// 端到端：会员余额提醒（2026-11-25）。真点按钮走一遍：开始记录（最后一场）→ 只剩 10 分钟 → 用完了 → 点「去买场次」→ 付款 → 会中自动接回云识别。
// 用 playwright 的 _electron 从源码启动，测试模式 E2E=1：窗口不上屏、不抢焦点，设置、会员令牌、会议库都在临时目录。
// 会员服务器和 Soniox 都是这个脚本在本机起的假服务（不连 api.us-cloud.uk，不碰 Stripe）；系统声音用 test/fixtures 里的 WAV。
// 用法（apps/meetcaption 下）：node scripts/e2e/member-balance.mjs [截图文件夹]；退出码 0 = 全过。E2E_DARK=1 截深色。
import { createRequire } from 'node:module'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const require = createRequire(import.meta.url)
const { _electron } = require('playwright')

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '')
const SHOTS = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mc-member-shots-')))
fs.mkdirSync(SHOTS, { recursive: true })
const HOUR = 3600_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 等到条件成立（机器忙时换识别、载入本地模型要十几秒）；到点了回最后一次的结果
const until = async (fn, ms = 30_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await fn()) return true
  return Boolean(await fn())
}
const steps = []
const check = (ok, what) => {
  steps.push(`${ok ? '通过' : '没过'}：${what}`)
  console.log(`${ok ? '✔' : '✖'} ${what}`)
  if (!ok) throw new Error(what)
}

/* ---------------- 假会员服务器 + 假 Soniox ---------------- */

const srv = { balance: 1, open: null, n: 0, hb: {}, paid: false, calls: [], soniox: [] }
const info = () => ({ kind: 'paid', code: 'MC-TEST-TEST-TEST', balance: srv.balance, devices: 1, sessionMs: 2 * HOUR, trialGranted: false })
const sess = (s) => ({ session: s.token, sessionId: s.id, remainingMs: s.remainingMs, charged: 1, balance: srv.balance, exhausted: s.exhausted, idle: false })
const routes = {
  'POST /v1/trial/start': () => [200, { token: 'mcd_e2e', ...info() }],
  'GET /v1/license/status': () => [200, info()],
  'POST /v1/session/start': () => {
    if (srv.balance < 1) return [402, { error: { code: 'no-balance', message: '场次用完了' } }]
    srv.balance--
    srv.open = { token: `mcs_${++srv.n}`, id: srv.n, remainingMs: 2 * HOUR, exhausted: false }
    srv.hb = {}
    return [200, sess(srv.open)]
  },
  'POST /v1/session/heartbeat': () => (srv.open ? (Object.assign(srv.open, srv.hb), [200, sess(srv.open)]) : [401, { error: { code: 'bad-session', message: 'x' } }]),
  'POST /v1/session/end': () => ((srv.open = null), [200, { balance: srv.balance }]),
  'POST /v1/session/asr-key': () => [200, { key: 'fake-soniox-key', maxMs: HOUR }],
  'POST /v1/checkout': () => [200, { url: 'https://checkout.invalid/e2e', claim: 'c1' }],
  'GET /v1/checkout/c1': () => [200, srv.paid ? { status: 'paid', ...info() } : { status: 'pending' }],
}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const key = `${req.method} ${req.url.split('?')[0]}`
    srv.calls.push(key)
    const [status, out] = routes[key]?.() ?? [404, { error: { code: 'not-found', message: `假服务器没有 ${key}` } }]
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(out))
  })
})
// Soniox：收配置和音频，每秒回一条空结果（不回就当连接死了）；记下每条连接开没开着
const wss = new WebSocketServer({ server, path: '/soniox' })
wss.on('connection', (ws) => {
  const c = { open: true }
  srv.soniox.push(c)
  const timer = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ tokens: [] })), 1000)
  ws.on('close', () => ((c.open = false), clearInterval(timer)))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const sonioxOpen = () => srv.soniox.filter((c) => c.open).length

