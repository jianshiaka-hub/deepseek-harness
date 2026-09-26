/** Isolated Electron webview paste and temporary clipboard round-trip fixture. */
const { createServer } = require('node:http')
const { readdirSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron')

const repository = path.resolve(__dirname, '../../../..')
const store = path.join(repository, 'node_modules/.pnpm')
const tsxPackage = readdirSync(store).find(name => /^tsx@[^/]+$/.test(name))
if (!tsxPackage) throw new Error('Fixture requires the workspace tsx development dependency')
require(path.join(store, tsxPackage, 'node_modules/tsx/dist/cjs/index.cjs'))
const { BrowserClipboardLease } = require('../../src/browser-clipboard.ts')

async function run() {
  const page = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><title>Paste fixture</title>
      <input id="input"><div id="editor" contenteditable="true"></div>
      <script>window.__events=[];window.__pasteTypes=[];
      document.addEventListener('paste',event=>{window.__pasteTypes.push([...event.clipboardData.types])},true);
      document.addEventListener('input',event=>{
        window.__events.push({target:event.target.id,trusted:event.isTrusted,type:event.inputType})
      },true)</script>`)
  })
  let window
  let token
  const lease = new BrowserClipboardLease(clipboard, entries => new ClipboardItem(entries))
  try {
    await app.whenReady()
    await new Promise(resolve => page.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${page.address().port}/`
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } })
    const attached = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, guest) => resolve(guest)))
    await window.loadURL(`data:text/html,${encodeURIComponent(`<webview src="${url}" style="width:400px;height:300px"></webview>`)}`)
    const guest = await attached
    if (guest.getURL() !== url || guest.isLoadingMainFrame()) {
      await new Promise(resolve => guest.once('did-stop-loading', resolve))
    }
    await guest.executeJavaScript('document.querySelector("#input").focus()')
    token = await lease.begin({ text: 'Ada', format: 'text' })
    await window.webContents.executeJavaScript(`document.querySelector('webview').paste()`)
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await guest.executeJavaScript('document.querySelector("#input").value') === 'Ada') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (await guest.executeJavaScript('document.querySelector("#input").value') !== 'Ada') {
      throw new Error('Native webview paste did not reach text input')
    }
    const first = await lease.finish(token)
    token = undefined
    if (!first.restored) throw new Error('Clipboard was not restored after plain paste')
    await guest.executeJavaScript('document.querySelector("#editor").focus()')
    token = await lease.begin({ text: '<b>Rich</b><i> text</i>', format: 'html', plainText: 'Rich text' })
    await window.webContents.executeJavaScript(`document.querySelector('webview').paste()`)
    for (let attempt = 0; attempt < 20; attempt++) {
      if (await guest.executeJavaScript('document.querySelector("#editor").textContent') === 'Rich text') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const editor = await guest.executeJavaScript('document.querySelector("#editor").innerHTML')
    const events = await guest.executeJavaScript('window.__events')
    const pasteTypes = await guest.executeJavaScript('window.__pasteTypes')
    if (!editor.includes('<b>Rich</b>') ||
      !events.some(event => event.target === 'input' && event.trusted) ||
      !events.some(event => event.target === 'editor' && event.trusted) ||
      pasteTypes.some(types => types.includes('web application/x-dsh-cu-lease'))) {
      throw new Error(`Native rich paste or trusted event failed: ${JSON.stringify({ editor, events, pasteTypes })}`)
    }
    const second = await lease.finish(token)
    token = undefined
    if (!second.restored) throw new Error('Clipboard was not restored after rich paste')
    process.stdout.write('Electron Sidebar paste fixture PASS: plain and rich paste, trusted input, clipboard restoration\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    if (token !== undefined) {
      try { await lease.finish(token) } catch { /* The lease may already be closed. */ }
    }
    process.exitCode = 1
    app.exit(1)
  } finally {
    window?.destroy()
    page.close()
  }
}

setTimeout(() => { process.stderr.write('sidebar paste fixture timed out\n'); app.exit(124) }, 18000).unref()
void run()
