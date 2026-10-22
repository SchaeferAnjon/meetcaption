import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, screen, shell, systemPreferences, Tray, dialog } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SettingsStore, keywordList } from './settings.js'
import { accelLabel, patchFor, registerHotkey } from './hotkeys.js'
import { upgradePatch } from './defaults.js'
import { SessionStore } from './sessions.js'
import { INBOX_ID, ProjectStore, migrateSettingsToInbox } from './projects.js'
import { NOTES_HTML, Summarizer } from './summary.js'
import { aggregateTodos, openTodoCounts, patchTodo } from './todos.js'
import { searchLibrary } from './search.js'
import { MeetingEngine } from './engine.js'
import { RendererCapture } from './rendererCapture.js'
import { ChatGPTAuth, complete, listModels, llmStatus, resolveModel, isAbort, PROVIDERS } from './llm/index.js'
import { OpenAIRealtimeASR } from './asr/openai.js'
import { VolcStreamASR } from './asr/volc.js'
import { LocalStreamASR, localAsrAvailable, prewarmLocalAsr, stopLocalAsr } from './asr/local.js'
import { MODEL_ID, VoiceprintStore, loadVoiceprintModel } from './audio/voiceprint.js'
import { WavCapture } from './audio/wav.js'
import { MacSystemAudio, macTapSupported } from './audio/macTap.js'
import { dbfs } from './audio/gate.js'
import { recordVoiceprint } from './enroll.js'
import { Assistant } from './assist/assistant.js'
import { captureScreen, screenPermission } from './assist/screen.js'
import { createAnswerWindow, keepFrontApp, resetAnswerBounds, setAnswerEditMode, showAnswerWindow } from './assist/answerWindow.js'
import { centeredIn } from './assist/answerBounds.js'
import { applyTheme, chromeInfo, chromeOptions } from './windows.js'
import { runSelfTest } from './selftest.js'
import { resolveMode } from './modes.js'
import { exportNotesTo, notesBaseName, saveSlide } from './class/files.js'
import { notesPdf } from './class/notesPdf.js'
import { MATERIAL_TYPES, importMaterial, materialKind, removeMaterial } from './class/materials.js'
import { renderPdf } from './class/pdfRender.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

if (process.env.MEETCAPTION_USERDATA) app.setPath('userData', process.env.MEETCAPTION_USERDATA)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (isMac) app.setName('会议字幕')

const selfTest = process.argv.find((a) => a.startsWith('--selftest'))
// --selftest=ui:N 正常打开界面，字幕窗和答题框进入调整模式（显示示例），N 秒后退出；给 CI 截图看 Windows 上的显示。
const uiSelfTest = selfTest?.startsWith('--selftest=ui') ? Number(selfTest.split(':')[1]) || 8 : 0
if (!selfTest && !app.requestSingleInstanceLock()) app.quit()

let settings, projects, store, summarizer, engine, capture, chatgptAuth, assistant, vpStore
let controlWin = null
let settingsWin = null
let onboardingWin = null
let overlayWin = null
let answerWin = null
let tray = null
let overlayWanted = true
let editMode = false
let hotkeyError = null
let askHotkeyError = null
let slideHotkeyError = null
let recordHotkeyError = null
let hotkeyNotice = null // 默认快捷键换成了备选：启动时主窗口还没建好，等它加载完再提示
let classAnswered = false // 课堂上默认不出答题框，按快捷键答过一次才出
let quitting = false
let enrolling = false
let audioTest = null
let pointerLast = null
let overlayHit = null // 字幕框在字幕窗里的位置（页面报），鼠标在上面时接管点击，可以拖
let overlayGrab = false
let overlayFront = null // Mac：拖完把前台还给会议软件
let lastOnboarding = ''

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
// 主窗口、设置窗口、引导窗口共用 preload/control.cjs，事件三个都发
const toUi = (ch, p) => {
  for (const w of [controlWin, settingsWin, onboardingWin]) send(w, ch, p)
}
const toOverlay = (ch, p) => send(overlayWin, ch, p)
const toAnswer = (ch, p) => send(answerWin, ch, p)
const senderWin = (e) => BrowserWindow.fromWebContents(e.sender) ?? controlWin

// 翻译、纪要、答题统一走 A 模块的 complete；每次取最新设置，切换 AI 服务不用重建什么
const llm = (o) => complete(settings.get(), chatgptAuth, o)
const aiStatus = (s = settings.get()) => llmStatus(s, chatgptAuth)

function vpProfile() {
  const p = vpStore.load()
  return p && p.modelId === MODEL_ID ? p : null // 换过模型的旧声纹当没录，界面提示重录
}

function vpStatus() {
  const p = vpProfile()
  return { enrolled: Boolean(p), seconds: p?.seconds ?? 0, createdAt: p?.createdAt ?? null }
}

/* ---------------- 项目、会议、待办 ---------------- */

const defaultRoot = () => path.join(app.getPath('documents'), '会议字幕')
let libraryRoot = null // 这次加载的库在哪：启动和换保存位置时定一次，中途插上移动硬盘也不会一半写到另一个库里
let rootFallback = false

// 根目录：设置里的 saveDir，建不了（比如移动硬盘没插）就用默认的
function resolveRoot() {
  const dir = settings.get().saveDir
  rootFallback = false
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      return dir
    } catch {
      rootFallback = true
    }
  }
  return defaultRoot()
}

const rootDir = () => (libraryRoot ??= resolveRoot())

const trash = (dir) => shell.trashItem(dir)

// 课堂笔记带给模型的截图：缩到 1280 宽再编码，请求小一点
function slideDataUrl(file) {
  let img = nativeImage.createFromPath(file)
  if (img.isEmpty()) throw new Error('截图读不出来')
  if (img.getSize().width > 1280) img = img.resize({ width: 1280, quality: 'good' })
  return `data:image/jpeg;base64,${img.toJPEG(80).toString('base64')}`
}

// 扫描根目录、把根目录下的旧会议挪进「未归类」、把 v2 全局的会议背景等迁成「未归类」的默认值（只迁一次）
function initLibrary() {
  libraryRoot = resolveRoot()
  projects.load()
  store.reindex()
  const moved = store.migrateLegacy()
  const settingsMigrated = migrateSettingsToInbox(settings, projects)
  // 升级时的一次性修改（defaults.js 的 upgradePatch）：老设置里关掉的翻译打开一次，豆包资源 ID 还是旧默认 1.0 的换成 2.0；之后用户自己改回去不再动
  const upgrade = upgradePatch(settings.get())
  if (upgrade) settings.update(upgrade)
  if (moved.length) console.log(`把 ${moved.length} 场旧会议挪进了「未归类」`)
  return { root: projects.root(), moved, settingsMigrated, fallback: rootFallback }
}

// 保存位置暂时用不了（移动硬盘没插）、这次用的是默认位置：告诉用户一声
function rootNotice() {
  if (!rootFallback) return
  toUi('engine:notice', {
    level: 'warn',
    text: `保存位置「${settings.get().saveDir}」现在用不了（移动硬盘没插？），这次先存在「${libraryRoot}」。插上以后到设置里重新选一次保存位置。`,
    code: 'save-dir',
  })
}

function currentProjectId() {
  const id = settings.get().currentProjectId
  const p = id && projects.get(id)
  return p && !p.archived ? id : INBOX_ID
}

function projectStats() {
  const records = store.records()
  const known = new Set(projects.list().map((p) => p.id))
  const open = openTodoCounts(records, known)
  const meetings = new Map()
  const last = new Map()
  for (const r of records) {
    meetings.set(r.projectId, (meetings.get(r.projectId) ?? 0) + 1)
    last.set(r.projectId, Math.max(last.get(r.projectId) ?? 0, r.startedAt))
  }
  return (id) => ({ meetings: meetings.get(id) ?? 0, openTodos: open.get(id) ?? 0, lastMeetingAt: last.get(id) ?? null })
}

function listProjects() {
  const stats = projectStats()
  return projects.list().map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    icon: p.icon,
    description: p.description,
    archived: p.archived,
    createdAt: p.createdAt,
    inbox: p.id === INBOX_ID,
    ...stats(p.id),
  }))
}

function getProject(id) {
  const p = projects.get(id)
  if (!p) return null
  return { ...p, inbox: id === INBOX_ID, path: projects.dir(id), ...projectStats()(id) }
}

function emitProjects() {
  toUi('projects:changed', { projects: listProjects(), currentProjectId: currentProjectId() })
  updateTrayMenu()
  emitOnboarding()
}
const emitSessions = (p = {}) => toUi('sessions:changed', p)
const emitTodos = (p = {}) => toUi('todos:changed', p)

function setCurrentProject(id) {
  if (!projects.has(id)) throw new Error('找不到这个项目')
  if (settings.get().currentProjectId !== id) settings.update({ currentProjectId: id })
  emitProjects()
  return id
}

