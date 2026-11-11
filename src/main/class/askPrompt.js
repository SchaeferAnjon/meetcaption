import { clock, noDashes } from '../prompts.js'
import { t } from '../i18n.js'
import { promptLang } from '../languages.js'
import { tokenize } from '../speaker.js'

// 课上问 AI：组 prompt 和解析回答（不引 electron，单测直接用）。
// 取材：这节课的字幕（整节课，太长时只留和问题最相关的几段加最近一段和引用那句的前后）、实时笔记、课件里最相关的几页、课上截图（最多附两张）。
// 回答按行写：覆盖、要点、几条、依据（引用资料里的编号）、接着问。解析边流边出，没写完的行先不露出来。

export const ASK_LIMITS = {
  transcriptTokens: 3200, // 字幕最多占的 token（估算）
  recentShare: 0.35, // 其中最近的字幕占的份额
  notesChars: 3600,
  pageTokens: 1800,
  pages: 3,
  pageChars: 1200,
  images: 2,
  history: 4, // 带上之前几问
  historyChars: 900,
  lineChars: 360,
}

/** token 估算：汉字、假名、韩文按一个算，其余按 3.6 个字符一个。 */
export function estTokens(s) {
  const text = String(s ?? '')
  const cjk = (text.match(/[぀-ヿ一-鿿가-힯]/g) ?? []).length
  return Math.ceil(cjk * 1.1 + (text.length - cjk) / 3.6)
}

const STOP = new Set('the a an and or but is are was were be been to of in on at for with that this it you we they i not do does did have has what how why can will just so if then than there here from by as about into your our their its also very really like which when where who whom would could should may might one two'.split(' '))

/** 一段文字里用来对照的词：拉丁字母的词（去掉虚词）和汉字相邻两个字。 */
export function searchTokens(text) {
  const out = new Set()
  const han = []
  const flush = () => {
    if (han.length === 1) out.add(han[0])
    for (let i = 0; i + 1 < han.length; i++) out.add(han[i] + han[i + 1])
    han.length = 0
  }
  for (const w of tokenize(text)) {
    if (/\p{Script=Han}/u.test(w)) han.push(w)
    else {
      flush()
      if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w)
    }
  }
  flush()
  return out
}

