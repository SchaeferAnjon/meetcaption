import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Assistant } from '../src/main/assist/assistant.js'
import { answerLanguage, answerMessages, answerSystem, parseAnswer, recentTranscript, splitAnswer, wantsHints, withImage } from '../src/main/assist/answerPrompt.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 假的 complete：按片段流式吐字，尊重 signal
function fakeComplete({ chunks = ['要点：', '要点：先说结论\n', '要点：先说结论\nI led it.'], delay = 5, calls = [] } = {}) {
  return async (opts) => {
    calls.push(opts)
    for (const c of chunks) {
      await sleep(delay)
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      opts.onDelta?.(c)
    }
    return chunks.at(-1)
  }
}

function collect(a) {
  const events = []
  a.on('answer', (x) => events.push(x))
  return events
}

test('assistant: streams deltas and records timing', async () => {
  const calls = []
  const a = new Assistant({ complete: fakeComplete({ calls }) })
  const events = collect(a)
  const final = await a.ask({ question: 'Tell me about yourself.', profile: 'PhD student', reason: 'auto' })
  assert.equal(final.done, true)
  assert.equal(final.error, null)
  assert.equal(final.text, '要点：先说结论\nI led it.')
  assert.equal(final.reason, 'auto')
  assert.equal(events[0].done, false)
  assert.equal(events[0].text, '')
  assert.ok(events.some((e) => !e.done && e.text === '要点：'))
  assert.ok(final.timing.firstToken > 0 && final.timing.firstToken <= final.timing.total)
  assert.equal(final.timing.screen, null)
  assert.ok(final.timing.sent >= 0 && final.timing.sent <= final.timing.firstToken)
  assert.equal(calls[0].model, 'answer')
  assert.equal(calls[0].effort, 'none')
  assert.ok(calls[0].maxOutputTokens <= 600)
  assert.match(calls[0].messages[0].content, /我的资料：\nPhD student/)
})

test('assistant: a new question cancels the one still generating', async () => {
  const a = new Assistant({ complete: fakeComplete({ chunks: ['a', 'ab', 'abc', 'abcd'], delay: 20 }) })
  const events = collect(a)
  const first = a.ask({ question: 'What is the main contribution?' })
  await sleep(30)
  const second = await a.ask({ question: 'Why this baseline?' })
  const firstResult = await first
  assert.equal(firstResult.cancelled, true)
  assert.equal(firstResult.done, true)
  assert.equal(second.cancelled, false)
  assert.equal(second.text, 'abcd')
  // 被取消的那条后面不再有更新
  const firstId = firstResult.id
  const lastFirst = events.filter((e) => e.id === firstId).at(-1)
  assert.equal(lastFirst.cancelled, true)
  assert.equal(a.list().length, 2)
})

test('assistant: screenshot runs alongside and is attached as an image', async () => {
  const calls = []
  const order = []
  const captureScreen = async ({ maxWidth }) => {
    order.push('shot:start')
    await sleep(30)
    order.push('shot:end')
    return { dataUrl: 'data:image/jpeg;base64,AAAA', width: maxWidth, height: 900, ms: 30 }
  }
  const a = new Assistant({ complete: fakeComplete({ calls }), captureScreen })
  const final = await a.ask({ question: 'What does this part of the diagram mean?', withScreen: true })
  assert.deepEqual(order, ['shot:start', 'shot:end'])
  assert.equal(final.timing.screen, 30)
  // 请求在截图之后才发：等首字 = firstToken - sent，生成 = total - firstToken
  assert.ok(final.timing.sent >= 30 && final.timing.sent <= final.timing.firstToken, JSON.stringify(final.timing))
  assert.ok(final.timing.firstToken <= final.timing.total)
  assert.equal(final.warning, null)
  const content = calls[0].messages.at(-1).content
  assert.ok(Array.isArray(content))
  assert.deepEqual(content.at(-1), { type: 'image', dataUrl: 'data:image/jpeg;base64,AAAA' })
  assert.match(calls[0].system, /附图是我现在的屏幕/)
})

test('answer prompt: names the scene by mode, never asks back, and only leans on the screenshot when the question is about it', () => {
  assert.match(answerSystem({ mode: 'interview' }), /面试官刚问了我/)
  assert.match(answerSystem({ mode: 'meeting' }), /会上有人刚问了我/)
  assert.match(answerSystem({}), /不反问/)
  assert.doesNotMatch(answerSystem({ withScreen: false }), /附图/)
  const sys = answerSystem({ withScreen: true })
  assert.match(sys, /问题明显在说屏幕上的东西/)
  assert.match(sys, /截图只当背景参考/)
  assert.match(answerMessages({ question: 'Q', withScreen: true, mode: 'interview' }).system, /面试官/)
})

