import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuestion, pickLastQuestion } from '../src/main/assist/question.js'

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
