/** Run with apps/desktop/node_modules/.bin/electron apps/desktop/tests/fixtures/sidebar-drag.cjs. */
const { createServer } = require('node:http')
const { readdirSync } = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const repository = path.resolve(__dirname, '../../../..')
const store = path.join(repository, 'node_modules/.pnpm')
const tsxPackage = readdirSync(store).find(name => /^tsx@[^/]+$/.test(name))
if (!tsxPackage) throw new Error('Fixture requires the workspace tsx development dependency')
require(path.join(store, tsxPackage, 'node_modules/tsx/dist/cjs/index.cjs'))
const { BrowserDragLease } = require('../../src/browser-drag.ts')

const html = `<!doctype html><title>Native drag fixture</title><style>
  body{margin:0} #source,#target{position:absolute;top:40px;width:80px;height:80px}
  #source{left:20px;background:#f66} #target{left:220px;background:#6f6}
</style><div id="source" draggable="true">Source</div><div id="target">Target</div>
<script>
  window.__events=[];
  const source=document.querySelector('#source'),target=document.querySelector('#target');
  source.addEventListener('mousedown',e=>__events.push({type:'down',trusted:e.isTrusted}));
  source.addEventListener('dragstart',e=>{e.dataTransfer.setData('text/plain','dsh-drag');
    __events.push({type:'start',trusted:e.isTrusted})});
  target.addEventListener('dragover',e=>{e.preventDefault();__events.push({type:'over',trusted:e.isTrusted})});
  target.addEventListener('drop',e=>{e.preventDefault();
    __events.push({type:'drop',trusted:e.isTrusted,data:e.dataTransfer.getData('text/plain')})});
  document.addEventListener('mouseup',e=>__events.push({type:'up',trusted:e.isTrusted}));
</script>`

const page = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(html)
})

async function run() {
  let window
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
    const dragLease = new BrowserDragLease()
    const token = await dragLease.begin(guest, url)
    await window.webContents.executeJavaScript(`(async () => {
      const webview=document.querySelector('webview');
      await webview.sendInputEvent({type:'mouseMove',x:60,y:80});
      await webview.sendInputEvent({type:'mouseDown',x:60,y:80,button:'left',clickCount:1});
      for(let step=1;step<=12;step++){
        await webview.sendInputEvent({type:'mouseMove',x:60+200*step/12,y:80,button:'left'});
        await new Promise(resolve=>setTimeout(resolve,12));
      }
      await webview.sendInputEvent({type:'mouseUp',x:260,y:80,button:'left',clickCount:1});
    })()`)
    const result = await dragLease.finish(token, url, { x: 260, y: 80 })
    if (!result.dropped) throw new Error('Chromium did not provide intercepted drag data')
    let events = []
    for (let attempt = 0; attempt < 30; attempt++) {
      events = await guest.executeJavaScript('window.__events')
      if (events.some(event => event.type === 'drop')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!events.some(event => event.type === 'down' && event.trusted) ||
      !events.some(event => event.type === 'start' && event.trusted) ||
      !events.some(event => event.type === 'drop' && event.trusted && event.data === 'dsh-drag')) {
      throw new Error(`Native webview drag did not deliver a trusted HTML drop: ${JSON.stringify(events)}`)
    }
    process.stdout.write('Electron Sidebar drag fixture PASS: trusted dragstart and drop\n')
    window.destroy()
    page.close()
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    window?.destroy()
    page.close()
    app.exit(1)
  }
}

setTimeout(() => { process.stderr.write('Sidebar drag Electron fixture timed out\n'); app.exit(124) }, 18000).unref()
void run()
