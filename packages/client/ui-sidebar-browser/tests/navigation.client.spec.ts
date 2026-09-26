// @vitest-environment jsdom
/** Selected-tab navigation waits for an observed destination and revokes switched tabs. */
import { expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserController } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { electronFixture } from './electron-harness.client.ts'

it('does not return the old page while goto loads and reports the observed redirect', async () => {
  const h = electronFixture()
  const lifetime = new AbortController()
  const controller = new BrowserController({ tabId: 'tab-a' as TabId, signal: lifetime.signal,
    applicationOrigin: 'https://dsh.example', initial: undefined,
    actions: createBrowserStore().create('navigation-a').actions,
    createPage: () => h, openTab: vi.fn() })
  try {
    controller.mount(h.host.id)
    controller.start('https://example.test/')
    const guest = await h.guest()
    guest.state.url = 'https://example.test/'
    guest.state.title = 'Example'
    guest.state.loading = false
    h.bridge.waitDialog.mockImplementation(() => new Promise(() => {}))
    h.bridge.getDialog.mockRejectedValue(new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE'))
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    const result = controller.navigate('https://example.test/', 'https://other.test/path', () => true)
    let settled = false
    void result.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenLastCalledWith(
      h.reservation.lease, 'dialog-lease', 'https://example.test/', 'goto', 'https://other.test/path') })
    guest.state.loading = true
    guest.emit('did-start-navigation', { isMainFrame: true })
    guest.state.url = 'https://final.test/'
    guest.state.title = 'Final'
    guest.emit('did-navigate')
    guest.state.loading = false
    guest.emit('did-stop-loading')
    await expect(result).resolves.toEqual({ url: 'https://final.test/', title: 'Final', performed: true })

    const refreshed = controller.navigate('https://final.test/', 'https://final.test/', () => true)
    await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenLastCalledWith(
      h.reservation.lease, 'dialog-lease', 'https://final.test/', 'goto', 'https://final.test/') })
    guest.state.loading = true
    guest.emit('did-start-navigation', { isMainFrame: true })
    guest.emit('did-navigate')
    guest.state.loading = false
    guest.emit('did-stop-loading')
    await expect(refreshed).resolves.toEqual({ url: 'https://final.test/', title: 'Final', performed: true })

    guest.state.back = true
    guest.emit('did-stop-loading')
    const back = controller.navigateHistory('https://final.test/', 'back', () => true)
    await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenLastCalledWith(
      h.reservation.lease, 'dialog-lease', 'https://final.test/', 'back', undefined) })
    guest.state.loading = true
    guest.emit('did-start-navigation', { isMainFrame: true })
    guest.state.url = 'https://example.test/'
    guest.state.title = 'Example again'
    guest.state.back = false
    guest.state.forward = true
    guest.emit('did-navigate')
    guest.state.loading = false
    guest.emit('did-stop-loading')
    await expect(back).resolves.toEqual({ url: 'https://example.test/', title: 'Example again', performed: true })

    const forward = controller.navigateHistory('https://example.test/', 'forward', () => true)
    await vi.waitFor(() => { expect(h.bridge.navigate).toHaveBeenLastCalledWith(
      h.reservation.lease, 'dialog-lease', 'https://example.test/', 'forward', undefined) })
    guest.state.loading = true
    guest.emit('did-start-navigation', { isMainFrame: true })
    guest.state.url = 'https://final.test/'
    guest.state.title = 'Final again'
    guest.state.forward = false
    guest.state.back = true
    guest.emit('did-navigate')
    guest.state.loading = false
    guest.emit('did-stop-loading')
    await expect(forward).resolves.toEqual({ url: 'https://final.test/', title: 'Final again', performed: true })
  } finally { lifetime.abort(); await controller.dispose(); await h.dispose() }
})

it('rejects navigation after selection changes and before any destination is returned', async () => {
  const h = electronFixture()
  const lifetime = new AbortController()
  const controller = new BrowserController({ tabId: 'tab-b' as TabId, signal: lifetime.signal,
    applicationOrigin: 'https://dsh.example', initial: undefined,
    actions: createBrowserStore().create('navigation-b').actions,
    createPage: () => h, openTab: vi.fn() })
  let selected = true
  try {
    controller.mount(h.host.id)
    controller.start('https://example.test/')
    const guest = await h.guest()
    guest.state.url = 'https://example.test/'
    guest.state.title = 'Example'
    guest.state.loading = false
    Object.assign(guest.element, { executeJavaScript: vi.fn(async () => {}) })
    h.bridge.waitDialog.mockImplementation(() => new Promise(() => {}))
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    expect(() => controller.navigateHistory('https://example.test/', 'back', () => true))
      .toThrow('SIDEBAR_HISTORY_UNAVAILABLE')
    const result = controller.navigate('https://example.test/', 'https://other.test/', () => selected)
    selected = false
    await expect(result).rejects.toThrow('SIDEBAR_SELECTION_CHANGED')
  } finally { lifetime.abort(); await controller.dispose(); await h.dispose() }
})

it('returns an agent goto beforeunload handle, then reports the committed destination after acceptance', async () => {
  const h = electronFixture()
  const lifetime = new AbortController()
  const controller = new BrowserController({ tabId: 'tab-c' as TabId, signal: lifetime.signal,
    applicationOrigin: 'https://dsh.example', initial: undefined,
    actions: createBrowserStore().create('navigation-c').actions,
    createPage: () => h, openTab: vi.fn() })
  const source = 'https://example.test/'
  const destination = 'https://other.test/path'
  const dialog = { id: 'f2f81017-5baf-422a-830d-843c43f67ed4', type: 'beforeunload' as const,
    origin: 'https://example.test' }
  try {
    controller.mount(h.host.id)
    controller.start(source)
    const guest = await h.guest()
    guest.state.url = source
    guest.state.title = 'Example'
    guest.state.loading = false
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    h.bridge.waitDialog.mockResolvedValue(dialog)
    h.bridge.getDialog.mockResolvedValue(dialog)
    const first = await controller.navigate(source, destination, () => true)
    expect(first).toMatchObject({ url: source, dialog, performed: true })
    expect(h.bridge.navigate).toHaveBeenLastCalledWith(
      h.reservation.lease, 'dialog-lease', source, 'goto', destination)
    guest.state.loading = true
    guest.emit('did-start-navigation', { isMainFrame: true })
    expect(controller.pendingDialogUrl()).toBe(source)
    expect(await controller.dialog(source, () => true)).toMatchObject({ dialog })
    const handled = controller.handleDialog(source, dialog.id, 'accept', undefined, () => true)
    guest.state.url = destination
    guest.state.title = 'Destination'
    guest.emit('did-navigate')
    guest.state.loading = false
    guest.emit('did-stop-loading')
    await expect(handled).resolves.toEqual({ url: destination, title: 'Destination', performed: true })
  } finally { lifetime.abort(); await controller.dispose(); await h.dispose() }
})
