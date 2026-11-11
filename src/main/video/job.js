import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openMedia, MediaError } from './demux.js'
import { extractAudio, readPcm } from './audio.js'
import { recognizeCloud, recognizeLocal } from './recognize.js'
import { scanFrames } from './frames.js'
import { labelSpeakers } from './speakers.js'
import { translateAll } from './translate.js'
import { applySpeakers, applyTranslations, buildSegments } from './segments.js'
import { saveVideoSlide } from './slides.js'
import { enough, segmentsFor, videoCharge } from './charge.js'
import { needsMultilingual } from '../languages.js'
import { keywordList } from '../defaults.js'
import { t } from '../i18n.js'

// 一个视频从头到尾：读出声音 → 识别（本地或云）→ 翻译 → 分说话人（会议）→ 截画面（课）→ 写笔记或纪要。
// 做成一场「会议」存进项目里，和实时记下来的会议一样：session.json、字幕记录、课堂笔记或会议纪要，另带 session.video（见下面的 meta）。
// 会员的场次：视频按每场能管的时长切成几段，一段开一场（member.startSession 扣一场），这一段识别和翻译完结束它，
// 最后的笔记用刚结束那一场的票做（24 小时内有效）。处理中取消：没开始的段不扣，已经开的那一场不退（不到 5 分钟后台自己退）。
// 不引 electron，依赖都从 deps 传进来，单测用假的。

// 每一步大约要多久（秒），按视频时长 D（秒）估：用来算总进度和「还要约几分钟」，做到哪一步之后按实测速度改
export function estimates({ D, recognition, translate, meeting, frames, notes }) {
  return {
    audio: 2 + D / 150,
    recognize: recognition === 'cloud' ? 5 + D / 3 : 3 + D / 20 + (translate ? 3 + D / 70 : 0),
    speakers: meeting ? 2 + D / 60 : 0,
    frames: frames ? 2 + D / 45 : 0,
    notes: notes ? 45 + D / 100 : 0,
  }
}

/** 进度：各步的状态和比例、总比例、还要多久。 */
export class Progress {
  constructor({ steps, est, durationMs, onChange }) {
    this.steps = steps.map((s) => ({ ...s, state: 'todo', fraction: 0, startedAt: null }))
    this.est = est
    this.durationMs = durationMs
    this.onChange = onChange
    this.atMs = 0
    this.last = 0
  }

  start(id) {
    const s = this.steps.find((x) => x.id === id)
    if (s && s.state === 'todo') Object.assign(s, { state: 'active', startedAt: Date.now() })
    this.#emit(true)
  }

  update(id, fraction, atMs) {
    const s = this.steps.find((x) => x.id === id)
    if (!s) return
    if (s.state === 'todo') s.startedAt = Date.now()
    if (s.state !== 'done') s.state = 'active'
    s.fraction = Math.max(s.fraction, Math.min(1, fraction))
    if (atMs != null && id === 'recognize') this.atMs = Math.max(this.atMs, atMs)
    this.#emit()
  }

  done(id) {
    const s = this.steps.find((x) => x.id === id)
    if (!s) return
    Object.assign(s, { state: 'done', fraction: 1 })
    this.#emit(true)
  }

  /** 还要多久（秒）：声音、识别、分说话人排着队，画面同时做；笔记等它们都完了才开始。 */
  etaSec() {
    const left = (s) => {
      if (!s || s.state === 'done') return 0
      const total = this.est[s.id] ?? 0
      if (s.state === 'active' && s.fraction > 0.04 && s.startedAt) {
        const e = (Date.now() - s.startedAt) / 1000
        return (e * (1 - s.fraction)) / s.fraction
      }
      return total * (1 - s.fraction)
    }
    const by = (id) => this.steps.find((x) => x.id === id)
    const chain = left(by('audio')) + left(by('recognize')) + left(by('speakers'))
    return Math.round(Math.max(chain, left(by('frames'))) + left(by('notes')))
  }

  fraction() {
    let total = 0
    let got = 0
    for (const s of this.steps) {
      const w = this.est[s.id] ?? 1
      total += w
      got += w * (s.state === 'done' ? 1 : s.fraction)
    }
    return total ? got / total : 0
  }

