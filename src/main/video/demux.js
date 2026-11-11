import fs from 'node:fs/promises'
import path from 'node:path'
import { t } from '../i18n.js'

// 视频模式读声音的第一步：不靠 ffmpeg，自己把 mp4、mov、m4a、webm、mkv、mp3 的封装拆开，
// 找出声音轨每一帧在文件里的位置（只读文件头和声音那几段，不把一个 1.4 GB 的文件读进内存），
// 帧交给隐藏窗口里 Chromium 自带的 AudioDecoder 解码（见 renderer/video/worker.js）。
// 读不了的声音格式（AC3、DTS、TrueHD 这些）和没有声音的文件，抛出带 code 的错，界面照设计稿说「这个文件的声音读不出来」。
//
// openMedia(file) → { kind, durationMs, hasVideo, video, audio: { codec, sampleRate, channels, description, count, ... }, readFrames(i0, i1), close() }
// readFrames 回 [{ data: Uint8Array, timestamp（微秒）, duration（微秒）}]，下标是声音轨的第几帧。

export class MediaError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.code = code
    Object.assign(this, extra)
  }
}

export const MEDIA_EXTS = ['.mp4', '.mov', '.webm', '.mp3', '.m4a', '.mkv']
export const DROP_EXTS = ['mp4', 'mov', 'webm', 'mp3', 'm4a']

// 声音轨的编码名，给界面说「它的声音是 AC3 或 DTS 格式」用
const UNSUPPORTED = {
  'ac-3': 'AC3', 'ec-3': 'E-AC3', dtsc: 'DTS', dtse: 'DTS', dtsh: 'DTS', dtsl: 'DTS', mlpa: 'TrueHD', alac: 'ALAC',
  A_AC3: 'AC3', A_EAC3: 'E-AC3', A_DTS: 'DTS', 'A_DTS/EXPRESS': 'DTS', 'A_DTS/LOSSLESS': 'DTS', A_TRUEHD: 'TrueHD', A_MLP: 'TrueHD', A_ALAC: 'ALAC',
}

/** 读文件的小工具：按位置读，头部那种零碎的读取走一块 1 MB 的缓存。 */
class Source {
  constructor(fh, size) {
    this.fh = fh
    this.size = size
    this.cache = { start: 0, buf: Buffer.alloc(0) }
  }

  async read(off, len) {
    len = Math.max(0, Math.min(len, this.size - off))
    if (!len) return Buffer.alloc(0)
    const c = this.cache
    if (off >= c.start && off + len <= c.start + c.buf.length) return c.buf.subarray(off - c.start, off - c.start + len)
    if (len >= 1 << 20) return this.#raw(off, len)
    const want = Math.min(1 << 20, this.size - off)
    c.buf = await this.#raw(off, want)
    c.start = off
    return c.buf.subarray(0, len)
  }

  async #raw(off, len) {
    const buf = Buffer.allocUnsafe(len)
    let got = 0
    while (got < len) {
      const { bytesRead } = await this.fh.read(buf, got, len - got, off + got)
      if (!bytesRead) break
      got += bytesRead
    }
    return got === len ? buf : buf.subarray(0, got)
  }
}

/** 声音轨的样本表：每一帧的位置、大小、时间（微秒）。用 typed array，两小时的课也只有几 MB。 */
function table(n) {
  return { offsets: new Float64Array(n), sizes: new Uint32Array(n), times: new Float64Array(n), durs: new Float64Array(n), count: n }
}

/* ---------------- MP4 / MOV / M4A ---------------- */

const fourcc = (b, o) => b.toString('latin1', o, o + 4)

async function boxes(src, start, end) {
  const out = []
  let o = start
  while (o + 8 <= end) {
    const head = await src.read(o, 16)
    if (head.length < 8) break
    let size = head.readUInt32BE(0)
    const type = fourcc(head, 4)
    let hdr = 8
    if (size === 1) {
      if (head.length < 16) break
      size = Number(head.readBigUInt64BE(8))
      hdr = 16
    } else if (size === 0) size = end - o
    if (size < hdr) break
    out.push({ type, start: o, hdr, end: Math.min(end, o + size) })
    o += size
  }
  return out
}

const child = (list, type) => list.find((b) => b.type === type)

