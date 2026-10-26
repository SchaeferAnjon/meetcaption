import { EventEmitter } from 'node:events'
import electronUpdater from 'electron-updater'

// 自动更新（electron-updater，查 GitHub Release 的 latest.yml / latest-mac.yml）：启动 30 秒后查一次，之后每 6 小时一次；
// 有新版在后台下载，下好了告诉界面（主窗口提示「重启更新」），用户点了才重启；正在记录时不重启。不点也行，下次退出时自动装上。
// Mac 上新版要和装着的版本用同一张 Developer ID 证书签名，Squirrel.Mac 才肯换（所以 Mac 的发布包要在本机打，见 scripts/release.mjs）。
// Mac 上 electron-updater 下完 zip 就报 update-downloaded，这时 Squirrel 还没取包、没验签：等 Electron 自己的 autoUpdater 也报
// update-downloaded（Squirrel 验过签、解好包）才算 ready，验签失败、装不进去（应用在只读位置）就是 error。
// 状态 phase：off（这个包不更新）| idle | checking | downloading（percent）| ready（version）| latest | error（error）；
// inApps：Mac 上是不是从「应用程序」文件夹打开的（别处打开的可能装不上）

const { autoUpdater } = electronUpdater
const FIRST_CHECK_MS = 30_000
const EVERY_MS = 6 * 3600_000

export class Updater extends EventEmitter {
  /**
   * supported：这个包能不能更新（正式版打包后才行；开发版、源码运行、自测不更新）；enabled()：设置里的「自动检查更新」；
   * feedUrl：测试用，指向本机的更新服务器（generic provider），不给就用打包时写进去的 GitHub。
   */
  constructor({ supported, enabled, feedUrl = '', native = null, inApps = true }) {
    super()
    this.supported = supported
    this.enabled = enabled
    this.state = { phase: supported ? 'idle' : 'off', version: '', percent: 0, error: '', checkedAt: 0, inApps }
    this.timer = null
    if (!supported) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = { info: () => {}, warn: (m) => console.warn('[update]', m), error: (m) => console.error('[update]', m), debug: () => {} }
    if (feedUrl) autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
    autoUpdater.on('checking-for-update', () => this.#set({ phase: 'checking', error: '' }))
    autoUpdater.on('update-available', (info) => this.#set({ phase: 'downloading', version: info.version, percent: 0 }))
    autoUpdater.on('update-not-available', () => this.#set({ phase: 'latest', checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (p) => this.#set({ phase: 'downloading', percent: Math.floor(p.percent ?? 0) }))
    // native：Mac 上 Electron 自己的 autoUpdater（Squirrel）；Windows 不用等
    let staged = false
    let pending = null
    native?.on('update-downloaded', () => {
      staged = true
      if (pending) this.#set({ phase: 'ready', ...pending })
    })
    autoUpdater.on('update-downloaded', (info) => {
      const done = { version: info.version, percent: 100, checkedAt: Date.now() }
      if (!native || staged) this.#set({ phase: 'ready', ...done })
      else ((pending = done), this.#set({ phase: 'downloading', ...done }))
    })
    // Windows：electron-updater 在 app.quit() 之前发；Mac 由 Electron 自己的 autoUpdater 发（main.js 也听着）
    autoUpdater.on('before-quit-for-update', () => this.emit('quitting'))
    autoUpdater.on('error', (e) => {
      // 下好以后再出的错（比如又查了一次没网）不盖掉「已下载」
      if (this.state.phase === 'ready') return
      this.#set({ phase: 'error', error: String(e?.message ?? e).split('\n')[0], checkedAt: Date.now() })
    })
  }

  #set(patch) {
    this.state = { ...this.state, ...patch }
    this.emit('state', this.state)
  }

  status() {
    return this.state
  }

  start() {
    if (!this.supported) return
    clearTimeout(this.timer)
    const loop = () => {
      if (this.enabled() && !['checking', 'downloading', 'ready'].includes(this.state.phase)) this.check().catch(() => {})
      this.timer = setTimeout(loop, EVERY_MS)
    }
    this.timer = setTimeout(loop, FIRST_CHECK_MS)
  }

  /** 查一次（设置里的「检查更新」也走这里）；出错时 state 是 error，这里把同样的错误抛出去。 */
  async check() {
    if (!this.supported) return this.state
    if (['checking', 'downloading', 'ready'].includes(this.state.phase)) return this.state
    await autoUpdater.checkForUpdates()
    return this.state
  }

  /** 已下载好的新版：退出、装上、重新打开。调用前先确认没在记录。Windows 静默安装（不弹安装向导），装完自动重开；Mac 不看这两个参数。 */
  install() {
    if (this.state.phase !== 'ready') return false
    autoUpdater.quitAndInstall(true, true)
    return true
  }
}
