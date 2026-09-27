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

/** Paused download status; the private path is revealed only after all origins are approved. */
export type BrowserDownloadStatus =
  | { readonly state: 'waiting' }
  | { readonly state: 'offered'; readonly origins: readonly string[] }
  | { readonly state: 'completed'; readonly path: string; readonly filename: string }
  | { readonly state: 'failed'; readonly reason: string }

/** Bounded status of one intercepted native file input. */
export type BrowserFileChooserStatus =
  | { readonly state: 'waiting' }
  | { readonly state: 'offered'; readonly origin: string; readonly multiple: boolean }
  | { readonly state: 'failed'; readonly reason: string }

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

/** A bounded string or serialized regular expression for approved locator matching. */
export type BrowserTextPattern = string | { readonly __cu: 'regexp'; readonly source: string; readonly flags: string }

/** One bounded selector and optional local filter over the approved document. */
export interface BrowserLocateSelector {
  readonly method: 'getByRole' | 'locator' | 'getByText' | 'getByLabel' | 'getByPlaceholder' | 'getByAltText' | 'getByTitle' | 'getByTestId'
  readonly value: BrowserTextPattern
  readonly name?: BrowserTextPattern
  readonly description?: BrowserTextPattern
  readonly exact: boolean
  readonly includeHidden?: boolean
  readonly checked?: boolean
  readonly disabled?: boolean
  readonly expanded?: boolean
  readonly level?: number
  readonly pressed?: boolean
  readonly selected?: boolean
  readonly filter?: {
    readonly hasText?: BrowserTextPattern
    readonly hasNotText?: BrowserTextPattern
    readonly visible?: boolean
    readonly has?: BrowserRelativeLocateQuery
    readonly hasNot?: BrowserRelativeLocateQuery
  }
}

/** Local filters within a relative locator; descendant queries are bounded by validation depth. */
export interface BrowserRelativeLocateFilter {
  readonly hasText?: BrowserTextPattern
  readonly hasNotText?: BrowserTextPattern
  readonly visible?: boolean
  readonly has?: BrowserRelativeLocateQuery
  readonly hasNot?: BrowserRelativeLocateQuery
}

/** One selector inside a candidate; no nested frame or positional selector. */
export type BrowserRelativeLocateSelector = Omit<BrowserLocateSelector, 'filter'> & {
  readonly filter?: BrowserRelativeLocateFilter
}

/** Up to three relative selector steps inside each candidate element. */
export type BrowserRelativeLocateQuery = BrowserRelativeLocateSelector & {
  readonly scopes?: readonly BrowserRelativeLocateSelector[]
}

/** A selector chain within the top document or explicit same-origin frames. */
export interface BrowserLocateQuery extends BrowserLocateSelector {
  readonly frames?: readonly string[]
  readonly scopes?: readonly BrowserLocateSelector[]
  readonly projection?: 'visible' | 'enabled' | 'checked' | 'text' | 'textContent' | 'allTextContents' | 'attribute' | 'downloadUrl'
  readonly attributeName?: string
  readonly position?: { readonly method: 'first' | 'last' | 'nth'; readonly index?: number }
  readonly combine?: { readonly method: 'and' | 'or'; readonly query: BrowserLocateQuery }
}

/** Count, at most one document-bound reference, or a bounded ordered text list. */
export interface BrowserLocateResult {
  readonly url: string
  readonly title: string
  readonly count: number
  readonly texts?: readonly string[]
  readonly rows: readonly {
    readonly ref: string
    readonly role: string
    readonly name: string
    readonly visible?: boolean
    readonly enabled?: boolean
    readonly checked?: boolean
    readonly text?: string
    readonly textContent?: string
    readonly attribute?: string | null
    readonly downloadUrl?: string
  }[]
}

/** Checked CSS-pixel target for a single approved foreign-frame element. */
export interface BrowserForeignRefPoint {
  readonly url: string
  readonly title: string
  readonly x: number
  readonly y: number
  readonly fingerprint: string
  readonly origin: string
  /** Known link or form destination; null when no static target is exposed. */
  readonly targetUrl: string | null
}

/** Verified focus state for one approved foreign text field; excludes its value. */
export interface BrowserForeignInputState {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly hadText: boolean
}

/** Trusted native paste receipt for one approved foreign editor. */
export interface BrowserForeignPasteState extends BrowserForeignInputState {
  readonly pasteConfirmed: boolean
}

/** Confirmed values of one approved foreign select, bounded for the plugin. */
export interface BrowserForeignOptionResult {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly selected: readonly string[]
}

/** Focus and known navigation targets for one approved foreign key recipient. */
export interface BrowserForeignKeyState {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly targetUrls: readonly string[]
}

/** Confirmed selection in one approved foreign frame; excludes the selected text. */
export interface BrowserForeignSelectionResult {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly selected: true
}

/** Bounded state for one fixed secondary action in an approved foreign frame. */
export interface BrowserForeignSecondaryState {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly expanded?: 'true' | 'false'
}

