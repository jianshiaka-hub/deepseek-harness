/** Electron navigation and guest lifetime, independent from DOM placement. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { BrowserJsDialog, DesktopBrowserBridge, DesktopBrowserLeaseId } from '../../types.ts'
import type { ElectronWebviewPresentation, WebviewElement } from './ElectronWebviewPresentation.ts'
import { emptyBrowserFrame, type BrowserDialogState, type BrowserDomAction, type BrowserDomActionResult, type BrowserDomDialogResult, type BrowserFrame, type BrowserFrameState, type BrowserLoadError, type BrowserLocateQuery, type BrowserLocateResult, type BrowserPageScreenshot, type BrowserScreenshotClip } from '../browser/BrowserFrame.ts'
import type { BrowserPageOptions } from '../browser/BrowserPage.ts'
import { browserAddressCheckpoint, currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { parseBrowserAddress, type BrowserTarget } from '../browser/url.ts'

interface NavigationEvent extends Event { readonly isMainFrame: boolean }
interface LoadFailureEvent extends NavigationEvent {
  readonly errorCode: number
  readonly errorDescription: string
}

type SidebarKeyModifier = 'shift' | 'control' | 'alt' | 'meta'

/** Accept a bounded browser key chord and translate DOM arrow names to Electron accelerators. */
function sidebarKeyEvent(value: string): { keyCode: string; modifiers: SidebarKeyModifier[] } {
  if (value.length > 64) throw new Error('SIDEBAR_KEY_UNAVAILABLE')
  const parts = value.split('+')
  const key = parts.pop()
  const modifiers: SidebarKeyModifier[] = []
  for (const part of parts) {
    const mapped = part === 'Control' ? 'control' : part === 'Meta' ? 'meta'
      : part === 'Alt' ? 'alt' : part === 'Shift' ? 'shift'
        : part === 'ControlOrMeta' ? (/Mac/iu.test(navigator.platform) ? 'meta' : 'control') : undefined
    if (mapped === undefined || modifiers.includes(mapped)) throw new Error('SIDEBAR_KEY_UNAVAILABLE')
    modifiers.push(mapped)
  }
  const named = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'PageUp', 'PageDown',
    'Home', 'End', 'Space'])
  if (key === undefined || !(named.has(key) || /^[A-Za-z0-9]$/u.test(key) ||
    /^F(?:[1-9]|1\d|2[0-4])$/u.test(key) || /^Arrow(?:Up|Down|Left|Right)$/u.test(key))) {
    throw new Error('SIDEBAR_KEY_UNAVAILABLE')
  }
  return { keyCode: key.startsWith('Arrow') ? key.slice(5) : key.length === 1 ? key.toUpperCase() : key,
    modifiers }
}

function validSidebarLocateSelector(value: unknown, extraKeys: readonly string[] = []): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const selector = value as Record<string, unknown>
  const filter = selector.filter
  return typeof selector.method === 'string' &&
    ['getByRole', 'locator', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId'].includes(selector.method) &&
    Object.keys(selector).every(key => ['method', 'value', 'name', 'exact', 'filter', ...extraKeys].includes(key)) &&
    typeof selector.value === 'string' && selector.value.trim().length > 0 &&
    selector.value.length <= (selector.method === 'locator' ? 256 : 120) &&
    (selector.method !== 'getByRole' || /^[a-z][a-z0-9-]{0,31}$/u.test(selector.value)) &&
    (selector.name === undefined || selector.method === 'getByRole' && typeof selector.name === 'string' &&
      selector.name.length <= 60) && typeof selector.exact === 'boolean' &&
    (filter === undefined || filter !== null && typeof filter === 'object' &&
      !Array.isArray(filter) && Object.keys(filter).length > 0 &&
      Object.entries(filter).every(([key, nested]) =>
        ['hasText', 'hasNotText'].includes(key)
          ? typeof nested === 'string' && nested.length > 0 && nested.length <= 120
          : ['has', 'hasNot'].includes(key) && nested !== null && typeof nested === 'object' &&
            !('filter' in nested) && validSidebarLocateSelector(nested)))
}

/** Executed inside the guest; frame DOM is included only when the browser itself grants same-origin access. */
const guestDomHelpers = String.raw`
  const sidebarSelector = 'a,button,input,textarea,select,[role],[contenteditable],h1,h2,h3';
  const sidebarFrames = (doc = document) => [...doc.querySelectorAll('iframe,frame')].slice(0, 100);
  const sidebarFrameDocument = (frame) => {
    try {
      const source = frame.getAttribute('src');
      if (source) {
        const target = new URL(source, frame.ownerDocument.baseURI);
        if (['http:','https:'].includes(target.protocol) && target.origin !== location.origin) return null;
      }
      const child = frame.contentDocument;
      if (!child) return null;
      const href = child.location.href;
      if (child.location.origin !== location.origin && href !== 'about:blank' && href !== 'about:srcdoc') return null;
      return child;
    } catch { return null; }
  };
  const sidebarFrameToken = (doc) => {
    let hash = 2166136261;
    const revision = doc.location.href + '|' + doc.defaultView.performance.timeOrigin;
    for (const char of revision) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  const sidebarNodes = (doc) => {
    const interactive = [...doc.querySelectorAll(sidebarSelector)].slice(0, 150);
    const extra = [...doc.querySelectorAll('label,p,summary,[data-testid],[placeholder],[aria-label]')]
      .filter(node => !interactive.includes(node)).slice(0, 150);
    return interactive.concat(extra);
  };
  const sidebarAllNodes = (doc) => {
    const nodes = doc.querySelectorAll('*');
    if (nodes.length > 100000) throw new Error('SIDEBAR_DOM_LIMIT');
    return nodes;
  };
  const sidebarDomFingerprint = (doc,node,index) => {
    const attributes = node.getAttributeNames().sort().slice(0,24)
      .map(name => name + '=' + (node.getAttribute(name) || '').slice(0,120));
    const material = [doc.location.href,doc.defaultView.performance.timeOrigin,index,node.tagName,
      ...attributes,(node.textContent || '').slice(0,120)].join('|');
    let hash = 2166136261;
    for (const char of material) hash = Math.imul(hash ^ char.charCodeAt(0),16777619);
    return (hash >>> 0).toString(16).padStart(8,'0');
  };
  const sidebarDescribe = (node) => {
    const rawRole = node.getAttribute('role') || '';
    const role = /^[a-z][a-z0-9-]{0,31}$/.test(rawRole) ? rawRole :
      node.tagName === 'INPUT' ? ({number:'spinbutton',range:'slider',checkbox:'checkbox',radio:'radio'})[node.type] || 'textbox' :
      ({A:'link',BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox',H1:'heading',H2:'heading',H3:'heading'})[node.tagName] ||
        (node.getAttribute('contenteditable') !== null ? 'textbox' : node.tagName.toLowerCase());
    const name = (node.getAttribute('aria-label') || node.innerText || node.getAttribute('placeholder') || '')
      .trim().replace(/\s+/g, ' ').replaceAll('[ref=', '[ref =').slice(0, 60);
    return {role, name};
  };
  const sidebarResolveRef = (ref) => {
    const match = /^((?:f\d{1,2}-[0-9a-f]{8}\/){0,8})(d\d{1,5}-[0-9a-f]{8}|\d{1,3}):([^:]+):(.*)$/.exec(ref);
    if (!match) throw new Error('SIDEBAR_UNKNOWN_REF');
    let doc = document;
    const frames = [];
    for (const segment of match[1].matchAll(/f(\d{1,2})-([0-9a-f]{8})\//g)) {
      const frame = sidebarFrames(doc)[Number(segment[1])];
      const child = frame && sidebarFrameDocument(frame);
      if (!child || sidebarFrameToken(child) !== segment[2]) throw new Error('SIDEBAR_STALE_REF');
      frames.push(frame);
      doc = child;
    }
    const domRef = /^d(\d{1,5})-([0-9a-f]{8})$/.exec(match[2]);
    const node = domRef ? sidebarAllNodes(doc)[Number(domRef[1])] : sidebarNodes(doc)[Number(match[2])];
    if (!node) throw new Error('SIDEBAR_STALE_REF');
    if (domRef && sidebarDomFingerprint(doc,node,Number(domRef[1])) !== domRef[2]) {
      throw new Error('SIDEBAR_STALE_REF');
    }
    const described = sidebarDescribe(node);
    if (described.role !== match[3] || described.name !== decodeURIComponent(match[4])) {
      throw new Error('SIDEBAR_STALE_REF');
    }
    return {node, frames, doc};
  };
  const sidebarHit = (x, y) => {
    let doc = document;
    const frames = [];
    let localX = x, localY = y;
    for (;;) {
      const hit = doc.elementFromPoint(localX, localY);
      if (!hit) throw new Error('SIDEBAR_TARGET_OCCLUDED');
      if (!hit.matches('iframe,frame')) return {hit,frames,doc};
      if (frames.length >= 8 || !sidebarFrames(doc).includes(hit)) throw new Error('SIDEBAR_FRAME_UNAVAILABLE');
      const child = sidebarFrameDocument(hit);
      if (!child) throw new Error('SIDEBAR_FRAME_UNAVAILABLE');
      const rect = hit.getBoundingClientRect();
      localX -= rect.left + hit.clientLeft;
      localY -= rect.top + hit.clientTop;
      frames.push(hit);
      doc = child;
    }
  };
  const sidebarPoint = (node, frames) => {
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('SIDEBAR_TARGET_NOT_VISIBLE');
    let x = rect.left + rect.width / 2;
    let y = rect.top + rect.height / 2;
    for (let index = frames.length - 1; index >= 0; index--) {
      const frame = frames[index];
      const outer = frame.getBoundingClientRect();
      x += outer.left + frame.clientLeft;
      y += outer.top + frame.clientTop;
    }
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error('SIDEBAR_POINT_OUT_OF_BOUNDS');
    const target = sidebarHit(x, y);
    if (target.frames.length !== frames.length ||
      target.frames.some((frame,index) => frame !== frames[index]) ||
      !(target.hit === node || node.contains(target.hit))) {
      throw new Error('SIDEBAR_TARGET_OCCLUDED');
    }
    return {x,y,hit:target.hit,doc:target.doc};
  };
`

