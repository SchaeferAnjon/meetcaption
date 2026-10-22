import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFix, chunkCoverage, enhanceMessages, translateMessages, fixEdits, noDashes, parseChunks, parseEnhance, streamedHead, streamedTr } from '../src/main/prompts.js'
import { joinFixed } from '../src/main/text.js'

const EMPTY = { tr: '', chunks: [], terms: [] }

test('enhanceMessages: translate on asks for tr, chunks and terms, with context and previous lines', () => {
  const m = enhanceMessages({ sentence: 'We use LoRA here.', previous: ['Hi.', 'So.'], target: 'zh', translate: true, context: 'ML paper meeting', keywords: ['LoRA', 'GLUE'] })
  assert.equal(m.length, 2)
  assert.equal(m[0].role, 'system')
  assert.match(m[0].content, /简体中文/)
  assert.match(m[0].content, /"tr"/)
  assert.match(m[0].content, /"chunks"/)
  assert.match(m[0].content, /"zh"/)
  assert.match(m[0].content, /2 到 5 块/)
  assert.match(m[0].content, /不加解释性扩写/)
  assert.match(m[0].content, /40 个字符/)
  assert.match(m[0].content, /会议背景：ML paper meeting/)
  assert.match(m[0].content, /LoRA、GLUE/)
  assert.equal(m[1].role, 'user')
  assert.match(m[1].content, /上文[\s\S]*Hi\.\nSo\.[\s\S]*这一句：\nWe use LoRA here\./)
})

test('enhanceMessages: translate off asks for terms only; chunks off; class scene; en target; no dashes in prompt', () => {
  const off = enhanceMessages({ sentence: '我们用 LoRA', previous: [], target: 'en', translate: false })
  assert.doesNotMatch(off[0].content, /"tr"/)
  assert.doesNotMatch(off[0].content, /"chunks"/)
  assert.doesNotMatch(off[0].content, /任务一/)
  assert.equal(off[1].content, '这一句：\n我们用 LoRA')
  const noChunks = enhanceMessages({ sentence: 'We use LoRA.', translate: true, chunks: false })
  assert.match(noChunks[0].content, /"tr"/)
  assert.doesNotMatch(noChunks[0].content, /"chunks"/)
  const chunksOnly = enhanceMessages({ sentence: 'We use LoRA.', translate: true, terms: false })
  assert.match(chunksOnly[0].content, /"chunks"/)
  assert.doesNotMatch(chunksOnly[0].content, /"terms"/)
  const cls = enhanceMessages({ sentence: 'The gradient is noisy.', translate: true, context: 'Intro to ML', scene: 'class' })
  assert.match(cls[0].content, /课堂/)
  assert.match(cls[0].content, /课程背景：Intro to ML/)
  const en = enhanceMessages({ sentence: '我们用 LoRA', previous: [], target: 'en', translate: true })
  assert.match(en[0].content, /翻译成英语（English）/)
  // 德语课译成英语：说明原文是德语，听众是德语听力一般
  const de = enhanceMessages({ sentence: 'Hat jemand eine Frage?', target: 'en', source: 'de', translate: true, scene: 'class' })
  assert.match(de[0].content, /翻译成英语（English）字幕/)
  assert.match(de[0].content, /原文是德语（Deutsch）/)
  assert.match(de[0].content, /德语听力一般/)
  assert.doesNotMatch(de[0].content, /通行中文说法/)
  const [tde] = translateMessages({ sentence: 'Hat jemand eine Frage?', previous: [], target: 'en', source: 'de' })
  assert.match(tde.content, /翻译成英语（English）字幕。发言的原文是德语/)
  for (const msg of [...off, ...noChunks, ...chunksOnly, ...cls, ...en]) assert.doesNotMatch(msg.content, /[\u2013\u2014]/)
})

test('parseEnhance: plain JSON', () => {
  const r = parseEnhance('{"tr":"我们在这里用低秩适配。","terms":[{"term":"LoRA","zh":"低秩适配","explain":"低秩适配，一种参数高效微调方法"}]}')
  assert.deepEqual(r, { tr: '我们在这里用低秩适配。', chunks: [], terms: [{ term: 'LoRA', zh: '低秩适配', explain: '低秩适配，一种参数高效微调方法' }] })
})

