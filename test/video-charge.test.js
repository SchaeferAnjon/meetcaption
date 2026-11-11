import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enough, HOUR, segmentsFor, sessionsFor, videoCharge } from '../src/main/video/charge.js'

// 视频模式的场次规则（用户定）：本地识别只出原文字幕 → 不用场次；用会员 AI 或会员云识别 → 每 2 小时 1 场；自带 Key 不用场次；试用的一场只管 1 小时。

const M = { plan: 'member' }

test('按时长算场次：2 小时以内 1 场，2 到 4 小时 2 场，恰好 2 小时还是 1 场，最少 1 场', () => {
  assert.equal(sessionsFor(0), 1)
  assert.equal(sessionsFor(10 * 60_000), 1)
  assert.equal(sessionsFor(2 * HOUR), 1)
  assert.equal(sessionsFor(2 * HOUR + 1000), 2)
  assert.equal(sessionsFor(2.5 * HOUR), 2)
  assert.equal(sessionsFor(4 * HOUR), 2)
  assert.equal(sessionsFor(4 * HOUR + 1), 3)
  assert.equal(sessionsFor(1.5 * HOUR, HOUR), 2, '试用一场 1 小时')
})

test('会员：本地识别只出原文字幕不用场次；翻译或笔记用 AI 就按时长算；云识别不管用不用 AI 都按时长算', () => {
  const h1 = HOUR
  assert.equal(videoCharge({ ...M, recognition: 'local', ai: false, durationMs: 5 * h1 }).sessions, 0)
  assert.equal(videoCharge({ ...M, recognition: 'local', ai: true, durationMs: h1 }).sessions, 1)
  assert.equal(videoCharge({ ...M, recognition: 'local', ai: true, durationMs: 2.5 * h1 }).sessions, 2)
  assert.equal(videoCharge({ ...M, recognition: 'cloud', ai: false, durationMs: h1 }).sessions, 1)
  assert.equal(videoCharge({ ...M, recognition: 'cloud', ai: true, durationMs: 2.5 * h1 }).sessions, 2)
  assert.equal(videoCharge({ ...M, recognition: 'cloud', ai: true, durationMs: 4 * h1 }).sessions, 2)
})

test('自带 Key 不用场次，不管识别和 AI', () => {
  for (const recognition of ['local', 'cloud']) for (const ai of [true, false]) assert.equal(videoCharge({ plan: 'own', recognition, ai, durationMs: 5 * HOUR }).sessions, 0)
})

test('只有试用场次的设备：一场管 1 小时，1 小时以内的视频 1 场，长的按每小时 1 场', () => {
  const trial = { ...M, trial: true, recognition: 'cloud', ai: true }
  assert.equal(videoCharge({ ...trial, durationMs: HOUR }).sessions, 1)
  assert.equal(videoCharge({ ...trial, durationMs: 1.5 * HOUR }).sessions, 2)
  assert.equal(videoCharge({ ...trial, durationMs: HOUR }).unit, HOUR)
  assert.equal(videoCharge({ ...M, recognition: 'cloud', ai: true, durationMs: HOUR }).unit, 2 * HOUR)
  assert.equal(videoCharge({ ...trial, recognition: 'local', ai: false, durationMs: 3 * HOUR }).sessions, 0)
})

test('余额够不够；一块一场地切段', () => {
  assert.deepEqual(enough(2, 1), { ok: false, need: 2, have: 1 })
  assert.deepEqual(enough(1, 1), { ok: true, need: 1, have: 1 })
  assert.deepEqual(enough(0, 0), { ok: true, need: 0, have: 0 })
  assert.deepEqual(segmentsFor(1.5 * HOUR, 1), [{ from: 0, to: 1.5 * HOUR }])
  assert.deepEqual(segmentsFor(2.5 * HOUR, 2), [{ from: 0, to: 2 * HOUR }, { from: 2 * HOUR, to: 2.5 * HOUR }])
  assert.deepEqual(segmentsFor(2.5 * HOUR, 3, HOUR), [{ from: 0, to: HOUR }, { from: HOUR, to: 2 * HOUR }, { from: 2 * HOUR, to: 2.5 * HOUR }])
  assert.deepEqual(segmentsFor(HOUR, 0), [{ from: 0, to: HOUR }])
})
