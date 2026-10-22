import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { aggregateTodos, carryOver, dateClash, dueFromSummary, normalizeDate, openTodoCounts, parseAt, parseTodoItems, patchTodo, resolveRelativeDate, summaryDeadlines, todoMessages } from '../src/main/todos.js'
import { summaryMessages } from '../src/main/prompts.js'
import { INBOX_ID, ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { Summarizer } from '../src/main/summary.js'

// 待办：提取结果的解析容错、相对日期兜底、跨项目聚合、重新提取时保留勾选、纪要 + 提取的完整流程（假模型）。

const THU = new Date(2026, 8, 24, 10, 0).getTime() // 2026-09-24 周四
const projects = [
  { id: 'p_paper', name: '论文：Danish 合作', description: '和 Danish 教授合写 noisy labels 论文' },
  { id: 'p_job', name: '面试：X 公司', description: '准备 X 公司的面试' },
  { id: INBOX_ID, name: '未归类' },
]

test('相对日期兜底：英文和中文的常见说法按会议日期换算', () => {
  const cases = {
    'next Friday': '2026-10-02',
    'by this Friday': '2026-09-25',
    'on Friday': '2026-09-25',
    'Monday': '2026-09-28',
    tomorrow: '2026-09-25',
    'the day after tomorrow': '2026-09-26',
    'in two weeks': '2026-10-08',
    'in 3 days': '2026-09-27',
    '下周二': '2026-09-29',
    '下个星期五': '2026-10-02',
    '这周五': '2026-09-25',
    '周日之前': '2026-09-27',
    '下下周一': '2026-10-05',
    '3天后': '2026-09-27',
    '两周内': '2026-10-08',
    '明天上午': '2026-09-25',
    '10月3日': '2026-10-03',
    'October 3rd': '2026-10-03',
    '3 Oct': '2026-10-03',
    '1月5号': '2027-01-05',
  }
  for (const [text, want] of Object.entries(cases)) assert.equal(resolveRelativeDate(text, THU), want, text)
  assert.equal(resolveRelativeDate('next week', THU), null)
  assert.equal(resolveRelativeDate('soon', THU), null)
  assert.equal(resolveRelativeDate('', THU), null)
})

test('normalizeDate 和 parseAt', () => {
  assert.equal(normalizeDate('2026-10-02'), '2026-10-02')
  assert.equal(normalizeDate('2026/10/2'), '2026-10-02')
  assert.equal(normalizeDate('2026-10-02T17:00:00Z'), '2026-10-02')
  assert.equal(normalizeDate('2026年10月2日'), '2026-10-02')
  assert.equal(normalizeDate('2026-02-30'), null)
  assert.equal(normalizeDate('next Friday'), null)
  assert.equal(normalizeDate(null), null)
  assert.equal(parseAt('01:23'), 83_000)
  assert.equal(parseAt('[1:02:03]'), 3_723_000)
  assert.equal(parseAt(90), 90_000)
  assert.equal(parseAt('无'), null)
})

test('parseTodoItems：正常 JSON，项目、日期、负责人、时间戳都对上', () => {
  const raw = JSON.stringify({
    title: '论文修改和面试准备',
    items: [
      { text: '把修改后的 WebVision 表格发给教授', due: '2026-10-02', dueText: 'by next Friday', owner: 'me', projectId: 'p_paper', quote: 'send me the revised table by next Friday', at: '00:42' },
      { text: '准备 X 公司的系统设计面试', due: null, dueText: 'next Tuesday', owner: 'me', projectId: 'p_job', quote: 'your interview with X next Tuesday', at: '01:10' },
      { text: '教授看一遍 related work', due: null, dueText: null, owner: 'other', projectId: 'p_paper', quote: null, at: null },
    ],
  })
  const r = parseTodoItems(raw, { projects, fallbackProjectId: 'p_paper', startedAt: THU })
  assert.equal(r.title, '论文修改和面试准备')
  assert.equal(r.items.length, 3)
  const [a, b, c] = r.items
  assert.match(a.id, /^t_[0-9a-f]{10}$/)
  assert.equal(a.projectId, 'p_paper')
  assert.equal(a.due, '2026-10-02')
  assert.equal(a.owner, 'me')
  assert.equal(a.at, 42_000)
  assert.equal(a.done, false)
  assert.equal(b.projectId, 'p_job')
  assert.equal(b.due, '2026-09-29', '模型没给日期，用 dueText 兜底换算')
  assert.equal(c.owner, 'other')
  assert.equal(c.due, null)
  assert.equal(c.quote, null)
})

test('parseTodoItems：代码块包裹、直接给数组、项目写成名字或不存在的 id、字段换说法、重复、破折号', () => {
  const fenced = '好的，结果如下：\n```json\n{"items":[{"task":"修改 Section 4 \u2014 补充实验","project":"论文：Danish 合作","deadline":"2026/10/2","who":"我"},{"text":"修改 Section 4 \u2014 补充实验"},{"text":"订机票","projectId":"p_gone"},{"text":"联系 HR","projectId":"id=p_job","owner":"对方"}]}\n```'
  const r = parseTodoItems(fenced, { projects, fallbackProjectId: 'p_paper', startedAt: THU })
  assert.deepEqual(
    r.items.map((x) => [x.text, x.projectId, x.due, x.owner]),
    [
      ['修改 Section 4，补充实验', 'p_paper', '2026-10-02', 'me'],
      ['订机票', 'p_paper', null, null],
      ['联系 HR', 'p_job', null, 'other'],
    ],
  )
  const arr = parseTodoItems('[{"text":"写摘要"}, "发邮件给导师"]', { projects, fallbackProjectId: INBOX_ID, startedAt: THU })
  assert.deepEqual(
    arr.items.map((x) => [x.text, x.projectId]),
    [
      ['写摘要', INBOX_ID],
      ['发邮件给导师', INBOX_ID],
    ],
  )
  const bad = parseTodoItems('抱歉，我没法完成', { projects, startedAt: THU })
  assert.equal(bad.items.length, 0)
  assert.ok(bad.error)
  assert.deepEqual(parseTodoItems('{"items":[]}', { projects }).items, [])
  assert.deepEqual(parseTodoItems('{"items":"none"}', { projects }).items, [])
})

test('carryOver：重新提取后，勾掉的和手动改过项目的按文字对上保留', () => {
  const old = [
    { id: 't_old1', text: '把表格发给教授', done: true, doneAt: 123, projectId: 'p_paper' },
    { id: 't_old2', text: '准备面试', done: false, projectId: 'p_paper', edited: { projectId: true } },
  ]
  const fresh = [
    { id: 't_new1', text: '把表格发给教授。', done: false, projectId: 'p_paper' },
    { id: 't_new2', text: '准备面试', done: false, projectId: 'p_job' },
    { id: 't_new3', text: '新的一条', done: false, projectId: 'p_paper' },
  ]
  const out = carryOver(old, fresh)
  assert.equal(out[0].id, 't_old1')
  assert.equal(out[0].done, true)
  assert.equal(out[0].doneAt, 123)
  assert.equal(out[1].projectId, 'p_paper', '用户手动改过项目，保留用户的')
  assert.equal(out[2].id, 't_new3')
})

test('patchTodo：勾选记时间、取消清掉；改项目要是存在的项目；不认识的字段不收', () => {
  const item = { id: 't1', text: 'a', due: null, projectId: 'p_paper', done: false }
  const done = patchTodo(item, { done: true, bogus: 1 }, { projects })
  assert.equal(done.done, true)
  assert.ok(done.doneAt > 0)
  assert.equal(done.bogus, undefined)
  assert.equal(item.done, false, '不改原对象')
  const undone = patchTodo(done, { done: false }, { projects })
  assert.equal(undone.doneAt, undefined)
  const moved = patchTodo(item, { projectId: 'p_job', due: '2026/10/9', text: '  新文字 ' }, { projects })
  assert.equal(moved.projectId, 'p_job')
  assert.equal(moved.due, '2026-10-09')
  assert.equal(moved.text, '新文字')
  assert.deepEqual(moved.edited, { projectId: true, due: true, text: true })
  assert.throws(() => patchTodo(item, { projectId: 'p_gone' }, { projects }), /找不到/)
  assert.equal(patchTodo(item, { due: '' }, { projects }).due, null)
})

test('aggregateTodos：跨项目聚合，按项目筛选，默认不含已完成，已删除项目的算到未归类，按截止日期排', () => {
  const records = [
    {
      id: 's1',
      title: '周会',
      projectId: 'p_paper',
      startedAt: THU,
      items: [
        { id: 'a', text: '改表格', due: '2026-10-02', projectId: 'p_paper', done: false },
        { id: 'b', text: '准备面试', due: '2026-09-29', projectId: 'p_job', done: false },
        { id: 'c', text: '已完成的', due: null, projectId: 'p_paper', done: true },
        { id: 'd', text: '被删项目的', due: null, projectId: 'p_deleted', done: false },
      ],
    },
    { id: 's2', title: '', projectId: 'p_job', startedAt: THU + 86400000, items: [{ id: 'e', text: '发简历', due: null, projectId: 'p_job', done: false }] },
  ]
  const known = new Set(projects.map((p) => p.id))
  const all = aggregateTodos(records, { knownProjects: known })
  assert.deepEqual(
    all.map((t) => t.id),
    ['b', 'a', 'e', 'd'],
  )
  assert.equal(all[0].sessionId, 's1')
  assert.equal(all[0].sessionTitle, '周会')
  assert.equal(all[0].sessionStartedAt, THU)
  assert.equal(all[0].sessionProjectId, 'p_paper')
  assert.equal(all.find((t) => t.id === 'd').projectId, INBOX_ID)
  assert.deepEqual(
    aggregateTodos(records, { projectId: 'p_job', knownProjects: known }).map((t) => t.id),
    ['b', 'e'],
  )
  assert.equal(aggregateTodos(records, { projectId: 'p_paper', includeDone: true, knownProjects: known }).length, 2)
  const counts = openTodoCounts(records, known)
  assert.equal(counts.get('p_job'), 2)
  assert.equal(counts.get('p_paper'), 1)
  assert.equal(counts.get(INBOX_ID), 1)
})

test('prompt：纪要和提取都带项目清单、会议日期和日历', () => {
  const session = { startedAt: THU, projectId: 'p_paper', segments: [{ speaker: '对方', startedAt: THU + 42_000, text: 'Send me the table by next Friday.' }] }
  const [sys, user] = todoMessages({ session, summary: '## 纪要', project: projects[0], projects })
  assert.match(sys.content, /id=p_paper；名称：论文：Danish 合作/)
  assert.match(sys.content, /id=p_job；名称：面试：X 公司/)
  assert.match(sys.content, /2026-09-24（周四）/)
  assert.match(sys.content, /下周：2026-09-28 周一/)
  assert.match(user.content, /\[00:42\] 对方：Send me the table/)
  assert.match(user.content, /## 纪要/)
  const [, sumUser] = summaryMessages({ session, project: { ...projects[0], context: 'Paper meeting with a Danish professor' }, projects })
  assert.match(sumUser.content, /这场会议所属的项目：论文：Danish 合作/)
  assert.match(sumUser.content, /项目背景：Paper meeting/)
  assert.match(sumUser.content, /- 面试：X 公司：准备 X 公司的面试/)
  assert.doesNotMatch(sumUser.content, /未归类/)
  for (const m of [sys, user]) assert.doesNotMatch(m.content, /[\u2013\u2014]/)
})

test('Summarizer：生成纪要、提取待办存进 session.summary.items，会议没标题就用提取出的标题', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetcaption-sum-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const paper = ps.create({ name: '论文：Danish 合作', context: 'paper' })
  const job = ps.create({ name: '面试：X 公司' })
  const store = new SessionStore({ projects: ps })
  const s = store.create({ projectId: paper.id })
  s.segments.push({ id: '1', speaker: '对方', startedAt: s.startedAt + 42_000, text: 'Send me the table by next Friday. Good luck with the X interview next Tuesday.' })
  s.endedAt = Date.now()
  store.saveNow(s)
  const calls = []
  const llm = async (o) => {
    calls.push(o)
    if (!o.json) {
      o.onDelta?.('## 一句话总结\n')
      return '## 一句话总结\n改表格，准备面试。'
    }
    return JSON.stringify({
      title: '表格修改和面试',
      items: [
        { text: '把表格发给教授', due: null, dueText: 'by next Friday', owner: 'me', projectId: paper.id, at: '00:42' },
        { text: '准备 X 公司面试', due: null, dueText: 'next Tuesday', owner: 'me', projectId: job.id, at: '00:42' },
      ],
    })
  }
  const sum = new Summarizer({ store, projects: ps, llm, aiStatus: () => ({ ready: true }) })
  const events = []
  sum.on('progress', (p) => events.push(p.phase))
  const r = await sum.generate(s.id)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].model, 'smart')
  assert.match(calls[0].messages[0].content, /面试：X 公司/)
  assert.equal(calls[1].json, true)
  assert.equal(r.items.length, 2)
  assert.ok(events.includes('summary') && events.includes('items'))
  const saved = store.load(s.id)
  assert.equal(saved.title, '表格修改和面试')
  assert.equal(saved.summary.markdown, '## 一句话总结\n改表格，准备面试。')
  const mt = new Date(saved.startedAt)
  const byProject = Object.fromEntries(saved.summary.items.map((x) => [x.projectId, x]))
  assert.equal(byProject[paper.id].due, resolveRelativeDate('next Friday', mt.getTime()))
  assert.equal(byProject[job.id].due, resolveRelativeDate('next Tuesday', mt.getTime()))
  assert.ok(fs.readFileSync(path.join(store.dir(s.id), '会议纪要.md'), 'utf8').includes('改表格'))

  // 勾掉一条再重新生成：勾选保留；提取失败时纪要照存、旧待办不丢
  const first = saved.summary.items[0]
  store.mutate(s.id, (x) => void (x.summary.items[0].done = true))
  const r2 = await sum.generate(s.id)
  assert.equal(r2.items.find((x) => x.id === first.id).done, true)
  const broken = new Summarizer({ store, projects: ps, llm: async (o) => (o.json ? 'not json' : '新纪要'), aiStatus: () => ({ ready: true }) })
  const r3 = await broken.generate(s.id)
  assert.match(r3.itemsError, /待办提取失败/)
  assert.equal(store.load(s.id).summary.markdown, '新纪要')
  assert.equal(store.load(s.id).summary.items.length, 2)

  const off = new Summarizer({ store, projects: ps, llm, aiStatus: () => ({ ready: false, reason: '还没用 ChatGPT 账号登录' }) })
  await assert.rejects(() => off.generate(s.id), /还没用 ChatGPT 账号登录/)
})

