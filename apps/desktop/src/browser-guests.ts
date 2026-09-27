/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, clipboard, ClipboardItem, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserInitialPreflight, DesktopBrowserOccurrence, DesktopBrowserLeaseId, DesktopBrowserOpenRequest,
  DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import { BrowserNavigationPreflight } from './browser-navigation-preflight.ts'
import { BrowserClipboardLease, type PastePayload, type RestoreResult } from './browser-clipboard.ts'
import { BrowserDragLease } from './browser-drag.ts'
import { BrowserFileChooserLease, type BrowserFileChooserStatus } from './browser-filechooser.ts'
import { BrowserDownloadLease } from './browser-download.ts'
import { BrowserDialogLease, type BrowserDialogInfo } from './browser-dialog.ts'
import type { BrowserDownloadStatus } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { auditBrowserFrames, readBrowserForeignText, captureBrowserFullPage,
  captureBrowserViewport, type BrowserFrameAudit, type BrowserForeignText,
  type BrowserFrameScreenshot, type BrowserScreenshotClip } from './browser-foreign-read.ts'
import { locateBrowserForeignFrame, pointForBrowserForeignRef,
  stateForBrowserForeignInput, selectBrowserForeignOption,
  stateForBrowserForeignKey, selectBrowserForeignText,
  stateForBrowserForeignSecondary, stateForBrowserForeignPaste, pointForBrowserDrag } from './browser-foreign-locate.ts'
import type { BrowserLocateResult, BrowserForeignRefPoint,
  BrowserForeignInputState, BrowserForeignOptionResult,
  BrowserForeignKeyState,
  BrowserForeignSelectionResult,
  BrowserForeignSecondaryState, BrowserForeignPasteState, BrowserDragPoint } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
  readonly initialPreflight?: DesktopBrowserInitialPreflight
  readonly blankClaim?: { readonly key: string; readonly value: DesktopBrowserInitialPreflight }
}

