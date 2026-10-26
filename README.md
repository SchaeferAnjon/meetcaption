# MeetCaption

**English** · [简体中文](README.zh-CN.md) · Website: [meetcaption.us-cloud.uk](https://meetcaption.us-cloud.uk)

MeetCaption turns the audio on your computer into live captions while you are in Zoom, Teams, Tencent Meeting or an online class. Captions float above every window, each sentence is followed by its translation, matching phrases share a color, and hard terms show an explanation when you hover over them. When someone asks you a question, the answer card next to the captions gives you a reply you can read out. One shortcut hides captions and the answer card, and the same shortcut brings them back. Everything is saved with timestamps, and after the meeting AI writes the minutes, the changes people asked for, your to-dos and deadlines. In class, it takes live notes while you listen and writes full class notes afterwards.

The other side does not need to turn on captions, you do not need a virtual sound card, and you do not need to hold a phone up to the screen. Works on Mac and Windows. Open source under GPL-3.0.

Download: [latest release](https://github.com/SchaeferAnjon/meetcaption/releases/latest)

## Languages

- **Recognition and translation in 60 languages**: English, Chinese, Japanese, Korean, German, French, Spanish, Italian, Portuguese, Russian and 50 more. Captions can be translated into any of them, plus Traditional Chinese.
- **Local recognition** (free, offline, runs on your computer) understands Chinese, English and a mix of both. Other languages use cloud recognition.
- **When the network drops** during a Chinese or English meeting with cloud recognition, local recognition carries on from where the cloud stopped, and the cloud takes over again a few seconds after the network is back. Other languages wait for the network; the last 60 seconds are filled in once it reconnects.
- **The interface comes in 9 languages**: 简体中文, 繁體中文, English, 日本語, 한국어, Deutsch, Français, Español, Italiano. It follows your system language; change it in **Settings**, page **General**, item **Interface language**.
- Minutes, notes, to-dos, term explanations and the key point of each AI answer are written in the language you translate into. The answer itself follows the language of the question, so you can say it out loud.

Where to set the languages:

- What the other side speaks: in each project, on the **Materials** tab.
- What to translate into: **Settings**, page **Captions and answer card**, or per project.
- A new install picks both from your system language.

## Install

- **Mac with Apple silicon (M1 to M4)**: `MeetCaption-<version>-mac-arm64.dmg`
- **Mac with Intel chip**: `MeetCaption-<version>-mac-x64.dmg`
- **Windows 10 and 11**: `MeetCaption-<version>-win-x64.exe`

Mac needs macOS 14.2 or later. If macOS says the developer cannot be verified the first time you open it, open **System Settings**, go to **Privacy & Security**, scroll to the bottom and click **Open Anyway**.

On Windows, if **Windows protected your PC** appears, click **More info**, then **Run anyway**.

After that, MeetCaption updates itself. Each time it starts, and every 6 hours after that, it checks GitHub for a new version, downloads it in the background and shows **Restart to update** in the main window when it is ready. It never restarts while you are recording; if you do not click, the update installs the next time you quit. Your meetings and settings stay as they are. To turn this off, open **Settings**, page **General**, and switch off **Automatic updates**.

## First run

The first time you open MeetCaption, a setup window walks you through six steps: welcome, permissions, languages, a listening test, your voiceprint (optional; you can record it later in **Settings**, page **Voiceprint**) and start. It asks for two permissions: the microphone, and on Mac the recording of system audio. Click **Open System Settings** and a rabbit icon appears next to System Settings; drag it into the **System Audio Recording Only** list. If macOS asks you to quit and reopen the app, the guide comes back at the step where you stopped. The listening test uses local recognition and does not use up a session. At the end it can point out where Start meeting, the captions, the answer card and the language button are in the main window.

Captions work right away with local recognition, no key needed. New users get **1 free session** (up to 1 hour) with cloud recognition and AI included.

## Pricing

The app is free and open source. For translation, AI answers and notes you have two options:

- **Your own API key**: free forever, no session limit. You pay your provider directly (DeepSeek, Qwen, Kimi, Doubao, Zhipu, OpenAI and others; a ChatGPT Plus or Pro account can sign in directly). Sentences go straight from your computer to the provider.
- **Membership**: no keys to set up, cloud recognition and AI included. Pay per session, sessions never expire and nothing renews automatically. A session is one recording of up to 2 hours.

| Pack | 1 session | 10 sessions | 30 sessions | 100 sessions |
|---|---|---|---|---|
| CNY | ¥12.8 | ¥108 | ¥298 | ¥888 |
| USD | $1.99 | $15 | $42 | $125 |

Buy inside the app (the session is added automatically) or on the [website](https://meetcaption.us-cloud.uk/#page=pricing) (you get a license code). One license code works on up to 2 computers. Unused sessions can be refunded within 14 days.

## Modes

- **Meeting**: captions, translation, terms and automatic answers.
- **Interview**: like a meeting, with a more visible answer card, automatic answers on by default and your profile from the project (for example your CV highlights).
- **Class**: choose **In-classroom** (the microphone hears the teacher) or **Online class** (computer audio). Live notes update about every two minutes: outline, key points, formulas, what the teacher stressed, homework and deadlines. Press `⌘⌥P` / `Ctrl+Alt+P` to capture the current slide. After class, **Generate class notes** writes complete notes with outline, formulas, examples, exam points, homework, a glossary and self-test questions, plus an illustrated version that puts each slide where the teacher talked about it.

## During a meeting

1. Pick a project in the main window and click **Start meeting**, or press `⌘⌥R` / `Ctrl+Alt+R` in your meeting app; press it again to stop.
2. Captions appear at the bottom of the screen as the other side speaks.
3. `⌘⌥S` / `Ctrl+Alt+S` shows or hides captions and the answer card.
4. When someone asks you a question, the answer card shows a reply. If it does not appear on its own, press `⌘⌥A` / `Ctrl+Alt+A`.
5. When you share your screen, the other side does not see captions or the answer card.

Every shortcut can be changed in **Settings**, page **Shortcuts**.

## After the meeting

Click **Generate minutes** in the meeting and AI writes a one-line summary, the discussion points, what the other side asked you to change, your to-dos with deadlines (with the original words and time), a deadline table where phrases like *next Friday* become dates, and what needs checking. To-dos go to the project they belong to and can be checked off on the **To-dos** page.

Meetings are saved in the **会议字幕** folder in your Documents folder (configurable), one folder per project and one folder per meeting, as plain Markdown files.

## Privacy

- No account, no sign-up.
- With local recognition the audio never leaves your computer.
- With membership cloud recognition, audio goes from your computer straight to Soniox for recognition; our server only hands out a one-time key.
- Sentences to translate or answer go to the AI service you choose. With your own key they go straight to your provider; with membership they pass through our server to DeepSeek and are not stored. Our server records only how long each session ran and how many tokens it used.
- Your voiceprint, recordings, notes and keys stay on your computer.

## Development

```bash
npm install
npm run models            # download the local recognition model (170 MB, not in git) to resources/models/xasr
npm start                 # run in development
npm test                  # unit tests
npm run dist:mac          # build the Mac packages (dist/), on a Mac
npm run dist:win          # build the Windows installer, on Windows
```

Releasing a version (the app's automatic updates read the GitHub release): bump `version` in `package.json`, push to `main`, then push a tag `v<version>` so CI builds the Windows installer. Then run `node scripts/release.mjs` on a Mac that has the Developer ID certificate: it builds the Mac dmg and zip (automatic updates on Mac need the same certificate as the installed app, so the CI Mac build cannot be used), downloads the Windows files from CI, checks the signature and that `latest-mac.yml` and `latest.yml` are complete, and leaves everything in `release/<version>/`. Write the release notes in `release/<version>/notes.md`, then `node scripts/release.mjs --publish` uploads exactly those files and creates the release.

GitHub Actions (`.github/workflows/build.yml`) builds on Windows and Mac and checks with a VB-CABLE virtual sound card that loopback capture works. The website in `website/` is published to GitHub Pages by `.github/workflows/pages.yml`.

Self-tests (no window; results go to `MEETCAPTION_SELFTEST_OUT`, or the terminal):

```bash
electron . --selftest=capture:10   # capture system audio for 10 seconds and print levels
electron . --selftest=asr:30       # run 30 seconds with the current settings: recognition, me/other, translation and terms, answers, saving
electron . --selftest=voiceprint   # load the voiceprint model once (checks the packaged native library and model)
electron . --selftest=answer       # open the answer card and click a button
electron . --selftest=enroll:12 --fake-mic=me.wav   # record a voiceprint with a file instead of the microphone
electron . --selftest=ui:8         # open the interface with captions and answer card in layout mode, quit after 8 seconds
```

End-to-end without devices: add `--fake-system=a.wav --fake-mic=b.wav` to `--selftest=asr` to feed files at real-time speed instead of computer audio and microphone. To open the full interface without devices: `MEETCAPTION_FAKE_SYSTEM=a.wav MEETCAPTION_FAKE_MIC=b.wav npm start`.

Useful environment variables:

- `MEETCAPTION_USERDATA=<folder>`: keep settings, voiceprint and sign-ins in a test folder instead of your own data.
- `MEETCAPTION_API=<url>`: point the membership client at another backend.
- `MEETCAPTION_UPDATE_URL=<url>`: check a local update server (a folder with `latest-mac.yml` and the zip) instead of GitHub, to test automatic updates with a packaged build.
- `MEETCAPTION_SONIOX_URL=<ws url>`: connect Soniox recognition through another address (for testing network drops through a local relay).
- `MEETCAPTION_NO_EXTERNAL=1`: do not open the system browser (for tests).
- `MEETCAPTION_DEBUG=1`: print recognition events, audio positions and the me/other decisions.

Layout:

- `src/main/audio/`: system audio on Mac with audiotee (Core Audio taps), the speech gate, voiceprint (sherpa-onnx + CAM++), a 60-second microphone ring buffer
- `src/renderer/capture/`: WASAPI loopback on Windows and the microphone on both systems
- `src/main/asr/`: local recognition (X-ASR in a utility process), Soniox, OpenAI and Doubao streaming recognition
- `src/main/member/`: membership client (trial, sessions, temporary recognition keys, purchases)
- `src/main/i18n.js`, `src/renderer/shared/i18n.js`, `src/i18n/`: interface languages, keyed by the Simplified Chinese source text
- `src/main/languages.js`: the 60 recognition and translation languages
- `src/main/engine.js`: capture, recognition, sentences, me/other, translation and terms, answers, saving
- `src/main/llm/`: ChatGPT sign-in and OpenAI-compatible providers
- `src/renderer/`: captions window, answer card, main window, settings, onboarding and the shared design system

## License

[GPL-3.0-or-later](LICENSE). Licenses of the bundled third-party models and native libraries (sherpa-onnx, ONNX Runtime, CAM++, X-ASR) are in [resources/models/NOTICE.txt](resources/models/NOTICE.txt).
