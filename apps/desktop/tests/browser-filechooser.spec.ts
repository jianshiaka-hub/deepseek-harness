import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserFileChooserLease } from '../src/browser-filechooser.ts'

const url = 'https://example.test/page'
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

function fixture() {
  const state = { url, attached: false, destroyed: false, childLoader: 'child-loader' }
  const debuggerEvents = new EventEmitter()
  const sendCommand = vi.fn(async (method: string): Promise<object> =>
    method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'top', url, loaderId: 'top-loader' },
      childFrames: [{ frame: { id: 'child', url: 'https://files.test/form',
        loaderId: state.childLoader } }] } } : {})
  const debuggerPort = Object.assign(debuggerEvents, {
    isAttached: () => state.attached,
    attach: vi.fn(() => { state.attached = true }),
    detach: vi.fn(() => { state.attached = false }), sendCommand,
  })
  const guest = Object.assign(new EventEmitter(), {
    debugger: debuggerPort, getURL: () => state.url,
    isDestroyed: () => state.destroyed, isLoadingMainFrame: () => false,
  })
  const open = (frameId: string, mode = 'selectSingle', backendNodeId = 7): void => {
    debuggerEvents.emit('message', {}, 'Page.fileChooserOpened', { frameId, mode, backendNodeId })
  }
  return { state, guest, debuggerPort, sendCommand, open }
}

it('intercepts one input, reports its frame origin, and supplies only the approved file', async () => {
  const h = fixture()
  const lease = new BrowserFileChooserLease()
  const token = await lease.begin(h.guest, url)
  expect(h.sendCommand).toHaveBeenCalledWith('Page.setInterceptFileChooserDialog', { enabled: true })
  h.open('child', 'selectMultiple')
  await vi.waitFor(() => { expect(lease.poll(token)).toEqual({ state: 'offered',
    origin: 'https://files.test', multiple: true }) })
  const directory = mkdtempSync(join(tmpdir(), 'dsh-cu-chooser-test-'))
  directories.push(directory)
  const file = join(directory, 'approved.txt')
  writeFileSync(file, 'approved bytes')
  await expect(lease.setFiles(token, 'https://wrong.test', [file]))
    .rejects.toThrow('SIDEBAR_FILECHOOSER_LEASE_UNAVAILABLE')
  expect(h.sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything())
  await lease.setFiles(token, 'https://files.test', [file])
  expect(h.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles',
    { files: [realpathSync(file)], backendNodeId: 7 })
  expect(h.debuggerPort.detach).toHaveBeenCalledOnce()
  expect(() => lease.poll(token)).toThrow('SIDEBAR_FILECHOOSER_LEASE_UNAVAILABLE')
})

it('rejects a changed selected page and refuses a chooser without a file input node', async () => {
  const h = fixture()
  const lease = new BrowserFileChooserLease()
  const token = await lease.begin(h.guest, url)
  h.open('top', 'selectSingle', 0)
  await vi.waitFor(() => { expect(lease.poll(token).state).toBe('failed') })
  await lease.cancel(token)
  const next = await lease.begin(h.guest, url)
  h.state.url = 'https://other.test/'
  h.guest.emit('did-navigate')
  expect(() => lease.poll(next)).toThrow('SIDEBAR_NAVIGATED')
  await lease.cancel(next)
})

it('rejects an iframe replacement after the chooser opens but before local files are supplied', async () => {
  const h = fixture()
  const lease = new BrowserFileChooserLease()
  const token = await lease.begin(h.guest, url)
  h.open('child')
  await vi.waitFor(() => { expect(lease.poll(token).state).toBe('offered') })
  h.state.childLoader = 'new-document'
  await expect(lease.setFiles(token, 'https://files.test', []))
    .rejects.toThrow('SIDEBAR_FILECHOOSER_FRAME_CHANGED')
  expect(h.sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything())
  expect(h.debuggerPort.detach).toHaveBeenCalledOnce()
})
