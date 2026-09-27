/** One-use, guest-bound downloads for the selected Sidebar Computer Use tab. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { DownloadItem, WebContents } from 'electron'
import type { BrowserDownloadStatus } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

type Guest = Pick<WebContents, 'getURL' | 'isDestroyed' | 'isLoadingMainFrame'> &
  Pick<EventEmitter, 'on' | 'off'>
type Item = Pick<DownloadItem, 'setSavePath' | 'pause' | 'resume' | 'cancel' | 'getURLChain' |
  'getFilename' | 'getReceivedBytes'> & Pick<EventEmitter, 'on' | 'once'>

interface ActiveDownload {
  readonly guest: Guest
  readonly expectedUrl: string
  readonly directory: string
  readonly invalidate: () => void
  readonly token: string
  readonly expectedTarget?: string
  item?: Item
  filename?: string
  path?: string
  completedPending?: boolean
  approvedOrigins: readonly string[]
  status: BrowserDownloadStatus
  timer?: ReturnType<typeof setTimeout>
}

const MAX_BYTES = 100_000_000

function chainOrigins(item: Item, source: string): string[] {
  const chain = item.getURLChain()
  if (chain.length < 1 || chain.length > 16) throw new Error('SIDEBAR_DOWNLOAD_TARGET_UNAVAILABLE')
  const sourceOrigin = new URL(source).origin
  const origins = new Set<string>([sourceOrigin])
  for (const value of chain) {
    const url = new URL(value)
    if (url.username || url.password) throw new Error('SIDEBAR_DOWNLOAD_TARGET_UNAVAILABLE')
    if (url.protocol === 'data:') continue
    if (!['http:', 'https:', 'blob:'].includes(url.protocol) ||
      url.origin === 'null') throw new Error('SIDEBAR_DOWNLOAD_TARGET_UNAVAILABLE')
    origins.add(url.origin)
  }
  return [...origins]
}

/** Holds a native download paused until every observed target origin is approved. */
export class BrowserDownloadLease {
  private readonly entries = new Map<string, ActiveDownload>()

  /** Confirm that an opaque ticket still belongs to this exact guest. */
  owns(token: string, guest: Guest): boolean { return this.entries.get(token)?.guest === guest }

  /** @param guest - The already owned, selected guest. @param expectedUrl - Its approved exact URL. */
  begin(guest: Guest, expectedUrl: string, expectedTarget?: string): string {
    if (guest.isDestroyed() || guest.isLoadingMainFrame() || guest.getURL() !== expectedUrl ||
      !['http:', 'https:'].includes(new URL(expectedUrl).protocol) ||
      (expectedTarget !== undefined && (expectedTarget.length > 16_384 || !URL.canParse(expectedTarget) ||
        !['http:', 'https:'].includes(new URL(expectedTarget).protocol) ||
        new URL(expectedTarget).href !== expectedTarget ||
        new URL(expectedTarget).username !== '' || new URL(expectedTarget).password !== '')) ||
      [...this.entries.values()].filter(entry => entry.status.state !== 'failed').length >= 16 ||
      [...this.entries.values()].some(entry => entry.guest === guest && entry.status.state !== 'failed')) {
      throw new Error('SIDEBAR_DOWNLOAD_UNAVAILABLE')
    }
    const token = randomUUID()
    const directory = mkdtempSync(join(tmpdir(), 'dsh-cu-download-'))
    const entry: ActiveDownload = { guest, expectedUrl, directory, token,
      ...(expectedTarget === undefined ? {} : { expectedTarget }),
      approvedOrigins: [], status: { state: 'waiting' },
      invalidate: () => { this.fail(entry, 'SIDEBAR_NAVIGATED') } }
    this.entries.set(token, entry)
    guest.on('did-navigate', entry.invalidate)
    guest.on('did-navigate-in-page', entry.invalidate)
    guest.on('destroyed', entry.invalidate)
    this.expire(entry, 15_000)
    return token
  }

