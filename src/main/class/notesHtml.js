import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import katex from 'katex'
import { Marked } from 'marked'
import { clock, ymd } from '../prompts.js'
import { parseAt } from '../todos.js'
import { jpegSize, pageRef } from './materials.js'
import { t } from '../i18n.js'
import { ANSWER_WORDS, classHeadRe } from '../templateWords.js'

// 图文版课堂笔记（课堂笔记.html）：照 Dispatch 交付页的样子（左边目录、看图器：点一条放大到图上那个框、自动 / 浅色 / 深色），
// 一个文件，图片和公式字体都内嵌，拷给别人、放进笔记库都能直接打开。
// 内容是课堂笔记的 Markdown；Markdown 里插的课件页、和 slideMap 里老师讲到的课件页画成看图器：
// 页上框出老师对着讲的那几行，旁边按顺序写老师讲了什么（时间和原话）。没插进 Markdown 的页放到它所属小节的末尾。

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, 'notes-page.html')
const KATEX_CSS = path.join(path.dirname(fileURLToPath(import.meta.resolve('katex'))), 'katex.min.css')

const md = new Marked({
  gfm: true,
  renderer: {
    html: () => '', // 模型写的原始 HTML 一律不要
    image: ({ text }) => esc(text), // 课件页和截图前面已经换成看图器，剩下的图（外链）只留说明文字
    link({ href, tokens }) {
      const inner = this.parser.parseInline(tokens)
      return /^https?:\/\//.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noreferrer">${inner}</a>` : inner
    },
  },
})

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/* ---------- 公式：和主窗口一样先换占位符，marked 渲染完再用 KaTeX 画回去 ---------- */

const MATH_OPEN = ''
const MATH_CLOSE = ''
const TEX_PATTERNS = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g, display: false },
]

function extractMath(text, math) {
  return String(text)
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) => {
      if (i % 2 === 1) return part
      let t = part
      for (const { re, display } of TEX_PATTERNS) {
        t = t.replace(re, (all, tex) => {
          if (!tex.trim()) return all
          math.push({ tex: tex.trim(), display })
          const ph = `${MATH_OPEN}${math.length - 1}${MATH_CLOSE}`
          return display ? `\n\n${ph}\n\n` : ph
        })
      }
      return t
    })
    .join('')
}

function tex({ tex, display }) {
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'html' })
}

function fillMath(html, math) {
  return html
    .replace(/<p>(\d+)<\/p>/g, (all, i) => (math[i].display ? `<div class="math-display">${tex(math[i])}</div>` : all))
    .replace(/(\d+)/g, (_, i) => tex(math[i]))
}

/** Markdown → HTML（带公式）。inline：只有一行字（标题、看图器旁边的一条）。 */
function render(text, { inline = false } = {}) {
  const math = []
  const t = extractMath(text, math)
  return fillMath(inline ? md.parseInline(t) : md.parse(t), math)
}

/* ---------- 看图器 ---------- */

const PAD = 6

function dataUrl(file) {
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
}

// 一个点对应的那几行：挨着的合成一个框，隔得远的各画一个（不然中间不相干的内容也被圈进去）；四周留一点边
function boxesOf(page, lines) {
  const groups = lines.map((i) => page.lines[i].b)
  for (let i = 0; i < groups.length; i++) {
    const j = groups.findIndex((b, k) => k > i && near(groups[i], b))
    if (j < 0) continue
    groups[i] = union([groups[i], groups[j]])
    groups.splice(j, 1)
    i = -1
  }
  return groups.map((b) => {
    const x = Math.max(0, b[0] - PAD)
    const y = Math.max(0, b[1] - PAD)
    return [x, y, Math.min(page.w, b[0] + b[2] + PAD) - x, Math.min(page.h, b[1] + b[3] + PAD) - y].map(Math.round)
  })
}

// 上下隔不到大半行、左右隔不到两个字，算挨着
function near(a, b) {
  const h = Math.min(a[3], b[3])
  const gx = Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2])
  const gy = Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3])
  return gx < h * 2 && gy < h * 0.8
}

