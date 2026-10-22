import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LiveNotes, countWords, mergeNotes, parseNotes } from '../src/main/class/liveNotes.js'
import { classNotesMessages, classTodoMessages, notesMessages } from '../src/main/class/prompts.js'
import { exportNotesTo, notesFileName, saveSlide } from '../src/main/class/files.js'
import { modeSettings, resolveMode, speakerLabel } from '../src/main/modes.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'

// 课堂模式：模式选择、实时笔记的解析 / 合并 / 调度和容错、课堂 prompt、截图和导出。

const START = new Date(2026, 8, 24, 14, 0, 0).getTime() // 2026-09-24 周四 14:00

/* ---------------- 模式 ---------------- */

test('resolveMode: start argument beats the project default; class source falls back project, then settings, then mic', () => {
  const s = merge(DEFAULTS, {})
  assert.deepEqual(resolveMode({}, null, s), { mode: 'meeting', classSource: null })
  assert.deepEqual(resolveMode({ mode: 'bogus' }, { mode: 'interview' }, s), { mode: 'interview', classSource: null })
  assert.deepEqual(resolveMode({ mode: 'meeting' }, { mode: 'class', classSource: 'system' }, s), { mode: 'meeting', classSource: null })
  assert.deepEqual(resolveMode({}, { mode: 'class', classSource: 'system' }, s), { mode: 'class', classSource: 'system' })
  assert.deepEqual(resolveMode({ classSource: 'mic' }, { mode: 'class', classSource: 'system' }, s), { mode: 'class', classSource: 'mic' })
  assert.deepEqual(resolveMode({ mode: 'class' }, { mode: 'meeting', classSource: '' }, applyPatch(s, { class: { source: 'system' } })), { mode: 'class', classSource: 'system' })
  assert.deepEqual(resolveMode({ mode: 'class', classSource: 'nope' }, null, {}), { mode: 'class', classSource: 'mic' })
})

test('modeSettings: interview forces auto answers, class turns auto off, meeting leaves settings alone', () => {
  const s = applyPatch(merge(DEFAULTS, {}), { assist: { enabled: false, auto: false, profile: 'cv' } })
  assert.equal(modeSettings(s, 'meeting'), s)
  const i = modeSettings(s, 'interview')
  assert.equal(i.assist.enabled, true)
  assert.equal(i.assist.auto, true)
  assert.equal(i.assist.profile, 'cv')
  const c = modeSettings(applyPatch(s, { assist: { enabled: true, auto: true } }), 'class')
  assert.equal(c.assist.enabled, true)
  assert.equal(c.assist.auto, false)
  assert.equal(s.assist.enabled, false) // 不改原对象
  assert.equal(speakerLabel('other', 'class'), '老师')
  assert.equal(speakerLabel('other', 'interview'), '对方')
  assert.equal(speakerLabel('me', 'class'), '我')
})

test('settings: v4 defaults and nested patches', () => {
  const s = merge(DEFAULTS, {})
  assert.deepEqual(s.display, { chunkColors: true, chunkStyle: 'text' })
  assert.deepEqual(s.class, { source: 'mic', notesEveryMin: 2, hotkeySlide: 'CommandOrControl+Alt+P', exportDir: '' })
  const p = applyPatch(s, { class: { exportDir: '/tmp/notes' }, display: { chunkColors: false } })
  assert.equal(p.class.exportDir, '/tmp/notes')
  assert.equal(p.class.hotkeySlide, 'CommandOrControl+Alt+P')
  assert.equal(p.display.chunkColors, false)
})

test('projects: mode and class source are stored, validated and copied', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-proj-'))
  const store = new ProjectStore({ root: () => root }).load()
  const a = store.create({ name: '机器学习', mode: 'class', classSource: 'system' })
  assert.equal(a.mode, 'class')
  assert.equal(a.classSource, 'system')
  const b = store.create({ name: '面试', mode: 'nope' })
  assert.equal(b.mode, 'meeting')
  assert.equal(b.classSource, '')
  assert.equal(store.update(b.id, { mode: 'interview' }).mode, 'interview')
  assert.equal(store.update(a.id, { classSource: 'bad' }).classSource, 'system')
  assert.equal(store.update(a.id, { classSource: '' }).classSource, '')
  const c = store.create({ name: '另一门课', copyFrom: a.id })
  assert.equal(c.mode, 'class')
  // 旧的 project.json 没有 mode：读出来是会议
  const legacy = path.join(root, '旧项目')
  fs.mkdirSync(legacy)
  fs.writeFileSync(path.join(legacy, 'project.json'), JSON.stringify({ id: 'p_old', name: '旧项目' }))
  assert.equal(store.load().get('p_old').mode, 'meeting')
  fs.rmSync(root, { recursive: true, force: true })
})

