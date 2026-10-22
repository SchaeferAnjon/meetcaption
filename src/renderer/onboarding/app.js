// 首次引导：第 0 步登录，再五步，每步一屏，底部「上一步 / 稍后再说 / 下一步」。已经做好的步骤在步骤条上打勾。
const P = window.parts
const api = window.app
const { el, icon } = ui

let init = null
let ob = { voiceprint: false, ai: false, asr: false, project: false }
let cur = 0
let projects = []
let screenPerm = null

const STEPS = [
  { key: 'account', label: '登录', build: stepAccount },
  { key: 'voiceprint', label: '录声纹', build: stepVoiceprint },
  { key: 'ai', label: '连接 AI', build: stepAi },
  { key: 'asr', label: '语音识别', build: stepAsr },
  { key: 'project', label: '建项目', build: stepProject },
  { key: null, label: '试一下', build: stepTry },
]
const pages = []

// 登录这一步看账号状态；登录接口还没接上时不拦
function accountDone() {
  const a = P.account()
  if (a?.unsupported || a?.off) return true
  return Boolean(a?.loggedIn ?? ob.account)
}

// 这次引导里用户自己点过的选择。AI 和识别两步：配好了、而且选的是推荐的（ChatGPT 账号、豆包）或者在这里点过，才算做完。
// 老用户只填过 OpenAI Key 时，这两步不会一打开就打勾被跳过，推荐的选项至少会被看到一次。
const chosen = { ai: false, asr: false }
function pick(key) {
  if (chosen[key]) return
  chosen[key] = true
  renderSteps()
  renderFoot()
}

const isDone = (i) => {
  const k = STEPS[i].key
  if (k === 'account') return accountDone()
  const s = P.settings?.() ?? {}
  if (k === 'ai') return Boolean(ob.ai) && (chosen.ai || s.llmProvider === 'chatgpt')
  if (k === 'asr') return Boolean(ob.asr) && (chosen.asr || s.engine !== 'openai')
  return k ? Boolean(ob[k]) : false
}

/* ---------------- 小部件 ---------------- */

function hero(iconName, tint, title, lead) {
  return el('div.ob-hero', {}, ui.iconBox(iconName, tint, { size: 'lg' }), el('div.ob-hero-text', {}, el('h1.ob-title', { text: title }), el('p.ob-lead', { text: lead })))
}

function doneNote(text) {
  return el('div.ob-done', {}, icon('circle-check', 16), el('span', { text }))
}

// 二选一的大卡片，value 绑定一个设置；desc 可以是函数（按当前设置变，比如显示现有 Key 的尾号）；onPick 点了任意一张时调用
function choices(key, options, onPick) {
  const group = el(`div.choice-group${options.length === 3 ? '.is-three' : ''}`, { role: 'radiogroup' })
  const descs = []
  const buttons = options.map((o) => {
    const desc = el('span.choice-desc')
    descs.push(desc)
    return el(
      'button.choice',
      { type: 'button', role: 'radio', onClick: () => (P.set(key, o.value, 0), onPick?.(o.value)) },
      el('span.choice-radio'),
      el('span.choice-main', {}, el('span.choice-title', {}, el('span', { text: o.title }), o.tag ? el('span.tag.tag-accent', { text: o.tag }) : null), desc),
    )
  })
  group.append(...buttons)
  P.watch((s) =>
    buttons.forEach((b, i) => {
      b.setAttribute('aria-checked', P.get(key) === options[i].value ? 'true' : 'false')
      const d = options[i].desc
      descs[i].textContent = typeof d === 'function' ? d(s) : d
    }),
  )
  return group
}

const keyTail = (k) => String(k ?? '').slice(-4)

// 配好了但还没在这里选过（老设置里的 OpenAI Key）：提示选一张卡片再继续
const chooseHints = []
function chooseHint(key, text) {
  const hint = el('div.ob-choose-hint', {}, icon('info', 14), el('span', { text }))
  const sync = () => (hint.hidden = !(ob[key] && !isDone(STEPS.findIndex((x) => x.key === key))))
  P.watch(sync)
  chooseHints.push(sync)
  return hint
}

