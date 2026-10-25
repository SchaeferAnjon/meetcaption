const api = window.overlayApi
const bi = window.bilingual
const box = document.getElementById('box')
const lines = document.getElementById('lines')
const tip = document.getElementById('tip')
const tipTerm = tip.querySelector('.tip-term')
const tipText = tip.querySelector('.tip-text')
const tipArrow = tip.querySelector('.tip-arrow')
const segments = new Map()
const nodes = new Map() // 句子 key → { el, en, tr, sig }，内容没变就复用，悬停不会丢
let config = { fontSize: 26, lines: 3, bgOpacity: 0.6, textColor: '#fff', translationColor: '#ffd666', showTranslation: true, showMic: false, editMode: false, display: { chunkColors: true } }
let lastActivity = 0

const QUIET_AFTER_MS = 12_000
const HOVER_MS = 300
const SWITCH_GRACE_MS = 150
// 调整位置时没有字幕就显示这两句，意群颜色和术语也能看到效果
const SAMPLE = [
  {
    id: 'a',
    source: 'system',
    who: 'other',
    speaker: t('对方'),
    startedAt: 1,
    final: true,
    text: 'Okay, so about the second section of the paper.',
    sentences: [
      {
        text: 'Okay, so about the second section of the paper.',
        tr: t('好，关于论文的第二部分。'),
        chunks: [
          { en: 'Okay, so', zh: t('好') },
          { en: 'about the second section of the paper', zh: t('关于论文的第二部分') },
        ],
      },
    ],
  },
  {
    id: 'b',
    source: 'system',
    who: 'other',
    speaker: t('对方'),
    startedAt: 2,
    final: false,
    text: 'Please send me the revised ablation table by next Friday.',
    sentences: [
      {
        text: 'Please send me the revised ablation table by next Friday.',
        tr: t('下周五之前把改好的消融实验表发给我。'),
        chunks: [
          { en: 'Please send me', zh: t('发给我') },
          { en: 'the revised ablation table', zh: t('改好的消融实验表') },
          { en: 'by next Friday', zh: t('下周五之前') },
        ],
        terms: [{ term: 'ablation', zh: t('消融实验'), explain: t('去掉模型的某个部分，看效果掉多少') }],
      },
    ],
  },
]

const termsOn = () => config.terms?.enabled !== false
// 意群颜色：主进程把 settings.display 放进 overlay:config（没放就按默认：开，文字着色）
const chunkPrefs = () => bi.prefs(config)
const isMine = (s) => (s.who ? s.who === 'me' : s.source === 'mic')

function applyConfig(c) {
  config = c
  const root = document.documentElement.style
  root.setProperty('--font-size', `${c.fontSize}px`)
  root.setProperty('--bg', `rgba(12, 14, 20, ${c.bgOpacity})`)
  root.setProperty('--text', c.textColor)
  root.setProperty('--tr', c.translationColor)
  root.setProperty('--tip-space', `${Math.max(0, c.tipSpace || 0)}px`)
  root.setProperty('--tip-font', `${Math.min(20, Math.max(13, Math.round(c.fontSize * 0.6)))}px`)
  document.body.classList.toggle('editing', Boolean(c.editMode))
  document.body.classList.toggle('has-tip-space', c.tipSpace > 0)
  document.body.classList.toggle('anchor-top', c.anchor === 'top')
  const bic = chunkPrefs().className
  for (const k of ['bi-text', 'bi-bar', 'bi-mono']) document.body.classList.toggle(k, k === bic)
  renderEditKeys(c.hotkeyToggle)
  render()
}

