import fs from 'node:fs'

// 录音的封装：编码器（隐藏窗口里的 WebCodecs AudioEncoder，Opus）出来的一包一包，自己封成 WebM。
// 不用 MediaRecorder：它录出来的 webm 没有 Cues、没有时长，播放器只能从头读到尾才知道多长，拖到后面跳不准。
// 这里等一场录完再一次写好：开头 SeekHead 指向 Info、Tracks、Cues，Info 带 Duration，每 5 秒一个 Cluster、一个 CuePoint。
// 会上收到的包先追加进一个包文件（packets.bin，一包 = u32 长度 + f64 时间戳微秒 + f64 时长微秒 + 数据），应用崩了也还在，下次能接着封。

const CLUSTER_MS = 5000

function vint(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const b = Buffer.alloc(len)
      let v = BigInt(n)
      for (let i = len - 1; i >= 0; i--) {
        b[i] = Number(v & 0xffn)
        v >>= 8n
      }
      b[0] |= 1 << (8 - len)
      return b
    }
  }
  throw new Error('EBML 大小超出范围')
}
function idBytes(id) {
  const out = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff)
  return Buffer.from(out)
}
const el = (id, ...parts) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([idBytes(id), vint(body.length), body])
}
function uintBytes(n, fixed = 0) {
  let v = BigInt(Math.max(0, Math.round(n)))
  const out = []
  do {
    out.unshift(Number(v & 0xffn))
    v >>= 8n
  } while (v > 0n)
  while (out.length < fixed) out.unshift(0)
  return Buffer.from(out)
}
const uint = (id, n, fixed) => el(id, uintBytes(n, fixed))
const str = (id, s) => el(id, Buffer.from(s, 'utf8'))
const f64 = (id, x) => {
  const b = Buffer.alloc(8)
  b.writeDoubleBE(x)
  return el(id, b)
}

/** OpusHead（RFC 7845）：编码器没给 description 时自己写一个 */
export function opusHead({ channels = 1, preSkip = 312, inputRate = 48000 } = {}) {
  const b = Buffer.alloc(19)
  b.write('OpusHead', 0, 'latin1')
  b[8] = 1
  b[9] = channels
  b.writeUInt16LE(preSkip, 10)
  b.writeUInt32LE(inputRate, 12)
  b.writeInt16LE(0, 16)
  b[18] = 0
  return b
}

/**
 * 一组 Opus 包 → 一个完整的 WebM（Buffer）。packets：[{ ts（微秒）, dur（微秒）, data }]，按时间排好。
 * head：OpusHead（CodecPrivate），channels：声道数。
 */
export function muxOpusWebm(packets, { head, channels = 1 } = {}) {
  const priv = head?.length ? Buffer.from(head) : opusHead({ channels })
  const preSkip = priv.readUInt16LE(10)
  const ebml = el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2))
  const last = packets.at(-1)
  const durationMs = last ? (last.ts + (last.dur || 20000)) / 1000 : 0
  const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), f64(0x4489, durationMs), str(0x4d80, 'MeetCaption'), str(0x5741, 'MeetCaption'))
  const tracks = el(
    0x1654ae6b,
    el(0xae, uint(0xd7, 1), uint(0x73c5, 1), uint(0x9c, 0), uint(0x83, 2), str(0x86, 'A_OPUS'), el(0x63a2, priv), uint(0x56aa, Math.round((preSkip * 1e9) / 48000)), uint(0x56bb, 80_000_000), el(0xe1, f64(0xb5, 48000), uint(0x9f, channels))),
  )
  // Cluster：每 5 秒一个，块里的时间是相对这个 Cluster 的毫秒（int16）
  const clusters = []
  let cur = null
  for (const p of packets) {
    const ms = Math.round(p.ts / 1000)
    if (!cur || ms - cur.time >= CLUSTER_MS || ms - cur.time > 32000) clusters.push((cur = { time: ms, blocks: [] }))
    const head4 = Buffer.alloc(4)
    head4[0] = 0x81 // 轨道 1
    head4.writeInt16BE(ms - cur.time, 1)
    head4[3] = 0x80 // 关键帧
    cur.blocks.push(el(0xa3, head4, Buffer.from(p.data)))
  }
  const clusterBufs = clusters.map((c) => el(0x1f43b675, uint(0xe7, c.time), ...c.blocks))
  // SeekHead 里的位置固定 8 字节，大小先算得出来
  const seek = (id, pos) => el(0x4dbb, el(0x53ab, idBytes(id)), uint(0x53ac, pos, 8))
  const seekLen = el(0x114d9b74, seek(0x1549a966, 0), seek(0x1654ae6b, 0), seek(0x1c53bb6b, 0)).length
  const infoPos = seekLen
  const tracksPos = infoPos + info.length
  let pos = tracksPos + tracks.length
  const cuePoints = []
  for (let i = 0; i < clusters.length; i++) {
    cuePoints.push(el(0xbb, uint(0xb3, clusters[i].time), el(0xb7, uint(0xf7, 1), uint(0xf1, pos))))
    pos += clusterBufs[i].length
  }
  const cues = el(0x1c53bb6b, ...cuePoints)
  const seekHead = el(0x114d9b74, seek(0x1549a966, infoPos), seek(0x1654ae6b, tracksPos), seek(0x1c53bb6b, pos))
  const segment = el(0x18538067, seekHead, info, tracks, ...clusterBufs, cues)
  return Buffer.concat([ebml, segment])
}

// ---------- 包文件 ----------

export function packetRecord({ ts, dur, data }) {
  const b = Buffer.alloc(20)
  b.writeUInt32LE(data.byteLength, 0)
  b.writeDoubleLE(ts, 4)
  b.writeDoubleLE(dur || 0, 12)
  return Buffer.concat([b, Buffer.from(data)])
}

/** 读包文件；最后半包（写到一半崩了）丢掉 */
export function readPackets(file) {
  const buf = fs.readFileSync(file)
  const out = []
  for (let o = 0; o + 20 <= buf.length; ) {
    const len = buf.readUInt32LE(o)
    if (o + 20 + len > buf.length) break
    out.push({ ts: buf.readDoubleLE(o + 4), dur: buf.readDoubleLE(o + 12), data: buf.subarray(o + 20, o + 20 + len) })
    o += 20 + len
  }
  return out
}
