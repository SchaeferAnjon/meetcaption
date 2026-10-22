// 账号 session 存 userData/account.json：Mac 明文 JSON、权限 0600（ad-hoc 签名每次更新都会弹钥匙串框，所以不用 safeStorage），
// Windows 用 safeStorage（DPAPI）加密成 { enc }。和 ChatGPT 登录的存法一样。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

export function defaultSafeStorage() {
  if (process.platform !== 'win32' || !process.versions.electron) return null
  try {
    return createRequire(import.meta.url)('electron').safeStorage ?? null
  } catch {
    return null
  }
}

/** 存下来的 session 最少要有这些字段，否则当没登录。 */
export function validSession(s) {
  return Boolean(s && typeof s.accessToken === 'string' && s.accessToken && typeof s.refreshToken === 'string' && s.refreshToken && Number.isFinite(s.expiresAt) && s.user?.id)
}

export class SessionFile {
  /**
   * @param {object} o
   * @param {string} o.file
   * @param {object} [o.safeStorage] Electron 的 safeStorage
   * @param {boolean} [o.encrypt] 默认只在 Windows 加密
   */
  constructor({ file, safeStorage, encrypt } = {}) {
    this.file = file
    this.safeStorage = safeStorage === undefined ? defaultSafeStorage() : safeStorage
    this.encrypt = encrypt ?? process.platform === 'win32'
    this.error = null // 读不出来的原因（给界面看）
  }

  #canEncrypt() {
    if (!this.encrypt || !this.safeStorage) return false
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** → session 或 null */
  load() {
    this.error = null
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (e) {
      if (e.code !== 'ENOENT') this.error = '保存的登录信息读不出来，请重新登录'
      return null
    }
    if (typeof raw?.enc === 'string') {
      try {
        if (!this.#canEncrypt()) throw new Error('safeStorage unavailable')
        raw = JSON.parse(this.safeStorage.decryptString(Buffer.from(raw.enc, 'base64')))
      } catch {
        this.error = '保存的登录信息无法解密，请重新登录'
        return null
      }
    }
    const s = raw?.session
    if (!validSession(s)) {
      if (raw) this.error = '保存的登录信息不完整，请重新登录'
      return null
    }
    return s
  }

  save(session) {
    const json = JSON.stringify({ v: 1, session }, null, 2)
    const out = this.#canEncrypt() ? JSON.stringify({ enc: this.safeStorage.encryptString(json).toString('base64') }) : json
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, out, { mode: 0o600 })
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, this.file)
  }

  clear() {
    try {
      fs.rmSync(this.file, { force: true })
    } catch {}
  }
}
