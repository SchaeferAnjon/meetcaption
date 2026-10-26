import { t } from './i18n.js'

// Chromium 给「系统默认」和「通信默认」两个虚拟设备的名字加前缀（按它自己的语言：Default - / 默认 - / Communications - …），
// 前缀语言和界面语言对不上（中文界面出现 Default - 麦克风阵列）。去掉它，换成界面语言的「默认 - 」「通信 - 」。
const PREFIX = /^(Default|Communications|默认|默認|通信|通訊|既定|規定|기본값|통신|Standard|Kommunikation|Par défaut|Predeterminado|Comunicaciones|Predefinito|Comunicazioni)\s+-\s+/i
const COMM = /^(Communications|通信|通訊|통신|Kommunikation|Comunicaciones|Comunicazioni)\s+-\s+/i

/** 采集到的麦克风名字 → 给人看的名字。deviceId 是音轨的设备号（'default' / 'communications' 是虚拟设备）。 */
export function micLabel(raw, deviceId = '') {
  const label = String(raw ?? '').trim()
  const virtual = deviceId === 'default' || deviceId === 'communications'
  if (!virtual && !PREFIX.test(label)) return label
  const name = label.replace(PREFIX, '')
  if (!name) return label
  return `${COMM.test(label) || deviceId === 'communications' ? t('通信') : t('默认')} - ${name}`
}
