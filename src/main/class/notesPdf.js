import { BrowserWindow } from 'electron'

// 图文笔记导出成 PDF：在隐藏窗口里按 A4 排（窄版：课件页在上、老师讲的点在下），浅色白底，自测题答案展开，老师原话不放（见 notes-page.html 的 print 样式）。
// 窗口开成 A4 去掉左右边距的宽度，看图器在屏幕上算好的缩放和打出来的一样。
const MARGIN = 0.4 // 英寸
const WIDTH = Math.round((8.27 - MARGIN * 2) * 96)

export async function notesPdf(file) {
  const win = new BrowserWindow({ show: false, width: WIDTH, height: 1000, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  try {
    await win.loadFile(file)
    await win.webContents.executeJavaScript(`(async () => {
      document.documentElement.dataset.theme = 'light'
      for (const img of document.images) img.loading = 'eager'
      await Promise.all([...document.images].map((img) => img.decode().catch(() => {})))
      await document.fonts.ready
      dispatchEvent(new Event('resize'))
      await new Promise((r) => setTimeout(r, 300))
    })()`)
    return await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: MARGIN, bottom: 0.55, left: MARGIN, right: MARGIN },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="width:100%;text-align:center;font-size:8px;color:#79716b"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    })
  } finally {
    win.destroy()
  }
}
