'use strict'
// 主窗口的共用部分：状态、主进程事件、小工具、提示条、路由。
// 各视图在 view-*.js 里注册到 VIEWS，侧栏在 sidebar.js，命令面板在 palette.js，启动在 app.js。
// 普通 <script>，顶层声明在几个文件之间共用。

const api = window.app
const { el, icon, kbd } = ui

const INBOX = 'inbox'

const state = {
  platform: '',
  version: '',
  settings: null,
  projects: [],
  currentProjectId: INBOX,
  onboarding: {},
  llm: null, // { provider, ready, label, reason }
  chatgpt: null,
  hotkey: { accel: '', error: null, ask: { accel: '', error: null } },
  overlay: { visible: true, editMode: false },
  engine: { state: 'idle' }, // 还带 paused：暂停中（state 仍是 running）
  devices: {}, // 正在用的设备 { mic: { label, fallback } }
  // 这次打开应用以来最近一场会：{ sessionId, projectId, startedAt, endedAt, segs: Map, answers: Map, ended, dismissed }
  live: null,
  summaries: new Map(), // 会议 id → { phase, text }：正在生成的纪要
  starting: false,
  // v4
  modeChoice: null, // 开始按钮下拉里临时换的模式 { projectId, mode, classSource }，换项目就作废
  projectModes: new Map(), // 项目 id → { mode, classSource }：列表里没带时用 getProject 补
  pendingStart: null, // 刚请求开始时选的模式，engine:state 没带 mode 时用它
}

/* ---------------- 事件 ---------------- */

const listeners = new Map()

function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set())
  listeners.get(name).add(fn)
  return () => listeners.get(name)?.delete(fn)
}

function emit(name, payload) {
  for (const fn of [...(listeners.get(name) ?? [])]) {
    try {
      fn(payload)
    } catch (e) {
      console.error(`[${name}]`, e)
    }
  }
}

