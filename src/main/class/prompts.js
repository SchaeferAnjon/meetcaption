import { calendarText, clock, dateLabel, transcriptText } from '../prompts.js'
import { relativeDayHints } from '../todos.js'
import { promptLang, templateRule, writeLang } from '../languages.js'

// 课堂模式的三个 prompt：实时笔记（边听边整理，JSON）、课后课堂笔记（Markdown）、作业提取（沿用待办的 JSON 格式）。

// 实时笔记模型回复的形状：只写这一批的变化。sections 第一项补充上一版的第 n 小节，第二项是新小节；edits 改上一版里写错的某一条。
// 示例里的反斜杠经 JSON.stringify 后是两个，模型照着写，JSON.parse 以后才是正确的一个
export const NOTES_SHAPE = {
  sections: [
    { n: 2, points: ['补充到第 2 小节的新要点，符号和式子写成行内公式，比如 $\\lambda$'], formulas: ['LaTeX 源码，比如 \\lambda \\lVert w \\rVert_2^2'], examples: ['例子'] },
    { title: '新小节标题', start: 'mm:ss', points: ['要点'], formulas: [], examples: [] },
  ],
  edits: [{ section: 1, field: 'points', i: 2, text: '改正后的整条' }],
  emphasis: [{ text: '老师强调或可能考的点', at: 'mm:ss', quote: '原话' }],
  homework: [{ text: '作业或要做的事', due: 'YYYY-MM-DD 或 null', dueText: '原话里的时间' }],
  terms: [{ term: '英文', zh: '中文', explain: '解释' }],
}

/** 字幕片段 [{ at（距开始的毫秒数）, speaker, text }] → 「[mm:ss] 老师：…」 */
export function linesText(lines) {
  return lines.map((l) => `[${clock(l.at)}] ${l.speaker}：${l.text}`).join('\n')
}

// 实时笔记四类字段在三种模式下的含义：同一个 JSON 结构，界面按模式换标题
const NOTES_ROLE = {
  class: {
    who: '你是课堂笔记助手，用户正在听一节课（多半是英文授课），你边听边帮他整理笔记。',
    lines: '新增的课堂字幕（[分:秒] 说话人：内容；「老师」是授课老师，「我」是用户）',
    background: '课程背景',
    date: '上课日期',
    first: '还没有，这是这节课的第一段。',
    rules: `- sections：按老师讲的顺序分小节，start 是这一小节开始的时间（mm:ss）；points 每条一句话，具体到能复习。
- formulas：老师念出来或写出来的公式，还原成 LaTeX 源码（不要加 $ 符号），比如 "theta new equals theta old minus eta times the gradient" 在 JSON 里写成 "\\\\theta_{new} = \\\\theta_{old} - \\\\eta \\\\nabla_\\\\theta L"。
- examples：老师举的例子，一句话说清楚例子和它说明了什么。
- emphasis：老师明确强调的（this is important、remember、this will be on the exam、考试会考、注意）或反复讲的点，at 是原话的时间，quote 是原话（保留英文）。
- homework：作业、阅读、要交的东西、考试和截止时间。due 按日历换算成 YYYY-MM-DD，没说时间写 null；dueText 是原话里的时间说法（保留英文）。
- terms：课上出现的专业术语，原文、{L}译名、一句{L}解释（不超过 40 个字）。`,
  },
  meeting: {
    who: '你是会议记录助手，用户正在开会，你边听边帮他整理会议笔记。',
    lines: '新增的会议字幕（[分:秒] 说话人：内容；「我」是用户，「对方」是会上的其他人）',
    background: '会议背景',
    date: '会议日期',
    first: '还没有，这是这场会的第一段。',
    rules: `- sections：会上讨论的议题，按讨论顺序，title 是议题，start 是开始讨论的时间（mm:ss）；points 每条一句话，写清谁说了什么、有什么意见和理由。
- formulas、examples：会上真的出现公式、举了具体例子才写，一般给空数组。
- emphasis：已经定下来的结论和决定，或对方明确提出的要求和修改意见，at 是原话的时间，quote 是原话（保留原文）。
- homework：待办，text 写清谁做什么（「我：…」或「对方：…」），due 按日历换算成 YYYY-MM-DD，没说时间写 null；dueText 是原话里的时间说法（保留原文）。
- terms：会上出现的专业术语、项目名、缩写，原文、{L}译名、一句{L}解释（不超过 40 个字）。`,
  },
  interview: {
    who: '你是面试记录助手，用户正在参加面试，你边听边帮他整理面试笔记，方便他随时看问过什么、答得怎么样。',
    lines: '新增的面试字幕（[分:秒] 说话人：内容；「我」是用户，「对方」是面试官）',
    background: '面试背景',
    date: '面试日期',
    first: '还没有，这是这场面试的第一段。',
    rules: `- sections：面试官问过的问题，按提问顺序，title 是问题（一句话概括），start 是提问的时间（mm:ss）。points 先写我回答的要点，再写面试官的追问（以「追问：」开头）。
- formulas、examples：面试里真的推公式、举了具体例子才写，一般给空数组。
- emphasis：面试官在意或反复追问的地方、给出的评价和暗示、我没答好需要补的点，at 是原话的时间，quote 是原话（保留原文）。
- homework：面试后要做的事和时间点：下一轮面试、要补发的材料、面试官让我准备的东西。due 按日历换算成 YYYY-MM-DD，没说时间写 null；dueText 是原话里的时间说法（保留原文）。
- terms：面试里出现的专业术语、技术名词、公司和产品名，原文、{L}译名、一句{L}解释（不超过 40 个字）。`,
  },
}

