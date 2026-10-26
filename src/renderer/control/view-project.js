'use strict'
// 项目页：标题区（图标、名字、一句描述，直接改）、在这个项目里开始会议、标签页（会议、待办与 DDL、资料）。
// 项目操作（改名、换颜色图标、归档、删除）在「…」菜单里。只是打开项目页不改当前项目（托盘和首页的开始按钮用它），
// 当前项目只在开始按钮的下拉、命令面板的「设为当前项目」、在某个项目里开始记录时改。

const MODE_OPTIONS = () => Object.entries(MODES).map(([value, m]) => ({ value, label: m.label, icon: m.icon }))
const SOURCE_OPTIONS = () => Object.entries(CLASS_SOURCES).map(([value, c]) => ({ value, label: t(`{0}（{1}）`, c.label, c.hint), icon: c.icon }))

/** 项目默认模式改了：本地先记上，开始按钮马上跟着变（主进程的 projects:changed 可能不带 mode）。 */
function rememberProjectMode(id, patch) {
  state.projectModes.set(id, { ...state.projectModes.get(id), ...patch })
  const row = projectOf(id)
  if (row) Object.assign(row, patch)
  if (state.modeChoice?.projectId === id) state.modeChoice = null
  emit('mode', null)
}

VIEWS.project = {
  mount(ctx) {
    const id = ctx.params.id
    let p = projectOf(id)
    if (!p) {
      ctx.header({ crumbs: [t('项目')] })
      ctx.body.append(ui.emptyState({ icon: 'folder', title: t('找不到这个项目'), description: t('可能已经删掉了。'), action: { label: t('回首页'), onClick: () => go('home') } }))
      return {}
    }
    const inbox = id === INBOX
    let tab = ctx.params.tab || 'meetings'
    const autoRename = Boolean(ctx.params.rename) && !inbox // 侧栏右键「改名」进来：项目名选中
    ctx.setParam('rename', false)
    let full = null // getProject：带会议背景、术语、我的资料、对方语言

    // 标题区
    const boxBtn = el('button.project-icon-button', { type: 'button', 'aria-label': t('换颜色和图标'), title: t('换颜色和图标'), onClick: () => appearanceModal(projectOf(id)) })
    const nameInput = el('input.input-bare.title-xl.project-name', { type: 'text', value: p.name, maxLength: 60, 'aria-label': t('项目名'), readOnly: inbox, spellcheck: false })
    const descInput = el('input.input-bare.project-desc', { type: 'text', value: p.description ?? '', maxLength: 200, placeholder: t('一句话说明这个项目（可选）'), 'aria-label': t('项目描述'), spellcheck: false })
    const stats = el('div.project-stats.text-2.text-sm')
    const startBtn = el('button.btn.btn-primary', { type: 'button', onClick: () => startMeeting(id) })
    const modeBtn = el('button.btn.btn-primary.btn-icon', { type: 'button', 'aria-label': t('换模式'), title: t('换模式'), onClick: () => startMenu(modeBtn, { projectId: id, showProjects: false }) }, icon('chevron-down', 14))
    const archivedNote = el('div')
    const heroActions = el('div.project-actions', {}, el('div.btn-group', {}, startBtn, modeBtn), el('button.btn', { type: 'button', onClick: () => call('openProjectFolder', id) }, icon('folder', 14), t('打开文件夹')))
    const hero = el('section.project-hero', {}, boxBtn, el('div.project-titles', {}, nameInput, descInput, stats))

    // 标签页
    const tabLabel = el('span', { text: modeInfo(projectMode(id)).label }) // 课堂项目写「课堂」、面试项目写「面试」，renderHero 里跟着模式改
    const tabBtns = {
      meetings: el('button.tab', { type: 'button', role: 'tab', dataset: { tab: 'meetings' } }, tabLabel, el('span.count.num')),
      todos: el('button.tab', { type: 'button', role: 'tab', dataset: { tab: 'todos' } }, t('待办与 DDL'), el('span.count.num')),
      info: el('button.tab', { type: 'button', role: 'tab', dataset: { tab: 'info' } }, t('资料')),
    }
    const tabs = el('div.tabs.project-tabs', { role: 'tablist', 'aria-label': t('项目内容') }, ...Object.values(tabBtns))
    const panel = el('div.tab-panel', { role: 'tabpanel' })
    const page = el('div.page.project-page', {}, hero, archivedNote, heroActions, tabs, panel)
    const scroller = el('div.pane-body', {}, page)
    ctx.body.append(scroller)
    wireTabs(tabs, (tv) => setTab(tv), panel)
    if (autoRename) requestAnimationFrame(() => (nameInput.focus(), nameInput.select()))

    const menuBtn = iconButton('ellipsis', t('项目操作'), () => projectActions(menuBtn))
    // 刚打开时列表还没取回来：取回来以后焦点还在标签上就挪到列表
    let wantListFocus = false
    const settleFocus = (list) => {
      if (!wantListFocus) return
      wantListFocus = false
      const a = document.activeElement
      if (a === document.body || tabs.contains(a)) list.focus({ preventScroll: true })
    }

    function renderHeader() {
      ctx.header({
        crumbs: [el('span.crumb.crumb-title', {}, projectBox(p, 'sm'), el('span.truncate', { text: p.name }))],
        actions: [p.archived ? el('span.tag', { text: t('已归档') }) : null, menuBtn],
      })
    }

    function renderHero() {
      fill(boxBtn, projectBox(p, 'lg'))
      if (document.activeElement !== nameInput) nameInput.value = p.name
      if (document.activeElement !== descInput) descInput.value = p.description ?? ''
      const pm = projectMode(id)
      tabLabel.textContent = modeInfo(pm).label
      const bits = [pm !== 'meeting' ? t(`默认{0}模式`, modeInfo(pm).label) : null, modeCopy(pm).count(p.meetings || 0), p.openTodos ? t(`{0} 条待办没做完`, p.openTodos) : t('没有待办'), p.lastMeetingAt ? t(`最近一次 {0}`, fmtDay(p.lastMeetingAt)) : null]
      if (inbox) bits.push(t('没分到项目的会议都在这里'))
      stats.textContent = bits.filter(Boolean).join(' · ')
      const st = state.engine.state
      const liveHere = st !== 'idle' && state.live?.projectId === id
      ui.clear(startBtn)
      const choice = startChoice(id)
      if (liveHere) startBtn.append(el('span.dot.dot-live'), liveMode() === 'class' ? t('正在这里上课，回到课堂') : t('正在这里开会，回到会议'))
      else startBtn.append(icon(choice.mode === 'meeting' ? 'mic' : modeInfo(choice.mode).icon, 14), t(`在这个项目里{0}`, startLabel(choice)), kbd('CommandOrControl+Shift+R', { size: 'sm' }))
      startBtn.disabled = p.archived || (st !== 'idle' && !liveHere) || state.starting
      modeBtn.hidden = liveHere
      modeBtn.disabled = startBtn.disabled
      startBtn.classList.toggle('is-loading', state.starting || st === 'starting')
      startBtn.onclick = liveHere ? () => go('live') : () => startMeeting(id, startChoice(id))
      ui.clear(archivedNote)
      if (p.archived)
        archivedNote.append(
          el(
            'div.callout.project-archived',
            {},
            icon('archive', 16),
            el('div.callout-body', {}, el('div.callout-title', { text: t('这个项目已归档') }), el('div.callout-desc', { text: t('不会出现在开会时的项目列表里，会议和待办都还在。') })),
            el('button.btn.btn-sm', { type: 'button', onClick: () => setArchived(false) }, t('取消归档')),
          ),
        )
      tabBtns.meetings.querySelector('.count').textContent = p.meetings ? String(p.meetings) : ''
      tabBtns.todos.querySelector('.count').textContent = p.openTodos ? String(p.openTodos) : ''
    }

    async function saveField(patch) {
      const r = await call('updateProject', id, patch)
      if (failed(r)) {
        ui.toast({ title: t('没能保存'), message: r?.error, type: 'error' })
        return false
      }
      if (r && typeof r === 'object') full = { ...full, ...r }
      return true
    }

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) nameInput.blur()
      if (e.key === 'Escape') {
        nameInput.value = p.name
        nameInput.blur()
        e.stopPropagation()
      }
    })
    nameInput.addEventListener('change', async () => {
      const name = nameInput.value.replace(/\s+/g, ' ').trim()
      if (!name || name === p.name) return (nameInput.value = p.name)
      if (await saveField({ name })) ui.toast({ title: t('已改名'), message: t('项目文件夹也跟着改了'), type: 'success' })
      else nameInput.value = p.name
    })
    descInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) descInput.blur()
      if (e.key === 'Escape') {
        descInput.value = p.description ?? ''
        descInput.blur()
        e.stopPropagation()
      }
    })
    descInput.addEventListener('change', () => saveField({ description: descInput.value.trim() }))

    function projectActions(anchor) {
      const items = [
        !inbox && { label: t('改名'), icon: 'pencil', onSelect: () => (nameInput.focus(), nameInput.select()) },
        { label: t('换颜色和图标…'), icon: 'star', onSelect: () => appearanceModal(projectOf(id)) },
        { label: t('打开文件夹'), icon: 'folder', onSelect: () => call('openProjectFolder', id) },
        { label: t('新建项目并复制这里的资料…'), icon: 'folder-plus', onSelect: () => newProjectModal({ copyFrom: id }) },
        !inbox && 'sep',
        !inbox && (p.archived ? { label: t('取消归档'), icon: 'archive', onSelect: () => setArchived(false) } : { label: t('归档'), icon: 'archive', onSelect: () => setArchived(true) }),
        !inbox && { label: t('删除项目…'), icon: 'trash', danger: true, onSelect: () => deleteProjectFlow(projectOf(id)) },
      ].filter(Boolean)
      ui.menu(anchor, items, { align: 'end', minWidth: 230 })
    }

    async function setArchived(archived) {
      if (archived && state.engine.state !== 'idle' && state.live?.projectId === id) return ui.toast({ title: t('这个项目里正在开会'), message: t('先停止记录再归档'), type: 'warning' })
      if (await saveField({ archived })) ui.toast({ title: archived ? t('已归档') : t('已取消归档'), type: 'success' })
    }

    /* ---- 会议 ---- */

    let meetingNav = null
    async function renderMeetings() {
      const list = el('div.list', { role: 'listbox', 'aria-label': t('会议') })
      const keep = meetingNav?.selected()?.dataset.id ?? ctx.params.sel
      meetingNav?.destroy()
      meetingNav = navList(list, { onSelect: (item) => ctx.setParam('sel', item.dataset.id) })
      const sessions = await call('listSessions', { projectId: id })
      if (!ctx.alive() || tab !== 'meetings') return
      fill(panel, list)
      if (!Array.isArray(sessions) || !sessions.length) {
        list.replaceWith(
          ui.emptyState({
            icon: 'message-square-text',
            title: modeCopy(projectMode(id)).empty,
            description: p.archived ? t('取消归档后就能在这里开会。') : t('点上面的「{0}」，记录就存在这个项目里。', t(`在这个项目里{0}`, startLabel(startChoice(id)))),
          }),
        )
        return
      }
      let group = null
      for (const s of sessions) {
        const g = meetingGroup(s.startedAt)
        if (g !== group) {
          list.append(sectionTitle(g))
          group = g
        }
        list.append(meetingRow(s, {}))
      }
      meetingNav.refresh(keep)
      if (document.activeElement !== list && !ctx.params.sel) meetingNav.select(-1)
      settleFocus(list)
    }

    /* ---- 待办与 DDL ---- */

    const DONE_KEY = `meetcaption.project.done`
    let todoNav = null
    async function renderTodos() {
      const includeDone = store(DONE_KEY) === '1'
      const list = el('div.list', { role: 'listbox', 'aria-label': t('待办') })
      const keep = todoNav?.selected()?.dataset.id ?? ctx.params.sel
      todoNav?.destroy()
      todoNav = navList(list, { onSelect: (item) => ctx.setParam('sel', item.dataset.id) })
      wireTodoKeys(list, todoNav)
      const items = await call('listTodos', { projectId: id, includeDone })
      if (!ctx.alive() || tab !== 'todos') return
      const toggle = ui.toggle({
        size: 'sm',
        checked: includeDone,
        label: t('显示已完成'),
        onChange: (v) => {
          store(DONE_KEY, v ? '1' : null)
          renderTodos()
        },
      })
      fill(panel, el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: t('归到这个项目的全部待办，包括别的项目的会议里提到的。空格键勾选。') }), el('span.header-spacer'), toggle), list)
      if (!Array.isArray(items) || !items.length) {
        list.replaceWith(ui.emptyState({ icon: 'list-todo', title: includeDone ? t('还没有待办') : t('没有要做的事'), description: t('会后生成纪要时，AI 会把待办和 DDL 提取出来，归到对应的项目。') }))
        return
      }
      renderTodoGroups(list, items, { showSource: true, showProject: false })
      todoNav.refresh(keep)
      if (document.activeElement !== list && !ctx.params.sel) todoNav.select(-1)
      settleFocus(list)
    }

    /* ---- 资料 ---- */

    async function renderInfo() {
      if (!full) full = await call('getProject', id)
      if (!ctx.alive() || tab !== 'info') return
      if (failed(full) || !full) {
        fill(panel, ui.emptyState({ icon: 'circle-alert', title: t('读不到项目资料'), description: full?.error }))
        full = null
        return
      }
      const saved = el('span.save-state.text-3.text-sm', { 'aria-live': 'polite' })
      const flash = (text) => {
        saved.textContent = text
        clearTimeout(flash.t)
        flash.t = setTimeout(() => (saved.textContent = ''), 1800)
      }
      const pending = {}
      const flush = debounce(async () => {
        const patch = { ...pending }
        for (const k of Object.keys(pending)) delete pending[k]
        if (!Object.keys(patch).length) return
        saved.textContent = t('正在保存…')
        if (await saveField(patch)) flash(t('已保存'))
        else saved.textContent = ''
      }, 600)
      ctx.dispose(() => flush.flush())
      const area = (key, label, hint, placeholder, rows) => {
        const tv = el('textarea.input', { rows, placeholder, value: full[key] ?? '', spellcheck: false, 'aria-label': label })
        tv.addEventListener('input', () => {
          pending[key] = tv.value
          flush()
        })
        tv.addEventListener('blur', () => flush.flush())
        return el('label.info-field', {}, el('span.info-label', { text: label }), el('span.info-hint', { text: hint }), tv)
      }
      // 对方语言和翻译成什么：德语课可以译成英语。本地识别和豆包只认中英文，选了别的语言提示换 Soniox 或 OpenAI（会员的云识别是 Soniox，不提示）
      const langWarn = el('div.info-hint.lang-warn', {}, icon('triangle-alert', 13), el('span', { text: t('本地识别和豆包只认中文和英文，这个语言要用 Soniox 或 OpenAI 识别。') }), el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => openSettings('asr') }, t('去换')))
      const multiAsr = () => {
        const s = state.settings ?? {}
        return s.plan === 'member' ? s.memberAsr !== 'local' : s.engine === 'openai' || s.engine === 'soniox'
      }
      const renderLangWarn = () => (langWarn.hidden = !(needsMultilingual(full.language ?? 'en') && !multiAsr()))
      const lang = ui.select({
        options: SOURCE_LANGS,
        value: full.language ?? 'en',
        width: 200,
        ariaLabel: t('对方语言'),
        onChange: (v) => {
          full.language = pending.language = v
          renderLangWarn()
          flush.flush()
        },
      })
      const globalTarget = () => t(`跟设置走（{0}）`, langLabel(state.settings?.translateTarget ?? 'zh'))
      const target = ui.select({
        options: [{ value: '', label: globalTarget() }, ...TARGET_LANGS],
        value: full.target ?? '',
        width: 200,
        ariaLabel: t('翻译成'),
        onChange: (v) => {
          pending.target = v
          flush.flush()
        },
      })
      renderLangWarn()
      ctx.on('settings', renderLangWarn)
      const srcWrap = el('div.info-sub')
      const modeSeg = ui.segmented({
        options: MODE_OPTIONS(),
        value: modeOf(full.mode ?? projectMode(id)),
        ariaLabel: t('默认模式'),
        onChange: (v) => {
          pending.mode = v
          srcWrap.hidden = v !== 'class'
          rememberProjectMode(id, { mode: v })
          flush.flush()
        },
      })
      const srcSeg = ui.segmented({
        options: SOURCE_OPTIONS(),
        value: sourceOf(full.classSource || state.settings?.class?.source),
        ariaLabel: t('上课的声音来源'),
        size: 'sm',
        onChange: (v) => {
          pending.classSource = v
          rememberProjectMode(id, { classSource: v })
          flush.flush()
        },
      })
      srcWrap.append(el('span.info-hint', { text: t('上课的声音来源：老师在教室里讲选「教室现场」，看网课选「网课」。') }), srcSeg)
      srcWrap.hidden = modeOf(full.mode ?? projectMode(id)) !== 'class'
      const modeField = el(
        'div.info-field',
        {},
        el('span.info-label', { text: t('默认模式') }),
        el('span.info-hint', { text: t('开始按钮默认用这个模式，开始前在下拉里也能临时换。面试：问完自动回答，答题框更显眼；课堂：AI 边听边记笔记，下课生成课堂笔记。') }),
        modeSeg,
        srcWrap,
      )
      fill(panel, 
        el(
          'div.info-form',
          {},
          el('div.panel-toolbar', {}, el('span.text-2.text-sm', { text: t('在这个项目里开会时，识别、翻译、AI 答题和纪要都用这里的资料。改了自动保存。') }), el('span.header-spacer'), saved),
          modeField,
          area('context', t('会议背景'), t('这个项目是做什么的、和谁开会。翻译、答题、纪要都会参考。'), t('比如：和导师讨论硕士论文，方向是带噪声标签的学习，导师说话语速快。'), 4),
          area('keywords', t('术语'), t('一行一个。识别会优先认出这些词，比如人名、模型名、缩写。'), 'ablation\nBonferroni correction\nWebVision', 4),
          area('profile', t('我的资料'), t('AI 答题时用来代入你的背景：简历要点、项目介绍、常被问到的问题和你想怎么答。'), t('比如：\n我在做带噪声标签的图像分类，模型是 ResNet-50 加一个去噪模块。\n在 WebVision 子集上去掉去噪模块掉 7.5 个点。'), 7),
          el('div.info-field', {}, el('span.info-label', { text: t('对方语言') }), el('span.info-hint', { text: t('识别按这个语言来；中英混着说就选自动识别。') }), lang, langWarn),
          el('div.info-field', {}, el('span.info-label', { text: t('翻译成') }), el('span.info-hint', { text: t('字幕下面的译文用什么语言。比如德语课想看英文就选英语；不选就跟设置里的一样。') }), target),
        ),
      )
    }

    function setTab(tv) {
      if (!['meetings', 'todos', 'info'].includes(tv)) tv = 'meetings'
      if (tv !== tab) ctx.setParam('sel', null)
      tab = tv
      ctx.setParam('tab', tv)
      for (const [k, b] of Object.entries(tabBtns)) {
        b.setAttribute('aria-selected', String(k === tv))
        b.tabIndex = k === tv ? 0 : -1
      }
      ui.clear(panel)
      if (tv === 'meetings') renderMeetings()
      if (tv === 'todos') renderTodos()
      if (tv === 'info') renderInfo()
    }

    renderHeader()
    renderHero()
    setTab(tab)

    ctx.on('projects', () => {
      const next = projectOf(id)
      if (!next) {
        if (!deletingProjects.has(id)) ui.toast({ title: t('这个项目已经删除') })
        return go('home', {}, { push: false })
      }
      p = next
      renderHeader()
      renderHero()
    })
    ctx.on('engine', renderHero)
    ctx.on('mode', renderHero)
    ctx.on(
      'sessions',
      debounce((e) => {
        if (tab === 'meetings' && (!e?.projectId || e.projectId === id || e.from === id)) renderMeetings()
      }, 200),
    )
    ctx.on(
      'todos',
      debounce(() => tab === 'todos' && renderTodos(), 250),
    )

    return {
      focus: () => {
        const list = tab !== 'info' && panel.querySelector('.list')
        if (list) return list.focus({ preventScroll: true })
        tabBtns[tab]?.focus({ preventScroll: true })
        wantListFocus = tab !== 'info'
      },
      setTab,
      cycleTab: (d) => setTab(cycle(['meetings', 'todos', 'info'], tab, d)),
    }
  },
}

