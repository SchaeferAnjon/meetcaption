import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassAsk } from '../src/main/class/ask.js'
import { askScope, transcriptForAsk } from '../src/main/class/askPrompt.js'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'

// 问 AI 答非所问（2026-11-25）：问「刚才讲了什么」「最近十分钟」「目前讲了什么」「18:00 讲了什么」时，交给 AI 的字幕要是问的那一段时间。
// 以前一律当关键词检索：中文问题拆成「讲了」「什么」「一下」这类双字去对字幕译文，课上任何一句含这些字的都被挑进来，
// 真正问的那段时间只剩固定的最近 4 分钟左右；课上又只拿得到引擎内存里最近 300 段，长课开头那几小时 AI 根本看不到。

const DAY = new Date(2026, 10, 25, 0, 0, 0).getTime()
const at = (h, m, s = 0) => DAY + ((h * 60 + m) * 60 + s) * 1000
const hhmm = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// 14:00 到 18:17 每 20 秒一句。整节课的译文里到处是「讲了」「什么」「一下」「刚才」「目前」（真实课上也是这样），
// 18:12 以后讲 Okinawa habu 的血清（最近一段），18:00 前后讲 polyvalent。
function longClass(until = at(18, 17)) {
  const segs = []
  let i = 0
  for (let t = at(14, 0); t < until; t += 20_000, i++) {
    let text = `So in part ${i} we looked at how the colonial institute organised its laboratories and archives, with many details about the reports.`
    let tr = `所以在第 ${i} 部分，我们讲了殖民研究所怎么组织实验室和档案，什么都讲了一下，刚才目前这些报告的细节。`
    if (t >= at(18, 12)) [text, tr] = [`The serum against the Okinawa habu venom was tested again in step ${i}, and it neutralised the venom.`, `第 ${i} 步又测了一次冲绳波布蛇毒的血清，它中和了蛇毒。`]
    else if (t >= at(17, 59) && t < at(18, 3)) [text, tr] = [`A polyvalent product covers more than one venom, line ${i}.`, `多价产品能对付不止一种蛇毒，第 ${i} 句。`]
    segs.push({ id: `s${i}`, startedAt: t, text, speaker: '老师', who: 'other', sentences: [{ text, tr }] })
  }
  return segs
}

const timesIn = (r) => [...r.ats.values()].sort((a, b) => a - b)

test('askScope: reads the time a question asks about (recent N minutes, just now, so far, a clock time, the start)', () => {
  const o = { now: at(18, 17), startedAt: at(14, 0), live: true }
  assert.deepEqual(pick(askScope('刚才讲了什么', o)), { kind: 'recent', from: at(18, 12), to: at(18, 17) })
  assert.deepEqual(pick(askScope('最近十分钟讲啥了', o)), { kind: 'recent', from: at(18, 7), to: at(18, 17) })
  assert.deepEqual(pick(askScope('过去 20 分钟老师说了什么', o)), { kind: 'recent', from: at(17, 57), to: at(18, 17) })
  assert.deepEqual(pick(askScope('最近半小时讲了什么', o)), { kind: 'recent', from: at(17, 47), to: at(18, 17) })
  assert.deepEqual(pick(askScope('总结一下目前讲了什么?', o)), { kind: 'all', from: at(14, 0), to: at(18, 17) })
  assert.deepEqual(pick(askScope('到现在讲了哪些要点？', o)), { kind: 'all', from: at(14, 0), to: at(18, 17) })
  assert.deepEqual(pick(askScope('18:00 讲了什么', o)), { kind: 'at', from: at(17, 59), to: at(18, 4) })
  assert.deepEqual(pick(askScope('下午6点讲了什么', o)), { kind: 'at', from: at(17, 59), to: at(18, 4) })
  assert.deepEqual(pick(askScope('十分钟前老师在讲什么', o)), { kind: 'at', from: at(18, 5), to: at(18, 10) })
  assert.deepEqual(pick(askScope('开头讲了什么', o)), { kind: 'start', from: at(14, 0), to: at(14, 10) })
  assert.deepEqual(pick(askScope('what did he say in the last 15 minutes', o)), { kind: 'recent', from: at(18, 2), to: at(18, 17) })
  // 没问时间的不算；「三点」（三个要点）不是钟点
  assert.equal(askScope('Ising 哈密顿量是什么', o), null)
  assert.equal(askScope('老师说的三点是什么', o), null)
  assert.equal(askScope('1921 年的报告说了什么', o), null)
  // 下课以后：「第 30 分钟」是开课后 30 分钟，「刚才」没有意义（按下课前那段算）
  const after = { now: at(20, 0), startedAt: at(14, 0), endedAt: at(18, 30), live: false }
  assert.deepEqual(pick(askScope('第 30 分钟讲了什么', after)), { kind: 'at', from: at(14, 29), to: at(14, 34) })
  assert.deepEqual(pick(askScope('最后十分钟讲了什么', after)), { kind: 'recent', from: at(18, 20), to: at(18, 30) })
})

