import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INBOX_ID, INBOX_NAME, ProjectStore, migrateSettingsToInbox, projectSettings, safeFolderName } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'
import { searchLibrary } from '../src/main/search.js'
import { applyPatch, DEFAULTS, merge } from '../src/main/defaults.js'

// 项目存储、旧数据迁移、会议按项目存取和移动、搜索。全在临时目录里。

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meetcaption-lib-'))
}

const trashed = []
const trash = async (dir) => {
  trashed.push(dir)
  fs.rmSync(dir, { recursive: true, force: true })
}

function library(root = tmpRoot()) {
  const projects = new ProjectStore({ root: () => root, trash }).load()
  const store = new SessionStore({ projects, trash })
  return { root, projects, store }
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

function writeLegacySession(root, name, extra = {}) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  const s = { id: name, title: '', startedAt: Date.parse('2026-05-02T10:00:00'), endedAt: Date.parse('2026-05-02T10:30:00'), segments: [{ id: 'a', speaker: '对方', startedAt: Date.parse('2026-05-02T10:01:00'), text: 'Please fix the ablation table.' }], summary: null, ...extra }
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(s))
  return dir
}

test('safeFolderName: 去掉 Windows 不认的字符，全角冒号照留', () => {
  assert.equal(safeFolderName('论文：Danish 合作'), '论文：Danish 合作')
  assert.equal(safeFolderName('a/b\\c:d*e?"f<g>h|i'), 'a b c d e f g h i')
  assert.equal(safeFolderName('  trailing dots... '), 'trailing dots')
  assert.equal(safeFolderName('CON'), 'CON_')
  assert.equal(safeFolderName('   '), '项目')
})

test('ProjectStore: 第一次 load 建「未归类」，project.json 跟着文件夹', () => {
  const { root, projects } = library()
  const inbox = projects.get(INBOX_ID)
  assert.equal(inbox.name, INBOX_NAME)
  assert.equal(inbox.folder, INBOX_NAME)
  assert.equal(readJson(path.join(root, INBOX_NAME, 'project.json')).id, INBOX_ID)
  // project.json 里不存 folder
  assert.equal(readJson(path.join(root, INBOX_NAME, 'project.json')).folder, undefined)
})

test('ProjectStore: 创建、改名同时改文件夹、颜色图标、归档，重新 load 还在', () => {
  const { root, projects } = library()
  const p = projects.create({ name: '论文：Danish 合作', description: '和 Danish 教授合写', context: 'Paper meeting', keywords: 'ablation\nWebVision', language: 'en' })
  assert.match(p.id, /^p_[0-9a-f]{12}$/)
  assert.ok(fs.existsSync(path.join(root, '论文：Danish 合作', 'project.json')))
  const q = projects.update(p.id, { name: '论文：Danish 合作（投稿）', color: 'purple', icon: 'book', archived: true, bogus: 1 })
  assert.equal(q.id, p.id)
  assert.equal(q.folder, '论文：Danish 合作（投稿）')
  assert.ok(!fs.existsSync(path.join(root, '论文：Danish 合作')))
  assert.equal(q.color, 'purple')
  assert.equal(q.icon, 'book')
  assert.equal(q.archived, true)
  assert.equal(q.bogus, undefined)
  const again = new ProjectStore({ root: () => root }).load()
  assert.deepEqual({ ...again.get(p.id) }, { ...q })
  // 归档的排在最后，「未归类」排在没归档的最后
  const r = projects.create({ name: '面试：X 公司' })
  assert.deepEqual(
    projects.list().map((x) => x.id),
    [r.id, INBOX_ID, p.id],
  )
})

test('ProjectStore: 同名项目文件夹加后缀；「未归类」不能删、不能改名、不能归档', async () => {
  const { projects } = library()
  const a = projects.create({ name: '面试' })
  const b = projects.create({ name: '面试' })
  assert.equal(a.folder, '面试')
  assert.equal(b.folder, '面试 (2)')
  // 改成和别人一样的名字：文件夹加后缀
  const c = projects.update(a.id, { name: '面试' })
  assert.equal(c.folder, '面试')
  const d = projects.update(b.id, { name: '未归类' })
  assert.equal(d.folder, '未归类 (2)')
  const inbox = projects.update(INBOX_ID, { name: '改名', archived: true, context: '默认背景' })
  assert.equal(inbox.name, INBOX_NAME)
  assert.equal(inbox.archived, false)
  assert.equal(inbox.context, '默认背景')
  await assert.rejects(() => projects.remove(INBOX_ID), /不能删除/)
})

