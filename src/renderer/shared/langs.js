'use strict'
// 能选的语言（和主进程 src/main/languages.js 同一份，单测核对）：对方说的、翻译成的。Soniox 实时识别支持的 60 种，常用的十种排前面。
// 本地识别和豆包只认中英文，其他语言要用 Soniox 或 OpenAI 识别（会员的云识别是 Soniox）。语言名按界面语言用 Intl.DisplayNames 取。
window.LANG_CODES = [
  ...['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt', 'ru'],
  ...'af sq ar az eu be bn bs bg ca hr cs da nl et fi gl el gu he hi hu id kn kk lv lt mk ms ml mr no fa pl pa ro sr sk sl sw sv tl ta te th tr uk ur vi cy'.split(' '),
]
;(function () {
  const names = new Intl.DisplayNames([window.UI_LANG || 'zh-Hans'], { type: 'language' })
  const name = (code) => (code === 'zh' ? '中文' : names.of(code))
  window.LANGS = window.LANG_CODES.map((value) => ({ value, label: name(value) }))
  window.SOURCE_LANGS = [...window.LANGS, { value: 'auto', label: '自动识别（中英混说）' }]
  // 翻译成什么：多一个繁体中文（只做翻译目标）
  window.TARGET_LANGS = [...window.LANGS.map((l) => (l.value === 'zh' ? { value: 'zh', label: '简体中文' } : l)), { value: 'zh-Hant', label: '繁体中文' }]
})()
window.langLabel = (code) => [...window.TARGET_LANGS, ...window.SOURCE_LANGS].find((l) => l.value === code)?.label ?? code
window.needsMultilingual = (code) => !['zh', 'en', 'auto'].includes(code)
