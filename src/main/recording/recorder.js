import { BrowserWindow, desktopCapturer, ipcMain, screen } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { routeDisplayMedia } from '../rendererCapture.js'
import { nextRecordingFile, REC_DIR } from './clips.js'
import { t } from '../i18n.js'

// 录一段屏幕：开一个隐藏窗口（renderer/recorder），录鼠标所在的那一整块屏幕，30 帧，声音是字幕用的那两路混在一起；
// 录出来的数据一块一块写进这一场文件夹的 recordings/录屏-N.mp4，不在内存里攒。一段一个对象：start() → pcm()… → stop()。
// 事件：'ended'（屏幕没了：拔了显示器、权限被收回）、'error' { message }。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, '..', '..', 'renderer', 'recorder', 'index.html')
const PRELOAD = path.join(HERE, '..', '..', 'preload', 'recorder.cjs')
const PAGE_MARK = 'renderer/recorder/index.html'

// 画面最长边 1920：Retina 屏（3024 × 1964）缩到 1920 × 1246，课件上的小字照样看得清，编码器也不吃力。
// 码率 3.5 Mbps：1920 宽、30 帧的 H.264 放课件和共享的文档，字边不糊；画面不动时编码器给得少得多，
// 实测静止的桌面一小时 0.5 GB 左右，一直在动（滚网页、放视频）最多约 1.6 GB（3.5 + 0.128 Mbps × 3600 秒）。
export const MAX_EDGE = 1920
export const FPS = 30
export const VIDEO_BPS = 3_500_000
export const AUDIO_BPS = 128_000

let wired = false
const live = new Map() // webContents id → ScreenRecorder

function wire() {
  if (wired) return
  wired = true
  ipcMain.on('recorder:chunk', (e, data) => live.get(e.sender.id)?.write(data))
  ipcMain.on('recorder:event', (e, what, info) => live.get(e.sender.id)?.emit(what, info ?? {}))
}

/** 鼠标所在的那块屏幕，和它录下来的画面大小（偶数，最长边不超过 MAX_EDGE）。 */
export function pickDisplay() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const w = display.size.width * display.scaleFactor
  const h = display.size.height * display.scaleFactor
  const k = Math.min(1, MAX_EDGE / Math.max(w, h))
  const even = (x) => Math.max(2, Math.round((x * k) / 2) * 2)
  return { display, width: even(w), height: even(h) }
}

export class ScreenRecorder extends EventEmitter {
  constructor() {
    super()
    this.win = null
    this.out = null
    this.bytes = 0
    this.chunks = 0
    this.file = null
    this.writeError = null
  }

  /**
   * 开始录一段。sessionDir：这一场的文件夹；recordings：这一场已有的录屏（定文件名）。
   * → { file: 'recordings/录屏-N.mp4', startAt, width, height, mime }；录不了抛错（e.code：no-permission | start）。
   */
  async start({ sessionDir, recordings = [] }) {
    wire()
    const { display, width, height } = pickDisplay()
    routeDisplayMedia(PAGE_MARK, async () => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      return sources.find((s) => s.display_id === String(display.id)) ?? sources[0] ?? null
    })
    const win = new BrowserWindow({ show: false, width: 200, height: 100, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    this.win = win
    live.set(win.webContents.id, this)
    const id = win.webContents.id
    win.on('closed', () => live.delete(id))
    try {
      await win.loadFile(PAGE)
      const type = await win.webContents.executeJavaScript('window.pickType()')
      if (!type) throw Object.assign(new Error(t('这台电脑录不了视频（没有能用的视频编码）')), { code: 'start' })
      this.file = nextRecordingFile(sessionDir, recordings, type.ext)
      const full = path.join(sessionDir, this.file)
      fs.mkdirSync(path.join(sessionDir, REC_DIR), { recursive: true })
      this.out = fs.createWriteStream(full)
      this.out.on('error', (e) => {
        this.writeError = e
        this.emit('error', { message: t(`录屏写不进文件：{0}`, e.message) })
      })
      // 带上 userGesture：getDisplayMedia 和 AudioContext 都要「用户手势」才让用
      const r = await win.webContents.executeJavaScript(`window.startRecording(${JSON.stringify({ mime: type.mime, width, height, fps: FPS, videoBps: VIDEO_BPS, audioBps: AUDIO_BPS })})`, true)
      if (!r?.ok) {
        const denied = /NotAllowed|Permission|denied/i.test(`${r?.name} ${r?.error}`)
        throw Object.assign(new Error(denied ? t('没有屏幕录制权限，截不到屏幕。去「系统设置 → 隐私与安全性 → 录屏与系统录音」里打开「会议字幕」，然后重启应用。') : t(`录屏没开起来：{0}`, r?.error ?? '')), { code: denied ? 'no-permission' : 'start' })
      }
      return { file: this.file, startAt: r.startAt, width: r.width, height: r.height, mime: r.mime }
    } catch (e) {
      await this.#close(true)
      throw e
    }
  }

  write(data) {
    if (!this.out || this.writeError) return
    const buf = Buffer.from(data)
    this.chunks++
    this.bytes += buf.length
    this.out.write(buf)
  }

  /** 字幕用的一块声音（16 位单声道 PCM）送进录屏窗口混音。 */
  pcm(source, buf, rate) {
    const wc = this.win?.webContents
    if (wc && !wc.isDestroyed()) wc.send('recorder:pcm', source, buf, rate)
  }

  /** 停下来，最后一块写完再关文件。→ { file, endAt, bytes } */
  async stop() {
    let endAt = Date.now()
    try {
      const wc = this.win?.webContents
      if (wc && !wc.isDestroyed()) {
        const r = await Promise.race([wc.executeJavaScript('window.stopRecording()'), new Promise((res) => setTimeout(() => res(null), 8000))])
        if (r?.endAt) endAt = r.endAt
        // 最后几块数据和 stopRecording 的结果走的不是同一条路：等收齐（最多 3 秒）再关文件
        for (let i = 0; r?.sent && this.chunks < r.sent && i < 60; i++) await new Promise((res) => setTimeout(res, 50))
      }
    } catch {}
    await this.#close(false)
    return { file: this.file, endAt, bytes: this.bytes }
  }

  async #close(removeEmpty) {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    const out = this.out
    this.out = null
    if (out) await new Promise((resolve) => out.end(resolve))
    if (removeEmpty && this.file && out && !this.bytes) fs.rmSync(out.path, { force: true })
  }
}