/** 调主进程：方法不存在或出错时返回 { ok: false, error }，不抛。 */
async function call(name, ...args) {
  if (typeof api?.[name] !== 'function') return { ok: false, missing: true, error: '这个功能在当前版本里还没接好' }
  try {
    return await api[name](...args)
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

const failed = (r) => r == null || (typeof r === 'object' && !Array.isArray(r) && r.ok === false)

function subscribe(channel, cb) {
  try {
    return api.on(channel, cb)
  } catch {
    return () => {}
  }
}

/* ---------------- 时间和日期 ---------------- */

const pad = (n) => String(n).padStart(2, '0')
const DAY = 86_400_000
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function startOfDay(t = Date.now()) {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

const daysFromToday = (t) => Math.round((startOfDay(t) - startOfDay()) / DAY)

function fmtTime(ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fmtClock(ms) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 会议里的位置：mm:ss，超过一小时 h:mm:ss。 */
function fmtOffset(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

function fmtMonthDay(ms) {
  const d = new Date(ms)
  const y = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年` : ''
  return `${y}${d.getMonth() + 1}月${d.getDate()}日`
}

/** 今天、昨天、周二（一周内）、9月15日。 */
function fmtDay(ms) {
  const n = daysFromToday(ms)
  if (n === 0) return '今天'
  if (n === -1) return '昨天'
  if (n < 0 && n > -7) return WEEK[new Date(ms).getDay()]
  return fmtMonthDay(ms)
}

const fmtDateTime = (ms) => `${fmtMonthDay(ms)} ${fmtTime(ms)}`
const fmtWhen = (ms) => `${fmtDay(ms)} ${fmtTime(ms)}`

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return ''
  const m = Math.round(ms / 60000)
  if (m < 1) return '不到 1 分钟'
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} 小时 ${m % 60} 分钟` : `${h} 小时`
}

const sec = (ms) => `${(ms / 1000).toFixed(1)} 秒`

function parseDue(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due ?? ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null
}

/** 截止日期的显示：{ label, tint, days }；没有截止返回 null。 */
function dueInfo(due, done = false) {
  const t = parseDue(due)
  if (t == null) return null
  const days = daysFromToday(t)
  let label
  let tint = null
  if (days < 0) {
    label = days === -1 ? '昨天到期' : `逾期 ${-days} 天`
    tint = 'red'
  } else if (days === 0) {
    label = '今天到期'
    tint = 'red'
  } else if (days === 1) {
    label = '明天'
    tint = 'orange'
  } else if (days < 7) {
    // 过了这周日就是「下周几」
    const toSunday = (7 - new Date().getDay()) % 7
    label = `${days > toSunday ? '下' : ''}${WEEK[new Date(t).getDay()]}`
    tint = 'yellow'
  } else label = fmtMonthDay(t)
  return { label, tint: done ? null : tint, days, title: fmtMonthDay(t) }
}

/** 待办页的分组：已逾期、今天、本周（到周日）、以后、没有截止。 */
function dueBucket(due) {
  const t = parseDue(due)
  if (t == null) return 'none'
  const today = startOfDay()
  if (t < today) return 'overdue'
  if (t === today) return 'today'
  const endOfWeek = today + ((7 - new Date(today).getDay()) % 7) * DAY
  return t <= endOfWeek ? 'week' : 'later'
}

const DUE_GROUPS = [
  ['overdue', '已逾期'],
  ['today', '今天'],
  ['week', '本周'],
  ['later', '以后'],
  ['none', '没有截止'],
]

/* ---------------- 项目、会议 ---------------- */

const projectOf = (id) => state.projects.find((p) => p.id === id) ?? null
const projectName = (id) => projectOf(id)?.name ?? '未归类'
const activeProjects = () => state.projects.filter((p) => !p.archived)
const projectIconName = (p) => (p?.icon && ui.hasIcon(p.icon) ? p.icon : p?.id === INBOX ? 'inbox' : 'folder')
const projectTint = (p) => (p?.color && ui.tints.includes(p.color) ? p.color : 'gray')

function projectBox(p, size) {
  return ui.iconBox(projectIconName(p), projectTint(p), size ? { size } : {})
}

function projectTag(id, props = {}) {
  const p = projectOf(id)
  return el('span.tag.tag-dot', { ...props, dataset: { tint: projectTint(p) }, text: p?.name ?? '未归类' })
}

const sessionTitle = (s) => s?.title || `${fmtDateTime(s?.startedAt ?? Date.now())} 的${MODES[s?.mode]?.label ?? '会议'}`

/* ---------------- 模式：会议、面试、课堂 ---------------- */

const MODES = {
  meeting: { label: '会议', icon: 'users', tint: 'blue', verb: '开始会议', live: '会议进行中', ended: '会议已结束', desc: '字幕和翻译，对方提问时 AI 答题' },
  interview: { label: '面试', icon: 'briefcase', tint: 'orange', verb: '开始面试', live: '面试进行中', ended: '面试已结束', desc: '对方问完自动回答，答题框更显眼' },
  class: { label: '课堂', icon: 'graduation-cap', tint: 'purple', verb: '开始上课', live: '正在上课', ended: '课堂已结束', desc: 'AI 边听边记笔记，下课出课堂笔记' },
}
const CLASS_SOURCES = {
  mic: { label: '教室现场', hint: '麦克风', icon: 'mic', desc: '老师在前面讲，用麦克风听' },
  system: { label: '网课', hint: '电脑声音', icon: 'monitor', desc: '听电脑里播放的网课' },
}
const modeOf = (m) => (MODES[m] ? m : 'meeting')
const sourceOf = (v) => (CLASS_SOURCES[v] ? v : 'mic')
const modeInfo = (m) => MODES[modeOf(m)]

/** 项目的默认模式：project.mode；列表里没带就看 getProject 补回来的。 */
function projectMode(id) {
  const p = projectOf(id)
  return modeOf(p?.mode ?? state.projectModes.get(id)?.mode)
}

/** 课堂的声音来源：项目上记的，没有就用设置里的默认（class.source）。 */
function projectClassSource(id) {
  const p = projectOf(id)
  return sourceOf(p?.classSource || state.projectModes.get(id)?.classSource || state.settings?.class?.source) // 项目上是空串就用设置的默认
}

/** 列表里的项目没带 mode 时，取一次完整项目补上（只取一次）。 */
async function ensureProjectMode(id) {
  const p = projectOf(id)
  if (!p || p.mode !== undefined || state.projectModes.has(id)) return
  state.projectModes.set(id, {})
  const full = await call('getProject', id)
  if (failed(full) || !full) return
  state.projectModes.set(id, { mode: full.mode, classSource: full.classSource })
  if (full.mode !== undefined || full.classSource !== undefined) emit('projects', state.projects)
}

/** 开始时用的模式：开始按钮下拉里临时换过就用换的，否则用项目默认。 */
function startChoice(pid = state.currentProjectId) {
  const c = state.modeChoice
  if (c && c.projectId === pid) return c
  return { projectId: pid, mode: projectMode(pid), classSource: projectClassSource(pid) }
}

function startLabel(choice) {
  const m = modeInfo(choice.mode)
  if (choice.mode === 'class') return `${m.verb}（${CLASS_SOURCES[sourceOf(choice.classSource)].label}）`
  return m.verb
}

const liveMode = () => modeOf(state.live?.mode)
const whoLabel = (who, mode) => (who === 'me' ? '我' : mode === 'class' ? '老师' : '对方')

/* ---------------- 主窗口快捷键（设置里能改，空字符串表示不用） ---------------- */

const appKey = (name) => state.settings?.keys?.[name] || ''
const keyHint = (name) => (appKey(name) ? kbd(appKey(name), { size: 'sm' }) : null)

const running = () => state.engine.state === 'running'
const busyEngine = () => state.engine.state === 'starting' || state.engine.state === 'stopping'

/* ---------------- 小工具 ---------------- */

/** 清空再放进子节点；null、false 跳过（DOM 的 append 会把 null 变成文字「null」）。 */
function fill(node, ...kids) {
  ui.clear(node)
  node.append(...kids.flat().filter((k) => k != null && k !== false))
  return node
}

async function copyText(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text)
    ui.toast({ title: label, type: 'success' })
  } catch {
    ui.toast({ title: '没能复制，请手动选中文字复制', type: 'error' })
  }
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key)
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {}
  return null
}

function debounce(fn, ms) {
  let t
  const d = (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
  d.flush = (...a) => {
    clearTimeout(t)
    fn(...a)
  }
  d.cancel = () => clearTimeout(t)
  return d
}

/** 列表键盘导航：聚焦列表时没选中就选第一项。 */
function navList(list, opts = {}) {
  const nav = ui.listNav(list, { initial: -1, selectOnHover: false, ...opts })
  list.addEventListener('focus', () => {
    if (!nav.selected() || !nav.selected().isConnected) nav.select(0, { silent: true })
  })
  return nav
}

function sectionTitle(text, ...extra) {
  return el('div.section-title', {}, el('span', { text }), ...extra)
}

function iconButton(name, label, onClick, props = {}) {
  const b = el('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': label, onClick, ...props }, icon(name, 16))
  ui.tip(b, label, { delay: 400, placement: 'bottom' })
  return b
}

/* ---------------- 纪要（marked 渲染） ---------------- */

if (window.marked) window.marked.use({ renderer: { html: () => '' }, gfm: true, breaks: false })

function renderMarkdown(node, md) {
  // marked 的结果只含 Markdown 生成的标签（原始 HTML 已去掉），页面 CSP 也不许脚本。
  // 公式（$$…$$、$…$、\[…\]、\(…\)）先换成占位符，marked 渲染完再用 KaTeX 画回去，免得 marked 把 _ 和 * 当成强调
  const { text, math } = extractMath(md || '')
  node.innerHTML = window.marked ? window.marked.parse(text) : ''
  if (!window.marked) node.textContent = md || ''
  else fillMath(node, math)
}

/* ---------------- 公式（KaTeX） ---------------- */

const MATH_OPEN = '\uE000'
const MATH_CLOSE = '\uE001'
const MATH_RE = /\uE000(\d+)\uE001/g

// 行内公式：$ 后面不是空格、$ 前面不是空格、后面不跟数字（$5 和 $6 这种钱数不算）
const TEX_PATTERNS = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g, display: false },
]