/* ---------------- 纪要里写明的截止日期（Windows 第二轮：Bonferroni 那条纪要写了 2026-09-28，待办里是空的） ---------------- */

// 真实会议纪要的节选（2026-09-24 周四开的会）
const SUMMARY_MD = `## 我要做的事
- [ ] 分析并说明第二数据集上移除 denoising module 后性能下降 7 个点的原因。（截止：无明确截止）  原话："Could you walk me through why the ablation drops so much there?" [01:50]
- [ ] 对 WebVision subset 的 p-values 应用 Bonferroni correction。（截止：2026-09-28）  原话："We should apply the Bonferroni correction to the p-values on the WebVision subset." [06:30]
- [ ] 使用 scikit-learn 重新运行 ablation。（截止：2026-09-28）  原话："Then please rerun the ablation with scikit-learn and send me the ROC curve by Monday." [06:30]
- [ ] 向对方发送 ROC curve。（截止：2026-09-28）  原话："Then please rerun the ablation with scikit-learn and send me the ROC curve by Monday." [06:30]
- [ ] 将论文第二部分的 related work 压缩至约一页。（截止：修订稿截止日前，具体日期待确认）  原话："I think the related work is too long. You should cut it down to maybe one page." [08:57]
- [ ] 向对方发送 revised draft。（截止：日期存在冲突，待确认）  原话："please send me the revised draft by next Friday, the third of October." [08:57]

## DDL 与时间节点
| 时间 | 事项 | 原话 |
|---|---|---|
| 2026-09-28（周一，Monday） | 完成 scikit-learn ablation 重跑，并发送 ROC curve | "Then please rerun the ablation with scikit-learn and send me the ROC curve by Monday." [06:30] |
| 2026-10-02（周五，next Friday）或 2026-10-03（周六，the third of October），日期冲突，待确认 | 发送 revised draft | "please send me the revised draft by next Friday, the third of October." [08:57] |
| 2026-09-29（周二，Tuesday，推测） | 讨论 experiments | "Then we can discuss the experiments on Tuesday." [08:57] |
| 2026年10月9日 | 提交 camera-ready 版本 | "camera ready is due October ninth" [09:30] |`

