// 实时答题的 prompt。输出要短：第一行要点（用这一场「翻译成」的语言，一眼看懂），后面 2 到 4 句能直接说出口的回答（默认跟提问的语言），
// 回答里每句前面带一个【标签】（同样用「翻译成」的语言，答题卡上扫一眼就是整段的提纲；回答和翻成的语言相同时不要标签）。
import { detectLang, promptLang } from '../languages.js'

const LATIN_GUESS = ['en', 'de', 'fr', 'es', 'it', 'pt'] // detectLang 数虚词认得的几种

/**
 * 回答用哪种语言。设了就用设的；「跟随提问」时由代码先判提问的语言，写死在 prompt 里
 * （让模型自己判，资料是中文、翻译成德语日语时常答成中文或德语）。判不准（Why? 这种太短的）返回 null，还是让模型跟着提问答。
 * source：这一场对方说的语言。
 */
export function answerLanguage(question, answerLang = 'auto', source = null) {
  if (answerLang && answerLang !== 'auto') return answerLang
  const q = String(question ?? '')
  const src = source && source !== 'auto' ? source : null
  const d = detectLang(q)
  // 你用过 Kubernetes 吗：汉字比英文词多就是中文
  const han = (q.match(/\p{Script=Han}/gu) ?? []).length
  if (d !== 'ja' && d !== 'ko' && han && han >= (q.match(/\p{Script=Latin}+/gu) ?? []).length) return 'zh'
  // 对方说的是荷兰语、瑞典语这类拉丁字母的语言时，数虚词判出来的法语英语不可信（语言自己的名字是拉丁字母就算）
  const latinSrc = src && !LATIN_GUESS.includes(src) && /^\p{Script=Latin}/u.test(new Intl.DisplayNames([src], { type: 'language' }).of(src))
  return d && !(latinSrc && LATIN_GUESS.includes(d)) ? d : null
}

const langName = (lang) => (lang ? promptLang(lang) : '和提问相同的语言')

// 标签的长度：汉字、假名按字数，其他语言按词数
const TAG_LIMIT = (lang) => (['zh', 'zh-Hant', 'ja'].includes(lang) ? '10 个字以内' : '4 个词以内')

/** 要不要写标签：回答用的语言和翻成的语言一样就不要（标签是给看不懂回答的人看的）；回答语言还没定（null）时问模型自己判。 */
export const wantsHints = (answerLang, noteLang) => !answerLang || answerLang !== noteLang

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

