'use strict'
// utilityProcess 里跑声纹：加载模型（一两秒，Rosetta 下更久）和给麦克风每一段打分的向量计算都是同步的 CPU 活，放主进程会卡住界面。
// 收：{ type: 'init', native, model } / { type: 'score', id, pcm, rate }
// 回：{ type: 'ready', ms } / { type: 'error', message, code } / { type: 'scored', id, embedding, seconds } / { type: 'failed', id, message }

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const port = process.parentPort
let vp = null
let model = null

async function init(m) {
  const t0 = Date.now()
  vp ??= await import(pathToFileURL(path.join(__dirname, 'voiceprint.js')).href)
  model ??= await vp.loadVoiceprintModel({ paths: { native: m.native, model: m.model } })
  port.postMessage({ type: 'ready', ms: Date.now() - t0 })
}

function score(m) {
  try {
    const r = vp.embedPcm(model, Buffer.from(m.pcm.buffer, m.pcm.byteOffset, m.pcm.byteLength), m.rate)
    port.postMessage({ type: 'scored', id: m.id, embedding: r?.embedding ?? null, seconds: r?.seconds ?? 0 })
  } catch (e) {
    port.postMessage({ type: 'failed', id: m.id, message: e.message })
  }
}

// 一条一条按顺序处理：init 还没完，后面到的 score 排在它后面
let chain = Promise.resolve()
port.on('message', (e) => {
  const m = e.data
  chain = chain.then(async () => {
    try {
      if (m.type === 'init') await init(m)
      else if (m.type === 'score') score(m)
    } catch (err) {
      port.postMessage({ type: 'error', message: err.message, code: err.code })
    }
  })
})
