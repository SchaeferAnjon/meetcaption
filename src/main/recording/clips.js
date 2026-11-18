import fs from 'node:fs'
import path from 'node:path'

// 记录时录屏：每开一次是一段，一段一个文件，放在这一场的文件夹里 recordings/录屏-1.mp4（Chromium 不出 mp4 时是 .webm）。
// session.recordings：[{ file, startAt, endAt, width, height, bytes, mime }]。startAt / endAt 和字幕的 seg.startedAt、截图的 at 一样是毫秒时间戳，
// 视频里第 t 毫秒就是这一场的 startAt + t（暂停记录时这一段收尾，继续时另开一段，所以每段里的时间是连续的）。
// 录完以后「画面一变就截一张」的截图记进 session.slides：{ file: 'slides/rec-00.12.05.jpg', at, source: 'recording', recording: 'recordings/录屏-1.mp4' }，
// 文件名是它在这一场里的位置（时.分.秒），和手动截的（slides/<钟点>.jpg，没有 source）分开。
// 不引 electron，单测直接用。

export const REC_DIR = 'recordings'
export const REC_SOURCE = 'recording'
const pad = (n) => String(n).padStart(2, '0')

/** 下一段录屏的文件名：recordings/录屏-<n>.<ext>，n 比已有的都大，文件夹里也没有这个文件。 */
export function nextRecordingFile(sessionDir, recordings = [], ext = 'mp4') {
  let n = 1
  for (const r of recordings ?? []) {
    const m = String(r?.file ?? '').match(/录屏-(\d+)\.\w+$/)
    if (m) n = Math.max(n, Number(m[1]) + 1)
  }
  while (fs.existsSync(path.join(sessionDir, REC_DIR, `录屏-${n}.${ext}`))) n++
  return `${REC_DIR}/录屏-${n}.${ext}`
}

/** 这一段录屏有多长（毫秒）：endAt 没写上（录到一半应用退出了）时不知道，回 null。 */
export function recordingLength(rec) {
  return rec?.endAt && rec.startAt ? Math.max(0, rec.endAt - rec.startAt) : null
}

/** 时刻 at（毫秒时间戳）落在哪一段录屏里：→ { rec, index, ms（在这段视频里的毫秒）} | null。没写结束时间的那段当它一直录到后面。 */
export function recordingAt(recordings, at) {
  const list = recordings ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const rec = list[i]
    if (!rec?.startAt || at < rec.startAt) continue
    if (rec.endAt != null && at > rec.endAt) continue
    return { rec, index: i, ms: at - rec.startAt }
  }
  return null
}

/** 录屏里截的画面的文件名（不带扩展名）：rec-时.分.秒，按它在这一场里的位置。 */
export function recSlideBase(offsetMs) {
  const s = Math.max(0, Math.floor(offsetMs / 1000))
  return `rec-${pad(Math.floor(s / 3600))}.${pad(Math.floor((s % 3600) / 60))}.${pad(s % 60)}`
}

export const isRecSlide = (x) => x?.source === REC_SOURCE

/**
 * 录屏里画面一变截到的一张要不要：前后 gapMs 内已经有手动截的（用户自己按了「截取画面」），就是同一页，不要重复。
 */
export function wantRecFrame(slides, at, gapMs = 5000) {
  return !(slides ?? []).some((x) => x?.file && !isRecSlide(x) && Math.abs(Number(x.at) - at) <= gapMs)
}

/**
 * 把一段录屏截到的画面并进 slides：先拿掉这段录屏以前截过的（重新截一遍时不重复），再按时间插进去。
 * → { slides, removed: 拿掉的旧文件 }
 */
export function mergeRecSlides(slides, recordingFile, added) {
  const removed = []
  const kept = []
  for (const x of slides ?? []) {
    if (isRecSlide(x) && x.recording === recordingFile) removed.push(x.file)
    else kept.push(x)
  }
  const fresh = added.map((x) => ({ file: x.file, at: x.at, source: REC_SOURCE, recording: recordingFile }))
  return { slides: [...kept, ...fresh].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0)), removed }
}

/** 还没截过画面的录屏（录完还没来得及截就退出了的也算）。 */
export function recordingsToScan(session) {
  return (session.recordings ?? []).filter((r) => r?.file && r.frames == null)
}
