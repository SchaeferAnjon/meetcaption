'use strict'
// 会议详情：标题（可改）、所属项目（可移动）、时间和时长；标签页：纪要、实时笔记（开会时 AI 整理过才有）、待办、字幕记录、AI 答题、术语。
// 课堂的标签页换成：课堂笔记、图文笔记（生成过课堂笔记才有）、实时笔记（上课时 AI 整理过才有）、字幕记录、截图、术语、作业（课上用快捷键问过 AI 时再多一个 AI 答题），课堂笔记能导出到笔记库。

const MEETING_TABS = ['summary', 'notes', 'todos', 'transcript', 'answers', 'terms']
const CLASS_TABS = ['summary', 'html', 'notes', 'transcript', 'slides', 'terms', 'todos', 'answers']
const TAB_LABELS = {
  meeting: { summary: t('纪要'), notes: t('实时笔记'), todos: t('待办'), transcript: t('字幕记录'), answers: t('AI 答题'), terms: t('术语') },
  class: { summary: t('课堂笔记'), html: t('图文笔记'), notes: t('实时笔记'), todos: t('作业'), transcript: t('字幕记录'), answers: t('AI 答题'), terms: t('术语'), slides: t('截图') },
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

    const titleInput = el('input.input-bare.title-xl.meeting-title', { type: 'text', maxLength: 120, placeholder: t('给这场会议起个名字'), 'aria-label': t('会议标题'), spellcheck: false })
    const projectBtn = el('button.tag-button', { type: 'button', 'aria-label': t('移到别的项目') })
    const meta = el('div.meeting-meta.text-2.text-sm')
    const modeTag = el('span.tag.mode-tag', { hidden: true })
    const liveNote = el('div')
    const tabBtn = (k) => el('button.tab', { type: 'button', role: 'tab', dataset: { tab: k } }, el('span.tab-label', { text: TAB_LABELS.meeting[k] ?? TAB_LABELS.class[k] }), el('span.count.num'))
    const tabBtns = Object.fromEntries(['summary', 'html', 'notes', 'todos', 'transcript', 'answers', 'terms', 'slides'].map((k) => [k, tabBtn(k)]))
    const tabs = el('div.tabs.tabs-line.meeting-tabs', { role: 'tablist', 'aria-label': t('会议内容') }, ...Object.values(tabBtns))
    const isClass = () => s?.mode === 'class'
    const liveNotesOf = () => (isLive() && state.live?.notes) || s?.liveNotes || null
    const hasLiveNotes = () => ['sections', 'emphasis', 'homework', 'terms'].some((k) => notesList(liveNotesOf()?.[k]).length)
    const tabList = () => (isClass() ? CLASS_TABS.filter((k) => k !== 'answers' || s.answers?.length) : MEETING_TABS).filter((k) => (k !== 'notes' || hasLiveNotes()) && (k !== 'html' || s.summary?.markdown))
    const panel = el('div.tab-panel', { role: 'tabpanel' })
    const page = el('div.page.meeting-page', {}, el('section.meeting-head', {}, titleInput, el('div.meeting-meta-row', {}, projectBtn, modeTag, meta)), liveNote, tabs, panel)
    const scroller = el('div.pane-body', {}, page)
    ctx.body.append(scroller)
    wireTabs(tabs, (tv) => setTab(tv), panel)
    ctx.dispose(wireTerms(panel))

    const menuBtn = iconButton('ellipsis', t('会议操作'), () => meetingActions(menuBtn))

    function isLive() {
      return state.engine.state !== 'idle' && state.live?.sessionId === id
    }

    function renderHeader() {
      const p = projectOf(s?.projectId)
      ctx.header({
        crumbs: [
          s ? el('button.crumb-button', { type: 'button', onClick: () => go('project', { id: s.projectId }) }, projectBox(p, 'sm'), el('span.truncate', { text: p?.name ?? t('未归类') })) : null,
          el('span.crumb.truncate', { text: s ? sessionTitle(s) : t('会议') }),
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
      bits.push(t(`{0} 段`, segs.length))
      if (s.engineLabel) bits.push(s.engineLabel)
      fill(meta, icon('clock', 13), bits.join(' · '))
      ui.clear(liveNote)
      if (isLive())
        liveNote.append(
          el(
            'div.callout.callout-accent.meeting-live',
            {},
            el('span.dot.dot-live'),
            el('div.callout-body', {}, el('div.callout-title', { text: isClass() ? t('这节课正在记录') : t('这场会议正在记录') }), el('div.callout-desc', { text: isClass() ? t('下课停止以后再生成课堂笔记。实时字幕和笔记在「正在上课」里看。') : t('停止以后再生成纪要。实时字幕在「会议进行中」里看。') })),
            el('button.btn.btn-sm', { type: 'button', onClick: () => go('live') }, isClass() ? t('回到课堂') : t('回到会议')),
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
      if (failed(r)) return ui.toast({ title: t('没能改名'), message: r?.error, type: 'error' })
      s.title = title
      renderHeader()
    })

    projectBtn.addEventListener('click', () => moveMenu(projectBtn))

    function moveMenu(anchor) {
      if (isLive()) return ui.toast({ title: t('正在记录的会议不能移动'), message: t('先停止记录'), type: 'warning' })
      projectMenu(anchor, {
        current: s.projectId,
        title: t('移到哪个项目'),
        onPick: async (pid) => {
          if (pid === s.projectId) return
          const r = await call('moveSession', id, pid)
          if (failed(r) || !r?.id) return ui.toast({ title: t('没能移动'), message: r?.error, type: 'error' })
          id = r.id
          ctx.setParam('id', id)
          ctx.setParam('projectId', pid)
          s = r
          renderHeader()
          renderHead()
          markSidebarActive()
          ui.toast({ title: t(`已移到「{0}」`, projectName(pid)), type: 'success' })
        },
      })
    }

    function meetingActions(anchor) {
      ui.menu(
        anchor,
        [
          { label: t('移到别的项目…'), icon: 'folder', onSelect: () => moveMenu(projectBtn) },
          { label: t('改标题'), icon: 'pencil', onSelect: () => (titleInput.focus(), titleInput.select()) },
          { label: t('打开文件夹'), icon: 'external-link', onSelect: () => call('openFolder', id) },
          { label: t('复制字幕记录'), icon: 'copy', onSelect: () => copyText(transcriptText(s), t('字幕记录已复制')) },
          s?.summary?.markdown && { label: isClass() ? t('复制课堂笔记') : t('复制纪要'), icon: 'copy', onSelect: () => copyText(s.summary.markdown, isClass() ? t('课堂笔记已复制') : t('纪要已复制')) },
          isClass() && s?.summary?.markdown && { label: t('导出到笔记库…'), icon: 'folder-output', onSelect: () => exportNotes(menuBtn) },
          'sep',
          { label: isClass() ? t('删除这节课…') : t('删除这场会议…'), icon: 'trash', danger: true, onSelect: remove },
        ].filter(Boolean),
        { align: 'end', minWidth: 220 },
      )
    }

    async function remove() {
      const r = await call('removeSession', id)
      if (r === true) {
        ui.toast({ title: t('已删除'), message: t('文件夹移到了废纸篓'), type: 'success' })
        back()
      } else if (failed(r) && r?.error) ui.toast({ title: t('没能删除'), message: r.error, type: 'error' })
    }

    /* ---- 实时笔记：开会时右栏那份，会后也能看；还在开会时跟着更新 ---- */

    let liveNotesView = null
    ctx.dispose(() => liveNotesView?.destroy())

    function renderLiveNotes() {
      liveNotesView?.destroy()
      liveNotesView = notesView({ mode: s.mode ?? 'meeting' })
      liveNotesView.update(liveNotesOf())
      const at = isLive() ? null : s.liveNotesAt
      const what = isClass() ? { now: t('还在上课'), when: t('上课时'), full: t('课后生成的完整笔记在「课堂笔记」') } : { now: t('还在开会'), when: t('开会时'), full: t('会后生成的完整纪要在「纪要」') }
      const hint = isLive() ? t(`{0}，AI 每隔几分钟整理一版，这里跟着更新。`, what.now) : t(`{0} AI 边听边整理的笔记{1}。{2}。`, what.when, at ? t(`，最后一版 {0}`, fmtClock(at)) : '', what.full)
      fill(panel, el('div.live-notes-tab', {}, el('div.text-2.text-sm.live-notes-hint', { text: hint }), liveNotesView.root))
    }

    /* ---- 纪要 ---- */

    let summaryParts = null
    let notesPreview = null
    ctx.dispose(() => notesPreview?.destroy())

    function renderSummary() {
      const cls = isClass()
      const extra = el('input', { type: 'text', placeholder: cls ? t('额外要求（可选），比如：公式推导写详细一点，自测题多出两道') : t('额外要求（可选），比如：重点列出导师对实验部分的意见'), spellcheck: false, 'aria-label': cls ? t('课堂笔记的额外要求') : t('纪要的额外要求') })
      extra.value = summaryExtra.get(id) ?? ''
      extra.addEventListener('input', () => summaryExtra.set(id, extra.value))
      const genBtn = el('button.btn.btn-primary', { type: 'button' })
      const cancelBtn = el('button.btn', { type: 'button', hidden: true, onClick: () => call('cancelSummary', id) }, t('取消'))
      const copyBtn = iconButton('copy', cls ? t('复制课堂笔记') : t('复制纪要'), () => {
        const md = s.summary?.markdown || state.summaries.get(id)?.text
        if (md) copyText(md, cls ? t('课堂笔记已复制') : t('纪要已复制'))
      })
      const exportBtn = cls ? el('button.btn', { type: 'button', onClick: () => exportNotes(exportBtn) }, icon('folder-output', 14), t('导出到笔记库')) : null
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
          m.kind === 'pdf' ? el('span.text-3.num', { text: t(`{0} 页`, m.pages) }) : null,
          el('button.material-remove', { type: 'button', 'aria-label': t(`删掉课件 {0}`, m.name), disabled: Boolean(importing), onClick: () => removeMaterial(m) }, icon('x', 12)),
        ),
      )
      const add = el('button.btn.btn-sm', { type: 'button', disabled: Boolean(importing), onClick: () => addMaterials() }, icon('plus', 13), t('添加课件'))
      const note = importing
        ? el('span.text-2.text-sm.material-progress', {}, ui.spinner(12), importing.total ? t(`正在读《{0}》第 {1} / {2} 页`, importing.name, importing.page, importing.total) : t(`正在读《{0}》`, importing.name))
        : !list.length
          ? el('span.text-3.text-sm', { text: t('加上老师的课件（PDF 或图片，也可以拖进来），课堂笔记会对照课件写，公式和术语按课件来，还会插入对应的课件页。') })
          : s.summary?.markdown
            ? el('span.text-3.text-sm', { text: t('加了课件后点「重新生成」，笔记会对照课件重写。') })
            : null
      fill(bar, el('span.materials-label', {}, icon('presentation', 14), t('课件')), chips, add, note)
    }

    async function addMaterials(files) {
      const r = await call('addMaterials', id, files)
      if (r == null) return // 取消了选文件
      if (failed(r)) return ui.toast({ title: t('没能添加课件'), message: r?.error, type: 'error' })
      if (r.errors?.length) ui.toast({ title: t('有课件没加上'), message: r.errors.join('\n'), type: 'error', duration: 8000 })
      else ui.toast({ title: t('课件已加上'), message: s.summary?.markdown ? t('点「重新生成」让课堂笔记对照课件重写') : t('生成课堂笔记时会对照课件'), type: 'success' })
    }

    async function removeMaterial(m) {
      const r = await call('removeMaterial', id, m.id)
      if (failed(r)) ui.toast({ title: t('没能删掉课件'), message: r?.error, type: 'error' })
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
      if (importing) return ui.toast({ title: t('上一批课件还在读，读完再加') })
      addMaterials([...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean))
    })

    async function exportNotes(btn) {
      btn.classList.add('is-loading')
      const r = await call('exportNotes', id)
      btn.classList.remove('is-loading')
      if (r == null) return // 用户取消了选文件夹
      if (failed(r) || r.error) return ui.toast({ title: t('没能导出'), message: r?.error, type: 'error' })
      const n = Array.isArray(r.files) ? r.files.length : 0
      ui.toast({ title: t('已导出到笔记库'), message: `${r.dir ?? ''}${n ? t(`（{0} 个文件）`, n) : ''}`, type: 'success', duration: 5000 })
    }

    function syncSummary() {
      if (!summaryParts || tab !== 'summary') return
      const { genBtn, cancelBtn, copyBtn, status, prose, emptyBox, extra } = summaryParts
      const job = state.summaries.get(id)
      const md = job ? job.text : s.summary?.markdown
      const hasSegs = s.segments.some((x) => x.text)
      const busy = Boolean(job)
      const cls = isClass()
      const noun = cls ? t('课堂笔记') : t('纪要')
      fill(genBtn, icon(s.summary?.markdown ? 'refresh-cw' : cls ? 'notebook-pen' : 'sparkles', 14), busy ? t('生成中…') : s.summary?.markdown ? t('重新生成') : t(`生成{0}`, noun), busy ? null : kbd('CommandOrControl+Enter', { size: 'sm' }))
      genBtn.disabled = busy || !hasSegs || isLive()
      extra.disabled = busy
      cancelBtn.hidden = !busy
      copyBtn.hidden = !md
      if (summaryParts.exportBtn) summaryParts.exportBtn.hidden = !s.summary?.markdown || busy
      renderMaterials()
      status.hidden = !busy && !summaryError.get(id)
      ui.clear(status)
      if (busy) status.append(ui.spinner(12), job.phase === 'items' ? (cls ? (s.materials?.length ? t('课堂笔记写好了，正在整理作业、把老师讲的对到课件上…') : t('课堂笔记写好了，正在整理作业和截止日期…')) : t('纪要写好了，正在提取待办和 DDL…')) : job.phase === 'html' ? (s.materials?.length ? t('正在做图文笔记：把老师讲的对到课件上…') : t('正在做图文笔记…')) : t(`正在生成{0}…`, noun))
      else if (summaryError.get(id)) status.append(el('span.summary-error', {}, icon('circle-alert', 14), summaryError.get(id)))
      prose.classList.toggle('is-generating', busy && job.phase === 'summary')
      ui.clear(emptyBox)
      if (!md) {
        prose.hidden = true
        if (!busy) {
          emptyBox.append(
            ui.emptyState({
              icon: cls ? 'notebook-pen' : 'file-text',
              title: hasSegs ? t(`还没有{0}`, noun) : cls ? t('这节课没有识别到内容') : t('这场会议没有识别到内容'),
              description: hasSegs
                ? cls
                  ? t('AI 会整理出本节概览、大纲和知识点、公式、老师强调的考点、作业、术语表和几道自测题，截图放在对应的位置。')
                  : t('AI 会整理出讨论要点、对方的意见、你要做的事和 DDL，待办会归到对应的项目。')
                : t('记录时没有出字幕，就没有可以整理的内容。'),
            }),
          )
          // 课堂：还没生成课堂笔记时，先看上课时的实时笔记
          if (cls && s.liveNotes) {
            notesPreview?.destroy()
            const v = (notesPreview = notesView({}))
            v.update(s.liveNotes)
            emptyBox.append(el('div.live-notes-preview', {}, sectionTitle(t('上课时的实时笔记')), v.root))
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
        img.addEventListener('click', () => openSlide(src, img.alt || t('截图')))
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
        if (r?.error === t('已取消')) ui.toast({ title: t('已取消生成') })
        else summaryError.set(sid, t(`没生成出来：{0}`, r?.error ?? t('未知错误')))
      } else {
        ui.toast({ title: isClass() ? t('课堂笔记生成好了') : t('纪要生成好了'), message: r.items?.length ? t(`提取出 {0} 条{1}`, r.items.length, isClass() ? t('作业') : t('待办')) : undefined, type: 'success', duration: r.html ? 8000 : undefined, action: r.html ? { label: t('看图文笔记'), onClick: () => go('meeting', { id: sid, tab: 'html' }) } : undefined })
        if (r.itemsError || r.htmlError) summaryError.set(sid, [r.itemsError, r.htmlError].filter(Boolean).join(t('；')))
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
    // 框架里的页面不能自己存东西（没有 allow-same-origin）：目录收起还是展开，页面发消息过来，这里记下（见 shared/notes-toc.js），每次把框架放回页面时写在地址里带回去
    const onFrameMessage = (e) => {
      if (htmlFrame?.contentWindow && e.source === htmlFrame.contentWindow) notesToc.accept(store, e.data)
    }
    window.addEventListener('message', onFrameMessage)
    ctx.dispose(() => window.removeEventListener('message', onFrameMessage))

    function renderHtml() {
      const job = state.summaries.get(id)
      const making = job?.phase === 'html'
      const has = Boolean(s.summary?.html) && !making
      const browserBtn = el('button.btn', { type: 'button', hidden: !has, disabled: Boolean(job), onClick: () => openHtml(browserBtn) }, icon('external-link', 14), t('用浏览器打开'))
      const pdfBtn = el('button.btn', { type: 'button', hidden: !has, disabled: Boolean(job), onClick: () => exportPdf(pdfBtn) }, icon('file-down', 14), t('导出 PDF'))
      const redoBtn = el('button.btn', { type: 'button', disabled: Boolean(job), title: t('照现在的课堂笔记和课件重新对一遍'), onClick: () => buildHtml() }, icon('refresh-cw', 14), s.summary?.html ? t('重新做') : t('做图文笔记'))
      const note = job
        ? [ui.spinner(12), making ? (s.materials?.length ? t('正在做图文笔记：把老师讲的对到课件上…') : t('正在做图文笔记…')) : t('课堂笔记正在生成，写好后图文笔记跟着重做')]
        : summaryError.get(id)
          ? [el('span.summary-error', {}, icon('circle-alert', 14), summaryError.get(id))]
          : has
            ? [t(`课件页插在老师讲到的地方，框出他对着讲的那几行{0}`, s.summary.htmlAt ? t(` · {0} 做的`, fmtClock(s.summary.htmlAt)) : '')]
            : []
      const bar = el('div.summary-toolbar.html-toolbar', {}, el('div.html-note.text-2.text-sm', {}, ...note), redoBtn, browserBtn, pdfBtn)
      let body = null
      if (has) {
        const src = `${new URL(s.summary.html, sessionBaseUrl(s)).href}?v=${s.summary.htmlAt ?? 0}`
        if (htmlFrame?.dataset.src !== src) htmlFrame = el('iframe.notes-frame', { title: t('图文笔记'), dataset: { src }, attrs: { src: notesToc.address(store, src), sandbox: 'allow-scripts allow-popups' } })
        body = htmlFrame
      } else if (!job)
        body = ui.emptyState({
          icon: 'book-open',
          title: t('还没有图文笔记'),
          description: s.materials?.length ? t('把老师讲的点对到课件上：课件页插在讲到的地方，框出他对着讲的那几行，旁边是讲了什么、时间和原话。') : t('没加课件时只放课上的截图。先在「课堂笔记」里加上老师的课件，效果好得多。'),
        })
      // 只换工具栏，别把框架拿下来再放回去（会重新加载、滚动位置丢掉）
      if (body && body === htmlFrame && htmlFrame.parentNode === panel && htmlBar?.parentNode === panel) htmlBar.replaceWith(bar)
      else {
        // 框架从页面上拿下来过（切了标签、重新做没成），放回去会照旧地址重新加载：先换成记下的选择，不然目录回到框架刚建出来时的样子
        if (body && body === htmlFrame) htmlFrame.setAttribute('src', notesToc.address(store, htmlFrame.dataset.src))
        fill(panel, bar, body)
      }
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
      if (failed(r)) summaryError.set(sid, t(`图文笔记没做出来：{0}`, r?.error ?? t('未知错误')))
      else if (r.htmlError) summaryError.set(sid, r.htmlError)
      if (ctx.alive() && id === sid) await reload()
    }

    async function openHtml(btn) {
      btn.classList.add('is-loading')
      const r = await call('openNotesHtml', id)
      btn.classList.remove('is-loading')
      if (failed(r)) ui.toast({ title: t('没能用浏览器打开'), message: r?.error, type: 'error' })
    }

    async function exportPdf(btn) {
      btn.classList.add('is-loading')
      const r = await call('exportNotesPdf', id)
      btn.classList.remove('is-loading')
      if (r == null) return // 取消了选位置
      if (failed(r)) return ui.toast({ title: t('没能导出 PDF'), message: r?.error, type: 'error' })
      ui.toast({ title: t('已导出 PDF'), message: r.openError ? t(`{0}（没能打开：{1}）`, r.file, r.openError) : r.file, type: 'success', duration: 5000 })
    }

    /* ---- 待办 ---- */

    let todoNav = null
    function renderTodos() {
      const cls = isClass()
      const items = (s.summary?.items ?? []).map((x) => ({ ...x, sessionId: id, sessionTitle: s.title, sessionStartedAt: s.startedAt }))
      const list = el('div.list', { role: 'listbox', 'aria-label': t('这场会议的待办') })
      const keep = todoNav?.selected()?.dataset.id
      todoNav?.destroy()
      todoNav = navList(list)
      wireTodoKeys(list, todoNav)
      const reBtn = el('button.btn.btn-sm', { type: 'button', disabled: state.summaries.has(id) || isLive(), hidden: !s.summary?.markdown }, icon('refresh-cw', 14), t('重新提取'))
      reBtn.addEventListener('click', async () => {
        reBtn.classList.add('is-loading')
        const r = await call('extractTodos', id)
        reBtn.classList.remove('is-loading')
        if (failed(r)) ui.toast({ title: t('没能提取'), message: r?.error, type: 'error' })
        else ui.toast({ title: r.itemsError ? t('提取出错') : t(`提取出 {0} 条待办`, r.items?.length ?? 0), message: r.itemsError, type: r.itemsError ? 'warning' : 'success' })
        if (ctx.alive()) reload()
      })
      fill(panel, 
        el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: cls ? t('生成课堂笔记时自动整理，作业会进这门课所在项目的待办。空格键勾选。') : t('生成纪要时自动提取，每条标到最相关的项目。点项目标签可以改归属，空格键勾选。') }), el('span.header-spacer'), reBtn),
        list,
      )
      if (!items.length) {
        const hw = cls ? notesList(s.liveNotes?.homework).map((x) => (typeof x === 'string' ? { text: x } : x)).filter((x) => x?.text) : []
        if (hw.length) {
          // 还没生成课堂笔记：先列出上课时实时笔记里记下的作业（只读）
          const box = el('div.list.hw-preview')
          for (const h of hw) {
            const due = dueInfo(h.due)
            box.append(ui.listItem({ icon: 'clipboard-list', title: h.text, subtitle: h.dueText ? t(`原话：{0}`, h.dueText) : null, twoLine: Boolean(h.dueText), accessories: due ? [{ tag: due.label, tint: due.tint }] : [] }))
          }
          list.replaceWith(el('div', {}, el('div.callout.callout-accent.hw-note', {}, icon('info', 16), el('div.callout-body', {}, el('div.callout-desc', { text: t('这是上课时实时笔记里记下的作业。生成课堂笔记后会变成能勾选的待办。') }))), box))
          return
        }
        list.replaceWith(
          ui.emptyState({
            icon: cls ? 'clipboard-list' : 'list-todo',
            title: cls ? t('没有作业') : t('没有待办'),
            description: s.summary?.markdown ? t(`{0}。觉得漏了可以点「重新提取」。`, cls ? t('课堂笔记里没有提到作业') : t('纪要里没有提到要做的事')) : cls ? t('先生成课堂笔记，作业和截止日期会一起整理出来。') : t('先生成纪要，待办和 DDL 会一起提取出来。'),
          }),
        )
        return
      }
      const onProject = (anchor, tv) =>
        projectMenu(anchor, {
          current: tv.projectId,
          title: t('这条待办归到'),
          onPick: async (pid) => {
            const r = await call('updateTodo', id, tv.id, { projectId: pid })
            if (failed(r)) ui.toast({ title: t('没能改归属'), message: r?.error, type: 'error' })
          },
        })
      const open = items.filter((x) => !x.done)
      const done = items.filter((x) => x.done)
      for (const tv of open) list.append(todoRow(tv, { showProject: true, showQuote: true, onProject, onOpen: () => {} }))
      if (done.length) {
        list.append(sectionTitle(t('已完成'), el('span.count.num', { text: String(done.length) })))
        for (const tv of done) list.append(todoRow(tv, { showProject: true, showQuote: true, onProject, onOpen: () => {} }))
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
          el('span.text-2.text-sm', { text: segs.length ? [t(`{0} {1} 段`, whoLabel('other', s.mode), who.other), who.me ? t(`我 {0} 段`, who.me) : null, questions ? t(`提问 {0} 次`, questions) : null, s.slides?.length ? t(`{0} 张截图`, s.slides.length) : null].filter(Boolean).join(' · ') : '' }),
          el('span.header-spacer'),
          el('button.btn.btn-sm', { type: 'button', disabled: !segs.length, onClick: () => copyText(transcriptText(s), t('字幕记录已复制')) }, icon('copy', 14), t('复制全文')),
        ),
        segs.length ? box : ui.emptyState({ icon: 'captions', title: t('没有字幕'), description: t('这场会议没有识别到内容。') }),
      )
    }

    /* ---- 截图（课堂） ---- */

    function renderSlides() {
      const list = [...(s.slides ?? [])].sort((a, b) => slideTime(a, s.startedAt) - slideTime(b, s.startedAt))
      ui.clear(panel)
      if (!list.length) {
        panel.append(ui.emptyState({ icon: 'image', title: t('这节课没有截图'), description: t('网课时点「截取画面」或按快捷键，当前屏幕上的课件就存进这节课的文件夹，课堂笔记会在对应的位置引用它。') }))
        return
      }
      const grid = el('div.slide-grid')
      for (const sl of list) {
        const tv = slideTime(sl, s.startedAt)
        const src = slideSrc(sl, s.dir)
        const label = t(`第 {0}`, fmtOffset(tv - s.startedAt))
        grid.append(
          el(
            'figure.slide-card',
            {},
            src
              ? el('button.slide-card-img', { type: 'button', 'aria-label': t(`放大 {0} 的截图`, label), onClick: () => openSlide(src, t(`截图 {0}`, fmtOffset(tv - s.startedAt))) }, el('img', { src, alt: label, loading: 'lazy' }))
              : el('div.slide-card-img.is-missing', {}, icon('image', 22)),
            el('figcaption.num', {}, el('span', { text: fmtOffset(tv - s.startedAt) }), el('span.text-3', { text: fmtTime(tv) })),
          ),
        )
      }
      panel.append(
        el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: t(`{0} 张截图，按上课时间排。点一下放大。`, list.length) }), el('span.header-spacer'), el('button.btn.btn-sm', { type: 'button', onClick: () => call('openFolder', id) }, icon('folder', 14), t('打开文件夹'))),
        grid,
      )
    }

    /* ---- AI 答题 ---- */

    function renderAnswers() {
      const list = (s.answers ?? []).filter((a) => a.text || a.error)
      ui.clear(panel)
      if (!list.length) {
        panel.append(ui.emptyState({ icon: 'sparkles', title: isClass() ? t('这节课没有 AI 回答') : t('这场会议没有 AI 回答'), description: t('对方一提问，AI 就会给出你可以照着说的回答，都会记在这里。') }))
        return
      }
      const box = el('div.answer-list.meeting-answers')
      for (const a of [...list].sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0))) {
        const c = answerCard({ ...a, done: true }, { live: false })
        c.root.prepend(el('span.answer-at.num', { text: fmtOffset((a.startedAt ?? s.startedAt) - s.startedAt) }))
        box.append(c.root)
      }
      panel.append(el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: t(`{0} 条回答，按时间先后。生成纪要时会参考。`, list.length) })), box)
    }

    /* ---- 术语 ---- */

    function renderTerms() {
      const list = glossary(s)
      ui.clear(panel)
      if (!list.length) {
        panel.append(ui.emptyState({ icon: 'book-open', title: t('没有术语'), description: t('开会时字幕里的专业词会带解释，都收在这里。可以在设置里打开「术语解释」。') }))
        return
      }
      const box = el('div.glossary.selectable')
      for (const tv of list) box.append(el('div.glossary-row', {}, el('div.glossary-term', {}, el('span', { text: tv.term }), tv.zh ? el('span.glossary-zh', { text: tv.zh }) : null), el('div.glossary-explain', { text: tv.explain })))
      panel.append(
        el(
          'div.panel-toolbar',
          {},
          el('span.text-2.text-sm', { text: t(`{0} 个术语`, list.length) }),
          el('span.header-spacer'),
          el('button.btn.btn-sm', { type: 'button', onClick: () => copyText(list.map((tv) => t(`{0}{1}：{2}`, tv.term, tv.zh ? t(`（{0}）`, tv.zh) : '', tv.explain)).join('\n'), t('术语已复制')) }, icon('copy', 14), t('复制')),
        ),
        box,
      )
    }

    function setTab(tv) {
      if (s && !tabList().includes(tv)) tv = 'summary'
      else if (!s && !CLASS_TABS.includes(tv) && !MEETING_TABS.includes(tv)) tv = 'summary'
      tab = tv
      ctx.setParam('tab', tv)
      for (const [k, b] of Object.entries(tabBtns)) {
        b.setAttribute('aria-selected', String(k === tv))
        b.tabIndex = k === tv ? 0 : -1
      }
      summaryParts = null
      page.classList.toggle('is-wide', tv === 'html')
      if (!s) return
      if (tv === 'summary') renderSummary()
      if (tv === 'html') renderHtml()
      if (tv === 'todos') renderTodos()
      if (tv === 'transcript') renderTranscript()
      if (tv === 'answers') renderAnswers()
      if (tv === 'terms') renderTerms()
      if (tv === 'slides') renderSlides()
      if (tv === 'notes') renderLiveNotes()
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
        fill(page, ui.emptyState({ icon: 'circle-alert', title: t('找不到这场会议'), description: r?.error || t('文件夹可能被移走或删掉了。'), action: { label: t('返回'), onClick: back } }))
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
        ui.toast({ title: t('这场会议已经删除') })
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
      return t(`[{0}] {1}{2}：{3}{4}`, fmtOffset(x.startedAt - s.startedAt), who, x.question ? t('（提问）') : '', x.text, tr ? `\n    ${tr}` : '')
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
  const add = (tv) => {
    if (!tv?.term || !tv.explain) return
    const k = String(tv.term).toLowerCase()
    const old = seen.get(k)
    if (!old) seen.set(k, { term: tv.term, zh: tv.zh || '', explain: tv.explain })
    else if (!old.zh && tv.zh) old.zh = tv.zh
  }
  for (const seg of s.segments ?? []) for (const sen of seg.sentences ?? []) for (const tv of sen.terms ?? []) add(tv)
  for (const tv of notesList(s.liveNotes?.terms)) add(tv)
  return [...seen.values()]
}
