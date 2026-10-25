import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { t } from '../i18n.js'

// Soniox 实时识别（stt-rt-v5）：wss://stt-rt.soniox.com/transcribe-websocket，60 种语言，按连接时长计费。
// 音频一直送（含静音，和豆包一样），Soniox 自己断句：<end> 之前的字是一句。每条回复里 is_final 的字是新定稿的，
// 不是 final 的是这一刻还没定的尾巴（每次整段替换）。字的 start_ms / end_ms 相对这条连接收到的第一个样本。
//
// Key 两种来法：自带 Key（key）；会员（getKey）每条连接向我们的服务器换一把临时 Key：只能用一次，
// 连上以后最长连 maxMs，到点 Soniox 断开（403）。快到点时在下一个句末换一条新连接，旧的收尾关掉。
// getKey 抛出带 code 的错（exhausted / idle / ended）时不再重连，发 'member' 交给上层换本地识别或暂停；
// 服务器说连接太多、太频繁（too-many / too-fast）照常退避重连，等前面的 Key 过期腾出来。
//
// 断线不丢字：留最近 60 秒送出的音频；新连接从最后一个定稿的字的终点补发。这一句里已经定稿的字当这一句的定稿发出去，
// 没定稿的尾巴新连接重新认；一个字都没定稿的这一句作废（'drop'）。

const RATE = 16000
const KEEP_SAMPLES = RATE * 60
const ROTATE_BEFORE_MS = 90_000 // 离 Key 到点不到这么久，就在下一个句末换连接
const FORCE_BEFORE_MS = 20_000 // 到这时还没等到句末（一直有人在说）：让 Soniox 把手上的字都定稿（finalize），定完就换
const DEAD_AFTER_MS = 20_000 // 送着音频、这么久一条回复都没有，当连接死了
// 会员服务器不再给 Key 的几种情况（错误码 → 交给上层的类型）
const MEMBER_STOPS = { exhausted: 'exhausted', idle: 'idle', ended: 'ended', 'bad-session': 'ended' }

class FatalError extends Error {}

/** 项目语言 → Soniox 的 language_hints。中英混说给两个；其他语言给一个（不设 strict，夹的英文照样认）。 */
export function sonioxHints(language) {
  if (!language || language === 'auto' || language === 'zh') return ['zh', 'en']
  return [language === 'zh-Hant' ? 'zh' : language]
}

function describe(code, message) {
  if (code === 401) return `Soniox 的 Key 无效（401）：${message}`
  if (code === 402) return `Soniox 账户余额不足（402）：${message}`
  if (code === 400) return `Soniox 拒绝了识别参数（400）：${message}`
  return `Soniox 出错（${code}）：${message}`
}

export class SonioxStreamASR extends EventEmitter {
  sampleRate = RATE
  gated = false

  /**
   * key：自带的 Soniox Key；getKey：async () => { key, maxMs, model? }（会员）。两个给一个。
   * language：项目「对方说的语言」；context：项目背景（≤ 2000 字）；hotwords：术语。
   */
  constructor({ key = '', getKey = null, language = 'auto', context = '', hotwords = [], model = 'stt-rt-v5', url = 'wss://stt-rt.soniox.com/transcribe-websocket', timing = {} }) {
    super()
    this.opts = { key, getKey, language, context, hotwords, model, url }
    this.tm = { rotateBeforeMs: ROTATE_BEFORE_MS, forceBeforeMs: FORCE_BEFORE_MS, deadAfterMs: DEAD_AFTER_MS, ...timing }
    this.conn = null
    this.closing = false
    this.history = [] // [{ at: 这一路的样本序号, buf }]，最近 60 秒
    this.sent = 0 // 这一路一共送了多少样本
    this.finalEnd = 0 // 上一句定稿在这一路音频里的终点（样本序号）
    this.retries = 0
    this.retryTimer = null
    this.seq = 0
  }

  connect() {
    return this.#open(0).ready
  }

  sendAudio(buf) {
    this.history.push({ at: this.sent, buf })
    this.sent += buf.length / 2
    while (this.history.length > 1 && this.sent - this.history[1].at > KEEP_SAMPLES) this.history.shift()
    const c = this.conn
    if (c?.open && c.ws.readyState === WebSocket.OPEN) c.ws.send(buf)
  }

