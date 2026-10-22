import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { OpenAIRealtimeASR } from '../src/main/asr/openai.js'
import zlib from 'node:zlib'
import { VolcStreamASR, handshakeError, utteranceKey, utteranceStart } from '../src/main/asr/volc.js'

// 两个识别服务都用本地假服务器，只验证「识别结果对应哪一段音频」的换算。

function listen(onConnection) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => resolve(wss))
    wss.on('connection', onConnection)
  })
}

const next = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve))

test('openai: the n-th committed event maps to the n-th endTurn span; empty commits are skipped', async () => {
  let n = 0
  const wss = await listen((ws) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString())
      if (m.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }))
      if (m.type !== 'input_audio_buffer.commit') return
      n++
      if (n === 2) {
        ws.send(JSON.stringify({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'empty' } }))
        return
      }
      const item = `item_${n}`
      ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: item, delta: 'hello ' }))
      ws.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: item }))
      ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: `hello ${n}` }))
    })
  })
  const asr = new OpenAIRealtimeASR({ key: 'k', baseUrl: `http://127.0.0.1:${wss.address().port}/v1`, model: 'gpt-live-transcribe' })
  await asr.connect()
  const finals = []
  asr.on('final', (f) => finals.push(f))
  asr.endTurn({ start: 0, end: 1500 })
  await next(asr, 'final')
  asr.endTurn({ start: 1500, end: 1800 }) // 服务端说是空的
  asr.endTurn({ start: 2000, end: 4200 })
  await next(asr, 'final')
  assert.deepEqual(finals.map((f) => [f.text, f.span]), [
    ['hello 1', { start: 0, end: 1500 }],
    ['hello 3', { start: 2000, end: 4200 }],
  ])
  asr.closing = true
  asr.conn.ws.close()
  wss.close()
})

function volcFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj))
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length)
  return Buffer.concat([Buffer.from([0x11, 0x90, 0x10, 0]), size, payload])
}

test('volc: utterance times are shifted by where this connection started in the stream', async () => {
  let sock
  const wss = await listen((ws) => (sock = ws))
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: `ws://127.0.0.1:${wss.address().port}` })
  const ready = asr.connect()
  // 连接还没好时送的 200ms 音频被丢掉了，但时间照算：这条连接从第 200ms 开始
  asr.sendAudio(Buffer.alloc(3200))
  asr.sendAudio(Buffer.alloc(3200))
  await ready
  asr.sendAudio(Buffer.alloc(3200))
  await new Promise((r) => setTimeout(r, 50))
  const got = []
  asr.on('partial', (e) => got.push(['partial', e.text, e.span]))
  asr.on('final', (e) => got.push(['final', e.text, e.span]))
  sock.send(volcFrame({ result: { utterances: [{ text: 'hi', start_time: 100, end_time: 400, definite: false }] } }))
  sock.send(volcFrame({ result: { utterances: [{ text: 'hi there', start_time: 100, end_time: 900, definite: true }] } }))
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(got, [
    ['partial', 'hi', { start: 300, end: 600 }],
    ['final', 'hi there', { start: 300, end: 1100 }],
  ])
  asr.closing = true
  asr.conn.ws.close()
  wss.close()
})

test('volc: a partial whose start moved into a revised utterance is dropped, not finalized at close', async () => {
  let sock
  const wss = await listen((ws) => (sock = ws))
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: `ws://127.0.0.1:${wss.address().port}` })
  await asr.connect()
  asr.sendAudio(Buffer.alloc(3200))
  await new Promise((r) => setTimeout(r, 50))
  const got = []
  asr.on('partial', (e) => got.push(['partial', e.text]))
  asr.on('final', (e) => got.push(['final', e.text]))
  asr.on('drop', (e) => got.push(['drop', e.key.split(':')[1]]))
  sock.send(volcFrame({ result: { utterances: [{ text: '2.', start_time: 17362, end_time: 17442, definite: false }] } }))
  sock.send(volcFrame({ result: { utterances: [{ text: '2N.', start_time: 17222, end_time: 17682, definite: true }] } }))
  sock.send(volcFrame({ result: { utterances: [{ text: 'Times the sum', start_time: 18572, end_time: 19000, definite: false }] } }))
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(got, [
    ['partial', '2.'],
    ['drop', '17362'],
    ['final', '2N.'],
    ['partial', 'Times the sum'],
  ])
  assert.deepEqual([...asr.conn.open.keys()].map((k) => k.split(':')[1]), ['18572'])
  asr.closing = true
  asr.conn.ws.close()
  wss.close()
})

