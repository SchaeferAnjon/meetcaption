import test from 'node:test'
import assert from 'node:assert/strict'
import { CONTROL_HEADER, MIN_SIZE, centeredIn, placeAnswer } from '../src/main/assist/answerBounds.js'

const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
// 主窗口顶上两行：「停止」、窗口按钮和「让 AI 回答」在它们右端
const header = (w) => ({ x: w.x, y: w.y, width: w.width, height: CONTROL_HEADER })

test('答题框默认位置：165% 的 2560x1600 屏上不压主窗口右上角的按钮', () => {
  // 真机：逻辑分辨率 1552x970，任务栏占掉 43
  const area = { x: 0, y: 0, width: 1552, height: 927 }
  const main = centeredIn(area, { width: 1100, height: 720 })
  const b = placeAnswer(area, main)
  assert.equal(overlaps(b, header(main)), false)
  // 还在屏幕右侧、字幕上方，高度够用
  assert.ok(b.x + b.width <= area.width && b.x > area.width / 2)
  assert.ok(b.y + b.height <= Math.round(area.height * 0.94) - 200)
  assert.ok(b.height >= 400)
  // 没给主窗口时和原来一样贴着上边
  assert.ok(placeAnswer(area).y < b.y)
})

test('答题框默认位置：主窗口最大化、在左边或屏很小时', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  const max = placeAnswer(area, area)
  assert.equal(overlaps(max, header(area)), false)
  // 主窗口在左边、和答题框左右不重叠：不用往下挪
  const left = { x: 0, y: 0, width: 900, height: 700 }
  assert.deepEqual(placeAnswer(area, left), placeAnswer(area))
  // 屏幕很小也不小于最小尺寸
  const tiny = { x: 0, y: 0, width: 1024, height: 600 }
  const t = placeAnswer(tiny, centeredIn(tiny, { width: 1100, height: 720 }))
  assert.ok(t.width >= MIN_SIZE.width && t.height >= MIN_SIZE.height)
})

test('答题框默认位置：副屏坐标带偏移', () => {
  const area = { x: -1920, y: 200, width: 1920, height: 1040 }
  const main = centeredIn(area, { width: 1100, height: 720 })
  const b = placeAnswer(area, main)
  assert.equal(overlaps(b, header(main)), false)
  assert.ok(b.x >= area.x && b.x + b.width <= area.x + area.width && b.y >= area.y)
})
