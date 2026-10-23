'use strict'
// 左侧栏：搜索（命令面板）、会议进行中、首页、待办、项目、底部状态小条和设置。

const SHOW_ARCHIVED = 'meetcaption.sidebar.archived'
const COLLAPSED = 'meetcaption.sidebar.collapsed'

function renderSidebar() {
  const side = document.getElementById('sidebar')
  const hadFocus = side.contains(document.activeElement) ? document.activeElement.dataset.nav : null
  ui.clear(side)
  const nav = el('nav.sidebar-scroll', { 'aria-label': '导航' })

  nav.append(
    el(
      'button.search-trigger',
      { type: 'button', dataset: { nav: 'search' }, onClick: () => openPalette() },
      icon('search', 14),
      el('span', { text: '搜索' }),
      keyHint('palette'),
    ),
  )

  const live = state.live
  if (live && (running() || busyEngine() || !live.dismissed)) {
    const on = running() || busyEngine()
    const paused = running() && state.engine.paused
    nav.append(
      navItem({
        key: 'live',
        lead: el('span.nav-live', {}, paused ? icon('pause', 14) : on ? el('span.dot.dot-live') : icon('audio-lines', 16)),
        label: paused ? '已暂停' : on ? modeInfo(live.mode).live : live.mode === 'class' ? '刚才的课' : '刚才的会议',
        count: on && live.startedAt ? el('span.count.num', { dataset: { elapsed: '' }, text: fmtOffset(Date.now() - live.startedAt) }) : null,
        onClick: () => go('live', {}, { root: true }),
      }),
    )
  }

  const openTodos = activeProjects().reduce((n, p) => n + (p.openTodos || 0), 0)
  nav.append(
    navItem({ key: 'home', lead: icon('house', 16), label: '首页', onClick: () => go('home', {}, { root: true }) }),
    navItem({ key: 'todos', lead: icon('list-todo', 16), label: '待办', count: openTodos ? String(openTodos) : null, onClick: () => go('todos', {}, { root: true }) }),
  )

  nav.append(
    el(
      'div.nav-section',
      {},
      el('span', { text: '项目' }),
      el('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': '新建项目', title: '新建项目', onClick: () => newProjectModal() }, icon('plus', 14)),
    ),
  )
  for (const p of activeProjects()) nav.append(projectNavItem(p))
  nav.append(navItem({ key: 'new-project', lead: icon('plus', 16), label: '新建项目', muted: true, onClick: () => newProjectModal() }))

  const archived = state.projects.filter((p) => p.archived)
  if (archived.length) {
    // 正在看的是归档项目：展开，侧栏里才有高亮的那一行
    const viewing = router.current?.name === 'project' && archived.some((p) => p.id === router.current.id)
    const open = store(SHOW_ARCHIVED) === '1' || viewing
    nav.append(
      el(
        'button.nav-section.nav-section-toggle',
        {
          type: 'button',
          'aria-expanded': String(open),
          dataset: { nav: 'archived' },
          onClick: () => {
            store(SHOW_ARCHIVED, open ? null : '1')
            renderSidebar()
          },
        },
        el('span', { text: `已归档（${archived.length}）` }),
        icon(open ? 'chevron-down' : 'chevron-right', 12),
      ),
    )
    if (open) for (const p of archived) nav.append(projectNavItem(p, true))
  }

  side.append(el('div.sidebar-top', {}, sidebarToggle()), nav, sidebarFooter())
  markSidebarActive()
  if (hadFocus) side.querySelector(`[data-nav="${CSS.escape(hadFocus)}"]`)?.focus({ preventScroll: true })
}

function navItem({ key, lead, label, count, muted, onClick, title }) {
  return el(
    'button.nav-item',
    { type: 'button', class: muted ? 'is-muted' : '', dataset: { nav: key }, onClick, title },
    lead,
    el('span.nav-label', { text: label }),
    typeof count === 'string' ? el('span.count.num', { text: count }) : count,
  )
}

