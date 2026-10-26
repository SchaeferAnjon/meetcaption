import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// 主窗口导览（renderer/control/guide.js）的说明文字：只有快捷键本身不换行，整句话不能包在不换行里（超出卡片右边）。
const ctx = {
  t: (s) => s,
  state: { settings: { hotkeyRecord: 'CommandOrControl+Alt+R', hotkeyToggle: 'CommandOrControl+Alt+S', assist: { hotkeyAsk: 'CommandOrControl+Alt+A' } } },
  el: (tag, _attrs, ...children) => ({ tag, children }),
  kbd: (accel) => ({ tag: 'kbd', accel }),
  document: {},
}
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(new URL('../src/renderer/control/guide.js', import.meta.url), 'utf8') + '\nglobalThis.tourSteps = tourSteps', ctx)

const flat = (n) => (typeof n === 'string' ? n : n?.children ? n.children.map(flat).join('') : '')

test('导览说明：不换行的只有快捷键，后面的整句话不在里面', () => {
  const steps = ctx.tourSteps().slice(0, 3)
  for (const st of steps) {
    const nw = st.text.find((n) => n?.tag === 'span.nw')
    assert.ok(nw, st.title)
    assert.deepEqual(nw.children.map((c) => c.tag), ['kbd'])
    const after = st.text[st.text.length - 1]
    assert.equal(typeof after, 'string')
    assert.ok(after.length > 4)
  }
  assert.match(flat({ children: ctx.tourSteps()[0].text }), /以后可以按项目分开/)
})

test('导览说明：没设快捷键时只剩文字', () => {
  ctx.state.settings.hotkeyRecord = ''
  const st = ctx.tourSteps()[0]
  assert.equal(st.text.filter((n) => n?.tag === 'span.nw').length, 0)
  assert.match(flat({ children: st.text }), /以后可以按项目分开/)
})
