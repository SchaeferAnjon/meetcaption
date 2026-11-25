import fs from 'node:fs'
import path from 'node:path'

// 软件家族的联动开关（和画布笔记、画布今日读同一份：库里 .canvas-notes/联动.json，写法照 @cn/family 的 linksJson——按名字排、两格缩进、末尾换行）。
// MeetCaption 不接共用包（纯 JS 无打包器），这里照抄那几行。
// 名单里 mc-write、mc-todo 默认关；用户在设置里点「连上画布笔记的库」算明确同意，两条一起打开。断开库不动它们（关在家族设置里）。
export const LINKS_FILE = '.canvas-notes/联动.json'
export const CONNECT_LINKS = ['mc-write', 'mc-todo']

export function readLinks(vault) {
  let text
  try {
    text = fs.readFileSync(path.join(vault, LINKS_FILE), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return {}
    throw e
  }
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(Object.entries(v).filter(([, on]) => typeof on === 'boolean'))
  } catch (e) {
    if (e instanceof SyntaxError) return {}
    throw e
  }
}

export const linksJson = (links) => JSON.stringify(Object.fromEntries(Object.entries(links).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2) + '\n'

/** 把这几条拨开（别的照旧）；先写临时文件再改名，另两个软件每秒在看 */
export function turnOnLinks(vault, ids = CONNECT_LINKS) {
  const file = path.join(vault, LINKS_FILE)
  const cur = readLinks(vault)
  const next = { ...cur, ...Object.fromEntries(ids.map((id) => [id, true])) }
  const text = linksJson(next)
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return next
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.mc-${process.pid}.tmp`)
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
  return next
}
