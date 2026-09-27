/** Composition of one navigation provider and its presentation. */
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'
import type { BrowserFrame } from './BrowserFrame.ts'
import type { BrowserTabState } from './BrowserPersistence.ts'
import type { DesktopBrowserInitialPreflight } from '../../types.ts'

/** Provider construction inputs; persistence does not enter the live navigation interface. */
export interface BrowserPageOptions {
  readonly initial: BrowserTabState | undefined
  readonly occurrence?: { readonly sessionId: string; readonly tabId: string }
  readonly initialPreflight?: DesktopBrowserInitialPreflight
  readonly persist: (state: BrowserTabState) => void
  readonly openRequested: (url: string) => void
}

/** The owning controller disposes frame; UI mounts only presentation. */
export interface BrowserPage {
  readonly frame: BrowserFrame
  readonly presentation: BrowserPresentation
}

/** Construct an idle provider without attaching DOM; saved navigation waits for an explicit frame command. */
export type BrowserPageFactory = (options: BrowserPageOptions) => BrowserPage
