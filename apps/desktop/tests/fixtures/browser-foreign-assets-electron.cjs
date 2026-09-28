const { createServer } = require('node:http')
const { randomUUID } = require('node:crypto')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')

app.setPath('userData', process.argv[2])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const serve = handler => new Promise(resolve => {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = server => `http://127.0.0.1:${server.address().port}`

let root, topServer, childServer, assetServer
let completed = false
let exitCode = 0
const timeout = setTimeout(() => {
  if (!completed) {
    process.stderr.write('Electron asset probe timed out\n')
    process.exit(124)
  }
}, 30000)

;(async () => {
  try {
    await app.whenReady()
    assetServer = await serve((_req, response) => {
      response.writeHead(200, {
        'content-type':'image/png',
        'access-control-allow-origin':'*',
      })
      response.end('foreign-image-bytes')
    })
    const assetUrl = `${origin(assetServer)}/foreign.png`
    childServer = await serve((_req, response) => {
      response.writeHead(200, {'content-type':'text/html'})
      response.end(`<!doctype html><title>foreign</title><button><img alt="Save" src="${assetUrl}"></button>`)
    })
    const childUrl = `${origin(childServer)}/widget`
    topServer = await serve((request, response) => {
      if (request.url === '/top.png') {
        response.writeHead(200, {'content-type':'image/png'})
        response.end('top-image-bytes')
      } else {
        response.writeHead(200, {'content-type':'text/html'})
        response.end(`<!doctype html><title>top</title><img src="/top.png"><iframe src="${childUrl}"></iframe>`)
      }
    })
    const topUrl = `${origin(topServer)}/page`
    const frameOrigins = [origin(topServer), origin(childServer)]
    const module = await import(pathToFileURL(join(__dirname,
      '../../lib/types/browser-foreign-assets.js')).href)
    const readModule = await import(pathToFileURL(join(__dirname,
      '../../lib/types/browser-foreign-read.js')).href)
    root = new BrowserWindow({ show:false,width:600,height:500,
      webPreferences:{ webviewTag:true,contextIsolation:true,sandbox:true } })
    const attached = new Promise(resolve => {
      root.webContents.once('did-attach-webview', (_event, guest) => resolve(guest))
    })
    await root.loadURL(`data:text/html,${encodeURIComponent(
      `<webview src="${topUrl}" style="width:600px;height:500px"></webview>`)}`)
    const guest = await attached
    let child
    for (let attempt=0; attempt<100; attempt++) {
      child = guest.mainFrame.framesInSubtree.find(frame => frame.url === childUrl)
      if (guest.getURL() === topUrl && !guest.isLoadingMainFrame() && child &&
        await child.executeJavaScript('document.readyState') === 'complete') break
      await sleep(50)
    }
    if (!child) throw Error('Foreign frame did not load')
    const marker = randomUUID()
    let denied = false
    try { await module.listBrowserFrameAssets(guest, topUrl, [frameOrigins[0]], marker) }
    catch (error) { denied = String(error).includes('SIDEBAR_FRAME_SITE_NOT_APPROVED') }
    if (!denied) throw Error('Foreign frame read was not denied before its grant')
    const inventory = await module.listBrowserFrameAssets(guest, topUrl, frameOrigins, marker)
    const asset = inventory.assets.find(row => row.url === assetUrl)
    if (!asset || inventory.frames[asset.frameIndex].origin !== frameOrigins[1]) {
      throw Error('Foreign-frame asset missing from inventory')
    }
    let targetDenied = false
    try { await module.fetchBrowserFrameAsset(guest,topUrl,frameOrigins,
      origin(topServer),marker,asset.id) }
    catch (error) { targetDenied = String(error).includes('SIDEBAR_ASSET_SITE_NOT_APPROVED') }
    if (!targetDenied) throw Error('Asset fetch did not require its own origin grant')
    const bytes = await module.fetchBrowserFrameAsset(guest,topUrl,frameOrigins,
      origin(assetServer),marker,asset.id)
    if (Buffer.from(bytes.base64,'base64').toString() !== 'foreign-image-bytes') {
      throw Error('Wrong foreign resource bytes')
    }
    const foreignText = await readModule.readBrowserForeignText(guest,topUrl,frameOrigins)
    const foreignButtonName = foreignText.frames.some(frame =>
      frame.origin === frameOrigins[1] && frame.roles.includes('- button "Save"'))
    if (!foreignButtonName) throw Error('Foreign image button lost its accessible name')
    await child.executeJavaScript('location.reload()')
    let stale = false
    for (let attempt=0; attempt<40; attempt++) {
      try { await module.checkBrowserFrameAssets(guest,topUrl,frameOrigins,marker) }
      catch (error) {
        if (String(error).includes('STALE_ASSET_INVENTORY')) { stale = true; break }
      }
      await sleep(25)
    }
    if (!stale) throw Error('Inventory survived foreign-frame navigation')
    process.stdout.write(JSON.stringify({
      electron:process.versions.electron,
      origins:frameOrigins,
      frameCount:inventory.frames.length,
      assetCount:inventory.assets.length,
      foreignAssetId:asset.id,
      assetBytes:bytes.size,
      deniedBeforeGrant:denied,
      deniedWithoutAssetGrant:targetDenied,
      foreignButtonName,
      staleAfterForeignReload:stale,
    })+'\n')
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error)+'\n')
    exitCode = 1
  } finally {
    completed = true
    clearTimeout(timeout)
    root?.destroy()
    await Promise.all([topServer,childServer,assetServer].filter(Boolean).map(server =>
      new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })))
    app.exit(exitCode)
  }
})()
