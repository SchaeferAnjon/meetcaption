import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { SonioxStreamASR } from '../src/main/asr/soniox.js'
import { LocalFallbackASR } from '../src/main/asr/fallback.js'

// 云识别断线时本地识别接手、网络好了交回云端：假的 Soniox 服务器记下每条连接收到的音频和 keepalive，
// 「断网」= 服务器把连接掐掉、会员服务器换不到 Key；本地识别用假的，测试按需让它出字。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(check, ms = 5000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('等太久了')
    await sleep(10)
  }
}

async function fakeSoniox(t) {
  const conns = []
  const mode = { flap: false } // flap：接受握手后立刻断开（故障、限流时的样子）
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    const c = { ws, config: null, bytes: 0, keepalive: 0, at: Date.now() }
    conns.push(c)
    if (mode.flap) return ws.terminate()
    ws.on('message', (d, binary) => {
      if (binary) return (c.bytes += d.length)
      const s = String(d)
      if (s === '') return ws.close()
      const m = JSON.parse(s)
      if (m.type === 'keepalive') c.keepalive++
      else if (!m.type) c.config = m
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => (wss.close(), server.close()))
  return { conns, mode, url: `ws://127.0.0.1:${server.address().port}/`, send: (c, tokens) => c.ws.send(JSON.stringify({ tokens })) }
}

class FakeLocal extends EventEmitter {
  sampleRate = 16000
  bytes = 0
  closed = false
  async connect() {
    await sleep(20)
  }
  sendAudio(buf) {
    this.bytes += buf.length
  }
  catchUp(bufs) {
    for (const b of bufs) this.sendAudio(b)
  }
  async close() {
    this.closed = true
  }
}

const tok = (text, start, end, final = true) => ({ text, start_ms: start, end_ms: end, is_final: final })
const second = Buffer.alloc(32000) // 1 秒 16k 单声道
const RATE = 16000

function collect(asr) {
  const ev = []
  for (const name of ['partial', 'final', 'drop', 'status', 'warn']) asr.on(name, (x) => ev.push({ name, ...(typeof x === 'object' ? x : { value: x }) }))
  return ev
}

// 会员：down 为 true 时换不到 Key（断网）
function setup(f, opts = {}) {
  const net = { down: false }
  const getKey = async () => {
    if (net.down) throw new Error('fetch failed')
    return { key: 'tmp', maxMs: 600_000 }
  }
  const locals = []
  const cloud = new SonioxStreamASR({ getKey, url: f.url, timing: { watchMs: 50, silentAfterMs: 400, keepaliveMs: 100, stableMs: 150 } })
  const asr = new LocalFallbackASR({ cloud, makeLocal: () => (locals.push(new FakeLocal()), locals.at(-1)), afterMs: 100, handoverWaitMs: 400, ...opts })
  return { asr, net, locals, ev: collect(asr) }
}

test('断网：4 秒（这里 0.1 秒）没连上就换本地识别，从最后一个定稿的字的终点接着认；网好了等本地这一句说完交回云端', async (t) => {
  const f = await fakeSoniox(t)
  const { asr, net, locals, ev } = setup(f)
  await asr.connect()
  const c0 = f.conns[0]
  asr.sendAudio(second)
  asr.sendAudio(second)
  await until(() => c0.bytes === 64000)
  f.send(c0, [tok('Hello.', 0, 500), { text: '<end>', is_final: true }])
  await until(() => ev.some((e) => e.name === 'final'))

  net.down = true
  c0.ws.terminate()
  await until(() => ev.some((e) => e.value === 'fallback'))
  const local = locals[0]
  assert.equal(locals.length, 1)
  assert.equal(local.bytes, (2 * RATE - 0.5 * RATE) * 2, '本地从 0.5 秒（最后定稿的字的终点）补到现在')
  asr.sendAudio(second)
  assert.equal(local.bytes, (3 * RATE - 0.5 * RATE) * 2, '之后的音频直接给本地')

  // 本地出的字：span 加上它开始的位置（0.5 秒）
  local.emit('partial', { key: 'c1-1', text: '我们', span: { start: 100, end: 400 } })
  local.emit('final', { key: 'c1-1', text: '我们开始吧。', span: { start: 100, end: 900 } })
  assert.deepEqual(ev.filter((e) => e.key === 'c1-1').map((e) => [e.name, e.span.start, e.span.end]), [
    ['partial', 600, 900],
    ['final', 600, 1400],
  ])

  net.down = false
  await until(() => ev.some((e) => e.value === 'back'))
  const c1 = f.conns[1]
  assert.ok(c1.config, '新连接发了配置')
  assert.ok(local.closed, '本地识别关掉了')
  // 交回点：本地最后一句的终点 1.4 秒再让 0.25 秒；从那里补发到现在（3 秒）
  const at = Math.round(1.65 * RATE)
  await until(() => c1.bytes === (3 * RATE - at) * 2)
  asr.sendAudio(second)
  await until(() => c1.bytes === (4 * RATE - at) * 2)
  assert.equal(local.bytes, (3 * RATE - 0.5 * RATE) * 2, '交回以后本地不再收音频')
  // 云端新连接的字按交回点算时间
  f.send(c1, [tok('Next', 100, 300, false)])
  await until(() => ev.some((e) => e.name === 'partial' && e.text === 'Next'))
  assert.equal(ev.find((e) => e.text === 'Next').span.start, 1650 + 100)
  assert.deepEqual(ev.filter((e) => e.name === 'status').map((e) => e.value).filter((v, i, a) => v !== a[i - 1]), ['reconnecting', 'fallback', 'back'])
  await asr.close()
})

test('网好了时本地这一句还没说完：连接挂着只发 keepalive，等它说完再交回；一直不完就作废这一句、从它开头交回', async (t) => {
  const f = await fakeSoniox(t)
  for (const finish of [true, false]) {
    const { asr, net, locals, ev } = setup(f)
    await asr.connect()
    const c0 = f.conns.at(-1)
    asr.sendAudio(second)
    await until(() => c0.bytes === 32000)
    net.down = true
    c0.ws.terminate()
    await until(() => ev.some((e) => e.value === 'fallback'))
    const local = locals[0]
    asr.sendAudio(second)
    local.emit('final', { key: 'c1-1', text: '第一句。', span: { start: 0, end: 500 } })
    local.emit('partial', { key: 'c1-2', text: '第二句还在', span: { start: 1200, end: 1800 } })
    const before = f.conns.length
    net.down = false
    await until(() => f.conns.length > before && f.conns.at(-1).config)
    const c1 = f.conns.at(-1)
    await sleep(300)
    assert.equal(c1.bytes, 0, '本地还在说：云端连接先不送音频')
    assert.ok(c1.keepalive >= 1, '挂着时发 keepalive')
    assert.ok(!ev.some((e) => e.value === 'back'))
    if (finish) {
      local.emit('final', { key: 'c1-2', text: '第二句还在说。', span: { start: 1200, end: 1900 } })
      await until(() => ev.some((e) => e.value === 'back'))
      // 最后一句终点 1.9 秒再让 0.25 秒，超过了现在（2 秒）：从现在起送，之前的本地都认了
      asr.sendAudio(second)
      await until(() => c1.bytes === 32000)
      f.send(c1, [tok('Go', 100, 300, false)])
      await until(() => ev.some((e) => e.text === 'Go'))
      assert.equal(ev.find((e) => e.text === 'Go').span.start, 2000 + 100)
      assert.ok(!ev.some((e) => e.name === 'drop'))
    } else {
      await until(() => ev.some((e) => e.value === 'back'))
      assert.ok(ev.some((e) => e.name === 'drop' && e.key === 'c1-2'), '没说完的这一句作废，云端重认')
      // 第一句终点 0.5 秒 + 0.25 秒 < 第二句开头 1.2 秒：从 0.75 秒补发
      await until(() => c1.bytes === (2 * RATE - Math.round(0.75 * RATE)) * 2)
    }
    await asr.close()
  }
})

test('本地识别开不起来：提示一句，等云端连上从它最后定稿的地方补发', async (t) => {
  const f = await fakeSoniox(t)
  const { asr, net, locals, ev } = setup(f)
  locals.push = function (l) {
    l.connect = async () => {
      throw new Error('本地识别模型缺失，请重新安装')
    }
    return Array.prototype.push.call(this, l)
  }
  await asr.connect()
  const c0 = f.conns[0]
  asr.sendAudio(second)
  await until(() => c0.bytes === 32000)
  f.send(c0, [tok('Hi.', 0, 250), { text: '<end>', is_final: true }])
  await until(() => ev.some((e) => e.name === 'final'))
  net.down = true
  c0.ws.terminate()
  await until(() => ev.some((e) => e.name === 'warn'))
  assert.match(ev.find((e) => e.name === 'warn').value, /本地识别没能接上/)
  asr.sendAudio(second)
  net.down = false
  await until(() => ev.some((e) => e.value === 'ready'))
  await until(() => f.conns[1]?.bytes === (2 * RATE - 0.25 * RATE) * 2)
  await asr.close()
})

test('网断了但连接没报错：6 秒（这里 0.4 秒）既没回消息也没回 pong 就当断了', async (t) => {
  const f = await fakeSoniox(t)
  const cloud = new SonioxStreamASR({ key: 'sk', url: f.url, timing: { watchMs: 50, silentAfterMs: 400 } })
  const ev = collect(cloud)
  await cloud.connect()
  await until(() => f.conns[0]?.config)
  await sleep(300)
  assert.ok(!ev.some((e) => e.value === 'reconnecting'), '回着 pong 就不算断')
  f.conns[0].ws._socket.pause() // 服务器不再读：不回 pong
  const t0 = Date.now()
  await until(() => ev.some((e) => e.value === 'reconnecting'))
  assert.ok(Date.now() - t0 < 1500)
  await cloud.close()
})

test('握手成功又马上断开：重连间隔照样往上退，不是每秒几百次；4 秒（这里 0.1 秒）后换本地识别并提示，服务器好了再换回', async (t) => {
  const f = await fakeSoniox(t)
  const { asr, locals, ev } = setup(f)
  await asr.connect()
  const c0 = f.conns[0]
  asr.sendAudio(second)
  await until(() => c0.bytes === 32000)
  f.send(c0, [tok('Hello.', 0, 500), { text: '<end>', is_final: true }])
  await until(() => ev.some((e) => e.name === 'final'))

  f.mode.flap = true
  const t0 = Date.now()
  const before = f.conns.length
  c0.ws.terminate()
  await until(() => ev.some((e) => e.value === 'fallback'))
  assert.equal(locals.length, 1, '换成了本地识别')
  assert.ok(!ev.some((e) => e.value === 'ready'), '接上又断的不算重新连上')
  await sleep(2500)
  // 间隔 0、1、2 秒…往上退：2.5 秒里最多再试三四次（以前是每秒几百次）
  const tries = f.conns.length - before
  assert.ok(tries >= 2 && tries <= 5, `重连了 ${tries} 次`)
  assert.ok(Date.now() - t0 >= 2500)
  asr.sendAudio(second)
  assert.ok(locals[0].bytes > 0, '本地接着出字')

  // 服务器好了：新连接连够 stableMs 才算数，再交回云端
  f.mode.flap = false
  await until(() => ev.some((e) => e.value === 'back'), 8000)
  assert.equal(locals.length, 1)
  assert.ok(locals[0].closed)
  assert.deepEqual(ev.filter((e) => e.name === 'status').map((e) => e.value).filter((v, i, a) => v !== a[i - 1]), ['reconnecting', 'fallback', 'back'])
  await asr.close()
})

test('握手后马上断开，但只断一次：下一条连够 stableMs 就算连上，不换本地识别', async (t) => {
  const f = await fakeSoniox(t)
  const { asr, locals, ev } = setup(f, { afterMs: 3000 })
  await asr.connect()
  f.mode.flap = true
  f.conns[0].ws.terminate()
  await until(() => f.conns.length >= 2) // 第一次重连被马上断开
  f.mode.flap = false
  await until(() => ev.some((e) => e.value === 'ready'), 5000)
  assert.equal(locals.length, 0)
  assert.ok(asr.cloud.steady)
  await asr.close()
})
