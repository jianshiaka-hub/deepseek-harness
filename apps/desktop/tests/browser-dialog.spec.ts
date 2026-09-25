import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserDialogLease } from '../src/browser-dialog.ts'

const url = 'https://example.test/page'

function fixture() {
  const guestEvents = new EventEmitter()
  const debuggerEvents = new EventEmitter()
  const state = { url, attached: false, destroyed: false, loading: false, failAttach: false }
  const sendCommand = vi.fn(async (_method: string, _params?: object): Promise<object> => ({}))
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
  it('captures a modal by opaque ID, accepts it once, and detaches from the guest', async () => {
    const h = fixture()
    const lease = new BrowserDialogLease()
    const token = await lease.begin(h.guest, url)
    expect(h.sendCommand).toHaveBeenCalledWith('Page.enable')
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
