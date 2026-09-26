/** Bounded full-page PNG capture of one main-owned Sidebar guest. */
import { createHash } from 'node:crypto'
import type { BrowserPageScreenshot, BrowserScreenshotClip, BrowserLocateQuery, BrowserLocateResult,
  BrowserForeignRefPoint, BrowserForeignInputState, BrowserForeignSecondaryState, BrowserDragPoint,
  BrowserForeignOptionResult, BrowserForeignSelectionResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
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

function nativeFrameForDescriptor(parent: CaptureFrame, descriptor: ForeignFrameDescriptor): CaptureFrame {
  const exact = parent.frames?.filter(frame => !frame.detached && frame.url === descriptor.src &&
    frame.name === descriptor.name) ?? []
  const matches = exact.length === 0 && descriptor.name !== ''
    ? parent.frames?.filter(frame => !frame.detached && frame.name === descriptor.name) ?? [] : exact
  if (matches.length !== 1 || matches[0] === undefined) throw new Error('SIDEBAR_FRAME_AMBIGUOUS')
  return matches[0]
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
  const descriptor = { src: raw.src, name: raw.name }
  return { frame: nativeFrameForDescriptor(parent, descriptor), descriptor }
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
  if (query.projection === 'allTextContents') {
    const expected = query.position === undefined ? raw.count :
      query.position.method === 'nth' ? Number(typeof query.position.index === 'number' &&
        query.position.index < raw.count) : Number(raw.count > 0)
    if (raw.rows.length !== 0 || !Array.isArray(raw.texts) || raw.texts.length !== expected ||
      raw.texts.length > 256 || raw.texts.some((text: unknown) => typeof text !== 'string') ||
      raw.texts.reduce((length: number, text: string) => length + text.length, 0) > 24000) {
      throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
    }
  } else if (raw.texts !== undefined) throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  if (query.projection === 'attribute' && raw.rows.some((row: BrowserLocateResult['rows'][number]) =>
    row.attribute !== null && (typeof row.attribute !== 'string' || row.attribute.length > 24000))) {
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
    rows: rows.map(row => ({ ...row, ref: prefix + row.ref })),
    ...(query.projection === 'allTextContents' ? { texts: raw.texts as string[] } : {}) }
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
      const named = [...document.querySelectorAll('iframe,frame')].filter(frame =>
        (frame.getAttribute('name') || '') === ${JSON.stringify(child.name)});
      const bySource = named.filter(frame => frame.src === ${JSON.stringify(child.url)});
      const matches = bySource.length === 0 && ${JSON.stringify(child.name)} !== '' ? named : bySource;
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

/** Prepare or verify one visible, approved foreign editable target without exporting its value. */
export async function stateForBrowserForeignInput(guest: FullPageCaptureGuest, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[], phase: unknown,
  value: unknown): Promise<BrowserForeignInputState> {
  if (['pasteArm', 'pasteCheck', 'pasteResult', 'pasteCleanup'].includes(phase as string)) {
    return stateForBrowserForeignPaste(guest, expectedUrl, input, approvedOrigins, phase, value)
  }
  if (!['select', 'verify', 'focus', 'check', 'keyFocus', 'keyCheck'].includes(phase as string) ||
    (phase === 'verify' && (typeof value !== 'string' || value.length > 4000)) ||
    (phase !== 'verify' && value !== undefined)) throw new Error('SIDEBAR_INPUT_UNAVAILABLE')
  const point = await pointForBrowserForeignRef(guest, expectedUrl, input, approvedOrigins)
  const match = /^x\d{1,10}-[a-f0-9]{64}\/(.+)$/iu.exec(input as string)
  if (match === null) throw new Error('SIDEBAR_UNKNOWN_REF')
  const id = Number(/^x(\d{1,10})-/iu.exec(input as string)?.[1])
  const leaf = guest.mainFrame.framesInSubtree.find(frame => frame.frameTreeNodeId === id)
  if (leaf?.executeJavaScript === undefined || leaf.origin !== point.origin) throw new Error('SIDEBAR_STALE_REF')
  const raw = await leaf.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_NAVIGATED');
    ${guestDomHelpers}
    const {node,frames} = sidebarResolveRef(${JSON.stringify(match[1])});
    if (frames.length !== 0 || !node.isConnected ||
      ('disabled' in node && node.disabled) || ('readOnly' in node && node.readOnly) ||
      (['select','verify'].includes(${JSON.stringify(phase)})
        ? !['INPUT','TEXTAREA'].includes(node.tagName) ||
          node.tagName === 'INPUT' && !['text','search','url','tel'].includes(node.type)
        : ['focus','check'].includes(${JSON.stringify(phase)})
          ? node.tagName === 'INPUT' && !['text','search','email','url','tel','number'].includes(node.type) ||
            !['INPUT','TEXTAREA'].includes(node.tagName) && !node.isContentEditable
          : node.tagName === 'INPUT' && ['password','hidden','file'].includes(node.type) ||
            !['INPUT','TEXTAREA','SELECT','BUTTON'].includes(node.tagName) &&
              !(node.tagName === 'A' && node.hasAttribute('href')) &&
              !node.isContentEditable && !(Number.isInteger(node.tabIndex) && node.tabIndex >= 0))) {
      throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
    }
    ${phase === 'select' ? `node.focus();
    if (document.activeElement !== node) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
    node.select();
    if (node.selectionStart !== 0 || node.selectionEnd !== node.value.length) {
      throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
    }` : phase === 'focus' || phase === 'keyFocus' ? `node.focus();
    if (document.activeElement !== node) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');`
      : phase === 'check' || phase === 'keyCheck' ? `if (document.activeElement !== node) {
      throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
    }` : `if (document.activeElement !== node || node.value !== ${JSON.stringify(value)}) {
      throw new Error('SIDEBAR_INPUT_NOT_CONFIRMED');
    }`}
    return {hadText:(typeof node.value === 'string' ? node.value : node.textContent || '').length > 0};
  })()`)
  if (!record(raw) || typeof raw.hadText !== 'boolean' ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== point.fingerprint) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512), origin: point.origin,
    fingerprint: point.fingerprint, hadText: raw.hadText }
}

async function stateForBrowserForeignPaste(guest: FullPageCaptureGuest, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[], phase: unknown,
  receipt: unknown): Promise<BrowserForeignInputState> {
  if (!['pasteArm', 'pasteCheck', 'pasteResult', 'pasteCleanup'].includes(phase as string) ||
    typeof receipt !== 'string' || !/^[a-f0-9-]{36}$/iu.test(receipt)) {
    throw new Error('SIDEBAR_PASTE_UNAVAILABLE')
  }
  const match = /^x\d{1,10}-([a-f0-9]{64})\/(.+)$/iu.exec(input as string)
  const id = Number(/^x(\d{1,10})-/iu.exec(input as string)?.[1])
  const audit = auditBrowserFrames(guest, expectedUrl, approvedOrigins)
  const leaf = guest.mainFrame.framesInSubtree.find(frame => frame.frameTreeNodeId === id)
  if (match === null || match[1] !== audit.fingerprint || leaf?.executeJavaScript === undefined ||
    !approvedOrigins.includes(leaf.origin)) {
    throw new Error('SIDEBAR_STALE_REF')
  }
  const point = ['pasteArm', 'pasteCheck'].includes(phase as string)
    ? await pointForBrowserForeignRef(guest, expectedUrl, input, approvedOrigins) : undefined
  if (point !== undefined && point.origin !== leaf.origin) throw new Error('SIDEBAR_STALE_REF')
  const key = `__dsh_cu_foreign_paste_${receipt.replaceAll('-', '')}`
  const raw = await leaf.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_NAVIGATED');
    ${guestDomHelpers}
    const key = ${JSON.stringify(key)};
    const phase = ${JSON.stringify(phase)};
    let state = window[key];
    if (phase === 'pasteCleanup') {
      if (state) {
        document.removeEventListener('paste',state.onPaste,true);
        document.removeEventListener('input',state.onInput,true);
        delete window[key];
      }
      return {hadText:false,pasteConfirmed:false};
    }
    const resolved = phase === 'pasteArm' || phase === 'pasteCheck'
      ? sidebarResolveRef(${JSON.stringify(match[2])}) : null;
    const node = resolved?.node ?? state?.node;
    if (!node || resolved?.frames.length > 0 || !node.isConnected ||
      ('disabled' in node && node.disabled) || ('readOnly' in node && node.readOnly) ||
      node.tagName === 'INPUT' && !['text','search','email','url','tel','number'].includes(node.type) ||
      !['INPUT','TEXTAREA'].includes(node.tagName) && !node.isContentEditable) {
      throw new Error('SIDEBAR_PASTE_TARGET_UNAVAILABLE');
    }
    if (phase === 'pasteArm') {
      if (state) throw new Error('SIDEBAR_PASTE_TARGET_UNAVAILABLE');
      node.focus();
      if (document.activeElement !== node) throw new Error('SIDEBAR_PASTE_TARGET_UNAVAILABLE');
      state = {node,armed:false,paste:false,input:false};
      state.onPaste = event => {
        if (state.armed && event.isTrusted && node.isConnected &&
          (event.target === node || node.contains(event.target))) state.paste = true;
      };
      state.onInput = event => {
        if (state.armed && state.paste && event.isTrusted && node.isConnected &&
          (event.target === node || node.contains(event.target))) state.input = true;
      };
      Object.defineProperty(window,key,{value:state,configurable:true});
      document.addEventListener('paste',state.onPaste,true);
      document.addEventListener('input',state.onInput,true);
    } else {
      if (!state || state.node !== node || document.activeElement !== node) {
        throw new Error('SIDEBAR_PASTE_TARGET_UNAVAILABLE');
      }
      if (phase === 'pasteCheck') state.armed = true;
    }
    return {hadText:(typeof node.value === 'string' ? node.value : node.textContent || '').length > 0,
      pasteConfirmed:state?.paste === true && state?.input === true};
  })()`)
  if (!record(raw) || typeof raw.hadText !== 'boolean' || typeof raw.pasteConfirmed !== 'boolean' ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== audit.fingerprint) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512), origin: leaf.origin,
    fingerprint: audit.fingerprint, hadText: raw.hadText, pasteConfirmed: raw.pasteConfirmed }
}

