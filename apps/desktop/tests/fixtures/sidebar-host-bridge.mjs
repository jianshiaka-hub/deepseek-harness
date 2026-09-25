/**
 * Run after the Sidebar TypeScript build with:
 * DSH_COMPUTER_USE_PLUGIN_DIR=/path/to/dsh-computer-use-safe node apps/desktop/tests/fixtures/sidebar-host-bridge.mjs
 *
 * Exercises the built DSH reporter against the separately installed plugin's
 * registered Host routes without opening a real DSH profile or user tab.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { SidebarComputerUseReporter } from '../../../../packages/client/ui-sidebar-browser/lib/types/client/electron/SidebarComputerUseReporter.js'

const pluginDirectory = process.env.DSH_COMPUTER_USE_PLUGIN_DIR
if (!pluginDirectory) throw new Error('Set DSH_COMPUTER_USE_PLUGIN_DIR to the Computer Use plugin checkout')
const pluginUrl = file => pathToFileURL(resolve(pluginDirectory, file)).href
const [{ SidebarBridge }, { registerSidebarRoutes }, { dispatchSidebarBrowser }] = await Promise.all([
  import(pluginUrl('lib/sidebar-bridge.js')),
  import(pluginUrl('lib/connection-routes.js')),
  import(pluginUrl('lib/sidebar-browser.js')),
])

const bridge = new SidebarBridge({ pollMs: 10, commandTimeoutMs: 2000 })
const routes = new Map()
registerSidebarRoutes({ fetch: { register: route => routes.set(route.path, route) } }, bridge)
const originalFetch = globalThis.fetch
const completions = []
globalThis.fetch = async (path, init) => {
  const url = new URL(path, 'http://localhost/')
  const route = routes.get(url.pathname)
  if (!route) throw new Error(`Unregistered Host route: ${url.pathname}`)
  if (url.pathname.endsWith('/complete')) completions.push(JSON.parse(init.body))
  return route.fetch(new Request(url, init))
}

const url = 'https://example.test/page'
const origin = new URL(url).origin
const selectedTab = { sessionId: 'session-a', tabId: 'tab-a', controllerAvailable: true,
  observedUrl: url, requestedUrl: url, title: 'Example' }
const redirect = { ...selectedTab, observedUrl: 'https://final.example/',
  requestedUrl: 'https://final.example/', title: 'Final' }
const agent = { session: { id: 'session-a' } }
const id = 'sidebar:session-a:tab-a'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
let selected = selectedTab
let heldRead
let pendingDialog = null
let nextClickDialog = false
let nextClickPrompt = false
let nextGotoDialog = false
let dialogNavigation = false
const syntheticDialog = { id: 'e137a885-e786-42d9-86b6-a29903d2e52e', type: 'confirm' }
const promptDialog = { id: 'a137a885-e786-42d9-86b6-a29903d2e52e', type: 'prompt' }
const beforeUnloadDialog = { id: 'f137a885-e786-42d9-86b6-a29903d2e52e', type: 'beforeunload' }
const commands = []
const approvals = []
const reporter = new SidebarComputerUseReporter(() => selected, async (_tab, command) => {
  commands.push(command)
  if (command.op === 'inspect') {
    if (heldRead) return new Promise(resolve => { heldRead.resolve = resolve })
    return { url, title: 'Example', text: 'Approved page text' }
  }
  if (command.op === 'screenshot') return { url, title: 'Example', base64: png, viewport: { width: 1, height: 1 } }
  if (command.op === 'dialog') return { url, title: 'Example', dialog: pendingDialog }
  if (command.op === 'dialogAction') {
    assert.deepEqual([command.args.handle, command.args.decision], [pendingDialog?.id, 'accept'])
    if (pendingDialog?.type === 'prompt') assert.equal(command.args.text, 'approved answer')
    pendingDialog = null
    if (dialogNavigation) {
      dialogNavigation = false
      selected = redirect
      reporter.notify()
      return { url: redirect.observedUrl, title: redirect.title, performed: true }
    }
    return { url, title: 'Example', performed: true }
  }
  if (['click', 'drag', 'key', 'type', 'setValue', 'selectText', 'secondary'].includes(command.op)) {
    if (command.op === 'click' && nextClickPrompt) {
      nextClickPrompt = false
      pendingDialog = promptDialog
      return { url, title: 'Example', performed: true, dialog: promptDialog }
    }
    if (command.op === 'click' && nextClickDialog) {
      nextClickDialog = false
      pendingDialog = syntheticDialog
      return { url, title: 'Example', performed: true, dialog: syntheticDialog }
    }
    return { url, title: 'Example', performed: true,
      ...(command.op === 'drag' ? { dropDispatched: true } : {}) }
  }
  if (command.op === 'paste') return { url, title: 'Example', performed: true,
    clipboardRestored: true, clipboardSuperseded: false }
  if (command.op === 'goto') {
    if (nextGotoDialog) {
      nextGotoDialog = false
      dialogNavigation = true
      pendingDialog = beforeUnloadDialog
      return { url, title: 'Example', performed: true, dialog: beforeUnloadDialog }
    }
    selected = redirect
    reporter.notify()
    return { url: redirect.observedUrl, title: redirect.title, performed: true }
  }
  if (command.op === 'back' || command.op === 'forward') {
    selected = command.op === 'back' ? selectedTab : redirect
    reporter.notify()
    return { url: selected.observedUrl, title: selected.title, performed: true }
  }
  if (command.op === 'close') {
    selected = null
    reporter.notifySelection()
    return { url: command.expectedUrl, title: '', closed: true }
  }
  throw new Error(`Unexpected command ${command.op}`)
})

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for the reporter/Host bridge')
}

try {
  reporter.start()
  await until(() => bridge.list().length === 1)
  const authorize = async site => { approvals.push(site); assert.equal(site, origin) }
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'snapshot', { id }, async () => {
    throw new Error('SITE_DENIED')
  }), /SITE_DENIED/)
  assert.equal(commands.length, 0, 'denied sites must not reach the Desktop reporter')
  assert.equal(await dispatchSidebarBrowser(bridge, agent, 'snapshot', { id }, authorize), 'Approved page text')
  const image = await dispatchSidebarBrowser(bridge, agent, 'screenshot', { id, fullPage: true }, authorize)
  assert.equal(image.base64, png)
  assert.equal(commands.at(-1).args.fullPage, true)
  let oneUse = 0
  const beforeDeniedClick = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'click', { id, ref: '0:button:Press' },
    authorize, undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedClick, 'a denied click must not reach the Desktop reporter')
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'click', { id, ref: '0:button:Press' },
    authorize, undefined, async () => { oneUse++; return true })).performed, true)
  assert.equal(oneUse, 1)
  nextClickDialog = true
  assert.deepEqual((await dispatchSidebarBrowser(bridge, agent, 'click',
    { id, ref: '0:button:Press' }, authorize, undefined, async () => true)).dialog, syntheticDialog)
  assert.deepEqual(await dispatchSidebarBrowser(bridge, agent, 'dialog', { id }, authorize), syntheticDialog)
  const beforeDeniedDialog = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'dialogAction',
    { id, handle: syntheticDialog.id, action: 'accept' }, authorize, undefined,
    async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedDialog)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'dialogAction',
    { id, handle: syntheticDialog.id, action: 'accept' }, authorize, undefined,
    async () => true)).performed, true)
  assert.equal(await dispatchSidebarBrowser(bridge, agent, 'dialog', { id }, authorize), null)
  const beforeDeniedKey = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'key', { id, key: 'Enter' },
    authorize, undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedKey, 'a denied key must not reach the Desktop reporter')
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'key', { id, key: 'Enter' },
    authorize, undefined, async () => true)).performed, true)
  assert.equal(commands.at(-1).op, 'key')
  assert.deepEqual(commands.at(-1).args, { approvedOrigin: origin, key: 'Enter' })
  assert.deepEqual(approvals, Array(11).fill(origin))
  nextClickPrompt = true
  assert.deepEqual((await dispatchSidebarBrowser(bridge, agent, 'click',
    { id, ref: '0:button:Press' }, authorize, undefined, async () => true)).dialog, promptDialog)
  assert.deepEqual(await dispatchSidebarBrowser(bridge, agent, 'dialog', { id }, authorize), promptDialog)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'dialogAction',
    { id, handle: promptDialog.id, action: 'accept', text: 'approved answer' },
    authorize, undefined, async () => true)).performed, true)
  assert.equal(await dispatchSidebarBrowser(bridge, agent, 'dialog', { id }, authorize), null)
  const beforeDeniedType = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'type', { id, text: 'Ada' },
    authorize, undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedType)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'type', { id, text: 'Ada' },
    authorize, undefined, async (op, label) => {
      assert.deepEqual([op, label], ['type', '当前聚焦编辑框']); return true
    })).performed, true)
  assert.deepEqual(commands.at(-1).args, { approvedOrigin: origin, text: 'Ada' })
  const beforeDeniedSetValue = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'setValue',
    { id, ref: '1:textbox:Name', value: 'Bea' }, authorize, undefined,
    async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedSetValue)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'setValue',
    { id, ref: '1:textbox:Name', value: 'Bea' }, authorize, undefined,
    async (op, label) => { assert.deepEqual([op, label], ['setValue', 'Name']); return true })).performed, true)
  assert.deepEqual(commands.at(-1).args, { approvedOrigin: origin, ref: '1:textbox:Name', value: 'Bea' })
  const beforeDeniedSelection = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'selectText',
    { id, ref: '1:textbox:Name', text: 'ea', selectionType: 'cursor_after' }, authorize,
    undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedSelection)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'selectText',
    { id, ref: '1:textbox:Name', text: 'ea', selectionType: 'cursor_after' }, authorize,
    undefined, async (op, label) => { assert.deepEqual([op, label], ['selectText', 'Name']); return true })).performed, true)
  assert.deepEqual(commands.at(-1).args, { approvedOrigin: origin, ref: '1:textbox:Name',
    text: 'ea', selectionType: 'cursor_after' })
  const beforeDeniedSecondary = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'secondary',
    { id, ref: '0:button:Press', action: 'ShowMenu' }, authorize,
    undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedSecondary)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'secondary',
    { id, ref: '0:button:Press', action: 'ShowMenu' }, authorize,
    undefined, async (op, label) => { assert.deepEqual([op, label], ['secondary', 'Press']); return true })).performed, true)
  assert.deepEqual(commands.at(-1).args, { approvedOrigin: origin, ref: '0:button:Press', action: 'showmenu' })
  const beforeDeniedPaste = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'paste',
    { id, ref: '1:textbox:Name', text: '<b>Rich</b>', format: 'html' }, authorize,
    undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedPaste)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'paste',
    { id, ref: '1:textbox:Name', text: '<b>Rich</b>', format: 'html' }, authorize,
    undefined, async (op, label) => { assert.deepEqual([op, label], ['paste', 'Name']); return true })).clipboardRestored, true)
  assert.deepEqual(commands.at(-1).args, { approvedOrigin: origin, ref: '1:textbox:Name',
    text: '<b>Rich</b>', format: 'html' })
  const beforeDeniedDrag = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'drag',
    { id, x: 20, y: 30, to: { x: 180, y: 140 } }, authorize,
    undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedDrag)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'drag',
    { id, x: 20, y: 30, to: { x: 180, y: 140 } }, authorize,
    undefined, async (op, label) => {
      assert.deepEqual([op, label], ['drag', '网页坐标 (20, 30) → (180, 140)']); return true
    })).dropDispatched, true)
  assert.deepEqual(commands.at(-1).args, { approvedOrigin: origin,
    x: 20, y: 30, to: { x: 180, y: 140 } })

  heldRead = { resolve: undefined }
  const stale = dispatchSidebarBrowser(bridge, agent, 'snapshot', { id }, authorize)
  const staleFailure = assert.rejects(stale, /SIDEBAR_SELECTION_CHANGED|SIDEBAR_NAVIGATED|侧栏标签|已切换/)
  await until(() => heldRead.resolve !== undefined)
  selected = null
  reporter.notify()
  heldRead.resolve({ url, title: 'Example', text: 'Must not leave the old tab' })
  await staleFailure
  assert.equal(completions.at(-1).ok, false)
  assert.equal(Object.hasOwn(completions.at(-1), 'value'), false)
  await until(() => bridge.list().length === 0)
  assert.deepEqual(await dispatchSidebarBrowser(bridge, agent, 'list', {}, authorize), [])

  selected = selectedTab
  reporter.notifySelection()
  await until(() => bridge.list().length === 1)
  nextGotoDialog = true
  const modalSites = []
  const modalGrant = async site => { modalSites.push(site) }
  const modalAllowed = current => modalSites.includes(new URL(current).origin)
  const modalNavigation = await dispatchSidebarBrowser(bridge, agent, 'goto',
    { id, url: 'https://target.example/path' }, modalGrant, undefined, undefined, modalAllowed)
  assert.deepEqual(modalNavigation.dialog, beforeUnloadDialog)
  assert.equal(modalNavigation.url, url)
  assert.deepEqual(await dispatchSidebarBrowser(bridge, agent, 'dialog', { id }, modalGrant), beforeUnloadDialog)
  const modalHandled = await dispatchSidebarBrowser(bridge, agent, 'dialogAction',
    { id, handle: beforeUnloadDialog.id, action: 'accept' }, modalGrant, undefined,
    async () => true, modalAllowed)
  assert.equal(modalHandled.url, redirect.observedUrl)
  assert.deepEqual(modalSites, [origin, 'https://target.example', origin, origin, 'https://final.example'])

  selected = selectedTab
  reporter.notifySelection()
  await until(() => bridge.list().some(current => current.observedUrl === url))
  const navigationSites = []
  const navigated = await dispatchSidebarBrowser(bridge, agent, 'goto',
    { id, url: 'https://target.example/path' }, async site => { navigationSites.push(site) },
    undefined, async () => { throw new Error('goto reached action approval') },
    current => navigationSites.includes(new URL(current).origin))
  assert.deepEqual(navigated, { url: redirect.observedUrl, title: redirect.title, performed: true })
  assert.deepEqual(navigationSites, [origin, 'https://target.example', 'https://final.example'])
  assert.deepEqual(await dispatchSidebarBrowser(bridge, agent, 'waitNavigation',
    { id, fromUrl: url, timeoutMs: 500 },
    async site => { assert.equal(site, 'https://final.example') }, undefined, undefined,
    current => new URL(current).origin === 'https://final.example'),
  { url: redirect.observedUrl })
  assert.equal(commands.at(-1).op, 'goto')

  const historySites = []
  const historyGrant = async site => { historySites.push(site) }
  const isHistoryGrant = current => historySites.includes(new URL(current).origin)
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'back', { id }, historyGrant,
    undefined, async () => true, isHistoryGrant)).url, url)
  assert.equal(commands.at(-1).op, 'back')
  assert.equal((await dispatchSidebarBrowser(bridge, agent, 'forward', { id }, historyGrant,
    undefined, async () => true, isHistoryGrant)).url, redirect.observedUrl)
  assert.equal(commands.at(-1).op, 'forward')
  assert.deepEqual(historySites, ['https://final.example', origin, origin, 'https://final.example'])
  const beforeDeniedClose = commands.length
  await assert.rejects(dispatchSidebarBrowser(bridge, agent, 'close', { id }, historyGrant,
    undefined, async () => false), /SIDEBAR_ACTION_DENIED/)
  assert.equal(commands.length, beforeDeniedClose)
  const closed = await dispatchSidebarBrowser(bridge, agent, 'close', { id }, historyGrant,
    undefined, async (op, label) => {
      assert.deepEqual([op, label], ['close', '当前侧栏网页标签'])
      return true
    }, isHistoryGrant)
  assert.deepEqual(closed, { url: redirect.observedUrl, title: '', closed: true })
  assert.equal(commands.at(-1).op, 'close')
  assert.deepEqual(bridge.list(), [])
  process.stdout.write('selected Sidebar Host bridge PASS: site grant, confirm/prompt/beforeunload handles, full-page option, one-use click/drag/key/type/setValue/selectText/secondary/paste, stale read, goto/waitNavigation/history, close\n')
} finally {
  await reporter.dispose()
  bridge.dispose()
  globalThis.fetch = originalFetch
}
