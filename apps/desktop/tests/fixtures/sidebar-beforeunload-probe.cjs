/** Isolated Electron guest: test a native user gesture followed by beforeunload. */
const { createServer } = require('node:http')
const { app, BrowserWindow } = require('electron')

async function run() {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (request.url === '/next') {
      response.end('<!doctype html><title>Next</title><p>Arrived</p>')
      return
    }
    response.end(`<!doctype html><title>Beforeunload</title>
      <button id="arm" style="position:absolute;left:20px;top:20px;width:120px;height:60px">Arm</button>
      <a id="next" href="/next" style="position:absolute;left:20px;top:110px;width:120px;height:60px">Next</a>
      <script>
        document.querySelector('#arm').addEventListener('click', () => {
          window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });
          window.__armed = navigator.userActivation.hasBeenActive;
        });
      </script>`)
  })
  let window
  try {
    await app.whenReady()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/`
    const next = new URL('/next', url).href
    window = new BrowserWindow({ show: true, width: 400, height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } })
    window.webContents.on('will-attach-webview', (_event, preferences) => { preferences.disableDialogs = true })
    const attached = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)))
    await window.loadURL(`data:text/html,${encodeURIComponent(`<webview src="${url}" style="width:400px;height:300px"></webview>`)}`)
    const guest = await attached
    if (guest.getURL() !== url || guest.isLoadingMainFrame()) {
      await new Promise(resolve => guest.once('did-stop-loading', resolve))
    }
    if (['back', 'forward', 'nativeback', 'nativeforward', 'isoback', 'isoforward'].includes(process.env.SIDEBAR_NAV_METHOD)) {
      await guest.loadURL(next)
      if (['back', 'nativeback', 'isoback'].includes(process.env.SIDEBAR_NAV_METHOD)) await guest.loadURL(url)
      else {
        const returned = new Promise(resolve => guest.once('did-stop-loading', resolve))
        guest.goBack()
        await returned
      }
      if (guest.getURL() !== url) throw new Error('History setup did not return to the source page')
    }
    window.focus()
    guest.focus()
    await new Promise(resolve => setTimeout(resolve, 100))
    const { BrowserDialogLease } = await import('../../lib/types/browser-dialog.js')
    const dialogs = new BrowserDialogLease()
    let browserGuests
    const serviceNavigation = process.env.SIDEBAR_NAV_METHOD === 'serviceassign'
    const serviceLease = 'isolated-probe-lease'
    if (serviceNavigation) {
      const { DesktopBrowserGuests } = await import('../../lib/types/browser-guests.js')
      browserGuests = new DesktopBrowserGuests(() => 'http://127.0.0.1:9999/')
      browserGuests.leases.set(serviceLease, { owner: window.webContents, partition: 'probe', attached: true, guest })
    }
    await window.webContents.executeJavaScript(`(async () => {
      const webview = document.querySelector('webview');
      await webview.sendInputEvent({type:'mouseMove',x:60,y:50});
      await webview.sendInputEvent({type:'mouseDown',x:60,y:50,button:'left',clickCount:1});
      await webview.sendInputEvent({type:'mouseUp',x:60,y:50,button:'left',clickCount:1});
    })()`)
    const activated = await guest.executeJavaScript(`({armed:window.__armed,
      active:navigator.userActivation.hasBeenActive,hit:document.elementFromPoint(60,50)?.id})`)
    if (!activated.armed || !activated.active) {
      throw new Error(`Native guest activation was not observed: ${JSON.stringify(activated)}`)
    }
    const token = serviceNavigation
      ? await browserGuests.beginDialog(window.webContents, serviceLease, url)
      : await dialogs.begin(guest, url)
    if (serviceNavigation) {
      for (const [badToken, oldUrl, method, destination] of [
        ['wrong-token', url, 'goto', next],
        [token, next, 'goto', next],
        [token, url, 'goto', 'javascript:alert(1)'],
      ]) {
        try {
          browserGuests.navigate(window.webContents, serviceLease, badToken, oldUrl, method, destination)
          throw new Error('Rejected navigation unexpectedly succeeded')
        } catch (error) {
          if (error.message === 'Rejected navigation unexpectedly succeeded') throw error
        }
      }
    }
    if (serviceNavigation) {
      browserGuests.navigate(window.webContents, serviceLease, token, url, 'goto', next)
      try {
        browserGuests.navigate(window.webContents, serviceLease, token, url, 'goto', next)
        throw new Error('One-use navigation unexpectedly repeated')
      } catch (error) {
        if (error.message === 'One-use navigation unexpectedly repeated') throw error
      }
    }
    else if (process.env.SIDEBAR_NAV_METHOD === 'nativeback') guest.goBack()
    else if (process.env.SIDEBAR_NAV_METHOD === 'nativeforward') guest.goForward()
    else if (process.env.SIDEBAR_NAV_METHOD === 'isoback') {
      void guest.executeJavaScriptInIsolatedWorld(1001, [{ code: 'history.back()' }]).catch(() => {})
    } else if (process.env.SIDEBAR_NAV_METHOD === 'isoforward') {
      void guest.executeJavaScriptInIsolatedWorld(1001, [{ code: 'history.forward()' }]).catch(() => {})
    } else if (process.env.SIDEBAR_NAV_METHOD === 'isoassign') {
      const code = `(() => { if (location.href !== ${JSON.stringify(url)}) throw new Error('SIDEBAR_NAVIGATED'); location.assign(${JSON.stringify(next)}); })()`
      void guest.executeJavaScriptInIsolatedWorld(1001, [{ code }]).catch(() => {})
    }
    else if (['assign', 'back', 'forward'].includes(process.env.SIDEBAR_NAV_METHOD)) {
      const code = process.env.SIDEBAR_NAV_METHOD === 'assign' ? `location.assign(${JSON.stringify(next)})`
        : process.env.SIDEBAR_NAV_METHOD === 'back' ? 'history.back()' : 'history.forward()'
      void guest.executeJavaScript(code).catch(() => {})
    } else {
      await window.webContents.executeJavaScript(`(async () => {
        const webview = document.querySelector('webview');
        await webview.sendInputEvent({type:'mouseMove',x:60,y:140});
        await webview.sendInputEvent({type:'mouseDown',x:60,y:140,button:'left',clickCount:1});
        await webview.sendInputEvent({type:'mouseUp',x:60,y:140,button:'left',clickCount:1});
      })()`)
    }
    const dialog = serviceNavigation
      ? await browserGuests.waitDialog(window.webContents, serviceLease, token, 3000)
      : await dialogs.wait(token, 3000)
    const stateAtDialog = { url: guest.getURL(), loading: guest.isLoadingMainFrame() }
    if (dialog?.type !== 'beforeunload') {
      throw new Error(`Expected beforeunload, got ${JSON.stringify(dialog)}`)
    }
    if (serviceNavigation) await browserGuests.handleDialog(window.webContents, serviceLease, token, dialog.id, 'accept')
    else await dialogs.handle(token, dialog.id, 'accept')
    for (let attempt = 0; attempt < 60 && guest.getURL() !== next; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (guest.getURL() !== next || guest.debugger.isAttached()) {
      throw new Error(`Beforeunload navigation did not finish cleanly: ${guest.getURL()}`)
    }
    process.stdout.write(`Electron Sidebar beforeunload probe PASS: native activation, dialog, navigation ${JSON.stringify(stateAtDialog)}\n`)
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    window?.destroy()
    server.close()
  }
}

setTimeout(() => { process.stderr.write('sidebar beforeunload probe timed out\n'); app.exit(124) }, 18000).unref()
void run()
