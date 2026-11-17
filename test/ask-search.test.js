import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClassAsk } from '../src/main/class/ask.js'
import { askMessages, askSystem, parseAsk, parseSearch, resolveSources, transcriptForAsk, webForAsk } from '../src/main/class/askPrompt.js'
import { searchConfig, searchQuery, webSearch, SearchError } from '../src/main/llm/search.js'
import { withMemberAuth } from '../src/main/member/client.js'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'

// 问 AI 联网：AI 资料不够时第一行写「搜索：<搜索词>」，停掉这次回答去搜，带上结果再问一次（不再给搜索这一条），依据里列出处。
// 只有 DeepSeek（自带 Key）和会员能搜；搜不成照常回答，记下 web.status。

const START = new Date(2026, 10, 17, 10, 0, 0).getTime()
const mmss = (ms) => `${String(Math.floor((ms - START) / 60000)).padStart(2, '0')}:00`

const RESULTS = [
  { title: '光电容积脉搏波描记法 - 维基百科', url: 'https://zh.wikipedia.org/wiki/PPG', date: '2025-03-01T00:00:00Z', summary: 'PPG（photoplethysmography）用光照射皮肤，测反射或透射光的强弱变化来得到脉搏波形。'.repeat(3) },
  { title: 'What is PPG', url: 'https://www.example.com/ppg', date: null, summary: 'PPG sensors in smartwatches measure heart rate.' },
  { title: '不安全的', url: 'http://insecure.example.com/x', date: null, summary: 'http 的网址' },
]

/* ---------------- 解析「搜索：」那一行 ---------------- */

test('parseSearch: 第一行写完的「搜索：」给出搜索词；还没写完先等；别的回答马上放行', () => {
  assert.deepEqual(parseSearch('搜索：PPG 光电容积脉搏波\n'), { query: 'PPG 光电容积脉搏波' })
  assert.deepEqual(parseSearch('  \n**搜索：** 「PPG」\n'), { query: 'PPG' }, '前面的空行、粗体、引号去掉')
  assert.deepEqual(parseSearch('搜索: PPG', { final: true }), { query: 'PPG' }, '半角冒号；流结束时没有换行也算写完')
  assert.equal(parseSearch(''), 'wait')
  assert.equal(parseSearch('搜'), 'wait')
  assert.equal(parseSearch('搜索：PPG 光电'), 'wait', '搜索词还没写完')
  assert.equal(parseSearch('覆盖：讲过'), null)
  assert.equal(parseSearch('覆'), null, '第一个字就对不上，马上照常显示')
  assert.equal(parseSearch('要点：搜索：是一种……\n'), null)
  assert.equal(parseSearch('搜索：\n', { final: true }), null, '没写搜索词不算')
  // 回答里混进来的「搜索：」行不露给用户
  const p = parseAsk('搜索：PPG\n覆盖：讲过\n要点：一句话\n- 一条', null, { final: true })
  assert.equal(p.gist, '一句话')
  assert.deepEqual(p.points, [{ text: '一条' }])
})

/* ---------------- 提示词 ---------------- */

const SEGMENTS = [
  { id: 's1', startedAt: START + 60_000, text: '今天讲心率变异性 HRV，我们用心电 ECG 的 R 波间期来算。', speaker: '老师' },
  { id: 's2', startedAt: START + 120_000, text: '像手表上用 PPG 也能测心率，这个今天不展开。', speaker: '老师' },
  { id: 's3', startedAt: START + 180_000, text: 'HRV 的时域指标有 SDNN 和 RMSSD，SDNN 是所有 RR 间期的标准差。', speaker: '老师' },
]

function prompt(extra = {}) {
  const transcript = transcriptForAsk(SEGMENTS, { query: extra.question ?? 'ppg 是什么？', clockTime: mmss })
  return askMessages({ session: { startedAt: START, endedAt: START + 3_600_000, mode: 'class' }, mode: 'class', live: false, transcript, question: 'ppg 是什么？', ...extra })
}

