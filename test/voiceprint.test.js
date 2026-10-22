import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cosine,
  pcm16ToFloat32,
  resample,
  trimSilence,
  enrollFrom,
  scoreSegment,
  VoiceprintStore,
  MODEL_ID,
} from '../src/main/audio/voiceprint.js'

const RATE = 16000

function sine(freq, seconds, rate = RATE, amp = 0.5) {
  const x = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return x
}
const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length)
const concat = (...parts) => {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0))
  let o = 0
  for (const p of parts) (out.set(p, o), (o += p.length))
  return out
}

test('cosine: identical, opposite, orthogonal, scale-invariant, zero', () => {
  const a = Float32Array.from([1, 2, 3])
  assert.ok(Math.abs(cosine(a, a) - 1) < 1e-9)
  assert.ok(Math.abs(cosine(a, a.map((v) => -v)) + 1) < 1e-9)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.ok(Math.abs(cosine(a, a.map((v) => v * 7)) - 1) < 1e-9)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.equal(cosine(null, a), 0)
})

test('pcm16ToFloat32: scale, sign, Buffer / Int16Array / ArrayBuffer inputs', () => {
  const i16 = Int16Array.from([0, 16384, -32768, 32767])
  const want = [0, 0.5, -1, 32767 / 32768]
  assert.deepEqual(Array.from(pcm16ToFloat32(i16)), want)
  assert.deepEqual(Array.from(pcm16ToFloat32(Buffer.from(i16.buffer))), want)
  assert.deepEqual(Array.from(pcm16ToFloat32(i16.buffer)), want)
})

test('pcm16ToFloat32: odd byte offset and trailing odd byte', () => {
  const raw = Buffer.alloc(1 + 4 + 1)
  raw.writeInt16LE(1000, 1)
  raw.writeInt16LE(-2000, 3)
  const f = pcm16ToFloat32(raw.subarray(1)) // 奇数偏移，末尾多一个字节
  assert.equal(f.length, 2)
  assert.ok(Math.abs(f[0] - 1000 / 32768) < 1e-9)
  assert.ok(Math.abs(f[1] + 2000 / 32768) < 1e-9)
})

test('resample: same rate returns a copy', () => {
  const x = sine(440, 0.1)
  const y = resample(x, RATE, RATE)
  assert.deepEqual(y, x)
  assert.notEqual(y, x)
})

test('resample: output length follows the rate ratio', () => {
  assert.equal(resample(new Float32Array(48000), 48000, 16000).length, 16000)
  assert.equal(resample(new Float32Array(24000), 24000, 16000).length, 16000)
  assert.equal(resample(new Float32Array(44100), 44100, 16000).length, 16000)
  assert.equal(resample(new Float32Array(8000), 8000, 16000).length, 16000)
})

test('resample: passband tone keeps its amplitude and frequency', () => {
  for (const from of [48000, 24000, 44100, 8000]) {
    const y = resample(sine(1000, 1, from), from, RATE)
    const mid = y.subarray(2000, 14000) // 避开两端
    assert.ok(Math.abs(rms(mid) - 0.5 / Math.SQRT2) < 0.01, `${from}: rms ${rms(mid)}`)
    const ref = sine(1000, 1).subarray(2000, 14000)
    assert.ok(cosine(mid, ref) > 0.99, `${from}: tone shape`)
  }
})

test('resample: tones above the new Nyquist are filtered out, not aliased', () => {
  const y = resample(sine(12000, 1, 48000), 48000, RATE)
  assert.ok(rms(y.subarray(1000, 15000)) < 0.01, `rms ${rms(y)}`)
  const z = resample(sine(10000, 1, 24000), 24000, RATE)
  assert.ok(rms(z.subarray(1000, 15000)) < 0.01, `rms ${rms(z)}`)
})

test('resample: DC stays at 1', () => {
  const y = resample(new Float32Array(4800).fill(1), 48000, RATE)
  for (let i = 100; i < 1500; i++) assert.ok(Math.abs(y[i] - 1) < 1e-3)
})

test('trimSilence: removes digital silence and keeps speech-level frames', () => {
  const x = concat(new Float32Array(RATE), sine(300, 2), new Float32Array(RATE * 2), sine(500, 1.5), new Float32Array(RATE))
  const r = trimSilence(x)
  // 3.5 秒有声，每段前后各多留 2 帧（60ms），允许帧对齐误差
  assert.ok(r.seconds >= 3.5 && r.seconds <= 3.8, `seconds ${r.seconds}`)
  assert.ok(r.peakDb > -10)
})