test('parseEnhance: a term kept in English in the translation has no Chinese side', () => {
  const r = parseEnhance('{"tr":"我们在这里用 LoRA。","terms":[{"term":"LoRA","zh":"LoRA","explain":"低秩适配"},{"term":"noisy subset","zh":"Noisy Subset","explain":"噪声子集"}]}', 'We use LoRA on the noisy subset here.')
  assert.deepEqual(r.terms, [
    { term: 'LoRA', zh: '', explain: '低秩适配' },
    { term: 'noisy subset', zh: '', explain: '噪声子集' },
  ])
})

test('parseEnhance: code fence and extra text around the JSON', () => {
  const fenced = '好的：\n```json\n{"tr": "你好", "terms": []}\n```\n以上。'
  assert.deepEqual(parseEnhance(fenced), { tr: '你好', chunks: [], terms: [] })
  const noisy = 'Here you go: {"tr":"含 {括号} 的译文","terms":[{"term":"ELBO","explain":"证据下界"}]} hope it helps {bad'
  assert.deepEqual(parseEnhance(noisy), { tr: '含 {括号} 的译文', chunks: [], terms: [{ term: 'ELBO', zh: '', explain: '证据下界' }] })
  const unclosedFence = '```json\n{"tr":"x","terms":[]}'
  assert.deepEqual(parseEnhance(unclosedFence), { tr: 'x', chunks: [], terms: [] })
})

test('parseEnhance: invalid input gives empty result', () => {
  for (const bad of ['', 'not json', '{"tr": "x", ', '[1,2]', 'null', null, undefined, 42, '{{{']) assert.deepEqual(parseEnhance(bad), EMPTY)
})

test('parseEnhance: missing or wrong fields are dropped', () => {
  assert.deepEqual(parseEnhance('{"terms":[{"term":"GLUE","explain":"基准"}]}'), { tr: '', chunks: [], terms: [{ term: 'GLUE', zh: '', explain: '基准' }] })
  assert.deepEqual(parseEnhance('{"tr":"只有译文"}'), { tr: '只有译文', chunks: [], terms: [] })
  assert.deepEqual(parseEnhance('{"tr":123,"terms":"LoRA","chunks":"x"}'), EMPTY)
  const r = parseEnhance('{"tr":"t","terms":[null,"x",{"term":"A"},{"explain":"没有术语"},{"term":"  ","explain":"空"},{"term":"B","explain":""},{"term":"\\"KL\\"","explain":"KL 散度"}]}')
  assert.deepEqual(r.terms, [{ term: 'KL', zh: '', explain: 'KL 散度' }])
})

test('parseEnhance: accepts translation/explanation aliases and object-shaped terms', () => {
  assert.deepEqual(parseEnhance('{"translation":"译","terms":[{"term":"ICML","explanation":"机器学习会议"}]}'), { tr: '译', chunks: [], terms: [{ term: 'ICML', zh: '', explain: '机器学习会议' }] })
  assert.deepEqual(parseEnhance('{"tr":"译","terms":{"TMLR":"机器学习期刊"}}'), { tr: '译', chunks: [], terms: [{ term: 'TMLR', zh: '', explain: '机器学习期刊' }] })
})

test('parseEnhance: with sentence keeps only terms that occur, fixes case, dedupes', () => {
  const sentence = 'Did you run the Bonferroni correction on the GLUE results?'
  const raw = JSON.stringify({ tr: '你在 GLUE 结果上做了 Bonferroni 校正吗？', terms: [
    { term: 'bonferroni correction', zh: 'Bonferroni 校正', explain: '多重比较校正' },
    { term: 'GLUE', zh: 'GLUE', explain: '基准' },
    { term: 'glue', explain: '重复' },
    { term: 'LoRA', explain: '句子里没有' },
  ] })
  assert.deepEqual(parseEnhance(raw, sentence).terms, [
    { term: 'Bonferroni correction', zh: 'Bonferroni 校正', explain: '多重比较校正' },
    { term: 'GLUE', zh: '', explain: '基准' }, // 译文里原样是 GLUE：中文那边不再标一次
  ])
})