// 在一段 buffer 里按 4 字节名字找子盒子（用于 stsd 里的编码盒子，里面套着 esds / dOps）
function findBox(buf, type, from = 0, to = buf.length) {
  let o = from
  while (o + 8 <= to) {
    const size = buf.readUInt32BE(o)
    if (size < 8 || o + size > to) break
    if (fourcc(buf, o + 4) === type) return buf.subarray(o + 8, o + size)
    o += size
  }
  return null
}

function findDeep(buf, type, depth = 0) {
  if (depth > 4) return null
  const hit = findBox(buf, type)
  if (hit) return hit
  let o = 0
  while (o + 8 <= buf.length) {
    const size = buf.readUInt32BE(o)
    if (size < 8 || o + size > buf.length) break
    const name = fourcc(buf, o + 4)
    if (name === 'wave' || name === 'mp4a') {
      const r = findDeep(buf.subarray(o + 8, o + size), type, depth + 1)
      if (r) return r
    }
    o += size
  }
  return null
}

// esds：MPEG-4 描述符。拿出 objectTypeIndication 和 AudioSpecificConfig
function parseEsds(box) {
  // 全盒子：4 字节版本和标志，然后是描述符
  let o = 4
  const len = () => {
    let n = 0
    for (let i = 0; i < 4; i++) {
      const b = box[o++]
      n = (n << 7) | (b & 0x7f)
      if (!(b & 0x80)) break
    }
    return n
  }
  const out = { objectType: null, config: null }
  while (o < box.length) {
    const tag = box[o++]
    const l = len()
    if (tag === 0x03) {
      // ES_ID(2) + 标志(1)，标志里有几位表示后面还带可选字段
      const fl = box[o + 2]
      o += 3
      if (fl & 0x80) o += 2
      if (fl & 0x40) o += 1 + box[o]
      if (fl & 0x20) o += 2
    } else if (tag === 0x04) {
      out.objectType = box[o]
      o += 13
    } else if (tag === 0x05) {
      out.config = Uint8Array.from(box.subarray(o, o + l))
      return out
    } else o += l
  }
  return out
}

// AudioSpecificConfig 前 5 位是 audioObjectType（31 表示后面 6 位再加 32）
function aacObjectType(config) {
  if (!config?.length) return 2
  let aot = config[0] >> 3
  if (aot === 31) aot = 32 + (((config[0] & 7) << 3) | (config[1] >> 5))
  return aot
}

function parseStsd(stsd, handler) {
  // 全盒子：版本和标志 4 字节、条目数 4 字节，然后是条目
  const count = stsd.readUInt32BE(4)
  if (!count) return null
  const size = stsd.readUInt32BE(8)
  const type = fourcc(stsd, 12)
  const entry = stsd.subarray(8, 8 + size)
  if (handler === 'vide') return { codec: type, width: entry.readUInt16BE(8 + 24), height: entry.readUInt16BE(8 + 26) }
  // 声音：8 字节盒子头 + 6 保留 + 2 数据引用 + 版本(2) 修订(2) 厂商(4) 声道(2) 位数(2) 压缩 id(2) 包大小(2) 采样率(16.16)
  const version = entry.readUInt16BE(16)
  const channels = entry.readUInt16BE(24)
  const sampleRate = entry.readUInt16BE(32)
  const extra = version === 1 ? 16 : version === 2 ? 36 : 0
  const inner = entry.subarray(36 + extra)
  return { codec: type, channels, sampleRate, inner }
}

