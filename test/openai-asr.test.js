import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'
import { OpenAIRealtimeASR, finalText } from '../src/main/asr/openai.js'
import { SpeechGate } from '../src/main/audio/gate.js'

// OpenAI 实时转写的断线和保活：本地假服务器按收到的音频块出字（每块音频里写着自己的编号 n，出 " wn"），
// commit 后回 committed 和 completed。能随时掐断连接、装死（不回 pong、不回消息）、拒绝握手。

const CHUNK = 4800 // 24 kHz 16 位的 100 毫秒

function chunk(n) {
  const b = Buffer.alloc(CHUNK)
  for (let i = 0; i < CHUNK; i += 2) b.writeInt16LE(n, i)
  return b
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(fn, ms = 3000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('等不到')
    await sleep(10)
  }
}

async function fakeServer({ autoPong = true } = {}) {
  const conns = []
  let reject = false
  const wss = await new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong, verifyClient: (_info, cb) => (reject ? cb(false, 503, 'busy') : cb(true)) }, () => resolve(s))
  })
  wss.on('connection', (ws) => {
    const c = { ws, no: conns.length + 1, got: [], pings: 0, silent: false, words: [], item: null, k: 0, transcript: null, hold: false, held: [] }
    conns.push(c)
    ws.on('ping', () => {
      c.pings++
      if (c.hold) c.held.push('ping')
      else if (!autoPong && c.pong) ws.pong()
    })
    // 上行卡住：hold 期间收到的东西先攒着（服务端还没收到），release 时按顺序处理，攒着的 ping 这时才回 pong
    c.release = () => {
      c.hold = false
      for (const d of c.held.splice(0)) d === 'ping' ? ws.pong() : ws.emit('message', d)
    }
    ws.on('message', (d) => {
      if (c.hold) return c.held.push(d)
      if (c.silent) return
      const m = JSON.parse(d.toString())
      c.got.push({ type: m.type, at: Date.now(), n: m.audio ? Buffer.from(m.audio, 'base64').readInt16LE(0) : null })
      if (m.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }))
      if (m.type === 'input_audio_buffer.append') {
        c.item ??= `item_${c.no}_${++c.k}`
        const w = `w${Buffer.from(m.audio, 'base64').readInt16LE(0)}`
        c.words.push(w)
        ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: c.item, delta: ` ${w}` }))
      }
      if (m.type === 'input_audio_buffer.commit') {
        if (!c.item) return ws.send(JSON.stringify({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'empty' } }))
        const item = c.item
        const transcript = c.transcript?.(c.words) ?? c.words.join(' ')
        c.item = null
        c.words = []
        ws.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: item }))
        ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript }))
      }
    })
  })
  return {
    wss,
    conns,
    url: `http://127.0.0.1:${wss.address().port}/v1`,
    setReject: (v) => (reject = v),
    close: () => {
      for (const c of conns) c.ws.terminate()
      wss.close()
    },
  }
}

// 测试里时间都缩短：积压按 50 倍速送，积压过的段最后一块送出 100 毫秒后 commit
const FAST = { replaySpeed: 50, lateMs: 150, commitHoldMs: 100, commitQuietMs: 50, commitMaxHoldMs: 400, retryGapMs: 30 }

function record(asr) {
  const ev = []
  asr.on('partial', (e) => ev.push(['partial', e.key, e.text]))
  asr.on('final', (e) => ev.push(['final', e.key, e.text, e.span]))
  asr.on('status', (s) => ev.push(['status', s]))
  return ev
}

// t.after 里收尾：断言失败时也关掉服务器，不然测试进程退不出去
async function make(t, srv, timing = {}) {
  const asr = new OpenAIRealtimeASR({ key: 'k', baseUrl: srv.url, model: 'gpt-live-transcribe', timing: { ...FAST, ...timing } })
  t.after(async () => {
    await asr.close()
    srv.close()
  })
  const ev = record(asr)
  await asr.connect()
  return { asr, ev }
}