test('parseEnhance: term zh must be in the translation, otherwise empty', () => {
  const sentence = 'The loss starts to diverge.'
  const r = parseEnhance(JSON.stringify({ tr: 'loss 开始发散。', terms: [
    { term: 'diverge', zh: '发散', explain: '越来越大' },
    { term: 'loss', zh: '损失', explain: '损失函数' },
    { term: 'starts', zh: '「开始」', explain: '去掉引号还能找到' },
  ] }), sentence)
  assert.deepEqual(r.terms, [
    { term: 'diverge', zh: '发散', explain: '越来越大' },
    { term: 'loss', zh: '', explain: '损失函数' },
    { term: 'starts', zh: '开始', explain: '去掉引号还能找到' },
  ])
})

test('parseEnhance: chunks are validated against the sentence and the translation, sorted by English order', () => {
  const sentence = 'If you increase the learning rate too much, the loss will start to diverge, which we saw in the last lab.'
  const tr = '学习率调得太大，loss 就会开始发散，上次实验课我们见过。'
  const raw = JSON.stringify({ tr, chunks: [
    { en: 'which we saw in the last lab.', zh: '上次实验课我们见过。' },
    { en: 'if you increase the learning rate too much', zh: '学习率调得太大，' }, // 大小写和标点不同也认
    { en: 'the loss will start to diverge,', zh: 'loss 就会开始发散' },
    { en: 'we never said this', zh: '上次' }, // 原句里没有：丢掉
    { en: 'the last lab', zh: '不在译文里' }, // 译文里没有：丢掉
    { en: 'which we saw', zh: '学习率调得太大，' }, // zh 和前面的重叠：丢掉
    { zh: '缺 en' },
    'garbage',
  ] })
  const r = parseEnhance(raw, sentence)
  assert.equal(r.tr, tr)
  assert.deepEqual(r.chunks, [
    { en: 'If you increase the learning rate too much', zh: '学习率调得太大，' },
    { en: 'the loss will start to diverge,', zh: 'loss 就会开始发散' },
    { en: 'which we saw in the last lab.', zh: '上次实验课我们见过。' },
  ])
  // 每块都能在原文和译文里找到
  for (const c of r.chunks) {
    assert.ok(sentence.includes(c.en))
    assert.ok(tr.includes(c.zh))
  }
})

test('parseEnhance: repeated Chinese pieces map to different places; no translation means no chunks; dashes cleaned consistently', () => {
  const sentence = 'Train it, then test it.'
  const r = parseEnhance(JSON.stringify({ tr: '训练它，再测试它。', chunks: [{ en: 'Train it,', zh: '它' }, { en: 'then test it.', zh: '它' }] }), sentence)
  assert.deepEqual(r.chunks, [{ en: 'Train it,', zh: '它' }, { en: 'then test it.', zh: '它' }])
  assert.deepEqual(parseEnhance(JSON.stringify({ chunks: [{ en: 'Train it,', zh: '训练' }] }), sentence), EMPTY)
  const d = parseEnhance(JSON.stringify({ tr: '训练它 \u2014 再测试它', chunks: [{ en: 'Train it,', zh: '训练它 \u2014 ' }, { en: 'then test it.', zh: '再测试它' }] }), sentence)
  assert.equal(d.tr, '训练它，再测试它')
  assert.deepEqual(d.chunks, [{ en: 'Train it,', zh: '训练它，' }, { en: 'then test it.', zh: '再测试它' }])
})

