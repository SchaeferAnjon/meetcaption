import { test } from 'node:test'
import assert from 'node:assert/strict'
await import('../src/renderer/answer/units.js')

const { segments, build } = globalThis.answerUnits

const BODY = 'At Northwind I led the Falcon project. Our p99 latency was 820 milliseconds. I added a cache and moved the fraud checks into a queue.'
const S = ['At Northwind I led the Falcon project.', 'Our p99 latency was 820 milliseconds.', 'I added a cache and moved the fraud checks into a queue.']
const at = (n) => BODY.indexOf(S[n])
const HINTS = [
  { at: at(0), text: '负责结账服务' },
  { at: at(1), text: '瓶颈在数据库' },
  { at: at(2), text: '加缓存' },
]
const sen = (text) => ({ text, tr: `译：${text}` })

test('answer units: one tag opens each sentence, before the translations are back', () => {
  const u = build(BODY, HINTS, null)
  assert.deepEqual(u.map((x) => [x.hint, x.text, x.sen]), [
    ['负责结账服务', S[0], null],
    ['瓶颈在数据库', S[1], null],
    ['加缓存', S[2], null],
  ])
})

test('answer units: with translations each sentence gets its own, the tag stays on the first sentence of its part', () => {
  const trans = { body: S.map(sen) }
  const u = build(BODY, HINTS, trans)
  assert.deepEqual(u.map((x) => x.hint), ['负责结账服务', '瓶颈在数据库', '加缓存'])
  assert.deepEqual(u.map((x) => x.sen?.tr), S.map((s) => `译：${s}`))
  // 一个标签后面是两句（模型少写了一个标签）：译文那边按句分，标签只在第一句上
  const u2 = build(BODY, [HINTS[0], HINTS[2]], trans)
  assert.deepEqual(u2.map((x) => [x.hint, x.text]), [['负责结账服务', S[0]], ['', S[1]], ['加缓存', S[2]]])
  assert.ok(u2.every((x) => x.sen))
})

test('answer units: no tags at all (same language) is just the answer; text before the first tag has no tag', () => {
  assert.deepEqual(build(BODY, undefined, null).map((x) => [x.hint, x.text]), [['', BODY]])
  assert.deepEqual(build(BODY, [], { body: S.map(sen) }).map((x) => [x.hint, x.text]), S.map((s) => ['', s]))
  const u = build(BODY, [HINTS[1]], null)
  assert.deepEqual(u.map((x) => [x.hint, x.text]), [['', S[0]], ['瓶颈在数据库', `${S[1]} ${S[2]}`]])
  assert.deepEqual(build('', [], null), [])
})

test('answer units: while streaming a tag can arrive before its sentence has a single word', () => {
  const body = `${S[0]} `
  const u = build(body, [{ at: 0, text: '负责结账服务' }, { at: body.length, text: '瓶颈在数据库' }], null)
  assert.deepEqual(u.map((x) => [x.hint, x.text]), [['负责结账服务', S[0]], ['瓶颈在数据库', '']])
})

test('answer units: translations that do not line up with the answer are left out instead of misplaced', () => {
  const odd = { body: [sen('Something else entirely.'), sen(S[1]), sen(S[2])] }
  const u = build(BODY, HINTS, odd)
  assert.deepEqual(u.map((x) => !!x.sen), [false, true, true])
  assert.equal(u[0].text, S[0])
  // 译文拆句和正文不同（正文里一句被拆成两句）：能拼回来就照译文的句子分
  const split = { body: [sen('At Northwind I led'), sen('the Falcon project.'), sen(S[1]), sen(S[2])] }
  assert.equal(build(BODY, HINTS, split).length, 4)
  // 空白差异不影响对上
  assert.ok(build(BODY, HINTS, { body: S.map((s) => sen(`  ${s.replace(' ', '  ')}\n`)) }).every((x) => x.sen))
})

test('answer units: segments cut the body at the tags', () => {
  assert.deepEqual(segments(BODY, HINTS).map((x) => x.text), S)
})
