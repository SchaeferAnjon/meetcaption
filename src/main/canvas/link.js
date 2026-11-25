import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { INBOX_ID } from '../projects.js'
import { parseAt } from '../todos.js'
import { AUDIO_FILE } from './audioRec.js'
import { AudioStore } from './audioStore.js'
import { turnOnLinks } from './familyLinks.js'
import { canvasNotesMcUrl, clockLabel, mcFrameName, mcRecordingDir, mcSubtitlePath, writeMcRecord, writeVtt } from './format.js'

// 和画布笔记连库（MeetCaption 联动，设计 24「已定（2026-11-23）」；接口照画布笔记、画布今日那两侧的清单）：
// - 连库：库里写 .canvas-notes/meetcaption.json（每个项目对哪个文件夹、什么模式、日历名、课表），画布笔记的文件夹首页组件、画布今日的「今天的课」读它；
// - 上课 / 下课：设置目录里写 canvas-notes-live.json（session、startedAt、project、mode、file、endedAt、todos），画布笔记、画布今日看正在上哪节课；
// - 一场一篇上课记录（同一项目、同一天、隔不到 1 小时的并成一篇）：照 format.js 的 writeMcRecord 写进对上的文件夹的「上课记录」/「会议记录」；
//   字幕全文写 .canvas-notes/字幕/meetcaption/<场>.vtt，关键画面和录音写进录音那一处（三种存法见 audioStore.js）。
// - 用户在画布笔记里改过那一篇：不再盖它（记着上次写的内容的哈希，对不上就只更新字幕、画面、录音，不动那一篇）。

export const MAP_FILE = '.canvas-notes/meetcaption.json'
export const LIVE_NAME = 'canvas-notes-live.json'
const WRITTEN = 'canvas-written.json'
const MERGE_GAP_MS = 60 * 60_000

const pad = (n) => String(n).padStart(2, '0')
const dayOf = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const clockOf = (ms) => {
  const d = new Date(ms)
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
}
const sha = (s) => createHash('sha1').update(s).digest('hex')
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
const safeName = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'MeetCaption'

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.mc-${process.pid}.tmp`)
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

/** 画布笔记上次打开的库（读它的设置；没装或读不到是 null）。appData：系统的应用数据文件夹 */
export function detectVault(appData) {
  const s = readJson(path.join(appData, 'canvas-notes', 'settings.json'), null)
  const v = s && typeof s.lastVault === 'string' ? s.lastVault : null
  return v && fs.existsSync(v) ? v : null
}

/** 项目的模式 → 画布笔记那边的五种 */
export const mcModeOfProject = (p) => (p.mode === 'class' ? (p.classSource === 'system' ? 'online' : 'class') : p.mode === 'interview' ? 'interview' : 'meeting')

/** 库里的文件夹（3 层以内，跳过点开头的），相对路径 */
function vaultDirs(vault) {
  const out = []
  const walk = (rel, depth) => {
    if (depth > 3) return
    let ents
    try {
      ents = fs.readdirSync(path.join(vault, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      out.push(r)
      walk(r, depth + 1)
    }
  }
  walk('', 1)
  return out
}

/** 按名字在库里找这个项目的文件夹：同名，或者文件夹名以项目名开头接着分隔符（「ECP-Emerging-…」对 ECP） */
export function matchFolder(dirs, name) {
  const n = norm(name)
  if (!n) return null
  const base = (d) => d.split('/').pop()
  return dirs.find((d) => norm(base(d)) === n) ?? dirs.find((d) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\-_·.:]`, 'i').test(base(d))) ?? null
}

/** 过去 8 周里同一个星期几、同一刻钟开始过两次以上的，当成课表 */
export function inferSchedule(startTimes, now = Date.now()) {
  const count = new Map()
  for (const ms of startTimes) {
    if (now - ms > 56 * 86400_000) continue
    const d = new Date(ms)
    const q = Math.round((d.getHours() * 60 + d.getMinutes()) / 15) * 15
    const key = `${d.getDay()} ${pad(Math.floor(q / 60) % 24)}:${pad(q % 60)}`
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  return [...count]
    .filter(([, n]) => n >= 2)
    .map(([k]) => ({ weekday: Number(k.split(' ')[0]), time: k.split(' ')[1] }))
    .sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time))
}

