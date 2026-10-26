import { BrowserWindow, clipboard, screen } from 'electron'
import { execFile } from 'node:child_process'
import { MIN_SIZE, placeAnswer } from './answerBounds.js'
import { dragBounds, getBoundsKept, gesture, keepSize, resizeBounds, setBoundsKept } from '../windowBounds.js'

// 答题框：独立的置顶窗口，默认在主屏右侧、字幕上方。不抢焦点，但按钮能点。
// 窗口平时鼠标穿透。鼠标移到面板上时接管点击：Mac 靠 forward 转来的 mousemove，渲染进程发 answer:setIgnoreMouse(false)；
// Windows 由主进程轮询鼠标位置决定（见 hoverByPolling）。

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'
export { MIN_SIZE }
const editing = new WeakMap()
const avoiders = new WeakMap() // win → () => 主窗口位置，默认位置要避开它的标题栏

/** 默认位置：主屏右侧、字幕上方，不压主窗口右上角的按钮（avoid：主窗口位置，见 answerBounds.js）。 */
export function defaultAnswerBounds(display = screen.getPrimaryDisplay(), avoid = null) {
  return placeAnswer(display.workArea, avoid)
}

/* Mac：无边框窗口默认留着看不见的标题栏（顶上约 28 像素），点在那里会激活整个应用，主窗口跟着跳到最前面，
   松手后前台又被还回去，看起来就是主窗口闪一下（「收起 / 展开」正好在那一条里）。roundedCorners:false 去掉这条标题栏，
   面板别处本来就不激活应用。保险起见仍然在鼠标进入面板时记下当时的前台应用，点完再把前台还给它。
   用 JXA 调 NSRunningApplication，不发 Apple Event，不会弹「想要控制」的授权框。 */

function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? '' : String(stdout))))
}

async function frontPid() {
  const asn = (await run('lsappinfo', ['front'])).trim()
  if (!asn) return null
  const m = (await run('lsappinfo', ['info', '-only', 'pid', asn])).match(/"pid"\s*=\s*(\d+)/)
  return m ? Number(m[1]) : null
}

function activatePid(pid) {
  return run('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${Number(pid)}).activateWithOptions(0)`])
}

export function keepFrontApp(win) {
  let previous = null
  return {
    async enter() {
      const pid = await frontPid()
      previous = pid && pid !== process.pid ? pid : null
    },
    async clicked() {
      // 不先判断自己是不是前台：激活是异步的，那一刻可能还没登记上，直接还回去（本来就在前台时是空操作）
      if (previous && !editing.get(win)) await activatePid(previous)
    },
  }
}

/* Windows 上接管点击有三个坑（前两个是不靠 forward 转来的 mousemove 切穿透的原因）：
   1. Electron 开 forward 时要给 Chromium 的子窗口 Chrome_RenderWidgetHostHWND 挂子类，吞掉转发引起的 WM_MOUSELEAVE。
      窗口刚建好、页面还没加载时这个子窗口还不存在，挂不上。于是第一次悬停时页面收到 mousemove 紧跟一个 mouseleave，
      刚接管又穿透，点击落到下面的窗口（CI 实测，原来的自测就是这么失败的）。
   2. forward 用的低级鼠标钩子装在主线程，主线程忙过 LowLevelHooksTimeout（比如算声纹）时 Windows 会悄悄摘掉它。
   所以主进程每 50ms 看一次鼠标在不在面板上，在就接管鼠标，离开就恢复穿透；渲染进程发来的 answer:setIgnoreMouse 不理。
   面板在窗口里的位置由渲染进程报 answer:hitRect（CSS 像素，等于 DIP）。
   接管后按下先到 Chrome_RenderWidgetHostHWND，它见父窗口是 WS_EX_NOACTIVATE 就回 MA_NOACTIVATE，
   所以 focusable:false 也能点，前台不变（CI 实测）。
   3. 按下要是落到顶层窗口 Chrome_WidgetWin_1 上，Chromium 见窗口不能激活就回 MA_NOACTIVATEANDEAT，按下被吃掉：
      悬停有高亮，页面只收到 mouseup，按钮全都点不动（0.4.2 真机上正式开会时就是这样）。
      子窗口什么时候会不见：窗口藏起来时 Chromium 把 Chrome_RenderWidgetHostHWND 也藏起来，再显示时只在页面「从隐藏变回可见」
      那条路上把它放出来。backgroundThrottling:false 的页面在 Electron 里永远不算隐藏，那条路就不走，子窗口一直藏着，
      直到窗口改一次大小。所以只要 hide() 过一次（散会、Ctrl+Alt+S）或被系统判成遮挡过，之后就点不动了；
      原来的自测只显示过一次，测不到。答题框在 Windows 上开 backgroundThrottling，走 Chromium 正常的显示流程。 */
function hoverByPolling(win) {
  let rect = null
  let over = false
  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer)
    // 调整模式下整窗接管鼠标，由 setAnswerEditMode 管；退出时它已改回穿透，over 跟着复位
    if (editing.get(win)) {
      over = false
      return
    }
    let inside = false
    if (rect && win.isVisible()) {
      const p = screen.getCursorScreenPoint()
      const b = win.getContentBounds()
      const x = p.x - b.x
      const y = p.y - b.y
      inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
    }
    if (inside === over) return
    over = inside
    win.setIgnoreMouseEvents(!inside, { forward: true })
  }, 50)
  win.on('closed', () => clearInterval(timer))
  return {
    setRect(r) {
      rect = r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 ? r : null
    },
  }
}

