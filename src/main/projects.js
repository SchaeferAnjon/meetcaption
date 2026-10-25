import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { TARGET_CODES, SOURCE_LANGS } from './languages.js'
import { t } from './i18n.js'

// 项目：根目录下一个项目一个文件夹，文件夹里的 project.json 就是项目本身（拷走文件夹就是完整的项目），
// 会议文件夹放在所属项目的文件夹里。「未归类」id 固定 'inbox'，不能删、不能改名、不能归档。
// 不引 electron：根目录和「移到废纸篓」由主进程注入，单测直接用临时目录。

export const INBOX_ID = 'inbox'
export const INBOX_NAME = '未归类'
// 「未归类」不能改名，存的名字一直是中文；给界面时换成当前界面语言
const shown = (p) => (p.id === INBOX_ID ? { ...structuredClone(p), name: t(INBOX_NAME) } : structuredClone(p))
export const PROJECT_FILE = 'project.json'
export const PROJECT_COLORS = ['blue', 'purple', 'green', 'orange', 'pink', 'teal', 'yellow', 'red', 'gray']
export const LANGUAGES = SOURCE_LANGS
export const TARGETS = ['', ...TARGET_CODES] // 翻译成什么，空就用设置里的
export const PROJECT_MODES = ['meeting', 'interview', 'class'] // 项目的默认模式（开始按钮的下拉里可以临时换）
export const PROJECT_CLASS_SOURCES = ['mic', 'system', ''] // 课堂的声音来源，空就用设置里的默认
const TEXT_FIELDS = ['name', 'color', 'icon', 'description', 'context', 'keywords', 'profile']
const MAX = { name: 60, color: 32, icon: 40, description: 200, context: 4000, keywords: 4000, profile: 8000 }
const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i

function writeAtomic(file, content) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export const newId = (prefix) => prefix + crypto.randomBytes(6).toString('hex')

/** 项目名 → 两个系统都能用的文件夹名（全角冒号这类照留，只换掉 Windows 不认的字符）。 */
export function safeFolderName(name, fallback = '项目') {
  let s = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (s.length > 60) s = s.slice(0, 60).trim()
  if (!s || /^\.+$/.test(s)) s = fallback
  if (WIN_RESERVED.test(s)) s = `${s}_`
  return s
}

/** 同一个目录下不重名：「名字」「名字 (2)」「名字 (3)」… taken(name) 返回 true 表示被占了。 */
export function uniqueName(base, taken) {
  if (!taken(base)) return base
  for (let i = 2; ; i++) {
    const name = `${base} (${i})`
    if (!taken(name)) return name
  }
}

/** 开会用的设置：把项目的会议背景、术语、我的资料、对方语言、翻译成什么叠到全局设置上。没给项目就原样返回。 */
export function projectSettings(s, p) {
  if (!p) return s
  return {
    ...s,
    context: p.context ?? '',
    keywords: p.keywords ?? '',
    language: LANGUAGES.includes(p.language) ? p.language : s.language,
    translateTarget: p.target && TARGETS.includes(p.target) ? p.target : s.translateTarget,
    assist: { ...s.assist, profile: p.profile ?? '' },
  }
}

// 项目字段清洗：只收认识的字段，长度封顶
function clean(patch, { inbox = false } = {}) {
  const out = {}
  for (const k of TEXT_FIELDS) {
    if (patch[k] === undefined) continue
    out[k] = String(patch[k] ?? '').slice(0, MAX[k])
  }
  if (out.name !== undefined) {
    out.name = out.name.replace(/\s+/g, ' ').trim()
    if (!out.name) delete out.name
  }
  if (patch.language !== undefined && LANGUAGES.includes(patch.language)) out.language = patch.language
  if (patch.target !== undefined && TARGETS.includes(patch.target ?? '')) out.target = patch.target ?? ''
  if (patch.mode !== undefined && PROJECT_MODES.includes(patch.mode)) out.mode = patch.mode
  if (patch.classSource !== undefined && PROJECT_CLASS_SOURCES.includes(patch.classSource ?? '')) out.classSource = patch.classSource ?? ''
  if (patch.archived !== undefined) out.archived = Boolean(patch.archived)
  if (inbox) {
    delete out.name
    delete out.archived
  }
  return out
}

