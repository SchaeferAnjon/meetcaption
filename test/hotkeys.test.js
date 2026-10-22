import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 快捷键都在设置里：全局的四个加主窗口里的 keys.*，默认值互不重复，老设置文件升级后自动带上默认值。

const allKeys = (s) => [s.hotkeyToggle, s.hotkeyRecord, s.assist.hotkeyAsk, s.class.hotkeySlide, ...Object.values(s.keys)]

test('hotkeys: 默认快捷键互不重复', () => {
  const list = allKeys(DEFAULTS)
  assert.equal(list.length, 13)
  assert.equal(new Set(list).size, list.length)
})

test('hotkeys: 0.4.4 的老设置文件没有 hotkeyRecord 和 keys，读进来补上默认值，改过的全局快捷键保留', () => {
  const s = merge(DEFAULTS, { hotkeyToggle: 'CommandOrControl+Shift+H', assist: { hotkeyAsk: 'F9' } })
  assert.equal(s.hotkeyToggle, 'CommandOrControl+Shift+H')
  assert.equal(s.assist.hotkeyAsk, 'F9')
  assert.equal(s.hotkeyRecord, 'CommandOrControl+Alt+R')
  assert.deepEqual(s.keys, DEFAULTS.keys)
})

test('hotkeys: 只改一个主窗口快捷键不影响别的；清空表示不用', () => {
  let s = merge(DEFAULTS, {})
  s = applyPatch(s, { keys: { palette: 'CommandOrControl+P' } })
  assert.equal(s.keys.palette, 'CommandOrControl+P')
  assert.equal(s.keys.settings, 'CommandOrControl+,')
  s = applyPatch(s, { keys: { start: '' }, hotkeyRecord: '' })
  assert.equal(s.keys.start, '')
  assert.equal(s.hotkeyRecord, '')
  assert.equal(s.keys.palette, 'CommandOrControl+P')
})
