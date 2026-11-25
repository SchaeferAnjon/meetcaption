import { clock, noDashes } from '../prompts.js'
import { t } from '../i18n.js'
import { promptLang } from '../languages.js'
import { tokenize } from '../speaker.js'
import { speakerLabel } from '../modes.js'

// 问 AI（课堂、会议、面试都能问）：组 prompt 和解析回答（不引 electron，单测直接用）。
// 取材：这一场的字幕（整场，太长时只留和问题最相关的几段加最近一段和引用那句的前后）、实时笔记、课件里最相关的几页、截图（最多附两张）。
// 问的是一段时间（刚才、最近十分钟、到现在、几点几分、开头，askScope 认）时，先整段给那段时间的字幕，「讲了什么」这类词不拿去对字幕。
// prompt 里的说法按模式换：课堂说「这节课 / 老师」，会议说「这场会 / 对方」，面试说「这场面试 / 面试官」。
// 回答按行写：覆盖、要点、几条、依据（引用资料里的编号）、接着问。解析边流边出，没写完的行先不露出来。
// 联网（AI 服务是 DeepSeek 或会员时）：资料不够回答时 AI 第一行只写「搜索：<搜索词>」，ask.js 看到这一行就停掉这次回答、去搜，
// 再把搜索结果（编号「网N」）连同原问题问一次，这一次不再给搜索这一条；「依据」里的 网N 是出处链接。

export const ASK_LIMITS = {
  transcriptTokens: 3200, // 字幕最多占的 token（估算）
  scopeTokens: 7000, // 问的是一段时间（刚才、最近十分钟、到现在、几点几分）时字幕最多占的 token：那段时间要整段给
  recentShare: 0.35, // 其中最近的字幕占的份额（问题没说时间、又有能对上的词时）
  justMin: 5, // 「刚才」「刚刚」：最近几分钟
  startMin: 10, // 「开头」「一开始」：开课后几分钟
  notesChars: 3600,
  pageTokens: 1800,
  pages: 3,
  pageChars: 1200,
  images: 2,
  history: 4, // 带上之前几问
  webChars: 700, // 一条搜索结果的摘要最多几个字（DeepSeek 给的 summary 600 到 800 字）
  webSources: 3, // 「依据」里最多几条网页
  historyChars: 900,
  lineChars: 360,
}

/** token 估算：汉字、假名、韩文按一个算，其余按 3.6 个字符一个。 */
export function estTokens(s) {
  const text = String(s ?? '')
  const cjk = (text.match(/[぀-ヿ一-鿿가-힯]/g) ?? []).length
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 3.6)
}

const STOP = new Set('the a an and or but is are was were be been to of in on at for with that this it you we they i not do does did have has what how why can will just so if then than there here from by as about into your our their its also very really like which when where who whom would could should may might one two'.split(' '))

/** 一段文字里用来对照的词：拉丁字母的词（去掉虚词）和汉字相邻两个字。 */
export function searchTokens(text) {
  const out = new Set()
  const han = []
  const flush = () => {
    if (han.length === 1) out.add(han[0])
    for (let i = 0; i + 1 < han.length; i++) out.add(han[i] + han[i + 1])
    han.length = 0
  }
  for (const w of tokenize(text)) {
    if (/\p{Script=Han}/u.test(w)) han.push(w)
    else {
      flush()
      if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w)
    }
  }
  flush()
  return out
}

// 问题里的中文术语换成课上的英文词（反过来也一样），不然中文问题对不上英文字幕
function termTokens(question, terms) {
  const q = String(question).toLowerCase()
  const out = new Set()
  for (const t of terms) {
    const en = String(t.term ?? '').toLowerCase()
    const zh = String(t.zh ?? '').toLowerCase()
    if ((zh && q.includes(zh)) || (en && q.includes(en))) for (const k of [...searchTokens(en), ...searchTokens(zh)]) out.add(k)
  }
  return out
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/* ---------------- 问题问的是哪段时间 ---------------- */

const MIN = 60_000
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const EN_NUM = { one: 1, two: 2, three: 3, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, sixty: 60 }
const NUM = '(\\d{1,3}|[一二两三四五六七八九十]{1,3})'
// 一段时长：十分钟、20 分钟、半小时、一个小时、一刻钟
const DUR = `(?:${NUM}\\s*个?\\s*(分钟|小时|钟头)|(半)\\s*个?\\s*(?:小时|钟头)|(一刻钟))`

/** 「十五」「二十」「3」→ 数字；认不出 → null */
function cnNum(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s]
  const m = s.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/)
  return m ? (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0) : null
}

/** DUR 匹配到的几组 → 分钟 */
function durMin(n, unit, half, quarter) {
  if (half) return 30
  if (quarter) return 15
  const v = cnNum(n)
  return v == null ? null : unit === '分钟' ? v : v * 60
}

/**
 * 问题问的是这一场里的哪段时间（看问题里的说法，不看内容）。
 * now：现在；startedAt：开始时间；endedAt：结束时间（课后才有）；live：还在进行。
 * → { kind: 'recent' | 'all' | 'at' | 'start', from, to, label } | null（没问时间）
 * recent：最近 N 分钟、刚才（最近 5 分钟）、最后十分钟；all：到现在、总结、目前讲了什么；at：某个钟点或「第 N 分钟」「十分钟前」前后几分钟；start：开头、前十分钟。
 */
