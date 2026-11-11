import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocketServer } from 'ws'
import { chunkCount, planChunks, quietCut, recognizeChunk, recognizeCloud, recognizeLocal } from '../src/main/video/recognize.js'

// 视频模式的识别：本地一条通道送到尾；云识别在停顿处切块、几路同时认再拼回来，断线从最后一句的终点接着认。

const RATE = 16000
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrec-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 做一个 PCM 文件：seconds 秒，噪声；quiet 里的区间（秒）静音
function makePcm(seconds, quiet = []) {
  const f = path.join(dir, `p${Math.random().toString(36).slice(2)}.pcm`)
  const a = new Int16Array(seconds * RATE)
  for (let i = 0; i < a.length; i++) {
    const s = i / RATE
    a[i] = quiet.some(([x, y]) => s >= x && s < y) ? 0 : Math.round((Math.random() - 0.5) * 8000)
  }
  fs.writeFileSync(f, Buffer.from(a.buffer))
  return f
}

// 假 Soniox：每收到 2 秒音频出一句 "s<序号>"（时间相对这条连接的开头），收到空帧回 finished；
// dropAfter：第一条连接收到这么多字节就断开（临时 Key 到点）
async function fakeSoniox(t, { dropAfter = 0 } = {}) {
  const conns = []
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws, req) => {
    const c = { auth: req.headers.authorization, config: null, bytes: 0, sent: 0 }
    conns.push(c)
    ws.on('message', (d, binary) => {
      if (binary) {
        c.bytes += d.length
        while (c.bytes - c.sent * 64000 >= 64000) {
          const k = c.sent++
          ws.send(JSON.stringify({ tokens: [{ text: `s${conns.indexOf(c)}-${k}`, start_ms: k * 2000, end_ms: k * 2000 + 1500, is_final: true }, { text: '<end>', is_final: true }], total_audio_proc_ms: (k + 1) * 2000 }))
        }
        if (dropAfter && conns.length === 1 && c.bytes >= dropAfter) ws.terminate()
        return
      }
      const s = String(d)
      if (s === '') return ws.send(JSON.stringify({ tokens: [], finished: true }), () => ws.close())
      c.config = JSON.parse(s)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => (wss.close(), server.close()))
  return { conns, url: `ws://127.0.0.1:${server.address().port}/` }
}

test('quietCut / planChunks：刀口落在静音上，不劈在说话中间', async () => {
  const f = makePcm(100, [[48.5, 49.1]])
  const cut = await quietCut(f, 50_000, 10_000)
  assert.ok(cut >= 48_500 && cut <= 49_100, `刀口 ${cut}`)
  const chunks = await planChunks(f, 100_000, 50_000, 0, { parallel: 2 })
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].from, 0)
  assert.equal(chunks[0].to, chunks[1].from)
  assert.equal(chunks[1].to, 100_000)
  assert.ok(chunks[0].to >= 48_500 && chunks[0].to <= 49_100)
  assert.equal((await planChunks(f, 100_000, 240_000)).length, 3, '100 秒的短视频也分 3 块，3 路同时认')
  assert.equal((await planChunks(f, 30_000)).length, 1, '30 秒不到 40 秒，不值得分')
})

test('分几块：短的也分到路数那么多（每块不短于 20 秒），长的块数是路数的整数倍、每块不长于 4 分钟', () => {
  const S = 1000
  assert.deepEqual([10, 30, 39, 40, 59, 60, 120, 300].map((x) => chunkCount(x * S)), [1, 1, 1, 2, 2, 3, 3, 3])
  assert.equal(chunkCount(12 * 60 * S), 3, '12 分钟：3 块各 4 分钟')
  assert.equal(chunkCount(12 * 60 * S + 1), 6)
  assert.equal(chunkCount(20 * 60 * S), 6, '20 分钟：2 轮、每路 3 分 20 秒，不是 5 块（最后一轮有路空着）')
  assert.equal(chunkCount(2 * 3600 * S), 30, '2 小时：30 块各 4 分钟')
  assert.equal(chunkCount(100 * S, { parallel: 1 }), 1)
})

test('云识别一块：Key 放请求头，配置带语言、术语和背景；句子时间换成视频里的毫秒', async (t) => {
  const f = makePcm(10)
  const s = await fakeSoniox(t)
  const out = await recognizeChunk({ pcmFile: f, from: 2000, to: 8000, key: 'sk-mine', url: s.url, language: 'de', hotwords: ['Döllner'], context: '财报会' })
  assert.equal(s.conns[0].auth, 'Bearer sk-mine')
  assert.deepEqual(s.conns[0].config.language_hints, ['de'])
  assert.deepEqual(s.conns[0].config.context, { text: '财报会', terms: ['Döllner'] })
  assert.deepEqual(out.map((x) => [x.text, x.startMs, x.endMs]), [['s0-0', 2000, 3500], ['s0-1', 4000, 5500], ['s0-2', 6000, 7500]])
})

