import { EventEmitter } from 'node:events'
import { clock, cleanText, extractJson } from '../prompts.js'
import { normalizeDate, parseAt, resolveRelativeDate, ruleDate } from '../todos.js'
import { overlap, tokenize } from '../speaker.js'
import { notesMessages } from './prompts.js'
import '../../renderer/shared/texfix.js'
import { t } from '../i18n.js'

const { repair } = globalThis.texfix

// 实时笔记（三种模式都有，内容按模式不同）：定稿的字幕攒起来，每累计约 N 分钟新内容（或 400 个英文词、600 个汉字）把上一版笔记的摘要和新片段一起交给 smart 模型，
// 模型只写这一批带来的变化（补到哪个小节、新开的小节、改哪一条、新的强调点 / 作业 / 术语），applyNotes 合进上一版，得到完整的新版笔记。
// 同一时间只有一个请求；失败或额度不够时保留上一版，隔一会儿带着这批内容再试。
// 事件 'update'：{ notes, updatedAt, error }（失败时 notes 是上一版，error 是一句中文原因）。

const LIMITS = { sections: 80, points: 30, formulas: 15, examples: 12, emphasis: 80, homework: 20, terms: 80, edits: 30 }
const DASH = /[\u2013\u2014]+/g

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
// 文字里的 LaTeX（$\lambda$）可能被 JSON 转义弄坏，先修再清洗（见 renderer/shared/texfix.js）
const text = (v, max = 300) => cleanText(typeof v === 'string' ? repair(v) : typeof v === 'number' ? String(v) : '').slice(0, max)
const mmss = (v) => {
  const ms = parseAt(v)
  return ms == null ? null : clock(ms)
}
const seconds = (v) => parseAt(v) ?? Infinity

// LaTeX 不能按普通文字清洗（逗号会坏公式）：先修被 JSON 转义吃掉的反斜杠（\text 的 \t 成了制表符这种），
// 再去掉包着的 $ 和破折号
function latex(v) {
  const s = typeof v === 'string' ? v : isObject(v) ? v.latex ?? v.formula ?? v.text ?? '' : ''
  return repair(s, { formula: true })
    .trim()
    .replace(/^\${1,2}\s*|\s*\${1,2}$/g, '')
    .replace(DASH, '-')
    .trim()
    .slice(0, 400)
}

function list(v, max, map) {
  const arr = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
  const out = []
  for (const x of arr) {
    const y = map(x)
    if (y) out.push(y)
    if (out.length >= max) break
  }
  return out
}

const strings = (v, max, fn = (x) => text(isObject(x) ? x.text ?? x.point ?? x.example ?? '' : x)) => list(v, max, (x) => fn(x) || null)

/** 字数：英文按词，中文按字。 */
export function countWords(s) {
  let words = 0
  let han = 0
  for (const w of tokenize(s)) {
    if (/\p{Script=Han}/u.test(w)) han++
    else words++
  }
  return { words, han }
}

// JSON 不认的转义（没开 JSON 模式时模型写的 \lambda、\sigma、\underline）：落单的反斜杠补成两个，合法的转义不动
export function fixEscapes(s) {
  return String(s ?? '').replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])|\\/g, (all, ok) => (ok ? all : '\\\\'))
}

/**
 * 一段字幕拆成按句子的几行，每句的时间按字数比例在这段的起点和时长之间估出来（门限一段常有四五十秒，只用起点的话小节和强调点都对不上）。
 * 没有句子或时长就还是一行。
 */
export function splitByTime(seg, now = Date.now()) {
  const base = seg.startedAt ?? now
  const speaker = seg.speaker ?? '老师'
  const id = seg.id ?? null
  const dur = Math.max(0, Number(seg.durationMs) || 0)
  const sents = (seg.sentences ?? []).map((x) => x?.text).filter(Boolean)
  if (sents.length < 2 || !dur) return [{ id, at: base, speaker, text: seg.text, durationMs: dur }]
  const total = sents.reduce((a, t) => a + t.length, 0) || 1
  let acc = 0
  return sents.map((text) => {
    const at = base + Math.round((dur * acc) / total)
    acc += text.length
    return { id, at, speaker, text, durationMs: dur }
  })
}

const index = (v) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return Number.isInteger(n) && n >= 1 ? n : null
}
const EDIT_FIELDS = ['title', 'points', 'formulas', 'examples']

