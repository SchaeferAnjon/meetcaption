import { test } from 'node:test'
import assert from 'node:assert/strict'
// 界面脚本里的文字都过 t()（shared/i18n.js 在页面里定义）；这里按简体中文原文
globalThis.t = (s, ...a) => a.reduce((o, v, i) => o.split(`{${i}}`).join(String(v)), s)
await import('../src/renderer/shared/bilingual.js')

const { layout, prefs, signature, diffFixes, tipContent, TIP_SELECTOR } = globalThis.bilingual

const joined = (runs) => runs.map((r) => r.text).join('')
const colorOf = (runs, piece) => runs.find((r) => r.text.includes(piece))?.c
const termOf = (runs, piece) => runs.find((r) => r.text === piece)?.t

const SENTENCE = {
  text: 'Could you walk me through why the ablation drops so much on the second dataset?',
  tr: '你能讲讲，在第二个数据集上，为什么消融结果掉这么多吗？',
  chunks: [
    { en: 'Could you walk me through', zh: '你能讲讲' },
    { en: 'why the ablation drops so much', zh: '为什么消融结果掉这么多' },
    { en: 'on the second dataset', zh: '在第二个数据集上' },
  ],
  terms: [{ term: 'ablation', zh: '消融', explain: '去掉模型的某个部分，看效果掉多少' }],
}

test('bilingual: runs rebuild both lines exactly', () => {
  const l = layout(SENTENCE)
  assert.equal(joined(l.en), SENTENCE.text)
  assert.equal(joined(l.zh), SENTENCE.tr)
  assert.equal(l.colored, 3)
})

test('bilingual: an English chunk and its Chinese chunk share one color even when word order differs', () => {
  const l = layout(SENTENCE)
  assert.equal(colorOf(l.en, 'Could you'), 0)
  assert.equal(colorOf(l.zh, '你能讲讲'), 0)
  assert.equal(colorOf(l.en, 'second dataset'), 2)
  assert.equal(colorOf(l.zh, '第二个数据集'), 2)
  // 标点不在任何意群里，用默认颜色
  assert.equal(l.en[l.en.length - 1].text, '?')
  assert.equal(l.en[l.en.length - 1].c, -1)
})

test('bilingual: a term is marked on both sides with the same index, inside its chunk color', () => {
  const l = layout(SENTENCE)
  assert.deepEqual(l.terms, [{ term: 'ablation', zh: '消融', explain: '去掉模型的某个部分，看效果掉多少' }])
  assert.equal(termOf(l.en, 'ablation'), 0)
  assert.equal(termOf(l.zh, '消融'), 0)
  assert.equal(l.en.find((r) => r.text === 'ablation').c, 1)
})

test('bilingual: chunks or terms that cannot be found are dropped, the rest still work', () => {
  const l = layout({
    ...SENTENCE,
    chunks: [...SENTENCE.chunks, { en: 'not in the sentence', zh: '你能讲讲' }, { en: 'Could', zh: '不在译文里' }, { en: '', zh: '' }, null],
    terms: [...SENTENCE.terms, { term: 'transformer', zh: '变换器', explain: 'x' }, { term: 'dataset', zh: '不在译文', explain: '一组数据' }, { term: 'drops' }],
  })
  assert.equal(l.colored, 3)
  assert.deepEqual(
    l.terms.map((t) => [t.term, t.zh]),
    [
      ['ablation', '消融'],
      ['dataset', ''],
    ],
  )
})

test('bilingual: a single matched chunk means no colors; colors off means no colors', () => {
  const one = layout({ ...SENTENCE, chunks: [SENTENCE.chunks[0]] })
  assert.equal(one.colored, 0)
  assert.ok(one.en.every((r) => r.c === -1))
  const off = layout(SENTENCE, { colors: false })
  assert.equal(off.colored, 0)
  assert.equal(termOf(off.en, 'ablation'), 0)
  const noTerms = layout(SENTENCE, { terms: false })
  assert.deepEqual(noTerms.terms, [])
})

test('bilingual: old data (only tr and terms without zh) still renders', () => {
  const l = layout({ text: 'We used Bonferroni correction here.', tr: '这里用了邦费罗尼校正。', terms: [{ term: 'Bonferroni correction', explain: '多重比较时的校正' }] })
  assert.equal(joined(l.en), 'We used Bonferroni correction here.')
  assert.equal(termOf(l.en, 'Bonferroni correction'), 0)
  assert.ok(l.zh.every((r) => r.t === -1 && r.c === -1))
  const bare = layout({ text: 'Okay.' })
  assert.deepEqual(bare.zh, [])
  assert.equal(joined(bare.en), 'Okay.')
  assert.deepEqual(layout(null).en, [])
})

