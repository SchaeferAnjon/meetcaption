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
  const reset = el('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: () => P.set('saveDir', '', 0) }, '恢复默认')
  P.watch((s) => (reset.hidden = !s.saveDir))
  P.watch((s) => document.documentElement.style.setProperty('--sidebar-opacity', String(s.sidebarOpacity ?? 0.85)))
  return [
    P.section(
      '启动和外观',
      null,
      P.row('开机启动', toggleLine('launchAtLogin', '登录电脑后自动打开'), '在后台运行，托盘里点一下就能开始会议。'),
      P.row(
        '外观',
        P.segField(
          'theme',
          [
            { value: 'system', label: '跟随系统', icon: 'monitor' },
            { value: 'dark', label: '深色', icon: 'moon' },
            { value: 'light', label: '浅色', icon: 'sun' },
          ],
          { label: '外观' },
        ),
      ),
      ui.isMac || document.documentElement.classList.contains('is-win')
        ? P.row('侧栏不透明度', P.slider('sidebarOpacity', { min: 0.3, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, label: '侧栏不透明度' }), '左边侧栏透出桌面的程度：越高越实，字越清楚。字幕的背景在「字幕与答题框」的「背景深浅」里调。')
        : null,
    ),
    P.section(
      '会议文件',
      null,
      P.row(
        '保存位置',
        [
          pathBox(() => P.get('saveDir') || sessionsDir),
          el(
            'div.form-inline',
            {},
            el('button.btn.btn-sm', { type: 'button', onClick: pickDir }, icon('folder', 14), el('span', { text: '更改…' })),
            el('button.btn.btn-sm', { type: 'button', onClick: () => api.openFolder(null) }, icon('external-link', 13), el('span', { text: ui.isMac ? '在访达中显示' : '打开文件夹' })),
            reset,
          ),
        ],
        '每个项目一个文件夹，会议记录和纪要都在里面。换位置不会搬走已有的会议，想一起带走就把整个文件夹拷过去再选它。',
      ),
    ),
    P.section('隐私', null, P.row('屏幕共享', toggleLine('hideFromScreenShare', '共享屏幕时隐藏字幕和答题框'), '对方看你的共享屏幕、录屏或截图时都看不到这两个窗口，只有你自己看得见。')),
    P.section(
      '首次引导',
      null,
      P.row('', el('button.btn', { type: 'button', onClick: () => api.openOnboarding() }, icon('play', 14), el('span', { text: '重新打开首次引导' })), '录声纹、连接 AI、语音识别、建项目和声音测试，一步步再走一遍。'),
    ),
  ]
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
    `正在用会员的${what}`,
    `会员模式下${what}由 MeetCaption 提供，不用填 Key。下面的设置在换成「自带 Key」后才用。`,
    el('button.btn.btn-sm', { type: 'button', onClick: () => go('member') }, '会员设置'),
  )
  P.showWhen(note, (s) => s.plan === 'member')
  return note
}

