import fs from 'node:fs'
import path from 'node:path'
import { clock } from './prompts.js'
import { INBOX_ID, uniqueName } from './projects.js'
import { notesFileName } from './class/files.js'
import { t } from './i18n.js'

// 每场会议一个文件夹，放在所属项目的文件夹里：session.json 是原始数据，另外写一份人能直接看的「字幕记录.md」和「会议纪要.md」
// （课堂会议叫「课堂笔记.md」，截取的画面在 slides/ 里）。
// 会议 id 就是会议文件夹名，全局唯一（创建和移动时保证）；属于哪个项目以文件夹所在位置为准。
// 不引 electron：项目存储和「移到废纸篓」由主进程注入。

const pad = (n) => String(n).padStart(2, '0')
const SESSION_FILE = 'session.json'

export function formatDate(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function writeAtomic(file, content) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}

export function transcriptMarkdown(session) {
  const lines = [`# ${session.title || (session.mode === 'class' ? '课堂' : '会议')} · ${formatDate(session.startedAt)}`, '']
  const mins = session.endedAt ? Math.round((session.endedAt - session.startedAt) / 60000) : null
  lines.push(`- 开始：${formatDate(session.startedAt)}`)
  if (mins !== null) lines.push(`- 时长：${mins} 分钟`)
  lines.push(`- 识别：${session.engineLabel ?? session.engine}`, '')
  const glossary = new Map()
  for (const seg of session.segments) {
    if (!seg.text) continue
    lines.push(`**[${clock(seg.startedAt - session.startedAt)}] ${seg.speaker}${seg.question ? '（提问）' : ''}**：${seg.text}`)
    const tr = (seg.sentences ?? []).map((s) => s.tr).filter(Boolean).join(' ')
    if (tr) lines.push(`> ${tr}`)
    lines.push('')
    for (const sen of seg.sentences ?? []) for (const t of sen.terms ?? []) if (!glossary.has(t.term)) glossary.set(t.term, t.explain)
  }
  const answers = (session.answers ?? []).filter((a) => a.text)
  if (answers.length) {
    lines.push('## AI 答题', '')
    for (const a of answers) {
      lines.push(`**[${clock(a.startedAt - session.startedAt)}] 问**：${a.question}`, '')
      lines.push(...a.text.split('\n').map((l) => `> ${l}`), '')
    }
  }
  if (glossary.size) {
    lines.push('## 术语', '')
    for (const [term, explain] of glossary) lines.push(`- **${term}**：${explain}`)
    lines.push('')
  }
  return lines.join('\n')
}

// 列表、待办聚合、搜索用的轻量记录（不留 sentences、terms 这些大字段）
function toRecord(id, projectId, s) {
  const startedAt = Number(s.startedAt) || 0
  const segs = Array.isArray(s.segments) ? s.segments.filter((x) => x?.text) : []
  return {
    id,
    projectId,
    title: s.title || '',
    mode: s.mode ?? 'meeting',
    startedAt,
    endedAt: s.endedAt ?? null,
    count: segs.length,
    answers: Array.isArray(s.answers) ? s.answers.length : 0,
    hasSummary: Boolean(s.summary?.markdown),
    summary: s.summary?.markdown || '',
    items: Array.isArray(s.summary?.items) ? s.summary.items : [],
    lines: segs.map((x) => ({ at: (Number(x.startedAt) || startedAt) - startedAt, speaker: x.speaker, text: x.text })),
  }
}

export class SessionStore {
  /** projects：ProjectStore；trash(dir) → Promise，把文件夹移到废纸篓 / 回收站。 */
  constructor({ projects, trash = async (dir) => fs.rmSync(dir, { recursive: true, force: true }) }) {
    this.projects = projects
    this.trash = trash
    this.timers = new Map()
    this.index = null // 会议 id → 项目 id
    this.cache = new Map() // 会议 id → { key, record }
    this.current = null // 正在记录的那场（create 出来的对象，引擎一直在改它），停止后落盘时放掉
    this.currentDir = null
  }

  baseDir() {
    return this.projects.root()
  }