export function askScope(question, { now = Date.now(), startedAt, endedAt = null, live = true } = {}) {
  const q = String(question ?? '').replace(/\s+/g, ' ')
  const end = live ? now : (endedAt ?? now)
  const out = (kind, from, to, label) => {
    const f = Math.max(startedAt, from)
    const t = Math.min(end, to)
    return t > f ? { kind, from: f, to: t, label } : null
  }
  const around = (t, label, before = 1, after = 4) => out('at', t - before * MIN, t + after * MIN, label)
  const recent = (min, label) => out('recent', end - min * MIN, end, label)
  const hm = (ms) => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  // 钟点 → 这一场那天的这个时刻；没说上午下午的，挑落在这一场里的那个
  const wall = (h, m, pm) => {
    const base = new Date(startedAt)
    const cands = (pm && h < 12 ? [h + 12] : h < 12 ? [h, h + 12] : [h]).map((x) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), x, m).getTime())
    return cands.find((t) => t >= startedAt - 10 * MIN && t <= end + 10 * MIN) ?? null
  }
  let m
  // 课后的 1:05:00、第 30 分钟：开始以后多久
  if (!live && (m = q.match(/(?<![\d:])(\d{1,2}):(\d{2}):(\d{2})(?![\d:])/))) return around(startedAt + (Number(m[1]) * 60 + Number(m[2])) * MIN, `第 ${Number(m[1]) * 60 + Number(m[2])} 分钟前后`)
  if ((m = q.match(new RegExp(`(?:第|开课|开始后?|上课)\\s*${NUM}\\s*分钟`)))) {
    const n = cnNum(m[1])
    if (n != null) return around(startedAt + n * MIN, `开始后第 ${n} 分钟前后`)
  }
  if ((m = q.match(/(?<![\d:])(\d{1,2})[:：](\d{2})(?![\d:])/))) {
    const t = wall(Number(m[1]), Number(m[2]), false)
    if (t != null) return around(t, `${hm(t)} 前后`)
    // 课后没对上钟点的 30:00 是开始后多久
    if (!live) return around(startedAt + (Number(m[1]) + Number(m[2]) / 60) * MIN, `第 ${Number(m[1])} 分钟前后`)
  }
  // 「两点五十」「下午 6 点」「3 点半」；光一个「三点」常是三个要点，要有上下午、分钟、半或「左右」这类才算钟点
  if ((m = q.match(new RegExp(`(上午|下午|晚上|早上|中午|傍晚)?\\s*${NUM}\\s*点\\s*(?:${NUM}\\s*分?|(半)|(一刻))?\\s*(钟|左右|前后|的时候|那会|那时)?`)))) {
    const [, ampm, hs, ms, half, quarter, tail] = m
    const h = cnNum(hs)
    const min = ms ? cnNum(ms) : half ? 30 : quarter ? 15 : 0
    if ((ampm || ms || half || quarter || tail) && h != null && h < 24 && min != null && min < 60) {
      const t = wall(h, min, /下午|晚上|傍晚/.test(ampm ?? ''))
      if (t != null) return around(t, `${hm(t)} 前后`)
    }
  }
  // 十分钟前 / 10 minutes ago：那个时刻前后
  if ((m = q.match(new RegExp(`${DUR}\\s*之?前(?!面|边)`)))) {
    const n = durMin(m[1], m[2], m[3], m[4])
    if (n != null) return around(end - n * MIN, `${n} 分钟前`, 2, 3)
  }
  if ((m = q.match(/(\d{1,3}|one|two|three|five|ten|fifteen|twenty|thirty|forty|sixty)\s*(minutes?|mins?|hours?)\s+ago/i))) {
    const n = (Number(m[1]) || EN_NUM[m[1].toLowerCase()]) * (/^h/i.test(m[2]) ? 60 : 1)
    return around(end - n * MIN, `${n} 分钟前`, 2, 3)
  }
  // 最近十分钟 / 过去半小时 / 最后十分钟 / 这 20 分钟 / 十分钟内 / last 15 minutes
  if ((m = q.match(new RegExp(`(?:最近|过去|近|刚才|刚刚|最后|这|方才)\\s*的?\\s*${DUR}`))) || (m = q.match(new RegExp(`${DUR}\\s*(?:内|以内|之内|里)`)))) {
    const n = durMin(m[1], m[2], m[3], m[4])
    if (n != null) return recent(n, live ? `最近 ${n} 分钟` : `最后 ${n} 分钟`)
  }
  if ((m = q.match(/(?:last|past|previous|final)\s+(\d{1,3}|one|two|three|five|ten|fifteen|twenty|thirty|forty|sixty)\s*(minutes?|mins?|hours?)/i))) {
    const n = (Number(m[1]) || EN_NUM[m[1].toLowerCase()]) * (/^h/i.test(m[2]) ? 60 : 1)
    return recent(n, live ? `最近 ${n} 分钟` : `最后 ${n} 分钟`)
  }
  if (/(?:last|past)\s+half\s+(?:an\s+)?hour/i.test(q)) return recent(30, live ? '最近 30 分钟' : '最后 30 分钟')
  // 前十分钟 / 开头十分钟 / first 10 minutes
  if ((m = q.match(new RegExp(`(?:前|头|开头|开始的?|一开始的?|刚开始的?)\\s*${DUR}`)))) {
    const n = durMin(m[1], m[2], m[3], m[4])
    if (n != null) return out('start', startedAt, startedAt + n * MIN, `开头 ${n} 分钟`)
  }
  if ((m = q.match(/first\s+(\d{1,3}|one|two|three|five|ten|fifteen|twenty|thirty)\s*(minutes?|mins?|hours?)/i))) {
    const n = (Number(m[1]) || EN_NUM[m[1].toLowerCase()]) * (/^h/i.test(m[2]) ? 60 : 1)
    return out('start', startedAt, startedAt + n * MIN, `开头 ${n} 分钟`)
  }
  if (/开头|一开始|刚开始|刚上课|开始的时候|at the (?:beginning|start)/i.test(q)) return out('start', startedAt, startedAt + ASK_LIMITS.startMin * MIN, `开头 ${ASK_LIMITS.startMin} 分钟`)
  // 刚才 / 刚刚 / just now：最近 5 分钟
  if (/刚才|刚刚|方才|刚说|这一?段在|(?<!到)现在在?(?:讲|说|聊)|just now|just said|right now|a moment ago/i.test(q)) return recent(ASK_LIMITS.justMin, live ? `刚才这 ${ASK_LIMITS.justMin} 分钟` : `最后 ${ASK_LIMITS.justMin} 分钟`)
  // 到现在 / 目前 / 总结 / so far：从开始到现在
  if (/目前|到现在|至今|迄今|为止|一共|总共|整节课|整堂课|整场|全部|总结|概括|梳理|回顾|大纲|(?:讲|说|聊)(?:了|过)哪些|so far|overall|summar|whole (?:class|lecture|meeting|talk)/i.test(q)) return out('all', startedAt, end, live ? '从开始到现在' : '从头到尾')
  return null
}