  /** Accept only a download from the exact armed guest; the caller cancels all other items. */
  offer(item: Item, guest: Guest): boolean {
    const entry = [...this.entries.values()].find(candidate => candidate.guest === guest &&
      candidate.status.state === 'waiting' && candidate.item === undefined)
    if (entry === undefined || guest.isDestroyed() || guest.getURL() !== entry.expectedUrl) return false
    if (entry.expectedTarget !== undefined && item.getURLChain()[0] !== entry.expectedTarget) return false
    try {
      const origins = chainOrigins(item, entry.expectedUrl)
      const safeName = item.getFilename().replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 120)
      const filename = safeName === '.' || safeName === '..' ? 'download' : safeName || 'download'
      const path = join(entry.directory, filename)
      item.setSavePath(path)
      item.pause()
      entry.item = item
      entry.filename = filename
      entry.path = path
      entry.status = { state: 'offered', origins }
      this.expire(entry, 120_000)
      item.on('updated', () => { this.updated(entry) })
      item.once('done', (_event: unknown, state: unknown) => {
        this.done(entry, typeof state === 'string' ? state : 'interrupted')
      })
      return true
    } catch {
      this.fail(entry, 'SIDEBAR_DOWNLOAD_TARGET_UNAVAILABLE')
      return false
    }
  }

  /** Return only target origins until the approved download has completed. */
  poll(token: string): BrowserDownloadStatus {
    const entry = this.entries.get(token)
    if (entry === undefined) throw new Error('SIDEBAR_DOWNLOAD_LEASE_UNAVAILABLE')
    if (entry.guest.isDestroyed() || entry.guest.getURL() !== entry.expectedUrl) {
      this.fail(entry, 'SIDEBAR_NAVIGATED')
      throw new Error('SIDEBAR_NAVIGATED')
    }
    return entry.status
  }

  /** Resume the same item only after the Host has approved its complete redirect chain. */
  resume(token: string, approvedOrigins: readonly string[]): void {
    const entry = this.entries.get(token)
    if (entry === undefined || entry.status.state !== 'offered' || entry.item === undefined ||
      entry.guest.isDestroyed() || entry.guest.getURL() !== entry.expectedUrl ||
      new Set(approvedOrigins).size !== approvedOrigins.length) throw new Error('SIDEBAR_DOWNLOAD_LEASE_UNAVAILABLE')
    const origins = chainOrigins(entry.item, entry.expectedUrl)
    if (entry.expectedTarget !== undefined && entry.item.getURLChain()[0] !== entry.expectedTarget) {
      throw new Error('SIDEBAR_DOWNLOAD_TARGET_CHANGED')
    }
    if (origins.some(origin => !approvedOrigins.includes(origin))) {
      throw new Error('SIDEBAR_DOWNLOAD_SITE_NOT_APPROVED')
    }
    entry.approvedOrigins = [...approvedOrigins]
    if (entry.completedPending === true) {
      if (entry.path === undefined || entry.filename === undefined) {
        this.fail(entry, 'SIDEBAR_DOWNLOAD_FAILED')
        return
      }
      entry.status = { state: 'completed', path: entry.path, filename: entry.filename }
      this.stop(entry)
      return
    }
    entry.status = { state: 'waiting' }
    this.expire(entry, 120_000)
    entry.item.resume()
  }

  /** Cancel an unconsumed download and delete its private temporary output. */
  cancel(token: string): void {
    const entry = this.entries.get(token)
    if (entry === undefined) return
    this.entries.delete(token)
    this.stop(entry)
    if (entry.status.state !== 'completed') entry.item?.cancel()
    rmSync(entry.directory, { recursive: true, force: true })
  }

  /** Release a completed ticket while leaving its approved output for the caller. */
  finish(token: string): void {
    const entry = this.entries.get(token)
    if (entry?.status.state !== 'completed') throw new Error('SIDEBAR_DOWNLOAD_LEASE_UNAVAILABLE')
    this.entries.delete(token)
    this.stop(entry)
  }

  /** Revoke pending tickets before an owned webview is released. */
  cancelGuest(guest: Guest): void {
    for (const [token, entry] of this.entries) if (entry.guest === guest) this.cancel(token)
  }

  /** Revoke every lease when the owning Desktop window closes. */
  dispose(): void { for (const token of this.entries.keys()) this.cancel(token) }

  private updated(entry: ActiveDownload): void {
    if (!this.entries.has(entry.token) || entry.item === undefined) return
    try {
      if (entry.item.getReceivedBytes() > MAX_BYTES) throw new Error('SIDEBAR_DOWNLOAD_SIZE_LIMIT')
      const origins = chainOrigins(entry.item, entry.expectedUrl)
      if (entry.expectedTarget !== undefined && entry.item.getURLChain()[0] !== entry.expectedTarget) {
        throw new Error('SIDEBAR_DOWNLOAD_TARGET_CHANGED')
      }
      if (origins.some(origin => !entry.approvedOrigins.includes(origin))) {
        entry.item.pause()
        entry.status = { state: 'offered', origins }
      }
    } catch { this.fail(entry, 'SIDEBAR_DOWNLOAD_TARGET_CHANGED') }
  }

  private done(entry: ActiveDownload, state: string): void {
    if (!this.entries.has(entry.token) || entry.item === undefined) return
    try {
      const origins = chainOrigins(entry.item, entry.expectedUrl)
      if (entry.expectedTarget !== undefined && entry.item.getURLChain()[0] !== entry.expectedTarget) {
        throw new Error('SIDEBAR_DOWNLOAD_TARGET_CHANGED')
      }
      if (state !== 'completed') {
        this.fail(entry, 'SIDEBAR_DOWNLOAD_INTERRUPTED')
        return
      }
      if (entry.item.getReceivedBytes() > MAX_BYTES) {
        this.fail(entry, 'SIDEBAR_DOWNLOAD_SIZE_LIMIT')
        return
      }
      if (entry.path === undefined || entry.filename === undefined) {
        this.fail(entry, 'SIDEBAR_DOWNLOAD_FAILED')
        return
      }
      if (origins.some(origin => !entry.approvedOrigins.includes(origin))) {
        entry.completedPending = true
        entry.status = { state: 'offered', origins }
        this.expire(entry, 120_000)
        return
      }
      entry.status = { state: 'completed', path: entry.path, filename: entry.filename }
      this.stop(entry)
    } catch { this.fail(entry, 'SIDEBAR_DOWNLOAD_TARGET_CHANGED') }
  }

  private fail(entry: ActiveDownload, reason: string): void {
    if (!this.entries.has(entry.token) || entry.status.state === 'failed' ||
      entry.status.state === 'completed') return
    entry.item?.cancel()
    entry.status = { state: 'failed', reason }
    this.stop(entry)
    rmSync(entry.directory, { recursive: true, force: true })
  }

  private stop(entry: ActiveDownload): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.guest.off('did-navigate', entry.invalidate)
    entry.guest.off('did-navigate-in-page', entry.invalidate)
    entry.guest.off('destroyed', entry.invalidate)
  }

  private expire(entry: ActiveDownload, milliseconds: number): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { this.fail(entry, 'SIDEBAR_DOWNLOAD_TIMEOUT') }, milliseconds)
    entry.timer.unref()
  }
}
