'use strict'
// 本地识别的核心：sherpa-onnx 流式识别（X-ASR 中英文带标点，480ms 块）。不依赖 Electron，
// 主进程通过 localHost.cjs 放在 utilityProcess 里跑；单测和没有 Electron 的自测直接在进程内用。
//
// 一路声音一条 stream，一直不断：sherpa 判断到 0.8 秒停顿（rule2）就把这一段定稿、reset，接着认下一段，
// reset 不丢已经送进去还没解码的音频。X-ASR 的句末标点常常要等下一段开口才出来，落在下一段开头，
// 这里把段首的标点去掉；中文标点后面、汉字之间的空格也去掉。

const fs = require('node:fs')
const path = require('node:path')

const SAMPLE_RATE = 16000
// 模型文件：Resources/models/xasr（打包后）或 resources/models/xasr（开发）
const MODEL_FILES = { encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' }
// 随安装包带的那份模型每个文件的大小：文件不完整时 onnxruntime 会直接让进程退出，先按大小挡掉
const MODEL_BYTES = { 'encoder.int8.onnx': 155278641, 'decoder.onnx': 11309084, 'joiner.int8.onnx': 2581422, 'tokens.txt': 58806 }
const MODEL_ID = 'x-asr-zh-en-punct-480ms-int8-2026-06-05'

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff'
const CJK_PUNCT = '，。？！、；：“”‘’（）《》…'
const LEAD_PUNCT = new RegExp(`^[\\s${CJK_PUNCT},.?!;:]+`)
const SPACE_AFTER_CJK_PUNCT = new RegExp(`([${CJK_PUNCT}])\\s+`, 'g')
const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g')
const SPACE_BEFORE_PUNCT = new RegExp(`\\s+([${CJK_PUNCT},.?!;:])`, 'g')

/** 模型吐出来的文字整理成能直接显示的：去段首标点、中文里多余的空格、标点前的空格。 */
function cleanText(raw) {
  return String(raw ?? '')
    .replace(LEAD_PUNCT, '')
    .replace(SPACE_AFTER_CJK_PUNCT, '$1')
    .replace(SPACE_BETWEEN_CJK, '$1')
    .replace(SPACE_BEFORE_PUNCT, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function modelFiles(dir) {
  const out = {}
  for (const [k, f] of Object.entries(MODEL_FILES)) out[k] = path.join(dir, f)
  return out
}

/** 缺的或大小不对的文件。checkSize：随安装包带的模型按大小核对；自己指定的模型文件夹（MEETCAPTION_ASR_MODEL_DIR）不核对。 */
function missingModelFiles(dir, { checkSize = false } = {}) {
  if (!dir) return Object.values(MODEL_FILES)
  return Object.values(MODEL_FILES).filter((f) => {
    const p = path.join(dir, f)
    if (!fs.existsSync(p)) return true
    return checkSize && fs.statSync(p).size !== MODEL_BYTES[f]
  })
}

/**
 * 加载识别器。addon 是 sherpa-onnx.node（require 进来的原生模块），同一个识别器可以开多条 stream（对方、我各一条）。
 * numThreads 1 就够：480ms 块的 X-ASR 在 M4 和 Ryzen 上单线程都只要实时的 5% 到 13%。
 */
function createRecognizer(addon, modelDir, { numThreads = 1 } = {}) {
  const missing = missingModelFiles(modelDir)
  if (missing.length) {
    const e = new Error(`本地识别模型缺失（${missing.join('、')}），请重新安装`)
    e.code = 'no-model'
    throw e
  }
  const f = modelFiles(modelDir)
  const handle = addon.createOnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
      tokens: f.tokens,
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 1,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 0.8,
    // 一直没有 0.8 秒停顿时的兜底，可能切在词中间。平常超过 15 秒就在句末标点处切（见 LocalChannel），
    // 那种切法不 reset，这个时长从上一次停顿算起，所以放得很宽
    rule3MinUtteranceLength: 300,
  })
  return { addon, handle }
}

// 一个字大概多长：span 的终点取最后一个字的起点再往后一点
const TAIL_S = 0.25
// 一段话超过这么多秒还没停顿（讲课常这样），就在下一个句末标点处先定稿前半段
const SOFT_SPLIT_S = 15
const SENT_END = /^[.?!。？！]$/
const isWord = (t) => {
  const w = String(t).trim()
  return Boolean(w) && !LEAD_PUNCT.test(w)
}
// 模型的 token 带着前导空格表示一个新词（汉字每个都带），拼起来就是 sherpa 给的 text
const joinTokens = (tokens) => tokens.join('')

// 从后往前找最后一个能切的句末标点：后面已经跟着一个新词的开头（排除 3.5 这种小数点），前面至少有几个字
function lastSentenceEnd(tokens, from) {
  for (let i = tokens.length - 2; i >= from + 3; i--) {
    if (!SENT_END.test(String(tokens[i]).trim())) continue
    const next = String(tokens[i + 1])
    if (next.startsWith(' ') && isWord(next)) return i
  }
  return -1
}

/**
 * 一路声音。accept(PCM16 Buffer) / finish() 返回这次产生的事件：
 * { type: 'partial' | 'final', key, text, span: { start, end } }，span 是这一段在这一路音频里的毫秒位置（从第一个样本算起）。
 */
class LocalChannel {
  constructor(rec, { keyPrefix = 'L' } = {}) {
    this.rec = rec
    this.stream = rec.addon.createOnlineStream(rec.handle)
    this.keyPrefix = keyPrefix
    this.n = 0
    this.lastText = ''
    this.samples = 0
    this.finished = false
    this.committed = 0 // 这条 stream 当前结果里，前面已经定稿出去的 token 数（长段落在句末切过）
  }

  #key() {
    return `${this.keyPrefix}${this.n}`
  }

  #decode() {
    const { addon, handle } = this.rec
    while (addon.isOnlineStreamReady(handle, this.stream)) addon.decodeOnlineStream(handle, this.stream)
  }

  #result() {
    return JSON.parse(this.rec.addon.getOnlineStreamResultAsJson(this.rec.handle, this.stream))
  }

  // tokens[from, to) 里第一个、最后一个不是标点的字的时间（毫秒，相对这一路开头）
  static span(r, from = 0, to = (r.tokens ?? []).length) {
    const tokens = r.tokens ?? []
    const ts = r.timestamps ?? []
    const base = Number(r.start_time) || 0
    let a = from
    while (a < to && !isWord(tokens[a])) a++
    let b = to - 1
    while (b >= from && !isWord(tokens[b])) b--
    if (a >= to || b < from || ts[a] == null || ts[b] == null) return null
    return { start: Math.round((base + ts[a]) * 1000), end: Math.round((base + ts[b] + TAIL_S) * 1000) }
  }

  #collect(events, endpoint) {
    const r = this.#result()
    const tokens = r.tokens ?? []
    const ts = r.timestamps ?? []
    if (this.committed > tokens.length) this.committed = 0
    // 长段落：前半段在句末标点处先定稿，stream 不 reset（reset 会丢掉已经认出来的后半截），后面的字接着算这一段
    if (!endpoint && ts[this.committed] != null && ts.at(-1) - ts[this.committed] > SOFT_SPLIT_S) {
      const k = lastSentenceEnd(tokens, this.committed)
      if (k >= 0) {
        const head = cleanText(joinTokens(tokens.slice(this.committed, k + 1)))
        if (head) {
          events.push({ type: 'final', key: this.#key(), text: head, span: LocalChannel.span(r, this.committed, k + 1) })
          this.n++
        }
        this.committed = k + 1
        this.lastText = ''
      }
    }
    const text = cleanText(this.committed ? joinTokens(tokens.slice(this.committed)) : r.text)
    const span = LocalChannel.span(r, this.committed)
    if (text && text !== this.lastText) {
      this.lastText = text
      if (!endpoint) events.push({ type: 'partial', key: this.#key(), text, span })
    }
    if (endpoint) {
      if (text) events.push({ type: 'final', key: this.#key(), text, span })
      if (text) this.n++
      this.lastText = ''
      this.committed = 0
      this.rec.addon.reset(this.rec.handle, this.stream)
    }
  }

  /** 送一包 16k 单声道 16 位 PCM。 */
  accept(pcm16) {
    const events = []
    if (this.finished || !pcm16?.length) return events
    const n = pcm16.length >> 1
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) x[i] = pcm16.readInt16LE(i * 2) / 32768
    this.samples += n
    this.rec.addon.acceptWaveformOnline(this.stream, { samples: x, sampleRate: SAMPLE_RATE })
    this.#decode()
    this.#collect(events, this.rec.addon.isEndpoint(this.rec.handle, this.stream))
    return events
  }

  /** 收尾：补一小段静音让最后一个块算完，最后一段定稿。 */
  finish() {
    const events = []
    if (this.finished) return events
    this.finished = true
    const { addon } = this.rec
    addon.acceptWaveformOnline(this.stream, { samples: new Float32Array(Math.round(SAMPLE_RATE * 0.6)), sampleRate: SAMPLE_RATE })
    addon.inputFinished(this.stream)
    this.#decode()
    this.#collect(events, true)
    return events
  }
}

module.exports = { SAMPLE_RATE, MODEL_FILES, MODEL_ID, cleanText, missingModelFiles, createRecognizer, LocalChannel }