function cycle(list, cur, d) {
  const i = list.indexOf(cur)
  return list[(i + d + list.length) % list.length]
}

/** 标签页：点击切换；获得焦点时左右键切换。 */
function wireTabs(tabs, onPick, panel) {
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.tab')
    if (b && !b.disabled) onPick(b.dataset.tab)
  })
  tabs.addEventListener('keydown', (e) => {
    // 下键从标签进到下面的列表
    if (e.key === 'ArrowDown' && panel?.querySelector('.list')) {
      e.preventDefault()
      return panel.querySelector('.list').focus({ preventScroll: true })
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const all = [...tabs.querySelectorAll('.tab:not([disabled]):not([hidden])')]
    const i = all.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    const next = all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length]
    onPick(next.dataset.tab)
    next.focus()
  })
}

function meetingGroup(tv) {
  const n = daysFromToday(tv)
  if (n === 0) return t('今天')
  if (n === -1) return t('昨天')
  if (n > -7) return t('最近 7 天')
  const d = new Date(tv)
  const thisYear = d.getFullYear() === new Date().getFullYear()
  // 简体中文照旧写「10月」「2025年10月」（Intl 给的是「十月」「2025/10」）
  if (UI_LANG === 'zh') return `${thisYear ? '' : `${d.getFullYear()}年`}${d.getMonth() + 1}月`
  return fmtDate(d, thisYear ? { month: 'long' } : { year: 'numeric', month: 'long' })
}

