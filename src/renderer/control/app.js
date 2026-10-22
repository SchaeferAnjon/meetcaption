'use strict'
// 启动：读 init()，接主进程事件，注册页面内快捷键，打开首页（开会中打开的就到会议进行中）。

function resetLive(st) {
  state.live = {
    sessionId: st.sessionId ?? null,
    projectId: st.projectId ?? state.currentProjectId,
    startedAt: st.startedAt ?? Date.now(),
    endedAt: null,
    segs: new Map(),
    answers: new Map(),
    ended: false,
    dismissed: false,
    // v4
    mode: modeOf(st.mode ?? state.pendingStart?.mode),
    classSource: st.classSource ?? state.pendingStart?.classSource ?? null,
    dir: st.dir ?? st.sessionDir ?? null, // 会议文件夹（截图缩略图要用）
    notes: null, // 课堂实时笔记 { sections, emphasis, homework, terms }
    notesAt: 0,
    notesError: '',
    slides: [], // [{ file, at }]
  }
}

// engine:state 和 init 的 snapshot 里带的 v4 字段：模式、声音来源、文件夹、实时笔记、截图
function applyLiveExtras(src) {
  const live = state.live
  if (!live || !src) return
  if (src.mode) live.mode = modeOf(src.mode)
  if (src.classSource) live.classSource = src.classSource
  if (src.dir || src.sessionDir) live.dir = src.dir || src.sessionDir
  if (src.liveNotes && !live.notes) {
    live.notes = src.liveNotes
    live.notesAt = src.liveNotesAt ?? live.notesAt
  }
  if (Array.isArray(src.slides) && !live.slides.length) live.slides = [...src.slides]
}

async function refreshLlm() {
  const r = await call('llmStatus')
  if (!failed(r) && r) state.llm = r
  emit('status')
}

function onEngineState(st) {
  const prev = state.engine.state
  state.engine = st
  if (st.state === 'running' && prev !== 'running') {
    if (state.live?.sessionId !== st.sessionId || state.live?.ended) {
      resetLive(st)
      clearNotices()
      emit('live-reset')
    }
    state.live.projectId = st.projectId ?? state.live.projectId
    state.live.startedAt = st.startedAt ?? state.live.startedAt
    applyLiveExtras(st)
    state.pendingStart = null
    if (router.current?.name !== 'live') go('live')
  }
  if (st.state === 'idle' && prev !== 'idle') {
    clearLiveNotices()
    if (state.live && prev !== 'starting') {
      state.live.ended = true
      state.live.endedAt = Date.now()
      if (st.lastSessionId) state.live.sessionId = st.lastSessionId
      state.live.dismissed = router.current?.name !== 'live'
      if (router.current?.name !== 'live' && st.lastSessionId) {
        const sid = st.lastSessionId
        const noun = modeInfo(state.live.mode).label
        ui.toast({ title: `${noun}记录已保存`, message: `「${projectName(state.live.projectId)}」`, type: 'success', action: { label: '查看', onClick: () => go('meeting', { id: sid }) } })
      }
    }
    if (st.error) addNotice('error', `没能开始：${st.error}`, { code: 'start-error', actions: startErrorActions(st.error) })
    state.pendingStart = null
  }
  emit('engine', st)
}

// 课堂实时笔记：主进程每攒够一段新内容整理一次，发完整的新版；失败时保留上一版，只记一行提示
function onNotes(p) {
  const live = state.live
  if (!p || !live || (p.sessionId && live.sessionId && p.sessionId !== live.sessionId)) return
  if (p.error) live.notesError = String(p.error)
  else if (p.notes) {
    live.notes = p.notes
    live.notesError = ''
    live.notesAt = p.updatedAt ?? Date.now()
  }
  emit('notes', p)
}

function onSlide(p) {
  const live = state.live
  if (!p || !live || (p.sessionId && live.sessionId && p.sessionId !== live.sessionId)) return
  const slide = { file: p.file, at: p.at, ...(p.url ? { url: p.url } : {}), ...(p.path ? { path: p.path } : {}) }
  if (p.dir && !live.dir) live.dir = p.dir
  live.slides.push(slide)
  emit('slide', slide)
}

