const { contextBridge, ipcRenderer, webUtils } = require('electron')

// 主窗口、设置窗口、引导窗口共用这一套 window.app。
// 主进程抛的错会带上「Error invoking remote method ...」前缀，这里去掉，界面拿到的 message 就是中文原因。
const invoke = (ch) => async (...args) => {
  try {
    return await ipcRenderer.invoke(ch, ...args)
  } catch (e) {
    throw new Error(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, ''))
  }
}

const EVENTS = new Set([
  'engine:state',
  'engine:segment',
  'engine:level',
  'engine:notice',
  'engine:pause', // { paused, sessionId }：暂停 / 继续了（state 还是 running）
  'engine:devices', // { mic: { label, fallback } }：正在用的麦克风（换了设备、断线重连后）
  'overlay:state',
  'hotkey:status',
  'summary:progress',
  'chatgpt:status',
  'voiceprint:progress',
  'assist:answer',
  // v3
  'projects:changed', // { projects, currentProjectId }
  'sessions:changed', // { sessionId?, projectId?, from?, previousId?, removed? }，收到就重新取列表
  'todos:changed', // { sessionId?, itemId? }
  'settings:changed', // 完整设置（任何窗口改了设置都会发）
  'theme:changed', // { source: 'system'|'dark'|'light', dark }
  'onboarding:changed', // { done, voiceprint, ai, asr, project }
  'settings:section', // 设置窗口已开着时又要求打开某个分区
  'audio:level', // 声音测试、试听时的音量 { source, db }
  'listen:text', // 引导试听时本地识别出的字 { key, text, final } | { error }
  'update:state', // 自动更新 { phase: off|idle|checking|downloading|ready|latest|error, version, percent, error, checkedAt }
  'onboarding:helper', // 系统设置旁的拖图标面板 { kind: 'sys'|'scr'|'mic', dragged | closed }
  // v4 课堂
  'notes:update', // 实时笔记 { sessionId, notes: { sections, emphasis, homework, terms }, updatedAt, error }，error 非空时 notes 是上一版
  'materials:progress', // 读课件的进度 { sessionId, name, page, total }，读完一批发 { sessionId, done: true }
  // 会员
  'member:update', // { info: { kind, code, balance, devices, trialOnly, recent }, session, buying, error }
  'member:paid', // 付完款、场次加上了：{ kind, code, balance, ... }
  'member:showPricing', // 别的窗口（设置）要求主窗口打开收费页
  'guide:show', // 主窗口导览（引导最后点「带我看一遍主窗口」，或设置里点「看主窗口导览」）
  'slides:added', // 截取了一张画面 { sessionId, file: 'slides/时.分.秒.jpg', at（截图时刻，毫秒时间戳，同 seg.startedAt）, url（file:// 地址）}
])

// 界面语言的表：页面脚本加载前就要有（shared/i18n.js 用它定义 t）
contextBridge.exposeInMainWorld('I18N', ipcRenderer.sendSync('i18n:get'))

