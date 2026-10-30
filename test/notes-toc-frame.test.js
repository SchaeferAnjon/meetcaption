import { test } from 'node:test'
import assert from 'node:assert/strict'
import '../src/renderer/shared/notes-toc.js'

// 软件里的图文笔记框架：页面发消息过来就记下，每次把框架放回页面（切了标签再回来）地址里带的是记下的最新值

const { address, accept } = globalThis.notesToc
const memory = () => {
  const m = new Map()
  return (key, value) => {
    if (value === undefined) return m.get(key) ?? null
    if (value === null) m.delete(key)
    else m.set(key, value)
    return null
  }
}
const BASE = 'file:///lib/课堂笔记.html?v=1'

test('框架的地址跟着页面最后发来的选择走', () => {
  const store = memory()
  assert.equal(address(store, BASE), `${BASE}#toc=open`, '没记过：展开')
  assert.equal(accept(store, { type: 'meetcaption-notes-toc', rail: true }), true)
  assert.equal(address(store, BASE), `${BASE}#toc=rail`, '收起后切标签回来：还是收起')
  assert.equal(accept(store, { type: 'meetcaption-notes-toc', rail: false }), true)
  assert.equal(address(store, BASE), `${BASE}#toc=open`, '展开后切标签回来：还是展开，记下的值清掉')
  assert.equal(store('notesTocRail'), null)
})

test('别的消息不当成目录的选择', () => {
  const store = memory()
  for (const data of [null, undefined, 'x', {}, { type: 'dispatch-theme', rail: true }, { rail: true }]) assert.equal(accept(store, data), false)
  assert.equal(store('notesTocRail'), null)
})
