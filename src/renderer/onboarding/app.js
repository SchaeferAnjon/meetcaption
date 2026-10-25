'use strict'
// 首次引导第一段（design/onboarding 方向 A）：欢迎 → 麦克风 → 电脑声音（只有 Mac 要授权）→ 全部就绪。
// 授权后自己翻页；点「看看怎么用」关掉小窗，主窗口上放演示（control/guide.js）。不填 Key、不登录，会员试用在后台已经领好。
const api = window.app
const { el, icon } = ui

let init = null
let isMac = true
let step = 0
let mic = 'not-determined' // granted | denied | not-determined
let sys = 'idle' // idle | asked
let screen = 'ask' // ask | granted | skip
let member = null
let langsOpen = false

const steps = () => (isMac ? ['welcome', 'mic', 'sys', 'done'] : ['welcome', 'mic', 'done'])

function next() {
  step = Math.min(steps().length - 1, step + 1)
  render()
}

function autoNext() {
  const s = step
  setTimeout(() => {
    if (step === s) next()
  }, 600)
}

// 欢迎页上写明支持的语言（偏好「写明支持的语言」）：一行概括，点开看全部
function langsBlock() {
  const names = LANGS.map((l) => l.label).join('、')
  return el(
    'div.ob-langs',
    {},
    el(
      'button.ob-langs-sum',
      { type: 'button', 'aria-expanded': String(langsOpen), onClick: () => ((langsOpen = !langsOpen), render()) },
      icon('languages', 14),
      el('span', {}, '识别 ', el('b', { text: `${LANGS.length} 种语言` }), '，翻译成其中任意一种'),
      icon('chevron-down', 13),
    ),
    langsOpen
      ? el(
          'div.ob-langs-list',
          {},
          el('p', {}, el('b', { text: '识别和翻译：' }), names, '。'),
          el('p', {}, el('b', { text: '只做翻译：' }), '繁体中文。'),
          el('p.ob-langs-note', { text: '本地识别（免费、不联网）只认中文和英文；其他语言用云识别。' }),
        )
      : null,
  )
}

function badge(name, cls = '') {
  return el('div.ob-badge', { class: cls }, icon(name, 30))
}

function nav(canNext) {
  if (step === 0) return null
  return el(
    'div.ob-nav',
    {},
    el('button', { type: 'button', onClick: () => ((step -= 1), render()) }, '← 上一步'),
    canNext && steps()[step] !== 'done' ? el('button', { type: 'button', onClick: next }, '下一步 →') : null,
  )
}

// 拖进系统设置的权限列表就加上（偏好「拖图标授权」）：拖的是应用本身
function dragIcon(text) {
  const img = el('img', { src: '../../assets/icon.png', alt: 'MeetCaption', draggable: 'true' })
  img.addEventListener('dragstart', (e) => {
    e.preventDefault()
    api.dragApp()
  })
  return el('div.ob-drag', {}, img, el('div.t', {}, text))
}

async function askMic() {
  if (mic === 'denied') return api.openPrivacy('microphone')
  const r = await api.requestPermission('microphone')
  mic = r?.status ?? mic
  render()
  if (mic === 'granted') autoNext()
}

async function askSys() {
  await api.requestPermission('systemAudio')
  sys = 'asked'
  render()
}

async function askScreen() {
  const r = await api.requestPermission('screen')
  screen = r?.status === 'granted' ? 'granted' : 'ask'
  if (screen !== 'granted') api.openPrivacy('screen')
  render()
}

function doneText() {
  const info = member?.info
  if (init.settings?.plan !== 'member') return '字幕用本地识别，在你电脑上跑，一直免费。翻译和 AI 答题用你在设置里配好的服务。'
  if (!info) return member?.error ? `会员服务器暂时连不上（${member.error}）。字幕照常能用（本地识别），连上以后自动送你 1 场。` : '正在领取免费试用…'
  if (info.balance > 0) return `${info.kind === 'paid' ? '你的会员还剩' : '送你的'} ${info.balance} 场已经到账：每场最长 ${(info.sessionMs ?? 2 * 3600_000) / 3600_000} 小时，云识别和翻译、AI 答题、笔记都不用配 Key。用完以后字幕照常，AI 再买场次或换自带 Key。`
  return '这台电脑的试用场次已经用过了。字幕照常能用（本地识别）；AI 在「设置 → 会员」里买场次或换自带 Key。'
}

