'use strict'
// 首页：开始会议（带项目选择）、没配置好的项、最近 3 天的会议、逾期和 7 天内到期的待办。

VIEWS.home = {
  mount(ctx) {
    ctx.header({ crumbs: [el('span.crumb.crumb-title', { text: t('首页') })] })

    const hero = el('section.home-hero')
    const guide = el('div.home-guide')
    const recentList = el('div.list', { role: 'listbox', 'aria-label': t('最近的会议') })
    const todoList = el('div.list', { role: 'listbox', 'aria-label': t('快到期的待办') })
    const recentTitle = sectionTitle(t('最近 3 天'))
    const todoTitle = sectionTitle(t('快到期的待办'))
    const page = el('div.page.home', {}, hero, guide, el('section.home-section', {}, recentTitle, recentList), el('section.home-section', {}, todoTitle, todoList))
    ctx.body.append(el('div.pane-body', {}, page))

    const recentNav = navList(recentList)
    const todoNav = navList(todoList)
    wireTodoKeys(todoList, todoNav)
    ctx.dispose(() => (recentNav.destroy(), todoNav.destroy()))

    let startBtn = null

    function renderHero() {
      ui.clear(hero)
      const now = Date.now()
      hero.append(el('div.home-date', {}, el('span.title-2xl', { text: `${fmtMonthDay(now)} ${WEEK[new Date(now).getDay()]}` })))
      const st = state.engine.state
      if (st === 'running' || st === 'stopping') {
        const live = state.live
        const doing = { meeting: t('开会'), interview: t('面试'), class: t('上课') }[liveMode()]
        hero.append(
          el(
            'div.callout.callout-accent.home-live',
            {},
            el('span.dot.dot-live'),
            el(
              'div.callout-body',
              {},
              el('div.callout-title', { text: state.engine.paused ? t(`「{0}」里的{1}已暂停`, projectName(live?.projectId), doing) : t(`正在「{0}」里{1}`, projectName(live?.projectId), doing) }),
              el('div.callout-desc.num', {}, t('已经开了 '), el('span', { dataset: { elapsed: '' }, text: live?.startedAt ? fmtOffset(now - live.startedAt) : '' })),
            ),
            el('button.btn', { type: 'button', onClick: togglePause, disabled: st === 'stopping' }, icon(state.engine.paused ? 'play' : 'pause', 14), state.engine.paused ? t('继续') : t('暂停')),
            el('button.btn', { type: 'button', onClick: stopMeeting, disabled: st === 'stopping' }, icon('square', 14), t('停止')),
            (startBtn = el('button.btn.btn-primary', { type: 'button', onClick: () => go('live') }, liveMode() === 'class' ? t('回到课堂') : t('回到会议'), keyHint('live'))),
          ),
        )
        return
      }
      const cur = projectOf(state.currentProjectId)
      const loading = st === 'starting' || state.starting
      const choice = startChoice(state.currentProjectId)
      const m = modeInfo(choice.mode)
      startBtn = el(
        'button.btn.btn-primary.btn-lg.home-start',
        { type: 'button', class: loading ? 'is-loading' : '', onClick: () => startMeeting(state.currentProjectId, choice) },
        icon(choice.mode === 'meeting' ? 'mic' : m.icon, 18),
        el('span.truncate', { text: t(`在「{0}」里{1}`, cur?.name ?? t('未归类'), startLabel(choice)) }),
        keyHint('start'),
      )
      const pick = el('button.btn.btn-primary.btn-lg.btn-icon', {
        type: 'button',
        'aria-label': t('换项目或模式'),
        title: t('换项目或模式'),
        disabled: loading,
        onClick: () => startMenu(pick),
      }, icon('chevron-down', 16))
      const s = state.settings ?? {}
      const hints = []
      if (s.hotkeyToggle) hints.push(el('span', {}, t('字幕和答题框会出现在屏幕上，'), kbd(s.hotkeyToggle, { size: 'sm' }), t(' 显示或隐藏')))
      if (s.hotkeyRecord) hints.push(el('span', {}, t('在会议软件里按 '), kbd(s.hotkeyRecord, { size: 'sm' }), t(' 直接开始或停止记录')))
      if (choice.mode === 'class') {
        if (s.class?.hotkeySlide) hints.push(el('span', {}, kbd(s.class.hotkeySlide, { size: 'sm' }), t(' 截取画面（网课课件）')))
      } else if (s.assist?.enabled && s.assist.hotkeyAsk) hints.push(el('span', {}, kbd(s.assist.hotkeyAsk, { size: 'sm' }), t(' 让 AI 回答刚才的问题')))
      // 只有「未归类」的时候提一句项目是干什么的
      const onlyInbox = !activeProjects().some((p) => p.id !== INBOX)
      const projectHint = onlyInbox
        ? el('div.home-hints.text-2.text-sm', {}, el('span', { text: t('会议放在项目里，每个项目有自己的会议背景、术语和我的资料。') }), el('button.list-more', { type: 'button', onClick: () => newProjectModal() }, t('建第一个项目'), icon('arrow-right', 14)))
        : null
      // 开始按钮旁边一直显示这个项目的语言对，点开就能改（design/onboarding-v2：回答「语言在哪设置」）
      const langBtn = el('button.btn.btn-lg.home-lang', { type: 'button', title: t('对方说的语言和翻成的语言'), onClick: () => langMenu(langBtn, state.currentProjectId) }, icon('languages', 16), el('span.home-lang-pair'), icon('chevron-down', 14))
      fillLangButton(langBtn, state.currentProjectId)
      hero.append(...[el('div.home-start-row', {}, el('div.btn-group', {}, startBtn, pick), langBtn), hints.length ? el('div.home-hints.text-2.text-sm', {}, ...hints) : null, projectHint].filter(Boolean))
    }

    function renderGuide() {
      ui.clear(guide)
      const ob = state.onboarding ?? {}
      const s = state.settings ?? {}
      const steps = []
      if (!ob.asr) steps.push({ title: t('语音识别还没配好'), desc: t('选本地识别，或填上 Soniox、豆包、OpenAI 的密钥，才能出字幕。'), label: t('去设置'), run: () => openSettings('asr') })
      if (!ob.ai)
        steps.push({
          title: t('AI 服务还没连上'),
          desc: state.llm?.reason ? t(`{0}。翻译、会后纪要和 AI 答题都要用。`, state.llm.reason) : t('用 ChatGPT 账号登录或填 API Key，翻译、会后纪要和 AI 答题才能用。'),
          label: s.llmProvider === 'chatgpt' ? t('去登录') : t('去设置'),
          run: () => openSettings('ai'),
        })
      if (!ob.voiceprint && s.captureMic !== false)
        steps.push({ title: t('还没录声纹'), desc: t('录 12 秒，软件就能分清哪句是你说的，外放时串进麦克风的对方声音也能滤掉。'), label: t('去录声纹'), run: () => openSettings('voiceprint') })
      if (steps.length) {
        const first = steps[0]
        guide.append(
          el(
            'div.callout.callout-accent',
            {},
            icon('sparkles', 16),
            el(
              'div.callout-body',
              {},
              el('div.callout-title', { text: steps.length > 1 ? t(`还差 {0} 步就能用全了：{1}`, steps.length, first.title) : first.title }),
              el('div.callout-desc', { text: first.desc }),
            ),
            !ob.done ? el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => call('openOnboarding') }, t('打开引导')) : null,
            el('button.btn.btn-sm', { type: 'button', onClick: first.run }, first.label),
          ),
        )
      }
      const hk = state.hotkey ?? {}
      // 主进程的提示里是 Electron 的写法（CommandOrControl+Alt+S），换成 ⌥⌘S 这种
      const errs = [hk.error, hk.record?.error, hk.ask?.error].filter(Boolean).map((t) => t.replace(/\b(?:CommandOrControl|Command|Control|Ctrl|Alt|Option|Shift|Super)(?:\+[^\s+，。]+)+/g, (a) => ui.accelText(a)))
      if (errs.length)
        guide.append(
          el(
            'div.callout.callout-warn',
            {},
            icon('triangle-alert', 16),
            el('div.callout-body', {}, el('div.callout-title', { text: t('有快捷键没注册上') }), el('div.callout-desc', { text: errs.join(t('；')) })),
            el('button.btn.btn-sm', { type: 'button', onClick: () => openSettings('hotkeys') }, t('换快捷键')),
          ),
        )
      guide.hidden = !guide.children.length
    }

    async function loadRecent() {
      const list = await call('listSessions', {})
      if (!ctx.alive() || !Array.isArray(list)) return
      const since = startOfDay() - 2 * DAY
      const recent = list.filter((s) => s.startedAt >= since)
      const keep = recentNav.selected()?.dataset.id
      ui.clear(recentList)
      recentTitle.querySelector('span').textContent = recent.length ? t(`最近 3 天 · {0} 场`, recent.length) : t('最近 3 天')
      if (!recent.length) recentList.append(el('div.list-empty', { text: list.length ? t('最近 3 天没有开会。') : t('还没有会议记录。开完第一场会，这里就能看到。') }))
      for (const s of recent) recentList.append(meetingRow(s, { showProject: true }))
      recentNav.refresh(keep)
      if (document.activeElement !== recentList) recentNav.select(-1)
    }

    async function loadTodos() {
      const list = await call('listTodos', {})
      if (!ctx.alive() || !Array.isArray(list)) return
      const soon = list.filter((t) => {
        const info = dueInfo(t.due)
        return info && info.days < 7
      })
      const keep = todoNav.selected()?.dataset.id
      ui.clear(todoList)
      todoTitle.querySelector('span').textContent = soon.length ? t(`快到期的待办 · {0}`, soon.length) : t('快到期的待办')
      if (!soon.length) todoList.append(el('div.list-empty', { text: list.length ? t(`7 天内没有到期的待办。一共还有 {0} 条没做完。`, list.length) : t('没有待办。会后生成纪要时，AI 会把待办和 DDL 提取出来。') }))
      for (const t of soon) todoList.append(todoRow(t, { showProject: true, showSource: true, onOpen: (x) => go('meeting', { id: x.sessionId, tab: 'todos' }) }))
      if (list.length > soon.length && soon.length)
        todoList.append(el('button.list-more', { type: 'button', onClick: () => go('todos') }, t(`查看全部 {0} 条待办`, list.length), icon('arrow-right', 14)))
      todoNav.refresh(keep)
      if (document.activeElement !== todoList) todoNav.select(-1)
    }

    renderHero()
    renderGuide()
    loadRecent()
    loadTodos()
    ctx.on('engine', renderHero)
    ctx.on('projects', () => (renderHero(), loadRecent()))
    ctx.on('settings', renderHero)
    ctx.on('mode', renderHero)
    ctx.on('status', renderGuide)
    ctx.on('sessions', debounce(loadRecent, 200))
    ctx.on('todos', debounce(loadTodos, 250))
    // 过了零点「最近 3 天」和「今天到期」要变
    ctx.every(() => {
      if (new Date().getHours() === 0 && new Date().getMinutes() === 0) (loadRecent(), loadTodos(), renderHero())
    }, 60_000)

    return { focus: () => startBtn?.focus({ preventScroll: true }) }
  },
}

