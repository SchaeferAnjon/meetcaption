// 答题框的默认位置（纯计算，不碰 Electron，方便测试）。

export const MIN_SIZE = { width: 300, height: 200 }
// 主窗口顶上两行：标题行右端是「停止」和最小化、最大化、关闭，开会时下面一行右端是「让 AI 回答」。
// 165% 缩放的真机上量的，这两行到主窗口顶边以下约 74 DIP 为止
export const CONTROL_HEADER = 84

/**
 * 默认在屏幕右侧、字幕上方。avoid 是主窗口的位置：答题框和它左右有重叠时，顶边放到主窗口顶上两行下面，
 * 不压主窗口右上角的「停止」、窗口按钮和「让 AI 回答」（0.4.2 真机上默认位置正好盖住前两个）。
 * → { x, y, width, height }（DIP）
 */
export function placeAnswer(workArea, avoid = null) {
  const a = workArea
  const margin = Math.max(12, Math.min(24, Math.round(a.width * 0.015)))
  const width = Math.max(340, Math.min(440, Math.round(a.width * 0.26)))
  const x = a.x + a.width - width - margin
  // 字幕默认贴在底部 6% 处、高约 180，答题框的底边留在它上方
  const bottom = a.y + Math.round(a.height * 0.94) - 200 - 16
  let top = a.y + margin
  if (avoid && x < avoid.x + avoid.width && x + width > avoid.x && avoid.y < bottom) top = Math.max(top, avoid.y + CONTROL_HEADER)
  const height = Math.max(MIN_SIZE.height, Math.min(640, Math.round(a.height * 0.62), bottom - top))
  return { x, y: Math.max(a.y + margin, bottom - height), width, height }
}

/** 主窗口没打开时按它的默认大小估计位置：Electron 不给 x、y 时窗口在主屏可用区域里居中。 */
export function centeredIn(workArea, size) {
  return {
    x: workArea.x + Math.round((workArea.width - size.width) / 2),
    y: workArea.y + Math.round((workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  }
}