test('ProjectStore: 复制出来的项目文件夹 id 重复时后一个换新 id', () => {
  const { root, projects } = library()
  const p = projects.create({ name: 'A' })
  fs.cpSync(path.join(root, 'A'), path.join(root, 'A copy'), { recursive: true })
  const again = new ProjectStore({ root: () => root }).load()
  const ids = again.list().map((x) => x.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes(p.id))
  const copy = again.list().find((x) => x.folder === 'A copy')
  assert.notEqual(copy.id, p.id)
  assert.equal(readJson(path.join(root, 'A copy', 'project.json')).id, copy.id)
})

test('create copyFrom：没填的会议背景、术语、我的资料、对方语言从别的项目复制', () => {
  const { projects } = library()
  const a = projects.create({ name: 'A', context: 'ctx A', keywords: 'k1', profile: 'CV', language: 'zh' })
  const b = projects.create({ name: 'B', copyFrom: a.id, context: 'ctx B' })
  assert.equal(b.context, 'ctx B')
  assert.equal(b.keywords, 'k1')
  assert.equal(b.profile, 'CV')
  assert.equal(b.language, 'zh')
})

test('projectSettings：项目的背景、术语、资料、语言叠到设置上', () => {
  const s = applyPatch(merge(DEFAULTS, {}), { context: 'global', keywords: 'g', language: 'en', assist: { profile: 'global cv', auto: false } })
  const out = projectSettings(s, { context: 'project', keywords: 'p1, p2', profile: 'project cv', language: 'zh' })
  assert.equal(out.context, 'project')
  assert.equal(out.keywords, 'p1, p2')
  assert.equal(out.language, 'zh')
  assert.equal(out.assist.profile, 'project cv')
  assert.equal(out.assist.auto, false)
  assert.equal(projectSettings(s, null), s)
})

test('迁移：根目录下的旧会议挪进「未归类」，session.json 记上 projectId；设置里的背景等只迁一次', () => {
  const root = tmpRoot()
  writeLegacySession(root, '2026-05-02 10.00')
  writeLegacySession(root, '2026-05-03 09.30', { title: '周会' })
  fs.mkdirSync(path.join(root, '别的文件夹'))
  const { projects, store } = library(root)
  const moved = store.migrateLegacy()
  assert.deepEqual(
    moved.map((m) => m.id),
    ['2026-05-02 10.00', '2026-05-03 09.30'],
  )
  assert.ok(!fs.existsSync(path.join(root, '2026-05-02 10.00')))
  assert.ok(fs.existsSync(path.join(root, INBOX_NAME, '2026-05-02 10.00', 'session.json')))
  assert.equal(readJson(path.join(root, INBOX_NAME, '2026-05-03 09.30', 'session.json')).projectId, INBOX_ID)
  assert.ok(fs.existsSync(path.join(root, '别的文件夹')), '不是会议的文件夹不动')
  assert.equal(store.load('2026-05-03 09.30').title, '周会')
  assert.deepEqual(store.migrateLegacy(), [], '第二次没东西可迁')

  let data = applyPatch(merge(DEFAULTS, {}), { context: 'Danish professor meeting', keywords: 'ablation', language: 'zh', assist: { profile: 'PhD student CV' } })
  const settings = { get: () => structuredClone(data), update: (patch) => (data = applyPatch(data, patch)) }
  assert.deepEqual(migrateSettingsToInbox(settings, projects).sort(), ['context', 'keywords', 'language', 'profile'])
  const inbox = projects.get(INBOX_ID)
  assert.equal(inbox.context, 'Danish professor meeting')
  assert.equal(inbox.keywords, 'ablation')
  assert.equal(inbox.language, 'zh')
  assert.equal(inbox.profile, 'PhD student CV')
  assert.equal(data.migrations.projects, true)
  // 用户后来清空了未归类的背景：再启动不会又迁回来
  projects.update(INBOX_ID, { context: '' })
  assert.equal(migrateSettingsToInbox(settings, projects), null)
  assert.equal(projects.get(INBOX_ID).context, '')
})

