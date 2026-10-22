import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// 声纹：sherpa-onnx（Node-API 预编译，Electron 里不用重编）+ 3D-Speaker CAM++ 中英文说话人向量模型。
// 开发时 .node 从 node_modules/sherpa-onnx-<平台>-<架构> 加载，模型在 resources/models；
// 打包后两者都在 Resources 目录（electron-builder 的 extraResources），不进 asar，原生代码才能按路径读。

export const SAMPLE_RATE = 16000
export const MODEL_FILE = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
export const MODEL_ID = 'campplus-zh_en-16k-common_advanced'
const MODEL_BYTES = 28281164
export const MIN_ENROLL_SECONDS = 6
const MIN_EMBED_SECONDS = 0.5
const TOO_QUIET_DB = -45

const require = createRequire(import.meta.url)
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function platformTag() {
  return `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
}

function firstExisting(list) {
  return list.find((p) => p && fs.existsSync(p)) ?? null
}

/** 模型和原生库的实际路径（找不到为 null），自测和出错提示用。 */
export function voiceprintPaths() {
  const res = process.resourcesPath
  let devNative = null
  try {
    devNative = require.resolve(`sherpa-onnx-${platformTag()}/sherpa-onnx.node`)
  } catch {}
  return {
    model: firstExisting([
      process.env.MEETCAPTION_VOICEPRINT_MODEL,
      res && path.join(res, 'models', MODEL_FILE),
      path.join(APP_ROOT, 'resources', 'models', MODEL_FILE),
    ]),
    native: firstExisting([res && path.join(res, 'sherpa-onnx', 'sherpa-onnx.node'), devNative]),
  }
}

function fail(code, message, cause) {
  const e = new Error(message, cause ? { cause } : undefined)
  e.code = code
  return e
}

let loading = null

/** 加载一次，之后复用。embed 是同步的原生调用，8 秒音频几十毫秒。 */
export function loadVoiceprintModel({ numThreads = 1 } = {}) {
  if (loading) return loading
  loading = (async () => {
    const { model, native } = voiceprintPaths()
    if (!native) throw fail('no-native', `声纹组件缺失：找不到 sherpa-onnx（${platformTag()}）`)
    if (!model) throw fail('no-model', `声纹模型缺失：找不到 ${MODEL_FILE}`)
    // 模型文件不完整时 onnxruntime 会直接 abort 整个进程，先看大小
    if (!process.env.MEETCAPTION_VOICEPRINT_MODEL && fs.statSync(model).size !== MODEL_BYTES) {
      throw fail('no-model', '声纹模型文件不完整，请重新安装')
    }
    let addon
    try {
      addon = require(native)
    } catch (e) {
      throw fail('no-native', `声纹组件加载失败：${e.message}`, e)
    }
    const handle = addon.createSpeakerEmbeddingExtractor({ model, numThreads, debug: 0, provider: 'cpu' })
    const dim = addon.speakerEmbeddingExtractorDim(handle)
    return {
      dim,
      modelId: MODEL_ID,
      embed(samples) {
        const x = samples instanceof Float32Array ? samples : Float32Array.from(samples)
        if (x.length < MIN_EMBED_SECONDS * SAMPLE_RATE) throw fail('too-short', '音频太短，算不了声纹')
        const stream = addon.speakerEmbeddingExtractorCreateStream(handle)
        addon.acceptWaveformOnline(stream, { samples: x, sampleRate: SAMPLE_RATE })
        addon.inputFinished(stream)
        if (!addon.speakerEmbeddingExtractorIsReady(handle, stream)) throw fail('too-short', '音频太短，算不了声纹')
        // 第三个参数 false：拷贝一份返回。Electron 不允许原生模块返回外部内存的 ArrayBuffer。
        return normalize(addon.speakerEmbeddingExtractorComputeEmbedding(handle, stream, false))
      },
    }
  })()
  const p = loading
  p.catch(() => {
    if (loading === p) loading = null // 失败了下次再试
  })
  return p
}

function normalize(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

export function cosine(a, b) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** PCM16 小端（Buffer / Uint8Array / ArrayBuffer / Int16Array）转 [-1, 1) 的 Float32Array；奇数字节偏移也能处理。 */
export function pcm16ToFloat32(buf) {
  let i16
  if (buf instanceof Int16Array) i16 = buf
  else {
    const u8 = ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf)
    const n = u8.byteLength >> 1
    i16 = u8.byteOffset % 2 === 0 ? new Int16Array(u8.buffer, u8.byteOffset, n) : new Int16Array(u8.slice(0, n * 2).buffer)
  }
  const out = new Float32Array(i16.length)
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768
  return out
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b]
  return a
}

const kernels = new Map()

// 多相加窗 sinc：L/M 有理数重采样，降采样时截止频率跟着降，防混叠。每个相位的核预先算好。
function polyphase(L, M, halfTaps) {
  const key = `${L}/${M}/${halfTaps}`
  if (kernels.has(key)) return kernels.get(key)
  const scale = Math.min(1, L / M)
  const half = Math.ceil(halfTaps / scale)
  const taps = 2 * half
  const table = new Float32Array(L * taps)
  for (let k = 0; k < L; k++) {
    let sum = 0
    for (let j = 0; j < taps; j++) {
      const t = j - half + 1 - k / L // 输入样本 base + (j - half + 1) 到输出位置的距离
      const u = scale * t
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)
      const r = t / half
      const win = Math.abs(r) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * r) + 0.08 * Math.cos(2 * Math.PI * r)
      const w = sinc * win
      table[k * taps + j] = w
      sum += w
    }
    for (let j = 0; j < taps; j++) table[k * taps + j] /= sum
  }
  const kernel = { table, taps, half }
  kernels.set(key, kernel)
  return kernel
}

export function resample(float32, fromRate, toRate, { halfTaps = 16 } = {}) {
  const x = float32 instanceof Float32Array ? float32 : Float32Array.from(float32)
  if (fromRate === toRate) return x.slice()
  const g = gcd(fromRate, toRate)
  const L = toRate / g
  const M = fromRate / g
  const { table, taps, half } = polyphase(L, M, halfTaps)
  const out = new Float32Array(Math.ceil((x.length * L) / M))
  for (let n = 0; n < out.length; n++) {
    const pos = n * M
    const base = Math.floor(pos / L)
    const k = pos - base * L
    const start = base - half + 1
    let acc = 0
    const row = k * taps
    for (let j = 0; j < taps; j++) {
      const i = start + j
      if (i >= 0 && i < x.length) acc += x[i] * table[row + j]
    }
    out[n] = acc
  }
  return out
}

function frameDb(x, from, n) {
  let s = 0
  for (let i = from; i < from + n; i++) s += x[i] * x[i]
  const rms = Math.sqrt(s / n)
  return rms > 0 ? 20 * Math.log10(rms) : -100
}

function percentile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : -100
}

/**
 * 能量门限去掉静音段，只留说话的帧（前后各多留 pad 帧，免得切掉辅音）。
 * 门限 = max(-50 dBFS, min(底噪 +10 dB, 最响的帧 -15 dB), 最响的帧 -30 dB)：
 * 整段都在说话（没有静音可当底噪）时，离最响 15 dB 以内的帧总会留下。返回 { samples, seconds, peakDb, floorDb }。
 */
export function trimSilence(x, { sampleRate = SAMPLE_RATE, frameMs = 30, pad = 2 } = {}) {
  const n = Math.round((sampleRate * frameMs) / 1000)
  const frames = Math.floor(x.length / n)
  const db = new Float32Array(frames)
  for (let f = 0; f < frames; f++) db[f] = frameDb(x, f * n, n)
  const sorted = Array.from(db).sort((a, b) => a - b)
  const floorDb = percentile(sorted, 0.1)
  const peakDb = percentile(sorted, 0.95)
  const thr = Math.max(-50, Math.min(floorDb + 10, peakDb - 15), peakDb - 30)
  const keep = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) {
    if (db[f] <= thr) continue
    for (let g = Math.max(0, f - pad); g <= Math.min(frames - 1, f + pad); g++) keep[g] = 1
  }
  let kept = 0
  for (let f = 0; f < frames; f++) kept += keep[f]
  const samples = new Float32Array(kept * n)
  let o = 0
  for (let f = 0; f < frames; f++) {
    if (!keep[f]) continue
    samples.set(x.subarray(f * n, f * n + n), o)
    o += n
  }
  return { samples, seconds: samples.length / sampleRate, peakDb, floorDb }
}

/**
 * 从一段 16k 录音注册声纹：去静音，有效语音不少于 6 秒。
 * 按 3 秒一段分别算向量再取平均：实测对 1 到 3 秒的短句更稳，中英文混读注册时两种语言都照顾到。
 */
export function enrollFrom(float32At16k, model) {
  const { samples, seconds, peakDb } = trimSilence(float32At16k)
  if (peakDb < TOO_QUIET_DB) throw fail('too-quiet', '声音太小，没听到说话。请检查麦克风，离近一点再录一次。')
  if (seconds < MIN_ENROLL_SECONDS) {
    throw fail('too-short', `有效语音只有 ${seconds.toFixed(1)} 秒，至少要 ${MIN_ENROLL_SECONDS} 秒。请连续多读几句再录一次。`)
  }
  const chunk = 3 * SAMPLE_RATE
  const count = Math.floor(samples.length / chunk)
  const sum = new Float32Array(model.dim)
  for (let i = 0; i < count; i++) {
    const v = model.embed(samples.subarray(i * chunk, i === count - 1 ? samples.length : (i + 1) * chunk))
    for (let j = 0; j < sum.length; j++) sum[j] += v[j]
  }
  return { embedding: normalize(sum), modelId: model.modelId, seconds: Math.round(seconds * 10) / 10, createdAt: Date.now() }
}

/**
 * 给一段 16k 音频打分：去静音后和注册的声纹比余弦相似度。
 * 有效语音不到 minSeconds 秒、或声纹是别的模型录的，返回 null（判不了，调用方按没有声纹处理）。
 */
export function scoreSegment(model, profile, float32At16k, { minSeconds = 1 } = {}) {
  if (!profile?.embedding || profile.modelId !== model.modelId) return null
  const { samples, seconds } = trimSilence(float32At16k)
  if (seconds < Math.max(minSeconds, MIN_EMBED_SECONDS)) return null
  return { score: cosine(profile.embedding, model.embed(samples)), seconds }
}

/** 声纹存档：userData/voiceprint.json，0600，先写临时文件再改名。 */
export class VoiceprintStore {
  constructor(file) {
    this.file = file
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const e = d?.embedding
      if (!Array.isArray(e) || !e.length || !e.every(Number.isFinite)) return null
      return {
        embedding: Float32Array.from(e),
        modelId: String(d.modelId ?? ''),
        seconds: Number(d.seconds) || 0,
        createdAt: Number(d.createdAt) || null,
      }
    } catch {
      return null
    }
  }

  save(profile) {
    const data = {
      version: 1,
      modelId: profile.modelId,
      seconds: profile.seconds,
      createdAt: profile.createdAt ?? Date.now(),
      embedding: Array.from(profile.embedding, (v) => Math.round(v * 1e6) / 1e6),
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  clear() {
    fs.rmSync(this.file, { force: true })
  }
}

/** 给 --selftest=voiceprint 用：加载模型，对 2 秒合成音算一次向量。 */
export async function voiceprintSelfTest() {
  const paths = voiceprintPaths()
  const t0 = performance.now()
  try {
    const model = await loadVoiceprintModel()
    const loadMs = Math.round(performance.now() - t0)
    const x = new Float32Array(2 * SAMPLE_RATE)
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * (150 + (i / x.length) * 250) * i) / SAMPLE_RATE)
    const t1 = performance.now()
    const v = model.embed(x)
    const embedMs = Math.round(performance.now() - t1)
    const ok = v.length === model.dim && Math.abs(cosine(v, v) - 1) < 1e-4
    return { ok, modelId: model.modelId, dim: model.dim, loadMs, embedMs, platform: platformTag(), paths }
  } catch (e) {
    return { ok: false, error: e.message, code: e.code, platform: platformTag(), paths }
  }
}