function field(label, control, hint) {
  const hintNode = hint == null ? null : hint instanceof Node ? hint : el('div.form-hint', { text: hint })
  return el('div.ob-field', {}, el('label.ob-label', { text: label }), el('div.ob-control', {}, control, hintNode))
}

/* ---------------- 第 0 步：登录 ---------------- */

function stepAccount() {
  const hint = el('div.form-hint.ob-foot-hint', { text: '点登录会打开浏览器，选好账号就会自动回到这里。' })
  const sync = () => (hint.hidden = Boolean(P.account()?.loggedIn))
  P.onAccount(sync)
  sync()
  return [
    hero('user', 'blue', '先登录', '用 Google 账号登录会议字幕，登录后才能开始记录。登录只是确认是你在用，会议记录、声纹和密钥都只存在这台电脑上。'),
    el('div.ob-account', {}, P.accountPanel({ big: true })),
    hint,
  ]
}

/* ---------------- 第 1 步：录声纹 ---------------- */

function stepVoiceprint() {
  return [
    hero('fingerprint-pattern', 'purple', '先录一段你的声音', '录 12 秒，软件就能分清哪句是你说的、哪句是对方说的。开外放时串进麦克风的对方声音也能自动滤掉。声纹只存在这台电脑上。'),
    P.voiceprintRecorder({ status: 'enrolled', allowDelete: false }),
    ui.isMac ? el('div.form-hint.ob-foot-hint', { text: '第一次录音时 macOS 会问能不能用麦克风，点「好」。' }) : null,
  ]
}

/* ---------------- 第 2 步：连接 AI ---------------- */

function stepAi() {
  // 不替用户改 llmProvider：老用户升级后引导会重开，自动改会把能用的 Key 换成没登录的 ChatGPT。推荐只体现在卡片的「推荐」标签上。
  const test = P.testButton('测试', () => P.call('testLlm', {}), (r) => `可以用，${((r.ms ?? 0) / 1000).toFixed(1)} 秒：${r.sample ?? ''}`)
  const testRow = el('div.ob-field', {}, el('span.ob-label'), el('div.ob-control', {}, test))
  P.showWhen(testRow, (s) => s.llmProvider !== 'chatgpt')
  return [
    hero('sparkles', 'indigo', '连接 AI', '翻译、术语解释、会后纪要和 AI 答题都要用 AI。选一家，填上它的 Key；有 ChatGPT Plus 或 Pro 的可以直接登录账号，不另外花钱。'),
    P.providerPicker({ onPick: () => pick('ai') }),
    chooseHint('ai', '你已经设置过 AI 服务。想换一家就点上面的卡片，不换直接下一步。'),
    el('div.ob-panel', {}, ...P.providerSetup({ row: field }), testRow),
  ]
}

/* ---------------- 第 3 步：语音识别 ---------------- */

