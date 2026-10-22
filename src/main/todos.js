import crypto from 'node:crypto'
import { calendarText, cleanText, dateLabel, extractJson, transcriptText, ymd } from './prompts.js'
import { INBOX_ID } from './projects.js'

// 待办和 DDL：纪要生成后再让模型做一次结构化提取，每条标到一个项目，存进 session.summary.items：
// { id, text, due: 'YYYY-MM-DD' | null, dueUncertain?, dueText, owner: 'me' | 'other' | null, projectId, quote, at, done, doneAt? }
// at 是原话在会议里的位置（距开始的毫秒数），没有就是 null。dueUncertain：日期拿不准（纪要标了待确认，或者原话里星期几和日期对不上），
// 界面上带「待确认」；用户手动改过日期就去掉。

const MAX_ITEMS = 50

/* ---------------- prompt ---------------- */

function projectLine(p) {
  const bits = [`id=${p.id}`, `名称：${p.name}`]
  if (p.description) bits.push(`简介：${p.description}`)
  if (p.context) bits.push(`背景：${p.context.slice(0, 200)}`)
  if (p.keywords) bits.push(`术语：${p.keywords.replace(/\s*\n\s*/g, '，').slice(0, 120)}`)
  if (p.id === INBOX_ID) bits.push('（放不进任何项目的事放这里）')
  return `- ${bits.join('；')}`
}

/** 提取待办的请求。projects 是全部没归档的项目（含未归类），project 是这场会议所属的项目。 */
export function todoMessages({ session, summary, project, projects }) {
  const list = projects.filter((p) => !p.archived || p.id === project?.id)
  const system = `你是会议助理，从一场会议的纪要和识别稿里提取待办事项和截止时间（DDL），输出 JSON。
「我」是用户，「对方」是会上的其他人。

项目清单（每条待办都要标到最相关的一个项目，填它的 id）：
${list.map(projectLine).join('\n')}
这场会议属于「${project?.name ?? '未归类'}」（id=${project?.id ?? INBOX_ID}）。一件事明显属于别的项目就标那个项目，拿不准就用这场会议的项目。

会议日期：${dateLabel(session.startedAt)}。日历：
${calendarText(session.startedAt)}
${relativeDayHints(session.startedAt)}
相对日期（tomorrow、next Friday、in two weeks、下周三、月底）都按会议日期换算成具体日期 YYYY-MM-DD；「next + 星期几」指下一周的那一天；只有月日没有年份的取会议日期之后最近的那一天。
纪要的「我要做的事」「DDL 与时间节点」已经给一件事写了一个具体日期的，due 就用纪要的日期：纪要是结合上下文定的，比如对方一口气提了几件事、最后才说 by Monday，前面几件也是这个截止。纪要写着日期冲突或待确认的，按原话自己换算。原话和纪要都没给时间的 due 写 null。

规则：
- 只提取明确要做的事：谁答应要做、被要求做的事，约好的截止时间、会议和面试。泛泛的讨论不算。
- text：一句简体中文，动词开头，具体到能照着做；术语、人名、公司名保留原文；不要用破折号。
- owner：me（我要做）、other（对方要做）、null（双方一起或说不清）。
- dueText：原话里的时间说法，原样保留（比如 "by next Friday"），没有写 null。
- quote：识别稿里的原话依据，原样保留英文，不超过 120 个字符。
- at：原话在识别稿里的时间戳（mm:ss 或 h:mm:ss），没有写 null。
- 同一件事只写一条；没有待办就给空数组。
- title：给这场会起一个简短的中文标题（不超过 20 个字），说清楚主要谈了什么。

只输出一个 JSON 对象，不要代码块，不要别的文字：
{"title":"…","items":[{"text":"…","due":"YYYY-MM-DD","dueText":"…","owner":"me","projectId":"…","quote":"…","at":"mm:ss"}]}`
  const parts = []
  if (summary) parts.push(`会议纪要：\n${summary}`)
  parts.push(`识别稿（[分:秒] 说话人：内容）：\n${transcriptText(session)}`)
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/* ---------------- 日期 ---------------- */

const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const ZH_DAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const ZH_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const EN_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2 }

