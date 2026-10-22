import fs from 'node:fs'
import path from 'node:path'
import { dbfs } from './audio/gate.js'
import { MacSystemAudio } from './audio/macTap.js'
import { WavCapture, readWavAt } from './audio/wav.js'
import { enrollFrom, loadVoiceprintModel, pcm16ToFloat32, voiceprintSelfTest } from './audio/voiceprint.js'
import { runAnswerSelfTest } from './assist/answerSelftest.js'
import { recordVoiceprint } from './enroll.js'
import { aggregateTodos } from './todos.js'
import { resolveMode } from './modes.js'
import { renderPdf } from './class/pdfRender.js'

// 无界面自测，给 CI 和本机验证用：
//   --selftest=capture:8     只抓系统声音 8 秒，统计收到多少音频、最大电平
//   --selftest=asr:20        用当前设置完整跑 20 秒（采集 + 识别 + 说话人 + 译文术语 + 答题 + 存档）
//     --fake-system=a.wav    用文件代替电脑声音，按实时速度喂；给了任何 --fake-* 就不开真实设备
//     --fake-mic=b.wav       用文件代替麦克风
//     --fake-voiceprint=c.wav  先用这个文件注册声纹（存进 MEETCAPTION_USERDATA），不开麦克风
//     用了假音源时秒数可以省略：按最长的文件再加 15 秒
//     --project=<id 或名字>  在这个项目里开会（用它的会议背景、术语、我的资料、对方语言），不给就是当前项目
//     --summary              停止后生成纪要和待办，报告每条待办归到哪个项目（课堂是课堂笔记和作业）
//     --mode=class|interview|meeting  模式，不给用项目的默认模式
//     --class-source=mic|system       课堂的声音来源；不给时只有 --fake-mic 算教室现场，有 --fake-system 算网课
//     --slides=30,90         开始后第 30、90 秒各截一次画面（要屏幕录制权限）
//   --selftest=library       只看项目和会议：根目录、迁移了什么、项目列表、每个项目的会议和待办
//   --selftest=voiceprint    加载声纹模型算一次向量（验证打包后的原生库和模型）
//   --selftest=enroll:12 --fake-mic=c.wav  走一遍界面上「录制声纹」的流程（进度、音量、注册、存档），麦克风换成文件
//   --selftest=notes --session=<id>  给已有的一节课重新生成课堂笔记和图文版（课堂笔记.html）；--html-only 只重做图文版
//   --selftest=answer        打开答题框，真点一下按钮（Windows CI 验证不抢焦点）
// 结果写到 MEETCAPTION_SELFTEST_OUT（没设就打到 stdout）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function report(result) {
  const text = JSON.stringify(result, null, 2)
  if (process.env.MEETCAPTION_SELFTEST_OUT) fs.writeFileSync(process.env.MEETCAPTION_SELFTEST_OUT, text)
  else console.log(text)
}

function argRaw(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : null
}

function argValue(name) {
  const v = argRaw(name)
  return v ? path.resolve(v) : null
}

const hasFlag = (name) => process.argv.includes(`--${name}`)

function findProject(projects, key) {
  const list = projects.list()
  return list.find((p) => p.id === key) ?? list.find((p) => p.name === key) ?? null
}

// 项目、会议、待办的现状（端到端测试用来核对迁移和归属）
function libraryReport({ projects, store, library }) {
  const records = store.records()
  const known = new Set(projects.list().map((p) => p.id))
  const todos = aggregateTodos(records, { includeDone: true, knownProjects: known })
  return {
    root: projects.root(),
    migration: library ? { moved: library.moved, settingsMigrated: library.settingsMigrated } : null,
    projects: projects.list().map((p) => ({
      id: p.id,
      name: p.name,
      folder: p.folder,
      language: p.language,
      context: p.context,
      keywords: p.keywords,
      profile: p.profile ? `${p.profile.length} 字` : '',
      sessions: records.filter((r) => r.projectId === p.id).map((r) => r.id),
      todos: todos.filter((t) => t.projectId === p.id).map((t) => ({ text: t.text, due: t.due, dueText: t.dueText, owner: t.owner, from: t.sessionId })),
    })),
  }
}

