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

/* ---------------- 2. 译文边写边显示 ---------------- */

import { streamedPartial } from '../src/main/prompts.js'

test('streamedPartial: shows what the translation has so far, waits for half-written escapes, tolerates a fixed field first', () => {
  assert.equal(streamedPartial(''), '')
  assert.equal(streamedPartial('{"tr":"'), '')
  assert.equal(streamedPartial('{"tr":"你好，世'), '你好，世')
  assert.equal(streamedPartial('{"tr":"他说\\"好'), '他说"好')
  assert.equal(streamedPartial('{"tr":"a\\'), 'a', '转义写了一半先不要')
  assert.equal(streamedPartial('{"tr":"a\\u4f'), 'a')
  assert.equal(streamedPartial('{"tr":"a\\u4f60b"'), 'a你b')
  assert.equal(streamedPartial('{"tr":"路径 C:\\\\temp'), '路径 C:\\temp', '成对的反斜杠是一个反斜杠')
  assert.equal(streamedPartial('{"tr":"路径 C:\\\\'), '路径 C:\\')
  assert.equal(streamedPartial('{"tr":"表情 \\ud83d'), '表情', '代理对只写了高位先不要')
  assert.equal(streamedPartial('{"fixed":"We use Lo'), '', '纠正后的句子还没写完，译文还没开始')
  assert.equal(streamedPartial('{"fixed":"We use LoRA.","tr":"我们用'), '我们用')
  assert.equal(streamedPartial('```json\n{"tr":"嗯 — 好'), '嗯，好', '破折号和完整译文一样换成逗号')
  assert.equal(streamedPartial('{"tr":"完整的。","chunks":[{"en":"x"'), '完整的。', '译文收全后返回完整译文')
  assert.equal(streamedPartial('{"chunks":[],"tr":"顺序不对'), '', '模型没把 tr 放前面就不显示')
})

const SENT = 'We fine-tuned the model with LoRA last week.'
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

test('engine: the plain translation prompt streams, subtitles grow with it, at most one refresh per 80 ms, and the saved file only has the final text', async (t) => {
  const pieces = ['我们', '上周用', ' LoRA', ' 微调了', '这个模型。']
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    assert.equal(typeof o.onDelta, 'function', '纯翻译也流式收')
    let full = ''
    for (const p of pieces) {
      full += p
      o.onDelta(full)
      await pause(3) // 比 80 毫秒密得多
    }
    await pause(60) // 全文回来前还有一段
    return full
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.final('a', SENT)
  await until(() => ctx.sentence(SENT)?.trLive)
  const during = ctx.events.filter((e) => e.sentences.some((x) => x.trLive))
  assert.ok(during.length >= 1)
  assert.ok(during.length <= 3, `${during.length} 次刷新：5 段内容 15 毫秒内到齐，应该合并`)
  await until(() => ctx.sentence(SENT)?.tr === '我们上周用 LoRA 微调了这个模型。' && !ctx.sentence(SENT).trLive)
  // 中间状态的 tr 都是完整译文的开头
  for (const e of during) assert.ok('我们上周用 LoRA 微调了这个模型。'.startsWith(e.sentences[0].tr))
  // 存档里始终没有半截译文：写完之前落盘的，句子上没有 tr 和 trLive；写完之后有完整译文
  await ctx.engine.stop()
  const rec = ctx.saved.at(-1).segments[0].sentences[0]
  assert.equal(rec.tr, '我们上周用 LoRA 微调了这个模型。')
  assert.equal('trLive' in rec, false)
})

test('engine: the JSON prompt shows the translation as it is written, before the closing quote; chunks and terms follow when the reply is parsed', async (t) => {
  const reply = '{"tr":"我们上周用 LoRA 微调了这个模型。","chunks":[{"en":"We fine-tuned the model","zh":"我们微调了这个模型"},{"en":"with LoRA","zh":"用 LoRA"}],"terms":[]}'
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    const cut = reply.indexOf('微调了') // 译文写到一半
    o.onDelta(reply.slice(0, cut))
    await pause(120)
    o.onDelta(reply.slice(0, reply.indexOf('"chunks"') - 1)) // 译文写完（引号收尾）
    await pause(30)
    return reply
  }
  const ctx = harness(t, { llm, patch: { display: { chunkColors: true } } })
  await ctx.engine.start()
  ctx.final('a', SENT)
  await until(() => ctx.sentence(SENT)?.trLive)
  assert.equal(ctx.sentence(SENT).tr, '我们上周用 LoRA')
  assert.equal(ctx.sentence(SENT).chunks, undefined)
  await until(() => ctx.sentence(SENT)?.tr === '我们上周用 LoRA 微调了这个模型。' && !ctx.sentence(SENT).trLive)
  await until(() => ctx.sentence(SENT)?.chunks?.length === 2)
})

