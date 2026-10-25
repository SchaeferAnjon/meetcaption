import { cleanText, extractJson } from '../prompts.js'
import { parseAt } from '../todos.js'
import '../../renderer/shared/texfix.js'
import { t } from '../i18n.js'

const { repair } = globalThis.texfix

// 图文版课堂笔记的「课件对照」：模型说老师讲到了哪些课件页、每页对着哪几行讲了什么（prompts.js 的 slideMapMessages），
// 这里核对后存成 session.summary.slideMap：[{ m, p, s, points: [{ lines, text, at, quote }] }]
// （m 课件 id，p 页码，s 大纲第几个小节（从 0 起，没有为 null），lines 是这一页 layout 里行的下标，at 是毫秒）。

const MAX_POINTS = 6
const MAX_LINES = 4

/** 笔记「## 大纲…」下面的 ### 小节标题，按顺序。 */
export function outlineSections(markdown) {
  const out = []
  let inOutline = false
  for (const line of String(markdown).split('\n')) {
    const h2 = line.match(/^##\s+(.+)/)
    if (h2) inOutline = /大纲|知识点/.test(h2[1])
    const h3 = inOutline && line.match(/^###\s+(.+)/)
    if (h3) out.push(h3[1].trim())
  }
  return out
}

/** pages：materials.js 的 materialsForMap(...).pages；sections：outlineSections 的结果。 */
export function parseSlideMap(raw, { pages, sections }) {
  const v = extractJson(raw)
  if (!Array.isArray(v?.pages)) throw new Error(t('课件对照的回复不是 JSON'))
  const byKey = new Map()
  for (const x of v.pages) {
    const page = pages.get(`${x?.m}:${Number(x?.p)}`)
    if (!page) continue
    const s = Number.isInteger(x.s) && x.s >= 1 && x.s <= sections.length ? x.s - 1 : null
    const points = (Array.isArray(x.points) ? x.points : [])
      .map((pt) => ({
        lines: [...new Set((Array.isArray(pt?.l) ? pt.l : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= page.lines.length))]
          .slice(0, MAX_LINES)
          .map((n) => n - 1),
        text: cleanText(repair(pt?.t)).slice(0, 400),
        at: parseAt(pt?.at),
        quote: cleanText(pt?.q).slice(0, 160),
      }))
      .filter((pt) => pt.text)
    const key = `${page.m.id}:${page.n}`
    const prev = byKey.get(key)
    if (prev) prev.points.push(...points)
    else byKey.set(key, { m: page.m.id, p: page.n, s, points })
  }
  for (const x of byKey.values()) x.points = x.points.slice(0, MAX_POINTS)
  return [...byKey.values()]
}
