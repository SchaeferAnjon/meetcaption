import path from 'node:path'
import { enough, videoCharge } from './charge.js'
import { estimates, probeVideo, runVideo } from './job.js'
import { needsMultilingual } from '../languages.js'
import { t } from '../i18n.js'

// 主进程里管视频处理的那一层：「加一个视频」面板问价（quote）、开始处理、取消、做完发通知。一次只处理一个视频。
// 不引 electron：弹通知、开隐藏窗口、读设置都从外面传进来，单测用假的。

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0)

export class VideoService {
  /**
   * deps：{ store, projects, settings(), member, llm, summarizer, makeWorkers() → { audio, frames }, voiceprint, emit(channel, payload),
   *        notify({ title, body, sessionId }), busy() → 有没有正在记录的会议（有就不处理视频）, tmpDir?, steps? }
   */
  constructor(deps) {
    this.deps = deps
    this.job = null // { file, name, startedAt, ctl: AbortController, progress }
    this.probes = new Map() // 文件 → { at, probe }
  }

  get running() {
    return Boolean(this.job)
  }

  snapshot() {
    return this.job ? { running: true, file: this.job.file, name: this.job.name, startedAt: this.job.startedAt, progress: this.job.progress } : { running: false }
  }

  async #probe(file) {
    const hit = this.probes.get(file)
    if (hit && Date.now() - hit.at < 30_000) return hit.probe
    const probe = await probeVideo(file, { open: this.deps.steps?.open })
    this.probes.set(file, { at: Date.now(), probe })
    return probe
  }

  /**
   * 面板里每改一项就问一次：这个视频用几场、够不够、大约多久、选的识别行不行。
   * q：{ file, kind, recognition, translate, notes, language, target }
   */
  async quote(q) {
    const s = this.deps.settings()
    const plan = s.plan === 'member' ? 'member' : 'own'
    const probe = await this.#probe(q.file)
    const member = this.deps.member
    if (plan === 'member') await member?.refresh({ maxAge: 30_000 })
    const trial = plan === 'member' && member?.info?.kind !== 'paid'
    const balance = plan === 'member' ? member?.info?.balance ?? 0 : null
    // 云识别：会员走我们服务器，自带 Key 要有 Soniox 的 Key
    const cloud = plan === 'member' || Boolean(s.sonioxKey)
    const out = { ok: probe.ok, probe, plan, trial, balance, cloudAvailable: cloud, errors: [] }
    if (!probe.ok) {
      out.errors.push({ code: probe.error.code, message: probe.error.message, codecLabel: probe.error.codecLabel })
      return out
    }
    const translate = Boolean(q.translate) && Boolean(q.target) && q.target !== q.language
    const charge = videoCharge({ plan, recognition: q.recognition, ai: translate || Boolean(q.notes), durationMs: probe.durationMs, trial })
    const meeting = q.kind !== 'class'
    const est = estimates({ D: probe.durationMs / 1000, recognition: q.recognition, translate, meeting, frames: !meeting && probe.hasVideo, notes: Boolean(q.notes) })
    Object.assign(out, { sessions: charge.sessions, unit: charge.unit, estSec: Math.round(sum(est)), translate })
    if (q.recognition === 'local' && needsMultilingual(q.language)) out.errors.push({ code: 'local-language', message: t('本地识别只认中文和英文') })
    if (q.recognition === 'cloud' && !cloud) out.errors.push({ code: 'no-cloud-key', message: t('云识别要先填 Soniox 的 Key') })
    // 自带 Key：翻译和笔记要 AI，没连上就先说清楚（会员的 AI 不够场次由下面的场次检查说）
    if (plan === 'own' && (translate || q.notes) && this.deps.aiStatus) {
      const st = this.deps.aiStatus()
      if (!st.ready) out.errors.push({ code: 'no-ai', message: st.reason || t('AI 服务还没连上') })
    }
    if (charge.sessions) {
      const e = enough(charge.sessions, balance)
      out.enough = e.ok
      if (!e.ok) out.errors.push({ code: 'no-balance', message: t(`场次不够：这个视频要用 {0} 场，你还剩 {1} 场`, e.need, e.have), need: e.need, have: e.have })
    }
    return out
  }

  /** 开始处理。→ { ok: true } | { ok: false, error, code }。做完发 video:done，失败发 video:failed。 */
  async start(opts) {
    if (this.job) return { ok: false, code: 'busy-video', error: t('已经在处理一个视频了，等它做完再加下一个') }
    if (this.deps.busy?.()) return { ok: false, code: 'busy', error: t('正在记录会议，先停止记录再处理视频') }
    const q = await this.quote(opts)
    const bad = q.errors[0]
    if (bad) return { ok: false, code: bad.code, error: bad.message, need: bad.need, have: bad.have }
    const ctl = new AbortController()
    const job = { file: opts.file, name: path.basename(opts.file), startedAt: Date.now(), ctl, progress: null }
    this.job = job
    const { emit } = this.deps
    emit('video:state', this.snapshot())
    this.#run(job, opts).catch(() => {})
    return { ok: true }
  }

  async #run(job, opts) {
    const d = this.deps
    const workers = d.makeWorkers()
    try {
      const r = await runVideo(
        { ...d, audioWorker: workers.audio, frameWorker: workers.frames, emit: (ch, p) => (ch === 'video:progress' && (job.progress = p), ch === 'video:started' && (job.sessionId = p.sessionId), d.emit(ch, p)) },
        opts,
        { signal: job.ctl.signal },
      )
      this.job = null
      d.emit('video:done', { sessionId: r.sessionId, name: job.name, partial: r.partial, notesError: r.notesError, translateFailed: r.translateFailed, usage: r.usage, timings: r.timings, sessions: r.sessions })
      d.emit('video:state', this.snapshot())
      d.notify?.({ title: t('视频处理好了'), body: job.name, sessionId: r.sessionId })
    } catch (e) {
      this.job = null
      const cancelled = e.name === 'AbortError' || job.ctl.signal.aborted
      d.emit('video:failed', { name: job.name, sessionId: job.sessionId ?? null, cancelled, error: cancelled ? t('已取消') : e.message, code: e.code ?? null })
      d.emit('video:state', this.snapshot())
    } finally {
      workers.audio?.close()
      workers.frames?.close()
    }
  }

  /** 取消：没开始的段不扣；已经开了的那一场按后台的规矩（不到 5 分钟退回）。 */
  cancel() {
    if (!this.job) return false
    this.job.ctl.abort()
    return true
  }
}
