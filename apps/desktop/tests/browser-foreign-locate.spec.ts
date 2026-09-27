import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { locateBrowserForeignFrame, pointForBrowserForeignRef,
  stateForBrowserForeignInput } from '../src/browser-foreign-locate.ts'
import { auditBrowserFrames } from '../src/browser-foreign-read.ts'

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

it('maps a fresh foreign ref into the guest viewport and carries its checked link target', async () => {
  const h = fixture()
  Object.assign(h.child, { parent: h.top })
  const ref = `x2-${auditBrowserFrames(h.guest, topUrl, sites).fingerprint}/d4-1234abcd:button:Open`
  await expect(pointForBrowserForeignRef(h.guest, topUrl, ref, [sites[0]!]))
    .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  Object.assign(h.child, { executeJavaScript: vi.fn(async (_code: string) => ({ x: 10, y: 5,
    targetUrl: 'https://target.test/go' })) })
  Object.assign(h.top, { executeJavaScript: vi.fn(async (_code: string) => ({ x: 31, y: 42 })) })
  await expect(pointForBrowserForeignRef(h.guest, topUrl, ref, sites))
    .resolves.toMatchObject({ url: topUrl, x: 31, y: 42,
      origin: sites[1], targetUrl: 'https://target.test/go' })
  await expect(pointForBrowserForeignRef(h.guest, topUrl,
    `x2-${'0'.repeat(64)}/d4-1234abcd:button:Open`, sites))
    .rejects.toThrow('SIDEBAR_STALE_REF')
  const unsafe = fixture()
  Object.assign(unsafe.child, { parent: unsafe.top, executeJavaScript: vi.fn(async () => ({
    x: 10, y: 5, targetUrl: 'javascript:alert(1)',
  })) })
  const unsafeRef = `x2-${auditBrowserFrames(unsafe.guest, topUrl, sites).fingerprint}/d4-1234abcd:button:Open`
  await expect(pointForBrowserForeignRef(unsafe.guest, topUrl, unsafeRef, sites))
    .rejects.toThrow('SIDEBAR_POINT_UNAVAILABLE')
})

it('focuses a verified foreign text field and returns only input state', async () => {
  const h = fixture()
  Object.assign(h.child, { parent: h.top, executeJavaScript: vi.fn()
    .mockResolvedValueOnce({ x: 10, y: 5, targetUrl: null })
    .mockResolvedValueOnce({ hadText: true }) })
  Object.assign(h.top, { executeJavaScript: vi.fn(async () => ({ x: 31, y: 42 })) })
  const ref = `x2-${auditBrowserFrames(h.guest, topUrl, sites).fingerprint}/d4-1234abcd:textbox:Name`
  await expect(stateForBrowserForeignInput(h.guest, topUrl, ref, sites, 'select', undefined))
    .resolves.toMatchObject({ url: topUrl, origin: sites[1], hadText: true })
  const code = h.child.executeJavaScript.mock.calls[1]?.[0]
  expect(code).toContain("['text','search','url','tel']")
  expect(code).toContain('node.readOnly')
  expect(code).toContain('node.select()')
  expect(code).not.toContain('return {value:')
  await expect(stateForBrowserForeignInput(h.guest, topUrl, ref, sites, 'verify', 5))
    .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
})

it('checks a foreign typing target without accepting password inputs', async () => {
  const h = fixture()
  Object.assign(h.child, { parent: h.top, executeJavaScript: vi.fn()
    .mockResolvedValueOnce({ x: 10, y: 5, targetUrl: null })
    .mockResolvedValueOnce({ hadText: false }) })
  Object.assign(h.top, { executeJavaScript: vi.fn(async () => ({ x: 31, y: 42 })) })
  const ref = `x2-${auditBrowserFrames(h.guest, topUrl, sites).fingerprint}/d4-1234abcd:textbox:Name`
  await expect(stateForBrowserForeignInput(h.guest, topUrl, ref, sites, 'focus', undefined))
    .resolves.toMatchObject({ origin: sites[1], hadText: false })
  const code = h.child.executeJavaScript.mock.calls[1]?.[0]
  expect(code).toContain("['text','search','email','url','tel','number']")
  expect(code).toContain('node.focus()')
  expect(code).toContain('sidebarActiveElement(document)')
})
