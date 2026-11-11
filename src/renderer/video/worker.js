'use strict'
// 视频模式的隐藏窗口：用 Chromium 自带的 AudioDecoder 解声音，用 <video> 截画面。
// 主进程（main/video/audio.js、frames.js）发活（video:job），这里做完回（reply）。活：
//   decoder.open { codec, sampleRate, channels, description } → { dec } | { error }
//   decoder.decode { dec, frames: [{ data, timestamp, duration }] } → { pcm: Int16Array（16 kHz 单声道） }
//   decoder.close { dec }
//   （截画面的活在 frames.js）

const RATE = 16000
const decoders = new Map()
let seq = 0

class Dec {
  constructor(cfg) {
    this.mono = [] // 解出来的单声道 Float32Array
    this.srcRate = cfg.sampleRate
    this.error = null
    this.dec = new AudioDecoder({
      output: (d) => this.#take(d),
      error: (e) => (this.error = e),
    })
    this.dec.configure(cfg)
  }

  #take(d) {
    const n = d.numberOfFrames
    const ch = d.numberOfChannels
    this.srcRate = d.sampleRate
    const mono = new Float32Array(n)
    const tmp = new Float32Array(n)
    for (let c = 0; c < ch; c++) {
      d.copyTo(tmp, { planeIndex: c, format: 'f32-planar' })
      for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch
    }
    d.close()
    this.mono.push(mono)
  }

  async decode(frames, last) {
        for (const f of frames) this.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.timestamp, duration: f.duration, data: f.data }))
    await this.dec.flush()
    if (this.error) throw this.error
    const total = this.mono.reduce((n, x) => n + x.length, 0)
    const all = new Float32Array(total)
    let o = 0
    for (const x of this.mono) (all.set(x, o), (o += x.length))
    this.mono = []
    const rs = await resample(all, this.srcRate)
    return toPcm16(rs)
  }

  close() {
    try {
      this.dec.close()
    } catch {}
  }
}

async function resample(x, rate) {
  if (!x.length || rate === RATE) return x
  const len = Math.max(1, Math.round((x.length * RATE) / rate))
  const ctx = new OfflineAudioContext(1, len, RATE)
  const buf = ctx.createBuffer(1, x.length, rate)
  buf.copyToChannel(x, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  src.start()
  return (await ctx.startRendering()).getChannelData(0)
}

function toPcm16(f) {
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)))
  return out
}

const jobs = {
  async 'decoder.open'(j) {
    const cfg = { codec: j.codec, sampleRate: j.sampleRate, numberOfChannels: j.channels }
    if (j.description) cfg.description = j.description
    if (typeof AudioDecoder === 'undefined') return { error: 'no-webcodecs' }
    const s = await AudioDecoder.isConfigSupported(cfg).catch(() => ({ supported: false }))
    if (!s.supported) return { error: 'unsupported', codec: j.codec }
    const id = ++seq
    decoders.set(id, new Dec(cfg))
    return { dec: id }
  },
  async 'decoder.decode'(j) {
    const d = decoders.get(j.dec)
    if (!d) return { error: 'closed' }
    return { pcm: await d.decode(j.frames) }
  },
  async 'decoder.close'(j) {
    decoders.get(j.dec)?.close()
    decoders.delete(j.dec)
    return {}
  },
}

window.videoJobs = jobs

window.videoBridge.onJob(async (job) => {
  let result
  try {
    result = await window.videoJobs[job.op](job)
  } catch (e) {
    result = { error: String(e?.message ?? e) }
  }
  window.videoBridge.reply(job.id, result)
})
