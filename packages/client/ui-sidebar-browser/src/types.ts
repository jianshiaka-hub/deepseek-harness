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

/** Bounded PNG of the selected guest; viewport is the captured coordinate extent. */
export interface BrowserPageScreenshot {
  readonly url: string
  readonly title: string
  readonly base64: string
  readonly viewport: { readonly width: number; readonly height: number }
}

/** Only approved-current-tab source origins and a digest of the native frame tree. */
export interface BrowserFrameAudit {
  readonly origins: readonly string[]
  readonly fingerprint: string
}

/** Bounded visible text from currently approved foreign child frames. */
export interface BrowserForeignText {
  readonly fingerprint: string
  readonly frames: readonly { readonly origin: string; readonly text: string; readonly roles: string }[]
}

/** One bounded selector and optional local filter over the approved document. */
export interface BrowserLocateSelector {
  readonly method: 'getByRole' | 'locator' | 'getByText' | 'getByLabel' | 'getByPlaceholder' | 'getByAltText' | 'getByTitle' | 'getByTestId'
  readonly value: string
  readonly name?: string
  readonly exact: boolean
  readonly filter?: {
    readonly hasText?: string
    readonly hasNotText?: string
    readonly visible?: boolean
    readonly has?: BrowserRelativeLocateQuery
    readonly hasNot?: BrowserRelativeLocateQuery
  }
}

/** Local filters allowed within a relative locator, without another descendant query. */
export interface BrowserRelativeLocateFilter {
  readonly hasText?: string
  readonly hasNotText?: string
  readonly visible?: boolean
}

/** One selector inside a candidate; no nested frame or locator-valued filter. */
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
  readonly projection?: 'visible' | 'enabled' | 'checked' | 'text'
  readonly position?: { readonly method: 'first' | 'last' | 'nth'; readonly index?: number }
  readonly combine?: { readonly method: 'and' | 'or'; readonly query: BrowserLocateQuery }
}

