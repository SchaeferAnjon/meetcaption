// 字幕窗和答题框的拖动、拉边缘改大小。不引 electron，单测直接跑。
//
// Windows 在 150%、165% 这类小数缩放下，getBounds 读到的宽高会比 setBounds 设进去的大一两个像素，读了再设就一次涨一截
// （165% 的真机上拖一次字幕条宽 1095 → 1481，改宽度时高 328 → 639）。所以：
// 1. 窗口宽高以我们自己上次设的为准（setBoundsKept / getBoundsKept）；
// 2. 拖动和拉边缘都在按下时记一次窗口位置和鼠标位置（主进程读，屏幕坐标），之后只按鼠标走了多远算，
//    不用渲染进程的 screenX（窗口一动它跟着错位，上下不跟手）。

const kept = new WeakMap()
const SIZE_TOLERANCE = 2

export function setBoundsKept(win, b) {
  kept.set(win, { width: b.width, height: b.height })
  win.setBounds(b)
}

/** 读到的宽高和我们设的差在两像素以内就用设的，别处改过大小（系统、换屏）就用读到的。 */
export function getBoundsKept(win) {
  const b = win.getBounds()
  const k = kept.get(win)
  if (k && Math.abs(b.width - k.width) <= SIZE_TOLERANCE && Math.abs(b.height - k.height) <= SIZE_TOLERANCE) return { ...b, ...k }
  return b
}

/** 窗口刚建好时记下它的大小。 */
export function keepSize(win, b) {
  kept.set(win, { width: b.width, height: b.height })
}

/** 拖动：按下时窗口在 start、鼠标在 from，现在鼠标在 to，大小不变。 */
export function dragBounds(start, from, to) {
  return { x: Math.round(start.x + to.x - from.x), y: Math.round(start.y + to.y - from.y), width: start.width, height: start.height }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/**
 * 拖边缘：edges 里有 l、r、t、b，dx、dy 是鼠标从按下起走的距离。没拖的那一边纹丝不动，拖的那一边不超出 area，宽高不小于 min。
 */
export function resizeBounds(start, dx, dy, edges, min, area) {
  let left = start.x
  let right = start.x + start.width
  let top = start.y
  let bottom = start.y + start.height
  if (edges.includes('l')) left = clamp(start.x + dx, area.x, right - min.width)
  if (edges.includes('r')) right = clamp(right + dx, left + min.width, area.x + area.width)
  if (edges.includes('t')) top = clamp(start.y + dy, area.y, bottom - min.height)
  if (edges.includes('b')) bottom = clamp(bottom + dy, top + min.height, area.y + area.height)
  return { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) }
}

/**
 * 一次手势（拖动或拉边缘）的状态：first 为真或还没开始就记下起点，之后每次返回 { start, dx, dy }。
 * cursor() 读鼠标的屏幕位置，getBounds() 读窗口。
 */
export function gesture(getBounds, cursor) {
  let g = null
  return (first) => {
    const now = cursor()
    if (first || !g) g = { start: getBounds(), from: now }
    return { start: g.start, from: g.from, now, dx: now.x - g.from.x, dy: now.y - g.from.y }
  }
}
