/** One CDP dialog watch bound to one exact Sidebar guest document. */
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'

type DialogGuest = Pick<WebContents, 'debugger' | 'isDestroyed' | 'isLoadingMainFrame' | 'getURL' | 'on' | 'off'>
type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'
type PromptResponse = string | null | { readonly useDefault: true }

/** Data that may cross the Desktop bridge; page-supplied dialog text stays in the guest. */
export interface BrowserDialogInfo {
  readonly id: string
  readonly type: DialogType
}

interface ActiveDialogWatch {
  readonly token: string
  readonly guest: DialogGuest
  readonly expectedUrl: string
  readonly onMessage: (_event: unknown, method: string, params: unknown) => void
  readonly onDetach: () => void
  readonly onNavigate: () => void
  readonly onDestroyed: () => void
  readonly waiters: Set<(dialog: BrowserDialogInfo | null) => void>
  timer: ReturnType<typeof setTimeout> | undefined
  dialog: BrowserDialogInfo | undefined
  promptReply: ((value: PromptResponse) => void) | undefined
  closed: boolean
  detached: boolean
}

const EMPTY_WATCH_MS = 30_000
const OPEN_WATCH_MS = 300_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dialogType(value: unknown): value is DialogType {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload'
}

/** Own the debugger only while an approved action might open a modal dialog. */
export class BrowserDialogLease {
  private readonly watches = new Map<string, ActiveDialogWatch>()
  private readonly guests = new Set<DialogGuest>()

