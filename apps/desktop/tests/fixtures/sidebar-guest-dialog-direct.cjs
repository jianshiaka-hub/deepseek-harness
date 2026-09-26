/** Isolated Electron acceptance of sandboxed top-level and same-origin guest dialogs. */
const { createServer } = require('node:http')
const { join, resolve } = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { app, BrowserWindow, ipcMain } = require('electron')

async function run() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (request.url === '/frame') {
      response.end('<script>window.ask = () => { parent.__frameResult = confirm("Private child choice") }</script>')
      return
    }
    response.end(`<!doctype html><title>Guest dialog test</title><script>
      window.__result = 'pending'; window.__frameResult = 'pending';
      window.askConfirm = () => { window.__result = confirm('Private top choice') };
      window.askAlert = () => { alert('Private top notice'); window.__result = 'alerted' };
    </script><iframe src="/frame"></iframe>`)
  })
  let window
  let token
  let lease
  const profile = mkdtempSync(join(tmpdir(), 'dsh-guest-dialog-'))
  app.setPath('userData', profile)
  try {
    await app.whenReady()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    const preload = resolve(__dirname, '../../lib/preload-browser-guest.cjs')
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, disableDialogs: true } })
    const { BrowserDialogLease } = await import('../../lib/types/browser-dialog.js')
    const { DESKTOP_IPC } = await import('../../lib/types/ipc.js')
    lease = new BrowserDialogLease()
    ipcMain.on(DESKTOP_IPC.browserGuestPrompt, event => {
      const offered = token !== undefined && lease.offerPrompt(token, event.senderFrame?.url,
        answer => { event.returnValue = answer })
      if (!offered) event.returnValue = null
    })
    ipcMain.on(DESKTOP_IPC.browserGuestDialog, (event, type, ...extras) => {
      if (extras.length || !['confirm','alert'].includes(type)) {
        throw new Error('Page message escaped the guest')
      }
      const offered = token !== undefined && lease.offerGuestDialog(token, event.senderFrame?.url,
        type, answer => { event.returnValue = answer })
      if (!offered) event.returnValue = type === 'confirm' ? false : undefined
    })
    await window.loadURL(url)
    const guest = window.webContents
    const ask = async (type, action, inFrame = false) => {
      await guest.executeJavaScript(inFrame ? "window.__frameResult = 'pending'" : "window.__result = 'pending'")
      token = await lease.begin(guest, url)
      const call = type === 'alert' ? 'askAlert' : inFrame ? 'ask' : 'askConfirm'
      await guest.executeJavaScript(inFrame
        ? `setTimeout(() => document.querySelector('iframe').contentWindow.${call}(), 0)`
        : `setTimeout(window.${call}, 0)`)
      const dialog = await lease.wait(token, 3000)
      if (dialog?.type !== type || JSON.stringify(dialog).includes('Private')) {
        throw new Error(`Opaque ${type} unavailable: ${JSON.stringify(dialog)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (lease.get(token)?.id !== dialog.id) throw new Error(`${type} was auto-dismissed`)
      await lease.handle(token, dialog.id, action)
      token = undefined
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await guest.executeJavaScript(inFrame ? 'window.__frameResult' : 'window.__result')
        if (result !== 'pending') return result
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error(`${type} did not resume the page`)
    }
    if (await ask('confirm', 'accept') !== true) throw new Error('Top confirm accept failed')
    if (await ask('confirm', 'dismiss') !== false) throw new Error('Top confirm dismiss failed')
    if (await ask('alert', 'accept') !== 'alerted') throw new Error('Top alert continuation failed')
    if (await ask('confirm', 'accept', true) !== true) throw new Error('Frame confirm accept failed')
    process.stdout.write('Sandboxed guest dialogs PASS: top confirm/alert, same-origin frame confirm, delayed one-use answers\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    if (token !== undefined && lease !== undefined) await lease.close(token).catch(() => {})
    ipcMain.removeAllListeners('dsh-desktop:browser-guest-prompt')
    ipcMain.removeAllListeners('dsh-desktop:browser-guest-dialog')
    window?.destroy()
    server.close()
  }
}
setTimeout(() => { process.stderr.write('Sandboxed guest dialog probe timed out\n'); process.exit(124) }, 15000).unref()
void run()
