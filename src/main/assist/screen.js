import { desktopCapturer, screen, systemPreferences } from 'electron'

// 答题时带上的屏幕截图：鼠标所在的那块显示器，缩到 maxWidth，JPEG。

function noPermission(detail) {
  const e = new Error('没有屏幕录制权限，截不到屏幕。去「系统设置 → 隐私与安全性 → 录屏与系统录音」里打开「会议字幕」，然后重启应用。')
  e.code = 'no-permission'
  e.detail = detail
  return e
}

export function screenPermission() {
  if (process.platform !== 'darwin') return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus('screen')
  } catch {
    return 'unknown'
  }
}

/** → { dataUrl, width, height, ms, displayId } */
export async function captureScreen({ maxWidth = 1600, quality = 0.8 } = {}) {
  const t0 = performance.now()
  const permission = screenPermission()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const physical = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
  const width = Math.min(maxWidth, physical.width)
  const height = Math.round((width * physical.height) / physical.width)

  let sources
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
  } catch (e) {
    if (process.platform === 'darwin') throw noPermission(e.message)
    throw new Error(`截屏失败：${e.message}`)
  }
  // Mac 没授权时 getSources 仍会返回只有桌面壁纸的图，只能靠系统给的授权状态判断
  if (process.platform === 'darwin' && permission !== 'granted') throw noPermission(permission)
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) {
    if (process.platform === 'darwin') throw noPermission('empty')
    throw new Error('截屏失败：没拿到屏幕画面')
  }
  let img = source.thumbnail
  if (img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'good' })
  const jpeg = img.toJPEG(Math.round(Math.min(1, Math.max(0.1, quality)) * 100))
  const size = img.getSize()
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: size.width,
    height: size.height,
    bytes: jpeg.length,
    displayId: display.id,
    ms: Math.round(performance.now() - t0),
  }
}
