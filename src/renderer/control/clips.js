'use strict'
// 会后详情页的视频分「段」：视频模式是一整个文件（一段，从 0 开始）；记录时录的屏是好几段（session.recordings）。
// 每段 { file（绝对路径）, start, end（在这一场里的毫秒，end 不知道时为 null）, n（第几段，从 1 起）}。
// 播放器按这一场的时间走：跳到第 ms 毫秒时找它在哪一段，切过去，再跳到这一段里的 ms - start。

function videoClips(s) {
  if (s?.video?.file) return [{ file: s.video.file, start: 0, end: s.video.durationMs ?? null, n: 1 }]
  const base = String(s?.dir ?? '').replace(/[\\/]+$/, '')
  if (!base) return []
  return (s.recordings ?? [])
    .filter((r) => r?.file && r.startAt)
    .map((r, i) => ({ file: `${base}/${r.file}`, start: r.startAt - s.startedAt, end: r.endAt ? r.endAt - s.startedAt : null, n: i + 1 }))
    .sort((a, b) => a.start - b.start)
}

/** 第 ms 毫秒在哪一段：→ 下标；哪段都不在（没在录屏的时候）回 -1。不知道结束时间的那段当它一直录到下一段开始。 */
function clipIndexAt(clips, ms) {
  for (let i = clips.length - 1; i >= 0; i--) {
    const c = clips[i]
    if (ms >= c.start && (c.end == null || ms <= c.end)) return i
  }
  return -1
}

/** 一句话、一张截图从 ms 开始：落在录屏里就是 ms；刚好在一段开头前一点（1.5 秒内，话说到一半才开的录屏）算这一段的开头；别的回 null。 */
function clipSeekable(clips, ms) {
  if (clipIndexAt(clips, ms) >= 0) return ms
  const next = clips.find((c) => c.start > ms && c.start - ms <= 1500)
  return next ? next.start : null
}
