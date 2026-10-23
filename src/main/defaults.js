// 设置的默认值和合并规则。不引 electron，engine 和单测都能直接用。
import { PRESET_IDS, PROVIDER_IDS, presetByUrl, providerOf } from './llm/providers.js'

export const DEFAULTS = {
  // 会员（member：识别和 AI 都经 MeetCaption 服务器，不用填 Key，按场扣）| 自带 Key（own：下面的识别和 AI 设置）
  plan: 'member',
  memberAsr: 'cloud', // 会员用哪种识别：cloud（豆包 2.0，经我们服务器）| local（本地识别，只用会员 AI）
  engine: 'local', // local（本地 X-ASR，免费、不联网、不用 Key）| volc（豆包）| openai
  // v3：对方语言、会议背景、术语、我的资料（assist.profile）挪到了项目里（project.json）。这里的四个值只在第一次升级时迁成「未归类」的默认值。
  language: 'en', // 对方说的语言：languages.js 的 SOURCE_LANGS（en | zh | de … | auto）
  openaiKey: '',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-live-transcribe',
  openaiDelay: 'low', // minimal | low | medium | high
  volcAppId: '',
  volcAccessToken: '',
  volcResourceId: 'volc.seedasr.sauc.duration',
  context: '',
  keywords: '',
  translate: true, // v4：字幕下面一句一对的中文是核心功能，默认开（老设置文件里没存这个键的也跟着开）
  translateTarget: 'zh', // 翻译成什么：languages.js 的 TARGET_CODES（多一个 zh-Hant 繁体中文）；项目上设了（project.target）用项目的
  llmProvider: 'openai', // llm/providers.js 里的 id：chatgpt（ChatGPT 账号登录）| openai | deepseek、zhipu 等内置服务 | custom（自定义兼容接口）
  llmBaseUrl: 'https://api.openai.com/v1', // 只给 custom 用
  llmKey: '', // 只给 custom 用；OpenAI 用 openaiKey
  llmKeys: Object.fromEntries(PRESET_IDS.map((id) => [id, ''])), // 内置服务各自的 Key，换来换去不丢
  // 下面三个是当前这家的模型；换服务时存进 llmModels[旧的]，再取出新的那家上次用的（没有就用推荐）
  llmFastModel: 'gpt-5.6-luna',
  llmSummaryModel: 'gpt-5.6-terra',
  llmAnswerModel: '', // 留空按通道选：ChatGPT 用 terra，其他跟 llmFastModel（见 llm/index.js 的 ANSWER_DEFAULTS）
  llmModels: Object.fromEntries(PROVIDER_IDS.map((id) => [id, { fast: '', summary: '', answer: '' }])),
  captureMic: true,
  micDeviceId: '',
  hotkeyToggle: 'CommandOrControl+Alt+S',
  hotkeyRecord: 'CommandOrControl+Alt+R', // 全局：在当前项目里开始记录，记录中再按停止
  // 主窗口里的快捷键，设置里都能改；空字符串表示不用
  keys: {
    palette: 'CommandOrControl+K',
    settings: 'CommandOrControl+,',
    start: 'CommandOrControl+Shift+R',
    live: 'CommandOrControl+0',
    newProject: 'CommandOrControl+N',
    home: 'CommandOrControl+1',
    todos: 'CommandOrControl+2',
    back: 'CommandOrControl+[',
    sidebar: 'CommandOrControl+\\',
  },
  hideFromScreenShare: true,
  saveDir: '', // 根目录，空就是 文稿/会议字幕
  theme: 'system', // system | dark | light
  sidebarOpacity: 0.85, // Mac 毛玻璃、Windows 11 云母上侧栏底色有多实：1 不透明，太低了深色桌面前看不清字
  launchAtLogin: false,
  currentProjectId: 'inbox', // 主窗口和托盘里选中的项目，开会就开在它里面
  onboarding: { done: false, shownAt: 0, demo: false }, // 首次引导：done 走完权限小窗；shownAt 自动弹过一次（之后只能从设置里再打开）；demo 看过（或跳过）主窗口上的演示
  migrations: { projects: false, translateOn: false, volcSeed: false, localAsr: false, providers: false, plan: false }, // providers：「其他兼容服务」填的是内置的那几家地址的，换成那一家；projects：v2 的全局会议背景等已经迁进「未归类」；translateOn：升级时打开过一次翻译；volcSeed：豆包资源 ID 从旧默认 1.0 换成过 2.0；localAsr：没配好识别 Key 的换成过本地识别；plan：0.6 以前就在用的人（走完过引导）定成自带 Key
  terms: { enabled: true, correct: true }, // correct：AI 纠正识别错误（跟译文、术语同一个请求，显示纠正后的句子，识别原文留在存档里）
  voiceprint: { threshold: 0.5 }, // 声纹本体存 userData/voiceprint.json
  assist: {
    enabled: true,
    auto: true,
    withScreen: true,
    profile: '', // 「我的资料」：简历、项目介绍等，答题时带上
    answerLang: 'auto', // auto（跟提问语言）| en | zh
    hotkeyAsk: 'CommandOrControl+Alt+A',
  },
  display: { chunkColors: true, chunkStyle: 'text' }, // v4：双语意群颜色对照（关掉就退回单色，也不再向 AI 要意群对齐）；chunkStyle：text（文字着色）| bar（下方细色条）
  class: {
    source: 'mic', // 课堂默认声音来源：mic（教室现场）| system（网课）；项目上记了就用项目的
    notesEveryMin: 2, // 实时笔记每攒几分钟新内容更新一次：1 | 2 | 5
    hotkeySlide: 'CommandOrControl+Alt+P', // 截取画面（只在上课记录时注册）
    exportDir: '', // 导出课堂笔记的文件夹（记住上次选的）
  },
  overlay: {
    fontSize: 26,
    lines: 4,
    bgOpacity: 0.6,
    textColor: '#ffffff',
    translationColor: '#ffd666',
    showTranslation: true,
    showMic: false,
    bounds: null,
    anchor: 'bottom', // 字幕条朝向：bottom 贴底边往上长（在屏幕下半部）| top 贴顶边往下长（拖到上半部松手后自动换）
    answerBounds: null,
  },
}

