import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { clock } from '../prompts.js'
import { keywordList } from '../defaults.js'
import { materialPages } from './materials.js'
import { askMessages, coverOf, notesForAsk, pagesForAsk, parseAsk, slidesForAsk, transcriptForAsk, withAsked } from './askPrompt.js'
import { t, uiLang } from '../i18n.js'

// 课上问 AI：一问一答，流式出字，问答存进这节课的 session.asks（课上和下课后都能问、都能看）。
// 课还在上：用正在记录的那场的字幕、笔记，AI 走这场的会员票（和翻译、答题一样，不另外开场次）。
// 下课以后：用存下来的整节课加课件，AI 走和课堂笔记一样的凭据（24 小时内算在这一场上，之后是每天的会后整理额度；自带 Key 不受影响）。
// source(sessionId) → { session, segments } | null：这节课正在记录时由引擎给；llm 和 aiStatus 是主进程里同一份（会员通道在里面）。

const MAX_Q = 600
const HISTORY_KEEP = 200

/** 提问和回答的 id */
let seq = 0
const newId = () => `a${Date.now().toString(36)}${(++seq).toString(36)}`

function chineseError(e) {
  const msg = String(e?.message ?? e ?? '')
  if (/[一-鿿]/.test(msg)) return msg
  if (e?.name === 'TimeoutError' || /timed? ?out/i.test(msg)) return t('AI 回答超时，再试一次')
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(msg)) return t(`连不上 AI 服务，检查一下网络：{0}`, msg)
  return t(`回答失败：{0}`, msg || t('未知错误'))
}

const hhmm = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 一问一答的记录里存下来的字段 */
const STORED = ['id', 'q', 'quote', 'askedAt', 'after', 'status', 'cover', 'gist', 'points', 'src', 'next', 'error', 'usage']
const pick = (r) => Object.fromEntries(STORED.filter((k) => r[k] != null).map((k) => [k, r[k]]))

