import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { SseParser, parseSse } from '../src/main/llm/sse.js'
import { LlmError, clipToTokens, estimateTokens } from '../src/main/llm/errors.js'
import {
  buildResponsesBody,
  toResponsesInput,
  mapEffort,
  applyResponsesEvent,
  newStreamState,
  responsesHttpError,
  responsesStreamError,
  formatReset,
  chatgptComplete,
} from '../src/main/llm/chatgpt.js'
import { buildBody, toChatMessages, withJsonHint, chat, chatStream, listModels as compatModels } from '../src/main/llm/openaiCompat.js'
import { complete, llmStatus, resolveModel, compatConfig, listModels } from '../src/main/llm/index.js'

const ev = (type, o = {}) => ({ event: type, data: JSON.stringify({ type, ...o }) })
const sse = (events) => events.map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`).join('')

/** 本地假服务：handler(req, body, n) → { status, headers, body | chunks }。 */
async function fakeServer(handler) {
  const reqs = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    reqs.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
    const out = await handler(req, reqs.at(-1), reqs.length)
    res.writeHead(out.status ?? 200, out.headers ?? { 'Content-Type': 'text/event-stream' })
    for (const c of out.chunks ?? [out.body ?? '']) {
      res.write(c)
      if (out.delay) await new Promise((r) => setTimeout(r, out.delay))
    }
    if (!out.hang) res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url,
    reqs,
    close: () => {
      server.closeAllConnections()
      return new Promise((r) => server.close(r))
    },
  }
}

/* ---------------- SSE ---------------- */

test('sse: frames split across chunks, CRLF, comments, multi-line data', () => {
  const p = new SseParser()
  const got = [
    ...p.push('event: a\r\ndata: {"x"'),
    ...p.push(':1}\r\n\r\n: keepalive\n\nda'),
    ...p.push('ta: line1\ndata: line2\n\n'),
    ...p.push('data: [DONE]'),
    ...p.end(),
  ]
  assert.deepEqual(got, [
    { event: 'a', data: '{"x":1}' },
    { event: '', data: 'line1\nline2' },
    { event: '', data: '[DONE]' },
  ])
  assert.equal(parseSse('event: x\n\n').length, 0) // 没有 data 的帧不算
})

/* ---------------- Responses 请求体 ---------------- */

test('responses: body shape, images, roles, json and effort', () => {
  const body = buildResponsesBody({
    model: 'gpt-5.6-luna',
    system: 'SYS',
    effort: 'low',
    json: true,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', dataUrl: 'data:image/jpeg;base64,AAA', detail: 'low' }] },
    ],
  })
  assert.equal(body.model, 'gpt-5.6-luna')
  assert.equal(body.instructions, 'SYS')
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.deepEqual(body.reasoning, { effort: 'low' })
  assert.deepEqual(body.text, { format: { type: 'json_object' } })
  assert.equal(body.max_output_tokens, undefined) // 后端不认
  assert.equal(body.input[0].role, 'developer')
  assert.match(body.input[0].content[0].text, /JSON/)
  assert.deepEqual(body.input[1], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] })
  assert.deepEqual(body.input[2].content, [{ type: 'output_text', text: 'hello' }])
  assert.deepEqual(body.input[3].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,AAA', detail: 'low' })
  const plain = buildResponsesBody({ model: 'm', messages: [{ role: 'system', content: 's' }] })
  assert.equal(plain.instructions, undefined)
  assert.equal(plain.reasoning, undefined)
  assert.equal(plain.input[0].role, 'developer')
  assert.equal(mapEffort('minimal'), 'none')
  assert.equal(mapEffort('bogus'), undefined)
  assert.equal(toResponsesInput([{ role: 'user', content: [] }]).length, 0)
})

/* ---------------- Responses 流解析 ---------------- */

test('responses: deltas accumulate, commentary skipped, completed ends', () => {
  const st = newStreamState()
  const events = parseSse(
    sse([
      ev('response.created', { response: { id: 'r' } }),
      ev('response.output_item.added', { item: { id: 'c1', type: 'message', phase: 'commentary' } }),
      ev('response.output_text.delta', { item_id: 'c1', delta: 'thinking aloud' }),
      ev('response.output_item.added', { item: { id: 'm1', type: 'message', phase: 'final_answer' } }),
      ev('response.output_text.delta', { item_id: 'm1', delta: '要点：' }),
      ev('response.output_text.delta', { item_id: 'm1', delta: 'Yes.' }),
      ev('response.output_text.done', { item_id: 'm1', text: '要点：Yes.' }),
      ev('response.completed', { response: { usage: { output_tokens: 3 } } }),
    ]),
  )
  const kinds = events.map((e) => applyResponsesEvent(st, e))
  assert.equal(st.text, '要点：Yes.')
  assert.equal(st.done, true)
  assert.equal(st.usage.output_tokens, 3)
  assert.deepEqual(kinds.filter(Boolean), ['delta', 'delta', 'done'])
})

test('responses: done text is used when no deltas arrived', () => {
  const st = newStreamState()
  applyResponsesEvent(st, ev('response.output_text.done', { item_id: 'm', text: 'whole' }))
  assert.equal(st.text, 'whole')
  assert.equal(applyResponsesEvent(st, { event: '', data: 'not json' }), null)
})

test('responses: failed / error / incomplete events throw readable errors', () => {
  const st = newStreamState()
  const fail = (code, message) => ev('response.failed', { response: { error: { code, message } } })
  assert.throws(() => applyResponsesEvent(st, fail('context_length_exceeded', 'x')), (e) => e.code === 'context-too-long')
  assert.throws(() => applyResponsesEvent(st, fail('rate_limit_exceeded', 'Try again in 2s')), (e) => e.code === 'rate-limit' && e.retryable)
  assert.throws(() => applyResponsesEvent(st, fail('insufficient_quota', 'x')), (e) => e.code === 'usage-limit')
  assert.throws(() => applyResponsesEvent(st, fail('server_is_overloaded', 'x')), (e) => e.code === 'overloaded')
  assert.throws(() => applyResponsesEvent(st, fail('invalid_prompt', 'bad words')), (e) => e.code === 'refused' && /bad words/.test(e.message))
  assert.throws(() => applyResponsesEvent(st, fail('weird', 'boom')), (e) => e.code === 'stream' && /boom/.test(e.message))
  assert.throws(() => applyResponsesEvent(st, ev('error', { code: 'usage_limit_reached', message: 'x' })), (e) => e.code === 'usage-limit')
  assert.throws(
    () => applyResponsesEvent(st, ev('response.incomplete', { response: { incomplete_details: { reason: 'content_filter' } } })),
    (e) => e.code === 'incomplete' && /过滤/.test(e.message),
  )
  const st2 = newStreamState()
  assert.equal(applyResponsesEvent(st2, ev('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } })), 'done')
  assert.equal(st2.truncated, true)
})

/* ---------------- 错误映射 ---------------- */

test('errors: http status → chinese reasons', () => {
  const e401 = responsesHttpError(401, '{"detail":"Could not parse your authentication token."}')
  assert.equal(e401.code, 'auth-expired')
  assert.match(e401.message, /重新登录/)
  assert.match(responsesHttpError(401, '{}', { source: 'codex' }).message, /codex/)
  const soon = Math.floor(Date.now() / 1000) + 3600
  const lim = responsesHttpError(429, JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'plus', resets_at: soon } }))
  assert.equal(lim.code, 'usage-limit')
  assert.match(lim.message, /额度用完/)
  assert.ok(lim.message.includes(formatReset(soon)))
  assert.equal(lim.resetsAt, soon * 1000)
  assert.equal(responsesHttpError(429, JSON.stringify({ error: { type: 'usage_not_included' } })).code, 'usage-not-included')
  assert.equal(responsesHttpError(429, '{"error":{"message":"slow"}}').code, 'rate-limit')
  assert.equal(responsesHttpError(403, '<html>cf</html>').code, 'forbidden')
  assert.match(responsesHttpError(403, '<html>cf</html>').message, /Cloudflare/)
  const bad = responsesHttpError(400, '{"detail":"The \'gpt-bogus\' model is not supported when using Codex with a ChatGPT account."}', { model: 'gpt-bogus' })
  assert.equal(bad.code, 'bad-model')
  assert.match(bad.message, /gpt-bogus/)
  assert.equal(responsesHttpError(400, '{"detail":"Unsupported parameter: temperature"}').code, 'bad-request')
  assert.equal(responsesHttpError(502, 'bad gateway').code, 'server')
  assert.equal(responsesHttpError(502, 'x').retryable, true)
  assert.equal(responsesStreamError(undefined).code, 'stream')
})

test('errors: reset time formatting', () => {
  const now = new Date(2026, 8, 24, 10, 0).getTime()
  assert.equal(formatReset(new Date(2026, 8, 24, 15, 5).getTime() / 1000, now), '15:05')
  assert.equal(formatReset(new Date(2026, 8, 26, 9, 30).getTime() / 1000, now), '9 月 26 日 09:30')
  assert.equal(formatReset(null, now), '')
})

test('errors: output length estimate and clipping', () => {
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('你好世界'), 4)
  const long = 'First sentence here. Second sentence is here. Third one goes on and on and on.'
  const clipped = clipToTokens(long, 12)
  assert.ok(estimateTokens(clipped) <= 12)
  assert.ok(clipped.endsWith('.'))
  assert.equal(clipToTokens('short', 100), 'short')
})

/* ---------------- chatgptComplete（假后端） ---------------- */

function fakeAuth({ token = 't1', refreshed = 't2', refreshOk = true } = {}) {
  let cur = token
  return {
    mode: 'app',
    refreshCalls: 0,
    async credentials() {
      return { accessToken: cur, accountId: 'acc-1', residency: null }
    },
    async forceRefresh() {
      this.refreshCalls++
      if (!refreshOk) return false
      cur = refreshed
      return true
    },
  }
}

const okStream = (...deltas) =>
  sse([
    ev('response.output_item.added', { item: { id: 'm', type: 'message' } }),
    ...deltas.map((d) => ev('response.output_text.delta', { item_id: 'm', delta: d })),
    ev('response.completed', { response: {} }),
  ])

test('chatgpt: streams deltas with the codex headers', async () => {
  const srv = await fakeServer(() => ({ chunks: [okStream('Hel', 'lo', ' there')] }))
  try {
    const seen = []
    const out = await chatgptComplete(fakeAuth(), {
      url: srv.url,
      model: 'gpt-5.6-luna',
      system: 'S',
      messages: [{ role: 'user', content: 'q' }],
      effort: 'none',
      onDelta: (t) => seen.push(t),
    })
    assert.equal(out, 'Hello there')
    assert.deepEqual(seen, ['Hel', 'Hello', 'Hello there'])
    const r = srv.reqs[0]
    assert.equal(r.headers.authorization, 'Bearer t1')
    assert.equal(r.headers['chatgpt-account-id'], 'acc-1')
    assert.equal(r.headers.originator, 'codex_cli_rs')
    assert.equal(r.headers.accept, 'text/event-stream')
    assert.equal(r.body.store, false)
    assert.deepEqual(r.body.reasoning, { effort: 'none' })
  } finally {
    await srv.close()
  }
})

test('chatgpt: 401 refreshes once and retries', async () => {
  const srv = await fakeServer((req) =>
    req.headers.authorization === 'Bearer t1'
      ? { status: 401, headers: { 'Content-Type': 'application/json' }, body: '{"detail":"expired"}' }
      : { chunks: [okStream('ok')] },
  )
  const auth = fakeAuth()
  try {
    assert.equal(await chatgptComplete(auth, { url: srv.url, model: 'm', messages: [{ role: 'user', content: 'q' }] }), 'ok')
    assert.equal(auth.refreshCalls, 1)
    assert.equal(srv.reqs.length, 2)
    const dead = fakeAuth({ refreshOk: false })
    await assert.rejects(chatgptComplete(dead, { url: srv.url, model: 'm', messages: [] }), (e) => e.code === 'auth-expired')
  } finally {
    await srv.close()
  }
})

test('chatgpt: 429 usage limit is surfaced in chinese', async () => {
  const srv = await fakeServer(() => ({
    status: 429,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: Math.floor(Date.now() / 1000) + 600 } }),
  }))
  try {
    await assert.rejects(chatgptComplete(fakeAuth(), { url: srv.url, model: 'm', messages: [] }), (e) => e instanceof LlmError && e.code === 'usage-limit')
  } finally {
    await srv.close()
  }
})

test('chatgpt: maxOutputTokens clips on the client and stops the stream', async () => {
  const words = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here. `)
  const srv = await fakeServer(() => ({ chunks: [okStream(...words)] }))
  try {
    const out = await chatgptComplete(fakeAuth(), { url: srv.url, model: 'm', messages: [], maxOutputTokens: 20 })
    assert.ok(estimateTokens(out) <= 20, out)
    assert.ok(out.length > 20)
  } finally {
    await srv.close()
  }
})