// 问题里只是在问「讲了什么、是什么意思」、问时间的词：不拿去对字幕（「讲了」「什么」「一下」到处都有，对上的全是不相干的句子）
const QUERY_FILLER = new RegExp(
  [
    '\\d{1,2}[:：]\\d{2}(?:[:：]\\d{2})?',
    `${NUM}\\s*点\\s*(?:${NUM}\\s*分?|半|一刻)?`,
    DUR,
    `第\\s*${NUM}\\s*分钟`,
    '到目前为止|目前为止|到现在为止|总结一下|概括一下|梳理一下|回顾一下|讲的是什么|说的是什么|是什么意思|什么意思|啥意思|讲了什么|说了什么|讲的什么|说的什么|在讲什么|在说什么',
    '讲了啥|说了啥|讲啥|说啥|总结|概括|梳理|回顾|目前|到现在|现在|至今|为止|刚才|刚刚|方才|最近|过去|开头|一开始|刚开始|开始|最后|是什么|是啥|什么|哪些|怎么|为什么|为啥|一下',
    '老师|说的|讲的|讲了|说了|讲过|说过|这节课|这堂课|这场会|这场面试|整节课|这一段|这段|这句|那段|分钟|小时|钟头|左右|前后|时候|之前|以前|内容|要点|主要|大概|具体|一点|帮我|请问|上午|下午|晚上|早上|中午|傍晚',
    '这么|那么|这样|那样|这个|那个|这些|那些|回答|解释|意思|我们|你们',
  ].join('|'),
  'g',
)
const QUERY_STOP = new Set('just now so far minute minutes min mins hour hours last past previous first ago summary summarize summarise overall whole said say says talk talked talking teacher lecture class meeting'.split(' '))

/** 问题里拿去对字幕的词：去掉只是在问「讲了什么」和问时间的说法；去掉以后剩下的单个汉字（「说」「他」）也不要，太常见。 */
export function queryTokens(query) {
  const out = searchTokens(String(query ?? '').replace(QUERY_FILLER, ' '))
  for (const k of out) if (QUERY_STOP.has(k) || /^\p{Script=Han}$/u.test(k)) out.delete(k)
  return out
}

// 各模式在 prompt 里的说法。it：这一场；whole：整场；src：内容从哪来（「先看资料里老师是怎么讲的」）；say：讲 / 说；
// in：在场时（「课上的字幕」）；aside：只是顺带提到（「老师只在举别的例子时顺带说了」）；gap：没听懂时要补的那一步。
const WORDS = {
  class: {
    it: '这节课',
    whole: '整节课',
    src: '老师',
    say: '讲',
    in: '课上',
    aside: '举别的例子',
    seen: '字幕、笔记或课件',
    cite: '#12 #15 笔记2 截图1 课件p14',
    role: '随身助教',
    doing: (live) => (live ? '上课' : '复习一节已经下课的课'),
    ask: '我没听懂的地方会来问你',
    who: '',
    gap: '没听懂常常是缺一步：把老师没说出口的那一步补上（符号代表什么、式子从哪来、为什么这样做）',
    running: (m) => `这节课已经开讲 ${m} 分钟，还在继续。`,
    ended: (m) => `这节课已经下课，全长 ${m} 分钟。`,
    context: '课程背景',
    notes: '课堂笔记',
    deck: '老师的课件',
    emphasis: '老师强调',
    homework: '作业',
  },
  meeting: {
    it: '这场会',
    whole: '整场会',
    src: '会上',
    say: '说',
    in: '会上',
    aside: '说别的事',
    seen: '字幕、笔记或截图',
    cite: '#12 #15 笔记2 截图1',
    role: '会议助手',
    doing: (live) => (live ? '开会' : '回顾一场已经开完的会'),
    ask: '我想确认或没听懂的地方会来问你',
    who: '字幕里「对方」是会上的其他人，「我」是我。',
    gap: '没听懂常常是缺了背景：把对方没说出口的那一步补上（这个词指什么、为什么这样定、和前面说的有什么关系）',
    running: (m) => `这场会已经开了 ${m} 分钟，还在继续。`,
    ended: (m) => `这场会已经开完，全长 ${m} 分钟。`,
    context: '会议背景',
    notes: '会议笔记',
    deck: '会上的资料',
    emphasis: '结论',
    homework: '待办',
  },
  interview: {
    it: '这场面试',
    whole: '整场面试',
    src: '面试里',
    say: '说',
    in: '面试时',
    aside: '聊别的事',
    seen: '字幕、笔记或截图',
    cite: '#12 #15 笔记2 截图1',
    role: '面试助手',
    doing: (live) => (live ? '面试' : '回顾一场已经结束的面试'),
    ask: '我想确认或没听懂的地方会来问你',
    who: '字幕里「对方」是面试官，「我」是我。',
    gap: '没听懂常常是缺了背景：把面试官没说出口的那一层补上（这个问题想考什么、这个词指什么、为什么这样问）',
    running: (m) => `这场面试已经进行了 ${m} 分钟，还在继续。`,
    ended: (m) => `这场面试已经结束，全长 ${m} 分钟。`,
    context: '面试背景',
    notes: '面试笔记',
    deck: '面试的资料',
    emphasis: '面试官在意',
    homework: '面试后要做',
  },
}

/** 模式在 prompt 里的说法；没记模式的老记录按会议算。 */
export const askWords = (mode) => WORDS[mode] ?? WORDS.meeting

/**
 * 课上的字幕 → 编了号的几行文字。segments：[{ id, startedAt, text, speaker?, sentences? }]，按时间排好。
 * clockTime(ms)：一行前面写的时间（实时是钟点，课后是课里第几分钟）。
 * scope：askScope 给的这一问问的那段时间（刚才、最近十分钟、到现在、几点几分）：那段时间整段给（放不下就在那段里按时间均匀挑几截），
 * 预算放宽到 ASK_LIMITS.scopeTokens，剩下的再给和问题相关的。没问时间：最近的一段 + 引用那句的前后 + 和问题最相关的几段（带前后各一句）。
 * 整场放得下就全放；中间省略的地方写「……」。
 * → { text, refs: Map<编号, 字幕 id>, ats: Map<字幕 id, 时间>, shown, total, range: { from, to } | null（问的那段里给了的第一句和最后一句的时间）, note }
 */