/** 按截止日期分组画待办（已完成的放最后一组）。 */
function renderTodoGroups(list, items, opts) {
  const groups = new Map(DUE_GROUPS.map(([k]) => [k, []]))
  const done = []
  for (const tv of items) (tv.done ? done : groups.get(dueBucket(tv.due))).push(tv)
  const open = (tv) => go('meeting', { id: tv.sessionId, tab: 'todos' })
  const onProject = opts.showProject
    ? (anchor, tv) =>
        projectMenu(anchor, {
          current: tv.projectId,
          title: t('这条待办归到'),
          onPick: async (pid) => {
            const r = await call('updateTodo', tv.sessionId, tv.id, { projectId: pid })
            if (failed(r)) ui.toast({ title: t('没能改归属'), message: r?.error, type: 'error' })
            else ui.toast({ title: t(`已归到「{0}」`, projectName(pid)), type: 'success' })
          },
        })
    : null
  for (const [k, label] of DUE_GROUPS) {
    const g = groups.get(k)
    if (!g.length) continue
    list.append(sectionTitle(label, el('span.count.num', { text: String(g.length) })))
    if (k === 'overdue') list.lastChild.classList.add('is-overdue')
    for (const tv of g) list.append(todoRow(tv, { ...opts, onOpen: open, onProject }))
  }
  if (done.length) {
    list.append(sectionTitle(t('已完成'), el('span.count.num', { text: String(done.length) })))
    for (const tv of done) list.append(todoRow(tv, { ...opts, onOpen: open, onProject }))
  }
}

