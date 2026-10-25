// 能选的语言：对方说的（识别用）和翻译成的。界面上的同一份清单在 renderer/shared/langs.js。
// 本地识别（X-ASR）和豆包流式识别只认中文和英文（2026-10 实测豆包指定 de-DE 也认不出德语），其他语言要用 OpenAI 识别。

export const LANG_NAMES = { zh: '中文', en: '英语', de: '德语', fr: '法语', es: '西班牙语', it: '意大利语', pt: '葡萄牙语', ru: '俄语', ja: '日语', ko: '韩语' }
export const LANG_CODES = Object.keys(LANG_NAMES)
export const SOURCE_LANGS = [...LANG_CODES, 'auto'] // auto：中英混着说
// 能翻成的：对方的语言之外多一个繁体中文（只做翻译目标，识别还是按「中文」认）
export const TARGET_CODES = [...LANG_CODES, 'zh-Hant']
export const isChinese = (code) => code === 'zh' || code === 'zh-Hant'

// 写进 prompt 的名字（带上原名，模型不会弄错是哪种语言）
const PROMPT_NAMES = { zh: '简体中文', 'zh-Hant': '繁体中文（繁體字，台湾、香港的用词）', en: '英语（English）', de: '德语（Deutsch）', fr: '法语（Français）', es: '西班牙语（Español）', it: '意大利语（Italiano）', pt: '葡萄牙语（Português）', ru: '俄语（Русский）', ja: '日语（日本語）', ko: '韩语（한국어）' }
export const promptLang = (code) => PROMPT_NAMES[code] ?? PROMPT_NAMES.zh

/** 只有 OpenAI 识别能认的语言（中英文和自动以外的）。 */
export const needsMultilingual = (lang) => !['zh', 'en', 'auto'].includes(lang)

// 拉丁字母的几种语言各自最常见的虚词：数一句里各有几个，最多的那种就是（一个都没有返回 null）
const STOP = {
  en: 'the a an and or but is are was were be to of in on at for with that this it you we they i not do does have has what',
  de: 'der die das und oder aber ist sind war nicht ein eine einen ich du wir sie es mit für auf zu von den dem des auch wie was hat haben wird',
  fr: 'le la les et ou mais est sont un une des je tu nous vous il elle pas pour avec dans sur que qui ce cette du au',
  es: 'el la los las y o pero es son un una unos yo tú nosotros no para con en que qué del al por lo este esta',
  it: 'il lo la gli le e o ma è sono un una io tu noi non per con che di da del della nel questo questa',
  pt: 'o a os as e ou mas é são um uma eu tu nós não para com em que do da no na por este esta',
}
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]))

/** 粗判一句话是哪种语言：韩文、假名、汉字、西里尔字母看字符，拉丁字母数虚词；判不出返回 null。 */
export function detectLang(text) {
  const t = String(text ?? '')
  const letters = t.replace(/[\s\p{P}\p{N}]/gu, '').length || 1
  const share = (re) => (t.match(re) ?? []).length / letters
  if (share(/[가-힯]/g) > 0.3) return 'ko'
  if (share(/[぀-ヿ]/g) > 0.1) return 'ja'
  if (share(/[一-鿿]/g) > 0.3) return 'zh'
  if (share(/[Ѐ-ӿ]/g) > 0.3) return 'ru'
  const words = t.toLowerCase().match(/\p{L}+/gu) ?? []
  let best = null
  let top = 0
  let tie = false
  for (const [lang, set] of Object.entries(STOP_SETS)) {
    const n = words.filter((w) => set.has(w)).length
    if (n > top) [best, top, tie] = [lang, n, false]
    else if (n === top && n > 0) tie = true
  }
  return top && !tie ? best : null
}

/** 这句要不要翻：判出来的语言（判不出就按项目设的对方语言，自动识别当英语）和要翻成的不一样就翻。 */
export function needsTranslation(text, source, target) {
  const lang = detectLang(text) ?? (source === 'auto' || !source ? 'en' : source)
  return lang !== (target === 'zh-Hant' ? 'zh' : target)
}