function buildAi() {
  const test = P.testButton('测试 AI 服务', () => P.call('testLlm', {}), (r) => `可以用，${((r.ms ?? 0) / 1000).toFixed(1)} 秒：${r.sample ?? ''}`)
  const testRow = P.row('', test)
  P.showWhen(testRow, (s) => s.llmProvider !== 'chatgpt')
  return [
    memberNote('AI'),
    P.section('AI 服务', '翻译、术语解释、会后纪要和 AI 答题都用它。每家的 Key 分开存，换来换去不会丢。', P.providerPicker({ recommend: null }), ...P.providerSetup(), testRow),
    P.section(
      '模型',
      '一般不用改。换服务时自动换成那家的推荐模型；想换别的，点输入框右边的箭头从那家的模型里选，也可以直接填模型名。翻译和答题会关掉模型的思考，纪要照常思考。',
      P.row('', modelsLine),
      P.row('翻译和术语', modelField('llmFastModel', { label: '翻译和术语模型' }), '要快，每句话都会用一次。'),
      P.row('会后纪要', modelField('llmSummaryModel', { label: '纪要模型' }), '要准，一场会用一次。'),
      P.row('AI 答题', modelField('llmAnswerModel', { placeholder: '留空自动选', label: '答题模型' }), '留空时 ChatGPT 账号用 gpt-5.6-terra，其他服务跟翻译模型一样。'),
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
  models = r?.ok ? { list: r.models ?? [], error: '', busy: false, label: r.label ?? '' } : { list: [], error: r?.error || '没拉到', busy: false, label: '' }
  renderModelsLine()
}

function renderModelsLine() {
  modelsLine.textContent = models.busy
    ? '正在拉取模型列表…'
    : models.error
      ? `没拉到模型列表：${models.error}。可以直接填模型名。`
      : models.list.length
        ? `从 ${models.label} 拉到 ${models.list.length} 个模型。`
        : ''
  modelsLine.hidden = !modelsLine.textContent
}

function modelField(key, opts) {
  const input = P.textInput(key, { short: true, trim: true, ...opts })
  const pick = el('button.btn.btn-icon.model-pick', { type: 'button', 'aria-label': `从列表选${opts.label}` }, icon('chevron-down', 14))
  ui.tip(pick, '从列表选', { delay: 400 })
  pick.addEventListener('click', async () => {
    if (!models.list.length) await refreshModels()
    if (!models.list.length) return
    ui.menu(
      pick,
      models.list.map((id) => ({ label: id, checked: P.get(key) === id, onSelect: () => P.set(key, id, 0) })),
      { align: 'end', searchable: models.list.length > 8, placeholder: '搜索模型' },
    )
  })
  return el('div.form-inline.model-field', {}, input, pick)
}

function buildAsr() {
  const engineHint = el('div.form-hint')
  P.watch((s) => {
    engineHint.textContent =
      s.engine === 'local'
        ? '在这台电脑上识别，免费，不用联网，也不用填 Key。中文、英文和中英夹杂都能认，说完一个词约半秒出字。专有名词偶尔听错，AI 纠错会按项目术语改回来。'
        : s.engine === 'volc'
          ? '豆包流式语音识别（火山引擎），国内网络可以直连，要自己开通、按小时付费。'
          : 'OpenAI 实时转写，要 API Key，约 1 美元一小时，只在有人说话时计费。'
  })
  const openaiRows = el(
    'div',
    {},
    P.row('OpenAI API Key', P.textInput('openaiKey', { secret: true, trim: true, placeholder: 'sk-…', label: 'OpenAI API Key' }), '和「账号与 AI」里是同一个 Key。'),
    P.row(
      '出字速度',
      P.selectField(
        'openaiDelay',
        [
          { value: 'minimal', label: '最快', description: '可能多错几个词' },
          { value: 'low', label: '快（推荐）' },
          { value: 'medium', label: '平衡' },
          { value: 'high', label: '更准', description: '慢半拍' },
        ],
        { width: 200, label: '出字速度' },
      ),
    ),
  )
  const volcRows = el(
    'div',
    {},
    P.row('App ID', P.textInput('volcAppId', { trim: true, mono: true, label: 'App ID' })),
    P.row('Access Token', P.textInput('volcAccessToken', { secret: true, trim: true, label: 'Access Token' })),
    P.row('资源 ID', P.textInput('volcResourceId', { trim: true, mono: true, label: '资源 ID' }), '在火山引擎控制台开通「豆包流式语音识别大模型」，在旧版控制台拿 App ID 和 Access Token。默认用 2.0（volc.seedasr.sauc.duration，更准，说完一句会再整句识别一遍）；只开通了 1.0 就填 volc.bigasr.sauc.duration。'),
  )
  const advanced = P.section(
    '高级',
    null,
    P.row('API 地址', P.textInput('openaiBaseUrl', { trim: true, mono: true, label: 'API 地址' })),
    P.row('识别模型', P.textInput('openaiModel', { trim: true, mono: true, label: '识别模型' })),
  )
  P.showWhen(openaiRows, (s) => s.engine === 'openai')
  P.showWhen(volcRows, (s) => s.engine === 'volc')
  P.showWhen(advanced, (s) => s.engine === 'openai')
  const test = P.testButton('测试', () => P.call('testAsr', {}), () => (P.get('engine') === 'local' ? '本地识别可以用了' : '连接成功，可以开始用了'))
  return [
    memberNote('识别'),
    P.section(
      '识别服务',
      '把对方和你说的话实时转成文字。对方说的语言在每个项目的「资料」里设置。',
      P.row(
        '服务',
        [
          P.segField(
            'engine',
            [
              { value: 'local', label: '本地（免费）' },
              { value: 'volc', label: '豆包' },
              { value: 'openai', label: 'OpenAI' },
            ],
            { label: '识别服务' },
          ),
          engineHint,
        ],
      ),
      openaiRows,
      volcRows,
      P.row('', test),
    ),
    advanced,
  ]
}

function buildVoiceprint() {
  const micOff = P.callout('warn', 'mic-off', '麦克风没打开', '「麦克风」里没打开「同时记录我说的话」，开会时用不上声纹。', el('button.btn.btn-sm', { type: 'button', onClick: () => go('mic') }, '去打开'))
  P.showWhen(micOff, (s) => !s.captureMic)
  return [
    P.section('我的声纹', '录 12 秒你的声音，软件就能分清哪句是你说的、哪句是对方说的。开外放时串进麦克风的对方声音也能滤掉。声纹只存在这台电脑上。', micOff, P.voiceprintRecorder()),
    P.section(
      '高级',
      null,
      P.row(
        '判定阈值',
        P.slider('voiceprint.threshold', { min: 0.3, max: 0.8, step: 0.05, format: (v) => Number(v).toFixed(2), label: '判定阈值' }),
        '和声纹的相似度高于这个值才算你说的。调高：别人的话更不容易被当成你的；调低：你说得很短或嗓子哑时也能认出来。默认 0.50。',
      ),
    ),
  ]
}

function buildAssist() {
  const aiWarn = el('div.top-callout')
  const renderAiWarn = () => {
    const bad = llm && llm.ready === false
    aiWarn.hidden = !bad
    if (bad) aiWarn.replaceChildren(P.callout('warn', 'triangle-alert', 'AI 服务还没准备好', llm.reason || '先在「账号与 AI」里登录或填 Key。', el('button.btn.btn-sm', { type: 'button', onClick: () => go('ai') }, '去设置')))
  }
  aiWarnRender = renderAiWarn
  renderAiWarn()

  const screenWarn = P.callout(
    'warn',
    'monitor',
    '还没有屏幕录制权限',
    '去「系统设置 → 隐私与安全性 → 录屏与系统录音」打开「会议字幕」，重启应用后生效。没开也能回答，只是不带截图。',
    el('button.btn.btn-sm', { type: 'button', onClick: () => api.openPrivacy('screen') }, '打开系统设置'),
  )
  screenWarn.hidden = true
  screenWarnNode = screenWarn

  const askKbd = el('span.kbd-slot')
  P.watch((s) => askKbd.replaceChildren(s.assist?.hotkeyAsk ? ui.kbd(s.assist.hotkeyAsk) : el('span.text-3', { text: '未设置' })))

  const dep = el(
    'div',
    {},
    P.row('自动回答', toggleLine('assist.auto', '对方问完就自动回答'), '关掉后，只在按快捷键时回答。'),
    P.row('屏幕截图', [toggleLine('assist.withScreen', '回答时附上当前屏幕截图'), screenWarn], '讲 PPT 或共享屏幕时对方问「这一块怎么做的」，AI 能看到你屏幕上的内容。截图只发给 AI 服务，不保存。'),
    P.row(
      '回答语言',
      P.segField(
        'assist.answerLang',
        [
          { value: 'auto', label: '跟提问一样' },
          { value: 'en', label: '英文' },
          { value: 'zh', label: '中文' },
        ],
        { label: '回答语言' },
      ),
      '最前面一行中文要点总是有的。',
    ),
    P.row('快捷键', el('div.form-inline', {}, askKbd, el('span.text-2', { text: '让 AI 回答刚才的问题' }), linkButton('修改', () => go('hotkeys')))),
  )
  P.enableWhen(dep, (s) => s.assist?.enabled)
  P.watch((s) => {
    if (screenWarnNode) screenWarnNode.hidden = !(ui.isMac && s.assist?.withScreen && screenPerm && screenPerm !== 'granted')
  })

  return [
    aiWarn,
    P.section(
      'AI 答题',
      '对方提问后，屏幕右侧的答题框马上给出你可以照着说的回答：先一行中文要点，再两到四句口语。答题框和字幕一样，共享屏幕时对方看不到。',
      P.row('AI 答题', toggleLine('assist.enabled', '开启 AI 答题')),
      dep,
    ),
    P.section(
      '我的资料',
      null,
      P.callout(
        'accent',
        'file-text',
        '「我的资料」放在项目里',
        '简历要点、项目介绍、常被问的问题，现在按项目分开放，答题时用当前项目的资料。在主窗口打开项目，切到「资料」填写。',
        el('button.btn.btn-sm', { type: 'button', onClick: () => api.showMain() }, '打开主窗口'),
      ),
    ),
  ]
}
function buildOverlay() {
  const editBtn = el('button.btn', { type: 'button' })
  const renderEdit = () => {
    editBtn.replaceChildren(icon(overlayState.editMode ? 'check' : 'pencil', 14), el('span', { text: overlayState.editMode ? '调整好了' : '调整位置' }))
    editBtn.classList.toggle('btn-primary', Boolean(overlayState.editMode))
  }
  editBtn.addEventListener('click', () => api.editOverlay(!overlayState.editMode))
  renderEditBtn = renderEdit
  renderEdit()

  const resetColors = el('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: () => (P.set('overlay.textColor', '#ffffff', 0), P.set('overlay.translationColor', '#ffd666', 0)) }, '恢复默认')
  P.watch((s) => (resetColors.hidden = (s.overlay?.textColor || '').toLowerCase() === '#ffffff' && (s.overlay?.translationColor || '').toLowerCase() === '#ffd666'))

  const target = P.selectField('translateTarget', LANGS, { label: '翻译成', width: 140 })
  const targetWrap = el('span.form-inline', {}, el('span.text-2', { text: '翻成' }), target)
  P.enableWhen(targetWrap, (s) => s.translate)
  const trRow = P.row('译文', toggleLine('overlay.showTranslation', '在字幕里显示'), '关掉后译文只在主窗口的实时记录里显示。')
  P.enableWhen(trRow.querySelector('.form-control'), (s) => s.translate)

  // 意群颜色的两种样子：并排两张小预览，点哪张就用哪种
  const styleCards = el('div.chunk-styles', { role: 'radiogroup', 'aria-label': '意群颜色的样式' })
  for (const [value, label, desc] of [
    ['text', '文字着色', '英文片段和对应的中文直接上同一种颜色'],
    ['bar', '底部色条', '文字颜色不变，下面一条同色细线'],
  ]) {
    const card = el(
      'button.chunk-style',
      { type: 'button', role: 'radio', dataset: { value } },
      P.captionPreview({ style: value, scale: 0.5, tip: false, compact: true }),
      el('span.chunk-style-label', {}, el('span.choice-radio'), el('span', { text: label }), value === window.bilingual?.DEFAULT_STYLE ? el('span.tag.tag-accent', { text: '默认' }) : null),
      el('span.chunk-style-desc', { text: desc }),
    )
    card.addEventListener('click', () => P.set('display.chunkStyle', value, 0))
    styleCards.append(card)
  }
  P.watch((s) => {
    const cur = window.bilingual?.prefs(s).style
    for (const c of styleCards.children) c.setAttribute('aria-checked', String(c.dataset.value === cur))
  })
  const styleRow = P.row('样式', styleCards)
  P.enableWhen(styleRow.querySelector('.form-control'), (s) => s.display?.chunkColors !== false)

  return [
    P.section(null, null, P.captionPreview()),
    P.section(
      '双语对照',
      '每句英文下面紧跟它的中文，一句一对。按意群（主干、从句、介词短语）分色，英文片段和它的中文用同一种颜色；难词在两边都画虚线，悬停任一边都能看解释。字幕窗、主窗口的实时记录和字幕记录都一样。',
      P.row('意群颜色对照', toggleLine('display.chunkColors', '按意群给中英文上同样的颜色'), '关掉就是单色，翻译时也不再让 AI 额外做意群对齐。'),
      styleRow,
    ),
    P.section(
      '字幕',
      null,
      P.row('字号', P.slider('overlay.fontSize', { min: 14, max: 48, step: 1, label: '字号' })),
      P.row('显示行数', P.slider('overlay.lines', { min: 1, max: 8, step: 1, label: '显示行数' })),
      P.row('背景深浅', P.slider('overlay.bgOpacity', { min: 0, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, label: '背景深浅' })),
      P.row('颜色', el('div.form-inline', {}, el('span.text-2', { text: '原文' }), P.colorField('overlay.textColor', '原文颜色'), el('span.text-2.gap-l', { text: '译文' }), P.colorField('overlay.translationColor', '译文颜色'), resetColors)),
      P.row('我说的话', toggleLine('overlay.showMic', '字幕里也显示我说的话'), '一般不用开，自己说了什么自己知道；录音和纪要里都有。'),
    ),
    P.section(
      '翻译和术语',
      '都用「账号与 AI」里的服务，每说完一句翻一句，一般比原文晚 2 到 5 秒出现。对方提问时先出答案，这句的译文再晚一两秒。',
      P.row('翻译', el('div.form-inline', {}, toggleLine('translate', '翻译对方说的话'), targetWrap)),
      trRow,
      P.row('术语解释', toggleLine('terms.enabled', '专业词加虚线，悬停看解释'), '鼠标停在字幕里的专业词上，弹出一句中文解释。主窗口的实时记录里也一样。'),
      P.row('纠错', toggleLine('terms.correct', 'AI 纠正识别错误'), '翻译时顺带改掉听错的词（近音误听、人名、术语拼写），改过的词下面有很淡的点线，悬停能看识别原文，存档里也留着识别原文。'),
    ),
    P.section(
      '位置',
      null,
      P.row(
        '字幕和答题框',
        el('div.form-inline', {}, editBtn, el('button.btn.btn-ghost', { type: 'button', onClick: () => api.resetOverlayPosition() }, icon('refresh-cw', 13), el('span', { text: '恢复默认位置' }))),
        '点「调整位置」后两个窗口会出现在屏幕上：拖动移动，拖边缘改大小，改好点「完成」。',
      ),
    ),
  ]
}
function buildHotkeys() {
  const askHint = el('div.form-hint')
  P.watch((s) => {
    askHint.textContent = s.assist?.enabled ? '对方的问题没被自动认出来，或者想换个说法时按一下。' : 'AI 答题关着，这个快捷键暂时不生效。'
  })
  const appKey = (name, label, def, hint) => P.row(label, P.hotkeyRecorder(`keys.${name}`, { def, label }), hint)
  return [
    P.section(
      '全局快捷键',
      '在任何程序里都能用，包括会议软件全屏时。点一下快捷键，再按新的组合；按 Delete 不用这个快捷键。',
      P.row('显示 / 隐藏', P.hotkeyRecorder('hotkeyToggle', { def: 'CommandOrControl+Alt+S', label: '显示 / 隐藏字幕' }), '字幕窗和答题框一起显示或隐藏。'),
      P.row('开始 / 停止记录', P.hotkeyRecorder('hotkeyRecord', { def: 'CommandOrControl+Alt+R', label: '开始 / 停止记录' }), '不用切回主窗口：没在记录就在当前项目里开始，正在记录就停止。'),
      P.row('回答刚才的问题', P.hotkeyRecorder('assist.hotkeyAsk', { def: 'CommandOrControl+Alt+A', label: '回答刚才的问题' }), askHint),
      P.row('截取画面', P.hotkeyRecorder('class.hotkeySlide', { def: 'CommandOrControl+Alt+P', label: '截取画面' }), '上课记录时把当前屏幕（网课课件）存进这节课，只在上课时生效。'),
    ),
    P.section(
      '主窗口里',
      '会议字幕的主窗口在最前面时才有效，改法同上。',
      appKey('palette', '命令面板', 'CommandOrControl+K', '搜项目、会议和待办，切换项目，执行命令。'),
      appKey('settings', '打开设置', 'CommandOrControl+,'),
      appKey('start', '开始记录', 'CommandOrControl+Shift+R', '在当前项目里开始；已经在记录就回到记录页。'),
      appKey('live', '回到正在进行的记录', 'CommandOrControl+0'),
      appKey('newProject', '新建项目', 'CommandOrControl+N'),
      appKey('home', '首页', 'CommandOrControl+1'),
      appKey('todos', '待办', 'CommandOrControl+2'),
      appKey('back', '返回上一页', 'CommandOrControl+['),
      appKey('sidebar', '收起 / 展开侧栏', 'CommandOrControl+\\'),
    ),
  ]
}

function buildClass() {
  const pick = el('button.btn.btn-sm', { type: 'button', onClick: pickExportDir }, icon('folder', 14), el('span', { text: '选择文件夹…' }))
  const clear = el('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: () => P.set('class.exportDir', '', 0) }, '清除')
  const dirBox = el('div.path.mono.selectable')
  P.watch((s) => {
    const d = s.class?.exportDir || ''
    dirBox.textContent = d || '还没选。导出时会让你选一个文件夹，之后默认打开上次选的。'
    dirBox.classList.toggle('is-empty', !d)
    clear.hidden = !d
  })
  return [
    P.section(
      '课堂模式',
      '上课时在开始按钮的下拉里选「课堂」：边听边出双语字幕，AI 每隔几分钟把新内容整理进实时笔记，下课生成课堂笔记（大纲、公式、老师强调的考点、作业、术语表和自测题）。作业会进这门课所在项目的待办。',
      P.row(
        '默认声音来源',
        P.segField(
          'class.source',
          [
            { value: 'mic', label: '教室现场（麦克风）', icon: 'mic' },
            { value: 'system', label: '网课（电脑声音）', icon: 'monitor' },
          ],
          { label: '默认声音来源' },
        ),
        '老师在教室里讲就用麦克风听；看网课就听电脑里的声音。每个项目可以在「资料」里单独设，开始前在下拉里也能临时换。',
      ),
      P.row(
        '实时笔记',
        P.segField(
          'class.notesEveryMin',
          [
            { value: 1, label: '1 分钟' },
            { value: 2, label: '2 分钟' },
            { value: 5, label: '5 分钟' },
          ],
          { label: '实时笔记更新频率' },
        ),
        '每攒够这么久的新内容整理一次笔记（讲得快时攒够 400 个英文词也会整理）。越频繁越跟得上，用的 AI 额度也越多。',
      ),
    ),
    P.section(
      '截取画面',
      null,
      P.row('快捷键', P.hotkeyRecorder('class.hotkeySlide', { def: 'CommandOrControl+Alt+P', label: '截取画面' }), '上课记录时按一下，把当前屏幕（网课的课件）存进这节课的文件夹。实时记录里会出现缩略图，课堂笔记会在对应的位置引用它。主窗口里也有「截取画面」按钮。'),
    ),
    P.section('导出', null, P.row('笔记库文件夹', [dirBox, el('div.form-inline', {}, pick, clear)], '在课堂记录里点「导出到笔记库」，选文件夹时默认打开这里；课堂笔记.md 和用到的截图会拷过去，文件名带日期和标题。比如选 Obsidian 库里的课程目录。')),
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
  const options = [{ value: '', label: '系统默认' }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `麦克风 ${i + 1}` }))]
  if (cur && !options.some((o) => o.value === cur)) options.push({ value: cur, label: '之前选的麦克风（现在没接）' })
  micSelect.setOptions(options, cur)
}

/* ---------------- 权限 ---------------- */

const PERM_TAG = {
  granted: ['tag-ok', '已允许'],
  denied: ['tag-warn', '被拒绝了'],
  restricted: ['tag-warn', '被系统限制'],
  'not-determined': ['tag-warn', '还没允许'],
}

// 一行权限：状态标签 + 按钮。没问过点「允许」弹系统框；被拒过只能去系统设置里打开
function permRow(label, kind, hint, { extra = null, renderExtra } = {}) {
  const tag = el('span.tag')
  const allow = el('button.btn.btn-sm', { type: 'button' }, '允许')
  const open = el('button.btn.btn-sm', { type: 'button', onClick: () => api.openPrivacy(kind) }, icon('external-link', 13), el('span', { text: '打开系统设置' }))
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
  const mic = permRow('麦克风', 'microphone', '录你自己说的话、录声纹；教室现场上课时用它听老师讲课。')
  const rows = [mic]
  const extra = []
  if (ui.isMac) {
    // 屏幕录制在这次打开设置以后才给的，要重启才生效：这时才出「重启」
    const wasOff = perms.screen !== 'granted'
    const restart = el('button.btn.btn-sm', { type: 'button', onClick: () => P.call('relaunch') }, icon('refresh-cw', 13), el('span', { text: '重启生效' }))
    const screen = permRow('屏幕录制', 'screen', 'AI 答题时带上屏幕截图、课堂上截取画面。在系统设置里打开以后，要重启会议字幕才生效。', { extra: restart, renderExtra: (st) => (restart.hidden = !(wasOff && st === 'granted')) })
    rows.push(screen)
    extra.push(
      P.row(
        '系统录音',
        el(
          'div.form-inline',
          {},
          el('span.tag', { text: '用到时检查' }),
          el('button.btn.btn-sm', { type: 'button', onClick: () => P.call('requestPermission', 'systemAudio') }, '允许'),
          el('button.btn.btn-sm', { type: 'button', onClick: () => api.openPrivacy('screen') }, icon('external-link', 13), el('span', { text: '打开系统设置' })),
        ),
        '抓会议软件里对方的声音。macOS 没有办法查它给没给：点「允许」时系统会弹框；以前点过不允许，就在「录屏与系统录音」里打开「会议字幕」。',
      ),
    )
  }
  renderPerms = () => {
    for (const r of rows) r.render()
    renderNavWarn()
  }
  renderPerms()
  return [
    P.section('系统权限', ui.isMac ? '会议字幕要用的系统权限都在这里，没给的点「允许」，以前拒绝过的点「打开系统设置」。' : 'Windows 上电脑声音和屏幕截图不用单独授权，只有麦克风要。', ...rows.map((r) => r.node), ...extra),
  ]
}

async function refreshPerms() {
  const r = await P.call('permissionStatus')
  if (r && !r.missing) perms = r
  renderPerms()
}

function buildMic() {
  micSelect = P.selectField('micDeviceId', [{ value: '', label: '系统默认' }], { width: 280, label: '麦克风' })
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics)
  const vpHint = P.callout('accent', 'fingerprint-pattern', '还没录声纹', '录 12 秒，就能分清你和对方，外放时串进来的声音也能滤掉。', el('button.btn.btn-sm.btn-primary', { type: 'button', onClick: () => go('voiceprint') }, '去录声纹'))
  const renderVpHint = () => (vpHint.hidden = !(P.get('captureMic') && P.voiceprint() && !P.voiceprint().enrolled && !P.voiceprint().unsupported))
  P.watch(renderVpHint)
  P.onVoiceprint(renderVpHint)
  const dep = P.row('麦克风', micSelect, '换了耳机或外接麦克风后在这里选。')
  P.enableWhen(dep, (s) => s.captureMic)
  return [
    P.section(
      '麦克风',
      '开会时同时记录你自己说的话，会后纪要更完整。',
      P.row('我说的话', toggleLine('captureMic', '开会时同时记录我说的话'), '识别费用大约翻倍。外放时麦克风会串进对方的声音，录好声纹后会自动滤掉；戴耳机效果最好。'),
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
  const codeInput = el('input.input.mono', { type: 'text', placeholder: 'MC-XXXX-XXXX-XXXX', spellcheck: 'false', autocomplete: 'off', 'aria-label': '授权码' })
  const codeOut = el('div.test-line', { role: 'status' })
  const activate = el('button.btn', { type: 'button' }, el('span', { text: '激活' }))
  activate.addEventListener('click', async () => {
    const code = codeInput.value.trim()
    if (!code) return codeInput.focus()
    activate.classList.add('is-loading')
    const r = await P.call('memberActivate', code)
    activate.classList.remove('is-loading')
    codeOut.dataset.state = r?.ok ? 'ok' : 'err'
    codeOut.replaceChildren(icon(r?.ok ? 'circle-check' : 'circle-alert', 14), el('span', { text: r?.ok ? `已激活，剩 ${r.info?.balance ?? 0} 场` : r?.error || '没能激活' }))
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
      rows.push(el('div.form-hint', { text: memberSnap?.error ? `连不上会员服务器：${memberSnap.error}` : '正在连接会员服务器…' }))
    } else {
      const trial = info.kind !== 'paid'
      rows.push(
        el(
          'div.member-balance',
          {},
          el('b', { text: String(Math.max(0, info.balance)) }),
          el('span', { text: ` 场${trial ? '（免费试用）' : ''}，每场最长 2 小时` }),
        ),
      )
      if (info.code)
        rows.push(
          el(
            'div.member-code',
            {},
            el('span.form-hint', { text: '授权码' }),
            el('code.selectable', { text: info.code }),
            el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => navigator.clipboard.writeText(info.code).then(() => ui.toast({ title: '授权码已复制', type: 'success' })) }, icon('copy', 13), el('span', { text: '复制' })),
          ),
          el('div.form-hint', { text: `用在 ${info.devices ?? 1} 台电脑上，最多 2 台。` }),
        )
      const recent = (info.recent ?? []).filter((x) => x.ended_at || x.active_ms)
      if (recent.length)
        rows.push(
          el(
            'div.member-recent',
            {},
            recent.map((x) =>
              el('div', {
                text: `${new Date(x.started_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 用了 ${Math.round((x.active_ms ?? 0) / 60000)} 分钟 · ${x.refunded ? '不到 5 分钟，没扣' : `扣 ${x.charged} 场`}`,
              }),
            ),
          ),
        )
    }
    const actions = el(
      'div.form-inline',
      {},
      el('button.btn.btn-primary', { type: 'button', onClick: () => P.call('showPricing') }, el('span', { text: memberSnap?.buying ? '正在等付款…' : '购买场次' })),
      info && !info.trialOnly
        ? el(
            'button.btn.btn-ghost',
            {
              type: 'button',
              onClick: async () => {
                if (!(await ui.confirm({ title: '解绑这台电脑？', message: '这台电脑不再用这个授权码，退回它自己的试用场次。授权码在别的电脑上照常用，以后输码还能再绑回来。', okLabel: '解绑' }))) return
                await P.call('memberUnbind')
              },
            },
            el('span', { text: '解绑这台电脑' }),
          )
        : null,
    )
    box.replaceChildren(...rows, actions)
  }
  renderMember()

  const own = P.callout(null, 'key-round', '正在用自带 Key', '识别和 AI 用你在「账号与 AI」「语音识别」里配的服务，不经过我们，不扣场次。')
  P.showWhen(own, (s) => s.plan === 'own')
  const memberRows = [
    P.row('剩余场次', box),
    P.row('识别', P.segField('memberAsr', [
      { value: 'cloud', label: '云识别（豆包 2.0）', icon: 'audio-lines' },
      { value: 'local', label: '本地识别', icon: 'monitor' },
    ], { label: '会员用哪种识别' }), '云识别更准，专有名词少听错；本地识别在电脑上跑、断网也能用。两种都按场算，AI 照样能用。'),
  ]
  for (const r of memberRows) P.showWhen(r, (s) => s.plan === 'member')
  return [
    P.section(
      '用法',
      '会员不用填任何 Key，识别和 AI 都由我们提供，按场扣；自带 Key 永久免费，费用直接付给你选的服务商。',
      P.row('', P.segField('plan', [
        { value: 'member', label: '会员（免配置）', icon: 'sparkles' },
        { value: 'own', label: '自带 Key', icon: 'key-round' },
      ], { label: '用法' })),
      own,
      ...memberRows,
    ),
    P.section('授权码', '在别的电脑上买过，或者官网买的：输入授权码，这台电脑就用那里的场次。', P.row('', el('div.form-inline', {}, codeInput, activate), codeOut)),
  ]
}

function buildAbout() {
  const toggleKbd = el('span.kbd-slot')
  const askKbd = el('span.kbd-slot')
  const recordKbd = el('span.kbd-slot')
  const stopKbd = el('span.kbd-slot')
  const k = (v) => (v ? ui.kbd(v) : el('span.text-3', { text: '（快捷键没设）' }))
  P.watch((s) => {
    toggleKbd.replaceChildren(k(s.hotkeyToggle))
    askKbd.replaceChildren(k(s.assist?.hotkeyAsk))
    recordKbd.replaceChildren(k(s.hotkeyRecord))
    stopKbd.replaceChildren(k(s.hotkeyRecord))
  })
  const steps = [
    ['在主窗口选好项目，点「开始会议」，或者在会议软件里直接按 ', recordKbd, '。对方说话时屏幕下方就会出字幕，每句都会存档。'],
    ['按 ', toggleKbd, ' 随时隐藏或显示字幕和答题框；对方问了问题没自动回答时，按 ', askKbd, '。'],
    ['会议结束点「停止」或再按一次 ', stopKbd, '，在会议详情里生成纪要，待办和 DDL 会按项目归好。所有快捷键都能在「快捷键」里改。'],
    ['共享屏幕、录屏时，对方看不到字幕和答题框。'],
  ]
  return [
    el(
      'div.about-hero',
      {},
      el('img.about-icon', { src: '../../assets/icon.png', alt: '' }),
      el('div', {}, el('div.title-xl', { text: '会议字幕' }), el('div.text-2', { text: `版本 ${init.version || ''}` }), el('div.text-3.text-sm', { text: '实时字幕、AI 答题和会后纪要' })),
    ),
    P.section(
      '数据',
      null,
      P.row('会议和项目', [pathBox(() => P.get('saveDir') || sessionsDir), el('div.form-inline', {}, el('button.btn.btn-sm', { type: 'button', onClick: () => api.openFolder(null) }, icon('external-link', 13), el('span', { text: '打开' })))], '都是普通文件夹和 Markdown，Word、记事本都能打开。'),
      P.row('声纹和登录', el('span.text-2.plain-line', { text: '只存在这台电脑上，不会上传。' })),
    ),
    P.section(
      '使用说明',
      null,
      el('ol.howto', {}, ...steps.map((parts) => el('li', {}, ...parts))),
      el('div.form-inline.howto-actions', {}, el('button.btn', { type: 'button', onClick: () => api.openOnboarding() }, icon('play', 14), el('span', { text: '重新打开首次引导' }))),
    ),
  ]
}

/* ---------------- 分区切换 ---------------- */

const SECTIONS = [
  { id: 'general', label: '通用', icon: 'settings', tint: 'gray', build: buildGeneral },
  { id: 'member', label: '会员', icon: 'star', tint: 'yellow', build: buildMember },
  { id: 'ai', label: '账号与 AI', icon: 'sparkles', tint: 'indigo', build: buildAi, warn: () => onboarding.ai === false },
  { id: 'asr', label: '语音识别', icon: 'audio-lines', tint: 'blue', build: buildAsr, warn: () => onboarding.asr === false },
  { id: 'voiceprint', label: '声纹', icon: 'fingerprint-pattern', tint: 'purple', build: buildVoiceprint, warn: () => onboarding.voiceprint === false && P.get('captureMic') },
  { id: 'assist', label: 'AI 答题', icon: 'message-square-text', tint: 'green', build: buildAssist },
  { id: 'overlay', label: '字幕与答题框', icon: 'captions', tint: 'orange', build: buildOverlay },
  { id: 'class', label: '课堂', icon: 'graduation-cap', tint: 'pink', build: buildClass },
  { id: 'hotkeys', label: '快捷键', icon: 'keyboard', tint: 'teal', build: buildHotkeys },
  { id: 'mic', label: '麦克风', icon: 'mic', tint: 'red', build: buildMic },
  { id: 'permissions', label: '权限', icon: 'shield-check', tint: 'yellow', build: buildPermissions, warn: () => ['microphone', 'screen'].some((k) => perms[k] && perms[k] !== 'granted') },
  { id: 'about', label: '关于', icon: 'info', tint: 'gray', build: buildAbout },
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
      el('span.dot.dot-warn', { hidden: true, title: '还没设置好' }),
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
  s.replaceChildren(icon('check', 13), el('span', { text: '已保存' }))
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
  })
}

boot()