/* ---------------- 新建项目、外观、删除 ---------------- */

function colorIconPicker({ color, icon: iconName }, onChange) {
  let c = color
  let ic = iconName
  const preview = el('span.picker-preview')
  const swatches = el('div.swatch-row', { role: 'radiogroup', 'aria-label': t('颜色') })
  const icons = el('div.icon-grid', { role: 'radiogroup', 'aria-label': t('图标') })
  const sync = () => {
    fill(preview, ui.iconBox(ic, c, { size: 'lg' }))
    for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.value === c))
    for (const b of icons.children) {
      b.setAttribute('aria-checked', String(b.dataset.value === ic))
      b.dataset.tint = c
    }
    onChange({ color: c, icon: ic })
  }
  for (const tv of ui.tints) {
    swatches.append(el('button.swatch', { type: 'button', role: 'radio', dataset: { value: tv, tint: tv }, 'aria-label': tv, onClick: () => ((c = tv), sync()) }))
  }
  for (const n of ui.projectIcons) {
    icons.append(el('button.icon-choice', { type: 'button', role: 'radio', dataset: { value: n }, 'aria-label': n, onClick: () => ((ic = n), sync()) }, icon(n, 16)))
  }
  sync()
  return el('div.picker', {}, preview, el('div.picker-body', {}, swatches, icons))
}

