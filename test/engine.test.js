import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MeetingEngine } from '../src/main/engine.js'
import { Assistant } from '../src/main/assist/assistant.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 引擎接线：假识别服务（直接发 partial/final）、假声纹模型（按音量区分我和别人）、真的 Assistant 配假的 complete。

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

// 响的是「我」，小声的是别人：embed 按音量给两个方向的向量
const fakeModel = {
  dim: 2,
  modelId: 'fake',
  embed(x) {
    let s = 0
    for (const v of x) s += v * v
    return Math.sqrt(s / x.length) > 0.2 ? Float32Array.from([1, 0]) : Float32Array.from([0, 1])
  },
}
const profile = { embedding: Float32Array.from([1, 0]), modelId: 'fake', seconds: 12 }

function tone(ms, amp) {
  const n = (16000 * ms) / 1000
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2)
  return b
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

const NOTES_REPLY = {
  sections: [{ title: '梯度下降', start: '00:01', points: ['沿负梯度方向更新参数'], formulas: ['$\\theta \\leftarrow \\theta - \\eta \\nabla L$'], examples: [] }],
  emphasis: [{ text: '更新公式要会推导', at: '00:02', quote: 'this will be on the exam' }],
  homework: [{ text: '完成 problem set 3', due: null, dueText: 'next Wednesday' }],
  terms: [{ term: 'learning rate', zh: '学习率', explain: '每一步走多远' }],
}

async function setup({ patch = {}, withVoiceprint = true, llmReady = true, llmImpl = null } = {}) {
  let cfg = applyPatch(applyPatch(merge(DEFAULTS, {}), { translate: true, assist: { withScreen: false } }), patch)
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  let session
  const store = {
    create: (meta) => (session = { id: 't', startedAt: Date.now() - 1, segments: [], ...meta }),
    scheduleSave() {},
    saveNow() {},
    remove: async () => {},
  }
  const llmCalls = []
  const order = [] // 译文请求和答题请求谁先发
  const llm = async (o) => {
    llmCalls.push(o)
    order.push(o.json ? `enhance:${o.messages[0].content.split('这一句：\n').at(-1)}` : 'llm')
    if (llmImpl) return llmImpl(o)
    if (o.json && o.system.includes('课堂笔记助手')) return JSON.stringify(NOTES_REPLY)
    if (o.json) {
      const sentence = o.messages[0].content.split('这一句：\n').at(-1)
      const words = sentence.split(' ')
      const half = Math.ceil(words.length / 2)
      return JSON.stringify({
        tr: '译文前半，译文后半',
        chunks: [{ en: words.slice(0, half).join(' '), zh: '译文前半，' }, { en: words.slice(half).join(' '), zh: '译文后半' }],
        terms: [{ term: 'ablation', zh: '译文', explain: '去掉一部分看影响' }],
      })
    }
    return '译文'
  }
  const asks = []
  const warms = []
  const assistant = new Assistant({
    complete: async (o) => {
      if (o.warm) {
        warms.push(o)
        o.onDelta?.('OK')
        return 'OK'
      }
      asks.push(o)
      order.push('ask')
      o.onDelta?.('要点：先说原因\nBecause the labels are noisy.')
      return '要点：先说原因\nBecause the labels are noisy.'
    },
  })
  const providers = []
  const engine = new MeetingEngine({
    settings,
    store,
    rendererCapture: null,
    llm,
    llmStatus: () => ({ ready: llmReady, reason: llmReady ? null : '还没用 ChatGPT 账号登录' }),
    assistant,
    voiceprint: withVoiceprint ? { profile: () => profile, loadModel: async () => fakeModel } : null,
    createProvider: () => {
      const p = new FakeASR()
      providers.push(p)
      return p
    },
  })
  engine.useFakeSources({ system: true, mic: true }) // 两路都有，不开真实设备，音频由测试直接 feed
  const segs = []
  engine.on('segment', (s) => segs.push(structuredClone(s)))
  const setCfg = (p) => {
    cfg = applyPatch(cfg, p)
    settings.emit('change', settings.get(), cfg)
  }
  return { engine, providers, llmCalls, asks, warms, order, assistant, segs, setCfg, session: () => session }
}

async function start(ctx, t) {
  await ctx.engine.start()
  t.after(() => ctx.engine.stop())
  return ctx
}

test('engine: other side question gets enhanced, merged with its lead-in and answered once', async (t) => {
  const ctx = await start(await setup(), t)
  const [sys] = ctx.providers
  sys.emit('partial', { key: 'a', text: 'So we looked at your results' })
  sys.emit('final', { key: 'a', text: 'So we looked at your results on the second dataset.' })
  sys.emit('final', { key: 'b', text: 'Could you walk me through why the ablation drops so much there?' })
  sys.emit('final', { key: 'b', text: 'again' }) // 同一段重复定稿不再处理
  await tick()
  const b = ctx.segs.filter((s) => s.id === 'system:b').at(-1)
  assert.equal(b.who, 'other')
  assert.equal(b.speaker, '对方')
  assert.equal(b.question, true)
  assert.equal(b.sentences[0].tr, '译文前半，译文后半')
  assert.deepEqual(b.sentences[0].chunks, [
    { en: 'Could you walk me through why', zh: '译文前半，' },
    { en: 'the ablation drops so much there?', zh: '译文后半' },
  ])
  assert.deepEqual(b.sentences[0].terms, [{ term: 'ablation', zh: '译文', explain: '去掉一部分看影响' }])
  assert.deepEqual(ctx.session().segments.find((x) => x.id === 'system:b').sentences[0].chunks, b.sentences[0].chunks)
  const a = ctx.segs.filter((s) => s.id === 'system:a').at(-1)
  assert.ok(!a.question)
  assert.equal(ctx.asks.length, 1)
  assert.match(ctx.asks[0].messages[0].content, /铺垫[^\n]*：So we looked at your results on the second dataset\.\n\n对方的问题：Could you walk me through/)
  const list = ctx.assistant.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].question, 'So we looked at your results on the second dataset. Could you walk me through why the ablation drops so much there?')
  await tick()
  const saved = ctx.session().answers
  assert.equal(saved.length, 1)
  assert.equal(saved[0].segId, 'system:b')
  assert.ok(ctx.session().segments.find((x) => x.id === 'system:b').question)
  // 翻译 + 术语：json 请求，system 单独传
  const enh = ctx.llmCalls.find((c) => c.json)
  assert.equal(enh.model, 'fast')
  assert.ok(enh.system.includes('JSON'))
})

