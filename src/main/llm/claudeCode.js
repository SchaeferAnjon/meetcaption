import { spawn } from 'node:child_process'
import { LlmError } from './errors.js'

// 本机 Claude Code（`claude -p`）当 AI：只在环境变量 MEETCAPTION_LLM=claude-code 时用，验证问 AI、调 prompt 时不用 Key；设置里没有这一项。
// 不给工具（--tools ""），不读用户和项目的 Claude 设置、不连 MCP、不存会话；system 走 --system-prompt，之前几轮对话拼成文字从 stdin 进。
// 图片不带（只传文字）；出字一次给齐（onDelta 在结束时调一次）。模型用 MEETCAPTION_CLAUDE_MODEL，默认 sonnet。

export const claudeCodeOn = () => process.env.MEETCAPTION_LLM === 'claude-code'

const text = (c) => (typeof c === 'string' ? c : (c ?? []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'))

/** messages → 一段文字：只有一条时原样，多条时标上「我：」「你：」 */
function transcriptOf(messages) {
  if (messages.length === 1) return text(messages[0].content)
  return messages.map((m) => `${m.role === 'assistant' ? '你' : '我'}：${text(m.content)}`).join('\n\n')
}

export function claudeCodeComplete(o) {
  const args = ['-p', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--model', process.env.MEETCAPTION_CLAUDE_MODEL || 'sonnet']
  if (o.system) args.push('--system-prompt', o.system)
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MEETCAPTION_CLAUDE_BIN || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), o.timeoutMs ?? 120_000)
    const onAbort = () => child.kill('SIGTERM')
    o.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new LlmError('network', `claude 启动失败：${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      if (o.signal?.aborted) return reject(o.signal.reason ?? new Error('aborted'))
      if (code !== 0) return reject(new LlmError('server', `claude 退出码 ${code}：${err.trim().slice(0, 300)}`))
      const full = out.trim()
      o.onDelta?.(full)
      resolve(full)
    })
    child.stdin.end(transcriptOf(o.messages ?? []))
  })
}
