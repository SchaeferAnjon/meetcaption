import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingEngine } from '../src/main/engine.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'
import { checkFix } from '../src/main/prompts.js'
import { LocalWeakWatch, CORRECT_WINDOW, FRAGMENT_WINDOW, LANG_WINDOW } from '../src/main/asr/localQuality.js'
import { LocalStreamASR } from '../src/main/asr/local.js'

// 本地识别效果不好时提示换云识别或买会员：三条判断（电脑跟不上、对方说的不是中英文、识别质量差）和「一场最多提示一次」。
// 门槛和依据在 src/main/asr/localQuality.js 的注释里。

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await tick(10)) if (fn()) return
  assert.fail('等不到')
}

function harness(t, { patch = {}, llm = null } = {}) {
  const cfg = applyPatch(merge(DEFAULTS, {}), { plan: 'own', engine: 'local', captureMic: false, translate: false, assist: { enabled: false }, terms: { enabled: false, correct: false }, ...patch })
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  const store = {
    create: (meta) => ({ id: 't', startedAt: Date.now() - 1, segments: [], ...meta }),
    scheduleSave() {},
    saveNow() {},
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
    enhanceWaitMs: 0,
    createProvider: () => {
      const p = new FakeASR()
      providers.push(p)
      return p
    },
  })
  engine.useFakeSources({ system: true })
  const notices = []
  engine.on('notice', (n) => notices.push(n))
  t.after(() => engine.stop())
  const weak = () => notices.filter((n) => n.code === 'local-weak')
  const say = (text, i = Math.random()) => providers.at(-1).emit('final', { key: `k${i}`, text })
  return { engine, providers, notices, weak, say }
}

const GERMAN = 'Wir haben den Umsatz deutlich gesteigert, aber die Kosten sind auch gestiegen und der Plan ist nicht klar.'
const ENGLISH = 'We increased the revenue a lot, but the costs went up as well and the plan is not clear yet.'

/* ---------------- 判断本身 ---------------- */

test('weak watch: 碎片比例到 60% 且攒够 40 句才报；比例不到不报', () => {
  const got = []
  const w = new LocalWeakWatch({ onWeak: (r, d) => got.push([r, d]) })
  for (let i = 0; i < FRAGMENT_WINDOW - 1; i++) w.final('Okay yeah')
  assert.deepEqual(got, [], '不满 40 句不判')
  w.final('Okay yeah')
  assert.equal(got[0][0], 'fragments')
  assert.equal(got[0][1].share, 1)

  const mix = []
  const w2 = new LocalWeakWatch({ onWeak: (r) => mix.push(r) })
  // 每 10 句里 5 句零碎：50% 低于门槛
  for (let i = 0; i < FRAGMENT_WINDOW * 2; i++) w2.final(i % 2 ? 'Okay yeah' : 'We should look at the numbers again tomorrow')
  assert.deepEqual(mix, [])
  // 中文：6 个字以内算零碎，7 个字不算
  const zh = []
  const w3 = new LocalWeakWatch({ onWeak: (r) => zh.push(r) })
  for (let i = 0; i < FRAGMENT_WINDOW; i++) w3.final('我觉得可以的吧。')
  assert.deepEqual(zh, [])
  for (let i = 0; i < FRAGMENT_WINDOW; i++) w3.final('我觉得可以的。')
  assert.equal(zh[0], 'fragments')
})

test('weak watch: 最近 6 个长句里 4 句像外语才报；英文和中文不报；短句不参与', () => {
  const got = []
  const w = new LocalWeakWatch({ onWeak: (r, d) => got.push([r, d]) })
  for (let i = 0; i < 30; i++) w.final(i % 2 ? ENGLISH : '我们的收入明显增加了，但是成本也增加了，所以我们需要再检查一下计划。')
  w.final('Danke schön')
  assert.deepEqual(got, [])
  const g = new LocalWeakWatch({ onWeak: (r, d) => got.push([r, d]) })
  for (let i = 0; i < LANG_WINDOW - 3; i++) g.final(GERMAN)
  assert.deepEqual(got, [], '攒不够 6 句不判')
  g.final(GERMAN)
  g.final(ENGLISH)
  g.final(GERMAN)
  assert.equal(got.length, 1)
  assert.equal(got[0][0], 'language')
  assert.ok(got[0][1].detected.every((l) => l === 'de'))
})

