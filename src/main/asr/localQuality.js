import { detectLang } from '../languages.js'

// 本地识别（X-ASR）效果不好的判断。会中提示换云识别或开通会员，一场会最多提示一次（engine.js 管次数，这里只管「算不算差」）。
// 一共三条，先到的那条提示：
//   busy      电脑跟不上（local.js 的 LAG_WARN_SAMPLES：送进去的音频比认完的多 4 秒），不在这里判
//   language  对方说的不是中英文：开始时项目语言就是外语（engine.js 判），或者开会后从识别出的字里看出来（下面的 LANG_*）
//   fragments / corrections  识别质量明显差：下面两个门槛
// 门槛一律「宁可少报」。依据（2026-10 本机 M 系列 Mac 上用 macOS say 合成的语音跑 X-ASR 实测）：
//   - 德语、法语：X-ASR 把音译成拉丁字母（"Goodentak zozamen, poute whistrich…"），detectLang 仍能认出 de / fr；
//     日语被音译成罗马音（"Na sang konijiwa yova Senge…"），detectLang 认成 pt，所以自动识别时只提示「不是中英文」，不报具体语言。
//   - 一段 90 秒的英文连续朗读加白噪声：信噪比 10、0、-5 dB 时认成 7 到 8 段长句（3 个词以内的 0 到 1 段），-10 dB（人耳已听不清）碎成 18 段，
//     其中 3 个词以内的 6 段（33%）。所以「碎片比例」门槛定在 60%：比实测最差的 33% 还高。门槛没有用真实会议校准过，是「宁可少报」的判断。
//   - AI 纠错的门槛没有实测（本机没有 AI Key）：prompts.js 里 AI 的改动本来就限在词数的 35% 以内（FIX_MAX_EDITS），
//     正常的术语、同音字纠正一般只改一两个词；连续 20 句里 70% 都被改、且改动占这些句子词数的 12% 以上，才算识别明显差。

/** 对方一句话定稿后，看最近多少句里有多少是零碎的几个字。 */
export const FRAGMENT_WINDOW = 40 // 至少攒够这么多句才判
export const FRAGMENT_MAX_UNITS = 3 // 一句不超过 3 个词（中文按两个字算一个词，即 6 个字以内）算零碎
export const FRAGMENT_SHARE = 0.6

/** 对方说的是不是中英文：看最近的长句（字母数不少于 LANG_MIN_LETTERS）。 */
export const LANG_WINDOW = 6
export const LANG_MIN_LETTERS = 20
export const LANG_FOREIGN = 4 // 最近 6 个长句里至少 4 句像外语

/** AI 纠错：最近 CORRECT_WINDOW 句（开着纠错、原句不少于 CORRECT_MIN_CHARS 个字符）里的比例。 */
export const CORRECT_WINDOW = 20
export const CORRECT_MIN_CHARS = 8
export const CORRECT_FIXED_SHARE = 0.7
export const CORRECT_EDIT_SHARE = 0.12

const units = (text) => {
  const s = String(text ?? '')
  const han = (s.match(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu) ?? []).length
  const words = (s.replace(/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/gu, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length
  return words + Math.ceil(han / 2)
}

const lettersOf = (text) => String(text ?? '').replace(/[\s\p{P}\p{N}]/gu, '').length

const push = (list, v, max) => {
  list.push(v)
  if (list.length > max) list.shift()
}

export class LocalWeakWatch {
  /** onWeak(reason, detail)：reason 为 language | fragments | corrections。同一个 watch 可能反复触发条件，次数由调用方管。 */
  constructor({ onWeak }) {
    this.onWeak = onWeak
    this.frags = [] // 最近的对方定稿：是不是零碎
    this.langs = [] // 最近的长句：判出来的语言（null 表示判不出）
    this.fixes = [] // 最近的纠错结果 { fixed, edits, words }
  }

  /** 对方一句话定稿（只给对方那一路，不含我自己的）。 */
  final(text) {
    const s = String(text ?? '').trim()
    if (!s) return
    push(this.frags, units(s) <= FRAGMENT_MAX_UNITS, FRAGMENT_WINDOW)
    if (this.frags.length >= FRAGMENT_WINDOW) {
      const share = this.frags.filter(Boolean).length / this.frags.length
      if (share >= FRAGMENT_SHARE) this.onWeak('fragments', { share: Math.round(share * 100) / 100, sentences: this.frags.length })
    }
    if (lettersOf(s) >= LANG_MIN_LETTERS) {
      push(this.langs, detectLang(s), LANG_WINDOW)
      const foreign = this.langs.filter((l) => l && l !== 'zh' && l !== 'en')
      if (this.langs.length >= LANG_WINDOW && foreign.length >= LANG_FOREIGN) this.onWeak('language', { detected: foreign, sentences: this.langs.length })
    }
  }

  /** 开着 AI 纠错的一句回来了。text 是识别原文；fix 是 checkFix(text, 纠正后的句子) 的结果，AI 没改就是 null。 */
  corrected(text, fix) {
    if (String(text ?? '').trim().length < CORRECT_MIN_CHARS) return
    push(this.fixes, { fixed: Boolean(fix?.ok), edits: fix?.ok ? fix.edits : 0, words: fix?.ok ? fix.words : 0 }, CORRECT_WINDOW)
    if (this.fixes.length < CORRECT_WINDOW) return
    const fixed = this.fixes.filter((f) => f.fixed)
    const words = fixed.reduce((n, f) => n + f.words, 0)
    const edits = fixed.reduce((n, f) => n + f.edits, 0)
    const fixedShare = fixed.length / this.fixes.length
    const editShare = words ? edits / words : 0
    if (fixedShare >= CORRECT_FIXED_SHARE && editShare >= CORRECT_EDIT_SHARE) this.onWeak('corrections', { fixedShare: Math.round(fixedShare * 100) / 100, editShare: Math.round(editShare * 100) / 100, sentences: this.fixes.length })
  }
}
