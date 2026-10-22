# 模块 D：术语悬停，交付说明

## 改了哪些文件

- `src/main/prompts.js`：新增 `enhanceMessages`、`parseEnhance`，原有导出没动。
- `src/renderer/overlay/terms.js`（新文件）：`MeetTerms.split(text, terms)`，把句子切成普通片段和术语片段。普通 script，挂在 `window.MeetTerms`，控制窗口也能直接用。
- `src/renderer/overlay/index.html`、`overlay.css`、`overlay.js`：虚线下划线、300ms 悬停解释框、按句子复用 DOM（字幕更新不闪、不丢悬停）、顶部透明区、调整位置模式下显示「术语解释在这里弹出」的虚线框。
- `test/enhance.test.js`：14 个用例，覆盖 prompt、解析容错、术语匹配。`npm test` 37 个全过。

main.js、engine.js、preload、settings.js 我都没改，需要改的地方在下面。

## 和设计文档不一样的地方

**不用 `setIgnoreMouseEvents(true, { forward: true })`，改成主进程轮询鼠标位置。**
Mac 上用真实鼠标（CGEvent 发 mouseMoved）实测：字幕窗是 `type: 'panel'`、`focusable: false`，我们的应用又不在前台（开会时前台是 Zoom 或 Teams），forward 模式下渲染进程只在鼠标进入窗口时收到 1 个过时的 mousemove，停在术语上 500ms 一个事件都没有，解释框根本弹不出来。改成主进程每 50ms 读一次 `screen.getCursorScreenPoint()`，鼠标在字幕窗内就发窗口内坐标给渲染进程，Mac 和 Windows 一套代码，也不用在 Windows 上装全局鼠标钩子。窗口照旧 `setIgnoreMouseEvents(true)`，点击全部穿透。

渲染端：preload 提供了 `onPointer` 就只用轮询；没有就退回 DOM 的 mousemove（兼容旧 preload，也方便用 sendInputEvent 测）。两路混用会互相打断，所以只选一路。

**`parseEnhance(text, sentence)` 多了可选的第二个参数。** 给了句子就只保留句子里真有的术语，并把大小写改成句子里的写法（模型偶尔会把 `kl divergence` 写成小写），渲染端高亮一定对得上。

## E1：main.js 要改的地方

### 1. 窗口高度：字幕框上方加一段透明区

解释框 = 术语名一行 + 解释最多两行（最宽 28 个字）+ 内边距 15px + 箭头 6px + 间距 10px。解释框字号 = 字幕字号 × 0.6，限制在 13 到 20px。字号 26 时约 103px，所以留 `60 + 字号 × 3.5`：字号 18 时 123px，26 时 151px，40 时 200px。术语关掉时留 0。

```js
// 字幕框本身的高度（原来的 overlayHeight）
function captionHeight(o) {
  return Math.round(o.lines * o.fontSize * 1.42 + 28)
}

// 字幕框上方留给术语解释的透明区域
function tipSpace(s = settings.get()) {
  return s.terms?.enabled === false ? 0 : Math.round(60 + s.overlay.fontSize * 3.5)
}

function overlayHeight(o) {
  return captionHeight(o) + tipSpace()
}
```

`defaultOverlayBounds`、`applyOverlayAppearance`、`overlay:resetPosition` 都用 `overlayHeight`，不用再改。`applyOverlayAppearance` 已经是按底边对齐换高度，所以改字号、开关术语时字幕框不会跳。

`createOverlay` 里读旧位置要按底边对齐，否则 v1 存下来的 bounds（没有透明区）换了高度后字幕会往下掉 tipSpace：

```js
function createOverlay() {
  const o = settings.get().overlay
  const height = overlayHeight(o)
  let bounds =
    o.bounds && visibleOnSomeDisplay(o.bounds)
      ? { ...o.bounds, y: o.bounds.y + o.bounds.height - height, height }
      : defaultOverlayBounds(o)
  // 下面不变，setIgnoreMouseEvents(true) 也不变
```

### 2. overlay-config 加两个字段

```js
function overlayConfig() {
  const s = settings.get()
  return {
    ...s.overlay,
    editMode,
    running: engine.state !== 'idle',
    terms: { enabled: s.terms?.enabled !== false },
    tipSpace: tipSpace(s),
  }
}
```

渲染端没收到 `tipSpace` 时按 0 处理，布局和 v1 完全一样；没收到 `terms` 时当作开着。

### 3. 轮询鼠标位置

