import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { consented, consentPatch, localDay, needsConsent, UsagePing } from '../src/main/usagePing.js'
import { applyPatch, DEFAULTS } from '../src/main/defaults.js'

// 每天匿名报到一次：用户同意了才报（没问过、不同意都不报）；同一个本地日期只报一次，换一天再报；body 只有约定的六个字段；失败不抛错、这一天不记下

// consent：设置里的 usageConsent（'' 没问过 | yes | no），默认按同意了来测发送规则
function setup({ status = 204, fail = null, consent = 'yes', info = { version: '0.6.5', plan: 'own', lang: 'en' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-ping-'))
  const file = path.join(dir, 'usage-ping.json')
  const calls = []
  const logs = []
  const env = { now: new Date(2026, 9, 27, 9, 0), settings: applyPatch(DEFAULTS, { usageConsent: consent }), status, fail }
  const ping = new UsagePing({
    file,
    api: 'http://ping.test',
    enabled: () => consented(env.settings),
    info: () => info,
    platform: 'darwin',
    arch: 'arm64',
    now: () => env.now,
    log: (...a) => logs.push(a.join(' ')),
    fetch: async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) })
      if (env.fail) throw env.fail
      return { ok: env.status >= 200 && env.status < 300, status: env.status }
    },
  })
  return { ping, file, calls, logs, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

test('默认是没问过，没问过不算同意；同意 / 不同意写进设置是 yes / no', () => {
  assert.equal(DEFAULTS.usageConsent, '')
  assert.equal(consented(DEFAULTS), false)
  assert.deepEqual(consentPatch(true), { usageConsent: 'yes' })
  assert.deepEqual(consentPatch(false), { usageConsent: 'no' })
  assert.equal(consented(applyPatch(DEFAULTS, consentPatch(true))), true)
  assert.equal(consented(applyPatch(DEFAULTS, consentPatch(false))), false)
})

test('询问只在没回答过时出：点了「同意」或「不用了」都不再问', () => {
  assert.equal(needsConsent(DEFAULTS), true)
  assert.equal(needsConsent({}), true, '老设置文件里没有这个键')
  assert.equal(needsConsent(applyPatch(DEFAULTS, consentPatch(true))), false)
  assert.equal(needsConsent(applyPatch(DEFAULTS, consentPatch(false))), false)
})

test('点「不用了」：存成 no，不发', async () => {
  const s = setup({ consent: '' })
  s.env.settings = applyPatch(s.env.settings, consentPatch(false))
  assert.equal(await s.ping.tick(), 'off')
  s.env.now = new Date(2026, 9, 29, 9, 0)
  assert.equal(await s.ping.tick(), 'off')
  assert.equal(s.calls.length, 0)
  s.cleanup()
})

test('没问过不发，也不生成 id；同意后当天就发', async () => {
  const s = setup({ consent: '' })
  assert.equal(await s.ping.tick(), 'off')
  s.env.now = new Date(2026, 9, 28, 9, 0)
  assert.equal(await s.ping.tick(), 'off')
  assert.equal(s.calls.length, 0)
  assert.equal(fs.existsSync(s.file), false)
  s.env.settings = applyPatch(s.env.settings, consentPatch(true))
  assert.equal(await s.ping.tick(), 'sent')
  assert.equal(s.calls.length, 1)
  s.cleanup()
})

test('第一次打开就报，同一天第二次（重启后新对象也一样）不报', async () => {
  const s = setup()
  assert.equal(await s.ping.tick(), 'sent')
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].url, 'http://ping.test/v1/ping')
  assert.equal(s.calls[0].opts.method, 'POST')
  assert.equal(await s.ping.tick(), 'done')
  // 重启：新的对象读同一个文件
  const again = new UsagePing({ ...s.ping, file: s.file })
  assert.equal(await again.tick(), 'done')
  // 同一天晚上 23:59 也还是这一天
  s.env.now = new Date(2026, 9, 27, 23, 59)
  assert.equal(await s.ping.tick(), 'done')
  assert.equal(s.calls.length, 1)
  s.cleanup()
})

test('换一天再报，id 不变', async () => {
  const s = setup()
  await s.ping.tick()
  s.env.now = new Date(2026, 9, 28, 0, 5) // 开着跨过午夜
  assert.equal(await s.ping.tick(), 'sent')
  assert.equal(s.calls.length, 2)
  assert.equal(s.calls[0].body.id, s.calls[1].body.id)
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).day, '2026-10-28')
  s.cleanup()
})