function stepAsr() {
  const volc = el(
    'div.ob-panel',
    {},
    field('App ID', P.textInput('volcAppId', { trim: true, mono: true, label: 'App ID' })),
    field('Access Token', P.textInput('volcAccessToken', { secret: true, trim: true, label: 'Access Token' }), '火山引擎控制台开通「豆包流式语音识别大模型」，在旧版控制台拿 App ID 和 Access Token。'),
  )
  const keyInput = P.textInput('openaiKey', { secret: true, trim: true, placeholder: 'sk-…', label: 'OpenAI API Key' })
  const keyField = field('API Key', keyInput, '上一步选了 ChatGPT 账号的话，这里要另外填一个 OpenAI API Key。')
  const keyUsed = el('div.ob-inline-note')
  const openai = el('div.ob-panel', {}, keyField, keyUsed)
  // 已经有 Key 时只显示一句「用上一步的 Key」，输入框焦点在里面时不收起
  P.watch((s) => {
    const has = Boolean(s.openaiKey) && !keyField.contains(document.activeElement)
    keyField.hidden = has
    keyUsed.hidden = !has
    if (has) keyUsed.replaceChildren(icon('key-round', 14), el('span', { text: `用上一步填的 OpenAI Key（尾号 ${String(s.openaiKey).slice(-4)}）` }), el('button.link-btn', { type: 'button', onClick: () => ((keyField.hidden = false), (keyUsed.hidden = true), keyInput.input.focus()) }, '换一个'))
  })
  P.showWhen(volc, (s) => s.engine === 'volc')
  P.showWhen(openai, (s) => s.engine === 'openai')
  const test = P.testButton('测试', () => P.call('testAsr', {}), () => (P.get('engine') === 'local' ? '本地识别可以用了' : '连接成功，可以开始用了'))
  // 切换服务时清掉上一次的测试结果
  let lastEngine = null
  P.watch((s) => {
    if (lastEngine && lastEngine !== s.engine) test.reset()
    lastEngine = s.engine
  })
  return [
    hero('audio-lines', 'blue', '选语音识别服务', '把对方和你说的话实时转成文字。本地识别免费，什么都不用填；豆包和 OpenAI 是云端服务，要自己的 Key，按说话时长计费。'),
    choices(
      'engine',
      [
        { value: 'local', title: '本地识别', tag: '推荐', desc: '在这台电脑上识别，免费、不用联网、不用 Key。中文、英文、中英夹杂都能认。' },
        { value: 'volc', title: '豆包（火山引擎）', desc: '云端识别，要 App ID 和 Access Token，按小时付费。' },
        { value: 'openai', title: 'OpenAI', desc: (st) => (st.openaiKey ? `英文口音最准，约 1 美元一小时，用现有的 Key（尾号 ${keyTail(st.openaiKey)}）。` : '英文口音最准，约 1 美元一小时，用 OpenAI API Key。') },
      ],
      () => pick('asr'),
    ),
    chooseHint('asr', '现在用的是 OpenAI 识别。推荐本地识别（免费、不用 Key）；想接着用 OpenAI，点 OpenAI 那张卡片就能继续。'),
    volc,
    openai,
    el('div.ob-panel.ob-test', {}, test),
  ]
}

/* ---------------- 第 4 步：建第一个项目 ---------------- */

const COLORS = ['blue', 'indigo', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'teal', 'gray']
const ICONS = ['folder', 'graduation-cap', 'briefcase', 'flask-conical', 'code', 'book-open', 'users', 'lightbulb']
const draft = { name: '', color: 'blue', icon: 'folder', context: '', keywords: '', profile: '', language: 'en' }
let showForm = true
let createdName = ''

function stepProject() {
  const box = el('div.ob-project')
  const render = () => {
    const mine = projects.filter((p) => !p.inbox && p.id !== 'inbox' && !p.archived)
    const parts = []
    if (createdName) parts.push(doneNote(`已创建「${createdName}」，开会时默认用这个项目。项目可以随时在主窗口里改。`))
    else if (mine.length && !showForm) parts.push(doneNote('已经有项目了。开会前在主窗口选好项目，会议就存在那里。'))
    if (mine.length && !showForm) {
      parts.push(
        el(
          'div.list.ob-projects',
          {},
          mine.slice(0, 4).map((p) => ui.listItem({ icon: p.icon || 'folder', tint: p.color || 'blue', title: p.name, subtitle: p.description || '', accessories: [p.meetings ? `${p.meetings} 场会议` : '还没有会议'], compact: true })),
        ),
        el('div.form-inline', {}, el('button.btn', { type: 'button', onClick: () => ((showForm = true), (createdName = ''), render()) }, icon('plus', 14), el('span', { text: '再建一个项目' }))),
      )
    }
    if (showForm) parts.push(projectForm(render))
    box.replaceChildren(...parts)
  }
  renderProjectStep = render
  render()
  return [
    hero('folder-plus', 'green', '建第一个项目', '每场会议都放在一个项目里，比如「硕士论文」「实习面试」。项目的背景和术语让识别和 AI 更准，纪要里的待办也按项目归好。'),
    box,
  ]
}
let renderProjectStep = () => {}