test('assistant: screenshot failure still answers and leaves a warning', async () => {
  const calls = []
  const captureScreen = async () => {
    throw Object.assign(new Error('没有屏幕录制权限'), { code: 'no-permission' })
  }
  const a = new Assistant({ complete: fakeComplete({ calls }), captureScreen })
  const final = await a.ask({ question: 'What does this mean?', withScreen: true })
  assert.equal(final.error, null)
  assert.match(final.warning, /屏幕录制权限/)
  assert.equal(typeof calls[0].messages.at(-1).content, 'string')
})

test('assistant: slow screenshot is skipped after the screen timeout', async () => {
  const calls = []
  const captureScreen = () => sleep(500).then(() => ({ dataUrl: 'data:x', ms: 500 }))
  const a = new Assistant({ complete: fakeComplete({ calls }), captureScreen, screenTimeoutMs: 40 })
  const t0 = Date.now()
  const final = await a.ask({ question: 'What is this?', withScreen: true })
  assert.ok(Date.now() - t0 < 300)
  assert.match(final.warning, /截图太慢/)
  assert.equal(typeof calls[0].messages.at(-1).content, 'string')
})

test('assistant: errors land in the answer event in Chinese', async () => {
  const cases = [
    [new Error('401 Unauthorized'), /^回答失败：401/],
    [new TypeError('fetch failed'), /^连不上 AI 服务/],
    [new Error('ChatGPT 登录已过期，请重新登录'), /^ChatGPT 登录已过期/],
  ]
  for (const [err, re] of cases) {
    const a = new Assistant({
      complete: async () => {
        throw err
      },
    })
    const events = collect(a)
    const final = await a.ask({ question: 'Why?' })
    assert.equal(final.done, true)
    assert.match(final.error, re)
    assert.match(events.at(-1).error, re)
  }
})

test('assistant: times out with a Chinese error', async () => {
  const a = new Assistant({
    timeoutMs: 40,
    complete: (opts) =>
      new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  })
  const final = await a.ask({ question: 'Why?' })
  assert.match(final.error, /超时/)
})

test('assistant: empty answer is an error', async () => {
  const a = new Assistant({ complete: async () => '' })
  const final = await a.ask({ question: 'Why?' })
  assert.match(final.error, /没有给出回答/)
})

test('assistant: the same auto question is answered once; regenerate reuses the id', async () => {
  const calls = []
  const a = new Assistant({ complete: fakeComplete({ calls }) })
  const x = await a.ask({ question: 'Why did you choose this baseline?', reason: 'auto' })
  const y = await a.ask({ question: 'why did you choose this baseline', reason: 'auto' })
  assert.equal(x.id, y.id)
  assert.equal(calls.length, 1)
  const z = await a.regenerate(x.id)
  assert.equal(z.id, x.id)
  assert.equal(z.reason, 'regenerate')
  assert.equal(calls.length, 2)
  assert.equal(a.list().length, 1)
  assert.equal(await a.regenerate('nope'), null)
  assert.equal(await a.ask({ question: '   ' }), null)
})

test('answer prompt: language rule, profile, trimmed transcript', () => {
  assert.match(answerSystem({ answerLang: 'en' }), /用英语（English）回答/)
  assert.match(answerSystem({ answerLang: 'de' }), /用德语（Deutsch）回答/)
  assert.match(answerSystem({}), /「要点：」（这三个字照写）加一句简体中文要点/)
  assert.match(answerSystem({ noteLang: 'ja' }), /加一句日语（日本語）要点/, '要点用这一场翻译成的语言')
  const segs = Array.from({ length: 90 }, (_, i) => ({ who: i % 2 ? 'me' : 'other', text: `line ${i}` }))
  const t = recentTranscript(segs)
  assert.equal(t.split('\n').length, 60)
  assert.match(t, /^对方：line 30\n我：line 31/)
  assert.ok(t.endsWith('我：line 89'))
  const { system, messages } = answerMessages({ question: ' Why? ', transcript: segs.slice(0, 30), context: 'Interview', profile: 'CV', answerLang: 'zh' })
  assert.match(system, /简体中文/)
  assert.match(messages[0].content, /会议背景：Interview[\s\S]*我的资料：\nCV[\s\S]*最近的对话：[\s\S]*对方的问题：Why\?\n\n语言：要点那一行用简体中文[^\n]*回答用简体中文/)
  const dup = answerMessages({ question: 'Why this one?', transcript: [{ who: 'me', text: 'Here it is.' }, { who: 'other', text: 'Why this one?' }] })
  assert.match(dup.messages[0].content, /^最近的对话：\n我：Here it is\.\n\n对方的问题：Why this one\?\n\n语言：/)
  const img = withImage(messages, 'data:image/jpeg;base64,AA')
  assert.equal(img[0].content[0].type, 'text')
  assert.equal(img[0].content[1].dataUrl, 'data:image/jpeg;base64,AA')
})