// 框按图的百分比定位：屏幕上图按原尺寸放再整体缩放，打印时图跟着纸宽走，框都对得上
function boxStyle(b, img) {
  const pct = (v, of) => `${+((v / of) * 100).toFixed(3)}%`
  return `left:${pct(b[0], img.w)};top:${pct(b[1], img.h)};width:${pct(b[2], img.w)};height:${pct(b[3], img.h)}`
}

function union(bs) {
  const x = Math.min(...bs.map((b) => b[0]))
  const y = Math.min(...bs.map((b) => b[1]))
  return [x, y, Math.max(...bs.map((b) => b[0] + b[2])) - x, Math.max(...bs.map((b) => b[1] + b[3])) - y]
}

/**
 * 一张图的看图器。img：{ file, w, h, label }；points：[{ boxes, text, at, quote }]（没有就是一张能点开放大的图）。
 * 点一条放大到它所有框合起来的范围。
 */
function viewer(img, points = []) {
  const still = !points.length
  const boxes = points
    .flatMap((p, i) => p.boxes.map((b) => `<b class="rb" data-i="${i}" data-b="${b.join(',')}" style="${boxStyle(b, img)}"><i class="k">${i + 1}</i></b>`))
    .join('')
  const stage = `<div class="stage on" data-w="${img.w}" data-h="${img.h}" data-s="1" style="width:${img.w}px;height:${img.h}px"><img src="${dataUrl(img.file)}" alt="${esc(img.label)}" width="${img.w}" height="${img.h}" draggable="false" loading="lazy">${boxes}</div>`
  const lines = points
    .map((p, i) => {
      const meta = [p.at != null ? `[${clock(p.at)}]` : '', p.quote ? `“${esc(p.quote)}”` : ''].filter(Boolean).join(' ')
      return `<li tabindex="0" data-i="${i}" data-t="0:0:${p.boxes.length ? union(p.boxes).join(',') : ''}"><span class="n">${i + 1}</span><span>${render(p.text, { inline: true })}${meta ? `<span class="said">${meta}</span>` : ''}</span></li>`
    })
    .join('')
  return `<div class="vw${still ? ' still' : ' split rows'}"><div class="ftitle">${esc(img.label)}<span class="sp"></span><button class="ghost close" type="button"><svg><use href="#i-close"/></svg>关闭</button></div><div class="vpbox"><div class="panes"><div class="pane"><div class="vp" role="img" aria-label="${esc(img.label)}">${stage}<i class="mask" hidden></i></div></div></div><div class="wbar"><span class="pnote1">${esc(img.label)}</span><button class="ghost all" type="button" hidden>全图</button><span class="sp"></span>${still ? '' : '<button class="ghost enl" type="button"><svg><use href="#i-enlarge"/></svg>放大</button>'}</div></div>${still ? '' : `<div class="side"><div class="side-h">老师对着这一页讲的</div><ol class="leg body">${lines}</ol></div>`}</div>`
}

/* ---------- 整页 ---------- */

const MATERIAL_IMG = /!\[([^\]]*)\]\(<?materials\/(m[0-9a-f]+)\/p(\d{3})\.jpg>?\)/g
const SLIDE_IMG = /!\[([^\]]*)\]\(<?slides\/([^)\s>]+)>?\)/g
const FIG_OPEN = ''
const FIG_CLOSE = ''

