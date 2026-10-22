# 模块 C：AI 答题，接线说明

给 E1（主进程）和 E2（界面）看。代码都在 `src/main/assist/`、`src/renderer/answer/`、`src/preload/answer.cjs`，单测 `test/assist.*.test.js`。

## 文件和导出

| 文件 | 导出 |
|---|---|
| `assist/question.js` | `isQuestion(text)`、`pickLastQuestion(segments, { now, windowMs })` |
| `assist/answerPrompt.js` | `answerMessages(...)`、`answerSystem(...)`、`recentTranscript(...)`、`withImage(...)`、`splitAnswer(text)` |
| `assist/screen.js` | `captureScreen({ maxWidth, quality })`、`screenPermission()` |
| `assist/assistant.js` | `class Assistant` |
| `assist/answerWindow.js` | `createAnswerWindow(...)`、`setAnswerEditMode(win, on)`、`resetAnswerBounds(win)`、`defaultAnswerBounds(display)`、`MIN_SIZE` |
| `assist/answerSelftest.js` | `runAnswerSelfTest({ preload, page })`，给 `--selftest=answer` 用 |

## 和设计文档约定不一样的地方

1. `Assistant` 构造参数多了 `captureScreen`，由主进程传 `screen.js` 的实现。assistant.js 不 import electron，单测才能直接跑。可选参数：`model`（默认 `'answer'`）、`effort`（默认 `'none'`）、`maxOutputTokens`（400）、`timeoutMs`（25 秒）、`screenTimeoutMs`（1.5 秒，截图超时就不带图照常答）、`screenMaxWidth`（1600）、`dedupeMs`（20 秒）。
2. 注入的 `complete` 只收一个参数：`(opts) => complete(settings.get(), chatgptAuth, opts)`。每次调用都取最新设置，切换提供方不用重建 Assistant。
3. answer 对象多了几个字段：`warning`（截图失败这类不影响回答的提示，中文）、`cancelled`（被新问题打断）、`withScreen`、`startedAt`。`timing.screen` 只在截图成功时有值；`timing.firstToken`、`timing.total` 都从调用 `ask()` 开始算，包含截图时间。
4. 多了 5 个 IPC 通道，其中 4 个由 `createAnswerWindow` 自己处理，主进程不用管：`answer:setIgnoreMouse`（Mac 上鼠标进出面板时切换穿透，Windows 不采纳）、`answer:hitRect`（面板在窗口里的位置，Windows 上主进程轮询鼠标用，见下文）、`answer:copy`（用主进程 clipboard 写，窗口不是焦点时渲染进程的 navigator.clipboard 写不了）、`answer:clicked`（Mac 上点完把前台还给会议软件，见下文）。第 5 个 `answer:clear` 是 main→renderer，新会议开始时发，清空答题框。
5. `createAnswerWindow` 多两个可选参数：`contentProtection`（默认 true）、`onBoundsChange(bounds)`（拖动或改大小停下 400ms 后回调）。
6. 新增 `answerSelftest.js`：Windows 上 focusable:false 的窗口能不能点按钮，本机没法测，写成自测交给 CI（见「自测」）。

## 主进程接线（E1）

```js
import { complete, ChatGPTAuth } from './llm/index.js'
import { Assistant } from './assist/assistant.js'
import { captureScreen } from './assist/screen.js'
import { isQuestion, pickLastQuestion } from './assist/question.js'
import { createAnswerWindow, setAnswerEditMode, resetAnswerBounds } from './assist/answerWindow.js'

const assistant = new Assistant({ complete: (o) => complete(settings.get(), chatgptAuth, o), captureScreen })

answerWin = createAnswerWindow({
  preload: path.join(root, 'preload/answer.cjs'),
  page: path.join(root, 'renderer/answer/index.html'),
  bounds: s.overlay.answerBounds,
  contentProtection: s.hideFromScreenShare,
  onBoundsChange: (b) => settings.update({ overlay: { answerBounds: b } }),
})
```

- `settings.js` 的 `DEFAULTS.overlay` 一定要加 `answerBounds: null`，否则 `merge` 会把它丢掉，位置存不住。
- 窗口创建后不显示。显示只用 `answerWin.showInactive()`，别用 `show()` / `focus()`，会抢焦点。什么时候显示：`assist.enabled && (editMode || (overlayWanted && engine.state !== 'idle'))`，跟字幕窗同一套判断；显示/隐藏快捷键同时切两个窗口。没有回答时面板是空的，窗口全透明且鼠标穿透，一直开着也不挡东西。
- `hideFromScreenShare` 改了要同步 `answerWin.setContentProtection(...)`。
- 屏幕拔掉时位置不在任何屏幕上，调 `resetAnswerBounds(answerWin)` 再存设置（跟字幕窗的 `display-removed` 放一起）。

### IPC

