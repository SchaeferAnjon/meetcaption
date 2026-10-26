import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 设置左栏：栏目名长的语言（法、西、意、德、英）要换行，不能被截成省略号（真窗口里的测量在交付说明里）
const css = fs.readFileSync(new URL('../src/renderer/settings/style.css', import.meta.url), 'utf8')
const rule = (sel) => css.match(new RegExp(`${sel.replace(/[.>]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

test('设置左栏：栏目名可以换行，行高跟着长', () => {
  const label = rule('.settings .nav-item > .nav-label')
  assert.match(label, /white-space:\s*normal/)
  assert.match(label, /text-overflow:\s*clip/)
  assert.match(rule('.settings .nav-item'), /height:\s*auto/)
})

test('设置左栏：不比 224px 窄', () => {
  const w = Number(css.match(/--sidebar-w:\s*(\d+)px/)?.[1])
  assert.ok(w >= 224, `${w}`)
})
