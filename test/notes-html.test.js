import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { importMaterial, jpegSize, materialsForMap } from '../src/main/class/materials.js'
import { outlineSections, parseSlideMap } from '../src/main/class/slideMap.js'
import { slideMapMessages } from '../src/main/class/prompts.js'
import { exportNotesTo } from '../src/main/class/files.js'
import { renderNotesHtml } from '../src/main/class/notesHtml.js'
import { setUiLang } from '../src/main/i18n.js'

// 最小的 JPEG 头：SOF0 段里写着 1280 × 720
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, ...Array(9).fill(0), 0xff, 0xd9])

const PAGES = [
  { text: 'Lecture 5', lines: [{ t: 'Lecture 5: Evaluating Classifiers', b: [64, 99, 906, 73] }] },
  {
    text: 'Precision and Recall',
    lines: [
      { t: 'Precision and Recall', b: [64, 88, 313, 40] },
      { t: 'Precision = TP / (TP + FP)', b: [64, 170, 400, 36] },
      { t: 'Recall = TP / (TP + FN)', b: [64, 214, 380, 36] },
    ],
  },
]
const fakeRender = async (_file, onPage) => {
  for (let i = 0; i < PAGES.length; i++) await onPage(i + 1, PAGES.length, { ...PAGES[i], width: 1280, height: 720, jpeg })
}

const MARKDOWN = `## 本节概览
讲 Precision 和 Recall。<script>alert(1)</script>
## 大纲与知识点
### [00:00] 医学检测（课件 p.2）
- 癌症检测的例子 [看这里](javascript:alert(1))
![课件第 2 页：定义](materials/MID/p002.jpg)
### [00:20] trade-off
- 两者此消彼长
## 公式与推导
$$\\mathrm{Precision}=\\frac{TP}{TP+FP}$$
## 自测题
1. Precision 的分母是什么？
答案：$TP+FP$
`

test('jpegSize reads the frame size after other segments', () => {
  assert.deepEqual(jpegSize(jpeg), { w: 1280, h: 720 })
  assert.throws(() => jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), /图片大小/)
})

test('outlineSections and parseSlideMap keep only real pages, lines and sections', async () => {
  assert.deepEqual(outlineSections(MARKDOWN), ['[00:00] 医学检测（课件 p.2）', '[00:20] trade-off'])
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-map-'))
  fs.writeFileSync(path.join(dir, 'L5.pdf'), '%PDF')
  const m = await importMaterial({ sessionDir: dir, file: path.join(dir, 'L5.pdf'), renderPdf: fakeRender })
  const { text, pages } = materialsForMap({ materials: [m] }, dir)
  assert.match(text, new RegExp(`\\[${m.id} 第 2 页\\]\\n1\\. Precision and Recall\\n2\\. Precision = TP`))
  const raw = JSON.stringify({
    pages: [
      { m: m.id, p: 2, s: 1, points: [{ l: [2, 9], t: '分母是预测为阳性的 $TP+FP$', at: '00:05', q: 'of all predicted cancers' }, { l: [], t: '' }] },
      { m: m.id, p: 2, s: 1, points: [{ l: [3], t: '漏检看 Recall', at: '00:12' }] },
      { m: m.id, p: 9, s: 1, points: [{ l: [1], t: '不存在的页' }] },
      { m: 'mzzz', p: 1, points: [{ t: '别的课件' }] },
    ],
  })
  const map = parseSlideMap(raw, { pages, sections: outlineSections(MARKDOWN) })
  assert.equal(map.length, 1, '不存在的页和别的课件丢掉，同一页并成一条')
  assert.deepEqual(map[0].points.map((p) => [p.lines, p.at]), [[[1], 5000], [[2], 12000]], '行号越界的丢掉，空的点丢掉')
  assert.equal(map[0].s, 0)
  assert.throws(() => parseSlideMap('不是 JSON', { pages, sections: [] }), /不是 JSON/)
  const [sys, user] = slideMapMessages({ session: { startedAt: 0, segments: [{ startedAt: 5000, speaker: '老师', text: 'Precision is…' }] }, markdown: MARKDOWN, sections: outlineSections(MARKDOWN), materialsText: text })
  assert.match(sys.content, /框出老师对着讲的那几行/)
  assert.match(user.content, /1\. \[00:00\] 医学检测/)
  assert.match(user.content, /\[00:05\] 老师：Precision is/)
})

