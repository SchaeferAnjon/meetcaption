import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { SonioxStreamASR } from '../src/main/asr/soniox.js'
import { SpeakerBook } from '../src/main/diarize.js'
import { MeetingEngine } from '../src/main/engine.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'
import { speakersNote } from '../src/main/prompts.js'

// 实时分说话人：Soniox 按 token 的 speaker 断句（假服务器）、SpeakerBook 的编号 / 老师 / 改名 / 重连对人、引擎接线（假识别、假声纹模型）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('等太久了')
    await sleep(10)
  }
}

/* ---------------- Soniox：按说话人断句 ---------------- */

async function fakeSoniox(t) {
  const conns = []
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    const c = { ws, config: null }
    conns.push(c)
    ws.on('message', (d, binary) => {
      if (binary) return
      const s = String(d)
      if (s === '') {
        ws.send(JSON.stringify({ tokens: [], finished: true }))
        return ws.close()
      }
      const m = JSON.parse(s)
      if (!m.type) c.config = m
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => (wss.close(), server.close()))
  return { conns, url: `ws://127.0.0.1:${server.address().port}/`, send: (c, tokens) => c.ws.send(JSON.stringify({ tokens })) }
}

const tok = (text, start, speaker, final = true) => ({ text, start_ms: start, end_ms: start + 200, is_final: final, speaker })

function collect(asr) {
  const ev = []
  for (const name of ['partial', 'final', 'drop']) asr.on(name, (x) => ev.push({ name, ...x }))
  return ev
}

test('Soniox 分说话人：配置里开 enable_speaker_diarization；定稿的字换了人就断成两句，各带编号和连接号', async (t) => {
  const f = await fakeSoniox(t)
  const asr = new SonioxStreamASR({ key: 'k', url: f.url, diarize: true })
  const ev = collect(asr)
  await asr.connect()
  await until(() => f.conns[0]?.config)
  const c = f.conns[0]
  assert.equal(c.config.enable_speaker_diarization, true)
  assert.equal(c.config.enable_endpoint_detection, true, '端点检测照开（断句靠它）')
  // 还没有定稿的字：编号取尾巴里第一个字的
  f.send(c, [tok('So', 0, '1', false)])
  // 老师一句没说完，学生接上：「Why」起是学生的
  f.send(c, [tok('So', 0, '1'), tok(' we', 200, '1'), tok(' stop', 400, '1'), tok('.', 600, '1'), tok(' Why', 900, '2'), tok('?', 1100, '2', false)])
  f.send(c, [tok('?', 1100, '2'), { text: '<end>', is_final: true }])
  await until(() => ev.filter((e) => e.name === 'final').length === 2)
  const finals = ev.filter((e) => e.name === 'final')
  assert.deepEqual(
    finals.map((e) => [e.text, e.speaker, e.conn]),
    [
      ['So we stop.', '1', 1],
      ['Why?', '2', 1],
    ],
  )
  assert.equal(ev[0].name, 'partial')
  assert.equal(ev[0].speaker, '1', '只有尾巴时用尾巴的编号')
  assert.equal(finals[1].span.start, 900, '新的一句从换人的那个字算起')
  await asr.close()
})

test('Soniox 分说话人：单独的标点换了编号不断句；不开分说话人时不带 speaker、配置里也没有', async (t) => {
  const f = await fakeSoniox(t)
  const asr = new SonioxStreamASR({ key: 'k', url: f.url, diarize: true })
  const ev = collect(asr)
  await asr.connect()
  await until(() => f.conns[0]?.config)
  f.send(f.conns[0], [tok('Yes', 0, '1'), tok(',', 200, '2'), tok(' sure', 300, '1'), { text: '<end>', is_final: true }])
  await until(() => ev.some((e) => e.name === 'final'))
  assert.deepEqual(
    ev.filter((e) => e.name === 'final').map((e) => [e.text, e.speaker]),
    [['Yes, sure', '1']],
  )
  await asr.close()

  const plain = new SonioxStreamASR({ key: 'k', url: f.url })
  const ev2 = collect(plain)
  await plain.connect()
  await until(() => f.conns[1]?.config)
  assert.equal(f.conns[1].config.enable_speaker_diarization, undefined)
  f.send(f.conns[1], [tok('Hi', 0, '1'), tok(' there', 200, '2'), { text: '<end>', is_final: true }])
  await until(() => ev2.some((e) => e.name === 'final'))
  const fin = ev2.find((e) => e.name === 'final')
  assert.equal(fin.text, 'Hi there', '不开分说话人时编号变了也不断')
  assert.equal(fin.speaker, undefined)
  await plain.close()
})

test('Soniox：超过 8 秒的后备断句不在数字的小数点处断（0.001 不切成两句）', async (t) => {
  const f = await fakeSoniox(t)
  const asr = new SonioxStreamASR({ key: 'k', url: f.url })
  const ev = collect(asr)
  await asr.connect()
  await until(() => f.conns[0]?.config)
  f.send(f.conns[0], [tok('Like', 0), tok(' 0.', 8500), tok('001', 8700), tok(' or', 9000), tok(' less.', 9200), tok(' Next', 9600, undefined, false)])
  await until(() => ev.some((e) => e.name === 'final'))
  assert.deepEqual(
    ev.filter((e) => e.name === 'final').map((e) => e.text),
    ['Like 0.001 or less.'],
  )
  await asr.close()
})

/* ---------------- SpeakerBook ---------------- */

const A = { stream: 's1', label: '1' }
const B = { stream: 's1', label: '2' }
const C = { stream: 's1', label: '3' }
const v = (...xs) => {
  const n = Math.hypot(...xs)
  return Float32Array.from(xs.map((x) => x / n))
}
const VOICE = { t: v(1, 0, 0), s1: v(0, 1, 0), s2: v(0, 0, 1) }

test('SpeakerBook 课堂：按第一次说话排编号；讲得最多的叫老师，被反超一截才换；改名后用改的名字', () => {
  const b = new SpeakerBook({ mode: 'class' })
  assert.equal(b.name(null), '老师', '还没人说话时先猜老师')
  const a = b.place('mic', A)
  b.heard(a, { who: 'other', chars: 200 })
  const s = b.place('mic', B)
  assert.equal(b.name(s), '说话人 2', '还没定稿时也按将来的编号叫')
  b.heard(s, { who: 'other', chars: 40 })
  const c = b.place('mic', C)
  b.heard(c, { who: 'other', chars: 30 })
  assert.deepEqual(b.names(), ['老师', '说话人 2', '说话人 3'])
  // 学生多说了一点，没反超一截：老师不换
  b.heard(s, { who: 'other', chars: 190 })
  assert.equal(b.name(a), '老师')
  b.heard(s, { who: 'other', chars: 100 })
  assert.deepEqual(b.names(), ['说话人 1', '老师', '说话人 3'], '反超 1.2 倍再多 30 字：换老师')
  b.rename(a, '王老师')
  assert.deepEqual(b.names(), ['王老师', '老师', '说话人 3'])
  assert.throws(() => b.rename(9, 'x'), /找不到这个说话人/)
})

test('SpeakerBook 开会：只有一个人叫「对方」，来了第二个人起都叫说话人 1、2；判成我的不占编号、不算字数', () => {
  const b = new SpeakerBook({ mode: 'meeting' })
  const a = b.place('system', A)
  b.heard(a, { who: 'other', chars: 50 })
  assert.deepEqual(b.names(), ['对方'])
  const me = b.place('system', B)
  b.heard(me, { who: 'me', chars: 80 })
  b.heard(me, { who: 'me', chars: 80 })
  assert.ok(b.mostlyMe(me), '这个编号的句子大多是我')
  const c = b.place('system', C)
  assert.equal(b.name(c), '说话人 2', '还没定稿：先按下一个编号叫')
  b.heard(c, { who: 'other', chars: 10 })
  assert.equal(b.name(a), '说话人 1')
  assert.equal(b.name(c), '说话人 2', '我的那个编号不占号')
  assert.equal(b.mostlyMe(c), false)
})

test('SpeakerBook 重连：新连接的编号按声纹对回之前的人；不像任何人的开新编号；同一条连接里不会两个编号对到同一个人', () => {
  const b = new SpeakerBook({ mode: 'class' })
  const t0 = b.place('mic', A, VOICE.t)
  b.heard(t0, { who: 'other', chars: 300, emb: VOICE.t })
  const s1 = b.place('mic', B, VOICE.s1)
  b.heard(s1, { who: 'other', chars: 50, emb: VOICE.s1 })
  // 新连接：编号又从 1 开始，这回学生先开口
  const n1 = { stream: 's2', label: '1' }
  const n2 = { stream: 's2', label: '2' }
  const n3 = { stream: 's2', label: '3' }
  assert.equal(b.place('mic', n1, v(0.1, 1, 0)), s1)
  assert.equal(b.place('mic', n2, v(1, 0.15, 0)), t0)
  const fresh = b.place('mic', n3, VOICE.s2)
  assert.equal(fresh, 2, '新来的人')
  b.heard(fresh, { who: 'other', chars: 20, emb: VOICE.s2 })
  assert.deepEqual(b.names(), ['老师', '说话人 2', '说话人 3'])
  // 之后同一条连接里的编号照用，不再比
  assert.equal(b.place('mic', n1, null), s1)
})

test('SpeakerBook 重连没有声纹向量：新连接第一个开口的算断线前正在说的人，其余开新编号', () => {
  const b = new SpeakerBook({ mode: 'class' })
  const t0 = b.place('mic', A)
  b.heard(t0, { who: 'other', chars: 300 })
  const s1 = b.place('mic', B)
  b.heard(s1, { who: 'other', chars: 40 })
  b.speaking('mic', t0) // 断线时老师说到一半（这句还没定稿）
  const n1 = { stream: 's2', label: '1' }
  assert.equal(b.guess('mic', n1), t0, '说话过程中先猜是他')
  assert.equal(b.place('mic', n1), t0)
  assert.equal(b.guess('mic', { stream: 's2', label: '2' }), null)
  assert.equal(b.place('mic', { stream: 's2', label: '2' }), 2, '对不上：开新编号（限制）')
})

test('SpeakerBook：Soniox 标错人的一句（声音明显是另一个人）改记到那个人名下，编号本身不改', () => {
  const b = new SpeakerBook({ mode: 'class' })
  for (let i = 0; i < 3; i++) b.heard(b.place('mic', A, VOICE.t), { who: 'other', chars: 100, emb: VOICE.t })
  for (let i = 0; i < 2; i++) b.heard(b.place('mic', B, VOICE.s1), { who: 'other', chars: 30, emb: VOICE.s1 })
  assert.equal(b.place('mic', B, v(1, 0.1, 0)), 0, '标成学生，声音是老师')
  assert.equal(b.place('mic', B, v(0.2, 1, 0)), 1, '本来就像学生：不改')
  assert.equal(b.place('mic', B, null), 1, '没有向量：照 Soniox 的')
})

/* ---------------- 引擎接线 ---------------- */

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

// 假声纹模型：音频中间那个样本的值决定向量方向（1 老师、2 学生、3 我）。引擎取音频时前后各多取 150 毫秒，所以不看头尾
const voiceModel = {
  dim: 3,
  modelId: 'fake',
  embed(x) {
    const k = Math.round(Math.abs(x[x.length >> 1]) * 10)
    return k === 3 ? v(0, 0, 1) : k === 2 ? v(0, 1, 0) : v(1, 0, 0)
  },
}
const mine = { embedding: v(0, 0, 1), modelId: 'fake', seconds: 12 }
const voiceAudio = (k, ms = 1500) => {
  const n = (16000 * ms) / 1000
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(k * 0.1 * 32767 * (i % 2 ? 1 : 0.98)), i * 2)
  return b
}

