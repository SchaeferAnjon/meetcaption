import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  AccountAuth,
  buildAuthorizeUrl,
  errorText,
  needsRefresh,
  refreshFailureIsPermanent,
  sessionFromTokenResponse,
  userInfo,
} from '../src/main/account/auth.js'
import { findDeepLink, isAuthCallback, parseCallback } from '../src/main/account/deeplink.js'
import { SessionFile, validSession } from '../src/main/account/store.js'
import { DEEP_LINK_CALLBACK, PRODUCT, SUPABASE_ANON_KEY, SUPABASE_URL } from '../src/main/account/config.js'

const sha256url = (s) => crypto.createHash('sha256').update(s).digest('base64url')
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-account-')), 'account.json')
const quiet = () => {}

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}

const GOOGLE_USER = {
  id: 'u-1',
  email: 'friend@example.com',
  app_metadata: { provider: 'google' },
  user_metadata: { full_name: 'Friend Li', avatar_url: 'https://lh3.googleusercontent.com/a/x', email: 'friend@example.com' },
}

function tokenBody(n = 1, { expiresIn = 3600, user = GOOGLE_USER } = {}) {
  return {
    access_token: jwt({ sub: user.id, email: user.email, n }),
    refresh_token: `rt-${n}`,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user,
  }
}

/** 假的 Supabase：记录请求，按 handler 回应。 */
async function fakeSupabase(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }
    calls.push(call)
    const out = (await handler(call, calls)) ?? { status: 404, json: { msg: 'no route' } }
    if (out.status === 204) {
      res.writeHead(204).end()
      return
    }
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out.json ?? {}))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const close = () =>
    new Promise((r) => {
      server.close(r)
      server.closeAllConnections()
    })
  servers.push(close)
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close }
}

// 断言失败时也把假服务器关掉，测试进程才能退出
const servers = []
after(() => Promise.all(servers.map((c) => c())))

/** 常规路由：pkce 换 token、续期、取用户、track_event、退出。 */
function routes({ refresh, pkce } = {}) {
  let n = 1
  return (call) => {
    if (call.url === '/auth/v1/token?grant_type=pkce') return pkce ? pkce(call) : { json: tokenBody(n) }
    if (call.url === '/auth/v1/token?grant_type=refresh_token') return refresh ? refresh(call) : { json: tokenBody(++n) }
    if (call.url === '/auth/v1/user') return { json: GOOGLE_USER }
    if (call.url === '/rest/v1/rpc/track_event') return { status: 204 }
    if (call.url === '/auth/v1/logout?scope=local') return { status: 204 }
  }
}

function makeAuth(sb, o = {}) {
  return new AccountAuth({ file: o.file ?? tmpFile(), url: sb.url, anonKey: 'anon-test', encrypt: false, safeStorage: null, log: quiet, ...o })
}

const session = (o = {}) => ({
  accessToken: 'at-old',
  refreshToken: 'rt-old',
  expiresAt: Date.now() + 3600_000,
  user: userInfo(GOOGLE_USER),
  ...o,
})

function waitFor(pred, ms = 2000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv)
        resolve()
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv)
        reject(new Error('waitFor timeout'))
      }
    }, 5)
  })
}

/* ---------------- 配置和 PKCE ---------------- */

test('config: no account platform in source, only from env or build-time package.json', () => {
  assert.equal(SUPABASE_URL, process.env.MEETCAPTION_SUPABASE_URL || '')
  assert.equal(SUPABASE_ANON_KEY, process.env.MEETCAPTION_SUPABASE_ANON_KEY || '')
  assert.equal(PRODUCT, 'meetcaption')
  assert.equal(DEEP_LINK_CALLBACK, 'meetcaption://auth-callback')
})

test('config: without url or anon key the account is off and recording needs no login', () => {
  assert.equal(new AccountAuth({ file: tmpFile(), url: '', anonKey: '', encrypt: false, log: quiet }).status().off, true)
  assert.equal(new AccountAuth({ file: tmpFile(), url: 'https://x.supabase.co', anonKey: 'k', encrypt: false, log: quiet }).status().off, false)
})

