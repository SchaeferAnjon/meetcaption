// 设置窗口：左边分区，右边一组组「左标签、右控件」的行。改了就存（parts.js 合并成 patch 发给主进程）。
const P = window.parts
const api = window.app
const { el, icon } = ui

let init = null
let sessionsDir = ''
let onboarding = {}
let llm = null
let screenPerm = null
let perms = {} // { microphone, screen }：'granted' | 'denied' | 'not-determined' | 'restricted'
let renderPerms = () => {}
let overlayState = { visible: true, editMode: false }
let current = ''
// 分区建好后才有的刷新函数
let aiWarnRender = () => {}
let screenWarnNode = null
let renderEditBtn = () => {}

const LAST = 'meetcaption.settings.section'
const ALIAS = { pricing: 'member', plan: 'member', license: 'member', permission: 'permissions', privacy: 'permissions', account: 'ai', login: 'ai', llm: 'ai', chatgpt: 'ai', hotkey: 'hotkeys', shortcuts: 'hotkeys', caption: 'overlay', captions: 'overlay', display: 'overlay', answer: 'assist', microphone: 'mic', recognition: 'asr', classroom: 'class', lecture: 'class', notes: 'class' }

/* ---------------- 小部件 ---------------- */

// 开关 + 一句说明，点文字也能切换
function toggleLine(key, text) {
  const input = P.toggleInput(key, { label: text })
  return el('label.toggle-line', {}, input, el('span', { text }))
}

// 匿名使用统计：设置里是三态（'' 没问过 | yes | no），只有 yes 显示为开；这里打开算同意、关掉算不同意
function consentLine(text) {
  const input = ui.toggle({ ariaLabel: text, onChange: (v) => api.setUsageConsent(v) })
  P.watch((s) => (input.checked = s.usageConsent === 'yes'))
  return el('label.toggle-line', {}, input, el('span', { text }))
}

function linkButton(text, onClick) {
  return el('button.link-btn', { type: 'button', onClick }, el('span', { text }), icon('chevron-right', 13))
}

function pathBox(getText) {
  const box = el('div.path.mono.selectable')
  P.watch(() => (box.textContent = getText() || ''))
  return box
}

/* ---------------- 各分区 ---------------- */