```js
ipcMain.on('answer:ready', () => {
  send(answerWin, 'answer:config', answerConfig())
  for (const a of assistant.list()) send(answerWin, 'answer:update', a)
})
ipcMain.on('answer:regenerate', (_e, id) => assistant.regenerate(id))
ipcMain.on('answer:doneEditing', () => setEditMode(false))   // 和字幕窗共用一个调整模式
assistant.on('answer', (a) => {
  send(answerWin, 'answer:update', a)
  toControl('assist:answer', a)                               // 控制窗口也显示一份
})
// 新会议开始时
send(answerWin, 'answer:clear')
```

`answer:config` 的内容：`{ editMode, fontSize: 16, bgOpacity: 0.9, hotkeyAsk: s.assist.hotkeyAsk }`。fontSize 和 bgOpacity 目前没有设置项，先写死；以后要调就加进 `overlay`。

调整位置模式：现有的 `setEditMode(on)` 里加 `setAnswerEditMode(answerWin, on)`，再发一次 `answer:config`。调整模式下答题框没有回答时显示两张示例卡片，方便看大小。托盘菜单的「调整字幕位置」可以改叫「调整字幕和答题框位置」。

### 什么时候调 ask

自动：`engine.on('segment')` 里，只看定稿段：

```js
if (seg.final && seg.who === 'other' && (seg.question ?? isQuestion(seg.text))) {
  const s = settings.get()
  if (s.assist.enabled && s.assist.auto && llmReady()) {
    assistant.ask({
      question: seg.text,
      transcript: engine.snapshot().segments,   // 内部只取最近 12 句、1500 字
      context: s.context,
      profile: s.assist.profile,
      withScreen: s.assist.withScreen,
      answerLang: s.assist.answerLang,
      reason: 'auto',
    })
  }
}
```

- `seg.question` 由 engine 用 `isQuestion` 标好（存档也要这个字段），这里直接用。
- 同一句定稿被广播多次没关系：`reason: 'auto'` 且 20 秒内同一句话（忽略大小写和标点）只答一次。
- 新问题来了会自动停掉上一个还在生成的，旧卡片标「已停止」。
- `ask` 返回 Promise，不用 await，结果都走 `'answer'` 事件；它自己不会 reject，错误在 `answer.error`。

手动（快捷键和 `assist:askLast`）：

```js
function askLast() {
  const s = settings.get()
  const q = pickLastQuestion(engine.snapshot().segments)
  if (!q) return { ok: false, error: '最近 90 秒没有对方说的话' }
  assistant.ask({ question: q.text, transcript: engine.snapshot().segments, context: s.context, profile: s.assist.profile, withScreen: s.assist.withScreen, answerLang: s.assist.answerLang, reason: 'hotkey' })
  return { ok: true, question: q.text }
}
ipcMain.handle('assist:askLast', () => askLast())
```

`pickLastQuestion` 先找最近 90 秒内对方的最后一个问题，找不到就拿对方最后两段拼起来（`matched: false`），所以对方没按问句说完也能手动触发。

### 快捷键

`registerHotkeys()` 里在 `hotkeyToggle` 之后加 `s.assist.hotkeyAsk`（默认 `CommandOrControl+Alt+A`），回调 `askLast`，注册失败的提示方式和现有的一样。`settings.on('change')` 里比较 `assist.hotkeyAsk` 变了就重新注册。答案正在生成时再按一次等于重问（旧的会被停掉）。

### 截屏权限

Mac 没授权时 `captureScreen` 抛 `code: 'no-permission'`，Assistant 接住后照常回答，只在 `answer.warning` 里写提示。控制窗口可以用 `screenPermission()`（Mac 返回 `granted/denied/not-determined/...`，Windows 恒为 `granted`）在 AI 答题卡片里显示状态，并复用现有的 `shell:openPrivacy` 打开设置页。

### 自测

`selftest.js` 的 `runSelfTest` 加一个分支：

```js
if (kind === 'answer') {
  const r = await runAnswerSelfTest({ preload: path.join(root, 'preload/answer.cjs'), page: path.join(root, 'renderer/answer/index.html') })
  report(r)
  return r.ok ? 0 : 1
}
```

`main.js` 里 `--selftest=answer` 不走 `uiSelfTest` 分支（它会进 `runSelfTest`），不需要额外处理。CI 的 Windows job 跑打包后的 `MeetCaption.exe --selftest=answer`，结果 JSON 在 artifact `windows-selftest` 的 answer.json。

Windows 上它开一个常驻 PowerShell 调 user32（`SetCursorPos` / `mouse_event` / `GetForegroundWindow` / `WindowFromPoint`）真动鼠标，挨个做：跳到「重新回答」上点（窗口建好后第一次悬停，原来就是这一步失败）、滑进来点「复制」（查剪贴板）、「收起」「展开」、调整模式下拖标题栏移动和拖右下角改大小、点「完成」、退出调整模式后再点一次「重新回答」。每步记：元素矩形和点击坐标、鼠标下是哪个 HWND、窗口扩展样式、主进程切穿透的时间、渲染进程请求的穿透、渲染进程收到的 mousemove/mousedown/mouseup/click/mouseleave、点击前后的前台窗口。`ok` 要求每步都成、点按钮时前台不变。Mac 上只用 sendInputEvent 走一遍重新回答、收起、展开，不动真鼠标、不碰剪贴板。

## Windows 上怎么接管鼠标