function newProjectModal({ copyFrom = null } = {}) {
  const name = el('input.input', { type: 'text', placeholder: t('比如：硕士论文、实习面试、实验室周会'), maxLength: 60, spellcheck: false })
  const desc = el('input.input', { type: 'text', placeholder: t('一句话说明（可选）'), maxLength: 200, spellcheck: false })
  const nameHint = el('div.form-hint')
  let mode = copyFrom ? projectMode(copyFrom) : 'meeting'
  let classSource = sourceOf(copyFrom ? projectOf(copyFrom)?.classSource || state.projectModes.get(copyFrom)?.classSource : state.settings?.class?.source)
  const modeHint = el('div.form-hint')
  // 课堂要先定听哪里：教室现场用麦克风，网课听电脑声音；只在选了课堂时出现
  const sourceHint = el('div.form-hint')
  const sourceSeg = ui.segmented({
    options: Object.entries(CLASS_SOURCES).map(([value, info]) => ({ value, label: t(`{0}（{1}）`, info.label, info.hint), icon: info.icon })),
    value: classSource,
    ariaLabel: t('声音来源'),
    block: true,
    onChange: (v) => ((classSource = v), (sourceHint.textContent = CLASS_SOURCES[v].desc)),
  })
  sourceHint.textContent = CLASS_SOURCES[classSource].desc
  const sourceField = el('div.stack-field', {}, el('span.info-label', { text: t('声音来源') }), sourceSeg, sourceHint)
  const syncModeHint = () => ((modeHint.textContent = modeInfo(mode).desc), (sourceField.hidden = mode !== 'class'))
  const modeSeg = ui.segmented({ options: MODE_OPTIONS(), value: mode, ariaLabel: t('默认模式'), block: true, onChange: (v) => ((mode = v), syncModeHint()) })
  const used = new Set(ui.tints.slice(1))
  const n = state.projects.length
  let look = { color: [...used][n % used.size], icon: 'folder' }
  const copy = ui.select({
    options: [{ value: '', label: t('不复制，从空白开始') }, ...activeProjects().map((p) => ({ value: p.id, label: t(`复制「{0}」的资料`, p.name), icon: projectIconName(p), tint: projectTint(p) }))],
    value: copyFrom ?? '',
    block: true,
  })
  const body = el(
    'div.new-project',
    {},
    el('label.stack-field', {}, el('span.info-label', { text: t('名字') }), name, nameHint),
    el('label.stack-field', {}, el('span.info-label', { text: t('描述') }), desc),
    el('div.stack-field', {}, el('span.info-label', { text: t('默认模式') }), modeSeg, modeHint),
    sourceField,
    el('div.stack-field', {}, el('span.info-label', { text: t('颜色和图标') }), colorIconPicker(look, (v) => (look = v))),
    el('div.stack-field', {}, el('span.info-label', { text: t('会议背景、术语、我的资料') }), copy, el('div.form-hint', { text: t('建好以后在项目的「资料」里还能改。') })),
  )
  syncModeHint()
  ui.modal({
    title: t('新建项目'),
    description: t('每场会议都属于一个项目。项目里的会议背景、术语和我的资料，开会时会用上。'),
    body,
    width: 480,
    initialFocus: 'input',
    actions: [
      { label: t('取消') },
      {
        label: t('创建'),
        kind: 'primary',
        onClick: async () => {
          const v = name.value.replace(/\s+/g, ' ').trim()
          if (!v) {
            name.setAttribute('aria-invalid', 'true')
            nameHint.textContent = t('起个名字')
            nameHint.classList.add('is-error')
            name.focus()
            return false
          }
          const r = await call('createProject', { name: v, description: desc.value.trim(), color: look.color, icon: look.icon, mode, classSource: mode === 'class' ? classSource : undefined, copyFrom: copy.value || undefined })
          if (failed(r) || !r?.id) {
            nameHint.textContent = r?.error || t('没能创建')
            nameHint.classList.add('is-error')
            return false
          }
          // projects:changed 可能还没到，先放进列表，项目页才找得到
          if (!projectOf(r.id)) state.projects.push({ ...r, meetings: 0, openTodos: 0 })
          state.projectModes.set(r.id, { mode: r.mode ?? mode, classSource: r.classSource })
          ui.toast({ title: t(`建好了「{0}」`, r.name), type: 'success' })
          // 刚建的项目多半接着就要用：设成当前项目（只是打开项目页不会改）
          setCurrentProject(r.id)
          go('project', { id: r.id, tab: 'info' }, { root: true })
        },
      },
    ],
  })
  name.addEventListener('input', () => {
    name.removeAttribute('aria-invalid')
    nameHint.textContent = ''
    nameHint.classList.remove('is-error')
  })
}

