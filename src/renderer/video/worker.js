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

// ---------------- 截画面 ----------------
// 一节课的视频：先每隔几秒跳到那个时间点取一张亮度小图（160 × 90），整段取完交给 changes.js 找出翻页的时间点，
// 再跳回这些时间点截大图（一节课几十张）。找翻页的办法见 changes.js。

const SIG_W = 160
const SIG_H = 90

function lumaOf(ctx) {
  const d = ctx.getImageData(0, 0, SIG_W, SIG_H).data
  const out = new Uint8Array(SIG_W * SIG_H)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2])
  return out
}

function seekTo(v, t) {
  return new Promise((resolve, reject) => {
    const done = () => (v.removeEventListener('seeked', done), v.removeEventListener('error', fail), resolve())
    const fail = () => (v.removeEventListener('seeked', done), v.removeEventListener('error', fail), reject(new Error('video seek failed')))
    v.addEventListener('seeked', done)
    v.addEventListener('error', fail)
    v.currentTime = t
  })
}

jobs['frames.scan'] = async (j) => {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.src = j.url
  await new Promise((resolve, reject) => {
    v.addEventListener('loadeddata', resolve, { once: true })
    v.addEventListener('error', () => reject(new Error(v.error?.message || 'video load failed')), { once: true })
  })
  if (!v.videoWidth) return { error: 'no-picture' }
  const dur = (j.durationMs || v.duration * 1000) / 1000
  const step = Math.max(j.stepSec || 3, dur / 2500)
  const small = document.createElement('canvas')
  small.width = SIG_W
  small.height = SIG_H
  const sctx = small.getContext('2d', { willReadFrequently: true })
  const big = document.createElement('canvas')
  const scale = Math.min(1, (j.maxWidth || 1280) / v.videoWidth)
  big.width = Math.round(v.videoWidth * scale)
  big.height = Math.round(v.videoHeight * scale)
  const bctx = big.getContext('2d')
  const sigs = []
  const last = Math.max(0, dur - 0.05)
  for (let t = 0; t < dur; t += step) {
    await seekTo(v, Math.min(t, last))
    sctx.drawImage(v, 0, 0, SIG_W, SIG_H)
    sigs.push(lumaOf(sctx))
    if (sigs.length % 20 === 0) window.videoBridge.event(j.id, { type: 'progress', atMs: Math.round(t * 1000), of: 0.9 })
  }
  const { picks, masked } = window.videoChanges.findChanges(sigs, { w: SIG_W, h: SIG_H, stepSec: step, minGapSec: j.minGapSec || 8 })
  const chosen = picks.slice(0, j.max || 150)
  let count = 0
  for (const k of chosen) {
    const t = Math.min(k * step, last)
    await seekTo(v, t)
    bctx.drawImage(v, 0, 0, big.width, big.height)
    const blob = await new Promise((r) => big.toBlob(r, 'image/jpeg', 0.82))
    window.videoBridge.event(j.id, { type: 'frame', atMs: Math.round(k * step * 1000), jpeg: new Uint8Array(await blob.arrayBuffer()) })
    count++
  }
  v.removeAttribute('src')
  v.load()
  return { count, samples: sigs.length, masked }
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
