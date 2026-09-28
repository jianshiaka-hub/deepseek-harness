/** Bounded, origin-gated text inspection of a Sidebar guest's foreign frames. */
import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'
import { guestDomHelpers } from './browser-locator-script.ts'

export interface BrowserFrameAudit {
  readonly origins: readonly string[]
  readonly fingerprint: string
}

export interface BrowserForeignText {
  readonly fingerprint: string
  readonly frames: readonly { readonly origin: string; readonly text: string; readonly roles: string }[]
}

export interface BrowserScreenshotClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BrowserFrameScreenshot {
  readonly url: string
  readonly title: string
  readonly base64: string
  readonly viewport: { readonly width: number; readonly height: number }
}

const MAX_DIMENSION = 8192
const MAX_PIXELS = 16_777_216
const MAX_IMAGE_BYTES = 4_194_304
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const FOREIGN_FRAME_SNAPSHOT = String.raw`(() => {
  ${guestDomHelpers}
  const text = String(document.body?.innerText ?? '').slice(0,1000).replaceAll('[ref=','[ref =');
  const selector = 'a,button,input,textarea,select,img[alt],area[alt],[role],[contenteditable],h1,h2,h3';
  const nodes = [...document.querySelectorAll(selector)].slice(0,150);
  const roles = [];
  for (const node of nodes) {
    if (roles.length >= 50 || node.closest('[aria-hidden="true"],[inert]')) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.visibility === 'collapse' ||
      ![...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) continue;
    const { role, name } = sidebarDescribe(node);
    roles.push('- ' + role + ' ' + JSON.stringify(name));
  }
  return {text,roles:roles.join('\n').slice(0,2000)};
})()`

function exactOrigin(value: string): boolean {
  if (value.length > 2048 || !URL.canParse(value)) return false
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && url.origin === value
}

function validGuest(guest: WebContents, expectedUrl: string): void {
  if (guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl ||
    !URL.canParse(expectedUrl) || !['http:', 'https:'].includes(new URL(expectedUrl).protocol)) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
}

/** Report real native frame origins and a revision marker, without reading frame content. */
export function auditBrowserFrames(guest: WebContents, expectedUrl: string,
  approvedOrigins?: readonly string[]): BrowserFrameAudit {
  validGuest(guest, expectedUrl)
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

/** Read bounded visible text and shared DOM role/name summaries only after all frame origins are approved. */
export async function readBrowserForeignText(guest: WebContents, expectedUrl: string,
  approvedOrigins: readonly string[]): Promise<BrowserForeignText> {
  const before = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  const topOrigin = new URL(expectedUrl).origin
  const foreign = guest.mainFrame.framesInSubtree.filter(frame => frame.origin !== topOrigin).slice(0, 8)
  const frames: { origin: string; text: string; roles: string }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([ (async () => {
      for (const frame of foreign) {
        const snapshot: unknown = await frame.executeJavaScript(FOREIGN_FRAME_SNAPSHOT)
        if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot) ||
          !('text' in snapshot) || typeof snapshot.text !== 'string' || snapshot.text.length > 1000 ||
          !('roles' in snapshot) || typeof snapshot.roles !== 'string' || snapshot.roles.length > 2000 ||
          auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
          throw new Error('SIDEBAR_NAVIGATED')
        }
        frames.push({ origin: frame.origin, text: snapshot.text, roles: snapshot.roles })
      }
      return { fingerprint: before, frames }
    })(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SIDEBAR_FRAME_READ_TIMEOUT')) }, 12_000)
    }) ])
  } finally { clearTimeout(timer) }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkedClip(value: BrowserScreenshotClip | undefined, width: number, height: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y) ||
    !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
    value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1 ||
    value.x + value.width > width || value.y + value.height > height)) {
    throw new Error('SIDEBAR_CLIP_OUT_OF_BOUNDS')
  }
}

function pngData(bytes: Buffer, width: number, height: number): string {
  if (bytes.length < 24 || bytes.length > MAX_IMAGE_BYTES ||
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
    throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
  }
  return bytes.toString('base64')
}

