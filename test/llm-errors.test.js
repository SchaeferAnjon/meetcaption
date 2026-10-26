import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildBody, chat, chatStream } from '../src/main/llm/openaiCompat.js'
import { LlmError } from '../src/main/llm/errors.js'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { Summarizer } from '../src/main/summary.js'
import { EventEmitter } from 'node:events'
import { MeetingEngine } from '../src/main/engine.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// OpenAI 兼容通道：会员服务器和 DeepSeek 的错误说人话、DeepSeek 的 low 真的压低思考、长输出被截断要报出来。

async function fakeServer(handler) {
  const reqs = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    reqs.push({ url: req.url, body: body ? JSON.parse(body) : null })
    const out = await handler(req, reqs.at(-1))
    res.writeHead(out.status ?? 200, { 'Content-Type': out.json ? 'application/json' : 'text/event-stream' })
    for (const c of out.chunks ?? [out.body ?? '']) res.write(c)
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    reqs,
    close: () => {
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    },
  }
}

const err = (status, error) => ({ status, json: true, body: JSON.stringify({ error }) })

test('会员服务器的用量上限映射成 usage-limit（不重试、不说太频繁）；会员 401 不说 Key 无效；自带 Key 余额不足说去充值', async () => {
  const cases = {
    '/session-ai-limit': err(429, { code: 'session-ai-limit', message: '这一场的 AI 用量到上限了' }),
    '/device-ai-limit': err(429, { code: 'device-ai-limit', message: '今天会后整理的 AI 额度用完了' }),
    '/exhausted': err(402, { code: 'exhausted', message: '这一场的时间用完了，场次余额不够' }),
    '/no-balance': err(402, { code: 'no-balance', message: '试用场次用完了，买场次后 AI 才能用' }),
    '/bad-session': err(401, { code: 'bad-session', message: '这一场已经结束超过 24 小时' }),
    '/deepseek-401': err(401, { message: 'Authentication Fails, Your api key is invalid', type: 'authentication_error', code: 'invalid_request_error' }),
    '/deepseek-402': err(402, { message: 'Insufficient Balance', type: 'unknown_error', code: 'invalid_request_error' }),
    '/rate': err(429, { code: 'rate', message: 'AI 请求太频繁，稍后再试' }),
  }
  const srv = await fakeServer((req) => cases[req.url.replace('/chat/completions', '')])
  try {
    const call = (p) => chat({ baseUrl: srv.url + p, key: 'k', model: 'x', messages: [] }).then(() => null, (e) => e)
    for (const p of ['/session-ai-limit', '/device-ai-limit', '/exhausted', '/no-balance']) {
      const e = await call(p)
      assert.equal(e.code, 'usage-limit', p)
      assert.equal(e.retryable, false, p)
      assert.doesNotMatch(e.message, /频繁|Key 无效/, p)
    }
    assert.match((await call('/session-ai-limit')).message, /这一场的 AI 用量到上限了.*下一场重新计算/)
    assert.match((await call('/exhausted')).message, /会员时间用完了.*买了场次/)
    const bad = await call('/bad-session')
    assert.equal(bad.code, 'auth-expired')
    assert.equal(bad.status, 401)
    assert.match(bad.message, /会员凭据失效了（401）：这一场已经结束超过 24 小时/)
    assert.doesNotMatch(bad.message, /Key/)
    assert.match((await call('/deepseek-401')).message, /Key 无效/)
    const poor = await call('/deepseek-402')
    assert.equal(poor.code, 'usage-limit')
    assert.equal(poor.status, 402)
    assert.match(poor.message, /^AI 服务账户余额不足，去充值（402）：Insufficient Balance/)
    const rate = await call('/rate')
    assert.equal(rate.code, 'rate-limit')
    assert.equal(rate.retryable, true)
  } finally {
    await srv.close()
  }
})

