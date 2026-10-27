import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { LocalStreamASR } from '../src/main/asr/local.js'

// 本地识别（X-ASR）：模型吐出来的文字怎么整理、什么时候定稿、span 怎么算。识别器用假的 addon，不加载真模型。
const require = createRequire(import.meta.url)
const { cleanText, LocalChannel } = require('../src/main/asr/localCore.cjs')

test('local: 段首的标点（上一句的句末标点）去掉，中文标点后和汉字之间的空格去掉', () => {
  assert.equal(cleanText('， 因为感觉香港好多都深圳人， 你看着我像分不清嘛， 你都说我是北方人'), '因为感觉香港好多都深圳人，你看着我像分不清嘛，你都说我是北方人')
  assert.equal(cleanText('. Has anybody done anything'), 'Has anybody done anything')
  assert.equal(cleanText('?'), '')
  assert.equal(cleanText("I'm saying? Sounds like you've done some stuff."), "I'm saying? Sounds like you've done some stuff.")
  assert.equal(cleanText('那我专业是那个 ISM， Information Systems Management'), '那我专业是那个 ISM，Information Systems Management')
  assert.equal(cleanText('我 们 专业'), '我们专业')
})

// 假的 sherpa addon：按脚本一步步给出识别结果；endpoint 为 true 的那一步之后 reset
function fakeAddon(script) {
  let i = -1
  const calls = { reset: 0, accepted: 0, finished: false }
  const addon = {
    calls,
    createOnlineStream: () => ({}),
    acceptWaveformOnline: (_s, w) => {
      calls.accepted += w.samples.length
      i = Math.min(i + 1, script.length - 1)
    },
    isOnlineStreamReady: () => false,
    decodeOnlineStream: () => {},
    getOnlineStreamResultAsJson: () => JSON.stringify(script[i]?.r ?? { text: '', tokens: [], timestamps: [], start_time: 0 }),
    isEndpoint: () => Boolean(script[i]?.endpoint),
    reset: () => calls.reset++,
    inputFinished: () => (calls.finished = true),
  }
  return addon
}

const pcm = (ms) => Buffer.alloc((16000 * ms * 2) / 1000)

test('local: 中间结果按字变化发 partial，停顿后定稿发 final、换下一个 key；span 从这一路开头算毫秒', () => {
  const addon = fakeAddon([
    { r: { text: 'Can you', tokens: [' Can', ' you'], timestamps: [1.0, 1.2], start_time: 0 } },
    { r: { text: 'Can you', tokens: [' Can', ' you'], timestamps: [1.0, 1.2], start_time: 0 } },
    { r: { text: 'Can you explain it', tokens: [' Can', ' you', ' explain', ' it'], timestamps: [1.0, 1.2, 1.5, 1.9], start_time: 0 }, endpoint: true },
    { r: { text: '? Sure', tokens: [' ?', ' Sure'], timestamps: [0.1, 0.9], start_time: 3.2 } },
  ])
  const ch = new LocalChannel({ addon, handle: {} }, { keyPrefix: 'c1-' })
  const events = [...ch.accept(pcm(100)), ...ch.accept(pcm(100)), ...ch.accept(pcm(100)), ...ch.accept(pcm(100))]
  assert.deepEqual(
    events.map((e) => [e.type, e.key, e.text]),
    [
      ['partial', 'c1-0', 'Can you'],
      ['final', 'c1-0', 'Can you explain it'],
      ['partial', 'c1-1', 'Sure'],
    ],
  )
  assert.deepEqual(events[1].span, { start: 1000, end: 2150 })
  // 下一段的 span 跳过段首的问号，从 Sure 算起：3.2 + 0.9
  assert.deepEqual(events[2].span, { start: 4100, end: 4350 })
  assert.equal(addon.calls.reset, 1)
  assert.equal(ch.samples, 6400)
})

test('local: 收尾时补静音、最后一段定稿；只有标点的一段不算', () => {
  const addon = fakeAddon([
    { r: { text: '好的', tokens: [' 好', ' 的'], timestamps: [0.2, 0.4], start_time: 0 } },
    { r: { text: '好的。', tokens: [' 好', ' 的', ' 。'], timestamps: [0.2, 0.4, 0.9], start_time: 0 } },
  ])
  const ch = new LocalChannel({ addon, handle: {} }, { keyPrefix: 'x' })
  assert.deepEqual(ch.accept(pcm(100)).map((e) => e.type), ['partial'])
  const end = ch.finish()
  assert.equal(addon.calls.finished, true)
  assert.deepEqual(end.map((e) => [e.type, e.key, e.text]), [['final', 'x0', '好的。']])
  assert.deepEqual(end[0].span, { start: 200, end: 650 })
  assert.deepEqual(ch.finish(), [])

  const only = new LocalChannel({ addon: fakeAddon([{ r: { text: ' ?', tokens: [' ?'], timestamps: [0.1], start_time: 5 }, endpoint: true }]), handle: {} })
  assert.deepEqual(only.accept(pcm(100)), [])
})

// 假的识别进程：记下送了多少音频，事件由测试手动推
function fakeHost() {
  const h = { opened: [], sent: [], started: 0, handlers: new Map() }
  h.start = async () => {
    h.started++
  }
  h.open = (ch, handlers) => {
    h.opened.push(ch)
    h.handlers.set(ch, handlers)
  }
  h.audio = (ch, buf) => h.sent.push([ch, buf.length])
  h.finish = async () => []
  return h
}

