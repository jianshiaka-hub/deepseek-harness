/** Register the HTTP(S) Browser tab type in the right Sidebar. */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { createIframePage } from './pages.ts'
import { createElectronPage } from './electron/pages.ts'
import type { DesktopBrowserBridge } from '../types.ts'
import { browserWorkspace } from './electron/workspace.ts'
import { SidebarComputerUseReporter } from './electron/SidebarComputerUseReporter.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserPageScreenshot, BrowserScreenshotClip, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string }
  }
}

/** Required Browser services. */
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** Register the Browser type, localized guide entry, body, and title. */
export function apply(ctx: Context): void {
  const namespace = 'sidebarBrowser'
  const t = ctx.locale.bind(namespace)
  ctx.inject(['shortcuts'], (ctx) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
  })
  const store = createBrowserStore()
  const openTabs = ctx.sidebarRight.openTabs
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { readonly protocolVersion: number; readonly browser?: DesktopBrowserBridge }
  }).dshDesktop
  const desktop = carrier?.protocolVersion === 1 ? carrier.browser : undefined
  const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
  const reporter = desktop === undefined ? undefined : new SidebarComputerUseReporter(
    () => {
      const selected = ctx.sidebarRight.selected.getSnapshot()
      if (selected === undefined || !openTabs.getSnapshot().some(tab =>
        tab.sessionId === selected.sessionId && tab.tabId === selected.tabId && tab.kind === 'browser')) return null
      const state = controllers.get(selected.sessionId)?.snapshot(selected.tabId)?.frame
      const pendingDialogUrl = controllers.get(selected.sessionId)?.pendingDialogUrl(selected.tabId)
      return { sessionId: selected.sessionId, tabId: selected.tabId,
        controllerAvailable: pendingDialogUrl !== undefined ||
          state?.address === 'observed' && !state.loading && state.target !== undefined,
        ...(pendingDialogUrl !== undefined ? { observedUrl: pendingDialogUrl }
          : state?.address === 'observed' && state.target !== undefined ? { observedUrl: state.target.url } : {}),
        ...(state?.target !== undefined ? { requestedUrl: state.target.url, title: state.target.title } : {}) }
    },
    (tab, command, stillSelected) => {
      const controller = controllers.get(tab.sessionId as BrowserBodyProps['sessionId'])
      if (controller === undefined) throw new Error('SIDEBAR_TAB_UNAVAILABLE')
      const tabId = tab.tabId as Parameters<BrowserInjected['inspect']>[0]
      if (command.op === 'inspect') return controller.inspect(tabId, command.expectedUrl,
        command.args.approvedFrameOrigins)
      if (command.op === 'frameOrigins') return controller.frameOrigins(tabId, command.expectedUrl)
      if (command.op === 'locate') {
        if (command.args.query === undefined) throw new Error('SIDEBAR_LOCATOR_UNAVAILABLE')
        return controller.locate(tabId, command.expectedUrl, command.args.query,
          command.args.approvedFrameOrigins)
      }
      if (command.op === 'dialog') return controller.dialog(tabId, command.expectedUrl, stillSelected)
      if (command.op === 'dialogAction') {
        if (command.args.handle === undefined || command.args.decision === undefined) {
          throw new Error('SIDEBAR_DIALOG_LEASE_UNAVAILABLE')
        }
        return controller.handleDialog(tabId, command.expectedUrl, command.args.handle,
          command.args.decision, command.args.text, stillSelected)
      }
      if (command.op === 'screenshot') return controller.screenshot(tabId, command.expectedUrl, command.args.clip,
        command.args.fullPage, command.args.approvedFrameOrigins)
      if (command.op === 'goto') {
        if (command.args.url === undefined) throw new Error('SIDEBAR_URL_UNAVAILABLE')
        return controller.navigate(tabId, command.expectedUrl, command.args.url, stillSelected)
      }
      if (command.op === 'back' || command.op === 'forward') {
        return controller.navigateHistory(tabId, command.expectedUrl, command.op, stillSelected)
      }
      if (command.op === 'close') {
        if (!stillSelected()) throw new Error('SIDEBAR_SELECTION_CHANGED')
        ctx.sidebarRight.close(tabId)
        if (openTabs.getSnapshot().some(current =>
          current.sessionId === tab.sessionId && current.tabId === tab.tabId)) {
          throw new Error('SIDEBAR_CLOSE_FAILED')
        }
        return Promise.resolve({ url: command.expectedUrl, title: '', closed: true })
      }
      if (command.op === 'click') {
        const options = {
          ...(command.args.button === undefined ? {} : { button: command.args.button }),
          ...(command.args.count === undefined ? {} : { count: command.args.count }),
          ...(command.args.approvedFrameOrigins === undefined ? {}
            : { approvedFrameOrigins: command.args.approvedFrameOrigins }),
        }
        if (command.args.ref !== undefined) return controller.action(tabId, command.expectedUrl,
          { op: 'click', ref: command.args.ref, ...options }, stillSelected)
        if (command.args.x === undefined || command.args.y === undefined) throw new Error('SIDEBAR_POINT_UNAVAILABLE')
        return controller.action(tabId, command.expectedUrl,
          { op: 'click', x: command.args.x, y: command.args.y, ...options }, stillSelected)
      }
      if (command.op === 'drag') {
        if (command.args.x === undefined || command.args.y === undefined || command.args.to === undefined) {
          throw new Error('SIDEBAR_DRAG_UNAVAILABLE')
        }
        return controller.action(tabId, command.expectedUrl,
          { op: 'drag', x: command.args.x, y: command.args.y, to: command.args.to }, stillSelected)
      }
      if (command.op === 'key') {
        if (command.args.key === undefined) throw new Error('SIDEBAR_KEY_UNAVAILABLE')
        return controller.action(tabId, command.expectedUrl,
          { op: 'key', ...(command.args.ref === undefined ? {} : { ref: command.args.ref }),
            key: command.args.key }, stillSelected)
      }
      if (command.op === 'paste') {
        if (command.args.text === undefined || command.args.format === undefined) {
          throw new Error('SIDEBAR_PASTE_UNAVAILABLE')
        }
        return controller.action(tabId, command.expectedUrl,
          { op: 'paste', ...(command.args.ref === undefined ? {} : { ref: command.args.ref }),
            text: command.args.text, format: command.args.format }, stillSelected)
      }
      if (command.op === 'type') {
        if (command.args.text === undefined) throw new Error('SIDEBAR_INPUT_UNAVAILABLE')
        return controller.action(tabId, command.expectedUrl,
          { op: 'type', ...(command.args.ref === undefined ? {} : { ref: command.args.ref }),
            text: command.args.text,
            ...(command.args.sequential === true ? { sequential: true as const } : {}) }, stillSelected)
      }
      if (command.args.ref === undefined) throw new Error('SIDEBAR_UNKNOWN_REF')
      if (command.op === 'setValue') {
        if (command.args.value === undefined) throw new Error('SIDEBAR_INPUT_UNAVAILABLE')
        return controller.action(tabId, command.expectedUrl,
          { op: 'setValue', ref: command.args.ref, value: command.args.value }, stillSelected)
      }
      if (command.op === 'selectOption') {
        if (command.args.options === undefined) throw new Error('SIDEBAR_OPTION_UNAVAILABLE')
        return controller.action(tabId, command.expectedUrl,
          { op: 'selectOption', ref: command.args.ref, options: command.args.options }, stillSelected)
      }
      if (command.op === 'selectText') {
        if (command.args.text === undefined) throw new Error('SIDEBAR_SELECTION_UNAVAILABLE')
        return controller.action(tabId, command.expectedUrl,
          { op: 'selectText', ref: command.args.ref, text: command.args.text,
            ...(command.args.prefix === undefined ? {} : { prefix: command.args.prefix }),
            ...(command.args.suffix === undefined ? {} : { suffix: command.args.suffix }),
            ...(command.args.selectionType === undefined ? {} : { selectionType: command.args.selectionType }) }, stillSelected)
      }
      if (command.op === 'secondary') {
        if (command.args.action === undefined) throw new Error('SIDEBAR_ACTION_UNAVAILABLE')
        return controller.action(tabId, command.expectedUrl,
          { op: 'secondary', ref: command.args.ref, action: command.args.action }, stillSelected)
      }
      if (command.args.dx === undefined || command.args.dy === undefined) throw new Error('SIDEBAR_SCROLL_UNAVAILABLE')
      return controller.action(tabId, command.expectedUrl,
        { op: 'scroll', ref: command.args.ref, dx: command.args.dx, dy: command.args.dy }, stillSelected)
    },
  )
  if (reporter !== undefined) ctx.effect(() => {
    const unsubscribe = ctx.sidebarRight.selected.subscribe(() => { reporter.notifySelection() })
    const unsubscribeTabs = openTabs.subscribe(() => { reporter.notifySelection() })
    reporter.start()
    return async () => { unsubscribe(); unsubscribeTabs(); await reporter.dispose() }
  }, 'ui-sidebar-browser.computer-use-selected')
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'ui-sidebar-browser.copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: desktop !== undefined }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context, factory: (sessionId: BrowserBodyProps['sessionId']) => BrowserPageFactory): void => {
    scope.effect(() => async () => {
      const pending = [...controllers.values()].map(controller => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: namespace, store,
      inject: (sessionId, actions) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions)
          return existing
        }
        const controller = createBrowserControllers(actions, factory(sessionId), tabId =>
          openTabs.getSnapshot().some(tab => tab.sessionId === sessionId && tab.tabId === tabId),
        () => { reporter?.notify() })
        controllers.set(sessionId, controller)
        return controller
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
  }
  if (desktop === undefined) installFrames(ctx, () => createIframePage)
  else ctx.inject(['workspaces'], (scope) => {
    installFrames(scope, sessionId => options => createElectronPage(options, desktop,
      signal => browserWorkspace(scope.workspaces.list, sessionId, signal)))
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}