  snapshot() {
    return {
      steps: this.steps.map((s) => ({ id: s.id, label: s.label, state: s.state, fraction: s.fraction })),
      fraction: this.fraction(),
      atMs: this.atMs,
      durationMs: this.durationMs,
      etaSec: this.etaSec(),
    }
  }

  #emit(force = false) {
    const now = Date.now()
    if (!force && now - this.last < 400) return
    this.last = now
    this.onChange?.(this.snapshot())
  }
}

/**
 * 处理前先看一眼：打开文件读出时长、有没有画面、声音能不能读；按选项算要几场。给「加一个视频」面板用。
 * → { ok, file, name, size, durationMs, hasVideo, video, audio: { codec }, error?: { code, message, codecLabel } }
 */
export async function probeVideo(file, { open = openMedia } = {}) {
  const st = (() => {
    try {
      return fs.statSync(file)
    } catch {
      return null
    }
  })()
  const base = { file, name: path.basename(file), size: st?.size ?? 0 }
  try {
    const m = await open(file)
    const out = { ok: true, ...base, durationMs: m.durationMs, hasVideo: m.hasVideo, video: m.video, kind: m.kind, audio: { codec: m.audio.codec } }
    await m.close()
    return out
  } catch (e) {
    if (!(e instanceof MediaError)) throw e
    return { ok: false, ...base, durationMs: e.durationMs ?? 0, hasVideo: Boolean(e.hasVideo), error: { code: e.code, message: e.message, codecLabel: e.codecLabel ?? null } }
  }
}

/**
 * 跑一个视频。opts：{ file, kind: 'class' | 'meeting', language, target, translate, notes, recognition: 'local' | 'cloud', projectId, title? }
 * deps：{ store, projects, settings(), member, llm, summarizer, audioWorker, frameWorker, voiceprint（loadVoiceprintScorer）, emit, tmpDir?, steps? }
 * ctl：{ signal }。
 * → { sessionId, partial?, notesError?, translateFailed? }；失败抛错，没处理完的会议已经删掉。
 */
