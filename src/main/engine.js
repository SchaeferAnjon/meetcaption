import { EventEmitter } from 'node:events'
import { SpeechGate } from './audio/gate.js'
import { MacSystemAudio, macTapSupported } from './audio/macTap.js'
import { AudioRing } from './audio/ring.js'
import { WavCapture } from './audio/wav.js'
import { cosine, pcm16ToFloat32, resample, scoreSegment } from './audio/voiceprint.js'
import { OpenAIRealtimeASR } from './asr/openai.js'
import { VolcStreamASR } from './asr/volc.js'
import { LocalStreamASR, localAsrAvailable } from './asr/local.js'
import { SonioxStreamASR } from './asr/soniox.js'
import { LocalFallbackASR } from './asr/fallback.js'
import { LocalWeakWatch } from './asr/localQuality.js'
import { isCutOff, isQuestion, pickLastQuestion } from './assist/question.js'
import { splitAnswer } from './assist/answerPrompt.js'
import { checkFix, chunkCoverage, enhanceMessages, noDashes, parseEnhance, streamedHead, streamedPartial, translateMessages } from './prompts.js'
import { keywordList } from './defaults.js'
import { projectSettings } from './projects.js'
import { isCrosstalk, questionRun, tokenize } from './speaker.js'
import { isMostlyChinese, joinFixed, splitSentences } from './text.js'
import { LANG_NAMES, needsMultilingual, needsTranslation } from './languages.js'
import { modeSettings, speakerLabel } from './modes.js'
import { LiveNotes } from './class/liveNotes.js'
import { SpeedLog } from './speed.js'
import { t, uiLang } from './i18n.js'

