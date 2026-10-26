// LLM 门面：所有调用方只用 complete() 和 llmStatus()，按 settings.llmProvider 分到 ChatGPT 订阅或 OpenAI 兼容接口。
import { chatgptComplete } from './chatgpt.js'
import { compatComplete, listModels as compatModels, memberOffline } from './openaiCompat.js'
import { LlmError } from './errors.js'
import { PRESET_IDS, PROVIDERS, providerOf } from './providers.js'
import { t } from '../i18n.js'

export { ChatGPTAuth } from './chatgptAuth.js'
export { LlmError, isAbort } from './errors.js'
export { PROVIDERS }

// 答题默认（实测，见 docs/v2-integration/A-llm.md）：ChatGPT 通道 terra 首字不比 luna 慢、回答更好；
// OpenAI API 上 luna 明显更快。effort 都用 none，low 只让首字更慢、尾部更长。
export const ANSWER_DEFAULTS = {
  chatgpt: { model: 'gpt-5.6-terra', effort: 'none' },
  openai: { model: 'gpt-5.6-luna', effort: 'none' },
}
const OPENAI_BASE = 'https://api.openai.com/v1'

// ChatGPT 通道只认 OpenAI 的模型名；设置里如果还是 deepseek 之类的名字，就用这里的默认。
const CHATGPT_MODELS = { fast: 'gpt-5.6-luna', smart: 'gpt-5.6-terra', answer: ANSWER_DEFAULTS.chatgpt.model }

/** 'fast' | 'smart' | 'answer' | 具体模型名 → 具体模型名。llmAnswerModel 留空时按提供方选默认。 */
export function resolveModel(s, model = 'fast') {
  const provider = s.llmProvider ?? 'openai'
  const answer = s.llmAnswerModel || (provider === 'chatgpt' ? ANSWER_DEFAULTS.chatgpt.model : s.llmFastModel || ANSWER_DEFAULTS.openai.model)
  const alias = { fast: s.llmFastModel, smart: s.llmSummaryModel, answer }
  const name = (alias[model] ?? model) || CHATGPT_MODELS.fast
  if (provider === 'chatgpt' && !/^(gpt-|o\d|codex)/i.test(name)) return CHATGPT_MODELS[model] ?? CHATGPT_MODELS.fast
  return name
}

const isOpenAIHost = (url) => /^https:\/\/api\.openai\.com(\/|$)/i.test(String(url ?? '').trim())

/**
 * OpenAI 兼容通道的地址和 Key。选 OpenAI 时用「OpenAI API Key」那一栏（openaiKey，和语音识别共用）：
 * llmKey 是「自定义」的 Key，不能发给 OpenAI。只有 llmKey 本来就是给 api.openai.com 填的（v1 的老设置）才拿来兜底。
 * DeepSeek 这类内置服务用内置地址和 llmKeys 里它自己的 Key。
 */
export function compatConfig(s) {
  const provider = s.llmProvider ?? 'openai'
  if (provider === 'openai') {
    const legacy = !s.openaiKey && isOpenAIHost(s.llmBaseUrl) ? s.llmKey : ''
    return { baseUrl: s.openaiBaseUrl || OPENAI_BASE, key: s.openaiKey || legacy || '', openai: true }
  }
  if (PRESET_IDS.includes(provider)) return { baseUrl: providerOf(provider).baseUrl, key: s.llmKeys?.[provider] ?? '', openai: false, ...(provider === 'member' ? { member: true } : {}) }
  return { baseUrl: s.llmBaseUrl, key: s.llmKey, openai: /api\.openai\.com/.test(s.llmBaseUrl ?? '') }
}

/**
 * @param {object} settings  settings.get() 的结果
 * @param {import('./chatgptAuth.js').ChatGPTAuth | null} auth  llmProvider='chatgpt' 时必须给
 * @param {object} o  { model, system, messages, effort, maxOutputTokens, json, signal, timeoutMs, onDelta }
 * @returns {Promise<string>} 全文；给了 onDelta 就流式回调累计全文
 */
export async function complete(settings, auth, o) {
  const provider = settings.llmProvider ?? 'openai'
  const model = resolveModel(settings, o.model)
  if (provider === 'chatgpt') {
    if (!auth) throw new LlmError('not-logged-in', t('还没用 ChatGPT 账号登录（设置 → AI 服务）'))
    return chatgptComplete(auth, { ...o, model })
  }
  const cfg = compatConfig(settings)
  if (!cfg.baseUrl) throw new LlmError('bad-request', t('还没填 AI 服务地址（设置 → 账号与 AI）'))
  return compatComplete(cfg, { ...o, model })
}

/** 设置页的模型下拉：→ { ok, models, label } | { ok: false, error }。ChatGPT 通道没有列表接口，给它认的那几个。 */
export async function listModels(settings) {
  const provider = settings.llmProvider ?? 'openai'
  if (provider === 'chatgpt') return { ok: true, models: [...new Set(Object.values(CHATGPT_MODELS))].sort(), label: 'ChatGPT' }
  const cfg = compatConfig(settings)
  if (!cfg.baseUrl) return { ok: false, error: t('还没填接口地址') }
  if (!cfg.key) return { ok: false, error: t('还没填 API Key') }
  try {
    return { ok: true, models: await compatModels(cfg), label: provider === 'custom' ? hostOf(cfg.baseUrl) || cfg.baseUrl : providerOf(provider).name }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** 给界面显示用：{ provider, ready, label, reason }，ChatGPT 通道另带 account。 */
export function llmStatus(settings, auth) {
  const provider = settings.llmProvider ?? 'openai'
  if (provider === 'chatgpt') {
    const label = 'ChatGPT 账号'
    if (!auth) return { provider, ready: false, label, reason: t('主进程还没创建 ChatGPT 登录模块') }
    const st = auth.status()
    if (st.loggingIn) return { provider, ready: false, label, reason: t('正在等浏览器里完成登录') }
    if (!st.loggedIn) return { provider, ready: false, label, reason: st.error ?? t('还没用 ChatGPT 账号登录') }
    const who = [st.email, st.planLabel].filter(Boolean).join('，')
    return {
      provider,
      ready: true,
      label: who ? t(`ChatGPT（{0}）`, who) : 'ChatGPT',
      reason: null,
      account: { email: st.email, plan: st.plan, planLabel: st.planLabel, source: st.source },
    }
  }
  const cfg = compatConfig(settings)
  const label = provider === 'custom' ? hostOf(cfg.baseUrl) || '自定义 AI 服务' : providerOf(provider).name
  if (!cfg.baseUrl) return { provider, ready: false, label, reason: t('没填 AI 服务地址') }
  if (!cfg.key && provider === 'member') return { provider, ready: false, label, reason: memberOffline() }
  if (!cfg.key) return { provider, ready: false, label, reason: provider === 'openai' ? t('没填 OpenAI Key') : provider === 'custom' ? t('没填 AI 服务的 Key') : t(`没填 {0} 的 Key`, label) }
  return { provider, ready: true, label, reason: null }
}
