import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { setUiLang, t } from '../src/main/i18n.js'

// 设置 → 关于：写明装的是哪个包。settings/app.js 是页面脚本，把 buildKind 的原文取出来在 Node 里跑
const src = fs.readFileSync(new URL('../src/renderer/settings/app.js', import.meta.url), 'utf8')
const buildKind = Function('t', `${src.match(/function buildKind\([^)]*\) \{[\s\S]*?\n\}\n/)[0]}\nreturn buildKind`)(t)

test('关于页：Apple 芯片版、Intel 芯片版、Windows 版各写各的；只有 Rosetta 下的 Intel 版才提示换原生版', () => {
  setUiLang('zh')
  assert.deepEqual(buildKind({ platform: 'darwin', arch: 'arm64', translated: false }), { label: 'Apple 芯片版', rosetta: false })
  assert.deepEqual(buildKind({ platform: 'darwin', arch: 'x64', translated: false }), { label: 'Intel 芯片版', rosetta: false }, '真 Intel 机器上不提示')
  assert.deepEqual(buildKind({ platform: 'darwin', arch: 'x64', translated: true }), { label: 'Intel 芯片版', rosetta: true }, 'Apple 芯片上用 Rosetta 跑 Intel 版')
  assert.deepEqual(buildKind({ platform: 'win32', arch: 'x64', translated: false }), { label: 'Windows 版', rosetta: false })
  assert.deepEqual(buildKind({ platform: 'win32', arch: 'arm64', translated: true }), { label: 'Windows 版', rosetta: false }, 'Windows 不提示 Rosetta')
  assert.deepEqual(buildKind({ platform: 'linux', arch: 'x64' }), { label: '', rosetta: false })
  setUiLang('en')
  assert.equal(t('版本 {0}（{1}）', '0.6.1', buildKind({ platform: 'darwin', arch: 'arm64' }).label), 'Version 0.6.1 (Apple silicon build)')
  setUiLang('zh')
})

test('Rosetta 提示的下载链接是官网（和 README 里写的同一个，主进程只开 https）', () => {
  const site = src.match(/const SITE_URL = '([^']+)'/)[1]
  assert.match(site, /^https:\/\//)
  assert.ok(fs.readFileSync(new URL('../README.zh-CN.md', import.meta.url), 'utf8').includes(site))
  assert.match(src, /onClick: \(\) => api\.openExternal\(SITE_URL\)/)
})

test('主进程把 process.arch 和 Rosetta 状态交给设置窗口', () => {
  const main = fs.readFileSync(new URL('../src/main/main.js', import.meta.url), 'utf8')
  assert.match(main, /arch: process\.arch,\s+translated: !!app\.runningUnderARM64Translation/)
})
