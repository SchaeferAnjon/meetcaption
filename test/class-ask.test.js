import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassAsk } from '../src/main/class/ask.js'
import { askMessages, coverOf, estTokens, notesForAsk, pagesForAsk, parseAsk, resolveSources, searchTokens, slidesForAsk, transcriptForAsk, withAsked, ASKED_MARK } from '../src/main/class/askPrompt.js'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { Summarizer } from '../src/main/summary.js'

// 课上问 AI：取材（长课只给相关的几段）、prompt、回答的解析、存进这节课、课堂笔记末尾的「课上问过的」、课上和课后走哪条 AI 通道。

const START = new Date(2026, 10, 11, 10, 0, 0).getTime()
const mmss = (ms) => `${String(Math.floor((ms - START) / 60000)).padStart(2, '0')}:00`

// 两个小时的课：每分钟一句，大多讲别的；第 41 分钟讲 Ising，第 95 分钟讲 gain cell
function longClass() {
  const segs = []
  for (let i = 0; i < 120; i++) {
    let text = `Today we continue with the part number ${i} of the lecture about circuits and the transistor level behaviour of the amplifier stage, lots of filler words here to make it a realistic sentence length.`
    let tr = `今天我们继续讲第 ${i} 部分，关于电路和放大器级的晶体管行为。`
    if (i === 41) [text, tr] = ['And then we write it as the Ising Hamiltonian, H of sigma, where sigma is the configuration of all the spins.', '然后我们把它写成 Ising 哈密顿量 H(σ)，σ 是所有自旋的取值。']
    if (i === 95) [text, tr] = ['They can mean a gain cell, for example.', '它们可以指增益单元，比如。']
    segs.push({ id: `g${i}`, startedAt: START + i * 60_000, text, speaker: '老师', sentences: [{ text, tr }] })
  }
  return segs
}

test('searchTokens: Latin words without stop words, Han as pairs', () => {
  const t = searchTokens('Ising Hamiltonian 那段没听懂 the H of sigma')
  assert.ok(t.has('ising') && t.has('hamiltonian') && t.has('sigma'))
  assert.ok(!t.has('the') && !t.has('of'))
  assert.ok(t.has('没听') && t.has('听懂'))
})