function projectForm(done) {
  const name = el('input.input', { type: 'text', placeholder: '例如：硕士论文', value: draft.name, spellcheck: false, 'aria-label': '项目名字' })
  const err = el('div.form-hint.is-error', { hidden: true })
  const swatches = el(
    'div.ob-swatches',
    { role: 'radiogroup', 'aria-label': '颜色' },
    COLORS.map((c) => el('button.ob-swatch', { type: 'button', role: 'radio', title: c, 'aria-label': c, dataset: { tint: c }, 'aria-checked': String(draft.color === c) })),
  )
  const icons = el(
    'div.ob-icons',
    { role: 'radiogroup', 'aria-label': '图标' },
    ICONS.map((n) => el('button.ob-icon', { type: 'button', role: 'radio', 'aria-label': n, dataset: { icon: n }, 'aria-checked': String(draft.icon === n) }, icon(n, 15))),
  )
  const lead = el('span.ob-name-lead', {}, ui.iconBox(draft.icon, draft.color))
  const syncLook = () => {
    lead.replaceChildren(ui.iconBox(draft.icon, draft.color))
    for (const b of swatches.children) b.setAttribute('aria-checked', String(b.dataset.tint === draft.color))
    for (const b of icons.children) {
      b.setAttribute('aria-checked', String(b.dataset.icon === draft.icon))
      b.dataset.tint = draft.color
    }
  }
  swatches.addEventListener('click', (e) => {
    const b = e.target.closest('.ob-swatch')
    if (!b) return
    draft.color = b.dataset.tint
    syncLook()
  })
  icons.addEventListener('click', (e) => {
    const b = e.target.closest('.ob-icon')
    if (!b) return
    draft.icon = b.dataset.icon
    syncLook()
  })
  const ctx = el('input.input', { type: 'text', value: draft.context, placeholder: '例如：和导师讨论论文实验进展，方向是标签噪声下的图像分类', 'aria-label': '一句话背景' })
  const lang = ui.segmented({
    options: [
      { value: 'en', label: '英语' },
      { value: 'zh', label: '中文' },
      { value: 'auto', label: '自动判断' },
    ],
    value: draft.language,
    ariaLabel: '对方说的语言',
    onChange: (v) => (draft.language = v),
  })
  const kw = el('textarea.input', { rows: 2, placeholder: '一行一个，比如 ablation study、WebVision', 'aria-label': '术语' })
  kw.value = draft.keywords
  const profile = el('textarea.input', { rows: 2, placeholder: '面试时放简历要点、项目介绍，AI 答题会用上', 'aria-label': '我的资料' })
  profile.value = draft.profile
  name.addEventListener('input', () => ((draft.name = name.value), (err.hidden = true), name.removeAttribute('aria-invalid')))
  ctx.addEventListener('input', () => (draft.context = ctx.value))
  kw.addEventListener('input', () => (draft.keywords = kw.value))
  profile.addEventListener('input', () => (draft.profile = profile.value))

  const create = el('button.btn.btn-primary', { type: 'button' }, icon('folder-plus', 14), el('span', { text: '创建项目' }))
  create.addEventListener('click', async () => {
    const n = draft.name.trim()
    if (!n) {
      err.textContent = '先给项目起个名字'
      err.hidden = false
      name.setAttribute('aria-invalid', 'true')
      name.focus()
      return
    }
    create.classList.add('is-loading')
    create.disabled = true
    const r = await P.call('createProject', { name: n, color: draft.color, icon: draft.icon, context: draft.context.trim(), keywords: draft.keywords.trim(), profile: draft.profile.trim(), language: draft.language })
    create.classList.remove('is-loading')
    create.disabled = false
    if (!r || r.ok === false || !r.id) {
      err.textContent = r?.error || '没能创建项目'
      err.hidden = false
      return
    }
    await P.call('setCurrentProject', r.id)
    createdName = r.name || n
    Object.assign(draft, { name: '', context: '', keywords: '', profile: '' })
    showForm = false
    await refreshProjects()
    done()
  })
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) create.click()
  })

  return el(
    'div.ob-panel.ob-form',
    {},
    field('名字', el('div.ob-name', {}, lead, name)),
    field('颜色和图标', el('div.ob-look', {}, swatches, el('span.vr'), icons)),
    field('一句话背景', ctx, '告诉识别和 AI 这是什么会，专业词会少听错很多。'),
    field('对方说的语言', lang),
    el('div.ob-two', {}, field('术语（可选）', kw), field('我的资料（可选）', profile)),
    el('div.ob-field', {}, el('span.ob-label'), el('div.ob-control', {}, el('div.form-inline', {}, create, err))),
  )
}

