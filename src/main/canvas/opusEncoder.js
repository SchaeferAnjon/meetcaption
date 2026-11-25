import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 录音编码器：一个隐藏窗口（renderer/opus）里的 WebCodecs AudioEncoder。open → pcm()… → close() → { head }

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE = path.join(HERE, '..', '..', 'renderer', 'opus', 'index.html')
const PRELOAD = path.join(HERE, '..', '..', 'preload', 'opus.cjs')

let wired = false
const live = new Map() // webContents id → OpusEncoder

export class OpusEncoder {
  constructor() {
    this.win = null
    this.queue = []
    this.ready = false
    this.got = 0
    this.onPacket = null
  }

  async open({ rate, bitrate, onPacket }) {
    if (!wired) {
      wired = true
      ipcMain.on('opus:packet', (e, ts, dur, data) => live.get(e.sender.id)?.#packet(ts, dur, data))
    }
    this.onPacket = onPacket
    const win = new BrowserWindow({ show: false, width: 100, height: 100, webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    this.win = win
    const id = win.webContents.id
    live.set(id, this)
    win.on('closed', () => live.delete(id))
    await win.loadFile(PAGE)
    const r = await win.webContents.executeJavaScript(`window.openEncoder(${JSON.stringify({ rate, bitrate })})`)
    if (!r?.ok) throw new Error(`录音编码器开不起来：${r?.error ?? ''}`)
    this.ready = true
    for (const pcm of this.queue.splice(0)) this.#send(pcm)
  }

  #packet(ts, dur, data) {
    this.got++
    this.onPacket?.({ ts, dur, data: Buffer.from(data) })
  }

  #send(pcm) {
    const wc = this.win?.webContents
    if (wc && !wc.isDestroyed()) wc.send('opus:pcm', Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength))
  }

  pcm(pcm) {
    if (this.ready) this.#send(pcm)
    else this.queue.push(pcm)
  }

  async close() {
    try {
      const wc = this.win?.webContents
      if (!wc || wc.isDestroyed()) return { head: null }
      const r = await wc.executeJavaScript('window.closeEncoder()')
      // 包和收尾的结果走的不是同一条路：等收齐（最多 5 秒）
      for (let i = 0; this.got < (r?.sent ?? 0) && i < 100; i++) await new Promise((res) => setTimeout(res, 50))
      if (!r?.ok) throw new Error(`录音编码出错：${r?.error ?? ''}`)
      return { head: r.head ? Buffer.from(r.head) : null }
    } finally {
      if (this.win && !this.win.isDestroyed()) this.win.destroy()
      this.win = null
    }
  }
}
