/** Isolated Electron guest: production prompt preload and dialog lease. */
const path = require('node:path')
const { createServer } = require('node:http')
const { app, BrowserWindow, ipcMain } = require('electron')

async function run() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (request.url === '/frame') {
      response.end('<!doctype html><title>Same-origin frame</title><script>window.runFramePrompt = () => { parent.__frameResult = prompt("Frame question", "Frame default") }</script>')
      return
    }
    response.end(`<!doctype html><title>Prompt lease</title><script>
      window.__result = 'pending';
      window.runPrompt = () => { window.__result = prompt('Private question', 'Private default') };
    </script><iframe src="/frame"></iframe>`)
  })
  let window
  let promptChannel
  try {
    await app.whenReady()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    window = new BrowserWindow({ show: true, width: 400, height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } })
    await window.loadURL('data:text/html,<body></body>')
    const { DesktopBrowserGuests } = await import('../../lib/types/browser-guests.js')
    const { DESKTOP_IPC } = await import('../../lib/types/ipc.js')
    promptChannel = DESKTOP_IPC.browserGuestPrompt
    const preload = path.resolve(__dirname, '../../lib/preload-browser-guest.cjs')
    const guests = new DesktopBrowserGuests(() => 'http://127.0.0.1:9999/', preload)
    guests.bind(window)
    if (process.env.SIDEBAR_SUBFRAME_PRELOAD === '1') {
      window.webContents.on('will-attach-webview', (_event, preferences) => {
        preferences.nodeIntegrationInSubFrames = true
      })
    }
    const reservation = guests.acquire(window.webContents, 'isolated-prompt-probe')
    ipcMain.on(promptChannel, (event, ...args) => {
      if (args.length !== 0) throw new Error('Page-supplied prompt text escaped the guest')
      guests.offerPrompt(event.sender, event.senderFrame?.url, answer => { event.returnValue = answer })
    })
    const attached = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)))
    await window.webContents.executeJavaScript(`(() => {
      const webview = document.createElement('webview');
      webview.setAttribute('partition', ${JSON.stringify(reservation.partition)});
      webview.setAttribute('src', ${JSON.stringify('about:blank#' + reservation.lease)});
      webview.style.cssText = 'width:400px;height:300px';
      document.body.append(webview);
    })()`)
    const guest = await attached
    for (let attempt = 0; attempt < 100 && guests.leases.get(reservation.lease)?.guest !== guest; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (guests.leases.get(reservation.lease)?.guest !== guest) throw new Error('Guest lease did not attach')
    await guest.loadURL(url)
    const frameCapabilities = await guest.executeJavaScript(`(() => {
      const frame = document.querySelector('iframe').contentWindow;
      return { promptShim: typeof frame.__dshGuestPrompt, require: typeof frame.require,
        process: typeof frame.process, electron: typeof frame.electron };
    })()`)
    if (JSON.stringify(frameCapabilities) !== JSON.stringify({ promptShim: 'undefined',
      require: 'undefined', process: 'undefined', electron: 'undefined' })) {
      throw new Error(`Subframe preload boundary changed: ${JSON.stringify(frameCapabilities)}`)
    }

    const ask = async (answer, action) => {
      await guest.executeJavaScript("window.__result = 'pending'")
      const token = await guests.beginDialog(window.webContents, reservation.lease, url)
      // Schedule the prompt only after its exact guest and URL have been watched.
      await guest.executeJavaScript('setTimeout(window.runPrompt, 0)')
      const dialog = await guests.waitDialog(window.webContents, reservation.lease, token, 3000)
      if (dialog?.type !== 'prompt') throw new Error(`Expected prompt handle, got ${JSON.stringify(dialog)}`)
      await guests.handleDialog(window.webContents, reservation.lease, token, dialog.id, action, answer)
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await guest.executeJavaScript('window.__result')
        if (result !== 'pending') return result
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('Prompt page script did not resume')
    }
    if (await ask('approved text', 'accept') !== 'approved text') throw new Error('Accepted prompt answer was lost')
    if (await ask(undefined, 'accept') !== 'Private default') throw new Error('Default prompt answer was lost')
    if (await ask(undefined, 'dismiss') !== null) throw new Error('Dismissed prompt did not return null')
    const askFrame = async (answer, action) => {
      await guest.executeJavaScript("window.__frameResult = 'pending'")
      const token = await guests.beginDialog(window.webContents, reservation.lease, url)
      await guest.executeJavaScript("setTimeout(() => document.querySelector('iframe').contentWindow.runFramePrompt(), 0)")
      const dialog = await guests.waitDialog(window.webContents, reservation.lease, token, 3000)
      if (dialog?.type !== 'prompt') throw new Error(`Expected same-origin frame prompt, got ${JSON.stringify(dialog)}`)
      await guests.handleDialog(window.webContents, reservation.lease, token, dialog.id, action, answer)
      for (let attempt = 0; attempt < 50; attempt++) {
        const result = await guest.executeJavaScript('window.__frameResult')
        if (result !== 'pending') return result
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('Same-origin frame prompt did not resume')
    }
    if (await askFrame('frame approved', 'accept') !== 'frame approved') throw new Error('Frame prompt answer was lost')
    if (await askFrame(undefined, 'dismiss') !== null) throw new Error('Frame prompt dismissal was lost')
    await guest.executeJavaScript('setTimeout(window.runPrompt, 0)')
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await guest.executeJavaScript('window.__result') === null) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (await guest.executeJavaScript('window.__result') !== null || guest.debugger.isAttached()) {
      throw new Error('Unwatched prompt or debugger lease remained active')
    }
    process.stdout.write('Electron Sidebar prompt PASS: owned guest, same-origin frame, opaque handle, accept/dismiss, no page text in IPC\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    if (promptChannel !== undefined) ipcMain.removeAllListeners(promptChannel)
    window?.destroy()
    server.close()
  }
}
setTimeout(() => { process.stderr.write('sidebar prompt probe timed out\n'); app.exit(124) }, 18000).unref()
void run()
