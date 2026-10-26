import { EventEmitter } from 'node:events'
import { answerMessages, parseAnswer, withImage } from './answerPrompt.js'
import { noDashes } from '../prompts.js'
import { t } from '../i18n.js'

// 实时答题：截图和组 prompt 同时做，流式出字；新问题来了就停掉还在生成的旧回答。
// complete 由主进程注入：(opts) => complete(settings, auth, opts)，单测里换成假的。

const HISTORY = 20
const PREFETCH_MS = 8000 // 预先截的图多久以内还能用

function normalize(q) {
  return q.toLowerCase().replace(/[\s\p{P}]+/gu, '')
}

function chineseError(e, timeoutMs) {
  const msg = String(e?.message ?? e ?? '')
  // A 模块的 LlmError 已经是中文提示，原样用
  if (/[一-鿿]/.test(msg)) return msg
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /timed? ?out/i.test(msg)) return `AI 回答超时（${Math.round(timeoutMs / 1000)} 秒没答完），再试一次`
  if (/fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|socket/i.test(msg)) return `连不上 AI 服务，检查一下网络：${msg}`
  return `回答失败：${msg || '未知错误'}`
}

export class Assistant extends EventEmitter {
  constructor({
    complete,
    captureScreen = null,
    screenReady = () => true, // 截屏权限在不在（Mac 没授权时预热不截，免得开会一开始就弹授权框）
    model = 'answer',
    effort = 'none',
    maxOutputTokens = 500,
    timeoutMs = 25_000,
    screenTimeoutMs = 1500,
    screenMaxWidth = 1600,
    dedupeMs = 20_000,
  } = {}) {
    super()
    if (typeof complete !== 'function') throw new Error(t('Assistant 需要 complete'))
    this.complete = complete
    this.captureScreen = captureScreen
    this.screenReady = screenReady
    this.opts = { model, effort, maxOutputTokens, timeoutMs, screenTimeoutMs, screenMaxWidth, dedupeMs }
    this.records = new Map()
    this.current = null
    this.lastAuto = null
    this.seq = 0
  }

