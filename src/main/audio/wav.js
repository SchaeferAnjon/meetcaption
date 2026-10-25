import fs from 'node:fs'
import { pcm16ToFloat32, resample } from './voiceprint.js'
import { t } from '../i18n.js'

// 读 16 位 PCM 的 WAV（自测用的假音源、从文件注册声纹）。多声道混成单声道，按需重采样。

export function readWav(file) {
  const b = fs.readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(t(`{0} 不是 WAV 文件`, file))
  let fmt = null
  let o = 12
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4)
    const size = b.readUInt32LE(o + 4)
    const body = o + 8
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) }
    else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error(t(`{0} 要是 16 位 PCM（say -o x.wav --data-format=LEI16@16000）`, file))
      const bytes = Math.min(size, b.length - body) & ~1
      const all = new Int16Array(b.buffer.slice(b.byteOffset + body, b.byteOffset + body + bytes))
      const ch = fmt.channels || 1
      const samples = ch === 1 ? all : Int16Array.from({ length: Math.floor(all.length / ch) }, (_, i) => {
        let s = 0
        for (let c = 0; c < ch; c++) s += all[i * ch + c]
        return Math.round(s / ch)
      })
      return { samples, sampleRate: fmt.rate, seconds: samples.length / fmt.rate }
    }
    o = body + size + (size & 1)
  }
  throw new Error(t(`{0} 里没有音频数据`, file))
}

/** 读成指定采样率的 PCM16。 */
export function readWavAt(file, rate) {
  const w = readWav(file)
  if (w.sampleRate === rate) return w.samples
  const f = resample(pcm16ToFloat32(w.samples), w.sampleRate, rate)
  const out = new Int16Array(f.length)
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32768)))
  return out
}

/**
 * 用 WAV 文件冒充采集（接口同 RendererCapture）：{ system?, mic? } 两路同时按实时速度喂，每 100ms 一包。
 * 自测和开发时用（--fake-system / --fake-mic，或 MEETCAPTION_FAKE_SYSTEM / MEETCAPTION_FAKE_MIC），不开任何真实设备。
 */
export class WavCapture {
  constructor(files) {
    this.files = files
    this.timers = []
    this.pos = {} // 每一路放到第几个样本：暂停后再 start 接着放
  }

  async start({ system, mic, sampleRate, onPcm }) {
    this.stop()
    const t0 = Date.now()
    for (const [source, on] of [['system', system], ['mic', mic]]) {
      const file = this.files[source]
      if (!on || typeof file !== 'string') continue
      const data = readWavAt(file, sampleRate)
      const base = this.pos[source] ?? 0
      let off = base
      const timer = setInterval(() => {
        const due = Math.min(data.length, base + Math.round(((Date.now() - t0) * sampleRate) / 1000))
        if (due > off) {
          onPcm(source, Buffer.from(data.buffer, data.byteOffset + off * 2, (due - off) * 2))
          off = this.pos[source] = due
        }
        if (off >= data.length) clearInterval(timer)
      }, 100)
      this.timers.push(timer)
    }
    return t0
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }
}