/** Inspect or focus one fixed secondary target in an approved foreign frame. */
export async function stateForBrowserForeignSecondary(guest: FullPageCaptureGuest, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[], action: unknown): Promise<BrowserForeignSecondaryState> {
  if (!['focus', 'showmenu', 'expand', 'collapse', 'increment', 'decrement'].includes(action as string)) {
    throw new Error('SIDEBAR_ACTION_UNAVAILABLE')
  }
  const point = await pointForBrowserForeignRef(guest, expectedUrl, input, approvedOrigins)
  const match = /^x(\d{1,10})-[a-f0-9]{64}\/(.+)$/iu.exec(input as string)
  if (match === null) throw new Error('SIDEBAR_UNKNOWN_REF')
  const leaf = guest.mainFrame.framesInSubtree.find(frame => frame.frameTreeNodeId === Number(match[1]))
  if (leaf?.executeJavaScript === undefined || leaf.origin !== point.origin) throw new Error('SIDEBAR_STALE_REF')
  const raw = await leaf.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_NAVIGATED');
    ${guestDomHelpers}
    const {node,frames} = sidebarResolveRef(${JSON.stringify(match[2])});
    if (frames.length !== 0 || !node.isConnected || node.matches('iframe,frame') ||
      ('disabled' in node && node.disabled)) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
    const action = ${JSON.stringify(action)};
    const role = sidebarDescribe(node).role;
    if (action === 'focus' || action === 'showmenu') {
      if (!['button','textbox','link','combobox','checkbox','radio','slider','spinbutton'].includes(role)) {
        throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
      }
    } else if (action === 'increment' || action === 'decrement') {
      if (!['slider','spinbutton'].includes(role) || ('readOnly' in node && node.readOnly)) {
        throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
      }
    }
    if (action === 'focus' || action === 'increment' || action === 'decrement') {
      node.focus();
      if (document.activeElement !== node) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
    }
    const expanded = node.getAttribute('aria-expanded');
    if (action === 'expand' || action === 'collapse') {
      if (!['true','false'].includes(expanded)) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
    }
    return {expanded:action === 'expand' || action === 'collapse' ? expanded : null};
  })()`)
  if (!record(raw) || raw.expanded !== null && raw.expanded !== 'true' && raw.expanded !== 'false' ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== point.fingerprint) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512), origin: point.origin,
    fingerprint: point.fingerprint,
    ...(raw.expanded === null ? {} : { expanded: raw.expanded }) }
}

/** Resolve one viewport pixel through an exact, fully approved native frame tree. */
export async function pointForBrowserDrag(guest: FullPageCaptureGuest, expectedUrl: string,
  x: unknown, y: unknown, approvedOrigins: readonly string[]): Promise<BrowserDragPoint> {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) ||
    x < 0 || y < 0 || x > MAX_DIMENSION || y > MAX_DIMENSION) throw new Error('SIDEBAR_DRAG_UNAVAILABLE')
  const before = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  let frame = guest.mainFrame
  let localX = x
  let localY = y
  for (let depth = 0; depth <= 8; depth++) {
    if (frame.executeJavaScript === undefined) throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
    const raw = await frame.executeJavaScript(`(() => {
      if (location.href !== ${JSON.stringify(frame.url)}) throw new Error('SIDEBAR_NAVIGATED');
      const x = ${JSON.stringify(localX)}, y = ${JSON.stringify(localY)};
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
        throw new Error('SIDEBAR_POINT_OUT_OF_BOUNDS');
      }
      const hit = document.elementFromPoint(x,y);
      if (!hit) throw new Error('SIDEBAR_TARGET_OCCLUDED');
      const rect = hit.getBoundingClientRect();
      if (!hit.matches('iframe,frame')) {
        return {kind:'hit',fingerprint:[hit.tagName,hit.id,hit.getAttribute('role'),
          hit.getAttribute('aria-label'),hit.getAttribute('type'),hit.getAttribute('href'),
          rect.left,rect.top,rect.width,rect.height].join('|')};
      }
      if (getComputedStyle(hit).transform !== 'none' ||
        Math.abs(rect.width - hit.offsetWidth) > 1 || Math.abs(rect.height - hit.offsetHeight) > 1) {
        throw new Error('SIDEBAR_FRAME_UNAVAILABLE');
      }
      const childX = x - rect.left - hit.clientLeft;
      const childY = y - rect.top - hit.clientTop;
      if (childX < 0 || childY < 0 || childX >= hit.clientWidth || childY >= hit.clientHeight) {
        throw new Error('SIDEBAR_POINT_OUT_OF_BOUNDS');
      }
      const source = hit.getAttribute('src');
      const src = hit.hasAttribute('srcdoc') ? 'about:srcdoc'
        : source ? new URL(source, document.baseURI).href : 'about:blank';
      return {kind:'frame',src,name:hit.getAttribute('name') || '',x:childX,y:childY};
    })()`)
    if (!record(raw)) throw new Error('SIDEBAR_POINT_UNAVAILABLE')
    if (raw.kind === 'hit' && typeof raw.fingerprint === 'string' && raw.fingerprint.length <= 1024) {
      if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      return { url: expectedUrl, title: guest.getTitle().slice(0, 512), origin: frame.origin,
        fingerprint: before, targetFingerprint: createHash('sha256').update(JSON.stringify(
          [frame.frameTreeNodeId, raw.fingerprint])).digest('hex') }
    }
    if (raw.kind !== 'frame' || typeof raw.src !== 'string' || raw.src.length > 16_384 ||
      typeof raw.name !== 'string' || raw.name.length > 256 ||
      typeof raw.x !== 'number' || typeof raw.y !== 'number' ||
      !Number.isFinite(raw.x) || !Number.isFinite(raw.y) || frame.frames === undefined) {
      throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
    }
    frame = nativeFrameForDescriptor(frame, { src: raw.src, name: raw.name })
    localX = raw.x
    localY = raw.y
  }
  throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
}

/** Change one approved foreign select using bounded exact option matchers. */
export async function selectBrowserForeignOption(guest: FullPageCaptureGuest, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[], selectors: unknown): Promise<BrowserForeignOptionResult> {
  if (!Array.isArray(selectors) || selectors.length < 1 || selectors.length > 20 ||
    selectors.some((spec: unknown) => !record(spec) ||
      Object.keys(spec).length < 1 || Object.keys(spec).some(key => !['value', 'label', 'index'].includes(key)) ||
      Object.values(spec).every(value => value === undefined) ||
      spec.value !== undefined && (typeof spec.value !== 'string' || spec.value.length > 120) ||
      spec.label !== undefined && (typeof spec.label !== 'string' || spec.label.length > 120) ||
      spec.index !== undefined && (!Number.isSafeInteger(spec.index) ||
        typeof spec.index !== 'number' || spec.index < 0 || spec.index > 999))) {
    throw new Error('SIDEBAR_OPTION_UNAVAILABLE')
  }
  const point = await pointForBrowserForeignRef(guest, expectedUrl, input, approvedOrigins)
  const match = /^x\d{1,10}-[a-f0-9]{64}\/(.+)$/iu.exec(input as string)
  if (match === null) throw new Error('SIDEBAR_UNKNOWN_REF')
  const id = Number(/^x(\d{1,10})-/iu.exec(input as string)?.[1])
  const leaf = guest.mainFrame.framesInSubtree.find(frame => frame.frameTreeNodeId === id)
  if (leaf?.executeJavaScript === undefined || leaf.origin !== point.origin) throw new Error('SIDEBAR_STALE_REF')
  const raw = await leaf.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_NAVIGATED');
    ${guestDomHelpers}
    const {node,frames} = sidebarResolveRef(${JSON.stringify(match[1])});
    const selectors = ${JSON.stringify(selectors)};
    if (frames.length !== 0 || !node.isConnected || node.tagName !== 'SELECT' ||
      node.disabled || node.options.length > 1000 ||
      (!node.multiple && selectors.length !== 1)) throw new Error('SIDEBAR_OPTION_UNAVAILABLE');
    const options = [...node.options];
    const targets = selectors.map(spec => {
      const matches = options.filter((option,index) =>
        (spec.value === undefined || option.value === spec.value) &&
        (spec.label === undefined || option.label === spec.label) &&
        (spec.index === undefined || index === spec.index) &&
        !option.disabled && !(option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled));
      if (matches.length !== 1) throw new Error('SIDEBAR_OPTION_NOT_UNIQUE');
      return matches[0];
    });
    if (new Set(targets).size !== targets.length) throw new Error('SIDEBAR_OPTION_NOT_UNIQUE');
    const indices = targets.map(option => options.indexOf(option)).sort((a,b) => a-b);
    node.focus();
    if (document.activeElement !== node) throw new Error('SIDEBAR_OPTION_UNAVAILABLE');
    if (node.multiple) {
      const selected = new Set(targets);
      for (const option of options) option.selected = selected.has(option);
    } else node.selectedIndex = indices[0];
    node.dispatchEvent(new Event('input',{bubbles:true}));
    node.dispatchEvent(new Event('change',{bubbles:true}));
    const after = options.flatMap((option,index) => option.selected ? [index] : []);
    if (!node.isConnected || after.length !== indices.length ||
      after.some((index,position) => index !== indices[position]) ||
      location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_OPTION_NOT_CONFIRMED');
    const selected = after.map(index => options[index].value);
    if (selected.some(value => value.length > 120)) throw new Error('SIDEBAR_OPTION_UNAVAILABLE');
    return {selected};
  })()`)
  if (!record(raw) || !Array.isArray(raw.selected) || raw.selected.length > 20 ||
    raw.selected.some(value => typeof value !== 'string' || value.length > 120) ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== point.fingerprint) {
    throw new Error('SIDEBAR_OPTION_NOT_CONFIRMED')
  }
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512), origin: point.origin,
    fingerprint: point.fingerprint, selected: raw.selected }
}

