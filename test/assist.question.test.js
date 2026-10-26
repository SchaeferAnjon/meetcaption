import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dropSmallTalk, isCutOff, isQuestion, pickLastQuestion } from '../src/main/assist/question.js'

const QUESTIONS = [
  // 英文
  'Tell me about yourself.',
  'Walk me through this part.',
  'Can you tell me about a project where you had to deal with conflicting requirements?',
  'Why did you choose this baseline instead of the newer one',
  'What does this part of the diagram mean',
  'So, how would you handle a disagreement with your manager',
  'Could you explain the loss function a bit more.',
  'Is this the final version of the dataset',
  'Do you have any experience with Kubernetes',
  'Have you tried running it on the larger split',
  'I would like to hear more about the evaluation.',
  "I'm curious how you picked the learning rate.",
  'What do you think about the reviewer comments',
  'Okay. Any thoughts on the second section.',
  'How long did the training take',
  'Which baseline performs better on the long documents',
  'That looks good. Describe the architecture for me.',
  'Give me an example of a time you failed.',
  'How about the ablation study',
  'What is your biggest weakness?',
  'Why?',
  'Who reviewed the second draft',
  'So what made you choose this approach.',
  'I want to know how you handled the deadline.',
  'Can you see the difference between the two curves?',
  // 中文
  '你能介绍一下你自己吗',
  '为什么选这个 baseline 而不是新的那个',
  '这一块是什么意思？',
  '你觉得这个方法怎么样',
  '能不能再讲一下第三章的实验',
  '嗯，那你呢',
  '实验大概要跑多久',
  '你们用的数据集有没有公开',
  '这个结果和上次的一样吗。',
  '请问你为什么离开上一家公司',
  '说说你在这个项目里具体负责什么',
]

const STATEMENTS = [
  // 英文
  "I think it's fine.",
  "Let me explain how it works.",
  'That is why we switched to the new baseline.',
  'When you have time, send me the revised draft.',
  'What I mean is that the data is too small.',
  'We did the ablation last week.',
  'Do it before Friday.',
  'Have a look at section three.',
  'Could be better, but it works.',
  'Okay, sounds good.',
  'Really?',
  'Right?',
  'Sorry?',
  'You know what I mean.',
  'What we did was compare against the old model.',
  "I'll explain the rest later.",
  'Share your screen please.',
  'Thanks, that makes sense.',
  'The deadline is next Friday.',
  'Please send me the slides after the meeting.',
  'Which is why the numbers look so low.',
  // 会上的事务性请求：形式是提问，但不用我来回答
  'Could you share your screen.',
  'Can you hear me now?',
  'Can you see it now?',
  'Could you send me the slides after the meeting?',
  'Would you please repeat that?',
  'Who wants coffee.',
  // 中文
  '好的，我明白了。',
  '我觉得这个方法没问题。',
  '这就是为什么我们要换 baseline。',
  '我们下周五之前把初稿发给你。',
  '我没说什么。',
  '我们开始吧。',
  '嗯，是吗？',
  '不管怎么样，先把实验跑完。',
  '我还在想这个问题呢。',
  '我们有几个问题要讨论。',
  '这个实验结果还不错。',
  '这个方法怎么样都行。',
  '你怎么都可以，先跑起来再说。',
]

test('isQuestion: questions (English and Chinese)', () => {
  assert.ok(QUESTIONS.length >= 30)
  const missed = QUESTIONS.filter((q) => !isQuestion(q))
  assert.deepEqual(missed, [])
})

test('isQuestion: statements and back-channels are not questions', () => {
  assert.ok(STATEMENTS.length >= 30)
  const wrong = STATEMENTS.filter((s) => isQuestion(s))
  assert.deepEqual(wrong, [])
})

test('isQuestion: only the last two sentences count', () => {
  assert.ok(isQuestion('We ran it twice. The numbers are close. So what changed between the runs?'))
  assert.ok(!isQuestion('Why does this matter? Because the baseline is weak. We fixed that. Then we reran everything.'))
  assert.ok(!isQuestion(''))
  assert.ok(!isQuestion(null))
})

test('pickLastQuestion: prefers the latest question from the other side', () => {
  const now = 1_000_000
  const segs = [
    { id: 1, who: 'other', text: 'What is the main contribution?', startedAt: now - 30_000 },
    { id: 2, who: 'me', text: 'Can I share my screen?', startedAt: now - 20_000 },
    { id: 3, who: 'other', text: 'Sure, go ahead.', startedAt: now - 10_000 },
  ]
  assert.deepEqual(pickLastQuestion(segs, { now }), { text: 'What is the main contribution?', segId: 1, matched: true })
  const noQ = [
    { id: 4, source: 'system', text: 'The second figure', startedAt: now - 5000 },
    { id: 5, source: 'system', text: 'the one on the left', startedAt: now - 2000 },
  ]
  assert.deepEqual(pickLastQuestion(noQ, { now }), { text: 'The second figure the one on the left', segId: 5, matched: false })
  assert.equal(pickLastQuestion([{ id: 6, who: 'me', text: 'Hello?' }], { now }), null)
})

/* ---------------- 2026-10-26 答题实测和代码审查里答非所问的句子 ---------------- */

