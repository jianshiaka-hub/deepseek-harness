/** Bounded full-page PNG capture of one main-owned Sidebar guest. */
import { createHash } from 'node:crypto'
import type { BrowserPageScreenshot, BrowserScreenshotClip, BrowserLocateQuery, BrowserLocateResult, BrowserForeignRefPoint } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { guestDomHelpers, sidebarLocateCode, validSidebarLocateQuery } from '@deepseek-ai/dsh-client-ui-sidebar-browser/src/locator-script.ts'

interface CaptureFrame {
  readonly detached: boolean
  readonly frameTreeNodeId: number
  readonly origin: string
  readonly url: string
  readonly framesInSubtree: CaptureFrame[]
  readonly frames?: CaptureFrame[]
  readonly name?: string
  readonly parent?: CaptureFrame | null
  executeJavaScript?(code: string): Promise<unknown>
}

interface CaptureDebugger {
  isAttached(): boolean
  attach(): void
  detach(): void
  sendCommand(method: string, params?: object): Promise<unknown>
}

/** The fixed main-process surface needed from an Electron guest. */
export interface FullPageCaptureGuest {
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
  getURL(): string
  getTitle(): string
  readonly mainFrame: CaptureFrame
  readonly debugger: CaptureDebugger
}

interface ViewportImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  crop(rect: BrowserScreenshotClip): ViewportImage
  toPNG(): Buffer
}

export interface ViewportCaptureGuest extends FullPageCaptureGuest {
  capturePage(): Promise<ViewportImage>
}

const MAX_DIMENSION = 8192
const MAX_PIXELS = 16_777_216
const MAX_IMAGE_BYTES = 4_194_304
const CAPTURE_TIMEOUT_MS = 12_000
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
type CaptureTarget = { x: number; y: number; width: number; height: number; scale: number }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function layoutSize(value: unknown): { x: number; y: number; width: number; height: number } {
  if (!record(value) || !record(value.cssContentSize)) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
  const { x, y, width, height } = value.cssContentSize
  if (![x, y, width, height].every(n => typeof n === 'number' && Number.isFinite(n)) ||
    typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
  }
  const roundedWidth = Math.ceil(width)
  const roundedHeight = Math.ceil(height)
  if (roundedWidth < 1 || roundedHeight < 1 || roundedWidth > MAX_DIMENSION || roundedHeight > MAX_DIMENSION ||
    roundedWidth * roundedHeight > MAX_PIXELS) throw new Error('SIDEBAR_IMAGE_TOO_LARGE')
  return { x, y, width: roundedWidth, height: roundedHeight }
}

function captureClip(clip: BrowserScreenshotClip | undefined, layout: ReturnType<typeof layoutSize>, pixelRatio: number): CaptureTarget {
  if (clip !== undefined && (!Number.isSafeInteger(clip.x) || !Number.isSafeInteger(clip.y) ||
    !Number.isSafeInteger(clip.width) || !Number.isSafeInteger(clip.height) ||
    clip.x < 0 || clip.y < 0 || clip.width < 1 || clip.height < 1 ||
    clip.x + clip.width > layout.width || clip.y + clip.height > layout.height)) {
    throw new Error('SIDEBAR_CLIP_OUT_OF_BOUNDS')
  }
  return { x: layout.x + (clip?.x ?? 0), y: layout.y + (clip?.y ?? 0),
    width: clip?.width ?? layout.width, height: clip?.height ?? layout.height, scale: 1 / pixelRatio }
}

function devicePixelRatio(value: unknown): number {
  if (!record(value) || !record(value.result) || typeof value.result.value !== 'number' ||
    !Number.isFinite(value.result.value) || value.result.value < 0.5 || value.result.value > 4) {
    throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
  }
  return value.result.value
}

export interface BrowserFrameAudit {
  readonly origins: readonly string[]
  readonly fingerprint: string
}

