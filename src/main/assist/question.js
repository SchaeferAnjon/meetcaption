// 判断一句定稿字幕是不是在向我提问，决定要不要自动出答案。宁可漏判也别把陈述句当问题。

/* ---------------- 英文 ---------------- */

const EN_FILLER =
  /^(?:(?:so|okay|ok|well|and|but|now|alright|all right|right|then|um+|uh+|hmm+|yeah|yes|great|cool|sure|good|nice|also|next|first|finally|maybe|actually|anyway|basically|please|and then|so then)\b[\s,.]*)+/i

const AUX =
  "(?:is|are|was|were|am|does|did|can|could|would|will|should|shall|may|might|must|has|isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|couldn't|wouldn't|won't|shouldn't|haven't|hasn't)"
const AUX_ALL = `(?:${AUX.slice(3, -1)}|do|have|had)`
const PRON = '(?:you|we|i|they|he|she|it|there|anyone|anybody|someone|somebody|everyone|everybody|people)'
const DET = '(?:this|that|these|those|the|your|our|my|their|his|her|its|any|a|an)'

// 疑问词后面直接跟助动词：What is / How do / Why did / Who's
const EN_WH_AUX = new RegExp(`^(?:what|why|how|when|where|who|whom|whose|which)(?:'s|'re|'d|'ve|'ll|\\s+${AUX_ALL}\\b)`, 'i')
// What / Which / How + 一个非代词 + 助动词：What part did you / How long does it / Which baseline is
const EN_WH_WORD_AUX = new RegExp(`^(?:what|which|whose|how)\\s+(?!${PRON}\\b|this\\b|that\\b|[a-z]+ed\\b)[a-z'-]+\\s+${AUX_ALL}\\b`, 'i')
// 疑问词后面的固定搭配：How about / Why not / What else / How come
const EN_WH_PHRASE =
  /^(?:how (?:about|come|so)|what (?:happens|would happen|will happen)\b(?! is\b)|why (?:not|so)|what (?:about|else|if|kind of|sort of|type of|exactly)|what (?:made|makes|led|leads|brought|brings|motivated|drew|draws) you\b|which\b|who (?!knows|cares|wants|needs)\w+)/i
