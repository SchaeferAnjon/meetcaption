import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { t } from '../i18n.js'

// 课件：一节课可以加几份老师的课件（PDF、图片）。原文件拷进会议文件夹 materials/<id>/，每页存成 pNNN.jpg，
// 每页的文字存 text.json，每页的大小和每行文字的位置存 layout.json（[{ w, h, lines: [{ t, b: [x, y, w, h] }] }]）；session.materials 记 [{ id, name, kind, pages, addedAt }]。
// 生成课堂笔记时把各页文字和挑出来的一些页图交给模型（materialsForNotes），笔记里用 materials/<id>/pNNN.jpg 引用那一页。
// 不引 electron：PDF 渲染和图片转 JPEG 由主进程注入（renderPdf、toJpeg），单测用假的。

export const MATERIAL_TYPES = { pdf: 'pdf', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', heic: 'image' }
export const MAX_PAGES = 300
const PAGE_CHARS = 1500 // 每页文字最多交给模型多少
const TOTAL_CHARS = 40_000
const MAX_IMAGES = 24

export const pageFile = (n) => `p${String(n).padStart(3, '0')}.jpg`
export const pageRef = (id, n) => `materials/${id}/${pageFile(n)}`

export function materialKind(file) {
  return MATERIAL_TYPES[path.extname(file).slice(1).toLowerCase()] ?? null
}

/**
 * 导入一份课件 → { id, name, kind, pages, addedAt }。
 * renderPdf(file, onPage(n, total, { text, jpeg })) 一页一页渲染 PDF；toJpeg(file) → JPEG Buffer（图片课件）。
 * onProgress({ page, total })：渲染到第几页。超过 MAX_PAGES 页的只取前面的。
 */
export async function importMaterial({ sessionDir, file, renderPdf, toJpeg, onProgress = () => {} }) {
  const kind = materialKind(file)
  if (!kind) throw new Error(t(`不认识这种文件：{0}（课件要 PDF 或图片）`, path.basename(file)))
  const id = `m${crypto.randomBytes(3).toString('hex')}`
  const dir = path.join(sessionDir, 'materials', id)
  fs.mkdirSync(dir, { recursive: true })
  try {
    fs.copyFileSync(file, path.join(dir, `source${path.extname(file).toLowerCase()}`))
    const texts = []
    const layout = []
    if (kind === 'pdf') {
      await renderPdf(file, async (n, total, { text, lines, width, height, jpeg }) => {
        if (n > MAX_PAGES) return false
        fs.writeFileSync(path.join(dir, pageFile(n)), jpeg)
        texts.push(text)
        layout.push({ w: width, h: height, lines })
        onProgress({ page: n, total: Math.min(total, MAX_PAGES) })
        return true
      })
      if (!texts.length) throw new Error(t('这份 PDF 一页都没读出来'))
    } else {
      const jpeg = toJpeg(file)
      fs.writeFileSync(path.join(dir, pageFile(1)), jpeg)
      texts.push('')
      layout.push({ ...jpegSize(jpeg), lines: [] })
      onProgress({ page: 1, total: 1 })
    }
    fs.writeFileSync(path.join(dir, 'text.json'), JSON.stringify(texts))
    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout))
    return { id, name: path.basename(file), kind, pages: texts.length, addedAt: Date.now() }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw e
  }
}

export function removeMaterial(sessionDir, id) {
  if (!/^m[0-9a-f]+$/.test(id)) throw new Error(t('课件 id 不对'))
  fs.rmSync(path.join(sessionDir, 'materials', id), { recursive: true, force: true })
}

function readTexts(sessionDir, m) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, 'materials', m.id, 'text.json'), 'utf8'))
  } catch {
    return []
  }
}

/**
 * 交给课堂笔记的课件：→ { text, images: [{ ref, file, label }] }，没有课件时 text 是 ''。
 * text 是每一页的文字（标着页码和引用路径），太长的截断；images 是附图的页：
 * 页数不多全给，多了优先给文字少的页（多半是图、表、公式，光看文字看不出来），按页码排。
 */
