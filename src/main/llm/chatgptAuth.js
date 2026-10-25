// 用 ChatGPT 账号登录（和 Codex CLI 同一套 OAuth + PKCE），token 存 userData/chatgpt-auth.json。
// 常量出处：openai/codex 的 codex-rs/login（server.rs、auth/manager.rs、oauth/*.rs、token_data.rs）。
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { LlmError } from './errors.js'
import { t } from '../i18n.js'

export const OAUTH = {
  issuer: 'https://auth.openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  // Codex 还多要 api.connectors.*，我们只调 Responses，用不到。
  scope: 'openid profile email offline_access',
  originator: 'codex_cli_rs',
  // 回调地址在 OpenAI 那边有白名单：1455 是默认，1457 是 Codex 的备用端口。
  ports: [1455, 1457],
  callbackPath: '/auth/callback',
}

const AUTH_CLAIM = 'https://api.openai.com/auth'
const PROFILE_CLAIM = 'https://api.openai.com/profile'
const REFRESH_WINDOW_MS = 10 * 60_000 // 离过期不到 10 分钟就刷新（Codex 是 5 分钟）
const REFRESH_INTERVAL_MS = 8 * 86_400_000 // token 里没有 exp 时，8 天刷一次（同 Codex）
const LOGIN_TIMEOUT_MS = 5 * 60_000

const PLAN_LABELS = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
}

/* ---------------- 纯函数（单测覆盖） ---------------- */

export function base64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

export function pkceChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest())
}

/** PKCE S256：64 字节随机数做 verifier（86 个字符），challenge = base64url(sha256(verifier))。 */
export function generatePkce() {
  const verifier = base64url(crypto.randomBytes(64))
  return { verifier, challenge: pkceChallenge(verifier) }
}

export function generateState() {
  return base64url(crypto.randomBytes(32))
}

export function buildAuthorizeUrl({ issuer = OAUTH.issuer, redirectUri, challenge, state }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: OAUTH.scope,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: OAUTH.originator,
  })
  return `${issuer}/oauth/authorize?${q}`
}

export function decodeJwt(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/** access token 的过期时刻（毫秒），读不出来返回 null。 */
export function tokenExpiresAt(token) {
  const exp = decodeJwt(token)?.exp
  return Number.isFinite(exp) ? exp * 1000 : null
}

export function isExpired(token, now = Date.now()) {
  const at = tokenExpiresAt(token)
  return at != null && at <= now
}

/** 快过期（或太久没刷新）就该刷新了。 */
export function needsRefresh({ accessToken, lastRefresh }, now = Date.now(), windowMs = REFRESH_WINDOW_MS) {
  if (!accessToken) return true
  const at = tokenExpiresAt(accessToken)
  if (at != null) return at - now <= windowMs
  return !lastRefresh || now - lastRefresh > REFRESH_INTERVAL_MS
}

export function planLabel(raw) {
  if (!raw) return ''
  return PLAN_LABELS[raw] ?? raw.replace(/(^|_)([a-z])/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase())
}

/** 从 id_token / access_token 里取账号信息；account_id 的位置同 Codex（https://api.openai.com/auth.chatgpt_account_id）。 */
export function accountInfo({ idToken, accessToken }) {
  const id = decodeJwt(idToken) ?? {}
  const access = decodeJwt(accessToken) ?? {}
  const idAuth = id[AUTH_CLAIM] ?? {}
  const accessAuth = access[AUTH_CLAIM] ?? {}
  const accountId =
    idAuth.chatgpt_account_id ?? accessAuth.chatgpt_account_id ?? id.chatgpt_account_id ?? id.organizations?.[0]?.id ?? null
  const plan = idAuth.chatgpt_plan_type ?? accessAuth.chatgpt_plan_type ?? null
  const email = id.email ?? id[PROFILE_CLAIM]?.email ?? access[PROFILE_CLAIM]?.email ?? null
  const residency = accessAuth.chatgpt_compute_residency ?? idAuth.chatgpt_compute_residency ?? null
  return {
    accountId,
    email,
    plan,
    planLabel: planLabel(plan),
    residency: residency && residency !== 'no_constraint' ? residency : null,
  }
}

/** 校验浏览器回调的参数：先比 state，再看有没有 error，最后要 code。 */
export function checkCallback(params, expectedState) {
  if (!params.state || params.state !== expectedState) {
    return { kind: 'state-mismatch', message: t('回调里的 state 对不上，可能是旧的登录页面，请回到应用重新点登录') }
  }
  if (params.error) {
    const desc = params.error_description ? `：${params.error_description}` : ''
    const message =
      params.error === 'access_denied' ? `你取消了授权，或者这个账号不能用于 Codex${desc}` : `OpenAI 返回错误 ${params.error}${desc}`
    return { kind: 'provider', message }
  }
  if (!params.code) return { kind: 'missing-code', message: t('回调里没有授权码，登录没能完成') }
  return { kind: 'ok', code: params.code }
}

/** 刷新失败是否要当成「已退出」：401、invalid_grant、refresh_token_* 这几类是永久的（同 Codex 的判断）。 */
export function classifyRefreshFailure(status, bodyText) {
  let code = ''
  try {
    const j = JSON.parse(bodyText)
    const e = j.error
    code = (typeof e === 'string' ? e : e?.code ?? e?.type) ?? j.code ?? ''
  } catch {}
  code = String(code).toLowerCase()
  const reasons = {
    refresh_token_expired: 'ChatGPT 登录已过期，请重新登录',
    refresh_token_reused: 'ChatGPT 登录已在别处刷新失效，请重新登录',
    refresh_token_invalidated: 'ChatGPT 登录已被撤销，请重新登录',
  }
  if (reasons[code]) return { permanent: true, message: reasons[code] }
  if (status === 401 || (status === 400 && code === 'invalid_grant')) {
    return { permanent: true, message: t('ChatGPT 登录已失效，请重新登录') }
  }
  return { permanent: false, message: t(`刷新 ChatGPT 登录失败（HTTP {0}），稍后会再试`, status) }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

export function callbackPage(ok, message) {
  const title = ok ? '登录成功' : '登录没有完成'
  const color = ok ? '#1a7f37' : '#cf222e'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>会议字幕 · ${title}</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:12px;padding:32px 40px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:440px}
h1{font-size:20px;margin:0 0 12px;color:${color}}p{font-size:15px;line-height:1.6;color:#333;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${escapeHtml(message)}</p></div></body></html>`
}

/* ---------------- 本地回调服务 ---------------- */

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    const onError = (e) => reject(e)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve(server)
    })
  })
}

