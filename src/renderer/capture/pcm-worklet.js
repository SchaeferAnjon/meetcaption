// 把输入混成单声道 16 位 PCM，攒够一包（默认 100ms）发给页面。
class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.chunk = options.processorOptions?.chunkSamples ?? 1600
    this.buf = new Int16Array(this.chunk)
    this.n = 0
  }

  process(inputs) {
    const channels = inputs[0]
    if (!channels || !channels.length) return true
    const a = channels[0]
    const b = channels[1]
    for (let i = 0; i < a.length; i++) {
      let v = b ? (a[i] + b[i]) / 2 : a[i]
      v = v > 1 ? 1 : v < -1 ? -1 : v
      this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff
      if (this.n === this.chunk) {
        this.port.postMessage(this.buf.buffer, [this.buf.buffer])
        this.buf = new Int16Array(this.chunk)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('pcm16', Pcm16Processor)
