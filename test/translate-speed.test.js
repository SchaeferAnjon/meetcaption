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

/* ---------------- 3. 句子一说完就翻，不等这一段定稿 ---------------- */

import http from 'node:http'
import { WebSocketServer } from 'ws'
import { SonioxStreamASR } from '../src/main/asr/soniox.js'

const sentenceOfCall = (o) => o.messages.at(-1).content.split('\n').at(-1)

// 记下每次译文请求问的是哪一句
function countingLlm(reply = (s) => `译：${s.slice(0, 12)}`) {
  const asked = []
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    const s = sentenceOfCall(o)
    asked.push(s)
    await pause(10)
    return reply(s)
  }
  return { llm, asked }
}

test('stable sentence: the last sentence of a partial is translated once it ends with a full stop inside the stable text, and the final then hits the cache', async (t) => {
  const { llm, asked } = countingLlm()
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  const A = 'We fine-tuned the model with LoRA last week.'
  ctx.partial('a', A, { stable: A })
  await until(() => ctx.sentence(A)?.tr)
  assert.deepEqual(asked, [A], '还没定稿就翻了')
  ctx.partial('a', `${A} The results`, { stable: A })
  ctx.final('a', `${A} The results look better.`)
  await until(() => ctx.sentence('The results look better.')?.tr)
  assert.deepEqual(asked, [A, 'The results look better.'], '定稿时第一句命中缓存，没再发')
  const row = ctx.engine.speed.rows.find((r) => r.text === A)
  assert.equal(row.reason, 'stable')
})

test('stable sentence: waits when the full stop is not in the stable text, for abbreviations, very short sentences and (with answers on) questions', async (t) => {
  const { llm, asked } = countingLlm()
  const ctx = harness(t, { llm, patch: { assist: { enabled: true, auto: false } } })
  await ctx.engine.start()
  const A = 'We fine-tuned the model with LoRA last week.'
  ctx.partial('a', A, { stable: 'We fine-tuned the model with LoRA last' }) // 句号还在没定稿的尾巴里
  ctx.partial('b', 'We expanded in the U.S.', { stable: 'We expanded in the U.S.' })
  ctx.partial('c', 'Okay.', { stable: 'Okay.' })
  ctx.partial('d', 'Did you run the Bonferroni correction on the results?', { stable: 'Did you run the Bonferroni correction on the results?' })
  ctx.partial('e', 'We spoke with Dr.', { stable: 'We spoke with Dr.' })
  ctx.partial('f', A)
  await tick(150)
  assert.deepEqual(asked, [], '一条都不该发')
  ctx.final('a', A)
  await until(() => asked.length === 1)
})

test('stable sentence: a Chinese sentence ends at 。 and short ones count by characters', async (t) => {
  const { llm, asked } = countingLlm()
  const ctx = harness(t, { llm, patch: { language: 'zh', translateTarget: 'en' } })
  await ctx.engine.start()
  ctx.partial('a', '我们上周用低秩适配微调了这个模型。', { stable: '我们上周用低秩适配微调了这个模型。' })
  await until(() => asked.length === 1)
})