async function deleteProject(id) {
  if (id === INBOX_ID) return { ok: false, error: '「未归类」不能删除' }
  if (!projects.has(id)) return { ok: false, error: '找不到这个项目' }
  if (engine.state !== 'idle' && engine.session?.projectId === id) return { ok: false, error: '这个项目里正在开会，先停止记录' }
  try {
    const moved = store.moveAll(id, INBOX_ID)
    await projects.remove(id).finally(() => {
      if (settings.get().currentProjectId === id) settings.update({ currentProjectId: INBOX_ID })
      emitProjects()
      emitSessions({ projectId: INBOX_ID })
      emitTodos({})
    })
    return { ok: true, moved }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function todoView(session, item) {
  return { ...item, sessionId: session.id, sessionTitle: session.title, sessionStartedAt: session.startedAt, sessionProjectId: session.projectId }
}

function updateTodo(sessionId, itemId, patch) {
  const list = projects.list()
  const item = store.mutate(sessionId, (s) => {
    const items = s.summary?.items ?? []
    const i = items.findIndex((x) => x.id === itemId)
    if (i < 0) throw new Error('找不到这条待办')
    items[i] = patchTodo(items[i], patch, { projects: list })
    return todoView(s, items[i])
  })
  emitTodos({ sessionId, itemId })
  emitProjects()
  return item
}

function removeTodo(sessionId, itemId) {
  store.mutate(sessionId, (s) => {
    const items = s.summary?.items ?? []
    const i = items.findIndex((x) => x.id === itemId)
    if (i < 0) throw new Error('找不到这条待办（课上实时笔记里的作业不能单独删）')
    items.splice(i, 1)
  })
  emitTodos({ sessionId, itemId })
  emitProjects()
  return true
}

function onboardingStatus() {
  const s = settings.get()
  return {
    done: Boolean(s.onboarding?.done),
    voiceprint: vpStatus().enrolled,
    ai: aiStatus(s).ready,
    asr: s.engine === 'local' ? localAsrAvailable() : s.engine === 'volc' ? Boolean(s.volcAppId && s.volcAccessToken) : Boolean(s.openaiKey),
    project: projects.list().some((p) => p.id !== INBOX_ID && !p.archived),
  }
}

function emitOnboarding() {
  const st = onboardingStatus()
  const key = JSON.stringify(st)
  if (key === lastOnboarding) return
  lastOnboarding = key
  toUi('onboarding:changed', st)
}

/* ---------------- 模式 ---------------- */

// 这场会的模式（没在开会时是 null）
const liveMode = () => (engine && engine.state !== 'idle' ? engine.mode : null)

// AI 答题开没开：面试时强制开（modes.modeSettings），其他看设置
function assistOn(s = settings.get()) {
  return liveMode() === 'interview' || Boolean(s.assist.enabled)
}

// 上课记录中（截取画面的快捷键只在这时注册）
const classRunning = () => engine?.state === 'running' && engine.mode === 'class'

/* ---------------- 字幕悬浮窗 ---------------- */

// 字幕框本身的高度
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

function defaultOverlayBounds(o) {
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(Math.round(area.width * 0.7), 1100)
  const height = overlayHeight(o)
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + area.height - height - Math.round(area.height * 0.06), width, height }
}

// 默认位置在屏幕下方，往上长
function resetOverlayBounds() {
  overlayWin.setBounds(defaultOverlayBounds(settings.get().overlay))
  if (overlayAnchor() !== 'bottom') {
    settings.update({ overlay: { anchor: 'bottom' } })
    toOverlay('overlay:config', overlayConfig())
  }
}

function visibleOnSomeDisplay(b) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 20 && b.y + b.height > a.y + 20
  })
}

const OVERLAY_EDGE = 6 // 字幕条四周给阴影留的边，和 overlay.css 的 --edge 一样

// 字幕条的朝向：top 贴着窗口顶边往下长、术语解释在下面；bottom 贴着底边往上长、术语解释在上面
const overlayAnchor = () => settings.get().overlay.anchor

// 换高度（字号、行数、术语开关变了）时贴着的那条边不动
function resized(b, height, anchor = overlayAnchor()) {
  return anchor === 'top' ? { ...b, height } : { ...b, y: b.y + b.height - height, height }
}

/**
 * 松手后定朝向：字幕区在屏幕上半部就往下长，下半部往上长。换朝向时挪窗口，让字幕区（窗口里除去术语区的部分）留在原地。
 * 拖动中不换，不然字幕条会从鼠标底下跳走。
 */
function settleOverlayAnchor() {
  const b = overlayWin.getBounds()
  const cur = overlayAnchor()
  const tip = tipSpace()
  const areaTop = b.y + (cur === 'top' ? OVERLAY_EDGE : tip)
  const areaMid = areaTop + (b.height - tip - OVERLAY_EDGE) / 2
  const d = screen.getDisplayMatching(b).bounds
  const next = areaMid < d.y + d.height / 2 ? 'top' : 'bottom'
  if (next === cur) return
  const shift = tip - OVERLAY_EDGE
  overlayWin.setBounds({ ...b, y: Math.round(next === 'top' ? b.y + shift : b.y - shift) })
  settings.update({ overlay: { anchor: next, bounds: overlayWin.getBounds() } })
  toOverlay('overlay:config', overlayConfig())
}

// 拖动时字幕条能一直拖到屏幕最顶（窗口上半截的术语区伸出屏幕外），但整个字幕区不能拖出屏幕
function clampOverlayY(x, y, width, height) {
  const d = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) }).bounds
  const tip = tipSpace()
  const [areaTop, areaBottom] = overlayAnchor() === 'top' ? [OVERLAY_EDGE, height - tip] : [tip, height - OVERLAY_EDGE]
  return Math.min(Math.max(y, d.y - areaTop), d.y + d.height - areaBottom)
}

function createOverlay() {
  const o = settings.get().overlay
  const height = overlayHeight(o)
  // 贴着朝向的那条边换高度：v1 存的位置没有上方的透明区，直接用会让字幕往下掉一截
  const saved = o.bounds && visibleOnSomeDisplay(o.bounds)
  if (!saved && o.anchor !== 'bottom') settings.update({ overlay: { anchor: 'bottom' } })
  const bounds = saved ? resized(o.bounds, height, o.anchor) : defaultOverlayBounds(o)
  overlayWin = new BrowserWindow({
    ...bounds,
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
    acceptFirstMouse: true, // 随时拖动：不是焦点窗口时第一下按住就能拖
    enableLargerThanScreen: true, // Mac：无边框窗口才能拖到菜单栏那一条（屏幕最顶部）
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: { preload: path.join(root, 'preload/overlay.cjs'), backgroundThrottling: false },
  })
  overlayFront = isMac ? keepFrontApp(overlayWin) : null
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  overlayWin.setIgnoreMouseEvents(true)
  overlayWin.setContentProtection(settings.get().hideFromScreenShare)
  lockNavigation(overlayWin)
  overlayWin.loadFile(path.join(root, 'renderer/overlay/index.html'))
  let saveTimer
  overlayWin.on('moved', () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      // 调整位置模式里拖完（系统拖动，没有 released）也定一次朝向
      if (editMode) settleOverlayAnchor()
      saveOverlayBounds()
    }, 400)
  })
}

function saveOverlayBounds() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  settings.update({ overlay: { bounds: overlayWin.getBounds() } })
}

function overlayConfig() {
  const s = settings.get()
  return {
    ...s.overlay,
    editMode,
    running: engine.state !== 'idle',
    anchor: overlayAnchor(),
    terms: { enabled: s.terms?.enabled !== false },
    tipSpace: tipSpace(s),
    hotkeyToggle: s.hotkeyToggle,
    display: { ...s.display },
    mode: liveMode() ?? 'meeting',
    classSource: liveMode() === 'class' ? engine.classSource : null,
  }
}

// 字幕窗点击穿透，收不到鼠标事件（Mac 上 forward 也收不到）：主进程 50ms 读一次鼠标位置，
// 在字幕窗里就发窗口内坐标，出了窗口发 null；位置没变不发，字幕滚动时解释框才不会乱收。
// 术语解释和 AI 纠错（悬停纠正过的词看识别原文）都关着时不发坐标。
// 随时拖动：鼠标在字幕框（页面报的 overlayHit）上时接管点击，可以按住拖；离开恢复穿透。调整位置模式由 setEditMode 管。
function pollPointer() {
  let next = null
  let grab = false
  const t = settings.get().terms
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible() && !editMode) {
    const p = screen.getCursorScreenPoint()
    const b = overlayWin.getBounds()
    const x = p.x - b.x
    const y = p.y - b.y
    if (x >= 0 && x < b.width && y >= 0 && y < b.height && (t?.enabled !== false || t?.correct !== false)) next = { x, y }
    const r = overlayHit
    grab = Boolean(r) && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
  }
  if (grab !== overlayGrab && !editMode && overlayWin && !overlayWin.isDestroyed()) {
    overlayGrab = grab
    overlayWin.setIgnoreMouseEvents(!grab)
    if (grab) overlayFront?.enter()
  }
  if (next?.x === pointerLast?.x && next?.y === pointerLast?.y) return
  pointerLast = next
  toOverlay('overlay:pointer', next)
}

/* ---------------- 答题框 ---------------- */

function createAnswer() {
  const s = settings.get()
  answerWin = createAnswerWindow({
    preload: path.join(root, 'preload/answer.cjs'),
    page: path.join(root, 'renderer/answer/index.html'),
    bounds: s.overlay.answerBounds,
    contentProtection: s.hideFromScreenShare,
    onBoundsChange: (b) => settings.update({ overlay: { answerBounds: b } }),
    // 默认位置避开主窗口右上角的「停止」和窗口按钮；启动时主窗口还没建，按它默认居中的位置算
    avoid: () => (controlWin && !controlWin.isDestroyed() && controlWin.isVisible() ? controlWin.getBounds() : centeredIn(screen.getPrimaryDisplay().workArea, CONTROL_SIZE)),
  })
  lockNavigation(answerWin)
}