function projectNavItem(p, archived = false) {
  const current = p.id === state.currentProjectId && !archived
  const item = navItem({
    key: `project:${p.id}`,
    lead: projectBox(p, 'sm'),
    label: p.name,
    count: p.meetings ? String(p.meetings) : null,
    muted: archived,
    title: current ? `${p.name}（当前项目，开会就开在这里）` : p.name,
    onClick: () => go('project', { id: p.id }, { root: true }),
  })
  if (current) item.classList.add('is-current')
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    projectContextMenu({ x: e.clientX, y: e.clientY }, p)
  })
  return item
}

function projectContextMenu(anchor, p) {
  const inbox = p.id === INBOX
  const busyHere = state.engine.state !== 'idle' && state.live?.projectId === p.id
  const setArchived = async (archived) => {
    if (archived && busyHere) return ui.toast({ title: '这个项目里正在开会', message: '先停止记录再归档', type: 'warning' })
    const r = await call('updateProject', p.id, { archived })
    if (failed(r)) return ui.toast({ title: '没能保存', message: r?.error, type: 'error' })
    ui.toast({ title: archived ? '已归档' : '已取消归档', type: 'success' })
  }
  const items = [
    { label: '打开', icon: 'arrow-right', onSelect: () => go('project', { id: p.id }, { root: true }) },
    !p.archived && { label: `在「${p.name}」里开始会议`, icon: 'mic', disabled: state.engine.state !== 'idle', onSelect: () => startMeeting(p.id) },
    !inbox && { label: '改名', icon: 'pencil', onSelect: () => go('project', { id: p.id, rename: true }, { root: true }) },
    { label: '换颜色和图标…', icon: 'star', onSelect: () => appearanceModal(projectOf(p.id) ?? p) },
    { label: '打开文件夹', icon: 'folder', onSelect: () => call('openProjectFolder', p.id) },
    !inbox && 'sep',
    !inbox && (p.archived ? { label: '取消归档', icon: 'archive', onSelect: () => setArchived(false) } : { label: '归档', icon: 'archive', onSelect: () => setArchived(true) }),
    !inbox && { label: '删除项目…', icon: 'trash', danger: true, disabled: busyHere, onSelect: () => deleteProjectFlow(projectOf(p.id) ?? p) },
  ].filter(Boolean)
  ui.menu(anchor, items, { minWidth: 220 })
}

function markSidebarActive() {
  const v = router.current
  let key = v?.name
  if (v?.name === 'project') key = `project:${v.id}`
  if (v?.name === 'meeting' && v.projectId) key = `project:${v.projectId}`
  for (const n of document.querySelectorAll('#sidebar .nav-item')) {
    const on = n.dataset.nav === key
    n.classList.toggle('is-active', on)
    if (on) n.setAttribute('aria-current', 'page')
    else n.removeAttribute('aria-current')
  }
}

// kind 是这一项管什么（识别、AI），name 是用的哪家服务：两个都叫 OpenAI 时也分得清
function statusChip({ ok, warn, kind, label, tip, onClick }) {
  const text = kind && label ? el('span', {}, el('span.status-kind', { text: kind }), ` ${label}`) : el('span', { text: label || kind })
  const b = el('button.status-chip', { type: 'button', onClick }, el('span.dot', { class: ok ? 'dot-ok' : warn ? 'dot-warn' : '' }), text)
  ui.tip(b, tip, { delay: 300, placement: 'top' })
  return b
}

