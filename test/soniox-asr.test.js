import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { SonioxStreamASR, sonioxHints } from '../src/main/asr/soniox.js'

// Soniox 实时识别：本地假服务器记下每条连接的鉴权、配置和收到的音频，测试按需回 token 或错误。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('等太久了')
    await sleep(10)
  }
}

// 每条连接 { ws, auth, config, bytes, text: 收到过空文本帧（结束） }
async function fakeSoniox(t) {
  const conns = []
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    const c = { ws, auth: req.headers.authorization, config: null, bytes: 0, ended: false, finalize: 0 }
    conns.push(c)
    ws.on('message', (d, binary) => {
      if (binary) return (c.bytes += d.length)
      const s = String(d)
      if (s === '') {
        c.ended = true
        ws.send(JSON.stringify({ tokens: [], finished: true }))
        return ws.close()
      }
      const m = JSON.parse(s)
      if (m.type === 'finalize') c.finalize++
      else c.config = m
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${server.address().port}/`
  const send = (c, tokens, extra = {}) => c.ws.send(JSON.stringify({ tokens, ...extra }))
  const close = () => (wss.close(), server.close())
  t.after(close)
  return { conns, url, send, close: () => {} }
}

const tok = (text, start, end, final = true) => ({ text, start_ms: start, end_ms: end, is_final: final })
const second = Buffer.alloc(32000) // 1 秒 16k 单声道

function collect(asr) {
  const ev = []
  for (const name of ['partial', 'final', 'drop', 'member', 'fatal', 'status']) asr.on(name, (x) => ev.push({ name, ...(typeof x === 'object' && !(x instanceof Error) ? x : { value: x?.message ?? x }) }))
  return ev
}

test('语言提示：中英和自动给两个，其他语言给一个，繁体按中文', () => {
  assert.deepEqual(sonioxHints('auto'), ['zh', 'en'])
  assert.deepEqual(sonioxHints('zh'), ['zh', 'en'])
  assert.deepEqual(sonioxHints('de'), ['de'])
  assert.deepEqual(sonioxHints('zh-Hant'), ['zh'])
})

test('自带 Key：鉴权放在请求头，配置带语言、术语和背景；没定稿的尾巴每条回复整段替换，<end> 出整句', async (t) => {
  const f = await fakeSoniox(t)
  const asr = new SonioxStreamASR({ key: 'sk-mine', language: 'de', context: '季度会议', hotwords: ['Döllner'], url: f.url })
  const ev = collect(asr)
  await asr.connect()
  await until(() => f.conns[0]?.config)
  const c = f.conns[0]
  assert.equal(c.auth, 'Bearer sk-mine')
  assert.equal(c.config.api_key, undefined, 'Key 不放在配置里（2027 年起不认）')
  assert.deepEqual(c.config.language_hints, ['de'])
  assert.equal(c.config.enable_endpoint_detection, true)
  assert.deepEqual(c.config.context, { text: '季度会议', terms: ['Döllner'] })
  asr.sendAudio(second)
  await until(() => c.bytes === 32000)
  f.send(c, [tok('Guten', 100, 400, false)])
  f.send(c, [tok('Guten', 100, 400), tok(' Mor', 450, 600, false)])
  f.send(c, [tok(' Morgen', 450, 800), tok('.', 800, 820), { text: '<end>', is_final: true }])
  await until(() => ev.some((e) => e.name === 'final'))
  const parts = ev.filter((e) => e.name === 'partial').map((e) => e.text)
  assert.deepEqual(parts, ['Guten', 'Guten Mor'], '句末和最后几个字同一条回复来：直接出整句，不再多一条 partial')
  const fin = ev.find((e) => e.name === 'final')
  assert.equal(fin.text, 'Guten Morgen.', '上一条的尾巴「 Mor」不能再拼上')
  assert.deepEqual(fin.span, { start: 100, end: 820 })
  await asr.close()
  assert.equal(c.ended, true, '关的时候送空文本帧结束')
  f.close()
})

test('断线：这一句已定稿的字发出去，从最后一个定稿的字的终点补发；没定稿的尾巴新连接重认', async (t) => {
  const f = await fakeSoniox(t)
  const asr = new SonioxStreamASR({ key: 'k', url: f.url })
  const ev = collect(asr)
  await asr.connect()
  for (let i = 0; i < 3; i++) asr.sendAudio(second)
  await until(() => f.conns[0].bytes === 96000)
  f.send(f.conns[0], [tok('你好', 200, 1500), tok('世界', 1600, 2400, false)])
  await until(() => ev.some((e) => e.name === 'partial'))
  f.conns[0].ws.terminate()
  await until(() => f.conns[1]?.bytes > 0)
  const fin = ev.find((e) => e.name === 'final')
  assert.equal(fin.text, '你好')
  assert.deepEqual(fin.span, { start: 200, end: 1500 })
  // 补发从 1.5 秒起：3 秒音频还剩 1.5 秒 = 48000 字节
  await until(() => f.conns[1].bytes === 48000)
  f.send(f.conns[1], [tok('世界', 100, 900), { text: '<end>', is_final: true }])
  await until(() => ev.filter((e) => e.name === 'final').length === 2)
  const second2 = ev.filter((e) => e.name === 'final')[1]
  assert.equal(second2.text, '世界')
  assert.deepEqual(second2.span, { start: 1600, end: 2400 }, '新连接的时间加上补发起点')
  assert.ok(ev.some((e) => e.name === 'status' && e.value === 'reconnecting'))
  await asr.close()
  f.close()
})

test('自带 Key 不对（401）：不重连，报致命错误', async (t) => {
  const f = await fakeSoniox(t)
  const asr = new SonioxStreamASR({ key: 'bad', url: f.url })
  const ev = collect(asr)
  await asr.connect()
  await until(() => f.conns[0]?.config)
  f.send(f.conns[0], [], { error_code: 401, error_message: 'Incorrect API key provided' })
  await until(() => ev.some((e) => e.name === 'fatal'))
  assert.match(ev.find((e) => e.name === 'fatal').value, /Key 无效/)
  await sleep(100)
  assert.equal(f.conns.length, 1)
  await asr.close()
  f.close()
})

test('会员：每条连接换一把临时 Key；快到点在句末换连接；一直有人说就先 finalize 再换；服务器不给了交给上层', async (t) => {
  const f = await fakeSoniox(t)
  const keys = []
  let refuse = null
  const getKey = async () => {
    if (refuse) throw Object.assign(new Error('场次用完'), { code: refuse })
    keys.push(`temp:${keys.length + 1}`)
    return { key: keys.at(-1), maxMs: 400 }
  }
  const asr = new SonioxStreamASR({ getKey, url: f.url, timing: { rotateBeforeMs: 200, forceBeforeMs: 100 } })
  const ev = collect(asr)
  await asr.connect()
  assert.equal(f.conns[0].auth, 'Bearer temp:1')
  asr.sendAudio(second)
  // 300ms 后（过了 rotateAt）句末：换新连接，新连接用第二把 Key
  await sleep(320)
  f.send(f.conns[0], [tok('一', 0, 300), { text: '<end>', is_final: true }])
  await until(() => f.conns[1]?.auth === 'Bearer temp:2')
  // 一直在说：到 forceAt 还没句末，就发 finalize；<fin> 回来以后换
  asr.sendAudio(second)
  await sleep(320)
  f.send(f.conns[1], [tok('二', 0, 200, false)])
  await until(() => f.conns[1].finalize === 1)
  f.send(f.conns[1], [tok('二', 0, 200), { text: '<fin>', is_final: true }])
  await until(() => f.conns[2]?.auth === 'Bearer temp:3')
  assert.deepEqual(ev.filter((e) => e.name === 'final').map((e) => e.text), ['一', '二'])
  // 服务器说连接太多（老断线的人前面的 Key 还没过期）：接着退避重连，不交给上层
  refuse = 'too-many'
  f.conns[2].ws.terminate()
  await sleep(1300)
  assert.ok(!ev.some((e) => e.name === 'member'))
  refuse = null
  await until(() => f.conns[3]?.auth === 'Bearer temp:4', 5000)
  // 服务器不再给 Key（场次用完）：不再重连，发 member
  refuse = 'exhausted'
  f.conns[3].ws.terminate()
  await until(() => ev.some((e) => e.name === 'member'), 6000) // 前面几次没连上、这条又连上不久就断：间隔没清零，退到 4 秒
  assert.equal(ev.find((e) => e.name === 'member').value, 'exhausted')
  await sleep(100)
  assert.equal(f.conns.length, 4)
  await asr.close()
  f.close()
})

test('服务器握手后马上断开：重连间隔 0、1、2 秒往上退，不发「重新连上」；服务器好了，新连接连够 stableMs 才发 ready、间隔清零', async (t) => {
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  const mode = { flap: true, count: 0 }
  wss.on('connection', (ws) => {
    mode.count++
    if (mode.flap) ws.terminate()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => (wss.close(), server.close()))
  const asr = new SonioxStreamASR({ key: 'sk', url: `ws://127.0.0.1:${server.address().port}/`, timing: { watchMs: 50, stableMs: 200 } })
  const ev = collect(asr)
  await asr.connect()
  const t0 = Date.now()
  await sleep(2600)
  // 以前每秒几百次：现在 0 秒、1 秒、3 秒各一次
  assert.ok(mode.count >= 3 && mode.count <= 5, `连了 ${mode.count} 次`)
  assert.ok(!ev.some((e) => e.value === 'ready'))
  assert.equal(asr.steady, false)
  assert.ok(asr.flaps >= 2)
  mode.flap = false
  await until(() => ev.some((e) => e.value === 'ready'), 5000)
  assert.ok(Date.now() - t0 >= 3000, '要等到下一次重连（第 3 秒）')
  assert.equal(asr.steady, true)
  assert.equal(asr.flaps, 0)
  assert.equal(asr.retries, 0)
  await asr.close()
})
