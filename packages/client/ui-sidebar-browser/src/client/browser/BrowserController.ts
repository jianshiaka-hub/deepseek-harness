/** Carrier-independent tab commands and renderer-facing state. */
import { createSnapshotStore, type BoundActions, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserDialogState, BrowserDomAction, BrowserDomActionResult, BrowserDomDialogResult, BrowserFrameState, BrowserLocateQuery, BrowserLocateResult, BrowserPageScreenshot, BrowserScreenshotClip } from './BrowserFrame.ts'
import type { BrowserPage, BrowserPageFactory } from './BrowserPage.ts'
import { currentBrowserTarget, type BrowserTabState } from './BrowserPersistence.ts'
import type { BrowserStore } from './store.ts'
import { parseBrowserAddress, type BrowserAddressFailure, type BrowserTarget } from './url.ts'

/** Live tab state; navigation comes from its provider and draft validation stays local. */
export interface BrowserControllerState {
  readonly frame: BrowserFrameState
  /** Saved address offered for explicit restoration before any page has been requested. */
  readonly restoreTarget: BrowserTarget | undefined
  readonly addressFailure: BrowserAddressFailure | undefined
  readonly addressRevision: number
}

/** Construction inputs for one tab occurrence. */
export interface BrowserControllerOptions {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly actions: BoundActions<BrowserStore>
  readonly createPage: BrowserPageFactory
  readonly openTab: (url: string) => void
}

/** Owns input validation and page lifetime without inspecting the carrier type. */
export class BrowserController implements HostObservable<BrowserControllerState> {
  private readonly page: BrowserPage
  private readonly store: SnapshotStore<BrowserControllerState>
  private readonly unsubscribe: () => void
  private actions: BoundActions<BrowserStore>
  private checkpoint: BrowserTabState | undefined
  private started = false
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly abort = (): void => { void this.dispose() }

  /** @param options - identity, persistence, page factory and source-tab navigation. */
  constructor(private readonly options: BrowserControllerOptions) {
    this.actions = options.actions
    this.checkpoint = options.initial
    this.page = options.createPage({
      initial: options.initial,
      persist: (state) => {
        if (this.disposed) return
        this.checkpoint = state
        this.actions.replace(options.tabId, state)
      },
      openRequested: (value) => {
        if (this.disposed) return
        const result = parseBrowserAddress(value, options.applicationOrigin)
        if (!result.ok) { this.addressFailed(result.reason); return }
        options.openTab(result.target.url)
      },
    })
    this.store = createSnapshotStore({ frame: this.page.frame.getSnapshot(),
      restoreTarget: currentBrowserTarget(this.checkpoint), addressFailure: undefined, addressRevision: 0 })
    this.unsubscribe = this.page.frame.subscribe(() => {
      if (this.disposed) return
      const current = this.store.getSnapshot()
      const frame = this.page.frame.getSnapshot()
      const changed = frame.target?.url !== current.frame.target?.url
      this.store.set({ frame, restoreTarget: frame.target === undefined ? currentBrowserTarget(this.checkpoint) : undefined,
        addressFailure: changed ? undefined : current.addressFailure,
        addressRevision: current.addressRevision + Number(changed) })
    })
    options.signal.addEventListener('abort', this.abort, { once: true })
  }