export function transcriptForAsk(segments, { query = '', terms = [], quoteId = null, clockTime, budget = null, mode = 'class', scope = null } = {}) {
  budget ??= scope ? ASK_LIMITS.scopeTokens : ASK_LIMITS.transcriptTokens
  const rows = segments
    .filter((s) => s?.text?.trim())
    .map((s) => {
      const line = oneLine(s.text)
      return { id: s.id, who: s.speaker || speakerLabel(s.who === 'me' ? 'me' : 'other', mode), at: s.startedAt, line: line.length > ASK_LIMITS.lineChars ? `${line.slice(0, ASK_LIMITS.lineChars)}…` : line, tr: (s.sentences ?? []).map((x) => x.tr).filter(Boolean).join(' ') }
    })
  const cost = rows.map((r) => estTokens(r.line) + 8)
  const total = cost.reduce((a, b) => a + b, 0)
  const chosen = new Set()
  let used = 0
  const add = (i) => {
    if (i < 0 || i >= rows.length || chosen.has(i)) return true
    if (used + cost[i] > budget) return false
    chosen.add(i)
    used += cost[i]
    return true
  }
  const win = scope ? rows.map((r, i) => (r.at >= scope.from && r.at <= scope.to ? i : -1)).filter((i) => i >= 0) : []
  const want = new Set([...queryTokens(query), ...termTokens(query, terms)])
  if (total <= budget) rows.forEach((_, i) => add(i))
  else {
    // 引用的那句和前后：回答一定要看得到它
    const qi = quoteId == null ? -1 : rows.findIndex((r) => r.id === quoteId)
    if (qi >= 0) for (const d of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) add(qi + d)
    if (scope) spread(win, budget * 0.85 - used)
    else {
      // 最近的一段：问题里没有能对上的词（「这是什么意思」「回答一下」）就几乎全给最近的
      const recent = budget * (want.size ? ASK_LIMITS.recentShare : 0.95)
      let tail = 0
      for (let i = rows.length - 1; i >= 0 && tail + cost[i] <= recent; i--) {
        tail += cost[i]
        add(i)
      }
    }
    // 和问题最相关的
    if (want.size) {
      const docs = rows.map((r) => searchTokens(`${r.line} ${r.tr}`))
      const df = new Map()
      for (const d of docs) for (const k of d) df.set(k, (df.get(k) ?? 0) + 1)
      const scored = docs
        .map((d, i) => {
          let sc = 0
          for (const k of want) if (d.has(k)) sc += Math.log(1 + rows.length / (df.get(k) ?? 1))
          return { i, sc }
        })
        .filter((x) => x.sc > 0)
        .sort((a, b) => b.sc - a.sc)
      for (const { i } of scored) {
        if (used >= budget * 0.95) break
        if (chosen.has(i)) continue
        add(i - 1)
        add(i)
        add(i + 1)
      }
    }
  }

  // 问的那段时间：放得下就整段；放不下按时间分成几组，每组从头取连着的几句（最后一组从最新的往前取），整段都照顾到
  function spread(idx, cap) {
    const need = idx.reduce((a, i) => a + cost[i], 0)
    if (need <= cap) return idx.forEach(add)
    const groups = Math.max(4, Math.min(24, Math.round(cap / 400)))
    const per = cap / groups
    for (let g = 0; g < groups; g++) {
      const part = idx.slice(Math.floor((g * idx.length) / groups), Math.floor(((g + 1) * idx.length) / groups))
      if (g === groups - 1) part.reverse()
      let got = 0
      for (const i of part) {
        if (got + cost[i] > per) break
        if (!add(i)) return
        got += cost[i]
      }
    }
  }

  const order = [...chosen].sort((a, b) => a - b)
  const refs = new Map()
  const ats = new Map()
  const out = []
  let prev = -1
  order.forEach((i, k) => {
    if (prev >= 0 && i - prev > 1) out.push(`……（中间省略 ${i - prev - 1} 句）`)
    const no = k + 1
    refs.set(no, rows[i].id)
    ats.set(rows[i].id, rows[i].at)
    out.push(`#${no} [${clockTime(rows[i].at)}] ${rows[i].who}：${rows[i].line}`)
    prev = i
  })
  if (order.length && order.at(-1) < rows.length - 1) out.push(`……（后面还有 ${rows.length - 1 - order.at(-1)} 句，没放进来）`)
  const inWin = scope ? win.filter((i) => chosen.has(i)) : order
  const range = inWin.length ? { from: rows[inWin[0]].at, to: rows[inWin.at(-1)].at } : null
  let note = ''
  if (scope) {
    const how = inWin.length === win.length ? '这段时间的字幕全在下面' : `这段时间有 ${win.length} 句，下面按时间均匀挑了 ${inWin.length} 句`
    note = win.length ? `这次问的是 ${scope.label}（${clockTime(rows[win[0]].at)} 到 ${clockTime(rows[win.at(-1)].at)}）：${how}，回答以这段为准。` : `这次问的是 ${scope.label}，这段时间没有字幕。`
  }
  return { text: out.join('\n'), refs, ats, shown: order.length, total: rows.length, range, note }
}

/** 实时笔记 → 编了号的文字（笔记 N）。放不下时先少给每节的要点，再只给标题。强调和作业按模式叫（会议是结论和待办）。 */
export function notesForAsk(notes, max = ASK_LIMITS.notesChars, mode = 'class') {
  if (!notes || typeof notes !== 'object') return ''
  const w = askWords(mode)
  const sections = notes.sections ?? []
  const build = (perSection) => {
    const lines = sections.map((s, i) => {
      const pts = (s.points ?? []).slice(0, perSection).map(oneLine)
      const fm = (s.formulas ?? []).slice(0, perSection > 0 ? 3 : 0).map((f) => `$${oneLine(f)}$`)
      const body = [...pts, ...fm].join('；')
      return `笔记${i + 1}${s.start ? `（${s.start}）` : ''} ${oneLine(s.title)}${body ? `：${body}` : ''}`
    })
    for (const e of notes.emphasis ?? []) if (e?.text) lines.push(`${w.emphasis}：${oneLine(e.text)}`)
    for (const h of notes.homework ?? []) if (h?.text) lines.push(`${w.homework}：${oneLine(h.text)}`)
    return lines.join('\n')
  }
  for (const n of [30, 5, 3, 0]) {
    const out = build(n)
    if (out.length <= max) return out
  }
  return build(0).slice(0, max) + '…'
}

