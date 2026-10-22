import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { importMaterial, materialsForNotes, removeMaterial, pageRef } from '../src/main/class/materials.js'
import { classNotesMessages } from '../src/main/class/prompts.js'
import { exportNotesTo } from '../src/main/class/files.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-materials-'))
// 最小的 JPEG 头：SOF0 段里写着 3 × 2 像素
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, ...Array(9).fill(0), 0xff, 0xd9])

// 假的 PDF 渲染：pages 是每页的文字
const fakeRender = (pages) => async (_file, onPage) => {
  for (let i = 0; i < pages.length; i++) if ((await onPage(i + 1, pages.length, { text: pages[i], jpeg })) === false) break
}

test('importMaterial copies the PDF, writes one JPEG and the text per page; a bad file leaves nothing behind', async () => {
  const dir = tmp()
  const src = path.join(dir, 'Lecture 5.pdf')
  fs.writeFileSync(src, '%PDF')
  const progress = []
  const m = await importMaterial({ sessionDir: dir, file: src, renderPdf: fakeRender(['Precision and recall', '', 'F1 = 2PR/(P+R)']), onProgress: (p) => progress.push(p.page) })
  assert.equal(m.kind, 'pdf')
  assert.equal(m.pages, 3)
  assert.equal(m.name, 'Lecture 5.pdf')
  assert.deepEqual(progress, [1, 2, 3])
  const mdir = path.join(dir, 'materials', m.id)
  assert.deepEqual(fs.readdirSync(mdir).sort(), ['layout.json', 'p001.jpg', 'p002.jpg', 'p003.jpg', 'source.pdf', 'text.json'])
  await assert.rejects(importMaterial({ sessionDir: dir, file: src, renderPdf: async () => {} }), /一页都没读出来/)
  await assert.rejects(importMaterial({ sessionDir: dir, file: path.join(dir, 'notes.docx') }), /PDF 或图片/)
  assert.equal(fs.readdirSync(path.join(dir, 'materials')).length, 1, '失败的不留文件夹')
  fs.writeFileSync(src.replace('.pdf', '.png'), 'png')
  const img = await importMaterial({ sessionDir: dir, file: src.replace('.pdf', '.png'), toJpeg: () => jpeg })
  assert.equal(img.kind, 'image')
  assert.equal(img.pages, 1)
  removeMaterial(dir, img.id)
  assert.ok(!fs.existsSync(path.join(dir, 'materials', img.id)))
})

test('materialsForNotes gives every page text with its path, and attaches the pages with the least text when there are many', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'a.pdf'), '%PDF')
  const texts = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? '' : `Slide ${i + 1} `.repeat(10 + i)))
  const m = await importMaterial({ sessionDir: dir, file: path.join(dir, 'a.pdf'), renderPdf: fakeRender(texts) })
  const r = materialsForNotes({ materials: [m] }, dir, { maxImages: 8 })
  assert.equal(r.images.length, 8)
  assert.ok(r.images.some((x) => x.ref === pageRef(m.id, 1)), '没文字的页（多半是图）优先附图')
  assert.ok(r.images.every((x, i, a) => i === 0 || a[i - 1].ref < x.ref), '按页码排')
  assert.match(r.text, /课件《a\.pdf》（共 30 页）/)
  assert.match(r.text, new RegExp(`\\[第 4 页 · materials/${m.id}/p004\\.jpg\\]\\nSlide 4`), '没附图的页只有文字')
  assert.match(r.text, /\[第 1 页 · materials\/m[0-9a-f]+\/p001\.jpg · 附图\]\n（这页没有文字）/)
  assert.deepEqual(materialsForNotes({}, dir), { text: '', images: [] })
  const small = materialsForNotes({ materials: [m] }, dir, { maxImages: 40 })
  assert.equal(small.images.length, 30, '页数不多全附图')
})

test('class notes prompt: with course materials it compares slides and transcript and inserts pages by path', () => {
  const session = { startedAt: Date.parse('2026-10-21T09:33:00'), segments: [{ startedAt: Date.parse('2026-10-21T09:34:00'), speaker: '老师', text: 'Precision and recall trade off.' }] }
  const materials = { text: '课件《L5.pdf》（共 1 页）：\n[第 1 页 · materials/mab12cd/p001.jpg · 附图]\nPrecision', images: [{ ref: 'materials/mab12cd/p001.jpg', label: '《L5.pdf》第 1 页' }] }
  const [sys, user] = classNotesMessages({ session, materials })
  assert.match(sys.content, /对照课件和识别稿一起写/)
  assert.match(sys.content, /materials\/…\/pNNN\.jpg/)
  assert.match(user.content, /老师的课件（逐页文字；标着「附图」的页，图附在后面，按顺序：《L5\.pdf》第 1 页）/)
  const [plain] = classNotesMessages({ session })
  assert.doesNotMatch(plain.content, /对照课件/)
})

test('exportNotesTo copies the course pages the notes link to and rewrites the links', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'L5.pdf'), '%PDF')
  const m = await importMaterial({ sessionDir: dir, file: path.join(dir, 'L5.pdf'), renderPdf: fakeRender(['a', 'b']) })
  const session = { mode: 'class', startedAt: Date.parse('2026-10-21T09:33:00'), title: '精确率与召回率', materials: [m], summary: { markdown: `## 大纲\n![课件第 2 页：PR 曲线](materials/${m.id}/p002.jpg)\n![别的](materials/m000000/p001.jpg)` } }
  const out = tmp()
  const r = exportNotesTo({ session, sessionDir: dir, dir: out })
  const md = fs.readFileSync(r.files[0], 'utf8')
  assert.match(md, /!\[课件第 2 页：PR 曲线\]\(2026-10-21%20精确率与召回率%20截图\/L5%20p002\.jpg\)/)
  assert.match(md, /materials\/m000000\/p001\.jpg/, '不是这节课的课件不拷')
  assert.ok(fs.existsSync(path.join(out, '2026-10-21 精确率与召回率 截图', 'L5 p002.jpg')))
})