test('chatgpt: stream cut before completed is an error; abort and idle timeout', async () => {
  const cut = await fakeServer(() => ({ chunks: [sse([ev('response.output_text.delta', { item_id: 'm', delta: 'half' })])] }))
  const hang = await fakeServer(() => ({ chunks: [': ping\n\n'], hang: true }))
  try {
    await assert.rejects(chatgptComplete(fakeAuth(), { url: cut.url, model: 'm', messages: [] }), (e) => e.code === 'stream' && e.partial === 'half')
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    await assert.rejects(chatgptComplete(fakeAuth(), { url: hang.url, model: 'm', messages: [], signal: ctrl.signal }), (e) => e.name === 'AbortError')
    await assert.rejects(chatgptComplete(fakeAuth(), { url: hang.url, model: 'm', messages: [], idleMs: 80 }), (e) => e.code === 'timeout')
    await assert.rejects(chatgptComplete(fakeAuth(), { url: hang.url, model: 'm', messages: [], timeoutMs: 80 }), (e) => e.code === 'timeout')
    await assert.rejects(chatgptComplete(null, { model: 'm', messages: [] }), (e) => e.code === 'not-logged-in')
  } finally {
    await cut.close()
    await hang.close()
  }
})

test('chatgpt: network failure is translated', async () => {
  await assert.rejects(chatgptComplete(fakeAuth(), { url: 'http://127.0.0.1:9/responses', model: 'm', messages: [] }), (e) => e.code === 'network' && /连不上/.test(e.message))
})

