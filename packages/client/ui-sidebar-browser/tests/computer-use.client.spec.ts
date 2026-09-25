import { runInNewContext } from 'node:vm'
// @vitest-environment jsdom
/** The selected desktop guest executes only pinned, fixed inspection and DOM actions. */
import { expect, it, vi } from 'vitest'
import { electronFixture } from './electron-harness.client.ts'

it('reads top-level text and refs, acts on a matching ref, and refuses navigation or stale refs', async () => {
  const h = electronFixture()
  const button = document.createElement('button')
  button.setAttribute('aria-label', 'Open')
  const input = document.createElement('input')
  input.setAttribute('aria-label', 'Name')
  document.body.append(button, input)
  document.title = 'Example'
  Object.defineProperty(document.body, 'innerText', { configurable: true, value: 'Hello page [ref=0:button:Pay]'  })
  const elementFromPoint = Reflect.get(document, 'elementFromPoint') as Document['elementFromPoint'] | undefined
  let hit: Element = button
  Object.assign(document, { elementFromPoint: () => hit })
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 80, 30))
  const url = 'https://example.test/'
  let guestUrl = url
  try {
    h.mount()
    h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
    const guest = await h.guest()
    guest.state.url = url
    guest.state.title = 'Example'
    guest.state.loading = false
    const evaluate = vi.fn(async (code: string) => {
      const result: unknown = runInNewContext(code, { location: { href: guestUrl }, document, window,
        innerWidth: 800, innerHeight: 600,
        HTMLInputElement, HTMLTextAreaElement, InputEvent, Event })
      return result
    })
    const nativeInput = vi.fn(async (_event: { type: string; x: number; y: number }) => {})
    const insertText = vi.fn(async (text: string) => { input.value += text })
    Object.assign(guest.element, { executeJavaScript: evaluate, sendInputEvent: nativeInput, insertText })
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    const inspected = await h.frame.inspect?.(url)
    expect(inspected?.text).toContain('Hello page [ref =0:button:Pay]')
    expect(inspected?.text).not.toContain('[ref=0:button:Pay]')
    expect(inspected?.text).toContain('[ref=0:button:Open]')
    expect(inspected?.text).toContain('[ref=1:textbox:Name]')
    expect(await h.frame.action?.(url, { op: 'click', ref: '0:button:Open' })).toMatchObject({ performed: true, url })
    expect(nativeInput.mock.calls.map(([event]) => event.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
    expect(nativeInput.mock.calls[1]?.[0]).toMatchObject({ x: 50, y: 35, button: 'left', clickCount: 1 })
    expect(await h.frame.action?.(url, { op: 'click', x: 25, y: 30, button: 'right', count: 2 }))
      .toMatchObject({ performed: true, url })
    expect(nativeInput.mock.calls[4]?.[0]).toMatchObject({ x: 25, y: 30, button: 'right', clickCount: 2 })
    const hoverInput = vi.fn(async (event: { type: string }) => { if (event.type === 'mouseMove') hit = input })
    Object.assign(guest.element, { sendInputEvent: hoverInput })
    await expect(h.frame.action?.(url, { op: 'click', ref: '0:button:Open' }))
      .rejects.toThrow('SIDEBAR_TARGET_OCCLUDED')
    expect(hoverInput.mock.calls.map(([event]) => event.type)).toEqual(['mouseMove'])
    hit = button
    Object.assign(guest.element, { sendInputEvent: nativeInput })
    let selected = true
    Object.assign(guest.element, { executeJavaScript: async (code: string) => {
      const result = await evaluate(code)
      selected = false
      return result
    } })
    const sentBefore = nativeInput.mock.calls.length
    await expect(h.frame.action?.(url, { op: 'click', ref: '0:button:Open' }, () => selected))
      .rejects.toThrow('SIDEBAR_SELECTION_CHANGED')
    expect(nativeInput.mock.calls.length).toBe(sentBefore)
    Object.assign(guest.element, { executeJavaScript: evaluate })
    expect(await h.frame.action?.(url, { op: 'type', ref: '1:textbox:Name', text: 'Ada' })).toMatchObject({ performed: true })
    expect(insertText).toHaveBeenCalledWith('Ada')
    expect(input.value).toBe('Ada')
    expect(await h.frame.action?.(url, { op: 'type', text: '!' })).toMatchObject({ performed: true })
    expect(input.value).toBe('Ada!')
    const typedBeforeFocusChange = insertText.mock.calls.length
    Object.assign(guest.element, { executeJavaScript: async (code: string) => {
      const result = await evaluate(code)
      if (code.includes('Object.defineProperty(window')) button.focus()
      return result
    } })
    await expect(h.frame.action?.(url, { op: 'type', text: 'blocked' }))
      .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
    expect(insertText.mock.calls.length).toBe(typedBeforeFocusChange)
    Object.assign(guest.element, { executeJavaScript: evaluate })
    input.focus()
    const replacement = vi.fn(async (text: string) => {
      input.setRangeText(text, input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end')
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
    })
    Object.assign(guest.element, { insertText: replacement })
    const inputEvents: boolean[] = []
    input.addEventListener('input', (event) => { inputEvents.push(event.isTrusted) }, { once: true })
    expect(await h.frame.action?.(url, { op: 'setValue', ref: '1:textbox:Name', value: 'Bea' }))
      .toMatchObject({ performed: true })
    expect(input.value).toBe('Bea')
    expect(replacement).toHaveBeenCalledWith('Bea')
    expect(inputEvents).toHaveLength(1)
    const clear = vi.fn(async (event: { type: string; keyCode?: string }) => {
      if (event.type === 'keyDown' && event.keyCode === 'Backspace') {
        input.setRangeText('', input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end')
      }
    })
    Object.assign(guest.element, { sendInputEvent: clear })
    expect(await h.frame.action?.(url, { op: 'setValue', ref: '1:textbox:Name', value: '' }))
      .toMatchObject({ performed: true })
    expect(input.value).toBe('')
    expect(clear.mock.calls.map(([event]) => event.type)).toEqual(['keyDown', 'keyUp'])
    Object.assign(guest.element, { insertText, sendInputEvent: nativeInput })
    expect(await h.frame.action?.(url, { op: 'scroll', ref: '0:button:Open', dx: 0, dy: 250 }))
      .toMatchObject({ performed: true })
    expect(nativeInput.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'mouseWheel', x: 50, y: 35,
      deltaX: 0, deltaY: 250 })
    expect(await h.frame.action?.(url, { op: 'key', ref: '1:textbox:Name', key: 'Control+Enter' }))
      .toMatchObject({ performed: true })
    expect(nativeInput.mock.calls.at(-2)?.[0]).toMatchObject({ type: 'keyDown', keyCode: 'Enter',
      modifiers: ['control'] })
    expect(nativeInput.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'keyUp', keyCode: 'Enter',
      modifiers: ['control'] })
    input.type = 'password'
    await expect(h.frame.action?.(url, { op: 'type', ref: '1:textbox:Name', text: 'secret' }))
      .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
    await expect(h.frame.action?.(url, { op: 'setValue', ref: '1:textbox:Name', value: 'secret' }))
      .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
    expect(insertText).toHaveBeenCalledTimes(2)
    input.focus()
    await expect(h.frame.action?.(url, { op: 'type', text: 'secret' }))
      .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
    const keySentBefore = nativeInput.mock.calls.length
    await expect(h.frame.action?.(url, { op: 'key', ref: '1:textbox:Name', key: 'Enter' }))
      .rejects.toThrow('SIDEBAR_KEY_TARGET_UNAVAILABLE')
    expect(nativeInput.mock.calls.length).toBe(keySentBefore)
    input.type = 'text'
    input.readOnly = true
    await expect(h.frame.action?.(url, { op: 'setValue', ref: '1:textbox:Name', value: 'Blocked' }))
      .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
    input.readOnly = false
    input.type = 'email'
    await expect(h.frame.action?.(url, { op: 'setValue', ref: '1:textbox:Name', value: 'ada@example.test' }))
      .rejects.toThrow('SIDEBAR_INPUT_UNAVAILABLE')
    input.type = 'text'
    let selectedForValue = true
    Object.assign(guest.element, { executeJavaScript: async (code: string) => {
      const result = await evaluate(code)
      selectedForValue = false
      return result
    } })
    await expect(h.frame.action?.(url, { op: 'setValue', ref: '1:textbox:Name', value: 'Blocked' },
      () => selectedForValue)).rejects.toThrow('SIDEBAR_SELECTION_CHANGED')
    expect(insertText).toHaveBeenCalledTimes(2)
    Object.assign(guest.element, { executeJavaScript: evaluate })
    await expect(h.frame.action?.(url, { op: 'setValue', ref: '1:textbox:Old', value: 'Blocked' }))
      .rejects.toThrow('SIDEBAR_STALE_REF')
    await expect(h.frame.action?.(url, { op: 'click', ref: '0:button:Changed' })).rejects.toThrow('SIDEBAR_STALE_REF')
    button.setAttribute('aria-label', '中'.repeat(120))
    const longName = await h.frame.inspect?.(url)
    const longRef = /\[ref=(0:button:[^\]]+)\]/.exec(longName?.text ?? '')?.[1]
    expect(longRef).toBeDefined()
    expect(longRef?.length).toBeLessThan(600)
    expect(await h.frame.action?.(url, { op: 'click', ref: longRef ?? '' })).toMatchObject({ performed: true })

    const frame = document.createElement('iframe')
    document.body.append(frame)
    const frameDoc = frame.contentDocument
    expect(frameDoc).not.toBeNull()
    const innerButton = frameDoc!.createElement('button')
    innerButton.setAttribute('aria-label', 'Inside')
    const innerInput = frameDoc!.createElement('input')
    innerInput.setAttribute('aria-label', 'Frame name')
    frameDoc!.body.append(innerButton, innerInput)
    Object.defineProperty(frameDoc!.body, 'innerText', { configurable: true, value: 'Frame content' })
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 200, 150))
    vi.spyOn(innerButton, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 80, 30))
    Object.assign(frameDoc!, { elementFromPoint: () => innerButton })
    hit = frame
    const framed = await h.frame.inspect?.(url)
    const frameButtonRef = /\[ref=(f0-[a-f0-9]{8}\/0:button:Inside)\]/.exec(framed?.text ?? '')?.[1]
    const frameInputRef = /\[ref=(f0-[a-f0-9]{8}\/1:textbox:Frame%20name)\]/.exec(framed?.text ?? '')?.[1]
    expect(framed?.text).toContain('Frame content')
    expect(frameButtonRef).toBeDefined()
    expect(frameInputRef).toBeDefined()
    expect(await h.frame.action?.(url, { op: 'click', ref: frameButtonRef ?? '' })).toMatchObject({ performed: true })
    expect(nativeInput.mock.calls.at(-2)?.[0]).toMatchObject({ type: 'mouseDown', x: 150, y: 85 })
    expect(await h.frame.action?.(url, { op: 'click', x: 150, y: 85 })).toMatchObject({ performed: true })
    expect(await h.frame.action?.(url, { op: 'scroll', ref: frameButtonRef ?? '', dx: 0, dy: 50 }))
      .toMatchObject({ performed: true })
    expect(nativeInput.mock.calls.at(-1)?.[0]).toMatchObject({ type: 'mouseWheel', x: 150, y: 85 })
    const frameInsert = vi.fn(async (text: string) => { innerInput.value += text })
    Object.assign(guest.element, { insertText: frameInsert })
    expect(await h.frame.action?.(url, { op: 'type', ref: frameInputRef ?? '', text: 'Ada' }))
      .toMatchObject({ performed: true })
    expect(frameInsert).toHaveBeenCalledWith('Ada')
    innerInput.focus()
    expect(await h.frame.action?.(url, { op: 'type', text: '!' }))
      .toMatchObject({ performed: true })
    expect(frameInsert).toHaveBeenCalledWith('!')
    const nestedFrame = frameDoc!.createElement('iframe')
    frameDoc!.body.append(nestedFrame)
    const nestedDoc = nestedFrame.contentDocument
    expect(nestedDoc).not.toBeNull()
    const deepButton = nestedDoc!.createElement('button')
    deepButton.setAttribute('aria-label', 'Deep')
    nestedDoc!.body.append(deepButton)
    Object.defineProperty(nestedDoc!.body, 'innerText', { configurable: true, value: 'Nested content' })
    vi.spyOn(nestedFrame, 'getBoundingClientRect').mockReturnValue(new DOMRect(30, 40, 100, 90))
    vi.spyOn(deepButton, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 10, 20, 20))
    Object.assign(nestedDoc!, { elementFromPoint: () => deepButton })
    Object.assign(frameDoc!, { elementFromPoint: () => nestedFrame })
    const nested = await h.frame.inspect?.(url)
    const deepRef = /\[ref=(f0-[a-f0-9]{8}\/f0-[a-f0-9]{8}\/0:button:Deep)\]/.exec(nested?.text ?? '')?.[1]
    expect(nested?.text).toContain('Nested content')
    expect(deepRef).toBeDefined()
    expect(await h.frame.action?.(url, { op: 'click', ref: deepRef ?? '' })).toMatchObject({ performed: true })
    expect(nativeInput.mock.calls.at(-2)?.[0]).toMatchObject({ type: 'mouseDown', x: 145, y: 110 })
    expect(await h.frame.action?.(url, { op: 'click', x: 145, y: 110 })).toMatchObject({ performed: true })
    expect(await h.frame.action?.(url, { op: 'scroll', ref: deepRef ?? '', dx: 0, dy: 80 }))
      .toMatchObject({ performed: true })
    nestedFrame.setAttribute('src', 'https://other.test/nested')
    await expect(h.frame.action?.(url, { op: 'click', ref: deepRef ?? '' }))
      .rejects.toThrow('SIDEBAR_STALE_REF')
    await expect(h.frame.action?.(url, { op: 'click', x: 145, y: 110 }))
      .rejects.toThrow('SIDEBAR_FRAME_UNAVAILABLE')
    nestedFrame.remove()
    Object.assign(frameDoc!, { elementFromPoint: () => innerButton })
    innerButton.setAttribute('aria-label', 'Changed')
    await expect(h.frame.action?.(url, { op: 'click', ref: frameButtonRef ?? '' }))
      .rejects.toThrow('SIDEBAR_STALE_REF')
    frame.setAttribute('src', 'https://other.test/frame')
    await expect(h.frame.action?.(url, { op: 'click', x: 150, y: 85 }))
      .rejects.toThrow('SIDEBAR_FRAME_UNAVAILABLE')
    frame.removeAttribute('src')
    Object.defineProperty(frame, 'contentDocument', { configurable: true, value: null })
    await expect(h.frame.action?.(url, { op: 'click', x: 150, y: 85 }))
      .rejects.toThrow('SIDEBAR_FRAME_UNAVAILABLE')
    frame.remove()
    hit = button

    guestUrl = 'https://other.test/'
    await expect(h.frame.inspect?.(url)).rejects.toThrow('SIDEBAR_NAVIGATED')
  } finally {
    await h.dispose()
    Object.assign(document, { elementFromPoint })
    button.remove()
    input.remove()
  }
})