test('summaryDeadlines：只写了一个日期、也没说待确认的算写明；冲突、待确认、推测的列成拿不准，日期取最早的', () => {
  const list = summaryDeadlines(SUMMARY_MD)
  assert.deepEqual(
    list.map((x) => [x.due, x.uncertain, x.text]),
    [
      ['2026-09-28', false, '对 WebVision subset 的 p-values 应用 Bonferroni correction。'],
      ['2026-09-28', false, '使用 scikit-learn 重新运行 ablation。'],
      ['2026-09-28', false, '向对方发送 ROC curve。'],
      [null, true, '将论文第二部分的 related work 压缩至约一页。'], // 「修订稿截止日前，具体日期待确认」
      [null, true, '向对方发送 revised draft。'], // 「日期存在冲突，待确认」
      ['2026-09-28', false, '完成 scikit-learn ablation 重跑，并发送 ROC curve'],
      ['2026-10-02', true, '发送 revised draft'], // 「2026-10-02 或 2026-10-03，日期冲突，待确认」
      ['2026-09-29', true, '讨论 experiments'], // 「推测」
      ['2026-10-09', false, '提交 camera-ready 版本'],
    ],
  )
  assert.equal(list[0].quote, 'We should apply the Bonferroni correction to the p-values on the WebVision subset.')
  assert.deepEqual(summaryDeadlines(''), [])
  // 课堂笔记的作业行、全角半角括号、带星期；「无明确截止」不算
  assert.deepEqual(summaryDeadlines('## 作业与截止\n- [ ] 完成 problem set 3 (截止: 2026-10-01 周四)  原话："due next Thursday at midnight" [01:10]\n- [ ] 读第三章（截止：无明确截止）'), [
    { text: '完成 problem set 3', due: '2026-10-01', uncertain: false, quote: 'due next Thursday at midnight' },
  ])
  // 截止里还套着括号（第二轮复核时纪要的写法）
  assert.deepEqual(summaryDeadlines('- [ ] 提交修订后的论文 draft（截止：2026-10-03（待确认））  原话："send me the revised draft by next Friday, the third of October" [08:57]'), [
    { text: '提交修订后的论文 draft', due: '2026-10-03', uncertain: true, quote: 'send me the revised draft by next Friday, the third of October' },
  ])
})