/** 一场的字幕 → vtt 的句子：一段里几句按字数分这段的时间；说话人写名字 */
export function sessionCues(s) {
  const segs = (s.segments ?? []).filter((x) => x?.text)
  const cues = []
  segs.forEach((seg, i) => {
    const start = Math.max(0, ((seg.startedAt ?? s.startedAt) - s.startedAt) / 1000)
    const nextAt = segs[i + 1]?.startedAt
    const end = Math.max(start + 0.5, ((seg.endedAt ?? nextAt ?? seg.startedAt + 3000) - s.startedAt) / 1000)
    const sens = (seg.sentences ?? []).filter((x) => x?.text)
    const parts = sens.length ? sens : [{ text: seg.text, tr: (seg.sentences ?? []).map((x) => x.tr).filter(Boolean).join(' ') }]
    const total = parts.reduce((a, p) => a + p.text.length, 0) || 1
    let at = start
    for (const p of parts) {
      const d = ((end - start) * p.text.length) / total
      const clean = (x) => String(x ?? '').replace(/\s*\n\s*/g, ' ').trim()
      cues.push({ start: at, end: at + d, text: clean(p.text), ...(clean(p.tr) ? { tr: clean(p.tr) } : {}), ...(seg.speaker ? { who: String(seg.speaker).replace(/[<>]/g, '') } : {}) })
      at += d
    }
  })
  return cues
}

/** 一场 → 上课记录里的一段（小节、点、关键画面）和作业 */
export function sessionPart(s) {
  const dur = Math.max(0, ((s.endedAt ?? Date.now()) - s.startedAt) / 1000)
  const secOf = (v) => {
    const ms = parseAt(v)
    return ms == null ? null : Math.floor(ms / 1000)
  }
  let sections = []
  const ln = s.liveNotes?.sections ?? []
  if (ln.length) {
    let last = 0
    sections = ln.map((x) => {
      const t = Math.max(last, secOf(x.start) ?? last)
      last = t
      return { title: String(x.title || '…').replace(/\s*\n\s*/g, ' '), t, raw: x.points ?? [] }
    })
  } else {
    // 没有实时笔记（会议、没开 AI）：每 5 分钟一节，标题用这一节第一句
    const segs = (s.segments ?? []).filter((x) => x?.text)
    for (const seg of segs) {
      const t = Math.floor((seg.startedAt - s.startedAt) / 1000)
      if (!sections.length || t - sections.at(-1).t >= 300) sections.push({ title: seg.text.replace(/\s+/g, ' ').slice(0, 40) + (seg.text.length > 40 ? '…' : ''), t, raw: [] })
    }
  }
  sections.forEach((sec, i) => {
    const end = sections[i + 1]?.t ?? Math.max(sec.t, dur)
    const n = sec.raw.length
    sec.points = sec.raw.map((p, k) => ({ text: String(typeof p === 'string' ? p : (p?.text ?? '')).replace(/\s*\n\s*/g, ' '), t: Math.floor(sec.t + ((end - sec.t) * k) / Math.max(1, n)) })).filter((p) => p.text)
    sec.frames = []
    delete sec.raw
  })
  const frames = []
  for (const sl of s.slides ?? []) {
    if (!sl?.file || !sl.at) continue
    const rel = (sl.at - s.startedAt) / 1000
    const clock = clockOf(sl.at)
    frames.push({ file: sl.file, clock })
    const sec = [...sections].reverse().find((x) => x.t <= rel) ?? sections[0]
    if (sec) sec.frames.push(clock)
    else sections.push({ title: '关键画面', t: Math.max(0, Math.floor(rel)), points: [], frames: [clock] })
  }
  const items = (s.summary?.items ?? []).filter((x) => x?.text && x.owner !== 'other' && !x.done)
  const todos = items.length
    ? items.map((x) => ({ text: x.text.replace(/\s*\n\s*/g, ' '), session: s.id, t: Math.floor((Number(x.at) || 0) / 1000), ...(x.due ? { due: x.due } : {}) }))
    : (s.liveNotes?.homework ?? []).filter((x) => x?.text).map((x) => ({ text: x.text.replace(/\s*\n\s*/g, ' '), session: s.id, t: 0, ...(x.due ? { due: x.due } : {}) }))
  return { part: { session: s.id, sections }, frames, todos }
}

