# 模块 A：ChatGPT 订阅通道 接线说明

`src/main/llm/` 已可用：用 ChatGPT 账号登录（OAuth + PKCE），请求走 Codex 后端 Responses API；OpenAI 兼容接口加了图片、输出长度和 JSON。调用方只用 `complete()` 和 `llmStatus()`。旧的 `src/main/llm.js` 还在，`import { chat, chatStream } from './llm.js'` 不变。

答题默认建议：**ChatGPT 通道用 `gpt-5.6-terra` + effort `none`，OpenAI API 通道用 `gpt-5.6-luna` + effort `none`**。数字见文末。

## 文件

| 文件 | 内容 |
| --- | --- |
| `llm/index.js` | 门面：`complete()`、`llmStatus()`、`resolveModel()`、`compatConfig()`、`ANSWER_DEFAULTS`，转出 `ChatGPTAuth`、`LlmError`、`isAbort` |
| `llm/chatgptAuth.js` | `ChatGPTAuth`：登录、存 token、提前刷新、退出 |
| `llm/chatgpt.js` | Codex 后端 Responses API，SSE 流式，错误翻译 |
| `llm/openaiCompat.js` | Chat Completions（原 llm.js 挪过来），加图片、maxOutputTokens、json |
| `llm/sse.js`、`llm/errors.js` | 两边共用的 SSE 解析、`LlmError`、超时控制 |

## 主进程怎么接（E1）

在 `app.whenReady()` 之后创建一个实例，全程复用：

```js
import { shell, safeStorage } from 'electron'
import { ChatGPTAuth, complete, llmStatus } from './llm/index.js'

const chatgptAuth = new ChatGPTAuth({
  file: path.join(app.getPath('userData'), 'chatgpt-auth.json'),
  safeStorage, // Windows 用它加密；Mac 上不加密，文件 0600
})
chatgptAuth.on('status', (st) => toControl('chatgpt:status', st))

// 统一的调用入口，给 engine、总结、Assistant 注入
const llm = (opts) => complete(settings.get(), chatgptAuth, opts)
```

IPC（设计文档里的约定）：

```js
ipcMain.handle('chatgpt:status', () => chatgptAuth.status())
ipcMain.handle('chatgpt:login', async () => {
  try {
    return { ok: true, status: await chatgptAuth.login({ openExternal: (url) => shell.openExternal(url) }) }
  } catch (e) {
    return { ok: false, code: e.code, error: e.message }
  }
})
ipcMain.handle('chatgpt:logout', async () => {
  await chatgptAuth.logout()
  return chatgptAuth.status()
})
// 可选：界面上「取消登录」按钮
ipcMain.handle('chatgpt:cancelLogin', () => chatgptAuth.cancelLogin())
```

`status()` 不含任何 token，可以直接发给界面：

```js
{
  loggedIn, loggingIn,        // loggingIn 时浏览器那边还没完成
  loginUrl,                   // 登录中才有；浏览器没自动打开时界面可以给「复制登录链接」
  email, plan, planLabel,     // planLabel 如 'Plus'、'Pro Lite'
  accountId, expiresAt,       // expiresAt 是 access token 过期毫秒时间，刷新是自动的
  source,                     // 'app' | 'codex'
  error,                      // 最近一次失败原因（中文），如「ChatGPT 登录已失效，请重新登录」
}
```

`login()` 的失败 `code`：`port-in-use`（1455 和 1457 都被占，常见是 Codex CLI 或 OpenCode 正在登录）、`login-timeout`（5 分钟）、`login-cancelled`（再次点登录或调了 cancelLogin）、`login-failed`（用户取消授权、换 token 失败等）。`message` 都是能直接显示的中文。

现有代码要改的地方（E1）：