/**
 * 课件里和问题最相关的几页。pages：[{ mat（第几份课件，从 1 数）, matName, n（页码）, text }]；只有一份课件时标成「课件pN」，几份时「课件1pN」。
 * → { text, picked: [{ tag, mat, n }] }
 */
export function pagesForAsk(pages, { query = '', terms = [], multi = false, limit = ASK_LIMITS.pages } = {}) {
  const want = new Set([...searchTokens(query), ...termTokens(query, terms)])
  if (!want.size || !pages.length) return { text: '', picked: [] }
  const docs = pages.map((p) => searchTokens(p.text))
  const df = new Map()
  for (const d of docs) for (const k of d) df.set(k, (df.get(k) ?? 0) + 1)
  const ranked = docs
    .map((d, i) => {
      let sc = 0
      for (const k of want) if (d.has(k)) sc += Math.log(1 + pages.length / (df.get(k) ?? 1))
      return { i, sc }
    })
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
  let left = ASK_LIMITS.pageTokens
  const picked = []
  const out = []
  for (const { i } of ranked) {
    const p = pages[i]
    const body = oneLine(p.text).slice(0, ASK_LIMITS.pageChars)
    const c = estTokens(body)
    if (c > left && picked.length) break
    left -= c
    const tag = multi ? `课件${p.mat}p${p.n}` : `课件p${p.n}`
    picked.push({ tag, mat: p.mat, n: p.n, matId: p.matId, name: p.matName })
    out.push(`${tag}（《${p.matName}》第 ${p.n} 页）：${body}`)
  }
  return { text: out.join('\n'), picked }
}

/** 课上截图：挑最多 N 张附图，有引用的那句就挑时间最近的，没有就挑最近截的。→ { list: 编了号的清单文字, attach: [slide] } */
export function slidesForAsk(slides, { quoteAt = null, clockTime, limit = ASK_LIMITS.images } = {}) {
  const all = (slides ?? []).filter((x) => x?.file).sort((a, b) => a.at - b.at)
  const listed = all.slice(-12)
  const index = (x) => all.indexOf(x) + 1
  let attach
  if (quoteAt != null) attach = [...listed].sort((a, b) => Math.abs(a.at - quoteAt) - Math.abs(b.at - quoteAt)).slice(0, limit)
  else attach = listed.slice(-limit)
  attach = attach.sort((a, b) => a.at - b.at)
  const list = listed.map((x) => `截图${index(x)}（${clockTime(x.at)}）${attach.includes(x) ? ' 附图' : ''}`).join('；')
  return { list, attach: attach.map((x) => ({ ...x, no: index(x) })) }
}

// 「覆盖」的三个词（讲过、提了一句、没讲到）各模式都一样，parseAsk 认的就是这三个
const TAIL = (w, web = false) => [
  '回答按下面的行写，一行一件事，不用 Markdown 标题、粗体和表格：',
  `第 1 行：「覆盖：」后面写 讲过、提了一句、没讲到 三选一。讲过：${w.it}（${w.seen}）讲到了问题问的内容；提了一句：${w.src}只在${w.aside}时顺带说了一个词或一句话、完全没有解释，这时在后面加上提到它的那句的编号，写成「覆盖：提了一句 #12」；没讲到：资料里完全没有。${w.src}用几句话解释过的就是「讲过」，拿不准时写「讲过」。`,
  '第 2 行：「要点：」后面一句话直接回答问题，不超过 30 个字。',
  '第 3 行起：2 到 4 行，每行以「- 」开头，只讲一件事；公式用 $…$ 写在句子里，重要的公式单独占一行、用 $$…$$ 包住（每个公式只占一行，不换行）。',
  `倒数第 2 行：「依据：」后面列出你用到的资料，用资料里的编号，空格隔开，例如「依据：${w.cite}${web ? ' 网1 网3' : ''}」；只列真正用到的，字幕编号最多 4 个（挑最能说明问题的）${web ? '，用到的搜索结果写「网N」，最多 3 个' : ''}，没有就写「依据：无」。`,
  '最后一行：「接着问：」后面给我一到两个顺着这个回答最可能想接着问的问题，每个不超过 20 个字，用「｜」隔开，只写普通文字：不要公式、$ 符号、下标和花括号，变量直接写字母。',
]

/** 能联网时加的一条：资料不够就先只写一行「搜索：<搜索词>」。parseSearch 认的就是这个格式。 */
const SEARCH_RULE = (w) =>
  `- 能联网查：问的是${w.src}只顺带提到、没解释的词（缩写、术语、人名、产品、事件），或者${w.it}的资料里没有、要最新的事实、数字、日期才答得准的，先查再答：整个回答只写一行「搜索：<搜索词>」就停，不写覆盖、要点和别的行。搜索词 2 到 6 个词，写成在搜索引擎里会搜的样子，缩写后面带上${w.it}所在的领域（比如「PPG 光电容积脉搏波」）。资料里已经讲清楚的、只问${w.it}里说了什么的，不要查，直接按下面的行回答。`

/**
 * search：这次能不能联网（DeepSeek 和会员才有）；web：这次的资料里有没有联网搜索的结果（有就按结果回答、引用写「网N」）。两个不会同时为真。
 */