test('askSystem: 能联网时多一条「搜索：」的规则；不能联网、已经搜过时都没有', () => {
  assert.match(askSystem({ search: true }), /整个回答只写一行「搜索：<搜索词>」/)
  assert.doesNotMatch(askSystem({}), /搜索：/)
  assert.doesNotMatch(askSystem({ web: true }), /只写一行「搜索/)
  assert.match(askSystem({ search: true, mode: 'meeting' }), /会上只顺带提到/)
  const first = prompt({ search: true })
  assert.match(first.system, /只写一行「搜索：<搜索词>」/)
  assert.match(first.messages.at(-1).content, /要联网查就只写一行「搜索：<搜索词>」/)
  const plain = prompt()
  assert.doesNotMatch(plain.system + plain.messages.at(-1).content, /搜索/)
})

test('askMessages: 搜索结果编成「网N」放进资料（标题、日期、网址、摘要），不再给搜索这一条；依据里的 网N 换成出处链接', () => {
  const p = prompt({ search: true, web: { query: 'PPG 光电容积脉搏波', results: RESULTS } })
  const content = p.messages.at(-1).content
  assert.match(content, /刚才联网搜索了「PPG 光电容积脉搏波」/)
  assert.match(content, /网1 光电容积脉搏波描记法 - 维基百科（2025-03-01） https:\/\/zh\.wikipedia\.org\/wiki\/PPG\nPPG（photoplethysmography）/)
  assert.match(content, /网2 What is PPG https:\/\/www\.example\.com\/ppg/)
  assert.doesNotMatch(p.system, /只写一行「搜索/, '搜过以后不再给搜索这一条')
  assert.match(p.system, /以结果为准/)
  assert.match(p.system, /网1 网3/)
  assert.doesNotMatch(content, /要联网查就/)
  // 摘要太长就截断
  assert.ok(webForAsk([{ ...RESULTS[0], summary: '字'.repeat(2000) }]).length < 800)
  // 依据：网页最多 3 个，只要 https 的，同一个只出一次，编号对不上的丢掉
  const src = resolveSources('#2 网1 网1 网2 网3 网9', p.refs)
  assert.deepEqual(src.filter((x) => x.type === 'web'), [
    { type: 'web', url: 'https://zh.wikipedia.org/wiki/PPG', title: '光电容积脉搏波描记法 - 维基百科', site: 'wikipedia.org' },
    { type: 'web', url: 'https://www.example.com/ppg', title: 'What is PPG', site: 'example.com' },
  ])
  assert.equal(src[0].type, 'seg')
  // 出处按钮上只写主域名，两段的国家后缀留三段
  const site = (url) => resolveSources('网1', { web: [{ url, title: 'x' }] })[0].site
  assert.equal(site('https://img2.kepuchina.cn/sx/a.shtml'), 'kepuchina.cn')
  assert.equal(site('https://wiki.cnki.com.cn/HotWord/1.htm'), 'cnki.com.cn')
  assert.equal(site('https://patentimages.storage.googleapis.com/x.pdf#2#2'), 'googleapis.com')
  assert.equal(site('https://www.bbc.co.uk/news'), 'bbc.co.uk')
  assert.equal(site('https://example.com/a'), 'example.com')
  // 没查到结果：资料里不放搜索段，提示词和没搜一样（不再给搜索）
  const empty = prompt({ search: true, web: { query: 'PPG', results: [] } })
  assert.doesNotMatch(empty.messages.at(-1).content, /联网搜索/)
  assert.deepEqual(resolveSources('网1', empty.refs), [])
})

/* ---------------- 搜索往哪发 ---------------- */