function answerConfig() {
  const s = settings.get()
  return { editMode, fontSize: 16, bgOpacity: 0.9, hotkeyAsk: s.assist.hotkeyAsk, mode: liveMode() ?? 'meeting', display: { ...s.display } }
}

// 答题框出不出：答题开着才出；课堂默认不出，按快捷键答过才出
function answerWanted() {
  if (!assistOn()) return false
  return liveMode() !== 'class' || classAnswered || editMode
}

function showWin(win, show) {
  if (!win || win.isDestroyed()) return
  if (show && !win.isVisible()) win.showInactive() // 不抢会议软件的焦点
  else if (!show && win.isVisible()) win.hide()
}

// 字幕窗和答题框一起显示、一起隐藏
function refreshOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return
  const on = editMode || (overlayWanted && engine.state !== 'idle')
  showWin(overlayWin, on)
  showAnswerWindow(answerWin, on && answerWanted())
  toOverlay('overlay:config', overlayConfig())
  toAnswer('answer:config', answerConfig())
  toUi('overlay:state', { visible: overlayWanted, editMode })
  updateTrayMenu()
}

function toggleOverlay() {
  overlayWanted = !overlayWanted
  refreshOverlay()
}

function setEditMode(on) {
  editMode = on
  overlayGrab = false
  overlayWin.setIgnoreMouseEvents(!on)
  overlayWin.setFocusable(on)
  setAnswerEditMode(answerWin, on)
  if (!on) saveOverlayBounds()
  refreshOverlay()
}

function applyOverlayAppearance() {
  const s = settings.get()
  const b = overlayWin.getBounds()
  const height = overlayHeight(s.overlay)
  if (b.height !== height) overlayWin.setBounds(resized(b, height))
  overlayWin.setContentProtection(s.hideFromScreenShare)
  if (answerWin && !answerWin.isDestroyed()) answerWin.setContentProtection(s.hideFromScreenShare)
  refreshOverlay()
}

/* ---------------- 快捷键、托盘 ---------------- */

function register(accel, fn) {
  if (!accel) return null
  try {
    return globalShortcut.register(accel, fn) ? null : `快捷键 ${accel} 被别的程序占用了，换一个试试`
  } catch (e) {
    return `快捷键格式不对：${e.message}`
  }
}

function hotkeyStatus() {
  const s = settings.get()
  return {
    accel: s.hotkeyToggle,
    error: hotkeyError,
    record: { accel: s.hotkeyRecord, error: recordHotkeyError },
    ask: { accel: assistOn(s) ? s.assist.hotkeyAsk : '', error: askHotkeyError },
    // 截取画面：只在上课记录时注册；active 表示现在注册上了
    slide: { accel: s.class.hotkeySlide, error: slideHotkeyError, active: classRunning() && Boolean(s.class.hotkeySlide) && !slideHotkeyError },
  }
}

const HOTKEY_NAMES = { hotkeyToggle: '显示 / 隐藏字幕', hotkeyRecord: '开始 / 停止记录', 'assist.hotkeyAsk': '回答刚才的问题', 'class.hotkeySlide': '截取画面' }

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const s = settings.get()
  const moved = []
  const reg = (key, accel, fn) => {
    const r = registerHotkey(key, accel, fn, register)
    if (r.moved) moved.push({ key, from: accel, to: r.moved })
    return r.error
  }
  hotkeyError = reg('hotkeyToggle', s.hotkeyToggle, toggleOverlay)
  recordHotkeyError = reg('hotkeyRecord', s.hotkeyRecord, () => toggleRecording())
  askHotkeyError = assistOn(s) ? reg('assist.hotkeyAsk', s.assist.hotkeyAsk, () => askLast()) : null
  slideHotkeyError = classRunning() ? reg('class.hotkeySlide', s.class.hotkeySlide, () => slideFromHotkey()) : null
  if (moved.length) {
    // 默认组合被别的程序占了：换成的备选存回设置（设置一变会再注册一遍、发状态），提示一次
    settings.update(Object.assign({}, ...moved.map((m) => patchFor(m.key, m.to))))
    const text = moved.map((m) => `${accelLabel(m.from)} 被别的程序占用了，「${HOTKEY_NAMES[m.key]}」改用 ${accelLabel(m.to)}`).join('；')
    hotkeyNotice = { level: 'info', text: `${text}。想换别的，在「设置 → 快捷键」里改。`, code: 'hotkey-moved' }
    toUi('engine:notice', hotkeyNotice)
    return
  }
  toUi('hotkey:status', hotkeyStatus())
}

/**
 * 全局快捷键「开始 / 停止记录」：没在记录就在当前项目里开始，正在记录就停止；还在连接（比如等系统授权麦克风）时再按一下是取消。
 * 开不起来时把主窗口叫出来说原因。
 */
async function toggleRecording() {
  if (engine.state === 'running' || engine.state === 'starting') return engine.stop()
  if (engine.state !== 'idle') return
  const r = await startEngine()
  if (r.ok || r.cancelled) return
  showControl()
  toUi('engine:notice', { level: 'error', text: `没能开始记录：${r.error}`, code: 'hotkey-start' })
}

/** 暂停 / 继续记录（同一场会议）。pause 不给就是切换。 */
function togglePause(pause = !engine.paused) {
  if (engine.state !== 'running') return { ok: false, error: '没在记录' }
  return (pause ? engine.pause() : engine.resume()).then(() => ({ ok: true, paused: engine.paused }))
}

/**
 * 托盘图标。Mac 用模板图（文件名以 Template 结尾，系统按菜单栏深浅反色）；
 * Windows / Linux 不认模板图，按任务栏深浅（shouldUseDarkColorsForSystemIntegratedUI）各一套，16 / 24 / 32 对应缩放 100% / 150% / 200%。
 * 录音中（在记录且没暂停）换成实心版。
 */
function trayImage(rec) {
  const dir = path.join(root, 'assets/tray')
  if (isMac) return nativeImage.createFromPath(path.join(dir, rec ? 'trayRecTemplate.png' : 'trayTemplate.png'))
  const theme = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark' : 'light'
  const file = (n) => path.join(dir, `win-tray-${theme}-${rec ? 'rec' : 'idle'}-${n}.png`)
  const img = nativeImage.createFromPath(file(16))
  img.addRepresentation({ scaleFactor: 1.5, buffer: fs.readFileSync(file(24)) })
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(file(32)) })
  return img
}

let trayIconKey = ''
function updateTrayIcon() {
  if (!tray) return
  const rec = engine.state === 'running' && !engine.paused
  const key = `${rec}|${nativeTheme.shouldUseDarkColorsForSystemIntegratedUI}`
  if (key === trayIconKey) return
  trayIconKey = key
  tray.setImage(trayImage(rec))
}

function updateTrayMenu() {
  if (!tray || !projects) return
  updateTrayIcon()
  const running = engine.state === 'running'
  const s = settings.get()
  const cur = currentProjectId()
  const curName = projects.get(cur)?.name ?? '未归类'
  const liveName = running ? projects.get(engine.session?.projectId)?.name : null
  const paused = running && engine.paused
  tray.setToolTip(running ? `会议字幕：${paused ? '已暂停' : '正在记录'}${liveName ? `（${liveName}）` : ''}` : '会议字幕')
  const projectItems = projects
    .list()
    .filter((p) => !p.archived)
    .map((p) => ({ label: p.name, type: 'radio', checked: p.id === cur, click: () => setCurrentProject(p.id) }))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: running ? `停止记录${liveName ? `（${liveName}）` : ''}` : `在「${curName}」里开始记录`, accelerator: s.hotkeyRecord || undefined, click: () => (running ? engine.stop() : startEngine()) },
      ...(running ? [{ label: paused ? '继续记录' : '暂停记录', click: () => togglePause() }] : []),
      { label: '当前项目', submenu: projectItems },
      { type: 'separator' },
      { label: overlayWanted ? '隐藏字幕' : '显示字幕', accelerator: s.hotkeyToggle || undefined, click: toggleOverlay },
      ...(assistOn(s) ? [{ label: '回答刚才的问题', accelerator: s.assist.hotkeyAsk || undefined, click: () => askLast() }] : []),
      ...(classRunning() ? [{ label: '截取画面', accelerator: s.class.hotkeySlide || undefined, click: () => slideFromHotkey() }] : []),
      { label: assistOn(s) ? '调整字幕和答题框位置' : '调整字幕位置', click: () => setEditMode(true) },
      { type: 'separator' },
      { label: '打开主窗口', click: showControl },
      { label: '设置…', click: () => openSettings() },
      { label: '退出', click: () => app.quit() },
    ]),
  )
}

function createTray() {
  tray = new Tray(trayImage(false))
  trayIconKey = `false|${nativeTheme.shouldUseDarkColorsForSystemIntegratedUI}`
  if (!isMac) tray.on('click', showControl) // Mac 上点托盘图标自动弹菜单
  updateTrayMenu()
}

/* ---------------- 主窗口、设置窗口、引导窗口 ---------------- */

const dark = () => nativeTheme.shouldUseDarkColors

// Windows 上菜单栏藏起来了：Ctrl+, 在页面里拦下来打开设置（Mac 走应用菜单的 ⌘,）
function wireWindowKeys(win) {
  if (isMac) return
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && !input.alt && !input.shift && input.key === ',') {
      e.preventDefault()
      openSettings()
    }
  })
}

