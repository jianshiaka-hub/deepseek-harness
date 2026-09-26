// @vitest-environment jsdom
/** A modal releases the selected-tab action instead of blocking its Host command. */
import { expect, it, vi } from 'vitest'
import type { BrowserJsDialog } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'

const url = 'https://example.test/'

async function readyFixture() {
  const h = electronFixture()
  h.mount()
  h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
  const guest = await h.guest()
  guest.state.url = url
  guest.state.title = 'Example'
  guest.state.loading = false
  guest.emit('dom-ready')
  guest.emit('did-navigate')
  return { h, guest }
}

it('returns an opaque dialog while native input is pending, then resumes after accept', async () => {
  const { h } = await readyFixture()
  const dialog: BrowserJsDialog = { id: 'a2f81017-5baf-422a-830d-843c43f67ed4', type: 'confirm' }
  let resolveAction: ((result: { url: string; title: string; performed: true }) => void) | undefined
  const action = vi.spyOn(h.frame, 'action').mockImplementation(() => new Promise((resolve) => { resolveAction = resolve }))
  h.bridge.waitDialog.mockResolvedValue(dialog)
  h.bridge.getDialog.mockResolvedValue(dialog)
  h.bridge.handleDialog.mockImplementation(async () => {
    resolveAction?.({ url, title: 'Example', performed: true })
  })
  try {
    const first = await h.frame.actionWithDialog?.(url, { op: 'click', x: 20, y: 20 }, () => true)
    expect(first).toMatchObject({ url, performed: true, dialog })
    expect(action).toHaveBeenCalledOnce()
    expect(await h.frame.dialog?.(url, () => true)).toEqual({ url, title: 'Example', dialog })
    await expect(h.frame.handleDialog?.(url, dialog.id, 'accept', undefined, () => true))
      .resolves.toEqual({ url, title: 'Example', performed: true })
    expect(h.bridge.handleDialog).toHaveBeenCalledWith(h.reservation.lease, 'dialog-lease', dialog.id,
      'accept', undefined)
    expect(await h.frame.dialog?.(url, () => true)).toEqual({ url, title: 'Example', dialog: null })
  } finally { action.mockRestore(); await h.dispose() }
})

it('forwards an approved prompt answer to only the retained guest dialog lease', async () => {
  const { h } = await readyFixture()
  const dialog: BrowserJsDialog = { id: 'd2f81017-5baf-422a-830d-843c43f67ed4', type: 'prompt' }
  let resolveAction: ((result: { url: string; title: string; performed: true }) => void) | undefined
  const action = vi.spyOn(h.frame, 'action').mockImplementation(() => new Promise((resolve) => { resolveAction = resolve }))
  h.bridge.waitDialog.mockResolvedValue(dialog)
  h.bridge.getDialog.mockResolvedValue(dialog)
  h.bridge.handleDialog.mockImplementation(async () => {
    resolveAction?.({ url, title: 'Example', performed: true })
  })
  try {
    await expect(h.frame.actionWithDialog?.(url, { op: 'click', x: 20, y: 20 }, () => true))
      .resolves.toMatchObject({ dialog })
    await expect(h.frame.handleDialog?.(url, dialog.id, 'accept', 'approved answer', () => true))
      .resolves.toEqual({ url, title: 'Example', performed: true })
    expect(h.bridge.handleDialog).toHaveBeenCalledWith(h.reservation.lease, 'dialog-lease', dialog.id,
      'accept', 'approved answer')
  } finally { action.mockRestore(); await h.dispose() }
})

it('forwards exact approved frame origins when a foreign element can open a prompt', async () => {
  const { h } = await readyFixture()
  const dialog: BrowserJsDialog = { id: 'aa281017-5baf-422a-830d-843c43f67ed4', type: 'prompt' }
  const origins = ['https://example.test', 'https://foreign.test']
  const action = vi.spyOn(h.frame, 'action').mockImplementation(() => new Promise(() => {}))
  h.bridge.waitDialog.mockResolvedValue(dialog)
  try {
    await expect(h.frame.actionWithDialog?.(url,
      { op: 'click', ref: 'foreign-ref', approvedFrameOrigins: origins }, () => true))
      .resolves.toMatchObject({ dialog })
    expect(h.bridge.beginDialog).toHaveBeenCalledWith(h.reservation.lease, url, origins)
  } finally { action.mockRestore(); await h.dispose() }
})

