/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** One agent-created tab's approved first document, scoped to its actual Sidebar occurrence. */
export interface DesktopBrowserInitialPreflight {
  readonly clientId: string
  readonly sessionId: string
  readonly tabId: string
  readonly initialUrl: string
}

/** Identity of the Browser occurrence acquiring a guest for its requested first URL. */
export interface DesktopBrowserOccurrence {
  readonly sessionId: string
  readonly tabId: string
  readonly initialUrl: string
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
  readonly resourceType?: 'subFrame'
  readonly popupInitialUrl?: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string, initialPreflight?: DesktopBrowserInitialPreflight | DesktopBrowserOccurrence): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** Versioned host gate. Plugins may use it when present; older shells omit it. */
  readonly navigationPreflightVersion?: 1
  /** Main-process bootstrap guard for the first request of an agent-created tab. */
  readonly initialNavigationPreflightVersion?: 1
  /** Reserve a request-before-network gate for an existing empty Browser occurrence. */
  readonly blankNavigationPreflightVersion?: 1
  reserveBlankNavigationPreflight?(clientId: string, sessionId: string, tabId: string,
    initialUrl: string): Promise<void>
  cancelBlankNavigationPreflight?(clientId: string, sessionId: string, tabId: string,
    initialUrl: string): Promise<void>
  /** Bounded read of currently loaded foreign frames; available only with a main-process guard. */
  readonly foreignFrameReadVersion?: 1
  auditFrames?(lease: DesktopBrowserLeaseId, expectedUrl: string): Promise<{
    readonly origins: readonly string[]; readonly fingerprint: string }>
  inspectForeignText?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    approvedOrigins: readonly string[]): Promise<{ readonly fingerprint: string;
      readonly frames: readonly { readonly origin: string; readonly text: string;
        readonly roles: string }[] }>
  armNavigationPreflight?(lease: DesktopBrowserLeaseId, clientId: string, sessionId: string,
    tabId: string, navigationEpoch: number, expectedUrl: string): Promise<void>
  resolveNavigationPreflight?(token: string, allowed: boolean): Promise<void>
  onNavigationIntent?(listener: (intent: DesktopBrowserNavigationIntent) => void): () => void
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