function wireLinks(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  lockNavigation(win)
}

// 窗口只显示自己的页面：拖进来的 .html、页面里漏网的链接都不许把窗口带走（新页面也会被注入 preload，拿到全部接口）
function lockNavigation(win) {
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
}

// 窗口大小不超过当前屏幕可用区域的 92%（Windows 笔记本 1366x768 开 125% 缩放时只有约 1093x580）
function fitToScreen({ width, height, minWidth, minHeight }) {
  let area = { width, height }
  try {
    area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  } catch {}
  const w = Math.min(width, Math.floor(area.width * 0.92))
  const h = Math.min(height, Math.floor(area.height * 0.92))
  return { width: w, height: h, minWidth: Math.min(minWidth ?? w, w), minHeight: Math.min(minHeight ?? h, h) }
}

function uiWindow({ width, height, minWidth, minHeight, title, ...rest }) {
  const win = new BrowserWindow({
    ...fitToScreen({ width, height, minWidth, minHeight }),
    title,
    show: false,
    icon: path.join(root, isWin ? 'assets/icon.ico' : 'assets/icon.png'),
    ...chromeOptions({ dark: dark() }),
    ...rest,
    webPreferences: { preload: path.join(root, 'preload/control.cjs') },
  })
  win.setMenuBarVisibility(false)
  wireLinks(win)
  wireWindowKeys(win)
  return win
}

// 把窗口拿到最前面。Windows 的防抢焦点：应用从后台开窗口（比如引导完成后开主窗口、登录回调）时，
// show() 加 focus() 只让任务栏图标闪一下，窗口留在别的窗口后面；临时置顶再取消，它就排到普通窗口的最前面。
function bringToFront(win) {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!isWin) {
    win.show()
    win.focus()
    return
  }
  win.setAlwaysOnTop(true)
  win.show()
  win.moveTop()
  win.focus()
  win.setAlwaysOnTop(false)
}

// 点 Dock 图标、再次打开应用：引导还开着就把引导拿到前面，否则出主窗口
function focusApp() {
  if (onboardingWin && !onboardingWin.isDestroyed() && onboardingWin.isVisible()) {
    bringToFront(onboardingWin)
    return
  }
  showControl()
}

function showControl() {
  if (!controlWin || controlWin.isDestroyed()) createControl()
  bringToFront(controlWin)
}

const CONTROL_SIZE = { width: 1100, height: 720 }

function createControl() {
  controlWin = uiWindow({ ...CONTROL_SIZE, minWidth: 820, minHeight: 560, title: '会议字幕' })
  controlWin.loadFile(path.join(root, 'renderer/control/index.html'))
  controlWin.once('ready-to-show', () => bringToFront(controlWin))
  controlWin.webContents.once('did-finish-load', () =>
    setTimeout(() => {
      rootNotice()
      if (hotkeyNotice) toUi('engine:notice', hotkeyNotice)
      hotkeyNotice = null
      requestPermissionsAtLaunch()
    }, 800),
  )
  controlWin.on('close', (e) => {
    if (quitting) return
    // Windows 上没在识别时关窗口就是退出；识别进行中关窗口只是收到托盘里，字幕照常出。
    if (!isMac && engine.state === 'idle') {
      app.quit()
      return
    }
    e.preventDefault()
    controlWin.hide()
  })
}

/** 设置窗口：单实例，section 是要打开的分区（general、ai、asr、voiceprint、assist、overlay、hotkeys、mic、about）。 */
function openSettings(section) {
  const sec = typeof section === 'string' ? section : ''
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (sec) send(settingsWin, 'settings:section', sec)
    bringToFront(settingsWin)
    return
  }
  settingsWin = uiWindow({ width: 820, height: 600, minWidth: 700, minHeight: 480, title: '设置', fullscreenable: false })
  settingsWin.loadFile(path.join(root, 'renderer/settings/index.html'), sec ? { query: { section: sec } } : {})
  settingsWin.once('ready-to-show', () => bringToFront(settingsWin))
  settingsWin.on('closed', () => (settingsWin = null))
}

function openOnboarding() {
  if (onboardingWin && !onboardingWin.isDestroyed()) {
    bringToFront(onboardingWin)
    return
  }
  onboardingWin = uiWindow({ width: 760, height: 580, minWidth: 640, minHeight: 520, title: '欢迎使用会议字幕', resizable: false, maximizable: false, fullscreenable: false })
  onboardingWin.loadFile(path.join(root, 'renderer/onboarding/index.html'))
  onboardingWin.once('ready-to-show', () => bringToFront(onboardingWin))
  onboardingWin.on('closed', () => {
    onboardingWin = null
    // 没走完就关了：主窗口得出来，不然应用只剩托盘
    if (!quitting && (!controlWin || controlWin.isDestroyed() || !controlWin.isVisible())) showControl()
  })
}

function finishOnboarding() {
  settings.update({ onboarding: { done: true } })
  emitOnboarding()
  showControl()
  if (onboardingWin && !onboardingWin.isDestroyed()) onboardingWin.close()
  return onboardingStatus()
}

function buildAppMenu() {
  if (!isMac) return
  const dev = !app.isPackaged
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: '关于会议字幕' },
          { type: 'separator' },
          { label: '设置…', accelerator: settings.get().keys.settings || undefined, click: () => openSettings() },
          { type: 'separator' },
          { role: 'services', label: '服务' },
          { type: 'separator' },
          { role: 'hide', label: '隐藏会议字幕' },
          { role: 'hideOthers', label: '隐藏其他' },
          { role: 'unhide', label: '全部显示' },
          { type: 'separator' },
          { role: 'quit', label: '退出会议字幕' },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '拷贝' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
      ...(dev
        ? [
            {
              label: '开发',
              submenu: [{ role: 'reload', label: '重新载入' }, { role: 'toggleDevTools', label: '开发者工具' }],
            },
          ]
        : []),
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'zoom', label: '缩放' },
          { role: 'close', label: '关闭窗口' },
          { type: 'separator' },
          { label: '主窗口', click: showControl },
          { role: 'front', label: '前置全部窗口' },
        ],
      },
    ]),
  )
}

function applyLaunchAtLogin(on) {
  if (!app.isPackaged) return // 开发版别把 Electron 本体加进登录项
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(on) })
  } catch (e) {
    toUi('engine:notice', { level: 'warn', text: `开机启动没设置成功：${e.message}`, code: 'login-item' })
  }
}

const themeSource = (t) => (['dark', 'light'].includes(t) ? t : 'system')

function themeInfo() {
  return { source: settings.get().theme, dark: dark() }
}

/* ---------------- 开会 ---------------- */

/**
 * start({ projectId, mode, classSource })：mode 不给用项目的默认模式；课堂的 classSource 不给用项目上记的，再不行用设置里的默认。
 * 开始时选了课堂的声音来源就记在项目上，下次同一门课直接用。
 */
async function startEngine({ projectId, mode, classSource } = {}) {
  // 录声纹、声音测试和开会共用麦克风采集：同时开会互相把对方的采集窗口关掉
  if (enrolling) return { ok: false, error: '正在录制声纹，录完再开始记录', code: 'busy' }
  if (audioTest) return { ok: false, error: '正在测试声音，测完再开始记录', code: 'busy' }
  try {
    const id = projectId && projects.has(projectId) ? projectId : currentProjectId()
    if (id !== settings.get().currentProjectId) setCurrentProject(id)
    let project = projects.get(id)
    const m = resolveMode({ mode, classSource }, project, settings.get())
    if (m.mode === 'class' && classSource && project.classSource !== m.classSource) project = projects.update(id, { classSource: m.classSource })
    await engine.start({ project, mode: m.mode, classSource: m.classSource, extraKeywords: otherProjectWords(id) })
    return { ok: true, projectId: id, sessionId: engine.session?.id ?? null, mode: m.mode, classSource: m.classSource }
  } catch (e) {
    if (e.code === 'start-cancelled') return { ok: false, cancelled: true, error: e.message, code: e.code }
    return { ok: false, error: e.message }
  }
}

// 其他没归档项目的名字和术语：加进识别热词，会上顺带提到别的项目时少听错
function otherProjectWords(id) {
  const words = []
  for (const p of projects.list()) {
    if (p.archived || p.id === id) continue
    if (p.id !== INBOX_ID) words.push(p.name)
    words.push(...keywordList(p))
  }
  return words
}

/* ---------------- 课堂：截取画面、导出笔记 ---------------- */

function sessionDir(sessionId) {
  try {
    return sessionId ? store.dir(sessionId) : null
  } catch {
    return null
  }
}

function slideUrl(sessionId, file) {
  const dir = sessionDir(sessionId)
  return dir && file ? pathToFileURL(path.join(dir, file)).href : null
}

// 给界面的 slides 带上能直接放进 <img> 的 file:// 地址（只加在发给界面的副本上，不落盘）
function withSlideUrls(sessionId, slides) {
  return Array.isArray(slides) ? slides.map((x) => ({ ...x, url: slideUrl(sessionId, x.file) })) : slides
}

// 界面拿到的快照另带会议文件夹 dir 和截图的 url
function snapshotForUi() {
  const snap = engine.snapshot()
  return snap.session ? { ...snap, dir: sessionDir(snap.session.id), slides: withSlideUrls(snap.session.id, snap.slides) } : snap
}