async function openMp4(src) {
  const top = await boxes(src, 0, src.size)
  const moovBox = child(top, 'moov')
  if (!moovBox) throw new MediaError('no-index', t('这个文件的头部读不出来（可能没下载完，或者不是普通的 mp4）'))
  const moovBuf = await src.read(moovBox.start + moovBox.hdr, moovBox.end - moovBox.start - moovBox.hdr)
  // moov 在文件里可能很大：整块读进来再在内存里拆
  const parse = (buf, start = 0, end = buf.length) => {
    const out = []
    let o = start
    while (o + 8 <= end) {
      let size = buf.readUInt32BE(o)
      let hdr = 8
      if (size === 1) {
        size = Number(buf.readBigUInt64BE(o + 8))
        hdr = 16
      } else if (size === 0) size = end - o
      if (size < hdr || o + size > end) break
      out.push({ type: fourcc(buf, o + 4), body: buf.subarray(o + hdr, o + size) })
      o += size
    }
    return out
  }
  const get = (list, type) => list.find((b) => b.type === type)?.body
  const mvhd = get(parse(moovBuf), 'mvhd')
  let durationMs = 0
  if (mvhd) {
    const v1 = mvhd[0] === 1
    const timescale = mvhd.readUInt32BE(v1 ? 20 : 12)
    const dur = v1 ? Number(mvhd.readBigUInt64BE(24)) : mvhd.readUInt32BE(16)
    durationMs = timescale ? Math.round((dur / timescale) * 1000) : 0
  }
  const tracks = []
  for (const trak of parse(moovBuf).filter((b) => b.type === 'trak')) {
    const mdia = get(parse(trak.body), 'mdia')
    if (!mdia) continue
    const mdiaList = parse(mdia)
    const hdlr = get(mdiaList, 'hdlr')
    const mdhd = get(mdiaList, 'mdhd')
    const minf = get(mdiaList, 'minf')
    if (!hdlr || !mdhd || !minf) continue
    const handler = fourcc(hdlr, 8)
    const stbl = get(parse(minf), 'stbl')
    if (!stbl) continue
    const st = parse(stbl)
    const v1 = mdhd[0] === 1
    const timescale = mdhd.readUInt32BE(v1 ? 20 : 12)
    const stsd = get(st, 'stsd')
    if (!stsd) continue
    tracks.push({ handler, timescale, st, get: (n) => get(st, n), stsd: parseStsd(stsd, handler), stsdBuf: stsd })
  }
  const vtrack = tracks.find((x) => x.handler === 'vide')
  const atrack = tracks.find((x) => x.handler === 'soun')
  const video = vtrack?.stsd ? { codec: vtrack.stsd.codec, width: vtrack.stsd.width, height: vtrack.stsd.height } : null
  if (!atrack?.stsd) throw new MediaError('no-audio', t('这个文件里没有声音'), { hasVideo: Boolean(video) })
  const { codec, inner, channels, sampleRate } = atrack.stsd
  const label = UNSUPPORTED[codec]
  if (label) throw new MediaError('audio-unsupported', t(`这个文件的声音是 {0} 格式，读不出来`, label), { codecLabel: label, hasVideo: Boolean(video), durationMs })
  let audio
  if (codec === 'mp4a') {
    const esds = findDeep(inner, 'esds')
    const es = esds ? parseEsds(esds) : { objectType: null, config: null }
    if (es.objectType === 0x6b || es.objectType === 0x69) audio = { codec: 'mp3', sampleRate, channels }
    else if (es.objectType != null && es.objectType !== 0x40 && es.objectType !== 0x66 && es.objectType !== 0x67 && es.objectType !== 0x68)
      throw new MediaError('audio-unsupported', t(`这个文件的声音是 {0} 格式，读不出来`, `MPEG-4 (0x${es.objectType.toString(16)})`), { codecLabel: 'MPEG-4', hasVideo: Boolean(video), durationMs })
    else audio = { codec: `mp4a.40.${aacObjectType(es.config)}`, sampleRate, channels, description: es.config }
  } else if (codec === 'Opus') {
    const dops = findDeep(inner, 'dOps')
    audio = { codec: 'opus', sampleRate: 48000, channels: dops ? dops[1] : channels, description: null }
    if (dops) {
      // dOps（版本 1 字节、声道、预跳、采样率、增益…）换成 OpusHead 当 description
      const head = Buffer.alloc(19)
      head.write('OpusHead', 0, 'latin1')
      head[8] = 1
      head[9] = dops[1]
      head.writeUInt16LE(dops.readUInt16BE(2), 10)
      head.writeUInt32LE(dops.readUInt32BE(4), 12)
      head.writeInt16LE(dops.readInt16BE(8), 16)
      head[18] = 0
      audio.description = Uint8Array.from(head)
    }
  } else if (codec === 'fLaC') {
    const dfla = findDeep(inner, 'dfLa')
    audio = { codec: 'flac', sampleRate, channels, description: dfla ? Uint8Array.from(dfla.subarray(4)) : null }
  } else if (codec === '.mp3') audio = { codec: 'mp3', sampleRate, channels }
  else if (['sowt', 'twos', 'lpcm', 'ipcm'].includes(codec)) throw new MediaError('audio-unsupported', t(`这个文件的声音是 {0} 格式，读不出来`, 'PCM'), { codecLabel: 'PCM', hasVideo: Boolean(video), durationMs })
  else throw new MediaError('audio-unsupported', t(`这个文件的声音是 {0} 格式，读不出来`, codec.trim()), { codecLabel: codec.trim(), hasVideo: Boolean(video), durationMs })

  // 样本表：stsz（每帧大小）、stsc（每个块里几帧）、stco / co64（块的位置）、stts（每帧时长）
  const stsz = atrack.get('stsz')
  const stco = atrack.get('stco')
  const co64 = atrack.get('co64')
  const stsc = atrack.get('stsc')
  const stts = atrack.get('stts')
  if (!stsz || !(stco || co64) || !stsc || !stts) throw new MediaError('no-index', t('这个文件的声音索引读不出来'))
  const fixed = stsz.readUInt32BE(4)
  const n = stsz.readUInt32BE(8)
  const tab = table(n)
  for (let i = 0; i < n; i++) tab.sizes[i] = fixed || stsz.readUInt32BE(12 + i * 4)
  const chunks = (stco ?? co64).readUInt32BE(4)
  const chunkOff = (i) => (stco ? stco.readUInt32BE(8 + i * 4) : Number(co64.readBigUInt64BE(8 + i * 8)))
  const runs = []
  for (let i = 0; i < stsc.readUInt32BE(4); i++) runs.push({ first: stsc.readUInt32BE(8 + i * 12), per: stsc.readUInt32BE(12 + i * 12) })
  let sample = 0
  for (let c = 0; c < chunks && sample < n; c++) {
    let per = runs[0].per
    for (const r of runs) if (c + 1 >= r.first) per = r.per
    let off = chunkOff(c)
    for (let k = 0; k < per && sample < n; k++, sample++) {
      tab.offsets[sample] = off
      off += tab.sizes[sample]
    }
  }
  // 时间：stts 是（帧数，每帧时长）的列表。部分 AAC（Opus）的第一帧有预跳，不去管它
  let idx = 0
  let tick = 0
  for (let i = 0; i < stts.readUInt32BE(4); i++) {
    const cnt = stts.readUInt32BE(8 + i * 8)
    const delta = stts.readUInt32BE(12 + i * 8)
    for (let k = 0; k < cnt && idx < n; k++, idx++) {
      tab.times[idx] = (tick / atrack.timescale) * 1e6
      tab.durs[idx] = (delta / atrack.timescale) * 1e6
      tick += delta
    }
  }
  if (!durationMs && n) durationMs = Math.round((tab.times[n - 1] + tab.durs[n - 1]) / 1000)
  return { kind: 'mp4', durationMs, video, audio, tab }
}

