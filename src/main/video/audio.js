import fs from 'node:fs/promises'
import { MediaError } from './demux.js'
import { t } from '../i18n.js'

// 把视频里的声音读成 16 kHz 单声道 16 位 PCM，写进一个临时文件（两小时约 230 MB，处理完删掉）。
// 先落成文件有三个好处：本地识别和云识别、说话人分段都能按位置随便读；云识别切块时能在停顿处下刀；取消和重试不用重新解码。
// 帧按约 12 秒一批交给隐藏窗口里的 AudioDecoder（worker.js），读下一批和解上一批同时进行。

const BATCH_US = 12_000_000
export const RATE = 16000

/**
 * media：demux.openMedia 的结果；out：PCM 文件路径；worker：VideoWorker。
 * onProgress(解到的毫秒)；signal 取消。→ { samples }
 */
export async function extractAudio(media, out, { worker, onProgress, signal } = {}) {
  const a = media.audio
  const opened = await worker.call('decoder.open', { codec: a.codec, sampleRate: a.sampleRate, channels: a.channels, description: a.description ?? null })
  if (opened.error) {
    throw new MediaError('audio-unsupported', t(`这个文件的声音是 {0} 格式，读不出来`, a.codec), { codecLabel: a.codec })
  }
  const fh = await fs.open(out, 'w')
  let samples = 0
  try {
    // 声音不是从第 0 秒开始的（有些 webm、mkv）：前面补静音，和画面对得上
    const lead = Math.round((media.timeOf(0) / 1e6) * RATE)
    if (lead > RATE / 10) {
      await fh.write(new Uint8Array(lead * 2))
      samples += lead
    }
    const batches = []
    for (let i = 0; i < a.count; ) {
      let j = i
      let us = 0
      while (j < a.count && us < BATCH_US) us += media.endOf(j) - media.timeOf(j++)
      batches.push([i, j])
      i = j
    }
    let next = batches.length ? media.readFrames(...batches[0]) : null
    for (let b = 0; b < batches.length; b++) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const frames = await next
      next = b + 1 < batches.length ? media.readFrames(...batches[b + 1]) : null
      const r = await worker.call('decoder.decode', { dec: opened.dec, frames })
      if (r.error) throw new MediaError('decode', t(`声音解不出来：{0}`, r.error))
      if (r.pcm?.length) {
        await fh.write(new Uint8Array(r.pcm.buffer, r.pcm.byteOffset, r.pcm.byteLength))
        samples += r.pcm.length
      }
      onProgress?.(Math.round((samples / RATE) * 1000))
    }
  } finally {
    await worker.call('decoder.close', { dec: opened.dec }).catch(() => {})
    await fh.close()
  }
  return { samples }
}

/** 读 PCM 文件里 [fromMs, toMs) 那一段。→ Int16Array */
export async function readPcm(file, fromMs, toMs, fh = null) {
  const own = !fh
  fh ??= await fs.open(file, 'r')
  try {
    const start = Math.max(0, Math.round((fromMs * RATE) / 1000))
    const n = Math.max(0, Math.round(((toMs - fromMs) * RATE) / 1000))
    const buf = Buffer.alloc(n * 2)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start * 2)
    return new Int16Array(buf.buffer, buf.byteOffset, bytesRead >> 1)
  } finally {
    if (own) await fh.close()
  }
}