/** A viewport image includes child-frame pixels; reject it unless every reachable frame stays at the approved origin. */
const screenshotFrameGuard = String.raw`
  const collectFrames = (root) => {
    const frames = [...root.querySelectorAll('iframe,frame')];
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) frames.push(...collectFrames(node.shadowRoot));
    }
    return frames;
  };
  const inspectFrames = (doc, depth, counter) => {
    if (depth > 8) throw new Error('SIDEBAR_FRAME_LIMIT');
    for (const frame of collectFrames(doc)) {
      if (++counter.count > 100) throw new Error('SIDEBAR_FRAME_LIMIT');
      try {
        const source = frame.getAttribute('src');
        if (source) {
          const target = new URL(source, doc.baseURI);
          if (['http:','https:'].includes(target.protocol) && target.origin !== location.origin) {
            throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED');
          }
        }
        const child = frame.contentDocument;
        if (!child || (child.location.origin !== location.origin &&
          child.location.href !== 'about:blank' && child.location.href !== 'about:srcdoc')) {
          throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED');
        }
        inspectFrames(child, depth + 1, counter);
      } catch (error) {
        if (error?.message === 'SIDEBAR_FRAME_LIMIT') throw error;
        throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED');
      }
    }
  };
  inspectFrames(document, 0, {count:0});
`

/** Owns native history and translates Electron observations into common frame state. */
export class ElectronWebViewImpl implements BrowserFrame {
  private readonly store: SnapshotStore<BrowserFrameState>
  private readonly lifetime = new AbortController()
  private guestLifetime: AbortController | undefined
  private element: WebviewElement | undefined
  private lease: DesktopBrowserLeaseId | undefined
  private workspaceKey: string | undefined
  private initializing: Promise<void> | undefined
  private ready = false
  private pending: BrowserTarget | undefined
  private revision = 0
  private firstDocument = true
  private checkpoint: BrowserTarget | undefined
  private disposal: Promise<void> | undefined
  private attachment: AbortController | undefined
  private readonly releases = new Set<Promise<void>>()
  private pendingDialog: {
    readonly lease: DesktopBrowserLeaseId
    readonly token: string
    readonly info: BrowserJsDialog
    readonly expectedUrl: string
    readonly action: Promise<BrowserDomActionResult>
    readonly cancelAction: () => void
    handling: boolean
  } | undefined
  private pendingDialogTimer: ReturnType<typeof setInterval> | undefined

  /**
   * @param options - saved address, persistence and source-tab opening callback.
   * @param bridge - main-process guest operations.
   * @param workspace - resolves the storage account once for this frame lifetime.
   * @param presentation - tag and Sidebar placement adapter.
   */
  constructor(private readonly options: BrowserPageOptions, private readonly bridge: DesktopBrowserBridge,
    private readonly workspace: (signal: AbortSignal) => Promise<string>,
    private readonly presentation: ElectronWebviewPresentation) {
    this.checkpoint = currentBrowserTarget(options.initial)
    this.store = createSnapshotStore(emptyBrowserFrame())
  }

  /** @returns immutable carrier-neutral navigation state. */
  getSnapshot = (): BrowserFrameState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** A physical mount may recreate a lost guest; ordinary Sidebar hiding never calls this. */
  attach(): void {
    if (this.lifetime.signal.aborted) return
    this.attachment = new AbortController()
    this.pending ??= this.store.getSnapshot().target
    if (this.pending !== undefined) {
      this.store.set({ ...this.store.getSnapshot(), address: 'requested', loading: true,
        canGoBack: false, canGoForward: false, error: undefined })
      this.initialize()
    }
  }

  /** Invalidate pending attachment before the containing DOM is removed. */
  detach(): void {
    this.attachment?.abort()
    this.attachment = undefined
    this.pending = this.store.getSnapshot().target
    void this.dropGuest()
  }

