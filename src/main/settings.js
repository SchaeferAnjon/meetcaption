import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { DEFAULTS, merge, applyPatch, providerPatch } from './defaults.js'
import { PRESET_IDS } from './llm/providers.js'

export { DEFAULTS, keywordList } from './defaults.js'

// Windows 上密钥类字段用 DPAPI 加密落盘。macOS 不用钥匙串：没有正式签名的应用每次更新都会弹钥匙串密码框，
// 设置文件在用户自己的 Application Support 里，权限 0600。
const SECRET_FIELDS = ['openaiKey', 'sonioxKey', 'volcAccessToken', 'llmKey', ...PRESET_IDS.map((id) => `llmKeys.${id}`)]
const getPath = (o, key) => key.split('.').reduce((x, k) => x?.[k], o)
const setPath = (o, key, v) => {
  const ks = key.split('.')
  const last = ks.pop()
  const parent = ks.reduce((x, k) => (x[k] ??= {}), o)
  parent[last] = v
}
const useSafeStorage = process.platform === 'win32'

export class SettingsStore extends EventEmitter {
  constructor() {
    super()
    this.file = path.join(app.getPath('userData'), 'settings.json')
    this.isNew = !fs.existsSync(this.file) // 新装：第一次打开时语言按系统定（main.js）
    this.data = this.#load()
  }

  #canEncrypt() {
    if (!useSafeStorage) return false
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  #load() {
    let raw = {}
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {}
    for (const f of SECRET_FIELDS) {
      const v = getPath(raw, f)
      if (typeof v === 'string' && v.startsWith('enc:')) {
        try {
          setPath(raw, f, useSafeStorage ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : '')
        } catch {
          setPath(raw, f, '')
        }
      }
    }
    return merge(DEFAULTS, raw)
  }

  get() {
    const d = structuredClone(this.data)
    // 开发和自测时可以用环境变量给 key，只在运行时用，不写进设置文件。
    const env = process.env
    if (!d.openaiKey && env.OPENAI_API_KEY) d.openaiKey = env.OPENAI_API_KEY
    if (!d.volcAppId && env.VOLC_ASR_APP_ID) d.volcAppId = env.VOLC_ASR_APP_ID
    if (!d.volcAccessToken && env.VOLC_ASR_ACCESS_TOKEN) d.volcAccessToken = env.VOLC_ASR_ACCESS_TOKEN
    return d
  }

  update(patch) {
    const next = applyPatch(this.data, providerPatch(this.data, patch))
    const prev = this.data
    this.data = next
    this.#save()
    this.emit('change', this.get(), prev)
    return this.get()
  }

  #save() {
    const out = structuredClone(this.data)
    const encrypt = this.#canEncrypt()
    for (const f of SECRET_FIELDS) {
      const v = getPath(out, f)
      if (v && encrypt) setPath(out, f, 'enc:' + safeStorage.encryptString(v).toString('base64'))
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
}