it('selects one exact text match or cursor position in the selected document', async () => {
  const h = electronFixture()
  const input = document.createElement('input')
  input.setAttribute('aria-label', 'Search')
  input.value = 'one two one'
  const heading = document.createElement('h1')
  heading.setAttribute('aria-label', 'Greeting')
  heading.innerHTML = '<span>Alpha </span><span>Beta</span><span> Gamma</span>'
  document.body.append(input, heading)
  const url = 'https://example.test/'
  try {
    h.mount()
    h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
    const guest = await h.guest()
    guest.state.url = url
    guest.state.title = 'Example'
    guest.state.loading = false
    const evaluate = vi.fn(async (code: string) => runInNewContext(code, {
      location: { href: url, origin: 'https://example.test' }, document, URL,
      innerWidth: 800, innerHeight: 600, HTMLInputElement, HTMLTextAreaElement,
    }) as unknown)
    Object.assign(guest.element, { executeJavaScript: evaluate })
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    await expect(h.frame.action?.(url, { op: 'selectText', ref: '0:textbox:Search', text: 'one' }))
      .rejects.toThrow('SIDEBAR_AMBIGUOUS_SELECTION')
    expect(await h.frame.action?.(url, { op: 'selectText', ref: '0:textbox:Search',
      text: 'one', prefix: 'two ' })).toMatchObject({ performed: true })
    expect([input.selectionStart, input.selectionEnd]).toEqual([8, 11])
    await h.frame.action?.(url, { op: 'selectText', ref: '0:textbox:Search',
      text: 'one', prefix: 'two ', selectionType: 'cursor_before' })
    expect([input.selectionStart, input.selectionEnd]).toEqual([8, 8])
    await h.frame.action?.(url, { op: 'selectText', ref: '0:textbox:Search',
      text: 'one', prefix: 'two ', selectionType: 'cursor_after' })
    expect([input.selectionStart, input.selectionEnd]).toEqual([11, 11])
    await expect(h.frame.action?.(url, { op: 'selectText', ref: '0:textbox:Search', text: 'absent' }))
      .rejects.toThrow('SIDEBAR_TEXT_NOT_FOUND')
    await h.frame.action?.(url, { op: 'selectText', ref: '1:heading:Greeting', text: 'Beta G' })
    expect(document.getSelection()?.toString()).toBe('Beta G')
    input.type = 'password'
    await expect(h.frame.action?.(url, { op: 'selectText', ref: '0:textbox:Search', text: 'two' }))
      .rejects.toThrow('SIDEBAR_SELECTION_UNAVAILABLE')
    input.type = 'text'
    input.setAttribute('aria-label', 'Changed')
    await expect(h.frame.action?.(url, { op: 'selectText', ref: '0:textbox:Search', text: 'two' }))
      .rejects.toThrow('SIDEBAR_STALE_REF')
    let stillSelected = true
    Object.assign(guest.element, { executeJavaScript: async (code: string) => {
      const value = await evaluate(code)
      stillSelected = false
      return value
    } })
    await expect(h.frame.action?.(url, { op: 'selectText', ref: '1:heading:Greeting', text: 'Beta' },
      () => stillSelected)).rejects.toThrow('SIDEBAR_SELECTION_CHANGED')
  } finally {
    await h.dispose()
    input.remove()
    heading.remove()
  }
})