test('volc: a 403 "requested resource not granted" says the Volcengine resource is not enabled or used up, not a wrong key', async () => {
  const body = '{"error":"[resource_id=volc.bigasr.sauc.duration] requested resource not granted"}'
  const server = http.createServer()
  server.on('upgrade', (_req, socket) => {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', resourceId: 'volc.bigasr.sauc.duration', url: `ws://127.0.0.1:${server.address().port}` })
  asr.on('fatal', () => {})
  const err = await asr.connect().then(() => null, (e) => e)
  server.close()
  assert.ok(err)
  assert.match(err.message, /^火山引擎账号的流式识别资源没开通或用完了，去火山引擎控制台看看/)
  assert.match(err.message, /volc\.bigasr\.sauc\.duration/)
  assert.match(err.message, /HTTP 403：requested resource not granted/)
  assert.doesNotMatch(err.message, /App ID|Access Token|Key/)
  assert.match(handshakeError(401, '{"error":"invalid access token"}'), /App ID 或 Access Token 不对/)
  assert.match(handshakeError(503, ''), /暂时不可用/)
})

// 连上假服务器，拿到客户端发的第一帧（完整请求，gzip 的 JSON）
async function volcRequest(resourceId) {
  let first
  const wss = await listen((ws) => ws.once('message', (d) => (first = d)))
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', resourceId, url: `ws://127.0.0.1:${wss.address().port}` })
  await asr.connect()
  await new Promise((r) => setTimeout(r, 50))
  asr.closing = true
  asr.conn.ws.close()
  wss.close()
  const size = first.readUInt32BE(4)
  return JSON.parse(zlib.gunzipSync(first.subarray(8, 8 + size)).toString('utf8'))
}

test('volc: 2.0 (seedasr) asks for the two-pass final (enable_nonstream), 1.0 does not', async () => {
  const two = await volcRequest('volc.seedasr.sauc.duration')
  assert.equal(two.request.enable_nonstream, true)
  assert.equal(two.request.show_utterances, true)
  const one = await volcRequest('volc.bigasr.sauc.duration')
  assert.equal('enable_nonstream' in one.request, false)
})

// 按顺序发几帧，收 partial / final 事件
async function volcRun(frames) {
  let sock
  const wss = await listen((ws) => (sock = ws))
  const asr = new VolcStreamASR({ appId: 'a', accessToken: 't', url: `ws://127.0.0.1:${wss.address().port}` })
  await asr.connect()
  asr.sendAudio(Buffer.alloc(3200)) // 连接从这一路的第 0 毫秒开始
  await new Promise((r) => setTimeout(r, 50))
  const got = []
  asr.on('partial', (e) => got.push(['partial', e.key.split(':')[1], e.text, e.span]))
  asr.on('final', (e) => got.push(['final', e.key.split(':')[1], e.text, e.span]))
  asr.on('drop', (e) => got.push(['drop', e.key.split(':')[1]]))
  for (const f of frames) sock.send(volcFrame({ result: { utterances: f } }))
  await new Promise((r) => setTimeout(r, 100))
  asr.closing = true
  asr.conn.ws.close()
  wss.close()
  return got
}

const w = (start, end, text) => ({ start_time: start, end_time: end, text })

test('volc: 2.0 frames without start_time (the first sentence starts at 0) keep one key from partial to the two-pass final', async () => {
  // 实测的 2.0 帧：连接里第一句没有 start_time，词的时间在 partial 和定稿之间会变；后面的句子有 start_time
  const got = await volcRun([
    [{ end_time: 500, definite: false, text: 'We ran.', words: [w(340, 500, 'We'), w(-1, -1, ' ')] }],
    [{ end_time: 1499, definite: false, text: 'We ran the adalion.', words: [w(200, 440, 'We'), w(440, 700, 'ran')] }],
    [{ end_time: 4312, definite: true, text: 'We ran the ablation study on the WebVision dataset last week.', words: [w(80, 300, 'We')] }],
    [{ start_time: 5302, end_time: 6202, definite: false, text: 'The Bon.', words: [w(5502, 5800, 'The')] }],
    [{ start_time: 5302, end_time: 9652, definite: true, text: ' The Bonferroni correction changes the p values quite a lot.', words: [w(5382, 5600, 'The')] }],
    // 定稿过的第一句又来一遍（没有起点，终点不在上一句定稿之后）：不再当成新的一句
    [{ end_time: 4312, definite: true, text: 'We ran the ablation study on the WebVision dataset last week.' }],
    [{ end_time: 11502, definite: false, text: 'Could you?', words: [w(10902, 11100, 'Could')] }],
    [{ end_time: 13282, definite: true, text: 'Could you send me the revised table by Friday?', words: [w(10862, 11100, 'Could')] }],
  ])
  assert.deepEqual(got, [
    ['partial', '~0', 'We ran.', { start: 340, end: 500 }],
    ['partial', '~0', 'We ran the adalion.', { start: 200, end: 1499 }],
    ['final', '~0', 'We ran the ablation study on the WebVision dataset last week.', { start: 80, end: 4312 }],
    ['partial', '5302', 'The Bon.', { start: 5302, end: 6202 }],
    ['final', '5302', 'The Bonferroni correction changes the p values quite a lot.', { start: 5302, end: 9652 }],
    ['partial', '~9652', 'Could you?', { start: 10902, end: 11502 }],
    ['final', '~9652', 'Could you send me the revised table by Friday?', { start: 10862, end: 13282 }],
  ])
})

test('volc: 1.0 frames with start_time 0 and an empty trailing utterance behave as before', async () => {
  const got = await volcRun([
    [{ start_time: 0, end_time: 500, definite: false, text: 'We ran.' }],
    [
      { start_time: 0, end_time: 4312, definite: true, text: 'We ran the adalion study on the Web Vision dataset last week.' },
      { start_time: -1, end_time: -1, definite: false, text: '' },
    ],
    [{ start_time: 5302, end_time: 9652, definite: true, text: 'The bonfire only correction changes the p values quite a lot.' }],
  ])
  assert.deepEqual(got, [
    ['partial', '0', 'We ran.', { start: 0, end: 500 }],
    ['final', '0', 'We ran the adalion study on the Web Vision dataset last week.', { start: 0, end: 4312 }],
    ['final', '5302', 'The bonfire only correction changes the p values quite a lot.', { start: 5302, end: 9652 }],
  ])
  assert.equal(utteranceKey('c', { start_time: 0 }), 'c:0')
  assert.equal(utteranceKey('c', { end_time: 900 }, 4312), 'c:~4312')
  assert.equal(utteranceStart({ start_time: -1, words: [w(-1, -1, ' '), w(120, 300, 'Hi')] }), 120)
  assert.equal(utteranceStart({ end_time: 900 }, 4312), 4312)
})
