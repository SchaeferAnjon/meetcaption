import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { Member, memberSettings } from '../src/main/member/client.js'
import { VolcStreamASR } from '../src/main/asr/volc.js'
import { DEFAULTS, merge } from '../src/main/defaults.js'
import { compatConfig, llmStatus } from '../src/main/llm/index.js'

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-member-')), 'member.json')

// 假的会员服务器：按路径回固定内容，记下收到的请求
function fakeFetch(routes) {
  const calls = []
  const f = async (url, init) => {
    const p = new URL(url).pathname
    calls.push({ p, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null })
    const r = routes[p]?.(init, calls) ?? { status: 404, body: { error: { code: 'not-found', message: 'nope' } } }
    return { ok: r.status === 200, status: r.status, json: async () => r.body }
  }
  return { f, calls }
}

test('第一次用领试用、存令牌；令牌失效时自动重新领一次', async () => {
  let n = 0
  const { f, calls } = fakeFetch({
    '/v1/trial/start': () => ({ status: 200, body: { token: `mcd_${++n}`, trial: 'granted', kind: 'trial', balance: 3, code: null } }),
    '/v1/license/status': (init) =>
      init.headers.Authorization === 'Bearer mcd_1' ? { status: 401, body: { error: { code: 'bad-device', message: 'x' } } } : { status: 200, body: { kind: 'trial', balance: 3 } },
  })
  const file = tmpFile()
  const m = new Member({ file, fetch: f, fingerprint: async () => 'ab'.repeat(32), api: 'https://api.test' })
  const snap = await m.refresh()
  assert.equal(snap.info.balance, 3)
  assert.equal(calls[0].body.device, 'ab'.repeat(32))
  // mcd_1 第一次领到，查状态时被告知失效 → 重新领到 mcd_2 再查
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'mcd_2')
  assert.deepEqual(
    calls.map((c) => c.p),
    ['/v1/trial/start', '/v1/license/status', '/v1/trial/start', '/v1/license/status'],
  )
})

test('一场：开始拿到票，心跳带着是否在记录，用完、自动暂停、进入下一场发事件；结束清掉', async () => {
  let hb = { remainingMs: 7000_000, charged: 1, exhausted: false, idle: false, balance: 2 }
  const { f, calls } = fakeFetch({
    '/v1/trial/start': () => ({ status: 200, body: { token: 'mcd_x', kind: 'trial', balance: 3 } }),
    '/v1/session/start': () => ({ status: 200, body: { session: 'mcs_1', sessionId: 7, remainingMs: 7200_000, charged: 1, balance: 2 } }),
    '/v1/session/heartbeat': () => ({ status: 200, body: hb }),
    '/v1/session/end': () => ({ status: 200, body: { balance: 3, refunded: true } }),
  })
  const m = new Member({ file: tmpFile(), fetch: f, fingerprint: async () => 'cd'.repeat(32), api: 'https://api.test', heartbeatMs: 1e9 })
  await m.startSession()
  assert.equal(m.aiKey(), 'mcs_1')
  const events = []
  m.on('session', (e) => events.push(e.type))
  m.setRunning(false)
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.at(-1).body.running, false)
  hb = { ...hb, charged: 2 }
  await m.heartbeat()
  hb = { ...hb, idle: true }
  await m.heartbeat()
  hb = { ...hb, exhausted: true }
  await m.heartbeat()
  assert.deepEqual(events, ['rolled', 'idle', 'exhausted'])
  const r = await m.endSession()
  assert.equal(r.refunded, true)
  assert.equal(m.session, null)
  assert.equal(m.aiKey(), 'mcd_x', '时间用完的那场服务器不再给 AI，会后改用设备令牌（没用完的见 member-ai.test.js）')
  m.stop()
})

test('会员模式的实际设置：识别换成 Soniox（向服务器换临时 Key），AI 换成会员通道；场次不够退回本地、试用用完关 AI', async () => {
  const s = merge(DEFAULTS, { plan: 'member', llmProvider: 'openai', engine: 'local', sonioxKey: 'mine' })
  const m = { session: { token: 'mcs_1' }, aiKey: () => 'mcs_1', asrKey: async () => ({ key: 'temp:1', maxMs: 900_000 }), noAi: false, fallback: false }
  const e = memberSettings(s, m)
  assert.equal(e.engine, 'soniox')
  assert.equal(e.sonioxKey, '', '不用自己填的 Key')
  assert.deepEqual(await e.sonioxGetKey(), { key: 'temp:1', maxMs: 900_000 })
  const cfg = compatConfig(e)
  assert.match(cfg.baseUrl, /\/v1$/)
  assert.equal(cfg.key, 'mcs_1')
  assert.equal(llmStatus(e).ready, true)
  assert.equal(llmStatus(e).label, 'MeetCaption 会员')
  assert.equal(memberSettings({ ...s, memberAsr: 'local' }, m).engine, 'local')
  assert.equal(memberSettings(s, { ...m, fallback: true }).engine, 'local')
  const none = memberSettings(s, { session: null, aiKey: () => '', noAi: true, fallback: true })
  assert.equal(llmStatus(none).ready, false)
  // 自带 Key 的不动
  assert.equal(memberSettings({ ...s, plan: 'own' }, m).engine, 'local')
})

test('识别：会员服务器用关闭码 4008 停掉（没说话自动暂停）时不重连，发 member 事件；握手被拒（场次用完）也一样', async () => {
  const srv = http.createServer()
  const wss = new WebSocketServer({ noServer: true })
  let conns = 0
  let reject = false
  srv.on('upgrade', (req, socket, head) => {
    if (reject) {
      socket.end('HTTP/1.1 402 Error\r\nX-Api-Message: exhausted\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      conns++
      ws.once('message', () => setTimeout(() => ws.close(4008, 'idle'), 20))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `ws://127.0.0.1:${srv.address().port}/v1/asr`
  const asr = new VolcStreamASR({ appId: 'member', accessToken: 'mcs_1', url, timing: { retryBaseMs: 10, retryMaxMs: 20 } })
  const got = new Promise((r) => asr.once('member', r))
  let fatal = null
  asr.on('fatal', (e) => (fatal = e))
  await asr.connect()
  asr.sendAudio(Buffer.alloc(3200))
  assert.equal(await got, 'idle')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(conns, 1, '没有重连')
  assert.equal(fatal, null)
  await asr.close()

  reject = true
  const asr2 = new VolcStreamASR({ appId: 'member', accessToken: 'mcs_1', url })
  const got2 = new Promise((r) => asr2.once('member', r))
  asr2.on('fatal', (e) => (fatal = e))
  await asr2.connect().catch(() => {})
  assert.equal(await got2, 'exhausted')
  assert.equal(fatal, null)
  await asr2.close()
  wss.close()
  srv.close()
})