function onSegment(seg) {
  if (!state.live) return
  if (!seg.text) state.live.segs.delete(seg.id)
  else state.live.segs.set(seg.id, seg)
  if (state.live.segs.size > 800) state.live.segs.delete(state.live.segs.keys().next().value)
  emit('segment', seg)
}

function onAnswer(a) {
  if (!a?.id) return
  // 会后按快捷键也能答：没有会议就先挂一个空的
  if (!state.live) {
    resetLive({ projectId: state.currentProjectId })
    state.live.ended = true
    state.live.dismissed = true
  }
  const fresh = !state.live.answers.has(a.id)
  state.live.answers.set(a.id, { ...state.live.answers.get(a.id), ...a })
  emit('answer', a)
  if (fresh) emit('engine', state.engine) // 会后答的第一条：侧栏出现「刚才的会议」
}

function wireEvents() {
  subscribe('engine:state', onEngineState)
  subscribe('engine:segment', onSegment)
  subscribe('engine:level', (lv) => emit('level', lv))
  subscribe('engine:notice', onEngineNotice)
  subscribe('engine:pause', (p) => {
    state.engine = { ...state.engine, paused: p.paused }
    emit('engine', state.engine)
  })
  subscribe('engine:devices', (d) => {
    state.devices = d ?? {}
    emit('devices', state.devices)
  })
  subscribe('assist:answer', onAnswer)
  subscribe('overlay:state', (o) => {
    state.overlay = o
    emit('overlay', o)
  })
  subscribe('hotkey:status', (h) => {
    state.hotkey = h
    emit('hotkey', h)
    emit('status')
  })
  subscribe('summary:progress', (p) => {
    const job = state.summaries.get(p.id)
    if (!job) state.summaries.set(p.id, { phase: p.phase, text: p.text ?? '' })
    else Object.assign(job, { phase: p.phase, text: p.text ?? job.text })
    emit('summary', p)
  })
  subscribe('projects:changed', ({ projects, currentProjectId }) => {
    if (Array.isArray(projects)) state.projects = projects
    if (currentProjectId) state.currentProjectId = currentProjectId
    emit('projects', state.projects)
  })
  subscribe('sessions:changed', (e) => emit('sessions', e ?? {}))
  subscribe('todos:changed', (e) => emit('todos', e ?? {}))
  subscribe('settings:changed', (s) => {
    state.settings = s
    if (s?.currentProjectId && projectOf(s.currentProjectId) && !projectOf(s.currentProjectId).archived) state.currentProjectId = s.currentProjectId
    emit('settings', s)
    refreshLlm()
  })
  subscribe('onboarding:changed', (ob) => {
    state.onboarding = ob ?? {}
    emit('status')
  })
  subscribe('chatgpt:status', (c) => {
    state.chatgpt = c
    refreshLlm()
  })
  subscribe('account:status', setAccount)
  subscribe('notes:update', onNotes)
  subscribe('slides:added', onSlide)
  subscribe('materials:progress', (p) => emit('materials', p))
}

/* ---------------- 页面内快捷键 ---------------- */

// 弹着模态框、命令面板或菜单时，页面快捷键先不管
const overlayOpen = () => Boolean(document.querySelector('.modal-backdrop, .palette-backdrop, .menu'))

// 设置里改了快捷键就重新绑：解绑上一轮的，按现在的设置再绑一遍
let unbindKeys = []
let boundKeys = ''

function bindAppKeys() {
  const sig = JSON.stringify(state.settings?.keys ?? {})
  if (sig === boundKeys) return
  boundKeys = sig
  for (const off of unbindKeys) off()
  unbindKeys = []
  const bind = (name, fn, always = false) => {
    const accel = appKey(name)
    if (accel) unbindKeys.push(ui.hotkey(accel, (e) => (always || !overlayOpen()) && fn(e)))
  }
  bind('palette', () => openPalette(), true)
  // Mac 上「设置…」菜单项带着同一个快捷键，任何窗口里都能按，这里不重复绑
  if (state.platform !== 'darwin') bind('settings', () => openSettings())
  bind('home', () => go('home', {}, { root: true }))
  bind('todos', () => go('todos', {}, { root: true }))
  bind('live', () => state.live && go('live'))
  bind('newProject', () => newProjectModal())
  // 在项目页上按：开在这个项目里（和页面上的开始按钮一样）；别的地方开在当前项目里
  bind('start', () => {
    if (state.engine.state !== 'idle') return go('live')
    const cur = router.current
    const p = cur?.name === 'project' ? projectOf(cur.id) : null
    return p && !p.archived ? startMeeting(p.id, startChoice(p.id)) : startMeeting()
  })
  bind('back', () => back())
  bind('sidebar', () => toggleSidebar(), true)
}

