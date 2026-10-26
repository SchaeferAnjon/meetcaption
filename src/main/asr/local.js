import { EventEmitter } from 'node:events'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { voiceprintPaths } from '../audio/voiceprint.js'
import { t } from '../i18n.js'

// 本地识别（X-ASR，免费、不联网、不用 Key）。识别在 utilityProcess 里跑（localHost.cjs），
// 对方和我两路共用一个进程、一份模型；进程开一次常驻，下一场会直接用。不在 Electron 里（单测）时在进程内跑。
// 对外和豆包、OpenAI 一样：connect / sendAudio / close，事件 partial / final({ key, text, span })。

const require = createRequire(import.meta.url)
const core = require('./localCore.cjs')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..', '..', '..')

// 送进去的音频比认完的多出这么多，就提醒一次电脑跟不上
const LAG_WARN_SAMPLES = core.SAMPLE_RATE * 4

/** 模型文件夹（四个文件都在才算），找不到为 null。 */
export function localModelDir() {
  const custom = process.env.MEETCAPTION_ASR_MODEL_DIR
  if (custom && core.missingModelFiles(custom).length === 0) return custom
  const res = process.resourcesPath
  const list = [res && path.join(res, 'models', 'xasr'), path.join(APP_ROOT, 'resources', 'models', 'xasr')]
  return list.find((d) => d && core.missingModelFiles(d, { checkSize: true }).length === 0) ?? null
}

export function localAsrAvailable() {
  return Boolean(localModelDir() && voiceprintPaths().native)
}

function initMessage() {
  const native = voiceprintPaths().native
  if (!native) throw Object.assign(new Error(t('本地识别组件缺失：找不到 sherpa-onnx，请重新安装')), { code: 'no-native' })
  const modelDir = localModelDir()
  if (!modelDir) throw Object.assign(new Error(t('本地识别模型缺失，请重新安装')), { code: 'no-model' })
  return { type: 'init', native, modelDir, numThreads: 1 }
}

/** 在 utilityProcess 里跑。start() 可以反复调，进程只开一次；进程没了下次 start() 重开。 */
class UtilityHost {
  constructor() {
    this.child = null
    this.ready = null
    this.channels = new Map() // ch → { onEvents, onCrash, finishing }
  }

  start() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const init = initMessage()
      const { utilityProcess } = await import('electron')
      const child = utilityProcess.fork(path.join(HERE, 'localHost.cjs'), [], { serviceName: 'MeetCaption Local ASR', stdio: process.env.MEETCAPTION_DEBUG ? 'inherit' : 'ignore' })
      this.child = child
      await new Promise((resolve, reject) => {
        const onMessage = (m) => {
          if (m?.type === 'ready') resolve()
          else if (m?.type === 'error' && !m.ch) reject(Object.assign(new Error(m.message), { code: m.code }))
        }
        child.on('message', onMessage)
        child.once('exit', (code) => reject(new Error(t(`本地识别模型加载失败，文件可能损坏，请重新安装（进程退出码 {0}）`, code))))
        child.on('message', (m) => this.#route(m))
        child.postMessage(init)
      })
      child.on('exit', (code) => this.#lost(child, code))
    })()
    this.ready.catch(() => {
      this.ready = null
      this.child?.kill()
      this.child = null
    })
    return this.ready
  }

  #route(m) {
    const h = this.channels.get(m?.ch)
    if (!h) return
    if (m.type === 'events') h.onEvents(m.events, m.samples)
    else if (m.type === 'finished') {
      this.channels.delete(m.ch)
      h.finishing?.(m.events)
    } else if (m.type === 'error') h.onError?.(new Error(m.message))
  }

  #lost(child, code) {
    if (this.child !== child) return
    this.child = null
    this.ready = null
    const list = [...this.channels.values()]
    this.channels.clear()
    for (const h of list) {
      h.finishing?.([])
      h.onCrash?.(code)
    }
  }

  open(ch, handlers) {
    this.channels.set(ch, handlers)
    this.child?.postMessage({ type: 'open', ch, keyPrefix: handlers.keyPrefix })
  }

  audio(ch, pcm) {
    // 只拷这一包：Buffer 常常是一大块内存（整段 WAV、Node 的缓冲池）上的一个视图，直接发会把整块都拷过去
    this.child?.postMessage({ type: 'audio', ch, pcm: new Uint8Array(pcm) })
  }

  finish(ch) {
    const h = this.channels.get(ch)
    if (!h || !this.child) return Promise.resolve([])
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.channels.delete(ch)
        resolve([])
      }, 5000)
      h.finishing = (events) => {
        clearTimeout(timer)
        resolve(events)
      }
      this.child.postMessage({ type: 'finish', ch })
    })
  }

  stop() {
    this.child?.kill()
    this.child = null
    this.ready = null
  }
}

/** 不在 Electron 里（单测、命令行）：同一个进程里直接认，事件放到下一轮事件循环再发，和子进程一样是异步的。 */
class InlineHost {
  constructor() {
    this.rec = null
    this.channels = new Map()
  }

