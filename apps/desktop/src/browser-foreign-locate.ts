/** Fixed bounded locator for one explicitly selected, site-approved cross-origin frame. */
import type { WebContents } from 'electron'
import type { BrowserLocateQuery, BrowserLocateResult, BrowserForeignRefPoint,
  BrowserForeignInputState } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { guestDomHelpers, sidebarLocateCode, validSidebarLocateQuery } from './browser-locator-script.ts'
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

/**
 * Revalidate an observed foreign element and map its visible center through uniquely bound native parents.
 * @param guest - Main-owned selected Browser guest.
 * @param expectedUrl - Exact top-level URL approved by the Host.
 * @param input - Fingerprinted foreign element reference.
 * @param approvedOrigins - Exact source sites approved for the current frame tree.
 * @returns Current visible point in the top guest viewport.
 */
export async function pointForBrowserForeignRef(guest: WebContents, expectedUrl: string,
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
    const {x,y,hit} = sidebarPoint(node,[]);
    const anchor = hit.closest('a[href],area[href]');
    const control = hit.closest('button,input');
    const form = control?.form && ['submit','image'].includes(control.type)
      ? control.form : null;
    const rawTarget = anchor?.getAttribute('href') ??
      (form ? control.getAttribute('formaction') || form.getAttribute('action') ||
        hit.ownerDocument.URL : null);
    let targetUrl = null;
    if (rawTarget !== null) {
      const parsed = new URL(rawTarget,hit.ownerDocument.baseURI);
      if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.href.length > 16384) throw new Error('SIDEBAR_TARGET_URL_UNAVAILABLE');
      targetUrl = parsed.href;
    }
    return {x,y,targetUrl};
  })()`)
  if (!record(local) || typeof local.x !== 'number' || typeof local.y !== 'number' ||
    !Number.isFinite(local.x) || !Number.isFinite(local.y) ||
    local.targetUrl !== null && (typeof local.targetUrl !== 'string' ||
      local.targetUrl.length > 16_384 || !URL.canParse(local.targetUrl) ||
      !['http:', 'https:'].includes(new URL(local.targetUrl).protocol) ||
      new URL(local.targetUrl).href !== local.targetUrl ||
      new URL(local.targetUrl).username !== '' ||
      new URL(local.targetUrl).password !== '')) throw new Error('SIDEBAR_POINT_UNAVAILABLE')
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
    fingerprint: before, origin: leaf.origin, targetUrl: local.targetUrl }
}

/** Focus or verify an approved text field in its own native frame; never return its contents. */
export async function stateForBrowserForeignInput(guest: WebContents, expectedUrl: string,
  input: unknown, approvedOrigins: readonly string[], phase: unknown,
  value: unknown): Promise<BrowserForeignInputState> {
  if (!['select', 'verify'].includes(phase as string) ||
    phase === 'select' && value !== undefined ||
    phase === 'verify' && (typeof value !== 'string' || value.length > 4000)) {
    throw new Error('SIDEBAR_INPUT_UNAVAILABLE')
  }
  const point = await pointForBrowserForeignRef(guest, expectedUrl, input, approvedOrigins)
  const match = /^x(\d{1,10})-[a-f0-9]{64}\/(.+)$/iu.exec(input as string)
  if (match === null) throw new Error('SIDEBAR_UNKNOWN_REF')
  const leaf = guest.mainFrame.framesInSubtree.find(frame => frame.frameTreeNodeId === Number(match[1]))
  if (leaf?.executeJavaScript === undefined || leaf.origin !== point.origin) {
    throw new Error('SIDEBAR_STALE_REF')
  }
  const raw = await leaf.executeJavaScript(`(() => {
    if (location.href !== ${JSON.stringify(leaf.url)}) throw new Error('SIDEBAR_NAVIGATED');
    ${guestDomHelpers}
    const {node,frames} = sidebarResolveRef(${JSON.stringify(match[2])});
    if (frames.length !== 0 || !node.isConnected ||
      !['INPUT','TEXTAREA'].includes(node.tagName) ||
      node.tagName === 'INPUT' && !['text','search','url','tel'].includes(node.type) ||
      node.disabled || node.readOnly) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
    ${phase === 'select' ? `node.focus();
    if (sidebarActiveElement(document) !== node) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
    node.select();
    if (node.selectionStart !== 0 || node.selectionEnd !== node.value.length) {
      throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
    }` : `if (sidebarActiveElement(document) !== node ||
      node.value !== ${JSON.stringify(value)}) throw new Error('SIDEBAR_INPUT_NOT_CONFIRMED');`}
    return {hadText:node.value.length > 0};
  })()`)
  if (!record(raw) || typeof raw.hadText !== 'boolean' ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== point.fingerprint) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  return { url: expectedUrl, title: guest.getTitle().slice(0, 512), origin: point.origin,
    fingerprint: point.fingerprint, hadText: raw.hadText }
}
