import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingEngine } from '../src/main/engine.js'
import { LlmError } from '../src/main/llm/errors.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 译文请求出错时：回复空或坏 JSON、限流退避、用量到上限、402、停止时排着的请求。假识别直接发定稿，llm 由每个测试自己给。

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const sentenceOf = (o) => o.messages[0].content.split('\n').at(-1)
const until = async (fn, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await tick(10)) if (fn()) return
  assert.fail('等不到')
}

function harness(t, { llm, patch = {}, enhanceWaitMs = 0 }) {
  const cfg = applyPatch(applyPatch(merge(DEFAULTS, {}), { translate: true, captureMic: false, assist: { enabled: false }, terms: { enabled: false, correct: false }, display: { chunkColors: false } }), patch)
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  let session
  const saved = []
  const store = {
    create: (meta) => (session = { id: 't', startedAt: Date.now() - 1, segments: [], ...meta }),
    scheduleSave() {},
    saveNow: (s) => saved.push(structuredClone(s)),
    remove: async () => {},
    update() {},
    mutate() {},
  }
  const providers = []
  const engine = new MeetingEngine({
    settings,
    store,
    rendererCapture: null,
    llm,
    llmStatus: () => ({ ready: true }),
    enhanceWaitMs,
    createProvider: () => {
      const p = new FakeASR()
      providers.push(p)
      return p
    },
  })
  engine.enhBackoffMs = [40, 80, 120]
  engine.enhRetryMs = 10
  engine.useFakeSources({ system: true })
  const notices = []
  engine.on('notice', (n) => notices.push(n))
  t.after(() => engine.stop())
  const say = (key, text) => providers[0].emit('final', { key, text })
  const trOf = (text) => engine.snapshot().segments.flatMap((s) => s.sentences).find((x) => x.text === text)?.tr
  return { engine, providers, notices, saved, say, trOf, session: () => session }
}

test('enhance: a 200 reply that is empty or not JSON is a failure and retried, not cached as no translation', async (t) => {
  const calls = []
  const replies = ['', 'Sorry, I cannot help with that.']
  const llm = async (o) => {
    calls.push(o)
    if (o.model === 'smart') return '{}'
    if (o.json) return replies.shift() ?? JSON.stringify({ tr: '译文', chunks: [] })
    return '只要译文的重试'
  }
  const ctx = harness(t, { llm, patch: { display: { chunkColors: true } } })
  await ctx.engine.start()
  ctx.say('a', 'We fine-tuned the model with LoRA last week.')
  ctx.say('b', 'The results on the second dataset look much better.')
  await until(() => ctx.trOf('We fine-tuned the model with LoRA last week.') && ctx.trOf('The results on the second dataset look much better.'))
  // 两句的第一次回复都坏了：各重试一次，只要译文（不走 JSON）
  assert.equal(ctx.trOf('We fine-tuned the model with LoRA last week.'), '只要译文的重试')
  assert.equal(ctx.trOf('The results on the second dataset look much better.'), '只要译文的重试')
  assert.equal(calls.filter((o) => o.json).length, 2)
  assert.equal(calls.filter((o) => !o.json && o.model === 'fast').length, 2)
  assert.deepEqual(ctx.notices.filter((n) => n.code === 'enhance' && n.level === 'warn'), [], '一次就恢复了，不提示')
})

test('enhance: an empty JSON reply after the streamed translation already arrived keeps the streamed translation', async (t) => {
  let n = 0
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    n++
    o.onDelta?.('{"tr":"先流式到的译文。","chunks":[')
    return '{"tr":"先流式到的译文。","chunks":[' // 截断了，解析不出来
  }
  const ctx = harness(t, { llm, patch: { display: { chunkColors: true } } })
  await ctx.engine.start()
  ctx.say('a', 'This should be completed within twenty twenty.')
  await tick(100)
  assert.equal(ctx.trOf('This should be completed within twenty twenty.'), '先流式到的译文。')
  assert.equal(n, 1, '不重试')
})