  start() {
    if (!this.rec) {
      const init = initMessage()
      this.rec = core.createRecognizer(require(init.native), init.modelDir, { numThreads: init.numThreads })
    }
    return Promise.resolve()
  }

  open(ch, handlers) {
    this.channels.set(ch, { handlers, channel: new core.LocalChannel(this.rec, { keyPrefix: handlers.keyPrefix }) })
  }

  audio(ch, pcm) {
    const c = this.channels.get(ch)
    if (!c) return
    const events = c.channel.accept(pcm)
    const samples = c.channel.samples
    setImmediate(() => c.handlers.onEvents(events, samples))
  }

  finish(ch) {
    const c = this.channels.get(ch)
    this.channels.delete(ch)
    return new Promise((resolve) => setImmediate(() => resolve(c ? c.channel.finish() : [])))
  }

  stop() {}
}

let host = null
const inElectron = () => Boolean(process.versions.electron) && process.type === 'browser' && !process.env.MEETCAPTION_LOCAL_ASR_INLINE

export function localHost() {
  if (!host) host = inElectron() ? new UtilityHost() : new InlineHost()
  return host
}

/** 应用启动时先把模型加载好（后台进程里，不卡界面），开会时不用再等两三秒。 */
export function prewarmLocalAsr() {
  if (!localAsrAvailable()) return Promise.resolve(false)
  return localHost()
    .start()
    .then(() => true)
    .catch(() => false)
}

export function stopLocalAsr() {
  host?.stop()
}

let seq = 0

export class LocalStreamASR extends EventEmitter {
  sampleRate = core.SAMPLE_RATE

  constructor({ host: h } = {}) {
    super()
    this.host = h ?? localHost()
    this.ch = `c${++seq}`
    this.total = 0 // 送出去的样本数
    this.chanStart = 0 // 这条识别通道从第几个样本开始（进程重开后换新通道，span 要加上它）
    this.warned = false
    this.backlog = 0 // 接手时一次补进来的样本数（云识别断线期间的音频）：这部分本来就要追，不算跟不上
    this.closed = false
    this.open = null // 最后一个还没定稿的段 { key, text, span }：进程崩了就把它当定稿，字不丢
    this.crashes = []
  }

  #emit(e) {
    const off = (this.chanStart * 1000) / core.SAMPLE_RATE
    const span = e.span ? { start: e.span.start + off, end: e.span.end + off } : null
    const out = { key: e.key, text: e.text, span }
    if (e.type === 'partial') this.open = out
    else if (this.open?.key === e.key) this.open = null
    this.emit(e.type, out)
  }

  #handlers() {
    return {
      keyPrefix: `${this.ch}-`,
      onEvents: (events, samples) => {
        for (const e of events) this.#emit(e)
        if (!this.warned && samples != null && this.total - this.chanStart - samples > LAG_WARN_SAMPLES + this.backlog) {
          this.warned = true
          this.emit('warn', '电脑太忙，本地识别跟不上，字幕会慢一些。可以关掉别的程序，或者在「设置 → 语音识别」里换成豆包或 OpenAI。')
        }
      },
      onError: (e) => this.emit('warn', `本地识别出错：${e.message}`),
      onCrash: (code) => this.#recover(code),
    }
  }

  async connect() {
    await this.host.start()
    // 等模型加载的时候已经停止了（开始后马上点停止）：不再开通道，不然通道一直留着
    if (this.closed) return
    this.host.open(this.ch, this.#handlers())
  }

  // 识别进程意外退出：已经出了字的这一段当定稿，重开进程接着认；60 秒里崩了 3 次或者重开不了才停
  async #recover(code) {
    if (this.closed) return
    if (this.open) {
      const last = this.open
      this.open = null
      this.emit('final', last)
    }
    const now = Date.now()
    this.crashes = [...this.crashes.filter((t) => now - t < 60_000), now]
    if (this.crashes.length >= 3) {
      this.emit('fatal', new Error(t(`本地识别一分钟里意外退出了 {0} 次（退出码 {1}），先停下了。可以在「设置 → 语音识别」里换成豆包或 OpenAI`, this.crashes.length, code)))
      return
    }
    this.emit('status', 'reconnecting')
    try {
      await this.host.start()
      if (this.closed) return
      this.ch = `c${++seq}`
      this.chanStart = this.total
      this.host.open(this.ch, this.#handlers())
      this.emit('status', 'ready')
    } catch (e) {
      this.emit('fatal', new Error(t(`本地识别停止了（进程退出码 {0}）：{1}`, code, e.message)))
    }
  }

  sendAudio(buf) {
    if (this.closed || !buf?.length) return
    this.total += buf.length >> 1
    this.host.audio(this.ch, buf)
  }

  /** 先补一段积下来的音频（云识别断线期间的），再接着 sendAudio。 */
  catchUp(bufs) {
    for (const b of bufs) {
      this.backlog += b.length >> 1
      this.sendAudio(b)
    }
  }

  endTurn() {}

  async close() {
    if (this.closed) return
    this.closed = true
    const events = await this.host.finish(this.ch).catch(() => [])
    for (const e of events) this.#emit(e)
  }
}
