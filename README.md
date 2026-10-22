# 会议字幕

开 Zoom、Teams、腾讯会议时，把电脑里放出来的声音实时转成字幕，浮在屏幕最上层，每句英文下面跟一句中文，意群用颜色对上，难词悬停就有解释。对方一问完，旁边的答题框马上给出能照着说的回答。按一个快捷键字幕和答题框立刻消失，再按一下立刻出现。每句话带时间自动存档，会开完一键让 AI 整理出要点、要改的地方、待办和 DDL。上课也能用：课堂模式边听边出笔记，下课生成整理好的课堂笔记。

不需要对方开字幕，不需要虚拟声卡，也不用把手机架在屏幕前。Windows 和 Mac 都能用。

下载：[GitHub Releases](https://github.com/SchaeferAnjon/meetcaption/releases/latest)。源码以 GPL-3.0 开源。

## 安装

- **Mac（M1/M2/M3/M4）**：`MeetCaption-版本-mac-arm64.dmg`
- **Mac（Intel）**：`MeetCaption-版本-mac-x64.dmg`
- **Windows 10/11**：`MeetCaption-版本-win-x64.exe`

Mac 需要 macOS 14.2 或更新。第一次打开会提示「无法验证开发者」：去 系统设置 → 隐私与安全性，拉到最下面点「仍要打开」。第一次开始记录时会问能不能录制系统声音，点允许。

Windows 第一次运行如果弹出「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。

## 第一次设置

第一次打开会出一个引导：

0. 登录：发布的安装包要先用 Google 账号登录（没登录不能开始记录）；自己从源码编的版本没有这一步。
1. 录声纹：照着念一段中英混合的文字，12 秒。有了声纹才分得清哪句是我说的，外放时漏进麦克风的对方声音也能滤掉。
2. 连接 AI：推荐用 ChatGPT 账号登录，翻译、纪要、答题都用订阅额度；也可以填 OpenAI API Key。
3. 语音识别：默认「本地识别」，什么都不用填，点「测试」确认一下就行；也可以换成豆包（填 App ID 和 Access Token）或 OpenAI（用上一步的 Key）。
4. 建第一个项目：名字、一句话背景，术语和我的资料可以先空着。
5. 试一下：Mac 上给系统录音和屏幕录制权限，放点声音看音量条动不动。

哪一步想以后再弄就点「稍后再说」。引导关掉以后可以在「设置 → 通用」里重新打开。

在国内网络连不上 OpenAI 的话，识别用本地识别，AI 换成 DeepSeek、Kimi 这类国内服务（选「其他（OpenAI 兼容接口）」，填接口地址、Key、模型名）。

## 中英对照

字幕里每句英文下面紧跟它的中文，一句一对，不拼成大段。英文按意群切成几块，每块一种颜色，中文里对应的部分用同一种颜色，一眼就能对上。专业术语在英文和中文两边都有虚线，鼠标停上去弹出一句解释。意群颜色可以在「设置 → 字幕与答题框」里关掉或换成底部色条。

## 三种模式

开始时选模式，项目里可以设默认模式：

- **会议**：字幕、翻译、术语、自动答题。
- **面试**：和会议一样，答题框更显眼，自动回答默认开着，会用上项目里「我的资料」（简历要点等）。
- **课堂**：先选「教室现场」（用麦克风听老师）还是「网课」（听电脑里的声音）。自动答题默认关，老师点名提问时按 `⌘⌥A` / `Ctrl+Alt+A` 让 AI 帮你答。右边是实时笔记，每两分钟左右更新一次：小节大纲、要点、公式、老师强调的考点、作业和截止时间。网课时按 `⌘⌥P` / `Ctrl+Alt+P` 截取当前课件画面。下课点「生成课堂笔记」，得到一份完整笔记（大纲、知识点、公式、例子、考点、作业、术语表、自测题），作业会进待办；「导出到笔记库」可以连截图一起拷到你的 Obsidian 课程文件夹。

## 项目

每场会议都属于一个项目，比如「论文：Danish 合作」「面试：X 公司」。项目里存着这类会议的背景、术语、我的资料（面试时放简历要点）和对方说的语言，开会时识别、翻译、答题都用它。没选项目的会议放在「未归类」。

一场会里聊到别的项目也没关系：生成纪要时 AI 知道你所有的项目，每条待办会标到它该去的项目，那个项目的「待办」里就能看到。

## 开会时

1. 在主窗口选好项目，点「开始会议」。不想切窗口就在会议软件里直接按 `⌘⌥R` / `Ctrl+Alt+R`，在当前项目里开始，再按一次停止。托盘菜单里也能切项目、开始记录。
2. 对方说话，屏幕下方就出字幕。默认的本地识别在你电脑上认，说完一个词约半秒出字，中文、英文、中英夹杂都能认。
3. Mac `⌘⌥S`、Windows `Ctrl+Alt+S` 显示或隐藏字幕和答题框。
4. 对方问了问题，右边的答题框会给出可以照着说的回答。没自动出来就按 `⌘⌥A` / `Ctrl+Alt+A`。
5. 共享屏幕时对方看不到字幕和答题框（设置里默认开着）。
6. 开完会点「停止」。

所有快捷键都能在「设置 → 快捷键」里改：全局的四个（显示隐藏、开始停止记录、让 AI 回答、截取画面）和主窗口里的八个（命令面板、打开设置、开始记录、回到记录、新建项目、首页、待办、返回）。点一下快捷键再按新的组合；按 Delete 表示不用这个快捷键；和别的快捷键重复，或者是复制、粘贴这类系统组合时会提示换一个。

## 会后

在会议详情里点「生成纪要」，AI 会写出：

- 一句话总结和讨论要点
- 对方的具体意见和修改要求
- 我要做的事（带截止日期，附原话和时间点）
- DDL 表，「next Friday」这种说法会换算成具体日期
- 没听清、需要再确认的地方

纪要写完再整理一遍待办：每条有截止日期、谁来做、原话和所属项目，可以勾掉。「待办」页按已逾期、今天、本周、以后分组，能按项目筛。

所有记录都在「文稿/会议字幕」（Windows 是「文档\会议字幕」，设置里可以改）里，一个项目一个文件夹，项目里每场会一个文件夹，`字幕记录.md` 和 `会议纪要.md` 用记事本或 Word 都能打开。项目文件夹里的 `project.json` 是项目的设置，整个文件夹拷走就是完整的项目。旧版本放在根目录下的会议，升级后第一次打开会自动挪进「未归类」。

## 费用

默认的本地识别免费。用 ChatGPT 账号登录的话，翻译、纪要、答题走你 ChatGPT 订阅的额度，不另外花钱，这样整套都不用付钱。用 OpenAI API Key 时按实际用量付给 OpenAI，没有订阅费：

- 识别换成 OpenAI 实时识别（gpt-live-transcribe）的话约 1 美元 / 小时，只在有人说话时计费
- 翻译每小时几美分
- 一场一小时的会议生成纪要几美分

豆包流式识别按连接时长计费，价格见火山引擎控制台。

## 隐私

声音不存盘。用本地识别时声音不出这台电脑；用豆包或 OpenAI 时只把说话的部分实时发给识别服务。存下来的只有文字。纪要和翻译会把文字发给你选的 AI 服务。答题时如果开了「带屏幕截图」，会把当前屏幕截一张一起发给 AI（字幕窗和答题框不会出现在截图里）。声纹只存在这台电脑上。

## 常见问题

**开始了但一直没字幕**：看「电脑声音」那条音量条动不动。
- 不动（Mac）：系统设置 → 隐私与安全性 → 录屏与系统录音 → 「仅系统录音」里打开「会议字幕」，然后重新开始。
- 不动（Windows）：会议声音要从默认的扬声器或耳机里放出来。
- 动了但没字：去「设置 → 语音识别」点「测试」。用豆包或 OpenAI 的话看 Key 对不对。

**字幕挡住了会议画面**：调小字号和行数，或者把字幕拖到屏幕上方。

**不想录我自己说的话**：设置 → 麦克风，关掉「同时记录我自己说的话」。开着时纪要更完整，识别费用翻倍；录好声纹后外放也能分清我和对方，戴耳机更稳。

## 开发

```bash
npm install
npm run models            # 下载本地识别模型（170 MB，不进 git）到 resources/models/xasr
npm start                 # 开发运行
npm test                  # 单元测试
npm run dist:mac          # 打 Mac 包（dist/），在 Mac 上跑
npm run dist:win          # 打 Windows 安装包，在 Windows 上跑
```

GitHub Actions（`.github/workflows/build.yml`）在 Windows 和 Mac 上各打一次包，同时用 VB-CABLE 虚拟声卡实测 loopback 能抓到声音。

账号登录（Google 登录、使用统计）连的是作者的 Supabase 项目，连接信息不在源码里。自己编的版本没有账号功能，不用登录就能用全部功能。发布的安装包打包时把它写进 package.json：

```bash
npx electron-builder --mac -c.extraMetadata.supabase.url=<URL> -c.extraMetadata.supabase.anonKey=<anon key>
```

开发时也可以用环境变量 `MEETCAPTION_SUPABASE_URL`、`MEETCAPTION_SUPABASE_ANON_KEY` 打开账号功能。

自测模式（不开界面，结果写到 `MEETCAPTION_SELFTEST_OUT`，没设就打到终端）：

```bash
electron . --selftest=capture:10   # 只抓系统声音 10 秒，输出音量统计
electron . --selftest=asr:30       # 用当前设置完整跑 30 秒：识别、我/对方、译文和术语、答题、存档
electron . --selftest=voiceprint   # 加载声纹模型算一次向量（验证打包后的原生库和模型）
electron . --selftest=answer       # 打开答题框真点一下按钮，看能不能点、会不会抢前台
electron . --selftest=enroll:12 --fake-mic=me.wav   # 走一遍「录制声纹」，麦克风换成文件
electron . --selftest=ui:8         # 打开界面，字幕窗和答题框进入调整模式，8 秒后退出（CI 截图）
```

项目相关：`--selftest=asr --project=<项目 id 或名字> --summary` 在指定项目里开会，停止后生成纪要和待办，输出里有会议文件夹、每条待办归到哪个项目；`--selftest=library` 只看根目录、迁移了什么、每个项目的会议和待办。

不接任何设备的端到端测试：`--selftest=asr` 加 `--fake-system=a.wav --fake-mic=b.wav`，用文件按实时速度代替电脑声音和麦克风；`--fake-voiceprint=c.wav` 先用文件注册声纹。测试音频用 `say -o x.wav --data-format=LEI16@16000 "..."` 生成，不要外放。输出里每段有 `who`（me/other）、`vp`（声纹分数）、`question`、译文、术语，另有被丢掉的串音、答题的首字耗时、翻译耗时。

开发时要打开完整界面但不接设备：`MEETCAPTION_FAKE_SYSTEM=a.wav MEETCAPTION_FAKE_MIC=b.wav npm start`，开会和录声纹都用文件。

常用环境变量：

- `MEETCAPTION_USERDATA=<目录>`：设置、声纹、ChatGPT 登录都放这里，测试别碰自己的数据；设置里的 `saveDir` 也指到测试目录。
- `OPENAI_API_KEY`、`VOLC_ASR_APP_ID`、`VOLC_ASR_ACCESS_TOKEN`：设置里没填时用它们，只在运行时用，不写进设置文件。
- `MEETCAPTION_CHATGPT_AUTH=codex`：ChatGPT 通道只读借用 `~/.codex/auth.json` 的登录（不刷新、不写）。
- `MEETCAPTION_DEBUG=1`：打印识别事件、每段的音频位置和我/对方的判断。

结构：

- `src/main/audio/`：Mac 用 audiotee（Core Audio taps）抓系统声音；门限按停顿切句；声纹（sherpa-onnx + CAM++）；麦克风最近 60 秒的环形缓冲
- `src/renderer/capture/`：Windows 用 Chromium 的 WASAPI loopback，麦克风两边都走这里
- `src/main/asr/`：本地识别（X-ASR，utilityProcess 里跑）、OpenAI 实时转写、豆包流式识别，结果带上这一段在音频里的位置
- `src/main/projects.js`：项目存储（project.json、未归类、改名改文件夹、旧设置迁移）；`sessions.js`：会议按项目存取、移动、缓存；`todos.js`：待办提取的 prompt、解析、相对日期、跨项目聚合；`summary.js`：纪要加待办；`search.js`：命令面板搜索
- `src/main/windows.js`：主窗口、设置窗口、引导窗口的外观（Mac 毛玻璃，Windows 11 Mica）
- `src/main/engine.js`：采集 → 识别 → 分句 → 我/对方（声纹 + 串音判断）→ 译文和术语 → 对方提问时答题 → 存档
- `src/main/llm/`：ChatGPT 账号登录和 OpenAI 兼容接口，翻译、纪要、答题都走 `complete()`
- `src/main/assist/`：判断提问、截屏、答题助手、答题框窗口
- `src/renderer/overlay/`：悬浮字幕窗（术语悬停解释）；`src/renderer/answer/`：答题框；`src/renderer/control/`：主窗口；`src/renderer/settings/`：设置窗口；`src/renderer/onboarding/`：首次引导；`src/renderer/shared/`：设计系统（颜色变量、组件、图标）

## 许可证

[GPL-3.0-or-later](LICENSE)。随安装包分发的第三方模型和原生库（sherpa-onnx、ONNX Runtime、CAM++、X-ASR）的许可证见 [resources/models/NOTICE.txt](resources/models/NOTICE.txt)。
