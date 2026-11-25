import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LOW_MS, Member, memberSettings } from '../src/main/member/client.js'
import { MemberLive } from '../src/main/member/live.js'
import { DEFAULTS, merge } from '../src/main/defaults.js'
import { compatConfig } from '../src/main/llm/index.js'
import { setUiLang } from '../src/main/i18n.js'

// 会员余额提醒（2026-11-25 用户定）：最后一场、只剩 10 分钟各提醒一次；用完了一条横幅、不自动弹收费页；
// 会中买了场次马上换回云识别、翻译和答题接着用。假会员服务器照 meetcaption-server 的场次规则回话，引擎用假的。

setUiLang('zh')
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-member-live-')), 'member.json')
const HOUR = 3600_000

// 假会员服务器：balance 场次余额；开一场扣 1（30 分钟内同一台接着开、没用完的回同一张票）；hb 是下一次心跳回的内容
function memberServer({ balance = 1, kind = 'paid' } = {}) {
  const srv = { balance, kind, calls: [], hb: null, n: 0, open: null, paidClaims: new Set() }
  const info = () => ({ kind: srv.kind, balance: srv.balance, sessionMs: 2 * HOUR })
  const sess = (s) => ({ session: s.token, sessionId: s.id, remainingMs: s.remainingMs, charged: 1, balance: srv.balance, exhausted: s.exhausted, idle: false })
  const routes = {
    '/v1/trial/start': () => ({ status: 200, body: { token: 'mcd_1', ...info() } }),
    '/v1/license/status': () => ({ status: 200, body: info() }),
    '/v1/license/activate': () => ((srv.balance += 10), { status: 200, body: info() }),
    '/v1/session/start': () => {
      if (srv.open && !srv.open.exhausted) return { status: 200, body: { ...sess(srv.open), resumed: true } }
      if (srv.balance < 1) return { status: 402, body: { error: { code: 'no-balance', message: '场次用完了' } } }
      srv.balance--
      srv.n++
      srv.open = { token: `mcs_${srv.n}`, id: srv.n, remainingMs: 2 * HOUR, exhausted: false }
      return { status: 200, body: sess(srv.open) }
    },
    '/v1/session/heartbeat': () => {
      Object.assign(srv.open, srv.hb ?? {})
      return { status: 200, body: { ...sess(srv.open), balance: srv.balance } }
    },
    '/v1/session/end': () => ((srv.open = null), { status: 200, body: { balance: srv.balance } }),
    '/v1/checkout': () => ({ status: 200, body: { url: 'https://checkout.test/c1', claim: 'c1' } }),
    '/v1/checkout/c1': () => (srv.paidClaims.has('c1') ? { status: 200, body: { status: 'paid', ...info() } } : { status: 200, body: { status: 'pending' } }),
  }
  srv.f = async (url, init) => {
    const p = new URL(url).pathname
    srv.calls.push({ p, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null })
    const r = routes[p]()
    return { ok: r.status === 200, status: r.status, json: async () => r.body }
  }
  // 付款：Stripe 那边付完，结账轮询下一次问到就是 paid
  srv.pay = (n) => {
    srv.balance += n
    srv.paidClaims.add('c1')
  }
  return srv
}

const S = merge(DEFAULTS, { plan: 'member' })

// 假引擎：开始、暂停、继续、按实际设置建识别；记下提示条和重连次数
class FakeEngine extends EventEmitter {
  constructor(member) {
    super()
    this.member = member
    this.state = 'idle'
    this.paused = false
    this.cfg = null
    this.session = null
    this.notices = []
    this.reconnects = 0
    this.aiResumed = 0
  }
  async start() {
    this.state = 'running'
    this.session = { startedAt: Date.now() }
    this.cfg = memberSettings(S, this.member)
  }
  refreshSettings() {
    if (this.state !== 'idle') this.cfg = memberSettings(S, this.member)
  }
  async pause() {
    this.paused = true
    this.member.setRunning(false)
  }
  async resume() {
    this.paused = false
    this.reconnects++
    this.member.setRunning(true)
  }
  resumeAi() {
    this.aiResumed++
  }
  notice(level, text, code) {
    this.notices.push({ level, text, code })
  }
  shown(code) {
    return this.notices.filter((n) => n.code === code && n.level !== 'clear')
  }
  // 界面上还看得见：这个代号最后一次是显示不是收起
  visible(code) {
    const last = this.notices.filter((n) => n.code === code).at(-1)
    return Boolean(last) && last.level !== 'clear'
  }
  cleared(code) {
    return this.notices.some((n) => n.code === code && n.level === 'clear')
  }
}