function buildGeneral() {
  const reset = el('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: () => P.set('saveDir', '', 0) }, t('恢复默认'))
  P.watch((s) => (reset.hidden = !s.saveDir))
  P.watch((s) => document.documentElement.style.setProperty('--sidebar-opacity', String(s.sidebarOpacity ?? 0.85)))
  return [
    P.section(
      t('启动和外观'),
      null,
      P.row(t('开机启动'), toggleLine('launchAtLogin', t('登录电脑后自动打开')), t('在后台运行，托盘里点一下就能开始会议。')),
      // 每种语言用它自己的写法，看不懂当前界面的人也找得到
      P.row(
        t('界面语言'),
        P.selectField(
          'uiLang',
          [
            { value: 'auto', label: t('跟随系统') },
            ...[['zh', '简体中文'], ['zh-Hant', '繁體中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano']].map(([value, label]) => ({ value, label })),
          ],
          { label: t('界面语言'), width: 200 },
        ),
        t('换了以后所有窗口会重新加载一次。'),
      ),
      P.row(
        t('外观'),
        P.segField(
          'theme',
          [
            { value: 'system', label: t('跟随系统'), icon: 'monitor' },
            { value: 'dark', label: t('深色'), icon: 'moon' },
            { value: 'light', label: t('浅色'), icon: 'sun' },
          ],
          { label: t('外观') },
        ),
      ),
      ui.isMac || document.documentElement.classList.contains('is-win')
        ? P.row(t('侧栏不透明度'), P.slider('sidebarOpacity', { min: 0.3, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, label: t('侧栏不透明度') }), t('左边侧栏透出桌面的程度：越高越实，字越清楚。字幕的背景在「字幕与答题框」的「背景深浅」里调。'))
        : null,
    ),
    P.section(
      t('会议文件'),
      null,
      P.row(
        t('保存位置'),
        [
          pathBox(() => P.get('saveDir') || sessionsDir),
          el(
            'div.form-inline',
            {},
            el('button.btn.btn-sm', { type: 'button', onClick: pickDir }, icon('folder', 14), el('span', { text: t('更改…') })),
            el('button.btn.btn-sm', { type: 'button', onClick: () => api.openFolder(null) }, icon('external-link', 13), el('span', { text: ui.isMac ? t('在访达中显示') : t('打开文件夹') })),
            reset,
          ),
        ],
        t('每个项目一个文件夹，会议记录和纪要都在里面。换位置不会搬走已有的会议，想一起带走就把整个文件夹拷过去再选它。'),
      ),
    ),
    P.section(
      t('隐私'),
      null,
      P.row(t('屏幕共享'), toggleLine('hideFromScreenShare', t('共享屏幕时隐藏字幕和答题框')), t('对方看你的共享屏幕、录屏或截图时都看不到这两个窗口，只有你自己看得见。')),
      P.row(t('匿名使用统计'), consentLine(t('每天发一次匿名统计')), t('我们会给前 100 位用户免费额度，所以需要统计有多少人在用。统计是匿名的。开着时每天发一次：随机编号、版本号、系统和芯片、用会员还是自带 Key、界面语言，只用来统计每天有多少人在用。不发会议内容、Key、名字和邮箱；关着什么都不发。')),
    ),
    buildUpdate(),
    P.section(
      t('首次引导'),
      null,
      P.row('', el('div.form-inline', {}, el('button.btn', { type: 'button', onClick: () => api.openOnboarding() }, icon('play', 14), el('span', { text: t('再走一遍引导') })), el('button.btn.btn-ghost', { type: 'button', onClick: () => api.openGuide() }, el('span', { text: t('看主窗口导览') }))), t('引导：授权、语言、试听、声纹再走一遍。导览：在主窗口上指一遍开始会议、字幕、答题卡和语言按钮。')),
    ),
  ]
}

// electron-updater / Squirrel 的原文报错换成看得懂的话，认不出的原样给
function updateError(msg, version = '') {
  const m = String(msg ?? '')
  if (/code signature|code requirement/i.test(m)) return t('新版本的签名和装着的这一版对不上，没有装')
  // 查到了新版（latest-mac.yml 在），但它的安装包（zip）下载不到：不是「没有新版」
  const down = m.match(/Cannot download .*status (\d{3})/i)
  if (down) return version ? t('新版本 {0} 的安装包下载不到（{1}），过一会儿再试', version, down[1]) : t('新版本的安装包下载不到（{0}），过一会儿再试', down[1])
  // GitHub 上最新的那一版没带 latest-mac.yml / latest.yml（0.5.9 就没有）
  if (/Cannot find channel/i.test(m)) return t('GitHub 上还没有能自动更新的新版本')
  if (/read-only/i.test(m)) return t('应用在只读的位置（比如直接从安装包里打开），装不上新版本')
  if (/net::|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|getaddrinfo|socket hang up/i.test(m)) return t('连不上 GitHub，过一会儿会再查')
  return m
}

const SITE_URL = 'https://meetcaption.us-cloud.uk'
const APPS_URL = 'https://apps.us-cloud.uk'
const CONTACT_EMAIL = 'infoschaeferanjon@gmail.com'

// 装的是哪个包：Mac 看包的芯片（arch），Intel 版在 Apple 芯片的 Mac 上是 Rosetta 转译跑的（translated），这时提示换原生版
function buildKind({ platform, arch, translated }) {
  if (platform === 'win32') return { label: t('Windows 版'), rosetta: false }
  if (platform !== 'darwin') return { label: '', rosetta: false }
  if (arch === 'arm64') return { label: t('Apple 芯片版'), rosetta: false }
  return { label: t('Intel 芯片版'), rosetta: translated === true }
}

// 两句话排成一行：前一句没有句末标点就补上（状态句本身都不带句号）
function joinSentences(first, next) {
  if (!next) return first
  return `${/[.。!！?？…]$/.test(first) ? first : t('{0}。', first)} ${next}`
}

/* 通用 → 更新：自动检查的开关、现在的状态（main/updater.js 的 phase）、检查更新、下好了重启更新 */
function buildUpdate() {
  const line = el('span.text-2.plain-line')
  const check = el('button.btn.btn-sm', { type: 'button' }, icon('refresh-cw', 13), el('span', { text: t('检查更新') }))
  const install = el('button.btn.btn-sm.btn-primary', { type: 'button', hidden: true }, el('span', { text: t('重启更新') }))
  let st = init.update ?? { phase: 'off' }
  let manualError = ''
  const when = (ms) => (ms ? fmtDate(ms, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '')
  function render() {
    const text = {
      off: t('开发版和从源码运行时不自动更新。'),
      idle: t('当前版本 {0}', init.version),
      checking: t('正在检查…'),
      downloading: t('正在下载新版本 {0}，{1}%', st.version, st.percent ?? 0),
      ready: t('新版本 {0} 已下载好，重启就能用。', st.version),
      latest: t('已是最新版本 {0}，{1} 查过', init.version, when(st.checkedAt)),
      error: t('更新出错：{0}', updateError(manualError || st.error, st.version)),
    }[st.phase]
    // Squirrel 要把新版换到应用所在的位置：从下载文件夹、dmg 里直接打开的（只读）装不上。两句之间补上句末标点
    const apps = st.inApps === false && st.phase !== 'off' ? t('会议字幕不在「应用程序」文件夹里，可能装不上更新：把它拖进「应用程序」后再打开。') : ''
    line.textContent = joinSentences(text, apps)
    check.disabled = ['off', 'checking', 'downloading', 'ready'].includes(st.phase)
    install.hidden = st.phase !== 'ready'
  }
  check.addEventListener('click', async () => {
    manualError = ''
    st = { ...st, phase: 'checking' }
    render()
    const r = await api.checkUpdate()
    if (r?.ok === false) manualError = r.error
    st = r?.state ?? st
    render()
  })
  install.addEventListener('click', async () => {
    const r = await api.installUpdate()
    if (r?.ok === false) ui.toast({ title: t('现在不能重启更新'), message: r.error, type: 'error' })
  })
  api.on('update:state', (next) => {
    st = next
    render()
  })
  render()
  return P.section(
    t('更新'),
    null,
    P.row(t('自动更新'), toggleLine('autoUpdate', t('自动检查并下载新版本')), t('有新版本时在后台下载，下好后提示你重启；正在记录时不会重启。不点重启也行，下次退出时自动装上。')),
    P.row('', [line, el('div.form-inline', {}, check, install)]),
  )
}

async function pickDir() {
  const dir = await P.call('pickDir')
  if (typeof dir === 'string' && dir) P.set('saveDir', dir, 0)
}

// 会员模式下「账号与 AI」「语音识别」里的设置不起作用：顶上说一句，给个换用法的入口
function memberNote(what) {
  const note = P.callout(
    'info',
    'sparkles',
    t(`正在用会员的{0}`, what),
    t(`会员模式下{0}由 MeetCaption 提供，不用填 Key。下面的设置在换成「自带 Key」后才用。`, what),
    el('button.btn.btn-sm', { type: 'button', onClick: () => go('member') }, t('会员设置')),
  )
  P.showWhen(note, (s) => s.plan === 'member')
  return note
}

function buildAi() {
  const test = P.testButton(t('测试 AI 服务'), () => P.call('testLlm', {}), (r) => t(`可以用，{0} 秒：{1}`, ((r.ms ?? 0) / 1000).toFixed(1), r.sample ?? ''))
  const testRow = P.row('', test)
  P.showWhen(testRow, (s) => s.llmProvider !== 'chatgpt')
  return [
    memberNote('AI'),
    P.section(t('AI 服务'), t('翻译、术语解释、会后纪要和 AI 答题都用它。每家的 Key 分开存，换来换去不会丢。'), P.providerPicker({ recommend: null }), ...P.providerSetup(), testRow),
    P.section(
      t('模型'),
      t('一般不用改。换服务时自动换成那家的推荐模型；想换别的，点输入框右边的箭头从那家的模型里选，也可以直接填模型名。翻译和答题会关掉模型的思考，纪要照常思考。'),
      P.row('', modelsLine),
      P.row(t('翻译和术语'), modelField('llmFastModel', { label: t('翻译和术语模型') }), t('要快，每句话都会用一次。')),
      P.row(t('会后纪要'), modelField('llmSummaryModel', { label: t('纪要模型') }), t('要准，一场会用一次。')),
      P.row(t('AI 答题'), modelField('llmAnswerModel', { placeholder: t('留空自动选'), label: t('答题模型') }), t('留空时 ChatGPT 账号用 gpt-5.6-terra，其他服务跟翻译模型一样。')),
    ),
  ]
}

/* ---------------- 模型列表 ---------------- */

// 填好地址和 Key 后从服务的 /models 拉一次模型名，模型输入框右边的箭头从里面选；拉不到照样手填
let models = { list: [], error: '', busy: false, label: '' }
let modelsSeq = 0
const modelsLine = el('div.form-hint.models-line', { role: 'status' })

async function refreshModels() {
  const seq = ++modelsSeq
  models = { ...models, busy: true }
  renderModelsLine()
  const r = await P.call('listModels')
  if (seq !== modelsSeq) return
  models = r?.ok ? { list: r.models ?? [], error: '', busy: false, label: r.label ?? '' } : { list: [], error: r?.error || t('没拉到'), busy: false, label: '' }
  renderModelsLine()
}

function renderModelsLine() {
  modelsLine.textContent = models.busy
    ? t('正在拉取模型列表…')
    : models.error
      ? t(`没拉到模型列表：{0}。可以直接填模型名。`, models.error)
      : models.list.length
        ? t(`从 {0} 拉到 {1} 个模型。`, models.label, models.list.length)
        : ''
  modelsLine.hidden = !modelsLine.textContent
}

function modelField(key, opts) {
  const input = P.textInput(key, { short: true, trim: true, ...opts })
  const pick = el('button.btn.btn-icon.model-pick', { type: 'button', 'aria-label': t(`从列表选{0}`, opts.label) }, icon('chevron-down', 14))
  ui.tip(pick, t('从列表选'), { delay: 400 })
  pick.addEventListener('click', async () => {
    if (!models.list.length) await refreshModels()
    if (!models.list.length) return
    ui.menu(
      pick,
      models.list.map((id) => ({ label: id, checked: P.get(key) === id, onSelect: () => P.set(key, id, 0) })),
      { align: 'end', searchable: models.list.length > 8, placeholder: t('搜索模型') },
    )
  })
  return el('div.form-inline.model-field', {}, input, pick)
}

function buildAsr() {
  const engineHint = el('div.form-hint')
  P.watch((s) => {
    engineHint.textContent =
      s.engine === 'local'
        ? t('在这台电脑上识别，免费，不用联网，也不用填 Key。中文、英文和中英夹杂都能认，说完一个词约半秒出字。专有名词偶尔听错，AI 纠错会按项目术语改回来。')
        : s.engine === 'soniox'
          ? t('Soniox 实时识别，60 种语言，中英文和外语都比豆包准，按连接时长计费。在 console.soniox.com 注册拿 API Key。')
          : s.engine === 'volc'
            ? t('豆包流式语音识别（火山引擎），只认中文和英文，国内网络可以直连，要自己开通、按小时付费。')
            : t('OpenAI 实时转写，要 API Key，约 1 美元一小时，只在有人说话时计费。')
  })
  const openaiRows = el(
    'div',
    {},
    P.row('OpenAI API Key', P.textInput('openaiKey', { secret: true, trim: true, placeholder: 'sk-…', label: 'OpenAI API Key' }), t('和「账号与 AI」里是同一个 Key。')),
    P.row(
      t('出字速度'),
      P.selectField(
        'openaiDelay',
        [
          { value: 'minimal', label: t('最快'), description: t('可能多错几个词') },
          { value: 'low', label: t('快（推荐）') },
          { value: 'medium', label: t('平衡') },
          { value: 'high', label: t('更准'), description: t('慢半拍') },
        ],
        { width: 200, label: t('出字速度') },
      ),
    ),
  )
  const sonioxRows = el('div', {}, P.row('Soniox API Key', P.textInput('sonioxKey', { secret: true, trim: true, label: 'Soniox API Key' })))
  const volcRows = el(
    'div',
    {},
    P.row('App ID', P.textInput('volcAppId', { trim: true, mono: true, label: 'App ID' })),
    P.row('Access Token', P.textInput('volcAccessToken', { secret: true, trim: true, label: 'Access Token' })),
    P.row(t('资源 ID'), P.textInput('volcResourceId', { trim: true, mono: true, label: t('资源 ID') }), t('在火山引擎控制台开通「豆包流式语音识别大模型」，在旧版控制台拿 App ID 和 Access Token。默认用 2.0（volc.seedasr.sauc.duration，更准，说完一句会再整句识别一遍）；只开通了 1.0 就填 volc.bigasr.sauc.duration。')),
  )
  const advanced = P.section(
    t('高级'),
    null,
    P.row(t('API 地址'), P.textInput('openaiBaseUrl', { trim: true, mono: true, label: t('API 地址') })),
    P.row(t('识别模型'), P.textInput('openaiModel', { trim: true, mono: true, label: t('识别模型') })),
  )
  P.showWhen(openaiRows, (s) => s.engine === 'openai')
  P.showWhen(volcRows, (s) => s.engine === 'volc')
  P.showWhen(sonioxRows, (s) => s.engine === 'soniox')
  P.showWhen(advanced, (s) => s.engine === 'openai')
  const test = P.testButton(t('测试'), () => P.call('testAsr', {}), () => (P.get('engine') === 'local' ? t('本地识别可以用了') : t('连接成功，可以开始用了')))
  return [
    memberNote(t('识别')),
    P.section(
      t('识别服务'),
      t('把对方和你说的话实时转成文字。对方说的语言在每个项目的「资料」里设置。'),
      P.row(
        t('服务'),
        [
          P.segField(
            'engine',
            [
              { value: 'local', label: t('本地（免费）') },
              { value: 'soniox', label: 'Soniox' },
              { value: 'volc', label: t('豆包') },
              { value: 'openai', label: 'OpenAI' },
            ],
            { label: t('识别服务') },
          ),
          engineHint,
        ],
      ),
      sonioxRows,
      openaiRows,
      volcRows,
      P.row('', test),
    ),
    advanced,
  ]
}

function buildVoiceprint() {
  const micOff = P.callout('warn', 'mic-off', t('麦克风没打开'), t('「麦克风」里没打开「同时记录我说的话」，开会时用不上声纹。'), el('button.btn.btn-sm', { type: 'button', onClick: () => go('mic') }, t('去打开')))
  P.showWhen(micOff, (s) => !s.captureMic)
  return [
    P.section(t('我的声纹'), t('录 12 秒你的声音，软件就能分清哪句是你说的、哪句是对方说的。开外放时串进麦克风的对方声音也能滤掉。声纹只存在这台电脑上。'), micOff, P.voiceprintRecorder()),
    P.section(
      t('高级'),
      null,
      P.row(
        t('判定阈值'),
        P.slider('voiceprint.threshold', { min: 0.3, max: 0.8, step: 0.05, format: (v) => Number(v).toFixed(2), label: t('判定阈值') }),
        t('和声纹的相似度高于这个值才算你说的。调高：别人的话更不容易被当成你的；调低：你说得很短或嗓子哑时也能认出来。默认 0.50。'),
      ),
    ),
  ]
}

function buildAssist() {
  const aiWarn = el('div.top-callout')
  const renderAiWarn = () => {
    const bad = llm && llm.ready === false
    aiWarn.hidden = !bad
    if (bad) aiWarn.replaceChildren(P.callout('warn', 'triangle-alert', t('AI 服务还没准备好'), llm.reason || t('先在「账号与 AI」里登录或填 Key。'), el('button.btn.btn-sm', { type: 'button', onClick: () => go('ai') }, t('去设置'))))
  }
  aiWarnRender = renderAiWarn
  renderAiWarn()

  const screenWarn = P.callout(
    'warn',
    'monitor',
    t('还没有屏幕录制权限'),
    t('去「系统设置 → 隐私与安全性 → 录屏与系统录音」打开「会议字幕」，重启应用后生效。没开也能回答，只是不带截图。'),
    el('button.btn.btn-sm', { type: 'button', onClick: () => api.openPrivacy('screen') }, t('打开系统设置')),
  )
  screenWarn.hidden = true
  screenWarnNode = screenWarn

  const askKbd = el('span.kbd-slot')
  P.watch((s) => askKbd.replaceChildren(s.assist?.hotkeyAsk ? ui.kbd(s.assist.hotkeyAsk) : el('span.text-3', { text: t('未设置') })))

  const dep = el(
    'div',
    {},
    P.row(t('自动回答'), toggleLine('assist.auto', t('对方问完就自动回答')), t('关掉后，只在按快捷键时回答。')),
    P.row(t('屏幕截图'), [toggleLine('assist.withScreen', t('回答时附上当前屏幕截图')), screenWarn], t('讲 PPT 或共享屏幕时对方问「这一块怎么做的」，AI 能看到你屏幕上的内容。截图只发给 AI 服务，不保存。')),
    P.row(
      t('回答语言'),
      P.segField(
        'assist.answerLang',
        [
          { value: 'auto', label: t('跟提问一样') },
          { value: 'en', label: t('英文') },
          { value: 'zh', label: t('中文') },
        ],
        { label: t('回答语言') },
      ),
      t('最前面一行要点总是有的，用「翻译成」的语言写。'),
    ),
    P.row(t('快捷键'), el('div.form-inline', {}, askKbd, el('span.text-2', { text: t('让 AI 回答刚才的问题') }), linkButton(t('修改'), () => go('hotkeys')))),
  )
  P.enableWhen(dep, (s) => s.assist?.enabled)
  P.watch((s) => {
    if (screenWarnNode) screenWarnNode.hidden = !(ui.isMac && s.assist?.withScreen && screenPerm && screenPerm !== 'granted')
  })

  return [
    aiWarn,
    P.section(
      t('AI 答题'),
      t('对方提问后，屏幕右侧的答题框马上给出你可以照着说的回答：先一行要点（用「翻译成」的语言），再两到四句口语。答题框和字幕一样，共享屏幕时对方看不到。'),
      P.row(t('AI 答题'), toggleLine('assist.enabled', t('开启 AI 答题'))),
      dep,
    ),
    P.section(
      t('我的资料'),
      null,
      P.callout(
        'accent',
        'file-text',
        t('「我的资料」放在项目里'),
        t('简历要点、项目介绍、常被问的问题，现在按项目分开放，答题时用当前项目的资料。在主窗口打开项目，切到「资料」填写。'),
        el('button.btn.btn-sm', { type: 'button', onClick: () => api.showMain() }, t('打开主窗口')),
      ),
    ),
  ]
}
function buildOverlay() {
  const editBtn = el('button.btn', { type: 'button' })
  const renderEdit = () => {
    editBtn.replaceChildren(icon(overlayState.editMode ? 'check' : 'pencil', 14), el('span', { text: overlayState.editMode ? t('调整好了') : t('调整位置') }))
    editBtn.classList.toggle('btn-primary', Boolean(overlayState.editMode))
  }
  editBtn.addEventListener('click', () => api.editOverlay(!overlayState.editMode))
  renderEditBtn = renderEdit
  renderEdit()

  const resetColors = el('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: () => (P.set('overlay.textColor', '#ffffff', 0), P.set('overlay.translationColor', '#ffd666', 0)) }, t('恢复默认'))
  P.watch((s) => (resetColors.hidden = (s.overlay?.textColor || '').toLowerCase() === '#ffffff' && (s.overlay?.translationColor || '').toLowerCase() === '#ffd666'))

  const target = P.selectField('translateTarget', TARGET_LANGS, { label: t('翻译成'), width: 140 })
  const targetWrap = el('span.form-inline', {}, el('span.text-2', { text: t('翻成') }), target)
  P.enableWhen(targetWrap, (s) => s.translate)
  const trRow = P.row(t('译文'), toggleLine('overlay.showTranslation', t('在字幕里显示')), t('关掉后译文只在主窗口的实时记录里显示。'))
  P.enableWhen(trRow.querySelector('.form-control'), (s) => s.translate)

  // 意群颜色的两种样子：并排两张小预览，点哪张就用哪种
  const styleCards = el('div.chunk-styles', { role: 'radiogroup', 'aria-label': t('意群颜色的样式') })
  for (const [value, label, desc] of [
    ['text', t('文字着色'), t('原文片段和对应的译文直接上同一种颜色')],
    ['bar', t('底部色条'), t('文字颜色不变，下面一条同色细线')],
  ]) {
    const card = el(
      'button.chunk-style',
      { type: 'button', role: 'radio', dataset: { value } },
      P.captionPreview({ style: value, scale: 0.5, tip: false, compact: true }),
      el('span.chunk-style-label', {}, el('span.choice-radio'), el('span', { text: label }), value === window.bilingual?.DEFAULT_STYLE ? el('span.tag.tag-accent', { text: t('默认') }) : null),
      el('span.chunk-style-desc', { text: desc }),
    )
    card.addEventListener('click', () => P.set('display.chunkStyle', value, 0))
    styleCards.append(card)
  }
  P.watch((s) => {
    const cur = window.bilingual?.prefs(s).style
    for (const c of styleCards.children) c.setAttribute('aria-checked', String(c.dataset.value === cur))
  })
  const styleRow = P.row(t('样式'), styleCards)
  P.enableWhen(styleRow.querySelector('.form-control'), (s) => s.display?.chunkColors !== false)

  return [
    P.section(null, null, P.captionPreview()),
    P.section(
      t('双语对照'),
      t('每句原文下面紧跟它的译文，一句一对。按意群（主干、从句、介词短语）分色，原文片段和它的译文用同一种颜色；难词在两边都画虚线，悬停任一边都能看解释。字幕窗、主窗口的实时记录和字幕记录都一样。'),
      P.row(t('意群颜色对照'), toggleLine('display.chunkColors', t('按意群给中英文上同样的颜色')), t('关掉就是单色，翻译时也不再让 AI 额外做意群对齐。')),
      styleRow,
    ),
    P.section(
      t('字幕'),
      null,
      P.row(t('字号'), P.slider('overlay.fontSize', { min: 14, max: 48, step: 1, label: t('字号') })),
      P.row(t('显示行数'), P.slider('overlay.lines', { min: 1, max: 8, step: 1, label: t('显示行数') })),
      P.row(t('背景深浅'), P.slider('overlay.bgOpacity', { min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, label: t('背景深浅') })),
      P.row(t('颜色'), el('div.form-inline', {}, el('span.text-2', { text: t('原文') }), P.colorField('overlay.textColor', t('原文颜色')), el('span.text-2.gap-l', { text: t('译文') }), P.colorField('overlay.translationColor', t('译文颜色')), resetColors)),
      P.row(t('我说的话'), toggleLine('overlay.showMic', t('字幕里也显示我说的话')), t('一般不用开，自己说了什么自己知道；录音和纪要里都有。')),
    ),
    P.section(
      t('翻译和术语'),
      t('都用「账号与 AI」里的服务，每说完一句翻一句，一般比原文晚 2 到 5 秒出现。对方提问时先出答案，这句的译文再晚一两秒。'),
      P.row(t('翻译'), el('div.form-inline', {}, toggleLine('translate', t('翻译对方说的话')), targetWrap)),
      trRow,
      P.row(t('术语解释'), toggleLine('terms.enabled', t('专业词加虚线，悬停看解释')), t('鼠标停在字幕里的专业词上，弹出一句解释（用「翻译成」的语言）。主窗口的实时记录里也一样。')),
      P.row(t('纠错'), toggleLine('terms.correct', t('AI 纠正识别错误')), t('翻译时顺带改掉听错的词（近音误听、人名、术语拼写），改过的词下面有很淡的点线，悬停能看识别原文，存档里也留着识别原文。')),
    ),
    P.section(
      t('位置'),
      null,
      P.row(
        t('字幕和答题框'),
        el('div.form-inline', {}, editBtn, el('button.btn.btn-ghost', { type: 'button', onClick: () => api.resetOverlayPosition() }, icon('refresh-cw', 13), el('span', { text: t('恢复默认位置') }))),
        t('点「调整位置」后两个窗口会出现在屏幕上：拖动移动，拖边缘改大小，改好点「完成」。'),
      ),
    ),
  ]
}
function buildHotkeys() {
  const askHint = el('div.form-hint')
  P.watch((s) => {
    askHint.textContent = s.assist?.enabled ? t('对方的问题没被自动认出来，或者想换个说法时按一下。') : t('AI 答题关着，这个快捷键暂时不生效。')
  })
  const appKey = (name, label, def, hint) => P.row(label, P.hotkeyRecorder(`keys.${name}`, { def, label }), hint)
  return [
    P.section(
      t('全局快捷键'),
      t('在任何程序里都能用，包括会议软件全屏时。点一下快捷键，再按新的组合；按 Delete 不用这个快捷键。'),
      P.row(t('显示 / 隐藏'), P.hotkeyRecorder('hotkeyToggle', { def: 'CommandOrControl+Alt+S', label: t('显示 / 隐藏字幕') }), t('字幕窗和答题框一起显示或隐藏。')),
      P.row(t('开始 / 停止记录'), P.hotkeyRecorder('hotkeyRecord', { def: 'CommandOrControl+Alt+R', label: t('开始 / 停止记录') }), t('不用切回主窗口：没在记录就在当前项目里开始，正在记录就停止。')),
      P.row(t('回答刚才的问题'), P.hotkeyRecorder('assist.hotkeyAsk', { def: 'CommandOrControl+Alt+A', label: t('回答刚才的问题') }), askHint),
      P.row(t('截取画面'), P.hotkeyRecorder('class.hotkeySlide', { def: 'CommandOrControl+Alt+P', label: t('截取画面') }), t('上课记录时把当前屏幕（网课课件）存进这节课，只在上课时生效。')),
    ),
    P.section(
      t('主窗口里'),
      t('会议字幕的主窗口在最前面时才有效，改法同上。'),
      appKey('palette', t('命令面板'), 'CommandOrControl+K', t('搜项目、会议和待办，切换项目，执行命令。')),
      appKey('settings', t('打开设置'), 'CommandOrControl+,'),
      appKey('start', t('开始记录'), 'CommandOrControl+Shift+R', t('在当前项目里开始；已经在记录就回到记录页。')),
      appKey('live', t('回到正在进行的记录'), 'CommandOrControl+0'),
      appKey('newProject', t('新建项目'), 'CommandOrControl+N'),
      appKey('home', t('首页'), 'CommandOrControl+1'),
      appKey('todos', t('待办'), 'CommandOrControl+2'),
      appKey('back', t('返回上一页'), 'CommandOrControl+['),
      appKey('sidebar', t('收起 / 展开侧栏'), 'CommandOrControl+\\'),
    ),
  ]
}

function buildClass() {
  const pick = el('button.btn.btn-sm', { type: 'button', onClick: pickExportDir }, icon('folder', 14), el('span', { text: t('选择文件夹…') }))
  const clear = el('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: () => P.set('class.exportDir', '', 0) }, t('清除'))
  const dirBox = el('div.path.mono.selectable')
  P.watch((s) => {
    const d = s.class?.exportDir || ''
    dirBox.textContent = d || t('还没选。导出时会让你选一个文件夹，之后默认打开上次选的。')
    dirBox.classList.toggle('is-empty', !d)
    clear.hidden = !d
  })
  return [
    P.section(
      t('课堂模式'),
      t('上课时在开始按钮的下拉里选「课堂」：边听边出双语字幕，AI 每隔几分钟把新内容整理进实时笔记，下课生成课堂笔记（大纲、公式、老师强调的考点、作业、术语表和自测题）。作业会进这门课所在项目的待办。'),
      P.row(
        t('默认声音来源'),
        P.segField(
          'class.source',
          [
            { value: 'mic', label: t('教室现场（麦克风）'), icon: 'mic' },
            { value: 'system', label: t('网课（电脑声音）'), icon: 'monitor' },
          ],
          { label: t('默认声音来源') },
        ),
        t('老师在教室里讲就用麦克风听；看网课就听电脑里的声音。每个项目可以在「资料」里单独设，开始前在下拉里也能临时换。'),
      ),
      P.row(
        t('实时笔记'),
        P.segField(
          'class.notesEveryMin',
          [
            { value: 1, label: t('1 分钟') },
            { value: 2, label: t('2 分钟') },
            { value: 5, label: t('5 分钟') },
          ],
          { label: t('实时笔记更新频率') },
        ),
        t('每攒够这么久的新内容整理一次笔记（讲得快时攒够 400 个英文词也会整理）。越频繁越跟得上，用的 AI 额度也越多。'),
      ),
    ),
    P.section(
      t('截取画面'),
      null,
      P.row(t('快捷键'), P.hotkeyRecorder('class.hotkeySlide', { def: 'CommandOrControl+Alt+P', label: t('截取画面') }), t('上课记录时按一下，把当前屏幕（网课的课件）存进这节课的文件夹。实时记录里会出现缩略图，课堂笔记会在对应的位置引用它。主窗口里也有「截取画面」按钮。')),
    ),
    P.section(t('导出'), null, P.row(t('笔记库文件夹'), [dirBox, el('div.form-inline', {}, pick, clear)], t('在课堂记录里点「导出到笔记库」，选文件夹时默认打开这里；课堂笔记.md 和用到的截图会拷过去，文件名带日期和标题。比如选 Obsidian 库里的课程目录。'))),
  ]
}

async function pickExportDir() {
  const dir = await P.call('pickDir')
  if (typeof dir === 'string' && dir) P.set('class.exportDir', dir, 0)
}

let micSelect = null
async function refreshMics() {
  if (!micSelect) return
  let devices = []
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  } catch {}
  const cur = P.get('micDeviceId') || ''
  const options = [{ value: '', label: t('系统默认') }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || t(`麦克风 {0}`, i + 1) }))]
  if (cur && !options.some((o) => o.value === cur)) options.push({ value: cur, label: t('之前选的麦克风（现在没接）') })
  micSelect.setOptions(options, cur)
}

