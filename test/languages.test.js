import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { detectLang, needsTranslation } from '../src/main/languages.js'
import { splitSentences, splitLong } from '../src/main/text.js'
import { projectSettings } from '../src/main/projects.js'
import { MeetingEngine } from '../src/main/engine.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

test('detectLang tells the common languages apart; unknown short text is null', () => {
  assert.equal(detectLang('Heute sprechen wir über die Entscheidungsbäume und das ist wichtig.'), 'de')
  assert.equal(detectLang('So you should always try to balance the model.'), 'en')
  assert.equal(detectLang('我们今天讲决策树'), 'zh')
  assert.equal(detectLang('Bonjour, je suis le professeur de la classe.'), 'fr')
  assert.equal(detectLang('今日は決定木について話します'), 'ja')
  assert.equal(detectLang('OK.'), null)
})

test('needsTranslation: German class into English, English meeting into Chinese, Chinese into Chinese is skipped', () => {
  assert.equal(needsTranslation('Hat jemand eine Frage?', 'de', 'en'), true)
  assert.equal(needsTranslation('Is that clear to everyone?', 'de', 'en'), false, '德语课上老师说的英语不用再译成英语')
  assert.equal(needsTranslation('OK.', 'de', 'en'), true, '判不出来按项目的对方语言')
  assert.equal(needsTranslation('Please send it by Friday.', 'en', 'zh'), true)
  assert.equal(needsTranslation('请在周五前发给我', 'auto', 'zh'), false)
  assert.equal(needsTranslation('请在周五前发给我', 'zh', 'en'), true)
})

const LONG =
  'so what we really want to do here is take the model and train it on a much bigger dataset and then see whether the validation loss keeps going down or whether it starts to go up again because that would mean we are overfitting'

test('splitSentences cuts a long run-on sentence into pieces before connectors; earlier pieces stay the same as the text grows', () => {
  const a = splitSentences(LONG)
  assert.ok(a.length >= 2)
  assert.ok(a.every((p) => p.split(' ').length <= 30))
  assert.equal(a.join(' '), LONG)
  assert.match(a[1], /^and then /, '从 and then 前面断')
  const b = splitSentences(LONG + ' and we need to add some regularization or stop early')
  assert.equal(b[0], a[0], '往后说话时前面的块不变（译文不重翻）')
  assert.deepEqual(splitSentences('Short one. Another, with a comma, is fine.'), ['Short one.', 'Another, with a comma, is fine.'])
})

test('splitLong prefers commas and never cuts a Chinese word in half', () => {
  const zh = '我们今天主要讲的是机器学习里面的分类问题然后我们会先看一下逻辑回归再看决策树最后讲一下随机森林以及它和梯度提升树之间的区别和联系还有它们各自适合的场景'
  const parts = splitLong(zh)
  assert.equal(parts.join(''), zh)
  assert.ok(parts.every((p) => p.length <= 60))
  assert.ok(!parts.some((p) => p.startsWith('别')))
  const commas = splitLong(Array.from({ length: 6 }, (_, i) => `this is clause number ${i} with a few more words`).join(', '))
  assert.ok(commas.every((p) => /,$/.test(p) || p === commas.at(-1)), '在逗号处断')
})

test('projectSettings: the project chooses what to translate into; empty follows the settings', () => {
  const s = merge(DEFAULTS, { translateTarget: 'zh' })
  assert.equal(projectSettings(s, { language: 'de', target: 'en' }).translateTarget, 'en')
  assert.equal(projectSettings(s, { language: 'de', target: 'en' }).language, 'de')
  assert.equal(projectSettings(s, { language: 'de', target: '' }).translateTarget, 'zh')
  assert.equal(projectSettings(s, { language: 'xx' }).language, s.language)
})

class FakeASR extends EventEmitter {
  sampleRate = 16000
  gated = false
  async connect() {}
  sendAudio() {}
  endTurn() {}
  async close() {}
}

test('a translation that times out is retried once with the plain prompt and shows up', async (t) => {
  const cfg = applyPatch(merge(DEFAULTS, {}), { translate: true, terms: { enabled: true, correct: true }, assist: { enabled: false }, translateTarget: 'en' })
  const settings = Object.assign(new EventEmitter(), { get: () => structuredClone(cfg) })
  const calls = []
  const store = { create: (m) => ({ id: 't', startedAt: Date.now(), segments: [], ...m }), scheduleSave() {}, saveNow() {}, remove: async () => {} }
  const providers = []
  const engine = new MeetingEngine({
    settings,
    store,
    rendererCapture: null,
    llm: async (o) => {
      calls.push(o)
      if (o.json) throw new Error('连不上 chatgpt.com（网络或代理问题）：ETIMEDOUT')
      return 'Does anyone have a question?'
    },
    llmStatus: () => ({ ready: true }),
    createProvider: () => (providers.push(new FakeASR()), providers.at(-1)),
  })
  engine.useFakeSources({ system: true })
  const notices = []
  engine.on('notice', (n) => notices.push(n))
  await engine.start({ project: { id: 'p', language: 'de', target: 'en', context: '', keywords: '', profile: '' } })
  t.after(() => engine.stop())
  providers[0].emit('final', { key: 'a', text: 'Hat jemand eine Frage?' })
  await new Promise((r) => setTimeout(r, 1800))
  assert.equal(calls.length, 2)
  assert.ok(calls[0].json)
  assert.ok(!calls[1].json, '重试只要译文')
  assert.match(calls[1].system, /翻译成英语（English）字幕。发言的原文是德语/)
  const seg = engine.snapshot().segments[0]
  assert.equal(seg.sentences[0].tr, 'Does anyone have a question?')
  assert.ok(!notices.some((n) => n.code === 'enhance'), '重试成功了就不报失败')
})

