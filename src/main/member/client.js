// 会员：不登录，按这台电脑领 1 场试用（最长 1 小时）；买了场次拿到授权码，别的电脑输码也能用。一场 = 一次记录，买的最长 2 小时。
// 服务器在 meetcaption-server（私有仓库），地址 API；识别和 AI 都经它转发，密钥只在服务器上。
// 这里只管和服务器说话、记住设备令牌；什么时候开一场、用完了怎么退回本地识别由 main.js 决定。
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { t } from '../i18n.js'

export const API = (process.env.MEETCAPTION_API ?? 'https://api.us-cloud.uk').replace(/\/+$/, '')

// 场次结束后多久还能拿这一场的票用 AI（服务器的 aiAfterEndMs）
export const AI_AFTER_END_MS = 24 * 3600_000

export const PACKS = [
  { id: 'p1', sessions: 1, cny: 12.8, usd: 1.99 },
  { id: 'p10', sessions: 10, cny: 108, usd: 15 },
  { id: 'p30', sessions: 30, cny: 298, usd: 42 },
  { id: 'p100', sessions: 100, cny: 888, usd: 125 },
]

export class MemberError extends Error {
  /** message 是给用户看的一句中文；detail 是原始报错（fetch failed、ECONNREFUSED），只进调试日志。 */
  constructor(code, message, status, detail) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const debug = process.env.MEETCAPTION_DEBUG ? (...a) => console.error(new Date().toISOString().slice(11, 23), ...a) : () => {}

const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? '' : String(out))))

/** 这台电脑的硬件标识（Mac 硬件 UUID，Windows MachineGuid）的哈希；拿不到就用存在本地的随机值。 */
export async function machineId(platform = process.platform) {
  let raw = ''
  if (platform === 'darwin') raw = (await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])).match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? ''
  else if (platform === 'win32') raw = (await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])).match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? ''
  return raw ? createHash('sha256').update(`meetcaption:${raw}`).digest('hex') : null
}

export class Member extends EventEmitter {
  /** file：userData/member.json；fingerprint：async () => 设备标识；fetch 单测里换。 */
  constructor({ file, fingerprint = machineId, platform = process.platform, fetch: f = globalThis.fetch, api = API, heartbeatMs = 30_000 }) {
    super()
    this.file = file
    this.fingerprint = fingerprint
    this.platform = platform
    this.fetch = f
    this.api = api
    this.heartbeatMs = heartbeatMs
    this.state = this.#read()
    this.info = null // 服务器上的状态：{ kind, code, balance, devices, trialOnly, recent }
    this.session = null // 进行中的一场：{ token, sessionId, remainingMs, charged, exhausted, idle }
    // state.last：最近一场的票 { token, startedAt, endedAt }，存在 member.json 里：会后 24 小时内（重启应用也算）纪要、课堂笔记记在这一场上。
    // 开始时就存（endedAt 为 null），没走到结束就退出的按开始时间算 24 小时，不会比服务器宽
    this.running = false
    this.fallback = false // 这一场场次不够、退回了本地识别（main.js 设）
    this.hb = null
    this.poll = null
    this.error = null
    this.refreshing = null // 正在问的 refresh()，同时来的几次合成一次
    this.checkedAt = 0 // 上次问服务器场次的时间
  }

