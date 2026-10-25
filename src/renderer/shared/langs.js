'use strict'
// 能选的语言（和主进程 src/main/languages.js 同一份，单测核对）：对方说的、翻译成的。Soniox 实时识别支持的 60 种，常用的十种排前面。
// 本地识别和豆包只认中英文，其他语言要用 Soniox 或 OpenAI 识别（会员的云识别是 Soniox）。
// 每种语言用它自己的写法显示（Deutsch、日本語，偏好「语言列表可搜索用母语」），右边灰字是界面语言里的叫法；搜索认这两种、英文名和代码。
window.LANG_CODES = [
  ...['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt', 'ru'],
  ...'af sq ar az eu be bn bs bg ca hr cs da nl et fi gl el gu he hi hu id kn kk lv lt mk ms ml mr no fa pl pa ro sr sk sl sw sv tl ta te th tr uk ur vi cy'.split(' '),
]
;(function () {
  const local = new Intl.DisplayNames([window.UI_LANG || 'zh-Hans'], { type: 'language' })
  const english = new Intl.DisplayNames(['en'], { type: 'language' })
  // 每种语言自己的写法，手写一份：浏览器和精简过的 ICU 缺一些语言的自称（Shqip、Euskara、Cymraeg 会变成英文名）
  const NATIVE = { en: 'English', zh: '中文', ja: '日本語', ko: '한국어', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', pt: 'Português', ru: 'Русский', af: 'Afrikaans', sq: 'Shqip', ar: 'العربية', az: 'Azərbaycan', eu: 'Euskara', be: 'Беларуская', bn: 'বাংলা', bs: 'Bosanski', bg: 'Български', ca: 'Català', hr: 'Hrvatski', cs: 'Čeština', da: 'Dansk', nl: 'Nederlands', et: 'Eesti', fi: 'Suomi', gl: 'Galego', el: 'Ελληνικά', gu: 'ગુજરાતી', he: 'עברית', hi: 'हिन्दी', hu: 'Magyar', id: 'Bahasa Indonesia', kn: 'ಕನ್ನಡ', kk: 'Қазақ тілі', lv: 'Latviešu', lt: 'Lietuvių', mk: 'Македонски', ms: 'Bahasa Melayu', ml: 'മലയാളം', mr: 'मराठी', no: 'Norsk', fa: 'فارسی', pl: 'Polski', pa: 'ਪੰਜਾਬੀ', ro: 'Română', sr: 'Српски', sk: 'Slovenčina', sl: 'Slovenščina', sw: 'Kiswahili', sv: 'Svenska', tl: 'Filipino', ta: 'தமிழ்', te: 'తెలుగు', th: 'ไทย', tr: 'Türkçe', uk: 'Українська', ur: 'اردو', vi: 'Tiếng Việt', cy: 'Cymraeg', 'zh-Hant': '繁體中文' }
  const nativeName = (code) => NATIVE[code] ?? local.of(code)
  const localName = (code) => (code === 'zh' ? t('中文') : code === 'zh-Hant' ? t('繁体中文') : local.of(code))
  const entry = (value, label = nativeName(value), here = localName(value)) => ({
    value,
    label,
    local: here,
    hint: here !== label ? here : undefined,
    keywords: [here, english.of(value), value],
  })
  window.LANGS = window.LANG_CODES.map((value) => entry(value))
  window.SOURCE_LANGS = [...window.LANGS, { value: 'auto', label: t('自动识别（中英混说）'), keywords: ['auto'] }]
  // 翻译成什么：中文分简体、繁体（繁体只做翻译目标）
  window.TARGET_LANGS = [...window.LANGS.map((l) => (l.value === 'zh' ? entry('zh', '简体中文', t('简体中文')) : l)), entry('zh-Hant')]
})()
window.langLabel = (code) => [...window.TARGET_LANGS, ...window.SOURCE_LANGS].find((l) => l.value === code)?.label ?? code
window.needsMultilingual = (code) => !['zh', 'en', 'auto'].includes(code)
