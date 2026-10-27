'use strict'
// 主窗口问一次匿名使用统计：老用户（0.6.5 以前装的）更新后第一次打开主窗口时，和引导里没答那一步的人。
// 点了任何一个按钮就记成 yes / no（settings.usageConsent），以后不再问；不能按 Esc 或点外面关掉。没点就退出的，下次打开还问（一直是「没问过」，不发）。
// 刚走完引导要导览的先导览，导览结束（guide.js 的 close）再问；正在记录时不问。正文在 shared/consent.js，和引导那一步共用。

let consentBox = null

function askUsageConsent() {
  if (consentBox || guide || !state.askUsage || state.settings?.usageConsent !== '' || state.engine.state !== 'idle') return
  const c = consentCopy()
  const answer = (agree) => () => call('setUsageConsent', agree)
  consentBox = ui.modal({
    title: c.title,
    body: consentBody(),
    width: 520,
    dismissible: false,
    actions: [
      { label: c.agree, onClick: answer(true) },
      { label: c.decline, onClick: answer(false) },
    ],
    onClose: () => (consentBox = null),
  })
  consentBox.el.classList.add('is-consent')
  // 两个按钮都不预先选中：焦点放在对话框本身，不放在第一个按钮上
  consentBox.el.tabIndex = -1
  consentBox.el.focus({ preventScroll: true })
}

function wireConsent() {
  // 别处（设置窗口、引导）答过了：关掉
  subscribe('settings:changed', (s) => {
    if (consentBox && s?.usageConsent !== '') consentBox.close()
  })
  if (state.settings?.onboarding?.done && !state.settings.onboarding.demo) return
  setTimeout(askUsageConsent, 600)
}
