# Agent Note: Selected Sidebar subframe unload replay

Status: implemented

English | [中文](2026-09-26-sidebar-beforeunload-replay.zh.md)

## Problem

Electron 44 resolves a foreign iframe's native `beforeunload` callback synchronously after `will-prevent-unload`. A selected Sidebar action can produce a DevTools dialog event, but the modal may close before the agent can answer it. Exposing that closed dialog as an actionable handle would misreport the page state; accepting the navigation in advance would bypass the agent's separate confirmation.

## Decision

The one-action Desktop dialog lease records `Page.frameRequestedNavigation` only for a script-initiated, same-origin HTTP(S) destination in a currently approved frame. It captures the frame ID, URL and loader ID before the action. If Chromium closes that frame's `beforeunload` with a cancellation, Desktop retains an opaque handle without exporting page text. Dismissal leaves the original document intact.

Acceptance first checks that the selected top-level guest and the original frame ID, source URL and loader ID still match. Desktop then sends one `Page.navigate` to that frame and immediately accepts only the retry's matching `beforeunload`. It reports success after `Page.frameNavigated` confirms the same frame and destination and the selected top-level tab finishes loading. The click is never replayed, so its preceding page-script side effects are not repeated.

## Alternatives considered

**Hold the first native modal across the agent round trip.** Electron's `will-prevent-unload` result completes the callback synchronously, so an asynchronous agent decision cannot keep that callback alive.

**Automatically accept the first modal.** This would navigate before the agent's separate one-use confirmation.

**Replay any attempted navigation.** Form submissions, POST bodies and cross-origin destinations cannot be reconstructed or authorized from the bounded frame request. Those paths do not receive a replay handle.

## Consequences

The replay path is deliberately limited to a script-initiated same-origin destination from the same approved frame document. A missing request, changed document, unrelated dialog, unsupported navigation reason or timeout fails rather than claiming completion. The check confirms the requested frame commit; a later redirect is not established by that check and needs fresh observation and website approval before further reads or actions. The isolated Sidebar webview-to-Host-to-Computer Use fixture confirms separate dismissal and acceptance; a direct Electron probe confirms the frame request and commit event sequence. The installed signed Desktop release and complex third-party sites remain unverified.