export function askSystem({ lang = 'zh', live = true, mode = 'class', search = false, web = false } = {}) {
  const L = promptLang(lang)
  const w = askWords(mode)
  return [
    `你是我的${w.role}。我正在${w.doing(live)}，${w.src}${w.say}的内容在下面「${w.it}的资料」里。${w.who}${w.ask}，每次问一个问题。`,
    '回答的原则：',
    `- 先看资料里${w.src}是怎么${w.say}的，术语、符号和${w.src}的说法保持一致。回答用${L}写；${w.src}用的英文术语（或其他语言的术语）第一次出现时放在译名后面的括号里，比如「耦合（coupling）」。`,
    `- 短，一眼能扫完：一句要点，再 2 到 4 条，每条只讲一件事、不超过 50 个字（英文 30 个词），公式不算字数；一件事说不完就拆成两条或砍掉次要的。全部加起来不超过 200 个字。不复述问题，不客套，不写「根据资料」「${w.it}提到」这类铺垫，不附逐句翻译。`,
    `- ${w.gap}，用${L}说人话。`,
    `- 我引用了一句提问、只写了「回答」「帮我答」「怎么答」这类：是要你替我回答那个问题，要点写我能直接说出口的答案，几条写理由或例子；不要去讲${w.src}有没有给出答案。`,
    '- 问的是一段时间（刚才、最近几分钟、到现在、几点几分）时，资料里会写明问的是哪段：只讲那段时间里的内容，按时间顺序，不拿别的时间讲的事凑数。',
    web
      ? `- 资料里没有的内容先看「联网搜索的结果」，事实、数字、日期以结果为准；结果里也没有的按通用知识补充，拿不准的直说没查到。不要装作${w.src}${w.say}过，也不要编数字、名字和公式。${w.src}只提了一句或没${w.say}到时，照实填「覆盖」；要点和每一条都只讲问的东西本身，不写${w.src}讲没讲、讲到哪（界面已经写在上面）。`
      : `- 资料里没有的内容按通用知识补充，不要装作${w.src}${w.say}过；也不要编资料里没有的数字、名字和公式。${w.src}只提了一句或没${w.say}到时，照实填「覆盖」，回答里不用重复解释这件事（界面会写）。`,
    '- 问题和引用的字幕是语音识别出来的，可能有错字，按最可能的意思理解；和「术语」里的词发音相近的，就是那个术语。',
    `- 回答里不要写编号（#12 这类）${web ? '、网址' : ''}和时间，也不要提「资料」${web ? '和「搜索结果」' : ''}；编号只写在「依据」那一行。`,
    '- 不用破折号。',
    ...(search ? [SEARCH_RULE(w)] : []),
    '',
    ...TAIL(w, web),
  ].join('\n')
}

/** 搜索结果 → 编了号的文字（网1、网2…）。results：[{ title, url, date, summary }] */
export function webForAsk(results, max = ASK_LIMITS.webChars) {
  return (results ?? [])
    .map((r, i) => {
      const date = r.date ? `（${String(r.date).slice(0, 10)}）` : ''
      const body = oneLine(r.summary)
      return `网${i + 1} ${oneLine(r.title) || r.url}${date} ${r.url}\n${body.length > max ? `${body.slice(0, max)}…` : body}`
    })
    .join('\n')
}

/**
 * 组一次提问的请求。
 * session：{ startedAt, endedAt, title, mode }（mode 定 prompt 里怎么说：这节课、这场会、这场面试）；live：课还在上 / 会还在开；now：现在的时间；nowLabel：课上现在的钟点；
 * transcript / notes / pages / slides：取好的材料（见上面几个函数）；question：这次的问题；quote：{ segId, text, sel }；
 * history：之前几问 [{ q, quote, gist, points }]；keywords：术语（项目里设的和笔记里的）；context：课程背景。
 * → { system, messages, refs }：refs 是回答里的编号对应的东西。
 */
export function askMessages({ session, mode = session.mode ?? 'class', live, now = Date.now(), nowLabel = null, lang = 'zh', context = '', keywords = [], transcript, notes = '', pages = { text: '', picked: [] }, slides = { list: '', attach: [] }, question, quote = null, quoteLine = null, history = [], search = false, web = null }) {
  const parts = []
  const w = askWords(mode)
  const mins = Math.max(0, Math.round(((live ? now : (session.endedAt ?? now)) - session.startedAt) / 60000))
  // nowLabel：课上现在几点（字幕前面写的是钟点，问「刚才」「十分钟前」时模型要知道现在是几点）
  parts.push(`${live ? w.running(mins) : w.ended(mins)}${live && nowLabel ? `现在是 ${nowLabel}。` : ''}`)
  if (context?.trim()) parts.push(`${w.context}：${context.trim().slice(0, 600)}`)
  if (keywords.length) parts.push(`术语：${keywords.slice(0, 60).join('、')}`)
  const mat = []
  if (notes) mat.push(`${w.notes}（AI 边听边整理的，覆盖${w.whole}，编号「笔记N」）：\n${notes}`)
  if (pages.text) mat.push(`${w.deck}里和这个问题最相关的几页（编号「课件pN」）：\n${pages.text}`)
  if (slides.list) mat.push(`${w.in}截的屏幕画面：${slides.list}${slides.attach.length ? '。标着「附图」的附在这条消息后面，按截图编号从小到大' : ''}`)
  mat.push(`${w.in}的字幕（编号 #N，[时间] 说话人：原话；「……」是省略的部分）：\n${transcript.note ? `${transcript.note}\n` : ''}${transcript.text || '（还没有识别出字幕）'}`)
  parts.push(`${w.it}的资料：\n\n${mat.join('\n\n')}`)
  const webList = web?.results?.length ? web.results : null
  if (webList) parts.push(`刚才联网搜索了「${oneLine(web.query)}」，结果（编号「网N」，标题、日期、网址，下一行是摘要）：\n${webForAsk(webList)}`)
  if (quote) {
    const no = quoteLine?.no
    const sel = quote.sel && quote.sel !== quote.text ? `；我选中的是「${oneLine(quote.sel)}」` : ''
    parts.push(`我引用了这一句字幕${no ? `（#${no}）` : ''}：「${oneLine(quote.text)}」${sel}。`)
  }
  parts.push(`我的问题：${oneLine(question)}`)
  const ask = search && !webList
  parts.push(ask ? `记得${promptLang(lang)}回答：要联网查就只写一行「搜索：<搜索词>」；不用查就按「覆盖、要点、- 几条、依据、接着问」的行写。` : `记得${promptLang(lang)}回答，按「覆盖、要点、- 几条、依据、接着问」的行写。`)
  const content = parts.join('\n\n')
  const messages = []
  for (const h of history.slice(-ASK_LIMITS.history)) {
    const q = h.quote?.text ? `（引用字幕：${oneLine(h.quote.text).slice(0, 200)}）` : ''
    messages.push({ role: 'user', content: `${q}${oneLine(h.q)}`.trim() })
    messages.push({ role: 'assistant', content: historyText(h) })
  }
  messages.push({ role: 'user', content })
  const refs = {
    seg: transcript.refs,
    ats: transcript.ats,
    notes: (notes.match(/^笔记\d+/gm) ?? []).length,
    slides: new Map(slides.attach.map((x) => [x.no, x])),
    pages: pages.picked,
    web: webList ?? [],
  }
  return { system: askSystem({ lang, live, mode, search: ask, web: Boolean(webList) }), messages, refs }
}

function historyText(h) {
  const body = [h.gist ? `要点：${h.gist}` : '', ...(h.points ?? []).map((p) => `- ${p.tex ? `$$${p.tex}$$` : p.text}`)].filter(Boolean).join('\n')
  return body.length > ASK_LIMITS.historyChars ? `${body.slice(0, ASK_LIMITS.historyChars)}…` : body || '（没答完）'
}

/* ---------------- 解析回答 ---------------- */

// 接着问的按钮里不画公式：去掉 $ 和 LaTeX 的下标、花括号、反斜杠
const plain = (v) => v.replace(/\$/g, '').replace(/_\{([^}]*)\}/g, '_$1').replace(/\\([a-zA-Z]+)/g, '$1').replace(/[{}]/g, '')