test('旧会议和未归类里的会议同名：迁移时加后缀，id 跟着改', () => {
  const root = tmpRoot()
  const { projects, store } = library(root)
  writeLegacySession(path.join(root, INBOX_NAME), '2026-05-02 10.00')
  store.reindex()
  writeLegacySession(root, '2026-05-02 10.00', { title: '根目录那场' })
  const moved = store.migrateLegacy()
  assert.equal(moved[0].id, '2026-05-02 10.00 (2)')
  const s = store.load('2026-05-02 10.00 (2)')
  assert.equal(s.title, '根目录那场')
  assert.equal(readJson(path.join(projects.dir(INBOX_ID), '2026-05-02 10.00 (2)', 'session.json')).id, '2026-05-02 10.00 (2)')
})

test('SessionStore：会议建在指定项目里，id 跨项目唯一', () => {
  const { projects, store } = library()
  const a = projects.create({ name: 'A' })
  const b = projects.create({ name: 'B' })
  const s1 = store.create({ projectId: a.id, engine: 'volc' })
  s1.endedAt = Date.now()
  store.saveNow(s1)
  const s2 = store.create({ projectId: b.id })
  s2.endedAt = Date.now()
  store.saveNow(s2)
  const s3 = store.create({ projectId: 'nope' })
  assert.notEqual(s1.id, s2.id)
  assert.match(s2.id, / \(2\)$/)
  assert.equal(s3.projectId, INBOX_ID)
  assert.ok(fs.existsSync(path.join(projects.dir(a.id), s1.id, 'session.json')))
  assert.ok(fs.existsSync(path.join(projects.dir(b.id), s2.id, 'session.json')))
  assert.equal(store.load(s2.id).projectId, b.id)
  assert.deepEqual(
    store.list({ projectId: a.id }).map((x) => x.id),
    [s1.id],
  )
  assert.equal(store.list().length, 3)
})

test('SessionStore：正在记录的那场，改标题直接改引擎手里的对象；停止后放掉', () => {
  const { store } = library()
  const s = store.create({})
  s.segments.push({ id: 'x', speaker: '对方', startedAt: Date.now(), text: 'hello' })
  store.update(s.id, { title: '新标题' })
  assert.equal(s.title, '新标题', '引擎手里的对象也改了')
  assert.equal(store.load(s.id).segments.length, 1)
  assert.ok(store.isLive(s.id))
  assert.throws(() => store.move(s.id, INBOX_ID), /正在记录/)
  s.endedAt = Date.now()
  store.saveNow(s)
  assert.equal(store.isLive(s.id), false)
  assert.equal(store.current, null)
  // 停了以后再改：读盘改盘，不碰引擎的旧对象
  store.update(s.id, { title: '会后改的' })
  assert.equal(s.title, '新标题')
  assert.equal(store.load(s.id).title, '会后改的')
})

test('SessionStore：移动会议，目标项目里有同名文件夹就加后缀；项目改名后照样能找到会议', () => {
  const { projects, store } = library()
  const a = projects.create({ name: 'A' })
  const b = projects.create({ name: 'B' })
  const s = store.create({ projectId: a.id, title: 't' })
  s.endedAt = Date.now()
  store.saveNow(s)
  // B 里已经有一个同名的非会议文件夹
  fs.mkdirSync(path.join(projects.dir(b.id), s.id))
  const moved = store.move(s.id, b.id)
  assert.equal(moved.id, `${s.id} (2)`)
  assert.equal(moved.projectId, b.id)
  assert.equal(readJson(path.join(projects.dir(b.id), moved.id, 'session.json')).projectId, b.id)
  assert.ok(!fs.existsSync(path.join(projects.dir(a.id), s.id)))
  projects.update(b.id, { name: 'B 改名' })
  assert.equal(store.load(moved.id).title, 't')
  assert.equal(store.dir(moved.id), path.join(projects.dir(b.id), moved.id))
})

test('删项目：会议挪到未归类，项目文件夹进废纸篓', async () => {
  const { projects, store } = library()
  const a = projects.create({ name: '要删的' })
  for (let i = 0; i < 2; i++) {
    const s = store.create({ projectId: a.id })
    s.endedAt = Date.now()
    store.saveNow(s)
  }
  const dir = projects.dir(a.id)
  assert.equal(store.moveAll(a.id, INBOX_ID), 2)
  await projects.remove(a.id)
  assert.ok(trashed.includes(dir))
  assert.equal(projects.has(a.id), false)
  assert.equal(store.list({ projectId: INBOX_ID }).length, 2)
})

