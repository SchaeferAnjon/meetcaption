// 判断一句定稿字幕是不是在向我提问，决定要不要自动出答案。宁可漏判也别把陈述句当问题。

/* ---------------- 英文 ---------------- */

const EN_FILLER =
  /^(?:(?:so|okay|ok|well|and|but|now|alright|all right|right|then|um+|uh+|hmm+|yeah|yes|great|cool|sure|good|nice|also|next|first|finally|maybe|actually|anyway|basically|please|and then|so then|hello|hi|hey)\b[\s,.]*)+/i

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
  /^(?:how (?:about|come|so)|what (?:happens|would happen|will happen)\b(?! is\b)|why (?:not|so)|what (?:about|else|if|kind of|sort of|type of|exactly)|what (?:made|makes|led|leads|brought|brings|motivated|drew|draws) you\b|which of (?!course\b)|who (?!knows|cares|wants|needs)\w+)/i
// Which + 名词：Which baseline performs better。识别常把从句断成 which 开头的一句（which comes up automatically / which I think is fine），
// 后面是动词（-s、-ed、助动词）、代词、副词的不算
const EN_WHICH_NOUN = new RegExp(
  `^which\\s+(?!(?:[a-z]+s|[a-z]+ed|[a-z]+ly|${AUX_ALL.slice(3, -1)}|${PRON.slice(3, -1)}|me|us|then|also|just|still|now|already|again|never|always|often|led|came|went|made|took|gave|got|meant|became|left|kept|ran)\\b)[a-z]+\\b`,
  'i',
)
// 看着像疑问句其实是陈述：Which is why / Which means / What happens is
const EN_WHICH_CLAUSE = /^which (?:is|was) (?:why|how|what)|^which (?:means|makes)\b|^what (?:happens|happened|matters|worked|works) (?:is|was)\b/i
// 强调句：What's also really important is that… / What's interesting here is…（没有问号时是陈述）
const EN_CLEFT =
  /^what(?:'s|\s+is|\s+was)\s+(?:(?:also|really|very|most|more|so|super|even|actually|kind of|pretty|um+|uh+)[\s,]+)*(?:important|interesting|key|crucial|essential|nice|cool|good|bad|great|surprising|funny|weird|clear|missing|happening|needed|left|new|different|tricky|hard|difficult|easy|cool)\b/i
// What I mean is / What we did was：主语 + 动词 + is/was，也是陈述
const EN_PSEUDO_CLEFT = /^what (?:i|we|you|they|he|she)\b(?:\s+[a-z'-]+){1,3}\s+(?:is|was)\b/i
// 识别给强调句也加了问号（What's important is that you think out loud?）：后面还有 is / was 的才算陈述，What's important to you? 照样是提问
const statementDespiteMark = (core) =>
  EN_WHICH_CLAUSE.test(core) || EN_PSEUDO_CLEFT.test(core) || (EN_CLEFT.test(core) && /\b(?:is|was)\b/i.test(core.replace(EN_CLEFT, '')))
// 停顿把一句话切断了：What is the / Can you tell me about your
const EN_DANGLING = /\b(?:the|a|an|and|or|but|your|my|our|their)$/i
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
// 附和、道谢、打招呼：拼问题时不当铺垫
const EN_ACK =
  /^(?:(?:that|it|this) (?:makes sense|sounds good|is great|is fine|works)|sounds good|thank you(?: very much| so much)?|thanks(?: a lot| so much)?|perfect|awesome|i see|fair enough|no problem|all good|good (?:morning|afternoon|evening)(?: everyone| all)?|(?:hello|hi|hey) (?:everyone|everybody|all|guys|there))$/i

/* ---------------- 德文 ---------------- */

const DE_FILLER = /^(?:(?:also|ja|gut|okay|ok|so|na|nun|und|dann|genau|super|prima|schön)\b[\s,.]*)+/i
// W 开头，中间一两个词，再跟主语：Was denken Sie / Wie lange arbeiten Sie / Was ist Ihre。紧跟主语的（Was wir gemacht haben）是从句
const DE_WH =
  /^(?:was|wie|warum|wieso|weshalb|wann|wo|woher|wohin|wer|wen|wem|welche[rsmn]?)\s+(?:\p{L}+\s+){1,2}(?:sie|du|ihr|ihre[mnrs]?|dein(?:e[mnrs]?)?|wir|man|es|das|der|die|den|dem|dies(?:e[mnrs]?)?)\b/iu
// 动词开头 + 您 / 你：Haben Sie / Können Sie / Erzählen Sie mal。Haben wir gemacht 这种省了主语的陈述不算
const DE_V1 =
  /^(?:(?:haben|hast|habt|sind|bist|seid|können|kannst|könnt|könnten|könntest|würden|würdest|wollen|willst|wollt|möchten|möchtest|sollten|dürfen|werden|wirst|hatten|hattest|waren|warst|arbeiten|arbeitest|kennen|kennst|denken|denkst|glauben|glaubst|finden|findest|erzählen|beschreiben|erklären|schildern|nennen|geben)\s+(?:sie|du|ihr)|(?:erzähl|beschreib|erklär|gib|nenn|zeig)\s+(?:mir|uns))\b/i
const DE_REQUEST =
  /bildschirm\s+(?:teilen|freigeben)|(?:hören|versteh(?:en|t))\s+(?:sie|ihr|du)\s+mich|mich\s+(?:hören|verstehen)|(?:sehen|seht|siehst)\s+(?:sie|ihr|du)\s+(?:meinen|den)\s+bildschirm|stumm|wiederholen|noch ?mal sagen/i
const DE_BACKCHANNEL =
  /^(?:wirklich|echt|ja|nein|genau|okay|ok|richtig|stimmt|oder|na ja|ach so|alles klar|ist das so|stimmt das|nicht wahr|ne|gell|verstehen sie|verstehst du|hallo|sind sie da|bist du da|danke(?: schön| sehr)?|vielen dank|guten (?:morgen|tag|abend)(?: zusammen)?|hallo zusammen)$/i

function germanSentenceIsQuestion(s) {
  const core = s.replace(DE_FILLER, '').replace(/^[\s,]+/, '')
  return DE_WH.test(core) || DE_V1.test(core)
}

function latinSmallTalk(s) {
  const words = s.replace(/[^\p{L}\p{N}'\s-]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  const bare = words.join(' ')
  if (!bare) return true
  const rest = bare.replace(EN_FILLER, '').trim()
  if (!rest || EN_BACKCHANNEL.test(rest) || EN_ACK.test(rest) || EN_ACK.test(bare)) return true
  if (DE_BACKCHANNEL.test(bare) || DE_BACKCHANNEL.test(bare.replace(DE_FILLER, '').trim())) return true
  const core = s.replace(EN_FILLER, '').replace(/^[\s,]+/, '')
  return EN_REQUEST.test(core) || (words.length <= 10 && DE_REQUEST.test(s))
}

function latinSentenceIsQuestion(raw) {
  const s = raw.replace(/["“”'’)\]]+$/u, '').trim()
  const words = s.replace(/[^\p{L}\p{N}'\s-]/gu, ' ').trim().split(/\s+/).filter(Boolean)
  const bare = words.join(' ')
  if (!bare) return false
  if (words.length <= 2 && !/^(?:why|how|any (?:questions|thoughts|comments|ideas|concerns)|questions|thoughts|anything else)\b/i.test(bare)) return false
  if (latinSmallTalk(s)) return false
  if (EN_DANGLING.test(bare)) return false
  const core = s.replace(EN_FILLER, '').replace(/^[\s,]+/, '')
  if (/[?？]$/.test(s)) return !statementDespiteMark(core)
  if (!EN_WHICH_CLAUSE.test(core) && !EN_CLEFT.test(core) && (EN_WH_AUX.test(core) || EN_WH_WORD_AUX.test(core) || EN_WH_PHRASE.test(core) || EN_WHICH_NOUN.test(core))) return true
  if (EN_AUX_SUBJECT.test(core) || EN_DO_HAVE.test(core)) return true
  if (EN_PROMPT.test(core)) return true
  if (germanSentenceIsQuestion(s)) return true
  return EN_INNER.test(s)
}

/* ---------------- 日文 ---------------- */

const JA_FILLER = /^(?:(?:えー+|ええ|あの+ー?|えっと|はい|うん|じゃあ|では|それでは|さて|まあ)[、,\s]*)+/
// ですか / ますか / でしょうか / かな 结尾
const JA_TAIL = /か(?:な|ね)?$/
// 教えてください / ご紹介いただけますか：请对方讲
const JA_PROMPT = /(?:教えて|説明して|紹介して|聞かせて|話して|お話し|ご紹介|ご説明)(?:ください|下さい|くれますか|もらえますか|いただけますか|いただけませんか|頂けますか)|自己紹介(?:を)?(?:お願いします|してください)/
// そうですか（原来如此）、本当ですか：附和
const JA_BACKCHANNEL = /^(?:そう|本当|ほんと|マジ|なるほど|いい|大丈夫|わかります|分かります|わかりました|分かりました|ありがとうございます|よろしくお願いします|こんにちは|おはようございます)(?:です|なん|でした)?(?:か|ですか|なの|ね|よ)?$/
// 聞こえますか / 画面を共有して：会上的事务
const JA_REQUEST = /(?:聞こえ|見え)(?:ます|ています|てます|る|てる)|画面(?:を)?(?:共有|シェア)|ミュート|カメラ(?:を)?(?:オン|オフ)|もう一度(?:言って|お願い)/

const jaBare = (s) => s.replace(/[\s\p{P}]/gu, '').replace(JA_FILLER, '')

function japaneseSmallTalk(s) {
  const bare = jaBare(s)
  return !bare || JA_BACKCHANNEL.test(bare) || (bare.length <= 20 && JA_REQUEST.test(bare))
}

function japaneseSentenceIsQuestion(s) {
  const bare = jaBare(s)
  if (bare.length < 4 || japaneseSmallTalk(s)) return false
  if (/[?？]\s*$/.test(s)) return true
  return JA_TAIL.test(bare) || JA_PROMPT.test(bare)
}

/* ---------------- 中文 ---------------- */

const ZH_FILLER = /^(?:(?:嗯+|啊+|哦+|噢|呃+|额|喂|好的?|对|那么?|然后|所以|okay|ok)[，,、\s]*)+/i
// 请对方讲：要看谁讲。前面是「我、我们」（我先给大家介绍一下）的是我方在讲，不是提问
const ZH_ASK_VERB = /(?:介绍一下|介绍下|讲讲|讲一下|讲一讲|说说|说一下|说一说|谈谈|谈一下|聊聊|解释一下|解释下|展开讲|展开说|详细说|具体说说|举个例子|举一个例子)/g
// 本身就是在问：你觉得、请问、我想知道
const ZH_ASK_PHRASE =
  /(?:你觉得|您觉得|你认为|您认为|你怎么看|您怎么看|请问|我想知道|我很好奇|想听听|给我讲|跟我讲|跟我说说|(?:你|您)的(?:看法|想法)(?:是什么|如何|怎么样|呢)?[\s。.!！…]*$)/
const ZH_OBJECT = /(?:给|跟|和|帮|为|向|对)(?:我们|我|大家)/g
const ZH_ASKED = /(?:你|您|请|麻烦|能不能|可不可以|能否|可以|大家|各位|同学)/
const ZH_LEAD = /^(?:那么?|嗯+|好的?|行|对|然后|所以|再|来|简单|简单地|稍微)*$/
// 这些搭配里的疑问词不表示提问，先删掉再判断
const ZH_NOT_QUESTION = [
  /(?:这就是|这也是|那就是|那也是|这正是|这才是)为什么/g,
  // 「有没有什么问题」里的「没有什么」不能删
  /(?:(?<!有)没|不|无论|不论|不管)[一-鿿]{0,3}?(?:什么|怎么|怎样|如何|为什么|为啥|哪|谁|多少)/g,
  /(?:什么都|什么的|怎么说呢|怎么样都|怎样都|怎么都|随便|多少有点|多多少少|或多或少|谁都|哪儿都|哪里都|哪都)/g,
  // 我们看看谁来负责、下面我讲一下怎么部署：说的是我方要做的事
  /(?:我|咱|下面|接下来|首先|今天)[一-鿿]{0,4}?(?:看看|想想|研究|商量|讨论|决定|确定|算算|算一下|查查|查一下|看一下|想一下|知道|讲|说|介绍|演示|展示|分享|解释|聊)[一-鿿]{0,6}?(?:什么|怎么|怎样|如何|为什么|为啥|哪|谁|多少)/g,
]
// 这个价格多少我们之后再算：往后推的话不是在问
const ZH_DEFER = /(?:再说|再定|再算|再看|再聊|再讨论|再商量|再决定|再议)[\s。.!！…吧]*$/
const ZH_WH = /(?:什么|怎么|为什么|为啥|干嘛|怎样|如何|哪个|哪些|哪里|哪儿|哪种|哪一|谁|多少|多久|多长|几点|啥)/
const ZH_ANOTB = /(?:能不能|可不可以|可以不可以|是不是|有没有|会不会|要不要|对不对|好不好|行不行|算不算|需不需要|愿不愿意|想不想|用不用|该不该)/
const ZH_TAIL = /(?:吗|嘛|么)[\s。.!！…]*$/
const ZH_TAIL_NE = /呢[\s。.!！…]*$/
const ZH_BACKCHANNEL = /^(?:真的吗|是吗|对吗|好吗|行吗|可以吗|是不是|对不对|好不好|行不行|什么|啥|怎么了|然后呢|是吧|对吧|好吧|没问题吧|明白吗|懂吗|清楚吗|你好|您好|大家好|哈喽|嗨|谢谢|谢谢你|谢谢大家|好的|明白了|知道了|收到)$/
// 能听到吗、大家能看到我的屏幕吗、共享一下屏幕：会上的事务，不用我回答
const ZH_HEAR_SEE = /(?:听|看)得?(?:到|见|清楚?)(?:我的?)?(?:说话|声音|屏幕|画面|共享|ppt)?了?(?:吗|么|嘛|没有?)?$/i
const ZH_REQUEST = /共享(?:一下)?(?:你的|您的|我的)?屏幕|(?:分享|投)(?:一下)?屏|(?:开|关|打开|关掉|关闭)(?:一下)?(?:摄像头|视频|麦克风|麦)|静音|(?:再说|重复)一(?:遍|下)/

const CJK = /[一-鿿]/g
const cjkCount = (s) => (s.match(CJK) ?? []).length
const zhBare = (s) => s.replace(ZH_FILLER, '').replace(/[\s\p{P}]/gu, '')

function chineseSmallTalk(s) {
  const bare = zhBare(s)
  return !bare || ZH_BACKCHANNEL.test(bare) || (bare.length <= 16 && (ZH_HEAR_SEE.test(bare) || ZH_REQUEST.test(bare)))
}

// 「介绍一下」这类词前后有没有指着对方：你能介绍一下、请讲讲、先介绍一下你自己、句首的「解释一下这个模块」
function chineseAsksMe(s) {
  for (const m of s.matchAll(ZH_ASK_VERB)) {
    const clause = s.slice(0, m.index).split(/[，,。.！!？?；;：:、\s]/).at(-1)
    const pre = clause.replace(ZH_OBJECT, '')
    if (/我|咱/.test(pre)) continue
    if (ZH_ASKED.test(pre) || ZH_LEAD.test(pre)) return true
    const post = s.slice(m.index + m[0].length).split(/[，,。.！!？?；;]/)[0]
    if (/你|您/.test(post)) return true
  }
  return false
}

function chineseSentenceIsQuestion(raw) {
  const s = raw.trim()
  const bare = s.replace(/[\s\p{P}]/gu, '')
  if (!bare || chineseSmallTalk(s)) return false
  if (cjkCount(bare) < 3) return false
  if (/[?？]\s*$/.test(s)) return true
  if (ZH_ASK_PHRASE.test(s) || chineseAsksMe(s)) return true
  if (ZH_DEFER.test(s)) return false
  let cleaned = s
  for (const re of ZH_NOT_QUESTION) cleaned = cleaned.replace(re, '，')
  if (ZH_TAIL.test(cleaned)) return true
  // 「呢」结尾的陈述句也不少（我还在想呢），只认短句：那你呢、baseline 呢
  if (ZH_TAIL_NE.test(cleaned) && bare.length <= 8) return true
  if (ZH_ANOTB.test(cleaned)) return true
  return ZH_WH.test(cleaned)
}

/* ---------------- 入口 ---------------- */

const KANA = /[぀-ヿ]/g

// 一句话按哪种语言的规则判：有假名的是日文，汉字多的是中文，别的文字只认问号，拉丁字母按英文和德文
function kindOf(s) {
  const letters = s.replace(/[\s\p{P}\p{N}]/gu, '').length || 1
  if ((s.match(KANA) ?? []).length / letters > 0.1) return 'ja'
  if (cjkCount(s) / letters > 0.3) return 'zh'
  if (/[\p{L}]/u.test(s) && !/\p{Script=Latin}/u.test(s)) return 'other'
  return 'latin'
}

function sentenceIsQuestion(s) {
  const kind = kindOf(s)
  if (kind === 'ja') return japaneseSentenceIsQuestion(s)
  if (kind === 'zh') return chineseSentenceIsQuestion(s)
  if (kind === 'other') return /[?？؟]\s*$/.test(s) && s.replace(/[\s\p{P}]/gu, '').length >= 4
  return latinSentenceIsQuestion(s)
}

function sentenceIsSmallTalk(s) {
  const kind = kindOf(s)
  if (kind === 'ja') return japaneseSmallTalk(s)
  if (kind === 'zh') return chineseSmallTalk(s)
  if (kind === 'other') return false
  return latinSmallTalk(s)
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|(?<=[。！？])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/* ---------------- 段落中间的提问 ---------------- */

// 本地识别一段定稿常有十几秒、好几句，对方问完不停顿接着往下说，问题就落在中间。
// 最后两句里的提问照旧按单句规则认；再往前的句子要求更严，因为长段发言中间常有自问自答（Why does this matter? Because…）：
// 必须是冲着听的人问的（你、您、大家、you、Sie），后面紧跟的不是自己的回答，也不是会上的事务请求。
const LISTENER = {
  latin: /\b(?:you|your|yours|yourself|you're|you've|you'd|you'll)\b|\b(?:Sie|Ihr|Ihre[mnrs]?|Ihnen|du|dein\w*)\b/i,
  zh: /你|您|大家|各位|同学/,
  ja: /あなた|皆さん|みなさん|ください|下さい|ますか|でしょうか/,
}
// 紧跟在设问后面、像在自己回答的：Because… / Well, / The answer is… / 因为…
const SELF_ANSWER = {
  latin: /^(?:because|since|well\b|the (?:answer|reason|short answer)|let me|i(?:'d say| think| guess)|it(?:'s| is| means)\b|that(?:'s| is)\b|this is\b|basically|simply|honestly)/i,
  zh: /^(?:因为|所以|其实|答案|原因|我(?:们)?(?:来|先|觉得|认为)|就是|这是因为)/,
}
// 点名：Tom, can you send… / Jack, how would you… 去掉名字再判，Tom, can you send the assets 就是会上的事务请求
const VOCATIVE = /^[A-Z][\p{L}'-]{1,15},\s+(?=\S)/u
// 问题后面紧跟的补充要求（Please think about retries）一起带上
const FOLLOW_UP = /^(?:please\b|bitte\b|请|麻烦)/i

function midSentenceIsQuestion(s, next) {
  const kind = kindOf(s)
  if (kind === 'other') return false
  const bare = kind === 'latin' ? s.replace(VOCATIVE, '') : s
  if (!sentenceIsQuestion(bare) || !LISTENER[kind].test(bare)) return false
  const answer = SELF_ANSWER[kind]
  return !(answer && next && (answer.test(next) || answer.test(next.replace(EN_FILLER, '').trim())))
}

// 一段话里哪几句是提问
function questionIndexes(sentences) {
  const out = []
  sentences.forEach((s, i) => {
    if (i >= sentences.length - 2 ? sentenceIsQuestion(s) : midSentenceIsQuestion(s, sentences[i + 1])) out.push(i)
  })
  return out
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** 是不是在提问。最后两句按单句规则认；再往前的句子只认冲着听的人问的（见上面）。 */
export function isQuestion(text) {
  const t = squash(text)
  return Boolean(t) && questionIndexes(splitSentences(t)).length > 0
}

/**
 * 要回答的是这一段里的哪部分。提问在最后两句里：整段（前面是铺垫，一直这么答）；
 * 提问落在中间（后面还接着说了别的）：只取最后那句提问，加上紧跟的「Please…」补充要求，别把后面说的事务也当成问题。认不出提问就整段。
 */
export function questionPart(text) {
  const t = squash(text)
  const sentences = splitSentences(t)
  const hits = questionIndexes(sentences)
  const last = hits.at(-1)
  if (last == null || last >= sentences.length - 2) return t
  let end = last + 1
  while (end < sentences.length && FOLLOW_UP.test(sentences[end])) end++
  return sentences.slice(last, end).join(' ')
}

/** 话没说完就停了（What is the / Can you tell me about your）：和接着的下一段连起来才是完整的问题。 */
export function isCutOff(text) {
  const t = String(text ?? '').trim()
  return !/[.!?。！？]$/.test(t) && EN_DANGLING.test(t.replace(/[^\p{L}\p{N}'\s-]/gu, ' ').trim())
}

/** 去掉一段话里的寒暄、附和和会上的事务（能听到吗、共享一下屏幕、Okay、Thanks），剩下的话；全是这些就返回空串。 */
export function dropSmallTalk(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  const all = splitSentences(t)
  const kept = all.filter((s) => !sentenceIsSmallTalk(s))
  return kept.length === all.length ? t : kept.join(' ')
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
    // question：引擎定稿时标的（连着前一段没说完的话才认得出的问题也标了）
    if (pool[i].question || isQuestion(pool[i].text)) return { text: questionPart(pool[i].text), segId: pool[i].id, matched: true }
  }
  return { text: pool.slice(-2).map((s) => s.text.trim()).join(' '), segId: pool.at(-1).id, matched: false }
}