contextBridge.exposeInMainWorld('app', {
  init: invoke('app:init'),
  updateSettings: invoke('settings:update'),
  start: invoke('engine:start'), // start({ projectId, mode: 'meeting'|'interview'|'class', classSource: 'mic'|'system' })，都可以不给
  captureSlide: invoke('class:captureSlide'), // → { file, at, url } | { error, code }
  exportNotes: invoke('notes:export'),
  openNotesHtml: invoke('notes:openHtml'), // (sessionId) → { ok, htmlError } 用浏览器打开图文版课堂笔记，没有就先做
  buildNotesHtml: invoke('notes:buildHtml'), // (sessionId) → { ok, html, htmlError } 重做图文版课堂笔记
  exportNotesPdf: invoke('notes:exportPdf'), // (sessionId) → { ok, file, htmlError } | null（取消）图文笔记导出成 PDF，存好打开
  addMaterials: invoke('materials:add'), // addMaterials(sessionId, 路径[]?) → { materials, errors } | null（取消）；不给路径弹选文件框
  removeMaterial: invoke('materials:remove'), // removeMaterial(sessionId, materialId) → materials
  pathForFile: (file) => webUtils.getPathForFile(file), // 拖进来的文件 → 本地路径 // exportNotes(sessionId) → { dir, files } | null（取消）| { error }
  stop: invoke('engine:stop'),
  pause: invoke('engine:pause'),
  resume: invoke('engine:resume'),
  setMic: invoke('engine:setMic'), // setMic(deviceId)：存进设置，会上马上换（'' 是系统默认）
  toggleOverlay: invoke('overlay:toggle'),
  editOverlay: invoke('overlay:edit'),
  resetOverlayPosition: invoke('overlay:resetPosition'),

  // 项目
  listProjects: invoke('projects:list'),
  getProject: invoke('projects:get'),
  createProject: invoke('projects:create'),
  updateProject: invoke('projects:update'),
  deleteProject: invoke('projects:delete'),
  setCurrentProject: invoke('projects:setCurrent'),
  openProjectFolder: invoke('projects:openFolder'),

  // 会议
  listSessions: invoke('sessions:list'), // listSessions({ projectId })
  loadSession: invoke('sessions:load'),
  renameSession: invoke('sessions:rename'),
  moveSession: invoke('sessions:move'),
  removeSession: invoke('sessions:remove'),
  openFolder: invoke('sessions:openFolder'),
  pickDir: invoke('sessions:pickDir'),

  // 纪要、待办、搜索
  generateSummary: invoke('summary:generate'),
  cancelSummary: invoke('summary:cancel'),
  extractTodos: invoke('todos:extract'),
  listTodos: invoke('todos:list'), // listTodos({ projectId, includeDone })
  updateTodo: invoke('todos:update'), // updateTodo(sessionId, itemId, patch)
  removeTodo: invoke('todos:remove'), // removeTodo(sessionId, itemId)
  search: invoke('search:query'),

  // 窗口和引导
  openSettings: invoke('window:openSettings'),
  openOnboarding: invoke('window:openOnboarding'),
  finishOnboarding: invoke('onboarding:finish'), // finishOnboarding({ tour })：tour 为真时进主窗口后导览四处
  showDragHelper: invoke('onboarding:helper'), // ('sys' | 'scr' | 'mic')：打开系统设置，旁边浮出能拖的兔子图标；不给参数就收起
  updateStatus: invoke('update:status'),
  checkUpdate: invoke('update:check'), // → { ok, state } | { ok: false, error, state }
  installUpdate: invoke('update:install'), // 已下载好的新版：退出、装上、重新打开；正在记录时 → { ok: false, error }
  listenStart: invoke('listen:start'), // 引导试听：电脑声音和麦克风一起开，电脑声音走本地识别
  listenStop: invoke('listen:stop'),
  saveOnboardingStep: invoke('onboarding:step'), // 引导走到哪一步（被系统授权重启打断后从这里接着来）
  onboardingStatus: invoke('onboarding:status'),
  showMain: invoke('window:showMain'),

  testAsr: invoke('test:asr'),
  testLlm: invoke('test:llm'),
  listModels: invoke('llm:models'), // → { ok, models, label } | { ok: false, error }
  testAudio: invoke('test:audio'), // testAudio({ seconds, mic })
  llmStatus: invoke('llm:status'),
  requestPermission: invoke('permission:request'), // 'microphone' | 'screen' | 'systemAudio'
  permissionStatus: invoke('permission:status'), // → { microphone, screen }
  openPrivacy: invoke('shell:openPrivacy'), // openPrivacy('microphone' | 'screen')
  relaunch: invoke('app:relaunch'), // 重启应用（屏幕录制权限给了要重启才生效）；正在记录时 → { ok: false, error }
  openExternal: invoke('shell:openExternal'),
  screenPermission: invoke('screen:permission'),
  chatgptStatus: invoke('chatgpt:status'),
  chatgptLogin: invoke('chatgpt:login'),
  chatgptLogout: invoke('chatgpt:logout'),
  chatgptCancelLogin: invoke('chatgpt:cancelLogin'),
  voiceprintStatus: invoke('voiceprint:status'),
  voiceprintEnroll: invoke('voiceprint:enroll'),
  voiceprintClear: invoke('voiceprint:clear'),
  askLast: invoke('assist:askLast'),
  askSegment: invoke('assist:askSegment'), // askSegment(segId)：回答主窗口点的那句提问
  answerRegenerate: invoke('assist:regenerate'),

  // 会员：都回 { ok, info, session, buying, error } | { ok: false, error, code }
  memberRefresh: invoke('member:refresh'),
  memberActivate: invoke('member:activate'), // (授权码)
  memberUnbind: invoke('member:unbind'),
  memberBuy: invoke('member:buy'), // (pack: 'p1'|'p10'|'p30'|'p100', currency: 'cny'|'usd')：浏览器里结账，付完自动加上
  memberCancelBuy: invoke('member:cancelBuy'),
  showPricing: invoke('member:showPricing'), // 把主窗口叫出来、打开收费页
  openGuide: invoke('guide:open'), // 把主窗口叫出来、导览四处
  dragApp: () => ipcRenderer.send('app:dragApp'), // 在 dragstart 里调：拖的是应用本身，放进系统设置的权限列表


  /** 订阅事件，返回取消订阅的函数。 */
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error(`unknown channel ${channel}`)
    const listener = (_e, payload) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})
