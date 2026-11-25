'use strict'
// 录音的编码器（隐藏窗口）：主进程送来混好的 16 位单声道 PCM，WebCodecs AudioEncoder 编成 Opus，一包一包交回主进程（main/canvas/audioRec.js 封成 WebM）。
// 编码器不收 16 kHz 时升到 48 kHz 再编。
const bridge = window.opusBridge
let enc = null
let rate = 16000
let encRate = 16000
let ts = 0 // 下一块的时间戳（微秒）
let head = null
let sent = 0
let error = null

function up(f32, k) {
  if (k === 1) return f32
  const out = new Float32Array(f32.length * k)
  for (let i = 0; i < out.length; i++) {
    const x = i / k
    const a = Math.floor(x)
    const b = Math.min(a + 1, f32.length - 1)
    out[i] = f32[a] + (f32[b] - f32[a]) * (x - a)
  }
  return out
}

window.openEncoder = async ({ rate: r, bitrate }) => {
  try {
    rate = r
    const cfg = (sr) => ({ codec: 'opus', sampleRate: sr, numberOfChannels: 1, bitrate })
    encRate = (await AudioEncoder.isConfigSupported(cfg(r))).supported ? r : 48000
    if (!(await AudioEncoder.isConfigSupported(cfg(encRate))).supported) return { ok: false, error: 'opus not supported' }
    enc = new AudioEncoder({
      output: (chunk, meta) => {
        const d = meta?.decoderConfig?.description
        if (d && !head) head = Array.from(d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength))
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        sent++
        bridge.packet(chunk.timestamp, chunk.duration ?? 0, data)
      },
      error: (e) => (error = String(e?.message ?? e)),
    })
    enc.configure(cfg(encRate))
    return { ok: true, encRate }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

bridge.onPcm((data) => {
  if (!enc || error) return
  const pcm = new Int16Array(data.slice().buffer)
  if (!pcm.length) return
  const f = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768
  const k = encRate / rate
  const x = up(f, k)
  const ad = new AudioData({ format: 'f32', sampleRate: encRate, numberOfFrames: x.length, numberOfChannels: 1, timestamp: ts, data: x })
  ts += (pcm.length * 1e6) / rate
  enc.encode(ad)
  ad.close()
})

window.closeEncoder = async () => {
  if (enc && !error) await enc.flush()
  enc?.close()
  enc = null
  return { ok: !error, error, head, sent }
}