test('pkce: authorize url asks google with an s256 challenge of the verifier sent at exchange', async () => {
  const u = new URL(buildAuthorizeUrl({ baseUrl: 'https://x.supabase.co', redirectTo: DEEP_LINK_CALLBACK, challenge: 'CH' }))
  assert.equal(u.origin + u.pathname, 'https://x.supabase.co/auth/v1/authorize')
  const q = Object.fromEntries(u.searchParams)
  assert.deepEqual(q, { provider: 'google', redirect_to: 'meetcaption://auth-callback', code_challenge: 'CH', code_challenge_method: 's256', prompt: 'select_account' })

  const sb = await fakeSupabase(routes())
  const auth = makeAuth(sb)
  const p = auth.login()
  const url = new URL(auth.status().loginUrl)
  const challenge = url.searchParams.get('code_challenge')
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/) // GoTrue 要 43 到 128 个字符
  assert.equal(url.searchParams.get('redirect_to'), 'meetcaption://auth-callback')
  assert.equal(auth.handleUrl('meetcaption://auth-callback?code=AUTH-CODE'), true)
  await p
  const ex = sb.calls.find((c) => c.url === '/auth/v1/token?grant_type=pkce')
  assert.equal(ex.body.auth_code, 'AUTH-CODE')
  assert.match(ex.body.code_verifier, /^[A-Za-z0-9_-]{43,128}$/)
  assert.equal(sha256url(ex.body.code_verifier), challenge)
  assert.equal(ex.headers.apikey, 'anon-test')
  assert.equal(ex.headers.authorization, undefined)

  // 每次登录都换一对新的
  const p2 = auth.login()
  assert.notEqual(new URL(auth.status().loginUrl).searchParams.get('code_challenge'), challenge)
  auth.cancelLogin()
  await assert.rejects(p2, { code: 'login-cancelled' })
  await sb.close()
})

/* ---------------- 深链解析 ---------------- */

test('deep link: find it in windows argv', () => {
  assert.equal(findDeepLink(['C:\\MeetCaption.exe', '--allow-file-access', 'meetcaption://auth-callback?code=1']), 'meetcaption://auth-callback?code=1')
  assert.equal(findDeepLink(['x.exe', '"meetcaption://auth-callback?code=2"']), 'meetcaption://auth-callback?code=2')
  assert.equal(findDeepLink(['x.exe', 'MeetCaption://auth-callback?code=3']), 'MeetCaption://auth-callback?code=3')
  assert.equal(findDeepLink(['x.exe', '--flag', 'https://example.com']), null)
  assert.equal(findDeepLink(null), null)
  assert.equal(findDeepLink(['atrium://auth-callback?code=1']), null)
})

test('deep link: which urls are login callbacks', () => {
  for (const u of [
    'meetcaption://auth-callback',
    'meetcaption://auth-callback/?code=1',
    'meetcaption:///auth-callback?code=1',
    'meetcaption:auth-callback?code=1',
    'MEETCAPTION://Auth-Callback?code=1',
    'http://127.0.0.1:53111/auth-callback?code=1',
    'http://localhost:1/auth-callback/',
  ])
    assert.equal(isAuthCallback(u), true, u)
  for (const u of [
    'meetcaption://other?code=1',
    'meetcaption://auth-callback/extra?code=1',
    'getnewword://auth-callback?code=1',
    'https://127.0.0.1/auth-callback?code=1',
    'http://evil.example/auth-callback?code=1',
    'http://127.0.0.1:1/other',
    'not a url',
  ])
    assert.equal(isAuthCallback(u), false, u)
})

