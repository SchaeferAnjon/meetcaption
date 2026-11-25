import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { muxOpusWebm, packetRecord, readPackets } from './webm.js'

// 录音（MeetCaption 联动，设计 24「录音留下来」）：开始记录就录，字幕用的那两路（电脑声音、麦克风）混成单声道，Opus 28 kbps。
// 时间轴 = 这一场开始后的墙上时间：暂停那段补静音，所以笔记里 ▶ 的 t（这一场开始后的秒数）在录音里就是那一秒。
// 会上：Mixer 混好一块就交给编码器（隐藏窗口，renderer/opus），编出的包追加进会议文件夹的 录音.packets；
// 停止：编码器收尾，包封成 录音.webm（带 Cues 和时长，见 webm.js），删掉包文件，session.audio 记下来。
// 事件：'saved' { sessionId, file, bytes, durationMs }、'error' { sessionId, message }。

export const RATE = 16000
export const BITRATE = 28000
export const AUDIO_FILE = '录音.webm'
const PACKETS = '录音.packets'

const toInt16 = (buf) => new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + (buf.byteLength & ~1)))

function resample(src, from, to) {
  if (from === to) return src
  const n = Math.floor((src.length * to) / from)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to
    const a = Math.floor(x)
    const b = Math.min(a + 1, src.length - 1)
    out[i] = Math.round(src[a] + (src[b] - src[a]) * (x - a))
  }
  return out
}

/**
 * 两路混一路，按墙上时间排：每一路记着自己写到第几个样本，和「现在 − 开始」差出半秒以上（暂停、卡过）就从现在接着排。
 * 所有在出声的路都写到了的那一段才交出去（最多压 2 秒），没人出声的地方是静音。
 */
export class Mixer {
  constructor({ startAt, out, now = () => Date.now(), rate = RATE }) {
    this.startAt = startAt
    this.out = out
    this.now = now
    this.rate = rate
    this.base = 0 // 还没交出去的第一个样本
    this.acc = new Float32Array(rate * 4)
    this.lanes = new Map()
  }

  #nowSample() {
    return Math.max(0, Math.round(((this.now() - this.startAt) * this.rate) / 1000))
  }

  #ensure(n) {
    if (n <= this.acc.length) return
    const next = new Float32Array(Math.max(n, this.acc.length * 2))
    next.set(this.acc)
    this.acc = next
  }

  push(source, buf, rate) {
    let s = toInt16(buf)
    if (rate && rate !== this.rate) s = resample(s, rate, this.rate)
    if (!s.length) return
    const nowS = this.#nowSample()
    const expect = nowS - s.length
    let lane = this.lanes.get(source)
    if (!lane || Math.abs(lane.pos - expect) > this.rate / 2) this.lanes.set(source, (lane = { pos: Math.max(expect, this.base), at: 0 }))
    lane.at = this.now()
    let from = 0
    if (lane.pos < this.base) from = this.base - lane.pos
    const off = lane.pos + from - this.base
    this.#ensure(off + s.length - from)
    for (let i = from; i < s.length; i++) this.acc[off + i - from] += s[i] / 32768
    lane.pos += s.length
    const live = [...this.lanes.values()].filter((l) => this.now() - l.at < 1000)
    // 留 0.3 秒等另一路（两路的块各自隔 100 毫秒左右到），最多压 2 秒
    const upto = Math.max(Math.min(live.length ? Math.min(...live.map((l) => l.pos)) : nowS, nowS - Math.round(this.rate * 0.3)), nowS - 2 * this.rate)
    this.#emit(upto)
  }

  /** 停止：交出到现在为止的全部 */
  end() {
    this.#emit(Math.max(this.#nowSample(), ...[...this.lanes.values()].map((l) => l.pos)))
  }

  #emit(upto) {
    const n = upto - this.base
    if (n <= 0) return
    this.#ensure(n)
    const pcm = new Int16Array(n)
    for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(this.acc[i] * 32767)))
    this.acc.copyWithin(0, n)
    this.acc.fill(0, this.acc.length - n)
    this.base = upto
    this.out(pcm)
  }
}

export class AudioRecording extends EventEmitter {
  /**
   * engine：开会的引擎（state、audio 事件、session）；store：SessionStore；enabled()：这一场要不要录（设置、项目开关）；
   * makeEncoder() → { open({ rate, bitrate, onPacket }), pcm(int16), close() → { head } }（main 里是隐藏窗口，测试里换假的）
   */
  constructor({ engine, store, enabled = () => true, makeEncoder }) {
    super()
    this.engine = engine
    this.store = store
    this.enabled = enabled
    this.makeEncoder = makeEncoder
    this.cur = null
    this.finished = new Map() // 会议 id → 收尾的 Promise
    engine.on('audio', (source, buf, rate) => this.cur?.mixer.push(source, buf, rate))
    engine.on('state', (st) => {
      if (st.state === 'running' && st.sessionId && this.cur?.sessionId !== st.sessionId) this.#start(st)
      if (st.state === 'stopping' && this.cur) {
        const c = this.cur
        this.cur = null
        this.finished.set(c.sessionId, this.#finish(c))
      }
    })
  }

  /** 这一场的录音存好了没有：→ { file, bytes, durationMs } | null（没录、录失败） */
  done(sessionId) {
    return this.finished.get(sessionId) ?? Promise.resolve(null)
  }

  #start(st) {
    if (!this.enabled(st)) return
    let dir
    try {
      dir = this.store.dir(st.sessionId)
    } catch {
      return
    }
    const file = path.join(dir, PACKETS)
    const out = fs.openSync(file, 'a')
    const enc = this.makeEncoder()
    const c = { sessionId: st.sessionId, dir, file, out, enc, failed: null, opened: null }
    c.opened = enc.open({ rate: RATE, bitrate: BITRATE, onPacket: (p) => !c.failed && fs.writeSync(out, packetRecord(p)) }).catch((e) => {
      c.failed = e
      this.emit('error', { sessionId: c.sessionId, message: e.message })
    })
    c.mixer = new Mixer({ startAt: st.startedAt ?? Date.now(), out: (pcm) => !c.failed && enc.pcm(pcm) })
    this.cur = c
  }

  async #finish(c) {
    try {
      c.mixer.end()
      await c.opened
      const r = c.failed ? null : await c.enc.close()
      fs.closeSync(c.out)
      if (c.failed) throw c.failed
      return this.#mux(c.sessionId, c.dir, r?.head)
    } catch (e) {
      try {
        fs.closeSync(c.out)
      } catch {}
      this.emit('error', { sessionId: c.sessionId, message: e.message })
      return null
    }
  }

  #mux(sessionId, dir, head) {
    const packetsFile = path.join(dir, PACKETS)
    const packets = readPackets(packetsFile)
    if (!packets.length) {
      fs.rmSync(packetsFile, { force: true })
      return null
    }
    const webm = muxOpusWebm(packets, { head })
    const tmp = path.join(dir, AUDIO_FILE + '.tmp')
    fs.writeFileSync(tmp, webm)
    fs.renameSync(tmp, path.join(dir, AUDIO_FILE))
    fs.rmSync(packetsFile, { force: true })
    const last = packets.at(-1)
    const audio = { file: AUDIO_FILE, bytes: webm.length, durationMs: Math.round((last.ts + (last.dur || 20000)) / 1000) }
    this.store.mutate(sessionId, (s) => void (s.audio = audio))
    this.emit('saved', { sessionId, ...audio })
    return audio
  }
}
