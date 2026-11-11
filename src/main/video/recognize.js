import fs from 'node:fs/promises'
import WebSocket from 'ws'
import { LocalStreamASR } from '../asr/local.js'
import { sonioxHints } from '../asr/soniox.js'
import { readPcm, RATE } from './audio.js'
import { t } from '../i18n.js'

// 视频模式的识别：把读好的 PCM 文件认成一句一句带起止时间的字。
// 本地识别（X-ASR，约 20 倍速）一条通道从头送到尾；
// 云识别用 Soniox 的实时接口（会员经我们服务器换临时 Key；自带 Key 就是自己的）。实时接口只按约 1.1 倍速收音频（2026-11 实测
// 40 秒的音频连着送完要 35 秒），一路认两小时的视频要近两小时，所以把音频在停顿处切成约 4 分钟一块，几路同时认，再按时间拼回来。
// 输出：[{ startMs, endMs, text }]，时间是视频里的毫秒。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

/* ---------------- 本地 ---------------- */

/** pcmFile：16 kHz 单声道 16 位。onProgress(已认到的毫秒)。 */
export async function recognizeLocal({ pcmFile, durationMs, fromMs = 0, toMs = durationMs, onProgress, signal, createAsr = () => new LocalStreamASR() }) {
  const asr = createAsr()
  const out = []
  let lastEnd = fromMs
  asr.on('final', (e) => {
    const text = String(e.text ?? '').trim()
    if (!text) return
    const startMs = fromMs + (e.span?.start ?? Math.max(0, lastEnd - fromMs))
    const endMs = Math.max(startMs + 200, fromMs + (e.span?.end ?? startMs - fromMs + 1000))
    out.push({ startMs, endMs, text })
    lastEnd = endMs
  })
  let acked = 0
  asr.on('progress', (n) => (acked = n))
  await asr.connect()
  const fh = await fs.open(pcmFile, 'r')
  try {
    const step = 2 * 1000
    let sent = 0
    for (let at = fromMs; at < toMs; at += step) {
      if (signal?.aborted) throw aborted()
      const pcm = await readPcm(pcmFile, at, Math.min(toMs, at + step), fh)
      if (!pcm.length) break
      // 认得比送得慢就等一等，不要把两小时的音频一下子塞进识别进程
      while (sent - acked > RATE * 30) {
        if (signal?.aborted) throw aborted()
        await sleep(15)
      }
      asr.sendAudio(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      sent += pcm.length
      onProgress?.(Math.min(toMs, fromMs + Math.round(((acked || sent) / RATE) * 1000)))
    }
  } finally {
    await fh.close()
    await asr.close()
  }
  onProgress?.(toMs)
  return out
}

/* ---------------- 云（Soniox） ---------------- */

/** 在 aroundMs 前后 radiusMs 里找最安静的 200 毫秒，从那里下刀，不把一个字劈成两半。 */
export async function quietCut(pcmFile, aroundMs, radiusMs = 20_000, fh = null) {
  const from = Math.max(0, aroundMs - radiusMs)
  const pcm = await readPcm(pcmFile, from, aroundMs + radiusMs, fh)
  const win = Math.round(RATE * 0.2)
  let best = { at: aroundMs, e: Infinity }
  for (let o = 0; o + win <= pcm.length; o += win >> 1) {
    let e = 0
    for (let i = o; i < o + win; i += 4) e += pcm[i] * pcm[i]
    // 离目标位置越远越吃亏一点点，同样安静时取近的
    e *= 1 + Math.abs(from + ((o + win / 2) / RATE) * 1000 - aroundMs) / 1e6
    if (e < best.e) best = { at: Math.round(from + ((o + win / 2) / RATE) * 1000), e }
  }
  return best.at
}

/** 把 [0, durationMs) 切成约 chunkMs 一块，刀口落在停顿上。→ [{ from, to }] */
export async function planChunks(pcmFile, durationMs, chunkMs = 240_000) {
  const n = Math.max(1, Math.round(durationMs / chunkMs))
  if (n === 1) return [{ from: 0, to: durationMs }]
  const fh = await fs.open(pcmFile, 'r')
  try {
    const cuts = [0]
    for (let i = 1; i < n; i++) {
      const target = Math.round((durationMs * i) / n)
      const cut = await quietCut(pcmFile, target, Math.min(20_000, chunkMs / 4), fh)
      cuts.push(Math.max(cuts.at(-1) + 5000, Math.min(durationMs - 5000, cut)))
    }
    cuts.push(durationMs)
    return cuts.slice(0, -1).map((from, i) => ({ from, to: cuts[i + 1] }))
  } finally {
    await fh.close()
  }
}

class Fatal extends Error {}

function describe(code, message) {
  if (code === 401) return t(`Soniox 的 Key 无效（401）：{0}`, message)
  if (code === 402) return t(`Soniox 账户余额不足（402）：{0}`, message)
  if (code === 400) return t(`Soniox 拒绝了识别参数（400）：{0}`, message)
  return t(`Soniox 出错（{0}）：{1}`, code, message)
}

/**
 * 认一块 [from, to)：连一条连接把这一块音频尽快送过去（Soniox 约 1.1 倍速收），按 <end> 出一句一句。
 * 连接断了（Key 到点、断网）从最后一句定稿的终点换新连接接着送。
 * key：自带的 Key；getKey：async () => { key, maxMs, model }（会员）。url 单测里换成假服务器。
 */
export async function recognizeChunk({ pcmFile, from, to, key = '', getKey = null, url = 'wss://stt-rt.soniox.com/transcribe-websocket', language = 'en', context = '', hotwords = [], signal, onTick, tries = 5 }) {
  const out = []
  let resumeAt = from
  let attempt = 0
  while (resumeAt < to) {
    if (signal?.aborted) throw aborted()
    try {
      const got = await oneConnection({ pcmFile, from: resumeAt, to, key, getKey, url, language, context, hotwords, signal, onTick })
      out.push(...got.sentences)
      resumeAt = got.reachedEnd ? to : Math.max(resumeAt + 1000, got.resumeAt)
      attempt = got.sentences.length ? 0 : attempt
      if (got.reachedEnd) break
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof Fatal || e.code === 'exhausted' || e.code === 'idle' || e.code === 'ended' || e.code === 'bad-session') throw e
      if (e.partial) {
        out.push(...e.partial.sentences)
        resumeAt = Math.max(resumeAt + 1000, e.partial.resumeAt)
      }
      // 会员服务器说连接太多、太频繁：等前面的 Key 过期腾出来
      const wait = e.code === 'too-many' || e.code === 'too-fast' ? 8000 : Math.min(15_000, 1000 * 2 ** attempt)
      if (++attempt >= tries) throw e
      await sleep(wait)
    }
  }
  return out
}

