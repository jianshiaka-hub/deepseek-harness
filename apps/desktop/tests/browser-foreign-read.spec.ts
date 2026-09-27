import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { auditBrowserFrames, captureBrowserFullPage, captureBrowserViewport,
  readBrowserForeignText } from '../src/browser-foreign-read.ts'

const topUrl = 'https://example.test/page'
const sites = ['https://example.test', 'https://embedded.test']

function fixture() {
  const top = { detached: false, frameTreeNodeId: 1, origin: sites[0]!, url: topUrl,
    framesInSubtree: [] as Array<{ detached: boolean
      frameTreeNodeId: number
      origin: string
      url: string
      executeJavaScript?: (code: string) => Promise<object> }> }
  const foreign = { detached: false, frameTreeNodeId: 2, origin: sites[1]!,
    url: 'https://embedded.test/widget', executeJavaScript: vi.fn(async () =>
      ({ text: 'Foreign visible text', roles: '- button "Open"' })) }
  top.framesInSubtree.push(top, foreign)
  const guest = { mainFrame: top, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => topUrl } as WebContents
  return { top, foreign, guest }
}

it('audits real frame origins and reads only after every exact origin is approved', async () => {
  const h = fixture()
  const audit = auditBrowserFrames(h.guest, topUrl)
  expect(audit.origins).toEqual(sites)
  expect(audit.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  await expect(readBrowserForeignText(h.guest, topUrl, [sites[0]!]))
    .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  expect(h.foreign.executeJavaScript).not.toHaveBeenCalled()
  await expect(readBrowserForeignText(h.guest, topUrl, sites)).resolves.toMatchObject({
    frames: [{ origin: sites[1], text: 'Foreign visible text', roles: '- button "Open"' }],
  })
})

it('refuses a foreign frame that changes during its bounded read', async () => {
  const h = fixture()
  h.foreign.executeJavaScript.mockImplementationOnce(async () => {
    h.foreign.url = 'https://embedded.test/next'
    return { text: 'New content', roles: '- button "Next"' }
  })
  await expect(readBrowserForeignText(h.guest, topUrl, sites))
    .rejects.toThrow('SIDEBAR_NAVIGATED')
})

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

it('captures approved foreign-frame pixels from only the named guest viewport', async () => {
  const h = fixture()
  const image = { getSize: () => ({ width: 4, height: 3 }), isEmpty: () => false,
    toPNG: () => png(4, 3), crop: vi.fn(() => ({ getSize: () => ({ width: 2, height: 1 }),
      isEmpty: () => false, toPNG: () => png(2, 1) })) }
  const capturePage = vi.fn(async () => image)
  Object.assign(h.guest, { capturePage, getTitle: () => 'Page' })
  await expect(captureBrowserViewport(h.guest, topUrl, undefined, [sites[0]!]))
    .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  expect(capturePage).not.toHaveBeenCalled()
  const clip = { x: 1, y: 1, width: 2, height: 1 }
  const result = await captureBrowserViewport(h.guest, topUrl, clip, sites)
  expect(result).toEqual({ url: topUrl, title: 'Page',
    base64: png(2, 1).toString('base64'), viewport: { width: 4, height: 3 } })
  expect(image.crop).toHaveBeenCalledWith(clip)
  await expect(captureBrowserViewport(h.guest, topUrl,
    { x: 3, y: 2, width: 2, height: 1 }, sites))
    .rejects.toThrow('SIDEBAR_CLIP_OUT_OF_BOUNDS')
})

it('refuses a viewport capture if a foreign frame changes while capturing', async () => {
  const h = fixture()
  Object.assign(h.guest, { capturePage: vi.fn(async () => {
    h.foreign.url = 'https://embedded.test/next'
    return { getSize: () => ({ width: 1, height: 1 }), isEmpty: () => false,
      toPNG: () => png(1, 1) }
  }), getTitle: () => 'Page' })
  await expect(captureBrowserViewport(h.guest, topUrl, undefined, sites))
    .rejects.toThrow('SIDEBAR_NAVIGATED')
})

it('captures an approved full page with fixed CDP commands and detaches', async () => {
  const h = fixture()
  let attached = false
  const sendCommand = vi.fn(async (name: string) => {
    if (name === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0,
      width: 3, height: 2 } }
    if (name === 'Runtime.evaluate') return { result: { value: 1 } }
    if (name === 'Page.captureScreenshot') return { data: png(3, 2).toString('base64') }
    throw new Error('Unexpected CDP command')
  })
  const debuggerApi = { isAttached: () => attached, attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }), sendCommand }
  Object.assign(h.guest, { debugger: debuggerApi, getTitle: () => 'Page' })
  await expect(captureBrowserFullPage(h.guest, topUrl, undefined, [sites[0]!]))
    .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  expect(debuggerApi.attach).not.toHaveBeenCalled()
  const result = await captureBrowserFullPage(h.guest, topUrl, undefined, sites)
  expect(result.base64).toBe(png(3, 2).toString('base64'))
  expect(result.viewport).toEqual({ width: 3, height: 2 })
  expect(sendCommand.mock.calls.map(call => call[0])).toEqual([
    'Page.getLayoutMetrics', 'Runtime.evaluate', 'Page.captureScreenshot',
  ])
  expect(debuggerApi.detach).toHaveBeenCalledOnce()
  expect(attached).toBe(false)
})

it('discards a full-page image if the foreign frame navigates before delivery', async () => {
  const h = fixture()
  let attached = false
  const debuggerApi = { isAttached: () => attached, attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }), sendCommand: vi.fn(async (name: string) => {
      if (name === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0,
        width: 1, height: 1 } }
      if (name === 'Runtime.evaluate') return { result: { value: 1 } }
      h.foreign.url = 'https://embedded.test/next'
      return { data: png(1, 1).toString('base64') }
    }) }
  Object.assign(h.guest, { debugger: debuggerApi, getTitle: () => 'Page' })
  await expect(captureBrowserFullPage(h.guest, topUrl, undefined, sites))
    .rejects.toThrow('SIDEBAR_NAVIGATED')
  expect(debuggerApi.detach).toHaveBeenCalledOnce()
  expect(attached).toBe(false)
})
