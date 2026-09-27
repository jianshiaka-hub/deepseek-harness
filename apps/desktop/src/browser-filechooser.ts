/** One selected Sidebar guest's next native file-input chooser. */
import { randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'

type Guest = Pick<WebContents, 'debugger' | 'getURL' | 'isDestroyed' | 'isLoadingMainFrame'> &
  Pick<EventEmitter, 'on' | 'off'>

export type BrowserFileChooserStatus =
  | { readonly state: 'waiting' }
  | { readonly state: 'offered'; readonly origin: string; readonly multiple: boolean }
  | { readonly state: 'failed'; readonly reason: string }

interface ActiveChooser {
  readonly token: string
  readonly guest: Guest
  readonly expectedUrl: string
  readonly onMessage: (_event: unknown, method: string, params: unknown) => void
  readonly onDetach: () => void
  readonly onNavigate: () => void
  timer: ReturnType<typeof setTimeout>
  status: BrowserFileChooserStatus
  backendNodeId?: number
  frameId?: string
  frameUrl?: string
  frameLoaderId?: string
  closed: boolean
}

function frameDocument(tree: unknown, id: string): { readonly url: string; readonly loaderId: string } | undefined {
  if (typeof tree !== 'object' || tree === null) return undefined
  const node = tree as { frame?: { id?: unknown; url?: unknown; loaderId?: unknown }; childFrames?: unknown }
  if (node.frame?.id === id && typeof node.frame.url === 'string' &&
    typeof node.frame.loaderId === 'string') {
    return { url: node.frame.url, loaderId: node.frame.loaderId }
  }
  if (!Array.isArray(node.childFrames)) return undefined
  for (const child of node.childFrames) {
    const found = frameDocument(child, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** Intercepts one file input so no native picker bypasses the Host's file approval. */
export class BrowserFileChooserLease {
  private readonly entries = new Map<string, ActiveChooser>()

  owns(token: string, guest: Guest): boolean { return this.entries.get(token)?.guest === guest }

  ownsGuest(guest: Guest): boolean {
    return [...this.entries.values()].some(entry => entry.guest === guest && !entry.closed)
  }

  async begin(guest: Guest, expectedUrl: string): Promise<string> {
    if (guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl ||
      !URL.canParse(expectedUrl) || !['http:', 'https:'].includes(new URL(expectedUrl).protocol) ||
      guest.debugger.isAttached() || this.ownsGuest(guest)) throw new Error('SIDEBAR_FILECHOOSER_UNAVAILABLE')
    const token = randomUUID()
    let entry: ActiveChooser | undefined
    const onNavigate = (): void => { if (entry !== undefined) void this.fail(entry, 'SIDEBAR_NAVIGATED') }
    const onDetach = (): void => { if (entry !== undefined) void this.fail(entry, 'SIDEBAR_FILECHOOSER_DETACHED') }
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      if (method !== 'Page.fileChooserOpened' || entry === undefined || entry.closed ||
        entry.status.state !== 'waiting') return
      const data = params as { frameId?: unknown; backendNodeId?: unknown; mode?: unknown } | null
      if (data === null || typeof data.frameId !== 'string' || data.frameId.length > 128 ||
        !Number.isSafeInteger(data.backendNodeId) || Number(data.backendNodeId) <= 0 ||
        !['selectSingle', 'selectMultiple'].includes(String(data.mode))) {
        void this.fail(entry, 'SIDEBAR_FILECHOOSER_TARGET_UNAVAILABLE')
        return
      }
      const active = entry
      void guest.debugger.sendCommand('Page.getFrameTree').then((result: unknown) => {
        if (active.closed || active.status.state !== 'waiting' || guest.isDestroyed() ||
          guest.getURL() !== expectedUrl) return
        const frame = frameDocument((result as { frameTree?: unknown } | null)?.frameTree, data.frameId as string)
        if (frame === undefined || !URL.canParse(frame.url) ||
          !['http:', 'https:'].includes(new URL(frame.url).protocol) ||
          new URL(frame.url).username !== '' || new URL(frame.url).password !== '') {
          void this.fail(active, 'SIDEBAR_FILECHOOSER_TARGET_UNAVAILABLE')
          return
        }
        active.backendNodeId = data.backendNodeId as number
        active.frameId = data.frameId as string
        active.frameUrl = frame.url
        active.frameLoaderId = frame.loaderId
        active.status = { state: 'offered', origin: new URL(frame.url).origin,
          multiple: data.mode === 'selectMultiple' }
        clearTimeout(active.timer)
        active.timer = setTimeout(() => { void this.fail(active, 'SIDEBAR_FILECHOOSER_TIMEOUT') }, 300_000)
        active.timer.unref()
      }).catch(() => { void this.fail(active, 'SIDEBAR_FILECHOOSER_TARGET_UNAVAILABLE') })
    }
    guest.debugger.attach('1.3')
    try {
      const timer = setTimeout(() => { if (entry !== undefined) void this.fail(entry, 'SIDEBAR_FILECHOOSER_TIMEOUT') }, 60_000)
      timer.unref()
      entry = { token, guest, expectedUrl, onMessage, onDetach, onNavigate, timer,
        status: { state: 'waiting' }, closed: false }
      this.entries.set(token, entry)
      guest.debugger.on('message', onMessage)
      guest.debugger.on('detach', onDetach)
      guest.on('did-navigate', onNavigate)
      guest.on('did-navigate-in-page', onNavigate)
      guest.on('destroyed', onNavigate)
      await guest.debugger.sendCommand('Page.enable')
      await guest.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true })
      if (entry.closed || guest.isDestroyed() || guest.getURL() !== expectedUrl) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
      return token
    } catch (error) {
      if (entry !== undefined) await this.cancel(token)
      else if (guest.debugger.isAttached()) guest.debugger.detach()
      throw error
    }
  }

  poll(token: string): BrowserFileChooserStatus {
    const entry = this.entries.get(token)
    if (entry === undefined) throw new Error('SIDEBAR_FILECHOOSER_LEASE_UNAVAILABLE')
    if (entry.guest.isDestroyed() || entry.guest.getURL() !== entry.expectedUrl) {
      void this.fail(entry, 'SIDEBAR_NAVIGATED')
      throw new Error('SIDEBAR_NAVIGATED')
    }
    return entry.status
  }

  async setFiles(token: string, origin: string, files: readonly string[]): Promise<void> {
    const entry = this.entries.get(token)
    if (entry === undefined || entry.closed || entry.status.state !== 'offered' ||
      entry.status.origin !== origin || entry.backendNodeId === undefined ||
      entry.guest.isDestroyed() || entry.guest.getURL() !== entry.expectedUrl ||
      !Array.isArray(files) || files.length > 32 ||
      !entry.status.multiple && files.length > 1) {
      throw new Error('SIDEBAR_FILECHOOSER_LEASE_UNAVAILABLE')
    }
    const canonical = files.map((file) => {
      if (typeof file !== 'string' || file.length < 1 || file.length > 4096 || !isAbsolute(file)) {
        throw new Error('UPLOAD_FILE_UNAVAILABLE')
      }
      const path = realpathSync(file)
      if (!statSync(path).isFile()) throw new Error('UPLOAD_FILE_UNAVAILABLE')
      return path
    })
    try {
      const tree: unknown = await entry.guest.debugger.sendCommand('Page.getFrameTree')
      const frame = frameDocument((tree as { frameTree?: unknown } | null)?.frameTree, entry.frameId ?? '')
      if (frame === undefined || frame.url !== entry.frameUrl || frame.loaderId !== entry.frameLoaderId ||
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- Navigation can close this lease while CDP awaits.
        entry.closed || entry.guest.isDestroyed() || entry.guest.getURL() !== entry.expectedUrl) {
        throw new Error('SIDEBAR_FILECHOOSER_FRAME_CHANGED')
      }
      await entry.guest.debugger.sendCommand('DOM.setFileInputFiles', {
        files: canonical, backendNodeId: entry.backendNodeId,
      })
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- The guest can detach while CDP sets files.
      if (entry.closed || entry.guest.isDestroyed() || entry.guest.getURL() !== entry.expectedUrl) {
        throw new Error('SIDEBAR_NAVIGATED')
      }
    } finally { await this.cancel(token) }
  }

  async cancel(token: string): Promise<void> {
    const entry = this.entries.get(token)
    if (entry === undefined) return
    this.entries.delete(token)
    await this.close(entry)
  }

  async cancelGuest(guest: Guest): Promise<void> {
    for (const [token, entry] of this.entries) if (entry.guest === guest) await this.cancel(token)
  }

  async dispose(): Promise<void> {
    for (const token of this.entries.keys()) await this.cancel(token)
  }

  private async fail(entry: ActiveChooser, reason: string): Promise<void> {
    if (entry.closed || entry.status.state === 'failed') return
    entry.status = { state: 'failed', reason }
    await this.close(entry)
  }

  private async close(entry: ActiveChooser): Promise<void> {
    if (entry.closed) return
    entry.closed = true
    clearTimeout(entry.timer)
    entry.guest.debugger.off('message', entry.onMessage)
    entry.guest.debugger.off('detach', entry.onDetach)
    entry.guest.off('did-navigate', entry.onNavigate)
    entry.guest.off('did-navigate-in-page', entry.onNavigate)
    entry.guest.off('destroyed', entry.onNavigate)
    if (entry.guest.debugger.isAttached()) {
      await entry.guest.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
      if (entry.guest.debugger.isAttached()) entry.guest.debugger.detach()
    }
  }
}
