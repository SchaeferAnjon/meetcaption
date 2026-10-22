// 能量门限：只在有人说话时把音频送去识别，停顿处切句。
// 阈值跟着底噪走（底噪 +10 dB，最低 -60 dBFS），宁可多送也不漏掉小声说话。
// 位置都按「从第一次 push 起的样本数」算，切句时带上这一段的起止，声纹要按它回头取音频。

export function dbfs(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  const rms = Math.sqrt(sum / Math.max(samples.length, 1)) / 32768
  return rms > 0 ? 20 * Math.log10(rms) : -100
}

export class SpeechGate {
  constructor({ sampleRate, frameMs = 20, preRollMs = 400, endSilenceMs = 800, maxTurnMs = 45_000 } = {}) {
    this.frameSamples = Math.round((sampleRate * frameMs) / 1000)
    this.frameMs = frameMs
    this.preRollFrames = Math.ceil(preRollMs / frameMs)
    this.endSilenceMs = endSilenceMs
    this.maxTurnMs = maxTurnMs
    this.pending = new Int16Array(0)
    this.preRoll = []
    this.floor = -90
    this.speaking = false
    this.silenceMs = 0
    this.turnMs = 0
    this.heardSomething = false
    this.base = 0 // pending[0] 的绝对样本位置
    this.turnStart = 0
  }

  /** 正在说的这一段 { start, end }（样本位置，end 是目前处理到的地方）；没在说话返回 null。 */
  openTurn() {
    return this.speaking ? { start: this.turnStart, end: this.base } : null
  }

  /** 输入 PCM16 单声道；返回按顺序执行的操作（送音频 / 切句）和这批里最大的电平。 */
  push(buf) {
    const input =
      buf.byteOffset % 2 === 0
        ? new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1)
        : new Int16Array(Uint8Array.prototype.slice.call(buf, 0, buf.byteLength & ~1).buffer)
    const all = new Int16Array(this.pending.length + input.length)
    all.set(this.pending)
    all.set(input, this.pending.length)
    const ops = []
    let out = []
    const flush = () => {
      if (out.length) ops.push({ audio: Buffer.from(concat(out).buffer) })
      out = []
    }
    let level = -100
    let off = 0
    for (; off + this.frameSamples <= all.length; off += this.frameSamples) {
      const at = this.base + off
      const frame = all.slice(off, off + this.frameSamples)
      const db = dbfs(frame)
      level = Math.max(level, db)
      if (db > -70) this.heardSomething = true
      this.floor = db < this.floor ? Math.max(db, -90) : this.floor + 0.02
      const isSpeech = db > Math.max(this.floor + 10, -60)
      if (!this.speaking) {
        if (isSpeech) {
          this.speaking = true
          this.silenceMs = 0
          this.turnMs = 0
          this.turnStart = at - this.preRoll.length * this.frameSamples
          out.push(...this.preRoll, frame)
          this.preRoll = []
        } else {
          this.preRoll.push(frame)
          if (this.preRoll.length > this.preRollFrames) this.preRoll.shift()
        }
        continue
      }
      out.push(frame)
      this.turnMs += this.frameMs
      this.silenceMs = isSpeech ? 0 : this.silenceMs + this.frameMs
      if (this.silenceMs >= this.endSilenceMs) {
        this.speaking = false
        flush()
        ops.push({ endTurn: true, start: this.turnStart, end: at + this.frameSamples })
      } else if (this.turnMs >= this.maxTurnMs && (this.silenceMs >= 200 || this.turnMs >= this.maxTurnMs + 15_000)) {
        // 一口气说太久没停顿，找个短停顿强制切一句，免得一句话越拖越长；再过 15 秒还找不到停顿（背景一直有声音）就硬切。
        this.turnMs = 0
        flush()
        ops.push({ endTurn: true, start: this.turnStart, end: at + this.frameSamples })
        this.turnStart = at + this.frameSamples
      }
    }
    flush()
    this.base += off
    this.pending = all.slice(off)
    return { ops, level }
  }
}

function concat(frames) {
  const n = frames.reduce((a, f) => a + f.length, 0)
  const out = new Int16Array(n)
  let o = 0
  for (const f of frames) {
    out.set(f, o)
    o += f.length
  }
  return out
}
