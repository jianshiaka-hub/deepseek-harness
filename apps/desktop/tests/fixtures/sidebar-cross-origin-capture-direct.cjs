/** Isolated Electron probe for exact-origin frame auditing and full-page pixels. */
const { createServer } = require('node:http')
const { app, BrowserWindow, nativeImage } = require('electron')

function embeddedPixel(base64) {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'))
  const { width, height } = image.getSize()
  if (width < 160 || height < 90) throw new Error('Capture dimensions are too small for embedded pixels')
  const bitmap = image.toBitmap()
  const pixel = (80 * width + 150) * 4
  // Electron bitmap bytes are BGRA; the frame background is #00aa88.
  if (bitmap[pixel] < 80 || bitmap[pixel] > 180 ||
    bitmap[pixel + 1] < 130 || bitmap[pixel + 2] > 60) {
    throw new Error('Approved capture omitted the cross-origin frame pixels')
  }
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function run() {
  const embedded = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<body style="background:#0a8"><button>Embedded</button></body>')
  })
  let embeddedOrigin
  const top = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<body><iframe src="${embeddedOrigin}/frame" style="width:200px;height:100px"></iframe></body>`)
  })
  let window
  try {
    await app.whenReady()
    embeddedOrigin = await listen(embedded)
    const topOrigin = await listen(top)
    const url = `${topOrigin}/page`
    window = new BrowserWindow({ show: false, width: 400, height: 300,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await window.loadURL(url)
    const guest = window.webContents
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!guest.isLoadingMainFrame() && guest.mainFrame.framesInSubtree.some(frame =>
        frame.origin === embeddedOrigin && frame.url === `${embeddedOrigin}/frame`)) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const { auditBrowserFrames, captureBrowserFullPage, captureBrowserViewport,
      readBrowserForeignText } = await import('../../lib/types/browser-full-page.js')
    const embeddedFrame = guest.mainFrame.framesInSubtree.find(frame => frame.origin === embeddedOrigin)
    if (await embeddedFrame?.executeJavaScript('document.body.innerText') !== 'Embedded') {
      throw new Error('Native frame-scoped text read unavailable')
    }
    await readBrowserForeignText(guest, url, [topOrigin]).then(
      () => { throw new Error('Foreign text read without site grant') },
      error => { if (error?.message !== 'SIDEBAR_FRAME_SITE_NOT_APPROVED') throw error })
    const foreignText = await readBrowserForeignText(guest, url, [topOrigin, embeddedOrigin])
    if (foreignText.frames.length !== 1 || foreignText.frames[0].origin !== embeddedOrigin ||
      foreignText.frames[0].text !== 'Embedded') throw new Error('Approved frame text unavailable')
    const audit = auditBrowserFrames(guest, url)
    if (JSON.stringify(audit.origins) !== JSON.stringify([topOrigin, embeddedOrigin]) ||
      !/^[a-f0-9]{64}$/.test(audit.fingerprint)) throw new Error('Frame origin audit incomplete')
    await captureBrowserFullPage(guest, url).then(
      () => { throw new Error('Foreign frame captured without its grant') },
      error => { if (error?.message !== 'SIDEBAR_FRAME_SITE_NOT_APPROVED') throw error })
    const image = await captureBrowserFullPage(guest, url, undefined, [topOrigin, embeddedOrigin])
    if (!image.base64 || image.viewport.width < 1 || image.viewport.height < 1 ||
      guest.debugger.isAttached()) throw new Error('Approved capture invalid or debugger leaked')
    embeddedPixel(image.base64)
    await captureBrowserViewport(guest, url).then(
      () => { throw new Error('Foreign viewport captured without its grant') },
      error => { if (error?.message !== 'SIDEBAR_FRAME_SITE_NOT_APPROVED') throw error })
    const viewport = await captureBrowserViewport(guest, url, undefined, [topOrigin, embeddedOrigin])
    if (!viewport.base64 || viewport.viewport.width < 1 || viewport.viewport.height < 1) {
      throw new Error('Approved viewport capture invalid')
    }
    embeddedPixel(viewport.base64)
    process.stdout.write('Electron cross-origin frame capture PASS\n')
    app.exit(0)
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n')
    app.exit(1)
  } finally {
    window?.destroy()
    top.close()
    embedded.close()
  }
}
setTimeout(() => { process.stderr.write('cross-origin frame capture timed out\n'); app.exit(124) }, 18000).unref()
void run()