test('searchConfig: 只有 DeepSeek（自带 Key）和会员能搜，别的 AI 服务、没有 Key 都不搜', () => {
  assert.deepEqual(searchConfig({ llmProvider: 'deepseek', llmKeys: { deepseek: 'sk-1' } }), { url: 'https://api.deepseek.com/v1/tools/search', key: 'sk-1', member: false })
  const m = searchConfig({ llmProvider: 'member', llmKeys: { member: 'mcs_x' } })
  assert.match(m.url, /\/v1\/search$/)
  assert.equal(m.member, true)
  assert.equal(searchConfig({ llmProvider: 'deepseek', llmKeys: {} }), null)
  assert.equal(searchConfig({ llmProvider: 'member', llmKeys: { member: '' } }), null, '会员 AI 用不了时也不搜')
  for (const p of ['openai', 'chatgpt', 'zhipu', 'qwen', 'kimi', 'custom', 'claude']) assert.equal(searchConfig({ llmProvider: p, llmKeys: { [p]: 'k' }, openaiKey: 'k', llmKey: 'k' }), null, p)
})

function fakeFetch(reply) {
  const calls = []
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    const r = typeof reply === 'function' ? await reply(init) : reply
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 })
  }
  return { f, calls }
}

test('webSearch: 发 DeepSeek 的格式（query ≤ 128 字、count 6）；会员带 X-Ask-Id；回结果列表，只要有网址的', async () => {
  const { f, calls } = fakeFetch({ body: { results: [...RESULTS, { title: 'no url' }] } })
  const r = await webSearch({ url: 'https://api.deepseek.com/v1/tools/search', key: 'sk-1', member: false }, `  PPG\n是什么 ${'字'.repeat(200)}`, { fetch: f })
  assert.equal(r.length, 3)
  assert.deepEqual(r[0], { title: RESULTS[0].title, url: RESULTS[0].url, date: RESULTS[0].date, summary: RESULTS[0].summary })
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-1')
  assert.equal(calls[0].body.count, 6)
  assert.equal([...calls[0].body.query].length, 128)
  assert.ok(calls[0].body.query.startsWith('PPG 是什么'))
  assert.equal(calls[0].init.headers['X-Ask-Id'], undefined, '自带 Key 不带我们的请求头')
  await webSearch({ url: 'https://api.us-cloud.uk/v1/search', key: 'mcs_x', member: true }, 'PPG', { fetch: f, askId: 'a123456789' })
  assert.equal(calls[1].init.headers['X-Ask-Id'], 'a123456789')
  assert.equal(searchQuery(' a \n b '), 'a b')
})

test('webSearch: 服务器没部署（404）、Key 不对、不是 JSON、超时都抛 SearchError；会员回 401 时 withMemberAuth 换凭据再试一次', async () => {
  const cfg = { url: 'https://api.us-cloud.uk/v1/search', key: 'mcs_x', member: true }
  await assert.rejects(webSearch(cfg, 'PPG', { fetch: fakeFetch({ status: 404, body: { error: { code: 'not-found' } } }).f }), (e) => e instanceof SearchError && e.status === 404)
  await assert.rejects(webSearch(cfg, 'PPG', { fetch: fakeFetch({ body: 'oops' }).f }), SearchError)
  await assert.rejects(webSearch(cfg, 'PPG', { fetch: fakeFetch({ body: { nothing: 1 } }).f }), SearchError)
  const slow = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
  await assert.rejects(webSearch(cfg, 'PPG', { fetch: fakeFetch(slow).f, timeoutMs: 30 }), (e) => e instanceof SearchError && /timeout/.test(e.message))
  await assert.rejects(webSearch(cfg, '   ', { fetch: fakeFetch({ body: { results: [] } }).f }), SearchError)
  // 401：换凭据（renewAiKey 说换到了）再试一次
  const keys = ['old', 'new']
  const used = []
  const m = { renewAiKey: async () => (keys.shift(), true) }
  const { f } = fakeFetch((init) => (used.push(init.headers.Authorization), init.headers.Authorization === 'Bearer old' ? { status: 401, body: {} } : { body: { results: RESULTS } }))
  const r = await withMemberAuth(m, () => ({ llmProvider: 'member', llmKeys: { member: keys[0] } }), (s) => webSearch(searchConfig(s), 'PPG', { fetch: f }))
  assert.equal(r.length, 3)
  assert.deepEqual(used, ['Bearer old', 'Bearer new'])
})

