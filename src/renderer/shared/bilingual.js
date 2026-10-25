/*
 * 双语意群对照：一句英文和它的中文，按意群分色（chunks），难词在中英两边都加虚线（terms），
 * AI 纠正过的词加很淡的点线（orig 是识别原文），悬停看识别原文。
 * 普通脚本，挂在 window.bilingual（Node 里 import 后在 globalThis.bilingual）。字幕窗、主窗口实时记录、
 * 会议详情的字幕记录都用它。只用 textContent 拼节点，不解析 HTML。样式在 bilingual.css。
 *
 * sentence = { text, orig?, tr, chunks: [{ en, zh }], terms: [{ term, zh, explain }] }
 * 旧数据只有 { text, tr, terms: [{ term, explain }] } 也照样显示（单色，只标英文术语）。
 */
;(function (root) {
  'use strict'

  const COLORS = 4
  // 拉丁字母、数字相连才算同一个词；中文不看词边界
  const WORD = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{N}_]/u
  const isWord = (ch) => Boolean(ch) && WORD.test(ch)
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

  function onBoundary(text, s, e) {
    if (isWord(text[s]) && isWord(text[s - 1])) return false
    if (isWord(text[e - 1]) && isWord(text[e])) return false
    return true
  }

  const overlaps = (taken, s, e) => taken.some((r) => s < r.e && e > r.s)

  function scan(text, needle, taken, from, word) {
    const tries = [[text, needle]]
    const lower = text.toLowerCase()
    const low = needle.toLowerCase()
    if (lower.length === text.length && low.length === needle.length && (lower !== text || low !== needle)) tries.push([lower, low])
    for (const [hay, n] of tries) {
      let before = -1
      for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1)) {
        const e = i + n.length
        if (overlaps(taken, i, e)) continue
        if (word && !onBoundary(text, i, e)) continue
        if (i >= from) return i
        if (before < 0) before = i
      }
      if (before >= 0) return before
    }
    return -1
  }

  /** 找 needle 在 text 里的位置：先原样再忽略大小写，不和已占的范围重叠，from 之后的优先，先要求词边界再放宽。 */
  function locate(text, needle, taken = [], from = 0) {
    if (!needle || !text) return -1
    const i = scan(text, needle, taken, from, true)
    return i >= 0 ? i : scan(text, needle, taken, from, false)
  }

  /** 把 text 按意群、术语、纠正的范围切成连续的小段：[{ text, c: 颜色号, t: 术语号, f: 纠正号（没有都是 -1） }]，拼起来就是原文。 */
  function runs(text, chunks, terms, fixes = []) {
    const cuts = new Set([0, text.length])
    for (const r of [...chunks, ...terms, ...fixes]) (cuts.add(r.s), cuts.add(r.e))
    const pts = [...cuts].sort((a, b) => a - b)
    const out = []
    for (let i = 0; i < pts.length - 1; i++) {
      const s = pts[i]
      const e = pts[i + 1]
      if (e <= s) continue
      const c = chunks.find((r) => r.s <= s && e <= r.e)?.c ?? -1
      const t = terms.find((r) => r.s <= s && e <= r.e)?.t ?? -1
      const f = fixes.find((r) => r.s <= s && e <= r.e)?.f ?? -1
      const last = out[out.length - 1]
      if (last && last.c === c && last.t === t && last.f === f) last.text += text.slice(s, e)
      else out.push({ text: text.slice(s, e), c, t, f })
    }
    return out
  }

  /* ---------------- AI 纠正过的词 ---------------- */

  // 词：字母数字连在一起算一个（中间可以有撇号、连字符、点），汉字一个字算一个；和主进程判断纠正可不可信时的切法一样
  const TOKEN = /\p{Script=Han}|[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu
  const tokens = (s) => Array.from(s.matchAll(TOKEN), (m) => ({ w: m[0], s: m.index, e: m.index + m[0].length }))

  /**
   * 纠正后的句子 text 和识别原文 orig 按词对齐（最长公共子序列，区分大小写，不看标点），
   * 对不上的连续几个词是一处纠正：→ [{ s, e, orig }]（text 里的范围和它对应的识别原文）。
   * 原文多出来的词（纠正时删掉的）算到前一个词上，前面没有就算到后一个词上。
   */
  function diffFixes(text, orig) {
    const a = tokens(orig)
    const b = tokens(text)
    if (!a.length || !b.length) return []
    const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i].w === b[j].w ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    const pairs = []
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (a[i].w === b[j].w) (pairs.push([i, j]), i++, j++)
      else if (L[i + 1][j] >= L[i][j + 1]) i++
      else j++
    }
    pairs.push([a.length, b.length])
    // { s, e }：text 里的范围；{ os, oe }：对应的识别原文范围（纠正时加进来的词没有）
    const out = []
    let pi = -1
    let pj = -1
    for (const [i, j] of pairs) {
      const oa = pi + 1
      const tb = pj + 1
      if (j > tb) out.push({ s: b[tb].s, e: b[j - 1].e, os: i > oa ? a[oa].s : null, oe: i > oa ? a[i - 1].e : null })
      else if (i > oa) {
        // 只删了词：挂到前一个对上的词（没有就后一个）上，识别原文带上这个词
        if (pj >= 0) out.push({ s: b[pj].s, e: b[pj].e, os: a[pi].s, oe: a[i - 1].e })
        else if (j < b.length) out.push({ s: b[j].s, e: b[j].e, os: a[oa].s, oe: a[i].e })
      }
      pi = i
      pj = j
    }
    // 挂到同一个词上的两处合成一处
    const merged = []
    for (const r of out.sort((x, y) => x.s - y.s)) {
      const last = merged[merged.length - 1]
      if (!last || r.s >= last.e) {
        merged.push({ ...r })
        continue
      }
      last.e = Math.max(last.e, r.e)
      if (r.os != null) {
        last.os = last.os == null ? r.os : Math.min(last.os, r.os)
        last.oe = last.oe == null ? r.oe : Math.max(last.oe, r.oe)
      }
    }
    return merged.map((r) => ({ s: r.s, e: r.e, orig: r.os == null ? '' : orig.slice(r.os, r.oe) }))
  }

  /**
   * 纯计算，不碰 DOM。opts：colors（意群分色，默认开）、terms（术语，默认开）、fixes（标出 AI 纠正过的词，默认开）。
   * → { text, tr, en: runs, zh: runs, terms: [{ term, zh, explain, orig? }], fixes: [{ text, orig }], colored: 分色的意群数 }
   * 术语里有纠正过的词时，术语多一个 orig（这几处的识别原文），悬停术语时一起显示。
   * 意群在原文或译文里找不到就丢掉；能对上的不到 2 块时不分色（整句一个颜色没有意义）。
   * 一块的 zh 可以是几段（数组）：中文语序和英文不同、对应的中文在译文里不连续时，几段用同一个颜色。
   */
  function layout(sentence, opts = {}) {
    const text = str(sentence?.text)
    const tr = str(sentence?.tr)
    const enC = []
    const zhC = []
    if (opts.colors !== false && tr && Array.isArray(sentence?.chunks)) {
      let from = 0
      for (const c of sentence.chunks) {
        const en = str(c?.en).trim()
        const pieces = (Array.isArray(c?.zh) ? c.zh : [c?.zh]).map((z) => str(z).trim()).filter(Boolean)
        if (!en || !pieces.length) continue
        const s = locate(text, en, enC, from)
        if (s < 0) continue
        const found = []
        for (const zh of pieces) {
          const z = locate(tr, zh, [...zhC, ...found])
          if (z < 0) break
          found.push({ s: z, e: z + zh.length })
        }
        if (found.length !== pieces.length) continue
        const n = enC.length % COLORS
        enC.push({ s, e: s + en.length, c: n })
        for (const f of found) zhC.push({ ...f, c: n })
        from = s + en.length
      }
      if (enC.length < 2) {
        enC.length = 0
        zhC.length = 0
      }
    }

    const terms = []
    const enT = []
    const zhT = []
    if (opts.terms !== false && Array.isArray(sentence?.terms)) {
      const list = sentence.terms.filter((t) => t && str(t.term).trim() && str(t.explain).trim())
      list.sort((a, b) => str(b.term).trim().length - str(a.term).trim().length) // 长的优先，互不重叠
      for (const t of list) {
        const term = str(t.term).trim()
        const s = locate(text, term, enT)
        if (s < 0) continue
        let zh = str(t.zh).trim()
        if (zh.toLowerCase() === term.toLowerCase()) zh = '' // 译文里原样留着英文：中文那边不再标一次
        const z = zh && tr ? locate(tr, zh, zhT) : -1
        const i = terms.length
        terms.push({ term: text.slice(s, s + term.length), zh: z >= 0 ? tr.slice(z, z + zh.length) : '', explain: str(t.explain).trim() })
        enT.push({ s, e: s + term.length, t: i })
        if (z >= 0) zhT.push({ s: z, e: z + zh.length, t: i })
      }
    }
    const fixes = []
    const enF = []
    const orig = str(sentence?.orig)
    if (opts.fixes !== false && orig && orig !== text) {
      for (const r of diffFixes(text, orig)) {
        enF.push({ s: r.s, e: r.e, f: fixes.length })
        fixes.push({ text: text.slice(r.s, r.e), orig: r.orig })
      }
      for (const r of enT) {
        const inside = enF.filter((x) => x.s < r.e && x.e > r.s).map((x) => fixes[x.f].orig || t('（没有）'))
        if (inside.length) terms[r.t].orig = inside.join(t('、'))
      }
    }
    return { text, tr, en: runs(text, enC, enT, enF), zh: tr ? runs(tr, zhC, zhT) : [], terms, fixes, colored: enC.length }
  }

  /** 内容签名：一样就不用重画（字幕窗靠它让悬停着的术语不丢）。 */
  function signature(sentence, opts = {}) {
    return JSON.stringify([str(sentence?.text), str(sentence?.orig), str(sentence?.tr), sentence?.chunks ?? null, sentence?.terms ?? null, opts.colors !== false, opts.terms !== false])
  }

  /* ---------------- DOM ---------------- */

  function span(cls, text) {
    const s = document.createElement('span')
    s.className = cls
    if (text != null) s.textContent = text
    return s
  }

  function termNode(t, i, opts) {
    const s = span('term')
    s.dataset.tid = `${opts.key ?? ''}t${i}`
    s.dataset.explain = t.explain
    s.dataset.title = t.zh ? `${t.term} · ${t.zh}` : t.term
    if (t.orig) s.dataset.orig = t.orig
    if (opts.focusable) s.tabIndex = 0
    return s
  }

  // 纠正过的词：点线，悬停看识别原文。在术语里面的（.in-term）不单独弹气泡，术语的气泡里带上识别原文
  function fixNode(fx, i, opts, inTerm) {
    const s = span(inTerm ? 'fix in-term' : 'fix')
    s.dataset.tid = `${opts.key ?? ''}f${i}`
    s.dataset.title = fx.text
    s.dataset.orig = fx.orig
    if (opts.focusable && !inTerm) s.tabIndex = 0
    return s
  }

  function build(list, terms, fixes, opts) {
    const frag = document.createDocumentFragment()
    let term = null
    let termIdx = -1
    let fix = null
    let fixIdx = -1
    for (const r of list) {
      let piece
      if (r.c >= 0) {
        piece = span('bi-c', r.text)
        piece.dataset.c = String(r.c)
      } else piece = document.createTextNode(r.text)
      if (r.t !== termIdx) {
        term = r.t >= 0 ? termNode(terms[r.t], r.t, opts) : null
        termIdx = r.t
        if (term) frag.append(term)
        fix = null
        fixIdx = -1
      }
      const host = term ?? frag
      if (r.f < 0) {
        fix = null
        fixIdx = -1
        host.append(piece)
        continue
      }
      if (!fix || fixIdx !== r.f) {
        fix = fixNode(fixes[r.f], r.f, opts, Boolean(term))
        fixIdx = r.f
        host.append(fix)
      }
      fix.append(piece)
    }
    return frag
  }

  /** 能弹气泡的节点：术语，和不在术语里的纠正词。 */
  const TIP_SELECTOR = '.term, .fix:not(.in-term)'

  /** 气泡内容 { title, text }：术语是解释（里面有纠正过的词就带上识别原文），纠正词是识别原文。 */
  function tipContent(el) {
    const d = el?.dataset ?? {}
    const orig = d.orig == null ? '' : d.orig ? t(`识别原文：{0}`, d.orig) : t('识别原文里没有这个词')
    const title = d.title || el?.textContent || ''
    if (el?.classList?.contains('fix')) return { title, text: orig }
    return { title, text: orig ? t(`{0}（{1}）`, d.explain ?? '', orig) : (d.explain ?? '') }
  }

  /**
   * 画一句：→ { en: DocumentFragment, zh: DocumentFragment | null, colored, terms }
   * opts：colors、terms（同 layout）；key：术语 data-tid 的前缀（同一页里多句时区分）；focusable：术语能 Tab 聚焦。
   * 两边同一个术语的 data-tid 一样，悬停任一边都能找到另一边。
   */
  function render(sentence, opts = {}) {
    const l = layout(sentence, opts)
    return { en: build(l.en, l.terms, l.fixes, opts), zh: l.tr ? build(l.zh, l.terms, [], opts) : null, colored: l.colored, terms: l.terms, fixes: l.fixes }
  }

  /** 悬停一边的术语时，同一句里另一边的同一个术语也高亮（加 .is-linked）。scope 是带 [data-bi] 的最近祖先，没有就是 root。 */
  function linkHover(rootEl) {
    let hot = []
    const clear = () => {
      for (const n of hot) n.classList.remove('is-linked')
      hot = []
    }
    const over = (e) => {
      const t = e.target?.closest?.('.term[data-tid]')
      if (t && hot.includes(t)) return
      clear()
      if (!t || !rootEl.contains(t)) return
      const scope = t.closest('[data-bi]') ?? rootEl
      hot = [...scope.querySelectorAll('.term[data-tid]')].filter((n) => n.dataset.tid === t.dataset.tid)
      for (const n of hot) n.classList.add('is-linked')
    }
    rootEl.addEventListener('mouseover', over)
    rootEl.addEventListener('mouseleave', clear)
    return () => {
      rootEl.removeEventListener('mouseover', over)
      rootEl.removeEventListener('mouseleave', clear)
      clear()
    }
  }

  /** 设置里的开关和样式：display.chunkColors（默认开）、display.chunkStyle（'text' 文字着色 | 'bar' 底部细色条）。 */
  const STYLES = ['text', 'bar']
  const DEFAULT_STYLE = 'text'
  function prefs(settings) {
    const d = settings?.display ?? {}
    const colors = (d.chunkColors ?? settings?.chunkColors) !== false
    const style = STYLES.includes(d.chunkStyle ?? settings?.chunkStyle) ? (d.chunkStyle ?? settings?.chunkStyle) : DEFAULT_STYLE
    return { colors, style, className: colors ? `bi-${style}` : 'bi-mono' }
  }

  root.bilingual = { COLORS, STYLES, DEFAULT_STYLE, TIP_SELECTOR, locate, diffFixes, layout, signature, render, tipContent, linkHover, prefs }
})(globalThis)
