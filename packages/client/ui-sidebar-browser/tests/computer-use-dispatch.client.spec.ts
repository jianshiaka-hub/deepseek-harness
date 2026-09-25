// @vitest-environment jsdom
/* oxlint-disable typescript/unbound-method -- BrowserInjected methods asserted below are stateless Vitest spies. */
/** The Desktop bridge translates only approved selected-tab commands into fixed Browser actions. */
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SidebarComputerUseReporter } from '../src/client/electron/SidebarComputerUseReporter.ts'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { createBrowserControllers } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { emptyBrowserFrame } from '../src/client/browser/BrowserFrame.ts'
import { apply, inject } from '../src/client/index.ts'

type Select = ConstructorParameters<typeof SidebarComputerUseReporter>[0]
type Execute = ConstructorParameters<typeof SidebarComputerUseReporter>[1]
type Command = Parameters<Execute>[1]

const captured = vi.hoisted(() => ({ selected: undefined as Select | undefined,
  execute: undefined as Execute | undefined }))
vi.mock('../src/client/electron/SidebarComputerUseReporter.ts', () => ({
  SidebarComputerUseReporter: class {
    constructor(selected: Select, execute: Execute) {
      captured.selected = selected
      captured.execute = execute
    }
    start(): void {}
    notify(): void {}
    notifySelection(): void {}
    async dispose(): Promise<void> {}
  },
}))
vi.mock('../src/client/browser/BrowserController.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/client/browser/BrowserController.ts')>(),
  createBrowserControllers: vi.fn(),
}))

const url = 'https://example.test/page'
const tabId = 'selected' as TabId
const sessions: Context[] = []

async function boot() {
  const ctx = new Context()
  sessions.push(ctx)
  const registered: { name: string; inject?: (sessionId: string, actions: Parameters<BrowserInjected['rebind']>[0]) => BrowserInjected }[] = []
  const openTabs = createSnapshotStore<readonly { sessionId: string; tabId: TabId; kind: string }[]>([
    { sessionId: 'session', tabId, kind: 'browser' },
  ])
  const selected = createSnapshotStore<{ sessionId: string; tabId: TabId } | undefined>({ sessionId: 'session', tabId })
  const close = vi.fn((id: TabId) => { openTabs.set(openTabs.getSnapshot().filter(tab => tab.tabId !== id)) })
  const frame = { ...emptyBrowserFrame(), address: 'observed' as const, target: {
    kind: 'https' as const, url, title: 'Example' } }
  const face: BrowserInjected = {
    keyedHooks: { browserState: () => undefined },
    snapshot: vi.fn(() => ({ frame, restoreTarget: undefined, addressFailure: undefined, addressRevision: 0 })),
    inspect: vi.fn(async () => ({ url, title: 'Example', text: 'Approved text' })),
    frameOrigins: vi.fn(async () => ({ url, title: 'Example', origins: ['https://example.test'] })),
    locate: vi.fn(async () => ({ url, title: 'Example', count: 1, rows: [] })),
    screenshot: vi.fn(async () => ({ url, title: 'Example', base64: 'iVBORw0KGgo=', viewport: { width: 800, height: 600 } })),
    action: vi.fn(async () => ({ url, title: 'Example', performed: true as const })),
    dialog: vi.fn(async () => ({ url, title: 'Example', dialog: null })),
    pendingDialogUrl: vi.fn(() => undefined),
    handleDialog: vi.fn(async () => ({ url, title: 'Example', performed: true as const })),
    navigate: vi.fn(async () => ({ url, title: 'Example', performed: true as const })),
    navigateHistory: vi.fn(async () => ({ url, title: 'Example', performed: true as const })),
    mount: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}), rebind: vi.fn(), loadUrl: vi.fn(), restore: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), setSandbox: vi.fn(),
  }
  vi.mocked(createBrowserControllers).mockReturnValue(face)
  ctx.provide('sidebarRight', { openTabs, selected, close } as never)
  ctx.provide('sidebarRightTabs', { register: () => () => {} } as never)
  ctx.provide('slots', { inject: (_name: string, register: () => () => void) => register(),
    register: (options: {
      name: string
      inject?: (sessionId: string, actions: Parameters<BrowserInjected['rebind']>[0]) => BrowserInjected
    }) => {
      registered.push(options); return () => {}
    } } as never)
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} } as never)
  ctx.provide('workspaces', { list: createSnapshotStore({ phase: 'ready', items: [] }) } as never)
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, browser: {} })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const slot = registered.find(item => item.name === 'sidebar.right.pane.tab')
  expect(slot?.inject).toBeTypeOf('function')
  slot!.inject!('session', createBrowserStore().create('dispatch-test').actions)
  expect(captured.selected).toBeTypeOf('function')
  expect(captured.execute).toBeTypeOf('function')
  return { ctx, face, openTabs, selected, close, select: captured.selected!, execute: captured.execute! }
}

