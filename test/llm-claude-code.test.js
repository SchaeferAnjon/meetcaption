import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { complete, llmStatus } from '../src/main/llm/index.js'

// MEETCAPTION_LLM=claude-code：AI 走本机 `claude -p`（验证问 AI 用，设置里没有这一项）。用一个假的 claude 看传了什么。
// 假的 claude 是 sh 脚本，Windows 上起不来（spawn 报 ENOENT；这个开关本来就只在 Mac 开发机上用），Windows 跳过这两条（0.6.15 的 CI 挂在这里）
const skip = process.platform === 'win32' && '假的 claude 是 sh 脚本，Windows 上起不来'

function fakeClaude(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-'))
  const bin = path.join(dir, 'claude')
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return { dir, bin }
}

test('claude-code switch: status is ready without a key; system goes in --system-prompt, no tools, the turns go in on stdin', { skip }, async (t) => {
  const f = fakeClaude('printf "ARGS:"; for a in "$@"; do printf "[%s]" "$a"; done; printf "\\nSTDIN:"; cat')
  process.env.MEETCAPTION_LLM = 'claude-code'
  process.env.MEETCAPTION_CLAUDE_BIN = f.bin
  t.after(() => {
    delete process.env.MEETCAPTION_LLM
    delete process.env.MEETCAPTION_CLAUDE_BIN
    fs.rmSync(f.dir, { recursive: true, force: true })
  })
  assert.deepEqual(llmStatus({ llmProvider: 'deepseek' }, null), { provider: 'claude-code', ready: true, label: 'Claude Code（本机）', reason: null })
  const deltas = []
  const out = await complete({ llmProvider: 'deepseek' }, null, {
    model: 'answer',
    system: '你是助教',
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '要点：一' },
      { role: 'user', content: [{ type: 'text', text: '我的问题：刚才讲了什么' }, { type: 'image', dataUrl: 'data:image/jpeg;base64,xx' }] },
    ],
    onDelta: (s) => deltas.push(s),
  })
  assert.match(out, /\[-p\]/)
  assert.match(out, /\[--tools\]\[\]/)
  assert.match(out, /\[--setting-sources\]\[\]/)
  assert.match(out, /\[--system-prompt\]\[你是助教\]/)
  assert.match(out, /STDIN:我：第一问\n\n你：要点：一\n\n我：我的问题：刚才讲了什么$/)
  assert.deepEqual(deltas, [out])
})

test('claude-code switch: a failing claude is an error with its message; off by default', { skip }, async (t) => {
  const f = fakeClaude('echo "not logged in" >&2; exit 3')
  process.env.MEETCAPTION_LLM = 'claude-code'
  process.env.MEETCAPTION_CLAUDE_BIN = f.bin
  t.after(() => {
    delete process.env.MEETCAPTION_LLM
    delete process.env.MEETCAPTION_CLAUDE_BIN
    fs.rmSync(f.dir, { recursive: true, force: true })
  })
  await assert.rejects(complete({}, null, { messages: [{ role: 'user', content: 'x' }] }), /claude 退出码 3：not logged in/)
  delete process.env.MEETCAPTION_LLM
  assert.equal(llmStatus({ llmProvider: 'deepseek' }, null).provider, 'deepseek')
})