const EN_ORD = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth']
// 日子：3、3rd，或者英文单词 third、twenty-first（识别稿里常是单词）。单词容易撞上普通说法（the first may…、may the fourth），
// 所以单词只认「the third of October」和「October (the) third」，而且 may、march 后面不接单词
const DAY_NUM = '\\d{1,2}(?:st|nd|rd|th)?'
const DAY_ORD = `(?:twenty|thirty)[\\s-]?(?:${EN_ORD.slice(0, 9).join('|')})|twentieth|thirtieth|${EN_ORD.join('|')}`
const MONTHS = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const MONTHS_NOT_VERB = '(jan|feb|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
const EN_DATE_MD = new RegExp(`\\b${MONTHS}\\s+(?:the\\s+)?(${DAY_NUM})\\b|\\b${MONTHS_NOT_VERB}\\s+(?:the\\s+)?(${DAY_ORD})\\b`)
const EN_DATE_DM = new RegExp(`\\b(?:the\\s+)?(${DAY_NUM})\\s+(?:of\\s+)?${MONTHS}(?![a-z])|\\b(?:the\\s+)?(${DAY_ORD})\\s+of\\s+${MONTHS}(?![a-z])`)

function dayNumber(s) {
  const t = s.replace(/(?<=\d)(st|nd|rd|th)$/, '')
  if (/^\d+$/.test(t)) return Number(t)
  if (t === 'twentieth') return 20
  if (t === 'thirtieth') return 30
  const m = t.match(/^(twenty|thirty)[\s-]?(\w+)$/)
  if (m) return (m[1] === 'twenty' ? 20 : 30) + EN_ORD.indexOf(m[2]) + 1
  const i = EN_ORD.indexOf(t)
  return i >= 0 ? i + 1 : null
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7))

function num(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (s in EN_NUM) return EN_NUM[s]
  if (s === '十') return 10
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + ZH_NUM[s[1]]
  return ZH_NUM[s] ?? null
}

// 某个星期几：weekOffset=1 是下一周（周一开始）那一天；null 表示「最近的下一个」（不含今天）
function weekday(base, day, weekOffset) {
  if (weekOffset == null) {
    const diff = (day - base.getDay() + 7) % 7 || 7
    return addDays(base, diff)
  }
  const d = addDays(mondayOf(base), weekOffset * 7 + ((day + 6) % 7))
  return weekOffset === 0 && d < base ? addDays(d, 7) : d
}

function monthDay(base, month, day) {
  let d = new Date(base.getFullYear(), month, day)
  if (d.getMonth() !== month) return null
  if (d < addDays(base, -30)) d = new Date(base.getFullYear() + 1, month, day)
  return d
}

const EN_DAY_TITLES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** 英文「this / next + 星期几」对照表（和 resolveRelativeDate 同一套规则），放进 prompt，模型换算日期时照着查。 */
export function relativeDayHints(meetingAt) {
  const pairs = EN_DAY_TITLES.flatMap((day) => [`this ${day} = ${resolveRelativeDate(`this ${day}`, meetingAt)}`, `next ${day} = ${resolveRelativeDate(`next ${day}`, meetingAt)}`])
  return `英文说法对照：${pairs.join('，')}`
}

