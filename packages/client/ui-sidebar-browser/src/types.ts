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
