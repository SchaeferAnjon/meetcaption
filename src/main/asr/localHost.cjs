'use strict'
// utilityProcess 里跑本地识别，识别是同步的 CPU 计算，放主进程会卡住界面和鼠标轮询。
// 收：{ type: 'init', native, modelDir, numThreads } / { type: 'open', ch, keyPrefix } / { type: 'audio', ch, pcm } / { type: 'finish', ch }
// 回：{ type: 'ready', ms } / { type: 'error', ch?, message, code } / { type: 'events', ch, events, samples } / { type: 'finished', ch, events }

const { createRecognizer, LocalChannel } = require('./localCore.cjs')

const port = process.parentPort
let rec = null
const channels = new Map()

function handle(m) {
  if (m.type === 'init') {
    const t0 = Date.now()
    if (!rec) rec = createRecognizer(require(m.native), m.modelDir, { numThreads: m.numThreads })
    port.postMessage({ type: 'ready', ms: Date.now() - t0 })
    return
  }
  if (m.type === 'open') {
    channels.set(m.ch, new LocalChannel(rec, { keyPrefix: m.keyPrefix }))
    return
  }
  const c = channels.get(m.ch)
  if (m.type === 'audio') {
    if (!c) return
    const events = c.accept(Buffer.from(m.pcm.buffer, m.pcm.byteOffset, m.pcm.byteLength))
    // 没有新字也定期报一下认到哪儿了，主进程据此判断跟不跟得上
    c.acks = (c.acks ?? 0) + 1
    if (events.length || c.acks % 10 === 0) port.postMessage({ type: 'events', ch: m.ch, events, samples: c.samples })
    return
  }
  if (m.type === 'finish') {
    const events = c ? c.finish() : []
    channels.delete(m.ch)
    port.postMessage({ type: 'finished', ch: m.ch, events })
  }
}

port.on('message', (e) => {
  const m = e.data
  try {
    handle(m)
  } catch (err) {
    port.postMessage({ type: 'error', ch: m?.ch, message: err.message, code: err.code })
  }
})
