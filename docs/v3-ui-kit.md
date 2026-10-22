# v3 界面组件

主窗口、设置、引导、字幕窗和答题框共用一套样式和小工具，都在 `src/renderer/shared/`。风格照 Raycast：暗色优先、中性灰、强调色只给主按钮和选中态。打开 `styleguide.html` 能看到全部组件和一个主窗口骨架（侧栏 + 会议列表 + 会议详情）。

| 文件 | 内容 |
|---|---|
| `tokens.css` | 颜色、字体、圆角、间距、尺寸、阴影、动效、层级变量。深浅两套写在一起，跟随系统 |
| `ui.css` | 全部组件的样式和状态（hover、选中、聚焦、禁用、加载） |
| `icons.js` | Lucide 的 64 个图标（ISC 许可，来源和许可证写在文件头），`ui.icon()` |
| `ui.js` | 小工具，挂在 `window.ui`：建节点、快捷键、开关、分段、下拉、菜单、弹层、提示气泡、toast、模态框、命令面板、列表键盘导航 |
| `bilingual.js` + `bilingual.css` | v4 双语意群对照：一句英文和它的中文按意群同色，术语两边都画虚线，挂在 `window.bilingual`（见文末） |
| `styleguide.html` + `styleguide.js` | 展示页。页面 CSP 不许内联脚本，所以脚本单独放一个文件 |

## 在页面里引入

