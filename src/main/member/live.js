// 会员在记录中的场次：开始前开一场、余额提醒、场次用完退回本地识别、会中买了场次马上接回云识别和 AI。
// 收费页只在用户点「去买场次」时打开（界面上的按钮），这里不弹（2026-11-25 用户定：上课中途弹出来抢屏幕）。
// main.js 接线（member 的 session / update / paid 事件、开始和停止记录）；单测用假引擎（test/member-live.test.js）。
import { t } from '../i18n.js'

const hours = (ms) => Math.round(ms / 360_000) / 10
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000))

// 提示条的代号：界面按代号给前三条配「去买场次」按钮（control/core.js 的 onEngineNotice）
export const NOTICE = { last: 'member-last', low: 'member-low', exhausted: 'member-exhausted', resumed: 'member-resumed', start: 'member', resume: 'member-resume' }

export class MemberLive {
  /** member：member/client.js 的 Member；engine：MeetingEngine；isMember()：设置里是不是会员模式。 */
  constructor({ member, engine, isMember }) {
    this.member = member
    this.engine = engine
    this.isMember = isMember
    this.pending = null // 开始前开场次时要说的话，等记录真开始了再说（界面在记录开始时清掉旧提示）
    this.resuming = null
    this.muted = false // 会中接回期间不单独提醒（见 topUp）
  }

  /** 开始记录前：扣一场（或接上 30 分钟内断开的那场）。场次不够或连不上服务器：这一场退回本地识别。 */
  async begin() {
    this.pending = null
    const m = this.member
    if (!this.isMember()) return
    m.fallback = false
    try {
      await m.startSession()
    } catch (e) {
      m.fallback = true
      if (e.code === 'no-balance') this.pending = { level: 'warn', text: exhaustedText(), code: NOTICE.exhausted }
      else
        this.pending = {
          level: 'warn',
          code: NOTICE.start,
          text:
            e.code === 'network'
              ? t('连不上会员服务器，这一场先用本地识别，AI 功能可能用不了。')
              : t(`会员服务器没能开始这一场（{0}），这一场先用本地识别，AI 功能可能用不了。`, e.message),
        }
    }
  }

  /** 记录开始了：说开场时攒下的话；这是最后一场就提醒。 */
  started() {
    const n = this.pending
    this.pending = null
    if (n) this.engine.notice(n.level, n.text, n.code)
    this.remind()
  }

  /** 余额提醒（每一场各一次）：开场、自动续场、每次心跳后调。 */
  remind() {
    if (this.engine.state !== 'running' || this.muted) return
    const r = this.member.takeReminder()
    if (!r) return
    if (r.type === 'last') this.engine.notice('info', lastText(r), NOTICE.last)
    else {
      this.engine.notice('clear', '', NOTICE.last)
      this.engine.notice('clear', '', NOTICE.resumed)
      this.engine.notice('warn', lowText(r), NOTICE.low)
    }
  }

  /** 会员服务器停了这一场：场次用完就换本地识别接着记（字幕、录音照常，AI 暂停）；15 分钟没说话就暂停，等用户点继续。 */
  async stop({ type }) {
    const { engine, member } = this
    if (engine.state !== 'running') return
    if (type === 'idle') {
      member.markIdle()
      await engine.pause()
      engine.notice('warn', t('15 分钟没听到有人说话，已经自动暂停，不再计时。要接着记就点「继续」。'), 'member-idle')
      return
    }
    // exhausted（场次用完）或 ended（服务器那边这一场已结束）：退回本地识别。
    // 横幅先出再换识别：换成本地识别要载入模型，机器忙时要十几秒，这期间用户该先知道为什么
    member.markExhausted()
    member.fallback = true
    for (const code of [NOTICE.last, NOTICE.low, NOTICE.resumed]) engine.notice('clear', '', code)
    engine.notice('warn', exhaustedText(), NOTICE.exhausted)
    await this.#swapAsr()
  }

  /**
   * 买了场次（结账轮询到付款、输了授权码）：正在记录、这一场退回了本地识别的，马上开一场新的接着记，
   * 换回云识别，翻译和答题接着用，不用等下一场。同时来的几次合成一次。
   */
  topUp() {
    if (this.resuming) return this.resuming
    const { engine, member } = this
    if (!this.isMember() || engine.state !== 'running' || !member.fallback || !(member.info?.balance > 0)) return Promise.resolve(false)
    // 接回期间开新场次、清 fallback 都会发 update（main.js 接着调 remind）：先不单独提醒，接回的提示里一起说
    this.muted = true
    this.resuming = this.#resume().finally(() => {
      this.resuming = null
      this.muted = false
    })
    return this.resuming
  }

  async #resume() {
    const { engine, member } = this
    // 用完的那一场先结束（服务器不让用完的场次接着用）；结束会清掉 fallback，开成之前还算退回着
    if (member.session) await member.endSession()
    member.fallback = true
    try {
      await member.startSession({ startedAt: engine.session?.startedAt })
    } catch (e) {
      engine.notice('warn', t(`场次加上了，但这一场没能接上会员服务（{0}），下一场就能用。`, e.message), NOTICE.resume)
      return false
    }
    // 开场的时候用户停了记录：这一场退回去
    if (engine.state !== 'running') {
      await member.endSession()
      return false
    }
    member.fallback = false
    if (engine.paused) member.setRunning(false) // 用户暂停着：继续时才计时
    await this.#swapAsr()
    engine.resumeAi()
    // 只留一条：用完、余额、开场的旧提示都收掉；新开的这一场要是又是最后一场（买了 1 场就是），这句并进接回的提示里
    for (const code of [NOTICE.exhausted, NOTICE.low, NOTICE.last, NOTICE.start, NOTICE.resume]) engine.notice('clear', '', code)
    const cloud = engine.cfg?.engine !== 'local'
    const r = member.takeReminder()
    const text = cloud ? t('场次加上了 · 已经换回云识别，翻译和答题接着用') : t('场次加上了 · 翻译和答题接着用')
    engine.notice('info', r ? `${text} · ${r.type === 'last' ? lastText(r) : lowText(r)}` : text, NOTICE.resumed)
    return true
  }

  // 会员通道变了（用完退回本地、买了换回云端）：实际用的识别变了才断开重连，同一场会议接着记；暂停着的等继续时按新的建。
  // 一次换完再换下一次：用完时换本地识别要载入模型（机器忙时十几秒），这期间买了场次，换回云端要等它换完，
  // 不然看到的是换到一半的「暂停着」，就不重连了，一直停在本地识别
  #swapAsr() {
    const next = (this.swapping ?? Promise.resolve()).then(() => this.#swapNow())
    this.swapping = next.catch(() => {})
    return next
  }

  async #swapNow() {
    const e = this.engine
    const before = e.cfg?.engine
    e.refreshSettings()
    if (e.paused || e.cfg?.engine === before) return
    await e.pause()
    await e.resume()
  }
}

const exhaustedText = () => t('场次用完了 · 翻译和答题先暂停，字幕和录音照常')
const lastText = (r) => t(`这是最后一场 · 最长 {0} 小时`, hours(r.remainingMs))
const lowText = (r) => t(`这一场的 AI 还剩 {0} 分钟`, minutes(r.remainingMs))
