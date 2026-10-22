import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioRing } from '../src/main/audio/ring.js'
import { SpeechGate } from '../src/main/audio/gate.js'
import { applyPatch, DEFAULTS, keywordList, merge } from '../src/main/defaults.js'
import { isCrosstalk, overlap, questionRun, tokenize } from '../src/main/speaker.js'

/* ---------------- 设置合并 ---------------- */

test('settings: a patch to one nested field keeps the other nested fields', () => {
  let s = merge(DEFAULTS, {})
  s = applyPatch(s, { assist: { profile: 'PhD student, FPGA speech recognition' } })
  s = applyPatch(s, { assist: { auto: false } })
  assert.equal(s.assist.profile, 'PhD student, FPGA speech recognition')
  assert.equal(s.assist.auto, false)
  assert.equal(s.assist.hotkeyAsk, 'CommandOrControl+Alt+A')
  s = applyPatch(s, { terms: { enabled: false }, voiceprint: { threshold: 0.6 } })
  s = applyPatch(s, { overlay: { answerBounds: { x: 1, y: 2, width: 400, height: 500 } } })
  s = applyPatch(s, { overlay: { fontSize: 30 } })
  assert.deepEqual(s.overlay.answerBounds, { x: 1, y: 2, width: 400, height: 500 })
  assert.equal(s.overlay.fontSize, 30)
  assert.equal(s.overlay.lines, 4)
  assert.equal(s.terms.enabled, false)
  assert.equal(s.voiceprint.threshold, 0.6)
  s = applyPatch(s, { overlay: { bounds: null }, bogus: 1 })
  assert.equal(s.overlay.bounds, null)
  assert.ok(!('bogus' in s))
})

test('settings: v2 defaults and files from v1 fill in the new nested fields', () => {
  const v1 = { engine: 'volc', captureMic: false, overlay: { fontSize: 20, bounds: { x: 0, y: 0, width: 800, height: 150 } } }
  const s = merge(DEFAULTS, v1)
  assert.equal(s.captureMic, false) // 用户存过的值不动
  assert.equal(s.overlay.answerBounds, null)
  assert.deepEqual(s.assist, DEFAULTS.assist)
  assert.equal(s.terms.enabled, true)
  assert.equal(merge(DEFAULTS, {}).captureMic, true)
  assert.equal(DEFAULTS.llmAnswerModel, '')
  assert.deepEqual(keywordList({ keywords: 'LoRA, GLUE\nKL divergence；ELBO' }), ['LoRA', 'GLUE', 'KL divergence', 'ELBO'])
})

/* ---------------- 环形缓冲 ---------------- */

test('ring: reads back by milliseconds and keeps only the last N seconds', () => {
  const ring = new AudioRing(1000, 2) // 1 kHz，存 2 秒，方便算
  const chunk = (from, n) => Buffer.from(Int16Array.from({ length: n }, (_, i) => from + i).buffer)
  ring.write(chunk(0, 1500))
  assert.deepEqual(Array.from(ring.read(100, 105)), [100, 101, 102, 103, 104])
  ring.write(chunk(1500, 1500)) // 一共 3 秒，前 1 秒被覆盖
  assert.equal(ring.ms, 3000)
  assert.equal(ring.read(0, 900), null)
  const r = ring.read(900, 1100) // 只剩 1000 以后
  assert.equal(r.length, 100)
  assert.equal(r[0], 1000)
  const wrap = ring.read(1990, 2010) // 跨过缓冲区结尾
  assert.deepEqual(Array.from(wrap.slice(0, 3)), [1990, 1991, 1992])
  assert.equal(wrap.at(-1), 2009)
  assert.equal(ring.read(2990, 4000).length, 10)
  const odd = Buffer.concat([Buffer.alloc(1), chunk(7, 4)]).subarray(1)
  assert.doesNotThrow(() => ring.write(odd))
})

/* ---------------- 门限的位置 ---------------- */

