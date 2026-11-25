import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as F from '../src/main/canvas/format.js'
import { muxOpusWebm, packetRecord, readPackets } from '../src/main/canvas/webm.js'
import { Mixer } from '../src/main/canvas/audioRec.js'
import { AudioStore, ensureIgnored, listFiles } from '../src/main/canvas/audioStore.js'
import { CanvasLink, inferSchedule, matchFolder, sessionCues } from '../src/main/canvas/link.js'
import { LINKS_FILE } from '../src/main/canvas/familyLinks.js'
import { openMedia } from '../src/main/video/demux.js'
import { ProjectStore } from '../src/main/projects.js'
import { SessionStore } from '../src/main/sessions.js'

// 画布笔记联动（MeetCaption 这一侧）：库里的写法、录音的封装和混音、三种录音存法和迁移、连库写一篇上课记录。

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'canvas')
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

/* ---------------- 写法和 @cn/format 逐字一样 ---------------- */

test('上课记录：和画布笔记 writeMcRecord 写的样本逐字一样（样本由 packages/format/test/meetcaption-js.test.ts 生成）', () => {
  const drafts = JSON.parse(fs.readFileSync(path.join(FIX, 'drafts.json'), 'utf8'))
  drafts.forEach((d, i) => assert.equal(F.writeMcRecord(d), fs.readFileSync(path.join(FIX, `record-${i + 1}.md`), 'utf8'), `样本 ${i + 1}`))
})

test('深链：start、open 认得出，别的不认', () => {
  assert.deepEqual(F.parseMcUrl('meetcaption://start?project=ecp&mode=online&source=system&back=%E8%AF%BE%E7%A8%8B%2FECP'), { kind: 'start', project: 'ecp', mode: 'online', source: 'system', back: '课程/ECP' })
  assert.deepEqual(F.parseMcUrl('meetcaption://open?session=2026-11-04%2009.29&t=840'), { kind: 'open', session: '2026-11-04 09.29', t: 840 })
  assert.deepEqual(F.parseMcUrl('meetcaption://open?session=x&t=-3&view=screen'), { kind: 'open', session: 'x', t: 0, view: 'screen' })
  assert.equal(F.parseMcUrl('meetcaption://open?t=3'), null)
  assert.equal(F.parseMcUrl('canvas-notes://open?file=a.md'), null)
  assert.equal(F.parseMcUrl('meetcaption://start?mode=bogus').mode, undefined)
})

/* ---------------- WebM 封装 ---------------- */

test('录音封装：带 Duration、SeekHead 指向 Cues，每 5 秒一个 Cluster；自己的解封装读得回时长和包数', async () => {
  const packets = Array.from({ length: 1000 }, (_, i) => ({ ts: i * 20000, dur: 20000, data: Buffer.from([0xf8, i & 0xff, 1, 2]) }))
  const buf = muxOpusWebm(packets)
  const dir = tmp('mc-webm-')
  const f = path.join(dir, 'a.webm')
  fs.writeFileSync(f, buf)
  const m = await openMedia(f)
  assert.equal(m.audio.codec?.toLowerCase().includes('opus') || m.audio.codec === 'A_OPUS', true, JSON.stringify(m.audio))
  assert.equal(m.audio.count, 1000)
  assert.ok(Math.abs(m.durationMs - 20000) < 50, `时长 ${m.durationMs}`)
  // Cues 在最后，SeekHead 里写着它的位置
  const seg = buf.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]))
  const cues = buf.lastIndexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]))
  const seekPos = buf.indexOf(Buffer.from([0x53, 0xab, 0x84, 0x1c, 0x53, 0xbb, 0x6b]))
  const pos = Number(buf.readBigUInt64BE(seekPos + 7 + 3))
  const sizeLen = 8 - Math.floor(Math.log2(buf[seg + 4])) // 段大小的 vint 有几个字节
  assert.equal(seg + 4 + sizeLen + pos, cues)
  assert.equal(buf.subarray(cues).filter((b, i, a) => b === 0xbb && a[i + 1] !== undefined).length >= 4, true)
})

