import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  ChatGPTAuth,
  OAUTH,
  generatePkce,
  pkceChallenge,
  generateState,
  buildAuthorizeUrl,
  decodeJwt,
  tokenExpiresAt,
  isExpired,
  needsRefresh,
  accountInfo,
  checkCallback,
  classifyRefreshFailure,
  planLabel,
} from '../src/main/llm/chatgptAuth.js'

const AUTH = 'https://api.openai.com/auth'

function jwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${enc({ alg: 'none' })}.${enc(payload)}.sig`
}
const nowS = () => Math.floor(Date.now() / 1000)
function tokens({ expIn = 3600, account = 'acc-1', n = 1 } = {}) {
  return {
    id_token: jwt({ email: 'me@example.com', [AUTH]: { chatgpt_account_id: account, chatgpt_plan_type: 'plus' } }),
    access_token: jwt({ exp: nowS() + expIn, n, [AUTH]: { chatgpt_account_id: account, chatgpt_compute_residency: 'no_constraint' } }),
    refresh_token: `rt-${n}`,
  }
}
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-llm-'))
}

/** 假的 auth.openai.com：记录收到的请求，按 handler 回应。 */
async function fakeIssuer(handler) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const call = { method: req.method, url: req.url, type: req.headers['content-type'], body }
    calls.push(call)
    const out = await handler(call, calls)
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out.json ?? {}))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) }
}

/* ---------------- 纯函数 ---------------- */

test('pkce: RFC 7636 test vector and random codes', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  const a = generatePkce()
  const b = generatePkce()
  assert.match(a.verifier, /^[A-Za-z0-9_-]{86}$/)
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(a.challenge, pkceChallenge(a.verifier))
  assert.notEqual(a.verifier, b.verifier)
  assert.match(generateState(), /^[A-Za-z0-9_-]{43}$/)
})

test('pkce: authorize url carries the codex parameters', () => {
  const u = new URL(buildAuthorizeUrl({ redirectUri: 'http://localhost:1455/auth/callback', challenge: 'CH', state: 'ST' }))
  assert.equal(u.origin + u.pathname, 'https://auth.openai.com/oauth/authorize')
  const q = Object.fromEntries(u.searchParams)
  assert.equal(q.response_type, 'code')
  assert.equal(q.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann')
  assert.equal(q.redirect_uri, 'http://localhost:1455/auth/callback')
  assert.equal(q.code_challenge, 'CH')
  assert.equal(q.code_challenge_method, 'S256')
  assert.equal(q.state, 'ST')
  assert.equal(q.scope, 'openid profile email offline_access')
  assert.equal(q.id_token_add_organizations, 'true')
  assert.equal(q.codex_cli_simplified_flow, 'true')
  assert.equal(q.originator, 'codex_cli_rs')
})

test('token: jwt decode and expiry', () => {
  const t = jwt({ exp: 2_000_000_000, sub: 'x' })
  assert.equal(decodeJwt(t).sub, 'x')
  assert.equal(decodeJwt('not-a-jwt'), null)
  assert.equal(decodeJwt('a.%%%.c'), null)
  assert.equal(tokenExpiresAt(t), 2_000_000_000_000)
  assert.equal(tokenExpiresAt(jwt({ sub: 'x' })), null)
  const now = 1_900_000_000_000
  assert.equal(isExpired(t, now), false)
  assert.equal(isExpired(t, 2_000_000_000_000), true)
})

test('token: refresh ahead of expiry', () => {
  const now = Date.now()
  const at = (s) => jwt({ exp: Math.floor(now / 1000) + s })
  assert.equal(needsRefresh({ accessToken: at(3600) }, now), false)
  assert.equal(needsRefresh({ accessToken: at(9 * 60) }, now), true) // 10 分钟窗口内
  assert.equal(needsRefresh({ accessToken: at(-5) }, now), true)
  assert.equal(needsRefresh({ accessToken: '' }, now), true)
  // 没有 exp：看上次刷新时间，超过 8 天才刷
  const noExp = jwt({ sub: 'x' })
  assert.equal(needsRefresh({ accessToken: noExp, lastRefresh: now - 86_400_000 }, now), false)
  assert.equal(needsRefresh({ accessToken: noExp, lastRefresh: now - 9 * 86_400_000 }, now), true)
})

test('token: account info from claims', () => {
  const t = tokens({ account: 'acc-9' })
  const info = accountInfo({ idToken: t.id_token, accessToken: t.access_token })
  assert.equal(info.accountId, 'acc-9')
  assert.equal(info.email, 'me@example.com')
  assert.equal(info.plan, 'plus')
  assert.equal(info.planLabel, 'Plus')
  assert.equal(info.residency, null) // no_constraint 不发头
  const only = accountInfo({ idToken: '', accessToken: jwt({ [AUTH]: { chatgpt_account_id: 'a2', chatgpt_compute_residency: 'us' } }) })
  assert.equal(only.accountId, 'a2')
  assert.equal(only.residency, 'us')
  assert.equal(planLabel('prolite'), 'Pro Lite')
  assert.equal(planLabel('self_serve_business'), 'Self Serve Business')
})

test('callback: state is checked before anything else', () => {
  assert.equal(checkCallback({ code: 'c', state: 'bad' }, 'good').kind, 'state-mismatch')
  assert.equal(checkCallback({ code: 'c' }, 'good').kind, 'state-mismatch')
  assert.equal(checkCallback({ error: 'access_denied', state: 'bad' }, 'good').kind, 'state-mismatch')
  const denied = checkCallback({ error: 'access_denied', error_description: 'no', state: 'good' }, 'good')
  assert.equal(denied.kind, 'provider')
  assert.match(denied.message, /取消了授权/)
  assert.equal(checkCallback({ state: 'good' }, 'good').kind, 'missing-code')
  assert.deepEqual(checkCallback({ code: 'c1', state: 'good' }, 'good'), { kind: 'ok', code: 'c1' })
})

test('refresh failure classification follows codex', () => {
  assert.equal(classifyRefreshFailure(401, '{}').permanent, true)
  assert.equal(classifyRefreshFailure(400, '{"error":"invalid_grant"}').permanent, true)
  assert.equal(classifyRefreshFailure(400, '{"error":{"code":"refresh_token_reused"}}').permanent, true)
  assert.match(classifyRefreshFailure(400, '{"error":{"code":"refresh_token_expired"}}').message, /过期/)
  assert.equal(classifyRefreshFailure(400, '{"error":"other"}').permanent, false)
  assert.equal(classifyRefreshFailure(502, '<html>').permanent, false)
})

/* ---------------- 登录流程（假 issuer + 模拟浏览器） ---------------- */

test('login: pkce round trip, token saved 0600, status logged in', async () => {
  const dir = tmpDir()
  const t = tokens()
  let verifier
  const iss = await fakeIssuer((call) => {
    const q = new URLSearchParams(call.body)
    verifier = q.get('code_verifier')
    return { json: t }
  })
  const auth = new ChatGPTAuth({ file: path.join(dir, 'chatgpt-auth.json'), issuer: iss.url, ports: [0], safeStorage: null, mode: 'app' })
  const events = []
  auth.on('status', (s) => events.push(s))
  let challenge
  let page
  let browser
  const st = await auth.login({
    openExternal: (url) => (browser = (async () => {
      const u = new URL(url)
      challenge = u.searchParams.get('code_challenge')
      const cb = new URL(u.searchParams.get('redirect_uri'))
      // 先来一个旧标签页的回调：state 不对，登录不应结束
      const stale = await fetch(`${cb}?code=zzz&state=old`)
      assert.equal(stale.status, 400)
      const res = await fetch(`${cb}?code=the-code&state=${u.searchParams.get('state')}`)
      page = await res.text()
      assert.equal(res.status, 200)
    })()),
  })
  await browser
  try {
    assert.equal(st.loggedIn, true)
    assert.equal(st.email, 'me@example.com')
    assert.equal(st.planLabel, 'Plus')
    assert.match(page, /登录成功/)
    assert.equal(pkceChallenge(verifier), challenge)
    const call = iss.calls[0]
    assert.equal(call.url, '/oauth/token')
    assert.match(call.type, /x-www-form-urlencoded/)
    const q = new URLSearchParams(call.body)
    assert.equal(q.get('grant_type'), 'authorization_code')
    assert.equal(q.get('code'), 'the-code')
    assert.equal(q.get('client_id'), OAUTH.clientId)
    const file = path.join(dir, 'chatgpt-auth.json')
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tokens.refresh_token, 'rt-1')
    assert.ok(events.some((e) => e.loggingIn && e.loginUrl))
    assert.equal(events.at(-1).loggedIn, true)
    // 新实例从文件读回来
    const again = new ChatGPTAuth({ file, issuer: iss.url, safeStorage: null, mode: 'app' })
    assert.equal((await again.credentials()).accountId, 'acc-1')
  } finally {
    await iss.close()
  }
})

test('login: provider error ends the login with a readable reason', async () => {
  const auth = new ChatGPTAuth({ file: path.join(tmpDir(), 'a.json'), issuer: 'http://127.0.0.1:9', ports: [0], safeStorage: null, mode: 'app' })
  await assert.rejects(
    auth.login({
      openExternal: async (url) => {
        const u = new URL(url)
        const res = await fetch(`${u.searchParams.get('redirect_uri')}?error=access_denied&state=${u.searchParams.get('state')}`)
        assert.match(await res.text(), /登录没有完成/)
      },
    }),
    (e) => e.code === 'login-failed' && /取消了授权/.test(e.message),
  )
  assert.equal(auth.status().loggedIn, false)
  assert.match(auth.status().error, /取消了授权/)
})

test('login: port in use gives a clear error', async () => {
  const blocker = http.createServer()
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  const port = blocker.address().port
  const auth = new ChatGPTAuth({ file: path.join(tmpDir(), 'a.json'), ports: [port], safeStorage: null, mode: 'app' })
  try {
    await assert.rejects(auth.login({ openExternal: () => {} }), (e) => e.code === 'port-in-use' && e.message.includes(String(port)))
  } finally {
    blocker.close()
  }
})

test('login: times out and cancel works', async () => {
  const auth = new ChatGPTAuth({ file: path.join(tmpDir(), 'a.json'), ports: [0], safeStorage: null, mode: 'app' })
  await assert.rejects(auth.login({ openExternal: () => {}, timeoutMs: 50 }), (e) => e.code === 'login-timeout')
  assert.equal(auth.status().loggingIn, false)
  const p = auth.login({ openExternal: () => {} })
  auth.cancelLogin()
  await assert.rejects(p, (e) => e.code === 'login-cancelled')
})

/* ---------------- 刷新 ---------------- */

function seeded(dir, t, extra = {}) {
  const file = path.join(dir, 'chatgpt-auth.json')
  fs.writeFileSync(file, JSON.stringify({ v: 1, tokens: t, lastRefresh: Date.now(), ...extra }))
  return file
}

test('refresh: concurrent callers share one refresh, rotated tokens are saved', async () => {
  const dir = tmpDir()
  const iss = await fakeIssuer(async () => {
    await new Promise((r) => setTimeout(r, 30))
    return { json: { access_token: tokens({ n: 2 }).access_token, refresh_token: 'rt-2' } }
  })
  const file = seeded(dir, tokens({ expIn: 60 })) // 1 分钟后过期，在刷新窗口内
  const auth = new ChatGPTAuth({ file, issuer: iss.url, safeStorage: null, mode: 'app' })
  try {
    const [a, b, c] = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.credentials()])
    assert.equal(iss.calls.length, 1)
    const body = JSON.parse(iss.calls[0].body)
    assert.deepEqual(body, { client_id: OAUTH.clientId, grant_type: 'refresh_token', refresh_token: 'rt-1' })
    assert.equal(decodeJwt(a).n, 2)
    assert.equal(a, b)
    assert.equal(c.accessToken, a)
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(saved.tokens.refresh_token, 'rt-2')
    assert.ok(saved.tokens.id_token) // 没返回 id_token 时保留旧的
    // 刚刷新过，不会再刷
    await auth.getAccessToken()
    assert.equal(iss.calls.length, 1)
  } finally {
    await iss.close()
  }
})

test('refresh: invalid_grant turns into logged out', async () => {
  const dir = tmpDir()
  const iss = await fakeIssuer(() => ({ status: 400, json: { error: 'invalid_grant' } }))
  const file = seeded(dir, tokens({ expIn: -10 }))
  const auth = new ChatGPTAuth({ file, issuer: iss.url, safeStorage: null, mode: 'app' })
  const events = []
  auth.on('status', (s) => events.push(s))
  try {
    assert.equal(auth.status().loggedIn, true)
    await assert.rejects(auth.getAccessToken(), (e) => e.code === 'auth-expired')
    assert.equal(auth.status().loggedIn, false)
    assert.match(auth.status().error, /重新登录/)
    assert.equal(fs.existsSync(file), false)
    assert.equal(events.at(-1).loggedIn, false)
    await assert.rejects(auth.getAccessToken(), (e) => e.code === 'not-logged-in')
  } finally {
    await iss.close()
  }
})

test('refresh: transient failure keeps using a still-valid token', async () => {
  const dir = tmpDir()
  const iss = await fakeIssuer(() => ({ status: 503, json: {} }))
  const t = tokens({ expIn: 120 })
  const auth = new ChatGPTAuth({ file: seeded(dir, t), issuer: iss.url, safeStorage: null, mode: 'app' })
  try {
    assert.equal(await auth.getAccessToken(), t.access_token)
    assert.equal(auth.status().loggedIn, true)
  } finally {
    await iss.close()
  }
})

test('forceRefresh skips when another request already refreshed', async () => {
  const dir = tmpDir()
  const iss = await fakeIssuer(() => ({ json: { access_token: tokens({ n: 3 }).access_token } }))
  const auth = new ChatGPTAuth({ file: seeded(dir, tokens()), issuer: iss.url, safeStorage: null, mode: 'app' })
  try {
    assert.equal(await auth.forceRefresh('some-older-token'), true)
    assert.equal(iss.calls.length, 0)
    const cur = await auth.getAccessToken()
    assert.equal(await auth.forceRefresh(cur), true)
    assert.equal(iss.calls.length, 1)
    assert.equal(decodeJwt(await auth.getAccessToken()).n, 3)
  } finally {
    await iss.close()
  }
})

test('logout removes the file and revokes the refresh token', async () => {
  const dir = tmpDir()
  const iss = await fakeIssuer(() => ({ json: {} }))
  const file = seeded(dir, tokens())
  const auth = new ChatGPTAuth({ file, issuer: iss.url, safeStorage: null, mode: 'app' })
  try {
    await auth.logout()
    assert.equal(fs.existsSync(file), false)
    assert.equal(auth.status().loggedIn, false)
    assert.equal(iss.calls[0].url, '/oauth/revoke')
    assert.deepEqual(JSON.parse(iss.calls[0].body), { token: 'rt-1', token_type_hint: 'refresh_token', client_id: OAUTH.clientId })
  } finally {
    await iss.close()
  }
})

test('encrypted storage (windows) round trips through safeStorage', async () => {
  const dir = tmpDir()
  const iss = await fakeIssuer(() => ({ json: { access_token: tokens({ n: 7 }).access_token } }))
  const fake = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s).reverse(),
    decryptString: (b) => Buffer.from(b).reverse().toString(),
  }
  const file = seeded(dir, tokens({ expIn: 5 }))
  const auth = new ChatGPTAuth({ file, issuer: iss.url, safeStorage: fake, encrypt: true, mode: 'app' })
  try {
    await auth.getAccessToken() // 读明文旧文件，刷新后写成加密的
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(raw.enc && !raw.tokens)
    const again = new ChatGPTAuth({ file, safeStorage: fake, encrypt: true, mode: 'app' })
    assert.equal(decodeJwt(await again.getAccessToken()).n, 7)
    // 解不开（换了机器或用户）就当未登录
    const broken = new ChatGPTAuth({ file, safeStorage: { ...fake, decryptString: () => { throw new Error('x') } }, encrypt: true, mode: 'app' })
    assert.equal(broken.status().loggedIn, false)
    assert.match(broken.status().error, /无法解密/)
  } finally {
    await iss.close()
  }
})

test('mac: file is plain json even if safeStorage is given', async () => {
  const dir = tmpDir()
  const iss = await fakeIssuer(() => ({ json: { access_token: tokens({ n: 5 }).access_token } }))
  const fake = { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('x'), decryptString: () => '' }
  const file = seeded(dir, tokens({ expIn: 5 }))
  const auth = new ChatGPTAuth({ file, issuer: iss.url, safeStorage: fake, encrypt: false, mode: 'app' })
  try {
    await auth.getAccessToken()
    assert.equal(decodeJwt(JSON.parse(fs.readFileSync(file, 'utf8')).tokens.access_token).n, 5)
  } finally {
    await iss.close()
  }
})

test('codex mode reads ~/.codex/auth.json read-only and never refreshes', async () => {
  const dir = tmpDir()
  const codexFile = path.join(dir, 'auth.json')
  const t = tokens({ expIn: 60 }) // 在刷新窗口内也不刷新
  fs.writeFileSync(codexFile, JSON.stringify({ tokens: { ...t, account_id: 'acc-c' } }))
  const before = fs.readFileSync(codexFile, 'utf8')
  const calls = []
  const auth = new ChatGPTAuth({ mode: 'codex', codexAuthFile: codexFile, fetch: async (...a) => calls.push(a) })
  const c = await auth.credentials()
  assert.equal(c.accessToken, t.access_token)
  assert.equal(c.accountId, 'acc-c')
  assert.equal(await auth.forceRefresh(t.access_token), false)
  assert.equal(auth.status().source, 'codex')
  assert.equal(auth.status().loggedIn, true)
  await assert.rejects(auth.login({}), (e) => e.code === 'codex-mode')
  await assert.rejects(auth.logout(), (e) => e.code === 'codex-mode')
  assert.equal(calls.length, 0)
  assert.equal(fs.readFileSync(codexFile, 'utf8'), before)
  fs.writeFileSync(codexFile, JSON.stringify({ tokens: tokens({ expIn: -1 }) }))
  await assert.rejects(auth.credentials(), (e) => e.code === 'auth-expired' && /codex/.test(e.message))
  assert.equal(auth.status().loggedIn, false)
})

test('logout during an in-flight refresh does not resurrect the login', async () => {
  const dir = tmpDir()
  let release
  const iss = await fakeIssuer(async (call) => {
    if (call.url === '/oauth/token') await new Promise((r) => (release = r))
    return { json: { access_token: tokens({ n: 9 }).access_token, refresh_token: 'rt-9' } }
  })
  const file = seeded(dir, tokens({ expIn: 30 }))
  const auth = new ChatGPTAuth({ file, issuer: iss.url, safeStorage: null, mode: 'app' })
  try {
    const p = auth.credentials()
    while (!release) await new Promise((r) => setTimeout(r, 5))
    await auth.logout()
    release()
    await assert.rejects(p, (e) => e.code === 'not-logged-in')
    assert.equal(auth.status().loggedIn, false)
    assert.equal(fs.existsSync(file), false)
  } finally {
    await iss.close()
  }
})
