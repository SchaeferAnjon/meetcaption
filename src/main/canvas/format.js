// 画布笔记库里的写法：packages/format/src/meetcaption.ts 的 JS 版（MeetCaption 纯 JS 无打包器、公开仓库不带画布笔记的包，所以抄一份）。
// 两边必须逐字一样：test/canvas-format.test.js 拿样本和 fixtures 里 writeMcRecord 的输出比，
// 画布笔记那边的 packages/format/test/meetcaption-js.test.ts 再拿同一份样本比 TS 版，任何一边改了写法两边的测试都会挂。

export const MC_MODE_NAMES = { class: '课堂', online: '网课', meeting: '会议', interview: '面试', video: '视频' }
export const MC_MODE_SOURCE = { class: 'mic', online: 'system', meeting: 'system', interview: 'system', video: 'system' }
export const isMcMode = (v) => typeof v === 'string' && v in MC_MODE_NAMES

const q = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

export function mcOpenUrl(o) {
  return `meetcaption://open?${q({ session: o.session, t: o.t === undefined ? undefined : Math.max(0, Math.floor(o.t)), view: o.view })}`
}

export function canvasNotesMcUrl(j) {
  if (j.file) return `canvas-notes://open?${q({ file: j.file, t: j.t, session: j.session, back: j.back, vault: j.vault })}`
  return `canvas-notes://meetcaption?${q({ session: j.session, t: j.t, back: j.back, vault: j.vault })}`
}

/** 「2026-11-04 09.29」那一场几点开始（当天 0 点起的秒）；认不出是 null */
export function sessionClock(session) {
  const m = /(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?\s*$/.exec(session)
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : null
}
export const sessionDate = (session) => /^\d{4}-\d{2}-\d{2}/.exec(session)?.[0] ?? null

const pad = (n) => String(n).padStart(2, '0')
export function clockLabel(sec, withSec = false) {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}${withSec ? ':' + pad(s % 60) : ''}`
}
export function spanLabel(sec) {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}
export function mcTimeLink(session, t) {
  const c = sessionClock(session)
  return `[▶ ${c === null ? spanLabel(t) : clockLabel(c + t)}](${mcOpenUrl({ session, t })})`
}

export const mcRecordingDir = (notePath) => `.canvas-notes/录音/${notePath.replace(/\.md$/i, '')}`
export const mcSubtitlePath = (session) => `.canvas-notes/字幕/meetcaption/${session}.vtt`
export const mcFrameName = (clock) => `画面-${clockLabel(clock, true).replace(/:/g, '.')}.jpg`

export function writeVtt(cues) {
  const ts = (s) => {
    const ms = Math.round(s * 1000)
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}.${String(ms % 1000).padStart(3, '0')}`
  }
  return 'WEBVTT\n\n' + cues.map((c) => `${ts(c.start)} --> ${ts(c.end)}\n${c.who ? `<v ${c.who}>` : ''}${c.text}${c.tr ? '\n' + c.tr : ''}`).join('\n\n') + '\n'
}

/** McRecordDraft → 一篇上课记录（和 TS 版 writeMcRecord 逐字一样） */
export function writeMcRecord(d) {
  const list = (xs) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`
  const dir = mcRecordingDir(d.path)
  const up = '../'.repeat(d.path.split('/').length - 1)
  const fm = [
    '---',
    `类型: ${d.mode === 'meeting' ? '会议记录' : d.mode === 'interview' ? '面试记录' : '上课记录'}`,
    ...(d.course ? [`课程: ${d.course}`] : []),
    `模式: ${MC_MODE_NAMES[d.mode]}`,
    `日期: ${sessionDate(d.sessions[0]) ?? ''}`,
    ...(d.duration ? [`时长: "${d.duration}"`] : []),
    `meetcaption: ${list(d.sessions)}`,
    `录音: ${list(d.sessions.map((_, i) => `${dir}/录音-${i + 1}.webm`))}`,
    `字幕: ${list(d.sessions.map(mcSubtitlePath))}`,
    '---',
  ]
  const out = [...fm, `# ${d.title}`, '']
  if (d.overview) out.push(`> [!ai] 这节课讲了什么 · MeetCaption${d.overview.engine ? ' · ' + d.overview.engine : ''}`, ...d.overview.text.split('\n').map((l) => (l ? `> ${l}` : '>')), '')
  if (d.todos?.length) {
    out.push('## 作业', '')
    for (const x of d.todos) out.push(`- [ ] ${x.text} ${mcTimeLink(x.session, x.t)}${x.due ? ` 📅 ${x.due}` : ''}`)
    out.push('')
  }
  const many = (d.parts?.length ?? 0) > 1
  for (const [i, p] of (d.parts ?? []).entries()) {
    const c = sessionClock(p.session)
    if (many) out.push(`## 第 ${i + 1} 段 · ${c === null ? p.session : clockLabel(c)}`, '')
    for (const s of p.sections) {
      out.push(`${many ? '###' : '##'} ${s.title} ${mcTimeLink(p.session, s.t)}`, '')
      for (const pt of s.points ?? []) out.push(`- ${pt.text} ${mcTimeLink(p.session, pt.t)}`)
      if (s.points?.length) out.push('')
      for (const f of s.frames ?? []) out.push(`![关键画面 ${clockLabel(f, true)}](${encodeURI(`${up}${dir}/${mcFrameName(f)}`)})`, '')
    }
  }
  return out.join('\n').replace(/\n+$/, '\n')
}

// ---------- meetcaption:// 深链（画布笔记、画布今日发过来的） ----------

/** → { kind: 'start', project, mode, source, back } | { kind: 'open', session, t, view } | null */
export function parseMcUrl(url) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    return null
  }
  if (u.protocol !== 'meetcaption:') return null
  const g = (k) => u.searchParams.get(k) || undefined
  if (u.hostname === 'start') {
    const mode = isMcMode(g('mode')) ? g('mode') : undefined
    const source = g('source') === 'mic' || g('source') === 'system' ? g('source') : undefined
    return { kind: 'start', project: g('project'), mode, source, back: g('back') }
  }
  if (u.hostname === 'open') {
    const session = g('session')
    if (!session) return null
    const t = Number(g('t') ?? 0)
    return { kind: 'open', session, t: Number.isFinite(t) && t >= 0 ? Math.floor(t) : 0, ...(g('view') === 'screen' ? { view: 'screen' } : {}) }
  }
  return null
}
