// 一路音频最近 N 秒的 PCM16 环形缓冲。位置按「从第一次写入起的毫秒数」算，和门限、识别事件里的 span 是同一条时间线。

function asInt16(buf) {
  if (buf instanceof Int16Array) return buf
  const u8 = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf)
  const n = u8.byteLength >> 1
  return u8.byteOffset % 2 === 0 ? new Int16Array(u8.buffer, u8.byteOffset, n) : new Int16Array(u8.slice(0, n * 2).buffer)
}

export class AudioRing {
  constructor(sampleRate, seconds = 60) {
    this.rate = sampleRate
    this.buf = new Int16Array(Math.round(sampleRate * seconds))
    this.total = 0 // 一共写进来多少样本
  }

  /** 写进来的总时长（毫秒）。 */
  get ms() {
    return (this.total * 1000) / this.rate
  }

  write(pcm) {
    let x = asInt16(pcm)
    const cap = this.buf.length
    if (x.length > cap) {
      this.total += x.length - cap
      x = x.subarray(x.length - cap)
    }
    const at = this.total % cap
    const first = Math.min(x.length, cap - at)
    this.buf.set(x.subarray(0, first), at)
    if (first < x.length) this.buf.set(x.subarray(first), 0)
    this.total += x.length
  }

  /** 取 [startMs, endMs) 这一段，超出保留范围的部分裁掉；什么都没有返回 null。 */
  read(startMs, endMs) {
    const cap = this.buf.length
    const lo = Math.max(Math.round((startMs * this.rate) / 1000), this.total - cap, 0)
    const hi = Math.min(Math.round((endMs * this.rate) / 1000), this.total)
    if (hi <= lo) return null
    const out = new Int16Array(hi - lo)
    const a = lo % cap
    const first = Math.min(out.length, cap - a)
    out.set(this.buf.subarray(a, a + first), 0)
    if (first < out.length) out.set(this.buf.subarray(0, out.length - first), first)
    return out
  }
}