it('drops a dialog handle that Chromium already closed before the agent accepts it', async () => {
  const { h } = await readyFixture()
  const dialog: BrowserJsDialog = { id: 'f2f81017-5baf-422a-830d-843c43f67ed4', type: 'confirm' }
  const action = vi.spyOn(h.frame, 'action').mockImplementation(() => new Promise(() => {}))
  h.bridge.waitDialog.mockResolvedValue(dialog)
  h.bridge.getDialog.mockResolvedValue(null)
  try {
    await expect(h.frame.actionWithDialog?.(url, { op: 'click', x: 20, y: 20 }, () => true))
      .resolves.toMatchObject({ dialog })
    await expect(h.frame.dialog?.(url, () => true))
      .resolves.toEqual({ url, title: 'Example', dialog: null })
    expect(h.bridge.finishDialog).toHaveBeenCalledWith(h.reservation.lease, 'dialog-lease')
    expect(h.frame.pendingDialogUrl?.()).toBeUndefined()
  } finally { action.mockRestore(); await h.dispose() }
})

it('keeps a bounded dialog watch when native click completes before a frame prompt arrives', async () => {
  const { h } = await readyFixture()
  const dialog: BrowserJsDialog = { id: 'e2f81017-5baf-422a-830d-843c43f67ed4', type: 'prompt' }
  const action = vi.spyOn(h.frame, 'action').mockResolvedValue({ url, title: 'Example', performed: true })
  h.bridge.getDialog.mockResolvedValueOnce(null).mockResolvedValue(dialog)
  h.bridge.waitDialog.mockImplementation(async (_lease, _token, timeoutMs) =>
    timeoutMs === 250 ? dialog : new Promise(() => {}))
  try {
    await expect(h.frame.actionWithDialog?.(url, { op: 'click', x: 20, y: 20 }, () => true))
      .resolves.toMatchObject({ dialog })
    expect(h.bridge.waitDialog).toHaveBeenCalledWith(h.reservation.lease, 'dialog-lease', 250)
    await expect(h.frame.handleDialog?.(url, dialog.id, 'accept', 'answered', () => true))
      .resolves.toMatchObject({ performed: true })
    expect(h.bridge.handleDialog).toHaveBeenCalledWith(h.reservation.lease, 'dialog-lease',
      dialog.id, 'accept', 'answered')
    expect(h.frame.pendingDialogUrl?.()).toBeUndefined()
  } finally { action.mockRestore(); await h.dispose() }
})

it('releases the guest debugger when selection changes before a modal is resolved', async () => {
  const { h } = await readyFixture()
  const dialog: BrowserJsDialog = { id: 'b2f81017-5baf-422a-830d-843c43f67ed4', type: 'alert' }
  let retainedGuard: (() => boolean) | undefined
  const action = vi.spyOn(h.frame, 'action').mockImplementation((_url, _action, guard) => {
    retainedGuard = guard
    return new Promise(() => {})
  })
  h.bridge.waitDialog.mockResolvedValue(dialog)
  let selected = true
  try {
    await h.frame.actionWithDialog?.(url, { op: 'click', x: 20, y: 20 }, () => selected)
    selected = false
    await vi.waitFor(() => { expect(h.bridge.finishDialog).toHaveBeenCalledWith(h.reservation.lease, 'dialog-lease') })
    expect(retainedGuard?.()).toBe(false)
    selected = true
    expect(retainedGuard?.()).toBe(false)
    selected = false
    await expect(h.frame.dialog?.(url, () => selected)).rejects.toThrow('SIDEBAR_TAB_UNAVAILABLE')
  } finally { action.mockRestore(); await h.dispose() }
})

it('holds an accepted beforeunload result until the destination finishes loading', async () => {
  const { h, guest } = await readyFixture()
  const dialog: BrowserJsDialog = { id: 'c2f81017-5baf-422a-830d-843c43f67ed4', type: 'beforeunload' }
  const next = 'https://other.test/next'
  const action = vi.spyOn(h.frame, 'action').mockResolvedValue({ url, title: 'Example', performed: true })
  h.bridge.getDialog.mockResolvedValue(dialog)
  try {
    await expect(h.frame.actionWithDialog?.(url, { op: 'click', x: 20, y: 20 }, () => true))
      .resolves.toMatchObject({ dialog })
    guest.state.loading = true
    guest.emit('did-start-navigation', { isMainFrame: true })
    expect(h.frame.pendingDialogUrl?.()).toBe(url)
    expect(await h.frame.dialog?.(url, () => true)).toMatchObject({ dialog })
    let settled = false
    const handled = h.frame.handleDialog!(url, dialog.id, 'accept', undefined, () => true)
    void handled.then(() => { settled = true }, () => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    guest.state.url = next
    guest.state.title = 'Next'
    guest.emit('did-navigate')
    await Promise.resolve()
    expect(settled).toBe(false)
    guest.state.loading = false
    guest.emit('did-stop-loading')
    await expect(handled).resolves.toEqual({ url: next, title: 'Next', performed: true })
    expect(h.frame.pendingDialogUrl?.()).toBeUndefined()
  } finally { action.mockRestore(); await h.dispose() }
})
