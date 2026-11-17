import { cosine } from './audio/voiceprint.js'
import { t } from './i18n.js'

// 实时分说话人：Soniox 每条连接自己给说话人编号（"1"、"2"…），这里把编号对到这一场的「人」上，再给人起显示的名字。
//
// 同一条连接里编号就是人，照用。新连接（断线重连、会员换 Key、暂停后继续）编号从 1 重来，第一次见到一个编号时对回之前的人：
// 有这一句的声纹向量（CAM++，和认「我」的同一个模型）就和之前每个人的平均向量比，够像（≥ MATCH）就是他，都不像算新的人；
// 没有向量（太短、模型没加载上）时，新连接里第一个开口的算断线前最后说话的那个人（新连接从断开处补发，多半是同一个人接着说），
// 其余的算新的人。限制：没有向量时重连后第二个开口的人会多出一个编号，改名时要改两次。
//
// Soniox 实时分人开着端点检测时会把同一个人句末后面的一两句短句标成别人（2026-11-17 实测 13 句错 2 句），
// 所以一句话的向量明显是另一个人（和他的平均向量 ≥ FIX_MIN，比和自己编号的人高出 FIX_GAP）时，这一句改记到那个人名下。
//
// 名字：改过名的用改的名字；课堂里讲得最多的叫「老师」（被别人反超一截才换人，免得来回跳）；开会、面试只有一个人时叫「对方」；
// 其余按第一次以别人的身份说话的先后叫「说话人 1、2、3」。声纹判成我的句子显示「我」，不算进这里的字数，也不占编号。

export const MATCH = 0.6
export const FIX_MIN = 0.7
export const FIX_GAP = 0.25
const OWN_UNKNOWN = 0.45 // 自己编号的人还没有平均向量时，按这个分数比
const TEACHER_LEAD = 1.2 // 课堂换老师：字数要超过现在的老师这么多倍，再多 TEACHER_EXTRA 个字
const TEACHER_EXTRA = 30
const CENTER_CAP = 20 // 平均向量最多按这么多句算权重，之后新句子分量不变小（人换了位置、麦克风远近变了能跟上）

export class SpeakerBook {
  constructor({ mode = 'meeting' } = {}) {
    this.mode = mode
    this.people = [] // { source, no, custom, chars, center, n, me, other }
    this.streams = new Map() // 连接 → { source, labels: Map(编号 → 人), reconnect }
    this.last = new Map() // 声音来源 → 最后一个说话的人
    this.numbered = 0 // 已经以别人的身份说过话、有了编号的人数
    this.teacher = null
  }

