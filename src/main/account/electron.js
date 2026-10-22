// 账号登录和 Electron 的接线：深链入口、协议登记、IPC、「没登录不能开始记录」。main.js 只调这里的几个函数。
import { app, ipcMain, safeStorage, shell } from 'electron'
import path from 'node:path'
import { AccountAuth } from './auth.js'
import { SCHEME } from './config.js'
import { findDeepLink } from './deeplink.js'

/**
 * 深链入口，要在 app ready 之前调用：Mac 上被 meetcaption:// 拉起时 open-url 比 ready 先到。
 * Mac 从 open-url 来，Windows 从 second-instance 的 argv（冷启动是 process.argv）来。处理函数接上之前收到的先排队。
 */
export function listenDeepLinks() {
  const queue = []
  let handler = null
  const push = (url) => {
    if (!url) return
    if (handler) handler(url)
    else queue.push(url)
  }
  app.on('open-url', (e, url) => {
    e.preventDefault()
    push(url)
  })
  return {
    /** Windows：从命令行参数里找 meetcaption:// 开头的那个 */
    fromArgv: (argv) => push(findDeepLink(argv)),
    attach(fn) {
      handler = fn
      for (const url of queue.splice(0)) fn(url)
    },
  }
}

/**
 * 打包版把 meetcaption:// 登记给自己：Mac 靠 electron-builder protocols 写进 Info.plist 的 CFBundleURLTypes，
 * 这里再设成默认处理程序；Windows 的安装包不写协议，靠这里写 HKCU\Software\Classes\meetcaption。
 * 开发版不登记（Electron.app 的 Info.plist 里没有这个协议，走本机回环）。
 */
export function registerProtocol() {
  if (!app.isPackaged) return false
  try {
    return app.setAsDefaultProtocolClient(SCHEME)
  } catch {
    return false
  }
}

/** 回调方式：打包版深链，开发版本机回环；MEETCAPTION_AUTH_CALLBACK=deeplink|loopback 可以强制。 */
export function callbackMode() {
  const forced = process.env.MEETCAPTION_AUTH_CALLBACK
  if (forced === 'loopback' || forced === 'deeplink') return forced
  return app.isPackaged ? 'deeplink' : 'loopback'
}

/** 测试开关 MEETCAPTION_ACCOUNT_TEST=1：点登录不开浏览器（链接在 status().loginUrl），登录进行中也认管理接口生成的登录链接（#access_token=…）。 */
export const accountTestMode = () => process.env.MEETCAPTION_ACCOUNT_TEST === '1'

/** 开发版自动化测试跳过「没登录不能开始记录」：MEETCAPTION_SKIP_LOGIN=1，打包版无效。 */
export const loginBypassed = () => !app.isPackaged && process.env.MEETCAPTION_SKIP_LOGIN === '1'

export function createAccount() {
  const account = new AccountAuth({
    file: path.join(app.getPath('userData'), 'account.json'),
    safeStorage,
    callback: callbackMode(),
    allowTokenCallback: accountTestMode(),
  })
  return account.start()
}

/**
 * IPC：account:status / login / logout / cancelLogin，状态变了发 'account:status'。
 * login 成功 resolve 新状态；失败也 resolve 状态，另带 error 和 code（login-cancelled | login-timeout | login-failed）。
 */
export function wireAccountIpc(account, { toUi, onStatus } = {}) {
  ipcMain.handle('account:status', () => account.status())
  ipcMain.handle('account:login', async () => {
    try {
      return await account.login({ openExternal: accountTestMode() ? null : (url) => shell.openExternal(url) })
    } catch (e) {
      return { ...account.status(), error: e.message, code: e.code }
    }
  })
  ipcMain.handle('account:logout', () => account.logout())
  ipcMain.handle('account:cancelLogin', () => account.cancelLogin())
  account.on('status', (st) => {
    toUi?.('account:status', st)
    onStatus?.(st)
  })
}

/** 没登录时给 start() 的错误；登录了（或开发版跳过、没配账号平台）返回 null。 */
export function loginRequired(account) {
  const st = account?.status()
  if (loginBypassed() || st?.off || st?.loggedIn) return null
  return { ok: false, code: 'login-required', error: '先登录账号再开始记录：用 Google 账号登录（设置 → 账号与 AI）' }
}
