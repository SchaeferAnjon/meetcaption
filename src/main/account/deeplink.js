// 登录回调地址的解析（纯函数，单测覆盖）。
// 成功：?code=…（PKCE）。失败：?error=…&error_description=…，GoTrue 有时把错误放在 # 后面。
// #access_token=…&refresh_token=… 是隐式流程（管理接口生成的登录链接会这样回），只在测试开关打开时认。
import { DEEP_LINK_CALLBACK, LOOPBACK_PATH, SCHEME } from './config.js'

/** Windows 的深链从命令行参数里来（second-instance 的 argv 或冷启动的 process.argv），找出第一个 meetcaption:// 开头的。 */
export function findDeepLink(argv, scheme = SCHEME) {
  if (!Array.isArray(argv)) return null
  const prefix = `${scheme}://`
  for (const a of argv) {
    if (typeof a !== 'string') continue
    // 有的启动器会把参数整个加上引号
    const s = a.trim().replace(/^"(.*)"$/, '$1')
    if (s.toLowerCase().startsWith(prefix)) return s
  }
  return null
}

/** 是不是登录回调：meetcaption://auth-callback（大小写不敏感，尾部可以带 /），或本机回环的 /auth-callback。 */
export function isAuthCallback(url, { scheme = SCHEME } = {}) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol === `${scheme}:`) {
    // meetcaption://auth-callback：host 是 auth-callback；有的系统会给成 meetcaption:auth-callback 或 meetcaption:///auth-callback
    const where = (u.host || u.pathname.replace(/^\/+/, '')).replace(/\/+$/, '').toLowerCase()
    const rest = u.host ? u.pathname.replace(/^\/+|\/+$/g, '') : ''
    return where === 'auth-callback' && rest === ''
  }
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.pathname.replace(/\/+$/, '') === LOOPBACK_PATH
  return false
}

function paramsOf(u) {
  const out = {}
  // # 后面的先放，? 后面的覆盖（GoTrue 两处都可能给 error）
  const hash = u.hash.replace(/^#/, '')
  for (const [k, v] of new URLSearchParams(hash)) out[k] = v
  for (const [k, v] of u.searchParams) out[k] = v
  return out
}

/**
 * 解析回调。返回：
 * - null：不是登录回调
 * - { kind: 'code', code }
 * - { kind: 'tokens', accessToken, refreshToken, expiresIn, expiresAt }
 * - { kind: 'error', error, message }
 */
export function parseCallback(url, opts) {
  if (!isAuthCallback(url, opts)) return null
  const p = paramsOf(new URL(url))
  if (p.error || p.error_code) {
    const desc = (p.error_description || '').replace(/\+/g, ' ').trim()
    return { kind: 'error', error: p.error || p.error_code, message: callbackErrorMessage(p.error || p.error_code, desc) }
  }
  if (p.code) return { kind: 'code', code: p.code }
  if (p.access_token && p.refresh_token) {
    const expiresIn = Number(p.expires_in) || 3600
    const expiresAt = Number(p.expires_at) || null
    return { kind: 'tokens', accessToken: p.access_token, refreshToken: p.refresh_token, expiresIn, expiresAt }
  }
  return { kind: 'error', error: 'missing-code', message: '回调里没有授权码，登录没能完成' }
}

export function callbackErrorMessage(error, desc = '') {
  const tail = desc ? `：${desc}` : ''
  if (error === 'access_denied') return `你取消了授权${tail}`
  if (error === 'server_error' && /redirect/i.test(desc)) return `账号服务不认这个回调地址${tail}`
  return `账号服务返回错误 ${error}${tail}`
}

export { DEEP_LINK_CALLBACK }
