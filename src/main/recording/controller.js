import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { scanFrames } from '../video/frames.js'
import { mergeRecSlides, recordingLength, recordingsToScan, recSlideBase, wantRecFrame } from './clips.js'
import { t } from '../i18n.js'

// 记录时的录屏开关（会议、面试、课堂都能用）：实时页顶栏的「录屏」、命令面板、托盘菜单、快捷键都走这里。
// 开着时录一段（recorder.js），关掉这一段就存好；一场里可以开开关关好几段，每段一个文件、记进 session.recordings。
// 暂停记录：这一段收尾存好（视频里的时间要和这一场对得上，一段里不能有空档）；继续记录时开关还开着就自动另开一段。
// 停止记录：自动停掉、存好，然后对每段录屏「画面一变就截一张」（video/frames.js），截图并进 session.slides，课堂笔记、纪要就有图用。
// 事件：'state' 开关和正在录的那段变了；'progress' { sessionId, total, index, fraction, done, error }：截画面的进度；'changed' { sessionId }：会议里的录屏或截图变了。

const MAX_FRAME_WIDTH = 1600 // 截下来的画面最宽 1600：课件上的字看得清，一张两三百 KB

export class ScreenRecording extends EventEmitter {
  /**
   * engine：开会的引擎（要它的 state、pause、audio 事件和 session）；store：SessionStore；
   * makeRecorder() → ScreenRecorder；makeWorker() → VideoWorker（截画面用的隐藏窗口）；
   * protect() → release()：录屏期间把我们自己的窗口挡在录屏外面，录完放开；permission() → 屏幕录制权限 'granted' | …
   */
  constructor({ engine, store, makeRecorder, makeWorker, protect = () => () => {}, permission = () => 'granted', scan = scanFrames }) {
    super()
    this.engine = engine
    this.store = store
    this.makeRecorder = makeRecorder
    this.makeWorker = makeWorker
    this.protect = protect
    this.permission = permission
    this.scanImpl = scan
    this.wanted = false // 开关开着（暂停记录时开着但没在录）
    this.sessionId = null // 开关属于哪一场
    this.rec = null // 正在录的 ScreenRecorder
    this.seg = null // 正在录的那段 { sessionId, file, startAt, release }
    this.starting = false
    this.queue = Promise.resolve() // 开、关、暂停、停止一个接一个做
    this.scans = new Map() // 会议 id → 截画面的 Promise
    this.progress = new Map() // 会议 id → 截画面的进度
    engine.on('audio', (source, buf, rate) => this.rec?.pcm(source, buf, rate))
    engine.on('state', (st) => {
      if (st.state === 'running' && st.sessionId !== this.sessionId) {
        // 新的一场：开关默认关着
        this.sessionId = st.sessionId
        this.wanted = false
        this.#emit()
      }
      if (st.state === 'stopping') this.#run(() => this.#finish(this.sessionId))
    })
    engine.on('pause', (p) => {
      if (p.paused) this.#run(() => this.#stopSeg())
      else this.#run(() => (this.wanted && !this.rec ? this.#startSeg().catch((e) => this.#failed(e)) : null))
    })
  }

