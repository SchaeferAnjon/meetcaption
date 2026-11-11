'use strict'
// 一节课的视频里哪几个时间点翻了页。输入是按固定间隔取样的小图（亮度，一个像素一个字节），输出是该截图的取样序号。
// 不用平均差：白底课件翻一页平均差很小，但有字的那一块像素都变了，所以数「变了的像素占多大」。
// 讲师小窗、时钟、一直在动的动画每一对相邻取样都在变：先统计每个像素在多少对相邻取样里变过，常变的（超过 30%）整块挡掉不算，
// 剩下的才用来判断翻页。变了、而且下一个取样点画面稳住了（不是翻页动画和镜头切换的中间帧）才算一页。
// 页面里是普通脚本（window.videoChanges）；单测用 vm 带一个假的 window 读它。

const DELTA = 26 // 一个像素亮度差超过这个（满值 255）算变了
const NOISY = 0.3 // 在超过这个比例的相邻取样里变过的像素，当作一直在动
const CHANGED = 0.006 // 剩下的像素里变了超过这个比例，算换了一页
const STABLE = 0.002 // 前后两个取样之间变化不到这个比例，算稳住了

/** 常变的像素（一直在动的区域，周围一圈也挡掉）→ Uint8Array，1 是挡掉。 */
function noisyMask(sigs, w, h) {
  const n = w * h
  const count = new Uint32Array(n)
  for (let k = 1; k < sigs.length; k++) {
    const a = sigs[k - 1]
    const b = sigs[k]
    for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > DELTA) count[i]++
  }
  const pairs = Math.max(1, sigs.length - 1)
  const hot = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (count[i] >= 6 && count[i] / pairs > NOISY) hot[i] = 1 // 至少变过 6 次，样本太少时别把翻过两页的字也挡掉
  // 周围一圈（每边 2 个像素）也挡掉：区域边缘的抖动
  const mask = new Uint8Array(n)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!hot[y * w + x]) continue
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const yy = y + dy
          const xx = x + dx
          if (yy >= 0 && yy < h && xx >= 0 && xx < w) mask[yy * w + xx] = 1
        }
    }
  return mask
}

function share(a, b, mask, valid) {
  let c = 0
  for (let i = 0; i < a.length; i++) if (!mask[i] && Math.abs(a[i] - b[i]) > DELTA) c++
  return c / valid
}

/**
 * sigs：取样的小图；stepSec：取样间隔；w、h：小图的宽高；minGapSec：两张之间最少隔多久。
 * → { picks: [取样序号], masked: 被挡掉的像素比例 }
 */
function findChanges(sigs, { w, h, stepSec = 3, minGapSec = 8, everySec = 300 } = {}) {
  if (!sigs.length) return { picks: [], masked: 0 }
  const n = w * h
  const mask = sigs.length > 4 ? noisyMask(sigs, w, h) : new Uint8Array(n)
  let valid = 0
  for (let i = 0; i < n; i++) if (!mask[i]) valid++
  const masked = 1 - valid / n
  // 整个画面都在动（真人讲课、实拍）：没有翻页可找，每隔几分钟截一张
  if (valid / n < 0.3) {
    const picks = []
    for (let k = 0; k < sigs.length; k += Math.max(1, Math.round(everySec / stepSec))) picks.push(k)
    return { picks, masked }
  }
  const picks = []
  let kept = null
  let keptAt = -1e9
  const content = (s) => {
    let bright = 0
    for (let i = 0; i < s.length; i++) if (s[i] > 26) bright++
    return bright / s.length > 0.2 // 黑屏、淡入的第一帧不要
  }
  for (let k = 0; k < sigs.length; k++) {
    const s = sigs[k]
    if (!kept) {
      if (content(s)) {
        picks.push(k)
        kept = s
        keptAt = k * stepSec
      }
      continue
    }
    if (k * stepSec - keptAt < minGapSec) continue
    if (share(kept, s, mask, valid) <= CHANGED) continue
    // 变了：下一个取样点还在变就是中间帧，等它稳住（最后一个取样点没得比，直接算）
    const next = sigs[k + 1]
    if (next && share(s, next, mask, valid) > STABLE) continue
    picks.push(k)
    kept = s
    keptAt = k * stepSec
  }
  return { picks, masked }
}

window.videoChanges = { findChanges }