async function fakeSoniox(t) {
  const conns = []
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    conns.push({ ws })
    ws.on('message', (d, binary) => {
      if (binary || String(d) !== '') return
      ws.send(JSON.stringify({ tokens: [], finished: true })) // 收到结束帧：回 finished 并关掉
      ws.close()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => (wss.close(), server.close()))
  return { conns, url: `ws://127.0.0.1:${server.address().port}/` }
}

const tok = (text, start, end, final = true) => ({ text, start_ms: start, end_ms: end, is_final: final })

test('Soniox token stream: the sentence is requested as soon as its full stop is final (lone space token after it, punctuation timed with the next word), and <end> reuses it', async (t) => {
  const f = await fakeSoniox(t)
  const { llm, asked } = countingLlm()
  const ctx = harness(t, { llm })
  // 用真的 Soniox 识别类接假服务器，不用 FakeASR
  const asr = new SonioxStreamASR({ key: 'k', url: f.url, language: 'en', hotwords: [] })
  ctx.engine.makeProvider = () => asr
  await ctx.engine.start()
  await until(() => f.conns.length > 0)
  const send = (tokens) => f.conns[0].ws.send(JSON.stringify({ tokens }))
  const first = [tok('We', 0, 200), tok(' fine', 200, 400), tok('-tuned', 400, 600), tok(' the', 600, 700), tok(' model', 700, 1000)]
  // 每条回复里定稿的字只送一次；没定稿的尾巴每条整段重送。句号还没定稿：不翻
  send([...first, tok('.', 1500, 1510, false)])
  await tick(100)
  assert.deepEqual(asked, [])
  // 句号定稿（时间标在下一个词开头，停顿之后），后面单独来一个空格词元，下一句的头两个词还没定稿
  send([tok('.', 1500, 1510), tok(' ', 1510, 1510), tok(' The', 1520, 1700, false), tok(' results', 1700, 2000, false)])
  await until(() => asked.length === 1)
  assert.deepEqual(asked, ['We fine-tuned the model.'])
  // 下一句说完、<end> 到：第一句不再发，第二句发一次
  send([tok(' The', 1520, 1700), tok(' results', 1700, 2000), tok(' are', 2000, 2200), tok(' good', 2200, 2500), tok('.', 2500, 2510), { text: '<end>', is_final: true }])
  await until(() => ctx.sentence('The results are good.')?.tr)
  assert.deepEqual(asked, ['We fine-tuned the model.', 'The results are good.'])
  assert.ok(ctx.sentence('We fine-tuned the model.').tr)
})

test('Soniox: tokens that turn final without the text changing still send a partial with the longer stable part', async (t) => {
  const f = await fakeSoniox(t)
  const asr = new SonioxStreamASR({ key: 'k', url: f.url, language: 'en', hotwords: [] })
  const ev = []
  asr.on('partial', (e) => ev.push(e))
  await asr.connect()
  await until(() => f.conns.length > 0)
  const send = (tokens) => f.conns[0].ws.send(JSON.stringify({ tokens }))
  send([tok('Hello', 0, 300), tok(' there', 300, 600, false)])
  await until(() => ev.length === 1)
  send([tok(' there', 300, 600)]) // 定稿的字只送一次，没定稿的尾巴每条整段重送
  await until(() => ev.length === 2)
  assert.deepEqual(ev.map((e) => [e.text, e.stable]), [['Hello there', 'Hello'], ['Hello there', 'Hello there']])
  await asr.close()
})

import { LocalStreamASR } from '../src/main/asr/local.js'

test('local ASR: every partial says its whole text is stable, a final does not carry it', async () => {
  const host = {
    start: async () => {},
    open: (ch, h) => (host.h = h),
    audio() {},
    finish: async () => [],
  }
  const asr = new LocalStreamASR({ host })
  const got = []
  asr.on('partial', (e) => got.push(['partial', e.text, e.stable]))
  asr.on('final', (e) => got.push(['final', e.text, e.stable]))
  await asr.connect()
  host.h.onEvents([{ type: 'partial', key: 'a0', text: 'We fine-tuned the model.', span: { start: 0, end: 900 } }], 0)
  host.h.onEvents([{ type: 'final', key: 'a0', text: 'We fine-tuned the model. Then', span: { start: 0, end: 1200 } }], 0)
  assert.deepEqual(got, [['partial', 'We fine-tuned the model.', 'We fine-tuned the model.'], ['final', 'We fine-tuned the model. Then', undefined]])
})

/* ---------------- 4. 长句前半先翻（临时译文） ---------------- */

const LONG = 'In the third quarter of this year, we saw revenue growth of about ten percent across all of our regions, and our margins improved as well.'
const STABLE1 = 'In the third quarter of this year, we saw revenue growth of about ten percent across'
const STABLE2 = 'In the third quarter of this year, we saw revenue growth of about ten percent across all of our regions,'
const PREFIX1 = 'In the third quarter of this year,'
const PREFIX2 = STABLE2
const isProvCall = (o) => String(o.system ?? '').includes('后半还没说完')

// 记下临时译文和整句请求，分别由测试给回复
function provLlm({ prov = async (s) => `前半：${s.slice(0, 8)}`, full = async () => '完整的译文。' } = {}) {
  const calls = { prov: [], full: [] }
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    const s = sentenceOfCall(o)
    if (isProvCall(o)) {
      calls.prov.push(s)
      return prov(s, o)
    }
    calls.full.push(s)
    return full(s, o)
  }
  return { llm, calls }
}

