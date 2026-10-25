'use strict'
// 命令面板（⌘K / Ctrl+K）：命令、切换项目、打开设置；输入文字时再到主进程搜会议（标题、纪要、字幕）和待办。

const SETTINGS_SECTIONS = [
  ['general', '通用', '主题、保存位置、开机启动、屏幕共享时隐藏', 'settings'],
  ['ai', '账号与 AI', 'ChatGPT 登录、API Key、模型', 'sparkles'],
  ['asr', '语音识别', 'Soniox、豆包、OpenAI、密钥、测试连接', 'audio-lines'],
  ['voiceprint', '声纹', '录制、重新录制、阈值', 'fingerprint-pattern'],
  ['assist', 'AI 答题', '自动回答、屏幕截图、回答语言', 'message-square-text'],
  ['overlay', '字幕与答题框', '字号、行数、颜色、译文、意群颜色对照、术语解释', 'captions'],
  ['class', '课堂', '声音来源、实时笔记更新频率、截取画面、导出文件夹', 'graduation-cap'],
  ['hotkeys', '快捷键', '显示隐藏、开始停止记录、让 AI 回答、主窗口快捷键，都能改', 'keyboard'],
  ['mic', '麦克风', '同时录我、选择设备', 'mic'],
  ['about', '关于', '版本、数据位置、使用说明', 'info'],
]

function commandItems() {
  const s = state.settings ?? {}
  const st = state.engine.state
  const cur = projectOf(state.currentProjectId)
  const items = []
  if (st === 'idle') {
    const choice = startChoice()
    items.push({ id: 'start', title: startLabel(choice), subtitle: `在「${cur?.name ?? '未归类'}」里`, icon: choice.mode === 'meeting' ? 'mic' : modeInfo(choice.mode).icon, tint: 'red', kbd: appKey('start') || undefined, actionLabel: '开始', keywords: ['start', 'record', 'kaishi', '录音', '记录', '开始会议'], onSelect: () => startMeeting(state.currentProjectId, choice) })
    // 换个模式开始（只在搜索时出现）
    const alt = [
      { mode: 'meeting', keywords: ['meeting', 'huiyi', '会议'] },
      { mode: 'interview', keywords: ['interview', 'mianshi', '面试'] },
      { mode: 'class', classSource: 'mic', keywords: ['class', 'lecture', 'shangke', '上课', '课堂', '教室'] },
      { mode: 'class', classSource: 'system', keywords: ['class', 'online', 'wangke', '上课', '课堂', '网课'] },
    ].filter((x) => x.mode !== choice.mode || (x.mode === 'class' && x.classSource !== sourceOf(choice.classSource)))
    for (const x of alt) {
      const c = { projectId: state.currentProjectId, mode: x.mode, classSource: x.classSource }
      items.push({ id: `start:${x.mode}:${x.classSource ?? ''}`, title: startLabel(c), subtitle: `在「${cur?.name ?? '未归类'}」里`, icon: modeInfo(x.mode).icon, tint: 'red', searchOnly: true, actionLabel: '开始', keywords: ['start', ...x.keywords], onSelect: () => startMeeting(state.currentProjectId, c) })
    }
  } else {
    items.push({ id: 'live', title: liveMode() === 'class' ? '回到课堂' : '回到会议', subtitle: `「${projectName(state.live?.projectId)}」`, icon: 'audio-lines', tint: 'red', kbd: appKey('live') || undefined, keywords: ['live', '进行中'], onSelect: () => go('live') })
    if (running() && liveMode() === 'class')
      items.push({ id: 'capture', title: '截取画面', subtitle: '把当前屏幕（网课课件）存进这节课', icon: 'camera', tint: 'purple', kbd: state.settings?.class?.hotkeySlide || undefined, actionLabel: '截取', keywords: ['capture', 'screenshot', 'slide', '截图', '课件'], onSelect: () => captureSlide() })
    items.push({ id: 'stop', title: '停止记录', subtitle: '保存这场会议', icon: 'square', tint: 'red', kbd: s.hotkeyRecord || undefined, actionLabel: '停止', keywords: ['stop', '结束'], onSelect: () => stopMeeting() })
  }
  if (s.assist?.enabled !== false)
    items.push({ id: 'ask', title: '让 AI 回答刚才的问题', icon: 'sparkles', tint: 'indigo', kbd: s.assist?.hotkeyAsk || undefined, actionLabel: '回答', keywords: ['ask', 'answer', '答题'], onSelect: () => askFromPalette() })
  items.push({
    id: 'overlay',
    title: state.overlay.visible ? '隐藏字幕和答题框' : '显示字幕和答题框',
    icon: state.overlay.visible ? 'eye-off' : 'eye',
    tint: 'blue',
    kbd: state.hotkey.accel || undefined,
    keywords: ['overlay', 'caption', '字幕'],
    onSelect: () => call('toggleOverlay'),
  })
  items.push({ id: 'edit-overlay', title: state.overlay.editMode ? '完成调整字幕位置' : '调整字幕和答题框位置', icon: 'monitor', tint: 'blue', keywords: ['position', '位置', '拖动'], onSelect: () => call('editOverlay', !state.overlay.editMode) })
  items.push({ id: 'reset-overlay', title: '恢复字幕和答题框的默认位置', icon: 'refresh-cw', tint: 'blue', searchOnly: true, keywords: ['reset', '默认'], onSelect: () => call('resetOverlayPosition').then(() => ui.toast({ title: '已回到默认位置', type: 'success' })) })
  items.push({ id: 'new-project', title: '新建项目', icon: 'folder-plus', tint: 'green', kbd: appKey('newProject') || undefined, keywords: ['new project', 'xinjian'], onSelect: () => newProjectModal() })
  items.push({ id: 'home', title: '首页', icon: 'house', tint: 'gray', kbd: appKey('home') || undefined, keywords: ['home'], onSelect: () => go('home', {}, { root: true }) })
  items.push({ id: 'todos', title: '待办', icon: 'list-todo', tint: 'orange', kbd: appKey('todos') || undefined, keywords: ['todo', 'ddl', '截止'], onSelect: () => go('todos', {}, { root: true }) })
  items.push({ id: 'settings', title: '打开设置', icon: 'settings', tint: 'gray', kbd: appKey('settings') || undefined, keywords: ['settings', 'preferences', 'shezhi'], onSelect: () => openSettings() })
  for (const [sec, label, desc, ic] of SETTINGS_SECTIONS)
    items.push({ id: `settings:${sec}`, title: `设置：${label}`, subtitle: desc, icon: ic, tint: 'gray', searchOnly: true, keywords: ['settings', '设置', desc], onSelect: () => openSettings(sec) })
  items.push({ id: 'onboarding', title: '打开首次引导', subtitle: '录声纹、连接 AI、语音识别、建项目', icon: 'sparkles', tint: 'purple', searchOnly: true, keywords: ['onboarding', 'guide', '引导', '向导'], onSelect: () => call('openOnboarding') })
  items.push({ id: 'open-root', title: '打开保存位置', subtitle: '会议字幕的根文件夹', icon: 'folder', tint: 'gray', searchOnly: true, keywords: ['folder', 'finder', '文件夹'], onSelect: () => call('openFolder', null) })
  return items
}

