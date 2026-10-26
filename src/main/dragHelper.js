import { spawn } from 'node:child_process'
import path from 'node:path'
import { BrowserWindow, screen } from 'electron'

// 拖图标授权（照 GetNewWord 的 PermissionDragHelper）：引导里点「打开系统设置」后，系统设置窗口右边浮出一个小面板，
// 上面是能拖的兔子图标，往左拖进「仅系统录音」或「录屏与系统录音」列表就加上了。面板跟着系统设置窗口挪，
// 系统设置关掉、点 ✕、或 4 分钟后消失。
// 系统设置窗口的位置：osascript 跑一段 JXA 读 CGWindowListCopyWindowInfo（不要辅助功能权限），每 0.4 秒打一行 JSON。

const SIZE = { width: 340, height: 92 }
const MAX_MS = 4 * 60_000

const WATCH = `ObjC.import('AppKit'); ObjC.import('CoreGraphics')
function frame() {
  const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.systempreferences')
  if (apps.count === 0) return null
  const pid = apps.objectAtIndex(0).processIdentifier
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))) || []
  const w = list.find((x) => x.kCGWindowOwnerPID === pid && x.kCGWindowLayer === 0)
  return w ? w.kCGWindowBounds : { closed: false }
}
while (true) { console.log(JSON.stringify(frame())); delay(0.4) }`

/** 每 0.4 秒回调一次系统设置主窗口的位置 { X, Y, Width, Height }（屏幕坐标，和 Electron 的一样），没开是 null。返回停止函数。 */
function watchSystemSettings(onFrame) {
  const p = spawn('osascript', ['-l', 'JavaScript', '-e', WATCH], { stdio: ['ignore', 'ignore', 'pipe'] })
  let buf = ''
  // JXA 的 console.log 写到 stderr
  p.stderr.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let v
      try {
        v = JSON.parse(line)
      } catch {
        continue
      }
      onFrame(v && typeof v.Width === 'number' ? { x: v.X, y: v.Y, width: v.Width, height: v.Height } : v ? 'open' : null)
    }
  })
  p.on('error', () => {})
  return () => p.kill()
}

// 贴在系统设置窗口右边（列表在窗口右半边，往左一拖就到）；右边放不下放下面，再不行压在它底部里面。
// 系统设置窗口不在任何一块屏幕上（窗口留在拔掉的显示器那边）时，放在 near 那块屏幕的右侧中间
export function helperPosition(ss, near) {
  const onScreen = ss && screen.getAllDisplays().some((d) => overlap(d.workArea, ss) > 0.5 * ss.width * ss.height)
  if (!onScreen) {
    const wa = screen.getDisplayMatching(near).workArea
    return { x: Math.round(wa.x + wa.width - SIZE.width - 24), y: Math.round(wa.y + wa.height / 2 - SIZE.height / 2) }
  }
  const wa = screen.getDisplayMatching(ss).workArea
  let x
  let y
  if (ss.x + ss.width + 12 + SIZE.width <= wa.x + wa.width) [x, y] = [ss.x + ss.width + 12, ss.y + ss.height / 2 - SIZE.height / 2]
  else if (ss.y + ss.height + 10 + SIZE.height <= wa.y + wa.height) [x, y] = [ss.x + ss.width / 2 - SIZE.width / 2, ss.y + ss.height + 10]
  else [x, y] = [ss.x + ss.width - SIZE.width - 16, ss.y + ss.height - SIZE.height - 16]
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - SIZE.width - 8)
  y = Math.min(Math.max(y, wa.y + 8), wa.y + wa.height - SIZE.height - 8)
  return { x: Math.round(x), y: Math.round(y) }
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * root：src 目录；appName：系统设置列表里显示的应用名；names()：系统设置里列表和按钮的原文（main.js 的 systemSettingsNames）；
 * near()：引导窗口的位置（系统设置窗口找不到时面板放在那块屏幕上）；
 * onChange({ kind, dragged | closed })：面板上开始拖了、面板没了。
 */
export class DragHelper {
  constructor({ root, appName, names, near, onChange }) {
    Object.assign(this, { root, appName, names, near, onChange })
    this.win = null
    this.kind = null
    this.stopWatch = null
    this.timer = null
  }

  /** kind：'sys'（仅系统录音）| 'scr'（录屏与系统录音）| 'mic'（麦克风，只能开开关，面板上没有图标）。 */
  show(kind) {
    this.hide()
    this.kind = kind
    const win = new BrowserWindow({
      ...SIZE,
      ...helperPosition(null, this.near()),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: true,
      hasShadow: false,
      webPreferences: { preload: path.join(this.root, 'preload/control.cjs') },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.loadFile(path.join(this.root, 'renderer/onboarding/helper.html'), { query: { kind, app: this.appName, ...this.names() } })
    this.win = win
    let seen = false
    this.stopWatch = watchSystemSettings((f) => {
      if (this.win !== win || win.isDestroyed()) return
      if (f === null) {
        if (seen) this.hide() // 系统设置关掉了
        return
      }
      seen = true
      const pos = helperPosition(f === 'open' ? null : f, this.near())
      const [x, y] = win.getPosition()
      if (x !== pos.x || y !== pos.y) win.setPosition(pos.x, pos.y)
      if (!win.isVisible()) win.showInactive()
    })
    this.timer = setTimeout(() => this.hide(), MAX_MS)
  }

  /** 面板上的兔子图标开始拖了（拖进列表松手后系统接着弹「退出并重新打开」）。 */
  dragged(sender) {
    if (!this.win || this.win.isDestroyed() || sender !== this.win.webContents) return false
    this.onChange({ kind: this.kind, dragged: true })
    return true
  }

  owns(sender) {
    return Boolean(this.win && !this.win.isDestroyed() && sender === this.win.webContents)
  }

  hide() {
    clearTimeout(this.timer)
    this.stopWatch?.()
    this.stopWatch = null
    const win = this.win
    const kind = this.kind
    this.win = null
    this.kind = null
    if (win && !win.isDestroyed()) {
      win.destroy()
      this.onChange({ kind, closed: true })
    }
  }
}
