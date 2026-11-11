import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 视频模式的隐藏窗口（renderer/video/worker.html）：解声音和截画面都在它里面做，Chromium 自带的解码器不用另带 ffmpeg。
// call(op, 参数) → Promise<结果>：发一个活过去，等它回（二进制走 IPC 的结构化克隆，不转字符串）。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, '..', '..', 'renderer', 'video', 'worker.html')
const PRELOAD = path.join(HERE, '..', '..', 'preload', 'video.cjs')

let seq = 0
const waiting = new Map() // job id → { resolve, win }
let wired = false

function wire() {
  if (wired) return
  wired = true
  ipcMain.on('video:reply', (e, id, result) => {
    const w = waiting.get(id)
    if (!w || e.sender !== w.win.webContents) return
    waiting.delete(id)
    w.resolve(result)
  })
}

export class VideoWorker {
  constructor() {
    this.win = null
    this.ready = null
  }

  #start() {
    wire()
    this.ready ??= (async () => {
      const win = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
      this.win = win
      win.on('closed', () => {
        for (const [id, w] of waiting) if (w.win === win) (waiting.delete(id), w.resolve({ error: 'worker-closed' }))
        this.win = null
        this.ready = null
      })
      if (process.env.MEETCAPTION_DEBUG) win.webContents.on('console-message', (e) => console.error('[video worker]', e.message ?? e))
      await win.loadFile(PAGE)
    })()
    return this.ready
  }

  async call(op, args = {}) {
    await this.#start()
    const win = this.win
    if (!win || win.isDestroyed()) return { error: 'worker-closed' }
    const id = ++seq
    return new Promise((resolve) => {
      waiting.set(id, { resolve, win })
      win.webContents.send('video:job', { ...args, id, op })
    })
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.ready = null
  }
}