export function answerSystem({ answerLang = null, noteLang = 'zh', withScreen = false, mode = 'meeting', hints = true } = {}) {
  const hintRule = answerLang
    ? `每句话的前面先写一个${promptLang(noteLang)}标签：用【】括起来，紧贴着这句话，${TAG_LIMIT(noteLang)}，只概括这句话本身，不加这句话里没有的数字和名字，不带标点。标签一律用${promptLang(noteLang)}写，不跟着回答的语言走（回答是别的语言也一样）。一句一个标签，一句也不漏，标签以外不要用【】。`
    : `回答用的语言和${promptLang(noteLang)}不同时，每句话的前面先写一个${promptLang(noteLang)}标签：用【】括起来，紧贴着这句话，${TAG_LIMIT(noteLang)}，只概括这句话本身，不加这句话里没有的数字和名字，不带标点，标签一律用${promptLang(noteLang)}写，不跟着回答的语言走，一句一个、一句也不漏，标签以外不要用【】；回答也是${promptLang(noteLang)}时不写标签。`
  return [
    `你是我的实时答题助手。${SCENE[mode] ?? SCENE.meeting}你写一段我能直接照着说出口的回答。`,
    '格式：',
    `第一行：「要点：」（这三个字照写）加一句${promptLang(noteLang)}要点，15 个字或 8 个词以内，让我一眼知道怎么答。`,
    `第二行起：回答本身，用${langName(answerLang)}回答。2 到 4 句，第一人称，口语，像我自己在说话。每句尽量不超过 20 个词（中文 30 个字），不用分号、括号和破折号${hints ? '（标签的【】除外）' : ''}。`,
    ...(hints ? [hintRule] : []),
    '要求：',
    '- 只回答「对方的问题」这一个问题。「最近的对话」只是背景：里面更早的问题已经答过了，不要再答；寒暄和会上的事务（能听到吗、共享屏幕）也不要回应。',
    '- 直接回答，不复述问题，不说 Great question 之类的客套，不用列表、标题和 Markdown。',
    '- 不反问，不让我先确认问题是什么意思，也不提截图。问题有几种理解时，按对话里最可能的那一种直接答。',
    ...(withScreen
      ? [
          '- 附图是我现在的屏幕。先判断问题和屏幕上的内容有没有关系：',
          '  问题明显在说屏幕上的东西（「这个」「这一页」「这里」指的就是图里的模块、标题、图表、代码），就围绕屏幕上的具体内容回答，用上图里的名字和数字；',
          '  看不出关系（屏幕上是别的软件、聊天窗口、终端，或者问题本身是个独立的问题），就只围绕问题本身回答，截图只当背景参考，不要往屏幕上扯。',
        ]
      : []),
    '- 「我的资料」里有和这个问题相关的经历、项目名和数字就用上；和问题无关的不要硬扯进来。资料里没有的经历和数据不要编，需要我自己补的细节用 [方括号] 标出来（问的是进度、时间、数字这类只有我知道的事，也用 [方括号] 留给我填，不要替我定）；回答里不要提「资料」。',
    '- 问题是语音识别出来的，可能有错字或没说完，按最可能的意思回答；和「术语」里的词发音相近的，就是那个术语。',
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

/**
 * 组一次答题请求（不含截图），返回 { system, messages }；截图到了以后用 withImage 挂上去。
 * question：界面上显示的整段提问（铺垫 + 问题）；lead：其中前面的铺垫，prompt 里和问题分开写。
 * source：这一场对方说的语言（判提问语言时用）。keywords：这一场的术语。
 */
export function answerMessages({ question, lead = '', transcript, context, profile, keywords = [], notes = null, matched = true, answerLang = 'auto', source = null, noteLang = 'zh', withScreen = false, mode = 'meeting' }) {
  const parts = []
  if (context?.trim()) parts.push(`会议背景：${context.trim()}`)
  if (keywords?.length) parts.push(`术语：${keywords.join('、')}`)
  const p = profile?.trim()
  if (p) parts.push(`我的资料：\n${p.length > PROFILE_MAX ? p.slice(0, PROFILE_MAX) + '…' : p}`)
  const q = String(question ?? '').trim()
  const pre = String(lead ?? '').trim()
  const ask = pre && q.startsWith(pre) ? q.slice(pre.length).trim() || q : q
  // 问题本身通常就是对话的最后一句，不用重复
  const recent = recentTranscript(transcript)
    .split('\n')
    .filter((line) => line && !(q && line.endsWith(q)))
    .join('\n')
  const outline = notesText(notes)
  if (outline) parts.push(`到现在为止的${mode === 'class' ? '课堂' : '会议'}笔记（AI 边听边整理的）：\n${outline}`)
  if (recent) parts.push(`最近的对话：\n${recent}`)
  if (!matched) parts.push(`没认出明确的问题，这是对方最后说的话：${q}`)
  else {
    if (ask !== q) parts.push(`对方问之前紧接着说的（问题的铺垫，帮你理解问题）：${pre}`)
    parts.push(`对方的问题：${ask}`)
  }
  if (withScreen) parts.push('附图是我现在的屏幕，只在问题和屏幕内容有关时才围绕它回答。')
  const lang = answerLanguage(ask, answerLang, source)
  // 语言放在最后再说一遍：只在 system 里说时，资料是中文的场次要点常写成中文
  const hints = wantsHints(lang, noteLang)
  const tags = hints ? `，每句前面的【标签】也用${promptLang(noteLang)}（专有名词除外，不跟着回答的语言走）` : ''
  parts.push(`语言：要点那一行用${promptLang(noteLang)}（除了人名、项目名这类专有名词，每个词都用${promptLang(noteLang)}）${tags}，回答用${langName(lang)}，不管资料和对话是什么语言。`)
  return {
    system: answerSystem({ answerLang: lang, noteLang, withScreen, mode, hints }),
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

const TAG = /【([^【】\n]{1,40})】\s*/g

/**
 * 模型写出来的回答（流式写到一半也行）→ { text, gist, body, hints }。每句前面的【标签】摘出来：
 * text 是不带标签的回答（第一行要点 + 正文，存档、复制、翻译都用它），hints 是 [{ at, text }]，at 是标签后面那句在正文（text 去掉要点行）里的位置。
 * 标签还没写完（【负责结…）的先不露出来，写完那一刻才出现，所以流式出字时用户看不到标记。
 */
export function parseAnswer(raw) {
  const full = String(raw ?? '')
  if (!full.includes('【')) return { text: full, ...splitAnswer(full), hints: [] }
  const s = full.replace(/^\s+/, '')
  const head = s.match(/^要点[:：][^\n]*\n*/)?.[0] ?? ''
  const rest = s.slice(head.length).replace(/\*\*|__/g, '')
  let body = ''
  let last = 0
  const hints = []
  for (const m of rest.matchAll(TAG)) {
    body += rest.slice(last, m.index)
    const text = m[1].trim()
    if (text) hints.push({ at: body.length, text })
    last = m.index + m[0].length
  }
  body += rest.slice(last)
  body = body.replace(/【[^【】\n]{0,40}$/, '')
  return { text: head + body, gist: splitAnswer(head).gist, body, hints }
}

/** 把回答拆成「要点」和正文，界面和复制都用。 */
export function splitAnswer(text) {
  const t = String(text ?? '').replace(/^\s+/, '')
  const m = t.match(/^要点[:：]\s*(.*)(?:\n+|$)/)
  if (!m) return { gist: '', body: t.trim() }
  return { gist: m[1].trim(), body: t.slice(m[0].length).trim() }
}
