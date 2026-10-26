import { BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences } from 'electron'
import { t } from './i18n.js'
import { micLabel } from './micLabel.js'

// 在一个隐藏窗口里用 Web Audio 采集：Windows 的系统声音（Chromium 的 WASAPI loopback）和麦克风。
// 页面用 AudioContext 直接按识别需要的采样率重采样，AudioWorklet 攒 100ms 一包 16 位 PCM 发回主进程。

let displayHandlerInstalled = false

function installDisplayMediaHandler() {
  if (displayHandlerInstalled) return
  displayHandlerInstalled = true
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback(sources.length ? { video: sources[0], audio: 'loopback' } : {}))
        .catch(() => callback({}))
    },
    { useSystemPicker: false },
  )
}

export class RendererCapture {
  constructor({ preload, page }) {
    this.preload = preload
    this.page = page
    this.win = null
    this.handlers = null
    this.token = null
    ipcMain.on('capture:pcm', (e, source, data) => {
      if (!this.win || e.sender !== this.win.webContents) return
      this.handlers?.onPcm(source, Buffer.from(data))
    })
    // 音轨断了（拔耳机、蓝牙断开）或系统默认麦克风换了：开会的自己重开（onLost），录声纹和声音测试当出错
    ipcMain.on('capture:lost', (e, source, reason) => {
      if (!this.win || e.sender !== this.win.webContents) return
      const h = this.handlers
      if (h?.onLost) h.onLost(source, reason)
      else if (reason === 'ended') h?.onError(source, '音频流中断了')
    })
  }

  /** 开始采集，返回这次的 token：stop(token) 只停这一次开的，停不到别人（开会、录声纹、声音测试共用这一个对象）。 */
  /** → { token, system?: { label }, mic?: { label, fallback } }；onLost(source, reason) 不给时音轨断了按 onError 报。 */
  async start({ system, mic, sampleRate, micDeviceId, onPcm, onError, onLost }) {
    this.stop()
    const token = (this.token = Symbol('capture'))
    if (system) installDisplayMediaHandler()
    if (mic && process.platform === 'darwin') {
      const ok = await systemPreferences.askForMediaAccess('microphone')
      if (!ok) throw new Error(t('没有麦克风权限：系统设置 → 隐私与安全性 → 麦克风，打开「会议字幕」'))
    }
    // 等授权的时候被停掉了（比如「正在连接」时点了停止）：不再开窗口
    if (this.token !== token) throw new Error(t('音频采集已停止'))
    this.handlers = { onPcm, onError, onLost }
    const win = new BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      webPreferences: { preload: this.preload, backgroundThrottling: false, contextIsolation: true },
    })
    this.win = win
    await win.loadFile(this.page)
    // 带上 userGesture，getDisplayMedia 和 AudioContext 都需要“用户手势”才让用。
    const result = await win.webContents.executeJavaScript(`window.startCapture(${JSON.stringify({ system, mic, sampleRate, micDeviceId })})`, true)
    if (!result?.ok) {
      this.stop(token)
      throw new Error(result?.error || t('音频采集启动失败'))
    }
    if (result.mic) result.mic.label = micLabel(result.mic.label, result.mic.deviceId)
    this.info = result
    return token
  }

  /** 重开 token 那次采集里的一路（patch.micDeviceId 换麦克风）：→ { ok, label, fallback } 或 { ok: false, error }。 */
  async restart(token, source, patch = {}) {
    if (token !== this.token || !this.win || this.win.isDestroyed()) return { ok: false, error: t('音频采集已停止'), stopped: true }
    const r = await this.win.webContents.executeJavaScript(`window.restartSource(${JSON.stringify(source)}, ${JSON.stringify(patch)})`, true)
    if (r?.ok && source === 'mic') r.label = micLabel(r.label, r.deviceId)
    return token === this.token ? r : { ok: false, error: t('音频采集已停止'), stopped: true }
  }

  /** token 不给就停掉现在开着的；给了且不是现在这一次的，什么都不做。 */
  stop(token) {
    if (token != null && token !== this.token) return
    this.token = null
    this.handlers = null
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }
}
