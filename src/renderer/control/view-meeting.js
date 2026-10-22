'use strict'
// 会议详情：标题（可改）、所属项目（可移动）、时间和时长；标签页：纪要、实时笔记（开会时 AI 整理过才有）、待办、字幕记录、AI 答题、术语。
// 课堂的标签页换成：课堂笔记、图文笔记（生成过课堂笔记才有）、实时笔记（上课时 AI 整理过才有）、字幕记录、截图、术语、作业（课上用快捷键问过 AI 时再多一个 AI 答题），课堂笔记能导出到笔记库。

const MEETING_TABS = ['summary', 'notes', 'todos', 'transcript', 'answers', 'terms']
const CLASS_TABS = ['summary', 'html', 'notes', 'transcript', 'slides', 'terms', 'todos', 'answers']
const TAB_LABELS = {
  meeting: { summary: '纪要', notes: '实时笔记', todos: '待办', transcript: '字幕记录', answers: 'AI 答题', terms: '术语' },
  class: { summary: '课堂笔记', html: '图文笔记', notes: '实时笔记', todos: '作业', transcript: '字幕记录', answers: 'AI 答题', terms: '术语', slides: '截图' },
}

VIEWS.meeting = {
  mount(ctx) {
    let id = ctx.params.id
    let s = null
    let tab = ctx.params.tab || null
    let autoSummarize = Boolean(ctx.params.summarize)
    ctx.setParam('summarize', false)
    let autoRename = Boolean(ctx.params.rename) // 列表右键「改标题」进来：标题框选中
    ctx.setParam('rename', false)

    const titleInput = el('input.input-bare.title-xl.meeting-title', { type: 'text', maxLength: 120, placeholder: '给这场会议起个名字', 'aria-label': '会议标题', spellcheck: false })
    const projectBtn = el('button.tag-button', { type: 'button', 'aria-label': '移到别的项目' })
    const meta = el('div.meeting-meta.text-2.text-sm')
    const modeTag = el('span.tag.mode-tag', { hidden: true })
    const liveNote = el('div')
    const tabBtn = (k) => el('button.tab', { type: 'button', role: 'tab', dataset: { tab: k } }, el('span.tab-label', { text: TAB_LABELS.meeting[k] ?? TAB_LABELS.class[k] }), el('span.count.num'))
    const tabBtns = Object.fromEntries(['summary', 'html', 'notes', 'todos', 'transcript', 'answers', 'terms', 'slides'].map((k) => [k, tabBtn(k)]))
    const tabs = el('div.tabs.tabs-line.meeting-tabs', { role: 'tablist', 'aria-label': '会议内容' }, ...Object.values(tabBtns))
    const isClass = () => s?.mode === 'class'
    const liveNotesOf = () => (isLive() && state.live?.notes) || s?.liveNotes || null
    const hasLiveNotes = () => ['sections', 'emphasis', 'homework', 'terms'].some((k) => notesList(liveNotesOf()?.[k]).length)
    const tabList = () => (isClass() ? CLASS_TABS.filter((k) => k !== 'answers' || s.answers?.length) : MEETING_TABS).filter((k) => (k !== 'notes' || hasLiveNotes()) && (k !== 'html' || s.summary?.markdown))
    const panel = el('div.tab-panel', { role: 'tabpanel' })
    const page = el('div.page.meeting-page', {}, el('section.meeting-head', {}, titleInput, el('div.meeting-meta-row', {}, projectBtn, modeTag, meta)), liveNote, tabs, panel)
    const scroller = el('div.pane-body', {}, page)
    ctx.body.append(scroller)
    wireTabs(tabs, (t) => setTab(t), panel)
    ctx.dispose(wireTerms(panel))

    const menuBtn = iconButton('ellipsis', '会议操作', () => meetingActions(menuBtn))

    function isLive() {
      return state.engine.state !== 'idle' && state.live?.sessionId === id
    }

    function renderHeader() {
      const p = projectOf(s?.projectId)
      ctx.header({
        crumbs: [
          s ? el('button.crumb-button', { type: 'button', onClick: () => go('project', { id: s.projectId }) }, projectBox(p, 'sm'), el('span.truncate', { text: p?.name ?? '未归类' })) : null,
          el('span.crumb.truncate', { text: s ? sessionTitle(s) : '会议' }),
        ],
        actions: s ? [menuBtn] : [],
      })
    }

    function renderHead() {
      if (document.activeElement !== titleInput) titleInput.value = s.title || ''
      titleInput.placeholder = sessionTitle({ startedAt: s.startedAt, mode: s.mode })
      fill(projectBtn, projectTag(s.projectId), icon('chevrons-up-down', 12))
      const m = modeInfo(s.mode)
      modeTag.hidden = s.mode !== 'class' && s.mode !== 'interview'
      fill(modeTag, icon(m.icon, 12), s.mode === 'class' && s.classSource ? `${m.label} · ${CLASS_SOURCES[sourceOf(s.classSource)].label}` : m.label)
      modeTag.dataset.tint = m.tint
      // 标签页：课堂和会议不一样
      const labels = TAB_LABELS[isClass() ? 'class' : 'meeting']
      const shown = tabList()
      for (const [k, b] of Object.entries(tabBtns)) {
        b.hidden = !shown.includes(k)
        b.querySelector('.tab-label').textContent = labels[k] ?? ''
      }
      for (const k of shown) tabs.append(tabBtns[k])
      const segs = s.segments.filter((x) => x.text)
      const bits = [fmtWhen(s.startedAt)]
      if (s.endedAt) bits.push(fmtDuration(s.endedAt - s.startedAt))
      bits.push(`${segs.length} 段`)
      if (s.engineLabel) bits.push(s.engineLabel)
      fill(meta, icon('clock', 13), bits.join(' · '))
      ui.clear(liveNote)
      if (isLive())
        liveNote.append(
          el(
            'div.callout.callout-accent.meeting-live',
            {},
            el('span.dot.dot-live'),
            el('div.callout-body', {}, el('div.callout-title', { text: isClass() ? '这节课正在记录' : '这场会议正在记录' }), el('div.callout-desc', { text: isClass() ? '下课停止以后再生成课堂笔记。实时字幕和笔记在「正在上课」里看。' : '停止以后再生成纪要。实时字幕在「会议进行中」里看。' })),
            el('button.btn.btn-sm', { type: 'button', onClick: () => go('live') }, isClass() ? '回到课堂' : '回到会议'),
          ),
        )
      const items = s.summary?.items ?? []
      const open = items.filter((x) => !x.done).length
      tabBtns.todos.querySelector('.count').textContent = items.length ? (open ? String(open) : '✓') : ''
      tabBtns.transcript.querySelector('.count').textContent = segs.length ? String(segs.length) : ''
      tabBtns.answers.querySelector('.count').textContent = s.answers?.length ? String(s.answers.length) : ''
      const nTerms = glossary(s).length
      tabBtns.terms.querySelector('.count').textContent = nTerms ? String(nTerms) : ''
      tabBtns.slides.querySelector('.count').textContent = s.slides?.length ? String(s.slides.length) : ''
      if (isClass() && !items.length) {
        const hw = notesList(s.liveNotes?.homework).length
        tabBtns.todos.querySelector('.count').textContent = hw ? String(hw) : ''
      }
    }

    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) titleInput.blur()
      if (e.key === 'Escape') {
        titleInput.value = s?.title || ''
        titleInput.blur()
        e.stopPropagation()
      }
    })
    titleInput.addEventListener('change', async () => {
      if (!s) return
      const title = titleInput.value.trim()
      if (title === (s.title || '')) return
      const r = await call('renameSession', id, title)
      if (failed(r)) return ui.toast({ title: '没能改名', message: r?.error, type: 'error' })
      s.title = title
      renderHeader()
    })

    projectBtn.addEventListener('click', () => moveMenu(projectBtn))

    function moveMenu(anchor) {
      if (isLive()) return ui.toast({ title: '正在记录的会议不能移动', message: '先停止记录', type: 'warning' })
      projectMenu(anchor, {
        current: s.projectId,
        title: '移到哪个项目',
        onPick: async (pid) => {
          if (pid === s.projectId) return
          const r = await call('moveSession', id, pid)
          if (failed(r) || !r?.id) return ui.toast({ title: '没能移动', message: r?.error, type: 'error' })
          id = r.id
          ctx.setParam('id', id)
          ctx.setParam('projectId', pid)
          s = r
          renderHeader()
          renderHead()
          markSidebarActive()
          ui.toast({ title: `已移到「${projectName(pid)}」`, type: 'success' })
        },
      })
    }

    function meetingActions(anchor) {
      ui.menu(
        anchor,
        [
          { label: '移到别的项目…', icon: 'folder', onSelect: () => moveMenu(projectBtn) },
          { label: '改标题', icon: 'pencil', onSelect: () => (titleInput.focus(), titleInput.select()) },
          { label: '打开文件夹', icon: 'external-link', onSelect: () => call('openFolder', id) },
          { label: '复制字幕记录', icon: 'copy', onSelect: () => copyText(transcriptText(s), '字幕记录已复制') },
          s?.summary?.markdown && { label: isClass() ? '复制课堂笔记' : '复制纪要', icon: 'copy', onSelect: () => copyText(s.summary.markdown, isClass() ? '课堂笔记已复制' : '纪要已复制') },
          isClass() && s?.summary?.markdown && { label: '导出到笔记库…', icon: 'folder-output', onSelect: () => exportNotes(menuBtn) },
          'sep',
          { label: isClass() ? '删除这节课…' : '删除这场会议…', icon: 'trash', danger: true, onSelect: remove },
        ].filter(Boolean),
        { align: 'end', minWidth: 220 },
      )
    }

    async function remove() {
      const r = await call('removeSession', id)
      if (r === true) {
        ui.toast({ title: '已删除', message: '文件夹移到了废纸篓', type: 'success' })
        back()
      } else if (failed(r) && r?.error) ui.toast({ title: '没能删除', message: r.error, type: 'error' })
    }

    /* ---- 实时笔记：开会时右栏那份，会后也能看；还在开会时跟着更新 ---- */

    let liveNotesView = null
    ctx.dispose(() => liveNotesView?.destroy())

    function renderLiveNotes() {
      liveNotesView?.destroy()
      liveNotesView = notesView({ mode: s.mode ?? 'meeting' })
      liveNotesView.update(liveNotesOf())
      const at = isLive() ? null : s.liveNotesAt
      const what = isClass() ? { now: '还在上课', when: '上课时', full: '课后生成的完整笔记在「课堂笔记」' } : { now: '还在开会', when: '开会时', full: '会后生成的完整纪要在「纪要」' }
      const hint = isLive() ? `${what.now}，AI 每隔几分钟整理一版，这里跟着更新。` : `${what.when} AI 边听边整理的笔记${at ? `，最后一版 ${fmtClock(at)}` : ''}。${what.full}。`
      fill(panel, el('div.live-notes-tab', {}, el('div.text-2.text-sm.live-notes-hint', { text: hint }), liveNotesView.root))
    }

    /* ---- 纪要 ---- */

    let summaryParts = null
    let notesPreview = null
    ctx.dispose(() => notesPreview?.destroy())

    function renderSummary() {
      const cls = isClass()
      const extra = el('input', { type: 'text', placeholder: cls ? '额外要求（可选），比如：公式推导写详细一点，自测题多出两道' : '额外要求（可选），比如：重点列出导师对实验部分的意见', spellcheck: false, 'aria-label': cls ? '课堂笔记的额外要求' : '纪要的额外要求' })
      extra.value = summaryExtra.get(id) ?? ''
      extra.addEventListener('input', () => summaryExtra.set(id, extra.value))
      const genBtn = el('button.btn.btn-primary', { type: 'button' })
      const cancelBtn = el('button.btn', { type: 'button', hidden: true, onClick: () => call('cancelSummary', id) }, '取消')
      const copyBtn = iconButton('copy', cls ? '复制课堂笔记' : '复制纪要', () => {
        const md = s.summary?.markdown || state.summaries.get(id)?.text
        if (md) copyText(md, cls ? '课堂笔记已复制' : '纪要已复制')
      })
      const exportBtn = cls ? el('button.btn', { type: 'button', onClick: () => exportNotes(exportBtn) }, icon('folder-output', 14), '导出到笔记库') : null
      const status = el('div.summary-status.text-2.text-sm', { hidden: true })
      const prose = el('div.prose.summary-prose')
      const emptyBox = el('div')
      extra.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && !genBtn.disabled) generate()
      })
      genBtn.addEventListener('click', () => generate())
      const materials = cls ? el('div.materials-bar') : null
      fill(panel, 
        el('div.summary-toolbar', {}, el('label.field.summary-extra', {}, icon('sparkles', 14), extra), genBtn, cancelBtn, exportBtn, copyBtn),
        materials,
        status,
        emptyBox,
        prose,
      )
      summaryParts = { extra, genBtn, cancelBtn, copyBtn, exportBtn, status, prose, emptyBox, materials }
      syncSummary()
    }

    /* ---- 课件：课堂笔记对照课件写（PDF、图片，拖进来或点「添加课件」） ---- */

    let importing = null // 正在读的课件 { name, page, total }

    function renderMaterials() {
      const bar = summaryParts?.materials
      if (!bar) return
      const list = s.materials ?? []
      const chips = list.map((m) =>
        el(
          'span.material-chip',
          { title: m.name },
          icon(m.kind === 'pdf' ? 'file-text' : 'image', 13),
          el('span.truncate', { text: m.name }),
          m.kind === 'pdf' ? el('span.text-3.num', { text: `${m.pages} 页` }) : null,
          el('button.material-remove', { type: 'button', 'aria-label': `删掉课件 ${m.name}`, disabled: Boolean(importing), onClick: () => removeMaterial(m) }, icon('x', 12)),
        ),
      )
      const add = el('button.btn.btn-sm', { type: 'button', disabled: Boolean(importing), onClick: () => addMaterials() }, icon('plus', 13), '添加课件')
      const note = importing
        ? el('span.text-2.text-sm.material-progress', {}, ui.spinner(12), importing.total ? `正在读《${importing.name}》第 ${importing.page} / ${importing.total} 页` : `正在读《${importing.name}》`)
        : !list.length
          ? el('span.text-3.text-sm', { text: '加上老师的课件（PDF 或图片，也可以拖进来），课堂笔记会对照课件写，公式和术语按课件来，还会插入对应的课件页。' })
          : s.summary?.markdown
            ? el('span.text-3.text-sm', { text: '加了课件后点「重新生成」，笔记会对照课件重写。' })
            : null
      fill(bar, el('span.materials-label', {}, icon('presentation', 14), '课件'), chips, add, note)
    }

    async function addMaterials(files) {
      const r = await call('addMaterials', id, files)
      if (r == null) return // 取消了选文件
      if (failed(r)) return ui.toast({ title: '没能添加课件', message: r?.error, type: 'error' })
      if (r.errors?.length) ui.toast({ title: '有课件没加上', message: r.errors.join('\n'), type: 'error', duration: 8000 })
      else ui.toast({ title: '课件已加上', message: s.summary?.markdown ? '点「重新生成」让课堂笔记对照课件重写' : '生成课堂笔记时会对照课件', type: 'success' })
    }

    async function removeMaterial(m) {
      const r = await call('removeMaterial', id, m.id)
      if (failed(r)) ui.toast({ title: '没能删掉课件', message: r?.error, type: 'error' })
    }

    // 课件拖到课堂笔记这一页上就加进来
    panel.addEventListener('dragover', (e) => {
      if (tab !== 'summary' || !isClass() || !e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      panel.classList.add('is-drop')
    })
    panel.addEventListener('dragleave', (e) => {
      if (!panel.contains(e.relatedTarget)) panel.classList.remove('is-drop')
    })
    panel.addEventListener('drop', (e) => {
      panel.classList.remove('is-drop')
      if (tab !== 'summary' || !isClass() || !e.dataTransfer?.files?.length) return
      e.preventDefault()
      if (importing) return ui.toast({ title: '上一批课件还在读，读完再加' })
      addMaterials([...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean))
    })

    async function exportNotes(btn) {
      btn.classList.add('is-loading')
      const r = await call('exportNotes', id)
      btn.classList.remove('is-loading')
      if (r == null) return // 用户取消了选文件夹
      if (failed(r) || r.error) return ui.toast({ title: '没能导出', message: r?.error, type: 'error' })
      const n = Array.isArray(r.files) ? r.files.length : 0
      ui.toast({ title: '已导出到笔记库', message: `${r.dir ?? ''}${n ? `（${n} 个文件）` : ''}`, type: 'success', duration: 5000 })
    }

    function syncSummary() {
      if (!summaryParts || tab !== 'summary') return
      const { genBtn, cancelBtn, copyBtn, status, prose, emptyBox, extra } = summaryParts
      const job = state.summaries.get(id)
      const md = job ? job.text : s.summary?.markdown
      const hasSegs = s.segments.some((x) => x.text)
      const busy = Boolean(job)
      const cls = isClass()
      const noun = cls ? '课堂笔记' : '纪要'
      fill(genBtn, icon(s.summary?.markdown ? 'refresh-cw' : cls ? 'notebook-pen' : 'sparkles', 14), busy ? '生成中…' : s.summary?.markdown ? '重新生成' : `生成${noun}`, busy ? null : kbd('CommandOrControl+Enter', { size: 'sm' }))
      genBtn.disabled = busy || !hasSegs || isLive()
      extra.disabled = busy
      cancelBtn.hidden = !busy
      copyBtn.hidden = !md
      if (summaryParts.exportBtn) summaryParts.exportBtn.hidden = !s.summary?.markdown || busy
      renderMaterials()
      status.hidden = !busy && !summaryError.get(id)
      ui.clear(status)
      if (busy) status.append(ui.spinner(12), job.phase === 'items' ? (cls ? (s.materials?.length ? '课堂笔记写好了，正在整理作业、把老师讲的对到课件上…' : '课堂笔记写好了，正在整理作业和截止日期…') : '纪要写好了，正在提取待办和 DDL…') : job.phase === 'html' ? (s.materials?.length ? '正在做图文笔记：把老师讲的对到课件上…' : '正在做图文笔记…') : `正在生成${noun}…`)
      else if (summaryError.get(id)) status.append(el('span.summary-error', {}, icon('circle-alert', 14), summaryError.get(id)))
      prose.classList.toggle('is-generating', busy && job.phase === 'summary')
      ui.clear(emptyBox)
      if (!md) {
        prose.hidden = true
        if (!busy) {
          emptyBox.append(
            ui.emptyState({
              icon: cls ? 'notebook-pen' : 'file-text',
              title: hasSegs ? `还没有${noun}` : cls ? '这节课没有识别到内容' : '这场会议没有识别到内容',
              description: hasSegs
                ? cls
                  ? 'AI 会整理出本节概览、大纲和知识点、公式、老师强调的考点、作业、术语表和几道自测题，截图放在对应的位置。'
                  : 'AI 会整理出讨论要点、对方的意见、你要做的事和 DDL，待办会归到对应的项目。'
                : '记录时没有出字幕，就没有可以整理的内容。',
            }),
          )
          // 课堂：还没生成课堂笔记时，先看上课时的实时笔记
          if (cls && s.liveNotes) {
            notesPreview?.destroy()
            const v = (notesPreview = notesView({}))
            v.update(s.liveNotes)
            emptyBox.append(el('div.live-notes-preview', {}, sectionTitle('上课时的实时笔记'), v.root))
          }
        }
        return
      }
      prose.hidden = false
      renderMarkdown(prose, md)
      fixImages(prose)
    }

    // 课堂笔记里用相对路径引用截图（slides/xxx.jpg），换成会议文件夹里的实际地址；点一下放大
    function fixImages(root) {
      const base = sessionBaseUrl(s)
      for (const img of root.querySelectorAll('img')) {
        const raw = img.getAttribute('src') || ''
        if (/^(?:file|https|data):/i.test(raw)) continue
        let src = ''
        try {
          src = base ? new URL(raw, base).href : ''
        } catch {}
        if (!src) {
          img.replaceWith(el('span.prose-missing', {}, icon('image', 14), img.getAttribute('alt') || raw))
          continue
        }
        img.src = src
        img.classList.add('prose-slide')
        img.addEventListener('click', () => openSlide(src, img.alt || '截图'))
      }
    }

    async function generate() {
      if (!s || state.summaries.has(id) || isLive()) return
      const sid = id
      summaryError.delete(sid)
      state.summaries.set(sid, { phase: 'summary', text: '' })
      syncSummary()
      const r = await call('generateSummary', sid, (summaryExtra.get(sid) ?? '').trim())
      state.summaries.delete(sid)
      emit('summary', { id: sid, done: true })
      if (failed(r)) {
        if (r?.error === '已取消') ui.toast({ title: '已取消生成' })
        else summaryError.set(sid, `没生成出来：${r?.error ?? '未知错误'}`)
      } else {
        ui.toast({ title: isClass() ? '课堂笔记生成好了' : '纪要生成好了', message: r.items?.length ? `提取出 ${r.items.length} 条${isClass() ? '作业' : '待办'}` : undefined, type: 'success', duration: r.html ? 8000 : undefined, action: r.html ? { label: '看图文笔记', onClick: () => go('meeting', { id: sid, tab: 'html' }) } : undefined })
        if (r.itemsError || r.htmlError) summaryError.set(sid, [r.itemsError, r.htmlError].filter(Boolean).join('；'))
      }
      if (ctx.alive() && id === sid) await reload()
    }

    /* ---- 图文笔记（课堂笔记.html）：课件页插在老师讲到的地方，框出他对着讲的那几行；在这里直接看，也能用浏览器打开、导出 PDF ---- */

    let htmlFrame = null
    let htmlBar = null
    // 框架占满这一页剩下的高度，滚动在图文笔记自己里面
    const fitFrame = () => {
      if (!htmlFrame?.isConnected) return
      const top = htmlFrame.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      htmlFrame.style.height = `${Math.max(420, scroller.clientHeight - top - 20)}px`
    }
    const frameFit = new ResizeObserver(fitFrame)
    frameFit.observe(scroller)
    ctx.dispose(() => frameFit.disconnect())

    function renderHtml() {
      const job = state.summaries.get(id)
      const making = job?.phase === 'html'
      const has = Boolean(s.summary?.html) && !making
      const browserBtn = el('button.btn', { type: 'button', hidden: !has, disabled: Boolean(job), onClick: () => openHtml(browserBtn) }, icon('external-link', 14), '用浏览器打开')
      const pdfBtn = el('button.btn', { type: 'button', hidden: !has, disabled: Boolean(job), onClick: () => exportPdf(pdfBtn) }, icon('file-down', 14), '导出 PDF')
      const redoBtn = el('button.btn', { type: 'button', disabled: Boolean(job), title: '照现在的课堂笔记和课件重新对一遍', onClick: () => buildHtml() }, icon('refresh-cw', 14), s.summary?.html ? '重新做' : '做图文笔记')
      const note = job
        ? [ui.spinner(12), making ? (s.materials?.length ? '正在做图文笔记：把老师讲的对到课件上…' : '正在做图文笔记…') : '课堂笔记正在生成，写好后图文笔记跟着重做']
        : summaryError.get(id)
          ? [el('span.summary-error', {}, icon('circle-alert', 14), summaryError.get(id))]
          : has
            ? [`课件页插在老师讲到的地方，框出他对着讲的那几行${s.summary.htmlAt ? ` · ${fmtClock(s.summary.htmlAt)} 做的` : ''}`]
            : []
      const bar = el('div.summary-toolbar.html-toolbar', {}, el('div.html-note.text-2.text-sm', {}, ...note), redoBtn, browserBtn, pdfBtn)
      let body = null
      if (has) {
        const src = `${new URL(s.summary.html, sessionBaseUrl(s)).href}?v=${s.summary.htmlAt ?? 0}`
        if (htmlFrame?.dataset.src !== src) htmlFrame = el('iframe.notes-frame', { title: '图文笔记', dataset: { src }, attrs: { src, sandbox: 'allow-scripts allow-popups' } })
        body = htmlFrame
      } else if (!job)
        body = ui.emptyState({
          icon: 'book-open',
          title: '还没有图文笔记',
          description: s.materials?.length ? '把老师讲的点对到课件上：课件页插在讲到的地方，框出他对着讲的那几行，旁边是讲了什么、时间和原话。' : '没加课件时只放课上的截图。先在「课堂笔记」里加上老师的课件，效果好得多。',
        })
      // 只换工具栏，别把框架拿下来再放回去（会重新加载、滚动位置丢掉）
      if (body && body === htmlFrame && htmlFrame.parentNode === panel && htmlBar?.parentNode === panel) htmlBar.replaceWith(bar)
      else fill(panel, bar, body)
      htmlBar = bar
      fitFrame()
    }

    async function buildHtml() {
      const sid = id
      summaryError.delete(sid)
      state.summaries.set(sid, { phase: 'html', text: s.summary?.markdown ?? '' })
      renderHtml()
      const r = await call('buildNotesHtml', sid)
      state.summaries.delete(sid)
      if (failed(r)) summaryError.set(sid, `图文笔记没做出来：${r?.error ?? '未知错误'}`)
      else if (r.htmlError) summaryError.set(sid, r.htmlError)
      if (ctx.alive() && id === sid) await reload()
    }

    async function openHtml(btn) {
      btn.classList.add('is-loading')
      const r = await call('openNotesHtml', id)
      btn.classList.remove('is-loading')
      if (failed(r)) ui.toast({ title: '没能用浏览器打开', message: r?.error, type: 'error' })
    }

    async function exportPdf(btn) {
      btn.classList.add('is-loading')
      const r = await call('exportNotesPdf', id)
      btn.classList.remove('is-loading')
      if (r == null) return // 取消了选位置
      if (failed(r)) return ui.toast({ title: '没能导出 PDF', message: r?.error, type: 'error' })
      ui.toast({ title: '已导出 PDF', message: r.openError ? `${r.file}（没能打开：${r.openError}）` : r.file, type: 'success', duration: 5000 })
    }

    /* ---- 待办 ---- */

    let todoNav = null
    function renderTodos() {
      const cls = isClass()
      const items = (s.summary?.items ?? []).map((x) => ({ ...x, sessionId: id, sessionTitle: s.title, sessionStartedAt: s.startedAt }))
      const list = el('div.list', { role: 'listbox', 'aria-label': '这场会议的待办' })
      const keep = todoNav?.selected()?.dataset.id
      todoNav?.destroy()
      todoNav = navList(list)
      wireTodoKeys(list, todoNav)
      const reBtn = el('button.btn.btn-sm', { type: 'button', disabled: state.summaries.has(id) || isLive(), hidden: !s.summary?.markdown }, icon('refresh-cw', 14), '重新提取')
      reBtn.addEventListener('click', async () => {
        reBtn.classList.add('is-loading')
        const r = await call('extractTodos', id)
        reBtn.classList.remove('is-loading')
        if (failed(r)) ui.toast({ title: '没能提取', message: r?.error, type: 'error' })
        else ui.toast({ title: r.itemsError ? '提取出错' : `提取出 ${r.items?.length ?? 0} 条待办`, message: r.itemsError, type: r.itemsError ? 'warning' : 'success' })
        if (ctx.alive()) reload()
      })
      fill(panel, 
        el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: cls ? '生成课堂笔记时自动整理，作业会进这门课所在项目的待办。空格键勾选。' : '生成纪要时自动提取，每条标到最相关的项目。点项目标签可以改归属，空格键勾选。' }), el('span.header-spacer'), reBtn),
        list,
      )
      if (!items.length) {
        const hw = cls ? notesList(s.liveNotes?.homework).map((x) => (typeof x === 'string' ? { text: x } : x)).filter((x) => x?.text) : []
        if (hw.length) {
          // 还没生成课堂笔记：先列出上课时实时笔记里记下的作业（只读）
          const box = el('div.list.hw-preview')
          for (const h of hw) {
            const due = dueInfo(h.due)
            box.append(ui.listItem({ icon: 'clipboard-list', title: h.text, subtitle: h.dueText ? `原话：${h.dueText}` : null, twoLine: Boolean(h.dueText), accessories: due ? [{ tag: due.label, tint: due.tint }] : [] }))
          }
          list.replaceWith(el('div', {}, el('div.callout.callout-accent.hw-note', {}, icon('info', 16), el('div.callout-body', {}, el('div.callout-desc', { text: '这是上课时实时笔记里记下的作业。生成课堂笔记后会变成能勾选的待办。' }))), box))
          return
        }
        list.replaceWith(
          ui.emptyState({
            icon: cls ? 'clipboard-list' : 'list-todo',
            title: cls ? '没有作业' : '没有待办',
            description: s.summary?.markdown ? `${cls ? '课堂笔记里没有提到作业' : '纪要里没有提到要做的事'}。觉得漏了可以点「重新提取」。` : cls ? '先生成课堂笔记，作业和截止日期会一起整理出来。' : '先生成纪要，待办和 DDL 会一起提取出来。',
          }),
        )
        return
      }
      const onProject = (anchor, t) =>
        projectMenu(anchor, {
          current: t.projectId,
          title: '这条待办归到',
          onPick: async (pid) => {
            const r = await call('updateTodo', id, t.id, { projectId: pid })
            if (failed(r)) ui.toast({ title: '没能改归属', message: r?.error, type: 'error' })
          },
        })
      const open = items.filter((x) => !x.done)
      const done = items.filter((x) => x.done)
      for (const t of open) list.append(todoRow(t, { showProject: true, showQuote: true, onProject, onOpen: () => {} }))
      if (done.length) {
        list.append(sectionTitle('已完成', el('span.count.num', { text: String(done.length) })))
        for (const t of done) list.append(todoRow(t, { showProject: true, showQuote: true, onProject, onOpen: () => {} }))
      }
      todoNav.refresh(keep)
      if (document.activeElement !== list) todoNav.select(-1)
    }

    /* ---- 字幕记录 ---- */

    function renderTranscript() {
      const segs = s.segments.filter((x) => x.text)
      const box = el('div.transcript.meeting-transcript')
      const items = segs.map((seg) => ({ t: seg.startedAt ?? 0, seg }))
      for (const sl of s.slides ?? []) items.push({ t: slideTime(sl, s.startedAt), slide: sl })
      items.sort((a, b) => a.t - b.t)
      for (const it of items) box.append(it.seg ? lineNode({ ...it.seg, final: true }, s.startedAt, { mode: s.mode }) : slideNode(it.slide, { base: s.startedAt, dir: s.dir, startedAt: s.startedAt }))
      const who = { me: 0, other: 0 }
      for (const seg of segs) who[segWho(seg)]++
      const questions = segs.filter((x) => x.question).length
      fill(panel, 
        el(
          'div.panel-toolbar',
          {},
          el('span.text-2.text-sm', { text: segs.length ? [`${whoLabel('other', s.mode)} ${who.other} 段`, who.me ? `我 ${who.me} 段` : null, questions ? `提问 ${questions} 次` : null, s.slides?.length ? `${s.slides.length} 张截图` : null].filter(Boolean).join(' · ') : '' }),
          el('span.header-spacer'),
          el('button.btn.btn-sm', { type: 'button', disabled: !segs.length, onClick: () => copyText(transcriptText(s), '字幕记录已复制') }, icon('copy', 14), '复制全文'),
        ),
        segs.length ? box : ui.emptyState({ icon: 'captions', title: '没有字幕', description: '这场会议没有识别到内容。' }),
      )
    }

    /* ---- 截图（课堂） ---- */

    function renderSlides() {
      const list = [...(s.slides ?? [])].sort((a, b) => slideTime(a, s.startedAt) - slideTime(b, s.startedAt))
      ui.clear(panel)
      if (!list.length) {
        panel.append(ui.emptyState({ icon: 'image', title: '这节课没有截图', description: '网课时点「截取画面」或按快捷键，当前屏幕上的课件就存进这节课的文件夹，课堂笔记会在对应的位置引用它。' }))
        return
      }
      const grid = el('div.slide-grid')
      for (const sl of list) {
        const t = slideTime(sl, s.startedAt)
        const src = slideSrc(sl, s.dir)
        const label = `第 ${fmtOffset(t - s.startedAt)}`
        grid.append(
          el(
            'figure.slide-card',
            {},
            src
              ? el('button.slide-card-img', { type: 'button', 'aria-label': `放大 ${label} 的截图`, onClick: () => openSlide(src, `截图 ${fmtOffset(t - s.startedAt)}`) }, el('img', { src, alt: label, loading: 'lazy' }))
              : el('div.slide-card-img.is-missing', {}, icon('image', 22)),
            el('figcaption.num', {}, el('span', { text: fmtOffset(t - s.startedAt) }), el('span.text-3', { text: fmtTime(t) })),
          ),
        )
      }
      panel.append(
        el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: `${list.length} 张截图，按上课时间排。点一下放大。` }), el('span.header-spacer'), el('button.btn.btn-sm', { type: 'button', onClick: () => call('openFolder', id) }, icon('folder', 14), '打开文件夹')),
        grid,
      )
    }

    /* ---- AI 答题 ---- */

    function renderAnswers() {
      const list = (s.answers ?? []).filter((a) => a.text || a.error)
      ui.clear(panel)
      if (!list.length) {
        panel.append(ui.emptyState({ icon: 'sparkles', title: isClass() ? '这节课没有 AI 回答' : '这场会议没有 AI 回答', description: '对方一提问，AI 就会给出你可以照着说的回答，都会记在这里。' }))
        return
      }
      const box = el('div.answer-list.meeting-answers')
      for (const a of [...list].sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))) {
        const c = answerCard({ ...a, done: true }, { live: false })
        c.root.prepend(el('span.answer-at.num', { text: fmtOffset((a.startedAt ?? s.startedAt) - s.startedAt) }))
        box.append(c.root)
      }
      panel.append(el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: `${list.length} 条回答，按时间先后。生成纪要时会参考。` })), box)
    }

    /* ---- 术语 ---- */

    function renderTerms() {
      const list = glossary(s)
      ui.clear(panel)
      if (!list.length) {
        panel.append(ui.emptyState({ icon: 'book-open', title: '没有术语', description: '开会时字幕里的专业词会带解释，都收在这里。可以在设置里打开「术语解释」。' }))
        return
      }
      const box = el('div.glossary.selectable')
      for (const t of list) box.append(el('div.glossary-row', {}, el('div.glossary-term', {}, el('span', { text: t.term }), t.zh ? el('span.glossary-zh', { text: t.zh }) : null), el('div.glossary-explain', { text: t.explain })))
      panel.append(
        el(
          'div.panel-toolbar',
          {},
          el('span.text-2.text-sm', { text: `${list.length} 个术语` }),
          el('span.header-spacer'),
          el('button.btn.btn-sm', { type: 'button', onClick: () => copyText(list.map((t) => `${t.term}${t.zh ? `（${t.zh}）` : ''}：${t.explain}`).join('\n'), '术语已复制') }, icon('copy', 14), '复制'),
        ),
        box,
      )
    }

    function setTab(t) {
      if (s && !tabList().includes(t)) t = 'summary'
      else if (!s && !CLASS_TABS.includes(t) && !MEETING_TABS.includes(t)) t = 'summary'
      tab = t
      ctx.setParam('tab', t)
      for (const [k, b] of Object.entries(tabBtns)) {
        b.setAttribute('aria-selected', String(k === t))
        b.tabIndex = k === t ? 0 : -1
      }
      summaryParts = null
      page.classList.toggle('is-wide', t === 'html')
      if (!s) return
      if (t === 'summary') renderSummary()
      if (t === 'html') renderHtml()
      if (t === 'todos') renderTodos()
      if (t === 'transcript') renderTranscript()
      if (t === 'answers') renderAnswers()
      if (t === 'terms') renderTerms()
      if (t === 'slides') renderSlides()
      if (t === 'notes') renderLiveNotes()
    }

    function renderPanel() {
      const top = scroller.scrollTop
      setTab(tab)
      scroller.scrollTop = top
    }

    async function reload() {
      const r = await call('loadSession', id)
      if (!ctx.alive()) return
      if (failed(r) || !r?.id) {
        fill(page, ui.emptyState({ icon: 'circle-alert', title: '找不到这场会议', description: r?.error || '文件夹可能被移走或删掉了。', action: { label: '返回', onClick: back } }))
        s = null
        renderHeader()
        return
      }
      const first = !s
      s = r
      ctx.setParam('projectId', s.projectId)
      markSidebarActive()
      renderHeader()
      renderHead()
      if (first && autoRename) {
        autoRename = false
        requestAnimationFrame(() => (titleInput.focus(), titleInput.select()))
      }
      if (first && !tab) tab = s.summary?.markdown || !s.segments.some((x) => x.text) ? 'summary' : 'transcript'
      if (first && autoSummarize) {
        autoSummarize = false
        tab = 'summary'
        setTab(tab)
        if (!s.summary?.markdown) generate()
        return
      }
      // 正在打字的输入框别被重画掉
      if (tab === 'summary' && summaryParts) syncSummary()
      else renderPanel()
    }

    renderHeader()
    reload()

    ctx.on('summary', (p) => {
      if (p.id !== id) return
      if (p.done) return reloadSoon()
      if (state.summaries.has(id)) tab === 'html' ? renderHtml() : syncSummary()
    })
    ctx.on('sessions', (e) => {
      if (!s) return
      if (e?.removed && e.sessionId === id) {
        ui.toast({ title: '这场会议已经删除' })
        return back()
      }
      if (e?.previousId === id && e.sessionId) {
        id = e.sessionId
        ctx.setParam('id', id)
      }
      if (!e?.sessionId || e.sessionId === id) {
        if (!state.summaries.has(id)) reloadSoon()
      }
    })
    const reloadSoon = debounce(reload, 200)
    ctx.on('todos', (e) => {
      if (s && (!e?.sessionId || e.sessionId === id) && !state.summaries.has(id)) reloadSoon()
    })
    ctx.on('projects', () => s && (renderHeader(), renderHead()))
    ctx.on('materials', (p) => {
      if (p.sessionId !== id) return
      importing = p.done ? null : { name: p.name, page: p.page, total: p.total }
      renderMaterials()
    })
    // 设置里换了意群颜色开关或样式：字幕记录重画
    let lastPrefs = chunkPrefs().className
    ctx.on('settings', () => {
      const now = chunkPrefs().className
      if (now === lastPrefs) return
      lastPrefs = now
      if (s && tab === 'transcript') renderPanel()
    })
    ctx.on('engine', () => s && (renderHead(), tab === 'summary' && syncSummary()))
    ctx.on('notes', () => {
      if (!s || !isLive()) return
      renderHead()
      if (tab === 'notes') liveNotesView?.update(liveNotesOf())
    })

    return {
      focus: () => (panel.querySelector('.list') ?? tabBtns[tab ?? 'summary'])?.focus({ preventScroll: true }),
      setTab,
      cycleTab: (d) => setTab(cycle(s ? tabList() : MEETING_TABS, tab ?? 'summary', d)),
      primary: () => tab === 'summary' && summaryParts && !summaryParts.genBtn.disabled && generate(),
    }
  },
}

