import { test } from 'node:test'
import assert from 'node:assert/strict'
import katex from 'katex'
import '../src/renderer/shared/texfix.js'
import { fixEscapes, parseNotes } from '../src/main/class/liveNotes.js'
import { notesMessages } from '../src/main/class/prompts.js'

// 实时笔记里的 LaTeX：模型在 JSON 里把反斜杠写成一个（被当成 \t \r \f \b \n 转义吃掉，或者根本不是合法转义）、
// 写成四个（解析后成了 KaTeX 的换行），解析时都要还原；文字里的 $…$ 和没包 $ 的 \lambda 切成行内公式。

const { repair, split } = globalThis.texfix
const START = new Date(2026, 8, 24, 14, 0, 0).getTime()
const katexOk = (tex) => {
  try {
    katex.renderToString(tex, { throwOnError: true, strict: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('repair: control characters left by JSON escapes turn back into LaTeX commands', () => {
  // \text → 制表符，\rVert → 回车，\frac → 换页，\beta → 退格，\nabla → 换行，受约束解码的 \u0002lambda
  assert.equal(repair('L_{\text{ridge}}', { formula: true }), 'L_{\\text{ridge}}')
  assert.equal(repair('\\lVert w \rVert_2^2', { formula: true }), '\\lVert w \\rVert_2^2')
  assert.equal(repair('\frac{a}{b} + \beta', { formula: true }), '\\frac{a}{b} + \\beta')
  assert.equal(repair('\nabla_\theta L \ne 0, \nu', { formula: true }), '\\nabla_\\theta L \\ne 0, \\nu')
  assert.equal(repair('惩罚强度由 \u0002lambda 控制'), '惩罚强度由 \\lambda 控制')
  // 四个反斜杠解析后是 \\lambda（KaTeX 的换行加单词）：并成一个
  assert.equal(repair('\\\\lambda \\\\|w\\\\|_2^2', { formula: true }), '\\lambda \\|w\\|_2^2')
  // 真的多行公式里的 \\ 换行不动；后面不是命令的控制字符换成空格
  assert.equal(repair('\\begin{aligned} a &= b \\\\c &= d \\end{aligned}', { formula: true }), '\\begin{aligned} a &= b \\\\c &= d \\end{aligned}')
  assert.equal(repair('a\t= b\r\n'), 'a = b ')
  // 文字里换行后面单个 e、u 不猜成 \ne、\nu
  assert.equal(repair('first\ne.g. more'), 'first e.g. more')
  // 本来就对的不动，修过的再修一遍不变
  for (const s of ['\\theta_{t+1} = \\theta_t - \\eta \\nabla L', '选 $\\lambda$', 'plain text']) assert.equal(repair(s, { formula: true }), s)
  const once = repair('L_{\text{r}} + \\\\lambda', { formula: true })
  assert.equal(repair(once, { formula: true }), once)
})

test('fixEscapes: lone backslashes that JSON does not accept get doubled, valid escapes stay', () => {
  assert.equal(fixEscapes(String.raw`{"a":"\lambda \sigma \underline{x}"}`), String.raw`{"a":"\\lambda \\sigma \\underline{x}"}`)
  const ok = String.raw`{"a":"\\lambda \"q\" \n \u00e9 \t"}`
  assert.equal(fixEscapes(ok), ok)
})

test('parseNotes: bad JSON from the model still gives working LaTeX in formulas and text', () => {
  // 1. JSON 模式下的真实样子（Windows 实测和本机复现）：单个反斜杠被当成转义，四个的成了换行，\u0002 顶掉了反斜杠
  const jsonMode = String.raw`{"sections":[{"title":"Ridge regression","start":"00:10","points":["惩罚强度由 \u0002lambda 控制","使用 k-fold cross-validation 选择正则化参数 \\lambda。"],"formulas":["L_{\text{ridge}} = \text{squared error} + \\lambda \\\\lVert w \\\\rVert_2^2","\boldsymbol{w} = (X^\top X + \\lambda I)^{-1}X^\top\boldsymbol{y}","\nabla_{\theta}\\mathcal{L}(\theta)","\\frac{1}{n}\\sum_i \frac{a}{b}"],"examples":[]}],"emphasis":[{"text":"闭式解 $w=(X^\top X+\\lambda I)^{-1}X^\top y$ 会考","at":"00:57","quote":"This will be on the exam."}],"homework":[],"terms":[]}`
  const a = parseNotes(jsonMode, { startedAt: START })
  assert.deepEqual(a.sections[0].formulas, [
    'L_{\\text{ridge}} = \\text{squared error} + \\lambda \\lVert w \\rVert_2^2',
    '\\boldsymbol{w} = (X^\\top X + \\lambda I)^{-1}X^\\top\\boldsymbol{y}',
    '\\nabla_{\\theta}\\mathcal{L}(\\theta)',
    '\\frac{1}{n}\\sum_i \\frac{a}{b}',
  ])
  for (const f of a.sections[0].formulas) assert.ok(katexOk(f), f)
  assert.deepEqual(a.sections[0].points, ['惩罚强度由 \\lambda 控制', '使用 k-fold cross-validation 选择正则化参数 \\lambda。'])
  assert.equal(a.emphasis[0].text, '闭式解 $w=(X^\\top X+\\lambda I)^{-1}X^\\top y$ 会考')

  // 2. 没开 JSON 模式：\lambda、\sigma 是非法转义，整个 JSON.parse 失败；补上转义后照样解析，\theta 的 \t 仍要还原
  const loose = '```json\n' + String.raw`{"sections":[{"title":"Bias and variance","points":["噪声方差 $\sigma^2$ 与估计量 $\hat{\theta}$"],"formulas":["\mathbb{E}[\text{error}] = \text{bias}^2 + \sigma^2"]}],"emphasis":[{"text":"记住 \lambda 越大越平滑"}],"homework":[],"terms":[]}` + '\n```'
  const b = parseNotes(loose, { startedAt: START })
  assert.deepEqual(b.sections[0].formulas, ['\\mathbb{E}[\\text{error}] = \\text{bias}^2 + \\sigma^2'])
  assert.deepEqual(b.sections[0].points, ['噪声方差 $\\sigma^2$ 与估计量 $\\hat{\\theta}$'])
  assert.equal(b.emphasis[0].text, '记住 \\lambda 越大越平滑')

  // 3. 非法转义让外层对象解析不了时，不能退而拿里面的小对象当结果（那样会被当成格式不对）
  const inner = String.raw`{"sections":[{"title":"L1","formulas":["\lVert w \rVert_1"]}],"emphasis":[{"text":"x"}]}`
  const c = parseNotes(inner, { startedAt: START })
  assert.equal(c.sections[0].title, 'L1')
  assert.deepEqual(c.sections[0].formulas, ['\\lVert w \\rVert_1'])
  assert.deepEqual(c.emphasis, [{ text: 'x', at: null, quote: null }])

  // 4. 术语是纯文字：模型顺手写的 $…$ 去掉
  const d = parseNotes(String.raw`{"terms":[{"term":"L2 norm","zh":"$L_2$ 范数","explain":"权重的平方和 $\\|w\\|_2^2$"}]}`)
  assert.deepEqual(d.terms, [{ term: 'L2 norm', zh: 'L_2 范数', explain: '权重的平方和 \\|w\\|_2^2' }])
})

test('split: $…$ and bare commands become inline math, the rest stays text', () => {
  const tex = (s) => split(s, { valid: katexOk }).filter((p) => p.tex != null).map((p) => p.tex)
  assert.deepEqual(split('使用 k-fold cross-validation 选择正则化参数 \\lambda。', { valid: katexOk }), [{ text: '使用 k-fold cross-validation 选择正则化参数 ' }, { tex: '\\lambda' }, { text: '。' }])
  assert.deepEqual(tex('Ridge regression 的闭式解中，\\lambda I 使矩阵更稳定'), ['\\lambda I'])
  assert.deepEqual(tex('估计量\\hat{\\theta}及噪声方差\\sigma^2体现 bias-variance tradeoff。'), ['\\hat{\\theta}', '\\sigma^2'])
  assert.deepEqual(tex('\\nabla_\\theta L表示损失函数相对于参数\\theta的梯度。'), ['\\nabla_\\theta L', '\\theta'])
  assert.deepEqual(tex('闭式解 (X^\\top X + \\lambda I)^{-1} X^\\top y，考试会考'), ['(X^\\top X + \\lambda I)^{-1} X^\\top y'])
  assert.deepEqual(tex('The penalty is \\lambda times the norm.'), ['\\lambda'])
  assert.deepEqual(tex('（\\lambda 越大越平滑）'), ['\\lambda'])
  assert.deepEqual(tex('闭式解 $w=(X^\\top X+\\lambda I)^{-1}X^\\top y$，另外 \\sigma^2 是噪声'), ['w=(X^\\top X+\\lambda I)^{-1}X^\\top y', '\\sigma^2'])
  // 被 JSON 吃掉的反斜杠先修再切
  assert.deepEqual(tex('参数 \theta 和 \u0002lambda'), ['\\theta', '\\lambda'])
  // 钱数、路径、没有命令的文字都不动
  assert.deepEqual(split('学费 $5 和 $6', { valid: katexOk }), [{ text: '学费 $5 和 $6' }])
  assert.deepEqual(split('文件在 C:\\Users\\me 里', { valid: katexOk }), [{ text: '文件在 C:\\Users\\me 里' }])
  assert.deepEqual(split('只是一句话'), [{ text: '只是一句话' }])
})

test('live notes prompt: asks for doubled backslashes in JSON and $…$ for inline math', () => {
  const [system] = notesMessages({ lines: [{ at: 0, speaker: '老师', text: 'Ridge regression' }], startedAt: START })
  assert.match(system.content, /每个反斜杠都写成两个（\\\\lambda/)
  assert.match(system.content, /"\\\\theta_\{new\} = \\\\theta_\{old\}/)
  assert.match(system.content, /行内公式 \$\.\.\.\$/)
  // 格式示例里的公式和行内公式也是 JSON 里的双反斜杠
  assert.match(system.content, /"formulas":\["LaTeX 源码，比如 \\\\lambda \\\\lVert w \\\\rVert_2\^2"\]/)
  assert.doesNotMatch(system.content, /[\u2013\u2014]/)
})
