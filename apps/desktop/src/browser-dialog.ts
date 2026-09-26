/** One CDP dialog watch bound to one exact Sidebar guest document. */
import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
type DialogGuest = {
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
  on: EventEmitter['on']
  off: EventEmitter['off']
  listeners: EventEmitter['listeners']
}
type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'
type PromptResponse = string | null | { readonly useDefault: true }
type NativeDialogType = 'alert' | 'confirm' | 'prompt'
type NativeDialogResponse = (action: 'accept' | 'dismiss', text?: string) => void

/** Data that may cross the Desktop bridge; page-supplied dialog text stays in the guest. */
export interface BrowserDialogInfo {
  readonly id: string
  readonly type: DialogType
  readonly origin: string
}

interface ActiveDialogWatch {
  readonly token: string
  readonly guest: DialogGuest
  readonly expectedUrl: string
  readonly approvedPromptOrigins: ReadonlySet<string>
  readonly onMessage: (_event: unknown, method: string, params: unknown) => void
  readonly onDetach: () => void
  readonly onNavigate: () => void
  readonly onDestroyed: () => void
  readonly waiters: Set<(dialog: BrowserDialogInfo | null) => void>
  timer: ReturnType<typeof setTimeout> | undefined
  dialog: BrowserDialogInfo | undefined
  promptReply: ((value: PromptResponse) => void) | undefined
  guestDialogReply: ((value: boolean | undefined) => void) | undefined
  nativeDialogReply: NativeDialogResponse | undefined
  framePromptScriptId: string | undefined
  readonly frameDocuments: ReadonlyMap<string, { readonly url: string; readonly loaderId: string }>
  navigationIntent: { readonly frameId: string; readonly url: string; readonly at: number } | undefined
  openedBeforeUnload: { readonly frameId: string; readonly sourceUrl: string } | undefined
  replay: { readonly frameId: string; readonly sourceUrl: string; readonly url: string } | undefined
  retry: {
    readonly frameId: string
    readonly sourceUrl: string
    readonly url: string
    readonly resolve: () => void
    readonly reject: (error: Error) => void
    open: boolean
  } | undefined
  closed: boolean
  detached: boolean
}

const EMPTY_WATCH_MS = 30_000
const OPEN_WATCH_MS = 300_000