async function refreshProjects() {
  const r = await P.call('listProjects')
  if (Array.isArray(r)) projects = r
}

/* ---------------- 第 5 步：试一下 ---------------- */

let audioBusy = false
function stepTry() {
  const left = el('div.ob-col')
  const right = el('div.ob-col')

  if (ui.isMac) {
    const screenTag = el('span.tag')
    const screenBtn = el('button.btn.btn-sm', { type: 'button' })
    const renderScreen = () => {
      const ok = screenPerm === 'granted'
      screenTag.className = `tag ${ok ? 'tag-ok' : 'tag-warn'}`
      screenTag.textContent = ok ? '已允许' : '还没允许'
      screenBtn.hidden = ok
      screenBtn.textContent = screenPerm === 'denied' ? '打开系统设置' : '允许'
    }
    screenBtn.addEventListener('click', async () => {
      if (screenPerm === 'denied') return api.openPrivacy('screen')
      const r = await P.call('requestPermission', 'screen')
      screenPerm = r?.status ?? screenPerm
      if (screenPerm !== 'granted') api.openPrivacy('screen')
      renderScreen()
    })
    renderScreenPerm = renderScreen
    renderScreen()
    left.append(
      el('h3.ob-sub', { text: '两个系统权限' }),
      el(
        'div.ob-perms',
        {},
        el(
          'div.ob-perm',
          {},
          ui.iconBox('volume-2', 'blue', { size: 'sm' }),
          el('div.ob-perm-main', {}, el('div.ob-perm-title', { text: '系统录音' }), el('div.ob-perm-desc', { text: '抓会议软件里对方的声音。第一次测试时 macOS 会弹框，点「允许」。' })),
          el('button.btn.btn-sm', { type: 'button', onClick: () => api.openPrivacy('screen') }, '系统设置'),
        ),
        el(
          'div.ob-perm',
          {},
          ui.iconBox('monitor', 'purple', { size: 'sm' }),
          el('div.ob-perm-main', {}, el('div.ob-perm-title', {}, el('span', { text: '屏幕录制' }), screenTag), el('div.ob-perm-desc', { text: 'AI 答题时带上屏幕截图。不开也能答，只是不带截图。' })),
          screenBtn,
        ),
      ),
    )
  }

  // 声音测试
  const sysMeter = el('div.meter.meter-other', {}, el('i'))
  const micMeter = el('div.meter.meter-me', {}, el('i'))
  const micRow = el('div.ob-meter', {}, icon('mic', 14), el('span.ob-meter-label', { text: '麦克风' }), micMeter)
  const out = el('div.test-line')
  const btn = el('button.btn', { type: 'button' })
  const renderBtn = (left) => btn.replaceChildren(icon('play', 14), el('span', { text: audioBusy ? `测试中 ${left} 秒` : '开始测试' }))
  renderBtn()
  P.watch((s) => (micRow.hidden = !s.captureMic))
  P.on('audio:level', ({ source, db }) => {
    const m = source === 'mic' ? micMeter : sysMeter
    m.style.setProperty('--value', `${P.levelPct(db)}%`)
  })
  btn.addEventListener('click', async () => {
    if (audioBusy) return
    audioBusy = true
    btn.disabled = true
    out.dataset.state = 'busy'
    out.replaceChildren(ui.spinner(12), el('span', { text: '正在听，放点声音…' }))
    const t0 = Date.now()
    const tick = setInterval(() => renderBtn(Math.max(0, 5 - Math.floor((Date.now() - t0) / 1000))), 250)
    renderBtn(5)
    const r = await P.call('testAudio', { seconds: 5 })
    clearInterval(tick)
    audioBusy = false
    btn.disabled = false
    renderBtn()
    sysMeter.style.setProperty('--value', '0%')
    micMeter.style.setProperty('--value', '0%')
    const res = audioResult(r)
    out.dataset.state = res.state
    out.replaceChildren(icon(res.state === 'ok' ? 'circle-check' : 'circle-alert', 14), el('span.selectable', { text: res.text }))
  })
  left.append(
    el('h3.ob-sub', { text: '声音测试' }),
    el('p.ob-sub-desc', { text: '放一段视频或音乐，点「开始测试」，5 秒内看音量条有没有动。' }),
    el('div.ob-meters', {}, el('div.ob-meter', {}, icon('volume-2', 14), el('span.ob-meter-label', { text: '电脑声音' }), sysMeter), micRow),
    el('div.test', {}, btn, out),
  )

  // 字幕样子和快捷键
  const toggleKbd = el('span.kbd-slot')
  const askKbd = el('span.kbd-slot')
  P.watch((s) => {
    toggleKbd.replaceChildren(ui.kbd(s.hotkeyToggle || ''))
    askKbd.replaceChildren(s.assist?.enabled && s.assist?.hotkeyAsk ? ui.kbd(s.assist.hotkeyAsk) : el('span.text-3', { text: 'AI 答题关着' }))
  })
  const trToggle = P.toggleInput('translate', { label: '字幕下面显示中文翻译' })
  right.append(
    el('h3.ob-sub', { text: '开会时屏幕上是这样' }),
    P.captionPreview({ scale: 0.56 }),
    el('label.ob-toggle-line', {}, trToggle, el('span', { text: '字幕下面显示中文翻译（一句英文一句中文，意群同色）' })),
    el(
      'div.ob-keys',
      {},
      el('div.ob-key', {}, toggleKbd, el('span', { text: '显示 / 隐藏字幕和答题框' })),
      el('div.ob-key', {}, askKbd, el('span', { text: '让 AI 回答刚才的问题' })),
    ),
    el('div.form-hint', { text: '快捷键在任何程序里都能用，设置里可以改。' }),
  )

  const classTip = el(
    'div.callout.ob-class-tip',
    {},
    ui.iconBox('graduation-cap', 'pink', { size: 'sm' }),
    el('div.callout-body', {}, el('div.callout-title', { text: '上课也能用' }), el('div.callout-desc', { text: '开始按钮的下拉里选「课堂」：边听边出双语字幕，AI 每隔几分钟整理一版笔记，网课的课件能一键截下来，下课生成课堂笔记。' })),
  )
  return [hero('play', 'orange', '最后试一下', '确认电脑能听到会议的声音，再记住两个快捷键。做完就可以在主窗口开始第一场会议了。'), el('div.ob-try', {}, left, right), classTip]
}
let renderScreenPerm = () => {}

