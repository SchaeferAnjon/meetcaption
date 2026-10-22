# 模块 B：声纹 接线说明

`src/main/audio/voiceprint.js` 已可用：sherpa-onnx 1.13.8（Node-API 预编译）+ 3D-Speaker CAM++ 中英文模型（28 MB，192 维）。Electron 44 开发版主进程、Mac arm64 打包版、Mac x64 打包版（Rosetta 下跑）都实测加载并算出向量；Windows 包的目录结构在 Mac 上交叉打包核对过，没在真 Windows 上跑。

默认阈值建议保持 **0.5**：同一声音同语言 1 秒片段最低 0.64，其它声音 90% 在 0.55 以下。用户注册时要**中英文混读**，只读中文注册、开会说英文时分数会掉到 0.47 到 0.60。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/main/audio/voiceprint.js` | 模型加载、向量、余弦、PCM 转换、重采样、去静音、注册、打分、存档、自测 |
| `resources/models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx` | 模型，SHA-256 `aa3cfc16…ceba2`，和 sherpa-onnx 发布页的 checksum.txt 一致 |
| `resources/models/NOTICE.txt` | 模型、sherpa-onnx、ONNX Runtime 的来源和许可证，随包分发 |
| `scripts/sherpa-native.mjs` | electron-builder 的 beforePack 钩子：目标平台的原生包没装时从 npm 取，按 package-lock 的 integrity 校验 |
| `test/voiceprint.test.js` | 纯逻辑单测：cosine、pcm16ToFloat32、resample、trimSilence、enrollFrom 报错、scoreSegment、VoiceprintStore |
| `test/voiceprint-model.test.js` | 真模型单测：本机有对应平台的原生包才跑。Windows CI 的 `npm test` 会在 Node 22 里真加载 win-x64 的 DLL |
| `package.json` | 加依赖 `sherpa-onnx-node: 1.13.8`（精确版本） |
| `electron-builder.yml` | 见下面「打包」 |

## 接口

跟设计文档一致，下面是补充和改动：

```js
export const SAMPLE_RATE = 16000, MODEL_FILE, MODEL_ID = 'campplus-zh_en-16k-common_advanced', MIN_ENROLL_SECONDS = 6

loadVoiceprintModel({ numThreads = 1 } = {}) → Promise<{ embed, dim: 192, modelId }>
// 进程内只加载一次，之后返回同一个对象。加载失败会清掉缓存，下次还能重试。
// embed(float32At16k) → Float32Array（L2 归一化）。不到 0.5 秒抛 code 'too-short'。同步原生调用。

cosine(a, b) → number              // 任一为零向量或 null 返回 0
pcm16ToFloat32(buf)                // Buffer / Uint8Array / ArrayBuffer / Int16Array，奇数字节偏移可以
resample(float32, fromRate, toRate) // 多相加窗 sinc，降采样防混叠；同采样率返回拷贝

enrollFrom(float32At16k, model) → { embedding: Float32Array, modelId, seconds, createdAt }
// 去静音后有效语音 < 6 秒：code 'too-short'，「有效语音只有 4.2 秒，至少要 6 秒。请连续多读几句再录一次。」
// 最响的帧也低于 -45 dBFS：code 'too-quiet'，「声音太小，没听到说话。请检查麦克风，离近一点再录一次。」
// e.message 可以直接显示在界面上。

VoiceprintStore(file).load() → { embedding: Float32Array, modelId, seconds, createdAt } | null
// 文件坏了、字段不对都返回 null。不检查 modelId，调用方自己跟 MODEL_ID 比。
VoiceprintStore.save(profile)   // 0600，先写 .tmp 再改名
VoiceprintStore.clear()