页面放在 `src/renderer/<页面>/index.html`，用相对路径 `../shared/`。`src/**` 本来就打进安装包，不用改 electron-builder 配置。

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:" />
<link rel="stylesheet" href="../shared/tokens.css" />
<link rel="stylesheet" href="../shared/ui.css" />
<link rel="stylesheet" href="style.css" />      <!-- 页面自己的样式放最后 -->
...
<script src="../shared/icons.js"></script>
<script src="../shared/ui.js"></script>
<script src="app.js"></script>
```

- CSP 里要有 `img-src data:`：原生下拉 `select.select-native` 的箭头是 data URL。
- 两个脚本都是普通 `<script>`，不用 `type="module"`。加载完就有 `window.ui`。
- 所有从模型、用户、文件来的文字一律走 `textContent`：`ui.el(..., { text })` 或把字符串当子节点传进去。`ui.js` 里没有 `innerHTML`，`ui.el` 收到 `html` 属性会忽略并警告。
- `ui.css` 给 `body` 设了 13px、`user-select: none`、`overflow: hidden`。要滚动的区域自己加 `overflow-y: auto`（现成的有 `.pane-body`、`.sidebar-scroll`）；正文要能选中就加 `.selectable`（`.prose`、输入框默认能选）。

## 主题和窗口外观

**跟随系统。** 每个颜色变量都写成 `light-dark(浅色值, 深色值)`，`:root` 是 `color-scheme: light dark`，系统换主题页面自动跟着换，不用 JS。

**强制主题。** `ui.setTheme('dark' | 'light' | 'system')`，等于设置或去掉 `html[data-theme]`。主进程已经按设置改 `nativeTheme.themeSource`（P 的 main.js），页面的 `prefers-color-scheme` 会跟着变，所以一般不用调 `setTheme`。Mac 毛玻璃和 Windows 标题栏按钮只跟 `nativeTheme` 走，不看 `data-theme`，所以主题一定要在主进程改，页面里单独强制会出现浅色字配深色毛玻璃。

**局部深色。** 给任意元素加 `.scheme-dark`（或 `.scheme-light`），里面的变量整块换成那一套。`.hud` 自带深色。

**窗口材质。** 页面拿到 `init()` 的 `chrome` 后调一次：

```js
const info = await window.app.init();
ui.applyChrome(info.chrome); // { platform, material: 'vibrancy' | 'mica' | 'none', titleBarHeight, trafficLights }
```

- `material: 'vibrancy'` 时给 `body` 加 `.vibrancy`：窗口背景透明，`.app-sidebar` 露出系统毛玻璃，`.app-main` 保持实色 `--bg`，侧栏里的次要文字换成带透明度的颜色。
- `material: 'mica'` 时加 `.mica`：整窗透出 Mica，`.app-main` 叠一层半透明 `--bg-layer`，左上角 10px 圆角。
- `material: 'none'` 时侧栏用实色 `--bg-sidebar`。
- Mac 上按红绿灯位置算 `--titlebar-h = 2 × y + 16`，保证红绿灯和标题栏上下居中：P 现在的 `{ x: 16, y: 13 }` 得到 42px，改成 `{ x: 18, y: 18 }` 是 52px（Raycast 和系统设置的高度，展示页截图用的是这个）。Windows 上 `--titlebar-h` 等于 `titleBarHeight`（40px）。

**拖动区。** `.drag`、`.titlebar`、`.sidebar-top` 是拖动区；里面的 `button`、`input`、`select`、`textarea`、`a`、`label`、`[tabindex]` 和 `.no-drag` 自动可以点。`.pane-header.drag` 让面板头也能拖窗口。

**Windows 右上角系统按钮。** 顶栏最右边那块加 `.titlebar-safe-end`，按 `env(titlebar-area-*)` 自动让出三个按钮的宽度。

**悬浮窗。** 字幕窗和答题框的 `body` 加 `.is-transparent`，内容包在 `.hud` 里。

## 变量

深色值在前，浅色值在后。页面样式只用变量，不写死颜色。

| 变量 | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `--bg` | #1b1b1d | #ffffff | 窗口和内容区背景 |
| `--bg-sidebar` | #202023 | #f3f3f5 | 没有毛玻璃时的侧栏 |
| `--bg-inset` | #161618 | #f6f6f8 | 内陷区（代码块、字幕记录底色） |
| `--bg-elevated` | #252528 | #ffffff | 模态框 |
| `--bg-popover` | 37,37,40 @ 0.88 | 252,252,253 @ 0.9 | 菜单、命令面板、toast（配 `--blur-pop` 毛玻璃） |
| `--bg-backdrop` | 黑 @ 0.42 | 20,20,30 @ 0.16 | 模态框背后的遮罩 |
| `--bg-layer` | 32,32,34 @ 0.7 | 白 @ 0.72 | Mica 时内容区的半透明层 |
| `--fill-1` 到 `--fill-4` | 白 @ 0.04 / 0.07 / 0.10 / 0.14 | 黑 @ 0.028 / 0.048 / 0.07 / 0.10 | 叠加表面：悬停、底色、选中、按下 |
| `--stroke-soft` / `--stroke` / `--stroke-strong` | 白 @ 0.05 / 0.08 / 0.14 | 黑 @ 0.05 / 0.09 / 0.15 | 描边和分隔线 |
| `--text` / `--text-2` / `--text-3` | #ececec / #9a9aa0 / #6b6b70 | #1d1d1f / #6c6c72 / #9c9ca2 | 正文、次要、更弱 |
| `--btn-bg`、`--btn-bg-hover`、`--btn-bg-active`、`--btn-stroke` | 半透明白 | 白底、浅灰 | 普通按钮 |
| `--field-bg`、`--field-stroke`、`--field-stroke-hover` | 半透明白 | 白底 | 输入框 |
| `--accent` | #7176ff | #5a5ff0 | 强调色（蓝紫，和应用图标呼应） |
| `--accent-bg`、`-hover`、`-active` | #5e62f2 起 | #5a5ff0 起 | 主按钮、开关打开、勾选 |
| `--accent-text` | #a3a6ff | #4a4fdc | 链接、菜单里的勾、命中字 |
| `--accent-soft`、`--accent-ring` | | | 选中底色、聚焦光圈 |
| `--green` `--yellow` `--red` `--blue`（各带 `-soft`） | | | 成功、警告、出错、信息 |
| `--me`、`--other`、`--question`（各带 `-soft`） | 绿、蓝、琥珀 | | 实时记录里的我、对方、提问 |
| `--tr` | #f2c75c | #946300 | 译文（和图标上的黄色呼应） |
| `--c-gray` `--c-red` `--c-orange` `--c-yellow` `--c-green` `--c-teal` `--c-blue` `--c-indigo` `--c-purple` `--c-pink` | | | 项目颜色和图标方块，两套主题通用 |

其他变量：

- 字体：`--font-sans`（Mac 走系统字体 SF 和苹方，Windows 走 Segoe UI Variable 和 Microsoft YaHei UI）、`--font-mono`；字号 `--fs-xs` 11、`--fs-sm` 12、`--fs` 13、`--fs-md` 14、`--fs-lg` 15、`--fs-xl` 17、`--fs-2xl` 22；行高 `--lh-tight` 1.25、`--lh` 1.4、`--lh-prose` 1.6。
- 圆角：`--r-xs` 4、`--r-sm` 6、`--r-md` 8、`--r-lg` 10、`--r-xl` 12、`--r-full`。间距：`--sp-1` 到 `--sp-8`（4px 网格）。
- 尺寸：`--control-h` 28、`--control-h-sm` 24、`--control-h-lg` 36、`--row-h` 40、`--row-h-sm` 32、`--nav-h` 30、`--sidebar-w` 232、`--titlebar-h`、`--traffic-end`。
- 阴影：`--shadow-sm`、`--shadow-control`、`--shadow-pop`、`--shadow-modal`、`--blur-pop`。
- 动效：`--dur-fast` 120ms、`--dur` 150ms、`--dur-slow` 180ms、`--ease`；系统开了「减少动态效果」时全部变 0。
- 层级：`--z-popover` 1000、`--z-modal` 1100、`--z-palette` 1200、`--z-toast` 1300、`--z-tip` 1400。
- 悬浮窗：`--hud-bg`（28,28,30 @ 0.86）、`--hud-stroke`、`--hud-shadow`、`--hud-radius` 12px。

## 组件

### 文字

`.title-2xl`（22px）、`.title-xl`（17px 半粗，页面标题）、`.title-lg`（15px 半粗，面板标题）、`.text-2`、`.text-3`、`.text-sm`、`.text-xs`、`.mono`、`.num`（等宽数字，计时和日期用）、`.truncate`（单行省略）。分组标题 `.section-title`（12px 半粗），分隔线 `.divider`，竖线 `.vr`。

### 按钮

```html
<button class="btn btn-primary"><svg class="icon">…</svg>开始会议</button>
```

- 种类：`.btn`（默认）、`.btn-primary`（一屏最多一个）、`.btn-ghost`、`.btn-danger`（红字）、`.btn-danger-solid`（确认删除）。
- 尺寸：`.btn-sm` 24px、默认 28px、`.btn-lg` 36px；方形图标按钮加 `.btn-icon`；占满一行 `.btn-block`。
- 状态：`disabled` 或 `aria-disabled="true"`；加载中加 `.is-loading`（文字隐藏，中间转圈，宽度不变）。
- 按钮里放快捷键：图标、文字、`ui.kbd(..., { size: 'sm' })` 依次放进去。
- 拆分按钮：`.btn-group` 包两个按钮，比如「在「XX」里开始会议」加一个 `.btn-icon` 的下拉箭头。

### 快捷键徽标

`ui.kbd('CommandOrControl+Shift+K')` 生成 `<span class="kbd-group"><span class="kbd">⌘</span>…</span>`。Mac 显示 ⌘ ⇧ ⌥ ⌃ ↵，Windows 显示 Ctrl、Shift、Alt、Enter。参数可以是 Electron 快捷键字符串、`'⌘K'` 这种符号串或数组 `['↑', '↓']`。小号 `{ size: 'sm' }`。纯文字版 `ui.accelText(accel)`：Mac「⌘⇧K」，Windows「Ctrl+Shift+K」。

### 图标方块和颜色

```js
ui.iconBox('graduation-cap', 'indigo')                   // 24px 实色底 + 白色线条图标（列表行、项目）
ui.iconBox('folder', 'teal', { size: 'sm' })             // 18px（侧栏、菜单）
ui.iconBox('mic', 'red', { size: 'lg' })                 // 40px
ui.iconBox('folder', 'orange', { variant: 'soft' })      // 浅底 + 彩色图标
```

颜色名：`ui.tints` = gray、red、orange、yellow、green、teal、blue、indigo、purple、pink。任何元素加 `data-tint="blue"` 就有 `--tint` 变量，`.tag`、`.dot-tint`、`.menu-swatch` 都认它。项目的 `color` 字段建议直接存这些名字。

### 圆点、标签、计数、头像

- `.dot` 7px 圆点：`.dot-ok`、`.dot-warn`、`.dot-error`、`.dot-accent`、`.dot-tint`、`.dot-live`（红点呼吸，录音中）。
- `.tag` 20px 小标签；`data-tint` 变成彩色；`.tag.tag-dot[data-tint]` 是灰底加彩色圆点（项目标签）；另有 `.tag-accent`、`.tag-me`、`.tag-other`、`.tag-question`、`.tag-warn`、`.tag-error`、`.tag-ok`。
- `.count` 灰色数字（侧栏会议数、标签页计数）。
- `.avatar`（24px，`.lg` 36px）首字母头像，ChatGPT 账号用。

### 转圈、音量条、进度

- `ui.spinner(size)` 或 `<span class="spinner">`。
- 音量条：`<div class="meter meter-me" style="--value: 62%"><i></i></div>`，`.meter-other` 是对方的颜色。改 `--value` 就行，宽度过渡 80ms。
- 进度：`.progress` 同样用 `--value`；不知道进度时加 `.is-indeterminate`。

### 开关和勾选

- 开关就是复选框加类：`<input type="checkbox" class="toggle" role="switch">`，小号再加 `.toggle-sm`。`data-key` 绑定照旧能用。
- `ui.toggle({ checked, disabled, onChange(checked), label, description, size })`：不给 `label` 返回 input；给了返回 `<label class="toggle-field">`（文字在左、开关在右），input 在 `.input` 属性上。
- 待办的圆形勾选：`<input type="checkbox" class="check">`；方形加 `.square`。

### 分段控件

`ui.segmented({ options: [{ value, label, icon, title, disabled }] | ['a', 'b'], value, onChange(value), size: 'sm', block, ariaLabel })`。返回 `.seg`，`el.value` 可读可写（赋值不触发 onChange）。左右键切换。手写 HTML 时选中按钮加 `aria-checked="true"`。

### 输入框、搜索框、下拉

- `.input`（28px）、`.input-lg`、`.input-sm`、`textarea.input`；出错加 `aria-invalid="true"` 或 `.is-invalid`，下面放 `.form-hint.is-error`。
- `.input-bare`：没框的输入框，悬停才有底色，用来直接改项目名、会议标题（和 `.title-xl` 一起用）。
- 带图标的输入框：`<label class="field"><svg class="icon">…</svg><input>…kbd…</label>`。
- 侧栏顶部的搜索入口：`<button class="search-trigger">图标<span>搜索</span>kbd</button>`，点开是命令面板。
- 少量选项、要原生弹出的：`<select class="select-native">`。
- 自绘下拉：`ui.select({ options | groups: [{ title, options }], value, onChange(value, option), placeholder, searchable, block, width, disabled })`。选项 `{ value, label, icon, tint, description, keywords, disabled }`。返回按钮，`el.value` 可读可写，`el.setOptions(options, value)` 换选项。选项超过 8 个自动出搜索框。

### 表单行（设置窗口）

```html
<div class="form">
  <section class="form-section">
    <h3 class="form-section-title">通用</h3>
    <p class="form-section-desc">一句说明（可选）</p>
    <div class="form-row">
      <div class="form-label">主题</div>
      <div class="form-control">…控件…<div class="form-hint">说明</div></div>
    </div>
  </section>