test('deep link: parse code, errors and implicit tokens', () => {
  assert.deepEqual(parseCallback('meetcaption://auth-callback?code=abc-123'), { kind: 'code', code: 'abc-123' })
  const denied = parseCallback('meetcaption://auth-callback?error=access_denied&error_code=403&error_description=User+cancelled')
  assert.equal(denied.kind, 'error')
  assert.equal(denied.error, 'access_denied')
  assert.match(denied.message, /取消了授权：User cancelled/)
  // GoTrue 有时把错误放在 # 后面
  const hashErr = parseCallback('meetcaption://auth-callback#error=server_error&error_description=Unable%20to%20exchange%20external%20code')
  assert.equal(hashErr.kind, 'error')
  assert.match(hashErr.message, /server_error：Unable to exchange external code/)
  const tokens = parseCallback('meetcaption://auth-callback#access_token=AT&expires_at=1900000000&expires_in=3600&refresh_token=RT&token_type=bearer&type=magiclink')
  assert.deepEqual(tokens, { kind: 'tokens', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, expiresAt: 1900000000 })
  assert.equal(parseCallback('meetcaption://auth-callback').kind, 'error')
  assert.equal(parseCallback('meetcaption://auth-callback').error, 'missing-code')
  assert.equal(parseCallback('https://example.com/?code=1'), null)
})

/* ---------------- session 存取 ---------------- */

test('session file: 0600 json on mac, encrypted with safeStorage when asked', () => {
  const file = tmpFile()
  const f = new SessionFile({ file, encrypt: false, safeStorage: null })
  assert.equal(f.load(), null)
  assert.equal(f.error, null) // 没有文件不算错
  const s = session()
  f.save(s)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { v: 1, session: s })
  assert.deepEqual(new SessionFile({ file, encrypt: false, safeStorage: null }).load(), s)

  // Windows：safeStorage 加密，文件里看不到 token
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (t) => Buffer.from(`ENC:${Buffer.from(t).toString('base64')}`),
    decryptString: (b) => Buffer.from(b.toString().slice(4), 'base64').toString(),
  }
  const efile = tmpFile()
  new SessionFile({ file: efile, encrypt: true, safeStorage: fake }).save(s)
  const raw = fs.readFileSync(efile, 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(raw)), ['enc'])
  assert.equal(raw.includes('rt-old'), false)
  assert.deepEqual(new SessionFile({ file: efile, encrypt: true, safeStorage: fake }).load(), s)
  // 换了机器解不开：当没登录，给出原因
  const broken = new SessionFile({ file: efile, encrypt: true, safeStorage: { ...fake, decryptString: () => { throw new Error('bad') } } })
  assert.equal(broken.load(), null)
  assert.match(broken.error, /无法解密/)
  const noSafe = new SessionFile({ file: efile, encrypt: true, safeStorage: null })
  assert.equal(noSafe.load(), null)

  // 坏文件、不完整的 session
  fs.writeFileSync(file, '{oops')
  const bad = new SessionFile({ file, encrypt: false, safeStorage: null })
  assert.equal(bad.load(), null)
  assert.match(bad.error, /读不出来/)
  fs.writeFileSync(file, JSON.stringify({ v: 1, session: { accessToken: 'a' } }))
  assert.equal(bad.load(), null)
  assert.match(bad.error, /不完整/)
  assert.equal(validSession(s), true)
  assert.equal(validSession({ ...s, user: {} }), false)
  f.clear()
  assert.equal(fs.existsSync(file), false)
})