/* ---------------- OpenAI 兼容 ---------------- */

test('compat: images, max tokens and json in the request body', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image', dataUrl: 'data:image/jpeg;base64,AAA' }] },
  ]
  const b = buildBody({ model: 'gpt-5.6-luna', messages: msgs, openai: true, effort: 'none', maxOutputTokens: 300, json: true })
  assert.deepEqual(b.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } })
  assert.equal(b.max_completion_tokens, 300)
  assert.equal(b.reasoning_effort, 'none')
  assert.deepEqual(b.response_format, { type: 'json_object' })
  assert.match(b.messages[0].content, /JSON object/)
  const custom = buildBody({ model: 'deepseek-chat', messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }], openai: false, effort: 'low', maxOutputTokens: 50 })
  assert.equal(custom.max_tokens, 50)
  assert.equal(custom.reasoning_effort, undefined)
  assert.equal(custom.messages[0].content, 'a\nb') // 纯文本数组压成字符串
  assert.deepEqual(toChatMessages([{ role: 'user', content: 'x' }]), [{ role: 'user', content: 'x' }])
  assert.equal(withJsonHint([{ role: 'user', content: 'give json' }]).length, 1)
  assert.equal(withJsonHint([{ role: 'user', content: 'x' }])[0].role, 'system')
})

