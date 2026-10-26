import test from 'node:test'
import assert from 'node:assert/strict'
import { dragBounds, getBoundsKept, gesture, keepSize, resizeBounds, setBoundsKept } from '../src/main/windowBounds.js'

// 模拟 Windows 小数缩放：setBounds 进去的宽高，getBounds 读出来每次大 1 像素（真机上就是这样一次涨一截）
function leakyWindow(b) {
  let cur = { ...b }
  return {
    setBounds(nb) {
      cur = { ...nb, width: nb.width + 1, height: nb.height + 1 }
    },
    getBounds: () => ({ ...cur }),
  }
}

test('拖动：窗口大小不变，位置跟着鼠标走了多远算', () => {
  const start = { x: 384, y: 549, width: 1092, height: 327 }
  assert.deepEqual(dragBounds(start, { x: 800, y: 700 }, { x: 800, y: 549 }), { x: 384, y: 398, width: 1092, height: 327 })
  assert.deepEqual(dragBounds(start, { x: 800, y: 700 }, { x: 900.4, y: 710.6 }), { x: 484, y: 560, width: 1092, height: 327 })
})

test('getBounds 每次多 1 像素时，拖动几百步窗口大小也不涨', () => {
  const win = leakyWindow({ x: 384, y: 549, width: 1092, height: 327 })
  keepSize(win, { width: 1092, height: 327 })
  let cursor = { x: 800, y: 700 }
  const next = gesture(() => getBoundsKept(win), () => cursor)
  for (let i = 0; i < 400; i++) {
    cursor = { x: 800, y: 700 - i }
    const g = next(i === 0)
    setBoundsKept(win, dragBounds(g.start, g.from, g.now))
  }
  const b = getBoundsKept(win)
  assert.equal(b.width, 1092)
  assert.equal(b.height, 327)
  assert.equal(b.y, 549 - 399)
})

test('没有记住大小时（别处改过窗口大小），按读到的算', () => {
  const win = leakyWindow({ x: 0, y: 0, width: 500, height: 300 })
  keepSize(win, { width: 500, height: 300 })
  win.setBounds({ x: 0, y: 0, width: 800, height: 300 }) // 绕过 setBoundsKept，模拟系统改了大小
  assert.equal(getBoundsKept(win).width, 801)
})

test('一次手势从 first 起算，不是 first 沿用起点', () => {
  let cursor = { x: 10, y: 10 }
  let bounds = { x: 100, y: 100, width: 50, height: 50 }
  const next = gesture(() => bounds, () => cursor)
  assert.equal(next(true).dx, 0)
  cursor = { x: 30, y: 15 }
  bounds = { x: 120, y: 105, width: 50, height: 50 } // 窗口已经挪了，起点不变
  const g = next(false)
  assert.deepEqual([g.dx, g.dy, g.start.x], [20, 5, 100])
  cursor = { x: 40, y: 40 }
  assert.equal(next(true).start.x, 120)
})

const AREA = { x: 0, y: 0, width: 1552, height: 927 }
const MIN = { width: 320, height: 0 }

test('拉右边缘：只改宽度，高度和位置不动；拉左边缘右边不动', () => {
  const start = { x: 384, y: 547, width: 1092, height: 327 }
  assert.deepEqual(resizeBounds(start, -100, 0, 'r', MIN, AREA), { x: 384, y: 547, width: 992, height: 327 })
  assert.deepEqual(resizeBounds(start, 100, 0, 'l', MIN, AREA), { x: 484, y: 547, width: 992, height: 327 })
})

test('拉边缘不出屏幕、不小于最小宽度', () => {
  const start = { x: 384, y: 547, width: 1092, height: 327 }
  assert.deepEqual(resizeBounds(start, 5000, 0, 'r', MIN, AREA), { x: 384, y: 547, width: 1168, height: 327 })
  assert.deepEqual(resizeBounds(start, -5000, 0, 'l', MIN, AREA), { x: 0, y: 547, width: 1476, height: 327 })
  assert.equal(resizeBounds(start, -5000, 0, 'r', MIN, AREA).width, 320)
  assert.equal(resizeBounds(start, 5000, 0, 'l', MIN, AREA).width, 320)
})

test('拉四个方向的角：答题框两边同时改', () => {
  const start = { x: 1000, y: 100, width: 440, height: 600 }
  const min = { width: 300, height: 200 }
  assert.deepEqual(resizeBounds(start, -30, 30, 'lb', min, AREA), { x: 970, y: 100, width: 470, height: 630 })
  assert.deepEqual(resizeBounds(start, 0, -50, 't', min, AREA), { x: 1000, y: 50, width: 440, height: 650 })
  assert.equal(resizeBounds(start, 0, 5000, 'b', min, AREA).y + resizeBounds(start, 0, 5000, 'b', min, AREA).height, 927)
  assert.equal(resizeBounds(start, 0, 5000, 't', min, AREA).height, 200)
})

test('165% 小数缩放下来回拉边缘 100 次，高度不涨', () => {
  const win = leakyWindow({ x: 384, y: 547, width: 1092, height: 327 })
  keepSize(win, { width: 1092, height: 327 })
  let cursor = { x: 1400, y: 700 }
  const next = gesture(() => getBoundsKept(win), () => cursor)
  for (let k = 0; k < 100; k++) {
    cursor = { x: 1400 - (k % 5) * 20, y: 700 }
    const g = next(k % 5 === 0)
    setBoundsKept(win, resizeBounds(g.start, g.dx, 0, k % 10 < 5 ? 'r' : 'l', MIN, AREA))
  }
  assert.equal(getBoundsKept(win).height, 327)
  assert.equal(getBoundsKept(win).y, 547)
})