it('performs only exposed fixed secondary actions against a stable element', async () => {
  const h = electronFixture()
  const button = document.createElement('button')
  button.setAttribute('aria-label', 'Toggle')
  button.setAttribute('aria-expanded', 'false')
  const input = document.createElement('input')
  input.type = 'number'
  input.setAttribute('aria-label', 'Count')
  const heading = document.createElement('h1')
  heading.setAttribute('aria-label', 'Heading')
  document.body.append(button, input, heading)
  const elementFromPoint = Reflect.get(document, 'elementFromPoint') as Document['elementFromPoint'] | undefined
  Object.assign(document, { elementFromPoint: () => button })
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 80, 30))
  const url = 'https://example.test/'
  try {
    h.mount()
    h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
    const guest = await h.guest()
    guest.state.url = url
    guest.state.title = 'Example'
    guest.state.loading = false
    const evaluate = vi.fn(async (code: string) => runInNewContext(code, {
      location: { href: url, origin: 'https://example.test' }, document, URL,
      innerWidth: 800, innerHeight: 600,
    }) as unknown)
    const nativeInput = vi.fn(async (event: { type: string; button?: string }) => {
      if (event.type === 'mouseUp' && event.button === 'left') {
        button.setAttribute('aria-expanded', button.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')
      }
    })
    Object.assign(guest.element, { executeJavaScript: evaluate, sendInputEvent: nativeInput })
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    expect((await h.frame.inspect?.(url))?.text).toContain('[ref=1:spinbutton:Count]')
    expect(await h.frame.action?.(url, { op: 'secondary', ref: '1:spinbutton:Count', action: 'focus' }))
      .toMatchObject({ performed: true })
    expect(document.activeElement).toBe(input)
    expect(nativeInput).not.toHaveBeenCalled()
    await h.frame.action?.(url, { op: 'secondary', ref: '0:button:Toggle', action: 'showmenu' })
    expect(nativeInput.mock.calls.at(-2)?.[0]).toMatchObject({ type: 'mouseDown', button: 'right' })
    const beforeUnexposed = nativeInput.mock.calls.length
    await expect(h.frame.action?.(url, { op: 'secondary', ref: '2:heading:Heading', action: 'showmenu' }))
      .rejects.toThrow('SIDEBAR_ACTION_NOT_EXPOSED')
    expect(nativeInput.mock.calls.length).toBe(beforeUnexposed)
    const beforeExpand = nativeInput.mock.calls.length
    await h.frame.action?.(url, { op: 'secondary', ref: '0:button:Toggle', action: 'expand' })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(nativeInput.mock.calls.length).toBe(beforeExpand + 3)
    await h.frame.action?.(url, { op: 'secondary', ref: '0:button:Toggle', action: 'expand' })
    expect(nativeInput.mock.calls.length).toBe(beforeExpand + 3)
    await h.frame.action?.(url, { op: 'secondary', ref: '0:button:Toggle', action: 'collapse' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await expect(h.frame.action?.(url, { op: 'secondary', ref: '0:button:Toggle', action: 'increment' }))
      .rejects.toThrow('SIDEBAR_ACTION_NOT_EXPOSED')
    await h.frame.action?.(url, { op: 'secondary', ref: '1:spinbutton:Count', action: 'increment' })
    expect(nativeInput.mock.calls.at(-2)?.[0]).toMatchObject({ type: 'keyDown', keyCode: 'Up' })
    await h.frame.action?.(url, { op: 'secondary', ref: '1:spinbutton:Count', action: 'decrement' })
    expect(nativeInput.mock.calls.at(-2)?.[0]).toMatchObject({ type: 'keyDown', keyCode: 'Down' })
    const beforeMoved = nativeInput.mock.calls.length
    let inspected = false
    Object.assign(guest.element, { executeJavaScript: async (code: string) => {
      const value = await evaluate(code)
      if (!inspected) { inspected = true; button.setAttribute('aria-expanded', 'true') }
      return value
    } })
    await expect(h.frame.action?.(url, { op: 'secondary', ref: '0:button:Toggle', action: 'expand' }))
      .rejects.toThrow('SIDEBAR_TARGET_MOVED')
    expect(nativeInput.mock.calls.length).toBe(beforeMoved)
  } finally {
    await h.dispose()
    Object.assign(document, { elementFromPoint })
    button.remove()
    input.remove()
    heading.remove()
  }
})

it('pastes rich content through the leased clipboard and restores it after a trusted input receipt', async () => {
  const h = electronFixture()
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.setAttribute('aria-label', 'Editor')
  Object.defineProperty(editor, 'isContentEditable', { configurable: true, value: true })
  const other = document.createElement('input')
  document.body.append(editor, other)
  const url = 'https://example.test/'
  const guestWindow: Record<string, unknown> = {}
  try {
    h.mount()
    h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
    const guest = await h.guest()
    guest.state.url = url
    guest.state.title = 'Example'
    guest.state.loading = false
    const evaluate = vi.fn(async (code: string) => runInNewContext(code, {
      location: { href: url, origin: 'https://example.test' }, document, URL, window: guestWindow,
      innerWidth: 800, innerHeight: 600,
    }) as unknown)
    const paste = vi.fn(() => {
      const key = Object.getOwnPropertyNames(guestWindow).find(value => value.startsWith('__dsh_cu_paste_'))
      const receipt = guestWindow[key ?? ''] as
        { done: boolean; listener: (event: { isTrusted: boolean; target: Element }) => void }
      receipt.listener({ isTrusted: false, target: editor })
      expect(receipt.done).toBe(false)
      editor.innerHTML = '<b>Rich</b> text'
      receipt.listener({ isTrusted: true, target: editor })
    })
    Object.assign(guest.element, { executeJavaScript: evaluate, paste })
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    h.bridge.beginPaste.mockImplementationOnce(async () => {
      const key = Object.getOwnPropertyNames(guestWindow).find(value => value.startsWith('__dsh_cu_paste_'))
      const receipt = guestWindow[key ?? ''] as
        { done: boolean; listener: (event: { isTrusted: boolean; target: Element }) => void }
      receipt.listener({ isTrusted: true, target: editor })
      expect(receipt.done).toBe(false)
      return 'paste-lease'
    })
    const result = await h.frame.action?.(url, { op: 'paste', ref: '0:textbox:Editor',
      text: '<b>Rich</b> text', format: 'html' })
    expect(result).toMatchObject({ performed: true, clipboardRestored: true, clipboardSuperseded: false })
    expect(h.bridge.beginPaste).toHaveBeenCalledWith(h.reservation.lease, url,
      { text: '<b>Rich</b> text', format: 'html', plainText: 'Rich text' })
    expect(paste).toHaveBeenCalledTimes(1)
    expect(h.bridge.finishPaste).toHaveBeenCalledWith(h.reservation.lease, 'paste-lease')
    expect(Object.getOwnPropertyNames(guestWindow)).toHaveLength(0)

    h.bridge.finishPaste.mockResolvedValueOnce({ restored: false, superseded: true })
    expect(await h.frame.action?.(url, { op: 'paste', ref: '0:textbox:Editor',
      text: '**Markdown source**', format: 'md' })).toMatchObject({
      performed: true, clipboardRestored: false, clipboardSuperseded: true,
    })
    expect(h.bridge.beginPaste).toHaveBeenLastCalledWith(h.reservation.lease, url,
      { text: '**Markdown source**', format: 'md' })
    expect(Object.getOwnPropertyNames(guestWindow)).toHaveLength(0)

    h.bridge.beginPaste.mockImplementationOnce(async () => { other.focus(); return 'paste-lease' })
    await expect(h.frame.action?.(url, { op: 'paste', ref: '0:textbox:Editor', text: 'wrong target', format: 'text' }))
      .rejects.toThrow('SIDEBAR_PASTE_TARGET_UNAVAILABLE')
    expect(paste).toHaveBeenCalledTimes(2)
    expect(h.bridge.finishPaste).toHaveBeenCalledTimes(3)
    editor.focus()

    let selected = true
    h.bridge.beginPaste.mockImplementationOnce(async () => { selected = false; return 'paste-lease' })
    await expect(h.frame.action?.(url, { op: 'paste', ref: '0:textbox:Editor', text: 'late', format: 'text' },
      () => selected)).rejects.toThrow('SIDEBAR_SELECTION_CHANGED')
    expect(paste).toHaveBeenCalledTimes(2)
    expect(h.bridge.finishPaste).toHaveBeenCalledTimes(4)
    expect(Object.getOwnPropertyNames(guestWindow)).toHaveLength(0)

    h.bridge.beginPaste.mockRejectedValueOnce(new Error('SIDEBAR_CLIPBOARD_CHANGED'))
    await expect(h.frame.action?.(url, { op: 'paste', ref: '0:textbox:Editor',
      text: 'late', format: 'text' })).rejects.toThrow('SIDEBAR_CLIPBOARD_CHANGED')
    expect(paste).toHaveBeenCalledTimes(2)
    expect(h.bridge.finishPaste).toHaveBeenCalledTimes(4)
    expect(Object.getOwnPropertyNames(guestWindow)).toHaveLength(0)
  } finally {
    await h.dispose()
    editor.remove()
    other.remove()
  }
})

it('drags along a checked native pointer path and releases the button if selection changes', async () => {
  const h = electronFixture()
  const source = document.createElement('button')
  const target = document.createElement('div')
  document.body.append(source, target)
  const originalHit = document.elementFromPoint?.bind(document)
  Object.assign(document, { elementFromPoint: (x: number) => x < 100 ? source : target })
  const url = 'https://example.test/'
  try {
    h.mount()
    h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
    const guest = await h.guest()
    guest.state.url = url
    guest.state.title = 'Example'
    guest.state.loading = false
    const evaluate = vi.fn(async (code: string) => runInNewContext(code, {
      location: { href: url, origin: 'https://example.test' }, document, URL,
      innerWidth: 300, innerHeight: 200,
    }) as unknown)
    const events: { type: string; x: number; y: number }[] = []
    let selected = true
    let stopAfterMove = false
    const sendInputEvent = vi.fn(async (event: { type: string; x: number; y: number }) => {
      events.push(event)
      if (stopAfterMove && events.filter(item => item.type === 'mouseMove').length === 4) selected = false
    })
    Object.assign(guest.element, { executeJavaScript: evaluate, sendInputEvent })
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    expect(await h.frame.action?.(url, { op: 'drag', x: 40, y: 40, to: { x: 180, y: 40 } }))
      .toMatchObject({ performed: true, url, dropDispatched: true })
    expect(events.map(event => event.type)).toEqual([
      'mouseMove', 'mouseDown', ...Array<string>(12).fill('mouseMove'), 'mouseUp',
    ])
    expect(events.at(-1)).toMatchObject({ x: 180, y: 40 })
    expect(h.bridge.beginDrag).toHaveBeenCalledWith(h.reservation.lease, url)
    expect(h.bridge.finishDrag).toHaveBeenCalledWith(h.reservation.lease, 'drag-lease', { x: 180, y: 40 })

    events.length = 0
    h.bridge.finishDrag.mockResolvedValueOnce({ dropped: false })
    expect(await h.frame.action?.(url, { op: 'drag', x: 40, y: 40, to: { x: 180, y: 40 } }))
      .toMatchObject({ performed: true, dropDispatched: false })
    events.length = 0
    stopAfterMove = true
    await expect(h.frame.action?.(url, { op: 'drag', x: 40, y: 40, to: { x: 180, y: 40 } },
      () => selected)).rejects.toThrow('SIDEBAR_SELECTION_CHANGED')
    expect(events.filter(event => event.type === 'mouseDown')).toHaveLength(1)
    expect(events.filter(event => event.type === 'mouseUp')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('mouseUp')
    expect(h.bridge.finishDrag).toHaveBeenLastCalledWith(h.reservation.lease, 'drag-lease')
  } finally {
    await h.dispose()
    Object.assign(document, { elementFromPoint: originalHit })
    source.remove()
    target.remove()
  }
})

it('captures the selected guest viewport and discards an image if navigation starts during capture', async () => {
  const h = electronFixture()
  const url = 'https://example.test/'
  try {
    h.mount()
    h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
    const guest = await h.guest()
    guest.state.url = url
    guest.state.title = 'Example'
    guest.state.loading = false
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    const picture = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
      crop: vi.fn(() => picture),
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }
    const capturePage = vi.fn(async () => picture)
    Object.assign(guest.element, { capturePage,
      executeJavaScript: async (code: string) => runInNewContext(code, {
        location: { href: url, origin: 'https://example.test' }, document, URL,
      }) as unknown })
    expect(await h.frame.screenshot?.(url)).toEqual({ url, title: 'Example',
      base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', viewport: { width: 1, height: 1 } })
    expect(await h.frame.screenshot?.(url, { x: 0, y: 0, width: 1, height: 1 })).toMatchObject({
      viewport: { width: 1, height: 1 },
    })
    expect(picture.crop).toHaveBeenCalledWith({ x: 0, y: 0, width: 1, height: 1 })
    await expect(h.frame.screenshot?.(url, { x: 1, y: 0, width: 1, height: 1 }))
      .rejects.toThrow('SIDEBAR_CLIP_OUT_OF_BOUNDS')

    const sameOrigin = document.createElement('iframe')
    document.body.append(sameOrigin)
    expect(await h.frame.screenshot?.(url)).toMatchObject({ url })
    const nestedCrossOrigin = sameOrigin.contentDocument!.createElement('iframe')
    nestedCrossOrigin.src = 'https://other.test/nested'
    sameOrigin.contentDocument!.body.append(nestedCrossOrigin)
    await expect(h.frame.screenshot?.(url)).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    sameOrigin.remove()

    const crossOrigin = document.createElement('iframe')
    crossOrigin.src = 'https://other.test/frame'
    document.body.append(crossOrigin)
    const capturesBefore = capturePage.mock.calls.length
    await expect(h.frame.screenshot?.(url)).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    expect(capturePage.mock.calls.length).toBe(capturesBefore)
    crossOrigin.remove()

    let release: ((value: typeof picture) => void) | undefined
    Object.assign(guest.element, { capturePage: () => new Promise<typeof picture>((resolve) => { release = resolve }) })
    const pending = h.frame.screenshot?.(url)
    await vi.waitFor(() => { expect(release).toBeDefined() })
    guest.state.loading = true
    guest.emit('did-start-loading')
    release?.(picture)
    await expect(pending).rejects.toThrow('SIDEBAR_NAVIGATED')

    guest.state.loading = false
    guest.emit('did-stop-loading')
    release = undefined
    const pendingFrame = h.frame.screenshot?.(url)
    await vi.waitFor(() => { expect(release).toBeDefined() })
    const arrivingFrame = document.createElement('iframe')
    arrivingFrame.src = 'https://other.test/arrived-during-capture'
    document.body.append(arrivingFrame)
    const releaseFrame = release as ((value: typeof picture) => void) | undefined
    releaseFrame?.(picture)
    await expect(pendingFrame).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    arrivingFrame.remove()
  } finally { await h.dispose() }
})

it('routes full-page capture through the owning lease and rechecks frame origins afterward', async () => {
  const h = electronFixture()
  const url = 'https://example.test/'
  try {
    h.mount()
    h.frame.loadUrl({ kind: 'https', url, title: 'Example' })
    const guest = await h.guest()
    guest.state.url = url
    guest.state.title = 'Example'
    guest.state.loading = false
    guest.emit('dom-ready')
    guest.emit('did-navigate')
    Object.assign(guest.element, { executeJavaScript: async (code: string) => runInNewContext(code, {
      location: { href: url, origin: 'https://example.test' }, document, URL,
    }) as unknown })
    const clip = { x: 0, y: 0, width: 1, height: 1 }
    expect(await h.frame.screenshot?.(url, clip, true)).toMatchObject({ url, viewport: { width: 1, height: 1 } })
    expect(h.bridge.captureFullPage).toHaveBeenCalledWith(h.reservation.lease, url, clip)
    const crossOrigin = document.createElement('iframe')
    h.bridge.captureFullPage.mockImplementationOnce(async () => {
      crossOrigin.src = 'https://foreign.test/frame'
      document.body.append(crossOrigin)
      return { url, title: 'Example', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        viewport: { width: 1, height: 1 } }
    })
    try {
      await expect(h.frame.screenshot?.(url, undefined, true)).rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
    } finally { crossOrigin.remove() }
  } finally { await h.dispose() }
})