function projectItems() {
  const items = []
  for (const p of state.projects) {
    const current = p.id === state.currentProjectId
    items.push({
      id: `project:${p.id}`,
      title: p.name,
      subtitle: p.archived ? '已归档' : p.description || '',
      icon: projectIconName(p),
      tint: projectTint(p),
      accessory: current ? '当前项目' : `${p.meetings || 0} 场会议`,
      actionLabel: '打开项目',
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
    { label: '打开项目', icon: 'arrow-right', kbd: 'Enter', onSelect: () => go('project', { id: p.id }) },
    !p.archived && state.engine.state === 'idle' && { label: `在「${p.name}」里开始会议`, icon: 'mic', onSelect: () => startMeeting(p.id) },
    !p.archived && { label: '设为当前项目', icon: 'check', onSelect: () => (setCurrentProject(p.id), ui.toast({ title: `当前项目：${p.name}`, type: 'success' })) },
    { label: '待办与 DDL', icon: 'list-todo', onSelect: () => go('project', { id: p.id, tab: 'todos' }) },
    { label: '资料', icon: 'file-text', onSelect: () => go('project', { id: p.id, tab: 'info' }) },
    { label: '打开文件夹', icon: 'folder', onSelect: () => call('openProjectFolder', p.id) },
  ].filter(Boolean)
}

// 纪要片段里的 Markdown 记号（列表、标题、加粗）去掉，只留文字
const cleanSnippet = (t) =>
  String(t ?? '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|…|\s)(?:[-*+>]|#{1,6}|\d+\.)\s+/g, '$1')
    .trim()

const FIELD_LABEL = { title: '标题', summary: '纪要', transcript: '字幕', project: '项目', text: '待办', quote: '原话', dueText: '时间', name: '名字', description: '描述', context: '会议背景', keywords: '术语' }

async function searchGroups(q) {
  const r = await call('search', q)
  if (failed(r) || !r) return []
  const groups = []
  // 项目名字本地已经能搜到，这里只补按描述、背景、术语搜到的
  const projects = (r.projects ?? []).filter((p) => p.field !== 'name' && !ui.fuzzy(q, p.name))
  if (projects.length)
    groups.push({
      title: '项目',
      items: projects.map((p) => ({
        id: `sp:${p.id}`,
        title: p.name,
        subtitle: FIELD_LABEL[p.field] ?? '',
        snippet: cleanSnippet(p.snippet),
        icon: projectIconName(p),
        tint: projectTint(p),
        actionLabel: '打开项目',
        onSelect: () => go('project', { id: p.id }),
        actions: projectPaletteActions(projectOf(p.id) ?? p),
      })),
    })
  if (r.sessions?.length)
    groups.push({
      title: '会议',
      items: r.sessions.map((s) => ({
        id: `s:${s.id}`,
        title: sessionTitle(s),
        subtitle: `${projectName(s.projectId)} · ${fmtWhen(s.startedAt)}`,
        snippet: s.field !== 'title' && s.field !== 'project' ? `${FIELD_LABEL[s.field] ?? ''}：${cleanSnippet(s.snippet)}` : null,
        icon: 'message-square-text',
        tint: projectTint(projectOf(s.projectId)),
        accessory: s.hasSummary ? '有纪要' : '',
        actionLabel: '打开会议',
        onSelect: () => go('meeting', { id: s.id, tab: s.field === 'transcript' ? 'transcript' : s.field === 'summary' ? 'summary' : undefined }),
        actions: [
          { label: '打开会议', icon: 'arrow-right', kbd: 'Enter', onSelect: () => go('meeting', { id: s.id }) },
          { label: '看纪要', icon: 'file-text', onSelect: () => go('meeting', { id: s.id, tab: 'summary' }) },
          { label: '看字幕记录', icon: 'captions', onSelect: () => go('meeting', { id: s.id, tab: 'transcript' }) },
          { label: '看待办', icon: 'list-todo', onSelect: () => go('meeting', { id: s.id, tab: 'todos' }) },
          { label: '打开文件夹', icon: 'folder', onSelect: () => call('openFolder', s.id) },
        ],
      })),
    })
  if (r.todos?.length)
    groups.push({
      title: '待办',
      items: r.todos.map((t) => {
        const due = dueInfo(t.due, t.done)
        return {
          id: `t:${t.sessionId}:${t.id}`,
          title: t.text,
          subtitle: `${projectName(t.projectId)}${t.done ? ' · 已完成' : ''}`,
          snippet: t.field === 'quote' ? `原话：${cleanSnippet(t.snippet)}` : `来自「${t.sessionTitle || fmtDateTime(t.sessionStartedAt)}」`,
          icon: t.done ? 'circle-check' : 'circle',
          iconVariant: 'soft',
          tint: t.done ? 'green' : due?.tint || 'gray',
          accessory: due?.label ?? '',
          actionLabel: '打开会议',
          onSelect: () => go('meeting', { id: t.sessionId, tab: 'todos' }),
          actions: [
            { label: '打开来源会议', icon: 'arrow-right', kbd: 'Enter', onSelect: () => go('meeting', { id: t.sessionId, tab: 'todos' }) },
            { label: t.done ? '标记为没完成' : '标记为完成', icon: 'check', onSelect: () => toggleTodo(t, !t.done) },
          ],
        }
      }),
    })
  return groups
}

async function askFromPalette() {
  const r = await askAI()
  if (failed(r)) ui.toast({ title: '没法回答', message: r?.error, type: 'error' })
  else {
    ui.toast({ title: 'AI 正在回答', message: r?.question, type: 'info' })
    if (router.current?.name !== 'live' && state.live) go('live')
  }
}

function openPalette(query = '') {
  const open = ui.commandPalette.current()
  if (open) return open.close()
  ui.commandPalette({
    placeholder: '搜索会议、待办、项目，或输入命令',
    query,
    groups: [
      { title: '命令', items: commandItems() },
      { title: '切换项目', items: projectItems() },
    ],
    source: (q) => searchGroups(q),
    emptyText: '会议标题、纪要、字幕和待办都能搜',
    context: { icon: 'command', tint: 'indigo', label: '会议字幕' },
    actionsKey: appKey('palette'),
  })
}