export async function runVideo(deps, opts, ctl = {}) {
  const { store, projects, member, signal } = { ...deps, ...ctl }
  const impl = { open: openMedia, extract: extractAudio, local: recognizeLocal, cloud: recognizeCloud, frames: scanFrames, speakers: labelSpeakers, translate: translateAll, ...deps.steps }
  const s = deps.settings()
  const plan = s.plan === 'member' ? 'member' : 'own'
  const meeting = opts.kind !== 'class'
  const translate = Boolean(opts.translate) && opts.target && opts.target !== opts.language && !(opts.target === 'zh-Hant' && opts.language === 'zh')
  const notes = Boolean(opts.notes)
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  const started = Date.now()
  const timings = {}

  const media = await impl.open(opts.file)
  let session = null
  let pcm = null
  let slides = []
  let frameJob = null
  const sessionsUsed = { n: 0 }
  try {
    check()
    // 取消时马上关掉隐藏窗口，正在里面跑的解码和截画面当场停（不等它这一轮做完）
    signal?.addEventListener('abort', () => (deps.frameWorker?.close(), deps.audioWorker?.close()), { once: true })
    const durationMs = media.durationMs
    const trial = plan === 'member' && member?.info?.kind !== 'paid'
    const charge = videoCharge({ plan, recognition: opts.recognition, ai: translate || notes, durationMs, trial })
    if (opts.recognition === 'local' && needsMultilingual(opts.language)) throw new MediaError('local-language', t('本地识别只认中文和英文，这个视频要用云识别'))
    if (charge.sessions) {
      await member.refresh()
      const bal = enough(charge.sessions, member.info?.balance)
      if (!bal.ok) throw Object.assign(new MediaError('no-balance', t(`场次不够：这个视频要用 {0} 场，你还剩 {1} 场`, bal.need, bal.have)), { need: bal.need, have: bal.have })
    }
    const withFrames = !meeting && media.hasVideo
    const progress = new Progress({
      steps: [
        { id: 'audio', label: t('读出声音') },
        { id: 'recognize', label: translate ? t('识别和翻译') : t('识别') },
        meeting && { id: 'speakers', label: t('分说话人') },
        withFrames && { id: 'frames', label: t('截课件画面') },
        notes && { id: 'notes', label: meeting ? t('写纪要') : t('写图文笔记') },
      ].filter(Boolean),
      est: estimates({ D: durationMs / 1000, recognition: opts.recognition, translate, meeting, frames: withFrames, notes }),
      durationMs,
      onChange: (p) => deps.emit('video:progress', { ...p, file: opts.file, name: path.basename(opts.file) }),
    })

    const project = projects.get(opts.projectId)
    const title = String(opts.title ?? '').trim() || path.parse(opts.file).name
    const engineLabel = opts.recognition === 'local' ? '本地识别（X-ASR）' : plan === 'member' ? '会员云识别（Soniox）' : 'Soniox 实时识别'
    const now = Date.now()
    session = store.create({
      projectId: opts.projectId,
      title,
      mode: meeting ? 'meeting' : 'class',
      language: opts.language,
      target: translate ? opts.target : '',
      engine: opts.recognition === 'local' ? 'local' : 'soniox',
      engineLabel,
      startedAt: now,
      endedAt: now + durationMs,
      video: {
        file: opts.file,
        name: path.basename(opts.file),
        size: fs.statSync(opts.file).size,
        durationMs,
        hasVideo: media.hasVideo,
        recognition: opts.recognition,
        plan,
        sessions: charge.sessions,
        translate,
        notes,
        status: 'processing',
      },
    })
    const id = session.id
    deps.emit('video:started', { sessionId: id })
    const dir = store.dir(id)
    const baseAt = session.startedAt
    pcm = path.join(deps.tmpDir ?? os.tmpdir(), `meetcaption-video-${process.pid}-${Date.now()}.pcm`)

    // 截画面和读声音、识别同时做（一个用隐藏窗口里的 <video>，一个用 AudioDecoder，互不抢）
    if (withFrames) {
      progress.start('frames')
      frameJob = impl
        .frames({
          worker: deps.frameWorker,
          file: opts.file,
          durationMs,
          signal,
          onProgress: (ms) => progress.update('frames', ms / durationMs * 0.95),
          onFrame: (ms, jpeg) => slides.push({ file: saveVideoSlide(dir, jpeg, ms), at: baseAt + ms }),
        })
        .then(() => progress.done('frames'))
        .catch((e) => {
          // 画面读不出来、截不完：字幕和笔记照常做，只是没有（或少了）截图
          if (e.name === 'AbortError') throw e
          progress.done('frames')
          timings.framesError = e.message
        })
      frameJob.catch(() => {})
    }

    progress.start('audio')
    let t0 = Date.now()
    await impl.extract(media, pcm, { worker: deps.audioWorker, signal, onProgress: (ms) => progress.update('audio', ms / durationMs) })
    progress.done('audio')
    timings.audio = Date.now() - t0
    check()

    // 按场次切段，一段一场
    const parts = segmentsFor(durationMs, charge.sessions, charge.unit)
    const utterances = []
    const all = { segments: [], sentences: [] }
    const usage = { in: 0, out: 0, calls: 0 }
    const meter = (o) => deps.llm({ ...o, onUsage: (u) => (usage.in += Number(u?.prompt_tokens ?? 0), (usage.out += Number(u?.completion_tokens ?? 0)), o.onUsage?.(u)) })
    let reached = durationMs
    let partialReason = ''
    progress.start('recognize')
    t0 = Date.now()
    let translatedFailed = 0
    for (let k = 0; k < parts.length; k++) {
      const { from, to } = parts[k]
      if (charge.sessions) {
        try {
          await member.startSession()
          sessionsUsed.n++
        } catch (e) {
          if (k === 0) throw e
          // 第一段之后没场次了（别的电脑用掉了）：前面做好的留着，说一声
          reached = from
          partialReason = e.code === 'no-balance' ? t('场次不够了，只处理了前面一段') : e.message
          break
        }
      }
      try {
        const base = from / durationMs
        const part = (to - from) / durationMs
        const frac = (ms) => base + (part * Math.max(0, Math.min(1, (ms - from) / (to - from)))) * (translate ? 0.7 : 1)
        const common = { pcmFile: pcm, durationMs, signal }
        const got =
          opts.recognition === 'cloud'
            ? await impl.cloud({
                ...common,
                // 只认这一段：云识别切块时按段给起止
                fromMs: from,
                toMs: to,
                key: plan === 'member' ? '' : s.sonioxKey,
                getKey: plan === 'member' ? () => member.asrKey() : null,
                language: opts.language,
                context: project?.context ?? '',
                hotwords: keywordList(project ?? {}),
                onProgress: (ms) => progress.update('recognize', frac(from + ms), from + ms),
              })
            : await impl.local({ ...common, fromMs: from, toMs: to, onProgress: (ms) => progress.update('recognize', frac(ms), ms) })
        check()
        const { segments, sentences } = buildSegments(got, { lang: opts.language, baseAt, speaker: meeting ? '' : t('老师') })
        if (translate && segments.length) {
          const r = await impl.translate({
            texts: segments.map((x) => x.text),
            llm: meter,
            target: opts.target,
            source: opts.language,
            context: project?.context ?? '',
            keywords: keywordList(project ?? {}),
            signal,
            onProgress: (done, total) => progress.update('recognize', base + part * (0.7 + 0.3 * (done / Math.max(1, total)))),
          })
          applyTranslations(segments, r.tr)
          translatedFailed += r.failed
        }
        all.segments.push(...segments)
        all.sentences.push(...sentences)
        utterances.push(...got)
      } finally {
        if (charge.sessions) await member.endSession()
      }
    }
    progress.done('recognize')
    timings.recognize = Date.now() - t0
    if (!all.segments.length) throw new MediaError('no-speech', t('没有识别到说话的内容。检查一下视频里有没有人声，或者换一种识别方式'))

    // 分说话人
    let speakers = null
    if (meeting) {
      progress.start('speakers')
      t0 = Date.now()
      try {
        const scorer = await deps.voiceprint?.()
        if (scorer) {
          const fh = await fs.promises.open(pcm, 'r')
          try {
            const r = await impl.speakers(all.sentences, { readPcm: (a, b) => readPcm(pcm, a, b, fh), scorer, signal, onProgress: (f) => progress.update('speakers', f) })
            const names = Array.from({ length: Math.max(1, r.count) }, (_, i) => t(`说话人 {0}`, i + 1))
            applySpeakers(all.segments, r.labels, names)
            speakers = names
          } finally {
            await fh.close()
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e
        timings.speakersError = e.message
      }
      if (!speakers) {
        speakers = [t('说话人 {0}', 1)]
        applySpeakers(all.segments, [], speakers)
      }
      progress.done('speakers')
      timings.speakers = Date.now() - t0
    }
    check()
    if (frameJob) await frameJob
    check()

    // 存进会议文件夹：字幕、截图、各项数字
    slides.sort((a, b) => a.at - b.at)
    store.mutate(id, (x) => {
      x.segments = all.segments
      x.slides = slides
      Object.assign(x.video, {
        speakers: speakers ?? undefined,
        reachedMs: reached,
        partial: reached < durationMs ? partialReason : undefined,
        sessionsUsed: sessionsUsed.n,
        translateFailed: translatedFailed || undefined,
      })
    })
    deps.emit('sessions:changed', { sessionId: id, projectId: opts.projectId })

    // 笔记或纪要
    let notesError = null
    if (notes) {
      progress.start('notes')
      t0 = Date.now()
      try {
        const r = await deps.summarizer.generate(id, '', { now: true, onUsage: (u) => (usage.in += Number(u?.prompt_tokens ?? 0), (usage.out += Number(u?.completion_tokens ?? 0)) , usage.calls++) })
        if (r.itemsError || r.htmlError) notesError = [r.itemsError, r.htmlError].filter(Boolean).join('；')
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e
        notesError = e.message
      }
      progress.done('notes')
      timings.notes = Date.now() - t0
    }
    check()
    timings.total = Date.now() - started
    store.mutate(id, (x) => {
      Object.assign(x.video, { status: 'done', finishedAt: Date.now(), tookMs: timings.total, timings, notesError: notesError ?? undefined })
      x.video.usage = usage
    })
    return { sessionId: id, partial: partialReason || null, notesError, translateFailed: translatedFailed, usage, timings, sessions: sessionsUsed.n }
  } catch (e) {
    // 取消或失败：没做完的会议删掉（识别和字幕都没留）
    if (session) {
      try {
        store.discard(session.id)
      } catch {}
    }
    throw e
  } finally {
    await media.close().catch(() => {})
    if (pcm) fs.rm(pcm, { force: true }, () => {})
  }
}