function render() {
  const key = steps()[step]
  let body = []
  if (key === 'welcome') {
    body = [
      el('img.ob-logo', { src: '../../assets/icon.png', alt: '' }),
      el('h2', { text: '欢迎使用 MeetCaption' }),
      el('p', { text: '开会、面试、上网课时，对方说的每一句都实时出字幕和译文；问题一来，答案就到。简单几步就能开始。' }),
      langsBlock(),
      el('button.btn.btn-primary.ob-cta', { type: 'button', onClick: next }, '开始设置'),
    ]
  } else if (key === 'mic') {
    body = [
      badge('mic'),
      el('h2', { text: '允许使用麦克风' }),
      el('p', { text: '听你自己说的话，分清哪句是你说的；教室现场上课也靠它。' }),
      mic === 'granted'
        ? el('span.ob-pill.is-ok', {}, icon('check', 13), '已允许')
        : [
            el('button.btn.btn-primary.ob-cta', { type: 'button', onClick: askMic }, mic === 'denied' ? '去系统设置开启' : '允许麦克风'),
            el('span.ob-pill', { text: mic === 'denied' ? '之前拒绝过 · 在系统设置里打开 MeetCaption 的开关' : '等待授权…' }),
          ],
      nav(mic === 'granted' || mic === 'denied'),
    ]
  } else if (key === 'sys') {
    body = [
      badge('volume-2'),
      el('h2', { text: '允许录电脑的声音' }),
      el('p', {}, '会议软件里对方的声音从这里来。', el('b', { text: '只录声音，不录画面。' })),
      sys === 'asked'
        ? el('span.ob-pill.is-ok', {}, icon('check', 13), '弹框里点了「允许」就好了')
        : el('button.btn.btn-primary.ob-cta', { type: 'button', onClick: askSys }, '允许录电脑的声音'),
      sys === 'asked'
        ? dragIcon([el('b', { text: '没弹框？' }), '打开「系统设置 → 隐私与安全性 → 录屏与系统录音」，把左边的图标拖进「仅系统录音」列表。', ' ', el('a', { href: '#', onClick: (e) => (e.preventDefault(), api.openPrivacy('screen')) }, '打开系统设置')])
        : null,
      el(
        'div.ob-opt',
        {},
        icon('monitor', 18),
        el('div', {}, el('div.t', { text: '屏幕截图（可选）' }), el('div.d', { text: 'AI 答题时带上屏幕，看得到 PPT 上的题；网课能截课件。' })),
        screen === 'granted'
          ? el('span.ob-pill.is-ok', { text: '已允许' })
          : screen === 'skip'
            ? el('span.ob-pill', { text: '先不用' })
            : [el('button.btn.btn-sm', { type: 'button', onClick: askScreen }, '允许'), el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => ((screen = 'skip'), render()) }, '跳过')],
      ),
      nav(true),
    ]
  } else {
    const accel = init.settings?.hotkeyRecord
    body = [
      badge('check', 'is-ok'),
      el('h2', { text: '全部就绪' }),
      el('p', { text: doneText() }),
      accel ? el('div.ob-keys', {}, '开会时按', ui.kbd(accel, { size: 'sm' }), '开始记录') : null,
      el('button.btn.btn-primary.ob-cta', { type: 'button', onClick: () => api.finishOnboarding() }, '看看怎么用'),
      nav(false),
    ]
  }
  document.getElementById('body').replaceChildren(...body.flat().filter(Boolean))
  document.getElementById('dots').replaceChildren(...steps().map((_, i) => el('i', { class: i === step ? 'on' : '' })))
}

// 系统设置里改了麦克风开关，回到窗口时更新
async function refreshMic() {
  const p = await api.permissionStatus()
  if (!p) return
  const was = mic
  mic = p.microphone ?? mic
  if (p.screen === 'granted') screen = 'granted'
  if (was !== mic || steps()[step] === 'sys') render()
  if (was !== 'granted' && mic === 'granted' && steps()[step] === 'mic') autoNext()
}

async function boot() {
  init = await api.init()
  ui.applyChrome(init.chrome)
  isMac = init.platform === 'darwin'
  member = init.member ?? null
  mic = init.permissions?.microphone ?? mic
  if (init.permissions?.screen === 'granted') screen = 'granted'
  api.on('member:update', (snap) => {
    member = snap
    if (steps()[step] === 'done') render()
  })
  window.addEventListener('focus', refreshMic)
  setInterval(() => steps()[step] === 'mic' && mic !== 'granted' && refreshMic(), 1000)
  // Enter = 当前页的主按钮
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return
    document.querySelector('.ob-cta')?.click()
  })
  render()
}

boot()
