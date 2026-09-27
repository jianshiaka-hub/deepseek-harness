import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'

const request = vi.hoisted(() => ({ handler: undefined as undefined | ((details: {
  url: string
  webContentsId: number
  resourceType: string
  method: string
}, callback: (answer: { cancel: boolean }) => void) => void) }))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  clipboard: { read: vi.fn(async () => []), write: vi.fn(async () => {}), clear: vi.fn() },
  ClipboardItem: vi.fn(),
  session: { fromPartition: () => ({
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(), setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn(), webRequest: { onBeforeRequest: (handler: typeof request.handler) => { request.handler = handler } },
  }) },
}))
const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')

const clientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const initialUrl = 'https://approved.test/start'

it('holds the first foreign redirect of a reserved blank occurrence before network delivery', () => {
  const owner = Object.assign(new EventEmitter(), { id: 17, isDestroyed: () => false,
    send: vi.fn<(channel: string, intent: { token: string }) => void>() })
  const contents = owner as Pick<WebContents, 'id' | 'isDestroyed' | 'send'> as WebContents
  const window = { webContents: contents } as BrowserWindow
  const guests = new DesktopBrowserGuests(() => undefined)
  guests.bind(window, () => () => {})
  guests.reserveBlankNavigationPreflight(contents, clientId,
    'session-a', 'tab-a', initialUrl)
  expect(() => { guests.acquire(contents, 'workspace-a', {
    sessionId: 'session-a', tabId: 'tab-a', initialUrl: 'https://different.test/' }) })
    .toThrow('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
  const reservation = guests.acquire(contents, 'workspace-a', {
    sessionId: 'session-a', tabId: 'tab-a', initialUrl })
  const guest = Object.assign(new EventEmitter(), { id: 42,
    getURL: () => `about:blank#${reservation.lease}`, isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(), close: vi.fn() })
  owner.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {
    src: `about:blank#${reservation.lease}`, partition: reservation.partition })
  owner.emit('did-attach-webview', {}, guest)
  guest.emit('dom-ready')
  const callback = vi.fn()
  request.handler!({ url: 'https://foreign.test/private', webContentsId: guest.id,
    resourceType: 'mainFrame', method: 'GET' }, callback)
  expect(callback).not.toHaveBeenCalled()
  const [channel, intent] = owner.send.mock.calls.at(-1)!
  expect(channel).toBe(DESKTOP_IPC.browserNavigationIntent)
  expect(intent).toMatchObject({ clientId, sessionId: 'session-a', tabId: 'tab-a',
    expectedUrl: 'about:blank', popupInitialUrl: initialUrl,
    targetUrl: 'https://foreign.test/private' })
  guests.resolveNavigationPreflight(contents, intent.token, false)
  expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
  guest.emit('destroyed')
})

it('cancels an unused blank reservation without arming a later guest', () => {
  const owner = Object.assign(new EventEmitter(), { id: 18, isDestroyed: () => false,
    send: vi.fn() })
  const contents = owner as Pick<WebContents, 'id' | 'isDestroyed' | 'send'> as WebContents
  const guests = new DesktopBrowserGuests(() => undefined)
  guests.reserveBlankNavigationPreflight(contents, clientId,
    'session-a', 'tab-a', initialUrl)
  guests.cancelBlankNavigationPreflight(contents, clientId,
    'session-a', 'tab-a', initialUrl)
  expect(() => { guests.reserveBlankNavigationPreflight(contents,
    clientId, 'session-a', 'tab-a', initialUrl) }).not.toThrow()
})
