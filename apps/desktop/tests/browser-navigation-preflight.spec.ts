import { describe, expect, it, vi } from 'vitest'
import { BrowserNavigationPreflight } from '../src/browser-navigation-preflight.ts'
import type { BrowserNavigationIntent } from '../src/browser-navigation-preflight.ts'

const source = 'https://source.test/page'

function fixture() {
  const state = { url: source, destroyed: false }
  const guest = { id: 42, getURL: () => state.url, isDestroyed: () => state.destroyed }
  const sent: BrowserNavigationIntent[] = []
  const owner = { isDestroyed: () => false,
    send: vi.fn((_channel: string, intent: BrowserNavigationIntent) => { sent.push(intent) }) }
  const gate = new BrowserNavigationPreflight('navigation-intent')
  gate.arm(owner, guest, 'lease', 'client', 'session', 'tab', 3, source)
  return { state, guest, owner, gate, sent }
}

describe('agent navigation preflight', () => {
  it('holds a cross-origin POST until its exact request is authorized', () => {
    const h = fixture()
    const callback = vi.fn()
    expect(h.gate.intercept(42, 'mainFrame', 'https://target.test/submit', 'POST', callback)).toBe(true)
    expect(callback).not.toHaveBeenCalled()
    const intent = h.sent[0]!
    expect(intent).toMatchObject({ expectedUrl: source, targetUrl: 'https://target.test/submit', method: 'POST',
      sessionId: 'session', tabId: 'tab', navigationEpoch: 3 })
    h.gate.resolve(intent.token, h.owner, true)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: false })
    expect(() => { h.gate.resolve(intent.token, h.owner, true) }).toThrow('SIDEBAR_NAVIGATION_PREFLIGHT_EXPIRED')
    h.gate.dispose()
  })

  it('ignores ordinary subresources and same-origin requests, but cancels on tab removal', () => {
    const h = fixture()
    const callback = vi.fn()
    expect(h.gate.intercept(42, 'image', 'https://target.test/logo.png', 'GET', callback)).toBe(false)
    expect(h.gate.intercept(42, 'mainFrame', 'https://source.test/next', 'GET', callback)).toBe(false)
    expect(h.gate.intercept(42, 'mainFrame', 'https://target.test/next', 'GET', callback)).toBe(true)
    h.gate.revokeGuest(h.guest)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    h.gate.dispose()
  })

  it('holds a foreign iframe document before delivery while leaving ordinary subresources alone', () => {
    const h = fixture()
    const callback = vi.fn()
    expect(h.gate.intercept(42, 'image', 'https://target.test/logo.png', 'GET', callback)).toBe(false)
    expect(h.gate.intercept(42, 'subFrame', 'https://source.test/inside', 'GET', callback)).toBe(false)
    expect(h.gate.intercept(42, 'subFrame', 'https://target.test/frame', 'GET', callback)).toBe(true)
    expect(callback).not.toHaveBeenCalled()
    expect(h.sent[0]).toMatchObject({ resourceType: 'subFrame',
      expectedUrl: source, targetUrl: 'https://target.test/frame', method: 'GET' })
    h.gate.resolve(h.sent[0]!.token, h.owner, false)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    h.gate.dispose()
  })

  it('rejects an answer from another window or after the source has changed', () => {
    const h = fixture()
    const callback = vi.fn()
    h.gate.intercept(42, 'mainFrame', 'https://target.test/next', 'GET', callback)
    const intent = h.sent[0]!
    expect(() => { h.gate.resolve(intent.token, { isDestroyed: () => false, send: vi.fn() }, true) })
      .toThrow('SIDEBAR_NAVIGATION_PREFLIGHT_EXPIRED')
    h.state.url = 'https://other.test/'
    h.gate.resolve(intent.token, h.owner, true)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    h.gate.dispose()
  })

  it('cancels an old pending request when another agent action arms the same guest', () => {
    const h = fixture()
    const callback = vi.fn()
    h.gate.intercept(42, 'mainFrame', 'https://target.test/next', 'GET', callback)
    h.gate.arm(h.owner, h.guest, 'lease', 'client', 'session', 'tab', 3, source)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    h.gate.dispose()
  })

  it('still gates a delayed script request after the old short action window', () => {
    vi.useFakeTimers()
    try {
      const h = fixture()
      vi.advanceTimersByTime(16_000)
      const callback = vi.fn()
      expect(h.gate.intercept(42, 'mainFrame', 'https://blocked.test/late', 'GET', callback)).toBe(true)
      expect(h.sent).toHaveLength(1)
      h.gate.resolve(h.sent[0]!.token, h.owner, false)
      expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
      h.gate.dispose()
    } finally { vi.useRealTimers() }
  })

  it('fails closed when the guest URL changed before a cross-site request', () => {
    const h = fixture()
    h.state.url = 'https://source.test/other'
    const callback = vi.fn()
    expect(h.gate.intercept(42, 'mainFrame', 'https://blocked.test/late', 'GET', callback)).toBe(true)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    expect(h.sent).toHaveLength(0)
    h.gate.dispose()
  })

  it('does not treat the old source origin as same-origin after a document change', () => {
    const h = fixture()
    h.state.url = 'https://other.test/new-document'
    const callback = vi.fn()
    expect(h.gate.intercept(42, 'mainFrame', 'https://source.test/return', 'GET', callback)).toBe(true)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: true })
    expect(h.sent).toHaveLength(0)
    h.gate.dispose()
  })

  it('holds a cross-origin popup before opening a new tab', () => {
    const h = fixture()
    const open = vi.fn()
    expect(h.gate.interceptPopup(h.guest, 'https://target.test/new', open)).toBe(true)
    expect(open).not.toHaveBeenCalled()
    expect(h.sent[0]).toMatchObject({ method: 'POPUP', targetUrl: 'https://target.test/new' })
    h.gate.resolve(h.sent[0]!.token, h.owner, false)
    expect(open).not.toHaveBeenCalled()
    expect(h.gate.interceptPopup(h.guest, 'https://target.test/new', open)).toBe(true)
    h.gate.resolve(h.sent[1]!.token, h.owner, true)
    expect(open).toHaveBeenCalledOnce()
    h.gate.dispose()
  })

  it('cancels an approved popup when its source page changes before the Host responds', () => {
    const h = fixture()
    const open = vi.fn()
    h.gate.interceptPopup(h.guest, 'https://target.test/new', open)
    h.state.url = 'https://source.test/next'
    h.gate.resolve(h.sent[0]!.token, h.owner, true)
    expect(open).not.toHaveBeenCalled()
    h.gate.dispose()
  })

  it('allows the approved popup origin and holds its second-origin redirect', () => {
    const h = fixture()
    h.state.url = 'about:blank#lease'
    h.gate.arm(h.owner, h.guest, 'lease', 'client', 'session', 'new-tab', 1,
      'about:blank', 'https://target.test/popup')
    const callback = vi.fn()
    expect(h.gate.intercept(42, 'mainFrame', 'https://target.test/popup', 'GET', callback)).toBe(false)
    expect(h.gate.intercept(42, 'mainFrame', 'https://redirect.test/landing', 'GET', callback)).toBe(true)
    expect(h.sent[0]).toMatchObject({ expectedUrl: 'about:blank',
      popupInitialUrl: 'https://target.test/popup', targetUrl: 'https://redirect.test/landing',
      method: 'GET', tabId: 'new-tab' })
    h.gate.resolve(h.sent[0]!.token, h.owner, true)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: false })
    h.gate.dispose()
  })

  it('keeps the popup gate after its approved first document commits', () => {
    const h = fixture()
    h.state.url = 'about:blank#lease'
    h.gate.arm(h.owner, h.guest, 'lease', 'client', 'session', 'new-tab', 1,
      'about:blank', 'https://target.test/popup')
    h.state.url = 'https://target.test/popup'
    const callback = vi.fn()
    expect(h.gate.intercept(42, 'mainFrame', 'https://redirect.test/landing', 'GET', callback)).toBe(true)
    expect(h.sent[0]).toMatchObject({ expectedUrl: 'https://target.test/popup',
      popupInitialUrl: 'https://target.test/popup', navigationEpoch: 1,
      targetUrl: 'https://redirect.test/landing' })
    h.gate.resolve(h.sent[0]!.token, h.owner, true)
    expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: false })
    h.gate.dispose()
  })
})
