import { isMostlyChinese } from './text.js'
import { isChinese, needsMultilingual, promptLang, templateRule, writeLang } from './languages.js'

// 对方说的是中英文以外的语言（德语课等）：告诉模型原文是什么语言，识别稿里的错字按这种语言去理解
const sourceLine = (source) => (needsMultilingual(source) ? `发言的原文是${promptLang(source)}。` : '')

export function translateMessages({ sentence, previous, target, source, context, keywords }) {
  const lang = promptLang(target)
  const system = [
    `你是会议同传字幕员，把会议发言翻译成${lang}字幕。${sourceLine(source)}`,
    `要求：忠实原意，口语自然，简洁；人名、机构名、缩写、模型/数据集/工具名保留原文；${isChinese(target) ? '有通行中文说法的专业术语翻成中文；' : ''}数字、日期、截止时间必须准确。`,
    '识别稿可能有错字或断句不全，按上下文理解，不要评论。只输出译文本身，不要引号、不要解释。',
    context ? `会议背景：${context}` : '',
    keywords?.length ? `术语表（识别稿里这些词的正确拼写；专有名词和缩写保留原文）：${keywords.join('、')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const user = previous.length
    ? `上文（只作参考，不要翻译）：\n${previous.join('\n')}\n\n请翻译这一句：\n${sentence}`
    : `请翻译这一句：\n${sentence}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function transcriptText(session) {
  return session.segments
    .filter((s) => s.text)
    .map((s) => `[${clock(s.startedAt - session.startedAt)}] ${s.speaker}：${s.text}`)
    .join('\n')
}

export { clock }

const WEEKDAYS = '日一二三四五六'

/** 'YYYY-MM-DD'（本地时间） */
export function ymd(d) {
  d = new Date(d)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 'YYYY-MM-DD（周四）' */
export function dateLabel(ms) {
  return `${ymd(ms)}（周${WEEKDAYS[new Date(ms).getDay()]}）`
}

/** 会议所在这一周的周一起，连着 weeks 周的日历，一周一行，给模型换算相对日期用。 */
export function calendarText(ms, weeks = 3) {
  const d = new Date(ms)
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  const rows = []
  for (let w = 0; w < weeks; w++) {
    const days = []
    for (let i = 0; i < 7; i++) {
      const x = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + w * 7 + i)
      days.push(`${ymd(x)} 周${WEEKDAYS[x.getDay()]}`)
    }
    rows.push(`${['这周', '下周', '下下周'][w] ?? `${w} 周后`}：${days.join('，')}`)
  }
  return rows.join('\n')
}

/** 项目清单（纪要和待办提取都带上），current 是这场会议所属的项目。 */
export function projectBrief({ project, projects = [] }) {
  const lines = []
  if (project) {
    lines.push(`这场会议所属的项目：${project.name}${project.description ? `（${project.description}）` : ''}`)
    if (project.context) lines.push(`项目背景：${project.context}`)
  }
  const others = projects.filter((p) => p.id !== project?.id && !p.archived && p.id !== 'inbox')
  if (others.length) lines.push(`用户的其他项目（会里可能顺带提到）：\n${others.map((p) => `- ${p.name}${p.description ? `：${p.description}` : ''}`).join('\n')}`)
  return lines.join('\n')
}

export function summaryMessages({ session, project = null, projects = [], context, extraAsk }) {
  const dateText = dateLabel(session.startedAt)
  const out = writeLang(session, project)
  const system = `你是一位细心的会议助理。用户刚开完一场会。下面是会议的自动识别稿（可能有识别错误、缺标点，也可能只录到一方；「我」是用户，「对方」是会上的其他人）。
请用${promptLang(out)}写会议纪要，术语、论文章节名、人名保留原文。要求：
- 只根据识别稿写，不编造；拿不准的地方标「（待确认）」。
- 相对时间要换算成具体日期：会议日期是 ${dateText}，「next Friday」「in two weeks」「下周三」这类都算出日期并保留原话；「next + 星期几」按下一周的那一天算。
- 待办和 DDL 要具体到能直接照着做，每条后面用「原话：」附上识别稿里的依据（保留原文）和时间戳。
- 用户同时在做好几个项目（见项目清单）。会里说到别的项目的事照样写进纪要，在那一条后面用【项目名】标出来。
- 不要用破折号。${templateRule(out)}

按下面的 Markdown 结构输出，没有内容的小节写「无」：

## 一句话总结
## 讨论要点
（按话题分组，每组几条要点）
## 对方的具体意见和修改要求
（按主题或论文章节列，尽量具体到改哪里、怎么改）
## 我要做的事
- [ ] 事项（截止：日期 / 无明确截止）  原话："…" [mm:ss]
## DDL 与时间节点
| 时间 | 事项 | 原话 |
|---|---|---|
## 下次会议
## 没听清或需要再确认的地方`
  const parts = []
  const brief = projectBrief({ project, projects })
  if (brief) parts.push(brief)
  else if (context) parts.push(`会议背景：${context}`)
  parts.push(`日历：\n${calendarText(session.startedAt)}`)
  if (extraAsk) parts.push(`额外要求：${extraAsk}`)
  if (session.liveNotes) parts.push(`开会时整理的实时笔记（JSON，只作参考，以识别稿为准）：\n${JSON.stringify(session.liveNotes)}`)
  parts.push(`识别稿（[分:秒] 说话人：内容）：\n${transcriptText(session)}`)
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/* ---------------- 译文 + 意群对齐 + 术语解释（一次请求，enhance v2） ---------------- */

// 意群对齐的示例：让模型知道 chunks 怎么切、zh 怎么从译文里原样截；第二个是问句，中文语序不同时 zh 给几段
const CHUNK_EXAMPLES = [
  {
    sentence: 'If you increase the learning rate too much, the loss will start to diverge, which we saw in the last lab.',
    out: {
      tr: '学习率调得太大，损失就会开始发散，上次实验课我们见过。',
      chunks: [
        { en: 'If you increase the learning rate too much,', zh: '学习率调得太大，' },
        { en: 'the loss will start to diverge,', zh: '损失就会开始发散，' },
        { en: 'which we saw in the last lab.', zh: '上次实验课我们见过。' },
      ],
      terms: [{ term: 'diverge', zh: '发散', explain: '训练时损失不降反升、越来越大' }],
    },
  },
  {
    sentence: 'Could you tell me why the new model converges faster on the small dataset?',
    out: {
      tr: '你能说说为什么新模型在小数据集上收敛更快吗？',
      chunks: [
        { en: 'Could you tell me', zh: '你能说说' },
        { en: 'why the new model converges faster', zh: ['为什么新模型', '收敛更快'] },
        { en: 'on the small dataset?', zh: '在小数据集上' },
      ],
      terms: [{ term: 'converges', zh: '收敛', explain: '训练中损失逐渐稳定、不再明显下降' }],
    },
  },
]

// AI 纠错时再加一个带识别错误的示例：fixed 是改好的整句，意群和术语都从 fixed 里截（示例故意不用探针里的词）
const FIX_EXAMPLE = {
  sentence: 'So the pie torch version handles the whole out set differently.',
  out: {
    tr: '所以 PyTorch 版本处理留出集的方式不一样。',
    fixed: 'So the PyTorch version handles the hold-out set differently.',
    chunks: [
      { en: 'So the PyTorch version', zh: '所以 PyTorch 版本' },
      { en: 'handles the hold-out set differently.', zh: '处理留出集的方式不一样。' },
    ],
    terms: [{ term: 'hold-out set', zh: '留出集', explain: '训练时不用、专门留来评估模型的数据' }],
  },
}

// 示例的输出按这次要的字段裁剪，字段顺序和 shape 一样（fixed、tr、chunks、terms）
function exampleOut(out, { correct, terms }) {
  const o = {}
  if (correct) o.fixed = out.fixed ?? ''
  o.tr = out.tr
  o.chunks = out.chunks
  if (terms) o.terms = out.terms
  return o
}

/**
 * enhance v2 的请求：translate 要译文，chunks 要意群对齐（只在要译文时有），terms 要术语解释，correct 要 AI 纠正识别错误。
 * 回复 { fixed, tr, chunks: [{ en, zh }], terms: [{ term, zh, explain }] }；en 是原文片段，zh 是译文片段（译成英文时也叫这两个名字）。
 * fixed 是纠正识别错误后的整句，没改就是空字符串（多数句子只多几个字）；放在最前面，译文、意群和术语都按纠正后的句子来，
 * 字幕上的英文和中文说的是同一句话。
 */
export function enhanceMessages({ sentence, previous = [], target = 'zh', source = 'en', translate = true, terms = true, chunks = translate, correct = false, context, keywords, scene = 'meeting' }) {
  const lang = promptLang(target)
  const withChunks = Boolean(translate && chunks)
  // 纠错开着时，意群和术语都按改好的句子来
  const src = correct ? '改好的句子（fixed 为空时就是「这一句」）' : '原文'
  const shape = {}
  if (correct) shape.fixed = '纠正识别错误后的整句，没有要改的给空字符串'
  if (translate) shape.tr = '译文'
  if (withChunks) shape.chunks = [{ en: '原文片段', zh: '译文片段' }]
  if (terms) shape.terms = [translate ? { term: '原文片段', zh: '译文里对应的片段', explain: '解释' } : { term: '原文片段', explain: '解释' }]
  const tasks = []
  const toZh = isChinese(target)
  if (correct)
    tasks.push(
      [
        '「这一句」是语音识别稿，先纠正里面明显的识别错误，改好的整句放在 fixed：',
        '- 只改识别错的词：同音或近音误听（比如 the whole out set 应为 the hold-out set）；人名、机构名、术语、模型/数据集/工具名的拼写，以术语表和背景为准（比如术语表里有 LoRA，识别稿写成 Laura）；一个词被拆开或几个词被连在一起（比如 pie torch 应为 PyTorch）。',
        '- 不改说法，不润色，不改语法和标点，不补全没说完的话，不翻译；口头禅、重复、语病都照留。',
        '- 拿不准就不改。整句没有要改的，fixed 给空字符串。',
      ].join('\n'),
    )
  if (translate)
    tasks.push(
      `把「这一句」翻译成${lang}字幕。译文要短：口语化，一句原文对一句译文，不加解释性扩写；人名、机构名、缩写、模型/数据集/工具名保留原文；` +
        (toZh ? '有通行中文说法的专业术语要翻成中文（比如 ablation 译作「消融」，learning rate 译作「学习率」），方便对照着看懂；' : '') +
        '数字、日期必须准确。识别稿可能有错字或断句不全，按上下文理解' + (correct ? '，按纠正后的意思翻译。' : '。'),
    )
  if (withChunks)
    tasks.push(
      [
        '按意群把「这一句」切成几块，给出每块的原文片段 en 和它在译文 tr 里对应的片段 zh：',
        '- 一句 2 到 5 块；主干、从句、介词短语、插入语各自一块。再短的句子也至少切 2 块（比如 OK, that makes sense. 切成 OK, 和 that makes sense.）。',
        `- en 从${src}原样复制，按原文顺序首尾相接：所有 en 连起来就是整句（标点可以不算），开头和结尾都不能漏。`,
        '- zh 必须是 tr 里连续的原样子串，各块的 zh 互不重叠；中文语序和原文不同没关系。',
        '- 一块英文对应的中文在 tr 里被别的内容隔开了（问句、倒装里常见），zh 就给数组，列出 tr 里的这几段，每段都是 tr 的原样子串。',
      ].join('\n'),
    )
  if (terms)
    tasks.push(
      [
        '从「这一句」里挑出需要解释的词：',
        '- 只挑听众不查就可能听不懂的：专业术语、缩写、方法/模型/数据集/工具名、人名、机构、会议和期刊名。',
        '- 日常词和人人都懂的学术用语不挑，比如 paper、draft、section、related work、experiment、results、deadline、supervisor、data。',
        '- 宁缺毋滥，一句最多 3 个；没有就给空数组。',
        correct
          ? `- term 必须从${src}里原样复制：大小写、单复数、连字符都不改，不补全缩写，不加引号。`
          : '- term 必须从这一句原文里原样复制：大小写、单复数、连字符都不改，不补全缩写，不加引号。',
        translate ? '- zh 是 tr 里和它对应的中文片段（原样复制）；译文里这个词保留了原文、没有中文说法的，zh 给空字符串。' : '',
        `- explain 是一句${lang}，最多 40 个字符（英文字母和空格也算），结合背景说它在这里指什么；缩写先给${toZh ? '中文名' : `${lang}的说法`}或简短全称，不写很长的英文全称；不要用破折号。`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
  const numbered = tasks.length > 1 ? tasks.map((t, i) => `任务${'一二三四'[i]}：${t}`) : [`任务：${tasks[0] ?? ''}`]
  const heard = needsMultilingual(source) ? promptLang(source).replace(/（.*）/, '') : '英语'
  const audience =
    (scene === 'class' ? `你是课堂实时字幕助手，听众是母语为${lang}的学生，${heard}听力一般。` : `你是会议实时字幕助手，听众是母语为${lang}的研究生，${heard}听力一般。`) + sourceLine(source)
  const examples = correct ? [...CHUNK_EXAMPLES, FIX_EXAMPLE] : CHUNK_EXAMPLES
  const system = [
    audience,
    ...numbered,
    `只输出一个 JSON 对象，不要代码块，不要别的文字：${JSON.stringify(shape)}`,
    withChunks && toZh
      ? `示例：\n${examples.map((x) => `这一句：${x.sentence}\n输出：${JSON.stringify(exampleOut(x.out, { correct, terms }))}`).join('\n')}`
      : '',
    context ? `${scene === 'class' ? '课程背景' : '会议背景'}：${context}` : '',
    keywords?.length ? `术语表（识别稿里这些词的正确拼写）：${keywords.join('、')}` : '',
    // 术语表里的词模型容易整段留英文（v4 审查实测），中文那边就没有可标的难词：单独再说一遍
    keywords?.length && translate && toZh
      ? '术语表里的词翻译时和别的词一样：有通行中文说法的写中文（几个普通英文词组成的词组也要译出来，比如 label noise 写「标签噪声」），只有人名、机构、产品、模型、数据集的名字和缩写保留原文。'
      : '',
  ]
    .filter(Boolean)
    .join('\n')
  const user = previous.length
    ? `上文（只作参考，不要处理）：\n${previous.join('\n')}\n\n这一句：\n${sentence}`
    : `这一句：\n${sentence}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

const DASHES = /\s*[\u2013\u2014]+\s*/g
const QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g
const MAX_TERMS = 5

export function cleanText(v) {
  return typeof v === 'string' ? v.replace(DASHES, '，').trim() : ''
}

// enhance 的回复开头就是 {"tr":"…"（开着纠错时是 {"fixed":"…","tr":"…"）：流式收到这一段就能先把译文（和纠正后的句子）
// 显示出来，意群和术语等整个 JSON 到了再补
const TR_HEAD = /^\s*(?:```[a-zA-Z]*\s*)?\{\s*(?:"(?:fixed|corrected)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*)?"(?:tr|translation)"\s*:\s*"((?:[^"\\]|\\.)*)"/

const unquote = (s) => {
  try {
    return JSON.parse(`"${s}"`)
  } catch {
    return null
  }
}

/**
 * 流式收到的半截 enhance 回复开头：→ { tr, fixed }。tr 还没收全（或者模型没按顺序先给 fixed、tr）时 tr 是 ''；
 * fixed 是模型给的原样（没给是 ''），能不能用由调用方拿 checkFix 判断。
 */
export function streamedHead(text) {
  const m = String(text ?? '').match(TR_HEAD)
  const tr = m ? unquote(m[2]) : null
  if (tr == null) return { tr: '', fixed: '' }
  return { tr: cleanText(tr), fixed: (m[1] != null && unquote(m[1])) || '' }
}

/** 流式收到的半截 enhance 回复里已经完整的译文；还没收全（或者模型没把 tr 放在最前面）返回 ''。 */
export function streamedTr(text) {
  return streamedHead(text).tr
}

/** 模型写的长文（纪要、课堂笔记、答案）里的破折号换成逗号；不去首尾空白，流式出字时也能每次调用。 */
export function noDashes(v) {
  return typeof v === 'string' ? v.replace(DASHES, '，') : ''
}

// 从 start 处的 { 开始找配平的 }，跳过字符串里的括号
function balancedEnd(s, start) {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
    } else if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 从模型回复里取出第一个 JSON 对象（容忍代码块包裹和前后多余文字），取不到返回 null。 */
export function extractJson(text) {
  const s = String(text ?? '').trim()
  const fenced = s.match(/```[a-zA-Z]*\s*([\s\S]*?)```/)
  for (const cand of [fenced?.[1], s]) {
    if (!cand) continue
    try {
      const v = JSON.parse(cand.trim())
      if (isObject(v)) return v
    } catch {}
  }
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    const end = balancedEnd(s, i)
    if (end < 0) break
    try {
      const v = JSON.parse(s.slice(i, end + 1))
      if (isObject(v)) return v
    } catch {}
  }
  return null
}

// 在句子里找 term：先原样，找不到再忽略大小写，返回句子里的原样片段
function locateTerm(sentence, term) {
  if (sentence.includes(term)) return term
  const lower = sentence.toLowerCase()
  if (lower.length !== sentence.length) return null
  const i = lower.indexOf(term.toLowerCase())
  return i >= 0 ? sentence.slice(i, i + term.length) : null
}

// 超过 40 字：优先在 40 字内最后一个分句处截断，没有合适的分句再硬截到 60 字
function capExplain(s) {
  if (s.length <= 40) return s
  const head = s.slice(0, 41)
  const cut = Math.max(...['，', '。', '；', ',', ';'].map((c) => head.lastIndexOf(c)))
  if (cut >= 10) return s.slice(0, cut)
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

const EDGE_PUNCT = /^[\s,.;:!?，。；：！？、"'“”‘’「」()（）]+|[\s,.;:!?，。；：！？、"'“”‘’「」()（）]+$/g
const MAX_CHUNKS = 8

// 片段在 text 里的位置：先原样，再忽略大小写，再去掉两头的标点；避开已经占用的区间，优先从 from 往后找。
// → { start, end } 或 null
function locate(text, piece, used = [], from = 0) {
  const lower = text.toLowerCase()
  const caseless = lower.length === text.length
  const tries = [piece]
  const bare = piece.replace(EDGE_PUNCT, '')
  if (bare && bare !== piece) tries.push(bare)
  const free = (a, b) => !used.some((u) => a < u.end && b > u.start)
  for (const p of tries) {
    for (const [hay, needle] of caseless ? [[text, p], [lower, p.toLowerCase()]] : [[text, p]]) {
      let first = null
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
        if (!free(i, i + needle.length)) continue
        if (i >= from) return { start: i, end: i + needle.length }
        first ??= { start: i, end: i + needle.length }
      }
      if (first) return first
    }
  }
  return null
}

function str(v) {
  return typeof v === 'string' ? v : ''
}

const LEAD_PUNCT = /^[\s,.;:!?，。；：！？、"'“”‘’「」()（）]+/
const MAX_ZH_PIECES = 3
const solid = (s) => s.replace(EDGE_PUNCT, '').length

/**
 * zh 整段在译文里找不到：多半是模型把译文里不相邻的几段拼成了一块（问句、倒装里常见，比如「Transformer 基线表现更差」
 * 对「Transformer 基线在噪声子集上表现更差」）。从头贪心取译文里能找到的最长一段（至少 2 个字），接着找剩下的，
 * 最多 3 段；最后只剩一个字（吗、呢）就不要了。都找得到返回这几段的位置，否则 null。
 */
function splitZh(tr, zh, used) {
  const out = []
  const taken = [...used]
  let rest = zh.replace(EDGE_PUNCT, '')
  while (rest) {
    if (solid(rest) < 2) return out.length ? out : null
    let hit = null
    for (let len = rest.length; len >= 2 && !hit; len--) {
      const piece = rest.slice(0, len)
      if (solid(piece) < 2) continue
      const pos = locate(tr, piece, taken)
      if (pos) hit = { pos, len }
    }
    if (!hit || out.length >= MAX_ZH_PIECES) return null
    out.push(hit.pos)
    taken.push(hit.pos)
    rest = rest.slice(hit.len).replace(LEAD_PUNCT, '')
  }
  return out.length ? out : null
}

// 一块的 zh（字符串，或者模型给的几段）在译文里的位置：→ [{ start, end }]（按译文顺序）或 null
function locateZh(tr, zh, used) {
  const list = (Array.isArray(zh) ? zh : [zh]).map((z) => cleanText(z)).filter(Boolean)
  if (!list.length) return null
  const found = []
  for (const piece of list) {
    const taken = [...used, ...found]
    const z = locate(tr, piece, taken)
    const parts = z ? [z] : splitZh(tr, piece, taken)
    if (!parts) return null
    found.push(...parts)
    if (found.length > MAX_ZH_PIECES) return null
  }
  return found.sort((a, b) => a.start - b.start)
}

/**
 * 意群对齐：en 要在原句里找得到，zh 要在译文里找得到，而且各块互不重叠；找不到的块丢掉，其它照留。
 * zh 在译文里不连续时拆成几段（数组，同一个颜色），见 splitZh。结果按原句顺序排。sentence 没给时不查 en（只做清洗）。
 */
export function parseChunks(list, sentence, tr) {
  if (!Array.isArray(list) || !tr) return []
  const out = []
  const usedEn = []
  const usedZh = []
  let from = 0
  for (const x of list) {
    if (!isObject(x)) continue
    let en = str(x.en ?? x.src ?? x.source).trim()
    const zhRaw = x.zh ?? x.tr ?? x.target
    if (!en || !zhRaw) continue
    let pos = null
    if (typeof sentence === 'string') {
      pos = locate(sentence, en, usedEn, from)
      if (!pos) continue
      en = sentence.slice(pos.start, pos.end)
    }
    const zs = locateZh(tr, zhRaw, usedZh)
    if (!zs) continue
    const pieces = zs.map((z) => tr.slice(z.start, z.end))
    if (pos) {
      usedEn.push(pos)
      from = pos.end
    }
    usedZh.push(...zs)
    out.push({ en, zh: pieces.length === 1 ? pieces[0] : pieces, at: pos?.start ?? out.length })
    if (out.length >= MAX_CHUNKS) break
  }
  return out.sort((a, b) => a.at - b.at).map(({ en, zh }) => ({ en, zh }))
}

/** 意群覆盖了原句多少（不算空格和标点），0 到 1。给 trace 看模型守不守「首尾相接覆盖整句」。 */
export function chunkCoverage(sentence, chunks) {
  const text = String(sentence ?? '')
  const bare = (t) => t.replace(/[\s\p{P}]/gu, '').length
  const total = bare(text)
  if (!total || !Array.isArray(chunks)) return 0
  const lower = text.toLowerCase()
  const marks = new Array(text.length).fill(false)
  let from = 0
  for (const c of chunks) {
    const en = String(c?.en ?? '')
    if (!en) continue
    let i = lower.indexOf(en.toLowerCase(), from)
    if (i < 0) i = lower.indexOf(en.toLowerCase())
    if (i < 0) continue
    for (let k = i; k < i + en.length; k++) marks[k] = true
    from = i + en.length
  }
  let n = 0
  for (let k = 0; k < text.length; k++) if (marks[k] && !/[\s\p{P}]/u.test(text[k])) n++
  return n / total
}

/* ---------------- AI 纠错：模型给的 fixed 可不可信 ---------------- */

const FIX_MAX_EDITS = 0.35 // 词级编辑超过原句词数的 35%（至少允许 1 处）：多半是改写了，不是纠错
const FIX_MAX_LENGTH = 0.4 // 长度变化超过 40%：多半是补全或删了半句
// 词：字母数字连在一起算一个（中间可以有撇号、连字符、点，比如 Siemens's、p-values、U.S）；汉字一个字算一个
const FIX_TOKEN = /\p{Script=Han}|[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu
const fixTokens = (s) => String(s ?? '').match(FIX_TOKEN) ?? []
const normWord = (w) => w.toLowerCase().replace(/['’.\-]/g, '')

function lev(a, b) {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

// 拼写接近（编辑距离不超过较长那个的一半）：识别错的词大多是这样，seamens / siemens、blation / ablation
const nearWord = (x, y) => lev(x, y) <= Math.max(x.length, y.length) / 2
// 拆开或合并：连起来几乎一样才算（web vision / webvision），免得 do 和 to do 这种也按半个算
const nearJoin = (x, y) => lev(x, y) <= Math.max(1, Math.floor(Math.max(x.length, y.length) / 4))

/**
 * 两句之间的词级编辑距离（不分大小写，不看标点）：增删一个词算 1，换成拼写接近的词、两三个词合成一个或一个拆成两三个
 * （web vision / WebVision、a blation / ablation）算 0.5，换成不相干的词算 1。
 */
export function fixEdits(a, b) {
  const x = a.map(normWord)
  const y = b.map(normWord)
  const D = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0))
  for (let i = 0; i <= x.length; i++) D[i][0] = i
  for (let j = 0; j <= y.length; j++) D[0][j] = j
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const sub = x[i - 1] === y[j - 1] ? 0 : nearWord(x[i - 1], y[j - 1]) ? 0.5 : 1
      let d = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + sub)
      for (let k = 2; k <= 3; k++) {
        if (i >= k && nearJoin(x.slice(i - k, i).join(''), y[j - 1])) d = Math.min(d, D[i - k][j - 1] + 0.5)
        if (j >= k && nearJoin(x[i - 1], y.slice(j - k, j).join(''))) d = Math.min(d, D[i - 1][j - k] + 0.5)
      }
      D[i][j] = d
    }
  }
  return D[x.length][y.length]
}

const WRAPPED = /^(["“「])([\s\S]*)(["”」])$/
// 比长度用：一个汉字算两个字符（罗拉 改成 LoRA 不该算长了一倍）
const textWeight = (s) => s.length + (s.match(/\p{Script=Han}/gu)?.length ?? 0)

/**
 * 模型给的纠正后整句 fixed 能不能用。→ { ok: true, fixed, edits, words } 或 { ok: false, reason, edits?, words? }
 * reason：empty（没给或空）、same（和原句一样，或者只动了标点、空白）、edits（改动的词太多）、length（长度变化太大）。
 */
export function checkFix(orig, fixed) {
  const o = String(orig ?? '').trim()
  let f = typeof fixed === 'string' ? fixed.trim() : ''
  f = f.replace(DASHES, isMostlyChinese(o) ? '，' : ', ').trim()
  const w = f.match(WRAPPED)
  if (w && !WRAPPED.test(o)) f = w[2].trim() // 模型给整句加了引号
  if (!f) return { ok: false, reason: 'empty' }
  if (f === o) return { ok: false, reason: 'same' }
  const a = fixTokens(o)
  const b = fixTokens(f)
  if (a.length === b.length && a.every((x, i) => x === b[i])) return { ok: false, reason: 'same' }
  const edits = fixEdits(a, b)
  const words = Math.max(a.length, 1)
  if (edits > Math.max(1, words * FIX_MAX_EDITS)) return { ok: false, reason: 'edits', edits, words }
  const lo = textWeight(o)
  if (Math.abs(textWeight(f) - lo) > lo * FIX_MAX_LENGTH) return { ok: false, reason: 'length', edits, words }
  return { ok: true, fixed: f, edits, words }
}

/**
 * 解析 enhance 的回复 → { tr, chunks, terms }，AI 纠正了识别错误时多一个 fixed（纠正后的整句）。
 * 给了 sentence 就只留句子里真有的术语和意群，并把大小写改成句子里的写法；术语的 zh 在译文里找不到就置空。
 * fixed 缺失、为空、和原句一样都算没改；改动太大（见 checkFix）丢掉，结果里只多一个 fixDropped（'edits' 或 'length'），
 * 按 fixed 写的意群和术语在原句里找不到，照常丢掉。correct: false 时不看 fixed。全坏了是 { tr: '', chunks: [], terms: [] }。
 */
export function parseEnhance(text, sentence, { correct = true } = {}) {
  const v = extractJson(text)
  if (!v) return { tr: '', chunks: [], terms: [] }
  const tr = cleanText(v.tr ?? v.translation)
  let base = sentence
  let fix = null
  if (correct && typeof sentence === 'string') {
    fix = checkFix(sentence, v.fixed ?? v.corrected)
    if (fix.ok) base = fix.fixed
  }
  let list = v.terms ?? v.glossary ?? []
  if (isObject(list)) list = Object.entries(list).map(([term, explain]) => ({ term, explain }))
  const terms = []
  const seen = new Set()
  for (const x of Array.isArray(list) ? list : []) {
    if (!isObject(x)) continue
    let term = typeof x.term === 'string' ? x.term.trim().replace(QUOTES, '').trim() : ''
    let explain = cleanText(x.explain ?? x.explanation)
    if (!term || term.length > 60 || !explain) continue
    if (typeof base === 'string') {
      term = locateTerm(base, term)
      if (!term) continue
    }
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    explain = capExplain(explain)
    const zhRaw = cleanText(x.zh ?? x.tr ?? x.translation).replace(QUOTES, '').trim()
    // 译文里原样保留了英文（zh 就是 term 本身）：中文那边没有可标的，按没有中文处理
    const same = zhRaw.toLowerCase() === term.toLowerCase()
    const z = zhRaw && tr && !same ? locate(tr, zhRaw) : null
    terms.push({ term, zh: z ? tr.slice(z.start, z.end) : '', explain })
    if (terms.length >= MAX_TERMS) break
  }
  const out = { tr, chunks: parseChunks(v.chunks ?? v.groups ?? v.segments, base, tr), terms }
  if (fix?.ok) out.fixed = fix.fixed
  else if (fix && (fix.reason === 'edits' || fix.reason === 'length')) out.fixDropped = fix.reason
  return out
}