function audioResult(r) {
  if (!r || r.ok === false) {
    if (r?.missing) return { state: 'err', text: P.NOT_READY }
    if (!r?.system) return { state: 'err', text: r?.error || '测试没完成' }
  }
  const sys = r.system?.heard
  const mic = r.mic ? r.mic.heard : true
  if (sys && mic) return { state: 'ok', text: r.mic ? '电脑声音和麦克风都听到了，可以开始用了。' : '听到电脑的声音了，可以开始用了。' }
  const tips = []
  if (!sys) tips.push(ui.isMac ? '没听到电脑的声音：确认声音是从这台电脑放出来的；「系统设置 → 隐私与安全性 → 录屏与系统录音」的「仅系统录音」里要打开会议字幕。' : '没听到电脑的声音：确认会议声音是从这台电脑的默认扬声器或耳机里放出来的。')
  if (!mic) tips.push('没听到麦克风：看看系统设置里的输入设备和音量。')
  if (r.error) tips.push(r.error)
  return { state: 'err', text: tips.join(' ') }
}

/* ---------------- 翻页 ---------------- */

const stepsEl = document.getElementById('steps')
let stepItems = []
const buildSteps = () => (stepItems = STEPS.map((s, i) => {
  const li = el('li.step', { tabindex: '0', role: 'button', 'aria-label': `第 ${i + 1} 步：${s.label}` }, el('span.step-dot'), el('span.step-label.truncate', { text: s.label }))
  li.addEventListener('click', () => go(i))
  li.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      go(i)
    }
  })
  stepsEl.append(li)
  return li
}))