test('parseChunks: a Chinese piece split by other words in the translation is kept as several pieces', () => {
  const sentence = 'Can you explain why the transformer baseline performs worse on the noisy subset?'
  const tr = '你能解释一下，为什么 Transformer 基线在噪声子集上的表现更差吗？'
  const r = parseChunks(
    [
      { en: 'Can you explain why', zh: '你能解释一下，为什么' },
      { en: 'the transformer baseline performs worse', zh: 'Transformer 基线的表现更差' }, // 实测模型会这样拼
      { en: 'on the noisy subset?', zh: '在噪声子集上吗？' }, // 最后只剩一个「吗」：不要了
    ],
    sentence,
    tr,
  )
  assert.deepEqual(r, [
    { en: 'Can you explain why', zh: '你能解释一下，为什么' },
    { en: 'the transformer baseline performs worse', zh: ['Transformer 基线', '的表现更差'] },
    { en: 'on the noisy subset?', zh: '在噪声子集上' },
  ])
  assert.equal(chunkCoverage(sentence, r), 1)
  // 模型直接给数组也认；拼不出来的（有一段译文里没有）整块丢掉
  const arr = parseChunks([{ en: 'why the transformer baseline performs worse', zh: ['为什么 Transformer 基线', '表现更差'] }], sentence, tr)
  assert.deepEqual(arr, [{ en: 'why the transformer baseline performs worse', zh: ['为什么 Transformer 基线', '表现更差'] }])
  assert.deepEqual(parseChunks([{ en: 'on the noisy subset?', zh: '在干净的子集上' }], sentence, tr), [])
  // 拆出来的几段和别的块不重叠
  const two = parseChunks([{ en: 'Can you explain why', zh: '你能解释一下，为什么' }, { en: 'why', zh: '为什么表现' }], sentence, tr)
  assert.equal(two.length, 1)
})

test('chunkCoverage: share of the sentence (no spaces, no punctuation) covered by chunks', () => {
  const sentence = 'Please send me the revised table by next Friday.'
  assert.equal(chunkCoverage(sentence, [{ en: 'Please send me' }, { en: 'the revised table' }, { en: 'by next Friday.' }]), 1)
  assert.ok(Math.abs(chunkCoverage(sentence, [{ en: 'by next Friday.' }]) - 12 / 39) < 1e-9)
  assert.equal(chunkCoverage(sentence, []), 0)
  assert.equal(chunkCoverage('', [{ en: 'x' }]), 0)
})

test('enhanceMessages: terms are translated into Chinese, short sentences get 2 chunks, split Chinese pieces come as arrays', () => {
  const [sys] = enhanceMessages({ sentence: 'OK, that makes sense.', target: 'zh', translate: true, terms: true, keywords: ['ablation'] })
  assert.match(sys.content, /有通行中文说法的专业术语要翻成中文/)
  assert.match(sys.content, /至少切 2 块/)
  assert.match(sys.content, /所有 en 连起来就是整句/)
  assert.match(sys.content, /zh 就给数组/)
  assert.match(sys.content, /"zh":\["为什么新模型","收敛更快"\]/)
  assert.match(sys.content, /没有中文说法的，zh 给空字符串/)
  assert.doesNotMatch(sys.content, /术语表（翻译时保留原文）/)
  const [en] = enhanceMessages({ sentence: '我们用低秩适配', target: 'en', translate: true, terms: true })
  assert.doesNotMatch(en.content, /翻成中文/)
})

test('parseChunks: old data and odd shapes', () => {
  assert.deepEqual(parseChunks(null, 'a', 'b'), [])
  assert.deepEqual(parseChunks([{ en: 'a', zh: 'b' }], 'a', ''), [])
  // 没给原句时只查译文
  assert.deepEqual(parseChunks([{ en: 'anything', zh: '译' }], undefined, '译文'), [{ en: 'anything', zh: '译' }])
  // 最多 8 块
  const words = 'one two three four five six seven eight nine ten'
  const many = words.split(' ').map((w, i) => ({ en: w, zh: String(i) }))
  assert.equal(parseChunks(many, words, '0123456789').length, 8)
})

test('parseEnhance: replaces dashes and caps long explanations', () => {
  const r = parseEnhance(JSON.stringify({ tr: '一句话 \u2014 另一句', terms: [
    { term: 'KL', explain: 'KL 散度 \u2014 衡量分布差异' },
    { term: 'X', explain: '衡量两个概率分布之间差异的指标，也叫相对熵，常用于变分推断和知识蒸馏，还有很多别的说法' },
    { term: 'Y', explain: 'Transactions on Machine Learning Research and Other Very Long Names Of Journals' },
  ] }))
  assert.equal(r.tr, '一句话，另一句')
  assert.equal(r.terms[0].explain, 'KL 散度，衡量分布差异')
  assert.equal(r.terms[1].explain, '衡量两个概率分布之间差异的指标，也叫相对熵，常用于变分推断和知识蒸馏')
  assert.ok(r.terms[2].explain.length <= 61 && r.terms[2].explain.endsWith('…'))
})