test('transcriptForAsk: a short class goes in whole, numbered, with the time column', () => {
  const segs = longClass().slice(0, 5)
  const r = transcriptForAsk(segs, { query: 'anything', clockTime: mmss })
  assert.equal(r.shown, 5)
  assert.match(r.text, /^#1 \[00:00\] 老师：Today we continue/)
  assert.equal(r.refs.get(5), 'g4')
  assert.ok(!r.text.includes('省略'))
})

test('transcriptForAsk: a two hour class keeps to the budget and still has the latest lines, the quoted line and the lines matching the question (Chinese question, English transcript)', () => {
  const segs = longClass()
  const terms = [{ term: 'Ising Hamiltonian', zh: 'Ising 哈密顿量' }]
  const r = transcriptForAsk(segs, { query: 'Ising 哈密顿量那段没听懂，H(σ) 到底是什么', terms, clockTime: mmss, budget: 1200 })
  const ids = [...r.refs.values()]
  assert.ok(estTokens(r.text) <= 1300, `估算 ${estTokens(r.text)} token`)
  assert.ok(r.shown < 60 && r.total === 120)
  assert.ok(ids.includes('g41'), '问到的那一段在里面')
  assert.ok(ids.includes('g119') && ids.includes('g118'), '最近的在里面')
  assert.match(r.text, /中间省略/)
  // 引用的那句：即使问题里一个相关的词也没有
  const q = transcriptForAsk(segs, { query: '这句什么意思', quoteId: 'g95', clockTime: mmss, budget: 1200 })
  const qids = [...q.refs.values()]
  assert.ok(qids.includes('g95') && qids.includes('g94') && qids.includes('g96'))
  // 编号和字幕 id 对得上
  for (const [no, id] of q.refs) assert.ok(q.text.includes(`#${no} [`), `${id} 的编号 ${no}`)
})

test('transcriptForAsk: tokens grow with the question, not with the class length', () => {
  const segs = longClass()
  const small = transcriptForAsk(segs.slice(0, 60), { query: 'Ising', clockTime: mmss })
  const big = transcriptForAsk([...segs, ...segs.map((s) => ({ ...s, id: `x${s.id}`, startedAt: s.startedAt + 7_200_000 }))], { query: 'Ising', clockTime: mmss })
  assert.ok(estTokens(big.text) <= 3300)
  assert.ok(estTokens(big.text) < estTokens(small.text) * 3)
})

test('notesForAsk: numbered sections with formulas; trims points before dropping sections', () => {
  const notes = { sections: [{ title: '自旋', start: '05:00', points: ['σ 取 ±1'], formulas: ['H=-\\sum J'] }, { title: '增益单元', points: ['a', 'b', 'c', 'd'] }], emphasis: [{ text: '会考' }] }
  const out = notesForAsk(notes)
  assert.match(out, /^笔记1（05:00） 自旋：σ 取 ±1；\$H=-\\sum J\$/)
  assert.match(out, /笔记2 增益单元：a；b；c；d/)
  assert.match(out, /老师强调：会考/)
  const big = { sections: Array.from({ length: 40 }, (_, i) => ({ title: `节${i}`, points: Array.from({ length: 12 }, (_, j) => `第 ${j} 条要点，写得长一些，让它放不下 ${'字'.repeat(40)}`) })) }
  const cut = notesForAsk(big, 3600)
  assert.ok(cut.length <= 3601)
  assert.match(cut, /笔记40/, '放不下时每节都还在，只是少给要点')
})

test('pagesForAsk: only pages that match the question, tagged with the page number', () => {
  const pages = [
    { mat: 1, matName: '课件.pdf', n: 1, text: 'Title slide' },
    { mat: 1, matName: '课件.pdf', n: 14, text: 'Gain cell: two transistor memory, gate stores the charge' },
    { mat: 1, matName: '课件.pdf', n: 15, text: 'Kirchhoff current law' },
  ]
  const r = pagesForAsk(pages, { query: '老师说的 gain cell 是什么', terms: [] })
  assert.deepEqual(r.picked, [{ tag: '课件p14', mat: 1, n: 14, matId: undefined, name: '课件.pdf' }])
  assert.match(r.text, /^课件p14（《课件.pdf》第 14 页）：Gain cell/)
  assert.equal(pagesForAsk(pages, { query: '完全无关的问题 xyz' }).text, '')
  assert.equal(pagesForAsk(pages, { query: 'gain cell', multi: true }).picked[0].tag, '课件1p14')
})

test('slidesForAsk: attaches the screens nearest the quoted line, else the latest', () => {
  const slides = [1, 2, 3, 4].map((i) => ({ file: `slides/${i}.jpg`, at: START + i * 600_000 }))
  const near = slidesForAsk(slides, { quoteAt: START + 1_250_000, clockTime: mmss })
  assert.deepEqual(near.attach.map((x) => x.no), [2, 3])
  assert.match(near.list, /截图1（10:00）；截图2.*附图/)
  const latest = slidesForAsk(slides, { clockTime: mmss })
  assert.deepEqual(latest.attach.map((x) => x.no), [3, 4])
  assert.equal(slidesForAsk([], { clockTime: mmss }).list, '')
})

test('askMessages: earlier questions come first as turns, this question and the material last; quote carries the line number', () => {
  const segs = longClass().slice(40, 45)
  const transcript = transcriptForAsk(segs, { query: 'Ising', quoteId: 'g41', clockTime: mmss })
  const quoteLine = { no: [...transcript.refs].find(([, id]) => id === 'g41')[0] }
  const m = askMessages({
    session: { startedAt: START, endedAt: START + 7_200_000 },
    live: false,
    lang: 'zh',
    keywords: ['Ising'],
    transcript,
    notes: notesForAsk({ sections: [{ title: '自旋', points: ['x'] }] }),
    question: '这句什么意思？',
    quote: { segId: 'g41', text: segs[1].text, sel: 'Ising Hamiltonian' },
    quoteLine,
    history: [{ q: '什么是 Ising？', gist: '一个自旋模型', points: [{ text: '自旋只能 ±1' }, { tex: 'H=-J\\sigma\\sigma' }] }],
  })
  assert.equal(m.messages.length, 3)
  assert.deepEqual(m.messages.map((x) => x.role), ['user', 'assistant', 'user'])
  assert.match(m.messages[1].content, /要点：一个自旋模型\n- 自旋只能 ±1\n- \$\$H=-J\\sigma\\sigma\$\$/)
  const last = m.messages[2].content
  assert.match(last, /这节课已经下课，全长 120 分钟/)
  assert.match(last, /笔记1 自旋：x/)
  assert.match(last, /我引用了这一句字幕（#2）：「And then we write it as the Ising Hamiltonian/)
  assert.match(last, /我选中的是「Ising Hamiltonian」/)
  assert.match(last, /我的问题：这句什么意思？$/m)
  assert.match(m.system, /简体中文/)
  assert.match(m.system, /覆盖：/)
  assert.equal(m.refs.notes, 1)
})

test('parseAsk: reads cover, gist, points (inline and display formulas), sources and follow-ups; a half-written line is shown but sources wait for the end', () => {
  const refs = { seg: new Map([[3, 'g3'], [5, 'g5']]), notes: 3, slides: new Map([[1, { file: 'slides/a.jpg', at: 5 }]]), pages: [{ tag: '课件p14', mat: 1, n: 14, matId: 'm1', name: '课件.pdf' }] }
  const full = [
    '覆盖：提了一句 #3',
    '要点：H(σ) 是给每种自旋取值打的「能量分」',
    '- σ 是所有自旋的取值（老师说的 plus one or minus one）',
    '- $J_{ij}$ 是耦合（coupling）：',
    '$$H(\\sigma)=-\\sum J_{ij}\\sigma_i\\sigma_j$$',
    '- 找最优解就是找让 $H$ 最小的取值',
    '依据：#3 #5 #3 笔记2 笔记9 截图1 课件p14 课件p99',
    '接着问：准最小和真正的最小差多少？｜为什么 H 最小就是最优解？',
  ].join('\n')
  const p = parseAsk(full, refs, { final: true })
  assert.deepEqual(p.cover, { kind: 'partial', segNo: 3 })
  assert.deepEqual(coverOf(p.cover, refs), { kind: 'partial', segId: 'g3' })
  assert.equal(p.gist, 'H(σ) 是给每种自旋取值打的「能量分」')
  assert.deepEqual(p.points.map((x) => x.tex ?? x.text), ['σ 是所有自旋的取值（老师说的 plus one or minus one）', '$J_{ij}$ 是耦合（coupling）：', 'H(\\sigma)=-\\sum J_{ij}\\sigma_i\\sigma_j', '找最优解就是找让 $H$ 最小的取值'])
  assert.deepEqual(p.src, [{ type: 'seg', id: 'g3' }, { type: 'seg', id: 'g5' }, { type: 'note', n: 1 }, { type: 'slide', file: 'slides/a.jpg', at: 5 }, { type: 'page', mat: 1, n: 14, matId: 'm1', name: '课件.pdf' }])
  assert.equal(p.next.length, 2)
  // 一条要点只有一个公式时当独占一行的公式；接着问里不带公式符号
  const one = parseAsk('要点：x\n- $J_{ij}\\sigma_i$。\n- 普通的一条\n接着问：$J_{ij}$ 和 \\sigma 是什么｜h_i 呢', refs, { final: true })
  assert.deepEqual(one.points, [{ tex: 'J_{ij}\\sigma_i' }, { text: '普通的一条' }])
  assert.deepEqual(one.next, ['J_ij 和 sigma 是什么', 'h_i 呢'])
  // 流式：写到一半
  const half = parseAsk('覆盖：讲过\n要点：H(σ) 是能量\n- σ 是自旋的取\n$$H(\\sig', refs)
  assert.equal(half.cover.kind, 'full')
  assert.equal(half.gist, 'H(σ) 是能量')
  assert.deepEqual(half.points.map((x) => x.text), ['σ 是自旋的取'])
  assert.deepEqual(half.src, [])
  // 没按格式写
  const loose = parseAsk('H 是能量\n再解释一下\n另一点', refs, { final: true })
  assert.equal(loose.gist, 'H 是能量')
  assert.equal(loose.points.length, 2)
  assert.equal(loose.cover, null)
  // 破折号换掉
  assert.ok(!parseAsk('要点：能量——越低越好', refs, { final: true }).gist.includes('—'))
})

test('resolveSources: unknown numbers are dropped, the same source shows once', () => {
  const refs = { seg: new Map([[1, 'a']]), notes: 1, pages: [{ mat: 2, n: 3 }] }
  assert.deepEqual(resolveSources('#1 #1 #2 笔记1 笔记2 课件2p3 课件p3', refs), [{ type: 'seg', id: 'a' }, { type: 'note', n: 0 }, { type: 'page', mat: 2, n: 3 }])
  assert.deepEqual(resolveSources('无', refs), [])
})

test('resolveSources: at most four subtitle times, the other kinds still come through', () => {
  const refs = { seg: new Map([1, 2, 3, 4, 5, 6].map((n) => [n, `g${n}`])), notes: 2 }
  const out = resolveSources('#1 #2 #3 #4 #5 #6 笔记1', refs)
  assert.deepEqual(out.map((x) => x.id ?? `n${x.n}`), ['g1', 'g2', 'g3', 'g4', 'n0'])
})

test('withAsked: adds one line per question at the end, replaces the old part, leaves the notes alone when nothing was asked', () => {
  const md = '## 本节概览\n内容\n'
  const asks = [
    { id: 'b', q: '为什么 H 最小就是最优解？', askedAt: START + 50 * 60_000, gist: '把「好」定义成了「能量低」', points: [] },
    { id: 'a', q: 'H(σ) 是什么？', askedAt: START + 13 * 60_000, gist: '给每种取值打的能量分', points: [] },
    { id: 'c', q: '下课后问的', after: true, askedAt: START + 9e6, gist: '', points: [{ text: '先说这个' }] },
    { id: 'd', q: '没答出来的', askedAt: START, gist: '', points: [] },
  ]
  const once = withAsked(md, asks, START)
  assert.match(once, /<!--asked-->\n## 课上问过的\n\n- 13:00 \*\*H\(σ\) 是什么？\*\* 给每种取值打的能量分\n- 50:00 \*\*为什么 H 最小就是最优解？\*\* 把「好」定义成了「能量低」\n- 下课后 \*\*下课后问的\*\*：先说这个\n\n完整的回答在「问 AI」里看，点时间回到那句字幕。\n$/)
  assert.ok(!once.includes('没答出来的'))
  const withQuote = withAsked(md, [{ id: 'q', q: '这句什么意思？', askedAt: START + 5 * 60_000, quote: { text: 'And then we write it as the Ising Hamiltonian, H of sigma, where sigma is the configuration', segId: 'g' }, gist: '把问题写成能量', points: [] }], START)
  assert.match(withQuote, /- 05:00 \*\*这句什么意思？\*\*（引用「And then we write it as …」） 把问题写成能量/)
  const twice = withAsked(once, asks.slice(0, 1), START)
  assert.equal(twice.split(ASKED_MARK).length, 2)
  assert.ok(!twice.includes('H(σ) 是什么'))
  assert.equal(withAsked(md, [], START), md)
  assert.equal(withAsked(once, [], START).trim(), md.trim(), '问过的都没了就去掉整段')
  assert.equal(withAsked('', asks, START), '')
})

/* ---------------- 控制器：假的 store、假的 AI ---------------- */

function setup({ ended = true, markdown = null, slides = [], materials = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ask-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const store = new SessionStore({ projects: ps })
  const s = store.create({ mode: 'class', classSource: 'mic', slides, liveNotes: { sections: [{ title: '自旋模型', start: '12:00', points: ['σ 取 ±1'], formulas: ['H=-\\sum J'] }], terms: [{ term: 'Ising Hamiltonian', zh: 'Ising 哈密顿量', explain: 'x' }] } })
  s.startedAt = START
  s.segments.push(...longClass().slice(0, 50))
  if (ended) s.endedAt = START + 3_000_000
  if (markdown) s.summary = { markdown }
  if (materials.length) s.materials = materials
  store.saveNow(s)
  return { root, store, id: s.id, dir: store.dir(s.id), ps }
}

const answerText = ['覆盖：讲过', '要点：H(σ) 是给每种自旋取值打的能量分', '- σ 取 ±1', '- 越低越好', '依据：#41 笔记1', '接着问：然后呢？'].join('\n')

function ask(over = {}) {
  const t = setup(over.setup)
  const calls = []
  const events = []
  let release = null
  const llm = async (o) => {
    calls.push(o)
    if (over.llm) return over.llm(o, { release: (fn) => (release = fn) })
    o.onUsage?.({ prompt_tokens: 1234, completion_tokens: 56 })
    o.onDelta?.(answerText.slice(0, 40))
    return answerText
  }
  const statuses = []
  const a = new ClassAsk({
    store: t.store,
    llm,
    aiStatus: over.aiStatus ?? ((at) => (statuses.push(at), { ready: true })),
    source: over.source ?? (() => null),
    projectOf: () => ({ context: '电路与系统', keywords: 'Ising, gain cell' }),
    onSaved: (id) => events.push(['saved', id]),
  })
  a.on('update', (u) => events.push(['update', u]))
  const done = () =>
    new Promise((resolve) => {
      const f = (u) => {
        if (u.status !== 'streaming') (a.off('update', f), resolve(u))
      }
      a.on('update', f)
    })
  return { ...t, a, calls, events, statuses, done }
}

test('ClassAsk after class: asks with the session start time (same credential as the class notes), streams, saves into session.asks and into the notes', async () => {
  const t = ask({ setup: { markdown: '## 本节概览\n内容\n' } })
  const fin = t.done()
  const r = await t.a.ask({ sessionId: t.id, question: 'Ising 哈密顿量那段没听懂，H(σ) 到底是什么？' })
  assert.equal(r.ok, true)
  const u = await fin
  assert.equal(u.status, 'done')
  assert.equal(u.gist, 'H(σ) 是给每种自旋取值打的能量分')
  assert.equal(u.after, true)
  assert.deepEqual(u.cover, { kind: 'full' })
  assert.deepEqual(u.src.map((x) => x.type), ['seg', 'note'])
  assert.deepEqual(u.usage, { input: 1234, output: 56 })
  assert.equal(t.calls[0].sessionStartedAt, START, '课后走和课堂笔记一样的凭据')
  assert.deepEqual(t.statuses, [START])
  assert.ok(t.calls[0].messages.at(-1).content.includes('Ising'))
  assert.match(t.calls[0].messages.at(-1).content, /#\d+ \[\d\d:00\] 老师：And then we write it as the Ising Hamiltonian/)
  assert.equal(t.calls[0].model, 'answer')
  const s = t.store.load(t.id)
  assert.equal(s.asks.length, 1)
  assert.equal(s.asks[0].q, 'Ising 哈密顿量那段没听懂，H(σ) 到底是什么？')
  assert.equal(s.asks[0].status, 'done')
  assert.ok(s.summary.markdown.includes('## 课上问过的') && s.summary.markdown.includes('下课后'))
  assert.ok(fs.readFileSync(path.join(t.dir, '课堂笔记.md'), 'utf8').includes('课上问过的'))
  assert.ok(t.events.some((e) => e[0] === 'saved' && e[1] === t.id))
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk: a quoted sentence (sen) becomes the quote text, and the whole line still goes in the transcript', async () => {
  const t = ask()
  const seg = t.store.load(t.id).segments.find((x) => x.id === 'g41')
  assert.equal(seg.sentences.length, 1)
  t.store.mutate(t.id, (s) => {
    const x = s.segments.find((y) => y.id === 'g41')
    x.sentences = [{ text: 'First sentence of the line.' }, { text: 'Second sentence of the line.' }]
    x.text = 'First sentence of the line. Second sentence of the line.'
  })
  const fin = t.done()
  await t.a.ask({ sessionId: t.id, question: '这句什么意思？', quote: { segId: 'g41', sen: 1 } })
  const u = await fin
  assert.equal(u.quote.text, 'Second sentence of the line.')
  assert.equal(u.quote.sel, undefined)
  const last = t.calls[0].messages.at(-1).content
  assert.match(last, /我引用了这一句字幕（#\d+）：「Second sentence of the line\.」/)
  assert.match(last, /First sentence of the line\. Second sentence of the line\./)
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk follow-up: the earlier question and answer ride along; a quote is looked up from the stored line, not trusted from the window', async () => {
  const t = ask()
  let fin = t.done()
  await t.a.ask({ sessionId: t.id, question: '第一问' })
  await fin
  fin = t.done()
  await t.a.ask({ sessionId: t.id, question: '这句什么意思？', quote: { segId: 'g41', text: '假的', sel: 'Ising Hamiltonian' } })
  const u = await fin
  const msgs = t.calls[1].messages
  assert.equal(msgs.length, 3)
  assert.equal(msgs[0].content, '第一问')
  assert.match(msgs[1].content, /要点：H\(σ\)/)
  assert.ok(msgs[2].content.includes('And then we write it as the Ising Hamiltonian'))
  assert.ok(!msgs[2].content.includes('假的'))
  assert.deepEqual(u.quote, { segId: 'g41', at: START + 41 * 60_000, text: 'And then we write it as the Ising Hamiltonian, H of sigma, where sigma is the configuration of all the spins.', sel: 'Ising Hamiltonian' })
  assert.equal(t.store.load(t.id).asks.length, 2)
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk live: uses the running session (no start time, so it is the running session ticket), the engine segments, and records that it was asked during class', async () => {
  const t = setup({ ended: false })
  const calls = []
  const live = t.store.load(t.id)
  const segments = [...live.segments, { id: 'g50', startedAt: START + 3_000_000, text: 'And this is the newest line that is still being said', final: false }]
  const statuses = []
  const a = new ClassAsk({ store: t.store, llm: async (o) => (calls.push(o), answerText), aiStatus: (at) => (statuses.push(at), { ready: true }), source: (id) => (id === t.id ? { session: live, segments } : null) })
  const fin = new Promise((resolve) => a.on('update', (u) => u.status !== 'streaming' && resolve(u)))
  assert.equal((await a.ask({ sessionId: t.id, question: '刚才说了什么' })).ok, true)
  const u = await fin
  assert.equal(u.after, false)
  assert.equal(calls[0].sessionStartedAt, undefined)
  assert.deepEqual(statuses, [null])
  assert.match(calls[0].messages.at(-1).content, /still being said/)
  assert.match(calls[0].messages.at(-1).content, /还在继续/)
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk: when AI is not available it says why and does not call the model; one question at a time; empty and non-class are refused', async () => {
  const t = ask({ aiStatus: () => ({ ready: false, reason: '今天会后整理的 AI 额度用完了：明天再试，或者开始一场记录' }) })
  const r = await t.a.ask({ sessionId: t.id, question: '问一下' })
  assert.deepEqual(r, { ok: false, error: '今天会后整理的 AI 额度用完了：明天再试，或者开始一场记录', code: 'no-ai' })
  assert.equal(t.calls.length, 0)
  assert.deepEqual(await t.a.ask({ sessionId: t.id, question: '   ' }), { ok: false, error: '问题是空的' })
  fs.rmSync(t.root, { recursive: true, force: true })

  const b = ask({ llm: () => new Promise(() => {}) })
  assert.equal((await b.a.ask({ sessionId: b.id, question: '第一问' })).ok, true)
  const second = await b.a.ask({ sessionId: b.id, question: '第二问' })
  assert.equal(second.ok, false)
  assert.match(second.error, /还在回答/)
  fs.rmSync(b.root, { recursive: true, force: true })

  const m = setup()
  const meeting = m.store.create({ mode: 'meeting' })
  const c = new ClassAsk({ store: m.store, llm: async () => '', aiStatus: () => ({ ready: true }) })
  assert.equal((await c.ask({ sessionId: meeting.id, question: 'x' })).ok, false)
  fs.rmSync(m.root, { recursive: true, force: true })
})

test('ClassAsk stop: keeps what was already written, marks it stopped, and the next question can start', async () => {
  const t = ask({
    llm: (o) =>
      new Promise((_, reject) => {
        o.onDelta('覆盖：讲过\n要点：先出来这一句\n- 第一条')
        o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      }),
  })
  const fin = t.done()
  await t.a.ask({ sessionId: t.id, question: '问' })
  await new Promise((r) => setTimeout(r, 20))
  t.a.stop(t.id)
  const u = await fin
  assert.equal(u.status, 'stopped')
  assert.equal(u.gist, '先出来这一句')
  assert.equal(u.error, undefined)
  assert.equal(t.store.load(t.id).asks[0].status, 'stopped')
  const again = await t.a.ask({ sessionId: t.id, question: '再问' })
  assert.equal(again.ok, true)
  t.a.stop(t.id)
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk error: the reason is in Chinese; partial text is kept and saved, a retry replaces it; an error with nothing written saves nothing', async () => {
  const t = ask({
    llm: (_o, ) => {
      throw Object.assign(new Error('连不上 AI 服务'), { partial: '覆盖：讲过\n要点：写到一半' })
    },
  })
  let fin = t.done()
  await t.a.ask({ sessionId: t.id, question: '问' })
  let u = await fin
  assert.equal(u.status, 'error')
  assert.equal(u.error, '连不上 AI 服务')
  assert.equal(u.gist, '写到一半')
  const saved = t.store.load(t.id).asks
  assert.equal(saved.length, 1)
  // 重试：换掉出错的那条
  t.a.llm = async () => answerText
  fin = t.done()
  await t.a.ask({ sessionId: t.id, question: '问', replaceId: u.id })
  u = await fin
  assert.equal(u.status, 'done')
  const after = t.store.load(t.id).asks
  assert.equal(after.length, 1)
  assert.equal(after[0].status, 'done')

  const e = ask({ llm: () => Promise.reject(new Error('fetch failed')) })
  fin = e.done()
  await e.a.ask({ sessionId: e.id, question: '问' })
  u = await fin
  assert.match(u.error, /连不上 AI 服务/)
  assert.equal(e.store.load(e.id).asks, undefined)
  fs.rmSync(t.root, { recursive: true, force: true })
  fs.rmSync(e.root, { recursive: true, force: true })
})

test('ClassAsk: slides nearest the quoted line go along as images; a course page that matches goes along as text', async () => {
  const dir0 = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ask-img-'))
  const t = ask({ setup: { slides: [{ file: 'slides/a.jpg', at: START + 41 * 60_000 }, { file: 'slides/b.jpg', at: START + 5 * 60_000 }], materials: [{ id: 'm1', name: '课件.pdf', kind: 'pdf', pages: 2, addedAt: 1 }] } })
  fs.mkdirSync(path.join(t.dir, 'slides'), { recursive: true })
  fs.writeFileSync(path.join(t.dir, 'slides/a.jpg'), 'A')
  fs.writeFileSync(path.join(t.dir, 'slides/b.jpg'), 'B')
  fs.mkdirSync(path.join(t.dir, 'materials/m1'), { recursive: true })
  fs.writeFileSync(path.join(t.dir, 'materials/m1/text.json'), JSON.stringify(['Title', 'Ising Hamiltonian: H(sigma) = - sum J s_i s_j']))
  const fin = t.done()
  await t.a.ask({ sessionId: t.id, question: '这句什么意思？', quote: { segId: 'g41' } })
  await fin
  const content = t.calls[0].messages.at(-1).content
  assert.ok(Array.isArray(content))
  assert.equal(content.filter((x) => x.type === 'image').length, 2)
  assert.match(content[0].text, /课件p2（《课件.pdf》第 2 页）：Ising Hamiltonian/)
  fs.rmSync(t.root, { recursive: true, force: true })
  fs.rmSync(dir0, { recursive: true, force: true })
})

test('Summarizer.generate keeps the questions asked in class at the end of the class notes; refreshHtml rebuilds the picture notes without asking the AI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ask-sum-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const store = new SessionStore({ projects: ps })
  const s = store.create({ mode: 'class', classSource: 'mic', slides: [], asks: [{ id: 'a1', q: 'H(σ) 是什么？', askedAt: START + 13 * 60_000, gist: '能量分', points: [] }] })
  s.startedAt = START
  s.segments.push({ id: 'g1', speaker: '老师', who: 'other', startedAt: START + 5000, text: 'Hello everyone, today the Ising model.' })
  s.endedAt = START + 600_000
  store.saveNow(s)
  const calls = []
  const llm = async (o) => {
    calls.push(o)
    return o.json ? JSON.stringify({ title: '自旋', items: [] }) : '## 本节概览\n自旋模型。\n'
  }
  const sum = new Summarizer({ store, projects: ps, llm, aiStatus: () => ({ ready: true }) })
  const r = await sum.generate(s.id, '')
  assert.match(r.markdown, /## 课上问过的\n\n- 13:00 \*\*H\(σ\) 是什么？\*\* 能量分/)
  assert.ok(!calls.some((c) => JSON.stringify(c.messages).includes('课上问过的')), '作业提取和课件对照看不到这一段')
  const html = fs.readFileSync(path.join(store.dir(s.id), '课堂笔记.html'), 'utf8')
  assert.ok(html.includes('课上问过的') && html.includes('能量分'))
  // 又问了一个：笔记末尾换新，图文笔记照现成的重画，不问 AI
  const before = calls.length
  store.mutate(s.id, (x) => {
    x.asks.push({ id: 'a2', q: '为什么 H 最小？', askedAt: START + 50 * 60_000, gist: '违反约束最少', points: [] })
    x.summary.markdown = withAsked(x.summary.markdown, x.asks, x.startedAt)
  })
  assert.equal(sum.refreshHtml(s.id), true)
  const again = fs.readFileSync(path.join(store.dir(s.id), '课堂笔记.html'), 'utf8')
  assert.ok(again.includes('违反约束最少'))
  assert.equal(calls.length, before)
  fs.rmSync(root, { recursive: true, force: true })
})
