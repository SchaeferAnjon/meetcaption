// 两种提供方共用：错误类型、超时/取消控制、网络错误翻译、输出长度估算。

export class LlmError extends Error {
  /**
   * code：not-logged-in | auth-expired | forbidden | usage-limit | usage-not-included | rate-limit |
   *       bad-model | bad-request | context-too-long | refused | overloaded | server | network | timeout |
   *       incomplete | stream | http
   */
  constructor(code, message, { status, detail, retryable = false, resetsAt } = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.status = status
    this.detail = detail
    this.retryable = retryable
    if (resetsAt) this.resetsAt = resetsAt
  }
}

export function abortError() {
  return new DOMException('已取消', 'AbortError')
}

export function isAbort(e) {
  return e?.name === 'AbortError'
}

/**
 * 合并外部 signal、总超时和空闲超时。空闲超时每收到数据就 touch() 一次，
 * 流式长输出不会被总时长误杀；timeoutMs 不给就不限总时长。
 */
export function requestControl({ signal, timeoutMs, idleMs }) {
  const ctrl = new AbortController()
  let total
  let idle
  const fire = (err) => {
    if (!ctrl.signal.aborted) ctrl.abort(err)
  }
  if (timeoutMs) {
    total = setTimeout(() => fire(new LlmError('timeout', `AI 服务超时（${Math.round(timeoutMs / 1000)} 秒没完成）`, { retryable: true })), timeoutMs)
  }
  const touch = () => {
    if (!idleMs) return
    clearTimeout(idle)
    idle = setTimeout(() => fire(new LlmError('timeout', `AI 服务 ${Math.round(idleMs / 1000)} 秒没有响应`, { retryable: true })), idleMs)
  }
  const onAbort = () => fire(signal.reason ?? abortError())
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  touch()
  return {
    signal: ctrl.signal,
    touch,
    /** 中止本次请求但不当成错误（例如输出够长了主动截断）。 */
    stop: () => fire(abortError()),
    done() {
      clearTimeout(total)
      clearTimeout(idle)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/** fetch 自己抛的错（DNS、连接被拒、TLS、代理）翻译成中文。 */
export function networkError(e, url) {
  if (e instanceof LlmError || isAbort(e)) return e
  let host = url
  try {
    host = new URL(url).host
  } catch {}
  const cause = e?.cause
  const why = cause?.code || cause?.message || e?.message || String(e)
  return new LlmError('network', `连不上 ${host}（网络或代理问题）：${why}`, { retryable: true })
}

/** 粗估 token 数：中日韩字符每个约 1 个，其余约 4 个字符 1 个。 */
export function estimateTokens(text) {
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 按 token 上限截断文本（估算），尽量停在句末。 */
export function clipToTokens(text, max) {
  if (!max || estimateTokens(text) <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (estimateTokens(text.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  const cut = text.slice(0, lo)
  const m = cut.match(/^[\s\S]*[。！？.!?\n](?=[^。！？.!?\n]*$)/)
  return m && m[0].length > lo * 0.6 ? m[0] : cut
}
