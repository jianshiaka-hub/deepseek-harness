/** Bounded page-resource inventory for individually approved Browser guest frames. */
import type { WebContents } from 'electron'
import { auditBrowserFrames } from './browser-foreign-read.ts'

interface FrameAsset {
  readonly id: string
  readonly frameIndex: number
  readonly kind: 'font' | 'image' | 'stylesheet' | 'video' | 'script' | 'other'
  readonly name: string
  readonly url: string
  readonly sources: readonly {
    readonly kind: string
    readonly nodeId?: number
    readonly property?: string
  }[]
}

/** Exact guest document inventory retained for a bounded native asset read. */
export interface FrameInventory {
  readonly id: string
  readonly fingerprint: string
  readonly pageUrl: string
  readonly frames: readonly {
    readonly path: readonly number[]
    readonly frameId: number
    readonly url: string
    readonly origin: string
  }[]
  readonly frameUrls: readonly string[]
  readonly assets: readonly FrameAsset[]
  readonly inlineSvgs: readonly {
    readonly id: string
    readonly frameIndex: number
    readonly markup: string
    readonly name: string
  }[]
  readonly skippedFrameCount: number
  readonly summary: {
    readonly byKind: Readonly<Record<string, number>>
    readonly inlineSvgCount: number
    readonly totalCount: number
  }
}

interface StoredInventory {
  readonly inventory: FrameInventory
  readonly guest: WebContents
  readonly revision: number
  readonly assets: ReadonlyMap<string, FrameAsset>
}

const inventories = new WeakMap<WebContents, Map<string, StoredInventory>>()
const revisions = new WeakMap<WebContents, number>()
const MAX_INVENTORY_BYTES = 10_000_000
const MAX_ASSET_BYTES = 5_000_000

const FRAME_ASSET_SCAN = String.raw`(() => {
  const marker = __MARKER__;
  const expectedUrl = __EXPECTED_URL__;
  if (location.href !== expectedUrl || !document.documentElement) throw Error('SIDEBAR_NAVIGATED');
  const assets = [], inlineSvgs = [], seen = new Map();
  let nodes = 0;
  const kindOf = (url, fallback) => /\.(woff2?|ttf|otf)(?:[?#]|$)/i.test(url) ? 'font'
    : /\.(png|jpe?g|gif|webp|avif|svg|ico)(?:[?#]|$)/i.test(url) ? 'image'
    : /\.css(?:[?#]|$)/i.test(url) ? 'stylesheet'
    : /\.(mp4|webm|mov)(?:[?#]|$)/i.test(url) ? 'video'
    : /\.[cm]?js(?:[?#]|$)/i.test(url) ? 'script' : fallback;
  const add = (raw, kind, source) => {
    if (!raw) return;
    let url;
    try { url = new URL(raw, document.baseURI).href; } catch { return; }
    if (!/^(https?:|data:|blob:)/.test(url) || url.length > 16384) return;
    let item = seen.get(url);
    if (!item) {
      if (assets.length >= 2000) throw Error('ASSET_COUNT_LIMIT');
      item = {kind:kindOf(url,kind),name:url.startsWith('data:') ? 'inline-resource'
        : new URL(url).pathname.split('/').pop() || 'resource',sources:[],url};
      seen.set(url,item); assets.push(item);
    }
    if (item.kind === 'other' && kind !== 'other') item.kind = kind;
    if (item.sources.length < 20 && !item.sources.some(old =>
      JSON.stringify(old) === JSON.stringify(source))) item.sources.push(source);
  };
  const scan = root => {
    for (const el of root.querySelectorAll('*')) {
      if (++nodes > 20000) throw Error('DOM_NODE_LIMIT');
      const nodeId = nodes;
      for (const [property,kind] of [['src',el.tagName === 'SCRIPT' ? 'script'
        : el.tagName === 'VIDEO' || el.tagName === 'SOURCE' &&
          el.parentElement?.tagName === 'VIDEO' ? 'video' : 'image'],['poster','image']]) {
        if (['IMG','SCRIPT','VIDEO','SOURCE','INPUT'].includes(el.tagName) &&
          el.getAttribute(property)) add(property === 'src' && el.currentSrc
            ? el.currentSrc : el.getAttribute(property),kind,
            {kind:'attribute',nodeId,property});
      }
      if (el.tagName === 'LINK' && el.rel === 'stylesheet')
        add(el.href,'stylesheet',{kind:'attribute',nodeId,property:'href'});
      if (el.tagName.toLowerCase() === 'svg' && inlineSvgs.length < 200) {
        const markup = el.outerHTML;
        if (markup.length < 200000) inlineSvgs.push({markup,
          name:el.getAttribute('aria-label') || el.id || 'svg'});
      }
      const style = getComputedStyle(el);
      for (const property of ['background-image','mask-image','list-style-image'])
        for (const match of style.getPropertyValue(property).matchAll(/url\(["']?(.*?)["']?\)/g))
          add(match[1],'image',{kind:'computedStyle',nodeId,property});
      if (el.shadowRoot) scan(el.shadowRoot);
    }
  };
  scan(document);
  for (const row of performance.getEntriesByType('resource'))
    add(row.name,({css:'stylesheet',script:'script',img:'image',video:'video'})
      [row.initiatorType] || 'other',{kind:'resource'});
  Object.defineProperty(document,marker,{value:true,configurable:true});
  return {url:location.href,assets,inlineSvgs};
})()`