test('compat: json falls back when response_format is unsupported; stream parses', async () => {
  const srv = await fakeServer((req, r) => {
    if (r.body.stream) {
      const chunk = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`
      return { chunks: [chunk('{"a"'), chunk(':1}'), 'data: [DONE]\n\n'] }
    }
    if (r.body.response_format) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: '{"error":{"message":"response_format is not supported"}}' }
    }
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content: ' {"a":1} ' } }] }) }
  })
  try {
    const out = await chat({ baseUrl: srv.url, key: 'k', openai: false, model: 'x', messages: [{ role: 'user', content: 'q' }], json: true })
    assert.equal(out, '{"a":1}')
    assert.equal(srv.reqs.length, 2)
    assert.equal(srv.reqs[1].body.response_format, undefined)
    const seen = []
    assert.equal(await chatStream({ baseUrl: srv.url, key: 'k', model: 'x', messages: [], onDelta: (t) => seen.push(t) }), '{"a":1}')
    assert.deepEqual(seen, ['{"a"', '{"a":1}'])
    assert.equal(srv.reqs.at(-1).headers.authorization, 'Bearer k')
  } finally {
    await srv.close()
  }
})

test('compat: effort none turns thinking off on reasoning models, drops it when unsupported', async () => {
  const msgs = [{ role: 'user', content: 'q' }]
  assert.deepEqual(buildBody({ model: 'deepseek-flash', messages: msgs, openai: false, baseUrl: 'https://api.deepseek.com', effort: 'none' }).thinking, { type: 'disabled' })
  assert.equal(buildBody({ model: 'qwen3', messages: msgs, openai: false, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', effort: 'none' }).enable_thinking, false)
  assert.equal(buildBody({ model: 'deepseek-flash', messages: msgs, openai: false, effort: 'low' }).thinking, undefined)
  assert.equal(buildBody({ model: 'gpt-5.6-luna', messages: msgs, openai: true, effort: 'none' }).thinking, undefined)

  const srv = await fakeServer((req, r) => {
    if (r.body.thinking) return { status: 400, headers: { 'Content-Type': 'application/json' }, body: '{"error":{"message":"Unknown parameter: thinking"}}' }
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) }
  })
  try {
    assert.equal(await chat({ baseUrl: srv.url, key: 'k', openai: false, model: 'x', messages: msgs, effort: 'none', json: true }), 'ok')
    assert.equal(srv.reqs.length, 2)
    assert.equal(srv.reqs[1].body.thinking, undefined)
    assert.deepEqual(srv.reqs[1].body.response_format, { type: 'json_object' })
  } finally {
    await srv.close()
  }
})

test('compat: reasoning with no answer text is an error, not an empty answer', async () => {
  const srv = await fakeServer((req, r) => {
    if (r.body.stream) {
      const chunk = (d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`
      return { chunks: [chunk({ reasoning_content: 'We need' }), chunk({ reasoning_content: ' to think' }), 'data: [DONE]\n\n'] }
    }
    return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'hmm' } }] }) }
  })
  try {
    await assert.rejects(chatStream({ baseUrl: srv.url, key: 'k', model: 'x', messages: [], onDelta: () => {} }), (e) => e.code === 'incomplete' && /思考/.test(e.message))
    await assert.rejects(chat({ baseUrl: srv.url, key: 'k', model: 'x', messages: [] }), (e) => e.code === 'incomplete')
  } finally {
    await srv.close()
  }
})