export interface BrowserForeignText {
  readonly fingerprint: string
  readonly frames: readonly { readonly origin: string; readonly text: string; readonly roles: string }[]
}

interface ForeignFrameDescriptor {
  readonly src: string
  readonly name: string
}

/** Resolve a named or uniquely addressed child without assuming DOM and native frame orders match. */
async function resolveForeignFrame(parent: CaptureFrame, selector: string): Promise<{
  readonly frame: CaptureFrame
  readonly descriptor: ForeignFrameDescriptor
}> {
  if (parent.executeJavaScript === undefined || parent.frames === undefined) {
    throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  }
  const raw = await parent.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(parent.url)}) throw new Error('SIDEBAR_NAVIGATED');
    let frames;
    try { frames = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter(node => node.matches('iframe,frame')); }
    catch { throw new Error('SIDEBAR_SELECTOR_INVALID'); }
    if (frames.length !== 1) throw new Error(frames.length
      ? 'SIDEBAR_FRAME_AMBIGUOUS' : 'SIDEBAR_FRAME_NOT_FOUND');
    return {src:frames[0].src,name:frames[0].getAttribute('name') || ''};
  })()`)
  if (!record(raw) || typeof raw.src !== 'string' || typeof raw.name !== 'string' ||
    raw.src.length > 16_384 || raw.name.length > 256 || !URL.canParse(raw.src) ||
    !['http:', 'https:'].includes(new URL(raw.src).protocol)) {
    throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  }
  const matches = parent.frames.filter(frame => !frame.detached && frame.url === raw.src &&
    frame.name === raw.name)
  const match = matches[0]
  if (matches.length !== 1 || match === undefined) throw new Error('SIDEBAR_FRAME_AMBIGUOUS')
  return { frame: match, descriptor: { src: raw.src, name: raw.name } }
}

/** Query one explicitly selected, approved foreign frame with the same bounded DOM engine as the Webview. */
export async function locateBrowserForeignFrame(guest: FullPageCaptureGuest, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[]): Promise<BrowserLocateResult> {
  if (!validSidebarLocateQuery(input as BrowserLocateQuery)) throw new Error('SIDEBAR_LOCATOR_UNAVAILABLE')
  const query = input as BrowserLocateQuery
  if (query.frames === undefined ||
    JSON.stringify(query).length > 8192) throw new Error('SIDEBAR_LOCATOR_UNAVAILABLE')
  const before = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  let frame = guest.mainFrame
  const { frames: frameSelectors, ...foreignQuery } = query
  const path: {
    parent: CaptureFrame
    child: CaptureFrame
    selector: string
    descriptor: ForeignFrameDescriptor
  }[] = []
  for (const selector of frameSelectors) {
    const parent = frame
    const resolved = await resolveForeignFrame(parent, selector)
    path.push({ parent, child: resolved.frame, selector, descriptor: resolved.descriptor })
    frame = resolved.frame
    if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
      throw new Error('SIDEBAR_NAVIGATED')
    }
  }
  if (!path.some(step => step.child.origin !== step.parent.origin) || frame.executeJavaScript === undefined) {
    throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  }
  const raw = await frame.executeJavaScript(sidebarLocateCode(frame.url, foreignQuery))
  if (!record(raw) || raw.url !== frame.url || !Number.isSafeInteger(raw.count) ||
    typeof raw.count !== 'number' || raw.count < 0 || raw.count > 1_000_000 ||
    !Array.isArray(raw.rows) || raw.rows.length > 1 || raw.rows.some((row: unknown) =>
    !record(row) || typeof row.ref !== 'string' || !/^d\d{1,5}-[0-9a-f]{8}:/u.test(row.ref))) {
    throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  }
  for (const step of path) {
    const again = await resolveForeignFrame(step.parent, step.selector)
    if (again.frame !== step.child || again.descriptor.src !== step.descriptor.src ||
      again.descriptor.name !== step.descriptor.name) throw new Error('SIDEBAR_NAVIGATED')
  }
  if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  const prefix = `x${frame.frameTreeNodeId}-${before}/`
  const rows = raw.rows as BrowserLocateResult['rows']
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512), count: raw.count,
    rows: rows.map(row => ({ ...row, ref: prefix + row.ref })) }
}

/**
 * Revalidate an observed foreign element and map its visible center through uniquely bound native parents.
 * @param guest - Main-owned selected Browser guest.
 * @param expectedUrl - Exact top-level URL approved by the Host.
 * @param input - Fingerprinted foreign element reference.
 * @param approvedOrigins - Exact source sites approved for the current frame tree.
 * @returns Current visible point in the top guest viewport.
 */
export async function pointForBrowserForeignRef(guest: FullPageCaptureGuest, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[]): Promise<BrowserForeignRefPoint> {
  const match = typeof input === 'string' && input.length <= 750
    ? /^x(\d{1,10})-([a-f0-9]{64})\/(d\d{1,5}-[a-f0-9]{8}:[a-z][a-z0-9-]{0,31}:[^\]\s]{0,600})$/iu.exec(input)
    : null
  if (match === null) throw new Error('SIDEBAR_UNKNOWN_REF')
  const before = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  if (match[2] !== before) throw new Error('SIDEBAR_STALE_REF')
  const id = Number(match[1])
  const frames = guest.mainFrame.framesInSubtree
  const leaf = frames.find(frame => frame.frameTreeNodeId === id)
  if (leaf === undefined || leaf === guest.mainFrame || leaf.executeJavaScript === undefined) {
    throw new Error('SIDEBAR_STALE_REF')
  }
  const chain: { parent: CaptureFrame; child: CaptureFrame }[] = []
  let current = leaf
  while (current !== guest.mainFrame) {
    const parent: CaptureFrame | null | undefined = current.parent
    if (parent === undefined || parent === null || !frames.includes(parent) ||
      chain.length >= 8 || !parent.frames?.includes(current)) throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
    chain.push({ parent, child: current })
    current = parent
  }
  if (!chain.some(step => step.parent.origin !== step.child.origin)) throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  const local = await leaf.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_NAVIGATED');
    ${guestDomHelpers}
    const {node,frames} = sidebarResolveRef(${JSON.stringify(match[3])});
    if (frames.length !== 0) throw new Error('SIDEBAR_FRAME_UNAVAILABLE');
    const {x,y} = sidebarPoint(node,[]);
    return {x,y};
  })()`)
  if (!record(local) || typeof local.x !== 'number' || typeof local.y !== 'number' ||
    !Number.isFinite(local.x) || !Number.isFinite(local.y)) throw new Error('SIDEBAR_POINT_UNAVAILABLE')
  let x = local.x
  let y = local.y
  for (const { parent, child } of chain) {
    if (parent.executeJavaScript === undefined || parent.frames === undefined ||
      parent.frames.filter(frame => !frame.detached && frame.url === child.url &&
        frame.name === child.name).length !== 1) throw new Error('SIDEBAR_FRAME_AMBIGUOUS')
    const offset = await parent.executeJavaScript(`(() => {
      if (location.href !== ${JSON.stringify(parent.url)}) throw new Error('SIDEBAR_NAVIGATED');
      const matches = [...document.querySelectorAll('iframe,frame')].filter(frame =>
        frame.src === ${JSON.stringify(child.url)} &&
        (frame.getAttribute('name') || '') === ${JSON.stringify(child.name)});
      if (matches.length !== 1) throw new Error('SIDEBAR_FRAME_AMBIGUOUS');
      const frame = matches[0], rect = frame.getBoundingClientRect();
      if (getComputedStyle(frame).transform !== 'none' ||
        Math.abs(rect.width - frame.offsetWidth) > 1 ||
        Math.abs(rect.height - frame.offsetHeight) > 1) throw new Error('SIDEBAR_FRAME_UNAVAILABLE');
      const x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)};
      if (x < 0 || y < 0 || x >= frame.clientWidth || y >= frame.clientHeight) {
        throw new Error('SIDEBAR_POINT_OUT_OF_BOUNDS');
      }
      const px = rect.left + frame.clientLeft + x;
      const py = rect.top + frame.clientTop + y;
      if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight ||
        document.elementFromPoint(px,py) !== frame) throw new Error('SIDEBAR_TARGET_OCCLUDED');
      return {x:px,y:py};
    })()`)
    if (!record(offset) || typeof offset.x !== 'number' || typeof offset.y !== 'number' ||
      !Number.isFinite(offset.x) || !Number.isFinite(offset.y)) throw new Error('SIDEBAR_POINT_UNAVAILABLE')
    x = offset.x
    y = offset.y
  }
  if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512), x, y,
    fingerprint: before, origin: leaf.origin }
}

