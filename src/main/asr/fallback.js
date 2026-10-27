import { EventEmitter } from 'node:events'
import { t } from '../i18n.js'

// 云识别断线时本地识别接手：断开 afterMs 还没连上，就开本地识别，从云端最后一个定稿的字的终点（最多往回 60 秒）接着认；
// 云端再连上时连接先挂着（Soniox 的 hold），等本地这一句说完（最多等 handoverWaitMs），从本地最后一句的终点交回云端补发。
// 本地还在说的那一句作废（'drop'），云端从那里重认，所以前后不重复也不丢字。
// 对外和别的识别一样：connect / sendAudio / close，事件 partial / final / drop / status / warn / weak（本地识别跟不上）/ member / fatal；
// status 多两种：'fallback'（本地接手了）和 'back'（换回云端了）。
// 本地识别只认中英文：别的语言不用这一层（engine.js 决定）。

// 重连在断开后 0、1、3 秒各试一次：闪断两三秒的，第 3 秒那次就连上了，不用换本地。
// 接上又马上断的不算连上（soniox.js 的 STABLE_MS）：同样 4 秒后换本地
const AFTER_MS = 4000
const HANDOVER_WAIT_MS = 4000
// 本地给的一句的终点是最后一个字的起点加 0.25 秒，长一点的字还没说完：交回时再往后让一点，免得云端把这个字的尾巴再认一遍
const MARGIN_MS = 250

export class LocalFallbackASR extends EventEmitter {
  gated = false

  /** cloud：SonioxStreamASR；makeLocal：() => 本地识别（LocalStreamASR）。 */
  constructor({ cloud, makeLocal, afterMs = AFTER_MS, handoverWaitMs = HANDOVER_WAIT_MS }) {
    super()
    this.cloud = cloud
    this.makeLocal = makeLocal
    this.tm = { afterMs, handoverWaitMs }
    this.sampleRate = cloud.sampleRate
    this.local = null // { asr, from, live, retired, openKey, openStart, lastEnd }，本地接手时才有；位置都是这一路的样本序号
    this.timer = null
    this.handover = null // 等本地说完这一句再交回的计时器
    this.closed = false
    for (const name of ['partial', 'final', 'drop', 'warn', 'member', 'fatal']) cloud.on(name, (x) => this.emit(name, x))
    cloud.on('status', (st) => this.#onCloud(st))
  }

  connect() {
    return this.cloud.connect()
  }

  sendAudio(buf) {
    this.cloud.sendAudio(buf)
    if (this.local?.live) this.local.asr.sendAudio(buf)
  }

  endTurn() {}

  async close() {
    this.closed = true
    clearTimeout(this.timer)
    clearTimeout(this.handover)
    const l = this.local
    this.local = null
    await Promise.all([this.cloud.close(), l?.asr.close()].filter(Boolean))
  }

  #onCloud(st) {
    if (this.closed) return
    if (!this.local) {
      if (st === 'reconnecting') {
        if (!this.timer) this.timer = setTimeout(() => this.#toLocal(), this.tm.afterMs)
      } else if (st === 'ready') {
        clearTimeout(this.timer)
        this.timer = null
      }
      return this.emit('status', st)
    }
    // 本地接手中：云端又断了就接着等；连上了（挂着）就准备交回
    if (st === 'reconnecting') {
      clearTimeout(this.handover)
      this.handover = null
    } else if (st === 'online') this.#onOnline()
  }

  async #toLocal() {
    this.timer = null
    if (this.closed || this.local || this.cloud.steady) return
    this.cloud.hold()
    const l = { asr: this.makeLocal(), from: 0, live: false, retired: false, openKey: null, openStart: null, lastEnd: 0 }
    this.local = l
    const off = () => (l.from * 1000) / this.sampleRate
    const shift = (span) => span && { start: span.start + off(), end: span.end + off() }
    l.asr.on('partial', (e) => {
      if (l.retired) return
      const span = shift(e.span)
      if (l.openKey !== e.key) l.openStart = span ? this.#samples(span.start) : null
      l.openKey = e.key
      this.emit('partial', { ...e, span })
    })
    l.asr.on('final', (e) => {
      if (l.retired) return
      if (l.openKey === e.key) l.openKey = null
      const span = shift(e.span)
      if (span) l.lastEnd = Math.max(l.lastEnd, this.#samples(span.end))
      this.emit('final', { ...e, span })
      if (this.handover && !l.openKey) this.#backToCloud()
    })
    l.asr.on('warn', (msg) => !l.retired && this.emit('warn', msg))
    l.asr.on('weak', (w) => !l.retired && this.emit('weak', w))
    l.asr.on('fatal', (e) => !l.retired && this.#localFailed(l, e))
    try {
      await l.asr.connect()
    } catch (e) {
      return this.#localFailed(l, e)
    }
    if (l.retired || this.local !== l) return
    // 模型加载的这几秒音频还在云端的缓冲里：从最后一个定稿的字的终点一起补给本地
    const { from, bufs } = this.cloud.pendingAudio()
    l.from = from
    l.lastEnd = from
    l.asr.catchUp(bufs)
    l.live = true
    this.emit('status', 'fallback')
  }

  // 本地识别开不起来或者停了：回到只等云端重连（连上后从云端最后定稿的地方补发）
  #localFailed(l, e) {
    if (l.retired) return
    l.retired = true
    if (this.local === l) this.local = null
    clearTimeout(this.handover)
    this.handover = null
    if (l.openKey) this.emit('drop', { key: l.openKey })
    this.cloud.resumeFrom(l.live ? l.lastEnd : 0)
    l.asr.close().catch(() => {})
    this.emit('warn', t('本地识别没能接上：{0}', e.message))
    if (this.cloud.online) this.emit('status', 'ready')
  }

  #onOnline() {
    const l = this.local
    if (!l.live) {
      // 本地还没开起来云端就回来了：不换了，云端从它最后定稿的地方补发
      l.retired = true
      this.local = null
      this.cloud.resumeFrom(0)
      l.asr.close().catch(() => {})
      return this.emit('status', 'ready')
    }
    if (!l.openKey) return this.#backToCloud()
    clearTimeout(this.handover)
    this.handover = setTimeout(() => this.#backToCloud(), this.tm.handoverWaitMs)
  }

  #backToCloud() {
    const l = this.local
    if (!l) return
    clearTimeout(this.handover)
    this.handover = null
    l.retired = true
    this.local = null
    if (l.openKey) this.emit('drop', { key: l.openKey })
    // 本地还在说的那一句作废，云端从它的开头重认，所以让出去的那一点不能盖过它
    const at = l.lastEnd + this.#samples(MARGIN_MS)
    this.cloud.resumeFrom(l.openKey && l.openStart != null ? Math.max(l.lastEnd, Math.min(at, l.openStart)) : at)
    l.asr.close().catch(() => {})
    this.emit('status', 'back')
  }

  #samples(ms) {
    return Math.round((ms * this.sampleRate) / 1000)
  }
}