// 照 main.js 接线：开始记录、心跳后提醒、服务器说用完了、付完款
function setup(srv, file = tmpFile()) {
  const member = new Member({ file, fetch: srv.f, fingerprint: async () => 'ab'.repeat(32), api: 'https://api.test', heartbeatMs: 1e9 })
  const engine = new FakeEngine(member)
  const live = new MemberLive({ member, engine, isMember: () => true })
  member.on('update', () => live.remind())
  member.on('session', (e) => e.type === 'exhausted' && engine.state === 'running' && !engine.paused && live.stop({ type: 'exhausted' }))
  member.on('paid', () => engine.state === 'running' && live.topUp())
  const record = async () => {
    await live.begin()
    await engine.start()
    live.started()
  }
  return { member, engine, live, record }
}
const tick = () => new Promise((r) => setImmediate(r))

test('开最后一场（扣完余额 0）：提醒「这是最后一场 · 最长 2 小时」，按钮去买场次；还有场次时不提醒', async () => {
  const srv = memberServer({ balance: 1 })
  const { member, engine, record } = setup(srv)
  await member.refresh()
  await record()
  assert.deepEqual(engine.shown('member-last').map((n) => n.text), ['这是最后一场 · 最长 2 小时'])
  assert.equal(engine.shown('member-low').length, 0)
  member.stop()

  const rich = memberServer({ balance: 3 })
  const b = setup(rich)
  await b.member.refresh()
  await b.record()
  assert.equal(b.engine.notices.length, 0, '扣完还剩 2 场：什么都不说')
  b.member.stop()
})

test('余额 0、这一场的 AI 还剩 10 分钟：提醒一次（收起「最后一场」那条）；余额不是 0 时到点自动续场，不提醒', async () => {
  const srv = memberServer({ balance: 1 })
  const { member, engine, record } = setup(srv)
  await member.refresh()
  await record()
  srv.hb = { remainingMs: 25 * 60_000 }
  await member.heartbeat()
  assert.equal(engine.shown('member-low').length, 0, '还剩 25 分钟：不说')
  srv.hb = { remainingMs: LOW_MS - 20_000 }
  await member.heartbeat()
  assert.deepEqual(engine.shown('member-low').map((n) => n.text), ['这一场的 AI 还剩 10 分钟'])
  assert.ok(engine.cleared('member-last'))
  member.stop()

  const rich = memberServer({ balance: 5 })
  const b = setup(rich)
  await b.member.refresh()
  await b.record()
  rich.hb = { remainingMs: 3 * 60_000 }
  await b.member.heartbeat()
  assert.equal(b.engine.shown('member-low').length, 0, '还有 4 场：服务器到 2 小时自动续，不用提醒')
  b.member.stop()
})

test('每条提醒每一场只说一次：心跳再来、断线接上同一场、重启应用都不重复；新的一场重新算', async () => {
  const file = tmpFile()
  const srv = memberServer({ balance: 1 })
  const { member, engine, record } = setup(srv, file)
  await member.refresh()
  await record()
  srv.hb = { remainingMs: 9 * 60_000 }
  for (let i = 0; i < 5; i++) await member.heartbeat()
  assert.equal(engine.shown('member-last').length, 1)
  assert.equal(engine.shown('member-low').length, 1)
  // 应用崩了重开、30 分钟内接上同一场（同一张票）：不再提醒
  member.stop()
  const again = setup(srv, file)
  await again.member.refresh()
  await again.record()
  assert.equal(again.member.session.token, 'mcs_1')
  await again.member.heartbeat()
  assert.equal(again.engine.notices.length, 0)
  // 新的一场：重新提醒
  await again.member.endSession()
  srv.balance = 1
  const next = setup(srv, file)
  await next.member.refresh()
  await next.record()
  assert.equal(next.member.session.token, 'mcs_2')
  assert.equal(next.engine.shown('member-last').length, 1)
  again.member.stop()
  next.member.stop()
})

test('只剩不到 10 分钟才开场（接上断开的最后一场）：只说还剩几分钟，不再补「最后一场」', async () => {
  const srv = memberServer({ balance: 0 })
  srv.open = { token: 'mcs_9', id: 9, remainingMs: 4 * 60_000, exhausted: false }
  const { member, engine, record } = setup(srv)
  await member.refresh()
  await record()
  assert.deepEqual(engine.shown('member-low').map((n) => n.text), ['这一场的 AI 还剩 4 分钟'])
  assert.equal(engine.shown('member-last').length, 0)
  member.stop()
})

