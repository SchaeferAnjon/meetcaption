// 可选的 AI 服务。除了 ChatGPT 账号，都走 OpenAI 兼容的 chat/completions（openaiCompat.js）。
// 不引 electron：defaults、llm 门面、单测都直接用；界面从 app:init 的 llmProviders 拿同一份。
// 推荐模型按 2026-10 各家 /models 列表核对过（DeepSeek、智谱、通义实测能用）；设置里能从拉到的列表改。
// fast：翻译、术语、答题，每句话都用；smart：纪要、实时笔记。
// icon：renderer/shared/providers/ 下的文件；mono 的是单色图标，按文字颜色画。

export const PROVIDERS = [
  { id: 'chatgpt', name: 'ChatGPT 账号', blurb: '用订阅，不另外花钱', region: 'global', icon: 'openai.svg', mono: true },
  { id: 'deepseek', name: 'DeepSeek', blurb: '便宜，中文好', region: 'cn', icon: 'deepseek.svg', baseUrl: 'https://api.deepseek.com', keyPage: 'https://platform.deepseek.com/api_keys', fast: 'deepseek-flash', smart: 'deepseek-v4-pro' },
  { id: 'zhipu', name: '智谱 GLM', blurb: '国内直连，速度快', region: 'cn', icon: 'zhipu.svg', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyPage: 'https://open.bigmodel.cn/usercenter/apikeys', fast: 'glm-5.3-flash', smart: 'glm-5.3' },
  { id: 'qwen', name: '通义千问', blurb: '阿里云百炼', region: 'cn', icon: 'qwen.svg', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyPage: 'https://bailian.console.aliyun.com/?tab=model#/api-key', fast: 'qwen3.8-flash', smart: 'qwen3.8-max' },
  { id: 'kimi', name: 'Kimi', blurb: '月之暗面', region: 'cn', icon: 'kimi.svg', mono: true, baseUrl: 'https://api.moonshot.cn/v1', keyPage: 'https://platform.moonshot.cn/console/api-keys', fast: 'kimi-k3', smart: 'kimi-k3' },
  { id: 'doubao', name: '豆包', blurb: '火山方舟', region: 'cn', icon: 'doubao.svg', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyPage: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey', fast: 'doubao-seed-1-6-251015', smart: 'doubao-seed-1-6-251015' },
  { id: 'openai', name: 'OpenAI API', blurb: '按用量付费', region: 'global', icon: 'openai.svg', mono: true, baseUrl: 'https://api.openai.com/v1', keyPage: 'https://platform.openai.com/api-keys', fast: 'gpt-5.6-luna', smart: 'gpt-5.6-terra' },
  { id: 'gemini', name: 'Gemini', blurb: '需要海外网络', region: 'global', icon: 'gemini.png', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyPage: 'https://aistudio.google.com/apikey', fast: 'gemini-3.8-flash', smart: 'gemini-3.8-flash' },
  { id: 'claude', name: 'Claude', blurb: '需要海外网络', region: 'global', icon: 'claude.svg', baseUrl: 'https://api.anthropic.com/v1', keyPage: 'https://platform.claude.com/settings/keys', fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' },
  { id: 'openrouter', name: 'OpenRouter', blurb: '一个 Key 用多家模型', region: 'global', icon: 'openrouter.svg', mono: true, baseUrl: 'https://openrouter.ai/api/v1', keyPage: 'https://openrouter.ai/settings/keys', fast: 'openai/gpt-5.6-luna', smart: 'openai/gpt-5.6-terra' },
  { id: 'custom', name: '自定义', blurb: '任何 OpenAI 兼容接口', region: 'global' },
]

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id)

/** 内置地址、Key 存在 llmKeys 里的那几家（OpenAI 用 openaiKey，和语音识别共用；自定义用 llmBaseUrl + llmKey）。 */
export const PRESET_IDS = PROVIDERS.filter((p) => p.baseUrl && p.id !== 'openai').map((p) => p.id)

export const providerOf = (id) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS.find((p) => p.id === 'openai')

// 地址规整成「主机 + 路径」：去掉结尾的 /、/chat/completions 和 /v1（DeepSeek 带不带 /v1 都行）
const endpointOf = (url) => {
  try {
    const u = new URL(String(url ?? '').trim())
    return (u.host + u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '')).toLowerCase()
  } catch {
    return ''
  }
}

/** 地址认出是哪一家内置服务（老设置里「其他兼容服务」填的地址），认不出返回 null。智谱 Coding Plan 这类路径不同的不算。 */
export function presetByUrl(url) {
  const e = endpointOf(url)
  return (e && PROVIDERS.find((p) => PRESET_IDS.includes(p.id) && endpointOf(p.baseUrl) === e)?.id) || null
}