// 一场会议的运行时：采集 → 门限切句 → 识别 → 分句 → 判断是谁说的 → 译文、意群对齐和术语 → 存档，对方的提问交给答题助手。
// 电脑声音（system）是对方。麦克风（mic）的每段定稿先看是不是外放漏进来的对方声音（和对方最近 10 秒的字幕比词重合），是就丢掉；
// 不是的话，录了声纹就比声纹：像我的算我，不像的算对方（面对面开会）；没录声纹都算我。
// 模式（modes.js）：面试强制自动答题；课堂上对方叫「老师」，可以截取画面。三种模式都边听边整理实时笔记（class/liveNotes.js）。
// 课堂的教室现场只开麦克风：录了声纹的话像我的算我（我在课上提问），其余算老师；没录声纹都算老师。网课同会议，电脑声音是老师。
const debug = process.env.MEETCAPTION_DEBUG ? (...a) => console.error(new Date().toISOString().slice(11, 23), ...a) : () => {}
const LIVE_KEEP = 300
const PENDING = Symbol('pending')
// 远程开会（对方从电脑声音进来）时，麦克风里的人几乎都是我：声纹分数要低到这个以下才算屋里的别人。
// 实测 M1 上声纹注册和开会时的麦克风不一样，我自己的话打分 0.17 到 0.53（中位数 0.37），按 0.5 判有七成被当成了对方，AI 就去答我自己说的话。
const REMOTE_OTHER_MAX = 0.2
const DEFER_MS = 1500 // 麦克风段不像我、对方那一路又还在出字：等对方字幕跟上再判串音
const SCORE_STEP_MS = 1500 // 说话过程中每多 1.5 秒重新打一次分，到 8 秒为止
const SCORE_MAX = 6 * 16000 // 打分最多用 6 秒音频（取中间）：音频越长算得越久
const SHORT_FOLLOW_MS = 20_000
const MAX_HOTWORDS = 100
const CROSSTALK_WINDOW_MS = 10_000
const TRANSCRIPT_MS = 15 * 60_000 // 答题带最近多久的记录（再按句数和字数截，见 answerPrompt.js）
const NOTES_TICK_MS = 5000
const ENH_HOLD_MS = 2000 // 答题优先时译文最多等多久（答案首字一般 1 到 2 秒）
// 长句前半先翻（临时译文）：还没说完的这句话里已经定稿的部分够长、里面有逗号这类停顿，就把停顿前面的翻出来
const PROV_WORDS = 14 // 定稿部分至少这么多词（中文按字数 PROV_CHARS）才开始
const PROV_CHARS = 28
const PROV_MIN_WORDS = 6 // 停顿前面至少这么多词才值得翻（太短的一小截没有意义）
const PROV_MIN_CHARS = 12
const LIVE_MS = 80 // 译文边写边显示，字幕最多这么久刷新一次
const ENH_RETRY_MS = 1500 // 译文请求失败（不是限流、服务出错这类）后多久只要译文再试一次
// 限流、服务出错、超时、回复是空的：所有译文请求先停这么久，再一次只发一个试，通了才恢复；连着不通就往后挪，最多 30 秒
const ENH_BACKOFF_MS = [5000, 15000, 30000]
const ENH_TRIES = 3 // 服务正常时一句自己失败几次就不再试（服务一直出错时的试探不算）
const CAPTURE_RETRY_MS = [500, 1000, 2000, 3000] // 音频断了重开的间隔，之后一直按最后一个
const SOURCE_NAME = { mic: '麦克风', system: '电脑声音' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function engineLabel(s) {
  if (s.engine === 'local') return '本地识别（X-ASR）'
  if (s.engine === 'soniox') return s.sonioxGetKey ? '会员云识别（Soniox）' : 'Soniox 实时识别'
  if (s.volcUrl) return '会员云识别（豆包 2.0）'
  return s.engine === 'volc' ? `豆包流式识别（${s.volcResourceId}）` : `OpenAI ${s.openaiModel}`
}

/** 识别热词：这场会的项目术语在前，再加其他没归档项目的名字和术语（会上顺带提到别的项目时少听错），去重，最多 100 个。 */
export function hotwordList(s, extra = []) {
  const out = []
  const seen = new Set()
  for (const w of [...keywordList(s), ...(Array.isArray(extra) ? extra : [])]) {
    const word = String(w ?? '').replace(/[<>\r\n]/g, '').trim()
    const key = word.toLowerCase()
    if (!word || word.length > 30 || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length >= MAX_HOTWORDS) break
  }
  return out
}

function createProvider(s) {
  const hotwords = s.hotwords ?? keywordList(s)
  // 本地识别不用热词：X-ASR 的热词时灵时不灵，术语靠 AI 纠错（纠错请求里带着项目术语）
  if (s.engine === 'local') return new LocalStreamASR()
  if (s.engine === 'volc') {
    if (!s.volcAppId || !s.volcAccessToken) throw new Error(t('还没填豆包的 App ID 和 Access Token，去「设置」里填'))
    return new VolcStreamASR({ appId: s.volcAppId, accessToken: s.volcAccessToken, resourceId: s.volcResourceId, hotwords, url: s.volcUrl })
  }
  if (s.engine === 'soniox') {
    if (!s.sonioxKey && !s.sonioxGetKey) throw new Error(t('还没填 Soniox 的 API Key，去「设置」里填'))
    const cloud = new SonioxStreamASR({ key: s.sonioxKey, getKey: s.sonioxGetKey, language: s.language, context: s.context, hotwords, url: process.env.MEETCAPTION_SONIOX_URL || undefined })
    // 断线时本地识别接着认（只认中英文）
    if (needsMultilingual(s.language) || !localAsrAvailable()) return cloud
    return new LocalFallbackASR({ cloud, makeLocal: () => new LocalStreamASR() })
  }
  if (!s.openaiKey) throw new Error(t('还没填 OpenAI API Key，去「设置」里填'))
  return new OpenAIRealtimeASR({
    key: s.openaiKey,
    baseUrl: s.openaiBaseUrl,
    model: s.openaiModel,
    languages: s.language === 'auto' ? [] : [s.language],
    delay: s.openaiDelay,
    prompt: s.context,
    keywords: hotwords,
  })
}

// 提示里的语言名按界面语言写（界面是英文就写 Japanese，不写日语）
const shownLang = (code) => (uiLang() === 'zh' ? LANG_NAMES[code] : new Intl.DisplayNames([uiLang()], { type: 'language' }).of(code)) ?? code

// 译文请求的超时：一般 20 秒，长句多给一点（一个字 30 毫秒，最多再加 20 秒）
const enhanceTimeout = (text) => 20_000 + Math.min(20_000, text.length * 30)

// 回复是空的或者解析不出译文：当成可重试的失败
const emptyReply = () => Object.assign(new Error(t('AI 没给出译文（回复是空的或格式不对）')), { code: 'empty-reply', retryable: true })

// 逗号、分号、冒号（后面是空格或结尾，1,000 和 10:30 不算）、破折号：一句话里的停顿
const CLAUSE_BREAK = /[,;:](?=\s|$)|[，；：]|\s[-\u2013\u2014]\s|[\u2013\u2014]/g

// 句末标点（后面可以跟着引号、括号）
const TERMINAL = /[.!?。！？]["'”’)）\]]*$/
// 句号落在缩写后面（Mr. / U.S. / e.g. / 单个字母加点）不算一句话说完
const ABBREV = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|ltd|co|corp|no|fig|eq|approx|e\.g|i\.e|u\.s|u\.k|a\.m|p\.m|[a-z])\.$/i

// 这个点可能还没写完：数字后面的点（3. 后面可能接 5 变成 3.5）、连着的点（省略号）。等定稿再翻，不提前发
const MAYBE_UNFINISHED = /(?:\d\.|\.\.)["'”’)）\]]*$/

// 太短的句子（Okay. / 对。）不值得单独问术语
const worthTerms = (text) => tokenize(text).length >= 3

// 存档里的段落按开始时间排：同一段就替换，新的一段插到对的位置
function upsertSegment(list, record) {
  const i = list.findIndex((x) => x.id === record.id)
  if (i >= 0) {
    list[i] = record
    return
  }
  let j = list.length
  while (j > 0 && list[j - 1].startedAt > record.startedAt) j--
  list.splice(j, 0, record)
}

// 一句的译文、意群、术语落到已有的句子上：译文和意群要配套（已有的译文没带意群、这次带了，就一起换成这次的）。改了返回 true
// AI 纠正了识别错误（r.fixed）：句子显示纠正后的文字，识别原文留在 orig；意群和术语本来就是按纠正后的句子给的
function mergeEnhance(sen, r) {
  let touched = false
  if (r.fixed && !sen.orig && r.fixed !== sen.text) {
    sen.orig = sen.text
    sen.text = r.fixed
    touched = true
  }
  // 边写边显示的半截译文（trLive）、长句前半的临时译文（prov）被完整的译文换掉
  if (r.tr && (!sen.tr || sen.trLive || sen.prov || (r.chunks?.length && !sen.chunks?.length))) {
    sen.tr = r.tr
    delete sen.trLive
    delete sen.prov
    if (r.chunks?.length) sen.chunks = r.chunks
    touched = true
  }
  if (r.terms && !sen.terms) {
    sen.terms = r.terms
    touched = true
  }
  return touched
}

// 段落文本跟着句子的纠正走：纠正过的句子在识别原文里原地换掉，识别原文留在 seg.orig；一句都没纠正就没有 orig
function syncFixed(seg) {
  const raw = seg.orig ?? seg.text
  const text = joinFixed(raw, seg.sentences)
  seg.text = text
  if (text !== raw) seg.orig = raw
  else delete seg.orig
}

// 存档里的句子不带还在显示中的临时内容：边写边显示的半截译文（trLive）和临时译文（prov）。译文写完才进文件。
// 永远返回新对象：记录和字幕上的句子不能是同一个，不然后来写进字幕句子的半截译文会原地改到记录里
const storable = (sen) => {
  if (!sen.trLive && !sen.prov) return { ...sen }
  const { tr, chunks, trLive, prov, ...rest } = sen
  return rest
}

// 句子的识别原文：译文缓存、重新分句都按它认句子，纠正后的文字不会再被当成新句子送去翻译
const rawOf = (sen) => sen.orig ?? sen.text

// 答题带不带截图：会员通道也带（后台原样转给 deepseek-flash，它看得懂图）
const withScreen = (s) => Boolean(s?.assist?.withScreen)

export class MeetingEngine extends EventEmitter {
  /**
   * llm(opts) → Promise<string>：A 模块 complete 的门面（已绑好设置和登录）。
   * llmStatus() → { ready, reason }。
   * assistant：答题助手（C 模块的 Assistant），对方问完自动调它的 ask。
   * voiceprint：{ profile() → 声纹或 null, loadModel() → Promise<模型> }。
   */
  constructor({ settings, store, rendererCapture, llm = null, llmStatus = null, assistant = null, voiceprint = null, createProvider: make = createProvider, enhanceWaitMs = 4000 }) {
    super()
    this.enhanceWaitMs = enhanceWaitMs // 停止时等还在路上的译文多久再落盘
    this.settings = settings
    this.store = store
    this.rendererCapture = rendererCapture
    this.llm = llm
    this.llmStatus = llmStatus
    this.assistant = assistant
    this.voiceprint = voiceprint
    this.makeProvider = make
    this.state = 'idle'
    this.session = null
    this.cfg = null
    this.live = new Map()
    this.meta = new Map() // 段落 id → 不广播的内部状态 { span, updatedAt, endedAt, awaiting, deferred, settled, ... }
    this.pipelines = new Map()
    this.micRing = null
    this.enh = new Map() // 句子 → PENDING | { tr?, chunks?, terms? } | null
    this.enhEarly = new Map() // 还在路上的句子 → 已经流式收到的 { tr, fixed? }
    this.enhHold = false // 答题优先，新的译文请求先等着
    this.enhHoldSince = 0
    this.enhHoldTimer = null
    this.enhQueue = []
    this.provQueue = [] // 长句前半的临时译文请求：排在整句译文后面，只用空闲的位置
    this.enhRetry = [] // 失败了等着重发的（只要译文）：排在新句子后面，服务恢复后补上
    this.enhFails = 0 // 连着几次可重试的失败：大于 0 时一次只发一个
    this.enhPauseUntil = 0
    this.enhPauseTimer = null
    this.aiLimited = false // 这一场 AI 用量到上限了：不再发译文请求，实时笔记也停
    this.enhActive = 0
    this.enhRunning = new Set() // 已经发出去、还没回来的译文请求（答题时 ChatGPT 通道上要让路）
    this.enhWarned = false
    this.speed = new SpeedLog()
    this.assistWarned = false
    this.weakShown = false // 这一场已经提示过本地识别效果不好
    this.weakWatch = null // 本地识别效果不好的判断（asr/localQuality.js），只在自己选了本地识别时有
    this.fake = null
    this.fakeCapture = null
    this.vp = null
    this.scoring = new Set() // 声纹进程里还在算的分（麦克风段的判断）：停止、暂停时等它们落定
    this.micCheck = false // 麦克风的定稿要不要判（比声纹、查串音）：有声纹，或者同时在录电脑声音（没声纹也要滤串音）
    this.lastMicWho = null
    this.askedAt = new Map()
    this.answered = new Set() // 已经答完的提问段（一次提问的最后一段）：拼新问题时不再当铺垫
    this.answerSeg = new Map()
    this.pendingAsk = null
    this.watchdog = null
    this.filler = null
    this.project = null // 这场会议的项目：会议背景、术语、我的资料、对方语言用它的
    this.mode = 'meeting' // meeting | interview | class
    this.classSource = null // 课堂的声音来源：mic（教室现场）| system（网课）
    this.notes = null // 实时笔记（LiveNotes），三种模式都有
    this.notesTimer = null
    this.notesFlush = null // 下课时最后一次整理笔记的 Promise（自测和退出应用时等它），整理完变回 null
    this.gen = 0 // 第几场会：停止后才回来的译文按它认出是哪一场的
    this.starting = null // start() 还没走完时的 Promise
    this.abortStart = false // 「正在连接」时点了停止
    this.screenAsked = new Set() // 已经为它预先截过图的对方段落
    this.paused = false // 暂停中：采集和识别都关着，会议还是这一场
    this.pauseOp = null // 正在暂停或继续的 Promise
    this.recovering = new Set() // 正在重开的音频（mic / system）
    this.devices = {} // 正在用的设备 { mic: { label, fallback } }
    // 开会中途改设置（翻译、术语、答题开关、声纹阈值、笔记频率）马上生效；识别相关的下次开始才用。换了麦克风马上换
    settings.on?.('change', (next) => {
      if (this.state === 'idle') return
      const prevMic = this.cfg?.micDeviceId
      this.cfg = this.#settingsFor(next)
      if (this.cfg.micDeviceId !== prevMic && this.captureStarted && this.pipelines.has('mic')) this.#recoverCapture('mic', 'switch')
    })
    assistant?.on('answer', (a) => {
      // 答案出了第一个字（或者失败、被停掉）：让路的译文请求接着发
      // 只认让路之后开始的回答：新问题会先停掉还在出字的旧回答，旧的那条 done 不算
      if (this.enhHold && a.startedAt >= this.enhHoldSince && (a.text || a.done)) this.#releaseEnhance()
      if (a.done && a.text && !a.error && !a.cancelled && a.segIds?.length) this.answered.add(a.segIds.at(-1))
      this.#storeAnswer(a)
      if (a.done && a.text && !a.error && !a.cancelled && !a.trans) this.#translateAnswer(a)
    })
  }

  snapshot() {
    const s = this.session
    return {
      state: this.state,
      session: s && { id: s.id, projectId: s.projectId ?? null, startedAt: s.startedAt, engineLabel: s.engineLabel, mode: s.mode ?? 'meeting', classSource: s.classSource ?? null },
      segments: [...this.live.values()],
      paused: this.paused,
      devices: this.devices,
      voiceprint: Boolean(this.vp),
      mode: s?.mode ?? this.mode,
      classSource: s?.classSource ?? null,
      liveNotes: s?.liveNotes ?? null,
      liveNotesAt: s?.liveNotesAt ?? null,
      slides: s?.slides ?? [],
    }
  }

  // 开会用的设置：全局设置 + 项目的四个值 + 模式的覆盖
  #settingsFor(s) {
    return modeSettings(projectSettings(s, this.project), this.mode)
  }

  // 教室现场：只有麦克风一路，默认都是老师
  #classMic() {
    return this.mode === 'class' && this.classSource === 'mic'
  }

  #label(who) {
    return speakerLabel(who, this.mode)
  }

  // 新出现的一段先算谁的：电脑声音是对方；麦克风平时是我，教室现场是老师
  #defaultWho(source) {
    return source === 'mic' && !this.#classMic() ? 'me' : 'other'
  }

  /** 自测用：{ system?: wav, mic?: wav } 按实时速度代替真实采集；给了就不开任何真实设备。值为 true 表示有这一路、由调用方自己 feed（单测）。 */
  useFakeSources(fake) {
    this.fake = fake
  }

  // 会后按快捷键答题也用刚才那场会的项目资料和模式
  #conf() {
    return this.state === 'idle' || !this.cfg ? this.#settingsFor(this.settings.get()) : this.cfg
  }

  #setState(state, extra = {}) {
    this.state = state
    this.emit('state', {
      state,
      sessionId: this.session?.id ?? null,
      projectId: this.session?.projectId ?? this.project?.id ?? null,
      startedAt: this.session?.startedAt ?? null,
      mode: this.mode,
      classSource: this.classSource,
      paused: this.paused,
      ...extra,
    })
  }

  /** 开会中项目资料改了（会议背景、我的资料等）：译文和答题马上用新的；识别的语言和热词下次开始才用。 */
  setProject(project) {
    if (this.state === 'idle' || !project || project.id !== this.project?.id) return
    this.project = project
    this.cfg = this.#settingsFor(this.settings.get())
    if (this.notes) this.notes.context = project.context ?? ''
  }

  /** 会员场次用完、退回本地识别这类：设置没变但实际用的识别变了，下次继续时按新的建识别。 */
  refreshSettings() {
    if (this.state !== 'idle') this.cfg = this.#settingsFor(this.settings.get())
  }

  notice(level, text, code, extra) {
    this.emit('notice', { level, text, code, ...extra })
  }

  // 本地识别效果不好要不要提示：只对自己选了本地识别的用户（会员选本地、场次用完退回本地的另有提示；云识别断线时本地接手的也不算）
  #weakEligible() {
    return this.cfg?.engine === 'local' && this.cfg?.plan !== 'member'
  }

  /**
   * 本地识别效果不好（reason：busy 电脑跟不上 | language 对方说的不是中英文 | fragments 识别结果大多是零碎短句 | corrections AI 纠错改得很多），
   * 提示换云识别或买会员。一场会（包括中间暂停再继续）只提示一次，三条里先到的那条。判断的门槛见 asr/localQuality.js。
   */
  #weak(reason, detail = {}) {
    if (!this.#weakEligible()) {
      if (reason === 'busy') this.notice('warn', t('电脑太忙，本地识别跟不上，字幕会慢一些。可以关掉别的程序。'))
      return
    }
    if (this.weakShown) return
    this.weakShown = true
    const lang = detail.lang ? shownLang(detail.lang) : ''
    const text =
      reason === 'busy'
        ? t('电脑太忙，本地识别跟不上，字幕会慢一些。关掉别的程序会好一点；换成云识别或开通会员，识别在云端做，不占这台电脑。')
        : reason === 'language'
          ? lang
            ? t(`对方在说{0}，本地识别只认中文和英文，字幕会很不准。换成云识别，或者开通会员直接用。`, lang)
            : t('对方说的好像不是中文或英文，本地识别只认中文和英文，字幕会很不准。换成云识别，或者开通会员直接用。')
          : reason === 'fragments'
            ? t('最近的字幕大多是零碎的几个字，本地识别在这段声音上效果不好（可能杂音大，或者声音太小）。可以试试云识别，或者开通会员。')
            : t('AI 一直在大段改本地识别出来的字，说明识别错得比较多。可以试试云识别，或者开通会员。')
    this.notice('warn', text, 'local-weak', { reason, ...detail })
  }

  /**
   * project：{ id, context, keywords, profile, language }（项目存储里的项目），不给就用全局设置。
   * mode：meeting | interview | class；classSource：课堂的声音来源 mic | system（主进程用 modes.resolveMode 定好再传进来）。
   * extraKeywords：其他项目的名字和术语，只加进识别热词（排在这场会的术语后面）。
   * 「正在连接」时调了 stop()：这里在下一个 await 之后发现，清理掉，抛 code 为 start-cancelled 的错。
   */
  start(opts = {}) {
    if (this.state !== 'idle') return Promise.resolve()
    const p = this.#start(opts)
    this.starting = p
    const clear = () => {
      if (this.starting === p) this.starting = null
    }
    p.then(clear, clear)
    return p
  }

  async #start({ project = null, mode = 'meeting', classSource = null, extraKeywords = [] } = {}) {
    // 上一场会停止后还挂在引擎上（界面的「刚才的会议」）：开新的这场先放下，失败了再放回去，别把它当成这次新建的会议删掉
    const prev = this.session
    this.session = null
    this.abortStart = false
    this.gen++
    this.project = project
    this.mode = ['interview', 'class'].includes(mode) ? mode : 'meeting'
    this.classSource = this.mode === 'class' ? (classSource === 'system' ? 'system' : 'mic') : null
    const s = this.#settingsFor(this.settings.get())
    this.cfg = s
    this.#dropEnhanceQueue()
    this.enh.clear()
    this.enhEarly.clear()
    this.speed = new SpeedLog()
    this.aiLimited = false
    this.#releaseEnhance()
    this.enhWarned = false
    this.assistWarned = false
    this.weakShown = false
    this.weakWatch = this.#weakEligible() ? new LocalWeakWatch({ onWeak: (reason, detail) => this.#weak(reason, detail) }) : null
    this.meta.clear()
    this.askedAt.clear()
    this.answered.clear()
    this.answerSeg.clear()
    this.screenAsked.clear()
    this.lastMicWho = null
    this.systemHeard = false // 这一场电脑声音里出过字：远程开会
    this.vp = null
    this.micCheck = false
    this.micRing = null
    this.paused = false
    this.devices = {}
    this.fakeCapture = null
    this.#stopNotes()
    this.notes = null
    const warnings = []
    let created = null
    const checkAbort = () => {
      if (this.abortStart) throw Object.assign(new Error(t('已取消开始')), { code: 'start-cancelled' })
    }
    this.#setState('starting')
    try {
      const classMic = this.#classMic()
      const withMic = classMic || (this.fake ? Boolean(this.fake.mic) : s.captureMic)
      if (classMic && this.fake && !this.fake.mic) throw new Error(t('教室现场要用麦克风，自测要给 --fake-mic'))
      this.sources = [...(classMic ? [] : ['system']), ...(withMic ? ['mic'] : [])]
      this.hotwords = hotwordList(s, extraKeywords)
      this.#buildPipelines(s)
      // 自己选了本地识别、对方语言是外语：换成带「换云识别」「买会员」的提示（见 #weak）；豆包和会员退回本地的照旧
      const weakLang = needsMultilingual(s.language) && this.#weakEligible()
      if (needsMultilingual(s.language) && s.engine !== 'openai' && s.engine !== 'soniox' && !weakLang)
        warnings.push({ text: t(`{0}只认中文和英文，听不懂{1}。在「设置 → 语音识别」里换成 Soniox 或 OpenAI 再开始。`, s.engine === 'local' ? t('本地识别') : t('豆包'), shownLang(s.language)), code: 'asr-language' })
      const vpLoad = withMic ? this.#loadVoiceprint(warnings) : null
      await Promise.all([...this.pipelines.values()].map((p) => p.provider.connect()))
      await vpLoad
      this.micCheck = this.pipelines.has('mic') && (Boolean(this.vp) || this.pipelines.has('system'))
      checkAbort()
      const cls = this.mode === 'class' ? { classSource: this.classSource, slides: [] } : {}
      created = this.store.create({ ...(project ? { projectId: project.id } : {}), mode: this.mode, ...cls, liveNotes: null, liveNotesAt: null, engine: s.engine, engineLabel: engineLabel(s), language: s.language, target: s.translateTarget, answers: [] })
      this.session = created
      this.live.clear()
      await this.#startCapture(s)
      checkAbort()
      this.#startNotes(this.session)
      this.#setState('running')
      this.#warmUp(s)
      for (const w of warnings) this.notice('warn', w.text, w.code)
      if (weakLang) this.#weak('language', { lang: s.language, source: 'setting' })
      this.#startWatchdog()
      this.#startSilenceFiller()
    } catch (err) {
      const cancelled = this.abortStart
      const e = cancelled ? Object.assign(new Error(t('已取消开始')), { code: 'start-cancelled' }) : err
      await this.#teardown()
      // 只删这次新建、还没有内容的会议文件夹（先标上结束时间，不然存储当它还在记录、不让删）
      if (created) {
        created.endedAt = Date.now()
        if (!created.segments.length) await this.store.remove(created.id).catch(() => {})
        else this.store.saveNow(created)
      }
      this.session = created?.segments.length ? created : prev
      this.notes = null
      this.abortStart = false
      // 取消的：stop() 已经发过 idle，这里不再报错
      if (!cancelled) this.#setState('idle', { error: e.message })
      else if (this.state !== 'idle') this.#setState('idle')
      throw e
    }
  }

  // 每一路一个识别实例和门限，麦克风另有 60 秒环形缓冲给声纹打分。继续（暂停后）时也是新建一套：span 从新的这一路音频算起
  #buildPipelines(s) {
    const ps = { ...s, hotwords: this.hotwords }
    for (const source of this.sources) {
      const provider = this.makeProvider(ps)
      this.#wireProvider(source, provider)
      const ring = source === 'mic' ? new AudioRing(provider.sampleRate, 60) : null
      this.pipelines.set(source, { source, provider, gate: new SpeechGate({ sampleRate: provider.sampleRate }), ring, lastRealAt: 0 })
      if (ring) this.micRing = ring
    }
  }

  // 有声纹才加载模型（冷启动会卡主进程 1 到 2 秒，放在连接识别服务的同时做）
  async #loadVoiceprint(warnings) {
    const profile = this.voiceprint?.profile?.()
    if (!profile) return
    try {
      const t0 = Date.now()
      const model = await this.voiceprint.loadModel()
      this.vp = { model, profile }
      this.emit('trace', { type: 'voiceprint', ms: Date.now() - t0 })
    } catch (e) {
      warnings.push({ text: t(`声纹模型没加载上，这次麦克风里的话都算「{0}」：{1}`, this.#classMic() ? t('老师') : t('我'), e.message), code: 'voiceprint' })
    }
  }

  async #startCapture(s) {
    const sampleRate = [...this.pipelines.values()][0].provider.sampleRate
    const withSystem = this.pipelines.has('system')
    const withMic = this.pipelines.has('mic')
    if (this.fake) {
      // 假音源：两路同时从文件按实时速度喂；放完以后由补静音接手
      this.fakeCapture ??= new WavCapture(this.fake) // 暂停后继续时接着上次放到的地方
      this.emit('trace', { type: 'fake-start', at: Date.now() })
      await this.fakeCapture.start({ system: withSystem, mic: withMic, sampleRate, onPcm: (source, buf) => this.feed(source, buf) })
      return
    }
    const wantRendererSystem = withSystem && process.platform !== 'darwin'
    if (withSystem && !wantRendererSystem) {
      if (!macTapSupported()) throw new Error(t('抓电脑声音需要 macOS 14.2 或更新的系统'))
      const tap = new MacSystemAudio({ sampleRate })
      tap.on('data', (buf) => this.feed('system', buf))
      tap.on('error', (e) => this.notice('error', t(`系统声音采集出错：{0}`, e.message)))
      tap.on('stalled', () => this.notice('warn', t('还没收到电脑的声音。如果屏幕上弹出「会议字幕想访问以录制你的系统音频」，点「允许」。'), 'mac-permission'))
      tap.on('resumed', () => this.notice('clear', '', 'mac-permission'))
      // 换了输出设备（戴上 / 摘下耳机）audiotee 断了：它自己重开，这里只报状态
      tap.on('restarting', (why) => {
        debug('system', 'tap restarting', why)
        this.notice('warn', t('电脑声音断开了（可能换了耳机或扬声器），正在重新连接…'), 'capture-system')
      })
      tap.on('restored', () => {
        this.notice('clear', '', 'capture-system')
        this.notice('info', t('电脑声音已重新连上'), 'capture-restored')
      })
      tap.start()
      this.macTap = tap
    }
    if (wantRendererSystem || withMic) {
      this.captureStarted = true
      this.captureToken = await this.rendererCapture.start({
        system: wantRendererSystem,
        mic: withMic,
        sampleRate,
        micDeviceId: s.micDeviceId,
        onPcm: (source, buf) => this.#captured(source, buf),
        onError: (source, msg) => this.notice('error', t(`{0}采集出错：{1}`, SOURCE_NAME[source], msg)),
        onLost: (source, reason) => this.#recoverCapture(source, reason),
      })
      const mic = this.rendererCapture.info?.mic
      if (mic) this.#setDevice('mic', mic)
    }
  }

  // 采集窗口来的真实音频（补的静音不算）：记下时间，麦克风停了太久就当断了
  #captured(source, buf) {
    const p = this.pipelines.get(source)
    if (p) p.lastRealAt = Date.now()
    this.feed(source, buf)
  }

  #setDevice(source, { label, fallback }) {
    this.devices = { ...this.devices, [source]: { label: label ?? '', fallback: Boolean(fallback) } }
    this.emit('devices', this.devices)
  }

  /**
   * 重开采集窗口里的一路：ended（音轨断了，拔耳机、蓝牙断开）、stalled（好几秒没数据）先报「断开了」，一直重试到连上；
   * default-changed（系统默认麦克风换了）、preferred-back（选的麦克风插回来了）、switch（设置里换了麦克风）直接换，连不上才报。
   */
  async #recoverCapture(source, reason) {
    if (this.state !== 'running' || this.paused || !this.captureStarted || this.recovering.has(source)) return
    this.recovering.add(source)
    const token = this.captureToken
    const code = `capture-${source}`
    const name = SOURCE_NAME[source]
    const loud = reason === 'ended' || reason === 'stalled'
    let warned = false
    const warn = () => {
      warned = true
      this.notice('warn', t(`{0}断开了（可能拔了耳机或换了设备），正在重新连接…`, name), code)
    }
    if (loud) warn()
    debug(source, 'capture lost', reason)
    this.emit('trace', { type: 'capture-lost', source, reason })
    try {
      for (let i = 0; this.state === 'running' && !this.paused && this.captureToken === token; i++) {
        const r = await this.rendererCapture.restart(token, source, { micDeviceId: this.cfg.micDeviceId }).catch((e) => ({ ok: false, error: e.message }))
        if (r.stopped) return
        if (r.ok) {
          const p = this.pipelines.get(source)
          if (p) p.lastRealAt = Date.now()
          if (warned) this.notice('clear', '', code)
          if (source === 'mic') {
            this.#setDevice('mic', r)
            const label = r.label ? `：${r.label}` : ''
            const text = r.fallback ? `选的麦克风没接上，先用系统默认${label}` : warned ? `麦克风已重新连上${label}` : `麦克风换成了${label || '系统默认'}`
            this.notice('info', text, 'capture-device')
          } else if (warned) this.notice('info', t(`{0}已重新连上`, name), 'capture-device')
          this.emit('trace', { type: 'capture-restored', source, reason, tries: i + 1, label: r.label ?? '' })
          return
        }
        debug(source, 'capture restart failed', r.error)
        if (!warned && i >= 1) warn()
        await sleep(CAPTURE_RETRY_MS[Math.min(i, CAPTURE_RETRY_MS.length - 1)])
      }
    } finally {
      this.recovering.delete(source)
    }
  }

  // 没声音提示：开始 noAudioMs 还没听到主音源就提示一次；提示过以后又听到了，或者会议结束，就发 clear 收回（单测改小这两个值）
  noAudioMs = 20_000
  watchdogEveryMs = 2000
  watchdogNotice = null // 发出去还没收回的提示的 code
  captureStallMs = 3000 // 麦克风这么久没来一包就当断了（拔耳机时有的设备不发 ended）

  #startWatchdog() {
    const started = Date.now()
    const classMic = this.#classMic()
    this.watchdogNotice = null
    this.watchdog = setInterval(() => {
      const main = this.pipelines.get(classMic ? 'mic' : 'system')
      if (!main) return
      if (main.gate.heardSomething) return this.#stopWatchdog()
      if (this.watchdogNotice || Date.now() - started <= this.noAudioMs) return
      const [level, text, code] = classMic
        ? ['warn', '开始 20 秒了还没听到麦克风里有声音，看看麦克风是不是选对了、有没有被静音。', 'no-mic-audio']
        : // 麦克风里有人说话：多半是面对面开会，电脑本来就没声音
          this.pipelines.get('mic')?.gate.heardSomething
          ? ['info', '开始 20 秒了还没听到电脑里有声音。面对面开会的话可以忽略这条；线上会议的话，看看会议声音是不是从这台电脑放出来的。', 'no-audio-f2f']
          : ['warn', '开始 20 秒了还没听到电脑里有任何声音。', process.platform === 'darwin' ? 'mac-no-audio' : 'no-audio']
      this.watchdogNotice = code
      this.notice(level, text, code)
    }, this.watchdogEveryMs)
  }

  #stopWatchdog() {
    clearInterval(this.watchdog)
    this.watchdog = null
    if (this.watchdogNotice) this.notice('clear', '', this.watchdogNotice)
    this.watchdogNotice = null
  }

  // 开着答题（课堂除外）就先把答题模型和截屏热起来，第一次答题不用现建连接
  #warmUp(s) {
    const a = s.assist
    if (!this.assistant?.warmUp || !a?.enabled || this.mode === 'class') return
    if (this.llmStatus?.()?.ready === false) return
    this.assistant
      .warmUp({ screen: withScreen(s) })
      .then((r) => this.emit('trace', { type: 'warm', ...r }))
      .catch(() => {})
  }

  /* ---------------- 实时笔记；课堂截取画面 ---------------- */

  #startNotes(session) {
    const notes = new LiveNotes({
      llm: this.llm ?? (async () => Promise.reject(new Error(t('没接 AI 服务')))),
      llmStatus: this.llmStatus,
      startedAt: session.startedAt,
      everyMs: () => Math.max(1, Number(this.cfg?.class?.notesEveryMin) || 2) * 60_000,
      context: this.project?.context ?? '',
      mode: this.mode,
      lang: session.target ?? 'zh',
    })
    notes.on('update', (u) => this.#onNotes(session, u))
    notes.on('limit', (e) => this.#aiLimit(e))
    this.notes = notes
    this.notesTimer = setInterval(() => notes.tick(), NOTES_TICK_MS)
  }

  #stopNotes() {
    clearInterval(this.notesTimer)
    this.notesTimer = null
  }

  // 新版笔记存进 session.liveNotes；会已经停了（下课后最后一次整理）就只改文件里的这两个字段
  #onNotes(session, { notes, updatedAt, error, ms }) {
    if (!error) {
      session.liveNotes = notes
      session.liveNotesAt = updatedAt
      if (this.session === session && this.state !== 'idle') this.store.scheduleSave(session)
      else {
        try {
          this.store.update(session.id, { liveNotes: notes, liveNotesAt: updatedAt })
        } catch {}
      }
    }
    this.emit('trace', { type: 'notes', ok: !error, error: error ?? null, ms: ms ?? null })
    this.emit('notes', { sessionId: session.id, notes, updatedAt, error: error ?? null })
  }

  /** 截取的画面（主进程已经存进 slides/）记到这场会议里。→ { file, at } */
  addSlide({ file, at = Date.now() }) {
    const s = this.session
    if (!s || this.state !== 'running') throw new Error(t('没在记录，开始记录后才能截取画面'))
    s.slides ??= []
    const slide = { file, at }
    s.slides.push(slide)
    this.store.scheduleSave(s)
    this.emit('slide', { sessionId: s.id, ...slide })
    return slide
  }

  // Windows 上没有任何程序在放声音时，loopback 可能一包数据都不给；这时补静音，让门限照样能在停顿处切句。
  #startSilenceFiller() {
    const now = Date.now()
    for (const p of this.pipelines.values()) p.lastFeedAt = now
    let tickAt = now
    this.filler = setInterval(() => {
      const t = Date.now()
      // 这次晚了很多才轮到：是主进程卡住了，采集的数据还排在后面，不是没声音；这时补静音会插进说话中间，门限当成停顿切句
      const late = t - tickAt > 450
      tickAt = t
      if (late) return
      for (const p of this.pipelines.values()) {
        // 麦克风一直有数据（安静时也有）：好几秒没来就是设备没了。Windows 的电脑声音没人放声音时本来就不来数据，不算
        if (p.source === 'mic' && p.lastRealAt && t - p.lastRealAt > this.captureStallMs) {
          p.lastRealAt = 0
          this.#recoverCapture('mic', 'stalled')
        }
        const gap = t - p.lastFeedAt
        if (gap < 400) continue
        const samples = Math.round((Math.min(gap, 1000) * p.provider.sampleRate) / 1000)
        this.feed(p.source, Buffer.alloc(samples * 2))
      }
    }, 250)
  }

  feed(source, buf) {
    const p = this.pipelines.get(source)
    if (!p || this.state !== 'running' || this.paused) return
    p.lastFeedAt = Date.now()
    p.ring?.write(buf)
    const { ops, level } = p.gate.push(buf)
    this.emit('level', { source, db: level })
    if (!p.provider.gated) {
      p.provider.sendAudio(buf)
      return
    }
    for (const op of ops) {
      if (op.audio) p.provider.sendAudio(op.audio)
      else if (op.endTurn) {
        debug(source, 'endTurn')
        p.provider.endTurn(this.#toMs(p, op))
      }
    }
  }

  #toMs(p, t) {
    const rate = p.provider.sampleRate
    return t && { start: (t.start * 1000) / rate, end: (t.end * 1000) / rate }
  }

  // 一段是什么时候开始说的：按它在这一路音频里的起点，从现在（已经收到的音频的末尾）往回推。
  // 识别断线重连后补出来的字比说话晚好几秒，按出字的时间算会排到后来说的话后面。不知道起点就用现在
  #spokenAt(source, span) {
    const now = Date.now()
    const p = this.pipelines.get(source)
    const at = p && (span ?? (p.provider.gated ? this.#toMs(p, p.gate.openTurn()) : null))
    if (!at) return now
    const heard = ((p.gate.base + p.gate.pending.length) * 1000) / p.provider.sampleRate
    const back = Math.min(Math.max(0, heard - at.start), 5 * 60_000)
    return Math.max(now - back, this.session?.startedAt ?? 0)
  }

  #wireProvider(source, provider) {
    provider.on('partial', ({ key, text, span, stable }) => {
      debug(source, 'partial', key.slice(-6), JSON.stringify(text))
      this.#onText(source, key, text, false, span, stable)
    })
    provider.on('final', ({ key, text, span }) => {
      debug(source, 'FINAL', key.slice(-6), JSON.stringify(text), span ? `${Math.round(span.start)}-${Math.round(span.end)}ms` : '')
      if (this.#defaultWho(source) === 'other') this.weakWatch?.final(text)
      this.#onText(source, key, text, true, span)
    })
    // 识别服务改了断句，之前的未定稿句子作废（豆包）：从实时记录里拿掉
    provider.on('drop', ({ key }) => this.#dropStale(`${source}:${key}`))
    provider.on('status', (st) => {
      if (this.state !== 'running') return
      if (st === 'reconnecting') {
        const lang = this.cfg?.language
        const why = this.cfg?.engine === 'soniox' && needsMultilingual(lang) ? t('识别连接断了，正在重连。本地识别只认中英文，{0}要等网络恢复，最近 60 秒的话连上后会补出来。', shownLang(lang)) : t('识别连接断了，正在重连…')
        this.notice('warn', why, 'reconnecting')
      }
      if (st === 'fallback') this.notice('warn', t('网络断了，先用本地识别接着记。网络好了会自动换回云识别。'), 'reconnecting')
      if (st === 'ready') this.notice('info', t('识别已重新连上'), 'reconnected')
      if (st === 'back') this.notice('info', t('网络恢复了，已换回云识别'), 'reconnected')
    })
    provider.on('warn', (msg) => this.notice('warn', msg))
    provider.on('weak', (w) => this.#weak(w.reason, w))
    // 会员服务器停了识别（场次用完、没说话自动暂停）：主进程决定暂停还是换本地识别
    provider.on('member', (type) => this.emit('member', { type, source }))
    provider.on('fatal', (e) => {
      this.notice('error', e.message)
      if (this.state === 'running') this.stop().catch(() => {})
    })
  }

  #m(seg) {
    let m = this.meta.get(seg.id)
    if (!m) this.meta.set(seg.id, (m = {}))
    return m
  }

  #onText(source, key, text, final, span, stable = null) {
    if (!this.session) return
    const id = `${source}:${key}`
    let seg = this.live.get(id)
    if (!seg) {
      if (!text || this.meta.has(id)) return // meta 还在说明这段已经丢掉或挤出去了
      const who = this.#defaultWho(source)
      seg = { id, source, speaker: this.#label(who), who, startedAt: this.#spokenAt(source, span), text: '', final: false, sentences: [] }
      this.live.set(id, seg)
      this.meta.set(id, {})
      if (this.live.size > LIVE_KEEP) {
        const old = this.live.keys().next().value
        this.live.delete(old)
        this.meta.delete(old)
      }
    }
    const m = this.#m(seg)
    if (seg.final || m.awaiting) return
    seg.text = text || (final ? seg.text : '')
    m.updatedAt = Date.now()
    m.stable = final ? null : stable // 识别服务说已经定下来的那一截（text 的开头），没说就是 null
    const p = this.pipelines.get(source)
    if (span) {
      m.span = span
      m.spanFixed = true
    } else if (!final && p?.provider.gated && !m.spanFixed) {
      // OpenAI 这段还没 commit：就是门限里正在说的这一段
      m.span = this.#toMs(p, p.gate.openTurn()) ?? m.span
    }
    if (source === 'system') {
      if (text) this.systemHeard = true
      this.#recheckDeferred()
    }
    if (!final && seg.who === 'other') this.#maybePrefetchScreen(seg)
    if (source === 'mic' && this.micCheck) {
      if (final) {
        m.awaiting = true
        this.#track(this.#decideMic(seg, m))
        return
      }
      if (this.vp) this.#scorePartial(seg, m)
      // 还在说的这段和对方刚说的话重合：多半是外放漏进麦克风的，先不上屏（不然同一句会有「对方」「我」两行），定稿再判
      if (this.#hideEcho(seg, m)) return
    }
    this.#update(seg, final)
  }

  // 麦克风还没定稿的段看着像串音就藏起来：已经上过屏的发一个空文本让界面拿掉。声纹认出是我的照常显示。→ 藏了没有
  #hideEcho(seg, m) {
    const mine = seg.vp != null && seg.vp >= this.#threshold()
    if (mine || !this.#crosstalk(seg)) {
      m.echo = false
      return false
    }
    if (!m.echo && m.shown) this.emit('segment', { ...seg, text: '', sentences: [], final: false })
    m.echo = true
    return true
  }

  #update(seg, final) {
    seg.final = final
    let ask = false
    if (final) {
      this.#m(seg).endedAt = Date.now()
      if (seg.who === 'other' && (isQuestion(seg.text) || this.#continuesQuestion(seg))) seg.question = true
      else delete seg.question
      // 要自动答题：这句的译文请求等答案先发出去（#resplit 里就会发译文请求，所以在它前面拦）
      ask = this.#autoAsk(seg)
      if (ask === 'ask') this.#holdEnhance()
    }
    this.#resplit(seg)
    if (!final) this.#m(seg).shown = true
    if (final) {
      this.#settleSpeed(seg)
      this.#persist(seg)
      // 一段常有四五十秒：把时长交给实时笔记，按句子估每句的时间，小节和强调点才不会都是这段的起点
      const span = this.#m(seg).span
      this.notes?.add({ ...seg, durationMs: span ? span.end - span.start : Date.now() - seg.startedAt })
    }
    this.emit('segment', seg)
    if (ask) this.#maybeAsk(seg, ask)
  }

  // 停止时把每句的计时和汇总写进 trace（speed-row、speed）
  #traceSpeed() {
    if (!this.speed.rows.length) return
    const kept = new Set()
    for (const seg of this.live.values()) for (const sen of seg.sentences ?? []) kept.add(rawOf(sen))
    for (const row of this.speed.rows) if (row.kind === 'final') row.used = kept.has(row.text)
    for (const row of this.speed.rows) this.emit('trace', { type: 'speed-row', ...row })
    this.emit('trace', { type: 'speed', ...this.speed.summary() })
  }

  // 定稿后算这段里各句的 speechEnd（译文速度计时用）：音频位置 → 时间戳，按已经收到的音频长度往回推
  #settleSpeed(seg) {
    const span = this.#m(seg).span
    const p = this.pipelines.get(seg.source)
    if (!span || !p || seg.who !== 'other') return
    const raw = seg.orig ?? seg.text
    const ends = new Map()
    let at = 0
    for (const sen of seg.sentences) {
      const r = rawOf(sen)
      const i = raw.indexOf(r, at)
      if (i < 0) continue
      at = i + r.length
      ends.set(r, at)
    }
    const heard = ((p.gate.base + p.gate.pending.length) * 1000) / p.provider.sampleRate
    const now = Date.now()
    this.speed.settle(seg.id, ends, raw.length, span, (ms) => now - (heard - ms))
  }

  /* ---------------- 麦克风这段是谁说的 ---------------- */

  // 声纹分数；音频不够（去掉静音不到 1 秒）或没有声纹返回 null。向量在声纹进程里算（model.scorePcm），不卡主进程
  async #score(span) {
    const ring = this.micRing
    const vp = this.vp
    if (!vp || !span || !ring) return null
    const pcm = ring.read(span.start - 150, span.end + 150)
    if (!pcm || pcm.length < ring.rate) return null
    try {
      const t0 = performance.now()
      const r = await this.#scoreAudio(vp, pcm, ring.rate)
      this.emit('trace', { type: 'score', ms: Math.round(performance.now() - t0), seconds: r?.seconds ?? null })
      return r ? Math.round(r.score * 100) / 100 : null
    } catch (e) {
      debug('voiceprint', e.message)
      return null
    }
  }

  async #scoreAudio({ model, profile }, pcm, rate) {
    if (model.scorePcm) {
      const r = await model.scorePcm(pcm, rate)
      return r && profile.modelId === model.modelId ? { score: cosine(profile.embedding, r.embedding), seconds: r.seconds } : null
    }
    // 模型在进程内同步算的（单测、自测）
    let x = pcm16ToFloat32(pcm)
    if (rate !== 16000) x = resample(x, rate, 16000)
    if (x.length > SCORE_MAX) {
      const off = (x.length - SCORE_MAX) >> 1
      x = x.subarray(off, off + SCORE_MAX)
    }
    return scoreSegment(model, profile, x)
  }

  // 登记一个还在算的判断，算完（成不成都算）自动注销；停止、暂停时 #settleScoring 等它们
  #track(job) {
    this.scoring.add(job)
    const done = () => this.scoring.delete(job)
    job.then(done, done)
    return job
  }

  async #settleScoring() {
    while (this.scoring.size) await Promise.allSettled([...this.scoring])
  }

  #threshold() {
    return this.cfg?.voiceprint?.threshold ?? 0.5
  }

  // 说话过程中先给个临时判断：像我就是我；不像我而且对方那一路安静（面对面），先显示成对方；
  // 对方正在说话时多半是串音，先当我（字幕窗默认不显示我的话），定稿再判。分数在声纹进程里算，回来以后改了再广播一次。
  #scorePartial(seg, m) {
    const span = m.span
    if (!span) return
    const len = span.end - span.start
    const done = m.scoredLen ?? 0
    if (len < SCORE_STEP_MS || len - done < SCORE_STEP_MS || done >= 8000) return
    if (this.scoring.size) return // 声纹进程还在算别的（定稿的判断不能等），这次不打，下次出字再来
    m.scoredLen = len
    const gen = this.gen
    this.#track(
      this.#score(span).then((score) => {
        if (score == null || gen !== this.gen || seg.final || m.awaiting || m.settled || m.echo) return
        seg.vp = score
        const who = score >= this.#threshold() || this.#systemActive() || this.#crosstalk(seg) || this.#remoteMine(score) ? 'me' : 'other'
        if (who === seg.who) return
        seg.who = who
        seg.speaker = this.#label(who)
        this.#update(seg, false)
      }),
    )
  }

  // 没声纹时 #score 是 null：只剩串音这一条，和对方的字幕高度重合就丢，不重合按麦克风的默认算
  async #decideMic(seg, m) {
    if (!seg.text) {
      m.settled = true
      this.#update(seg, true)
      return
    }
    let score = null
    if (this.vp && m.span) {
      const gen = this.gen
      score = await this.#score(m.span)
      if (gen !== this.gen || m.settled) return
    }
    if (score != null) seg.vp = score
    else delete seg.vp
    if (score != null && score >= this.#threshold()) return this.#settle(seg, 'me', 'voiceprint')
    if (this.#crosstalk(seg)) return this.#drop(seg)
    if (!m.deferred && this.state === 'running' && this.#systemActive()) {
      m.deferred = true
      m.timer = setTimeout(() => this.#resolveDeferred(seg), DEFER_MS)
      return
    }
    this.#settleUnlike(seg)
  }

  // 不像我、也不是串音：有分数就是对方。太短打不了分的（OK、Sure）：前一段有分数的是我（20 秒内）就跟着算我，
  // 否则按麦克风的默认（平时是我，教室现场是老师）。一问一答时这种短回应多半是听的那个人说的，不跟着对方走。
  #settleUnlike(seg) {
    if (seg.vp != null) return this.#remoteMine(seg.vp) ? this.#settle(seg, 'me', 'remote') : this.#settle(seg, 'other', 'voiceprint')
    if (!this.vp) return this.#settle(seg, this.#defaultWho('mic'), 'no-voiceprint')
    const l = this.lastMicWho
    this.#settle(seg, l?.who === 'me' && Date.now() - l.at < SHORT_FOLLOW_MS ? 'me' : this.#defaultWho('mic'), 'short')
  }

  #resolveDeferred(seg) {
    const m = this.#m(seg)
    if (m.settled) return
    clearTimeout(m.timer)
    if (this.#crosstalk(seg)) this.#drop(seg)
    else this.#settleUnlike(seg)
  }

  // 对方那一路有新字了：还在等的麦克风段再比一次；还在说、已经上屏的麦克风段重合了也藏起来
  #recheckDeferred() {
    for (const seg of this.live.values()) {
      const m = this.meta.get(seg.id)
      if (m?.deferred && !m.settled && this.#crosstalk(seg)) this.#drop(seg)
      else if (m && seg.source === 'mic' && this.micCheck && !seg.final && !m.awaiting && seg.text) this.#hideEcho(seg, m)
    }
  }

  #settle(seg, who, how) {
    const m = this.#m(seg)
    m.settled = true
    clearTimeout(m.timer)
    seg.who = who
    seg.speaker = this.#label(who)
    if (how === 'voiceprint') this.lastMicWho = { who, at: Date.now() }
    debug('mic', who, how, seg.vp, JSON.stringify(seg.text))
    this.emit('trace', { type: 'who', id: seg.id, text: seg.text, who, score: seg.vp ?? null, how })
    this.#update(seg, true)
  }

  // 串音：从实时记录里拿掉，广播一个空文本的定稿让界面删掉这一行
  #drop(seg) {
    const m = this.#m(seg)
    m.settled = true
    clearTimeout(m.timer)
    this.live.delete(seg.id)
    debug('mic', 'crosstalk', seg.vp, JSON.stringify(seg.text))
    this.emit('trace', { type: 'who', id: seg.id, text: seg.text, who: 'dropped', score: seg.vp ?? null, how: 'crosstalk' })
    this.emit('segment', { ...seg, text: '', sentences: [], final: true, dropped: 'crosstalk', droppedText: seg.text })
  }

  #dropStale(id) {
    const seg = this.live.get(id)
    if (!seg || seg.final) return
    const m = this.#m(seg)
    if (m.settled) return
    m.settled = true
    clearTimeout(m.timer)
    this.live.delete(id)
    debug(seg.source, 'revised', JSON.stringify(seg.text))
    this.emit('segment', { ...seg, text: '', sentences: [], final: true, dropped: 'revised', droppedText: seg.text })
  }

  #crosstalk(seg) {
    const since = seg.startedAt - CROSSTALK_WINDOW_MS
    const texts = []
    for (const x of this.live.values()) {
      // 比识别原文：漏进麦克风的那份也是识别出来的，错法差不多
      if (x.source === 'system' && x.text && (this.meta.get(x.id)?.updatedAt ?? x.startedAt) >= since) texts.push(x.orig ?? x.text)
    }
    return isCrosstalk(seg.text, texts)
  }

  // 远程开会（开会、面试，电脑声音里有人说话）时声纹分数不算太低的麦克风段就是我；课堂按原来的判法
  #remoteMine(score) {
    return this.mode !== 'class' && this.systemHeard && score != null && score >= REMOTE_OTHER_MAX
  }

  #systemActive() {
    if (this.pipelines.get('system')?.gate.speaking) return true
    const now = Date.now()
    for (const x of this.live.values()) {
      if (x.source === 'system' && !x.final && now - (this.meta.get(x.id)?.updatedAt ?? 0) < 2500) return true
    }
    return false
  }

  /* ---------------- 存档 ---------------- */

  #persist(seg) {
    if (!seg.text || !this.session) return
    const record = { id: seg.id, source: seg.source, speaker: seg.speaker, who: seg.who, startedAt: seg.startedAt, text: seg.text, sentences: seg.sentences.map(storable) }
    if (seg.orig) record.orig = seg.orig // AI 纠错前的识别原文（text 是纠正后的）
    if (seg.question) record.question = true
    if (seg.vp != null) record.vp = seg.vp
    if (this.state === 'idle') {
      // 会已经停了（停止后才回来的译文）：只改文件里的这一段，别用内存里停止时的旧对象把会后改的标题、纪要、待办盖掉
      this.#patchStored(this.session.id, (s) => upsertSegment(s.segments, record))
      return
    }
    upsertSegment(this.session.segments, record)
    this.store.scheduleSave(this.session)
  }

  // 改已经落盘的会议（store.mutate 读最新的文件再写）；会议被删了或挪走了就算了
  #patchStored(id, fn) {
    try {
      this.store.mutate(id, (s) => {
        s.segments ??= []
        fn(s)
      })
    } catch (e) {
      debug('patch stored session', id, e.message)
    }
  }

  // 答案（包括重新回答）存进这场会议的 answers，会后纪要用；被新问题打断的不存
  #storeAnswer(a) {
    const s = this.session
    if (!s) return
    if (this.pendingAsk && !this.answerSeg.has(a.id)) this.answerSeg.set(a.id, this.pendingAsk.segId)
    if (!a.done || a.startedAt < s.startedAt) return
    s.answers ??= []
    const i = s.answers.findIndex((x) => x.id === a.id)
    if (a.cancelled) {
      if (i >= 0) {
        s.answers.splice(i, 1)
        this.#saveAnswers(s)
      }
      return
    }
    const record = { id: a.id, question: a.question, text: a.text, reason: a.reason, withScreen: a.withScreen, startedAt: a.startedAt, timing: a.timing }
    if (a.hints) record.hints = a.hints
    if (a.trans) record.trans = a.trans
    if (a.error) record.error = a.error
    const segId = this.answerSeg.get(a.id)
    if (segId) record.segId = segId
    if (i >= 0) s.answers[i] = record
    else s.answers.push(record)
    this.#saveAnswers(s)
  }

  // 会已经停了（停之后才答完，或者会后按快捷键）：只改文件里的 answers，别用内存里的旧对象盖掉用户改过的标题
  #saveAnswers(s) {
    if (this.state !== 'idle') return this.store.scheduleSave(s)
    try {
      this.store.update(s.id, { answers: s.answers })
    } catch {}
  }

  /* ---------------- 答题 ---------------- */

  #ordered() {
    return [...this.live.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  // 停顿把问题切成了两段（What is the / best way to roll out…）：前一段没说完、连起来是提问，这段也算提问
  #continuesQuestion(seg) {
    const run = questionRun(this.#ordered(), seg, { maxSegs: 2, endedAt: (x) => this.meta.get(x.id)?.endedAt })
    return run.length === 2 && isCutOff(run[0].text) && isQuestion(`${run[0].text} ${run[1].text}`)
  }

  // 对方还在说、听着已经像提问了：让答题助手先截屏，问完自动答题时省掉截图的时间
  #maybePrefetchScreen(seg) {
    const a = this.cfg?.assist
    if (!this.assistant?.prefetchScreen || !a?.enabled || !a.auto || !withScreen(this.cfg) || this.screenAsked.has(seg.id)) return
    if (!isQuestion(seg.text)) return
    if (this.llmStatus?.()?.ready === false) return
    this.screenAsked.add(seg.id)
    this.assistant.prefetchScreen()
  }

  // 这段定稿要不要自动答题：'ask' 要答，'not-ready' 该答但 AI 用不了（提示一次），null 不答
  #autoAsk(seg) {
    if (!seg.question || !this.assistant || this.askedAt.has(seg.id)) return null
    const a = this.cfg?.assist
    if (!a?.enabled || !a.auto) return null
    const st = this.llmStatus?.()
    return st && !st.ready ? 'not-ready' : 'ask'
  }

  #maybeAsk(seg, ask) {
    if (this.aiLimited) return // 这一场 AI 用量到上限了，不再自动答
    if (ask === 'not-ready') {
      if (!this.assistWarned) {
        this.assistWarned = true
        this.notice('warn', t(`对方在提问，但 AI 答题用不了：{0}`, this.llmStatus?.()?.reason ?? ''), 'assist-llm')
      }
      return
    }
    const run = questionRun(this.#ordered(), seg, { askedAt: this.askedAt, answered: (x) => this.answered.has(x.id), endedAt: (x) => this.meta.get(x.id)?.endedAt })
    this.#ask(run, 'auto')
  }

  // 问题前面的铺垫句一起带上（prompt 里和问题分开写）；上下文是最近 15 分钟的记录（不含问题本身）、实时笔记和术语。
  // matched：认出了问句（没认出时拿的是对方最后的话）
  #ask(run, reason, { matched = true } = {}) {
    const s = this.#conf()
    const now = Date.now()
    for (const x of run) this.askedAt.set(x.id, now)
    const ids = new Set(run.map((x) => x.id))
    const question = run.map((x) => x.text.trim()).join(' ')
    // 铺垫最后一句没说完（What is the）：和问题是同一句话，不分开写
    const lead = run.length > 1 && !isCutOff(run.at(-2).text) ? run.slice(0, -1).map((x) => x.text.trim()).join(' ') : ''
    const transcript = this.#ordered().filter((x) => x.final && x.text && !ids.has(x.id) && now - x.startedAt <= TRANSCRIPT_MS)
    this.emit('trace', { type: 'ask', reason, question, segIds: [...ids] })
    this.pendingAsk = { segId: run.at(-1).id }
    try {
      const p = this.assistant.ask({
        question,
        lead,
        transcript,
        context: s.context,
        profile: s.assist.profile,
        keywords: keywordList(s),
        notes: this.session?.liveNotes ?? null,
        matched,
        withScreen: withScreen(s),
        answerLang: s.assist.answerLang,
        source: s.language,
        noteLang: this.session?.target ?? s.translateTarget,
        mode: this.mode,
        reason,
        segIds: [...ids],
      })
      p?.catch?.(() => {})
    } finally {
      this.pendingAsk = null
    }
    return question
  }

  /** 快捷键：回答对方刚才的问题（最近 90 秒内对方的最后一个问题，没有就拿对方最后两段）。 */
  askLast() {
    if (!this.assistant) return { ok: false, error: t('答题助手没启动') }
    const st = this.llmStatus?.()
    if (st && !st.ready) return { ok: false, error: st.reason }
    // 还没说完的也算：老师刚问出口就按快捷键，那句还在出字
    const segs = this.#ordered().filter((x) => x.text)
    const q = pickLastQuestion(segs)
    if (!q) return { ok: false, error: t('最近 90 秒没有对方说的话') }
    const seg = this.live.get(q.segId)
    const run = q.matched && seg ? questionRun(segs, seg, { answered: (x) => this.answered.has(x.id), endedAt: (x) => this.meta.get(x.id)?.endedAt }) : [{ id: q.segId, text: q.text }]
    if (this.state === 'running') this.#holdEnhance() // 按快捷键答题也让答案先走
    return { ok: true, question: this.#ask(run, 'hotkey', { matched: q.matched }) }
  }

  /** 主窗口点了某一句提问：回答这一句（连同前面紧挨着的铺垫句）。 */
  askSegment(segId) {
    if (!this.assistant) return { ok: false, error: t('答题助手没启动') }
    const st = this.llmStatus?.()
    if (st && !st.ready) return { ok: false, error: st.reason }
    const seg = this.live.get(segId)
    if (!seg?.text) return { ok: false, error: t('找不到这句话（可能是上一场的记录）') }
    const run = seg.final ? questionRun(this.#ordered().filter((x) => x.final && x.text), seg, { answered: (x) => this.answered.has(x.id), endedAt: (x) => this.meta.get(x.id)?.endedAt }) : [seg]
    if (this.state === 'running') this.#holdEnhance()
    return { ok: true, question: this.#ask(run, 'click') }
  }

  /**
   * 回答答完：提问和回答正文（不含中文要点那一行）逐句要译文和意群，答题卡片里像字幕一样一句原文一句彩色译文。
   * 提问里和字幕同一句的直接用字幕的译文；不用排字幕的译文队列，也不要术语和纠错。失败的句子就只有原文。
   */
  async #translateAnswer(a) {
    const s = this.#conf()
    if (!this.llm || !s.translate || this.aiLimited || this.llmStatus?.()?.ready === false) return
    const chunks = s.display?.chunkColors !== false
    const one = async (text) => {
      const known = await this.#captionTr(text)
      if (known) return { text, tr: known.tr, ...(known.chunks ? { chunks: known.chunks } : {}) }
      if (!needsTranslation(text, s.language, s.translateTarget)) return { text }
      const [system, user] = enhanceMessages({ sentence: text, target: s.translateTarget, source: s.language, translate: true, chunks, terms: false, context: s.context, scene: this.mode === 'class' ? 'class' : 'meeting' })
      try {
        const raw = await this.llm({ model: 'fast', system: system.content, messages: [user], effort: 'none', json: true, timeoutMs: enhanceTimeout(text) })
        const p = parseEnhance(raw, text, { correct: false })
        return { text, tr: p.tr, ...(chunks && p.chunks.length ? { chunks: p.chunks } : {}) }
      } catch (e) {
        debug('answer translate', e.message)
        return { text }
      }
    }
    const all = (t) => Promise.all(splitSentences(t, s.language).map(one))
    const [question, body] = await Promise.all([all(a.question), all(splitAnswer(a.text).body)])
    if (![...question, ...body].some((x) => x.tr)) return
    this.assistant.setTrans(a.id, { question, body })
  }

  // 字幕里同一句的译文；那句的译文还在路上就等它回来（最多 20 秒），不重复要
  async #captionTr(text) {
    const find = () => {
      for (const seg of this.live.values()) for (const sen of seg.sentences ?? []) if (sen.text === text) return sen
      return null
    }
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(200)) {
      const sen = find()
      const done = sen?.tr && !sen.trLive && !sen.prov
      if (!sen || done || this.enh.get(rawOf(sen)) !== PENDING) return done ? sen : null
    }
    return null
  }

  /* ---------------- 译文、意群对齐和术语 ---------------- */

  // 只给对方的话做；我的话不翻译也不标术语。重新分句时同一句话的译文、意群、术语照留（译文和意群一起取，免得对不上）。
  // AI 纠错：分句和缓存都按识别原文（段落的 orig，没有就是 text），纠正后的文字只挂在句子上显示；
  // 段落定稿后 seg.text 换成纠正后的整段（syncFixed），纪要、答题、实时笔记、存档都用它，识别原文留在 seg.orig。
  #resplit(seg) {
    const parts = splitSentences(seg.orig ?? seg.text, this.cfg.language)
    const old = seg.sentences
    const mine = seg.who === 'me'
    seg.sentences = parts.map((text) => {
      const sen = { text }
      if (mine) return sen
      const prev = old.find((o) => rawOf(o) === text)
      const c = this.#cached(text)
      const fixed = prev?.orig ? prev.text : c?.fixed
      if (fixed) {
        sen.text = fixed
        sen.orig = text
      }
      // 完整的译文优先；只有半截的（边写边显示）就接着显示，等写完再换。临时译文（prov）不是这句的译文，另由 #showProv 挂回去
      const own = prev?.tr && !prev.prov ? prev : null
      const src = own && !own.trLive ? own : c?.tr ? c : own ? own : c
      if (src?.tr) sen.tr = src.tr
      if (src?.trLive) sen.trLive = true
      if (src?.tr && src.chunks?.length) sen.chunks = src.chunks
      const terms = prev?.terms ?? c?.terms
      if (terms) sen.terms = terms
      return sen
    })
    if (seg.final) syncFixed(seg)
    if (mine) {
      this.meta.get(seg.id)?.provs?.clear() // 这段（原来当成对方的）现在是我的话：不翻译，之前发出的临时译文也不要了
      return
    }
    const m = this.#m(seg)
    const raw = seg.orig ?? seg.text
    this.#showProv(seg)
    // 识别服务说已经定下来的那一截：最后一句完整地落在里面、又以句末标点结尾，就不用等这一段定稿
    const stable = !seg.final && m.stable ? new Set(splitSentences(m.stable, this.cfg.language)) : null
    let at = 0
    seg.sentences.forEach((sen, i) => {
      const r = rawOf(sen)
      const from = raw.indexOf(r, at)
      if (from >= 0) at = from + r.length
      const reason = seg.final ? 'final' : i < parts.length - 1 ? 'next' : stable && this.#stableDone(r, stable) ? 'stable' : null
      if (reason) this.#requestEnhance(r, { segId: seg.id, source: seg.source, endChar: from >= 0 ? at : null, reason, completeAt: m.updatedAt ?? Date.now() })
    })
    if (!seg.final) this.#maybeProvisional(seg, m, raw)
  }

  // 这段里每一句的起点（在识别原文里的第几个字）
  #offsets(seg) {
    const raw = seg.orig ?? seg.text
    let at = 0
    const out = []
    for (const sen of seg.sentences) {
      const r = rawOf(sen)
      const from = raw.indexOf(r, at)
      if (from < 0) continue
      at = from + r.length
      out.push({ sen, from })
    }
    return out
  }

  /**
   * 长句前半先翻：最后一句还没说完，但它已经定稿的部分够长（14 个词 / 28 个字）、里面有逗号这类停顿，
   * 就把最后一个停顿前面的翻出来，挂在这句下面当临时译文。这句的完整译文到了就换掉它。
   * 每句同时只有一个临时译文请求在路上；定稿的部分又多出一个停顿才发下一个。不存档。
   */
  #maybeProvisional(seg, m, raw) {
    const s = this.cfg
    if (!s.translate || this.aiLimited || this.enhFails || !m.stable || !raw.startsWith(m.stable)) return
    const last = this.#offsets(seg).at(-1)
    if (!last || this.enh.has(rawOf(last.sen))) return // 整句已经在翻了
    const st = m.stable.slice(last.from)
    const cjk = isMostlyChinese(st)
    const units = (x) => (cjk ? Array.from(x.replace(/\s/g, '')).length : x.split(/\s+/).filter(Boolean).length)
    if (units(st) < (cjk ? PROV_CHARS : PROV_WORDS)) return
    let cut = -1
    for (const b of st.matchAll(CLAUSE_BREAK)) cut = b.index + (/^[,;:，；：]/.test(b[0]) ? b[0].length : 0)
    if (cut <= 0) return
    const prefix = st.slice(0, cut).trim()
    if (units(prefix) < (cjk ? PROV_MIN_CHARS : PROV_MIN_WORDS) || !needsTranslation(prefix, s.language, s.translateTarget)) return
    m.provs ??= new Map()
    const p = m.provs.get(last.from)
    if (p && (p.busy || prefix.length <= p.src.length)) return
    if (p) p.row.superseded = true
    const row = this.speed.open('prov', prefix, { segId: seg.id, source: seg.source, endChar: last.from + prefix.length, reason: 'prov', completeAt: m.updatedAt ?? Date.now() })
    m.provs.set(last.from, { src: prefix, tr: p?.tr ?? null, busy: true, row })
    this.provQueue.push({ prov: true, text: prefix, translate: true, chunks: false, terms: false, correct: false, gen: this.gen, sessionId: this.session?.id ?? null, row, segId: seg.id, from: last.from })
    this.#pumpEnhance()
  }

  // 把临时译文挂回这段的句子上（句子对象每次重新分句都会重建）。这句已经有自己的译文就不挂，临时译文作废。有变化返回 true
  #showProv(seg) {
    const m = this.meta.get(seg.id)
    if (!m?.provs?.size || seg.who === 'me') return false
    const at = this.#offsets(seg)
    let touched = false
    for (const [from, p] of m.provs) {
      const hit = at.find((x) => x.from === from)
      if (!hit || !rawOf(hit.sen).startsWith(p.src)) {
        m.provs.delete(from) // 这句话已经不是原来那样了（重新分句、被换掉）
        continue
      }
      const sen = hit.sen
      if (sen.tr && !sen.prov) {
        if (!sen.trLive) {
          this.speed.replaced(p.row, sen.tr) // 有完整译文了
          m.provs.delete(from)
        }
        continue // 半截译文在写（trLive）：它写得比临时译文长了才换，见 #flushLive
      }
      if (!p.tr || (sen.prov && sen.tr === p.tr)) continue
      sen.tr = p.tr
      sen.prov = true
      touched = true
    }
    return touched
  }

  // 临时译文请求回来了：这句话还在、前半没变就显示
  #onProv(job, r) {
    const seg = this.live.get(job.segId)
    const p = this.meta.get(job.segId)?.provs?.get(job.from)
    if (!seg || !p || p.src !== job.text) {
      this.speed.fail(job.row, 'discarded')
      return
    }
    p.busy = false
    p.tr = r.tr
    job.row.shown = r.tr
    if (this.#showProv(seg)) {
      this.speed.visible(job.row, true)
      this.emit('segment', seg)
    }
    this.speed.done(job.row)
  }

  // 一句话的完整译文到了，换掉了它的临时译文：记下两边像不像
  #provReplaced(seg, sen, finalTr) {
    const m = this.meta.get(seg.id)
    const hit = this.#offsets(seg).find((x) => x.sen === sen)
    const p = hit && m?.provs?.get(hit.from)
    if (!p) return
    this.speed.replaced(p.row, finalTr)
    m.provs.delete(hit.from)
  }

  // 停止时：所有还挂着的临时译文收回（完整译文没等到的那几句，字幕上不留半句话的译文）
  #clearProv() {
    for (const seg of this.live.values()) {
      const m = this.meta.get(seg.id)
      m?.provs?.clear()
      let touched = false
      for (const sen of seg.sentences ?? []) {
        if (!sen.prov) continue
        delete sen.tr
        delete sen.prov
        touched = true
      }
      if (touched) this.emit('segment', seg)
    }
  }

  // 最后一句在识别服务定下来的字里完整地说完了：句末标点、不是缩写、不止一两个词。
  // 对方在提问时让答题先走（答案的请求排在译文前面），所以问句照旧等这一段定稿
  #stableDone(text, stable) {
    if (!stable.has(text) || !TERMINAL.test(text) || ABBREV.test(text) || MAYBE_UNFINISHED.test(text)) return false
    if (tokenize(text).length < 3 && !isMostlyChinese(text)) return false
    return !(this.cfg.assist?.enabled && isQuestion(text))
  }

  #cached(text) {
    const v = this.enh.get(text)
    if (v === PENDING) return this.enhEarly.get(text) ?? null
    return v ?? null
  }

  // 译文请求失败后等多久再试（单测改小）
  enhBackoffMs = ENH_BACKOFF_MS
  enhRetryMs = ENH_RETRY_MS

  // 翻译开、句子不是目标语言才要译文；要译文且开着意群颜色就要意群对齐；术语开就要术语。都不要就不发请求。
  #requestEnhance(text, why = {}) {
    if (this.enh.has(text)) return
    const s = this.cfg
    const translate = Boolean(s.translate) && needsTranslation(text, s.language, s.translateTarget)
    const chunks = translate && s.display?.chunkColors !== false
    const terms = s.terms?.enabled !== false && worthTerms(text)
    if ((!translate && !terms) || this.aiLimited) {
      this.enh.set(text, null)
      return
    }
    // AI 纠错跟着这次请求一起要（不单独发请求）
    const correct = s.terms?.correct !== false
    this.enh.set(text, PENDING)
    const row = translate ? this.speed.open('final', text, why) : null
    this.enhQueue.push({ text, translate, chunks, terms, correct, gen: this.gen, sessionId: this.session?.id ?? null, row })
    this.#pumpEnhance()
  }

  // 答题优先：对方刚问完、答案还没出第一个字时，新的译文请求先等着（最多 ENH_HOLD_MS），
  // 别和答题请求同时挤在同一个账号上。ChatGPT 通道上已经发出去、还在路上的也先停掉，放回队头，答案出了第一个字再重发：
  // 实测同一账号上有一个译文请求在路上时答题首字中位 1.9 秒，停掉后 1.4 秒（单独答题 1.6 秒）。
  // OpenAI API 通道并发不互相拖，停掉只会白花钱，照常。
  #holdEnhance() {
    clearTimeout(this.enhHoldTimer)
    this.enhHold = true
    this.enhHoldSince = Date.now()
    this.enhHoldTimer = setTimeout(() => this.#releaseEnhance(), ENH_HOLD_MS)
    if (this.cfg?.llmProvider !== 'chatgpt') return
    for (const job of this.enhRunning) {
      job.yielded = true
      job.ctrl.abort(Object.assign(new Error(t('让答题先走')), { code: 'yield' }))
    }
  }

  #releaseEnhance() {
    clearTimeout(this.enhHoldTimer)
    if (!this.enhHold) return
    this.enhHold = false
    this.#pumpEnhance()
  }

  #pumpEnhance() {
    if (this.enhHold || Date.now() < this.enhPauseUntil) return
    // 服务还在出错：一次只发一个试，通了再恢复同时 3 个
    const max = this.enhFails ? 1 : 3
    // 临时译文只用空闲的位置，至少留一个给整句
    while (this.enhActive < max && (this.enhQueue.length || this.enhRetry.length || (this.provQueue.length && this.enhActive < max - 1))) {
      const job = this.enhQueue.shift() ?? this.enhRetry.shift() ?? this.provQueue.shift()
      job.ctrl = new AbortController()
      job.yielded = false
      job.probe = this.enhFails > 0
      this.enhActive++
      this.enhRunning.add(job)
      this.#enhance(job)
        .then((r) => {
          if (job.prov) return job.gen === this.gen ? this.#onProv(job, r) : undefined
          this.#enhanceBack()
          // 已经开了下一场会：只补进上一场的文件，别碰这一场的缓存和实时记录
          if (job.gen !== this.gen) return this.#applyToStored(job.sessionId, job.text, r)
          this.enh.set(job.text, r)
          this.enhEarly.delete(job.text)
          if (job.correct) this.weakWatch?.corrected(job.text, r.fixed ? checkFix(job.text, r.fixed) : null)
          this.#applyEnhance(job.text, r)
          if (r.tr) this.speed.visible(job.row, true)
          this.speed.done(job.row)
          // 网络好了：收回之前的失败提示，再失败时还会提示
          if (this.enhWarned) {
            this.enhWarned = false
            this.notice('clear', '', 'enhance')
          }
        })
        .catch((e) => {
          if (job.gen !== this.gen) return
          // 临时译文失败了不重试、不退避、不提示：这句话的完整译文照常会来
          if (job.prov) {
            const p = this.meta.get(job.segId)?.provs?.get(job.from)
            if (p) p.busy = false
            this.speed.fail(job.row, e.message)
            return
          }
          // 给答题让路停掉的：放回队头，答案出了第一个字再发（已经先到的译文留着，不再重复显示）
          if (job.yielded && this.state === 'running') {
            this.enhQueue.unshift(job)
            this.emit('trace', { type: 'enhance-yield', text: job.text })
            return
          }
          if (job.yielded) {
            this.enh.set(job.text, job.early ?? null)
            this.enhEarly.delete(job.text)
            this.speed.fail(job.row, e.message)
            this.#dropLive(job.text)
            return
          }
          if (e?.code === 'usage-limit') {
            this.enh.set(job.text, job.early ?? null)
            this.enhEarly.delete(job.text)
            this.speed.fail(job.row, e.message)
            this.#dropLive(job.text)
            this.#aiLimit(e)
            return
          }
          // 译文已经先到了、后面的意群和术语断了：留住译文，不算失败
          if (job.early) {
            this.enh.set(job.text, job.early)
            this.enhEarly.delete(job.text)
            this.speed.done(job.row)
            return
          }
          // 限流、服务出错、超时、回复是空的：只要译文（不要意群和术语，快很多），排在新句子后面，所有译文请求先退一会儿
          const tries = (job.tries ?? 0) + (job.probe ? 0 : 1)
          if (job.translate && e?.retryable && this.state === 'running' && tries < ENH_TRIES) {
            this.enhRetry.push({ ...job, tries, retried: true, chunks: false, terms: false, correct: false })
            this.#backoff(e)
            return
          }
          // 别的错（请求被拒这类）：过一会儿只要译文再试一次
          if (job.translate && !job.retried && !e?.retryable && this.state === 'running') {
            this.emit('trace', { type: 'enhance-retry', text: job.text, error: e.message })
            setTimeout(() => {
              if (job.gen !== this.gen) return
              this.enhQueue.push({ ...job, retried: true, chunks: false, terms: false, correct: false })
              this.#pumpEnhance()
            }, this.enhRetryMs)
            return
          }
          this.enh.set(job.text, null)
          this.enhEarly.delete(job.text)
          this.speed.fail(job.row, e.message)
          this.#dropLive(job.text)
          // 会员场次用完的 402 另有「场次用完」的提示，这里不再报；自带 Key 余额不足的 402 要报
          const memberOut = e.status === 402 && this.cfg?.llmProvider === 'member'
          if (!this.enhWarned && !memberOut) {
            this.enhWarned = true
            this.notice('warn', t(`{0}失败：{1}`, job.translate ? t('翻译') : t('术语解释'), e.message), 'enhance')
          }
        })
        .finally(() => {
          this.#endLive(job)
          this.enhActive--
          this.enhRunning.delete(job)
          this.#pumpEnhance()
        })
    }
  }

  // 可重试的失败：所有译文请求先停一会儿（同一波同时失败的只算一次），之后一次只发一个试；连着不通就停得更久
  #backoff(e) {
    if (Date.now() < this.enhPauseUntil) return
    const ms = this.enhBackoffMs[Math.min(this.enhFails, this.enhBackoffMs.length - 1)]
    this.enhFails++
    this.enhPauseUntil = Date.now() + ms
    clearTimeout(this.enhPauseTimer)
    this.enhPauseTimer = setTimeout(() => {
      this.enhPauseUntil = 0
      this.#pumpEnhance()
    }, ms)
    this.emit('trace', { type: 'enhance-retry', error: e.message, fails: this.enhFails, waitMs: ms })
    // 试了一次还不通：告诉用户在等，通了会补上（通了就收回）
    if (this.enhFails === 2 && !this.enhWarned) {
      this.enhWarned = true
      this.notice('warn', t('翻译暂时失败，正在重试，恢复后会补上：{0}', e.message), 'enhance')
    }
  }

  // 有请求成功了：服务恢复，排着的（包括失败等着重发的）全速接着发
  #enhanceBack() {
    if (!this.enhFails && !this.enhPauseUntil) return
    this.enhFails = 0
    this.enhPauseUntil = 0
    clearTimeout(this.enhPauseTimer)
  }

  // 排着的译文请求不发了（停止时等过了、开新的一场）
  #dropEnhanceQueue() {
    for (const job of [...this.enhQueue, ...this.enhRetry]) {
      if (this.enh.get(job.text) !== PENDING) continue
      this.enh.set(job.text, null)
      this.#dropLive(job.text) // 第一次发出去写了一半又失败、等着重发的：重发不会来了，半截译文收回
    }
    this.enhQueue = []
    this.enhRetry = []
    this.provQueue = []
    this.#enhanceBack()
  }

  // 这一场的 AI 用量到上限了（会员这一场的 token 上限、ChatGPT 套餐额度）：这一场不再发译文和实时笔记的请求，提示一次
  #aiLimit(e) {
    if (this.aiLimited || this.state === 'idle') return
    this.aiLimited = true
    this.#dropEnhanceQueue()
    this.notes?.halt(e)
    // 会员场次用完（402）另有提示
    if (e.status === 402 && this.cfg?.llmProvider === 'member') return
    this.notice('warn', t('翻译和实时笔记这一场先停了：{0}', e.message), 'ai-limit')
  }

  // 要意群、术语或纠错时走 enhance（一次拿译文、纠正后的句子、意群对齐和术语，JSON）；只要译文时用原来的翻译 prompt，快一点
  async #enhance(job) {
    const { text, translate, chunks, terms, correct } = job
    if (!this.llm) throw new Error(t('没接 AI 服务'))
    const st = this.llmStatus?.()
    if (st && !st.ready) throw new Error(st.reason)
    const s = this.cfg
    const previous = (this.session?.segments ?? []).slice(-3).map((x) => x.text)
    const args = { sentence: text, previous, target: s.translateTarget, source: s.language, context: s.context, keywords: keywordList(s) }
    const t0 = Date.now()
    job.live = null // 重试时重新开始
    job.finished = false
    this.speed.sent(job.row)
    const onUsage = process.env.MEETCAPTION_SPEED_USAGE ? (u) => this.speed.usage(job.row ?? { kind: 'final' }, u) : undefined
    let r
    let fixDropped = null
    if (job.prov) {
      const [system, user] = translateMessages({ ...args, partial: true })
      const tr = await this.llm({ model: 'fast', system: system.content, messages: [user], effort: 'none', timeoutMs: enhanceTimeout(text), signal: job.ctrl?.signal, onUsage })
      r = { tr: noDashes(String(tr ?? '')).trim().replace(/[。.，,；;：:]+$/, '') } // 句末的标点去掉，字幕上由省略号表示后面还没说完
      if (!r.tr) throw emptyReply()
      return r
    }
    if (!terms && !chunks && !correct) {
      const [system, user] = translateMessages(args)
      // 流式收：译文一个字一个字显示出来
      const onDelta = (full) => {
        this.speed.first(job.row)
        this.#onLiveTr(job, noDashes(full).trim())
      }
      const tr = await this.llm({ model: 'fast', system: system.content, messages: [user], effort: 'none', timeoutMs: enhanceTimeout(text), signal: job.ctrl?.signal, onDelta, onUsage })
      r = { tr: noDashes(String(tr ?? '')).trim() }
      if (!r.tr) throw emptyReply()
    } else {
      const [system, user] = enhanceMessages({ ...args, translate, chunks, terms, correct, scene: this.mode === 'class' ? 'class' : 'meeting' })
      // 流式收：JSON 开头的译文（开着纠错时连同前面纠正后的句子）一收全就先显示（ChatGPT 通道上整个 JSON 要 3 到 10 秒，译文 1.5 到 2 秒就齐了）
      const onDelta = translate
        ? (full) => {
            this.speed.first(job.row)
            if (job.early) return
            const h = streamedHead(full)
            if (!h.tr) return this.#onLiveTr(job, streamedPartial(full))
            const fix = correct ? checkFix(text, h.fixed) : null
            job.early = fix?.ok ? { tr: h.tr, fixed: fix.fixed } : { tr: h.tr }
            job.trMs = Date.now() - t0
            this.#onEarlyTr(job, job.early)
          }
        : undefined
      const raw = await this.llm({ model: 'fast', system: system.content, messages: [user], effort: 'none', json: true, timeoutMs: enhanceTimeout(text) + 10_000, onDelta, signal: job.ctrl?.signal, onUsage })
      const p = parseEnhance(raw, text, { correct })
      // 要译文却没拿到（回复是空的或不是 JSON，DeepSeek 的 JSON 模式偶尔这样）：流式先到的译文就用它，没有就算失败，走重试
      const early = translate && !p.tr ? job.early : null
      if (translate && !p.tr && !early) throw emptyReply()
      r = {}
      if (p.fixed ?? early?.fixed) r.fixed = p.fixed ?? early.fixed
      if (p.fixDropped) fixDropped = p.fixDropped
      if (translate) {
        r.tr = p.tr || early.tr
        if (chunks) r.chunks = p.chunks
      }
      if (terms) r.terms = translate ? p.terms : p.terms.map(({ term, explain }) => ({ term, explain }))
    }
    // 意群覆盖率和「中文那边没标出来的术语」数：看模型守不守规矩（覆盖率低于 70% 的句子多了就该改 prompt）
    const coverage = r.chunks ? Math.round(chunkCoverage(r.fixed ?? text, r.chunks) * 100) / 100 : null
    const termsNoZh = translate && r.terms ? r.terms.filter((x) => !x.zh).length : null
    this.emit('trace', { type: 'enhance', text, translate, chunks, terms, correct, ms: Date.now() - t0, trMs: job.trMs ?? null, chunkCount: r.chunks?.length ?? null, coverage, termsNoZh, fixed: r.fixed ?? null, fixDropped })
    return r
  }

  // 译文还在写：把写出来的这一截挂到句子上显示（不存档，写完由 mergeEnhance 换成完整的）。最多每 LIVE_MS 刷新一次，第一个字马上显示
  #onLiveTr(job, text) {
    if (!text || job.early || job.gen !== this.gen || text === job.live) return
    job.live = text
    const wait = (job.liveAt ?? 0) + LIVE_MS - Date.now()
    if (wait <= 0) return this.#flushLive(job)
    job.liveTimer ??= setTimeout(() => this.#flushLive(job), wait)
  }

  #flushLive(job) {
    clearTimeout(job.liveTimer)
    job.liveTimer = null
    if (job.finished || job.early || job.gen !== this.gen || !job.live) return
    job.liveAt = Date.now()
    let shown = false
    for (const seg of this.live.values()) {
      if (seg.who === 'me') continue
      let touched = false
      for (const sen of seg.sentences) {
        if (rawOf(sen) !== job.text || (sen.tr && !sen.trLive && !sen.prov) || sen.tr === job.live) continue
        // 已经显示的更长（临时译文，或让路、失败后重发前写出来的半截）：等这次写到那么长再换，别往回缩
        if ((sen.prov || sen.trLive) && job.live.length < sen.tr.length) continue
        sen.tr = job.live
        sen.trLive = true
        delete sen.prov
        touched = true
      }
      if (touched) {
        shown = true
        this.emit('segment', seg)
      }
    }
    if (shown) this.speed.visible(job.row, false)
  }

  // 这句的请求彻底失败了：已经显示出来的半截译文收回
  #dropLive(text) {
    for (const seg of this.live.values()) {
      let touched = false
      for (const sen of seg.sentences ?? []) {
        if (rawOf(sen) !== text || !sen.trLive) continue
        delete sen.tr
        delete sen.trLive
        touched = true
      }
      if (touched) this.emit('segment', seg)
    }
  }

  // 请求结束了（成功、失败、让路）：不再有半截译文要刷
  #endLive(job) {
    job.finished = true
    clearTimeout(job.liveTimer)
    job.liveTimer = null
  }

  // 译文先到：先挂到句子上显示出来（纠正后的句子也一起），意群颜色和术语等整个回复到了再补（mergeEnhance 会把译文和意群一起换成完整的）
  #onEarlyTr(job, early) {
    if (job.gen !== this.gen) return
    this.enhEarly.set(job.text, early)
    this.#applyEnhance(job.text, early)
    this.speed.visible(job.row, true)
  }

  #applyEnhance(text, r) {
    for (const seg of this.live.values()) {
      if (seg.who === 'me') continue
      let touched = false
      for (const sen of seg.sentences) {
        if (rawOf(sen) !== text) continue
        const hadProv = r.tr && (sen.prov || sen.trLive)
        if (!mergeEnhance(sen, r)) continue
        touched = true
        if (hadProv) this.#provReplaced(seg, sen, r.tr)
      }
      if (!touched) continue
      if (seg.final && r.fixed) {
        syncFixed(seg)
        this.notes?.revise(seg) // 还没交给实时笔记的这段换成纠正后的文字
      }
      this.emit('segment', seg)
      if (seg.final) this.#persist(seg)
    }
  }

  // 上一场会的译文晚到了：直接补进它的 session.json
  #applyToStored(sessionId, text, r) {
    if (!sessionId || !r) return
    this.#patchStored(sessionId, (s) => {
      for (const seg of s.segments) {
        if (seg.who === 'me') continue
        let fixed = false
        for (const sen of seg.sentences ?? []) if (rawOf(sen) === text && mergeEnhance(sen, r) && r.fixed) fixed = true
        if (fixed) syncFixed(seg)
      }
    })
  }

  /* ---------------- 停止 ---------------- */

  async stop() {
    if (this.state === 'starting') {
      // 还在连接：让 start() 在下一个 await 之后自己收拾（它只删自己新建的会议），这里等它走完
      this.abortStart = true
      this.#setState('stopping')
      await this.#teardown()
      await this.starting?.catch(() => {})
      if (this.state !== 'idle') this.#setState('idle')
      return
    }
    if (this.state !== 'running') return
    this.#setState('stopping')
    await this.pauseOp?.catch(() => {})
    await this.#teardown()
    this.#stopNotes()
    this.#finishOpen()
    await this.#settleScoring()
    if (this.paused) this.#endPause()
    this.paused = false
    const session = this.session
    if (session) {
      session.endedAt = Date.now()
      // 译文可能还在路上、还在排队，等一小会儿再落盘（服务在出错、退着的时候不等排队的）；还没发出去的就不发了
      this.provQueue = [] // 临时译文不等了
      const deadline = Date.now() + this.enhanceWaitMs
      const waiting = () => this.enhActive > 0 || (!this.enhFails && this.enhQueue.length + this.enhRetry.length > 0)
      while (waiting() && Date.now() < deadline) await sleep(200)
      this.#dropEnhanceQueue()
      this.#clearProv()
      this.store.saveNow(session)
      this.#traceSpeed()
    }
    this.#setState('idle', { lastSessionId: session?.id ?? null })
    // 停止后把最后一段内容整理进实时笔记（不挡着停止，写回文件由 #onNotes 做；退出应用前主进程等它）
    if (this.notes) {
      const p = this.notes
        .flush()
        .catch(() => {})
        .finally(() => {
          if (this.notesFlush === p) this.notesFlush = null
        })
      this.notesFlush = p
      this.notes = null
    }
  }

  // 还没定稿的收尾（停止、暂停时）：先收对方的，麦克风段判串音要用
  #finishOpen() {
    const rest = [...this.live.values()].filter((x) => !x.final).sort((a, b) => (a.source === 'system' ? 0 : 1) - (b.source === 'system' ? 0 : 1))
    for (const seg of rest) {
      const m = this.#m(seg)
      if (m.settled || !this.live.has(seg.id)) continue
      if (m.deferred) this.#resolveDeferred(seg)
      else if (!seg.text || m.awaiting) continue
      else if (seg.source === 'mic' && this.micCheck) {
        m.awaiting = true
        this.#track(this.#decideMic(seg, m))
      } else this.#update(seg, true)
    }
  }

  /* ---------------- 暂停 / 继续 ---------------- */

  /**
   * 暂停：关掉采集（麦克风灯灭）和识别连接（云端识别不再计费），没说完的话收尾定稿；会议、实时笔记、答题都留着。
   * 继续：重新连识别、开采集，接着记在同一场会议里。暂停的时间段记在 session.pauses。
   */
  pause() {
    if (this.state !== 'running' || this.paused) return this.pauseOp ?? Promise.resolve()
    this.paused = true
    const op = (async () => {
      await this.pauseOp?.catch(() => {})
      this.#emitPause()
      this.#stopWatchdog()
      clearInterval(this.filler)
      this.#stopCapture()
      await Promise.all([...this.pipelines.values()].map((p) => p.provider.close().catch(() => {})))
      this.pipelines.clear()
      this.#finishOpen()
      await this.#settleScoring()
      const s = this.session
      if (s && this.state === 'running') {
        s.pauses ??= []
        s.pauses.push({ at: Date.now(), until: null })
        this.store.scheduleSave(s)
      }
    })()
    this.pauseOp = op.finally(() => {
      if (this.pauseOp === op) this.pauseOp = null
    })
    return this.pauseOp
  }

  resume() {
    if (this.state !== 'running' || !this.paused) return this.pauseOp ?? Promise.resolve()
    const op = (async () => {
      await this.pauseOp?.catch(() => {})
      if (this.state !== 'running' || !this.paused) return
      const s = this.cfg
      try {
        this.#buildPipelines(s)
        await Promise.all([...this.pipelines.values()].map((p) => p.provider.connect()))
        if (this.state !== 'running') return
        this.paused = false
        await this.#startCapture(s)
      } catch (e) {
        // 连不上（断网、设备没了）：还是暂停着，提示原因，可以再点继续
        this.#stopCapture()
        await Promise.all([...this.pipelines.values()].map((p) => p.provider.close().catch(() => {})))
        this.pipelines.clear()
        this.paused = true
        this.notice('error', t(`没能继续记录：{0}`, e.message), 'resume')
        this.#emitPause()
        return
      }
      if (this.state !== 'running') return
      this.#endPause()
      this.notice('clear', '', 'resume')
      this.#startSilenceFiller()
      this.#emitPause()
    })()
    this.pauseOp = op.finally(() => {
      if (this.pauseOp === op) this.pauseOp = null
    })
    return this.pauseOp
  }

  #endPause() {
    const s = this.session
    const last = s?.pauses?.at(-1)
    if (!last || last.until) return
    last.until = Date.now()
    this.store.scheduleSave(s)
  }

  #emitPause() {
    this.emit('pause', { paused: this.paused, sessionId: this.session?.id ?? null })
  }

  #stopCapture() {
    this.fakeCapture?.stop()
    this.macTap?.stop()
    this.macTap = null
    // 只停自己开的采集窗口（声纹录制、声音测试也用同一个 RendererCapture）
    if (this.captureStarted) this.rendererCapture?.stop(this.captureToken)
    this.captureStarted = false
    this.captureToken = null
  }

  async #teardown() {
    this.#stopWatchdog()
    clearInterval(this.filler)
    this.#stopNotes()
    this.#stopCapture()
    const closing = [...this.pipelines.values()].map((p) => p.provider.close().catch(() => {}))
    await Promise.all(closing)
    this.pipelines.clear()
    this.#releaseEnhance() // 收尾时补的译文不用再给答题让路，排着的接着发（停止时等它们落盘）
  }
}
