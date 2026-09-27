/** Fixed bounded locator for one explicitly selected, site-approved cross-origin frame. */
import type { WebContents } from 'electron'
import type { BrowserLocateQuery, BrowserLocateResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { sidebarLocateCode, validSidebarLocateQuery } from './browser-locator-script.ts'
import { auditBrowserFrames } from './browser-foreign-read.ts'

type CaptureFrame = WebContents['mainFrame']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
export async function locateBrowserForeignFrame(guest: WebContents, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[]): Promise<BrowserLocateResult | null> {
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
  if (!path.some(step => step.child.origin !== step.parent.origin)) return null
  if (frame.executeJavaScript === undefined) throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
  const raw = await frame.executeJavaScript(sidebarLocateCode(frame.url, foreignQuery))
  if (auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== before) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  if (!record(raw) || JSON.stringify(raw).length > 50_000 ||
    raw.url !== frame.url || !Number.isSafeInteger(raw.count) ||
    typeof raw.count !== 'number' || raw.count < 0 || raw.count > 1_000_000 ||
    !Array.isArray(raw.rows) || raw.rows.length > 1 || raw.rows.some((row: unknown) =>
    !record(row) || typeof row.ref !== 'string' || row.ref.length > 750 ||
    !/^(?:f\d{1,2}-[0-9a-f]{8}\/){0,8}d\d{1,5}-[0-9a-f]{8}:[a-z][a-z0-9-]{0,31}:[^\]\s]{0,600}$/u.test(row.ref) ||
    typeof row.role !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(row.role) ||
    typeof row.name !== 'string' || row.name.length > 60 ||
    row.ref.split(':')[1] !== row.role ||
    decodeURIComponent(row.ref.split(':').slice(2).join(':')) !== row.name)) {
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
  if (query.projection === 'downloadUrl' && raw.rows.some((row: BrowserLocateResult['rows'][number]) =>
    typeof row.downloadUrl !== 'string' || !URL.canParse(row.downloadUrl) ||
    !['http:', 'https:'].includes(new URL(row.downloadUrl).protocol) ||
    new URL(row.downloadUrl).href !== row.downloadUrl ||
    new URL(row.downloadUrl).username !== '' || new URL(row.downloadUrl).password !== '')) {
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