/** Forward same-origin subframe dialogs to the sandboxed top-frame shims. */
function sameOriginFramePromptScript(expectedUrl: string): string {
  const origin = JSON.stringify(new URL(expectedUrl).origin)
  return `(() => {
    if (self === top || location.origin !== ${origin}) return;
    try {
      if (top.location.origin !== ${origin}) return;
      window.prompt = function (message, defaultValue) {
        return top.prompt(message, defaultValue);
      };
      window.confirm = function (message) { return top.confirm(message); };
      window.alert = function (message) { top.alert(message); };
    } catch { /* Cross-origin frames retain Electron's unsupported prompt. */ }
  })();`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function frameDocuments(value: unknown): Map<string, { readonly url: string; readonly loaderId: string }> {
  const result = new Map<string, { readonly url: string; readonly loaderId: string }>()
  if (!record(value) || !record(value.frameTree)) return result
  const visit = (node: unknown): void => {
    if (!record(node) || !record(node.frame)) return
    const frame = node.frame
    if (typeof frame.id === 'string' && typeof frame.url === 'string' &&
      typeof frame.loaderId === 'string') {
      result.set(frame.id, { url: frame.url, loaderId: frame.loaderId })
    }
    if (Array.isArray(node.childFrames)) for (const child of node.childFrames) visit(child)
  }
  visit(value.frameTree)
  return result
}

function dialogType(value: unknown): value is DialogType {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload'
}

/** Own the debugger only while an approved action might open a modal dialog. */
export class BrowserDialogLease {
  private readonly watches = new Map<string, ActiveDialogWatch>()
  private readonly guests = new Set<DialogGuest>()
  private readonly nativeGuards = new WeakSet<DialogGuest>()

  /** Replace Electron 44's default private dialog listener only when its single-handler shape is intact. */
  installNativeDialogGuard(guest: DialogGuest,
    offer: (sourceUrl: string, type: NativeDialogType, respond: NativeDialogResponse) => boolean): boolean {
    const existing = guest.listeners('-run-dialog')
    if (existing.length !== 1 || this.nativeGuards.has(guest)) return false
    const original = existing[0]
    if (original === undefined) return false
    const defaultListener = original as (...args: unknown[]) => void
    const handler = (raw: unknown, callback: unknown): void => {
      if (typeof callback !== 'function') return
      const complete = callback as (accepted: boolean, text: string) => void
      let answered = false
      const respond: NativeDialogResponse = (action, text) => {
        if (answered) return
        answered = true
        try { complete(action === 'accept', text ?? '') }
        catch { /* The guest may have navigated while its dialog was held. */ }
      }
      if (raw === null || typeof raw !== 'object' || !('frame' in raw) ||
        !('dialogType' in raw) || typeof raw.dialogType !== 'string' ||
        !['alert', 'confirm', 'prompt'].includes(raw.dialogType) ||
        raw.frame === null || typeof raw.frame !== 'object' ||
        !('url' in raw.frame) || typeof raw.frame.url !== 'string') {
        respond('dismiss')
        return
      }
      const type = raw.dialogType as NativeDialogType
      const defaultText = 'defaultPromptText' in raw && typeof raw.defaultPromptText === 'string'
        ? raw.defaultPromptText : ''
      const accepted: NativeDialogResponse = (action, text) => {
        respond(action, action === 'accept' && type === 'prompt' ? text ?? defaultText : '')
      }
      try { if (offer(raw.frame.url, type, accepted)) return }
      catch { /* A failed lease lookup must still unblock the guest. */ }
      respond('dismiss')
    }
    guest.off('-run-dialog', defaultListener)
    try { guest.on('-run-dialog', handler) }
    catch (error) { guest.on('-run-dialog', defaultListener); throw error }
    this.nativeGuards.add(guest)
    return true
  }

  get(token: string): BrowserDialogInfo | null {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || !this.validGuest(active)) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    return active.dialog ?? null
  }

  async begin(guest: DialogGuest, expectedUrl: string,
    approvedPromptOrigins?: readonly string[]): Promise<string> {
    if (!URL.canParse(expectedUrl) || !['http:', 'https:'].includes(new URL(expectedUrl).protocol) ||
      new URL(expectedUrl).username !== '' || new URL(expectedUrl).password !== '' ||
      guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl) {
      throw new Error('SIDEBAR_TAB_UNAVAILABLE')
    }
    const topOrigin = new URL(expectedUrl).origin
    if (approvedPromptOrigins !== undefined && (!Array.isArray(approvedPromptOrigins) ||
      approvedPromptOrigins.length < 1 || approvedPromptOrigins.length > 100 ||
      new Set(approvedPromptOrigins).size !== approvedPromptOrigins.length ||
      !approvedPromptOrigins.includes(topOrigin) ||
      !approvedPromptOrigins.every((origin) => {
        if (typeof origin !== 'string' || !URL.canParse(origin)) return false
        const parsed = new URL(origin)
        return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin &&
          parsed.username === '' && parsed.password === ''
      }))) throw new Error('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    if (this.guests.has(guest) || guest.debugger.isAttached()) throw new Error('SIDEBAR_DIALOG_BUSY')
    this.guests.add(guest)
    const token = randomUUID()
    let attached = false
    let invalidated = false
    const initialFrames = new Map<string, { readonly url: string; readonly loaderId: string }>()
    const active: ActiveDialogWatch = {
      token, guest, expectedUrl, approvedPromptOrigins: new Set(approvedPromptOrigins ?? [topOrigin]),
      waiters: new Set(), timer: undefined, dialog: undefined,
      promptReply: undefined, guestDialogReply: undefined,
      nativeDialogReply: undefined,
      framePromptScriptId: undefined,
      frameDocuments: initialFrames, navigationIntent: undefined,
      openedBeforeUnload: undefined, replay: undefined, retry: undefined,
      closed: false, detached: false,
      onMessage: (_event, method, params): void => {
        if (method === 'Page.frameRequestedNavigation' && record(params) &&
          params.disposition === 'currentTab' && params.reason === 'scriptInitiated' &&
          typeof params.frameId === 'string' && typeof params.url === 'string' &&
          params.frameId.length <= 128 && params.url.length <= 16_384 && URL.canParse(params.url)) {
          const document = initialFrames.get(params.frameId)
          const destination = new URL(params.url)
          if (document !== undefined && URL.canParse(document.url) &&
            ['http:', 'https:'].includes(destination.protocol) &&
            destination.username === '' && destination.password === '' &&
            (destination.origin === new URL(document.url).origin ||
              [...initialFrames.values()].some(frame => URL.canParse(frame.url) &&
                new URL(frame.url).origin === destination.origin)) &&
            active.approvedPromptOrigins.has(destination.origin)) {
            active.navigationIntent = { frameId: params.frameId, url: destination.href, at: Date.now() }
          }
          return
        }
        if (method === 'Page.frameNavigated' && active.retry !== undefined &&
          record(params) && record(params.frame) &&
          params.frame.id === active.retry.frameId && params.frame.url === active.retry.url) {
          active.retry.resolve()
          return
        }
        if (method === 'Page.javascriptDialogClosed') {
          if (active.retry !== undefined) {
            if (record(params) && params.frameId === active.retry.frameId && params.result === false) {
              active.retry.reject(new Error('SIDEBAR_NAVIGATION_FAILED'))
            }
            active.retry.open = false
            return
          }
          // Chromium can cancel a modal independently of the agent (notably in
          // child frames). Never leave its opaque handle actionable afterward.
          if (active.nativeDialogReply !== undefined) {
            void this.close(token).catch(() => {})
            return
          }
          if (active.dialog !== undefined && active.promptReply === undefined &&
            active.guestDialogReply === undefined) {
            const opened = active.openedBeforeUnload
            const intent = active.navigationIntent
            if (active.dialog.type === 'beforeunload' && record(params) && params.result === false &&
              opened !== undefined && params.frameId === opened.frameId &&
              intent?.frameId === opened.frameId && Date.now() - intent.at < 5000 &&
              initialFrames.get(opened.frameId)?.url === opened.sourceUrl) {
              active.replay = { frameId: opened.frameId, sourceUrl: opened.sourceUrl, url: intent.url }
              return
            }
            active.dialog = undefined
            if (active.timer !== undefined) clearTimeout(active.timer)
            active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, EMPTY_WATCH_MS)
          }
          return
        }
        if (method !== 'Page.javascriptDialogOpening' || !record(params)) return
        if (active.retry !== undefined) {
          if (params.type === 'beforeunload' && params.frameId === active.retry.frameId &&
            params.url === active.retry.sourceUrl && this.validGuest(active, true)) {
            active.retry.open = true
            void guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {})
          } else {
            active.retry.reject(new Error('SIDEBAR_NAVIGATION_FAILED'))
            void guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
          }
          return
        }
        if (this.nativeGuards.has(guest) && params.type !== 'beforeunload') return
        // CDP is reserved for beforeunload when the native guard is installed.
        // A foreign frame may hold it only if the current action preapproved
        // that frame's exact site origin; page-supplied text is never exported.
        const source = params.url
        const approvedSource = typeof source === 'string' && URL.canParse(source) &&
          active.approvedPromptOrigins.has(new URL(source).origin)
        if (!approvedSource || !dialogType(params.type) || active.dialog !== undefined ||
          !this.validGuest(active, params.type === 'beforeunload')) {
          void guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
          return
        }
        active.openedBeforeUnload = params.type === 'beforeunload' &&
          typeof params.frameId === 'string' && typeof source === 'string'
          ? { frameId: params.frameId, sourceUrl: source } : undefined
        active.dialog = { id: randomUUID(), type: params.type, origin: new URL(source).origin }
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
      this.assertValidStart(active, invalidated)
      const tree = await guest.debugger.sendCommand('Page.getFrameTree').catch(() => null)
      for (const [id, document] of frameDocuments(tree)) initialFrames.set(id, document)
      this.assertValidStart(active, invalidated)
      const injected = await guest.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: sameOriginFramePromptScript(expectedUrl), runImmediately: true,
      })
      if (!record(injected) || typeof injected.identifier !== 'string') {
        throw new Error('SIDEBAR_DIALOG_FRAME_PROMPT_UNAVAILABLE')
      }
      active.framePromptScriptId = injected.identifier
      this.assertValidStart(active, invalidated)
      this.watches.set(token, active)
      if (active.dialog === undefined) {
        if (active.timer !== undefined) clearTimeout(active.timer)
        active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, EMPTY_WATCH_MS)
      }
      return token
    } catch (error) {
      if (active.framePromptScriptId !== undefined && guest.debugger.isAttached()) {
        await guest.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: active.framePromptScriptId,
        }).catch(() => {})
      }
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
      active.guestDialogReply !== undefined ||
      !this.validGuest(active) || !URL.canParse(sourceUrl) ||
      !active.approvedPromptOrigins.has(new URL(sourceUrl).origin)) return false
    active.promptReply = respond
    active.dialog = { id: randomUUID(), type: 'prompt', origin: new URL(sourceUrl).origin }
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, OPEN_WATCH_MS)
    for (const waiter of active.waiters) waiter(active.dialog)
    active.waiters.clear()
    return true
  }

  /** Hold a fixed alert/confirm from a source already approved for this lease. */
  offerGuestDialog(token: string, sourceUrl: string, type: 'alert' | 'confirm',
    respond: (value: boolean | undefined) => void): boolean {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || active.dialog !== undefined ||
      active.promptReply !== undefined || !this.validGuest(active) || !URL.canParse(sourceUrl) ||
      !active.approvedPromptOrigins.has(new URL(sourceUrl).origin)) return false
    active.guestDialogReply = respond
    active.dialog = { id: randomUUID(), type, origin: new URL(sourceUrl).origin }
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, OPEN_WATCH_MS)
    for (const waiter of active.waiters) waiter(active.dialog)
    active.waiters.clear()
    return true
  }

  /** Hold one origin-approved Electron dialog without exposing page-supplied text. */
  offerNativeDialog(token: string, sourceUrl: string, type: NativeDialogType,
    respond: NativeDialogResponse): boolean {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || active.dialog !== undefined ||
      active.promptReply !== undefined || active.guestDialogReply !== undefined ||
      !this.validGuest(active) || !URL.canParse(sourceUrl) ||
      !active.approvedPromptOrigins.has(new URL(sourceUrl).origin)) return false
    active.nativeDialogReply = respond
    active.dialog = { id: randomUUID(), type, origin: new URL(sourceUrl).origin }
    if (active.timer !== undefined) clearTimeout(active.timer)
    active.timer = setTimeout(() => { void this.close(token).catch(() => {}) }, OPEN_WATCH_MS)
    for (const waiter of active.waiters) waiter(active.dialog)
    active.waiters.clear()
    return true
  }

  async handle(token: string, id: string, action: 'accept' | 'dismiss', text?: string): Promise<true | void> {
    const active = this.watches.get(token)
    if (active === undefined || active.closed || active.detached || !this.validGuest(active) ||
      active.dialog?.id !== id || !['accept', 'dismiss'].includes(action) ||
      text !== undefined && (active.dialog.type !== 'prompt' || text.length > 4000)) {
      throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
    }
    if (active.replay !== undefined) {
      const replay = active.replay
      active.replay = undefined
      if (action === 'dismiss') {
        active.dialog = undefined
        await this.close(token)
        return true
      }
      const tree = frameDocuments(await active.guest.debugger.sendCommand('Page.getFrameTree'))
      const original = active.frameDocuments.get(replay.frameId)
      const current = tree.get(replay.frameId)
      if (original === undefined || current === undefined ||
        original.url !== replay.sourceUrl || current.url !== original.url ||
        current.loaderId !== original.loaderId || !this.validGuest(active)) {
        await this.close(token)
        throw new Error('SIDEBAR_NAVIGATED')
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const committed = new Promise<void>((resolve, reject) => {
        active.retry = { ...replay, resolve, reject, open: false }
        timer = setTimeout(() => { reject(new Error('SIDEBAR_NAVIGATION_TIMEOUT')) }, 12_000)
      })
      active.dialog = undefined
      try {
        void active.guest.debugger.sendCommand('Page.navigate', {
          frameId: replay.frameId, url: replay.url,
        }).catch((error: unknown) => {
          active.retry?.reject(error instanceof Error ? error : new Error(String(error)))
        })
        await committed
        return true
      } finally {
        clearTimeout(timer)
        await this.close(token)
      }
    }
    if (active.nativeDialogReply !== undefined) {
      const reply = active.nativeDialogReply
      active.nativeDialogReply = undefined
      active.dialog = undefined
      try { reply(action, text) }
      finally { await this.close(token) }
      return
    } else if (active.promptReply !== undefined) {
      const reply = active.promptReply
      active.promptReply = undefined
      active.dialog = undefined
      try { reply(action === 'accept' ? text ?? { useDefault: true } : null) }
      finally { await this.close(token) }
      return
    } else if (active.guestDialogReply !== undefined) {
      const reply = active.guestDialogReply
      const type = active.dialog.type
      active.guestDialogReply = undefined
      active.dialog = undefined
      try { reply(type === 'confirm' ? action === 'accept' : undefined) }
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
    const retry = active.retry
    active.retry = undefined
    retry?.reject(new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE'))
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
    const guestDialogReply = active.guestDialogReply
    active.guestDialogReply = undefined
    if (guestDialogReply !== undefined) {
      const type = active.dialog?.type
      active.dialog = undefined
      try { guestDialogReply(type === 'confirm' ? false : undefined) }
      catch { /* The blocked guest may already be gone. */ }
    }
    const nativeDialogReply = active.nativeDialogReply
    active.nativeDialogReply = undefined
    if (nativeDialogReply !== undefined) {
      active.dialog = undefined
      try { nativeDialogReply('dismiss') }
      catch { /* The blocked guest may already be gone. */ }
    }
    if (!active.detached && active.guest.debugger.isAttached()) {
      try {
        if (active.dialog !== undefined || retry?.open === true) {
          await active.guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
        }
        if (active.framePromptScriptId !== undefined) {
          await active.guest.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', {
            identifier: active.framePromptScriptId,
          }).catch(() => {})
        }
      } finally { if (active.guest.debugger.isAttached()) active.guest.debugger.detach() }
    }
  }

  private validGuest(active: ActiveDialogWatch, openingBeforeUnload = false): boolean {
    return !active.guest.isDestroyed() &&
      (!active.guest.isLoadingMainFrame() || openingBeforeUnload || active.dialog?.type === 'beforeunload') &&
      active.guest.getURL() === active.expectedUrl
  }

  private assertValidStart(active: ActiveDialogWatch, invalidated: boolean): void {
    if (invalidated || active.detached || !this.validGuest(active)) throw new Error('SIDEBAR_NAVIGATED')
  }
}
