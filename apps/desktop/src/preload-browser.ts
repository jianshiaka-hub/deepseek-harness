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
    foreignFrameLocateVersion: 1,
    foreignFramePointVersion: 1,
    foreignFrameInputVersion: 1,
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
    locateForeign: (lease, expectedUrl, query, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserLocateForeign, lease, expectedUrl, query, approvedOrigins) as
      ReturnType<NonNullable<DesktopBrowserBridge['locateForeign']>>,
    foreignRefPoint: (lease, expectedUrl, ref, approvedOrigins) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignRefPoint, lease, expectedUrl, ref, approvedOrigins) as
      ReturnType<NonNullable<DesktopBrowserBridge['foreignRefPoint']>>,
    foreignInputState: (lease, expectedUrl, ref, approvedOrigins, phase, value) => ipcRenderer.invoke(
      DESKTOP_IPC.browserForeignInputState, lease, expectedUrl, ref, approvedOrigins, phase, value) as
      ReturnType<NonNullable<DesktopBrowserBridge['foreignInputState']>>,
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