- `main.js` 的 `generateSummary`、`testLlm` 和 `engine.js` 的 `#translate` 现在先查 `llm.key`，ChatGPT 通道没有 key。改成 `const st = llmStatus(s, chatgptAuth); if (!st.ready) throw new Error(st.reason)`，再调 `complete()`。engine 拿不到 auth，建议构造时注入上面的 `llm` 函数。
- 总结：`complete(s, chatgptAuth, { model: 'smart', effort: 'low', signal, messages: summaryMessages(...), onDelta })`。
- 翻译和术语（模块 D）：`complete(s, chatgptAuth, { model: 'fast', effort: 'none', json: true, timeoutMs: 20_000, messages: enhanceMessages(...) })`。`messages` 里可以有 `role: 'system'`。
- 答题（模块 C）：`new Assistant({ complete: llm })`，它默认传 `model: 'answer', effort: 'none', maxOutputTokens: 400`，不用改。
- 连接测试：`complete(s, chatgptAuth, { model: 'fast', effort: 'none', timeoutMs: 20_000, messages: [...] })`。
- `settings.js`：`llmProvider` 注释加上 `'chatgpt'`。`llmAnswerModel` 建议默认 `''`，留空时 `resolveModel` 按通道选：chatgpt 用 `gpt-5.6-terra`，其他跟 `llmFastModel`。写死 `'gpt-5.6-luna'` 也能用，只是订阅通道上没有更快。
- `settings.js` 的 `llmConfig` 和 `index.js` 的 `compatConfig` 逻辑一样（index 不能 import settings.js，那边引了 electron，单测跑不了），以后改一处要同步另一处，或者让 `llmConfig` 直接转发 `compatConfig`。

## complete() 的约定和实际行为

```js
complete(settings, auth, {
  model,            // 'fast' | 'smart' | 'answer' | 具体模型名
  system,           // string
  messages,         // [{ role, content: string | [{ type:'text', text } | { type:'image', dataUrl, detail? }] }]
  effort,           // 'none' | 'low' | 'medium'（chatgpt 还认 high/xhigh/max；'minimal' 映射成 none）
  maxOutputTokens,
  json,             // true：要一个 JSON 对象
  signal, timeoutMs,
  onDelta,          // (累计全文) => void，给了就流式
}) → Promise<string>
```

- `model` 在 chatgpt 通道如果解析出来不是 OpenAI 的模型名（比如设置里还是 `deepseek-chat`），自动换成 luna（fast）或 terra（smart、answer）。
- **Codex 后端不认 `max_output_tokens` 和 `temperature`**（实测 400 `Unsupported parameter`，OpenCode 也因此去掉了这个参数）。chatgpt 通道的 `maxOutputTokens` 在客户端按估算 token 数截断：超了就停流，尽量截在句末。OpenAI 兼容通道照常传：OpenAI 用 `max_completion_tokens`（gpt-5 系列含思考 token，effort 不是 none 时别给太小），其他服务用 `max_tokens`。
- `json`：chatgpt 通道发 `text.format: json_object`，并在 input 前加一条 developer 消息要求 JSON（后端要求 input 里出现 json 字样，instructions 里的不算）。兼容通道发 `response_format: json_object`，消息里没有 json 字样就补一句；服务不支持 `response_format` 回 4xx 时自动去掉再试一次。
- 图片：chatgpt 通道转成 `input_image`（data URL），兼容通道转成 `image_url`。`detail` 可选，实测 `low` 没有稳定变快，回答会丢屏幕细节，建议不设。
- 超时：`timeoutMs` 是总时长；流式另有 90 秒空闲超时（一直没新数据才算）。`signal` 取消时抛 `AbortError`，用 `isAbort(e)` 判断，别当错误显示。
- 401：chatgpt 通道自动刷新一次 token 再重试；刷新失败账号转为未登录，`status` 事件会发出去。

错误都是 `LlmError`，`message` 是给用户看的中文，`code` 给程序判断：

| code | 什么时候 |
| --- | --- |
| `not-logged-in` | 没登录 ChatGPT，或兼容通道没填 key |
| `auth-expired` | 401 且刷新无效；兼容通道 key 无效 |
| `usage-limit` | 429 套餐额度用完，`resetsAt`（毫秒）是恢复时间，消息里带「几点恢复」 |
| `usage-not-included` | 套餐不含 Codex 用量（免费账号等） |
| `rate-limit` | 429 太频繁，`retryable: true` |
| `bad-model` / `bad-request` | 模型不支持、参数不支持、图片无效 |
| `context-too-long` / `refused` / `overloaded` | 上下文超长、被策略拒绝、服务繁忙 |
| `forbidden` | 403，含 Cloudflare 拦截 |
| `server` / `network` / `timeout` / `stream` | 5xx、连不上、超时、流中途断（`e.partial` 是已收到的文字） |