function appearanceModal(p) {
  if (!p) return
  let look = { color: projectTint(p), icon: projectIconName(p) }
  ui.modal({
    title: t(`「{0}」的颜色和图标`, p.name),
    body: colorIconPicker(look, (v) => (look = v)),
    width: 420,
    actions: [
      { label: t('取消') },
      {
        label: t('保存'),
        kind: 'primary',
        onClick: async () => {
          const r = await call('updateProject', p.id, look)
          if (failed(r)) {
            ui.toast({ title: t('没能保存'), message: r?.error, type: 'error' })
            return false
          }
        },
      },
    ],
  })
}

const deletingProjects = new Set() // 自己删的项目：项目页收到 projects:changed 时不再弹「已经删除」

async function deleteProjectFlow(p) {
  if (!p || p.id === INBOX) return
  const ok = await ui.confirm({
    title: t(`删除「{0}」？`, p.name),
    message: t(`{0}项目文件夹移到废纸篓，还能找回。`, p.meetings ? t(`这个项目里的 {0} 场会议会移到「未归类」，`, p.meetings) : ''),
    okLabel: t('删除'),
    danger: true,
  })
  if (!ok) return
  deletingProjects.add(p.id)
  const r = await call('deleteProject', p.id)
  setTimeout(() => deletingProjects.delete(p.id), 3000)
  if (failed(r)) return ui.toast({ title: t('没能删除'), message: r?.error, type: 'error' })
  ui.toast({ title: t(`已删除「{0}」`, p.name), message: r?.moved ? t(`{0} 场会议移到了「未归类」`, r.moved) : undefined, type: 'success' })
  if (router.current?.name === 'project' && router.current.id === p.id) go('home', {}, { push: false })
}
