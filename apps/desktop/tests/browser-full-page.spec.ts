import { describe, expect, it, vi } from 'vitest'
import { captureBrowserFullPage, type FullPageCaptureGuest } from '../src/browser-full-page.ts'

const url = 'https://example.test/page'

function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

function fixture() {
  const frame: FullPageCaptureGuest['mainFrame'] = {
    detached: false, frameTreeNodeId: 1, origin: 'https://example.test', url, framesInSubtree: [],
  }
  frame.framesInSubtree.push(frame)
  const state = { url, loading: false, destroyed: false, attached: false, pixelRatio: 1 }
  const sendCommand = vi.fn(async (method: string, params?: object): Promise<unknown> => {
    if (method === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 2, height: 3 } }
    if (method === 'Runtime.evaluate') return { result: { value: state.pixelRatio } }
    if (method === 'Page.captureScreenshot') {
      const clip = params !== undefined && 'clip' in params ? params.clip : undefined
      if (typeof clip !== 'object' || clip === null || !('width' in clip) || !('height' in clip) ||
        typeof clip.width !== 'number' || typeof clip.height !== 'number') throw new Error('missing clip')
      return { data: png(clip.width, clip.height) }
    }
    throw new Error(`Unexpected command ${method}`)
  })
  const guest = {
    isDestroyed: () => state.destroyed,
    isLoadingMainFrame: () => state.loading,
    getURL: () => state.url,
    getTitle: () => 'Example',
    mainFrame: frame,
    debugger: {
      isAttached: () => state.attached,
      attach: () => { state.attached = true },
      detach: () => { state.attached = false },
      sendCommand,
    },
  } satisfies FullPageCaptureGuest
  return { guest, frame, state, sendCommand }
}

describe('main-owned Sidebar full-page capture', () => {
  it('captures bounded CSS content and clips without exposing debugger commands to the caller', async () => {
    const h = fixture()
    const image = await captureBrowserFullPage(h.guest, url)
    expect(image).toEqual({ url, title: 'Example', base64: png(2, 3), viewport: { width: 2, height: 3 } })
    expect(h.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'window.devicePixelRatio', returnByValue: true,
    })
    expect(h.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 2, height: 3, scale: 1 },
    })
    expect(h.state.attached).toBe(false)
    h.sendCommand.mockClear()
    const cropped = await captureBrowserFullPage(h.guest, url, { x: 1, y: 1, width: 1, height: 2 })
    expect(cropped.base64).toBe(png(1, 2))
    expect(cropped.viewport).toEqual({ width: 2, height: 3 })
    expect(h.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: 1, y: 1, width: 1, height: 2, scale: 1 },
    })
  })

  it('scales Retina output back to CSS pixels and rejects untrusted pixel ratios', async () => {
    const h = fixture()
    h.state.pixelRatio = 2
    await expect(captureBrowserFullPage(h.guest, url)).resolves.toMatchObject({ viewport: { width: 2, height: 3 } })
    expect(h.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 2, height: 3, scale: 0.5 },
    })
    h.state.pixelRatio = 0
    await expect(captureBrowserFullPage(h.guest, url)).rejects.toThrow('SIDEBAR_IMAGE_UNAVAILABLE')
    expect(h.state.attached).toBe(false)
  })

  it('rejects foreign frames, stale navigation, oversized geometry, and bad PNGs', async () => {
    const h = fixture()
    h.frame.framesInSubtree.push({ ...h.frame, frameTreeNodeId: 2, origin: 'https://foreign.test',
      url: 'https://foreign.test/', framesInSubtree: [] })
    await expect(captureBrowserFullPage(h.guest, url)).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    expect(h.sendCommand).not.toHaveBeenCalled()
    h.frame.framesInSubtree.pop()
    await expect(captureBrowserFullPage(h.guest, url, { x: 2, y: 0, width: 1, height: 1 }))
      .rejects.toThrow('SIDEBAR_CLIP_OUT_OF_BOUNDS')
    expect(h.state.attached).toBe(false)
    h.state.url = 'https://other.test/'
    await expect(captureBrowserFullPage(h.guest, url)).rejects.toThrow('SIDEBAR_NAVIGATED')
    h.state.url = url
    h.sendCommand.mockImplementationOnce(async () => ({ cssContentSize: { x: 0, y: 0, width: 8192, height: 8192 } }))
    await expect(captureBrowserFullPage(h.guest, url)).rejects.toThrow('SIDEBAR_IMAGE_TOO_LARGE')
    h.sendCommand.mockImplementationOnce(async () => ({ cssContentSize: { x: 0, y: 0, width: 2, height: 3 } }))
      .mockImplementationOnce(async () => ({ result: { value: 1 } }))
      .mockImplementationOnce(async () => ({ data: 'not-a-png' }))
    await expect(captureBrowserFullPage(h.guest, url)).rejects.toThrow('SIDEBAR_IMAGE_UNAVAILABLE')
    expect(h.state.attached).toBe(false)
  })

  it('discards pixels if a frame changes during capture', async () => {
    const h = fixture()
    h.sendCommand.mockImplementationOnce(async () => ({ cssContentSize: { x: 0, y: 0, width: 2, height: 3 } }))
      .mockImplementationOnce(async () => ({ result: { value: 1 } }))
      .mockImplementationOnce(async () => {
        h.frame.framesInSubtree.push({ ...h.frame, frameTreeNodeId: 3, origin: 'https://foreign.test',
          url: 'https://foreign.test/', framesInSubtree: [] })
        return { data: png(2, 3) }
      })
    await expect(captureBrowserFullPage(h.guest, url)).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    expect(h.state.attached).toBe(false)
  })
})