## 登录和 token 存储

- PKCE S256，verifier 64 字节随机数，state 32 字节；回调 `http://localhost:1455/auth/callback`，1455 被占用自动换 1457（两个都在 OpenAI 的白名单里，已实测），都被占时报 `port-in-use`。只监听 127.0.0.1。
- 回调先比 state：对不上回 400 页面但**不结束**登录（多半是旧标签页）；用户拒绝授权或缺 code 结束并报原因。成功和失败页面都是中文。
- token 存 `userData/chatgpt-auth.json`：Mac 明文 JSON，权限 0600；Windows 用 safeStorage 整体加密成 `{"enc": "..."}`，解不开就当未登录并提示重新登录。
- 离过期不到 10 分钟就用自己的 refresh_token 刷新（Codex 是 5 分钟）；并发请求共用一次刷新。刷新回 401、`invalid_grant`、`refresh_token_expired/reused/invalidated` 算永久失效：删文件、转为未登录、`status.error` 写原因。断网或 5xx 算暂时失败，旧 token 没过期就继续用。
- 退出时删文件，并照 Codex 的做法在服务端作废 refresh_token（失败不影响本地退出）。
- 开发自测：`MEETCAPTION_CHATGPT_AUTH=codex` 时只读 `~/.codex/auth.json`（或 `$CODEX_HOME/auth.json`），每次请求重新读，**从不刷新、从不写**；过期时报「在终端运行一次 codex」。这个模式下 `login()`、`logout()` 报 `codex-mode`。

## 协议出处

openai/codex，main 分支 `282cd7b0`（2026-09-24）：

- `codex-rs/login/src/server.rs`：issuer `https://auth.openai.com`，端口 1455 和备用 1457，`/auth/callback`，authorize 参数（`scope`、`id_token_add_organizations=true`、`codex_cli_simplified_flow=true`、`originator`），code 换 token 用 form 编码，account_id 取 id_token 的 `https://api.openai.com/auth`.`chatgpt_account_id`。
- `codex-rs/login/src/auth/manager.rs`：`CLIENT_ID = app_EMoamEEZ73f0CkXaXp7hrann`，刷新地址 `https://auth.openai.com/oauth/token`（JSON 编码），5 分钟提前刷新、8 天兜底，刷新失败分类。
- `codex-rs/login/src/oauth/pkce.rs`、`oauth/authorization.rs`、`oauth/client.rs`：PKCE、state 校验顺序、form 和 JSON 两种编码。
- `codex-rs/login/src/auth/revoke.rs`：退出时 `POST /oauth/revoke`。
- `codex-rs/login/src/token_data.rs`：claims 结构、套餐类型；`codex-rs/protocol/src/auth.rs`：套餐显示名。
- `codex-rs/login/src/auth/default_client.rs`：默认 `originator: codex_cli_rs`。
- `codex-rs/model-provider-info/src/lib.rs`：`https://chatgpt.com/backend-api/codex`；`codex-rs/model-provider/src/bearer_auth_provider.rs`：`ChatGPT-Account-ID` 头。
- `codex-rs/codex-api/src/common.rs`（`ResponsesApiRequest`、`input_image`）、`endpoint/responses.rs`（`POST /responses`，`Accept: text/event-stream`）、`sse/responses.rs`（事件类型和失败码）、`api_bridge.rs`（429 的 `usage_limit_reached`、`resets_at`、`usage_not_included`）。

对照了 OpenCode（anomalyco/opencode `packages/opencode/src/plugin/openai/codex.ts`）：同样的 client_id 和 PKCE 流程，scope 只要 `openid profile email offline_access`，按 token 里的 `chatgpt_compute_residency` 加 `x-openai-internal-codex-residency` 头，去掉 `maxOutputTokens`。我们的 scope 和 residency 头照 OpenCode（不需要 Codex 的 connectors 权限），`originator` 用 Codex 的默认值。