</div>
```

标签右对齐，列宽用 `--form-label-w`（默认 180px）调；分组之间靠分隔线和留白，不套卡片。窗口窄于 620px 时标签自动放到控件上面。一行放几个控件用 `.form-inline`。

### 列表

```js
ui.listItem({
  id, icon: 'mic', tint: 'indigo', title, subtitle,
  accessories: ['14:30', { icon: 'circle-check', text: '3' }, { tag: '周五', tint: 'yellow' }, { kbd: 'CommandOrControl+1' }, { dot: 'warn' }],
  twoLine, compact, selected, onClick, className, titleIndices,
})
```

- `.list` 容器（左右 8px 内边距），`.list-item` 行高 40px，`.two-line` 52px（标题一行、副标题一行，会议列表用），`.compact` 32px。
- 左边 24px 图标方块或 16px 灰色图标，然后 `.li-title`、`.li-subtitle`（同一行灰字），右边 `.li-accessories`。
- 选中 `.is-selected` 或 `aria-selected="true"`；禁用 `.is-disabled`；加载中的一行 `.list-loading`。
- 上下键和回车交给 `ui.listNav`（见下文）。

### 窗口骨架和侧栏

```html
<div class="app">
  <aside class="app-sidebar">
    <div class="sidebar-top"></div>                       <!-- Mac 红绿灯的位置，也是拖动区 -->
    <nav class="sidebar-scroll">
      <button class="search-trigger">…</button>
      <a class="nav-item is-active"><svg class="icon">…</svg><span class="nav-label">首页</span></a>
      <div class="nav-section"><span>项目</span><button class="btn btn-ghost btn-icon btn-sm">+</button></div>
      <a class="nav-item">[iconBox sm]<span class="nav-label">硕士论文</span><span class="count">12</span></a>
      <button class="nav-item is-muted">+ 新建项目</button>
    </nav>
    <div class="sidebar-footer">
      <div class="status-strip"><button class="status-chip"><span class="dot dot-warn"></span>识别</button>…</div>
      <button class="nav-item">设置 kbd</button>
    </div>
  </aside>
  <main class="app-main">…</main>
