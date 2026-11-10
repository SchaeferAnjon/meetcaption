import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { clock, noDashes, summaryMessages } from './prompts.js'
import { INBOX_ID } from './projects.js'
import { carryOver, parseTodoItems, todoMessages } from './todos.js'
import { classNotesMessages, classTodoMessages, slideMapMessages } from './class/prompts.js'
import { ensureLayouts, materialsForMap, materialsForNotes } from './class/materials.js'
import { outlineSections, parseSlideMap } from './class/slideMap.js'
import { renderNotesHtml } from './class/notesHtml.js'
import { t } from './i18n.js'

// 会后纪要：先流式生成纪要（知道这场会属于哪个项目，也知道其他项目），存盘；
// 再做一次结构化提取，把待办和 DDL 标到各自的项目，存进 session.summary.items。
// 课堂会议（session.mode === 'class'）用课堂笔记的 prompt，带最近 6 张截图；作业提取出来全部归到这节课的项目。
// 课堂笔记写完还出一份图文版（课堂笔记.html，notesHtml.js）：有课件时和作业提取同时让模型把老师讲的点对到课件的行上（slideMap）。
// 事件：'progress' { id, phase: 'summary' | 'items' | 'html', text }，'saved' { id, items: boolean }

const MAX_SLIDES = 6
export const NOTES_HTML = '课堂笔记.html'

// 截图 → data URL（主进程会换成先缩小再编码的版本）
function readImage(file) {
  return `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`
}

// 会中给过的答题提示也交给纪要参考（对方问了什么、我大概怎么答的）
export function answersNote(session) {
  const list = (session.answers ?? []).filter((a) => a.text && !a.error).slice(-20)
  if (!list.length) return ''
  const lines = list.map((a) => `[${clock(a.startedAt - session.startedAt)}] 对方问：${a.question}\nAI 建议我答：${a.text.slice(0, 400)}`)
  return `\n\n会中 AI 给我的答题提示（我不一定照着说了；只用来理解对方问了什么，纪要内容以识别稿为准）：\n${lines.join('\n')}`
}

/**
 * 去掉指不到会话文件夹里真实文件的图片：模型没拿到截图也会编 ![…](slides/xxx.jpg)，笔记里就成了一个个破图框。
 * 网址和跳出会话文件夹的路径也去掉（笔记要离线能看）。单独一行的图片连同那一行一起去掉。
 */
export function dropMissingImages(markdown, dir) {
  const seen = new Map()
  const exists = (src) => {
    if (!seen.has(src)) {
      let p = src
      try {
        p = decodeURI(src)
      } catch {}
      const full = path.resolve(dir, p)
      seen.set(src, full.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(full))
    }
    return seen.get(src)
  }
  const IMG = /!\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g
  return markdown
    .replace(new RegExp(`^[ \\t]*${IMG.source}[ \\t]*(?:\\n|$)`, 'gm'), (all, src) => (exists(src) ? all : ''))
    .replace(IMG, (all, src) => (exists(src) ? all : ''))
}

const MAX_CONTINUE = 4
const CONTINUE_ASK = '你上一条回复写到这里被截断了。从断开的地方直接接着写（可能在一句话中间），不要重复已经写过的内容，不要开场白，写完整篇为止。'

// 续写拼回原文：模型常把断开处的半句再写一遍，去掉接缝处重复的部分（最长 300 字）
export function joinContinued(done, more) {
  if (!done) return more
  for (let n = Math.min(300, done.length, more.length); n >= 6; n--) {
    if (done.endsWith(more.slice(0, n))) return done + more.slice(n)
  }
  return done + more
}

export class Summarizer extends EventEmitter {
  /**
   * store：SessionStore；projects：ProjectStore；llm(opts) → Promise<string>（complete 门面）；
   * aiStatus(at) → { ready, reason }（at 是这次记录的开始时间）；modelName(alias) → 实际模型名（记进 summary.model）。
   */
  constructor({ store, projects, llm, aiStatus, modelName = (m) => m, loadImage = readImage, renderPdf = null }) {
    super()
    this.store = store
    this.projects = projects
    this.llm = llm
    this.aiStatus = aiStatus
    this.modelName = modelName
    this.loadImage = loadImage
    this.renderPdf = renderPdf // 早先导入的课件补算每行文字的位置用（class/pdfRender.js）
    this.jobs = new Map()
  }

  cancel(id) {
    this.jobs.get(id)?.abort()
  }

