import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true },
  clipboard: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
  ClipboardItem: vi.fn(),
  session: { fromPartition: vi.fn() },
}))

const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')
const { BrowserDialogLease } = await import('../src/browser-dialog.ts')
const url = 'https://example.test/page'
const foreignUrl = 'https://foreign.test/frame'
const leaseId = 'test-owned-guest'

function fixture() {
  const owner = { isDestroyed: () => false }
  const debuggerEvents = new EventEmitter()
  const guestEvents = new EventEmitter()
  let attached = false
  const debuggerPort = Object.assign(debuggerEvents, {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    sendCommand: vi.fn(async (method: string): Promise<object> =>
      method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: 'dialog-shim' } : {}),
  })
  const other = Object.assign(new EventEmitter(), {
    debugger: debuggerPort,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL: () => url,
  })
  const mainFrame = { url, origin: new URL(url).origin, frameTreeNodeId: 1, detached: false,
    framesInSubtree: [] as unknown[] }
  mainFrame.framesInSubtree.push(mainFrame,
    { url: foreignUrl, origin: new URL(foreignUrl).origin, frameTreeNodeId: 2, detached: false })
  const guest = Object.assign(guestEvents, {
    debugger: debuggerPort,
    mainFrame,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL: () => url,
  })
  const guests = new DesktopBrowserGuests(() => undefined, '/unused/preload.cjs')
  const leases: unknown = Reflect.get(guests, 'leases')
  if (!(leases instanceof Map)) throw new Error('DesktopBrowserGuests leases are unavailable')
  leases.set(leaseId, { owner, partition: 'isolated', attached: true, guest })
  return { guests, owner, other, guest, guestEvents, debuggerPort }
}

it('routes one confirm only from the owned and exact-origin guest to its current dialog lease', async () => {
  const h = fixture()
  const token = await h.guests.beginDialog(h.owner, leaseId, url)
  const rejected = vi.fn()
  h.guests.offerGuestDialog(h.other, url, 'confirm', rejected)
  h.guests.offerGuestDialog(h.guest, 'https://foreign.test/frame', 'confirm', rejected)
  expect(rejected).toHaveBeenCalledTimes(2)
  expect(rejected).toHaveBeenNthCalledWith(1, false)
  expect(rejected).toHaveBeenNthCalledWith(2, false)
  expect(h.guests.getDialog(h.owner, leaseId, token)).toBeNull()
  const answer = vi.fn()
  h.guests.offerGuestDialog(h.guest, 'https://example.test/frame', 'confirm', answer)
  const dialog = await h.guests.waitDialog(h.owner, leaseId, token, 0)
  expect(dialog?.type).toBe('confirm')
  await expect(h.guests.handleDialog(h.other, leaseId, token, dialog!.id, 'accept', undefined))
    .rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
  expect(answer).not.toHaveBeenCalled()
  await h.guests.handleDialog(h.owner, leaseId, token, dialog!.id, 'accept', undefined)
  expect(answer).toHaveBeenCalledExactlyOnceWith(true)
  expect(h.debuggerPort.isAttached()).toBe(false)
})

it('dismisses a held guest confirm when the owning lease ends', async () => {
  const h = fixture()
  const token = await h.guests.beginDialog(h.owner, leaseId, url)
  const answer = vi.fn()
  h.guests.offerGuestDialog(h.guest, url, 'confirm', answer)
  expect(h.guests.getDialog(h.owner, leaseId, token)?.type).toBe('confirm')
  await h.guests.finishDialog(h.owner, leaseId, token)
  expect(answer).toHaveBeenCalledExactlyOnceWith(false)
  expect(h.debuggerPort.isAttached()).toBe(false)
})

it('routes native foreign-frame dialogs only through the approved owner lease', async () => {
  const h = fixture()
  h.guestEvents.on('-run-dialog', vi.fn())
  const dialogLease: unknown = Reflect.get(h.guests, 'dialogLease')
  const offerNativeDialog: unknown = Reflect.get(h.guests, 'offerNativeDialog')
  if (!(dialogLease instanceof BrowserDialogLease) || typeof offerNativeDialog !== 'function') {
    throw new Error('DesktopBrowserGuests native dialog routing is unavailable')
  }
  expect(dialogLease.installNativeDialogGuard(h.guest,
    (source, type, respond) => Reflect.apply(offerNativeDialog, h.guests, [h.guest, source, type, respond]) === true)).toBe(true)
  const origins = [new URL(url).origin, new URL(foreignUrl).origin]
  const first = await h.guests.beginDialog(h.owner, leaseId, url, origins)
  const unapproved = vi.fn()
  h.guestEvents.emit('-run-dialog', { frame: { url: 'https://unapproved.test/frame' },
    dialogType: 'confirm', messageText: 'Private page text' }, unapproved)
  expect(unapproved).toHaveBeenCalledExactlyOnceWith(false, '')
  expect(h.guests.getDialog(h.owner, leaseId, first)).toBeNull()
  const promptReply = vi.fn()
  h.guestEvents.emit('-run-dialog', { frame: { url: foreignUrl },
    dialogType: 'prompt', defaultPromptText: 'Seed', messageText: 'Private page text' }, promptReply)
  const prompt = h.guests.getDialog(h.owner, leaseId, first)
  expect(prompt?.type).toBe('prompt')
  expect(JSON.stringify(prompt)).not.toContain('Private page text')
  await expect(h.guests.handleDialog(h.other, leaseId, first, prompt!.id, 'accept', 'answer'))
    .rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
  expect(promptReply).not.toHaveBeenCalled()
  await h.guests.handleDialog(h.owner, leaseId, first, prompt!.id, 'accept', 'answer')
  expect(promptReply).toHaveBeenCalledExactlyOnceWith(true, 'answer')
  expect(h.debuggerPort.isAttached()).toBe(false)

  const second = await h.guests.beginDialog(h.owner, leaseId, url, origins)
  const confirmReply = vi.fn()
  h.guestEvents.emit('-run-dialog', { frame: { url: foreignUrl },
    dialogType: 'confirm', messageText: 'Private page text' }, confirmReply)
  const confirm = h.guests.getDialog(h.owner, leaseId, second)
  expect(confirm?.type).toBe('confirm')
  await h.guests.handleDialog(h.owner, leaseId, second, confirm!.id, 'accept', undefined)
  expect(confirmReply).toHaveBeenCalledExactlyOnceWith(true, '')

  const third = await h.guests.beginDialog(h.owner, leaseId, url, origins)
  const canceled = vi.fn()
  h.guestEvents.emit('-run-dialog', { frame: { url: foreignUrl },
    dialogType: 'alert' }, canceled)
  const alert = h.guests.getDialog(h.owner, leaseId, third)
  expect(alert?.type).toBe('alert')
  h.debuggerPort.emit('message', undefined, 'Page.javascriptDialogClosed', {})
  expect(canceled).toHaveBeenCalledExactlyOnceWith(false, '')
  await expect(h.guests.handleDialog(h.owner, leaseId, third, alert!.id, 'accept', undefined))
    .rejects.toThrow('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
})
