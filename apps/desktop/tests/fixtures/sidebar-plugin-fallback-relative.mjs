/**
 * Run with DSH_COMPUTER_USE_PLUGIN_DIR=/path/to/dsh-computer-use-safe
 * node apps/desktop/tests/fixtures/sidebar-plugin-fallback-relative.mjs.
 * Exercises the client-module fallback used by an unmodified official shell.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'

const pluginDirectory = process.env.DSH_COMPUTER_USE_PLUGIN_DIR
if (!pluginDirectory) throw new Error('Set DSH_COMPUTER_USE_PLUGIN_DIR to the Computer Use plugin checkout')
const page = new JSDOM('<!doctype html><title>Fallback</title><section data-testid="group-a"><div class="inner"><p data-testid="duplicate">Shared</p></div></section><div class="inner"><section data-testid="group-b"><p data-testid="duplicate">Shared</p></section></div><img alt="Playwright logo"><span title="Issues count">25</span><div alt="Playwright logo">Unrelated alt</div><label for="account">Account name</label><input id="account"><span id="action-word">Action</span><span id="detail-word">details</span><button aria-labelledby="action-word detail-word" aria-label="Wrong name">X</button><label><input type="checkbox">Subscribe</label><button><img alt="Search"></button><input type="submit" value="Send form">', { url: 'https://example.test/' })
for (const node of page.window.document.querySelectorAll('.inner')) {
  Object.defineProperty(node, 'innerText', { value: 'Shared', configurable: true })
}
const url = page.window.location.href
const relative = { method: 'getByTestId', value: 'duplicate', exact: false,
  scopes: [{ method: 'locator', value: '.inner', exact: false, filter: { hasText: 'Shared' } }] }
const queries = [
  { method: 'getByTestId', value: 'group-a', exact: false, filter: { has: relative } },
  { method: 'getByTestId', value: 'group-b', exact: false, filter: { has: relative } },
  { method: 'getByTestId', value: 'group-b', exact: false, filter: { hasNot: relative } },
  { method: 'getByAltText', value: 'logo', exact: false },
  { method: 'getByAltText', value: 'Playwright logo', exact: true },
  { method: 'getByAltText', value: 'playwright logo', exact: true },
  { method: 'getByRole', value: 'img', name: 'Playwright logo', exact: true },
  { method: 'getByTitle', value: 'Issues', exact: false },
  { method: 'getByTitle', value: 'issues count', exact: true },
  { method: 'getByRole', value: 'textbox', name: 'Account name', exact: true },
  { method: 'getByRole', value: 'button', name: 'Action details', exact: true },
  { method: 'getByRole', value: 'button', name: 'Wrong name', exact: true },
  { method: 'getByRole', value: 'checkbox', name: 'Subscribe', exact: true },
  { method: 'getByRole', value: 'button', name: 'Search', exact: true },
  { method: 'getByRole', value: 'button', name: 'Send form', exact: true },
  { method: 'getByLabel', value: 'Account name', exact: true },
  { method: 'getByLabel', value: 'Wrong name', exact: true },
]
const commands = queries.map((query, index) => ({
  id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, sessionId: 'session-a', tabId: 'tab-a',
  op: 'locate', expectedUrl: url, args: { approvedOrigin: page.window.location.origin, query },
}))
const completions = []
let registration, dispose
const view = {
  getURL: () => url, getTitle: () => 'Fallback', isLoading: () => false,
  addEventListener() {}, removeEventListener() {},
  async executeJavaScript(code) {
    return runInNewContext(code, { location: page.window.location, document: page.window.document, URL })
  },
}
const host = { hidden: false, getAttribute: name => name === 'data-dockkit-content' ? 'tab-a' : null,
  closest: () => ({ hasAttribute: () => true }), querySelectorAll: () => [view] }
const session = { hidden: false, getAttribute: () => 'session-a', querySelectorAll: () => [host] }
const context = {
  window: { __ModuleLoader__: { load(entry) { registration = entry } } },
  document: { body: {}, querySelectorAll: () => [session] },
  dshDesktop: { protocolVersion: 1 },
  MutationObserver: class { observe() {} disconnect() {} },
  crypto: { randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  AbortController, URL, setTimeout, clearTimeout,
  fetch: async (route, options) => {
    if (route.endsWith('/poll')) {
      if (commands.length) return { ok: true, json: async () => ({ ok: true, value: { command: commands.shift() } }) }
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }))
    }
    completions.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ ok: true, value: { accepted: true } }) }
  },
}
context.globalThis = context
try {
  runInNewContext(readFileSync(resolve(pluginDirectory, 'lib/client.js'), 'utf8'), context)
  const plugin = registration.factory(name => name === 'react' ? {
    createElement: () => {}, useEffect() {}, useState() {}, useSyncExternalStore() {},
  } : {})
  plugin.apply({ slots: { inject() {} }, locale: { getSnapshot: () => ({ active: 'en' }) },
    sidebarRight: { mounted: { getSnapshot: () => 'session-a', subscribe: () => () => {} },
      openTabs: { getSnapshot: () => [{ sessionId: 'session-a', tabId: 'tab-a', kind: 'browser' }],
        subscribe: () => () => {} } }, effect: callback => { dispose = callback() } })
  for (let attempt = 0; attempt < 100 && completions.length < queries.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(completions.length, queries.length, 'all selected-tab fallback queries completed')
  assert.ok(completions.every(result => result.ok), JSON.stringify(completions.map(result => result.error)))
  assert.deepEqual(completions.map(result => result.value.count), [1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0])
  process.stdout.write('Official-shell plugin fallback locators PASS: relative, attributes, accessible names\n')
} finally {
  await dispose?.()
  page.window.close()
}
