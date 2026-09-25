import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { BrowserJsDialog } from '../../types.ts'
import type { BrowserLocateQuery } from '../browser/BrowserFrame.ts'

/** Selected-tab-only Client transport to the authenticated Computer Use Host routes. */

/** One selected Browser occurrence, with no page body or sibling-tab inventory. */
export interface ComputerUseSelectedTab {
  readonly sessionId: string
  readonly tabId: string
  readonly controllerAvailable: boolean
  readonly observedUrl?: string
  readonly requestedUrl?: string
  readonly title?: string
}

interface SidebarResult {
  readonly url: string
  readonly title: string
  readonly text?: string
  readonly origins?: readonly string[]
  readonly rows?: readonly { readonly ref: string; readonly role: string; readonly name: string }[]
  readonly base64?: string
  readonly viewport?: { readonly width: number; readonly height: number }
  readonly performed?: true
  readonly clipboardRestored?: boolean
  readonly clipboardSuperseded?: boolean
  readonly dropDispatched?: boolean
  readonly closed?: true
  readonly dialog?: BrowserJsDialog | null
}

interface SidebarResponse {
  readonly ok: boolean
  readonly value?: { readonly command: Command | null }
  readonly error?: { readonly code?: string; readonly message?: string }
}

interface Command {
  readonly id: string
  readonly sessionId: string
  readonly tabId: string
  readonly op: 'inspect' | 'frameOrigins' | 'locate' | 'screenshot' | 'click' | 'drag' | 'type' | 'paste' | 'setValue' | 'selectOption' | 'selectText' | 'secondary' | 'scroll' | 'key' | 'goto' | 'back' | 'forward' | 'close' | 'dialog' | 'dialogAction'
  readonly expectedUrl: string
  readonly args: {
    readonly approvedOrigin: string
    readonly query?: BrowserLocateQuery
    readonly ref?: string
    readonly x?: number
    readonly y?: number
    readonly to?: { readonly x: number; readonly y: number }
    readonly button?: 'left' | 'middle' | 'right'
    readonly count?: number
    readonly text?: string
    readonly sequential?: true
    readonly format?: 'text' | 'md' | 'html'
    readonly value?: string
    readonly options?: readonly { readonly value?: string; readonly label?: string; readonly index?: number }[]
    readonly prefix?: string
    readonly suffix?: string
    readonly selectionType?: 'text' | 'cursor_before' | 'cursor_after'
    readonly action?: 'focus' | 'showmenu' | 'expand' | 'collapse' | 'increment' | 'decrement'
    readonly key?: string
    readonly url?: string
    readonly dx?: number
    readonly dy?: number
    readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    readonly fullPage?: boolean
    readonly approvedFrameOrigins?: readonly string[]
    readonly handle?: string
    readonly decision?: 'accept' | 'dismiss'
  }
}

/** Report only the current selected tab; abort the old poll before a new selection is sent. */
export class SidebarComputerUseReporter {
  private readonly clientId = randomUUID()
  private readonly lifetime = new AbortController()
  private pending: AbortController | undefined
  private revision = 0
  private selectionRevision = 0
  private running: Promise<void> | undefined

  constructor(
    private readonly selected: () => ComputerUseSelectedTab | null,
    private readonly execute: (tab: ComputerUseSelectedTab, command: Command,
      stillSelected: () => boolean) => Promise<SidebarResult>,
  ) {}

  /** Begin reporting after the desktop Browser provider has registered. */
  start(): void { this.running ??= this.loop() }

  /** Invalidate pending work immediately after focus, navigation or mount changes. */
  notify(): void { this.revision++; this.pending?.abort() }

  /** Revoke an in-flight navigation even if the user switches away and back to the same tab. */
  notifySelection(): void { this.selectionRevision++; this.notify() }

