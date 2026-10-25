import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import WebSocket from 'ws'
import { t } from '../i18n.js'

// OpenAI 实时转写（gpt-live-transcribe）：音频边说边出词；本地门限在停顿处 commit，一次 commit 是一段（turn）。
// endTurn(span) 带上门限给的这一段在音频里的起止，partial / final 都带着它（声纹要用）。
//
// 断线不丢字：每一段的音频留在本地，直到服务端给出这一段的终稿。连接断了，没出终稿的段在新连接上从头重送，
// 字幕沿用原来的 key（界面上还是同一段），重送出来的字追上原来显示的长度之前不刷新，免得字幕先变短再变长。
// 实测服务端解码大约是实时的 4 倍，积压的音频一口气送过去再马上 commit，终稿只有解码到的那部分（45 秒只剩 32 秒的字）；
// 所以积压的音频按 3 倍速送，积压过的段最后一块送出 1.5 秒、这一段 0.8 秒没出新字以后才 commit（最多等 8 秒）。
//
// 保活：每 10 秒发一个 WebSocket ping（控制帧，不算音频时长、不计费；服务端自己每 20 到 30 秒也 ping 一次）。
// 20 秒什么都没收到就当连接已经死了，断开重连。门限在静音时不送音频，半死的连接平时发现不了；
// 每段开头如果 2 秒没收到过东西（正在说的时候 3 秒）先 ping 一下，没回音时看 ws 里有没有积压：
// - 没有积压（ping 已经交给系统发出去了）：2 秒没回就马上换连接，没出终稿的音频存着，连上后补送；
// - 有积压：笔记本 Wi-Fi 上行常卡 0.5 到 4 秒，ping 排在积压的音频后面，回不来不说明连接死了。积压还在往外走就接着等，
//   8 秒一个字节都没发出去才换（和豆包一样）。不然卡几秒就重连（握手走的还是那条卡住的上行）、整段重送，字幕停得更久，还多花钱。
// 断线后第一次立刻重连，再失败按 1、2、4…15 秒退避；退避中有人开始说话就不等了。
// 会话最长 60 分钟，50 分钟后在下一个停顿处换新连接，旧连接等手上的段出完终稿再关。

const ROTATE_AFTER_MS = 50 * 60_000
const IGNORED_ERRORS = new Set(['input_audio_buffer_commit_empty'])
// 单测可以用 timing 选项改小
export const TIMING = {
  pingEveryMs: 10_000,
  deadAfterMs: 20_000,
  probeIdleMs: 2000, // 一段开头，这么久没收到过东西就先 ping 一下
  probeBusyMs: 3000, // 正在送音频，这么久一个字、一个回音都没有，也 ping 一下
  probeWaitMs: 2000, // ping 发出去（ws 里没有积压）这么久没有任何回音，当连接死了
  stallMs: 8000, // ws 里有积压、这么久一个字节都没发出去，当连接死了
  tickMs: 500, // 探活时多久看一次积压
  replaySpeed: 3, // 积压的音频按几倍实时速度送
  lateMs: 1000, // 音频在本地等了这么久才送出，算积压
  commitHoldMs: 1500,
  commitQuietMs: 800,
  commitMaxHoldMs: 8000,
  keepSeconds: 180, // 连接一直连不上时最多存这么多秒还没出终稿的音频，再多就先收尾最早的段
  retryGapMs: 1000, // 两次建连之间至少隔这么久
}

class FatalError extends Error {}

// 排查用：MEETCAPTION_ASR_TRACE=<文件> 时记下探活和换连接（和豆包写同一个文件）
const TRACE_FILE = process.env.MEETCAPTION_ASR_TRACE
let traceOut = null
function trace(o) {
  if (!TRACE_FILE) return
  traceOut ??= fs.createWriteStream(TRACE_FILE, { flags: 'a' })
  traceOut.write(`${JSON.stringify({ t: Date.now(), asr: 'openai', ...o })}\n`)
}

// 已经交给系统发出去的字节数。ws 里有积压时系统的发送缓冲区是满的，这个数还在涨，就是对面确认收到、腾出了地方：网络在走。
// 按套接字算，不按消息长度算：OpenAI 开了 permessage-deflate，压缩后的字节和消息长度对不上
function flushedBytes(ws) {
  const s = ws._socket
  return s ? s.bytesWritten - s.writableLength : 0
}

function wsUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + '/realtime?intent=transcription'
}