test('provisional: a long unfinished sentence gets its stable first part translated early and shown as provisional text; the full translation replaces it', async (t) => {
  const { llm, calls } = provLlm()
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all of`, { stable: STABLE1 })
  await until(() => ctx.sentence(`${STABLE1} all of`)?.prov)
  assert.deepEqual(calls.prov, [PREFIX1], '翻到最后一个逗号')
  const sen = ctx.sentence(`${STABLE1} all of`)
  assert.equal(sen.tr, '前半：In the t')
  assert.deepEqual(calls.full, [], '整句还没说完，不发整句请求')
  // 又来了几个字：临时译文还在
  ctx.partial('a', `${STABLE1} all of our`, { stable: STABLE1 })
  assert.equal(ctx.sentence(`${STABLE1} all of our`).prov, true)
  assert.equal(ctx.sentence(`${STABLE1} all of our`).tr, '前半：In the t')
  // 整句说完、定稿：整句请求发出，临时译文留着直到完整译文到
  ctx.final('a', LONG)
  await until(() => ctx.sentence(LONG)?.tr === '完整的译文。')
  assert.equal(ctx.sentence(LONG).prov, undefined)
  assert.deepEqual(calls.full, [LONG])
  const row = ctx.engine.speed.rows.find((r) => r.kind === 'prov')
  assert.ok(row.replacedAt && row.final === '完整的译文。' && typeof row.sim === 'number')
})

test('provisional: below 14 words, with no pause, or with a prefix shorter than 6 words nothing is sent; Chinese counts characters', async (t) => {
  const { llm, calls } = provLlm()
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  const short = 'In the third quarter of this year, we saw revenue growth of about'
  ctx.partial('a', `${short} ten`, { stable: short }) // 13 个词
  const noBreak = 'In the third quarter of this year we saw revenue growth of about ten percent across'
  ctx.partial('b', `${noBreak} all`, { stable: noBreak }) // 没有逗号
  const early = 'However, the revenue growth of about ten percent across all of our regions was strong'
  ctx.partial('c', `${early} and`, { stable: early }) // 逗号前只有 1 个词
  await tick(150)
  assert.deepEqual(calls.prov, [])
  const zh = '第三季度我们的收入增长了大约百分之十，所有地区都有增长，而且利润率也有所提高，客户数量增加了'
  const ctx2 = harness(t, { llm, patch: { language: 'zh', translateTarget: 'en' } })
  await ctx2.engine.start()
  ctx2.partial('a', `${zh}很多`, { stable: zh })
  await until(() => calls.prov.length === 1)
  assert.equal(calls.prov[0], '第三季度我们的收入增长了大约百分之十，所有地区都有增长，而且利润率也有所提高，客户数量增加了'.slice(0, '第三季度我们的收入增长了大约百分之十，所有地区都有增长，而且利润率也有所提高，'.length))
})

test('provisional: one request per sentence at a time; the next goes out only when the stable part grew by another pause', async (t) => {
  let release
  const gate = new Promise((r) => (release = r))
  const { llm, calls } = provLlm({ prov: async (s) => (s === PREFIX1 ? (await gate, '前半一') : '前半二') })
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all`, { stable: STABLE1 })
  await until(() => calls.prov.length === 1)
  ctx.partial('a', `${STABLE2} and our`, { stable: STABLE2 }) // 又多了一个停顿，但第一个还没回来
  await tick(60)
  assert.deepEqual(calls.prov, [PREFIX1], '一句同时只有一个临时译文请求在路上')
  release()
  await until(() => ctx.sentence(`${STABLE2} and our`)?.tr === '前半一')
  ctx.partial('a', `${STABLE2} and our margins`, { stable: STABLE2 })
  await until(() => calls.prov.length === 2)
  assert.deepEqual(calls.prov, [PREFIX1, PREFIX2])
  await until(() => ctx.sentence(`${STABLE2} and our margins`)?.tr === '前半二')
  ctx.partial('a', `${STABLE2} and our margins improved`, { stable: STABLE2 })
  await tick(60)
  assert.equal(calls.prov.length, 2, '定稿的部分没再长一个停顿，不再发')
})