不靠 forward 转来的 mousemove，由主进程每 50ms 看鼠标在不在面板上（面板矩形由渲染进程报 `answer:hitRect`），在就 `setIgnoreMouseEvents(false)`，离开就恢复穿透。原因（CI 实测）：Electron 开 forward 时要给 Chromium 的子窗口 `Chrome_RenderWidgetHostHWND` 挂子类，吞掉转发引起的 `WM_MOUSELEAVE`；窗口刚建好时页面还没加载，这个子窗口不存在，挂不上。于是第一次悬停时页面收到 mousemove 紧跟一个 mouseleave，渲染进程刚请求接管又请求穿透，点击落到下面的窗口。另外 forward 的低级鼠标钩子装在主线程，主线程忙过 LowLevelHooksTimeout 时 Windows 会悄悄摘掉它。

接管后按下先到 `Chrome_RenderWidgetHostHWND`，它见父窗口是 `WS_EX_NOACTIVATE` 就回 `MA_NOACTIVATE`，所以 focusable:false 的答题框也能点，前台窗口不变。调整模式下窗口临时可聚焦，点一下会激活（和 Mac 一样，这时用户就是在操作答题框）。

## 界面（E2）

- 控制窗口订阅 `assist:answer`，用 `answer.id` 做键原地更新，和答题框一个逻辑。`text` 第一行是「要点：…」，可以用 `splitAnswer` 同款正则拆开（渲染进程里 `answer.js` 的 `split()` 就是）。
- AI 答题卡片的设置项对应 `assist.*`：开关、自动回答、带屏幕截图、我的资料（大文本框，超过 4000 字只取前 4000）、回答语言（auto/en/zh）、提问快捷键。

## Mac 上点按钮会激活应用

实测 Electron 44 的 `type: 'panel'` 不是真的 NSPanel（ElectronNSPanel 继承 NSWindow，日志里的 `NSWindow does not support nonactivating panel styleMask 0x80` 就是这个），点一下答题框，整个应用会被激活，会议软件失去焦点。Chromium 自己有 `SetActivationIndependence` 能做到不激活，但 Electron 没开放。

现在的做法：鼠标进入面板时用 `lsappinfo` 记下当时的前台应用 pid，松开鼠标后用 `osascript -l JavaScript` 调 `NSRunningApplication.activateWithOptions` 把前台还回去。不发 Apple Event，不弹「想要控制」的授权框。实测 3 次都还回去了，会议软件失焦约 150 到 900ms。调整位置模式下不还（那时用户就是在操作我们的窗口）。窗口本身始终不是 key window（`isFocused()` 为 false）。

## 实测结果

实测脚本和截图在 scratch：`/private/tmp/claude-501/-Users-apple-Projects-----/962b4cac-77e4-4c2b-8d52-d90571c35018/scratchpad/wf/C-assist/`（`harness/main.mjs`，`shots/`，`report-*.json`）。

- 截屏：Mac mini M4，外接 2048x1152@2x 显示器，缩到 1600x900 JPEG 约 75KB。第一次 350ms，之后 60 到 77ms；答题实测时 135 到 521ms（和网络请求抢 CPU）。
- content protection：`setContentProtection(true)` 的窗口不出现在 desktopCapturer 的截图里（品红测试窗口位置取到的是底下应用的颜色，没保护的绿色窗口能取到），答题框本身也不在截图里。macOS 15.7.4。
- 答题框：真实鼠标事件（CGEvent）测过。悬停接管鼠标、离开恢复穿透，「复制」「重新回答」「收起」「完成」都能点，调整模式下拖动移动 (-120, +40)、拖右下角改大小 (+60, -80) 都生效，退出调整模式后按钮还能点。
- 真实 OpenAI（gpt-5.6-luna，reasoning_effort none，Chat Completions 流式），首字 / 总耗时：
  - 面试（纯文本）：首字 0.77 到 1.17 秒，总 1.9 到 2.4 秒。
  - 导师提问（纯文本）：首字 0.75 到 0.97 秒，总 1.9 到 2.1 秒。
  - 带屏幕截图：首字 1.07 到 1.87 秒（含截图 0.14 到 0.52 秒），总 1.9 到 2.8 秒。
  - 都在 3 秒目标以内。回答内容都用上了资料里的项目和数字，截图场景准确说出了红框里的 Speech Gate 和它的参数。

## 已知问题

- Windows 只在 CI（windows-latest，1024x768，缩放 100%）上实测过：按钮都能点，前台不变，拖动和改大小生效。高 DPI、多显示器、真实会议软件在前台时没有测。
- Windows 调整位置模式点「完成」后，Electron 的 `setFocusable(false)` 把前台交给 Z 序里下一个可见窗口（CI 上是任务栏），不是进入调整模式前的会议软件。
- Mac 激活后还回前台有一个短暂闪动（菜单栏切到「会议字幕」再切回去）。极少数情况下第一下点击只激活应用、按钮没反应（4 次整套测试里出现 1 次），再点一下就好。
- 答题 prompt 要求不用破折号和分号，但模型偶尔还会用；界面没有再做替换。