/* ---------------- MKV / WEBM（EBML） ---------------- */

const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f, Video: 0xe0,
  PixelWidth: 0xb0, PixelHeight: 0xba, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b,
  DefaultDuration: 0x23e383, CodecDelay: 0x56aa,
}

// 读一个 EBML 元素头：{ id, size（-1 表示长度未知）, hdr }
function ebmlHead(buf, o) {
  let first = buf[o]
  if (first == null) return null
  let idLen = 1
  while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++
  if (idLen > 4 || o + idLen >= buf.length) return null
  let id = 0
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[o + i]
  const s0 = buf[o + idLen]
  let sLen = 1
  while (sLen <= 8 && !(s0 & (0x80 >> (sLen - 1)))) sLen++
  if (sLen > 8 || o + idLen + sLen > buf.length) return null
  let size = s0 & (0xff >> sLen)
  let allOnes = size === 0xff >> sLen
  for (let i = 1; i < sLen; i++) {
    const b = buf[o + idLen + i]
    size = size * 256 + b
    if (b !== 0xff) allOnes = false
  }
  return { id, size: allOnes ? -1 : size, hdr: idLen + sLen }
}

const uintOf = (b) => {
  let n = 0
  for (const x of b) n = n * 256 + x
  return n
}

function floatOf(b) {
  return b.length === 4 ? b.readFloatBE(0) : b.length === 8 ? b.readDoubleBE(0) : 0
}