</div>
```

- `.nav-item` 30px，当前项 `.is-active` 或 `aria-current="page"`；分组标题 `.nav-section` 里的按钮悬停才出现。
- `.status-chip` 是底部状态小条的一项（圆点 + 名字），点了去对应设置。
- 红绿灯同一行要放按钮时用 `.sidebar-top.inline`，内容从 `--traffic-end` 开始。

### 分栏、面板头、动作条

- `.split`：左边 `var(--split-w, 320px)`，右边自适应；每栏 `.pane`，栏头 `.pane-header`（高度 `--titlebar-h`，加 `.drag` 可拖窗口），内容 `.pane-body`（自己滚动）。
- `.titlebar`：独立的顶栏（主区域没有分栏时用）。
- `.action-bar`：Raycast 那种底部动作条，40px。左边 `.action-bar-context`（小图标方块 + 当前位置），右边 `button.action`（文字 + kbd），中间用 `.action-sep` 隔开。

### 标签页

`.tabs` 里放 `button.tab`，当前的加 `aria-selected="true"`（或 `.is-active`），后面可以跟 `.count`。默认是圆角底色（项目页）；`.tabs.tabs-line` 是下划线版（会议详情）。

### 步骤条（首次引导）

`ui.steps({ steps: ['录声纹', '连接 AI', '语音识别', '建第一个项目', '试一下'], current: 0 })` 返回 `<ol class="steps">`，`el.set(i)` 切到第 i 步。做完的打勾，当前一步强调色。

### 菜单、弹层、提示气泡、术语

- `ui.menu(anchor, items, { align: 'start' | 'end', placement: 'bottom' | 'top', searchable, placeholder, minWidth, onSelect, onClose })`：锚定在元素下方（放不下自动翻到上方，贴边时收在窗口里）；`anchor` 也可以是 `{ x, y }`（右键菜单）。
  - 项：`{ label, icon, tint, description, kbd, hint, checked, danger, disabled, keywords, onSelect }`，分隔线 `'sep'`，分组标题 `{ section: '标题' }`。
  - 上下键、回车、Esc，鼠标移动跟着选中；选中一项或按 Esc 关掉后焦点回到锚点；点外面、窗口失焦、改窗口大小都会关；同一个锚点再点一次就收起。
  - 返回 `{ el, close(), isOpen(), update(items) }`。
- `ui.popover(anchor, content, { align, placement, className, onClose })`：通用弹层（`.popover`），比如「为什么要录声纹」的说明。
- `ui.tip(el, '文字' | { title, text } | (el) => 内容, { delay: 250, placement })`：悬停提示，返回解绑函数。
- `ui.tipDelegate(root, '.term', (termEl) => ({ title, text }))`：委托版，列表经常重画时用（实时记录里的术语就用它）。锚点被删掉、列表滚动时气泡自动收起。
- 字幕里的术语：`<span class="term">ablation</span>`，虚线下划线，悬停加深。

### 模态框

```js
ui.modal({
  title, description, body,                   // body 是节点或字符串
  actions: [{ label: '取消' }, { label: '创建', kind: 'primary', onClick: async (ctx) => { … } }],
  width, dismissible, onClose(reason), initialFocus,
})
```

- `kind`：`'primary'`、`'danger'`、`'ghost'` 或不写；`'spacer'` 把后面的按钮推到右边。
- `onClick` 返回 `false` 不关；返回 Promise 时按钮转圈，结果是 `false` 也不关（表单校验不过就返回 false）。
- Esc 关，回车触发主按钮（文本域里不触发），Tab 在框内循环，关掉后焦点回到打开前的位置。
- `ui.confirm({ title, message, okLabel, cancelLabel, danger })` 返回 `Promise<boolean>`。

### 命令面板

```js
ui.hotkey('CommandOrControl+K', () => {
  const open = ui.commandPalette.current();
  if (open) return open.close();
  ui.commandPalette({
    groups: [
      { title: '命令', items: [{ id: 'start', title: '开始会议', subtitle: '在「硕士论文」里', icon: 'mic', tint: 'red', kbd: 'CommandOrControl+Shift+R', actionLabel: '开始', onSelect }] },
      { title: '项目', items: projects.map((p) => ({ id: p.id, title: p.name, icon: p.icon, tint: p.color, accessory: `${p.meetings} 场会议` })) },
    ],
    // 主进程搜索：会议标题、纪要、字幕、待办。结果不再本地过滤，只高亮
    source: async (q) => {
      const r = await window.app.search(q);
      return [{ title: '会议', items: r.sessions.map((s) => ({ id: s.id, title: s.title, subtitle: s.projectName, snippet: s.snippet, icon: 'message-square-text', tint: 'indigo', actions: [...] })) }];
    },
    onSelect: (item, group) => { … },
    context: { icon: 'command', tint: 'indigo', label: '会议字幕' },   // 底部动作条左边
  });
});
```

- 项：`{ id, title, subtitle, snippet（第二行灰字，搜索命中片段）, icon, tint, accessory, kbd, keywords, actions, actionLabel, onSelect, keepOpen, searchOnly }`。
- 本地项按标题、副标题、`keywords` 模糊匹配（子串优先，其次按顺序出现的字，词首加分），命中的字标成 `.hl`。
- `source` 有 120ms 防抖，旧请求的结果会丢掉；等结果时右上角转圈，旧结果先留着不闪。
- 键盘：上下键、回车、Esc（有字先清空，再按才关）、⌘K / Ctrl+K 打开所选项的 `actions` 菜单。输入法组字时的回车和方向键不处理。
- 返回 `{ el, input, close(), setGroups(groups), refresh() }`；`ui.commandPalette.current()` 拿到当前打开的面板。

### toast

`ui.toast('纪要已复制')` 或 `ui.toast({ title, message, type: 'success' | 'error' | 'warning' | 'info' | 'loading', duration, action: { label: '撤销', onClick }, closable })`。从底部中间弹出，最多同时 3 条；普通 2.6 秒，带操作 5 秒，出错 6 秒且带关闭按钮，`loading` 一直在；鼠标停在上面不消失。返回 `{ el, update(opts), close() }`，常见用法是先 `loading` 再 `update({ type: 'success', title })`。

### 空状态、引导块

- `ui.emptyState({ icon, title, description, action: { label, icon, primary, onClick } })` 生成 `.empty`。
- `.callout`（图标 + `.callout-body` 里的 `.callout-title`、`.callout-desc` + 可选按钮）；`.callout-accent` 用于「还没录声纹」这类引导，`.callout-warn` 用于权限说明，`.callout-error` 用于失败。

### 长文

纪要（marked 渲染的 HTML）放进 `.prose`：14px、行高 1.6，标题、列表、引用、代码、表格都有样式。

### 悬浮窗

`.hud`：深色半透明（`--hud-bg`）、1px 细描边、12px 圆角、柔和阴影、背景模糊，里面自动用深色变量。标题条 `.hud-header`（32px，图标 + 标题 + `.spacer` + 小号 kbd + 关闭按钮）。字幕里的译文用 `--tr`，术语用 `.term`。

## ui.js 其他函数

| 函数 | 说明 |
|---|---|
| `ui.el(spec, props, ...children)` | `spec` 可以写 `'div.row.is-active#id'`。`props`：`text`、`class`（字符串或数组）、`style`（字符串或对象，支持 `--变量`）、`dataset`、`attrs`、`on: { click }`、`onClick` 这类、`aria-*`、`role`，其余当属性或 attribute。子节点里的字符串和数字变文本节点，数组展开，`null`/`false` 跳过 |
| `ui.clear(node)` | 清空子节点 |
| `ui.icon(name, size = 16, { strokeWidth, title, class })` | 返回 SVG 节点；`ui.iconSvg()` 返回字符串（只含 icons.js 里的固定数据）；`ui.hasIcon(name)`、`ui.iconNames`、`ui.projectIcons`（新建项目可选的 15 个） |
| `ui.hotkey(accel, handler, { allowInInput, target, capture })` | 页面内快捷键，`CommandOrControl` / `Mod` 在 Mac 是 ⌘、Windows 是 Ctrl。带 Cmd/Ctrl/Alt 的组合默认在输入框里也生效。字母按物理键匹配，Mac 上按 Option 也能认。返回解绑函数 |
| `ui.matchAccel(event, accel)`、`ui.formatAccel(accel, platform)`、`ui.accelText(accel, platform)` | 快捷键匹配和显示 |
| `ui.listNav(container, opts)` | 给任意列表加键盘：上下键、PageUp/PageDown、Home/End、回车，Mac 上 Ctrl+N/P 也能移动。`opts`：`itemSelector`（默认 `.list-item, .menu-item, .palette-item, [data-nav-item]`）、`keyTarget`（比如列表上方的搜索框，此时自动设 `aria-activedescendant`）、`onOpen(item, event)`（默认 `item.click()`）、`onSelect(item)`、`selectOnHover`、`openOnClick`、`loop`、`initial`（-1 表示不预选）。会跳过隐藏和禁用的行，选中的行滚进可见区域，输入法组字时不响应。返回 `{ select(itemOrIndex), move(delta), open(), items(), selected(), refresh(keepId), destroy() }`，列表重画后调 `refresh()` |
| `ui.fuzzy(query, text)` | 返回 `{ score, indices }` 或 `null`；空格分开的多个词都要命中 |
| `ui.highlight(text, indices)` | 返回 DocumentFragment，命中的字包在 `.hl` 里 |
| `ui.platform`、`ui.isMac`、`ui.currentScheme()` | 平台（同时给 `html` 加了 `.is-mac` / `.is-win` / `.is-linux`）和当前实际主题 |

## 图标

74 个，名字和 Lucide 一致（v3 的 64 个，v4 加了 camera、image、notebook-pen、folder-output、list-tree、flag、clipboard-list、sigma、presentation、chevrons-down-up）：

- 导航和结构：house、list-todo、folder、folder-plus、inbox、search、settings、command、keyboard
- 开会：mic、mic-off、volume-2、audio-lines、captions、play、square、clock、calendar、monitor
- AI 和资料：sparkles、message-square-text、languages、fingerprint-pattern（声纹）、file-text、key-round
- 操作：plus、minus、x、check、chevron-down、chevron-right、chevron-left、chevrons-up-down、ellipsis、trash、pencil、copy、external-link、arrow-right、corner-down-left、refresh-cw、log-in、log-out、archive、funnel
- 状态：circle-check、circle、circle-alert、triangle-alert、info、loader-circle、eye、eye-off、sun、moon
- 项目图标：briefcase、graduation-cap、flask-conical、code、book-open、lightbulb、users、user、star

加图标：从 npm 包 `lucide` 的 `dist/esm/icons/<名字>.mjs` 把数组拷进 `icons.js` 的 `ICONS`，名字不改。

## 怎么看和怎么测

- 展示页：`src/renderer/shared/styleguide.html`，地址参数 `?theme=dark|light&vibrancy=1&tl=16,13`，`#skeleton`（主窗口骨架）、`#components`（全部组件）、`#palette`、`#modal`、`#menu`（打开就弹出对应组件，方便截图）。右上角能切主题和毛玻璃。
- 用 Electron 打开（hiddenInset + `vibrancy: 'sidebar'`）的最小入口、截图和 80 项行为检查（`el` 不解析 HTML、快捷键格式和匹配、模糊匹配、列表导航、开关、分段、下拉、菜单、弹层、命令面板含远程结果和操作菜单、模态框、确认框、toast、提示气泡、主题切换）放在 scratch 的 `wf/DS-design/`：`electron/main.mjs`、`uitest.js`、`shots/`。