test('models: list from /models for the settings dropdown', async () => {
  const srv = await fakeServer((req) =>
    req.headers.authorization === 'Bearer k'
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'glm-5.2' }, { id: 'glm-4.7' }, { id: 'glm-4.7' }, {}] }) }
      : { status: 401, headers: { 'Content-Type': 'application/json' }, body: '{"error":{"message":"bad key"}}' },
  )
  try {
    assert.deepEqual(await compatModels({ baseUrl: srv.url + '/', key: 'k' }), ['glm-4.7', 'glm-5.2'])
    assert.equal(srv.reqs[0].url, '/models')
    const ok = await listModels({ llmProvider: 'custom', llmBaseUrl: srv.url, llmKey: 'k' })
    assert.deepEqual(ok, { ok: true, models: ['glm-4.7', 'glm-5.2'], label: new URL(srv.url).host })
    const bad = await listModels({ llmProvider: 'custom', llmBaseUrl: srv.url, llmKey: 'x' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /401/)
    assert.deepEqual(await listModels({ llmProvider: 'custom', llmBaseUrl: srv.url, llmKey: '' }), { ok: false, error: '还没填 API Key' })
    assert.equal((await listModels({ llmProvider: 'chatgpt' })).models.includes('gpt-5.6-terra'), true)
  } finally {
    await srv.close()
  }
})