/** 纪要 / 课堂笔记的第一段正文当概览（300 字以内） */
export function overviewOf(markdown) {
  if (!markdown) return null
  const paras = String(markdown).split(/\n\s*\n/).map((p) => p.trim())
  const p = paras.find((x) => x && !/^(#|[-*+] |\d+\. |>|\||!\[|```|\$\$)/.test(x))
  if (!p) return null
  const one = p.replace(/\s*\n\s*/g, ' ')
  return one.length > 300 ? one.slice(0, 299) + '…' : one
}

export class CanvasLink extends EventEmitter {
  /**
   * settings：SettingsStore；store：SessionStore；projects：ProjectStore；userData：设置目录（live 文件、写过的记录）；
   * audioRec：AudioRecording（done(id)）；trash(abs)：挪进废纸篓；appData：找画布笔记设置用
   */
  constructor({ engine, store, projects, settings, userData, audioRec, trash, appData, notesFlush = () => null }) {
    super()
    Object.assign(this, { engine, store, projects, settings, userData, audioRec, trash, appData, notesFlush })
    this.pending = new Map() // 会议 id → 下课写库的 Promise
    this.migrating = null // { to, abort, progress }
    this.backs = new Map() // 深链 start 带的 back，等这一场建好记到它身上
    this.wantBack = null
    this.#store = null
    engine.on('state', (st) => this.#onState(st))
  }

  #store

  vault() {
    const v = this.settings.get().canvasVault
    return v && fs.existsSync(v) ? v : null
  }

  detected() {
    return detectVault(this.appData)
  }

  audioCfg() {
    const s = this.settings.get()
    return { mode: s.canvasAudio || 'local', remote: s.canvasLfsRemote || '', icloudDir: s.canvasIcloudDir || '' }
  }

  audioStore() {
    const v = this.vault()
    if (!v) return null
    const cfg = this.audioCfg()
    if (!this.#store || this.#store.vault !== v || JSON.stringify(this.#store.cfg) !== JSON.stringify({ ...this.#store.cfg, ...cfg })) this.#store = new AudioStore({ vault: v, cfg, trash: this.trash })
    return this.#store
  }

  status() {
    const st = this.audioStore()
    return {
      vault: this.vault(),
      detected: this.detected(),
      audio: this.audioCfg(),
      actual: st?.actual() ?? null,
      icloudDir: st?.icloudDir() ?? null,
      lastPush: st?.lastPush ?? null,
      migrating: this.migrating ? { to: this.migrating.to, progress: this.migrating.progress } : null,
      projects: this.vault() ? this.projectMap().length : 0,
    }
  }

  // ---------- 连库：meetcaption.json ----------

  /**
   * 连上一个库（不给就用设置里的 / 画布笔记的）：写 meetcaption.json、主库 .gitignore、准备录音那一处。
   * agree：用户在设置里点的连库（算明确同意）——家族联动 mc-write、mc-todo 一起拨开；启动时自动重连不给，用户在家族设置里关了的不再打开
   */
  async connect(vault, { agree = false } = {}) {
    const v = vault || this.settings.get().canvasVault || this.detected()
    if (!v || !fs.existsSync(v)) throw new Error('找不到画布笔记的库：在设置里选一下库的文件夹')
    if (v !== this.settings.get().canvasVault) this.settings.update({ canvasVault: v })
    if (agree) turnOnLinks(v)
    this.writeMap()
    const st = this.audioStore()
    await st.prepare()
    // 上次退出时没推完的（推送被打断）：连上就补推一次，不挡着
    if (st.cfg.mode === 'lfs' && st.cfg.remote) st.saved('录音：补上没提交的').catch((e) => this.emit('error', { message: `录音推不上去：${e.message}` }))
    this.emit('status', this.status())
    return this.status()
  }

  /** 录音还在推（退出前等它） */
  isPushing() {
    return (this.#store?.inflight ?? 0) > 0
  }
  async flushPush(ms) {
    if (!this.isPushing()) return
    let timer
    await Promise.race([this.#store.pushing, new Promise((r) => (timer = setTimeout(r, ms)))])
    clearTimeout(timer)
  }

  disconnect() {
    this.settings.update({ canvasVault: '' })
    this.emit('status', this.status())
  }

  /** 每个项目：id、name、folder、mode、calendar（库里原来写了的保留）、schedule（原来写了的保留，没写就从上课时间推） */
  projectMap() {
    const v = this.vault()
    const old = new Map((readJson(path.join(v, MAP_FILE), {})?.projects ?? []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]))
    const dirs = vaultDirs(v)
    const list = this.projects.list().filter((p) => !p.archived)
    const out = []
    for (const p of list) {
      const prev = old.get(p.id)
      const mode = mcModeOfProject(p)
      const kind = mode === 'class' || mode === 'online' ? '课程' : '会议'
      const name = p.id === INBOX_ID ? '未归类' : p.name
      const folder = prev?.folder || (p.id === INBOX_ID ? 'MeetCaption' : matchFolder(dirs, p.name)) || `${kind}/${safeName(p.name)}`
      let schedule = Array.isArray(prev?.schedule) ? prev.schedule : null
      if (!schedule) {
        try {
          schedule = inferSchedule(this.store.list({ projectId: p.id }).map((x) => x.startedAt))
        } catch {
          schedule = []
        }
      }
      out.push({ id: p.id, name, folder, mode, ...(prev?.calendar ? { calendar: prev.calendar } : {}), ...(schedule.length ? { schedule } : {}) })
    }
    return out
  }

  writeMap() {
    const v = this.vault()
    if (!v) return null
    const projects = this.projectMap()
    const file = path.join(v, MAP_FILE)
    const prev = readJson(file, {})
    const text = JSON.stringify({ ...prev, version: 1, app: 'meetcaption', projects, audio: this.#audioInfo() }, null, 2) + '\n'
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) writeAtomic(file, text)
    return projects
  }

  /** 画布笔记按这个找录音：存法、lfs 的远端、icloud 文件夹（相对 iCloud 云盘，换台 Mac 也对） */
  #audioInfo() {
    const c = this.audioCfg()
    const st = this.audioStore()
    const drive = path.join(this.appData, '..', 'Mobile Documents', 'com~apple~CloudDocs')
    const dir = st?.icloudDir() ?? ''
    return { store: c.mode, path: '.canvas-notes/录音', ...(c.mode === 'lfs' && c.remote ? { remote: c.remote } : {}), ...(c.mode === 'icloud' ? { icloud: dir.startsWith(drive + path.sep) ? path.relative(drive, dir) : dir } : {}) }
  }

  // ---------- 一场 → 哪一篇 ----------

  #written() {
    return readJson(path.join(this.userData, WRITTEN), {})
  }
  #saveWritten(w) {
    writeAtomic(path.join(this.userData, WRITTEN), JSON.stringify(w, null, 1))
  }

  /** 这一场写进哪一篇：同一项目、同一天、上一场下课不到 1 小时的并进去；不然新开一篇「<日期> <项目名>.md」 */
  #fileFor(s) {
    const v = this.vault()
    const w = this.#written()
    const day = dayOf(s.startedAt)
    for (const [key, x] of Object.entries(w)) {
      if (!key.startsWith(v + '|') || x.project !== s.projectId || x.date !== day) continue
      if (x.sessions.includes(s.id)) return key.slice(v.length + 1)
      if (x.endedAt && s.startedAt - x.endedAt < MERGE_GAP_MS && fs.existsSync(path.join(v, key.slice(v.length + 1)))) return key.slice(v.length + 1)
    }
    const map = this.projectMap().find((p) => p.id === s.projectId)
    const mode = s.mode === 'class' ? 'class' : s.mode
    const sub = mode === 'class' ? '上课记录' : '会议记录'
    const name = this.#projectName(s.projectId)
    const base = `${map?.folder ?? 'MeetCaption'}/${sub}/${day} ${safeName(name)}`
    let file = `${base}.md`
    for (let i = 2; fs.existsSync(path.join(v, file)); i++) file = `${base} ${i}.md`
    return file
  }

  #projectName(id) {
    if (id === INBOX_ID) return '未归类'
    try {
      return this.projects.get(id)?.name ?? id
    } catch {
      return id
    }
  }

  #liveFile() {
    return path.join(this.userData, LIVE_NAME)
  }

  /** 深链 start 带来的 back：下一场建好时记到它身上（「在画布笔记里继续」带回去） */
  expectBack(back) {
    this.wantBack = back || null
  }

  #onState(st) {
    if (!this.vault()) return
    try {
      if (st.state === 'running' && st.sessionId && !this.backs.has(st.sessionId)) {
        this.backs.set(st.sessionId, this.wantBack)
        this.wantBack = null
        this.#begin(st.sessionId)
      }
      if (st.state === 'idle' && st.lastSessionId && !this.pending.has(st.lastSessionId)) {
        const id = st.lastSessionId
        const p = this.#end(id).catch((e) => {
          this.emit('error', { sessionId: id, message: e.message })
          return { ok: false, error: e.message }
        })
        this.pending.set(id, p)
      }
    } catch (e) {
      this.emit('error', { sessionId: st.sessionId ?? st.lastSessionId, message: e.message })
    }
  }

  /** 上课：定好写哪一篇、先写一篇有属性的（画布笔记马上看得到），live 文件写上 */
  #begin(id) {
    const v = this.vault()
    const s = this.store.load(id)
    const file = this.#fileFor(s)
    const back = this.backs.get(id)
    this.store.mutate(id, (x) => void (x.canvas = { vault: v, file, ...(back ? { back } : {}) }))
    this.writeRecord(file, id)
    const mode = mcModeOfProject({ mode: s.mode, classSource: s.classSource })
    writeAtomic(this.#liveFile(), JSON.stringify({ session: id, startedAt: s.startedAt, project: s.projectId, mode, file }, null, 1))
    this.emit('live', { sessionId: id, file })
  }

  /** 下课：等录音封好、实时笔记最后一次整理，写字幕、画面、录音和那一篇；live 文件写上 endedAt、todos */
  async #end(id) {
    // 引擎发 idle 之后才挂上 notesFlush：等一拍再拿
    await new Promise((r) => setImmediate(r))
    const flush = this.notesFlush()
    if (flush) {
      let timer
      await Promise.race([flush, new Promise((r) => (timer = setTimeout(r, 240_000)))]).catch(() => {})
      clearTimeout(timer)
    }
    const audio = await this.audioRec?.done(id).catch(() => null)
    return this.writeSession(id, { audio })
  }

  /** 下课写库的那次做完了（自测、退出前等它） */
  finished(id) {
    return this.pending.get(id) ?? Promise.resolve(null)
  }

  /** 一场的字幕、画面、录音写进库，再重写那一篇。→ { ok, file, vtt, frames, audio, record } */
  async writeSession(id, { audio } = {}) {
    const v = this.vault()
    if (!v) return { ok: false, error: 'not-connected' }
    const s = this.store.load(id)
    const file = s.canvas?.vault === v && s.canvas.file ? s.canvas.file : this.#fileFor(s)
    if (s.canvas?.file !== file) this.store.mutate(id, (x) => void (x.canvas = { ...(x.canvas ?? {}), vault: v, file }))
    const st = this.audioStore()
    await st.prepare()
    const vtt = mcSubtitlePath(id)
    writeAtomic(path.join(v, vtt), writeVtt(sessionCues(s)))
    const recDir = path.join(v, mcRecordingDir(file))
    fs.mkdirSync(recDir, { recursive: true })
    const { frames } = sessionPart(s)
    const sdir = this.store.dir(id)
    const copied = []
    for (const f of frames) {
      const src = path.join(sdir, f.file)
      if (!fs.existsSync(src)) continue
      const dst = path.join(recDir, mcFrameName(f.clock))
      if (!fs.existsSync(dst)) fs.copyFileSync(src, dst)
      copied.push(path.basename(dst))
    }
    const rec = this.writeRecord(file, id)
    const sessions = rec.sessions
    const n = sessions.indexOf(id) + 1
    let audioRel = null
    const srcAudio = path.join(sdir, (audio ?? s.audio)?.file ?? AUDIO_FILE)
    if (n > 0 && fs.existsSync(srcAudio)) {
      audioRel = `${mcRecordingDir(file)}/录音-${n}.webm`
      fs.copyFileSync(srcAudio, path.join(v, audioRel))
    }
    const push = st.saved(`录音：${file.replace(/\.md$/i, '')} 第 ${n} 场`)
    push.then((r) => r && this.emit('status', this.status())).catch((e) => this.emit('error', { sessionId: id, message: `录音推不上去：${e.message}` }))
    // live 文件：这一场下课了
    const live = readJson(this.#liveFile(), null)
    if (live?.session === id) writeAtomic(this.#liveFile(), JSON.stringify({ ...live, endedAt: s.endedAt ?? Date.now(), todos: rec.todos, ...(rec.dated ? { dated: rec.dated } : {}) }, null, 1))
    const out = { ok: true, file, vtt, frames: copied, audio: audioRel, record: rec }
    this.emit('written', { sessionId: id, ...out })
    return out
  }

  /** 重写一篇（这一场加进它的场次里）。用户改过就不动。→ { written, edited, sessions, todos, dated } */
  writeRecord(file, id) {
    const v = this.vault()
    const key = `${v}|${file}`
    const w = this.#written()
    const prev = w[key]
    const ids = [...new Set([...(prev?.sessions ?? []), id])]
    const sessions = ids
      .map((x) => {
        try {
          return this.store.load(x)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.startedAt - b.startedAt)
    const first = sessions[0]
    const parts = sessions.map(sessionPart)
    const durSec = sessions.reduce((a, x) => a + Math.max(0, ((x.endedAt ?? Date.now()) - x.startedAt) / 1000), 0)
    const minutes = Math.round(durSec / 60)
    const overview = sessions.map((x) => overviewOf(x.summary?.markdown)).find(Boolean)
    const todos = parts.flatMap((p) => p.todos)
    const name = this.#projectName(first.projectId)
    const title = `${dayOf(first.startedAt)} ${first.title || name}`
    const mode = mcModeOfProject({ mode: first.mode, classSource: first.classSource })
    const text = writeMcRecord({
      path: file,
      title,
      course: name,
      mode,
      sessions: sessions.map((x) => x.id),
      ...(sessions.some((x) => x.endedAt) ? { duration: `${Math.floor(minutes / 60)}:${pad(minutes % 60)}` } : {}),
      ...(overview ? { overview: { text: overview } } : {}),
      todos,
      parts: parts.map((p) => p.part),
    })
    const abs = path.join(v, file)
    const edited = fs.existsSync(abs) && (!prev || sha(fs.readFileSync(abs, 'utf8')) !== prev.hash)
    if (!edited) writeAtomic(abs, text)
    const ended = sessions.map((x) => x.endedAt).filter(Boolean)
    w[key] = { project: first.projectId, date: dayOf(first.startedAt), sessions: sessions.map((x) => x.id), hash: edited ? prev?.hash : sha(text), endedAt: ended.length ? Math.max(...ended) : null }
    this.#saveWritten(w)
    return { written: !edited, edited, sessions: w[key].sessions, todos: todos.length, dated: todos.filter((x) => x.due).length }
  }

  /** 纪要、作业生成好了：那一篇重写一次（概览、作业） */
  refresh(id) {
    const v = this.vault()
    let s
    try {
      s = this.store.load(id)
    } catch {
      return null
    }
    if (!v || s.canvas?.vault !== v || !s.canvas.file) return null
    return this.writeRecord(s.canvas.file, id)
  }

  // ---------- 在画布笔记里继续 ----------

  /** 这一场（t 秒）在画布笔记里的网址：写进过库的走 open（带篇、文件夹、库），没写过的走 meetcaption?session= */
  continueUrl(id, t) {
    let s = null
    try {
      s = this.store.load(id)
    } catch {}
    const c = s?.canvas
    const tt = Number.isFinite(t) && t >= 0 ? Math.floor(t) : undefined
    if (c?.file) return canvasNotesMcUrl({ file: c.file, t: tt, session: id, back: c.back ?? path.posix.dirname(path.posix.dirname(c.file)), vault: c.vault })
    return canvasNotesMcUrl({ session: id, t: tt })
  }

  // ---------- 换录音存法 ----------

  /** 换存法（设置里点的）：迁移有进度（事件 'progress'）、能取消（cancelMigrate）；成功才改设置 */
  async setAudio(mode, next = {}) {
    if (this.migrating) throw new Error('正在换存法，等它做完或先取消')
    const st = this.audioStore()
    const patch = { canvasAudio: mode, ...(next.remote !== undefined ? { canvasLfsRemote: next.remote } : {}), ...(next.icloudDir !== undefined ? { canvasIcloudDir: next.icloudDir } : {}) }
    if (!st) {
      this.settings.update(patch)
      return { ok: true, files: 0 }
    }
    const ctrl = new AbortController()
    this.migrating = { to: mode, abort: () => ctrl.abort(), progress: null }
    try {
      const r = await st.migrate(mode, { remote: next.remote ?? st.cfg.remote, icloudDir: next.icloudDir ?? st.cfg.icloudDir }, { signal: ctrl.signal, onProgress: (p) => ((this.migrating.progress = p), this.emit('progress', { to: mode, ...p })) })
      this.settings.update(patch)
      this.#store = null
      this.writeMap()
      return { ok: true, ...r }
    } finally {
      this.migrating = null
      this.emit('status', this.status())
    }
  }

  cancelMigrate() {
    this.migrating?.abort()
  }

  /** 时钟标签（给界面看）：「09:43」 */
  static clock(ms) {
    return clockLabel(clockOf(ms))
  }
}