test('provisional: never stored, never kept after stop, and gone when the full translation of that sentence is missing', async (t) => {
  const { llm } = provLlm({ full: () => new Promise(() => {}) }) // 整句的译文一直不回来
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all`, { stable: STABLE1 })
  await until(() => ctx.sentence(`${STABLE1} all`)?.prov)
  ctx.final('a', LONG)
  await until(() => ctx.sentence(LONG)?.prov)
  const rec = ctx.session().segments[0]?.sentences[0]
  assert.ok(!rec || (rec.tr === undefined && rec.prov === undefined), '存档里没有临时译文')
  await ctx.engine.stop()
  assert.equal(ctx.sentence(LONG)?.prov, undefined, '停止后收回')
  assert.equal(ctx.events.at(-1).sentences.some((x) => x.prov || x.tr), false)
  for (const seg of ctx.saved.at(-1).segments) for (const sen of seg.sentences) assert.ok(sen.tr === undefined && sen.prov === undefined)
})

test('provisional: the sentence being re-split or dropped takes its provisional translation with it; a failed request is silent and not retried', async (t) => {
  let n = 0
  const { llm, calls } = provLlm({
    prov: async () => {
      if (++n === 1) throw Object.assign(new Error('服务出错'), { retryable: true })
      return '前半'
    },
  })
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all`, { stable: STABLE1 })
  await until(() => calls.prov.length === 1)
  await tick(80)
  assert.equal(ctx.sentence(`${STABLE1} all`)?.prov, undefined)
  assert.equal(ctx.engine.enhFails, 0, '临时译文失败不触发退避')
  assert.deepEqual(ctx.engine.speed.rows.filter((r) => r.kind === 'prov').map((r) => Boolean(r.error)), [true])
  // 前面的字变了（不是只往后接）：这句话换了个样子，临时译文作废，不再挂在新的句子上
  ctx.partial('a', `${STABLE2} and`, { stable: STABLE2 })
  await until(() => calls.prov.length === 2)
  await until(() => ctx.sentence(`${STABLE2} and`)?.prov)
  ctx.partial('a', 'Completely different words now', { stable: 'Completely different words now' })
  assert.equal(ctx.sentence('Completely different words now').prov, undefined)
  assert.equal(ctx.sentence('Completely different words now').tr, undefined)
})

test('provisional: the streamed full translation replaces it only once it is longer than the provisional text', async (t) => {
  let sendLive
  const { llm } = provLlm({
    full: async (s, o) => {
      o.onDelta('前')
      await new Promise((r) => (sendLive = r))
      return '前半：In the t后面的话说完了。'
    },
  })
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all`, { stable: STABLE1 })
  await until(() => ctx.sentence(`${STABLE1} all`)?.prov)
  ctx.final('a', LONG)
  await tick(150) // 整句请求出了第一个字「前」，比临时译文短
  assert.equal(ctx.sentence(LONG).prov, true)
  assert.equal(ctx.sentence(LONG).tr, '前半：In the t')
  sendLive()
  await until(() => ctx.sentence(LONG)?.tr === '前半：In the t后面的话说完了。' && !ctx.sentence(LONG).prov)
})

test('provisional: with translation off nothing is sent', async (t) => {
  const { llm, calls } = provLlm()
  const ctx = harness(t, { llm, patch: { translate: false } })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all`, { stable: STABLE1 })
  await tick(120)
  assert.deepEqual(calls.prov, [])
})

import { translateMessages } from '../src/main/prompts.js'

test('translateMessages: the provisional prompt says it is only the first half and has no dashes', () => {
  const [sys, user] = translateMessages({ sentence: 'In the third quarter of this year,', previous: ['Hello.'], target: 'zh', source: 'en', partial: true })
  assert.match(sys.content, /后半还没说完：只翻这一半，不要补全后半句，句末不加句号/)
  assert.match(user.content, /请翻译这半句：\nIn the third quarter of this year,$/)
  assert.doesNotMatch(sys.content, /[\u2013\u2014]/)
  const [full] = translateMessages({ sentence: 'x', previous: [], target: 'zh', source: 'en' })
  assert.doesNotMatch(full.content, /后半还没说完/)
})

/* ---------------- 复审修的几处 ---------------- */

const noLive = (sen) => assert.ok(sen && sen.tr === undefined && sen.trLive === undefined && sen.prov === undefined, `存档里不该有半截译文：${JSON.stringify(sen)}`)

test('review: a delta that arrives after the paragraph was saved does not reach the session record or the stop save', async (t) => {
  let release
  const hold = new Promise((r) => (release = r))
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    await pause(30) // 真实网络：第一段内容在定稿存档之后才到
    o.onDelta('我们上周')
    await hold
    return '我们上周用 LoRA 微调了模型。'
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.final('a', SENT)
  assert.equal(ctx.session().segments.length, 1, '定稿时已经存过一次')
  await until(() => ctx.sentence(SENT)?.trLive)
  noLive(ctx.session().segments[0].sentences[0])
  await ctx.engine.stop()
  noLive(ctx.saved.at(-1).segments[0].sentences[0])
  release()
})