test('answer prompt: class rules for open invitations, live notes outline, and a hint when no question was recognized', () => {
  const notes = { sections: [{ title: 'Precision 和 recall', points: ['两者此消彼长'], formulas: ['$P = TP/(TP+FP)$'] }], emphasis: [{ text: '要会解释取舍' }] }
  const { system, messages } = answerMessages({ question: 'OK, so are there any questions so far?', transcript: [], notes, mode: 'class' })
  assert.match(system, /不要答「没有问题」/)
  assert.match(system, /要点：可以问/)
  assert.match(messages[0].content, /到现在为止的课堂笔记[\s\S]*Precision 和 recall：两者此消彼长；\$P = TP\/\(TP\+FP\)\$[\s\S]*强调：要会解释取舍/)
  const meeting = answerSystem({ mode: 'meeting' })
  assert.doesNotMatch(meeting, /不要答「没有问题」/)
  const loose = answerMessages({ question: 'So you should always try to balance.', matched: false })
  assert.match(loose.messages[0].content, /没认出明确的问题，这是对方最后说的话：So you should always try to balance\.\n\n语言：/)
})

test('answer language: "follow the question" is decided in code from the question, falling back to the meeting language', () => {
  assert.equal(answerLanguage('Can you walk me through your experience with Kafka?', 'auto', 'en'), 'en')
  assert.equal(answerLanguage('Warum möchten Sie Ihre aktuelle Firma verlassen?', 'auto', 'en'), 'de')
  assert.equal(answerLanguage('これまでの経験について教えてください。', 'auto', 'en'), 'ja')
  assert.equal(answerLanguage('你为什么想离开现在的公司？', 'auto', 'en'), 'zh')
  assert.equal(answerLanguage('你用过 Kubernetes 吗', 'auto', 'en'), 'zh', '汉字比英文词多')
  assert.equal(answerLanguage('How do you handle 高并发 in your system?', 'auto', 'zh'), 'en')
  assert.equal(answerLanguage('Can you tell me about yourself?', 'auto', 'ar'), 'en')
  // 判不准的交给模型跟着提问答：太短的、对方说荷兰语时被数虚词猜成法语的
  assert.equal(answerLanguage('Why?', 'auto', 'de'), null)
  assert.equal(answerLanguage('Wat vind je van dit voorstel?', 'auto', 'nl'), null)
  assert.match(answerSystem({ answerLang: null }), /用和提问相同的语言回答/)
  assert.equal(answerLanguage('你为什么想离开现在的公司？', 'en', 'zh'), 'en', '设了就用设的')
})

test('answer prompt: language written out for both lines, lead-in apart from the question, terms, no screen when not attached', () => {
  const { system, messages } = answerMessages({
    question: 'So we looked at your Kafka work. Can you walk me through the migration?',
    lead: 'So we looked at your Kafka work.',
    keywords: ['idempotent', 'Kafka'],
    answerLang: 'auto',
    source: 'en',
    noteLang: 'de',
    mode: 'interview',
  })
  assert.match(system, /要点：」（这三个字照写）加一句德语（Deutsch）要点/)
  assert.match(system, /用英语（English）回答/)
  assert.match(system, /只回答「对方的问题」这一个问题/)
  assert.doesNotMatch(system, /附图/)
  const c = messages[0].content
  assert.match(c, /^术语：idempotent、Kafka/)
  assert.match(c, /铺垫[^\n]*：So we looked at your Kafka work\.\n\n对方的问题：Can you walk me through the migration\?/)
  assert.match(c, /\n\n语言：要点那一行用德语（Deutsch）[^\n]*回答用英语（English）/)
  assert.doesNotMatch(c, /附图|屏幕/)
  // 问题是中文时回答跟着换，要点还是这一场翻译成的语言
  const zh = answerMessages({ question: '你为什么想离开现在的公司？', noteLang: 'ja', source: 'en' })
  assert.match(zh.system, /用简体中文回答/)
  assert.match(zh.messages[0].content, /要点那一行用日语（日本語）[^\n]*回答用简体中文/)
  // 带截图时才提附图
  assert.match(answerMessages({ question: 'What does this chart show?', withScreen: true }).messages[0].content, /附图是我现在的屏幕/)
})