const FRAME_ASSET_CHECK = String.raw`(() =>
  location.href === __EXPECTED_URL__ && document[__MARKER__] === true)()`

const FRAME_ASSET_FETCH = String.raw`(async () => {
  const expectedUrl = __EXPECTED_URL__, marker = __MARKER__, url = __ASSET_URL__;
  if (location.href !== expectedUrl || document[marker] !== true)
    throw Error('STALE_ASSET_INVENTORY');
  const response = await fetch(url,{signal:AbortSignal.timeout(10000),redirect:'manual'});
  if (!response.ok) throw Error('HTTP_'+response.status);
  const reader = response.body?.getReader();
  if (!reader) throw Error('EMPTY_ASSET');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 5000000) throw Error('ASSET_SIZE_LIMIT');
      chunks.push(item.value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk,at); at += chunk.length; }
  let binary = '';
  for (let i=0; i<bytes.length; i+=8192)
    binary += String.fromCharCode(...bytes.subarray(i,i+8192));
  if (location.href !== expectedUrl || document[marker] !== true)
    throw Error('STALE_ASSET_INVENTORY');
  return {base64:btoa(binary),size,contentType:response.headers.get('content-type')};
})()`

function script(template: string, expectedUrl: string, marker: string, url?: string): string {
  return template.replaceAll('__EXPECTED_URL__', JSON.stringify(expectedUrl))
    .replaceAll('__MARKER__', JSON.stringify(marker))
    .replaceAll('__ASSET_URL__', JSON.stringify(url))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function approvedList(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every(item => typeof item === 'string')
}

function observeGuest(guest: WebContents): number {
  const existing = revisions.get(guest)
  if (existing !== undefined) return existing
  revisions.set(guest, 0)
  const invalidate = (): void => {
    revisions.set(guest, (revisions.get(guest) ?? 0) + 1)
    inventories.delete(guest)
  }
  guest.on('frame-created', invalidate)
  guest.on('will-frame-navigate', invalidate)
  guest.on('did-navigate-in-page', invalidate)
  guest.once('destroyed', () => {
    guest.off('frame-created', invalidate)
    guest.off('will-frame-navigate', invalidate)
    guest.off('did-navigate-in-page', invalidate)
    inventories.delete(guest)
    revisions.delete(guest)
  })
  return 0
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SIDEBAR_ASSET_TIMEOUT')) }, 12_000)
    })])
  } finally { clearTimeout(timer) }
}

