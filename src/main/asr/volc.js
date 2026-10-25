import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import zlib from 'node:zlib'
import WebSocket from 'ws'
import { t } from '../i18n.js'

// 豆包（火山引擎）大模型流式识别 v3：wss://openspeech.bytedance.com/api/v3/sauc/bigmodel。
// 帧：[4 字节 header][4 字节大端 payload 长度][payload]；响应带序号时 header 后多 4 字节，错误帧多 4 字节错误码。
// 服务端自己断句：utterances 里 definite=true 的是定稿。音频一直送（含静音），按连接时长计费。
// 资源 volc.seedasr.*（2.0）只在 bigmodel_async 端点上开通，而且必须带 X-Api-Request-Id；2.0 开 enable_nonstream（两遍识别：
// 边说边出流式结果，一句说完再用非流式模型重识别一遍当定稿，实测定稿晚 0.1 到 0.4 秒，专有名词和术语准很多）。
// utterance 的 start_time / end_time 是相对这条连接收到的第一个样本的毫秒数；记下每条连接从这一路音频的哪里开始送，
// 事件里给出 span（这一路音频的毫秒时间），声纹按它取音频。
// 2.0 的回复里起点是 0 的句子没有 start_time 字段（连接里的第一句），见 utteranceStart。
//
// 断线：服务端 8 秒收不到包就结束会话（45000081）。Windows 真机上应用照常每 100ms 发一包，ws 里积压的字节却一直涨：
// 笔记本 Wi-Fi 上行动不动卡 0.5 到 4 秒，偶尔超过 8 秒（同时 ping 路由器丢 23%）。于是：
// - 45000081 这类「这次会话结束了」和服务端内部错误都换一条连接接着识别，只有鉴权、资源没开通、额度、参数这类才算致命；
// - 留最近 60 秒送出的音频，新连接从上一句定稿的终点补发（实测补发一口气发完服务端照样认，结果和实时送一样），
//   旧连接上没定稿的句子作废重认（'drop'），断线期间的音频不丢；
// - 看门狗：连接上 3 秒没发过包就补 200ms 静音（记在这条连接的时间轴上，换算 span 时扣掉）；ws 里有积压、8 秒一个字节
//   都没发出去，服务端肯定已经超时了，错误帧也没回来就是下行也断了，不再等，直接换连接。

class FatalError extends Error {}

// 经会员服务器转发时（url 指向 api.us-cloud.uk）它会主动断开或拒绝重连的几种情况：关闭码 / 握手时 X-Api-Message 里的代码
const MEMBER_CLOSE = { 4002: 'exhausted', 4008: 'idle' }
const MEMBER_STOPS = { exhausted: 'exhausted', idle: 'idle', ended: 'ended' }

const RATE = 16000
const PER_MS = RATE / 1000 // 16 个样本 1 毫秒
const PACKET_BYTES = 3200 // 攒够 100ms 发一包
const REPLAY_PACKET_BYTES = 6400 // 重连补发时 200ms 一包
const STABLE_MS = 20_000 // 连接活过 20 秒，之前连续失败的次数清零
const MAX_UNKNOWN_FAILS = 3 // 没见过的错误码连着出这么多次（每次连接都没撑过 20 秒）才算致命

/** 默认的时间参数；单测用构造参数 timing 改小。 */
export const TIMING = {
  watchdogMs: 3000, // 超过 3 秒没发包就补一包静音
  tickMs: 500,
  fillSamples: RATE / 5, // 每次补 200ms
  stallMs: 8000, // ws 里有积压、这么久一个字节都没发出去就换连接（补发一大段时积压很多但一直在走，不算）
  historyMs: 60_000, // 留最近 60 秒送出的音频
  retryBaseMs: 1000,
  retryMaxMs: 15_000,
}

// 排查用：MEETCAPTION_ASR_TRACE=<文件> 时逐包记下发送时间、字节数、ws 里还没发出去的字节数，和主进程事件循环的卡顿
const TRACE_FILE = process.env.MEETCAPTION_ASR_TRACE
let traceOut = null
function trace(o) {
  if (!TRACE_FILE) return
  if (!traceOut) {
    traceOut = fs.createWriteStream(TRACE_FILE, { flags: 'a' })
    let last = Date.now()
    setInterval(() => {
      const now = Date.now()
      if (now - last > 350) trace({ ev: 'lag', ms: now - last - 100 })
      last = now
    }, 100).unref?.()
  }
  traceOut.write(`${JSON.stringify({ t: Date.now(), ...o })}\n`)
}