/* ---------------- 权限 ---------------- */

const PERM_TAG = {
  granted: ['tag-ok', t('已允许')],
  denied: ['tag-warn', t('被拒绝了')],
  restricted: ['tag-warn', t('被系统限制')],
  'not-determined': ['tag-warn', t('还没允许')],
}

// 一行权限：状态标签 + 按钮。没问过点「允许」弹系统框；被拒过只能去系统设置里打开
function permRow(label, kind, hint, { extra = null, renderExtra } = {}) {
  const tag = el('span.tag')
  const allow = el('button.btn.btn-sm', { type: 'button' }, t('允许'))
  const open = el('button.btn.btn-sm', { type: 'button', onClick: () => api.openPrivacy(kind) }, icon('external-link', 13), el('span', { text: t('打开系统设置') }))
  allow.addEventListener('click', async () => {
    allow.classList.add('is-loading')
    const r = await P.call('requestPermission', kind)
    allow.classList.remove('is-loading')
    if (r?.status && r.status !== 'granted') api.openPrivacy(kind)
    refreshPerms()
  })
  const render = () => {
    const st = perms[kind] ?? 'not-determined'
    const [cls, text] = PERM_TAG[st] ?? PERM_TAG['not-determined']
    tag.className = `tag ${cls}`
    tag.textContent = text
    allow.hidden = st !== 'not-determined'
    open.hidden = st === 'granted'
    renderExtra?.(st)
  }
  return { node: P.row(label, el('div.form-inline', {}, tag, allow, open, extra), hint), render }
}

