/** Temporary native clipboard lease for one confirmed Sidebar Browser paste. */
import { randomUUID } from 'node:crypto'

const MARKER = 'web application/x-dsh-cu-lease'
const MAX_SAVED_BYTES = 64 * 1024 * 1024
const MAX_PASTE_BYTES = 1024 * 1024

interface Bookmark { readonly title: string; readonly url: string }
interface ClipboardItemPort {
  readonly types: string[]
  getType(type: string): Promise<Blob | Bookmark>
}
interface ClipboardPort<Item> {
  read(): Promise<Item[]>
  write(items: Item[]): Promise<void>
  clear(): void
}
type StoredValue = { readonly bytes: Buffer; readonly mime: string } | { readonly bookmark: Bookmark }
type StoredItem = Map<string, StoredValue>
type PastePayload = { readonly text: string; readonly format: 'text' | 'md' | 'html'; readonly plainText?: string }
type RestoreResult = { readonly restored: boolean; readonly superseded: boolean }

function sameItems(left: readonly StoredItem[], right: readonly StoredItem[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    if (other === undefined || item.size !== other.size) return false
    for (const [type, value] of item) {
      const compared = other.get(type)
      if (compared === undefined) return false
      if ('bookmark' in value) {
        if (!('bookmark' in compared) || value.bookmark.title !== compared.bookmark.title ||
          value.bookmark.url !== compared.bookmark.url) return false
      } else if ('bookmark' in compared || value.mime !== compared.mime || !value.bytes.equals(compared.bytes)) return false
    }
    return true
  })
}

/** An application-wide lock; never restore over a newer human copy. */
export class BrowserClipboardLease<Item extends ClipboardItemPort> {
  private busy = false
  private active: {
    token: string
    saved: StoredItem[]
    staged: StoredItem[]
    timer: ReturnType<typeof setTimeout>
    closing?: Promise<RestoreResult>
  } | undefined

  constructor(private readonly board: ClipboardPort<Item>,
    private readonly makeItem: (entries: Record<string, string | Blob | Bookmark>) => Item) {}

  get activeToken(): string | undefined { return this.active?.token }

  private async capture(): Promise<StoredItem[]> {
    const result: StoredItem[] = []
    let total = 0
    for (const item of await this.board.read()) {
      if (item.types.length === 0) continue
      const values: StoredItem = new Map()
      for (const type of item.types) {
        const value = await item.getType(type)
        if (value instanceof Blob) {
          total += value.size
          if (total > MAX_SAVED_BYTES) throw new Error('SIDEBAR_CLIPBOARD_TOO_LARGE')
          values.set(type, { bytes: Buffer.from(await value.arrayBuffer()), mime: value.type })
        } else {
          values.set(type, { bookmark: { title: value.title, url: value.url } })
        }
      }
      result.push(values)
    }
    return result
  }

  private recreate(items: readonly StoredItem[]): Item[] {
    return items.map((item) => {
      const entries: Record<string, string | Blob | Bookmark> = {}
      for (const [type, value] of item) {
        entries[type] = 'bookmark' in value ? value.bookmark :
          new Blob([Uint8Array.from(value.bytes)], { type: value.mime })
      }
      return this.makeItem(entries)
    })
  }

  private async owns(token: string): Promise<boolean> {
    for (const item of await this.board.read()) {
      if (!item.types.includes(MARKER)) continue
      const value = await item.getType(MARKER)
      if (value instanceof Blob && await value.text() === token) return true
    }
    return false
  }

  /** Stage one bounded paste only after the Host's site and one-use approval. */
  async begin(payload: PastePayload): Promise<string> {
    if (this.busy) throw new Error('SIDEBAR_CLIPBOARD_BUSY')
    if (!['text', 'md', 'html'].includes(payload.format) || typeof payload.text !== 'string' ||
      Buffer.byteLength(payload.text) > MAX_PASTE_BYTES ||
      payload.format === 'html' && (typeof payload.plainText !== 'string' ||
        Buffer.byteLength(payload.plainText) > MAX_PASTE_BYTES) ||
      payload.format !== 'html' && payload.plainText !== undefined) {
      throw new Error('SIDEBAR_PASTE_UNAVAILABLE')
    }
    this.busy = true
    let saved: StoredItem[] | undefined
    let token: string | undefined
    let stagedWrite = false
    try {
      saved = await this.capture()
      if (!sameItems(saved, await this.capture())) throw new Error('SIDEBAR_CLIPBOARD_CHANGED')
      token = randomUUID()
      const entries: Record<string, string | Blob | Bookmark> = {
        'text/plain': payload.format === 'html' ? payload.plainText ?? '' : payload.text,
        [MARKER]: new Blob([token], { type: 'application/x-dsh-cu-lease' }),
      }
      if (payload.format === 'html') entries['text/html'] = payload.text
      await this.board.write([this.makeItem(entries)])
      stagedWrite = true
      const staged = await this.capture()
      if (!await this.owns(token)) {
        if (sameItems(staged, await this.capture())) {
          if (saved.length === 0) this.board.clear()
          else await this.board.write(this.recreate(saved))
        }
        throw new Error('SIDEBAR_CLIPBOARD_MARKER_UNAVAILABLE')
      }
      const leaseToken = token
      const timer = setTimeout(() => { void this.finish(leaseToken).catch(() => {}) }, 15_000)
      this.active = { token, saved, staged, timer }
      return token
    } catch (error) {
      if (stagedWrite && saved !== undefined && token !== undefined) {
        try {
          if (await this.owns(token)) {
            if (saved.length === 0) this.board.clear()
            else await this.board.write(this.recreate(saved))
          }
        } catch { /* A newer clipboard or failed OS read must not be overwritten blindly. */ }
      }
      this.busy = false
      throw error
    }
  }

  /** Restore all prior formats only if the exact staged clipboard still owns the board. */
  finish(token: string): Promise<RestoreResult> {
    const active = this.active
    if (active === undefined || active.token !== token) throw new Error('SIDEBAR_CLIPBOARD_LEASE_UNAVAILABLE')
    if (active.closing !== undefined) return active.closing
    clearTimeout(active.timer)
    active.closing = (async () => {
      const current = await this.capture()
      if (!sameItems(current, active.staged) ||
        !sameItems(await this.capture(), active.staged)) return { restored: false, superseded: true }
      if (active.saved.length === 0) this.board.clear()
      else await this.board.write(this.recreate(active.saved))
      return { restored: true, superseded: false }
    })().finally(() => {
      if (this.active === active) this.active = undefined
      this.busy = false
    })
    return active.closing
  }
}

export type { PastePayload, RestoreResult }
