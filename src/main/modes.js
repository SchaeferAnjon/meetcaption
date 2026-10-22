// 三种模式：会议（v3 的行为）、面试（答题默认开且自动回答）、课堂（老师讲、AI 边听边记笔记）。
// 不引 electron，engine、main 和单测都直接用。

export const MODES = ['meeting', 'interview', 'class']
export const CLASS_SOURCES = ['mic', 'system'] // 教室现场（麦克风）| 网课（电脑声音）

export const MODE_LABELS = { meeting: '会议', interview: '面试', class: '课堂' }

/**
 * 这次开会用什么模式：start 参数 > 项目默认 > 会议。
 * 课堂的声音来源：start 参数 > 项目上记的 > 设置里的默认（class.source）> 麦克风。不是课堂时 classSource 是 null。
 */
export function resolveMode({ mode, classSource } = {}, project = null, settings = {}) {
  const m = MODES.includes(mode) ? mode : MODES.includes(project?.mode) ? project.mode : 'meeting'
  if (m !== 'class') return { mode: m, classSource: null }
  const pick = [classSource, project?.classSource, settings?.class?.source].find((x) => CLASS_SOURCES.includes(x))
  return { mode: m, classSource: pick ?? 'mic' }
}

/** 模式叠到设置上：面试强制开答题、自动回答；课堂关自动回答（开着答题的话快捷键照样能答）。 */
export function modeSettings(s, mode) {
  if (mode === 'interview') return { ...s, assist: { ...s.assist, enabled: true, auto: true } }
  if (mode === 'class') return { ...s, assist: { ...s.assist, auto: false } }
  return s
}

/** 界面和存档里的说话人称呼：课堂上对方叫「老师」。 */
export function speakerLabel(who, mode) {
  if (who === 'me') return '我'
  return mode === 'class' ? '老师' : '对方'
}
