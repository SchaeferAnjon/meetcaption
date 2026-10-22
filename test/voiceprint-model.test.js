import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadVoiceprintModel, voiceprintPaths, enrollFrom, cosine, MODEL_ID } from '../src/main/audio/voiceprint.js'

// 真模型：本机装了对应平台的 sherpa-onnx 才跑（Windows CI 的 npm ci 会装 win-x64），顺便验证原生库能加载。
const paths = voiceprintPaths()
const skip = !paths.native || !paths.model ? '没有本平台的 sherpa-onnx 或模型文件' : false
const RATE = 16000

// 类似说话的合成音：基频 f0 的谐波，按音节节奏开关
function voice(f0, seconds, seed = 1) {
  const x = new Float32Array(Math.round(seconds * RATE))
  let s = seed
  for (let i = 0; i < x.length; i++) {
    const t = i / RATE
    const env = Math.max(0, Math.sin(2 * Math.PI * 3 * t)) ** 0.5
    let v = 0
    for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t * (1 + 0.01 * Math.sin(2 * Math.PI * 0.7 * t))) / h
    s = (s * 16807) % 2147483647
    x[i] = 0.15 * env * v + 0.002 * (s / 2147483647 - 0.5)
  }
  return x
}

test('model: loads once, 192-d normalized embeddings, deterministic', { skip }, async () => {
  const model = await loadVoiceprintModel()
  assert.equal(model, await loadVoiceprintModel())
  assert.equal(model.modelId, MODEL_ID)
  assert.equal(model.dim, 192)
  const x = voice(120, 3)
  const a = model.embed(x)
  const b = model.embed(x)
  assert.equal(a.length, 192)
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-4)
  assert.ok(cosine(a, b) > 0.9999)
})

test('model: too-short audio throws too-short', { skip }, async () => {
  const model = await loadVoiceprintModel()
  assert.throws(() => model.embed(new Float32Array(RATE * 0.3)), (e) => e.code === 'too-short')
})

test('model: enrollFrom on 10 s works and the same source scores higher than a different one', { skip }, async () => {
  const model = await loadVoiceprintModel()
  const p = enrollFrom(voice(110, 10), model)
  assert.equal(p.embedding.length, 192)
  const same = cosine(p.embedding, model.embed(voice(110, 3, 7)))
  const other = cosine(p.embedding, model.embed(voice(230, 3, 7)))
  assert.ok(same > other, `same ${same} other ${other}`)
})
