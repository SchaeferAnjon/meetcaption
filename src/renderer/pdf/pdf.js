// 隐藏窗口里用 pdf.js 读课件：主进程先 openPdf(地址) 拿页数，再一页一页 renderPage(n) 拿这一页的文字和 JPEG。
import * as pdfjs from '../../../node_modules/pdfjs-dist/build/pdf.min.mjs'

const lib = new URL('../../../node_modules/pdfjs-dist/', import.meta.url)
pdfjs.GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.min.mjs', lib).href
let doc = null

window.openPdf = async (url) => {
  doc?.destroy()
  doc = await pdfjs.getDocument({ url, cMapUrl: new URL('cmaps/', lib).href, cMapPacked: true, standardFontDataUrl: new URL('standard_fonts/', lib).href, wasmUrl: new URL('wasm/', lib).href, iccUrl: new URL('iccs/', lib).href, isEvalSupported: false }).promise
  return doc.numPages
}

// 按宽度 width 渲染成 JPEG（data URL），文字按阅读顺序拼起来、行内空白合并
window.renderPage = async (n, width = 1280) => {
  const page = await doc.getPage(n)
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: width / base.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport }).promise
  const content = await page.getTextContent()
  const text = content.items
    .map((x) => (x.str ?? '') + (x.hasEOL ? '\n' : ''))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  page.cleanup()
  return { text, lines: textLines(content.items, viewport), width: canvas.width, height: canvas.height, jpeg: canvas.toDataURL('image/jpeg', 0.82) }
}

// 这一页的文字按行拼起来，带每行在渲染图上的位置 [x, y, w, h]（像素）：笔记的图文版在课件页上框出老师讲的那一行。
// 同一基线、挨得近的文字块算一行；hasEOL 处断行；竖排、斜排的字（坐标轴标签）各自算一行，框按文字的四个角算。
function textLines(items, viewport) {
  const lines = []
  let cur = null
  for (const x of items) {
    const s = x.str ?? ''
    if (s.trim()) {
      const m = pdfjs.Util.transform(viewport.transform, x.transform)
      const h = Math.hypot(m[2], m[3])
      const w = x.width * viewport.scale
      const ux = m[0] / Math.hypot(m[0], m[1])
      const uy = m[1] / Math.hypot(m[0], m[1])
      const vx = m[2] / h
      const vy = m[3] / h
      // 基线起点、沿字的方向 w、往上 h、往下留 0.25h 给 p、g 的下伸部分
      const xs = []
      const ys = []
      for (const [a, c] of [[0, -0.25], [1, -0.25], [0, 1], [1, 1]]) {
        xs.push(m[4] + ux * w * a + vx * h * c)
        ys.push(m[5] + uy * w * a + vy * h * c)
      }
      const box = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) }
      const flat = Math.abs(uy) < 0.1 && ux > 0
      const base = m[5]
      if (flat && cur?.flat && Math.abs(base - cur.base) < h * 0.5 && box.left - cur.right < h * 2.5 && box.left > cur.left - h) {
        cur.t += box.left - cur.right > h * 0.15 && !/\s$/.test(cur.t) && !/^\s/.test(s) ? ` ${s}` : s
        cur.right = Math.max(cur.right, box.right)
        cur.top = Math.min(cur.top, box.top)
        cur.bottom = Math.max(cur.bottom, box.bottom)
      } else {
        cur = { t: s, base, flat, ...box }
        lines.push(cur)
      }
      if (!flat) cur = null
    }
    if (x.hasEOL) cur = null
  }
  return lines.map((l) => ({ t: l.t.replace(/\s+/g, ' ').trim(), b: [l.left, l.top, l.right - l.left, l.bottom - l.top].map(Math.round) }))
}
