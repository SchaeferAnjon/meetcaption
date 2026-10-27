// 每天匿名报到一次（设置 → 通用 → 隐私「匿名使用统计」）：统计每天有多少人在用，自带 Key 的用户平时不联系服务器，只能靠这个算进来。
// 要用户先同意（settings.usageConsent：'' 没问过 | yes | no），只有 yes 才发，没问过和不同意都不发。
// POST {会员服务器}/v1/ping，不带 Authorization，body 只有 id（每次安装随机生成一次）、version、platform、arch、plan（member | own）、lang（界面语言），
// 不发会议内容、Key、名字、邮箱、硬件编号。成功回 204。
// 同一个本地日期只报一次：日期和 id 存在 userData/usage-ping.json。启动后过几秒报一次，之后每小时看一眼（开着跨过午夜第二天也报）；
// 失败（断网、4xx、5xx、10 秒超时）只记日志，不弹窗，这一天没记下，下一个小时再试。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const FIRST_MS = 5_000
const EVERY_MS = 3600_000
const TIMEOUT_MS = 10_000

/** 用户同意了没有：只有明确同意（yes）才算。 */
export const consented = (s) => s?.usageConsent === 'yes'

/** 还没回答过（没问过）：主窗口要问一次。点过「同意」或「不用了」（yes / no）就不再问。 */
export const needsConsent = (s) => (s?.usageConsent ?? '') === ''

/** 「同意 / 不同意」写进设置的 patch（设置里的开关和以后的询问弹窗都走 main.js 的 setUsageConsent）。 */
export const consentPatch = (agree) => ({ usageConsent: agree === true ? 'yes' : 'no' })

/** 本地日期 2026-10-27（不用 toISOString：那是 UTC，东八区早上 8 点前还算前一天）。 */
export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class UsagePing {
  /**
   * file：userData/usage-ping.json；api：会员服务器地址；enabled()：用户同意了没有（consented）；
   * info()：{ version, plan, lang }，每次报到时现取（界面语言、用法可能改过）。fetch、now、log 单测里换。
   */
  constructor({ file, api, enabled, info, fetch: f = globalThis.fetch, now = () => new Date(), log = (...a) => console.warn('[ping]', ...a), platform = process.platform, arch = process.arch, firstMs = FIRST_MS, everyMs = EVERY_MS, timeoutMs = TIMEOUT_MS }) {
    Object.assign(this, { file, api, enabled, info, fetch: f, now, log, platform, arch, firstMs, everyMs, timeoutMs })
    this.timers = []
    this.busy = null
  }

  #read() {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return s && typeof s === 'object' ? s : {}
    } catch {
      return {}
    }
  }

  #write(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(state, null, 2))
  }

  start() {
    this.stop()
    const first = setTimeout(() => this.tick(), this.firstMs)
    const every = setInterval(() => this.tick(), this.everyMs)
    first.unref?.()
    every.unref?.()
    this.timers = [first, every]
  }

  stop() {
    for (const h of this.timers) clearTimeout(h)
    this.timers = []
  }

  /** 看一眼：开关开着、今天还没报过就报。返回 'off' | 'done'（今天报过了）| 'sent' | 'failed'；同时来的几次合成一次。 */
  tick() {
    this.busy ??= this.#tick().finally(() => (this.busy = null))
    return this.busy
  }

  async #tick() {
    if (!this.enabled()) return 'off'
    const state = this.#read()
    const day = localDay(this.now())
    if (state.day === day) return 'done'
    if (typeof state.id !== 'string' || !state.id) {
      state.id = randomUUID()
      this.#write(state)
    }
    const { version, plan, lang } = this.info()
    const body = { id: state.id, version: String(version), platform: this.platform, arch: this.arch, plan: plan === 'own' ? 'own' : 'member', lang: String(lang) }
    try {
      const res = await this.fetch(`${this.api}/v1/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'MeetCaption' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (!res.ok) {
        this.log(`HTTP ${res.status}`)
        return 'failed'
      }
    } catch (e) {
      this.log(e?.cause?.code ?? e?.name ?? String(e))
      return 'failed'
    }
    this.#write({ ...state, day })
    return 'sent'
  }
}
