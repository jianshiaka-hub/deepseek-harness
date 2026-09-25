/** Native webview events controlled by each test; presentation and navigation stay real. */
import { vi } from 'vitest'
import type { BrowserForeignText, BrowserJsDialog, DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserReservation } from '../src/types.ts'
import type { BrowserTabState } from '../src/client/browser/BrowserPersistence.ts'
import { createElectronPage } from '../src/client/electron/pages.ts'
import { ElectronWebviewPresentation } from '../src/client/electron/ElectronWebviewPresentation.ts'

let sequence = 0

/** @returns one isolated, explicitly mounted page with native operations replaced by spies. */
export function electronFixture(initial?: BrowserTabState) {
  const opens = new Set<(url: string) => void>()
  const reservation: DesktopBrowserReservation = { lease: `lease-${++sequence}` as DesktopBrowserLeaseId, partition: 'partition' }
  const frameAudit = { origins: ['https://example.test'], fingerprint: 'frame-1' }
  const bridge = {
    acquire: vi.fn(async (_workspace: string) => reservation),
    release: vi.fn(async (_lease: DesktopBrowserLeaseId) => {}),
    auditFrames: vi.fn(async (_lease: DesktopBrowserLeaseId, _url: string, approved?: readonly string[]) => {
      if (approved !== undefined && frameAudit.origins.some(origin => !approved.includes(origin))) {
        throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
      }
      return { origins: [...frameAudit.origins], fingerprint: frameAudit.fingerprint }
    }),
    inspectForeignText: vi.fn(async (_lease: DesktopBrowserLeaseId, _url: string): Promise<BrowserForeignText> => ({
      fingerprint: frameAudit.fingerprint, frames: [],
    })),
    locateForeign: vi.fn(async () => { throw new Error('not used in this harness') }),
    foreignRefPoint: vi.fn(async () => { throw new Error('not used in this harness') }),
    foreignInputState: vi.fn(async () => { throw new Error('not used in this harness') }),
    selectForeignOption: vi.fn(async () => { throw new Error('not used in this harness') }),
    captureViewport: vi.fn(async (_lease: DesktopBrowserLeaseId, _url: string) => ({
      url: 'https://example.test/', title: 'Example', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      viewport: { width: 1, height: 1 },
    })),
    captureFullPage: vi.fn(async (_lease: DesktopBrowserLeaseId, _url: string) => ({
      url: 'https://example.test/', title: 'Example', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      viewport: { width: 1, height: 1 },
    })),
    beginPaste: vi.fn(async (_lease: DesktopBrowserLeaseId, _url: string,
      _payload: { readonly text: string; readonly format: 'text' | 'md' | 'html'; readonly plainText?: string }) => 'paste-lease'),
    finishPaste: vi.fn(async (_lease: DesktopBrowserLeaseId, _token: string) =>
      ({ restored: true, superseded: false })),
    beginDrag: vi.fn(async (_lease: DesktopBrowserLeaseId, _url: string) => 'drag-lease'),
    finishDrag: vi.fn(async (_lease: DesktopBrowserLeaseId, _token: string,
      _point?: { readonly x: number; readonly y: number }) => ({ dropped: true })),
    beginDialog: vi.fn(async (_lease: DesktopBrowserLeaseId, _url: string) => 'dialog-lease'),
    navigate: vi.fn(async (_lease: DesktopBrowserLeaseId, _token: string, _url: string,
      _method: 'goto' | 'back' | 'forward', _destination?: string) => {}),
    getDialog: vi.fn(async (_lease: DesktopBrowserLeaseId, _token: string): Promise<BrowserJsDialog | null> => null),
    waitDialog: vi.fn(async (_lease: DesktopBrowserLeaseId, _token: string,
      _timeoutMs?: number): Promise<BrowserJsDialog | null> => null),
    handleDialog: vi.fn(async (_lease: DesktopBrowserLeaseId, _token: string, _dialogId: string,
      _action: 'accept' | 'dismiss', _text?: string) => {}),
    finishDialog: vi.fn(async (_lease: DesktopBrowserLeaseId, _token: string) => {}),
    onOpenRequested: vi.fn((_lease: DesktopBrowserLeaseId, listener: (url: string) => void) => {
      opens.add(listener)
      return () => { opens.delete(listener) }
    }),
  } satisfies DesktopBrowserBridge
  const workspace = vi.fn(async (_signal: AbortSignal) => 'cwd:/workspace')
  const persist = vi.fn()
  const openRequested = vi.fn()
  const page = createElectronPage({ initial, persist, openRequested }, bridge, workspace)
  const presentation = page.presentation
  if (!(presentation instanceof ElectronWebviewPresentation)) throw new Error('expected the Electron presentation')
  const create = presentation.createElement.bind(presentation)
  const guests: ReturnType<typeof prepareGuest>[] = []
  function prepareGuest(approved: DesktopBrowserReservation) {
    const element = create(approved)
    const state = { url: 'about:blank', title: '', loading: true, back: false, forward: false }
    const methods = {
      loadURL: vi.fn(async (_url: string) => {}), getURL: vi.fn(() => state.url), getTitle: vi.fn(() => state.title),
      canGoBack: () => state.back, canGoForward: () => state.forward, clearHistory: vi.fn(),
      goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => state.loading,
    }
    Object.assign(element, methods)
    const emit = (type: string, fields: object = {}): void => { element.dispatchEvent(Object.assign(new Event(type), fields)) }
    return { element, state, emit, ...methods }
  }
  const createElement = vi.spyOn(presentation, 'createElement').mockImplementation((approved) => {
    const guest = prepareGuest(approved)
    guests.push(guest)
    return guest.element
  })
  const host = document.createElement('div')
  host.id = `electron-fixture-${sequence}`
  document.body.append(host)
  return {
    ...page, presentation, bridge, frameAudit, workspace, persist, openRequested, opens, guests, host, reservation,
    mount: () => presentation.mount(host.id),
    async guest() {
      await vi.waitFor(() => { expectGuest() })
      return guests.at(-1)!
    },
    async dispose() {
      await page.frame.dispose()
      createElement.mockRestore()
      host.remove()
    },
  }
  function expectGuest(): void {
    if (host.firstElementChild === null || guests.length === 0) throw new Error('guest has not attached')
  }
}