function defaults(id, name, n = 0) {
  return {
    id,
    name,
    color: id === INBOX_ID ? 'gray' : PROJECT_COLORS[n % (PROJECT_COLORS.length - 1)],
    icon: id === INBOX_ID ? 'inbox' : 'folder',
    description: '',
    context: '',
    keywords: '',
    profile: '',
    language: 'en',
    target: '',
    mode: 'meeting',
    classSource: '',
    createdAt: Date.now(),
    archived: false,
  }
}

export class ProjectStore extends EventEmitter {
  /** root() → 根目录（不存在就建）；trash(dir) → Promise，把文件夹移到废纸篓 / 回收站。 */
  constructor({ root, trash = async (dir) => fs.rmSync(dir, { recursive: true, force: true }) }) {
    super()
    this.rootFn = root
    this.trash = trash
    this.items = new Map() // id → { ...project, folder }
  }

  root() {
    const dir = this.rootFn()
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 扫描根目录，没有「未归类」就建一个。复制出来的项目文件夹 id 重复时，后面那个换新 id。 */
  load() {
    const root = this.root()
    this.items.clear()
    const names = fs
      .readdirSync(root)
      .filter((n) => !n.startsWith('.'))
      .sort()
    for (const folder of names) {
      const file = path.join(root, folder, PROJECT_FILE)
      if (!fs.existsSync(file)) continue
      const raw = readJson(file)
      if (!raw || typeof raw !== 'object') continue
      let id = typeof raw.id === 'string' && raw.id ? raw.id : null
      const fixed = !id || this.items.has(id)
      if (fixed) id = raw.id === INBOX_ID && !this.items.has(INBOX_ID) ? INBOX_ID : newId('p_')
      const base = defaults(id, folder)
      const p = { ...base, ...clean(raw), id, createdAt: Number(raw.createdAt) || base.createdAt, folder }
      if (id === INBOX_ID) p.archived = false
      this.items.set(id, p)
      if (fixed) this.#write(p)
    }
    if (!this.items.has(INBOX_ID)) {
      const folder = uniqueName(INBOX_NAME, (n) => fs.existsSync(path.join(root, n)))
      const p = { ...defaults(INBOX_ID, INBOX_NAME), folder }
      fs.mkdirSync(path.join(root, folder), { recursive: true })
      this.items.set(INBOX_ID, p)
      this.#write(p)
    }
    return this
  }

  #write(p) {
    const { folder, ...data } = p
    const dir = path.join(this.root(), folder)
    fs.mkdirSync(dir, { recursive: true })
    writeAtomic(path.join(dir, PROJECT_FILE), JSON.stringify(data, null, 2))
  }

