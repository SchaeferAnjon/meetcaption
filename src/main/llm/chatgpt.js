// ChatGPT 订阅通道：Codex 后端的 Responses API（SSE 流式）。
// 协议出处：openai/codex 的 codex-rs/codex-api（common.rs 的 ResponsesApiRequest、endpoint/responses.rs、
// sse/responses.rs、api_bridge.rs）和 model-provider（ChatGPT-Account-ID 头）。
// 实测：后端不接受 max_output_tokens 和 temperature（400 Unsupported parameter），输出长度在客户端截断；
// json_object 要求 input 里出现 json 字样（instructions 里的不算）；effort 可选 none/low/medium/high/xhigh/max。
import { readSse } from './sse.js'
import { LlmError, requestControl, networkError, clipToTokens, estimateTokens } from './errors.js'
import { OAUTH } from './chatgptAuth.js'
import { t } from '../i18n.js'

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const JSON_HINT = 'Respond with a single JSON object only. No code fences, no extra text.'

/* ---------------- 请求 ---------------- */

/** 统一消息格式 → Responses 的 input。图片 { type:'image', dataUrl, detail? } → input_image。 */
export function toResponsesInput(messages = []) {
  const out = []
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' || m.role === 'developer' ? 'developer' : 'user'
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
    const content = []
    for (const p of parts) {
      if (p.type === 'image') {
        if (role === 'assistant' || !p.dataUrl) continue
        content.push({ type: 'input_image', image_url: p.dataUrl, ...(p.detail ? { detail: p.detail } : {}) })
      } else if (p.text != null) {
        content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: String(p.text) })
      }
    }
    if (content.length) out.push({ type: 'message', role, content })
  }
  return out
}

export function mapEffort(effort) {
  if (!effort) return undefined
  if (effort === 'minimal') return 'none' // gpt-5.6 不支持 minimal
  return EFFORTS.has(effort) ? effort : undefined
}

export function buildResponsesBody({ model, system, messages, effort, json }) {
  const input = toResponsesInput(messages)
  if (json) input.unshift({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: JSON_HINT }] })
  const body = { model, input, store: false, stream: true }
  if (system) body.instructions = system
  const e = mapEffort(effort)
  if (e) body.reasoning = { effort: e }
  if (json) body.text = { format: { type: 'json_object' } }
  return body
}

/* ---------------- 错误翻译 ---------------- */

function parseBody(text) {
  try {
    const j = JSON.parse(text)
    if (typeof j.detail === 'string') return { message: j.detail }
    const e = j.error ?? j.detail ?? j
    return { message: e.message ?? '', type: e.type, code: e.code, resetsAt: e.resets_at, plan: e.plan_type }
  } catch {
    return { message: text.trim().slice(0, 300), html: /^\s*</.test(text) }
  }
}

