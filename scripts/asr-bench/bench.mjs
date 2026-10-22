// 本地识别模型实测（评测结果见 docs/本地识别模型评测.md）。都在 scripts/asr-bench 里跑：
//   python3 fetch.py ami earnings ascend      取真实录音拼成 data/*.wav 和参考文本
//   ./get.sh <sherpa 模型包名>                下载解压到 models/（Windows 用 get.ps1 -Names a,b）
//   node bench.mjs <模型> <数据集> [线程数=2] [语言]
//   node volcbench.mjs <数据集>                豆包 2.0 基准（要 VOLC_ASR_APP_ID、VOLC_ASR_ACCESS_TOKEN）
//   python3 -m venv venv && venv/bin/pip install jiwer whisper-normalizer && venv/bin/python score.py
// 升级 sherpa-onnx 后跑一遍 xasr-480，尤其在 M4 上（ORT 升级曾让 zipformer 流式在 M4 上出乱码）。
// 流式模型按 100ms 一包喂，记每个字从说出到出现在屏幕上的延迟；非流式模型用 silero VAD 切句、每句整句解码，
// 另外量 2/5/10 秒缓冲整段重解码要多久（判断能不能靠反复重解码做「边说边出字」）。结果写 out/<模型>__<数据集>__t<线程>.json
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const require = createRequire(import.meta.url)
const sherpa = require(process.env.SHERPA_PATH || 'sherpa-onnx-node')

const [name, dataset, threadsArg, langArg] = process.argv.slice(2)
const threads = Number(threadsArg || 2)
const M = path.join(here, 'models')
const f = (d, x) => path.join(M, d, x)

const tr = (d, t = 'int8.') => ({ transducer: { encoder: f(d, `encoder.${t}onnx`), decoder: f(d, `decoder.${t}onnx`), joiner: f(d, `joiner.${t}onnx`) }, tokens: f(d, 'tokens.txt') })

