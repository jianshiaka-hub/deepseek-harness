/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { randomUUID } from 'node:crypto'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserInitialPreflight, DesktopBrowserOccurrence, DesktopBrowserLeaseId, DesktopBrowserOpenRequest,
  DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'
import { BrowserNavigationPreflight } from './browser-navigation-preflight.ts'
import { auditBrowserFrames, readBrowserForeignText, captureBrowserFullPage,
  captureBrowserViewport, type BrowserFrameAudit, type BrowserForeignText,
  type BrowserFrameScreenshot, type BrowserScreenshotClip } from './browser-foreign-read.ts'
import { locateBrowserForeignFrame, pointForBrowserForeignRef,
  stateForBrowserForeignInput, selectBrowserForeignOption,
  stateForBrowserForeignKey } from './browser-foreign-locate.ts'
import type { BrowserLocateResult, BrowserForeignRefPoint,
  BrowserForeignInputState, BrowserForeignOptionResult,
  BrowserForeignKeyState } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
  readonly initialPreflight?: DesktopBrowserInitialPreflight
  readonly blankClaim?: { readonly key: string; readonly value: DesktopBrowserInitialPreflight }
}

/** Owns workspace storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly partitions = new Map<string, string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  private readonly blankClaims = new Map<string, { readonly owner: WebContents;
    readonly value: DesktopBrowserInitialPreflight }>()
  private readonly navigationPreflight = new BrowserNavigationPreflight(DESKTOP_IPC.browserNavigationIntent)

  /** @param hostUrl - current authenticated DSH Host, which guests cannot request. */
  constructor(private readonly hostUrl: () => string | undefined) {}

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
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
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
        guest.once('destroyed', () => { lease.releaseInput?.(); this.navigationPreflight.revokeGuest(guest); this.leases.delete(id) })
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
    browserSession.on('will-download', (event) => { event.preventDefault() })
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
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await locateBrowserForeignFrame(guest, expectedUrl as string,
        query, approvedOrigins as string[])
      if (changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
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
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await pointForBrowserForeignRef(guest, expectedUrl as string,
        ref, approvedOrigins as string[])
      if (changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
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
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await stateForBrowserForeignInput(guest, expectedUrl as string,
        ref, approvedOrigins as string[], phase, value)
      if (changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
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
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await selectBrowserForeignOption(guest, expectedUrl as string,
        ref, approvedOrigins as string[], options)
      if (changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
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
    let changed = false
    const markChanged = (): void => { changed = true }
    guest.on('frame-created', markChanged)
    guest.on('will-frame-navigate', markChanged)
    guest.on('did-navigate-in-page', markChanged)
    try {
      const result = await stateForBrowserForeignKey(guest, expectedUrl as string,
        ref, approvedOrigins as string[], key, phase)
      if (changed || this.leases.get(id as DesktopBrowserLeaseId) !== lease ||
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