test('包文件：最后半包（写到一半崩了）丢掉', () => {
  const dir = tmp('mc-pk-')
  const f = path.join(dir, 'p')
  fs.writeFileSync(f, Buffer.concat([packetRecord({ ts: 0, dur: 20000, data: Buffer.from([1, 2]) }), packetRecord({ ts: 20000, dur: 20000, data: Buffer.from([3]) }).subarray(0, 20)]))
  assert.deepEqual(readPackets(f).map((p) => [p.ts, [...p.data]]), [[0, [1, 2]]])
})

/* ---------------- 混音 ---------------- */

test('混音：两路按墙上时间对齐相加；暂停那段补静音，录音的第 t 秒就是这一场开始后的第 t 秒', () => {
  let now = 1000
  const out = []
  const mx = new Mixer({ startAt: 1000, now: () => now, out: (p) => out.push(...p), rate: 100 })
  const chunk = (v, n) => Buffer.from(new Int16Array(n).fill(v).buffer)
  now = 1500
  mx.push('system', chunk(1000, 50), 100)
  mx.push('mic', chunk(500, 50), 100)
  assert.equal(out.length, 20) // 留 0.3 秒等别的路
  assert.equal(out[10], 1000) // 那时麦克风还没到
  // 暂停 10 秒，之后只有电脑声音（16 kHz 的块降到 100）
  now = 11500 + 1000
  mx.push('system', chunk(2000, 160 * 100), 16000)
  mx.end()
  assert.equal(out.length, 1150)
  assert.equal(out[30], 1500) // 两路相加
  assert.equal(out[600], 0) // 暂停那段是静音
  assert.equal(out[1149], 2000)
})

/* ---------------- 三种录音存法 ---------------- */