function buildPermissions() {
  const mic = permRow(t('麦克风'), 'microphone', t('录你自己说的话、录声纹；教室现场上课时用它听老师讲课。'))
  const rows = [mic]
  const extra = []
  if (ui.isMac) {
    // 屏幕录制在这次打开设置以后才给的，要重启才生效：这时才出「重启」
    const wasOff = perms.screen !== 'granted'
    const restart = el('button.btn.btn-sm', { type: 'button', onClick: () => P.call('relaunch') }, icon('refresh-cw', 13), el('span', { text: t('重启生效') }))
    const screen = permRow(t('屏幕录制'), 'screen', t('AI 答题时带上屏幕截图、课堂上截取画面。在系统设置里打开以后，要重启会议字幕才生效。'), { extra: restart, renderExtra: (st) => (restart.hidden = !(wasOff && st === 'granted')) })
    rows.push(screen)
    extra.push(
      P.row(
        t('系统录音'),
        el(
          'div.form-inline',
          {},
          el('span.tag', { text: t('用到时检查') }),
          el('button.btn.btn-sm', { type: 'button', onClick: () => P.call('requestPermission', 'systemAudio') }, t('允许')),
          el('button.btn.btn-sm', { type: 'button', onClick: () => api.openPrivacy('screen') }, icon('external-link', 13), el('span', { text: t('打开系统设置') })),
        ),
        t('抓会议软件里对方的声音。macOS 没有办法查它给没给：点「允许」时系统会弹框；以前点过不允许，就在「录屏与系统录音」里打开「会议字幕」。'),
      ),
    )
  }
  renderPerms = () => {
    for (const r of rows) r.render()
    renderNavWarn()
  }
  renderPerms()
  return [
    P.section(t('系统权限'), ui.isMac ? t('会议字幕要用的系统权限都在这里，没给的点「允许」，以前拒绝过的点「打开系统设置」。') : t('Windows 上电脑声音和屏幕截图不用单独授权，只有麦克风要。'), ...rows.map((r) => r.node), ...extra),
  ]
}