/* ---------------- 控制器：先搜、再答 ---------------- */

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-asksearch-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const store = new SessionStore({ projects: ps })
  const s = store.create({ mode: 'class', classSource: 'mic' })
  s.startedAt = START
  s.endedAt = START + 3_600_000
  s.segments.push(...SEGMENTS)
  store.saveNow(s)
  return { root, store, id: s.id }
}

const ANSWER = ['覆盖：提了一句 #2', '要点：PPG 是用光测脉搏的方法', '- 光照皮肤，看反射光随血流的变化', '- 手表测心率就用它', '依据：#2 网1 网2', '接着问：PPG 和 ECG 有什么区别？'].join('\n')

/**
 * replies：每次调用模型怎么回，'search' = 先流出「搜索：PPG 光电容积脉搏波」一行，然后一直等到被停掉（看第一行写完就停）。
 * search：假的联网搜索。
 */
function make({ replies, search = async () => RESULTS, searchable = () => true }) {
  const t = setup()
  const calls = []
  const searches = []
  const llm = async (o) => {
    calls.push(o)
    const r = replies[calls.length - 1]
    if (r === 'search') {
      o.onDelta?.('搜')
      o.onDelta?.('搜索：PPG 光电')
      o.onDelta?.('搜索：PPG 光电容积脉搏波\n')
      // 真的模型还会接着写；这里等它被停掉，确认 ask.js 看到这一行就停了
      return new Promise((_, reject) => {
        if (o.signal.aborted) return reject(new DOMException('已取消', 'AbortError'))
        o.signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')))
      })
    }
    o.onUsage?.({ prompt_tokens: 100, completion_tokens: 10 })
    o.onDelta?.(r.slice(0, 30))
    return r
  }
  const updates = []
  const a = new ClassAsk({ store: t.store, llm, aiStatus: () => ({ ready: true }), search: async (x) => (searches.push(x), search(x)), searchable })
  a.on('update', (u) => updates.push(u))
  const done = new Promise((resolve) => a.on('update', (u) => u.status !== 'streaming' && resolve(u)))
  return { ...t, a, calls, searches, updates, done }
}

