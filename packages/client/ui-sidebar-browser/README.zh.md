---
description: "右侧 Sidebar 浏览器 tab：在 sandbox 中访问 HTTP(S) 页面，包括 loopback 服务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-browser

[English](README.md) | 中文

## 概述

在独立的右侧 Sidebar tab 中浏览 HTTP(S) 页面，包括 loopback 服务。Web 使用 iframe 和应用维护的 history；Desktop 使用 Electron `<webview>`、原生导航 history 和保活页面。本包不会向被访问内容注入 Electron 或 Node 能力。

## 目录

- [使用本包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Browser 在 Web profile 中默认禁用，在 Desktop 中默认启用。Web 用户可通过 profile patch 启用随附条目。可以从右侧 Sidebar guide 打开 **浏览器**并输入 HTTP(S) URL。Chat 的[链接偏好](../ui-chat/README.zh.md)选择**应用内侧边栏**时，HTTP(S) 链接会在此打开。不带 scheme 的主机名会补全为 HTTPS。公共目标与 loopback 目标使用相同的默认 sandbox。每次 guide 操作或委托到此的消息链接操作都会创建一个新的 Browser tab。

### 何时选择

当 Web 页面需要保留在当前 Session 旁时，选择 Browser。本地文件使用 [Document Preview](../ui-sidebar-documentpreview/README.zh.md)；站点拒绝 iframe 嵌入或需要本包不授予的浏览器 capability 时，使用明确的外部浏览器操作。

### 最小配置

本包没有插件配置字段。Web profile 通过其 profile patch 启用随附条目：

```yaml
- id: ui-sidebar-browser
  disabled: false
```

Client 插件可以调用 `ctx.sidebarRight.openTab('browser', { params: { url } })` 打开 tab。可选 URL 会在导航前接受与地址栏输入相同的校验。

命令 `browser.new` 在焦点停靠分栏打开独立浏览器页，替换开始页并保留已有内容页。从聊天区或浮动内容页触发时，使用活动停靠分栏。桌面默认键在 macOS 上为 Cmd+T，在 Windows 上为 Ctrl+T；Windows 和 macOS Web 使用[快捷键服务的平台默认值](../shortcuts/README.zh.md)；Linux Web 默认不绑定此命令。开始页按钮使用蓝色地球图标，并在按钮内显示有效快捷键，不额外弹出重复提示。

工具栏提供后退、前进、刷新、前往和在系统浏览器中打开。Web 还提供逐 tab sandbox 开关；关闭它是临时选择，并会显示警告。Desktop 显示观察到的页面标题。重启后，Browser 展示保存的标题和 URL；只有点击恢复或刷新才打开该地址。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

### 协议策略

地址解析器接受 HTTP 与 HTTPS，包括 loopback 目标。`file:` URL、脚本/data/blob 输入、内嵌凭据、DSH 应用自身 origin 和畸形地址会被拒绝。本地文件由 Document Preview 负责渲染。

### Iframe 载体

Web 默认使用 `sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"`。frame 没有直接的下载或顶层导航 flag。popup 会脱离 sandbox；在 Web 中，逃逸的 popup 会保留 opener，并可以导航顶层应用。被访问的 origin 可以使用自身 Cookie 与 Web storage，但跨域目标无法读取 DSH DOM、storage 或 API 响应。iframe 不发送 referrer，也不添加包自有的 Permissions Policy，因此浏览器默认策略与用户授权生效。toolbar 可以为当前 tab occurrence 移除 sandbox；该选择不持久化。未受 sandbox 约束的页面可以按浏览器 activation 规则导航顶层应用，并使用下载、模态对话框和输入锁定。本包不代理或探测远程页面。

Web 记录 toolbar 提交和 typed tab 打开。导航状态机把每个受控 revision 的第一次 iframe load 视为已知，把后续 load 视为页面已经变化到不可读取 URL 的证据。进入 unknown 状态后，地址会显示标记，后退、前进和外部打开会禁用，刷新则返回最后一个受控 URL。body 重挂载时会重新加载应用最后已知的 URL，并且仅在尚无受控目标时使用可选初始 URL。不产生 iframe load 的 History API 与 fragment 变化仍不可见。iframe `error` event 会显示临时加载失败 notice，直到下一个受控加载，但不会改变 URL history。

### Controller

每个 tab 的 `BrowserController` 负责地址校验、命令和显式恢复。`BrowserFrame` 提供与载体无关的导航状态；`IframeImpl` 使用 `BrowserNavigation`，`ElectronWebViewImpl` 观察 Chromium history。`BrowserPresentation` 负责 DOM 的物理挂载。Slot injection 提供 `useBrowserState` 和普通 callback，React body 不接收 provider 对象或 observable。

Desktop 主进程批准 guest 租约，并执行挂载、导航和权限策略。preload 只暴露限定范围的 Browser 操作。共享声明通过标准 `/types` 出口配合 `import type` 引入；Host 与 Client 使用独立 tsconfig 编译。Desktop Browser tab 声明 `keepMounted`，Sidebar 因而在切 tab、切 Session、收起与浮动期间保留其 DOM。

页面刷新快捷键调用工具栏使用的同一重载操作。其 Tooltip 和 ARIA 组合随有效绑定更新。Desktop 通过所属窗口路由已批准 guest 中的有效快捷键；获焦 webview 必须仍持有该 guest 的租约。Web 保留浏览器专用组合。

另行安装 Computer Use 插件后，Desktop Browser 只向已认证的本机 Host 路由报告已挂载 Session 的活动标签。精确来源网站获准后，guest 才会发送顶层文档及嵌套同源 iframe 的正文、可交互元素的可访问性标签，以及有大小上限的可见区域或整页 PNG；点击、输入、粘贴、替换输入框内容、选择文本、使用已列出的次要动作、按下有界组合键和关闭已选标签每次都需用户确认。已有一个 Browser 标签被选中时，Computer Use 可在当前 Session 用明确的规范 HTTP(S) 网址或空白页新建一个 Browser 标签。只有由 Computer Use 创建且仍被选中的空白标签才对代理可用，后续导航仍须取得目标网站许可；没有已选 Browser 标签作为锚点时仍不可新建。HTTP(S) 标签待实际网址就绪后才绑定；重定向后的实际网站获准后才向代理返回其网址或标题。后退与前进使用原生历史记录。切换焦点、关闭、卸载或导航会撤销待完成的读取和截图；切换标签也会撤销正在进行的导航结果。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [右侧 Sidebar](../../../docs/subsystems/sidebar-right.zh.md)——tab composition、导航与生命周期。
- [Document Preview](../ui-sidebar-documentpreview/README.zh.md)——本地源码、Markdown、图片、HTML 与 PDF 渲染。
- [Sidebar Browser 决策](../../../.agents/notes/implemented/feature/2026-09-16-sidebar-browser.zh.md)——iframe 行为与 controller 所有权。
- [Desktop Browser 决策](../../../.agents/notes/implemented/feature/2026-09-20-desktop-browser-webview.zh.md)——webview 租约、CWD 存储分组与手动恢复。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 Browser 标签本身不注册工具或 prompt；另行安装的 Computer Use 插件会把获准的网页观察作为自己的工具结果记录。

#### KV Cache 影响

Browser 包不增加 prompt 内容。Computer Use 返回的获准观察以普通、已记录的工具结果进入模型。

## 已知限制与延期工作

当前选中侧栏的 `locator.innerText()` 在精确来源网站获准后，只返回唯一匹配、可见元素的原样文字，最多 24000 字符；显式同源 frame 也可用。隐藏元素与超长文字会拒绝，此投影不开放表单当前值、任意属性、原始 `textContent` 或实时任意 DOM 执行。隔离 Electron 已验证顶层和 frame 文字读取、隐藏元素拒绝，读取不消耗操作确认。

独立的 0.1.7-rc.2 Desktop 与 Host 源码已通过私有端到端测试：Computer Use 从一个真实选中的侧栏 webview 读取文字和可访问性信息，以 CSS、角色、文本、标签、占位符和测试 ID 查询，随后点击普通 div、点击同源 frame 内元素并按标签填写；每次写入操作均经一次性确认。侧栏支持 getByRole、locator(CSS)、getByText、getByLabel、getByPlaceholder、getByTestId 和显式 frameLocator(CSS)（跨源 frame 须逐站许可），以及计数、首/末/指定位置、只读 `innerText`/可见性/启用状态/勾选状态查询、勾选/取消勾选/指定勾选状态、有界单选或多选下拉框选择、点击、双击、悬停、填入、按键、输入和 `pressSequentially`。逐字符输入经一次性确认，逐字发送可信 `keyDown`/`char`/`keyUp`，期间复核选中标签和焦点；限 256 个 Unicode 码点、1024 UTF-8 字节，不接受控制字符。最多三个选择器可按后代关系串联，每层可接 `visible: true|false`、`hasText`/`hasNotText` 或最多三级相对后代 `has`/`hasNot` 定位器链过滤，`first`/`last`/`nth` 只作用于最终结果。同一文档或同一显式 frame 内可用一次 `and`/`or` 组合两个有界定位器，并集去重；嵌套组合拒绝。每次查询最多扫描顶层或选中 frame 的 10 万个元素，只返回匹配总数、至多一个经指纹复核的引用；状态或可见文字投影另返回一个有界值。相对定位器链可使用局部文字或可见性过滤，也可再嵌套一层相对 `has`/`hasNot`；更深层嵌套、相对 frame 或位置选择、正则、任意 DOM 读取和完整 Playwright 语义仍不可用。显式跨源 frame 定位器的有界操作须逐站许可，并按单项验收范围使用。官方已安装的 0.1.7-rc.2 应用缺少这组源码原生桥接；插件后备路径已在隔离 profile 验收，原生桥接仍未在已安装发行版中验收。

当前选中标签的 `drag(from,to)` 需要先获逐站许可，再逐次确认。Client 检查视口路径，并向同一个 webview 发送有界的原生鼠标序列。Desktop 只截取该 guest 发起的拖放数据，再向同一个 guest 发送固定的 Chromium 进入、经过和投放命令；导航、切换标签或命令失败会取消短期租约。`dropDispatched` 区分 Chromium 已发送 HTML 投放与仅完成指针拖动，不表示网页已接受投放。隔离 Electron 夹具在这条路径上收到可信的 `dragstart` 和 `drop` 事件。原生桥接尚未在已安装 Desktop 发行版中完成验收。

Computer Use 读取 Desktop 顶层文档和嵌套同源 iframe；逐站许可后还可有界读取跨源 frame，并截取或裁剪可见区域或整页。frame 引用包含逐层网址和文档修订标记，最多八层。整页截图由主进程执行固定的 Chromium 命令，将 Retina 输出归一到 CSS 像素；页面内容限制在 1600 万像素以内，PNG 限 4 MiB。选中侧栏标签的引用或坐标点击、引用元素悬停、文本输入、有界组合键和滚动经 Electron webview 输入接口执行，前提是 Host 已批准且页面身份复核通过。`typeText(null,text)` 可在当前聚焦的可编辑元素（包括同源 frame）输入；发送前复核焦点仍在原元素，密码框、禁用或只读目标拒绝。`paste()` 支持普通文本、Markdown 源文本和富 HTML，可向当前聚焦的可编辑元素粘贴。Desktop 为精确归属的 guest 临时写入共享剪贴板，调用 webview 原生粘贴并要求可信输入回执；只有剪贴板仍是本次暂存内容时才还原所有原格式，废弃租约在 15 秒后自动清理。`setValue()` 先选中旧内容，再经原生文本插入或 Backspace 替换可用、可写的 text/search/URL/tel 输入框及 textarea；其他输入类型会拒绝。`selectText()` 可在获准输入框或引用元素中选择唯一匹配的文字，支持前缀/后缀消歧以及文字前后光标定位；密码输入框拒绝。`performSecondaryAction()` 只接受可访问性结果中已列出的聚焦、显示菜单、展开、折叠、增加和减少动作；原生点击或按键前复核角色及展开状态。选中标签的 `goto()`、`reload()`、后退和前进会等待观察到实际目标页，12 秒后仍未完成则失败；后退与前进要求有可用的原生历史条目。Client 只向 Host 返回实际观察到的网址和标题，供最终网站许可复核。确认后的 `close()` 只移除仍选中的标签，并撤销旧句柄。已许可的跨源 iframe 支持有界正文、角色摘要、显式定位器查询、截图及已验收的原生操作，包括向引用的可编辑目标粘贴。Desktop 会复核每个 frame 的精确来源和 frame 树指纹；未获许可或 frame 树变化时不返回结果。隔离 Electron webview 夹具已验证整页截图，以及可信点击、文本、按键和粘贴输入，包含富 HTML 和剪贴板恢复；隔离的 Sidebar 到 Host 原生链路已通过私有 Electron 夹具，包括跨源纯文本和富 HTML 粘贴的可信事件及剪贴板恢复；复杂真实网页和已安装发行版仍未验收。此处尚不提供完整 Playwright API。

Computer Use 会在选中标签的原生操作前建立短期调试租约，使 `alert`、`confirm`、`prompt` 或 `beforeunload` 能先返回不透明弹窗句柄，而不阻塞 Host 命令。Electron 44 没有原生网页 `prompt()`，因此受 sandbox 约束的 guest preload 在顶层文档的网页脚本运行前替换这个函数：同步调用暂停网页，直到归属同一 guest 的有效租约收到 `accept()` 或 `dismiss()`；提示语和默认值留在 guest 内。确认但不提供文字会采用网页默认值，取消或租约关闭会返回 `null`。代理操作之外没有有效租约的 prompt 直接返回 `null`。同源子 frame 在租约期间会把 `alert()`、`confirm()` 和 `prompt()` 转交给受控顶层 frame；明确获准的跨源 frame 使用 Electron 原生弹窗处理。`getJsDialog()` 只读取弹窗类型和不透明句柄；处理仍须单次确认。代理发起的 `goto()`、重载、后退和前进走 guest 隔离脚本世界里的固定、绑定租约的导航命令，使网页无法替换命令，并能捕获已获用户激活页面的 `beforeunload`。确认后等待实际到达的网址；取消则保留原网址。切换标签、无关导航、关闭或长时间不处理会释放调试器并取消弹窗。隔离 Electron、Client 与已认证 Host 桥接夹具覆盖了这些路径；原生桥接仍未在已安装 DSH 发行版中验收。

若跨源 iframe 的原生 `beforeunload` 在代理答复前被同步关闭，Desktop 只在 Chromium 事先观察到该已授权 frame 的脚本发起、同源 HTTP(S) 目标时保留合成句柄。确认时复核 frame ID、来源网址与原文档加载 ID，只对该 frame 执行一次 `Page.navigate`，确认重试产生的离页弹窗，并等待该 frame 提交及当前选中的顶层标签恢复稳定；取消则原 frame 留在原处。文档已变化、导航原因不符或目标跨源时不能使用这条重试路径。隔离侧栏到 Host 的夹具已分别验证单次取消与确认，已安装发行版仍未验收。

<a id="known-limitations-and-deferred-work"></a>

隔离策略有意放弃部分浏览器兼容性：

- 很多站点拒绝 iframe 嵌入，或需要默认 sandbox 不向 frame 授予的下载与顶层导航。HTTPS 应用还可能按 mixed-content 策略阻止公共 HTTP 页面。关闭 sandbox 会用自身限制换取兼容性，但不会绕过 mixed-content 或 private-network 策略。未受 sandbox 约束的 frame 可以按浏览器 activation 规则导航顶层应用，并使用下载、模态对话框和输入锁定。该模式不会按 Browser tab 隔离被访问 origin 的 Cookie，也无法阻止 iframe 内页面自行选择后续 URL。
- 在 Web 中，逃逸出 sandbox 的 popup 会保留 opener，并可以通过该链导航顶层应用。Desktop 会单独处理 popup 创建。
- 后续 iframe load 能表明发生了导航，但无法给出新的跨域 URL。History API 与 fragment 变化可能仍不可见；状态变成 unknown 后，Web 的后退与前进不可用。
- 出于安全原因，浏览器会隐藏很多 iframe 失败：DNS、TLS、mixed-content、CSP 与 `X-Frame-Options` 失败可能触发 `load`，也可能不提供可操作 event，而不是触发 `error`。加载失败 notice 只能作为 best-effort 提示。
- 只要 tab 仍在 Sidebar 布局中，保存的标题和 URL 就会跨刷新与插件卸载保留。关闭 tab 会删除其检查点。重启恢复不恢复页面内存、未保存的表单或 Chromium history 栈。
- 本地文件会被拒绝，并继续由 Document Preview 负责。
- Desktop 按规范化的工作区 CWD 共享进程内存储分区；没有解析到 Workspace 的 Session 单独隔离。Cookie 与 Web storage 不跨应用重启保留。guest 权限、下载与原生 popup 均被拒绝；通过检查的 HTTP(S) popup 请求会打开 Sidebar tab。Host 地址过滤不是通用私网或 DNS-rebinding 防火墙。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变量：** 不发布 companion。每个导航 provider 拥有自身的实时状态并直接发布检查点；UI 通过 controller 消费同一份 provider 状态。