async function refreshPerms() {
  const r = await P.call('permissionStatus')
  if (r && !r.missing) perms = r
  renderPerms()
}

function buildMic() {
  micSelect = P.selectField('micDeviceId', [{ value: '', label: t('系统默认') }], { width: 280, label: t('麦克风') })
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics)
  const vpHint = P.callout('accent', 'fingerprint-pattern', t('还没录声纹'), t('录 12 秒，就能分清你和对方，外放时串进来的声音也能滤掉。'), el('button.btn.btn-sm.btn-primary', { type: 'button', onClick: () => go('voiceprint') }, t('去录声纹')))
  const renderVpHint = () => (vpHint.hidden = !(P.get('captureMic') && P.voiceprint() && !P.voiceprint().enrolled && !P.voiceprint().unsupported))
  P.watch(renderVpHint)
  P.onVoiceprint(renderVpHint)
  const dep = P.row(t('麦克风'), micSelect, t('换了耳机或外接麦克风后在这里选。'))
  P.enableWhen(dep, (s) => s.captureMic)
  return [
    P.section(
      t('麦克风'),
      t('开会时同时记录你自己说的话，会后纪要更完整。'),
      P.row(t('我说的话'), toggleLine('captureMic', t('开会时同时记录我说的话')), t('识别费用大约翻倍。外放时麦克风会串进对方的声音，录好声纹后会自动滤掉；戴耳机效果最好。')),
      dep,
    ),
    vpHint,
  ]
}

