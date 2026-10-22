import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { WebSocketServer } from 'ws'
import { EventEmitter } from 'node:events'
import { VolcStreamASR, classifyServerError } from '../src/main/asr/volc.js'
import { MeetingEngine } from '../src/main/engine.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 豆包断线重连和看门狗：本地假服务器记下每条连接收到的包，按需回识别结果或错误帧。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('等太久了')
    await sleep(10)
  }
}

// 假豆包：每条连接一个 { ws, request, packets: [{ at, bytes, silent, first }] }；status(n) 给第 n 次握手返回的 HTTP 状态（默认 101）
async function fakeVolc({ status = () => 101 } = {}) {
  const conns = []
  let attempts = 0
  const wss = new WebSocketServer({ noServer: true })
  const server = http.createServer()
  server.on('upgrade', (req, socket, head) => {
    const code = status(attempts++)
    if (code !== 101) {
      const body = code === 401 ? '{"error":"invalid access token"}' : '{"error":"too many requests"}'
      socket.end(`HTTP/1.1 ${code} Nope\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`)
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c = { ws, request: null, packets: [] }
      conns.push(c)
      ws.on('message', (d) => {
        const type = d[1] >> 4
        const payload = d.subarray(8, 8 + d.readUInt32BE(4))
        if (type === 1) c.request = JSON.parse(zlib.gunzipSync(payload).toString('utf8'))
        else if (d[1] & 0b0010) ws.send(Buffer.from([0x11, 0x92, 0x10, 0, 0, 0, 0, 2, 0x7b, 0x7d])) // 最后一包：回一个 {}，客户端就不用等 3 秒
        else c.packets.push({ at: Date.now(), bytes: payload.length, silent: payload.every((b) => b === 0), first: payload.length ? payload.readInt16LE(0) : null, payload: Buffer.from(payload) })
      })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    conns,
    url: `ws://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const c of conns) c.ws.terminate()
      server.close()
    },
  }
}

function result(obj) {
  const payload = Buffer.from(JSON.stringify(obj))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length)
  return Buffer.concat([Buffer.from([0x11, 0x90, 0x10, 0]), size, payload])
}

function errorFrame(code, text) {
  const payload = Buffer.from(JSON.stringify({ error: text }))
  const head = Buffer.alloc(8)
  head.writeUInt32BE(code, 0)
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([Buffer.from([0x11, 0xf0, 0x10, 0]), head, payload])
}

// 100ms 一块，样本值都是 v，服务端从包里第一个样本就能认出是哪一块
const chunk = (v, samples = 1600) => Buffer.from(new Int16Array(samples).fill(v).buffer)
const bytesOf = (c) => c.packets.reduce((a, p) => a + p.bytes, 0)
const audioOf = (c) => Buffer.concat(c.packets.map((p) => p.payload))

function record(asr) {
  const got = []
  asr.on('partial', (e) => got.push(['partial', e.key.split(':')[1], e.text, e.span]))
  asr.on('final', (e) => got.push(['final', e.key.split(':')[1], e.text, e.span]))
  asr.on('drop', (e) => got.push(['drop', e.key.split(':')[1]]))
  asr.on('status', (s) => got.push(['status', s]))
  asr.on('fatal', (e) => got.push(['fatal', e.message]))
  return got
}

const QUIET = { watchdogMs: 60_000, retryBaseMs: 30 } // 不想让看门狗插手的测试

test('volc: 45000081 (no packet for 8 s) reconnects instead of ending; unfinished sentences are re-recognized from the last final', async () => {
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: { ...QUIET, retryBaseMs: 150 } })
  const got = record(asr)
  await asr.connect()
  for (let i = 1; i <= 10; i++) asr.sendAudio(chunk(i)) // 第 0 到 1000ms
  await until(() => bytesOf(srv.conns[0]) === 32000)
  const s0 = srv.conns[0].ws
  s0.send(result({ result: { utterances: [{ text: 'Good morning.', start_time: 0, end_time: 400, definite: true }] }, audio_info: { duration: 1000 } }))
  s0.send(result({ result: { utterances: [{ text: 'Today we', start_time: 500, end_time: 900, definite: false }] }, audio_info: { duration: 1000 } }))
  await until(() => got.some((x) => x[0] === 'partial'))
  // 断线期间继续来的 500ms 音频：收到 reconnecting 的同一刻送进去
  asr.once('status', (s) => {
    if (s === 'reconnecting') for (let i = 11; i <= 15; i++) asr.sendAudio(chunk(i))
  })
  s0.send(errorFrame(45000081, '[Timeout waiting next packet] waiting next packet timeout: 8.000000 seconds, session has ended'))
  await until(() => srv.conns.length === 2 && bytesOf(srv.conns[1]) === (1500 - 400) * 32)
  const c1 = srv.conns[1]
  assert.equal(c1.request.audio.rate, 16000)
  // 从上一句定稿的终点（400ms，第 5 块中间）补发到断线期间收到的最后一块
  const replay = audioOf(c1)
  assert.equal(replay.readInt16LE(0), 5)
  assert.equal(replay.readInt16LE(replay.length - 2), 15)
  assert.ok(c1.packets.every((p) => p.bytes <= 6400))
  // 新连接上的时间从 400ms 算起
  c1.ws.send(result({ result: { utterances: [{ text: 'Today we continue.', start_time: 100, end_time: 700, definite: true }] } }))
  await until(() => got.filter((x) => x[0] === 'final').length === 2)
  const c1Key = got.at(-1)[1]
  assert.deepEqual(got, [
    ['status', 'ready'],
    ['final', '0', 'Good morning.', { start: 0, end: 400 }],
    ['partial', '500', 'Today we', { start: 500, end: 900 }],
    ['status', 'reconnecting'],
    ['status', 'ready'],
    ['drop', '500'],
    ['final', c1Key, 'Today we continue.', { start: 500, end: 1100 }],
  ])
  // 之后的新音频接着送到新连接
  asr.sendAudio(chunk(16))
  await until(() => audioOf(c1).readInt16LE(audioOf(c1).length - 2) === 16)
  await asr.close()
  srv.close()
})

test('volc: with nothing unfinished, the new connection starts one second before what the server said it had heard', async () => {
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: QUIET })
  const got = record(asr)
  await asr.connect()
  for (let i = 1; i <= 30; i++) asr.sendAudio(chunk(i)) // 3 秒
  await until(() => bytesOf(srv.conns[0]) === 96000)
  srv.conns[0].ws.send(result({ result: { utterances: [{ text: 'Hi.', start_time: 0, end_time: 300, definite: true }] }, audio_info: { duration: 3000 } }))
  await until(() => got.some((x) => x[0] === 'final'))
  srv.conns[0].ws.send(errorFrame(55000031, 'server busy'))
  await until(() => srv.conns.length === 2 && bytesOf(srv.conns[1]) === 32000)
  assert.equal(audioOf(srv.conns[1]).readInt16LE(0), 21) // 第 2000ms 起
  assert.ok(!got.some((x) => x[0] === 'fatal'))
  await asr.close()
  srv.close()
})

test('volc: auth, bad params and bad audio format are fatal; open sentences are kept as finals and nothing reconnects', async () => {
  assert.equal(classifyServerError(45000081, 'Timeout waiting next packet'), 'retry')
  assert.equal(classifyServerError(45000002, 'empty audio'), 'retry')
  assert.equal(classifyServerError(55000031, 'server busy, resource exhausted'), 'retry')
  assert.equal(classifyServerError(45000001, 'invalid request'), 'fatal')
  assert.equal(classifyServerError(45000151, 'invalid audio format'), 'fatal')
  assert.equal(classifyServerError(45000010, 'quota exceeded'), 'fatal')
  assert.equal(classifyServerError(45000099, 'something new'), 'unknown')

  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: QUIET })
  const got = record(asr)
  await asr.connect()
  asr.sendAudio(chunk(1))
  await until(() => bytesOf(srv.conns[0]) === 3200)
  srv.conns[0].ws.send(result({ result: { utterances: [{ text: 'half a', start_time: 0, end_time: 90, definite: false }] } }))
  srv.conns[0].ws.send(errorFrame(45000001, 'invalid request'))
  await until(() => got.some((x) => x[0] === 'fatal'))
  await sleep(150)
  assert.equal(srv.conns.length, 1)
  assert.deepEqual(got.slice(1), [
    ['partial', '0', 'half a', { start: 0, end: 90 }],
    ['final', '0', 'half a', { start: 0, end: 90 }],
    ['fatal', '豆包识别出错（45000001）：{"error":"invalid request"}'],
  ])
  await asr.close()
  srv.close()
})

test('volc: an error code we do not know reconnects, but the third quick failure in a row is fatal', async () => {
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: QUIET })
  const got = record(asr)
  await asr.connect()
  for (let n = 1; n <= 3; n++) {
    await until(() => srv.conns.length === n && srv.conns[n - 1].request)
    srv.conns[n - 1].ws.send(errorFrame(45000099, 'something new'))
    await until(() => got.filter((x) => x[0] === 'status' && x[1] === 'reconnecting').length === Math.min(n, 2) && (n < 3 || got.some((x) => x[0] === 'fatal')))
  }
  await sleep(100)
  assert.equal(srv.conns.length, 3)
  assert.equal(got.filter((x) => x[0] === 'fatal').length, 1)
  await asr.close()
  srv.close()
})

test('volc: while reconnecting, 429 (the old session still counted) retries and 401 is fatal', async () => {
  // 第 0 次握手成功，第 1 次 429，第 2 次成功；那条连接断了以后第 3 次 401
  const srv = await fakeVolc({ status: (n) => [101, 429, 101, 401][n] ?? 401 })
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: QUIET })
  const got = record(asr)
  await asr.connect()
  await until(() => srv.conns[0]?.request)
  srv.conns[0].ws.send(errorFrame(45000081, 'timeout'))
  await until(() => srv.conns.length === 2 && srv.conns[1].request)
  assert.ok(!got.some((x) => x[0] === 'fatal'))
  srv.conns[1].ws.send(errorFrame(45000081, 'timeout'))
  await until(() => got.some((x) => x[0] === 'fatal'))
  assert.match(got.find((x) => x[0] === 'fatal')[1], /App ID 或 Access Token 不对/)
  await asr.close()
  srv.close()
})

test('volc: watchdog sends 200ms of silence after 3 s without a packet, and spans skip the inserted silence', async () => {
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: { watchdogMs: 200, tickMs: 20, fillSamples: 3200 } })
  const got = record(asr)
  const t0 = Date.now()
  await asr.connect()
  // 开始记录要先建窗口、开采集，一开始几秒没有音频：服务端照样隔一会儿收到一包静音
  await until(() => srv.conns[0].packets.length === 1)
  const fill = srv.conns[0].packets[0]
  assert.ok(fill.silent)
  assert.equal(fill.bytes, 6400)
  assert.ok(fill.at - t0 >= 200)
  for (let i = 1; i <= 5; i++) asr.sendAudio(chunk(i)) // 真音频从这一路的第 0ms 开始，在连接上是第 200ms
  await until(() => bytesOf(srv.conns[0]) === 6400 + 16000)
  srv.conns[0].ws.send(result({ result: { utterances: [{ text: 'hello', start_time: 250, end_time: 600, definite: true }] } }))
  await until(() => got.some((x) => x[0] === 'final'))
  assert.deepEqual(got.find((x) => x[0] === 'final')[3], { start: 50, end: 400 })
  // 不够一包的真音频：看门狗先把它发掉，不补静音
  asr.sendAudio(chunk(9, 500))
  await until(() => srv.conns[0].packets.length === 7)
  assert.deepEqual([srv.conns[0].packets[6].bytes, srv.conns[0].packets[6].first], [1000, 9])
  await asr.close()
  srv.close()
})

test('volc: audio stuck in the socket (uplink dead, nothing drains) replaces the connection without waiting for the server', async () => {
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: { ...QUIET, tickMs: 20, stallMs: 150 } })
  const got = record(asr)
  await asr.connect()
  for (let i = 1; i <= 4; i++) asr.sendAudio(chunk(i))
  await until(() => bytesOf(srv.conns[0]) === 12800)
  // 积压很多但一直在往外走（刚补发完一大段）：不算卡住
  let backlog = 300_000
  const draining = setInterval(() => (backlog -= 20_000), 10)
  Object.defineProperty(asr.conn.ws, 'bufferedAmount', { get: () => Math.max(backlog, 0) })
  await sleep(300)
  clearInterval(draining)
  assert.equal(srv.conns.length, 1)
  // 积压不动了：卡住
  backlog = 300_000
  await until(() => srv.conns.length === 2 && srv.conns[1].request)
  assert.deepEqual(got.filter((x) => x[0] === 'status').map((x) => x[1]), ['ready', 'reconnecting', 'ready'])
  // 旧连接什么都没认出来：从它的起点整段补发
  await until(() => bytesOf(srv.conns[1]) === 12800)
  assert.equal(audioOf(srv.conns[1]).readInt16LE(0), 1)
  await asr.close()
  srv.close()
})

test('volc: stopping while reconnecting keeps the unfinished sentence as a final and does not reconnect', async () => {
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: { ...QUIET, retryBaseMs: 400 } })
  const got = record(asr)
  await asr.connect()
  asr.sendAudio(chunk(1))
  await until(() => bytesOf(srv.conns[0]) === 3200)
  srv.conns[0].ws.send(result({ result: { utterances: [{ text: 'almost', start_time: 0, end_time: 90, definite: false }] } }))
  srv.conns[0].ws.send(errorFrame(45000081, 'timeout'))
  await until(() => got.some((x) => x[1] === 'reconnecting'))
  await asr.close()
  await sleep(500)
  assert.equal(srv.conns.length, 1)
  assert.deepEqual(got.at(-1), ['final', '0', 'almost', { start: 0, end: 90 }])
  srv.close()
})

test('volc: when the unfinished sentence started before the kept audio, it is kept as a final and only the rest is sent again', async () => {
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: { ...QUIET, historyMs: 500 } })
  const got = record(asr)
  await asr.connect()
  for (let i = 1; i <= 10; i++) asr.sendAudio(chunk(i)) // 1 秒，只留最后 500ms
  await until(() => bytesOf(srv.conns[0]) === 32000)
  srv.conns[0].ws.send(result({ result: { utterances: [{ text: 'a very long', start_time: 0, end_time: 700, definite: false }] } }))
  await until(() => got.some((x) => x[0] === 'partial'))
  srv.conns[0].ws.send(errorFrame(45000081, 'timeout'))
  await until(() => srv.conns.length === 2 && bytesOf(srv.conns[1]) === 300 * 32)
  assert.equal(audioOf(srv.conns[1]).readInt16LE(0), 8) // 从这句认到的终点 700ms 接着送
  assert.ok(got.some((x) => x[0] === 'final' && x[2] === 'a very long'))
  assert.ok(!got.some((x) => x[0] === 'drop'))
  await asr.close()
  srv.close()
})

test('volc: 2.0 first sentence whose partial briefly carries start_time 40 and whose final has none is not finalized twice', async () => {
  // 实测（补发后的第一句）：partial 没有 start_time → 带上 start_time 40（换了 key）→ 定稿又没有 start_time，第一个词 80
  const srv = await fakeVolc()
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: QUIET })
  const got = record(asr)
  await asr.connect()
  asr.sendAudio(chunk(1))
  await until(() => bytesOf(srv.conns[0]) === 3200)
  const w = (s, e) => [{ start_time: s, end_time: e, text: 'x' }]
  for (const u of [
    { end_time: 1599, definite: false, text: 'Bender. So.', words: w(40, 300) },
    { start_time: 40, end_time: 20612, definite: false, text: 'Bender. So the inverse always exists.', words: w(40, 300) },
    { end_time: 20271, definite: true, text: 'Lambda, so the inverse always exists.', words: w(80, 300) },
  ])
    srv.conns[0].ws.send(result({ result: { utterances: [u] } }))
  await until(() => got.some((x) => x[0] === 'final'))
  await asr.close()
  assert.deepEqual(got.filter((x) => x[0] !== 'status').map((x) => x.slice(0, 3)), [
    ['partial', '~0', 'Bender. So.'],
    ['drop', '~0'],
    ['partial', '40', 'Bender. So the inverse always exists.'],
    ['drop', '40'],
    ['final', '~0', 'Lambda, so the inverse always exists.'],
  ])
  srv.close()
})

// 引擎接上真的 VolcStreamASR（连假服务器）：只录电脑声音，不翻译、不答题
async function volcEngine(srv) {
  const cfg = applyPatch(merge(DEFAULTS, {}), { engine: 'volc', volcAppId: 'a', volcAccessToken: 't', captureMic: false, translate: false, terms: { enabled: false }, assist: { enabled: false } })
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  let session
  const store = { create: (meta) => (session = { id: 't', startedAt: Date.now() - 1, segments: [], ...meta }), scheduleSave() {}, saveNow() {}, remove: async () => {} }
  const engine = new MeetingEngine({ settings, store, rendererCapture: null, createProvider: () => new VolcStreamASR({ appId: 'a', accessToken: 't', url: srv.url, timing: QUIET }) })
  engine.useFakeSources({ system: true })
  const notices = []
  const segs = []
  engine.on('notice', (n) => notices.push(n))
  engine.on('segment', (x) => segs.push(structuredClone(x)))
  await engine.start({ mode: 'meeting' })
  return { engine, notices, segs, session: () => session }
}

test('volc + engine: a 45000081 in the middle of a meeting shows "reconnecting", keeps recording and re-recognizes the unfinished line', async (t) => {
  const srv = await fakeVolc()
  const { engine, notices, segs, session } = await volcEngine(srv)
  t.after(() => srv.close())
  for (let i = 1; i <= 10; i++) engine.feed('system', chunk(i * 100))
  await until(() => bytesOf(srv.conns[0]) >= 32000)
  srv.conns[0].ws.send(result({ result: { utterances: [{ text: 'We ran the ablation.', start_time: 0, end_time: 400, definite: true }] } }))
  srv.conns[0].ws.send(result({ result: { utterances: [{ text: 'Could you', start_time: 500, end_time: 900, definite: false }] } }))
  await until(() => segs.some((x) => x.text === 'Could you'))
  srv.conns[0].ws.send(errorFrame(45000081, '[Timeout waiting next packet] waiting next packet timeout: 8.000000 seconds, session has ended'))
  await until(() => srv.conns.length === 2 && srv.conns[1].packets.length > 0)
  assert.equal(engine.state, 'running')
  assert.deepEqual(notices.map((n) => n.code), ['reconnecting', 'reconnected'])
  assert.equal(notices[0].text, '识别连接断了，正在重连…')
  // 旧连接上没说完的那句作废，新连接从 400ms 重认
  assert.ok(segs.some((x) => x.dropped === 'revised' && x.droppedText === 'Could you'))
  srv.conns[1].ws.send(result({ result: { utterances: [{ text: 'Could you walk me through it?', start_time: 100, end_time: 800, definite: true }] } }))
  await until(() => session().segments.length === 2)
  assert.deepEqual(session().segments.map((x) => x.text), ['We ran the ablation.', 'Could you walk me through it?'])
  await engine.stop()
})

test('volc + engine: a fatal error (bad request) still ends the meeting with the error shown', async () => {
  const srv = await fakeVolc()
  const { engine, notices } = await volcEngine(srv)
  await until(() => srv.conns[0]?.request)
  srv.conns[0].ws.send(errorFrame(45000001, 'invalid request'))
  await until(() => engine.state === 'idle')
  assert.ok(notices.some((n) => n.level === 'error' && n.text.includes('45000001')))
  srv.close()
})