/** Markdown 里的公式换成占位符（代码块和行内代码里的不动）。→ { text, math: [{ tex, display }] } */
function extractMath(md) {
  const math = []
  const parts = String(md).split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part // 代码
    let t = part
    for (const { re, display } of TEX_PATTERNS) {
      t = t.replace(re, (all, tex) => {
        if (!tex.trim()) return all
        math.push({ tex: tex.trim(), display })
        const ph = `${MATH_OPEN}${math.length - 1}${MATH_CLOSE}`
        return display ? `\n\n${ph}\n\n` : ph
      })
    }
    return t
  })
  return { text: out.join(''), math }
}

/** 画一个公式；KaTeX 没加载或公式写错了就退回等宽的原文。 */
function renderTex(node, tex, display = false) {
  if (window.katex) {
    try {
      window.katex.render(tex, node, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' })
      node.classList.add('math', display ? 'math-display' : 'math-inline')
      node.title = tex
      return true
    } catch {}
  }
  node.textContent = display ? tex : `$${tex}$`
  node.classList.add('math-raw')
  return false
}

// marked 渲染完：文本里的占位符换成 KaTeX 画的公式；整段只有一个公式的，整段换成居中的块
function fillMath(root, math) {
  if (!math.length) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const hits = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes(MATH_OPEN)) hits.push(n)
  for (const textNode of hits) {
    const frag = document.createDocumentFragment()
    let last = 0
    const value = textNode.nodeValue
    for (const m of value.matchAll(MATH_RE)) {
      if (m.index > last) frag.append(value.slice(last, m.index))
      const item = math[Number(m[1])]
      const box = document.createElement(item?.display ? 'div' : 'span')
      if (item) renderTex(box, item.tex, item.display)
      frag.append(box)
      last = m.index + m[0].length
    }
    if (last < value.length) frag.append(value.slice(last))
    const parent = textNode.parentNode
    parent.replaceChild(frag, textNode)
    // <p> 里只剩一个块公式：去掉这层 <p>（div 不能放在 p 里）
    if (parent.tagName === 'P' && parent.childNodes.length === 1 && parent.firstChild.classList?.contains('math-display')) parent.replaceWith(parent.firstChild)
  }
}

/** 实时笔记里的一条公式：模型给的是 LaTeX，可能还带着 $ 或 \[ \]。 */
function renderFormula(node, tex) {
  const t = String(tex ?? '')
    .trim()
    .replace(/^\$\$([\s\S]*)\$\$$/, '$1')
    .replace(/^\\\[([\s\S]*)\\\]$/, '$1')
    .replace(/^\$([\s\S]*)\$$/, '$1')
    .trim()
  node.replaceChildren()
  node.classList.remove('math', 'math-display', 'math-inline', 'math-raw')
  renderTex(node, t, true)
}

// 纪要里的链接用系统浏览器打开，不在窗口里跳走
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]')
  if (!a || !a.closest('.prose')) return
  e.preventDefault()
  if (/^https:/.test(a.href)) call('openExternal', a.href)
})

/* ---------------- 术语和意群颜色 ---------------- */

// 设置里的「意群颜色对照」：display.chunkColors、display.chunkStyle（bilingual.prefs 给默认值）
const chunkPrefs = () => window.bilingual.prefs(state.settings)

// 术语悬停出解释，AI 纠正过的词悬停出识别原文；中英两边的同一个术语一起高亮
function wireTerms(root) {
  const stopTip = ui.tipDelegate(root, window.bilingual.TIP_SELECTOR, (t) => window.bilingual.tipContent(t), { placement: 'top' })
  const stopLink = window.bilingual.linkHover(root)
  return () => (stopTip(), stopLink())
}

// 键盘聚焦到术语或纠正过的词上也显示
document.addEventListener('focusin', (e) => {
  if (e.target.matches?.(window.bilingual.TIP_SELECTOR)) {
    const t = e.target
    ui.hideTip()
    const stop = ui.tip(t, window.bilingual.tipContent(t), { delay: 0 })
    t.dispatchEvent(new Event('focus'))
    t.addEventListener('blur', () => stop(), { once: true })
  }
})

/* ---------------- 提示条 ---------------- */

const notices = [] // { id, level, text, code, actions, title }
let noticeSeq = 0
const NOTICE_ICON = { error: 'circle-alert', warn: 'triangle-alert', info: 'info' }

function addNotice(level, text, { code = null, actions = [], title = '', timeout = 0 } = {}) {
  if (code) removeNotice(code, false)
  const n = { id: ++noticeSeq, level, text, code, actions, title }
  notices.push(n)
  while (notices.length > 4) notices.shift()
  renderNotices()
  if (timeout) setTimeout(() => dismissNotice(n.id), timeout)
  return n
}

function removeNotice(code, render = true) {
  const i = notices.findIndex((n) => n.code === code)
  if (i >= 0) notices.splice(i, 1)
  if (render) renderNotices()
}

function dismissNotice(id) {
  const i = notices.findIndex((n) => n.id === id)
  if (i >= 0) {
    notices.splice(i, 1)
    renderNotices()
  }
}

function clearNotices() {
  notices.length = 0
  renderNotices()
}

// 只在记录进行中才有意义的提示（没听到声音、识别在重连）：记录结束就收掉，不带到结束页和纪要页；出错原因这类留着
const LIVE_NOTICES = new Set(['no-audio', 'mac-no-audio', 'no-audio-f2f', 'no-mic-audio', 'mac-permission', 'reconnecting', 'reconnected'])