async function captureOnly(seconds, { capture }) {
  const stats = { platform: process.platform, bytes: 0, chunks: 0, maxDb: -100, loudChunks: 0, errors: [] }
  const onPcm = (_source, buf) => {
    stats.bytes += buf.length
    stats.chunks++
    const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1)
    const db = dbfs(samples)
    stats.maxDb = Math.max(stats.maxDb, Math.round(db * 10) / 10)
    if (db > -50) stats.loudChunks++
  }
  let tap
  try {
    if (process.platform === 'darwin') {
      tap = new MacSystemAudio({ sampleRate: 16000 })
      tap.on('data', (buf) => onPcm('system', Buffer.from(buf)))
      tap.on('error', (e) => stats.errors.push(e.message))
      tap.start()
    } else {
      await capture.start({ system: true, mic: false, sampleRate: 16000, onPcm, onError: (_s, m) => stats.errors.push(m) })
    }
    await sleep(seconds * 1000)
  } catch (e) {
    stats.errors.push(e.message)
  } finally {
    tap?.stop()
    capture.stop()
  }
  stats.seconds = stats.bytes / 32000
  stats.ok = stats.bytes > 0 && stats.errors.length === 0
  report(stats)
  return stats.ok ? 0 : 1
}

// 从文件注册声纹，代替 voiceprint:enroll 的麦克风录音
async function enrollFromFile(file, vpStore) {
  const t0 = Date.now()
  const model = await loadVoiceprintModel()
  const profile = enrollFrom(pcm16ToFloat32(readWavAt(file, 16000)), model)
  vpStore.save(profile)
  return { file: path.basename(file), seconds: profile.seconds, modelId: profile.modelId, ms: Date.now() - t0 }
}

const round = (x) => (x == null ? null : Math.round(x))

