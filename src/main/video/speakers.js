import { cosine } from '../audio/voiceprint.js'

// 会议视频里分说话人：识别出来的每一句取一段音频算声纹向量（CAM++，和开会时认「我」用的同一个模型），
// 按时间顺序聚类：和已有的哪一类像（余弦相似度 ≥ 阈值）就归哪一类，都不像就开新的一类；再按类的中心重新归一遍，合并过近的类。
// 太短（不到 1 秒有效语音）的句子没法算向量，跟着前一句；整段一个人说话就只有「说话人 1」。
// 云识别和本地识别都走这一套，不依赖 Soniox 自带的分人（分块并行认的时候各块的编号对不上）。
// 只看声音，不知道谁是谁，之后用户在界面上把「说话人 2」改成真名。

export const THRESHOLD = 0.55
export const MAX_SPEAKERS = 8

const mean = (vs) => {
  const out = new Float32Array(vs[0].length)
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i]
  let n = 0
  for (let i = 0; i < out.length; i++) n += out[i] * out[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < out.length; i++) out[i] /= n
  return out
}

/**
 * items：[{ embedding: Float32Array | null }]，按时间排；返回每一项的说话人序号（0 起，按第一次出现的先后）。
 * embedding 为 null 的项跟前一项（前面没有的跟后面第一个有的）。
 */
export function clusterEmbeddings(items, { threshold = THRESHOLD, maxSpeakers = MAX_SPEAKERS } = {}) {
  const idx = items.map((x, i) => (x.embedding ? i : -1)).filter((i) => i >= 0)
  if (!idx.length) return items.map(() => 0)
  // 1. 顺序归类
  let centers = []
  let members = []
  const label = new Map()
  for (const i of idx) {
    const e = items[i].embedding
    let best = -1
    let bestScore = threshold
    centers.forEach((c, k) => {
      const s = cosine(c, e)
      if (s >= bestScore) [best, bestScore] = [k, s]
    })
    if (best < 0) {
      centers.push(e)
      members.push([e])
      best = centers.length - 1
    } else {
      members[best].push(e)
      centers[best] = mean(members[best])
    }
    label.set(i, best)
  }
  // 2. 按类的中心重新归一遍（早期的类中心不准，开头几句可能归错），两轮
  for (let round = 0; round < 2; round++) {
    const next = centers.map(() => [])
    for (const i of idx) {
      const e = items[i].embedding
      let best = 0
      let bestScore = -2
      centers.forEach((c, k) => {
        const s = cosine(c, e)
        if (s > bestScore) [best, bestScore] = [k, s]
      })
      label.set(i, best)
      next[best].push(e)
    }
    const keep = next.map((m, k) => (m.length ? k : -1)).filter((k) => k >= 0)
    centers = keep.map((k) => mean(next[k]))
    const remap = new Map(keep.map((k, n) => [k, n]))
    for (const i of idx) label.set(i, remap.get(label.get(i)))
    members = keep.map((k) => next[k])
  }
  // 3. 太小的类（不到 3 句）、超出上限的类并进最像的那一类
  const fold = (small) => {
    const sizes = members.map((m) => m.length)
    const target = centers.map((_, k) => k).filter((k) => !small.has(k))
    if (!target.length) return
    for (const k of small) {
      let best = target[0]
      let bestScore = -2
      for (const t of target) {
        const s = cosine(centers[k], centers[t])
        if (s > bestScore) [best, bestScore] = [t, s]
      }
      for (const i of idx) if (label.get(i) === k) label.set(i, best)
      sizes[best] += sizes[k]
    }
  }
  const smallSet = new Set(members.map((m, k) => (m.length < 3 && members.length > 1 ? k : -1)).filter((k) => k >= 0))
  if (smallSet.size < members.length) fold(smallSet)
  // 重编号：按第一次出现的先后
  const order = []
  for (const i of idx) if (!order.includes(label.get(i))) order.push(label.get(i))
  if (order.length > maxSpeakers) {
    const count = new Map(order.map((k) => [k, 0]))
    for (const i of idx) count.set(label.get(i), count.get(label.get(i)) + 1)
    const keep = [...order].sort((a, b) => count.get(b) - count.get(a)).slice(0, maxSpeakers)
    const cs = new Map()
    for (const k of order) cs.set(k, mean(idx.filter((i) => label.get(i) === k).map((i) => items[i].embedding)))
    for (const i of idx) {
      const k = label.get(i)
      if (keep.includes(k)) continue
      let best = keep[0]
      let bestScore = -2
      for (const t of keep) {
        const s = cosine(cs.get(k), cs.get(t))
        if (s > bestScore) [best, bestScore] = [t, s]
      }
      label.set(i, best)
    }
    order.splice(0, order.length, ...order.filter((k) => keep.includes(k)))
  }
  const num = new Map(order.map((k, n) => [k, n]))
  const out = []
  let prev = null
  for (let i = 0; i < items.length; i++) {
    if (label.has(i)) prev = num.get(label.get(i))
    out.push(prev)
  }
  // 开头没有向量的几项跟后面第一个有的
  const first = out.find((x) => x != null) ?? 0
  return out.map((x) => x ?? first)
}

/**
 * 给每一句分说话人。sentences：[{ startMs, endMs }]；readPcm(fromMs, toMs) → Int16Array；
 * scorer：{ scorePcm(pcm, rate) → Promise<{ embedding, seconds } | null> }。
 * → { labels: number[], count }
 */
export async function labelSpeakers(sentences, { readPcm, scorer, onProgress, signal, ...opts }) {
  const items = []
  for (let i = 0; i < sentences.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const s = sentences[i]
    let embedding = null
    if (s.endMs - s.startMs >= 1200) {
      const pcm = await readPcm(s.startMs, Math.min(s.endMs, s.startMs + 8000))
      const r = await scorer.scorePcm(pcm, 16000).catch(() => null)
      embedding = r?.seconds >= 0.8 ? r.embedding : null
    }
    items.push({ embedding })
    if (i % 20 === 0) onProgress?.(i / sentences.length)
  }
  const labels = clusterEmbeddings(items, opts)
  return { labels, count: labels.length ? Math.max(...labels) + 1 : 0 }
}
