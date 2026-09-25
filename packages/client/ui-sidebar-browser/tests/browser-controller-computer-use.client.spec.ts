// @vitest-environment jsdom
/* oxlint-disable typescript/unbound-method -- The referenced frame methods are stateless Vitest spies and SnapshotStore callbacks. */
import { afterEach, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { BrowserController, createBrowserControllers } from '../src/client/browser/BrowserController.ts'
import { emptyBrowserFrame, type BrowserFrame, type BrowserFrameState, type BrowserLocateQuery } from '../src/client/browser/BrowserFrame.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'

const tabId = 'selected-browser' as TabId
const otherId = 'unselected-browser' as TabId
const url = 'https://example.test/'
const query: BrowserLocateQuery = { method: 'getByRole', value: 'button', exact: true }
const click = { op: 'click', ref: 'observed-button' } as const
const selected = (): boolean => true
const lifetimes: AbortController[] = []
const disposables: { dispose(): Promise<void> }[] = []

function fixture(native = true) {
  const lifetime = new AbortController()
  lifetimes.push(lifetime)
  const state = createSnapshotStore<BrowserFrameState>({ ...emptyBrowserFrame(), address: 'observed',
    target: { kind: 'https' as const, url, title: 'Example' }, canGoBack: true, canGoForward: true })
  const frame: BrowserFrame = {
    getSnapshot: () => state.getSnapshot(),
    subscribe: listener => state.subscribe(listener),
    loadUrl: vi.fn(), goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), dispose: vi.fn(async () => {}),
    ...native ? {
      inspect: vi.fn(async () => ({ url, title: 'Example', text: 'Allowed text' })),
      locate: vi.fn(async () => ({ url, title: 'Example', count: 1, rows: [{ ref: 'observed-button', role: 'button', name: 'Go' }] })),
      screenshot: vi.fn(async () => ({ url, title: 'Example', base64: 'iVBORw0KGgo=', viewport: { width: 800, height: 600 } })),
      action: vi.fn(async () => ({ url, title: 'Example', performed: true as const })),
      actionWithDialog: vi.fn(async () => ({ url, title: 'Example', performed: true as const })),
      pendingDialogUrl: vi.fn(() => url),
      dialog: vi.fn(async () => ({ url, title: 'Example', dialog: { id: 'dialog-id', type: 'alert' as const } })),
      handleDialog: vi.fn(async () => ({ url, title: 'Example', performed: true as const })),
    } : {},
  }
  const createPage = () => ({ frame, presentation: { mount: () => () => {} } })
  const actions = createBrowserStore().create('computer-use-controller').actions
  const controller = new BrowserController({ tabId, signal: lifetime.signal, applicationOrigin: 'https://dsh.example',
    initial: undefined, actions, createPage, openTab: vi.fn() })
  disposables.push(controller)
  return { controller, frame, state, lifetime, createPage, actions }
}

afterEach(async () => {
  await Promise.all(disposables.splice(0).map(value => value.dispose()))
  for (const lifetime of lifetimes.splice(0)) lifetime.abort()
  vi.restoreAllMocks()
})

it('delegates approved observations and actions only to the selected desktop page', async () => {
  const { controller, frame } = fixture()
  expect(await controller.inspect(url)).toEqual({ url, title: 'Example', text: 'Allowed text' })
  expect(await controller.locate(url, query)).toMatchObject({ count: 1, rows: [{ ref: 'observed-button' }] })
  const clip = { x: 1, y: 2, width: 30, height: 40 }
  expect(await controller.screenshot(url, clip, true)).toMatchObject({ viewport: { width: 800 } })
  expect(frame.screenshot).toHaveBeenCalledWith(url, clip, true)
  expect(await controller.action(url, click)).toMatchObject({ performed: true })
  expect(frame.actionWithDialog).toHaveBeenCalledWith(url, click, expect.any(Function))
  expect(vi.mocked(frame.actionWithDialog!).mock.calls[0]?.[2]?.()).toBe(true)
  expect(controller.pendingDialogUrl()).toBe(url)
  expect(await controller.dialog(url, selected)).toMatchObject({ dialog: { type: 'alert' } })
  expect(await controller.handleDialog(url, 'dialog-id', 'accept', undefined, selected)).toMatchObject({ performed: true })
  expect(await controller.navigate(url, 'https://next.test/', selected)).toMatchObject({ performed: true })
  expect(frame.actionWithDialog).toHaveBeenCalledWith(url,
    { op: 'navigate', method: 'goto', url: 'https://next.test/' }, selected)
  expect(await controller.navigateHistory(url, 'back', selected)).toMatchObject({ performed: true })
  expect(await controller.navigateHistory(url, 'forward', selected)).toMatchObject({ performed: true })
  expect(frame.actionWithDialog).toHaveBeenCalledWith(url, { op: 'navigate', method: 'back' }, selected)
  expect(frame.actionWithDialog).toHaveBeenCalledWith(url, { op: 'navigate', method: 'forward' }, selected)
  expect(() => controller.navigate(url, 'file:///private', selected)).toThrow('SIDEBAR_URL_UNAVAILABLE')
  expect(() => controller.navigate(url, 'https://next.test/#', selected)).not.toThrow()
})