export class ClassAsk extends EventEmitter {
  constructor({ store, llm, aiStatus, source = () => null, projectOf = () => null, loadImage = (f) => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}`, onSaved = () => {} }) {
    super()
    this.store = store
    this.llm = llm
    this.aiStatus = aiStatus // (at) → { ready, reason }，at 是下课后那场的开始时间，课上不给
    this.source = source
    this.projectOf = projectOf
    this.loadImage = loadImage
    this.onSaved = onSaved
    this.jobs = new Map() // 会议 id → { id, ctrl }
  }

  /** 这节课现在能不能问：→ { ready, reason, provider }。 */
  status(sessionId) {
    const live = this.source(sessionId)
    const session = live?.session ?? this.store.load(sessionId)
    return this.aiStatus(live ? null : session.startedAt)
  }

  /** 停掉这节课正在回答的那一问。 */
  stop(sessionId) {
    this.jobs.get(sessionId)?.ctrl.abort(new Error('stopped'))
  }

  /**
   * 问一个问题。quote：{ segId, sel? } 引用的那句字幕（sel 是在那句里选中的几个词）；replaceId：重试时换掉出错的那一条。
   * → { ok: true, id } | { ok: false, error }，答案通过 'update' 事件一点点来（status: streaming | done | stopped | error）。
   */
  async ask({ sessionId, question, quote = null, replaceId = null }) {
    const q = String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q)
    if (!q) return { ok: false, error: t('问题是空的') }
    if (this.jobs.has(sessionId)) return { ok: false, error: t('上一个问题还在回答，等它答完或者先停止') }
    const live = this.source(sessionId)
    const session = live?.session ?? this.store.load(sessionId)
    if (session.mode !== 'class') return { ok: false, error: t('只有课堂记录能问 AI') }
    const at = live ? null : session.startedAt
    const st = this.aiStatus(at)
    if (!st.ready) return { ok: false, error: st.reason, code: 'no-ai' }

    const segments = (live?.segments ?? session.segments).filter((s) => s?.text).sort((a, b) => a.startedAt - b.startedAt)
    const dir = this.store.dir(sessionId)
    const base = session.startedAt
    const clockTime = live ? hhmm : (ms) => clock(ms - base)
    const seg = quote?.segId != null ? segments.find((s) => s.id === quote.segId) : null
    const quoted = seg ? { segId: seg.id, at: seg.startedAt, text: seg.text, ...(quote.sel && String(quote.sel).trim() !== seg.text.trim() ? { sel: String(quote.sel).trim().slice(0, 300) } : {}) } : null
    const notes = session.liveNotes ?? null
    const terms = [
      ...(notes?.terms ?? []),
      ...segments.flatMap((s) => (s.sentences ?? []).flatMap((x) => x.terms ?? [])),
    ].filter((x) => x?.term)
    const query = [q, quoted?.text, quoted?.sel].filter(Boolean).join(' ')
    const transcript = transcriptForAsk(segments, { query, terms, quoteId: quoted?.segId ?? null, clockTime })
    const pageList = materialPages(session, dir)
    const pages = pagesForAsk(pageList, { query, terms, multi: new Set(pageList.map((p) => p.mat)).size > 1 })
    const slides = slidesForAsk(session.slides, { quoteAt: seg?.startedAt ?? null, clockTime })
    const project = this.projectOf(session)
    const history = (session.asks ?? []).filter((r) => r.id !== replaceId && (r.gist || r.points?.length))
    const quoteLine = quoted ? { no: [...transcript.refs].find(([, id]) => id === quoted.segId)?.[0] ?? null } : null
    const prompt = askMessages({
      session,
      live: Boolean(live) || !session.endedAt,
      lang: uiLang(),
      context: project?.context ?? '',
      keywords: [...new Set([...keywordList({ keywords: project?.keywords ?? '' }), ...terms.map((x) => x.term)])],
      transcript,
      notes: notesForAsk(notes),
      pages,
      slides,
      question: q,
      quote: quoted,
      quoteLine,
      history,
    })
    const images = []
    for (const x of slides.attach) {
      try {
        images.push(this.loadImage(path.join(dir, x.file)))
      } catch {}
    }
    if (images.length) {
      const last = prompt.messages.length - 1
      prompt.messages[last] = { ...prompt.messages[last], content: [{ type: 'text', text: prompt.messages[last].content }, ...images.map((dataUrl) => ({ type: 'image', dataUrl })) ] }
    }

    const id = newId()
    const ctrl = new AbortController()
    this.jobs.set(sessionId, { id, ctrl })
    const rec = { id, q, askedAt: Date.now(), after: !live && Boolean(session.endedAt), ...(quoted ? { quote: quoted } : {}) }
    const emit = (extra) => this.emit('update', { sessionId, ...rec, ...extra })
    emit({ status: 'streaming', gist: '', points: [] })
    this.#run({ sessionId, session, live, at, rec, prompt, ctrl, emit, replaceId, usedImages: images.length, prompted: { transcript: transcript.shown, of: transcript.total } })
    return { ok: true, id }
  }

  async #run({ sessionId, session, live, at, rec, prompt, ctrl, emit, replaceId, usedImages, prompted }) {
    let raw = ''
    let usage = null
    let last = 0
    let error = null
    const t0 = Date.now()
    try {
      raw = await this.llm({
        model: 'answer',
        effort: 'none',
        maxOutputTokens: 1100,
        timeoutMs: 60_000,
        signal: ctrl.signal,
        system: prompt.system,
        messages: prompt.messages,
        ...(at != null ? { sessionStartedAt: at } : {}),
        onUsage: (u) => (usage = u),
        onDelta: (full) => {
          raw = full
          const now = Date.now()
          if (now - last < 70) return
          last = now
          const p = parseAsk(full, prompt.refs)
          emit({ status: 'streaming', gist: p.gist, points: p.points, cover: coverOf(p.cover, prompt.refs) })
        },
      })
    } catch (e) {
      if (!ctrl.signal.aborted || ctrl.signal.reason?.message !== 'stopped') error = chineseError(e)
      if (e?.partial && String(e.partial).trim()) raw = e.partial
    }
    this.jobs.delete(sessionId)
    const stopped = ctrl.signal.aborted && ctrl.signal.reason?.message === 'stopped'
    const p = parseAsk(raw, prompt.refs, { final: true })
    const has = Boolean(p.gist || p.points.length)
    if (!error && !stopped && !has) error = t('AI 没有给出回答，再试一次')
    const status = stopped ? 'stopped' : error ? 'error' : 'done'
    const out = {
      ...rec,
      status,
      cover: coverOf(p.cover, prompt.refs),
      gist: p.gist,
      points: p.points,
      src: status === 'error' ? [] : p.src,
      next: status === 'done' ? p.next : [],
      ...(error ? { error } : {}),
      ...(usage ? { usage: { input: usage.prompt_tokens ?? usage.input_tokens ?? null, output: usage.completion_tokens ?? usage.output_tokens ?? null } } : {}),
    }
    if (has) {
      try {
        this.#save(sessionId, out, replaceId)
      } catch (e) {
        out.error = t(`没能存进这节课：{0}`, e.message)
      }
    } else if (replaceId) {
      try {
        this.#save(sessionId, null, replaceId)
      } catch {}
    }
    this.emit('update', { sessionId, ...out, ms: Date.now() - t0, images: usedImages, prompted })
  }

  // 存进这节课的 asks；课堂笔记已经生成的话，末尾「课上问过的」跟着换成新的
  #save(sessionId, rec, replaceId) {
    this.store.mutate(sessionId, (s) => {
      const list = (s.asks ?? []).filter((r) => r.id !== replaceId && r.id !== rec?.id)
      if (rec) list.push(pick(rec))
      list.sort((a, b) => a.askedAt - b.askedAt)
      s.asks = list.slice(-HISTORY_KEEP)
      if (s.summary?.markdown) s.summary.markdown = withAsked(s.summary.markdown, s.asks, s.startedAt)
    })
    this.onSaved(sessionId)
  }
}