function pick(s) {
  return s && { kind: s.kind, from: s.from, to: s.to }
}

test('transcriptForAsk: "just now" gets the whole latest stretch, not lines picked for the words 讲了 / 什么', () => {
  const segs = longClass()
  const scope = askScope('刚才讲了什么', { now: at(18, 17), startedAt: at(14, 0), live: true })
  const r = transcriptForAsk(segs, { query: '刚才讲了什么', scope, clockTime: hhmm })
  const ts = timesIn(r)
  assert.ok(ts[0] >= at(18, 12) - 60_000, `最早一句 ${hhmm(ts[0])}，应在 18:11 以后`)
  assert.ok(ts.at(-1) >= at(18, 16, 30), '最新一句在里面')
  // 18:12 到 18:17 一句不落
  const want = segs.filter((s) => s.startedAt >= at(18, 12)).map((s) => s.id)
  for (const id of want) assert.ok([...r.refs.values()].includes(id), `${id} 在里面`)
  assert.deepEqual(r.range && [hhmm(r.range.from), hhmm(r.range.to)], ['18:12', '18:16'])
})

test('transcriptForAsk: "so far" spreads over the whole class, from the first hour to the latest lines', () => {
  const segs = longClass()
  const scope = askScope('总结一下目前讲了什么?', { now: at(18, 17), startedAt: at(14, 0), live: true })
  const r = transcriptForAsk(segs, { query: '总结一下目前讲了什么?', scope, clockTime: hhmm })
  const ts = timesIn(r)
  assert.ok(ts[0] < at(14, 10), `最早一句 ${hhmm(ts[0])}，应在开头十分钟里`)
  assert.ok(ts.at(-1) >= at(18, 16), '最新一句在里面')
  // 每个小时都有
  for (const h of [14, 15, 16, 17, 18]) assert.ok(ts.some((t) => t >= at(h, 0) && t < at(h + 1, 0)), `${h} 点那一小时有字幕`)
})

test('transcriptForAsk: "the last ten minutes" covers 18:07 to 18:17; a clock time gets the lines around it', () => {
  const segs = longClass()
  const o = { now: at(18, 17), startedAt: at(14, 0), live: true }
  const r = transcriptForAsk(segs, { query: '最近十分钟讲啥了', scope: askScope('最近十分钟讲啥了', o), clockTime: hhmm })
  const ts = timesIn(r)
  assert.ok(ts[0] <= at(18, 7, 30) && ts[0] >= at(18, 6), `最早一句 ${hhmm(ts[0])}`)
  assert.ok(ts.at(-1) >= at(18, 16, 30))
  const c = transcriptForAsk(segs, { query: '18:00 讲了什么', scope: askScope('18:00 讲了什么', o), clockTime: hhmm })
  assert.ok([...c.refs.values()].length > 5)
  assert.match(c.text, /polyvalent/)
  assert.ok(timesIn(c).every((t) => t >= at(17, 58) && t <= at(18, 5)), '只有 18:00 前后那几分钟')
})

/* ---------------- 课上真问：假字幕流 14:00 到 18:17，引擎内存里只剩最近 300 段 ---------------- */

const answerFor = (q) => ['覆盖：讲过', `要点：这是「${q}」的回答`, '- 第一条', '依据：#1', '接着问：然后呢？'].join('\n')

function liveSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ask-scope-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const store = new SessionStore({ projects: ps })
  const s = store.create({ mode: 'class', classSource: 'mic' })
  s.startedAt = at(14, 0)
  const all = longClass()
  s.segments.push(...all)
  store.saveNow(s)
  // 引擎：session.segments 是整场存下来的，snapshot().segments 是内存里最近 300 段（LIVE_KEEP）
  const live = { session: s, segments: all.slice(-300) }
  const calls = []
  const a = new ClassAsk({
    store,
    llm: async (o) => {
      calls.push(o)
      const q = o.messages.at(-1).content.match(/我的问题：(.*)/)[1]
      o.onDelta?.(answerFor(q).slice(0, 20))
      return answerFor(q)
    },
    aiStatus: () => ({ ready: true }),
    source: (id) => (id === s.id ? live : null),
    now: () => at(18, 17),
  })
  return { root, store, id: s.id, a, calls }
}