type DialogOwner = Pick<WebContents, 'isDestroyed'>
type DialogGuest = Parameters<BrowserDialogLease['begin']>[0]

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly blankClaims = new Map<string, { readonly owner: WebContents
    readonly value: DesktopBrowserInitialPreflight }>()
  private readonly navigationPreflight = new BrowserNavigationPreflight(DESKTOP_IPC.browserNavigationIntent)
  private readonly clipboardLease = new BrowserClipboardLease(clipboard, entries => new ClipboardItem(entries))
  private readonly dragLease = new BrowserDragLease()
  private readonly fileChooserLease = new BrowserFileChooserLease()
  private readonly downloadLease = new BrowserDownloadLease()
  private readonly dialogLease = new BrowserDialogLease()
  private readonly activeDialogs = new Map<DesktopBrowserLeaseId, string>()
  private readonly activeNavigations = new Set<string>()
  private activePaste: { readonly owner: WebContents; readonly lease: DesktopBrowserLeaseId; readonly token: string } | undefined
  private activeDrag: { readonly owner: WebContents
    readonly lease: DesktopBrowserLeaseId
    readonly token: string
    readonly expectedUrl: string } | undefined

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined,
    private readonly guestPreloadPath = '') {}

  private clearExpiredPaste(): void {
    if (this.activePaste !== undefined && this.clipboardLease.activeToken !== this.activePaste.token) {
      this.activePaste = undefined
    }
  }

  private clearExpiredDrag(): void {
    if (this.activeDrag !== undefined && this.dragLease.activeToken !== this.activeDrag.token) {
      this.activeDrag = undefined
    }
  }

  /**
   * Reserve one guest in a workspace's process-lifetime partition.
   * @param owner - authenticated primary application WebContents.
   * @param workspace - workspace identity received over IPC.
   * @returns opaque lease and the partition approved for it.
   */
  acquire(owner: WebContents, workspace: unknown, initialPreflight?: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    const direct = initialPreflight !== undefined && typeof initialPreflight === 'object' &&
      initialPreflight !== null && 'clientId' in initialPreflight
    if (initialPreflight !== undefined &&
      !(direct ? this.validInitialPreflight(initialPreflight) : this.validOccurrence(initialPreflight))) {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
    }
    const occurrence = direct || initialPreflight === undefined ? undefined
      : initialPreflight as DesktopBrowserOccurrence
    const key = occurrence === undefined ? undefined : this.blankClaimKey(owner,
      occurrence.sessionId, occurrence.tabId)
    const blankClaim = key === undefined ? undefined : this.blankClaims.get(key)
    if (blankClaim !== undefined && blankClaim.value.initialUrl !== occurrence?.initialUrl) {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
    }
    const guard = direct ? initialPreflight as DesktopBrowserInitialPreflight : blankClaim?.value
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false,
      ...(guard === undefined ? {} : { initialPreflight: guard }),
      ...(blankClaim === undefined || key === undefined ? {} : { blankClaim: {
        key, value: blankClaim.value } }) })
    return { lease, partition }
  }

  /**
   * Release only a lease issued to this application window; workspace storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    this.clearExpiredPaste()
    if (this.activePaste?.lease === key) await this.finishPaste(owner, key, this.activePaste.token)
    this.clearExpiredDrag()
    if (this.activeDrag?.lease === key) await this.finishDrag(owner, key, this.activeDrag.token)
    const dialogToken = this.activeDialogs.get(key)
    if (dialogToken !== undefined) await this.finishDialog(owner, key, dialogToken)
    if (lease.guest !== undefined) this.downloadLease.cancelGuest(lease.guest)
    if (lease.guest !== undefined) await this.fileChooserLease.cancelGuest(lease.guest)
    lease.releaseInput?.()
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined) this.navigationPreflight.revokeGuest(guest)
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        ...(this.guestPreloadPath ? { preload: this.guestPreloadPath } : {}),
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      // Reject native dialogs unless one selected guest has a live, origin-scoped watch.
      this.dialogLease.installNativeDialogGuard(guest,
        (sourceUrl, type, respond) => this.offerNativeDialog(guest, sourceUrl, type, respond))
      let attachedLease: DesktopBrowserLeaseId | undefined
      guest.on('did-navigate', (_event, url) => { this.navigationPreflight.commit(guest, url) })
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        guest.once('destroyed', () => {
          if (this.activePaste?.lease === id) {
            void this.finishPaste(owner, id, this.activePaste.token).catch(() => {})
          }
          if (this.activeDrag?.lease === id) {
            void this.finishDrag(owner, id, this.activeDrag.token).catch(() => {})
          }
          this.downloadLease.cancelGuest(guest)
          void this.fileChooserLease.cancelGuest(guest).catch(() => {})
          lease.releaseInput?.(); this.navigationPreflight.revokeGuest(guest); this.leases.delete(id)
        })
        if (lease.initialPreflight !== undefined) {
          const claim = lease.initialPreflight
          try {
            this.navigationPreflight.arm(owner, guest, id, claim.clientId,
              claim.sessionId, claim.tabId, 0, 'about:blank', claim.initialUrl)
            const blankClaim = lease.blankClaim
            if (blankClaim !== undefined) {
              guest.on('did-navigate', (_event, url) => {
                if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) return
                const current = this.blankClaims.get(blankClaim.key)
                if (current?.value === blankClaim.value) this.blankClaims.delete(blankClaim.key)
              })
            }
          } catch {
            guest.close({ waitForBeforeUnload: false })
            return
          }
        }
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const sourceLease = attachedLease
          const open = (): void => {
            const request: DesktopBrowserOpenRequest = { lease: sourceLease, url: new URL(url).href }
            owner.send(DESKTOP_IPC.browserOpenRequested, request)
          }
          if (!this.navigationPreflight.interceptPopup(guest, url, open)) open()
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [key, claim] of this.blankClaims) {
        if (claim.owner === owner) this.blankClaims.delete(key)
      }
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event, item, contents) => {
      if (!this.downloadLease.offer(item, contents)) event.preventDefault()
    })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      const forbidden = network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol)
      if (forbidden) { callback({ cancel: true }); return }
      if (this.navigationPreflight.intercept(details.webContentsId, details.resourceType,
        details.url, details.method, callback)) return
      callback({ cancel: false })
    })
  }

  /** Watch only this owned guest for an action-triggered JavaScript modal. */
  async beginDialog(owner: DialogOwner, id: unknown, expectedUrl: unknown,
    approvedPromptOrigins?: unknown): Promise<string> {
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl)) {
      throw new Error('SIDEBAR_DIALOG_UNAVAILABLE')
    }
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    if (approvedPromptOrigins !== undefined && (!Array.isArray(approvedPromptOrigins) ||
      !approvedPromptOrigins.every(origin => typeof origin === 'string'))) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    if (approvedPromptOrigins !== undefined) {
      auditBrowserFrames(guest, expectedUrl, approvedPromptOrigins)
    }
    const previous = this.activeDialogs.get(key)
    if (previous !== undefined) {
      try { this.dialogLease.get(previous); throw new Error('SIDEBAR_DIALOG_BUSY') }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'SIDEBAR_DIALOG_LEASE_UNAVAILABLE') throw error
        this.activeDialogs.delete(key)
      }
    }
    const dragOwned = this.dragLease.ownsGuest(guest)
    const token = await this.dialogLease.begin(guest, expectedUrl, approvedPromptOrigins,
      this.fileChooserLease.ownsGuest(guest) || dragOwned)
    if (dragOwned) this.dragLease.extendForDialog(guest)
    this.activeDialogs.set(key, token)
    return token
  }

  /** Accept a prompt only from a currently watched, owned guest frame. */
  offerPrompt(guest: DialogGuest, sourceUrl: string | undefined,
    respond: (answer: string | null | { readonly useDefault: true }) => void): void {
    if (typeof sourceUrl !== 'string') { respond(null); return }
    for (const [key, token] of this.activeDialogs) {
      const lease = this.leases.get(key)
      if (lease?.guest === guest && lease.attached && !lease.owner.isDestroyed() &&
        this.dialogLease.offerPrompt(token, sourceUrl, respond)) return
    }
    respond(null)
  }

  /** Hold only top-level or approved same-origin guest alert/confirm shims. */
  offerGuestDialog(guest: DialogGuest, sourceUrl: string | undefined, type: unknown,
    respond: (answer: boolean | undefined) => void): void {
    if (typeof sourceUrl !== 'string' || (type !== 'alert' && type !== 'confirm')) {
      respond(type === 'confirm' ? false : undefined)
      return
    }
    for (const [key, token] of this.activeDialogs) {
      const lease = this.leases.get(key)
      if (lease?.guest === guest && lease.attached && !lease.owner.isDestroyed() &&
        this.dialogLease.offerGuestDialog(token, sourceUrl, type, respond)) return
    }
    respond(type === 'confirm' ? false : undefined)
  }

  /** Route Electron's held child-frame dialog only through the current approved action lease. */
  private offerNativeDialog(guest: DialogGuest, sourceUrl: string, type: 'alert' | 'confirm' | 'prompt',
    respond: (action: 'accept' | 'dismiss', text?: string) => void): boolean {
    for (const [key, token] of this.activeDialogs) {
      const lease = this.leases.get(key)
      if (lease?.guest === guest && lease.attached && !lease.owner.isDestroyed() &&
        this.dialogLease.offerNativeDialog(token, sourceUrl, type, respond)) return true
    }
    return false
  }

  /** One fixed, URL-bound navigation per active dialog watch; page code cannot replace the isolated-world method. */
  navigate(owner: WebContents, id: unknown, token: unknown, expectedUrl: unknown,
    method: unknown, destination: unknown): void {
    const key = this.dialogToken(owner, id, token)
    const guest = this.leases.get(key)?.guest
    if (guest === undefined || guest.isDestroyed() || guest.isLoadingMainFrame() ||
      typeof expectedUrl !== 'string' || guest.getURL() !== expectedUrl ||
      !this.allowedNavigation(expectedUrl) ||
      !['goto', 'back', 'forward'].includes(method as string) ||
      (method === 'goto' && (typeof destination !== 'string' || !this.allowedNavigation(destination) ||
        new URL(destination).href !== destination)) ||
      (method !== 'goto' && destination !== undefined) ||
      this.dialogLease.get(token as string) !== null || this.activeNavigations.has(token as string)) {
      throw new Error('SIDEBAR_NAVIGATION_UNAVAILABLE')
    }
    this.activeNavigations.add(token as string)
    try {
      if (method === 'goto' && destination === expectedUrl) {
        guest.reload()
        return
      }
      const command = method === 'goto' ? `location.assign(${JSON.stringify(destination)})`
        : method === 'back' ? 'history.back()' : 'history.forward()'
      const code = `(() => {
        if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
        ${command};
      })()`
      // Page unload can destroy the evaluation context while the navigation
      // succeeds. The Client reports success only from observed guest events.
      void guest.executeJavaScriptInIsolatedWorld(1001, [{ code }]).catch(() => {})
    } catch (error) {
      this.activeNavigations.delete(token as string)
      throw error
    }
  }

  /** Read only a modal handle and type; its page-provided text stays in the guest. */
  getDialog(owner: DialogOwner, id: unknown, token: unknown): BrowserDialogInfo | null {
    this.dialogToken(owner, id, token)
    return this.dialogLease.get(token as string)
  }

  /** Await a dialog without exposing raw CDP commands to the renderer. */
  waitDialog(owner: DialogOwner, id: unknown, token: unknown, timeoutMs: unknown): Promise<BrowserDialogInfo | null> {
    this.dialogToken(owner, id, token)
    if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
      throw new Error('SIDEBAR_DIALOG_WAIT_UNAVAILABLE')
    }
    return this.dialogLease.wait(token as string, typeof timeoutMs === 'number' ? timeoutMs : 5000)
  }

  /** Resolve one matching handle; a stale handle cannot control a newer dialog. */
  async handleDialog(owner: DialogOwner, id: unknown, token: unknown, dialogId: unknown,
    action: unknown, text: unknown): Promise<true | void> {
    const key = this.dialogToken(owner, id, token)
    if (typeof dialogId !== 'string' || !['accept', 'dismiss'].includes(action as string) ||
      text !== undefined && typeof text !== 'string') throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    const replayed = await this.dialogLease.handle(token as string, dialogId, action as 'accept' | 'dismiss', text)
    this.activeDialogs.delete(key)
    this.activeNavigations.delete(token as string)
    return replayed
  }

  /** Abandon a watch and dismiss any open modal so the guest is not left blocked. */
  async finishDialog(owner: DialogOwner, id: unknown, token: unknown): Promise<void> {
    const key = this.dialogToken(owner, id, token)
    const drag = this.activeDrag
    // Invalidate the drop synchronously, then dismiss the modal before sending
    // CDP drag-cancellation commands that cannot complete while it is open.
    if (drag?.lease === key) this.dragLease.invalidate(drag.token)
    this.activeDialogs.delete(key)
    this.activeNavigations.delete(token as string)
    try { await this.dialogLease.close(token as string) }
    finally {
      if (drag?.lease === key) {
        try { await this.dragLease.cancel(drag.token).catch(() => {}) }
        finally { if (this.activeDrag === drag) this.activeDrag = undefined }
      }
    }
  }

  private dialogToken(owner: DialogOwner, id: unknown, token: unknown): DesktopBrowserLeaseId {
    if (typeof id !== 'string' || typeof token !== 'string') throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined || lease.owner !== owner || this.activeDialogs.get(key) !== token) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    return key
  }

  /** Keep an exact one-use claim until a matching guest commits or the owner closes. */
  reserveBlankNavigationPreflight(owner: WebContents, clientId: unknown, sessionId: unknown,
    tabId: unknown, initialUrl: unknown): void {
    const value = { clientId, sessionId, tabId, initialUrl }
    if (!this.validInitialPreflight(value) || owner.isDestroyed()) {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
    }
    const key = this.blankClaimKey(owner, value.sessionId, value.tabId)
    if (this.blankClaims.has(key) || [...this.blankClaims.values()].filter(row => row.owner === owner).length >= 16) {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_BUSY')
    }
    this.blankClaims.set(key, { owner, value })
  }

  cancelBlankNavigationPreflight(owner: WebContents, clientId: unknown, sessionId: unknown,
    tabId: unknown, initialUrl: unknown): void {
    const value = { clientId, sessionId, tabId, initialUrl }
    if (!this.validInitialPreflight(value)) throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
    const key = this.blankClaimKey(owner, value.sessionId, value.tabId)
    const claim = this.blankClaims.get(key)
    if (claim?.owner === owner && claim.value.clientId === value.clientId &&
      claim.value.initialUrl === value.initialUrl) this.blankClaims.delete(key)
  }

  private blankClaimKey(owner: WebContents, sessionId: string, tabId: string): string {
    return `${owner.id}\0${sessionId}\0${tabId}`
  }

  /** Audit only the named live guest; the plugin authorizes returned origins before reading. */
  auditFrames(owner: WebContents, id: unknown, expectedUrl: unknown): BrowserFrameAudit {
    const guest = this.readableGuest(owner, id, expectedUrl)
    return auditBrowserFrames(guest, expectedUrl as string)
  }

  /** Return bounded text only after the plugin has authorized every current frame origin. */
  inspectForeignText(owner: WebContents, id: unknown, expectedUrl: unknown,
    approvedOrigins: unknown): Promise<BrowserForeignText> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    return readBrowserForeignText(guest, expectedUrl as string, approvedOrigins as string[])
  }

  /** Resolve only a fixed, bounded locator against the caller's approved guest frame. */
  async locateForeign(owner: WebContents, id: unknown, expectedUrl: unknown,
    query: unknown, approvedOrigins: unknown): Promise<BrowserLocateResult | null> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await locateBrowserForeignFrame(guest, expectedUrl as string,
        query, approvedOrigins as string[])
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Resolve one fingerprinted foreign element to a checked point in its owned guest. */
  async foreignRefPoint(owner: WebContents, id: unknown, expectedUrl: unknown,
    ref: unknown, approvedOrigins: unknown): Promise<BrowserForeignRefPoint> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await pointForBrowserForeignRef(guest, expectedUrl as string,
        ref, approvedOrigins as string[])
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Focus or verify one approved foreign text field under the current owner lease. */
  async foreignInputState(owner: WebContents, id: unknown, expectedUrl: unknown,
    ref: unknown, approvedOrigins: unknown, phase: unknown,
    value: unknown): Promise<BrowserForeignInputState> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await stateForBrowserForeignInput(guest, expectedUrl as string,
        ref, approvedOrigins as string[], phase, value)
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Select exact options in one approved foreign frame under the current owner lease. */
  async selectForeignOption(owner: WebContents, id: unknown, expectedUrl: unknown,
    ref: unknown, approvedOrigins: unknown, options: unknown): Promise<BrowserForeignOptionResult> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await selectBrowserForeignOption(guest, expectedUrl as string,
        ref, approvedOrigins as string[], options)
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Preflight or verify an approved foreign key recipient under the current owner lease. */
  async foreignKeyState(owner: WebContents, id: unknown, expectedUrl: unknown,
    ref: unknown, approvedOrigins: unknown, key: unknown,
    phase: unknown): Promise<BrowserForeignKeyState> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await stateForBrowserForeignKey(guest, expectedUrl as string,
        ref, approvedOrigins as string[], key, phase)
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Select one exact occurrence in an approved foreign frame under the current owner lease. */
  async selectForeignText(owner: WebContents, id: unknown, expectedUrl: unknown,
    ref: unknown, approvedOrigins: unknown, selection: unknown): Promise<BrowserForeignSelectionResult> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await selectBrowserForeignText(guest, expectedUrl as string,
        ref, approvedOrigins as string[], selection)
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Revalidate one approved foreign secondary target under the current owner lease. */
  async foreignSecondaryState(owner: WebContents, id: unknown, expectedUrl: unknown,
    ref: unknown, approvedOrigins: unknown, action: unknown): Promise<BrowserForeignSecondaryState> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await stateForBrowserForeignSecondary(guest, expectedUrl as string,
        ref, approvedOrigins as string[], action)
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Intercept one native file input for this owned, exact-URL guest. */
  async beginFileChooser(owner: WebContents, id: unknown, expectedUrl: unknown): Promise<string> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    return this.fileChooserLease.begin(guest, expectedUrl as string)
  }

  /** Reveal only the intercepted input's frame origin and multiplicity. */
  pollFileChooser(owner: WebContents, id: unknown, token: unknown): BrowserFileChooserStatus {
    const guest = typeof id === 'string' ? this.leases.get(id as DesktopBrowserLeaseId)?.guest : undefined
    if (typeof token !== 'string' || guest === undefined ||
      this.leases.get(id as DesktopBrowserLeaseId)?.owner !== owner ||
      !this.fileChooserLease.owns(token, guest)) throw new Error('SIDEBAR_FILECHOOSER_LEASE_UNAVAILABLE')
    return this.fileChooserLease.poll(token)
  }

  /** Supply approved regular files to that single intercepted input. */
  async setFileChooserFiles(owner: WebContents, id: unknown, token: unknown,
    origin: unknown, files: unknown): Promise<void> {
    const status = this.pollFileChooser(owner, id, token)
    if (status.state !== 'offered' || typeof origin !== 'string' || status.origin !== origin ||
      !Array.isArray(files) || files.some(file => typeof file !== 'string')) {
      throw new Error('SIDEBAR_FILECHOOSER_LEASE_UNAVAILABLE')
    }
    await this.fileChooserLease.setFiles(token as string, origin, files as string[])
  }

  async cancelFileChooser(owner: WebContents, id: unknown, token: unknown): Promise<void> {
    this.pollFileChooser(owner, id, token)
    await this.fileChooserLease.cancel(token as string)
  }

  /** Arm only the caller's live, exact-URL guest for its next download. */
  beginDownload(owner: WebContents, id: unknown, expectedUrl: unknown, target?: unknown): string {
    if (target !== undefined && (typeof target !== 'string' ||
      target.length > 16_384 || !this.allowedNavigation(target) ||
      new URL(target).href !== target)) throw new Error('SIDEBAR_DOWNLOAD_UNAVAILABLE')
    const guest = this.readableGuest(owner, id, expectedUrl)
    return this.downloadLease.begin(guest, expectedUrl as string, target)
  }

  /** Report a ticket's bounded state only to its owning guest and window. */
  pollDownload(owner: WebContents, id: unknown, token: unknown): BrowserDownloadStatus {
    const guest = typeof id === 'string' ? this.leases.get(id as DesktopBrowserLeaseId)?.guest : undefined
    if (typeof token !== 'string' || guest === undefined ||
      this.leases.get(id as DesktopBrowserLeaseId)?.owner !== owner ||
      !this.downloadLease.owns(token, guest)) throw new Error('SIDEBAR_DOWNLOAD_LEASE_UNAVAILABLE')
    return this.downloadLease.poll(token)
  }

  /** Resume only after the plugin obtained every exact source and redirect origin. */
  resumeDownload(owner: WebContents, id: unknown, token: unknown, origins: unknown): void {
    if (!Array.isArray(origins) || origins.length < 1 || origins.length > 16 ||
      origins.some(origin => typeof origin !== 'string' || !URL.canParse(origin) ||
        !['http:', 'https:'].includes(new URL(origin).protocol) || new URL(origin).origin !== origin)) {
      throw new Error('SIDEBAR_DOWNLOAD_SITE_NOT_APPROVED')
    }
    this.pollDownload(owner, id, token)
    this.downloadLease.resume(token as string, origins as string[])
  }

  /** Cancel one owned ticket and remove its unconsumed private output. */
  cancelDownload(owner: WebContents, id: unknown, token: unknown): void {
    const lease = typeof id === 'string' ? this.leases.get(id as DesktopBrowserLeaseId) : undefined
    if (typeof token !== 'string' || lease?.owner !== owner || lease.guest === undefined ||
      !this.downloadLease.owns(token, lease.guest)) throw new Error('SIDEBAR_DOWNLOAD_LEASE_UNAVAILABLE')
    this.downloadLease.cancel(token)
  }

  /** Release a completed ticket while retaining its approved file for the caller. */
  finishDownload(owner: WebContents, id: unknown, token: unknown): void {
    if (this.pollDownload(owner, id, token).state !== 'completed') {
      throw new Error('SIDEBAR_DOWNLOAD_LEASE_UNAVAILABLE')
    }
    this.downloadLease.finish(token as string)
  }

  /** Stage one short, bounded HTML paste for the caller's live exact-URL guest. */
  async beginPaste(owner: WebContents, id: unknown, expectedUrl: unknown, payload: unknown): Promise<string> {
    this.clearExpiredPaste()
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl) ||
      typeof payload !== 'object' || payload === null || Array.isArray(payload) ||
      Object.keys(payload).some(key => !['text', 'format', 'plainText'].includes(key)) ||
      !('text' in payload) || !('format' in payload) || !('plainText' in payload) ||
      typeof payload.text !== 'string' || payload.format !== 'html' ||
      typeof payload.plainText !== 'string') throw new Error('SIDEBAR_PASTE_UNAVAILABLE')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed() || guest.getURL() !== expectedUrl || guest.isLoadingMainFrame() ||
      this.activePaste !== undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    const navigation = { changed: false }
    const invalidate = (): void => { navigation.changed = true }
    guest.on('did-start-navigation', invalidate)
    guest.on('destroyed', invalidate)
    try {
      const token = await this.clipboardLease.begin(payload as PastePayload)
      if (navigation.changed || this.leases.get(key) !== lease || lease.guest !== guest || guest.isDestroyed() ||
        guest.getURL() !== expectedUrl || owner.isDestroyed()) {
        await this.clipboardLease.finish(token)
        throw new Error('SIDEBAR_NAVIGATED')
      }
      this.activePaste = { owner, lease: key, token }
      return token
    } finally {
      guest.off('did-start-navigation', invalidate)
      guest.off('destroyed', invalidate)
    }
  }

  /** Restore the saved formats unless a newer copy replaced the staged paste. */
  async finishPaste(owner: WebContents, id: unknown, token: unknown): Promise<RestoreResult> {
    this.clearExpiredPaste()
    const active = this.activePaste
    if (typeof id !== 'string' || typeof token !== 'string' || active === undefined ||
      active.owner !== owner || active.lease !== id || active.token !== token) {
      throw new Error('SIDEBAR_CLIPBOARD_LEASE_UNAVAILABLE')
    }
    try { return await this.clipboardLease.finish(token) }
    finally { if (this.activePaste === active) this.activePaste = undefined }
  }

  /** Arm or inspect a trusted paste receipt inside one approved foreign frame. */
  async foreignPasteState(owner: WebContents, id: unknown, expectedUrl: unknown,
    ref: unknown, approvedOrigins: unknown, phase: unknown, receipt: unknown): Promise<BrowserForeignPasteState> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await stateForBrowserForeignPaste(guest, expectedUrl as string,
        ref, approvedOrigins as string[], phase, receipt)
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Begin one short native drag lease in the caller's exact-URL guest. */
  async beginDrag(owner: WebContents, id: unknown, expectedUrl: unknown): Promise<string> {
    this.clearExpiredDrag()
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl)) {
      throw new Error('SIDEBAR_DRAG_UNAVAILABLE')
    }
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl ||
      this.activeDrag !== undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    const token = await this.dragLease.begin(guest, expectedUrl)
    if (this.leases.get(key) !== lease || lease.guest !== guest || guest.isDestroyed() ||
      guest.getURL() !== expectedUrl || owner.isDestroyed()) {
      await this.dragLease.cancel(token)
      throw new Error('SIDEBAR_NAVIGATED')
    }
    this.activeDrag = { owner, lease: key, token, expectedUrl }
    return token
  }

  /** Deliver captured page drag data only to the same guest and checked point. */
  async finishDrag(owner: WebContents, id: unknown, token: unknown,
    point?: unknown): Promise<{ readonly dropped: boolean }> {
    this.clearExpiredDrag()
    const active = this.activeDrag
    if (typeof id !== 'string' || typeof token !== 'string' || active === undefined ||
      active.owner !== owner || active.lease !== id || active.token !== token) {
      throw new Error('SIDEBAR_DRAG_LEASE_UNAVAILABLE')
    }
    try { return await this.dragLease.finish(token, active.expectedUrl, point) }
    finally { if (this.activeDrag === active) this.activeDrag = undefined }
  }

  /** Revalidate a drag pixel through the approved native frame tree. */
  async dragPoint(owner: WebContents, id: unknown, expectedUrl: unknown,
    x: unknown, y: unknown, approvedOrigins: unknown): Promise<BrowserDragPoint> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (!Array.isArray(approvedOrigins) || approvedOrigins.length < 1 || approvedOrigins.length > 100 ||
      approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const navigation = { changed: false }
    const markChanged = (): void => { navigation.changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await pointForBrowserDrag(guest, expectedUrl as string, x, y,
        approvedOrigins as string[])
      if (navigation.changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
        lease?.guest !== guest || owner.isDestroyed()) throw new Error('SIDEBAR_NAVIGATED')
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Capture only approved pixels of the named guest, never another tab or window. */
  captureFrameAware(owner: WebContents, id: unknown, expectedUrl: unknown, clip: unknown,
    fullPage: unknown, approvedOrigins: unknown): Promise<BrowserFrameScreenshot> {
    const guest = this.readableGuest(owner, id, expectedUrl)
    if (typeof fullPage !== 'boolean' || clip !== undefined && (typeof clip !== 'object' ||
      clip === null || Array.isArray(clip) || Object.keys(clip).length !== 4 ||
      !['x', 'y', 'width', 'height'].every(key => key in clip)) ||
      !Array.isArray(approvedOrigins) || approvedOrigins.length < 1 ||
      approvedOrigins.length > 100 || approvedOrigins.some(origin => typeof origin !== 'string')) {
      throw new Error('SIDEBAR_IMAGE_UNAVAILABLE')
    }
    const siteList = approvedOrigins as string[]
    return fullPage
      ? captureBrowserFullPage(guest, expectedUrl as string, clip as BrowserScreenshotClip | undefined, siteList)
      : captureBrowserViewport(guest, expectedUrl as string, clip as BrowserScreenshotClip | undefined, siteList)
  }

  private readableGuest(owner: WebContents, id: unknown, expectedUrl: unknown): WebContents {
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' ||
      expectedUrl.length > 16_384 || !this.allowedNavigation(expectedUrl)) {
      throw new Error('SIDEBAR_FRAME_UNAVAILABLE')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      owner.isDestroyed() || guest.isDestroyed() || guest.isLoadingMainFrame() ||
      guest.getURL() !== expectedUrl) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    return guest
  }

  /** A plugin can arm only a guest lease issued to this authenticated application window. */
  armNavigationPreflight(owner: WebContents, id: unknown, clientId: unknown, sessionId: unknown,
    tabId: unknown, navigationEpoch: unknown, expectedUrl: unknown): void {
    if (typeof id !== 'string' || typeof clientId !== 'string' ||
      !/^[a-f0-9-]{36}$/iu.test(clientId) ||
      typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 256 ||
      typeof tabId !== 'string' || tabId.length < 1 || tabId.length > 256 ||
      typeof navigationEpoch !== 'number' || !Number.isSafeInteger(navigationEpoch) ||
      typeof expectedUrl !== 'string' || expectedUrl.length > 16_384 ||
      !this.allowedNavigation(expectedUrl)) {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    this.navigationPreflight.arm(owner, guest, id, clientId, sessionId, tabId,
      navigationEpoch, expectedUrl)
  }

  /** A held request can be released only by its owning application window. */
  resolveNavigationPreflight(owner: WebContents, token: unknown, allowed: unknown): void {
    if (typeof token !== 'string' || typeof allowed !== 'boolean') {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
    }
    this.navigationPreflight.resolve(token, owner, allowed)
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private validInitialPreflight(value: unknown): value is DesktopBrowserInitialPreflight {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    return Object.keys(row).length === 4 &&
      ['clientId', 'sessionId', 'tabId', 'initialUrl'].every(key => typeof row[key] === 'string') &&
      /^[a-f0-9-]{36}$/iu.test(row.clientId as string) &&
      (row.sessionId as string).length > 0 && (row.sessionId as string).length <= 256 &&
      (row.tabId as string).length > 0 && (row.tabId as string).length <= 256 &&
      (row.initialUrl as string).length <= 16_384 && this.allowedNavigation(row.initialUrl as string)
  }

  private validOccurrence(value: unknown): value is DesktopBrowserOccurrence {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    return Object.keys(row).length === 3 &&
      ['sessionId', 'tabId', 'initialUrl'].every(key => typeof row[key] === 'string') &&
      (row.sessionId as string).length > 0 && (row.sessionId as string).length <= 256 &&
      (row.tabId as string).length > 0 && (row.tabId as string).length <= 256 &&
      (row.initialUrl as string).length <= 16_384 && this.allowedNavigation(row.initialUrl as string)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
