'use strict'
// 匿名使用统计的询问（文案用户 2026-10-27 定的）：首次引导里的那一步和主窗口的弹窗共用这段正文。
// 两个按钮「同意」「不用了」一样大、一样的样式，都不预先选中；点了走 app.setUsageConsent(true | false)。
window.consentCopy = () => ({ title: t('帮我们知道有多少人在用会议字幕？'), agree: t('同意'), decline: t('不用了') })

window.consentBody = () =>
  ui.el(
    'div.consent',
    { dataset: { part: '匿名使用统计' } },
    ui.el('p', { text: t('我们会给前 100 位用户免费额度，所以需要统计有多少人在用。统计是匿名的。') }),
    ui.el('p', { text: t('同意后，会议字幕每天会发给我们一次：') }),
    ui.el(
      'ul.consent-list',
      {},
      [t('一个随机编号：只用来数人数，是第一次发送时随机生成的，跟你的名字、邮箱和电脑硬件都没有关系'), t('版本号，用的是 Mac 还是 Windows、什么芯片'), t('用会员还是自带 Key，界面是什么语言')].map((s) => ui.el('li', { text: s })),
    ),
    ui.el('p', { text: t('不会发会议内容、字幕、笔记、录音、截图和你的 Key，也不记你的 IP 地址。') }),
    ui.el('p', { text: t('不同意也能用全部功能。以后随时可以在 设置 → 通用 → 匿名使用统计 里改。') }),
  )
