import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

// macOS 系统声音：用 audiotee（Core Audio taps，macOS 14.2+）抓扬声器里播放的所有声音，
// stdout 直接吐 16 位单声道 PCM。它收到 SIGTERM 不退出，要用 SIGINT。

export function macTapSupported() {
  if (process.platform !== 'darwin') return false
  const [major, minor] = os.release().split('.').map(Number) // Darwin 23.2 = macOS 14.2
  return major > 23 || (major === 23 && minor >= 2)
}

function binaryPath() {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('audiotee') // .../audiotee/dist/index.js
  return path.join(path.dirname(entry), '..', 'bin', 'audiotee').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

// 换输出设备（戴上 / 摘下耳机、连上蓝牙）时 audiotee 可能退出，也可能还活着但不再出数据：
// 退出了就重开，出过数据又停了 GAP_MS 也重开（正常时安静也会一直出静音数据）。重开连着失败才报错。
const GAP_MS = 4000
const RETRY_MS = [500, 1000, 2000, 4000]

export class MacSystemAudio extends EventEmitter {
  constructor({ sampleRate, spawnTap = null }) {
    super()
    this.sampleRate = sampleRate
    this.spawnTap = spawnTap
    this.proc = null
    this.leftover = null
    this.stopped = true
    this.failures = 0 // 连着几次重开都没出数据
    this.lastDataAt = 0
    this.gapTimer = null
    this.retryTimer = null
  }

  start() {
    this.stopped = false
    this.#spawn(true)
    this.gapTimer = setInterval(() => {
      if (this.proc && this.lastDataAt && Date.now() - this.lastDataAt > GAP_MS) this.#restart('gap')
    }, 1000)
  }

  #spawn(first) {
    const p = this.spawnTap ? this.spawnTap() : spawn(binaryPath(), ['--sample-rate', String(this.sampleRate), '--chunk-duration', '0.1'])
    this.proc = p
    this.leftover = null
    this.lastDataAt = 0
    // 还没授权时 audiotee 一个字节都不给（系统在弹授权框），点了「允许」后同一个进程就开始出数据。
    let gotData = false
    let stalled = false
    const stallTimer = first
      ? setTimeout(() => {
          if (!gotData && this.proc === p) {
            stalled = true
            this.emit('stalled')
          }
        }, 3000)
      : null
    p.stdout.on('data', (chunk) => {
      if (this.proc !== p) return
      this.lastDataAt = Date.now()
      if (!gotData) {
        gotData = true
        clearTimeout(stallTimer)
        if (stalled) this.emit('resumed')
        if (!first) this.emit('restored')
        this.failures = 0
      }
      let buf = this.leftover ? Buffer.concat([this.leftover, chunk]) : chunk
      if (buf.length % 2) {
        this.leftover = buf.subarray(buf.length - 1)
        buf = buf.subarray(0, buf.length - 1)
      } else this.leftover = null
      if (buf.length) this.emit('data', buf)
    })
    p.stderr.on('data', (d) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.message_type === 'error') this.emit('error', new Error(msg.data?.message ?? '系统声音采集出错'))
        } catch {}
      }
    })
    p.on('error', (e) => this.emit('error', e))
    p.on('exit', (code, signal) => {
      clearTimeout(stallTimer)
      if (this.proc !== p) return // stop() 或重开时主动停的
      this.proc = null
      this.#restart(`exit code=${code} signal=${signal}`)
    })
  }

  #restart(reason) {
    if (this.stopped) return
    const old = this.proc
    this.proc = null
    old?.kill('SIGINT')
    if (this.failures === 0) this.emit('restarting', reason)
    if (this.failures >= RETRY_MS.length * 3) {
      this.emit('error', new Error(`系统声音采集反复中断，重开了 ${this.failures} 次都没恢复（${reason}）`))
      this.failures = 0
    }
    const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]
    this.failures++
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      if (!this.stopped && !this.proc) this.#spawn(false)
    }, wait)
  }

  stop() {
    this.stopped = true
    clearInterval(this.gapTimer)
    clearTimeout(this.retryTimer)
    const p = this.proc
    if (!p) return
    this.proc = null
    p.kill('SIGINT')
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
    }, 1500).unref()
  }
}
