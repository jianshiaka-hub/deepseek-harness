/**
 * Run with DSH_COMPUTER_USE_PLUGIN_DIR=/path/to/dsh-computer-use-safe
 * node apps/desktop/tests/fixtures/site-settings-ui.mjs.
 * The Settings Client and Host routes are real; jsdom supplies only the DOM.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { JSDOM } from 'jsdom'

const pluginDirectory = process.env.DSH_COMPUTER_USE_PLUGIN_DIR
if (!pluginDirectory) throw new Error('Set DSH_COMPUTER_USE_PLUGIN_DIR to the Computer Use plugin checkout')
const pluginUrl = file => pathToFileURL(resolve(pluginDirectory, file)).href
const [{ BrowserSitePolicyStore }, { registerComputerUseRoutes }] = await Promise.all([
  import(pluginUrl('lib/browser-site-policy.js')),
  import(pluginUrl('lib/connection-routes.js')),
])
const fromSidebar = createRequire(new URL('../../../../packages/client/ui-sidebar-browser/package.json', import.meta.url))
const React = fromSidebar('react')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const globalDescriptors = new Map(['window', 'document', 'navigator'].map(key =>
  [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
  navigator: dom.window.navigator })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
const { render, fireEvent, screen, waitFor, cleanup } = fromSidebar('@testing-library/react')
const originalFetch = globalThis.fetch

const directory = mkdtempSync(join(tmpdir(), 'dsh-site-ui-'))
const store = new BrowserSitePolicyStore(join(directory, 'sites.json'))
const routes = new Map()
const cleared = []
const requests = []
registerComputerUseRoutes({ fetch: { register: route => routes.set(route.path, route) } }, store,
  { clearSite: site => cleared.push(site) })
globalThis.fetch = (path, init) => {
  const url = new URL(path, 'http://localhost/')
  requests.push({ endpoint: url.pathname, payload: JSON.parse(init.body) })
  return routes.get(url.pathname).fetch(new Request(url, init))
}

try {
  let registration
  dom.window.__ModuleLoader__ = { load: value => { registration = value } }
  const source = readFileSync(resolve(pluginDirectory, 'lib/client.js'), 'utf8')
  new Function('window', source)(dom.window)
  const plugin = registration.factory(name => {
    assert.equal(name, 'react')
    return React
  })
  let component
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => ({ active: 'zh' }) },
    connection: {},
    slots: {
      inject(name, register) { assert.equal(name, 'settings.plugins.tab'); register() },
      register(_options, body) { component = body; return () => {} },
    },
  }
  plugin.apply(ctx)
  render(React.createElement(component))
  const allow = await screen.findByRole('button', { name: '始终允许' })
  await waitFor(() => assert.equal(allow.disabled, false))
  const input = screen.getByLabelText('完整网站来源')
  fireEvent.change(input, { target: { value: 'https://example.com' } })
  fireEvent.click(allow)
  assert.ok(screen.getByRole('group', { name: '确认更改' }))
  assert.deepEqual(store.list().allowed, [])
  assert.equal(requests.filter(request => request.endpoint.endsWith('/change')).length, 0)
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  assert.deepEqual(store.list().allowed, [])
  fireEvent.click(allow)
  fireEvent.click(screen.getByRole('button', { name: '确认更改' }))
  await waitFor(() => assert.deepEqual(store.list().allowed, ['https://example.com']))
  assert.deepEqual(cleared, ['https://example.com'])

  fireEvent.change(input, { target: { value: 'https://example.com/path' } })
  fireEvent.click(allow)
  assert.ok(screen.getByRole('alert').textContent.includes('完整 http(s) 网站来源'))
  assert.equal(requests.filter(request => request.endpoint.endsWith('/change')).length, 1)

  fireEvent.change(input, { target: { value: 'https://example.com' } })
  fireEvent.click(screen.getByRole('button', { name: '始终阻止' }))
  fireEvent.click(screen.getByRole('button', { name: '确认更改' }))
  await waitFor(() => assert.deepEqual(store.list().blocked, ['https://example.com']))
  fireEvent.click(screen.getByRole('button', { name: '移除规则' }))
  fireEvent.click(screen.getByRole('button', { name: '确认更改' }))
  await waitFor(() => assert.deepEqual(store.list(), { allowed: [], blocked: [] }))
  assert.deepEqual(cleared, ['https://example.com', 'https://example.com', 'https://example.com'])
  assert.equal(requests.filter(request => request.endpoint.endsWith('/change')).length, 3)

  fireEvent.change(input, { target: { value: 'https://example.com' } })
  fireEvent.click(allow)
  store.set('https://example.com', 'block-site')
  fireEvent.click(screen.getByRole('button', { name: '确认更改' }))
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('规则已变化')))
  assert.equal(screen.queryByRole('group', { name: '确认更改' }), null)
  assert.deepEqual(store.list().blocked, ['https://example.com'])
  fireEvent.click(screen.getByRole('button', { name: '刷新规则' }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(screen.queryByRole('alert'), null)
  assert.ok(screen.getByText('https://example.com'))
  fireEvent.click(screen.getByRole('button', { name: '移除规则' }))
  fireEvent.click(screen.getByRole('button', { name: '确认更改' }))
  await waitFor(() => assert.deepEqual(store.list(), { allowed: [], blocked: [] }))
  assert.equal(requests.filter(request => request.endpoint.endsWith('/change')).length, 5)
  assert.deepEqual(cleared, Array(4).fill('https://example.com'))
  process.stdout.write('Computer Use site Settings UI PASS: cancel, allow, invalid, block, remove, stale refresh\n')
} finally {
  cleanup()
  rmSync(directory, { recursive: true, force: true })
  globalThis.fetch = originalFetch
  for (const [key, descriptor] of globalDescriptors) {
    if (descriptor === undefined) delete globalThis[key]
    else Object.defineProperty(globalThis, key, descriptor)
  }
  dom.window.close()
}
