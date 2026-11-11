'use strict'
// 视频课的图文笔记（design/video-mode 方向 A 的第 5 屏）：每个小节一行，左边截图、右边要点，标题旁有时间；
// 点时间或点截图，左边的视频跳到那一刻。数据全来自课堂笔记 Markdown 和视频里自动截的画面，不依赖 HTML 文件
// （「用浏览器打开」「导出 PDF」仍用原来的课堂笔记.html）。

const NOTE_TIME = /^\[(\d{1,3}:\d{2}(?::\d{2})?)\]\s*/
const NOTE_IMG = /!\[([^\]]*)\]\(<?slides\/([^)\s>]+)>?\)/g
const MAX_FIGS = 3

const clockMs = (s) => {
  const p = s.split(':').map(Number)
  return (p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]) * 1000
}

/**
 * 课堂笔记 Markdown → { overview, intro, sections: [{ at, title, body, figs: [文件名] }], extras: [{ title, body }] }。
 * 大纲那一节认法：第一个带 [时间] 小标题的二级标题；它前面的第一个二级标题是概览；其余的二级标题原样放在后面。
 * 没有带时间的小标题（模型没照格式写）返回 null，调用的地方换回原来的图文笔记。
 */
function parseVideoNotes(md) {
  const h2s = []
  let cur = null
  let sub = null
  let fence = false
  for (const line of String(md ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const a = !fence && line.match(/^##\s+(.+)/)
    const b = !fence && line.match(/^###\s+(.+)/)
    if (a) {
      cur = { title: a[1].trim(), body: [], subs: [] }
      sub = null
      h2s.push(cur)
    } else if (b && cur) {
      sub = { title: b[1].trim(), body: [] }
      cur.subs.push(sub)
    } else if (cur) (sub ?? cur).body.push(line)
  }
  const outline = h2s.findIndex((h) => h.subs.some((x) => NOTE_TIME.test(x.title)))
  if (outline < 0) return null
  const o = h2s[outline]
  const timed = o.subs.map((x, i) => {
    const m = x.title.match(NOTE_TIME)
    return { at: m ? clockMs(m[1]) : null, title: m ? x.title.slice(m[0].length) : x.title, body: x.body.join('\n') }
  })
  // 没写时间的小节跟着前一个小节走
  const sections = []
  for (const x of timed) {
    if (x.at == null && sections.length) sections.at(-1).body += `\n\n**${x.title}**\n${x.body}`
    else sections.push({ ...x, at: x.at ?? 0 })
  }
  sections.sort((p, q) => p.at - q.at)
  for (const x of sections) {
    x.figs = []
    x.body = x.body.replace(NOTE_IMG, (all, alt, name) => (x.figs.push(decodeURIComponent(name)), ''))
  }
  const pre = h2s.slice(0, outline)
  return {
    overview: pre[0] ? pre[0].body.join('\n').trim() : '',
    intro: o.body.join('\n').trim(),
    sections,
    extras: [...pre.slice(1), ...h2s.slice(outline + 1)].map((h) => ({ title: h.title, body: [...h.body, ...h.subs.flatMap((x) => [`\n### ${x.title}`, ...x.body])].join('\n').trim() })).filter((x) => x.body),
  }
}

/** 画出图文笔记。s：这场会议；vm：视频播放器（seek）；→ { node } 或 null（笔记不是带时间的小节，调用的地方换回原来的）。 */
function videoNotesView(s, vm) {
  const parsed = parseVideoNotes(s.summary?.markdown)
  if (!parsed) return null
  const slides = [...(s.slides ?? [])].filter((x) => x.file).map((x) => ({ ...x, ms: x.at - s.startedAt })).sort((p, q) => p.ms - q.ms)
  const byName = new Map(slides.map((x) => [String(x.file).split('/').pop(), x]))
  const cited = new Set(parsed.sections.flatMap((x) => x.figs))
  const segs = (s.segments ?? []).filter((x) => x.text).map((x) => ({ x, ms: x.startedAt - s.startedAt })).sort((p, q) => p.ms - q.ms)
  const { sections } = parsed

  const prose = (md) => {
    const d = el('div.prose.vn-prose')
    renderMarkdown(d, md)
    vm?.decorate(d)
    return d
  }
  const jump = (ms) => vm?.seek(ms, true)
  const chip = (ms) => el('button.vm-tchip', { type: 'button', title: t('回到视频这一刻'), onClick: () => jump(ms) }, icon('play', 10), fmtOffset(ms))

  sections.forEach((x, i) => {
    const end = sections[i + 1]?.at ?? Infinity
    // 模型引用的截图在前；没引用的、落在这一节时间里的补在后面
    const own = x.figs.map((f) => byName.get(f)).filter(Boolean)
    const rest = slides.filter((sl) => !cited.has(String(sl.file).split('/').pop()) && sl.ms >= x.at && sl.ms < end)
    x.shots = [...own, ...rest].filter((v, k, a) => a.indexOf(v) === k).sort((p, q) => p.ms - q.ms).slice(0, MAX_FIGS)
    x.said = segs.filter((q) => q.ms >= x.at && q.ms < end)
  })

  const figure = (sl) =>
    el(
      'button.vn-fig',
      { type: 'button', title: t(`回到视频 {0}`, fmtOffset(sl.ms)), onClick: () => jump(sl.ms) },
      el('img', { src: slideSrc(sl, s.dir), alt: '', loading: 'lazy' }),
      el('span.vn-fig-at.num', { text: fmtOffset(sl.ms) }),
    )

  const quote = (list) =>
    el(
      'details.vn-said',
      {},
      el('summary', { text: t(`老师原话 {0} 句`, list.length) }),
      ...list.map(({ x, ms }) => {
        const sen = x.sentences?.[0]
        return el(
          'p.vn-q',
          { title: t('回到视频这一刻'), onClick: () => jump(ms) },
          el('span.vn-q-o', { text: sen?.text ?? x.text }),
          sen?.tr ? el('span.vn-q-z', { text: sen.tr }) : null,
        )
      }),
    )

  const secNodes = sections.map((x, i) => {
    const title = el('span.vn-sec-t')
    title.innerHTML = window.marked ? window.marked.parseInline(x.title) : ''
    if (!window.marked) title.textContent = x.title
    const body = el('div.vn-points', {}, x.body.trim() ? prose(x.body) : null, x.said.length ? quote(x.said) : null)
    return el(
      'section.vn-sec',
      { id: `vn-${i + 1}` },
      el('h3.vn-sec-h', {}, el('span.vn-n.num', { text: String(i + 1) }), title, chip(x.at)),
      el('div.vn-body', { class: x.shots.length ? 'has-fig' : '' }, x.shots.length ? el('div.vn-figs', {}, ...x.shots.map(figure)) : null, body),
    )
  })

  const durationMs = s.video?.durationMs ?? (s.endedAt ?? s.startedAt) - s.startedAt
  const lead = [fmtLen(durationMs), t(`{0} 个小节`, sections.length), slides.length ? t(`{0} 张自动截的画面`, slides.length) : ''].filter(Boolean).join(' · ')
  const toc = el(
    'nav.vn-toc',
    { 'aria-label': t('目录') },
    el('span.vn-toc-l', { text: t('目录') }),
    ...sections.map((x, i) =>
      el('button', { type: 'button', onClick: () => document.getElementById(`vn-${i + 1}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, el('span.num', { text: String(i + 1) }), ' ', x.title.replace(/[*_`$]/g, '')),
    ),
  )
  const head = el('header.vn-head', {}, el('h2.vn-title', { text: s.title }), el('div.vn-meta.num', { text: lead }))
  const overview = parsed.overview ? prose(parsed.overview) : null
  overview?.classList.add('vn-overview')
  const extras = parsed.extras.map((x) => el('section.vn-extra', {}, el('h3.vn-extra-h', { text: x.title.replace(/[*_`]/g, '') }), prose(x.body)))
  const node = el('div.vn', {}, head, overview, parsed.intro ? prose(parsed.intro) : null, toc, ...secNodes, ...extras)
  return { node }
}