const summaryExtra = new Map() // 会议 id → 还没用上的额外要求
const summaryError = new Map()

function transcriptText(s) {
  return s.segments
    .filter((x) => x.text)
    .map((x) => {
      const tr = (x.sentences ?? [])
        .map((y) => y.tr)
        .filter(Boolean)
        .join(' ')
      const who = whoLabel(segWho(x), s.mode)
      return `[${fmtOffset(x.startedAt - s.startedAt)}] ${who}${x.question ? '（提问）' : ''}：${x.text}${tr ? `\n    ${tr}` : ''}`
    })
    .join('\n')
}

/** 会议文件夹的 file:// 地址（结尾带 /）：从截图的 url 倒推（主进程给每张截图带了 url），没有就用 s.dir。 */
function sessionBaseUrl(s) {
  for (const sl of s.slides ?? []) {
    if (!sl?.url || !sl.file || !/^file:/i.test(sl.url)) continue
    try {
      let base = new URL('./', sl.url)
      for (let i = String(sl.file).split('/').length - 1; i > 0; i--) base = new URL('../', base)
      return base.href
    } catch {}
  }
  return s.dir ? fileUrl(`${String(s.dir).replace(/[\\/]+$/, '')}/`) : null
}

/** 术语表：字幕里标过的，加上课堂实时笔记里的（带中文）。 */
function glossary(s) {
  const seen = new Map()
  const add = (t) => {
    if (!t?.term || !t.explain) return
    const k = String(t.term).toLowerCase()
    const old = seen.get(k)
    if (!old) seen.set(k, { term: t.term, zh: t.zh || '', explain: t.explain })
    else if (!old.zh && t.zh) old.zh = t.zh
  }
  for (const seg of s.segments ?? []) for (const sen of seg.sentences ?? []) for (const t of sen.terms ?? []) add(t)
  for (const t of notesList(s.liveNotes?.terms)) add(t)
  return [...seen.values()]
}