/**
 * 给一节课加课件（PDF、图片）：files 不给就弹选文件框，拖进来的直接给路径。一份一份导入，进度发 materials:progress。
 * → { materials, errors }；取消选择返回 null。
 */
const importing = new Set()
async function addMaterials(e, id, files) {
  if (importing.has(id)) throw new Error('上一批课件还在读，读完再加')
  if (!files?.length) {
    const r = await dialog.showOpenDialog(senderWin(e), {
      title: '添加课件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '课件（PDF、图片）', extensions: Object.keys(MATERIAL_TYPES) }],
    })
    if (r.canceled) return null
    files = r.filePaths
  }
  importing.add(id)
  const errors = []
  try {
    const dir = store.dir(id)
    for (const file of files.map(String)) {
      if (!materialKind(file)) {
        errors.push(`${path.basename(file)}：课件要 PDF 或图片`)
        continue
      }
      const name = path.basename(file)
      try {
        const m = await importMaterial({
          sessionDir: dir,
          file,
          renderPdf,
          toJpeg: (f) => {
            let img = nativeImage.createFromPath(f)
            if (img.isEmpty()) throw new Error('图片读不出来')
            if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'good' })
            return img.toJPEG(85)
          },
          onProgress: (p) => toUi('materials:progress', { sessionId: id, name, ...p }),
        })
        changeMaterials(id, (list) => [...list, m])
      } catch (err) {
        errors.push(`${name}：${err.message}`)
      }
    }
  } finally {
    importing.delete(id)
    toUi('materials:progress', { sessionId: id, done: true })
  }
  return { materials: store.load(id).materials ?? [], errors }
}

// 改一节课的课件清单：正在记录的这节课也改内存里的那份，免得下一次自动保存把它盖掉
function changeMaterials(id, fn) {
  let list = []
  store.mutate(id, (s) => {
    list = s.materials = fn(s.materials ?? [])
  })
  if (engine.session?.id === id && engine.state !== 'idle') engine.session.materials = list
  emitSessions({ sessionId: id })
  return list
}

/**
 * 截当前屏幕（鼠标所在的显示器，网课课件）存进会议文件夹 slides/<时间>.jpg，记进 session.slides。
 * 截的时候我们自己的窗口（主窗口、设置、字幕窗、答题框）临时开内容保护，不进截图，截完恢复。→ { file, at, url } | { error, code }
 */
async function captureSlide() {
  if (engine.state !== 'running' || !engine.session) return { error: '还没开始记录，开始上课记录后才能截取画面', code: 'not-running' }
  const hide = settings.get().hideFromScreenShare
  const wins = [
    ...[controlWin, settingsWin, onboardingWin].map((w) => [w, false]),
    ...[overlayWin, answerWin].map((w) => [w, hide]),
  ].filter(([w]) => w && !w.isDestroyed() && w.isVisible())
  try {
    for (const [w] of wins) w.setContentProtection(true)
    const shot = await captureScreen({ maxWidth: 1920, quality: 0.85 })
    const at = Date.now()
    const id = engine.session.id
    const file = saveSlide(store.dir(id), Buffer.from(shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1), 'base64'), at)
    engine.addSlide({ file, at })
    return { file, at, url: slideUrl(id, file) }
  } catch (e) {
    return { error: e.message, code: e.code ?? null }
  } finally {
    for (const [w, keep] of wins) if (!w.isDestroyed()) w.setContentProtection(keep)
  }
}

// 快捷键截图：成功不打扰（界面收 slides:added），失败给一条提示
async function slideFromHotkey() {
  const r = await captureSlide()
  if (r.error) toUi('engine:notice', { level: 'warn', text: `截取画面失败：${r.error}`, code: 'slide' })
}

/** 导出笔记到笔记库：选文件夹（记住上次的），拷笔记和用到的截图。→ { dir, files } | null（取消）| { error } */
async function exportNotes(e, sessionId) {
  let session
  try {
    session = store.load(sessionId)
  } catch (err) {
    return { error: err.message }
  }
  if (!session.summary?.markdown) return { error: session.mode === 'class' ? '还没生成课堂笔记，先点「生成课堂笔记」' : '还没生成纪要' }
  const last = settings.get().class.exportDir
  const r = await dialog.showOpenDialog(senderWin(e), {
    title: '导出到笔记库',
    buttonLabel: '导出到这里',
    defaultPath: last && fs.existsSync(last) ? last : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (r.canceled || !r.filePaths[0]) return null
  const dir = r.filePaths[0]
  if (dir !== last) settings.update({ class: { exportDir: dir } })
  try {
    return exportNotesTo({ session, sessionDir: store.dir(sessionId), dir, projectName: projects.get(session.projectId)?.name ?? '' })
  } catch (err) {
    return { error: err.message }
  }
}

/* ---------------- 答题 ---------------- */

function askSegment(segId) {
  if (!assistOn()) return { ok: false, error: 'AI 答题没打开（设置 → AI 答题）' }
  return engine.askSegment(String(segId ?? ''))
}

function askLast() {
  if (!assistOn()) return { ok: false, error: 'AI 答题没打开（设置 → AI 答题）' }
  const r = engine.askLast()
  if (!r.ok) toUi('engine:notice', { level: 'warn', text: `没法回答：${r.error}`, code: 'assist-ask' })
  return r
}

// Mac 上答题要带截图但没有屏幕录制权限：开始记录时提示一次（没权限照样答，只是不带图）
function checkScreenPermission() {
  const s = settings.get()
  if (!isMac || screenPermission() === 'granted') return
  if (liveMode() === 'class') {
    toUi('engine:notice', {
      level: 'warn',
      text: '截取画面要用屏幕录制权限，会议字幕还没有。去「系统设置 → 隐私与安全性 → 录屏与系统录音」打开「会议字幕」，下课后点「重启」生效。',
      code: 'screen-permission',
    })
    return
  }
  if (!s.assist.enabled || !s.assist.withScreen) return
  toUi('engine:notice', {
    level: 'warn',
    text: 'AI 答题要带屏幕截图，但会议字幕还没有屏幕录制权限，这次回答不带截图。去「系统设置 → 隐私与安全性 → 录屏与系统录音」打开「会议字幕」，重启应用后生效。',
    code: 'screen-permission',
  })
}

/* ---------------- 声纹、权限、声音测试 ---------------- */

// 开发时不接设备：MEETCAPTION_FAKE_SYSTEM / MEETCAPTION_FAKE_MIC 指向 16 位 WAV，开会、录声纹、声音测试都用文件代替
const fakeFiles = { system: process.env.MEETCAPTION_FAKE_SYSTEM, mic: process.env.MEETCAPTION_FAKE_MIC }
const useFakes = Boolean(fakeFiles.system || fakeFiles.mic)

async function enrollVoiceprint(seconds) {
  if (enrolling) return { ok: false, error: '正在录制声纹' }
  if (engine.state !== 'idle') return { ok: false, error: '正在记录会议，先停止记录再录声纹' }
  if (audioTest) return { ok: false, error: '正在测试声音，等测试结束再录' }
  enrolling = true
  try {
    const r = await recordVoiceprint({
      capture: useFakes ? new WavCapture(fakeFiles) : capture,
      store: vpStore,
      seconds,
      micDeviceId: settings.get().micDeviceId,
      onProgress: (p) => toUi('voiceprint:progress', p),
    })
    emitOnboarding()
    return r.ok ? { ok: true, status: vpStatus() } : { ok: false, error: r.error, code: r.code }
  } finally {
    enrolling = false
  }
}

/**
 * 引导最后一步的「放点声音看音量条」：只采集不识别，seconds 秒（2 到 15），期间发 'audio:level' { source, db }。
 * Mac 第一次抓系统声音时系统会弹录音授权。→ { ok, system: { heard, maxDb }, mic: { heard, maxDb } | null }
 */
async function testAudio({ seconds = 5, mic } = {}) {
  if (engine.state !== 'idle') return { ok: false, error: '正在记录会议' }
  if (enrolling) return { ok: false, error: '正在录制声纹' }
  if (audioTest) return { ok: false, error: '声音测试已经在进行' }
  const secs = Math.min(15, Math.max(2, Number(seconds) || 5))
  const withMic = mic ?? settings.get().captureMic
  const stats = { system: { maxDb: -100, bytes: 0 }, mic: { maxDb: -100, bytes: 0 } }
  const errors = []
  const onPcm = (source, buf) => {
    const st = stats[source]
    if (!st) return
    const b = Buffer.from(buf)
    const db = Math.round(dbfs(new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1)) * 10) / 10
    st.maxDb = Math.max(st.maxDb, db)
    st.bytes += b.length
    toUi('audio:level', { source, db })
  }
  const onError = (source, msg) => errors.push(`${source === 'mic' ? '麦克风' : '系统声音'}：${msg}`)
  const fake = useFakes ? new WavCapture(fakeFiles) : null
  let tap = null
  let token = null
  audioTest = { stop: () => {} }
  try {
    if (fake) await fake.start({ system: true, mic: withMic, sampleRate: 16000, onPcm })
    else {
      if (isMac) {
        if (!macTapSupported()) throw new Error('抓电脑声音需要 macOS 14.2 或更新的系统')
        tap = new MacSystemAudio({ sampleRate: 16000 })
        tap.on('data', (buf) => onPcm('system', buf))
        tap.on('error', (e) => onError('system', e.message))
        tap.start()
      }
      if (!isMac || withMic) token = await capture.start({ system: !isMac, mic: withMic, sampleRate: 16000, micDeviceId: settings.get().micDeviceId, onPcm, onError })
    }
    await new Promise((r) => setTimeout(r, secs * 1000))
  } catch (e) {
    errors.push(e.message)
  } finally {
    fake?.stop()
    tap?.stop()
    if (!fake) capture.stop(token) // token 为空（没开成）时停掉半开的窗口
    audioTest = null
  }
  const out = (st) => ({ heard: st.maxDb > -50, maxDb: st.maxDb, seconds: Math.round((st.bytes / 32000) * 10) / 10 })
  return { ok: errors.length === 0, error: errors[0] ?? null, system: out(stats.system), mic: withMic ? out(stats.mic) : null }
}

/** 设置的「权限」页和引导用：麦克风、屏幕录制现在的状态（'granted' | 'denied' | 'not-determined' | 'restricted'）。系统录音没有查询接口，不在这里。 */
function permissionStatus() {
  return { microphone: systemPreferences.getMediaAccessStatus('microphone'), screen: isMac ? screenPermission() : 'granted' }
}

/** 申请权限：kind = 'microphone' | 'screen' | 'systemAudio'。→ { kind, status: 'granted' | 'denied' | 'not-determined' | … } */
async function requestPermission(kind) {
  if (kind === 'systemAudio') {
    // 系统录音没有查询接口：短跑一次 audiotee，没授权时 macOS 弹框
    if (isMac && macTapSupported() && !fakeFiles.system) probeSystemAudio()
    return { kind, status: 'unknown' }
  }
  if (!isMac) return { kind, status: 'granted' }
  if (kind === 'microphone') {
    await systemPreferences.askForMediaAccess('microphone').catch(() => false)
    return { kind, status: systemPreferences.getMediaAccessStatus('microphone') }
  }
  if (kind === 'screen') {
    // 第一次取屏幕会让系统把应用加进「录屏与系统录音」列表并弹授权框
    if (screenPermission() !== 'granted') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {})
    return { kind, status: screenPermission() }
  }
  return { kind, status: 'unknown' }
}

