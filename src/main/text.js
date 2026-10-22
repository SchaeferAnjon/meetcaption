const segmenters = new Map()

/**
 * 分句。识别稿常有一大段不带句号的话（一口气说一两分钟，或者识别没出标点）：超长的句子再按逗号切成几块，
 * 还太长就按词数（中文按字数）硬切，每块单独翻译，说着话前面的块就能先出译文。
 */
export function splitSentences(text, lang = 'en') {
  const loc = lang === 'auto' ? 'en' : lang
  if (!segmenters.has(loc)) segmenters.set(loc, new Intl.Segmenter(loc, { granularity: 'sentence' }))
  return Array.from(segmenters.get(loc).segment(text), (x) => x.segment.trim())
    .filter(Boolean)
    .flatMap((x) => splitLong(x))
}

export const LONG_WORDS = 30
export const LONG_CHARS = 60

// 从头往后装：逗号切开的小句一句句装进当前块，装不下就开新块；一个小句本身太长就按词硬切。
// 只往后加字时，前面已经装满的块不会再变（译文请求按块的文字认，前面的块不会重复翻）
export function splitLong(text, { words = LONG_WORDS, chars = LONG_CHARS } = {}) {
  const cjk = isMostlyChinese(text)
  const limit = cjk ? chars : words
  const units = (t) => (cjk ? Array.from(t.replace(/\s/g, '')) : t.split(/\s+/).filter(Boolean)).length
  if (units(text) <= limit) return [text]
  const clauses = text.match(/[^,;:，；：、]+(?:[,;:，；：、]+|$)\s*/g) ?? [text]
  const pieces = []
  let cur = ''
  const flush = () => {
    if (cur.trim()) pieces.push(cur.trim())
    cur = ''
  }
  for (const c of clauses) {
    if (units(c) > limit) {
      flush()
      pieces.push(...hardSplit(c, limit, cjk))
      continue
    }
    if (cur && units(cur + c) > limit) flush()
    cur += c
  }
  flush()
  return pieces
}

// 连词前面是天然的断点：硬切时在一块的后 40% 里找最后一个连词，从它前面断
const CONNECT = /^(?:and|but|or|so|because|which|that|then|when|if|while|although|um|uh|und|aber|oder|weil|dass|wenn|denn|et|mais|ou|parce|donc|y|pero|porque|然后|所以|但是|因为|还有|以及|而且|不过|接着|最后|另外|如果|就是)$/i
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })

// 按词硬切（中文用分词，不把一个词劈开），每块最多 limit 个词（中文 limit 个字）
function hardSplit(text, limit, cjk) {
  const toks = cjk
    ? Array.from(wordSegmenter.segment(text), (x) => ({ s: x.segment, n: x.isWordLike ? Array.from(x.segment.replace(/\s/g, '')).length : 0 }))
    : text.split(/(\s+)/).filter(Boolean).map((t) => ({ s: t, n: /\S/.test(t) ? 1 : 0 }))
  const out = []
  let i = 0
  while (i < toks.length) {
    let n = 0
    let j = i
    while (j < toks.length && n + toks[j].n <= limit) n += toks[j++].n
    if (j === i) j++ // 一个词就超过上限（不会发生在正常文本里）
    if (j < toks.length) {
      let acc = 0
      let cut = -1
      for (let k = i; k < j; k++) {
        if (k > i && acc >= limit * 0.6 && CONNECT.test(toks[k].s.trim())) cut = k
        acc += toks[k].n
      }
      // and then、so because 这种连着的连词从第一个前面断
      for (let k = cut - 1; cut > i && k > i; k--) {
        if (!toks[k].n) continue
        if (!CONNECT.test(toks[k].s.trim())) break
        cut = k
      }
      if (cut > i) j = cut
    }
    out.push(toks.slice(i, j).map((t) => t.s).join('').trim())
    i = j
  }
  return out.filter(Boolean)
}

export function isMostlyChinese(text) {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length
  return cjk / Math.max(text.replace(/\s/g, '').length, 1) > 0.3
}

/**
 * AI 纠错后的段落文本：段落按识别原文分句，纠正过的句子（{ text: 纠正后, orig: 识别原文 }）在原文里按顺序找到自己，
 * 原地换掉，句子之间的空白和标点原样留着。找不到的句子（不该发生）跳过，不影响别的句子。
 */
export function joinFixed(raw, sentences) {
  const text = String(raw ?? '')
  let out = ''
  let at = 0
  for (const sen of sentences ?? []) {
    const src = sen?.orig ?? sen?.text
    if (!src) continue
    const i = text.indexOf(src, at)
    if (i < 0) continue
    out += text.slice(at, i) + (sen.orig ? sen.text : src)
    at = i + src.length
  }
  return out + text.slice(at)
}