async function askOnce(a, sessionId, question) {
  const seen = []
  const f = (u) => seen.push(u)
  a.on('update', f)
  const fin = new Promise((resolve) => {
    const g = (u) => u.status !== 'streaming' && (a.off('update', g), resolve(u))
    a.on('update', g)
  })
  const r = await a.ask({ sessionId, question })
  const u = await fin
  a.off('update', f)
  return { r, u, seen }
}

test('ClassAsk live at 18:17: "刚才讲了什么" sends the latest stretch, the answer shown is for this question; "目前讲了什么" sees the first hour too', async () => {
  const t = liveSetup()
  // 先问过一次（14:34 那种），再问新的：回答区收到的是新这一问的 id 和回答
  await askOnce(t.a, t.id, '总结一下目前讲了什么?')
  const { r, u, seen } = await askOnce(t.a, t.id, '刚才讲了什么')
  assert.equal(r.ok, true)
  assert.ok(seen.every((x) => x.id === r.id), '这一问的更新都带这一问的 id')
  assert.equal(u.id, r.id)
  assert.equal(u.q, '刚才讲了什么')
  assert.equal(u.status, 'done')
  assert.equal(u.gist, '这是「刚才讲了什么」的回答')
  const content = t.calls[1].messages.at(-1).content
  assert.match(content, /现在是 18:17/)
  const lines = content.split('\n').filter((l) => /^#\d+ \[/.test(l))
  const times = lines.map((l) => l.match(/\[(\d\d:\d\d)\]/)[1])
  assert.ok(times[0] >= '18:11', `交给 AI 的第一句 ${times[0]}`)
  assert.equal(times.at(-1), '18:16')
  assert.ok(lines.every((l) => /Okinawa habu|part \d+/.test(l)))
  assert.ok(lines.filter((l) => /Okinawa habu/.test(l)).length >= 14, '18:12 以后那段都在')
  assert.deepEqual([hhmm(u.prompted.range.from), hhmm(u.prompted.range.to)], ['18:12', '18:16'])
  // 整场：第一问交给 AI 的字幕从 14 点开始（不只是引擎内存里最近的 300 段）
  const first = t.calls[0].messages.at(-1).content.split('\n').filter((l) => /^#\d+ \[/.test(l))
  assert.ok(first[0].includes('[14:0'), `整场的第一句 ${first[0].slice(0, 20)}`)
  const s = t.store.load(t.id)
  assert.deepEqual(s.asks.map((x) => x.q), ['总结一下目前讲了什么?', '刚才讲了什么'])
  fs.rmSync(t.root, { recursive: true, force: true })
})

/* ---------------- 回答途中意外出错：任务要清掉，下一问照常 ---------------- */

test('ClassAsk: an unexpected error mid-answer clears the job and marks the answer as an error in words; the next question goes through', async () => {
  const t = liveSetup()
  // 能联网：第一问模型要搜；发「正在联网查」给界面时界面那头抛错（窗口已经没了这一类）
  let n = 0
  const a = new ClassAsk({
    store: t.store,
    llm: async (o) => {
      n++
      if (n === 1) {
        o.onDelta?.('搜索：冲绳 波布 血清\n')
        return '搜索：冲绳 波布 血清\n'
      }
      return answerFor('第二问')
    },
    aiStatus: () => ({ ready: true }),
    search: async () => [],
    searchable: () => true,
    source: (id) => (id === t.id ? { session: t.store.load(t.id), segments: [] } : null),
    now: () => at(18, 17),
  })
  a.on('update', (u) => {
    if (u.web?.status === 'searching') throw new Error('Object has been destroyed')
  })
  const errored = new Promise((resolve) => a.on('update', (u) => u.status === 'error' && resolve(u)))
  const r1 = await a.ask({ sessionId: t.id, question: 'habu 是什么蛇' })
  assert.equal(r1.ok, true)
  const e = await errored
  assert.equal(e.id, r1.id)
  assert.match(e.error, /回答失败：Object has been destroyed/)
  // 任务清掉了：再问不会回「上一个问题还在回答」
  const fin = new Promise((resolve) => a.on('update', (u) => u.id !== r1.id && u.status === 'done' && resolve(u)))
  const r2 = await a.ask({ sessionId: t.id, question: '刚才讲了什么' })
  assert.equal(r2.ok, true, r2.error)
  assert.equal((await fin).gist, '这是「第二问」的回答')
  fs.rmSync(t.root, { recursive: true, force: true })
})