```js
let pointerLast = null

// 字幕窗点击穿透，收不到鼠标事件；鼠标在窗口里就把窗口内坐标发过去，出了窗口发 null
function pollPointer() {
  let next = null
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible() && !editMode && settings.get().terms?.enabled !== false) {
    const p = screen.getCursorScreenPoint()
    const b = overlayWin.getBounds()
    if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) next = { x: p.x - b.x, y: p.y - b.y }
  }
  if (next?.x === pointerLast?.x && next?.y === pointerLast?.y) return
  pointerLast = next
  toOverlay('overlay:pointer', next)
}
```

在 `app.whenReady()` 里 `createOverlay()` 之后加 `setInterval(pollPointer, 50)`。只有位置变了才发 IPC，鼠标不在字幕窗上时每次只是读一下坐标，开销可以忽略。坐标没变就不发，这一点渲染端要靠它：字幕滚动时鼠标没动，解释框就不收起。

调整位置模式下 `pollPointer` 发 null，解释框不会弹。`setEditMode` 本身不用改。

### 4. preload/overlay.cjs 加一行

```js
  onPointer: (cb) => ipcRenderer.on('overlay:pointer', (_e, p) => cb(p)),
```

### 5. settings.js

DEFAULTS 按设计文档加 `terms: { enabled: true }`。设置变了会走 `applyOverlayAppearance`，高度和 config 会自动跟上。

## E1：engine.js 接 enhance

`enhanceMessages` 返回和 `translateMessages` 一样的 `[system, user]` 数组。接 A 模块的 `complete` 时拆开：

```js
import { enhanceMessages, parseEnhance } from './prompts.js'

async #enhance(sentence, { translate }) {
  const s = this.cfg
  const previous = (this.session?.segments ?? []).slice(-3).map((x) => x.text)
  const [system, user] = enhanceMessages({
    sentence, previous, translate,
    target: s.translateTarget, context: s.context, keywords: keywordList(s),
  })
  const raw = await complete(s, this.auth, {
    model: 'fast', system: system.content, messages: [user],
    effort: 'none', json: true, timeoutMs: 20_000,
  })
  return parseEnhance(raw, sentence) // { tr, terms }
}
```

- 什么时候调：只对 `who === 'other'` 的稳定句子。`translate` = 翻译开着且句子不是目标语言；两件事都不用做（翻译关、术语关，或者已是目标语言且术语关）就不发请求。已经是目标语言但术语开着，就用 `translate: false` 只要术语。
- 结果挂到句子上：`sen.tr = r.tr || undefined`，`sen.terms = r.terms`（可以是空数组）。`#resplit` 重新分句时现在只从缓存恢复 `tr`，要把 `terms` 一起恢复，缓存从「文本 → 译文」改成「文本 → { tr, terms }」。
- `json: true`：OpenAI 的 `response_format: json_object` 要求消息里出现 JSON 这个词，system prompt 里已经有了。实测不开 json 模式时 50 次回复也全是合法 JSON，`parseEnhance` 另外兜底代码块和前后多余文字。
- 延迟：比只翻译平均慢 0.4 秒左右（下面有数字），翻译字幕会晚这么多出来。

## E2：控制窗口的实时记录

`src/renderer/control/index.html` 里在 app.js 前面加 `<script src="../overlay/terms.js"></script>`，然后：

```js
for (const p of MeetTerms.split(sen.text, sen.terms)) {
  if (!p.term) { el.append(p.text); continue }
  const s = document.createElement('span')
  s.className = 'term'
  s.textContent = p.text
  s.title = p.explain // 或者做成和字幕窗一样的气泡
  el.append(s)
}
```

控制窗口是普通窗口，能收到鼠标事件，用 `title` 或 CSS 气泡都行。下划线样式可以抄 overlay.css 的 `.term`。设置页的「术语解释」开关写 `terms.enabled`。

## 实测

### 模型（gpt-5.6-luna，effort none，现有 `src/main/llm.js` 的 chat()，10 句学术会议英文）

最终版 prompt 跑两轮，共 20 次：

| 指标 | 结果 |
|---|---|
| 单句耗时 | 中位数 1866ms，p90 2419ms，最快 1023ms，最慢 2490ms，平均 1842ms |
| 直接是合法 JSON | 20/20 |
| 术语是原句里的原样片段 | 35/35（`parseEnhance` 按句子过滤一个没丢） |
| 解释长度 | 8 到 24 字，中位数 16，超过 40 字的 0 个 |

同一批句子接连跑一轮对比（每种 10 次）：只翻译（现有 `translateMessages`）平均 1230ms、中位数 1190ms；只要术语（translate=false）平均 1489ms；译文加术语平均 1592ms、中位数 1715ms。