test('dueFromSummary：文字很像或原话对得上才填；像的几条日期打架就不填', () => {
  const list = summaryDeadlines(SUMMARY_MD)
  // 模型改了空格和标点，还是同一件事
  assert.equal(dueFromSummary({ text: '对WebVision subset的p-values应用Bonferroni correction', quote: null }, list), '2026-09-28')
  // 文字换了说法，原话对得上
  assert.equal(dueFromSummary({ text: '给 WebVision 子集的 p 值做 Bonferroni 校正', quote: 'We should apply the Bonferroni correction to the p-values on the WebVision subset.' }, list), '2026-09-28')
  // 只是句式像（向对方发送…），说的是另一件事：不能拿 ROC curve 的日期
  assert.equal(dueFromSummary({ text: '向对方发送修订后的draft', quote: 'please send me the revised draft by next Friday, the third of October.' }, list), null)
  assert.equal(dueFromSummary({ text: '将论文第二部分的related work压缩至约一页', quote: null }, list), null)
  const clash = [
    { text: '发送 ROC curve 给对方', due: '2026-09-28', quote: '' },
    { text: '发送 ROC curve 给导师', due: '2026-10-05', quote: '' },
  ]
  assert.equal(dueFromSummary({ text: '发送 ROC curve 给对方和导师', quote: null }, clash), null)
})

