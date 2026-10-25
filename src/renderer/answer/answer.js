const api = window.answerApi
const panel = document.getElementById('panel')
const list = document.getElementById('list')
const dot = document.getElementById('dot')
const count = document.getElementById('count')
const collapseBtn = document.getElementById('collapse')

const MAX = 20
const answers = new Map() // id → answer
const cards = new Map() // id → { el, parts }
const opened = new Set() // 手动展开的旧卡片
let config = { editMode: false, fontSize: 16, bgOpacity: 0.9, hotkeyAsk: '' }
let collapsed = false
let ignoring = true // 窗口创建时是穿透的

const REASON = { auto: t('自动'), hotkey: t('快捷键'), manual: t('手动'), regenerate: t('重答') }
const now = Date.now()
const SAMPLE = [
  {
    id: 'sample-1',
    question: 'Can you tell me about a project where you had to deal with conflicting requirements?',
    text: t('要点：讲清冲突、取舍依据和结果\nIn my last project, the product team wanted real time results, but the research side needed accuracy. I set up a quick benchmark so we could see the trade-off in numbers. We shipped a fast mode first, and kept the accurate path for the final report.'),
    done: true,
    reason: 'auto',
    withScreen: false,
    startedAt: now,
    timing: { screen: null, firstToken: 1180, total: 2900 },
  },
  {
    id: 'sample-2',
    question: t('为什么选这个 baseline 而不是新的那个？'),
    text: t('要点：可比性和复现成本\n我们选它主要是因为之前的工作都用它，结果能直接比。新的那个我们也试了，但代码没公开，复现不出论文里的数。'),
    done: true,
    reason: 'hotkey',
    withScreen: true,
    startedAt: now - 60_000,
    timing: { screen: 240, firstToken: 1350, total: 3100 },
  },
]

/* ---------------- 文本 ---------------- */