function describeHttp(status, body) {
  let msg = body
  try {
    msg = JSON.parse(body).error?.message ?? body
  } catch {}
  if (status === 401) return `OpenAI Key 无效或已过期（401）：${msg}`
  if (status === 403) return `OpenAI 拒绝访问（403），可能是地区不支持或账号没有这个模型的权限：${msg}`
  if (status === 429) return `OpenAI 额度用完或请求太频繁（429）：${msg}`
  return `连接 OpenAI 失败（HTTP ${status}）：${msg}`
}

/**
 * 一段的终稿用哪份文字：一般用服务端的 completed；它比已经收到的字（这条连接上累计的 delta，或者重送前显示过的）
 * 短一大截（不到一半）时，多半是服务端没解码完就收尾了，用已经收到的，别把字覆盖丢。
 */
export function finalText(transcript, deltas = '', shown = '') {
  const got = [String(deltas ?? '').trim(), String(shown ?? '').trim()].sort((a, b) => b.length - a.length)[0]
  const t = String(transcript ?? '').trim()
  if (!t) return got
  if (got.length >= 20 && t.length < got.length * 0.5) return got
  return t
}

function newTurn() {
  // chunks：[{ buf, at }]；sent / commitSent / item / acked / text 是在当前连接上的进度，换连接时清零；key 和 shown 跨连接保留
  return { key: null, chunks: [], bytes: 0, span: null, committed: false, sent: 0, commitSent: false, item: null, acked: false, text: '', shown: '', late: false, lastSentAt: 0, lastDeltaAt: 0, done: false }
}

function resetForReplay(t) {
  t.sent = 0
  t.commitSent = false
  t.item = null
  t.acked = false
  t.text = ''
  t.late = t.chunks.length > 0 // 重送是一口气补的，commit 要等服务端解码跟上
  t.lastSentAt = 0
  t.lastDeltaAt = 0
}

const bestText = (t) => {
  const x = t.text.trim()
  return x.length >= t.shown.length ? x : t.shown
}

export class OpenAIRealtimeASR extends EventEmitter {
  sampleRate = 24000
  gated = true

  constructor({ key, baseUrl, model, languages, delay, prompt, keywords, timing = null }) {
    super()
    this.opts = { key, baseUrl, model, languages, delay, prompt, keywords }
    this.tm = { ...TIMING, ...timing }
    this.conn = null
    this.closing = false
    this.failures = 0
    this.open = null // 正在说、还没 commit 的一段
    this.retryTimer = null
    this.lastOpenAt = 0
    this.retiredConns = new Set()
    this.opened = 0
  }

