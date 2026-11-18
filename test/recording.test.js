import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mergeRecSlides, nextRecordingFile, recordingAt, recordingsToScan, recSlideBase, wantRecFrame } from '../src/main/recording/clips.js'
import { ScreenRecording } from '../src/main/recording/controller.js'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { manySlides, pickSlides, Summarizer } from '../src/main/summary.js'
import { slidesText, summaryMessages } from '../src/main/prompts.js'
import { classNotesMessages } from '../src/main/class/prompts.js'
import { seekableAt } from '../src/main/class/notesHtml.js'

// 记录时录屏：一段一个文件，时间用这一场的时间轴（毫秒时间戳，和字幕、截图一样）；停止后从录屏里截画面并进 slides；
// 纪要和课堂笔记用上这些截图；详情页点字幕跳到对应那段录屏的那一刻。

const T0 = new Date(2026, 10, 18, 10, 0, 0).getTime()

function tmpStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-rec-'))
  const projects = new ProjectStore({ root: () => root }).load()
  return { root, projects, store: new SessionStore({ projects }) }
}

/* ---------------- 时间和文件名 ---------------- */

test('录屏文件名：recordings/录屏-N，N 比已有的都大，文件夹里已有的文件也跳过', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-recname-'))
  assert.equal(nextRecordingFile(dir, []), 'recordings/录屏-1.mp4')
  assert.equal(nextRecordingFile(dir, [{ file: 'recordings/录屏-1.mp4' }, { file: 'recordings/录屏-3.webm' }]), 'recordings/录屏-4.mp4')
  fs.mkdirSync(path.join(dir, 'recordings'))
  fs.writeFileSync(path.join(dir, 'recordings', '录屏-1.webm'), 'x')
  assert.equal(nextRecordingFile(dir, [], 'webm'), 'recordings/录屏-2.webm', '崩溃留下、没记进 session 的文件不覆盖')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('时间换算：这一场的某一刻落在哪一段录屏、是视频里的第几毫秒；两段中间（没在录）回 null；没写结束时间的那段当它一直在录', () => {
  const recs = [
    { file: 'recordings/录屏-1.mp4', startAt: T0 + 60_000, endAt: T0 + 80_000 },
    { file: 'recordings/录屏-2.mp4', startAt: T0 + 120_000, endAt: T0 + 135_000 },
  ]
  assert.deepEqual(recordingAt(recs, T0 + 70_000), { rec: recs[0], index: 0, ms: 10_000 })
  assert.equal(recordingAt(recs, T0 + 121_500).index, 1)
  assert.equal(recordingAt(recs, T0 + 121_500).ms, 1_500)
  assert.equal(recordingAt(recs, T0 + 100_000), null, '两段中间')
  assert.equal(recordingAt(recs, T0 + 30_000), null, '第一段之前')
  assert.equal(recordingAt(recs, T0 + 140_000), null, '最后一段之后')
  const open = [{ file: 'recordings/录屏-1.mp4', startAt: T0 + 60_000, endAt: null }]
  assert.equal(recordingAt(open, T0 + 600_000).ms, 540_000, '应用崩了没写上结束时间')
  assert.equal(recSlideBase(3_725_000), 'rec-01.02.05')
  assert.equal(recSlideBase(-5), 'rec-00.00.00')
})

test('录屏截到的画面：前后 5 秒内有手动截的就不要（同一页不重复）；重截一段时先拿掉这段以前截的，别的照留，按时间排', () => {
  const slides = [
    { file: 'slides/10.01.40.jpg', at: T0 + 100_000 },
    { file: 'slides/rec-00.00.30.jpg', at: T0 + 30_000, source: 'recording', recording: 'recordings/录屏-1.mp4' },
    { file: 'slides/rec-00.03.00.jpg', at: T0 + 180_000, source: 'recording', recording: 'recordings/录屏-2.mp4' },
  ]
  assert.equal(wantRecFrame(slides, T0 + 97_000), false, '3 秒前用户手动截过')
  assert.equal(wantRecFrame(slides, T0 + 106_000), true)
  assert.equal(wantRecFrame(slides, T0 + 181_000), true, '只和手动截的比')
  const { slides: next, removed } = mergeRecSlides(slides, 'recordings/录屏-1.mp4', [
    { file: 'slides/rec-00.00.20.jpg', at: T0 + 20_000 },
    { file: 'slides/rec-00.01.10.jpg', at: T0 + 70_000 },
  ])
  assert.deepEqual(removed, ['slides/rec-00.00.30.jpg'])
  assert.deepEqual(next.map((x) => x.file), ['slides/rec-00.00.20.jpg', 'slides/rec-00.01.10.jpg', 'slides/10.01.40.jpg', 'slides/rec-00.03.00.jpg'])
  assert.deepEqual(next[0], { file: 'slides/rec-00.00.20.jpg', at: T0 + 20_000, source: 'recording', recording: 'recordings/录屏-1.mp4' })
  assert.equal(next[2].source, undefined, '手动截的不标')
  assert.deepEqual(recordingsToScan({ recordings: [{ file: 'a', frames: 2 }, { file: 'b' }, { file: 'c', frames: 0, framesError: 'x' }] }).map((r) => r.file), ['b'])
})

/* ---------------- 开关、暂停、停止 ---------------- */

// 假的录屏（不开窗口）：start 记下开始时间、建一个文件；stop 回结束时间
class FakeRecorder extends EventEmitter {
  constructor(clock, log) {
    super()
    this.clock = clock
    this.log = log
  }
  async start({ sessionDir, recordings }) {
    this.file = nextRecordingFile(sessionDir, recordings)
    fs.mkdirSync(path.join(sessionDir, 'recordings'), { recursive: true })
    fs.writeFileSync(path.join(sessionDir, this.file), Buffer.alloc(1000))
    this.log.push(['start', this.file])
    return { file: this.file, startAt: this.clock.now, width: 1920, height: 1246, mime: 'video/mp4' }
  }
  pcm(source, buf, rate) {
    this.log.push(['pcm', source, buf.length, rate])
  }
  async stop() {
    this.log.push(['stop', this.file])
    return { file: this.file, endAt: this.clock.now, bytes: 1000 }
  }
}

function setup({ scan, permission = () => 'granted' } = {}) {
  const t = tmpStore()
  const engine = new EventEmitter()
  engine.state = 'idle'
  engine.paused = false
  const clock = { now: T0 }
  const log = []
  let protects = 0
  const ctl = new ScreenRecording({
    engine,
    store: t.store,
    makeRecorder: () => new FakeRecorder(clock, log),
    makeWorker: () => ({ close: () => log.push(['worker-closed']) }),
    protect: () => (protects++, () => protects--),
    permission,
    scan: scan ?? (async ({ onFrame }) => (onFrame(0, Buffer.from('jpeg')), { count: 1 })),
  })
  const s = t.store.create({ mode: 'class', classSource: 'system', slides: [] })
  s.startedAt = T0
  engine.session = s
  const run = () => {
    engine.state = 'running'
    engine.emit('state', { state: 'running', sessionId: s.id })
  }
  const stop = async () => {
    engine.state = 'stopping'
    engine.emit('state', { state: 'stopping', sessionId: s.id })
    s.endedAt = clock.now
    // 引擎先写上 endedAt，等一会儿译文再最后存一次（这中间录屏收尾、截画面）
    await ctl.settled()
    await ctl.frames(s.id)
    t.store.saveNow(s)
    engine.state = 'idle'
  }
  return { ...t, engine, clock, log, ctl, s, run, stop, protects: () => protects }
}

test('录屏开关：开着录一段、关掉存好；一场里开两次是两个文件，起止时间记在这一场的时间轴上；录屏期间挡住自己的窗口，录完放开', async () => {
  const x = setup()
  assert.equal((await x.ctl.toggle(true)).ok, false, '没在记录时不能开')
  x.run()
  x.clock.now = T0 + 5_000
  const on = await x.ctl.toggle()
  assert.equal(on.ok, true)
  assert.equal(on.recording, true)
  assert.equal(x.protects(), 1)
  x.engine.emit('audio', 'system', Buffer.alloc(3200), 16000)
  assert.deepEqual(x.log.at(-1), ['pcm', 'system', 3200, 16000], '字幕那两路声音送进录屏')
  x.clock.now = T0 + 25_000
  assert.equal((await x.ctl.toggle()).on, false)
  assert.equal(x.protects(), 0)
  x.clock.now = T0 + 40_000
  await x.ctl.toggle(true)
  x.clock.now = T0 + 55_000
  await x.ctl.toggle(false)
  const recs = x.store.load(x.s.id).recordings
  assert.deepEqual(
    recs.map((r) => [r.file, r.startAt - T0, r.endAt - T0, r.width, r.height, r.bytes]),
    [
      ['recordings/录屏-1.mp4', 5_000, 25_000, 1920, 1246, 1000],
      ['recordings/录屏-2.mp4', 40_000, 55_000, 1920, 1246, 1000],
    ],
  )
  assert.deepEqual(x.ctl.status(), { sessionId: x.s.id, on: false, recording: false, starting: false, startAt: null, count: 2, totalMs: 35_000 })
  fs.rmSync(x.root, { recursive: true, force: true })
})

test('暂停记录：这一段收尾存好；继续时开关还开着就另开一段。停止记录：自动停掉、存好，再从每段里截画面并进 slides', async () => {
  const x = setup()
  x.run()
  x.clock.now = T0 + 10_000
  await x.ctl.toggle(true)
  x.clock.now = T0 + 20_000
  x.engine.paused = true
  x.engine.emit('pause', { paused: true, sessionId: x.s.id })
  await x.ctl.settled()
  assert.equal(x.ctl.status().recording, false)
  assert.equal(x.ctl.status().on, true, '开关还开着')
  x.clock.now = T0 + 30_000
  x.engine.paused = false
  x.engine.emit('pause', { paused: false, sessionId: x.s.id })
  await x.ctl.settled()
  assert.equal(x.ctl.status().recording, true)
  x.clock.now = T0 + 42_000
  await x.stop()
  const s = x.store.load(x.s.id)
  assert.deepEqual(
    s.recordings.map((r) => [r.startAt - T0, r.endAt - T0, r.frames]),
    [
      [10_000, 20_000, 1],
      [30_000, 42_000, 1],
    ],
  )
  assert.deepEqual(
    s.slides.map((sl) => [sl.file, sl.at - T0, sl.source, sl.recording]),
    [
      ['slides/rec-00.00.10.jpg', 10_000, 'recording', 'recordings/录屏-1.mp4'],
      ['slides/rec-00.00.30.jpg', 30_000, 'recording', 'recordings/录屏-2.mp4'],
    ],
  )
  assert.ok(fs.existsSync(path.join(x.store.dir(x.s.id), 'slides/rec-00.00.30.jpg')))
  assert.equal(x.ctl.status().on, false)
  assert.ok(x.log.some((l) => l[0] === 'worker-closed'))
  fs.rmSync(x.root, { recursive: true, force: true })
})

test('截画面和手动截的不重复；截不出来（只有声音、文件坏了）只记在那段录屏上，字幕和别的截图照旧', async () => {
  const frames = { 'recordings/录屏-1.mp4': [0, 8_000, 30_000], 'recordings/录屏-2.mp4': 'broken' }
  const x = setup({
    scan: async ({ file, onFrame }) => {
      const f = frames[`recordings/${path.basename(file)}`]
      if (f === 'broken') throw new Error('这个视频的画面读不出来')
      for (const ms of f) onFrame(ms, Buffer.from(`jpeg${ms}`))
      return { count: f.length }
    },
  })
  x.run()
  // 用户在第 18 秒手动截了一张（录屏开着），录屏里第 8 秒（这一场第 18 秒）那张就不要了
  x.s.slides.push({ file: 'slides/10.00.18.jpg', at: T0 + 18_000 })
  x.clock.now = T0 + 10_000
  await x.ctl.toggle(true)
  x.clock.now = T0 + 50_000
  await x.ctl.toggle(false)
  x.clock.now = T0 + 60_000
  await x.ctl.toggle(true)
  x.clock.now = T0 + 70_000
  await x.stop()
  const s = x.store.load(x.s.id)
  assert.deepEqual(
    s.slides.map((sl) => [sl.file, sl.at - T0, sl.source ?? 'manual']),
    [
      ['slides/rec-00.00.10.jpg', 10_000, 'recording'],
      ['slides/10.00.18.jpg', 18_000, 'manual'],
      ['slides/rec-00.00.40.jpg', 40_000, 'recording'],
    ],
  )
  assert.equal(s.recordings[0].frames, 2)
  assert.equal(s.recordings[1].frames, 0)
  assert.match(s.recordings[1].framesError, /读不出来/)
  assert.ok(!fs.existsSync(path.join(x.store.dir(x.s.id), 'slides/rec-00.00.18.jpg')), '不要的那张不落盘')
  fs.rmSync(x.root, { recursive: true, force: true })
})

test('没有屏幕录制权限：点了说清楚去哪开，开关不动', async () => {
  const x = setup({ permission: () => 'denied' })
  x.run()
  const r = await x.ctl.toggle(true)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'no-permission')
  assert.match(r.error, /系统设置 → 隐私与安全性 → 录屏与系统录音/)
  assert.equal(x.ctl.status().on, false)
  fs.rmSync(x.root, { recursive: true, force: true })
})

