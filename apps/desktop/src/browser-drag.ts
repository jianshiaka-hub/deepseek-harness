/** One bounded native drag for an already approved Sidebar guest. */
import { randomUUID } from 'node:crypto'
type DragGuest = {
  readonly debugger: {
    isAttached(): boolean
    attach(version: string): void
    detach(): void
    sendCommand(method: string, params?: object): Promise<unknown>
    on(event: 'message', listener: (_event: unknown, method: string, params: unknown) => void): void
    on(event: 'detach', listener: () => void): void
    off(event: 'message', listener: (_event: unknown, method: string, params: unknown) => void): void
    off(event: 'detach', listener: () => void): void
  }
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
  getURL(): string
  on(event: 'did-start-navigation' | 'destroyed', listener: () => void): void
  off(event: 'did-start-navigation' | 'destroyed', listener: () => void): void
}
type Point = { readonly x: number; readonly y: number }

function validPoint(value: unknown): value is Point {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.keys(value).every(key => ['x', 'y'].includes(key)) &&
    'x' in value && 'y' in value && [value.x, value.y].every(n =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 8192)
}

/** CDP commands stay private to the main process; captured drag data returns only to its source guest. */
export class BrowserDragLease {
  private active: {
    readonly token: string
    readonly guest: DragGuest
    readonly expectedUrl: string
    readonly onMessage: (_event: unknown, method: string, params: unknown) => void
    readonly onNavigate: () => void
    readonly onDetach: () => void
    readonly timer: ReturnType<typeof setTimeout>
    data: object | undefined
    invalidated: boolean
    detached: boolean
    finishing: boolean
  } | undefined
  private busy = false

  get activeToken(): string | undefined { return this.active?.token }

  async begin(guest: DragGuest, expectedUrl: string): Promise<string> {
    if (this.busy || guest.debugger.isAttached()) throw new Error('SIDEBAR_DRAG_BUSY')
    if (guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl) {
      throw new Error('SIDEBAR_NAVIGATED')
    }
    this.busy = true
    const token = randomUUID()
    let invalidated = false
    let detached = false
    let attachedByUs = false
    let data: object | undefined
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      if (method !== 'Input.dragIntercepted' || typeof params !== 'object' || params === null ||
        !('data' in params) || typeof params.data !== 'object' || params.data === null) return
      if (Buffer.byteLength(JSON.stringify(params.data)) > 4 * 1024 * 1024) {
        invalidated = true
        if (this.active?.token === token) this.active.invalidated = true
        return
      }
      data = params.data
      if (this.active?.token === token) this.active.data = data
    }
    const onNavigate = (): void => {
      invalidated = true
      if (this.active?.token === token && !this.active.finishing) {
        this.active.invalidated = true
        void this.cancel(token).catch(() => {})
      }
    }
    const onDetach = (): void => {
      detached = true
      invalidated = true
      if (this.active?.token === token) {
        this.active.detached = true
        this.active.invalidated = true
      }
    }
    try {
      guest.debugger.attach('1.3')
      attachedByUs = true
      guest.debugger.on('message', onMessage)
      guest.debugger.on('detach', onDetach)
      guest.on('did-start-navigation', onNavigate)
      guest.on('destroyed', onNavigate)
      await guest.debugger.sendCommand('Input.setInterceptDrags', { enabled: true })
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Guest events may invalidate an awaited CDP command.
      if (invalidated || guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      const timer = setTimeout(() => { void this.cancel(token).catch(() => {}) }, 12_000)
      this.active = { token, guest, expectedUrl, onMessage, onNavigate, onDetach, timer,
        data, invalidated: false, detached, finishing: false }
      return token
    } catch (error) {
      guest.debugger.off('message', onMessage)
      guest.debugger.off('detach', onDetach)
      guest.off('did-start-navigation', onNavigate)
      guest.off('destroyed', onNavigate)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- attach() may throw before acquiring the debugger.
      if (attachedByUs && !detached && guest.debugger.isAttached()) {
        await guest.debugger.sendCommand('Input.setInterceptDrags', { enabled: false }).catch(() => {})
        guest.debugger.detach()
      }
      this.busy = false
      throw error
    }
  }

  async finish(token: string, expectedUrl: string, point?: unknown): Promise<{ readonly dropped: boolean }> {
    const active = this.active
    if (active === undefined || active.token !== token) throw new Error('SIDEBAR_DRAG_LEASE_UNAVAILABLE')
    if (active.finishing) throw new Error('SIDEBAR_DRAG_BUSY')
    active.finishing = true
    let dropped = false
    try {
      if (point !== undefined) {
        if (!validPoint(point) || active.expectedUrl !== expectedUrl || active.invalidated || active.detached ||
          active.guest.isDestroyed() || active.guest.isLoadingMainFrame() ||
          active.guest.getURL() !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
        if (active.data === undefined) await new Promise(resolve => setTimeout(resolve, 50))
        if (active.data !== undefined) {
          for (const type of ['dragEnter', 'dragOver', 'drop']) {
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- Navigation/detach can occur during each awaited CDP step.
            if (active.invalidated || active.detached || active.guest.isDestroyed() ||
              active.guest.getURL() !== expectedUrl) throw new Error('SIDEBAR_NAVIGATED')
            await active.guest.debugger.sendCommand('Input.dispatchDragEvent', {
              type, x: point.x, y: point.y, data: active.data,
            })
          }
          dropped = true
        }
      }
      return { dropped }
    } finally { await this.close(active, !dropped) }
  }

  async cancel(token: string): Promise<void> {
    const active = this.active
    if (active === undefined || active.token !== token || active.finishing) return
    active.finishing = true
    await this.close(active, true)
  }

  private async close(active: NonNullable<BrowserDragLease['active']>, cancel: boolean): Promise<void> {
    clearTimeout(active.timer)
    active.guest.debugger.off('message', active.onMessage)
    active.guest.debugger.off('detach', active.onDetach)
    active.guest.off('did-start-navigation', active.onNavigate)
    active.guest.off('destroyed', active.onNavigate)
    try {
      if (!active.detached && active.guest.debugger.isAttached()) {
        if (cancel) await active.guest.debugger.sendCommand('Input.cancelDragging').catch(() => {})
        await active.guest.debugger.sendCommand('Input.setInterceptDrags', { enabled: false }).catch(() => {})
        active.guest.debugger.detach()
      }
    } finally {
      if (this.active === active) this.active = undefined
      this.busy = false
    }
  }
}