  /** @param target - validated address, loaded without replacing the guest. */
  loadUrl(target: BrowserTarget): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    if (this.ready && current.address === 'observed' && current.target?.url === target.url) {
      this.reload()
      return
    }
    this.revision++
    this.pending = target
    this.store.set({ ...current, target, address: 'requested', loading: true, error: undefined })
    this.persist(target)
    if (this.ready) this.loadPending()
    else this.initialize()
  }

  /** Move backward through Chromium history. */
  goBack(): void {
    if (this.store.getSnapshot().canGoBack) this.navigate('goBack')
  }

  /** Move forward through Chromium history. */
  goForward(): void {
    if (this.store.getSnapshot().canGoForward) this.navigate('goForward')
  }

  /** Reload the actual current page, or retry failed guest creation. */
  reload(): void {
    const current = this.store.getSnapshot()
    if (this.lifetime.signal.aborted || current.target === undefined) return
    if (!this.ready || current.error !== undefined) {
      this.revision++
      this.pending = current.target
      this.store.set({ ...current, loading: true, error: undefined })
      if (this.ready) this.loadPending()
      else this.initialize()
    } else this.navigate('reload')
  }

  /** Read the selected guest's top-level document after exact URL checks on both sides of execution. */
  async inspect(expectedUrl: string): Promise<{ readonly url: string; readonly title: string; readonly text: string }> {
    const element = this.element
    if (element === undefined || !this.ready || this.lifetime.signal.aborted ||
      this.store.getSnapshot().address !== 'observed' || element.getURL() !== expectedUrl) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const body = document.body;
      const text = (body?.innerText ?? '').slice(0, 24000).replaceAll('[ref=', '[ref =');
      const roles = sidebarNodes(document).slice(0, 150).map((node, index) => {
        const {role,name} = sidebarDescribe(node);
        return '- ' + role + ' "' + name + '" [ref=' + index + ':' + role + ':' + encodeURIComponent(name) + ']';
      });
      const collectFrames = (parent, parentPrefix, depth, counter) => {
        if (depth >= 8) return;
        const frames = sidebarFrames(parent);
        for (let index = 0; index < frames.length; index++) {
          if (++counter.count > 100) return;
          const doc = sidebarFrameDocument(frames[index]);
          if (!doc) continue;
          const prefix = parentPrefix + 'f' + index + '-' + sidebarFrameToken(doc) + '/';
          roles.push('[Same-origin frame ' + prefix + '] ' + (doc.body?.innerText ?? '').slice(0, 1500).replaceAll('[ref=', '[ref ='));
          for (const [nodeIndex,node] of sidebarNodes(doc).slice(0, 50).entries()) {
            const {role,name} = sidebarDescribe(node);
            roles.push('- ' + role + ' "' + name + '" [ref=' + prefix + nodeIndex + ':' + role + ':' + encodeURIComponent(name) + ']');
          }
          collectFrames(doc, prefix, depth + 1, counter);
        }
      };
      collectFrames(document, '', 0, {count:0});
      return {url:location.href,title:document.title.slice(0,512),text:(text+'\\n[Accessibility]\\n'+roles.join('\\n')).slice(0,32000)};
    })()`
    const value = await element.executeJavaScript(code)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest may change while executeJavaScript awaits.
    if (this.element !== element || this.lifetime.signal.aborted || element.getURL() !== expectedUrl ||
      this.store.getSnapshot().address !== 'observed' || typeof value !== 'object' || value === null ||
      !('url' in value) || value.url !== expectedUrl || !('title' in value) || typeof value.title !== 'string' ||
      !('text' in value) || typeof value.text !== 'string') throw new Error('SIDEBAR_NAVIGATED')
    return { url: value.url, title: value.title, text: value.text }
  }

  /** Run one fixed locator query without exporting a page-wide DOM snapshot. */
  async locate(expectedUrl: string, query: BrowserLocateQuery): Promise<BrowserLocateResult> {
    const element = this.element
    if (element === undefined || !this.ready || this.lifetime.signal.aborted ||
      this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
      element.getURL() !== expectedUrl) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    if (!validSidebarLocateSelector(query, ['frames', 'scopes', 'position', 'projection']) ||
      query.projection !== undefined && !['visible', 'enabled'].includes(query.projection) ||
      query.scopes !== undefined && (!Array.isArray(query.scopes) || query.scopes.length < 1 ||
        query.scopes.length > 2 || query.scopes.some(scope => !validSidebarLocateSelector(scope))) ||
      query.position !== undefined &&
      (!['first', 'last', 'nth'].includes(query.position.method) || query.position.method === 'nth' &&
        (!Number.isSafeInteger(query.position.index) || query.position.index === undefined ||
          query.position.index < 0 || query.position.index > 99999)) ||
      query.frames !== undefined && (!Array.isArray(query.frames) || query.frames.length < 1 ||
        query.frames.length > 8 || query.frames.some(frame => typeof frame !== 'string' ||
          frame.trim().length < 1 || frame.length > 256))) {
      throw new Error('SIDEBAR_LOCATOR_UNAVAILABLE')
    }
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const query = ${JSON.stringify(query)};
      const selectors = [...(query.scopes || []),query];
      const normalize = (value) => String(value || '').trim().replace(/\\s+/g,' ');
      const textMatches = (value,needle,exact) => exact
        ? normalize(value) === normalize(needle)
        : normalize(value).toLocaleLowerCase().includes(normalize(needle).toLocaleLowerCase());
      const matchesBase = (node,selector) => {
        if (selector.method === 'locator') {
          try { return node.matches(selector.value); }
          catch { throw new Error('SIDEBAR_SELECTOR_INVALID'); }
        }
        if (selector.method === 'getByRole') {
          const described = sidebarDescribe(node);
          return described.role === selector.value &&
            (selector.name === undefined || textMatches(described.name,selector.name,selector.exact));
        }
        if (selector.method === 'getByTestId') return node.getAttribute('data-testid') === selector.value;
        let text = '';
        if (selector.method === 'getByText') {
          text = node.innerText || '';
          if (!textMatches(text,selector.value,selector.exact)) return false;
          return ![...node.children].some(child =>
            textMatches(child.innerText || '',selector.value,selector.exact));
        }
        else if (selector.method === 'getByPlaceholder') text = node.getAttribute('placeholder') || '';
        else if (selector.method === 'getByLabel') {
          const labels = node.labels ? [...node.labels].map(label => label.innerText) : [];
          const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\\s+/)
            .map(id => id && node.ownerDocument.getElementById(id)?.innerText || '');
          text = [node.getAttribute('aria-label') || '', ...labels, ...labelledBy].join(' ');
        }
        return textMatches(text,selector.value,selector.exact);
      };
      const matches = (node,selector,step) => {
        if (!matchesBase(node,selector)) return false;
        const filter = selector.filter;
        if (!filter) return true;
        const text = node.innerText || '';
        return (filter.hasText === undefined || textMatches(text,filter.hasText,false)) &&
          (filter.hasNotText === undefined || !textMatches(text,filter.hasNotText,false)) &&
          (nestedResults[step].has === null || nestedResults[step].has.has(node)) &&
          (nestedResults[step].hasNot === null || !nestedResults[step].hasNot.has(node));
      };
      let doc = document, prefix = '';
      const frameNodes = [];
      for (const selector of query.frames || []) {
        let frames;
        try { frames = [...doc.querySelectorAll(selector)].filter(node => node.matches('iframe,frame')); }
        catch { throw new Error('SIDEBAR_SELECTOR_INVALID'); }
        if (frames.length !== 1) throw new Error(frames.length ? 'SIDEBAR_FRAME_AMBIGUOUS' : 'SIDEBAR_FRAME_NOT_FOUND');
        const index = sidebarFrames(doc).indexOf(frames[0]);
        const child = index < 0 ? null : sidebarFrameDocument(frames[0]);
        if (!child) throw new Error('SIDEBAR_FRAME_UNAVAILABLE');
        prefix += 'f' + index + '-' + sidebarFrameToken(child) + '/';
        frameNodes.push(frames[0]);
        doc = child;
      }
      let count = 0, first = null, last = null, nth = null;
      const nodes = sidebarAllNodes(doc);
      const nestedDescendants = nested => {
        if (nested === undefined) return null;
        const containing = new WeakSet();
        for (let index = nodes.length - 1; index >= 0; index--) {
          const node = nodes[index];
          if ((matchesBase(node,nested) || containing.has(node)) && node.parentElement) {
            containing.add(node.parentElement);
          }
        }
        return containing;
      };
      const nestedResults = selectors.map(selector => ({
        has:nestedDescendants(selector.filter?.has),
        hasNot:nestedDescendants(selector.filter?.hasNot),
      }));
      const states = new WeakMap();
      for (const [index,node] of nodes.entries()) {
        const inherited = states.get(node.parentElement) || 0;
        let state = inherited, matchedFinal = false;
        for (let step = 0; step < selectors.length; step++) {
          if (step > 0 && !(inherited & (1 << (step - 1)))) continue;
          if (!matches(node,selectors[step],step)) continue;
          state |= 1 << step;
          if (step === selectors.length - 1) matchedFinal = true;
        }
        states.set(node,state);
        if (!matchedFinal) continue;
        const candidate = {doc,prefix,index,node};
        if (count === 0) first = candidate;
        if (query.position?.method === 'nth' && count === query.position.index) nth = candidate;
        last = candidate;
        count++;
      }
      const chosen = query.position?.method === 'first' ? first
        : query.position?.method === 'last' ? last
          : query.position?.method === 'nth' ? nth : count === 1 ? first : null;
      const rows = chosen === null ? [] : (() => {
        const {doc,prefix,index,node} = chosen;
        const {role,name} = sidebarDescribe(node);
        return [{ref:prefix + 'd' + index + '-' + sidebarDomFingerprint(doc,node,index)
          + ':' + role + ':' + encodeURIComponent(name),role,name,
          ...(query.projection === 'visible' ? {visible:[...frameNodes,node].every(element => {
            const style = element.ownerDocument.defaultView.getComputedStyle(element);
            return style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
              [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
          })} : {}),
          ...(query.projection === 'enabled' ? {enabled:!node.matches(':disabled') &&
            !node.closest('[aria-disabled="true"],[inert]')} : {})}];
      })();
      return {url:location.href,title:document.title.slice(0,512),count,rows};
    })()`
    const raw = await element.executeJavaScript(code)
    if (raw === null || typeof raw !== 'object') throw new Error('SIDEBAR_NAVIGATED')
    const value = raw as BrowserLocateResult
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest may close or navigate while executeJavaScript awaits.
    if (this.element !== element || this.lifetime.signal.aborted || element.getURL() !== expectedUrl ||
      this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
      value.url !== expectedUrl || typeof value.title !== 'string' ||
      !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 1000000 ||
      !Array.isArray(value.rows) || value.rows.length > 1) throw new Error('SIDEBAR_NAVIGATED')
    return value
  }

  /** Capture the selected guest's viewport or full page, then recheck its document and lifetime. */
  async screenshot(expectedUrl: string, clip?: BrowserScreenshotClip, fullPage = false): Promise<BrowserPageScreenshot> {
    const element = this.element
    if (element === undefined || !this.ready || this.lifetime.signal.aborted ||
      this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
      element.getURL() !== expectedUrl) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    const guard = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${screenshotFrameGuard}
      return location.href;
    })()`
    if (await element.executeJavaScript(guard) !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest state may change while the guard awaits.
    if (this.element !== element || this.lifetime.signal.aborted ||
      this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
      element.getURL() !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
    if (fullPage) {
      const lease = this.lease
      if (lease === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
      const result = await this.bridge.captureFullPage(lease, expectedUrl, clip)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Lease and guest may change during capture.
      if (this.element !== element || this.lease !== lease || this.lifetime.signal.aborted ||
        this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
        element.getURL() !== expectedUrl || result.url !== expectedUrl ||
        await element.executeJavaScript(guard) !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
      return result
    }
    const image = await element.capturePage()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest may change during capture.
    if (this.element !== element || this.lifetime.signal.aborted ||
      this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
      element.getURL() !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
    if (await element.executeJavaScript(guard) !== expectedUrl ||
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest may change while the guard awaits.
      this.element !== element || this.lifetime.signal.aborted ||
      this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
      element.getURL() !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
    const { width, height } = image.getSize()
    if (image.isEmpty() || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
    if (clip !== undefined && (!Number.isSafeInteger(clip.x) || !Number.isSafeInteger(clip.y) ||
      !Number.isSafeInteger(clip.width) || !Number.isSafeInteger(clip.height) ||
      clip.x < 0 || clip.y < 0 || clip.width < 1 || clip.height < 1 ||
      clip.x + clip.width > width || clip.y + clip.height > height)) throw new Error('SIDEBAR_CLIP_OUT_OF_BOUNDS')
    const output = clip === undefined ? image : image.crop(clip)
    const outputSize = output.getSize()
    if (output.isEmpty() || (clip !== undefined &&
      (outputSize.width !== clip.width || outputSize.height !== clip.height))) throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
    const dataUrl = output.toDataURL()
    const prefix = 'data:image/png;base64,'
    if (!dataUrl.startsWith(prefix) || dataUrl.length - prefix.length > 5_592_408) {
      throw new Error('SIDEBAR_IMAGE_TOO_LARGE')
    }
    return { url: expectedUrl, title: element.getTitle().slice(0, 512),
      base64: dataUrl.slice(prefix.length), viewport: { width, height } }
  }

  /** Run one allow-listed action against the currently selected document. */
  async action(expectedUrl: string, action: BrowserDomAction, stillSelected: () => boolean = () => true): Promise<BrowserDomActionResult> {
    const element = this.element
    if (element === undefined || !this.ready || this.lifetime.signal.aborted ||
      this.store.getSnapshot().address !== 'observed' || this.store.getSnapshot().loading ||
      element.getURL() !== expectedUrl || !stillSelected()) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    if (action.op === 'click') return this.nativeClick(element, expectedUrl, action, stillSelected)
    if (action.op === 'drag') return this.nativeDrag(element, expectedUrl, action, stillSelected)
    if (action.op === 'type') return this.nativeType(element, expectedUrl, action, stillSelected)
    if (action.op === 'paste') return this.nativePaste(element, expectedUrl, action, stillSelected)
    if (action.op === 'setValue') return this.nativeSetValue(element, expectedUrl, action, stillSelected)
    if (action.op === 'selectText') return this.nativeSelectText(element, expectedUrl, action, stillSelected)
    if (action.op === 'secondary') return this.nativeSecondary(element, expectedUrl, action, stillSelected)
    if (action.op === 'key') return this.nativeKey(element, expectedUrl, action, stillSelected)
    if (action.op === 'navigate') throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    return this.nativeScroll(element, expectedUrl, action, stillSelected)
  }

  /** Surface a modal before a native action blocks waiting for its page script. */
  async actionWithDialog(expectedUrl: string, action: BrowserDomAction,
    stillSelected: () => boolean): Promise<BrowserDomDialogResult> {
    const element = this.element
    const lease = this.lease
    if (this.pendingDialog !== undefined) throw new Error('SIDEBAR_DIALOG_OPEN')
    if (element === undefined || lease === undefined || !this.inputStillSelected(element, expectedUrl, stillSelected)) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    // HTML dragging owns the same debugger exclusively for its duration.
    if (action.op === 'drag') return this.action(expectedUrl, action, stillSelected)
    const token = await this.bridge.beginDialog(lease, expectedUrl)
    let keep = false
    try {
      if (this.lease !== lease || !this.inputStillSelected(element, expectedUrl, stillSelected)) {
        throw new Error('SIDEBAR_SELECTION_CHANGED')
      }
      let mayContinue = true
      const cancelAction = (): void => { mayContinue = false }
      const pending = action.op === 'navigate'
        ? this.nativeNavigate(element, expectedUrl, action, () => mayContinue && stillSelected(), lease, token)
        : this.action(expectedUrl, action, () => mayContinue && stillSelected())
      // The action can settle after the dialog is returned; retain its rejection.
      void pending.catch(() => {})
      const outcome = await Promise.race([
        pending.then(value => ({ kind: 'action' as const, value }), (error: unknown) => ({ kind: 'error' as const, error })),
        this.bridge.waitDialog(lease, token, 15_000).then(dialog => ({ kind: 'dialog' as const, dialog })),
      ])
      if (outcome.kind === 'error') throw outcome.error
      if (outcome.kind === 'action') {
        let late: BrowserJsDialog | null
        try { late = await this.bridge.getDialog(lease, token) }
        catch (error) {
          const state = this.store.getSnapshot()
          if (this.element === element && !this.lifetime.signal.aborted && stillSelected() &&
            state.address === 'observed' && !state.loading && state.target?.url === element.getURL() &&
            (action.op === 'navigate' || element.getURL() !== expectedUrl)) {
            return { ...outcome.value, url: element.getURL(), title: element.getTitle().slice(0, 512) }
          }
          throw error
        }
        if (late === null) return outcome.value
        this.pendingDialog = { lease, token, info: late, expectedUrl, action: pending, cancelAction, handling: false }
      } else {
        if (outcome.dialog === null) throw new Error('SIDEBAR_ACTION_TIMEOUT')
        this.pendingDialog = { lease, token, info: outcome.dialog, expectedUrl, action: pending, cancelAction,
          handling: false }
      }
      keep = true
      const openedAt = Date.now()
      this.pendingDialogTimer = setInterval(() => {
        if (Date.now() - openedAt >= 290_000 ||
          (this.pendingDialog?.handling === true
            ? this.element !== element || this.lifetime.signal.aborted || !stillSelected()
            : !this.dialogStillSelected(element, expectedUrl, stillSelected, this.pendingDialog?.info.type))) {
          void this.cancelDialog()
        }
      }, 50)
      return { url: expectedUrl, title: element.getTitle().slice(0, 512), performed: true,
        dialog: this.pendingDialog.info }
    } finally {
      if (!keep) await this.bridge.finishDialog(lease, token).catch(() => {})
    }
  }

  async dialog(expectedUrl: string, stillSelected: () => boolean): Promise<BrowserDialogState> {
    const element = this.element
    if (element === undefined ||
      !this.dialogStillSelected(element, expectedUrl, stillSelected, this.pendingDialog?.info.type)) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    const active = this.pendingDialog
    if (active === undefined) return { url: expectedUrl, title: element.getTitle().slice(0, 512), dialog: null }
    if (active.expectedUrl !== expectedUrl || this.lease !== active.lease) throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    let dialog: BrowserJsDialog | null
    try { dialog = await this.bridge.getDialog(active.lease, active.token) }
    catch (error) { await this.cancelDialog(); throw error }
    if (dialog?.id !== active.info.id) throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    return { url: expectedUrl, title: element.getTitle().slice(0, 512), dialog }
  }

  pendingDialogUrl(): string | undefined {
    const active = this.pendingDialog
    return active !== undefined && this.lease === active.lease && this.element !== undefined &&
      !this.lifetime.signal.aborted && this.element.getURL() === active.expectedUrl
      ? active.expectedUrl : undefined
  }

  async handleDialog(expectedUrl: string, dialogId: string, action: 'accept' | 'dismiss',
    text: string | undefined, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    const active = this.pendingDialog
    const element = this.element
    if (active === undefined || element === undefined || active.expectedUrl !== expectedUrl ||
      active.info.id !== dialogId || this.lease !== active.lease ||
      !this.dialogStillSelected(element, expectedUrl, stillSelected, active.info.type)) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    const navigation = active.info.type === 'beforeunload' && action === 'accept'
      ? this.observeDialogNavigation(element, stillSelected) : undefined
    active.handling = true
    try { await this.bridge.handleDialog(active.lease, active.token, dialogId, action, text) }
    catch (error) { navigation?.dispose(); await this.cancelDialog(); throw error }
    this.clearDialogState(active)
    if (active.info.type === 'beforeunload' && action === 'dismiss') {
      // The navigation was cancelled by the page modal; stop its pending wait.
      active.cancelAction()
      return { url: element.getURL(), title: element.getTitle().slice(0, 512), performed: true }
    }
    // A page script may continue after modal resolution. Report the observed
    // destination only after the native action settles or fail explicitly.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([active.action, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('SIDEBAR_ACTION_TIMEOUT')) }, 10_000)
      })])
      await navigation?.settled
    } finally { clearTimeout(timer); navigation?.dispose() }
    if (this.element !== element || this.lifetime.signal.aborted || !stillSelected()) {
      throw new Error('SIDEBAR_SELECTION_CHANGED')
    }
    return { url: element.getURL(), title: element.getTitle().slice(0, 512), performed: true }
  }

  private clearDialogState(active: NonNullable<ElectronWebViewImpl['pendingDialog']>): void {
    if (this.pendingDialog !== active) return
    this.pendingDialog = undefined
    if (this.pendingDialogTimer !== undefined) clearInterval(this.pendingDialogTimer)
    this.pendingDialogTimer = undefined
  }

  private async cancelDialog(): Promise<void> {
    const active = this.pendingDialog
    if (active === undefined) return
    active.cancelAction()
    this.clearDialogState(active)
    await this.bridge.finishDialog(active.lease, active.token).catch(() => {})
  }

  private inputStillSelected(element: WebviewElement, expectedUrl: string, stillSelected: () => boolean): boolean {
    return this.element === element && !this.lifetime.signal.aborted &&
      this.store.getSnapshot().address === 'observed' && !this.store.getSnapshot().loading &&
      element.getURL() === expectedUrl && stillSelected()
  }

  private async nativeNavigate(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'navigate' }>,
    stillSelected: () => boolean, lease: DesktopBrowserLeaseId, token: string): Promise<BrowserDomActionResult> {
    if (!this.inputStillSelected(element, expectedUrl, stillSelected) ||
      this.lease !== lease ||
      action.method === 'goto' && (action.url === undefined || !URL.canParse(action.url) ||
        !['http:', 'https:'].includes(new URL(action.url).protocol) ||
        new URL(action.url).href !== action.url || new URL(action.url).username !== '' ||
        new URL(action.url).password !== '')) {
      throw new Error('SIDEBAR_NAVIGATION_UNAVAILABLE')
    }
    let started = false
    let committed = false
    let stopped = false
    let done = false
    let finish: ((error?: Error, result?: BrowserDomActionResult) => void) | undefined
    const settled = new Promise<BrowserDomActionResult>((resolve, reject) => {
      finish = (error, result) => { if (error !== undefined) reject(error); else if (result !== undefined) resolve(result) }
    })
    const dispose = (): void => {
      element.removeEventListener('did-start-navigation', onStart)
      element.removeEventListener('did-start-loading', onStart)
      element.removeEventListener('did-navigate', onCommit)
      element.removeEventListener('did-navigate-in-page', onCommit)
      element.removeEventListener('did-stop-loading', onStop)
      element.removeEventListener('did-fail-load', onFailure)
      clearInterval(interval)
      clearTimeout(timeout)
    }
    const complete = (error?: Error, result?: BrowserDomActionResult): void => {
      if (done) return
      done = true
      dispose()
      finish?.(error, result)
    }
    const check = (): void => {
      if (this.element !== element || this.lifetime.signal.aborted || !stillSelected()) {
        complete(new Error('SIDEBAR_SELECTION_CHANGED'))
      } else if ((committed || started && stopped) && !element.isLoading() &&
        this.store.getSnapshot().address === 'observed' &&
        this.store.getSnapshot().target?.url === element.getURL()) {
        complete(undefined, { url: element.getURL(), title: element.getTitle().slice(0, 512), performed: true })
      }
    }
    const onStart = (): void => { started = true; stopped = false }
    const onCommit = (): void => { committed = true; check() }
    const onStop = (): void => { stopped = true; if (started || committed) check() }
    const onFailure = (event: Event): void => {
      const failure = event as LoadFailureEvent
      if (failure.isMainFrame && failure.errorCode !== -3) complete(new Error('SIDEBAR_NAVIGATION_FAILED'))
    }
    const interval = setInterval(check, 50)
    const timeout = setTimeout(() => { complete(new Error('SIDEBAR_NAVIGATION_TIMEOUT')) }, 12_000)
    element.addEventListener('did-start-navigation', onStart)
    element.addEventListener('did-start-loading', onStart)
    element.addEventListener('did-navigate', onCommit)
    element.addEventListener('did-navigate-in-page', onCommit)
    element.addEventListener('did-stop-loading', onStop)
    element.addEventListener('did-fail-load', onFailure)
    void this.bridge.navigate(lease, token, expectedUrl, action.method, action.url)
      .catch(() => { complete(new Error('SIDEBAR_NAVIGATION_FAILED')) })
    return settled
  }

  private dialogStillSelected(element: WebviewElement, expectedUrl: string,
    stillSelected: () => boolean, type?: BrowserJsDialog['type']): boolean {
    return this.element === element && !this.lifetime.signal.aborted && element.getURL() === expectedUrl &&
      stillSelected() && (type === 'beforeunload' ||
        this.store.getSnapshot().address === 'observed' && !this.store.getSnapshot().loading)
  }

  /** Wait for the actual destination; an accepted beforeunload is not itself a completed navigation. */
  private observeDialogNavigation(element: WebviewElement, stillSelected: () => boolean): {
    readonly settled: Promise<void>
    readonly dispose: () => void
  } {
    let committed = false
    let finish: ((error?: Error) => void) | undefined
    const settled = new Promise<void>((resolve, reject) => {
      finish = (error) => { if (error === undefined) resolve(); else reject(error) }
    })
    // A failed dialog action can dispose this observer without awaiting it.
    void settled.catch(() => {})
    let done = false
    const dispose = (): void => {
      element.removeEventListener('did-navigate', onCommit)
      element.removeEventListener('did-stop-loading', check)
      element.removeEventListener('did-fail-load', onFailure)
      clearInterval(interval)
      clearTimeout(timeout)
    }
    const complete = (error?: Error): void => {
      if (done) return
      done = true
      dispose()
      finish?.(error)
    }
    const check = (): void => {
      if (this.element !== element || this.lifetime.signal.aborted || !stillSelected()) {
        complete(new Error('SIDEBAR_SELECTION_CHANGED'))
      } else if (committed && !element.isLoading()) complete()
    }
    const onCommit = (): void => { committed = true; check() }
    const onFailure = (event: Event): void => {
      const failure = event as LoadFailureEvent
      if (failure.isMainFrame && failure.errorCode !== -3) complete(new Error('SIDEBAR_NAVIGATION_FAILED'))
    }
    const interval = setInterval(check, 50)
    const timeout = setTimeout(() => { complete(new Error('SIDEBAR_NAVIGATION_TIMEOUT')) }, 12_000)
    element.addEventListener('did-navigate', onCommit)
    element.addEventListener('did-stop-loading', check)
    element.addEventListener('did-fail-load', onFailure)
    return { settled, dispose }
  }

  private async nativeKey(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'key' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    const keyboard = sidebarKeyEvent(action.key)
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const ref = ${JSON.stringify(action.ref ?? null)};
      const resolved = ref === null ? null : sidebarResolveRef(ref);
      const node = resolved?.node ?? document.activeElement;
      const doc = resolved?.doc ?? document;
      if (${action.numericOnly === true} && (!resolved ||
        !['slider','spinbutton'].includes(sidebarDescribe(node).role))) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
      if (!node || node.matches('iframe,frame') ||
        (node.tagName === 'INPUT' && node.type === 'password') ||
        ('disabled' in node && node.disabled)) throw new Error('SIDEBAR_KEY_TARGET_UNAVAILABLE');
      if (resolved) {
        node.focus();
        if (doc.activeElement !== node) throw new Error('SIDEBAR_KEY_TARGET_UNAVAILABLE');
      }
      return {url:location.href,title:document.title.slice(0,512)};
    })()`
    const focused = await element.executeJavaScript(code)
    if (typeof focused !== 'object' || focused === null || !('url' in focused) || focused.url !== expectedUrl ||
      !('title' in focused) || typeof focused.title !== 'string' ||
      !this.inputStillSelected(element, expectedUrl, stillSelected)) {
      throw new Error('SIDEBAR_SELECTION_CHANGED')
    }
    await element.sendInputEvent({ type: 'keyDown', ...keyboard })
    if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    await element.sendInputEvent({ type: 'keyUp', ...keyboard })
    return { url: expectedUrl, title: focused.title, performed: true }
  }

  private async nativeType(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'type' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    if (action.text.length > 4000) throw new Error('SIDEBAR_INPUT_UNAVAILABLE')
    const receipt = `__dsh_cu_type_${randomUUID().replaceAll('-', '')}`
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const ref = ${JSON.stringify(action.ref ?? null)};
      const resolved = ref === null ? null : sidebarResolveRef(ref);
      let doc = resolved?.doc ?? document;
      let node = resolved?.node ?? doc.activeElement;
      if (ref === null) {
        let depth = 0;
        while (node?.matches('iframe,frame')) {
          if (++depth > 8 || !sidebarFrames(doc).includes(node)) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
          const child = sidebarFrameDocument(node);
          if (!child) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
          doc = child;
          node = doc.activeElement;
        }
      }
      if (!node || !node.isConnected ||
        ('disabled' in node && node.disabled) || ('readOnly' in node && node.readOnly) ||
        node.tagName === 'INPUT' && !['text','search','email','url','tel','number'].includes(node.type) ||
        !['INPUT','TEXTAREA'].includes(node.tagName) && !node.isContentEditable) {
        throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
      }
      if (resolved) node.focus();
      if (doc.activeElement !== node) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
      Object.defineProperty(window,${JSON.stringify(receipt)},
        {value:{node,doc},configurable:true});
      return {url:location.href,title:document.title.slice(0,512)};
    })()`
    try {
      const focused = await element.executeJavaScript(code)
      if (typeof focused !== 'object' || focused === null || !('url' in focused) || focused.url !== expectedUrl ||
        !('title' in focused) || typeof focused.title !== 'string' ||
        !this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
      await element.executeJavaScript(`(() => {
        if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
        ${guestDomHelpers}
        const state = window[${JSON.stringify(receipt)}];
        const ref = ${JSON.stringify(action.ref ?? null)};
        if (!state || !state.node.isConnected || state.doc.activeElement !== state.node ||
          (ref !== null && sidebarResolveRef(ref).node !== state.node) ||
          ('disabled' in state.node && state.node.disabled) ||
          ('readOnly' in state.node && state.node.readOnly) ||
          state.node.tagName === 'INPUT' &&
            !['text','search','email','url','tel','number'].includes(state.node.type) ||
          !['INPUT','TEXTAREA'].includes(state.node.tagName) && !state.node.isContentEditable) {
          throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
        }
      })()`)
      if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
      await element.insertText(action.text)
      if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
      return { url: expectedUrl, title: focused.title, performed: true }
    } finally {
      await element.executeJavaScript(`(() => { delete window[${JSON.stringify(receipt)}]; })()`).catch(() => {})
    }
  }

  private async nativePaste(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'paste' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    const lease = this.lease
    if (lease === undefined || !['text', 'md', 'html'].includes(action.format) ||
      new TextEncoder().encode(action.text).length > 1_000_000) throw new Error('SIDEBAR_PASTE_UNAVAILABLE')
    const receipt = `__dsh_cu_paste_${randomUUID().replaceAll('-', '')}`
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const ref = ${JSON.stringify(action.ref ?? null)};
      const resolved = ref === null ? null : sidebarResolveRef(ref);
      const node = resolved?.node ?? document.activeElement;
      const doc = resolved?.doc ?? document;
      if (!node || node.matches('iframe,frame') ||
        ('disabled' in node && node.disabled) || ('readOnly' in node && node.readOnly) ||
        node.tagName === 'INPUT' && !['text','search','email','url','tel','number'].includes(node.type) ||
        !['INPUT','TEXTAREA'].includes(node.tagName) && !node.isContentEditable) {
        throw new Error('SIDEBAR_PASTE_TARGET_UNAVAILABLE');
      }
      node.focus();
      if (doc.activeElement !== node) throw new Error('SIDEBAR_PASTE_TARGET_UNAVAILABLE');
      const key = ${JSON.stringify(receipt)};
      const state = {done:false, armed:false, node, doc, listener:null};
      state.listener = event => {
        if (state.armed && event.isTrusted && node.isConnected &&
          (event.target === node || node.contains(event.target))) state.done = true;
      };
      Object.defineProperty(window,key,{value:state,configurable:true});
      doc.addEventListener('input',state.listener,true);
      return {url:location.href,title:document.title.slice(0,512)};
    })()`
    const cleanup = async (): Promise<void> => {
      await element.executeJavaScript(`(() => {
        const key = ${JSON.stringify(receipt)};
        const state = window[key];
        if (state) { state.doc.removeEventListener('input',state.listener,true); delete window[key]; }
      })()`).catch(() => {})
    }
    const focused = await element.executeJavaScript(code)
    if (typeof focused !== 'object' || focused === null || !('url' in focused) || focused.url !== expectedUrl ||
      !('title' in focused) || typeof focused.title !== 'string' ||
      !this.inputStillSelected(element, expectedUrl, stillSelected) || this.lease !== lease) {
      await cleanup()
      throw new Error('SIDEBAR_SELECTION_CHANGED')
    }
    const payload = action.format === 'html' ? (() => {
      const template = document.createElement('template')
      template.innerHTML = action.text
      return { text: action.text, format: action.format, plainText: template.content.textContent }
    })() : { text: action.text, format: action.format }
    let token: string | undefined
    let clipboardRestored = false
    let clipboardSuperseded = false
    try {
      token = await this.bridge.beginPaste(lease, expectedUrl, payload)
      if (!this.inputStillSelected(element, expectedUrl, stillSelected) || this.lease !== lease) {
        throw new Error('SIDEBAR_SELECTION_CHANGED')
      }
      await element.executeJavaScript(`(() => {
        if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
        ${guestDomHelpers}
        const state = window[${JSON.stringify(receipt)}];
        const ref = ${JSON.stringify(action.ref ?? null)};
        if (!state || !state.node.isConnected ||
          (ref !== null && sidebarResolveRef(ref).node !== state.node) ||
          state.doc.activeElement !== state.node ||
          ('disabled' in state.node && state.node.disabled) ||
          ('readOnly' in state.node && state.node.readOnly) ||
          state.node.tagName === 'INPUT' && !['text','search','email','url','tel','number'].includes(state.node.type) ||
          !['INPUT','TEXTAREA'].includes(state.node.tagName) && !state.node.isContentEditable) {
          throw new Error('SIDEBAR_PASTE_TARGET_UNAVAILABLE');
        }
        state.armed = true;
      })()`)
      if (!this.inputStillSelected(element, expectedUrl, stillSelected) || this.lease !== lease) {
        throw new Error('SIDEBAR_SELECTION_CHANGED')
      }
      element.paste()
      let observed = false
      for (let attempt = 0; attempt < 50; attempt++) {
        if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
        observed = await element.executeJavaScript(`(() => {
          if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
          return window[${JSON.stringify(receipt)}]?.done === true;
        })()`) === true
        if (observed) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!observed) throw new Error('SIDEBAR_PASTE_NOT_CONFIRMED')
    } finally {
      await cleanup()
      if (token !== undefined) {
        const restored = await this.bridge.finishPaste(lease, token)
        clipboardRestored = restored.restored
        clipboardSuperseded = restored.superseded
      }
    }
    return { url: expectedUrl, title: focused.title, performed: true, clipboardRestored, clipboardSuperseded }
  }

  private async nativeSetValue(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'setValue' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const {node,doc} = sidebarResolveRef(${JSON.stringify(action.ref)});
      if (!['INPUT','TEXTAREA'].includes(node.tagName) ||
        (node.tagName === 'INPUT' && !['text','search','url','tel'].includes(node.type)) ||
        node.disabled || node.readOnly) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
      node.focus();
      if (doc.activeElement !== node) throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
      node.select();
      if (node.selectionStart !== 0 || node.selectionEnd !== node.value.length) {
        throw new Error('SIDEBAR_INPUT_UNAVAILABLE');
      }
      return {url:location.href,title:document.title.slice(0,512),hadText:node.value.length > 0};
    })()`
    const selected = await element.executeJavaScript(code)
    if (typeof selected !== 'object' || selected === null || !('url' in selected) || selected.url !== expectedUrl ||
      !('title' in selected) || typeof selected.title !== 'string' ||
      !('hadText' in selected) || typeof selected.hadText !== 'boolean' ||
      !this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    if (action.value.length > 0) {
      await element.insertText(action.value)
    } else if (selected.hadText) {
      await element.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' })
      if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
      await element.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' })
    }
    return { url: expectedUrl, title: selected.title, performed: true }
  }

  private async nativeSelectText(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'selectText' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    if (action.text.length < 1 || action.text.length > 4000 ||
      action.prefix !== undefined && action.prefix.length > 4000 ||
      action.suffix !== undefined && action.suffix.length > 4000 ||
      action.selectionType !== undefined && !['text', 'cursor_before', 'cursor_after'].includes(action.selectionType)) {
      throw new Error('SIDEBAR_SELECTION_UNAVAILABLE')
    }
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const action = ${JSON.stringify(action)};
      const {node,doc} = sidebarResolveRef(action.ref);
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
        if (doc.activeElement !== node) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
        node.setSelectionRange(start,end);
        if (node.selectionStart !== start || node.selectionEnd !== end) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
      } else {
        const walker = doc.createTreeWalker(node, doc.defaultView.NodeFilter.SHOW_TEXT);
        const nodes = []; let offset = 0;
        while (walker.nextNode()) {
          const item = walker.currentNode;
          nodes.push({item,start:offset,end:offset + item.textContent.length});
          offset += item.textContent.length;
        }
        const first = nodes.find(item => start >= item.start && start <= item.end);
        const last = nodes.find(item => end >= item.start && end <= item.end);
        if (!first || !last) throw new Error('SIDEBAR_TEXT_NOT_FOUND');
        const range = doc.createRange();
        range.setStart(first.item,start - first.start);
        range.setEnd(last.item,end - last.start);
        const selection = doc.getSelection();
        if (!selection) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE');
        selection.removeAllRanges(); selection.addRange(range);
      }
      return {url:location.href,title:document.title.slice(0,512)};
    })()`
    if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    const selected = await element.executeJavaScript(code)
    if (typeof selected !== 'object' || selected === null || !('url' in selected) || selected.url !== expectedUrl ||
      !('title' in selected) || typeof selected.title !== 'string' ||
      !this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    return { url: expectedUrl, title: selected.title, performed: true }
  }

  private async nativeSecondary(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'secondary' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    if (action.action === 'showmenu') return this.nativeClick(element, expectedUrl,
      { op: 'click', ref: action.ref, button: 'right', exposedRoleOnly: true }, stillSelected)
    if (action.action === 'increment' || action.action === 'decrement') return this.nativeKey(element, expectedUrl,
      { op: 'key', ref: action.ref, key: action.action === 'increment' ? 'ArrowUp' : 'ArrowDown', numericOnly: true }, stillSelected)
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const {node,doc} = sidebarResolveRef(${JSON.stringify(action.ref)});
      if (node.matches('iframe,frame') || ('disabled' in node && node.disabled)) {
        throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
      }
      if (${JSON.stringify(action.action)} === 'focus') {
        if (!['button','textbox','link','combobox','checkbox','radio','slider','spinbutton']
          .includes(sidebarDescribe(node).role)) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
        node.focus();
        if (doc.activeElement !== node) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
        return {url:location.href,title:document.title.slice(0,512)};
      }
      const expanded = node.getAttribute('aria-expanded');
      if (!['true','false'].includes(expanded)) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
      return {url:location.href,title:document.title.slice(0,512),expanded};
    })()`
    if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    const state = await element.executeJavaScript(code)
    if (typeof state !== 'object' || state === null || !('url' in state) || state.url !== expectedUrl ||
      !('title' in state) || typeof state.title !== 'string' ||
      !this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    if (action.action === 'focus') return { url: expectedUrl, title: state.title, performed: true }
    const wanted = action.action === 'expand' ? 'true' : 'false'
    if (!('expanded' in state) || !['true', 'false'].includes(String(state.expanded))) {
      throw new Error('SIDEBAR_ACTION_NOT_EXPOSED')
    }
    if (state.expanded === wanted) return { url: expectedUrl, title: state.title, performed: true }
    return this.nativeClick(element, expectedUrl,
      { op: 'click', ref: action.ref, expectedExpanded: wanted === 'true' ? 'false' : 'true' }, stillSelected)
  }

  private async nativeScroll(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'scroll' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const {node,frames} = sidebarResolveRef(${JSON.stringify(action.ref)});
      const {x,y} = sidebarPoint(node,frames);
      return {x,y,url:location.href,title:document.title.slice(0,512)};
    })()`
    const point = await element.executeJavaScript(code)
    if (typeof point !== 'object' || point === null || !('x' in point) || !('y' in point) ||
      typeof point.x !== 'number' || typeof point.y !== 'number' || !('url' in point) ||
      point.url !== expectedUrl || !('title' in point) || typeof point.title !== 'string' ||
      this.element !== element || this.lifetime.signal.aborted || this.store.getSnapshot().loading ||
      element.getURL() !== expectedUrl || !stillSelected()) throw new Error('SIDEBAR_SELECTION_CHANGED')
    await element.sendInputEvent({ type: 'mouseWheel', x: point.x, y: point.y,
      deltaX: action.dx === 0 ? 0 : -action.dx, deltaY: action.dy === 0 ? 0 : -action.dy,
      hasPreciseScrollingDeltas: true, canScroll: true })
    return { url: expectedUrl, title: point.title, performed: true }
  }

  private async nativeDrag(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'drag' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    const points = [action.x, action.y, action.to.x, action.to.y]
    if (!points.every(value => Number.isFinite(value) && value >= 0 && value <= 8192) ||
      action.x === action.to.x && action.y === action.to.y) throw new Error('SIDEBAR_DRAG_UNAVAILABLE')
    const path = Array.from({ length: 12 }, (_, index) => ({
      x: action.x + (action.to.x - action.x) * (index + 1) / 12,
      y: action.y + (action.to.y - action.y) * (index + 1) / 12,
    }))
    const pointCode = (x: number, y: number): string => `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const x = ${x}, y = ${y};
      if (x >= innerWidth || y >= innerHeight) throw new Error('SIDEBAR_POINT_OUT_OF_BOUNDS');
      const {hit,frames} = sidebarHit(x,y);
      const tokens = frames.map(frame => sidebarFrameToken(sidebarFrameDocument(frame)));
      return {url:location.href,title:document.title.slice(0,512),
        fingerprint:[tokens.join('/'),hit.tagName,hit.id,hit.getAttribute('role'),
          hit.getAttribute('aria-label'),hit.getAttribute('type'),hit.getAttribute('href')].join('|')};
    })()`
    const inspect = async (x: number, y: number): Promise<{ readonly title: string; readonly fingerprint: string }> => {
      const value = await element.executeJavaScript(pointCode(x, y))
      if (typeof value !== 'object' || value === null || !('url' in value) || value.url !== expectedUrl ||
        !('title' in value) || typeof value.title !== 'string' ||
        !('fingerprint' in value) || typeof value.fingerprint !== 'string' ||
        !this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
      return { title: value.title, fingerprint: value.fingerprint }
    }
    const source = await inspect(action.x, action.y)
    await element.executeJavaScript(`(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      for (const point of ${JSON.stringify(path)}) {
        if (point.x >= innerWidth || point.y >= innerHeight) throw new Error('SIDEBAR_POINT_OUT_OF_BOUNDS');
        sidebarHit(point.x,point.y);
      }
    })()`)
    if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    await element.sendInputEvent({ type: 'mouseMove', x: action.x, y: action.y })
    const hovered = await inspect(action.x, action.y)
    if (hovered.fingerprint !== source.fingerprint) throw new Error('SIDEBAR_TARGET_MOVED')
    const lease = this.lease
    if (lease === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    const token = await this.bridge.beginDrag(lease, expectedUrl)
    let pressed = false
    let completed = false
    let dropDispatched = false
    let last = { x: action.x, y: action.y }
    try {
      if (!this.inputStillSelected(element, expectedUrl, stillSelected) || this.lease !== lease) {
        throw new Error('SIDEBAR_SELECTION_CHANGED')
      }
      pressed = true
      await element.sendInputEvent({ type: 'mouseDown', ...last, button: 'left', clickCount: 1 })
      for (const point of path) {
        await inspect(point.x, point.y)
        await element.sendInputEvent({ type: 'mouseMove', ...point, button: 'left' })
        last = point
        await new Promise(resolve => setTimeout(resolve, 12))
      }
      if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
      await element.sendInputEvent({ type: 'mouseUp', ...last, button: 'left', clickCount: 1 })
      pressed = false
      completed = true
    } finally {
      if (pressed) await element.sendInputEvent({ type: 'mouseUp', ...last, button: 'left', clickCount: 1 }).catch(() => {})
      if (completed && this.inputStillSelected(element, expectedUrl, stillSelected) && this.lease === lease) {
        dropDispatched = (await this.bridge.finishDrag(lease, token, last)).dropped
      } else {
        await this.bridge.finishDrag(lease, token).catch(() => {})
      }
    }
    return { url: expectedUrl, title: source.title, performed: true, dropDispatched }
  }

  private async nativeClick(element: WebviewElement, expectedUrl: string,
    action: Extract<BrowserDomAction, { readonly op: 'click' }>, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const action = ${JSON.stringify(action)};
      let x = action.x, y = action.y;
      let target = null;
      if (action.ref !== undefined) {
        const {node,frames} = sidebarResolveRef(action.ref);
        target = node;
        if (action.exposedRoleOnly &&
          !['button','textbox','link','combobox','checkbox','radio','slider','spinbutton']
            .includes(sidebarDescribe(node).role)) throw new Error('SIDEBAR_ACTION_NOT_EXPOSED');
        if (action.expectedExpanded !== undefined &&
          node.getAttribute('aria-expanded') !== action.expectedExpanded) throw new Error('SIDEBAR_TARGET_MOVED');
        ({x,y} = sidebarPoint(node,frames));
      }
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
        x >= innerWidth || y >= innerHeight) throw new Error('SIDEBAR_POINT_OUT_OF_BOUNDS');
      const {hit,frames} = sidebarHit(x,y);
      const frameTokens = frames.map(frame => {
        const child = sidebarFrameDocument(frame);
        if (!child) throw new Error('SIDEBAR_FRAME_UNAVAILABLE');
        return sidebarFrameToken(child);
      });
      const fingerprint = [frameTokens.join('/'),target?.getAttribute('aria-expanded'),hit.tagName, hit.id,
        hit.getAttribute('role'), hit.getAttribute('aria-label'),
        hit.getAttribute('type'), hit.getAttribute('href')].join('|');
      return {x, y, url:location.href, title:document.title.slice(0,512), fingerprint};
    })()`
    const point = await element.executeJavaScript(code)
    if (typeof point !== 'object' || point === null || !('x' in point) || !('y' in point) ||
      typeof point.x !== 'number' || typeof point.y !== 'number' || !('url' in point) ||
      point.url !== expectedUrl || !('title' in point) || typeof point.title !== 'string' ||
      !('fingerprint' in point) || typeof point.fingerprint !== 'string') {
      throw new Error('SIDEBAR_POINT_UNAVAILABLE')
    }
    if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    const button = action.button ?? 'left'
    const clickCount = action.count ?? 1
    if (!['left','middle','right'].includes(button) || !Number.isSafeInteger(clickCount) ||
      clickCount < 1 || clickCount > 3) throw new Error('SIDEBAR_CLICK_UNAVAILABLE')
    await element.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    if (!this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_SELECTION_CHANGED')
    const moved = await element.executeJavaScript(code)
    if (typeof moved !== 'object' || moved === null || !('x' in moved) || !('y' in moved) ||
      !('fingerprint' in moved) || moved.x !== point.x || moved.y !== point.y ||
      moved.fingerprint !== point.fingerprint ||
      !this.inputStillSelected(element, expectedUrl, stillSelected)) throw new Error('SIDEBAR_TARGET_MOVED')
    await element.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button, clickCount })
    await element.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button, clickCount })
    return { url: expectedUrl, title: point.title, performed: true }
  }

  /** @returns after pending initialization and the owned guest have been released. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort()
    this.pending = undefined
    this.disposal = Promise.all([this.dropGuest(), this.initializing])
      .then(() => Promise.all(this.releases)).then(() => {})
    this.presentation.dispose()
    return this.disposal
  }

  private navigate(command: 'goBack' | 'goForward' | 'reload'): void {
    if (this.lifetime.signal.aborted || !this.ready || this.element === undefined) return
    this.revision++
    this.pending = undefined
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
    try { this.element[command]() }
    catch (error) { this.commandFailed(error) }
  }

  private initialize(): void {
    const attachment = this.attachment
    if (attachment === undefined || this.initializing !== undefined || this.element !== undefined || this.lifetime.signal.aborted) return
    const signal = AbortSignal.any([this.lifetime.signal, attachment.signal])
    this.initializing = this.createGuest(signal).catch(async (error: unknown) => {
      await this.dropGuest()
      if (!signal.aborted) this.commandFailed(error)
    }).finally(() => {
      this.initializing = undefined
      if (this.attachment !== attachment && this.pending !== undefined) this.initialize()
    })
  }

  private async createGuest(attachmentSignal: AbortSignal): Promise<void> {
    this.workspaceKey ??= await this.workspace(attachmentSignal)
    if (attachmentSignal.aborted) return
    const reservation = await this.bridge.acquire(this.workspaceKey)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- The signal can abort while acquire is pending.
    if (attachmentSignal.aborted) { await this.release(reservation.lease); return }
    this.lease = reservation.lease
    this.guestLifetime = new AbortController()
    const signal = AbortSignal.any([attachmentSignal, this.guestLifetime.signal])
    const element = this.presentation.createElement(reservation)
    this.element = element
    const unsubscribeOpen = this.bridge.onOpenRequested(reservation.lease, (url) => {
      if (this.element === element && !signal.aborted) this.options.openRequested(url)
    })
    signal.addEventListener('abort', unsubscribeOpen, { once: true })
    element.addEventListener('dom-ready', () => {
      this.ready = true
      this.observe(this.store.getSnapshot().address !== 'requested')
      this.loadPending()
    }, { signal })
    element.addEventListener('did-navigate', () => { this.observe(true) }, { signal })
    element.addEventListener('did-navigate-in-page', (event) => {
      if ((event as NavigationEvent).isMainFrame) this.observe(true)
    }, { signal })
    element.addEventListener('did-start-navigation', (event) => {
      if ((event as NavigationEvent).isMainFrame) {
        this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
      }
    }, { signal })
    for (const name of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) {
      element.addEventListener(name, () => {
        this.observe(name === 'page-title-updated' && this.store.getSnapshot().address === 'observed')
      }, { signal })
    }
    element.addEventListener('did-fail-load', (event) => {
      const failure = event as LoadFailureEvent
      if (failure.isMainFrame && failure.errorCode !== -3) {
        this.failed({ code: failure.errorCode, description: failure.errorDescription })
      }
    }, { signal })
    for (const name of ['render-process-gone', 'destroyed']) {
      element.addEventListener(name, () => { void this.dropGuest(); this.failed() }, { signal })
    }
    this.presentation.present(element)
  }

  private loadPending(): void {
    const target = this.pending
    const element = this.element
    if (!this.ready || target === undefined || element === undefined) return
    const revision = this.revision
    this.pending = undefined
    void element.loadURL(target.url).catch((error: unknown) => {
      if (this.element !== element || this.lifetime.signal.aborted || this.revision !== revision) return
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED') return
      if (this.store.getSnapshot().error === undefined) this.commandFailed(error)
    })
  }

  private observe(committed: boolean): void {
    if (!this.ready || this.element === undefined || this.lifetime.signal.aborted) return
    try { this.observeReady(this.element, committed) }
    catch (error) { this.commandFailed(error) }
  }

  private observeReady(element: WebviewElement, committed: boolean): void {
    const current = this.store.getSnapshot()
    const parsed = committed ? parseBrowserAddress(element.getURL()) : undefined
    if (parsed?.ok && this.firstDocument) {
      // The lease-bearing bootstrap document is not a user history entry.
      element.clearHistory()
      this.firstDocument = false
    }
    let target = current.target
    let address = current.address
    if (parsed?.ok) {
      target = { ...parsed.target, title: element.getTitle() || parsed.target.title }
      address = 'observed'
      this.presentation.show(target.title)
    }
    const loading = current.error === undefined && element.isLoading()
    const canGoBack = element.canGoBack()
    const canGoForward = element.canGoForward()
    if (target?.url !== current.target?.url || target?.title !== current.target?.title || address !== current.address
      || loading !== current.loading || canGoBack !== current.canGoBack || canGoForward !== current.canGoForward) {
      this.store.set({ ...current, target, address, loading, canGoBack, canGoForward })
    }
    if (parsed?.ok && target !== undefined) this.persist(target)
  }

  private persist(target: BrowserTarget): void {
    if (target.url === this.checkpoint?.url && target.title === this.checkpoint.title) return
    this.checkpoint = target
    this.options.persist(browserAddressCheckpoint(target, this.revision))
  }

  private failed(error: BrowserLoadError = { code: undefined, description: undefined }): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, loading: false, error,
      canGoBack: this.ready && current.canGoBack, canGoForward: this.ready && current.canGoForward })
  }

  private commandFailed(error: unknown): void {
    console.error('Desktop browser operation failed', error)
    this.failed()
  }

  private dropGuest(): Promise<void> {
    void this.cancelDialog()
    this.guestLifetime?.abort()
    this.guestLifetime = undefined
    this.presentation.clear()
    this.element = undefined
    this.ready = false
    this.firstDocument = true
    const lease = this.lease
    this.lease = undefined
    return lease === undefined ? Promise.resolve() : this.release(lease)
  }

  private release(lease: DesktopBrowserLeaseId): Promise<void> {
    const released = this.bridge.release(lease)
      .catch((error: unknown) => { console.error('Desktop browser guest release failed', error) })
      .finally(() => { this.releases.delete(released) })
    this.releases.add(released)
    return released
  }
}