test('session: token response, user info and expiry helpers', () => {
  const now = 1_000_000
  const s = sessionFromTokenResponse({ ...tokenBody(1), expires_at: undefined, expires_in: 3600 }, now)
  assert.equal(s.expiresAt, now + 3600_000)
  assert.deepEqual(s.user, { id: 'u-1', email: 'friend@example.com', name: 'Friend Li', avatarUrl: 'https://lh3.googleusercontent.com/a/x', provider: 'google' })
  assert.equal(sessionFromTokenResponse({ ...tokenBody(1), expires_at: 1900000000 }).expiresAt, 1900000000_000)
  // 没有 user 时从 access token 里取
  const bare = sessionFromTokenResponse({ access_token: jwt({ sub: 'u-9', email: 'a@b.c', user_metadata: { name: 'A', picture: 'p.png' } }), refresh_token: 'r', expires_in: 60 }, now)
  assert.deepEqual(bare.user, { id: 'u-9', email: 'a@b.c', name: 'A', avatarUrl: 'p.png', provider: null })
  assert.equal(sessionFromTokenResponse({ access_token: 'x' }), null)

  assert.equal(needsRefresh(session({ expiresAt: now + 10 * 60_000 }), now), false)
  assert.equal(needsRefresh(session({ expiresAt: now + 5 * 60_000 }), now), true)
  assert.equal(needsRefresh(session({ expiresAt: now - 1 }), now), true)
  assert.equal(needsRefresh(null, now), true)

  for (const st of [400, 401, 403, 404]) assert.equal(refreshFailureIsPermanent(st), true)
  for (const st of [408, 429, 500, 502, 503]) assert.equal(refreshFailureIsPermanent(st), false)
  assert.equal(errorText({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }), 'Invalid Refresh Token: Refresh Token Not Found')
  assert.equal(errorText({ error: 'invalid_grant', error_description: 'expired' }), 'expired')
  assert.equal(errorText(null, 'plain'), 'plain')
})

/* ---------------- 登录 ---------------- */

test('login: deep link code → session saved, status, track_event as the user', async () => {
  const sb = await fakeSupabase(routes())
  const file = tmpFile()
  const auth = makeAuth(sb, { file })
  const events = []
  auth.on('status', (s) => events.push(s))
  assert.equal(auth.status().loggedIn, false)
  const opened = []
  const p = auth.login({ openExternal: (u) => opened.push(u) })
  assert.equal(auth.status().loggingIn, true)
  await waitFor(() => opened.length)
  assert.equal(opened[0], auth.status().loginUrl)
  auth.handleUrl('meetcaption://auth-callback?code=C1')
  const st = await p
  assert.deepEqual(st, {
    off: false,
    loggedIn: true,
    email: 'friend@example.com',
    name: 'Friend Li',
    avatarUrl: 'https://lh3.googleusercontent.com/a/x',
    provider: 'google',
    loggingIn: false,
    loginUrl: null,
    error: null,
  })
  await auth.lastTrack
  const track = sb.calls.find((c) => c.url === '/rest/v1/rpc/track_event')
  assert.deepEqual(track.body, { p_product: 'meetcaption', p_name: '登录' })
  assert.equal(track.headers.authorization, `Bearer ${tokenBody(1).access_token}`)
  assert.equal(track.headers.apikey, 'anon-test')
  // 存盘，新实例读得出来；状态里没有 token
  const again = makeAuth(sb, { file })
  assert.equal(again.status().loggedIn, true)
  assert.equal(JSON.stringify(again.status()).includes('rt-1'), false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).session.refreshToken, 'rt-1')
  assert.ok(events.some((e) => e.loggingIn) && events.at(-1).loggedIn)
  await sb.close()
})

test('login: provider error, bad code and stray callbacks', async () => {
  const sb = await fakeSupabase(
    routes({ pkce: (c) => (c.body.auth_code === 'bad' ? { status: 404, json: { code: 404, error_code: 'flow_state_not_found', msg: 'invalid flow state, no valid flow state found' } } : { json: tokenBody(1) }) }),
  )
  const auth = makeAuth(sb)
  // 用户在 Google 那边取消
  let p = auth.login()
  auth.handleUrl('meetcaption://auth-callback?error=access_denied&error_description=cancelled')
  await assert.rejects(p, (e) => e.code === 'login-failed' && /取消了授权/.test(e.message))
  assert.match(auth.status().error, /取消了授权/)
  // 授权码对不上（比如是别的登录的）
  p = auth.login()
  auth.handleUrl('meetcaption://auth-callback?code=bad')
  await assert.rejects(p, (e) => /HTTP 404.*flow state/.test(e.message))
  // 没在登录时收到回调：认得是回调，但不换 token
  const before = sb.calls.length
  assert.equal(auth.handleUrl('meetcaption://auth-callback?code=late'), true)
  assert.equal(sb.calls.length, before)
  assert.match(auth.status().error, /过期/)
  assert.equal(auth.handleUrl('https://example.com'), false)
  await sb.close()
})

