/** Fixed document queries shared by the selected Webview and its native frame bridge. */
import type { BrowserLocateQuery } from './types.ts'

function validSidebarLocateSelector(value: unknown, extraKeys: readonly string[] = [], depth = 0): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const selector = value as Record<string, unknown>
  const filter = selector.filter
  return typeof selector.method === 'string' &&
    ['getByRole', 'locator', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId'].includes(selector.method) &&
    Object.keys(selector).every(key => ['method', 'value', 'name', 'exact', 'filter', ...extraKeys].includes(key)) &&
    typeof selector.value === 'string' && selector.value.trim().length > 0 &&
    selector.value.length <= (selector.method === 'locator' ? 256 : 120) &&
    (selector.method !== 'getByRole' || /^[a-z][a-z0-9-]{0,31}$/u.test(selector.value)) &&
    (selector.name === undefined || selector.method === 'getByRole' && typeof selector.name === 'string' &&
      selector.name.length <= 60) && typeof selector.exact === 'boolean' &&
    (filter === undefined || filter !== null && typeof filter === 'object' &&
      !Array.isArray(filter) && Object.keys(filter).length > 0 &&
      Object.entries(filter).every(([key, nested]) =>
        key === 'visible' ? typeof nested === 'boolean' : ['hasText', 'hasNotText'].includes(key)
          ? typeof nested === 'string' && nested.length > 0 && nested.length <= 120
          : ['has', 'hasNot'].includes(key) && depth < 2 && validSidebarRelativeQuery(nested, depth + 1)))
}

function validSidebarRelativeQuery(value: unknown, depth: number): boolean {
  if (!validSidebarLocateSelector(value, ['scopes'], depth)) return false
  const scopes = (value as { readonly scopes?: unknown }).scopes
  return scopes === undefined || Array.isArray(scopes) && scopes.length >= 1 &&
    scopes.length <= 2 && scopes.every(scope => validSidebarLocateSelector(scope, [], depth))
}

/**
 * Validate the fixed, bounded Sidebar locator language before script generation.
 * @param query - Untrusted locator request from the selected-tab bridge.
 * @param allowCombine - Whether one outer and/or composition is permitted.
 * @returns Whether the request fits the bounded locator language.
 */
export function validSidebarLocateQuery(query: BrowserLocateQuery, allowCombine = true): boolean {
  return validSidebarLocateSelector(query, ['frames', 'scopes', 'position', 'projection', 'combine']) &&
    (query.projection === undefined || ['visible', 'enabled', 'checked', 'text', 'textContent', 'allTextContents'].includes(query.projection)) &&
    (query.scopes === undefined || Array.isArray(query.scopes) && query.scopes.length >= 1 &&
      query.scopes.length <= 2 && query.scopes.every(scope => validSidebarLocateSelector(scope))) &&
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Query arrives as Host RPC JSON, which may contain null.
    (query.position === undefined || query.position !== null &&
      ['first', 'last', 'nth'].includes(query.position.method) &&
      (query.position.method === 'nth'
        ? Number.isSafeInteger(query.position.index) && query.position.index !== undefined &&
          query.position.index >= 0 && query.position.index <= 99999
        : query.position.index === undefined)) &&
    (query.frames === undefined || Array.isArray(query.frames) && query.frames.length >= 1 &&
      query.frames.length <= 8 && query.frames.every(frame => typeof frame === 'string' &&
        frame.trim().length > 0 && frame.length <= 256)) &&
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Host RPC JSON can violate this TypeScript interface.
    (query.combine === undefined || allowCombine && query.combine !== null &&
      typeof query.combine === 'object' && !Array.isArray(query.combine) &&
      Object.keys(query.combine).length === 2 &&
      Object.keys(query.combine).every(key => ['method', 'query'].includes(key)) &&
      ['and', 'or'].includes(query.combine.method) &&
      validSidebarLocateQuery(query.combine.query, false) &&
      JSON.stringify(query.frames ?? []) === JSON.stringify(query.combine.query.frames ?? []))
}


