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
// 调整位置时的示例：回答每句前面带标签，和真回答一样的排法
const SENTENCES = [
  [t('产品要实时，研究要准'), 'In my last project, the product team wanted real time results, but the research side needed accuracy.'],
  [t('先用数字看取舍'), 'I set up a quick benchmark so we could see the trade-off in numbers.'],
  [t('先上快速模式，准的留给报告'), 'We shipped a fast mode first, and kept the accurate path for the final report.'],
]
const SAMPLE = [
  {
    id: 'sample-1',
    question: 'Can you tell me about a project where you had to deal with conflicting requirements?',
    text: `要点：${t('讲清冲突、取舍依据和结果')}\n${SENTENCES.map((x) => x[1]).join(' ')}`,
    hints: SENTENCES.map((x, i) => ({ at: SENTENCES.slice(0, i).reduce((n, y) => n + y[1].length + 1, 0), text: x[0] })),
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

// 最新一条的要点和底栏平时透明，真贴住（要点贴在列表上沿、底栏贴在下沿）时才上底色
function syncStuck() {
  const view = list.getBoundingClientRect()
  for (const c of cards.values()) {
    const g = c.gist.getBoundingClientRect()
    const m = c.meta.getBoundingClientRect()
    c.gist.classList.toggle('stuck', g.height > 0 && g.top - view.top < 1)
    c.meta.classList.toggle('stuck', m.height > 0 && view.bottom - m.bottom < 1)
  }
}
const cardSize = new ResizeObserver(syncStuck) // 译文回来、展开收回都会改卡片高度

let hover = null // 现在浮着的提问全文对着谁 { anchor, nodes }

function createCard(id) {
  const root = el('article', 'card')
  const q = el('div', 'q')
  const tag = el('span', 'tag')
  const qZh = el('span', 'q-zh')
  const qHead = el('span', 'q-head', t('问：'))
  const qText = el('span', 'q-src')
  const qTr = el('div', 'q-tr cols')
  qZh.append(qHead, qText)
  q.append(tag, qZh)
  const gist = el('div', 'gist')
  const body = el('div', 'body')
  const warn = el('div', 'note warn')
  const error = el('div', 'note error')
  const meta = el('div', 'meta')
  const timing = el('span', 'timing')
  const regen = el('button', 'ghost regen', t('重新回答'))
  const copy = el('button', 'ghost copy', t('复制'))
  regen.type = copy.type = 'button'
  const acts = el('span', 'acts')
  acts.append(regen, copy)
  meta.append(timing, acts)
  root.append(q, qTr, gist, body, warn, error, meta)
  cardSize.observe(root)
  const c = { root, tag, q, qZh, qText, qTr, gist, body, warn, error, meta, timing, regen, copy, units: [] }
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
  // 旧卡片默认只露两行，点一下展开、再点收起（选中文字复制时不算）
  root.addEventListener('click', (e) => {
    if (e.target.closest('button') || !root.classList.contains('old') || String(getSelection()).trim()) return
    if (opened.has(id)) opened.delete(id)
    else opened.add(id)
    root.classList.toggle('open', opened.has(id))
    hidePop()
  })
  // 提问行只放真正问的那一句：前面还有铺垫，或者一行放不下时，指上去看提问全文
  qZh.addEventListener('mouseenter', () => {
    const a = answers.get(id) ?? SAMPLE.find((s) => s.id === id)
    if (a && ((a.trans?.question?.length ?? 0) > 1 || qZh.scrollHeight > qZh.clientHeight + 1)) showPop(qZh, questionPop(a))
  })
  qZh.addEventListener('mouseleave', hidePop)
  return c
}

/* ---------------- 浮出的提问全文：盖在下面的字上，不占版面 ---------------- */

const pop = document.getElementById('pop')

function showPop(anchor, nodes) {
  hover = { anchor, nodes }
  pop.replaceChildren(...nodes)
  placePop()
}

function hidePop() {
  hover = null
  pop.classList.remove('on')
}

// 指着的字之后放得下就放下面，放不下放上面；字滚出可视区了就收起
function placePop() {
  if (!hover) return
  const rects = hover.anchor.getClientRects()
  if (!rects.length) return hidePop()
  const first = rects[0]
  const last = rects[rects.length - 1]
  const view = list.getBoundingClientRect()
  if (last.bottom < view.top || first.top > view.bottom) return pop.classList.remove('on')
  const box = panel.getBoundingClientRect()
  pop.classList.add('on')
  const h = pop.offsetHeight
  let top = last.bottom - box.top + 6
  if (top + h > box.height - 8) top = first.top - box.top - h - 6
  pop.style.top = `${Math.max(view.top - box.top, top)}px`
}

const bi = () => window.bilingual
const colorsOn = () => bi().prefs(config).colors

function questionPop(a) {
  const qs = a.trans?.question ?? []
  const last = qs.at(-1)
  const nodes = [el('span', 'pop-k', t('提问原文'))]
  if (!last) return [...nodes, el('span', 'plain', a.question)]
  const r = bi().render(last, { colors: colorsOn(), terms: false })
  const en = el('span', 'bars')
  en.append(r.en)
  nodes.push(en)
  if (r.zh && last.tr) {
    const zh = el('span', 'cols')
    zh.append(r.zh)
    nodes.push(el('br'), zh)
  }
  const before = qs.slice(0, -1).map((x) => x.text).join(' ')
  if (before) nodes.push(el('span', 'pop-src', t(`前面还说了：{0}`, before)))
  return nodes
}

// 最后一句才是真正问的：原文一行，译文回来以后在下面再一行，和主窗口里的对照一样
const lastSentence = (q) => String(q ?? '').split(/(?<=[.?!。？！])\s*/).filter((x) => x.trim()).at(-1) ?? ''

// 正文：一句一个单元。译文回来以前标签在句首、整段连排；回来以后和主窗口一样，一句原文（按意群着色）下面一句译文
function buildBody(c, a) {
  const { body } = split(a.text)
  c.units = window.answerUnits.build(body, a.hints, a.trans)
  const nodes = []
  c.units.forEach((u, i) => {
    if (i) nodes.push(' ')
    const s = el('span', 's')
    s.dataset.i = i
    if (u.hint) s.append(el('span', 'hint', u.hint))
    const en = el('span', 'en')
    if (u.sen?.tr) {
      const r = bi().render(u.sen, { colors: colorsOn(), terms: false })
      en.append(r.en)
      s.classList.add('has-tr')
      const zh = el('span', 'zh')
      zh.append(r.zh)
      s.append(en, zh)
    } else {
      en.textContent = u.text
      s.append(en)
    }
    nodes.push(s)
  })
  if (!a.done) nodes.push(el('span', 'caret'))
  c.body.replaceChildren(...nodes)
  c.body.classList.toggle('pairs', c.units.some((u) => u.sen?.tr))
}

// 提问：最后一句原文（按意群着色），译文回来以后下面一行彩色译文
function buildQuestion(c, a) {
  const last = a.trans?.question?.at(-1)
  if (last?.tr) {
    const r = bi().render(last, { colors: colorsOn(), terms: false })
    c.qText.replaceChildren(r.en)
    c.qTr.replaceChildren(r.zh ?? last.tr)
  } else {
    c.qText.textContent = last?.text || lastSentence(a.question)
    c.qTr.replaceChildren()
  }
  c.qTr.hidden = !last?.tr
}

function fillCard(c, a, latest) {
  const { gist } = split(a.text)
  const tr = a.trans
  c.root.classList.toggle('latest', latest)
  c.root.classList.toggle('old', !latest)
  c.root.classList.toggle('open', opened.has(a.id))
  c.root.classList.toggle('live', !a.done)
  c.tag.textContent = REASON[a.reason] ?? t('提问')
  c.gist.textContent = gist
  const key = JSON.stringify([a.text, a.hints, tr?.body, tr?.question, a.done, config.display])
  if (key !== c.shownKey) {
    c.shownKey = key
    buildBody(c, a)
    buildQuestion(c, a)
  }
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
      cardSize.unobserve(c.root)
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
  placePop()
  syncStuck()
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
  hidePop()
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
  // 意群颜色跟主窗口同一个设置：文字着色、底部细色条，或者关掉
  for (const k of ['bi-text', 'bi-bar', 'bi-mono']) document.body.classList.toggle(k, k === bi().prefs(config).className)
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
new ResizeObserver(placePop).observe(panel)
list.addEventListener(
  'scroll',
  () => {
    placePop()
    syncStuck()
  },
  { passive: true },
)

// 随时拖动：按住面板（按钮和回答正文以外）拖就移动答题框；调整位置模式下由 -webkit-app-region 负责
window.dragWindow(panel, { moveTo: (p) => api.moveTo(p), enabled: () => !config.editMode, ignore: '.body' })

/* ---------------- 调整位置模式：拖边缘改大小（移动靠 -webkit-app-region；大小由主进程按鼠标走了多远算） ---------------- */

document.getElementById('done').addEventListener('click', () => api.doneEditing())
for (const handle of document.querySelectorAll('.handle')) {
  handle.addEventListener('pointerdown', (e) => {
    const edges = handle.dataset.edges
    let first = true
    handle.setPointerCapture(e.pointerId)
    const move = () => {
      api.resizeEdges({ edges, first })
      first = false
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