// 调整位置时，提示条上用快捷键徽标提示「显示 / 隐藏」（只是显示，不参与逻辑）
function renderEditKeys(accel) {
  const wrap = document.getElementById('editKeys')
  if (!wrap) return
  const mac = /Mac/.test(navigator.userAgent)
  const map = mac
    ? { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' }
    : { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Command: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win' }
  const keys = String(accel || '')
    .split('+')
    .filter(Boolean)
    .map((k) => map[k] ?? k)
  document.getElementById('editKbd').replaceChildren(
    ...keys.map((k) => {
      const s = document.createElement('span')
      s.className = 'kbd'
      s.textContent = k
      return s
    }),
  )
  wrap.hidden = !keys.length
}

// 按我 / 对方过滤，不按声音来源：面对面和课堂（教室现场）时麦克风里的是对方或老师
function visibleSegments() {
  const list = [...segments.values()].filter((s) => s.text && (config.showMic || !isMine(s)))
  list.sort((a, b) => a.startedAt - b.startedAt)
  return list.slice(-12)
}

// 按句子排：每句原文下面紧跟它的译文。放不下时从最上面整句移走，不出现半行。
function sentenceItems(list) {
  const items = []
  const mixed = config.showMic && list.some(isMine)
  for (const seg of list) {
    const sentences = seg.sentences?.length ? seg.sentences : [{ text: seg.text }]
    const mine = isMine(seg)
    sentences.forEach((sen, i) => {
      const last = i === sentences.length - 1
      items.push({
        key: `${seg.id}#${i}`,
        sen: { ...sen, text: sen.text || seg.text },
        showTr: Boolean(config.showTranslation),
        live: !seg.final && last,
        mine,
        speaker: mixed && i === 0 ? speakerLabel(seg, mine) : '',
      })
    })
  }
  return items.slice(-16)
}

function speakerLabel(seg, mine) {
  if (mine) return t('我')
  if (config.mode === 'class') return t('老师')
  return seg.speaker && seg.speaker !== '我' ? seg.speaker : t('对方')
}

// 一句原文加它的译文：意群同色、术语两边都画虚线（shared/bilingual.js），内容没变就不重画
function itemNode(it) {
  let n = nodes.get(it.key)
  if (!n) {
    const el = document.createElement('div')
    const en = document.createElement('div')
    en.className = 'en'
    el.append(en)
    n = { el, en, tr: null, sig: null }
    nodes.set(it.key, n)
  }
  const cls = `seg${it.live ? ' live' : ''}${it.mine ? ' mine' : ''}`
  if (n.el.className !== cls) n.el.className = cls
  const opts = { colors: chunkPrefs().colors, terms: termsOn(), key: `${it.key}@` }
  const sig = `${bi.signature(it.sen, opts)}|${it.speaker}|${it.showTr}`
  if (sig === n.sig) return n.el
  n.sig = sig
  const r = bi.render(it.sen, opts)
  const kids = []
  if (it.speaker) {
    const sp = document.createElement('span')
    sp.className = 'speaker'
    sp.textContent = it.speaker
    kids.push(sp)
  }
  n.en.replaceChildren(...kids, r.en)
  if (it.showTr && r.zh && it.sen.tr) {
    if (!n.tr) {
      n.tr = document.createElement('div')
      n.tr.className = 'tr'
      n.el.append(n.tr)
    }
    n.tr.replaceChildren(r.zh)
  } else if (n.tr) {
    n.tr.remove()
    n.tr = null
  }
  return n.el
}

function render() {
  let list = visibleSegments()
  if (!list.length && config.editMode) list = SAMPLE
  const items = sentenceItems(list)
  const wanted = items.map(itemNode)
  const keep = new Set(items.map((it) => it.key))
  for (const [k, n] of nodes) {
    if (keep.has(k)) continue
    n.el.remove()
    nodes.delete(k)
  }
  // 只移动顺序不对的节点，没变的句子原地不动
  let cur = lines.firstChild
  for (const el of wanted) {
    if (el === cur) cur = cur.nextSibling
    else lines.insertBefore(el, cur)
  }
  while (cur) {
    const next = cur.nextSibling
    cur.remove()
    cur = next
  }
  // 从上往下删整句，直到放得下；最后一句太长就让它顶部被渐隐遮住。
  while (lines.children.length > 1 && lines.scrollHeight > lines.clientHeight + 1) lines.firstElementChild.remove()
  const clipped = lines.scrollHeight > lines.clientHeight + 1
  lines.classList.toggle('clipped', clipped)
  lines.scrollTop = clipped ? lines.scrollHeight : 0
  const hasContent = items.length > 0
  // 正在看解释时不淡出
  const quiet = !config.editMode && !hover.shownId && (!hasContent || Date.now() - lastActivity > QUIET_AFTER_MS)
  box.classList.toggle('quiet', quiet)
  syncTip()
  reportHit()
}

// 随时拖动：把字幕框在窗口里的位置报给主进程，鼠标在框上时它就接管点击（框淡出了或在调整位置模式就不报）
let lastHit = ''
function reportHit() {
  const r = config.editMode || box.classList.contains('quiet') ? null : box.getBoundingClientRect()
  const hit = r && r.width > 0 && r.height > 0 ? { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) } : null
  const key = JSON.stringify(hit)
  if (key === lastHit) return
  lastHit = key
  api.setHitRect(hit)
}
new ResizeObserver(reportHit).observe(box)

/* ---------------- 术语悬停 ---------------- */

// id：鼠标所在（或等待弹出）的术语；shownId：解释框当前显示的术语
const hover = { id: '', shownId: '', timer: 0, hideTimer: 0 }
let pointer = null

// 术语关着时画出来的字幕里就没有术语节点；纠正过的词（.fix）不管术语开没开都能悬停看识别原文
const canTip = () => !config.editMode && !box.classList.contains('quiet')
const tipTarget = (node) => node?.closest?.(bi.TIP_SELECTOR) ?? null

// 同一个术语中英两边各有一处（data-tid 一样）：鼠标下面的那一处优先
function termEl(id) {
  if (!id) return null
  const under = pointer && tipTarget(document.elementFromPoint(pointer.x, pointer.y))
  if (under && under.dataset.tid === id) return under
  for (const el of lines.querySelectorAll(bi.TIP_SELECTOR)) if (el.dataset.tid === id) return el
  return null
}

// 两边一起高亮
function markHot(id) {
  for (const el of lines.querySelectorAll(bi.TIP_SELECTOR)) el.classList.toggle('hot', Boolean(id) && el.dataset.tid === id)
}

function placeTip(el) {
  const b = box.getBoundingClientRect()
  const w = tip.offsetWidth
  const h = tip.offsetHeight
  tip.classList.toggle('no-arrow', !el)
  if (!el) return
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const left = Math.min(Math.max(8, cx - w / 2), window.innerWidth - w - 8)
  // 默认放在术语区：字幕往上长时在字幕框上方，往下长时在下方；放不下就退到术语那一行的上方，再不行放下方
  let top
  let below = false
  if (config.anchor === 'top' && b.bottom + h + 10 <= window.innerHeight - 2) {
    top = b.bottom + 10
    below = true
  } else {
    top = b.top - h - 10
    if (top < 2) top = r.top - h - 10
    if (top < 2) {
      top = r.bottom + 10
      below = true
    }
  }
  tip.classList.toggle('below', below)
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
  tipArrow.style.left = `${Math.round(Math.min(Math.max(cx - left, 14), w - 14))}px`
}

function showTip() {
  clearTimeout(hover.timer)
  const el = termEl(hover.id)
  if (!el || !canTip()) return
  hover.shownId = hover.id
  const c = bi.tipContent(el)
  tipTerm.textContent = c.title
  tipText.textContent = c.text
  placeTip(el)
  tip.classList.add('show')
  markHot(hover.id)
}

function hideTip() {
  clearTimeout(hover.timer)
  clearTimeout(hover.hideTimer)
  const wasShown = Boolean(hover.shownId)
  hover.shownId = ''
  tip.classList.remove('show')
  markHot(hover.id)
  if (wasShown) render() // 看完解释后按正常规则淡出
}

function enterTerm(el) {
  clearTimeout(hover.timer)
  clearTimeout(hover.hideTimer)
  hover.id = el.dataset.tid
  markHot(hover.id)
  // 已经有解释框开着（刚从别的术语移过来）就直接切换，不用再等
  if (hover.shownId) showTip()
  else hover.timer = setTimeout(showTip, HOVER_MS)
}

function leaveTerm() {
  if (!hover.id && !hover.shownId) return
  clearTimeout(hover.timer)
  hover.id = ''
  markHot('')
  if (hover.shownId) {
    clearTimeout(hover.hideTimer)
    hover.hideTimer = setTimeout(hideTip, SWITCH_GRACE_MS)
  }
}

function pointAt(target) {
  const el = canTip() ? tipTarget(target) : null
  if (!el) return leaveTerm()
  if (el.dataset.tid === hover.id) {
    clearTimeout(hover.hideTimer)
    if (hover.shownId) placeTip(el) // 从英文挪到中文那一处：气泡跟过去
    return
  }
  enterTerm(el)
}

// 字幕更新后：解释框跟着术语走；鼠标没动就不收起，术语被挤出去也留着，等鼠标动了再说
function syncTip() {
  if (!hover.id && !hover.shownId) return
  if (!canTip()) {
    hover.id = ''
    hideTip()
    return
  }
  if (hover.shownId) {
    placeTip(termEl(hover.shownId))
    markHot(hover.id)
    return
  }
  // 还在等 300ms：术语已经不在鼠标下面就取消
  const el = termEl(hover.id)
  const under = pointer && tipTarget(document.elementFromPoint(pointer.x, pointer.y))
  if (!el || under !== el) {
    clearTimeout(hover.timer)
    hover.id = ''
    markHot('')
  } else markHot(hover.id)
}

function pointerMoved(x, y, target) {
  // 坐标没变的是排版变化引起的，不算移动
  if (pointer && pointer.x === x && pointer.y === y) return
  pointer = { x, y }
  pointAt(target ?? document.elementFromPoint(x, y))
}

function pointerLeft() {
  pointer = null
  clearTimeout(hover.timer)
  hover.id = ''
  if (hover.shownId) hideTip()
  else markHot('')
}

// 字幕窗平时点击穿透。Mac 上不在前台的 panel 窗口收不到转发的 mousemove（只在进出窗口时来一个过时的），
// 所以主进程轮询鼠标位置发 overlay:pointer（窗口内坐标，出了窗口发 null）。有轮询就只用它，两路混用会互相打断。
if (api.onPointer) api.onPointer((p) => (p ? pointerMoved(p.x, p.y) : pointerLeft()))
else {
  document.addEventListener('mousemove', (e) => pointerMoved(e.clientX, e.clientY, e.target))
  document.documentElement.addEventListener('mouseleave', pointerLeft)
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return
  pointer = null
  hover.id = ''
  hideTip()
})