/* ---------------- 一打开就要权限 ---------------- */

// 麦克风没决定就弹框；屏幕录制、系统录音没给就触发一次系统授权（应用会出现在「录屏与系统录音」列表里），
// 不等开始上课才弹。还没给的在主窗口挂提示。首次引导开着时它会一步步自己要，这里不抢。每次启动只要一次。
let permissionsAsked = false
async function requestPermissionsAtLaunch() {
  if (!isMac || selfTest || uiSelfTest || permissionsAsked || (onboardingWin && !onboardingWin.isDestroyed())) return
  permissionsAsked = true
  if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone').catch(() => false)
  if (screenPermission() !== 'granted') await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {})
  if (macTapSupported() && !fakeFiles.system) probeSystemAudio()
  if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    toUi('engine:notice', { level: 'warn', text: '会议字幕没有麦克风权限：教室现场上课、你自己说的话都录不到。去「系统设置 → 隐私与安全性 → 麦克风」打开「会议字幕」。', code: 'mic-permission' })
  }
  if (screenPermission() !== 'granted') {
    toUi('engine:notice', { level: 'warn', text: '截取画面和 AI 答题带截图要用屏幕录制权限。去「系统设置 → 隐私与安全性 → 录屏与系统录音」打开「会议字幕」，再点「重启」生效。', code: 'screen-permission' })
  }
}

// 系统录音没有查询接口：短跑一次 audiotee，没授权时系统会弹框；出了数据（已授权或刚点了允许）、出错或 30 秒后就停，数据丢掉
function probeSystemAudio() {
  const tap = new MacSystemAudio({ sampleRate: 16000 })
  let timer
  const stop = () => {
    clearTimeout(timer)
    tap.removeAllListeners()
    tap.stop()
  }
  tap.once('data', stop)
  tap.on('error', stop)
  timer = setTimeout(stop, 30_000)
  tap.start()
}

// 屏幕录制权限给了要重启才生效：主窗口提示里的「重启」。正在记录时不重启
function relaunchApp() {
  if (engine.state !== 'idle') return { ok: false, error: '正在记录，停止后再重启' }
  app.relaunch()
  app.quit()
  return { ok: true }
}

function privacyUrl(kind) {
  if (isMac) return `x-apple.systempreferences:com.apple.preference.security?${kind === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture'}`
  return kind === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:sound'
}

/* ---------------- 连接测试 ---------------- */

async function testAsr(patch) {
  const s = { ...settings.get(), ...patch }
  const provider =
    s.engine === 'local'
      ? new LocalStreamASR()
      : s.engine === 'volc'
        ? new VolcStreamASR({ appId: s.volcAppId, accessToken: s.volcAccessToken, resourceId: s.volcResourceId })
        : new OpenAIRealtimeASR({ key: s.openaiKey, baseUrl: s.openaiBaseUrl, model: s.openaiModel, languages: [], delay: s.openaiDelay })
  provider.on('fatal', () => {})
  try {
    await provider.connect()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    provider.close().catch(() => {})
  }
}

