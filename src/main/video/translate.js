import { noDashes } from '../prompts.js'
import { isChinese, needsTranslation, promptLang } from '../languages.js'
import { t } from '../i18n.js'

// 视频模式的翻译：整份字幕已经在手里，不用像实时字幕那样一句一个请求、每句都带一大段上下文。
// 把连着的十几句装成一批，只带前两句当上文，一个请求回一个 JSON 数组。
// 两小时的密集英语（约 2 万词、700 句）一共约 50 个请求，用量见 docs/视频模式.md 里的实测；译文请求不带意群和术语（视频字幕按一句一句的对照看）。

export const BATCH_SENTENCES = 14
export const BATCH_CHARS = 1600 // 中文按这个的 40%
const CONTEXT_SENTENCES = 2

/** 一批的提示。sentences：这一批要翻的（字符串）；previous：上文（只参考）。 */
export function batchMessages({ sentences, previous = [], target, source = 'en', context = '', keywords = [] }) {
  const lang = promptLang(target)
  const system = [
    `你是视频字幕翻译员，把视频里的发言翻译成${lang}字幕。${source && source !== 'auto' ? `发言的语言是${promptLang(source)}。` : ''}`,
    `要求：忠实原意，口语自然，简洁；人名、机构名、缩写、模型/数据集/工具名保留原文；${isChinese(target) ? '有通行中文说法的专业术语翻成中文；' : ''}数字、日期必须准确。`,
    '识别稿可能有错字或断句不全，按上下文理解，不要评论。',
    context ? `视频背景：${context}` : '',
    keywords?.length ? `术语表（识别稿里这些词的正确拼写；专有名词和缩写保留原文）：${keywords.join('、')}` : '',
    `输出一个 JSON 对象 {"tr":["第 1 句的译文","第 2 句的译文",…]}：tr 的个数和要翻的句数一样，顺序一样，一句对一句，不合并不拆开；不要别的文字。`,
  ]
    .filter(Boolean)
    .join('\n')
  const user = `${previous.length ? `上文（只作参考，不要翻译）：\n${previous.join('\n')}\n\n` : ''}要翻译的 ${sentences.length} 句：\n${sentences.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 模型回的 JSON → 译文数组；个数对不上、不是 JSON、有空的返回 null。 */
export function parseBatch(raw, n) {
  let j
  try {
    const s = String(raw ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1))
  } catch {
    return null
  }
  const tr = j?.tr
  if (!Array.isArray(tr) || tr.length !== n) return null
  const out = tr.map((x) => noDashes(String(x ?? '')).trim().replace(/^\d+[.、)）]\s*/, ''))
  return out.some((x) => !x) ? null : out
}

/** 把要翻的句子（下标）装成批：最多 BATCH_SENTENCES 句、BATCH_CHARS 个字符（中文按 40%）。 */
export function makeBatches(texts, indexes, { cjk = false } = {}) {
  const limit = cjk ? BATCH_CHARS * 0.4 : BATCH_CHARS
  const out = []
  let cur = []
  let chars = 0
  for (const i of indexes) {
    const len = texts[i].length
    if (cur.length && (cur.length >= BATCH_SENTENCES || chars + len > limit)) {
      out.push(cur)
      cur = []
      chars = 0
    }
    cur.push(i)
    chars += len
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * 翻译整份字幕。texts：每句的原文；llm(opts) → Promise<string>（main.js 的 llm，会员通道换凭据在里面）。
 * 已经是目标语言的句子（判出来的语言和 target 一样）不翻，译文留空。
 * → { tr: (string|null)[]，没翻出来的是 null, failed: 没翻出来的句数, usage: { in, out, calls } }
 */
export async function translateAll({ texts, llm, target, source = 'en', context = '', keywords = [], concurrency = 3, onProgress, signal }) {
  const tr = texts.map(() => null)
  const usage = { in: 0, out: 0, calls: 0 }
  const todo = []
  texts.forEach((x, i) => {
    if (needsTranslation(x, source, target)) todo.push(i)
    else tr[i] = ''
  })
  const batches = makeBatches(texts, todo, { cjk: source === 'zh' || source === 'ja' || source === 'ko' })
  let next = 0
  let done = 0
  const call = async (idx) => {
    const previous = []
    for (let k = idx[0] - 1; k >= 0 && previous.length < CONTEXT_SENTENCES; k--) previous.unshift(texts[k])
    const [system, user] = batchMessages({ sentences: idx.map((i) => texts[i]), previous, target, source, context, keywords })
    const raw = await llm({
      model: 'fast',
      system: system.content,
      messages: [user],
      effort: 'none',
      json: true,
      timeoutMs: 60_000,
      signal,
      onUsage: (u) => {
        usage.in += Number(u?.prompt_tokens ?? u?.input_tokens ?? 0)
        usage.out += Number(u?.completion_tokens ?? u?.output_tokens ?? 0)
        usage.calls++
      },
    })
    return parseBatch(raw, idx.length)
  }
  // 一批没回对（个数不对、空译文、超时）先再试一次，还不行就对半拆开；单句最多试三次
  const run = async (idx, depth = 0) => {
    let got = null
    const tries = idx.length === 1 ? 3 : 2
    for (let k = 0; k < tries && !got; k++) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      try {
        got = await call(idx)
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e
        // 没 Key、场次用完、用量到上限：再试也没用，整个翻译停下来报给用户
        if (e.code === 'not-logged-in' || [401, 402].includes(e.status) || e.code === 'usage-limit' || e.code === 'session-ai-limit' || e.code === 'exhausted') throw e
        await new Promise((r) => setTimeout(r, 1500 * (k + 1)))
      }
    }
    if (got) idx.forEach((i, k) => (tr[i] = got[k]))
    else if (idx.length > 1 && depth < 4) {
      const mid = idx.length >> 1
      await run(idx.slice(0, mid), depth + 1)
      await run(idx.slice(mid), depth + 1)
    }
  }
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++]
      await run(b)
      done += b.length
      onProgress?.(done, todo.length)
    }
  }
  const errs = []
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker().catch((e) => ((next = batches.length), errs.push(e)))))
  if (errs.length) throw errs[0]
  return { tr, failed: tr.filter((x) => x === null).length, usage }
}

export const translateError = (e) => t(`翻译没做完：{0}`, e.message)