function upsert(seg) {
  if (!seg.text && segments.has(seg.id)) segments.delete(seg.id)
  else if (seg.text) segments.set(seg.id, seg)
  if (segments.size > 40) {
    const oldest = [...segments.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, segments.size - 40)
    for (const s of oldest) segments.delete(s.id)
  }
  if (config.showMic || !isMine(seg)) lastActivity = Date.now()
  render()
}

api.onConfig(applyConfig)
api.onSegment(upsert)
api.onSegments((list) => {
  segments.clear()
  for (const s of list) segments.set(s.id, s)
  lastActivity = list.length ? Date.now() : 0
  render()
})
setInterval(() => {
  if (lastActivity && Date.now() - lastActivity > QUIET_AFTER_MS && !box.classList.contains('quiet')) render()
}, 1000)

// 随时拖动：按住字幕框拖就移动字幕窗；松手后主进程存位置，Mac 上把前台还给原来的应用
window.dragWindow(box, { moveTo: (p) => api.moveTo(p), enabled: () => !config.editMode })
document.addEventListener('pointerup', () => {
  if (!config.editMode) api.released()
})

// 调整位置模式：拖左右边缘改宽度（拖动整个字幕条移动位置由 -webkit-app-region 负责）
document.getElementById('done').addEventListener('click', () => api.doneEditing())
for (const handle of document.querySelectorAll('.handle')) {
  handle.addEventListener('pointerdown', (e) => {
    const side = handle.dataset.side
    const start = { mouse: e.screenX, x: window.screenX, width: window.innerWidth }
    handle.setPointerCapture(e.pointerId)
    const move = (ev) => {
      const dx = ev.screenX - start.mouse
      if (side === 'right') api.setHorizontal({ x: start.x, width: Math.max(320, start.width + dx) })
      else {
        const width = Math.max(320, start.width - dx)
        api.setHorizontal({ x: start.x + start.width - width, width })
      }
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