// 0.4.1 之前的默认资源 ID（豆包 1.0）。那时保存过设置的，文件里存的都是它
export const OLD_VOLC_RESOURCE_ID = 'volc.bigasr.sauc.duration'

/**
 * 升级时对老设置做的一次性修改，返回要 update 的 patch，没有要做的返回 null。
 * 每一项做完都在 migrations 里记一笔（改没改都记），之后用户自己改回去不再动：
 * - translateOn：老设置里存着 translate:false 的打开一次（v4 中英对照是核心功能）。
 * - volcSeed：豆包资源 ID 还是旧默认 1.0 的换成现在的默认 2.0。
 */
export function upgradePatch(s) {
  const done = s?.migrations ?? {}
  const patch = {}
  const marks = {}
  if (!done.translateOn) {
    patch.translate = true
    marks.translateOn = true
  }
  if (!done.volcSeed) {
    if (s?.volcResourceId === OLD_VOLC_RESOURCE_ID) patch.volcResourceId = DEFAULTS.volcResourceId
    marks.volcSeed = true
  }
  // 0.5：识别服务还没配好 Key 的换成本地识别，打开就能用；已经填了豆包或 OpenAI 的不动
  if (!done.localAsr) {
    const ready = s?.engine === 'volc' ? Boolean(s.volcAppId && s.volcAccessToken) : s?.engine === 'openai' ? Boolean(s.openaiKey) : true
    if (!ready) patch.engine = 'local'
    marks.localAsr = true
  }
  // 0.5.6：AI 服务改成多家可选。原来选「其他兼容服务」、地址是 DeepSeek 这类内置服务的，换成那一家，Key 挪进 llmKeys，模型不动
  if (!done.providers) {
    const id = s?.llmProvider === 'custom' ? presetByUrl(s.llmBaseUrl) : null
    if (id) Object.assign(patch, { llmProvider: id, llmKeys: { [id]: s.llmKey ?? '' } })
    marks.providers = true
  }
  // 0.6：加了会员。已经在用的人保持自带 Key（他们的 Key 和识别设置不动），新装的默认会员
  if (!done.plan) {
    if (s?.onboarding?.done) Object.assign(patch, { plan: 'own', onboarding: { demo: true } })
    marks.plan = true
  }
  return Object.keys(marks).length ? { ...patch, migrations: marks } : null
}

/**
 * 换 AI 服务时补全 patch：当前三个模型存进 llmModels[旧的]，再换成新的那家上次用的；没用过就用推荐模型（自定义没有推荐，保持不动）。
 * 没换服务原样返回。
 */
export function providerPatch(current, patch) {
  const next = patch?.llmProvider
  const prev = current?.llmProvider ?? DEFAULTS.llmProvider
  if (!next || next === prev) return patch
  const saved = current?.llmModels?.[next]
  const p = providerOf(next)
  const models = saved?.fast
    ? { llmFastModel: saved.fast, llmSummaryModel: saved.summary, llmAnswerModel: saved.answer }
    : p.fast
      ? { llmFastModel: p.fast, llmSummaryModel: p.smart, llmAnswerModel: '' }
      : {}
  const stash = { fast: current.llmFastModel, summary: current.llmSummaryModel, answer: current.llmAnswerModel }
  return { ...models, ...patch, llmModels: { ...patch.llmModels, [prev]: stash } }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 按 defaults 的形状取值：多余的键丢掉，缺的补默认，嵌套对象逐层合并。 */
export function merge(defaults, value) {
  const out = { ...defaults }
  for (const [k, v] of Object.entries(value ?? {})) {
    if (!(k in defaults)) continue
    const d = defaults[k]
    out[k] = isPlainObject(d) ? merge(d, v) : v
  }
  return out
}

/** 把一次局部修改叠到当前设置上：所有嵌套对象（overlay、assist、terms、voiceprint）都只改给了的字段。 */
export function applyPatch(current, patch, defaults = DEFAULTS) {
  const out = { ...current }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in defaults)) continue
    out[k] = isPlainObject(defaults[k]) && isPlainObject(v) ? applyPatch(current?.[k] ?? {}, v, defaults[k]) : v
  }
  return merge(defaults, out)
}

export function keywordList(s) {
  return String(s.keywords ?? '')
    .split(/[\n,，;；]/)
    .map((w) => w.replace(/[<>\r\n]/g, '').trim())
    .filter(Boolean)
    .slice(0, 100)
}