export function materialsForNotes(session, sessionDir, { maxImages = MAX_IMAGES, totalChars = TOTAL_CHARS } = {}) {
  const list = (session.materials ?? []).filter((m) => m?.id && m.pages > 0)
  if (!list.length) return { text: '', images: [] }
  const pages = []
  for (const m of list) {
    const texts = readTexts(sessionDir, m)
    for (let n = 1; n <= m.pages; n++) pages.push({ m, n, text: String(texts[n - 1] ?? '').trim(), ref: pageRef(m.id, n), file: path.join(sessionDir, 'materials', m.id, pageFile(n)) })
  }
  const picked = pages.length <= maxImages ? pages : [...pages].sort((a, b) => a.text.length - b.text.length).slice(0, maxImages)
  const withImage = new Set(picked)
  const images = pages.filter((p) => withImage.has(p)).map((p) => ({ ref: p.ref, file: p.file, label: t(`《{0}》第 {1} 页`, p.m.name, p.n) }))
  let left = totalChars
  const blocks = list.map((m) => {
    const lines = pages
      .filter((p) => p.m === m)
      .map((p) => {
        const t = p.text.length > PAGE_CHARS ? `${p.text.slice(0, PAGE_CHARS)}…` : p.text
        const body = left > 0 ? t.slice(0, Math.max(0, left)) : '（文字太多，略）'
        left -= body.length
        return `[第 ${p.n} 页 · ${p.ref}${withImage.has(p) ? ' · 附图' : ''}]\n${body || (m.kind === 'image' ? '（图片）' : '（这页没有文字）')}`
      })
    return `课件《${m.name}》（共 ${m.pages} 页）：\n${lines.join('\n')}`
  })
  return { text: blocks.join('\n\n'), images }
}

/** JPEG 的宽高（读 SOF 段）。 */
export function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length; ) {
    if (buf[i] !== 0xff) break
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  throw new Error(t('读不出图片大小'))
}

/** 一份课件每页的大小和文字行：[{ w, h, lines }]。 */
export function readLayout(sessionDir, m) {
  return JSON.parse(fs.readFileSync(path.join(sessionDir, 'materials', m.id, 'layout.json'), 'utf8'))
}

/**
 * 早先导入、还没有 layout.json 的课件补算一次：PDF 用 source.pdf 重新过一遍 pdf.js，图片读 JPEG 大小。
 */
export async function ensureLayouts(session, sessionDir, { renderPdf }) {
  for (const m of session.materials ?? []) {
    const dir = path.join(sessionDir, 'materials', m.id)
    if (fs.existsSync(path.join(dir, 'layout.json'))) continue
    const layout = []
    if (m.kind === 'pdf') {
      await renderPdf(path.join(dir, 'source.pdf'), (n, _total, { lines, width, height }) => {
        if (n > m.pages) return false
        layout.push({ w: width, h: height, lines })
        return true
      })
    } else {
      layout.push({ ...jpegSize(fs.readFileSync(path.join(dir, pageFile(1)))), lines: [] })
    }
    fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify(layout))
  }
}

const LINE_CHARS = 160
const PAGE_LINES = 40

/**
 * 交给「笔记对课件」那一步的课件：每页的文字行编了号（第几行），模型用行号指出老师讲的是哪一行。
 * → { text, pages: Map<'<id>:<页码>', { m, n, w, h, lines, ref, file }> }
 */
export function materialsForMap(session, sessionDir, { totalChars = TOTAL_CHARS } = {}) {
  const pages = new Map()
  let left = totalChars
  const blocks = (session.materials ?? []).map((m) => {
    const layout = readLayout(sessionDir, m)
    const rows = layout.map((pg, i) => {
      const n = i + 1
      pages.set(`${m.id}:${n}`, { m, n, ...pg, ref: pageRef(m.id, n), file: path.join(sessionDir, 'materials', m.id, pageFile(n)) })
      const lines = pg.lines.slice(0, PAGE_LINES).map((l, j) => `${j + 1}. ${l.t.slice(0, LINE_CHARS)}`)
      const body = left > 0 ? lines.join('\n') : '（文字太多，略）'
      left -= body.length
      return `[${m.id} 第 ${n} 页]\n${body || '（这页没有文字，是图）'}`
    })
    return `课件《${m.name}》（id ${m.id}，共 ${m.pages} 页）：\n${rows.join('\n')}`
  })
  return { text: blocks.join('\n\n'), pages }
}
