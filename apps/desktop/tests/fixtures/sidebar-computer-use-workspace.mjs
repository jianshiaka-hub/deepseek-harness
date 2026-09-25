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
    const nestedRelative = await control('/invoke', { sessionId,
      code: `let chain = t.playwright.locator('.inner').filter({hasText:'Shared'}).getByTestId('duplicate'); return 'NESTED_RELATIVE_' + [await t.playwright.getByTestId('group-a').filter({has:chain}).count(),await t.playwright.getByTestId('group-b').filter({has:chain}).count(),await t.playwright.getByTestId('group-b').filter({hasNot:chain}).count()].join('_');` })
    await writeFile(join(root, 'computer-use-nested-relative-locate.json'), JSON.stringify({ sessionId, tool: nestedRelative }, null, 2))
    assert.equal(nestedRelative.result?.isError, false, JSON.stringify(nestedRelative.result))
    assert.equal(nestedRelative.result?.value?.ok, true, JSON.stringify(nestedRelative.result))
    assert.match(nestedRelative.result.value.result, /NESTED_RELATIVE_1_0_1/)
    assert.equal(nestedRelative.approvals.filter(approval => approval.allowed).length, 0)
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
      tab.sessionId === sessionId && tab.observedUrl === crossUrl),
    'cross-origin Sidebar reporter registration', 10000)
    const crossText = await control('/invoke', { sessionId,
      code: `let foreignState = await t.getAXState({emit:false}); if(!foreignState.includes('[Approved frame http://127.0.0.1:') || !foreignState.includes('Cross-origin frame') || !foreignState.includes('[Frame roles]\\n- button "Cross-origin frame"')) throw Error('FOREIGN_FRAME_ROLES_MISSING'); return 'FOREIGN_ROLES_OK';` })
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
    const crossRefClick = await control('/invoke', { sessionId,
      code: `await t.playwright.frameLocator('#foreign').getByRole('button',{name:'Cross-origin frame',exact:true}).click(); let clicked = await t.getAXState({emit:false}); if(!clicked.includes('foreign clicked 1')) throw Error('FOREIGN_REF_CLICK_NOT_OBSERVED'); return 'FOREIGN_REF_CLICK_OK';` })
    await writeFile(join(root, 'computer-use-cross-origin-ref-click.json'),
      JSON.stringify({ sessionId, tool: crossRefClick }, null, 2))
    assert.equal(crossRefClick.result?.isError, false, JSON.stringify(crossRefClick.result))
    assert.equal(crossRefClick.result?.value?.ok, true, JSON.stringify(crossRefClick.result))
    assert.match(crossRefClick.result.value.result, /FOREIGN_REF_CLICK_OK/)
    assert.equal(crossRefClick.approvals.filter(approval => approval.allowed).length,
      crossLocate.approvals.filter(approval => approval.allowed).length + 1,
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