test('openai: finalText keeps the received words when the completed transcript is far shorter', () => {
  assert.equal(finalText('Hello there.', ' Hello there'), 'Hello there.')
  assert.equal(finalText('', ' partial words so far'), 'partial words so far')
  const long = 'Good morning everyone. Today we continue with regularization in linear models.'
  assert.equal(finalText('linear models.', long), long) // completed 只剩尾巴：用收到的字
  assert.equal(finalText('in linear models.', '', long), long) // 重送前显示过的更长，也算
  assert.equal(finalText('ok', 'o k'), 'ok') // 很短的不比
})

test('openai: a turn cut by a dropped connection is sent again on the next one under the same key; nothing is lost or repeated', async (t) => {
  const srv = await fakeServer()
  const { asr, ev } = await make(t, srv)
  for (const n of [1, 2, 3]) asr.sendAudio(chunk(n))
  await until(() => ev.filter((e) => e[0] === 'partial').length === 3)
  srv.conns[0].ws.terminate() // 连接被对面重置（ECONNRESET）
  await until(() => ev.some((e) => e[1] === 'reconnecting'))
  for (const n of [4, 5]) asr.sendAudio(chunk(n)) // 重连期间还在说
  asr.endTurn({ start: 0, end: 500 })
  await until(() => ev.some((e) => e[0] === 'final'))
  const key = ev.find((e) => e[0] === 'partial')[1]
  assert.equal(key, 'item_1_1')
  const partials = ev.filter((e) => e[0] === 'partial')
  assert.ok(partials.every((e) => e[1] === key), '重送的段沿用原来的 key')
  for (let i = 1; i < partials.length; i++) assert.ok(partials[i][2].length >= partials[i - 1][2].length, '字幕不会先变短')
  assert.deepEqual(ev.filter((e) => e[0] === 'final'), [['final', key, 'w1 w2 w3 w4 w5', { start: 0, end: 500 }]])
  assert.deepEqual(ev.filter((e) => e[0] === 'status').map((e) => e[1]), ['ready', 'reconnecting', 'ready'])
  // 新连接上：五块音频按顺序从头送，commit 等最后一块送出 commitHoldMs 以后
  const got = srv.conns[1].got.filter((g) => g.type !== 'session.update')
  assert.deepEqual(got.map((g) => g.n ?? g.type), [1, 2, 3, 4, 5, 'input_audio_buffer.commit'])
  assert.ok(got[5].at - got[4].at >= FAST.commitHoldMs - 5)
})

test('openai: a backlog is sent at replaySpeed, not in one burst, and the next turn waits for its commit', async (t) => {
  const srv = await fakeServer()
  const { asr, ev } = await make(t, srv, { replaySpeed: 4 })
  srv.conns[0].ws.terminate()
  await until(() => ev.some((e) => e[1] === 'reconnecting'))
  srv.setReject(true) // 连不上：这 1 秒的话先存着
  await sleep(50)
  for (let n = 1; n <= 10; n++) asr.sendAudio(chunk(n))
  asr.endTurn({ start: 0, end: 1000 })
  asr.sendAudio(chunk(11))
  asr.endTurn({ start: 1000, end: 1100 })
  srv.setReject(false)
  await until(() => ev.filter((e) => e[0] === 'final').length === 2, 8000)
  const got = srv.conns.at(-1).got.filter((g) => g.type !== 'session.update')
  assert.deepEqual(got.map((g) => g.n ?? 'commit'), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'commit', 11, 'commit'])
  // 1 秒音频按 4 倍速大约 250 毫秒送完（令牌桶从 0 开始）
  assert.ok(got[9].at - got[0].at >= 150, `积压要按倍速送：${got[9].at - got[0].at}ms`)
  assert.deepEqual(
    ev.filter((e) => e[0] === 'final').map((e) => e[2]),
    ['w1 w2 w3 w4 w5 w6 w7 w8 w9 w10', 'w11'],
  )
})

