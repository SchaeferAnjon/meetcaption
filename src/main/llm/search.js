// 问 AI 的联网搜索：DeepSeek 自家的 POST /v1/tools/search（和对话同一个 Key，每千次 0.75 美元，文档 https://api-docs.deepseek.com/guides/search ，2026-11-17 查）。
// 会员走我们服务器的 POST /v1/search（请求、返回和 DeepSeek 一样，凭据和会员 AI 同一个，请求头 X-Ask-Id 是这次提问的号，服务器按它限次）。
// 别的 AI 服务（OpenAI、ChatGPT 登录、智谱……）不搜：searchConfig 回 null，问 AI 的提示词里也不给搜索这一条。
// 不引 electron，单测直接用。
import { providerOf } from './providers.js'

const DEEPSEEK_SEARCH = 'https://api.deepseek.com/v1/tools/search'
export const SEARCH_COUNT = 6 // 够交叉核对，又不至于把提示词撑得太长（Ask Free 也取 6 条）
export const SEARCH_QUERY_MAX = 128 // 文档：query 1 到 128 个字符
const TIMEOUT = { own: 10_000, member: 15_000 } // 会员：服务器到 DeepSeek 本身 10 秒，再加一来一回

export class SearchError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'SearchError'
    this.status = status
  }
}

/** 搜索往哪发（按实际用的设置）：{ url, key, member } | null（不是 DeepSeek 或会员、没有 Key 就不搜）。 */
export function searchConfig(s) {
  const provider = s?.llmProvider
  if (provider === 'deepseek') {
    const key = s.llmKeys?.deepseek ?? ''
    return key ? { url: DEEPSEEK_SEARCH, key, member: false } : null
  }
  if (provider === 'member') {
    const key = s.llmKeys?.member ?? ''
    return key ? { url: `${providerOf('member').baseUrl}/search`, key, member: true } : null
  }
  return null
}

/** 搜索词：压成一行，最多 128 个字（按字符数，不按字节）。 */
export const searchQuery = (q) => [...String(q ?? '').replace(/\s+/g, ' ').trim()].slice(0, SEARCH_QUERY_MAX).join('')

/**
 * 搜一次。→ [{ title, url, date, summary }]（没结果是空数组）。失败、超时抛 SearchError（status 是 HTTP 状态，会员回 401 时 withMemberAuth 换凭据再试）。
 * askId：这次提问的号（会员服务器按它限每问最多几次）；signal：用户点了停止。
 */
export async function webSearch(cfg, query, { askId = '', signal, timeoutMs = cfg.member ? TIMEOUT.member : TIMEOUT.own, fetch: f = globalThis.fetch } = {}) {
  const q = searchQuery(query)
  if (!q) throw new SearchError('搜索词是空的')
  // 用普通的 setTimeout 计时：AbortSignal.timeout 的计时器不拦着进程退出（Node 22 的单测里会在等超时的时候直接收场）
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs)
  const timeout = ctrl.signal
  let res
  try {
    res = await f(cfg.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', ...(cfg.member ? { 'User-Agent': 'MeetCaption', ...(askId ? { 'X-Ask-Id': askId } : {}) } : {}) },
      body: JSON.stringify({ query: q, count: SEARCH_COUNT }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    clearTimeout(timer)
    throw new SearchError(timeout.aborted ? 'timeout' : (e.cause?.code ?? e.message))
  }
  const text = await res.text().catch(() => '')
  clearTimeout(timer)
  if (!res.ok) throw new SearchError(`HTTP ${res.status} ${text.slice(0, 200)}`, res.status)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new SearchError('返回的不是 JSON')
  }
  if (!Array.isArray(data?.results)) throw new SearchError('返回里没有 results')
  return data.results
    .filter((r) => typeof r?.url === 'string' && /^https?:\/\//.test(r.url))
    .map((r) => ({ title: String(r.title ?? '').trim(), url: r.url, date: typeof r.date === 'string' ? r.date : null, summary: String(r.summary || r.snippet || '').trim() }))
    .slice(0, SEARCH_COUNT)
}