test('会话存储：引擎写上 endedAt、还没最后存的这几秒里别人改了（录屏截完画面），引擎最后那次保存不会把它盖掉', () => {
  const t = tmpStore()
  const s = t.store.create({ mode: 'meeting' })
  s.endedAt = Date.now() // 引擎在等译文
  t.store.mutate(s.id, (x) => (x.recordings = [{ file: 'recordings/录屏-1.mp4', frames: 1 }]))
  t.store.mutate(s.id, (x) => (x.slides = [{ file: 'slides/rec-00.00.00.jpg', at: s.startedAt, source: 'recording' }]))
  t.store.saveNow(s) // 引擎最后存一次（内存里的那个对象）
  const back = t.store.load(s.id)
  assert.equal(back.recordings.length, 1)
  assert.equal(back.slides.length, 1)
  assert.equal(t.store.isLive(s.id), false)
  fs.rmSync(t.root, { recursive: true, force: true })
})

/* ---------------- 纪要和课堂笔记用上录屏的截图 ---------------- */

const slideList = (manual, auto) => [
  ...Array.from({ length: manual }, (_, i) => ({ file: `slides/10.0${i}.00.jpg`, at: T0 + i * 60_000 + 30_000 })),
  ...Array.from({ length: auto }, (_, i) => ({ file: `slides/rec-00.${String(i).padStart(2, '0')}.10.jpg`, at: T0 + i * 60_000 + 10_000, source: 'recording', recording: 'recordings/录屏-1.mp4' })),
]