test('engine: mic is me by voiceprint; a quiet copy of the other side is dropped; unlike voice alone is the other side', async (t) => {
  const ctx = await start(await setup(), t)
  const [sys, mic] = ctx.providers
  const e = ctx.engine
  e.feed('mic', tone(2000, 0.5)) // 0 到 2 秒：我
  e.feed('mic', tone(2000, 0.05)) // 2 到 4 秒：外放漏进来的对方
  e.feed('mic', Buffer.alloc(16000 * 2)) // 4 到 5 秒：静音
  e.feed('mic', tone(2000, 0.05)) // 5 到 7 秒：面对面的别人
  mic.emit('final', { key: 'm1', text: 'I think the second dataset is noisier.', span: { start: 0, end: 2000 } })
  sys.emit('final', { key: 's1', text: 'Could you walk me through why the ablation drops so much there?' })
  mic.emit('final', { key: 'm2', text: 'could you walk me through why the ablation drops', span: { start: 2000, end: 4000 } })
  mic.emit('final', { key: 'm3', text: 'Where do you keep the raw recordings?', span: { start: 5000, end: 7000 } })
  await tick()
  const last = (id) => ctx.segs.filter((s) => s.id === id).at(-1)
  assert.equal(last('mic:m1').who, 'me')
  assert.equal(last('mic:m1').vp, 1)
  assert.equal(last('mic:m1').sentences[0].tr, undefined) // 我的话不翻译
  assert.equal(last('mic:m2').dropped, 'crosstalk')
  assert.equal(last('mic:m2').text, '')
  assert.equal(last('mic:m3').who, 'other')
  assert.equal(last('mic:m3').speaker, '对方')
  assert.equal(last('mic:m3').question, true)
  assert.ok(!ctx.session().segments.some((x) => x.id === 'mic:m2'))
  assert.equal(ctx.session().segments.find((x) => x.id === 'mic:m1').who, 'me')
  assert.equal(ctx.asks.length, 2) // s1 和 m3
  // 我的话只会出现在别的句子的「上文」里，不会被单独翻译
  assert.ok(!ctx.llmCalls.some((c) => c.messages[0].content.endsWith('I think the second dataset is noisier.')))
})

test('engine: without a voiceprint every mic segment is me; nothing is asked when the AI is not ready', async (t) => {
  const ctx = await start(await setup({ withVoiceprint: false, llmReady: false }), t)
  const [sys, mic] = ctx.providers
  const notices = []
  ctx.engine.on('notice', (n) => notices.push(n))
  mic.emit('final', { key: 'm', text: 'Where do you keep the raw recordings?' })
  sys.emit('final', { key: 's', text: 'What is your baseline?' })
  await tick()
  const m = ctx.segs.find((s) => s.id === 'mic:m')
  assert.equal(m.who, 'me')
  assert.ok(!m.question)
  assert.equal(ctx.asks.length, 0)
  assert.ok(notices.some((n) => n.code === 'assist-llm'))
})

test('engine: without a voiceprint, a mic copy of the other side is still dropped as crosstalk; my own reply stays me', async (t) => {
  const ctx = await start(await setup({ withVoiceprint: false }), t)
  const [sys, mic] = ctx.providers
  const last = (id) => ctx.segs.filter((s) => s.id === id).at(-1)
  sys.emit('final', { key: 's1', text: 'Good, second thing, for your Bosch internship application, please send me your CV and the cover letter by this Friday.' })
  // 外放串进麦克风，识别还听错了一个词
  mic.emit('final', { key: 'm1', text: 'Good, second thing, for your Bayesian turnship application, please send me your CV and the cover letter by this Friday.' })
  mic.emit('final', { key: 'm2', text: 'Okay, I will send both documents by Friday.' })
  await tick()
  assert.equal(last('mic:m1').dropped, 'crosstalk')
  assert.equal(last('mic:m1').text, '')
  assert.equal(last('mic:m2').who, 'me')
  assert.equal(last('mic:m2').vp, undefined)
  const saved = ctx.session().segments
  assert.deepEqual(saved.map((x) => x.id), ['system:s1', 'mic:m2'])
  // 对方还在说：麦克风的段先等对方的字幕跟上再判
  sys.emit('partial', { key: 's2', text: 'Also, what do you think' })
  ctx.engine.feed('system', tone(300, 0.3))
  mic.emit('final', { key: 'm3', text: 'Also, what do you think about presenting these results at the group meeting?' })
  await tick()
  assert.ok(!ctx.segs.some((s) => s.id === 'mic:m3' && s.final))
  sys.emit('final', { key: 's2', text: 'Also, what do you think about presenting these results at the group meeting next Thursday?' })
  await tick()
  assert.equal(last('mic:m3').dropped, 'crosstalk')
  // 问句的「我」副本没插进去：提问连同铺垫一起答了一次
  assert.equal(ctx.asks.length, 1)
})

test('engine: online class without a voiceprint drops the teacher copied into the mic', async (t) => {
  const ctx = await setup({ withVoiceprint: false })
  await ctx.engine.start({ mode: 'class', classSource: 'system' })
  t.after(() => ctx.engine.stop())
  const [sys, mic] = ctx.providers
  sys.emit('final', { key: 't', text: 'We split the data into k folds, train on k minus one folds and test on the remaining fold.' })
  mic.emit('final', { key: 'm', text: 'we split the data into k folds train on k minus one folds and test on the remaining fold' })
  mic.emit('final', { key: 'q', text: 'Sorry, how many folds do people usually use?' })
  await tick()
  const last = (id) => ctx.segs.filter((s) => s.id === id).at(-1)
  assert.equal(last('system:t').speaker, '老师')
  assert.equal(last('mic:m').dropped, 'crosstalk')
  assert.equal(last('mic:q').who, 'me')
  assert.equal(ctx.warms.length, 0) // 课堂不预热答题
})

