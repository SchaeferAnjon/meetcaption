import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// 视频课图文笔记的 Markdown 解析（渲染进程的脚本，不是模块：拿源码包成函数取出来）
const src = fs.readFileSync(new URL('../src/renderer/control/video-notes.js', import.meta.url), 'utf8')
const { parseVideoNotes } = new Function(`${src}\nreturn { parseVideoNotes }`)()

const md = `## 本节概览
讲梯度下降。

## 大纲与知识点
### [00:00] 直觉：雾里下山
- 只能感觉脚下的坡度
![梯度](slides/00.00.00.jpg)

### [12:30] 更新规则
- w ← w − η∇L(w)

### [1:05:10] 学习率
- 太大会发散

## 公式与推导
无

## 作业
- 在房价数据上实现 SGD
`

test('课堂笔记 Markdown → 概览、带时间的小节（图从正文里拿出来）、其余小节；空的小节不要', () => {
  const p = parseVideoNotes(md)
  assert.equal(p.overview, '讲梯度下降。')
  assert.deepEqual(p.sections.map((x) => [x.at, x.title]), [[0, '直觉：雾里下山'], [750_000, '更新规则'], [3_910_000, '学习率']])
  assert.deepEqual(p.sections[0].figs, ['00.00.00.jpg'])
  assert.ok(!p.sections[0].body.includes('![') && p.sections[0].body.includes('脚下的坡度'))
  assert.deepEqual(p.extras.map((x) => x.title), ['作业'], '正文只有「无」的「公式与推导」不画')
})

test('没有带时间的小标题：认不出来，调用的地方换回原来的图文笔记', () => {
  assert.equal(parseVideoNotes('## 概览\n一段话\n\n## 大纲\n### 没时间的小节\n- 要点'), null)
  assert.equal(parseVideoNotes(''), null)
})

test('代码块里的 ## 不当标题；没写时间的小节并进前一个小节', () => {
  const p = parseVideoNotes('## 概览\nx\n\n## 大纲与知识点\n### [00:10] 一\n```\n## 不是标题\n```\n### 补充\n- 并进来\n')
  assert.equal(p.sections.length, 1)
  assert.ok(p.sections[0].body.includes('## 不是标题') && p.sections[0].body.includes('补充') && p.sections[0].body.includes('并进来'))
})