实测核对（2026-09-24，用 codex 的 access token 只读）：`max_output_tokens`、`temperature` 回 400；effort 只接受 none/low/medium/high/xhigh/max；`json_object` 要求 input 里有 json 字样；不带 `ChatGPT-Account-ID` 或 `originator` 也能用，但我们照 Codex 都带上；`response.completed` 里的 `output` 是空数组，全文只能从增量拼；伪造 token 回 401 `{"detail": "Could not parse your authentication token..."}`。authorize 地址用 1455、1457 都能到 OpenAI 登录页，换成未登记的端口会报 `redirect_uri` 不匹配。

## 实测数字

条件：Mac 本机网络，每次一个请求、轮流跑。system 约 150 token，user 约 120 token（资料、最近三句字幕、问题），回答 170 到 330 字符。图片是屏幕截图缩到 1600x900 的 JPEG（质量 80，399 KB）。首字 = 发请求到第一次 `onDelta`。单位毫秒。

| 通道 | 模型 | 输入 | effort | 次数 | 首字中位 | 首字最大 | 总耗时中位 | 首字超 3 秒 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChatGPT | luna | 文本 | none | 6 | 1846 | 2998 | 3104 | 0 |
| ChatGPT | luna | 文本 | low | 6 | 1993 | 2938 | 3344 | 0 |
| ChatGPT | luna | 截图 | none | 12 | 2530 | 3669 | 3896 | 3 |
| ChatGPT | luna | 截图 | low | 6 | 2930 | 4375 | 4272 | 3 |
| ChatGPT | terra | 文本 | none | 6 | 1527 | 2372 | 3225 | 0 |
| ChatGPT | terra | 文本 | low | 6 | 1660 | 3521 | 3011 | 1 |
| ChatGPT | terra | 截图 | none | 12 | 1932 | 3658 | 3672 | 1 |
| ChatGPT | terra | 截图 | low | 6 | 2258 | 4119 | 3542 | 2 |
| ChatGPT | luna | 截图 detail=low | none | 6 | 1744 | 5737 | 2908 | 2 |
| OpenAI API | luna | 文本 | none | 6 | 857 | 1148 | 1398 | 0 |
| OpenAI API | luna | 截图 | none | 6 | 1362 | 1929 | 2029 | 0 |

- 订阅通道比 API 慢约 1 秒的底子。截图 + none 时 terra 首字 p90 2.7 秒，luna p90 3.3 秒；luna 在这个后端上没有更快，terra 回答也更贴屏幕内容。所以订阅通道答题用 terra。
- effort low 中位只慢 0.1 到 0.4 秒，但尾部明显变长（首字最长 4.4 秒），答题用 none。
- 带图 vs 不带图：订阅通道首字多 0.4 到 0.7 秒，API 多 0.5 秒。不带图时模型会瞎猜屏幕内容，带图的回答能说出屏幕上的具体东西，值得带。
- 这些是短 prompt 的数字。「我的资料」很长或字幕上下文很多时首字会再涨，3 秒的目标在订阅通道上是贴边的；要稳在 3 秒内就用 OpenAI API key 走 luna。
- 其他：chatgpt 通道 json 模式翻译加术语一次 6.8 秒（输出长），API 2.9 秒；Electron 44 主进程里跑一次最小请求首字 880 毫秒。

## 单测

`test/llm-auth.test.js`（20 个）和 `test/llm.test.js`（21 个）：PKCE（含 RFC 7636 向量）、authorize 参数、JWT 过期和提前刷新、claims 取账号、回调 state 校验、刷新失败分类；假 issuer 上跑完整登录（含旧 state 回调、token 文件 0600）、端口被占、超时和取消、并发刷新只刷一次、刷新失效转未登录、暂时失败继续用旧 token、退出中途的刷新不复活、Windows 加密往返、codex 只读模式；SSE 分帧、Responses 事件解析、HTTP 和流内错误映射、假后端上的流式、401 刷新重试、429、客户端截断、取消和超时；兼容通道的请求体、json 回退、错误码；门面的模型解析、路由和 `llmStatus`。