/* ---------------- 实时笔记：解析和合并 ---------------- */

test('parseNotes: normal reply, code fences, loose shapes, time and date normalisation, dashes', () => {
  const raw = '```json\n' + JSON.stringify({
    sections: [
      { title: 'Gradient descent', start: '1:05', points: ['沿负梯度走 \u2014 每步一小段', 42], formulas: ['$$\\theta_{t+1} = \\theta_t - \\eta \\nabla L$$', { latex: 'a \u2013 b' }], examples: '房价的例子' },
      '只有标题的小节',
      { points: ['没有标题'] },
      { title: '' },
    ],
    emphasis: ['要会推导', { text: 'unbiased', at: 125, quote: 'remember the word unbiased' }],
    homework: [{ text: '完成 problem set 3', dueText: 'next Wednesday before midnight' }, { task: '读 Bishop 第三章', deadline: '2026-09-25' }, { text: '' }],
    terms: { 'learning rate': '每一步走多远' },
  }) + '\n```'
  const n = parseNotes(raw, { startedAt: START })
  assert.equal(n.sections.length, 3)
  assert.deepEqual(n.sections[0], {
    title: 'Gradient descent',
    start: '01:05',
    points: ['沿负梯度走，每步一小段', '42'],
    formulas: ['\\theta_{t+1} = \\theta_t - \\eta \\nabla L', 'a - b'],
    examples: ['房价的例子'],
  })
  assert.deepEqual(n.sections[1], { title: '只有标题的小节', start: null, points: [], formulas: [], examples: [] })
  assert.equal(n.sections[2].title, '要点')
  assert.deepEqual(n.emphasis, [
    { text: '要会推导', at: null, quote: null },
    { text: 'unbiased', at: '02:05', quote: 'remember the word unbiased' },
  ])
  assert.deepEqual(n.homework, [
    { text: '完成 problem set 3', due: '2026-09-30', dueText: 'next Wednesday before midnight' },
    { text: '读 Bishop 第三章', due: '2026-09-25', dueText: null },
  ])
  assert.deepEqual(n.terms, [{ term: 'learning rate', zh: '', explain: '每一步走多远' }])
  for (const bad of ['', 'nope', '{"foo":1}', '[1,2]', null]) assert.equal(parseNotes(bad), null)
  assert.deepEqual(parseNotes('{"sections":[]}'), { sections: [], emphasis: [], homework: [], terms: [] })
})

test('mergeNotes: the new version wins, but sections, emphasis, homework and terms never silently disappear', () => {
  const prev = {
    sections: [
      { title: '损失函数', start: '00:10', points: ['MSE'], formulas: [], examples: [] },
      { title: '梯度下降', start: '01:00', points: ['负梯度'], formulas: [], examples: [] },
    ],
    emphasis: [{ text: 'The update rule will be on the exam', at: '01:30', quote: 'q' }],
    homework: [{ text: 'Finish problem set three', due: '2026-09-30', dueText: 'next Wednesday' }],
    terms: [{ term: 'MSE', zh: '均方误差', explain: 'x' }],
  }
  const next = {
    sections: [
      { title: '梯度下降与学习率', start: '01:00', points: ['负梯度', '学习率太大会发散'], formulas: [], examples: [] },
      { title: 'SGD', start: '03:00', points: ['小批量'], formulas: [], examples: [] },
    ],
    emphasis: [{ text: 'The update rule will be on the exam!', at: '01:30', quote: 'q' }, { text: 'Remember unbiased', at: '03:10', quote: 'q2' }],
    homework: [{ text: 'finish problem set three', due: null, dueText: null }, { text: 'Read chapter three of Bishop', due: '2026-09-25', dueText: "before Friday's lecture" }],
    terms: [{ term: 'mse', zh: '均方误差', explain: '新解释' }, { term: 'SGD', zh: '随机梯度下降', explain: 'y' }],
  }
  const m = mergeNotes(prev, next)
  assert.deepEqual(m.sections.map((x) => x.title), ['损失函数', '梯度下降与学习率', 'SGD']) // 丢掉的「损失函数」补回来，按时间排
  assert.equal(m.emphasis.length, 2)
  assert.equal(m.homework.length, 2)
  assert.equal(m.homework[0].due, '2026-09-30') // 新版没给截止时间，沿用上一版
  assert.equal(m.homework[0].dueText, 'next Wednesday')
  assert.deepEqual(m.terms.map((x) => x.term), ['mse', 'SGD'])
  assert.equal(mergeNotes(null, next), next)
  assert.equal(mergeNotes(prev, null), prev)
})

