import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingEngine } from '../src/main/engine.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 「开始 20 秒了还没听到电脑里有声音」：后来有声音了发 clear 收回，会议结束也收回；从头就有声音的不提示。
// 引擎的 noAudioMs / watchdogEveryMs 调小，假识别服务，音频由测试直接 feed。

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

function tone(ms, amp) {
  const n = (16000 * ms) / 1000
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2)
  return b
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms))
const NO_AUDIO = process.platform === 'darwin' ? 'mac-no-audio' : 'no-audio'

async function started(t, { mic = false } = {}) {
  const cfg = applyPatch(merge(DEFAULTS, {}), { translate: false, terms: { enabled: false, correct: false }, assist: { enabled: false } })
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  const store = {
    create: (meta) => ({ id: 't', startedAt: Date.now() - 1, segments: [], ...meta }),
    scheduleSave() {},
    saveNow() {},
    remove: async () => {},
  }
  const engine = new MeetingEngine({ settings, store, rendererCapture: null, llmStatus: () => ({ ready: false, reason: '' }), createProvider: () => new FakeASR() })
  engine.noAudioMs = 60
  engine.watchdogEveryMs = 20
  engine.useFakeSources({ system: true, mic })
  const notices = []
  engine.on('notice', (n) => notices.push(n))
  await engine.start()
  t.after(() => engine.stop())
  return { engine, notices }
}

test('watchdog: the no-audio notice is taken back once the computer audio arrives', async (t) => {
  const { engine, notices } = await started(t)
  await tick(150)
  assert.deepEqual(notices.map((n) => [n.level, n.code]), [['warn', NO_AUDIO]])
  engine.feed('system', tone(200, 0.3))
  await tick(80)
  assert.deepEqual(notices.map((n) => [n.level, n.code]), [['warn', NO_AUDIO], ['clear', NO_AUDIO]])
  // 收回以后不会再提示，停止时也不再多发一次 clear
  await tick(100)
  await engine.stop()
  assert.equal(notices.length, 2)
})

test('watchdog: a notice still showing when the meeting stops is taken back; the face to face hint too', async (t) => {
  const { engine, notices } = await started(t, { mic: true })
  engine.feed('mic', tone(200, 0.3))
  await tick(150)
  assert.deepEqual(notices.map((n) => [n.level, n.code]), [['info', 'no-audio-f2f']])
  await engine.stop()
  assert.deepEqual(notices.map((n) => [n.level, n.code]), [['info', 'no-audio-f2f'], ['clear', 'no-audio-f2f']])
})

test('watchdog: audio from the start means no notice at all', async (t) => {
  const { engine, notices } = await started(t)
  engine.feed('system', tone(200, 0.3))
  await tick(150)
  await engine.stop()
  assert.deepEqual(notices, [])
})
