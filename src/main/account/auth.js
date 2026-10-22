// 统一账号登录：Supabase Auth 的 Google 登录（PKCE），手写 REST，不引 SDK（流程同 GetNewWord 的 SupabaseAuth.swift）。
// 流程：/auth/v1/authorize?provider=google&code_challenge=… → 浏览器里选 Google 账号 → Supabase 回到
// meetcaption://auth-callback?code=…（开发版回到本机回环）→ POST /auth/v1/token?grant_type=pkce 换 session →
// 调 track_event 记一次「登录」。之后快过期就用 refresh_token 续期，session 存 userData/account.json。
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { callbackPage, decodeJwt, generatePkce } from '../llm/chatgptAuth.js'
import { DEEP_LINK_CALLBACK, LOOPBACK_HOST, LOOPBACK_PATH, PRODUCT, SUPABASE_ANON_KEY, SUPABASE_URL } from './config.js'
import { parseCallback } from './deeplink.js'
import { SessionFile } from './store.js'

const REFRESH_MARGIN_MS = 5 * 60_000 // 离过期不到 5 分钟就续期（access token 一般 1 小时）
const CHECK_INTERVAL_MS = 60_000 // 每分钟看一次，睡眠唤醒后也能很快补上
const LOGIN_TIMEOUT_MS = 10 * 60_000 // 第一次授权 Google 要点好几下
const REQUEST_TIMEOUT_MS = 20_000

export class AccountError extends Error {
  /** code：not-logged-in | session-expired | login-cancelled | login-timeout | login-failed | busy | network | refresh-failed | http */
  constructor(code, message, { status, retryable = false } = {}) {
    super(message)
    this.name = 'AccountError'
    this.code = code
    this.status = status
    this.retryable = retryable
  }
}

/* ---------------- 纯函数（单测覆盖） ---------------- */

/** Google 登录的授权地址。prompt=select_account 让浏览器里登着多个 Google 账号的人能选。 */
export function buildAuthorizeUrl({ baseUrl = SUPABASE_URL, redirectTo, challenge, provider = 'google' }) {
  const q = new URLSearchParams({
    provider,
    redirect_to: redirectTo,
    code_challenge: challenge,
    code_challenge_method: 's256',
    prompt: 'select_account',
  })
  return `${baseUrl}/auth/v1/authorize?${q}`
}

/** GoTrue 的 user 对象 → 界面要的几项。Google 的名字和头像在 user_metadata 里。 */
export function userInfo(u) {
  if (!u?.id) return null
  const md = u.user_metadata ?? {}
  return {
    id: u.id,
    email: u.email || md.email || null,
    name: md.full_name || md.name || null,
    avatarUrl: md.avatar_url || md.picture || null,
    provider: u.app_metadata?.provider ?? null,
  }
}

/** /auth/v1/token 的返回 → 存下来的 session。expires_at 是秒，没有就按 expires_in 算。 */
export function sessionFromTokenResponse(j, now = Date.now()) {
  if (!j?.access_token || !j?.refresh_token) return null
  const user = userInfo(j.user) ?? userInfo(jwtUser(j.access_token))
  if (!user) return null
  const expiresAt = Number.isFinite(j.expires_at) ? j.expires_at * 1000 : now + (Number(j.expires_in) || 3600) * 1000
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt, user }
}

// 返回里没有 user 时，至少从 access token 里拿到 id 和邮箱
function jwtUser(token) {
  const p = decodeJwt(token)
  return p?.sub ? { id: p.sub, email: p.email, user_metadata: p.user_metadata, app_metadata: p.app_metadata } : null
}

export function needsRefresh(session, now = Date.now(), marginMs = REFRESH_MARGIN_MS) {
  return !session || session.expiresAt - now <= marginMs
}

/** GoTrue 的错误说明：新版是 { code, error_code, msg }，老版是 { error, error_description }。 */
export function errorText(json, text = '') {
  return json?.msg || json?.error_description || json?.message || (typeof json?.error === 'string' ? json.error : '') || String(text).slice(0, 200)
}

/**
 * 续期失败要不要当成「已退出」：400、401、403 是 refresh_token 失效或被撤销（refresh_token_not_found、
 * refresh_token_already_used、session_not_found、session_expired、user_banned…），其余（断网、429、5xx）稍后再试。
 */
export function refreshFailureIsPermanent(status) {
  return status === 400 || status === 401 || status === 403 || status === 404
}

/* ---------------- 本机回环（开发版的回调） ---------------- */

