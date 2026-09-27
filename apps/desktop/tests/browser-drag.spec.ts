import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserDragLease } from '../src/browser-drag.ts'
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
  const intercept = (data: object): void => { debuggerEvents.emit('message', undefined, 'Input.dragIntercepted', { data }) }
  return { guest, guestEvents, debuggerPort, state, sendCommand, intercept }
}

describe('one-guest native drag lease', () => {
  it('lets a dialog borrow its debugger until the drag finishes', async () => {
    const h = fixture()
    h.sendCommand.mockImplementation(async (method: string): Promise<object> =>
      method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'dialog-script' } : {})
    const drag = new BrowserDragLease()
    const dialog = new BrowserDialogLease()
    const dragToken = await drag.begin(h.guest, url)
    expect(drag.ownsGuest(h.guest)).toBe(true)
    drag.extendForDialog(h.guest)
    const dialogToken = await dialog.begin(h.guest, url, undefined, drag.ownsGuest(h.guest))
    expect(h.debuggerPort.attach).toHaveBeenCalledTimes(1)
    await dialog.close(dialogToken)
    expect(h.state.attached).toBe(true)
    await drag.cancel(dragToken)
    expect(h.state.attached).toBe(false)
    expect(drag.ownsGuest(h.guest)).toBe(false)
  })

  it('replays captured page drag data into the same guest with fixed drop commands', async () => {
    const h = fixture()
    const lease = new BrowserDragLease()
    const token = await lease.begin(h.guest, url)
    expect(h.sendCommand).toHaveBeenCalledWith('Input.setInterceptDrags', { enabled: true })
    const data = { items: [{ mimeType: 'text/plain', data: 'page-owned' }], dragOperationsMask: 1 }
    h.intercept(data)
    expect(await lease.finish(token, url, { x: 120, y: 75 })).toEqual({ dropped: true })
    expect(h.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchDragEvent'))
      .toEqual(['dragEnter', 'dragOver', 'drop'].map(type => ['Input.dispatchDragEvent',
        { type, x: 120, y: 75, data }]))
    expect(h.state.attached).toBe(false)
    expect(lease.activeToken).toBeUndefined()
  })

  it('keeps pointer drags possible without HTML drag data, but rejects a changed page', async () => {
    const h = fixture()
    const lease = new BrowserDragLease()
    const token = await lease.begin(h.guest, url)
    expect(await lease.finish(token, url, { x: 90, y: 80 })).toEqual({ dropped: false })
    expect(h.sendCommand).not.toHaveBeenCalledWith('Input.dispatchDragEvent', expect.anything())
    const second = await lease.begin(h.guest, url)
    h.state.url = 'https://other.test/'
    h.guestEvents.emit('did-start-navigation')
    await vi.waitFor(() => { expect(lease.activeToken).toBeUndefined() })
    await expect(lease.finish(second, url, { x: 90, y: 80 })).rejects.toThrow('SIDEBAR_DRAG_LEASE_UNAVAILABLE')
    expect(h.state.attached).toBe(false)
  })

  it('bounds the drop point and releases the debugger after a failed attach or cancel', async () => {
    const h = fixture()
    const lease = new BrowserDragLease()
    h.state.failAttach = true
    await expect(lease.begin(h.guest, url)).rejects.toThrow('debugger busy')
    h.state.failAttach = false
    const token = await lease.begin(h.guest, url)
    await expect(lease.begin(h.guest, url)).rejects.toThrow('SIDEBAR_DRAG_BUSY')
    await expect(lease.finish(token, url, { x: -1, y: 80 })).rejects.toThrow('SIDEBAR_NAVIGATED')
    expect(h.state.attached).toBe(false)
    const next = await lease.begin(h.guest, url)
    await lease.cancel(next)
    expect(h.state.attached).toBe(false)
  })
})