  /** 说话过程中先猜是谁（不记账）：见过的编号直接给；新连接里第一个开口的猜断线前最后说话的人；猜不出是 null。 */
  guess(source, { stream, label }) {
    const st = this.streams.get(stream)
    const known = st?.labels.get(label)
    if (known != null) return known
    if (!this.#reconnect(source, st)) return null
    return st?.labels.size ? null : (this.last.get(source) ?? null)
  }

  /** 一句定稿了：编号第一次见的这时候对上人。emb：这一句的声纹向量，没有是 null。→ 这一句算谁的 */
  place(source, { stream, label }, emb = null) {
    let st = this.streams.get(stream)
    if (!st) {
      st = { source, labels: new Map(), reconnect: this.#reconnect(source, null) }
      this.streams.set(stream, st)
    }
    let idx = st.labels.get(label)
    if (idx == null) {
      idx = st.reconnect ? this.#match(source, st, emb) : null
      idx ??= this.#add(source)
      st.labels.set(label, idx)
    }
    return this.#fix(idx, emb) ?? idx
  }

  /** 这个人正在说（还没定稿）：断线时多半就是他说到一半，新连接第一个开口的先算他 */
  speaking(source, idx) {
    if (this.people[idx]) this.last.set(source, idx)
  }

  /** 这一句定下是谁说的以后记账：who 是 me 的只记次数（short 的「是我吗」用），别人的记字数、给编号、更新平均向量、看老师要不要换。 */
  heard(idx, { who, chars = 0, emb = null }) {
    const p = this.people[idx]
    if (!p) return
    if (who === 'me') {
      p.me++
      return
    }
    p.other++
    p.chars += chars
    p.no ??= ++this.numbered
    if (emb) {
      const w = Math.min(p.n, CENTER_CAP)
      const c = new Float32Array(emb.length)
      for (let i = 0; i < c.length; i++) c[i] = (p.center ? p.center[i] * w : 0) + emb[i]
      p.center = normalize(c)
      p.n++
    }
    this.last.set(p.source, idx)
    if (this.mode === 'class') this.#pickTeacher()
  }

  /** 显示的名字；idx 是 null（还猜不出是谁）时给新来的人会用的名字。 */
  name(idx) {
    const p = idx == null ? null : this.people[idx]
    if (p?.custom) return p.custom
    const no = p?.no ?? this.numbered + 1
    if (this.mode === 'class') {
      if (idx != null && idx === this.teacher) return t('老师')
      if (this.teacher == null && !p?.no) return t('老师')
    } else if (this.numbered <= 1 && no === 1) return t('对方')
    return t('说话人 {0}', no)
  }

  /** 每个人现在的名字，下标就是人（存进 session.speakers） */
  names() {
    return this.people.map((_, i) => this.name(i))
  }

  rename(idx, name) {
    const p = this.people[idx]
    if (!p) throw new Error(t('找不到这个说话人'))
    p.custom = name
  }

  /** 这个编号的句子大多被声纹认成我：太短打不了分的那几句也跟着算我 */
  mostlyMe(idx) {
    const p = idx == null ? null : this.people[idx]
    return Boolean(p && p.me >= 2 && p.me > p.other)
  }

  // 同一路声音之前有过别的连接给过编号：这条是重连后的新连接
  #reconnect(source, self) {
    for (const st of this.streams.values()) if (st !== self && st.source === source && st.labels.size) return true
    return false
  }

  #add(source) {
    this.people.push({ source, no: null, custom: null, chars: 0, center: null, n: 0, me: 0, other: 0 })
    return this.people.length - 1
  }

  // 新连接里的新编号：和这一路之前的人比声纹，这条连接里已经对上的人不算
  #match(source, st, emb) {
    const taken = new Set(st.labels.values())
    const cands = this.people.map((p, i) => i).filter((i) => this.people[i].source === source && !taken.has(i))
    const withCenter = cands.filter((i) => this.people[i].center)
    if (emb && withCenter.length) {
      let best = null
      let score = MATCH
      for (const i of withCenter) {
        const s = cosine(this.people[i].center, emb)
        if (s >= score) [best, score] = [i, s]
      }
      return best
    }
    if (st.labels.size) return null
    const last = this.last.get(source)
    return last != null && cands.includes(last) ? last : null
  }

  // 这一句的声音明显是另一个人（Soniox 标错了）：返回那个人，否则 null
  #fix(idx, emb) {
    if (!emb) return null
    const own = this.people[idx]
    const ownScore = own.center && own.n >= 2 ? cosine(own.center, emb) : OWN_UNKNOWN
    let best = null
    let score = Math.max(FIX_MIN, ownScore + FIX_GAP)
    this.people.forEach((p, i) => {
      if (i === idx || p.source !== own.source || !p.center || p.n < 2) return
      const s = cosine(p.center, emb)
      if (s >= score) [best, score] = [i, s]
    })
    return best
  }

  #pickTeacher() {
    let best = null
    this.people.forEach((p, i) => {
      if (p.no && (best == null || p.chars > this.people[best].chars)) best = i
    })
    if (best == null || best === this.teacher) return
    const cur = this.teacher == null ? null : this.people[this.teacher]
    if (!cur || this.people[best].chars > cur.chars * TEACHER_LEAD + TEACHER_EXTRA) this.teacher = best
  }
}

function normalize(v) {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}
