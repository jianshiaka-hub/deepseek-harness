/** Isolated Electron probe for the fixed same-origin frame prompt shim. */
const { createServer } = require('node:http')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

async function run() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (request.url === '/frame') {
      response.end('<script>window.ask = () => { parent.__answer = prompt("Frame question", "Frame default") }</script>')
      return
    }
    response.end('<script>window.__answer = "pending"</script><iframe src="/frame"></iframe>')
  })
  let window
  let promptChannel
  try {
    await app.whenReady()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    const preload = path.resolve(__dirname, '../../lib/preload-browser-guest.cjs')
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: false } })
    const { BrowserDialogLease } = await import('../../lib/types/browser-dialog.js')
    const { DESKTOP_IPC } = await import('../../lib/types/ipc.js')
    const lease = new BrowserDialogLease()
    let token
    promptChannel = DESKTOP_IPC.browserGuestPrompt
    ipcMain.on(promptChannel, event => {
      if (event.sender !== window.webContents || token === undefined ||
        !lease.offerPrompt(token, event.senderFrame?.url, answer => { event.returnValue = answer })) {
        event.returnValue = null
      }
    })
    await window.loadURL(url)
    for (let attempt = 0; attempt < 50 && window.webContents.isLoadingMainFrame(); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    if (window.webContents.getURL() !== url || window.webContents.isLoadingMainFrame()) {
      throw new Error(`Unexpected window state: ${window.webContents.getURL()} loading=${window.webContents.isLoadingMainFrame()}`)
    }
    token = await lease.begin(window.webContents, url)
    await window.webContents.executeJavaScript('setTimeout(() => frames[0].ask(), 0)')
    const dialog = await lease.wait(token, 3000)
    if (dialog?.type !== 'prompt') throw new Error(`Frame prompt missing: ${JSON.stringify(dialog)}`)
    await lease.handle(token, dialog.id, 'accept', 'frame approved')
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await window.webContents.executeJavaScript('window.__answer')
      if (result === 'frame approved') {
        if (window.webContents.debugger.isAttached()) throw new Error('Dialog debugger was not released')
        process.stdout.write('Electron direct frame prompt PASS\n')
        app.exit(0)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error('Frame prompt answer was not returned')
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    if (promptChannel !== undefined) ipcMain.removeAllListeners(promptChannel)
    window?.destroy()
    server.close()
  }
}
setTimeout(() => { process.stderr.write('direct frame prompt probe timed out\n'); app.exit(124) }, 18000).unref()
void run()