/** 首页语言按钮上的「English → 简体中文」：项目的对方语言，翻成（项目没设就跟设置）。 */
async function fillLangButton(btn, id) {
  const p = await call('getProject', id)
  if (!btn.isConnected || !p) return
  const src = p.language ?? 'en'
  const tgt = p.target || state.settings?.translateTarget || 'zh'
  btn.querySelector('.home-lang-pair').replaceChildren(el('span', { lang: src, text: langLabel(src) }), icon('arrow-right', 13), el('span', { lang: tgt, text: langLabel(tgt) }))
}

/** 语言按钮的菜单：对方说的语言、翻成（各开一个能搜索的列表），或者去项目的「资料」页。改的是这个项目的。 */
async function langMenu(anchor, id) {
  const p = await call('getProject', id)
  if (!p) return
  const s = state.settings ?? {}
  const list = (which) => {
    const options = which === 'src' ? SOURCE_LANGS : [{ value: '', label: t(`跟设置走（{0}）`, langLabel(s.translateTarget ?? 'zh')) }, ...TARGET_LANGS]
    const cur = which === 'src' ? (p.language ?? 'en') : (p.target ?? '')
    ui.menu(
      anchor,
      options.map((o) => ({
        label: o.label,
        hint: o.hint,
        keywords: o.keywords,
        checked: o.value === cur,
        onSelect: async () => {
          const r = await call('updateProject', id, which === 'src' ? { language: o.value } : { target: o.value })
          if (failed(r)) ui.toast({ title: t('没能保存'), message: r?.error, type: 'error' })
        },
      })),
      { searchable: true, placeholder: t('搜索语言，比如 Deutsch、德语、de'), minWidth: 280 },
    )
  }
  ui.menu(
    anchor,
    [
      { section: t(`「{0}」的语言`, projectName(id)) },
      { label: t('对方说的语言'), icon: 'mic', hint: langLabel(p.language ?? 'en'), onSelect: () => setTimeout(() => list('src')) },
      { label: t('翻成'), icon: 'languages', hint: langLabel(p.target || s.translateTarget || 'zh'), onSelect: () => setTimeout(() => list('tgt')) },
      'sep',
      { label: t('在项目的「资料」页改…'), icon: 'pencil', onSelect: () => go('project', { id, tab: 'info' }) },
    ],
    { minWidth: 260 },
  )
}

