/** Isolated Electron probe for foreign-frame dialogs through the real lease. */
const { createServer } = require('node:http')
const { app, BrowserWindow } = require('electron')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const serve = handler => new Promise(resolve => {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})

async function readAnswer(frame, name) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const value = await frame.executeJavaScript(`window.${name}`)
    if (value !== 'pending') return value
    await sleep(50)
  }
  throw new Error(`${name} stayed pending`)
}

async function run() {
  let window, topServer, childServer
  try {
    await app.whenReady()
    childServer = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><title>Foreign frame</title>
        <button id="prompt" onclick="window.promptAnswer=prompt('secret text','Seed')">Prompt</button>
        <button id="confirm" onclick="window.confirmAnswer=confirm('secret text')">Confirm</button>
        <button id="alert" onclick="alert('secret text');window.alertAnswer='closed'">Alert</button>
        <script>window.promptAnswer='pending';window.confirmAnswer='pending';window.alertAnswer='pending'</script>`)
    })
    const childUrl = `http://127.0.0.1:${childServer.address().port}/`
    topServer = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><title>Top</title><iframe src="${childUrl}"></iframe>`)
    })
    const topUrl = `http://127.0.0.1:${topServer.address().port}/`
    window = new BrowserWindow({ show: false, width: 500, height: 400,
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
    const { BrowserDialogLease } = await import('../../lib/types/browser-dialog.js')
    const dialogs = new BrowserDialogLease()
    let token
    if (!dialogs.installNativeDialogGuard(guest, (source, type, respond) =>
      token !== undefined && dialogs.offerNativeDialog(token, source, type, respond))) {
      throw new Error('Electron native dialog guard did not install')
    }

    // An origin without a grant must be dismissed without creating a handle.
    token = await dialogs.begin(guest, topUrl)
    void child.executeJavaScript("document.getElementById('prompt').click()")
    if (await readAnswer(child, 'promptAnswer') !== null || dialogs.get(token) !== null) {
      throw new Error('Unapproved foreign prompt was offered')
    }
    await dialogs.close(token)
    token = undefined

    // A granted foreign frame must be offered once and answered through the lease.
    token = await dialogs.begin(guest, topUrl, [new URL(topUrl).origin, new URL(childUrl).origin])
    void child.executeJavaScript("window.promptAnswer='pending';document.getElementById('prompt').click()")
    const prompt = await dialogs.wait(token, 3000)
    if (prompt?.type !== 'prompt') throw new Error(`Expected foreign prompt: ${JSON.stringify(prompt)}`)
    await dialogs.handle(token, prompt.id, 'accept', 'approved')
    if (await readAnswer(child, 'promptAnswer') !== 'approved') throw new Error('Foreign prompt answer was lost')
    token = undefined

    token = await dialogs.begin(guest, topUrl, [new URL(topUrl).origin, new URL(childUrl).origin])
    void child.executeJavaScript("document.getElementById('confirm').click()")
    const confirm = await dialogs.wait(token, 3000)
    if (confirm?.type !== 'confirm') throw new Error(`Expected foreign confirm: ${JSON.stringify(confirm)}`)
    await dialogs.handle(token, confirm.id, 'accept')
    if (await readAnswer(child, 'confirmAnswer') !== true) throw new Error('Foreign confirm answer was lost')
    token = undefined

    token = await dialogs.begin(guest, topUrl, [new URL(topUrl).origin, new URL(childUrl).origin])
    void child.executeJavaScript("document.getElementById('alert').click()")
    const alert = await dialogs.wait(token, 3000)
    if (alert?.type !== 'alert') throw new Error(`Expected foreign alert: ${JSON.stringify(alert)}`)
    await dialogs.handle(token, alert.id, 'dismiss')
    if (await readAnswer(child, 'alertAnswer') !== 'closed') throw new Error('Foreign alert did not unblock')
    token = undefined

    void child.executeJavaScript("window.promptAnswer='pending';document.getElementById('prompt').click()")
    if (await readAnswer(child, 'promptAnswer') !== null) throw new Error('No-lease prompt was not denied')
    if (guest.debugger.isAttached()) throw new Error('Dialog debugger lease was not released')
    process.stdout.write('Electron foreign-frame dialog probe PASS: approved prompt/confirm/alert; unapproved and no-lease denied\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    window?.destroy()
    topServer?.close()
    childServer?.close()
  }
}

setTimeout(() => { process.stderr.write('foreign dialog probe timed out\n'); app.exit(124) }, 18000).unref()
void run()
