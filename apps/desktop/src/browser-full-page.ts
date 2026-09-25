/** Bounded full-page PNG capture of one main-owned Sidebar guest. */
import { createHash } from 'node:crypto'
import type { BrowserPageScreenshot, BrowserScreenshotClip } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

interface CaptureFrame {
  readonly detached: boolean
  readonly frameTreeNodeId: number
  readonly origin: string
  readonly url: string
  readonly framesInSubtree: CaptureFrame[]
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

function exactOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false
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