async function fullRun(secs, ctx) {
  const { engine, settings, store, projects, summarizer, library, assistant, vpStore } = ctx
  const fake = { system: argValue('fake-system'), mic: argValue('fake-mic') }
  const fakeVp = argValue('fake-voiceprint')
  const s = settings.get()
  const result = { ok: false, engine: s.engine, llmProvider: s.llmProvider, captureMic: s.captureMic, translate: s.translate, terms: s.terms, assist: { ...s.assist, profile: s.assist.profile ? `${s.assist.profile.length} 字` : '' } }
  const notices = []
  const traces = []
  const segEvents = new Map()
  const dropped = []
  const answers = new Map()
  const notesEvents = []
  const slideEvents = []
  let t0 = Date.now()
  const rel = () => Date.now() - t0

  try {
    if (fakeVp) result.voiceprint = await enrollFromFile(fakeVp, vpStore)
  } catch (e) {
    report({ ok: false, error: `注册声纹失败：${e.message}`, code: e.code })
    return 1
  }
  let seconds = secs
  if (fake.system || fake.mic) {
    engine.useFakeSources(fake)
    const longest = Math.max(...[fake.system, fake.mic].filter(Boolean).map((f) => readWavAt(f, 16000).length / 16000))
    seconds ||= Math.ceil(longest + 15)
    result.fake = { system: fake.system && path.basename(fake.system), mic: fake.mic && path.basename(fake.mic), seconds: Math.round(longest * 10) / 10 }
  }
  seconds ||= 10

  engine.on('notice', (n) => notices.push(n))
  engine.on('trace', (t) => {
    if (t.type === 'fake-start') t0 = t.at
    traces.push({ ...t, t: rel() })
  })
  engine.on('segment', (seg) => {
    if (seg.dropped) dropped.push({ t: rel(), source: seg.source, text: seg.droppedText, vp: seg.vp ?? null, reason: seg.dropped })
    else if (seg.final && !segEvents.has(seg.id)) segEvents.set(seg.id, rel())
  })
  engine.on('notes', (n) => {
    const x = n.notes ?? {}
    notesEvents.push({ t: rel(), ok: !n.error, error: n.error, sections: x.sections?.length ?? 0, emphasis: x.emphasis?.length ?? 0, homework: x.homework?.length ?? 0, terms: x.terms?.length ?? 0, titles: (x.sections ?? []).map((s) => `[${s.start ?? '?'}] ${s.title}`) })
  })
  engine.on('slide', (x) => slideEvents.push({ t: rel(), file: x.file }))
  assistant?.on('answer', (a) => {
    const r = answers.get(a.id) ?? { firstTextAt: null }
    if (a.text && r.firstTextAt == null) r.firstTextAt = rel()
    if (a.done && r.doneAt == null) r.doneAt = rel()
    answers.set(a.id, { ...r, a })
  })

  const projectKey = argRaw('project')
  const project = projectKey ? findProject(projects, projectKey) : projects.get(settings.get().currentProjectId) ?? projects.get('inbox')
  if (!project) {
    report({ ...result, error: `找不到项目 ${projectKey}` })
    return 1
  }
  result.project = { id: project.id, name: project.name, language: project.language, context: project.context, keywords: project.keywords, profile: project.profile ? `${project.profile.length} 字` : '' }

  const modeArg = argRaw('mode')
  const srcArg = argRaw('class-source') ?? (fake.system ? 'system' : fake.mic ? 'mic' : null)
  const m = resolveMode({ mode: modeArg, classSource: srcArg }, project, settings.get())
  result.mode = m.mode
  result.classSource = m.classSource
  try {
    await engine.start({ project, mode: m.mode, classSource: m.classSource })
  } catch (e) {
    report({ ...result, error: e.message, notices })
    return 1
  }
  const sessionId = engine.session.id
  const slideTimers = (argRaw('slides') ?? '')
    .split(',')
    .map(Number)
    .filter((x) => x > 0)
    .map((sec) => setTimeout(async () => slideEvents.push({ t: rel(), requestedAt: sec, ...(await ctx.captureSlide()) }), sec * 1000))
  await sleep(seconds * 1000)
  for (const t of slideTimers) clearTimeout(t)
  // 答题还在出字就等它说完再停
  const deadline = Date.now() + 30_000
  while ([...answers.values()].some((x) => !x.a.done) && Date.now() < deadline) await sleep(200)
  await engine.stop()
  // 课堂：下课后最后一次整理实时笔记
  if (engine.notesFlush) await Promise.race([engine.notesFlush, sleep(240_000)])
  const saved = store.load(sessionId)
  const asks = traces.filter((t) => t.type === 'ask')

  result.sessionId = sessionId
  result.sessionDir = store.dir(sessionId)
  result.sessionProjectId = saved.projectId
  result.voiceprintLoaded = traces.some((t) => t.type === 'voiceprint')
  result.segments = saved.segments.map((x) => ({
    finalAt: segEvents.get(x.id) ?? null,
    source: x.source,
    who: x.who,
    speaker: x.speaker,
    question: Boolean(x.question),
    vp: x.vp ?? null,
    text: x.text,
    ...(x.orig ? { orig: x.orig } : {}), // AI 纠错前的识别原文
    fixes: x.sentences.filter((y) => y.orig).map((y) => ({ orig: y.orig, text: y.text })),
    tr: x.sentences.map((y) => y.tr).filter(Boolean).join(' '),
    chunks: x.sentences.map((y) => (y.chunks ?? []).map((c) => `${c.en} ⇒ ${[].concat(c.zh).join(' … ')}`)).filter((c) => c.length),
    terms: x.sentences.flatMap((y) => y.terms ?? []),
  }))
  result.liveNotes = { updates: notesEvents, final: saved.liveNotes ?? null, updatedAt: saved.liveNotesAt ?? null }
  if (m.mode === 'class') {
    result.slides = { events: slideEvents, saved: saved.slides ?? [] }
  }
  result.dropped = dropped
  result.who = traces.filter((t) => t.type === 'who').map(({ t, text, who, score, how }) => ({ t, who, score, how, text }))
  result.asks = asks.map(({ t, reason, question, segIds }) => ({ t, reason, question, segs: segIds.length }))
  result.answers = [...answers.values()].map(({ a, firstTextAt, doneAt }) => ({
    reason: a.reason,
    question: a.question,
    text: a.text,
    error: a.error,
    warning: a.warning,
    cancelled: a.cancelled,
    withScreen: a.withScreen,
    timing: a.timing,
    firstTextAt,
    doneAt,
  }))
  result.savedAnswers = (saved.answers ?? []).length
  const enh = traces.filter((t) => t.type === 'enhance')
  result.enhance = enh.map(({ t, ms, trMs, translate, chunks, terms, correct, chunkCount, coverage, termsNoZh, text, fixed, fixDropped }) => ({ t, ms, trMs, translate, chunks, terms, correct, chunkCount, coverage, termsNoZh, text, fixed, fixDropped }))
  const covs = enh.filter((t) => t.coverage != null).map((t) => t.coverage)
  if (covs.length) result.chunkStats = { sentences: covs.length, avgCoverage: round((covs.reduce((a, b) => a + b, 0) / covs.length) * 100), below70: covs.filter((c) => c < 0.7).length, singleColor: enh.filter((t) => t.chunks && (t.chunkCount ?? 0) < 2).length }
  const scoreTraces = traces.filter((t) => t.type === 'score')
  const scores = scoreTraces.map((t) => t.ms).sort((a, b) => a - b)
  const trMs = enh.map((t) => t.trMs ?? (t.translate ? t.ms : null)).filter((x) => x != null).sort((a, b) => a - b)
  const warm = traces.find((t) => t.type === 'warm')
  result.timing = {
    enhanceMs: enh.length ? { median: round(enh.map((t) => t.ms).sort((a, b) => a - b)[enh.length >> 1]), max: Math.max(...enh.map((t) => t.ms)) } : null,
    // 译文出现（流式收到 JSON 里的 tr）比请求发出晚多少
    trMs: trMs.length ? { median: trMs[trMs.length >> 1], max: trMs.at(-1) } : null,
    warm: warm ? { t: warm.t, ms: warm.ms, ok: warm.ok, error: warm.error ?? null, screenMs: warm.screenMs ?? null } : null,
    scoreMs: scores.length ? { count: scores.length, median: scores[scores.length >> 1], max: scores.at(-1), maxSeconds: scoreTraces.find((t) => t.ms === scores.at(-1))?.seconds ?? null } : null,
    voiceprintLoadMs: traces.find((t) => t.type === 'voiceprint')?.ms ?? null,
    // ChatGPT 通道上给答题让路、停掉后重发的译文请求
    enhanceYielded: traces.filter((t) => t.type === 'enhance-yield').map(({ t, text }) => ({ t, text })),
  }
  result.notices = notices
  result.ok = saved.segments.length > 0
  if (hasFlag('summary') && result.ok) {
    const t1 = Date.now()
    const names = new Map(projects.list().map((p) => [p.id, p.name]))
    try {
      const r = await summarizer.generate(sessionId)
      const after = store.load(sessionId)
      result.summary = {
        kind: after.mode === 'class' ? '课堂笔记' : '会议纪要',
        ms: Date.now() - t1,
        chars: r.markdown.length,
        markdown: r.markdown,
        title: after.title,
        itemsError: r.itemsError ?? null,
        items: (after.summary?.items ?? []).map((x) => ({ project: names.get(x.projectId) ?? x.projectId, text: x.text, due: x.due, dueUncertain: Boolean(x.dueUncertain), dueText: x.dueText, owner: x.owner, at: x.at, quote: x.quote })),
      }
    } catch (e) {
      result.summary = { error: e.message }
      result.ok = false
    }
  }
  result.library = libraryReport({ projects, store, library })
  report(result)
  return result.ok ? 0 : 1
}