test('bilingual: repeated words go to the next free place in English order', () => {
  const l = layout({
    text: 'the model and the data',
    tr: '模型和数据',
    chunks: [
      { en: 'the model', zh: '模型' },
      { en: 'and the data', zh: '和数据' },
    ],
  })
  assert.equal(colorOf(l.en, 'model'), 0)
  assert.equal(colorOf(l.en, 'data'), 1)
  // 术语要整词：「data」不会标在「dataset」里
  const w = layout({ text: 'dataset and data', terms: [{ term: 'data', explain: '数据' }] })
  assert.equal(termOf(w.en, 'data'), 0)
  assert.equal(w.en[0].text, 'dataset and ')
})

test('bilingual: prefs and signature', () => {
  assert.deepEqual(prefs({}), { colors: true, style: 'text', className: 'bi-text' })
  assert.deepEqual(prefs({ display: { chunkColors: false } }), { colors: false, style: 'text', className: 'bi-mono' })
  assert.equal(prefs({ display: { chunkStyle: 'bar' } }).className, 'bi-bar')
  assert.equal(prefs({ display: { chunkStyle: 'weird' } }).style, 'text')
  assert.notEqual(signature(SENTENCE), signature({ ...SENTENCE, tr: '别的' }))
  assert.notEqual(signature(SENTENCE), signature(SENTENCE, { colors: false }))
})

test('bilingual: a chunk whose Chinese is split in two places colors both places the same', () => {
  const l = layout({
    text: 'Can you explain why the transformer baseline performs worse on the noisy subset?',
    tr: '你能解释一下，为什么 Transformer 基线在噪声子集上的表现更差吗？',
    chunks: [
      { en: 'Can you explain why', zh: '你能解释一下，为什么' },
      { en: 'the transformer baseline performs worse', zh: ['Transformer 基线', '的表现更差'] },
      { en: 'on the noisy subset?', zh: '在噪声子集上' },
    ],
  })
  assert.equal(l.colored, 3)
  assert.equal(colorOf(l.zh, 'Transformer 基线'), 1)
  assert.equal(colorOf(l.zh, '的表现更差'), 1)
  assert.equal(colorOf(l.zh, '在噪声子集上'), 2)
  assert.equal(joined(l.zh), '你能解释一下，为什么 Transformer 基线在噪声子集上的表现更差吗？')
  // 数组里有一段找不到：整块不分色
  const bad = layout({ text: 'a b c', tr: '甲乙丙', chunks: [{ en: 'a', zh: '甲' }, { en: 'b c', zh: ['乙', '丁'] }] })
  assert.equal(bad.colored, 0)
})

test('bilingual: a term kept in English in the translation is only marked on the English side, tip title is just the term', () => {
  const l = layout({ text: 'Look at the noisy subset first.', tr: '先看 noisy subset。', terms: [{ term: 'noisy subset', zh: 'noisy subset', explain: '噪声较多的子数据集' }] })
  assert.deepEqual(l.terms, [{ term: 'noisy subset', zh: '', explain: '噪声较多的子数据集' }])
  assert.equal(termOf(l.en, 'noisy subset'), 0)
  assert.ok(l.zh.every((r) => r.t === -1))
})

// 以前 overlay/terms.js 的术语匹配规则，现在由 bilingual.locate 负责
const termAt = (text, terms) => layout({ text, terms: terms.map((t) => ({ explain: 'x', ...t })) }, { colors: false }).en.filter((r) => r.t >= 0).map((r) => [r.text, text.indexOf(r.text)])

test('bilingual terms: whole words first, exact case first, longer terms win, Chinese needs no word boundary', () => {
  assert.deepEqual(termAt('We compare LoRA with QLoRA and LoRAs.', [{ term: 'LoRA' }]), [['LoRA', 11]])
  assert.deepEqual(termAt('elbo first, then ELBO again', [{ term: 'ELBO' }]).map((x) => x[0]), ['ELBO'])
  assert.deepEqual(termAt('the Glue benchmark', [{ term: 'GLUE' }]), [['Glue', 4]])
  assert.deepEqual(termAt('Use KL divergence here.', [{ term: 'KL' }, { term: 'KL divergence' }]), [['KL divergence', 4]])
  assert.deepEqual(termAt('p-values matter', [{ term: 'p-values' }]), [['p-values', 0]])
  assert.deepEqual(termAt('我们用变分推断来做', [{ term: '变分推断' }]), [['变分推断', 3]])
  assert.deepEqual(termAt('abc', [{ term: '' }]), [])
  assert.deepEqual(layout({ text: '', terms: [{ term: 'a', explain: 'x' }] }).en, [])
})

/* ---------------- AI 纠正过的词 ---------------- */

