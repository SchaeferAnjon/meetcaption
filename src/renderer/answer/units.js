/*
 * 答题卡正文的排法：回答（不带标签的正文）、标签 hints（[{ at, text }]，at 是标签后面那句在正文里的位置）、
 * 答完后回来的整句译文（trans.body：[{ text, tr, chunks }]）合成一串「单元」，一个单元 = 一句：
 * { hint: 标签文字 | '', text: 这一句英文, sen: 这一句的译文对象 | null }
 * 译文还没回来、或这一段对不上译文时，一个标签后面的整段算一个单元。普通脚本，挂在 globalThis.answerUnits。
 */
;(function (root) {
  'use strict'

  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

  // 按标签的位置把正文切成段：第一个标签前面如果有字，是一段没有标签的
  function segments(body, hints) {
    const cuts = (hints ?? []).filter((h) => h?.text && h.at >= 0).sort((a, b) => a.at - b.at)
    const out = []
    const first = cuts.length ? cuts[0].at : body.length
    if (first > 0 && body.slice(0, first).trim()) out.push({ hint: '', text: body.slice(0, first).trim() })
    cuts.forEach((h, i) => out.push({ hint: h.text, text: body.slice(Math.min(h.at, body.length), i + 1 < cuts.length ? cuts[i + 1].at : body.length).trim() }))
    if (!out.length) out.push({ hint: '', text: body.trim() })
    return out
  }

  // 从 from 起找连续几句译文，拼起来正好是这一段：→ [起, 止（含）] | null
  function match(sens, from, text) {
    const target = norm(text)
    if (!target) return null
    for (let s = from; s < sens.length; s++) {
      let acc = ''
      for (let e = s; e < sens.length; e++) {
        acc = norm(`${acc} ${sens[e]?.text ?? ''}`)
        if (acc === target) return [s, e]
        if (acc.length >= target.length) break
      }
    }
    return null
  }

  function build(body, hints, trans) {
    if (!String(body ?? '').trim() && !hints?.length) return []
    const sens = Array.isArray(trans?.body) ? trans.body : []
    const units = []
    let from = 0
    for (const seg of segments(String(body ?? ''), hints)) {
      const hit = sens.length ? match(sens, from, seg.text) : null
      if (!hit) {
        units.push({ ...seg, sen: null })
        continue
      }
      for (let i = hit[0]; i <= hit[1]; i++) units.push({ hint: i === hit[0] ? seg.hint : '', text: sens[i].text, sen: sens[i] })
      from = hit[1] + 1
    }
    return units
  }

  root.answerUnits = { segments, build }
})(globalThis)
