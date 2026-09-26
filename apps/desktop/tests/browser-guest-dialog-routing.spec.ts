import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true },
  clipboard: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
  ClipboardItem: vi.fn(),
  session: { fromPartition: vi.fn() },
}))

const { DesktopBrowserGuests } = await import('../src/browser-guests.ts')
const url = 'https://example.test/page'
const leaseId = 'test-owned-guest'

function fixture() {
  const owner = { isDestroyed: () => false }
  const other = { isDestroyed: () => false }
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
  const guest = Object.assign(guestEvents, {
    debugger: debuggerPort,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL: () => url,
  })
  const guests = new DesktopBrowserGuests(() => undefined, '/unused/preload.cjs')
  const privateState = guests as unknown as { readonly leases: Map<string, unknown> }
  privateState.leases.set(leaseId, { owner, partition: 'isolated', attached: true, guest })
  return { guests, owner: owner as unknown as WebContents,
    other: other as unknown as WebContents, guest: guest as unknown as WebContents, debuggerPort }
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