test('不同意不发；同意过又改成不同意，第二天也不发', async () => {
  const s = setup({ consent: 'no' })
  assert.equal(await s.ping.tick(), 'off')
  assert.equal(s.calls.length, 0)
  assert.equal(fs.existsSync(s.file), false)
  s.env.settings = applyPatch(s.env.settings, consentPatch(true))
  assert.equal(await s.ping.tick(), 'sent')
  s.env.settings = applyPatch(s.env.settings, consentPatch(false))
  s.env.now = new Date(2026, 9, 28, 10, 0)
  assert.equal(await s.ping.tick(), 'off')
  assert.equal(s.calls.length, 1)
  s.cleanup()
})

test('请求体只有约定的六个字段，不带 Authorization', async () => {
  const s = setup({ info: { version: '0.6.5', plan: 'member', lang: 'zh-Hant' } })
  await s.ping.tick()
  const { body, opts } = s.calls[0]
  assert.deepEqual(Object.keys(body).sort(), ['arch', 'id', 'lang', 'plan', 'platform', 'version'])
  assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual({ ...body, id: '' }, { id: '', version: '0.6.5', platform: 'darwin', arch: 'arm64', plan: 'member', lang: 'zh-Hant' })
  assert.equal(Object.keys(opts.headers).some((h) => h.toLowerCase() === 'authorization'), false)
  assert.ok(opts.signal instanceof AbortSignal)
  // 存的 id 就是发出去的那个，文件里只有 id 和日期
  assert.deepEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), { id: body.id, day: '2026-10-27' })
  s.cleanup()
})

test('plan 只会是 member 或 own', async () => {
  const s = setup({ info: { version: '1', plan: 'whatever', lang: 'en' } })
  await s.ping.tick()
  assert.equal(s.calls[0].body.plan, 'member')
  s.cleanup()
})

test('断网、4xx、5xx 不抛错，只记日志，这一天不记下（下次检查再试）', async () => {
  for (const c of [{ fail: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) }, { status: 400 }, { status: 503 }]) {
    const s = setup(c)
    assert.equal(await s.ping.tick(), 'failed')
    assert.equal(s.logs.length, 1)
    assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).day, undefined)
    // 好了以后同一天再试能报上，用的还是同一个 id
    s.env.fail = null
    s.env.status = 204
    assert.equal(await s.ping.tick(), 'sent')
    assert.equal(s.calls[0].body.id, s.calls[1].body.id)
    s.cleanup()
  }
})

test('10 秒超时：服务器不回也不抛错', async () => {
  const s = setup()
  s.ping.timeoutMs = 50
  s.ping.fetch = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)))
  // AbortSignal.timeout 的计时器不占事件循环（Node 22 上测试会以为没事可等、直接取消）；应用里有窗口开着，不受影响
  const keep = setInterval(() => {}, 1000)
  assert.equal(await s.ping.tick(), 'failed')
  clearInterval(keep)
  assert.match(s.logs[0], /TimeoutError/)
  assert.equal(new UsagePing({ file: s.file }).timeoutMs, 10_000)
  s.cleanup()
})

test('同时来的几次只发一次；坏掉的文件当没报过', async () => {
  const s = setup()
  fs.writeFileSync(s.file, '{not json')
  const r = await Promise.all([s.ping.tick(), s.ping.tick(), s.ping.tick()])
  assert.deepEqual(r, ['sent', 'sent', 'sent'])
  assert.equal(s.calls.length, 1)
  s.cleanup()
})

test('start：几秒后报第一次，之后每隔一段检查一次；计时器 unref，不挡退出', async () => {
  const s = setup()
  s.ping.firstMs = 10
  s.ping.everyMs = 30
  s.ping.start()
  assert.equal(s.ping.timers.length, 2)
  assert.ok(s.ping.timers.every((h) => h.hasRef() === false))
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(s.calls.length, 1)
  s.env.now = new Date(2026, 9, 28, 0, 1)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(s.calls.length, 2)
  s.ping.stop()
  assert.equal(s.ping.timers.length, 0)
  s.cleanup()
})

test('localDay 用本地日期', () => {
  assert.equal(localDay(new Date(2026, 0, 5, 0, 30)), '2026-01-05')
  assert.equal(localDay(new Date(2026, 11, 31, 23, 59)), '2026-12-31')
})