/* ---------------- 会员 ---------------- */

let memberSnap = null
let renderMember = () => {}

function buildMember() {
  const box = el('div.member-status')
  const codeInput = el('input.input.mono', { type: 'text', placeholder: 'MC-XXXX-XXXX-XXXX', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('授权码') })
  const codeOut = el('div.test-line', { role: 'status' })
  const activate = el('button.btn', { type: 'button' }, el('span', { text: t('激活') }))
  activate.addEventListener('click', async () => {
    const code = codeInput.value.trim()
    if (!code) return codeInput.focus()
    activate.classList.add('is-loading')
    const r = await P.call('memberActivate', code)
    activate.classList.remove('is-loading')
    codeOut.dataset.state = r?.ok ? 'ok' : 'err'
    codeOut.replaceChildren(icon(r?.ok ? 'circle-check' : 'circle-alert', 14), el('span', { text: r?.ok ? t(`已激活，剩 {0} 场`, r.info?.balance ?? 0) : r?.error || t('没能激活') }))
    if (r?.ok) {
      codeInput.value = ''
      if (P.get('plan') !== 'member') P.set('plan', 'member', 0)
    }
  })
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) activate.click()
  })

  renderMember = () => {
    const info = memberSnap?.info
    const rows = []
    if (!info) {
      rows.push(el('div.form-hint', { text: memberSnap?.error || t('正在连接会员服务器…') }))
    } else {
      const trial = info.kind !== 'paid'
      rows.push(
        el(
          'div.member-balance',
          {},
          el('b', { text: String(Math.max(0, info.balance)) }),
          el('span', { text: t(` 场{0}，每场最长 {1} 小时`, trial ? t('（免费试用）') : '', (info.sessionMs ?? 2 * 3600_000) / 3600_000) }),
        ),
      )
      if (info.code)
        rows.push(
          el(
            'div.member-code',
            {},
            el('span.form-hint', { text: t('授权码') }),
            el('code.selectable', { text: info.code }),
            el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => navigator.clipboard.writeText(info.code).then(() => ui.toast({ title: t('授权码已复制'), type: 'success' })) }, icon('copy', 13), el('span', { text: t('复制') })),
          ),
          el('div.form-hint', { text: t(`用在 {0} 台电脑上，最多 2 台。`, info.devices ?? 1) }),
        )
      const recent = (info.recent ?? []).filter((x) => x.ended_at || x.active_ms)
      if (recent.length)
        rows.push(
          el(
            'div.member-recent',
            {},
            recent.map((x) =>
              el('div', {
                text: t(`{0} · 用了 {1} 分钟 · {2}`, new Date(x.started_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), Math.round((x.active_ms ?? 0) / 60000), x.refunded ? t('不到 5 分钟，没扣') : t(`扣 {0} 场`, x.charged)),
              }),
            ),
          ),
        )
    }
    const actions = el(
      'div.form-inline',
      {},
      el('button.btn.btn-primary', { type: 'button', onClick: () => P.call('showPricing') }, el('span', { text: memberSnap?.buying ? t('正在等付款…') : t('购买场次') })),
      info && !info.trialOnly
        ? el(
            'button.btn.btn-ghost',
            {
              type: 'button',
              onClick: async () => {
                if (!(await ui.confirm({ title: t('解绑这台电脑？'), message: t('这台电脑不再用这个授权码，退回它自己的试用场次。授权码在别的电脑上照常用，以后输码还能再绑回来。'), okLabel: t('解绑') }))) return
                await P.call('memberUnbind')
              },
            },
            el('span', { text: t('解绑这台电脑') }),
          )
        : null,
    )
    box.replaceChildren(...rows, actions)
  }
  renderMember()

  const own = P.callout(null, 'key-round', t('正在用自带 Key'), t('识别和 AI 用你在「账号与 AI」「语音识别」里配的服务，不经过我们，不扣场次。'))
  P.showWhen(own, (s) => s.plan === 'own')
  const memberRows = [
    P.row(t('剩余场次'), box),
    P.row(t('识别'), P.segField('memberAsr', [
      { value: 'cloud', label: t('云识别（Soniox）'), icon: 'audio-lines' },
      { value: 'local', label: t('本地识别'), icon: 'monitor' },
    ], { label: t('会员用哪种识别') }), t('云识别更准，专有名词少听错；本地识别在电脑上跑、断网也能用。两种都按场算，AI 照样能用。')),
  ]
  for (const r of memberRows) P.showWhen(r, (s) => s.plan === 'member')
  return [
    P.section(
      t('用法'),
      t('会员不用填任何 Key，识别和 AI 都由我们提供，按场扣；自带 Key 永久免费，费用直接付给你选的服务商。'),
      P.row('', P.segField('plan', [
        { value: 'member', label: t('会员（免配置）'), icon: 'sparkles' },
        { value: 'own', label: t('自带 Key'), icon: 'key-round' },
      ], { label: t('用法') })),
      own,
      ...memberRows,
    ),
    P.section(t('授权码'), t('在别的电脑上买过，或者官网买的：输入授权码，这台电脑就用那里的场次。'), P.row('', el('div.form-inline', {}, codeInput, activate), codeOut)),
  ]
}

