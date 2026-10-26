// 麦克风这一路的两个判断：一段话是不是外放漏进来的对方的声音（和对方最近的字幕比词重合），
// 以及对方连着说的几段怎么拼成一个完整的问题（问题前面的铺垫句也带上）。
import { dropSmallTalk } from './assist/question.js'

// 汉字一个字一个词，其他文字按连续的字母数字切
const TOKEN = /\p{Script=Han}|[^\s\p{P}\p{S}\p{Script=Han}]+/gu

export function tokenize(text) {
  return String(text ?? '').toLowerCase().match(TOKEN) ?? []
}

function pairs(tokens) {
  const out = []
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`)
  return out
}

/** text 的词（和相邻两个词）有多少出现在 others 里：{ uni, bi }，0 到 1。 */
export function overlap(text, others) {
  const a = tokenize(text)
  if (!a.length) return { uni: 0, bi: 0, words: 0 }
  const pool = new Set()
  const pool2 = new Set()
  for (const o of others) {
    const t = tokenize(o)
    for (const w of t) pool.add(w)
    for (const p of pairs(t)) pool2.add(p)
  }
  const uni = a.filter((w) => pool.has(w)).length / a.length
  const p = pairs(a)
  const bi = p.length ? p.filter((x) => pool2.has(x)).length / p.length : uni
  return { uni, bi, words: a.length }
}

/**
 * 麦克风里这段话是不是对方声音的串音：它的词基本都在对方最近说的话里。
 * 同一段声音两路用同一个识别服务，串音的识别结果和对方那一路几乎一样；我自己回答时会重复几个词，但连着的词对不上。
 */
export function isCrosstalk(text, others, { minUni = 0.6, minBi = 0.4 } = {}) {
  const list = (others ?? []).filter(Boolean)
  if (!list.length) return false
  const r = overlap(text, list)
  if (!r.words) return false
  if (r.words <= 2) return r.uni === 1
  return r.uni >= minUni && r.bi >= minBi
}

/**
 * 对方刚说完的问题 seg，连同前面紧挨着的铺垫句拼成一次提问。
 * ordered：按 startedAt 排好的段落 [{ id, who, text, final, startedAt }]。
 * 往前找对方的定稿段：中间我说了话、停顿超过 gapMs、或者那段是另一个问过的问题（已经答完，或者问过超过 reaskMs），就停。
 * 寒暄和会上的事务（能听到吗、共享一下屏幕）不当铺垫，问题这段开头的也去掉，免得回答先去回应它们。
 * 返回的段落 text 是去掉这些以后的。
 */
export function questionRun(ordered, seg, { gapMs = 4000, maxSegs = 3, maxChars = 600, askedAt = new Map(), answered = () => false, reaskMs = 8000, now = Date.now(), endedAt = (x) => x.endedAt } = {}) {
  const head = dropSmallTalk(seg.text)
  const run = [head ? { ...seg, text: head } : seg]
  let chars = run[0].text.length
  let next = seg
  const i = ordered.findIndex((x) => x.id === seg.id)
  for (let j = i - 1; j >= 0 && run.length < maxSegs; j--) {
    const x = ordered[j]
    if (!x.text || !x.final) continue
    if (x.who !== 'other') break
    const end = endedAt(x)
    if (end != null && next.startedAt - end > gapMs) break
    // 刚问过、还在答的：新问题会停掉它，合并重问；已经答完的是另一个问题，带上就会答成上一题
    const asked = askedAt.get(x.id)
    if (asked != null && (answered(x) || now - asked > reaskMs)) break
    const text = dropSmallTalk(x.text)
    if (!text) continue
    if (chars + text.length > maxChars) break
    run.unshift({ ...x, text })
    chars += text.length
    next = x
  }
  return run
}