test('weak watch: AI 纠错 20 句里 70% 被改且改动占词数 12% 以上才报；改得少或改的句子少都不报', () => {
  const text = 'We fine tuned the model with laura last week okay'
  const fix = checkFix(text, 'We fine-tuned the model with LoRA last quarter okay')
  assert.equal(fix.ok, true)
  const run = (every, f) => {
    const got = []
    const w = new LocalWeakWatch({ onWeak: (r, d) => got.push([r, d]) })
    for (let i = 0; i < CORRECT_WINDOW * 2; i++) w.corrected(text, i % every === 0 ? f : null)
    return got
  }
  assert.equal(run(1, fix).length > 0, true)
  assert.equal(run(1, fix)[0][0], 'corrections')
  assert.deepEqual(run(2, fix), [], '一半的句子被改：不报')
  // 每句只改一个词、十个词的句子：占词数 10%，低于 12%
  const small = checkFix(text, 'We fine tuned the model with laura last quarter okay')
  assert.equal(small.ok, true)
  assert.ok(small.edits / small.words < 0.12)
  assert.deepEqual(run(1, small), [])
  // 太短的句子不参与
  const w = new LocalWeakWatch({ onWeak: () => assert.fail('不该报') })
  for (let i = 0; i < 50; i++) w.corrected('Okay.', fix)
})

/* ---------------- 引擎里：提示怎么出、一场最多一次 ---------------- */

test('engine: 自己选了本地识别、对方语言是德语：开始就提示一次，带原因；不再出旧的「只认中英文」那条', async (t) => {
  const ctx = harness(t, { patch: { language: 'de' } })
  await ctx.engine.start()
  assert.equal(ctx.weak().length, 1)
  const n = ctx.weak()[0]
  assert.equal(n.level, 'warn')
  assert.equal(n.reason, 'language')
  assert.match(n.text, /对方在说德语，本地识别只认中文和英文/)
  assert.deepEqual(ctx.notices.filter((x) => x.code === 'asr-language'), [])
})

test('engine: 一场会最多提示一次：开始时的语言提示之后，跟不上、碎片、外语都不再提示；停了再开新的一场又可以提示', async (t) => {
  const ctx = harness(t, { patch: { language: 'ja' } })
  await ctx.engine.start()
  ctx.providers[0].emit('weak', { reason: 'busy' })
  for (let i = 0; i < FRAGMENT_WINDOW + 5; i++) ctx.say('Okay yeah', i)
  assert.equal(ctx.weak().length, 1)
  assert.equal(ctx.weak()[0].reason, 'language')
  // 暂停再继续也算同一场
  await ctx.engine.pause()
  await ctx.engine.resume()
  ctx.providers.at(-1).emit('weak', { reason: 'busy' })
  assert.equal(ctx.weak().length, 1)
  await ctx.engine.stop()
  await ctx.engine.start()
  assert.equal(ctx.weak().length, 2, '新的一场再提示一次')
})

test('engine: 电脑跟不上：本地识别报 busy，提示一次，建议换云识别或会员', async (t) => {
  const ctx = harness(t)
  await ctx.engine.start()
  assert.deepEqual(ctx.weak(), [])
  ctx.providers[0].emit('weak', { reason: 'busy', lagSeconds: 5 })
  ctx.providers[0].emit('weak', { reason: 'busy', lagSeconds: 9 })
  assert.equal(ctx.weak().length, 1)
  assert.equal(ctx.weak()[0].reason, 'busy')
  assert.match(ctx.weak()[0].text, /云识别或开通会员/)
})

test('engine: 语言设成自动，对方说德语：本地识别音译出来的字看得出不是中英文，提示一次，不报具体语言', async (t) => {
  const ctx = harness(t, { patch: { language: 'auto' } })
  await ctx.engine.start()
  for (let i = 0; i < LANG_WINDOW + 4; i++) ctx.say(GERMAN, i)
  assert.equal(ctx.weak().length, 1)
  assert.equal(ctx.weak()[0].reason, 'language')
  assert.match(ctx.weak()[0].text, /对方说的好像不是中文或英文/)
  assert.equal(ctx.weak()[0].lang, undefined)
})