test('openai: speech during the reconnect backoff reconnects at once instead of waiting', async (t) => {
  const srv = await fakeServer()
  const { asr, ev } = await make(t, srv)
  srv.setReject(true)
  srv.conns[0].ws.terminate()
  // 第一次立刻重连被拒，第二次退避 1 秒
  await until(() => asr.retryTimer && asr.failures >= 2)
  srv.setReject(false)
  const t0 = Date.now()
  asr.sendAudio(chunk(7))
  await until(() => srv.conns.length === 2)
  assert.ok(Date.now() - t0 < 500, `应该马上重连，实际等了 ${Date.now() - t0}ms`)
  asr.endTurn({ start: 0, end: 100 })
  await until(() => ev.some((e) => e[0] === 'final'))
  assert.equal(ev.find((e) => e[0] === 'final')[2], 'w7')
})

test('openai: at the start of a turn a connection that went quiet is probed and replaced; the turn arrives whole', async (t) => {
  const srv = await fakeServer({ autoPong: false })
  const { asr, ev } = await make(t, srv, { probeIdleMs: 100, probeWaitMs: 150, pingEveryMs: 60_000, deadAfterMs: 60_000 })
  srv.conns[0].silent = true // 半死：不回 pong、不回任何消息
  await sleep(150)
  asr.sendAudio(chunk(1))
  asr.sendAudio(chunk(2))
  await until(() => srv.conns.length === 2, 2000)
  asr.endTurn({ start: 0, end: 200 })
  await until(() => ev.some((e) => e[0] === 'final'))
  assert.ok(srv.conns[0].pings >= 1)
  assert.deepEqual(ev.filter((e) => e[0] === 'final').map((e) => e[2]), ['w1 w2'])
})

test('openai: a connection that goes quiet in the middle of a turn is probed and replaced; the whole turn arrives once', async (t) => {
  const srv = await fakeServer({ autoPong: false })
  const { asr, ev } = await make(t, srv, { probeIdleMs: 60_000, probeBusyMs: 150, probeWaitMs: 100, pingEveryMs: 60_000, deadAfterMs: 60_000 })
  for (let n = 1; n <= 3; n++) {
    asr.sendAudio(chunk(n))
    await sleep(50)
  }
  srv.conns[0].silent = true // 说着说着连接断在半路（NAT 表项没了）：服务端什么都收不到，也不回
  for (let n = 4; n <= 10; n++) {
    asr.sendAudio(chunk(n))
    await sleep(50)
  }
  asr.endTurn({ start: 0, end: 1000 })
  await until(() => ev.some((e) => e[0] === 'final'), 3000)
  assert.equal(srv.conns.length, 2)
  assert.deepEqual(ev.filter((e) => e[0] === 'final').map((e) => [e[1], e[2]]), [['item_1_1', 'w1 w2 w3 w4 w5 w6 w7 w8 w9 w10']])
})

test('openai: keepalive pings every pingEveryMs; a connection silent for deadAfterMs is replaced while idle', async (t) => {
  const srv = await fakeServer({ autoPong: false })
  const { asr, ev } = await make(t, srv, { pingEveryMs: 40, deadAfterMs: 200 })
  await sleep(150)
  assert.ok(srv.conns[0].pings >= 2, `应该有 ping：${srv.conns[0].pings}`)
  assert.equal(srv.conns.length, 1) // 还在出消息的连接（这里是握手后 150 毫秒内）不算死
  srv.conns[0].silent = true
  await until(() => srv.conns.length === 2, 2000)
  assert.ok(ev.some((e) => e[1] === 'reconnecting'))

  // 正常回 pong 的连接空闲再久也不换
  const ok = await fakeServer()
  const b = await make(t, ok, { pingEveryMs: 40, deadAfterMs: 200 })
  await sleep(500)
  assert.equal(ok.conns.length, 1)
  assert.ok(ok.conns[0].pings >= 8)
})

