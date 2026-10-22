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