/** Opaque hit check for one approved coordinate along a native drag path. */
export interface BrowserDragPoint {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly targetFingerprint: string
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
  /** Fixed locator in an explicitly selected, approved foreign frame. Null means the path stayed same-origin. */
  readonly foreignFrameLocateVersion?: 1
  locateForeign?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    query: BrowserLocateQuery, approvedOrigins: readonly string[]): Promise<BrowserLocateResult | null>
  /** Revalidate one approved foreign ref and map it to the selected guest viewport. */
  readonly foreignFramePointVersion?: 1
  foreignRefPoint?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[]): Promise<BrowserForeignRefPoint>
  /** Focus or verify one visible, approved foreign text field without exporting its value. */
  readonly foreignFrameInputVersion?: 1
  foreignInputState?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[], phase: 'select' | 'verify' | 'focus' | 'check',
    value?: string): Promise<BrowserForeignInputState>
  /** Extends foreignInputState with focus/check phases for append typing. */
  readonly foreignFrameTypeVersion?: 1
  /** Next native download from the exact selected Browser guest. */
  readonly downloadVersion?: 1
  beginDownload?(lease: DesktopBrowserLeaseId, expectedUrl: string, target?: string): Promise<string>
  pollDownload?(lease: DesktopBrowserLeaseId, token: string): Promise<BrowserDownloadStatus>
  resumeDownload?(lease: DesktopBrowserLeaseId, token: string, origins: readonly string[]): Promise<void>
  cancelDownload?(lease: DesktopBrowserLeaseId, token: string): Promise<void>
  finishDownload?(lease: DesktopBrowserLeaseId, token: string): Promise<void>
  /** One intercepted native file input for an approved selected guest. */
  readonly fileChooserVersion?: 1
  beginFileChooser?(lease: DesktopBrowserLeaseId, expectedUrl: string): Promise<string>
  pollFileChooser?(lease: DesktopBrowserLeaseId, token: string): Promise<BrowserFileChooserStatus>
  setFileChooserFiles?(lease: DesktopBrowserLeaseId, token: string,
    origin: string, files: readonly string[]): Promise<void>
  cancelFileChooser?(lease: DesktopBrowserLeaseId, token: string): Promise<void>
  /** Short clipboard lease for one confirmed rich-text paste. */
  readonly richPasteVersion?: 1
  beginPaste?(lease: DesktopBrowserLeaseId, expectedUrl: string, payload: {
    readonly text: string; readonly format: 'html'; readonly plainText: string
  }): Promise<string>
  finishPaste?(lease: DesktopBrowserLeaseId, token: string): Promise<{
    readonly restored: boolean; readonly superseded: boolean }>
  foreignPasteState?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[],
    phase: 'arm' | 'check' | 'result' | 'cleanup', receipt: string): Promise<BrowserForeignPasteState>
  /** Bounded native HTML drag in the caller's exact-URL guest. */
  readonly nativeDragVersion?: 1
  dragPoint?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    x: number, y: number, approvedOrigins: readonly string[]): Promise<BrowserDragPoint>
  beginDrag?(lease: DesktopBrowserLeaseId, expectedUrl: string): Promise<string>
  finishDrag?(lease: DesktopBrowserLeaseId, token: string,
    point?: { readonly x: number; readonly y: number }): Promise<{ readonly dropped: boolean }>
  /** Fixed exact-option selection in one approved foreign frame. */
  readonly foreignFrameOptionVersion?: 1
  selectForeignOption?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[], options: readonly {
      readonly value?: string; readonly label?: string; readonly index?: number
    }[]): Promise<BrowserForeignOptionResult>
  /** Fixed key target preflight and focus checks in one approved foreign frame. */
  readonly foreignFrameKeyVersion?: 1
  foreignKeyState?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[], key: string,
    phase: 'target' | 'focus' | 'check'): Promise<BrowserForeignKeyState>
  /** Select one exact, unique text occurrence in an approved foreign frame. */
  readonly foreignFrameSelectionVersion?: 1
  selectForeignText?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[], selection: {
      readonly text: string; readonly prefix?: string; readonly suffix?: string;
      readonly selectionType?: 'text' | 'cursor_before' | 'cursor_after'
    }): Promise<BrowserForeignSelectionResult>
  /** Inspect or focus one approved foreign target for a fixed secondary action. */
  readonly foreignFrameSecondaryVersion?: 1
  foreignSecondaryState?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[],
    action: 'focus' | 'showmenu' | 'expand' | 'collapse' | 'increment' | 'decrement'):
    Promise<BrowserForeignSecondaryState>
  /** Native guest capture after all current frame origins have received exact-site grants. */
  readonly foreignFrameCaptureVersion?: 1
  captureFrameAware?(lease: DesktopBrowserLeaseId, expectedUrl: string,
    clip: { readonly x: number; readonly y: number; readonly width: number;
      readonly height: number } | undefined, fullPage: boolean,
    approvedOrigins: readonly string[]): Promise<{ readonly url: string; readonly title: string;
      readonly base64: string; readonly viewport: { readonly width: number;
        readonly height: number } }>
  armNavigationPreflight?(lease: DesktopBrowserLeaseId, clientId: string, sessionId: string,
    tabId: string, navigationEpoch: number, expectedUrl: string): Promise<void>
  resolveNavigationPreflight?(token: string, allowed: boolean): Promise<void>
  onNavigationIntent?(listener: (intent: DesktopBrowserNavigationIntent) => void): () => void
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
