import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BrowserDownloadLease } from '../src/browser-download.ts'

const source = 'https://example.test/page'

function fixture() {
  const state = { url: source, destroyed: false, loading: false,
    chain: ['https://files.test/report.csv'], bytes: 4 }
  const guest = Object.assign(new EventEmitter(), {
    getURL: () => state.url, isDestroyed: () => state.destroyed,
    isLoadingMainFrame: () => state.loading,
  })
  const item = Object.assign(new EventEmitter(), {
    setSavePath: vi.fn<(path: string) => void>(),
    pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
    getURLChain: () => state.chain, getFilename: () => '../report.csv',
    getReceivedBytes: () => state.bytes,
  })
  return { state, guest, item }
}

describe('one-use Sidebar native download lease', () => {
  it('accepts only the pinned locator URL for an explicit download', () => {
    const h = fixture()
    const lease = new BrowserDownloadLease()
    const token = lease.begin(h.guest, source, 'https://files.test/report.csv')
    h.state.chain = ['https://files.test/other.csv']
    expect(lease.offer(h.item, h.guest)).toBe(false)
    expect(lease.poll(token)).toEqual({ state: 'waiting' })
    h.state.chain = ['https://files.test/report.csv']
    expect(lease.offer(h.item, h.guest)).toBe(true)
    lease.resume(token, ['https://example.test', 'https://files.test'])
    h.state.chain[0] = 'https://files.test/replaced.csv'
    h.item.emit('updated', {}, 'progressing')
    expect(lease.poll(token)).toEqual({ state: 'failed', reason: 'SIDEBAR_DOWNLOAD_TARGET_CHANGED' })
    lease.cancel(token)
  })
  it('pauses a foreign target until every exact origin is approved, including redirects', () => {
    const h = fixture()
    const lease = new BrowserDownloadLease()
    const token = lease.begin(h.guest, source)
    expect(lease.offer(h.item, h.guest)).toBe(true)
    expect(h.item.pause).toHaveBeenCalledOnce()
    expect(lease.poll(token)).toEqual({ state: 'offered',
      origins: ['https://example.test', 'https://files.test'] })
    expect(() => { lease.resume(token, ['https://example.test']) }).toThrow('SIDEBAR_DOWNLOAD_SITE_NOT_APPROVED')
    expect(h.item.resume).not.toHaveBeenCalled()
    lease.resume(token, ['https://example.test', 'https://files.test'])
    expect(h.item.resume).toHaveBeenCalledOnce()
    h.state.chain.push('https://cdn.test/report.csv')
    h.item.emit('updated', {}, 'progressing')
    expect(lease.poll(token)).toEqual({ state: 'offered',
      origins: ['https://example.test', 'https://files.test', 'https://cdn.test'] })
    lease.resume(token, ['https://example.test', 'https://files.test', 'https://cdn.test'])
    h.item.emit('done', {}, 'completed')
    const result = lease.poll(token)
    expect(result).toMatchObject({ state: 'completed', filename: '.._report.csv' })
    if (result.state !== 'completed') throw new Error('download did not complete')
    expect(dirname(result.path)).toContain('dsh-cu-download-')
    expect(existsSync(dirname(result.path))).toBe(true)
    lease.cancel(token)
    rmSync(dirname(result.path), { recursive: true, force: true })
  })

  it('refuses unarmed guests and removes a paused output when the selected page navigates', () => {
    const h = fixture()
    const lease = new BrowserDownloadLease()
    expect(lease.offer(h.item, h.guest)).toBe(false)
    const token = lease.begin(h.guest, source)
    expect(lease.offer(h.item, h.guest)).toBe(true)
    const path = h.item.setSavePath.mock.calls[0]?.[0]
    if (path === undefined) throw new Error('save path missing')
    h.state.url = 'https://other.test/'
    h.guest.emit('did-navigate')
    expect(() => lease.poll(token)).toThrow('SIDEBAR_NAVIGATED')
    expect(h.item.cancel).toHaveBeenCalled()
    expect(existsSync(dirname(path))).toBe(false)
    lease.cancel(token)
  })

  it('rejects oversized, malformed and unapproved final redirects', () => {
    const h = fixture()
    const lease = new BrowserDownloadLease()
    const token = lease.begin(h.guest, source)
    expect(lease.offer(h.item, h.guest)).toBe(true)
    lease.resume(token, ['https://example.test', 'https://files.test'])
    h.state.bytes = 100_000_001
    h.item.emit('updated', {}, 'progressing')
    expect(lease.poll(token).state).toBe('failed')
    lease.cancel(token)
    h.state.bytes = 4
    h.state.chain = ['javascript:alert(1)']
    const next = lease.begin(h.guest, source)
    expect(lease.offer(h.item, h.guest)).toBe(false)
    expect(lease.poll(next).state).toBe('failed')
    lease.dispose()
  })

  it('quarantines a fast completed transfer until every target origin is approved', () => {
    const h = fixture()
    const lease = new BrowserDownloadLease()
    const token = lease.begin(h.guest, source)
    expect(lease.offer(h.item, h.guest)).toBe(true)
    h.item.emit('done', {}, 'completed')
    expect(lease.poll(token)).toEqual({ state: 'offered',
      origins: ['https://example.test', 'https://files.test'] })
    expect(h.item.resume).not.toHaveBeenCalled()
    lease.resume(token, ['https://example.test', 'https://files.test'])
    expect(lease.poll(token).state).toBe('completed')
    expect(h.item.resume).not.toHaveBeenCalled()
    const completed = lease.poll(token)
    if (completed.state !== 'completed') throw new Error('download did not complete')
    lease.finish(token)
    expect(() => lease.poll(token)).toThrow('SIDEBAR_DOWNLOAD_LEASE_UNAVAILABLE')
    expect(existsSync(dirname(completed.path))).toBe(true)
    rmSync(dirname(completed.path), { recursive: true, force: true })
  })
})