  /** 按时间从旧到新的回答列表（给刚打开的答题框补历史）。 */
  list() {
    return [...this.records.values()].map((r) => this.#public(r))
  }

  get(id) {
    const r = this.records.get(id)
    return r ? this.#public(r) : null
  }

  /** 答完以后补上提问和回答的译文（{ question: [句子], body: [句子] }，句子同字幕的 { text, tr, chunks }），广播一次。 */
  setTrans(id, trans) {
    const r = this.records.get(id)
    if (!r?.answer.done) return
    r.answer.trans = trans
    this.#emit(r)
  }

  /**
   * ask({ question, transcript, context, profile, withScreen, answerLang, reason })
   * reason：'auto'（对方问完自动触发）| 'hotkey' | 'click'（主窗口点了提问句）| 'manual' | 'regenerate'。返回最终的 answer 对象。
   */
  async ask(opts = {}) {
    const question = String(opts.question ?? '').trim()
    if (!question) return null
    const reason = opts.reason ?? 'manual'
    if (reason === 'auto') {
      // 同一句话定稿后可能被广播好几次，短时间内只答一次
      const key = normalize(question)
      const last = this.lastAuto
      if (last && last.key === key && Date.now() - last.at < this.opts.dedupeMs && this.records.has(last.id)) return this.#public(this.records.get(last.id))
    }
    const id = `${Date.now().toString(36)}-${++this.seq}`
    if (reason === 'auto') this.lastAuto = { key: normalize(question), at: Date.now(), id }
    return this.#run(id, { ...opts, question, reason })
  }

  /** 重新回答某一条（用同一个 id，界面上原地刷新并挪到最上面）。 */
  async regenerate(id) {
    const r = this.records.get(id)
    if (!r) return null
    return this.#run(id, { ...r.input, reason: 'regenerate' })
  }

  /**
   * 对方好像在提问、还没说完：先把屏幕截下来，问完自动答题时直接用，省掉截图那 0.4 秒。
   * 截图只留在内存里，8 秒内的自动答题用一次就丢；没用上的也就丢了，不会发出去。
   */
  prefetchScreen() {
    if (!this.captureScreen) return
    const now = Date.now()
    if (this.prefetch && now - this.prefetch.at < 3000) return
    this.prefetch = { at: now, promise: this.#shot(new AbortController().signal) }
  }

  // 拿预先截好的图（还在截就等它），等的时间记成这次的截图耗时
  async #prefetched(pre, signal) {
    const t0 = performance.now()
    const aborted = new Promise((resolve) => signal.addEventListener('abort', () => resolve({ error: 'cancelled' }), { once: true }))
    const shot = await Promise.race([pre.promise, aborted])
    return shot.dataUrl ? { ...shot, ms: Math.round(performance.now() - t0), prefetched: true } : shot
  }

  /**
   * 开会时先把答题这条路热起来，第一次答题不用现建连接：给答题模型发一个极小的请求，收到第一个字就断开；
   * screen 为 true 时再截一张 32 像素宽的图，让截屏组件先起来（Windows 上第一次截屏慢）。结果都丢掉，不发给任何人。
   * → { ms, ok, error?, screenMs? }
   */
  async warmUp({ screen = false } = {}) {
    const t0 = performance.now()
    const ctrl = new AbortController()
    let first = null
    const llm = Promise.resolve()
      .then(() =>
        this.complete({
          model: this.opts.model,
          system: 'Reply with the single word OK.',
          messages: [{ role: 'user', content: 'ping' }],
          effort: this.opts.effort,
          maxOutputTokens: 5,
          timeoutMs: 15_000,
          signal: ctrl.signal,
          warm: true,
          onDelta: (full) => {
            if (first != null || !full) return
            first = Math.round(performance.now() - t0)
            ctrl.abort(new Error('warm'))
          },
        }),
      )
      .then(
        () => ({ ms: first ?? Math.round(performance.now() - t0), ok: true }),
        (e) => (first != null ? { ms: first, ok: true } : { ms: Math.round(performance.now() - t0), ok: false, error: String(e?.message ?? e) }),
      )
    const shot =
      screen && this.captureScreen && this.screenReady() !== false
        ? Promise.resolve()
            .then(() => this.captureScreen({ maxWidth: 32 }))
            .then(
              () => Math.round(performance.now() - t0),
              () => null,
            )
        : null
    const [r, screenMs] = await Promise.all([llm, shot])
    return screenMs != null ? { ...r, screenMs } : r
  }

  /** 停掉正在生成的回答。 */
  cancel() {
    const r = this.current
    if (!r || r.answer.done) return
    r.cancelled = true
    r.ctrl.abort(new Error('cancelled'))
    this.#finish(r)
  }

  // 模型写的回答每句前面带【标签】：标签单独放 hints，text 里不留标记（流式写到一半的标签也不露出来）
  #setText(r, raw) {
    const p = parseAnswer(raw)
    r.answer.text = p.text
    if (p.hints.length) r.answer.hints = p.hints
    else delete r.answer.hints
  }