function clearLiveNotices() {
  const before = notices.length
  for (let i = notices.length - 1; i >= 0; i--) if (LIVE_NOTICES.has(notices[i].code)) notices.splice(i, 1)
  if (notices.length !== before) renderNotices()
}

function renderNotices() {
  const box = document.getElementById('notices')
  if (!box) return
  ui.clear(box)
  box.hidden = !notices.length
  for (const n of notices) {
    const cls = n.level === 'error' ? 'callout-error' : n.level === 'warn' ? 'callout-warn' : 'callout-accent'
    box.append(
      el(
        'div.callout.notice',
        { class: cls, role: n.level === 'error' ? 'alert' : 'status' },
        icon(NOTICE_ICON[n.level] ?? 'info', 16),
        el('div.callout-body', {}, n.title ? el('div.callout-title', { text: n.title }) : null, el('div.callout-desc.selectable', { text: n.text })),
        ...n.actions.map((a) => el('button.btn.btn-sm', { type: 'button', onClick: () => a.run() }, a.label)),
        el('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': '关闭', onClick: () => dismissNotice(n.id) }, icon('x', 14)),
      ),
    )
  }
}

let askQuietUntil = 0 // 界面自己调 askLast 时，主进程发的同一句提示不再弹一次

function onEngineNotice(n) {
  if (n.level === 'clear') return removeNotice(n.code)
  if (n.code === 'assist-ask' && Date.now() < askQuietUntil) return
  const privacy = { label: '打开系统设置', run: () => call('openPrivacy', 'screen') }
  switch (n.code) {
    case 'reconnected':
      removeNotice('reconnecting', false)
      return addNotice('info', n.text, { code: n.code, timeout: 4000 })
    // 音频断了又连上、换了麦克风：说一声就自己收起
    case 'capture-device':
    case 'capture-restored':
      return addNotice('info', n.text, { code: n.code, timeout: 5000 })
    case 'mac-no-audio':
      return addNotice('warn', `${n.text}如果对方明明在说话却没有字幕：打开「系统设置 → 隐私与安全性 → 录屏与系统录音」，在「仅系统录音」里打开「会议字幕」，然后重新开始。`, { code: n.code, actions: [privacy] })
    case 'no-audio':
      return addNotice('warn', `${n.text}检查一下会议声音是不是从这台电脑的默认扬声器或耳机里放出来的。`, { code: n.code, actions: [{ label: '声音设置', run: () => call('openPrivacy', 'screen') }] })
    case 'screen-permission':
      return addNotice('warn', n.text, { code: n.code, actions: [privacy, { label: '重启', run: relaunchApp }] })
    case 'mic-permission':
      return addNotice('warn', n.text, { code: n.code, actions: [{ label: '打开系统设置', run: () => call('openPrivacy', 'microphone') }] })
    case 'assist-llm':
      return addNotice('warn', n.text, { code: n.code, actions: [{ label: '去设置', run: () => openSettings('ai') }] })
    case 'asr-language':
      return addNotice('warn', n.text, { code: n.code, actions: [{ label: '去换识别服务', run: () => openSettings('asr') }] })
    case 'voiceprint':
      return addNotice('warn', n.text, { code: n.code, actions: [{ label: '声纹设置', run: () => openSettings('voiceprint') }] })
    case 'save-dir':
      return addNotice(n.level, n.text, { code: n.code, actions: [{ label: '去设置', run: () => openSettings('general') }] })
    default:
      return addNotice(n.level === 'error' ? 'error' : n.level === 'info' ? 'info' : 'warn', n.text, { code: n.code })
  }
}

/* ---------------- 常用操作 ---------------- */

async function relaunchApp() {
  const r = await call('relaunch')
  if (failed(r)) ui.toast({ title: '没有重启', message: r?.error, type: 'error' })
}

function openSettings(section) {
  return call('openSettings', section)
}

/** 开始记录。choice 不给就用这个项目的默认模式（开始按钮下拉里换过就用换的）。 */
async function startMeeting(projectId, choice) {
  if (running()) return go('live')
  if (state.engine.state !== 'idle' || state.starting) return
  const pid = projectId && projectOf(projectId) ? projectId : state.currentProjectId
  const c = choice ?? startChoice(pid)
  const mode = modeOf(c.mode)
  const classSource = mode === 'class' ? sourceOf(c.classSource) : undefined
  removeNotice('start-error')
  state.starting = true
  state.pendingStart = { mode, classSource }
  emit('engine', state.engine)
  const r = await call('start', { projectId: pid, mode, classSource })
  state.starting = false
  emit('engine', state.engine)
  // 「正在连接」时自己点了停止的不算失败
  if (failed(r) && !r?.cancelled) addNotice('error', `没能开始：${r?.error ?? '未知错误'}`, { code: 'start-error', actions: startErrorActions(r?.error) })
}

function startErrorActions(error = '') {
  if (/key|token|app ?id|密钥|识别/i.test(error)) return [{ label: '语音识别设置', run: () => openSettings('asr') }]
  return []
}

/** 课堂里截取当前屏幕（网课课件）。→ { file, at } | { error } */
async function captureSlide() {
  const r = await call('captureSlide')
  if (failed(r) || r?.error) {
    ui.toast({ title: '没能截取画面', message: r?.error, type: 'error' })
    return null
  }
  ui.toast({ title: '已截取画面', message: '存进这节课的文件夹，课堂笔记会用上', type: 'success' })
  return r
}

async function stopMeeting() {
  if (state.engine.state !== 'running' && state.engine.state !== 'starting') return
  await call('stop')
}

/** 暂停 / 继续记录（同一场会议）。 */
async function togglePause() {
  if (!running()) return
  const r = await call(state.engine.paused ? 'resume' : 'pause')
  if (failed(r)) ui.toast({ title: state.engine.paused ? '没能继续记录' : '没能暂停', message: r?.error, type: 'error' })
}