test('login: token-style callback only in test mode, and never interrupts a pending login', async () => {
  const sb = await fakeSupabase(routes())
  const strict = makeAuth(sb)
  const p = strict.login()
  strict.handleUrl('meetcaption://auth-callback#access_token=AT&refresh_token=RT&expires_in=3600')
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(strict.status().loggingIn, true) // 还在等真正的授权码
  assert.equal(sb.calls.some((c) => c.url === '/auth/v1/user'), false)
  strict.handleUrl('meetcaption://auth-callback?code=C')
  assert.equal((await p).loggedIn, true)

  const testMode = makeAuth(sb, { allowTokenCallback: true })
  const q = testMode.login()
  testMode.handleUrl('meetcaption://auth-callback#access_token=AT2&refresh_token=RT2&expires_in=3600&type=magiclink')
  const st = await q
  assert.equal(st.email, 'friend@example.com')
  const who = sb.calls.find((c) => c.url === '/auth/v1/user')
  assert.equal(who.headers.authorization, 'Bearer AT2')
  await sb.close()
})

test('login: a new login cancels the old one; timeout; cancelLogin', async () => {
  const sb = await fakeSupabase(routes())
  const auth = makeAuth(sb)
  const first = auth.login()
  const second = auth.login()
  await assert.rejects(first, { code: 'login-cancelled' })
  assert.equal(auth.status().error, null) // 取消不算错误
  auth.cancelLogin()
  await assert.rejects(second, { code: 'login-cancelled' })
  assert.equal(auth.status().loggingIn, false)
  await assert.rejects(auth.login({ timeoutMs: 30 }), (e) => e.code === 'login-timeout' && /登录超时/.test(e.message))
  assert.match(auth.status().error, /登录超时/)
  await sb.close()
})

test('login: loopback callback for the dev build', async () => {
  const sb = await fakeSupabase(routes())
  const auth = makeAuth(sb, { callback: 'loopback' })
  const p = auth.login()
  await waitFor(() => auth.status().loginUrl)
  const redirect = new URL(auth.status().loginUrl).searchParams.get('redirect_to')
  assert.match(redirect, /^http:\/\/127\.0\.0\.1:\d+\/auth-callback$/)
  const other = await fetch(redirect.replace('/auth-callback', '/favicon.ico'))
  assert.equal(other.status, 404)
  const page = await fetch(`${redirect}?code=LOOP`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /登录成功[\s\S]*已登录 friend@example\.com/)
  assert.equal((await p).loggedIn, true)
  assert.equal(sb.calls.find((c) => c.url === '/auth/v1/token?grant_type=pkce').body.auth_code, 'LOOP')
  // 回调口已经关了
  await assert.rejects(fetch(`${redirect}?code=again`))
  await sb.close()
})

/* ---------------- 过期和续期 ---------------- */

test('refresh: expired session on disk refreshes once for concurrent callers and rotates the refresh token', async () => {
  let refreshes = 0
  const sb = await fakeSupabase(
    routes({
      refresh: async (c) => {
        refreshes++
        assert.equal(c.body.refresh_token, 'rt-old')
        await new Promise((r) => setTimeout(r, 30))
        return { json: tokenBody(7) }
      },
    }),
  )
  const file = tmpFile()
  new SessionFile({ file, encrypt: false, safeStorage: null }).save(session({ expiresAt: Date.now() - 1000 }))
  const auth = makeAuth(sb, { file })
  assert.equal(auth.status().loggedIn, true) // access 过期但有 refresh_token，仍算已登录
  const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()])
  assert.equal(refreshes, 1)
  assert.equal(a, tokenBody(7).access_token)
  assert.equal(b, a)
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).session
  assert.equal(saved.refreshToken, 'rt-7')
  assert.ok(saved.expiresAt > Date.now() + 3000_000)
  // 还新鲜就不续期
  await auth.accessToken()
  assert.equal(refreshes, 1)
  await sb.close()
})

