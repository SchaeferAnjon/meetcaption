// 界面语言：设置里的 uiLang（auto 跟系统）定下来是哪一种，主进程自己的提示（通知、错误）和各窗口都用这一张表。
// 表在 src/i18n/<语言>.json，以简体中文原文为键；简体中文不用表。改了界面语言，各窗口重新加载。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const UI_LANGS = ['zh', 'zh-Hant', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'it']
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'i18n')

let lang = 'zh'
let dict = {}

/** 系统语言（app.getPreferredSystemLanguages() 的第一个，如 zh-Hans-CN、de-DE）→ 九种之一，别的语言用英语。 */
export function systemUiLang(locale = 'en') {
  const l = String(locale).toLowerCase()
  if (l.startsWith('zh')) return /hant|-tw|-hk|-mo/.test(l) ? 'zh-Hant' : 'zh'
  const base = l.split(/[-_]/)[0]
  return UI_LANGS.includes(base) ? base : 'en'
}

export function setUiLang(setting, locale) {
  const next = UI_LANGS.includes(setting) ? setting : systemUiLang(locale)
  lang = next
  dict = next === 'zh' ? {} : JSON.parse(fs.readFileSync(path.join(DIR, `${next}.json`), 'utf8'))
  return lang
}

export const uiLang = () => lang
export const uiDict = () => ({ lang, dict })

const one = (n) => (lang === 'fr' ? Math.abs(Number(n)) < 2 : Number(n) === 1)

/** t('还剩 {0} 场', n)：查不到就用原文。译文里的 {0|session|sessions} 按第 0 个参数选单复数（法语 0 和 1 都用单数）。 */
export function t(s, ...args) {
  let out = dict[s] ?? s
  out = out.replace(/\{(\d+)\|([^|}]*)\|([^}]*)\}/g, (_, i, a, b) => (one(args[i]) ? a : b))
  for (let i = 0; i < args.length; i++) out = out.split(`{${i}}`).join(String(args[i]))
  return out
}