test('给模型看哪几张：只有手动截的取最近 6 张；录屏截的很多时手动的先放、剩下的从自动的里均匀挑，一共 8 张，按时间排', () => {
  assert.equal(pickSlides({ slides: slideList(9, 0) }).length, 6)
  assert.equal(manySlides({ slides: slideList(9, 0) }), false)
  const mix = pickSlides({ slides: slideList(2, 30) })
  assert.equal(mix.length, 8)
  assert.equal(mix.filter((x) => x.source !== 'recording').length, 2)
  assert.deepEqual(mix.map((x) => x.at), [...mix.map((x) => x.at)].sort((a, b) => a - b))
  assert.equal(mix.filter((x) => x.source === 'recording')[0].file, 'slides/rec-00.00.10.jpg', '均匀挑：第一张和最后一张都在')
  assert.equal(mix.filter((x) => x.source === 'recording').at(-1).file, 'slides/rec-00.29.10.jpg')
  assert.equal(pickSlides({ slides: slideList(8, 5) }).filter((x) => x.source === 'recording').length, 2, '手动的多也至少给 2 张自动的')
  assert.equal(manySlides({ slides: slideList(0, 3) }), true)
})

test('会议纪要的 prompt：有截图时让模型在讲到的地方引用，清单里标出手动截的和附了图的；没截图时不提', () => {
  const s = { startedAt: T0, segments: [{ startedAt: T0 + 5000, speaker: '对方', text: 'Look at this chart.' }], slides: slideList(1, 3) }
  const slides = pickSlides(s)
  const [sys, user] = summaryMessages({ session: s, slides, allSlides: s.slides })
  assert.match(sys.content, /!\[简短说明\]\(slides\/文件名\.jpg\)/)
  assert.match(user.content, /截图（共 4 张：标着「手动」的是用户自己截的/)
  assert.match(user.content, /- slides\/10\.00\.00\.jpg（\[00:30\]，手动，图附在后面）/)
  assert.match(user.content, /- slides\/rec-00\.01\.10\.jpg（\[01:10\]，图附在后面）/)
  const [sys0, user0] = summaryMessages({ session: { startedAt: T0, segments: [] } })
  assert.doesNotMatch(sys0.content, /slides\//)
  assert.doesNotMatch(user0.content, /截图/)
  // 课堂笔记：录屏截的也走「全部清单 + 附几张」，不说是视频里截的
  const [csys, cuser] = classNotesMessages({ session: { ...s, mode: 'class' }, slides, allSlides: s.slides })
  assert.match(csys.content, /标了它是课上哪个时间截的/)
  assert.doesNotMatch(cuser.content, /视频里自动截的画面/)
  assert.equal(slidesText({ startedAt: T0, video: { file: 'a.mp4' } }, { slides: [], allSlides: [{ file: 'slides/00.00.05.jpg', at: T0 + 5000 }] }).startsWith('视频里自动截的画面'), true, '视频模式照旧')
})

test('会议纪要生成：截图附在消息后面；模型引用了录屏截图就留着，编出来的（文件夹里没有）去掉', async () => {
  const t = tmpStore()
  const s = t.store.create({ mode: 'meeting' })
  const dir = t.store.dir(s.id)
  fs.mkdirSync(path.join(dir, 'slides'))
  s.slides = slideList(0, 3)
  for (const x of s.slides) fs.writeFileSync(path.join(dir, x.file), `img-${x.file}`)
  s.segments.push({ id: 's1', speaker: '对方', who: 'other', startedAt: s.startedAt + 70_000, text: 'Here is the revenue chart, please fix the axis.' })
  s.recordings = [{ file: 'recordings/录屏-1.mp4', startAt: s.startedAt, endAt: s.startedAt + 200_000, frames: 3 }]
  s.endedAt = Date.now()
  t.store.saveNow(s)
  const calls = []
  const llm = async (o) => {
    calls.push(o)
    if (o.json) return JSON.stringify({ title: '收入图', items: [] })
    return '## 一句话总结\n改图。\n\n## 讨论要点\n- 收入图的坐标轴要改\n  ![收入图](slides/rec-00.01.10.jpg)\n- 编的\n  ![没有](slides/rec-09.09.09.jpg)'
  }
  const sum = new Summarizer({ store: t.store, projects: t.projects, llm, aiStatus: () => ({ ready: true }), loadImage: (f) => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}` })
  const r = await sum.generate(s.id, '')
  const content = calls[0].messages[0].content
  assert.ok(Array.isArray(content), '截图附在消息后面')
  assert.equal(content.filter((x) => x.type === 'image').length, 3)
  assert.match(content[0].text, /slides\/rec-00\.01\.10\.jpg/)
  assert.match(r.markdown, /!\[收入图\]\(slides\/rec-00\.01\.10\.jpg\)/)
  assert.doesNotMatch(r.markdown, /rec-09\.09\.09/)
  assert.match(fs.readFileSync(path.join(dir, '会议纪要.md'), 'utf8'), /slides\/rec-00\.01\.10\.jpg/)
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('图文笔记：录了屏的场次，落在录屏里的时间和截图能让视频跳过去，没录屏的那段不能', () => {
  const s = { startedAt: T0, recordings: [{ startAt: T0 + 60_000, endAt: T0 + 120_000 }] }
  const at = seekableAt(s)
  assert.equal(at(90_000), 90_000)
  assert.equal(at(30_000), null)
  assert.equal(at(undefined), null)
  assert.equal(seekableAt({ startedAt: T0, video: { file: 'x' } })(30_000), 30_000, '视频模式哪里都能跳')
  assert.equal(seekableAt({ startedAt: T0 })(30_000), null, '没录屏的不能跳')
})

/* ---------------- 详情页：多段录屏跳转（渲染进程的 clips.js） ---------------- */

const clipsSrc = fs.readFileSync(new URL('../src/renderer/control/clips.js', import.meta.url), 'utf8')
const { videoClips, clipIndexAt, clipSeekable } = new Function(`${clipsSrc}\nreturn { videoClips, clipIndexAt, clipSeekable }`)()

test('详情页的视频分段：录屏按这一场的时间排成段；点一句、一张截图跳到它所在的那一段的那个位置；没在录的时候不跳', () => {
  const s = {
    startedAt: T0,
    dir: '/x/未归类/2026-11-18 10.00/',
    recordings: [
      { file: 'recordings/录屏-2.mp4', startAt: T0 + 120_000, endAt: T0 + 135_000 },
      { file: 'recordings/录屏-1.mp4', startAt: T0 + 60_000, endAt: T0 + 80_000 },
      { file: 'recordings/录屏-3.mp4', startAt: T0 + 200_000, endAt: null },
    ],
  }
  const clips = videoClips(s)
  assert.deepEqual(
    clips.map((c) => [c.file, c.start, c.end, c.n]),
    [
      ['/x/未归类/2026-11-18 10.00/recordings/录屏-1.mp4', 60_000, 80_000, 2],
      ['/x/未归类/2026-11-18 10.00/recordings/录屏-2.mp4', 120_000, 135_000, 1],
      ['/x/未归类/2026-11-18 10.00/recordings/录屏-3.mp4', 200_000, null, 3],
    ],
  )
  // 第二段里的一句：切到第二段，视频里的位置是 ms - start
  const i = clipIndexAt(clips, 125_000)
  assert.equal(i, 1)
  assert.equal(125_000 - clips[i].start, 5_000)
  assert.equal(clipIndexAt(clips, 70_000), 0)
  assert.equal(clipIndexAt(clips, 100_000), -1, '两段中间没录')
  assert.equal(clipIndexAt(clips, 999_000), 2, '最后一段没写结束时间')
  assert.equal(clipSeekable(clips, 100_000), null)
  assert.equal(clipSeekable(clips, 119_000), 120_000, '话说到一半才开的录屏：从这一段开头放')
  assert.equal(clipSeekable(clips, 70_000), 70_000)
  // 视频模式：一段，从 0 开始
  assert.deepEqual(videoClips({ startedAt: T0, video: { file: '/v/a.mp4', durationMs: 5000 } }), [{ file: '/v/a.mp4', start: 0, end: 5000, n: 1 }])
  assert.deepEqual(videoClips({ startedAt: T0, dir: '/x' }), [], '没录屏的场次没有视频')
})