  /** Withdraw this client and join its current request. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.notify()
    await this.running
  }

  private async post(endpoint: 'poll' | 'complete', body: object, signal?: AbortSignal): Promise<SidebarResponse> {
    const response = await fetch(`api/cu-sidebar/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: this.clientId, ...body }), signal: signal ?? null,
    })
    if (!response.ok) throw new Error(`SIDEBAR_BRIDGE_HTTP_${response.status}`)
    const envelope = await response.json() as SidebarResponse
    if (!envelope.ok) throw new Error(envelope.error?.code ?? 'SIDEBAR_BRIDGE_REJECTED')
    return envelope
  }

  private sameIdentity(command: Command, tab: ComputerUseSelectedTab | null): tab is ComputerUseSelectedTab {
    return tab !== null && tab.sessionId === command.sessionId && tab.tabId === command.tabId
  }

  private same(command: Command, tab: ComputerUseSelectedTab | null): tab is ComputerUseSelectedTab {
    return this.sameIdentity(command, tab) && tab.controllerAvailable &&
      tab.observedUrl === command.expectedUrl &&
      new URL(command.expectedUrl).origin === command.args.approvedOrigin
  }

  private async complete(command: Command): Promise<void> {
    const before = this.selected()
    const revision = this.revision
    const selectionRevision = this.selectionRevision
    let ok = false
    let value: SidebarResult | undefined
    let error = 'SIDEBAR_SELECTION_CHANGED'
    if (this.same(command, before)) {
      try {
        value = await this.execute(before, command, () => ['goto', 'back', 'forward', 'dialogAction'].includes(command.op)
          ? this.selectionRevision === selectionRevision && this.sameIdentity(command, this.selected())
          : this.revision === revision && this.same(command, this.selected()))
        const after = this.selected()
        if (command.op === 'close') {
          ok = value.closed === true && !this.sameIdentity(command, after)
        } else if (['goto', 'back', 'forward', 'dialogAction'].includes(command.op)) {
          ok = this.selectionRevision === selectionRevision && this.sameIdentity(command, after) &&
            after.controllerAvailable && after.observedUrl === value.url && value.performed === true
        } else if (command.op === 'inspect' || command.op === 'frameOrigins' || command.op === 'locate' || command.op === 'screenshot' || command.op === 'dialog') {
          const outputValid = command.op === 'inspect' ? typeof value.text === 'string'
            : command.op === 'locate' ? Array.isArray(value.rows)
              : command.op === 'frameOrigins' ? Array.isArray(value.origins)
                : command.op === 'dialog' ? value.dialog === null || value.dialog !== undefined
                  : typeof value.base64 === 'string' && value.viewport !== undefined
          ok = this.revision === revision && this.same(command, after) && value.url === command.expectedUrl &&
            outputValid
        } else {
          ok = this.revision === revision && after !== null && after.sessionId === command.sessionId &&
            after.tabId === command.tabId && value.performed === true
        }
        if (!ok) error = 'SIDEBAR_NAVIGATED'
      } catch (failure) { error = failure instanceof Error ? failure.message : 'SIDEBAR_INSPECT_FAILED' }
    }
    await this.post('complete', { id: command.id, selectedTab: this.selected(), ok,
      ...(ok ? { value } : { error }) }, this.lifetime.signal)
  }

  private async loop(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      const request = new AbortController()
      this.pending = request
      try {
        const response = await this.post('poll', { selectedTab: this.selected() }, request.signal)
        if (response.ok && response.value?.command !== null && response.value?.command !== undefined) {
          await this.complete(response.value.command)
        }
      } catch (_error) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- A selection change may abort a pending poll.
        if (!request.signal.aborted && !this.lifetime.signal.aborted) {
          // The plugin may be unloaded or absent; retry only while this Browser provider lives.
          await new Promise<void>((resolve) => {
            const done = (): void => { this.lifetime.signal.removeEventListener('abort', abort); resolve() }
            const abort = (): void => { clearTimeout(timer); done() }
            const timer = setTimeout(done, 2000)
            this.lifetime.signal.addEventListener('abort', abort, { once: true })
          })
        }
      } finally {
        if (this.pending === request) this.pending = undefined
      }
    }
  }
}