test('云识别一块：中途断线（Key 到点）从最后一句的终点换新 Key 接着认，不重复不丢', async (t) => {
  const f = makePcm(20)
  const s = await fakeSoniox(t, { dropAfter: 200_000 })
  let keys = 0
  const out = await recognizeChunk({ pcmFile: f, from: 0, to: 20_000, getKey: async () => ({ key: `k${++keys}`, maxMs: 300_000 }), url: s.url })
  assert.ok(s.conns.length >= 2, '换过连接')
  assert.equal(keys, s.conns.length, '每条连接换一把 Key')
  const starts = out.map((x) => x.startMs)
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
  assert.equal(new Set(starts).size, starts.length, '没有重复的句子')
  // 第二条连接是从第一条最后一句的终点开始送的：它的第 0 句的开始时间 = 那个终点
  const second = out.find((x) => x.text.startsWith('s1-'))
  assert.ok(second && second.startMs >= out.find((x) => x.text.startsWith('s0-')).endMs)
  assert.ok(out.at(-1).endMs <= 20_000 + 1500)
})

test('云识别整个文件：切块、几路同时认、按时间拼回来；进度只增不减', async (t) => {
  const f = makePcm(120, [[29, 31], [59, 61], [89, 91]])
  const s = await fakeSoniox(t)
  const seen = []
  const reach = []
  const out = await recognizeCloud({ pcmFile: f, durationMs: 120_000, parallel: 2, chunkMs: 30_000, key: 'k', url: s.url, onProgress: (ms) => seen.push(ms), onReach: (ms) => reach.push(ms) })
  assert.ok(reach.every((x) => x >= 0 && x <= 120_000))
  assert.ok(Math.max(...reach) >= 119_000, '最后报到视频的终点')
  assert.ok(reach.some((x) => x >= 30_000 && x < 60_000), '第二路一开始就报告了它那一块的起点，不等第一路认完')
  assert.equal(s.conns.length, 4)
  assert.deepEqual(out.map((x) => x.startMs), [...out.map((x) => x.startMs)].sort((a, b) => a - b))
  assert.ok(out.length >= 40)
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b))
  assert.ok(seen.at(-1) >= 119_000)
})

test('云识别：自带 Key 被拒（401）不重试，直接报错；取消能中断', async (t) => {
  const f = makePcm(10)
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ error_code: 401, error_message: 'bad key' }))))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => (wss.close(), server.close()))
  await assert.rejects(recognizeChunk({ pcmFile: f, from: 0, to: 10_000, key: 'bad', url: `ws://127.0.0.1:${server.address().port}/` }), /401/)
  const ac = new AbortController()
  const s = await fakeSoniox(t)
  const p = recognizeCloud({ pcmFile: makePcm(60), durationMs: 60_000, key: 'k', url: s.url, signal: ac.signal, chunkMs: 20_000 })
  setTimeout(() => ac.abort(), 5)
  await assert.rejects(p, (e) => e.name === 'AbortError')
})

class FakeLocal extends EventEmitter {
  constructor() {
    super()
    this.got = 0
    this.n = 0
  }
  async connect() {}
  sendAudio(b) {
    this.got += b.length >> 1
    // 每送满 4 秒认出一句；span 相对这条通道的开头
    while ((this.n + 1) * 4 * RATE <= this.got) {
      this.emit('final', { key: `k${this.n}`, text: `local ${this.n}`, span: { start: this.n * 4000, end: this.n * 4000 + 3000 } })
      this.n++
    }
    this.emit('progress', this.got)
  }
  async close() {}
}

test('本地识别：从文件按 2 秒一包送，句子时间加上起点，进度到终点', async () => {
  const f = makePcm(20)
  const prog = []
  const out = await recognizeLocal({ pcmFile: f, durationMs: 20_000, onProgress: (ms) => prog.push(ms), createAsr: () => new FakeLocal() })
  assert.equal(out.length, 5)
  assert.deepEqual(out[1], { startMs: 4000, endMs: 7000, text: 'local 1' })
  assert.equal(prog.at(-1), 20_000)
  const part = await recognizeLocal({ pcmFile: f, durationMs: 20_000, fromMs: 8000, toMs: 16_000, createAsr: () => new FakeLocal() })
  assert.equal(part[0].startMs, 8000)
  await sleep(1)
})
