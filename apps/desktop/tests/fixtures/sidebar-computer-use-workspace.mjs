/** Real Desktop renderer, selected webview, Host route, and Computer Use tool in one private profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow } from 'electron'

const root = process.env.DSH_SIDEBAR_CU_ROOT
const pageUrl = process.env.DSH_SIDEBAR_CU_PAGE_URL
assert.ok(root && pageUrl)
const application = join(root, 'app')
app.setAppPath(application)
app.setPath('userData', join(root, 'electron'))

async function waitFor(check, subject, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${subject}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

async function windowAt(url) {
  let found
  await waitFor(() => {
    found = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url)
    return found !== undefined
  }, `window ${url}`)
  return found
}

async function press(window, expression) {
  await waitFor(() => window.webContents.executeJavaScript(`(() => {
    const target = ${expression};
    return target && !target.disabled && target.getClientRects().length > 0;
  })()`), `button ${expression}`)
  window.focus()
  const point = await window.webContents.executeJavaScript(`(() => {
    const target = ${expression};
    const rect = target.getBoundingClientRect();
    const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    if (!target.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Test click target is obscured');
    return point;
  })()`)
  await window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  await window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  await window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
}

async function control(path, body) {
  const { url } = JSON.parse(await readFile(join(root, 'sidebar-cu-control.json'), 'utf8'))
  const response = await fetch(`${url}${path}`, { method: 'POST', headers: {
    'x-qualification-token': process.env.DSH_SIDEBAR_CU_TOKEN, 'content-type': 'application/json',
  }, body: JSON.stringify(body ?? {}) })
  assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text())
  return response.json()
}

async function qualify() {
  let window
  try {
    await import(pathToFileURL(join(application, 'lib/main.js')).href)
    await waitFor(async () => { try { await readFile(join(root, 'sidebar-cu-control.json')); return true } catch { return false } },
      'Computer Use Host control')
    window = await windowAt('dsh-app://app/')
    await waitFor(() => window.webContents.executeJavaScript(`!!document.querySelector('[class*="frame"]') && !!window.dshDesktop?.browser`),
      'Desktop workspace with Browser carrier')
    if (!window.isVisible()) {
      const welcome = await windowAt(pathToFileURL(join(application, 'renderer/welcome.html')).href)
      await press(welcome, `document.getElementById('api-key')`)
      await press(welcome, `document.getElementById('skip-key')`)
      await waitFor(() => window.isVisible(), 'workspace after welcome skip')
    }
    const notice = `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === '继续')`
    if (await window.webContents.executeJavaScript(`!!(${notice})`)) {
      await press(window, notice)
      await waitFor(() => window.webContents.executeJavaScript(`!(${notice})`), 'first-run notice dismissal')
    }
    await writeFile(join(root, 'startup.json'), JSON.stringify({ host: await control('/status'),
      buttons: await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].map(button => ({
        text: button.textContent?.trim(), label: button.getAttribute('aria-label') }))`) }, null, 2))
    await waitFor(() => window.webContents.executeJavaScript(`!!document.querySelector('button[aria-label="在“默认工作区”中新建会话"]')`),
      'default workspace to load')
    await press(window, `document.querySelector('button[aria-label="新建会话"]')`)
    await waitFor(async () => (await control('/status')).sessions.length > 0, 'new session')
    await press(window, `document.querySelector('button[aria-label="打开右侧边栏"]')`)
    const state = { host: await control('/status'), buttons: await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')].map(button => ({text: button.textContent?.trim(), label: button.getAttribute('aria-label')}))`),
      text: await window.webContents.executeJavaScript(`document.body.innerText.slice(0, 1800)`) }
    await writeFile(join(root, 'sidebar-ui-probe.json'), JSON.stringify(state, null, 2))
    console.log('sidebar qualification: UI probe written')
    await press(window, `[...document.querySelectorAll('button')].find(button =>
      button.textContent?.includes('浏览器') && button.textContent?.includes('浏览网页'))`)
    const address = `document.querySelector('input[aria-label="输入 HTTP(S) 地址"]')`
    await waitFor(() => window.webContents.executeJavaScript(`!!(${address})`), 'Browser address bar')
    await window.webContents.executeJavaScript(`(${address}).focus()`)
    await window.webContents.insertText(pageUrl)
    await waitFor(() => window.webContents.executeJavaScript(`(${address}).value === ${JSON.stringify(pageUrl)}`),
      'Browser address text')
    await press(window, `document.querySelector('button[aria-label="前往"]')`)
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].some(view => view.getURL() === ${JSON.stringify(pageUrl)})`),
      'selected Browser webview loading private page')
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].some(view => view.getURL() === ${JSON.stringify(pageUrl)} && !view.isLoading())`),
      'selected Browser webview ready')
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        ?.executeJavaScript('!!document.getElementById("inner")?.contentDocument?.getElementById("frameResult")')`),
    'same-origin Sidebar frame ready')
    await waitFor(async () => (await control('/status')).selectedTabs.some(tab =>
      tab.sessionId === state.host.sessions.at(-1) && tab.observedUrl === pageUrl),
    'Browser reporter selected-tab registration after page load', 10000)
    await writeFile(join(root, 'browser-host-state.json'), JSON.stringify({ host: await control('/status'),
      webviews: await window.webContents.executeJavaScript(`[...document.querySelectorAll('webview')].map(view => ({
        url: view.getURL(), loading: view.isLoading() }))`) }, null, 2))
    const sessionId = state.host.sessions.at(-1)
    const tool = await control('/invoke', { sessionId,
      code: `let b = await cua.getBrowser('dsh-sidebar'); let t = await b.tabs.selected(); if (!t) throw Error('MISSING_SELECTED_TAB'); return await t.getAXState({emit:false});` })
    await writeFile(join(root, 'computer-use-read.json'), JSON.stringify({ sessionId, tool }, null, 2))
    assert.equal(tool.result?.isError, false, JSON.stringify(tool.result))
    assert.equal(tool.result?.value?.ok, true, JSON.stringify(tool.result))
    assert.match(tool.result.value.result, /Isolated Computer Use/)
    const located = await control('/invoke', { sessionId,
      code: `let allCount = await t.playwright.locator('*').count(); if (allCount < 10) throw Error('CSS_COUNT_INCOMPLETE_' + allCount); return 'LOCATORS_' + [await t.playwright.getByRole('button',{name:'Click test button',exact:true}).count(),await t.playwright.locator('#generic').count(),await t.playwright.getByText('idle',{exact:true}).count(),await t.playwright.getByLabel('Name',{exact:true}).count(),await t.playwright.getByPlaceholder('Your name',{exact:true}).count(),await t.playwright.getByTestId('action').count(),await t.playwright.getByRole('button',{name:'Frame action',exact:true}).count(),await t.playwright.frameLocator('#inner').getByRole('button',{name:'Frame action',exact:true}).count(),await t.playwright.getByRole('button').filter({hasText:'Click test'}).count(),await t.playwright.getByRole('button').filter({hasNotText:'Click test'}).count(),await t.playwright.getByTestId('group-a').getByTestId('duplicate').count(),await t.playwright.getByTestId('group-b').getByText('Shared',{exact:true}).count(),await t.playwright.getByTestId('group-a').getByTestId('group-b').count(),await t.playwright.locator('#hidden').isVisible(),await t.playwright.locator('#action').isVisible(),await t.playwright.getByRole('textbox',{name:'Disabled'}).isEnabled(),await t.playwright.locator('#action').isEnabled(),await t.playwright.locator('#missing').isVisible()].join('_');` })
    await writeFile(join(root, 'computer-use-locate.json'), JSON.stringify({ sessionId, tool: located }, null, 2))
    assert.equal(located.result?.isError, false, JSON.stringify(located.result))
    assert.equal(located.result?.value?.ok, true, JSON.stringify(located.result))
    assert.match(located.result.value.result, /LOCATORS_1_1_1_1_1_1_0_1_1_0_1_1_0_false_true_false_true_false/)
    assert.equal(located.approvals.filter(approval => approval.allowed).length, 0,
      'Read-only locator queries must not consume action approval')
    const generic = await control('/invoke', { sessionId,
      code: `await t.playwright.locator('#generic').click(); return 'generic clicked';` })
    await writeFile(join(root, 'computer-use-generic-click.json'), JSON.stringify({ sessionId, tool: generic }, null, 2))
    assert.equal(generic.result?.isError, false, JSON.stringify(generic.result))
    assert.equal(generic.result?.value?.ok, true, JSON.stringify(generic.result))
    assert.equal(generic.approvals.filter(approval => approval.allowed).length, 1)
    const genericState = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("generic").getAttribute("data-state")')`)
    assert.equal(genericState, 'clicked')
    const frameClicked = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#inner').getByRole('button',{name:'Frame action',exact:true}).click(); return 'frame clicked';` })
    await writeFile(join(root, 'computer-use-frame-click.json'), JSON.stringify({ sessionId, tool: frameClicked }, null, 2))
    assert.equal(frameClicked.result?.isError, false, JSON.stringify(frameClicked.result))
    assert.equal(frameClicked.result?.value?.ok, true, JSON.stringify(frameClicked.result))
    assert.equal(frameClicked.approvals.filter(approval => approval.allowed).length, 2)
    const frameState = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("inner").contentDocument.getElementById("frameResult").textContent')`)
    assert.equal(frameState, 'frame clicked')
    const clicked = await control('/invoke', { sessionId,
      code: `await t.playwright.locator('body').locator('#action').click(); return await t.getAXState({emit:false});` })
    await writeFile(join(root, 'computer-use-click.json'), JSON.stringify({ sessionId, tool: clicked }, null, 2))
    assert.equal(clicked.result?.isError, false, JSON.stringify(clicked.result))
    assert.equal(clicked.result?.value?.ok, true, JSON.stringify(clicked.result))
    assert.match(clicked.result.value.result, /clicked/)
    assert.equal(clicked.approvals.filter(approval => approval.allowed).length, 3,
      'The real Sidebar button click must consume one one-use approval')
    const filled = await control('/invoke', { sessionId,
      code: `await t.playwright.getByLabel('Name',{exact:true}).fill('Ada'); return 'filled';` })
    await writeFile(join(root, 'computer-use-fill.json'), JSON.stringify({ sessionId, tool: filled }, null, 2))
    assert.equal(filled.result?.isError, false, JSON.stringify(filled.result))
    assert.equal(filled.result?.value?.ok, true, JSON.stringify(filled.result))
    assert.equal(filled.approvals.filter(approval => approval.allowed).length, 4,
      'Filling the selected input must consume a separate one-use approval')
    const value = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("name").value')`)
    assert.equal(value, 'Ada')
    console.log('sidebar qualification: Computer Use read result written')
    app.exit(0)
  } catch (error) {
    await writeFile(join(root, 'failure.txt'), String(error?.stack ?? error))
    if (window && !window.isDestroyed()) {
      await writeFile(join(root, 'failure-ui.json'), JSON.stringify(await window.webContents.executeJavaScript(`({
        buttons: [...document.querySelectorAll('button')].map(button => ({text: button.textContent?.trim(), label: button.getAttribute('aria-label')})),
        text: document.body.innerText.slice(0, 1800),
        address: document.querySelector('input[aria-label="输入 HTTP(S) 地址"]')?.value,
        webviews: [...document.querySelectorAll('webview')].map(view => ({url:view.getURL(),loading:view.isLoading()}))
      })`), null, 2))
    }
    throw error
  }
}

void qualify().catch(error => { console.error(error); app.exit(1) })