function buildAbout() {
  const toggleKbd = el('span.kbd-slot')
  const askKbd = el('span.kbd-slot')
  const recordKbd = el('span.kbd-slot')
  const stopKbd = el('span.kbd-slot')
  const k = (v) => (v ? ui.kbd(v) : el('span.text-3', { text: t('（快捷键没设）') }))
  P.watch((s) => {
    toggleKbd.replaceChildren(k(s.hotkeyToggle))
    askKbd.replaceChildren(k(s.assist?.hotkeyAsk))
    recordKbd.replaceChildren(k(s.hotkeyRecord))
    stopKbd.replaceChildren(k(s.hotkeyRecord))
  })
  const steps = [
    [t('在主窗口选好项目，点「开始会议」，或者在会议软件里直接按 '), recordKbd, t('。对方说话时屏幕下方就会出字幕，每句都会存档。')],
    [t('按 '), toggleKbd, t(' 随时隐藏或显示字幕和答题框；对方问了问题没自动回答时，按 '), askKbd, t('。')],
    [t('会议结束点「停止」或再按一次 '), stopKbd, t('，在会议详情里生成纪要，待办和 DDL 会按项目归好。所有快捷键都能在「快捷键」里改。')],
    [t('共享屏幕、录屏时，对方看不到字幕和答题框。')],
  ]
  const build = buildKind(init)
  const download = build.rosetta
    ? P.callout(
        'warn',
        'info',
        t('这是 Intel 芯片版，在 Apple 芯片的 Mac 上要靠 Rosetta 转译运行'),
        t('去官网换成 Apple 芯片版，会更省电、更快。会议记录和设置都不用动，装好直接覆盖。'),
        el('button.btn.btn-sm', { type: 'button', onClick: () => api.openExternal(SITE_URL) }, icon('external-link', 13), el('span', { text: t('下载 Apple 芯片版') })),
      )
    : null
  return [
    el(
      'div.about-hero',
      {},
      el('img.about-icon', { src: '../../assets/icon.png', alt: '' }),
      el('div', {}, el('div.title-xl', { text: t('会议字幕') }), el('div.text-2', { text: build.label ? t('版本 {0}（{1}）', init.version || '', build.label) : t(`版本 {0}`, init.version || '') }), el('div.text-3.text-sm', { text: t('实时字幕、AI 答题和会后纪要') })),
    ),
    download,
    P.section(
      t('数据'),
      null,
      P.row(t('会议和项目'), [pathBox(() => P.get('saveDir') || sessionsDir), el('div.form-inline', {}, el('button.btn.btn-sm', { type: 'button', onClick: () => api.openFolder(null) }, icon('external-link', 13), el('span', { text: t('打开') })))], t('都是普通文件夹和 Markdown，Word、记事本都能打开。')),
      P.row(t('声纹和登录'), el('span.text-2.plain-line', { text: t('只存在这台电脑上，不会上传。') })),
    ),
    P.section(
      t('使用说明'),
      null,
      el('ol.howto', {}, ...steps.map((parts) => el('li', {}, ...parts))),
      el('div.form-inline.howto-actions', {}, el('button.btn', { type: 'button', onClick: () => api.openGuide() }, icon('play', 14), el('span', { text: t('看主窗口导览') }))),
    ),
  ]
}

function buildAboutUs() {
  const value = (text) => el('div.path.mono.selectable', { text })
  return [
    P.section(
      t('官网'),
      null,
      P.row(
        t('软件官网'),
        [value(APPS_URL), el('div.form-inline', {}, el('button.btn.btn-sm', { type: 'button', onClick: () => api.openExternal(APPS_URL) }, icon('external-link', 13), el('span', { text: t('打开') })))],
        t('这个网站列着我们做的所有软件。'),
      ),
    ),
    P.section(
      t('联系方式'),
      null,
      P.row(
        t('邮箱'),
        [
          value(CONTACT_EMAIL),
          el(
            'div.form-inline',
            {},
            el('button.btn.btn-sm', { type: 'button', onClick: () => api.openExternal(`mailto:${CONTACT_EMAIL}`) }, icon('mail', 13), el('span', { text: t('发邮件') })),
            el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => P.copyText(CONTACT_EMAIL, t('邮箱已复制')) }, icon('copy', 13), el('span', { text: t('复制') })),
          ),
        ],
        t('用得不顺手、想要什么功能，都可以写信告诉我们。'),
      ),
    ),
  ]
}