async function oneConnection({ pcmFile, from, to, key, getKey, url, language, context, hotwords, signal, onTick }) {
  let model = 'stt-rt-v5'
  let maxMs = Infinity
  if (getKey) {
    const k = await getKey()
    key = k.key
    model = k.model ?? model
    maxMs = k.maxMs ?? maxMs
  }
  if (!key) throw new Fatal(t('还没填 Soniox 的 API Key，去「设置 → 语音识别」里填'))
  const sentences = []
  let cur = { text: '', start: null, end: null }
  let lastFinalEnd = from // 视频里的毫秒
  let finished = false
  let failure = null
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 15_000 })
  const closed = new Promise((resolve) => {
    ws.on('close', () => resolve())
    ws.on('error', (e) => {
      failure ??= e
      resolve()
    })
    ws.on('unexpected-response', (_r, res) => {
      failure ??= new Error(t(`连接 Soniox 失败（HTTP {0}）`, res.statusCode))
      resolve()
    })
  })
  const flushSentence = () => {
    const text = cur.text.trim()
    if (text && cur.start != null) {
      const s = { startMs: from + cur.start, endMs: from + Math.max(cur.end ?? cur.start, cur.start + 200), text }
      sentences.push(s)
      lastFinalEnd = s.endMs
    }
    cur = { text: '', start: null, end: null }
  }
  ws.on('message', (raw) => {
    let m
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (m.error_code) {
      // 400、401、402 自带 Key 时自己好不了；403 是临时 Key 的时长到了，其余换连接再来
      failure ??= [400, 401, 402].includes(m.error_code) && !getKey ? new Fatal(describe(m.error_code, m.error_message ?? '')) : new Error(describe(m.error_code, m.error_message ?? ''))
      return
    }
    for (const tk of m.tokens ?? []) {
      if (tk.text === '<end>' || tk.text === '<fin>') {
        flushSentence()
        continue
      }
      if (!tk.is_final) continue
      cur.text += tk.text
      if (tk.start_ms != null) cur.start ??= tk.start_ms
      if (tk.end_ms != null) cur.end = tk.end_ms
    }
    if (typeof m.total_audio_proc_ms === 'number') onTick?.(from + m.total_audio_proc_ms)
    if (m.finished) finished = true
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    closed.then(() => reject(failure ?? new Error(t('连不上 Soniox'))))
  })
  const config = { model, audio_format: 'pcm_s16le', sample_rate: RATE, num_channels: 1, language_hints: sonioxHints(language), enable_endpoint_detection: true, max_endpoint_delay_ms: 1000 }
  const terms = hotwords.filter(Boolean).slice(0, 100)
  const text = String(context ?? '').trim().slice(0, 2000)
  if (terms.length || text) config.context = { ...(text ? { text } : {}), ...(terms.length ? { terms } : {}) }
  ws.send(JSON.stringify(config))
  const deadline = Date.now() + maxMs - 20_000 // Key 到点前主动收尾，已经定稿的字不丢
  const fh = await fs.open(pcmFile, 'r')
  let at = from
  let reachedEnd = false
  try {
    const step = 5000
    while (at < to && !failure && !signal?.aborted) {
      if (Date.now() > deadline) break
      const pcm = await readPcm(pcmFile, at, Math.min(to, at + step), fh)
      if (!pcm.length) break
      // 别让本地发送缓冲堆太大：服务器只按 1.1 倍速收
      while (ws.bufferedAmount > 1_500_000 && !failure && !signal?.aborted) await sleep(50)
      if (ws.readyState !== WebSocket.OPEN) break
      ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
      at += (pcm.length / RATE) * 1000
    }
    reachedEnd = at >= to - 50
    if (ws.readyState === WebSocket.OPEN && !signal?.aborted) {
      ws.send('')
      // 等收尾：Soniox 把手上的字都定稿再回 finished；最多等音频积压的时间加几秒
      const t0 = Date.now()
      while (!finished && !failure && ws.readyState === WebSocket.OPEN && Date.now() - t0 < 120_000 && !signal?.aborted) await sleep(100)
    }
  } finally {
    await fh.close()
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate()
    await closed
  }
  if (signal?.aborted) throw aborted()
  flushSentence() // 连接收尾时没定稿的尾巴不要（下一条连接从 lastFinalEnd 重新认）
  if (failure instanceof Fatal) throw failure
  // 没等到 finished 就是连接断了（Key 到点、断网）：交给上面从最后一句的终点换新连接接着认
  if (!finished) throw Object.assign(failure ?? new Error(t('Soniox 连接断开了')), { partial: { sentences, resumeAt: lastFinalEnd } })
  return { sentences, reachedEnd, resumeAt: lastFinalEnd }
}