test('compat: http errors map to codes', async () => {
  const srv = await fakeServer((req) => ({
    status: Number(req.url.split('/')[1]),
    headers: { 'Content-Type': 'application/json' },
    body: '{"error":{"message":"m","code":"insufficient_quota"}}',
  }))
  try {
    const call = (s) => chat({ baseUrl: `${srv.url}/${s}`, key: 'k', model: 'x', messages: [] })
    await assert.rejects(call(401), (e) => e.code === 'auth-expired' && /Key 无效/.test(e.message))
    await assert.rejects(call(429), (e) => e.code === 'usage-limit')
    await assert.rejects(call(404), (e) => e.code === 'bad-model')
    await assert.rejects(call(500), (e) => e.code === 'server')
  } finally {
    await srv.close()
  }
})

/* ---------------- 门面 ---------------- */

const S = {
  llmProvider: 'openai',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiKey: 'sk-x',
  llmKey: '',
  llmBaseUrl: 'https://api.deepseek.com/v1',
  llmFastModel: 'gpt-5.6-luna',
  llmSummaryModel: 'gpt-5.6-terra',
}

test('index: model aliases and provider routing config', () => {
  assert.equal(resolveModel(S, 'fast'), 'gpt-5.6-luna')
  assert.equal(resolveModel(S, 'smart'), 'gpt-5.6-terra')
  assert.equal(resolveModel(S, 'answer'), 'gpt-5.6-luna') // API 通道留空：跟快模型
  assert.equal(resolveModel({ ...S, llmProvider: 'chatgpt' }, 'answer'), 'gpt-5.6-terra') // 订阅通道留空：terra
  assert.equal(resolveModel({ ...S, llmAnswerModel: 'gpt-5.6-luna', llmProvider: 'chatgpt' }, 'answer'), 'gpt-5.6-luna')
  assert.equal(resolveModel(S, 'gpt-4.1'), 'gpt-4.1')
  // 从 deepseek 切到 chatgpt，旧的模型名不能用，换成默认
  const ds = { ...S, llmProvider: 'chatgpt', llmFastModel: 'deepseek-chat', llmSummaryModel: 'deepseek-reasoner' }
  assert.equal(resolveModel(ds, 'fast'), 'gpt-5.6-luna')
  assert.equal(resolveModel(ds, 'smart'), 'gpt-5.6-terra')
  assert.deepEqual(compatConfig(S), { baseUrl: 'https://api.openai.com/v1', key: 'sk-x', openai: true })
  assert.deepEqual(compatConfig({ ...S, llmProvider: 'custom', llmKey: 'k2' }), { baseUrl: 'https://api.deepseek.com/v1', key: 'k2', openai: false })
})

