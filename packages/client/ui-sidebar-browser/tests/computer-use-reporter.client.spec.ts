// @vitest-environment jsdom
/** Client selection revocation is checked again before page bytes leave the renderer. */
import { afterEach, expect, it, vi } from 'vitest'
import { SidebarComputerUseReporter } from '../src/client/electron/SidebarComputerUseReporter.ts'

const tab = { sessionId: 'session-a', tabId: 'tab-a', controllerAvailable: true,
  observedUrl: 'https://example.test/', title: 'Example' }

afterEach(() => { vi.unstubAllGlobals() })

it('backs off when the authenticated Host rejects a poll envelope', async () => {
  const fetch = vi.fn(() => Promise.resolve(Response.json({
    ok: false, error: { code: 'cu-sidebar/DUPLICATE_POLL' },
  })))
  vi.stubGlobal('fetch', fetch)
  const reporter = new SidebarComputerUseReporter(() => tab, async () => {
    throw new Error('No command should be dispatched')
  })
  try {
    reporter.start()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(fetch).toHaveBeenCalledOnce()
  } finally { await reporter.dispose() }
})

it('sends just the selected tab and rejects an in-flight inspection after selection changes', async () => {
  let selected: typeof tab | null = tab
  let finishInspection: ((value: { url: string; title: string; text: string }) => void) | undefined
  const inspect = vi.fn(() => new Promise<{ url: string; title: string; text: string }>((resolve) => { finishInspection = resolve }))
  const sent: { endpoint: string; payload: { selectedTab?: typeof tab | null; ok?: boolean; value?: object } }[] = []
  let respondPoll: ((value: Response) => void) | undefined
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string) as { selectedTab?: typeof tab | null; ok?: boolean; value?: object }
    sent.push({ endpoint: path, payload })
    if (path.endsWith('/complete')) return Promise.resolve(Response.json({ ok: true, value: { accepted: true } }))
    return new Promise<Response>((resolve, reject) => {
      respondPoll = resolve
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }))
  const reporter = new SidebarComputerUseReporter(() => selected, inspect)
  try {
    reporter.start()
    await vi.waitFor(() => { expect(sent.length).toBe(1) })
    expect(sent[0]?.payload.selectedTab).toEqual(tab)
    respondPoll?.(Response.json({ ok: true, value: { command: {
      id: 'command-a', sessionId: 'session-a', tabId: 'tab-a', op: 'inspect',
      expectedUrl: 'https://example.test/', args: { approvedOrigin: 'https://example.test' },
    } } }))
    await vi.waitFor(() => { expect(inspect).toHaveBeenCalledOnce() })
    selected = null
    reporter.notify()
    finishInspection?.({ url: 'https://example.test/', title: 'Example', text: 'private page text' })
    await vi.waitFor(() => { expect(sent.some(call => call.endpoint.endsWith('/complete'))).toBe(true) })
    const completed = sent.find(call => call.endpoint.endsWith('/complete'))
    expect(completed?.payload.ok).toBe(false)
    expect(completed?.payload.value).toBeUndefined()
    await vi.waitFor(() => { expect(sent.some(call => call.endpoint.endsWith('/poll') && call.payload.selectedTab === null)).toBe(true) })
  } finally { await reporter.dispose() }
})

it('does not release an old page read after switching away and back to the same tab', async () => {
  let selected: typeof tab | null = tab
  let finishInspection: ((value: { url: string; title: string; text: string }) => void) | undefined
  let respondPoll: ((value: Response) => void) | undefined
  const completions: Array<{ ok: boolean; value?: object }> = []
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
    const payload = JSON.parse(init.body as string) as { ok: boolean; value?: object }
    if (path.endsWith('/complete')) {
      completions.push(payload)
      return Promise.resolve(Response.json({ ok: true, value: { accepted: true } }))
    }
    return new Promise<Response>((resolve, reject) => {
      respondPoll = resolve
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }))
  const reporter = new SidebarComputerUseReporter(() => selected, () =>
    new Promise((resolve) => { finishInspection = resolve }))
  try {
    reporter.start()
    await vi.waitFor(() => { expect(respondPoll).toBeDefined() })
    respondPoll?.(Response.json({ ok: true, value: { command: {
      id: 'command-b', sessionId: 'session-a', tabId: 'tab-a', op: 'inspect',
      expectedUrl: 'https://example.test/', args: { approvedOrigin: 'https://example.test' },
    } } }))
    await vi.waitFor(() => { expect(finishInspection).toBeDefined() })
    selected = null
    reporter.notify()
    selected = tab
    reporter.notify()
    finishInspection?.({ url: 'https://example.test/', title: 'Example', text: 'old text' })
    await vi.waitFor(() => { expect(completions.length).toBe(1) })
    expect(completions[0]).toMatchObject({ ok: false })
    expect(completions[0]?.value).toBeUndefined()
  } finally { await reporter.dispose() }
})