test('SessionStore.list：带 projectId、答题数、没完成的待办数、时长', () => {
  const { projects, store } = library()
  const s = store.create({ projectId: INBOX_ID })
  s.segments.push({ id: 'a', speaker: '对方', startedAt: s.startedAt + 1000, text: 'hi' })
  s.answers = [{ id: 'x', text: 'ans' }]
  s.summary = { markdown: '# 纪要', items: [{ id: 't1', text: 'a', done: false }, { id: 't2', text: 'b', done: true }] }
  s.endedAt = s.startedAt + 65_000
  store.saveNow(s)
  const [row] = store.list()
  assert.equal(row.projectId, INBOX_ID)
  assert.equal(row.answers, 1)
  assert.equal(row.todos, 1)
  assert.equal(row.hasSummary, true)
  assert.equal(row.durationMs, 65_000)
  assert.equal(row.count, 1)
  assert.ok(projects)
})

test('SessionStore.records：没变的文件走缓存，改了的重新读', () => {
  const { store } = library()
  const s = store.create({})
  s.endedAt = Date.now()
  store.saveNow(s)
  const r1 = store.records()[0]
  assert.equal(store.records()[0], r1, '同一个对象，说明没重新读')
  store.update(s.id, { title: '改了' })
  assert.equal(store.records()[0].title, '改了')
})

test('搜索：项目、会议标题 / 纪要 / 字幕文字、待办，带匹配片段', () => {
  const { projects, store } = library()
  const a = projects.create({ name: '论文：Danish 合作', description: 'noisy labels 论文' })
  const b = projects.create({ name: '面试：X 公司' })
  const s = store.create({ projectId: a.id, title: '讨论 ablation 结果' })
  s.segments.push({ id: '1', speaker: '对方', startedAt: s.startedAt + 83_000, text: 'Please send me the revised WebVision table by next Friday.' })
  s.summary = {
    markdown: '## 一句话总结\n讨论了消融实验。\n## 我要做的事\n- 准备 X 公司的系统设计面试',
    items: [
      { id: 't1', text: '把修改后的 WebVision 表格发给教授', due: '2026-10-02', projectId: a.id, quote: 'send me the revised WebVision table', done: false },
      { id: 't2', text: '准备 X 公司的系统设计面试', due: null, projectId: b.id, done: false },
    ],
  }
  s.endedAt = Date.now()
  store.saveNow(s)
  const records = store.records()
  const all = projects.list()

  const r1 = searchLibrary({ query: 'webvision', projects: all, records })
  assert.equal(r1.sessions.length, 1)
  assert.equal(r1.sessions[0].field, 'transcript')
  assert.equal(r1.sessions[0].at, 83_000)
  const sn = r1.sessions[0]
  assert.equal(sn.snippet.slice(sn.match[0], sn.match[1]).toLowerCase(), 'webvision')
  assert.equal(r1.todos.length, 1)
  assert.equal(r1.todos[0].id, 't1')
  assert.equal(r1.todos[0].sessionId, s.id)

  const r2 = searchLibrary({ query: 'ablation', projects: all, records })
  assert.equal(r2.sessions[0].field, 'title')

  const r3 = searchLibrary({ query: '面试 系统设计', projects: all, records })
  assert.equal(r3.sessions[0].field, 'summary')
  assert.equal(r3.todos[0].projectId, b.id)

  const r4 = searchLibrary({ query: 'danish', projects: all, records })
  assert.equal(r4.projects[0].id, a.id)
  assert.equal(r4.projects[0].field, 'name')

  assert.deepEqual(searchLibrary({ query: '   ', projects: all, records }), { projects: [], sessions: [], todos: [] })
})

test('SessionStore：开会中途换了根目录，正在记录的这场继续写在原来的文件夹里', () => {
  let root = tmpRoot()
  const oldRoot = root
  const projects = new ProjectStore({ root: () => root }).load()
  const store = new SessionStore({ projects })
  const s = store.create({})
  root = tmpRoot()
  projects.load()
  store.reindex()
  s.segments.push({ id: 'x', speaker: '对方', startedAt: Date.now(), text: 'still here' })
  s.endedAt = Date.now()
  store.saveNow(s)
  assert.equal(readJson(path.join(oldRoot, INBOX_NAME, s.id, 'session.json')).segments.length, 1)
  assert.equal(store.current, null)
  assert.throws(() => store.load(s.id), /找不到这场会议/)
})