function listenLoopback() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    // 端口给 0 让系统挑：Redirect URLs 里加的是 http://127.0.0.1:*/auth-callback
    server.listen(0, LOOPBACK_HOST, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

/* ---------------- AccountAuth ---------------- */

export class AccountAuth extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.file                  userData/account.json
   * @param {object} [o.safeStorage]         Windows 用它加密
   * @param {boolean} [o.encrypt]            默认只在 Windows 加密
   * @param {'deeplink'|'loopback'} [o.callback] 回调方式：打包版 deeplink，开发版 loopback
   * @param {boolean} [o.allowTokenCallback] 测试用：登录进行中时也接受 #access_token=… 形式的回调（管理接口生成的登录链接）
   * @param {string} [o.url] [o.anonKey] [o.product] [o.fetch] [o.now] 单测用
   */
  constructor({ file, safeStorage, encrypt, callback = 'deeplink', allowTokenCallback = false, url, anonKey, product, fetch: fetchImpl, now, log } = {}) {
    super()
    this.store = new SessionFile({ file, safeStorage, encrypt })
    this.callback = callback === 'loopback' ? 'loopback' : 'deeplink'
    this.allowTokenCallback = Boolean(allowTokenCallback)
    this.url = (url ?? SUPABASE_URL).replace(/\/+$/, '')
    this.anonKey = anonKey ?? SUPABASE_ANON_KEY
    this.product = product ?? PRODUCT
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a))
    this.now = now ?? (() => Date.now())
    this.log = log ?? ((...a) => console.log('[account]', ...a))
    this.session = null
    this.loaded = false
    this.lastError = null
    this.attempt = null // 进行中的登录
    this.refreshing = null
    this.gen = 0 // 退出、重新登录时加一，旧的续期结果不再写回
    this.timer = null
    this.lastEmitted = ''
    this.lastTrack = null // 最近一次 track_event 的 Promise（测试用）
  }

  /* ---------- 生命周期 ---------- */

  /** 读出保存的 session，快过期就续期，之后每分钟检查一次。 */
  start() {
    this.#current()
    this.#tick()
    if (!this.timer) {
      this.timer = setInterval(() => this.#tick(), CHECK_INTERVAL_MS)
      this.timer.unref?.()
    }
    return this
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    this.cancelLogin()
  }

  #tick() {
    const s = this.#current()
    if (s && needsRefresh(s, this.now())) this.#refresh().catch((e) => this.log(`续期没成功：${e.message}`))
  }

  /* ---------- 状态 ---------- */

  /** 给界面的状态，不含 token。 */
  status() {
    const s = this.#current()
    const u = s?.user
    return {
      off: !this.url || !this.anonKey, // 没配账号平台：不用登录
      loggedIn: Boolean(s),
      email: u?.email ?? null,
      name: u?.name ?? null,
      avatarUrl: u?.avatarUrl ?? null,
      provider: u?.provider ?? null,
      loggingIn: Boolean(this.attempt),
      loginUrl: this.attempt?.url ?? null,
      error: this.lastError ?? (s ? null : this.store.error),
    }
  }

  #emit() {
    const st = this.status()
    const key = JSON.stringify(st)
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    this.emit('status', st)
  }

  #current() {
    if (!this.loaded) {
      this.loaded = true
      this.session = this.store.load()
    }
    return this.session
  }

  #set(session) {
    this.session = session
    this.loaded = true
    this.lastError = null
    this.store.error = null
    this.store.save(session)
    this.#emit()
  }

  /* ---------- 登录 ---------- */

  /**
   * 打开浏览器走 Google 登录，等回调（深链交给 handleUrl，回环由自己的小服务器接）。
   * 成功 resolve 新的 status()；失败 reject AccountError。再次调用会取消上一次还没完成的登录。
   * openExternal 不给时不开浏览器（测试），链接在 status().loginUrl 里。
   */
  async login({ openExternal, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
    this.cancelLogin()
    const pkce = generatePkce()
    const attempt = { url: null, verifier: pkce.verifier, redirectTo: DEEP_LINK_CALLBACK, server: null, settled: false, exchanging: false }
    // 绑端口期间被取消：只做记号，绑好后检查 settled
    attempt.finish = () => {}
    attempt.cancel = () => {
      attempt.settled = true
    }
    this.attempt = attempt
    if (this.callback === 'loopback') {
      try {
        attempt.server = await listenLoopback()
      } catch (e) {
        if (this.attempt === attempt) this.attempt = null
        this.lastError = `登录要用本机端口接收浏览器回调，但没能打开：${e.code ?? e.message}`
        this.#emit()
        throw new AccountError('login-failed', this.lastError)
      }
      if (attempt.settled) {
        attempt.server.close()
        if (this.attempt === attempt) this.attempt = null
        this.#emit()
        throw new AccountError('login-cancelled', '登录已取消')
      }
      attempt.redirectTo = `http://${LOOPBACK_HOST}:${attempt.server.address().port}${LOOPBACK_PATH}`
    }
    attempt.url = buildAuthorizeUrl({ baseUrl: this.url, redirectTo: attempt.redirectTo, challenge: pkce.challenge })
    this.lastError = null
    this.#emit()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => attempt.finish(new AccountError('login-timeout', `登录超时：${Math.round(timeoutMs / 60_000) || 1} 分钟内没有在浏览器里完成登录`)),
        timeoutMs,
      )
      timer.unref?.()
      attempt.finish = (err) => {
        if (attempt.settled) return
        attempt.settled = true
        clearTimeout(timer)
        if (attempt.server) {
          const server = attempt.server
          // 监听口马上释放；刚回完页面的连接给 1 秒再关，别截断页面
          server.close()
          server.closeIdleConnections?.()
          setTimeout(() => server.closeAllConnections?.(), 1000).unref?.()
        }
        if (this.attempt === attempt) this.attempt = null
        if (err && err.code !== 'login-cancelled') this.lastError = err.message
        this.#emit()
        if (err) reject(err)
        else resolve(this.status())
      }
      attempt.cancel = () => attempt.finish(new AccountError('login-cancelled', '登录已取消'))

      if (attempt.server) attempt.server.on('request', (req, res) => this.#onLoopbackRequest(attempt, req, res))

      if (openExternal) {
        Promise.resolve()
          .then(() => openExternal(attempt.url))
          .catch(() => {
            if (attempt.settled) return
            this.lastError = '没能自动打开浏览器，请复制登录链接到浏览器里打开'
            this.#emit()
          })
      }
    })
  }

  cancelLogin() {
    this.attempt?.cancel()
  }

  /**
   * 深链回调（Mac 的 open-url，Windows 的 second-instance argv）。是登录回调就返回 true。
   * 没有进行中的登录时不处理：授权码离了这次登录的 code_verifier 换不出 session。
   */
  handleUrl(url) {
    const parsed = parseCallback(url)
    if (!parsed) return false
    const attempt = this.attempt
    if (!attempt || attempt.settled) {
      this.log('收到登录回调，但现在没有进行中的登录，忽略')
      if (!this.#current()) {
        this.lastError = '这个登录回调已经过期了，请在应用里重新点登录'
        this.#emit()
      }
      return true
    }
    this.#complete(attempt, parsed).catch(() => {})
    return true
  }

  async #onLoopbackRequest(attempt, req, res) {
    const send = (status, ok, message) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' })
      res.end(callbackPage(ok, message))
    }
    let u
    try {
      u = new URL(req.url, `http://${LOOPBACK_HOST}`)
    } catch {
      res.writeHead(400).end()
      return
    }
    if (u.pathname !== LOOPBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found')
      return
    }
    const parsed = parseCallback(`http://${LOOPBACK_HOST}${u.pathname}${u.search}`)
    try {
      const st = await this.#complete(attempt, parsed)
      send(200, true, `${st.email ? `已登录 ${st.email}。` : ''}可以关掉这个页面，回到「会议字幕」。`)
    } catch (e) {
      send(e.code === 'busy' ? 409 : 400, false, e.message)
    }
  }

  async #complete(attempt, parsed) {
    if (attempt.settled) throw new AccountError('login-cancelled', '这次登录已经结束了，请回到应用重新登录')
    if (attempt.exchanging) throw new AccountError('busy', '这个登录已经在处理了，请回到应用查看')
    if (parsed.kind === 'tokens' && !this.allowTokenCallback) {
      // 应用发起的都是 PKCE，正常不会收到直接带 token 的回调；不认，也不打断正在进行的登录
      this.log('收到不带授权码的登录回调，忽略')
      throw new AccountError('login-failed', '这个登录链接不是从应用里发起的，请在应用里点登录')
    }
    if (parsed.kind === 'error') {
      const err = new AccountError('login-failed', `登录失败：${parsed.message}`)
      attempt.finish(err)
      throw err
    }
    attempt.exchanging = true
    try {
      const session = parsed.kind === 'code' ? await this.#exchangeCode(parsed.code, attempt.verifier) : await this.#sessionFromTokens(parsed)
      if (attempt.settled) throw new AccountError('login-cancelled', '这次登录已被取消，请回到应用重新登录')
      this.gen++ // 旧 session 正在进行的续期作废
      this.#set(session)
      this.lastTrack = this.track('登录').catch((e) => this.log(`track_event 没记上：${e.message}`))
      attempt.finish(null)
      return this.status()
    } catch (e) {
      const err = e instanceof AccountError ? e : new AccountError('login-failed', `登录失败：${e.message}`)
      attempt.finish(err)
      throw err
    }
  }

  async #exchangeCode(code, verifier) {
    const r = await this.#request('/auth/v1/token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } })
    if (!r.ok) throw new AccountError('login-failed', `登录失败（HTTP ${r.status}）：${errorText(r.json, r.text)}`, { status: r.status })
    const s = sessionFromTokenResponse(r.json, this.now())
    if (!s) throw new AccountError('login-failed', '登录失败：账号服务的返回里缺少 token 或用户信息')
    return s
  }

  // 测试开关打开时：#access_token=… 形式的回调，先用 token 取一次用户，确认 token 是真的
  async #sessionFromTokens(p) {
    const r = await this.#request('/auth/v1/user', { method: 'GET', token: p.accessToken })
    if (!r.ok) throw new AccountError('login-failed', `登录失败（HTTP ${r.status}）：${errorText(r.json, r.text)}`, { status: r.status })
    const user = userInfo(r.json)
    if (!user) throw new AccountError('login-failed', '登录失败：取不到用户信息')
    const expiresAt = p.expiresAt ? p.expiresAt * 1000 : this.now() + p.expiresIn * 1000
    return { accessToken: p.accessToken, refreshToken: p.refreshToken, expiresAt, user }
  }

  /* ---------- 取 token、续期 ---------- */

  /** 有效的 access token；快过期先续期。暂时续不了（断网）但旧 token 还没真过期就先用着。 */
  async accessToken() {
    let s = this.#current()
    if (!s) throw new AccountError('not-logged-in', this.lastError ?? '还没登录')
    if (needsRefresh(s, this.now())) {
      try {
        await this.#refresh()
      } catch (e) {
        const cur = this.#current()
        if (e.code === 'session-expired' || !cur || cur.expiresAt <= this.now()) throw e
      }
      s = this.#current()
      if (!s) throw new AccountError('not-logged-in', this.lastError ?? '已退出登录')
    }
    return s.accessToken
  }

  /** 同一时间只续期一次，并发的调用共用同一个 Promise（refresh_token 用一次就换新的）。 */
  #refresh() {
    if (this.refreshing) return this.refreshing
    const gen = this.gen
    this.refreshing = (async () => {
      const rt = this.#current()?.refreshToken
      if (!rt) throw this.#loggedOut(gen, '登录信息不完整，请重新登录')
      const r = await this.#request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: rt } }).catch((e) => {
        throw new AccountError('refresh-failed', `续期登录时${e.message}`, { retryable: true })
      })
      if (!r.ok) {
        if (refreshFailureIsPermanent(r.status)) throw this.#loggedOut(gen, `登录已过期，请重新登录（${errorText(r.json, r.text)}）`)
        throw new AccountError('refresh-failed', `续期登录失败（HTTP ${r.status}），稍后再试`, { status: r.status, retryable: true })
      }
      const next = sessionFromTokenResponse(r.json, this.now())
      if (!next) throw new AccountError('refresh-failed', '续期登录失败：返回里缺少 token', { retryable: true })
      if (gen !== this.gen || !this.session) return // 续期途中退出或重新登录了
      this.#set({ ...next, user: next.user ?? this.session.user })
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  #loggedOut(gen, message) {
    if (gen === this.gen) {
      this.gen++
      this.session = null
      this.lastError = message
      this.store.clear()
      this.#emit()
    }
    return new AccountError('session-expired', message)
  }

  /* ---------- 退出 ---------- */

  /** 本机马上退出；服务端只作废这台电脑的 session（scope=local），不影响别的产品和别的设备。 */
  async logout() {
    this.cancelLogin()
    const s = this.#current()
    this.gen++
    this.session = null
    this.lastError = null
    this.store.error = null
    this.store.clear()
    this.#emit()
    if (s) {
      try {
        let token = s.accessToken
        if (needsRefresh(s, this.now(), 30_000)) {
          const r = await this.#request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refreshToken }, timeoutMs: 5_000 })
          token = r.ok ? r.json?.access_token : null
        }
        if (token) await this.#request('/auth/v1/logout?scope=local', { token, timeoutMs: 5_000 })
      } catch {}
    }
    return this.status()
  }

  /* ---------- 数据库函数 ---------- */

  /** 调 public 里的 RPC（用户自己的 token，RLS 生效）。 */
  async rpc(fn, args = {}) {
    const token = await this.accessToken()
    const r = await this.#request(`/rest/v1/rpc/${encodeURIComponent(fn)}`, { body: args, token })
    if (!r.ok) throw new AccountError('http', `${fn} 失败（HTTP ${r.status}）：${errorText(r.json, r.text)}`, { status: r.status })
    return r.json
  }

  /** 记一条事件到 analytics.events（只能记自己）。 */
  track(name, props) {
    return this.rpc('track_event', { p_product: this.product, p_name: name, ...(props ? { p_props: props } : {}) })
  }

  async #request(path, { method = 'POST', body, token, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    let res
    try {
      res = await this.fetch(`${this.url}${path}`, {
        method,
        headers: {
          apikey: this.anonKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      throw new AccountError('network', `连不上账号服务：${e.cause?.code ?? e.message}`, { retryable: true })
    }
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    return { ok: res.ok, status: res.status, json, text }
  }
}
