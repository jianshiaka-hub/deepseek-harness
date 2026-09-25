/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, clipboard, ClipboardItem, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { BrowserPageScreenshot, BrowserScreenshotClip, DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import { auditBrowserFrames, captureBrowserFullPage, captureBrowserViewport, readBrowserForeignText,
  type BrowserForeignText, type BrowserFrameAudit } from './browser-full-page.ts'
import { BrowserClipboardLease, type PastePayload, type RestoreResult } from './browser-clipboard.ts'
import { BrowserDragLease } from './browser-drag.ts'
import { BrowserDialogLease, type BrowserDialogInfo } from './browser-dialog.ts'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly clipboardLease = new BrowserClipboardLease(clipboard, entries => new ClipboardItem(entries))
  private readonly dragLease = new BrowserDragLease()
  private readonly dialogLease = new BrowserDialogLease()
  private readonly activeDialogs = new Map<DesktopBrowserLeaseId, string>()
  private readonly activeNavigations = new Set<string>()
  private activePaste: {
    readonly owner: WebContents
    readonly lease: DesktopBrowserLeaseId
    readonly token: string
  } | undefined
  private activeDrag: {
    readonly owner: WebContents
    readonly lease: DesktopBrowserLeaseId
    readonly token: string
    readonly expectedUrl: string
  } | undefined

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined,
    private readonly guestPreloadPath: string) {}

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
  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
      throw new Error('desktop browser: a workspace storage identity is required')
    }
    let partition = this.partitions.get(workspace)
    if (partition === undefined) {
      partition = `dsh-sidebar-browser-${randomUUID()}`
      this.configureSession(session.fromPartition(partition))
      this.partitions.set(workspace, partition)
    }
    const lease = randomUUID() as DesktopBrowserLeaseId
    this.leases.set(lease, { owner, partition, attached: false })
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
    lease.releaseInput?.()
    this.clearExpiredPaste()
    if (this.activePaste?.lease === key) await this.finishPaste(owner, key, this.activePaste.token)
    this.clearExpiredDrag()
    if (this.activeDrag?.lease === key) await this.finishDrag(owner, key, this.activeDrag.token)
    const dialogToken = this.activeDialogs.get(key)
    if (dialogToken !== undefined) await this.finishDialog(owner, key, dialogToken)
    this.leases.delete(key)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /** Stage a short native paste for only the caller's live, exact-URL guest. */
  async beginPaste(owner: WebContents, id: unknown, expectedUrl: unknown, payload: unknown): Promise<string> {
    this.clearExpiredPaste()
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl) ||
      typeof payload !== 'object' || payload === null || Array.isArray(payload) ||
      Object.keys(payload).some(key => !['text', 'format', 'plainText'].includes(key)) ||
      !('text' in payload) || !('format' in payload) ||
      typeof payload.text !== 'string' || typeof payload.format !== 'string' ||
      'plainText' in payload && payload.plainText !== undefined &&
        typeof payload.plainText !== 'string') throw new Error('SIDEBAR_PASTE_UNAVAILABLE')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed() || guest.getURL() !== expectedUrl || guest.isLoadingMainFrame() ||
      this.activePaste !== undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    let changed = false
    const invalidate = (): void => { changed = true }
    guest.on('did-start-navigation', invalidate)
    guest.on('destroyed', invalidate)
    try {
      const token = await this.clipboardLease.begin(payload as PastePayload)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest events can invalidate an awaited clipboard write.
      if (changed || this.leases.get(key) !== lease || lease.guest !== guest || guest.isDestroyed() ||
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

  /** Restore the prior clipboard unless a newer user copy replaced the staged paste. */
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

  /** Enable native HTML drag interception for this one owned, exact-URL guest. */
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

  /** Drop only into the same guest, or cancel without exposing captured page drag data. */
  async finishDrag(owner: WebContents, id: unknown, token: unknown, point?: unknown): Promise<{ readonly dropped: boolean }> {
    this.clearExpiredDrag()
    const active = this.activeDrag
    if (typeof id !== 'string' || typeof token !== 'string' || active === undefined ||
      active.owner !== owner || active.lease !== id || active.token !== token) {
      throw new Error('SIDEBAR_DRAG_LEASE_UNAVAILABLE')
    }
    try { return await this.dragLease.finish(token, active.expectedUrl, point) }
    finally { if (this.activeDrag === active) this.activeDrag = undefined }
  }

  /** Watch only this owned guest for an action-triggered JavaScript modal. */
  async beginDialog(owner: WebContents, id: unknown, expectedUrl: unknown): Promise<string> {
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
    const previous = this.activeDialogs.get(key)
    if (previous !== undefined) {
      try { this.dialogLease.get(previous); throw new Error('SIDEBAR_DIALOG_BUSY') }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'SIDEBAR_DIALOG_LEASE_UNAVAILABLE') throw error
        this.activeDialogs.delete(key)
      }
    }
    const token = await this.dialogLease.begin(guest, expectedUrl)
    this.activeDialogs.set(key, token)
    return token
  }

  /** Accept a prompt only from a currently watched, owned guest frame. */
  offerPrompt(guest: WebContents, sourceUrl: string | undefined,
    respond: (answer: string | null | { readonly useDefault: true }) => void): void {
    if (typeof sourceUrl !== 'string') { respond(null); return }
    for (const [key, token] of this.activeDialogs) {
      const lease = this.leases.get(key)
      if (lease?.guest === guest && lease.attached && !lease.owner.isDestroyed() &&
        this.dialogLease.offerPrompt(token, sourceUrl, respond)) return
    }
    respond(null)
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
    const command = method === 'goto'
      ? destination === expectedUrl ? 'location.reload()' : `location.assign(${JSON.stringify(destination)})`
      : method === 'back' ? 'history.back()' : 'history.forward()'
    const code = `(() => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('SIDEBAR_NAVIGATED');
      ${command};
    })()`
    this.activeNavigations.add(token as string)
    try {
      // Page unload can destroy the evaluation context while the navigation
      // succeeds. The Client reports success only from observed guest events.
      void guest.executeJavaScriptInIsolatedWorld(1001, [{ code }]).catch(() => {})
    } catch (error) {
      this.activeNavigations.delete(token as string)
      throw error
    }
  }

  /** Read only a modal handle and type; its page-provided text stays in the guest. */
  getDialog(owner: WebContents, id: unknown, token: unknown): BrowserDialogInfo | null {
    this.dialogToken(owner, id, token)
    return this.dialogLease.get(token as string)
  }

  /** Await a dialog without exposing raw CDP commands to the renderer. */
  waitDialog(owner: WebContents, id: unknown, token: unknown, timeoutMs: unknown): Promise<BrowserDialogInfo | null> {
    this.dialogToken(owner, id, token)
    if (timeoutMs !== undefined && typeof timeoutMs !== 'number') {
      throw new Error('SIDEBAR_DIALOG_WAIT_UNAVAILABLE')
    }
    return this.dialogLease.wait(token as string, typeof timeoutMs === 'number' ? timeoutMs : 5000)
  }

  /** Resolve one matching handle; a stale handle cannot control a newer dialog. */
  async handleDialog(owner: WebContents, id: unknown, token: unknown, dialogId: unknown,
    action: unknown, text: unknown): Promise<void> {
    const key = this.dialogToken(owner, id, token)
    if (typeof dialogId !== 'string' || !['accept', 'dismiss'].includes(action as string) ||
      text !== undefined && typeof text !== 'string') throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    await this.dialogLease.handle(token as string, dialogId, action as 'accept' | 'dismiss', text)
    this.activeDialogs.delete(key)
    this.activeNavigations.delete(token as string)
  }

  /** Abandon a watch and dismiss any open modal so the guest is not left blocked. */
  async finishDialog(owner: WebContents, id: unknown, token: unknown): Promise<void> {
    const key = this.dialogToken(owner, id, token)
    this.activeDialogs.delete(key)
    this.activeNavigations.delete(token as string)
    await this.dialogLease.close(token as string)
  }

  private dialogToken(owner: WebContents, id: unknown, token: unknown): DesktopBrowserLeaseId {
    if (typeof id !== 'string' || typeof token !== 'string') throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined || lease.owner !== owner || this.activeDialogs.get(key) !== token) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    return key
  }

  /** Audit only the current owned guest; URLs never leave the Desktop process. */
  auditFrames(owner: WebContents, id: unknown, expectedUrl: unknown,
    approvedOrigins?: unknown): BrowserFrameAudit {
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl)) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed()) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    if (approvedOrigins !== undefined && (!Array.isArray(approvedOrigins) ||
      !approvedOrigins.every(origin => typeof origin === 'string'))) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    return auditBrowserFrames(guest, expectedUrl, approvedOrigins)
  }

  /** Read approved child-frame body text through the owned guest, with navigation invalidation. */
  async inspectForeignText(owner: WebContents, id: unknown, expectedUrl: unknown,
    approvedOrigins: unknown): Promise<BrowserForeignText> {
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl) ||
      !Array.isArray(approvedOrigins) || !approvedOrigins.every(origin => typeof origin === 'string')) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed()) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await readBrowserForeignText(guest, expectedUrl, approvedOrigins)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest events may fire during awaited frame reads.
      if (changed || this.leases.get(key) !== lease || lease.guest !== guest || owner.isDestroyed()) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Capture the viewport in Main so frame navigation events cannot race the grant. */
  async captureViewport(owner: WebContents, id: unknown, expectedUrl: unknown, clip: unknown,
    approvedOrigins?: unknown): Promise<BrowserPageScreenshot> {
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl)) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    const guest = lease?.guest
    if (lease === undefined || lease.owner !== owner || !lease.attached || guest === undefined ||
      guest.isDestroyed()) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    const rectangle = this.captureRectangle(clip)
    if (approvedOrigins !== undefined && (!Array.isArray(approvedOrigins) ||
      !approvedOrigins.every(origin => typeof origin === 'string'))) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await captureBrowserViewport(guest, expectedUrl, rectangle, approvedOrigins)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest events may fire during the awaited capture.
      if (changed || this.leases.get(key) !== lease || lease.guest !== guest || owner.isDestroyed()) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  /** Capture only a live guest owned by the authenticated application window. */
  async captureFullPage(owner: WebContents, id: unknown, expectedUrl: unknown, clip: unknown,
    approvedOrigins?: unknown): Promise<BrowserPageScreenshot> {
    if (typeof id !== 'string' || typeof expectedUrl !== 'string' || !this.allowedNavigation(expectedUrl)) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined || lease.owner !== owner || !lease.attached || lease.guest === undefined ||
      lease.guest.isDestroyed()) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    const rectangle = this.captureRectangle(clip)
    const guest = lease.guest
    if (approvedOrigins !== undefined && (!Array.isArray(approvedOrigins) ||
      !approvedOrigins.every(origin => typeof origin === 'string'))) {
      throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    }
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await captureBrowserFullPage(guest, expectedUrl, rectangle, approvedOrigins)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest events may fire during the awaited capture.
      if (changed || this.leases.get(key) !== lease || lease.guest !== guest || owner.isDestroyed()) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      return result
    } finally {
      guest.off('frame-created', markChanged)
      guest.off('will-frame-navigate', markChanged)
      guest.off('did-navigate-in-page', markChanged)
    }
  }

  private captureRectangle(clip: unknown): BrowserScreenshotClip | undefined {
    if (clip === undefined) return undefined
    if (typeof clip !== 'object' || clip === null || Array.isArray(clip) ||
      Object.keys(clip).some(field => !['x', 'y', 'width', 'height'].includes(field)) ||
      !('x' in clip) || !('y' in clip) || !('width' in clip) || !('height' in clip) ||
      typeof clip.x !== 'number' || typeof clip.y !== 'number' ||
      typeof clip.width !== 'number' || typeof clip.height !== 'number') {
      throw new Error('SIDEBAR_CLIP_OUT_OF_BOUNDS')
    }
    return { x: clip.x, y: clip.y, width: clip.width, height: clip.height }
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
        preload: this.guestPreloadPath,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
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
        guest.once('destroyed', () => { lease.releaseInput?.(); this.leases.delete(id) })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
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
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