/** 会上换麦克风：列出电脑上的麦克风，选了马上换（同时存进设置）。 */
async function pickMic(anchor) {
  let devices = []
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  } catch {}
  const cur = state.settings?.micDeviceId || ''
  const using = state.devices?.mic?.label
  ui.menu(
    anchor,
    [
      { section: '麦克风' },
      { label: '系统默认', description: !cur && using ? `现在是 ${using}` : '戴上 / 摘下耳机时自动跟着换', checked: !cur, onSelect: () => call('setMic', '') },
      ...devices.map((d, i) => ({ label: d.label || `麦克风 ${i + 1}`, checked: d.deviceId === cur, onSelect: () => call('setMic', d.deviceId) })),
    ],
    { align: 'start', minWidth: 260 },
  )
}

/** 让 AI 回答刚才的问题。→ 主进程的结果 { ok, question | error } */
async function askAI() {
  askQuietUntil = Date.now() + 2000
  const r = await call('askLast')
  if (failed(r)) removeNotice('assist-ask')
  emit('ask', r)
  return r
}

async function setCurrentProject(id) {
  if (!id || id === state.currentProjectId) return
  const p = projectOf(id)
  if (!p || p.archived) return
  state.currentProjectId = id
  ensureProjectMode(id)
  emit('projects', state.projects)
  const r = await call('setCurrentProject', id)
  if (failed(r)) ui.toast({ title: '没能切换项目', message: r?.error, type: 'error' })
}

/* ---------------- 路由 ---------------- */

const VIEWS = {}
const router = { current: null, stack: [], mounted: null, seq: 0 }

const sameView = (a, b) => a && b && a.name === b.name && (a.id ?? null) === (b.id ?? null)

// 顶层页面：从侧栏、⌘1 / ⌘2 进去的，没有「返回」（Raycast 的顶层视图也没有）
const TOP_LEVEL = new Set(['home', 'todos'])

/** opts.root：从侧栏这种顶层入口进来，清掉返回栈（标题栏不出返回箭头）。 */
function go(name, params = {}, opts = {}) {
  const next = { ...params, name }
  const cur = router.current
  if (opts.root) {
    router.stack.length = 0
    opts = { ...opts, push: false }
  }
  if (cur && sameView(cur, next) && !opts.force) {
    if (opts.root) document.querySelector('#header .header-back')?.remove()
    // 同一个视图：只换标签页之类的参数
    if (params.tab && router.mounted?.setTab) router.mounted.setTab(params.tab)
    router.mounted?.focus?.()
    return
  }
  if (cur && opts.push !== false) {
    router.stack.push(cur)
    if (router.stack.length > 40) router.stack.shift()
  }
  mount(next, opts)
}

function back() {
  let prev = router.stack.pop()
  // 退回的视图已经不在了（项目被删、会议被删）就再往前退
  while (prev && !viewExists(prev)) prev = router.stack.pop()
  if (prev) mount(prev, {})
  else if (router.current?.name !== 'home') mount({ name: 'home' }, {})
}

function viewExists(v) {
  if (v.name === 'project') return Boolean(projectOf(v.id))
  if (v.name === 'live') return Boolean(state.live)
  return true
}

function mount(view, opts = {}) {
  const prev = router.mounted
  if (prev) for (const fn of prev.disposers) fn()
  if (router.current?.name === 'live' && view.name !== 'live' && state.live?.ended) state.live.dismissed = true
  ui.hideTip()
  router.current = view
  const header = document.getElementById('header')
  const body = document.getElementById('view')
  ui.clear(header)
  ui.clear(body)
  body.dataset.view = view.name
  const disposers = []
  const seq = ++router.seq
  const ctx = {
    params: view,
    body,
    alive: () => router.seq === seq,
    header: (h) => renderHeader(header, h),
    on: (name, fn) => disposers.push(on(name, fn)),
    dispose: (fn) => disposers.push(fn),
    every: (fn, ms) => {
      const t = setInterval(fn, ms)
      disposers.push(() => clearInterval(t))
    },
    setParam: (k, v) => {
      if (router.seq === seq) view[k] = v
    },
  }
  const inst = VIEWS[view.name]?.mount(ctx) ?? {}
  router.mounted = { ...inst, disposers, ctx }
  emit('route', view)
  if (opts.focus !== false) requestAnimationFrame(() => router.seq === seq && inst.focus?.())
}

function renderHeader(header, { crumbs = [], actions = [] } = {}) {
  ui.clear(header)
  if (sidebarCollapsed()) header.append(sidebarToggle())
  if (router.stack.length && !TOP_LEVEL.has(router.current?.name)) {
    const b = el('button.btn.btn-ghost.btn-icon.btn-sm.header-back', { type: 'button', 'aria-label': '返回', onClick: back }, icon('chevron-left', 16))
    ui.tip(b, { title: '返回', text: `Esc 或 ${ui.accelText('CommandOrControl+[')}` }, { delay: 400, placement: 'bottom' })
    header.append(b)
  }
  const list = el('div.crumbs')
  crumbs.filter(Boolean).forEach((c, i) => {
    if (i) list.append(el('span.crumb-sep', {}, icon('chevron-right', 14)))
    list.append(typeof c === 'string' ? el('span.crumb.truncate', { text: c }) : c)
  })
  header.append(list, el('span.header-spacer'), el('div.header-actions', {}, ...actions.filter(Boolean)))
}

/* ---------------- 共用的行和卡片 ---------------- */

function segWho(seg) {
  return seg.who ?? (seg.source === 'mic' ? 'me' : 'other')
}

/**
 * 一段字幕：时间、我 / 对方（课堂是老师）、每句原文下面紧跟它的译文。
 * 意群同色、术语两边虚线由 shared/bilingual.js 画。base 给了会议开始时间就显示会议里的位置。
 */
