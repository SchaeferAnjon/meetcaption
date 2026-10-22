import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { MeetingEngine } from '../src/main/engine.js'
import { MacSystemAudio } from '../src/main/audio/macTap.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 暂停 / 继续（同一场会议，识别和采集都关掉再重开）；音频断了自动重开（采集窗口的一路、Mac 的 audiotee）。

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  closed = false
  sent = 0
  async connect() {}
  sendAudio(b) {
    this.sent += b.length
  }
  endTurn() {}
  async close() {
    this.closed = true
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

function setup({ rendererCapture = null, fake = { system: true, mic: true }, patch = {} } = {}) {
  let cfg = applyPatch(applyPatch(merge(DEFAULTS, {}), { translate: false, terms: { enabled: false }, assist: { enabled: false } }), patch)
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  let session
  const saves = []
  const store = {
    create: (meta) => (session = { id: 't', startedAt: Date.now() - 1, segments: [], ...meta }),
    scheduleSave: (s) => saves.push(structuredClone(s.pauses ?? null)),
    saveNow() {},
    remove: async () => {},
  }
  const providers = []
  const engine = new MeetingEngine({
    settings,
    store,
    rendererCapture,
    createProvider: () => {
      const p = new FakeASR()
      providers.push(p)
      return p
    },
  })
  if (fake) engine.useFakeSources(fake)
  const notices = []
  engine.on('notice', (n) => notices.push(n))
  const pauses = []
  engine.on('pause', (p) => pauses.push(p.paused))
  const setCfg = (p) => {
    cfg = applyPatch(cfg, p)
    settings.emit('change', settings.get())
  }
  return { engine, providers, notices, pauses, setCfg, session: () => session }
}

test('pause finalizes the open line, closes recognition and ignores audio; resume reconnects into the same meeting', async (t) => {
  const ctx = setup()
  const { engine, providers } = ctx
  await engine.start()
  t.after(() => engine.stop())
  assert.equal(providers.length, 2)
  providers[0].emit('partial', { key: 'a', text: 'We were talking about the deadline' })
  await engine.pause()
  assert.equal(engine.paused, true)
  assert.equal(engine.state, 'running')
  assert.ok(providers.every((p) => p.closed))
  const seg = engine.snapshot().segments.find((x) => x.id === 'system:a')
  assert.equal(seg.final, true, '没说完的那句暂停时定稿')
  assert.equal(engine.snapshot().paused, true)
  assert.equal(ctx.session().pauses.length, 1)
  assert.equal(ctx.session().pauses[0].until, null)
  engine.feed('system', Buffer.alloc(3200))
  assert.equal(providers[0].sent, 0, '暂停时不送音频')

  await engine.resume()
  assert.equal(engine.paused, false)
  assert.equal(providers.length, 4, '继续时新建识别连接')
  engine.feed('system', Buffer.alloc(3200))
  assert.equal(providers[2].sent, 3200)
  providers[2].emit('final', { key: 'b', text: 'Let us continue.' })
  assert.equal(ctx.session().id, 't')
  assert.ok(ctx.session().segments.some((x) => x.text === 'Let us continue.'), '继续后的话记在同一场会议里')
  assert.ok(ctx.session().pauses[0].until >= ctx.session().pauses[0].at)
  assert.deepEqual(ctx.pauses, [true, false])
})

test('stop while paused ends the meeting and closes the pause', async () => {
  const ctx = setup()
  await ctx.engine.start()
  await ctx.engine.pause()
  await ctx.engine.stop()
  assert.equal(ctx.engine.state, 'idle')
  assert.equal(ctx.engine.paused, false)
  assert.ok(ctx.session().pauses[0].until)
})

// 采集窗口的替身：start 记下回调，restart 按 results 依次返回
function fakeCapture(results = []) {
  const calls = []
  const cap = {
    token: null,
    handlers: null,
    info: { mic: { label: 'MacBook Pro 麦克风', fallback: false } },
    async start(opts) {
      this.handlers = opts
      this.token = Symbol('t')
      return this.token
    },
    async restart(token, source, patch) {
      calls.push({ source, patch })
      if (token !== this.token) return { ok: false, stopped: true }
      return results.shift() ?? { ok: true, label: 'AirPods', fallback: false }
    },
    stop(token) {
      if (token == null || token === this.token) this.token = null
    },
  }
  return { cap, calls }
}

const classMic = { mode: 'class', classSource: 'mic' } // 只开麦克风一路，不碰 Mac 的系统声音

test('a mic track that ends is reopened with retries, then a notice says which device it uses', async (t) => {
  const { cap, calls } = fakeCapture([{ ok: false, error: 'NotFoundError' }, { ok: true, label: 'MacBook Pro 麦克风', fallback: false }])
  const ctx = setup({ rendererCapture: cap, fake: null })
  await ctx.engine.start(classMic)
  t.after(() => ctx.engine.stop())
  assert.deepEqual(ctx.engine.snapshot().devices.mic, { label: 'MacBook Pro 麦克风', fallback: false })
  cap.handlers.onLost('mic', 'ended')
  assert.equal(ctx.notices.at(-1).code, 'capture-mic')
  assert.equal(ctx.notices.at(-1).level, 'warn')
  await tick(700)
  assert.equal(calls.length, 2)
  const codes = ctx.notices.map((n) => `${n.level}:${n.code}`)
  assert.ok(codes.includes('clear:capture-mic'))
  assert.match(ctx.notices.at(-1).text, /麦克风已重新连上：MacBook Pro 麦克风/)
})

test('the system default mic changing (headphones on) switches quietly; a missing chosen mic falls back with a notice', async (t) => {
  const { cap, calls } = fakeCapture([{ ok: true, label: 'AirPods', fallback: false }, { ok: true, label: 'MacBook Pro 麦克风', fallback: true }])
  const ctx = setup({ rendererCapture: cap, fake: null })
  await ctx.engine.start(classMic)
  t.after(() => ctx.engine.stop())
  cap.handlers.onLost('mic', 'default-changed')
  await tick()
  assert.ok(!ctx.notices.some((n) => n.code === 'capture-mic'), '换默认设备不报断开')
  assert.match(ctx.notices.at(-1).text, /麦克风换成了：AirPods/)
  // 会上在设置里换了麦克风：马上按新的设备重开
  ctx.setCfg({ micDeviceId: 'usb-1' })
  await tick()
  assert.equal(calls.at(-1).patch.micDeviceId, 'usb-1')
  assert.match(ctx.notices.at(-1).text, /选的麦克风没接上，先用系统默认/)
  assert.equal(ctx.engine.snapshot().devices.mic.fallback, true)
})

test('a mic that silently stops delivering audio is treated as lost', async (t) => {
  const { cap, calls } = fakeCapture()
  const ctx = setup({ rendererCapture: cap, fake: null })
  ctx.engine.captureStallMs = 300
  await ctx.engine.start(classMic)
  t.after(() => ctx.engine.stop())
  cap.handlers.onPcm('mic', Buffer.alloc(3200))
  await tick(800)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].source, 'mic')
})