test('ClassAsk: 模型先写「搜索：」就停掉、去搜，带上结果再问一次；界面先看到「正在联网查」，回答带出处，存下来', async () => {
  const t = make({ replies: ['search', ANSWER] })
  assert.equal((await t.a.ask({ sessionId: t.id, question: 'ppg 是什么？' })).ok, true)
  const u = await t.done
  assert.equal(t.calls.length, 2)
  assert.match(t.calls[0].system, /只写一行「搜索：<搜索词>」/)
  assert.ok(t.calls[0].signal.aborted, '看到「搜索：」那一行就停了')
  assert.equal(t.searches.length, 1)
  assert.equal(t.searches[0].query, 'PPG 光电容积脉搏波')
  assert.equal(t.searches[0].askId, u.id, '会员服务器按提问号限次')
  assert.equal(t.searches[0].sessionStartedAt, START, '下课后：和问 AI 同一个凭据')
  assert.doesNotMatch(t.calls[1].system, /只写一行「搜索/, '第二次不再给搜索')
  assert.match(t.calls[1].messages.at(-1).content, /网1 光电容积脉搏波描记法/)
  // 搜索那一行从没露给界面
  assert.ok(t.updates.every((x) => !String(x.gist ?? '').includes('搜索') && !(x.points ?? []).some((p) => p.text?.includes('搜索'))))
  const searching = t.updates.find((x) => x.web?.status === 'searching')
  assert.deepEqual(searching.web, { query: 'PPG 光电容积脉搏波', status: 'searching' })
  assert.equal(u.status, 'done')
  assert.deepEqual(u.web, { query: 'PPG 光电容积脉搏波', status: 'ok', n: 3 })
  assert.equal(u.cover.kind, 'partial')
  assert.equal(u.gist, 'PPG 是用光测脉搏的方法')
  assert.deepEqual(u.src.map((x) => x.type), ['seg', 'web', 'web'])
  assert.equal(u.src[1].url, 'https://zh.wikipedia.org/wiki/PPG')
  const saved = t.store.load(t.id).asks[0]
  assert.deepEqual(saved.web, u.web)
  assert.equal(saved.src[1].site, 'wikipedia.org')
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk: 搜索失败（会员服务器没部署、超时）照常回答，web.status 是 failed，第二次不给搜索结果也不给搜索', async () => {
  const t = make({ replies: ['search', ANSWER.replace(' 网1 网2', '')], search: async () => Promise.reject(new SearchError('HTTP 404', 404)) })
  await t.a.ask({ sessionId: t.id, question: 'ppg 是什么？' })
  const u = await t.done
  assert.equal(u.status, 'done')
  assert.deepEqual(u.web, { query: 'PPG 光电容积脉搏波', status: 'failed' })
  assert.equal(t.calls.length, 2)
  assert.doesNotMatch(t.calls[1].messages.at(-1).content, /联网搜索/)
  assert.doesNotMatch(t.calls[1].system, /只写一行「搜索/)
  assert.equal(u.gist, 'PPG 是用光测脉搏的方法')
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk: 没查到结果照常回答，web.status 是 empty', async () => {
  const t = make({ replies: ['search', ANSWER], search: async () => [] })
  await t.a.ask({ sessionId: t.id, question: 'ppg 是什么？' })
  const u = await t.done
  assert.equal(u.status, 'done')
  assert.deepEqual(u.web, { query: 'PPG 光电容积脉搏波', status: 'empty' })
  assert.ok(u.src.every((x) => x.type !== 'web'))
  fs.rmSync(t.root, { recursive: true, force: true })
})

test('ClassAsk: 不用搜时照常一次答完；不是 DeepSeek 或会员时提示词里没有搜索这一条，也不会去搜', async () => {
  const t = make({ replies: [ANSWER.replace('提了一句 #2', '讲过')] })
  await t.a.ask({ sessionId: t.id, question: 'SDNN 是什么？' })
  const u = await t.done
  assert.equal(t.calls.length, 1)
  assert.equal(t.searches.length, 0)
  assert.equal(u.web, undefined)
  assert.equal(u.status, 'done')
  fs.rmSync(t.root, { recursive: true, force: true })

  const ats = []
  const o = make({ replies: [ANSWER], searchable: (at) => (ats.push(at), false) })
  await o.a.ask({ sessionId: o.id, question: 'ppg 是什么？' })
  await o.done
  assert.deepEqual(ats, [START], '按这一场的凭据问能不能搜')
  assert.doesNotMatch(o.calls[0].system, /搜索/)
  assert.equal(o.searches.length, 0)
  fs.rmSync(o.root, { recursive: true, force: true })
})

test('ClassAsk: 正在联网查时点停止，不再问第二次，什么都不存', async () => {
  let started
  const t = make({ replies: ['search', ANSWER], search: ({ signal }) => new Promise((_, reject) => ((started = true), signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError'))))) })
  await t.a.ask({ sessionId: t.id, question: 'ppg 是什么？' })
  while (!started) await new Promise((r) => setTimeout(r, 5))
  t.a.stop(t.id)
  const u = await t.done
  assert.equal(u.status, 'stopped')
  assert.equal(t.calls.length, 1)
  assert.equal(t.store.load(t.id).asks?.length ?? 0, 0)
  fs.rmSync(t.root, { recursive: true, force: true })
})