test('engine: the translation shows as soon as the streamed JSON has it; chunks and terms follow', async (t) => {
  let finish
  const llmImpl = (o) =>
    new Promise((resolve) => {
      o.onDelta?.('{"tr":"你能讲讲')
      o.onDelta?.('{"tr":"你能讲讲为什么消融掉这么多吗？","chu')
      finish = () =>
        resolve(
          JSON.stringify({
            tr: '你能讲讲为什么消融掉这么多吗？',
            chunks: [{ en: 'Could you walk me through', zh: '你能讲讲' }, { en: 'why the ablation drops so much?', zh: '为什么消融掉这么多吗？' }],
            terms: [{ term: 'ablation', zh: '消融', explain: '去掉一部分看影响' }],
          }),
        )
    })
  const ctx = await start(await setup({ llmImpl, patch: { assist: { auto: false } } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'q', text: 'Could you walk me through why the ablation drops so much?' })
  await tick()
  let q = ctx.segs.filter((s) => s.id === 'system:q').at(-1)
  assert.equal(q.sentences[0].tr, '你能讲讲为什么消融掉这么多吗？')
  assert.equal(q.sentences[0].chunks, undefined)
  assert.equal(ctx.session().segments[0].sentences[0].tr, '你能讲讲为什么消融掉这么多吗？')
  finish()
  await tick()
  q = ctx.segs.filter((s) => s.id === 'system:q').at(-1)
  assert.equal(q.sentences[0].chunks.length, 2)
  assert.equal(q.sentences[0].terms[0].zh, '消融')
})

test('engine: an auto answer goes out before the translation of the question; the AI is warmed up at start', async (t) => {
  const ctx = await start(await setup(), t)
  assert.equal(ctx.warms.length, 1)
  assert.equal(ctx.warms[0].model, 'answer')
  const [sys] = ctx.providers
  sys.emit('final', { key: 'q', text: 'Why does the transformer baseline perform worse on the noisy subset?' })
  await tick()
  const i = ctx.order.indexOf('ask')
  assert.ok(i >= 0)
  const j = ctx.order.findIndex((x) => x.startsWith('enhance:Why does the transformer'))
  assert.ok(j > i, ctx.order.join(' | '))
  assert.ok(ctx.segs.filter((s) => s.id === 'system:q').at(-1).sentences[0].tr)
})

test('engine: on the ChatGPT channel a translation still in flight steps aside for the answer and is sent again after its first word', async (t) => {
  const reply = (o) => {
    const sentence = o.messages[0].content.split('这一句：\n').at(-1)
    return JSON.stringify({ tr: `译文：${sentence.slice(0, 8)}`, chunks: [], terms: [] })
  }
  const run = async (provider) => {
    let first = true
    const aborted = []
    const llmImpl = (o) => {
      if (!first) return reply(o)
      first = false
      // 第一个译文请求一直不回，直到被停掉
      return new Promise((resolve, reject) => o.signal?.addEventListener('abort', () => (aborted.push(o.signal.reason?.code), reject(o.signal.reason)), { once: true }))
    }
    const ctx = await start(await setup({ llmImpl, patch: { llmProvider: provider } }), t)
    const [sys] = ctx.providers
    sys.emit('final', { key: 'a', text: 'So we looked at your results on the second dataset.' })
    await tick()
    sys.emit('final', { key: 'q', text: 'Could you walk me through why the ablation drops so much there?' })
    await tick(40)
    return { ctx, aborted }
  }
  const { ctx, aborted } = await run('chatgpt')
  assert.deepEqual(aborted, ['yield'])
  const o = ctx.order.filter((x) => x !== 'llm')
  // 让路的那句在答题之后重发，问句的译文也在答题之后
  assert.equal(o[0], 'enhance:So we looked at your results on the second dataset.')
  assert.equal(o[1], 'ask')
  assert.ok(o.slice(2).includes('enhance:So we looked at your results on the second dataset.'), o.join(' | '))
  assert.ok(o.slice(2).some((x) => x.startsWith('enhance:Could you walk me through')), o.join(' | '))
  const a = ctx.segs.filter((x) => x.id === 'system:a').at(-1)
  assert.equal(a.sentences[0].tr, '译文：So we lo')
  // OpenAI API 通道：已经发出去的不停
  const other = await run('openai')
  assert.deepEqual(other.aborted, [])
  assert.equal(other.ctx.order.filter((x) => x.startsWith('enhance:So we looked')).length, 1)
})

test('engine: translate off and terms on asks for terms only; both off sends nothing; auto off only answers the hotkey', async (t) => {
  const ctx = await start(await setup({ patch: { translate: false, assist: { auto: false }, terms: { correct: false } } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: 'Did you run the ablation on the GLUE benchmark?' })
  await tick()
  assert.equal(ctx.llmCalls.length, 1)
  assert.ok(ctx.llmCalls[0].json)
  assert.ok(!ctx.llmCalls[0].system.includes('任务一'))
  const a = ctx.segs.filter((s) => s.id === 'system:a').at(-1)
  assert.equal(a.sentences[0].tr, undefined)
  assert.equal(a.sentences[0].terms.length, 1)
  assert.equal(ctx.asks.length, 0)
  const r = ctx.engine.askLast()
  assert.equal(r.ok, true)
  assert.equal(r.question, 'Did you run the ablation on the GLUE benchmark?')
  await tick()
  assert.equal(ctx.asks.length, 1)
  ctx.setCfg({ terms: { enabled: false } })
  sys.emit('final', { key: 'b', text: 'Okay, let us move on to the next section then.' })
  await tick()
  assert.equal(ctx.llmCalls.length, 1)
})

test('engine: while the other side is still talking, an unlike mic segment waits for their captions before deciding', async (t) => {
  const ctx = await start(await setup(), t)
  const [sys, mic] = ctx.providers
  ctx.engine.feed('mic', tone(2000, 0.05))
  sys.emit('partial', { key: 's', text: 'So the thing' })
  mic.emit('final', { key: 'm', text: 'so the thing I wanted to ask is about the baseline', span: { start: 0, end: 2000 } })
  await tick()
  assert.ok(!ctx.segs.some((s) => s.id === 'mic:m' && s.final)) // 还在等
  sys.emit('final', { key: 's', text: 'So the thing I wanted to ask is about the baseline.' })
  await tick()
  assert.equal(ctx.segs.filter((s) => s.id === 'mic:m').at(-1).dropped, 'crosstalk')
})

test('engine: start({ project }) uses the project context, keywords, profile and language, and records projectId', async (t) => {
  const ctx = await setup({ patch: { context: 'global context', assist: { profile: 'global cv' } } })
  const project = { id: 'p_job', context: 'Interview at X company', keywords: 'Kafka', profile: 'Backend engineer CV', language: 'en' }
  await ctx.engine.start({ project })
  t.after(() => ctx.engine.stop())
  assert.equal(ctx.session().projectId, 'p_job')
  assert.equal(ctx.engine.snapshot().session.projectId, 'p_job')
  const [sys] = ctx.providers
  sys.emit('final', { key: 'q', text: 'How would you design the Kafka consumer?' })
  await tick()
  const enh = ctx.llmCalls.find((c) => c.json)
  assert.match(enh.system, /会议背景：Interview at X company/)
  assert.match(enh.system, /Kafka/)
  assert.doesNotMatch(enh.system, /global context/)
  assert.equal(ctx.asks.length, 1)
  const askText = JSON.stringify(ctx.asks[0])
  assert.match(askText, /Backend engineer CV/)
  assert.doesNotMatch(askText, /global cv/)
  // 改了别的设置：项目资料仍然叠在上面；会中改了项目资料：答题马上用新的
  ctx.setCfg({ translate: false })
  ctx.engine.setProject({ ...project, profile: 'Updated CV' })
  sys.emit('final', { key: 'q2', text: 'Why did you choose Postgres over MySQL for that?' })
  await tick()
  assert.match(JSON.stringify(ctx.asks.at(-1)), /Updated CV/)
  // 别的项目的更新不影响这场
  ctx.engine.setProject({ id: 'p_other', profile: 'nope' })
  assert.equal(ctx.engine.project.profile, 'Updated CV')
})

test('engine: chunk colors off with terms off uses the plain translation; chunks survive resplitting', async (t) => {
  const ctx = await start(await setup({ patch: { display: { chunkColors: false }, terms: { enabled: false, correct: false } } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: 'We compared both models on the test set.' })
  await tick()
  assert.equal(ctx.llmCalls.length, 1)
  assert.ok(!ctx.llmCalls[0].json)
  const a = ctx.segs.filter((s) => s.id === 'system:a').at(-1)
  assert.equal(a.sentences[0].tr, '译文')
  assert.equal(a.sentences[0].chunks, undefined)
  // 开着意群颜色：partial 里前面的整句先拿到意群，句子变长重新分句时照留
  ctx.setCfg({ display: { chunkColors: true } })
  sys.emit('partial', { key: 'b', text: 'The first model overfits badly. And the second' })
  await tick()
  let b = ctx.segs.filter((s) => s.id === 'system:b').at(-1)
  assert.equal(b.sentences[0].chunks.length, 2)
  const calls = ctx.llmCalls.length
  sys.emit('partial', { key: 'b', text: 'The first model overfits badly. And the second one does not' })
  b = ctx.segs.filter((s) => s.id === 'system:b').at(-1)
  assert.deepEqual(b.sentences[0].chunks.map((c) => c.zh), ['译文前半，', '译文后半'])
  assert.equal(ctx.llmCalls.length, calls) // 同一句不再请求
})

test('engine: interview mode answers automatically even when auto answer is off in settings', async (t) => {
  const ctx = await setup({ patch: { assist: { enabled: false, auto: false } } })
  await ctx.engine.start({ mode: 'interview' })
  t.after(() => ctx.engine.stop())
  assert.equal(ctx.session().mode, 'interview')
  const [sys] = ctx.providers
  sys.emit('final', { key: 'q', text: 'Can you tell me about a project you are proud of?' })
  await tick()
  assert.equal(ctx.segs.at(-1).speaker, '对方')
  assert.equal(ctx.asks.length, 1)
})

test('engine: class in the classroom listens to the mic only; without a voiceprint everything is the teacher; no auto answers', async (t) => {
  const ctx = await setup({ withVoiceprint: false })
  const states = []
  ctx.engine.on('state', (st) => states.push(st))
  await ctx.engine.start({ mode: 'class', classSource: 'mic', project: { id: 'p_ml', context: 'Intro to ML', keywords: '', profile: '', language: 'en' } })
  t.after(() => ctx.engine.stop())
  assert.equal(ctx.providers.length, 1) // 只有麦克风一路
  assert.equal(ctx.session().mode, 'class')
  assert.equal(ctx.session().classSource, 'mic')
  assert.deepEqual(ctx.session().slides, [])
  assert.equal(states.at(-1).mode, 'class')
  assert.equal(ctx.engine.snapshot().mode, 'class')
  const [mic] = ctx.providers
  mic.emit('final', { key: 'l1', text: 'Could you all derive the update rule for linear regression?' })
  await tick()
  const l1 = ctx.segs.filter((s) => s.id === 'mic:l1').at(-1)
  assert.equal(l1.source, 'mic')
  assert.equal(l1.who, 'other')
  assert.equal(l1.speaker, '老师')
  assert.equal(l1.question, true)
  assert.ok(l1.sentences[0].tr) // 老师的话要翻译
  assert.equal(ctx.asks.length, 0) // 课堂不自动回答
  const enh = ctx.llmCalls.find((c) => c.json)
  assert.match(enh.system, /课堂/)
  assert.match(enh.system, /课程背景：Intro to ML/)
  // 快捷键照样能答
  assert.equal(ctx.engine.askLast().ok, true)
  await tick()
  assert.equal(ctx.asks.length, 1)
})

test('engine: class in the classroom with a voiceprint: my voice is me, the rest is the teacher', async (t) => {
  const ctx = await setup()
  await ctx.engine.start({ mode: 'class', classSource: 'mic' })
  t.after(() => ctx.engine.stop())
  const [mic] = ctx.providers
  const e = ctx.engine
  e.feed('mic', tone(2000, 0.05)) // 老师
  e.feed('mic', tone(2000, 0.5)) // 我提问
  mic.emit('final', { key: 't', text: 'The gradient is an unbiased estimate of the true gradient.', span: { start: 0, end: 2000 } })
  mic.emit('final', { key: 'q', text: 'Why is the stochastic gradient unbiased?', span: { start: 2000, end: 4000 } })
  await tick()
  const last = (id) => ctx.segs.filter((s) => s.id === id).at(-1)
  assert.equal(last('mic:t').who, 'other')
  assert.equal(last('mic:t').speaker, '老师')
  assert.equal(last('mic:q').who, 'me')
  assert.equal(last('mic:q').speaker, '我')
  assert.ok(!ctx.segs.some((s) => s.dropped))
})

test('engine: online class: computer audio is the teacher, the mic follows the meeting rules', async (t) => {
  const ctx = await setup({ withVoiceprint: false })
  await ctx.engine.start({ mode: 'class', classSource: 'system' })
  t.after(() => ctx.engine.stop())
  assert.equal(ctx.providers.length, 2)
  const [sys, mic] = ctx.providers
  sys.emit('final', { key: 's', text: 'Please read chapter three before Friday.' })
  mic.emit('final', { key: 'm', text: 'Okay I will read it.' })
  await tick()
  assert.equal(ctx.segs.filter((s) => s.id === 'system:s').at(-1).speaker, '老师')
  assert.equal(ctx.segs.filter((s) => s.id === 'mic:m').at(-1).speaker, '我')
  assert.equal(ctx.session().classSource, 'system')
})

test('engine: class live notes update from enough new words; slides are recorded', async (t) => {
  const ctx = await setup({ withVoiceprint: false })
  await ctx.engine.start({ mode: 'class', classSource: 'mic' })
  t.after(() => ctx.engine.stop())
  const notes = []
  const slides = []
  ctx.engine.on('notes', (n) => notes.push(n))
  ctx.engine.on('slide', (x) => slides.push(x))
  const [mic] = ctx.providers
  mic.emit('final', { key: 'a', text: 'Short one.' })
  await tick()
  assert.equal(notes.length, 0) // 还不够
  const long = Array.from({ length: 420 }, (_, i) => `word${i}`).join(' ') + '.'
  mic.emit('final', { key: 'b', text: long })
  await tick(50)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].error, null)
  assert.equal(notes[0].sessionId, 't')
  assert.equal(notes[0].notes.sections[0].title, '梯度下降')
  assert.equal(notes[0].notes.sections[0].formulas[0], '\\theta \\leftarrow \\theta - \\eta \\nabla L')
  assert.deepEqual(ctx.session().liveNotes, notes[0].notes)
  assert.ok(ctx.session().liveNotesAt)
  const req = ctx.llmCalls.find((c) => c.system.includes('课堂笔记助手'))
  assert.equal(req.model, 'smart')
  assert.match(req.messages[0].content, /\[00:00\] 老师：Short one\./)
  const slide = ctx.engine.addSlide({ file: 'slides/10.00.00.jpg', at: 123 })
  assert.deepEqual(slide, { file: 'slides/10.00.00.jpg', at: 123 })
  assert.deepEqual(ctx.session().slides, [slide])
  assert.deepEqual(slides, [{ sessionId: 't', file: 'slides/10.00.00.jpg', at: 123 }])
  assert.deepEqual(ctx.engine.snapshot().slides, [slide])
  assert.deepEqual(ctx.engine.snapshot().liveNotes, notes[0].notes)
  await ctx.engine.stop()
  assert.throws(() => ctx.engine.addSlide({ file: 'x' }), /没在记录/)
})

test('engine: a partial the recogniser revised away is removed instead of being finalized at stop', async (t) => {
  const ctx = await start(await setup({ withVoiceprint: false }), t)
  const [sys] = ctx.providers
  sys.emit('partial', { key: 'c:17362', text: '2.' })
  sys.emit('final', { key: 'c:17222', text: '2N.' })
  sys.emit('drop', { key: 'c:17362' })
  sys.emit('partial', { key: 'c:17362', text: '2.' }) // 丢掉以后同一个 key 不再出现
  await tick()
  const last = ctx.segs.filter((s) => s.id === 'system:c:17362').at(-1)
  assert.equal(last.dropped, 'revised')
  assert.equal(last.text, '')
  await ctx.engine.stop()
  assert.deepEqual(ctx.session().segments.map((x) => x.text), ['2N.'])
})

/* ---------------- 开始、停止、会后才回来的译文（真实的项目和会议存储，临时目录） ---------------- */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { hotwordList } from '../src/main/engine.js'

function library(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-engine-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const projects = new ProjectStore({ root: () => root }).load()
  return { root, projects, store: new SessionStore({ projects }) }
}

function realEngine(t, { llm = null, connect = null, fake = { system: true }, patch = {} } = {}) {
  const lib = library(t)
  const cfg = applyPatch(applyPatch(merge(DEFAULTS, {}), { translate: true, terms: { enabled: false, correct: false }, display: { chunkColors: false }, captureMic: false }), patch)
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  const providers = []
  const engine = new MeetingEngine({
    settings,
    store: lib.store,
    rendererCapture: null,
    llm,
    llmStatus: () => ({ ready: true }),
    enhanceWaitMs: 0,
    createProvider: () => {
      const p = new FakeASR()
      if (connect) p.connect = connect
      providers.push(p)
      return p
    },
  })
  engine.useFakeSources(fake)
  const states = []
  engine.on('state', (s) => states.push(s))
  t.after(() => engine.stop())
  return { ...lib, engine, providers, states }
}

const readSession = (store, id) => JSON.parse(fs.readFileSync(path.join(store.dir(id), 'session.json'), 'utf8'))

test('engine: a failed start removes only the meeting it created and keeps the previous one', async (t) => {
  let failConnect = false
  const ctx = realEngine(t, { connect: async () => failConnect && Promise.reject(new Error('network down')) })
  await ctx.engine.start()
  await ctx.engine.stop()
  const prevId = ctx.engine.session.id
  ctx.states.length = 0
  failConnect = true
  await assert.rejects(ctx.engine.start(), /network down/)
  // 上一场会议（没有识别出字，也不能删）还在，引擎上挂的还是它
  assert.ok(fs.existsSync(path.join(ctx.store.dir(prevId), 'session.json')))
  assert.equal(ctx.engine.session.id, prevId)
  // 「正在连接」不再带上一场的 sessionId
  assert.deepEqual(ctx.states.map((s) => [s.state, s.sessionId]), [['starting', null], ['idle', prevId]])
  assert.equal(ctx.states.at(-1).error, 'network down')

  // 建好会议以后才失败（采集起不来）：这次新建的空会议删掉
  const bad = realEngine(t, { fake: { system: path.join(ctx.root, 'missing.wav') } })
  await assert.rejects(bad.engine.start())
  assert.equal(bad.store.records().length, 0)
})

test('engine: stop while still connecting cancels the start quietly, no English TypeError, no meeting left', async (t) => {
  const ctx = realEngine(t, { connect: () => new Promise((r) => setTimeout(r, 150)) })
  const started = ctx.engine.start().catch((e) => e)
  await tick(30)
  await ctx.engine.stop()
  const e = await started
  assert.equal(e.code, 'start-cancelled')
  assert.equal(ctx.engine.state, 'idle')
  assert.deepEqual(ctx.states.map((s) => s.state), ['starting', 'stopping', 'idle'])
  assert.ok(!ctx.states.some((s) => s.error))
  assert.equal(ctx.store.records().length, 0)
})

test('engine: a translation that lands after stop only patches its sentence and keeps the edited title and summary', async (t) => {
  let release
  // 停止时实时笔记会再整理一次（smart 模型），这里只拦翻译请求
  const llm = (o) => (o.model === 'smart' ? Promise.resolve('{}') : new Promise((r) => (release = () => r('你好世界'))))
  const ctx = realEngine(t, { llm })
  await ctx.engine.start()
  const id = ctx.engine.session.id
  ctx.providers[0].emit('final', { key: 'k1', text: 'Hello there, this is a long sentence to translate.' })
  await tick()
  await ctx.engine.stop()
  ctx.store.update(id, { title: '我改的标题', summary: { markdown: '# 纪要' } })
  release()
  await tick(50)
  await tick(1100) // 旧写法 1 秒后整份写回
  const disk = readSession(ctx.store, id)
  assert.equal(disk.title, '我改的标题')
  assert.equal(disk.summary.markdown, '# 纪要')
  assert.equal(disk.segments[0].sentences[0].tr, '你好世界')
})

test('engine: a translation from the previous meeting goes to that meeting file, not into the new one', async (t) => {
  const pending = []
  const llm = (o) => (o.model === 'smart' ? Promise.resolve('{}') : new Promise((r) => pending.push(r)))
  const ctx = realEngine(t, { llm })
  await ctx.engine.start()
  const first = ctx.engine.session.id
  ctx.providers[0].emit('final', { key: 'k1', text: 'The loss starts to diverge after ten epochs.' })
  await tick()
  await ctx.engine.stop()
  await ctx.engine.start() // 同一分钟里的第二场，文件夹名自动加 (2)
  const second = ctx.engine.session.id
  ctx.providers.at(-1).emit('final', { key: 'k1', text: 'The loss starts to diverge after ten epochs.' })
  await tick()
  pending[0]('损失在十个 epoch 后开始发散。')
  await tick(50)
  assert.equal(readSession(ctx.store, first).segments[0].sentences[0].tr, '损失在十个 epoch 后开始发散。')
  // 新的一场自己的请求还在路上，没被上一场的结果填上
  assert.equal(ctx.engine.snapshot().segments[0].sentences[0].tr, undefined)
  pending[1]('新会议的译文')
  await tick(50)
  assert.equal(ctx.engine.snapshot().segments[0].sentences[0].tr, '新会议的译文')
  assert.notEqual(first, second)
})

test('engine: a short reply right after the other person (OK.) is me, not the other side', async (t) => {
  const ctx = await start(await setup(), t)
  const [, mic] = ctx.providers
  const e = ctx.engine
  e.feed('mic', tone(3000, 0.05)) // 面对面的别人说了一大段
  e.feed('mic', tone(500, 0.05)) // 很短的一句，打不了分
  mic.emit('final', { key: 'm1', text: 'Great, please write that up and send it to me by Friday.', span: { start: 0, end: 3000 } })
  mic.emit('final', { key: 'm2', text: 'OK.', span: { start: 3000, end: 3500 } })
  await tick()
  const last = (id) => ctx.segs.filter((s) => s.id === id).at(-1)
  assert.equal(last('mic:m1').who, 'other')
  assert.equal(last('mic:m2').who, 'me')
  assert.equal(last('mic:m2').vp, undefined)
})

test('engine: hotwords put this project first, then other projects, deduped and capped at 100', () => {
  const s = { keywords: 'ablation, WebVision\nBonferroni correction' }
  assert.deepEqual(hotwordList(s, ['Bosch 实习申请', 'Bosch', 'webvision', '', 'x'.repeat(31)]), ['ablation', 'WebVision', 'Bonferroni correction', 'Bosch 实习申请', 'Bosch'])
  const many = Array.from({ length: 150 }, (_, i) => `w${i}`)
  assert.equal(hotwordList({ keywords: 'first' }, many).length, 100)
  assert.equal(hotwordList({ keywords: 'first' }, many)[0], 'first')
})

test('engine: while the other side is still asking, the screen is captured once ahead and used by the auto answer', async (t) => {
  const ctx = await setup({ patch: { assist: { withScreen: true } } })
  let shots = 0
  const warmShots = []
  ctx.assistant.captureScreen = async ({ maxWidth } = {}) => {
    if (maxWidth <= 32) warmShots.push(maxWidth) // 开会时预热截屏组件的那一张
    else shots++
    return { dataUrl: 'data:image/jpeg;base64,AAAA', ms: 5 }
  }
  await start(ctx, t)
  await tick()
  assert.deepEqual(warmShots, [32])
  const [sys] = ctx.providers
  sys.emit('partial', { key: 'q', text: 'Could you walk me through' })
  sys.emit('partial', { key: 'q', text: 'Could you walk me through why the ablation' })
  await tick()
  assert.equal(shots, 1)
  sys.emit('final', { key: 'q', text: 'Could you walk me through why the ablation drops so much there?' })
  await tick(50)
  assert.equal(shots, 1)
  const a = ctx.assistant.list().at(-1)
  assert.equal(a.withScreen, true)
  assert.equal(a.timing.screenPrefetched, true)
  assert.ok(ctx.asks[0].messages.some((m) => Array.isArray(m.content)))
})

/* ---------------- AI 纠错 ---------------- */

// 假模型：认得的句子给纠正（fixed），意群和术语按纠正后的句子写；别的句子 fixed 给空
const FIXES = {
  'We did the Seamen internship last year.': 'We did the Siemens internship last year.',
  'It was on the web vision data set.': 'It was on the WebVision dataset.',
}
function fixingLlm(o) {
  const sentence = o.messages[0].content.split('这一句：\n').at(-1)
  const fixed = FIXES[sentence] ?? ''
  const words = (fixed || sentence).split(' ')
  const half = Math.ceil(words.length / 2)
  return JSON.stringify({
    tr: '译文前半，译文后半',
    fixed,
    chunks: [
      { en: words.slice(0, half).join(' '), zh: '译文前半，' },
      { en: words.slice(half).join(' '), zh: '译文后半' },
    ],
    terms: fixed.includes('Siemens') ? [{ term: 'Siemens', zh: '', explain: '德国工业公司' }] : [],
  })
}
const lastSeg = (ctx, id) => ctx.segs.filter((s) => s.id === id).at(-1)

test('engine: AI correction shows the corrected sentence, keeps the recognised text as orig, rides along in the same request', async (t) => {
  const ctx = await start(await setup({ llmImpl: fixingLlm, patch: { assist: { auto: false } } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: 'We did the Seamen internship last year. It went really well for me.' })
  await tick()
  const a = lastSeg(ctx, 'system:a')
  assert.equal(a.text, 'We did the Siemens internship last year. It went really well for me.')
  assert.equal(a.orig, 'We did the Seamen internship last year. It went really well for me.')
  assert.deepEqual(
    a.sentences.map((x) => [x.text, x.orig]),
    [
      ['We did the Siemens internship last year.', 'We did the Seamen internship last year.'],
      ['It went really well for me.', undefined],
    ],
  )
  assert.equal(a.sentences[0].chunks[0].en, 'We did the Siemens')
  assert.deepEqual(a.sentences[0].terms, [{ term: 'Siemens', zh: '', explain: '德国工业公司' }])
  // 一句一个请求，纠错跟着一起要；纠正后的文字不会再被当成新句子送去翻译
  assert.equal(ctx.llmCalls.length, 2)
  assert.ok(ctx.llmCalls.every((c) => c.json && c.system.includes('"fixed"')))
  const rec = ctx.session().segments.find((x) => x.id === 'system:a')
  assert.equal(rec.text, a.text)
  assert.equal(rec.orig, a.orig)
  assert.equal(rec.sentences[0].orig, 'We did the Seamen internship last year.')
  // 下一句的上文、快捷键答题都用纠正后的文字
  sys.emit('final', { key: 'b', text: 'Could you tell me more about that project?' })
  await tick()
  assert.match(ctx.llmCalls.at(-1).messages[0].content, /上文（只作参考，不要处理）：\nWe did the Siemens internship/)
  const r = ctx.engine.askLast()
  assert.equal(r.ok, true)
  assert.match(r.question, /Siemens internship[\s\S]*Could you tell me more/)
  assert.doesNotMatch(r.question, /Seamen/)
  assert.equal(ctx.llmCalls.length, 3)
})

test('engine: a sentence corrected while the paragraph is still being spoken stays corrected and is not sent again', async (t) => {
  const ctx = await start(await setup({ llmImpl: fixingLlm, patch: { assist: { auto: false } } }), t)
  const [sys] = ctx.providers
  sys.emit('partial', { key: 'p', text: 'We did the Seamen internship last year. And then' })
  await tick()
  let p = lastSeg(ctx, 'system:p')
  assert.equal(p.sentences[0].text, 'We did the Siemens internship last year.')
  assert.equal(p.text, 'We did the Seamen internship last year. And then') // 还在说：段落文字跟着识别走
  assert.equal(p.orig, undefined)
  assert.equal(ctx.llmCalls.length, 1)
  sys.emit('partial', { key: 'p', text: 'We did the Seamen internship last year. And then we moved' })
  p = lastSeg(ctx, 'system:p')
  assert.equal(p.sentences[0].text, 'We did the Siemens internship last year.')
  assert.equal(p.sentences[0].orig, 'We did the Seamen internship last year.')
  assert.equal(p.sentences[0].chunks.length, 2)
  sys.emit('final', { key: 'p', text: 'We did the Seamen internship last year. And then we moved to Munich. It was on the web vision data set.' })
  await tick()
  p = lastSeg(ctx, 'system:p')
  assert.equal(p.text, 'We did the Siemens internship last year. And then we moved to Munich. It was on the WebVision dataset.')
  assert.equal(p.orig, 'We did the Seamen internship last year. And then we moved to Munich. It was on the web vision data set.')
  assert.deepEqual(p.sentences.map((x) => Boolean(x.orig)), [true, false, true])
  assert.equal(ctx.llmCalls.length, 3) // 第一句没有再发
  assert.equal(ctx.session().segments[0].text, p.text)
})

test('engine: with AI correction off the prompt does not ask for fixed and a fixed in the reply is ignored', async (t) => {
  const ctx = await start(await setup({ llmImpl: fixingLlm, patch: { assist: { auto: false }, terms: { correct: false } } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: 'We did the Seamen internship last year.' })
  await tick()
  assert.ok(!ctx.llmCalls[0].system.includes('"fixed"'))
  let a = lastSeg(ctx, 'system:a')
  assert.equal(a.text, 'We did the Seamen internship last year.')
  assert.equal(a.orig, undefined)
  assert.equal(a.sentences[0].orig, undefined)
  assert.deepEqual(a.sentences[0].terms, []) // 按纠正后的句子写的术语在原句里找不到
  // 开会中途打开：之后的句子马上开始纠正
  ctx.setCfg({ terms: { correct: true } })
  sys.emit('final', { key: 'b', text: 'It was on the web vision data set.' })
  await tick()
  a = lastSeg(ctx, 'system:b')
  assert.equal(a.text, 'It was on the WebVision dataset.')
  assert.equal(a.orig, 'It was on the web vision data set.')
})

test('engine: a correction that lands after stop, or after the next meeting started, patches that meeting file with orig', async (t) => {
  const pending = []
  const llm = (o) => new Promise((r) => pending.push(() => r(fixingLlm(o))))
  const ctx = realEngine(t, { llm, patch: { terms: { correct: true } } })
  await ctx.engine.start()
  const first = ctx.engine.session.id
  ctx.providers[0].emit('final', { key: 'k1', text: 'We did the Seamen internship last year.' })
  ctx.providers[0].emit('final', { key: 'k2', text: 'It was on the web vision data set.' })
  await tick()
  await ctx.engine.stop()
  ctx.store.update(first, { title: '我改的标题' })
  pending[0]() // 停止后才回来
  await tick(50)
  let disk = readSession(ctx.store, first)
  assert.equal(disk.title, '我改的标题')
  assert.equal(disk.segments[0].text, 'We did the Siemens internship last year.')
  assert.equal(disk.segments[0].orig, 'We did the Seamen internship last year.')
  await ctx.engine.start()
  pending[1]() // 下一场已经开始了才回来：只补进上一场的文件
  await tick(50)
  disk = readSession(ctx.store, first)
  assert.equal(disk.segments[1].text, 'It was on the WebVision dataset.')
  assert.equal(disk.segments[1].orig, 'It was on the web vision data set.')
  assert.equal(disk.segments[1].sentences[0].orig, 'It was on the web vision data set.')
  assert.equal(ctx.engine.snapshot().segments.length, 0)
})

test('engine: with AI correction the corrected sentence shows together with the streamed translation', async (t) => {
  let finish
  const llmImpl = (o) =>
    new Promise((resolve) => {
      o.onDelta?.('{"fixed":"We did the Siemens internship last year.","tr":"我们去年做了西门子实')
      o.onDelta?.('{"fixed":"We did the Siemens internship last year.","tr":"我们去年做了西门子实习。","chunks":[')
      finish = () => resolve(fixingLlm(o))
    })
  const ctx = await start(await setup({ llmImpl, patch: { assist: { auto: false } } }), t)
  ctx.providers[0].emit('final', { key: 'a', text: 'We did the Seamen internship last year.' })
  await tick()
  let a = lastSeg(ctx, 'system:a')
  assert.equal(a.sentences[0].tr, '我们去年做了西门子实习。')
  assert.equal(a.sentences[0].text, 'We did the Siemens internship last year.')
  assert.equal(a.text, 'We did the Siemens internship last year.')
  assert.equal(a.orig, 'We did the Seamen internship last year.')
  assert.equal(a.sentences[0].chunks, undefined)
  finish()
  await tick()
  a = lastSeg(ctx, 'system:a')
  assert.equal(a.sentences[0].chunks.length, 2)
  assert.equal(a.sentences[0].orig, 'We did the Seamen internship last year.')
  assert.equal(ctx.llmCalls.length, 1)
})

test('engine: the hotkey picks the question the teacher is still saying, and a finished answer gets translations for question and answer', async (t) => {
  const ctx = await start(await setup({ patch: { assist: { auto: false } } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: "Yeah, OK, and what's also really um uh important is that precision and recall trade off." })
  sys.emit('partial', { key: 'q', text: 'OK, so are there any questions so far' })
  await tick(40)
  assert.ok(!ctx.segs.filter((x) => x.id === 'system:a').at(-1).question, '强调句不算提问')
  const r = ctx.engine.askLast()
  assert.ok(r.ok)
  assert.match(r.question, /any questions so far/)
  await tick(80)
  assert.equal(ctx.asks.length, 1)
  const a = ctx.assistant.list().at(-1)
  assert.ok(a.done)
  assert.ok(a.trans, '答完补上译文')
  assert.equal(a.trans.body[0].text, 'Because the labels are noisy.')
  assert.equal(a.trans.body[0].tr, '译文前半，译文后半')
  // 问题连着前面紧挨的铺垫句；铺垫句用字幕已有的译文
  assert.equal(a.trans.question.at(-1).text, 'OK, so are there any questions so far')
  assert.ok(a.trans.question.every((x) => x.tr))
  // 存进会议的 answers 里，会后看也有
  assert.ok(ctx.session().answers.at(-1).trans)
})

/* ---------------- 答非所问（2026-10-26 实测） ---------------- */

test('engine: the answer takes a screenshot on the member channel too (the backend passes it to deepseek-flash), same as with an own key', async (t) => {
  for (const [llmProvider, expect] of [['member', true], ['deepseek', true]]) {
    const ctx = await setup({ patch: { llmProvider, assist: { withScreen: true } } })
    let shots = 0
    ctx.assistant.captureScreen = async () => {
      shots++
      return { dataUrl: 'data:image/jpeg;base64,AAAA', ms: 5 }
    }
    await start(ctx, t)
    await tick()
    const [sys] = ctx.providers
    sys.emit('partial', { key: 'q', text: 'What does this chart' })
    sys.emit('final', { key: 'q', text: 'What does this chart on your screen show?' })
    await tick(50)
    const a = ctx.assistant.list().at(-1)
    assert.equal(a.withScreen, expect, llmProvider)
    assert.equal(shots > 0, expect, llmProvider)
    assert.equal(ctx.asks[0].messages.some((m) => Array.isArray(m.content)), expect, llmProvider)
    assert.equal(/附图/.test(ctx.asks[0].system + JSON.stringify(ctx.asks[0].messages)), expect, llmProvider)
    await ctx.engine.stop()
  }
})

test('engine: once this meeting hits its AI usage limit, questions are no longer answered automatically', async (t) => {
  const { LlmError } = await import('../src/main/llm/errors.js')
  const ctx = await start(await setup({ llmImpl: async () => { throw new LlmError('usage-limit', '这一场的 AI 用量到上限了', { status: 429 }) } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: 'The ledger migration is the risky one.' })
  await tick(50)
  sys.emit('final', { key: 'b', text: 'Why did you pick Postgres for the ledger?' })
  await tick(50)
  assert.equal(ctx.asks.length, 0)
})

test('engine: the answer prompt gets the terms, the question language and the lead-in apart; chores before the question are left out', async (t) => {
  const ctx = await start(await setup({ patch: { keywords: 'idempotent, Kafka', translateTarget: 'de' } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: 'Could you share your screen?' })
  sys.emit('final', { key: 'b', text: 'Can you hear me now?' })
  sys.emit('final', { key: 'c', text: 'How would you design an item potent payment API?' })
  await tick()
  assert.equal(ctx.asks.length, 1, '「共享屏幕」「能听到吗」不自动答')
  const { system, messages } = ctx.asks[0]
  const c = messages[0].content
  assert.match(c, /术语：idempotent、Kafka/)
  assert.match(c, /对方的问题：How would you design an item potent payment API\?/)
  assert.doesNotMatch(c, /铺垫/, '「共享屏幕」「能听到吗」不当铺垫拼进问题')
  assert.match(system, /用英语（English）回答/)
  assert.match(c, /要点那一行用德语（Deutsch）/)
  assert.equal(ctx.assistant.list().at(-1).question, 'How would you design an item potent payment API?')
})

test('engine: a question answered seconds ago is not merged into the next one', async (t) => {
  const ctx = await start(await setup(), t)
  const [sys] = ctx.providers
  // 识别给强调句加了问号，被当成提问答了；几秒后才是真正的问题
  sys.emit('final', { key: 'a', text: 'Why did you pick Postgres for the ledger?' })
  await tick(30)
  assert.ok(ctx.assistant.list().at(-1).done)
  sys.emit('final', { key: 'b', text: 'Why do you want to leave your current company?' })
  await tick(30)
  assert.equal(ctx.asks.length, 2)
  assert.equal(ctx.assistant.list().at(-1).question, 'Why do you want to leave your current company?')
  assert.doesNotMatch(ctx.asks[1].messages[0].content, /对方的问题：[^\n]*Postgres/)
})

test('engine: the hotkey answers "有没有什么问题" said just now, not the question from half a minute ago', async (t) => {
  const ctx = await start(await setup({ patch: { assist: { auto: false }, language: 'zh', translate: false } }), t)
  const [sys] = ctx.providers
  sys.emit('final', { key: 'a', text: '大家想一想，这种情况下查找的时间复杂度是多少' })
  sys.emit('final', { key: 'b', text: '对，退化成链表以后就是 O(n)。' })
  sys.emit('final', { key: 'c', text: '到这里大家有没有什么问题' })
  await tick()
  assert.ok(ctx.segs.filter((x) => x.id === 'system:c').at(-1).question)
  const r = ctx.engine.askLast()
  assert.ok(r.ok)
  assert.equal(r.question.endsWith('到这里大家有没有什么问题'), true)
  await tick(30)
  assert.match(ctx.asks[0].messages[0].content, /对方的问题：到这里大家有没有什么问题/)
  assert.match(ctx.asks[0].system, /用简体中文回答/)
})

test('engine: a question cut in two by a pause is answered once, as one sentence, and the cut-off half alone is not', async (t) => {
  const ctx = await start(await setup(), t)
  const [sys] = ctx.providers
  // 2026-10-26 存档里的真实情况：面试官停顿了一下，前半句「What is the」被单独自动答成「你的问题好像没说完」
  sys.emit('final', { key: 'a', text: 'What is the' })
  await tick()
  assert.equal(ctx.asks.length, 0)
  sys.emit('final', { key: 'b', text: 'best way to roll out a schema change without downtime.' })
  await tick()
  assert.ok(ctx.segs.filter((x) => x.id === 'system:b').at(-1).question)
  assert.equal(ctx.asks.length, 1)
  assert.equal(ctx.assistant.list().at(-1).question, 'What is the best way to roll out a schema change without downtime.')
  const c = ctx.asks[0].messages[0].content
  assert.match(c, /对方的问题：What is the best way to roll out a schema change without downtime\./)
  assert.doesNotMatch(c, /铺垫/)
})