const gitOk = (() => {
  try {
    execFileSync('git', ['lfs', 'version'], { env: { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` } })
    return true
  } catch {
    return false
  }
})()

function seed(root) {
  fs.mkdirSync(path.join(root, '课程/ECP/上课记录/2026-11-04 ECP'), { recursive: true })
  fs.writeFileSync(path.join(root, '课程/ECP/上课记录/2026-11-04 ECP/录音-1.webm'), Buffer.alloc(5000, 7))
  fs.writeFileSync(path.join(root, '课程/ECP/上课记录/2026-11-04 ECP/画面-09.41.12.jpg'), Buffer.alloc(300, 9))
}
const trashTo = (dir) => async (p) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.renameSync(p, path.join(dir, `${Date.now()}-${path.basename(p)}`))
}

test('只存本机：库里普通文件夹，主库 .gitignore 跳过它（只加一次）', async () => {
  const v = tmp('mc-vault-')
  const st = new AudioStore({ vault: v, cfg: { mode: 'local' }, trash: trashTo(tmp('mc-trash-')) })
  await st.prepare()
  assert.equal(st.actual(), 'local')
  assert.equal(ensureIgnored(v), false)
  assert.equal(fs.readFileSync(path.join(v, '.gitignore'), 'utf8'), '/.canvas-notes/录音/\n')
})

test('iCloud：录音那一处是替身，文件真身在 iCloud 文件夹里，库里的路径照样读得到', async () => {
  const v = tmp('mc-vault-')
  const cloud = path.join(tmp('mc-icloud-'), 'MeetCaption 录音', 'vault')
  const st = new AudioStore({ vault: v, cfg: { mode: 'icloud', icloudDir: cloud }, trash: trashTo(tmp('mc-trash-')) })
  await st.prepare()
  assert.equal(st.actual(), 'icloud')
  seed(st.root)
  assert.ok(fs.existsSync(path.join(cloud, '课程/ECP/上课记录/2026-11-04 ECP/录音-1.webm')))
  assert.equal(fs.readFileSync(path.join(v, '.canvas-notes/录音/课程/ECP/上课记录/2026-11-04 ECP/录音-1.webm')).length, 5000)
})

test('Git LFS：单独的仓库，录音存好就提交、推到远端（本机 bare 仓库代替 GitHub），远端里是 LFS 对象、克隆下来先只有指针', { skip: !gitOk && '没装 git-lfs' }, async () => {
  const v = tmp('mc-vault-')
  const remote = path.join(tmp('mc-remote-'), 'vault-录音.git')
  execFileSync('git', ['init', '-q', '--bare', remote])
  const st = new AudioStore({ vault: v, cfg: { mode: 'lfs', remote }, trash: trashTo(tmp('mc-trash-')) })
  await st.prepare()
  seed(st.root)
  const r = await st.saved('录音：测试')
  assert.equal(r.pushed, true)
  assert.match(execFileSync('git', ['-C', remote, 'log', '--oneline']).toString(), /录音：测试/)
  const clone = path.join(tmp('mc-clone-'), 'c')
  execFileSync('git', ['clone', '-q', remote, clone], { env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', PATH: `${process.env.PATH}:/opt/homebrew/bin` } })
  assert.match(fs.readFileSync(path.join(clone, '课程/ECP/上课记录/2026-11-04 ECP/录音-1.webm'), 'utf8'), /^version https:\/\/git-lfs/)
})

test('换存法：本机 → LFS → iCloud → 本机，文件一个不少；原来的那份进废纸篓；取消时什么都不动', { skip: !gitOk && '没装 git-lfs' }, async () => {
  const v = tmp('mc-vault-')
  const trash = tmp('mc-trash-')
  const remote = path.join(tmp('mc-remote-'), 'r.git')
  execFileSync('git', ['init', '-q', '--bare', remote])
  const st = new AudioStore({ vault: v, cfg: { mode: 'local' }, trash: trashTo(trash) })
  await st.prepare()
  seed(st.root)
  const want = listFiles(st.root)
  const steps = []
  await st.migrate('lfs', { remote }, { onProgress: (p) => steps.push(p.phase) })
  assert.equal(st.actual(), 'lfs')
  assert.ok(steps.includes('push'))
  assert.match(execFileSync('git', ['-C', remote, 'log', '--oneline']).toString(), /换成 Git LFS/)
  // 取消：拷到一半停下，iCloud 里不留半截，库里还是 LFS
  const cloud = path.join(tmp('mc-icloud-'), 'v')
  const ac = new AbortController()
  await assert.rejects(
    st.migrate('icloud', { icloudDir: cloud }, { signal: ac.signal, onProgress: (p) => p.phase === 'copy' && p.done === 1 && ac.abort() }),
    (e) => e.code === 'cancelled',
  )
  assert.equal(st.actual(), 'lfs')
  assert.deepEqual(listFiles(st.root), want)
  assert.deepEqual(fs.existsSync(cloud) ? listFiles(cloud) : [], [])
  await st.migrate('icloud', { icloudDir: cloud })
  assert.equal(st.actual(), 'icloud')
  assert.deepEqual(listFiles(cloud), want)
  assert.ok(fs.readdirSync(trash).length >= 1, '原来的仓库进了废纸篓')
  await st.migrate('local')
  assert.equal(st.actual(), 'local')
  assert.deepEqual(listFiles(st.root), want)
  assert.deepEqual(listFiles(cloud), want, 'iCloud 那份不动')
  assert.equal(fs.readFileSync(path.join(st.root, want[0])).length, fs.statSync(path.join(cloud, want[0])).size)
})

/* ---------------- 连库、写一篇 ---------------- */

function fakeSettings(init) {
  let s = { canvasVault: '', canvasAudio: 'local', canvasLfsRemote: '', canvasIcloudDir: '', recordAudio: true, ...init }
  return { get: () => s, update: (p) => (s = { ...s, ...p }) }
}

function setup() {
  const docs = tmp('mc-docs-')
  const vault = tmp('mc-vault-')
  fs.mkdirSync(path.join(vault, '30-Courses', 'ECP-Emerging-Computing'), { recursive: true })
  const projects = new ProjectStore({ root: () => docs }).load()
  const ecp = projects.create({ name: 'ECP', mode: 'class' })
  const store = new SessionStore({ projects })
  const engine = new EventEmitter()
  const userData = tmp('mc-ud-')
  const settings = fakeSettings({ canvasVault: vault })
  const link = new CanvasLink({ engine, store, projects, settings, userData, appData: tmp('mc-appdata-'), trash: trashTo(tmp('mc-trash-')) })
  return { docs, vault, projects, ecp, store, engine, userData, settings, link }
}

function fakeSession(store, projectId, startedAt, extra = {}) {
  const s = store.create({ projectId, mode: 'class', classSource: 'system' })
  const dir = store.dir(s.id)
  fs.mkdirSync(path.join(dir, 'slides'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'slides', 'a.jpg'), Buffer.from('jpg'))
  fs.writeFileSync(path.join(dir, '录音.webm'), Buffer.from('webm'))
  Object.assign(s, {
    startedAt,
    endedAt: startedAt + 50 * 60_000,
    segments: [
      { id: 'a', text: 'Good morning. Homework is due Wednesday.', speaker: '老师', startedAt: startedAt + 2000, endedAt: startedAt + 6000, sentences: [{ text: 'Good morning.', tr: '早上好。' }, { text: 'Homework is due Wednesday.', tr: '作业周三交。' }] },
      { id: 'b', text: 'Approximate adders.', speaker: '老师', startedAt: startedAt + 600_000, sentences: [] },
    ],
    liveNotes: { sections: [{ title: '动机', start: '00:00', points: ['能耗', '误差'] }, { title: '近似加法器', start: '10:00', points: [] }], homework: [{ text: '列三种加法器', due: '2026-11-11' }] },
    slides: [{ file: 'slides/a.jpg', at: startedAt + 700_000 }],
    summary: { markdown: '# 课堂笔记\n\n这节课讲了近似加法器。\n\n## 大纲', items: [{ text: '列三种近似加法器', due: '2026-11-11', at: 4000, owner: 'me' }, { text: '老师发课件', owner: 'other' }] },
    audio: { file: '录音.webm' },
    ...extra,
  })
  store.saveNow(s)
  return s
}

test('连库：meetcaption.json 每个项目对上文件夹（「ECP-Emerging-…」认作 ECP），课表从上课时间推，库里写过的 calendar、folder 保留', async () => {
  const { link, vault, ecp } = setup()
  await link.connect()
  const map = JSON.parse(fs.readFileSync(path.join(vault, '.canvas-notes/meetcaption.json'), 'utf8'))
  const p = map.projects.find((x) => x.id === ecp.id)
  assert.equal(p.folder, '30-Courses/ECP-Emerging-Computing')
  assert.equal(p.mode, 'class')
  assert.equal(p.name, 'ECP')
  assert.deepEqual(map.audio, { store: 'local', path: '.canvas-notes/录音' })
  map.projects[0].calendar = 'Emerging Computing'
  map.projects[0].folder = '课/ECP'
  fs.writeFileSync(path.join(vault, '.canvas-notes/meetcaption.json'), JSON.stringify(map))
  link.writeMap()
  const again = JSON.parse(fs.readFileSync(path.join(vault, '.canvas-notes/meetcaption.json'), 'utf8'))
  assert.equal(again.projects[0].calendar, 'Emerging Computing')
  assert.equal(again.projects[0].folder, '课/ECP')
  const wed = new Date(2026, 10, 4, 9, 29).getTime()
  assert.deepEqual(inferSchedule([wed, wed + 7 * 86400_000, wed + 86400_000], wed + 8 * 86400_000), [{ weekday: 3, time: '09:30' }])
  assert.equal(matchFolder(['a/ECPX', 'b/ECP 课'], 'ECP'), 'b/ECP 课')
})

test('连库算同意：用户点连库时家族联动 mc-write、mc-todo 一起拨开（库里 联动.json，别的开关照旧、写法和 @cn/family 一样）；启动时自动重连不动；断开库后 mc-todo 不变', async () => {
  const { link, vault } = setup()
  const file = path.join(vault, LINKS_FILE)
  // 启动时重连（没点过）：不写
  await link.connect()
  assert.equal(fs.existsSync(file), false)
  // 画布笔记那边拨过别的开关；用户在设置里点连库
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{\n  "ct-open": false\n}\n')
  await link.connect(vault, { agree: true })
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "ct-open": false,\n  "mc-todo": true,\n  "mc-write": true\n}\n')
  // 断开：两条都不关
  link.disconnect()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { 'ct-open': false, 'mc-todo': true, 'mc-write': true })
  // 用户后来在家族设置里关了 mc-todo：启动时重连不再打开
  fs.writeFileSync(file, '{\n  "mc-todo": false,\n  "mc-write": true\n}\n')
  await link.connect(vault)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['mc-todo'], false)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), [])
})

test('上课 → 下课：live 文件、一篇上课记录（作业带 ▶ 和 📅、关键画面、录音）、字幕 vtt；同一天一小时内的下一场并进同一篇；改过的不盖', async () => {
  const { link, vault, store, ecp, engine, userData } = setup()
  await link.connect()
  const t0 = new Date(2026, 10, 4, 9, 29, 0).getTime()
  const s1 = fakeSession(store, ecp.id, t0)
  link.expectBack('30-Courses/ECP-Emerging-Computing')
  engine.emit('state', { state: 'running', sessionId: s1.id })
  const live = JSON.parse(fs.readFileSync(path.join(userData, 'canvas-notes-live.json'), 'utf8'))
  assert.equal(live.session, s1.id)
  assert.equal(live.project, ecp.id)
  assert.equal(live.mode, 'online')
  assert.equal(live.file, `30-Courses/ECP-Emerging-Computing/上课记录/2026-11-04 ECP.md`)
  engine.emit('state', { state: 'idle', lastSessionId: s1.id })
  const r = await link.finished(s1.id)
  assert.equal(r.ok, true)
  const md = fs.readFileSync(path.join(vault, live.file), 'utf8')
  assert.match(md, new RegExp(`^meetcaption: \\["${s1.id}"\\]$`, 'm'))
  assert.match(md, /^- \[ \] 列三种近似加法器 \[▶ \d\d:\d\d\]\(meetcaption:\/\/open\?session=.*&t=4\) 📅 2026-11-11$/m)
  assert.doesNotMatch(md, /老师发课件/)
  assert.match(md, /^> \[!ai\] 这节课讲了什么 · MeetCaption\n> 这节课讲了近似加法器。/m)
  assert.match(md, /^## 近似加法器 \[▶ /m)
  assert.match(md, /!\[关键画面 09:40:40\]\(\.\.\/\.\.\/\.\.\/\.canvas-notes\//)
  const recDir = path.join(vault, '.canvas-notes/录音/30-Courses/ECP-Emerging-Computing/上课记录/2026-11-04 ECP')
  assert.deepEqual(fs.readdirSync(recDir).sort(), ['录音-1.webm', '画面-09.40.40.jpg'])
  const vtt = fs.readFileSync(path.join(vault, `.canvas-notes/字幕/meetcaption/${s1.id}.vtt`), 'utf8')
  assert.match(vtt, /<v 老师>Good morning\.\n早上好。/)
  const ended = JSON.parse(fs.readFileSync(path.join(userData, 'canvas-notes-live.json'), 'utf8'))
  assert.equal(ended.endedAt, s1.endedAt)
  assert.equal(ended.todos, 1)
  assert.match(link.continueUrl(s1.id, 840), /^canvas-notes:\/\/open\?file=30-Courses%2FECP-Emerging-Computing%2F.*&t=840&session=.*&back=30-Courses%2FECP-Emerging-Computing&vault=/)
  assert.match(link.continueUrl('不存在的场', 3), /^canvas-notes:\/\/meetcaption\?session=/)

  // 下一场：下课后 30 分钟开始，并进同一篇，录音-2
  const s2 = fakeSession(store, ecp.id, s1.endedAt + 30 * 60_000)
  engine.emit('state', { state: 'running', sessionId: s2.id })
  engine.emit('state', { state: 'idle', lastSessionId: s2.id })
  const r2 = await link.finished(s2.id)
  assert.equal(r2.file, live.file)
  assert.equal(r2.audio, '.canvas-notes/录音/30-Courses/ECP-Emerging-Computing/上课记录/2026-11-04 ECP/录音-2.webm')
  const md2 = fs.readFileSync(path.join(vault, live.file), 'utf8')
  assert.match(md2, /^## 第 2 段 · /m)

  // 用户在画布笔记里改了那一篇：纪要再生成也不盖
  fs.appendFileSync(path.join(vault, live.file), '\n我自己的笔记\n')
  const r3 = link.refresh(s2.id)
  assert.equal(r3.edited, true)
  assert.match(fs.readFileSync(path.join(vault, live.file), 'utf8'), /我自己的笔记/)
})

test('字幕：一段里几句按字数分时间，第一行原文、第二行译文', () => {
  const s = { startedAt: 0, segments: [{ text: 'ab cd', speaker: '对方', startedAt: 1000, endedAt: 3000, sentences: [{ text: 'ab', tr: '甲' }, { text: 'cdef', tr: '乙' }] }] }
  const c = sessionCues(s)
  assert.equal(c.length, 2)
  assert.ok(Math.abs(c[0].end - (1 + 2 / 3)) < 1e-9)
  assert.equal(c[1].tr, '乙')
  assert.match(F.writeVtt(c), /^00:00:01\.000 --> 00:00:01\.667\n<v 对方>ab\n甲$/m)
})

test('Git LFS：远端已有别的设备推的录音，这台 Mac 新建的仓库接上去推，不删别人的、旧录音只拿指针', { skip: !gitOk && '没装 git-lfs' }, async () => {
  const remote = path.join(tmp('mc-remote-'), 'r.git')
  execFileSync('git', ['init', '-q', '--bare', remote])
  const a = new AudioStore({ vault: tmp('mc-vault-a-'), cfg: { mode: 'lfs', remote }, trash: trashTo(tmp('mc-trash-')) })
  await a.prepare()
  seed(a.root)
  await a.saved('录音：别的设备')
  const b = new AudioStore({ vault: tmp('mc-vault-b-'), cfg: { mode: 'local' }, trash: trashTo(tmp('mc-trash-')) })
  await b.prepare()
  fs.mkdirSync(path.join(b.root, '课程/EH'), { recursive: true })
  fs.writeFileSync(path.join(b.root, '课程/EH/录音-1.webm'), Buffer.alloc(800, 3))
  const r = await b.migrate('lfs', { remote })
  assert.equal(r.pushError, undefined)
  const tree = execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'main']).toString()
  assert.match(tree, /课程\/EH\/录音-1\.webm/)
  assert.match(tree, /2026-11-04 ECP\/录音-1\.webm/)
  assert.match(fs.readFileSync(path.join(b.root, '课程/ECP/上课记录/2026-11-04 ECP/录音-1.webm'), 'utf8'), /^version https:\/\/git-lfs/)
})