test('local: 识别进程重开后 span 接着这一路的时间往后算；跟不上时提醒一次', async () => {
  const host = fakeHost()
  const asr = new LocalStreamASR({ host })
  const got = []
  const warns = []
  const status = []
  asr.on('final', (e) => got.push(e))
  asr.on('weak', (m) => warns.push(m))
  asr.on('status', (s) => status.push(s))
  await asr.connect()
  const first = host.opened[0]
  for (let i = 0; i < 60; i++) asr.sendAudio(pcm(100)) // 6 秒
  host.handlers.get(first).onEvents([{ type: 'final', key: 'a0', text: 'hello', span: { start: 500, end: 900 } }], 16000)
  assert.deepEqual(got[0].span, { start: 500, end: 900 })
  assert.equal(warns.length, 1, '送了 6 秒只认完 1 秒，提醒一次')
  host.handlers.get(first).onEvents([], 16000)
  assert.equal(warns.length, 1)

  // 进程崩了：重开一条新通道，新通道的 span 从 0 算，要加上前面已经送的 6 秒
  host.handlers.get(first).onCrash(1)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(status, ['reconnecting', 'ready'])
  const second = host.opened[1]
  assert.notEqual(second, first)
  host.handlers.get(second).onEvents([{ type: 'final', key: 'b0', text: 'again', span: { start: 200, end: 700 } }], 0)
  assert.deepEqual(got[1].span, { start: 6200, end: 6700 })
})

test('local: 等模型加载时已经停止了，不再开通道', async () => {
  const host = fakeHost()
  let release
  host.start = () => new Promise((r) => (release = r))
  const asr = new LocalStreamASR({ host })
  const connecting = asr.connect()
  await asr.close()
  release()
  await connecting
  assert.deepEqual(host.opened, [])
})

test('local: 进程崩了，已经出了字的那段当定稿（字不丢）；一分钟里崩 3 次就停', async () => {
  const host = fakeHost()
  const asr = new LocalStreamASR({ host })
  const finals = []
  const fatals = []
  asr.on('final', (e) => finals.push(e.text))
  asr.on('fatal', (e) => fatals.push(e.message))
  await asr.connect()
  host.handlers.get(host.opened[0]).onEvents([{ type: 'partial', key: 'a0', text: 'Can you explain the', span: { start: 0, end: 900 } }], 0)
  host.handlers.get(host.opened[0]).onCrash(1)
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(finals, ['Can you explain the'])
  host.handlers.get(host.opened[1]).onCrash(1)
  await new Promise((r) => setImmediate(r))
  assert.equal(fatals.length, 0)
  host.handlers.get(host.opened[2]).onCrash(1)
  await new Promise((r) => setImmediate(r))
  assert.equal(fatals.length, 1)
  assert.match(fatals[0], /意外退出了 3 次/)
  assert.equal(host.opened.length, 3, '第三次崩了不再重开')
})

test('local: 随安装包的模型按文件大小核对，截断的文件算缺', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { missingModelFiles } = require('../src/main/asr/localCore.cjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xasr-test-'))
  for (const f of ['encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt']) fs.writeFileSync(path.join(dir, f), 'x')
  assert.deepEqual(missingModelFiles(dir), [])
  assert.equal(missingModelFiles(dir, { checkSize: true }).length, 4)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('local: 一口气说超过 15 秒，在句末标点处先定稿前半段，不从词中间切；后面的字接着算下一段', () => {
  const words = (list, t0) => ({ tokens: list, timestamps: list.map((_, i) => t0 + i * 0.5) })
  // 前半段 17 秒：...regularization. 后面紧跟着新词 So（前导空格 = 新词）
  const a = words([' We', ' saw', ' ordinary', ' least', ' squares', ' in', ' linear', ' models', ' with', ' many', ' features', ' and', ' a', ' penalty', ' term', ' for', ' regular', 'ization', ' .', ' So', ' make'], 0.4)
  const addon = fakeAddon([
    { r: { text: 'We saw ordinary', tokens: a.tokens.slice(0, 3), timestamps: a.timestamps.slice(0, 3), start_time: 0 } },
    { r: { text: 'x', tokens: a.tokens.slice(0, 20), timestamps: [...a.timestamps.slice(0, 19), 17.0], start_time: 0 } },
    { r: { text: 'x', tokens: a.tokens, timestamps: [...a.timestamps.slice(0, 19), 17.0, 17.3], start_time: 0 } },
    { r: { text: 'x', tokens: [...a.tokens, ' sure'], timestamps: [...a.timestamps.slice(0, 19), 17.0, 17.3, 17.6], start_time: 0 }, endpoint: true },
  ])
  const ch = new LocalChannel({ addon, handle: {} }, { keyPrefix: 'k' })
  const ev = [0, 1, 2, 3].flatMap(() => ch.accept(pcm(100)))
  const finals = ev.filter((e) => e.type === 'final')
  assert.deepEqual(finals.map((e) => [e.key, e.text]), [
    ['k0', 'We saw ordinary least squares in linear models with many features and a penalty term for regularization.'],
    ['k1', 'So make sure'],
  ])
  assert.deepEqual(finals[1].span, { start: 17000, end: 17850 })
  assert.equal(addon.calls.reset, 1, '句末切的时候不 reset，只有停顿定稿时 reset')
})

test('local: 小数点后面不是新词，不当句末切（3.5 不会被切成 3. 和 5）', () => {
  const tokens = [' The', ' model', ' is', ' version', ' 3', '.', '5', ' and', ' it', ' works']
  const timestamps = tokens.map((_, i) => i * 2)
  const addon = fakeAddon([{ r: { text: tokens.join(''), tokens, timestamps, start_time: 0 } }])
  const ch = new LocalChannel({ addon, handle: {} })
  const ev = ch.accept(pcm(100))
  assert.deepEqual(ev.map((e) => [e.type, e.text]), [['partial', 'The model is version 3.5 and it works']])
})
