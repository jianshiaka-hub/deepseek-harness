/** Synthetic, isolated Electron guest dialog probe. */
const { createServer } = require('node:http')
const { app, BrowserWindow } = require('electron')

async function run() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Dialog probe</title><script>window.__results=[]</script>')
  })
  let window
  try {
    await app.whenReady()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } })
    window.webContents.on('will-attach-webview', (_event, preferences) => { preferences.disableDialogs = true })
    const attached = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)))
    await window.loadURL(`data:text/html,${encodeURIComponent(`<webview src="${url}" style="width:400px;height:300px"></webview>`)}`)
    const guest = await attached
    if (guest.getURL() !== url || guest.isLoadingMainFrame()) {
      await new Promise(resolve => guest.once('did-stop-loading', resolve))
    }
    const { BrowserDialogLease } = await import('../../lib/types/browser-dialog.js')
    const dialogs = new BrowserDialogLease()
    const scripts = [
      "setTimeout(()=>{try{__results.push(prompt('Prompt','Default'))}catch(error){__results.push('prompt error: '+error.message)}},0)",
      "setTimeout(()=>{alert('Alert');__results.push('alert')},0)",
      "setTimeout(()=>{__results.push(confirm('Confirm'))},0)",
    ]
    const results = []
    for (const [index, code] of scripts.entries()) {
      if (index > 0) {
        const loaded = new Promise(resolve => guest.once('did-stop-loading', resolve))
        guest.reload()
        await loaded
      }
      const token = await dialogs.begin(guest, url)
      await guest.executeJavaScript(code)
      if (index > 0) {
        const dialog = await dialogs.wait(token, 3000)
        if (dialog?.type !== (index === 1 ? 'alert' : 'confirm')) {
          throw new Error(`Expected an Electron dialog for script ${index}, got ${JSON.stringify(dialog)}`)
        }
        await dialogs.handle(token, dialog.id, index === 1 ? 'dismiss' : 'accept')
      } else if (dialogs.get(token) !== null) {
        throw new Error('Electron prompt unexpectedly opened a dialog')
      } else await dialogs.close(token)
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await guest.executeJavaScript('window.__results')).length > 0) break
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      results.push(...await guest.executeJavaScript('window.__results'))
    }
    if (JSON.stringify(results) !== '["prompt error: prompt() is not supported.","alert",true]') {
      throw new Error(`Unexpected dialog results: ${JSON.stringify(results)}`)
    }
    if (guest.debugger.isAttached()) throw new Error('Dialog debugger lease was not released')
    process.stdout.write('Electron Sidebar dialog probe PASS: alert and confirm via CDP; prompt unsupported\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    window?.destroy()
    server.close()
  }
}

setTimeout(() => { process.stderr.write('sidebar dialog probe timed out\n'); app.exit(124) }, 18000).unref()
void run()
