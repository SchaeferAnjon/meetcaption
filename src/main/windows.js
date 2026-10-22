import os from 'node:os'

// 主窗口、设置窗口、引导窗口的外观：Mac 用 hiddenInset 标题栏 + 毛玻璃（vibrancy），
// Windows 11 22H2 起用 Mica 材质 + 隐藏标题栏 + titleBarOverlay（右上角三个按钮的颜色跟主题），更老的 Windows 用纯色背景。
// 渲染层从 init() 的 chrome 字段知道这些：material 为 'none' 时自己画不透明背景。

export const TITLEBAR_HEIGHT = 40
export const TRAFFIC_LIGHTS = { x: 16, y: 13 } // Mac 红绿灯左上角的位置，三个按钮一共约 52×16

// 和 DS 的 tokens.css 的 --bg、--text 对齐
export const THEME_COLORS = {
  dark: { bg: '#1b1b1d', fg: '#ececec' },
  light: { bg: '#ffffff', fg: '#1d1d1f' },
}

/** 'vibrancy'（Mac）| 'mica'（Windows 11 22H2+）| 'none' */
export function windowMaterial(platform = process.platform, release = os.release()) {
  if (platform === 'darwin') return 'vibrancy'
  if (platform === 'win32') return (Number(String(release).split('.')[2]) || 0) >= 22621 ? 'mica' : 'none'
  return 'none'
}

export function titleBarOverlay(dark, material = windowMaterial()) {
  const c = dark ? THEME_COLORS.dark : THEME_COLORS.light
  return { color: material === 'mica' ? '#00000000' : c.bg, symbolColor: c.fg, height: TITLEBAR_HEIGHT }
}

/** BrowserWindow 的外观选项。 */
export function chromeOptions({ dark, platform = process.platform, material = windowMaterial(platform) }) {
  const c = dark ? THEME_COLORS.dark : THEME_COLORS.light
  if (platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS, vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlay(dark, material),
      backgroundColor: material === 'mica' ? '#00000000' : c.bg,
      ...(material === 'mica' ? { backgroundMaterial: 'mica' } : {}),
    }
  }
  return { backgroundColor: c.bg }
}

/** 给渲染层的：怎么留拖动区、要不要自己画背景。 */
export function chromeInfo(platform = process.platform) {
  const material = windowMaterial(platform)
  return {
    platform,
    material,
    titleBarHeight: TITLEBAR_HEIGHT,
    // Mac：红绿灯在左上，内容别压住 { x, y, width, height }；Windows：右上角是系统的三个按钮，宽度看 CSS env(titlebar-area-width)
    trafficLights: platform === 'darwin' ? { ...TRAFFIC_LIGHTS, width: 52, height: 16 } : null,
    overlayControls: platform === 'win32' ? 'right' : null,
  }
}

/** 主题变了：Windows 上更新右上角按钮和底色（Mac 的毛玻璃自己跟系统）。 */
export function applyTheme(win, dark, platform = process.platform) {
  if (!win || win.isDestroyed() || platform !== 'win32') return
  const material = windowMaterial(platform)
  try {
    win.setTitleBarOverlay(titleBarOverlay(dark, material))
  } catch {}
  if (material !== 'mica') win.setBackgroundColor(dark ? THEME_COLORS.dark.bg : THEME_COLORS.light.bg)
}