test('lost audio while paused or after stop is not reopened', async () => {
  const { cap, calls } = fakeCapture()
  const ctx = setup({ rendererCapture: cap, fake: null })
  await ctx.engine.start(classMic)
  const h = cap.handlers
  await ctx.engine.pause()
  h.onLost('mic', 'ended')
  await ctx.engine.stop()
  h.onLost('mic', 'ended')
  await tick()
  assert.equal(calls.length, 0)
})

// audiotee 替身：一个带 stdout / stderr 的 EventEmitter
function fakeProc() {
  const p = new EventEmitter()
  p.stdout = new PassThrough()
  p.stderr = new PassThrough()
  p.exitCode = null
  p.signalCode = null
  p.kill = () => {
    p.killed = true
  }
  return p
}

test('mac tap: audiotee exiting (output device changed) is respawned and reports restarting / restored', async () => {
  const procs = []
  const tap = new MacSystemAudio({ sampleRate: 16000, spawnTap: () => (procs.push(fakeProc()), procs.at(-1)) })
  const events = []
  for (const e of ['restarting', 'restored', 'stalled', 'error']) tap.on(e, () => events.push(e))
  let bytes = 0
  tap.on('data', (b) => (bytes += b.length))
  tap.start()
  procs[0].stdout.write(Buffer.alloc(320))
  await tick()
  procs[0].emit('exit', 0, null)
  assert.deepEqual(events, ['restarting'])
  await tick(600)
  assert.equal(procs.length, 2)
  procs[1].stdout.write(Buffer.alloc(320))
  await tick()
  assert.deepEqual(events, ['restarting', 'restored'])
  assert.equal(bytes, 640)
  tap.stop()
  assert.ok(procs[1].killed)
})

test('mac tap: data stopping for 4 s after it had started restarts audiotee', async () => {
  const procs = []
  const tap = new MacSystemAudio({ sampleRate: 16000, spawnTap: () => (procs.push(fakeProc()), procs.at(-1)) })
  tap.start()
  procs[0].stdout.write(Buffer.alloc(320))
  await tick(5600)
  tap.stop()
  assert.ok(procs[0].killed)
  assert.equal(procs.length, 2)
})