/**
 * 模型回复 → 这一批的变化 { sections, edits, emphasis, homework, terms }（给 applyNotes 合并）：
 * sections 里带 n 的是补充已有的第 n 小节，不带的是新小节；edits 改已有小节里的某一条；homework 带 n 的是改已有的第 n 条作业；
 * emphasis、terms 只含新出现的。容错：代码块包裹、字段换说法、字符串代替对象、时间格式不对、
 * JSON 里 LaTeX 的反斜杠只写了一个（非法转义补上再解析，被当成 \t \r \f \b \n 吃掉的在各字段里还原）。
 * 五类一个都没有返回 null（当作这次失败）；全是空数组是合法的，表示这批没有新东西。startedAt 用来换算作业的相对日期。
 */
export function parseNotes(raw, { startedAt = Date.now() } = {}) {
  const fields = (v) => {
    if (!v) return null
    const f = [v.sections ?? v.outline ?? v.topics, v.emphasis ?? v.highlights ?? v.keyPoints, v.homework ?? v.assignments ?? v.todos, v.terms ?? v.glossary, v.edits ?? v.fixes]
    return f.some((x) => Array.isArray(x) || isObject(x)) ? f : null
  }
  // 整个对象因为非法转义解析不了时，extractJson 可能退而取到里面的某个小对象，所以取不到笔记字段就补转义再试一次
  const got = fields(extractJson(raw)) ?? fields(extractJson(fixEscapes(raw)))
  if (!got) return null
  const [secs, emph, hw, terms, edits] = got
  return {
    sections: list(secs, LIMITS.sections, (x) => {
      if (typeof x === 'string') return text(x, 80) ? { n: null, title: text(x, 80), start: null, points: [], formulas: [], examples: [] } : null
      if (!isObject(x)) return null
      const d = {
        n: index(x.n ?? x.section),
        title: text(x.title ?? x.name ?? x.heading, 80),
        start: mmss(x.start ?? x.at ?? x.time),
        points: strings(x.points ?? x.bullets ?? x.notes, LIMITS.points),
        formulas: list(x.formulas ?? x.equations, LIMITS.formulas, (f) => latex(f) || null),
        examples: strings(x.examples, LIMITS.examples),
      }
      return d.n || d.title || d.points.length || d.formulas.length || d.examples.length ? d : null
    }),
    edits: list(edits, LIMITS.edits, (x) => {
      const field = String(x?.field ?? '').toLowerCase()
      if (!isObject(x) || !EDIT_FIELDS.includes(field)) return null
      const t = field === 'formulas' ? latex(x.text) : text(x.text, field === 'title' ? 80 : 300)
      const section = index(x.section ?? x.n)
      return t && section ? { section, field, i: index(x.i ?? x.index), text: t } : null
    }),
    emphasis: list(emph, LIMITS.emphasis, (x) => {
      const o = isObject(x) ? x : { text: x }
      const t = text(o.text ?? o.point)
      return t ? { text: t, at: mmss(o.at ?? o.time), quote: text(o.quote, 200) || null } : null
    }),
    homework: list(hw, LIMITS.homework, (x) => {
      const o = isObject(x) ? x : { text: x }
      const t = text(o.text ?? o.task ?? o.title)
      if (!t) return null
      const dueText = text(o.dueText ?? o.due_text, 80) || null
      const due = ruleDate(dueText, startedAt) ?? normalizeDate(o.due ?? o.deadline) ?? (dueText ? resolveRelativeDate(dueText, startedAt) : null)
      return { n: index(o.n), text: t, due, dueText }
    }),
    terms: list(isObject(terms) ? Object.entries(terms).map(([term, explain]) => ({ term, explain })) : terms, LIMITS.terms, (x) => {
      if (!isObject(x)) return null
      // 术语是纯文字（标签、悬停提示、字幕里的高亮都不画公式）：模型顺手写的 $L_2$ 去掉 $
      const plain = (v, max) => text(v, max).replace(/\$\$?([^$]+?)\$\$?/g, '$1')
      const term = plain(x.term ?? x.en, 60)
      return term ? { term, zh: plain(x.zh ?? x.cn, 60), explain: plain(x.explain ?? x.explanation, 80) } : null
    }),
  }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

// 两句话说的是不是同一件事：规整后相同，或者词基本都互相覆盖
function same(a, b) {
  if (norm(a) === norm(b)) return true
  if (tokenize(a).length < 3 || tokenize(b).length < 3) return false
  return overlap(a, [b]).uni >= 0.8 && overlap(b, [a]).uni >= 0.8
}

const byTime = (key) => (a, b) => seconds(a[key]) - seconds(b[key])

const EMPTY = { sections: [], emphasis: [], homework: [], terms: [] }
// 作业改写后措辞会变：用 n 指到的那一条只要和旧的有一半词重合就当作同一条
const similar = (a, b) => overlap(a, [b]).uni >= 0.5 || overlap(b, [a]).uni >= 0.5

function addUnique(target, items, max, eq) {
  for (const x of items) {
    if (target.length >= max) break
    if (!target.some((y) => eq(y, x))) target.push(x)
  }
}

/**
 * 把这一批的变化（parseNotes 的结果）合进上一版，得到完整的新版笔记。上一版的内容只会被 edits 明确改掉，模型漏写、写错序号都不会丢：
 * - sections 带 n 的追加到上一版的第 n 小节（和已有的重复就跳过）；没带 n 的是新小节，标题和某个已有小节相同就并进去；
 *   既没有标题也没有有效序号的追加到最后一个小节。新小节没写 start 就用这批第一句的时间（fallbackStart）。
 * - edits 改某个小节的标题或其中第 i 条，i 对不上的当作追加。
 * - emphasis、terms 只补新的；homework 同一条（带 n 的算同一条，只要措辞还像）更新截止时间，其余补新的。
 * prev 是 null（第一批）从空笔记开始。
 */
export function applyNotes(prev, delta, { fallbackStart = null } = {}) {
  if (!delta) return prev
  const base = prev ?? EMPTY
  const sections = base.sections.map((s) => ({ ...s, points: [...s.points], formulas: [...s.formulas], examples: [...s.examples] }))
  const known = sections.length // 序号是对着上一版的顺序给的，新加的不参与
  const at = (n) => (n >= 1 && n <= known ? sections[n - 1] : null)

  const incoming = [...delta.sections]
  for (const e of delta.edits ?? []) {
    const s = at(e.section)
    if (!s) continue
    if (e.field === 'title') s.title = e.text
    else if (e.i >= 1 && e.i <= s[e.field].length) s[e.field][e.i - 1] = e.text
    else incoming.push({ n: e.section, title: '', points: [], formulas: [], examples: [], [e.field]: [e.text] }) // 第几条对不上：当作补充
  }

  const fresh = []
  for (const d of incoming) {
    let target = at(d.n)
    if (!target && d.title) target = [...sections, ...fresh].find((s) => norm(s.title) === norm(d.title)) ?? null
    if (!target && !d.title && sections.length) target = fresh.at(-1) ?? sections.at(-1)
    if (!target) {
      target = { title: d.title || t('要点'), start: d.start ?? fallbackStart, points: [], formulas: [], examples: [] }
      fresh.push(target)
    }
    addUnique(target.points, d.points, LIMITS.points, same)
    addUnique(target.formulas, d.formulas, LIMITS.formulas, (a, b) => norm(a) === norm(b))
    addUnique(target.examples, d.examples, LIMITS.examples, same)
  }

  const emphasis = [...base.emphasis]
  addUnique(emphasis, delta.emphasis, Infinity, (a, b) => same(a.text, b.text))
  const homework = [...base.homework]
  for (const h of delta.homework) {
    let i = homework.findIndex((x) => same(x.text, h.text))
    if (i < 0 && h.n >= 1 && h.n <= base.homework.length && similar(homework[h.n - 1].text, h.text)) i = h.n - 1
    if (i < 0) {
      homework.push({ text: h.text, due: h.due, dueText: h.dueText })
      continue
    }
    const p = homework[i]
    homework[i] = { text: h.text, due: h.due ?? p.due, dueText: h.dueText ?? p.dueText }
  }
  const terms = [...base.terms]
  addUnique(terms, delta.terms, Infinity, (a, b) => a.term.toLowerCase() === b.term.toLowerCase())

  return {
    sections: [...sections, ...fresh].sort(byTime('start')).slice(0, LIMITS.sections),
    emphasis: emphasis.sort(byTime('at')).slice(0, LIMITS.emphasis),
    homework: homework.slice(0, LIMITS.homework),
    terms: terms.slice(0, LIMITS.terms),
  }
}

function reason(e) {
  const msg = String(e?.message ?? e ?? '')
  return /[一-鿿]/.test(msg) ? msg : `AI 请求失败：${msg || '未知错误'}`
}

export class LiveNotes extends EventEmitter {
  /**
   * llm(opts) → Promise<string>（complete 门面）；llmStatus() → { ready, reason }；startedAt：开始时间；
   * everyMs() → 攒多久更新一次（设置里的 class.notesEveryMin，开会中改了马上生效）；context：课程或会议背景；
   * mode：class | meeting | interview；prev：接着之前的笔记（没有就 null）。
   */
  constructor({ llm, llmStatus = null, startedAt = Date.now(), everyMs = () => 120_000, context = '', mode = 'class', lang = 'zh', prev = null, now = () => Date.now(), wordsCap = 400, hanCap = 600, minWords = 15, retryMs = 60_000, timeoutMs = 180_000 }) {
    super()
    this.llm = llm
    this.llmStatus = llmStatus
    this.startedAt = startedAt
    this.everyMs = everyMs
    this.context = context
    this.mode = mode
    this.lang = lang
    this.now = now
    this.opts = { wordsCap, hanCap, minWords, retryMs, timeoutMs }
    this.notes = prev
    this.updatedAt = null
    this.pending = [] // [{ id（段落 id）, at（绝对时间）, speaker, text }]
    this.running = null
    this.retryAt = 0
    this.warned = false
    this.closed = false
  }

  /** 一段定稿的字幕：{ id, startedAt, speaker, text }。 */
  add(seg) {
    if (this.closed || !seg?.text) return
    this.pending.push(...splitByTime(seg, this.now()))
    this.tick()
  }

  /** 这段的文字后来被 AI 纠正了：还没交给模型的话换成纠正后的（已经发出去的就算了）。 */
  revise(seg) {
    if (seg?.id == null || !seg.text) return
    const i = this.pending.findIndex((x) => x.id === seg.id)
    if (i < 0) return
    const old = this.pending.filter((x) => x.id === seg.id)
    const lines = splitByTime({ ...seg, durationMs: seg.durationMs ?? old[0].durationMs, startedAt: seg.startedAt ?? old[0].at }, this.now())
    this.pending = [...this.pending.slice(0, i).filter((x) => x.id !== seg.id), ...lines, ...this.pending.slice(i).filter((x) => x.id !== seg.id)]
  }

  #counts() {
    let words = 0
    let han = 0
    for (const p of this.pending) {
      const c = countWords(p.text)
      words += c.words
      han += c.han
    }
    return { words, han }
  }

  /** 攒够了没有。final：下课时收尾，剩下的只要不是一两句就更新。 */
  due({ final = false } = {}) {
    if (!this.pending.length) return false
    const { words, han } = this.#counts()
    const { wordsCap, hanCap, minWords } = this.opts
    if (final) return words >= 8 || han >= 12
    if (this.now() < this.retryAt) return false
    if (words >= wordsCap || han >= hanCap) return true
    const enough = words >= minWords || han >= minWords * 2
    return enough && this.now() - this.pending[0].at >= this.everyMs()
  }

  /** 定时调用（引擎每 5 秒一次）：到时间了就发一次请求。返回这次请求的 Promise（没发返回 null）。 */
  tick({ final = false } = {}) {
    if (this.running || !this.due({ final })) return null
    const st = this.llmStatus?.()
    if (st && !st.ready) {
      if (!this.warned) {
        this.warned = true
        this.emit('update', { notes: this.notes, updatedAt: this.updatedAt, error: t(`实时笔记暂停了：{0}`, st.reason) })
      }
      this.retryAt = this.now() + this.opts.retryMs
      return null
    }
    const batch = this.pending
    this.pending = []
    this.running = this.#run(batch).finally(() => {
      this.running = null
      if (!this.closed) this.tick()
    })
    return this.running
  }

  /** 下课：等在跑的请求，剩下的内容再更新一次。 */
  async flush() {
    this.closed = true
    await this.running
    this.retryAt = 0
    if (this.due({ final: true })) {
      const batch = this.pending
      this.pending = []
      await this.#run(batch)
    }
  }

  async #run(batch) {
    const lines = batch.map((p) => ({ at: Math.max(0, p.at - this.startedAt), speaker: p.speaker, text: p.text }))
    const [system, user] = notesMessages({ prev: this.notes, lines, context: this.context, startedAt: this.startedAt, mode: this.mode, lang: this.lang })
    const t0 = this.now()
    try {
      const raw = await this.llm({ model: 'smart', effort: 'low', json: true, timeoutMs: this.opts.timeoutMs, system: system.content, messages: [user] })
      const parsed = parseNotes(raw, { startedAt: this.startedAt })
      if (!parsed) throw new Error(t('AI 返回的笔记格式不对'))
      this.notes = applyNotes(this.notes, parsed, { fallbackStart: lines.length ? clock(lines[0].at) : null })
      this.updatedAt = this.now()
      this.retryAt = 0
      this.warned = false
      this.emit('update', { notes: this.notes, updatedAt: this.updatedAt, error: null, ms: this.updatedAt - t0, lines: lines.length })
    } catch (e) {
      // 这批内容放回去，下次和新内容一起再整理
      this.pending = [...batch, ...this.pending]
      this.retryAt = this.now() + this.opts.retryMs
      this.emit('update', { notes: this.notes, updatedAt: this.updatedAt, error: t(`实时笔记这次没更新：{0}`, reason(e)), ms: this.now() - t0 })
    }
  }
}