test('splitAnswer: gist line and body', () => {
  assert.deepEqual(splitAnswer('要点：讲冲突怎么解决\nIn my last project, I had two teams.'), { gist: '讲冲突怎么解决', body: 'In my last project, I had two teams.' })
  assert.deepEqual(splitAnswer('要点：只有要点'), { gist: '只有要点', body: '' })
  assert.deepEqual(splitAnswer('No gist here.'), { gist: '', body: 'No gist here.' })
})

test('assistant: warmUp sends one tiny request to the answer model, stops at the first token, and warms the screen only with permission', async () => {
  const calls = []
  const shots = []
  const a = new Assistant({ complete: fakeComplete({ calls, chunks: ['OK', 'OK more', 'OK more text'] }), captureScreen: async (o) => (shots.push(o.maxWidth), { dataUrl: 'x' }) })
  const events = collect(a)
  const r = await a.warmUp({ screen: true })
  assert.equal(r.ok, true)
  assert.ok(r.ms >= 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, 'answer')
  assert.equal(calls[0].warm, true)
  assert.ok(calls[0].signal.aborted) // 收到第一个字就断开
  assert.deepEqual(shots, [32])
  assert.equal(events.length, 0) // 不出现在答题框里
  assert.equal(a.list().length, 0)

  const b = new Assistant({ complete: fakeComplete(), captureScreen: async () => shots.push('no'), screenReady: () => false })
  await b.warmUp({ screen: true })
  assert.deepEqual(shots, [32])
  const c = new Assistant({ complete: async () => Promise.reject(new Error('还没用 ChatGPT 账号登录')) })
  const rc = await c.warmUp()
  assert.equal(rc.ok, false)
  assert.match(rc.error, /ChatGPT/)
})

/* ---------------- 句首标签 ---------------- */

const TAGGED = '要点：先说原因\n【标签有噪声】Because the labels are noisy. 【所以先清洗】So I cleaned them first. 【效果提升两成】It lifted accuracy by two percent.'

test('parseAnswer: without tags the text stays exactly as the model wrote it', () => {
  for (const raw of ['', '要点：', '要点：先说结论\nI led it.', 'No gist here.', '要点：只有要点']) {
    const p = parseAnswer(raw)
    assert.equal(p.text, raw)
    assert.deepEqual(p.hints, [])
    assert.deepEqual({ gist: p.gist, body: p.body }, splitAnswer(raw))
  }
})

test('parseAnswer: tags are taken out of the text and kept apart with the place of the sentence they belong to', () => {
  const p = parseAnswer(TAGGED)
  assert.equal(p.gist, '先说原因')
  assert.equal(p.body, 'Because the labels are noisy. So I cleaned them first. It lifted accuracy by two percent.')
  assert.equal(p.text, `要点：先说原因\n${p.body}`)
  assert.deepEqual(
    p.hints.map((h) => h.text),
    ['标签有噪声', '所以先清洗', '效果提升两成'],
  )
  // at 指向标签后面那句的第一个字；splitAnswer 拆出来的正文和它对得上
  const body = splitAnswer(p.text).body
  assert.deepEqual(
    p.hints.map((h) => body.slice(h.at, h.at + 7)),
    ['Because', 'So I cl', 'It lift'],
  )
  assert.doesNotMatch(p.text, /[【】]/)
})

