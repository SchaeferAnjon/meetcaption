import { clock } from './prompts.js'
import { aggregateTodos } from './todos.js'

// 命令面板的搜索：项目、会议（标题、纪要、字幕文字）、待办。不分大小写；空格分开的几个词都要出现（可以在不同字段里）。
// 每条结果带一个匹配片段 snippet 和片段里第一处命中的位置 match: [start, end]，界面拿来高亮。

const LIMITS = { projects: 8, sessions: 30, todos: 30 }
const BEFORE = 24
const AFTER = 56

export function queryTerms(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
}

/** text 里第一个命中的词附近截一段。没命中返回 null。 */
export function snippet(text, terms) {
  const s = String(text ?? '')
  if (!s) return null
  const lower = s.toLowerCase()
  let best = null
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (!best || i < best.i)) best = { i, len: t.length }
  }
  if (!best) return null
  let start = Math.max(0, best.i - BEFORE)
  let end = Math.min(s.length, best.i + best.len + AFTER)
  // 别从词中间或者行中间切开太难看：往前找到空白或换行
  const nl = s.lastIndexOf('\n', best.i)
  if (nl >= start) start = nl + 1
  const nl2 = s.indexOf('\n', best.i + best.len)
  if (nl2 >= 0 && nl2 < end) end = nl2
  const head = start > 0 ? '…' : ''
  const tail = end < s.length ? '…' : ''
  const body = s.slice(start, end).replace(/\s+/g, ' ')
  const offset = head.length + s.slice(start, best.i).replace(/\s+/g, ' ').length
  return { snippet: head + body + tail, match: [offset, offset + best.len] }
}

const hasAll = (hay, terms) => terms.every((t) => hay.includes(t))

// 按字段顺序找第一个有命中的，给片段
function firstHit(fields, terms) {
  for (const [field, text, extra] of fields) {
    const sn = snippet(text, terms)
    if (sn) return { field, ...sn, ...(extra ?? {}) }
  }
  return null
}

/**
 * projects：ProjectStore.list()；records：SessionStore.records()。
 * → { projects: [...], sessions: [...], todos: [...] }
 */
export function searchLibrary({ query, projects = [], records = [] }) {
  const terms = queryTerms(query)
  const out = { projects: [], sessions: [], todos: [] }
  if (!terms.length) return out
  const known = new Set(projects.map((p) => p.id))
  const pname = new Map(projects.map((p) => [p.id, p.name]))

  for (const p of projects) {
    const fields = [
      ['name', p.name],
      ['description', p.description],
      ['context', p.context],
      ['keywords', p.keywords],
    ]
    if (!hasAll(fields.map((f) => f[1] ?? '').join('\n').toLowerCase(), terms)) continue
    const hit = firstHit(fields, terms)
    out.projects.push({ id: p.id, name: p.name, color: p.color, icon: p.icon, archived: p.archived, ...hit })
  }

  const scored = []
  for (const r of records) {
    const transcript = r.lines.map((l) => l.text).join('\n')
    const hay = [r.title, r.summary, transcript, pname.get(r.projectId) ?? ''].join('\n').toLowerCase()
    if (!hasAll(hay, terms)) continue
    let hit = firstHit(
      [
        ['title', r.title],
        ['summary', r.summary],
      ],
      terms,
    )
    if (!hit) {
      const line = r.lines.find((l) => terms.some((t) => l.text.toLowerCase().includes(t)))
      if (line) hit = { field: 'transcript', ...snippet(`[${clock(line.at)}] ${line.speaker}：${line.text}`, terms), at: line.at }
    }
    hit ??= { field: 'project', snippet: pname.get(r.projectId) ?? '', match: [0, 0] }
    const rank = { title: 0, summary: 1, transcript: 2, project: 3 }[hit.field]
    scored.push({ rank, item: { id: r.id, title: r.title, projectId: r.projectId, startedAt: r.startedAt, hasSummary: r.hasSummary, ...hit } })
  }
  scored.sort((a, b) => a.rank - b.rank || b.item.startedAt - a.item.startedAt)
  out.sessions = scored.slice(0, LIMITS.sessions).map((x) => x.item)

  for (const t of aggregateTodos(records, { includeDone: true, knownProjects: known })) {
    const hay = [t.text, t.quote, t.dueText, pname.get(t.projectId) ?? ''].join('\n').toLowerCase()
    if (!hasAll(hay, terms)) continue
    const hit = firstHit(
      [
        ['text', t.text],
        ['quote', t.quote],
        ['dueText', t.dueText],
      ],
      terms,
    ) ?? { field: 'project', snippet: t.text, match: [0, 0] }
    out.todos.push({ ...t, ...hit })
  }
  // 没完成的在前
  out.todos.sort((a, b) => Number(a.done) - Number(b.done))
  out.projects = out.projects.slice(0, LIMITS.projects)
  out.todos = out.todos.slice(0, LIMITS.todos)
  return out
}