// 公式写到一半（$ 没配成对）：先不露出那半截，写完那一刻才出现；停在半截时也不留一堆源码
const noOpenMath = (v) => ((v.match(/(?<!\\)\$/g) ?? []).length % 2 ? v.slice(0, v.lastIndexOf('$')).trimEnd() : v)

const COVER = { 讲过: 'full', 没讲到: 'none', 提了一句: 'partial' }

// 「搜索：<搜索词>」那一行（全角半角冒号都认，模型偶尔加粗）
const SEARCH_LINE = /^搜索\s*[:：]/

/**
 * 回答的第一行是不是「搜索：<搜索词>」（流式写到一半也能看）：
 * → { query }：是，这一行写完了（后面有换行，或者 final）；'wait'：还看不出来（第一行刚写了「搜」，或者搜索词还没写完）；null：不是，照常回答。
 */
export function parseSearch(raw, { final = false } = {}) {
  const text = noDashes(String(raw ?? '')).replace(/\r/g, '').replace(/^\s+/, '')
  if (!text) return final ? null : 'wait'
  const nl = text.indexOf('\n')
  const first = stripMd(nl >= 0 ? text.slice(0, nl) : text).trim()
  const done = nl >= 0 || final
  if (!SEARCH_LINE.test(first)) return !done && '搜索：'.startsWith(first.replace(/:$/, '：')) ? 'wait' : null
  if (!done) return 'wait'
  const query = first
    .replace(SEARCH_LINE, '')
    .replace(/^[\s*「“"']+|[\s*」”"'。.]+$/g, '')
    .trim()
  return query ? { query } : null
}

function stripMd(s) {
  return s.replace(/\*\*|__/g, '').replace(/^\s*#{1,6}\s+/, '')
}

/**
 * 模型写的回答（流式写到一半也行）→ { cover, gist, points, src, next }。
 * cover：{ kind: 'full' | 'partial' | 'none', segNo? }；points：[{ text } | { tex }]；src：[{ type, ... }]（只在写完时才解析，编号对不上的丢掉）。
 * refs：askMessages 给的 refs。final 为真时没按格式写的回答也尽量拆出要点和几条。
 */
export function parseAsk(raw, refs = null, { final = false } = {}) {
  const text = noDashes(String(raw ?? '')).replace(/\r/g, '')
  const lines = text.split('\n')
  const out = { cover: null, gist: '', points: [], src: [], next: [], formatted: false }
  let srcLine = ''
  let nextLine = ''
  let open = null // 还没写完的 $$ 公式
  const lastIndex = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    const complete = i < lastIndex || final
    const line = stripMd(lines[i]).trim()
    if (!line) continue
    if (open) {
      open.text += ` ${line}`
      if (/\$\$\s*$/.test(line)) {
        if (complete) out.points.push({ tex: open.text.replace(/^\s*\$\$|\$\$\s*$/g, '').trim() })
        open = null
      }
      continue
    }
    let m
    if (SEARCH_LINE.test(line)) continue
    if ((m = line.match(/^覆盖\s*[:：]\s*(讲过|没讲到|提了一句)\s*(?:#(\d+))?/))) {
      out.formatted = true
      out.cover = { kind: COVER[m[1]], ...(m[2] ? { segNo: Number(m[2]) } : {}) }
      if (out.cover.kind === 'partial' && !m[2]) {
        const n = line.match(/#(\d+)/)
        if (n) out.cover.segNo = Number(n[1])
      }
    } else if ((m = line.match(/^要点\s*[:：]\s*(.*)$/))) {
      out.formatted = true
      out.gist = m[1].trim()
    } else if ((m = line.match(/^依据\s*[:：]\s*(.*)$/))) {
      srcLine = m[1]
    } else if ((m = line.match(/^接着问\s*[:：]\s*(.*)$/))) {
      nextLine = m[1]
    } else if (/^\$\$/.test(line)) {
      if (/^\$\$[\s\S]+\$\$$/.test(line) && line.length > 4) out.points.push({ tex: line.replace(/^\$\$|\$\$$/g, '').trim() })
      else open = { text: line }
    } else if ((m = line.match(/^(?:[-*•·]|\d+[.、)])\s+(.*)$/))) {
      // 一条要点只有一个公式时当独占一行的公式画，和别的公式一样
      const only = m[1].trim().match(/^\$([^$]+)\$[。.，,;；]?$/)
      if (only) out.points.push({ tex: only[1].trim() })
      else if (m[1].trim()) out.points.push({ text: m[1].trim() })
    } else if (out.formatted && out.points.length) {
      // 上一条写到下一行去了
      const last = out.points.at(-1)
      if (last.text != null) last.text += ` ${line}`
    } else if (!out.formatted && final) {
      // 没按格式写：第一行当要点，其余各算一条
      if (!out.gist) out.gist = line
      else out.points.push({ text: line })
    }
  }
  out.gist = noOpenMath(out.gist)
  for (const p of out.points) if (p.text != null) p.text = noOpenMath(p.text)
  out.points = out.points.filter((p) => (p.tex ?? p.text)?.length).slice(0, 6)
  out.next = nextLine
    .split(/[｜|]/)
    .map((s) => plain(s).trim().replace(/^["「“]|["」”]$/g, ''))
    .filter((s) => s && s !== '无')
    .slice(0, 2)
  if (final) out.src = resolveSources(srcLine, refs)
  return out
}

/** 回答里的 cover.segNo（字幕编号）换成字幕 id。 */
export function coverOf(cover, refs) {
  if (!cover) return undefined
  if (cover.kind !== 'partial') return { kind: cover.kind }
  const id = cover.segNo != null ? refs?.seg?.get(cover.segNo) : null
  return id != null ? { kind: 'partial', segId: id, ...(refs.ats?.has(id) ? { at: refs.ats.get(id) } : {}) } : { kind: 'partial' }
}

// 出处按钮上写的网站：只留主域名（img2.kepuchina.cn → kepuchina.cn）；.com.cn、.ac.uk 这类两段的后缀留三段。完整网址在悬停提示里
const hostOf = (url) => {
  let host
  try {
    host = new URL(url).hostname
  } catch {
    return ''
  }
  const parts = host.split('.')
  if (parts.length <= 2 || /^\d+$/.test(parts.at(-1))) return host
  const two = /^(com|net|org|gov|edu|ac|co|or|ne|go)$/.test(parts.at(-2)) && parts.at(-1).length === 2
  return parts.slice(two ? -3 : -2).join('.')
}

/** 「依据」那一行里的编号 → [{ type: 'seg', id } | { type: 'note', n } | { type: 'slide', file, at } | { type: 'page', mat, n } | { type: 'web', url, title, site }]，同一个只出一次，认不出的丢掉。 */
export function resolveSources(line, refs) {
  const src = []
  const seen = new Set()
  let segs = 0
  const push = (key, item) => {
    if (seen.has(key)) return
    // 字幕时间点最多 4 个：多了一排时间看不过来，也点不出哪个才是关键
    if (item.type === 'seg' && segs >= 4) return
    if (item.type === 'seg') segs++
    seen.add(key)
    src.push(item)
  }
  if (!refs) return src
  let webs = 0
  for (const m of String(line ?? '').matchAll(/#(\d+)|笔记\s*(\d+)|截图\s*(\d+)|课件\s*(\d*)\s*p\.?\s*(\d+)|网\s*(\d+)/gi)) {
    if (m[6]) {
      // 搜索结果：只放能用系统浏览器打开的 https 网址
      const r = refs.web?.[Number(m[6]) - 1]
      if (r && /^https:\/\//.test(r.url) && !seen.has(`w${r.url}`) && webs < ASK_LIMITS.webSources) {
        webs++
        seen.add(`w${r.url}`)
        src.push({ type: 'web', url: r.url, title: oneLine(r.title).slice(0, 200), site: hostOf(r.url) })
      }
      continue
    }
    if (m[1]) {
      const id = refs.seg?.get(Number(m[1]))
      if (id != null) push(`s${id}`, { type: 'seg', id, ...(refs.ats?.has(id) ? { at: refs.ats.get(id) } : {}) })
    } else if (m[2]) {
      const n = Number(m[2])
      if (n >= 1 && n <= (refs.notes ?? 0)) push(`n${n}`, { type: 'note', n: n - 1 })
    } else if (m[3]) {
      const x = refs.slides?.get(Number(m[3]))
      if (x) push(`i${x.file}`, { type: 'slide', file: x.file, at: x.at })
    } else if (m[5]) {
      const mat = m[4] ? Number(m[4]) : 1
      const n = Number(m[5])
      const p = (refs.pages ?? []).find((x) => x.mat === mat && x.n === n)
      if (p) push(`p${mat}-${n}`, { type: 'page', mat: p.mat, n: p.n, ...(p.matId ? { matId: p.matId, name: p.name } : {}) })
    }
  }
  return src
}

/* ---------------- 课堂笔记末尾的「课上问过的」 ---------------- */

// 一行注释标出这一段从哪里开始，重新生成笔记、再问了新的问题时整段换掉，不会越堆越多（marked 和图文笔记都不渲染原始 HTML）
export const ASKED_MARK = '<!--asked-->'

const askedAt = (r, startedAt) => (r.after ? t('下课后') : clock(r.askedAt - startedAt))

/** 一条问答在课堂笔记里的一行：时间、问题、一句要点 */
export function askedLine(r, startedAt) {
  const q = oneLine(r.q).slice(0, 120)
  const quoted = r.quote?.text ? oneLine(r.quote.sel || r.quote.text) : ''
  const gist = oneLine(r.gist || r.points?.find((p) => p.text)?.text || '').slice(0, 160)
  // 问句末尾已经有问号：后面直接接要点，不再加冒号（全角冒号紧跟问号，粗体后面会空出一截）
  return `- ${askedAt(r, startedAt)} **${q}**${quoted ? t(`（引用「{0}」）`, quoted.length > 24 ? `${quoted.slice(0, 24)}…` : quoted) : ''}${gist ? `${/[?？]$/.test(q) ? ' ' : '：'}${gist}` : ''}`
}

/** 课堂笔记的 Markdown 末尾接上「课上问过的」（已经有的先去掉）；一条都没有就不接。asks 里没答出内容的不算。 */
export function withAsked(markdown, asks, startedAt) {
  const md = String(markdown ?? '')
  const i = md.indexOf(ASKED_MARK)
  const base = i >= 0 ? md.slice(0, i).replace(/\s+$/, '\n') : md
  const list = (asks ?? []).filter((r) => r.gist || r.points?.length).sort((a, b) => a.askedAt - b.askedAt)
  if (!md.trim() || !list.length) return base
  return `${base.replace(/\s+$/, '')}\n\n${ASKED_MARK}\n## ${t('课上问过的')}\n\n${list.map((r) => askedLine(r, startedAt)).join('\n')}\n\n${t('完整的回答在「问 AI」里看，点时间回到那句字幕。')}\n`
}