test('parseAnswer: while streaming, a half-written tag is never shown and a finished tag shows up before its sentence', () => {
  const finalBody = parseAnswer(TAGGED).body
  let seen = 0
  for (let n = 3; n <= TAGGED.length; n++) {
    const p = parseAnswer(TAGGED.slice(0, n))
    assert.doesNotMatch(p.text, /[【】]/, `第 ${n} 个字：${p.text}`)
    assert.ok(finalBody.startsWith(p.body), `第 ${n} 个字：正文是最终正文的开头`)
    assert.ok(p.hints.length >= seen, '标签只增不减')
    seen = p.hints.length
    for (const h of p.hints) assert.ok(h.at <= p.body.length)
  }
  // 标签刚写完、那句话还没出第一个字
  const p = parseAnswer('要点：先说原因\n【标签有噪声】')
  assert.deepEqual(p.hints, [{ at: 0, text: '标签有噪声' }])
  assert.equal(p.body, '')
  assert.equal(parseAnswer('要点：先说原因\n【标签有').text, '要点：先说原因\n')
  assert.equal(parseAnswer('要点：先说原因\n【标签有噪声】Because the labels are noisy. 【所以').body, 'Because the labels are noisy. ')
})

test('parseAnswer: a tag written before the gist line, odd spacing and markdown do not leak markers or shift the places', () => {
  const p = parseAnswer('\n 要点：先说\n\n【一】 **Yes**, I did. 【二】So what?')
  assert.equal(p.gist, '先说')
  assert.equal(p.body, 'Yes, I did. So what?')
  assert.deepEqual(p.hints, [{ at: 0, text: '一' }, { at: 12, text: '二' }])
  // 第一个标签之前就有字：那一段没有标签
  assert.deepEqual(parseAnswer('Well. 【二】So what?').hints, [{ at: 6, text: '二' }])
  // 空标签不算
  assert.deepEqual(parseAnswer('【 】Yes.').hints, [])
})

test('assistant: streamed tags never reach the card as text and are stored apart; the final text is the plain answer', async () => {
  const chunks = []
  for (let n = 5; n < TAGGED.length; n += 6) chunks.push(TAGGED.slice(0, n))
  chunks.push(TAGGED)
  const a = new Assistant({ complete: fakeComplete({ chunks, delay: 1 }) })
  const events = collect(a)
  const final = await a.ask({ question: 'Why did the labels matter?', reason: 'auto' })
  assert.ok(events.length > 5)
  for (const e of events) assert.doesNotMatch(e.text, /[【】]/)
  assert.equal(final.text, '要点：先说原因\nBecause the labels are noisy. So I cleaned them first. It lifted accuracy by two percent.')
  assert.equal(final.hints.length, 3)
  assert.ok(events.some((e) => !e.done && e.hints?.length === 1), '第一句的标签先到')
  // 没有标签的回答没有 hints 字段
  const plain = new Assistant({ complete: fakeComplete() })
  assert.equal('hints' in (await plain.ask({ question: 'Tell me about yourself.' })), false)
})

test('answer prompt: tags in the language it is translated into, short, one per sentence; none when the answer is already in that language', () => {
  const en = answerSystem({ answerLang: 'en', noteLang: 'zh' })
  assert.match(en, /每句话的前面先写一个简体中文标签：用【】括起来/)
  assert.match(en, /10 个字以内/)
  assert.match(en, /不加这句话里没有的数字和名字/)
  assert.match(answerSystem({ answerLang: 'zh', noteLang: 'de' }), /德语（Deutsch）标签[^\n]*4 个词以内/)
  assert.match(answerSystem({ answerLang: 'en', noteLang: 'ja' }), /日语（日本語）标签[^\n]*10 个字以内/)
  // 回答和翻成的语言一样：不要标签
  assert.doesNotMatch(answerSystem({ answerLang: 'zh', noteLang: 'zh', hints: false }), /标签/)
  assert.equal(wantsHints('zh', 'zh'), false)
  assert.equal(wantsHints('de', 'zh'), true)
  assert.equal(wantsHints(null, 'zh'), true)
  const same = answerMessages({ question: '你为什么想离开现在的公司？', noteLang: 'zh' })
  assert.doesNotMatch(same.system, /标签/)
  assert.doesNotMatch(same.messages[0].content, /标签/)
  const diff = answerMessages({ question: 'Why do you want to leave your current company?', noteLang: 'zh' })
  assert.match(diff.system, /标签/)
  assert.match(diff.messages[0].content, /每句前面的【标签】也用简体中文/)
  // 回答语言没判出来（太短的问题）：让模型自己判，回答和标签同语言时不写
  assert.match(answerSystem({ answerLang: null, noteLang: 'zh' }), /回答也是简体中文时不写标签/)
  // 括号规则给标签让路
  assert.match(en, /标签的【】除外/)
})
