import { DEFAULTS } from './defaults.js'

// 全局快捷键的备选：默认的组合被别的程序占了（比如 Windows 上 Ctrl+Alt+R 常被输入法、显卡工具占着），
// 而且用户没改过它，就依次换成备选里第一个能注册上的，存回设置，界面上显示的也跟着变。用户自己改过的不动。
export const HOTKEY_FALLBACKS = {
  hotkeyToggle: ['CommandOrControl+Alt+Shift+S', 'CommandOrControl+Alt+H'],
  hotkeyRecord: ['CommandOrControl+Alt+Shift+R', 'CommandOrControl+Alt+Enter'],
  'assist.hotkeyAsk': ['CommandOrControl+Alt+Shift+A', 'CommandOrControl+Alt+Q'],
  'class.hotkeySlide': ['CommandOrControl+Alt+Shift+P', 'CommandOrControl+Alt+O'],
}

const getPath = (o, key) => key.split('.').reduce((x, k) => x?.[k], o)

/**
 * 注册一个全局快捷键。register(accel, fn) 注册上返回 null，否则返回出错说明。
 * 返回 { error, moved }：moved 是换成的备选组合（没换为 null）。
 */
export function registerHotkey(key, accel, fn, register) {
  const error = register(accel, fn)
  if (!error || !accel || accel !== getPath(DEFAULTS, key)) return { error, moved: null }
  for (const alt of HOTKEY_FALLBACKS[key] ?? []) {
    if (!register(alt, fn)) return { error: null, moved: alt }
  }
  return { error, moved: null }
}

/** 'assist.hotkeyAsk' + 值 → { assist: { hotkeyAsk: 值 } }，给 settings.update 用。 */
export function patchFor(key, value) {
  return key.split('.').reduceRight((v, k) => ({ [k]: v }), value)
}

/** 提示文字里的快捷键写法：Mac ⌃⌥⇧⌘R，Windows Ctrl+Alt+Shift+R。 */
export function accelLabel(accel, mac = process.platform === 'darwin') {
  if (!mac) {
    // 应用里别处都写 Ctrl+Alt+Shift+键 的顺序
    const win = { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Control: 'Ctrl', Option: 'Alt', Super: 'Win', Meta: 'Win' }
    const order = ['Ctrl', 'Alt', 'Shift', 'Win']
    const parts = accel.split('+')
    const key = parts.pop()
    const mods = parts.map((p) => win[p] ?? p).sort((a, b) => order.indexOf(a) - order.indexOf(b))
    return [...mods, key].join('+')
  }
  const parts = accel.split('+')
  const key = parts.pop()
  const sym = { Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘' }
  const order = ['⌃', '⌥', '⇧', '⌘']
  const mods = parts.map((p) => sym[p] ?? p).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return mods.join('') + (key === 'Return' ? '↩' : key)
}

/**
 * 托盘菜单一项：Mac 用系统的 accelerator（画成 ⌃⌥⇧⌘ 符号）；Windows 系统画出来是 Alt+Ctrl+Shift 的顺序，
 * 所以不交给系统画，自己把 Ctrl+Alt+Shift+键 写在名字后面（菜单标签里的 Tab 在 Windows 上画成 → 符号，不能用）。
 */
export function menuItemWithKey(label, accel, mac = process.platform === 'darwin') {
  if (!accel) return { label }
  return mac ? { label, accelerator: accel } : { label: `${label}    ${accelLabel(accel, false)}` }
}