async function setup(t, { mode = 'class', withVoiceprint = false } = {}) {
  const cfg = applyPatch(merge(DEFAULTS, {}), { translate: false, engine: 'soniox', sonioxKey: 'k' })
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  let session
  const store = { create: (meta) => (session = { id: 'd', startedAt: Date.now() - 1, segments: [], ...meta }), scheduleSave() {}, saveNow() {}, remove: async () => {}, update() {} }
  const providers = []
  const engine = new MeetingEngine({
    settings,
    store,
    rendererCapture: null,
    llm: async () => '{}',
    llmStatus: () => ({ ready: false, reason: 'test' }),
    voiceprint: { profile: () => (withVoiceprint ? mine : null), loadModel: async () => voiceModel },
    createProvider: () => {
      const p = new FakeASR()
      providers.push(p)
      return p
    },
  })
  engine.useFakeSources(mode === 'class' ? { mic: true } : { system: true })
  const segs = []
  engine.on('segment', (s) => segs.push(structuredClone(s)))
  await engine.start({ mode, classSource: 'mic' })
  t.after(() => engine.stop())
  const source = mode === 'class' ? 'mic' : 'system'
  let at = 0
  // 一句：先喂这一句的音频，再发定稿（span 指向刚喂的那一段）
  const say = async (key, text, voice, speaker, conn = 1) => {
    const audio = voiceAudio(voice)
    engine.feed(source, audio)
    const span = { start: at, end: at + 1500 }
    at += 1500
    providers[0].emit('partial', { key, text, span, speaker, conn })
    providers[0].emit('final', { key, text, span, speaker, conn })
    await until(() => session.segments.some((s) => s.id === `${source}:${key}`))
  }
  return { engine, segs, say, session: () => session, providers }
}