  #run(fn) {
    const p = this.queue.then(fn)
    this.queue = p.catch(() => {})
    return p
  }

  /** 正在做的开、关、停止都做完。 */
  settled() {
    return this.queue
  }

  status() {
    const id = this.sessionId
    let count = 0
    let totalMs = 0
    try {
      const s = id ? this.store.load(id) : null
      for (const r of s?.recordings ?? []) {
        count++
        totalMs += recordingLength(r) ?? 0
      }
    } catch {}
    return {
      sessionId: id,
      on: this.wanted,
      recording: Boolean(this.rec),
      starting: this.starting,
      startAt: this.seg?.startAt ?? null,
      count,
      totalMs,
    }
  }

  #emit() {
    this.emit('state', this.status())
  }

  #failed(e) {
    this.wanted = false
    this.#emit()
    this.emit('notice', { level: 'error', text: e.message, code: e.code === 'no-permission' ? 'screen-permission' : 'screen-record' })
  }

  /** 开 / 关录屏。on 不给就是切换。→ { ok, ...status } | { ok: false, error, code } */
  toggle(on = !this.wanted) {
    return this.#run(async () => {
      const e = this.engine
      if (on) {
        if (e.state !== 'running' || !e.session) return { ok: false, error: t('还没开始记录，开始记录后才能录屏'), code: 'not-running' }
        if (this.permission() !== 'granted') {
          return { ok: false, code: 'no-permission', error: t('没有屏幕录制权限，录不了屏。去「系统设置 → 隐私与安全性 → 录屏与系统录音」里打开「会议字幕」，然后重启应用。') }
        }
        this.sessionId = e.session.id
        this.wanted = true
        if (!e.paused && !this.rec) {
          try {
            await this.#startSeg()
          } catch (err) {
            this.wanted = false
            this.#emit()
            return { ok: false, error: err.message, code: err.code ?? 'start' }
          }
        }
      } else {
        this.wanted = false
        await this.#stopSeg()
      }
      this.#emit()
      return { ok: true, ...this.status() }
    })
  }

  async #startSeg() {
    const e = this.engine
    const s = e.session
    if (!s || e.state !== 'running' || e.paused || this.rec) return
    const rec = this.makeRecorder()
    this.starting = true
    this.#emit()
    const release = this.protect()
    try {
      const info = await rec.start({ sessionDir: this.store.dir(s.id), recordings: s.recordings ?? [] })
      const entry = { file: info.file, startAt: info.startAt, endAt: null, width: info.width, height: info.height, bytes: 0, mime: info.mime }
      this.store.mutate(s.id, (x) => {
        x.recordings = [...(x.recordings ?? []), entry]
      })
      this.rec = rec
      this.seg = { sessionId: s.id, file: info.file, startAt: info.startAt, release }
      // 录的那块屏幕没了：这一段存好，开关关掉，告诉用户
      rec.on('ended', () =>
        this.#run(async () => {
          if (this.rec !== rec) return
          this.wanted = false
          await this.#stopSeg()
          this.#emit()
          this.emit('notice', { level: 'warn', text: t('录屏停了：录的那块屏幕没了（拔了显示器，或者屏幕录制权限被关掉）。录到的这一段已经存好。'), code: 'screen-record' })
        }),
      )
      rec.on('error', (x) => this.emit('notice', { level: 'error', text: x.message, code: 'screen-record' }))
      this.emit('changed', { sessionId: s.id })
    } catch (err) {
      release()
      throw err
    } finally {
      this.starting = false
      this.#emit()
    }
  }

  async #stopSeg() {
    const rec = this.rec
    const seg = this.seg
    if (!rec) return
    this.rec = null
    this.seg = null
    this.#emit()
    const r = await rec.stop()
    seg.release()
    let bytes = r.bytes
    try {
      bytes = fs.statSync(path.join(this.store.dir(seg.sessionId), r.file)).size
    } catch {}
    try {
      this.store.mutate(seg.sessionId, (x) => {
        const e = (x.recordings ?? []).find((y) => y.file === r.file)
        if (e) Object.assign(e, { endAt: r.endAt, bytes })
      })
    } catch {}
    this.emit('changed', { sessionId: seg.sessionId })
  }

  // 停止记录：停掉正在录的这段，存好，再去截画面（不挡着停止）
  async #finish(sessionId) {
    this.wanted = false
    await this.#stopSeg()
    this.#emit()
    // 截画面出错不影响字幕和笔记：提示一句就算了
    if (sessionId) this.frames(sessionId).catch((e) => this.emit('notice', { level: 'warn', text: t(`从录屏里截画面没做完：{0}。字幕和笔记照常。`, e.message), code: 'screen-frames' }))
  }

  /** 截画面的进度（界面刚打开时取一次）。 */
  framesStatus(id) {
    return this.progress.get(id) ?? null
  }

  /**
   * 对这一场还没截过画面的录屏「画面一变就截一张」，截图并进 session.slides。已经在做就等它。
   * 生成纪要、课堂笔记前也调一次（录完还没截就退出了应用的，这时补上）。截不出来不报错，只记在那段录屏的 framesError 上。
   */
  frames(id) {
    if (this.scans.has(id)) return this.scans.get(id)
    const p = this.#scan(id).finally(() => this.scans.delete(id))
    this.scans.set(id, p)
    return p
  }

  async #scan(id) {
    let session = this.store.load(id)
    const todo = recordingsToScan(session).filter((r) => !(this.seg?.sessionId === id && this.seg.file === r.file))
    if (!todo.length) return { added: 0 }
    const dir = this.store.dir(id)
    const total = todo.length
    const report = (x) => {
      const p = { sessionId: id, total, ...x }
      if (p.done) this.progress.delete(id)
      else this.progress.set(id, p)
      this.emit('progress', p)
    }
    let worker = null
    let addedAll = 0
    try {
      worker = this.makeWorker()
      for (const [index, r] of todo.entries()) {
        const lengthMs = recordingLength(r)
        report({ index, fraction: index / total })
        session = this.store.load(id)
        const taken = new Set()
        const added = []
        let error = null
        try {
          await this.scanImpl({
            worker,
            file: path.join(dir, r.file),
            durationMs: lengthMs ?? undefined,
            maxWidth: MAX_FRAME_WIDTH,
            onProgress: (ms) => lengthMs && report({ index, fraction: (index + Math.min(1, ms / lengthMs)) / total }),
            onFrame: (ms, jpeg) => {
              const at = r.startAt + ms
              if (!wantRecFrame(session.slides, at)) return
              const base = recSlideBase(at - session.startedAt)
              let name = base
              for (let k = 2; taken.has(name) || fs.existsSync(path.join(dir, 'slides', `${name}.jpg`)); k++) name = `${base}-${k}`
              taken.add(name)
              fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })
              fs.writeFileSync(path.join(dir, 'slides', `${name}.jpg`), jpeg)
              added.push({ file: `slides/${name}.jpg`, at })
            },
          })
        } catch (e) {
          error = e.message
        }
        if (process.env.MEETCAPTION_DEBUG) console.error('[recording] frames', r.file, added.length, error ?? '')
        let removed = []
        this.store.mutate(id, (x) => {
          const merged = mergeRecSlides(x.slides, r.file, added)
          x.slides = merged.slides
          removed = merged.removed
          const e = (x.recordings ?? []).find((y) => y.file === r.file)
          if (e) {
            e.frames = added.length
            if (error) e.framesError = error
            else delete e.framesError
          }
        })
        const fresh = new Set(added.map((x) => x.file))
        for (const f of removed) if (!fresh.has(f)) fs.rmSync(path.join(dir, f), { force: true })
        addedAll += added.length
        this.emit('changed', { sessionId: id })
      }
    } finally {
      worker?.close()
      report({ index: total, fraction: 1, done: true, added: addedAll })
    }
    return { added: addedAll }
  }
}
