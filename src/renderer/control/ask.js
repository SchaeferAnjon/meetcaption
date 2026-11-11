'use strict'
// 问 AI：课上右栏的第三页和课后详情页的「问 AI」标签共用这一个面板。
// 一条对话：问题在右边的气泡里（引用的字幕在气泡上面），回答在左边铺开（先一句要点，再几条，公式用 KaTeX），
// 回答底下是「依据」（时间点一下，字幕回到那一句），再底下是接着问的问法；输入框一直在底下。
// 回答由主进程一点点发来（ask:update），这里只管画；问答存在这节课的 session.asks 里。

/**
 * host：{
 *   mode: 'live' | 'after'，
 *   sessionId()、base()（开课时间）、seg(id)（字幕段，找不到返回 null）、
 *   jump(segId, sen)、openNote(n)、openSlide(file, at)、openPage(matId, n, label)、
 *   elapsed()（课上：已经讲了多久，毫秒）、terms()（课堂笔记里的术语，起手问法用）、onSeen()（回答完了但用户不在这一页）
 * }
 */
function askPanel(host) {
  const live = host.mode === 'live'
  const records = new Map() // id → { rec, me, ai }
  let ready = true
  let reason = ''
  let busy = null // 正在回答的那条的 id
  let quote = null // { segId, sel, text }
  let follow = true
  let alive = true

  const thread = el('div.ask-thread', { dataset: { part: '对话' } })
  const scroller = el('div.ask-scroll', {}, thread)
  const notice = el('div.ask-notice', { hidden: true }) // 已经问过以后 AI 用不了：原因放在输入框上面（还没问过时放在对话区里）
  const quoteBox = el('div.ask-quote-slot')
  const chips = el('div.ask-chips.is-small.ask-ready', { hidden: true })
  const input = el('textarea.ask-input', { rows: 1, placeholder: t('问这节课，比如：H(σ) 到底是什么？'), 'aria-label': t('问 AI'), spellcheck: false })
  const send = el('button.ask-send', { type: 'button', 'aria-label': t('发送'), title: t('发送（↵）') }, icon('arrow-up', 15))
  const hint = el('div.ask-hint', {}, el('span', { text: t('↵ 发送 · ⇧↵ 换行') }), el('span.header-spacer'), el('span.ask-hint-what', { text: live ? t('用这节课的字幕、笔记和截图回答') : t('用整节课的字幕、笔记和课件回答') }))
  const composer = el('div.ask-composer', { dataset: { part: '输入框' } }, notice, quoteBox, chips, el('div.ask-input-row', {}, input, send), hint)
  const root = el('div.ask-body.ask-a', { class: live ? '' : 'is-after' }, scroller, composer)

  // 课上是右栏自己在滚；课后详情页整页在滚，输入框贴在页面底部
  const box = () => (live ? scroller : host.scrollEl())
  const dist = () => box().scrollHeight - box().scrollTop - box().clientHeight
  const scrollEnd = () => (box().scrollTop = box().scrollHeight)
  box().addEventListener('scroll', () => (follow = dist() < 80))

  /* ---------- 时间和引用 ---------- */

  // 字幕段还在就用它的时间；已经不在实时记录里（早先的）就用回答里记下的时间
  const timeOfSeg = (segId, at) => {
    const ms = host.seg(segId)?.startedAt ?? at
    if (ms == null) return ''
    return live ? fmtTime(ms) : fmtOffset(ms - host.base())
  }
  const whenOf = (r) => (r.after ? t('下课后') : live ? fmtTime(r.askedAt) : fmtOffset(r.askedAt - host.base()))

  function quoteNode(q, { onRemove } = {}) {
    const s = host.seg(q.segId)
    const when = timeOfSeg(q.segId, q.at)
    const label = when ? t(`{0} {1}`, when, whoLabel(s ? segWho(s) : 'other', 'class')) : ''
    return el(
      'div.ask-quote',
      { dataset: { part: '引用的字幕' } },
      label ? el('button.ask-quote-time.num', { type: 'button', title: t('回到这句字幕'), text: label, onClick: () => host.jump(q.segId) }) : null,
      el('span.ask-quote-text', { text: q.sel || q.text || s?.text || '' }),
      onRemove ? el('button.ask-quote-x', { type: 'button', 'aria-label': t('不引用这句'), title: t('不引用这句'), onClick: onRemove }, icon('x', 12)) : null,
    )
  }

  function setQuote(q) {
    quote = q ? { segId: q.segId, at: host.seg(q.segId)?.startedAt, sel: q.sel || '', text: q.text || host.seg(q.segId)?.text || '' } : null
    ui.clear(quoteBox)
    if (quote) quoteBox.append(quoteNode(quote, { onRemove: () => (setQuote(null), input.focus()) }))
    input.placeholder = quote ? t('问这一句，直接按 ↵ 就是「这句什么意思」') : t('问这节课，比如：H(σ) 到底是什么？')
    renderReady()
    grow()
  }

  // 引用以后给几个现成的问法，点一下就问，不用打字
  function renderReady() {
    ui.clear(chips)
    chips.hidden = !quote || !ready
    if (chips.hidden) return
    const sel = quote.sel && quote.sel !== quote.text ? (quote.sel.length > 22 ? `${quote.sel.slice(0, 22)}…` : quote.sel) : ''
    const list = sel ? [t(`「{0}」是什么？`, sel), t('它在这里是什么意思？'), t('和前面讲的有什么关系？')] : [t('这句什么意思？'), t('解释里面的术语'), t('老师为什么这么说？')]
    for (const q of list) chips.append(el('button.ask-chip', { type: 'button', onClick: () => submit(q) }, q))
  }

  /* ---------- 一条回答 ---------- */

  const coverText = (r) => {
    const c = r.cover
    if (!c || c.kind === 'full') return ''
    if (c.kind === 'none') return r.after ? t('这节课没讲到，下面按通用知识回答') : t('课上还没讲到，下面按通用知识回答')
    const when = c.segId ? timeOfSeg(c.segId, c.at) : ''
    return when ? t(`老师 {0} 只把它当例子提了一句，没展开；下面按通用知识补充`, when) : t('老师只把它当例子提了一句，没展开；下面按通用知识补充')
  }

  function srcChip(s) {
    if (s.type === 'seg') {
      const seg = host.seg(s.id)
      const when = timeOfSeg(s.id, s.at)
      if (!when) return null
      const sen = (seg?.sentences ?? []).map((x) => x.text).join(' ') || seg?.text || ''
      const tr = (seg?.sentences ?? []).map((x) => x.tr).filter(Boolean).join(' ')
      return el('button.ask-src-chip', { type: 'button', title: [t(`老师 {0}`, when), sen, tr].filter(Boolean).join('\n'), onClick: () => host.jump(s.id) }, el('span.num', { text: when }))
    }
    if (s.type === 'note') {
      const title = String(host.notes?.()?.sections?.[s.n]?.title ?? '').replace(/（.*$/, '')
      return el('button.ask-src-chip', { type: 'button', onClick: () => host.openNote(s.n) }, icon('notebook-pen', 12), el('span', { text: title ? t(`笔记 · {0}`, title) : t('笔记') }))
    }
    if (s.type === 'slide') {
      const when = live ? fmtTime(s.at) : fmtOffset(s.at - host.base())
      return el('button.ask-src-chip', { type: 'button', onClick: () => host.openSlide(s.file, s.at) }, icon('camera', 12), el('span', { text: t(`截图 {0}`, when) }))
    }
    if (s.type === 'page') {
      const label = t(`课件 p.{0}`, s.n)
      return el('button.ask-src-chip', { type: 'button', title: s.name ?? '', onClick: () => host.openPage(s.matId, s.n, label) }, icon('presentation', 12), el('span', { text: label }))
    }
    return null
  }

  const answerText = (r) =>
    [r.gist ? (r.points?.length ? `${r.gist}\n` : r.gist) : '', ...(r.points ?? []).map((p) => (p.tex ? `$$${p.tex}$$` : `- ${p.text}`))].filter(Boolean).join('\n')

  function aiMsg(r) {
    const cover = el('div.ask-cover', { hidden: true, dataset: { part: '课上讲没讲' } })
    const wait = el('div.ask-wait', { text: t('正在看课上讲过的…') })
    const gist = el('div.answer-gist.ask-gist.selectable', { dataset: { part: '要点' } })
    const list = el('div.ask-points.selectable', { dataset: { part: '回答' } })
    const err = el('div.answer-note.is-error.ask-err', { hidden: true })
    const stopped = el('div.ask-stopped', { hidden: true, text: t('已停止') })
    const copy = iconButton('copy', t('复制回答'), () => copyText(answerText(cur), t('回答已复制')))
    copy.classList.add('btn-sm', 'ask-copy')
    const src = el('div.ask-src', { hidden: true, dataset: { part: '依据' } })
    const next = el('div.ask-next', { hidden: true, dataset: { part: '接着问' } })
    const answer = el('div.ask-answer', {}, cover, wait, gist, list, err, stopped, src)
    const node = el('div.ask-msg.is-ai', { dataset: { part: 'AI 的回答', id: r.id } }, answer, next)
    let cur = r

    function update(x) {
      cur = { ...cur, ...x }
      const streaming = cur.status === 'streaming'
      answer.classList.toggle('is-streaming', streaming)
      wait.hidden = !streaming || Boolean(cur.gist) || Boolean(cur.points?.length)
      const ct = coverText(cur)
      cover.hidden = !ct
      if (ct) fill(cover, icon(cur.cover.kind === 'none' ? 'book-open' : 'info', 13), el('span', { text: ct }))
      cover.className = `ask-cover is-${cur.cover?.kind ?? 'full'}`
      if (cur.gist) setMathText(gist, cur.gist)
      gist.hidden = !cur.gist
      gist.classList.toggle('is-typing', streaming && !cur.points?.length)
      syncPoints(list, cur.points ?? [], streaming)
      err.hidden = cur.status !== 'error'
      if (!err.hidden) fill(err, icon('triangle-alert', 14), el('span', { text: cur.error || t('没答完') }), el('button.btn.btn-sm.ask-retry', { type: 'button', onClick: () => retry(cur) }, icon('refresh-cw', 13), t('重试')))
      stopped.hidden = cur.status !== 'stopped'
      const done = cur.status === 'done' || cur.status === 'stopped'
      src.hidden = !done
      if (done && !src.dataset.built) {
        src.dataset.built = '1'
        const chipsList = (cur.src ?? []).map(srcChip).filter(Boolean)
        fill(src, chipsList.length ? el('span.ask-src-label', { text: t('依据') }) : null, ...chipsList, copy)
      }
    }
    update(r)
    return { node, update, next, get rec() { return cur } }
  }

  // 要点后面的几条：按位置对上旧节点，文字没变就不重画（公式不闪）
  function syncPoints(box, points, streaming) {
    while (box.children.length > points.length) box.lastChild.remove()
    points.forEach((p, i) => {
      const text = p.tex ?? p.text
      let row = box.children[i]
      if (row && row.dataset.src === text && Boolean(row.dataset.tex) === Boolean(p.tex)) return
      const made = p.tex != null ? el('div.notes-formula.ask-formula.selectable') : el('div.ask-point', {}, el('span.ask-dot'), el('span.ask-point-text.selectable'))
      made.dataset.src = text
      if (p.tex != null) {
        made.dataset.tex = '1'
        renderFormula(made, window.texfix ? window.texfix.repair(p.tex, { formula: true }) : p.tex)
      } else setMathText(made.lastChild, text)
      if (row) row.replaceWith(made)
      else box.append(made)
      row = made
    })
    for (const [i, row] of [...box.children].entries()) row.classList.toggle('is-last', streaming && i === points.length - 1)
  }

  function meMsg(r) {
    return el('div.ask-msg.is-me', { dataset: { id: r.id } }, el('div.ask-bubble', {}, r.quote ? quoteNode(r.quote) : null, el('div.ask-bubble-text.selectable', { text: r.q })), el('div.ask-msg-at.num', { text: whenOf(r) }))
  }

  /* ---------- 主进程发来的 ---------- */

  function update(a) {
    if (!alive || !a?.id || a.sessionId !== host.sessionId()) return
    let item = records.get(a.id)
    if (!item) {
      clearEmpty()
      removeNext()
      const rec = { ...a }
      item = { rec, me: meMsg(rec), ai: aiMsg(rec) }
      records.set(a.id, item)
      thread.append(item.me, item.ai.node)
      follow = true
    } else item.ai.update(a)
    item.rec = { ...item.rec, ...a }
    if (a.status === 'streaming') busy = a.id
    else if (busy === a.id) busy = null
    if (a.status !== 'streaming') {
      if (a.status === 'done') showNext(item)
      if (!isShown()) host.onSeen?.()
    }
    renderSend()
    if (follow) requestAnimationFrame(scrollEnd)
  }

  const isShown = () => root.offsetParent !== null

  function removeNext() {
    for (const n of thread.querySelectorAll('.ask-next-row')) n.remove()
  }

  function showNext(item) {
    removeNext()
    const list = item.rec.next ?? []
    if (!list.length || !ready) return
    item.ai.node.append(el('div.ask-next.ask-next-row', { dataset: { part: '接着问' } }, list.map((s) => el('button.ask-chip', { type: 'button', onClick: () => submit(s) }, icon('corner-down-left', 12), s))))
  }

  function load(asks) {
    ui.clear(thread)
    records.clear()
    busy = null
    for (const a of [...asks].sort((x, y) => x.askedAt - y.askedAt)) {
      const rec = { ...a, sessionId: host.sessionId() }
      const item = { rec, me: meMsg(rec), ai: aiMsg(rec) }
      records.set(a.id, item)
      thread.append(item.me, item.ai.node)
      if (a.status === 'streaming') busy = a.id
    }
    const last = [...records.values()].at(-1)
    if (last?.rec.status === 'done') showNext(last)
    renderEmpty()
    renderState()
    // 课上：右栏里最新的在底下；课后：整页从头看，不把标签和标题滚走
    if (live) requestAnimationFrame(scrollEnd)
  }

  async function retry(r) {
    const item = records.get(r.id)
    if (!item) return
    item.me.remove()
    item.ai.node.remove()
    records.delete(r.id)
    host.forget?.(r.id)
    renderEmpty()
    await submit(r.q, { quote: r.quote ?? null, replaceId: r.id })
  }

  /* ---------- 提问 ---------- */

  async function submit(text, { quote: q = quote, replaceId = null } = {}) {
    if (!ready || busy) return
    const question = (text ?? input.value).trim() || (q ? (q.sel && q.sel !== q.text ? t(`「{0}」是什么？`, q.sel) : t('这句什么意思？')) : '')
    if (!question) return
    const sent = input.value
    input.value = ''
    const used = q
    setQuote(null)
    grow()
    follow = true
    const r = await call('askStart', { sessionId: host.sessionId(), question, quote: used ? { segId: used.segId, sel: used.sel } : null, replaceId })
    if (!alive) return
    if (failed(r)) {
      if (!text) input.value = sent
      if (used) setQuote(used)
      grow()
      if (r?.code === 'no-ai') {
        ready = false
        reason = r.error || reason
        renderState()
      } else ui.toast({ title: t('没能提问'), message: r?.error, type: 'error' })
    }
  }

  function grow() {
    if (input.offsetParent) {
      input.style.height = 'auto'
      input.style.height = `${Math.min(input.scrollHeight, 132)}px`
    }
    renderSend()
  }

  function renderSend() {
    send.classList.toggle('is-stop', Boolean(busy))
    send.disabled = !ready || (!busy && !input.value.trim() && !quote)
    fill(send, busy ? icon('square', 13) : icon('arrow-up', 15))
    send.title = busy ? t('停止') : t('发送（↵）')
    send.setAttribute('aria-label', busy ? t('停止') : t('发送'))
  }

  input.addEventListener('input', grow)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    }
  })
  send.addEventListener('click', () => (busy ? call('askStop', host.sessionId()) : submit()))

  /* ---------- 空的、用不了 ---------- */

  function clearEmpty() {
    thread.querySelector('.ask-empty')?.remove()
  }

  function noAiNode() {
    const member = state.settings?.plan === 'member'
    return el(
      'div.callout.callout-warn.ask-noai',
      { dataset: { part: 'AI 用不了' } },
      icon('triangle-alert', 16),
      el('div.callout-body', {}, el('div.callout-title', { text: t('问 AI 用不了') }), el('div.callout-desc', { text: reason || t('AI 服务还没设置好') })),
      el('button.btn.btn-sm', { type: 'button', onClick: () => (member ? openPricing() : aiSettings()) }, member ? t('看看场次') : t('去设置')),
    )
  }

  function renderEmpty() {
    if (records.size) return clearEmpty()
    if (thread.querySelector('.ask-empty')) return
    if (!ready) return thread.append(el('div.ask-empty', {}, noAiNode()))
    const early = live && host.elapsed() < 3 * 60_000
    const term = [...(host.terms?.() ?? [])].reverse().find((x) => x?.term)?.term
    const starters = live ? [t('刚才这段讲了什么？'), t('到现在讲了哪些要点？')] : [t('这节课讲了哪些要点？'), t('老师强调了什么？')]
    if (term) starters.push(t(`老师说的 {0} 是什么？`, term))
    thread.append(
      el(
        'div.ask-empty',
        { dataset: { part: '空的时候' } },
        el('div.ask-empty-icon', {}, icon('message-circle-question', 18)),
        el('div.ask-empty-title', { text: t('没听懂就问') }),
        el('div.ask-empty-desc', { text: early ? t('老师才讲了几分钟，课上的内容还少。现在问，AI 会多用通用知识，并在回答里标出来。') : live ? t('AI 会结合老师刚才讲的、实时笔记和截图来答。回答里的时间点一下，左边就回到那句字幕。') : t('AI 会结合整节课的字幕、实时笔记、课堂笔记和课件来答。回答里的时间点一下，就打开字幕记录里那一句。') }),
        el('div.ask-empty-tip', {}, icon('captions', 13), el('span', { text: t('也可以在字幕里选中几个词，或者把鼠标移到一句上点「问」。') })),
        el('div.ask-chips', {}, starters.map((s) => el('button.ask-chip', { type: 'button', onClick: () => submit(s, { quote: null }) }, s))),
      ),
    )
  }

  function renderState() {
    root.classList.toggle('is-off', !ready)
    input.disabled = !ready
    if (!ready) input.placeholder = t('AI 用不了，接上以后就能问')
    else input.placeholder = quote ? t('问这一句，直接按 ↵ 就是「这句什么意思」') : t('问这节课，比如：H(σ) 到底是什么？')
    const empty = thread.querySelector('.ask-empty')
    if (empty && !records.size) {
      empty.remove()
      renderEmpty()
    }
    notice.hidden = ready || !records.size
    if (!notice.hidden) fill(notice, noAiNode())
    for (const n of thread.querySelectorAll('.ask-next-row')) n.hidden = !ready
    renderReady()
    renderSend()
  }

  /** 现在能不能问：向主进程要（课上走这一场的票，下课后走会后的凭据，自带 Key 一直能问）。 */
  async function refreshStatus() {
    const r = await call('askStatus', host.sessionId())
    if (!alive || failed(r) || !r) return
    const next = r.ready !== false
    if (next === ready && (r.reason ?? '') === reason) return
    ready = next
    reason = r.reason ?? ''
    renderState()
  }

  renderEmpty()
  renderSend()
  refreshStatus()

  return {
    root,
    update,
    load,
    refreshStatus,
    quote: (q) => (setQuote(q), input.focus({ preventScroll: true })),
    focus: () => (grow(), input.focus({ preventScroll: true })),
    scrollEnd: () => requestAnimationFrame(scrollEnd),
    busy: () => busy,
    count: () => records.size,
    destroy: () => (alive = false),
  }
}

