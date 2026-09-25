import { describe, expect, it, vi } from 'vitest'
import { auditBrowserFrames, captureBrowserFullPage, captureBrowserViewport, locateBrowserForeignFrame,
  pointForBrowserForeignRef, pointForBrowserDrag, stateForBrowserForeignInput,
  readBrowserForeignText,
  type ViewportCaptureGuest } from '../src/browser-full-page.ts'

const url = 'https://example.test/page'

function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes.toString('base64')
}

function image(width: number, height: number) {
  return { isEmpty: () => false, getSize: () => ({ width, height }),
    crop: (rect: { width: number; height: number }) => image(rect.width, rect.height),
    toPNG: () => Buffer.from(png(width, height), 'base64') }
}

function fixture() {
  const frame: ViewportCaptureGuest['mainFrame'] = {
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
    capturePage: vi.fn(async () => image(2, 3)),
    mainFrame: frame,
    debugger: {
      isAttached: () => state.attached,
      attach: () => { state.attached = true },
      detach: () => { state.attached = false },
      sendCommand,
    },
  } satisfies ViewportCaptureGuest
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

  it('captures a foreign frame only after its exact origin is approved and rejects a changed tree', async () => {
    const h = fixture()
    const foreign = { ...h.frame, frameTreeNodeId: 2, origin: 'https://embedded.test',
      url: 'https://embedded.test/widget', framesInSubtree: [] }
    h.frame.framesInSubtree.push(foreign)
    expect(auditBrowserFrames(h.guest, url).origins).toEqual(['https://example.test', 'https://embedded.test'])
    await expect(captureBrowserFullPage(h.guest, url)).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    await expect(captureBrowserFullPage(h.guest, url, undefined,
      ['https://example.test', 'https://embedded.test'])).resolves.toMatchObject({ base64: png(2, 3) })
    foreign.url = 'blob:https://embedded.test/5a41'
    expect(auditBrowserFrames(h.guest, url, ['https://example.test', 'https://embedded.test']).origins)
      .toEqual(['https://example.test', 'https://embedded.test'])
    foreign.url = 'about:blank#inherited'
    expect(auditBrowserFrames(h.guest, url, ['https://example.test', 'https://embedded.test']).origins)
      .toEqual(['https://example.test', 'https://embedded.test'])
    foreign.url = 'https://embedded.test/widget'
    await expect(captureBrowserFullPage(h.guest, url, undefined,
      ['https://example.test', 'https://example.test'])).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    h.sendCommand.mockImplementationOnce(async () => ({ cssContentSize: { x: 0, y: 0, width: 2, height: 3 } }))
      .mockImplementationOnce(async () => ({ result: { value: 1 } }))
      .mockImplementationOnce(async () => {
        h.frame.framesInSubtree.push({ ...foreign, frameTreeNodeId: 3,
          origin: 'https://new.test', url: 'https://new.test/' })
        return { data: png(2, 3) }
      })
    await expect(captureBrowserFullPage(h.guest, url, undefined,
      ['https://example.test', 'https://embedded.test'])).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    expect(h.state.attached).toBe(false)
  })

  it('reads bounded text and roles from a granted foreign frame and rejects navigation during the read', async () => {
    const h = fixture()
    const foreign = { ...h.frame, frameTreeNodeId: 2, origin: 'https://embedded.test',
      url: 'https://embedded.test/widget', framesInSubtree: [],
      executeJavaScript: vi.fn(async () => ({ text: 'Embedded', roles: '- button "Open"' })) }
    h.frame.framesInSubtree.push(foreign)
    await expect(readBrowserForeignText(h.guest, url, ['https://example.test']))
      .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    await expect(readBrowserForeignText(h.guest, url,
      ['https://example.test', 'https://embedded.test'])).resolves.toMatchObject({
      frames: [{ origin: 'https://embedded.test', text: 'Embedded', roles: '- button "Open"' }],
    })
    foreign.executeJavaScript.mockImplementationOnce(async () => {
      foreign.url = 'https://embedded.test/next'
      return { text: 'New content', roles: '- button "Next"' }
    })
    await expect(readBrowserForeignText(h.guest, url,
      ['https://example.test', 'https://embedded.test'])).rejects.toThrow('SIDEBAR_NAVIGATED')
  })

  it('binds foreign locators to a unique named native frame and rejects ambiguous twins', async () => {
    const h = fixture()
    const foreignUrl = 'https://embedded.test/widget'
    const first = { ...h.frame, frameTreeNodeId: 2, origin: 'https://embedded.test',
      url: foreignUrl, name: 'first', framesInSubtree: [],
      executeJavaScript: vi.fn(async () => ({ url: foreignUrl, title: 'Widget', count: 1,
        rows: [{ ref: 'd4-12345678:button:Open', role: 'button', name: 'Open' }] })) }
    const second = { ...first, frameTreeNodeId: 3, name: 'second',
      executeJavaScript: vi.fn(async () => { throw new Error('wrong foreign frame') }) }
    Object.assign(h.frame, { frames: [second, first] })
    h.frame.framesInSubtree.push(first, second)
    Object.assign(h.frame, { executeJavaScript: vi.fn(async () => ({ src: foreignUrl, name: 'first' })) })
    const query = { method: 'getByRole' as const, value: 'button', name: 'Open', exact: true,
      frames: ['#first'] }
    const approved = ['https://example.test', 'https://embedded.test']
    await expect(locateBrowserForeignFrame(h.guest, url, query, ['https://example.test']))
      .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    const result = await locateBrowserForeignFrame(h.guest, url, query, approved)
    expect(result.rows[0]?.ref).toMatch(/^x2-[a-f0-9]{64}\/d4-12345678:button:Open$/u)
    expect(first.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(second.executeJavaScript).not.toHaveBeenCalled()
    second.name = 'first'
    await expect(locateBrowserForeignFrame(h.guest, url, query, approved))
      .rejects.toThrow('SIDEBAR_FRAME_AMBIGUOUS')
  })

  it('resolves a fresh foreign element ref through only its unique native parent', async () => {
    const h = fixture()
    const foreign = { ...h.frame, frameTreeNodeId: 2, origin: 'https://embedded.test',
      url: 'https://embedded.test/widget', name: 'widget', parent: h.frame, framesInSubtree: [],
      executeJavaScript: vi.fn(async (code: string) => code.includes('return {hadText:')
        ? { hadText: true } : { x: 10, y: 5 }) }
    Object.assign(h.frame, { frames: [foreign],
      executeJavaScript: vi.fn(async () => ({ x: 31, y: 42 })) })
    h.frame.framesInSubtree.push(foreign)
    const sites = ['https://example.test', 'https://embedded.test']
    const ref = () => `x2-${auditBrowserFrames(h.guest, url, sites).fingerprint}/d4-12345678:button:Open`
    await expect(pointForBrowserForeignRef(h.guest, url, ref(), ['https://example.test']))
      .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    const point = await pointForBrowserForeignRef(h.guest, url, ref(), sites)
    expect(point).toMatchObject({ url, x: 31, y: 42, origin: 'https://embedded.test' })
    expect(foreign.executeJavaScript).toHaveBeenCalledTimes(1)
    const selected = await stateForBrowserForeignInput(h.guest, url, ref(), sites, 'select', undefined)
    expect(selected).toMatchObject({ origin: 'https://embedded.test', hadText: true })
    await expect(stateForBrowserForeignInput(h.guest, url, ref(), sites, 'verify', 'x'.repeat(4001)))
      .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
    await expect(pointForBrowserForeignRef(h.guest, url, `x2-${'0'.repeat(64)}/d4-12345678:button:Open`, sites))
      .rejects.toThrow('SIDEBAR_STALE_REF')
    const twin = { ...foreign, frameTreeNodeId: 3 }
    h.frame.framesInSubtree.push(twin)
    Object.assign(h.frame, { frames: [foreign, twin] })
    await expect(pointForBrowserForeignRef(h.guest, url, ref(), sites))
      .rejects.toThrow('SIDEBAR_FRAME_AMBIGUOUS')
  })

  it('checks each drag pixel against the exact approved and uniquely bound foreign frame', async () => {
    const h = fixture()
    const foreignUrl = 'https://embedded.test/widget'
    const foreign = { ...h.frame, frameTreeNodeId: 2, origin: 'https://embedded.test',
      url: foreignUrl, name: 'widget', parent: h.frame, framesInSubtree: [],
      executeJavaScript: vi.fn(async () => ({ kind: 'hit', fingerprint: 'DIV|drag-source' })) }
    Object.assign(h.frame, { frames: [foreign],
      executeJavaScript: vi.fn(async () => ({ kind: 'frame', src: foreignUrl, name: 'widget', x: 12, y: 9 })) })
    h.frame.framesInSubtree.push(foreign)
    await expect(pointForBrowserDrag(h.guest, url, 40, 60, ['https://example.test']))
      .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    const approved = ['https://example.test', 'https://embedded.test']
    const point = await pointForBrowserDrag(h.guest, url, 40, 60, approved)
    expect(point).toMatchObject({ url, origin: 'https://embedded.test' })
    expect(point.targetFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    const twin = { ...foreign, frameTreeNodeId: 3 }
    h.frame.framesInSubtree.push(twin)
    Object.assign(h.frame, { frames: [foreign, twin] })
    await expect(pointForBrowserDrag(h.guest, url, 40, 60, approved))
      .rejects.toThrow('SIDEBAR_FRAME_AMBIGUOUS')
  })

  it('bounds viewport pixels and rejects a frame that changes while the native capture runs', async () => {
    const h = fixture()
    const foreign = { ...h.frame, frameTreeNodeId: 2, origin: 'https://embedded.test',
      url: 'https://embedded.test/widget', framesInSubtree: [] }
    h.frame.framesInSubtree.push(foreign)
    await expect(captureBrowserViewport(h.guest, url)).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    await expect(captureBrowserViewport(h.guest, url, { x: 1, y: 1, width: 1, height: 2 },
      ['https://example.test', 'https://embedded.test'])).resolves.toEqual({
      url, title: 'Example', base64: png(1, 2), viewport: { width: 2, height: 3 },
    })
    h.guest.capturePage.mockImplementationOnce(async () => {
      foreign.url = 'https://embedded.test/next'
      return image(2, 3)
    })
    await expect(captureBrowserViewport(h.guest, url, undefined,
      ['https://example.test', 'https://embedded.test'])).rejects.toThrow('SIDEBAR_NAVIGATED')
    await expect(captureBrowserViewport(h.guest, url, { x: 2, y: 0, width: 1, height: 1 },
      ['https://example.test', 'https://embedded.test'])).rejects.toThrow('SIDEBAR_CLIP_OUT_OF_BOUNDS')
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
