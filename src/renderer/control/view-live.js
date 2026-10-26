'use strict'
// 会议进行中：顶部项目、计时、停止；下面一条音量和字幕窗控制；左边实时记录。
// 右栏两页：实时笔记（课堂是大纲、强调、作业；会议是议题、结论、待办；面试是问过的问题和要点）和 AI 回答（和悬浮答题框同步，最新在上）。
// 面试先看 AI 回答，会议和课堂先看实时笔记。
// 开会时收到的字幕、回答、笔记、截图存在 state.live 里，切到别的视图再回来还在。

const ANSWERS_SHOWN = 12

// 点的这一句自己的回答：segIds 最后一段是被问的那句，前面是带进去的铺垫。
// 按快捷键答的那次可能把前一个问题也带上（Bob 那句 + 最大风险那句），不能当成 Bob 那句的回答。多条取最新的
function answerOfSeg(answers, segId) {
  return answers.filter((a) => a.segIds?.at(-1) === segId).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ?? null
}

VIEWS.live = {
  mount(ctx) {
    const header = () => renderLiveHeader(ctx)
    const mode = () => liveMode()
    const isClass = () => mode() === 'class'

    // 音量和字幕窗控制
    const meterOther = el('div.meter.meter-other', {}, el('i'))
    const meterMe = el('div.meter.meter-me', {}, el('i'))
    const otherLabel = el('span')
    const meLabel = el('span')
    const otherIcon = el('span.live-meter-icon')
    const meIcon = el('span.live-meter-icon')
    const otherMeter = el('div.live-meter', {}, otherIcon, otherLabel, meterOther)
    const meMeter = el('div.live-meter', {}, meIcon, meLabel, meterMe)
    // 会上换麦克风：显示正在用的那个，点开列出电脑上的麦克风
    const micBtn = el('button.btn.btn-sm.btn-ghost.live-mic', { type: 'button', title: t('换麦克风'), onClick: () => pickMic(micBtn) })
    const meters = el('div.live-meters', {}, otherMeter, meMeter, micBtn)
    const captureBtn = el('button.btn.btn-sm.live-capture', { type: 'button', onClick: () => capture() })
    const toggleBtn = el('button.btn.btn-sm', { type: 'button', onClick: () => call('toggleOverlay') })
    const editBtn = el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => call('editOverlay', !state.overlay.editMode) })
    const moreBtn = iconButton('ellipsis', t('字幕窗的更多操作'), () =>
      ui.menu(
        moreBtn,
        [
          { label: t('恢复字幕和答题框的默认位置'), icon: 'refresh-cw', onSelect: () => call('resetOverlayPosition').then(() => ui.toast({ title: t('已回到默认位置'), type: 'success' })) },
          { label: t('字幕与答题框设置…'), icon: 'captions', onSelect: () => openSettings('overlay') },
          { label: t('AI 答题设置…'), icon: 'sparkles', onSelect: () => openSettings('assist') },
          isClass() && { label: t('课堂设置…'), icon: 'graduation-cap', onSelect: () => openSettings('class') },
        ].filter(Boolean),
        { align: 'end' },
      ),
    )
    moreBtn.classList.add('btn-sm')
    const askBtn = el('button.btn.btn-sm', { type: 'button', onClick: () => ask(askBtn) })
    const askVr = el('span.vr.live-vr')
    const bar = el('div.live-bar', {}, meters, el('span.header-spacer'), captureBtn, toggleBtn, editBtn, moreBtn, askVr, askBtn)
    const summaryLine = el('div.live-summary.text-2')

    // 实时记录（字幕和课堂截图按时间排在一起）
    const list = el('div.transcript.live-transcript', { role: 'log', 'aria-live': 'off', 'aria-label': t('实时记录') })
    const empty = el('div.live-empty')
    const scroller = el('div.pane-body.live-scroll', { tabindex: '0' }, empty, list)
    const jump = el('button.btn.btn-sm.jump-latest', { type: 'button', hidden: true, onClick: () => ((scroller.scrollTop = scroller.scrollHeight), (jump.hidden = true)) }, icon('chevron-down', 14), t('回到最新'))
    const left = el('div.live-left', {}, scroller, jump)

    // 右栏：AI 回答
    const answerList = el('div.answer-list')
    const answerEmpty = el('div.answer-empty')
    const answerNote = el('div.answer-note-line', { hidden: true })
    const answerCount = el('span.count.num')
    // 会开完了顶上那条就收起来，「让 AI 回答」挪到这里（会后按快捷键也能答刚才那场会的问题）
    const askAfter = el('button.btn.btn-sm.btn-ghost', { type: 'button', hidden: true, onClick: () => ask(askAfter) }, icon('sparkles', 14), t('让 AI 回答'))
    const answersBody = el('div.pane-body.answer-scroll', {}, answerNote, answerEmpty, answerList)

    // 右栏：实时笔记
    const every = () => state.settings?.class?.notesEveryMin ?? 2
    const notesWhat = { class: t('老师讲大约 {n} 分钟后，AI 把要点、公式、老师强调的考点和作业整理在这里'), meeting: t('开会大约 {n} 分钟后，AI 把议题、结论和待办整理在这里'), interview: t('面试大约 {n} 分钟后，AI 把问过的问题、你答的要点和面试官在意的地方整理在这里') }
    const notes = notesView({ mode, collapseOld: true, emptyText: () => t(`{0}，之后每 {1} 分钟更新一次。`, (notesWhat[mode()] ?? notesWhat.meeting).replace('{n}', every()), every()) })
    const notesLine = el('div.notes-line', { hidden: true })
    const notesBody = el('div.pane-body.notes-scroll', {}, notesLine, notes.root)
    ctx.dispose(notes.destroy)

    // 右栏的头：「实时笔记 | AI 回答」两页；答题关着时只有实时笔记
    const firstTab = () => (mode() === 'interview' ? 'answers' : 'notes')
    let sideTab = firstTab()
    const tabNotes = el('button.side-tab', { type: 'button', role: 'tab', onClick: () => setSide('notes') }, icon('notebook-pen', 14), t('实时笔记'))
    const tabAnswers = el('button.side-tab', { type: 'button', role: 'tab', onClick: () => setSide('answers') }, icon('sparkles', 14), t('AI 回答'), answerCount)
    const notesStamp = el('span.side-stamp.num')
    const sideHead = el('div.pane-subheader.side-head', { role: 'tablist' }, tabNotes, tabAnswers, el('span.header-spacer'), notesStamp, askAfter)
    const side = el('aside.live-answers', { 'aria-label': t('右栏') }, sideHead, notesBody, answersBody)
    const split = el('div.live-split', {}, left, side)
    ctx.body.append(bar, summaryLine, split)

    const nodes = new Map() // 段落 id → 行
    const slideNodes = new Set()
    const cards = new Map()
    let hoveringTerm = false
    let unseenAnswers = 0
    ctx.dispose(wireTerms(list))
    list.addEventListener('mouseover', (e) => (hoveringTerm = Boolean(e.target.closest?.(window.bilingual.TIP_SELECTOR))))
    list.addEventListener('mouseleave', () => (hoveringTerm = false))
    scroller.addEventListener('scroll', () => {
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60) jump.hidden = true
    })

    function setSide(t) {
      sideTab = t
      if (t === 'answers') unseenAnswers = 0
      renderSide()
    }

    function renderSide() {
      const assistOn = state.settings?.assist?.enabled !== false
      const tab = assistOn ? sideTab : 'notes'
      tabAnswers.hidden = !assistOn
      tabNotes.setAttribute('aria-selected', String(tab === 'notes'))
      tabAnswers.setAttribute('aria-selected', String(tab === 'answers'))
      tabAnswers.classList.toggle('has-unseen', unseenAnswers > 0 && tab !== 'answers')
      notesBody.hidden = tab !== 'notes'
      answersBody.hidden = tab !== 'answers'
      notesStamp.hidden = tab !== 'notes' || !state.live?.notesAt
      if (!notesStamp.hidden) notesStamp.textContent = t(`{0} 更新`, fmtTime(state.live.notesAt))
    }

    function renderMeters() {
      const live = state.live
      const cls = isClass()
      const src = live?.classSource ?? 'mic'
      const s = state.settings ?? {}
      // 课堂教室现场：麦克风是主声源（老师）；网课：电脑声音是老师
      fill(otherIcon, icon(cls && src === 'system' ? 'monitor' : 'volume-2', 14))
      fill(meIcon, icon('mic', 14))
      otherLabel.textContent = cls ? (src === 'system' ? t('网课') : t('电脑')) : t('对方')
      meLabel.textContent = cls && src === 'mic' ? t('教室') : t('我')
      otherMeter.title = t(`{0}的音量`, otherLabel.textContent)
      meMeter.title = t(`{0}的音量`, meLabel.textContent)
      otherMeter.hidden = cls && src === 'mic'
      meMeter.hidden = !(cls && src === 'mic') && s.captureMic === false
      const mic = state.devices?.mic
      micBtn.hidden = meMeter.hidden || !mic || state.engine.paused
      if (!micBtn.hidden) fill(micBtn, el('span.truncate', { text: mic.label || t('系统默认麦克风') }), icon('chevron-down', 12))
    }

    function renderBar() {
      const s = state.settings ?? {}
      const live = state.live
      const on = running() || state.engine.state === 'starting'
      bar.hidden = !on
      askAfter.hidden = on || !live?.ended || s.assist?.enabled === false
      meters.hidden = !on
      renderMeters()
      const ov = state.overlay
      toggleBtn.hidden = !on
      editBtn.hidden = !on && !ov.editMode
      moreBtn.hidden = !on
      captureBtn.hidden = !on || !isClass()
      const slideKey = s.class?.hotkeySlide
      fill(captureBtn, icon('camera', 14), t('截取画面'), slideKey ? kbd(slideKey, { size: 'sm' }) : null)
      fill(toggleBtn, icon(ov.visible ? 'eye-off' : 'eye', 14), ov.visible ? t('隐藏字幕') : t('显示字幕'), state.hotkey.accel ? kbd(state.hotkey.accel, { size: 'sm' }) : null)
      fill(editBtn, icon(ov.editMode ? 'check' : 'monitor', 14), ov.editMode ? t('完成调整') : t('调整位置'))
      editBtn.classList.toggle('btn-ghost', !ov.editMode)
      const assistOn = s.assist?.enabled !== false
      askBtn.hidden = !assistOn
      askVr.hidden = !assistOn || !on
      fill(askBtn, icon('sparkles', 14), t('让 AI 回答'), s.assist?.hotkeyAsk && state.hotkey.ask?.accel ? kbd(s.assist.hotkeyAsk, { size: 'sm' }) : null)
      if (!on) for (const m of [meterOther, meterMe]) m.style.setProperty('--value', '0%')
      renderSide()
    }

    function renderSummary() {
      const live = state.live
      summaryLine.hidden = !live?.ended
      if (!live?.ended) return
      const segs = [...live.segs.values()].filter((x) => x.text)
      const bits = [live.endedAt && live.startedAt ? fmtDuration(live.endedAt - live.startedAt) : null, t(`{0} 段字幕`, segs.length), live.slides?.length ? t(`{0} 张截图`, live.slides.length) : null, live.answers.size ? t(`{0} 条 AI 回答`, live.answers.size) : null]
      const after = isClass() ? t('生成课堂笔记时 AI 会整理出大纲、公式、考点和作业。') : t('生成纪要时 AI 会整理出要点、待办和 DDL。')
      fill(summaryLine, icon('circle-check', 14), t(`已保存到「{0}」：{1}。{2}`, projectName(live.projectId), bits.filter(Boolean).join(t('，')), after))
    }

    function renderEmpty() {
      ui.clear(empty)
      const cls = isClass()
      empty.append(
        ui.emptyState({
          icon: cls ? 'graduation-cap' : 'captions',
          title: cls ? t('等老师开讲') : t('等对方开口'),
          description: cls
            ? t('识别出来的字幕会出现在这里，每句原文下面紧跟译文，同一种颜色是对应的意思。网课的课件可以点「截取画面」存下来。')
            : t('识别出来的字幕会出现在这里。每句原文下面紧跟译文，同一种颜色是对应的意思；提问句标黄，专业术语悬停看解释。'),
        }),
      )
      empty.hidden = nodes.size + slideNodes.size > 0
    }

    const segOpts = () => ({ mode: mode() })
    const slideOpts = () => ({ dir: state.live?.dir, startedAt: state.live?.startedAt })

    // 按时间把节点插到对的位置（截图可能比正在说的那句早一点）
    function insertByTime(n) {
      const t = Number(n.dataset.t)
      let after = list.lastElementChild
      while (after && Number(after.dataset.t) > t) after = after.previousElementSibling
      if (!after) list.prepend(n)
      else after.after(n)
    }

    // 点提问句：句子下面展开一个小框显示这句的 AI 回答，没答过（或上次失败）就现在答；再点一次收起。
    // 框挂在句子节点里，字幕滚动不受影响；句子节点被换掉（译文到了、重画）时挪到新节点上。
    const qBoxes = new Map() // segId → { root, body, card }

    const answerFor = (segId) => answerOfSeg(state.live ? [...state.live.answers.values()] : [], segId)

    function attachQBox(segId) {
      const b = qBoxes.get(segId)
      const main = nodes.get(segId)?.querySelector('.tline-main')
      if (b && main && b.root.parentNode !== main) main.append(b.root)
    }

    function fillQBox(b, a) {
      if (!b.card) {
        b.card = answerCard(a, { live: true })
        b.body.replaceChildren(b.card.root)
      } else b.card.update(a)
    }

    async function toggleQuestion(segId) {
      const open = qBoxes.get(segId)
      if (open) {
        open.root.remove()
        qBoxes.delete(segId)
        return
      }
      const body = el('div.qbox-body', {}, el('div.qbox-wait', {}, el('span.spinner'), el('span', { text: t('正在回答这句…') })))
      const close = iconButton('x', t('收起回答'), () => toggleQuestion(segId))
      close.classList.add('btn-sm')
      const b = { root: el('div.qbox', {}, el('div.qbox-head', {}, icon('sparkles', 13), el('span', { text: t('AI 回答') }), el('span.header-spacer'), close), body), body, card: null }
      qBoxes.set(segId, b)
      attachQBox(segId)
      const have = answerFor(segId)
      if (have && !have.error && !have.cancelled) return fillQBox(b, have)
      const r = await call('askSegment', segId)
      if (!ctx.alive() || qBoxes.get(segId) !== b) return
      if (failed(r)) body.replaceChildren(el('div.answer-note.is-error', { text: r?.error || t('没能开始回答') }))
    }

    list.addEventListener('click', (e) => {
      const line = e.target.closest('.tline.is-question')
      if (!line || e.target.closest('.qbox, button, a, .term, .fix')) return
      if (String(window.getSelection?.() ?? '').trim()) return // 在选文字，不算点
      toggleQuestion(line.dataset.id)
    })

    function renderAll() {
      ui.clear(list)
      nodes.clear()
      slideNodes.clear()
      const segs = state.live ? [...state.live.segs.values()] : []
      const items = segs.map((seg) => ({ t: seg.startedAt ?? 0, seg }))
      for (const sl of state.live?.slides ?? []) items.push({ t: slideTime(sl, state.live.startedAt), slide: sl })
      items.sort((a, b) => a.t - b.t)
      for (const it of items) {
        if (it.seg) {
          const n = lineNode(it.seg, null, segOpts())
          nodes.set(it.seg.id, n)
          list.append(n)
        } else {
          const n = slideNode(it.slide, slideOpts())
          slideNodes.add(n)
          list.append(n)
        }
      }
      for (const id of qBoxes.keys()) attachQBox(id)
      renderEmpty()
      requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight))
    }

    function onSegment(seg) {
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
      const old = nodes.get(seg.id)
      if (!seg.text) {
        old?.remove()
        nodes.delete(seg.id)
        empty.hidden = nodes.size + slideNodes.size > 0
        return
      }
      const n = lineNode(seg, null, segOpts())
      if (old) old.replaceWith(n)
      else list.append(n)
      nodes.set(seg.id, n)
      attachQBox(seg.id)
      while (nodes.size > 600) {
        const [id, first] = nodes.entries().next().value
        first.remove()
        nodes.delete(id)
      }
      empty.hidden = true
      if (nearBottom && !hoveringTerm) scroller.scrollTop = scroller.scrollHeight
      else if (!old && !nearBottom) jump.hidden = false
    }

    function onSlide(slide) {
      const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
      const n = slideNode(slide, slideOpts())
      slideNodes.add(n)
      insertByTime(n)
      empty.hidden = true
      if (nearBottom) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight))
      renderSummary()
    }

    function renderNotes() {
      const live = state.live
      notes.update(live?.notes ?? null)
      const err = live?.notesError
      notesLine.hidden = !err
      notesLine.className = 'notes-line is-warn'
      // 主进程的 error 已经是完整的一句（实时笔记这次没更新：原因 / 实时笔记暂停了：原因），这里只补后半句
      const msg = err ? `${String(err).replace(/[。.，,\s]+$/, '')}。${live.notes ? t('先保留上一版。') : ''}` : ''
      fill(notesLine, err ? [icon('triangle-alert', 13), el('span', { text: msg })] : [])
      renderSide()
    }

    function renderAnswerEmpty() {
      const s = state.settings ?? {}
      const llm = state.llm
      ui.clear(answerEmpty)
      answerEmpty.hidden = cards.size > 0
      if (llm && !llm.ready) {
        answerEmpty.append(
          el('div.callout.callout-warn', {}, icon('triangle-alert', 16), el('div.callout-body', {}, el('div.callout-title', { text: t('AI 答题用不了') }), el('div.callout-desc', { text: llm.reason || t('AI 服务还没设置好') })), el('button.btn.btn-sm', { type: 'button', onClick: aiSettings }, t('去设置'))),
        )
        return
      }
      const auto = mode() === 'interview' || (mode() !== 'class' && s.assist?.auto)
      const text = isClass()
        ? t('上课时不自动回答。老师点名提问时按快捷键或点「让 AI 回答」，AI 就回答刚才的问题。')
        : auto
          ? t('对方一问完，这里马上给出你可以照着说的回答，屏幕上的答题框也会同步出现。')
          : t('自动回答关着。点「让 AI 回答」或按快捷键，AI 就回答对方刚才的问题。')
      answerEmpty.append(el('div.answer-hint', {}, el('div', { text }), s.assist?.hotkeyAsk ? el('div.answer-hint-kbd', {}, kbd(s.assist.hotkeyAsk, { size: 'sm' }), el('span', { text: t('回答刚才的问题') })) : null))
    }

    function renderAnswers() {
      const all = state.live ? [...state.live.answers.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, ANSWERS_SHOWN) : []
      const ids = new Set(all.map((a) => a.id))
      for (const [id, c] of cards) if (!ids.has(id)) (c.root.remove(), cards.delete(id))
      all.forEach((a, i) => {
        let c = cards.get(a.id)
        if (!c) {
          c = answerCard(a, { live: true })
          cards.set(a.id, c)
        } else c.update(a)
        if (answerList.children[i] !== c.root) answerList.insertBefore(c.root, answerList.children[i] ?? null)
        c.root.classList.toggle('is-latest', i === 0)
      })
      answerCount.textContent = state.live?.answers.size ? String(state.live.answers.size) : ''
      renderAnswerEmpty()
    }

    function showNote(text, level = 'error') {
      answerNote.textContent = text
      answerNote.className = `answer-note-line is-${level}`
      answerNote.hidden = !text
    }

    async function ask(btn = askBtn) {
      btn.classList.add('is-loading')
      showNote('')
      const r = await askAI()
      btn.classList.remove('is-loading')
      if (!ctx.alive()) return
      setSide('answers')
      if (failed(r)) showNote(r?.error || t('没能开始回答'))
      else if (r?.question && !cards.size) showNote(t(`正在回答：{0}`, r.question), 'info')
    }

    async function capture() {
      captureBtn.classList.add('is-loading')
      await captureSlide()
      captureBtn.classList.remove('is-loading')
    }

    // 等待中的回答每 200ms 刷新一下耗时
    ctx.every(() => {
      for (const c of cards.values()) {
        const a = c.get()
        if (!a.done && !a.cancelled) c.update({})
      }
    }, 200)

    const renderAllSoon = debounce(renderAll, 120)

    header()
    renderBar()
    renderSummary()
    renderAll()
    renderAnswers()
    renderNotes()
    ctx.on('segment', onSegment)
    ctx.on('slide', onSlide)
    ctx.on('notes', renderNotes)
    ctx.on('answer', (a) => {
      const box = qBoxes.get(a?.segIds?.at(-1))
      if (box) fillQBox(box, a)
      const fresh = a?.id && !cards.has(a.id) && a.reason !== 'click'
      renderAnswers()
      if (fresh && sideTab !== 'answers') {
        unseenAnswers++
        renderSide()
      }
      if (a?.done || a?.error) showNote('')
    })
    ctx.on('live-reset', () => {
      qBoxes.clear()
      sideTab = firstTab()
      unseenAnswers = 0
      renderAll()
      renderAnswers()
      renderSummary()
      renderNotes()
      renderBar()
      showNote('')
    })
    ctx.on('engine', () => (header(), renderBar(), renderSummary()))
    ctx.on('devices', renderBar)
    ctx.on('overlay', renderBar)
    ctx.on('hotkey', () => (header(), renderBar()))
    // 意群颜色开关、样式改了要重画字幕
    let lastPrefs = chunkPrefs().className
    ctx.on('settings', () => {
      header()
      renderBar()
      renderAnswerEmpty()
      const now = chunkPrefs().className
      if (now !== lastPrefs) {
        lastPrefs = now
        renderAllSoon()
      }
    })
    ctx.on('status', renderAnswerEmpty)
    ctx.on('projects', header)
    ctx.on('level', ({ source, db }) => {
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
      ;(source === 'mic' ? meterMe : meterOther).style.setProperty('--value', `${pct}%`)
    })
    return { focus: () => scroller.focus({ preventScroll: true }), ask, capture }
  },
}

