/** Run with apps/desktop/node_modules/.bin/electron apps/desktop/tests/fixtures/full-page-capture.cjs. */
const { createServer } = require('node:http')
const { readdirSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const repository = path.resolve(__dirname, '../../../..')
const store = path.join(repository, 'node_modules/.pnpm')
const tsxPackage = readdirSync(store).find(name => /^tsx@[^/]+$/.test(name))
if (!tsxPackage) throw new Error('Fixture requires the workspace tsx development dependency')
require(path.join(store, tsxPackage, 'node_modules/tsx/dist/cjs/index.cjs'))
const { captureBrowserFullPage } = require('../../src/browser-full-page.ts')

function serve(body) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  return server
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
}

function dimensions(base64) {
  const image = Buffer.from(base64, 'base64')
  if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Not a PNG')
  return [image.readUInt32BE(16), image.readUInt32BE(20)]
}

async function run() {
  const page = serve('<!doctype html><title>Full page fixture</title><style>body{margin:0}main{height:1500px;background:linear-gradient(red,blue)}</style><main>Local fixture</main><button id="button" style="position:absolute;left:20px;top:20px;width:100px;height:40px">Press</button><input id="input" style="position:absolute;left:20px;top:80px;width:100px"><script>window.__events=[];document.querySelector("#button").addEventListener("click",event=>__events.push({type:"click",trusted:event.isTrusted}));document.querySelector("#input").addEventListener("input",event=>__events.push({type:"input",trusted:event.isTrusted}));document.querySelector("#input").addEventListener("keydown",event=>__events.push({type:"key",key:event.key,control:event.ctrlKey,trusted:event.isTrusted}))</script>')
  const foreign = serve('<!doctype html><title>Foreign fixture</title>')
  let window
  try {
    await app.whenReady()
    await listen(page)
    const url = `http://127.0.0.1:${page.address().port}/`
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } })
    const attached = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)))
    await window.loadURL(`data:text/html,${encodeURIComponent(`<webview src="${url}" style="width:400px;height:300px"></webview>`)}`)
    const guest = await attached
    if (guest.getURL() !== url || guest.isLoadingMainFrame()) {
      await new Promise(resolve => guest.once('did-stop-loading', resolve))
    }
    const full = await captureBrowserFullPage(guest, url)
    if (full.url !== url || JSON.stringify(dimensions(full.base64)) !== '[400,1500]') {
      throw new Error('Full-page dimensions did not match CSS content')
    }
    const clipped = await captureBrowserFullPage(guest, url, { x: 5, y: 900, width: 100, height: 120 })
    if (JSON.stringify(dimensions(clipped.base64)) !== '[100,120]') {
      throw new Error('Clipped dimensions did not match CSS content')
    }
    await window.webContents.executeJavaScript(`(() => {
      const webview = document.querySelector('webview');
      webview.sendInputEvent({ type: 'mouseMove', x: 70, y: 40 });
      webview.sendInputEvent({ type: 'mouseDown', x: 70, y: 40, button: 'left', clickCount: 1 });
      webview.sendInputEvent({ type: 'mouseUp', x: 70, y: 40, button: 'left', clickCount: 1 });
    })()`)
    await guest.executeJavaScript('document.querySelector("#input").focus()')
    await window.webContents.executeJavaScript(`document.querySelector('webview').insertText('Ada')`)
    await window.webContents.executeJavaScript(`(async () => {
      const webview = document.querySelector('webview');
      await webview.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      await webview.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await webview.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['control'] });
      await webview.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['control'] });
    })()`)
    let events = []
    for (let attempt = 0; attempt < 20; attempt++) {
      events = await guest.executeJavaScript('window.__events')
      if (events.length >= 4) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!events.some(event => event.type === 'click' && event.trusted === true) ||
      !events.some(event => event.type === 'input' && event.trusted === true) ||
      !events.some(event => event.type === 'key' && event.key === 'Enter' && event.trusted === true) ||
      !events.some(event => event.type === 'key' && event.key === 'Enter' && event.control === true && event.trusted === true) ||
      await guest.executeJavaScript('document.querySelector("#input").value') !== 'Ada') {
      throw new Error(`Webview did not deliver trusted native click, text and key events: ${JSON.stringify(events)}`)
    }
    await guest.executeJavaScript('document.querySelector("#input").select()')
    await window.webContents.executeJavaScript(`document.querySelector('webview').insertText('Bea')`)
    if (await guest.executeJavaScript('document.querySelector("#input").value') !== 'Bea') {
      throw new Error('Webview did not replace selected input text')
    }
    await guest.executeJavaScript('document.querySelector("#input").select()')
    await window.webContents.executeJavaScript(`(async () => {
      const webview = document.querySelector('webview');
      await webview.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
      await webview.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
    })()`)
    events = await guest.executeJavaScript('window.__events')
    if (await guest.executeJavaScript('document.querySelector("#input").value') !== '' ||
      events.filter(event => event.type === 'input' && event.trusted === true).length < 3) {
      throw new Error(`Webview did not clear selected input with trusted events: ${JSON.stringify(events)}`)
    }
    await listen(foreign)
    await guest.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.onload = resolve;
      frame.src = 'http://127.0.0.1:${foreign.address().port}/'; document.body.append(frame);
    })`)
    try {
      await captureBrowserFullPage(guest, url)
      throw new Error('Foreign frame pixels were returned')
    } catch (error) {
      if (error.message !== 'SIDEBAR_FRAME_SITE_NOT_APPROVED') throw error
    }
    process.stdout.write('Electron webview fixture PASS: Retina page, clip, foreign frame, trusted click/type/key/setValue\n')
    window.destroy()
    page.close()
    foreign.close()
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    window?.destroy()
    page.close()
    foreign.close()
    app.exit(1)
  }
}

setTimeout(() => { process.stderr.write('full-page Electron fixture timed out\n'); app.exit(124) }, 18000).unref()
void run()