test('openai: a completed transcript far shorter than the streamed words does not wipe them', async (t) => {
  const srv = await fakeServer()
  const { asr, ev } = await make(t, srv)
  srv.conns[0].transcript = (words) => words.slice(-2).join(' ') // 服务端只给了最后两块
  for (let n = 1; n <= 8; n++) asr.sendAudio(chunk(n))
  asr.endTurn({ start: 0, end: 800 })
  await until(() => ev.some((e) => e[0] === 'final'))
  assert.equal(ev.find((e) => e[0] === 'final')[2], 'w1 w2 w3 w4 w5 w6 w7 w8')
})

test('openai: stop while reconnecting finishes the shown text instead of dropping it', async (t) => {
  const srv = await fakeServer()
  const { asr, ev } = await make(t, srv, { retryGapMs: 5000 })
  for (const n of [1, 2]) asr.sendAudio(chunk(n))
  await until(() => ev.filter((e) => e[0] === 'partial').length === 2)
  srv.setReject(true)
  srv.conns[0].ws.terminate()
  await until(() => ev.some((e) => e[1] === 'reconnecting'))
  await asr.close()
  assert.deepEqual(ev.filter((e) => e[0] === 'final').map((e) => [e[1], e[2]]), [['item_1_1', 'w1 w2']])
})

// 门限：讲课一口气说下去，句子之间只有 200 到 300 毫秒的停顿（到不了 800 毫秒），也要大约每 45 秒切一段
function lecture(rate, seconds, { pauseMs = 250, sentenceMs = 3000, noise = 0 } = {}) {
  const out = Buffer.alloc(rate * seconds * 2)
  let i = 0
  let t = 0
  while (i < rate * seconds) {
    const inPause = t % (sentenceMs + pauseMs) >= sentenceMs
    const v = inPause ? noise * (Math.random() - 0.5) : 0.3 * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate)
    out.writeInt16LE(Math.round(v), i * 2)
    i++
    t = (i * 1000) / rate
  }
  return out
}

function turnsOf(gate, buf, rate) {
  const cuts = []
  for (let o = 0; o < buf.length; o += rate / 5) for (const op of gate.push(buf.subarray(o, o + rate / 5)).ops) if (op.endTurn) cuts.push([op.start / rate, op.end / rate])
  return cuts
}

test('gate: a lecture with only short pauses is still cut about every 45 seconds, at a pause', () => {
  const rate = 24000
  const cuts = turnsOf(new SpeechGate({ sampleRate: rate }), lecture(rate, 100), rate)
  assert.equal(cuts.length, 2)
  for (const [a, b] of cuts) assert.ok(b - a >= 45 && b - a <= 49, `${a} 到 ${b}`)
  assert.ok(Math.abs(cuts[1][0] - cuts[0][1]) < 0.001, '下一段从上一段切开的地方接着算')
})

test('gate: with no usable pause at all (steady background), a turn is cut anyway 15 seconds after maxTurnMs', () => {
  const rate = 16000
  const steady = Buffer.alloc(rate * 62 * 2)
  for (let i = 0; i < rate * 62; i++) steady.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2)
  const cuts = turnsOf(new SpeechGate({ sampleRate: rate }), steady, rate)
  assert.equal(cuts.length, 1)
  assert.ok(Math.abs(cuts[0][1] - cuts[0][0] - 60) < 0.1, `${cuts[0][0]} 到 ${cuts[0][1]}`)
})

/* ---------------- 上行卡顿：ping 排在积压的音频后面回不来，不等于连接死了 ---------------- */

// 本机回环的系统缓冲区很大，积压出不来；这里直接改 ws 看到的积压和「系统收走的字节数」，模拟 Wi-Fi 上行卡住
function fakeUplink(ws) {
  const up = { backlog: 0, flushed: 0 }
  const sock = ws._socket
  Object.defineProperty(ws, 'bufferedAmount', { configurable: true, get: () => up.backlog })
  Object.defineProperty(sock, 'bytesWritten', { configurable: true, get: () => up.flushed + sock.writableLength })
  return up
}