function command(op: Command['op'], args: Partial<Command['args']> = {}): Command {
  return { id: 'command', sessionId: 'session', tabId, op, expectedUrl: url,
    args: { approvedOrigin: 'https://example.test', ...args } }
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(ctx => ctx.fiber.dispose()))
  captured.selected = undefined
  captured.execute = undefined
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('reports only the active Browser tab and routes approved observations and navigation', async () => {
  const h = await boot()
  const current = h.select()
  expect(current).toMatchObject({ sessionId: 'session', tabId, observedUrl: url, controllerAvailable: true })
  expect(await h.execute(current!, command('inspect'), () => true)).toMatchObject({ text: 'Approved text' })
  expect(await h.execute(current!, command('frameOrigins'), () => true))
    .toMatchObject({ origins: ['https://example.test'] })
  const query = { method: 'getByRole' as const, value: 'button', exact: true }
  await h.execute(current!, command('locate', { query }), () => true)
  await h.execute(current!, command('screenshot', { fullPage: true,
    approvedFrameOrigins: ['https://example.test'] }), () => true)
  await h.execute(current!, command('dialog'), () => true)
  await h.execute(current!, command('dialogAction', { handle: 'dialog-id', decision: 'dismiss' }), () => true)
  await h.execute(current!, command('goto', { url: 'https://next.test/' }), () => true)
  await h.execute(current!, command('back'), () => true)
  await h.execute(current!, command('forward'), () => true)
  expect(h.face.locate).toHaveBeenCalledWith(tabId, url, query)
  expect(h.face.frameOrigins).toHaveBeenCalledWith(tabId, url)
  expect(h.face.screenshot).toHaveBeenCalledWith(tabId, url, undefined, true,
    ['https://example.test'])
  expect(h.face.handleDialog).toHaveBeenCalledWith(tabId, url, 'dialog-id', 'dismiss', undefined, expect.any(Function))
  expect(h.face.navigate).toHaveBeenCalledWith(tabId, url, 'https://next.test/', expect.any(Function))
  expect(h.face.navigateHistory).toHaveBeenCalledWith(tabId, url, 'back', expect.any(Function))
  expect(h.face.navigateHistory).toHaveBeenCalledWith(tabId, url, 'forward', expect.any(Function))
  h.selected.set(undefined)
  expect(h.select()).toBeNull()
  h.selected.set({ sessionId: 'session', tabId })
  h.openTabs.set([])
  expect(h.select()).toBeNull()
})

it('translates only fixed input actions for the selected tab', async () => {
  const h = await boot()
  const current = h.select()!
  const cases: readonly [Command['op'], Partial<Command['args']>, object][] = [
    ['click', { ref: 'button', button: 'right', count: 2 }, { op: 'click', ref: 'button', button: 'right', count: 2 }],
    ['click', { x: 10, y: 20 }, { op: 'click', x: 10, y: 20 }],
    ['drag', { x: 10, y: 20, to: { x: 30, y: 40 } }, { op: 'drag', x: 10, y: 20, to: { x: 30, y: 40 } }],
    ['key', { key: 'Enter', ref: 'button' }, { op: 'key', key: 'Enter', ref: 'button' }],
    ['paste', { text: 'hello', format: 'text' }, { op: 'paste', text: 'hello', format: 'text' }],
    ['type', { text: '你', sequential: true }, { op: 'type', text: '你', sequential: true }],
    ['setValue', { ref: 'input', value: 'Ada' }, { op: 'setValue', ref: 'input', value: 'Ada' }],
    ['selectOption', { ref: 'select', options: [{ value: 'blue' }] },
      { op: 'selectOption', ref: 'select', options: [{ value: 'blue' }] }],
    ['selectText', { ref: 'input', text: 'Ada', prefix: 'Hi', suffix: '!', selectionType: 'cursor_after' },
      { op: 'selectText', ref: 'input', text: 'Ada', prefix: 'Hi', suffix: '!', selectionType: 'cursor_after' }],
    ['secondary', { ref: 'button', action: 'focus' }, { op: 'secondary', ref: 'button', action: 'focus' }],
    ['scroll', { ref: 'page', dx: 0, dy: 100 }, { op: 'scroll', ref: 'page', dx: 0, dy: 100 }],
  ]
  for (const [op, args, action] of cases) {
    await h.execute(current, command(op, args), () => true)
    expect(h.face.action).toHaveBeenLastCalledWith(tabId, url, action, expect.any(Function))
  }
  await h.execute(current, command('close'), () => true)
  expect(h.close).toHaveBeenCalledWith(tabId)
  expect(h.openTabs.getSnapshot()).toEqual([])
})