/** Fixed, bounded child-frame inspection. Form values and element handles stay inside the page. */
const FOREIGN_FRAME_SNAPSHOT = String.raw`(() => {
  const text = String(document.body?.innerText ?? '').slice(0,1000).replaceAll('[ref=','[ref =');
  const selector = 'a,button,input,textarea,select,img[alt],area[alt],[role],[contenteditable],h1,h2,h3';
  const nodes = [...document.querySelectorAll(selector)].slice(0,150);
  const roles = [];
  for (const node of nodes) {
    if (roles.length >= 50 || node.closest('[aria-hidden="true"],[inert]')) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' ||
      ![...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
    const rawRole = node.getAttribute('role') || '';
    const role = /^[a-z][a-z0-9-]{0,31}$/.test(rawRole) ? rawRole :
      node.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',button:'button',submit:'button',
        reset:'button',search:'searchbox',range:'slider',number:'spinbutton'})[node.type] || 'textbox' :
      ({A:'link',AREA:'link',IMG:'img',BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox',
        H1:'heading',H2:'heading',H3:'heading'})[node.tagName] ||
        (node.getAttribute('contenteditable') !== null ? 'textbox' : node.tagName.toLowerCase());
    const ids = (node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).slice(0,8);
    const linked = ids.map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
    const labels = node.labels ? [...node.labels].slice(0,8).map(label => label.innerText || '').join(' ') : '';
    const formField = ['INPUT','TEXTAREA','SELECT'].includes(node.tagName) &&
      !['button','submit','reset'].includes(node.type);
    const name = (linked || node.getAttribute('aria-label') || labels ||
      (formField ? '' : node.tagName === 'INPUT' ? node.value : node.getAttribute('alt') || node.innerText) ||
      node.getAttribute('title') || node.getAttribute('placeholder') || '')
      .trim().replace(/\s+/g,' ').replaceAll('[ref=','[ref =').slice(0,60);
    roles.push('- ' + role + ' ' + JSON.stringify(name));
  }
  return {text,roles:roles.join('\n').slice(0,2000)};
})()`

