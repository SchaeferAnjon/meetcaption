import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitByTime } from '../src/main/class/liveNotes.js'

test('live notes: a long paragraph is split into sentences with times spread over its duration', () => {
  const seg = { id: 's1', startedAt: 1000, speaker: '老师', text: 'A b c. D e f g h i. J.', durationMs: 20_000, sentences: [{ text: 'A b c.' }, { text: 'D e f g h i.' }, { text: 'J.' }] }
  const lines = splitByTime(seg)
  assert.deepEqual(
    lines.map((l) => [l.at, l.text]),
    [
      [1000, 'A b c.'],
      [7000, 'D e f g h i.'],
      [19000, 'J.'],
    ],
  )
  assert.ok(lines.every((l) => l.id === 's1' && l.speaker === '老师'))
})

test('live notes: without sentences or duration the paragraph stays one line at its start', () => {
  assert.deepEqual(splitByTime({ id: 'a', startedAt: 5, text: 'x y', sentences: [] }).map((l) => [l.at, l.text]), [[5, 'x y']])
  assert.deepEqual(splitByTime({ id: 'b', startedAt: 5, text: 'x. y.', sentences: [{ text: 'x.' }, { text: 'y.' }] }).map((l) => l.at), [5])
})
