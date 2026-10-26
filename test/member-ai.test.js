import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AI_AFTER_END_MS, Member, memberSettings, withMemberAuth } from '../src/main/member/client.js'
import { DEFAULTS, merge } from '../src/main/defaults.js'
import { compatConfig, llmStatus } from '../src/main/llm/index.js'
import { LlmError } from '../src/main/llm/errors.js'

// 会员通道的 AI 凭据：试用开完唯一一场后 24 小时内还能做纪要（重启也算），场次用完关 AI，401 换凭据再试一次。

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-member-ai-')), 'member.json')

// 假会员服务器：试用 1 场，开完余额 0；status 回 kind 和余额
function trialServer({ kind = 'trial' } = {}) {
  const calls = []
  let balance = 1
  let n = 0
  const routes = {
    '/v1/trial/start': () => ({ status: 200, body: { token: `mcd_${++n}`, kind, balance } }),
    '/v1/license/status': () => ({ status: 200, body: { kind, balance } }),
    '/v1/session/start': () => ((balance = 0), { status: 200, body: { session: 'mcs_1', sessionId: 1, remainingMs: 3600_000, charged: 1, balance } }),
    '/v1/session/heartbeat': () => ({ status: 200, body: { remainingMs: 0, charged: 1, exhausted: true, idle: false, balance } }),
    '/v1/session/end': () => ({ status: 200, body: { balance } }),
  }
  const f = async (url, init) => {
    const p = new URL(url).pathname
    calls.push({ p, auth: init.headers.Authorization })
    const r = routes[p]()
    return { ok: r.status === 200, status: r.status, json: async () => r.body }
  }
  return { f, calls }
}

const make = (file, f) => new Member({ file, fetch: f, fingerprint: async () => 'ab'.repeat(32), api: 'https://api.test', heartbeatMs: 1e9 })
const S = merge(DEFAULTS, { plan: 'member' })
const memberKey = (m) => compatConfig(memberSettings(S, m)).key

test('试用开完唯一一场：会后 AI 用这一场的票（不是空 Key），重启应用也行，过了 24 小时就不再用', async () => {
  const file = tmpFile()
  const { f } = trialServer()
  const m = make(file, f)
  await m.refresh()
  await m.startSession()
  await m.endSession()
  assert.equal(m.info.balance, 0)
  assert.equal(m.noAi, false, '刚结束那场的票还能用')
  assert.equal(memberKey(m), 'mcs_1')
  assert.equal(llmStatus(memberSettings(S, m)).ready, true, '生成纪要前的检查能过')

  // 重启：票从 member.json 读回来
  const again = make(file, f)
  await again.refresh()
  assert.equal(again.noAi, false)
  assert.equal(memberKey(again), 'mcs_1')

  // 25 小时后：不再拿旧票，试用又用完了，AI 关着
  const st = JSON.parse(fs.readFileSync(file, 'utf8'))
  st.last.endedAt = Date.now() - AI_AFTER_END_MS - 3600_000
  fs.writeFileSync(file, JSON.stringify(st))
  const later = make(file, f)
  await later.refresh()
  assert.equal(later.aiKey(), 'mcd_1', '过了 24 小时用设备令牌')
  assert.equal(later.noAi, true)
  assert.equal(memberKey(later), '')
  assert.match(later.noAiReason(), /试用场次用完/)
  m.stop()
})

test('没走到结束就退出（崩溃）：按开始时间算 24 小时', async () => {
  const file = tmpFile()
  const { f } = trialServer()
  const m = make(file, f)
  await m.refresh()
  await m.startSession()
  m.stop()
  const st = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(st.last.token, 'mcs_1')
  assert.equal(st.last.endedAt, null)
  const after = make(file, f)
  await after.refresh()
  assert.equal(memberKey(after), 'mcs_1')
  st.last.startedAt = Date.now() - AI_AFTER_END_MS - 1
  fs.writeFileSync(file, JSON.stringify(st))
  const late = make(file, f)
  await late.refresh()
  assert.equal(late.noAi, true)
})