function exactOrigin(value: string): boolean {
  if (value.length > 2048 || !URL.canParse(value)) return false
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && url.origin === value
}

/** Read only source origins and a non-reversible frame-tree revision marker. */
export function auditBrowserFrames(guest: FullPageCaptureGuest, expectedUrl: string,
  approvedOrigins?: readonly string[]): BrowserFrameAudit {
  if (guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  const origin = new URL(expectedUrl).origin
  if (approvedOrigins !== undefined && (approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
    new Set(approvedOrigins).size !== approvedOrigins.length || !approvedOrigins.includes(origin) ||
    !approvedOrigins.every(exactOrigin))) throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  const frames = guest.mainFrame.framesInSubtree
  if (frames.length === 0 || frames.length > 100 || !frames.includes(guest.mainFrame)) {
    throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  }
  const origins = new Set<string>()
  const identities = new Set<number>()
  for (const frame of frames) {
    const parsed = URL.canParse(frame.url) ? new URL(frame.url) : undefined
    const normalWeb = parsed !== undefined && ['http:', 'https:'].includes(parsed.protocol) &&
      parsed.origin === frame.origin && parsed.username === '' && parsed.password === ''
    const blobWeb = parsed?.protocol === 'blob:' && parsed.origin === frame.origin &&
      URL.canParse(frame.url.slice(5)) && ['http:', 'https:'].includes(new URL(frame.url.slice(5)).protocol) &&
      new URL(frame.url.slice(5)).username === '' && new URL(frame.url.slice(5)).password === ''
    const inheritedBlank = frame.url === 'about:blank' || frame.url.startsWith('about:blank#') ||
      frame.url === 'about:srcdoc'
    if (frame.detached || !exactOrigin(frame.origin) || identities.has(frame.frameTreeNodeId) ||
      !Number.isSafeInteger(frame.frameTreeNodeId) || !(normalWeb || blobWeb || inheritedBlank)) {
      throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
    }
    identities.add(frame.frameTreeNodeId)
    origins.add(frame.origin)
    if (approvedOrigins !== undefined && !approvedOrigins.includes(frame.origin)) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
  }
  if (guest.mainFrame.url !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
  return { origins: [...origins], fingerprint: createHash('sha256').update(JSON.stringify(
    frames.map(frame => [frame.frameTreeNodeId, frame.origin, frame.url]))).digest('hex') }
}

/** Read only bounded visible text from approved foreign frames; never form values or page scripts. */
export async function readBrowserForeignText(guest: FullPageCaptureGuest, expectedUrl: string,
  approvedOrigins: readonly string[]): Promise<BrowserForeignText> {
  const before = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  const topOrigin = new URL(expectedUrl).origin
  const foreign = guest.mainFrame.framesInSubtree.filter(frame => frame.origin !== topOrigin).slice(0, 8)
  const frames: { origin: string; text: string; roles: string }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (): Promise<BrowserForeignText> => {
    for (const frame of foreign) {
      if (frame.executeJavaScript === undefined) throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
      const snapshot = await frame.executeJavaScript(FOREIGN_FRAME_SNAPSHOT)
      if (!record(snapshot) || typeof snapshot.text !== 'string' || snapshot.text.length > 1000 ||
        typeof snapshot.roles !== 'string' || snapshot.roles.length > 2000 ||
        auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      frames.push({ origin: frame.origin, text: snapshot.text, roles: snapshot.roles })
    }
    return { fingerprint: before, frames }
  }
  try {
    return await Promise.race([read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SIDEBAR_FRAME_READ_TIMEOUT')) }, CAPTURE_TIMEOUT_MS)
    })])
  } finally { clearTimeout(timer) }
}

function pngData(value: unknown, width: number, height: number): string {
  if (!record(value) || typeof value.data !== 'string' || value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
  }
  const bytes = Buffer.from(value.data, 'base64')
  if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height ||
    bytes.toString('base64') !== value.data) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
  return value.data
}

