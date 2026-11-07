// 译文速度计时：对方每句话从说完到译文出现，中间每一段花了多久。只进 trace（speed-row）和停止时的汇总（speed），不进界面。
// 一行 = 一次译文请求（kind: final 整句 | prov 长句前半的临时译文）。时间都是毫秒时间戳：
//   speechEnd      这句话最后一个字的音频位置换成的时间（段落的 span 按字数比例估到这一句，最后一句就是 span.end）
//   completeAt     知道这句话说完了（识别事件到达，下一句开头出现 / 定稿 / 定稿的字里已经带句末标点）
//   queuedAt       请求排进队列
//   sentAt         请求真正发出（扣掉答题让路、限流退避的等待）
//   firstTokenAt   AI 回的第一段内容
//   firstVisibleAt 译文第一次出现在字幕上（流式时是第一个字）
//   fullAt         完整译文出现在字幕上
//   doneAt         整个回复解析完（意群颜色、术语到了）

/** 升序数组里的分位数（最近排名法）。 */
function quantile(sorted, q) {
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]
}

/** 一组毫秒数 → { n, median, p90 }，没有数据时 n 为 0。 */
export function stats(list) {
  const a = list.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
  if (!a.length) return { n: 0, median: null, p90: null }
  const mid = a.length >> 1
  const median = a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
  return { n: a.length, median: Math.round(median), p90: Math.round(quantile(a, 0.9)) }
}

const diff = (a, b) => (a != null && b != null ? a - b : null)

export class SpeedLog {
  constructor() {
    this.rows = []
    this.latest = new Map() // `${kind}:${text}` → 最新一行
    this.tokens = { final: { in: 0, out: 0, cached: 0, calls: 0 }, prov: { in: 0, out: 0, cached: 0, calls: 0 } }
  }

  open(kind, text, info = {}) {
    const row = { kind, text, ...info, queuedAt: Date.now(), attempts: 0, speechEnd: null }
    this.rows.push(row)
    this.latest.set(`${kind}:${text}`, row)
    return row
  }

  row(kind, text) {
    return this.latest.get(`${kind}:${text}`) ?? null
  }

  sent(row) {
    if (!row) return
    row.attempts++
    row.sentAt = Date.now()
    row.firstTokenAt = null // 重试时重新算
  }

  first(row) {
    if (row && row.firstTokenAt == null) row.firstTokenAt = Date.now()
  }

  /** 译文出现在字幕上：full 为 true 是完整译文。 */
  visible(row, full) {
    if (!row) return
    const now = Date.now()
    row.firstVisibleAt ??= now
    if (full) row.fullAt ??= now
  }

  done(row) {
    if (!row || row.doneAt) return
    row.doneAt = Date.now()
  }

  fail(row, error) {
    if (!row || row.doneAt) return
    row.failedAt = Date.now()
    row.error = String(error ?? '')
  }

  /** AI 服务报的用量（只在 MEETCAPTION_SPEED_USAGE=1 时才向服务要）。 */
  usage(row, u) {
    if (!row || !u) return
    const t = this.tokens[row.kind] ?? this.tokens.final
    t.calls++
    t.in += u.prompt_tokens ?? 0
    t.out += u.completion_tokens ?? 0
    t.cached += u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0
  }

  /**
   * 一段定稿后，把这段里各句的 speechEnd 算出来。ends：这段定稿后每一句（识别原文）→ 它结束在段落文字的第几个字；
   * total：段落文字总长；span：这一路音频里的 { start, end } 毫秒；wall：音频毫秒 → 时间戳。
   */
  settle(segId, ends, total, span, wall) {
    if (!span || !(span.end >= span.start)) return
    for (const row of this.rows) {
      if (row.segId !== segId || row.speechEnd != null) continue
      const end = (row.kind === 'final' ? ends.get(row.text) : null) ?? row.endChar
      if (end == null) continue
      row.speechEnd = Math.round(wall(span.start + (span.end - span.start) * Math.min(1, end / Math.max(1, total))))
    }
  }

  /** 每一句的第一次译文出现的时间：整句的请求，或者它前半的临时译文，取早的。 */
  firstVisible(row) {
    let at = row.firstVisibleAt
    for (const p of this.rows) {
      if (p.kind !== 'prov' || p.segId !== row.segId || p.firstVisibleAt == null || !row.text.startsWith(p.text)) continue
      at = at == null ? p.firstVisibleAt : Math.min(at, p.firstVisibleAt)
    }
    return at
  }

  /** 停止时的汇总：语音结束 → 第一个字 / 完整译文的中位数和 p90，每一段各花多久，多发了多少请求和 token。 */
  summary() {
    const finals = this.rows.filter((r) => r.kind === 'final' && r.fullAt != null && r.speechEnd != null)
    const of = (f) => stats(finals.map(f))
    const provs = this.rows.filter((r) => r.kind === 'prov')
    const reasons = {}
    for (const r of this.rows.filter((x) => x.kind === 'final')) reasons[r.reason ?? '?'] = (reasons[r.reason ?? '?'] ?? 0) + 1
    return {
      sentences: finals.length,
      speechEndToFirstVisible: of((r) => diff(this.firstVisible(r), r.speechEnd)),
      speechEndToFullVisible: of((r) => diff(r.fullAt, r.speechEnd)),
      speechEndToDone: of((r) => diff(r.doneAt, r.speechEnd)),
      stages: {
        speechEndToComplete: of((r) => diff(r.completeAt, r.speechEnd)),
        queueToSent: of((r) => diff(r.sentAt, r.queuedAt)),
        sentToFirstToken: of((r) => diff(r.firstTokenAt, r.sentAt)),
        firstTokenToFirstVisible: of((r) => diff(r.firstVisibleAt, r.firstTokenAt)),
        firstVisibleToFull: of((r) => diff(r.fullAt, r.firstVisibleAt)),
        fullToDone: of((r) => diff(r.doneAt, r.fullAt)),
      },
      requests: {
        final: this.rows.filter((r) => r.kind === 'final').length,
        retries: this.rows.reduce((n, r) => n + Math.max(0, r.attempts - 1), 0),
        provisional: provs.length,
        failed: this.rows.filter((r) => r.error).length,
      },
      completeBy: reasons,
      tokens: this.tokens,
    }
  }
}