test('繁体中文只做翻译目标：中文的话不再翻，英文照翻；提示词说繁体，专业术语照样翻成中文', async () => {
  const { needsTranslation, TARGET_CODES, SOURCE_LANGS } = await import('../src/main/languages.js')
  const { enhanceMessages } = await import('../src/main/prompts.js')
  assert.ok(TARGET_CODES.includes('zh-Hant'))
  assert.ok(!SOURCE_LANGS.includes('zh-Hant'))
  assert.equal(needsTranslation('我们下周开会', 'zh', 'zh-Hant'), false)
  assert.equal(needsTranslation('We meet next week.', 'en', 'zh-Hant'), true)
  const text = enhanceMessages({ sentence: 'The ablation drops.', target: 'zh-Hant' }).map((m) => (typeof m === 'string' ? m : m.content ?? '')).join('\n')
  assert.match(text, /繁体中文/)
  assert.match(text, /消融/)
})

test('界面的语言清单（renderer/shared/langs.js）和主进程同一份：Soniox 的 60 种，名字按界面语言取', async () => {
  const fs = await import('node:fs')
  const vm = await import('node:vm')
  const { LANG_CODES, TARGET_CODES, promptLang } = await import('../src/main/languages.js')
  const window = {}
  vm.runInNewContext(fs.readFileSync(new URL('../src/renderer/shared/langs.js', import.meta.url), 'utf8'), { window, Intl, t: (x) => x })
  assert.deepEqual([...window.LANG_CODES], LANG_CODES)
  assert.equal(LANG_CODES.length, 60)
  assert.deepEqual([...window.TARGET_LANGS.map((l) => l.value)], TARGET_CODES)
  assert.equal(window.langLabel('de'), '德语')
  assert.equal(window.langLabel('zh-Hant'), '繁体中文')
  assert.equal(promptLang('ja'), '日语（日本語）')
  const en = {}
  vm.runInNewContext(fs.readFileSync(new URL('../src/renderer/shared/langs.js', import.meta.url), 'utf8'), { window: Object.assign(en, { UI_LANG: 'en' }), Intl, t: (x) => x })
  assert.equal(en.langLabel('de'), 'German')
})

test('AI 写给用户看的东西跟这一场「翻译成」的语言：纪要、课堂笔记、实时笔记、待办、术语解释', async () => {
  const { summaryMessages, enhanceMessages } = await import('../src/main/prompts.js')
  const { classNotesMessages, notesMessages, classTodoMessages } = await import('../src/main/class/prompts.js')
  const { todoMessages } = await import('../src/main/todos.js')
  const { writeLang } = await import('../src/main/languages.js')
  const de = { startedAt: Date.now(), segments: [], target: 'de' }
  const old = { startedAt: Date.now(), segments: [] }
  assert.equal(writeLang(old), 'zh', '旧记录没记 target：照旧简体中文')
  assert.equal(writeLang(old, { target: 'fr' }), 'fr')
  const sum = summaryMessages({ session: de })[0].content
  assert.match(sum, /请用德语（Deutsch）写会议纪要/)
  assert.match(sum, /小节标题、表头.*都换成德语/)
  assert.match(sum, /截止日期照样写成 YYYY-MM-DD/)
  assert.doesNotMatch(summaryMessages({ session: old })[0].content, /都换成/, '简体中文照旧，不加规则')
  assert.match(summaryMessages({ session: { ...de, target: 'zh-Hant' } })[0].content, /都换成繁体中文/)
  assert.match(classNotesMessages({ session: de })[0].content, /请用德语（Deutsch）写一份课堂笔记/)
  assert.match(classTodoMessages({ session: de, summary: '' })[0].content, /text：一句德语（Deutsch）/)
  assert.match(todoMessages({ session: de, summary: '', project: null, projects: [] })[0].content, /德语（Deutsch）标题/)
  const live = notesMessages({ lines: [], lang: 'ja' })[0].content
  assert.match(live, /用日语（日本語）写/)
  assert.match(live, /日语（日本語）译名、一句日语（日本語）解释/)
  assert.match(enhanceMessages({ sentence: 'x', target: 'ko' })[0].content, /explain 是一句韩语（한국어）/)
})

test('纪要里的截止认任何语言的截止词：德语、日语、英语写的纪要也能提出待办的日期', async () => {
  const { summaryDeadlines } = await import('../src/main/todos.js')
  const md = [
    '- [ ] Folien senden (Fällig: 2026-10-26)  Zitat: „send me the slides before Monday.“ [00:40]',
    '- [ ] スライドを送付する（期限：2026-10-26）  原話："send me the slides" [00:40]',
    '- [ ] Send slides (Due: 2026-10-26)',
    '- [ ] 交初稿（截止：2026-10-30）  原话："by next Friday" [00:00]',
    '- [ ] Ablation erneut ausführen (Fällig: keine Angabe)',
    '- [ ] Notiz (Quelle: Protokoll)',
  ].join('\n')
  const got = summaryDeadlines(md)
  assert.deepEqual(got.map((x) => x.due), ['2026-10-26', '2026-10-26', '2026-10-26', '2026-10-30'])
  assert.equal(got[0].text, 'Folien senden')
  assert.equal(got[0].quote, 'send me the slides before Monday.')
})
