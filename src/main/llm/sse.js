// Server-Sent Events 解析：按空行分帧，支持 event:/data: 多行、CRLF、注释行。
// OpenAI 的 Chat Completions 和 Responses 两种流式都用它。

export class SseParser {
  #buf = ''
  #event = ''
  #data = []

  /** 喂一段文本，返回这一段里完整的事件 [{ event, data }]。 */
  push(text) {
    this.#buf += text
    const out = []
    let nl
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      let line = this.#buf.slice(0, nl)
      this.#buf = this.#buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.#line(line, out)
    }
    return out
  }

  /** 流结束：没以空行收尾的最后一个事件也交出去。 */
  end() {
    const out = []
    if (this.#buf) this.#line(this.#buf.replace(/\r$/, ''), out)
    this.#buf = ''
    this.#line('', out)
    return out
  }

  #line(line, out) {
    if (line === '') {
      if (this.#data.length) out.push({ event: this.#event, data: this.#data.join('\n') })
      this.#event = ''
      this.#data = []
      return
    }
    if (line.startsWith(':')) return
    const i = line.indexOf(':')
    const field = i < 0 ? line : line.slice(0, i)
    let value = i < 0 ? '' : line.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.#event = value
    else if (field === 'data') this.#data.push(value)
  }
}

/** 一次性解析整段 SSE 文本（单测和调试用）。 */
export function parseSse(text) {
  const p = new SseParser()
  return [...p.push(text), ...p.end()]
}

/** 逐块读 fetch 的 body，产出事件。 */
export async function* readSse(body) {
  const decoder = new TextDecoder()
  const p = new SseParser()
  for await (const chunk of body) {
    for (const ev of p.push(decoder.decode(chunk, { stream: true }))) yield ev
  }
  for (const ev of p.push(decoder.decode())) yield ev
  for (const ev of p.end()) yield ev
}