挑词结果（两轮合并）：

| 句子 | 挑出的术语 |
|---|---|
| …the related work is a bit thin. | 无 |
| …against LoRA and full fine-tuning on the GLUE benchmark? | LoRA、GLUE benchmark |
| …NeurIPS…KL divergence instead of the Wasserstein distance. | NeurIPS、KL divergence、Wasserstein distance |
| I talked to Yoshua Bengio at Mila…GFlowNets. | Mila、GFlowNets、Yoshua Bengio（一轮漏了人名） |
| Please send me the revised draft by next Friday… | 无 |
| The ablation in Table 3…attention sink…BOS token. | ablation、attention sink、BOS token |
| …DTU HPC cluster, the A100 nodes… | DTU HPC cluster、A100 nodes / A100 |
| Your p-values…Bonferroni correction… | p-values、Bonferroni correction |
| …the ELBO derivation in the appendix… | ELBO |
| …the ICML deadline…submit to TMLR. | ICML、TMLR |

日常句子两轮都是空数组。偏宽的是 ablation、p-values，对 CS 研究生来说算常识，但对英语听力一般的人也说得过去。第一版 prompt 有两条解释超过 40 字（KL divergence 带了英文全称 44 字，TMLR 50 字），也挑过一次 related work；加了「英文字母也算字数、不写很长的英文全称」和日常词示例后没再出现。只要术语的模式下有一次把 derivation 当术语。

译文举例：「你有没有在 GLUE 基准测试上，将你们的方法与 LoRA 和全量微调进行比较？」「我们争取赶上 ICML 的截止日期，如果没赶上，还可以提交给 TMLR。」意思准、口语自然，术语按规则保留原文（KL divergence 有时译成「KL散度」）。

### 字幕窗（scratch 下最小 Electron 入口，用项目的 overlay 页面和 preload/overlay.cjs）

sendInputEvent 模拟鼠标，连跑 3 次全过（14 项）：

- 4 个术语都加了下划线，`kl divergence`（小写）在句子里 `KL divergence` 上也能标出来。
- 停 150ms 不弹，450ms 弹出，解释框底边 141px，字幕框顶边 151px，不遮字幕。
- 已经开着解释框时移到别的术语，40 到 60ms 内直接切换。
- 字幕更新（上一句定稿、来新句、第一句被挤出去）：解释框还在，悬停的那个 DOM 节点没被重建，跟着往上移。
- 悬停的术语被挤出字幕框：鼠标没动就留着解释框，箭头收起。
- 移开 60ms 时还在（150ms 切换宽限），260ms 时收起；鼠标离开窗口马上收起。
- 调整位置模式不弹；`terms.enabled=false` 下划线全没。
- 旧 main.js（config 里没有 tipSpace、terms）：字幕框高度等于窗口高度，和 v1 一样；调整位置模式的提示和按钮位置不变。

轮询 IPC 这一路（发 `overlay:pointer` 坐标）：450ms 弹出，发 null 后收起。

真实鼠标（Mac，窗口 `type: 'panel'`、`focusable: false`，终端在前台，用 CGEvent 从窗口上方移到术语上停 500ms，再移出去）：

| 做法 | 停在术语上 500ms | 移出窗口 |
|---|---|---|
| `setIgnoreMouseEvents(true, { forward: true })` | 不弹。整个过程 DOM 只收到 1 个 mousemove（进窗口那一刻的旧坐标） | 收到 2 个 mouseleave |
| 主进程 50ms 轮询 + `overlay:pointer` | 弹出，内容正确 | 收起 |

另外发现：窗口 `setIgnoreMouseEvents(true)` 时真实鼠标进出窗口仍会给 DOM 发 mousemove 和 mouseleave，跟 sendInputEvent 模拟的事件混在一起会把悬停打断。所以渲染端有 `onPointer` 就完全不听 DOM 鼠标事件。

## 已知限制

- Windows 上的轮询和鼠标穿透没法在本机测，需要在 CI 截图或朋友机器上确认一次。`getCursorScreenPoint` 和 `getBounds` 都是 DIP 坐标，缩放 125% 或 150% 的屏幕上应该也对得上，但没实测。
- macOS 不让无边框窗口顶到菜单栏上面，所以字幕框最高只能拖到离屏幕顶端 tipSpace 的位置。字幕一般放在屏幕下方，影响不大。
- 解释框开着时字幕不会 12 秒后淡出，鼠标一动或移开就恢复正常。
- 鼠标停着不动时，新出来的术语正好在鼠标下面也不会弹，要动一下鼠标。这是故意的：字幕滚动时不能乱弹乱收。