test('场次时间用完（换成本地识别）：会中 AI 状态变成不可用，不再每句发请求；结束后 24 小时内用这张票做纪要', async () => {
  const { f } = trialServer()
  const m = make(tmpFile(), f)
  await m.refresh()
  await m.startSession()
  assert.equal(m.noAi, false)
  await m.heartbeat() // 服务器说用完了
  assert.equal(m.session.exhausted, true)
  assert.equal(m.noAi, true)
  assert.equal(llmStatus(memberSettings(S, m)).ready, false)
  assert.match(m.noAiReason(), /时间用完/)
  await m.endSession()
  assert.equal(m.noAi, false, '结束了：服务器 24 小时内让这一场做纪要')
  assert.equal(m.aiKey(), m.state.last.token)

  // 买过的：一样用这一场的票
  const paid = trialServer({ kind: 'paid' })
  const p = make(tmpFile(), paid.f)
  await p.refresh()
  await p.startSession()
  p.markExhausted()
  assert.equal(p.noAi, true)
  await p.endSession()
  assert.equal(p.noAi, false)
  assert.equal(p.aiKey(), p.state.last.token)
})

test('试用余额 0、这一场没开成（退回本地识别）：AI 关着，上一场的票不拿来翻译这一场；这一场结束后照常给上一场做纪要', async () => {
  const { f } = trialServer()
  const m = make(tmpFile(), f)
  await m.refresh()
  await m.startSession()
  await m.endSession()
  m.fallback = true // main.js：开下一场时余额不够
  assert.equal(m.noAi, true)
  await m.endSession() // 这一场停了
  assert.equal(m.fallback, false)
  assert.equal(m.noAi, false)
  assert.equal(m.aiKey(), 'mcs_1')
})

test('401 换凭据：会后的场次票不认了就改用设备令牌；设备令牌失效就重新领；进行中那一场不换', async () => {
  const paid = trialServer({ kind: 'paid' })
  const m = make(tmpFile(), paid.f)
  await m.refresh()
  await m.startSession()
  assert.equal(await m.renewAiKey('mcs_1'), false, '进行中的票不换')
  await m.endSession()
  assert.equal(await m.renewAiKey('mcs_1'), true)
  assert.equal(m.aiKey(), 'mcd_1')
  assert.equal(await m.renewAiKey('mcd_1'), true)
  assert.equal(m.aiKey(), 'mcd_2', '重新领到的设备令牌')
  assert.equal(paid.calls.filter((c) => c.p === '/v1/trial/start').length, 2)

  // 试用余额 0：票不认了以后没有能用的，不再试
  const trial = trialServer()
  const t = make(tmpFile(), trial.f)
  await t.refresh()
  await t.startSession()
  await t.endSession()
  assert.equal(await t.renewAiKey('mcs_1'), false)
  assert.equal(t.noAi, true)
})

test('withMemberAuth：会员通道 401 换凭据用新设置再试一次；别的错误、自带 Key 的不重试', async () => {
  const paid = trialServer({ kind: 'paid' })
  const m = make(tmpFile(), paid.f)
  await m.refresh()
  await m.startSession()
  await m.endSession()
  const current = () => memberSettings(S, m)
  const used = []
  const r = await withMemberAuth(m, current, async (s) => {
    used.push(s.llmKeys.member)
    if (s.llmKeys.member === 'mcs_1') throw new LlmError('auth-expired', '会员凭据失效了（401）：这一场已经结束超过 24 小时', { status: 401 })
    return 'ok'
  })
  assert.equal(r, 'ok')
  assert.deepEqual(used, ['mcs_1', 'mcd_1'])

  let n = 0
  const fail = (status) => async () => {
    n++
    throw new LlmError('x', 'x', { status })
  }
  await assert.rejects(withMemberAuth(m, current, fail(429)))
  assert.equal(n, 1)
  n = 0
  await assert.rejects(withMemberAuth(m, () => ({ ...S, plan: 'own', llmProvider: 'deepseek', llmKeys: { deepseek: 'sk' } }), fail(401)))
  assert.equal(n, 1)
  // 换了以后还是 401：只再试一次
  n = 0
  await assert.rejects(withMemberAuth(m, current, fail(401)), (e) => e.status === 401)
  assert.equal(n, 2)
})
