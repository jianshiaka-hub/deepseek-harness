/** Fixed document queries shared by the selected Webview and its native frame bridge. */
import type { BrowserLocateQuery } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

function validSidebarTextPattern(value: unknown, maxStringLength: number): boolean {
  if (typeof value === 'string') return value.length <= maxStringLength
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const pattern = value as Record<string, unknown>
  if (Object.keys(pattern).length !== 3 || !['__cu', 'source', 'flags'].every(key => Object.hasOwn(pattern, key)) ||
    pattern.__cu !== 'regexp' || typeof pattern.source !== 'string' || pattern.source.length > 120 ||
    typeof pattern.flags !== 'string' || !/^[dgimsuvy]*$/u.test(pattern.flags) ||
    new Set(pattern.flags).size !== pattern.flags.length ||
    pattern.flags.includes('u') && pattern.flags.includes('v')) return false
  try { new RegExp(pattern.source, pattern.flags); return true }
  catch { return false }
}

function validSidebarLocateSelector(value: unknown, extraKeys: readonly string[] = [], depth = 0): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const selector = value as Record<string, unknown>
  const filter = selector.filter
  return typeof selector.method === 'string' &&
    ['getByRole', 'locator', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId'].includes(selector.method) &&
    Object.keys(selector).every(key => ['method', 'value', 'name', 'description', 'exact', 'includeHidden',
      'checked', 'disabled', 'expanded', 'level', 'pressed', 'selected', 'filter', ...extraKeys].includes(key)) &&
    (selector.method === 'locator' || selector.method === 'getByRole'
      ? typeof selector.value === 'string' && selector.value.trim().length > 0 &&
        selector.value.length <= (selector.method === 'locator' ? 256 : 120)
      : validSidebarTextPattern(selector.value, 120) &&
        (typeof selector.value !== 'string' || selector.value.trim().length > 0)) &&
    (selector.method !== 'getByRole' || typeof selector.value === 'string' &&
      /^[a-z][a-z0-9-]{0,31}$/u.test(selector.value)) &&
    (selector.name === undefined || selector.method === 'getByRole' &&
      validSidebarTextPattern(selector.name, 60)) && typeof selector.exact === 'boolean' &&
    (selector.description === undefined || selector.method === 'getByRole' &&
      validSidebarTextPattern(selector.description, 120)) &&
    (selector.includeHidden === undefined || selector.method === 'getByRole' &&
      typeof selector.includeHidden === 'boolean') &&
    (['checked', 'disabled', 'expanded', 'pressed', 'selected'].every(key =>
      selector[key] === undefined || selector.method === 'getByRole' && typeof selector[key] === 'boolean')) &&
    (selector.level === undefined || selector.method === 'getByRole' &&
      Number.isSafeInteger(selector.level) && Number(selector.level) >= 1 && Number(selector.level) <= 99) &&
    (filter === undefined || filter !== null && typeof filter === 'object' &&
      !Array.isArray(filter) && Object.keys(filter).length > 0 &&
      Object.entries(filter).every(([key, nested]) =>
        key === 'visible' ? typeof nested === 'boolean' : ['hasText', 'hasNotText'].includes(key)
          ? validSidebarTextPattern(nested, 120) &&
            (typeof nested !== 'string' || nested.length > 0)
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
  return validSidebarLocateSelector(query, ['frames', 'scopes', 'position', 'projection', 'attributeName', 'combine']) &&
    (query.projection === undefined || ['visible', 'enabled', 'checked', 'text', 'textContent', 'allTextContents', 'attribute', 'downloadUrl'].includes(query.projection)) &&
    (query.projection === 'attribute'
      ? typeof query.attributeName === 'string' && /^[^\u0000-\u0020\u007f"'<>/=]{1,256}$/u.test(query.attributeName)
      : query.attributeName === undefined) &&
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
  const sidebarSelector = 'a,button,input,textarea,select,option,img[alt],area[alt],svg,[role],[contenteditable],h1,h2,h3,h4,h5,h6';
  const sidebarAllNodes = (doc) => {
    if (!doc.children) return doc.querySelectorAll('*');
    const nodes = [];
    const stack = [...doc.children].reverse();
    while (stack.length) {
      const node = stack.pop();
      nodes.push(node);
      if (nodes.length > 100000) throw new Error('SIDEBAR_DOM_LIMIT');
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
      if (node.shadowRoot) {
        for (let i = node.shadowRoot.children.length - 1; i >= 0; i--) {
          stack.push(node.shadowRoot.children[i]);
        }
      }
    }
    return nodes;
  };
  const sidebarQueryAll = (doc, selector) => doc.children
    ? sidebarAllNodes(doc).filter(node => node.matches(selector))
    : [...doc.querySelectorAll(selector)];
  const sidebarFrames = (doc = document) => sidebarQueryAll(doc,'iframe,frame').slice(0, 100);
  const sidebarParent = node => node.parentElement || node.getRootNode?.().host || null;
  const sidebarContains = (parent,child) => {
    for (let node = child; node; node = sidebarParent(node)) if (node === parent) return true;
    return false;
  };
  const sidebarActiveElement = doc => {
    let node = doc.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    return node;
  };
  const sidebarComposedChildren = node => {
    if (node.tagName === 'SLOT') {
      const assigned = node.assignedNodes({flatten:true});
      if (assigned.length) return assigned;
    }
    return node.shadowRoot
      ? [...node.childNodes,...node.shadowRoot.childNodes] : node.childNodes || [];
  };
  let sidebarCssHasBudget = 100000;
  const sidebarNthMatchCache = new WeakMap();
  const sidebarCssText = root => {
    const stack = [root];
    let value = '';
    while (stack.length) {
      const node = stack.pop();
      if (--sidebarCssHasBudget < 0) throw new Error('SIDEBAR_DOM_LIMIT');
      if (node.nodeType === 3) {
        value += node.nodeValue || '';
        if (value.length > 200000) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
        continue;
      }
      if (node.nodeType !== 1 || ['SCRIPT','STYLE','NOSCRIPT'].includes(node.tagName) ||
        node.ownerDocument.head?.contains(node)) continue;
      if (node.tagName === 'INPUT' && ['button','submit'].includes(node.type)) {
        value += node.value || '';
        if (value.length > 200000) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
      }
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
      if (node.shadowRoot) {
        for (let i = node.shadowRoot.childNodes.length - 1; i >= 0; i--) {
          stack.push(node.shadowRoot.childNodes[i]);
        }
      }
    }
    return value;
  };
      const sidebarCssPseudo = part => {
        let quote = '', square = 0, round = 0, escape = false;
        for (let i = 0; i < part.length; i++) {
          const char = part[i];
          if (escape) { escape = false; continue; }
          if (char === '\\') { escape = true; continue; }
          if (quote) { if (char === quote) quote = ''; continue; }
          if (char === '"' || char === "'") { quote = char; continue; }
          if (char === '[') { square++; continue; }
          if (char === ']') { square--; continue; }
          if (char === ':' && square === 0 && round === 0) {
            if (part.startsWith(':visible',i) && !/[a-z0-9_-]/i.test(part[i + 8] || '')) {
              return {name:'visible',argument:'',rest:part.slice(0,i) + part.slice(i + 8)};
            }
            const name = part.startsWith(':has-text(',i) ? 'has-text' :
              part.startsWith(':nth-match(',i) ? 'nth-match' :
              part.startsWith(':text-matches(',i) ? 'text-matches' :
              part.startsWith(':text-is(',i) ? 'text-is' :
              part.startsWith(':text(',i) ? 'text' :
              part.startsWith(':has(',i) ? 'has' : null;
            if (name) {
              const open = i + name.length + 1;
              let depth = 1, argumentQuote = '', argumentEscape = false;
              for (let j = open + 1; j < part.length; j++) {
                const next = part[j];
                if (argumentEscape) { argumentEscape = false; continue; }
                if (next === '\\') { argumentEscape = true; continue; }
                if (argumentQuote) { if (next === argumentQuote) argumentQuote = ''; continue; }
                if (next === '"' || next === "'") { argumentQuote = next; continue; }
                if (next === '(') depth++;
                if (next === ')' && --depth === 0) {
                  return {name,argument:part.slice(open + 1,j),
                    rest:part.slice(0,i) + part.slice(j + 1)};
                }
              }
              return null;
            }
          }
          if (char === '(') round++;
          if (char === ')') round--;
        }
        return null;
      };
      const sidebarCssString = argument => {
        const value = argument.trim();
        const quote = value[0];
        if (!['"',"'"].includes(quote) || value.length < 2 ||
          value.at(-1) !== quote) return null;
        let result = '';
        for (let i = 1; i < value.length - 1; i++) {
          const char = value[i];
          if (char === quote) return null;
          if (char !== '\\') { result += char; continue; }
          if (++i >= value.length - 1) return null;
          const next = value[i];
          if (/[0-9a-f]/i.test(next)) {
            let hex = next;
            while (hex.length < 6 && i + 1 < value.length - 1 &&
              /[0-9a-f]/i.test(value[i + 1])) hex += value[++i];
            if (i + 1 < value.length - 1 && /\s/.test(value[i + 1])) i++;
            const point = parseInt(hex,16);
            result += point === 0 || point > 0x10ffff ? '\ufffd' :
              String.fromCodePoint(point);
          } else if (next !== '\n' && next !== '\r') result += next;
        }
        return result;
      };
      const sidebarCssNormalize = value => value.trim().replace(/\s+/g,' ');
      const sidebarCssRegex = argument => {
        let quote = '', escaped = false, comma = -1;
        for (let i = 0; i < argument.length; i++) {
          const char = argument[i];
          if (escaped) { escaped = false; continue; }
          if (char === '\\') { escaped = true; continue; }
          if (quote) { if (char === quote) quote = ''; continue; }
          if (char === '"' || char === "'") { quote = char; continue; }
          if (char === ',') { if (comma >= 0) return null; comma = i; }
        }
        if (quote || escaped || comma < 0) return null;
        const raw = argument.slice(0,comma).trim();
        const sourceQuote = raw[0];
        if (!['"',"'"].includes(sourceQuote) || raw.at(-1) !== sourceQuote) return null;
        let source = '';
        for (let i = 1; i < raw.length - 1; i++) {
          const char = raw[i];
          if (char === sourceQuote) return null;
          if (char !== '\\') { source += char; continue; }
          if (++i >= raw.length - 1) return null;
          const next = raw[i];
          source += next === sourceQuote || next === '\\' ? next : '\\' + next;
        }
        const flags = sidebarCssString(argument.slice(comma + 1));
        if (!source || source.length > 120 || flags === null || !/^[gimsuy]*$/.test(flags)) return null;
        try { return new RegExp(source,flags); } catch { return null; }
      };
      const sidebarCssVisible = node => {
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          style.visibility !== 'collapse' && style.contentVisibility !== 'hidden' &&
          [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
      };
      const sidebarCssDirectText = node => {
        if (node.tagName === 'INPUT' && ['button','submit'].includes(node.type)) return [node.value || ''];
        const segments = [];
        let segment = '';
        for (const child of sidebarComposedChildren(node)) {
          if (--sidebarCssHasBudget < 0) throw new Error('SIDEBAR_DOM_LIMIT');
          if (child.nodeType === 3) {
            segment += child.nodeValue || '';
            if (segment.length > 200000) throw new Error('SIDEBAR_TEXT_TOO_LARGE');
          } else if (child.nodeType === 1 && segment) {
            segments.push(segment);
            segment = '';
          }
        }
        if (segment) segments.push(segment);
        return segments;
      };
      const sidebarCssSmallestText = (node,needle,exact) => {
        if (['SCRIPT','STYLE','NOSCRIPT'].includes(node.tagName) ||
          node.ownerDocument.head?.contains(node)) return false;
        const input = node.tagName === 'INPUT' && ['button','submit'].includes(node.type)
          ? node.value || '' : null;
        const matches = exact
          ? sidebarCssDirectText(node).some(text => sidebarCssNormalize(text) === needle)
          : sidebarCssNormalize(input ?? sidebarCssText(node)).toLocaleLowerCase()
            .includes(needle.toLocaleLowerCase());
        if (!matches) return false;
        const descendants = [...sidebarComposedChildren(node)].filter(child => child.nodeType === 1);
        while (descendants.length) {
          const child = descendants.pop();
          if (--sidebarCssHasBudget < 0) throw new Error('SIDEBAR_DOM_LIMIT');
          if (['SCRIPT','STYLE','NOSCRIPT'].includes(child.tagName) ||
            child.ownerDocument.head?.contains(child)) continue;
          if (exact) {
            if (sidebarCssDirectText(child).some(text => sidebarCssNormalize(text) === needle)) return false;
            for (const nested of sidebarComposedChildren(child)) {
              if (nested.nodeType === 1) descendants.push(nested);
            }
          } else if (sidebarCssNormalize(sidebarCssText(child)).toLocaleLowerCase()
            .includes(needle.toLocaleLowerCase())) return false;
        }
        return true;
      };
      const sidebarCssSmallestRegex = (node,expression) => {
        if (['SCRIPT','STYLE','NOSCRIPT'].includes(node.tagName) ||
          node.ownerDocument.head?.contains(node)) return false;
        const matches = value => {
          expression.lastIndex = 0;
          return expression.test(sidebarCssNormalize(value));
        };
        const input = node.tagName === 'INPUT' && ['button','submit'].includes(node.type)
          ? node.value || '' : null;
        if (!matches(input ?? sidebarCssText(node))) return false;
        const descendants = [...sidebarComposedChildren(node)].filter(child => child.nodeType === 1);
        while (descendants.length) {
          const child = descendants.pop();
          if (--sidebarCssHasBudget < 0) throw new Error('SIDEBAR_DOM_LIMIT');
          if (['SCRIPT','STYLE','NOSCRIPT'].includes(child.tagName) ||
            child.ownerDocument.head?.contains(child)) continue;
          if (matches(sidebarCssText(child))) return false;
        }
        return true;
      };
      const sidebarMatchesCSS = (node,selector) => {
        const matchesPart = (candidate,part,depth=0) => {
          if (depth > 16) throw new Error('SIDEBAR_DOM_LIMIT');
          try { if (candidate.matches(part)) return true; }
          catch { /* Browser CSS does not parse Playwright-only text pseudo-classes. */ }
          const pseudo = sidebarCssPseudo(part);
          if (pseudo) {
            if (pseudo.rest && !matchesPart(candidate,pseudo.rest,depth+1)) return false;
            if (pseudo.name === 'visible') return sidebarCssVisible(candidate);
            if (pseudo.name === 'has-text') {
              const text = sidebarCssString(pseudo.argument);
              if (text === null) return false;
              const needle = sidebarCssNormalize(text).toLocaleLowerCase();
              return needle.length > 0 && sidebarCssNormalize(sidebarCssText(candidate))
                .toLocaleLowerCase().includes(needle);
            }
            if (pseudo.name === 'text' || pseudo.name === 'text-is') {
              const text = sidebarCssString(pseudo.argument);
              const needle = text === null ? '' : sidebarCssNormalize(text);
              return needle.length > 0 &&
                sidebarCssSmallestText(candidate,needle,pseudo.name === 'text-is');
            }
            if (pseudo.name === 'text-matches') {
              const expression = sidebarCssRegex(pseudo.argument);
              return expression !== null && sidebarCssSmallestRegex(candidate,expression);
            }
            if (pseudo.name === 'nth-match') {
              const argument = /^([\s\S]+),\s*([1-9]\d*)\s*$/.exec(pseudo.argument);
              const inner = argument?.[1].trim();
              const index = Number(argument?.[2]);
              if (!inner || !Number.isSafeInteger(index) || index > 100000) return false;
              const doc = candidate.ownerDocument;
              let matches = sidebarNthMatchCache.get(doc);
              if (!matches) { matches = new Map(); sidebarNthMatchCache.set(doc,matches); }
              if (!matches.has(inner)) {
                matches.set(inner,sidebarAllNodes(doc).filter(node => sidebarMatchesCSS(node,inner)));
              }
              return matches.get(inner)[index - 1] === candidate;
            }
          } else {
            try { return candidate.matches(part); } catch { return false; }
          }
          const relative = pseudo.argument.trim();
      const combinator = /^[>+~]/.exec(relative)?.[0] || '';
      const target = combinator ? relative.slice(1).trim() : relative;
      if (!target) return false;
      if (combinator === '+' || combinator === '~') {
        for (let sibling = candidate.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
          if (--sidebarCssHasBudget < 0) throw new Error('SIDEBAR_DOM_LIMIT');
          if (sidebarMatchesCSS(sibling,target)) return true;
          if (combinator === '+') break;
        }
        return false;
      }
      const stack = [candidate];
      while (stack.length) {
        const current = stack.pop();
        if (--sidebarCssHasBudget < 0) throw new Error('SIDEBAR_DOM_LIMIT');
        if (current !== candidate &&
          (combinator !== '>' || sidebarParent(current) === candidate) &&
          sidebarMatchesCSS(current,target)) return true;
        for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]);
        if (current.shadowRoot) {
          for (let i = current.shadowRoot.children.length - 1; i >= 0; i--) {
            stack.push(current.shadowRoot.children[i]);
          }
        }
      }
      return false;
    };
    const groups = [];
    let parts = [], combinators = [], token = '', pending = null;
    let quote = '', square = 0, round = 0, escape = false;
    const flush = () => {
      if (!token) return;
      if (parts.length) combinators.push(pending || ' ');
      parts.push(token);
      token = '';
      pending = null;
    };
    for (const char of selector) {
      if (escape) { token += char; escape = false; continue; }
      if (char === '\\') { token += char; escape = true; continue; }
      if (quote) { token += char; if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { token += char; quote = char; continue; }
      if (char === '[') square++;
      if (char === ']') square--;
      if (char === '(') round++;
      if (char === ')') round--;
      if (square || round) { token += char; continue; }
      if (/\s/.test(char)) { flush(); if (parts.length && !pending) pending = ' '; continue; }
      if (char === '>') { flush(); if (!parts.length) return false; pending = '>'; continue; }
      if (char === '+' || char === '~') {
        flush();
        if (!parts.length) return false;
        pending = char;
        continue;
      }
      if (char === ',') {
        flush();
        if (parts.length) groups.push({parts,combinators});
        parts = []; combinators = []; pending = null;
        continue;
      }
      token += char;
    }
    flush();
    if (parts.length) groups.push({parts,combinators});
    return groups.some(group => {
      if (!matchesPart(node,group.parts.at(-1))) return false;
      let current = node;
      for (let index = group.parts.length - 2; index >= 0; index--) {
        const combinator = group.combinators[index];
        current = combinator === '+' || combinator === '~'
          ? current.previousElementSibling : sidebarParent(current);
        if (combinator === '~') {
          while (current && !matchesPart(current,group.parts[index])) current = current.previousElementSibling;
        } else if (combinator !== '>' && combinator !== '+') {
          while (current && !matchesPart(current,group.parts[index])) current = sidebarParent(current);
        }
        if (!current || !matchesPart(current,group.parts[index])) return false;
      }
      return true;
    });
  };
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
    const interactive = sidebarQueryAll(doc,sidebarSelector)
      .filter(node => !(node.tagName === 'INPUT' && node.type === 'hidden') &&
        (node.tagName.toLowerCase() !== 'svg' || node.querySelector('title') ||
          node.hasAttribute('aria-label') || node.hasAttribute('aria-labelledby') ||
          node.hasAttribute('role'))).slice(0, 150);
    const extra = sidebarQueryAll(doc,'label,p,summary,em,sub,sup,dfn,del,ins,[data-testid],[placeholder],[aria-label]')
      .filter(node => !interactive.includes(node)).slice(0, 150);
    return interactive.concat(extra);
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
  const sidebarGeneratedText = (node, pseudo) => {
    const style = node.ownerDocument.defaultView.getComputedStyle(node, pseudo);
    if (style.display === 'none' || style.visibility === 'hidden' ||
      style.visibility === 'collapse') return '';
    const content = style.content || '';
    const quoted = /^(?:"([^"\\]{0,160})"|'([^'\\]{0,160})')$/.exec(content);
    return quoted ? quoted[1] ?? quoted[2] ?? '' : '';
  };
  const sidebarEmbeddedValue = node => {
    if (node.tagName === 'INPUT') {
      if (!['text','search','url','tel','email','number','range'].includes(node.type)) return null;
      const valueText = ['number','range'].includes(node.type)
        ? node.getAttribute('aria-valuetext') : null;
      return (valueText?.trim() || node.value || '').slice(0,160);
    }
    if (node.tagName === 'TEXTAREA') return (node.value || '').slice(0,160);
    if (node.tagName === 'SELECT') return [...node.selectedOptions].slice(0,20)
      .map(option => option.label || option.textContent || '').join(' ').slice(0,160);
    const role = (node.getAttribute('role') || '').split(/\s+/)[0];
    if (['slider','spinbutton'].includes(role)) return (node.getAttribute('aria-valuetext') ||
      node.getAttribute('aria-valuenow') || '').slice(0,160);
    return null;
  };
  const sidebarReferencedName = (root) => {
    let remaining = 2000;
    const hidden = node => {
      if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden') ||
        node.hasAttribute('inert')) return true;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      return style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || style.contentVisibility === 'hidden';
    };
    const includeHidden = hidden(root);
    const walk = node => {
      if (--remaining < 0) return '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (['SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(node.tagName)) return '';
      if (node !== root && !includeHidden && hidden(node)) return '';
      if (node !== root) {
        const embedded = sidebarEmbeddedValue(node);
        if (embedded !== null) return embedded;
      }
      const aria = node.getAttribute('aria-label');
      if (aria?.trim()) return aria;
      if (node.tagName === 'IMG' || node.tagName === 'AREA' ||
        node.tagName === 'INPUT' && node.type === 'image') return node.getAttribute('alt') || '';
      if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' ||
        node.tagName === 'SELECT') return '';
      if (node.tagName.toLowerCase() === 'svg') {
        const title = [...node.children].find(child => child.tagName.toLowerCase() === 'title');
        return title?.textContent || '';
      }
      let result = sidebarGeneratedText(node, '::before');
      for (const child of sidebarComposedChildren(node)) {
        const part = walk(child);
        if (!part) continue;
        if (child.nodeType === 1 && result && !/\s$/.test(result)) result += ' ';
        result += part;
        if (child.nodeType === 1) result += ' ';
      }
      return result + sidebarGeneratedText(node, '::after');
    };
    return walk(root).replace(/\s+/g, ' ').trim();
  };
  const sidebarLabelName = (node, nativeLabels = true) => {
    const ids = [...new Set((node.getAttribute('aria-labelledby') || '').trim()
      .split(/\s+/).filter(Boolean))].slice(0,8);
    if (ids.length) {
      const linked = ids.map(id => {
        const label = (node.getRootNode?.() || node.ownerDocument).getElementById(id);
        return label ? sidebarReferencedName(label).slice(0,160) : '';
      }).join(' ').trim();
      if (linked) return linked;
    }
    const aria = node.getAttribute('aria-label') || '';
    if (aria.trim()) return aria;
    if (!nativeLabels) return '';
    const labels = node.labels ? [...node.labels].slice(0,8)
      .map(label => sidebarReferencedName(label).slice(0,160)).join(' ').trim() : '';
    return labels;
  };
  const sidebarContentName = (root) => {
    let remaining = 2000;
    const walk = node => {
      if (--remaining < 0) return '';
      if (node.nodeType === undefined) return node.innerText || '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      if (node !== root) {
        if (node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('hidden') ||
          node.hasAttribute('inert')) return '';
        const style = node.ownerDocument.defaultView.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || style.contentVisibility === 'hidden') return '';
        const embedded = sidebarEmbeddedValue(node);
        if (embedded !== null) return embedded;
        if (node.tagName === 'IMG' || node.tagName === 'AREA' ||
          node.tagName === 'INPUT' && node.type === 'image') return node.getAttribute('alt') || '';
        if (node.tagName.toLowerCase() === 'svg') {
          const title = [...node.children].find(child => child.tagName.toLowerCase() === 'title');
          return title?.textContent || '';
        }
        const label = sidebarLabelName(node);
        if (label) return label;
      }
      return sidebarGeneratedText(node, '::before') +
        [...sidebarComposedChildren(node)].map(walk).join('') +
        sidebarGeneratedText(node, '::after');
    };
    return walk(root);
  };
  const sidebarAccessibleName = (node, role, skipTitle = false) => {
    const label = sidebarLabelName(node, !['meter','progressbar'].includes(role));
    if (label) return label;
    if (node.tagName === 'FIELDSET') {
      const legend = [...node.children].find(child => child.tagName === 'LEGEND');
      if (legend) return legend.innerText || legend.textContent || '';
    }
    if (node.tagName === 'FIGURE' || node.tagName === 'TABLE') {
      const tag = node.tagName === 'FIGURE' ? 'FIGCAPTION' : 'CAPTION';
      const caption = [...node.children].find(child => child.tagName === tag);
      if (caption) return caption.innerText || caption.textContent || '';
    }
    if (node.tagName === 'INPUT' && ['button','submit','reset'].includes(node.type)) {
      if (node.value) return node.value;
      if (node.type === 'submit') return 'Submit';
      if (node.type === 'reset') return 'Reset';
    }
    if (['IMG','AREA'].includes(node.tagName) || node.tagName === 'INPUT' && node.type === 'image') {
      const alt = node.getAttribute('alt') || '';
      if (alt) return alt;
    }
    if (node.tagName.toLowerCase() === 'svg') {
      const title = [...node.children].find(child => child.tagName.toLowerCase() === 'title');
      if (title?.textContent) return title.textContent;
    }
    if (['button','link','heading','option','cell','columnheader','rowheader',
      'tab','menuitem','menuitemcheckbox','menuitemradio','checkbox','radio','switch','treeitem','gridcell']
      .includes(role)) {
      const content = sidebarContentName(node);
      if (content.trim()) return content;
    }
    if (['BUTTON','A'].includes(node.tagName)) {
      const image = node.querySelector('img[alt],input[type=image][alt],svg > title');
      if (image?.tagName.toLowerCase() === 'title' && image.textContent) return image.textContent;
      if (image?.getAttribute('alt')) return image.getAttribute('alt');
    }
    if (skipTitle && node.getAttribute('title')) return '';
    return node.getAttribute('title') || node.getAttribute('placeholder') || '';
  };
  const sidebarAccessibleDescription = (node, role) => {
    const describedBy = node.getAttribute('aria-describedby');
    if (describedBy !== null) return describedBy.trim().split(/\s+/).filter(Boolean).slice(0,8)
      .map(id => {
        const target = (node.getRootNode?.() || node.ownerDocument).getElementById(id);
        return target ? (target.innerText || target.textContent || '').slice(0,160) : '';
      }).join(' ').trim();
    const aria = node.getAttribute('aria-description');
    if (aria !== null) return aria;
    const title = node.getAttribute('title') || '';
    return title && sidebarAccessibleName(node, role, true) ? title : '';
  };
  const sidebarValidRoles = new Set((
    'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox ' +
    'complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid ' +
    'gridcell group heading img insertion link list listbox listitem log main mark marquee math meter menu menubar ' +
    'menuitem menuitemcheckbox menuitemradio navigation none note option paragraph presentation progressbar radio radiogroup ' +
    'region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript ' +
    'switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem'
  ).split(' '));
  const sidebarDescribe = (node) => {
    const roleAttribute = node.getAttribute('role') || '';
    const rolePrefix = roleAttribute.slice(0,512);
    const roleTokens = rolePrefix.split(' ');
    if (roleAttribute.length > rolePrefix.length && roleAttribute[rolePrefix.length] !== ' ') roleTokens.pop();
    const rawRole = roleTokens.map(role => role.trim()).find(role => sidebarValidRoles.has(role)) || '';
    const presentational = rawRole === 'none' || rawRole === 'presentation';
    const globalAria = presentational && node.getAttributeNames().some(name => name.startsWith('aria-'));
    const focusable = presentational && !node.matches(':disabled') &&
      (node.hasAttribute('tabindex') || node.tabIndex >= 0);
    const hasLandmarkAncestor = !!node.parentElement?.closest('article,aside,main,nav,section');
    const hasName = !!((node.getAttribute('aria-labelledby') || '').trim() ||
      (node.getAttribute('aria-label') || '').trim());
    const role = rawRole && !(presentational && (globalAria || focusable)) ? rawRole :
      node.tagName === 'INPUT' ? ({number:'spinbutton',range:'slider',checkbox:'checkbox',radio:'radio',image:'button',button:'button',submit:'button',reset:'button',file:'button',hidden:'hidden',search:'searchbox'})[node.type] || 'textbox' :
      ['A','AREA'].includes(node.tagName) ? (node.hasAttribute('href') ? 'link' : 'generic') :
      node.tagName === 'SELECT' ? (node.multiple || node.size > 1 ? 'listbox' : 'combobox') :
      node.tagName === 'TH' ? (['row','rowgroup'].includes(node.getAttribute('scope')) ||
        !['col','colgroup'].includes(node.getAttribute('scope')) &&
        !!node.parentElement?.querySelector(':scope > td') ? 'rowheader' : 'columnheader') :
      node.tagName.toLowerCase() === 'svg' ? 'img' :
      node.tagName === 'IMG' && node.getAttribute('alt') === '' &&
        !(node.getAttribute('title') || '').trim() &&
        !node.getAttributeNames().some(name => name.startsWith('aria-')) &&
        node.getAttribute('tabindex') === null && node.tabIndex < 0 ? 'presentation' :
      node.tagName === 'FORM' ? (hasName ? 'form' : 'generic') :
      node.tagName === 'SECTION' ? (hasName ? 'region' : 'generic') :
      node.tagName === 'HEADER' ? (hasLandmarkAncestor ? 'generic' : 'banner') :
      node.tagName === 'FOOTER' ? (hasLandmarkAncestor ? 'generic' : 'contentinfo') :
      ({IMG:'img',BUTTON:'button',TEXTAREA:'textbox',OPTION:'option',UL:'list',OL:'list',MENU:'list',LI:'listitem',TABLE:'table',THEAD:'rowgroup',TBODY:'rowgroup',TFOOT:'rowgroup',TR:'row',TD:'cell',P:'paragraph',MAIN:'main',NAV:'navigation',ASIDE:'complementary',ARTICLE:'article',DIALOG:'dialog',DETAILS:'group',FIELDSET:'group',FIGURE:'figure',PROGRESS:'progressbar',METER:'meter',OUTPUT:'status',HR:'separator',DT:'term',DD:'definition',EM:'emphasis',SUB:'subscript',SUP:'superscript',DFN:'term',DEL:'deletion',INS:'insertion',DIV:'generic',SPAN:'generic',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading'})[node.tagName] ||
        node.tagName.toLowerCase();
    const name = (role === 'generic' ? '' : sidebarAccessibleName(node, role))
      .trim().replace(/\s+/g, ' ').replaceAll('[ref=', '[ref =').slice(0, 60);
    return {role, name, explicitRole:rawRole};
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
      let hit = doc.elementFromPoint(localX, localY);
      while (hit?.shadowRoot) {
        const nested = hit.shadowRoot.elementFromPoint(localX, localY);
        if (!nested || nested === hit) break;
        hit = nested;
      }
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
      !sidebarContains(node,target.hit)) {
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
      const textMatches = (value,needle,exact) => {
        if (needle && typeof needle === 'object' && needle.__cu === 'regexp') {
          return new RegExp(needle.source,needle.flags).test(normalize(value));
        }
        return exact ? normalize(value) === normalize(needle)
          : normalize(value).toLocaleLowerCase().includes(normalize(needle).toLocaleLowerCase());
      };
      const locatorTextCache = new WeakMap();
      const locatorText = (node) => {
        if (node.nodeType === undefined) return node.tagName === 'INPUT' &&
          ['button','submit'].includes(node.type) ? node.value : node.innerText || '';
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';
        if (locatorTextCache.has(node)) return locatorTextCache.get(node);
        if (['SCRIPT','NOSCRIPT','STYLE'].includes(node.tagName) ||
          node.ownerDocument.head?.contains(node)) return '';
        let value = node.tagName === 'INPUT' && ['button','submit'].includes(node.type)
          ? node.value : '';
        if (!value) for (const child of node.childNodes) {
          if (child.nodeType === 3 || child.nodeType === 1) value += locatorText(child);
        }
        if (node.shadowRoot) for (const child of node.shadowRoot.childNodes) {
          if (child.nodeType === 3 || child.nodeType === 1) value += locatorText(child);
        }
        locatorTextCache.set(node,value);
        return value;
      };
      const locatorTextMatches = (value,needle,exact) => needle &&
        typeof needle === 'object' && needle.__cu === 'regexp'
        ? new RegExp(needle.source,needle.flags).test(value)
        : textMatches(value,needle,exact);
      const excludedAncestors = new WeakMap();
      const ariaHidden = (node) => {
        if (node.tagName === 'INPUT' && node.type === 'hidden') return true;
        const chain = [];
        let current = node;
        while (current && !excludedAncestors.has(current)) {
          chain.push(current);
          current = sidebarParent(current);
        }
        let excluded = current ? excludedAncestors.get(current) : false;
        for (let index = chain.length - 1; index >= 0; index--) {
          const element = chain[index];
          if (!excluded) {
            const style = element.ownerDocument.defaultView.getComputedStyle(element);
            excluded = element.getAttribute('aria-hidden') === 'true' ||
              element.getAttribute('hidden') !== null ||
              style.display === 'none' || style.contentVisibility === 'hidden';
          }
          excludedAncestors.set(element,excluded);
        }
        if (excluded) return true;
        const visibility = node.ownerDocument.defaultView.getComputedStyle(node).visibility;
        return visibility === 'hidden' || visibility === 'collapse';
      };
      const ariaBoolean = (node,name) => {
        const value = node.getAttribute('aria-' + name);
        return value === 'true' ? true : value === 'false' ? false : undefined;
      };
      const roleState = (node,role,name) => {
        if (name === 'disabled') return node.matches(':disabled') ||
          !!node.closest('[aria-disabled="true"]');
        if (name === 'checked' && node.tagName === 'INPUT' &&
          ['checkbox','radio'].includes(node.type)) return node.checked;
        if (name === 'selected' && node.tagName === 'OPTION') return node.selected;
        if (name === 'level') {
          const raw = node.getAttribute('aria-level');
          if (raw !== null) {
            const level = Number(raw);
            return Number.isSafeInteger(level) && level > 0 ? level : undefined;
          }
          if (role === 'heading' && /^H[1-6]$/.test(node.tagName)) return Number(node.tagName[1]);
          return undefined;
        }
        return ariaBoolean(node,name);
      };
      const matchesBase = (node,selector) => {
        if (selector.method === 'locator') {
          try { return sidebarMatchesCSS(node,selector.value); }
          catch { throw new Error('SIDEBAR_SELECTOR_INVALID'); }
        }
        if (selector.method === 'getByRole') {
          const described = sidebarDescribe(node);
          return described.role === selector.value &&
            (described.role !== 'generic' || described.explicitRole === 'generic') &&
            (selector.includeHidden || !ariaHidden(node)) &&
            (selector.name === undefined || textMatches(described.name,selector.name,selector.exact)) &&
            (selector.description === undefined ||
              textMatches(sidebarAccessibleDescription(node,described.role),selector.description,selector.exact)) &&
            ['checked','disabled','expanded','level','pressed','selected'].every(name =>
              selector[name] === undefined || roleState(node,described.role,name) === selector[name]);
        }
        if (selector.method === 'getByTestId') {
          const id = node.getAttribute('data-testid');
          return id !== null && (typeof selector.value === 'string'
            ? id === selector.value : new RegExp(selector.value.source,selector.value.flags).test(id));
        }
        let text = '';
        if (selector.method === 'getByText') {
          text = locatorText(node);
          if (!locatorTextMatches(text,selector.value,selector.exact)) return false;
          return ![...node.children,...(node.shadowRoot?.children || [])].some(child =>
            locatorTextMatches(locatorText(child),selector.value,selector.exact));
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
        const text = locatorText(node);
        return (filter.hasText === undefined || locatorTextMatches(text,filter.hasText,false)) &&
          (filter.hasNotText === undefined || !locatorTextMatches(text,filter.hasNotText,false)) &&
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
        try { frames = sidebarFrames(doc).filter(node => sidebarMatchesCSS(node,selector)); }
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
          const parent = sidebarParent(node);
          if ((selected.has(node) || containing.has(node)) && parent) {
            containing.add(parent);
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
          const inherited = states.get(sidebarParent(node)) || 0;
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
            !node.closest('[aria-disabled="true"]')} : {}),
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
          })()} : {}),
          ...(query.projection === 'attribute' ? {attribute:(() => {
            const value = node.getAttribute(query.attributeName);
            if (value !== null && value.length > 24000) throw new Error('SIDEBAR_ATTRIBUTE_TOO_LARGE');
            return value;
          })()} : {}),
          ...(query.projection === 'downloadUrl' ? {downloadUrl:(() => {
            const href = node.getAttribute('href');
            if (!href) throw new Error('NO_DOWNLOAD_LINK');
            const url = new URL(href, node.baseURI);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
              url.href.length > 16384) throw new Error('UNSUPPORTED_DOWNLOAD_URL');
            return url.href;
          })()} : {})}];
      })();
      return {url:location.href,title:document.title.slice(0,512),count,rows,
        ...(query.projection === 'allTextContents' ? {texts:allTexts} : {})};
    })()`
}