function wireKeys() {
  const key = (accel, fn) => ui.hotkey(accel, (e) => !overlayOpen() && fn(e))
  bindAppKeys()
  on('settings', bindAppKeys)
  key('CommandOrControl+Enter', () => router.mounted?.primary?.())
  key('Control+Tab', () => router.mounted?.cycleTab?.(1))
  key('Control+Shift+Tab', () => router.mounted?.cycleTab?.(-1))
  // 编辑框里按 Esc 先离开编辑框，再按才返回
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
    if (overlayOpen()) return
    const t = e.target
    if (t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) {
      t.blur()
      document.getElementById('view').querySelector('.list, .pane-body')?.focus?.({ preventScroll: true })
      return
    }
    if (router.stack.length) {
      e.preventDefault()
      back()
    }
  })
}

// 计时：会议进行中每秒更新所有 [data-elapsed]
setInterval(() => {
  if (!state.live?.startedAt || state.live.ended) return
  const text = fmtOffset(Date.now() - state.live.startedAt)
  for (const n of document.querySelectorAll('[data-elapsed]')) n.textContent = text
}, 1000)

/* ---------------- 启动 ---------------- */

async function boot() {
  const init = await api.init()
  state.platform = init.platform
  state.version = init.version
  state.settings = init.settings
  state.projects = init.projects ?? []
  state.currentProjectId = init.currentProjectId ?? INBOX
  state.onboarding = init.onboarding ?? {}
  state.llm = init.llm ?? null
  state.chatgpt = init.chatgpt ?? null
  state.hotkey = init.hotkey ?? state.hotkey
  state.overlay = init.overlay ?? state.overlay
  if (init.account) state.account = init.account
  ui.applyChrome(init.chrome)

  const snap = init.snapshot ?? { state: 'idle', segments: [] }
  const sess = snap.session ?? {}
  state.engine = { state: snap.state, sessionId: sess.id ?? null, projectId: sess.projectId ?? null, startedAt: sess.startedAt ?? null, mode: snap.mode ?? sess.mode, paused: Boolean(snap.paused) }
  state.devices = snap.devices ?? {}
  if (snap.state !== 'idle' && snap.session) {
    resetLive({ sessionId: sess.id, projectId: sess.projectId, startedAt: sess.startedAt, mode: snap.mode ?? sess.mode, classSource: snap.classSource ?? sess.classSource, dir: snap.dir ?? sess.dir })
    applyLiveExtras({ liveNotes: snap.liveNotes ?? sess.liveNotes, liveNotesAt: snap.liveNotesAt, slides: snap.slides ?? sess.slides })
    for (const seg of snap.segments ?? []) if (seg.text) state.live.segs.set(seg.id, seg)
    // 窗口重开时把这场会已经答完的问题补回来
    const s = await call('loadSession', snap.session.id)
    for (const a of (!failed(s) && s?.answers) || []) state.live.answers.set(a.id, { ...a, done: true })
  }

  wireEvents()
  wireKeys()
  renderSidebar()
  applySidebar()
  applySidebarOpacity()
  renderNotices()
  go(state.live && snap.state !== 'idle' ? 'live' : 'home', {}, { push: false })
  if (!state.llm) refreshLlm()
  if (!init.account && accountSupported()) call('accountStatus').then(setAccount)
  ensureProjectMode(state.currentProjectId)
}

boot().catch((e) => {
  console.error(e)
  document.getElementById('view').append(ui.emptyState({ icon: 'circle-alert', title: '界面没加载起来', description: String(e?.message ?? e) }))
})