  #sessionUpdate() {
    const { model, languages, delay, prompt, keywords } = this.opts
    const transcription = { model }
    if (languages?.length) transcription.languages = languages
    if (delay && model === 'gpt-live-transcribe') transcription.delay = delay
    if (prompt) transcription.prompt = prompt.slice(0, 1000)
    if (keywords?.length) transcription.keywords = keywords
    return {
      type: 'session.update',
      session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null } } },
    }
  }

  /** 连上并配置好会话才 resolve；key 错、模型不可用会 reject。 */
  connect() {
    return this.#open().ready
  }

  // turns：接着上一条（断掉的）连接没出终稿的段，连上后从头重送
  #open(turns = []) {
    this.lastOpenAt = Date.now()
    const conn = { id: ++this.opened, ws: null, ready: null, isReady: false, openedAt: Date.now(), turns, byItem: new Map(), retired: false, lost: false, lastRecv: Date.now(), timers: {}, tokens: 0, refillAt: Date.now() }
    conn.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.opts.baseUrl), { headers: { Authorization: `Bearer ${this.opts.key}` }, handshakeTimeout: 15_000 })
      conn.ws = ws
      const fail = (e) => {
        if (!conn.isReady) reject(e)
      }
      ws.on('unexpected-response', (req, res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          req.destroy()
          const err = new (res.statusCode === 401 || res.statusCode === 403 ? FatalError : Error)(describeHttp(res.statusCode, body))
          fail(err)
          this.#onConnLost(conn, err)
        })
      })
      ws.on('open', () => ws.send(JSON.stringify(this.#sessionUpdate())))
      ws.on('message', (data) => {
        conn.lastRecv = Date.now()
        let e
        try {
          e = JSON.parse(data.toString())
        } catch {
          return
        }
        this.#onEvent(conn, e, resolve, fail)
      })
      ws.on('ping', () => (conn.lastRecv = Date.now()))
      ws.on('pong', () => (conn.lastRecv = Date.now()))
      ws.on('error', (e) => fail(e))
      ws.on('close', (code, reason) => this.#onConnLost(conn, new Error(t(`连接断开（{0} {1}）`, code, reason))))
      conn.timers.connect = setTimeout(() => {
        if (conn.isReady) return
        fail(new Error(t('连接 OpenAI 超时，检查网络或代理')))
        ws.terminate()
      }, 20_000)
      conn.timers.connect.unref?.()
    })
    conn.ready.catch(() => {})
    this.conn = conn
    return conn
  }

  #onEvent(conn, e, resolve, fail) {
    if (conn.lost) return
    switch (e.type) {
      case 'session.updated':
        if (!conn.isReady) {
          conn.isReady = true
          this.failures = 0
          conn.tokens = 0
          conn.refillAt = Date.now()
          this.#keepAlive(conn)
          this.emit('status', 'ready')
          resolve()
          this.#pump(conn)
        }
        break
      case 'input_audio_buffer.committed': {
        const t = conn.byItem.get(e.item_id) ?? conn.turns.find((x) => x.commitSent && !x.acked)
        if (!t) break
        t.acked = true
        if (!t.item && e.item_id) this.#bind(conn, t, e.item_id)
        break
      }
      case 'conversation.item.input_audio_transcription.delta': {
        const t = this.#turnFor(conn, e.item_id)
        t.text += e.delta ?? ''
        t.lastDeltaAt = Date.now()
        const text = t.text.trim()
        if (text.length < t.shown.length) break // 断线后重送的这一段，还没追上原来显示的字
        t.shown = text
        this.emit('partial', { key: t.key, text, span: t.committed ? t.span : null })
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = this.#turnFor(conn, e.item_id)
        this.#complete(conn, t, finalText(e.transcript, t.text, t.shown))
        break
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const t = this.#turnFor(conn, e.item_id)
        this.#complete(conn, t, bestText(t))
        this.emit('warn', `这一段识别失败：${e.error?.message ?? ''}`)
        break
      }
      case 'error': {
        const code = e.error?.code
        if (code === 'input_audio_buffer_commit_empty') {
          // 这次 commit 服务端说是空的，不会有 committed：这一段就此结束
          const t = conn.turns.find((x) => x.commitSent && !x.acked)
          if (t) this.#complete(conn, t, bestText(t))
        }
        if (IGNORED_ERRORS.has(code)) break
        const err = new Error(t(`OpenAI：{0}`, e.error?.message ?? t('未知错误')))
        if (!conn.isReady) fail(new FatalError(err.message))
        else this.emit('warn', err.message)
        break
      }
    }
  }

  #bind(conn, t, itemId) {
    t.item = itemId
    t.key ??= itemId
    conn.byItem.set(itemId, t)
  }

  // 服务端的 item 对应哪一段：按顺序，这条连接上还没对上 item 的最早一段（已经送过音频或 commit 的）
  #turnFor(conn, itemId) {
    let t = conn.byItem.get(itemId)
    if (t) return t
    t = conn.turns.find((x) => !x.item && !x.acked && !x.done && (x.sent > 0 || x.commitSent))
    if (!t) {
      // 对不上（不该发生）：单独算一段，没有音频可以重送
      t = newTurn()
      t.committed = true
      t.commitSent = true
      conn.turns.push(t)
    }
    this.#bind(conn, t, itemId)
    return t
  }

  #complete(conn, t, text) {
    if (t.done) return
    t.done = true
    const i = conn.turns.indexOf(t)
    if (i >= 0) conn.turns.splice(i, 1)
    if (t.item) conn.byItem.delete(t.item)
    if (this.open === t) this.open = null
    const key = t.key ?? t.item
    if (key) this.emit('final', { key, text, span: t.span })
    if (conn.retired && conn.turns.length === 0) conn.ws.close()
    this.#pump(conn)
  }

  /* ---------------- 送音频 ---------------- */

  // 积压的音频按 replaySpeed 倍速送，平时来一块送一块；积压过的段等服务端解码跟上了再 commit
  #pump(conn) {
    if (!conn) return
    clearTimeout(conn.timers.pump)
    if (!conn.isReady || conn.lost || conn.ws.readyState !== WebSocket.OPEN) return
    const now = Date.now()
    const rate = this.sampleRate * 2 * this.tm.replaySpeed
    conn.tokens = Math.min(this.sampleRate * 2, conn.tokens + ((now - conn.refillAt) * rate) / 1000)
    conn.refillAt = now
    let wait = 0
    for (const t of conn.turns) {
      while (t.sent < t.chunks.length) {
        if (conn.tokens <= 0) {
          wait = 100
          break
        }
        const c = t.chunks[t.sent++]
        conn.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: c.buf.toString('base64') }))
        conn.tokens -= c.buf.length
        if (now - c.at > this.tm.lateMs) t.late = true
        t.lastSentAt = now
      }
      if (wait || !t.committed) break
      if (t.commitSent) continue
      if (t.late) {
        const hold = Math.max(t.lastSentAt + this.tm.commitHoldMs, (t.lastDeltaAt || 0) + this.tm.commitQuietMs)
        const at = Math.min(hold, t.lastSentAt + this.tm.commitMaxHoldMs)
        if (now < at) {
          wait = at - now
          break
        }
      }
      conn.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      t.commitSent = true
    }
    if (wait) {
      conn.timers.pump = setTimeout(() => this.#pump(conn), Math.max(wait, 20))
      conn.timers.pump.unref?.()
    }
  }

  sendAudio(buf) {
    const conn = this.conn
    if (!conn || this.closing || !buf?.length) return
    let t = this.open
    if (!t) {
      t = this.open = newTurn()
      conn.turns.push(t)
      this.#turnStarted(conn)
    }
    t.chunks.push({ buf, at: Date.now() })
    t.bytes += buf.length
    if (Date.now() - conn.lastRecv > this.tm.probeBusyMs) this.#probe(conn)
    this.#trim(conn)
    this.#pump(conn)
  }

  /** span：{ start, end }（毫秒，这一路音频的时间），不知道就不传。 */
  endTurn(span = null) {
    const conn = this.conn
    if (!conn || this.closing) return
    let t = this.open
    if (!t) {
      // 没送过音频也照样 commit（服务端会回 commit_empty）
      t = newTurn()
      conn.turns.push(t)
    }
    this.open = null
    t.span = span
    t.committed = true
    this.#pump(conn)
    if (conn.isReady && !conn.lost && Date.now() - conn.openedAt > ROTATE_AFTER_MS) this.#rotate(conn)
  }

  // 一段开始说话：连接在退避里就马上重连；好久没收到东西就先 ping 一下，半死的连接趁早换掉
  #turnStarted(conn) {
    if (this.retryTimer) return this.#reconnectNow()
    if (Date.now() - conn.lastRecv >= this.tm.probeIdleMs) this.#probe(conn)
  }

  // ping 一下等回音。没回音时：ws 里没有积压，probeWaitMs 就算死；有积压，上行 stallMs 一直不动才算死（见文件开头）
  #probe(conn) {
    if (!conn.isReady || conn.lost || conn.timers.probe) return
    const at = Date.now()
    try {
      conn.ws.ping()
    } catch {}
    let backlog = conn.ws.bufferedAmount
    let out = flushedBytes(conn.ws)
    let movedAt = at // ping 发出，或者上一次看到积压在往外走
    trace({ ev: 'probe', c: conn.id, buf: backlog })
    const schedule = (ms) => {
      conn.timers.probe = setTimeout(check, Math.max(ms, 10))
      conn.timers.probe.unref?.()
    }
    const check = () => {
      conn.timers.probe = null
      if (conn.lost) return
      const now = Date.now()
      if (conn.lastRecv >= at) return trace({ ev: 'alive', c: conn.id, ms: conn.lastRecv - at })
      const o = flushedBytes(conn.ws)
      if (backlog >= 1024 && o - out > 1024) movedAt = now // 有积压时系统又收走了一批：上行在走
      out = o
      backlog = conn.ws.bufferedAmount
      const limit = backlog < 1024 ? this.tm.probeWaitMs : this.tm.stallMs
      if (now - movedAt >= limit) {
        trace({ ev: 'dead', c: conn.id, buf: backlog, quiet: now - movedAt })
        conn.ws.terminate()
        return
      }
      schedule(Math.min(this.tm.tickMs, movedAt + limit - now))
    }
    schedule(Math.min(this.tm.tickMs, this.tm.probeWaitMs))
  }

  // 连接一直连不上、音频越攒越多：最早的段先用已经收到的字收尾，不再等重送
  #trim(conn) {
    let bytes = conn.turns.reduce((a, t) => a + t.bytes, 0)
    const max = this.sampleRate * 2 * this.tm.keepSeconds
    while (bytes > max && conn.turns.length > 1 && conn.turns[0].committed) {
      const t = conn.turns[0]
      bytes -= t.bytes
      this.#complete(conn, t, bestText(t))
    }
  }

  /* ---------------- 保活、断线重连、换连接 ---------------- */

  #keepAlive(conn) {
    conn.timers.ping = setInterval(() => {
      if (conn.lost || conn.ws.readyState !== WebSocket.OPEN) return
      if (Date.now() - conn.lastRecv > this.tm.deadAfterMs) {
        trace({ ev: 'dead', c: conn.id, buf: conn.ws.bufferedAmount, quiet: Date.now() - conn.lastRecv })
        conn.ws.terminate() // 20 秒没有任何回音：半死的连接，换掉
        return
      }
      try {
        conn.ws.ping()
      } catch {}
    }, this.tm.pingEveryMs)
    conn.timers.ping.unref?.()
  }

  #stopTimers(conn) {
    clearTimeout(conn.timers.connect)
    clearInterval(conn.timers.ping)
    clearTimeout(conn.timers.probe)
    clearTimeout(conn.timers.pump)
    clearTimeout(conn.timers.retire)
    conn.timers.probe = null
  }

  #rotate(conn) {
    conn.retired = true
    this.retiredConns.add(conn)
    conn.timers.retire = setTimeout(() => conn.ws.close(), conn.turns.length ? 10_000 : 3000)
    conn.timers.retire.unref?.()
    const next = this.#open([])
    next.ready.catch((e) => this.#onConnLost(next, e))
  }

  #onConnLost(conn, err) {
    if (conn.lost) return
    conn.lost = true
    this.#stopTimers(conn)
    trace({ ev: 'lost', c: conn.id, msg: err?.message })
    if (conn !== this.conn || this.closing) {
      // 退役的旧连接（或者正在关）：手上没出终稿的段用已经收到的字收尾
      this.retiredConns.delete(conn)
      if (conn !== this.conn) for (const t of [...conn.turns]) this.#complete(conn, t, bestText(t))
      return
    }
    // 这条连接上的进度作废；没出终稿的段留着音频，连上新连接后从头重送。没有音频可送的（对不上的）先收尾
    conn.byItem.clear()
    for (const t of [...conn.turns]) {
      if (!t.chunks.length && t.committed && (t.key || t.item)) this.#complete(conn, t, bestText(t))
      else resetForReplay(t)
    }
    if (err instanceof FatalError) {
      this.emit('fatal', err)
      return
    }
    this.failures++
    this.emit('status', 'reconnecting')
    const backoff = this.failures === 1 ? 0 : Math.min(1000 * 2 ** (this.failures - 2), 15_000)
    const delay = Math.max(backoff, this.lastOpenAt + this.tm.retryGapMs - Date.now())
    this.retryTimer = setTimeout(() => this.#reconnectNow(), delay)
    this.retryTimer.unref?.()
  }

  #reconnectNow() {
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    const old = this.conn
    if (this.closing || !old?.lost) return
    const next = this.#open(old.turns)
    next.ready.catch((e) => this.#onConnLost(next, e))
  }

  async close() {
    this.closing = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    const conn = this.conn
    if (!conn) return
    if (this.open) {
      this.open.committed = true
      this.open = null
    }
    if (conn.isReady && !conn.lost && conn.ws.readyState === WebSocket.OPEN) {
      this.#pump(conn)
      // 等最后几段的终稿：一般最多 3 秒，还有积压的音频就按 3 倍速多等一会儿，最多 10 秒
      const unsent = conn.turns.reduce((a, t) => a + t.chunks.slice(t.sent).reduce((b, c) => b + c.buf.length, 0), 0)
      const limit = Math.min(3000 + (unsent / (this.sampleRate * 2 * this.tm.replaySpeed)) * 1000, 10_000)
      await new Promise((r) => {
        const t = setTimeout(r, limit)
        const check = () => {
          if (conn.lost || conn.turns.length === 0) {
            clearTimeout(t)
            setTimeout(r, 300)
          } else setTimeout(check, 100)
        }
        setTimeout(check, 600)
      })
    }
    for (const c of [conn, ...this.retiredConns]) {
      this.#stopTimers(c)
      for (const t of [...c.turns]) this.#complete(c, t, bestText(t))
      try {
        c.ws.close()
      } catch {}
    }
    this.retiredConns.clear()
  }
}
