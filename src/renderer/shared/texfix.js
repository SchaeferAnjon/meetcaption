/*
 * 实时笔记里的 LaTeX：修好 JSON 转义弄坏的反斜杠，把文字切成「纯文字」和「行内公式」两种片段。
 * 普通脚本，挂在 window.texfix（Node 里 import 后在 globalThis.texfix）。主进程解析实时笔记时用 repair，
 * 主窗口画实时笔记时用 repair 和 split（老版本存下来的笔记也照样修）。
 *
 * 模型在 JSON 字符串里常把 LaTeX 的反斜杠只写一个：\text 的 \t 被 JSON.parse 当成制表符，\rVert 的 \r 成了回车，
 * \frac、\beta 的 \f、\b 成了换页、退格，\nabla 的 \n 成了换行；受约束的 JSON 模式里还会出现 \u0002lambda 这种；
 * 反过来写四个的，解析后是 \\lambda，KaTeX 当成换行加一个单词。
 */
;(function (root) {
  'use strict'

  // \n 开头的常用命令去掉 n 以后剩下的部分：换行后面紧跟这些才当成被吃掉的 \n
  const N_FORMULA = /\n(?=(?:abla|eq|e|u|i|ot|otin|eg|mid|leq|geq|exists|ewline|atural|parallel|subseteq|supseteq|cong|sim|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|earrow|warrow|olimits|onumber|otag)(?![A-Za-z]))/g
  // 文字里单字母的 \ne、\nu、\ni 不猜（换行后面跟一个 e 的普通文字更常见）
  const N_TEXT = /\n(?=(?:abla|eq|ot|otin|eg|mid|leq|geq|exists|atural|parallel|subseteq|supseteq|cong|sim|rightarrow|leftarrow|Rightarrow|Leftarrow|leftrightarrow|earrow|warrow)(?![A-Za-z]))/g

  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v))

  /**
   * 修 JSON 转义弄坏的 LaTeX。formula：整条都是公式（多行环境里的 \\ 换行不动）；否则是一句笔记文字。
   * 控制字符后面紧跟字母的还原成反斜杠命令，剩下的控制字符换成空格；两个以上反斜杠紧跟命令名的并成一个。
   */
  function repair(v, { formula = false } = {}) {
    let s = str(v)
    if (!/[\x00-\x1f\\]/.test(s)) return s
    s = s
      .replace(/\t(?=[A-Za-z])/g, '\\t')
      .replace(/\x08(?=[A-Za-z])/g, '\\b')
      .replace(/\f(?=[A-Za-z])/g, '\\f')
      .replace(/\r(?=[A-Za-z])/g, '\\r')
      .replace(formula ? N_FORMULA : N_TEXT, '\\n')
      .replace(/[\x00-\x08\x0b\x0e-\x1f](?=[A-Za-z])/g, '\\')
      .replace(/[\x00-\x1f]+/g, ' ')
    if (!formula || !/&|\\begin\{/.test(s)) s = s.replace(/\\{2,}(?=[A-Za-z|{},;:!%_#])/g, '\\')
    return s
  }

  // 已经包好的行内公式：$$…$$、\(…\)、\[…\]、$…$（$ 后面不是空格、前面不是空格、后面不跟数字，$5 这种钱数不算）
  const DELIMITED = /\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g

  // s[i] 是 {：配对的 } 后面一位，配不上返回 -1
  function group(s, i) {
    let depth = 0
    for (let j = i; j < s.length; j++) {
      if (s[j] === '\\') j++
      else if (s[j] === '{') depth++
      else if (s[j] === '}' && --depth === 0) return j + 1
    }
    return -1
  }

  // s[i] 是反斜杠：命令连同后面紧跟的 {…} 参数的结尾，不是命令返回 -1
  function command(s, i) {
    const m = /^\\(?:[A-Za-z]+|[|{},;:!])/.exec(s.slice(i, i + 40))
    if (!m) return -1
    let j = i + m[0].length
    while (s[j] === '{') {
      const e = group(s, j)
      if (e < 0) break
      j = e
    }
    return j
  }

  // s[i] 是 ^ 或 _：上下标的结尾
  function script(s, i) {
    const c = s[i + 1]
    if (c === '{') return group(s, i + 1)
    if (c === '\\') return command(s, i + 1)
    return c && /[A-Za-z0-9*'+-]/.test(c) ? i + 2 : -1
  }

  const SYMBOL = /[0-9+\-=*/<>()[\]|'!.,:;]/
  const EDGE_HEAD = /^[\s.,:;!)\]]$/
  const EDGE_TAIL = /^[\s.,:;!([]$/

  /**
   * 纯文字里没包 $ 的 LaTeX：找出以反斜杠命令为核心的一串（单个字母、数字、运算符、上下标、空格都算进去，
   * 两个字母以上的单词和中文算文字）。→ [{ start, end }]
   */
  function bareRuns(s) {
    const toks = []
    for (let i = 0; i < s.length; ) {
      const c = s[i]
      let e = -1
      let kind = 'text'
      if (c === '\\') {
        e = command(s, i)
        kind = 'cmd'
      } else if (c === '^' || c === '_') {
        e = script(s, i)
        kind = 'math'
      } else if (/[A-Za-z]/.test(c)) {
        e = i
        while (e < s.length && /[A-Za-z]/.test(s[e])) e++
        kind = e - i === 1 ? 'math' : 'text'
      } else if (c === ' ') {
        e = i + 1
        kind = 'space'
      } else if (SYMBOL.test(c)) {
        e = i + 1
        kind = 'math'
      }
      if (e <= i) {
        e = i + 1
        kind = 'text'
      }
      toks.push({ s: i, e, kind, t: s.slice(i, e) })
      i = e
    }
    const runs = []
    let cur = []
    const close = () => {
      let r = cur
      cur = []
      if (!r.some((t) => t.kind === 'cmd')) return
      const count = (ch) => r.filter((t) => t.t === ch).length
      for (let changed = true; changed && r.length; ) {
        changed = false
        if (EDGE_HEAD.test(r[0].t) || (r[0].t === '(' && count('(') > count(')')) || (r[0].t === '[' && count('[') > count(']'))) {
          r = r.slice(1)
          changed = true
        } else if (r.length && (EDGE_TAIL.test(r[r.length - 1].t) || (r[r.length - 1].t === ')' && count(')') > count('(')) || (r[r.length - 1].t === ']' && count(']') > count('[')))) {
          r = r.slice(0, -1)
          changed = true
        }
      }
      if (r.some((t) => t.kind === 'cmd')) runs.push({ start: r[0].s, end: r[r.length - 1].e })
    }
    for (const t of toks) {
      if (t.kind === 'text') close()
      else cur.push(t)
    }
    close()
    return runs
  }

  // 页面里有 KaTeX 就用它判断画不画得出来（\Users 这种不是公式的留作文字）；Node 里没有就都算
  function katexValid(tex) {
    if (!root.katex) return true
    try {
      root.katex.renderToString(tex, { throwOnError: true, strict: 'ignore', trust: false })
      return true
    } catch {
      return false
    }
  }

  /**
   * 一句笔记文字 → [{ text } | { tex }]：先 repair，已经包好的 $…$ 和没包的 \lambda、\hat{\theta} 都切成 tex。
   * valid(tex)：没包的这段画不画得出来，默认用页面里的 KaTeX 判断。
   */
  function split(v, { valid = katexValid } = {}) {
    const s = repair(v)
    const out = []
    const pushText = (t) => {
      if (!t) return
      if (out.length && out[out.length - 1].text != null) out[out.length - 1].text += t
      else out.push({ text: t })
    }
    const plain = (t) => {
      let last = 0
      for (const r of t.includes('\\') ? bareRuns(t) : []) {
        const tex = t.slice(r.start, r.end)
        if (!valid(tex)) continue
        pushText(t.slice(last, r.start))
        out.push({ tex })
        last = r.end
      }
      pushText(t.slice(last))
    }
    let last = 0
    for (const m of s.matchAll(DELIMITED)) {
      const tex = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim()
      if (!tex) continue
      plain(s.slice(last, m.index))
      out.push({ tex })
      last = m.index + m[0].length
    }
    plain(s.slice(last))
    return out
  }

  root.texfix = { repair, split }
})(globalThis)
