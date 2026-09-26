---
description: "Right-Sidebar browser tabs for sandboxed HTTP(S) pages, including loopback services."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

English | [中文](README.zh.md)

## Summary

Browse HTTP(S) pages, including loopback services, inside independent right-Sidebar tabs. Web uses an iframe with application-managed history; Desktop uses Electron `<webview>` with native navigation history and retained pages. The package never injects Electron or Node access into visited content.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Browser is disabled by default in Web profiles and enabled on Desktop. Enable the shipped entry through the Web profile patch to use it. Open **Browser** from the right-Sidebar guide and enter an HTTP(S) URL. Chat HTTP(S) links open here when the [link preference](../ui-chat/README.md) selects **In-App Sidebar**. A host name without a scheme becomes HTTPS. Public and loopback targets use the same default sandbox. Each guide action or delegated message-link activation creates another Browser tab.

### When to choose it

Choose Browser for a Web page that should remain beside the current Session. Choose [Document Preview](../ui-sidebar-documentpreview/README.md) for local files, and use the explicit external-browser action when a site refuses iframe embedding or needs browser capabilities this package withholds.

### Minimal configuration

The package has no plugin configuration. A Web profile enables the shipped entry through its profile patch:

```yaml
- id: ui-sidebar-browser
  disabled: false
```

Client plugins can open a tab through `ctx.sidebarRight.openTab('browser', { params: { url } })`. The optional URL passes the same validation as address-bar input before navigation.

The `browser.new` command opens a separate Browser page in the focused dock pane, replacing a guide and retaining existing content pages. From the conversation or a floating content page, it uses the active dock pane. Desktop defaults to Cmd+T on macOS and Ctrl+T on Windows; Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves the command unbound. The guide button uses a blue globe and displays the effective shortcut inline without a duplicate tooltip.

The toolbar provides Back, Forward, Reload, Go, and Open in system browser. Web also offers a per-tab sandbox toggle; disabling it is temporary and displays a warning. Desktop shows the observed page title. After a restart, Browser shows the saved title and URL; Restore or Reload opens that address only when requested.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Protocol policy

The address parser accepts HTTP and HTTPS, including loopback targets. It rejects `file:` URLs, script/data/blob input, embedded credentials, the DSH application origin, and malformed addresses. Document Preview owns local-file rendering.

### Iframe carrier

Web uses `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"` by default. The frame has no direct download or top-navigation flag. Popups leave the sandbox; in Web, an escaped popup retains its opener and can navigate the top-level application. The visited origin can use its own cookies and Web storage but a cross-origin target cannot read DSH DOM, storage, or API responses. The iframe sends no referrer and adds no package-owned Permissions Policy, so browser defaults and user grants apply. The toolbar can remove the sandbox for the current tab occurrence; the choice is not persisted. An unsandboxed page can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. The package does not proxy or probe remote pages.

Web records toolbar submissions and typed tab opens. A navigation state machine treats the first iframe load for each controlled revision as known and a later load as proof that the page changed to an unreadable URL. In that unknown state the address is marked, Back, Forward, and external-open are disabled, and Reload returns to the last controlled URL. A remounted body reloads the latest application-known URL and uses its optional initial URL only before the first controlled target. History API and fragment changes that emit no iframe load remain invisible. An iframe `error` event displays a transient load-failure notice until the next controlled load without changing URL history.

### Controller

Each tab's `BrowserController` owns address validation, commands and explicit restoration. `BrowserFrame` supplies carrier-neutral navigation state; `IframeImpl` uses `BrowserNavigation`, while `ElectronWebViewImpl` observes Chromium history. `BrowserPresentation` owns physical DOM attachment. Slot injection supplies `useBrowserState` and plain callbacks, keeping provider objects and observables out of the React body.

Desktop's main process approves guest leases and enforces attachment, navigation and permission policy. Preload exposes only scoped Browser operations. Shared declarations use the standard `/types` export with `import type`; the Host and Client compile through separate tsconfig files. Desktop Browser tabs declare `keepMounted`, so Sidebar preserves their DOM across tab changes, Session switches, collapse and floating.

The page refresh shortcut calls the same reload operation as the toolbar. Its tooltip and ARIA key combination follow the effective binding. Desktop routes accepted shortcuts from an approved guest through its owning window; the focused webview must still carry that guest’s lease. Web leaves browser-reserved combinations unchanged.

