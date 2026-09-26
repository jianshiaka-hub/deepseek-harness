import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { BrowserDialogLease } from '../src/browser-dialog.ts'

const url = 'https://example.test/page'

it('guest preload forwards only fixed dialog kinds and keeps page text inside the guest', () => {
  const source = readFileSync(new URL('../src/preload-browser-guest.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText
  const page: Record<string, unknown> = {}
  const sent: [string, ...unknown[]][] = []
  let decision: unknown = false
  const electron = {
    contextBridge: {
      exposeInMainWorld(name: string, value: unknown): void { page[name] = value },
      executeInMainWorld({ func }: { readonly func: () => void }): void {
        runInNewContext(`(${func.toString()})()`, { window: page })
      },
    },
    ipcRenderer: { sendSync(channel: string, ...args: unknown[]): unknown {
      sent.push([channel, ...args])
      return decision
    } },
  }
  runInNewContext(code, { require: (name: string) => name === 'electron' ? electron
    : { DESKTOP_IPC: { browserGuestPrompt: 'prompt', browserGuestDialog: 'dialog' } }, exports: {} })
  decision = true
  expect((page.confirm as (message: string) => boolean)('Private choice')).toBe(true)
  decision = false
  expect((page.confirm as (message: string) => boolean)('Different private choice')).toBe(false)
  const alert = page.alert as (message: string) => void
  alert('Private notice')
  decision = { useDefault: true }
  expect((page.prompt as (message: string, fallback: string) => string)('Private prompt', 'seed'))
    .toBe('seed')
  expect(sent).toEqual([['dialog', 'confirm'], ['dialog', 'confirm'], ['dialog', 'alert'], ['prompt']])
})

function fixture() {
  const guestEvents = new EventEmitter()
  const debuggerEvents = new EventEmitter()
  const state = { url, attached: false, destroyed: false, loading: false, failAttach: false }
  const sendCommand = vi.fn(async (method: string, _params?: object): Promise<object> =>
    method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'frame-prompt-script' } : {})
  const debuggerPort = Object.assign(debuggerEvents, {
    isAttached: () => state.attached,
    attach: vi.fn(() => {
      if (state.failAttach) throw new Error('debugger busy')
      state.attached = true
    }),
    detach: vi.fn(() => { state.attached = false; debuggerEvents.emit('detach', undefined, 'target_closed') }),
    sendCommand,
  })
  const guest = Object.assign(guestEvents, {
    debugger: debuggerPort,
    isDestroyed: () => state.destroyed,
    isLoadingMainFrame: () => state.loading,
    getURL: () => state.url,
  })
  const open = (type: string, source = url): void => {
    debuggerEvents.emit('message', undefined, 'Page.javascriptDialogOpening', { type, url: source, message: 'Private page text' })
  }
  return { guest, guestEvents, debuggerPort, state, sendCommand, open }
}

describe('one-document Sidebar JavaScript dialog lease', () => {
  it('holds only an approved native child-frame prompt and defaults other dialogs to dismissal', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const defaultHandler = vi.fn()
    h.guestEvents.on('-run-dialog', defaultHandler)
    const current: { token: string | undefined } = { token: undefined }
    const offered = vi.fn((source: string, type: 'alert' | 'confirm' | 'prompt',
      reply: (action: 'accept' | 'dismiss', text?: string) => void) =>
      current.token !== undefined && lease.offerNativeDialog(current.token, source, type, reply))
    expect(lease.installNativeDialogGuard(h.guest, offered)).toBe(true)
    expect(h.guestEvents.listenerCount('-run-dialog')).toBe(1)
    expect(lease.installNativeDialogGuard(h.guest, offered)).toBe(false)
    const idleReply = vi.fn()
    h.guestEvents.emit('-run-dialog', { frame: { url }, dialogType: 'confirm',
      messageText: 'Private idle dialog' }, idleReply)
    expect(idleReply).toHaveBeenCalledExactlyOnceWith(false, '')
    const token = await lease.begin(h.guest, url, ['https://example.test', 'https://foreign.test'])
    current.token = token
    h.open('prompt', 'https://foreign.test/frame')
    expect(lease.get(token)).toBeNull()
    expect(h.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false })
    const blocked = vi.fn()
    h.guestEvents.emit('-run-dialog', { frame: { url: 'https://unapproved.test/frame' },
      dialogType: 'confirm', messageText: 'Private denied dialog' }, blocked)
    expect(blocked).toHaveBeenCalledExactlyOnceWith(false, '')
    const reply = vi.fn()
    h.guestEvents.emit('-run-dialog', { frame: { url: 'https://foreign.test/frame' },
      dialogType: 'prompt', defaultPromptText: 'Seed', messageText: 'Private prompt' }, reply)
    expect(offered.mock.calls.at(-1)?.slice(0, 2)).toEqual(['https://foreign.test/frame', 'prompt'])
    const dialog = lease.get(token)
    expect(dialog?.type).toBe('prompt')
    await lease.handle(token, dialog!.id, 'accept')
    expect(reply).toHaveBeenCalledExactlyOnceWith(true, 'Seed')
    expect(defaultHandler).not.toHaveBeenCalled()
    const after = vi.fn()
    h.guestEvents.emit('-run-dialog', { frame: { url }, dialogType: 'alert' }, after)
    expect(after).toHaveBeenCalledExactlyOnceWith(false, '')
  })

  it('dismisses a native child-frame dialog canceled outside the agent', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    h.guestEvents.on('-run-dialog', vi.fn())
    const current: { token: string | undefined } = { token: undefined }
    expect(lease.installNativeDialogGuard(h.guest, (source, type, reply) =>
      current.token !== undefined && lease.offerNativeDialog(current.token, source, type, reply))).toBe(true)
    const token = await lease.begin(h.guest, url, ['https://example.test', 'https://foreign.test'])
    current.token = token
    const reply = vi.fn()
    h.guestEvents.emit('-run-dialog', { frame: { url: 'https://foreign.test/frame' },
      dialogType: 'prompt' }, reply)
    const dialog = lease.get(token)
    expect(dialog?.type).toBe('prompt')
    h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogClosed', {})
    expect(reply).toHaveBeenCalledExactlyOnceWith(false, '')
    expect(() => lease.get(token)).toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    await expect(lease.handle(token, dialog!.id, 'accept', 'late')).rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
  })

  it('captures a modal by opaque ID, accepts it once, and detaches from the guest', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const token = await lease.begin(h.guest, url)
    expect(h.sendCommand).toHaveBeenCalledWith('Page.enable')
    const injection = h.sendCommand.mock.calls.find(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')
    expect(JSON.stringify(injection?.[1])).toContain('https://example.test')
    expect(JSON.stringify(injection?.[1])).toContain('top.confirm(message)')
    expect(JSON.stringify(injection?.[1])).toContain('top.alert(message)')
    expect(injection?.[1]).toHaveProperty('runImmediately', true)
    expect(lease.get(token)).toBeNull()
    const opened = lease.wait(token)
    h.open('confirm')
    const dialog = await opened
    expect(dialog?.type).toBe('confirm')
    expect(dialog?.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(lease.get(token)).toEqual(dialog)
    await lease.handle(token, dialog!.id, 'accept')
    expect(h.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(h.state.attached).toBe(false)
    expect(h.sendCommand).toHaveBeenCalledWith('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: 'frame-prompt-script',
    })
    expect(() => lease.get(token)).toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    await expect(lease.handle(token, dialog!.id, 'accept')).rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
  })

  it('dismisses an unapproved frame without exposing its dialog and protects the debugger lease', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const token = await lease.begin(h.guest, url)
    await expect(lease.begin(h.guest, url)).rejects.toThrow('SIDEBAR_DIALOG_BUSY')
    h.open('alert', 'https://foreign.test/frame')
    expect(lease.get(token)).toBeNull()
    await vi.waitFor(() => {
      expect(h.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false })
    })
    h.open('alert', 'https://example.test/frame')
    expect(lease.get(token)?.type).toBe('alert')
    expect(lease.get(token)?.id).toMatch(/^[a-f0-9-]{36}$/)
    await lease.close(token)
    expect(h.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false })
    expect(h.state.attached).toBe(false)
  })

  it('invalidates an opaque handle when Chromium closes its dialog before agent confirmation', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const token = await lease.begin(h.guest, url)
    h.open('confirm')
    const dialog = lease.get(token)
    expect(dialog?.type).toBe('confirm')
    h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogClosed', { result: false })
    expect(lease.get(token)).toBeNull()
    await expect(lease.handle(token, dialog!.id, 'accept'))
      .rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    await lease.close(token)
    expect(h.state.attached).toBe(false)
  })

  it('captures beforeunload after a navigation enters loading but before its URL commits', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const token = await lease.begin(h.guest, url)
    h.state.loading = true
    h.open('beforeunload')
    const dialog = lease.get(token)
    expect(dialog?.type).toBe('beforeunload')
    await lease.handle(token, dialog!.id, 'dismiss')
    expect(h.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false })
    expect(h.state.attached).toBe(false)
  })

  it('holds a same-origin sandboxed prompt and returns only its answer after handle approval', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const token = await lease.begin(h.guest, url)
    const reply = vi.fn()
    expect(lease.offerPrompt(token, 'https://foreign.test/frame', reply)).toBe(false)
    expect(reply).not.toHaveBeenCalled()
    const waiting = lease.wait(token)
    expect(lease.offerPrompt(token, 'https://example.test/frame', reply)).toBe(true)
    const dialog = await waiting
    expect(dialog?.type).toBe('prompt')
    expect(dialog?.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(lease.offerPrompt(token, url, vi.fn())).toBe(false)
    await expect(lease.handle(token, dialog!.id, 'accept', 'private answer')).resolves.toBeUndefined()
    expect(reply).toHaveBeenCalledExactlyOnceWith('private answer')
    expect(h.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', expect.anything())
    expect(h.state.attached).toBe(false)
  })

  it('holds guest confirm and alert until their one-use handles are answered', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const confirmToken = await lease.begin(h.guest, url)
    const confirmed = vi.fn()
    expect(lease.offerGuestDialog(confirmToken, 'https://foreign.test/frame', 'confirm', confirmed)).toBe(false)
    expect(lease.offerGuestDialog(confirmToken, url, 'confirm', confirmed)).toBe(true)
    const confirm = lease.get(confirmToken)!
    expect(confirm.type).toBe('confirm')
    expect(JSON.stringify(confirm)).not.toContain('Private page text')
    await lease.handle(confirmToken, confirm.id, 'accept')
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(true)
    expect(h.sendCommand).not.toHaveBeenCalledWith('Page.handleJavaScriptDialog', expect.anything())
    const dismissToken = await lease.begin(h.guest, url)
    const dismissed = vi.fn()
    expect(lease.offerGuestDialog(dismissToken, url, 'confirm', dismissed)).toBe(true)
    await lease.handle(dismissToken, lease.get(dismissToken)!.id, 'dismiss')
    expect(dismissed).toHaveBeenCalledExactlyOnceWith(false)
    const alertToken = await lease.begin(h.guest, url)
    const alerted = vi.fn()
    expect(lease.offerGuestDialog(alertToken, url, 'alert', alerted)).toBe(true)
    await lease.handle(alertToken, lease.get(alertToken)!.id, 'accept')
    expect(alerted).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(h.state.attached).toBe(false)
  })

  it('releases blocked guest dialogs on lease close without accepting them', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const confirmToken = await lease.begin(h.guest, url)
    const confirmed = vi.fn()
    expect(lease.offerGuestDialog(confirmToken, url, 'confirm', confirmed)).toBe(true)
    await lease.close(confirmToken)
    expect(confirmed).toHaveBeenCalledExactlyOnceWith(false)
    const alertToken = await lease.begin(h.guest, url)
    const alerted = vi.fn()
    expect(lease.offerGuestDialog(alertToken, url, 'alert', alerted)).toBe(true)
    await lease.close(alertToken)
    expect(alerted).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('binds a foreign prompt only to a current exact-origin grant', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    await expect(lease.begin(h.guest, url, ['https://foreign.test']))
      .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    await expect(lease.begin(h.guest, url, ['https://example.test', 'https://foreign.test/path']))
      .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    const token = await lease.begin(h.guest, url,
      ['https://example.test', 'https://foreign.test'])
    const blocked = vi.fn()
    expect(lease.offerPrompt(token, 'https://unapproved.test/frame', blocked)).toBe(false)
    expect(blocked).not.toHaveBeenCalled()
    h.open('confirm', 'https://unapproved.test/frame')
    expect(lease.get(token)).toBeNull()
    const reply = vi.fn()
    expect(lease.offerPrompt(token, 'https://foreign.test/frame', reply)).toBe(true)
    const dialog = lease.get(token)
    expect(dialog?.type).toBe('prompt')
    await lease.handle(token, dialog!.id, 'accept', 'approved answer')
    expect(reply).toHaveBeenCalledExactlyOnceWith('approved answer')
    expect(h.state.attached).toBe(false)
  })

  it('offers a foreign beforeunload only with its exact site grant', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    h.guestEvents.on('-run-dialog', vi.fn())
    expect(lease.installNativeDialogGuard(h.guest, () => false)).toBe(true)
    const denied = await lease.begin(h.guest, url)
    h.open('beforeunload', 'https://foreign.test/frame')
    expect(lease.get(denied)).toBeNull()
    expect(h.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: false })
    await lease.close(denied)
    const approved = await lease.begin(h.guest, url,
      ['https://example.test', 'https://foreign.test'])
    h.open('beforeunload', 'https://foreign.test/frame')
    const dialog = lease.get(approved)
    expect(dialog?.type).toBe('beforeunload')
    expect(JSON.stringify(dialog)).not.toContain('Private page text')
    await lease.handle(approved, dialog!.id, 'accept')
    expect(h.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(h.state.attached).toBe(false)
  })

  it('replays only an approved same-document foreign navigation after one-use beforeunload acceptance', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const source = 'https://foreign.test/frame'
    const destination = 'https://foreign.test/next'
    const frameId = 'foreign-frame'
    const tree = () => ({ frameTree: { frame: { id: 'top', url, loaderId: 'top-loader' },
      childFrames: [{ frame: { id: frameId, url: source, loaderId: 'foreign-loader' } }] } })
    h.sendCommand.mockImplementation(async (method: string, params?: object): Promise<object> => {
      if (method === 'Page.getFrameTree') return tree()
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'frame-prompt-script' }
      if (method === 'Page.navigate') {
        queueMicrotask(() => { h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogOpening',
          { type: 'beforeunload', url: source, frameId }) })
        return { frameId }
      }
      if (method === 'Page.handleJavaScriptDialog' && (params as { accept?: boolean })?.accept) {
        queueMicrotask(() => {
          h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogClosed', { frameId, result: true })
          h.debuggerPort.emit('message', undefined, 'Page.frameNavigated',
            { frame: { id: frameId, url: destination } })
        })
      }
      return {}
    })
    const offer = async (): Promise<{ token: string; id: string }> => {
      const token = await lease.begin(h.guest, url,
        ['https://example.test', 'https://foreign.test'])
      h.debuggerPort.emit('message', undefined, 'Page.frameRequestedNavigation',
        { disposition: 'currentTab', reason: 'scriptInitiated', frameId, url: destination })
      h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogOpening',
        { type: 'beforeunload', url: source, frameId })
      const dialog = lease.get(token)!
      h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogClosed', { frameId, result: false })
      expect(lease.get(token)).toEqual(dialog)
      return { token, id: dialog.id }
    }
    const dismissed = await offer()
    await expect(lease.handle(dismissed.token, dismissed.id, 'dismiss')).resolves.toBe(true)
    expect(h.sendCommand).not.toHaveBeenCalledWith('Page.navigate', expect.anything())
    const accepted = await offer()
    await expect(lease.handle(accepted.token, accepted.id, 'accept')).resolves.toBe(true)
    expect(h.sendCommand).toHaveBeenCalledWith('Page.navigate', { frameId, url: destination })
    expect(h.sendCommand).toHaveBeenCalledWith('Page.handleJavaScriptDialog', { accept: true })
    expect(h.state.attached).toBe(false)
  })

  it('rejects a replay when its original foreign document has changed', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const source = 'https://foreign.test/frame'
    const frameId = 'foreign-frame'
    let loaderId = 'original-loader'
    h.sendCommand.mockImplementation(async (method: string): Promise<object> => {
      if (method === 'Page.getFrameTree') return { frameTree: {
        frame: { id: 'top', url, loaderId: 'top-loader' },
        childFrames: [{ frame: { id: frameId, url: source, loaderId } }],
      } }
      return method === 'Page.addScriptToEvaluateOnNewDocument'
        ? { identifier: 'frame-prompt-script' } : {}
    })
    const token = await lease.begin(h.guest, url,
      ['https://example.test', 'https://foreign.test'])
    h.debuggerPort.emit('message', undefined, 'Page.frameRequestedNavigation',
      { disposition: 'currentTab', reason: 'scriptInitiated', frameId,
        url: 'https://foreign.test/next' })
    h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogOpening',
      { type: 'beforeunload', url: source, frameId })
    const dialog = lease.get(token)!
    h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogClosed', { frameId, result: false })
    loaderId = 'replacement-loader'
    await expect(lease.handle(token, dialog.id, 'accept')).rejects.toThrow('SIDEBAR_NAVIGATED')
    expect(h.sendCommand).not.toHaveBeenCalledWith('Page.navigate', expect.anything())
  })

  it('does not replay an iframe unload toward another origin even when that origin is approved', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const source = 'https://foreign.test/frame'
    const frameId = 'foreign-frame'
    h.sendCommand.mockImplementation(async (method: string): Promise<object> =>
      method === 'Page.getFrameTree' ? { frameTree: {
        frame: { id: 'top', url, loaderId: 'top-loader' },
        childFrames: [{ frame: { id: frameId, url: source, loaderId: 'foreign-loader' } }],
      } } : method === 'Page.addScriptToEvaluateOnNewDocument'
        ? { identifier: 'frame-prompt-script' } : {})
    const token = await lease.begin(h.guest, url,
      ['https://example.test', 'https://foreign.test', 'https://other.test'])
    h.debuggerPort.emit('message', undefined, 'Page.frameRequestedNavigation',
      { disposition: 'currentTab', reason: 'scriptInitiated', frameId,
        url: 'https://other.test/next' })
    h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogOpening',
      { type: 'beforeunload', url: source, frameId })
    const dialog = lease.get(token)!
    h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogClosed', { frameId, result: false })
    expect(lease.get(token)).toBeNull()
    await expect(lease.handle(token, dialog.id, 'accept'))
      .rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    await lease.close(token)
    expect(h.sendCommand).not.toHaveBeenCalledWith('Page.navigate', expect.anything())
  })

  it('returns null to a blocked prompt when its lease closes or it is dismissed', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const first = await lease.begin(h.guest, url)
    const cancelled = vi.fn()
    expect(lease.offerPrompt(first, url, cancelled)).toBe(true)
    await lease.close(first)
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(null)
    const second = await lease.begin(h.guest, url)
    const dismissed = vi.fn()
    expect(lease.offerPrompt(second, url, dismissed)).toBe(true)
    const dialog = lease.get(second)!
    await lease.handle(second, dialog.id, 'dismiss')
    expect(dismissed).toHaveBeenCalledExactlyOnceWith(null)
    const third = await lease.begin(h.guest, url)
    const defaulted = vi.fn()
    expect(lease.offerPrompt(third, url, defaulted)).toBe(true)
    await lease.handle(third, lease.get(third)!.id, 'accept')
    expect(defaulted).toHaveBeenCalledExactlyOnceWith({ useDefault: true })
    const destroyed = await lease.begin(h.guest, url)
    expect(lease.offerPrompt(destroyed, url, () => { throw new Error('renderer disappeared') })).toBe(true)
    await expect(lease.close(destroyed)).resolves.toBeUndefined()
    expect(h.state.attached).toBe(false)
  })

  it('rejects stale navigation, wrong handles and invented prompt text', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const token = await lease.begin(h.guest, url)
    h.open('confirm')
    const dialog = lease.get(token)!
    await expect(lease.handle(token, 'wrong', 'accept')).rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    await expect(lease.handle(token, dialog.id, 'accept', 'secret')).rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    h.state.url = 'https://example.test/next'
    h.guestEvents.emit('did-navigate')
    await vi.waitFor(() => { expect(h.state.attached).toBe(false) })
    expect(() => lease.get(token)).toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
  })

  it('unblocks waiters and releases resources on early close and failed attach', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    h.state.failAttach = true
    await expect(lease.begin(h.guest, url)).rejects.toThrow('debugger busy')
    h.state.failAttach = false
    const token = await lease.begin(h.guest, url)
    const pending = lease.wait(token)
    await lease.close(token)
    expect(await pending).toBeNull()
    expect(h.state.attached).toBe(false)
    await expect(lease.begin(h.guest, url)).resolves.toEqual(expect.any(String))
  })
})
