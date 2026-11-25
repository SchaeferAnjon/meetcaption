// 测试模式（E2E=1 或 MEETCAPTION_E2E=1）：应用照常跑，但不占用户的屏幕，给 Playwright 从后台驱动（点按、打字、截图都走 CDP）。
// 窗口从不显示（show、showInactive、focus 都不真做），全透明、鼠标穿透，被系统挪回屏幕就再挪出去；程序坞不出图标；
// 不建菜单栏图标、不注册全局快捷键、启动时不要麦克风和录屏权限（这几处在 main.js 里看 E2E）；
// 浏览器、访达、打开 / 存储面板、提示框、右键菜单、系统通知都不真做，只记下来（globalThis.mcScreen），测试要用哪个就在 app.evaluate 里自己换掉。
// 也不碰用户的数据：设置、声纹、会员令牌和会议库（默认「文稿/会议字幕」）都在临时目录，会员不连线上服务器。
// 这个模块要在 main.js 里排在会员客户端前面导入：下面的环境变量得在 member/client.js 读 MEETCAPTION_API 之前定好。
import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const E2E = process.env.E2E === '1' || process.env.MEETCAPTION_E2E === '1'

if (E2E) {
  process.env.MEETCAPTION_USERDATA ||= fs.mkdtempSync(path.join(os.tmpdir(), 'meetcaption-e2e-'))
  app.setPath('documents', path.join(process.env.MEETCAPTION_USERDATA, 'documents'))
  // 会员（登记电脑、扣场次、结账）：没指定后台就连本机一个没人听的端口，马上失败
  process.env.MEETCAPTION_API ||= 'http://127.0.0.1:9'
  // 网页里的 getUserMedia 用 Chromium 的假设备，不碰真麦克风、不弹授权框
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}

export function guardScreen() {
  if (!E2E) return
  // 已有的开关：不发系统通知；界面里的外链只打印「[openExternal] 网址」（测试从标准输出看点到了哪个）
  process.env.MEETCAPTION_NO_NOTIFY = '1'
  process.env.MEETCAPTION_NO_EXTERNAL = '1'
  globalThis.mcScreen = []
  const skip = (what) => {
    globalThis.mcScreen.push(what)
    console.log(`[测试模式] 没真的做：${what}`)
  }
  // 放在屏幕外还不够（macOS 会把整个在屏幕外的窗口拉回来），所以全透明、鼠标穿过去，一进屏幕就挪走
  app.on('browser-window-created', (_e, w) => {
    w.setOpacity(0)
    w.setIgnoreMouseEvents(true)
    w.webContents.setBackgroundThrottling(false)
    const park = () => {
      if (w.isDestroyed()) return
      const b = w.getBounds()
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.bounds
        return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
      })
      if (onScreen) w.setPosition(-20000, 80)
    }
    park()
    w.on('move', park)
    w.on('resize', park)
  })
  BrowserWindow.prototype.show = function () {
    skip('显示窗口')
  }
  BrowserWindow.prototype.showInactive = function () {
    skip('显示窗口（不抢焦点）')
  }
  BrowserWindow.prototype.focus = function () {}
  BrowserWindow.prototype.moveTop = function () {}
  app.focus = () => {}
  shell.openExternal = async (url) => skip(`用浏览器打开 ${url}`)
  shell.showItemInFolder = (p) => skip(`在访达中显示 ${p}`)
  shell.openPath = async (p) => (skip(`打开 ${p}`), '')
  dialog.showOpenDialog = async () => (skip('打开面板'), { canceled: true, filePaths: [] })
  dialog.showSaveDialog = async () => (skip('存储面板'), { canceled: true, filePath: '' })
  dialog.showMessageBox = async () => (skip('提示框'), { response: 0, checkboxChecked: false })
  dialog.showErrorBox = (title) => skip(`出错框 ${title}`)
  Menu.prototype.popup = function () {
    skip(`右键菜单（${this.items.map((i) => i.label).filter(Boolean).join('、')}）`)
  }
  app.whenReady().then(() => app.dock?.hide())
}
