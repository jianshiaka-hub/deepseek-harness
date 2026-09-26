# Agent Note: 选中侧栏子 frame 的离页重试

Status: implemented

[English](2026-09-26-sidebar-beforeunload-replay.md) | 中文

## Problem

Electron 44 在 `will-prevent-unload` 之后同步完成跨源 iframe 的原生 `beforeunload` 回调。已选侧栏操作可能收到 DevTools 弹窗事件，但模态框会在代理答复前关闭。把已关闭的弹窗作为可操作句柄会误报页面状态；预先接受导航则会绕过代理的独立确认。

## Decision

Desktop 的单次操作弹窗租约只记录当前获准 frame 中脚本发起、同源 HTTP(S) 目标的 `Page.frameRequestedNavigation`，并在操作前保存 frame ID、网址和加载 ID。若 Chromium 随后以取消结果关闭该 frame 的 `beforeunload`，Desktop 保留不导出网页文字的不透明句柄。取消操作会保留原文档。

确认操作先复核当前选中的顶层 guest，以及原 frame ID、来源网址和加载 ID。Desktop 随后只向该 frame 发送一次 `Page.navigate`，并立即确认重试时同一 frame 的 `beforeunload`。只有 `Page.frameNavigated` 证实同一 frame 到达目标，且选中的顶层标签结束加载后才报告成功。原点击不会重放，因此点击前的网页脚本副作用不会重复执行。

## Alternatives considered

**跨代理往返保持第一次原生模态框。** Electron 的 `will-prevent-unload` 结果会同步完成回调，异步的代理决定无法继续持有该回调。

**自动接受第一次模态框。** 这会在代理另行给出一次性确认前发生导航。

**重试所有尝试的导航。** 有界 frame 请求无法重建或授权表单提交、POST 请求体和跨源目标，因此这些路径不会得到重试句柄。

## Consequences

重试只适用于同一已许可 frame 文档脚本发起的同源目标。缺少请求、文档已变化、无关弹窗、不支持的导航原因或超时均返回失败，不声称完成。该检查确认请求目标的 frame 提交；之后的重定向不由此检查证明，继续读取或操作前须重新观察并取得网站许可。隔离的侧栏 webview 到 Host 到 Computer Use 夹具分别验证了取消与确认；直接 Electron 夹具验证了 frame 请求和提交事件顺序。已安装签名版及复杂第三方网站仍未验收。