function parseEbmlChildren(buf) {
  const out = []
  let o = 0
  while (o < buf.length) {
    const h = ebmlHead(buf, o)
    if (!h) break
    const size = h.size < 0 ? buf.length - o - h.hdr : h.size
    out.push({ id: h.id, body: buf.subarray(o + h.hdr, o + h.hdr + size) })
    o += h.hdr + size
  }
  return out
}

async function openMkv(src) {
  // 先在文件开头找 Segment、Info、Tracks（一般在前 几 MB 里）
  let o = 0
  const head = await src.read(0, 64)
  const ebml = ebmlHead(head, 0)
  if (!ebml || ebml.id !== ID.EBML) throw new MediaError('no-index', t('这个文件的头部读不出来'))
  o = ebml.hdr + ebml.size
  let seg = null
  for (;;) {
    const h = ebmlHead(await src.read(o, 16), 0)
    if (!h) throw new MediaError('no-index', t('这个文件的头部读不出来'))
    if (h.id === ID.Segment) {
      seg = { start: o + h.hdr, end: h.size < 0 ? src.size : Math.min(src.size, o + h.hdr + h.size) }
      break
    }
    o += h.hdr + Math.max(0, h.size)
  }
  let timescale = 1_000_000
  let durationMs = 0
  let tracks = []
  const clusters = []
  o = seg.start
  while (o < seg.end) {
    const h = ebmlHead(await src.read(o, 16), 0)
    if (!h) break
    const size = h.size < 0 ? seg.end - o - h.hdr : h.size
    if (h.id === ID.Info || h.id === ID.Tracks) {
      const body = await src.read(o + h.hdr, size)
      for (const c of parseEbmlChildren(body)) {
        if (c.id === ID.TimestampScale) timescale = uintOf(c.body)
        else if (c.id === ID.Duration) durationMs = (floatOf(c.body) * timescale) / 1e6
        else if (c.id === ID.TrackEntry) {
          const f = {}
          for (const x of parseEbmlChildren(c.body)) {
            if (x.id === ID.TrackNumber) f.number = uintOf(x.body)
            else if (x.id === ID.TrackType) f.type = uintOf(x.body)
            else if (x.id === ID.CodecID) f.codecId = x.body.toString('latin1')
            else if (x.id === ID.CodecPrivate) f.priv = Uint8Array.from(x.body)
            else if (x.id === ID.DefaultDuration) f.defaultDuration = uintOf(x.body)
            else if (x.id === ID.Audio) for (const a of parseEbmlChildren(x.body)) a.id === ID.SamplingFrequency ? (f.sampleRate = floatOf(a.body)) : a.id === ID.Channels ? (f.channels = uintOf(a.body)) : 0
            else if (x.id === ID.Video) for (const a of parseEbmlChildren(x.body)) a.id === ID.PixelWidth ? (f.width = uintOf(a.body)) : a.id === ID.PixelHeight ? (f.height = uintOf(a.body)) : 0
          }
          tracks.push(f)
        }
      }
    } else if (h.id === ID.Cluster) clusters.push({ start: o + h.hdr, end: o + h.hdr + size })
    o += h.hdr + size
  }
  const video = tracks.find((x) => x.type === 1)
  const a = tracks.find((x) => x.type === 2)
  const hasVideo = Boolean(video)
  if (!a) throw new MediaError('no-audio', t('这个文件里没有声音'), { hasVideo })
  const label = UNSUPPORTED[a.codecId]
  if (label) throw new MediaError('audio-unsupported', t(`这个文件的声音是 {0} 格式，读不出来`, label), { codecLabel: label, hasVideo, durationMs: Math.round(durationMs) })
  const map = {
    A_AAC: () => ({ codec: `mp4a.40.${aacObjectType(a.priv)}`, description: a.priv }),
    A_OPUS: () => ({ codec: 'opus', description: a.priv }),
    A_VORBIS: () => ({ codec: 'vorbis', description: a.priv }),
    A_FLAC: () => ({ codec: 'flac', description: a.priv }),
    'A_MPEG/L3': () => ({ codec: 'mp3' }),
  }
  const mk = map[a.codecId]
  if (!mk) throw new MediaError('audio-unsupported', t(`这个文件的声音是 {0} 格式，读不出来`, a.codecId), { codecLabel: a.codecId, hasVideo, durationMs: Math.round(durationMs) })
  const audio = { sampleRate: a.codecId === 'A_OPUS' ? 48000 : (a.sampleRate || 48000), channels: a.channels || 2, ...mk() }

  // 扫所有簇里的声音块：只读块头（轨道号、时间），其余不读
  const offs = []
  const sizes = []
  const times = []
  const durs = []
  const defDur = a.defaultDuration ? a.defaultDuration / 1000 : 0 // 纳秒 → 微秒
  const scaleUs = timescale / 1000
  for (const cl of clusters) {
    let p = cl.start
    let base = 0
    // 一个簇一次读完（视频簇可能几 MB，整个文件只读一遍）
    const buf = await src.read(p, cl.end - cl.start)
    let q = 0
    while (q < buf.length) {
      const h = ebmlHead(buf, q)
      if (!h) break
      const size = h.size < 0 ? buf.length - q - h.hdr : h.size
      const body = q + h.hdr
      if (h.id === ID.Timecode) base = uintOf(buf.subarray(body, body + size))
      else if (h.id === ID.SimpleBlock || h.id === ID.BlockGroup) {
        let blockAt = body
        let blockSize = size
        let bdur = 0
        if (h.id === ID.BlockGroup) {
          for (const c of parseEbmlChildren(buf.subarray(body, body + size))) {
            if (c.id === ID.Block) {
              blockAt = c.body.byteOffset - buf.byteOffset
              blockSize = c.body.length
            } else if (c.id === ID.BlockDuration) bdur = uintOf(c.body) * scaleUs
          }
        }
        // 块头：轨道号（vint）、相对簇时间（int16）、标志
        const tn = buf[blockAt]
        let tl = 1
        while (tl <= 8 && !(tn & (0x80 >> (tl - 1)))) tl++
        let track = tn & (0xff >> tl)
        for (let i = 1; i < tl; i++) track = track * 256 + buf[blockAt + i]
        if (track === a.number && blockSize > tl + 3) {
          const rel = buf.readInt16BE(blockAt + tl)
          const lacing = (buf[blockAt + tl + 2] >> 1) & 3
          if (lacing === 0) {
            offs.push(p + blockAt + tl + 3)
            sizes.push(blockSize - tl - 3)
            times.push((base + rel) * scaleUs)
            durs.push(bdur || defDur || 0)
          }
        }
      }
      q = body + size
    }
  }
  const n = offs.length
  const tab = table(n)
  for (let i = 0; i < n; i++) {
    tab.offsets[i] = offs[i]
    tab.sizes[i] = sizes[i]
    tab.times[i] = times[i]
    // 没写时长的块（Opus 一帧通常 20 ms）用下一块的时间减这一块的
    tab.durs[i] = durs[i] || (i + 1 < n ? Math.max(0, times[i + 1] - times[i]) : defDur || 20_000)
  }
  if (!durationMs && n) durationMs = (tab.times[n - 1] + tab.durs[n - 1]) / 1000
  return { kind: 'mkv', durationMs: Math.round(durationMs), video: video ? { codec: video.codecId, width: video.width, height: video.height } : null, audio, tab }
}

