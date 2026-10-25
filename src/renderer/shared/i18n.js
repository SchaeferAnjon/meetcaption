'use strict'
// 界面语言：preload 启动时同步向主进程要来 window.I18N = { lang, dict }（dict 以简体中文原文为键，src/i18n/<语言>.json）。
// t('还剩 {0} 场', n)：查不到就用原文；{0} {1} 换成后面的参数。页面里写死在 HTML 的文字（标题、按钮、title / placeholder / aria-label）
// 也在这里按同一张表换掉，所以每个页面第一个加载这个文件。
;(function () {
  const I = window.I18N ?? { lang: 'zh', dict: {} }
  window.UI_LANG = I.lang
  // 日期、星期按界面语言排（简体中文还是「10月25日」「周日」）
  window.UI_LOCALE = { zh: 'zh-CN', 'zh-Hant': 'zh-TW' }[I.lang] ?? I.lang
  window.fmtDate = (ms, opts) => new Intl.DateTimeFormat(window.UI_LOCALE, opts).format(ms)
  // {0|session|sessions}：按第 0 个参数选单复数（法语 0 和 1 都用单数）
  const one = (n) => (I.lang === 'fr' ? Math.abs(Number(n)) < 2 : Number(n) === 1)
  window.t = (s, ...args) => {
    let out = I.dict[s] ?? s
    out = out.replace(/\{(\d+)\|([^|}]*)\|([^}]*)\}/g, (_, i, a, b) => (one(args[i]) ? a : b))
    for (let i = 0; i < args.length; i++) out = out.split(`{${i}}`).join(String(args[i]))
    return out
  }
  if (I.lang === 'zh') return
  document.documentElement.lang = I.lang
  const ATTRS = ['title', 'placeholder', 'aria-label']
  const swap = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.nodeValue.trim()
      if (s && I.dict[s]) n.nodeValue = n.nodeValue.replace(s, I.dict[s])
    }
    for (const el of root.querySelectorAll('[title],[placeholder],[aria-label]'))
      for (const a of ATTRS) {
        const v = el.getAttribute(a)
        if (v && I.dict[v]) el.setAttribute(a, I.dict[v])
      }
  }
  document.title = window.t(document.title)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => swap(document.body))
  else swap(document.body)
})()