test('index: llmStatus for each provider', () => {
  assert.deepEqual(llmStatus(S, null), { provider: 'openai', ready: true, label: 'OpenAI API', reason: null })
  assert.equal(llmStatus({ ...S, openaiKey: '' }, null).reason, '没填 OpenAI Key')
  assert.equal(llmStatus({ ...S, llmProvider: 'custom' }, null).reason, '没填 AI 服务的 Key')
  assert.equal(llmStatus({ ...S, llmProvider: 'custom', llmKey: 'k' }, null).label, 'api.deepseek.com')
  // 内置服务：内置地址、各自的 Key
  const dsk = { ...S, llmProvider: 'deepseek', llmKeys: { deepseek: 'sk-ds' } }
  assert.deepEqual(compatConfig(dsk), { baseUrl: 'https://api.deepseek.com', key: 'sk-ds', openai: false })
  assert.deepEqual(llmStatus(dsk, null), { provider: 'deepseek', ready: true, label: 'DeepSeek', reason: null })
  assert.equal(llmStatus({ ...dsk, llmKeys: {} }, null).reason, '没填 DeepSeek 的 Key')
  const cg = { ...S, llmProvider: 'chatgpt' }
  assert.equal(llmStatus(cg, null).ready, false)
  const out = { status: () => ({ loggedIn: false, loggingIn: false, error: null }) }
  assert.equal(llmStatus(cg, out).reason, '还没用 ChatGPT 账号登录')
  const busy = { status: () => ({ loggedIn: false, loggingIn: true }) }
  assert.match(llmStatus(cg, busy).reason, /浏览器/)
  const inn = { status: () => ({ loggedIn: true, email: 'a@b.c', plan: 'plus', planLabel: 'Plus', source: 'app' }) }
  const st = llmStatus(cg, inn)
  assert.equal(st.ready, true)
  assert.equal(st.label, 'ChatGPT（a@b.c，Plus）')
  assert.equal(st.account.planLabel, 'Plus')
})

test('index: complete routes to chatgpt with the resolved model', async () => {
  const srv = await fakeServer(() => ({ chunks: [okStream('答')] }))
  try {
    // 用门面走 chatgpt：url 透传给 chatgptComplete（单测专用）
    const out = await complete({ ...S, llmProvider: 'chatgpt' }, fakeAuth(), { model: 'answer', url: srv.url, messages: [{ role: 'user', content: 'q' }] })
    assert.equal(out, '答')
    assert.equal(srv.reqs[0].body.model, 'gpt-5.6-terra')
    await assert.rejects(complete({ ...S, llmProvider: 'chatgpt' }, null, { messages: [] }), (e) => e.code === 'not-logged-in')
    await assert.rejects(complete({ ...S, openaiKey: '' }, null, { messages: [] }), (e) => e.code === 'not-logged-in')
  } finally {
    await srv.close()
  }
})

test('index: OpenAI uses the OpenAI key, never a key typed for another compatible service', () => {
  // 以前在「其他兼容服务」填过 DeepSeek 的 key，切回 OpenAI：不能把它发给 api.openai.com
  const ds = { ...S, llmKey: 'sk-deepseek', openaiKey: 'sk-openai' }
  assert.equal(compatConfig(ds).key, 'sk-openai')
  assert.equal(compatConfig({ ...ds, openaiKey: '' }).key, '')
  assert.equal(llmStatus({ ...ds, openaiKey: '' }, null).ready, false)
  // v1 的老设置：llmKey 本来就是给 api.openai.com 填的，OpenAI Key 那一栏空着，才拿来用
  assert.equal(compatConfig({ ...S, openaiKey: '', llmKey: 'sk-old', llmBaseUrl: 'https://api.openai.com/v1' }).key, 'sk-old')
  // 其他兼容服务照旧用 llmKey
  assert.equal(compatConfig({ ...ds, llmProvider: 'custom' }).key, 'sk-deepseek')
})