test('parseTodoItems：模型没给日期、纪要里写明了的用纪要的日期；模型给了的不动；拿不准的留空', () => {
  const raw = JSON.stringify({
    items: [
      { text: '对WebVision subset的p-values应用Bonferroni correction', due: null, dueText: null, owner: 'me', quote: 'We should apply the Bonferroni correction to the p-values on the WebVision subset.' },
      { text: '使用scikit-learn重新运行ablation', due: null, dueText: 'by Monday', owner: 'me' },
      { text: '将论文第二部分的related work压缩至约一页', due: null, dueText: null, owner: 'me' },
      { text: '向对方发送修订后的draft', due: '2026-10-02', dueText: 'by next Friday, the third of October', owner: 'me' },
      { text: '讨论experiments', due: null, dueText: null, owner: null, quote: 'Then we can discuss the experiments on Tuesday.' },
    ],
  })
  const { items } = parseTodoItems(raw, { projects, fallbackProjectId: 'p_paper', startedAt: THU, summary: SUMMARY_MD })
  assert.deepEqual(
    items.map((x) => [x.due, x.dueText]),
    [
      ['2026-09-28', null], // 纪要写了 2026-09-28，原话里没有时间说法，dueText 还是空
      ['2026-09-28', 'by Monday'],
      [null, null],
      ['2026-10-02', 'by next Friday, the third of October'],
      ['2026-09-29', null], // 纪要里是「推测」：用纪要的日期，标待确认
    ],
  )
  // 纪要标了待确认的、原话里星期几和日期对不上的，都带 dueUncertain
  assert.deepEqual(
    items.map((x) => Boolean(x.dueUncertain)),
    [false, false, true, true, true],
  )
  // 不给纪要时照旧
  assert.equal(parseTodoItems(raw, { projects, startedAt: THU }).items[0].due, null)
})

