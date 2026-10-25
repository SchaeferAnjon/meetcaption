// OpenAI 兼容的 Chat Completions：OpenAI、DeepSeek、Kimi、豆包方舟、通义等都能用同一套。
// 消息 content 可以是字符串，也可以是 [{ type:'text', text } | { type:'image', dataUrl, detail? }]。
import { readSse } from './sse.js'
import { LlmError, requestControl, networkError } from './errors.js'
import { t } from '../i18n.js'

const JSON_HINT = 'Respond with a single JSON object only. No code fences, no extra text.'

export function endpoint(baseUrl) {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions'
}

function toPart(p) {
  if (p.type === 'image') return { type: 'image_url', image_url: { url: p.dataUrl, ...(p.detail ? { detail: p.detail } : {}) } }
  if (p.type === 'image_url') return p
  return { type: 'text', text: String(p.text ?? '') }
}

/** 统一消息 → chat completions 消息；纯文本的数组压成字符串，兼容不认数组的服务。 */
export function toChatMessages(messages = []) {
  return messages.map((m) => {
    if (typeof m.content === 'string' || !Array.isArray(m.content)) return { role: m.role, content: m.content ?? '' }
    const parts = m.content.map(toPart)
    if (parts.every((p) => p.type === 'text')) return { role: m.role, content: parts.map((p) => p.text).join('\n') }
    return { role: m.role, content: parts }
  })
}

function textOf(m) {
  return typeof m.content === 'string' ? m.content : (m.content ?? []).map((p) => p.text ?? '').join(' ')
}

/** json_object 要求消息里出现 json 字样，没有就补一条 system。 */
export function withJsonHint(messages) {
  if (messages.some((m) => /json/i.test(textOf(m)))) return messages
  const i = messages.findIndex((m) => m.role === 'system')
  if (i < 0) return [{ role: 'system', content: JSON_HINT }, ...messages]
  const out = [...messages]
  out[i] = { ...out[i], content: typeof out[i].content === 'string' ? `${out[i].content}\n\n${JSON_HINT}` : out[i].content }
  return out
}

// 推理模型（DeepSeek V4、GLM 4.5 起、豆包 Seed、Qwen3）默认先思考：翻译一句要十几秒，答题的输出上限被思考用光、正文是空的。
// effort 为 none 时关掉思考；通义用 enable_thinking，智谱 GLM 5 起关不掉、只能压到 reasoning_effort low，其余用 thinking.type。
// 不认这个参数的服务回 400 时去掉再试。
function noThinking(baseUrl) {
  if (/dashscope/i.test(baseUrl ?? '')) return { enable_thinking: false }
  if (/bigmodel\.cn/i.test(baseUrl ?? '')) return { reasoning_effort: 'low' }
  return { thinking: { type: 'disabled' } }
}

export function buildBody({ model, messages, openai, baseUrl, effort, stream, maxOutputTokens, json }) {
  let msgs = toChatMessages(messages)
  if (json) msgs = withJsonHint(msgs)
  const body = { model, messages: msgs }
  if (stream) body.stream = true
  // OpenAI 的 gpt-5 系列默认会先思考；翻译要快就关掉，总结给一点。
  if (openai && /^gpt-5/.test(model) && effort) body.reasoning_effort = effort === 'minimal' ? 'none' : effort
  if (!openai && (effort === 'none' || effort === 'minimal')) Object.assign(body, noThinking(baseUrl))
  // OpenAI 新模型只认 max_completion_tokens（含思考 token）；其他兼容服务大多只认 max_tokens。
  if (maxOutputTokens) body[openai ? 'max_completion_tokens' : 'max_tokens'] = maxOutputTokens
  if (json === true) body.response_format = { type: 'json_object' }
  return body
}

export async function httpError(res) {
  const body = await res.text()
  let msg = body
  let code
  let type
  try {
    const e = JSON.parse(body).error
    msg = e?.message ?? body
    code = e?.code
    type = e?.type
  } catch {}
  msg = String(msg).slice(0, 300)
  const opt = { status: res.status, detail: msg }
  if (res.status === 401) return new LlmError('auth-expired', t(`AI 服务的 Key 无效（401）：{0}`, msg), opt)
  if (res.status === 403) return new LlmError('forbidden', t(`AI 服务拒绝访问（403）：{0}`, msg), opt)
  if (res.status === 404) return new LlmError('bad-model', t(`AI 服务找不到这个模型或地址（404）：{0}`, msg), opt)
  if (res.status === 429) {
    if (code === 'insufficient_quota' || type === 'insufficient_quota') return new LlmError('usage-limit', t(`AI 服务的额度用完了（429）：{0}`, msg), opt)
    return new LlmError('rate-limit', t(`AI 服务额度用完或太频繁（429）：{0}`, msg), { ...opt, retryable: true })
  }
  if (res.status === 400) {
    if (code === 'context_length_exceeded') return new LlmError('context-too-long', t('内容太长，超过了模型能读的长度'), opt)
    return new LlmError('bad-request', t(`AI 服务拒绝了请求（400）：{0}`, msg), opt)
  }
  if (res.status >= 500) return new LlmError('server', t(`AI 服务出错（HTTP {0}），稍后再试`, res.status), { ...opt, retryable: true })
  return new LlmError('http', t(`AI 服务出错（HTTP {0}）：{1}`, res.status, msg), opt)
}