function lineNode(seg, base, { mode = 'meeting' } = {}) {
  const who = segWho(seg)
  const time = base ? fmtOffset(seg.startedAt - base) : fmtTime(seg.startedAt)
  const pr = chunkPrefs()
  const sentences = seg.sentences?.length ? seg.sentences : [{ text: seg.text }]
  const pairs = sentences.map((sen, i) => {
    const r = window.bilingual.render({ ...sen, text: sen.text || seg.text }, { colors: pr.colors, focusable: true })
    const last = i === sentences.length - 1
    return el(
      'div.tline-pair',
      { dataset: { bi: '' } },
      el('div.tline-text.selectable', {}, r.en, last && seg.question ? el('span.tag.tag-question.tline-q', { text: '提问' }) : null),
      r.zh && sen.tr ? el('div.tline-tr.selectable', {}, r.zh) : null,
    )
  })
  return el(
    'div.tline',
    { class: [who === 'me' ? 'is-me' : 'is-other', seg.final === false ? 'is-live' : '', seg.question ? 'is-question' : '', pr.className], dataset: { id: seg.id, t: String(seg.startedAt ?? 0) } },
    el('span.tline-time.num', { text: time, title: fmtClock(seg.startedAt) }),
    el('span.tline-who', {}, el('span.tag', { class: who === 'me' ? 'tag-me' : 'tag-other', text: whoLabel(who, mode) })),
    el('div.tline-main', {}, pairs),
  )
}

/* ---------------- 课堂截图 ---------------- */

