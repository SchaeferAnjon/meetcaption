import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// 项目页按项目默认模式说话（renderer/control/core.js 的 modeCopy）：课堂项目说「课」，面试项目说「面试」，其余说「会议」。
const src = fs.readFileSync(new URL('../src/renderer/control/core.js', import.meta.url), 'utf8')
const pick = (re) => src.match(re)[0]
const ctx = { t: (s, ...a) => a.reduce((o, v, i) => o.split(`{${i}}`).join(String(v)), s) }
vm.createContext(ctx)
vm.runInContext(
  [pick(/const MODES = \{[\s\S]*?\n\}\n/), pick(/const modeOf = .*\n/), pick(/function modeCopy\(m\) \{[\s\S]*?\n\}\n/), 'globalThis.modeCopy = modeCopy'].join('\n'),
  ctx,
)

test('modeCopy：课堂项目说课，面试项目说面试，会议项目说会议', () => {
  const c = ctx.modeCopy('class')
  assert.equal(c.count(3), '3 场课')
  assert.equal(c.empty, '这个项目里还没有课')
  const i = ctx.modeCopy('interview')
  assert.equal(i.count(1), '1 场面试')
  assert.equal(i.empty, '这个项目里还没有面试')
  const m = ctx.modeCopy('meeting')
  assert.equal(m.count(0), '0 场会议')
  assert.equal(m.empty, '这个项目里还没有会议')
})

test('modeCopy：不认识的模式当会议', () => {
  assert.equal(ctx.modeCopy(undefined).empty, '这个项目里还没有会议')
  assert.equal(ctx.modeCopy('x').count(2), '2 场会议')
})