/** Select one exact text match within a visible, approved foreign element. */
export async function selectBrowserForeignText(guest: FullPageCaptureGuest, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[], spec: unknown): Promise<BrowserForeignSelectionResult> {
  if (!record(spec) || Object.keys(spec).some(key =>
    !['text', 'prefix', 'suffix', 'selectionType'].includes(key)) ||
    typeof spec.text !== 'string' || spec.text.length < 1 || spec.text.length > 4000 ||
    spec.prefix !== undefined && (typeof spec.prefix !== 'string' || spec.prefix.length > 4000) ||
    spec.suffix !== undefined && (typeof spec.suffix !== 'string' || spec.suffix.length > 4000) ||
    spec.selectionType !== undefined && !['text', 'cursor_before', 'cursor_after'].includes(spec.selectionType as string)) {
    throw new Error('SIDEBAR_SELECTION_UNAVAILABLE')
  }
  const point = await pointForBrowserForeignRef(guest, expectedUrl, input, approvedOrigins)
  const match = /^x\d{1,10}-[a-f0-9]{64}\/(.+)$/iu.exec(input as string)
  if (match === null) throw new Error('SIDEBAR_UNKNOWN_REF')
  const id = Number(/^x(\d{1,10})-/iu.exec(input as string)?.[1])
  const leaf = guest.mainFrame.framesInSubtree.find(frame => frame.frameTreeNodeId === id)
  if (leaf?.executeJavaScript === undefined || leaf.origin !== point.origin) throw new Error('SIDEBAR_STALE_REF')
  const raw = await leaf.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_NAVIGATED');
    ${guestDomHelpers}
    const action = ${JSON.stringify(spec)};
    const {node,frames} = sidebarResolveRef(${JSON.stringify(match[1])});
    if (frames.length !== 0 || !node.isConnected) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
    const input = ['INPUT','TEXTAREA'].includes(node.tagName);
    if (input && (node.disabled || node.tagName === 'INPUT' &&
      !['text','search','url','tel'].includes(node.type))) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
    const source = input ? node.value : node.textContent ?? '';
    if (source.length > 200000) throw new Error('SIDEBAR_SELECTION_TOO_LARGE');
    const matches = [];
    for (let index = source.indexOf(action.text); index >= 0; index = source.indexOf(action.text, index + 1)) {
      if (action.prefix !== undefined && !source.slice(0,index).endsWith(action.prefix)) continue;
      if (action.suffix !== undefined && !source.slice(index + action.text.length).startsWith(action.suffix)) continue;
      matches.push(index);
      if (matches.length > 1) throw new Error('SIDEBAR_AMBIGUOUS_SELECTION');
    }
    if (matches.length === 0) throw new Error('SIDEBAR_TEXT_NOT_FOUND');
    let start = matches[0], end = start + action.text.length;
    if (action.selectionType === 'cursor_before') end = start;
    if (action.selectionType === 'cursor_after') start = end;
    if (input) {
      node.focus();
      if (document.activeElement !== node) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
      node.setSelectionRange(start,end);
      if (node.selectionStart !== start || node.selectionEnd !== end) {
        throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
      }
    } else {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const nodes = []; let offset = 0;
      while (walker.nextNode()) {
        const item = walker.currentNode;
        nodes.push({item,start:offset,end:offset + item.textContent.length});
        offset += item.textContent.length;
      }
      const first = nodes.find(item => start >= item.start && start <= item.end);
      const last = nodes.find(item => end >= item.start && end <= item.end);
      if (!first || !last) throw new Error('SIDEBAR_TEXT_NOT_FOUND');
      const range = document.createRange();
      range.setStart(first.item,start - first.start);
      range.setEnd(last.item,end - last.start);
      const selection = document.getSelection();
      if (!selection) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
      selection.removeAllRanges(); selection.addRange(range);
      if (selection.rangeCount !== 1 || selection.toString() !==
        (action.selectionType === 'text' || action.selectionType === undefined ? action.text : '')) {
        throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
      }
    }
    if (!node.isConnected || location.href !== ${JSON.stringify(leaf.url)}) {
      throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
    }
    return {confirmed:true};
  })()`)
  if (!record(raw) || raw.confirmed !== true ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== point.fingerprint) {
    throw new Error('SIDEBAR_SELECTION_UNAVAILABLE')
  }
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512),
    origin: point.origin, fingerprint: point.fingerprint }
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