// 上一版笔记给模型看多少：最近的 FULL_SECTIONS 个小节给全文（要点、公式、例子都带序号，好接着写或改某一条），
// 再早的只给序号、标题、开始时间和各类条数（模型只需要知道有这个小节、能补充它）。强调点和术语只给文字 / 名字让它别重复，作业全给。
// 取舍：一小时课大约 20 个小节，每次都全给，输入每批多一万多 token；老小节的要点模型用不上（新内容多半接在最近的话题后面），
// 万一回到旧话题，也能用序号补充，重复的要点由 applyNotes 去掉。代价是旧小节的要点写错了模型改不了，课后课堂笔记会按识别稿重写。
export const FULL_SECTIONS = 2

/** 上一版笔记 → 给模型看的摘要文字。 */
export function notesDigest(prev, { full = FULL_SECTIONS } = {}) {
  const out = []
  const n = prev.sections.length
  prev.sections.forEach((s, i) => {
    const head = `小节 ${i + 1}「${s.title}」${s.start ? `[${s.start}]` : ''}`
    if (i < n - full) {
      out.push(`${head}：${s.points.length} 条要点，${s.formulas.length} 个公式，${s.examples.length} 个例子`)
      return
    }
    out.push(head)
    s.points.forEach((x, j) => out.push(`  要点 ${j + 1}. ${x}`))
    s.formulas.forEach((x, j) => out.push(`  公式 ${j + 1}. ${x}`))
    s.examples.forEach((x, j) => out.push(`  例子 ${j + 1}. ${x}`))
  })
  if (!n) out.push('小节：还没有')
  out.push(prev.emphasis.length ? `已有的强调点（不要重复写）：\n${prev.emphasis.map((e) => `  - ${e.text}`).join('\n')}` : '已有的强调点：还没有')
  out.push(
    prev.homework.length
      ? `已有的作业（有新信息才带 n 重写）：\n${prev.homework.map((h, i) => `  ${i + 1}. ${h.text}${h.due ? `（截止 ${h.due}）` : h.dueText ? `（${h.dueText}）` : ''}`).join('\n')}`
      : '已有的作业：还没有',
  )
  out.push(prev.terms.length ? `已有的术语（不要重复写）：${prev.terms.map((t) => t.term).join('、')}` : '已有的术语：还没有')
  return out.join('\n')
}

/**
 * 实时笔记：上一版笔记的摘要 + 新的字幕片段 → 这一批的变化（增量 JSON，liveNotes.js 的 applyNotes 合并）。
 * prev：上一版（没有就 null）；lines：新增的字幕片段；startedAt：开始时间（换算日期）；mode：class | meeting | interview。
 */