  async close() {
    this.closing = true
    clearTimeout(this.retryTimer)
    const c = this.conn
    this.conn = null
    if (!c) return
    await this.#retire(c, 3000)
  }

  // ---------- 连接 ----------

  // from：新连接从这一路音频的哪个样本开始补发
  #open(from) {
    const conn = { id: ++this.seq, ws: null, open: false, base: from, seg: this.#newSeg(), lastMsgAt: Date.now(), rotateAt: Infinity, forceAt: Infinity, finalizing: false, retired: false }
    this.conn = conn
    conn.ready = (async () => {
      let key = this.opts.key
      if (this.opts.getKey) {
        const k = await this.opts.getKey()
        key = k.key
        // Key 短（这一场快到点时只给剩下的时间）也至少用到四分之三再换，免得一连上就换
        conn.rotateAt = Date.now() + Math.max(k.maxMs - this.tm.rotateBeforeMs, k.maxMs * 0.75)
        conn.forceAt = Math.max(Date.now() + k.maxMs - this.tm.forceBeforeMs, conn.rotateAt)
      }
      if (!key) throw new FatalError(t('还没填 Soniox 的 API Key，去「设置 → 语音识别」里填'))
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(this.opts.url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 15_000 })
        conn.ws = ws
        ws.on('unexpected-response', (_req, res) => reject(new Error(t(`连接 Soniox 失败（HTTP {0}）`, res.statusCode))))
        ws.on('error', (e) => (conn.open ? this.#lost(conn, e) : reject(e)))
        ws.on('open', () => {
          ws.send(JSON.stringify(this.#config(conn)))
          conn.open = true
          conn.lastMsgAt = Date.now()
          this.#replay(conn)
          resolve()
        })
        ws.on('message', (m) => this.#onMessage(conn, m))
        ws.on('close', (code) => {
          if (!conn.open) reject(new Error(t(`Soniox 断开了连接（{0}）`, code)))
          else this.#lost(conn, new Error(t(`连接断开（{0}）`, code)))
        })
      })
      conn.watch = setInterval(() => {
        if (conn.retired || !conn.open) return
        if (Date.now() - conn.lastMsgAt > this.tm.deadAfterMs) this.#lost(conn, new Error(t('Soniox 好久没回音')))
      }, 2000)
      this.retries = 0
    })()
    return conn
  }

  #config(conn) {
    const { model, language, context, hotwords } = this.opts
    const cfg = {
      model,
      audio_format: 'pcm_s16le',
      sample_rate: RATE,
      num_channels: 1,
      language_hints: sonioxHints(language),
      enable_endpoint_detection: true,
      max_endpoint_delay_ms: 1000,
      client_reference_id: `meetcaption-${conn.id}`,
    }
    const terms = hotwords.filter(Boolean).slice(0, 100)
    const text = String(context ?? '').trim().slice(0, 2000)
    if (terms.length || text) cfg.context = { ...(text ? { text } : {}), ...(terms.length ? { terms } : {}) }
    return cfg
  }

  // 从 conn.base 起补发还留着的音频（新连接接着上一条没认完的地方）
  #replay(conn) {
    for (const h of this.history) {
      const end = h.at + h.buf.length / 2
      if (end <= conn.base) continue
      const skip = Math.max(0, conn.base - h.at)
      conn.ws.send(skip ? h.buf.subarray(skip * 2) : h.buf)
    }
  }