async function testLlm(patch) {
  const s = { ...settings.get(), ...patch }
  const st = aiStatus(s)
  if (!st.ready) return { ok: false, error: st.reason }
  try {
    const t0 = Date.now()
    const out = await complete(s, chatgptAuth, { model: 'fast', effort: 'none', timeoutMs: 20_000, messages: [{ role: 'user', content: 'Translate to Chinese: good morning' }] })
    return { ok: true, sample: out, ms: Date.now() - t0, label: st.label }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/* ---------------- IPC ---------------- */

function wireIpc() {
  ipcMain.handle('app:init', () => ({
    settings: settings.get(),
    snapshot: snapshotForUi(),
    platform: process.platform,
    version: app.getVersion(),
    hotkey: hotkeyStatus(),
    overlay: { visible: overlayWanted, editMode },
    sessionsDir: store.baseDir(),
    chatgpt: chatgptAuth.status(),
    voiceprint: vpStatus(),
    llm: aiStatus(),
    llmProviders: PROVIDERS,
    screenPermission: screenPermission(),
    permissions: permissionStatus(),
    projects: listProjects(),
    currentProjectId: currentProjectId(),
    onboarding: onboardingStatus(),
    theme: themeInfo(),
    chrome: chromeInfo(),
  }))
  ipcMain.handle('settings:update', (_e, patch) => settings.update(patch))
  ipcMain.handle('engine:start', (_e, opts) => startEngine(opts ?? {}))
  ipcMain.handle('engine:stop', () => engine.stop())
  ipcMain.handle('engine:pause', () => togglePause(true))
  ipcMain.handle('engine:resume', () => togglePause(false))
  ipcMain.handle('engine:setMic', (_e, id) => settings.update({ micDeviceId: String(id ?? '') }))
  ipcMain.handle('overlay:toggle', () => toggleOverlay())
  ipcMain.handle('overlay:edit', (_e, on) => setEditMode(Boolean(on)))
  ipcMain.handle('overlay:resetPosition', () => {
    resetOverlayBounds()
    saveOverlayBounds()
    const b = resetAnswerBounds(answerWin)
    if (b) settings.update({ overlay: { answerBounds: b } })
  })

  // 项目
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:get', (_e, id) => getProject(id))
  ipcMain.handle('projects:create', (_e, p) => projects.create(p ?? {}))
  ipcMain.handle('projects:update', (_e, id, patch) => projects.update(id, patch ?? {}))
  ipcMain.handle('projects:delete', (_e, id) => deleteProject(id))
  ipcMain.handle('projects:setCurrent', (_e, id) => setCurrentProject(id))
  ipcMain.handle('projects:openFolder', (_e, id) => shell.openPath(projects.dir(id ?? currentProjectId())))

  // 会议
  ipcMain.handle('sessions:list', (_e, opts) => store.list(opts ?? {}))
  ipcMain.handle('sessions:load', (_e, id) => {
    const s = store.load(id)
    return { ...s, dir: sessionDir(id), slides: withSlideUrls(id, s.slides) }
  })
  ipcMain.handle('sessions:rename', (_e, id, title) => {
    const s = store.update(id, { title: String(title ?? '').slice(0, 120) })
    emitSessions({ sessionId: id, projectId: s.projectId })
    return s
  })
  ipcMain.handle('sessions:move', (_e, id, projectId) => {
    const from = store.projectOf(id)
    const s = store.move(id, projectId)
    emitSessions({ sessionId: s.id, projectId, from, previousId: id !== s.id ? id : undefined })
    emitProjects()
    emitTodos({ sessionId: s.id })
    return s
  })
  ipcMain.handle('sessions:remove', async (e, id) => {
    if (store.isLive(id)) {
      await dialog.showMessageBox(senderWin(e), { type: 'info', message: '这场会议正在记录', detail: '先停止记录再删除。' })
      return false
    }
    const { response } = await dialog.showMessageBox(senderWin(e), {
      type: 'warning',
      buttons: ['删除', '取消'],
      defaultId: 1,
      cancelId: 1,
      message: '删除这场会议的记录？',
      detail: '文件夹会移到废纸篓 / 回收站，还能找回。',
    })
    if (response !== 0) return false
    const projectId = store.projectOf(id)
    await store.remove(id)
    emitSessions({ sessionId: id, projectId, removed: true })
    emitProjects()
    emitTodos({ sessionId: id })
    return true
  })
  ipcMain.handle('sessions:openFolder', (_e, id) => shell.openPath(id ? store.dir(id) : store.baseDir()))
  ipcMain.handle('materials:add', (e, id, files) => addMaterials(e, id, files))
  ipcMain.handle('materials:remove', (_e, id, materialId) => {
    removeMaterial(store.dir(id), materialId)
    return changeMaterials(id, (list) => list.filter((m) => m.id !== materialId))
  })
  ipcMain.handle('sessions:pickDir', async (e) => {
    const r = await dialog.showOpenDialog(senderWin(e), { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // 纪要和待办
  ipcMain.handle('summary:generate', async (_e, id, extraAsk) => {
    try {
      return { ok: true, ...(await summarizer.generate(id, extraAsk)) }
    } catch (e) {
      return { ok: false, error: isAbort(e) ? '已取消' : e.message }
    }
  })
  ipcMain.handle('summary:cancel', (_e, id) => summarizer.cancel(id))
  // 图文版课堂笔记：主窗口里直接看；也能用浏览器打开、导出 PDF，这两个在还没有（早先生成的课堂笔记）时先做一份
  async function notesHtmlFile(id) {
    const file = path.join(store.dir(id), NOTES_HTML)
    const htmlError = !store.load(id).summary?.html || !fs.existsSync(file) ? (await summarizer.buildHtml(id)).htmlError : null
    return { file, htmlError }
  }
  ipcMain.handle('notes:buildHtml', async (_e, id) => {
    try {
      return { ok: true, ...(await summarizer.buildHtml(id)) }
    } catch (e) {
      return { ok: false, error: isAbort(e) ? '已取消' : e.message }
    }
  })
  ipcMain.handle('notes:openHtml', async (_e, id) => {
    try {
      const { file, htmlError } = await notesHtmlFile(id)
      const err = await shell.openPath(file)
      if (err) throw new Error(err)
      return { ok: true, htmlError }
    } catch (e) {
      return { ok: false, error: isAbort(e) ? '已取消' : e.message }
    }
  })
  // 存在哪由用户选（默认这节课的文件夹），存好用默认程序打开
  ipcMain.handle('notes:exportPdf', async (e, id) => {
    try {
      const { file, htmlError } = await notesHtmlFile(id)
      const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
        title: '导出图文笔记 PDF',
        defaultPath: path.join(store.dir(id), `${notesBaseName(store.load(id))}.pdf`),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      })
      if (r.canceled || !r.filePath) return null
      fs.writeFileSync(r.filePath, await notesPdf(file))
      const err = await shell.openPath(r.filePath)
      return { ok: true, file: r.filePath, htmlError, openError: err || null }
    } catch (e) {
      return { ok: false, error: isAbort(e) ? '已取消' : e.message }
    }
  })
  ipcMain.handle('todos:extract', async (_e, id) => {
    try {
      return { ok: true, ...(await summarizer.extract(id)) }
    } catch (e) {
      return { ok: false, error: isAbort(e) ? '已取消' : e.message }
    }
  })
  ipcMain.handle('todos:list', (_e, opts = {}) =>
    aggregateTodos(store.records(), { projectId: opts?.projectId, includeDone: Boolean(opts?.includeDone), knownProjects: new Set(projects.list().map((p) => p.id)) }),
  )
  ipcMain.handle('todos:update', (_e, sessionId, itemId, patch) => updateTodo(sessionId, itemId, patch ?? {}))
  ipcMain.handle('todos:remove', (_e, sessionId, itemId) => removeTodo(sessionId, itemId))
  ipcMain.handle('search:query', (_e, query) => searchLibrary({ query, projects: projects.list(), records: store.records() }))

  // 窗口和引导
  ipcMain.handle('window:openSettings', (_e, section) => openSettings(section))
  ipcMain.handle('window:openOnboarding', () => openOnboarding())
  ipcMain.handle('window:showMain', () => showControl())
  ipcMain.handle('onboarding:status', () => onboardingStatus())
  ipcMain.handle('onboarding:finish', () => finishOnboarding())

  ipcMain.handle('test:asr', (_e, patch) => testAsr(patch))
  ipcMain.handle('test:llm', (_e, patch) => testLlm(patch))
  ipcMain.handle('llm:models', () => listModels(settings.get()))
  ipcMain.handle('test:audio', (_e, opts) => testAudio(opts ?? {}))
  ipcMain.handle('llm:status', () => aiStatus())
  ipcMain.handle('permission:request', (_e, kind) => requestPermission(kind))
  ipcMain.handle('shell:openPrivacy', (_e, kind) => shell.openExternal(privacyUrl(kind)))
  ipcMain.handle('app:relaunch', () => relaunchApp())
  ipcMain.handle('shell:openExternal', (_e, url) => /^https:/.test(url) && shell.openExternal(url))
  ipcMain.handle('screen:permission', () => screenPermission())
  ipcMain.handle('permission:status', () => permissionStatus())

  // ChatGPT 账号登录（status 里没有 token，可以直接给界面）
  ipcMain.handle('chatgpt:status', () => chatgptAuth.status())
  ipcMain.handle('chatgpt:login', async () => {
    try {
      return { ok: true, status: await chatgptAuth.login({ openExternal: (url) => shell.openExternal(url) }) }
    } catch (e) {
      return { ok: false, code: e.code, error: e.message, status: chatgptAuth.status() }
    }
  })
  ipcMain.handle('chatgpt:logout', async () => {
    try {
      await chatgptAuth.logout()
    } catch (e) {
      return { ...chatgptAuth.status(), error: e.message }
    }
    return chatgptAuth.status()
  })
  ipcMain.handle('chatgpt:cancelLogin', () => chatgptAuth.cancelLogin())

  // 声纹
  ipcMain.handle('voiceprint:status', () => vpStatus())
  ipcMain.handle('voiceprint:enroll', (_e, seconds) => enrollVoiceprint(seconds))
  ipcMain.handle('voiceprint:clear', () => {
    vpStore.clear()
    emitOnboarding()
    return vpStatus()
  })

  // 课堂
  ipcMain.handle('class:captureSlide', () => captureSlide())
  ipcMain.handle('notes:export', (e, id) => exportNotes(e, id))

  // 答题
  ipcMain.handle('assist:askLast', () => askLast())
  ipcMain.handle('assist:askSegment', (_e, segId) => askSegment(segId))
  ipcMain.handle('assist:regenerate', (_e, id) => assistant.regenerate(id))
  ipcMain.on('answer:ready', (e) => {
    if (e.sender !== answerWin?.webContents) return
    toAnswer('answer:config', answerConfig())
    for (const a of assistant.list()) toAnswer('answer:update', a)
  })
  ipcMain.on('answer:regenerate', (_e, id) => assistant.regenerate(id))
  ipcMain.on('answer:doneEditing', () => setEditMode(false))

  // 悬浮窗
  ipcMain.on('overlay:ready', () => {
    toOverlay('overlay:config', overlayConfig())
    toOverlay('overlay:segments', engine.snapshot().segments)
  })
  ipcMain.on('overlay:setHorizontal', (_e, { x, width }) => {
    const b = overlayWin.getBounds()
    overlayWin.setBounds({ ...b, x: Math.round(x), width: Math.max(320, Math.round(width)) })
  })
  ipcMain.on('overlay:doneEditing', () => setEditMode(false))
  ipcMain.on('overlay:hitRect', (e, r) => {
    if (e.sender !== overlayWin?.webContents) return
    overlayHit = r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 ? r : null
  })
  ipcMain.on('overlay:moveTo', (e, p) => {
    if (e.sender !== overlayWin?.webContents || editMode || !p || ![p.x, p.y].every(Number.isFinite)) return
    const { width, height } = overlayWin.getBounds()
    overlayWin.setBounds({ x: Math.round(p.x), y: Math.round(clampOverlayY(p.x, p.y, width, height)), width, height })
  })
  ipcMain.on('overlay:released', (e) => {
    if (e.sender !== overlayWin?.webContents) return
    settleOverlayAnchor()
    saveOverlayBounds()
    overlayFront?.clicked()
  })
}

function wireEngine() {
  engine.on('state', (st) => {
    toUi('engine:state', { ...st, dir: sessionDir(st.sessionId ?? st.lastSessionId) })
    if (st.state === 'running') {
      classAnswered = false
      // 上一场按快捷键藏起来的字幕，新的一场重新显示（不然会以为坏了）
      overlayWanted = true
    }
    if (st.state === 'running' || st.state === 'idle') {
      refreshOverlay()
      // 面试时答题快捷键强制开、上课时多一个截取画面的快捷键：开始和结束时重新注册
      if (st.mode !== 'meeting') registerHotkeys()
    }
    toOverlay('overlay:config', overlayConfig())
    if (st.state === 'running') {
      toOverlay('overlay:segments', [])
      toAnswer('answer:clear')
      checkScreenPermission()
    }
    if (st.state === 'running' || (st.state === 'idle' && st.lastSessionId)) {
      emitSessions({ sessionId: st.sessionId ?? st.lastSessionId, projectId: st.projectId })
      emitProjects()
    }
  })
  engine.on('segment', (seg) => {
    toUi('engine:segment', seg)
    toOverlay('overlay:segment', seg)
  })
  engine.on('level', (lv) => toUi('engine:level', lv))
  engine.on('pause', (p) => {
    toUi('engine:pause', p)
    toOverlay('overlay:config', overlayConfig())
    updateTrayMenu()
  })
  engine.on('devices', (d) => toUi('engine:devices', d))
  engine.on('notice', (n) => toUi('engine:notice', n))
  engine.on('notes', (n) => toUi('notes:update', n))
  engine.on('slide', (x) => toUi('slides:added', { ...x, url: slideUrl(x.sessionId, x.file) }))
  assistant.on('answer', (a) => {
    toAnswer('answer:update', a)
    toUi('assist:answer', a)
    // 主窗口点提问句答的，回答就在主窗口的小框里，不另外弹悬浮答题框
    if (liveMode() === 'class' && !classAnswered && a.reason !== 'click') {
      classAnswered = true
      refreshOverlay()
    }
  })
  summarizer.on('progress', (p) => toUi('summary:progress', p))
  summarizer.on('saved', ({ id, items }) => {
    let projectId = null
    try {
      projectId = store.projectOf(id)
    } catch {}
    emitSessions({ sessionId: id, projectId })
    if (items) {
      emitTodos({ sessionId: id })
      emitProjects()
    }
  })
  chatgptAuth.on('status', (st) => {
    toUi('chatgpt:status', st)
    emitOnboarding()
  })
  projects.on('change', ({ id }) => {
    if (engine.state !== 'idle' && engine.project?.id === id) engine.setProject(projects.get(id))
    emitProjects()
  })
  nativeTheme.on('updated', () => {
    for (const w of [controlWin, settingsWin, onboardingWin]) applyTheme(w, dark())
    toUi('theme:changed', themeInfo())
    updateTrayIcon()
  })
  settings.on('change', (next, prev) => {
    toUi('settings:changed', next)
    if (
      next.hotkeyToggle !== prev.hotkeyToggle ||
      next.hotkeyRecord !== prev.hotkeyRecord ||
      next.assist.hotkeyAsk !== prev.assist?.hotkeyAsk ||
      next.assist.enabled !== prev.assist?.enabled ||
      next.class?.hotkeySlide !== prev.class?.hotkeySlide
    )
      registerHotkeys()
    if (next.keys.settings !== prev.keys?.settings) buildAppMenu()
    if (next.engine === 'local' && prev.engine !== 'local') prewarmLocalAsr()
    // 换成云端识别：本地识别进程（常驻约 250 MB）关掉；正在用它开会时等下次启动再说
    if (prev.engine === 'local' && next.engine !== 'local' && engine.state === 'idle') stopLocalAsr()
    if (next.theme !== prev.theme) nativeTheme.themeSource = themeSource(next.theme)
    if (next.launchAtLogin !== prev.launchAtLogin) applyLaunchAtLogin(next.launchAtLogin)
    if (next.saveDir !== prev.saveDir) {
      // 换了根目录：重新扫描，那边根目录下的旧会议一样挪进「未归类」
      try {
        initLibrary()
        rootNotice()
      } catch (e) {
        toUi('engine:notice', { level: 'error', text: `新的保存位置用不了：${e.message}`, code: 'save-dir' })
      }
      emitProjects()
      emitSessions({})
      emitTodos({})
    }
    if (overlayWin && !overlayWin.isDestroyed()) applyOverlayAppearance()
    updateTrayMenu()
    emitOnboarding()
  })
}

// 自测结束直接退出。先标上 quitting：app.exit 会一个个关掉窗口，引导窗口关掉时如果主窗口已经没了会再开一个主窗口，
// 窗口永远关不完，进程就一直挂着（--selftest=ui 带 MEETCAPTION_UI_SHOTS 时就是这样）
function exitNow(code) {
  quitting = true
  app.exit(code)
}

/** --selftest=ui 的窗口截图：每个窗口的页面一张 PNG，另写 windows.json（位置、大小、窗口外观、屏幕可用区域）。 */
async function saveUiShots(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const wins = { main: controlWin, settings: settingsWin, onboarding: onboardingWin, overlay: overlayWin, answer: answerWin }
  const out = {}
  for (const [name, w] of Object.entries(wins)) {
    if (!w || w.isDestroyed()) continue
    try {
      const img = await w.webContents.capturePage()
      fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG())
      out[name] = { ...w.getBounds(), visible: w.isVisible(), size: img.getSize() }
    } catch (e) {
      out[name] = { error: e.message }
    }
  }
  const report = { platform: process.platform, chrome: chromeInfo(), workArea: screen.getPrimaryDisplay().workArea, scaleFactor: screen.getPrimaryDisplay().scaleFactor, windows: out }
  fs.writeFileSync(path.join(dir, 'windows.json'), JSON.stringify(report, null, 2))
}

// 再打开一次应用：把已经开着的这个拿到前面
app.on('second-instance', () => focusApp())

app.whenReady().then(async () => {
  settings = new SettingsStore()
  nativeTheme.themeSource = themeSource(settings.get().theme)
  projects = new ProjectStore({ root: rootDir, trash })
  store = new SessionStore({ projects, trash })
  const library = initLibrary()
  capture = new RendererCapture({ preload: path.join(root, 'preload/capture.cjs'), page: path.join(root, 'renderer/capture/index.html') })
  chatgptAuth = new ChatGPTAuth({ file: path.join(app.getPath('userData'), 'chatgpt-auth.json'), safeStorage })
  assistant = new Assistant({ complete: llm, captureScreen, screenReady: () => screenPermission() === 'granted' })
  vpStore = new VoiceprintStore(path.join(app.getPath('userData'), 'voiceprint.json'))
  engine = new MeetingEngine({
    settings,
    store,
    rendererCapture: capture,
    llm,
    llmStatus: () => aiStatus(),
    assistant,
    voiceprint: { profile: vpProfile, loadModel: () => loadVoiceprintModel() },
  })
  summarizer = new Summarizer({ store, projects, llm, aiStatus: () => aiStatus(), modelName: (m) => resolveModel(settings.get(), m), loadImage: slideDataUrl, renderPdf })

  if (useFakes) engine.useFakeSources(fakeFiles)

  if (selfTest && !uiSelfTest) {
    const code = await runSelfTest(selfTest, { engine, settings, store, projects, summarizer, library, capture, assistant, vpStore, root, captureSlide })
    exitNow(code)
    return
  }

  if (isMac) app.dock?.setIcon(path.join(root, 'assets/icon.png'))
  buildAppMenu()
  wireIpc()
  wireEngine()
  createOverlay()
  createAnswer()
  createTray()
  registerHotkeys()
  // 第一次启动：先出引导（只自动出一次，没走完关掉的以后从设置里再打开），完成后再开主窗口
  const ob = settings.get().onboarding
  if (!ob.done && !ob.shownAt && !uiSelfTest) {
    settings.update({ onboarding: { shownAt: Date.now() } })
    openOnboarding()
  } else createControl()
  lastOnboarding = JSON.stringify(onboardingStatus())
  setInterval(pollPointer, 50)
  // 用本地识别时，启动后在后台进程里先把模型加载好，开会时不用再等
  if (settings.get().engine === 'local') setTimeout(() => prewarmLocalAsr(), 3000)
  if (uiSelfTest) {
    // 否则截图里看不到字幕窗和答题框
    overlayWin.setContentProtection(false)
    answerWin.setContentProtection(false)
    overlayWin.webContents.once('did-finish-load', () => setEditMode(true))
    // MEETCAPTION_UI_SHOTS=<文件夹>：另外打开设置和引导窗口，退出前把每个窗口的页面各存一张 PNG（CI 的虚拟屏幕太小，整屏截图看不全）
    const shots = process.env.MEETCAPTION_UI_SHOTS
    if (shots) {
      setTimeout(() => (openSettings('overlay'), openOnboarding(), controlWin?.focus()), 1500)
      setTimeout(() => saveUiShots(shots).finally(() => exitNow(0)), Math.max(4000, uiSelfTest * 1000 - 1500))
    } else setTimeout(() => exitNow(0), uiSelfTest * 1000)
  }
  screen.on('display-removed', () => {
    const b = overlayWin.getBounds()
    if (!visibleOnSomeDisplay(b)) resetOverlayBounds()
    if (answerWin && !answerWin.isDestroyed() && !visibleOnSomeDisplay(answerWin.getBounds())) {
      const nb = resetAnswerBounds(answerWin)
      if (nb) settings.update({ overlay: { answerBounds: nb } })
    }
  })
})

app.on('activate', () => focusApp())

app.on('before-quit', async (e) => {
  if (quitting) return
  chatgptAuth?.cancelLogin()
  const busy = engine && engine.state !== 'idle'
  if (busy || engine?.notesFlush) {
    e.preventDefault()
    quitting = true
    if (busy) await engine.stop().catch(() => {})
    // 课堂：下课后最后一段实时笔记还在整理（20 到 40 秒），最多等 45 秒再退，不然这段笔记就丢了
    if (engine.notesFlush) {
      tray?.setToolTip('会议字幕：正在整理最后一段笔记，整理完就退出')
      toUi('engine:notice', { level: 'info', text: '正在整理最后一段实时笔记，整理完就退出（最多 45 秒）。', code: 'quit-notes' })
      await Promise.race([engine.notesFlush, new Promise((r) => setTimeout(r, 45_000))])
    }
    app.quit()
    return
  }
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopLocalAsr()
})

app.on('window-all-closed', () => {})