function visibleOnSomeDisplay(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 20 && b.y + b.height > a.y + 20
  })
}

function sanitize(b) {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(MIN_SIZE.width, Math.round(b.width)),
    height: Math.max(MIN_SIZE.height, Math.round(b.height)),
  }
}

/**
 * createAnswerWindow({ preload, page, bounds, contentProtection, onBoundsChange, avoid })
 * bounds：上次保存的位置（settings.overlay.answerBounds），不在任何屏幕上就用默认位置。
 * onBoundsChange(bounds)：用户拖动或改大小停下 400ms 后回调，主进程拿去存设置。
 * avoid()：主窗口现在（或将要）在哪，默认位置和「重置位置」都避开它的标题栏。
 * 窗口创建后不显示，用 showAnswerWindow() 显示（showInactive，别用 show()，会抢焦点）。
 */
export function createAnswerWindow({ preload, page, bounds, contentProtection = true, onBoundsChange, avoid } = {}) {
  const b = bounds && visibleOnSomeDisplay(bounds) ? sanitize(bounds) : defaultAnswerBounds(undefined, avoid?.())
  const win = new BrowserWindow({
    ...b,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: true, // Mac：窗口不是焦点时第一下点击也直接给到按钮
    roundedCorners: false, // Mac：去掉看不见的标题栏，点顶上一条不激活应用（见 keepFrontApp 前的说明）
    ...(isMac ? { type: 'panel' } : {}),
    // Windows 上必须开 backgroundThrottling，见上面 hoverByPolling 前的说明第 3 条
    webPreferences: { preload, backgroundThrottling: isWin },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.setContentProtection(contentProtection)
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(page)
  keepSize(win, b)
  if (avoid) avoiders.set(win, avoid)

  // 这几个通道只跟本窗口有关，直接在这里处理；answer:ready / regenerate / doneEditing 由主进程接
  const ipc = win.webContents.ipc
  const front = isMac ? keepFrontApp(win) : null
  const hover = isWin ? hoverByPolling(win) : null
  ipc.on('answer:setIgnoreMouse', (_e, ignore) => {
    if (hover || editing.get(win)) return
    win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
    if (!ignore) front?.enter()
  })
  ipc.on('answer:hitRect', (_e, r) => hover?.setRect(r))
  ipc.on('answer:clicked', () => front?.clicked())
  // 随时拖动、调整位置时拖边缘：页面只说「开始了 / 还在拖」，位置和大小由这里按鼠标走了多远算（见 windowBounds.js）
  const cursor = () => screen.getCursorScreenPoint()
  const moving = gesture(() => getBoundsKept(win), cursor)
  const sizing = gesture(() => getBoundsKept(win), cursor)
  ipc.on('answer:moveTo', (_e, p) => {
    const g = moving(Boolean(p?.first))
    setBoundsKept(win, dragBounds(g.start, g.from, g.now))
  })
  ipc.on('answer:resizeEdges', (_e, r) => {
    if (typeof r?.edges !== 'string') return
    const g = sizing(Boolean(r.first))
    setBoundsKept(win, resizeBounds(g.start, g.dx, g.dy, r.edges, MIN_SIZE, screen.getDisplayMatching(g.start).workArea))
  })
  ipc.on('answer:copy', (_e, text) => {
    Promise.resolve(clipboard.writeText(String(text ?? ''))).catch(() => {})
  })

  let timer
  const changed = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!win.isDestroyed()) onBoundsChange?.(getBoundsKept(win))
    }, 400)
  }
  win.on('moved', changed)
  win.on('move', changed) // 拖动是 setBounds 挪的，Mac 上不发 moved
  win.on('resize', changed)
  win.on('closed', () => clearTimeout(timer))
  return win
}

/** 显示或隐藏答题框。main.js 的 refreshOverlay 和 --selftest=answer 都走这里。显示用 showInactive，不抢会议软件的焦点。 */
export function showAnswerWindow(win, show) {
  if (!win || win.isDestroyed()) return
  if (show && !win.isVisible()) win.showInactive()
  else if (!show && win.isVisible()) win.hide()
}

/** 调整位置模式：整窗接管鼠标，可拖动、可改大小；退出后恢复穿透。 */
export function setAnswerEditMode(win, on) {
  if (!win || win.isDestroyed()) return
  editing.set(win, Boolean(on))
  // 和字幕窗一样：调整时临时允许聚焦，否则 Windows 上 -webkit-app-region 拖不动
  win.setFocusable(Boolean(on))
  win.setIgnoreMouseEvents(!on, { forward: true })
}

export function resetAnswerBounds(win) {
  if (!win || win.isDestroyed()) return null
  const b = defaultAnswerBounds(undefined, avoiders.get(win)?.())
  setBoundsKept(win, b)
  return b
}