it('never returns screenshot bytes after the selected tab changes', async () => {
  let selected: typeof tab | null = tab
  let finish: ((value: { url: string; title: string; base64: string; viewport: { width: number; height: number } }) => void) | undefined
  let respondPoll: ((value: Response) => void) | undefined
  const completions: Array<{ ok: boolean; value?: object }> = []
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
    if (path.endsWith('/complete')) {
      completions.push(JSON.parse(init.body as string) as { ok: boolean; value?: object })
      return Promise.resolve(Response.json({ ok: true, value: { accepted: true } }))
    }
    return new Promise<Response>((resolve, reject) => {
      respondPoll = resolve
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }))
  const reporter = new SidebarComputerUseReporter(() => selected, () =>
    new Promise((resolve) => { finish = resolve }))
  try {
    reporter.start()
    await vi.waitFor(() => { expect(respondPoll).toBeDefined() })
    respondPoll?.(Response.json({ ok: true, value: { command: {
      id: 'command-image', sessionId: 'session-a', tabId: 'tab-a', op: 'screenshot',
      expectedUrl: 'https://example.test/', args: { approvedOrigin: 'https://example.test' },
    } } }))
    await vi.waitFor(() => { expect(finish).toBeDefined() })
    selected = null
    reporter.notify()
    finish?.({ url: 'https://example.test/', title: 'Example', base64: 'private-image',
      viewport: { width: 1, height: 1 } })
    await vi.waitFor(() => { expect(completions.length).toBe(1) })
    expect(completions[0]).toMatchObject({ ok: false })
    expect(completions[0]?.value).toBeUndefined()
  } finally { await reporter.dispose() }
})

it('allows a selected goto to change page URL but rejects switching away and back', async () => {
  const destination = { ...tab, observedUrl: 'https://other.test/path', title: 'Other' }
  let selected: typeof tab | null = tab
  const polls: Array<(value: Response) => void> = []
  let switchAway = false
  const completions: Array<{ ok: boolean; value?: object }> = []
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
    if (path.endsWith('/complete')) {
      completions.push(JSON.parse(init.body as string) as { ok: boolean; value?: object })
      return Promise.resolve(Response.json({ ok: true, value: { accepted: true } }))
    }
    return new Promise<Response>((resolve, reject) => {
      polls.push(resolve)
      init.signal?.addEventListener('abort', () => {
        const index = polls.indexOf(resolve)
        if (index >= 0) polls.splice(index, 1)
        reject(new Error('aborted'))
      }, { once: true })
    })
  }))
  const reporter = new SidebarComputerUseReporter(() => selected, async (_tab, _command, stillSelected) => {
    selected = destination
    reporter.notify()
    if (switchAway) {
      selected = null
      reporter.notifySelection()
      selected = destination
      reporter.notifySelection()
    }
    expect(stillSelected()).toBe(!switchAway)
    return { url: destination.observedUrl, title: destination.title, performed: true }
  })
  try {
    reporter.start()
    await vi.waitFor(() => { expect(polls.length).toBeGreaterThan(0) })
    const command = { id: 'navigate-a', sessionId: tab.sessionId, tabId: tab.tabId,
      op: 'goto', expectedUrl: tab.observedUrl,
      args: { approvedOrigin: 'https://example.test', url: 'https://other.test/path' } }
    polls.shift()?.(Response.json({ ok: true, value: { command } }))
    await vi.waitFor(() => { expect(completions.length).toBe(1) })
    expect(completions[0]).toMatchObject({ ok: true,
      value: { url: destination.observedUrl, performed: true } })

    selected = tab
    reporter.notify()
    switchAway = true
    await vi.waitFor(() => { expect(polls.length).toBeGreaterThan(0) })
    polls.shift()?.(Response.json({ ok: true, value: { command: { ...command, id: 'navigate-b' } } }))
    await vi.waitFor(() => { expect(completions.length).toBe(2) })
    expect(completions[1]).toMatchObject({ ok: false })
    expect(completions[1]?.value).toBeUndefined()
  } finally { await reporter.dispose() }
})

it('acknowledges close only after the selected Browser tab is withdrawn', async () => {
  let selected: typeof tab | null = tab
  let respondPoll: ((value: Response) => void) | undefined
  const completions: Array<{ ok: boolean; value?: object }> = []
  vi.stubGlobal('fetch', vi.fn((path: string, init: RequestInit) => {
    if (path.endsWith('/complete')) {
      completions.push(JSON.parse(init.body as string) as { ok: boolean; value?: object })
      return Promise.resolve(Response.json({ ok: true, value: { accepted: true } }))
    }
    return new Promise<Response>((resolve, reject) => {
      respondPoll = resolve
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    })
  }))
  const reporter = new SidebarComputerUseReporter(() => selected, async (_tab, _command, stillSelected) => {
    expect(stillSelected()).toBe(true)
    selected = null
    reporter.notifySelection()
    return { url: tab.observedUrl, title: '', closed: true }
  })
  try {
    reporter.start()
    await vi.waitFor(() => { expect(respondPoll).toBeDefined() })
    respondPoll?.(Response.json({ ok: true, value: { command: {
      id: 'close-a', sessionId: tab.sessionId, tabId: tab.tabId, op: 'close',
      expectedUrl: tab.observedUrl, args: { approvedOrigin: 'https://example.test' },
    } } }))
    await vi.waitFor(() => { expect(completions.length).toBe(1) })
    expect(completions[0]).toMatchObject({ ok: true,
      value: { url: tab.observedUrl, closed: true } })
  } finally { await reporter.dispose() }
})
