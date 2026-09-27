/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** A held main-frame request from an agent-touched Sidebar guest. */
export interface DesktopBrowserNavigationIntent {
  readonly token: string
  readonly lease: DesktopBrowserLeaseId
  readonly clientId: string
  readonly sessionId: string
  readonly tabId: string
  readonly navigationEpoch: number
  readonly expectedUrl: string
  readonly targetUrl: string
  readonly method: string
  readonly popupInitialUrl?: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** Versioned host gate. Plugins may use it when present; older shells omit it. */
  readonly navigationPreflightVersion?: 1
  armNavigationPreflight?(lease: DesktopBrowserLeaseId, clientId: string, sessionId: string,
    tabId: string, navigationEpoch: number, expectedUrl: string): Promise<void>
  resolveNavigationPreflight?(token: string, allowed: boolean): Promise<void>
  onNavigationIntent?(listener: (intent: DesktopBrowserNavigationIntent) => void): () => void
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
