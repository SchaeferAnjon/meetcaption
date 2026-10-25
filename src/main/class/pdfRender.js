import { BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { t } from '../i18n.js'

// 在一个隐藏窗口里用 pdf.js（renderer/pdf）读 PDF：一页一页拿文字、每行文字的位置和 JPEG，交给 onPage(n, total, { text, lines, width, height, jpeg })。
// onPage 返回 false 就不往下读了。
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'renderer', 'pdf', 'index.html')

export async function renderPdf(file, onPage, { width = 1280 } = {}) {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
  try {
    await win.loadFile(PAGE)
    const js = (code) => win.webContents.executeJavaScript(code)
    const total = await js(`openPdf(${JSON.stringify(pathToFileURL(file).href)})`).catch((e) => {
      throw new Error(t(`读不了这份 PDF（{0}）：{1}`, path.basename(file), e.message))
    })
    for (let n = 1; n <= total; n++) {
      const r = await js(`renderPage(${n}, ${width})`)
      const jpeg = Buffer.from(r.jpeg.slice(r.jpeg.indexOf(',') + 1), 'base64')
      if ((await onPage(n, total, { text: r.text, lines: r.lines, width: r.width, height: r.height, jpeg })) === false) break
    }
  } finally {
    win.destroy()
  }
}
