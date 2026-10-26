'use strict'
// 命令面板（⌘K / Ctrl+K）：命令、切换项目、打开设置；输入文字时再到主进程搜会议（标题、纪要、字幕）和待办。

const SETTINGS_SECTIONS = [
  ['general', t('通用'), t('主题、保存位置、开机启动、屏幕共享时隐藏'), 'settings'],
  ['ai', t('账号与 AI'), t('ChatGPT 登录、API Key、模型'), 'sparkles'],
  ['asr', t('语音识别'), t('Soniox、豆包、OpenAI、密钥、测试连接'), 'audio-lines'],
  ['voiceprint', t('声纹'), t('录制、重新录制、阈值'), 'fingerprint-pattern'],
  ['assist', t('AI 答题'), t('自动回答、屏幕截图、回答语言'), 'message-square-text'],
  ['overlay', t('字幕与答题框'), t('字号、行数、颜色、译文、意群颜色对照、术语解释'), 'captions'],
  ['class', t('课堂'), t('声音来源、实时笔记更新频率、截取画面、导出文件夹'), 'graduation-cap'],
  ['hotkeys', t('快捷键'), t('显示隐藏、开始停止记录、让 AI 回答、主窗口快捷键，都能改'), 'keyboard'],
  ['mic', t('麦克风'), t('同时录我、选择设备'), 'mic'],
  ['about', t('关于'), t('版本、数据位置、使用说明'), 'info'],
]

function commandItems() {
  const s = state.settings ?? {}
  const st = state.engine.state
  const cur = projectOf(state.currentProjectId)
  const items = []
  if (st === 'idle') {
    const choice = startChoice()
    items.push({ id: 'start', title: startLabel(choice), subtitle: t(`在「{0}」里`, cur?.name ?? t('未归类')), icon: choice.mode === 'meeting' ? 'mic' : modeInfo(choice.mode).icon, tint: 'red', kbd: appKey('start') || undefined, actionLabel: t('开始'), keywords: ['start', 'record', 'kaishi', t('录音'), t('记录'), t('开始会议')], onSelect: () => startMeeting(state.currentProjectId, choice) })
    // 换个模式开始（只在搜索时出现）
    const alt = [
      { mode: 'meeting', keywords: ['meeting', 'huiyi', t('会议')] },
      { mode: 'interview', keywords: ['interview', 'mianshi', t('面试')] },
      { mode: 'class', classSource: 'mic', keywords: ['class', 'lecture', 'shangke', t('上课'), t('课堂'), t('教室')] },
      { mode: 'class', classSource: 'system', keywords: ['class', 'online', 'wangke', t('上课'), t('课堂'), t('网课')] },
    ].filter((x) => x.mode !== choice.mode || (x.mode === 'class' && x.classSource !== sourceOf(choice.classSource)))
    for (const x of alt) {
      const c = { projectId: state.currentProjectId, mode: x.mode, classSource: x.classSource }
      items.push({ id: `start:${x.mode}:${x.classSource ?? ''}`, title: startLabel(c), subtitle: t(`在「{0}」里`, cur?.name ?? t('未归类')), icon: modeInfo(x.mode).icon, tint: 'red', searchOnly: true, actionLabel: t('开始'), keywords: ['start', ...x.keywords], onSelect: () => startMeeting(state.currentProjectId, c) })
    }
  } else {
    items.push({ id: 'live', title: liveMode() === 'class' ? t('回到课堂') : t('回到会议'), subtitle: t(`「{0}」`, projectName(state.live?.projectId)), icon: 'audio-lines', tint: 'red', kbd: appKey('live') || undefined, keywords: ['live', t('进行中')], onSelect: () => go('live') })
    if (running() && liveMode() === 'class')
      items.push({ id: 'capture', title: t('截取画面'), subtitle: t('把当前屏幕（网课课件）存进这节课'), icon: 'camera', tint: 'purple', kbd: state.settings?.class?.hotkeySlide || undefined, actionLabel: t('截取'), keywords: ['capture', 'screenshot', 'slide', t('截图'), t('课件')], onSelect: () => captureSlide() })
    items.push({ id: 'stop', title: t('停止记录'), subtitle: t('保存这场会议'), icon: 'square', tint: 'red', kbd: s.hotkeyRecord || undefined, actionLabel: t('停止'), keywords: ['stop', t('结束')], onSelect: () => stopMeeting() })
  }
  if (s.assist?.enabled !== false)
    items.push({ id: 'ask', title: t('让 AI 回答刚才的问题'), icon: 'sparkles', tint: 'indigo', kbd: s.assist?.hotkeyAsk || undefined, actionLabel: t('回答'), keywords: ['ask', 'answer', t('答题')], onSelect: () => askFromPalette() })
  items.push({
    id: 'overlay',
    title: state.overlay.visible ? t('隐藏字幕和答题框') : t('显示字幕和答题框'),
    icon: state.overlay.visible ? 'eye-off' : 'eye',
    tint: 'blue',
    kbd: state.hotkey.accel || undefined,
    keywords: ['overlay', 'caption', t('字幕')],
    onSelect: () => call('toggleOverlay'),
  })
  items.push({ id: 'edit-overlay', title: state.overlay.editMode ? t('完成调整字幕位置') : t('调整字幕和答题框位置'), icon: 'monitor', tint: 'blue', keywords: ['position', t('位置'), t('拖动')], onSelect: () => call('editOverlay', !state.overlay.editMode) })
  items.push({ id: 'reset-overlay', title: t('恢复字幕和答题框的默认位置'), icon: 'refresh-cw', tint: 'blue', searchOnly: true, keywords: ['reset', t('默认')], onSelect: () => call('resetOverlayPosition').then(() => ui.toast({ title: t('已回到默认位置'), type: 'success' })) })
  items.push({ id: 'new-project', title: t('新建项目'), icon: 'folder-plus', tint: 'green', kbd: appKey('newProject') || undefined, keywords: ['new project', 'xinjian'], onSelect: () => newProjectModal() })
  items.push({ id: 'home', title: t('首页'), icon: 'house', tint: 'gray', kbd: appKey('home') || undefined, keywords: ['home'], onSelect: () => go('home', {}, { root: true }) })
  items.push({ id: 'todos', title: t('待办'), icon: 'list-todo', tint: 'orange', kbd: appKey('todos') || undefined, keywords: ['todo', 'ddl', t('截止')], onSelect: () => go('todos', {}, { root: true }) })
  items.push({ id: 'settings', title: t('打开设置'), icon: 'settings', tint: 'gray', kbd: appKey('settings') || undefined, keywords: ['settings', 'preferences', 'shezhi'], onSelect: () => openSettings() })
  for (const [sec, label, desc, ic] of SETTINGS_SECTIONS)
    items.push({ id: `settings:${sec}`, title: t(`设置：{0}`, label), subtitle: desc, icon: ic, tint: 'gray', searchOnly: true, keywords: ['settings', t('设置'), desc], onSelect: () => openSettings(sec) })
  items.push({ id: 'onboarding', title: t('打开首次引导'), subtitle: t('授权、语言、试听、声纹'), icon: 'sparkles', tint: 'purple', searchOnly: true, keywords: ['onboarding', 'guide', t('引导'), t('向导')], onSelect: () => call('openOnboarding') })
  items.push({ id: 'update', title: t('检查更新'), subtitle: t('设置 → 通用 → 更新'), icon: 'refresh-cw', tint: 'gray', searchOnly: true, keywords: ['update', t('更新'), t('新版本')], onSelect: () => openSettings('general') })
  items.push({ id: 'tour', title: t('看主窗口导览'), subtitle: t('开始会议、字幕、答题卡、语言按钮在哪'), icon: 'play', tint: 'purple', searchOnly: true, keywords: ['tour', t('导览'), t('引导')], onSelect: () => openGuide() })
  items.push({ id: 'open-root', title: t('打开保存位置'), subtitle: t('会议字幕的根文件夹'), icon: 'folder', tint: 'gray', searchOnly: true, keywords: ['folder', 'finder', t('文件夹')], onSelect: () => call('openFolder', null) })
  return items
}