When the separately installed Computer Use plugin is available, the Desktop Browser reports only the active tab of the mounted Session to authenticated local Host routes. The guest sends page text, interactive accessibility labels from the top document and nested same-origin frames, and a bounded viewport or full-page PNG only after exact-origin approval; clicking, typing, pasting, replacing an input value, selecting text, using an exposed secondary action, pressing a bounded key chord and closing the selected tab each require a fresh user confirmation. Computer Use can open one new Browser tab in the mounted Session from an explicit canonical HTTP(S) URL or as an empty tab while another Browser tab is selected. Only a selected empty tab created by Computer Use is available to the agent, and navigation still requires target origin approval. Creation without a selected Browser anchor remains unavailable. An HTTP(S) tab is bound only after its observed URL is ready; a redirect destination is approved before its URL or title reaches the agent. Back and Forward use native history. Focus, close, unload and navigation invalidate pending reads and captures; switching tabs revokes an in-flight navigation result.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Right Sidebar](../../../docs/subsystems/sidebar-right.md) — tab composition, navigation, and lifecycle.
- [Document Preview](../ui-sidebar-documentpreview/README.md) — local source, Markdown, images, HTML, and PDF rendering.
- [Sidebar Browser decision](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.md) — iframe behavior and controller ownership.
- [Desktop Browser decision](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.md) — webview leases, CWD storage grouping and manual restoration.

-----

<a id="model-experience"></a>
## Model Experience

None, as Browser tabs register no tool or prompt; a separately installed Computer Use plugin logs approved page observations as its own tool results.

#### KV Cache effect

The Browser package adds no prompt content. Approved observations returned by Computer Use enter the model as ordinary logged tool results.

## Known Limitations and Deferred Work

Selected Sidebar `locator.innerText()` returns the exact visible text of one uniquely matched element when it is at most 24,000 characters; oversized text is refused after exact-origin approval, including an explicit same-origin frame. A hidden element is refused; form values, attributes, raw `textContent` and arbitrary live DOM evaluation are not exposed by this projection. Isolated real Electron tests cover visible text, frame text, hidden-element refusal and zero action approvals.

The isolated 0.1.7-rc.2 Desktop and Host source passed a private end-to-end test with one real selected Sidebar webview: Computer Use read its text and accessibility state, queried CSS, role, text, label, placeholder and test ID, then clicked an ordinary div, clicked inside a same-origin frame and filled by label. Each write action received its own one-use approval. The Sidebar supports getByRole, locator(CSS), getByText, getByLabel, getByPlaceholder, getByTestId and explicit frameLocator(CSS) with per-origin approval for cross-origin frames, with count, first/last/nth, read-only innerText/isVisible/isEnabled/isChecked, checked-state check/uncheck/setChecked, selectOption for bounded single- or multi-select values, click, double-click, fill, press, type and pressSequentially. Sequential input sends individual trusted keyDown/char/keyUp events after a single one-use action confirmation and checks the selected tab and focused target between characters; it accepts at most 256 Unicode code points and 1024 UTF-8 bytes, excluding control characters. Up to three selector steps may be chained as descendants; each may carry a `visible: true|false` filter, a `hasText`/`hasNotText` text filter or a relative `has`/`hasNot` chain of up to three descendant selector steps, and `first`/`last`/`nth` applies to the final result. One `and`/`or` composition combines two bounded locators in the same document or same explicit frame, deduplicating union matches; nested compositions are rejected. A query scans at most 100,000 elements in the top-level document or selected frame and returns only the match count, at most one fingerprinted reference and, for a requested state or visible-text projection, one bounded value. Relative chains may use local text or visibility filters and one further relative `has`/`hasNot` layer; deeper nesting, relative frames or positions, regular expressions, arbitrary DOM reads and full Playwright semantics remain unavailable. Explicit cross-origin frame locators support the separately qualified bounded operations after per-origin approval. The installed 0.1.7-rc.2 app lacks these source-native Sidebar changes; its plugin-only fallback passed isolated acceptance, while the native bridge remains unverified in an installed release.

Selected-tab `drag(from,to)` requires a fresh website grant and one-use action confirmation. The Client checks the viewport path and sends a bounded native mouse sequence to the same webview. Desktop intercepts drag data from only that owned guest and dispatches fixed Chromium drag-enter, drag-over and drop commands back to it; navigation, selection changes and failed commands cancel the short lease. `dropDispatched` distinguishes an HTML drop sent by Chromium from a pointer-only drag; it does not claim that the page accepted the drop. An isolated Electron fixture received trusted `dragstart` and `drop` events through this path. The native bridge has not yet completed acceptance in an installed Desktop release.

