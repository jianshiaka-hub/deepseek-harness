import { describe, expect, it } from 'vitest'
import { BrowserClipboardLease } from '../src/browser-clipboard.ts'

type Bookmark = { readonly title: string; readonly url: string }
type Value = string | Blob | Bookmark

class Item {
  readonly types: string[]
  readonly values: Record<string, Value>
  constructor(entries: Record<string, Value>) {
    this.types = Object.keys(entries)
    this.values = entries
  }
  async getType(type: string): Promise<Blob | Bookmark> {
    const value = this.values[type]
    if (value === undefined) throw new Error('missing clipboard format')
    return typeof value === 'string' ? new Blob([value], { type }) : value
  }
}

class Board {
  items: Item[] = []
  writes = 0
  reads = 0
  failReadAt: number | undefined
  afterRead: (() => void) | undefined
  async read(): Promise<Item[]> {
    if (++this.reads === this.failReadAt) throw new Error('clipboard read failed')
    const result = this.items
    this.afterRead?.()
    return result
  }
  async write(items: Item[]): Promise<void> { this.items = items; this.writes++ }
  clear(): void { this.items = [] }
}

const makeItem = (entries: Record<string, Value>): Item => new Item(entries)

describe('temporary Sidebar clipboard lease', () => {
  it('restores original text, image, custom bytes and bookmark after paste', async () => {
    const board = new Board()
    board.items = [makeItem({
      'text/plain': 'original',
      'image/png': new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }),
      'electron application/osclipboard;format="custom"': new Blob([Uint8Array.from([4, 5])]),
      'electron application/bookmark': { title: 'Page', url: 'https://example.test/' },
    })]
    const lease = new BrowserClipboardLease(board, makeItem)
    const token = await lease.begin({ text: '<b>new</b>', format: 'html', plainText: 'new' })
    expect(board.items[0]?.types).toContain('text/html')
    expect(board.items[0]?.types).toContain('web application/x-dsh-cu-lease')
    expect(await lease.finish(token)).toEqual({ restored: true, superseded: false })
    expect(await board.items[0]?.getType('text/plain').then(blob => blob instanceof Blob ? blob.text() : '')).toBe('original')
    expect(await board.items[0]?.getType('image/png').then(blob => blob instanceof Blob ? blob.arrayBuffer() : undefined))
      .toEqual(Uint8Array.from([1, 2, 3]).buffer)
    expect(await board.items[0]?.getType('electron application/bookmark'))
      .toEqual({ title: 'Page', url: 'https://example.test/' })
  })

  it('leaves a newer human copy intact and releases the busy lock', async () => {
    const board = new Board()
    board.items = [makeItem({ 'text/plain': 'original' })]
    const lease = new BrowserClipboardLease(board, makeItem)
    const token = await lease.begin({ text: 'temporary', format: 'md' })
    await expect(lease.begin({ text: 'other', format: 'text' })).rejects.toThrow('SIDEBAR_CLIPBOARD_BUSY')
    board.items = [makeItem({ 'text/plain': 'human copy' })]
    expect(await lease.finish(token)).toEqual({ restored: false, superseded: true })
    expect(await board.items[0]?.getType('text/plain').then(blob => blob instanceof Blob ? blob.text() : ''))
      .toBe('human copy')
    const next = await lease.begin({ text: 'again', format: 'text' })
    expect(await lease.finish(next)).toEqual({ restored: true, superseded: false })
  })

  it('refuses to stage if the clipboard changes while being saved', async () => {
    const board = new Board()
    board.items = [makeItem({ 'text/plain': 'old' })]
    let reads = 0
    board.afterRead = () => { if (++reads === 1) board.items = [makeItem({ 'text/plain': 'new' })] }
    const lease = new BrowserClipboardLease(board, makeItem)
    await expect(lease.begin({ text: 'temporary', format: 'text' })).rejects.toThrow('SIDEBAR_CLIPBOARD_CHANGED')
    expect(board.writes).toBe(0)
  })

  it('restores a staged paste if post-write clipboard inspection fails', async () => {
    const board = new Board()
    board.items = [makeItem({ 'text/plain': 'original' })]
    board.failReadAt = 3
    const lease = new BrowserClipboardLease(board, makeItem)
    await expect(lease.begin({ text: 'temporary', format: 'text' })).rejects.toThrow('clipboard read failed')
    expect(await board.items[0]?.getType('text/plain').then(blob => blob instanceof Blob ? blob.text() : ''))
      .toBe('original')
  })
})
