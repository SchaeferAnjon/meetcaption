import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accelLabel, menuItemWithKey, patchFor, registerHotkey } from '../src/main/hotkeys.js'

// 默认快捷键被别的程序占了：没改过的换成备选；改过的不动，照样报占用
const fakeRegister = (taken) => (accel) => (taken.includes(accel) ? `快捷键 ${accel} 被别的程序占用了` : null)

test('hotkeys: 默认的 Ctrl+Alt+R 被占，换成 Ctrl+Alt+Shift+R；这个也被占就再往后换', () => {
  assert.deepEqual(registerHotkey('hotkeyRecord', 'CommandOrControl+Alt+R', () => {}, fakeRegister(['CommandOrControl+Alt+R'])), { error: null, moved: 'CommandOrControl+Alt+Shift+R' })
  assert.deepEqual(registerHotkey('hotkeyRecord', 'CommandOrControl+Alt+R', () => {}, fakeRegister(['CommandOrControl+Alt+R', 'CommandOrControl+Alt+Shift+R'])), { error: null, moved: 'CommandOrControl+Alt+Enter' })
  const all = fakeRegister(['CommandOrControl+Alt+R', 'CommandOrControl+Alt+Shift+R', 'CommandOrControl+Alt+Enter'])
  assert.equal(registerHotkey('hotkeyRecord', 'CommandOrControl+Alt+R', () => {}, all).moved, null)
  assert.match(registerHotkey('hotkeyRecord', 'CommandOrControl+Alt+R', () => {}, all).error, /占用/)
})

test('hotkeys: 用户自己改过的快捷键被占，不自动换，只报错；注册上了就不动', () => {
  assert.deepEqual(registerHotkey('hotkeyRecord', 'F8', () => {}, fakeRegister(['F8'])), { error: '快捷键 F8 被别的程序占用了', moved: null })
  assert.deepEqual(registerHotkey('assist.hotkeyAsk', 'CommandOrControl+Alt+A', () => {}, fakeRegister([])), { error: null, moved: null })
  assert.deepEqual(registerHotkey('assist.hotkeyAsk', 'CommandOrControl+Alt+A', () => {}, fakeRegister(['CommandOrControl+Alt+A'])), { error: null, moved: 'CommandOrControl+Alt+Shift+A' })
})

test('hotkeys: 设置补丁和提示里的写法', () => {
  assert.deepEqual(patchFor('assist.hotkeyAsk', 'X'), { assist: { hotkeyAsk: 'X' } })
  assert.deepEqual(patchFor('hotkeyRecord', 'X'), { hotkeyRecord: 'X' })
  assert.equal(accelLabel('CommandOrControl+Alt+Shift+R', false), 'Ctrl+Alt+Shift+R')
  assert.equal(accelLabel('CommandOrControl+Alt+Shift+R', true), '⌥⇧⌘R')
  assert.equal(accelLabel('CommandOrControl+Alt+Enter', true), '⌥⌘Enter')
})

test('hotkeys: Windows 上快捷键一律写成 Ctrl+Alt+Shift+键 的顺序', () => {
  assert.equal(accelLabel('Alt+Control+Shift+R', false), 'Ctrl+Alt+Shift+R')
  assert.equal(accelLabel('Shift+Alt+CommandOrControl+S', false), 'Ctrl+Alt+Shift+S')
  assert.equal(accelLabel('Super+Option+K', false), 'Alt+Win+K')
  assert.equal(accelLabel('F8', false), 'F8')
})

test('hotkeys: 托盘菜单一项，Mac 交给系统画，Windows 把 Ctrl+Alt 顺序的文字写在名字后面（不能用 Tab，Windows 上画成 → ）', () => {
  assert.deepEqual(menuItemWithKey('显示字幕', 'CommandOrControl+Alt+S', true), { label: '显示字幕', accelerator: 'CommandOrControl+Alt+S' })
  assert.deepEqual(menuItemWithKey('显示字幕', 'CommandOrControl+Alt+S', false), { label: '显示字幕    Ctrl+Alt+S' })
  assert.deepEqual(menuItemWithKey('显示字幕', '', false), { label: '显示字幕' })
  assert.deepEqual(menuItemWithKey('显示字幕', undefined, true), { label: '显示字幕' })
})