test('refresh: start() renews a session about to expire', async () => {
  const sb = await fakeSupabase(routes())
  const file = tmpFile()
  new SessionFile({ file, encrypt: false, safeStorage: null }).save(session({ expiresAt: Date.now() + 60_000 }))
  const auth = makeAuth(sb, { file }).start()
  await waitFor(() => JSON.parse(fs.readFileSync(file, 'utf8')).session.refreshToken === 'rt-2')
  auth.stop()
  await sb.close()
})

test('refresh: revoked refresh token logs out; network trouble keeps the session', async () => {
  let mode = 'down'
  const sb = await fakeSupabase(
    routes({
      refresh: () =>
        mode === 'down'
          ? { status: 503, json: { msg: 'upstream' } }
          : { status: 400, json: { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' } },
    }),
  )
  const file = tmpFile()
  // 快过期但还没过期：服务暂时不可用时旧 token 照用
  new SessionFile({ file, encrypt: false, safeStorage: null }).save(session({ expiresAt: Date.now() + 60_000 }))
  const auth = makeAuth(sb, { file })
  assert.equal(await auth.accessToken(), 'at-old')
  assert.equal(auth.status().loggedIn, true)
  // 真过期了又续不了：报错，但不退出
  new SessionFile({ file, encrypt: false, safeStorage: null }).save(session({ expiresAt: Date.now() - 1 }))
  const auth2 = makeAuth(sb, { file })
  await assert.rejects(auth2.accessToken(), { code: 'refresh-failed' })
  assert.equal(auth2.status().loggedIn, true)
  // refresh_token 被撤销：退出，删文件，告诉用户
  mode = 'revoked'
  const events = []
  auth2.on('status', (s) => events.push(s))
  await assert.rejects(auth2.accessToken(), { code: 'session-expired' })
  assert.equal(auth2.status().loggedIn, false)
  assert.match(auth2.status().error, /登录已过期，请重新登录/)
  assert.equal(fs.existsSync(file), false)
  assert.equal(events.at(-1).loggedIn, false)
  await assert.rejects(auth2.accessToken(), { code: 'not-logged-in' })
  await sb.close()
})

/* ---------------- 退出 ---------------- */

test('logout: local scope with the user token, file removed', async () => {
  const sb = await fakeSupabase(routes())
  const file = tmpFile()
  new SessionFile({ file, encrypt: false, safeStorage: null }).save(session())
  const auth = makeAuth(sb, { file })
  const st = await auth.logout()
  assert.equal(st.loggedIn, false)
  assert.equal(st.error, null)
  assert.equal(fs.existsSync(file), false)
  const out = sb.calls.find((c) => c.url === '/auth/v1/logout?scope=local')
  assert.equal(out.headers.authorization, 'Bearer at-old') // 只退这台电脑，不影响别的产品和设备

  // access 已过期：先续期拿到能用的 token 再退出
  new SessionFile({ file, encrypt: false, safeStorage: null }).save(session({ expiresAt: Date.now() - 1 }))
  const auth2 = makeAuth(sb, { file })
  await auth2.logout()
  const last = sb.calls.filter((c) => c.url === '/auth/v1/logout?scope=local').at(-1)
  assert.equal(last.headers.authorization, `Bearer ${tokenBody(2).access_token}`)

  // 服务端连不上也照样本机退出
  const offline = makeAuth({ url: 'http://127.0.0.1:1' }, { file: tmpFile() })
  offline.store.save(session())
  offline.loaded = false
  assert.equal((await offline.logout()).loggedIn, false)
  await sb.close()
})
