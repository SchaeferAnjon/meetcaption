import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// 新建项目对话框里颜色和图标按钮的读屏名：每个颜色、每个图标都有界面语言的名字，不再读 blue、users 这样的英文词
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const core = read('../src/renderer/control/core.js')
const tints = [...read('../src/renderer/shared/ui.js').match(/tints: \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
const icons = [...read('../src/renderer/shared/icons.js').match(/const PROJECT_ICONS = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1])

const ctx = { t: (s) => s }
vm.createContext(ctx)
vm.runInContext([core.match(/function tintName[\s\S]*?\n\}\n/)[0], core.match(/function projectIconLabel[\s\S]*?\n\}\n/)[0], 'globalThis.tintName = tintName; globalThis.projectIconLabel = projectIconLabel'].join('\n'), ctx)

test('颜色和图标的读屏名：全部有中文名，不带英文词', () => {
  assert.ok(tints.length >= 10 && icons.length >= 15)
  for (const v of tints) assert.match(ctx.tintName(v), /^[一-鿿]+$/, v)
  for (const v of icons) assert.match(ctx.projectIconLabel(v), /^[一-鿿]+$/, v)
  assert.equal(new Set(tints.map(ctx.tintName)).size, tints.length)
  assert.equal(new Set(icons.map(ctx.projectIconLabel)).size, icons.length)
})

test('颜色和图标的读屏名：不认识的原样', () => {
  assert.equal(ctx.tintName('chartreuse'), 'chartreuse')
  assert.equal(ctx.projectIconLabel('x'), 'x')
})
