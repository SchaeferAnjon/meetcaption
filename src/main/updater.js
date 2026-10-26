import { EventEmitter } from 'node:events'
import electronUpdater from 'electron-updater'

// 自动更新（electron-updater，查 GitHub Release 的 latest.yml / latest-mac.yml）：启动 30 秒后查一次，之后每 6 小时一次；
// 有新版在后台下载，下好了告诉界面（主窗口提示「重启更新」），用户点了才重启；正在记录时不重启。不点也行，下次退出时自动装上。
// Mac 上新版要和装着的版本用同一张 Developer ID 证书签名，Squirrel.Mac 才肯换（所以 Mac 的发布包要在本机打，见 scripts/release.mjs）。
// 状态 phase：off（这个包不更新）| idle | checking | downloading（percent）| ready（version）| latest | error（error）

const { autoUpdater } = electronUpdater
const FIRST_CHECK_MS = 30_000
const EVERY_MS = 6 * 3600_000

export class Updater extends EventEmitter {
  /**
   * supported：这个包能不能更新（正式版打包后才行；开发版、源码运行、自测不更新）；enabled()：设置里的「自动检查更新」；
   * feedUrl：测试用，指向本机的更新服务器（generic provider），不给就用打包时写进去的 GitHub。
   */
  constructor({ supported, enabled, feedUrl = '' }) {
    super()
    this.supported = supported
    this.enabled = enabled
    this.state = { phase: supported ? 'idle' : 'off', version: '', percent: 0, error: '', checkedAt: 0 }
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
    autoUpdater.on('update-downloaded', (info) => this.#set({ phase: 'ready', version: info.version, percent: 100, checkedAt: Date.now() }))
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

  /** 已下载好的新版：退出、装上、重新打开。调用前先确认没在记录。 */
  install() {
    if (this.state.phase !== 'ready') return false
    autoUpdater.quitAndInstall(false, true)
    return true
  }
}
