'use strict'
// 实时笔记：小节大纲（可折叠）、强调、待办、术语，四块的标题按模式换（课堂、会议、面试）。开会时右栏用，会议详情的「实时笔记」页也用它。
// 主进程每次发完整的新版（notes:update）；这里按条目的文字对上旧节点，只换变了的，新条目淡入，整块不重画、不跳。

/** 按 key 对齐子节点：同 key 的节点复用（update 刷新内容），新的 create 出来加淡入，多余的删掉。 */
function syncKeyed(container, items, { key, create, update, fresh }) {
  const old = new Map()
  for (const n of container.children) if (n.dataset.key != null) old.set(n.dataset.key, n)
  const wanted = []
  const seen = new Set()
  for (const it of items) {
    let k = key(it)
    while (seen.has(k)) k += '\u0001' // 同样的文字出现两次也各算一条
    seen.add(k)
    let n = old.get(k)
    if (n) {
      old.delete(k)
      update?.(n, it)
    } else {
      n = create(it)
      n.dataset.key = k
      if (fresh) {
        n.classList.add('is-new')
        n.addEventListener('animationend', () => n.classList.remove('is-new'), { once: true })
      }
    }
    wanted.push(n)
  }
  for (const n of old.values()) n.remove()
  let cur = container.firstChild
  for (const n of wanted) {
    if (n === cur) cur = cur.nextSibling
    else container.insertBefore(n, cur)
  }
}