it('rejects missing native capabilities and invalidates a disposed tab occurrence', async () => {
  const { controller } = fixture(false)
  expect(() => controller.inspect(url)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => controller.locate(url, query)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => controller.screenshot(url)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => controller.action(url, click)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => controller.dialog(url, selected)).toThrow('SIDEBAR_DIALOG_UNAVAILABLE')
  expect(() => controller.handleDialog(url, 'dialog-id', 'accept', undefined, selected)).toThrow('SIDEBAR_DIALOG_UNAVAILABLE')
  expect(controller.pendingDialogUrl()).toBeUndefined()
  await controller.dispose()
  expect(() => controller.inspect(url)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(controller.pendingDialogUrl()).toBeUndefined()
})

it('does not expose a controller for an unselected tab ID', async () => {
  const { createPage, actions, lifetime } = fixture()
  const changed = vi.fn()
  const face = createBrowserControllers(actions, createPage, () => true, changed)
  disposables.push(face)
  expect(face.snapshot(otherId)).toBeUndefined()
  expect(face.pendingDialogUrl(otherId)).toBeUndefined()
  expect(() => face.inspect(otherId, url)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => face.locate(otherId, url, query)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => face.screenshot(otherId, url)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => face.action(otherId, url, click, selected)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => face.dialog(otherId, url, selected)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => face.handleDialog(otherId, url, 'dialog-id', 'dismiss', undefined, selected))
    .toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => face.navigate(otherId, url, 'https://next.test/', selected)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => face.navigateHistory(otherId, url, 'back', selected)).toThrow('SIDEBAR_TAB_UNAVAILABLE')
  face.mount({ tabId, signal: lifetime.signal, viewportId: 'fixture', applicationOrigin: 'https://dsh.example',
    initial: undefined, initialUrl: undefined, openTab: vi.fn() })
  expect(face.snapshot(tabId)?.frame.target?.url).toBe(url)
  expect(await face.inspect(tabId, url)).toMatchObject({ text: 'Allowed text' })
  expect(await face.locate(tabId, url, query)).toMatchObject({ count: 1 })
  expect(await face.screenshot(tabId, url)).toMatchObject({ viewport: { width: 800 } })
  expect(await face.action(tabId, url, click, selected)).toMatchObject({ performed: true })
  expect(await face.dialog(tabId, url, selected)).toMatchObject({ dialog: { type: 'alert' } })
  expect(face.pendingDialogUrl(tabId)).toBe(url)
  expect(await face.handleDialog(tabId, url, 'dialog-id', 'dismiss', undefined, selected)).toMatchObject({ performed: true })
  expect(await face.navigate(tabId, url, 'https://next.test/', selected)).toMatchObject({ performed: true })
  expect(await face.navigateHistory(tabId, url, 'back', selected)).toMatchObject({ performed: true })
  lifetime.abort()
  expect(face.snapshot(tabId)).toBeUndefined()
  expect(face.pendingDialogUrl(tabId)).toBeUndefined()
  expect(changed).toHaveBeenCalled()
})