// 新增
trimSilence(float32, opts) → { samples, seconds, peakDb, floorDb }
scoreSegment(model, profile, float32At16k, { minSeconds = 1 }) → { score, seconds } | null
// 去静音后算分。有效语音不到 minSeconds、没注册、或声纹是别的模型录的，返回 null。
voiceprintPaths() → { model, native }         // 实际用到的路径，找不到为 null
voiceprintSelfTest() → { ok, modelId, dim, loadMs, embedMs, platform, paths, error?, code? }
```

加载失败的错误码：`no-native`（找不到或加载不了 sherpa-onnx.node）、`no-model`（找不到模型，或文件大小不对）。模型文件不完整时 onnxruntime 会直接 abort 整个进程（实测截断的模型文件让 Node 以 134 退出，try/catch 接不住），所以加载前先核对文件大小。

注册的向量不是整段一次算：去静音后按 3 秒一段分别算再取平均（最后一段带上余数）。实测对 1 到 3 秒的短句分数高 0.01 到 0.04，中英混读注册时英文 1 秒片段的平均分从 0.56 提到 0.62。

## 主进程怎么接（E1）

```js
import { loadVoiceprintModel, VoiceprintStore, enrollFrom, scoreSegment, pcm16ToFloat32, resample, MODEL_ID } from './audio/voiceprint.js'

const vpStore = new VoiceprintStore(path.join(app.getPath('userData'), 'voiceprint.json'))
const vpProfile = () => {
  const p = vpStore.load()
  return p && p.modelId === MODEL_ID ? p : null // 换过模型的旧声纹当没录，界面提示重录
}

ipcMain.handle('voiceprint:status', () => {
  const p = vpProfile()
  return { enrolled: !!p, seconds: p?.seconds ?? 0, createdAt: p?.createdAt ?? null }
})
ipcMain.handle('voiceprint:clear', () => vpStore.clear())

// voiceprint:enroll(seconds)：只开麦克风录 seconds 秒 PCM16（采样率 rate），录的时候用 gate.js 的 dbfs 发 level
const model = await loadVoiceprintModel()
const x = resample(pcm16ToFloat32(Buffer.concat(chunks)), rate, 16000)
try {
  vpStore.save(enrollFrom(x, model))
  send('voiceprint:progress', { phase: 'done' })
} catch (e) {
  send('voiceprint:progress', { phase: 'error', error: e.message })
}

// 判一句 mic 段（buf 是这句的 PCM16，rate 是这一路的采样率：OpenAI 24000，豆包 16000）
const r = scoreSegment(model, profile, resample(pcm16ToFloat32(buf), rate, 16000))
const who = r == null ? null : r.score >= settings.voiceprint.threshold ? 'me' : 'other'
```

几点：

- `loadVoiceprintModel()` 虽然是 async，里面建模型是同步的：本机热启动 150 到 270 ms，冷启动（刚装好第一次）1 到 2.5 秒会卡住主进程。建议开始录音且有声纹时再加载，别放在启动路径上。
- `embed` 也是同步的：M4 上 3 秒片段 18 ms，8 秒 48 ms。慢的 Windows 笔记本估计再乘 3 到 4。一句话一次问题不大；如果以后发现卡界面，挪到 utilityProcess 里跑。
- `r == null`（有效语音不到 1 秒，比如「OK」「嗯」）时声纹判不了，建议走设计里的串音规则（最近 10 秒 system 段文本相似就丢），剩下的戴耳机场景算「我」、只有麦克风的面对面场景算「对方」，由 E1 定。
- 我说话时对方的声音从外放漏进麦克风（-12 dB）：分数只掉 0.02 到 0.06，还在 0.5 以上。我不说话、麦克风只收到外放的对方：分数跟「不同声音」一样低，交给文本比对丢掉。

### 自测和 CI

`selftest.js` 加一种：

```js
import { voiceprintSelfTest } from './audio/voiceprint.js'
// runSelfTest 里
if (kind === 'voiceprint') {
  const r = await voiceprintSelfTest()
  report(r)
  return r.ok ? 0 : 1
}
```

`.github/workflows/build.yml` 在 Build installer 后面加一步，真正验证 Windows 打包版能加载 DLL 和模型：

```yaml
      - name: Voiceprint self-test
        shell: pwsh
        run: |
          $env:MEETCAPTION_SELFTEST_OUT = "$pwd\voiceprint.json"
          $env:MEETCAPTION_USERDATA = "$pwd\ud-vp"
          $app = Start-Process -FilePath "dist\win-unpacked\MeetCaption.exe" -ArgumentList "--selftest=voiceprint" -PassThru
          $app.WaitForExit(60000) | Out-Null
          Get-Content voiceprint.json
          if (-not (Get-Content voiceprint.json | ConvertFrom-Json).ok) { throw "voiceprint model did not load" }
