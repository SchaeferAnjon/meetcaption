import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyPatch, DEFAULTS, merge, OLD_VOLC_RESOURCE_ID, providerPatch, upgradePatch } from '../src/main/defaults.js'

// 升级时对老设置的一次性修改：每项只做一次，做完记 migrations，之后用户自己改回去不再动。
// launch 模拟一次启动：读文件（merge 补默认）、做 upgradePatch、写回去（和 SettingsStore.update 一样用 applyPatch）。

function launch(file) {
  let s = merge(DEFAULTS, file)
  const up = upgradePatch(s)
  if (up) s = applyPatch(s, up)
  return s
}

const SEED = 'volc.seedasr.sauc.duration'

test('upgrade: 豆包资源 ID 还是旧默认 1.0 的换成 2.0，只换一次，之后手动改回 1.0 不再动', () => {
  assert.equal(DEFAULTS.volcResourceId, SEED)
  // 0.4.0 存下来的设置：资源 ID 是当时的默认 1.0，还没有 volcSeed 标记
  const old = { engine: 'volc', volcAppId: '123', volcAccessToken: 't', volcResourceId: OLD_VOLC_RESOURCE_ID, translate: true, migrations: { projects: true, translateOn: true } }
  const first = launch(old)
  assert.equal(first.volcResourceId, SEED)
  assert.equal(first.migrations.volcSeed, true)
  assert.equal(first.migrations.projects, true)
  assert.equal(first.engine, 'volc')
  assert.equal(upgradePatch(first), null)

  // 用户只开通了 1.0，又改回去：下次启动不动
  const back = applyPatch(first, { volcResourceId: OLD_VOLC_RESOURCE_ID })
  assert.equal(launch(back).volcResourceId, OLD_VOLC_RESOURCE_ID)
})

test('upgrade: 自己填过别的资源 ID 的不动；没存过资源 ID 的本来就是 2.0；都记上标记', () => {
  const custom = launch({ volcResourceId: 'volc.seedasr.sauc.concurrent', migrations: { translateOn: true } })
  assert.equal(custom.volcResourceId, 'volc.seedasr.sauc.concurrent')
  assert.equal(custom.migrations.volcSeed, true)

  const fresh = launch({})
  assert.equal(fresh.volcResourceId, SEED)
  assert.deepEqual(fresh.migrations, { projects: false, translateOn: true, volcSeed: true, localAsr: true, providers: true })
})

test('upgrade: 翻译只在还没迁过时打开一次；迁过以后自己关掉的保持关', () => {
  const v3 = launch({ translate: false, volcResourceId: OLD_VOLC_RESOURCE_ID })
  assert.equal(v3.translate, true)
  assert.equal(v3.volcResourceId, SEED)

  // 0.4.x 用户迁过翻译以后自己关掉了，这次升级只换资源 ID，不再打开翻译
  const off = launch({ translate: false, volcResourceId: OLD_VOLC_RESOURCE_ID, migrations: { translateOn: true } })
  assert.equal(off.translate, false)
  assert.equal(off.volcResourceId, SEED)
  assert.deepEqual(upgradePatch({ translate: false, volcResourceId: OLD_VOLC_RESOURCE_ID, migrations: { translateOn: true } }), { volcResourceId: SEED, migrations: { volcSeed: true, localAsr: true, providers: true } })
})

test('upgrade: 识别服务没配好 Key 的换成本地识别，已经填了豆包或 OpenAI 的不动，只做一次', () => {
  // 老用户：默认 OpenAI，但从没填过 Key
  const none = launch({ engine: 'openai', migrations: { projects: true, translateOn: true, volcSeed: true } })
  assert.equal(none.engine, 'local')
  assert.equal(none.migrations.localAsr, true)
  // 豆包只填了一半
  assert.equal(launch({ engine: 'volc', volcAppId: '123', migrations: { projects: true, translateOn: true, volcSeed: true } }).engine, 'local')
  // 配好了的不动
  assert.equal(launch({ engine: 'volc', volcAppId: '123', volcAccessToken: 't', migrations: { projects: true, translateOn: true, volcSeed: true } }).engine, 'volc')
  assert.equal(launch({ engine: 'openai', openaiKey: 'sk-x', migrations: { projects: true, translateOn: true, volcSeed: true } }).engine, 'openai')
  // 新装：默认就是本地
  assert.equal(launch({}).engine, 'local')
  // 迁移过以后自己换回 OpenAI（还没填 Key），下次启动不再改
  const back = applyPatch(none, { engine: 'openai' })
  assert.equal(launch(back).engine, 'openai')
})

test('upgrade: 「其他兼容服务」填的是内置服务的地址就换成那一家，Key 挪过去；智谱 Coding Plan 这类认不出的不动', () => {
  const base = { migrations: { translateOn: true, volcSeed: true, localAsr: true } }
  assert.deepEqual(upgradePatch({ ...base, llmProvider: 'custom', llmBaseUrl: 'https://api.deepseek.com/v1', llmKey: 'sk-1' }), { llmProvider: 'deepseek', llmKeys: { deepseek: 'sk-1' }, migrations: { providers: true } })
  assert.deepEqual(upgradePatch({ ...base, llmProvider: 'custom', llmBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', llmKey: 'k' }), { migrations: { providers: true } })
  assert.deepEqual(upgradePatch({ ...base, llmProvider: 'openai', llmBaseUrl: 'https://api.deepseek.com' }), { migrations: { providers: true } })
})

test('换 AI 服务：当前模型存给旧的那家，新的那家用上次的，没用过用推荐；自定义没推荐保持不动', () => {
  let s = merge(DEFAULTS, {})
  const step = (patch) => (s = applyPatch(s, providerPatch(s, patch)))
  step({ llmFastModel: 'gpt-x' })
  step({ llmProvider: 'deepseek' })
  assert.equal(s.llmFastModel, 'deepseek-flash')
  assert.equal(s.llmSummaryModel, 'deepseek-v4-pro')
  assert.equal(s.llmModels.openai.fast, 'gpt-x')
  step({ llmSummaryModel: 'deepseek-flash' })
  step({ llmProvider: 'openai' })
  assert.equal(s.llmFastModel, 'gpt-x')
  step({ llmProvider: 'deepseek' })
  assert.equal(s.llmSummaryModel, 'deepseek-flash')
  step({ llmProvider: 'custom' })
  assert.equal(s.llmFastModel, 'deepseek-flash')
  assert.deepEqual(applyPatch(s, providerPatch(s, { llmKeys: { deepseek: 'k' } })).llmKeys.deepseek, 'k')
})
