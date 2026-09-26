/** Isolated Electron probe for beforeunload in an approved foreign child frame. */
const { createServer } = require('node:http')
const { app, BrowserWindow } = require('electron')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const serve = handler => new Promise(resolve => {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})

async function run() {
  let window, topServer, childServer, destinationServer
  try {
    await app.whenReady()
    if (process.env.SIDEBAR_FOREIGN_CROSS_ORIGIN === '1') {
      destinationServer = await serve((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><title>Approved destination</title>')
      })
    }
    const destinationUrl = destinationServer
      ? `http://127.0.0.1:${destinationServer.address().port}/next` : undefined
    childServer = await serve((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(request.url === '/next' ? '<!doctype html><title>Next</title>' : `<!doctype html><title>Foreign frame</title>
        <button id="arm" style="position:absolute;left:20px;top:20px;width:120px;height:60px">Arm</button>
        <button id="navigate" style="position:absolute;left:20px;top:100px;width:120px;height:60px">Navigate</button>
        <script>
          document.getElementById('arm').onclick = () => {
            addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue=''; });
            window.__armed=navigator.userActivation.hasBeenActive;
          };
          document.getElementById('navigate').onclick = () => {
            location.assign(${JSON.stringify(destinationUrl ?? '/next')});
          };
        </script>`)
    })
    const childUrl = `http://127.0.0.1:${childServer.address().port}/`
    topServer = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><title>Top</title><iframe id="foreign" src="${childUrl}" style="position:absolute;left:20px;top:20px;width:300px;height:220px"></iframe>${destinationUrl ?
        `<iframe src="${new URL('/existing', destinationUrl)}" style="width:1px;height:1px"></iframe>` : ''}`)
    })
    const topUrl = `http://127.0.0.1:${topServer.address().port}/`
    window = new BrowserWindow({ show: true, width: 500, height: 400,
      webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } })
    window.webContents.on('will-attach-webview', (_event, preferences) => {
      preferences.disableDialogs = true
    })
    const attached = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)))
    await window.loadURL(`data:text/html,${encodeURIComponent(`<webview src="${topUrl}" style="width:500px;height:400px"></webview>`)}`)
    const guest = await attached
    let child
    for (let attempt = 0; attempt < 100; attempt++) {
      child = guest.mainFrame.framesInSubtree.find(frame => frame.url === childUrl)
      if (child && !guest.isLoadingMainFrame()) break
      await sleep(50)
    }
    if (!child) throw new Error('Foreign frame did not load')
    if (destinationUrl) {
      const existingUrl = new URL('/existing', destinationUrl).href
      for (let attempt = 0; attempt < 100 && !guest.mainFrame.framesInSubtree.some(frame => frame.url === existingUrl); attempt++) {
        await sleep(50)
      }
      if (!guest.mainFrame.framesInSubtree.some(frame => frame.url === existingUrl)) {
        throw new Error('Approved destination site did not load in the initial frame tree')
      }
    }
    window.focus()
    guest.focus()
    await sleep(100)
    const sendClick = async (x, y) => {
      if (process.env.SIDEBAR_FOREIGN_INPUT_PATH === 'webview') {
        await window.webContents.executeJavaScript(`(async () => {
          const view = document.querySelector('webview');
          await view.sendInputEvent({ type: 'mouseMove', x: ${x}, y: ${y} });
          await view.sendInputEvent({ type: 'mouseDown', x: ${x}, y: ${y}, button: 'left', clickCount: 1 });
          await view.sendInputEvent({ type: 'mouseUp', x: ${x}, y: ${y}, button: 'left', clickCount: 1 });
        })()`)
      } else {
        guest.sendInputEvent({ type: 'mouseMove', x, y })
        guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
        guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
      }
    }
    const frameRect = await guest.executeJavaScript(`(() => { const r = document.getElementById('foreign').getBoundingClientRect();
      return {x:r.left,y:r.top}; })()`)
    const buttonRect = await child.executeJavaScript(`(() => { const r = document.getElementById('arm').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`)
    const x = Math.round(frameRect.x + 2 + buttonRect.x)
    const y = Math.round(frameRect.y + 2 + buttonRect.y)
    await sendClick(x, y)
    await sleep(100)
    const activation = await child.executeJavaScript('({armed:window.__armed,active:navigator.userActivation.hasBeenActive})')
    if (!activation.armed || !activation.active) throw new Error(`Foreign activation missing: ${JSON.stringify(activation)}`)
    const { BrowserDialogLease } = await import('../../lib/types/browser-dialog.js')
    const dialogs = new BrowserDialogLease()
    if (!dialogs.installNativeDialogGuard(guest, () => false)) {
      throw new Error('Electron native dialog guard did not install')
    }
    const events = []
    let requestedNavigation
    guest.on('will-prevent-unload', () => events.push('will-prevent-unload'))
    guest.on('will-frame-navigate', details => {
      events.push('will-frame-navigate:' + JSON.stringify({ url: details.url, frame: details.frame?.url, isMainFrame: details.isMainFrame }))
    })
    guest.on('-run-dialog', raw => events.push('-run-dialog:' + raw?.dialogType))
    guest.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed' ||
        method === 'Page.frameRequestedNavigation' || method === 'Page.frameNavigated') {
        events.push(method + ':' + JSON.stringify(params))
        if (method === 'Page.frameRequestedNavigation' && params?.url?.endsWith('/next')) {
          requestedNavigation = { frameId: params.frameId, url: params.url, reason: params.reason }
        }
      }
    })
    const denied = await dialogs.begin(guest, topUrl)
    if (process.env.SIDEBAR_FOREIGN_NAV_METHOD === 'click') {
      const navRect = await child.executeJavaScript(`(() => { const r = document.getElementById('navigate').getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`)
      const navX = Math.round(frameRect.x + 2 + navRect.x)
      const navY = Math.round(frameRect.y + 2 + navRect.y)
      await sendClick(navX, navY)
    } else void child.executeJavaScript(`location.assign(${JSON.stringify(destinationUrl ?? '/next')})`).catch(() => {})
    if (await dialogs.wait(denied, 250) !== null) throw new Error('Unapproved foreign beforeunload was offered')
    if (child.url !== childUrl) throw new Error('Unapproved foreign beforeunload did not cancel navigation')
    await dialogs.close(denied)

    if (process.env.SIDEBAR_FOREIGN_REPLAY_PROBE === '1') {
      if (requestedNavigation?.reason !== 'scriptInitiated' ||
        requestedNavigation.url !== (destinationUrl ?? new URL('/next', childUrl).href)) {
        throw new Error(`Foreign navigation request unavailable: ${JSON.stringify(requestedNavigation)}`)
      }
      const replay = await dialogs.begin(guest, topUrl,
        [new URL(topUrl).origin, new URL(childUrl).origin])
      try {
        events.push('Page.getFrameTree:' + JSON.stringify(await guest.debugger.sendCommand('Page.getFrameTree')))
        const navigating = guest.debugger.sendCommand('Page.navigate', {
          frameId: requestedNavigation.frameId, url: requestedNavigation.url,
        })
        const retryDialog = await dialogs.wait(replay, 3000)
        if (retryDialog?.type !== 'beforeunload') {
          throw new Error(`Replay dialog unavailable: ${JSON.stringify(retryDialog)}`)
        }
        try { await guest.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }) }
        catch (error) { events.push('replay-handle-error:' + String(error)) }
        const result = await navigating.catch(error => ({ error: String(error) }))
        events.push('Page.navigate:' + JSON.stringify(result))
        for (let attempt = 0; attempt < 60 && child.url === childUrl; attempt++) await sleep(50)
        if (child.url === childUrl) {
          throw new Error(`Replay did not navigate: ${JSON.stringify({ childUrl: child.url, result })}`)
        }
      } finally {
        await dialogs.close(replay)
      }
      process.stdout.write(`Electron foreign beforeunload replay probe PASS: events=${JSON.stringify(events)}\n`)
      return
    }

    const approved = await dialogs.begin(guest, topUrl,
      [new URL(topUrl).origin, new URL(childUrl).origin,
        ...(destinationUrl ? [new URL(destinationUrl).origin] : [])])
    if (process.env.SIDEBAR_FOREIGN_NAV_METHOD === 'click') {
      const navRect = await child.executeJavaScript(`(() => { const r = document.getElementById('navigate').getBoundingClientRect();
        return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`)
      const navX = Math.round(frameRect.x + 2 + navRect.x)
      const navY = Math.round(frameRect.y + 2 + navRect.y)
      await sendClick(navX, navY)
    } else void child.executeJavaScript(`location.assign(${JSON.stringify(destinationUrl ?? '/next')})`).catch(() => {})
    const dialog = await dialogs.wait(approved, 3000)
    if (dialog?.type !== 'beforeunload') {
      throw new Error(`Approved foreign beforeunload was not offered: ${JSON.stringify(dialog)}`)
    }
    await dialogs.handle(approved, dialog.id, 'accept')
    const nextUrl = destinationUrl ?? new URL('/next', childUrl).href
    for (let attempt = 0; attempt < 60 && !guest.mainFrame.framesInSubtree.some(frame => frame.url === nextUrl); attempt++) {
      await sleep(50)
    }
    if (!guest.mainFrame.framesInSubtree.some(frame => frame.url === nextUrl)) {
      throw new Error('Approved foreign frame did not navigate')
    }
    if (guest.debugger.isAttached()) throw new Error('Dialog debugger lease was not released')
    process.stdout.write(`Electron foreign beforeunload probe PASS: unapproved canceled, approved accepted; events=${JSON.stringify(events)}; preferences=${JSON.stringify(guest.getLastWebPreferences())}\n`)
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    window?.destroy()
    topServer?.close()
    childServer?.close()
    destinationServer?.close()
  }
}

setTimeout(() => { process.stderr.write('foreign beforeunload probe timed out\n'); app.exit(124) }, 18000).unref()
void run()