function split(text) {
  const tv = String(text ?? '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s+/, '')
  const m = tv.match(/^要点[:：]\s*(.*)(?:\n+|$)/)
  if (!m) return { gist: '', body: tv.trim() }
  return { gist: m[1].trim(), body: tv.slice(m[0].length).trim() }
}

const sec = (ms) => `${(ms / 1000).toFixed(1)}s`

function timingText(a) {
  const tv = a.timing ?? {}
  if (a.cancelled) return t('已停止（有新问题）')
  // 三段分开显示：截图、等首字（请求发出去到第一个字）、生成（第一个字到答完）
  const shot = tv.screen != null ? t(`截图 {0}`, sec(tv.screen)) : null
  const sent = tv.sent ?? tv.screen ?? 0
  if (!a.done) {
    const now = Date.now() - a.startedAt
    if (tv.firstToken == null) {
      if (a.withScreen && tv.screen == null && tv.sent == null) return t(`截图中 {0}`, sec(now))
      return [shot, t(`等首字 {0}`, sec(Math.max(0, now - sent)))].filter(Boolean).join(' · ')
    }
    return [shot, t(`等首字 {0}`, sec(Math.max(0, tv.firstToken - sent))), t('生成中')].filter(Boolean).join(' · ')
  }
  const parts = [shot]
  if (tv.firstToken != null && !a.error) {
    parts.push(t(`等首字 {0}`, sec(Math.max(0, tv.firstToken - sent))))
    if (tv.total != null) parts.push(t(`生成 {0}`, sec(Math.max(0, tv.total - tv.firstToken))))
  } else if (tv.total != null) parts.push(t(`共 {0}`, sec(tv.total)))
  return parts.filter(Boolean).join(' · ')
}

function hotkeyKeys(accel) {
  if (!accel) return []
  const mac = /Mac/.test(navigator.userAgent)
  const map = mac
    ? { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' }
    : { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  return accel.split('+').map((k) => map[k] ?? k)
}

/* ---------------- 卡片 ---------------- */

function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function createCard(id) {
  const root = el('article', 'card')
  const q = el('div', 'q')
  const tag = el('span', 'tag')
  const qText = el('span')
  q.append(tag, qText)
  const gist = el('div', 'gist')
  const body = el('div', 'body')
  const warn = el('div', 'note warn')
  const error = el('div', 'note error')
  const meta = el('div', 'meta')
  const timing = el('span', 'timing')
  const regen = el('button', 'ghost', t('重新回答'))
  const copy = el('button', 'ghost', t('复制'))
  regen.type = copy.type = 'button'
  meta.append(timing, regen, copy)
  root.append(q, gist, body, warn, error, meta)
  regen.addEventListener('click', () => {
    if (!id.startsWith('sample-')) api.regenerate(id)
  })
  copy.addEventListener('click', () => {
    const a = answers.get(id) ?? SAMPLE.find((s) => s.id === id)
    if (!a) return
    const { body: b, gist: g } = split(a.text)
    api.copy(b || g)
    copy.textContent = t('已复制')
    setTimeout(() => (copy.textContent = t('复制')), 1200)
  })
  // 旧卡片默认只露两行，点一下展开
  root.addEventListener('click', (e) => {
    if (e.target.closest('button') || !root.classList.contains('old')) return
    if (opened.has(id)) opened.delete(id)
    else opened.add(id)
    root.classList.toggle('open', opened.has(id))
  })
  return { root, tag, qText, gist, body, warn, error, timing, regen, copy }
}

// 答完后的中外对照：一句原文，下面一句彩色译文（意群颜色同字幕）
function pairs(list) {
  const bi = window.bilingual
  const pr = bi.prefs(config)
  return list.map((sen) => {
    const r = bi.render(sen, { colors: pr.colors })
    const row = el('div', 'pair')
    row.append(el('div', 'src'))
    row.firstChild.append(r.en)
    if (r.zh && sen.tr) {
      const tr = el('div', 'tr')
      tr.append(r.zh)
      row.append(tr)
    }
    return row
  })
}

function fillCard(c, a, latest) {
  const { gist, body } = split(a.text)
  const tr = a.trans
  c.root.classList.toggle('latest', latest)
  c.root.classList.toggle('old', !latest)
  c.root.classList.toggle('open', opened.has(a.id))
  c.root.classList.toggle('live', !a.done)
  c.tag.textContent = REASON[a.reason] ?? t('提问')
  c.gist.textContent = gist
  if (tr !== c.shownTrans || !tr) {
    c.shownTrans = tr
    for (const k of ['bi-text', 'bi-bar', 'bi-mono']) c.root.classList.toggle(k, Boolean(tr) && k === window.bilingual.prefs(config).className)
    // 悬浮框地方小：提问只放最后一句（真正问的那句）和它的译文，回答留在第一屏；主窗口的卡片里是整段
    if (tr?.question?.length) c.qText.replaceChildren(...pairs(tr.question.slice(-1)))
    else c.qText.textContent = a.question
    if (tr?.body?.length) c.body.replaceChildren(...pairs(tr.body))
    else c.body.textContent = body
    c.root.classList.toggle('has-pairs', Boolean(tr))
  }
  if (!a.done) c.body.append(el('span', 'caret'))
  c.warn.textContent = a.warning ?? ''
  c.error.textContent = a.error ?? ''
  c.timing.textContent = timingText(a)
  c.copy.disabled = !a.text
}

function ordered() {
  const all = config.editMode && !answers.size ? SAMPLE : [...answers.values()]
  return all.sort((x, y) => y.startedAt - x.startedAt).slice(0, MAX)
}

function render() {
  const items = ordered()
  const keep = new Set(items.map((a) => a.id))
  for (const [id, c] of cards) {
    if (!keep.has(id)) {
      c.root.remove()
      cards.delete(id)
    }
  }
  items.forEach((a, i) => {
    let c = cards.get(a.id)
    if (!c) {
      c = createCard(a.id)
      cards.set(a.id, c)
    }
    fillCard(c, a, i === 0)
    if (list.children[i] !== c.root) list.insertBefore(c.root, list.children[i] ?? null)
  })
  const live = items.some((a) => !a.done)
  dot.classList.toggle('live', live)
  renderCount(items)
  panel.classList.toggle('hidden', !items.length)
  panel.classList.toggle('collapsed', collapsed && !config.editMode)
  collapseBtn.textContent = collapsed ? t('展开') : t('收起')
  collapseBtn.hidden = Boolean(config.editMode)
  reportHit()
}

// 标题条右边：收起时显示条数，平时用快捷键徽标提示「回答刚才的问题」
function renderCount(items) {
  if (collapsed && items.length) return count.replaceChildren(t(`{0} 条，点「展开」查看`, items.length))
  const keys = hotkeyKeys(config.hotkeyAsk)
  if (!keys.length || items.some((a) => !a.done)) return count.replaceChildren()
  const group = el('span', 'kbd-group')
  group.append(...keys.map((k) => el('span', 'kbd', k)))
  count.replaceChildren(group, el('span', 'count-text', t('回答刚才的问题')))
}

// 等首字时计时器每 100ms 走一次
setInterval(() => {
  for (const a of answers.values()) {
    if (!a.done) {
      const c = cards.get(a.id)
      if (c) c.timing.textContent = timingText(a)
    }
  }
}, 100)

/* ---------------- 事件 ---------------- */

api.onUpdate((a) => {
  const isNew = !answers.has(a.id) || a.startedAt !== answers.get(a.id).startedAt
  answers.set(a.id, a)
  if (answers.size > MAX) {
    const oldest = [...answers.values()].sort((x, y) => x.startedAt - y.startedAt)[0]
    answers.delete(oldest.id)
  }
  if (isNew) {
    // 新问题来了：自动展开并滚回顶部
    collapsed = false
    opened.delete(a.id)
    list.scrollTop = 0
  }
  render()
})

api.onClear(() => {
  answers.clear()
  opened.clear()
  render()
})

api.onConfig((c) => {
  // 退出调整模式时主进程已把窗口改回穿透，这里的状态跟着复位
  if (config.editMode && !c.editMode) ignoring = true
  config = { ...config, ...c }
  const root = document.documentElement.style
  root.setProperty('--font-size', `${config.fontSize}px`)
  root.setProperty('--bg', `rgba(12, 14, 20, ${config.bgOpacity})`)
  document.body.classList.toggle('editing', Boolean(config.editMode))
  // 面试模式：答题框更显眼（强调色描边、最新一条字更大），主进程在 answer:config 里带 mode
  document.body.classList.toggle('prominent', config.mode === 'interview' || Boolean(config.prominent))
  if (config.editMode) setIgnore(false)
  render()
})

collapseBtn.addEventListener('click', () => {
  collapsed = !collapsed
  render()
})

/* ---------------- 鼠标穿透：只在面板上接管鼠标 ---------------- */

function setIgnore(v) {
  if (ignoring === v) return
  ignoring = v
  api.setIgnoreMouse(v)
}
document.addEventListener('mousemove', (e) => {
  if (config.editMode) return
  setIgnore(!e.target.closest('.hit'))
})
document.addEventListener('mouseleave', () => {
  if (!config.editMode) setIgnore(true)
})
// Mac 上点面板会把应用激活，松手后让主进程把前台还给会议软件
document.addEventListener('pointerup', () => {
  if (!config.editMode) api.clicked()
})

// Windows 由主进程轮询鼠标位置决定穿透，这里只报面板在窗口里的位置（面板贴左上角，大小变了才要重报）
let lastHit = ''
function reportHit() {
  const r = panel.classList.contains('hidden') ? null : panel.getBoundingClientRect()
  const hit = r && r.width > 0 && r.height > 0 ? { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) } : null
  const key = JSON.stringify(hit)
  if (key === lastHit) return
  lastHit = key
  api.setHitRect(hit)
}
new ResizeObserver(reportHit).observe(panel)

// 随时拖动：按住面板（按钮和回答正文以外）拖就移动答题框；调整位置模式下由 -webkit-app-region 负责
window.dragWindow(panel, { moveTo: (p) => api.moveTo(p), enabled: () => !config.editMode, ignore: '.body' })

/* ---------------- 调整位置模式：拖边缘改大小（移动靠 -webkit-app-region） ---------------- */

document.getElementById('done').addEventListener('click', () => api.doneEditing())
for (const handle of document.querySelectorAll('.handle')) {
  handle.addEventListener('pointerdown', (e) => {
    const edges = handle.dataset.edges
    const start = { mx: e.screenX, my: e.screenY, x: window.screenX, y: window.screenY, w: window.innerWidth, h: window.innerHeight }
    handle.setPointerCapture(e.pointerId)
    const move = (ev) => {
      const dx = ev.screenX - start.mx
      const dy = ev.screenY - start.my
      let { x, y, w, h } = start
      if (edges.includes('r')) w = start.w + dx
      if (edges.includes('l')) {
        w = Math.max(300, start.w - dx)
        x = start.x + start.w - w
      }
      if (edges.includes('b')) h = start.h + dy
      if (edges.includes('t')) {
        h = Math.max(200, start.h - dy)
        y = start.y + start.h - h
      }
      api.setBounds({ x, y, width: Math.max(300, w), height: Math.max(200, h) })
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
}

api.ready()