/**
 * 握手被拒（HTTP 4xx/5xx）时给用户看的中文原因。403 requested resource not granted 是火山引擎账号那边的资源
 * （流式识别没开通、时长包用完）出了问题，不是密钥填错；401 才是 App ID / Access Token 不对。
 */
export function handshakeError(status, body = '', { resourceId = '', apiMessage = '' } = {}) {
  const raw = String(body || apiMessage || '').trim()
  let detail = raw
  try {
    detail = JSON.parse(raw)?.error ?? raw
  } catch {}
  detail = String(detail).replace(/^\[resource_id=[^\]]*\]\s*/, '').slice(0, 160)
  const tail = `（HTTP ${status}${detail ? `：${detail}` : ''}）`
  if (status === 403 && /not granted|resource/i.test(raw))
    return `火山引擎账号的流式识别资源没开通或用完了，去火山引擎控制台看看${resourceId ? `（资源 ${resourceId}）` : ''}。${tail}`
  if (status === 401 || (status === 403 && /auth|token|key|appid|app id|invalid/i.test(raw))) return `豆包的 App ID 或 Access Token 不对，去「设置 > 语音识别」核对一下。${tail}`
  if (status === 429) return `豆包识别的并发或频率超限了，过一会儿再试。${tail}`
  if (status >= 400 && status < 500) return `豆包识别连不上，检查 App ID、Access Token 和资源 ID。${tail}`
  return `豆包识别服务暂时不可用，过一会儿再试。${tail}`
}

const FATAL_TEXT = /auth|token|app ?id|access ?key|quota|grant|permission|arrear|balance|欠费|额度|鉴权|权限|未开通|用完/i

/**
 * 错误帧怎么处理：'retry' 换一条连接接着识别；'fatal' 重连也没用，结束这次记录；'unknown' 先重连，连着失败几次再算致命。
 * 45000081 等包超时、45000002 空音频只是这一次会话结束了；55xxxxxx 是服务端内部错误或繁忙。
 * 45000001 参数不对、45000151 音频格式不对，以及文字里说鉴权、额度、资源没开通的，重连也一样。
 */
export function classifyServerError(code, message = '') {
  const c = String(code ?? '')
  if (c === '45000081' || c === '45000002' || c.startsWith('55')) return 'retry'
  if (c === '45000001' || c === '45000151' || FATAL_TEXT.test(message)) return 'fatal'
  return 'unknown'
}

function frame(type, flags, serialization, compression, payload) {
  const header = Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | compression, 0])
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length)
  return Buffer.concat([header, size, payload])
}

const hasStart = (u) => u.start_time != null && Number(u.start_time) >= 0

/**
 * 一句话的起点（毫秒，相对这条连接）：有 start_time 就用；2.0 起点是 0 时不给这个字段，就用第一个有时间的词，
 * 再没有就用这条连接上一句定稿的终点 lastEnd。
 */
export function utteranceStart(u, lastEnd = 0) {
  if (hasStart(u)) return Number(u.start_time)
  const w = (Array.isArray(u.words) ? u.words : []).find((x) => x?.start_time != null && Number(x.start_time) >= 0)
  return w ? Number(w.start_time) : lastEnd
}

/**
 * 一句话在这条连接里的 key，同一句的 partial 和定稿要一样：有 start_time 就是它；没有的用上一句定稿的终点做锚
 * （~ 开头，和数字 key 分开）。词的时间在 partial 和定稿之间会变（340、200、80），不能拿来当 key。
 */
export function utteranceKey(connId, u, lastEnd = 0) {
  return hasStart(u) ? `${connId}:${Number(u.start_time)}` : `${connId}:~${lastEnd}`
}

export function decodeFrame(buf) {
  const headerSize = (buf[0] & 0x0f) * 4
  const type = buf[1] >> 4
  const flags = buf[1] & 0x0f
  const compression = buf[2] & 0x0f
  let o = headerSize
  if (type === 0b1001 && flags & 0b0001) o += 4
  let code
  if (type === 0b1111) {
    code = buf.readUInt32BE(o)
    o += 4
  }
  const size = buf.readUInt32BE(o)
  o += 4
  let payload = buf.subarray(o, o + size)
  if (compression === 1 && payload.length) payload = zlib.gunzipSync(payload)
  return { type, flags, code, payload }
}