  #read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      return {}
    }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), { mode: 0o600 })
  }

  async #call(method, p, { body, token, retry = true } = {}) {
    let res
    try {
      res = await this.fetch(`${this.api}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'MeetCaption', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      })
    } catch (e) {
      const detail = e.cause?.code ?? e.message
      debug('member', method, p, detail)
      throw new MemberError('network', t('连不上会员服务器，稍后再试'), undefined, detail)
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok) return data
    const err = data.error ?? {}
    // 设备令牌失效（换了电脑的备份、服务器那边重置）：重新领一次，同一台电脑拿回原来的账
    if (res.status === 401 && err.code === 'bad-device' && retry && token === this.state.token) {
      this.state.token = null
      await this.ensureDevice()
      return this.#call(method, p, { body, token: this.state.token, retry: false })
    }
    throw new MemberError(err.code ?? 'http', err.message ?? t(`会员服务器出错（HTTP {0}）`, res.status), res.status)
  }

  /** 第一次用：按设备领试用，存下设备令牌。之后直接返回。 */
  async ensureDevice() {
    if (this.state.token) return this.state.token
    const fp = (await this.fingerprint(this.platform)) ?? (this.state.fallbackId ??= createHash('sha256').update(`${Date.now()}:${Math.random()}`).digest('hex'))
    const r = await this.#call('POST', '/v1/trial/start', { body: { device: fp, platform: this.platform }, retry: false })
    this.state.token = r.token
    this.#write()
    this.#setInfo(r)
    return r.token
  }

  #setInfo(r) {
    const { token: _t, ...info } = r
    this.info = info
    this.error = null
    this.emit('update', this.snapshot())
  }

  snapshot() {
    return {
      info: this.info,
      session: this.session ? { sessionId: this.session.sessionId, remainingMs: this.session.remainingMs, charged: this.session.charged, exhausted: this.session.exhausted, idle: this.session.idle } : null,
      buying: Boolean(this.poll),
      error: this.error,
    }
  }

  /**
   * 向服务器要最新的场次（退款、别的电脑用掉了都只有服务器知道）。连不上就留着旧的数据。
   * maxAge：有数据且上次问过不到这么久就不再问（回到主窗口、打开会员页时用，别每次切窗口都打服务器）。
   */
  async refresh({ maxAge = 0 } = {}) {
    if (this.refreshing) return this.refreshing
    if (maxAge && this.info && Date.now() - this.checkedAt < maxAge) return this.snapshot()
    this.refreshing = (async () => {
      try {
        const token = await this.ensureDevice()
        this.#setInfo(await this.#call('GET', '/v1/license/status', { token }))
      } catch (e) {
        this.error = e.message
        this.emit('update', this.snapshot())
      }
      this.checkedAt = Date.now()
      return this.snapshot()
    })().finally(() => (this.refreshing = null))
    return this.refreshing
  }

  async activate(code) {
    const token = await this.ensureDevice()
    this.#setInfo(await this.#call('POST', '/v1/license/activate', { token, body: { code } }))
    return this.snapshot()
  }

  async unbind() {
    const token = await this.ensureDevice()
    this.#setInfo(await this.#call('POST', '/v1/license/unbind', { token }))
    return this.snapshot()
  }

  /** 买：服务器建结账，回网址（main.js 用浏览器打开）；之后每 3 秒问一次，付完自动加上，最多等 30 分钟。 */
  async buy(pack, currency) {
    const token = await this.ensureDevice()
    const r = await this.#call('POST', '/v1/checkout', { token, body: { pack, currency } })
    this.#pollClaim(r.claim)
    this.emit('update', this.snapshot())
    return r.url
  }

  #pollClaim(claim, intervalMs = 3000, maxMs = 30 * 60_000) {
    clearInterval(this.poll)
    const t0 = Date.now()
    const stop = () => {
      clearInterval(this.poll)
      this.poll = null
      this.emit('update', this.snapshot())
    }
    this.poll = setInterval(async () => {
      if (Date.now() - t0 > maxMs) return stop()
      try {
        const r = await this.#call('GET', `/v1/checkout/${claim}`, { token: this.state.token })
        if (r.status === 'paid') {
          const { status: _s, ...info } = r
          stop()
          this.#setInfo(info)
          this.emit('paid', info)
        } else if (r.status === 'expired') stop()
      } catch {}
    }, intervalMs)
    this.poll.unref?.()
  }

  cancelBuy() {
    clearInterval(this.poll)
    this.poll = null
    this.emit('update', this.snapshot())
  }

  // ---------- 场次 ----------

  /** 开始记录前调：扣一场（或接上 30 分钟内断开的那场）。没余额抛 code=no-balance。 */
  async startSession() {
    const token = await this.ensureDevice()
    let r
    try {
      r = await this.#call('POST', '/v1/session/start', { token })
    } catch (e) {
      // 服务器说没场次了（退款、别的电脑用掉了）：马上把卡片和会员页对齐成服务器的数，别跟弹出的横幅说的不一样
      if (e.code === 'no-balance') await this.refresh()
      throw e
    }
    this.session = { token: r.session, sessionId: r.sessionId, remainingMs: r.remainingMs, charged: r.charged, exhausted: false, idle: false }
    // 接上 30 分钟内断开的同一场：开始时间还是那一场最早的，断开前记的那段会议也算这一场
    const same = this.state.last?.token === r.session
    this.state.last = { token: r.session, startedAt: same ? this.state.last.startedAt : Date.now(), endedAt: null }
    this.#write()
    this.running = true
    this.info = this.info ? { ...this.info, balance: r.balance } : this.info
    clearInterval(this.hb)
    this.hb = setInterval(() => this.heartbeat().catch(() => {}), this.heartbeatMs)
    this.hb.unref?.()
    this.emit('update', this.snapshot())
    return r
  }

  /** 识别要连 Soniox 时调：拿这一场的票换一把临时 Key（只能连一次，最长连 maxMs）。 */
  async asrKey() {
    const s = this.session
    if (!s) throw new MemberError('ended', t('这一场已经结束了'))
    return this.#call('POST', '/v1/session/asr-key', { token: s.token })
  }

  /** 每 30 秒一次；暂停时 running=false（暂停的时间不计）。服务器说用完了、自动暂停了就发 'session' 事件。 */
  async heartbeat() {
    const s = this.session
    if (!s) return null
    const r = await this.#call('POST', '/v1/session/heartbeat', { token: s.token, body: { running: this.running } })
    if (this.session !== s) return r
    const was = { exhausted: s.exhausted, idle: s.idle, charged: s.charged }
    Object.assign(s, { remainingMs: r.remainingMs, charged: r.charged, exhausted: r.exhausted, idle: r.idle })
    if (this.info) this.info = { ...this.info, balance: r.balance }
    if (r.exhausted && !was.exhausted) this.emit('session', { type: 'exhausted' })
    if (r.idle && !was.idle) this.emit('session', { type: 'idle' })
    if (r.charged > was.charged) this.emit('session', { type: 'rolled', charged: r.charged })
    this.emit('update', this.snapshot())
    return r
  }

  setRunning(running) {
    if (!this.session || this.running === running) return
    this.running = running
    this.heartbeat().catch(() => {})
  }

  /** 15 分钟没说话被服务器自动暂停后，用户点「继续」：先告诉服务器放行。 */
  async resumeIdle() {
    const s = this.session
    if (!s?.idle) return
    await this.#call('POST', '/v1/session/resume', { token: s.token })
    s.idle = false
  }

  markIdle() {
    if (this.session) this.session.idle = true
  }

  markExhausted() {
    if (this.session) this.session.exhausted = true
  }

  /** 停止记录：不到 5 分钟的服务器会退回这一场。 */
  async endSession() {
    this.fallback = false
    const s = this.session
    if (!s) return null
    clearInterval(this.hb)
    this.hb = null
    this.session = null
    this.running = false
    // 时间用完的场次也留着票：结束后 24 小时内服务器照样让它做纪要、课堂笔记（会中用完那段时间不给）
    this.state.last = { ...this.state.last, token: s.token, endedAt: Date.now() }
    this.#write()
    try {
      const r = await this.#call('POST', '/v1/session/end', { token: s.token })
      if (this.info) this.info = { ...this.info, balance: r.balance }
      this.emit('update', this.snapshot())
      return r
    } catch (e) {
      this.emit('update', this.snapshot())
      return { error: e.message }
    }
  }

  // 这次记录（本地会话的开始时间 at）是不是最近那一场：开始时间落在那一场的起止之间（本地会话在服务器开场之后几秒才建）
  #mine(at, now = Date.now()) {
    const l = this.state.last
    return Boolean(l?.token) && at >= l.startedAt - 5000 && at <= (l.endedAt ?? now)
  }

  // 最近一场的票，结束 24 小时内才给。给了 at 就只给那一场自己用：重做以前的会议不记在这一场上，走设备令牌（2026-10-27 用户定）
  #ticket(at = null, now = Date.now()) {
    const l = this.state.last
    if (!l?.token || now - (l.endedAt ?? l.startedAt) >= AI_AFTER_END_MS) return null
    return at == null || this.#mine(at, now) ? l.token : null
  }

  // 进行中的这一场管不管这次请求：没给 at（会中的翻译、答题）或者 at 就是这一场
  #live(at) {
    return Boolean(this.session) && (at == null || this.#mine(at))
  }

  /**
   * AI 用哪个凭据：进行中或 24 小时内结束那场的票；没有就用设备令牌（服务器给每天的会后整理额度）。
   * at：这次请求是给哪次记录的（本地会话的开始时间，纪要、课堂笔记会给）；不是最近那一场的就用设备令牌。
   */
  aiKey(at = null) {
    return (this.#live(at) ? this.session.token : null) ?? this.#ticket(at) ?? this.state.token ?? ''
  }

  /**
   * AI 用不了：这一场的时间用完了；或者试用用完、没买过，手上又没有 24 小时内的场次票。
   * 场次不够、这一场退回了本地识别（fallback）时也关着：上一场的票留给上一场做纪要，不拿来翻译这一场。
   */
  get noAi() {
    return this.noAiFor(null)
  }

  /** 给某次记录做纪要、课堂笔记时 AI 能不能用（at 同 aiKey）：试用用完、没买过时，只有最近那一场 24 小时内还能做。 */
  noAiFor(at) {
    if (this.#live(at)) return Boolean(this.session.exhausted)
    if (!this.info || this.info.balance > 0 || this.info.kind === 'paid') return false
    return (at == null && this.fallback) || !this.#ticket(at)
  }

  /** AI 用不了时给用户看的原因（会员没有 Key 可填，不能说「没填 Key」）。 */
  noAiReason(at = null) {
    if (this.#live(at) && this.session.exhausted) return t('这一场的会员时间用完了，翻译和答题先关着')
    return this.info?.trialGranted === false ? t('免费试用的名额发完了，买了场次 AI 才能用') : t('试用场次用完了，买了场次 AI 才能用')
  }

  /**
   * AI 请求回 401 之后换凭据：服务器不认会后的场次票（过了 24 小时）就不再用它，设备令牌失效就重新领一个。
   * 进行中那一场的票不换（换成设备令牌会花掉会后整理的额度）。→ 换到了能再试一次的凭据没有。
   */
  async renewAiKey(used) {
    if (!used || used === this.session?.token) return false
    if (used === this.state.last?.token) {
      this.state.last = null
      this.#write()
    } else if (used === this.state.token) {
      this.state.token = null
      await this.ensureDevice()
    } else return false
    const next = this.noAi ? '' : this.aiKey()
    return Boolean(next) && next !== used
  }

  stop() {
    clearInterval(this.hb)
    clearInterval(this.poll)
  }
}

/**
 * 会员模式下实际用的设置：识别换成 Soniox，应用拿场次票向我们的服务器换临时 Key 直连（选了本地识别、或场次用完退回时用本地），
 * AI 换成会员通道。只在主进程内部用；设置窗口看到的还是用户自己存的设置。
 */
export function memberSettings(s, m, at = null) {
  if (s.plan !== 'member') return s
  const local = s.memberAsr === 'local' || m.fallback || !m.session
  return {
    ...s,
    engine: local ? 'local' : 'soniox',
    sonioxKey: '',
    sonioxGetKey: () => m.asrKey(),
    llmProvider: 'member',
    llmFastModel: 'deepseek-flash',
    llmSummaryModel: 'deepseek-flash',
    llmAnswerModel: 'deepseek-flash',
    llmKeys: { ...s.llmKeys, member: (at == null ? m.noAi : m.noAiFor(at)) ? '' : m.aiKey(at) },
  }
}

/** 一次 AI 调用：current() 取实际设置，run(设置) 发请求；会员通道回 401 就换凭据（renewAiKey）用新的设置再试一次。 */
export async function withMemberAuth(m, current, run) {
  const s = current()
  try {
    return await run(s)
  } catch (e) {
    if (s.llmProvider !== 'member' || e?.status !== 401 || !(await m.renewAiKey(s.llmKeys?.member))) throw e
    return run(current())
  }
}