Computer Use reads the top-level Desktop document and nested same-origin iframe content, with separately approved bounded reads for cross-origin frames, and can capture or crop the visible viewport or the full page. Frame references contain a path of URL and document-revision tokens, bounded to eight levels. Full-page capture runs fixed Chromium commands in the main process, normalizes Retina output to CSS pixels, and has a 16-megapixel content limit and a 4 MiB PNG limit. Ref or coordinate clicks, text insertion, bounded key chords and wheel scrolling use Electron's webview input methods after the Host's approvals and a fresh page check. `typeText(null,text)` inserts into the currently focused editable element, including a same-origin frame, after checking that the focus stays on that element; password, disabled and read-only targets are refused. `paste()` accepts plain text, Markdown source or rich HTML for a focused editable target. Desktop temporarily stages the payload on the shared clipboard for the exact owned guest, calls native webview paste, requires a trusted input receipt, and restores all prior clipboard formats only if no newer copy has replaced the staged content. A 15-second timeout restores an abandoned lease. `setValue()` replaces text in an enabled, writable text/search/URL/telephone input or textarea, using native text insertion or Backspace after selecting its old value; other input types are refused. `selectText()` selects one unambiguous occurrence in an approved input or referenced element, with optional prefix/suffix disambiguation and before/after cursor placement; password inputs are refused. `performSecondaryAction()` accepts only exposed Focus, ShowMenu, Expand, Collapse, Increment and Decrement actions; it rechecks role and expansion state before sending a native click or key. Selected-tab `goto()`, `reload()`, Back and Forward wait for an observed destination or fail after 12 seconds; Back and Forward require an available native history entry. The Client returns only the observed URL and title for the Host's final origin check. A confirmed `close()` removes only the still-selected tab and withdraws its old handle. Approved cross-origin frames support bounded text, role summaries, explicit locator queries, screenshots and qualified native actions, including paste to a referenced editable target. The Desktop rechecks every exact frame origin and frame-tree fingerprint; unapproved origins or a changed frame tree withhold the result. Isolated Electron webview fixtures verify full-page capture and trusted click, text, key and paste input, including rich HTML and clipboard restoration. The isolated native Sidebar-to-Host flow has passed private Electron fixtures, including cross-origin plain-text and rich-HTML paste with trusted events and clipboard restoration. Complex real pages and the installed release remain unverified. The full Playwright API remains unavailable here.

Computer Use arms a short-lived debugger lease before selected-tab native actions so `alert`, `confirm`, `prompt`, or `beforeunload` can return an opaque dialog handle instead of blocking the Host command. Electron 44 does not implement native page `prompt()`, so a sandboxed guest preload replaces that function in the top-level document before page scripts run. Its synchronous call pauses the page while the owned guest's active lease awaits `accept()` or `dismiss()`; the page's question and default value stay inside the guest. Accepting without text uses that default, and dismissal or lease closure returns `null`. A prompt outside an agent action has no active lease and returns `null`. Subframes do not receive this preload, so their `prompt()` is not covered. `getJsDialog()` reads only the modal type and opaque handle; a fresh one-use confirmation is required to resolve it. Agent-initiated `goto()`, reload, Back, and Forward use a fixed, lease-bound navigation command in the guest's isolated script world so a page cannot replace the command and a user-activated `beforeunload` can be captured. Acceptance waits for the committed destination; dismissal keeps the source URL. Switching tabs, unrelated navigation, closing or leaving a dialog unattended releases the debugger and dismisses the modal. Isolated Electron, Client and authenticated Host-bridge fixtures cover these paths; the native bridge remains unverified in an installed DSH release.

<a id="known-limitations-and-deferred-work"></a>

The isolation policy deliberately gives up some browser compatibility:

- Many sites refuse iframe embedding or need downloads or top-level navigation withheld from the frame by the default sandbox. An HTTPS application can also block public HTTP pages as mixed content. Disabling the sandbox trades its restrictions for compatibility but does not bypass mixed-content or private-network policy. The unsandboxed frame can navigate the top-level application under browser activation rules and use downloads, modal dialogs, and input locks. It does not isolate the visited origin's cookies per Browser tab or prevent an in-frame page from choosing its own next URL.
- In Web, a popup that escapes the sandbox retains its opener and can use that chain to navigate the top-level application. Desktop handles popup creation separately.
- A later iframe load reveals that navigation occurred but not the new cross-origin URL. History API and fragment changes may remain invisible; Web Back and Forward are unavailable after the state becomes unknown.
- Browsers conceal many iframe failures for security: DNS, TLS, mixed-content, CSP, and `X-Frame-Options` failures may emit `load` or no actionable event instead of `error`. The load-failure notice is best-effort.
- Saved title and URL survive reloads and plugin unload while the tab remains in Sidebar's layout. Closing the tab removes its checkpoint. Restart restoration does not recover page memory, unsaved forms or Chromium's history stack.
- Local files are rejected and remain owned by Document Preview.
- Desktop shares process-local storage partitions by canonical workspace CWD; Sessions without a resolved Workspace are isolated separately. Cookies and Web storage do not survive application restart. Guest permissions, downloads and native popups are denied; approved HTTP(S) popup requests open Sidebar tabs. Host-address filtering is not a general private-network or DNS-rebinding firewall.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Each navigation provider owns its live state and publishes checkpoints directly; the UI consumes the same provider state through its controller.
