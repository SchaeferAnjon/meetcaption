import fs from 'node:fs'
import path from 'node:path'
import { clock, ymd } from '../prompts.js'
import { safeFolderName, uniqueName } from '../projects.js'
import { t } from '../i18n.js'

// 课堂的文件：截取的画面存在会议文件夹的 slides/ 里；课堂笔记导出到笔记库（比如 Obsidian 的课程目录）。
// 不引 electron，单测直接用临时目录。

const pad = (n) => String(n).padStart(2, '0')

/** 纪要文件名：课堂会议叫「课堂笔记.md」，其他叫「会议纪要.md」。 */
export function notesFileName(session) {
  return session?.mode === 'class' ? '课堂笔记.md' : '会议纪要.md'
}

/** 把一张 JPEG 存进 <会议文件夹>/slides/<时.分.秒>.jpg（同一秒截了两张就加后缀），返回相对路径 'slides/xx.jpg'。 */
export function saveSlide(sessionDir, jpeg, at = Date.now()) {
  const dir = path.join(sessionDir, 'slides')
  fs.mkdirSync(dir, { recursive: true })
  const d = new Date(at)
  const base = `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  const name = uniqueName(base, (n) => fs.existsSync(path.join(dir, `${n}.jpg`)))
  fs.writeFileSync(path.join(dir, `${name}.jpg`), jpeg)
  return `slides/${name}.jpg`
}

// Markdown 链接里的路径：空格和括号要转义，中文照留（Obsidian、Typora 都认）
const linkPath = (p) => p.replace(/[ ()<>]/g, (c) => encodeURIComponent(c))

const SLIDE_LINK = /(!\[[^\]]*\]\()<?slides\/([^)\s>]+)>?(\))/g
const MATERIAL_LINK = /(!\[[^\]]*\]\()<?materials\/(m[0-9a-f]+)\/(p\d{3}\.jpg)>?(\))/g

/** 导出的笔记文件名（不带扩展名）：「2026-10-21 标题 课堂笔记」，没标题用开始时间。 */
export function notesBaseName(session) {
  const d = new Date(session.startedAt)
  const kind = session.mode === 'class' ? '课堂笔记' : '会议纪要'
  const title = String(session.title ?? '').trim() || `${pad(d.getHours())}.${pad(d.getMinutes())}`
  return safeFolderName(`${ymd(session.startedAt)} ${title} ${kind}`, `${ymd(session.startedAt)} ${kind}`)
}

/**
 * 导出笔记：拷一份 <日期> <标题> 课堂笔记.md 到 dir，用到的截图拷进旁边的「<日期> <标题> 截图」文件夹，链接跟着改。
 * 笔记里没引用到的截图附在最后「课上截图」一节里一起拷过去；有图文版（课堂笔记.html，图都在文件里）的一起拷成「<日期> <标题> 课堂笔记.html」。
 * 同名文件直接覆盖（重新导出同一节课）。
 * → { dir, files: [绝对路径] }
 */
export function exportNotesTo({ session, sessionDir, dir, projectName = '' }) {
  const md = session.summary?.markdown
  if (!md) throw new Error(session.mode === 'class' ? t('还没生成课堂笔记，先点「生成课堂笔记」') : t('还没生成纪要'))
  const d = new Date(session.startedAt)
  const kind = session.mode === 'class' ? '课堂笔记' : '会议纪要'
  const title = String(session.title ?? '').trim() || `${pad(d.getHours())}.${pad(d.getMinutes())}`
  const base = notesBaseName(session)
  const assets = safeFolderName(`${ymd(session.startedAt)} ${title} 截图`, `${ymd(session.startedAt)} 截图`)
  fs.mkdirSync(dir, { recursive: true })
  const files = []
  const slides = Array.isArray(session.slides) ? session.slides : []
  const copied = new Set()
  // 只拷这节课自己截的图：笔记是模型写的，链接里的 ../ 之类不能把别的本地文件带进笔记库
  const known = new Set(slides.map((x) => (x?.file ? path.basename(String(x.file)) : '')).filter(Boolean))
  const safe = (name) => name === path.basename(name) && /^[\w.\- ()]+\.jpe?g$/i.test(name) && !name.startsWith('.') && (known.size === 0 || known.has(name))
  const copy = (name) => {
    if (copied.has(name)) return true
    if (!safe(name)) return false
    const from = path.join(sessionDir, 'slides', name)
    if (!fs.existsSync(from)) return false
    fs.mkdirSync(path.join(dir, assets), { recursive: true })
    const to = path.join(dir, assets, name)
    fs.copyFileSync(from, to)
    files.push(to)
    copied.add(name)
    return true
  }
  // 课件页：materials/<id>/pNNN.jpg 拷成「<课件名> pNNN.jpg」，只认这节课自己的课件
  const materials = new Map((session.materials ?? []).map((m) => [m.id, m]))
  const copyPage = (id, page) => {
    const m = materials.get(id)
    const from = path.join(sessionDir, 'materials', id, page)
    if (!m || !fs.existsSync(from)) return null
    const name = `${safeFolderName(path.parse(m.name).name, '课件')} ${page}`
    fs.mkdirSync(path.join(dir, assets), { recursive: true })
    const to = path.join(dir, assets, name)
    if (!files.includes(to)) {
      fs.copyFileSync(from, to)
      files.push(to)
    }
    return name
  }
  let body = md.replace(MATERIAL_LINK, (all, head, id, page, tail) => {
    const name = copyPage(id, page)
    return name ? `${head}${linkPath(`${assets}/${name}`)}${tail}` : all
  })
  body = body.replace(SLIDE_LINK, (all, head, name, tail) => {
    let file = name
    try {
      file = decodeURIComponent(name)
    } catch {}
    return copy(file) ? `${head}${linkPath(`${assets}/${file}`)}${tail}` : all
  })
  const rest = slides.filter((x) => x?.file && !copied.has(path.basename(x.file)))
  const extra = []
  for (const x of rest) {
    const name = path.basename(x.file)
    if (copy(name)) extra.push(`![[${clock(Math.max(0, (x.at ?? session.startedAt) - session.startedAt))}]](${linkPath(`${assets}/${name}`)})`)
  }
  if (extra.length) body = `${body.trimEnd()}\n\n## 课上截图\n\n${extra.join('\n\n')}\n`
  const head = [`# ${session.title || kind}`, '', `- 日期：${ymd(session.startedAt)}${projectName ? `\n- ${session.mode === 'class' ? '课程' : '项目'}：${projectName}` : ''}`, '', ''].join('\n')
  const file = path.join(dir, `${base}.md`)
  fs.writeFileSync(file, head + body)
  files.unshift(file)
  const html = session.summary?.html && path.join(sessionDir, path.basename(session.summary.html))
  if (html && fs.existsSync(html)) {
    const to = path.join(dir, `${base}.html`)
    fs.copyFileSync(html, to)
    files.splice(1, 0, to)
  }
  return { dir, files }
}