  // session：这次是给哪次记录做的（会员的会后凭据只给那一场自己用，见 member/client.js aiKey）
  #ready(session) {
    const st = this.aiStatus(session.startedAt)
    // 会员的原因里已经带了去哪改；没有 Key 可填，不能指到「账号与 AI」
    if (!st.ready) throw new Error(st.provider === 'member' ? st.reason : t(`{0}（设置 → 账号与 AI）`, st.reason))
  }

  #begin(id) {
    this.jobs.get(id)?.abort()
    const ctrl = new AbortController()
    this.jobs.set(id, ctrl)
    return ctrl
  }

  #end(id, ctrl) {
    if (this.jobs.get(id) === ctrl) this.jobs.delete(id)
  }

  #context(session) {
    const all = this.projects.list()
    const project = all.find((p) => p.id === session.projectId) ?? all.find((p) => p.id === INBOX_ID) ?? null
    return { project, projects: all }
  }

  // 最近 6 张截图：[{ file, at, dataUrl }]，读不到的跳过
  #slides(session) {
    const list = (Array.isArray(session.slides) ? session.slides : []).filter((x) => x?.file).slice(-MAX_SLIDES)
    const out = []
    let dir = null
    try {
      dir = this.store.dir(session.id)
    } catch {
      return out
    }
    for (const x of list) {
      try {
        out.push({ ...x, dataUrl: this.loadImage(path.join(dir, x.file)) })
      } catch {}
    }
    return out
  }

  /** 生成纪要（课堂会议是课堂笔记）和待办。→ { markdown, items, title, itemsError } */
  async generate(id, extraAsk) {
    const session = this.store.load(id)
    this.#ready(session)
    const isClass = session.mode === 'class'
    if (!session.segments.some((x) => x.text)) throw new Error(isClass ? t('这节课没有识别到内容') : t('这场会议没有识别到内容'))
    const ctrl = this.#begin(id)
    try {
      const { project, projects } = this.#context(session)
      let content
      let system
      if (isClass) {
        const slides = this.#slides(session)
        const materials = materialsForNotes(session, this.store.dir(id))
        const pages = []
        for (const x of materials.images) {
          try {
            pages.push(this.loadImage(x.file))
          } catch {}
        }
        const [sys, user] = classNotesMessages({ session, project, extraAsk, slides, liveNotes: session.liveNotes ?? null, materials })
        system = sys
        const text = user.content + answersNote(session)
        const images = [...slides.map((x) => x.dataUrl), ...pages]
        content = images.length ? [{ type: 'text', text }, ...images.map((dataUrl) => ({ type: 'image', dataUrl }))] : text
      } else {
        const [sys, user] = summaryMessages({ session, project, projects, extraAsk })
        system = sys
        content = user.content + answersNote(session)
      }
      // 全局约定不许破折号：prompt 里说了模型偶尔还是会写，流式和存盘前都换掉；编出来的图片（会话文件夹里没有这个文件）也一样去掉
      const clean = (text) => dropMissingImages(noDashes(text), this.store.dir(id))
      // 写到服务的输出上限（2026-11-04 那节 40 页课件的课，deepseek-flash 写到 1.6 万字就停了）或连接中途断了：
      // 把写好的部分当作 AI 自己的回答交回去，让它从断开处接着写，最多续 MAX_CONTINUE 次；还是写不完才存半截报错
      const messages = [{ role: 'user', content }]
      let done = ''
      let markdown
      let cut = null
      for (let round = 0; ; round++) {
        try {
          const more = await this.llm({
            model: 'smart',
            effort: 'low',
            sessionStartedAt: session.startedAt,
            signal: ctrl.signal,
            system: system.content,
            messages,
            onDelta: (text) => this.emit('progress', { id, phase: 'summary', text: clean(joinContinued(done, text)) }),
          })
          markdown = clean(joinContinued(done, more).trim())
          break
        } catch (e) {
          if (ctrl.signal.aborted || !e?.partial?.trim()) {
            if (!done.trim()) throw e
            cut = e
          } else {
            done = joinContinued(done, e.partial)
            if (round < MAX_CONTINUE) {
              messages.splice(1, 2, { role: 'assistant', content: done }, { role: 'user', content: CONTINUE_ASK })
              continue
            }
            cut = e
          }
          // 写到一半被截断：先存下这半截再报错，长课的笔记不至于一个字都没留下
          markdown = clean(done.trim())
          break
        }
      }
      // 先把纪要存下来：待办提取失败了纪要也不丢；旧的待办先留着，提取完再换
      this.store.mutate(id, (s) => {
        s.summary = { ...(s.summary ?? {}), markdown, model: this.modelName('smart'), createdAt: Date.now() }
      })
      this.emit('saved', { id, items: false })
      if (cut) throw new Error(t(`{0}。前面写好的部分已经存下`, cut.message))
      if (!isClass) return { markdown, ...(await this.#extract(id, markdown, ctrl.signal)) }
      const [r, map] = await Promise.all([this.#extract(id, markdown, ctrl.signal), this.#slideMap(id, markdown, ctrl.signal)])
      return { markdown, ...r, ...this.#writeHtml(id, markdown, map) }
    } finally {
      this.#end(id, ctrl)
    }
  }

  /** 只重新提取待办（纪要不动）。 */
  async extract(id) {
    const s = this.store.load(id)
    this.#ready(s)
    if (!s.summary?.markdown && !s.segments.some((x) => x.text)) throw new Error(t('这场会议没有识别到内容'))
    const ctrl = this.#begin(id)
    try {
      return await this.#extract(id, s.summary?.markdown ?? '', ctrl.signal)
    } finally {
      this.#end(id, ctrl)
    }
  }

  /** 只重新做图文版课堂笔记（课堂笔记的 Markdown 不动）。→ { html, htmlError } */
  async buildHtml(id) {
    const s = this.store.load(id)
    this.#ready(s)
    if (!s.summary?.markdown) throw new Error(t('还没生成课堂笔记'))
    const ctrl = this.#begin(id)
    try {
      this.emit('progress', { id, phase: 'html', text: s.summary.markdown })
      return this.#writeHtml(id, s.summary.markdown, await this.#slideMap(id, s.summary.markdown, ctrl.signal))
    } finally {
      this.#end(id, ctrl)
    }
  }

  // 课件对照：老师讲到哪些页、每页对着哪几行讲了什么 → { slideMap, pages, error }；没课件时是空的
  async #slideMap(id, markdown, signal) {
    const session = this.store.load(id)
    if (!session.materials?.length) return { slideMap: [], pages: new Map(), error: null }
    const dir = this.store.dir(id)
    await ensureLayouts(session, dir, { renderPdf: this.renderPdf })
    const { text, pages } = materialsForMap(session, dir)
    const sections = outlineSections(markdown)
    try {
      const [system, user] = slideMapMessages({ session, markdown, sections, materialsText: text })
      const raw = await this.llm({ model: 'smart', effort: 'low', json: true, signal, timeoutMs: 180_000, sessionStartedAt: session.startedAt, system: system.content, messages: [user] })
      return { slideMap: parseSlideMap(raw, { pages, sections }), pages, error: null }
    } catch (e) {
      if (signal.aborted) throw e
      return { slideMap: [], pages, error: t(`图文笔记里的课件没对上老师讲的：{0}`, e.message) }
    }
  }

  #writeHtml(id, markdown, { slideMap, pages, error }) {
    const session = this.store.load(id)
    const dir = this.store.dir(id)
    const { project } = this.#context(session)
    const html = renderNotesHtml({ session, markdown, slideMap, pages, sessionDir: dir, projectName: project?.name ?? '', model: session.summary?.model ?? '' })
    fs.writeFileSync(path.join(dir, NOTES_HTML), html)
    this.store.mutate(id, (s) => {
      s.summary = { ...(s.summary ?? {}), slideMap, html: NOTES_HTML, htmlAt: Date.now() }
    })
    this.emit('saved', { id, items: false })
    return { html: NOTES_HTML, htmlError: error }
  }

  async #extract(id, markdown, signal) {
    this.emit('progress', { id, phase: 'items', text: markdown })
    const session = this.store.load(id)
    const { project, projects } = this.#context(session)
    const isClass = session.mode === 'class'
    let parsed
    try {
      const [system, user] = isClass
        ? classTodoMessages({ session, summary: markdown, project, liveNotes: session.liveNotes ?? null })
        : todoMessages({ session, summary: markdown, project, projects })
      const raw = await this.llm({ model: 'smart', effort: 'low', json: true, signal, timeoutMs: 120_000, sessionStartedAt: session.startedAt, system: system.content, messages: [user] })
      // 课堂的作业全部归到这节课的项目；提取时没给日期、纪要里写明了截止日期的，用纪要的日期补上
      parsed = parseTodoItems(raw, { projects: isClass ? [] : projects, fallbackProjectId: project?.id ?? INBOX_ID, startedAt: session.startedAt, summary: markdown })
      if (isClass) for (const x of parsed.items) x.owner ??= 'me'
    } catch (e) {
      if (signal.aborted) throw e
      parsed = { title: '', items: null, error: e.message }
    }
    if (parsed.error && !parsed.items?.length) {
      this.emit('saved', { id, items: false, error: parsed.error })
      return { items: session.summary?.items ?? [], title: session.title, itemsError: `待办提取失败：${parsed.error}` }
    }
    let items = []
    let title = ''
    this.store.mutate(id, (s) => {
      items = carryOver(s.summary?.items, parsed.items)
      s.summary = { ...(s.summary ?? {}), items, itemsAt: Date.now() }
      if (!s.title && parsed.title) s.title = parsed.title
      title = s.title
    })
    this.emit('saved', { id, items: true })
    return { items, title }
  }
}