/* ---------------- 分区切换 ---------------- */

const SECTIONS = [
  { id: 'general', label: t('通用'), icon: 'settings', tint: 'gray', build: buildGeneral },
  { id: 'member', label: t('会员'), icon: 'star', tint: 'yellow', build: buildMember },
  { id: 'ai', label: t('账号与 AI'), icon: 'sparkles', tint: 'indigo', build: buildAi, warn: () => onboarding.ai === false },
  { id: 'asr', label: t('语音识别'), icon: 'audio-lines', tint: 'blue', build: buildAsr, warn: () => onboarding.asr === false },
  { id: 'voiceprint', label: t('声纹'), icon: 'fingerprint-pattern', tint: 'purple', build: buildVoiceprint, warn: () => onboarding.voiceprint === false && P.get('captureMic') },
  { id: 'assist', label: t('AI 答题'), icon: 'message-square-text', tint: 'green', build: buildAssist },
  { id: 'overlay', label: t('字幕与答题框'), icon: 'captions', tint: 'orange', build: buildOverlay },
  { id: 'class', label: t('课堂'), icon: 'graduation-cap', tint: 'pink', build: buildClass },
  { id: 'hotkeys', label: t('快捷键'), icon: 'keyboard', tint: 'teal', build: buildHotkeys },
  { id: 'mic', label: t('麦克风'), icon: 'mic', tint: 'red', build: buildMic },
  { id: 'permissions', label: t('权限'), icon: 'shield-check', tint: 'yellow', build: buildPermissions, warn: () => ['microphone', 'screen'].some((k) => perms[k] && perms[k] !== 'granted') },
  { id: 'aboutUs', label: t('关于我们'), icon: 'users', tint: 'blue', build: buildAboutUs },
  { id: 'about', label: t('关于'), icon: 'info', tint: 'gray', build: buildAbout },
]
const pages = new Map()
const navItems = new Map()

function renderNavWarn() {
  for (const s of SECTIONS) {
    const item = navItems.get(s.id)
    const dot = item?.querySelector('.dot')
    if (dot) dot.hidden = !(s.warn && s.warn())
  }
}

function sectionId(name) {
  const n = String(name || '').trim()
  const id = ALIAS[n] ?? n
  return SECTIONS.some((s) => s.id === id) ? id : null
}

function go(name, { focusNav = false } = {}) {
  const id = sectionId(name) ?? 'general'
  const def = SECTIONS.find((s) => s.id === id)
  if (!pages.has(id)) {
    const page = el('div.page', { role: 'tabpanel', 'aria-label': def.label }, el('div.form', {}, def.build()))
    pages.set(id, page)
    document.getElementById('body').append(page)
  }
  for (const [pid, page] of pages) page.hidden = pid !== id
  for (const [nid, item] of navItems) {
    item.classList.toggle('is-active', nid === id)
    item.setAttribute('aria-selected', nid === id ? 'true' : 'false')
    item.tabIndex = nid === id ? 0 : -1
  }
  document.getElementById('title').textContent = def.label
  if (current !== id) document.getElementById('body').scrollTop = 0
  current = id
  P.localSet(LAST, id)
  if (focusNav) navItems.get(id)?.focus()
  if (id === 'mic') refreshMics()
  if (id === 'permissions') refreshPerms()
  if (id === 'ai') refreshModels()
  // 会员页：跟服务器对一次场次（主进程 60 秒内问过、或用的是自带 Key 就不问）
  if (id === 'member') P.call('memberRefresh')
  if (id === 'assist') {
    refreshLlm()
    refreshScreen()
  }
}

function buildNav() {
  const nav = document.getElementById('nav')
  for (const s of SECTIONS) {
    const item = el(
      'button.nav-item',
      { type: 'button', role: 'tab', dataset: { id: s.id }, onClick: () => go(s.id) },
      ui.iconBox(s.icon, s.tint, { size: 'sm' }),
      el('span.nav-label', { text: s.label }),
      el('span.dot.dot-warn', { hidden: true, title: t('还没设置好') }),
    )
    navItems.set(s.id, item)
    nav.append(item)
  }
  nav.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const i = SECTIONS.findIndex((s) => s.id === current)
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? SECTIONS.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
    go(SECTIONS[n].id, { focusNav: true })
  })
}

/* ---------------- 状态刷新 ---------------- */

async function refreshLlm() {
  const r = await P.call('llmStatus')
  llm = r && r.ok !== false ? r : null
  aiWarnRender()
}

async function refreshScreen() {
  if (!ui.isMac) return
  const r = await P.call('screenPermission')
  screenPerm = typeof r === 'string' ? r : null
  if (screenWarnNode) screenWarnNode.hidden = !(P.get('assist.withScreen') && screenPerm && screenPerm !== 'granted')
}

let savedTimer = 0
function showSaved() {
  const s = document.getElementById('saved')
  s.replaceChildren(icon('check', 13), el('span', { text: t('已保存') }))
  s.hidden = false
  s.classList.remove('is-leaving')
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => s.classList.add('is-leaving'), 1400)
}

async function boot() {
  init = await api.init()
  ui.applyChrome(init.chrome)
  sessionsDir = init.sessionsDir || ''
  onboarding = init.onboarding || {}
  llm = init.llm || null
  screenPerm = init.screenPermission ?? null
  perms = init.permissions ?? {}
  overlayState = init.overlay || overlayState
  memberSnap = init.member ?? null
  P.boot(init)
  buildNav()
  const q = new URLSearchParams(location.search).get('section')
  go(sectionId(q) ?? sectionId(P.localGet(LAST)) ?? 'general')
  renderNavWarn()

  P.onSaved(async (patch) => {
    showSaved()
    if ('saveDir' in patch) {
      // 换了根目录：重新取一次实际的路径（选的目录建不了时主进程会退回默认位置）
      const again = await P.call('init')
      if (again?.sessionsDir) sessionsDir = again.sessionsDir
      P.refresh()
    }
    if (['llmProvider', 'openaiKey', 'llmKey', 'llmKeys', 'llmBaseUrl'].some((k) => k in patch)) {
      refreshLlm()
      refreshModels()
    }
  })
  P.onChatgpt(() => refreshLlm())
  P.onVoiceprint(renderNavWarn)
  P.watch(renderNavWarn)
  P.on('onboarding:changed', (st) => {
    onboarding = st || {}
    renderNavWarn()
  })
  P.on('settings:section', (sec) => go(sec))
  P.on('member:update', (snap) => {
    memberSnap = snap
    renderMember()
  })
  P.on('overlay:state', (st) => {
    overlayState = st || overlayState
    renderEditBtn()
  })
  window.addEventListener('focus', () => {
    if (current === 'assist') refreshScreen()
    if (current === 'mic') refreshMics()
    if (current === 'permissions') refreshPerms()
    if (current === 'member') P.call('memberRefresh')
  })
}

boot()