/** 会议列表的一行：标题（没有就用时间）、副标题、右侧时长和有没有纪要。 */
function meetingRow(s, { showProject = false, onOpen } = {}) {
  const sub = []
  if (showProject) sub.push(projectName(s.projectId))
  sub.push(showProject ? fmtWhen(s.startedAt) : s.title ? fmtWhen(s.startedAt) : WEEK[new Date(s.startedAt).getDay()])
  if (s.count) sub.push(t(`{0} 段`, s.count))
  const acc = []
  if (s.live) acc.push(el('span.tag.tag-error', {}, el('span.dot.dot-live'), t('进行中')))
  if (s.mode === 'class' || s.mode === 'interview') acc.push(el('span.tag.mode-tag', { dataset: { tint: modeInfo(s.mode).tint } }, icon(modeInfo(s.mode).icon, 12), modeInfo(s.mode).label))
  if (s.todos) acc.push({ icon: 'circle-check', text: String(s.todos), title: t(`{0} 条待办没做完`, s.todos) })
  if (s.answers) acc.push({ icon: 'sparkles', text: String(s.answers), title: t(`{0} 条 AI 回答`, s.answers) })
  if (!s.live) acc.push(el('span.num.meeting-duration', { text: s.durationMs != null ? fmtDuration(s.durationMs) : '' }))
  acc.push(
    el('span.summary-mark', { class: s.hasSummary ? 'has-summary' : '', title: s.hasSummary ? t('有纪要') : t('还没有纪要') }, icon('file-text', 14)),
  )
  const row = ui.listItem({
    id: s.id,
    icon: showProject ? projectIconName(projectOf(s.projectId)) : 'message-square-text',
    tint: showProject ? projectTint(projectOf(s.projectId)) : undefined,
    title: s.title || t(`{0} 的{1}`, fmtDateTime(s.startedAt), modeInfo(s.mode).label),
    subtitle: sub.join(' · '),
    twoLine: true,
    accessories: acc,
    className: s.title ? '' : 'is-untitled',
    onClick: () => (onOpen ? onOpen(s) : go('meeting', { id: s.id })),
  })
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    meetingContextMenu({ x: e.clientX, y: e.clientY }, s)
  })
  return row
}