test('engine: 英文的会议，对方的字大多是零碎短句：提示一次；我自己麦克风里的话不算', async (t) => {
  const ctx = harness(t, { patch: { captureMic: true } })
  ctx.engine.useFakeSources({ system: true, mic: true })
  await ctx.engine.start()
  // 麦克风那一路（我）的碎片不计
  const mic = ctx.providers[1]
  for (let i = 0; i < FRAGMENT_WINDOW * 2; i++) mic.emit('final', { key: `m${i}`, text: 'Okay yeah' })
  assert.deepEqual(ctx.weak(), [])
  for (let i = 0; i < FRAGMENT_WINDOW; i++) ctx.providers[0].emit('final', { key: `s${i}`, text: 'Okay yeah' })
  assert.equal(ctx.weak().length, 1)
  assert.equal(ctx.weak()[0].reason, 'fragments')
})

test('engine: AI 纠错改了大半的句子：识别质量差，提示一次', async (t) => {
  const llm = async (o) => {
    const sentence = o.messages[0].content.split('\n').at(-1)
    // 每句改三处（十个词的句子，占 15% 到 20%）
    return JSON.stringify({ tr: '译文', chunks: [], terms: [], fixed: sentence.replace('fine tuned', 'fine-tuned').replace('laura', 'LoRA').replace('week', 'quarter') })
  }
  const ctx = harness(t, { llm, patch: { translate: true, terms: { enabled: true, correct: true }, display: { chunkColors: false } } })
  await ctx.engine.start()
  for (let i = 0; i < CORRECT_WINDOW + 3; i++) ctx.say(`Number ${i} we fine tuned the model with laura last week okay`, i)
  await until(() => ctx.weak().length > 0)
  assert.equal(ctx.weak()[0].reason, 'corrections')
  assert.ok(ctx.weak()[0].fixedShare >= 0.7)
  await tick(100)
  assert.equal(ctx.weak().length, 1)
})

test('engine: 不是自己选本地识别的不提示：会员、豆包、Soniox、OpenAI；会员退回本地时旧的那条还在', async (t) => {
  for (const patch of [{ engine: 'volc', volcAppId: 'a', volcAccessToken: 'b', language: 'de' }, { engine: 'soniox', sonioxKey: 'k', language: 'de' }]) {
    const ctx = harness(t, { patch })
    await ctx.engine.start()
    ctx.providers[0].emit('weak', { reason: 'busy' })
    for (let i = 0; i < FRAGMENT_WINDOW; i++) ctx.say('Okay yeah', i)
    assert.deepEqual(ctx.weak(), [], patch.engine)
    await ctx.engine.stop()
  }
  // 豆包选了德语：还是旧的「只认中英文」提示
  const volc = harness(t, { patch: { engine: 'volc', volcAppId: 'a', volcAccessToken: 'b', language: 'de' } })
  await volc.engine.start()
  assert.deepEqual(volc.notices.map((n) => n.code), ['asr-language'])
  // 会员（场次用完、选了本地识别）：引擎看到的是 engine local、plan member
  const member = harness(t, { patch: { plan: 'member', language: 'de' } })
  await member.engine.start()
  member.providers[0].emit('weak', { reason: 'busy' })
  for (let i = 0; i < FRAGMENT_WINDOW; i++) member.say('Okay yeah', i)
  assert.deepEqual(member.weak(), [])
  assert.deepEqual(member.notices.map((n) => n.code), ['asr-language', undefined], '旧的语言提示照旧，跟不上只说一声慢')
  assert.doesNotMatch(member.notices[1].text, /会员|云识别/)
})

test('local: 本地识别送进去的音频比认完的多 4 秒，发 weak(busy) 一次，不再是写死中文的 warn', async () => {
  const handlers = new Map()
  const host = {
    start: async () => {},
    open: (ch, h) => handlers.set(ch, h),
    audio() {},
    finish: async () => [],
  }
  const asr = new LocalStreamASR({ host })
  const weak = []
  const warn = []
  asr.on('weak', (w) => weak.push(w))
  asr.on('warn', (m) => warn.push(m))
  await asr.connect()
  for (let i = 0; i < 60; i++) asr.sendAudio(Buffer.alloc(3200))
  const h = [...handlers.values()][0]
  h.onEvents([], 16000)
  h.onEvents([], 16000)
  assert.deepEqual(weak, [{ reason: 'busy', lagSeconds: 5 }])
  assert.deepEqual(warn, [])
})
