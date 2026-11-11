// 视频模式的场次规则（用户定，2026-11-11）：
//   本地识别、只出原文字幕和 SRT：不用场次，会员也一样；
//   用到会员 AI（翻译、笔记、纪要），不管本地还是云识别：每 2 小时视频 1 场（2 小时以内 1 场，2 到 4 小时 2 场，以此类推）；
//   会员云识别：同样每 2 小时 1 场；
//   自带 Key：不用场次；
//   还带着早先试用场次的设备（最长 1 小时一场）：试用的 1 场只管 1 小时以内的视频，长的按每小时 1 场算，试用余额不够就得买。
// 后台那边一场只按开着的时间算（记录中每 30 秒心跳），不认识「视频有多长」，所以应用把视频按每场能管的时长切成几段，
// 一段开一场（member.startSession 扣一场）、做完这一段结束它，见 job.js。界面只说「这个视频用 N 场」或「不用场次」，不出价格。

export const HOUR = 3600_000
export const SESSION_MS = 2 * HOUR
export const TRIAL_SESSION_MS = HOUR

/** 一场管多久：买过场次的 2 小时，只有试用的 1 小时。 */
export const unitMs = (trial) => (trial ? TRIAL_SESSION_MS : SESSION_MS)

/** 这个时长的视频要几场（至少 1）：恰好 2 小时是 1 场。 */
export const sessionsFor = (durationMs, unit = SESSION_MS) => Math.max(1, Math.ceil(Math.max(0, durationMs) / unit - 1e-9))

/**
 * 这次处理要几场。
 * plan：'member' | 'own'；recognition：'local' | 'cloud'；ai：要不要用 AI（翻译、笔记、纪要任一项）；trial：设备上只有试用场次。
 * → { sessions, unit }；sessions 为 0 就是「不用场次」。
 */
export function videoCharge({ plan, recognition, ai, durationMs, trial = false }) {
  const unit = unitMs(trial)
  if (plan !== 'member') return { sessions: 0, unit }
  if (recognition === 'local' && !ai) return { sessions: 0, unit }
  return { sessions: sessionsFor(durationMs, unit), unit }
}

/** 余额够不够：→ { ok, need, have }。 */
export function enough(sessions, balance) {
  const have = Math.max(0, Number(balance) || 0)
  return { ok: have >= sessions, need: sessions, have }
}

/** 视频按每场管的时长切成几段：[{ from, to }]（毫秒）。不用场次时就一段。 */
export function segmentsFor(durationMs, sessions, unit = SESSION_MS) {
  if (sessions <= 1) return [{ from: 0, to: durationMs }]
  const out = []
  for (let i = 0; i < sessions; i++) out.push({ from: i * unit, to: i === sessions - 1 ? durationMs : (i + 1) * unit })
  return out
}