  // 这条连接没了（断网、Key 到点、服务端出错）：定稿的字先发出去，从最后一个定稿的字的终点开新连接
  #lost(conn, err) {
    if (conn.retired || conn !== this.conn || this.closing) return
    this.#drop(conn)
    if (err instanceof FatalError) return this.emit('fatal', err)
    this.emit('status', 'reconnecting')
    const delay = this.retries === 0 ? 0 : Math.min(15_000, 1000 * 2 ** (this.retries - 1))
    this.retries++
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.#reconnect(), delay)
  }

  #reconnect() {
    if (this.closing) return
    const oldest = this.history[0]?.at ?? this.sent
    const next = this.#open(Math.max(this.finalEnd, oldest))
    next.ready.then(
      () => this.emit('status', 'ready'),
      (e) => {
        if (MEMBER_STOPS[e.code]) return this.#memberStop(next, MEMBER_STOPS[e.code])
        if (e instanceof FatalError) return this.emit('fatal', e)
        this.#lost(next, e)
      },
    )
  }

  // 会员 Key 快到点：刚好一句说完、下一句还没开口时换新连接。旧连接直接关掉，不等它收尾：
  // 它手上没有没定稿的字，之后送来的音频新连接会从上一句定稿的终点补发（旧连接再认一遍会重复）
  #rotate(conn) {
    if (conn !== this.conn) return
    conn.retired = true
    clearInterval(conn.watch)
    conn.ws?.terminate()
    this.#reconnect()
  }

  async #retire(conn, waitMs) {
    conn.retired = true
    clearInterval(conn.watch)
    const ws = conn.ws
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send('')
      await new Promise((r) => {
        const t = setTimeout(r, waitMs)
        ws.once('close', () => (clearTimeout(t), r()))
      })
    }
    this.#finishSeg(conn)
    ws?.terminate()
  }

  #memberStop(conn, type) {
    this.#drop(conn)
    this.emit('member', type)
  }

  // ---------- 结果 ----------

  #newSeg() {
    return { key: `sx${this.seq}-${Math.random().toString(36).slice(2, 8)}`, text: '', tail: '', start: null, end: null }
  }

  #span(conn, seg) {
    if (seg.start == null) return null
    const baseMs = (conn.base * 1000) / RATE
    return { start: baseMs + seg.start, end: baseMs + seg.end }
  }

  #onMessage(conn, raw) {
    conn.lastMsgAt = Date.now()
    let m
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m.error_code) {
      const msg = describe(m.error_code, m.error_message ?? '')
      // 403：临时 Key 的时长到了；408/413/429/5xx：换连接再来。400/401/402 自带 Key 时没法自己好
      const fatal = !this.opts.getKey && [400, 401, 402].includes(m.error_code)
      return this.#lost(conn, fatal ? new FatalError(msg) : new Error(msg))
    }
    const seg = conn.seg
    // 每条回复带着这一刻全部没定稿的字：上一条的尾巴作废（其中定下来的这条里会作为 final 再来）
    seg.tail = ''
    let tail = ''
    for (const t of m.tokens ?? []) {
      if (t.text === '<end>' || t.text === '<fin>') {
        this.#finishSeg(conn)
        continue
      }
      const s = conn.seg
      if (t.start_ms != null) {
        s.start ??= t.start_ms
        s.end = Math.max(s.end ?? 0, t.end_ms ?? t.start_ms)
      }
      if (t.is_final) {
        s.text += t.text
        if (t.end_ms != null) s.fend = t.end_ms
        if (t.end_ms != null) this.finalEnd = Math.max(this.finalEnd, conn.base + Math.round((t.end_ms * RATE) / 1000))
      } else tail += t.text
    }
    const cur = conn.seg
    cur.tail = tail
    const shown = (cur.text + cur.tail).trim()
    if (shown && (cur !== seg || shown !== seg.shown)) {
      cur.shown = shown
      this.emit('partial', { key: cur.key, text: shown, span: this.#span(conn, cur) })
    }
    if (m.finished) this.#finishSeg(conn)
    const idle = conn.seg.text === '' && conn.seg.tail === ''
    if (conn.retired || Date.now() < conn.rotateAt) return
    if (idle) this.#rotate(conn)
    else if (Date.now() > conn.forceAt && !conn.finalizing) {
      conn.finalizing = true
      conn.ws.send(JSON.stringify({ type: 'finalize' }))
    }
  }

  // 一句说完（<end>）：定稿的字发 final；只剩没定稿的尾巴（连接收尾时）也当定稿
  #finishSeg(conn) {
    const seg = conn.seg
    const text = (seg.text + seg.tail).trim()
    if (text) this.emit('final', { key: seg.key, text, span: this.#span(conn, seg) })
    conn.seg = this.#newSeg()
  }

  // 连接不要了：这一句定稿的部分发 final，没定稿的尾巴不要（新连接从 finalEnd 重新认）；一个字都没定稿就作废
  #drop(conn) {
    conn.retired = true
    clearInterval(conn.watch)
    const seg = conn.seg
    const text = seg.text.trim()
    if (text) this.emit('final', { key: seg.key, text, span: this.#span(conn, { start: seg.start, end: seg.fend ?? seg.end }) })
    else if (seg.shown) this.emit('drop', { key: seg.key })
    conn.seg = this.#newSeg()
    conn.ws?.terminate()
  }
}
