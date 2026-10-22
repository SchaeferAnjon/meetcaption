import { clipboard, screen } from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnswerWindow, setAnswerEditMode, showAnswerWindow } from './answerWindow.js'

// --selftest=answer：按正式开会的样子显示答题框，推回答，挨个点按钮，看按钮收没收到、前台窗口有没有被抢。
// 显示流程和 main.js 一样：窗口启动时建好藏着、开内容保护，开会时 showInactive，Ctrl+Alt+S 藏起再显示、改外观时重设内容保护、
//   散会再开一场。0.4.2 的 Windows 真机上答题框只要藏起过一次就点不动，原来的自测只显示一次，没测到。
// Windows（CI、真机）：用 user32 真动鼠标（SetCursorPos + mouse_event），走和用户一样的路：悬停接管鼠标、点重新回答/复制/收起，
//   调整模式下拖动和改大小、点完成，退出调整模式后再藏起显示一次再点。每步记诊断（坐标、子窗口、穿透切换、渲染进程收到的鼠标事件）。
// Mac：已手动实测过真实鼠标，这里只用 sendInputEvent 把按钮逻辑走一遍，不动真鼠标、不碰剪贴板。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ANSWER = {
  id: 'selftest',
  question: 'Why did you choose this baseline?',
  text: '要点：自测\nThis is a self test answer.',
  done: true,
  error: null,
  reason: 'manual',
  startedAt: Date.now(),
  timing: { screen: null, firstToken: 900, total: 1800 },
}
const CONFIG = { fontSize: 16, bgOpacity: 0.9, hotkeyAsk: 'CommandOrControl+Alt+A', mode: 'meeting' }
const REGEN = '.card .meta button' // 第一个是「重新回答」
const COPY = '.card .meta button + button'

/* ---------------- Windows：常驻的 PowerShell，按行收命令、按行回结果 ---------------- */

const PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
public static class MC {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  public static int W, H;
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Desc(IntPtr h) { return h.ToInt64() + ":" + Cls(h); }
  public static string At(int x, int y) {
    var p = new POINT(); p.X = x; p.Y = y;
    var h = WindowFromPoint(p);
    return Desc(h) + " root=" + GetAncestor(h, 2).ToInt64();
  }
  public static string Children(IntPtr parent) {
    var sb = new StringBuilder();
    EnumChildWindows(parent, delegate (IntPtr h, IntPtr l) {
      RECT r; GetWindowRect(h, out r);
      sb.Append(Desc(h)).Append(IsWindowVisible(h) ? "(visible " : "(hidden ").Append(r.L + "," + r.T + " " + (r.R - r.L) + "x" + (r.B - r.T) + ") ");
      return true;
    }, IntPtr.Zero);
    return sb.ToString().Trim();
  }
  public static string Cursor() { POINT p; GetCursorPos(out p); return p.X + " " + p.Y; }
  // 先发一个真正的移动事件（低级鼠标钩子能看到），再用 SetCursorPos 校准到整像素
  public static void MoveTo(int x, int y) {
    mouse_event(0x8001, (int)Math.Round(x * 65535.0 / (W - 1)), (int)Math.Round(y * 65535.0 / (H - 1)), 0, UIntPtr.Zero);
    SetCursorPos(x, y);
  }
  public static void Glide(int x0, int y0, int x1, int y1, int steps, int delay) {
    for (int i = 1; i <= steps; i++) {
      MoveTo(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      Thread.Sleep(delay);
    }
  }
  public static void Down() { mouse_event(2, 0, 0, 0, UIntPtr.Zero); }
  public static void Up() { mouse_event(4, 0, 0, 0, UIntPtr.Zero); }
}
'@
[void][MC]::SetProcessDPIAware()
[MC]::W = [MC]::GetSystemMetrics(0); [MC]::H = [MC]::GetSystemMetrics(1)
[Console]::Out.WriteLine("ready $([MC]::W) $([MC]::H)"); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq 'quit') { break }
  $a = $line.Split(' ')
  $out = 'ok'
  try {
    switch ($a[0]) {
      'move'     { [MC]::MoveTo([int]$a[1], [int]$a[2]); $out = [MC]::Cursor() }
      # 原来那版自测的动法：SetCursorPos 跳过去，再发一个换算到同一点的绝对移动
      'jump'     { $x = [int]$a[1]; $y = [int]$a[2]; [void][MC]::SetCursorPos($x, $y); [MC]::mouse_event(0x8001, [int][uint32]($x * 65535 / [MC]::W), [int][uint32]($y * 65535 / [MC]::H), 0, [UIntPtr]::Zero); $out = [MC]::Cursor() }
      'glide'    { [MC]::Glide([int]$a[1], [int]$a[2], [int]$a[3], [int]$a[4], [int]$a[5], [int]$a[6]); $out = [MC]::Cursor() }
      'click'    { [MC]::Down(); Start-Sleep -Milliseconds 60; [MC]::Up() }
      'drag'     { [MC]::Down(); Start-Sleep -Milliseconds 120; [MC]::Glide([int]$a[1], [int]$a[2], [int]$a[3], [int]$a[4], [int]$a[5], [int]$a[6]); Start-Sleep -Milliseconds 120; [MC]::Up(); $out = [MC]::Cursor() }
      'fg'       { $out = [MC]::Desc([MC]::GetForegroundWindow()) }
      'at'       { $out = [MC]::At([int]$a[1], [int]$a[2]) }
      'style'    { $out = '0x{0:X8}' -f [MC]::GetWindowLong([IntPtr]::new([long]$a[1]), -20) }
      'children' { $out = [MC]::Children([IntPtr]::new([long]$a[1])) }
      default    { $out = "error unknown command $($a[0])" }
    }
  } catch { $out = "error $($_.Exception.Message)" }
  [Console]::Out.WriteLine(($out -replace '\s+', ' ')); [Console]::Out.Flush()
}
`

class WinInput {
  static async start() {
    const file = path.join(os.tmpdir(), `meetcaption-input-${process.pid}.ps1`)
    fs.writeFileSync(file, PS)
    const self = new WinInput()
    self.file = file
    self.stderr = ''
    self.waiting = []
    self.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true })
    self.proc.stderr.on('data', (d) => (self.stderr += d))
    let buf = ''
    let onReady
    const ready = new Promise((r) => (onReady = r))
    self.proc.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (onReady) {
          // ready 之前的输出（如果有）都不是命令的回复
          const m = line.match(/^ready (\d+) (\d+)/)
          if (m) {
            self.screen = { width: Number(m[1]), height: Number(m[2]) }
            onReady(true)
            onReady = null
          }
        } else self.waiting.shift()?.(line)
      }
    })
    self.proc.stdin.on('error', () => {})
    self.proc.on('error', (e) => {
      self.stderr += e.message
      onReady?.(false)
    })
    self.proc.on('exit', () => {
      onReady?.(false)
      for (const w of self.waiting.splice(0)) w(`error powershell exited: ${self.stderr.trim().slice(0, 400)}`)
    })
    const ok = await Promise.race([ready, sleep(30_000).then(() => false)])
    if (!ok) {
      self.close()
      throw new Error(`PowerShell 没起来：${self.stderr.trim().slice(0, 400)}`)
    }
    return self
  }

  next(timeoutMs) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve('error timeout'), timeoutMs)
      this.waiting.push((line) => {
        clearTimeout(t)
        resolve(line)
      })
    })
  }

  cmd(line, timeoutMs = 15_000) {
    const p = this.next(timeoutMs)
    this.proc.stdin.write(line + '\n')
    return p
  }

  close() {
    try {
      this.proc.stdin.end('quit\n')
    } catch {}
    setTimeout(() => this.proc.kill(), 1000).unref()
    fs.rm(this.file, { force: true }, () => {})
  }
}

/* ---------------- 渲染进程诊断：记下收到的鼠标事件 ---------------- */

const DIAG_INSTALL = `(() => {
  if (window.__diag) return true
  const d = (window.__diag = { events: [], moves: 0 })
  const name = (el) => el && el.nodeType === 1 ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].map((c) => '.' + c).join('') : String(el)
  const log = (e) => {
    if (e.type === 'mousemove' && ++d.moves > 12) return
    d.events.push({ type: e.type, t: Date.now(), x: Math.round(e.clientX), y: Math.round(e.clientY), target: name(e.target), trusted: e.isTrusted })
  }
  for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) window.addEventListener(type, log, true)
  document.addEventListener('mouseleave', (e) => d.events.push({ type: 'document-mouseleave', t: Date.now(), x: Math.round(e.clientX), y: Math.round(e.clientY), trusted: e.isTrusted }))
  return true
})()`
const DIAG_TAKE = `(() => { const d = window.__diag; const out = { moves: d.moves, events: d.events }; d.events = []; d.moves = 0; return out })()`

const js = (win, code) => win.webContents.executeJavaScript(code)
const rectOf = (win, sel) =>
  js(win, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
const panelState = (win) =>
  js(win, `(() => { const p = document.getElementById('panel'); return { hidden: p.classList.contains('hidden'), collapsed: p.classList.contains('collapsed'), collapseText: document.getElementById('collapse').textContent } })()`)

function hwndOf(win) {
  const buf = win.getNativeWindowHandle()
  return String(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0))
}

async function waitFor(fn, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(stepMs)
  }
  return Boolean(await fn())
}

/** → { ok, platform, osLevel, clicked, answerWindowTookForeground, steps, flow, diag, error } */
export async function runAnswerSelfTest({ preload, page }) {
  const isWin = process.platform === 'win32'
  const result = { ok: false, platform: process.platform, osLevel: isWin, clicked: false, steps: {}, flow: [], diag: {} }
  // 和 main.js 的 createAnswer 一样：启动时建好、不显示，内容保护按默认设置打开
  const win = createAnswerWindow({ preload, page, contentProtection: true })
  const t0 = Date.now()
  const rel = (t) => t - t0

  // 主进程每次切换穿透都记下来（Windows 上由轮询切，Mac 上由渲染进程发 answer:setIgnoreMouse 切）
  const ignoreLog = []
  let ignoring = true
  const setIgnore = win.setIgnoreMouseEvents.bind(win)
  win.setIgnoreMouseEvents = (ignore, opts) => {
    ignoring = Boolean(ignore)
    ignoreLog.push({ t: rel(Date.now()), ignore: ignoring })
    return setIgnore(ignore, opts)
  }

  const ipc = win.webContents.ipc
  let regenerated = 0
  let doneEditing = 0
  const hitRects = []
  const rendererRequests = []
  ipc.on('answer:regenerate', () => regenerated++)
  ipc.on('answer:hitRect', (_e, r) => hitRects.push({ t: rel(Date.now()), r }))
  // 渲染进程自己按 mousemove/mouseleave 请求的穿透（Windows 上主进程不采纳，只记下来对照）
  ipc.on('answer:setIgnoreMouse', (_e, v) => rendererRequests.push({ t: rel(Date.now()), ignore: Boolean(v) }))
  const config = (editMode) => win.webContents.send('answer:config', { ...CONFIG, editMode })
  const editMode = (on) => {
    setAnswerEditMode(win, on)
    config(on)
  }
  ipc.on('answer:doneEditing', () => {
    doneEditing++
    editMode(false)
  })
  // 应用刚启动：还没开会，没有回答，只发配置
  ipc.on('answer:ready', () => config(false))

  // 正式开会时答题框经历的显示变化（main.js：refreshOverlay、toggleOverlay、applyOverlayAppearance、engine 的 state 事件）
  const flow = async (what) => {
    const at = rel(Date.now())
    if (what === 'meeting') {
      // 开会：显示，清掉上一场的回答；对方提问后回答推过来
      showAnswerWindow(win, true)
      config(false)
      win.webContents.send('answer:clear')
      await sleep(300)
      win.webContents.send('answer:update', { ...ANSWER, startedAt: Date.now() })
    } else if (what === 'toggle') {
      // Ctrl+Alt+S 藏起字幕和答题框，再按一次显示
      showAnswerWindow(win, false)
      await sleep(400)
      showAnswerWindow(win, true)
      config(false)
    } else if (what === 'appearance') {
      // 设置里改了什么（字号、背景、共享屏幕时隐藏）：applyOverlayAppearance 重设内容保护
      win.setContentProtection(true)
      config(false)
    } else if (what === 'meetingEnd') {
      // 散会：藏起来
      showAnswerWindow(win, false)
    }
    await sleep(400)
    const rendered = await waitFor(async () => what === 'meetingEnd' || (!(await panelState(win)).hidden && (await rectOf(win, REGEN))), 5000)
    if (!rendered) throw new Error(`「${what}」之后答题卡片 5 秒内没渲染出来`)
    result.flow.push({ t: at, what, visible: win.isVisible() })
  }

  let input = null
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    await js(win, DIAG_INSTALL)
    await sleep(300)
    const ctx = { hitRects, ignoreLog, rendererRequests, rel, flow, regen: () => regenerated, done: () => doneEditing, editMode, isIgnoring: () => ignoring, setInput: (i) => (input = i) }
    if (isWin) await windowsSteps(win, result, ctx)
    else await macSteps(win, result, ctx)

    result.clicked = Boolean(result.steps.regenerate?.clicked)
    const failed = Object.entries(result.steps).filter(([, s]) => !s.ok).map(([k]) => k)
    if (failed.length) result.failed = failed
    result.ok = failed.length === 0 && result.answerWindowTookForeground !== true
  } catch (e) {
    result.ok = false
    result.error = e.message
  } finally {
    result.diag.ignoreLog = ignoreLog
    result.diag.rendererRequests = rendererRequests
    result.diag.hitRects = hitRects
    input?.close()
    win.destroy()
  }
  return result
}

/* ---------------- Windows：真鼠标 ---------------- */

async function windowsSteps(win, result, ctx) {
  const { hitRects, ignoreLog, rel, flow } = ctx
  const input = await WinInput.start()
  ctx.setInput(input)
  const hwnd = hwndOf(win)
  const display = screen.getDisplayMatching(win.getBounds())
  const scale = display.scaleFactor
  Object.assign(result.diag, {
    screen: input.screen,
    display: { bounds: display.bounds, workArea: display.workArea, scaleFactor: scale },
    hwnd,
    windowBounds: win.getBounds(),
    contentBounds: win.getContentBounds(),
    exStyleStart: await input.cmd(`style ${hwnd}`),
    childrenHidden: await input.cmd(`children ${hwnd}`),
  })

  // 页面坐标（CSS 像素，相对内容区左上角）→ 屏幕物理像素
  const toScreen = (p) => {
    const b = win.getContentBounds()
    const s = screen.dipToScreenPoint({ x: b.x + p.x, y: b.y + p.y })
    return { x: Math.round(s.x), y: Math.round(s.y) }
  }
  const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  // 从窗口左边外面一点水平滑进来，和真人一样经过边缘
  const outside = (target) => {
    const b = win.getContentBounds()
    const left = screen.dipToScreenPoint({ x: b.x - 40, y: b.y })
    return { x: Math.max(2, Math.round(left.x)), y: target.y }
  }

  // 悬停到某个元素上，等主进程接管鼠标，再真点一下。jump：直接跳过去；否则从窗口左边外面滑进来
  async function hoverAndClick(sel, { jump = false } = {}) {
    const r = await rectOf(win, sel)
    if (!r) return { ok: false, error: `找不到 ${sel}` }
    const target = toScreen(center(r))
    const step = { elementRect: r, point: target }
    const start = outside(target)
    await input.cmd(`move ${start.x} ${start.y}`)
    await sleep(300)
    await js(win, DIAG_TAKE)
    const logFrom = ignoreLog.length
    const reqFrom = ctx.rendererRequests.length
    step.cursor = await input.cmd(jump ? `jump ${target.x} ${target.y}` : `glide ${start.x} ${start.y} ${target.x} ${target.y} 8 25`)
    const tHover = Date.now()
    step.tookOver = await waitFor(() => !ctx.isIgnoring(), 1500, 20)
    step.hoverMs = Date.now() - tHover
    step.windowAtPoint = await input.cmd(`at ${target.x} ${target.y}`)
    step.children = await input.cmd(`children ${hwnd}`)
    step.exStyle = await input.cmd(`style ${hwnd}`)
    step.fgBefore = await input.cmd('fg')
    await input.cmd('click')
    await sleep(400)
    step.fgAfter = await input.cmd('fg')
    step.tookForeground = step.fgAfter.split(':')[0] === hwnd
    step.ignoreChanges = ignoreLog.slice(logFrom)
    step.rendererRequests = ctx.rendererRequests.slice(reqFrom)
    const d = await js(win, DIAG_TAKE)
    step.renderer = { moves: d.moves, events: d.events.map((e) => ({ ...e, t: rel(e.t) })) }
    step.gotMouseDown = d.events.some((e) => e.type === 'mousedown')
    return step
  }
  async function clickRegen(opts) {
    const before = ctx.regen()
    const st = await hoverAndClick(REGEN, opts)
    st.clicked = ctx.regen() > before
    st.ok = st.clicked && !st.tookForeground
    return st
  }

  const s = result.steps
  // 1. 开会，第一次显示后马上点「重新回答」：鼠标直接跳到按钮上（原来靠渲染进程切穿透时这一步必失败）
  await flow('meeting')
  s.firstShow = await clickRegen({ jump: true })
  result.foregroundBefore = s.firstShow.fgBefore

  // 2. 按两次 Ctrl+Alt+S、改一次外观、散会再开一场以后再点。0.4.2 的真机上这时按钮全都点不动
  await flow('toggle')
  await flow('appearance')
  await flow('meetingEnd')
  await flow('meeting')
  s.regenerate = await clickRegen()

  // 3. 复制：按钮把回答正文写进剪贴板
  {
    // Electron 44 主进程的 clipboard 读写可能返回 Promise，统一 await
    await clipboard.writeText('')
    const st = await hoverAndClick(COPY)
    await sleep(200)
    st.clipboard = await clipboard.readText()
    st.ok = st.clipboard === 'This is a self test answer.' && !st.tookForeground
    s.copy = st
  }

  // 4. 收起，再展开
  {
    const st = await hoverAndClick('#collapse')
    st.state = await panelState(win)
    st.ok = st.state.collapsed && !st.tookForeground
    s.collapse = st
    await waitFor(async () => (hitRects.at(-1)?.r?.height ?? 0) < (hitRects.at(-2)?.r?.height ?? 0), 1000)
    const st2 = await hoverAndClick('#collapse')
    st2.state = await panelState(win)
    // 收起没点动时面板本来就是展开的，不能算展开成功
    st2.ok = st.state.collapsed && !st2.state.collapsed && !st2.tookForeground
    s.expand = st2
  }

  // 5. 调整位置模式：拖标题栏移动，拖右下角改大小，点「完成」。
  //    鼠标按物理像素动，窗口位置是 DIP：165% 缩放下鼠标走 120 像素，窗口走 120 / 1.65 ≈ 73
  {
    ctx.editMode(true)
    await sleep(500)
    const b0 = win.getBounds()
    const r = await rectOf(win, '.bar .title')
    const p = toScreen(center(r))
    await input.cmd(`move ${p.x - 5} ${p.y}`)
    await sleep(100)
    await input.cmd(`glide ${p.x - 5} ${p.y} ${p.x} ${p.y} 2 30`)
    await sleep(150)
    const cursor = await input.cmd(`drag ${p.x} ${p.y} ${p.x - 120} ${p.y + 40} 12 30`)
    await sleep(600)
    const b1 = win.getBounds()
    // Windows 拖标题栏时第一下移动用来判断是不是拖动，窗口会少走一步（这里一步是 10, 3 物理像素），所以留 15 物理像素的余量
    const moved = { dx: b1.x - b0.x, dy: b1.y - b0.y }
    const want = { dx: -120 / scale, dy: 40 / scale }
    const slack = 15 / scale
    s.drag = { ok: Math.abs(moved.dx - want.dx) <= slack && Math.abs(moved.dy - want.dy) <= slack, cursorDelta: { dx: -120, dy: 40 }, want, moved, before: b0, after: b1, from: p, cursor }
    await js(win, DIAG_TAKE)

    const h = await rectOf(win, '.handle.rb')
    const q = toScreen(center(h))
    await input.cmd(`move ${q.x - 5} ${q.y - 5}`)
    await sleep(100)
    await input.cmd(`glide ${q.x - 5} ${q.y - 5} ${q.x} ${q.y} 2 30`)
    await sleep(150)
    const cursor2 = await input.cmd(`drag ${q.x} ${q.y} ${q.x - 30} ${q.y + 30} 10 30`)
    await sleep(600)
    const b2 = win.getBounds()
    const d = await js(win, DIAG_TAKE)
    const grow = 30 / scale
    s.resize = {
      ok: Math.abs(b2.width - (b1.width - grow)) <= 4 && Math.abs(b2.height - (b1.height + grow)) <= 4,
      want: { width: b1.width - grow, height: b1.height + grow },
      before: b1,
      after: b2,
      from: q,
      cursor: cursor2,
      renderer: { moves: d.moves, events: d.events.filter((e) => e.type !== 'mousemove').map((e) => ({ ...e, t: rel(e.t) })) },
    }

    const doneBefore = ctx.done()
    const dr = await rectOf(win, '#done')
    const dp = toScreen(center(dr))
    await input.cmd(`glide ${dp.x - 20} ${dp.y} ${dp.x} ${dp.y} 4 25`)
    await sleep(150)
    await input.cmd('click')
    const ok = await waitFor(() => ctx.done() > doneBefore, 1500)
    await sleep(400)
    s.done = { ok, point: dp, isFocusedAfter: win.isFocused() }
  }

  // 6. 退出调整模式后按钮还能点、前台不被抢；再藏起显示一次也还能点
  s.regenerateAfterEdit = await clickRegen()
  await flow('toggle')
  s.regenerateAfterToggle = await clickRegen()

  result.foregroundAfter = s.regenerateAfterToggle.fgAfter
  result.answerWindowTookForeground = Object.values(s).some((st) => st.tookForeground === true)
  result.diag.exStyleEnd = await input.cmd(`style ${hwnd}`)
  if (input.stderr.trim()) result.diag.powershellStderr = input.stderr.trim().slice(0, 1000)
}

/* ---------------- Mac：只走渲染进程的按钮逻辑 ---------------- */

async function macSteps(win, result, ctx) {
  const click = async (sel) => {
    const r = await rectOf(win, sel)
    if (!r) return false
    const x = Math.round(r.x + r.width / 2)
    const y = Math.round(r.y + r.height / 2)
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1 })
      await sleep(80)
    }
    await sleep(300)
    return true
  }
  const s = result.steps
  const regen = async () => {
    const before = ctx.regen()
    await click(REGEN)
    const clicked = ctx.regen() > before
    return { ok: clicked, clicked }
  }
  await ctx.flow('meeting')
  s.firstShow = await regen()
  await ctx.flow('toggle')
  await ctx.flow('appearance')
  await ctx.flow('meetingEnd')
  await ctx.flow('meeting')
  s.regenerate = await regen()
  await click('#collapse')
  s.collapse = { ok: (await panelState(win)).collapsed }
  await click('#collapse')
  s.expand = { ok: s.collapse.ok && !(await panelState(win)).collapsed }
}