## 双语意群对照（v4，`bilingual.js`）

字幕窗、主窗口实时记录、会议详情的字幕记录都用它画「一句英文 + 它的中文」。句子的数据是 `{ text, tr, chunks: [{ en, zh }], terms: [{ term, zh, explain }] }`（见 `docs/v4-课堂模式与双语对照.md` 第一节），旧数据只有 `tr` 和不带 `zh` 的 `terms` 也能画。

```html
<link rel="stylesheet" href="../shared/bilingual.css" />
<script src="../shared/bilingual.js"></script>
```

```js
const pr = bilingual.prefs(settings)          // { colors, style: 'text' | 'bar', className: 'bi-text' | 'bi-bar' | 'bi-mono' }
const r = bilingual.render(sentence, { colors: pr.colors, terms: true, key: 'seg1#0@', focusable: true })
enLine.append(r.en)                             // DocumentFragment
if (r.zh) zhLine.append(r.zh)
container.classList.add(pr.className)           // 两行的共同祖先上加样式类
const stop = bilingual.linkHover(root)          // 悬停一边的术语，同一句（最近的 [data-bi]）另一边的同一个术语加 .is-linked
```

- 意群在原文、译文里找不到的就丢掉；能对上的不到 2 块时不分色。颜色号按英文顺序循环 4 种，变量 `--chunk-1..4` 在 `tokens.css`（深色值在字幕窗的半透明深底上清楚，浅色值在白底上对比度 5:1 以上）。
- 两种样式：`.bi-text` 文字着色（默认），`.bi-bar` 文字不变、下面一条同色细线（粗细用 `--bi-bar-h`）。设置 `display.chunkColors` 关掉时用 `.bi-mono`，也不再分色。
- 术语节点是 `span.term`，带 `data-tid`（两边一样）、`data-title`（「英文 · 中文」）、`data-explain`。主窗口用 `ui.tipDelegate` 读这两个字段出气泡，字幕窗自己画气泡。
- 纯计算的 `bilingual.layout()` 不碰 DOM，单测在 `test/bilingual.test.js`。全程只用 `textContent`。