  /** 重新扫一遍所有项目文件夹。复制出来的同名会议文件夹（id 重复）后面那个加后缀。 */
  reindex() {
    const index = new Map()
    for (const p of this.projects.list()) {
      let dir
      try {
        dir = this.projects.dir(p.id)
      } catch {
        continue
      }
      let names = []
      try {
        names = fs.readdirSync(dir).sort()
      } catch {}
      for (const name of names) {
        if (!fs.existsSync(path.join(dir, name, SESSION_FILE))) continue
        if (!index.has(name)) {
          index.set(name, p.id)
          continue
        }
        const next = uniqueName(name, (n) => index.has(n) || fs.existsSync(path.join(dir, n)))
        try {
          fs.renameSync(path.join(dir, name), path.join(dir, next))
          this.#rewriteMeta(path.join(dir, next), { id: next, projectId: p.id })
          index.set(next, p.id)
        } catch {}
      }
    }
    this.index = index
    return index
  }

  #index() {
    return this.index ?? this.reindex()
  }

  #rewriteMeta(dir, patch) {
    const file = path.join(dir, SESSION_FILE)
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    writeAtomic(file, JSON.stringify({ ...s, ...patch }, null, 1))
  }

  /** v1/v2 的会议文件夹直接放在根目录下：挪进「未归类」。返回挪了哪些。 */
  migrateLegacy() {
    const root = this.baseDir()
    const inboxDir = this.projects.dir(INBOX_ID)
    const index = this.#index()
    const moved = []
    for (const name of fs.readdirSync(root).sort()) {
      const from = path.join(root, name)
      if (!fs.existsSync(path.join(from, SESSION_FILE)) || fs.existsSync(path.join(from, 'project.json'))) continue
      const id = uniqueName(name, (n) => index.has(n) || fs.existsSync(path.join(inboxDir, n)))
      try {
        fs.renameSync(from, path.join(inboxDir, id))
        this.#rewriteMeta(path.join(inboxDir, id), { id, projectId: INBOX_ID })
        index.set(id, INBOX_ID)
        moved.push({ from: name, id })
      } catch (e) {
        moved.push({ from: name, error: e.message })
      }
    }
    return moved
  }

  /** 会议所在项目的 id；找不到先重扫一次（用户可能在访达里挪过文件夹）。 */
  projectOf(id) {
    let pid = this.#index().get(id)
    if (!pid || !this.projects.has(pid)) pid = this.reindex().get(id)
    if (!pid) throw Object.assign(new Error(t('找不到这场会议（文件夹可能被移走或删掉了）')), { code: 'no-session' })
    return pid
  }

  dir(id) {
    try {
      return path.join(this.projects.dir(this.projectOf(id)), id)
    } catch (e) {
      // 开会中途换了保存位置：正在记录的这场继续写在原来的文件夹里
      if (this.current?.id === id && this.currentDir) return this.currentDir
      throw e
    }
  }

  create(meta = {}) {
    const projectId = meta.projectId && this.projects.has(meta.projectId) ? meta.projectId : INBOX_ID
    const pdir = this.projects.dir(projectId)
    const index = this.#index()
    const d = new Date()
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`
    const id = uniqueName(base, (n) => index.has(n) || fs.existsSync(path.join(pdir, n)))
    fs.mkdirSync(path.join(pdir, id), { recursive: true })
    index.set(id, projectId)
    const session = { id, title: '', startedAt: Date.now(), endedAt: null, segments: [], summary: null, ...meta, projectId }
    this.current = session
    this.currentDir = path.join(pdir, id)
    this.saveNow(session)
    return session
  }

  scheduleSave(session) {
    clearTimeout(this.timers.get(session.id))
    this.timers.set(
      session.id,
      setTimeout(() => {
        try {
          this.saveNow(session)
        } catch (e) {
          console.error('保存会议失败', session.id, e.message)
        }
      }, 1000),
    )
  }

  saveNow(session) {
    clearTimeout(this.timers.get(session.id))
    this.timers.delete(session.id)
    const dir = this.dir(session.id)
    fs.mkdirSync(dir, { recursive: true })
    writeAtomic(path.join(dir, SESSION_FILE), JSON.stringify(session, null, 1))
    writeAtomic(path.join(dir, '字幕记录.md'), transcriptMarkdown(session))
    if (session.summary?.markdown) writeAtomic(path.join(dir, notesFileName(session)), session.summary.markdown)
    this.cache.delete(session.id)
    if (session === this.current && session.endedAt) this.current = null
  }

  load(id) {
    if (this.current?.id === id) return structuredClone(this.current)
    let file = path.join(this.dir(id), SESSION_FILE)
    if (!fs.existsSync(file)) {
      this.reindex()
      file = path.join(this.dir(id), SESSION_FILE)
    }
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    s.id = id
    s.projectId = this.projectOf(id)
    return s
  }

  /** 改一场会议并落盘。正在记录的那场直接改引擎手里的对象，免得引擎下一次保存把改动盖掉。 */
  mutate(id, fn) {
    const live = this.current?.id === id
    const s = live ? this.current : this.load(id)
    const out = fn(s)
    this.saveNow(s)
    return out === undefined ? s : out
  }

  update(id, patch) {
    return structuredClone(this.mutate(id, (s) => void Object.assign(s, patch)))
  }

  isLive(id) {
    return Boolean(this.current && this.current.id === id && !this.current.endedAt)
  }

  /** 移到别的项目：挪文件夹，名字冲突加后缀（id 跟着变），返回新的 session。 */
  move(id, projectId) {
    if (!this.projects.has(projectId)) throw Object.assign(new Error(t('找不到这个项目')), { code: 'no-project' })
    if (this.isLive(id)) throw new Error(t('正在记录的会议不能移动，先停止记录'))
    const from = this.projectOf(id)
    if (from === projectId) return this.load(id)
    const target = this.projects.dir(projectId)
    const index = this.#index()
    const next = uniqueName(id, (n) => (n !== id && index.has(n)) || fs.existsSync(path.join(target, n)))
    clearTimeout(this.timers.get(id))
    try {
      fs.renameSync(this.dir(id), path.join(target, next))
    } catch (e) {
      throw new Error(t(`移动失败（可能有文件正被别的程序打开）：{0}`, e.message))
    }
    index.delete(id)
    index.set(next, projectId)
    this.cache.delete(id)
    if (this.current?.id === id) this.current = null
    const s = this.load(next)
    s.id = next
    s.projectId = projectId
    this.saveNow(s)
    return s
  }

  /** 把一个项目里的会议全部挪到另一个项目（删项目前用），返回挪了几场。 */
  moveAll(fromProjectId, toProjectId) {
    if (this.current && !this.current.endedAt && this.#index().get(this.current.id) === fromProjectId) throw new Error(t('这个项目里正在开会，先停止记录'))
    let n = 0
    for (const [id, pid] of [...this.reindex()]) {
      if (pid !== fromProjectId) continue
      this.move(id, toProjectId)
      n++
    }
    return n
  }

  async remove(id) {
    if (this.isLive(id)) throw new Error(t('正在记录的会议不能删除，先停止记录'))
    const dir = this.dir(id)
    clearTimeout(this.timers.get(id))
    await this.trash(dir)
    this.#index().delete(id)
    this.cache.delete(id)
    if (this.current?.id === id) this.current = null
  }

  /** 全部会议的轻量记录（按 session.json 的修改时间缓存，几百场会也只读变了的文件）。 */
  records() {
    const out = []
    for (const [id, projectId] of this.reindex()) {
      if (this.current?.id === id) {
        out.push(toRecord(id, projectId, this.current))
        continue
      }
      const file = path.join(this.projects.dir(projectId), id, SESSION_FILE)
      let st
      try {
        st = fs.statSync(file)
      } catch {
        continue
      }
      const key = `${projectId}|${st.mtimeMs}|${st.size}`
      const hit = this.cache.get(id)
      if (hit?.key === key) {
        out.push(hit.record)
        continue
      }
      try {
        const record = toRecord(id, projectId, JSON.parse(fs.readFileSync(file, 'utf8')))
        this.cache.set(id, { key, record })
        out.push(record)
      } catch {}
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** 会议列表，新的在前；给了 projectId 只列这个项目的。 */
  list({ projectId } = {}) {
    return this.records()
      .filter((r) => !projectId || r.projectId === projectId)
      .map((r) => ({
        id: r.id,
        projectId: r.projectId,
        title: r.title,
        mode: r.mode,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationMs: r.endedAt ? Math.max(0, r.endedAt - r.startedAt) : null,
        live: this.isLive(r.id),
        count: r.count,
        answers: r.answers,
        hasSummary: r.hasSummary,
        todos: r.items.filter((x) => !x.done).length,
      }))
  }
}