async function listenFirst(ports) {
  for (const port of ports) {
    try {
      const server = await listenOn(port)
      return { server, port: server.address().port }
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e
    }
  }
  throw new LlmError(
    'port-in-use',
    t(`登录要用本机 {0} 端口接收浏览器回调，但端口被占用了。常见原因是 Codex CLI 或 OpenCode 正在登录，关掉它们再试。`, ports.join(t(' 或 '))),
  )
}

function defaultSafeStorage() {
  if (process.platform !== 'win32' || !process.versions.electron) return null
  try {
    return createRequire(import.meta.url)('electron').safeStorage ?? null
  } catch {
    return null
  }
}

function codexAuthPath() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(home, 'auth.json')
}

/* ---------------- ChatGPTAuth ---------------- */

export class ChatGPTAuth extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.file         userData/chatgpt-auth.json
   * @param {object} [o.safeStorage] Electron 的 safeStorage；Windows 用它加密，Mac 不用
   * @param {'app'|'codex'} [o.mode] 默认看 MEETCAPTION_CHATGPT_AUTH=codex（只读 ~/.codex/auth.json，开发自测用）
   * @param {boolean} [o.encrypt] 默认只在 Windows 加密
   * @param {string} [o.issuer] [o.ports] [o.fetch] [o.codexAuthFile] 单测用
   */
  constructor({ file, safeStorage, mode, encrypt, issuer, ports, fetch: fetchImpl, codexAuthFile } = {}) {
    super()
    this.file = file
    this.mode = mode ?? (process.env.MEETCAPTION_CHATGPT_AUTH === 'codex' ? 'codex' : 'app')
    this.issuer = issuer ?? OAUTH.issuer
    this.ports = ports ?? OAUTH.ports
    this.codexAuthFile = codexAuthFile ?? codexAuthPath()
    this.safeStorage = safeStorage === undefined ? defaultSafeStorage() : safeStorage
    this.encrypt = encrypt ?? process.platform === 'win32'
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a))
    this.data = null // { tokens: { id_token, access_token, refresh_token }, lastRefresh }
    this.loaded = false
    this.lastError = null
    this.login_ = null // 进行中的登录 { url, cancel, closed }
    this.refreshing = null
    this.gen = 0 // 退出或重新登录时加一，防止旧的刷新结果把状态写回去
  }

  /* ---------- 状态 ---------- */

  status() {
    const base = {
      source: this.mode,
      loggingIn: !!this.login_,
      loginUrl: this.login_?.url ?? null,
      error: this.lastError,
    }
    const d = this.mode === 'codex' ? this.#readCodex() : this.#current()
    if (!d) return { ...base, loggedIn: false }
    const info = accountInfo({ idToken: d.tokens.id_token, accessToken: d.tokens.access_token })
    const expiresAt = tokenExpiresAt(d.tokens.access_token)
    // 应用自己的登录：access 过期了但还有 refresh_token，下次用时会刷新，仍算已登录。
    const loggedIn = this.mode === 'codex' ? !isExpired(d.tokens.access_token) : true
    return {
      ...base,
      loggedIn,
      email: info.email,
      plan: info.plan,
      planLabel: info.planLabel,
      accountId: d.accountId ?? info.accountId,
      expiresAt,
      error: loggedIn ? base.error : base.error ?? t('Codex CLI 的登录已过期，在终端运行一次 codex 让它刷新'),
    }
  }

  #emit() {
    this.emit('status', this.status())
  }

  /* ---------- 登录 ---------- */

  /**
   * 打开浏览器走 OAuth，等本地回调。返回登录后的 status()。
   * 再次调用会取消上一次还没完成的登录。
   */
  async login({ openExternal, timeoutMs = LOGIN_TIMEOUT_MS, signal } = {}) {
    if (this.mode === 'codex') {
      throw new LlmError('codex-mode', t('现在用的是 Codex CLI 的登录（MEETCAPTION_CHATGPT_AUTH=codex），不能在应用里登录'))
    }
    // 先占位：登录还在绑端口时调用 cancelLogin() 也能取消。
    const attempt = { url: null, cancelled: false, closed: Promise.resolve() }
    attempt.cancel = () => {
      attempt.cancelled = true
    }
    const prev = this.login_
    this.login_ = attempt
    const cancelled = () => {
      if (this.login_ === attempt) this.login_ = null
      this.#emit()
      return new LlmError('login-cancelled', t('登录已取消'))
    }
    if (prev) {
      prev.cancel()
      await prev.closed
    }
    if (attempt.cancelled || signal?.aborted) throw cancelled()
    const pkce = generatePkce()
    const state = generateState()
    let server, port
    try {
      ;({ server, port } = await listenFirst(this.ports))
    } catch (e) {
      if (this.login_ === attempt) this.login_ = null
      this.lastError = e.message
      this.#emit()
      throw e
    }
    if (attempt.cancelled || signal?.aborted) {
      server.close()
      throw cancelled()
    }
    const redirectUri = `http://localhost:${port}${OAUTH.callbackPath}`
    attempt.url = buildAuthorizeUrl({ issuer: this.issuer, redirectUri, challenge: pkce.challenge, state })
    let resolveClosed
    attempt.closed = new Promise((r) => (resolveClosed = r))
    this.lastError = null
    this.#emit()

    return new Promise((resolve, reject) => {
      let settled = false
      let exchanging = false
      const finish = (err, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', attempt.cancel)
        // 监听口马上释放；已连着的（刚回完页面的、浏览器 keep-alive 的）给 1 秒再强关，别截断页面。
        server.close(() => resolveClosed())
        server.closeIdleConnections?.()
        setTimeout(() => server.closeAllConnections?.(), 1000).unref?.()
        if (this.login_ === attempt) this.login_ = null
        if (err && err.code !== 'login-cancelled') this.lastError = err.message
        this.#emit()
        if (err) reject(err)
        else resolve(value)
      }
      const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} 分钟` : `${Math.ceil(timeoutMs / 1000)} 秒`
      const timer = setTimeout(() => finish(new LlmError('login-timeout', t(`登录超时：{0}内没有在浏览器里完成登录`, limit))), timeoutMs)
      attempt.cancel = () => finish(new LlmError('login-cancelled', t('登录已取消')))
      signal?.addEventListener('abort', attempt.cancel, { once: true })

      const send = (res, status, ok, message) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' })
        res.end(callbackPage(ok, message))
      }

      server.on('request', async (req, res) => {
        let u
        try {
          u = new URL(req.url, `http://localhost:${port}`)
        } catch {
          res.writeHead(400).end()
          return
        }
        if (u.pathname !== OAUTH.callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found')
          return
        }
        const check = checkCallback(Object.fromEntries(u.searchParams), state)
        // state 对不上多半是旧标签页，不结束这次登录，继续等正确的回调。
        if (check.kind === 'state-mismatch') return send(res, 400, false, check.message)
        if (check.kind !== 'ok') {
          send(res, 400, false, check.message)
          return finish(new LlmError('login-failed', t(`登录失败：{0}`, check.message)))
        }
        if (exchanging || settled) return send(res, 409, false, '这个登录已经在处理了，请回到应用查看')
        exchanging = true
        try {
          const tokens = await this.#exchangeCode(check.code, redirectUri, pkce.verifier)
          if (settled) return send(res, 409, false, '这次登录已被取消，请回到应用重新登录')
          this.gen++ // 旧 token 正在进行的刷新作废
          this.#setTokens(tokens)
          const who = this.status()
          const name = [who.email, who.planLabel].filter(Boolean).join('，')
          send(res, 200, true, `${name ? `已登录 ${name}。` : ''}可以关掉这个页面，回到「会议字幕」。`)
          finish(null, who)
        } catch (e) {
          send(res, 500, false, e.message)
          finish(e instanceof LlmError ? e : new LlmError('login-failed', t(`登录失败：{0}`, e.message)))
        }
      })

      Promise.resolve()
        .then(() => (openExternal ? openExternal(attempt.url) : null))
        .catch(() => {
          // 浏览器没打开：status().loginUrl 里有链接，界面可以让用户手动打开。
          if (settled) return
          this.lastError = '没能自动打开浏览器，请手动复制登录链接到浏览器打开'
          this.#emit()
        })
    })
  }

  cancelLogin() {
    this.login_?.cancel()
  }

  async #exchangeCode(code, redirectUri, verifier) {
    let res
    try {
      res = await this.fetch(`${this.issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: OAUTH.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (e) {
      throw new LlmError('login-failed', t(`换取 token 时连不上 auth.openai.com：{0}`, e.cause?.code ?? e.message))
    }
    const text = await res.text()
    if (!res.ok) {
      let why = text.slice(0, 200)
      try {
        const j = JSON.parse(text)
        why = j.error_description ?? j.error?.message ?? j.error ?? why
      } catch {}
      throw new LlmError('login-failed', t(`换取 token 失败（HTTP {0}）：{1}`, res.status, why))
    }
    const j = JSON.parse(text)
    if (!j.access_token || !j.refresh_token) throw new LlmError('login-failed', t('换取 token 失败：返回里缺少 access_token 或 refresh_token'))
    return j
  }

  /* ---------- 退出 ---------- */

  async logout() {
    if (this.mode === 'codex') {
      throw new LlmError('codex-mode', t('现在用的是 Codex CLI 的登录（MEETCAPTION_CHATGPT_AUTH=codex），不能在应用里退出'))
    }
    this.cancelLogin()
    const rt = this.#current()?.tokens.refresh_token
    this.gen++
    this.data = null
    this.lastError = null
    try {
      fs.rmSync(this.file, { force: true })
    } catch {}
    this.#emit()
    // 同 Codex：顺手在服务端作废 refresh_token，失败不影响本地退出。
    if (rt) {
      await this.fetch(`${this.issuer}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: rt, token_type_hint: 'refresh_token', client_id: OAUTH.clientId }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {})
    }
  }

  /* ---------- 取 token ---------- */

  async getAccessToken() {
    return (await this.credentials()).accessToken
  }

  /** 请求 Codex 后端要用的全部凭据：{ accessToken, accountId, residency }。快过期会先刷新。 */
  async credentials() {
    if (this.mode === 'codex') {
      const d = this.#readCodex()
      if (!d) throw new LlmError('not-logged-in', t('没读到 ~/.codex/auth.json 里的 ChatGPT 登录（先在终端运行 codex login）'))
      if (isExpired(d.tokens.access_token)) {
        throw new LlmError('auth-expired', t('Codex CLI 的登录已过期，在终端运行一次 codex 让它刷新'))
      }
      return this.#creds(d)
    }
    let d = this.#current()
    if (!d) throw new LlmError('not-logged-in', this.lastError ?? t('还没用 ChatGPT 账号登录（设置 → AI 服务）'))
    if (needsRefresh({ accessToken: d.tokens.access_token, lastRefresh: d.lastRefresh })) {
      try {
        await this.#refresh()
      } catch (e) {
        // 暂时刷不了（断网、服务端 5xx），旧 token 还没真过期就先用着。
        if (e.code === 'auth-expired' || !this.#current() || isExpired(this.#current().tokens.access_token)) throw e
      }
      d = this.#current()
      if (!d) throw new LlmError('not-logged-in', this.lastError ?? t('已退出 ChatGPT 账号'))
    }
    return this.#creds(d)
  }

  /**
   * 后端回了 401 时调用：usedToken 是那次请求用的 token。
   * 别的请求已经刷新过就直接返回 true；否则强制刷新一次。刷新不了返回 false。
   */
  async forceRefresh(usedToken) {
    if (this.mode === 'codex') return false
    const d = this.#current()
    if (!d) return false
    if (usedToken && d.tokens.access_token !== usedToken) return true
    try {
      await this.#refresh()
      return true
    } catch {
      return false
    }
  }

  #creds(d) {
    const info = accountInfo({ idToken: d.tokens.id_token, accessToken: d.tokens.access_token })
    return { accessToken: d.tokens.access_token, accountId: d.accountId ?? info.accountId, residency: info.residency }
  }

  /** 同一时间只刷新一次，并发的调用共用同一个 Promise。 */
  #refresh() {
    if (this.refreshing) return this.refreshing
    const gen = this.gen
    this.refreshing = (async () => {
      const rt = this.#current()?.tokens.refresh_token
      if (!rt) throw this.#loggedOut(gen, 'ChatGPT 登录信息不完整，请重新登录')
      let res
      try {
        res = await this.fetch(`${this.issuer}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: OAUTH.clientId, grant_type: 'refresh_token', refresh_token: rt }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch (e) {
        throw new LlmError('refresh-failed', t(`刷新 ChatGPT 登录时连不上 auth.openai.com：{0}`, e.cause?.code ?? e.message), { retryable: true })
      }
      const text = await res.text()
      if (!res.ok) {
        const f = classifyRefreshFailure(res.status, text)
        if (f.permanent) throw this.#loggedOut(gen, f.message)
        throw new LlmError('refresh-failed', f.message, { status: res.status, retryable: true })
      }
      let j
      try {
        j = JSON.parse(text)
      } catch {
        throw new LlmError('refresh-failed', t('刷新 ChatGPT 登录失败：返回的不是 JSON'), { retryable: true })
      }
      if (gen !== this.gen || !this.data) return // 刷新途中退出或重新登录了
      const tokens = { ...this.data.tokens }
      for (const k of ['id_token', 'access_token', 'refresh_token']) if (j[k]) tokens[k] = j[k]
      this.#setTokens(tokens)
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  #loggedOut(gen, message) {
    if (gen === this.gen) {
      this.gen++
      this.data = null
      this.lastError = message
      try {
        fs.rmSync(this.file, { force: true })
      } catch {}
      this.#emit()
    }
    return new LlmError('auth-expired', message)
  }

  #setTokens(tokens) {
    const info = accountInfo({ idToken: tokens.id_token, accessToken: tokens.access_token })
    this.data = {
      tokens: { id_token: tokens.id_token ?? '', access_token: tokens.access_token, refresh_token: tokens.refresh_token },
      accountId: info.accountId,
      lastRefresh: Date.now(),
    }
    this.lastError = null
    this.#save()
    this.#emit()
  }

  /* ---------- 存储 ---------- */

  #canEncrypt() {
    if (!this.encrypt || !this.safeStorage) return false
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  #current() {
    if (!this.loaded) {
      this.loaded = true
      this.data = this.#load()
    }
    return this.data?.tokens?.access_token ? this.data : null
  }

  #load() {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
    if (typeof raw?.enc === 'string') {
      try {
        if (!this.#canEncrypt()) throw new Error('safeStorage unavailable')
        raw = JSON.parse(this.safeStorage.decryptString(Buffer.from(raw.enc, 'base64')))
      } catch {
        this.lastError = '保存的 ChatGPT 登录信息无法解密，请重新登录'
        return null
      }
    }
    return raw?.tokens?.access_token ? raw : null
  }

  #save() {
    const json = JSON.stringify({ v: 1, ...this.data }, null, 2)
    const out = this.#canEncrypt() ? JSON.stringify({ enc: this.safeStorage.encryptString(json).toString('base64') }) : json
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, out, { mode: 0o600 })
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, this.file)
  }

  /** 开发自测：只读 Codex CLI 的 auth.json，从不刷新、从不写回。 */
  #readCodex() {
    try {
      const j = JSON.parse(fs.readFileSync(this.codexAuthFile, 'utf8'))
      const t = j.tokens
      if (!t?.access_token) return null
      return { tokens: { id_token: t.id_token ?? '', access_token: t.access_token }, accountId: t.account_id ?? null }
    } catch {
      return null
    }
  }
}