test('engine: a request that fails for good after showing part of the translation takes the part back; a retryable one keeps it until the retry answers', async (t) => {
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    o.onDelta('我们上周')
    await pause(60)
    throw Object.assign(new Error('请求被拒'), { retryable: false })
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.final('a', SENT)
  await until(() => ctx.sentence(SENT)?.tr === '我们上周')
  await until(() => ctx.sentence(SENT)?.tr === undefined && ctx.events.at(-1).sentences[0].tr === undefined, 4000) // 失败后过一会儿重试，再失败就收回
  assert.equal(ctx.sentence(SENT).trLive, undefined)

  let n = 0
  const llm2 = async (o) => {
    if (o.model === 'smart') return '{}'
    if (++n === 1) {
      o.onDelta('我们上周')
      await pause(80)
      throw Object.assign(new Error('服务出错'), { retryable: true })
    }
    o.onDelta('重试：我们')
    await pause(20)
    return '重试：我们上周微调了模型。'
  }
  const ctx2 = harness(t, { llm: llm2 })
  await ctx2.engine.start()
  ctx2.final('a', SENT)
  await until(() => ctx2.sentence(SENT)?.tr === '我们上周')
  await pause(120) // 第一次失败之后、重试还没回答：半截译文还在
  assert.equal(ctx2.sentence(SENT).trLive, true)
  await until(() => ctx2.sentence(SENT)?.tr === '重试：我们上周微调了模型。' && !ctx2.sentence(SENT).trLive, 5000)
})

test('engine: the session record never carries a half-written translation even when another sentence of the same paragraph saves the paragraph meanwhile', async (t) => {
  const A = 'We fine-tuned the model with LoRA last week.'
  const B = 'The results on the second dataset look much better.'
  let releaseA
  const hold = new Promise((r) => (releaseA = r))
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    if (o.messages[0].content.includes(A)) {
      o.onDelta('我们上周')
      await hold
      return '我们上周用 LoRA 微调了模型。'
    }
    await pause(20)
    return '第二个数据集上的结果好多了。'
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.final('a', `${A} ${B}`)
  await until(() => ctx.sentence(B)?.tr && ctx.sentence(A)?.trLive)
  const rec = ctx.session().segments[0].sentences
  assert.equal(rec.find((x) => x.text === B).tr, '第二个数据集上的结果好多了。', '另一句写完时整段存了一次')
  const a = rec.find((x) => x.text === A)
  assert.equal(a.tr, undefined)
  assert.equal(a.trLive, undefined)
  releaseA()
  await until(() => ctx.sentence(A)?.tr === '我们上周用 LoRA 微调了模型。' && !ctx.sentence(A).trLive)
  assert.equal(ctx.session().segments[0].sentences.find((x) => x.text === A).tr, '我们上周用 LoRA 微调了模型。')
})

test('engine: a sentence that is re-split while its translation streams keeps showing the part until the full one lands', async (t) => {
  let release
  const gate = new Promise((r) => (release = r))
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    o.onDelta('我们上周用')
    await gate
    return '我们上周用 LoRA 微调了模型。'
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${SENT} The results`)
  await until(() => ctx.sentence(SENT)?.trLive)
  ctx.partial('a', `${SENT} The results are good`) // 段落又长了，重新分句
  assert.equal(ctx.sentence(SENT).tr, '我们上周用')
  assert.equal(ctx.sentence(SENT).trLive, true)
  release()
  await until(() => ctx.sentence(SENT)?.tr === '我们上周用 LoRA 微调了模型。' && !ctx.sentence(SENT).trLive)
})