test('trimSilence: steady background noise is dropped, louder speech kept', () => {
  let seed = 1
  const noise = (n, amp) => Float32Array.from({ length: n }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * amp)
  const x = concat(noise(RATE * 3, 0.01), sine(300, 2, RATE, 0.3), noise(RATE * 3, 0.01))
  const r = trimSilence(x)
  assert.ok(r.seconds >= 2 && r.seconds <= 2.2, `seconds ${r.seconds}`)
})

test('trimSilence: speech without any pause is kept whole', () => {
  const x = sine(300, 3)
  assert.equal(trimSilence(x).samples.length, x.length)
})

test('trimSilence: all silence gives nothing', () => {
  const r = trimSilence(new Float32Array(RATE * 3))
  assert.equal(r.samples.length, 0)
  assert.equal(r.seconds, 0)
})

// 假模型：向量就是信号的能量分布，够测 enrollFrom / scoreSegment 的流程
const fakeModel = {
  dim: 4,
  modelId: MODEL_ID,
  calls: [],
  embed(x) {
    this.calls.push(x.length)
    return Float32Array.from([1, 0, 0, 0])
  },
}

test('enrollFrom: less than 6 s of speech is rejected with a Chinese message', () => {
  const x = concat(sine(300, 4), new Float32Array(RATE * 10))
  assert.throws(
    () => enrollFrom(x, fakeModel),
    (e) => e.code === 'too-short' && /有效语音只有 4\.\d 秒，至少要 6 秒/.test(e.message),
  )
})

test('enrollFrom: near-silent recording is rejected as too quiet', () => {
  const x = sine(300, 12, RATE, 0.003) // 约 -53 dBFS
  assert.throws(
    () => enrollFrom(x, fakeModel),
    (e) => e.code === 'too-quiet' && /声音太小/.test(e.message),
  )
})

test('enrollFrom: silence is trimmed, speech embedded in 3 s chunks and averaged', () => {
  fakeModel.calls = []
  const x = concat(new Float32Array(RATE * 2), sine(300, 5), new Float32Array(RATE * 3), sine(400, 5), new Float32Array(RATE))
  const p = enrollFrom(x, fakeModel)
  assert.equal(p.modelId, MODEL_ID)
  assert.ok(p.seconds >= 10 && p.seconds <= 10.4, `seconds ${p.seconds}`)
  assert.equal(fakeModel.calls.length, 3) // 10.x 秒 → 3 段，最后一段带上余数
  assert.equal(fakeModel.calls.reduce((a, b) => a + b, 0), trimSilence(x).samples.length)
  assert.ok(Math.abs(cosine(p.embedding, [1, 0, 0, 0]) - 1) < 1e-6)
})

test('scoreSegment: null for short speech or a profile from another model', () => {
  const profile = { embedding: Float32Array.from([1, 0, 0, 0]), modelId: MODEL_ID }
  assert.equal(scoreSegment(fakeModel, profile, concat(sine(300, 0.6), new Float32Array(RATE))), null)
  assert.equal(scoreSegment(fakeModel, { ...profile, modelId: 'other' }, sine(300, 3)), null)
  assert.equal(scoreSegment(fakeModel, null, sine(300, 3)), null)
  const r = scoreSegment(fakeModel, profile, sine(300, 3))
  assert.ok(Math.abs(r.score - 1) < 1e-6)
  assert.ok(r.seconds > 2.9)
})

test('VoiceprintStore: save, load, overwrite, clear, and corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'))
  const file = path.join(dir, 'sub', 'voiceprint.json')
  const store = new VoiceprintStore(file)
  assert.equal(store.load(), null)
  const embedding = Float32Array.from({ length: 192 }, (_, i) => Math.sin(i) / 10)
  store.save({ embedding, modelId: MODEL_ID, seconds: 12.3, createdAt: 1700000000000 })
  const p = store.load()
  assert.equal(p.modelId, MODEL_ID)
  assert.equal(p.seconds, 12.3)
  assert.equal(p.createdAt, 1700000000000)
  assert.ok(p.embedding instanceof Float32Array)
  assert.equal(p.embedding.length, 192)
  assert.ok(cosine(p.embedding, embedding) > 0.99999)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.ok(!fs.existsSync(`${file}.tmp`))

  store.save({ embedding: Float32Array.from([1, 2]), modelId: 'x', seconds: 7 })
  assert.deepEqual(Array.from(store.load().embedding), [1, 2])

  store.clear()
  assert.equal(store.load(), null)
  assert.doesNotThrow(() => store.clear())

  fs.writeFileSync(file, '{not json')
  assert.equal(store.load(), null)
  fs.writeFileSync(file, JSON.stringify({ embedding: [1, 'a'], modelId: MODEL_ID }))
  assert.equal(store.load(), null)
  fs.writeFileSync(file, JSON.stringify({ embedding: [], modelId: MODEL_ID }))
  assert.equal(store.load(), null)
  fs.rmSync(dir, { recursive: true, force: true })
})
