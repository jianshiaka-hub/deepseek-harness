/** Carrier-neutral page navigation and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserTarget } from './url.ts'

/** A loading failure, optionally carrying the underlying browser's diagnostic. */
export interface BrowserLoadError {
  readonly code: number | undefined
  readonly description: string | undefined
}

/** State consumed by common browser chrome, without DOM or carrier identifiers. */
export interface BrowserFrameState {
  readonly target: BrowserTarget | undefined
  readonly address: 'empty' | 'requested' | 'observed' | 'unknown'
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: BrowserLoadError | undefined
  /** Undefined when this provider does not expose a sandbox control. */
  readonly sandboxEnabled: boolean | undefined
}

/** Optional iframe policy control, not an Electron process-sandbox switch. */
export interface BrowserSandboxControl {
  /** @param enabled - whether the provider's embedding sandbox is enforced. */
  setEnabled(enabled: boolean): void
}

/** Fixed action accepted by a selected desktop document. */
export type BrowserDomAction =
  | {
    readonly op: 'click'
    readonly ref?: string
    readonly x?: number
    readonly y?: number
    readonly button?: 'left' | 'middle' | 'right'
    readonly count?: number
    /** Exact source origins approved before a coordinate click can enter a foreign frame. */
    readonly approvedFrameOrigins?: readonly string[]
    /** Internal precondition for an exposed expand/collapse action. */
    readonly expectedExpanded?: 'true' | 'false'
    /** Require the same interactive role that was exposed by inspection. */
    readonly exposedRoleOnly?: boolean
  }
  | {
    readonly op: 'type'
    readonly ref?: string
    readonly text: string
    readonly sequential?: true
    readonly approvedFrameOrigins?: readonly string[]
  }
  | {
    readonly op: 'paste'
    readonly ref?: string
    readonly text: string
    readonly format: 'text' | 'md' | 'html'
  }
  | {
    readonly op: 'drag'
    readonly x: number
    readonly y: number
    readonly to: { readonly x: number; readonly y: number }
  }
  | {
    readonly op: 'setValue'
    readonly ref: string
    readonly value: string
    readonly approvedFrameOrigins?: readonly string[]
  }
  | {
    readonly op: 'selectOption'
    readonly ref: string
    readonly options: readonly BrowserOptionSelector[]
    readonly approvedFrameOrigins?: readonly string[]
  }
  | {
    readonly op: 'selectText'
    readonly ref: string
    readonly text: string
    readonly prefix?: string
    readonly suffix?: string
    readonly selectionType?: 'text' | 'cursor_before' | 'cursor_after'
    readonly approvedFrameOrigins?: readonly string[]
  }
  | {
    readonly op: 'secondary'
    readonly ref: string
    readonly action: 'focus' | 'showmenu' | 'expand' | 'collapse' | 'increment' | 'decrement'
    readonly approvedFrameOrigins?: readonly string[]
  }
  | {
    readonly op: 'key'
    readonly ref?: string
    readonly key: string
    readonly numericOnly?: boolean
    readonly approvedFrameOrigins?: readonly string[]
  }
  | {
    readonly op: 'scroll'
    readonly ref: string
    readonly dx: number
    readonly dy: number
    readonly approvedFrameOrigins?: readonly string[]
  }
  /** Agent navigation runs in the current page so Chromium can emit beforeunload. */
  | { readonly op: 'navigate'; readonly method: 'goto' | 'back' | 'forward'; readonly url?: string }

/** Acknowledgement without content from a possibly navigated document. */
export interface BrowserDomActionResult {
  readonly url: string
  readonly title: string
  readonly performed: true
  readonly clipboardRestored?: boolean
  readonly clipboardSuperseded?: boolean
  /** True only when Chromium dispatched the intercepted HTML drag data to the destination. */
  readonly dropDispatched?: boolean
  readonly selected?: readonly string[]
}

/** One bounded option matcher; every supplied field must match the same option. */
export interface BrowserOptionSelector {
  readonly value?: string
  readonly label?: string
  readonly index?: number
}

export type { BrowserPageScreenshot, BrowserScreenshotClip } from '../../types.ts'
import type { BrowserJsDialog, BrowserPageScreenshot, BrowserScreenshotClip, BrowserLocateQuery, BrowserLocateResult } from '../../types.ts'
export type { BrowserLocateSelector, BrowserRelativeLocateFilter, BrowserRelativeLocateSelector, BrowserRelativeLocateQuery, BrowserLocateQuery, BrowserLocateResult } from '../../types.ts'

/** A modal can interrupt an otherwise pending native input command. */
export interface BrowserDomDialogResult extends BrowserDomActionResult {
  readonly dialog?: BrowserJsDialog
}

/** Only the modal type and opaque handle leave the guest. */
export interface BrowserDialogState {
  readonly url: string
  readonly title: string
  readonly dialog: BrowserJsDialog | null
}

/** Navigation owns page lifetime; mounting and hiding belong to BrowserPresentation. */
export interface BrowserFrame extends HostObservable<BrowserFrameState> {
  readonly sandbox?: BrowserSandboxControl
  /** Inspect only the observed top-level HTTP(S) document in a desktop guest. */
  inspect?(expectedUrl: string, approvedOrigins?: readonly string[]): Promise<{
    readonly url: string
    readonly title: string
    readonly text: string
  }>
  /** List only source origins in the selected guest for a subsequent site-grant check. */
  frameOrigins?(expectedUrl: string): Promise<{ readonly url: string; readonly title: string; readonly origins: readonly string[] }>
  /** Query bounded DOM nodes in the observed guest without executing caller JavaScript. */
  locate?(expectedUrl: string, query: BrowserLocateQuery,
    approvedOrigins?: readonly string[]): Promise<BrowserLocateResult>
  /** Capture the observed guest's viewport or full page. */
  screenshot?(expectedUrl: string, clip?: BrowserScreenshotClip, fullPage?: boolean,
    approvedOrigins?: readonly string[]): Promise<BrowserPageScreenshot>
  /** Perform a fixed action on the same observed desktop document. */
  action?(expectedUrl: string, action: BrowserDomAction, stillSelected?: () => boolean): Promise<BrowserDomActionResult>
  /** Register a bounded CDP watch before sending agent input, so modal actions can return. */
  actionWithDialog?(expectedUrl: string, action: BrowserDomAction,
    stillSelected: () => boolean): Promise<BrowserDomDialogResult>
  /** Read or resolve the modal opened by the preceding watched action. */
  pendingDialogUrl?(): string | undefined
  dialog?(expectedUrl: string, stillSelected: () => boolean): Promise<BrowserDialogState>
  handleDialog?(expectedUrl: string, dialogId: string, action: 'accept' | 'dismiss',
    text: string | undefined, stillSelected: () => boolean): Promise<BrowserDomActionResult>
  /** @param target - validated HTTP(S) address; loading failures are published in state. */
  loadUrl(target: BrowserTarget): void
  /** Move backward when the provider reports an available entry. */
  goBack(): void
  /** Move forward when the provider reports an available entry. */
  goForward(): void
  /** Reload the current address without creating a new history entry. */
  reload(): void
  /** @returns after the page, listeners and pending initialization have been released; repeated calls join disposal. */
  dispose(): Promise<void>
}

/**
 * Create idle navigation state without a page target.
 * @returns state before any page has been requested.
 */
export function emptyBrowserFrame(): BrowserFrameState {
  return { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
    error: undefined, sandboxEnabled: undefined }
}
