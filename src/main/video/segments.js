import { splitSentences } from '../text.js'

// 识别出来的一段段话 → 存档里的字幕段落（同会议、课堂一样的形状：id、source、speaker、who、startedAt、text、sentences）。
// 视频里每一句单独成一段，这样每一行都有自己的时间，点一下视频能跳到那一句。
// startedAt = 会议文件夹的开始时间 + 视频里的毫秒，界面显示的位置 = startedAt - session.startedAt，和别的会议一样。
// seg.dur 是这一句持续多久（毫秒），界面用它判断播放到哪一句；seg.sp 是第几个说话人（会议视频，从 0 起）。

const isCjk = (s) => /[぀-ヿ㐀-鿿가-힯]/.test(s)

/**
 * utterances：[{ startMs, endMs, text }]；返回 { segments, sentences }，sentences 是和 segments 一一对应的 { startMs, endMs, text }（分说话人用）。
 * 一段话里有几句，按字数把这段话的时间分给各句。
 */
export function buildSegments(utterances, { lang = 'en', baseAt, speaker = '' } = {}) {
  const segments = []
  const sentences = []
  let n = 0
  for (const u of utterances) {
    const text = String(u.text ?? '').trim()
    if (!text) continue
    const parts = splitSentences(text, lang).filter((x) => x.length > 0)
    const total = parts.reduce((a, x) => a + x.length, 0) || 1
    const span = Math.max(300, u.endMs - u.startMs)
    let at = u.startMs
    parts.forEach((p, i) => {
      const dur = i === parts.length - 1 ? u.startMs + span - at : Math.round((span * p.length) / total)
      const s = { startMs: Math.round(at), endMs: Math.round(at + Math.max(dur, 200)), text: p }
      sentences.push(s)
      segments.push({
        id: `v${++n}`,
        source: 'system',
        speaker,
        who: 'other',
        startedAt: baseAt + s.startMs,
        dur: s.endMs - s.startMs,
        text: p,
        sentences: [{ text: p }],
      })
      at += dur
    })
  }
  return { segments, sentences }
}

/** 给每一段标说话人：labels 是每一段的序号（0 起），names 是各人的称呼。 */
export function applySpeakers(segments, labels, names) {
  segments.forEach((s, i) => {
    s.sp = labels[i] ?? 0
    s.speaker = names[s.sp] ?? names[0] ?? ''
  })
}

/** 译文填回去：tr[i] 是第 i 段的译文，null（没翻出来）和空串（本来就是目标语言）不写。 */
export function applyTranslations(segments, tr) {
  segments.forEach((s, i) => {
    if (tr[i]) s.sentences[0].tr = tr[i]
  })
}

export { isCjk }