// Markdown 按 ## 和 ### 切开：[{ title, body, subs: [{ title, body }] }]
function splitSections(markdown) {
  const out = []
  let cur = null
  let sub = null
  let fence = false
  for (const line of String(markdown).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h2 = !fence && line.match(/^##\s+(.+)/)
    const h3 = !fence && line.match(/^###\s+(.+)/)
    if (h2) {
      cur = { title: h2[1].trim(), body: [], subs: [] }
      sub = null
      out.push(cur)
    } else if (h3 && cur) {
      sub = { title: h3[1].trim(), body: [] }
      cur.subs.push(sub)
    } else if (cur) (sub ?? cur).body.push(line)
  }
  return out
}

/**
 * → HTML 字符串。pages：materials.js 的 materialsForMap(...).pages（'<id>:<页码>' → 页的大小、文字行、文件）；
 * slideMap：session.summary.slideMap；sessionDir：截图 slides/ 所在的会议文件夹。
 */
export function renderNotesHtml({ session, markdown, slideMap = [], pages = new Map(), sessionDir, projectName = '', model = '' }) {
  const mapped = new Map(slideMap.map((x) => [`${x.m}:${x.p}`, x]))
  const used = new Set()
  const figs = []

  // 课件页和截图换成占位符，各占一段（列表里的图也提出来，看图器要整行宽）
  const pageFig = (key, label) => {
    const page = pages.get(key)
    if (!page) return null
    used.add(key)
    const points = (mapped.get(key)?.points ?? []).map((p) => ({ ...p, boxes: boxesOf(page, p.lines) }))
    const name = page.m.name.replace(/\.[^.]+$/, '')
    figs.push(viewer({ file: page.file, w: page.w, h: page.h, label: label || t(`《{0}》第 {1} 页`, name, page.n) }, points))
    return `\n\n${FIG_OPEN}${figs.length - 1}${FIG_CLOSE}\n\n`
  }
  const slides = new Set((session.slides ?? []).map((x) => path.basename(String(x?.file ?? ''))))
  const withFigs = (text) =>
    text
      .replace(MATERIAL_IMG, (all, alt, id, n) => pageFig(`${id}:${Number(n)}`, alt) ?? '')
      .replace(SLIDE_IMG, (all, alt, name) => {
        const base = path.basename(decodeURIComponent(name))
        const file = path.join(sessionDir, 'slides', base)
        if (!slides.has(base) || !fs.existsSync(file)) return ''
        figs.push(viewer({ file, ...jpegSize(fs.readFileSync(file)), label: alt || t('课上截图') }))
        return `\n\n${FIG_OPEN}${figs.length - 1}${FIG_CLOSE}\n\n`
      })
  // 大纲那一节按上课的顺序走一遍：每个小节先是老师讲到的课件页（框出讲的那几行、旁边是讲了什么），
  // 再是这一节的要点（Markdown），最后折着这一段时间里的原话和译文
  const lesson = (s) => {
    const chapters = s.subs.length ? s.subs : [{ title: s.title, body: s.body }]
    const starts = chapters.map((c, i) => parseAt(c.title.match(/^\[([\d:]+)\]/)?.[1]) ?? (i === 0 ? 0 : null))
    const chapterAt = (ms) => {
      let k = 0
      starts.forEach((t, i) => {
        if (t != null && ms != null && t <= ms) k = i
      })
      return k
    }
    const firstAt = (x) => Math.min(...x.points.map((p) => p.at ?? Infinity))
    const byChapter = chapters.map(() => [])
    for (const x of slideMap) {
      if (!pages.has(`${x.m}:${x.p}`)) continue
      const k = x.s != null && x.s < chapters.length ? x.s : chapterAt(firstAt(x))
      byChapter[k].push(x)
    }
    const subs = chapters.map((c, i) => {
      const shown = byChapter[i].sort((a, b) => firstAt(a) - firstAt(b)).map((x) => figs[figIndex(pageFig(`${x.m}:${x.p}`))])
      // 已经按顺序放了的页，Markdown 里再插的就去掉
      const notes = c.body.join('\n').replace(MATERIAL_IMG, (all, alt, id, n) => (mapped.has(`${id}:${Number(n)}`) ? '' : all))
      const end = starts.slice(i + 1).find((t) => t != null) ?? Infinity
      const said = transcript(session, starts[i] ?? 0, end)
      const html = [shown.join(''), notes.trim() ? `<div class="notes">${shown.length ? '<div class="sub-h">这一节的要点</div>' : ''}${body([notes])}</div>` : '', said].join('')
      return { title: c.title, html }
    })
    return s.subs.length ? { s, html: body(s.body), subs } : { s, html: subs[0].html, subs: [] }
  }
  const figIndex = (ph) => Number(ph.match(/\d+/)[0])

  const body = (lines) => render(withFigs(lines.join('\n'))).replace(new RegExp(`<p>${FIG_OPEN}(\\d+)${FIG_CLOSE}</p>`, 'g'), (_, i) => figs[i])

  const sections = splitSections(markdown)
  const overview = sections.find((s) => classHeadRe(0).test(s.title))
  const outline = sections.find((s) => classHeadRe(1).test(s.title))
  const rendered = sections.map((s) => (s === outline ? lesson(s) : { s, html: body(s.body), subs: [] }))
  const toc = [] // { id, title, subs: [{ id, title }] }
  const parts = []
  rendered.forEach((r, i) => {
    if (r.s === overview) return
    const id = `s${i + 1}`
    const subs = r.subs.map((x, j) => ({ id: `${id}-${j + 1}`, ...x }))
    toc.push({ id, title: r.s.title, subs })
    const quiz = classHeadRe(7).test(r.s.title)
    const fix = (h) => (quiz ? foldAnswers(h) : h)
    parts.push(
      `<section class="sec${quiz ? ' quiz' : ''}" id="${id}"><h2>${render(r.s.title, { inline: true })}</h2>${fix(r.html)}${subs.map((x) => `<h3 id="${x.id}">${heading(x.title)}</h3>${fix(x.html)}`).join('')}</section>`,
    )
  })

  const title = String(session.title ?? '').trim() || '课堂笔记'
  const d = new Date(session.startedAt)
  const minutes = session.endedAt ? Math.round((session.endedAt - session.startedAt) / 60_000) : null
  const credit = [projectName, `${ymd(session.startedAt)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, minutes ? `${minutes} 分钟` : '', ...(session.materials ?? []).map((m) => `课件《${m.name}》`), model ? `整理：${model}` : '']
    .filter(Boolean)
    .map((x) => `<span>${esc(x)}</span>`)
    .join('')
  const header = `<header class="hd" id="top"><div class="hd-row"><div><h1>${esc(title)}</h1><div class="credit">${credit}</div></div><span class="seg theme" role="tablist" aria-label="主题"><button data-t="auto">自动</button><button data-t="light">浅色</button><button data-t="dark">深色</button></span></div>${overview ? `<div class="lead">${rendered.find((r) => r.s === overview).html}</div>` : ''}</header>`
  const tocHtml = tocNav(toc)

  const put = (s, k, v) => s.replace(k, () => v)
  let html = fs.readFileSync(TEMPLATE, 'utf8')
  html = put(html, '{{TITLE}}', esc(`${title} 课堂笔记`))
  html = put(html, '{{KATEX_CSS}}', katexCss())
  html = put(html, '{{TOC}}', tocHtml)
  html = put(html, '{{BODY}}', header + parts.join('\n'))
  return html
}

// 这一段时间里的原话（带译文），折起来：想听老师怎么说的时候点开
function transcript(session, from, to) {
  const segs = (session.segments ?? []).filter((x) => x.text && x.startedAt - session.startedAt >= from && x.startedAt - session.startedAt < to)
  if (!segs.length) return ''
  const rows = segs.map((x) => {
    const sentences = x.sentences?.length ? x.sentences : [{ text: x.text }]
    const lines = sentences.map((y) => `<p class="en">${esc(y.text)}</p>${y.tr ? `<p class="zh">${esc(y.tr)}</p>` : ''}`).join('')
    return `<div class="line${x.who === 'me' ? ' me' : ''}"><span class="t">${clock(x.startedAt - session.startedAt)}</span><span class="who">${esc(x.speaker)}</span><div>${lines}</div></div>`
  })
  return `<details class="said-all"><summary>老师原话（${segs.length} 段，${clock(segs[0].startedAt - session.startedAt)} 起）</summary><div class="lines">${rows.join('')}</div></details>`
}

const PAGE_TAIL = /\s*[（(][^（()）]*(?<![\p{L}])(?:p|S|стр)\.\s*\d[^（()）]*[)）]\s*$/u

// 左边的目录：展开的一列、收起后的细条（一节一道短横）、指着细条浮出的整份目录；窄屏时展开的那一份变成顶上的一条（见 notes-page.html）
function tocNav(toc) {
  // 目录里一条一行：小节标题后面注明的课件页（「（课件 p.1）」「(slides p.1)」「(Folien S. 1)」…）去掉，完整标题放进 title
  const label = (title) => {
    const m = plain(title).match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/)
    const full = m ? m[2] : plain(title)
    const short = full.replace(PAGE_TAIL, '') || full
    return { html: `${m ? `<span class="t">${m[1]}</span>` : ''}<span class="x">${esc(short)}</span>`, full }
  }
  const link = (cls, id, title) => {
    const l = label(title)
    return `<a ${cls}href="#${id}" data-t="${id}" title="${esc(l.full)}">${l.html}</a>`
  }
  const list = `<ol class="toc-list"><li><a href="#top" data-t="top">${t('概览')}</a></li>${toc
    .map((x) => `<li>${link('', x.id, x.title)}${x.subs.length ? `<ol class="toc-sub">${x.subs.map((y) => `<li>${link('class="s" ', y.id, y.title)}</li>`).join('')}</ol>` : ''}</li>`)
    .join('')}</ol>`
  const ticks = [{ id: 'top', subs: [] }, ...toc].map((x) => `<li><a href="#${x.id}" data-t="${x.id}" tabindex="-1"><i></i></a></li>${x.subs.map((y) => `<li><a class="s" href="#${y.id}" data-t="${y.id}" tabindex="-1"><i></i></a></li>`).join('')}`).join('')
  const hide = t('收起目录')
  const show = t('展开目录')
  const cap = (btn) => `<div class="toc-cap"><span>${t('目录')}</span><span class="sp"></span>${btn}</div>`
  const button = (cls, text, sym, expanded) => `<button class="nbtn ${cls}" type="button" aria-label="${esc(text)}" title="${esc(text)}" aria-expanded="${expanded}"><svg><use href="#${sym}"/></svg></button>`
  return [
    `<nav class="toc" aria-label="${esc(t('目录'))}">`,
    `<button class="toc-btn" type="button" aria-expanded="false"><span class="tl">${t('目录')}</span><span class="tc"></span><svg><use href="#i-chev"/></svg></button>`,
    `<div class="toc-full">${cap(button('toc-close', hide, 'i-toc-close', 'true'))}${list}</div>`,
    `<div class="toc-rail">${button('toc-open', show, 'i-toc-open', 'false')}<ol class="rail-ticks" aria-hidden="true">${ticks}</ol><span class="rail-pos" aria-hidden="true"></span></div>`,
    `<div class="toc-peek" role="group" aria-label="${esc(t('目录'))}">${cap(button('toc-pin', show, 'i-toc-open', 'false'))}${list}</div>`,
    '</nav>',
  ].join('')
}

// 标题里的 [mm:ss] 画成时间标签
function heading(title) {
  const m = title.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/)
  return m ? `<span class="at">${m[1]}</span>${render(m[2], { inline: true })}` : render(title, { inline: true })
}

// 目录里的字：去掉 Markdown 记号和公式的 $
function plain(s) {
  return String(s).replace(/[*_`$]/g, '')
}

// 自测题的「答案：…」折起来，先想再看（笔记是别的语言写的也认：Answer:、答え：…）
const ANSWER = new RegExp(`(?:<br>\\s*)?(?:${ANSWER_WORDS.join('|')})\\s*[：:]\\s*([\\s\\S]*?)(?=<\\/p>|<\\/li>)`, 'g')
function foldAnswers(html) {
  return html.replace(ANSWER, (_, a) => `<details class="ans"><summary>看答案</summary><div>${a}</div></details>`)
}

let katexCssCache = null
// KaTeX 的样式，字体只带 woff2，内嵌成 data URL
function katexCss() {
  if (katexCssCache) return katexCssCache
  const dir = path.dirname(KATEX_CSS)
  katexCssCache = fs
    .readFileSync(KATEX_CSS, 'utf8')
    .replace(/src:url\(fonts\/([^)]+\.woff2)\) format\("woff2"\)[^;}]*/g, (_, f) => `src:url(data:font/woff2;base64,${fs.readFileSync(path.join(dir, 'fonts', f)).toString('base64')}) format("woff2")`)
  return katexCssCache
}

export { pageRef }