const shown = (session) => session.segments.map((s) => [s.text, s.speaker, s.sp ?? null])

test('引擎（课堂·教室现场，没录声纹）：Soniox 编号变成老师 / 说话人 2；改名后这个人的每一句都改，存档和字幕窗事件跟着变', async (t) => {
  const ctx = await setup(t)
  await until(() => ctx.engine.spkModel)
  await ctx.say('a', 'Today we talk about gradient descent and why it works.', 1, '1')
  await ctx.say('b', 'How do we choose the learning rate?', 2, '2')
  await ctx.say('c', 'Usually we try a few values on a log scale.', 1, '1')
  await ctx.say('d', 'What if it is too large?', 2, '2')
  assert.deepEqual(shown(ctx.session()), [
    ['Today we talk about gradient descent and why it works.', '老师', 0],
    ['How do we choose the learning rate?', '说话人 2', 1],
    ['Usually we try a few values on a log scale.', '老师', 0],
    ['What if it is too large?', '说话人 2', 1],
  ])
  assert.deepEqual(ctx.session().speakers, ['老师', '说话人 2'])
  ctx.segs.length = 0
  const names = ctx.engine.renameSpeaker(1, 'Anna')
  assert.deepEqual(names, ['老师', 'Anna'])
  assert.deepEqual(
    shown(ctx.session()).map((x) => x[1]),
    ['老师', 'Anna', '老师', 'Anna'],
  )
  assert.deepEqual(
    ctx.segs.map((s) => [s.id, s.speaker]),
    [
      ['mic:b', 'Anna'],
      ['mic:d', 'Anna'],
    ],
    '只重发改了名字的那几句',
  )
})