/* ---------------- 日期冲突（第二轮复核：纪要写「2026-10-03（待确认）」，待办却是确定的 2026-10-02 或者空） ---------------- */

const FRI = new Date(2026, 8, 25, 10, 0).getTime() // 2026-09-25 周五：next Friday 是 10-02，the third of October 是周六

test('dateClash：同一个说法里星期几和带月份的日期对不上才算冲突，给两个候选、早的在前', () => {
  assert.deepEqual(dateClash('by next Friday. The third of October', FRI), ['2026-10-02', '2026-10-03'])
  assert.deepEqual(dateClash('by next Friday, the 3rd of October', FRI), ['2026-10-02', '2026-10-03'])
  assert.deepEqual(dateClash('下周五（10月3日）之前', FRI), ['2026-10-02', '2026-10-03'])
  assert.equal(dateClash('next Friday, October 9th', FRI), null) // 10 月 9 日正好是周五：以具体日期为准
  assert.equal(dateClash('by next Friday', FRI), null)
  assert.equal(dateClash('the third of October', FRI), null)
  assert.equal(dateClash('The first may not work, try again on Friday', FRI), null) // 「first may」不是日期
  assert.equal(dateClash(null, FRI), null)
  // 英文单词写的日子也认
  assert.equal(resolveRelativeDate('the twenty-first of October', FRI), '2026-10-21')
  assert.equal(resolveRelativeDate('by October third', FRI), '2026-10-03')
  assert.equal(resolveRelativeDate('may the fourth be with you', FRI), null)
})

// 复核时 openai 那场的纪要：两条都写「截止：2026-10-03（待确认）」
const CLASH_MD = `## 我要做的事
- [ ] 将论文第二部分的 related work 压缩至约一页（截止：2026-10-03（待确认））  原话："I think the related work is too long. You should cut it down to maybe one page." [00:40]
- [ ] 提交修订后的论文 draft（截止：2026-10-03（待确认））  原话："send me the revised draft by next Friday, the third of October." [00:45]`