const MODELS = {
  'nemotron35-160': { kind: 'online', dir: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-2026-06-11', cfg: (d) => tr(d), langOption: true },
  'nemotron35-560': { kind: 'online', dir: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11', cfg: (d) => tr(d), langOption: true },
  'xasr-160': { kind: 'online', dir: 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05', cfg: (d) => xasr(d) },
  'xasr-480': { kind: 'online', dir: 'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05', cfg: (d) => xasr(d) },
  'nemotron-en-560': { kind: 'online', dir: 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25', cfg: (d) => tr(d) },
  'nemotron-en-160': { kind: 'online', dir: 'sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25', cfg: (d) => tr(d) },
  'parakeet-unified-560': { kind: 'online', dir: 'sherpa-onnx-nemo-parakeet-unified-en-0.6b-int8-streaming-560ms', cfg: (d) => tr(d) },
  'kroko-en': { kind: 'online', dir: 'sherpa-onnx-streaming-zipformer-en-kroko-2025-08-06', cfg: (d) => tr(d, '') },
  'sensevoice-2024': { kind: 'offline', dir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17', cfg: (d, lang) => ({ senseVoice: { model: f(d, 'model.int8.onnx'), language: lang || 'auto', useInverseTextNormalization: 1 }, tokens: f(d, 'tokens.txt') }) },
  'parakeet-v2': { kind: 'offline', dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8', cfg: (d) => ({ ...tr(d), modelType: 'nemo_transducer' }) },
  'parakeet-v3': { kind: 'offline', dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', cfg: (d) => ({ ...tr(d), modelType: 'nemo_transducer' }) },
  sensevoice: { kind: 'offline', dir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09', cfg: (d, lang) => ({ senseVoice: { model: f(d, 'model.int8.onnx'), language: lang || 'auto', useInverseTextNormalization: 1 }, tokens: f(d, 'tokens.txt') }) },
  'moonshine-en': { kind: 'offline', dir: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27', cfg: (d) => moonshine(d) },
  'moonshine-zh': { kind: 'offline', dir: 'sherpa-onnx-moonshine-base-zh-quantized-2026-02-27', cfg: (d) => moonshine(d) },
  'firered2-ctc': { kind: 'offline', dir: 'sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25', cfg: (d) => ({ fireRedAsrCtc: { model: pick(d, /\.onnx$/) }, tokens: f(d, 'tokens.txt') }) },
}

const xasr = (d) => ({ transducer: { encoder: f(d, 'encoder.int8.onnx'), decoder: f(d, 'decoder.onnx'), joiner: f(d, 'joiner.int8.onnx') }, tokens: f(d, 'tokens.txt') })

function pick(d, re) {
  const hit = fs.readdirSync(path.join(M, d)).filter((x) => re.test(x)).sort((a, b) => (/int8/.test(b) ? 1 : 0) - (/int8/.test(a) ? 1 : 0))
  if (!hit.length) throw new Error(`${d} 里没有 ${re}`)
  return path.join(M, d, hit[0])
}

function moonshine(d) {
  const files = fs.readdirSync(path.join(M, d))
  const has = (re) => files.find((x) => re.test(x))
  const c = { moonshine: {}, tokens: f(d, 'tokens.txt') }
  if (has(/preprocess/)) c.moonshine.preprocessor = pick(d, /preprocess/)
  c.moonshine.encoder = pick(d, /encode/)
  if (has(/uncached/)) c.moonshine.uncachedDecoder = pick(d, /uncached/)
  if (has(/^cached/)) c.moonshine.cachedDecoder = pick(d, /^cached/)
  if (has(/merged/)) c.moonshine.mergedDecoder = pick(d, /merged/)
  return c
}

function readWav(file) {
  const w = sherpa.readWave(file)
  if (w.sampleRate !== 16000) throw new Error(`${file} 不是 16k`)
  return w.samples
}

const m = MODELS[name]
if (!m) throw new Error(`没有模型 ${name}，可选：${Object.keys(MODELS).join(' ')}`)
const samples = readWav(path.join(here, 'data', `${dataset}.wav`))
const dur = samples.length / 16000
const lang = langArg || ''
const rss0 = process.memoryUsage().rss

const out = { model: name, dataset, threads, lang, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0].model, audioSec: +dur.toFixed(2) }

if (m.kind === 'online') {
  const t0 = performance.now()
  const rec = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...m.cfg(m.dir), numThreads: threads, provider: 'cpu', debug: 0, ...(process.env.HOTWORDS ? { modelingUnit: 'cjkchar+bpe', bpeVocab: f(m.dir, 'bpe.vocab') } : {}) },
    decodingMethod: process.env.HOTWORDS ? 'modified_beam_search' : 'greedy_search',
    maxActivePaths: 4,
    ...(process.env.HOTWORDS ? { hotwordsFile: process.env.HOTWORDS, hotwordsScore: Number(process.env.HOTSCORE || 2) } : {}),
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 0.8,
    rule3MinUtteranceLength: 20,
  })
  const s = rec.createStream()
  if (m.langOption && lang) s.setOption('language', lang)
  out.loadMs = Math.round(performance.now() - t0)
  out.rssMB = Math.round((process.memoryUsage().rss - rss0) / 1048576)
  const chunk = 1600
  let compute = 0
  let maxChunkMs = 0
  let seen = 0
  let lastLen = 0
  const finals = []
  const delays = []
  let sample0 = null
  const step = (buf, audioNow) => {
    s.acceptWaveform({ samples: buf, sampleRate: 16000 })
    const t = performance.now()
    while (rec.isReady(s)) rec.decode(s)
    const dt = performance.now() - t
    compute += dt
    maxChunkMs = Math.max(maxChunkMs, dt)
    const r = rec.getResult(s)
    if (!sample0) sample0 = r
    const ts = r.timestamps ?? []
    const base = r.start_time ?? r.startTime ?? 0
    if (ts.length < seen) seen = ts.length
    // 新出的字：屏幕上出现的时刻（这一包送完 + 解码耗时）减去它在音频里的时间
    for (let k = seen; k < ts.length; k++) delays.push(audioNow + dt / 1000 - (base + ts[k]))
    seen = ts.length
    if ((r.text ?? '').length !== lastLen) lastLen = (r.text ?? '').length
    if (rec.isEndpoint(s)) {
      if (r.text?.trim()) finals.push({ text: r.text.trim(), at: +audioNow.toFixed(2) })
      rec.reset(s)
      seen = 0
    }
  }
  for (let i = 0; i < samples.length; i += chunk) step(samples.subarray(i, i + chunk), Math.min(samples.length, i + chunk) / 16000)
  step(new Float32Array(16000), dur + 1)
  s.inputFinished()
  while (rec.isReady(s)) rec.decode(s)
  const last = rec.getResult(s)
  if (last.text?.trim()) finals.push({ text: last.text.trim(), at: +(dur + 1).toFixed(2) })
  out.rtf = +(compute / 1000 / dur).toFixed(3)
  out.maxChunkMs = Math.round(maxChunkMs)
  const d = delays.filter((x) => x > -1).sort((a, b) => a - b)
  out.tokenDelay = d.length ? { p50: +d[Math.floor(d.length * 0.5)].toFixed(2), p90: +d[Math.floor(d.length * 0.9)].toFixed(2), n: d.length } : null
  out.sampleResultKeys = sample0 ? Object.keys(sample0) : []
  out.finals = finals
  out.hyp = finals.map((x) => x.text).join(' ')
} else {
  const t0 = performance.now()
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...m.cfg(m.dir, lang), numThreads: threads, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
  })
  out.loadMs = Math.round(performance.now() - t0)
  out.rssMB = Math.round((process.memoryUsage().rss - rss0) / 1048576)
  const vad = new sherpa.Vad({ sileroVad: { model: path.join(M, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 15, windowSize: 512 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 60)
  const decode = (buf) => {
    const st = rec.createStream()
    st.acceptWaveform({ samples: buf, sampleRate: 16000 })
    const t = performance.now()
    rec.decode(st)
    const ms = performance.now() - t
    return { text: rec.getResult(st).text.trim(), ms }
  }
  // 预热一次（第一次解码要分配内存）
  decode(samples.subarray(0, 16000 * 2))
  let compute = 0
  const finals = []
  const W = 512
  const drain = (audioNow) => {
    while (!vad.isEmpty()) {
      const seg = vad.front()
      vad.pop()
      const segStart = seg.start / 16000
      const segEnd = segStart + seg.samples.length / 16000
      const r = decode(seg.samples)
      compute += r.ms
      // 这一句最后一个字说完到整句文字出来：VAD 等停顿 + 解码
      finals.push({ text: r.text, start: +segStart.toFixed(2), end: +segEnd.toFixed(2), lag: +(audioNow - segEnd + r.ms / 1000).toFixed(2), decodeMs: Math.round(r.ms) })
    }
  }
  for (let i = 0; i + W <= samples.length; i += W) {
    vad.acceptWaveform(samples.subarray(i, i + W))
    drain((i + W) / 16000)
  }
  vad.flush()
  drain(dur)
  out.rtf = +(compute / 1000 / dur).toFixed(3)
  const lags = finals.map((x) => x.lag).sort((a, b) => a - b)
  out.finalLag = lags.length ? { p50: lags[Math.floor(lags.length / 2)], p90: lags[Math.floor(lags.length * 0.9)] } : null
  // 反复重解码正在说的这一句要多久：2 / 5 / 10 秒的缓冲
  out.redecodeMs = {}
  for (const sec of [2, 5, 10]) {
    const off = Math.min(samples.length - sec * 16000, 16000 * 20)
    const runs = [0, 1, 2].map(() => decode(samples.subarray(off, off + sec * 16000)).ms)
    out.redecodeMs[`${sec}s`] = Math.round(runs.sort((a, b) => a - b)[1])
  }
  out.finals = finals
  out.hyp = finals.map((x) => x.text).join(' ')
}

fs.mkdirSync(path.join(here, 'out'), { recursive: true })
const file = path.join(here, 'out', `${name}__${dataset}__t${threads}${lang ? `__${lang}` : ''}.json`)
fs.writeFileSync(file, JSON.stringify(out, null, 1))
const brief = { ...out }
delete brief.finals
brief.hyp = brief.hyp.slice(0, 160)
console.log(JSON.stringify(brief))