test('引擎：重连后（新连接编号从 1 重来）按声纹对回之前的人；Soniox 标错人的一句按声音改过来', async (t) => {
  const ctx = await setup(t)
  await until(() => ctx.engine.spkModel)
  await ctx.say('a', 'Gradient descent moves against the gradient every step.', 1, '1')
  await ctx.say('b', 'Is that the same as SGD?', 2, '2')
  await ctx.say('c', 'Almost, SGD uses a small random batch instead.', 1, '1')
  await ctx.say('d', 'Okay thank you very much.', 2, '2')
  // 断线重连：第二条连接里学生是 1、老师是 2
  await ctx.say('e', 'Does the batch size matter?', 2, '1', 2)
  await ctx.say('f', 'Yes, smaller batches are noisier.', 1, '2', 2)
  // Soniox 把老师的一句标成学生的编号
  await ctx.say('g', 'And bigger ones are slower per step.', 1, '1', 2)
  assert.deepEqual(
    shown(ctx.session()).map((x) => x[1]),
    ['老师', '说话人 2', '老师', '说话人 2', '说话人 2', '老师', '老师'],
  )
  assert.deepEqual(ctx.session().speakers, ['老师', '说话人 2'])
})

test('引擎（课堂，录了声纹）：认出是我的显示「我」、不带 sp；这个编号大多是我时，太短打不了分的那句也算我', async (t) => {
  const ctx = await setup(t, { withVoiceprint: true })
  await ctx.say('a', 'Today we start with linear regression models.', 1, '1')
  await ctx.say('b', 'Can you repeat the last formula please?', 3, '2')
  await ctx.say('c', 'Sorry, one more question about the loss.', 3, '2')
  await ctx.say('d', 'Sure, the loss is the squared error.', 1, '1')
  // 很短的一句（只有 0.3 秒音频，打不了分），编号是我的那个；上一句是老师，不是「跟着前一句算我」
  const audio = Buffer.alloc(16000 * 0.3 * 2)
  ctx.engine.feed('mic', audio)
  ctx.providers[0].emit('final', { key: 'e', text: 'Thanks.', span: { start: 6000, end: 6300 }, speaker: '2', conn: 1 })
  await until(() => ctx.session().segments.some((s) => s.id === 'mic:e'))
  const rows = ctx.session().segments.map((s) => [s.text, s.who, s.speaker, s.sp ?? null])
  assert.deepEqual(rows, [
    ['Today we start with linear regression models.', 'other', '老师', 0],
    ['Can you repeat the last formula please?', 'me', '我', null],
    ['Sorry, one more question about the loss.', 'me', '我', null],
    ['Sure, the loss is the squared error.', 'other', '老师', 0],
    ['Thanks.', 'me', '我', null],
  ])
})

test('引擎（会议，电脑声音两个人）：说话人 1、2；只有一个人时还是「对方」', async (t) => {
  const ctx = await setup(t, { mode: 'meeting' })
  await until(() => ctx.engine.spkModel)
  await ctx.say('a', 'Let us review the quarterly numbers first.', 1, '1')
  assert.equal(ctx.session().segments[0].speaker, '对方')
  await ctx.say('b', 'I have a question on the revenue line.', 2, '2')
  assert.deepEqual(
    shown(ctx.session()).map((x) => x[1]),
    ['说话人 1', '说话人 2'],
    '来了第二个人：第一个人的句子也改叫说话人 1',
  )
  assert.ok(ctx.segs.some((s) => s.id === 'system:a' && s.speaker === '说话人 1'), '改名广播出去了（字幕窗跟着变）')
})

test('纪要和课堂笔记的提示词：分了说话人时说明「说话人 N」是不同的人，没分不加', () => {
  assert.equal(speakersNote({ segments: [{ who: 'other', text: 'x' }] }), '')
  assert.match(speakersNote({ segments: [{ who: 'other', sp: 1, text: 'x' }] }), /说话人 1/)
})