/** Fixed document helpers shared by selected-tab queries and native child-frame reads. */
export const guestDomHelpers = String.raw`
  const sidebarSelector = 'a,button,input,textarea,select,img[alt],area[alt],[role],[contenteditable],h1,h2,h3';
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
  const sidebarLabelName = (node) => {
    const ids = (node.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).slice(0,8);
    if (ids.length) {
      const linked = ids.map(id => {
        const label = node.ownerDocument.getElementById(id);
        return label ? (label.innerText || label.textContent || '').slice(0,160) : '';
      }).join(' ').trim();
      if (linked) return linked;
    }
    const aria = node.getAttribute('aria-label') || '';
    if (aria.trim()) return aria;
    const labels = node.labels ? [...node.labels].slice(0,8)
      .map(label => (label.innerText || label.textContent || '').slice(0,160)).join(' ').trim() : '';
    return labels;
  };
  const sidebarAccessibleName = (node) => {
    const label = sidebarLabelName(node);
    if (label) return label;
    if (node.tagName === 'INPUT' && ['button','submit','reset'].includes(node.type) && node.value) return node.value;
    if (['IMG','AREA'].includes(node.tagName) || node.tagName === 'INPUT' && node.type === 'image') {
      const alt = node.getAttribute('alt') || '';
      if (alt) return alt;
    }
    if (node.innerText) return node.innerText;
    if (['BUTTON','A'].includes(node.tagName)) {
      const image = node.querySelector('img[alt],input[type=image][alt]');
      if (image?.getAttribute('alt')) return image.getAttribute('alt');
    }
    return node.getAttribute('title') || node.getAttribute('placeholder') || '';
  };
  const sidebarDescribe = (node) => {
    const rawRole = node.getAttribute('role') || '';
    const role = /^[a-z][a-z0-9-]{0,31}$/.test(rawRole) ? rawRole :
      node.tagName === 'INPUT' ? ({number:'spinbutton',range:'slider',checkbox:'checkbox',radio:'radio',image:'button',button:'button',submit:'button',reset:'button',search:'searchbox'})[node.type] || 'textbox' :
      ({A:'link',AREA:'link',IMG:'img',BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox',H1:'heading',H2:'heading',H3:'heading'})[node.tagName] ||
        (node.getAttribute('contenteditable') !== null ? 'textbox' : node.tagName.toLowerCase());
    const name = sidebarAccessibleName(node)
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

/**
 * Build the fixed locator script for one exact document URL.
 * @param expectedUrl - Observed URL of the selected document or approved child frame.
 * @param query - Validated locator request for that document.
 * @returns Script that emits only a bounded count and optional single element result.
 */
export function sidebarLocateCode(expectedUrl: string, query: BrowserLocateQuery): string {
  return `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${guestDomHelpers}
      const query = ${JSON.stringify(query)};
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
        else if (selector.method === 'getByAltText') {
          if (node.tagName !== 'IMG' && node.tagName !== 'AREA' &&
            !(node.tagName === 'INPUT' && node.type === 'image')) return false;
          text = node.getAttribute('alt') || '';
        }
        else if (selector.method === 'getByTitle') text = node.getAttribute('title') || '';
        else if (selector.method === 'getByLabel') text = sidebarLabelName(node);
        return textMatches(text,selector.value,selector.exact);
      };
      const matches = (node,selector,step,nestedResults) => {
        if (!matchesBase(node,selector)) return false;
        const filter = selector.filter;
        if (!filter) return true;
        const text = node.innerText || '';
        return (filter.hasText === undefined || textMatches(text,filter.hasText,false)) &&
          (filter.hasNotText === undefined || !textMatches(text,filter.hasNotText,false)) &&
          (filter.visible === undefined || isVisible(node) === filter.visible) &&
          (nestedResults[step].has === null || nestedResults[step].has.has(node)) &&
          (nestedResults[step].hasNot === null || !nestedResults[step].hasNot.has(node));
      };
      let doc = document, prefix = '';
      const frameNodes = [];
      const isVisible = node => [...frameNodes,node].every(element => {
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        return style.visibility !== 'hidden' && style.visibility !== 'collapse' &&
          [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
      });
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
      const nodes = sidebarAllNodes(doc);
      const ancestorsOf = selected => {
        const containing = new WeakSet();
        for (let index = nodes.length - 1; index >= 0; index--) {
          const node = nodes[index];
          if ((selected.has(node) || containing.has(node)) && node.parentElement) {
            containing.add(node.parentElement);
          }
        }
        return containing;
      };
      const nestedDescendants = nested => {
        if (nested === undefined) return null;
        const selectors = [...(nested.scopes || []),nested];
        const nestedResults = selectors.map(selector => ({
          has:nestedDescendants(selector.filter?.has),
          hasNot:nestedDescendants(selector.filter?.hasNot),
        }));
        let selected = null;
        for (let step = selectors.length - 1; step >= 0; step--) {
          const descendants = selected === null ? null : ancestorsOf(selected);
          const matchesStep = new Set();
          for (const node of nodes) {
            if ((descendants === null || descendants.has(node)) &&
              matches(node,selectors[step],step,nestedResults)) matchesStep.add(node);
          }
          selected = matchesStep;
        }
        return ancestorsOf(selected);
      };
      const matchChain = selectors => {
        const nestedResults = selectors.map(selector => ({
          has:nestedDescendants(selector.filter?.has),
          hasNot:nestedDescendants(selector.filter?.hasNot),
        }));
        const states = new WeakMap(), matched = new Set();
        for (const node of nodes) {
          const inherited = states.get(node.parentElement) || 0;
          let state = inherited;
          for (let step = 0; step < selectors.length; step++) {
            if (step > 0 && !(inherited & (1 << (step - 1)))) continue;
            if (!matches(node,selectors[step],step,nestedResults)) continue;
            state |= 1 << step;
            if (step === selectors.length - 1) matched.add(node);
          }
          states.set(node,state);
        }
        return matched;
      };
      const positionChain = (matched,position) => {
        if (position === undefined) return matched;
        const ordered = [...matched];
        const chosen = position.method === 'first' ? ordered[0]
          : position.method === 'last' ? ordered.at(-1) : ordered[position.index];
        return chosen === undefined ? new Set() : new Set([chosen]);
      };
      const primary = matchChain([...(query.scopes || []),query]);
      const secondary = query.combine === undefined ? null : positionChain(
        matchChain([...(query.combine.query.scopes || []),query.combine.query]),
        query.combine.query.position);
      let count = 0, first = null, last = null, nth = null;
      const allTexts = [];
      let totalText = 0;
      for (const [index,node] of nodes.entries()) {
        const included = secondary === null ? primary.has(node)
          : query.combine.method === 'and' ? primary.has(node) && secondary.has(node)
            : primary.has(node) || secondary.has(node);
        if (!included) continue;
        if (query.projection === 'allTextContents' && query.position === undefined) {
          if (allTexts.length >= 256) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
          const text = String(node.textContent ?? '');
          totalText += text.length;
          if (totalText > 24000) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
          allTexts.push(text);
        }
        const candidate = {doc,prefix,index,node};
        if (count === 0) first = candidate;
        if (query.position?.method === 'nth' && count === query.position.index) nth = candidate;
        last = candidate;
        count++;
      }
      const chosen = query.position?.method === 'first' ? first
        : query.position?.method === 'last' ? last
          : query.position?.method === 'nth' ? nth : count === 1 ? first : null;
      if (query.projection === 'allTextContents' && query.position !== undefined && chosen !== null) {
        const text = String(chosen.node.textContent ?? '');
        if (text.length > 24000) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
        allTexts.push(text);
      }
      const rows = query.projection === 'allTextContents' || chosen === null ? [] : (() => {
        const {doc,prefix,index,node} = chosen;
        const {role,name} = sidebarDescribe(node);
        return [{ref:prefix + 'd' + index + '-' + sidebarDomFingerprint(doc,node,index)
          + ':' + role + ':' + encodeURIComponent(name),role,name,
          ...(query.projection === 'visible' ? {visible:isVisible(node)} : {}),
          ...(query.projection === 'enabled' ? {enabled:!node.matches(':disabled') &&
            !node.closest('[aria-disabled="true"],[inert]')} : {}),
          ...(query.projection === 'checked' ? {checked:(() => {
            if (!['checkbox','radio'].includes(role)) throw new Error('SIDEBAR_CHECK_UNAVAILABLE');
            if (node.tagName === 'INPUT' && node.type === role) return node.checked;
            const aria = node.getAttribute('aria-checked');
            if (node.getAttribute('role') === role &&
              (aria === 'true' || aria === 'false' || role === 'checkbox' && aria === 'mixed')) {
              return aria === 'true';
            }
            throw new Error('SIDEBAR_CHECK_UNAVAILABLE');
          })()} : {}),
          ...(query.projection === 'text' ? {text:(() => {
            if (!isVisible(node)) throw new Error('SIDEBAR_TEXT_NOT_VISIBLE');
            const text = String(node.innerText ?? '');
            if (text.length > 24000) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
            return text;
          })()} : {}),
          ...(query.projection === 'textContent' ? {textContent:(() => {
            const text = String(node.textContent ?? '');
            if (text.length > 24000) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
            return text;
          })()} : {})}];
      })();
      return {url:location.href,title:document.title.slice(0,512),count,rows,
        ...(query.projection === 'allTextContents' ? {texts:allTexts} : {})};
    })()`
}