test('DeepSeek：纪要、实时笔记传的 low 关掉思考（默认 high 要想一两分钟）；别家的 low 不动', () => {
  const msgs = [{ role: 'user', content: 'q' }]
  const ds = buildBody({ model: 'deepseek-v4-pro', messages: msgs, openai: false, baseUrl: 'https://api.deepseek.com', effort: 'low', json: true })
  assert.deepEqual(ds.thinking, { type: 'disabled' })
  assert.deepEqual(buildBody({ model: 'deepseek-flash', messages: msgs, openai: false, baseUrl: 'https://api.deepseek.com/v1', effort: 'low' }).thinking, { type: 'disabled' })
  const glm = buildBody({ model: 'glm-5.3', messages: msgs, openai: false, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', effort: 'low' })
  assert.equal(glm.thinking, undefined)
  assert.equal(glm.reasoning_effort, undefined)
  assert.equal(buildBody({ model: 'gpt-5.6-terra', messages: msgs, openai: true, baseUrl: 'https://api.openai.com/v1', effort: 'low' }).reasoning_effort, 'low')
})

const chunk = (delta, finish = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`

test('长输出被截断要报错：finish_reason 是 length，或者流没收到 [DONE] 就断了；半截内容放在 partial', async () => {
  const streams = {
    '/length': [chunk({ content: '## 纪要\n' }), chunk({ content: '一半' }, 'length'), 'data: [DONE]\n\n'],
    '/cut': [chunk({ content: '## 纪要\n' }), chunk({ content: '一半' })],
    '/stop-no-done': [chunk({ content: '完整' }), chunk({}, 'stop')],
    '/ok': [chunk({ content: '完整' }), chunk({}, 'stop'), 'data: [DONE]\n\n'],
  }
  const srv = await fakeServer((req, r) => {
    const p = req.url.replace('/chat/completions', '')
    if (r.body.stream) return { chunks: streams[p] }
    return { json: true, body: JSON.stringify({ choices: [{ message: { content: '{"a":' }, finish_reason: p === '/length' ? 'length' : 'stop' }] }) }
  })
  try {
    const stream = (p, o = {}) => chatStream({ baseUrl: srv.url + p, key: 'k', model: 'x', messages: [], onDelta: () => {}, ...o })
    await assert.rejects(stream('/length'), (e) => e.code === 'incomplete' && /内容被截断/.test(e.message) && e.partial === '## 纪要\n一半')
    await assert.rejects(stream('/cut'), (e) => e.code === 'stream' && /内容被截断/.test(e.message) && e.partial === '## 纪要\n一半')
    assert.equal(await stream('/stop-no-done'), '完整', '有 finish_reason 没有 [DONE] 的服务也算写完')
    assert.equal(await stream('/ok'), '完整')
    assert.equal(await stream('/length', { maxOutputTokens: 400 }), '## 纪要\n一半', '调用方自己给的上限（答题）是有意截短，不报错')
    await assert.rejects(chat({ baseUrl: srv.url + '/length', key: 'k', model: 'x', messages: [], json: true }), (e) => e.code === 'incomplete' && /内容被截断/.test(e.message))
    assert.equal(await chat({ baseUrl: srv.url + '/ok', key: 'k', model: 'x', messages: [] }), '{"a":')
  } finally {
    await srv.close()
  }
})

test('纪要写到一半被截断：半截先存下，再报「内容被截断」；没写出东西的照常报错', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meetcaption-cut-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const store = new SessionStore({ projects: ps })
  const s = store.create({})
  s.segments.push({ id: '1', speaker: '对方', startedAt: s.startedAt + 1000, text: 'Ledger migration by next Friday.' })
  store.saveNow(s)
  const cutAt = (partial) => async () => {
    throw Object.assign(new LlmError('incomplete', '内容被截断：超过了 AI 服务一次能写的长度'), { partial })
  }
  const sum = new Summarizer({ store, projects: ps, llm: cutAt('## 一句话总结\n迁移下周五完成。\n## 讨论'), aiStatus: () => ({ ready: true }) })
  await assert.rejects(sum.generate(s.id), /内容被截断.*前面写好的部分已经存下/)
  assert.equal(store.load(s.id).summary.markdown, '## 一句话总结\n迁移下周五完成。\n## 讨论')
  const empty = new Summarizer({ store, projects: ps, llm: cutAt(''), aiStatus: () => ({ ready: true }) })
  await assert.rejects(empty.generate(s.id), (e) => e.message === '内容被截断：超过了 AI 服务一次能写的长度')
})

test('引擎：自带 Key 的 402（余额不足）提示一次；会员的 402 另有「场次用完」的提示，这里不报', async () => {
  const notices = async (llmProvider) => {
    const cfg = applyPatch(merge(DEFAULTS, {}), { translate: true, llmProvider, terms: { enabled: false, correct: false }, display: { chunkColors: false }, assist: { enabled: false } })
    const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
    const store = { create: (meta) => ({ id: 't', startedAt: Date.now() - 1, segments: [], ...meta }), scheduleSave() {}, saveNow() {}, remove: async () => {} }
    const asr = Object.assign(new EventEmitter(), { sampleRate: 16000, gated: false, connect: async () => {}, sendAudio() {}, endTurn() {}, close: async () => {} })
    const llm = async () => {
      throw new LlmError('usage-limit', 'AI 服务账户余额不足，去充值（402）：Insufficient Balance', { status: 402 })
    }
    const engine = new MeetingEngine({ settings, store, rendererCapture: null, llm, llmStatus: () => ({ ready: true }), createProvider: () => asr })
    engine.useFakeSources({ system: true })
    const got = []
    engine.on('notice', (n) => n.code === 'enhance' && n.text && got.push(n.text))
    await engine.start()
    asr.emit('final', { key: 'a', text: 'The ledger migration is the risky one.' })
    await new Promise((r) => setTimeout(r, 1800)) // 失败后 1.5 秒只要译文再试一次，再失败才提示
    await engine.stop()
    return got
  }
  assert.deepEqual(await notices('deepseek'), ['翻译失败：AI 服务账户余额不足，去充值（402）：Insufficient Balance'])
  assert.deepEqual(await notices('member'), [])
})