test('parseEnhance: at most 5 terms', () => {
  const terms = Array.from({ length: 8 }, (_, i) => ({ term: `T${i}`, explain: `解释${i}` }))
  assert.equal(parseEnhance(JSON.stringify({ tr: '', terms })).terms.length, 5)
})

test('noDashes: long model text keeps its whitespace, only dashes become commas', () => {
  assert.equal(noDashes('## 要点\n- 学习率 \u2014 太大就发散\n- 2020\u20132023'), '## 要点\n- 学习率，太大就发散\n- 2020，2023')
  assert.equal(noDashes(null), '')
})

test('streamedTr: the translation at the head of a half-received enhance reply', () => {
  assert.equal(streamedTr(''), '')
  assert.equal(streamedTr('{"tr":"你能讲讲为什'), '') // 还没收全
  assert.equal(streamedTr('{"tr":"你能讲讲为什么消融掉这么多吗？","chunks":[{"en":"Could'), '你能讲讲为什么消融掉这么多吗？')
  assert.equal(streamedTr('```json\n{ "tr" : "他说\\"好\\"。" , "terms"'), '他说"好"。') // 代码块、空格、转义引号
  assert.equal(streamedTr('{"tr":"第一步 \u2014 先清洗","chunks'), '第一步，先清洗') // 破折号换成逗号
  assert.equal(streamedTr('{"chunks":[{"en":"a","zh":"b"}],"tr":"x"'), '') // 译文不在最前面就等整个回复
})

/* ---------------- AI 纠错（fixed） ---------------- */

const FIX_SENTENCE = 'We did the Seamen internship on the web vision data set.'
const FIXED = 'We did the Siemens internship on the WebVision dataset.'
const fixReply = (fixed, extra = {}) =>
  JSON.stringify({
    tr: '我们在 WebVision 数据集上做了西门子实习。',
    fixed,
    chunks: [
      { en: 'We did the Siemens internship', zh: '做了西门子实习' },
      { en: 'on the WebVision dataset.', zh: '在 WebVision 数据集上' },
    ],
    terms: [{ term: 'WebVision', zh: '', explain: '带噪声标签的网络图片数据集' }],
    ...extra,
  })

