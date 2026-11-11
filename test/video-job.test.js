import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectStore, INBOX_ID } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { DEFAULTS } from '../src/main/defaults.js'
import { runVideo } from '../src/main/video/job.js'
import { VideoService } from '../src/main/video/service.js'
import { HOUR } from '../src/main/video/charge.js'

// 一个视频从头到尾（读声音、识别、翻译、分说话人、截画面、笔记）：识别、解码这些重活用假的，
// 看的是存下来的会议、会员场次开了几场、取消和失败时留不留半成品。

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vjob-'))
const videoFile = path.join(root, '第四讲.mp4')
fs.writeFileSync(videoFile, 'x')

function setup() {
  const dir = fs.mkdtempSync(path.join(root, 'lib-'))
  const projects = new ProjectStore({ root: () => dir }).load()
  const store = new SessionStore({ projects })
  const events = []
  return { dir, projects, store, events, emit: (c, p) => events.push([c, p]) }
}

const fakeMedia = (durationMs, { hasVideo = true } = {}) => ({
  kind: 'mp4',
  durationMs,
  hasVideo,
  video: hasVideo ? { width: 1280, height: 720 } : null,
  audio: { codec: 'mp4a.40.2', sampleRate: 44100, channels: 2, count: 1 },
  close: async () => {},
})

class FakeMember {
  constructor({ balance = 5, kind = 'paid', failAt = Infinity } = {}) {
    this.info = { balance, kind }
    this.calls = []
    this.failAt = failAt
    this.starts = 0
  }
  async refresh() {}
  async startSession() {
    if (this.starts >= this.failAt) throw Object.assign(new Error('没场次了'), { code: 'no-balance' })
    this.starts++
    this.info.balance--
    this.calls.push('start')
  }
  async endSession() {
    this.calls.push('end')
  }
  async asrKey() {
    return { key: 'k', maxMs: 300_000 }
  }
}

// 每次识别回两句，时间落在 [from, to) 里
const steps = (over = {}) => ({
  extract: async (_media, out) => (fs.writeFileSync(out, ''), { samples: 1 }),
  local: async ({ fromMs, toMs }) => [{ startMs: fromMs + 1000, endMs: fromMs + 4000, text: 'Hello everyone. Today we talk about gradients.' }, { startMs: toMs - 5000, endMs: toMs - 1000, text: 'See you next time.' }],
  cloud: async ({ fromMs, toMs }) => [{ startMs: fromMs + 1000, endMs: fromMs + 4000, text: 'Hello everyone. Today we talk about gradients.' }, { startMs: toMs - 5000, endMs: toMs - 1000, text: 'See you next time.' }],
  frames: async ({ onFrame }) => (onFrame(5000, new Uint8Array([1, 2, 3])), onFrame(65_000, new Uint8Array([4, 5])), { count: 2 }),
  translate: async ({ texts }) => ({ tr: texts.map((x) => `译:${x}`), failed: 0, usage: { in: 100, out: 50, calls: 1 } }),
  speakers: async (sentences) => ({ labels: sentences.map((_, i) => (i % 2 ? 1 : 0)), count: 2 }),
  ...over,
})

const deps = (env, over = {}) => ({
  ...env,
  settings: () => ({ ...DEFAULTS, plan: 'own', sonioxKey: 'sk' }),
  member: null,
  llm: async () => '',
  summarizer: { generate: async () => ({ items: [] }) },
  audioWorker: { close() {} },
  frameWorker: { close() {} },
  voiceprint: async () => ({ scorePcm: async () => null }),
  tmpDir: root,
  ...over,
})

const base = { file: videoFile, kind: 'class', language: 'en', target: 'zh', translate: true, notes: false, recognition: 'local', projectId: INBOX_ID }

