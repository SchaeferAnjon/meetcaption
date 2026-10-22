import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import { SpeechGate } from '../src/main/audio/gate.js'
import { decodeFrame } from '../src/main/asr/volc.js'
import { splitSentences, isMostlyChinese } from '../src/main/text.js'
import { transcriptText, clock } from '../src/main/prompts.js'

const RATE = 16000
function tone(ms, amp = 8000) {
  const n = (RATE * ms) / 1000
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2)
  return b
}
const silence = (ms) => Buffer.alloc(((RATE * ms) / 1000) * 2)

function run(gate, bufs) {
  const ops = []
  for (const b of bufs) for (let o = 0; o < b.length; o += 3200) ops.push(...gate.push(b.subarray(o, o + 3200)).ops)
  return ops
}

test('gate: silence sends nothing', () => {
  const ops = run(new SpeechGate({ sampleRate: RATE }), [silence(2000)])
  assert.equal(ops.length, 0)
})

test('gate: speech is sent with pre-roll and a turn ends after the pause', () => {
  const ops = run(new SpeechGate({ sampleRate: RATE }), [silence(1000), tone(1500), silence(1200)])
  const sent = ops.filter((o) => o.audio).reduce((a, o) => a + o.audio.length, 0)
  const ends = ops.filter((o) => o.endTurn).length
  assert.equal(ends, 1)
  // 1.5s 语音 + 0.4s 预录 + 0.8s 停顿，允许一帧误差
  assert.ok(Math.abs(sent / 2 / RATE - 2.7) < 0.05, `sent ${sent / 2 / RATE}s`)
  const lastAudio = ops.findLastIndex((o) => o.audio)
  assert.ok(ops.findIndex((o) => o.endTurn) > lastAudio - 1, 'endTurn comes after the audio of the turn')
})

test('gate: short pauses inside speech do not end the turn', () => {
  const ops = run(new SpeechGate({ sampleRate: RATE }), [tone(800), silence(400), tone(800), silence(300)])
  assert.equal(ops.filter((o) => o.endTurn).length, 0)
})

test('gate: odd byte offsets are handled', () => {
  const gate = new SpeechGate({ sampleRate: RATE })
  const b = Buffer.concat([Buffer.alloc(1), tone(500)]).subarray(1)
  assert.doesNotThrow(() => gate.push(b))
})

test('volc: decodes a gzip JSON response with sequence number', () => {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ result: { text: 'hi' } })))
  const seq = Buffer.alloc(4)
  seq.writeInt32BE(3)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length)
  const frame = Buffer.concat([Buffer.from([0x11, 0b10010001, 0x11, 0]), seq, size, payload])
  const f = decodeFrame(frame)
  assert.equal(f.type, 0b1001)
  assert.equal(JSON.parse(f.payload.toString()).result.text, 'hi')
})

test('volc: decodes an error frame', () => {
  const msg = Buffer.from('bad auth')
  const code = Buffer.alloc(4)
  code.writeUInt32BE(45000001)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(msg.length)
  const f = decodeFrame(Buffer.concat([Buffer.from([0x11, 0xf0, 0x10, 0]), code, size, msg]))
  assert.equal(f.code, 45000001)
  assert.equal(f.payload.toString(), 'bad auth')
})

test('sentences split for English and Chinese', () => {
  assert.deepEqual(splitSentences('Okay, so about the paper. Send it by Friday. Then'), ['Okay, so about the paper.', 'Send it by Friday.', 'Then'])
  assert.deepEqual(splitSentences('好的。下周五之前发给我。', 'zh'), ['好的。', '下周五之前发给我。'])
  assert.ok(isMostlyChinese('请在下周五之前发给我'))
  assert.ok(!isMostlyChinese('Please send it by Friday'))
})

test('transcript text uses offsets from the meeting start', () => {
  const start = Date.UTC(2026, 8, 24, 10, 0, 0)
  const s = { startedAt: start, segments: [{ speaker: '对方', startedAt: start + 65_000, text: 'Hello' }, { speaker: '我', startedAt: start + 3_725_000, text: 'Hi' }] }
  assert.equal(transcriptText(s), '[01:05] 对方：Hello\n[1:02:05] 我：Hi')
  assert.equal(clock(0), '00:00')
})