/* ---------------- MP3 ---------------- */

const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }

async function openMp3(src) {
  let o = 0
  const head = await src.read(0, 10)
  if (head.toString('latin1', 0, 3) === 'ID3') o = 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9])
  const offs = []
  const sizes = []
  let sampleRate = 0
  let channels = 2
  let spf = 1152
  const window = 1 << 20
  let buf = Buffer.alloc(0)
  let bufStart = 0
  const at = async (p, len) => {
    if (p < bufStart || p + len > bufStart + buf.length) {
      buf = await src.read(p, Math.min(window, src.size - p))
      bufStart = p
    }
    return buf.subarray(p - bufStart, p - bufStart + len)
  }
  let lost = 0
  while (o + 4 <= src.size) {
    const h = await at(o, 4)
    if (h.length < 4) break
    if (h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) {
      o++
      if (++lost > 65536 && !offs.length) break
      continue
    }
    const ver = (h[1] >> 3) & 3 // 3 = MPEG1，2 = MPEG2，0 = 2.5
    const layer = (h[1] >> 1) & 3 // 1 = Layer III
    const bi = h[2] >> 4
    const si = (h[2] >> 2) & 3
    if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) {
      o++
      continue
    }
    const rate = MP3_RATES[ver][si]
    const br = MP3_BITRATES[ver === 3 ? 1 : 2][bi] * 1000
    const pad = (h[2] >> 1) & 1
    spf = ver === 3 ? 1152 : 576
    const len = Math.floor(((ver === 3 ? 144 : 72) * br) / rate) + pad
    channels = (h[3] >> 6) === 3 ? 1 : 2
    sampleRate = rate
    lost = 0
    // 第一帧常是 Xing / Info 头（不是声音）
    const isInfo = !offs.length && (await at(o + 4, 40)).toString('latin1').match(/Xing|Info/)
    if (!isInfo) {
      offs.push(o)
      sizes.push(len)
    }
    o += len
  }
  if (!offs.length) throw new MediaError('no-audio', t('这个文件里没有声音'), { hasVideo: false })
  const n = offs.length
  const tab = table(n)
  const dur = (spf / sampleRate) * 1e6
  for (let i = 0; i < n; i++) {
    tab.offsets[i] = offs[i]
    tab.sizes[i] = sizes[i]
    tab.times[i] = i * dur
    tab.durs[i] = dur
  }
  return { kind: 'mp3', durationMs: Math.round((n * dur) / 1000), video: null, audio: { codec: 'mp3', sampleRate, channels }, tab }
}