test('parseTodoItems：纪要标了待确认的，待办用纪要的日期并标 dueUncertain；两个引擎的提取结果最后一样', () => {
  // openai 那场：related work 没日期，draft 模型给了 10-02
  const a = parseTodoItems(
    JSON.stringify({
      items: [
        { text: '将论文第二部分的related work压缩至约一页', due: null, dueText: null, owner: 'me', quote: 'I think the related work is too long. You should cut it down to maybe one page.' },
        { text: '发送修订后的论文draft', due: '2026-10-02', dueText: 'by next Friday. The third of October', owner: 'me', quote: 'send me the revised draft by next Friday, the third of October.' },
      ],
    }),
    { projects, fallbackProjectId: 'p_paper', startedAt: FRI, summary: CLASH_MD },
  )
  // volc 那场：模型两条都给了 10-02
  const b = parseTodoItems(
    JSON.stringify({
      items: [
        { text: '把论文第二部分的 related work 压缩到大约一页', due: '2026-10-02', dueText: 'by next Friday', owner: 'me' },
        { text: '提交修订后的论文 draft', due: '2026-10-02', dueText: 'by next Friday, the third of October', owner: 'me' },
      ],
    }),
    { projects, fallbackProjectId: 'p_paper', startedAt: FRI, summary: CLASH_MD },
  )
  for (const r of [a, b]) assert.deepEqual(r.items.map((x) => [x.due, x.dueUncertain]), [['2026-10-03', true], ['2026-10-03', true]])
})

test('parseTodoItems：没有纪要时，原话里星期几和日期对不上也标待确认，取早的那天；对得上的照旧', () => {
  const { items } = parseTodoItems(
    JSON.stringify({
      items: [
        { text: '发送修订后的论文draft', due: '2026-10-03', dueText: 'by next Friday, the third of October', owner: 'me' },
        { text: '交 camera-ready', due: null, dueText: 'next Friday, October 9th', owner: 'me' },
        { text: '把表格发给教授', due: null, dueText: null, owner: 'me', quote: 'Send me the table by Friday, the 3rd of October.' },
        { text: '重跑实验', due: '2026-09-28', dueText: 'by Monday', owner: 'me' },
      ],
    }),
    { projects, fallbackProjectId: 'p_paper', startedAt: FRI },
  )
  assert.deepEqual(
    items.map((x) => [x.due, Boolean(x.dueUncertain)]),
    [
      ['2026-10-02', true],
      ['2026-10-09', false], // 对得上（10 月 9 日是周五）：按具体日期，不标待确认
      ['2026-10-02', true], // 原话在 quote 里
      ['2026-09-28', false],
    ],
  )
  // 用户手动定了日期，待确认去掉
  const fixed = patchTodo(items[0], { due: '2026-10-03' }, { projects })
  assert.equal(fixed.due, '2026-10-03')
  assert.equal(fixed.dueUncertain, undefined)
})

test('prompt：提取待办时让模型用纪要里已经写明的日期', () => {
  const session = { startedAt: THU, projectId: 'p_paper', segments: [] }
  const [sys] = todoMessages({ session, summary: SUMMARY_MD, project: projects[0], projects })
  assert.match(sys.content, /纪要的「我要做的事」「DDL 与时间节点」已经给一件事写了一个具体日期的，due 就用纪要的日期/)
  assert.match(sys.content, /原话和纪要都没给时间的 due 写 null/)
  assert.doesNotMatch(sys.content, /[\u2013\u2014]/)
})

test('Summarizer：提取出来没日期、纪要里写明了截止日期的待办存进去带上纪要的日期', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetcaption-sumdue-'))
  try {
    const ps = new ProjectStore({ root: () => root }).load()
    const store = new SessionStore({ projects: ps })
    const s = store.create({ projectId: INBOX_ID })
    s.segments.push({ id: '1', speaker: '对方', startedAt: s.startedAt + 390_000, text: 'We should apply the Bonferroni correction to the p-values on the WebVision subset. Then please rerun the ablation with scikit-learn and send me the ROC curve by Monday.' })
    store.saveNow(s)
    const md = SUMMARY_MD.split('\n## DDL')[0]
    const llm = async (o) =>
      o.json ? JSON.stringify({ title: '实验修改', items: [{ text: '对WebVision subset的p-values应用Bonferroni correction', due: null, dueText: null, owner: 'me', projectId: INBOX_ID, quote: 'We should apply the Bonferroni correction to the p-values on the WebVision subset.', at: '06:30' }] }) : md
    const sum = new Summarizer({ store, projects: ps, llm, aiStatus: () => ({ ready: true }) })
    const r = await sum.generate(s.id)
    assert.equal(r.items[0].due, '2026-09-28')
    assert.equal(store.load(s.id).summary.items[0].due, '2026-09-28')
    // 只重新提取待办（纪要不动）也一样
    const again = await sum.extract(s.id)
    assert.equal(again.items[0].due, '2026-09-28')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