function renderSteps() {
  stepItems.forEach((li, i) => {
    const done = isDone(i)
    li.classList.toggle('is-current', i === cur)
    li.classList.toggle('is-done', done && i !== cur)
    li.classList.toggle('is-complete', done)
    li.setAttribute('aria-current', i === cur ? 'step' : 'false')
    const dot = li.firstChild
    ui.clear(dot)
    if (done) dot.append(icon('check', 12))
    else dot.textContent = String(i + 1)
  })
}

function renderFoot() {
  const last = cur === STEPS.length - 1
  const done = isDone(cur)
  const prev = document.getElementById('prev')
  prev.replaceChildren(icon('chevron-left', 14), el('span', { text: '上一步' }))
  prev.hidden = cur === 0
  document.getElementById('count').textContent = `第 ${cur + 1} 步，共 ${STEPS.length} 步`
  const later = document.getElementById('later')
  later.hidden = last || done
  const next = document.getElementById('next')
  next.replaceChildren(el('span', { text: last ? '完成，开始使用' : '下一步' }), ui.kbd('Enter', { size: 'sm' }))
  next.disabled = !last && !done
}

function go(i) {
  cur = Math.max(0, Math.min(STEPS.length - 1, i))
  if (!pages[cur]) {
    pages[cur] = el('section.ob-step', { 'aria-label': STEPS[cur].label }, STEPS[cur].build())
    document.getElementById('main').append(pages[cur])
  }
  pages.forEach((p, j) => p && (p.hidden = j !== cur))
  document.getElementById('main').scrollTop = 0
  renderSteps()
  renderFoot()
  if (STEPS[cur].key === 'project') refreshProjects().then(renderProjectStep)
  if (cur === STEPS.length - 1 && ui.isMac) refreshScreen()
}

async function refreshScreen() {
  const r = await P.call('screenPermission')
  if (typeof r === 'string') screenPerm = r
  renderScreenPerm()
}

async function finish() {
  await P.flush()
  const r = await P.call('finishOnboarding')
  if (r?.missing) window.close()
}

document.getElementById('prev').addEventListener('click', () => go(cur - 1))
document.getElementById('later').addEventListener('click', () => go(cur + 1))
document.getElementById('next').addEventListener('click', () => {
  if (cur === STEPS.length - 1) finish()
  else if (isDone(cur)) go(cur + 1)
})

// 回车 = 下一步（在输入框、按钮里按回车不算）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.target instanceof Element && e.target.closest('input, textarea, button, select, [role="button"], .menu, .modal')) return
  const next = document.getElementById('next')
  if (!next.disabled) {
    e.preventDefault()
    next.click()
  }
})

async function boot() {
  init = await api.init()
  ui.applyChrome(init.chrome)
  ob = { ...ob, ...(init.onboarding || {}) }
  projects = Array.isArray(init.projects) ? init.projects : []
  screenPerm = init.screenPermission ?? null
  showForm = !projects.some((p) => !p.inbox && p.id !== 'inbox' && !p.archived)
  P.boot(init)
  // 没配账号平台（从源码编的版本）没有登录这一步
  if (init.account?.off) STEPS.shift()
  buildSteps()
  // 在第 0 步登录好了就自动翻到下一步
  let wasIn = accountDone()
  P.onAccount(() => {
    const now = accountDone()
    renderSteps()
    renderFoot()
    if (now && !wasIn && STEPS[cur].key === 'account') setTimeout(() => STEPS[cur].key === 'account' && go(cur + 1), 700)
    wasIn = now
  })
  P.on('onboarding:changed', (st) => {
    ob = { ...ob, ...(st || {}) }
    renderSteps()
    renderFoot()
    for (const f of chooseHints) f()
  })
  // 换了 AI 服务或识别服务：这一步算不算做完跟着变
  P.watch(() => {
    if (!pages.length) return
    renderSteps()
    renderFoot()
    for (const f of chooseHints) f()
  })
  P.on('projects:changed', (p) => {
    if (Array.isArray(p?.projects)) projects = p.projects
    renderProjectStep()
  })
  window.addEventListener('focus', () => {
    if (cur === STEPS.length - 1 && ui.isMac) refreshScreen()
  })
  const first = STEPS.findIndex((s, i) => s.key && !isDone(i))
  go(first < 0 ? STEPS.length - 1 : first)
}

boot()