// 全局「开始 / 停止记录」快捷键注册上了才在停止按钮上显示
function recordKbd() {
  const r = state.hotkey?.record
  return r?.accel && !r.error ? kbd(r.accel, { size: 'sm' }) : null
}

function renderLiveHeader(ctx) {
  const live = state.live
  const st = state.engine.state
  const m = modeInfo(live?.mode)
  const cls = live?.mode === 'class'
  const p = projectOf(live?.projectId ?? state.engine.projectId)
  const projectCrumb = el('button.crumb-button', { type: 'button', onClick: () => p && go('project', { id: p.id }) }, projectBox(p, 'sm'), el('span.truncate', { text: p?.name ?? t('未归类') }))
  const modeTag = live && live.mode !== 'meeting' ? el('span.tag.mode-tag.header-mode', { dataset: { tint: m.tint } }, icon(m.icon, 12), cls && live.classSource ? `${m.label} · ${CLASS_SOURCES[sourceOf(live.classSource)].label}` : m.label) : null
  // 模式标签跟在项目名后面，不当一级面包屑
  const projectWithMode = modeTag ? el('span.crumb-group', {}, projectCrumb, modeTag) : projectCrumb
  if (!live || (live.ended && st === 'idle')) {
    const sid = live?.sessionId
    ctx.header({
      crumbs: [el('span.crumb.crumb-title', {}, icon('circle-check', 16), m.ended), live ? projectWithMode : null],
      actions: live
        ? [
            el('button.btn', { type: 'button', onClick: () => sid && go('meeting', { id: sid, tab: 'summary', summarize: true }) }, icon(cls ? 'notebook-pen' : 'sparkles', 14), cls ? t('生成课堂笔记') : t('生成纪要')),
            el('button.btn.btn-primary', { type: 'button', onClick: () => sid && go('meeting', { id: sid }) }, cls ? t('查看课堂记录') : t('查看会议记录'), icon('arrow-right', 14)),
          ]
        : [el('button.btn.btn-primary', { type: 'button', onClick: () => startMeeting() }, icon('mic', 14), t('开始会议'))],
    })
    return
  }
  const paused = st === 'running' && state.engine.paused
  const label = st === 'starting' ? t('正在连接') : st === 'stopping' ? t('正在保存') : paused ? t('已暂停') : m.live
  ctx.header({
    crumbs: [el('span.crumb.crumb-title', {}, paused ? icon('pause', 14) : st === 'running' ? el('span.dot.dot-live') : ui.spinner(12), label), projectWithMode],
    actions: [
      live.startedAt ? el('span.live-elapsed.num', { dataset: { elapsed: '' }, text: fmtOffset(Date.now() - live.startedAt) }) : null,
      el('button.btn', { type: 'button', disabled: st !== 'running', title: paused ? t('接着记录，还在这一场里') : t('先停一下：麦克风和识别都关掉，会议不结束'), onClick: togglePause }, icon(paused ? 'play' : 'pause', 14), paused ? t('继续') : t('暂停')),
      el('button.btn.btn-danger', { type: 'button', disabled: st !== 'running', class: st === 'stopping' ? 'is-loading' : '', onClick: stopMeeting }, icon('square', 14), t('停止'), recordKbd()),
    ],
  })
}
