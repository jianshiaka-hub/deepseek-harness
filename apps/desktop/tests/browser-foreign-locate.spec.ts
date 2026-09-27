import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { locateBrowserForeignFrame } from '../src/browser-foreign-locate.ts'

const topUrl = 'https://example.test/page'
const childUrl = 'https://embedded.test/widget'
const sites = ['https://example.test', 'https://embedded.test']
const query = { method: 'getByRole', value: 'button', name: 'Open', exact: true,
  frames: ['iframe[name="widget"]'] } as const

function fixture(foreign = true) {
  const descriptor = { src: foreign ? childUrl : 'https://example.test/widget', name: 'widget' }
  const child = { detached: false, frameTreeNodeId: 2,
    origin: foreign ? sites[1] : sites[0], url: descriptor.src, name: 'widget', frames: [],
    executeJavaScript: vi.fn(async (_code: string) => ({ url: descriptor.src, count: 1,
      rows: [{ ref: 'd4-1234abcd:button:Open', role: 'button', name: 'Open' }] })) }
  const top = { detached: false, frameTreeNodeId: 1, origin: sites[0], url: topUrl,
    frames: [child], framesInSubtree: [] as unknown[],
    executeJavaScript: vi.fn(async () => descriptor) }
  top.framesInSubtree.push(top, child)
  const guest: WebContents = Object.assign(Object.create(null), { mainFrame: top,
    isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => topUrl, getTitle: () => 'Top' })
  return { guest, top, child }
}

it('locates only an explicitly selected approved foreign frame and prefixes its ref', async () => {
  const h = fixture()
  await expect(locateBrowserForeignFrame(h.guest, topUrl, query, [sites[0]!]))
    .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  expect(h.top.executeJavaScript).not.toHaveBeenCalled()
  const result = await locateBrowserForeignFrame(h.guest, topUrl, query, sites)
  expect(result).toMatchObject({ url: topUrl, title: 'Top', count: 1,
    rows: [{ role: 'button', name: 'Open' }] })
  expect(result?.rows[0]?.ref).toMatch(/^x2-[a-f0-9]{64}\/d4-1234abcd:button:Open$/u)
  expect(h.child.executeJavaScript.mock.calls[0]?.[0]).toContain('getByRole')
})

it('returns null for an entirely same-origin path so the selected Webview handles it', async () => {
  const h = fixture(false)
  await expect(locateBrowserForeignFrame(h.guest, topUrl, query, [sites[0]!]))
    .resolves.toBeNull()
  expect(h.child.executeJavaScript).not.toHaveBeenCalled()
})

it('refuses an ambiguous or navigated frame before returning an element', async () => {
  const h = fixture()
  h.top.frames.push({ ...h.child, frameTreeNodeId: 3 })
  await expect(locateBrowserForeignFrame(h.guest, topUrl, query, sites))
    .rejects.toThrow('SIDEBAR_FRAME_AMBIGUOUS')
  const n = fixture()
  n.child.executeJavaScript.mockImplementationOnce(async () => {
    n.child.url = 'https://embedded.test/next'
    return { url: childUrl, count: 1, rows: [{ ref: 'd4-1234abcd:button:Open', role: 'button', name: 'Open' }] }
  })
  await expect(locateBrowserForeignFrame(n.guest, topUrl, query, sites))
    .rejects.toThrow('SIDEBAR_NAVIGATED')
})
