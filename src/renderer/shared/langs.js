'use strict'
// 能选的语言（和主进程 src/main/languages.js 同一份）：对方说的、翻译成的。
// 本地识别和豆包只认中英文，其他语言要在设置里换成 OpenAI 识别。
window.LANGS = [
  { value: 'en', label: '英语' },
  { value: 'zh', label: '中文' },
  { value: 'de', label: '德语' },
  { value: 'fr', label: '法语' },
  { value: 'es', label: '西班牙语' },
  { value: 'it', label: '意大利语' },
  { value: 'pt', label: '葡萄牙语' },
  { value: 'ru', label: '俄语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
]
window.SOURCE_LANGS = [...window.LANGS, { value: 'auto', label: '自动识别（中英混说）' }]
window.langLabel = (code) => window.SOURCE_LANGS.find((l) => l.value === code)?.label ?? code
window.needsOpenAI = (code) => !['zh', 'en', 'auto'].includes(code)