test('会中用完：换本地识别接着记（同一场会议），一条横幅说清楚，AI 暂停；不弹收费页', async () => {
  const srv = memberServer({ balance: 1 })
  const { member, engine, record } = setup(srv)
  await member.refresh()
  await record()
  assert.equal(engine.cfg.engine, 'soniox')
  srv.hb = { remainingMs: 0, exhausted: true }
  await member.heartbeat()
  await tick()
  assert.equal(engine.cfg.engine, 'local', '换成本地识别')
  assert.equal(engine.reconnects, 1, '识别重连一次，会议没停')
  assert.equal(engine.state, 'running')
  assert.deepEqual(engine.shown('member-exhausted').map((n) => [n.level, n.text]), [['warn', '场次用完了 · 翻译和答题先暂停，字幕和录音照常']])
  assert.ok(engine.cleared('member-last'))
  assert.equal(member.noAi, true)
  assert.equal(compatConfig(memberSettings(S, member)).key, '', 'AI 不再发请求')
  assert.match(member.noAiReason(), /翻译和答题先暂停/)
  assert.equal(srv.calls.filter((c) => c.p === '/v1/checkout').length, 0, '没有替用户开结账')
  // 心跳再说一次用完：不重复
  await member.heartbeat()
  assert.equal(engine.shown('member-exhausted').length, 1)
  member.stop()
})

test('开始记录时就没场次：本地识别记，横幅同上（开始以后才说，不被界面清掉）', async () => {
  const srv = memberServer({ balance: 0 })
  const { member, engine, live } = setup(srv)
  await member.refresh()
  await live.begin()
  assert.equal(engine.notices.length, 0, '记录还没开始：先不说')
  await engine.start()
  live.started()
  assert.equal(member.fallback, true)
  assert.equal(engine.cfg.engine, 'local')
  assert.deepEqual(engine.shown('member-exhausted').map((n) => n.text), ['场次用完了 · 翻译和答题先暂停，字幕和录音照常'])
  assert.equal(member.noAi, true)
  member.stop()
})

test('会中用完、买了场次：付完款（结账轮询到 paid）马上开新的一场，换回云识别，翻译和答题接着用；会后纪要认这一场的票', async () => {
  const srv = memberServer({ balance: 1 })
  const { member, engine, record } = setup(srv)
  await member.refresh()
  await record()
  const at = engine.session.startedAt
  srv.hb = { remainingMs: 0, exhausted: true }
  await member.heartbeat()
  await tick()
  srv.hb = null // 用完的是那一场；新开的一场照常计时
  assert.equal(engine.cfg.engine, 'local')
  // 点「去买场次」→ 收费页里买 1 场（结账网址交给浏览器），用户在浏览器里付完
  const url = await member.buy('p1', 'cny')
  assert.equal(url, 'https://checkout.test/c1')
  srv.pay(1)
  const t0 = Date.now()
  while (!engine.shown('member-resumed').length && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50))
  // 买的这 1 场接回时就用掉了，又是最后一场：这句并进接回的提示，只有这一条（2026-11-25 复审：两条横幅、数字对不上）
  assert.deepEqual(engine.shown('member-resumed').map((n) => [n.level, n.text]), [['info', '场次加上了 · 已经换回云识别，翻译和答题接着用 · 这是最后一场 · 最长 2 小时']])
  assert.equal(member.session.token, 'mcs_2', '开了新的一场')
  assert.equal(member.fallback, false)
  assert.equal(engine.cfg.engine, 'soniox', '换回云识别')
  assert.equal(engine.reconnects, 2)
  assert.equal(engine.aiResumed, 1, '撤掉这一场 AI 的停用')
  assert.ok(engine.cleared('member-exhausted'))
  assert.equal(member.noAi, false)
  assert.equal(compatConfig(memberSettings(S, member)).key, 'mcs_2')
  // 「最后一场」不再另弹一条：只有头一场开场时那一次，接回时收掉了；界面上会员的提示只剩接回那条
  assert.deepEqual(engine.shown('member-last').map((n) => n.text), ['这是最后一场 · 最长 2 小时'])
  const codes = ['member-last', 'member-low', 'member-exhausted', 'member-resumed', 'member', 'member-resume']
  assert.deepEqual(codes.filter((c) => engine.visible(c)), ['member-resumed'])
  // 这一场的提醒记过了：之后心跳不再补一条「最后一场」
  await member.heartbeat()
  await tick()
  assert.equal(engine.shown('member-last').length, 1)
  // 用完的那一场先结束了，再开新的
  const ps = srv.calls.map((c) => c.p)
  assert.ok(ps.lastIndexOf('/v1/session/end') < ps.lastIndexOf('/v1/session/start'))
  // 会后给这次记录做纪要：开始时间在新的一场之前，也认新的票
  await member.endSession()
  assert.equal(member.aiKey(at), 'mcs_2')
  assert.equal(member.noAiFor(at), false)
  member.stop()
})