test('isQuestion: questions from the 2026-10-26 reports, without question marks too (zh, en, de, ja)', () => {
  const asks = [
    // 「有没有什么」里的「没有什么」以前被当成否定删掉
    '到这里大家有没有什么问题',
    '你有没有什么想问我们的',
    '你还有没有什么问题想问我们',
    '大家有没有什么想法',
    '先简单介绍一下你自己吧',
    '那你给我们讲讲这个系统的架构',
    '我问一下，你为什么离开上一家公司',
    // 英文
    "What's important to you in your next role?",
    'Which option would you pick',
    'Which of these is better',
    'Any questions?',
    'Hello, can you tell me about yourself?',
    'How would you design an item potent payment API?',
    // 德文
    'Was denken Sie darüber.',
    'Warum möchten Sie Ihre aktuelle Firma verlassen',
    'Wie lange arbeiten Sie schon mit Kafka',
    'Haben Sie Erfahrung mit Kubernetes',
    'Erzählen Sie mir etwas über Ihr letztes Projekt.',
    'Was ist Ihre größte Schwäche',
    // 日文（以前连带「？」的都认不出）
    'この方法はどうですか。',
    'この方法はどうですか？',
    '何か質問はありますか',
    'これまでの経験について教えてください。',
    'なぜ転職を考えているのですか',
  ]
  assert.deepEqual(asks.filter((q) => !isQuestion(q)), [])
})

test('isQuestion: statements, cut-off fragments and meeting chores from the reports are not questions', () => {
  const statements = [
    // 停顿把问题切断了，以前自动答出「你的问题好像没说完」
    'What is the',
    'Can you tell me about your',
    // 识别把从句断成 which 开头的一句
    'um which comes up automatically with a transcription box and the topics.',
    'And then when you go on the menu, you can select the summarization box, which pops up and an audio player.',
    'which I think is fine.',
    'Which brings me to the next slide.',
    // 识别给强调句加了问号
    "What's important is that you think out loud during that round?",
    'What I mean is that the data is too small?',
    // 我方在讲，不是请对方讲
    '我先给大家介绍一下我们这个季度的方案。',
    '下面我讲一下怎么部署。',
    '我跟你说说昨天的情况。',
    '这个价格多少我们之后再算。',
    '我们看看谁来负责这个模块。',
    '接下来介绍一下我们的产品。',
    '下面讲一下怎么部署。',
    // 会上的事务和寒暄
    '能听到吗？',
    '喂，能听到我说话吗',
    '大家能看到我的屏幕吗',
    '你能共享一下屏幕吗',
    'Hello, can you hear me?',
    'Could you share your screen?',
    'Can you hear me now?',
    'Okay, that makes sense.',
    'そうですか。',
    '聞こえますか？',
    '画面を共有していただけますか？',
    'Können Sie mich hören?',
    'Können Sie Ihren Bildschirm teilen?',
    'Ist das so?',
    'Haben wir gestern besprochen.',
    'Was wir gemacht haben, ist ein neues Modell.',
    'Wie gesagt, das ist schon erledigt.',
    '今日はプロジェクトの進捗について話します。',
    '这就是为什么我们很看重高并发的经验',
  ]
  assert.deepEqual(statements.filter((s) => isQuestion(s)), [])
})

test('dropSmallTalk: removes chores and greetings, keeps the rest as said', () => {
  assert.equal(dropSmallTalk('Could you share your screen? Can you hear me now?'), '')
  assert.equal(dropSmallTalk('Can you hear me? OK so why do you want to leave Northwind?'), 'OK so why do you want to leave Northwind?')
  assert.equal(dropSmallTalk('喂，能听到吗？那我们先聊一下迁移的进度。'), '那我们先聊一下迁移的进度。')
  assert.equal(dropSmallTalk('聞こえますか？では、自己紹介をお願いします。'), 'では、自己紹介をお願いします。')
  // 没有可删的：原样（小数点不会被当成句号拆开）
  assert.equal(dropSmallTalk('We went from 820 to 190 ms in version 2.0 last week.'), 'We went from 820 to 190 ms in version 2.0 last week.')
})

test('pickLastQuestion: the newest "有没有什么问题" wins over a question from 36 seconds ago', () => {
  const now = 1_000_000
  const segs = [
    { id: 1, who: 'other', text: '大家想一想，这种情况下查找的时间复杂度是多少', startedAt: now - 40_000 },
    { id: 2, who: 'other', text: '对，退化成链表以后就是 O(n)。', startedAt: now - 20_000 },
    { id: 3, who: 'other', text: '到这里大家有没有什么问题', startedAt: now - 4000 },
  ]
  assert.deepEqual(pickLastQuestion(segs, { now }), { text: '到这里大家有没有什么问题', segId: 3, matched: true })
  // 面试最后那句「你有没有什么想问我们的」也认得
  const end = [
    { id: 4, who: 'other', text: 'Why do you want to leave your current company?', startedAt: now - 60_000 },
    { id: 5, who: 'other', text: '好的，我这边问完了，你有没有什么想问我们的', startedAt: now - 3000 },
  ]
  assert.equal(pickLastQuestion(end, { now }).segId, 5)
})

test('isCutOff: a question stopped mid-way by a pause', () => {
  assert.ok(isCutOff('What is the'))
  assert.ok(isCutOff('Can you tell me about your'))
  assert.ok(!isCutOff('What is the plan?'))
  assert.ok(!isCutOff('What is the plan'))
  assert.ok(!isCutOff('We picked the.'))
})