  #changed(type, id) {
    this.emit('change', { type, id })
  }

  /** 全部项目（含归档），按创建时间；「未归类」排在没归档的最后，归档的再往后。 */
  list() {
    const rank = (p) => (p.archived ? 2 : p.id === INBOX_ID ? 1 : 0)
    return [...this.items.values()].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt).map(shown)
  }

  has(id) {
    return this.items.has(id)
  }

  get(id) {
    const p = this.items.get(id)
    return p ? shown(p) : null
  }

  /** 项目文件夹的绝对路径；项目不在了抛错。 */
  dir(id) {
    const p = this.items.get(id)
    if (!p) throw Object.assign(new Error(t('找不到这个项目')), { code: 'no-project' })
    return path.join(this.root(), p.folder)
  }

  // 文件夹名是否被占（不分大小写，Mac 和 Windows 的文件系统默认都不分），exceptId 自己的不算
  #taken(exceptId) {
    const root = this.root()
    const own = exceptId ? this.items.get(exceptId)?.folder.toLowerCase() : null
    return (n) => {
      const key = n.toLowerCase()
      if (key === own) return false
      for (const p of this.items.values()) if (p.folder.toLowerCase() === key) return true
      return fs.existsSync(path.join(root, n))
    }
  }

  /** 新建项目。copyFrom 给了项目 id 时，没填的会议背景、术语、我的资料、对方语言、默认模式从那个项目复制。 */
  create(input = {}) {
    const src = input.copyFrom ? this.items.get(input.copyFrom) : null
    const inherited = src ? { context: src.context, keywords: src.keywords, profile: src.profile, language: src.language, target: src.target, mode: src.mode, classSource: src.classSource } : {}
    const fields = clean({ ...inherited, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) })
    const name = fields.name || '新项目'
    const id = newId('p_')
    const folder = uniqueName(safeFolderName(name), this.#taken())
    const p = { ...defaults(id, name, this.items.size - 1), ...fields, name, id, archived: false, folder }
    fs.mkdirSync(path.join(this.root(), folder), { recursive: true })
    this.items.set(id, p)
    this.#write(p)
    this.#changed('create', id)
    return this.get(id)
  }

  /** 改字段；改名时文件夹一起改名（重名加后缀）。 */
  update(id, patch = {}) {
    const p = this.items.get(id)
    if (!p) throw Object.assign(new Error(t('找不到这个项目')), { code: 'no-project' })
    const fields = clean(patch, { inbox: id === INBOX_ID })
    const next = { ...p, ...fields }
    if (fields.name && fields.name !== p.name) {
      const folder = uniqueName(safeFolderName(fields.name), this.#taken(id))
      if (folder !== p.folder) {
        const root = this.root()
        try {
          fs.renameSync(path.join(root, p.folder), path.join(root, folder))
        } catch (e) {
          throw new Error(t(`项目文件夹改名失败（可能有文件正被别的程序打开）：{0}`, e.message))
        }
        next.folder = folder
      }
    }
    this.items.set(id, next)
    this.#write(next)
    this.#changed('update', id)
    return this.get(id)
  }

  /** 删项目：调用方先把会议移走（SessionStore.moveAll），这里把剩下的文件夹移到废纸篓。 */
  async remove(id) {
    if (id === INBOX_ID) throw new Error(t('「未归类」不能删除'))
    const p = this.items.get(id)
    if (!p) return false
    const dir = path.join(this.root(), p.folder)
    this.items.delete(id)
    try {
      await this.trash(dir)
    } catch (e) {
      // 移不进废纸篓（比如网络盘）：至少别让它再被当成项目
      try {
        fs.renameSync(path.join(dir, PROJECT_FILE), path.join(dir, `${PROJECT_FILE}.deleted`))
      } catch {}
      this.#changed('remove', id)
      throw new Error(t(`项目已删除，但文件夹没能移到废纸篓：{0}`, e.message))
    }
    this.#changed('remove', id)
    return true
  }
}

/**
 * v2 的「会议背景、术语、我的资料、对方语言」在全局设置里，v3 挪到项目里：只迁一次，
 * 迁成「未归类」的值（未归类里已经填了的不覆盖），然后在设置里记 migrations.projects。
 * settings：{ get(), update(patch) }。返回迁了哪些字段（没迁返回 null）。
 */
export function migrateSettingsToInbox(settings, projects) {
  const s = settings.get()
  if (s.migrations?.projects) return null
  const inbox = projects.get(INBOX_ID)
  const from = { context: s.context ?? '', keywords: s.keywords ?? '', profile: s.assist?.profile ?? '', language: s.language }
  const patch = {}
  for (const [k, v] of Object.entries(from)) {
    if (v && (k === 'language' || !inbox[k])) patch[k] = v
  }
  if (Object.keys(patch).length) projects.update(INBOX_ID, patch)
  settings.update({ migrations: { projects: true } })
  return Object.keys(patch)
}