/**
 * @param guest - exact selected Browser guest.
 * @param expectedUrl - currently observed top-frame URL.
 * @param approvedOrigins - exact origins approved before any frame content read.
 * @param marker - caller-generated inventory ID.
 * @returns bounded per-frame resource inventory.
 */
export async function listBrowserFrameAssets(guest: WebContents, expectedUrl: string,
  approvedOrigins: readonly string[], marker: string): Promise<FrameInventory> {
  if (!approvedList(approvedOrigins) || !/^[a-f0-9-]{36}$/iu.test(marker)) {
    throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  }
  const fingerprint = auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint
  const revision = observeGuest(guest)
  const id = marker
  const frames: FrameInventory['frames'][number][] = []
  const assets: FrameAsset[] = []
  const inlineSvgs: FrameInventory['inlineSvgs'][number][] = []
  const work = (async (): Promise<void> => {
    for (const frame of guest.mainFrame.framesInSubtree) {
      const value: unknown = await frame.executeJavaScript(script(FRAME_ASSET_SCAN, frame.url, id))
      if (revisions.get(guest) !== revision ||
        auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== fingerprint ||
        !record(value) || value.url !== frame.url || !Array.isArray(value.assets) ||
        !Array.isArray(value.inlineSvgs) || value.assets.length > 2000 ||
        value.inlineSvgs.length > 200) throw new Error('SIDEBAR_NAVIGATED')
      const frameIndex = frames.length
      frames.push({ path: [], frameId: frame.frameTreeNodeId, url: frame.url,
        origin: frame.origin })
      for (const item of value.assets) {
        if (!record(item) || !['font','image','stylesheet','video','script','other'].includes(
          String(item.kind)) || typeof item.url !== 'string' || item.url.length > 16384 ||
          !/^(https?:|data:|blob:)/.test(item.url) || typeof item.name !== 'string' ||
          item.name.length > 256 || !Array.isArray(item.sources) || item.sources.length > 20 ||
          assets.length >= 2000) throw new Error('ASSET_INVENTORY_INVALID')
        assets.push({ id:`${id}:${frameIndex}:${assets.length}`,frameIndex,
          kind:item.kind as FrameAsset['kind'],name:item.name,url:item.url,
          sources:item.sources as FrameAsset['sources'] })
      }
      for (const item of value.inlineSvgs) {
        if (!record(item) || typeof item.markup !== 'string' ||
          item.markup.length > 200000 || typeof item.name !== 'string' ||
          item.name.length > 256) throw new Error('ASSET_INVENTORY_INVALID')
        if (inlineSvgs.length < 200) inlineSvgs.push({ id:`${id}:svg:${frameIndex}:${inlineSvgs.length}`,
          frameIndex,markup:item.markup,name:item.name })
      }
    }
  })()
  await bounded(work)
  if (revisions.get(guest) !== revision ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== fingerprint) {
    throw new Error('SIDEBAR_NAVIGATED')
  }
  const byKind: Record<string, number> = { font:0,image:0,other:0,script:0,stylesheet:0,video:0 }
  for (const asset of assets) byKind[asset.kind] = (byKind[asset.kind] ?? 0) + 1
  const inventory: FrameInventory = { id,fingerprint,pageUrl:expectedUrl,frames,
    frameUrls:frames.map(frame => frame.url),assets,inlineSvgs,skippedFrameCount:0,
    summary:{ byKind,inlineSvgCount:inlineSvgs.length,totalCount:assets.length } }
  if (Buffer.byteLength(JSON.stringify(inventory)) > MAX_INVENTORY_BYTES) {
    throw new Error('EXPORT_SIZE_LIMIT')
  }
  let guestInventories = inventories.get(guest)
  if (guestInventories === undefined) {
    guestInventories = new Map()
    inventories.set(guest, guestInventories)
  }
  guestInventories.set(id,{ inventory,guest,revision,
    assets:new Map(assets.map(asset => [asset.id,asset])) })
  while (guestInventories.size > 8) {
    const oldest = guestInventories.keys().next().value
    if (oldest !== undefined) guestInventories.delete(oldest)
  }
  return inventory
}