  get(token: string): BrowserDialogInfo | null {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || !this.validGuest(active)) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    return active.dialog ?? null
  }

  async begin(guest: DialogGuest, expectedUrl: string): Promise<string> {
    if (!URL.canParse(expectedUrl) || !['http:', 'https:'].includes(new URL(expectedUrl).protocol) ||
      new URL(expectedUrl).username !== '' || new URL(expectedUrl).password !== '' ||
      guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    if (this.guests.has(guest) || guest.debugger.isAttached()) throw new Error('SIDEBAR_DIALOG_BUSY')
    this.guests.add(guest)
    const token = randomUUID()
    let attached = false
    let invalidated = false
    const active: ActiveDialogWatch = {
      token, guest, expectedUrl, waiters: new Set(), timer: undefined, dialog: undefined,
      promptReply: undefined,
      closed: false, detached: false,
      onMessage: (_event, method, params): void => {
        if (method !== 'Page.javascriptDialogOpening' || !record(params)) return
        // A subframe from another website has no matching site grant. Dismiss it
        // without exposing its type or text through this exact-origin lease.
        const source = params.url
        const sameSite = typeof source === 'string' && URL.canParse(source) &&
          new URL(source).origin === new URL(expectedUrl).origin
        if (!sameSite || !dialogType(params.type) || active.dialog !== undefined ||
          !this.validGuest(active, params.type === 'beforeunload')) {
          void guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
          return
        }
        active.dialog = { id: randomUUID(), type: params.type }
        if (active.timer !== undefined) clearTimeout(active.timer)
        // An abandoned agent turn must not leave a user-owned tab modal forever.
        active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, OPEN_WATCH_MS)
        for (const waiter of active.waiters) waiter(active.dialog)
        active.waiters.clear()
      },
      onDetach: (): void => { invalidated = true; active.detached = true; void this.close(token).catch(() => {}) },
      onNavigate: (): void => { invalidated = true; void this.close(token).catch(() => {}) },
      onDestroyed: (): void => { invalidated = true; void this.close(token).catch(() => {}) },
    }
    try {
      guest.debugger.attach('1.3')
      attached = true
      guest.debugger.on('message', active.onMessage)
      guest.debugger.on('detach', active.onDetach)
      guest.on('did-navigate', active.onNavigate)
      guest.on('destroyed', active.onDestroyed)
      await guest.debugger.sendCommand('Page.enable')
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Debugger events can invalidate an awaited Page.enable.
      if (invalidated || guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl ||
        active.detached) throw new Error('SIDEBAR_NAVIGATED')
      this.watches.set(token, active)
      if (active.dialog === undefined) {
        active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, EMPTY_WATCH_MS)
      }
      return token
    } catch (error) {
      guest.debugger.off('message', active.onMessage)
      guest.debugger.off('detach', active.onDetach)
      guest.off('did-navigate', active.onNavigate)
      guest.off('destroyed', active.onDestroyed)
      if (attached && !active.detached && guest.debugger.isAttached()) guest.debugger.detach()
      this.guests.delete(guest)
      throw error
    }
  }

  async wait(token: string, timeoutMs = 15_000): Promise<BrowserDialogInfo | null> {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || !this.validGuest(active)) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 15_000) {
      throw new Error('SIDEBAR_DIALOG_WAIT_UNAVAILABLE')
    }
    if (active.dialog !== undefined) return active.dialog
    return new Promise((resolve) => {
      const finish = (dialog: BrowserDialogInfo | null): void => {
        clearTimeout(timer)
        active.waiters.delete(finish)
        resolve(dialog)
      }
      const timer = setTimeout(() => { finish(null) }, timeoutMs)
      active.waiters.add(finish)
    })
  }

  /** Hold a sandboxed guest prompt synchronously without revealing its page text. */
  offerPrompt(token: string, sourceUrl: string, respond: (value: PromptResponse) => void): boolean {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || active.dialog !== undefined ||
      !this.validGuest(active) || !URL.canParse(sourceUrl) ||
      new URL(sourceUrl).origin !== new URL(active.expectedUrl).origin) return false
    active.promptReply = respond
    active.dialog = { id: randomUUID(), type: 'prompt' }
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, OPEN_WATCH_MS)
    for (const waiter of active.waiters) waiter(active.dialog)
    active.waiters.clear()
    return true
  }

  async handle(token: string, id: string, action: 'accept' | 'dismiss', text?: string): Promise<void> {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || !this.validGuest(active) ||
      active.dialog?.id !== id || !['accept', 'dismiss'].includes(action) ||
      text !== undefined && (active.dialog.type !== 'prompt' || text.length > 4000)) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    if (active.promptReply !== undefined) {
      const reply = active.promptReply
      active.promptReply = undefined
      active.dialog = undefined
      try { reply(action === 'accept' ? text ?? { useDefault: true } : null) }
      finally { await this.close(token) }
      return
    } else {
      await active.guest.debugger.sendCommand('Page.handleJavaScriptDialog', {
        accept: action === 'accept',
        ...(action === 'accept' && active.dialog.type === 'prompt' ? { promptText: text ?? '' } : {}),
      })
    }
    active.dialog = undefined
    await this.close(token)
  }

  async close(token: string): Promise<void> {
    const active = this.watches.get(token)
    if (active === undefined || active.closed) return
    active.closed = true
    this.watches.delete(token)
    this.guests.delete(active.guest)
    if (active.timer !== undefined) clearTimeout(active.timer)
    for (const waiter of active.waiters) waiter(null)
    active.waiters.clear()
    active.guest.debugger.off('message', active.onMessage)
    active.guest.debugger.off('detach', active.onDetach)
    active.guest.off('did-navigate', active.onNavigate)
    active.guest.off('destroyed', active.onDestroyed)
    const promptReply = active.promptReply
    active.promptReply = undefined
    if (promptReply !== undefined) {
      active.dialog = undefined
      try { promptReply(null) } catch { /* The blocked guest may already be gone. */ }
    }
    if (!active.detached && active.guest.debugger.isAttached()) {
      try {
        if (active.dialog !== undefined) {
          await active.guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
        }
      } finally { if (active.guest.debugger.isAttached()) active.guest.debugger.detach() }
    }
  }

  private validGuest(active: ActiveDialogWatch, openingBeforeUnload = false): boolean {
    return !active.guest.isDestroyed() &&
      (!active.guest.isLoadingMainFrame() || openingBeforeUnload || active.dialog?.type === 'beforeunload') &&
      active.guest.getURL() === active.expectedUrl
  }
}
