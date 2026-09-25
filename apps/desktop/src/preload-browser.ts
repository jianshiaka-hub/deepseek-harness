/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserOpenRequested, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    acquire: workspace => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace) as ReturnType<DesktopBrowserBridge['acquire']>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    auditFrames: (lease, expectedUrl, approvedOrigins) => ipcRenderer.invoke(DESKTOP_IPC.browserAuditFrames,
      lease, expectedUrl, approvedOrigins) as ReturnType<DesktopBrowserBridge['auditFrames']>,
    inspectForeignText: (lease, expectedUrl, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserInspectForeignText, lease, expectedUrl, approvedOrigins) as
      ReturnType<DesktopBrowserBridge['inspectForeignText']>,
    locateForeign: (lease, expectedUrl, query, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserLocateForeign, lease, expectedUrl, query, approvedOrigins) as
      ReturnType<DesktopBrowserBridge['locateForeign']>,
    foreignRefPoint: (lease, expectedUrl, ref, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignRefPoint, lease, expectedUrl, ref, approvedOrigins) as
      ReturnType<DesktopBrowserBridge['foreignRefPoint']>,
    foreignInputState: (lease, expectedUrl, ref, approvedOrigins, phase, value) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignInputState, lease, expectedUrl, ref, approvedOrigins, phase, value) as
      ReturnType<DesktopBrowserBridge['foreignInputState']>,
    foreignSecondaryState: (lease, expectedUrl, ref, approvedOrigins, action) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignSecondaryState, lease, expectedUrl, ref, approvedOrigins, action) as
      ReturnType<DesktopBrowserBridge['foreignSecondaryState']>,
    dragPoint: (lease, expectedUrl, x, y, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserDragPoint, lease, expectedUrl, x, y, approvedOrigins) as
      ReturnType<DesktopBrowserBridge['dragPoint']>,
    selectForeignOption: (lease, expectedUrl, ref, approvedOrigins, options) => ipcRenderer.invoke(
      DESKTOP_IPC.browserSelectForeignOption, lease, expectedUrl, ref, approvedOrigins, options) as
      ReturnType<DesktopBrowserBridge['selectForeignOption']>,
    selectForeignText: (lease, expectedUrl, ref, approvedOrigins, spec) => ipcRenderer.invoke(
      DESKTOP_IPC.browserSelectForeignText, lease, expectedUrl, ref, approvedOrigins, spec) as
      ReturnType<DesktopBrowserBridge['selectForeignText']>,
    captureViewport: (lease, expectedUrl, clip, approvedOrigins) => ipcRenderer.invoke(DESKTOP_IPC.browserCaptureViewport,
      lease, expectedUrl, clip, approvedOrigins) as ReturnType<DesktopBrowserBridge['captureViewport']>,
    captureFullPage: (lease, expectedUrl, clip, approvedOrigins) => ipcRenderer.invoke(DESKTOP_IPC.browserCaptureFullPage,
      lease, expectedUrl, clip, approvedOrigins) as ReturnType<DesktopBrowserBridge['captureFullPage']>,
    beginPaste: (lease, expectedUrl, payload) => ipcRenderer.invoke(DESKTOP_IPC.browserPasteBegin,
      lease, expectedUrl, payload) as ReturnType<DesktopBrowserBridge['beginPaste']>,
    finishPaste: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserPasteEnd,
      lease, token) as ReturnType<DesktopBrowserBridge['finishPaste']>,
    beginDrag: (lease, expectedUrl) => ipcRenderer.invoke(DESKTOP_IPC.browserDragBegin,
      lease, expectedUrl) as ReturnType<DesktopBrowserBridge['beginDrag']>,
    finishDrag: (lease, token, point) => ipcRenderer.invoke(DESKTOP_IPC.browserDragEnd,
      lease, token, point) as ReturnType<DesktopBrowserBridge['finishDrag']>,
    beginDialog: (lease, expectedUrl) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogBegin,
      lease, expectedUrl) as ReturnType<DesktopBrowserBridge['beginDialog']>,
    navigate: (lease, token, expectedUrl, method, destination) => ipcRenderer.invoke(DESKTOP_IPC.browserNavigate,
      lease, token, expectedUrl, method, destination) as ReturnType<DesktopBrowserBridge['navigate']>,
    getDialog: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogGet,
      lease, token) as ReturnType<DesktopBrowserBridge['getDialog']>,
    waitDialog: (lease, token, timeoutMs) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogWait,
      lease, token, timeoutMs) as ReturnType<DesktopBrowserBridge['waitDialog']>,
    handleDialog: (lease, token, dialogId, action, text) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogHandle,
      lease, token, dialogId, action, text) as ReturnType<DesktopBrowserBridge['handleDialog']>,
    finishDialog: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogEnd,
      lease, token) as ReturnType<DesktopBrowserBridge['finishDialog']>,
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}