/* ---------------- 启动应用 ---------------- */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-member-e2e-'))
const migrations = { projects: true, translateOn: true, volcSeed: true, localAsr: true, providers: true, plan: true, uiLang: true }
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ plan: 'member', memberAsr: 'cloud', uiLang: 'zh', captureMic: false, translate: false, onboarding: { done: true, shownAt: 1, demo: true }, migrations, saveDir: path.join(userData, 'documents', '会议字幕') }),
)
const electronBin = process.platform === 'darwin' ? path.join(ROOT, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron') : require('electron')
const app = await _electron.launch({
  executablePath: electronBin,
  args: ['.'],
  cwd: ROOT,
  env: {
    ...process.env,
    E2E: '1',
    MEETCAPTION_USERDATA: userData,
    MEETCAPTION_API: `http://127.0.0.1:${port}`,
    MEETCAPTION_SONIOX_URL: `ws://127.0.0.1:${port}/soniox`,
    MEETCAPTION_FAKE_SYSTEM: path.join(ROOT, 'test/fixtures/local-asr-en.wav'),
    MEETCAPTION_HEARTBEAT_MS: '1000',
  },
  timeout: 60_000,
})
let failed = null
try {
  const control = async () => {
    for (let i = 0; i < 100; i++) {
      const w = app.windows().find((p) => p.url().includes('/control/'))
      if (w) return w
      await sleep(200)
    }
    throw new Error('没等到主窗口')
  }
  const win = await control()
  await win.waitForLoadState('domcontentloaded')
  // E2E_DARK=1：截深色（测试模式下系统外观改不了，换页面的 prefers-color-scheme）
  if (process.env.E2E_DARK) await win.emulateMedia({ colorScheme: 'dark' })
  await win.setViewportSize({ width: 1180, height: 760 }).catch(() => {})
  const screen = () => app.evaluate(() => [...(globalThis.mcScreen ?? [])])
  const pricingOpen = () => win.locator('.pricing-backdrop').count()
  const notice = (text) => win.locator('#notices .callout', { hasText: text })
  const shot = async (name) => {
    const f = path.join(SHOTS, `${name}.png`)
    await win.screenshot({ path: f })
    return f
  }

  // 1. 首页点开始记录：扣完余额 0，这是最后一场
  const start = win.locator('button.home-start')
  await start.waitFor({ timeout: 30_000 })
  const before = (await screen()).length
  await start.click()
  await notice('这是最后一场').waitFor({ timeout: 30_000 })
  check((await notice('这是最后一场').innerText()).includes('这是最后一场 · 最长 2 小时'), '开最后一场：提示「这是最后一场 · 最长 2 小时」')
  check((await notice('这是最后一场').locator('button', { hasText: '去买场次' }).count()) === 1, '提示条上有「去买场次」按钮')
  check(await until(() => sonioxOpen() === 1), '用云识别（假 Soniox 连着一条）')
  await shot('1-最后一场')

  // 2. 只剩 9 分 40 秒：提醒一次
  srv.hb = { remainingMs: 9 * 60_000 + 40_000 }
  await notice('还剩').waitFor({ timeout: 15_000 })
  check((await notice('还剩').innerText()).includes('这一场的 AI 还剩 10 分钟'), '只剩不到 10 分钟：提示「这一场的 AI 还剩 10 分钟」')
  check((await notice('这是最后一场').count()) === 0, '「最后一场」那条收起了')
  await sleep(3500) // 又来了三次心跳
  check((await notice('还剩').count()) === 1, '心跳又来几次也只有一条')
  await shot('2-还剩10分钟')

  // 3. 用完了：换本地识别接着记，一条横幅，侧栏 AI 写已暂停，收费页不自己弹，主窗口也不被叫到前面
  const beforeOut = (await screen()).length
  const t3 = Date.now()
  srv.hb = { remainingMs: 0, exhausted: true }
  // 横幅在换识别之前出（以前换完本地识别才出，机器忙时超过 15 秒，这一步偶发没过）
  await notice('场次用完了').waitFor({ timeout: 15_000 })
  check(
    (await notice('场次用完了').innerText()).includes('场次用完了 · 翻译和答题先暂停，字幕和录音照常'),
    `用完了：横幅「场次用完了 · 翻译和答题先暂停，字幕和录音照常」（心跳说用完后 ${((Date.now() - t3) / 1000).toFixed(1)} 秒）`,
  )
  check((await notice('场次用完了').locator('button', { hasText: '去买场次' }).count()) === 1, '横幅上有「去买场次」')
  await sleep(5000)
  check((await pricingOpen()) === 0, '等了 5 秒，收费页没有自己打开')
  // 测试模式把「显示窗口」「用浏览器打开」记在 mcScreen：开始记录时字幕窗、答题框照常出来（显示窗口（不抢焦点）），主窗口不该被叫到前面（显示窗口）
  const all = (await screen()).slice(before)
  const sinceOut = (await screen()).slice(beforeOut)
  check(!all.some((s) => s === '显示窗口' || s.startsWith('用浏览器打开')), `从开始记录起主窗口没被叫到前面、没开浏览器（测试模式记下的：${JSON.stringify(all)}）`)
  check(sinceOut.length === 0, `用完以后什么窗口都没出来（${JSON.stringify(sinceOut)}）`)
  check(await until(() => sonioxOpen() === 0), '云识别断开，换成本地识别')
  check(await until(async () => (await win.locator('.status-chip', { hasText: '已暂停' }).count()) === 1), '侧栏 AI 状态写「已暂停」')
  check(await until(async () => (await win.locator('.status-chip', { hasText: '识别 本地' }).count()) === 1), '侧栏识别写「本地」')
  const stopBtn = win.locator('button.btn-danger', { hasText: '停止' })
  check((await stopBtn.count()) === 1 && (await stopBtn.isEnabled()), '记录还在继续（实时页的「停止」能点）')
  await shot('3-场次用完了')

  // 4. 点「去买场次」才打开收费页（先选好单买 1 场）
  await notice('场次用完了').locator('button', { hasText: '去买场次' }).click()
  await win.locator('.pricing-backdrop.is-open').waitFor({ timeout: 5000 })
  const buy = win.locator('.pricing-btn.btn-primary')
  check((await buy.innerText()).includes('购买 1 场'), `点了才打开收费页，选好单买 1 场（按钮：${(await buy.innerText()).trim()}）`)
  await sleep(400) // 收费页淡入 150ms，等它出全了再截
  await shot('4-收费页')

  // 5. 点购买：结账网址交给浏览器（测试模式不真开），在「浏览器」里付完；轮询到付款，这一场马上接回云识别
  await buy.click()
  await sleep(800)
  check(srv.calls.includes('POST /v1/checkout'), '点购买：开了结账')
  srv.balance += 1
  srv.paid = true
  // 接回要等用完时换本地识别那次换完（载入模型）：平时一两秒，机器很忙时量到过 17 秒
  const t5 = Date.now()
  await notice('场次加上了').waitFor({ timeout: 60_000 })
  const resumedIn = ((Date.now() - t5) / 1000).toFixed(1)
  // 买的这 1 场接回时就用掉了，又是最后一场：并进同一条提示，不另弹「这是最后一场」（2026-11-25 复审）
  check(
    (await notice('场次加上了').innerText()).includes('场次加上了 · 已经换回云识别，翻译和答题接着用 · 这是最后一场 · 最长 2 小时'),
    `付完款：提示「场次加上了 · 已经换回云识别，翻译和答题接着用 · 这是最后一场 · 最长 2 小时」（付款后 ${resumedIn} 秒）`,
  )
  // 「付款成功」报的余额是接回以后的，和会员卡一样（以前报付款时的 1 场，会员卡写 0 场）
  const paidToast = win.locator('.toast', { hasText: '付款成功' })
  await paidToast.waitFor({ timeout: 5000 })
  const cardCount = (await win.locator('.member-card-count b').innerText()).trim()
  check((await paidToast.innerText()).includes('现在剩 0 场') && cardCount === '0', `付款成功的余额和会员卡一样都是 0 场（提示：${(await paidToast.innerText()).replace(/\s+/g, ' ')}；会员卡：${cardCount}）`)
  check(srv.n === 2 && srv.open?.token === 'mcs_2', '会中开了新的一场（不用等下一场）')
  // 只剩接回那一条提示（接回的提示 8 秒后自己收起，所以先看；以前「这是最后一场」和「场次加上了」两条同时在）
  const left = (await win.locator('#notices .callout').allInnerTexts()).filter((x) => !x.includes('电脑太忙'))
  check(left.length === 1 && left[0].includes('场次加上了'), `横幅只剩一条「场次加上了」（${JSON.stringify(left)}）`)
  check(await until(() => sonioxOpen() === 1), `换回云识别（假 Soniox 又连上一条；连着 ${sonioxOpen()} 条、一共连过 ${srv.soniox.length} 次）`)
  check((await notice('场次用完了').count()) === 0, '用完了的横幅收起了')
  // 收费页关掉看主界面
  if (await pricingOpen()) await win.keyboard.press('Escape')
  await sleep(600)
  check(await until(async () => (await win.locator('.status-chip', { hasText: '已暂停' }).count()) === 0), '侧栏 AI 状态不再写已暂停')
  check(await until(async () => (await win.locator('.status-chip', { hasText: '识别 会员云' }).count()) === 1), '侧栏识别写回「会员云」')
  await shot('5-接回云识别')

  // 点「停止」：这一场结束
  await stopBtn.click()
  for (let i = 0; i < 50 && srv.open; i++) await sleep(200)
  check(srv.open === null, '点停止：这一场在服务器上结束了')

  // 6. 余额 0 时再开始记录：服务器 402，本地识别记，同一条横幅；收费页不自己弹
  srv.balance = 0
  await win.locator('#sidebar [data-nav="home"]').click()
  const before2 = (await screen()).length
  await win.locator('button.home-start').click()
  await notice('场次用完了').waitFor({ timeout: 30_000 })
  check((await notice('场次用完了').innerText()).includes('场次用完了 · 翻译和答题先暂停，字幕和录音照常'), '没场次时开始记录：同一条横幅，记录照常开始')
  await sleep(4000)
  check((await pricingOpen()) === 0, '等了 4 秒，收费页没有自己打开')
  const shown2 = (await screen()).slice(before2)
  check(!shown2.some((s) => s === '显示窗口' || s.startsWith('用浏览器打开')), `主窗口没被叫到前面（${JSON.stringify(shown2)}）`)
  check(sonioxOpen() === 0 && (await win.locator('.status-chip', { hasText: '识别 本地' }).count()) === 1, '用本地识别，侧栏写「本地」')
  // AI 暂停着：术语解释、翻译、答题不发请求、不另报失败，会员和 AI 的横幅只有「场次用完了」一条（以前下面还有「术语解释失败：场次用完了…」）。
  // 机器太忙时本地识别自己会报「电脑太忙」，那条和余额无关，不算
  // 等识别出整句（以前术语解释就是在这时候报的失败）再看横幅
  await win.getByText('Tuesday').first().waitFor({ timeout: 20_000 })
  await sleep(1500)
  const banners = (await win.locator('#notices .callout').allInnerTexts()).filter((x) => !x.includes('电脑太忙'))
  check(banners.length === 1 && banners[0].includes('场次用完了'), `横幅只有「场次用完了」一条，没有 AI 失败的（${JSON.stringify(banners)}）`)
  await shot('6-没场次开始记录')
  await stopBtn.click()
  await sleep(1500)
} catch (e) {
  failed = e
  console.error(e)
  // 没过时把当时的横幅打出来，偶发的也看得到是哪条
  try {
    const w = app.windows().find((p) => p.url().includes('/control/'))
    if (w) console.error('当时的横幅：', JSON.stringify(await w.locator('#notices .callout').allInnerTexts()))
  } catch {}
  try {
    const w = app.windows().find((p) => p.url().includes('/control/'))
    if (w) await w.screenshot({ path: path.join(SHOTS, '失败时.png') })
  } catch {}
} finally {
  await Promise.race([app.close(), sleep(15_000)])
  wss.close()
  server.close()
}
console.log(`\n截图：${SHOTS}\n数据：${userData}\n${steps.length} 步，${failed ? '有没过的' : '全过'}`)
process.exit(failed ? 1 : 0)