function stored(guest: WebContents, expectedUrl: string, approvedOrigins: readonly string[],
  marker: string): StoredInventory {
  if (!approvedList(approvedOrigins)) throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  const entry = inventories.get(guest)?.get(marker)
  if (entry === undefined || entry.guest !== guest || entry.revision !== revisions.get(guest) ||
    entry.inventory.pageUrl !== expectedUrl ||
    auditBrowserFrames(guest, expectedUrl, approvedOrigins).fingerprint !== entry.inventory.fingerprint) {
    throw new Error('STALE_ASSET_INVENTORY')
  }
  return entry
}

/**
 * @param guest - exact selected Browser guest.
 * @param expectedUrl - original top-frame URL.
 * @param approvedOrigins - current exact-origin grants.
 * @param marker - original inventory ID.
 * @returns true only for the original frame documents.
 */
export async function checkBrowserFrameAssets(guest: WebContents, expectedUrl: string,
  approvedOrigins: readonly string[], marker: string): Promise<true> {
  const entry = stored(guest,expectedUrl,approvedOrigins,marker)
  await bounded((async () => {
    const live = guest.mainFrame.framesInSubtree
    for (const row of entry.inventory.frames) {
      const frame = live.find(item => item.frameTreeNodeId === row.frameId &&
        item.url === row.url && item.origin === row.origin)
      if (frame === undefined || await frame.executeJavaScript(
        script(FRAME_ASSET_CHECK,row.url,marker)) !== true) {
        throw new Error('STALE_ASSET_INVENTORY')
      }
    }
  })())
  stored(guest,expectedUrl,approvedOrigins,marker)
  return true
}

/**
 * @param guest - exact selected Browser guest.
 * @param expectedUrl - original top-frame URL.
 * @param approvedOrigins - current exact-origin frame grants.
 * @param approvedAssetOrigin - separately approved resource origin, or null for inline data.
 * @param marker - original inventory ID.
 * @param assetId - one ID from that inventory.
 * @returns one inventoried resource from its owning frame.
 */
export async function fetchBrowserFrameAsset(guest: WebContents, expectedUrl: string,
  approvedOrigins: readonly string[], approvedAssetOrigin: string | null,
  marker: string, assetId: string): Promise<{
  readonly base64: string
  readonly size: number
  readonly contentType: string | null
}> {
  const entry = stored(guest,expectedUrl,approvedOrigins,marker)
  const asset = entry.assets.get(assetId)
  if (asset === undefined) throw new Error('UNKNOWN_ASSET_ID')
  const assetOrigin = new URL(asset.url).origin
  if (assetOrigin !== 'null' && assetOrigin !== approvedAssetOrigin) {
    throw new Error('SIDEBAR_ASSET_SITE_NOT_APPROVED')
  }
  await checkBrowserFrameAssets(guest,expectedUrl,approvedOrigins,marker)
  const row = entry.inventory.frames[asset.frameIndex]
  if (row === undefined) throw new Error('STALE_ASSET_INVENTORY')
  const frame = guest.mainFrame.framesInSubtree.find(item =>
    item.frameTreeNodeId === row.frameId && item.url === row.url && item.origin === row.origin)
  if (frame === undefined) throw new Error('STALE_ASSET_INVENTORY')
  const value: unknown = await bounded(frame.executeJavaScript(
    script(FRAME_ASSET_FETCH,row.url,marker,asset.url)))
  await checkBrowserFrameAssets(guest,expectedUrl,approvedOrigins,marker)
  if (!record(value) || !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 || (value.size as number) > MAX_ASSET_BYTES ||
    typeof value.base64 !== 'string' ||
    Buffer.from(value.base64,'base64').length !== value.size ||
    Buffer.from(value.base64,'base64').toString('base64') !== value.base64 ||
    value.contentType !== null && (typeof value.contentType !== 'string' ||
      value.contentType.length > 256)) throw new Error('ASSET_RESPONSE_INVALID')
  return value as { base64:string;size:number;contentType:string|null }
}