function projectItems() {
  const items = []
  for (const p of state.projects) {
    const current = p.id === state.currentProjectId
    items.push({
      id: `project:${p.id}`,
      title: p.name,
      subtitle: p.archived ? t('已归档') : p.description || '',
      icon: projectIconName(p),
      tint: projectTint(p),
      accessory: current ? t('当前项目') : t(`{0} 场会议`, p.meetings || 0),
      actionLabel: t('打开项目'),
      searchOnly: p.archived,
      keywords: [p.description || ''],
      onSelect: () => go('project', { id: p.id }),
      actions: projectPaletteActions(p),
    })
  }
  return items
}

function projectPaletteActions(p) {
  return [
    { label: t('打开项目'), icon: 'arrow-right', kbd: 'Enter', onSelect: () => go('project', { id: p.id }) },
    !p.archived && state.engine.state === 'idle' && { label: t(`在「{0}」里开始会议`, p.name), icon: 'mic', onSelect: () => startMeeting(p.id) },
    !p.archived && { label: t('设为当前项目'), icon: 'check', onSelect: () => (setCurrentProject(p.id), ui.toast({ title: t(`当前项目：{0}`, p.name), type: 'success' })) },
    { label: t('待办与 DDL'), icon: 'list-todo', onSelect: () => go('project', { id: p.id, tab: 'todos' }) },
    { label: t('资料'), icon: 'file-text', onSelect: () => go('project', { id: p.id, tab: 'info' }) },
    { label: t('打开文件夹'), icon: 'folder', onSelect: () => call('openProjectFolder', p.id) },
  ].filter(Boolean)
}

