import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openMedia } from '../src/main/video/demux.js'

// 视频模式读声音的第一步：不靠 ffmpeg，自己拆 mp4、mov、m4a、webm、mkv、mp3 的封装。
// 样本文件是用 ffmpeg 做的 3 秒小文件（test/fixtures/video），放的是 test/fixtures/local-asr-en.wav 的前 3 秒。
const dir = fileURLToPath(new URL('./fixtures/video/', import.meta.url))
const at = (f) => path.join(dir, f)

const CASES = [
  ['a-aac.mp4', 'mp4', 'mp4a.40.2', 44100, true],
  ['a.mov', 'mp4', 'mp4a.40.2', 44100, true],
  ['a.m4a', 'mp4', 'mp4a.40.2', 44100, false],
  ['a-opus.webm', 'mkv', 'opus', 48000, true],
  ['a-aac.mkv', 'mkv', 'mp4a.40.2', 48000, true],
  ['a.mp3', 'mp3', 'mp3', 44100, false],
]

for (const [file, kind, codec, rate, video] of CASES) {
  test(`demux: ${file} 读出时长、编码、声音每一帧的位置，画面有没有`, async () => {
    const m = await openMedia(at(file))
    try {
      assert.equal(m.kind, kind)
      assert.ok(Math.abs(m.durationMs - 3000) < 120, `时长 ${m.durationMs}`)
      assert.equal(m.audio.codec, codec)
      assert.equal(m.audio.sampleRate, rate)
      assert.equal(m.audio.channels, 2)
      assert.equal(m.hasVideo, video)
      if (video) assert.deepEqual([m.video.width, m.video.height], [160, 90])
      assert.ok(m.audio.count > 80, `帧数 ${m.audio.count}`)
      const frames = await m.readFrames(0, m.audio.count)
      assert.equal(frames.length, m.audio.count)
      assert.ok(frames.every((f) => f.data.length > 0 && f.duration > 0))
      // 时间递增，最后一帧收在时长附近
      for (let i = 1; i < frames.length; i++) assert.ok(frames[i].timestamp >= frames[i - 1].timestamp)
      const last = frames.at(-1)
      assert.ok(Math.abs((last.timestamp + last.duration) / 1000 - 3000) < 120)
      // 按时间找帧
      const i = m.indexAt(1500)
      assert.ok(Math.abs(m.timeOf(i) / 1000 - 1500) < 60)
      if (codec.startsWith('mp4a')) assert.ok(m.audio.description?.length >= 2, 'AAC 要带 AudioSpecificConfig')
      if (codec === 'opus') assert.equal(Buffer.from(m.audio.description).toString('latin1', 0, 8), 'OpusHead')
    } finally {
      await m.close()
    }
  })
}

test('demux: 声音是 AC3（mkv 里常见）读不了，说清是 AC3；画面照样认得出来', async () => {
  await assert.rejects(openMedia(at('a-ac3.mkv')), (e) => e.code === 'audio-unsupported' && e.codecLabel === 'AC3' && e.hasVideo === true && /AC3/.test(e.message))
})

test('demux: 没有声音的视频报 no-audio；不认识的格式报 format', async () => {
  await assert.rejects(openMedia(at('silent.mp4')), (e) => e.code === 'no-audio' && e.hasVideo === true)
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'demux-')), 'x.avi')
  fs.writeFileSync(tmp, Buffer.from('RIFF....AVI LIST'))
  await assert.rejects(openMedia(tmp), (e) => e.code === 'format')
  await assert.rejects(openMedia(path.join(os.tmpdir(), 'no-such-file.mp4')), (e) => e.code === 'open')
  fs.rmSync(path.dirname(tmp), { recursive: true })
})

test('demux: 读一段帧（从中间开始）和整段读出来的一致', async () => {
  const m = await openMedia(at('a-aac.mp4'))
  const all = await m.readFrames(0, m.audio.count)
  const mid = await m.readFrames(40, 60)
  assert.equal(mid.length, 20)
  assert.deepEqual(Buffer.from(mid[5].data), Buffer.from(all[45].data))
  await m.close()
})