/** 会议行的右键菜单：打开、改标题、生成纪要、移到别的项目、打开文件夹、删除。正在记录的不能移动和删除。 */
function meetingContextMenu(anchor, s) {
  const cls = s.mode === 'class'
  const noun = cls ? t('这节课') : t('这场会议')
  const items = [
    { label: t('打开'), icon: 'arrow-right', onSelect: () => go('meeting', { id: s.id }) },
    { label: t('改标题'), icon: 'pencil', onSelect: () => go('meeting', { id: s.id, rename: true }) },
    !s.live && !s.hasSummary && { label: cls ? t('生成课堂笔记') : t('生成纪要'), icon: cls ? 'notebook-pen' : 'sparkles', onSelect: () => go('meeting', { id: s.id, tab: 'summary', summarize: true }) },
    {
      label: t('移到别的项目…'),
      icon: 'folder',
      disabled: Boolean(s.live),
      onSelect: () =>
        projectMenu(anchor, {
          current: s.projectId,
          title: t('移到哪个项目'),
          onPick: async (pid) => {
            if (pid === s.projectId) return
            const r = await call('moveSession', s.id, pid)
            if (failed(r) || !r?.id) return ui.toast({ title: t('没能移动'), message: r?.error, type: 'error' })
            ui.toast({ title: t(`已移到「{0}」`, projectName(pid)), type: 'success' })
          },
        }),
    },
    { label: t('打开文件夹'), icon: 'external-link', onSelect: () => call('openFolder', s.id) },
    'sep',
    {
      label: t(`删除{0}…`, noun),
      icon: 'trash',
      danger: true,
      disabled: Boolean(s.live),
      onSelect: async () => {
        const r = await call('removeSession', s.id)
        if (r === true) ui.toast({ title: t('已删除'), message: t('文件夹移到了废纸篓'), type: 'success' })
        else if (failed(r) && r?.error) ui.toast({ title: t('没能删除'), message: r.error, type: 'error' })
      },
    },
  ].filter(Boolean)
  ui.menu(anchor, items, { minWidth: 220 })
}
