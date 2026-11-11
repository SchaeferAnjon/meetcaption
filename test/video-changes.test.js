import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// 一节课的视频里找翻页：按固定间隔取样的小图，数变了的像素占多大；讲师小窗这种一直在动的区域先挡掉，动画的中间帧不算。
const win = {}
vm.runInNewContext(fs.readFileSync(new URL('../src/renderer/video/changes.js', import.meta.url), 'utf8'), { window: win })
const findChanges = (...a) => {
  const r = win.videoChanges.findChanges(...a) // vm 里造出来的数组换成本页面的数组，deepEqual 才比得了
  return { picks: [...r.picks], masked: r.masked }
}

const W = 80
const H = 45
let seed = 5
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647

// 一页课件：浅色底，几行「字」（一块块深色），page 不同字的位置不同
function slide(page, { cam = true, t = 0, anim = 0 } = {}) {
  const s = new Uint8Array(W * H).fill(240)
  for (let line = 0; line < 4; line++) {
    const y = 6 + line * 7 + (page % 3) * 2
    const x0 = 6 + ((page * 7 + line * 3) % 10)
    for (let y2 = y; y2 < y + 3; y2++) for (let x = x0; x < x0 + 40 - page; x++) s[y2 * W + x] = 30
  }
  if (cam) for (let y = H - 14; y < H - 2; y++) for (let x = W - 20; x < W - 2; x++) s[y * W + x] = Math.round(255 * rnd()) // 右下角讲师小窗，每次取样都不一样
  if (anim) for (let y = 0; y < 4; y++) for (let x = 0; x < anim; x++) s[(H - 20 + y) * W + x] = 30 // 翻页动画的一道
  return s
}

test('每 20 秒翻一页，右下角小窗一直在动：每页各截一张，小窗不算翻页', () => {
  const sigs = []
  for (let t = 0; t < 120; t += 3) sigs.push(slide(Math.floor(t / 20)))
  const { picks, masked } = findChanges(sigs, { w: W, h: H, stepSec: 3 })
  assert.deepEqual(picks.map((k) => k * 3), [0, 21, 42, 60, 81, 102], '每页翻过去后的第一个取样点')
  assert.ok(masked > 0.02 && masked < 0.2, `小窗被挡掉 ${masked}`)
})

test('翻页动画的中间帧不截，等画面稳住再截', () => {
  const sigs = [slide(1, { cam: false }), slide(1, { cam: false }), slide(1, { cam: false, anim: 30 }), slide(2, { cam: false }), slide(2, { cam: false }), slide(2, { cam: false }), slide(2, { cam: false })]
  const { picks } = findChanges(sigs, { w: W, h: H, stepSec: 3, minGapSec: 1 })
  assert.deepEqual(picks, [0, 3])
})

test('黑屏、淡入的开头不算第一张；两张之间最少隔 minGapSec', () => {
  const black = new Uint8Array(W * H)
  const sigs = [black, black, slide(1, { cam: false }), slide(1, { cam: false }), slide(2, { cam: false }), slide(2, { cam: false }), slide(2, { cam: false })]
  assert.deepEqual(findChanges(sigs, { w: W, h: H, stepSec: 3, minGapSec: 1 }).picks, [2, 4])
  assert.deepEqual(findChanges(sigs, { w: W, h: H, stepSec: 3, minGapSec: 8 }).picks, [2, 5], '第 4 个取样点离上一张只隔 6 秒，等到第 5 个')
})

test('整个画面都在动（真人讲课）：没有翻页可找，隔几分钟截一张', () => {
  const sigs = Array.from({ length: 400 }, () => Uint8Array.from({ length: W * H }, () => Math.round(255 * rnd())))
  const { picks } = findChanges(sigs, { w: W, h: H, stepSec: 3, everySec: 300 })
  assert.deepEqual(picks, [0, 100, 200, 300])
  assert.deepEqual(findChanges([], { w: W, h: H }).picks, [])
})