// 问题里的中文术语换成课上的英文词（反过来也一样），不然中文问题对不上英文字幕
function termTokens(question, terms) {
  const q = String(question).toLowerCase()
  const out = new Set()
  for (const t of terms) {
    const en = String(t.term ?? '').toLowerCase()
    const zh = String(t.zh ?? '').toLowerCase()
    if ((zh && q.includes(zh)) || (en && q.includes(en))) for (const k of [...searchTokens(en), ...searchTokens(zh)]) out.add(k)
  }
  return out
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * 课上的字幕 → 编了号的几行文字。segments：[{ id, startedAt, text, speaker?, sentences? }]，按时间排好。
 * base：课的开始时间；clockTime(ms)：一行前面写的时间（实时是钟点，课后是课里第几分钟）。
 * 整节课放得下就全放；放不下：最近的一段 + 引用那句的前后 + 和问题最相关的几段（带前后各一句），中间省略的地方写「……」。
 * → { text, refs: Map<编号, 字幕 id>, ats: Map<字幕 id, 时间>, shown, total }
 */
export function transcriptForAsk(segments, { query = '', terms = [], quoteId = null, clockTime, budget = ASK_LIMITS.transcriptTokens } = {}) {
  const rows = segments
    .filter((s) => s?.text?.trim())
    .map((s) => {
      const line = oneLine(s.text)
      return { id: s.id, who: s.speaker || (s.who === 'me' ? '我' : '老师'), at: s.startedAt, line: line.length > ASK_LIMITS.lineChars ? `${line.slice(0, ASK_LIMITS.lineChars)}…` : line, tr: (s.sentences ?? []).map((x) => x.tr).filter(Boolean).join(' ') }
    })
  const cost = rows.map((r) => estTokens(r.line) + 8)
  const total = cost.reduce((a, b) => a + b, 0)
  const chosen = new Set()
  let used = 0
  const add = (i) => {
    if (i < 0 || i >= rows.length || chosen.has(i)) return true
    if (used + cost[i] > budget) return false
    chosen.add(i)
    used += cost[i]
    return true
  }
  if (total <= budget) rows.forEach((_, i) => add(i))
  else {
    // 引用的那句和前后：回答一定要看得到它
    const qi = quoteId == null ? -1 : rows.findIndex((r) => r.id === quoteId)
    if (qi >= 0) for (const d of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) add(qi + d)
    // 最近的一段
    const recent = budget * ASK_LIMITS.recentShare
    let tail = 0
    for (let i = rows.length - 1; i >= 0 && tail + cost[i] <= recent; i--) {
      tail += cost[i]
      add(i)
    }
    // 和问题最相关的
    const want = new Set([...searchTokens(query), ...termTokens(query, terms)])
    if (want.size) {
      const docs = rows.map((r) => searchTokens(`${r.line} ${r.tr}`))
      const df = new Map()
      for (const d of docs) for (const k of d) df.set(k, (df.get(k) ?? 0) + 1)
      const scored = docs
        .map((d, i) => {
          let sc = 0
          for (const k of want) if (d.has(k)) sc += Math.log(1 + rows.length / (df.get(k) ?? 1))
          return { i, sc }
        })
        .filter((x) => x.sc > 0)
        .sort((a, b) => b.sc - a.sc)
      for (const { i } of scored) {
        if (used >= budget * 0.95) break
        if (chosen.has(i)) continue
        add(i - 1)
        add(i)
        add(i + 1)
      }
    }
  }
  const order = [...chosen].sort((a, b) => a - b)
  const refs = new Map()
  const ats = new Map()
  const out = []
  let prev = -1
  order.forEach((i, k) => {
    if (prev >= 0 && i - prev > 1) out.push(`……（中间省略 ${i - prev - 1} 句）`)
    const no = k + 1
    refs.set(no, rows[i].id)
    ats.set(rows[i].id, rows[i].at)
    out.push(`#${no} [${clockTime(rows[i].at)}] ${rows[i].who}：${rows[i].line}`)
    prev = i
  })
  if (order.length && order.at(-1) < rows.length - 1) out.push(`……（后面还有 ${rows.length - 1 - order.at(-1)} 句，没放进来）`)
  return { text: out.join('\n'), refs, ats, shown: order.length, total: rows.length }
}

/** 实时笔记 → 编了号的文字（笔记 N）。放不下时先少给每节的要点，再只给标题。 */
export function notesForAsk(notes, max = ASK_LIMITS.notesChars) {
  if (!notes || typeof notes !== 'object') return ''
  const sections = notes.sections ?? []
  const build = (perSection) => {
    const lines = sections.map((s, i) => {
      const pts = (s.points ?? []).slice(0, perSection).map(oneLine)
      const fm = (s.formulas ?? []).slice(0, perSection > 0 ? 3 : 0).map((f) => `$${oneLine(f)}$`)
      const body = [...pts, ...fm].join('；')
      return `笔记${i + 1}${s.start ? `（${s.start}）` : ''} ${oneLine(s.title)}${body ? `：${body}` : ''}`
    })
    for (const e of notes.emphasis ?? []) if (e?.text) lines.push(`老师强调：${oneLine(e.text)}`)
    for (const h of notes.homework ?? []) if (h?.text) lines.push(`作业：${oneLine(h.text)}`)
    return lines.join('\n')
  }
  for (const n of [30, 5, 3, 0]) {
    const out = build(n)
    if (out.length <= max) return out
  }
  return build(0).slice(0, max) + '…'
}

/**
 * 课件里和问题最相关的几页。pages：[{ mat（第几份课件，从 1 数）, matName, n（页码）, text }]；只有一份课件时标成「课件pN」，几份时「课件1pN」。
 * → { text, picked: [{ tag, mat, n }] }
 */
export function pagesForAsk(pages, { query = '', terms = [], multi = false, limit = ASK_LIMITS.pages } = {}) {
  const want = new Set([...searchTokens(query), ...termTokens(query, terms)])
  if (!want.size || !pages.length) return { text: '', picked: [] }
  const docs = pages.map((p) => searchTokens(p.text))
  const df = new Map()
  for (const d of docs) for (const k of d) df.set(k, (df.get(k) ?? 0) + 1)
  const ranked = docs
    .map((d, i) => {
      let sc = 0
      for (const k of want) if (d.has(k)) sc += Math.log(1 + pages.length / (df.get(k) ?? 1))
      return { i, sc }
    })
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
  let left = ASK_LIMITS.pageTokens
  const picked = []
  const out = []
  for (const { i } of ranked) {
    const p = pages[i]
    const body = oneLine(p.text).slice(0, ASK_LIMITS.pageChars)
    const c = estTokens(body)
    if (c > left && picked.length) break
    left -= c
    const tag = multi ? `课件${p.mat}p${p.n}` : `课件p${p.n}`
    picked.push({ tag, mat: p.mat, n: p.n, matId: p.matId, name: p.matName })
    out.push(`${tag}（《${p.matName}》第 ${p.n} 页）：${body}`)
  }
  return { text: out.join('\n'), picked }
}

/** 课上截图：挑最多 N 张附图，有引用的那句就挑时间最近的，没有就挑最近截的。→ { list: 编了号的清单文字, attach: [slide] } */
export function slidesForAsk(slides, { quoteAt = null, clockTime, limit = ASK_LIMITS.images } = {}) {
  const all = (slides ?? []).filter((x) => x?.file).sort((a, b) => a.at - b.at)
  const listed = all.slice(-12)
  const index = (x) => all.indexOf(x) + 1
  let attach
  if (quoteAt != null) attach = [...listed].sort((a, b) => Math.abs(a.at - quoteAt) - Math.abs(b.at - quoteAt)).slice(0, limit)
  else attach = listed.slice(-limit)
  attach = attach.sort((a, b) => a.at - b.at)
  const list = listed.map((x) => `截图${index(x)}（${clockTime(x.at)}）${attach.includes(x) ? ' 附图' : ''}`).join('；')
  return { list, attach: attach.map((x) => ({ ...x, no: index(x) })) }
}

const TAIL = [
  '回答按下面的行写，一行一件事，不用 Markdown 标题、粗体和表格：',
  '第 1 行：「覆盖：」后面写 讲过、提了一句、没讲到 三选一。讲过：这节课（字幕、笔记或课件）讲到了问题问的内容；提了一句：老师只在举别的例子时顺带说了一个词或一句话、完全没有解释，这时在后面加上提到它的那句的编号，写成「覆盖：提了一句 #12」；没讲到：资料里完全没有。老师用几句话解释过的就是「讲过」，拿不准时写「讲过」。',
  '第 2 行：「要点：」后面一句话直接回答问题，不超过 30 个字。',
  '第 3 行起：2 到 4 行，每行以「- 」开头，只讲一件事；公式用 $…$ 写在句子里，重要的公式单独占一行、用 $$…$$ 包住（每个公式只占一行，不换行）。',
  '倒数第 2 行：「依据：」后面列出你用到的资料，用资料里的编号，空格隔开，例如「依据：#12 #15 笔记2 截图1 课件p14」；只列真正用到的，字幕编号最多 4 个（挑最能说明问题的），没有就写「依据：无」。',
  '最后一行：「接着问：」后面给我一到两个顺着这个回答最可能想接着问的问题，每个不超过 20 个字，用「｜」隔开，只写普通文字：不要公式、$ 符号、下标和花括号，变量直接写字母。',
]

export function askSystem({ lang = 'zh', live = true } = {}) {
  const L = promptLang(lang)
  return [
    `你是我的随身助教。我正在${live ? '上课' : '复习一节已经下课的课'}，老师讲的内容在下面「这节课的资料」里。我没听懂的地方会来问你，每次问一个问题。`,
    '回答的原则：',
    `- 先看资料里老师是怎么讲的，术语、符号和老师的说法保持一致。回答用${L}写；老师用的英文术语（或其他语言的术语）第一次出现时放在译名后面的括号里，比如「耦合（coupling）」。`,
    '- 短，一眼能扫完：一句要点，再 2 到 4 条，每条只讲一件事、不超过 50 个字（英文 30 个词），公式不算字数；一件事说不完就拆成两条或砍掉次要的。全部加起来不超过 200 个字。不复述问题，不客套，不写「根据资料」「这节课提到」这类铺垫，不附逐句翻译。',
    `- 没听懂常常是缺一步：把老师没说出口的那一步补上（符号代表什么、式子从哪来、为什么这样做），用${L}说人话。`,
    '- 资料里没有的内容按通用知识补充，不要装作老师讲过；也不要编资料里没有的数字、名字和公式。老师只提了一句或没讲到时，照实填「覆盖」，回答里不用重复解释这件事（界面会写）。',
    '- 问题和引用的字幕是语音识别出来的，可能有错字，按最可能的意思理解；和「术语」里的词发音相近的，就是那个术语。',
    '- 回答里不要写编号（#12 这类）和时间，也不要提「资料」；编号只写在「依据」那一行。',
    '- 不用破折号。',
    '',
    ...TAIL,
  ].join('\n')
}

/**
 * 组一次提问的请求。
 * session：{ startedAt, endedAt, title, mode }；live：课还在上；now：现在的时间；
 * transcript / notes / pages / slides：取好的材料（见上面几个函数）；question：这次的问题；quote：{ segId, text, sel }；
 * history：之前几问 [{ q, quote, gist, points }]；keywords：术语（项目里设的和笔记里的）；context：课程背景。
 * → { system, messages, refs }：refs 是回答里的编号对应的东西。
 */
export function askMessages({ session, live, now = Date.now(), lang = 'zh', context = '', keywords = [], transcript, notes = '', pages = { text: '', picked: [] }, slides = { list: '', attach: [] }, question, quote = null, quoteLine = null, history = [] }) {
  const parts = []
  const mins = Math.max(0, Math.round(((live ? now : (session.endedAt ?? now)) - session.startedAt) / 60000))
  parts.push(live ? `这节课已经开讲 ${mins} 分钟，还在继续。` : `这节课已经下课，全长 ${mins} 分钟。`)
  if (context?.trim()) parts.push(`课程背景：${context.trim().slice(0, 600)}`)
  if (keywords.length) parts.push(`术语：${keywords.slice(0, 60).join('、')}`)
  const mat = []
  if (notes) mat.push(`课堂笔记（AI 边听边整理的，覆盖整节课，编号「笔记N」）：\n${notes}`)
  if (pages.text) mat.push(`老师的课件里和这个问题最相关的几页（编号「课件pN」）：\n${pages.text}`)
  if (slides.list) mat.push(`课上截的屏幕画面：${slides.list}${slides.attach.length ? '。标着「附图」的附在这条消息后面，按截图编号从小到大' : ''}`)
  mat.push(`课上的字幕（编号 #N，[时间] 说话人：原话；「……」是省略的部分）：\n${transcript.text || '（还没有识别出字幕）'}`)
  parts.push(`这节课的资料：\n\n${mat.join('\n\n')}`)
  if (quote) {
    const no = quoteLine?.no
    const sel = quote.sel && quote.sel !== quote.text ? `；我选中的是「${oneLine(quote.sel)}」` : ''
    parts.push(`我引用了这一句字幕${no ? `（#${no}）` : ''}：「${oneLine(quote.text)}」${sel}。`)
  }
  parts.push(`我的问题：${oneLine(question)}`)
  parts.push(`记得${promptLang(lang)}回答，按「覆盖、要点、- 几条、依据、接着问」的行写。`)
  const content = parts.join('\n\n')
  const messages = []
  for (const h of history.slice(-ASK_LIMITS.history)) {
    const q = h.quote?.text ? `（引用字幕：${oneLine(h.quote.text).slice(0, 200)}）` : ''
    messages.push({ role: 'user', content: `${q}${oneLine(h.q)}`.trim() })
    messages.push({ role: 'assistant', content: historyText(h) })
  }
  messages.push({ role: 'user', content })
  const refs = {
    seg: transcript.refs,
    ats: transcript.ats,
    notes: (notes.match(/^笔记\d+/gm) ?? []).length,
    slides: new Map(slides.attach.map((x) => [x.no, x])),
    pages: pages.picked,
  }
  return { system: askSystem({ lang, live }), messages, refs }
}

function historyText(h) {
  const body = [h.gist ? `要点：${h.gist}` : '', ...(h.points ?? []).map((p) => `- ${p.tex ? `$$${p.tex}$$` : p.text}`)].filter(Boolean).join('\n')
  return body.length > ASK_LIMITS.historyChars ? `${body.slice(0, ASK_LIMITS.historyChars)}…` : body || '（没答完）'
}

/* ---------------- 解析回答 ---------------- */

// 接着问的按钮里不画公式：去掉 $ 和 LaTeX 的下标、花括号、反斜杠
const plain = (v) => v.replace(/\$/g, '').replace(/_\{([^}]*)\}/g, '_$1').replace(/\\([a-zA-Z]+)/g, '$1').replace(/[{}]/g, '')

const COVER = { 讲过: 'full', 没讲到: 'none', 提了一句: 'partial' }

function stripMd(s) {
  return s.replace(/\*\*|__/g, '').replace(/^\s*#{1,6}\s+/, '')
}

/**
 * 模型写的回答（流式写到一半也行）→ { cover, gist, points, src, next }。
 * cover：{ kind: 'full' | 'partial' | 'none', segNo? }；points：[{ text } | { tex }]；src：[{ type, ... }]（只在写完时才解析，编号对不上的丢掉）。
 * refs：askMessages 给的 refs。final 为真时没按格式写的回答也尽量拆出要点和几条。
 */
export function parseAsk(raw, refs = null, { final = false } = {}) {
  const text = noDashes(String(raw ?? '')).replace(/\r/g, '')
  const lines = text.split('\n')
  const out = { cover: null, gist: '', points: [], src: [], next: [], formatted: false }
  let srcLine = ''
  let nextLine = ''
  let open = null // 还没写完的 $$ 公式
  const lastIndex = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    const complete = i < lastIndex || final
    const line = stripMd(lines[i]).trim()
    if (!line) continue
    if (open) {
      open.text += ` ${line}`
      if (/\$\$\s*$/.test(line)) {
        if (complete) out.points.push({ tex: open.text.replace(/^\s*\$\$|\$\$\s*$/g, '').trim() })
        open = null
      }
      continue
    }
    let m
    if ((m = line.match(/^覆盖\s*[:：]\s*(讲过|没讲到|提了一句)\s*(?:#(\d+))?/))) {
      out.formatted = true
      out.cover = { kind: COVER[m[1]], ...(m[2] ? { segNo: Number(m[2]) } : {}) }
      if (out.cover.kind === 'partial' && !m[2]) {
        const n = line.match(/#(\d+)/)
        if (n) out.cover.segNo = Number(n[1])
      }
    } else if ((m = line.match(/^要点\s*[:：]\s*(.*)$/))) {
      out.formatted = true
      out.gist = m[1].trim()
    } else if ((m = line.match(/^依据\s*[:：]\s*(.*)$/))) {
      srcLine = m[1]
    } else if ((m = line.match(/^接着问\s*[:：]\s*(.*)$/))) {
      nextLine = m[1]
    } else if (/^\$\$/.test(line)) {
      if (/^\$\$[\s\S]+\$\$$/.test(line) && line.length > 4) out.points.push({ tex: line.replace(/^\$\$|\$\$$/g, '').trim() })
      else open = { text: line }
    } else if ((m = line.match(/^(?:[-*•·]|\d+[.、)])\s+(.*)$/))) {
      // 一条要点只有一个公式时当独占一行的公式画，和别的公式一样
      const only = m[1].trim().match(/^\$([^$]+)\$[。.，,;；]?$/)
      if (only) out.points.push({ tex: only[1].trim() })
      else if (m[1].trim()) out.points.push({ text: m[1].trim() })
    } else if (out.formatted && out.points.length) {
      // 上一条写到下一行去了
      const last = out.points.at(-1)
      if (last.text != null) last.text += ` ${line}`
    } else if (!out.formatted && final) {
      // 没按格式写：第一行当要点，其余各算一条
      if (!out.gist) out.gist = line
      else out.points.push({ text: line })
    }
  }
  out.points = out.points.filter((p) => (p.tex ?? p.text)?.length).slice(0, 6)
  out.next = nextLine
    .split(/[｜|]/)
    .map((s) => plain(s).trim().replace(/^["「“]|["」”]$/g, ''))
    .filter((s) => s && s !== '无')
    .slice(0, 2)
  if (final) out.src = resolveSources(srcLine, refs)
  return out
}

/** 回答里的 cover.segNo（字幕编号）换成字幕 id。 */
export function coverOf(cover, refs) {
  if (!cover) return undefined
  if (cover.kind !== 'partial') return { kind: cover.kind }
  const id = cover.segNo != null ? refs?.seg?.get(cover.segNo) : null
  return id != null ? { kind: 'partial', segId: id, ...(refs.ats?.has(id) ? { at: refs.ats.get(id) } : {}) } : { kind: 'partial' }
}

/** 「依据」那一行里的编号 → [{ type: 'seg', id } | { type: 'note', n } | { type: 'slide', file, at } | { type: 'page', mat, n }]，同一个只出一次，认不出的丢掉。 */
export function resolveSources(line, refs) {
  const src = []
  const seen = new Set()
  let segs = 0
  const push = (key, item) => {
    if (seen.has(key)) return
    // 字幕时间点最多 4 个：多了一排时间看不过来，也点不出哪个才是关键
    if (item.type === 'seg' && segs >= 4) return
    if (item.type === 'seg') segs++
    seen.add(key)
    src.push(item)
  }
  if (!refs) return src
  for (const m of String(line ?? '').matchAll(/#(\d+)|笔记\s*(\d+)|截图\s*(\d+)|课件\s*(\d*)\s*p\.?\s*(\d+)/gi)) {
    if (m[1]) {
      const id = refs.seg?.get(Number(m[1]))
      if (id != null) push(`s${id}`, { type: 'seg', id, ...(refs.ats?.has(id) ? { at: refs.ats.get(id) } : {}) })
    } else if (m[2]) {
      const n = Number(m[2])
      if (n >= 1 && n <= (refs.notes ?? 0)) push(`n${n}`, { type: 'note', n: n - 1 })
    } else if (m[3]) {
      const x = refs.slides?.get(Number(m[3]))
      if (x) push(`i${x.file}`, { type: 'slide', file: x.file, at: x.at })
    } else if (m[5]) {
      const mat = m[4] ? Number(m[4]) : 1
      const n = Number(m[5])
      const p = (refs.pages ?? []).find((x) => x.mat === mat && x.n === n)
      if (p) push(`p${mat}-${n}`, { type: 'page', mat: p.mat, n: p.n, ...(p.matId ? { matId: p.matId, name: p.name } : {}) })
    }
  }
  return src
}

/* ---------------- 课堂笔记末尾的「课上问过的」 ---------------- */

// 一行注释标出这一段从哪里开始，重新生成笔记、再问了新的问题时整段换掉，不会越堆越多（marked 和图文笔记都不渲染原始 HTML）
export const ASKED_MARK = '<!--asked-->'

const askedAt = (r, startedAt) => (r.after ? t('下课后') : clock(r.askedAt - startedAt))

/** 一条问答在课堂笔记里的一行：时间、问题、一句要点 */
export function askedLine(r, startedAt) {
  const q = oneLine(r.q).slice(0, 120)
  const quoted = r.quote?.text ? oneLine(r.quote.sel || r.quote.text) : ''
  const gist = oneLine(r.gist || r.points?.find((p) => p.text)?.text || '').slice(0, 160)
  // 问句末尾已经有问号：后面直接接要点，不再加冒号（全角冒号紧跟问号，粗体后面会空出一截）
  return `- ${askedAt(r, startedAt)} **${q}**${quoted ? t(`（引用「{0}」）`, quoted.length > 24 ? `${quoted.slice(0, 24)}…` : quoted) : ''}${gist ? `${/[?？]$/.test(q) ? ' ' : '：'}${gist}` : ''}`
}

/** 课堂笔记的 Markdown 末尾接上「课上问过的」（已经有的先去掉）；一条都没有就不接。asks 里没答出内容的不算。 */
export function withAsked(markdown, asks, startedAt) {
  const md = String(markdown ?? '')
  const i = md.indexOf(ASKED_MARK)
  const base = i >= 0 ? md.slice(0, i).replace(/\s+$/, '\n') : md
  const list = (asks ?? []).filter((r) => r.gist || r.points?.length).sort((a, b) => a.askedAt - b.askedAt)
  if (!md.trim() || !list.length) return base
  return `${base.replace(/\s+$/, '')}\n\n${ASKED_MARK}\n## ${t('课上问过的')}\n\n${list.map((r) => askedLine(r, startedAt)).join('\n')}\n\n${t('完整的回答在「问 AI」里看，点时间回到那句字幕。')}\n`
}

