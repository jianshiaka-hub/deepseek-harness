/** Bounded, origin-gated text inspection of a Sidebar guest's foreign frames. */
import { createHash } from 'node:crypto'
import type { WebContents } from 'electron'

export interface BrowserFrameAudit {
  readonly origins: readonly string[]
  readonly fingerprint: string
}

export interface BrowserForeignText {
  readonly fingerprint: string
  readonly frames: readonly { readonly origin: string; readonly text: string; readonly roles: string }[]
}

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

/** Read bounded visible text only from frames whose current origins are all approved. */
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