it('waits for a committed destination before exposing legacy carrier navigation', async () => {
  const { controller, frame, state } = fixture()
  Object.assign(frame, { actionWithDialog: undefined })
  let lateNotification = (): void => {}
  const subscribe = controller.subscribe
  controller.subscribe = (listener) => { lateNotification = listener; return subscribe(listener) }
  expect(await controller.action(url, click, selected)).toMatchObject({ performed: true })
  expect(frame.action).toHaveBeenCalledWith(url, click, selected)

  const navigation = controller.navigate(url, 'https://next.test/', selected)
  expect(frame.loadUrl).toHaveBeenCalledWith({ kind: 'https', url: 'https://next.test/', title: 'next.test' })
  state.set({ ...state.getSnapshot(), address: 'requested', loading: true })
  let delivered = false
  void navigation.then(() => { delivered = true })
  expect(delivered).toBe(false)
  state.set({ ...state.getSnapshot(), address: 'observed', loading: false,
    target: { kind: 'https', url: 'https://redirect.test/', title: 'Redirected' } })
  await expect(navigation).resolves.toEqual({ url: 'https://redirect.test/', title: 'Redirected', performed: true })
  lateNotification()

  const back = controller.navigateHistory('https://redirect.test/', 'back', selected)
  expect(frame.goBack).toHaveBeenCalledOnce()
  state.set({ ...state.getSnapshot(), address: 'requested', loading: true })
  state.set({ ...state.getSnapshot(), address: 'observed', loading: false,
    target: { kind: 'https', url, title: 'Example' } })
  await expect(back).resolves.toMatchObject({ url })
  const forward = controller.navigateHistory(url, 'forward', selected)
  expect(frame.goForward).toHaveBeenCalledOnce()
  state.set({ ...state.getSnapshot(), address: 'requested', loading: true })
  state.set({ ...state.getSnapshot(), address: 'observed', loading: false,
    target: { kind: 'https', url: 'https://redirect.test/', title: 'Redirected' } })
  await expect(forward).resolves.toMatchObject({ url: 'https://redirect.test/' })
})

it('rejects a changed tab, failed page and aborted legacy navigation without releasing page data', async () => {
  const { controller, frame, state, lifetime } = fixture()
  Object.assign(frame, { actionWithDialog: undefined })
  expect(() => controller.navigate('https://wrong.test/', 'https://next.test/', selected))
    .toThrow('SIDEBAR_TAB_UNAVAILABLE')
  expect(() => controller.navigate(url, 'https://next.test/', () => false))
    .toThrow('SIDEBAR_TAB_UNAVAILABLE')
  state.set({ ...state.getSnapshot(), loading: true })
  expect(() => controller.navigate(url, 'https://next.test/', selected))
    .toThrow('SIDEBAR_TAB_UNAVAILABLE')
  state.set({ ...state.getSnapshot(), loading: false })

  let stillSelected = true
  const switched = controller.navigate(url, 'https://next.test/', () => stillSelected)
  stillSelected = false
  state.set({ ...state.getSnapshot(), address: 'requested', loading: true })
  await expect(switched).rejects.toThrow('SIDEBAR_SELECTION_CHANGED')
  state.set({ ...state.getSnapshot(), address: 'observed', loading: false })

  const failed = controller.navigate(url, 'https://next.test/', selected)
  state.set({ ...state.getSnapshot(), error: { code: -1, description: 'load failed' } })
  await expect(failed).rejects.toThrow('SIDEBAR_NAVIGATION_FAILED')
  state.set({ ...state.getSnapshot(), error: undefined })

  const aborted = controller.navigate(url, 'https://next.test/', selected)
  lifetime.abort()
  await expect(aborted).rejects.toThrow('SIDEBAR_TAB_UNAVAILABLE')
})

it('fails a legacy navigation on unknown state, invalid address or provider error', async () => {
  const { controller, frame, state } = fixture()
  Object.assign(frame, { actionWithDialog: undefined })
  const unknown = controller.navigate(url, 'https://next.test/', selected)
  state.set({ ...state.getSnapshot(), address: 'unknown', loading: false })
  await expect(unknown).rejects.toThrow('SIDEBAR_NAVIGATION_FAILED')
  state.set({ ...state.getSnapshot(), address: 'observed' })

  const invalid = controller.navigate(url, 'https://next.test/', selected)
  controller.loadUrl('file:///private')
  await expect(invalid).rejects.toThrow('SIDEBAR_NAVIGATION_FAILED')

  vi.mocked(frame.loadUrl).mockImplementationOnce(() => { throw new Error('provider navigation failed') })
  await expect(controller.navigate(url, 'https://next.test/', selected)).rejects.toThrow('provider navigation failed')
  vi.mocked(frame.loadUrl).mockImplementationOnce(() => {
    throw 'unexpected provider failure'
  })
  await expect(controller.navigate(url, 'https://next.test/', selected)).rejects.toThrow('SIDEBAR_NAVIGATION_FAILED')
})

it('times out a legacy navigation when the provider never reports a destination', async () => {
  const { controller, frame } = fixture()
  Object.assign(frame, { actionWithDialog: undefined })
  vi.useFakeTimers()
  try {
    const navigation = controller.navigate(url, 'https://next.test/', selected)
    const refusal = expect(navigation).rejects.toThrow('SIDEBAR_NAVIGATION_TIMEOUT')
    await vi.advanceTimersByTimeAsync(12_000)
    await refusal
  } finally { vi.useRealTimers() }
})