/** Capture only the named guest viewport after every real frame origin is approved. */
export async function captureBrowserViewport(guest: WebContents, expectedUrl: string,
  clip: BrowserScreenshotClip | undefined, approvedOrigins: readonly string[]): Promise<BrowserFrameScreenshot> {
  const before = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([ (async () => {
      const image = await guest.capturePage()
      if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      const viewport = image.getSize()
      if (image.isEmpty() || !Number.isSafeInteger(viewport.width) ||
        !Number.isSafeInteger(viewport.height) || viewport.width < 1 || viewport.height < 1 ||
        viewport.width > MAX_DIMENSION || viewport.height > MAX_DIMENSION ||
        viewport.width * viewport.height > MAX_PIXELS) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
      checkedClip(clip, viewport.width, viewport.height)
      const output = clip === undefined ? image : image.crop(clip)
      const size = output.getSize()
      const base64 = pngData(output.toPNG(), size.width, size.height)
      if (output.isEmpty() || clip !== undefined &&
        (size.width !== clip.width || size.height !== clip.height) ||
        auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
        throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
      }
      return { url: expectedUrl, title: guest.getTitle().slice(0, 512), base64, viewport }
    })(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SIDEBAR_CAPTURE_TIMEOUT')) }, 12_000)
    }) ])
  } finally { clearTimeout(timer) }
}

/** Capture a full page through fixed CDP commands, with every frame origin approved. */
export async function captureBrowserFullPage(guest: WebContents, expectedUrl: string,
  clip: BrowserScreenshotClip | undefined, approvedOrigins: readonly string[]): Promise<BrowserFrameScreenshot> {
  const before = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  const debuggerApi = guest.debugger
  if (debuggerApi.isAttached()) throw new Error('SIDEBAR_CAPTURE_BUSY')
  debuggerApi.attach()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([ (async () => {
      const layout: unknown = await debuggerApi.sendCommand('Page.getLayoutMetrics')
      if (!record(layout) || !record(layout.cssContentSize) ||
        ![layout.cssContentSize.x, layout.cssContentSize.y,
          layout.cssContentSize.width, layout.cssContentSize.height]
          .every(n => typeof n === 'number' && Number.isFinite(n))) {
        throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
      }
      const x = layout.cssContentSize.x as number
      const y = layout.cssContentSize.y as number
      const width = Math.ceil(layout.cssContentSize.width as number)
      const height = Math.ceil(layout.cssContentSize.height as number)
      if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION ||
        width * height > MAX_PIXELS) throw new Error('SIDEBAR_IMAGE_TOO_LARGE')
      checkedClip(clip, width, height)
      const ratio: unknown = await debuggerApi.sendCommand('Runtime.evaluate', {
        expression: 'window.devicePixelRatio', returnByValue: true,
      })
      if (!record(ratio) || !record(ratio.result) ||
        typeof ratio.result.value !== 'number' || !Number.isFinite(ratio.result.value) ||
        ratio.result.value < 0.5 || ratio.result.value > 4) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
      const target = { x: x + (clip?.x ?? 0), y: y + (clip?.y ?? 0),
        width: clip?.width ?? width, height: clip?.height ?? height,
        scale: 1 / ratio.result.value }
      if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      const raw: unknown = await debuggerApi.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true, clip: target,
      })
      if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      if (!record(raw) || typeof raw.data !== 'string' ||
        raw.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
      const bytes = Buffer.from(raw.data, 'base64')
      if (bytes.toString('base64') !== raw.data) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
      const base64 = pngData(bytes, target.width, target.height)
      return { url: expectedUrl, title: guest.getTitle().slice(0, 512), base64,
        viewport: { width, height } }
    })(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SIDEBAR_CAPTURE_TIMEOUT')) }, 12_000)
    }) ])
  } finally {
    clearTimeout(timer)
    if (debuggerApi.isAttached()) debuggerApi.detach()
  }
}