function sidebarFooter() {
  const s = state.settings ?? {}
  const ob = state.onboarding ?? {}
  const llm = state.llm
  const provider = s.llmProvider ?? llm?.provider
  const member = s.plan === 'member'
  const aiName = member ? '会员' : provider === 'chatgpt' ? 'ChatGPT' : provider === 'openai' ? 'OpenAI' : provider === 'custom' ? '自定义' : (llm?.label ?? '')
  const aiOk = llm ? Boolean(llm.ready) : Boolean(ob.ai)
  const asrName = member ? (s.memberAsr === 'local' ? '本地' : '会员云') : s.engine === 'local' ? '本地' : s.engine === 'volc' ? '豆包' : 'OpenAI'
  const micOn = s.captureMic !== false
  const chips = el(
    'div.status-strip',
    {},
    statusChip({
      ok: ob.voiceprint,
      warn: micOn && !ob.voiceprint,
      label: '声纹',
      tip: ob.voiceprint ? { title: '声纹已录好', text: '麦克风里的话能分清是你还是对方' } : micOn ? { title: '还没录声纹', text: '点这里去录，12 秒就好' } : { title: '没开麦克风', text: '只记录电脑里的声音，用不到声纹' },
      onClick: () => openSettings('voiceprint'),
    }),
    statusChip({
      ok: aiOk,
      warn: !aiOk,
      kind: 'AI',
      label: aiName,
      tip: aiOk ? { title: 'AI 已连上', text: llm?.label || aiName || 'AI 服务' } : { title: 'AI 还没连上', text: llm?.reason || '翻译、纪要和 AI 答题要用' },
      onClick: () => (member ? openPricing() : openSettings('ai')),
    }),
    statusChip({
      ok: ob.asr,
      warn: !ob.asr,
      kind: '识别',
      label: asrName,
      tip: ob.asr ? { title: '语音识别已配好', text: s.engine === 'local' ? '在这台电脑上识别，免费' : s.engine === 'volc' ? '豆包流式识别' : 'OpenAI 实时识别' } : { title: '语音识别还没配好', text: s.engine === 'local' ? '本地识别模型缺失，重新安装一下' : '点这里填密钥' },
      onClick: () => openSettings(member ? 'member' : 'asr'),
    }),
  )
  return el(
    'div.sidebar-footer',
    {},
    memberCard(),
    chips,
    el('button.nav-item', { type: 'button', dataset: { nav: 'settings' }, onClick: () => openSettings() }, icon('settings', 16), el('span.nav-label', { text: '设置' }), keyHint('settings')),
  )
}

// 侧栏里上下键移动焦点
document.getElementById('sidebar').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  if (e.isComposing) return
  const items = [...document.querySelectorAll('#sidebar [data-nav]')].filter((n) => n.offsetParent !== null)
  const i = items.indexOf(document.activeElement)
  if (i < 0) return
  e.preventDefault()
  const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
  next?.focus()
})

on('route', (v) => (v?.name === 'project' && projectOf(v.id)?.archived ? renderSidebar() : markSidebarActive()))
on('projects', renderSidebar)
on('status', renderSidebar)
on('engine', renderSidebar)
on('member', renderSidebar)
// 快捷键提示跟着设置走
let sidebarKeys = ''
on('settings', () => {
  const sig = JSON.stringify(state.settings?.keys ?? {})
  if (sig !== sidebarKeys) (sidebarKeys = sig), renderSidebar()
})

/* ---- 收起 / 展开：记在本机，重开还是那样；收起时按钮挪到主窗口标题栏最左边（Mac 在红绿灯右边） ---- */

function sidebarCollapsed() {
  return store(COLLAPSED) === '1'
}

function toggleSidebar() {
  store(COLLAPSED, sidebarCollapsed() ? null : '1')
  applySidebar()
}

function applySidebar() {
  const collapsed = sidebarCollapsed()
  document.querySelector('.app').classList.toggle('sidebar-collapsed', collapsed)
  document.getElementById('sidebar').inert = collapsed
  document.querySelector('.sidebar-top .sidebar-toggle')?.replaceWith(sidebarToggle())
  const header = document.getElementById('header')
  header.querySelector(':scope > .sidebar-toggle')?.remove()
  if (collapsed) header.prepend(sidebarToggle())
}

function sidebarToggle() {
  const label = sidebarCollapsed() ? '展开侧栏' : '收起侧栏'
  const b = el('button.btn.btn-ghost.btn-icon.btn-sm.sidebar-toggle', { type: 'button', 'aria-label': label, onClick: toggleSidebar }, icon('panel-left', 16))
  const k = appKey('sidebar')
  ui.tip(b, { title: label, text: k ? ui.accelText(k) : undefined }, { delay: 400, placement: 'bottom' })
  return b
}

// 侧栏底色有多实（设置「侧栏不透明度」）
function applySidebarOpacity() {
  document.documentElement.style.setProperty('--sidebar-opacity', String(state.settings?.sidebarOpacity ?? 0.85))
}
on('settings', applySidebarOpacity)
