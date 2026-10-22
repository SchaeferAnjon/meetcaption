import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingEngine } from '../src/main/engine.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 段落的开始时间按它在音频里的位置算，不按出字的时间：识别断线重连后补出来的字晚好几秒，也要排在后来说的话前面。

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

class FakeGatedASR extends FakeASR {
  sampleRate = 24000
  gated = true
}

function tone(rate, ms, amp) {
  const n = (rate * ms) / 1000
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2)
  return b
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

async function setup(t, Provider = FakeASR) {
  const cfg = applyPatch(merge(DEFAULTS, {}), { translate: false, terms: { enabled: false }, assist: { enabled: false } })
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  let session
  const store = {
    create: (meta) => (session = { id: 't', startedAt: Date.now() - 60_000, segments: [], ...meta }),
    scheduleSave() {},
    saveNow() {},
    remove: async () => {},
  }
  const providers = []
  const engine = new MeetingEngine({
    settings,
    store,
    rendererCapture: null,
    createProvider: () => {
      const p = new Provider()
      providers.push(p)
      return p
    },
  })
  engine.useFakeSources({ system: true, mic: true })
  await engine.start()
  t.after(() => engine.stop())
  const segs = []
  engine.on('segment', (s) => segs.push(structuredClone(s)))
  return { engine, providers, segs, session: () => session }
}

test('engine: a paragraph whose words arrive late (after a reconnect) is dated by its audio span and sorted before later speech', async (t) => {
  const ctx = await setup(t)
  const [sys, mic] = ctx.providers
  ctx.engine.feed('system', Buffer.alloc(16000 * 2 * 6)) // 电脑声音这一路已经收了 6 秒
  mic.emit('final', { key: 'm1', text: 'Sure, I can walk you through it.' }) // 我刚回了一句（没有 span：按现在算）
  await tick()
  // 对方 1 到 4 秒说的话，识别断线重连后现在才出字
  sys.emit('partial', { key: 's1', text: 'So we looked at your results', span: { start: 1000, end: 4000 } })
  sys.emit('final', { key: 's1', text: 'So we looked at your results on the second data set.', span: { start: 1000, end: 4000 } })
  await tick()
  const saved = ctx.session().segments
  assert.deepEqual(saved.map((x) => x.id), ['system:s1', 'mic:m1'])
  const s1 = saved[0]
  const m1 = saved[1]
  // 大约 5 秒前开始说的（收到的音频末尾是现在，起点在 1 秒处）
  assert.ok(m1.startedAt - s1.startedAt >= 4500 && m1.startedAt - s1.startedAt <= 5500, `${m1.startedAt - s1.startedAt}`)
})

test('engine: an OpenAI paragraph without a span yet is dated from the open turn in the gate', async (t) => {
  const ctx = await setup(t, FakeGatedASR)
  const [sys] = ctx.providers
  ctx.engine.feed('system', Buffer.alloc(24000 * 2 * 2)) // 2 秒静音
  ctx.engine.feed('system', tone(24000, 3000, 0.3)) // 2 到 5 秒说话（门限带 400 毫秒预录，这一段从 1.6 秒算起）
  const before = Date.now()
  sys.emit('partial', { key: 'item_1', text: 'Good morning everyone' })
  await tick()
  const seg = ctx.segs.find((s) => s.id === 'system:item_1')
  const back = before - seg.startedAt
  assert.ok(back >= 3200 && back <= 3600, `往回推了 ${back}ms`)
})

test('engine: the start time never goes before the meeting started, and without audio it is now', async (t) => {
  const ctx = await setup(t)
  const [sys] = ctx.providers
  const before = Date.now()
  sys.emit('final', { key: 'a', text: 'Hello there.', span: { start: 0, end: 1000 } }) // 这一路还没收到音频
  await tick()
  const a = ctx.session().segments.find((x) => x.id === 'system:a')
  assert.ok(a.startedAt >= before)
  ctx.engine.feed('system', Buffer.alloc(16000 * 2 * 3))
  sys.emit('final', { key: 'b', text: 'Hello again.', span: { start: -600_000, end: 1000 } })
  await tick()
  const b = ctx.session().segments.find((x) => x.id === 'system:b')
  assert.ok(b.startedAt >= ctx.session().startedAt)
})

test('engine: a stalled main process does not get silence filled into the middle of speech (no false turn end)', async (t) => {
  const ctx = await setup(t, FakeGatedASR)
  const [sys] = ctx.providers
  const ends = []
  sys.endTurn = (span) => ends.push(span)
  ctx.engine.feed('system', tone(24000, 1000, 0.3)) // 正在说
  await tick(100)
  // 主进程卡了 1.1 秒；这期间采集到的声音排在后面，卡完才到：下一轮事件循环里定时器（补静音）先跑，数据后到，和 IPC 一样
  await new Promise((resolve) =>
    setImmediate(() => {
      setImmediate(() => {
        ctx.engine.feed('system', tone(24000, 1100, 0.3))
        resolve()
      })
      const until = Date.now() + 1100
      while (Date.now() < until) {}
    }),
  )
  await tick(300)
  ctx.engine.feed('system', tone(24000, 300, 0.3))
  await tick(50)
  assert.deepEqual(ends, [], '说话中间不该切句')
})
