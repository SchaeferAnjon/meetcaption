// 能选的语言：对方说的（识别用）和翻译成的。界面上的同一份清单在 renderer/shared/langs.js（单测核对两边一致）。
// 清单是 Soniox 实时识别支持的 60 种（2026-10 官方列表），常用的十种排前面。本地识别（X-ASR）和豆包只认中文和英文
// （2026-10 实测豆包指定 de-DE 也认不出德语），其他语言要用 Soniox 或 OpenAI 识别（会员的云识别是 Soniox）。
// 语言名不手写：按界面语言用 Intl.DisplayNames 取（Node 和 Electron 都带完整的 ICU）。

export const LANG_CODES = [
  ...['en', 'zh', 'ja', 'ko', 'de', 'fr', 'es', 'it', 'pt', 'ru'],
  ...'af sq ar az eu be bn bs bg ca hr cs da nl et fi gl el gu he hi hu id kn kk lv lt mk ms ml mr no fa pl pa ro sr sk sl sw sv tl ta te th tr uk ur vi cy'.split(' '),
]
export const SOURCE_LANGS = [...LANG_CODES, 'auto'] // auto：中英混着说
// 能翻成的：对方的语言之外多一个繁体中文（只做翻译目标，识别还是按「中文」认）
export const TARGET_CODES = [...LANG_CODES, 'zh-Hant']
export const isChinese = (code) => code === 'zh' || code === 'zh-Hant'

const zhNames = new Intl.DisplayNames(['zh-Hans'], { type: 'language' })
/** 中文名（提示语和 prompt 用）：德语、繁体中文 */
export const langName = (code) => (code === 'zh-Hant' ? '繁体中文' : code === 'zh' ? '中文' : zhNames.of(code))
export const LANG_NAMES = Object.fromEntries(LANG_CODES.map((c) => [c, langName(c)]))

// 写进 prompt 的名字（带上原名，模型不会弄错是哪种语言）：德语（Deutsch）
const PROMPT_NAMES = { zh: '简体中文', 'zh-Hant': '繁体中文（繁體字，台湾、香港的用词）', en: '英语（English）' }
export const promptLang = (code) => {
  if (PROMPT_NAMES[code]) return PROMPT_NAMES[code]
  if (!LANG_CODES.includes(code)) return PROMPT_NAMES.zh
  return `${langName(code)}（${new Intl.DisplayNames([code], { type: 'language' }).of(code)}）`
}

/** 本地识别和豆包认不了、要 Soniox 或 OpenAI 的语言（中英文和自动以外的）。 */
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