const FIXED_SENTENCE = {
  text: 'We ran an ablation study with the Bonferroni correction on the WebVision dataset.',
  orig: 'We ran a blation study with the Bonferoni correction on the web vision data set.',
  tr: '我们在 WebVision 数据集上用 Bonferroni 校正做了消融实验。',
  chunks: [
    { en: 'We ran an ablation study', zh: '做了消融实验' },
    { en: 'with the Bonferroni correction', zh: '用 Bonferroni 校正' },
    { en: 'on the WebVision dataset.', zh: '在 WebVision 数据集上' },
  ],
  terms: [{ term: 'Bonferroni correction', zh: 'Bonferroni 校正', explain: '多重比较时的校正' }],
}
const fixOf = (runs, piece) => runs.find((r) => r.text.includes(piece))?.f

test('bilingual: words the AI corrected are marked with their recognised text, colors and terms still work', () => {
  const l = layout(FIXED_SENTENCE)
  assert.equal(joined(l.en), FIXED_SENTENCE.text)
  assert.deepEqual(l.fixes, [
    { text: 'an ablation', orig: 'a blation' },
    { text: 'Bonferroni', orig: 'Bonferoni' },
    { text: 'WebVision dataset', orig: 'web vision data set' },
  ])
  assert.equal(fixOf(l.en, 'ablation'), 0)
  assert.equal(fixOf(l.en, 'WebVision'), 2)
  assert.equal(fixOf(l.en, 'study'), -1)
  assert.equal(l.colored, 3)
  assert.equal(colorOf(l.en, 'WebVision'), 2)
  // 术语里有纠正过的词：术语带上识别原文，悬停术语时一起看到
  assert.deepEqual(l.terms, [{ term: 'Bonferroni correction', zh: 'Bonferroni 校正', explain: '多重比较时的校正', orig: 'Bonferoni' }])
  const b = l.en.find((r) => r.text === 'Bonferroni')
  assert.deepEqual([b.t, b.f], [0, 1])
  // 中文那边不标纠正
  assert.ok(l.zh.every((r) => r.f === -1))
  // 关掉、没有 orig、orig 和 text 一样：都不标
  assert.deepEqual(layout(FIXED_SENTENCE, { fixes: false }).fixes, [])
  assert.deepEqual(layout({ ...FIXED_SENTENCE, orig: undefined }).fixes, [])
  assert.deepEqual(layout({ ...FIXED_SENTENCE, orig: FIXED_SENTENCE.text }).fixes, [])
  assert.notEqual(signature(FIXED_SENTENCE), signature({ ...FIXED_SENTENCE, orig: undefined }))
})

test('bilingual: diffFixes handles case changes, added words and removed words', () => {
  const pairs = (text, orig) => diffFixes(text, orig).map((r) => [text.slice(r.s, r.e), r.orig])
  assert.deepEqual(pairs('We use LoRA here.', 'We use lora here.'), [['LoRA', 'lora']])
  assert.deepEqual(pairs('We did the Siemens internship.', "We did the Seamen's internship."), [['Siemens', "Seamen's"]])
  assert.deepEqual(pairs('It is an easy fix.', 'It is easy fix.'), [['an', '']]) // 加进来的词：识别原文里没有
  assert.deepEqual(pairs('The model is good.', 'The the model is good.'), [['The', 'The the']]) // 删掉的词挂到前一个词上
  assert.deepEqual(pairs('Model is good.', 'Uh model is good.'), [['Model', 'Uh model']])
  assert.deepEqual(pairs('Same text, new comma.', 'Same text new comma.'), []) // 只动了标点
  assert.deepEqual(diffFixes('', 'x'), [])
})

test('bilingual: tip content for a corrected word and for a term with a corrected word inside', () => {
  const node = (cls, dataset) => ({ dataset, textContent: dataset.title ?? '', classList: { contains: (c) => cls.split(' ').includes(c) } })
  assert.deepEqual(tipContent(node('fix', { title: 'Siemens', orig: "Seamen's" })), { title: 'Siemens', text: "识别原文：Seamen's" })
  assert.deepEqual(tipContent(node('fix', { title: 'an', orig: '' })), { title: 'an', text: '识别原文里没有这个词' })
  assert.deepEqual(tipContent(node('term', { title: 'Bonferroni correction · Bonferroni 校正', explain: '多重比较时的校正', orig: 'Bonferoni' })), {
    title: 'Bonferroni correction · Bonferroni 校正',
    text: '多重比较时的校正（识别原文：Bonferoni）',
  })
  assert.deepEqual(tipContent(node('term', { title: 'ablation', explain: '消融' })), { title: 'ablation', text: '消融' })
  assert.equal(TIP_SELECTOR, '.term, .fix:not(.in-term)')
})