test('enhance: 429 backs off for all sentences, sends one probe at a time, and fills every sentence once it recovers', async (t) => {
  let down = true
  const calls = []
  let active = 0
  let peak = 0
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    calls.push({ at: Date.now(), down })
    active++
    peak = Math.max(peak, active)
    await tick(5)
    active--
    if (down) throw new LlmError('rate-limit', 'AI 服务额度用完或太频繁（429）：busy', { status: 429, retryable: true })
    return `译文：${sentenceOf(o)}`
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  const lines = ['First point about the dataset.', 'Second point about the baseline.', 'Third point about the metrics.', 'Fourth point about the schedule.', 'Fifth point about the deadline.', 'Sixth point about the review.']
  lines.forEach((x, i) => ctx.say(`k${i}`, x))
  await tick(300)
  // 一直 429 的 300 毫秒里：第一波 3 个，之后每次退避只发一个试探（40、80、120 毫秒）
  const whileDown = calls.length
  assert.ok(whileDown <= 6, `限流时发了 ${whileDown} 个请求`)
  assert.ok(lines.every((x) => !ctx.trOf(x)))
  const warn = ctx.notices.find((n) => n.code === 'enhance' && n.level === 'warn')
  assert.match(warn?.text ?? '', /翻译暂时失败，正在重试，恢复后会补上/)
  down = false
  await until(() => lines.every((x) => ctx.trOf(x)), 1000)
  assert.ok(peak <= 3, `并发 ${peak}`)
  assert.ok(ctx.notices.some((n) => n.code === 'enhance' && n.level === 'clear'), '恢复后收回提示')
  assert.equal(calls.length - whileDown, lines.length, '恢复后每句只补一次')
})

test('enhance: usage-limit stops AI requests for this meeting with one notice; live notes stop too', async (t) => {
  const calls = []
  const llm = async (o) => {
    calls.push(o.model)
    throw new LlmError('usage-limit', '这一场的 AI 用量到上限了', { status: 429 })
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  const notes = []
  ctx.engine.on('notes', (n) => notes.push(n))
  ctx.say('a', 'First point about the dataset.')
  ctx.say('b', 'Second point about the baseline.')
  await tick(200)
  ctx.say('c', 'Third point about the metrics.')
  await tick(200)
  const fast = calls.filter((m) => m === 'fast').length
  assert.ok(fast <= 2, `发了 ${fast} 个译文请求`) // 前两句同时发出去的，之后不再发
  assert.deepEqual(ctx.notices.filter((n) => n.code === 'ai-limit').map((n) => n.text), ['翻译和实时笔记这一场先停了：这一场的 AI 用量到上限了'])
  assert.ok(ctx.engine.notes.halted)
  assert.match(notes.at(-1).error, /实时笔记暂停了/)
  await ctx.engine.stop()
  assert.ok(!calls.includes('smart'), '散会后也不再整理笔记')
})

test('enhance: 402 is silent only on the member channel; with your own key the balance error is shown once', async (t) => {
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    throw new LlmError('http', 'AI 服务出错（HTTP 402）：Insufficient Balance', { status: 402 })
  }
  for (const [provider, shown] of [['deepseek', 1], ['member', 0]]) {
    const ctx = harness(t, { llm, patch: { llmProvider: provider } })
    await ctx.engine.start()
    ctx.say('a', 'First point about the dataset.')
    ctx.say('b', 'Second point about the baseline.')
    await tick(150)
    const warns = ctx.notices.filter((n) => n.code === 'enhance' && n.level === 'warn')
    assert.equal(warns.length, shown, provider)
    if (shown) assert.match(warns[0].text, /翻译失败：.*Insufficient Balance/)
    await ctx.engine.stop()
  }
})

test('enhance: stop waits for translations still queued behind the three in flight, within the wait limit', async (t) => {
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    await tick(60)
    return `译文：${sentenceOf(o)}`
  }
  const ctx = harness(t, { llm, enhanceWaitMs: 2000 })
  await ctx.engine.start()
  const lines = ['First point about the dataset.', 'Second point about the baseline.', 'Third point about the metrics.', 'Fourth point about the schedule.', 'Fifth point about the deadline.']
  lines.forEach((x, i) => ctx.say(`k${i}`, x))
  await tick(5)
  await ctx.engine.stop()
  const saved = ctx.saved.at(-1)
  assert.deepEqual(
    saved.segments.map((s) => s.sentences[0].tr),
    lines.map((x) => `译文：${x}`),
  )
  // 等不完的（上限到了）就不发了，停止不会一直卡着
  const slow = harness(t, { llm: (o) => (o.model === 'smart' ? '{}' : new Promise(() => {})), enhanceWaitMs: 100 })
  await slow.engine.start()
  lines.forEach((x, i) => slow.say(`k${i}`, x))
  const t0 = Date.now()
  await slow.engine.stop()
  assert.ok(Date.now() - t0 < 600)
})