test('review: a provisional translation that comes back after the paragraph was saved does not reach the record', async (t) => {
  let release
  const gate = new Promise((r) => (release = r))
  const { llm } = provLlm({ prov: async () => (await gate, '前半译文'), full: () => new Promise(() => {}) })
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all`, { stable: STABLE1 })
  await until(() => ctx.engine.provQueue.length === 0 && ctx.engine.enhActive === 1)
  ctx.final('a', LONG)
  assert.equal(ctx.session().segments.length, 1)
  release()
  await until(() => ctx.sentence(LONG)?.prov)
  noLive(ctx.session().segments[0].sentences[0])
})

test('review: stopping while a failed first attempt waits for its retry takes the half translation back', async (t) => {
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    o.onDelta('我们上周')
    await pause(30)
    throw Object.assign(new Error('429'), { retryable: true })
  }
  const ctx = harness(t, { llm })
  ctx.engine.enhBackoffMs = [60_000]
  await ctx.engine.start()
  ctx.final('a', SENT)
  await until(() => ctx.engine.enhFails === 1 && ctx.engine.enhActive === 0)
  assert.equal(ctx.sentence(SENT).trLive, true, '重试等着的时候半截译文留着')
  await ctx.engine.stop()
  assert.equal(ctx.sentence(SENT)?.trLive, undefined)
  assert.equal(ctx.sentence(SENT)?.tr, undefined)
  assert.equal(ctx.events.at(-1).sentences[0].tr, undefined, '最后推给界面的也已经收回')
  noLive(ctx.saved.at(-1).segments[0].sentences[0])
})

test('review: a provisional translation that comes back after the paragraph turned out to be mine is dropped', async (t) => {
  let release
  const gate = new Promise((r) => (release = r))
  const { llm } = provLlm({ prov: async () => (await gate, '前半译文') })
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.partial('a', `${STABLE1} all`, { stable: STABLE1 })
  await until(() => ctx.engine.enhActive === 1)
  const seg = [...ctx.engine.live.values()][0]
  seg.who = 'me' // 定稿时判断出这是我自己的话
  ctx.partial('a', `${STABLE1} all of`, { stable: STABLE1 })
  release()
  await tick(80)
  const sen = ctx.sentence(`${STABLE1} all of`)
  assert.equal(sen.prov, undefined)
  assert.equal(sen.tr, undefined)
  assert.equal(ctx.engine.speed.rows.find((r) => r.kind === 'prov').shown, undefined, '回来的译文被丢掉了')
})

test('review: after a failed attempt the retry does not make the shown half translation shrink back', async (t) => {
  let n = 0
  const llm = async (o) => {
    if (o.model === 'smart') return '{}'
    if (++n === 1) {
      o.onDelta('我们上周用 LoRA')
      await pause(30)
      throw Object.assign(new Error('服务出错'), { retryable: true })
    }
    o.onDelta('我们')
    await pause(100)
    o.onDelta('我们上周用 LoRA 微调了')
    await pause(100)
    return '我们上周用 LoRA 微调了模型。'
  }
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  ctx.final('a', SENT)
  await until(() => ctx.sentence(SENT)?.tr === '我们上周用 LoRA 微调了模型。' && !ctx.sentence(SENT).trLive, 5000)
  let longest = 0
  for (const e of ctx.events) {
    const tr = e.sentences[0].tr
    if (tr == null) continue
    assert.ok(tr.length >= longest, `译文缩回去了：${tr}`)
    longest = tr.length
  }
})

test('stable sentence: a full stop after a digit or another full stop may not be the end yet, so the sentence waits for the final', async (t) => {
  const { llm, asked } = countingLlm()
  const ctx = harness(t, { llm })
  await ctx.engine.start()
  const a = 'Revenue grew by about 3.'
  const b = 'So we saw growth in all regions...'
  ctx.partial('a', a, { stable: a })
  ctx.partial('b', b, { stable: b })
  await tick(150)
  assert.deepEqual(asked, [], '3. 后面可能接 5，省略号后面还有话')
  const c = 'Revenue grew by about 3.5 percent last year.'
  ctx.partial('c', c, { stable: c })
  await until(() => asked.length === 1)
  assert.deepEqual(asked, [c])
  ctx.final('a', 'Revenue grew by about 3.5 percent.')
  await until(() => asked.length === 2)
})