/**
 * 字幕里的「问」：鼠标移到一句上，右上角出现「问」；选中几个词，上方浮出「问 AI」。
 * container 是装着 .tline[data-id] 的那一块；onAsk({ segId, sel }) 引用这一句（sel 是选中的词，整句时为空）。
 * → 取消的函数
 */
function wireAskTranscript(container, onAsk) {
  let pop = null
  const hide = () => (pop?.remove(), (pop = null))
  const lineOf = (n) => n?.parentElement?.closest?.('.tline[data-id]') ?? null
  const add = () => {
    for (const line of container.querySelectorAll('.tline[data-id]:not(.tline-slide)')) {
      if (line.querySelector('.ask-line-btn')) continue
      line.append(
        el('button.ask-line-btn', { type: 'button', title: t('问 AI 这一句'), 'aria-label': t('问 AI 这一句'), dataset: { part: '字幕行上的问' }, onClick: (e) => (e.stopPropagation(), onAsk({ segId: line.dataset.id, sel: '' })) }, icon('message-circle-question', 14), el('span', { text: t('问') })),
      )
    }
  }
  const onUp = () =>
    setTimeout(() => {
      const sel = window.getSelection()
      const text = String(sel ?? '').replace(/\s+/g, ' ').trim()
      hide()
      if (!text || text.length > 300 || !sel.rangeCount) return
      const range = sel.getRangeAt(0)
      const line = lineOf(range.startContainer) ?? lineOf(range.commonAncestorContainer)
      if (!line || !container.contains(line)) return
      pop = el('button.ask-sel', { type: 'button', dataset: { part: '选中后问 AI' }, onMousedown: (e) => e.preventDefault(), onClick: () => (hide(), onAsk({ segId: line.dataset.id, sel: text })) }, icon('message-circle-question', 14), t('问 AI'))
      document.body.append(pop)
      place()
    }, 0)
  // 选中的词上方：实时记录一直在往下滚（新字幕来了），按动了的位置跟着挪；选的词滚出了视野或选区没了才收起
  const place = () => {
    if (!pop) return
    const sel = window.getSelection()
    if (!sel?.rangeCount || !String(sel).trim()) return hide()
    const r = sel.getRangeAt(0).getBoundingClientRect()
    const box = (container.closest('.pane-body') ?? container).getBoundingClientRect()
    if (r.bottom < box.top + 4 || r.top > box.bottom - 4) return hide()
    pop.style.left = `${Math.max(8, Math.round(r.left + r.width / 2 - pop.offsetWidth / 2))}px`
    pop.style.top = `${Math.max(8, Math.round(r.top - pop.offsetHeight - 6))}px`
  }
  const onDown = (e) => {
    if (!e.target.closest?.('.ask-sel')) hide()
  }
  container.addEventListener('mouseup', onUp)
  document.addEventListener('mousedown', onDown)
  const scrollParent = container.closest('.pane-body')
  scrollParent?.addEventListener('scroll', place)
  add()
  const mo = new MutationObserver(add)
  mo.observe(container, { childList: true })
  return () => {
    mo.disconnect()
    hide()
    container.removeEventListener('mouseup', onUp)
    document.removeEventListener('mousedown', onDown)
    scrollParent?.removeEventListener('scroll', place)
  }
}

/** 点时间回到的那句：亮一下再淡掉 */
function flashLine(line, sen) {
  line.classList.remove('ask-flash')
  void line.offsetWidth
  line.classList.add('ask-flash')
  setTimeout(() => line.classList.remove('ask-flash'), 2700)
  const pair = Number.isInteger(sen) ? line.querySelectorAll('.tline-pair')[sen] : null
  if (pair) {
    pair.classList.add('ask-flash-pair')
    setTimeout(() => pair.classList.remove('ask-flash-pair'), 2700)
  }
}