test('课堂视频，自带 Key，本地识别：存下字幕（每句一段、带译文）、截图，没有场次，状态记成 done', async () => {
  const env = setup()
  const r = await runVideo(deps(env, { steps: { ...steps(), open: async () => fakeMedia(10 * 60_000) } }), base)
  const s = env.store.load(r.sessionId)
  assert.equal(s.mode, 'class')
  assert.equal(s.title, '第四讲')
  assert.equal(s.video.status, 'done')
  assert.equal(s.video.sessions, 0)
  assert.equal(s.endedAt - s.startedAt, 10 * 60_000, '时长按视频算')
  assert.deepEqual(s.segments.map((x) => x.text), ['Hello everyone.', 'Today we talk about gradients.', 'See you next time.'])
  assert.ok(s.segments.every((x) => x.sentences[0].tr === `译:${x.text}` && x.speaker === '老师'))
  assert.equal(s.segments[0].startedAt - s.startedAt, 1000)
  assert.deepEqual(s.slides.map((x) => [x.file, x.at - s.startedAt]), [['slides/00.00.05.jpg', 5000], ['slides/00.01.05.jpg', 65_000]])
  assert.ok(fs.existsSync(path.join(env.store.dir(r.sessionId), 'slides', '00.01.05.jpg')))
  assert.ok(fs.readFileSync(path.join(env.store.dir(r.sessionId), '字幕记录.md'), 'utf8').includes('Hello everyone.'))
  assert.equal(env.store.list().length, 1)
  assert.ok(env.events.some(([c]) => c === 'video:progress'))
})

test('会议视频：分说话人，说话人 1、2 记在 video.speakers，每段带 sp；没有截图', async () => {
  const env = setup()
  const r = await runVideo(deps(env, { steps: { ...steps(), open: async () => fakeMedia(HOUR) } }), { ...base, kind: 'meeting', translate: false })
  const s = env.store.load(r.sessionId)
  assert.equal(s.mode, 'meeting')
  assert.deepEqual(s.video.speakers, ['说话人 1', '说话人 2'])
  assert.deepEqual(s.segments.map((x) => [x.sp, x.speaker]), [[0, '说话人 1'], [1, '说话人 2'], [0, '说话人 1']])
  assert.deepEqual(s.slides, [])
  assert.ok(s.segments.every((x) => !x.sentences[0].tr))
})

test('会员：1 小时视频用云识别 1 场；2.5 小时 2 场，每段各开各结束；本地识别只出原文字幕不开场', async () => {
  let env = setup()
  let m = new FakeMember()
  await runVideo(deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m, steps: { ...steps(), open: async () => fakeMedia(HOUR) } }), { ...base, recognition: 'cloud' })
  assert.deepEqual(m.calls, ['start', 'end'])
  env = setup()
  m = new FakeMember()
  const r = await runVideo(deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m, steps: { ...steps(), open: async () => fakeMedia(2.5 * HOUR) } }), { ...base, recognition: 'cloud' })
  assert.deepEqual(m.calls, ['start', 'end', 'start', 'end'])
  const s = env.store.load(r.sessionId)
  assert.equal(s.video.sessions, 2)
  assert.equal(s.video.sessionsUsed, 2)
  assert.equal(s.segments.length, 6, '每段识别两句（三个句子）')
  assert.ok(s.segments.some((x) => x.startedAt - s.startedAt > 2 * HOUR), '第二段的字幕接在 2 小时之后')
  env = setup()
  m = new FakeMember()
  await runVideo(deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m, steps: { ...steps(), open: async () => fakeMedia(3 * HOUR) } }), { ...base, recognition: 'local', translate: false, notes: false })
  assert.deepEqual(m.calls, [], '本地识别、不翻译不写笔记：不用场次')
  env = setup()
  m = new FakeMember()
  await runVideo(deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m, steps: { ...steps(), open: async () => fakeMedia(HOUR) } }), { ...base, recognition: 'local', translate: true })
  assert.deepEqual(m.calls, ['start', 'end'], '本地识别加会员翻译：1 场')
})

test('场次不够：一场都没开、没留半成品；第二段开不了场次：前一段留着，说明只处理了前面', async () => {
  let env = setup()
  const m = new FakeMember({ balance: 1 })
  await assert.rejects(runVideo(deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m, steps: { ...steps(), open: async () => fakeMedia(2.5 * HOUR) } }), { ...base, recognition: 'cloud' }), (e) => e.code === 'no-balance' && e.need === 2 && e.have === 1)
  assert.deepEqual(m.calls, [])
  assert.equal(env.store.list().length, 0)
  env = setup()
  const m2 = new FakeMember({ balance: 2, failAt: 1 })
  const r = await runVideo(deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m2, steps: { ...steps(), open: async () => fakeMedia(2.5 * HOUR) } }), { ...base, recognition: 'cloud' })
  assert.deepEqual(m2.calls, ['start', 'end'])
  assert.match(r.partial, /场次不够/)
  const s = env.store.load(r.sessionId)
  assert.equal(s.video.reachedMs, 2 * HOUR)
  assert.ok(s.segments.every((x) => x.startedAt - s.startedAt < 2 * HOUR))
})

