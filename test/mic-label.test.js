import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setUiLang } from '../src/main/i18n.js'
import { micLabel } from '../src/main/micLabel.js'

test('micLabel：去掉 Chromium 的 Default - / Communications - 前缀，换成界面语言的「默认 - 」「通信 - 」', () => {
  setUiLang('zh')
  assert.equal(micLabel('Default - 麦克风阵列 (Realtek(R) Audio)', 'default'), '默认 - 麦克风阵列 (Realtek(R) Audio)')
  assert.equal(micLabel('Communications - 麦克风阵列 (Realtek(R) Audio)', 'communications'), '通信 - 麦克风阵列 (Realtek(R) Audio)')
  // 没拿到设备号也认前缀；Mac 上 Chromium 用中文写的「默认 - 」换成同样的写法
  assert.equal(micLabel('Default - AirPods', ''), '默认 - AirPods')
  assert.equal(micLabel('默认 - MacBook Pro麦克风', 'default'), '默认 - MacBook Pro麦克风')
  assert.equal(micLabel('Communications - USB Mic'), '通信 - USB Mic')
})

test('micLabel：名字里自己带 - 的设备只去第一个前缀；具体设备和空名字原样', () => {
  setUiLang('zh')
  assert.equal(micLabel('Default - Mic - Array', 'default'), '默认 - Mic - Array')
  assert.equal(micLabel('麦克风阵列 (Realtek(R) Audio)', 'abc123'), '麦克风阵列 (Realtek(R) Audio)')
  assert.equal(micLabel('USB Mic - Pro', 'abc123'), 'USB Mic - Pro')
  assert.equal(micLabel('', 'default'), '')
  assert.equal(micLabel(undefined), '')
})

test('micLabel：别的界面语言用那种语言写「默认」', () => {
  setUiLang('en')
  assert.equal(micLabel('Default - Microphone Array', 'default'), 'Default - Microphone Array')
  setUiLang('de')
  assert.equal(micLabel('Default - Mikrofonarray', 'default'), 'Standard - Mikrofonarray')
  setUiLang('zh')
})