test('Summarizer writes 课堂笔记.html: course pages as viewers with boxes, transcript with translation, folded answers, no raw HTML', async () => {
  const { Summarizer } = await import('../src/main/summary.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noteshtml-'))
  const ps = new ProjectStore({ root: () => root }).load()
  const ml = ps.create({ name: 'ML for Medicine', mode: 'class' })
  const store = new SessionStore({ projects: ps })
  const s = store.create({ projectId: ml.id, mode: 'class', classSource: 'system' })
  const dir = store.dir(s.id)
  fs.writeFileSync(path.join(root, 'L5.pdf'), '%PDF')
  // 早先导入的课件没有 layout.json：生成时用 source.pdf 补算
  const m = await importMaterial({ sessionDir: dir, file: path.join(root, 'L5.pdf'), renderPdf: fakeRender })
  fs.rmSync(path.join(dir, 'materials', m.id, 'layout.json'))
  s.materials = [m]
  s.segments.push({ id: 'system:1', speaker: '老师', who: 'other', startedAt: s.startedAt + 5000, text: 'Of all predicted cancers, how many are real.', sentences: [{ text: 'Of all predicted cancers, how many are real.', tr: '预测为癌症的里面有多少是真的。' }] })
  s.segments.push({ id: 'system:2', speaker: '老师', who: 'other', startedAt: s.startedAt + 25_000, text: 'They trade off.' })
  s.endedAt = s.startedAt + 60_000
  store.saveNow(s)
  const md = MARKDOWN.replace('MID', m.id)
  const calls = []
  const llm = async (o) => {
    calls.push(o)
    if (!o.json) return md
    if (/图文版课堂笔记/.test(o.system)) return JSON.stringify({ pages: [{ m: m.id, p: 2, s: 1, points: [{ l: [2], t: '分母是预测为阳性的 $TP+FP$', at: '00:05', q: 'Of all predicted cancers' }, { l: [1, 3], t: '标题和召回率', at: '00:06' }] }] })
    return JSON.stringify({ title: '精确率与召回率', items: [] })
  }
  const sum = new Summarizer({ store, projects: ps, llm, aiStatus: () => ({ ready: true }), renderPdf: fakeRender, loadImage: () => 'data:image/jpeg;base64,' })
  const r = await sum.generate(s.id, '')
  assert.equal(r.html, '课堂笔记.html')
  assert.equal(r.htmlError, null)
  assert.ok(fs.existsSync(path.join(dir, 'materials', m.id, 'layout.json')), '补算了每行文字的位置')
  const html = fs.readFileSync(path.join(dir, '课堂笔记.html'), 'utf8')
  assert.match(html, /<title>精确率与召回率 课堂笔记<\/title>/, '标题等作业提取起完再画')
  assert.match(html, /<b class="rb" data-i="0" data-b="58,164,412,48" style="left:4.531%;top:22.778%;width:32.188%;height:6.667%">/, '框住第 2 行，四周留 6 像素')
  assert.match(html, /<li tabindex="0" data-i="0" data-t="0:0:58,164,412,48"><span class="n">1<\/span><span>分母是预测为阳性的 <span class="katex">/)
  assert.match(html, /\[00:05\] “Of all predicted cancers”/)
  // 隔得远的两行各画一个框（同一个号），点这一条放大到两个框合起来的范围
  assert.match(html, /<b class="rb" data-i="1" data-b="58,82,325,52"[^>]*>[\s\S]*<b class="rb" data-i="1" data-b="58,208,392,48"/)
  assert.match(html, /<li tabindex="0" data-i="1" data-t="0:0:58,82,392,174">/)
  assert.equal(html.match(/data:image\/jpeg;base64,/g).length, 1, '课件页只插一次（Markdown 里插的和对照出来的是同一页）')
  assert.match(html, /<p class="zh">预测为癌症的里面有多少是真的。<\/p>/)
  assert.match(html, /老师原话（1 段，00:05 起）[\s\S]*老师原话（1 段，00:25 起）/, '每个小节只放自己那段时间的原话')
  assert.match(html, /<details class="ans"><summary>看答案<\/summary>/)
  assert.match(html, /<div class="math-display"><span class="katex-display">/)
  assert.match(html, /src:url\(data:font\/woff2;base64,/)
  assert.doesNotMatch(html, /<script>alert|javascript:alert/)
  assert.deepEqual(store.load(s.id).summary.slideMap[0].points[0].lines, [1])
  // 只重做图文版：课件对照失败也照样出一份，只是不带框
  const bad = new Summarizer({ store, projects: ps, llm: async () => 'oops', aiStatus: () => ({ ready: true }), renderPdf: fakeRender })
  const r2 = await bad.buildHtml(s.id)
  assert.match(r2.htmlError, /课件没对上/)
  assert.doesNotMatch(fs.readFileSync(path.join(dir, '课堂笔记.html'), 'utf8'), /class="rb"/)
  // 导出到笔记库带上图文版
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-noteshtml-out-'))
  const ex = exportNotesTo({ session: store.load(s.id), sessionDir: dir, dir: out })
  assert.ok(ex.files.some((f) => f.endsWith('精确率与召回率 课堂笔记.html')))
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(out, { recursive: true, force: true })
})

