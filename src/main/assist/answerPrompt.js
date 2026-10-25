// 实时答题的 prompt。输出要短：第一行要点（用这一场「翻译成」的语言，一眼看懂），后面 2 到 4 句能直接说出口的回答（默认跟提问的语言）。
import { promptLang } from '../languages.js'

const langRule = (answerLang) =>
  !answerLang || answerLang === 'auto' ? '跟随提问的语言：对方用哪种语言问，就用哪种语言答' : `用${promptLang(answerLang)}回答`

const PROFILE_MAX = 4000
// 最近的对话给多一点：课上老师问的常常是十几分钟前讲的内容（只给 12 句时只能答出「没有问题」这种空话）
const TRANSCRIPT_LINES = 60
const TRANSCRIPT_CHARS = 8000
const NOTES_CHARS = 3000

// 第一句说清处境：面试官问我 / 开会时有人问我 / 课上老师问我
const SCENE = {
  interview: '我正在面试，面试官刚问了我一个问题。',
  meeting: '我正在开会，会上有人刚问了我一个问题。',
  class: '我正在上课，老师刚问了一个问题。',
}

// 课堂上老师问的多半是「有没有问题」「听懂了吗」这种开放的邀请，答「没有问题」没有用
const CLASS_RULES = [
  '- 老师问的是「有没有问题」「听懂了吗」「有什么想法」这类开放的邀请时，不要答「没有问题」或「我懂了」：围绕刚讲的内容，给我一个具体、有价值、能直接问出口的问题（比如追问一个关键概念的条件、例外、和前面内容的联系，或者举例确认理解）。第一行写「要点：可以问」加问题的大意。',
  '- 老师问的是内容问题：用课上刚讲的内容和例子回答，术语和老师的说法保持一致。',
]

export function answerSystem({ answerLang = 'auto', noteLang = 'zh', withScreen = false, mode = 'meeting' } = {}) {
  return [
    `你是我的实时答题助手。${SCENE[mode] ?? SCENE.meeting}你写一段我能直接照着说出口的回答。`,
    '格式：',
    `第一行：「要点：」（这三个字照写）加一句${promptLang(noteLang)}要点，15 个字或 8 个词以内，让我一眼知道怎么答。`,
    `第二行起：回答本身，${langRule(answerLang)}。2 到 4 句，第一人称，口语，像我自己在说话。每句尽量不超过 20 个词（中文 30 个字），不用分号、括号和破折号。`,
    '要求：',
    '- 直接回答，不复述问题，不说 Great question 之类的客套，不用列表、标题和 Markdown。',
    '- 不反问，不让我先确认问题是什么意思，也不提截图。问题有几种理解时，按对话里最可能的那一种直接答。',
    ...(withScreen
      ? [
          '- 附图是我现在的屏幕。先判断问题和屏幕上的内容有没有关系：',
          '  问题明显在说屏幕上的东西（「这个」「这一页」「这里」指的就是图里的模块、标题、图表、代码），就围绕屏幕上的具体内容回答，用上图里的名字和数字；',
          '  看不出关系（屏幕上是别的软件、聊天窗口、终端，或者问题本身是个独立的问题），就只围绕问题本身回答，截图只当背景参考，不要往屏幕上扯。',
        ]
      : []),
    '- 用上「我的资料」里的具体经历、项目名和数字。资料里没有的经历和数据不要编；需要我自己补的细节用 [方括号] 标出来。',
    '- 问题是语音识别出来的，可能有错字或没说完，按最可能的意思回答。',
    '- 没认出明确的问题时（下面会说明），按对方最后说的话里最值得回应的一点来写：在课上就针对它提一个好问题或说出我的理解，在会上就给出我的回应。',
    ...(mode === 'class' ? CLASS_RULES : []),
  ].join('\n')
}

/** transcript 可以是现成的文本，也可以是段落数组 [{ who, speaker, text }]。只留最近几句，控制长度。 */
export function recentTranscript(transcript, { lines = TRANSCRIPT_LINES, chars = TRANSCRIPT_CHARS } = {}) {
  if (!transcript) return ''
  let list
  if (typeof transcript === 'string') list = transcript.split('\n')
  else
    list = transcript
      .filter((s) => s?.text?.trim())
      .map((s) => `${s.speaker ?? (s.who === 'me' || s.source === 'mic' ? '我' : '对方')}：${s.text.trim()}`)
  const out = []
  let total = 0
  for (let i = list.length - 1; i >= 0 && out.length < lines; i--) {
    const line = list[i].trim()
    if (!line) continue
    if (total + line.length > chars && out.length) break
    out.unshift(line.length > chars ? '…' + line.slice(-chars) : line)
    total += line.length
  }
  return out.join('\n')
}

/**
 * 组一次答题请求（不含截图）。截图到了以后用 withImage 挂上去。
 * 返回 { system, messages }，messages 的格式按 complete 的约定。
 */
/** 实时笔记（{ sections, emphasis, ... }）压成几行文字，答题时知道这节课 / 这场会讲到了哪些点。 */
export function notesText(notes, max = NOTES_CHARS) {
  if (!notes || typeof notes !== 'object') return ''
  const lines = []
  for (const s of notes.sections ?? []) {
    const points = [...(s.points ?? []), ...(s.formulas ?? [])]
    lines.push(`- ${s.title}${points.length ? `：${points.join('；')}` : ''}`)
  }
  for (const e of notes.emphasis ?? []) if (e?.text) lines.push(`- 强调：${e.text}`)
  const out = lines.join('\n')
  return out.length > max ? out.slice(0, max) + '…' : out
}

export function answerMessages({ question, transcript, context, profile, notes = null, matched = true, answerLang = 'auto', noteLang = 'zh', withScreen = false, mode = 'meeting' }) {
  const parts = []
  if (context?.trim()) parts.push(`会议背景：${context.trim()}`)
  const p = profile?.trim()
  if (p) parts.push(`我的资料：\n${p.length > PROFILE_MAX ? p.slice(0, PROFILE_MAX) + '…' : p}`)
  const q = String(question ?? '').trim()
  // 问题本身通常就是对话的最后一句，不用重复
  const recent = recentTranscript(transcript)
    .split('\n')
    .filter((line) => line && !(q && line.endsWith(q)))
    .join('\n')
  const outline = notesText(notes)
  if (outline) parts.push(`到现在为止的${mode === 'class' ? '课堂' : '会议'}笔记（AI 边听边整理的）：\n${outline}`)
  if (recent) parts.push(`最近的对话：\n${recent}`)
  parts.push(matched ? `对方的问题：${q}` : `没认出明确的问题，这是对方最后说的话：${q}`)
  if (withScreen) parts.push('附图是我现在的屏幕，只在问题和屏幕内容有关时才围绕它回答。')
  return {
    system: answerSystem({ answerLang, noteLang, withScreen, mode }),
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  }
}

export function withImage(messages, dataUrl) {
  if (!dataUrl) return messages
  return messages.map((m, i) =>
    i === messages.length - 1 && m.role === 'user'
      ? { ...m, content: [...(typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content), { type: 'image', dataUrl }] }
      : m,
  )
}

/** 把回答拆成「要点」和正文，界面和复制都用。 */
export function splitAnswer(text) {
  const t = String(text ?? '').replace(/^\s+/, '')
  const m = t.match(/^要点[:：]\s*(.*)(?:\n+|$)/)
  if (!m) return { gist: '', body: t.trim() }
  return { gist: m[1].trim(), body: t.slice(m[0].length).trim() }
}