/** 本地路径 → file:// 地址（Windows 的盘符和反斜杠也认）。 */
function fileUrl(p) {
  let s = String(p).replace(/\\/g, '/')
  if (!s.startsWith('/')) s = `/${s}`
  return `file://${encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

const isAbsPath = (p) => /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(String(p))

/** 截图的地址：slide 带 url 或绝对路径就直接用；file 是相对会议文件夹的路径（slides/xxx.jpg）时要有 dir。 */
function slideSrc(slide, dir) {
  if (!slide) return ''
  if (slide.url) return String(slide.url)
  const f = String(slide.path || slide.file || '')
  if (!f) return ''
  if (/^(?:file|https|data):/i.test(f)) return f
  if (isAbsPath(f)) return fileUrl(f)
  return dir ? fileUrl(`${String(dir).replace(/[\\/]+$/, '')}/${f}`) : ''
}

/** 截图在会议里的时间（毫秒时间戳）：at 是时间戳或距开始的毫秒数都认。 */
function slideTime(slide, startedAt) {
  const at = Number(slide?.at)
  if (!Number.isFinite(at)) return startedAt ?? 0
  return at > 1e11 ? at : (startedAt ?? 0) + at
}

function openSlide(src, label) {
  if (!src) return
  ui.modal({ title: label || '截图', body: el('div.slide-full', {}, el('img', { src, alt: label || '截图' })), width: 920, actions: [{ label: '关闭', kind: 'primary' }] })
}

/** 实时记录里的一张截图缩略图（按时间插在字幕中间）。 */
function slideNode(slide, { base, dir, startedAt } = {}) {
  const t = slideTime(slide, startedAt ?? base)
  const src = slideSrc(slide, dir)
  const label = `截图 ${base ? fmtOffset(t - base) : fmtTime(t)}`
  const thumb = src
    ? el('button.slide-thumb', { type: 'button', 'aria-label': `放大${label}`, onClick: () => openSlide(src, label) }, el('img', { src, alt: label, loading: 'lazy' }))
    : el('div.slide-thumb.is-missing', {}, icon('image', 18), el('span', { text: '截图已存进会议文件夹' }))
  return el(
    'div.tline.tline-slide',
    { dataset: { t: String(t), slide: String(slide.file ?? slide.at ?? '') } },
    el('span.tline-time.num', { text: base ? fmtOffset(t - base) : fmtTime(t), title: fmtClock(t) }),
    el('span.tline-who', {}, el('span.slide-mark', {}, icon('camera', 14))),
    el('div.tline-main', {}, thumb),
  )
}

const REASON = { auto: '自动', hotkey: '快捷键', click: '点选', manual: '手动', regenerate: '重答' }

function splitAnswer(text) {
  const t = String(text ?? '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s+/, '')
  const m = t.match(/^要点[:：]\s*(.*)(?:\n+|$)/)
  if (!m) return { gist: '', body: t.trim() }
  return { gist: m[1].trim(), body: t.slice(m[0].length).trim() }
}

function answerTiming(a) {
  const t = a.timing ?? {}
  if (a.cancelled) return '已停止（有新问题）'
  // 三段分开显示：截图、等首字（请求发出去到第一个字）、生成（第一个字到答完）
  const shot = t.screen != null ? `截图 ${sec(t.screen)}` : null
  const sent = t.sent ?? t.screen ?? 0
  if (!a.done) {
    const now = Date.now() - (a.startedAt ?? Date.now())
    if (t.firstToken == null) {
      if (a.withScreen && t.screen == null && t.sent == null) return `截图中 ${sec(now)}`
      return [shot, `等首字 ${sec(Math.max(0, now - sent))}`].filter(Boolean).join(' · ')
    }
    return [shot, `等首字 ${sec(Math.max(0, t.firstToken - sent))}`, '生成中'].filter(Boolean).join(' · ')
  }
  const parts = [shot]
  if (t.firstToken != null && !a.error) {
    parts.push(`等首字 ${sec(Math.max(0, t.firstToken - sent))}`)
    if (t.total != null) parts.push(`生成 ${sec(Math.max(0, t.total - t.firstToken))}`)
  } else if (t.total != null) parts.push(`共 ${sec(t.total)}`)
  return parts.filter(Boolean).join(' · ')
}

// 回答卡片里的中外对照：一句原文，下面一句彩色译文（和字幕一样的意群颜色）
function answerPairs(list) {
  const pr = chunkPrefs()
  return list.map((sen) => {
    const r = window.bilingual.render(sen, { colors: pr.colors })
    return el('div.answer-pair', {}, el('div.answer-src', {}, r.en), r.zh && sen.tr ? el('div.answer-tr', {}, r.zh) : null)
  })
}

/** 一条 AI 回答。返回 { root, update(a) }。答完后带上 a.trans：提问和回答逐句配上译文。 */
function answerCard(a0, { live = false } = {}) {
  let a = a0
  let shownTrans = null
  const reason = el('span.tag')
  const q = el('span.answer-q-text')
  const qBi = el('div.answer-q-bi.selectable', { hidden: true })
  const gist = el('div.answer-gist.selectable')
  const body = el('div.answer-body.selectable')
  const warn = el('div.answer-note.is-warn')
  const err = el('div.answer-note.is-error')
  const timing = el('span.answer-timing.num')
  const copyBtn = iconButton('copy', '复制回答', () => {
    const { gist: g, body: b } = splitAnswer(a.text)
    if (b || g) copyText(b || g, '回答已复制')
  })
  copyBtn.classList.add('btn-sm')
  const regen =
    live && typeof api.answerRegenerate === 'function'
      ? iconButton('refresh-cw', '重新回答', async () => {
          const r = await call('answerRegenerate', a.id)
          if (failed(r) && r?.error) ui.toast({ title: '没能重新回答', message: r.error, type: 'error' })
        })
      : null
  regen?.classList.add('btn-sm')
  const root = el(
    'article.answer',
    { dataset: { id: a.id } },
    el('div.answer-q', {}, reason, q),
    qBi,
    gist,
    body,
    warn,
    err,
    el('div.answer-meta', {}, timing, el('span.header-spacer'), regen, copyBtn),
  )
  function update(next) {
    a = { ...a, ...next }
    const { gist: g, body: b } = splitAnswer(a.text)
    const streaming = live && !a.done && !a.cancelled
    root.classList.toggle('is-streaming', streaming)
    root.classList.toggle('is-error', Boolean(a.error))
    root.classList.toggle('is-stopped', Boolean(a.cancelled))
    reason.textContent = REASON[a.reason] ?? '回答'
    q.textContent = a.question ?? ''
    q.title = a.question ?? ''
    gist.textContent = g
    gist.hidden = !g
    const tr = a.trans
    q.hidden = Boolean(tr?.question?.length)
    qBi.hidden = !q.hidden
    if (tr !== shownTrans || !tr) {
      shownTrans = tr
      for (const k of ['bi-text', 'bi-bar', 'bi-mono']) root.classList.toggle(k, Boolean(tr) && k === chunkPrefs().className)
      if (tr?.question?.length) ui.clear(qBi).append(...answerPairs(tr.question))
      if (tr?.body?.length) ui.clear(body).append(...answerPairs(tr.body))
      else body.textContent = b
    }
    body.classList.toggle('has-pairs', Boolean(tr?.body?.length))
    body.hidden = !b && !streaming
    warn.textContent = a.warning ?? ''
    warn.hidden = !a.warning
    err.textContent = a.error && a.error !== 'cancelled' ? a.error : ''
    err.hidden = !err.textContent
    timing.textContent = answerTiming(a)
    copyBtn.hidden = !(g || b)
    if (regen) regen.hidden = streaming
  }
  update(a0)
  return { root, update, get: () => a }
}

/** 一条待办的列表行。opts：showProject（跨项目列表）、showSource（显示来源会议）、onOpen、onProject(anchor) */
function todoRow(t, opts = {}) {
  const check = el('input.check', { type: 'checkbox', checked: Boolean(t.done), 'aria-label': t.done ? '标记为没完成' : '标记为完成', tabindex: '-1' })
  check.addEventListener('click', (e) => e.stopPropagation())
  check.addEventListener('change', () => toggleTodo(t, check.checked, check))
  const due = dueInfo(t.due, t.done)
  const sub = []
  if (opts.showSource && t.sessionId) sub.push(`来自「${t.sessionTitle || fmtDateTime(t.sessionStartedAt)}」`)
  if (t.quote && opts.showQuote) sub.push(`“${t.quote}”${t.at != null ? ` ${fmtOffset(t.at)}` : ''}`)
  const acc = []
  if (t.owner === 'me') acc.push(el('span.tag.tag-me', { text: '我' }))
  if (t.owner === 'other') acc.push(el('span.tag.tag-other', { text: '对方' }))
  // dueUncertain：纪要标了待确认，或者原话里星期几和日期对不上
  const unsure = t.dueUncertain && !t.done ? '，日期待确认' : ''
  if (due) acc.push(el('span.tag', { dataset: due.tint ? { tint: due.tint } : undefined, text: unsure ? `${due.label} 待确认` : due.label, title: t.dueText ? `${due.title}${unsure}（原话：${t.dueText}）` : `${due.title}${unsure}` }))
  else if (t.dueText) acc.push(el('span.tag', { text: unsure ? `${t.dueText}（待确认）` : t.dueText, title: '原话里的时间' }))
  else if (unsure) acc.push(el('span.tag', { text: '日期待确认' }))
  if (opts.showProject) {
    const tag = projectTag(t.projectId)
    if (opts.onProject) {
      const b = el('button.tag-button', { type: 'button', 'aria-label': '换归属项目', onClick: (e) => (e.stopPropagation(), opts.onProject(b, t)) }, tag)
      acc.push(b)
    } else acc.push(tag)
  }
  const row = ui.listItem({
    id: t.id,
    lead: check,
    title: t.text,
    subtitle: sub.join(' · ') || null,
    twoLine: sub.length > 0,
    accessories: acc,
    className: 'todo-row',
    onClick: () => opts.onOpen?.(t),
  })
  if (t.done) row.classList.add('is-done')
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    todoContextMenu({ x: e.clientX, y: e.clientY }, t, check, opts, row)
  })
  row.title = t.quote ? `原话：${t.quote}` : ''
  row._todo = t
  row._check = check
  return row
}

/** 待办行的右键菜单：完成 / 没完成、打开来源会议、换项目、删除。 */
function todoContextMenu(anchor, t, check, opts, row) {
  const items = [
    { label: t.done ? '标记为没完成' : '标记为完成', icon: t.done ? 'circle' : 'circle-check', onSelect: () => ((check.checked = !t.done), toggleTodo(t, !t.done, check)) },
    t.sessionId && { label: '打开来源会议', icon: 'arrow-right', onSelect: () => go('meeting', { id: t.sessionId, tab: 'todos' }) },
    opts.onProject && { label: '换归属项目…', icon: 'folder', onSelect: () => opts.onProject(row, t) },
    { label: '复制', icon: 'copy', onSelect: () => copyText(t.text, '待办已复制') },
    'sep',
    {
      label: '删除',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        const ok = await ui.confirm({ title: '删除这条待办？', message: t.text, okLabel: '删除', danger: true })
        if (!ok) return
        const r = await call('removeTodo', t.sessionId, t.id)
        if (failed(r)) return ui.toast({ title: '没能删除', message: r?.error, type: 'error' })
        ui.toast({ title: '待办已删除', type: 'success' })
      },
    },
  ].filter(Boolean)
  ui.menu(anchor, items, { minWidth: 200 })
}

async function toggleTodo(t, done, check) {
  const sessionId = t.sessionId
  const r = await call('updateTodo', sessionId, t.id, { done })
  if (failed(r) || !r) {
    if (check) check.checked = !done
    ui.toast({ title: '没能更新待办', message: r?.error, type: 'error' })
    return
  }
  t.done = done
  if (done)
    ui.toast({
      title: '已完成',
      message: t.text,
      type: 'success',
      action: { label: '撤销', onClick: () => call('updateTodo', sessionId, t.id, { done: false }) },
    })
}

/** 待办行的空格键：切换勾选。 */
function wireTodoKeys(list, nav) {
  list.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.isComposing) return
    const row = nav.selected()
    if (!row?._check) return
    e.preventDefault()
    row._check.checked = !row._check.checked
    row._check.dispatchEvent(new Event('change'))
  })
}

/**
 * 开始按钮的下拉：选项目（showProjects）、选模式（课堂再分教室现场和网课）。
 * 选的模式只管这一次（state.modeChoice），和项目默认不一样时可以一键设成默认。
 */
function startMenu(anchor, { projectId = state.currentProjectId, showProjects = true } = {}) {
  const pid = projectId
  const c = startChoice(pid)
  const def = { mode: projectMode(pid), classSource: projectClassSource(pid) }
  const items = []
  if (showProjects) {
    items.push({ section: '在哪个项目里' })
    for (const p of activeProjects())
      items.push({
        label: p.name,
        icon: projectIconName(p),
        tint: projectTint(p),
        checked: p.id === pid,
        onSelect: () => {
          state.modeChoice = null
          setCurrentProject(p.id)
        },
      })
    items.push({ label: '新建项目…', icon: 'plus', onSelect: () => newProjectModal() }, 'sep')
  }
  const pick = (mode, classSource) => {
    state.modeChoice = { projectId: pid, mode, classSource: classSource ?? projectClassSource(pid) }
    emit('mode', state.modeChoice)
  }
  items.push({ section: '模式' })
  items.push({ label: '会议', icon: MODES.meeting.icon, description: MODES.meeting.desc, checked: c.mode === 'meeting', onSelect: () => pick('meeting') })
  items.push({ label: '面试', icon: MODES.interview.icon, description: MODES.interview.desc, checked: c.mode === 'interview', onSelect: () => pick('interview') })
  for (const [src, info] of Object.entries(CLASS_SOURCES))
    items.push({ label: `课堂：${info.label}`, icon: info.icon, description: info.desc, checked: c.mode === 'class' && sourceOf(c.classSource) === src, onSelect: () => pick('class', src) })
  const differs = c.mode !== def.mode || (c.mode === 'class' && sourceOf(c.classSource) !== def.classSource)
  const p = projectOf(pid)
  if (differs && p) {
    items.push('sep', {
      label: `把这个设成「${p.name}」的默认`,
      icon: 'check',
      onSelect: async () => {
        const patch = { mode: c.mode, ...(c.mode === 'class' ? { classSource: sourceOf(c.classSource) } : {}) }
        const r = await call('updateProject', pid, patch)
        if (failed(r)) return ui.toast({ title: '没能保存', message: r?.error, type: 'error' })
        state.projectModes.set(pid, { ...state.projectModes.get(pid), ...patch })
        const row = projectOf(pid)
        if (row) Object.assign(row, patch)
        state.modeChoice = null
        emit('mode', null)
        ui.toast({ title: `「${p.name}」默认${modeInfo(c.mode).label}模式`, type: 'success' })
      },
    })
  }
  return ui.menu(anchor, items, { searchable: showProjects && items.length > 16, placeholder: '找项目或模式', minWidth: 280 })
}

/** 项目选择菜单（开会、移动会议、改待办归属）。 */
function projectMenu(anchor, { current, onPick, title, includeNew = false, exclude } = {}) {
  const items = []
  if (title) items.push({ section: title })
  for (const p of activeProjects()) {
    if (exclude && exclude === p.id) continue
    items.push({ label: p.name, icon: projectIconName(p), tint: projectTint(p), checked: p.id === current, onSelect: () => onPick(p.id) })
  }
  if (includeNew) items.push('sep', { label: '新建项目…', icon: 'plus', onSelect: () => newProjectModal() })
  return ui.menu(anchor, items, { searchable: items.length > 9, placeholder: '找项目', minWidth: 220 })
}