it('never reports an unmounted or unready tab as an available page', async () => {
  const h = await boot()
  h.openTabs.set([{ sessionId: 'other', tabId, kind: 'browser' }])
  h.selected.set({ sessionId: 'other', tabId })
  expect(h.select()).toEqual({ sessionId: 'other', tabId, controllerAvailable: false })
  h.openTabs.set([{ sessionId: 'session', tabId, kind: 'browser' }])
  h.selected.set({ sessionId: 'session', tabId })
  vi.mocked(h.face.snapshot).mockReturnValueOnce({ frame: emptyBrowserFrame(),
    restoreTarget: undefined, addressFailure: undefined, addressRevision: 0 })
  expect(h.select()).toEqual({ sessionId: 'session', tabId, controllerAvailable: false })
  vi.mocked(h.face.pendingDialogUrl).mockReturnValueOnce(url)
  expect(h.select()).toMatchObject({ observedUrl: url, controllerAvailable: true })
})

it('refuses incomplete commands before any native input reaches the selected tab', async () => {
  const h = await boot()
  const current = h.select()!
  const missing: readonly [Command['op'], Partial<Command['args']>, string][] = [
    ['locate', {}, 'SIDEBAR_LOCATOR_UNAVAILABLE'],
    ['dialogAction', { handle: 'dialog-id' }, 'SIDEBAR_DIALOG_LEASE_UNAVAILABLE'],
    ['dialogAction', { decision: 'accept' }, 'SIDEBAR_DIALOG_LEASE_UNAVAILABLE'],
    ['goto', {}, 'SIDEBAR_URL_UNAVAILABLE'],
    ['click', { x: 10 }, 'SIDEBAR_POINT_UNAVAILABLE'],
    ['click', { y: 10 }, 'SIDEBAR_POINT_UNAVAILABLE'],
    ['drag', { x: 10, y: 20 }, 'SIDEBAR_DRAG_UNAVAILABLE'],
    ['drag', { y: 20, to: { x: 30, y: 40 } }, 'SIDEBAR_DRAG_UNAVAILABLE'],
    ['drag', { x: 10, to: { x: 30, y: 40 } }, 'SIDEBAR_DRAG_UNAVAILABLE'],
    ['key', {}, 'SIDEBAR_KEY_UNAVAILABLE'],
    ['paste', { text: 'hello' }, 'SIDEBAR_PASTE_UNAVAILABLE'],
    ['paste', { format: 'text' }, 'SIDEBAR_PASTE_UNAVAILABLE'],
    ['type', {}, 'SIDEBAR_INPUT_UNAVAILABLE'],
    ['setValue', {}, 'SIDEBAR_UNKNOWN_REF'],
    ['setValue', { ref: 'input' }, 'SIDEBAR_INPUT_UNAVAILABLE'],
    ['selectOption', { ref: 'select' }, 'SIDEBAR_OPTION_UNAVAILABLE'],
    ['selectText', { ref: 'input' }, 'SIDEBAR_SELECTION_UNAVAILABLE'],
    ['secondary', { ref: 'button' }, 'SIDEBAR_ACTION_UNAVAILABLE'],
    ['scroll', { ref: 'page', dx: 0 }, 'SIDEBAR_SCROLL_UNAVAILABLE'],
    ['scroll', { ref: 'page', dy: 100 }, 'SIDEBAR_SCROLL_UNAVAILABLE'],
  ]
  for (const [op, args, error] of missing) {
    expect(() => h.execute(current, command(op, args), () => true)).toThrow(error)
  }
  expect(h.face.action).not.toHaveBeenCalled()
  expect(() => h.execute({ ...current, sessionId: 'other' }, command('inspect'), () => true))
    .toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => h.execute(current, command('close'), () => false)).toThrow('SIDEBAR_SELECTION_CHANGED')
  h.close.mockImplementationOnce(() => {})
  expect(() => h.execute(current, command('close'), () => true)).toThrow('SIDEBAR_CLOSE_FAILED')
})

it('omits absent optional input fields rather than inventing them', async () => {
  const h = await boot()
  const current = h.select()!
  const cases: readonly [Command['op'], Partial<Command['args']>, object][] = [
    ['click', { ref: 'button' }, { op: 'click', ref: 'button' }],
    ['key', { key: 'Enter' }, { op: 'key', key: 'Enter' }],
    ['paste', { ref: 'input', text: 'hello', format: 'text' },
      { op: 'paste', ref: 'input', text: 'hello', format: 'text' }],
    ['type', { ref: 'input', text: 'Ada' }, { op: 'type', ref: 'input', text: 'Ada' }],
    ['selectText', { ref: 'input', text: 'Ada' }, { op: 'selectText', ref: 'input', text: 'Ada' }],
  ]
  for (const [op, args, action] of cases) {
    await h.execute(current, command(op, args), () => true)
    expect(h.face.action).toHaveBeenLastCalledWith(tabId, url, action, expect.any(Function))
  }
})