// 纪要片段里的 Markdown 记号（列表、标题、加粗）去掉，只留文字
const cleanSnippet = (tv) =>
  String(tv ?? '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|…|\s)(?:[-*+>]|#{1,6}|\d+\.)\s+/g, '$1')
    .trim()

const FIELD_LABEL = { title: t('标题'), summary: t('纪要'), transcript: t('字幕'), project: t('项目'), text: t('待办'), quote: t('原话'), dueText: t('时间'), name: t('名字'), description: t('描述'), context: t('会议背景'), keywords: t('术语') }

async function searchGroups(q) {
  const r = await call('search', q)
  if (failed(r) || !r) return []
  const groups = []
  // 项目名字本地已经能搜到，这里只补按描述、背景、术语搜到的
  const projects = (r.projects ?? []).filter((p) => p.field !== 'name' && !ui.fuzzy(q, p.name))
  if (projects.length)
    groups.push({
      title: t('项目'),
      items: projects.map((p) => ({
        id: `sp:${p.id}`,
        title: p.name,
        subtitle: FIELD_LABEL[p.field] ?? '',
        snippet: cleanSnippet(p.snippet),
        icon: projectIconName(p),
        tint: projectTint(p),
        actionLabel: t('打开项目'),
        onSelect: () => go('project', { id: p.id }),
        actions: projectPaletteActions(projectOf(p.id) ?? p),
      })),
    })
  if (r.sessions?.length)
    groups.push({
      title: t('会议'),
      items: r.sessions.map((s) => ({
        id: `s:${s.id}`,
        title: sessionTitle(s),
        subtitle: `${projectName(s.projectId)} · ${fmtWhen(s.startedAt)}`,
        snippet: s.field !== 'title' && s.field !== 'project' ? t(`{0}：{1}`, FIELD_LABEL[s.field] ?? '', cleanSnippet(s.snippet)) : null,
        icon: 'message-square-text',
        tint: projectTint(projectOf(s.projectId)),
        accessory: s.hasSummary ? t('有纪要') : '',
        actionLabel: t('打开会议'),
        onSelect: () => go('meeting', { id: s.id, tab: s.field === 'transcript' ? 'transcript' : s.field === 'summary' ? 'summary' : undefined }),
        actions: [
          { label: t('打开会议'), icon: 'arrow-right', kbd: 'Enter', onSelect: () => go('meeting', { id: s.id }) },
          { label: t('看纪要'), icon: 'file-text', onSelect: () => go('meeting', { id: s.id, tab: 'summary' }) },
          { label: t('看字幕记录'), icon: 'captions', onSelect: () => go('meeting', { id: s.id, tab: 'transcript' }) },
          { label: t('看待办'), icon: 'list-todo', onSelect: () => go('meeting', { id: s.id, tab: 'todos' }) },
          { label: t('打开文件夹'), icon: 'folder', onSelect: () => call('openFolder', s.id) },
        ],
      })),
    })
  if (r.todos?.length)
    groups.push({
      title: t('待办'),
      items: r.todos.map((tv) => {
        const due = dueInfo(tv.due, tv.done)
        return {
          id: `t:${tv.sessionId}:${tv.id}`,
          title: tv.text,
          subtitle: `${projectName(tv.projectId)}${tv.done ? t(' · 已完成') : ''}`,
          snippet: tv.field === 'quote' ? t(`原话：{0}`, cleanSnippet(tv.snippet)) : t(`来自「{0}」`, tv.sessionTitle || fmtDateTime(tv.sessionStartedAt)),
          icon: tv.done ? 'circle-check' : 'circle',
          iconVariant: 'soft',
          tint: tv.done ? 'green' : due?.tint || 'gray',
          accessory: due?.label ?? '',
          actionLabel: t('打开会议'),
          onSelect: () => go('meeting', { id: tv.sessionId, tab: 'todos' }),
          actions: [
            { label: t('打开来源会议'), icon: 'arrow-right', kbd: 'Enter', onSelect: () => go('meeting', { id: tv.sessionId, tab: 'todos' }) },
            { label: tv.done ? t('标记为没完成') : t('标记为完成'), icon: 'check', onSelect: () => toggleTodo(tv, !tv.done) },
          ],
        }
      }),
    })
  return groups
}

async function askFromPalette() {
  const r = await askAI()
  if (failed(r)) ui.toast({ title: t('没法回答'), message: r?.error, type: 'error' })
  else {
    ui.toast({ title: t('AI 正在回答'), message: r?.question, type: 'info' })
    if (router.current?.name !== 'live' && state.live) go('live')
  }
}

function openPalette(query = '') {
  const open = ui.commandPalette.current()
  if (open) return open.close()
  ui.commandPalette({
    placeholder: t('搜索会议、待办、项目，或输入命令'),
    query,
    groups: [
      { title: t('命令'), items: commandItems() },
      { title: t('切换项目'), items: projectItems() },
    ],
    source: (q) => searchGroups(q),
    emptyText: t('会议标题、纪要、字幕和待办都能搜'),
    context: { icon: 'command', tint: 'indigo', label: t('会议字幕') },
    actionsKey: appKey('palette'),
  })
}