test('countWords: English words and Chinese characters', () => {
  assert.deepEqual(countWords('The loss, L of theta.'), { words: 5, han: 0 })
  assert.deepEqual(countWords('学习率 learning rate'), { words: 2, han: 3 })
})

/* ---------------- 实时笔记：调度和容错 ---------------- */

function notesHarness({ replies, ready = true, everyMin = 2 } = {}) {
  let now = START
  const calls = []
  const queue = [...replies]
  const llm = async (o) => {
    calls.push(o)
    const r = queue.shift()
    if (r instanceof Error) throw r
    return typeof r === 'string' ? r : JSON.stringify(r)
  }
  const updates = []
  const notes = new LiveNotes({ llm, llmStatus: () => ({ ready, reason: '还没登录' }), startedAt: START, everyMs: () => everyMin * 60_000, context: 'Intro ML', now: () => now })
  notes.on('update', (u) => updates.push(u))
  const say = (sec, text) => notes.add({ startedAt: START + sec * 1000, speaker: '老师', text })
  return { notes, calls, updates, say, advance: (sec) => (now += sec * 1000), at: (sec) => (now = START + sec * 1000) }
}

const sentence = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ') + '.'
const NOTE_A = { sections: [{ title: 'A', start: '00:05', points: ['a'] }], emphasis: [], homework: [], terms: [] }
const NOTE_B = { sections: [{ title: 'B', start: '02:10', points: ['b'] }], emphasis: [], homework: [{ text: '作业', dueText: 'next Wednesday' }], terms: [] }