  /**
   * Inspect a mounted desktop page only while its observed URL matches.
   * @param expectedUrl - exact URL approved by the Host.
   * @returns bounded page text, same-origin frame labels and title.
   */
  inspect(expectedUrl: string): Promise<{ readonly url: string; readonly title: string; readonly text: string }> {
    if (this.disposed || this.page.frame.inspect === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    return this.page.frame.inspect(expectedUrl)
  }

  /**
   * List embedded source origins in the selected document for per-site approval.
   * @param expectedUrl - Exact selected-tab URL approved by the Host.
   * @returns Only bounded website origins, with the selected tab identity.
   */
  frameOrigins(expectedUrl: string): Promise<{ readonly url: string; readonly title: string; readonly origins: readonly string[] }> {
    if (this.disposed || this.page.frame.frameOrigins === undefined) throw new Error('SIDEBAR_FRAME_AUDIT_UNAVAILABLE')
    return this.page.frame.frameOrigins(expectedUrl)
  }

  /**
   * Query the approved selected document with a bounded locator.
   * @param expectedUrl - Exact observed URL approved by the Host.
   * @param query - Selector steps and optional one-field projection.
   * @returns Match count and at most one document-bound element reference.
   */
  locate(expectedUrl: string, query: BrowserLocateQuery): Promise<BrowserLocateResult> {
    if (this.disposed || this.page.frame.locate === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    return this.page.frame.locate(expectedUrl, query)
  }

  /**
   * Capture the selected desktop guest after its website grant, rejecting cross-origin frames.
   * @param expectedUrl - exact observed URL approved by the Host.
   * @param clip - optional rectangle within the viewport or full page.
   * @param fullPage - capture the complete CSS page when true.
   * @param approvedOrigins - exact frame origins already approved by the Host.
   * @returns PNG bytes and CSS viewport or page dimensions.
   */
  screenshot(expectedUrl: string, clip?: BrowserScreenshotClip, fullPage?: boolean,
    approvedOrigins?: readonly string[]): Promise<BrowserPageScreenshot> {
    if (this.disposed || this.page.frame.screenshot === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    return this.page.frame.screenshot(expectedUrl, clip, fullPage, approvedOrigins)
  }

  /**
   * Perform one fixed desktop action while this occurrence remains live.
   * @param expectedUrl - exact observed URL approved by the Host.
   * @param action - allow-listed ref action with bounded arguments.
   * @param stillSelected - rejects input if the owning Sidebar tab loses selection.
   * @returns acknowledgement without new page content.
   */
  action(expectedUrl: string, action: BrowserDomAction, stillSelected?: () => boolean): Promise<BrowserDomDialogResult> {
    if (this.disposed || this.page.frame.action === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    if (this.page.frame.actionWithDialog !== undefined) {
      return this.page.frame.actionWithDialog(expectedUrl, action, stillSelected ?? (() => true))
    }
    return this.page.frame.action(expectedUrl, action, stillSelected)
  }

  /**
   * Read a pending modal on the same approved guest without disclosing its page text.
   * @param expectedUrl - Exact observed URL approved by the Host.
   * @param stillSelected - Rejects a changed Sidebar selection.
   * @returns Modal type and opaque handle, or no pending modal.
   */
  dialog(expectedUrl: string, stillSelected: () => boolean): Promise<BrowserDialogState> {
    if (this.disposed || this.page.frame.dialog === undefined) throw new Error('SIDEBAR_DIALOG_UNAVAILABLE')
    return this.page.frame.dialog(expectedUrl, stillSelected)
  }

  /**
   * Identify the still-pending modal's approved page without reading its content.
   * @returns The observed URL bound to the modal, if one remains.
   */
  pendingDialogUrl(): string | undefined {
    return this.disposed ? undefined : this.page.frame.pendingDialogUrl?.()
  }

  /**
   * Answer one pending modal while its guest and approved URL remain selected.
   * @param expectedUrl - Exact observed URL approved by the Host.
   * @param dialogId - Opaque handle returned for this guest's pending modal.
   * @param action - Accept or dismiss the modal.
   * @param text - Replacement text for a prompt acceptance, when provided.
   * @param stillSelected - Rejects a changed Sidebar selection.
   * @returns Acknowledgement or a newly pending modal.
   */
  handleDialog(expectedUrl: string, dialogId: string, action: 'accept' | 'dismiss',
    text: string | undefined, stillSelected: () => boolean): Promise<BrowserDomActionResult> {
    if (this.disposed || this.page.frame.handleDialog === undefined) throw new Error('SIDEBAR_DIALOG_UNAVAILABLE')
    return this.page.frame.handleDialog(expectedUrl, dialogId, action, text, stillSelected)
  }

  /**
   * Navigate only the still-selected desktop occurrence and acknowledge its observed destination.
   * @param expectedUrl - exact currently observed URL approved by the Host.
   * @param destination - canonical HTTP(S) target whose origin was approved before navigation.
   * @param stillSelected - revokes navigation if the user switches or closes the tab.
   * @returns destination URL and title without page body; the Host checks redirected origins before release.
   */
  navigate(expectedUrl: string, destination: string, stillSelected: () => boolean): Promise<BrowserDomDialogResult> {
    const parsed = parseBrowserAddress(destination, this.options.applicationOrigin)
    if (!parsed.ok || parsed.target.url !== destination) throw new Error('SIDEBAR_URL_UNAVAILABLE')
    if (this.page.frame.actionWithDialog !== undefined) {
      return this.page.frame.actionWithDialog(expectedUrl,
        { op: 'navigate', method: 'goto', url: destination }, stillSelected)
    }
    return this.awaitSelectedNavigation(expectedUrl, stillSelected, () => { this.loadUrl(destination) })
  }

  /**
   * Move through existing native history while the same Sidebar guest remains selected.
   * @param expectedUrl - Exact currently observed URL approved by the Host.
   * @param direction - Backward or forward through that guest's history.
   * @param stillSelected - Rejects navigation after the user switches or closes the tab.
   * @returns Destination URL and title; the Host checks its site grant before release.
   */
  navigateHistory(expectedUrl: string, direction: 'back' | 'forward',
    stillSelected: () => boolean): Promise<BrowserDomDialogResult> {
    const initial = this.store.getSnapshot().frame
    if (direction === 'back' ? !initial.canGoBack : !initial.canGoForward) {
      throw new Error('SIDEBAR_HISTORY_UNAVAILABLE')
    }
    if (this.page.frame.actionWithDialog !== undefined) {
      return this.page.frame.actionWithDialog(expectedUrl,
        { op: 'navigate', method: direction }, stillSelected)
    }
    return this.awaitSelectedNavigation(expectedUrl, stillSelected, () => {
      if (direction === 'back') this.goBack()
      else this.goForward()
    })
  }

  private awaitSelectedNavigation(expectedUrl: string, stillSelected: () => boolean,
    start: () => void): Promise<BrowserDomActionResult> {
    const initial = this.store.getSnapshot().frame
    if (this.disposed || initial.address !== 'observed' || initial.loading ||
      initial.target?.url !== expectedUrl || !stillSelected()) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    return new Promise((resolve, reject) => {
      let settled = false
      let started = false
      const finish = (outcome: { readonly error: Error } | { readonly value: BrowserDomActionResult }): void => {
        if (settled) return
        settled = true
        unsubscribe()
        clearInterval(selectionCheck)
        clearTimeout(timeout)
        this.options.signal.removeEventListener('abort', onAbort)
        if ('error' in outcome) reject(outcome.error)
        else resolve(outcome.value)
      }
      const check = (): void => {
        if (this.disposed || !stillSelected()) { finish({ error: new Error('SIDEBAR_SELECTION_CHANGED') }); return }
        const state = this.store.getSnapshot()
        if (state.frame.loading || state.frame.address === 'requested') started = true
        if (state.addressFailure !== undefined || state.frame.error !== undefined ||
          state.frame.address === 'unknown' && !state.frame.loading) {
          finish({ error: new Error('SIDEBAR_NAVIGATION_FAILED') }); return
        }
        if (started && state.frame.address === 'observed' && !state.frame.loading && state.frame.target !== undefined) {
          finish({ value: { url: state.frame.target.url, title: state.frame.target.title.slice(0, 512), performed: true } })
        }
      }
      const onAbort = (): void => { finish({ error: new Error('SIDEBAR_TAB_UNAVAILABLE') }) }
      const timeout = setTimeout(() => { finish({ error: new Error('SIDEBAR_NAVIGATION_TIMEOUT') }) }, 12_000)
      const selectionCheck = setInterval(check, 50)
      this.options.signal.addEventListener('abort', onAbort, { once: true })
      const unsubscribe = this.subscribe(check)
      try { start(); check() }
      catch (error) { finish({ error: error instanceof Error ? error : new Error('SIDEBAR_NAVIGATION_FAILED') }) }
    })
  }

  /** @returns immutable state for the common toolbar. */
  getSnapshot = (): BrowserControllerState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /**
   * Attach the page without transferring ownership of its tab occurrence.
   * @param viewportId - mounted content container.
   * @returns physical attachment cleanup only.
   */
  mount(viewportId: string): () => void {
    this.publishSaved()
    return this.page.presentation.mount(viewportId)
  }

  /**
   * Consume initial navigation once; a saved checkpoint alone never starts a page.
   * @param initialUrl - explicit typed-open address, or absence.
   */
  start(initialUrl: string | undefined): void {
    if (this.started || this.disposed) return
    this.started = true
    if (initialUrl !== undefined) this.loadUrl(initialUrl)
  }

  /** Load the saved address only after an explicit restore action. */
  restore(): void {
    const target = this.store.getSnapshot().restoreTarget
    if (target !== undefined) this.loadUrl(target.url)
  }

  /**
   * Validate an address before navigation, publishing invalid input for correction.
   * @param value - address-bar or typed-open input.
   */
  loadUrl(value: string): void {
    if (this.disposed) return
    const parsed = parseBrowserAddress(value, this.options.applicationOrigin)
    if (!parsed.ok) { this.addressFailed(parsed.reason); return }
    this.command(() => { this.page.frame.loadUrl(parsed.target) })
  }

  /** Delegate Back to the page's navigation provider. */
  goBack(): void { this.command(() => { this.page.frame.goBack() }) }
  /** Delegate Forward to the page's navigation provider. */
  goForward(): void { this.command(() => { this.page.frame.goForward() }) }
  /** Restore a saved address, or reload the already requested page. */
  reload(): void {
    if (this.store.getSnapshot().restoreTarget !== undefined) this.restore()
    else this.command(() => { this.page.frame.reload() })
  }

  /**
   * Apply the optional embedding-sandbox control; unsupported providers remain unchanged.
   * @param enabled - whether to enforce the provider's embedding sandbox.
   */
  setSandbox(enabled: boolean): void {
    const sandbox = this.page.frame.sandbox
    if (sandbox !== undefined) this.command(() => { sandbox.setEnabled(enabled) })
  }

  /**
   * Redirect future checkpoint writes to a replacement Session binding.
   * @param actions - replacement persistence writer.
   */
  rebind(actions: BoundActions<BrowserStore>): void { this.actions = actions }

  /**
   * Release the page and detach occurrence and state listeners.
   * @returns after page teardown; repeated callers join the same disposal.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.options.signal.removeEventListener('abort', this.abort)
    this.unsubscribe()
    this.disposal = this.page.frame.dispose()
    return this.disposal
  }

  private publishSaved(): void {
    if (this.checkpoint !== undefined) this.actions.replace(this.options.tabId, this.checkpoint)
  }

  private addressFailed(reason: BrowserAddressFailure): void {
    this.store.set({ ...this.store.getSnapshot(), addressFailure: reason })
  }

  private command(run: () => void): void {
    if (this.disposed) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, addressFailure: undefined, addressRevision: current.addressRevision + 1 })
    run()
  }
}

/** Values available once a Sidebar body has committed its content container. */
export interface BrowserMountRequest {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly viewportId: string
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly initialUrl: string | undefined
  readonly openTab: (url: string) => void
}

/** Plain Slot callbacks and a framework-bound state source, not a desktop protocol. */
export interface BrowserInjected {
  /** Latest state for one mounted tab without opening another tab. */
  snapshot(tabId: TabId): BrowserControllerState | undefined
  /** Inspect one mounted desktop tab. */
  inspect(tabId: TabId, expectedUrl: string): Promise<{ readonly url: string; readonly title: string; readonly text: string }>
  frameOrigins(tabId: TabId, expectedUrl: string): Promise<{
    readonly url: string
    readonly title: string
    readonly origins: readonly string[]
  }>
  /** Query a bounded set of DOM nodes in the selected desktop tab. */
  locate(tabId: TabId, expectedUrl: string, query: BrowserLocateQuery): Promise<BrowserLocateResult>
  /** Capture the visible viewport of one mounted desktop tab. */
  screenshot(tabId: TabId, expectedUrl: string, clip?: BrowserScreenshotClip, fullPage?: boolean,
    approvedOrigins?: readonly string[]): Promise<BrowserPageScreenshot>
  /** Perform one fixed action on a mounted desktop tab. */
  action(tabId: TabId, expectedUrl: string, action: BrowserDomAction, stillSelected?: () => boolean): Promise<BrowserDomDialogResult>
  /** Read or resolve a modal from the immediately preceding watched action. */
  dialog(tabId: TabId, expectedUrl: string, stillSelected: () => boolean): Promise<BrowserDialogState>
  /** Exact old URL while a confirmed action waits on its JavaScript modal. */
  pendingDialogUrl(tabId: TabId): string | undefined
  handleDialog(tabId: TabId, expectedUrl: string, dialogId: string, action: 'accept' | 'dismiss',
    text: string | undefined, stillSelected: () => boolean): Promise<BrowserDomActionResult>
  /** Navigate the selected occurrence after Host approval and report only its observed destination. */
  navigate(tabId: TabId, expectedUrl: string, destination: string, stillSelected: () => boolean): Promise<BrowserDomDialogResult>
  /** Traverse native history and report only the observed destination. */
  navigateHistory(tabId: TabId, expectedUrl: string, direction: 'back' | 'forward', stillSelected: () => boolean): Promise<BrowserDomDialogResult>
  readonly keyedHooks: {
    readonly browserState: (key: string) => HostObservable<BrowserControllerState> | undefined
  }
  /** @param request - committed tab and container. @returns ends physical attachment without closing the tab. */
  mount(request: BrowserMountRequest): () => void
  /** @returns after every page has been disposed. */
  dispose(): Promise<void>
  /** @param actions - writer from a recreated Session binding. */
  rebind(actions: BoundActions<BrowserStore>): void
  /** @param tabId - owning tab. @param value - address input. */
  loadUrl(tabId: TabId, value: string): void
  /** @param tabId - tab whose saved address the user requested to restore. */
  restore(tabId: TabId): void
  /** @param tabId - owning tab. */
  goBack(tabId: TabId): void
  /** @param tabId - owning tab. */
  goForward(tabId: TabId): void
  /** Restore a saved address or reload its page. @param tabId - owning tab. */
  reload(tabId: TabId): void
  /** @param tabId - owning tab. @param enabled - provider's optional sandbox control. */
  setSandbox(tabId: TabId, enabled: boolean): void
}

/**
 * Own tab-occurrence controllers behind Session-scoped callbacks.
 * @param actions - persisted view-state writer.
 * @param createPage - composition-selected provider.
 * @param isTabOpen - authoritative layout membership, independent of mounted bodies and plugin lifetime.
 * @param onChanged - notify the selected-tab reporter after state or lifetime changes.
 * @returns tab callbacks.
 */
export function createBrowserControllers(actions: BoundActions<BrowserStore>, createPage: BrowserPageFactory,
  isTabOpen: (tabId: TabId) => boolean, onChanged: () => void = () => {}): BrowserInjected {
  let currentActions = actions
  const controllers = new Map<TabId, {
    readonly signal: AbortSignal
    readonly controller: BrowserController
    readonly forget: () => void
    readonly unsubscribe: () => void
  }>()
  const controller = (id: TabId): BrowserController | undefined => controllers.get(id)?.controller
  return {
    keyedHooks: { browserState: key => controller(key as TabId) },
    snapshot: id => controller(id)?.getSnapshot(),
    inspect: (id, expectedUrl) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.inspect(expectedUrl) },
    frameOrigins: (id, expectedUrl) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.frameOrigins(expectedUrl) },
    locate: (id, expectedUrl, query) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.locate(expectedUrl, query) },
    screenshot: (id, expectedUrl, clip, fullPage, approvedOrigins) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.screenshot(expectedUrl, clip, fullPage, approvedOrigins) },
    action: (id, expectedUrl, action, stillSelected) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.action(expectedUrl, action, stillSelected) },
    dialog: (id, expectedUrl, stillSelected) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.dialog(expectedUrl, stillSelected) },
    pendingDialogUrl: id => controller(id)?.pendingDialogUrl(),
    handleDialog: (id, expectedUrl, dialogId, action, text, stillSelected) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.handleDialog(expectedUrl, dialogId, action, text, stillSelected) },
    navigate: (id, expectedUrl, destination, stillSelected) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.navigate(expectedUrl, destination, stillSelected) },
    navigateHistory: (id, expectedUrl, direction, stillSelected) => { const found = controller(id); if (found === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE'); return found.navigateHistory(expectedUrl, direction, stillSelected) },
    mount(request) {
      const { tabId, signal } = request
      if (signal.aborted) return () => {}
      let held = controllers.get(tabId)
      if (held?.signal !== signal) {
        if (held !== undefined) {
          held.signal.removeEventListener('abort', held.forget)
          held.unsubscribe()
          void held.controller.dispose()
        }
        const created = new BrowserController({ ...request, actions: currentActions, createPage })
        const unsubscribe = created.subscribe(onChanged)
        const forget = (): void => {
          unsubscribe()
          controllers.delete(tabId)
          onChanged()
          // Plugin unload also aborts occurrences; only layout removal deletes saved navigation.
          if (!isTabOpen(tabId)) currentActions.forget(tabId)
        }
        held = { signal, controller: created, forget, unsubscribe }
        controllers.set(tabId, held)
        onChanged()
        signal.addEventListener('abort', forget, { once: true })
      }
      const hide = held.controller.mount(request.viewportId)
      held.controller.start(request.initialUrl)
      return hide
    },
    dispose: async () => {
      const pending = [...controllers.values()].map(({ signal, controller, forget, unsubscribe }) => {
        signal.removeEventListener('abort', forget)
        unsubscribe()
        return controller.dispose()
      })
      controllers.clear()
      await Promise.all(pending)
      onChanged()
    },
    rebind: (actions) => {
      currentActions = actions
      for (const { controller } of controllers.values()) controller.rebind(actions)
    },
    loadUrl: (id, value) => { controller(id)?.loadUrl(value) },
    restore: (id) => { controller(id)?.restore() },
    goBack: (id) => { controller(id)?.goBack() },
    goForward: (id) => { controller(id)?.goForward() },
    reload: (id) => { controller(id)?.reload() },
    setSandbox: (id, enabled) => { controller(id)?.setSandbox(enabled) },
  }
}