/* ---------------- 入口 ---------------- */

export async function openMedia(file) {
  let fh
  try {
    fh = await fs.open(file, 'r')
  } catch (e) {
    throw new MediaError('open', t(`打不开这个文件：{0}`, e.code === 'ENOENT' ? t('文件找不到了') : e.message))
  }
  try {
    const { size } = await fh.stat()
    const src = new Source(fh, size)
    const head = await src.read(0, 12)
    const ext = path.extname(file).toLowerCase()
    let m
    if (head.length >= 12 && fourcc(head, 4) === 'ftyp') m = await openMp4(src)
    else if (head.readUInt32BE(0) === ID.EBML) m = await openMkv(src)
    else if (head.toString('latin1', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || ext === '.mp3') m = await openMp3(src)
    else if (['.mp4', '.mov', '.m4a'].includes(ext)) m = await openMp4(src)
    else throw new MediaError('format', t('这种格式读不了，能拖进来的是 mp4、mov、webm、mp3、m4a'))
    const { tab } = m
    return {
      kind: m.kind,
      durationMs: m.durationMs,
      hasVideo: Boolean(m.video),
      video: m.video,
      audio: { ...m.audio, count: tab.count },
      /** 第 i0 到 i1（不含）帧的数据 */
      async readFrames(i0, i1) {
        i0 = Math.max(0, i0)
        i1 = Math.min(tab.count, i1)
        const out = []
        // 位置连着的帧合成一次读
        let i = i0
        while (i < i1) {
          let j = i + 1
          while (j < i1 && tab.offsets[j] === tab.offsets[j - 1] + tab.sizes[j - 1] && tab.offsets[j] + tab.sizes[j] - tab.offsets[i] < 8 << 20) j++
          const len = tab.offsets[j - 1] + tab.sizes[j - 1] - tab.offsets[i]
          const buf = await src.read(tab.offsets[i], len)
          for (let k = i; k < j; k++) {
            const at = tab.offsets[k] - tab.offsets[i]
            out.push({ data: Uint8Array.from(buf.subarray(at, at + tab.sizes[k])), timestamp: tab.times[k], duration: tab.durs[k] })
          }
          i = j
        }
        return out
      },
      /** 某个时间（毫秒）对应的帧下标 */
      indexAt(ms) {
        const us = ms * 1000
        let lo = 0
        let hi = tab.count
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (tab.times[mid] + tab.durs[mid] <= us) lo = mid + 1
          else hi = mid
        }
        return Math.min(lo, tab.count)
      },
      timeOf: (i) => tab.times[Math.min(i, tab.count - 1)],
      endOf: (i) => tab.times[Math.min(i, tab.count - 1)] + tab.durs[Math.min(i, tab.count - 1)],
      close: () => fh.close(),
    }
  } catch (e) {
    await fh.close().catch(() => {})
    throw e
  }
}