  #public(r) {
    return { ...r.answer, timing: { ...r.answer.timing } }
  }

  #emit(r) {
    this.emit('answer', this.#public(r))
  }

  #finish(r) {
    if (r.finished) return
    r.finished = true
    r.answer.done = true
    r.answer.cancelled = Boolean(r.cancelled)
    r.answer.timing.total = Math.round(performance.now() - r.t0)
    clearTimeout(r.timer)
    if (this.current === r) this.current = null
    this.#emit(r)
  }

  async #shot(signal) {
    if (!this.captureScreen) return { error: t('没有接入截屏，这次没带截图') }
    const t0 = performance.now()
    let timer
    try {
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ error: t('截图太慢，这次没带截图'), ms: Math.round(performance.now() - t0) }), this.opts.screenTimeoutMs)
      })
      const shot = Promise.resolve()
        .then(() => this.captureScreen({ maxWidth: this.opts.screenMaxWidth }))
        .then(
        (r) => ({ dataUrl: r.dataUrl, ms: r.ms ?? Math.round(performance.now() - t0) }),
        (e) => ({ error: e.code === 'no-permission' ? e.message : t(`截图失败，这次没带截图：{0}`, e.message), code: e.code, ms: Math.round(performance.now() - t0) }),
      )
      const aborted = new Promise((resolve) => signal.addEventListener('abort', () => resolve({ error: 'cancelled' }), { once: true }))
      return await Promise.race([shot, timeout, aborted])
    } finally {
      clearTimeout(timer)
    }
  }

  async #run(id, input) {
    const prev = this.current
    if (prev && !prev.answer.done) {
      prev.cancelled = true
      prev.ctrl.abort(new Error('cancelled'))
      this.#finish(prev)
    }

    const withScreen = Boolean(input.withScreen)
    const r = {
      id,
      input,
      ctrl: new AbortController(),
      t0: performance.now(),
      cancelled: false,
      timedOut: false,
      finished: false,
      answer: {
        id,
        question: input.question,
        text: '',
        done: false,
        error: null,
        warning: null,
        cancelled: false,
        reason: input.reason,
        segIds: input.segIds ?? null, // 答的是哪几段字幕（主窗口点提问句时按它找回答）
        withScreen,
        startedAt: Date.now(),
        // 都从开始答题算起的毫秒数：screen 截图用了多久，sent 请求发出去的时刻，firstToken 第一个字，total 答完。
        // 界面拆成「截图 · 等首字（firstToken 减 sent）· 生成（total 减 firstToken）」
        timing: { screen: null, sent: null, firstToken: null, total: null },
      },
    }
    this.records.delete(id)
    this.records.set(id, r)
    while (this.records.size > HISTORY) this.records.delete(this.records.keys().next().value)
    this.current = r
    const { signal } = r.ctrl
    r.timer = setTimeout(() => {
      r.timedOut = true
      r.ctrl.abort(new Error('timeout'))
    }, this.opts.timeoutMs)
    this.#emit(r)

    const elapsed = () => Math.round(performance.now() - r.t0)
    try {
      // 截图和组 prompt 并行：先把截图发出去，再组文字。自动答题优先用对方还在问的时候预先截好的
      const pre = withScreen && input.reason === 'auto' && this.prefetch && Date.now() - this.prefetch.at < PREFETCH_MS ? this.prefetch : null
      if (withScreen) this.prefetch = null
      const shotPromise = withScreen ? (pre ? this.#prefetched(pre, signal) : this.#shot(signal)) : null
      const prompt = answerMessages({ ...input, withScreen })
      let messages = prompt.messages
      if (shotPromise) {
        const shot = await shotPromise
        if (r.cancelled) return this.#public(r)
        if (shot.dataUrl) {
          r.answer.timing.screen = shot.ms ?? null
          if (shot.prefetched) r.answer.timing.screenPrefetched = true
          messages = withImage(messages, shot.dataUrl)
        } else if (shot.error && shot.error !== 'cancelled') r.answer.warning = shot.error
      }
      if (signal.aborted) throw signal.reason
      r.answer.timing.sent = elapsed()
      if (withScreen) this.#emit(r) // 截图好了：界面从「截图中」换成「等首字」
      const text = await this.complete({
        model: this.opts.model,
        system: prompt.system,
        messages,
        effort: this.opts.effort,
        maxOutputTokens: this.opts.maxOutputTokens,
        timeoutMs: this.opts.timeoutMs,
        signal,
        onDelta: (full) => {
          if (signal.aborted || r.finished) return
          if (r.answer.timing.firstToken == null && full) r.answer.timing.firstToken = elapsed()
          this.#setText(r, noDashes(full))
          this.#emit(r)
        },
      })
      if (r.cancelled) return this.#public(r)
      if (typeof text === 'string' && text.trim()) this.#setText(r, noDashes(text).trim())
      if (r.answer.timing.firstToken == null && r.answer.text) r.answer.timing.firstToken = elapsed()
      if (!r.answer.text.trim()) r.answer.error = 'AI 没有给出回答，点「重新回答」再试一次'
    } catch (e) {
      if (r.cancelled) return this.#public(r)
      r.answer.error = r.timedOut ? chineseError({ name: 'TimeoutError' }, this.opts.timeoutMs) : chineseError(e, this.opts.timeoutMs)
    }
    this.#finish(r)
    return this.#public(r)
  }
}
