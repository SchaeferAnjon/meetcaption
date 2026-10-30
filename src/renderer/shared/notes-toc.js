/*
 * 图文笔记框架里的目录：收起还是展开。框架里的页面不能自己存东西（沙盒没有 allow-same-origin），所以页面把选择
 * 用消息发过来，主窗口记下，每次把框架放进页面（新建、从别的标签切回来）都把记下的值写在地址里（#toc=rail / #toc=open）带回去。
 * 普通脚本，挂在 window.notesToc（Node 里 import 后在 globalThis.notesToc）；store 是 core.js 的 store(key, value)。
 */
;(function (root) {
  'use strict'

  const KEY = 'notesTocRail'
  const MESSAGE = 'meetcaption-notes-toc'

  /** 框架的地址：基础地址 + 记下的选择 */
  const address = (store, base) => `${base}#toc=${store(KEY) === '1' ? 'rail' : 'open'}`

  /** 页面发来的消息：是目录的选择就记下，返回 true；别的消息不动 */
  function accept(store, data) {
    if (data?.type !== MESSAGE) return false
    store(KEY, data.rail ? '1' : null)
    return true
  }

  root.notesToc = { address, accept }
})(globalThis)