/** Count of matches and at most one document-bound reference or requested state. */
export interface BrowserLocateResult {
  readonly url: string
  readonly title: string
  readonly count: number
  readonly rows: readonly {
    readonly ref: string
    readonly role: string
    readonly name: string
    readonly visible?: boolean
    readonly enabled?: boolean
    readonly checked?: boolean
    readonly text?: string
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
}

/** Bounded acknowledgement for preparing or verifying one foreign text field. */
export interface BrowserForeignInputState {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly hadText: boolean
}

/** Bounded result of selecting options in one approved foreign select element. */
export interface BrowserForeignOptionResult {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
  readonly selected: readonly string[]
}

/** Bounded matcher for a single HTML option. */
export interface BrowserForeignOptionSelector {
  readonly value?: string
  readonly label?: string
  readonly index?: number
}

/** Bounded acknowledgement for a text selection inside one approved foreign frame. */
export interface BrowserForeignSelectionResult {
  readonly url: string
  readonly title: string
  readonly origin: string
  readonly fingerprint: string
}

/** Exact text and optional context required for one bounded foreign selection. */
export interface BrowserForeignSelectionSpec {
  readonly text: string
  readonly prefix?: string
  readonly suffix?: string
  readonly selectionType?: 'text' | 'cursor_before' | 'cursor_after'
}

/** CSS-pixel rectangle within the selected page's capture extent. */
export interface BrowserScreenshotClip {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Opaque handle for a modal opened by this guest; page text stays in the guest. */
export interface BrowserJsDialog {
  readonly id: string
  readonly type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** List current frame origins or verify a supplied exact-origin grant set. */
  auditFrames(lease: DesktopBrowserLeaseId, expectedUrl: string,
    approvedOrigins?: readonly string[]): Promise<BrowserFrameAudit>
  /** Read bounded body text from exact-origin approved foreign frames. */
  inspectForeignText(lease: DesktopBrowserLeaseId, expectedUrl: string,
    approvedOrigins: readonly string[]): Promise<BrowserForeignText>
  /** Query one explicitly selected foreign frame after checking every embedded source. */
  locateForeign(lease: DesktopBrowserLeaseId, expectedUrl: string,
    query: BrowserLocateQuery, approvedOrigins: readonly string[]): Promise<BrowserLocateResult>
  /** Revalidate one foreign element ref and resolve its visible point in the top guest viewport. */
  foreignRefPoint(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[]): Promise<BrowserForeignRefPoint>
  /** Select/verify a foreign text field, or focus/check an editable or key target. */
  foreignInputState(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[],
    phase: 'select' | 'verify' | 'focus' | 'check' | 'keyFocus' | 'keyCheck',
    value?: string): Promise<BrowserForeignInputState>
  /** Select unique enabled options in one approved foreign select element. */
  selectForeignOption(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[],
    options: readonly BrowserForeignOptionSelector[]): Promise<BrowserForeignOptionResult>
  /** Select one exact text match within an approved foreign element. */
  selectForeignText(lease: DesktopBrowserLeaseId, expectedUrl: string,
    ref: string, approvedOrigins: readonly string[],
    spec: BrowserForeignSelectionSpec): Promise<BrowserForeignSelectionResult>
  /** Capture the current viewport with native frame-event and site checks. */
  captureViewport(lease: DesktopBrowserLeaseId, expectedUrl: string, clip?: BrowserScreenshotClip,
    approvedOrigins?: readonly string[]): Promise<BrowserPageScreenshot>
  /** Capture the exact owned guest's full page after its caller checks the selected tab and frame origin. */
  captureFullPage(lease: DesktopBrowserLeaseId, expectedUrl: string, clip?: BrowserScreenshotClip,
    approvedOrigins?: readonly string[]): Promise<BrowserPageScreenshot>
  /** Temporarily stage a confirmed paste for this exact guest URL. */
  beginPaste(lease: DesktopBrowserLeaseId, expectedUrl: string,
    payload: { readonly text: string; readonly format: 'text' | 'md' | 'html'; readonly plainText?: string }): Promise<string>
  /** Restore the prior clipboard, or leave a newer user copy intact. */
  finishPaste(lease: DesktopBrowserLeaseId, token: string): Promise<{ readonly restored: boolean; readonly superseded: boolean }>
  /** Intercept only a native drag from the exact owned guest for a short lease. */
  beginDrag(lease: DesktopBrowserLeaseId, expectedUrl: string): Promise<string>
  /** Drop at a checked viewport point; omit it to cancel and release the native drag. */
  finishDrag(lease: DesktopBrowserLeaseId, token: string,
    point?: { readonly x: number; readonly y: number }): Promise<{ readonly dropped: boolean }>
  /** Arm the exact guest before an approved action can open a JavaScript modal. */
  beginDialog(lease: DesktopBrowserLeaseId, expectedUrl: string): Promise<string>
  /** Dispatch one fixed navigation in the owned guest's isolated world after arming its dialog watch. */
  navigate(lease: DesktopBrowserLeaseId, token: string, expectedUrl: string,
    method: 'goto' | 'back' | 'forward', destination?: string): Promise<void>
  /** Inspect the current modal without reading its page-provided message. */
  getDialog(lease: DesktopBrowserLeaseId, token: string): Promise<BrowserJsDialog | null>
  /** Wait briefly for a modal from the action that follows beginDialog. */
  waitDialog(lease: DesktopBrowserLeaseId, token: string, timeoutMs?: number): Promise<BrowserJsDialog | null>
  /** Confirm or dismiss one matching modal. */
  handleDialog(lease: DesktopBrowserLeaseId, token: string, dialogId: string,
    action: 'accept' | 'dismiss', text?: string): Promise<void>
  /** Disarm and dismiss a still-open modal when the action or selection ends. */
  finishDialog(lease: DesktopBrowserLeaseId, token: string): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