const normKey = (tv) => String(tv ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const setText = (n, tv) => {
  const v = String(tv ?? '')
  if (n.textContent !== v) n.textContent = v
}

// 同一份 JSON 在三种模式下的含义：课堂是大纲、老师强调、作业；会议是议题、结论、待办；面试是问过的问题、面试官在意的点、后续要做的事
const NOTES_LABELS = {
  class: { outline: t('大纲'), emph: t('老师强调和可能考的点'), hw: t('作业和要做的事'), empty: t('老师讲一会儿后，AI 会把要点整理在这里。') },
  meeting: { outline: t('议题'), emph: t('结论和决定'), hw: t('待办'), empty: t('开会一会儿后，AI 会把议题、结论和待办整理在这里。') },
  interview: { outline: t('问过的问题'), emph: t('面试官在意的点'), hw: t('面试后要做的事'), empty: t('面试一会儿后，AI 会把问过的问题和你答的要点整理在这里。') },
}

function notesList(v) {
  return Array.isArray(v) ? v.filter((x) => x != null && x !== '') : []
}

/** 一句笔记文字：$…$ 和没包 $ 的 \lambda、\hat{\theta} 用 KaTeX 画成行内公式（core.js 的 renderTex），其余是纯文字。 */
function setMathText(n, tv) {
  const v = String(tv ?? '')
  if (n.dataset.src === v) return
  n.dataset.src = v
  const parts = window.texfix ? window.texfix.split(v) : [{ text: v }]
  if (!parts.some((p) => p.tex != null)) {
    n.textContent = parts.map((p) => p.text).join('')
    return
  }
  n.replaceChildren(
    ...parts.map((p) => {
      if (p.tex == null) return p.text
      const box = document.createElement('span')
      renderTex(box, p.tex, false)
      return box
    }),
  )
}

/**
 * 实时笔记块。→ { root, update(notes, { updatedAt, error }) }
 * opts：mode（class | meeting | interview，或者返回它的函数，开会中换了模式标题跟着变）、emptyText（还没有笔记时的说明）、
 * collapseOld（小节多时旧的先收起，开会时用）
 */
function notesView(opts = {}) {
  const collapsed = new Map() // 小节 key → true / false（用户点过的）
  let first = true
  const labels = () => NOTES_LABELS[typeof opts.mode === 'function' ? opts.mode() : opts.mode] ?? NOTES_LABELS.class

  const outlineList = el('div.notes-sections')
  const toggleAll = el('button.btn.btn-ghost.btn-sm.notes-toggle-all', { type: 'button' })
  const outline = el('section.notes-block', {}, el('div.notes-head', {}, icon('list-tree', 14), el('span.notes-title'), el('span.count.num'), el('span.header-spacer'), toggleAll), outlineList)
  const emphList = el('ul.notes-items')
  const emph = el('section.notes-block.notes-emph', {}, el('div.notes-head', {}, icon('flag', 14), el('span.notes-title'), el('span.count.num')), emphList)
  const hwList = el('ul.notes-items')
  const hw = el('section.notes-block.notes-hw', {}, el('div.notes-head', {}, icon('clipboard-list', 14), el('span.notes-title'), el('span.count.num')), hwList)
  const termList = el('div.notes-terms')
  const terms = el('section.notes-block.notes-termblock', { 'aria-label': t('术语') }, el('div.notes-head', {}, icon('book-open', 14), el('span', { text: t('术语') }), el('span.count.num')), termList)
  const empty = el('div.notes-empty')
  const root = el('div.notes', {}, empty, emph, hw, outline, terms)
  const stopTips = ui.tipDelegate(termList, '.notes-term', (tv) => ({ title: tv.dataset.title, text: tv.dataset.explain }), { placement: 'top' })

  toggleAll.addEventListener('click', () => {
    const secs = [...outlineList.children]
    const anyOpen = secs.some((n) => !n.classList.contains('is-collapsed'))
    for (const n of secs) setCollapsed(n, anyOpen)
    renderToggleAll()
  })

  function renderToggleAll() {
    const secs = [...outlineList.children]
    const anyOpen = secs.some((n) => !n.classList.contains('is-collapsed'))
    fill(toggleAll, icon(anyOpen ? 'chevrons-down-up' : 'chevrons-up-down', 13), anyOpen ? t('全部收起') : t('全部展开'))
    toggleAll.hidden = secs.length < 2
  }

  function setCollapsed(n, on) {
    n.classList.toggle('is-collapsed', on)
    n.querySelector('.notes-sec-head')?.setAttribute('aria-expanded', String(!on))
    collapsed.set(n.dataset.key, on)
  }

  function sectionNode(sec) {
    const head = el(
      'button.notes-sec-head',
      { type: 'button', 'aria-expanded': 'true' },
      el('span.notes-chevron', {}, icon('chevron-down', 13)),
      el('span.notes-sec-title'),
      el('span.notes-sec-time.num'),
    )
    const body = el('div.notes-sec-body', {}, el('ul.notes-points'), el('div.notes-formulas'), el('ul.notes-examples'))
    const n = el('div.notes-sec', {}, head, body)
    head.addEventListener('click', () => {
      setCollapsed(n, !n.classList.contains('is-collapsed'))
      renderToggleAll()
    })
    return n
  }

  function fillSection(n, sec, fresh) {
    setMathText(n.querySelector('.notes-sec-title'), sec.title || t('（没有标题）'))
    setText(n.querySelector('.notes-sec-time'), sec.start || '')
    const li = (cls) => (tv) => {
      const node = el(cls, { class: 'selectable' })
      setMathText(node, tv)
      return node
    }
    syncKeyed(n.querySelector('.notes-points'), notesList(sec.points).map(String), { key: normKey, create: li('li.notes-point'), update: setMathText, fresh })
    // 公式用 KaTeX 画（core.js 的 renderFormula），画不了退回等宽原文；老版本存下的笔记里被 JSON 转义吃掉的反斜杠先还原
    const formula = (node, tex) => {
      if (node.dataset.tex === tex) return
      node.dataset.tex = tex
      renderFormula(node, window.texfix ? window.texfix.repair(tex, { formula: true }) : tex)
    }
    const newFormula = (tex) => {
      const node = el('div.notes-formula.selectable')
      formula(node, tex)
      return node
    }
    syncKeyed(n.querySelector('.notes-formulas'), notesList(sec.formulas).map(String), { key: normKey, create: newFormula, update: formula, fresh })
    const example = (node, tv) => setMathText(node.querySelector('.notes-ex-text'), tv)
    const newExample = (tv) => {
      const node = el('li.notes-example.selectable', {}, el('span.notes-ex-mark', { text: t('例') }), el('span.notes-ex-text'))
      example(node, tv)
      return node
    }
    syncKeyed(n.querySelector('.notes-examples'), notesList(sec.examples).map(String), { key: normKey, create: newExample, update: example, fresh })
  }

  function emphNode() {
    return el('li.notes-item', {}, el('div.notes-item-text.selectable'), el('div.notes-item-meta'))
  }
  function fillEmph(n, e) {
    setMathText(n.querySelector('.notes-item-text'), e.text)
    const meta = n.querySelector('.notes-item-meta')
    const sig = JSON.stringify([e.at, e.quote])
    if (meta.dataset.sig === sig) return
    meta.dataset.sig = sig
    ui.clear(meta)
    if (e.at) meta.append(el('span.num.notes-at', { text: e.at }))
    if (e.quote) meta.append(el('span.notes-quote.selectable', { text: `“${e.quote}”` }))
    meta.hidden = !e.at && !e.quote
  }

  function hwNode() {
    return el('li.notes-item', {}, el('div.notes-item-text.selectable'), el('div.notes-item-meta'))
  }
  function fillHw(n, h) {
    setMathText(n.querySelector('.notes-item-text'), h.text)
    const meta = n.querySelector('.notes-item-meta')
    const sig = JSON.stringify([h.due, h.dueText])
    if (meta.dataset.sig === sig) return
    meta.dataset.sig = sig
    ui.clear(meta)
    const due = dueInfo(h.due)
    if (due) meta.append(el('span.tag', { dataset: due.tint ? { tint: due.tint } : undefined, text: due.label, title: due.title }))
    if (h.dueText) meta.append(el('span.notes-quote', { text: t(`原话：{0}`, h.dueText) }))
    meta.hidden = !due && !h.dueText
  }

  function termNode() {
    return el('span.notes-term', { tabindex: '0' }, el('span.notes-term-en'), el('span.notes-term-zh'))
  }
  function fillTerm(n, tv) {
    const zh = tv.zh && String(tv.zh).toLowerCase() !== String(tv.term).toLowerCase() ? tv.zh : ''
    setText(n.querySelector('.notes-term-en'), tv.term)
    setText(n.querySelector('.notes-term-zh'), zh)
    n.dataset.title = zh ? `${tv.term} · ${zh}` : tv.term
    n.dataset.explain = tv.explain || ''
  }

  const count = (block, n) => setText(block.querySelector('.notes-head .count'), n ? String(n) : '')

  function renderTitles() {
    const l = labels()
    for (const [block, text] of [
      [outline, l.outline],
      [emph, l.emph],
      [hw, l.hw],
    ]) {
      setText(block.querySelector('.notes-title'), text)
      block.setAttribute('aria-label', text)
    }
  }

  function update(notes) {
    const fresh = !first // 第一次画出来不闪，之后新增的条目淡入
    renderTitles()
    const secs = notesList(notes?.sections).filter((x) => typeof x === 'object')
    const emphItems = notesList(notes?.emphasis).map((x) => (typeof x === 'string' ? { text: x } : x)).filter((x) => x?.text)
    const hwItems = notesList(notes?.homework).map((x) => (typeof x === 'string' ? { text: x } : x)).filter((x) => x?.text)
    const termItems = notesList(notes?.terms).filter((x) => x?.term)

    syncKeyed(outlineList, secs, {
      key: (s) => normKey(s.title || s.start),
      create: (s) => {
        const n = sectionNode(s)
        fillSection(n, s, false)
        return n
      },
      update: (n, s) => fillSection(n, s, fresh),
      fresh,
    })
    // 小节多了：用户没动过的旧小节先收起，只留最后两节展开
    const all = [...outlineList.children]
    all.forEach((n, i) => {
      const k = n.dataset.key
      if (collapsed.has(k)) n.classList.toggle('is-collapsed', collapsed.get(k))
      else n.classList.toggle('is-collapsed', Boolean(opts.collapseOld) && all.length > 3 && i < all.length - 2)
      n.querySelector('.notes-sec-head').setAttribute('aria-expanded', String(!n.classList.contains('is-collapsed')))
    })
    renderToggleAll()
    syncKeyed(emphList, emphItems, {
      key: (e) => normKey(e.text),
      create: (e) => {
        const n = emphNode()
        fillEmph(n, e)
        return n
      },
      update: fillEmph,
      fresh,
    })
    syncKeyed(hwList, hwItems, {
      key: (h) => normKey(h.text),
      create: (h) => {
        const n = hwNode()
        fillHw(n, h)
        return n
      },
      update: fillHw,
      fresh,
    })
    syncKeyed(termList, termItems, {
      key: (tv) => normKey(tv.term),
      create: (tv) => {
        const n = termNode()
        fillTerm(n, tv)
        return n
      },
      update: fillTerm,
      fresh,
    })
    count(outline, secs.length)
    count(emph, emphItems.length)
    count(hw, hwItems.length)
    count(terms, termItems.length)
    outline.hidden = !secs.length
    emph.hidden = !emphItems.length
    hw.hidden = !hwItems.length
    terms.hidden = !termItems.length
    const has = secs.length || emphItems.length || hwItems.length || termItems.length
    empty.hidden = Boolean(has)
    if (!has) {
      const text = typeof opts.emptyText === 'function' ? opts.emptyText() : opts.emptyText
      ui.clear(empty).append(ui.emptyState({ icon: 'notebook-pen', title: t('还没有笔记'), description: text || labels().empty }))
    }
    if (notes) first = false
  }

  update(null)
  return { root, update, destroy: stopTips }
}