```

## 给界面（E2）

- 录制时长 12 秒够：正常朗读去静音后大约 9 到 10 秒。实测 9 秒注册和 15 秒注册差别很小（同语言 1 秒片段 EER 0.9% 对 0.2%，3 秒以上都是 0）。
- 朗读文字要中英文各一半。只用中文注册时，同一个声音说英文 3 秒片段平均只有 0.57，混读注册后是 0.74。示例：「我现在在录声纹，今天想简单介绍一下我最近做的项目，还有接下来的计划。Hi, this is a short voice sample. I usually talk about my research and the project I am building.」
- 报错文案直接用 `error`（上面两条中文）。

## 打包

`electron-builder.yml` 改了这些：

```yaml
files:
  - "!node_modules/sherpa-onnx-*/**"        # 原生库不进 asar
extraResources:                               # 模型 → Resources/models
  - from: resources/models
    to: models
    filter: ["*.onnx", NOTICE.txt]
beforePack: ./scripts/sherpa-native.mjs
mac:
  extraResources:                             # 只带当前架构的 → Resources/sherpa-onnx
    - from: node_modules/sherpa-onnx-darwin-${arch}
      to: sherpa-onnx
      filter: ["*.node", "*.dylib"]
win:
  files: [顶层列表完整抄一遍, "!node_modules/audiotee/**"]
  extraResources:
    - from: node_modules/sherpa-onnx-win-${arch}
      to: sherpa-onnx
      filter: ["*.node", "*.dll"]