// 自测里抛出来的错（音频文件路径不对等）也要写结果、退出，不然进程一直挂着
export async function runSelfTest(arg, ctx) {
  try {
    return await runKind(arg, ctx)
  } catch (e) {
    report({ ok: false, error: `自测出错：${e?.message ?? e}` })
    return 1
  }
}

async function runKind(arg, ctx) {
  const [kind, secs] = arg.replace(/^--selftest=?/, '').split(':')
  if (kind === 'asr') return fullRun(Number(secs) || 0, ctx)
  if (kind === 'library') {
    report({ ok: true, ...libraryReport(ctx) })
    return 0
  }
  if (kind === 'voiceprint') {
    const r = await voiceprintSelfTest()
    report(r)
    return r.ok ? 0 : 1
  }
  if (kind === 'enroll') {
    const mic = argValue('fake-mic')
    if (!mic) {
      report({ ok: false, error: '要给 --fake-mic=文件，自测不开真实麦克风' })
      return 1
    }
    const progress = []
    const t0 = Date.now()
    const r = await recordVoiceprint({ capture: new WavCapture({ mic }), store: ctx.vpStore, seconds: Number(secs) || 12, onProgress: (p) => progress.push({ t: Date.now() - t0, ...p }) })
    const out = { ok: r.ok, error: r.error, code: r.code, seconds: r.profile?.seconds, saved: ctx.vpStore.load() ? true : false, progress }
    report(out)
    return r.ok ? 0 : 1
  }
  // 课件：--selftest=pdf --pdf=课件.pdf，逐页取文字和图（打包版上确认 pdf.js 从 asar 里加载得了）
  if (kind === 'pdf') {
    const file = argValue('pdf')
    if (!file) {
      report({ ok: false, error: '要给 --pdf=文件' })
      return 1
    }
    const pages = []
    const t0 = Date.now()
    await renderPdf(file, (n, total, { text, lines, width, height, jpeg }) => pages.push({ n, total, chars: text.length, head: text.slice(0, 60), size: [width, height], lines: lines.length, firstLine: lines[0] ?? null, jpegBytes: jpeg.length }))
    report({ ok: pages.length > 0 && pages.every((p) => p.jpegBytes > 1000), ms: Date.now() - t0, pages })
    return pages.length ? 0 : 1
  }
  // 图文版课堂笔记：--selftest=notes --session=<会议 id>，给已有的一节课重新生成课堂笔记和图文版；--html-only 只重做图文版
  if (kind === 'notes') {
    const id = argRaw('session')
    if (!id) {
      report({ ok: false, error: '要给 --session=会议 id' })
      return 1
    }
    const t0 = Date.now()
    const r = hasFlag('html-only') ? await ctx.summarizer.buildHtml(id) : await ctx.summarizer.generate(id, '')
    const s = ctx.store.load(id)
    const file = path.join(ctx.store.dir(id), s.summary?.html ?? '')
    const map = (s.summary?.slideMap ?? []).map((x) => ({ page: `${x.m} p${x.p}`, section: x.s, points: x.points.map((p) => ({ lines: p.lines, at: p.at, text: p.text.slice(0, 60) })) }))
    report({ ok: Boolean(s.summary?.html) && fs.existsSync(file), ms: Date.now() - t0, html: file, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0, htmlError: r.htmlError ?? null, itemsError: r.itemsError ?? null, slideMap: map })
    return s.summary?.html ? 0 : 1
  }
  if (kind === 'answer') {
    const r = await runAnswerSelfTest({ preload: path.join(ctx.root, 'preload/answer.cjs'), page: path.join(ctx.root, 'renderer/answer/index.html') })
    report(r)
    return r.ok ? 0 : 1
  }
  return captureOnly(Number(secs) || 10, ctx)
}