// 看着像疑问句其实是陈述：Which is why / Which means / What happens is
const EN_WHICH_CLAUSE = /^which (?:is|was) (?:why|how|what)|^which (?:means|makes)\b|^what (?:happens|happened|matters|worked|works) (?:is|was)\b/i
// 强调句：What's also really important is that… / What's interesting here is…（没有问号时是陈述）
const EN_CLEFT =
  /^what(?:'s|\s+is|\s+was)\s+(?:(?:also|really|very|most|more|so|super|even|actually|kind of|pretty|um+|uh+)[\s,]+)*(?:important|interesting|key|crucial|essential|nice|cool|good|bad|great|surprising|funny|weird|clear|missing|happening|needed|left|new|different|tricky|hard|difficult|easy|cool)\b/i
// 助动词开头 + 主语：Is this / Can we / Did the model。do / have 开头只认人称主语，避开 Do it now、Have a look。
const EN_AUX_SUBJECT = new RegExp(`^${AUX}\\s+(?:not\\s+)?(?:${PRON}|${DET})\\b`, 'i')
const EN_DO_HAVE = /^(?:do|have|had)\s+(?:not\s+)?(?:you|we|i|they|he|she|there|anyone|anybody|someone|somebody|everyone|people)\b/i
// 祈使式提问，出现在句首或 can you / could you / please 后面
const EN_PROMPT = new RegExp(
  '^(?:(?:can|could|would|will) you (?:please )?|please )?(?:' +
    [
      'tell (?:me|us)\\b',
      '(?:walk|talk|take|run) (?:me|us) through',
      'explain\\b',
      'describe\\b',
      'elaborate\\b',
      'clarify\\b',
      'summarize\\b',
      'justify\\b',
      'introduce yourself',
      'give (?:me|us) (?:an? |some )?(?:example|examples|overview|summary|idea|sense|rundown)',
      'share (?:with (?:me|us) )?(?:your|some) (?:thoughts|experience|view|views|opinion|perspective|approach|reasoning)',
      'help (?:me|us) understand',
      'say (?:more|a bit more|a little more)',
    ].join('|') +
    ')',
  'i',
)
// 会上的事务性请求，形式是 Could you / Can you，但不是要我回答的问题：Could you share your screen / Can you hear me now
const EN_REQUEST = new RegExp(
  '^(?:(?:can|could|would|will) (?:you|everyone|everybody) (?:please )?|please )(?:' +
    [
      'share (?:your|the|my) screen',
      'stop sharing',
      'hear me',
      'see my screen',
      'see (?:it|this|that|everything)(?: (?:now|ok|okay))?[?.!\\s]*$',
      'send (?:me|us|it|that|this|the)\\b',
      'mute',
      'unmute',
      'turn (?:on|off) (?:your|the) (?:camera|video|mic|microphone)',
      'speak up',
      'repeat (?:that|it|the question)',
      'say (?:it|that) again',
      'scroll',
      'zoom (?:in|out)',
      'go back to',
    ].join('|') +
    ')',
  'i',
)

// 句中带出的提问：I'd like to hear / I'm curious / I was wondering / what do you think
const EN_INNER =
  /\b(?:i(?:'d| would) (?:like|love) (?:to (?:hear|know|understand)|you to (?:explain|tell|walk|describe|talk))|i (?:want|wanted) to (?:know|hear|understand)|i(?:'m| am) (?:curious|wondering)|i was wondering|i wonder (?:if|whether|why|how|what)|what do you think|what(?:'s| is) your (?:take|view|opinion|thinking|understanding)|any (?:thoughts|questions|comments|ideas)\b|do you (?:mind|know|think|have)\b)/i

const EN_BACKCHANNEL =
  /^(?:really|right|sorry|pardon|what|huh|okay|ok|yes|yeah|no|hello|hi|hey|is it|are you sure|you know|got it|makes sense|see|and|so|why not|isn't it|correct|true|is that right|is that so|does that make sense|you see|am i right|can you hear me|can you see my screen|can you see it|can everyone see|are you there|is that okay|is that ok)$/i

function englishSentenceIsQuestion(raw) {
  const s = raw.replace(/["“”'’)\]]+$/u, '').trim()
  const words = s.replace(/[^\p{L}\p{N}'\s-]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  const bare = words.join(' ')
  if (!bare) return false
  if (words.length <= 2 && !/^(?:why|how)\b/i.test(bare)) return false
  if (EN_BACKCHANNEL.test(bare.replace(EN_FILLER, ''))) return false
  const core = s.replace(EN_FILLER, '').replace(/^[\s,]+/, '')
  if (EN_REQUEST.test(core)) return false
  if (/\?$/.test(s)) return true
  if (!EN_WHICH_CLAUSE.test(core) && !EN_CLEFT.test(core) && (EN_WH_AUX.test(core) || EN_WH_WORD_AUX.test(core) || EN_WH_PHRASE.test(core))) return true
  if (EN_AUX_SUBJECT.test(core) || EN_DO_HAVE.test(core)) return true
  if (EN_PROMPT.test(core)) return true
  return EN_INNER.test(s)
}

/* ---------------- 中文 ---------------- */

const ZH_FILLER = /^(?:(?:嗯+|啊+|哦+|噢|呃+|额|好的?|对|那么?|然后|所以|okay|ok)[，,、\s]*)+/i
const ZH_PROMPT =
  /(?:介绍一下|介绍下|讲讲|讲一下|讲一讲|说说|说一下|说一说|谈谈|谈一下|聊聊|解释一下|解释下|展开讲|展开说|详细说|具体说说|举个例子|举一个例子|你觉得|您觉得|你认为|您认为|你怎么看|您怎么看|你的看法|你的想法|请问|我想知道|我很好奇|想听听|给我讲|跟我讲|跟我说说)/
// 这些搭配里的疑问词不表示提问，先删掉再判断
const ZH_NOT_QUESTION = [
  /(?:这就是|这也是|那就是|那也是|这正是|这才是)为什么/g,
  /(?:没|不|无论|不论|不管)[一-鿿]{0,3}?(?:什么|怎么|怎样|如何|为什么|为啥|哪|谁|多少)/g,
  /(?:什么都|什么的|怎么说呢|怎么样都|怎样都|怎么都|随便|多少有点|多多少少|或多或少|谁都|哪儿都|哪里都|哪都)/g,
]
const ZH_WH = /(?:什么|怎么|为什么|为啥|干嘛|怎样|如何|哪个|哪些|哪里|哪儿|哪种|哪一|谁|多少|多久|多长|几点|啥)/
const ZH_ANOTB = /(?:能不能|可不可以|可以不可以|是不是|有没有|会不会|要不要|对不对|好不好|行不行|算不算|需不需要|愿不愿意|想不想|用不用|该不该)/
const ZH_TAIL = /(?:吗|嘛|么)[\s。.!！…]*$/
const ZH_TAIL_NE = /呢[\s。.!！…]*$/
const ZH_BACKCHANNEL = /^(?:真的吗|是吗|对吗|好吗|行吗|可以吗|是不是|对不对|好不好|行不行|什么|啥|怎么了|然后呢|是吧|对吧|好吧|没问题吧|明白吗|懂吗|清楚吗)$/

const CJK = /[一-鿿]/g
const cjkCount = (s) => (s.match(CJK) ?? []).length

function chineseSentenceIsQuestion(raw) {
  const s = raw.trim()
  const bare = s.replace(/[\s\p{P}]/gu, '')
  if (!bare || ZH_BACKCHANNEL.test(s.replace(ZH_FILLER, '').replace(/[\s\p{P}]/gu, ''))) return false
  if (cjkCount(bare) < 3) return false
  if (/[?？]\s*$/.test(s)) return true
  if (ZH_PROMPT.test(s)) return true
  let cleaned = s
  for (const re of ZH_NOT_QUESTION) cleaned = cleaned.replace(re, '，')
  if (ZH_TAIL.test(cleaned)) return true
  // 「呢」结尾的陈述句也不少（我还在想呢），只认短句：那你呢、baseline 呢
  if (ZH_TAIL_NE.test(cleaned) && bare.length <= 8) return true
  if (ZH_ANOTB.test(cleaned)) return true
  return ZH_WH.test(cleaned)
}

/* ---------------- 入口 ---------------- */

function isChineseSentence(text) {
  return cjkCount(text) / Math.max(text.replace(/[\s\p{P}]/gu, '').length, 1) > 0.3
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?。！？])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 是不是在提问。只看最后两句：长段发言中间的设问不算。 */
export function isQuestion(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return false
  return splitSentences(t)
    .slice(-2)
    .some((s) => (isChineseSentence(s) ? chineseSentenceIsQuestion(s) : englishSentenceIsQuestion(s)))
}

/**
 * 从最近的段落里挑「刚才的问题」，给手动快捷键用。
 * segments: [{ id, who, source, text, startedAt }]，按时间排。
 * 先找最近 90 秒内对方的最后一个问题；没有就取对方最后两段拼起来。
 */
export function pickLastQuestion(segments, { now = Date.now(), windowMs = 90_000 } = {}) {
  const other = (segments ?? []).filter((s) => s?.text?.trim() && (s.who ? s.who === 'other' : s.source !== 'mic'))
  if (!other.length) return null
  const recent = other.filter((s) => !s.startedAt || now - s.startedAt <= windowMs)
  const pool = recent.length ? recent : other.slice(-2)
  for (let i = pool.length - 1; i >= 0; i--) {
    if (isQuestion(pool[i].text)) return { text: pool[i].text.trim(), segId: pool[i].id, matched: true }
  }
  return { text: pool.slice(-2).map((s) => s.text.trim()).join(' '), segId: pool.at(-1).id, matched: false }
}