test('笔记页的目录：展开的一列、收起的细条、浮出的整份目录三份一一对上，按钮有名字，按界面语言写', () => {
  const session = { title: '梯度下降', startedAt: Date.UTC(2026, 9, 29, 2), endedAt: Date.UTC(2026, 9, 29, 3), segments: [], materials: [], slides: [] }
  const links = (html) => [...html.matchAll(/<a (?:class="s" )?href="#([\w-]+)" data-t="/g)].map((m) => m[1])
  const render = () => renderNotesHtml({ session, markdown: MARKDOWN, sessionDir: os.tmpdir() })
  const zh = render()
  const full = zh.match(/<div class="toc-full">([\s\S]*?)<\/div><div class="toc-rail">/)[1]
  const rail = zh.match(/<ol class="rail-ticks"[^>]*>([\s\S]*?)<\/ol>/)[1]
  const peek = zh.match(/<div class="toc-peek"[^>]*>([\s\S]*)<\/div><\/nav>/)[1]
  assert.deepEqual(links(rail), links(full), '细条一节一道，和目录列一样多')
  assert.deepEqual(links(peek), links(full))
  assert.ok(links(full).includes('s2-1') && links(full).includes('top'), '大纲的小节和概览都在')
  assert.match(full, /<span class="t">00:00<\/span><span class="x">医学检测<\/span>/, '小节的时间单独一块，标题后面的课件页不进目录')
  assert.match(full, /title="医学检测（课件 p\.2）"/, '完整标题放在 title 里')
  assert.match(zh, /<h3 id="s2-1"><span class="at">00:00<\/span>医学检测（课件 p\.2）<\/h3>/, '正文里的小节标题照旧带课件页')
  assert.match(zh, /<button class="nbtn toc-close" type="button" aria-label="收起目录" title="收起目录" aria-expanded="true">/)
  assert.match(zh, /<button class="nbtn toc-open" type="button" aria-label="展开目录" title="展开目录" aria-expanded="false">/)
  assert.match(zh, /localStorage\.getItem\("meetcaption-notes-toc"\)/, '记住收起还是展开')
  assert.match(zh, /location\.hash\.match\(\/toc=\(rail\|open\)\//, '框架里的页面不能存：开页时读地址里的 #toc=')
  assert.match(zh, /parent\.postMessage\(\{type:"meetcaption-notes-toc",rail:on\}/, '收起展开时发消息给软件，由软件记下')
  assert.match(zh.match(/@media print\{[^\n]*/)[0], /\.toc,/, '打印和导出 PDF 不带目录和它的按钮')
  setUiLang('en')
  try {
    const en = render()
    assert.match(en, /aria-label="Collapse contents"/)
    assert.match(en, /aria-label="Expand contents"/)
    assert.doesNotMatch(en, /收起目录/)
  } finally {
    setUiLang('zh')
  }
})

test('笔记页的目录条目：小节标题后面的课件页（各种语言的写法）不进目录，别的括号留着', () => {
  const session = { title: 'T', startedAt: Date.UTC(2026, 9, 29, 2), endedAt: Date.UTC(2026, 9, 29, 3), segments: [], materials: [], slides: [] }
  const subs = ['[00:01] 梯度下降（課件 p.1）', '[00:02] Gradient (slides p.1)', '[00:03] Gradient (Folien S. 3 bis S. 4)', '[00:04] 勾配（スライド p.12 から p.15）', '[00:05] 경사 (강의 자료 p.12부터 p.15까지)', '[00:06] Gradient (diapos p. 12 à p. 15)', '[00:07] Gradient (step.3)', '[00:08] 步骤（先看图）', '[00:09] （课件 p.5）']
  const markdown = `## 大纲与知识点\n${subs.map((x) => `### ${x}\n- a`).join('\n')}\n`
  const html = renderNotesHtml({ session, markdown, sessionDir: os.tmpdir() })
  const full = html.match(/<div class="toc-full">([\s\S]*?)<\/div><div class="toc-rail">/)[1]
  const shown = [...full.matchAll(/<a class="s"[^>]*><span class="t">[\d:]+<\/span><span class="x">([^<]*)<\/span>/g)].map((m) => m[1])
  assert.deepEqual(shown, ['梯度下降', 'Gradient', 'Gradient', '勾配', '경사', 'Gradient', 'Gradient (step.3)', '步骤（先看图）', '（课件 p.5）'])
})