```

- 运行时路径：打包后 `process.resourcesPath/models/…` 和 `process.resourcesPath/sherpa-onnx/sherpa-onnx.node`；开发时 `resources/models/…` 和 `node_modules/sherpa-onnx-<平台>-<架构>/`。代码按顺序找第一个存在的。`MEETCAPTION_VOICEPRINT_MODEL` 可以指定别的模型文件（实测对比用）。
- 不直接用 sherpa-onnx-node 的 JS 包装：它按 `../sherpa-onnx-<平台>/` 相对路径找 .node，打包后找不到。voiceprint.js 直接 require 平台包里的 .node，调 5 个原生函数。
- Electron 不允许原生模块返回外部内存的 ArrayBuffer（实测报 `External buffers are not allowed`），所以取向量时 `enableExternalBuffer` 传 false。
- npm 只装本机平台的 optionalDependency。M 芯片上打 x64 包时 beforePack 钩子自动 `npm pack sherpa-onnx-darwin-x64@1.13.8`，按 package-lock 的 sha512 校验后解到 node_modules。CLAUDE.md 里的发布命令不用改，第一次打 x64 或在 Mac 上打 Windows 包要联网。Windows CI 的 `npm ci` 本来就装 win-x64，钩子什么都不做。
- 安装目录带中文（Windows 默认装在 `…\Programs\会议字幕\`）：sherpa-onnx 1.13.8 在 Windows 上把 UTF-8 路径转成宽字符再打开（源码 `file-utils.cc` 和 `SHERPA_ONNX_TO_ORT_PATH`），Mac 上打包版路径里就有「会议字幕.app」，实测正常。
- dylib 和 .node 由 electron-builder 一起 ad-hoc 签名（`codesign --verify --deep --strict` 通过），加载靠 entitlements 里已有的 `disable-library-validation`。
- 安装包变大：Mac 应用 +62 MB（模型 28 MB，onnxruntime 29 MB），DMG 约 +36 MB；Windows 安装后 +51 MB，安装包约 +34 MB（gzip 估算，NSIS 用 LZMA 会再小一点）。

**顺手修的旧问题**：原来的 `win.files` 只有一条排除项，electron-builder 会给只含排除项的平台级 files 补一个 `**/*`，Windows 包的 app.asar 里其实带了整个项目目录（docs、test、CLAUDE.md、release，我这次加的 scripts 也会进去）。用原配置在 Mac 上交叉打 Windows 目录包核实过。现在把顶层列表完整抄到 `win.files` 里再加排除，Windows 的 app.asar 只剩 src、package.json、marked、ws，520 KB。

## 实测

全部用 `say -o x.wav --data-format=LEI16@16000` 生成，没用扬声器。声音：英文 Daniel、Samantha、Fred、Ralph、Albert、Kathy、Karen、Rishi、Junior；中文 Tingting、Meijia、Sinji；Tingting 另外读了一遍英文句子当「同一个人说另一种语言」。（`say -v 'Eddy (中文（中国大陆）)'` 这类带括号的声音名会悄悄退回默认声音，生成的文件跟 Samantha、Tingting 一模一样，已剔除。）

注册：每个声音读一段 24 秒左右的自我介绍，去静音后取前 15 秒注册（Tingting 混读：中英各 7.5 秒）。测试：6 句跟注册内容不同的句子，去静音后拼起来切成不重叠的 1 秒（24 段）、3 秒（约 12 段）、8 秒（约 5 段）。注册了 5 个声音（Daniel、Samantha、Karen、Tingting、Meijia），每个都跟其余所有声音比。

### 选型

sherpa-onnx-node 1.13.8 在 npm 上有 darwin-arm64、darwin-x64、win-x64（还有 linux 和 win-ia32）预编译包，Node-API，不用按 Electron 重编。Mac 的 .node 用 `@loader_path` 找旁边的 dylib，Windows 的 .node 用 delay-load 钩子找宿主进程，Electron 里都能直接加载。

模型对比（同一套数据，等错误率，越低越好）：

| 模型 | 大小 | 许可证 | 1 秒 EER | 1 秒 EER（含跨语言） | 3 秒 EER（含跨语言） | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 3D-Speaker CAM++ zh_en common_advanced（选它） | 28.3 MB | Apache-2.0 | 0.7% | 2.0% | 0.0% | 中英文大规模数据训练 |
| 3D-Speaker ERes2Net en VoxCeleb | 26.5 MB | Apache-2.0 | 1.6% | 1.8% | 0.0% | 接近，中文数据少 |
| 3D-Speaker CAM++ zh-cn common | 28.3 MB | Apache-2.0 | 2.7% | 3.6% | 2.7% | 只训了中文 |
| WeSpeaker ResNet34 en VoxCeleb | 26.5 MB | CC BY 4.0 | 3.7% | 4.6% | 1.0% | 不同声音也有 0.7 以上，阈值要 0.8 左右 |
| WeSpeaker CAM++ en VoxCeleb | 29.3 MB | CC BY 4.0 | | | | 输出异常（同一声音 8 秒片段只有 0.23），放弃 |

模型来源：https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models （tag 名原文就拼错了），许可证在 ModelScope 的 iic/speech_campplus_sv_zh_en_16k-common_advanced 页面核实为 Apache License 2.0。

### 相似度分布（选定模型，最终实现）

同一声音、同一语言（5 个注册声音汇总）：

| 片段 | 最低 | 平均 |
| --- | --- | --- |
| 1 秒 | 0.64 | 0.78 |
| 3 秒 | 0.81 | 0.90 |
| 8 秒 | 0.91 | 0.93 |

不同声音（每个注册声音对其余所有声音，90 分位 / 最高）：

| 注册的声音 | 1 秒 | 3 秒 | 8 秒 |
| --- | --- | --- | --- |
| Daniel | 0.26 / 0.39 | 0.28 / 0.35 | 0.30 / 0.33 |
| Samantha | 0.42 / 0.66 | 0.48 / 0.70 | 0.49 / 0.68 |
| Karen | 0.42 / 0.67 | 0.52 / 0.68 | 0.55 / 0.67 |
| Tingting | 0.35 / 0.64 | 0.36 / 0.65 | 0.33 / 0.63 |
| Meijia | 0.44 / 0.63 | 0.52 / 0.67 | 0.50 / 0.68 |

0.6 以上的几乎都来自两对：Samantha 和 Karen、Tingting 和 Meijia。我猜是苹果同一代神经 TTS 共用声码器，真人之间不会这么像。

跨语言（Tingting 注册，测她读英文）：

| 注册方式 | 1 秒 | 3 秒 | 8 秒 |
| --- | --- | --- | --- |
| 只读中文 | 平均 0.47，最低 0.31 | 0.57，最低 0.49 | 0.60，最低 0.58 |
| 中英混读 | 平均 0.62，最低 0.41 | 0.74，最低 0.67 | 0.78，最低 0.77 |

混读注册后中文片段是 0.76 / 0.87 / 0.88（1 / 3 / 8 秒）。

整句（4.5 到 7 秒，带句首句尾静音和句中停顿，走 `scoreSegment`）：Daniel 注册后 Daniel 的 6 句 0.91 到 0.97，其他声音全部 ≤ 0.37。Tingting 混读注册后她的中文句 0.85 到 0.87、英文句 0.82 到 0.85；Meijia 0.57 到 0.62，其余 ≤ 0.47。

### 阈值

同语言目标、不同声音汇总后，各阈值的漏判 / 误判：

| 阈值 | 1 秒 | 3 秒 | 8 秒 |
| --- | --- | --- | --- |
| 0.40 | 0% / 9.2% | 0% / 16.1% | 0% / 20.4% |
| 0.45 | 0% / 6.8% | 0% / 10.5% | 0% / 13.5% |
| **0.50** | 0% / 5.3% | 0% / 7.3% | 0% / 8.6% |
| 0.55 | 0% / 3.5% | 0% / 6.4% | 0% / 6.5% |
| 0.60 | 0% / 0.8% | 0% / 5.3% | 0% / 6.5% |

去掉上面那两对很像的 TTS 声音，0.5 下的误判是 0.1% / 1.0% / 2.2%。加上跨语言（混读注册）的目标，0.5 下 1 秒片段漏判 0.6%。

默认 0.5 的理由：TTS 同一声音每次都完全一致，真人换个距离、换个语气分数会比这里低，阈值再往上提，先出问题的是把我自己的话判成对方。如果设置里开放调节，范围给 0.4 到 0.7。

### -12 dB 串音

把另一个声音按 RMS 低 12 dB 叠加进去，用注册的声纹打分（平均，括号里是最低或最高）：

| 我 + 别人 | 片段 | 我单独 | 我 + 别人（-12 dB） | 别人 + 我（-12 dB） |
| --- | --- | --- | --- | --- |
| Daniel + Samantha | 1 秒 | 0.79 | 0.75（最低 0.67） | 0.21（最高 0.35） |
| | 3 秒 | 0.91 | 0.89（最低 0.85） | 0.23（最高 0.27） |
| | 8 秒 | 0.93 | 0.90（最低 0.89） | 0.25（最高 0.27） |
| Daniel + Fred | 1 秒 | 0.79 | 0.77（最低 0.67） | 0.34（最高 0.50） |
| | 3 秒 | 0.91 | 0.89（最低 0.84） | 0.36（最高 0.56） |
| Tingting + Sinji | 1 秒 | 0.77 | 0.71（最低 0.56） | 0.25（最高 0.35） |
| | 3 秒 | 0.90 | 0.87（最低 0.84） | 0.31（最高 0.37） |
| Tingting + Daniel | 1 秒 | 0.77 | 0.71（最低 0.55） | 0.20（最高 0.29） |
| Tingting + Meijia | 1 秒 | 0.77 | 0.71（最低 0.56） | 0.53（最高 0.63） |
| | 3 秒 | 0.90 | 0.87（最低 0.82） | 0.61（最高 0.65） |

### 耗时

M4，测的时候机器上还有别的任务在跑（load average 10 到 17），numThreads=1，中位数（90 分位）：

| 操作 | 耗时 |
| --- | --- |
| embed 1 秒 | 8 ms（11 ms） |
| embed 3 秒 | 18 ms（19 ms） |
| embed 8 秒 | 48 ms（91 ms） |
| embed 15 秒 | 86 ms（91 ms） |
| enrollFrom 15 秒语音 | 86 ms |
| 建模型（热） | 150 到 270 ms |
| resample 10 秒 24k → 16k | 15 ms |
| trimSilence 20 秒 | 0.7 ms |

2 线程时 8 秒片段 31 ms，4 线程在机器忙的时候反而更慢，默认用 1 线程。

Electron 里：

| 环境 | 建模型 | 2 秒合成音 embed | enrollFrom（24 秒录音） | Daniel 同声音 / Samantha / Tingting |
| --- | --- | --- | --- | --- |
| `electron <scratch>/main.js`，开发版主进程（Electron 44.4.5，Node 24.21.0） | 516 ms | 18 ms | 427 ms | 0.926 / 0.265 / 0.265 |
| `--mac --arm64 --dir` 打包版，voiceprint.js 在 app.asar 里 | 256 ms（另一次刚拷出来的包 2306 ms，冷启动） | 31 ms | 239 ms | 同上 |
| `--mac --x64 --dir` 打包版，Rosetta 下运行 | 3836 ms（Rosetta 首次翻译） | 71 ms | 665 ms | 同上 |

打包版的验证方法：把真实配置打出来的 .app 复制一份，往 app.asar 里加一个入口脚本、把 package.json 的 main 指过去，重新 ad-hoc 签名后运行。electron-builder 不允许把 /private/tmp 下的文件打进包，所以没法直接用配置加入口。E1 加上 `--selftest=voiceprint` 以后，就能直接用正式包跑。

测试脚本和原始结果在 scratchpad 的 `wf/voiceprint/`（bench.mjs、eer.py、raw-sentences.mjs、timing.mjs、bench-*.json），不进仓库。

## 需要别人改的地方

- E1：接线见上；`selftest.js` 加 `voiceprint`；CI 加一步 Voiceprint self-test；`settings.js` 的 `voiceprint: { threshold: 0.5 }` 不用改。
- E2：朗读文字中英混读；错误文案直接显示。
- 主会话：CLAUDE.md 的架构取舍里可以加一条「声纹：sherpa-onnx 原生库和模型放 Resources（extraResources），不进 asar；Mac x64 的原生包由 beforePack 钩子补」，验证里加 `--selftest=voiceprint`。

## 没做完 / 风险

- Windows 没在真机上跑过。CI 上 `npm test` 会在 Node 22 里加载 win-x64 的 DLL 并算向量；打包版要等 E1 加了 selftest 和 CI 那一步才算验证。Windows 11 的 System32 里可能有别的版本的 onnxruntime.dll。我猜不会串（libuv 用 LOAD_WITH_ALTERED_SEARCH_PATH 加载 .node，依赖的 DLL 先在 .node 所在目录找），要靠 CI 实测确认。
- 阈值全部来自 TTS。真人同一个人的分数会比这里低，建议 E1 接好后用户录一次声纹、开一次会，看日志里 me 和 other 的分数再调。
- `embed` 在主进程同步跑，慢机器上 8 秒片段可能 150 ms 以上。
- 仓库里多了一个 28 MB 的二进制模型文件。