export class VolcStreamASR extends EventEmitter {
  sampleRate = RATE
  gated = false

  constructor({ appId, accessToken, resourceId, hotwords, url, timing }) {
    super()
    this.opts = { appId, accessToken, resourceId: resourceId || 'volc.seedasr.sauc.duration', hotwords, url } // url：会员模式下是我们服务器的转发地址，单测里是假服务器
    this.t = { ...TIMING, ...timing }
    this.conn = null
    this.closing = false
    this.failures = 0 // 连续失败的次数，决定下次隔多久重连
    this.unknownFails = 0
    this.retryTimer = null
    this.watchdog = null
    this.pending = []
    this.pendingBytes = 0
    this.flushedSamples = 0 // 已经从 pending 送出（或攒进 history）的样本数，= 下一包的起点
    this.history = [] // 最近 60 秒送出的音频 [{ at, buf }]，at 是这一路的样本位置
    this.resumeFrom = null // 下一条连接从这一路的第几个样本开始补发；null 是不补发、直接送新音频（第一条连接）
    this.orphans = new Map() // 断掉的连接上还没定稿的句子：新连接补发了它的音频就作废（drop），没补上就当定稿
  }

  connect() {
    return this.#open().ready
  }

  #open() {
    const { appId, accessToken, resourceId, hotwords, url } = this.opts
    const endpoint = resourceId.includes('seedasr') ? 'bigmodel_async' : 'bigmodel'
    const conn = {
      id: randomUUID().slice(0, 8),
      ws: null,
      isReady: false,
      readyAt: 0,
      finals: new Set(),
      open: new Map(),
      lost: false,
      baseSample: null, // 这条连接的第一个真实样本是这一路的第几个样本
      lastEnd: 0,
      heard: 0, // 服务端说收到了多少毫秒（audio_info.duration，连接上的时间）
      replayed: 0, // 这条连接一开始补发了多少毫秒
      sent: 0, // 这条连接上送出的样本数（含看门狗补的静音）
      queued: 0, // 上次看门狗检查以后交给 ws 的字节数
      lastBuf: 0, // 上次检查时 ws 里积压的字节数
      movingAt: 0, // 上次看到积压在往外走（或者没有积压）的时间
      inserted: [], // 看门狗补的静音 [{ at: 连接上的样本位置, n }]
      lastSendAt: 0,
    }
    conn.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(url ?? `wss://openspeech.bytedance.com/api/v3/sauc/${endpoint}`, {
        headers: {
          'X-Api-App-Key': appId,
          'X-Api-Access-Key': accessToken,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': randomUUID(),
          'X-Api-Request-Id': randomUUID(),
        },
        handshakeTimeout: 15_000,
      })
      conn.ws = ws
      const fail = (e) => {
        if (!conn.isReady) reject(e)
      }
      ws.on('unexpected-response', (req, res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => {
          req.destroy()
          const status = res.statusCode
          const memberStop = MEMBER_STOPS[res.headers['x-api-message']]
          if (memberStop && (status === 402 || status === 409)) {
            fail(new Error(memberStop))
            return this.#memberStop(conn, memberStop)
          }
          const msg = handshakeError(status, body, { resourceId, apiMessage: res.headers['x-api-message'] })
          // 429（并发超限，常见于刚断的旧会话还没释放）和 5xx 过一会儿再连；其余 4xx 是账号或参数的问题
          const err = status >= 400 && status < 500 && status !== 429 ? new FatalError(msg) : new Error(msg)
          fail(err)
          this.#onConnLost(conn, err)
        })
      })
      ws.on('open', () => {
        const request = { model_name: 'bigmodel', enable_itn: true, enable_punc: true, show_utterances: true, result_type: 'single', end_window_size: 800 }
        if (resourceId.includes('seedasr')) request.enable_nonstream = true // 2.0：两遍识别，定稿更准
        const words = (hotwords ?? []).filter((w) => w.length <= 30).slice(0, 100)
        if (words.length) request.corpus = { context: JSON.stringify({ hotwords: words.map((word) => ({ word })) }) }
        const body = { user: { uid: 'meetcaption' }, audio: { format: 'pcm', codec: 'raw', rate: RATE, bits: 16, channel: 1 }, request }
        ws.send(frame(0b0001, 0, 1, 1, zlib.gzipSync(Buffer.from(JSON.stringify(body)))))
        conn.isReady = true
        conn.readyAt = conn.lastSendAt = conn.movingAt = Date.now()
        trace({ ev: 'ready', c: conn.id })
        this.emit('status', 'ready')
        resolve()
        this.#resume(conn)
        this.#startWatchdog()
      })
      ws.on('message', (data) => this.#onFrame(conn, data))
      ws.on('error', (e) => fail(e))
      ws.on('close', (code, reason) => {
        if (MEMBER_CLOSE[code]) return this.#memberStop(conn, MEMBER_CLOSE[code])
        this.#onConnLost(conn, new Error(t(`豆包连接断开（{0} {1}）`, code, reason)))
      })
    })
    conn.ready.catch(() => {})
    this.conn = conn
    return conn
  }

  #onFrame(conn, data) {
    // 已经判定断掉的连接（没定稿的句子交给了下一条连接重认）：后面零星到的结果不要，不然会和补发重认的重复
    if (conn.lost) return
    let f
    try {
      f = decodeFrame(data)
    } catch {
      return
    }
    if (f.type === 0b1111) {
      const text = f.payload.toString('utf8').slice(0, 200)
      const msg = `豆包识别出错（${f.code}）：${text}`
      const kind = classifyServerError(f.code, text)
      trace({ ev: 'error', c: conn.id, code: f.code, kind, text })
      this.#onConnLost(conn, kind === 'fatal' ? new FatalError(msg) : Object.assign(new Error(msg), { kind }))
      conn.ws.close()
      return
    }
    if (f.type !== 0b1001) return
    let j
    try {
      j = JSON.parse(f.payload.toString('utf8'))
    } catch {
      return
    }
    const heard = Number(j.audio_info?.duration)
    if (heard > conn.heard) conn.heard = heard
    const utterances = j.result?.utterances ?? []
    for (const u of utterances) {
      const key = utteranceKey(conn.id, u, conn.lastEnd)
      if (conn.finals.has(key)) continue
      const start = utteranceStart(u, conn.lastEnd)
      const end = Number(u.end_time)
      // 没有起点的句子只能按 lastEnd 认：终点不在上一句定稿之后的是已经定稿过的那句又来了一遍
      if (!hasStart(u) && conn.lastEnd > 0 && end >= 0 && end <= conn.lastEnd) continue
      const text = (u.text ?? '').trim()
      const span = this.#span(conn, start, end)
      this.#dropRevised(conn, key, start, end, u.definite)
      if (u.definite) {
        conn.finals.add(key)
        conn.open.delete(key)
        if (end >= 0) conn.lastEnd = Math.max(conn.lastEnd, end)
        this.emit('final', { key, text, span })
      } else if (text) {
        conn.open.set(key, { text, span, start })
        this.emit('partial', { key, text, span })
      }
    }
    if (f.flags & 0b0010) conn.done?.()
  }

  // 服务端会改一句话的起点（先出 "2." 起点 17362，后来整句 "2N." 起点改成 17222）：旧起点落在新这句时间里的未定稿句子作废，
  // 发 'drop'，不然它会一直挂着，收尾时被当成一句定稿。
  // 定稿时放宽 1 秒：2.0 连接里第一句的 partial 中途会带上 start_time 40（换了 key），定稿又不带了、起点按第一个词算成 80，
  // 那句 partial 的起点比定稿早一点，也是同一句。
  #dropRevised(conn, key, start, end, definite = false) {
    if (!(end > start)) return
    const from = definite ? start - 1000 : start
    for (const [k, o] of conn.open) {
      if (k === key || !(o.start >= from && o.start < end)) continue
      conn.open.delete(k)
      this.emit('drop', { key: k })
    }
  }

  // 连接上的毫秒 → 这一路音频的毫秒：加上这条连接的起点，扣掉之前看门狗补进去的静音
  #toSource(conn, ms) {
    const t = ms * PER_MS
    let shift = 0
    for (const x of conn.inserted) {
      if (x.at >= t) break
      shift += Math.min(x.n, t - x.at)
    }
    return (conn.baseSample + t - shift) / PER_MS
  }

  #span(conn, start, end) {
    if (conn.baseSample == null || !(start >= 0) || !(end > start)) return null
    return { start: this.#toSource(conn, start), end: this.#toSource(conn, end) }
  }

  #finalize(map) {
    for (const [key, { text, span }] of map) this.emit('final', { key, text, span })
    map.clear()
  }

  #onConnLost(conn, err) {
    if (conn.lost) return
    conn.lost = true
    trace({ ev: 'lost', c: conn.id, err: err?.message })
    conn.done?.()
    const current = conn === this.conn && !this.closing
    if (current && conn.readyAt && Date.now() - conn.readyAt >= STABLE_MS) {
      this.failures = 0
      this.unknownFails = 0
    }
    let fatal = err instanceof FatalError
    if (current && !fatal && err?.kind === 'unknown' && ++this.unknownFails >= MAX_UNKNOWN_FAILS) fatal = true
    if (!current) {
      this.#finalize(conn.open)
      return
    }
    if (fatal) {
      // 不再重连：没定稿的句子就当定稿
      this.#finalize(conn.open)
      this.#finalize(this.orphans)
      this.#stopWatchdog()
      this.emit('fatal', err)
      return
    }
    this.#planResume(conn)
    this.failures++
    const delay = Math.min(this.t.retryBaseMs * 2 ** (this.failures - 1), this.t.retryMaxMs)
    this.emit('status', 'reconnecting')
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.closing || conn !== this.conn) return
      const next = this.#open()
      next.ready.catch((e) => this.#onConnLost(next, e))
    }, delay)
  }

  // 会员服务器主动停的（场次用完、15 分钟没说话自动暂停、这一场已结束）：不重连，没定稿的当定稿，交给上层换本地识别或暂停
  #memberStop(conn, type) {
    if (conn.lost) return
    conn.lost = true
    conn.done?.()
    if (conn !== this.conn || this.closing) return this.#finalize(conn.open)
    this.#finalize(conn.open)
    this.#finalize(this.orphans)
    this.#stopWatchdog()
    clearTimeout(this.retryTimer)
    this.emit('member', type)
  }

  // 下一条连接从哪里补发：有没定稿的句子，从上一句定稿的终点（这几句作废，新连接重新认）；没有就从服务端说收到的地方往前 1 秒
  // （刚补发完一大段时服务端还没认完，这时不信它）。这条连接还没送过音频就沿用上一次的起点。
  // 上一句定稿早就不在 60 秒的缓存里了，就把没定稿的句子当定稿，从它们的终点接着送。
  #planResume(conn) {
    const start = this.#historyStart()
    let from = this.resumeFrom ?? this.flushedSamples
    if (conn.baseSample != null) {
      let ms = conn.lastEnd
      const settled = !conn.replayed || Date.now() - conn.readyAt > 10_000
      if (!conn.open.size && settled) ms = Math.max(ms, conn.heard - 1000)
      from = Math.round(this.#toSource(conn, ms) * PER_MS)
    }
    if (from >= start) {
      for (const [key, o] of conn.open) this.orphans.set(key, o)
      conn.open.clear()
    } else {
      let tail = start
      for (const { span } of conn.open.values()) if (span) tail = Math.max(tail, Math.round(span.end * PER_MS))
      this.#finalize(conn.open)
      from = tail
    }
    this.resumeFrom = Math.min(from, this.flushedSamples)
  }

  // 新连接好了：把断线前后没认完的音频补发过去
  #resume(conn) {
    const from = this.resumeFrom
    if (from == null) return
    this.resumeFrom = null
    const start = this.#historyStart()
    const gone = from < start // 断得太久，起点那段已经挤出缓存
    for (const [key, o] of this.orphans) this.emit(gone ? 'final' : 'drop', gone ? { key, text: o.text, span: o.span } : { key })
    this.orphans.clear()
    const at = Math.max(from, start)
    conn.baseSample = at
    const pcm = this.#historySlice(at)
    for (let o = 0; o < pcm.length; o += REPLAY_PACKET_BYTES) this.#send(conn, pcm.subarray(o, o + REPLAY_PACKET_BYTES), false)
    conn.replayed = pcm.length / 2 / PER_MS
    trace({ ev: 'replay', c: conn.id, ms: conn.replayed, gone })
  }

  #historyStart() {
    return this.history.length ? this.history[0].at : this.flushedSamples
  }

  #remember(at, buf) {
    this.history.push({ at, buf })
    const keepFrom = this.flushedSamples - this.t.historyMs * PER_MS
    while (this.history.length && this.history[0].at + (this.history[0].buf.length >> 1) <= keepFrom) this.history.shift()
  }

  #historySlice(from) {
    const parts = []
    for (const { at, buf } of this.history) {
      const end = at + (buf.length >> 1)
      if (end <= from) continue
      parts.push(at >= from ? buf : buf.subarray((from - at) * 2))
    }
    return Buffer.concat(parts)
  }

  #startWatchdog() {
    if (this.watchdog) return
    this.watchdog = setInterval(() => this.#watch(), this.t.tickMs)
    this.watchdog.unref?.()
  }

  #stopWatchdog() {
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  #watch() {
    const conn = this.conn
    if (this.closing) return this.#stopWatchdog()
    if (!conn?.isReady || conn.lost || conn.ws.readyState !== WebSocket.OPEN) return
    // 网络卡住了：发出去的音频全积压在 ws 里，一个字节都没走。到这时服务端早就超时了，错误帧没回来说明下行也不通，直接换一条连接
    const now = Date.now()
    const buf = conn.ws.bufferedAmount
    const drained = conn.lastBuf + conn.queued - buf // 上次检查以后从 ws 发出去的字节（ws 自己的帧头会让它略少）
    conn.lastBuf = buf
    conn.queued = 0
    if (buf < 1024 || drained > 1024) conn.movingAt = now
    else if (now - conn.movingAt >= this.t.stallMs) {
      trace({ ev: 'stall', c: conn.id, buf })
      this.#onConnLost(conn, new Error(t('豆包连接卡住了，音频发不出去')))
      conn.ws.terminate()
      return
    }
    if (now - conn.lastSendAt < this.t.watchdogMs) return
    // 攒着不够一包的真音频先发掉；什么都没有就补一段静音
    if (this.pendingBytes) return this.#flush(false)
    const n = this.t.fillSamples
    const last = conn.inserted.at(-1)
    if (last && last.at + last.n === conn.sent) last.n += n
    else conn.inserted.push({ at: conn.sent, n })
    trace({ ev: 'fill', c: conn.id, ms: n / PER_MS })
    this.#send(conn, Buffer.alloc(n * 2), false)
  }

  sendAudio(buf) {
    this.pending.push(buf)
    this.pendingBytes += buf.length
    if (this.pendingBytes >= PACKET_BYTES) this.#flush(false)
  }

  #flush(last) {
    const payload = Buffer.concat(this.pending)
    this.pending = []
    this.pendingBytes = 0
    const at = this.flushedSamples
    this.flushedSamples += payload.length >> 1
    if (payload.length) this.#remember(at, payload)
    const conn = this.conn
    // 连接没好（重连中）：音频留在 history 里，新连接好了补发
    if (!conn?.isReady || conn.lost || conn.ws.readyState !== WebSocket.OPEN) return
    if (conn.baseSample == null) conn.baseSample = at
    this.#send(conn, payload, last)
  }

  #send(conn, payload, last) {
    const data = frame(0b0010, last ? 0b0010 : 0, 0, 0, payload)
    conn.ws.send(data)
    conn.queued += data.length
    conn.sent += payload.length >> 1
    conn.lastSendAt = Date.now()
    trace({ ev: 'send', c: conn.id, bytes: payload.length, buf: conn.ws.bufferedAmount })
  }

  endTurn() {}

  async close() {
    this.closing = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.#stopWatchdog()
    const conn = this.conn
    if (conn?.isReady && !conn.lost && conn.ws.readyState === WebSocket.OPEN) {
      let timer
      await new Promise((resolve) => {
        conn.done = resolve
        this.#flush(true)
        timer = setTimeout(resolve, 3000)
      })
      clearTimeout(timer)
    }
    conn?.ws.close()
    if (conn) this.#finalize(conn.open)
    this.#finalize(this.orphans)
  }
}