test('enhanceMessages: AI correction asks for fixed right after tr, with background, glossary and previous lines; off asks nothing', () => {
  const [sys, user] = enhanceMessages({ sentence: FIX_SENTENCE, previous: ['Hi.'], translate: true, terms: true, correct: true, context: 'Internship interview', keywords: ['LoRA'] })
  assert.match(sys.content, /\{"fixed":"纠正识别错误后的整句，没有要改的给空字符串","tr":"译文","chunks"/)
  assert.match(sys.content, /任务一：「这一句」是语音识别稿/)
  assert.match(sys.content, /任务四/)
  assert.match(sys.content, /同音或近音误听/)
  assert.match(sys.content, /被连在一起/)
  assert.match(sys.content, /不改说法，不润色，不改语法和标点，不补全没说完的话，不翻译/)
  assert.match(sys.content, /拿不准就不改。整句没有要改的，fixed 给空字符串/)
  assert.match(sys.content, /en 从改好的句子（fixed 为空时就是「这一句」）原样复制/)
  assert.match(sys.content, /term 必须从改好的句子/)
  assert.match(sys.content, /按纠正后的意思翻译/)
  assert.match(sys.content, /会议背景：Internship interview/)
  assert.match(sys.content, /术语表（识别稿里这些词的正确拼写）：LoRA/)
  // 示例：没错的句子 fixed 给空，有错的给整句，意群从改好的句子里截
  assert.match(sys.content, /"fixed":"","tr":"学习率调得太大，损失就会开始发散，上次实验课我们见过。","chunks"/)
  assert.match(sys.content, /"fixed":"So the PyTorch version handles the hold-out set differently\.","tr":"[^"]+","chunks":\[\{"en":"So the PyTorch version"/)
  // 探针里的错词和答案不在 prompt 里
  assert.doesNotMatch(sys.content, /Seamen|Siemens|WebVision|web vision|Bonferoni|Bonferroni|a blation/)
  assert.match(user.content, /上文[\s\S]*Hi\.[\s\S]*这一句：\nWe did the Seamen internship/)
  assert.doesNotMatch(sys.content, /[\u2013\u2014]/)
  const off = enhanceMessages({ sentence: FIX_SENTENCE, translate: true, terms: true })
  assert.doesNotMatch(off[0].content, /fixed|识别错误/)
  const termsOnly = enhanceMessages({ sentence: FIX_SENTENCE, translate: false, terms: true, correct: true })
  assert.match(termsOnly[0].content, /\{"fixed":"[^"]*","terms"/)
  assert.match(termsOnly[0].content, /任务二：从「这一句」里挑出/)
})

test('parseEnhance: an accepted fix comes back as fixed, and chunks and terms are checked against the fixed sentence', () => {
  const r = parseEnhance(fixReply(FIXED), FIX_SENTENCE)
  assert.equal(r.fixed, FIXED)
  assert.deepEqual(r.chunks, [
    { en: 'We did the Siemens internship', zh: '做了西门子实习' },
    { en: 'on the WebVision dataset.', zh: '在 WebVision 数据集上' },
  ])
  assert.deepEqual(r.terms, [{ term: 'WebVision', zh: '', explain: '带噪声标签的网络图片数据集' }])
  assert.equal(r.fixDropped, undefined)
  // corrected 也认
  assert.equal(parseEnhance(JSON.stringify({ tr: 'x', corrected: FIXED }), FIX_SENTENCE).fixed, FIXED)
})

test('parseEnhance: fixed missing, empty, same as the sentence or only punctuation changed counts as no change', () => {
  const sentence = 'We did the Siemens internship on the WebVision dataset.'
  const plain = parseEnhance(fixReply(undefined), sentence)
  assert.equal(plain.chunks.length, 2)
  for (const fixed of [undefined, null, '', '   ', sentence, ` ${sentence} `, 'We did the Siemens internship, on the WebVision dataset!', 42]) {
    const r = parseEnhance(fixReply(fixed), sentence)
    assert.deepEqual(r, plain, String(fixed))
    assert.ok(!('fixed' in r) && !('fixDropped' in r))
  }
})

test('parseEnhance: a fix that changes too much is dropped; chunks and terms written for it fall back to the original sentence', () => {
  const sentence = 'So we gonna rerun it tomorrow.'
  const raw = JSON.stringify({
    tr: '我们明天早上把整个实验重跑一遍。',
    fixed: 'So we are going to run the whole experiment again tomorrow morning.',
    chunks: [
      { en: 'So we are going to run the whole experiment again', zh: '我们把整个实验重跑一遍' },
      { en: 'tomorrow', zh: '明天早上' },
    ],
    terms: [{ term: 'experiment', explain: '实验' }, { term: 'rerun', explain: '重新跑' }],
  })
  const r = parseEnhance(raw, sentence)
  assert.equal(r.fixed, undefined)
  assert.equal(r.fixDropped, 'edits')
  assert.deepEqual(r.chunks, [{ en: 'tomorrow', zh: '明天早上' }]) // 改写后的那块在原句里找不到：丢掉
  assert.deepEqual(r.terms.map((x) => x.term), ['rerun'])
  // 长度变化超过 40%：也不可信
  const long = checkFix('a b c d e f g h i j k l m n o p q r s t', 'alpha beta gamma delta epsilon zeta eta h i j k l m n o p q r s t')
  assert.deepEqual([long.ok, long.reason, long.edits], [false, 'length', 7])
  assert.equal(parseEnhance(JSON.stringify({ tr: 'x', fixed: 'alpha beta gamma delta epsilon zeta eta h i j k l m n o p q r s t' }), 'a b c d e f g h i j k l m n o p q r s t').fixDropped, 'length')
})

test('parseEnhance: correct off ignores fixed; without the sentence fixed cannot be checked and is ignored', () => {
  const r = parseEnhance(fixReply(FIXED), FIX_SENTENCE, { correct: false })
  assert.equal(r.fixed, undefined)
  assert.deepEqual(r.chunks, []) // 两块都是按 fixed 写的
  assert.deepEqual(r.terms, [])
  assert.equal(parseEnhance(fixReply(FIXED)).fixed, undefined)
})

test('checkFix and fixEdits: near spellings, merges and splits count half, unrelated words count one', () => {
  assert.equal(fixEdits(['the', "Seamen's"], ['the', 'Siemens']), 0.5)
  assert.equal(fixEdits(['a', 'blation', 'study'], ['ablation', 'study']), 0.5)
  assert.equal(fixEdits(['web', 'vision', 'data', 'set'], ['WebVision', 'dataset']), 1)
  assert.equal(fixEdits(['Bon', 'fer', 'oni'], ['Bonferroni']), 0.5)
  assert.equal(fixEdits(['do'], ['to', 'do']), 1) // do 和 todo 不算拆开
  assert.equal(fixEdits(['we', 'like', 'it'], ['they', 'hate', 'it']), 2)
  assert.equal(fixEdits(['lora'], ['LoRA']), 0) // 只改大小写
  // 一句话里三处识别错误（11 个词）照样收
  assert.equal(checkFix('We ran a blation study on the web vision data set.', 'We ran an ablation study on the WebVision dataset.').ok, true)
  // 很短的句子至少允许改一处
  assert.equal(checkFix('Bonferoni.', 'Bonferroni.').ok, true)
  assert.deepEqual(checkFix('we use lora', '"we use LoRA"'), { ok: true, fixed: 'we use LoRA', edits: 0, words: 3 })
  assert.equal(checkFix('Bonferoni correction', 'Bonferroni \u2014 correction').fixed, 'Bonferroni, correction')
  // 中文按字算，比长度时一个汉字算两个字符
  assert.equal(checkFix('我们用罗拉微调', '我们用 LoRA 微调').ok, true)
  assert.equal(checkFix('我们用罗拉微调', '我们今天下午用 LoRA 在新数据上微调模型').reason, 'edits')
  assert.deepEqual(checkFix('x', undefined), { ok: false, reason: 'empty' })
  assert.deepEqual(checkFix('Hello there.', 'Hello there!'), { ok: false, reason: 'same' })
})

test('streamedHead: with AI correction the reply starts with fixed, then tr; both show as soon as tr is complete', () => {
  assert.deepEqual(streamedHead('{"fixed":"We did the Siemens internship.","tr":"我们做了西门'), { tr: '', fixed: '' }) // 译文还没收全
  assert.deepEqual(streamedHead('{"fixed":"We did the Siemens internship.","tr":"我们做了西门子实习。","chunks'), { tr: '我们做了西门子实习。', fixed: 'We did the Siemens internship.' })
  assert.deepEqual(streamedHead('{"fixed":"","tr":"他说\\"好\\"。",'), { tr: '他说"好"。', fixed: '' })
  assert.deepEqual(streamedHead('{"tr":"只有译文。","chunks'), { tr: '只有译文。', fixed: '' }) // 没开纠错
  assert.equal(streamedTr('{"fixed":"a","tr":"译文。","terms'), '译文。')
})

test('joinFixed: corrected sentences replace their recognised text in the paragraph, spacing and repeats kept', () => {
  const raw = 'We did the Seamen internship.  It was great. Okay. Okay.'
  const sentences = [
    { text: 'We did the Siemens internship.', orig: 'We did the Seamen internship.' },
    { text: 'It was great.' },
    { text: 'Okay.' },
    { text: 'Okay!', orig: 'Okay.' },
  ]
  assert.equal(joinFixed(raw, sentences), 'We did the Siemens internship.  It was great. Okay. Okay!')
  assert.equal(joinFixed(raw, [{ text: 'x', orig: 'not in the paragraph' }]), raw)
  assert.equal(joinFixed(raw, []), raw)
})