test('开始时就没场次、会中输了授权码：一样马上接回；暂停着的不重连，继续时按云识别建、才开始计时', async () => {
  const srv = memberServer({ balance: 0 })
  const { member, engine, live, record } = setup(srv)
  await member.refresh()
  await record()
  assert.equal(engine.cfg.engine, 'local')
  await engine.pause() // 用户点了暂停
  await member.activate('MC-AAAA-BBBB-CCCC')
  await live.topUp()
  assert.equal(member.session.token, 'mcs_1')
  assert.equal(engine.cfg.engine, 'soniox')
  assert.equal(engine.reconnects, 0, '暂停着：不重连')
  assert.equal(member.running, false, '暂停着：不计时')
  assert.equal(engine.shown('member-resumed').length, 1)
  assert.equal(engine.shown('member-last').length, 0, '还剩 9 场')
  await engine.resume()
  assert.equal(member.running, true)
  member.stop()
})

test('不接回的情况：没在记录、没退回本地、余额还是 0；同时来两次只开一场', async () => {
  const srv = memberServer({ balance: 0 })
  const { member, engine, live, record } = setup(srv)
  await member.refresh()
  assert.equal(await live.topUp(), false, '没在记录')
  await record()
  assert.equal(await live.topUp(), false, '余额还是 0')
  srv.balance = 2
  await member.refresh()
  const [a, b] = await Promise.all([live.topUp(), live.topUp()])
  assert.equal(a, true)
  assert.equal(b, true)
  assert.equal(srv.calls.filter((c) => c.p === '/v1/session/start').length, 2, '开始时一次（402）、接回一次')
  assert.equal(await live.topUp(), false, '已经接回了')
  member.stop()
})

test('买了但会员服务器开不了这一场：说清楚，这一场还是本地识别', async () => {
  const srv = memberServer({ balance: 0 })
  const { member, engine, live, record } = setup(srv)
  await member.refresh()
  await record()
  member.info = { ...member.info, balance: 1 } // 客户端以为有了，服务器那边还没到账
  assert.equal(await live.topUp(), false)
  assert.equal(member.fallback, true)
  assert.equal(engine.cfg.engine, 'local')
  assert.match(engine.shown('member-resume')[0].text, /^场次加上了，但这一场没能接上会员服务（场次用完了），下一场就能用。$/)
  member.stop()
})

test('用完时换本地识别还没换完（机器忙、模型在载入）就买了场次：等它换完再换回云识别，不停在本地', async () => {
  const srv = memberServer({ balance: 1 })
  const { member, engine, live, record } = setup(srv)
  await member.refresh()
  await record()
  // 换到本地识别那次 resume 卡住，等放行（载入本地模型）
  let release
  const gate = new Promise((r) => (release = r))
  const built = []
  const resume = engine.resume.bind(engine)
  engine.resume = async () => {
    built.push(engine.cfg.engine)
    if (built.length === 1) await gate
    return resume()
  }
  srv.hb = { remainingMs: 0, exhausted: true }
  await member.heartbeat()
  await tick()
  srv.hb = null
  assert.ok(engine.visible('member-exhausted'), '横幅先出，不等换完识别')
  assert.equal(engine.paused, true, '换本地识别换到一半')
  await member.activate('MC-AAAA-BBBB-CCCC')
  const p = live.topUp()
  await new Promise((r) => setTimeout(r, 30))
  release()
  assert.equal(await p, true)
  assert.deepEqual(built, ['local', 'soniox'], '先换完本地，再换回云识别')
  assert.equal(engine.cfg.engine, 'soniox')
  assert.equal(engine.paused, false)
  assert.ok(!engine.visible('member-exhausted'))
  member.stop()
})