/**
 * 云识别整个文件：切块，parallel 路同时认，拼回来按时间排。
 * onProgress(已认到的毫秒，各块加起来)。→ [{ startMs, endMs, text }]
 */
export async function recognizeCloud({ pcmFile, durationMs, parallel = 3, chunkMs = 240_000, onProgress, signal, ...opts }) {
  const chunks = await planChunks(pcmFile, durationMs, chunkMs)
  const done = new Array(chunks.length).fill(0) // 每块已认到的毫秒数
  const results = new Array(chunks.length)
  let next = 0
  let broken = false // 一块认不下去就别再开新的
  const report = () => onProgress?.(done.reduce((a, b) => a + b, 0), chunks.length)
  const worker = async () => {
    while (next < chunks.length && !broken && !signal?.aborted) {
      const i = next++
      const { from, to } = chunks[i]
      results[i] = await recognizeChunk({
        ...opts,
        pcmFile,
        from,
        to,
        signal,
        onTick: (ms) => {
          done[i] = Math.max(done[i], Math.min(to, ms) - from)
          report()
        },
      })
      done[i] = to - from
      report()
    }
  }
  const failures = []
  await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, () => worker().catch((e) => (broken = true, failures.push(e)))))
  if (signal?.aborted) throw aborted()
  if (failures.length) throw failures[0]
  return results.flat().sort((a, b) => a.startMs - b.startMs)
}
