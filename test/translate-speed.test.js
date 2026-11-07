import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingEngine } from '../src/main/engine.js'
import { SpeedLog, stats } from '../src/main/speed.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 译文变快：每句计时（speed.js）、译文边写边显示、句子一完整就翻、长句前半先翻。假识别直接发事件，llm 由每个测试自己给。

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 3000) => {
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
  const events = []
  const traces = []
  engine.on('segment', (seg) => events.push(structuredClone(seg)))
  engine.on('trace', (x) => traces.push(x))
  t.after(() => engine.stop())
  const partial = (key, text, extra = {}) => providers[0].emit('partial', { key, text, ...extra })
  const final = (key, text, extra = {}) => providers[0].emit('final', { key, text, ...extra })
  const sentence = (text) => engine.snapshot().segments.flatMap((s) => s.sentences).find((x) => x.text === text)
  return { engine, providers, events, traces, saved, partial, final, sentence, session: () => session }
}

test('stats: median and p90 of a list, empty and non-number entries ignored', () => {
  assert.deepEqual(stats([]), { n: 0, median: null, p90: null })
  assert.deepEqual(stats([null, undefined, NaN]), { n: 0, median: null, p90: null })
  assert.deepEqual(stats([5]), { n: 1, median: 5, p90: 5 })
  assert.deepEqual(stats([4, 1, 3, 2]), { n: 4, median: 3, p90: 4 }) // 偶数个取中间两个的平均 2.5，四舍五入成 3
  assert.deepEqual(stats(Array.from({ length: 10 }, (_, i) => (i + 1) * 100)), { n: 10, median: 550, p90: 900 })
})

test('SpeedLog: speechEnd is estimated per sentence from the paragraph span; summary has stages, requests and tokens', () => {
  const log = new SpeedLog()
  const a = log.open('final', 'One two three.', { segId: 's1', endChar: 14, reason: 'next', completeAt: 1500 })
  const b = log.open('final', 'Four five six.', { segId: 's1', endChar: 29, reason: 'final', completeAt: 3200 })
  for (const [row, k] of [[a, 0], [b, 1]]) {
    row.queuedAt = row.completeAt
    log.sent(row)
    row.sentAt = row.queuedAt + 100
    row.firstTokenAt = row.sentAt + 400
    row.firstVisibleAt = row.sentAt + 500
    row.fullAt = row.sentAt + 900 + k * 100
    row.doneAt = row.fullAt + 600
    log.usage(row, { prompt_tokens: 200, completion_tokens: 40, prompt_cache_hit_tokens: 128 })
  }
  // 段落 0 到 3000 毫秒；第一句结束在第 14 个字（15 个字里的 14），第二句是段落末尾
  log.settle('s1', new Map([['One two three.', 14], ['Four five six.', 29]]), 29, { start: 0, end: 3000 }, (ms) => 10_000 + ms)
  assert.equal(b.speechEnd, 13_000)
  assert.equal(a.speechEnd, 10_000 + Math.round((3000 * 14) / 29))
  const s = log.summary()
  assert.equal(s.sentences, 2)
  assert.equal(s.speechEndToFullVisible.n, 2)
  assert.equal(s.stages.sentToFirstToken.median, 400)
  assert.equal(s.stages.queueToSent.median, 100)
  assert.equal(s.requests.final, 2)
  assert.equal(s.requests.provisional, 0)
  assert.deepEqual(s.tokens.final, { in: 400, out: 80, cached: 256, calls: 2 })
  assert.deepEqual(s.completeBy, { next: 1, final: 1 })
})

test('engine: every translated sentence of the other side gets a timing row and the stop trace has the summary', async (t) => {
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    await tick(30)
    return '译文'
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', 'We fine-tuned the model last week. The results look', { span: { start: 0, end: 2500 } })
  await tick(5)
  ctx.final('a', 'We fine-tuned the model last week. The results look better now.', { span: { start: 0, end: 4000 } })
  await until(() => ctx.sentence('The results look better now.')?.tr)
  await ctx.engine.stop()
  const rows = ctx.traces.filter((x) => x.type === 'speed-row')
  assert.equal(rows.length, 2)
  const [first, second] = rows
  assert.equal(first.reason, 'next', '第一句在段落还没定稿时、第二句开头出现后就知道说完了')
  assert.equal(second.reason, 'final')
  for (const r of rows) {
    assert.ok(r.queuedAt >= r.completeAt && r.sentAt >= r.queuedAt && r.fullAt >= r.sentAt && r.doneAt >= r.fullAt, JSON.stringify(r))
    assert.ok(r.speechEnd > 0, '定稿后有 span，算得出这句说完的时间')
  }
  assert.ok(first.speechEnd < second.speechEnd)
  const sum = ctx.traces.find((x) => x.type === 'speed')
  assert.equal(sum.sentences, 2)
  assert.equal(sum.requests.final, 2)
  assert.equal(sum.speechEndToFullVisible.n, 2)
})