export function notesMessages({ prev = null, lines, context = '', startedAt = Date.now(), mode = 'class', lang = 'zh' }) {
  const r = NOTES_ROLE[mode] ?? NOTES_ROLE.class
  const L = promptLang(lang)
  const system = `${r.who}
下面给你上一版笔记的摘要和刚才${r.lines}。
只输出这一批新内容带来的变化，不要重写上一版已有的内容，程序会把你写的合并进笔记。格式：
${JSON.stringify(NOTES_SHAPE)}

增量规则：
- sections 每一项二选一：补充已有小节，写 n（摘要里的小节序号）加上新增的 points、formulas、examples，不写 title 和 start，已有的不要重复；或者新小节，不写 n，写 title、start 和内容。还在讲同一个话题就补充已有小节（通常是最后一个），换了话题才新开；小节别切得太碎，一个小节一般是几分钟的一个完整话题。一个小节的要点一般不超过 12 条，公式不超过 8 个，再多就新开一个小节接着写。
- edits：只有摘要里给了全文的小节里某一条写错了才用，每项改一条：section 是小节序号，field 是 title、points、formulas、examples 之一，i 是第几条（title 不用写），text 是改正后的整条。没有要改的就给空数组。
- emphasis、terms 只写这一批新出现的，摘要里已有的不要再写；同一个意思不要换个说法再写一遍。
- homework 只写新的作业；摘要里已有的作业有了新信息（比如补了截止时间）才带 n（作业序号）把那一条重写一遍。
- 这一批没有新内容的类别给空数组，什么都没有就全给空数组。

要求：
- 用${L}写，术语、人名、模型名、书名保留原文。
${r.rules.replaceAll('{L}', L)}
- points、examples、emphasis 里提到符号或式子时写成行内公式 $...$，比如 "用 k-fold cross-validation 选 $\\\\lambda$"，不要把 \\\\lambda 这种命令不带 $ 直接写在文字里。homework 和 terms 用纯文字，不加 $。
- 反斜杠：输出的是 JSON，字符串里 LaTeX 的每个反斜杠都写成两个（\\\\lambda、\\\\text{ridge}、\\\\frac{a}{b}、\\\\rVert），JSON 解析后才是一个。只写一个会被当成转义，\\text、\\rVert、\\frac、\\beta、\\nabla 会变成制表符、回车、换页、退格、换行；写四个又会变成换行。
- 识别稿可能有错字（尤其是公式和术语），按上下文纠正；拿不准的不写。
- 不要用破折号。
只输出一个 JSON 对象，不要代码块，不要别的文字。`
  const parts = []
  if (context) parts.push(`${r.background}：${context}`)
  parts.push(`${r.date}：${dateLabel(startedAt)}。日历：\n${calendarText(startedAt)}\n${relativeDayHints(startedAt)}`)
  parts.push(prev ? `上一版笔记（摘要）：\n${notesDigest(prev)}` : `上一版笔记：${r.first}`)
  parts.push(`${r.lines.replace(/（.*$/, '')}：\n${linesText(lines)}`)
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/**
 * 课后课堂笔记（Markdown）。slides：[{ file, at }]（最多 6 张，图片由调用方附在消息后面）；
 * liveNotes：会中整理的实时笔记，给模型参考；materials：老师的课件（materials.js 的 materialsForNotes），
 * 文字逐页给，images 里的页附在截图后面。
 */
export function classNotesMessages({ session, project = null, extraAsk = '', slides = [], liveNotes = null, materials = null }) {
  const withMaterials = Boolean(materials?.text)
  const out = writeLang(session, project)
  const system = `你是一位细心的课堂笔记助手。用户刚听完一节课，下面是课堂的自动识别稿（可能有识别错误、缺标点；「老师」是授课老师，「我」是用户，我偶尔会在课上提问）。
请用${promptLang(out)}写一份课堂笔记，术语、人名、模型名、书名保留原文；公式用 LaTeX（行内用 $...$，单独一行的用 $$...$$）。要求：
- 只根据识别稿、实时笔记和截图写，不编造；识别稿里念出来的公式（比如 "y i minus theta transpose x i, squared"）还原成 LaTeX；拿不准的标「（待确认）」。
- 时间戳用识别稿里的 [mm:ss]。
- 相对日期换算成具体日期：上课日期是 ${dateLabel(session.startedAt)}，「next Wednesday」「this Sunday」「下周三」都算出日期并保留原话；「next + 星期几」按下一周的那一天算。
- 给了课件截图时，在讲到对应内容的地方用 ![简短说明](slides/文件名.jpg) 引用截图，路径照抄下面给的，没用上的截图不用硬塞。${
    withMaterials
      ? `
- 给了老师的课件时，对照课件和识别稿一起写：课件是老师准备的讲义，识别稿是老师实际讲的。大纲按老师讲的顺序；定义、公式、符号、术语和人名的写法以课件为准（识别稿里听错的按课件改）；老师口头补充的解释、例子、强调和课件上没有的内容都写进去；课件上有、课上没讲的简要写，标「（课件内容，课上没讲）」。
- 小节标题后面注明对应的课件页，比如「（课件 p.12 到 p.15）」。在讲到对应内容的地方用 ![课件第 N 页：简短说明](materials/…/pNNN.jpg) 插入那一页，路径照抄课件文字里每页标的路径；只插有图、表、公式推导或关键定义的页，一般 3 到 10 页；标题页、目录页、只有几行字的页不插，不要整份课件都插。`
      : ''
  }
- 不要用破折号。${templateRule(out)}

按下面的 Markdown 结构输出，没有内容的小节写「无」：

## 本节概览
（3 到 5 句：这节课讲了什么，主线是什么）
## 大纲与知识点
### [mm:ss] 小节标题
- 要点
## 公式与推导
（每个公式写清楚符号含义；老师推导过的写出推导步骤）
## 例子
## 老师强调和可能的考点
- 要点（[mm:ss] 原话："…"）
## 作业与截止
- [ ] 作业（截止：日期 / 无明确截止）  原话："…" [mm:ss]
## 术语表
| 英文 | 中文 | 解释 |
|---|---|---|
## 自测题
（3 到 5 道，覆盖本节重点，每道后面另起一行写「答案：…」）
## 没听清需要确认的地方`
  const parts = []
  if (project) {
    parts.push(`这节课属于「${project.name}」${project.description ? `（${project.description}）` : ''}`)
    if (project.context) parts.push(`课程背景：${project.context}`)
  }
  parts.push(`日历：\n${calendarText(session.startedAt)}\n${relativeDayHints(session.startedAt)}`)
  if (extraAsk) parts.push(`额外要求：${extraAsk}`)
  if (liveNotes) parts.push(`上课时整理的实时笔记（JSON，只作参考，以识别稿为准）：\n${JSON.stringify(liveNotes)}`)
  if (slides.length) parts.push(`课件截图（附在后面，按顺序）：\n${slides.map((x, i) => `${i + 1}. slides/${x.file.replace(/^slides\//, '')}（[${clock(x.at - session.startedAt)}] 截的）`).join('\n')}`)
  if (withMaterials) {
    parts.push(`老师的课件（逐页文字；标着「附图」的页，图附在${slides.length ? '课上截图后面' : '后面'}，按顺序：${materials.images.map((x) => x.label).join('、') || '无'}）：\n${materials.text}`)
  }
  parts.push(`识别稿（[分:秒] 说话人：内容）：\n${transcriptText(session)}`)
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/** 课堂的作业提取：输出同待办提取（{"title","items"}），全部归到这节课所属的项目。 */
export function classTodoMessages({ session, summary, project, liveNotes = null }) {
  const L = promptLang(writeLang(session, project))
  const system = `你是课堂助理，从一节课的课堂笔记和识别稿里提取作业、阅读任务、要交的东西、考试和截止时间，输出 JSON。
「老师」是授课老师，「我」是用户（学生）。

上课日期：${dateLabel(session.startedAt)}。日历：
${calendarText(session.startedAt)}
${relativeDayHints(session.startedAt)}
相对日期（next Wednesday、this Sunday、before Friday's lecture、下周三）都按上课日期换算成具体日期 YYYY-MM-DD；「next + 星期几」指下一周的那一天；只有月日没有年份的取上课日期之后最近的那一天；没说时间的 due 写 null。

规则：
- 只提取老师明确布置的、要我做或要注意的事：作业、阅读、项目、要交的报告、考试和测验。泛泛的建议不算。
- text：一句${L}，动词开头，具体到能照着做（写清楚是哪次作业、做什么）；术语、书名保留原文；不要用破折号。考试写成「准备 期中考试（范围：…）」这类。
- owner：作业和考试都是 me。
- dueText：原话里的时间说法，原样保留（比如 "next Wednesday before midnight"），没有写 null。
- quote：识别稿里的原话依据，原样保留英文，不超过 120 个字符。
- at：原话在识别稿里的时间戳（mm:ss 或 h:mm:ss），没有写 null。
- projectId 一律写 ${project?.id ?? 'inbox'}。
- 同一件事只写一条；没有就给空数组。
- title：给这节课起一个简短的${L}标题（不超过 20 个字或 8 个词），说清楚讲了什么。

只输出一个 JSON 对象，不要代码块，不要别的文字：
{"title":"…","items":[{"text":"…","due":"YYYY-MM-DD","dueText":"…","owner":"me","projectId":"${project?.id ?? 'inbox'}","quote":"…","at":"mm:ss"}]}`
  const parts = []
  if (summary) parts.push(`课堂笔记：\n${summary}`)
  if (liveNotes?.homework?.length) parts.push(`上课时记下的作业（只作参考）：\n${JSON.stringify(liveNotes.homework)}`)
  parts.push(`识别稿（[分:秒] 说话人：内容）：\n${transcriptText(session)}`)
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/**
 * 图文版课堂笔记：把老师讲的点对到课件的行上。sections：笔记「大纲与知识点」里的小节标题（按顺序）；
 * materialsText：materials.js 的 materialsForMap(...).text（每页的文字行编了号）。
 */
export function slideMapMessages({ session, markdown, sections, materialsText }) {
  const L = promptLang(writeLang(session))
  const system = `你在帮用户做一份图文版课堂笔记：老师是对着课件讲课的，把课件页插在老师讲到它的地方，在页上框出老师对着讲的那几行，旁边写老师讲了什么。
下面给你课堂笔记（Markdown）、笔记里「大纲与知识点」的小节（编了号）、老师的课件（每页的文字行编了号）和课堂识别稿（[分:秒] 说话人：内容；「老师」是授课老师）。

输出 JSON：
{"pages":[{"m":"课件 id","p":页码,"s":小节编号,"points":[{"l":[行号],"t":"老师怎么讲这一点","at":"mm:ss","q":"原话"}]}]}

要求：
- 只列老师课上讲到的页（识别稿里老师念到、解释或举例的内容在这一页上），按讲的先后排。标题页、目录页、课上没讲的页不列。
- s：这一页的内容属于笔记的哪个小节，写小节编号。
- points：老师对着这一页讲的每一个点，按讲的先后，一页 1 到 6 条。
  - l：这一点对应课件上的哪几行，写行号，1 到 4 行，挑最贴切的；讲的是页上的图、或者整页都在讲同一件事时给空数组。
  - t：用${L}一两句写老师怎么讲这一点（解释、举的例子、补充、强调），不要只把课件那一行翻译一遍；术语、人名保留英文；式子写成行内公式 $...$，JSON 里 LaTeX 的反斜杠写两个。
  - at：识别稿里讲这一点的时间（mm:ss）。q：老师的原话，照识别稿原样保留，不超过 120 个字符。
- 只根据识别稿和课件写，不编造。不要用破折号。
只输出一个 JSON 对象，不要代码块，不要别的文字。`
  const parts = [
    `课堂笔记：\n${markdown}`,
    `大纲与知识点的小节：\n${sections.map((t, i) => `${i + 1}. ${t}`).join('\n') || '（没有小节）'}`,
    `老师的课件（[课件 id 第 N 页]，下面每行前面是行号）：\n${materialsText}`,
    `识别稿（[分:秒] 说话人：内容）：\n${transcriptText(session)}`,
  ]
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}
