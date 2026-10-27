import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUiLang, systemUiLang, t, UI_LANGS } from '../src/main/i18n.js'

// 界面语言的表：代码里每个 t('…') 的原文在八张表里都要有译文，占位符 {0} 和 HTML 标签不能丢。
// fileURLToPath：Windows 上 URL 的 pathname 是 /D:/…，拼出来成了 D:\D:\…
const ROOT = fileURLToPath(new URL('..', import.meta.url))
function codeKeys() {
  const keys = new Set()
  const files = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (/\.(js|cjs)$/.test(f.name) && !f.name.includes('styleguide')) files.push(p)
    }
  }
  walk(path.join(ROOT, 'src'))
  for (const f of files) {
    // 注释里举例的 t('…') 不算
    const s = fs.readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')
    // t('…') / t("…") / t(`…`)（模板里的 ${} 已经换成 {0}，这里只认没有 ${ 的）
    for (const m of s.matchAll(/\bt\((['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      if (m[1] === '`' && m[2].includes('${')) continue
      keys.add(Function(`return ${m[1]}${m[2]}${m[1]}`)())
    }
  }
  return keys
}
const marks = (s) => [...(s.match(/\{\d+\}/g) ?? []), ...(s.match(/<\/?[a-z]+[^>]*>/g) ?? [])].sort().join('|')

test('八张界面语言表覆盖代码里所有 t() 的原文，占位符和标签都在', () => {
  const keys = [...codeKeys()].filter((k) => /[一-鿿]/.test(k))
  assert.ok(keys.length > 1000, `只找到 ${keys.length} 条`)
  for (const lang of UI_LANGS.filter((l) => l !== 'zh')) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n', `${lang}.json`), 'utf8'))
    const missing = keys.filter((k) => typeof dict[k] !== 'string')
    assert.deepEqual(missing.slice(0, 10), [], `${lang} 缺 ${missing.length} 条`)
    const broken = keys.filter((k) => marks(k) !== marks(dict[k]))
    assert.deepEqual(broken.slice(0, 10), [], `${lang} 占位符或标签对不上`)
  }
})

test('界面语言：auto 跟系统（简体、繁体、九种以外用英语）；查表、填占位符；查不到用原文', () => {
  assert.equal(systemUiLang('zh-Hans-CN'), 'zh')
  assert.equal(systemUiLang('zh-Hant-TW'), 'zh-Hant')
  assert.equal(systemUiLang('zh-HK'), 'zh-Hant')
  assert.equal(systemUiLang('de-DE'), 'de')
  assert.equal(systemUiLang('pt-BR'), 'en')
  assert.equal(setUiLang('auto', 'ja-JP'), 'ja')
  assert.equal(setUiLang('en', 'ja-JP'), 'en')
  assert.equal(t('还剩 {0} 场，每场最长 {1} 小时{2}', 3, 2, ''), '3 sessions left, up to 2 hours each')
  assert.equal(t('还剩 {0} 场，每场最长 {1} 小时{2}', 1, 1, ''), '1 session left, up to 1 hour each', '单数')
  assert.equal(t('没有这句'), '没有这句')
  setUiLang('zh')
  assert.equal(t('还剩 {0} 场，每场最长 {1} 小时{2}', 3, 2, ''), '还剩 3 场，每场最长 2 小时')
})

test('官网的八张语言表覆盖页面脚本里所有 t() 的原文，占位符、{{名}} 和链接属性都在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'website/index.html'), 'utf8')
  const keys = new Set()
  for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g))
    for (const m of body.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '').matchAll(/\bt\((['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
      if (m[1] === '`' && m[2].includes('${')) continue
      const k = Function(`return ${m[1]}${m[2]}${m[1]}`)()
      if (/[一-鿿]/.test(k)) keys.add(k)
    }
  assert.ok(keys.size > 150, `只找到 ${keys.size} 条`)
  const siteMarks = (s) => [...(s.match(/\{\d+\}/g) ?? []), ...(s.match(/\{\{名\}\}/g) ?? []), ...(s.match(/\s(?:href|data-go|data-dl|data-buy|data-p|data-c|id)="[^"]*"/g) ?? [])].sort().join('|')
  for (const lang of UI_LANGS.filter((l) => l !== 'zh')) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'website/i18n', `${lang}.json`), 'utf8'))
    const missing = [...keys].filter((k) => typeof dict[k] !== 'string')
    assert.deepEqual(missing.slice(0, 5), [], `${lang} 缺 ${missing.length} 条`)
    const broken = [...keys].filter((k) => siteMarks(k) !== siteMarks(dict[k]))
    assert.deepEqual(broken.slice(0, 5), [], `${lang} 占位符或链接对不上`)
  }
})

test('提示里写的「设置 → 某页」，那一页在设置窗口里真的有', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  const pages = [...read('src/renderer/settings/app.js').matchAll(/\{ id: '[a-z]+', label: t\('([^']+)'\)/g)].map((m) => m[1])
  assert.ok(pages.includes('账号与 AI') && pages.length >= 10, pages.join())
  const bad = []
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name)
      if (f.isDirectory()) walk(p)
      else if (/\.(js|cjs)$/.test(f.name) && !f.name.includes('styleguide')) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/(?<!系统)设置 → ([^」）)，。：、`]*)/g)) if (!pages.some((x) => m[1].startsWith(x))) bad.push(`${path.relative(ROOT, p)}: ${m[0]}`)
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  assert.deepEqual(bad, [])
})

test('日语、韩语：声纹、录音语境的「录制」是录音（録音、녹음），不是录像（録画、녹화）；只有屏幕录制、录屏可以用', () => {
  const video = { ja: /録画/, ko: /녹화/ }
  for (const lang of ['ja', 'ko']) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n', `${lang}.json`), 'utf8'))
    const bad = Object.keys(dict).filter((k) => /录制|录像/.test(k) && !/屏幕|录屏|画面/.test(k) && video[lang].test(dict[k]))
    assert.deepEqual(bad, [], `${lang} 把录音写成了录像`)
  }
  setUiLang('ja')
  assert.equal(t('，{0} 录制', '10月26日 22:44'), '、10月26日 22:44 録音')
  setUiLang('ko')
  assert.equal(t('，{0} 录制', '10월 26일 22:44'), ', 10월 26일 22:44 녹음')
  setUiLang('zh')
})

test('设置里 AI 服务卡片的名字和一行介绍（providers.js，渲染时走 t()）在八张表里都有译文', async () => {
  const { PROVIDERS } = await import('../src/main/llm/providers.js')
  const keys = PROVIDERS.filter((p) => !p.hidden).flatMap((p) => [p.name, p.blurb]).filter((s) => /[一-鿿]/.test(s))
  assert.ok(keys.length >= 12, `只找到 ${keys.length} 条`)
  for (const lang of UI_LANGS.filter((l) => l !== 'zh')) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n', `${lang}.json`), 'utf8'))
    const missing = keys.filter((k) => typeof dict[k] !== 'string')
    assert.deepEqual(missing, [], `${lang} 缺 ${missing.length} 条`)
    if (!['zh-Hant', 'ja'].includes(lang)) assert.deepEqual(keys.filter((k) => /[一-鿿]/.test(dict[k])), [], `${lang} 的译文里还有中文`)
  }
})
