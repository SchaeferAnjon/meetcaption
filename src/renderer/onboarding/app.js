'use strict'
// 首次引导（design/onboarding-v2 方向 A「侧栏五步加导览」，另加一步录声纹）：左边步骤栏，右边一屏只做一件事，
// 欢迎 → 授权（拖兔子图标进系统设置）→ 语言 → 试听 → 声纹（可跳过）→ 可以开始；走完在主窗口上导览四处（control/guide.js）。
// 每换一步存下步号：被系统授权的「退出并重新打开」打断的，重开后从这一步接着来；换界面语言重新载入也停在这一步。
const api = window.app
const P = window.parts
const { el, icon } = ui

const UI_LANGS = [['zh', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano']]
const UI_NAME = Object.fromEntries(UI_LANGS)

// 欢迎页大标题：九种界面语言各写一句（不走 t()：没选界面语言时九种轮着放）
const TITLES = {
  zh: '对方说的每一句，实时出双语字幕',
  'zh-Hant': '對方說的每一句，即時出雙語字幕',
  en: 'Live bilingual captions for every sentence they say',
  ja: '相手の一文一文に、リアルタイムで二か国語字幕',
  ko: '상대가 하는 모든 말에 실시간 이중 언어 자막',
  de: 'Live-Untertitel in zwei Sprachen für jeden Satz',
  fr: 'Des sous-titres bilingues en direct pour chaque phrase',
  es: 'Subtítulos bilingües en directo para cada frase',
  it: 'Sottotitoli bilingui in diretta per ogni frase',
}

// 例句（shared/langs.js）：欢迎页演示、语言页的字幕示例、试听时朗读的示例
const { SENT, QQ, AA } = window.SAMPLES
const LANGS_LINE = ['English', '中文', '日本語', '한국어', 'Deutsch', 'Français', 'Español']

let init = null
let isMac = true
const S = {
  step: 'welcome',
  seen: 0, // 走到过的最远一步
  resumed: false, // 被系统重开打断后接着出：顶上说一声，换一步就收起
  resumedWhat: [], // 重开前拖过的：'sys' | 'scr'，重开后各自真查一次（生效了才说生效）
  mic: 'not-determined', // granted | denied | not-determined | restricted，另有 waiting（开了系统设置等开关）
  sys: '', // '' | waiting（面板开着，等拖进列表）| inlist（拖过了，重开才生效）| checking（重开后正在真查）| noeffect（重开后查了，没生效）| ok（真查到能录）
  scr: '', // '' | skip | waiting | inlist | noeffect（重开后系统还没给权限）| ok
  src: 'en',
  tgt: '',
  guessed: true, // 语言还是按这台电脑猜的
  listen: { sys: false, mic: false, text: '', error: '', speaking: false, spoke: false, lines: [] },
  member: null,
  vpBusy: false,
}

const STEPS = ['welcome', 'perm', 'lang', 'listen', 'voice', 'ready']
const idx = () => STEPS.indexOf(S.step)
const uiCode = () => window.UI_LANG || 'zh'
const sep = () => (['zh', 'zh-Hant', 'ja'].includes(uiCode()) ? '、' : ', ')
const isMember = () => init.settings?.plan === 'member'
// 系统设置里列表和按钮的原文（按系统语言，可能和界面语言不一样），读不到用自己的译文
const sysName = (k) => init.sysNames?.[k] || { screen: t('录屏与系统录音'), audio: t('仅系统录音'), quit: t('退出并重新打开'), later: t('以后') }[k]
// 界面语言里的叫法（「英语」「Englisch」），句子里用；选择框里用语言自己的写法
const localName = (code) => [...TARGET_LANGS, ...SOURCE_LANGS].find((l) => l.value === code)?.local ?? langLabel(code)

/* ---------------- 步骤栏 ---------------- */

function stepInfo() {
  return {
    welcome: [t('欢迎'), t('看一眼怎么用')],
    perm: [t('授权'), isMac ? t('麦克风、电脑声音') : t('麦克风')],
    lang: [t('语言'), t('对方说的、翻成的')],
    listen: [t('试听'), t('确认字幕出来了')],
    voice: [t('声纹'), t('分清你和对方，可跳过')],
    ready: [t('开始'), isMember() ? t('送你 1 场') : t('快捷键')],
  }
}

function stepDone(key) {
  if (key === 'welcome') return S.seen > 0
  if (key === 'perm') return S.mic === 'granted' && (!isMac || (S.sys === 'ok' && S.scr !== 'inlist'))
  if (key === 'lang') return S.seen > 2 && Boolean(S.tgt)
  if (key === 'listen') return S.listen.sys && Boolean(S.listen.text)
  if (key === 'voice') return Boolean(P.voiceprint()?.enrolled)
  return false
}

function sidebar() {
  const info = stepInfo()
  return el(
    'aside.ob-side.app-sidebar',
    { dataset: { part: '步骤栏' } },
    el('div.ob-side-top.drag'),
    el('div.ob-brand', {}, el('img', { src: '../../assets/icon.png', alt: '' }), el('div', {}, el('div.ob-brand-n', { text: 'MeetCaption' }), el('div.ob-brand-s', { text: t('第一次设置') }))),
    el(
      'nav.ob-steps',
      {},
      STEPS.map((key, i) => {
        const done = stepDone(key) && key !== S.step
        return el(
          'button.ob-st',
          { type: 'button', class: [key === S.step ? 'is-cur' : '', done ? 'is-done' : ''].join(' '), 'aria-current': key === S.step ? 'step' : undefined, onClick: () => go(key) },
          el('span.ob-st-num', {}, done ? icon('check', 13) : String(i + 1)),
          el('span.ob-st-text', {}, el('span.ob-st-t', { text: info[key][0] }), el('span.ob-st-d', { text: info[key][1] })),
        )
      }),
    ),
    el('div.ob-side-foot', {}, el('button.ob-skip', { type: 'button', onClick: skipAll }, isMac ? t('跳过，之后点菜单栏图标继续') : t('跳过，之后点托盘图标继续'))),
  )
}

/* ---------------- 界面语言（窗口右上角，每一步都在） ---------------- */

function uiLangButton() {
  const cur = init.settings?.uiLang ?? 'auto'
  const btn = el('button.ob-uilang', { type: 'button', title: t('界面语言'), 'aria-haspopup': 'menu' }, icon('globe', 14), el('span', { lang: uiCode(), text: UI_NAME[uiCode()] }), icon('chevron-down', 13))
  btn.addEventListener('click', () => {
    const pick = (v) => {
      if (v === cur) return
      // 主进程换表后所有窗口重新载入，引导停在这一步（步号已经存了）
      api.updateSettings({ uiLang: v })
    }
    ui.menu(
      btn,
      [
        { section: t('界面语言 · 选了马上换') },
        { label: t('跟随系统'), checked: cur === 'auto', onSelect: () => pick('auto') },
        'sep',
        ...UI_LANGS.map(([v, label]) => ({ label, checked: cur === v, onSelect: () => pick(v) })),
      ],
      { minWidth: 220 },
    )
  })
  return el('div.ob-top.drag', {}, btn)
}

/* ---------------- 第 1 步：欢迎 ---------------- */

let titleTimer = 0
let titleI = 0
let demoTimer = 0

function stepWelcome() {
  const u = uiCode()
  const auto = (init.settings?.uiLang ?? 'auto') === 'auto'
  if (!auto) titleI = UI_LANGS.findIndex(([c]) => c === u)
  const tl = UI_LANGS[Math.max(0, titleI)][0]
  const h1 = el('h1.ob-h1.ob-rot', { id: 'wTitle', lang: tl, text: TITLES[tl] })
  const cards = [
    [isMac ? 'mic' : 'mic', isMac ? t('授权两项') : t('授权一项'), isMac ? t('麦克风点「允许」；电脑声音把兔子图标拖进系统设置。') : t('麦克风点「允许」就行，电脑声音不用授权。')],
    ['languages', t('定语言'), t('对方说什么、翻成什么，60 种语言里选，选了马上看到效果。')],
    ['play', t('试听一次'), t('放段视频，看字幕真的出来了。')],
    ['fingerprint-pattern', t('录声纹'), t('读 12 秒，分清你和对方；可以跳过。')],
  ]
  return [
    demoBlock(),
    h1,
    el('p.ob-sub', { text: t('开会、面试、上网课时，字幕浮在所有窗口最上层；对方一提问，答案就浮出来。接下来 5 步，大约 3 分钟。') }),
    el(
      'div.ob-cards',
      { dataset: { part: '接下来要做的' } },
      cards.map(([ic, title, desc]) => el('div.ob-card', {}, el('div.ob-card-t', {}, icon(ic, 15), el('span', { text: title })), el('p', { text: desc }))),
    ),
    el('div.ob-note', { dataset: { part: '支持的语言' } }, icon('languages', 14), el('span', { text: t('识别 60 种语言，翻译另有繁體中文：{0} 等，第 3 步再选。', LANGS_LINE.join(sep())) })),
  ]
}

// 大标题：没选界面语言（跟随系统）时九种轮着放，选了就停在那一种；字太长时缩小字号不换行
function fitTitle(h) {
  if (!h) return
  let fs = 22
  h.style.fontSize = `${fs}px`
  while (h.scrollWidth > h.clientWidth + 1 && fs > 15) h.style.fontSize = `${--fs}px`
}

function startWelcomeTimers() {
  stopWelcomeTimers()
  if ((init.settings?.uiLang ?? 'auto') === 'auto' && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    titleTimer = setInterval(() => {
      const h = document.getElementById('wTitle')
      if (!h) return
      h.classList.add('is-fade')
      setTimeout(() => {
        titleI = (titleI + 1) % UI_LANGS.length
        const c = UI_LANGS[titleI][0]
        h.textContent = TITLES[c]
        h.lang = c
        fitTitle(h)
        h.classList.remove('is-fade')
      }, 260)
    }, 2800)
  demoTimer = setInterval(demoTick, 110)
}

function stopWelcomeTimers() {
  clearInterval(titleTimer)
  clearInterval(demoTimer)
}

// 欢迎页演示：英、德、日轮流说（和界面语言撞了换成中文），字幕一个词一个词出来，下面是界面语言的译文；最后一句是提问，右上角浮出 AI 的回答
function demoList() {
  const u = uiCode()
  const sub = (s) => (s === u ? 'zh' : s)
  const [a, b, c] = ['en', 'de', 'ja'].map(sub)
  const name = (s) => ({ en: 'English', de: 'Deutsch', ja: '日本語', zh: '中文' })[s]
  const tag = (s) => `${name(s)} → ${UI_NAME[u]}`
  return [
    { tag: tag(a), src: SENT[a][0], tr: SENT[u][0], from: a },
    { tag: tag(b), src: SENT[b][1], tr: SENT[u][1], from: b },
    { tag: tag(c), src: SENT[c][1], tr: SENT[u][1], from: c },
    { tag: tag(a), src: QQ[a], tr: QQ[u], ask: true, from: a },
  ]
}

function demoBlock() {
  const u = uiCode()
  const q = demoList()[3]
  return el(
    'div.ob-demo',
    { dataset: { part: '欢迎演示' }, 'aria-hidden': 'true' },
    el('div.ob-tile', { id: 'dTile' }, el('div.ob-who', {}, icon('user', 24)), el('div.ob-ring'), el('div.ob-nm', { text: 'Prof. Miller' })),
    el('div.ob-hud.ob-cap', {}, el('div.ob-cap-tag', { id: 'dTag' }), el('div.ob-cap-src', { id: 'dSrc' }), el('div.ob-cap-tr', { id: 'dTr', lang: u })),
    el('div.ob-hud.ob-ans', { id: 'dAns' }, el('div.ob-ans-k', {}, icon('sparkles', 13), el('span', { text: t('AI 答 · 对方刚问') })), el('div.ob-ans-a', { lang: q.from, text: AA[q.from] }), el('div.ob-ans-at', { lang: u, text: AA[u] })),
  )
}

let dI = 0
let dT = 0
function demoTick() {
  const src = document.getElementById('dSrc')
  if (!src) return
  const list = demoList()
  const d = list[dI % list.length]
  const cjk = /[぀-ヿ一-鿿]/.test(d.src)
  const units = cjk ? [...d.src] : d.src.split(' ')
  const per = cjk ? 0.6 : 1.6
  dT++
  const n = Math.min(units.length, Math.floor(dT / per))
  src.textContent = units.slice(0, n).join(cjk ? '' : ' ')
  src.lang = d.from
  document.getElementById('dTag').textContent = d.tag
  document.getElementById('dTile').classList.toggle('is-talk', n < units.length)
  const trOn = n >= units.length
  document.getElementById('dTr').textContent = trOn ? d.tr : ''
  document.getElementById('dAns').classList.toggle('is-on', Boolean(d.ask) && trOn && dT > units.length * per + 6)
  if (trOn && dT > units.length * per + (d.ask ? 40 : 18)) {
    dI = (dI + 1) % list.length
    dT = 0
  }
}

/* ---------------- 第 2 步：授权 ---------------- */

const requiredLeft = () => (S.mic === 'granted' ? 0 : 1) + (isMac && !['ok', 'inlist'].includes(S.sys) ? 1 : 0)
// 重开后顶上那句：哪几项真查过、生效了，哪几项没生效（没生效的不说能用，给下一步）
function resumedText() {
  const of = (state) => S.resumedWhat.filter((k) => S[k] === state)
  const names = (keys) => keys.map((k) => (k === 'sys' ? t('电脑声音') : t('录屏'))).join(t('和'))
  const parts = [t('MeetCaption 重新打开了，从这一步接着来。')]
  if (of('ok').length) parts.push(t('{0}已经生效。', names(of('ok'))))
  if (of('checking').length) parts.push(t('正在确认电脑声音…'))
  if (of('noeffect').length) parts.push(t('{0}重开后还没检测到生效。下一步：按下面那一行的提示再试一次，也可以先跳过，第 4 步试听时会再确认。', names(of('noeffect'))))
  return parts.join(['zh', 'zh-Hant', 'ja'].includes(uiCode()) ? '' : ' ')
}
const pendingRestart = () => (isMac ? ['sys', 'scr'].filter((k) => S[k] === 'inlist') : [])

function permRow(kind) {
  const appName = init.appName || 'MeetCaption'
  const next = S.mic !== 'granted' ? 'mic' : isMac && ['', 'waiting', 'noeffect'].includes(S.sys) ? 'sys' : isMac && S.scr === '' ? 'scr' : null
  const pri = next === kind ? '.btn-primary' : ''
  const def = {
    mic: { icon: 'mic', name: t('麦克风'), tag: t('必需'), ds: t('听你自己说的话，分清哪句是你说的。系统会弹框问一次。') },
    // 拖进列表后要重开的事，在列表下面那句统一说
    sys: { icon: 'volume-2', name: t('电脑声音'), tag: t('必需'), ds: t('会议软件里对方的声音从这里来，只录声音，不录画面。') },
    scr: { icon: 'monitor', name: t('录屏'), tag: t('可选'), ds: t('截课件、AI 答题时看得到 PPT 上的题。') },
  }[kind]
  let ds = def.ds
  let act
  let status = null // 说明下面一行：在等什么、现在是什么状态（右边只放按钮，长语言里也不挤说明）
  const st = S[kind]
  const ok = el('span.ob-ok', {}, icon('check', 15), t('已允许'))
  const btn = (label, onClick, cls = '') => el(`button.btn${cls}`, { type: 'button', onClick }, label)
  const wait = (text, ...more) => el('div.ob-pr-st', {}, el('span.ob-spin'), el('span', { text }), ...more)
  if (kind === 'mic') {
    if (st === 'granted') act = ok
    else if (st === 'waiting') ((status = wait(t('等你在系统设置里打开开关'))), (act = btn(t('再打开'), () => openHelper('mic'))))
    else if (st === 'denied' || st === 'restricted' || !isMac) {
      if (isMac) ds = t('之前拒绝过。在系统设置里打开「{0}」的开关就行。', appName)
      else ds = t('Windows 的隐私设置里要允许「桌面应用访问麦克风」。下一步试听时会真的听一下。')
      act = btn(t('打开系统设置'), () => (isMac ? openHelper('mic') : api.openPrivacy('microphone')), pri)
    } else act = btn(t('允许'), askMic, pri)
  } else if (st === 'ok') {
    act = ok
    if (kind === 'sys') ds = t('会议软件里对方的声音从这里来。第 4 步试听时会再确认一次。')
  } else if (st === 'checking') {
    status = wait(t('正在确认电脑声音…'))
  } else if (st === 'noeffect') {
    // 重开后真查过了，没生效：照实说，告诉下一步
    status = el('div.ob-pr-st.is-bad', {}, icon('circle-alert', 13), el('span', { text: kind === 'sys' ? t('重开后还是录不到电脑声音') : t('重开后系统还没给录屏权限') }))
    ds = t('去系统设置的「{0}」，找到「{1}」打开开关；列表里没有就把兔子图标重新拖进去，再重开一次。', kind === 'sys' ? sysName('audio') : sysName('screen'), appName)
    act = [btn(t('再查一次'), kind === 'sys' ? checkSystemAudio : refreshPerm), btn(t('打开系统设置'), () => openHelper(kind), pri)]
  } else if (st === 'waiting') {
    status = wait(t('等你把图标拖进列表'), el('button.ob-link', { type: 'button', onClick: () => markInList(kind) }, t('已经加上了')))
    act = btn(t('再打开'), () => openHelper(kind))
  } else if (st === 'inlist') {
    status = el('div.ob-pr-st', {}, icon('check', 13), el('span', { text: t('已在列表里，重开一次才生效') }))
    act = btn(t('现在重开'), relaunch)
    ds = kind === 'sys' ? t('会议软件里对方的声音从这里来。重开后，第 4 步试听时会再确认一次。') : t('截课件、AI 答题时看得到 PPT 上的题。')
  } else if (st === 'skip') {
    status = el('div.ob-pr-st', {}, el('span', { text: t('先不用') }))
    act = btn(t('打开系统设置'), () => openHelper(kind))
    ds = t('以后在 设置 → 权限 里也能开。')
  } else if (kind === 'sys') act = btn(t('打开系统设置'), () => openHelper('sys'), pri)
  else act = [el('button.btn.btn-ghost', { type: 'button', onClick: () => ((S.scr = 'skip'), render()) }, t('先不用')), btn(t('打开系统设置'), () => openHelper('scr'), pri)]
  return el(
    'div.ob-pr',
    { dataset: { part: `授权 ${def.name}` } },
    el('div.ob-pr-ic', {}, icon(def.icon, 16)),
    el('div.ob-pr-tx', {}, el('div.ob-pr-nm', {}, el('span', { text: def.name }), el('span.ob-tag', { text: def.tag })), el('div.ob-pr-ds', { text: ds }), status),
    el('div.ob-pr-act', {}, act),
  )
}

function stepPerm() {
  const banner = S.resumed
    ? el(
        'div.ob-banner',
        { dataset: { part: '重开后接着来' }, class: S.resumedWhat.some((k) => S[k] === 'noeffect') ? 'is-warn' : '' },
        icon(S.resumedWhat.some((k) => S[k] === 'noeffect') ? 'triangle-alert' : 'refresh-cw', 15),
        el('span', { text: resumedText() }),
      )
    : null
  // 示意图：系统设置旁的小面板出来以后（在等拖）就不用了，收起来给几行说明让地方
  const illu = isMac && !['sys', 'scr'].some((k) => S[k] === 'waiting')
    ? el(
        'div.ob-illu',
        { dataset: { part: '拖图标示意' }, 'aria-hidden': 'true' },
        el('div.ob-mini', {}, el('div.ob-mini-l', {}, el('i'), el('i'), el('i'), el('i')), el('div.ob-mini-r', {}, el('div.ob-mini-row', {}, el('i'), el('em'), el('b')), el('div.ob-mini-row.is-new', {}, el('i', {}, el('img', { src: '../../assets/icon.png', alt: '' })), el('em'), el('b')))),
        el('div.ob-fly', {}, el('img', { src: '../../assets/icon.png', alt: '' })),
        el('div.ob-illu-say', { text: t('点「打开系统设置」后，系统设置右边会浮出兔子图标，把它往左拖进列表，开关就打开了。') }),
      )
    : null
  const rows = isMac ? [permRow('mic'), permRow('sys'), permRow('scr')] : [permRow('mic')]
  const warn =
    isMac && (['', 'waiting'].includes(S.sys) || ['', 'waiting'].includes(S.scr))
      ? el('div.ob-warn', { dataset: { part: '重开预告' } }, icon('triangle-alert', 14), el('span', { text: t('电脑声音和录屏拖进列表后，macOS 都可能请你「{0}」。可以先点「{1}」，两项都拖完再一起重开一次；重开后引导回到这一步，不用从头来。', sysName('quit'), sysName('later')) }))
      : null
  const winNote = isMac ? null : el('div.ob-note', { dataset: { part: 'Windows 说明' } }, icon('volume-2', 14), el('span', {}, el('b', { text: t('Windows 上电脑声音和截屏不用授权，') }), t('只有麦克风要。电脑声音能不能录到，下一步的试听会真的确认一次。')))
  return [
    banner,
    el('h1.ob-h1', { text: isMac ? t('给 MeetCaption 两项授权') : t('给 MeetCaption 一项授权') }),
    el('p.ob-sub', { text: isMac ? t('都在系统设置里完成，MeetCaption 拿不到你的密码。按顺序点下面的按钮就行。') : t('在 Windows 设置里完成，按下面的按钮就行。') }),
    illu,
    el('div.ob-perm', { dataset: { part: '授权列表' } }, rows),
    warn,
    winNote,
  ]
}

async function askMic() {
  const r = await api.requestPermission('microphone')
  S.mic = r?.status ?? S.mic
  render()
}

function openHelper(kind) {
  S[kind] = 'waiting'
  api.showDragHelper(kind)
  render()
}

// 拖过了（面板上开始拖、或者自己说已经加上了）：等重开生效，记下来，重开后知道是哪几项
function markInList(kind) {
  S[kind] = 'inlist'
  saveInList()
  render()
}

function saveInList() {
  api.updateSettings({ onboarding: { inList: ['sys', 'scr'].filter((k) => S[k] === 'inlist') } })
}

async function relaunch() {
  saveInList()
  const r = await api.relaunch()
  if (r?.ok === false) ui.toast({ title: t('没能重开'), message: r.error, type: 'error' })
}

async function refreshPerm() {
  const p = await api.permissionStatus()
  if (!p) return
  const before = `${S.mic}|${S.scr}`
  if (p.microphone === 'granted' || S.mic !== 'waiting') S.mic = p.microphone ?? S.mic
  if (p.screen === 'granted') S.scr = 'ok'
  if (`${S.mic}|${S.scr}` !== before && S.step === 'perm') render()
}

// 电脑声音没有查询接口：真起一次系统声音采集，出了数据才算生效。没出数据就说没生效，不往下假装能用
async function checkSystemAudio() {
  S.sys = 'checking'
  if (S.step === 'perm') render()
  S.sys = (await api.probeSystemAudio()) === 'granted' ? 'ok' : 'noeffect'
  if (S.step === 'perm') render()
}

/* ---------------- 第 3 步：语言 ---------------- */

function sample(code, i) {
  if (code === 'auto') return SENT.en[i]
  return SENT[code]?.[i] ?? null
}

function stepLang() {
  const field = (which) => {
    const opts = which === 'src' ? [SOURCE_LANGS.find((l) => l.value === 'auto'), ...SOURCE_LANGS.filter((l) => l.value !== 'auto')] : TARGET_LANGS
    const sel = ui.select({
      options: opts,
      value: S[which] || undefined,
      placeholder: t('选一种语言'),
      searchable: true,
      searchPlaceholder: t('搜索语言，比如 Deutsch、德语、de'),
      block: true,
      ariaLabel: which === 'src' ? t('对方说的语言') : t('翻成'),
      onChange: (v) => {
        S[which] = v
        S.guessed = false
        saveLang()
        render()
      },
    })
    return el('div.ob-field', {}, el('div.ob-fl', {}, el('span', { text: which === 'src' ? t('对方说的语言') : t('翻成') }), S.guessed && S[which] ? el('span.ob-guess', { text: t('按这台电脑猜的') }) : null), sel)
  }
  const s = sample(S.src, 1)
  const tr = S.tgt ? sample(S.tgt, 1) : null
  const same = S.tgt && (S.src === S.tgt || (S.src === 'zh' && S.tgt === 'zh'))
  return [
    el('h1.ob-h1', { text: t('开会时对方说什么语言？') }),
    el('p.ob-sub', { text: t('选了马上生效，下面的字幕示例跟着变。每个项目以后还能单独设。') }),
    el('div.ob-lpair', { dataset: { part: '语言选择' } }, field('src'), el('div.ob-arr', {}, icon('arrow-right', 16)), field('tgt')),
    el('div.ob-lnote', { text: t('中文和英文能用本地识别，免费、不联网；其他语言用云识别。繁體中文只做翻译，不做识别。') }),
    el(
      'div.ob-prev',
      { dataset: { part: '字幕示例' } },
      el('span.ob-prev-l', { text: t('字幕会是这样') }),
      el(
        'div.ob-hud.ob-prev-hud',
        {},
        el('div.ob-prev-src', { lang: S.src === 'auto' ? 'en' : S.src, text: s ?? langLabel(S.src) }),
        !S.tgt
          ? el('div.ob-prev-miss', { text: t('选一种「翻成」的语言就能继续。') })
          : same
            ? el('div.ob-prev-miss', { text: t('对方说的和翻成的一样，字幕只显示原文。') })
            : tr
              ? el('div.ob-prev-tr', { lang: S.tgt, text: tr })
              : el('div.ob-prev-miss', { text: t('这里只放了常用 11 种语言的例句，译成 {0} 照常能用。', langLabel(S.tgt)) }),
        !s && S.src !== 'auto' ? el('div.ob-prev-miss', { text: t('这里只放了常用 11 种语言的例句，{0} 照常能认。', langLabel(S.src)) }) : null,
      ),
    ),
    el('div.ob-where', { dataset: { part: '以后在哪改' } }, el('b', { text: t('以后在哪改：') }), t('主窗口「开始会议」旁边的语言按钮，或项目的「资料」页，每个项目可以不同。界面语言在窗口右上角，也在 设置 → 通用。')),
  ]
}

// 存到当前项目（主窗口的语言按钮显示的就是它）和全局设置（新项目跟它）；项目的「翻成」留空，跟设置走
function saveLang() {
  const patch = { language: S.src }
  if (S.tgt) patch.translateTarget = S.tgt
  api.updateSettings(patch)
  api.updateProject(init.currentProjectId || 'inbox', { language: S.src, target: '' })
}

/* ---------------- 第 4 步：试听 ---------------- */

let offLevel = null
let offText = null

// 试听用本地识别（只认中英文）：示例念对方的语言，不是中英文就念英文
const sampleLang = () => (S.src === 'zh' ? 'zh' : S.src === 'auto' ? (uiCode().startsWith('zh') ? 'zh' : 'en') : 'en')

function startListen() {
  if (offLevel) return
  const L = S.listen
  offLevel = api.on('audio:level', ({ source, db }) => {
    const pct = P.levelPct(db)
    const bar = document.querySelector(`[data-meter="${source}"]`)
    if (bar) bar.style.width = `${Math.max(2, pct)}%`
    const heard = source === 'system' ? db > -50 : db > -45
    const key = source === 'system' ? 'sys' : 'mic'
    if (heard && !L[key]) {
      L[key] = true
      paintListen()
    }
  })
  offText = api.on('listen:text', (e) => {
    if (e.error) L.error = e.error
    else if (e.text) {
      const i = L.lines.findIndex((x) => x.key === e.key)
      if (i >= 0) L.lines[i].text = e.text
      else L.lines.push({ key: e.key, text: e.text })
      L.lines = L.lines.slice(-2)
      L.text = L.lines.map((x) => x.text).join(' ')
    }
    paintListen()
  })
  api.listenStart().then((r) => {
    if (r?.ok === false) {
      L.error = r.error
      paintListen()
    }
  })
}

function stopListen() {
  if (!offLevel) return
  offLevel()
  offText()
  offLevel = offText = null
  speechSynthesis.cancel()
  api.listenStop()
}

function voiceFor(lang) {
  const want = lang === 'zh' ? 'zh-CN' : 'en-US'
  const vs = speechSynthesis.getVoices()
  return vs.find((v) => v.lang === want && v.default) ?? vs.find((v) => v.lang === want) ?? vs.find((v) => v.lang.startsWith(lang))
}

function playSample() {
  const L = S.listen
  const lang = sampleLang()
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(SENT[lang].join(' '))
  const v = voiceFor(lang)
  if (v) u.voice = v
  u.lang = v?.lang ?? (lang === 'zh' ? 'zh-CN' : 'en-US')
  u.onstart = () => ((L.speaking = true), paintListen())
  u.onend = u.onerror = () => {
    L.speaking = false
    L.spoke = true
    paintListen()
  }
  speechSynthesis.speak(u)
}

function stepListen() {
  const L = S.listen
  const lang = sampleLang()
  const srcName = langLabel(S.src)
  return [
    el('h1.ob-h1', { text: t('试听一下') }),
    el('p.ob-sub', { text: t('放一段有人说话的视频，比如一段 YouTube 演讲，看字幕是不是出来了。试听用本地识别，不联网，不算在送你的那 1 场里。') }),
    pendingRestart().includes('sys')
      ? el('div.ob-callout', {}, icon('triangle-alert', 15), el('span', { text: t('电脑声音拖进列表后还没重开，现在录不到。') }), el('button.btn.btn-sm', { type: 'button', onClick: relaunch }, t('现在重开')))
      : null,
    el(
      'div.ob-meters',
      { dataset: { part: '两路声音' } },
      el('div.ob-ml', { text: t('电脑声音') }),
      el('div.ob-meter', {}, el('i', { dataset: { meter: 'system' } })),
      el('div.ob-mv', { id: 'mSysT' }),
      el('div.ob-ml', { text: t('麦克风') }),
      el('div.ob-meter', {}, el('i', { dataset: { meter: 'mic' } })),
      el('div.ob-mv', { id: 'mMicT' }),
    ),
    el(
      'div.ob-tryrow',
      {},
      el('button.btn', { type: 'button', id: 'playBtn', onClick: playSample }, icon('play', 14), el('span', { id: 'playLabel' })),
      el('span.ob-try-s', { text: lang === 'en' && S.src !== 'en' && S.src !== 'auto' ? t('试听用本地识别，只认中文和英文，所以示例念的是英文；开会时 {0} 用云识别。', srcName) : t('手边没有视频，就让电脑念一段{0}。', localName(lang)) }),
    ),
    el('div.ob-prev', { dataset: { part: '试听字幕' } }, el('span.ob-prev-l', { text: t('本地识别') }), el('div.ob-hud.ob-prev-hud', {}, el('div.ob-prev-src', { id: 'tSrc' }), el('div.ob-prev-miss', { id: 'tErr' }))),
    el('div.ob-checks', { dataset: { part: '三项检查' } }, el('div', { id: 'c1' }, el('i'), t('听到电脑的声音')), el('div', { id: 'c2' }, el('i'), t('听到你的麦克风')), el('div', { id: 'c3' }, el('i'), t('字幕出来了'))),
    el('div.ob-callout', { id: 'noSys', hidden: true }, icon('circle-alert', 15), el('span', { text: t('念完了还没听到电脑的声音：电脑声音的授权可能还没生效。') }), el('button.btn.btn-sm', { type: 'button', onClick: () => go('perm') }, t('回到授权'))),
  ]
}

// 试听这一屏只改会变的几处，不整屏重画（音量条一秒十几次）
function paintListen() {
  if (S.step !== 'listen') return
  const L = S.listen
  const set = (id, on) => document.getElementById(id)?.classList.toggle('is-yes', on)
  set('c1', L.sys)
  set('c2', L.mic)
  set('c3', Boolean(L.text))
  const a = document.getElementById('mSysT')
  const b = document.getElementById('mMicT')
  if (a) ((a.textContent = L.sys ? t('听到了') : t('等声音…')), a.classList.toggle('is-ok', L.sys))
  if (b) ((b.textContent = L.mic ? t('听到了') : t('说句话试试')), b.classList.toggle('is-ok', L.mic))
  const src = document.getElementById('tSrc')
  if (src) src.textContent = L.text || ' '
  const err = document.getElementById('tErr')
  if (err) ((err.textContent = L.error), (err.hidden = !L.error))
  const lbl = document.getElementById('playLabel')
  if (lbl) lbl.textContent = L.speaking ? t('正在念…') : L.spoke ? t('再念一次') : t('放一段示例')
  const btn = document.getElementById('playBtn')
  if (btn) btn.classList.toggle('btn-primary', !L.spoke && !L.sys)
  const noSys = document.getElementById('noSys')
  if (noSys) noSys.hidden = !(L.spoke && !L.speaking && !L.sys)
  renderSideOnly()
}

/* ---------------- 第 5 步：声纹 ---------------- */

let recorder = null

function stepVoice() {
  if (S.mic !== 'granted')
    return [
      el('h1.ob-h1', { text: t('录 12 秒你的声音') }),
      el('p.ob-sub', { text: t('软件就能分清哪句是你说的、哪句是对方说的；开外放时串进麦克风的对方声音也能滤掉。声纹只存在这台电脑上。') }),
      el('div.ob-callout', {}, icon('mic-off', 15), el('span', { text: t('麦克风还没允许，录不了声纹。可以先跳过，以后在 设置 → 声纹 里录。') }), el('button.btn.btn-sm', { type: 'button', onClick: () => go('perm') }, t('回到授权'))),
    ]
  recorder ??= P.voiceprintRecorder({ status: 'enrolled', allowDelete: false })
  return [
    el('h1.ob-h1', { text: t('录 12 秒你的声音') }),
    el('p.ob-sub', { text: t('软件就能分清哪句是你说的、哪句是对方说的；开外放时串进麦克风的对方声音也能滤掉。声纹只存在这台电脑上。') }),
    el('div.ob-vp', { dataset: { part: '录声纹' } }, recorder),
  ]
}

/* ---------------- 第 6 步：可以开始了 ---------------- */

function giftText() {
  const m = S.member
  if (!isMember()) return [t('字幕一直免费'), t('字幕用本地识别，在你电脑上跑，一直免费。翻译和 AI 答题用你在设置里配好的服务。')]
  const info = m?.info
  if (!info) return m?.error ? [t('送你的 1 场稍后到账'), t('暂时连不上，字幕照常能用，连上后自动到账。')] : [t('正在领取送你的 1 场…'), t('字幕本身不用填任何 Key。')]
  if (info.balance > 0) {
    const hours = (info.sessionMs ?? 2 * 3600_000) / 3600_000
    const body = t('最长 {0} 小时：60 种语言的云识别、AI 答题和会后纪要都能用。字幕本身不用填任何 Key，用完也照常出（本地识别，中文和英文）。', hours)
    return info.kind === 'paid' ? [t('你的会员还剩 {0} 场', info.balance), body] : [t('送你的 {0} 场已经到账', info.balance), body]
  }
  return [t('这台电脑的试用场次已经用过了'), t('字幕照常能用（本地识别）；AI 在「设置 → 会员」里买场次或换自带 Key。')]
}

function stepReady() {
  const s = init.settings ?? {}
  const [g1, g2] = giftText()
  const keys = [
    [s.hotkeyRecord, t('开始或停止记录')],
    [s.hotkeyToggle, t('显示或隐藏字幕')],
    [s.assist?.hotkeyAsk, t('让 AI 答这一问')],
    [s.class?.hotkeySlide, t('截一页课件'), t('上课记录时')],
  ].filter(([k]) => k)
  return [
    el('h1.ob-h1', { text: t('可以开始了') }),
    s.hotkeyRecord ? el('p.ob-sub', {}, t('开会时按 '), ui.kbd(s.hotkeyRecord, { size: 'sm' }), t(' 开始记录，再按一次停止。')) : null,
    el('div.ob-gift', { dataset: { part: '送你的一场' } }, el('div.ob-gift-i', {}, icon('gift', 16)), el('div', {}, el('div.ob-gift-1', { text: g1 }), el('div.ob-gift-2', { text: g2 }))),
    el(
      'div.ob-keys',
      { dataset: { part: '快捷键' } },
      keys.map(([k, label, small]) => [ui.kbd(k, { size: 'sm' }), el('div.ob-kd', {}, label, small ? el('small', { text: small }) : null)]),
    ),
    el('div.ob-note', { dataset: { part: '菜单栏' } }, icon('house', 14), el('span', { text: isMac ? t('MeetCaption 住在屏幕右上角的菜单栏里，点兔子图标能开主窗口和设置。') : t('MeetCaption 住在任务栏右边的托盘里，点图标能开主窗口和设置。') })),
    el('div.ob-note.ob-note-tight', {}, icon('refresh-cw', 14), el('span', { text: t('引导和导览以后还能再看：设置 → 通用 → 首次引导。') })),
  ]
}

/* ---------------- 底栏 ---------------- */

function bar() {
  const back = idx() > 0 ? el('button.btn.btn-ghost', { type: 'button', onClick: () => go(STEPS[idx() - 1]) }, t('上一步')) : null
  const nextBtn = (label = t('继续'), opts = {}) => el('button.btn.btn-primary.btn-lg.ob-cta', { type: 'button', disabled: Boolean(opts.disabled), onClick: opts.onClick ?? (() => go(STEPS[idx() + 1])) }, label)
  let hint = ''
  let btns = []
  if (S.step === 'welcome') {
    // 免费说明放在欢迎页的底栏左边（正文一屏放不下五行卡片加两行说明）
    const free = isMember() ? [t('送你 1 场完整体验，最长 1 小时。'), t('只看字幕不用填任何 Key。')] : [t('字幕用本地识别，一直免费。'), t('只看字幕不用填任何 Key。')]
    hint = free.join(['zh', 'zh-Hant', 'ja'].includes(uiCode()) ? '' : ' ')
    btns = [nextBtn(t('开始设置'))]
  }
  else if (S.step === 'perm') {
    const n = requiredLeft()
    const p = pendingRestart()
    if (n) {
      hint = t('还差 {0} 项', n)
      btns = [back, el('button.btn.btn-ghost', { type: 'button', onClick: () => go('lang') }, t('先跳过')), nextBtn(t('继续'), { disabled: true })]
    } else if (p.length) {
      hint = p.length === 2 ? t('两项都在列表里了，重开一次一起生效') : S.scr === '' ? t('录屏也要的话，先拖完再一起重开') : t('还要重开一次才生效')
      btns = [back, el('button.btn.btn-ghost', { type: 'button', onClick: () => go('lang') }, t('先跳过')), nextBtn(t('重开并接着来'), { onClick: relaunch })]
    } else {
      hint = !isMac ? t('麦克风好了') : S.scr === 'ok' ? t('三项都好了') : t('两项必需的都好了，录屏可以以后再开')
      btns = [back, nextBtn()]
    }
  } else if (S.step === 'lang') {
    hint = S.tgt ? t('选好了就继续，以后随时能改') : t('选一种「翻成」的语言就能继续')
    btns = [back, nextBtn(t('继续'), { disabled: !S.tgt, onClick: () => (saveLang(), go('listen')) })]
  } else if (S.step === 'listen') {
    hint = t('试不试都行')
    btns = [back, nextBtn()]
  } else if (S.step === 'voice') {
    const enrolled = Boolean(P.voiceprint()?.enrolled)
    hint = enrolled ? t('录好了，以后在 设置 → 声纹 里能重录') : t('可以跳过，以后在 设置 → 声纹 里录')
    btns = enrolled ? [back, nextBtn()] : [back, el('button.btn.btn-ghost', { type: 'button', disabled: S.vpBusy, onClick: () => go('ready') }, t('先跳过')), nextBtn(t('继续'), { disabled: true })]
  } else {
    btns = [back, el('button.btn.btn-lg', { type: 'button', onClick: () => finish(false) }, t('直接开始')), nextBtn(t('带我看一遍主窗口'), { onClick: () => finish(true) })]
  }
  if (S.vpBusy) for (const b of btns) if (b) b.disabled = true
  return el('div.ob-bar', {}, el('span.ob-hint', { text: hint }), btns)
}

/* ---------------- 换步、整屏 ---------------- */

function go(key) {
  if (!STEPS.includes(key) || S.vpBusy) return
  if (S.step === 'listen' && key !== 'listen') stopListen()
  if (key !== S.step) S.resumed = false
  S.step = key
  S.seen = Math.max(S.seen, idx())
  render(true)
  if (key === 'listen') startListen()
}

function skipAll() {
  stopListen()
  window.close()
}

async function finish(tour) {
  stopListen()
  await api.finishOnboarding({ tour })
}

let lastSaved = ''
function render(anim = false) {
  if (S.step !== lastSaved) {
    lastSaved = S.step
    api.saveOnboardingStep(S.step)
  }
  if (S.step === 'welcome') startWelcomeTimers()
  else stopWelcomeTimers()
  const body = { welcome: stepWelcome, perm: stepPerm, lang: stepLang, listen: stepListen, voice: stepVoice, ready: stepReady }[S.step]()
  const main = el('main.ob-main.app-main', {}, uiLangButton(), el('div.ob-body', { class: [anim ? 'is-anim' : '', S.step === 'welcome' ? 'is-welcome' : ''].join(' '), id: 'obBody' }, body), bar())
  document.getElementById('ob').replaceChildren(sidebar(), main)
  fitTitle(document.getElementById('wTitle'))
  if (S.step === 'listen') paintListen()
}

// 只重画步骤栏（试听里勾上了、录完声纹）
function renderSideOnly() {
  const side = document.querySelector('.ob-side')
  if (side) side.replaceWith(sidebar())
}

/* ---------------- 启动 ---------------- */

async function boot() {
  init = await api.init()
  P.boot(init)
  ui.applyChrome(init.chrome)
  isMac = init.platform === 'darwin'
  document.body.classList.toggle('is-win', !isMac)
  S.member = init.member ?? null
  S.mic = init.permissions?.microphone ?? S.mic
  if (isMac && init.permissions?.screen === 'granted') S.scr = 'ok'
  const ob = init.settings?.onboarding ?? {}
  // 拖进列表等重开的：这次是被重开打断后接着出的，不假定生效，下面真查一次；换界面语言重新载入的还在等
  for (const k of ob.inList ?? []) {
    if (!isMac) break
    if (init.onboardingResumed) {
      // 重开后真查一次：电脑声音起一次系统声音采集（没有查询接口），录屏看系统的授权状态；没生效的照实说
      S.resumedWhat.push(k)
      if (k === 'sys') S.sys = 'checking'
      else if (S.scr !== 'ok') S.scr = 'noeffect'
    } else if (S[k] !== 'ok') S[k] = 'inlist'
  }
  if (init.onboardingResumed && ob.inList?.length) api.updateSettings({ onboarding: { inList: [] } })
  // 语言：没选过时对方默认 English，翻成跟界面语言；两个撞上（英文界面）时翻成留空，必须选一个
  const proj = await api.getProject(init.currentProjectId || 'inbox')
  if (ob.done || ob.step === 'listen' || ob.step === 'voice' || ob.step === 'ready') {
    S.src = proj?.language ?? init.settings.language ?? 'en'
    S.tgt = proj?.target || init.settings.translateTarget || ''
    S.guessed = false
  } else {
    S.src = 'en'
    const u = uiCode()
    S.tgt = u === 'en' ? '' : u
  }
  const last = ob.step
  if (STEPS.includes(last) && last !== 'welcome') {
    S.step = last
    S.seen = idx()
    S.resumed = Boolean(init.onboardingResumed)
  }
  api.on('member:update', (snap) => {
    S.member = snap
    if (S.step === 'ready') render()
  })
  api.on('onboarding:helper', (e) => {
    if (e?.dragged && ['sys', 'scr'].includes(e.kind)) markInList(e.kind)
  })
  api.on('settings:changed', (s) => (init.settings = s))
  P.onVoiceprint(() => {
    const busy = P.vpBusy()
    const changed = busy !== S.vpBusy
    S.vpBusy = busy
    if (S.step !== 'voice') return
    // 录音中只更新底栏和步骤栏，录制块自己会画
    const b = document.querySelector('.ob-bar')
    if (b) b.replaceWith(bar())
    if (changed || !busy) renderSideOnly()
  })
  window.addEventListener('focus', refreshPerm)
  setInterval(() => S.step === 'perm' && refreshPerm(), 1500)
  window.addEventListener('beforeunload', stopListen)
  // Enter = 底栏的主按钮（搜索框、菜单里不算）
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.target.closest?.('input, textarea, .menu, [role="menu"]')) return
    const b = document.querySelector('.ob-bar .btn-primary:not([disabled])')
    if (b) {
      e.preventDefault()
      b.click()
    }
  })
  render(true)
  if (S.step === 'listen') startListen()
  if (S.sys === 'checking') checkSystemAudio()
}

boot()
