import fs from 'node:fs'
import path from 'node:path'
import { uniqueName } from '../projects.js'

// 导出 SRT 字幕：一段一条。三种：原文和译文（两行）、只要原文、只要译文。
// 默认放在视频旁边、和视频同名（播放器会自动加载），另外两种带上后缀（.orig / .tr），不覆盖前一种。

const pad = (n, w = 2) => String(n).padStart(w, '0')

export function stamp(ms) {
  const t = Math.max(0, Math.round(ms))
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor((t % 3600000) / 60000))}:${pad(Math.floor((t % 60000) / 1000))},${pad(t % 1000, 3)}`
}

export const SRT_VARIANTS = ['both', 'orig', 'tr']

/** segments：存档里的段落；baseAt：session.startedAt。没有译文的句子「只要译文」那份里留原文。 */
export function toSrt(segments, baseAt, variant = 'both') {
  const rows = segments.filter((s) => s.text)
  const out = []
  rows.forEach((s, i) => {
    const start = s.startedAt - baseAt
    // 到下一句开始前结束，最短 1 秒，最长不超过它自己的时长加 1 秒
    const next = rows[i + 1] ? rows[i + 1].startedAt - baseAt : Infinity
    const end = Math.max(start + 1000, Math.min(next - 40, start + (s.dur ?? 3000) + 1000))
    const tr = (s.sentences ?? []).map((x) => x.tr).filter(Boolean).join(' ')
    const lines = variant === 'orig' ? [s.text] : variant === 'tr' ? [tr || s.text] : tr ? [s.text, tr] : [s.text]
    out.push(`${out.length + 1}\n${stamp(start)} --> ${stamp(end)}\n${lines.join('\n')}\n`)
  })
  return out.join('\n')
}

/** 存到视频旁边，文件名同视频；写不了（视频在只读的盘上）返回 null，由调用方让用户选位置。→ 路径 | null */
export function writeSrtBesideVideo(videoFile, content, variant = 'both') {
  const parsed = path.parse(videoFile)
  const suffix = variant === 'both' ? '' : `.${variant}`
  const file = path.join(parsed.dir, `${parsed.name}${suffix}.srt`)
  try {
    fs.writeFileSync(file, content)
    return file
  } catch {
    return null
  }
}

export { uniqueName }