/** 常见的相对日期说法 → 'YYYY-MM-DD'，认不出返回 null。模型没换算出日期时兜底用。 */
export function resolveRelativeDate(text, meetingAt) {
  const t = String(text ?? '').toLowerCase()
  if (!t) return null
  const d0 = new Date(meetingAt)
  const base = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate())
  let m
  if (/day after tomorrow|后天/.test(t)) return ymd(addDays(base, 2))
  if (/\btomorrow\b|明天|明早|明晚/.test(t)) return ymd(addDays(base, 1))
  if (/\btoday\b|\btonight\b|今天|今晚|今早/.test(t)) return ymd(base)
  if ((m = t.match(/\bin (\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a couple of) (day|week)s?\b/))) {
    const n = num(m[1].replace(/^a couple of$/, 'couple'))
    if (n) return ymd(addDays(base, m[2] === 'week' ? n * 7 : n))
  }
  if ((m = t.match(/(\d+|[一二两三四五六七八九十]+)\s*(天|周|个星期|个礼拜)\s*(后|之后|以后|内)/))) {
    const n = num(m[1])
    if (n) return ymd(addDays(base, m[2] === '天' ? n : n * 7))
  }
  // 带月份的具体日期先认：「next Friday, October 9th」说的是 10 月 9 日（和星期几对不上的由 dateClash 另外标出来）
  const date = explicitDate(t, base)
  if (date) return date
  if ((m = t.match(/\b(next|this|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const day = EN_DAYS.indexOf(m[2])
    const off = m[1] === 'next' ? 1 : m[1] === 'this' ? 0 : null
    return ymd(weekday(base, day, off))
  }
  if ((m = t.match(/(下下|下个?|这个?|本)?\s*(?:周|星期|礼拜)([一二三四五六日天])/))) {
    const day = ZH_DAYS[m[2]]
    const off = !m[1] ? null : m[1] === '下下' ? 2 : m[1].startsWith('下') ? 1 : 0
    return ymd(weekday(base, day, off))
  }
  return null
}

// 带月份的具体日期（10月3日、October 3rd、the third of October）→ 'YYYY-MM-DD'；有这种说法但不是真日期给 null，没有给 undefined
function explicitDate(t, base) {
  let m
  if ((m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) {
    const d = monthDay(base, Number(m[1]) - 1, Number(m[2]))
    return d ? ymd(d) : null
  }
  const md = t.match(EN_DATE_MD)
  const dm = t.match(EN_DATE_DM)
  if (md || dm) {
    const [mon, day] = md && (!dm || md.index <= dm.index) ? [md[1] ?? md[3], md[2] ?? md[4]] : [dm[2] ?? dm[4], dm[1] ?? dm[3]]
    const n = dayNumber(day)
    const d = n ? monthDay(base, EN_MONTHS.indexOf(mon), n) : null
    return d ? ymd(d) : null
  }
  return undefined
}

/**
 * 同一个说法里既说了星期几、又说了带月份的日期，两者对不上（「next Friday, the 3rd of October」，10 月 3 日是周六）→ 两个候选日期，早的在前；
 * 对得上（具体日期正好是那个星期几）或者只说了一种，返回 null。
 */
export function dateClash(text, meetingAt) {
  const t = String(text ?? '').toLowerCase()
  if (!t) return null
  const d0 = new Date(meetingAt)
  const base = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate())
  const date = explicitDate(t, base)
  if (!date) return null
  let m
  let named
  let byDay
  if ((m = t.match(/\b((?:next|this|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    named = EN_DAYS.indexOf(m[2])
    byDay = resolveRelativeDate(m[0], meetingAt)
  } else if ((m = t.match(/(下下|下个?|这个?|本)?\s*(?:周|星期|礼拜)([一二三四五六日天])/))) {
    named = ZH_DAYS[m[2]]
    byDay = resolveRelativeDate(m[0], meetingAt)
  } else return null
  const [y, mo, d] = date.split('-').map(Number)
  if (new Date(y, mo - 1, d).getDay() === named || !byDay || byDay === date) return null
  return [byDay, date].sort()
}

const RULE_EN = /^(?:(?:due|by|before|until|till|on|this is due|it is due|it's due)\s+)*(this|next)\s+(mon|tues|wednes|thurs|fri|satur|sun)day\b(?:\s+(?:before|by|at)\s+(?:midnight|noon|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|eight|nine|ten|eleven|twelve|[a-z]+ p\.?m\.?))?[\s.!]*$/i
const RULE_ZH = /^(?:在|于)?(下|这|本)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])(?:之前|以前|前|截止|晚上|上午|下午|中午|午夜|\d{1,2}点|[\s，,。])*$/

/**
 * 「this / next + 星期几」「下周三」这类说法按固定规则算（和 prompt 里给模型的规则一样）；
 * 只认整句就是这种说法的（可以带 by、before midnight、at 8 p.m. 这类修饰），「two weeks from next Monday」这种不管。
 * 模型偶尔会把 next Wednesday 算到下下周，这里把它拉回来，纪要、实时笔记、待办三处日期才一致。
 */
export function ruleDate(dueText, meetingAt) {
  const t = String(dueText ?? '').trim()
  if (!t || !(RULE_EN.test(t) || RULE_ZH.test(t))) return null
  return resolveRelativeDate(t, meetingAt)
}

/** 'YYYY-MM-DD'、'YYYY/M/D'、带时间的 ISO 串 → 'YYYY-MM-DD'；不是真实日期返回 null。 */
export function normalizeDate(v) {
  const m = String(v ?? '').trim().match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const x = new Date(y, mo, d)
  return x.getFullYear() === y && x.getMonth() === mo && x.getDate() === d ? ymd(x) : null
}

/* ---------------- 纪要里写明的截止日期 ---------------- */

const DATE_RE = /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}/g

// 截止写法 → { due, uncertain } | null。只有一个日期、也没说拿不准的是写明了；写了冲突、待确认、推测，或者给了几个日期的，
// 算拿不准（「2026-10-02 或 2026-10-03，日期冲突」「2026-10-03（待确认）」「2026-09-29，推测」），due 取最早的日期，一个日期都没有就是 null。
// 既没日期、也没说拿不准的（「无明确截止」）返回 null。
function deadlineOf(s) {
  const t = String(s ?? '')
  const dates = [...new Set((t.match(DATE_RE) ?? []).map((x) => normalizeDate(x.replace(/\s/g, ''))).filter(Boolean))].sort()
  const uncertain = /冲突|待确认|推测|不确定|或/.test(t) || dates.length > 1
  if (!dates.length && !uncertain) return null
  return { due: dates[0] ?? null, uncertain }
}

const quoteOf = (s) => String(s ?? '').match(/["“「]([^"”」]{4,})["”」]/)?.[1] ?? ''

/**
 * 纪要（课堂笔记）里给了截止时间的事 → [{ text, due, uncertain, quote }]，拿不准的也列出来（uncertain，due 可能是 null）。认两种写法：
 * 待办行「- [ ] 事项（截止：2026-09-28）  原话："…" [mm:ss]」和 DDL 表格行「| 2026-09-28（周一） | 事项 | "原话" |」。
 * 截止写法里还套着括号的（「截止：2026-10-03（待确认））」）也认。
 */
export function summaryDeadlines(markdown) {
  const out = []
  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw.trim()
    const m = line.match(/^[-*+]\s*(?:\[[ xX]?\]\s*)?(.+?)[（(]\s*(?:截止(?:时间|日期)?|DDL|due)\s*[：:]\s*((?:[^（()）]|[（(][^（()）]*[）)])*)[）)](.*)$/i)
    if (m) {
      const dl = deadlineOf(m[2])
      if (dl) out.push({ text: m[1].trim(), ...dl, quote: quoteOf(m[3]) })
      continue
    }
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    const dl = cells.length >= 2 ? deadlineOf(cells[0]) : null
    if (dl) out.push({ text: cells[1], ...dl, quote: quoteOf(cells[2]) || cells[2] || '' })
  }
  return out
}

// 事项文字像不像：英文词和数字按词（专有名词、术语分量重，算 2），中文按相邻两个字，加权 Dice 系数
function termWeights(s) {
  const w = new Map()
  const add = (k, v) => w.set(k, Math.max(w.get(k) ?? 0, v))
  const t = String(s ?? '').toLowerCase()
  for (const x of t.match(/[a-z0-9]+/g) ?? []) add(x, 2)
  for (const run of t.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) add(run, 1)
    for (let i = 0; i + 1 < run.length; i++) add(run.slice(i, i + 2), 1)
  }
  return w
}

function similarity(a, b) {
  const A = termWeights(a)
  const B = termWeights(b)
  let shared = 0
  let total = 0
  for (const [k, v] of A) {
    total += v
    if (B.has(k)) shared += Math.min(v, B.get(k))
  }
  for (const v of B.values()) total += v
  return total ? (2 * shared) / total : 0
}

/**
 * 一条待办在纪要的截止时间里对应哪一条：事项文字很像（0.75），或者原话对得上、文字也有几分像（0.4）。→ { due, uncertain } | null
 * 最像的一条写明了日期、另有一条也写明了不同日期又差不多像（差不到 0.15）：对不准是哪一条，返回 null。
 * 最像的一条拿不准又没写日期，用差不多像的几条里最早的日期。
 */
export function summaryHit(item, deadlines) {
  const q = norm(item.quote)
  const scored = deadlines.map((d) => {
    const dq = norm(d.quote)
    const sameQuote = q.length >= 8 && dq.length >= 8 && (dq.includes(q) || q.includes(dq))
    return { ...d, score: similarity(item.text, d.text) + (sameQuote ? 0.35 : 0) }
  })
  const best = scored.reduce((a, b) => (b.score > (a?.score ?? -1) ? b : a), null)
  if (!best || best.score < 0.75) return null
  const close = scored.filter((x) => x.score > best.score - 0.15)
  if (!best.uncertain && close.some((x) => !x.uncertain && x.due !== best.due)) return null
  if (best.uncertain && !best.due) return { due: close.map((x) => x.due).filter(Boolean).sort()[0] ?? null, uncertain: true }
  return { due: best.due, uncertain: Boolean(best.uncertain) }
}

/** 纪要里写明（不是待确认）的截止日期，对不上或拿不准返回 null。 */
export function dueFromSummary(item, deadlines) {
  const hit = summaryHit(item, deadlines)
  return hit && !hit.uncertain ? hit.due : null
}

/**
 * 一条待办的截止日期和拿不准标记。own：原话按规则算的 / 模型给的；clash：原话里星期几和日期对不上的两个候选；hit：纪要里对应的那条。
 * 纪要写明了、原话也没矛盾：用 own（没有再用纪要的）。纪要标了拿不准，或者原话自相矛盾：标待确认，日期优先跟纪要一致，
 * 纪要没给日期就取两个候选里早的（宁早勿晚）。纪要选了候选里的一个、又没说拿不准，就用纪要的。
 */
function pickDue(own, clash, hit) {
  if (hit && !hit.uncertain && (!clash || clash.includes(hit.due))) return { due: clash ? hit.due : own ?? hit.due, uncertain: false }
  if (hit?.uncertain || clash) return { due: hit?.due ?? clash?.[0] ?? own, uncertain: true }
  return { due: own, uncertain: false }
}

/** 'mm:ss' / 'h:mm:ss' / '[12:34]' / 秒数 → 毫秒；认不出返回 null。 */
export function parseAt(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 1000)
  const m = String(v ?? '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] == null ? null : Number(m[3])]
  return (c == null ? a * 60 + b : a * 3600 + b * 60 + c) * 1000
}

function owner(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (['me', 'i', 'user', 'self', '我', '用户'].includes(s)) return 'me'
  if (['other', 'others', 'them', 'they', '对方', '他们', '老师', '导师'].includes(s)) return 'other'
  return null
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s，,。.；;：:！!？?"'“”「」]/g, '')

/* ---------------- 解析 ---------------- */

function parseArray(s) {
  const i = s.indexOf('[')
  const j = s.lastIndexOf(']')
  if (i < 0 || j <= i) return null
  try {
    const arr = JSON.parse(s.slice(i, j + 1))
    return Array.isArray(arr) ? { items: arr } : null
  } catch {
    return null
  }
}

// 要的是 {"items": [...]}，但模型也可能直接给数组；数组在对象前面出现时先当数组解析
function parseLoose(text) {
  const s = String(text ?? '')
  const bracket = s.indexOf('[')
  const brace = s.indexOf('{')
  if (bracket >= 0 && (brace < 0 || bracket < brace)) {
    const arr = parseArray(s)
    if (arr) return arr
  }
  return extractJson(s) ?? parseArray(s)
}

/**
 * 解析提取结果，尽量容错：代码块包裹、多余文字、直接给数组、字段名换了说法、项目给了名字而不是 id、日期格式不对。
 * projects：[{ id, name }]；fallbackProjectId：认不出项目时用（这场会议的项目）；startedAt：会议开始时间（换算相对日期）；
 * summary：纪要 Markdown，没日期的待办按它补上纪要里写明的截止日期。
 * → { title, items }
 */
export function parseTodoItems(raw, { projects = [], fallbackProjectId = INBOX_ID, startedAt = Date.now(), summary = '' } = {}) {
  const v = parseLoose(raw)
  if (!v) return { title: '', items: [], error: '模型没有返回能解析的 JSON' }
  const deadlines = summaryDeadlines(summary)
  let list = v.items ?? v.todos ?? v.tasks ?? v.actionItems ?? []
  if (!Array.isArray(list)) list = []
  const ids = new Set(projects.map((p) => p.id))
  const byName = new Map(projects.map((p) => [norm(p.name), p.id]))
  const items = []
  const seen = new Set()
  for (let x of list) {
    if (typeof x === 'string') x = { text: x }
    if (!x || typeof x !== 'object') continue
    const text = cleanText(x.text ?? x.task ?? x.title ?? x.item).slice(0, 300)
    if (!text || seen.has(norm(text))) continue
    seen.add(norm(text))
    let pid = String(x.projectId ?? x.project_id ?? x.project ?? '').trim().replace(/^id\s*=\s*/, '')
    if (!ids.has(pid)) pid = byName.get(norm(pid)) ?? fallbackProjectId
    const dueText = cleanText(x.dueText ?? x.due_text ?? x.deadlineText ?? '') || null
    const quote = cleanText(x.quote ?? x.evidence ?? '').slice(0, 300) || null
    // 前面都没得出日期的，纪要里给这件事写明了日期就用纪要的（纪要结合上下文定过，两边才一致）；纪要标了待确认的，这里也标
    const own = ruleDate(dueText, startedAt) ?? normalizeDate(x.due ?? x.deadline ?? x.date) ?? (dueText ? resolveRelativeDate(dueText, startedAt) : null)
    const clash = dueText ? dateClash(dueText, startedAt) : dateClash(quote, startedAt)
    const { due, uncertain } = pickDue(own, clash, summaryHit({ text, quote }, deadlines))
    items.push({
      id: 't_' + crypto.randomBytes(5).toString('hex'),
      text,
      due,
      ...(uncertain ? { dueUncertain: true } : {}),
      dueText: dueText ? dueText.slice(0, 80) : null,
      owner: owner(x.owner ?? x.who ?? x.assignee),
      projectId: pid,
      quote,
      at: parseAt(x.at ?? x.time ?? x.timestamp),
      done: false,
    })
    if (items.length >= MAX_ITEMS) break
  }
  const title = cleanText(v.title ?? '').slice(0, 40)
  return { title, items }
}

/** 重新提取后，原来勾掉的、用户改过项目的，按事项文字对上就保留。 */
export function carryOver(oldItems = [], items = []) {
  const old = new Map(oldItems.map((x) => [norm(x.text), x]))
  return items.map((x) => {
    const o = old.get(norm(x.text))
    if (!o) return x
    const out = { ...x, id: o.id, done: Boolean(o.done) }
    if (o.doneAt) out.doneAt = o.doneAt
    if (o.edited?.projectId) out.projectId = o.projectId
    if (o.edited) out.edited = o.edited
    return out
  })
}

/* ---------------- 修改 ---------------- */

/** 界面改一条待办：只认这几个字段。返回改好的新对象（不改原对象）。 */
export function patchTodo(item, patch = {}, { projects = [] } = {}) {
  const out = { ...item }
  const edited = { ...(item.edited ?? {}) }
  if (patch.done !== undefined) {
    out.done = Boolean(patch.done)
    if (out.done) out.doneAt = item.done ? item.doneAt ?? Date.now() : Date.now()
    else delete out.doneAt
  }
  if (typeof patch.text === 'string' && patch.text.trim()) {
    out.text = cleanText(patch.text).slice(0, 300)
    edited.text = true
  }
  if (patch.due !== undefined) {
    out.due = patch.due === null || patch.due === '' ? null : normalizeDate(patch.due) ?? out.due
    delete out.dueUncertain // 用户自己定了日期
    edited.due = true
  }
  if (patch.dueText !== undefined) out.dueText = patch.dueText ? String(patch.dueText).slice(0, 80) : null
  if (patch.owner !== undefined) out.owner = owner(patch.owner)
  if (patch.projectId !== undefined) {
    if (!projects.some((p) => p.id === patch.projectId)) throw Object.assign(new Error('找不到这个项目'), { code: 'no-project' })
    out.projectId = patch.projectId
    edited.projectId = true
  }
  if (Object.keys(edited).length) out.edited = edited
  return out
}

/* ---------------- 聚合 ---------------- */

/**
 * 跨项目的待办列表。records 是 SessionStore.records()；knownProjects 是现有项目 id 的集合，
 * 指向已删除项目的待办算到「未归类」。排序：有截止日期的按日期，没有的在后面；同一天按会议新的在前。
 */
export function aggregateTodos(records, { projectId, includeDone = false, knownProjects } = {}) {
  const out = []
  for (const r of records) {
    for (const item of r.items ?? []) {
      if (!item || typeof item !== 'object') continue
      const pid = !knownProjects || knownProjects.has(item.projectId) ? item.projectId : INBOX_ID
      if (projectId && pid !== projectId) continue
      if (!includeDone && item.done) continue
      out.push({ ...item, projectId: pid, sessionId: r.id, sessionTitle: r.title, sessionStartedAt: r.startedAt, sessionProjectId: r.projectId })
    }
  }
  return out.sort((a, b) => {
    if (a.due !== b.due) {
      if (!a.due) return 1
      if (!b.due) return -1
      return a.due < b.due ? -1 : 1
    }
    return b.sessionStartedAt - a.sessionStartedAt
  })
}

/** 每个项目没完成的待办数。 */
export function openTodoCounts(records, knownProjects) {
  const counts = new Map()
  for (const t of aggregateTodos(records, { knownProjects })) counts.set(t.projectId, (counts.get(t.projectId) ?? 0) + 1)
  return counts
}
