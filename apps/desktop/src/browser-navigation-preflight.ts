import { randomUUID } from 'node:crypto'

export interface BrowserNavigationIntent {
  readonly token: string
  readonly lease: string
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

interface Guest {
  readonly id: number
  getURL(): string
  isDestroyed(): boolean
}

interface Owner {
  isDestroyed(): boolean
  send(channel: string, intent: BrowserNavigationIntent): void
}

interface Guard {
  readonly owner: Owner
  readonly guest: Guest
  readonly lease: string
  readonly clientId: string
  readonly sessionId: string
  readonly tabId: string
  readonly navigationEpoch: number
  readonly expectedUrl: string
  readonly documentUrl: string
  readonly popupInitialUrl?: string
}

interface Pending {
  readonly guard: Guard
  readonly targetUrl: string
  readonly callback: (response: { readonly cancel: boolean }) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** Hold cross-origin documents in an agent-touched guest before network delivery. */
export class BrowserNavigationPreflight {
  private readonly guards = new Map<number, Guard>()
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly channel: string) {}

  /** Keep site gating on an agent-touched guest, including while it is in the background. */
  arm(owner: Owner, guest: Guest, lease: string, clientId: string, sessionId: string,
    tabId: string, navigationEpoch: number, expectedUrl: string, popupInitialUrl?: string): void {
    const documentUrl = guest.getURL()
    if (owner.isDestroyed() || guest.isDestroyed() ||
      (popupInitialUrl === undefined ? documentUrl !== expectedUrl :
        expectedUrl !== 'about:blank' || documentUrl !== `about:blank#${lease}`) ||
      !Number.isSafeInteger(navigationEpoch) || navigationEpoch < 0) {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_UNAVAILABLE')
    }
    this.revokeGuest(guest)
    this.guards.set(guest.id, { owner, guest, lease, clientId, sessionId, tabId,
      navigationEpoch, expectedUrl, documentUrl,
      ...(popupInitialUrl === undefined ? {} : { popupInitialUrl }) })
  }

  /** @returns true only when this class owns the WebRequest callback. */
  intercept(webContentsId: number | undefined, resourceType: string, targetUrl: string,
    method: string, callback: (response: { readonly cancel: boolean }) => void): boolean {
    if (!['mainFrame', 'subFrame'].includes(resourceType) || webContentsId === undefined) return false
    let guard = this.guards.get(webContentsId)
    if (guard === undefined) return false
    const currentUrl = guard.guest.getURL()
    // The first approved popup document can run script before the renderer has
    // rearmed its new epoch. Retain the guest gate across that one commit.
    if (currentUrl !== guard.documentUrl && guard.popupInitialUrl !== undefined &&
      guard.expectedUrl === 'about:blank' && URL.canParse(currentUrl) &&
      new URL(currentUrl).origin === new URL(guard.popupInitialUrl).origin) {
      guard = { ...guard, expectedUrl: currentUrl, documentUrl: currentUrl }
      this.guards.set(webContentsId, guard)
    }
    // An old page or a delayed script must never turn a formerly guarded
    // navigation into an unrestricted network request.
    if (guard.owner.isDestroyed() || guard.guest.isDestroyed() ||
      currentUrl !== guard.documentUrl) {
      callback({ cancel: true })
      return true
    }
    const destination = new URL(targetUrl)
    if (guard.popupInitialUrl !== undefined && destination.origin === new URL(guard.popupInitialUrl).origin) return false
    if (destination.origin === new URL(guard.expectedUrl).origin) return false
    if ([...this.pending.values()].filter(request => request.guard === guard).length >= 4) {
      callback({ cancel: true })
      return true
    }
    const token = randomUUID()
    const timer = setTimeout(() => { this.resolve(token, guard.owner, false) }, 120_000)
    this.pending.set(token, { guard, targetUrl, callback, timer })
    try {
      guard.owner.send(this.channel, { token, lease: guard.lease, clientId: guard.clientId,
        sessionId: guard.sessionId, tabId: guard.tabId, navigationEpoch: guard.navigationEpoch,
        expectedUrl: guard.expectedUrl, targetUrl, method,
        ...(resourceType === 'subFrame' ? { resourceType: 'subFrame' as const } : {}),
        ...(guard.popupInitialUrl === undefined ? {} : { popupInitialUrl: guard.popupInitialUrl }) })
    } catch {
      this.resolve(token, guard.owner, false)
    }
    return true
  }

  /** Hold a new-tab request from an agent-touched guest until its destination is approved. */
  interceptPopup(guest: Guest, targetUrl: string, open: () => void): boolean {
    if (!this.guards.has(guest.id)) return false
    if (!this.intercept(guest.id, 'mainFrame', targetUrl, 'POPUP', (response) => {
      if (!response.cancel) open()
    })) open()
    return true
  }

  /** Resolve only the same owner and still-current guest; every held callback runs once. */
  resolve(token: string, owner: Owner, allowed: boolean): void {
    const request = this.pending.get(token)
    if (request === undefined || request.guard.owner !== owner) {
      throw new Error('SIDEBAR_NAVIGATION_PREFLIGHT_EXPIRED')
    }
    this.pending.delete(token)
    clearTimeout(request.timer)
    request.callback({ cancel: !allowed || owner.isDestroyed() || request.guard.guest.isDestroyed() ||
      request.guard.guest.getURL() !== request.guard.documentUrl })
  }

  /** Tab removal or window shutdown cancels all held requests from that guest. */
  revokeGuest(guest: Guest): void {
    this.guards.delete(guest.id)
    for (const [token, request] of this.pending) if (request.guard.guest === guest) {
      this.pending.delete(token)
      clearTimeout(request.timer)
      request.callback({ cancel: true })
    }
  }

  dispose(): void {
    for (const request of [...this.pending.values()]) this.revokeGuest(request.guard.guest)
    this.guards.clear()
  }
}
