/** Real Desktop renderer, selected webview, Host route, and Computer Use tool in one private profile. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, webContents } from 'electron'

const root = process.env.DSH_SIDEBAR_CU_ROOT
const pageUrl = process.env.DSH_SIDEBAR_CU_PAGE_URL
const destinationUrl = process.env.DSH_SIDEBAR_CU_DESTINATION_URL
assert.ok(root && pageUrl && destinationUrl)
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
    const attribute = await control('/invoke', { sessionId,
      code: `return 'ATTR_' + [await t.playwright.getByAltText('logo').count(),await t.playwright.getByAltText('Playwright logo',{exact:true}).count(),await t.playwright.getByAltText('playwright logo',{exact:true}).count(),await t.playwright.getByRole('img',{name:'Playwright logo',exact:true}).count(),await t.playwright.getByTitle('Issues').count(),await t.playwright.getByTitle('Issues count',{exact:true}).count(),await t.playwright.getByTitle('issues count',{exact:true}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-attribute-locate.json'), JSON.stringify({ sessionId, tool: attribute }, null, 2))
    assert.equal(attribute.result?.isError, false, JSON.stringify(attribute.result))
    assert.equal(attribute.result?.value?.ok, true, JSON.stringify(attribute.result))
    assert.match(attribute.result.value.result, /ATTR_1_1_0_1_1_1_0/)
    assert.equal(attribute.approvals.filter(approval => approval.allowed).length, 0)
    const accessibleFixture = '<label for="account">Account name</label><input id="account">' +
      '<span id="action-word">Action</span><span id="detail-word">details</span>' +
      '<button aria-labelledby="action-word detail-word" aria-label="Wrong name">X</button>' +
      '<label><input type="checkbox">Subscribe</label>' +
      '<button><img alt="Search"></button><input type="submit" value="Send form">'
    const appendAccessibleFixture = `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(accessibleFixture)})`
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript(${JSON.stringify(appendAccessibleFixture)})`)
    const accessible = await control('/invoke', { sessionId,
      code: `return 'A11Y_' + [await t.playwright.getByRole('textbox',{name:'Account name',exact:true}).count(),await t.playwright.getByRole('button',{name:'Action details',exact:true}).count(),await t.playwright.getByRole('button',{name:'Wrong name',exact:true}).count(),await t.playwright.getByRole('checkbox',{name:'Subscribe',exact:true}).count(),await t.playwright.getByRole('button',{name:'Search',exact:true}).count(),await t.playwright.getByRole('button',{name:'Send form',exact:true}).count(),await t.playwright.getByLabel('Account name',{exact:true}).count(),await t.playwright.getByLabel('Wrong name',{exact:true}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-accessible-name-locate.json'), JSON.stringify({ sessionId, tool: accessible }, null, 2))
    assert.equal(accessible.result?.isError, false, JSON.stringify(accessible.result))
    assert.equal(accessible.result?.value?.ok, true, JSON.stringify(accessible.result))
    assert.match(accessible.result.value.result, /A11Y_1_1_0_1_1_1_1_0/)
    assert.equal(accessible.approvals.filter(approval => approval.allowed).length, 0)
    const visible = await control('/invoke', { sessionId,
      code: `return 'VISIBILITY_' + [await t.playwright.locator('#hidden').filter({visible:false}).count(),await t.playwright.locator('#hidden').filter({visible:true}).count(),await t.playwright.locator('#action').filter({visible:true}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-visible-filter.json'), JSON.stringify({ sessionId, tool: visible }, null, 2))
    assert.equal(visible.result?.isError, false, JSON.stringify(visible.result))
    assert.match(visible.result?.value?.result ?? '', /VISIBILITY_1_0_1/)
    assert.equal(visible.approvals.filter(approval => approval.allowed).length, 0)
    const combined = await control('/invoke', { sessionId,
      code: `return 'COMPOSE_' + [await t.playwright.getByRole('button',{name:'Click test button',exact:true}).and(t.playwright.locator('#action')).count(),await t.playwright.locator('#action').and(t.playwright.locator('#generic')).count(),await t.playwright.locator('#action').or(t.playwright.locator('#generic')).count(),await t.playwright.locator('#action').or(t.playwright.locator('#action')).count(),await t.playwright.frameLocator('#inner').getByRole('button',{name:'Frame action',exact:true}).and(t.playwright.frameLocator('#inner').locator('button')).count()].join('_');` })
    await writeFile(join(root, 'computer-use-combined-locator.json'), JSON.stringify({ sessionId, tool: combined }, null, 2))
    assert.equal(combined.result?.isError, false, JSON.stringify(combined.result))
    assert.match(combined.result?.value?.result ?? '', /COMPOSE_1_0_2_1_1/)
    assert.equal(combined.approvals.filter(approval => approval.allowed).length, 0)
    const relative = await control('/invoke', { sessionId,
      code: `let section = t.playwright.getByTestId('group-a'); let inner = t.playwright.getByTestId('duplicate'); return 'RELATIVE_' + [await section.filter({has:inner}).count(),await section.filter({hasNot:inner}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-relative-locate.json'), JSON.stringify({ sessionId, tool: relative }, null, 2))
    assert.equal(relative.result?.isError, false, JSON.stringify(relative.result))
    assert.equal(relative.result?.value?.ok, true, JSON.stringify(relative.result))
    assert.match(relative.result.value.result, /RELATIVE_1_0/)
    assert.equal(relative.approvals.filter(approval => approval.allowed).length, 0)
    const regexpLocate = await control('/invoke', { sessionId,
      code: `return 'REGEXP_' + [await t.playwright.getByRole('button',{name:/^click test button$/i}).count(),await t.playwright.getByText(/^Shared$/).count(),await t.playwright.getByPlaceholder(/^your name$/i).count(),await t.playwright.getByTestId(/^group-[ab]$/).count(),await t.playwright.getByTestId('group-a').filter({hasText:/^Shared$/}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-regexp-locator.json'),
      JSON.stringify({ sessionId, tool: regexpLocate }, null, 2))
    assert.equal(regexpLocate.result?.value?.ok, true, JSON.stringify(regexpLocate.result))
    assert.match(regexpLocate.result.value.result, /REGEXP_1_2_1_2_1/)
    assert.equal(regexpLocate.approvals.filter(approval => approval.allowed).length, 0)
    const nestedRelative = await control('/invoke', { sessionId,
      code: `let chain = t.playwright.locator('.inner').filter({hasText:'Shared'}).getByTestId('duplicate'); return 'NESTED_RELATIVE_' + [await t.playwright.getByTestId('group-a').filter({has:chain}).count(),await t.playwright.getByTestId('group-b').filter({has:chain}).count(),await t.playwright.getByTestId('group-b').filter({hasNot:chain}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-nested-relative-locate.json'), JSON.stringify({ sessionId, tool: nestedRelative }, null, 2))
    assert.equal(nestedRelative.result?.isError, false, JSON.stringify(nestedRelative.result))
    assert.equal(nestedRelative.result?.value?.ok, true, JSON.stringify(nestedRelative.result))
    assert.match(nestedRelative.result.value.result, /NESTED_RELATIVE_1_0_1/)
    assert.equal(nestedRelative.approvals.filter(approval => approval.allowed).length, 0)
    const twiceNested = await control('/invoke', { sessionId,
      code: `let nestedInner = t.playwright.locator('.inner').filter({has:t.playwright.getByTestId('duplicate')}); return 'TWICE_NESTED_' + [await t.playwright.getByTestId('group-a').filter({has:nestedInner}).count(),await t.playwright.getByTestId('group-b').filter({has:nestedInner}).count(),await t.playwright.getByTestId('group-b').filter({hasNot:nestedInner}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-twice-nested-relative-locate.json'),
      JSON.stringify({ sessionId, tool: twiceNested }, null, 2))
    assert.equal(twiceNested.result?.value?.ok, true, JSON.stringify(twiceNested.result))
    assert.match(twiceNested.result.value.result, /TWICE_NESTED_1_0_1/)
    assert.equal(twiceNested.approvals.filter(approval => approval.allowed).length, 0)
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
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.body.insertAdjacentHTML("beforeend","<p id=literal>literal [ref=fake]</p>")')`)
    const elementText = await control('/invoke', { sessionId,
      code: `let visibleText = await t.playwright.locator('#result').innerText(); let frameText = await t.playwright.frameLocator('#inner').getByRole('button',{name:'Frame action',exact:true}).innerText(); let literalText = await t.playwright.locator('#literal').innerText(); let hiddenRejected = false; try { await t.playwright.locator('#hidden').innerText(); } catch { hiddenRejected = true; } return 'ELEMENT_TEXT_' + visibleText + '_' + frameText + '_' + literalText + '_' + hiddenRejected;` })
    await writeFile(join(root, 'computer-use-element-text.json'), JSON.stringify({ sessionId, tool: elementText }, null, 2))
    assert.equal(elementText.result?.value?.ok, true, JSON.stringify(elementText.result))
    assert.match(elementText.result.value.result, /ELEMENT_TEXT_clicked_Frame action_literal \[ref=fake\]_true/)
    assert.equal(elementText.approvals.filter(approval => approval.allowed).length, 3)
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
    const selectedColor = await control('/invoke', { sessionId,
      code: `return 'SELECTED_' + (await t.playwright.getByLabel('Color',{exact:true}).selectOption('blue')).join('_');` })
    await writeFile(join(root, 'computer-use-select-option.json'), JSON.stringify({ sessionId, tool: selectedColor }, null, 2))
    assert.equal(selectedColor.result?.value?.ok, true, JSON.stringify(selectedColor.result))
    assert.match(selectedColor.result.value.result, /SELECTED_blue/)
    assert.equal(selectedColor.approvals.filter(approval => approval.allowed).length, 5)
    const selectedColors = await control('/invoke', { sessionId,
      code: `return 'MULTI_' + (await t.playwright.getByLabel('Colors',{exact:true}).selectOption([{label:'Red'},{value:'blue'}])).join('_');` })
    await writeFile(join(root, 'computer-use-select-options.json'), JSON.stringify({ sessionId, tool: selectedColors }, null, 2))
    assert.equal(selectedColors.result?.value?.ok, true, JSON.stringify(selectedColors.result))
    assert.match(selectedColors.result.value.result, /MULTI_red_blue/)
    assert.equal(selectedColors.approvals.filter(approval => approval.allowed).length, 6)
    const clearedColors = await control('/invoke', { sessionId,
      code: `return 'CLEARED_' + (await t.playwright.getByLabel('Colors',{exact:true}).selectOption([])).length;` })
    await writeFile(join(root, 'computer-use-clear-options.json'), JSON.stringify({ sessionId, tool: clearedColors }, null, 2))
    assert.equal(clearedColors.result?.value?.ok, true, JSON.stringify(clearedColors.result))
    assert.match(clearedColors.result.value.result, /CLEARED_0/)
    assert.equal(clearedColors.approvals.filter(approval => approval.allowed).length, 7)
    const selectState = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('({color:document.getElementById("selectedColor").textContent,colors:document.getElementById("selectedColors").textContent})')`)
    assert.deepEqual(selectState,{color:'blue',colors:''})
    const checked = await control('/invoke', { sessionId,
      code: `let agree = t.playwright.getByRole('checkbox',{name:'Agree'}); if (await agree.isChecked()) throw Error('ALREADY_CHECKED'); await agree.check(); await agree.check(); return await agree.isChecked();` })
    await writeFile(join(root, 'computer-use-check.json'), JSON.stringify({ sessionId, tool: checked }, null, 2))
    assert.equal(checked.result?.value?.ok, true, JSON.stringify(checked.result))
    assert.match(checked.result.value.result, /返回值：true/)
    assert.equal(checked.approvals.filter(approval => approval.allowed).length, 8)
    const unchecked = await control('/invoke', { sessionId,
      code: `await agree.uncheck(); return await agree.isChecked();` })
    await writeFile(join(root, 'computer-use-uncheck.json'), JSON.stringify({ sessionId, tool: unchecked }, null, 2))
    assert.equal(unchecked.result?.value?.ok, true, JSON.stringify(unchecked.result))
    assert.match(unchecked.result.value.result, /返回值：false/)
    assert.equal(unchecked.approvals.filter(approval => approval.allowed).length, 9)
    const scrolled = await control('/invoke', { sessionId,
      code: `await t.getAXState({emit:false}); await t.scroll(1,'down',1); return 'scrolled';` })
    await writeFile(join(root, 'computer-use-scroll.json'), JSON.stringify({ sessionId, tool: scrolled }, null, 2))
    assert.equal(scrolled.result?.isError, false, JSON.stringify(scrolled.result))
    assert.equal(scrolled.result?.value?.ok, true, JSON.stringify(scrolled.result))
    assert.equal(scrolled.approvals.filter(approval => approval.allowed).length, 9)
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('window.scrollY > 0')`), 'selected Browser page scroll', 5000)
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('window.__sequentialEvents=[]; for(const type of ["keydown","input"]) document.getElementById("name").addEventListener(type,event=>window.__sequentialEvents.push({type,data:event.data??null,key:event.key??null,trusted:event.isTrusted}))')`)
    const sequential = await control('/invoke', { sessionId,
      code: `await t.playwright.getByLabel('Name',{exact:true}).pressSequentially('A你😀'); return 'SEQUENTIAL';` })
    await writeFile(join(root, 'computer-use-sequential.json'), JSON.stringify({ sessionId, tool: sequential }, null, 2))
    assert.equal(sequential.result?.value?.ok, true, JSON.stringify(sequential.result))
    assert.match(sequential.result.value.result, /SEQUENTIAL/)
    assert.equal(sequential.approvals.filter(approval => approval.allowed).length, 10)
    const sequentialState = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('({value:document.getElementById("name").value,events:window.__sequentialEvents})')`)
    assert.equal(sequentialState.value, 'AdaA你😀')
    assert.deepEqual(sequentialState.events.filter(event => event.type === 'input').map(event => event.data), ['A','你','😀'])
    assert.equal(sequentialState.events.filter(event => event.type === 'keydown' && event.trusted).length, 3)
    assert.ok(sequentialState.events.every(event => event.trusted))
    const framePromptSetup = `(() => {
      const child = document.getElementById('inner').contentDocument;
      const button = child.createElement('button');
      button.id = 'framePrompt';
      button.textContent = 'Frame prompt';
      button.addEventListener('click', () => {
        child.getElementById('frameResult').textContent =
          child.defaultView.prompt('Frame question', 'default') ?? 'dismissed';
      });
      child.body.append(button);
    })()`
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript(${JSON.stringify(framePromptSetup)})`)
    const framePrompt = await control('/invoke', { sessionId,
      code: `let clickedPrompt = await t.playwright.frameLocator('#inner').getByRole('button',{name:'Frame prompt',exact:true}).click(); let frameDialog = await t.getJsDialog(); if(frameDialog?.type !== 'prompt') return 'FRAME_PROMPT_MISSING_' + JSON.stringify(clickedPrompt); await frameDialog.accept('answered'); return 'FRAME_PROMPT_OK';` })
    await writeFile(join(root, 'computer-use-frame-prompt.json'),
      JSON.stringify({ sessionId, tool: framePrompt }, null, 2))
    assert.equal(framePrompt.result?.isError, false, JSON.stringify(framePrompt.result))
    assert.equal(framePrompt.result?.value?.ok, true, JSON.stringify(framePrompt.result))
    assert.match(framePrompt.result.value.result, /FRAME_PROMPT_OK/)
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("inner").contentDocument.getElementById("frameResult").textContent === "answered"')`),
    'same-origin Sidebar frame prompt answer')
    await writeFile(join(root, 'computer-use-frame-prompt-state.json'), JSON.stringify({ answered: true }))
    const frameDialogSetup = `(() => {
      const child = document.getElementById('inner').contentDocument;
      const confirmButton = child.createElement('button');
      confirmButton.id = 'frameConfirmAction';
      confirmButton.textContent = 'Frame confirm';
      confirmButton.addEventListener('click', () => {
        child.body.dataset.frameConfirmAnswer = String(child.defaultView.confirm('Private frame confirm'));
      });
      const alertButton = child.createElement('button');
      alertButton.id = 'frameAlertAction';
      alertButton.textContent = 'Frame alert';
      alertButton.addEventListener('click', () => {
        child.defaultView.alert('Private frame alert'); child.body.dataset.frameAlertDone = 'true';
      });
      child.body.prepend(confirmButton, alertButton);
    })()`
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript(${JSON.stringify(frameDialogSetup)})`)
    const frameConfirm = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#inner').getByRole('button',{name:'Frame confirm',exact:true}).click(); let frameConfirmDialog = await t.getJsDialog(); if(frameConfirmDialog?.type !== 'confirm') throw Error('FRAME_CONFIRM_MISSING'); await frameConfirmDialog.accept(); return 'FRAME_CONFIRM_OK';` })
    await writeFile(join(root, 'computer-use-frame-confirm.json'),
      JSON.stringify({ sessionId, tool: frameConfirm }, null, 2))
    assert.equal(frameConfirm.result?.value?.ok, true, JSON.stringify(frameConfirm.result))
    assert.match(frameConfirm.result.value.result, /FRAME_CONFIRM_OK/)
    assert.equal(frameConfirm.approvals.filter(approval => approval.allowed).length,
      framePrompt.approvals.filter(approval => approval.allowed).length + 2,
      'Same-origin frame confirm click and answer each require one-use confirmation')
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("inner").contentDocument.body.dataset.frameConfirmAnswer === "true"')`),
    'same-origin frame confirm answer')
    const frameAlert = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#inner').getByRole('button',{name:'Frame alert',exact:true}).click(); let frameAlertDialog = await t.getJsDialog(); if(frameAlertDialog?.type !== 'alert') throw Error('FRAME_ALERT_MISSING'); await frameAlertDialog.dismiss(); return 'FRAME_ALERT_OK';` })
    await writeFile(join(root, 'computer-use-frame-alert.json'),
      JSON.stringify({ sessionId, tool: frameAlert }, null, 2))
    assert.equal(frameAlert.result?.value?.ok, true, JSON.stringify(frameAlert.result))
    assert.match(frameAlert.result.value.result, /FRAME_ALERT_OK/)
    assert.equal(frameAlert.approvals.filter(approval => approval.allowed).length,
      frameConfirm.approvals.filter(approval => approval.allowed).length + 2,
      'Same-origin frame alert click and dismissal each require one-use confirmation')
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("inner").contentDocument.body.dataset.frameAlertDone === "true"')`),
    'same-origin frame alert dismissal')
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("inner").contentDocument.getElementById("frameConfirmAction").remove();document.getElementById("inner").contentDocument.getElementById("frameAlertAction").remove()')`)
    const topDialogSetup = `(() => {
      window.scrollTo(0,0);
      const confirmButton = document.createElement('button');
      confirmButton.id = 'topConfirmAction';
      confirmButton.textContent = 'Top confirm';
      confirmButton.addEventListener('click', () => {
        document.body.dataset.topConfirmAnswer = String(confirm('Private confirm text'));
      });
      const alertButton = document.createElement('button');
      alertButton.id = 'topAlertAction';
      alertButton.textContent = 'Top alert';
      alertButton.addEventListener('click', () => {
        alert('Private alert text'); document.body.dataset.topAlertDone = 'true';
      });
      document.body.prepend(confirmButton, alertButton);
    })()`
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript(${JSON.stringify(topDialogSetup)})`)
    const topConfirm = await control('/invoke', { sessionId,
      code: `await t.playwright.getByRole('button',{name:'Top confirm',exact:true}).click(); let topConfirmDialog = await t.getJsDialog(); if(topConfirmDialog?.type !== 'confirm') throw Error('TOP_CONFIRM_MISSING'); await topConfirmDialog.accept(); return 'TOP_CONFIRM_OK';` })
    await writeFile(join(root, 'computer-use-top-confirm.json'), JSON.stringify({ sessionId, tool: topConfirm }, null, 2))
    assert.equal(topConfirm.result?.value?.ok, true, JSON.stringify(topConfirm.result))
    assert.match(topConfirm.result.value.result, /TOP_CONFIRM_OK/)
    assert.equal(topConfirm.approvals.filter(approval => approval.allowed).length,
      frameAlert.approvals.filter(approval => approval.allowed).length + 2,
      'Top-level confirm click and answer each require one-use confirmation')
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.body.dataset.topConfirmAnswer === "true"')`), 'top-level confirm answer')
    const topAlert = await control('/invoke', { sessionId,
      code: `await t.playwright.getByRole('button',{name:'Top alert',exact:true}).click(); let topAlertDialog = await t.getJsDialog(); if(topAlertDialog?.type !== 'alert') throw Error('TOP_ALERT_MISSING'); await topAlertDialog.dismiss(); return 'TOP_ALERT_OK';` })
    await writeFile(join(root, 'computer-use-top-alert.json'), JSON.stringify({ sessionId, tool: topAlert }, null, 2))
    assert.equal(topAlert.result?.value?.ok, true, JSON.stringify(topAlert.result))
    assert.match(topAlert.result.value.result, /TOP_ALERT_OK/)
    assert.equal(topAlert.approvals.filter(approval => approval.allowed).length,
      topConfirm.approvals.filter(approval => approval.allowed).length + 2,
      'Top-level alert click and dismissal each require one-use confirmation')
    await waitFor(() => window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.body.dataset.topAlertDone === "true"')`), 'top-level alert dismissal')
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(pageUrl)})
        .executeJavaScript('document.getElementById("topConfirmAction").remove();document.getElementById("topAlertAction").remove()')`)
    const crossUrl = new URL('/cross-origin', pageUrl).href
    await window.webContents.executeJavaScript(`(${address}).focus(); (${address}).select()`)
    await window.webContents.insertText(crossUrl)
    await waitFor(() => window.webContents.executeJavaScript(`(${address}).value === ${JSON.stringify(crossUrl)}`),
      'Cross-origin page address')
    await press(window, `document.querySelector('button[aria-label="前往"]')`)
    await waitFor(() => window.webContents.executeJavaScript(`(() => {
      const view = [...document.querySelectorAll('webview')].find(view =>
        view.getURL() === ${JSON.stringify(crossUrl)} && !view.isLoading());
      return view ? view.executeJavaScript('document.body.dataset.embeddedReady === "yes"') : false;
    })()`),
    'cross-origin Sidebar frame ready')
    await waitFor(async () => (await control('/status')).selectedTabs.some(tab =>
      tab.sessionId === sessionId && tab.observedUrl === crossUrl && tab.controllerAvailable),
    'cross-origin Sidebar reporter registration', 10000)
    const crossText = await control('/invoke', { sessionId,
      code: `t = await b.tabs.selected(); let foreignState = await t.getAXState({emit:false}); if(!foreignState.includes('[Approved frame http://127.0.0.1:') || !foreignState.includes('Cross-origin frame') || !foreignState.includes('[Frame roles]\\n- button "Cross-origin frame"')) throw Error('FOREIGN_FRAME_ROLES_MISSING'); return 'FOREIGN_ROLES_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-text.json'),
      JSON.stringify({ sessionId, tool: crossText }, null, 2))
    assert.equal(crossText.result?.isError, false, JSON.stringify(crossText.result))
    assert.equal(crossText.result?.value?.ok, true, JSON.stringify(crossText.result))
    assert.match(crossText.result.value.result, /FOREIGN_ROLES_OK/)
    const crossLocate = await control('/invoke', { sessionId,
      code: `let frame = t.playwright.frameLocator('#foreign'); let button = frame.getByRole('button',{name:'Cross-origin frame',exact:true}); let count = await button.count(); let label = await button.innerText(); let checked = await frame.getByRole('checkbox',{name:'Foreign flag',exact:true}).isChecked(); if(count !== 1 || label !== 'Cross-origin frame' || !await button.isVisible() || !await button.isEnabled() || checked) throw Error('FOREIGN_LOCATOR_MISSING_' + count + '_' + label); return 'FOREIGN_LOCATOR_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-locator.json'),
      JSON.stringify({ sessionId, tool: crossLocate }, null, 2))
    assert.equal(crossLocate.result?.isError, false, JSON.stringify(crossLocate.result))
    assert.equal(crossLocate.result?.value?.ok, true, JSON.stringify(crossLocate.result))
    assert.match(crossLocate.result.value.result, /FOREIGN_LOCATOR_OK/)
    const foreignRegexp = await control('/invoke', { sessionId,
      code: `let foreign = t.playwright.frameLocator('#foreign'); return 'FOREIGN_REGEXP_' + [await foreign.getByRole('button',{name:/^cross-origin frame$/i}).count(),await foreign.getByText(/^foreign idle$/i).count()].join('_');` })
    await writeFile(join(root, 'computer-use-cross-origin-regexp-locator.json'),
      JSON.stringify({ sessionId, tool: foreignRegexp }, null, 2))
    assert.equal(foreignRegexp.result?.value?.ok, true, JSON.stringify(foreignRegexp.result))
    assert.match(foreignRegexp.result.value.result, /FOREIGN_REGEXP_1_1/)
    assert.equal(foreignRegexp.approvals.filter(approval => approval.allowed).length,
      crossLocate.approvals.filter(approval => approval.allowed).length)
    const crossFill = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign name',exact:true}).fill('Ada'); return 'FOREIGN_FILL_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-fill.json'),
      JSON.stringify({ sessionId, tool: crossFill }, null, 2))
    assert.equal(crossFill.result?.isError, false, JSON.stringify(crossFill.result))
    assert.equal(crossFill.result?.value?.ok, true, JSON.stringify(crossFill.result))
    assert.match(crossFill.result.value.result, /FOREIGN_FILL_OK/)
    assert.equal(crossFill.approvals.filter(approval => approval.allowed).length,
      crossLocate.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame fill needs one-use action confirmation')
    const foreignGuest = webContents.getAllWebContents().find(contents => contents.getURL() === crossUrl)
    assert.ok(foreignGuest, 'selected foreign-frame guest should remain mounted')
    const foreignFrame = foreignGuest.mainFrame.framesInSubtree.find(frame => frame !== foreignGuest.mainFrame)
    assert.ok(foreignFrame, 'approved foreign frame should still exist')
    assert.equal(await foreignFrame.executeJavaScript('document.querySelector("input[aria-label=\\"Foreign name\\"]").value'),
      'Ada', 'native input should update the actual foreign document')
    await foreignFrame.executeJavaScript(`(() => {
      const button = document.createElement('button');
      button.textContent = 'Foreign prompt';
      button.addEventListener('click', () => {
        document.getElementById('foreignPromptResult').textContent =
          prompt('Foreign question', 'seed') ?? 'dismissed';
      });
      const result = document.createElement('p');
      result.id = 'foreignPromptResult';
      result.textContent = 'idle';
      document.body.append(button, result);
    })()`)
    const foreignPrompt = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Foreign prompt',exact:true}).click(); let foreignDialog = await t.getJsDialog(); if(foreignDialog?.type !== 'prompt') throw Error('FOREIGN_PROMPT_MISSING'); await foreignDialog.accept('answered foreign'); return 'FOREIGN_PROMPT_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-prompt.json'),
      JSON.stringify({ sessionId, tool: foreignPrompt }, null, 2))
    assert.equal(foreignPrompt.result?.isError, false, JSON.stringify(foreignPrompt.result))
    assert.equal(foreignPrompt.result?.value?.ok, true, JSON.stringify(foreignPrompt.result))
    assert.match(foreignPrompt.result.value.result, /FOREIGN_PROMPT_OK/)
    assert.equal(foreignPrompt.approvals.filter(approval => approval.allowed).length,
      crossFill.approvals.filter(approval => approval.allowed).length + 2,
      'Foreign-frame click and prompt response each need one-use confirmation')
    await waitFor(() => foreignFrame.executeJavaScript(
      'document.getElementById("foreignPromptResult").textContent === "answered foreign"'),
    'approved foreign frame prompt answer')
    await foreignFrame.executeJavaScript(`(() => {
      const confirmButton = document.createElement('button');
      confirmButton.id = 'foreignConfirmAction';
      confirmButton.textContent = 'Foreign confirm';
      confirmButton.addEventListener('click', () => {
        document.body.dataset.foreignConfirmAnswer = String(confirm('Private confirm text'));
      });
      const alertButton = document.createElement('button');
      alertButton.id = 'foreignAlertAction';
      alertButton.textContent = 'Foreign alert';
      alertButton.addEventListener('click', () => {
        alert('Private alert text'); document.body.dataset.foreignAlertAnswer = 'closed';
      });
      document.body.prepend(confirmButton, alertButton);
    })()`)
    const foreignConfirm = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Foreign confirm',exact:true}).click(); let confirmDialog = await t.getJsDialog(); if(confirmDialog?.type !== 'confirm') throw Error('FOREIGN_CONFIRM_MISSING'); await confirmDialog.accept(); return 'FOREIGN_CONFIRM_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-confirm.json'),
      JSON.stringify({ sessionId, tool: foreignConfirm }, null, 2))
    assert.equal(foreignConfirm.result?.value?.ok, true, JSON.stringify(foreignConfirm.result))
    assert.match(foreignConfirm.result.value.result, /FOREIGN_CONFIRM_OK/)
    assert.equal(foreignConfirm.approvals.filter(approval => approval.allowed).length,
      foreignPrompt.approvals.filter(approval => approval.allowed).length + 2,
      'Foreign confirm click and answer each need one-use confirmation')
    await waitFor(() => foreignFrame.executeJavaScript(
      'document.body.dataset.foreignConfirmAnswer === "true"'),
    'approved foreign frame confirm answer')
    const foreignAlert = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Foreign alert',exact:true}).click(); let alertDialog = await t.getJsDialog(); if(alertDialog?.type !== 'alert') throw Error('FOREIGN_ALERT_MISSING'); await alertDialog.dismiss(); return 'FOREIGN_ALERT_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-alert.json'),
      JSON.stringify({ sessionId, tool: foreignAlert }, null, 2))
    assert.equal(foreignAlert.result?.value?.ok, true, JSON.stringify(foreignAlert.result))
    assert.match(foreignAlert.result.value.result, /FOREIGN_ALERT_OK/)
    assert.equal(foreignAlert.approvals.filter(approval => approval.allowed).length,
      foreignConfirm.approvals.filter(approval => approval.allowed).length + 2,
      'Foreign alert click and dismissal each need one-use confirmation')
    await waitFor(() => foreignFrame.executeJavaScript(
      'document.body.dataset.foreignAlertAnswer === "closed"'),
    'approved foreign frame alert dismissal')
    await foreignFrame.executeJavaScript(`(() => {
      document.getElementById('foreignConfirmAction').remove();
      document.getElementById('foreignAlertAction').remove();
    })()`)
    await foreignFrame.executeJavaScript(`(() => {
      const input = document.querySelector('input[aria-label="Foreign name"]');
      input.setSelectionRange(input.value.length,input.value.length);
      window.__foreignPasteEvents = [];
      document.addEventListener('paste',event => {
        if (event.target === input) window.__foreignPasteEvents.push(['paste',event.isTrusted]);
      },true);
      document.addEventListener('input',event => {
        if (event.target === input) window.__foreignPasteEvents.push(['input',event.isTrusted]);
      },true);
    })()`)
    const crossPaste = await control('/invoke', { sessionId,
      code: `let pasted = await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign name',exact:true}).paste('!'); if (pasted.clipboardRestored !== true || pasted.clipboardSuperseded !== false) throw Error('FOREIGN_CLIPBOARD_NOT_RESTORED'); return 'FOREIGN_PASTE_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-paste-state.json'), JSON.stringify({
      value: await foreignFrame.executeJavaScript(`({
        value:document.querySelector('input[aria-label="Foreign name"]').value,
        active:document.activeElement?.getAttribute('aria-label'),
        events:window.__foreignPasteEvents
      })`),
      host: { windowFocused: window.isFocused(), guestFocused: foreignGuest.isFocused(),
        focusedFrameUrl: foreignGuest.focusedFrame?.url ?? null },
    }, null, 2))
    await writeFile(join(root, 'computer-use-cross-origin-paste.json'),
      JSON.stringify({ sessionId, tool: crossPaste }, null, 2))
    assert.equal(crossPaste.result?.isError, false, JSON.stringify(crossPaste.result))
    assert.equal(crossPaste.result?.value?.ok, true, JSON.stringify(crossPaste.result))
    assert.match(crossPaste.result.value.result, /FOREIGN_PASTE_OK/)
    assert.equal(crossPaste.approvals.filter(approval => approval.allowed).length,
      foreignAlert.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame paste needs one-use action confirmation')
    assert.deepEqual(await foreignFrame.executeJavaScript(`({
      value:document.querySelector('input[aria-label="Foreign name"]').value,
      events:window.__foreignPasteEvents
    })`), { value: 'Ada!', events: [['paste',true],['input',true]] })
    await foreignFrame.executeJavaScript(`(() => {
      const editor = document.createElement('div');
      editor.contentEditable = 'true';
      editor.setAttribute('role','textbox');
      editor.setAttribute('aria-label','Foreign editor');
      editor.style.width = '180px'; editor.style.height = '40px';
      document.body.prepend(editor);
      window.__foreignRichEvents = [];
      document.addEventListener('paste',event => {
        if (event.target === editor) window.__foreignRichEvents.push(['paste',event.isTrusted]);
      },true);
      document.addEventListener('input',event => {
        if (event.target === editor) window.__foreignRichEvents.push(['input',event.isTrusted]);
      },true);
    })()`)
    const crossRichPaste = await control('/invoke', { sessionId,
      code: `let rich = await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign editor',exact:true}).paste('<b>Rich</b><i> text</i>',{format:'html'}); if (rich.clipboardRestored !== true || rich.clipboardSuperseded !== false) throw Error('FOREIGN_RICH_CLIPBOARD_NOT_RESTORED'); return 'FOREIGN_RICH_PASTE_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-rich-paste.json'),
      JSON.stringify({ sessionId, tool: crossRichPaste }, null, 2))
    assert.equal(crossRichPaste.result?.value?.ok, true, JSON.stringify(crossRichPaste.result))
    assert.match(crossRichPaste.result.value.result, /FOREIGN_RICH_PASTE_OK/)
    assert.equal(crossRichPaste.approvals.filter(approval => approval.allowed).length,
      crossPaste.approvals.filter(approval => approval.allowed).length + 1)
    const richState = await foreignFrame.executeJavaScript(`({
      html:document.querySelector('[aria-label="Foreign editor"]').innerHTML,
      events:window.__foreignRichEvents
    })`)
    await writeFile(join(root, 'computer-use-cross-origin-rich-paste-state.json'),
      JSON.stringify(richState, null, 2))
    assert.match(richState.html, /<b>Rich<\/b><i> text<\/i>/)
    assert.deepEqual(richState.events, [['paste',true],['input',true]])
    await foreignFrame.executeJavaScript(`document.querySelector('[aria-label="Foreign editor"]').remove()`)
    const crossClear = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign name',exact:true}).fill(''); return 'FOREIGN_CLEAR_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-clear.json'),
      JSON.stringify({ sessionId, tool: crossClear }, null, 2))
    assert.equal(crossClear.result?.isError, false, JSON.stringify(crossClear.result))
    assert.equal(crossClear.result?.value?.ok, true, JSON.stringify(crossClear.result))
    assert.match(crossClear.result.value.result, /FOREIGN_CLEAR_OK/)
    assert.equal(crossClear.approvals.filter(approval => approval.allowed).length,
      crossRichPaste.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame clear needs one-use action confirmation')
    assert.equal(await foreignFrame.executeJavaScript('document.querySelector("input[aria-label=\\"Foreign name\\"]").value'),
      '', 'native Backspace should clear the actual foreign document')
    const crossType = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign name',exact:true}).type('A'); return 'FOREIGN_TYPE_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-type.json'),
      JSON.stringify({ sessionId, tool: crossType }, null, 2))
    assert.equal(crossType.result?.isError, false, JSON.stringify(crossType.result))
    assert.equal(crossType.result?.value?.ok, true, JSON.stringify(crossType.result))
    assert.match(crossType.result.value.result, /FOREIGN_TYPE_OK/)
    assert.equal(crossType.approvals.filter(approval => approval.allowed).length,
      crossClear.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame type needs one-use action confirmation')
    assert.equal(await foreignFrame.executeJavaScript('document.querySelector("input[aria-label=\\"Foreign name\\"]").value'),
      'A', 'native insertText should append in the actual foreign document')
    const crossSequential = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign name',exact:true}).pressSequentially('你😀'); return 'FOREIGN_SEQUENTIAL_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-sequential.json'),
      JSON.stringify({ sessionId, tool: crossSequential }, null, 2))
    assert.equal(crossSequential.result?.isError, false, JSON.stringify(crossSequential.result))
    assert.equal(crossSequential.result?.value?.ok, true, JSON.stringify(crossSequential.result))
    assert.match(crossSequential.result.value.result, /FOREIGN_SEQUENTIAL_OK/)
    assert.equal(crossSequential.approvals.filter(approval => approval.allowed).length,
      crossType.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame sequential typing needs one-use action confirmation')
    assert.equal(await foreignFrame.executeJavaScript('document.querySelector("input[aria-label=\\"Foreign name\\"]").value'),
      'A你😀', 'trusted character events should update the actual foreign document')
    const crossOption = await control('/invoke', { sessionId,
      code: `return 'FOREIGN_OPTION_' + (await t.playwright.frameLocator('#foreign').getByRole('combobox',{name:'Foreign color',exact:true}).selectOption('blue')).join('_');` })
    await writeFile(join(root, 'computer-use-cross-origin-option.json'),
      JSON.stringify({ sessionId, tool: crossOption }, null, 2))
    assert.equal(crossOption.result?.isError, false, JSON.stringify(crossOption.result))
    assert.equal(crossOption.result?.value?.ok, true, JSON.stringify(crossOption.result))
    assert.match(crossOption.result.value.result, /FOREIGN_OPTION_blue/)
    assert.equal(crossOption.approvals.filter(approval => approval.allowed).length,
      crossSequential.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame selectOption needs one-use action confirmation')
    assert.equal(await foreignFrame.executeJavaScript('document.querySelector("select[aria-label=\\"Foreign color\\"]").value'),
      'blue', 'the actual foreign select should hold the chosen option')
    assert.equal(await foreignFrame.executeJavaScript('document.getElementById("foreignColorResult").textContent'),
      'blue', 'foreign change listener should observe the selected option')
    const crossKey = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign name',exact:true}).press('Enter'); return 'FOREIGN_KEY_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-key.json'),
      JSON.stringify({ sessionId, tool: crossKey }, null, 2))
    assert.equal(crossKey.result?.isError, false, JSON.stringify(crossKey.result))
    assert.equal(crossKey.result?.value?.ok, true, JSON.stringify(crossKey.result))
    assert.match(crossKey.result.value.result, /FOREIGN_KEY_OK/)
    assert.equal(crossKey.approvals.filter(approval => approval.allowed).length,
      crossOption.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame press needs one-use action confirmation')
    assert.equal(await foreignFrame.executeJavaScript('document.getElementById("foreignKeyResult").textContent'),
      'trusted', 'native keyDown should reach the actual foreign input')
    const crossSelection = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByText('foreign unique selection',{exact:true}).selectText('unique'); return 'FOREIGN_SELECTION_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-selection.json'),
      JSON.stringify({ sessionId, tool: crossSelection }, null, 2))
    assert.equal(crossSelection.result?.isError, false, JSON.stringify(crossSelection.result))
    assert.equal(crossSelection.result?.value?.ok, true, JSON.stringify(crossSelection.result))
    assert.match(crossSelection.result.value.result, /FOREIGN_SELECTION_OK/)
    assert.equal(crossSelection.approvals.filter(approval => approval.allowed).length,
      crossKey.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame selectText needs one-use action confirmation')
    assert.equal(await foreignFrame.executeJavaScript('window.getSelection().toString()'),
      'unique', 'the actual foreign document should hold the selected text')
    const rejectedFill = await control('/invoke', { sessionId,
      code: `let passwordRejected = false, lockedRejected = false, passwordKeyRejected = false; try { await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign secret',exact:true}).fill('blocked'); } catch (error) { passwordRejected = String(error).includes('SIDEBAR_INPUT_UNAVAILABLE'); } try { await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign locked',exact:true}).fill('blocked'); } catch (error) { lockedRejected = String(error).includes('SIDEBAR_INPUT_UNAVAILABLE'); } try { await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign secret',exact:true}).press('Enter'); } catch (error) { passwordKeyRejected = String(error).includes('SIDEBAR_INPUT_UNAVAILABLE'); } if(!passwordRejected || !lockedRejected || !passwordKeyRejected) throw Error('FOREIGN_INPUT_GATE_FAILED'); return 'FOREIGN_INPUT_GATES_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-fill-denied.json'),
      JSON.stringify({ sessionId, tool: rejectedFill }, null, 2))
    assert.equal(rejectedFill.result?.isError, false, JSON.stringify(rejectedFill.result))
    assert.equal(rejectedFill.result?.value?.ok, true, JSON.stringify(rejectedFill.result))
    assert.match(rejectedFill.result.value.result, /FOREIGN_INPUT_GATES_OK/)
    assert.deepEqual(await foreignFrame.executeJavaScript(`[document.querySelector('input[aria-label="Foreign secret"]').value,document.querySelector('input[aria-label="Foreign locked"]').value]`),
      ['safe', 'stable'], 'password and read-only fields must remain unchanged')
    const crossRefClick = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Cross-origin frame',exact:true}).click(); let clicked = await t.getAXState({emit:false}); if(!clicked.includes('foreign clicked 1')) throw Error('FOREIGN_REF_CLICK_NOT_OBSERVED'); return 'FOREIGN_REF_CLICK_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-ref-click.json'),
      JSON.stringify({ sessionId, tool: crossRefClick }, null, 2))
    assert.equal(crossRefClick.result?.isError, false, JSON.stringify(crossRefClick.result))
    assert.equal(crossRefClick.result?.value?.ok, true, JSON.stringify(crossRefClick.result))
    assert.match(crossRefClick.result.value.result, /FOREIGN_REF_CLICK_OK/)
    assert.equal(crossRefClick.approvals.filter(approval => approval.allowed).length,
      rejectedFill.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame element click needs one-use action confirmation')
    const foreignPoint = await window.webContents.executeJavaScript(`
      [...document.querySelectorAll('webview')].find(view => view.getURL() === ${JSON.stringify(crossUrl)})
        .executeJavaScript('(() => { const rect = document.getElementById("foreign").getBoundingClientRect(); return [Math.round(rect.left + 65),Math.round(rect.top + 20)]; })()')`)
    const crossClick = await control('/invoke', { sessionId,
      code: `await t.click(${JSON.stringify(foreignPoint)}); let coordinateState = await t.getAXState({emit:false}); if(!coordinateState.includes('foreign clicked 2')) throw Error('FOREIGN_CLICK_NOT_OBSERVED'); return 'FOREIGN_CLICK_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-click.json'),
      JSON.stringify({ sessionId, tool: crossClick }, null, 2))
    assert.equal(crossClick.result?.isError, false, JSON.stringify(crossClick.result))
    assert.equal(crossClick.result?.value?.ok, true, JSON.stringify(crossClick.result))
    assert.match(crossClick.result.value.result, /FOREIGN_CLICK_OK/)
    assert.equal(crossClick.approvals.filter(approval => approval.allowed).length,
      crossRefClick.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame coordinate click needs one-use action confirmation')
    assert.match(crossClick.approvals.at(-1).reason, /网页坐标/)
    const crossShot = await control('/invoke', { sessionId,
      code: `let crossViewport = await t.screenshot({emit:false}); let crossFull = await t.screenshot({fullPage:true,emit:false}); return 'CROSS_PNG_' + crossViewport.length + '_' + crossFull.length;` })
    await writeFile(join(root, 'computer-use-cross-origin-screenshot.json'),
      JSON.stringify({ sessionId, tool: crossShot }, null, 2))
    assert.equal(crossShot.result?.isError, false, JSON.stringify(crossShot.result))
    assert.equal(crossShot.result?.value?.ok, true, JSON.stringify(crossShot.result))
    assert.match(crossShot.result.value.result, /CROSS_PNG_[1-9][0-9]*_[1-9][0-9]*/)
    await foreignFrame.executeJavaScript(`(() => {
      document.querySelector('button').addEventListener('contextmenu', event => {
        event.preventDefault(); document.body.dataset.foreignMenuTrusted = String(event.isTrusted);
      });
      const toggle = document.createElement('button');
      toggle.textContent = 'Foreign toggle';
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', event => {
        toggle.setAttribute('aria-expanded', toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
        document.body.dataset.foreignToggleTrusted = String(event.isTrusted);
      });
      const number = document.createElement('input');
      number.type = 'number'; number.value = '2'; number.setAttribute('aria-label', 'Foreign count');
      number.addEventListener('input', event => {
        document.body.dataset.foreignNumberTrusted = String(event.isTrusted);
      });
      document.body.prepend(toggle, number);
    })()`)
    const crossSecondary = await control('/invoke', { sessionId,
      code: `{ const target = t.playwright.frameLocator('#foreign'); await target.getByRole('textbox',{name:'Foreign name',exact:true}).performSecondaryAction('focus'); await target.getByRole('button',{name:'Cross-origin frame',exact:true}).performSecondaryAction('showmenu'); await target.getByRole('button',{name:'Foreign toggle',exact:true}).performSecondaryAction('expand'); await target.getByRole('button',{name:'Foreign toggle',exact:true}).performSecondaryAction('collapse'); await target.getByRole('spinbutton',{name:'Foreign count',exact:true}).performSecondaryAction('increment'); await target.getByRole('spinbutton',{name:'Foreign count',exact:true}).performSecondaryAction('decrement'); } return 'FOREIGN_SECONDARY_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-secondary.json'),
      JSON.stringify({ sessionId, tool: crossSecondary }, null, 2))
    assert.equal(crossSecondary.result?.isError, false, JSON.stringify(crossSecondary.result))
    assert.equal(crossSecondary.result?.value?.ok, true, JSON.stringify(crossSecondary.result))
    assert.match(crossSecondary.result.value.result, /FOREIGN_SECONDARY_OK/)
    assert.equal(crossSecondary.approvals.filter(approval => approval.allowed).length,
      crossShot.approvals.filter(approval => approval.allowed).length + 6,
      'each foreign secondary action needs one-use confirmation')
    assert.deepEqual(crossSecondary.approvals.slice(-6).map(approval =>
      /执行(聚焦|打开菜单|展开|收起|增加|减少)/u.exec(approval.reason)?.[1]),
    ['聚焦', '打开菜单', '展开', '收起', '增加', '减少'],
    'each confirmation should identify its exact secondary action')
    assert.deepEqual(await foreignFrame.executeJavaScript(`({menu:document.body.dataset.foreignMenuTrusted,
      toggle:document.body.dataset.foreignToggleTrusted,
      expanded:document.querySelector('[aria-label="Foreign count"]').previousSibling.getAttribute('aria-expanded'),
      number:document.querySelector('[aria-label="Foreign count"]').value,
      numberTrusted:document.body.dataset.foreignNumberTrusted})`),
    {menu:'true',toggle:'true',expanded:'false',number:'2',numberTrusted:'true'})
    await foreignFrame.executeJavaScript(`(() => {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:12px;margin:8px 0';
      const source = document.createElement('div'); source.id = 'foreignDragSource';
      source.textContent = 'Foreign drag source'; source.draggable = true;
      source.style.cssText = 'width:105px;height:35px;background:#ff8';
      source.addEventListener('dragstart', event => {
        event.dataTransfer.setData('text/plain', 'foreign-payload');
        document.body.dataset.foreignDragTrusted = String(event.isTrusted);
      });
      const target = document.createElement('div'); target.id = 'foreignDropTarget';
      target.textContent = 'Foreign drop target';
      target.style.cssText = 'width:105px;height:35px;background:#8ff';
      target.addEventListener('dragover', event => event.preventDefault());
      target.addEventListener('drop', event => {
        event.preventDefault();
        document.body.dataset.foreignDropTrusted = String(event.isTrusted);
        document.body.dataset.foreignDropValue = event.dataTransfer.getData('text/plain');
      });
      row.append(source,target); document.body.prepend(row);
    })()`)
    const foreignDragLocal = await foreignFrame.executeJavaScript(`(() => {
      const point = id => { const r = document.getElementById(id).getBoundingClientRect();
        return {x:r.left + r.width / 2,y:r.top + r.height / 2}; };
      return {from:point('foreignDragSource'),to:point('foreignDropTarget')};
    })()`)
    const foreignDragOuter = await foreignGuest.mainFrame.executeJavaScript(`(() => {
      const frame = document.getElementById('foreign');
      const rect = frame.getBoundingClientRect();
      return {x:rect.left + frame.clientLeft,y:rect.top + frame.clientTop};
    })()`)
    const foreignDragFrom = [foreignDragOuter.x + foreignDragLocal.from.x,
      foreignDragOuter.y + foreignDragLocal.from.y]
    const foreignDragTo = [foreignDragOuter.x + foreignDragLocal.to.x,
      foreignDragOuter.y + foreignDragLocal.to.y]
    const crossDrag = await control('/invoke', { sessionId,
      code: `await t.screenshot({emit:false}); const result = await t.drag(${JSON.stringify(foreignDragFrom)},${JSON.stringify(foreignDragTo)}); return 'FOREIGN_DRAG_' + String(result.dropDispatched);` })
    assert.equal(crossDrag.result?.isError, false, JSON.stringify(crossDrag.result))
    assert.equal(crossDrag.result?.value?.ok, true, JSON.stringify(crossDrag.result))
    assert.match(crossDrag.result.value.result, /FOREIGN_DRAG_true/)
    assert.equal(crossDrag.approvals.filter(approval => approval.allowed).length,
      crossSecondary.approvals.filter(approval => approval.allowed).length + 1,
      'foreign drag needs one-use confirmation after every frame site is approved')
    const foreignDragState = await foreignFrame.executeJavaScript(`({drag:document.body.dataset.foreignDragTrusted,
      drop:document.body.dataset.foreignDropTrusted,value:document.body.dataset.foreignDropValue})`)
    assert.deepEqual(foreignDragState,
    {drag:'true',drop:'true',value:'foreign-payload'})
    await writeFile(join(root, 'computer-use-cross-origin-drag.json'),
      JSON.stringify({ sessionId, tool: crossDrag, foreignDragFrom, foreignDragTo, foreignDragState }, null, 2))
    await foreignFrame.executeJavaScript(`document.body.insertAdjacentHTML('beforeend',
      '<div style="height:1400px">Foreign scroll tail</div>')`)
    const foreignScrollBefore = await foreignFrame.executeJavaScript('window.scrollY')
    const topScrollBefore = await foreignGuest.mainFrame.executeJavaScript('window.scrollY')
    const crossScroll = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('textbox',{name:'Foreign name',exact:true}).scroll('down',1); return 'FOREIGN_SCROLL_OK';` })
    assert.equal(crossScroll.result?.isError, false, JSON.stringify(crossScroll.result))
    assert.equal(crossScroll.result?.value?.ok, true, JSON.stringify(crossScroll.result))
    assert.match(crossScroll.result.value.result, /FOREIGN_SCROLL_OK/)
    assert.equal(crossScroll.approvals.filter(approval => approval.allowed).length,
      crossDrag.approvals.filter(approval => approval.allowed).length,
      'Foreign-frame scroll uses approved site access without click or text confirmation')
    await waitFor(() => foreignFrame.executeJavaScript(`window.scrollY > ${foreignScrollBefore}`),
      'trusted foreign-frame wheel scroll', 5000)
    const foreignScrollAfter = await foreignFrame.executeJavaScript('window.scrollY')
    const topScrollAfter = await foreignGuest.mainFrame.executeJavaScript('window.scrollY')
    assert.equal(topScrollAfter, topScrollBefore, 'foreign scroll must not move the top document')
    await writeFile(join(root, 'computer-use-cross-origin-scroll.json'),
      JSON.stringify({ sessionId, tool: crossScroll, foreignScrollBefore, foreignScrollAfter,
        topScrollBefore, topScrollAfter }, null, 2))
    await foreignFrame.executeJavaScript(`(() => {
      window.scrollTo(0,0);
      const button = document.createElement('button');
      button.setAttribute('aria-label','Foreign hover');
      button.textContent = 'Foreign hover';
      button.addEventListener('mouseenter',event => {
        document.body.dataset.foreignHoverTrusted = String(event.isTrusted);
        button.textContent = 'Hover opened';
      });
      button.addEventListener('click',() => {
        document.body.dataset.foreignHoverClicked = 'true';
      });
      document.body.prepend(button);
    })()`)
    const crossHover = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Foreign hover',exact:true}).hover(); return 'FOREIGN_HOVER_OK';` })
    assert.equal(crossHover.result?.value?.ok, true, JSON.stringify(crossHover.result))
    assert.match(crossHover.result.value.result, /FOREIGN_HOVER_OK/)
    assert.equal(crossHover.approvals.filter(approval => approval.allowed).length,
      crossScroll.approvals.filter(approval => approval.allowed).length + 1,
      'Foreign-frame hover needs one-use confirmation')
    const foreignHoverState = await foreignFrame.executeJavaScript(`({
      trusted:document.body.dataset.foreignHoverTrusted,
      clicked:document.body.dataset.foreignHoverClicked ?? null,
      text:document.querySelector('[aria-label="Foreign hover"]')?.textContent
    })`)
    assert.deepEqual(foreignHoverState,{trusted:'true',clicked:null,text:'Hover opened'})
    await writeFile(join(root, 'computer-use-cross-origin-hover.json'),
      JSON.stringify({ sessionId, tool: crossHover, foreignHoverState }, null, 2))
    await foreignFrame.executeJavaScript(`(() => {
      const button = document.createElement('button');
      button.textContent = 'Foreign leave';
      window.__foreignLeaveHandler = event => { event.preventDefault(); event.returnValue = ''; };
      addEventListener('beforeunload', window.__foreignLeaveHandler);
      button.addEventListener('click', () => {
        document.body.dataset.foreignLeaveActivated = String(navigator.userActivation.hasBeenActive);
        location.assign('/next');
      });
      document.body.prepend(button);
    })()`)
    const foreignLeaveEvents = []
    const foreignLeaveStart = Date.now()
    const onForeignLeaveDebugger = (_event, method, params) => {
      if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed' ||
        method === 'Page.frameRequestedNavigation') {
        foreignLeaveEvents.push({ ms: Date.now() - foreignLeaveStart,
          method, type: params?.type, url: params?.url, result: params?.result,
          frameId: params?.frameId, reason: params?.reason, disposition: params?.disposition })
      }
    }
    const onForeignLeaveNative = raw => {
      foreignLeaveEvents.push({ ms: Date.now() - foreignLeaveStart, method: '-run-dialog',
        type: raw?.dialogType, source: raw?.frame?.url })
    }
    const onForeignLeavePrevent = () => {
      foreignLeaveEvents.push({ ms: Date.now() - foreignLeaveStart, method: 'will-prevent-unload' })
    }
    foreignGuest.debugger.on('message', onForeignLeaveDebugger)
    foreignGuest.on('-run-dialog', onForeignLeaveNative)
    foreignGuest.on('will-prevent-unload', onForeignLeavePrevent)
    const foreignLeaveDismissed = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Foreign leave',exact:true}).click(); let leaveDismiss = await t.getJsDialog(); if(leaveDismiss?.type !== 'beforeunload') throw Error('FOREIGN_BEFOREUNLOAD_MISSING'); await leaveDismiss.dismiss(); return 'FOREIGN_BEFOREUNLOAD_DISMISSED';` })
    assert.equal(foreignLeaveDismissed.result?.value?.ok, true, JSON.stringify(foreignLeaveDismissed.result))
    assert.match(foreignLeaveDismissed.result.value.result, /FOREIGN_BEFOREUNLOAD_DISMISSED/)
    assert.equal(foreignFrame.url.endsWith('/frame'), true, 'dismissed dialog must keep the foreign frame')
    assert.equal(foreignLeaveDismissed.approvals.filter(approval => approval.allowed).length,
      crossHover.approvals.filter(approval => approval.allowed).length + 2,
      'Foreign click and dialog dismissal each need one-use confirmation')
    const foreignLeaveAccepted = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Foreign leave',exact:true}).click(); let leaveAccept = await t.getJsDialog(); if(leaveAccept?.type !== 'beforeunload') throw Error('FOREIGN_BEFOREUNLOAD_MISSING'); await leaveAccept.accept(); return 'FOREIGN_BEFOREUNLOAD_ACCEPTED';` })
    foreignGuest.debugger.off('message', onForeignLeaveDebugger)
    foreignGuest.off('-run-dialog', onForeignLeaveNative)
    foreignGuest.off('will-prevent-unload', onForeignLeavePrevent)
    assert.equal(foreignLeaveAccepted.result?.value?.ok, true, JSON.stringify(foreignLeaveAccepted.result))
    assert.match(foreignLeaveAccepted.result.value.result, /FOREIGN_BEFOREUNLOAD_ACCEPTED/)
    assert.equal(foreignLeaveAccepted.approvals.filter(approval => approval.allowed).length,
      foreignLeaveDismissed.approvals.filter(approval => approval.allowed).length + 2,
      'Foreign click and dialog acceptance each need one-use confirmation')
    assert.equal(foreignFrame.url.endsWith('/next'), true, 'accepted dialog must navigate the same foreign frame')
    await writeFile(join(root, 'computer-use-cross-origin-beforeunload.json'),
      JSON.stringify({ sessionId, dismissed: foreignLeaveDismissed, accepted: foreignLeaveAccepted,
        foreignLeaveEvents,
        actionFinishedMs: Date.now() - foreignLeaveStart,
        guestPreferences: foreignGuest.getLastWebPreferences(),
        activated: true, frameUrl: foreignFrame.url }, null, 2))
    await foreignFrame.executeJavaScript(`(() => {
      addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });
      const button = document.createElement('button');
      button.textContent = 'Approved foreign destination';
      button.addEventListener('click', () => { location.assign(${JSON.stringify(destinationUrl)}); });
      document.body.prepend(button);
    })()`)
    const foreignCrossSiteAccepted = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Approved foreign destination',exact:true}).click(); let leave = await t.getJsDialog(); if(leave?.type !== 'beforeunload') throw Error('FOREIGN_CROSS_SITE_DIALOG_MISSING'); await leave.accept(); return 'FOREIGN_CROSS_SITE_ACCEPTED';` })
    assert.equal(foreignCrossSiteAccepted.result?.value?.ok, true, JSON.stringify(foreignCrossSiteAccepted.result))
    assert.match(foreignCrossSiteAccepted.result.value.result, /FOREIGN_CROSS_SITE_ACCEPTED/)
    assert.equal(foreignFrame.url, destinationUrl, 'accepted dialog must reach the already approved destination site')
    assert.equal(foreignCrossSiteAccepted.approvals.filter(approval => approval.allowed).length,
      foreignLeaveAccepted.approvals.filter(approval => approval.allowed).length + 2,
      'Foreign cross-site click and dialog acceptance each need one-use confirmation')
    await writeFile(join(root, 'computer-use-cross-origin-beforeunload-approved-destination.json'),
      JSON.stringify({ sessionId, tool: foreignCrossSiteAccepted, frameUrl: foreignFrame.url,
        destinationUrl }, null, 2))
    const createdUrl = new URL('/created', pageUrl).href
    const created = await control('/invoke', { sessionId,
      code: `let createdTab = await b.tabs.new(${JSON.stringify(createdUrl)}); let activeTab = await b.tabs.selected(); if (activeTab?.id !== createdTab.id) throw Error('CREATED_TAB_NOT_SELECTED'); let oldUnavailable = false; try { await t.getAXState({emit:false}); } catch { oldUnavailable = true; } if (!oldUnavailable) throw Error('OLD_TAB_STILL_EXPOSED'); return 'CREATED_' + createdTab.id + '_' + (await createdTab.getAXState({emit:false})).includes('Isolated Computer Use');` })
    await writeFile(join(root, 'computer-use-create-tab.json'),
      JSON.stringify({ sessionId, tool: created, createdUrl }, null, 2))
    assert.equal(created.result?.isError, false, JSON.stringify(created.result))
    assert.equal(created.result?.value?.ok, true, JSON.stringify(created.result))
    assert.match(created.result.value.result, /CREATED_sidebar:.*_true/)
    assert.equal(created.approvals.filter(approval => approval.allowed).length,
      foreignCrossSiteAccepted.approvals.filter(approval => approval.allowed).length,
      'same-origin tab creation and read need no action confirmation')
    const blankCreated = await control('/invoke', { sessionId,
      code: `let blankTab = await b.tabs.new(); if (await blankTab.url() !== 'about:blank') throw Error('BLANK_URL_MISSING'); if ((await blankTab.getAXState({emit:false})) !== '') throw Error('BLANK_NOT_EMPTY'); let selectedBlank = await b.tabs.selected(); if (selectedBlank?.id !== blankTab.id) throw Error('BLANK_NOT_SELECTED'); return 'BLANK_' + blankTab.id;` })
    await writeFile(join(root, 'computer-use-create-blank.json'),
      JSON.stringify({ sessionId, tool: blankCreated }, null, 2))
    assert.equal(blankCreated.result?.isError, false, JSON.stringify(blankCreated.result))
    assert.equal(blankCreated.result?.value?.ok, true, JSON.stringify(blankCreated.result))
    assert.match(blankCreated.result.value.result, /BLANK_sidebar:/)
    const blankNavigated = await control('/invoke', { sessionId,
      code: `let blankBefore = blankTab.id; await blankTab.goto(${JSON.stringify(createdUrl)}); if (blankTab.id !== blankBefore || (await b.tabs.selected())?.id !== blankBefore) throw Error('BLANK_ID_CHANGED'); return 'BLANK_NAVIGATED_' + (await blankTab.getAXState({emit:false})).includes('Isolated Computer Use');` })
    await writeFile(join(root, 'computer-use-navigate-blank.json'),
      JSON.stringify({ sessionId, tool: blankNavigated, createdUrl }, null, 2))
    assert.equal(blankNavigated.result?.isError, false, JSON.stringify(blankNavigated.result))
    assert.equal(blankNavigated.result?.value?.ok, true, JSON.stringify(blankNavigated.result))
    assert.match(blankNavigated.result.value.result, /BLANK_NAVIGATED_true/)
    console.log('sidebar qualification: Computer Use read result written')
    app.exit(0)
  } catch (error) {
    await writeFile(join(root, 'failure.txt'), String(error?.stack ?? error))
    await writeFile(join(root, 'failure-windows.json'), JSON.stringify(BrowserWindow.getAllWindows().map(item => ({
      url: item.webContents.getURL(), title: item.getTitle(), visible: item.isVisible(),
    })), null, 2))
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

void qualify().catch(error => { console.error(error); app.exit(1); setTimeout(() => process.exit(1), 2000).unref() })
