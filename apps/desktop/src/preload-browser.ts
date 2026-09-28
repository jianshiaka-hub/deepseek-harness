/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserNavigationIntent } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

function navigationIntent(value: unknown): value is DesktopBrowserNavigationIntent {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return ['token', 'lease', 'clientId', 'sessionId', 'tabId', 'expectedUrl', 'targetUrl', 'method']
    .every(key => typeof row[key] === 'string') && Number.isSafeInteger(row.navigationEpoch) &&
    (row.resourceType === undefined || row.resourceType === 'subFrame') &&
    (row.popupInitialUrl === undefined || typeof row.popupInitialUrl === 'string')
}

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  const navigationListeners = new Set<(intent: DesktopBrowserNavigationIntent) => void>()
  ipcRenderer.on(DESKTOP_IPC.browserNavigationIntent, (_event, value: unknown) => {
    if (!navigationIntent(value)) return
    for (const listener of [...navigationListeners]) {
      try { listener(value) }
      catch (error) { console.error('Desktop browser navigation handler failed', error) }
    }
  })
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
    navigationPreflightVersion: 1,
    initialNavigationPreflightVersion: 1,
    blankNavigationPreflightVersion: 1,
    foreignFrameReadVersion: 1,
    foreignFrameAssetsVersion: 1,
    foreignFrameLocateVersion: 1,
    foreignFramePointVersion: 1,
    foreignFrameInputVersion: 1,
    foreignFrameTypeVersion: 1,
    richPasteVersion: 1,
    nativeDragVersion: 1,
    dialogVersion: 1,
    fileChooserVersion: 1,
    downloadVersion: 1,
    foreignFrameOptionVersion: 1,
    foreignFrameKeyVersion: 1,
    foreignFrameSelectionVersion: 1,
    foreignFrameSecondaryVersion: 1,
    foreignFrameCaptureVersion: 1,
    acquire: (workspace, initialPreflight) => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire,
      workspace, initialPreflight) as ReturnType<DesktopBrowserBridge['acquire']>,
    reserveBlankNavigationPreflight: (clientId, sessionId, tabId, initialUrl) =>
      ipcRenderer.invoke(DESKTOP_IPC.browserBlankNavigationPreflightReserve,
        clientId, sessionId, tabId, initialUrl) as Promise<void>,
    cancelBlankNavigationPreflight: (clientId, sessionId, tabId, initialUrl) =>
      ipcRenderer.invoke(DESKTOP_IPC.browserBlankNavigationPreflightCancel,
        clientId, sessionId, tabId, initialUrl) as Promise<void>,
    auditFrames: (lease, expectedUrl) => ipcRenderer.invoke(DESKTOP_IPC.browserAuditFrames,
      lease, expectedUrl) as ReturnType<NonNullable<DesktopBrowserBridge['auditFrames']>>,
    inspectForeignText: (lease, expectedUrl, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserInspectForeignText, lease, expectedUrl, approvedOrigins) as
      ReturnType<NonNullable<DesktopBrowserBridge['inspectForeignText']>>,
    listFrameAssets: (lease, expectedUrl, approvedOrigins, marker) => ipcRenderer.invoke(
      DESKTOP_IPC.browserListFrameAssets, lease, expectedUrl, approvedOrigins, marker) as
      ReturnType<NonNullable<DesktopBrowserBridge['listFrameAssets']>>,
    checkFrameAssets: (lease, expectedUrl, approvedOrigins, marker) => ipcRenderer.invoke(
      DESKTOP_IPC.browserCheckFrameAssets, lease, expectedUrl, approvedOrigins, marker) as
      ReturnType<NonNullable<DesktopBrowserBridge['checkFrameAssets']>>,
    fetchFrameAsset: (lease, expectedUrl, approvedOrigins, approvedAssetOrigin, marker, assetId) =>
      ipcRenderer.invoke(DESKTOP_IPC.browserFetchFrameAsset, lease, expectedUrl,
        approvedOrigins, approvedAssetOrigin, marker, assetId) as
      ReturnType<NonNullable<DesktopBrowserBridge['fetchFrameAsset']>>,
    locateForeign: (lease, expectedUrl, query, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserLocateForeign, lease, expectedUrl, query, approvedOrigins) as
      ReturnType<NonNullable<DesktopBrowserBridge['locateForeign']>>,
    foreignRefPoint: (lease, expectedUrl, ref, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignRefPoint, lease, expectedUrl, ref, approvedOrigins) as
      ReturnType<NonNullable<DesktopBrowserBridge['foreignRefPoint']>>,
    foreignInputState: (lease, expectedUrl, ref, approvedOrigins, phase, value) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignInputState, lease, expectedUrl, ref, approvedOrigins, phase, value) as
      ReturnType<NonNullable<DesktopBrowserBridge['foreignInputState']>>,
    beginDownload: (lease, expectedUrl, target) => ipcRenderer.invoke(DESKTOP_IPC.browserDownloadBegin,
      lease, expectedUrl, target) as ReturnType<NonNullable<DesktopBrowserBridge['beginDownload']>>,
    pollDownload: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserDownloadPoll,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['pollDownload']>>,
    resumeDownload: (lease, token, origins) => ipcRenderer.invoke(DESKTOP_IPC.browserDownloadResume,
      lease, token, origins) as ReturnType<NonNullable<DesktopBrowserBridge['resumeDownload']>>,
    cancelDownload: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserDownloadCancel,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['cancelDownload']>>,
    finishDownload: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserDownloadFinish,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['finishDownload']>>,
    beginFileChooser: (lease, expectedUrl) => ipcRenderer.invoke(DESKTOP_IPC.browserFileChooserBegin,
      lease, expectedUrl) as ReturnType<NonNullable<DesktopBrowserBridge['beginFileChooser']>>,
    pollFileChooser: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserFileChooserPoll,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['pollFileChooser']>>,
    setFileChooserFiles: (lease, token, origin, files) => ipcRenderer.invoke(DESKTOP_IPC.browserFileChooserFiles,
      lease, token, origin, files) as ReturnType<NonNullable<DesktopBrowserBridge['setFileChooserFiles']>>,
    cancelFileChooser: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserFileChooserCancel,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['cancelFileChooser']>>,
    beginPaste: (lease, expectedUrl, payload) => ipcRenderer.invoke(DESKTOP_IPC.browserPasteBegin,
      lease, expectedUrl, payload) as ReturnType<NonNullable<DesktopBrowserBridge['beginPaste']>>,
    finishPaste: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserPasteEnd,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['finishPaste']>>,
    foreignPasteState: (lease, expectedUrl, ref, approvedOrigins, phase, receipt) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignPasteState, lease, expectedUrl, ref, approvedOrigins, phase, receipt) as
      ReturnType<NonNullable<DesktopBrowserBridge['foreignPasteState']>>,
    dragPoint: (lease, expectedUrl, x, y, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserDragPoint, lease, expectedUrl, x, y, approvedOrigins) as
      ReturnType<NonNullable<DesktopBrowserBridge['dragPoint']>>,
    beginDrag: (lease, expectedUrl) => ipcRenderer.invoke(DESKTOP_IPC.browserDragBegin,
      lease, expectedUrl) as ReturnType<NonNullable<DesktopBrowserBridge['beginDrag']>>,
    finishDrag: (lease, token, point) => ipcRenderer.invoke(DESKTOP_IPC.browserDragEnd,
      lease, token, point) as ReturnType<NonNullable<DesktopBrowserBridge['finishDrag']>>,
    beginDialog: (lease, expectedUrl, approvedPromptOrigins) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogBegin,
      lease, expectedUrl, approvedPromptOrigins) as ReturnType<NonNullable<DesktopBrowserBridge['beginDialog']>>,
    navigateWithDialog: (lease, token, expectedUrl, method, destination) => ipcRenderer.invoke(
      DESKTOP_IPC.browserDialogNavigate, lease, token, expectedUrl, method, destination) as
      ReturnType<NonNullable<DesktopBrowserBridge['navigateWithDialog']>>,
    getDialog: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogGet,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['getDialog']>>,
    waitDialog: (lease, token, timeoutMs) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogWait,
      lease, token, timeoutMs) as ReturnType<NonNullable<DesktopBrowserBridge['waitDialog']>>,
    handleDialog: (lease, token, dialogId, action, text) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogHandle,
      lease, token, dialogId, action, text) as ReturnType<NonNullable<DesktopBrowserBridge['handleDialog']>>,
    finishDialog: (lease, token) => ipcRenderer.invoke(DESKTOP_IPC.browserDialogEnd,
      lease, token) as ReturnType<NonNullable<DesktopBrowserBridge['finishDialog']>>,
    selectForeignOption: (lease, expectedUrl, ref, approvedOrigins, options) => ipcRenderer.invoke(
      DESKTOP_IPC.browserSelectForeignOption, lease, expectedUrl, ref, approvedOrigins, options) as
      ReturnType<NonNullable<DesktopBrowserBridge['selectForeignOption']>>,
    foreignKeyState: (lease, expectedUrl, ref, approvedOrigins, key, phase) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignKeyState, lease, expectedUrl, ref, approvedOrigins, key, phase) as
      ReturnType<NonNullable<DesktopBrowserBridge['foreignKeyState']>>,
    selectForeignText: (lease, expectedUrl, ref, approvedOrigins, selection) => ipcRenderer.invoke(
      DESKTOP_IPC.browserSelectForeignText, lease, expectedUrl, ref, approvedOrigins, selection) as
      ReturnType<NonNullable<DesktopBrowserBridge['selectForeignText']>>,
    foreignSecondaryState: (lease, expectedUrl, ref, approvedOrigins, action) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignSecondaryState, lease, expectedUrl, ref, approvedOrigins, action) as
      ReturnType<NonNullable<DesktopBrowserBridge['foreignSecondaryState']>>,
    captureFrameAware: (lease, expectedUrl, clip, fullPage, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserCaptureFrameAware, lease, expectedUrl, clip, fullPage, approvedOrigins) as
      ReturnType<NonNullable<DesktopBrowserBridge['captureFrameAware']>>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    armNavigationPreflight: (lease, clientId, sessionId, tabId, navigationEpoch, expectedUrl) =>
      ipcRenderer.invoke(DESKTOP_IPC.browserNavigationPreflightArm, lease, clientId, sessionId,
        tabId, navigationEpoch, expectedUrl) as Promise<void>,
    resolveNavigationPreflight: (token, allowed) => ipcRenderer.invoke(
      DESKTOP_IPC.browserNavigationPreflightResolve, token, allowed) as Promise<void>,
    onNavigationIntent(listener) {
      navigationListeners.add(listener)
      return () => { navigationListeners.delete(listener) }
    },
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