const STALL = { probeIdleMs: 60_000, probeBusyMs: 150, probeWaitMs: 100, stallMs: 400, tickMs: 20, pingEveryMs: 60_000, deadAfterMs: 60_000 }

test('openai: an uplink stall with audio backed up in the socket is waited out, not reconnected; the turn arrives once', async (t) => {
  const srv = await fakeServer({ autoPong: false })
  const { asr, ev } = await make(t, srv, STALL)
  srv.conns[0].pong = true
  const up = fakeUplink(asr.conn.ws)
  for (let n = 1; n <= 3; n++) {
    asr.sendAudio(chunk(n))
    await sleep(40)
  }
  await until(() => ev.filter((e) => e[0] === 'partial').length === 3)
  // 上行卡住 700 毫秒：服务端什么都收不到，ws 里越积越多；前 450 毫秒一个字节都没走，后面慢慢往外走
  srv.conns[0].hold = true
  up.backlog = 20_000
  const t0 = Date.now()
  for (let n = 4; n <= 12; n++) {
    asr.sendAudio(chunk(n))
    const ms = Date.now() - t0
    if (ms < 450) up.backlog += 6000
    else {
      up.backlog = Math.max(up.backlog - 8000, 2000)
      up.flushed += 8000
    }
    await sleep(60)
  }
  assert.ok(Date.now() - t0 > STALL.stallMs, '卡住的时间要比 stallMs 长，才看得出「在走就接着等」')
  // 卡顿结束：积压发完，服务端一口气收到并回话
  up.flushed += up.backlog
  up.backlog = 0
  srv.conns[0].release()
  asr.endTurn({ start: 0, end: 1200 })
  await until(() => ev.some((e) => e[0] === 'final'))
  assert.equal(srv.conns.length, 1, '不该换连接')
  assert.ok(!ev.some((e) => e[1] === 'reconnecting'))
  assert.deepEqual(ev.filter((e) => e[0] === 'final').map((e) => e[2]), ['w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12'])
  assert.ok(srv.conns[0].pings >= 1, '卡住时探过活')
})

test('openai: audio backed up in the socket that does not move for stallMs replaces the connection; nothing is lost', async (t) => {
  const srv = await fakeServer({ autoPong: false })
  const { asr, ev } = await make(t, srv, STALL)
  srv.conns[0].pong = true
  const up = fakeUplink(asr.conn.ws)
  for (let n = 1; n <= 2; n++) asr.sendAudio(chunk(n))
  await until(() => ev.filter((e) => e[0] === 'partial').length === 2)
  srv.conns[0].hold = true // 从这里起上行彻底不通
  up.backlog = 30_000
  const t0 = Date.now()
  let probedAt = 0
  for (let n = 3; n <= 20 && srv.conns.length === 1; n++) {
    asr.sendAudio(chunk(n))
    up.backlog += 6000
    if (!probedAt && srv.conns[0].held.includes('ping')) probedAt = Date.now()
    await sleep(50)
  }
  await until(() => srv.conns.length === 2, 3000)
  const replacedAt = Date.now()
  assert.ok(probedAt > 0)
  // 没积压时 100 毫秒没回就换；积压一直不动要等满 stallMs
  assert.ok(replacedAt - t0 >= STALL.probeBusyMs + STALL.stallMs - 30, `换得太早：${replacedAt - t0}ms`)
  const sent = srv.conns[0].got.filter((g) => g.n != null).length
  asr.endTurn({ start: 0, end: 2000 })
  await until(() => ev.some((e) => e[0] === 'final'), 3000)
  const final = ev.find((e) => e[0] === 'final')[2].split(' ')
  assert.deepEqual(final, final.map((_, i) => `w${i + 1}`), '整段按顺序、不重复')
  assert.ok(final.length > sent)
})