/** Capture one approved page beyond its viewport without exposing arbitrary debugger commands. */
export async function captureBrowserFullPage(
  guest: FullPageCaptureGuest, expectedUrl: string, clip?: BrowserScreenshotClip,
  approvedOrigins?: readonly string[],
): Promise<BrowserPageScreenshot> {
  if (!URL.canParse(expectedUrl)) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
  const url = new URL(expectedUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error('SIDEBAR_TAB_UNAVAILABLE')
  }
  const approved = approvedOrigins ?? [url.origin]
  const before = auditBrowserFrames(guest, expectedUrl, approved).fingerprint
  const debuggerApi = guest.debugger
  if (debuggerApi.isAttached()) throw new Error('SIDEBAR_CAPTURE_BUSY')
  debuggerApi.attach()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const capture = async (): Promise<BrowserPageScreenshot> => {
      const layout = layoutSize(await debuggerApi.sendCommand('Page.getLayoutMetrics'))
      // Chromium scales clip output by the page's device-pixel ratio on Retina displays.
      // This fixed, read-only query keeps the returned PNG in CSS-pixel coordinates.
      const pixelRatio = devicePixelRatio(await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: 'window.devicePixelRatio', returnByValue: true,
      }))
      const target = captureClip(clip, layout, pixelRatio)
      if (auditBrowserFrames(guest, expectedUrl, approved).fingerprint !== before) throw new Error('SIDEBAR_NAVIGATED')
      const image = await debuggerApi.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true, clip: target,
      })
      if (auditBrowserFrames(guest, expectedUrl, approved).fingerprint !== before) throw new Error('SIDEBAR_NAVIGATED')
      const base64 = pngData(image, target.width, target.height)
      return { url: expectedUrl, title: guest.getTitle().slice(0, 512), base64,
        viewport: { width: layout.width, height: layout.height } }
    }
    return await Promise.race([capture(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SIDEBAR_CAPTURE_TIMEOUT')) }, CAPTURE_TIMEOUT_MS)
    })])
  } finally {
    clearTimeout(timer)
    if (debuggerApi.isAttached()) debuggerApi.detach()
  }
}

