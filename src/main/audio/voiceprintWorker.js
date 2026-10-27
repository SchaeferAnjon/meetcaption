import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODEL_ID, embedPcm, loadVoiceprintModel, voiceprintPaths } from './voiceprint.js'

// 开会时给麦克风打分用的声纹模型。加载（一两秒）和每段的向量计算（Rosetta 下一两百毫秒、一场会上百次）都是同步的 CPU 活，
// 放在主进程里会让主窗口和字幕窗卡住，所以放在 utilityProcess（voiceprintHost.cjs）里，主进程只收发消息。
// 应用启动后在后台先加载好（prewarmVoiceprint），开会时不用再等。不在 Electron 里（单测）时在进程内算。
// 对外的模型：{ modelId, scorePcm(pcm16, rate) → Promise<{ embedding, seconds } | null> }。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REQUEST_TIMEOUT_MS = 15_000

class UtilityHost {
  constructor() {
    this.child = null
    this.ready = null
    this.pending = new Map() // id → { resolve, reject, timer }
    this.seq = 0
  }

  start() {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const { native, model } = voiceprintPaths()
      if (!native) throw Object.assign(new Error('声纹组件缺失：找不到 sherpa-onnx'), { code: 'no-native' })
      if (!model) throw Object.assign(new Error('声纹模型缺失，请重新安装'), { code: 'no-model' })
      const { utilityProcess } = await import('electron')
      const child = utilityProcess.fork(path.join(HERE, 'voiceprintHost.cjs'), [], { serviceName: 'MeetCaption Voiceprint', stdio: process.env.MEETCAPTION_DEBUG ? 'inherit' : 'ignore' })
      this.child = child
      await new Promise((resolve, reject) => {
        child.on('message', (m) => {
          if (m?.type === 'ready') resolve()
          else if (m?.type === 'error') reject(Object.assign(new Error(m.message), { code: m.code }))
          else this.#route(m)
        })
        child.once('exit', (code) => reject(new Error(`声纹模型加载失败，文件可能损坏，请重新安装（进程退出码 ${code}）`)))
        child.postMessage({ type: 'init', native, model })
      })
      child.on('exit', () => this.#lost(child))
    })()
    this.ready.catch(() => {
      this.ready = null
      this.child?.kill()
      this.child = null
    })
    return this.ready
  }

  #route(m) {
    const p = this.pending.get(m?.id)
    if (!p) return
    this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.type === 'scored') p.resolve(m.embedding ? { embedding: m.embedding, seconds: m.seconds } : null)
    else p.reject(new Error(m.message))
  }

  // 进程意外退出：在等的请求都算失败（引擎当这段没打上分），下次要用时重开
  #lost(child) {
    if (this.child !== child) return
    this.child = null
    this.ready = null
    const list = [...this.pending.values()]
    this.pending.clear()
    for (const p of list) {
      clearTimeout(p.timer)
      p.reject(new Error('声纹进程退出了'))
    }
  }

  async score(pcm, rate) {
    await this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('声纹打分超时'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      // 只拷这一段：pcm 常是一大块内存上的视图
      this.child.postMessage({ type: 'score', id, pcm: new Uint8Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)), rate })
    })
  }

  stop() {
    this.child?.kill()
    this.#lost(this.child)
    this.child = null
    this.ready = null
  }
}

/** 不在 Electron 里（单测、命令行）：进程内算，结果放到下一轮事件循环再给，和子进程一样是异步的。 */
class InlineHost {
  constructor() {
    this.model = null
  }

  async start() {
    this.model ??= await loadVoiceprintModel()
  }

  async score(pcm, rate) {
    await this.start()
    await new Promise((r) => setImmediate(r))
    return embedPcm(this.model, pcm, rate)
  }

  stop() {}
}

let host = null
const inElectron = () => Boolean(process.versions.electron) && process.type === 'browser' && !process.env.MEETCAPTION_LOCAL_ASR_INLINE
const voiceprintHost = () => (host ??= inElectron() ? new UtilityHost() : new InlineHost())

/** 开会用的声纹模型（后台进程里加载，已经加载好就直接回）。 */
export async function loadVoiceprintScorer() {
  const h = voiceprintHost()
  await h.start()
  return { modelId: MODEL_ID, scorePcm: (pcm, rate) => h.score(pcm, rate) }
}

/** 应用启动后先在后台把声纹模型加载好，开会时不用再等。 */
export function prewarmVoiceprint() {
  const { native, model } = voiceprintPaths()
  if (!native || !model) return Promise.resolve(false)
  return voiceprintHost()
    .start()
    .then(() => true)
    .catch(() => false)
}

export function stopVoiceprintWorker() {
  host?.stop()
}