test('取消：正在识别时中断，会议文件夹删掉，会员这一场结束；没识别出内容也不留半成品', async () => {
  const env = setup()
  const ac = new AbortController()
  const m = new FakeMember()
  const slow = async ({ signal }) => {
    ac.abort()
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  await assert.rejects(runVideo(deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m, steps: { ...steps({ cloud: slow }), open: async () => fakeMedia(HOUR) } }), { ...base, recognition: 'cloud' }, { signal: ac.signal }), (e) => e.name === 'AbortError')
  assert.deepEqual(m.calls, ['start', 'end'])
  assert.equal(env.store.reindex().size, 0, '半成品删掉了')
  const env2 = setup()
  await assert.rejects(runVideo(deps(env2, { steps: { ...steps({ local: async () => [] }), open: async () => fakeMedia(HOUR) } }), base), (e) => e.code === 'no-speech')
  assert.equal(env2.store.reindex().size, 0)
})

test('本地识别遇到德语：直接说清楚，不开始', async () => {
  const env = setup()
  await assert.rejects(runVideo(deps(env, { steps: { ...steps(), open: async () => fakeMedia(HOUR) } }), { ...base, language: 'de' }), (e) => e.code === 'local-language')
  assert.equal(env.store.reindex().size, 0)
})

test('笔记：做完字幕后用刚结束那一场的票做；笔记失败不丢字幕，记在 notesError', async () => {
  const env = setup()
  const calls = []
  const summarizer = { generate: async (id, ask, opts) => (calls.push([id, opts.now]), { items: [], htmlError: '图文没做出来' }) }
  const r = await runVideo(deps(env, { summarizer, steps: { ...steps(), open: async () => fakeMedia(HOUR) } }), { ...base, notes: true })
  assert.equal(calls[0][1], true)
  assert.equal(r.notesError, '图文没做出来')
  assert.equal(env.store.load(r.sessionId).video.notesError, '图文没做出来')
  const env2 = setup()
  const bad = { generate: async () => { throw new Error('AI 没连上') } }
  const r2 = await runVideo(deps(env2, { summarizer: bad, steps: { ...steps(), open: async () => fakeMedia(HOUR) } }), { ...base, notes: true })
  assert.equal(r2.notesError, 'AI 没连上')
  assert.equal(env2.store.load(r2.sessionId).segments.length, 3)
})

test('VideoService：问价（场次、够不够、云识别能不能用）、开始、一次只处理一个、做完发通知', async () => {
  const env = setup()
  const events = []
  const notes = []
  const m = new FakeMember({ balance: 1 })
  const svc = new VideoService({
    ...deps(env, { settings: () => ({ ...DEFAULTS, plan: 'member' }), member: m, steps: { ...steps(), open: async () => fakeMedia(2.5 * HOUR) } }),
    emit: (c, p) => events.push([c, p]),
    notify: (n) => notes.push(n),
    makeWorkers: () => ({ audio: { close() {} }, frames: { close() {} } }),
    busy: () => false,
  })
  const q = await svc.quote({ ...base, recognition: 'cloud' })
  assert.equal(q.sessions, 2)
  assert.equal(q.enough, false)
  assert.equal(q.errors[0].code, 'no-balance')
  assert.deepEqual([q.errors[0].need, q.errors[0].have], [2, 1])
  const free = await svc.quote({ ...base, recognition: 'local', translate: false, notes: false })
  assert.equal(free.sessions, 0)
  assert.deepEqual(free.errors, [])
  assert.deepEqual(await svc.start({ ...base, recognition: 'cloud' }), { ok: false, code: 'no-balance', error: q.errors[0].message, need: 2, have: 1 })
  m.info.balance = 2
  assert.deepEqual(await svc.start({ ...base, recognition: 'cloud' }), { ok: true })
  assert.equal((await svc.start({ ...base, recognition: 'cloud' })).code, 'busy-video')
  for (let i = 0; i < 100 && svc.running; i++) await new Promise((r) => setTimeout(r, 20))
  assert.ok(events.some(([c]) => c === 'video:done'))
  assert.equal(notes.length, 1)
  assert.match(notes[0].title, /处理好了/)
  const busy = new VideoService({ ...deps(env), makeWorkers: () => ({}), emit() {}, busy: () => true })
  assert.equal((await busy.start(base)).code, 'busy')
})