test('LiveNotes: waits for about two minutes of content, then sends previous notes plus new lines; one request at a time', async () => {
  const h = notesHarness({ replies: [NOTE_A, NOTE_B] })
  h.at(5)
  h.say(5, sentence(30))
  assert.equal(h.notes.tick(), null)
  h.at(60)
  h.say(60, sentence(30))
  assert.equal(h.notes.tick(), null) // 还不到 2 分钟
  h.at(126)
  const p = h.notes.tick()
  assert.ok(p)
  assert.equal(h.notes.tick(), null) // 在跑的时候不再发
  h.say(126, sentence(20)) // 请求期间来的新内容留到下一次
  await p
  assert.equal(h.calls.length, 1)
  assert.equal(h.updates.length, 1)
  assert.equal(h.updates[0].error, null)
  assert.equal(h.updates[0].notes.sections[0].title, 'A')
  assert.match(h.calls[0].messages[0].content, /还没有，这是这节课的第一段/)
  assert.match(h.calls[0].messages[0].content, /\[00:05\] 老师：w0/)
  assert.match(h.calls[0].messages[0].content, /\[01:00\] 老师：/)
  assert.doesNotMatch(h.calls[0].messages[0].content, /\[02:06\]/)
  assert.equal(h.calls[0].model, 'smart')
  assert.equal(h.calls[0].json, true)
  assert.equal(h.notes.pending.length, 1)
  // 第二次：带上一版笔记；结果合并（A 没丢）
  h.at(250)
  await h.notes.tick()
  assert.match(h.calls[1].messages[0].content, /上一版笔记：\n\{"sections":\[\{"title":"A"/)
  assert.match(h.calls[1].messages[0].content, /\[02:06\] 老师：/)
  assert.deepEqual(h.updates[1].notes.sections.map((s) => s.title), ['A', 'B'])
  assert.equal(h.updates[1].notes.homework[0].due, '2026-09-30')
})

test('LiveNotes: 400 English words or 600 Chinese characters trigger at once', async () => {
  const h = notesHarness({ replies: [NOTE_A, NOTE_A] })
  h.at(10)
  h.say(5, sentence(400))
  await h.notes.running
  assert.equal(h.calls.length, 1)
  h.at(20)
  h.say(15, '讲'.repeat(600))
  await h.notes.running
  assert.equal(h.calls.length, 2)
})

test('LiveNotes: failures keep the previous version, report a reason, and retry later with the same lines', async () => {
  const h = notesHarness({ replies: [NOTE_A, new Error('额度用完了'), 'not json', NOTE_B] })
  h.at(10)
  h.say(5, sentence(400))
  await h.notes.running
  h.at(20)
  h.say(15, sentence(400))
  await h.notes.running
  assert.equal(h.updates[1].error, '实时笔记这次没更新：额度用完了')
  assert.deepEqual(h.updates[1].notes, h.updates[0].notes) // 保留上一版
  assert.equal(h.updates[1].updatedAt, h.updates[0].updatedAt)
  assert.equal(h.notes.tick(), null) // 刚失败，先等一会儿
  h.advance(61)
  await h.notes.tick()
  assert.match(h.updates[2].error, /格式不对/)
  h.advance(61)
  await h.notes.tick()
  assert.equal(h.updates[3].error, null)
  assert.match(h.calls[3].messages[0].content, /\[00:15\] 老师：w0/) // 失败的那批内容还在
  assert.deepEqual(h.updates[3].notes.sections.map((s) => s.title), ['A', 'B'])
})

test('LiveNotes: AI not ready pauses with one message; flush at the end sends what is left', async () => {
  const off = notesHarness({ replies: [], ready: false })
  off.at(10)
  off.say(5, sentence(400))
  off.say(6, sentence(10))
  assert.equal(off.calls.length, 0)
  assert.equal(off.updates.length, 1)
  assert.match(off.updates[0].error, /实时笔记暂停了：还没登录/)
  const h = notesHarness({ replies: [NOTE_A] })
  h.at(30)
  h.say(20, sentence(12)) // 不够一次常规更新
  assert.equal(h.notes.tick(), null)
  await h.notes.flush()
  assert.equal(h.calls.length, 1)
  h.say(40, sentence(50)) // 收尾以后不再收
  assert.equal(h.notes.pending.length, 0)
  const tiny = notesHarness({ replies: [NOTE_A] })
  tiny.say(1, 'Okay.')
  await tiny.notes.flush()
  assert.equal(tiny.calls.length, 0)
})

/* ---------------- 课堂 prompt ---------------- */

const lecture = {
  id: 's1',
  mode: 'class',
  startedAt: START,
  segments: [
    { speaker: '老师', startedAt: START + 5000, text: 'The loss L of theta is one over two n times the sum of squared errors.' },
    { speaker: '我', startedAt: START + 70_000, text: 'Why one over two n?' },
    { speaker: '老师', startedAt: START + 90_000, text: 'Problem set three is due next Wednesday before midnight.' },
  ],
  slides: [{ file: 'slides/14.01.10.jpg', at: START + 70_000 }],
}

test('class prompts: live notes, class notes and homework extraction carry the right pieces and no dashes', () => {
  const [ns, nu] = notesMessages({ prev: null, lines: [{ at: 5000, speaker: '老师', text: 'Hello' }], context: 'Intro ML', startedAt: START })
  assert.match(ns.content, /"sections"/)
  assert.match(ns.content, /LaTeX/)
  assert.match(nu.content, /课程背景：Intro ML/)
  assert.match(nu.content, /2026-09-24（周四）/)
  assert.match(nu.content, /\[00:05\] 老师：Hello/)
  const project = { id: 'p_ml', name: '机器学习', description: '研一必修', context: 'Intro ML' }
  const [cs, cu] = classNotesMessages({ session: lecture, project, extraAsk: '多给例子', slides: lecture.slides, liveNotes: { sections: [] } })
  for (const h of ['本节概览', '大纲与知识点', '公式与推导', '例子', '老师强调和可能的考点', '作业与截止', '术语表', '自测题', '没听清需要确认的地方']) assert.match(cs.content, new RegExp(`## ${h}`))
  assert.match(cs.content, /!\[简短说明\]\(slides\/文件名\.jpg\)/)
  assert.match(cu.content, /这节课属于「机器学习」/)
  assert.match(cu.content, /slides\/14\.01\.10\.jpg（\[01:10\] 截的）/)
  assert.match(cu.content, /额外要求：多给例子/)
  assert.match(cu.content, /\[00:05\] 老师：The loss/)
  assert.match(cu.content, /\[01:10\] 我：Why/)
  const [ts, tu] = classTodoMessages({ session: lecture, summary: '## 作业与截止\n- [ ] problem set 3', project, liveNotes: { homework: [{ text: 'ps3' }] } })
  assert.match(ts.content, /projectId 一律写 p_ml/)
  assert.match(tu.content, /上课时记下的作业/)
  for (const m of [ns, nu, cs, cu, ts, tu]) assert.doesNotMatch(m.content, /[\u2013\u2014]/)
})

/* ---------------- 截图和导出 ---------------- */

test('saveSlide: slides/<time>.jpg, same second gets a suffix', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-slide-'))
  const at = new Date(2026, 8, 24, 14, 3, 7).getTime()
  assert.equal(saveSlide(dir, Buffer.from('a'), at), 'slides/14.03.07.jpg')
  assert.equal(saveSlide(dir, Buffer.from('b'), at), 'slides/14.03.07 (2).jpg')
  assert.equal(fs.readFileSync(path.join(dir, 'slides/14.03.07 (2).jpg'), 'utf8'), 'b')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('exportNotesTo: note named by date and title, referenced and leftover slides copied, links rewritten', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-export-'))
  const sessionDir = path.join(tmp, 'session')
  fs.mkdirSync(path.join(sessionDir, 'slides'), { recursive: true })
  for (const f of ['14.01.10.jpg', '14.05.00.jpg']) fs.writeFileSync(path.join(sessionDir, 'slides', f), f)
  const session = {
    ...lecture,
    title: '梯度下降与学习率',
    slides: [{ file: 'slides/14.01.10.jpg', at: START + 70_000 }, { file: 'slides/14.05.00.jpg', at: START + 300_000 }],
    summary: { markdown: '## 本节概览\n看图：![损失曲线](slides/14.01.10.jpg)\n\n![不存在](slides/nope.jpg)\n' },
  }
  const out = path.join(tmp, 'vault', '机器学习')
  const r = exportNotesTo({ session, sessionDir, dir: out, projectName: '机器学习' })
  assert.equal(r.dir, out)
  const note = path.join(out, '2026-09-24 梯度下降与学习率 课堂笔记.md')
  assert.equal(r.files[0], note)
  const md = fs.readFileSync(note, 'utf8')
  assert.match(md, /^# 梯度下降与学习率\n\n- 日期：2026-09-24\n- 课程：机器学习/)
  assert.match(md, /!\[损失曲线\]\(2026-09-24%20梯度下降与学习率%20截图\/14\.01\.10\.jpg\)/)
  assert.match(md, /!\[不存在\]\(slides\/nope\.jpg\)/) // 找不到的图原样留着
  assert.match(md, /## 课上截图\n\n!\[\[05:00\]\]\(2026-09-24%20梯度下降与学习率%20截图\/14\.05\.00\.jpg\)/)
  assert.ok(fs.existsSync(path.join(out, '2026-09-24 梯度下降与学习率 截图', '14.01.10.jpg')))
  assert.ok(fs.existsSync(path.join(out, '2026-09-24 梯度下降与学习率 截图', '14.05.00.jpg')))
  assert.equal(r.files.length, 3)
  // 再导出一次覆盖同一个文件
  exportNotesTo({ session, sessionDir, dir: out })
  assert.equal(fs.readdirSync(out).length, 2)
  assert.throws(() => exportNotesTo({ session: { ...session, summary: null }, sessionDir, dir: out }), /还没生成课堂笔记/)
  assert.equal(notesFileName(session), '课堂笔记.md')
  assert.equal(notesFileName({ mode: 'meeting' }), '会议纪要.md')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('exportNotesTo: links that climb out of slides/ are left alone, nothing outside is copied', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-export-'))
  const sessionDir = path.join(tmp, 'a', 'b', 'session')
  fs.mkdirSync(path.join(sessionDir, 'slides'), { recursive: true })
  fs.writeFileSync(path.join(sessionDir, 'slides', '14.01.10.jpg'), 'ok')
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret')
  fs.writeFileSync(path.join(tmp, 'a', 'b', 'x.jpg'), 'not a slide of this class')
  // sessionDir/slides 往上 4 层就是 tmp：这几个链接在旧代码里都会把文件拷进笔记库
  assert.ok(fs.existsSync(path.join(sessionDir, 'slides', '../../../../secret.txt')))
  assert.ok(fs.existsSync(path.join(sessionDir, 'slides', '../../x.jpg')))
  const md = '![](slides/../../../../secret.txt)\n![](slides/..%2F..%2F..%2F..%2Fsecret.txt)\n![](slides/../../x.jpg)\n![ok](slides/14.01.10.jpg)'
  const session = { ...lecture, title: '安全', slides: [{ file: 'slides/14.01.10.jpg', at: START }], summary: { markdown: md } }
  const out = path.join(tmp, 'vault')
  const r = exportNotesTo({ session, sessionDir, dir: out })
  const files = fs.readdirSync(out, { recursive: true }).map(String)
  assert.ok(!files.some((f) => f.includes('secret') || f.endsWith('x.jpg')), files.join(','))
  assert.equal(r.files.length, 2) // 笔记和那一张截图
  const body = fs.readFileSync(r.files[0], 'utf8')
  assert.match(body, /!\[\]\(slides\/\.\.\/\.\.\/\.\.\/\.\.\/secret\.txt\)/) // 原样留着
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('sessions: class notes are written as 课堂笔记.md and records carry the mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sess-'))
  const projects = new ProjectStore({ root: () => root }).load()
  const store = new SessionStore({ projects })
  const s = store.create({ mode: 'class', classSource: 'mic', slides: [] })
  s.segments.push({ id: 'mic:1', source: 'mic', speaker: '老师', who: 'other', startedAt: s.startedAt + 1000, text: 'Hello class.', sentences: [] })
  s.endedAt = Date.now()
  s.summary = { markdown: '## 本节概览\n好' }
  store.saveNow(s)
  const dir = store.dir(s.id)
  assert.ok(fs.existsSync(path.join(dir, '课堂笔记.md')))
  assert.ok(!fs.existsSync(path.join(dir, '会议纪要.md')))
  assert.match(fs.readFileSync(path.join(dir, '字幕记录.md'), 'utf8'), /# 课堂 ·[\s\S]*老师\*\*：Hello class\./)
  const rec = store.list()[0]
  assert.equal(rec.mode, 'class')
  fs.rmSync(root, { recursive: true, force: true })
})

test('Summarizer: class sessions get class notes with slides as images, homework lands in the class project', async () => {
  const { Summarizer } = await import('../src/main/summary.js')
  const { resolveRelativeDate } = await import('../src/main/todos.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-classsum-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const ml = ps.create({ name: '机器学习', mode: 'class', context: 'Intro ML' })
  ps.create({ name: '面试：X 公司' })
  const store = new SessionStore({ projects: ps })
  const s = store.create({ projectId: ml.id, mode: 'class', classSource: 'mic', slides: [] })
  const dir = store.dir(s.id)
  for (let i = 0; i < 8; i++) s.slides.push({ file: saveSlide(dir, Buffer.from(`img${i}`), s.startedAt + i * 1000), at: s.startedAt + i * 1000 })
  s.liveNotes = { sections: [{ title: '梯度下降' }], emphasis: [], homework: [{ text: 'ps3' }], terms: [] }
  s.segments.push({ id: 'mic:1', speaker: '老师', who: 'other', startedAt: s.startedAt + 90_000, text: 'Problem set three is due next Wednesday before midnight.' })
  s.endedAt = Date.now()
  store.saveNow(s)
  const calls = []
  const llm = async (o) => {
    calls.push(o)
    if (!o.json) return '## 本节概览\n梯度下降。\n![曲线](slides/x.jpg)'
    return JSON.stringify({ title: '梯度下降', items: [{ text: '完成 problem set 3', dueText: 'next Wednesday before midnight', projectId: 'p_wrong', quote: 'Problem set three is due', at: '01:30' }] })
  }
  const sum = new Summarizer({ store, projects: ps, llm, aiStatus: () => ({ ready: true }), loadImage: (f) => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}` })
  const r = await sum.generate(s.id, '多给例子')
  assert.match(calls[0].system, /课堂笔记助手/)
  const content = calls[0].messages[0].content
  assert.ok(Array.isArray(content))
  assert.equal(content.filter((x) => x.type === 'image').length, 6) // 最多 6 张，取最近的
  assert.match(content[0].text, /slides\/14|slides\//)
  assert.match(content[0].text, /实时笔记/)
  assert.match(content[0].text, /额外要求：多给例子/)
  assert.equal(content.at(-1).dataUrl, `data:image/jpeg;base64,${Buffer.from('img7').toString('base64')}`)
  assert.match(calls[1].system, /课堂助理/)
  assert.equal(r.items.length, 1)
  assert.equal(r.items[0].projectId, ml.id) // 全部归到这节课的项目
  assert.equal(r.items[0].owner, 'me')
  assert.equal(r.items[0].due, resolveRelativeDate('next Wednesday', s.startedAt)) // 模型没给日期，兜底换算
  assert.equal(store.load(s.id).title, '梯度下降')
  assert.ok(fs.existsSync(path.join(dir, '课堂笔记.md')))
  fs.rmSync(root, { recursive: true, force: true })
})

test('ruleDate: plain this/next + weekday follows the fixed rule and wins over a model date; anything more complex is left alone', async () => {
  const { ruleDate, parseTodoItems } = await import('../src/main/todos.js')
  assert.equal(ruleDate('next Wednesday before midnight', START), '2026-09-30')
  assert.equal(ruleDate('by next Friday', START), '2026-10-02')
  assert.equal(ruleDate('this Sunday at 8 p.m.', START), '2026-09-27')
  assert.equal(ruleDate('下周三之前', START), '2026-09-30')
  for (const s of ['two weeks from next Monday', "before Friday's lesson", 'on October 15th', '下下周一', 'next week', '', null]) assert.equal(ruleDate(s, START), null)
  const { items } = parseTodoItems(JSON.stringify({ items: [
    { text: '交 problem set 3', due: '2026-10-07', dueText: 'next Wednesday before midnight' },
    { text: '读 Bishop 第三章', due: '2026-09-25', dueText: "before Friday's lesson" },
  ] }), { startedAt: START })
  assert.deepEqual(items.map((x) => x.due), ['2026-09-30', '2026-09-25'])
  const notes = parseNotes(JSON.stringify({ homework: [{ text: 'ps3', due: '2026-10-07', dueText: 'next Wednesday before midnight' }] }), { startedAt: START })
  assert.equal(notes.homework[0].due, '2026-09-30')
})

test('live notes: meetings and interviews get their own prompt; LiveNotes passes the mode through', async () => {
  const lines = [{ at: 5000, speaker: '对方', text: 'Let us ship the draft by Friday.' }]
  const [ms, mu] = notesMessages({ lines, context: 'Paper sync', startedAt: START, mode: 'meeting' })
  assert.match(ms.content, /会议记录助手/)
  assert.match(ms.content, /sections：会上讨论的议题/)
  assert.match(ms.content, /homework：待办/)
  assert.match(mu.content, /会议背景：Paper sync/)
  assert.match(mu.content, /新增的会议字幕：\n\[00:05\] 对方：Let us ship/)
  const [is] = notesMessages({ lines, startedAt: START, mode: 'interview' })
  assert.match(is.content, /面试记录助手/)
  assert.match(is.content, /追问：/)
  let seen = null
  const n = new LiveNotes({ llm: async (o) => ((seen = o.system), '{"sections":[{"title":"交稿时间","start":"00:05","points":["周五交初稿"]}],"emphasis":[],"homework":[],"terms":[]}'), startedAt: START, mode: 'meeting', now: () => START + 200_000, everyMs: () => 1 })
  n.add({ id: 1, startedAt: START + 5000, speaker: '对方', text: 'Let us ship the draft by Friday, everyone agrees on that plan, and Anna will check the figures before then.' })
  await n.running
  assert.match(seen, /会议记录助手/)
  assert.equal(n.notes.sections[0].title, '交稿时间')
})