test('gate: turns carry their position in the stream, including pre-roll', () => {
  const RATE = 16000
  const tone = (ms) => {
    const b = Buffer.alloc((RATE * ms) / 1000 * 2)
    for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2)
    return b
  }
  const silence = (ms) => Buffer.alloc((RATE * ms) / 1000 * 2)
  const gate = new SpeechGate({ sampleRate: RATE })
  const ops = []
  let open = null
  for (const b of [silence(1000), tone(1500), silence(1200)]) {
    for (let o = 0; o < b.length; o += 3200) {
      ops.push(...gate.push(b.subarray(o, o + 3200)).ops)
      if (gate.speaking && !open) open = gate.openTurn()
    }
  }
  const end = ops.find((o) => o.endTurn)
  const frame = RATE * 0.02
  assert.ok(Math.abs(end.start - RATE * 0.6) <= frame, `start ${end.start}`) // 1 秒处开口，带 0.4 秒预录
  assert.ok(Math.abs(end.end - RATE * 3.3) <= frame, `end ${end.end}`) // 2.5 秒说完 + 0.8 秒停顿
  assert.equal(open.start, end.start)
  assert.equal(gate.openTurn(), null)
})

/* ---------------- 串音 ---------------- */

test('crosstalk: the leaked copy of the other side matches, my answer does not', () => {
  const sys = ['So we looked at your results on the second dataset.', 'Could you walk me through why the ablation drops so much there?']
  assert.ok(isCrosstalk('we looked at your results on the second data set', sys))
  assert.ok(isCrosstalk('Could you walk me through why the ablation drops so much?', sys))
  assert.ok(isCrosstalk('dataset', sys))
  const mine = 'Sure. On the second dataset the labels are much noisier, so once we remove the denoising module the ablation drops.'
  assert.ok(!isCrosstalk(mine, sys), JSON.stringify(overlap(mine, sys)))
  assert.ok(!isCrosstalk('Yes, exactly.', sys))
  assert.ok(!isCrosstalk('anything', []))
})

test('crosstalk: Chinese is compared character by character', () => {
  assert.deepEqual(tokenize('我们用 GPU跑了三天'), ['我', '们', '用', 'gpu', '跑', '了', '三', '天'])
  const sys = ['我们看了你在第二个数据集上的结果，为什么消融以后掉了这么多？']
  assert.ok(isCrosstalk('你在第二个数据集上的结果为什么消融以后掉了这么多', sys))
  assert.ok(!isCrosstalk('主要是第二个数据集的标签噪声比较大，去掉去噪模块以后模型开始拟合噪声。', sys))
})

/* ---------------- 提问合并 ---------------- */

test('question run: pulls in the lead-in, stops at my turn, long pauses and old questions', () => {
  const at = (id, who, text, startedAt, endedAt) => ({ id, who, text, final: true, startedAt, endedAt })
  const a = at('a', 'other', 'So we looked at your results on the second dataset.', 1000, 4000)
  const b = at('b', 'other', 'Could you walk me through why the ablation drops?', 5000, 8000)
  assert.deepEqual(questionRun([a, b], b).map((x) => x.id), ['a', 'b'])
  const me = at('m', 'me', 'Okay.', 4200, 4500)
  assert.deepEqual(questionRun([a, me, b], b).map((x) => x.id), ['b'])
  const late = { ...b, startedAt: 9000 }
  assert.deepEqual(questionRun([a, late], late).map((x) => x.id), ['b'])
  // 我还没定稿的临时段（多半是串音）不打断
  assert.deepEqual(questionRun([a, { ...me, final: false }, b], b).map((x) => x.id), ['a', 'b'])
  // 前一段是早就答过的问题：不再带上；刚问过（还在答）的：合并重问
  const now = 20_000
  assert.deepEqual(questionRun([a, b], b, { askedAt: new Map([['a', now - 30_000]]), now }).map((x) => x.id), ['b'])
  assert.deepEqual(questionRun([a, b], b, { askedAt: new Map([['a', now - 2000]]), now }).map((x) => x.id), ['a', 'b'])
  const long = at('l', 'other', 'x'.repeat(700), 0, 900)
  assert.deepEqual(questionRun([long, b], b).map((x) => x.id), ['b'])
})