/** 额度恢复时间：今天就只写时分，否则写月日。 */
export function formatReset(seconds, now = Date.now()) {
  if (!seconds) return ''
  const d = new Date(seconds * 1000)
  const n = new Date(now)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === n.toDateString() ? hm : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`
}

const QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
])

/** HTTP 非 2xx → LlmError（中文）。source='codex' 时 401 提示去终端刷新 Codex CLI。 */
export function responsesHttpError(status, bodyText, { model, source } = {}) {
  const b = parseBody(bodyText ?? '')
  const msg = b.message || `HTTP ${status}`
  const opt = { status, detail: msg }
  if (status === 401) {
    return source === 'codex'
      ? new LlmError('auth-expired', t('Codex CLI 的 token 失效了（401），在终端运行一次 codex 让它刷新'), opt)
      : new LlmError('auth-expired', t('ChatGPT 登录已失效（401），请重新登录'), opt)
  }
  if (status === 403) {
    if (b.html) return new LlmError('forbidden', t('chatgpt.com 拒绝了请求（403，可能被 Cloudflare 拦截，或网络所在地区不支持），换个网络或稍后再试'), opt)
    return new LlmError('forbidden', t(`这个 ChatGPT 账号没有权限用 Codex 接口（403）：{0}`, msg), opt)
  }
  if (status === 429) {
    if (b.type === 'usage_limit_reached') {
      const when = formatReset(b.resetsAt)
      return new LlmError('usage-limit', t(`ChatGPT 套餐的额度用完了{0}`, when ? t(`，{0} 恢复`, when) : t('，过一段时间再试')), {
        ...opt,
        resetsAt: b.resetsAt ? b.resetsAt * 1000 : undefined,
      })
    }
    if (b.type === 'usage_not_included') {
      return new LlmError('usage-not-included', t('这个 ChatGPT 套餐不包含 Codex 用量，需要 Plus、Pro、Team 等付费套餐'), opt)
    }
    if (b.type === 'insufficient_quota' || QUOTA_CODES.has(b.code)) return new LlmError('usage-limit', t('ChatGPT 额度用完了'), opt)
    return new LlmError('rate-limit', t('请求太频繁（429），稍后再试'), { ...opt, retryable: true })
  }
  if (status === 400) {
    if (/model is not supported|model_not_found|does not exist/i.test(msg)) {
      return new LlmError('bad-model', t(`ChatGPT 账号用不了模型 {0}：{1}`, model ?? '', msg), opt)
    }
    if (b.code === 'context_length_exceeded') return new LlmError('context-too-long', t('内容太长，超过了模型能读的长度'), opt)
    if (/valid image|image data/i.test(msg)) return new LlmError('bad-request', t(`图片无效：{0}`, msg), opt)
    return new LlmError('bad-request', t(`请求被拒绝（400）：{0}`, msg), opt)
  }
  if (status === 404) return new LlmError('http', t(`找不到接口或模型（404）：{0}`, msg), opt)
  if (status >= 500) return new LlmError('server', t(`ChatGPT 服务出错（HTTP {0}），稍后再试`, status), { ...opt, retryable: true })
  return new LlmError('http', t(`ChatGPT 服务出错（HTTP {0}）：{1}`, status, msg), opt)
}

/** 流里的 response.failed / error 事件 → LlmError。 */
export function responsesStreamError(err) {
  const e = err ?? {}
  const code = e.code ?? e.type
  const msg = e.message || ''
  if (code === 'context_length_exceeded') return new LlmError('context-too-long', t('内容太长，超过了模型能读的长度'), { detail: msg })
  if (QUOTA_CODES.has(code) || code === 'usage_limit_reached') return new LlmError('usage-limit', t('ChatGPT 额度用完了'), { detail: msg })
  if (code === 'usage_not_included') return new LlmError('usage-not-included', t('这个 ChatGPT 套餐不包含 Codex 用量'), { detail: msg })
  if (code === 'rate_limit_exceeded' || code === 'slow_down') {
    return new LlmError('rate-limit', t('请求太频繁，稍后再试'), { detail: msg, retryable: true })
  }
  if (code === 'server_is_overloaded') return new LlmError('overloaded', t('ChatGPT 服务繁忙，稍后再试'), { detail: msg, retryable: true })
  if (code === 'invalid_prompt' || /policy/.test(code ?? '')) {
    return new LlmError('refused', t(`请求被 ChatGPT 拒绝：{0}`, msg || code), { detail: msg })
  }
  return new LlmError('stream', t(`ChatGPT 返回失败：{0}`, msg || code || t('未知原因')), { detail: msg, retryable: true })
}

/* ---------------- 流解析 ---------------- */

export function newStreamState() {
  return { text: '', done: false, usage: null, skip: new Set(), gotDelta: new Set() }
}

/**
 * 处理一个 SSE 事件，更新 state。返回 'delta'（文本变了）、'done' 或 null；失败事件直接抛 LlmError。
 * 只收 message 里的 output_text；commentary 阶段的消息（工具调用前的旁白）跳过。
 */
export function applyResponsesEvent(state, ev) {
  let j
  try {
    j = JSON.parse(ev.data)
  } catch {
    return null
  }
  const type = j.type ?? ev.event
  switch (type) {
    case 'response.output_item.added':
      if (j.item?.type === 'message' && j.item.phase === 'commentary') state.skip.add(j.item.id)
      return null
    case 'response.output_text.delta':
      if (state.skip.has(j.item_id) || !j.delta) return null
      state.gotDelta.add(j.item_id)
      state.text += j.delta
      return 'delta'
    case 'response.output_text.done':
      // 没收到增量（例如后端直接给整段）时用 done 里的全文。
      if (state.skip.has(j.item_id) || state.gotDelta.has(j.item_id) || !j.text) return null
      state.gotDelta.add(j.item_id)
      state.text += j.text
      return 'delta'
    case 'response.completed':
      state.done = true
      state.usage = j.response?.usage ?? null
      return 'done'
    case 'response.incomplete': {
      const reason = j.response?.incomplete_details?.reason ?? 'unknown'
      if (reason === 'max_output_tokens') {
        state.done = true
        state.truncated = true
        return 'done'
      }
      throw new LlmError('incomplete', reason === 'content_filter' ? t('回答被内容过滤中断了') : t(`回答没有完整生成（{0}）`, reason))
    }
    case 'response.failed':
      throw responsesStreamError(j.response?.error)
    case 'error':
      throw responsesStreamError(j.error ?? j)
    default:
      return null
  }
}

/* ---------------- 调用 ---------------- */

/**
 * auth：ChatGPTAuth（或任何有 credentials() / forceRefresh() / mode 的对象）。
 * 其余参数同 index.js 的 complete()；model 已经是具体模型名。
 * url、fetch、idleMs 给单测和调试用。
 */
export async function chatgptComplete(auth, opts) {
  const {
    model,
    system,
    messages,
    effort,
    maxOutputTokens,
    json,
    signal,
    timeoutMs,
    onDelta,
    idleMs = 90_000,
    url = CODEX_RESPONSES_URL,
    fetch: fetchImpl = globalThis.fetch,
  } = opts
  if (!auth) throw new LlmError('not-logged-in', t('还没用 ChatGPT 账号登录（设置 → 账号与 AI）'))
  const body = JSON.stringify(buildResponsesBody({ model, system, messages, effort, json }))
  const ctl = requestControl({ signal, timeoutMs, idleMs })
  const st = newStreamState()

  const post = (creds) => {
    const headers = {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      originator: OAUTH.originator,
    }
    if (creds.accountId) headers['ChatGPT-Account-ID'] = creds.accountId
    if (creds.residency) headers['x-openai-internal-codex-residency'] = creds.residency
    return fetchImpl(url, { method: 'POST', headers, body, signal: ctl.signal })
  }

  try {
    let creds = await auth.credentials()
    let res = await post(creds)
    // 401：可能是刚好过期或被别处刷新了，自己刷新一次再试（同 Codex 的 UnauthorizedRecovery）。
    if (res.status === 401 && (await auth.forceRefresh?.(creds.accessToken))) {
      await res.body?.cancel().catch(() => {})
      creds = await auth.credentials()
      res = await post(creds)
    }
    if (!res.ok) throw responsesHttpError(res.status, await res.text(), { model, source: auth.mode })
    ctl.touch()
    for await (const ev of readSse(res.body)) {
      ctl.touch()
      const r = applyResponsesEvent(st, ev)
      if (r === 'delta') {
        if (maxOutputTokens && estimateTokens(st.text) > maxOutputTokens) {
          st.text = clipToTokens(st.text, maxOutputTokens)
          st.truncated = true
          onDelta?.(st.text)
          ctl.stop()
          break
        }
        onDelta?.(st.text)
      }
      if (st.done) break
    }
    if (!st.done && !st.truncated) {
      const e = new LlmError('stream', t('ChatGPT 的回答中途断了'), { retryable: true })
      e.partial = st.text
      throw e
    }
    return st.text.trim()
  } catch (e) {
    if (st.truncated) return st.text.trim()
    if (ctl.signal.aborted) throw ctl.signal.reason
    throw networkError(e, url)
  } finally {
    ctl.done()
  }
}