/** Capture one approved viewport while every embedded origin and frame revision stays fixed. */
export async function captureBrowserViewport(
  guest: ViewportCaptureGuest, expectedUrl: string, clip?: BrowserScreenshotClip,
  approvedOrigins?: readonly string[],
): Promise<BrowserPageScreenshot> {
  if (!URL.canParse(expectedUrl)) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
  const url = new URL(expectedUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error('SIDEBAR_TAB_UNAVAILABLE')
  }
  const approved = approvedOrigins ?? [url.origin]
  const before = auditBrowserFrames(guest, expectedUrl, approved).fingerprint
  let timer: ReturnType<typeof setTimeout> | undefined
  const capture = async (): Promise<BrowserPageScreenshot> => {
    const image = await guest.capturePage()
    if (auditBrowserFrames(guest, expectedUrl, approved).fingerprint !== before) {
      throw new Error('SIDEBAR_NAVIGATED')
    }
    const viewport = image.getSize()
    if (image.isEmpty() || !Number.isSafeInteger(viewport.width) ||
      !Number.isSafeInteger(viewport.height) || viewport.width < 1 || viewport.height < 1 ||
      viewport.width > MAX_DIMENSION || viewport.height > MAX_DIMENSION ||
      viewport.width * viewport.height > MAX_PIXELS) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
    if (clip !== undefined && (!Number.isSafeInteger(clip.x) || !Number.isSafeInteger(clip.y) ||
      !Number.isSafeInteger(clip.width) || !Number.isSafeInteger(clip.height) ||
      clip.x < 0 || clip.y < 0 || clip.width < 1 || clip.height < 1 ||
      clip.x + clip.width > viewport.width || clip.y + clip.height > viewport.height)) {
      throw new Error('SIDEBAR_CLIP_OUT_OF_BOUNDS')
    }
    const output = clip === undefined ? image : image.crop(clip)
    const bytes = output.toPNG()
    const size = output.getSize()
    if (output.isEmpty() || bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(16) !== size.width || bytes.readUInt32BE(20) !== size.height ||
      (clip !== undefined && (size.width !== clip.width || size.height !== clip.height))) {
      throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
    }
    if (auditBrowserFrames(guest, expectedUrl, approved).fingerprint !== before) {
      throw new Error('SIDEBAR_NAVIGATED')
    }
    return { url: expectedUrl, title: guest.getTitle().slice(0, 512),
      base64: bytes.toString('base64'), viewport }
  }
  try {
    return await Promise.race([capture(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SIDEBAR_CAPTURE_TIMEOUT')) }, CAPTURE_TIMEOUT_MS)
    })])
  } finally { clearTimeout(timer) }
}