async function post({ baseUrl, key, signal }, body) {
  const url = endpoint(baseUrl)
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    throw networkError(e, url)
  }
  if (!res.ok) throw await httpError(res)
  return res
}

// 服务不认的可选参数：400 里提到它就去掉再试一次
const OPTIONAL = [
  { keys: ['response_format'], re: /response_format|json_object|json mode/i },
  { keys: ['thinking', 'enable_thinking', 'reasoning_effort'], re: /thinking|reasoning|思考/i },
]

function unsupported(e, body) {
  if (!(e instanceof LlmError) || !(e.status >= 400 && e.status < 500) || e.status === 401) return null
  return OPTIONAL.find((o) => o.keys.some((k) => k in body) && o.re.test(e.detail ?? '')) ?? null
}

async function withParamFallback(body, run) {
  for (;;) {
    try {
      return await run(body)
    } catch (e) {
      const o = unsupported(e, body)
      if (!o) throw e
      body = Object.fromEntries(Object.entries(body).filter(([k]) => !o.keys.includes(k)))
    }
  }
}

// 只有思考、没有正文：多半是思考把输出上限用光了
function thinkingOnly() {
  return new LlmError('incomplete', t('AI 只在思考、没写出回答：换一个不思考的模型（比如 deepseek-flash），或者调大输出上限'))
}

export async function chat({ baseUrl, key, openai, model, messages, effort, signal, timeoutMs = 30_000, maxOutputTokens, json }) {
  const ctl = requestControl({ signal, timeoutMs })
  try {
    const body = buildBody({ model, messages, openai, baseUrl, effort, maxOutputTokens, json })
    return await withParamFallback(body, async (b) => {
      const res = await post({ baseUrl, key, signal: ctl.signal }, b)
      const j = await res.json()
      const m = j.choices?.[0]?.message
      const text = (m?.content ?? '').trim()
      if (!text && m?.reasoning_content) throw thinkingOnly()
      return text
    })
  } catch (e) {
    if (ctl.signal.aborted) throw ctl.signal.reason
    throw networkError(e, baseUrl)
  } finally {
    ctl.done()
  }
}

/** 流式输出，每来一段就回调 onDelta(累计全文)。 */
export async function chatStream({ baseUrl, key, openai, model, messages, effort, signal, onDelta, timeoutMs, idleMs = 90_000, maxOutputTokens, json }) {
  const ctl = requestControl({ signal, timeoutMs, idleMs })
  try {
    const body = buildBody({ model, messages, openai, baseUrl, effort, stream: true, maxOutputTokens, json })
    return await withParamFallback(body, async (b) => {
      const res = await post({ baseUrl, key, signal: ctl.signal }, b)
      let text = ''
      let thought = false
      for await (const ev of readSse(res.body)) {
        ctl.touch()
        if (ev.data === '[DONE]') break
        let j
        try {
          j = JSON.parse(ev.data)
        } catch {
          continue
        }
        if (j.error) throw new LlmError('stream', t(`AI 服务返回错误：{0}`, j.error.message ?? JSON.stringify(j.error)), { detail: j.error.message })
        const d = j.choices?.[0]?.delta
        if (d?.reasoning_content) thought = true
        if (d?.content) {
          text += d.content
          onDelta?.(text)
        }
      }
      if (!text.trim() && thought) throw thinkingOnly()
      return text
    })
  } catch (e) {
    if (ctl.signal.aborted) throw ctl.signal.reason
    throw networkError(e, baseUrl)
  } finally {
    ctl.done()
  }
}

/** 门面用：cfg = { baseUrl, key, openai }，给了 onDelta 就流式。 */
export async function compatComplete(cfg, { model, system, messages = [], effort, maxOutputTokens, json, signal, timeoutMs, onDelta }) {
  if (!cfg.key) throw new LlmError('not-logged-in', t('还没配置 AI 服务的 Key（设置 → AI 服务）'))
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages
  const args = { ...cfg, model, messages: msgs, effort, signal, maxOutputTokens, json }
  if (onDelta) return (await chatStream({ ...args, timeoutMs, onDelta })).trim()
  return chat({ ...args, timeoutMs: timeoutMs ?? 60_000 })
}

/** GET /models：服务上能用的模型名（设置页的下拉列表用），去重排好序。 */
export async function listModels({ baseUrl, key, signal, timeoutMs = 10_000 }) {
  const url = baseUrl.replace(/\/+$/, '') + '/models'
  const ctl = requestControl({ signal, timeoutMs })
  try {
    let res
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ctl.signal })
    } catch (e) {
      if (ctl.signal.aborted) throw ctl.signal.reason
      throw networkError(e, url)
    }
    if (!res.ok) throw await httpError(res)
    const j = await res.json()
    return [...new Set((j.data ?? []).map((m) => m?.id).filter((id) => typeof id === 'string' && id))].sort()
  } finally {
    ctl.done()
  }
}
