# Development

Running from source, tests, releases, self-tests, environment variables and the code layout. The other design and test notes under `docs/` are in Chinese.

## Run from source

```bash
npm install
npm run models            # download the local recognition model (170 MB, not in git) to resources/models/xasr
npm start                 # run in development
npm test                  # unit tests
npm run dist:mac          # build the Mac packages (dist/), on a Mac
npm run dist:win          # build the Windows installer, on Windows
```

## Releasing a version

The app's automatic updates read the GitHub release.

1. Bump `version` in `package.json`, push to `main`, then push a tag `v<version>` so CI builds the Windows installer.
2. On a Mac that has the Developer ID certificate, run `node scripts/release.mjs`. It builds the Mac dmg and zip (automatic updates on Mac need the same certificate as the installed app, so the CI Mac build cannot be used), downloads the Windows files from CI, checks the signature and that `latest-mac.yml` and `latest.yml` are complete, and leaves everything in `release/<version>/`. It also makes three copies without the version number (`MeetCaption-win-x64.exe`, `MeetCaption-mac-arm64.dmg`, `MeetCaption-mac-x64.dmg`) and uploads them with the release; the README links to `releases/latest/download/<file name>`, so these names must stay.
3. Write the release notes in `release/<version>/notes.md`, then run `node scripts/release.mjs --publish`. It uploads exactly those files and creates the release, titled `MeetCaption <version>`.

GitHub Actions (`.github/workflows/build.yml`) builds on Windows and Mac and checks with a VB-CABLE virtual sound card that loopback capture works. The website in `website/` is published to GitHub Pages by `.github/workflows/pages.yml`.

## Self-tests

No window; results go to `MEETCAPTION_SELFTEST_OUT`, or the terminal.

```bash
electron . --selftest=capture:10   # capture system audio for 10 seconds and print levels
electron . --selftest=asr:30       # run 30 seconds with the current settings: recognition, me/other, translation and terms, answers, saving
electron . --selftest=voiceprint   # load the voiceprint model once (checks the packaged native library and model)
electron . --selftest=answer       # open the answer card and click a button
electron . --selftest=enroll:12 --fake-mic=me.wav   # record a voiceprint with a file instead of the microphone
electron . --selftest=ui:8         # open the interface with captions and answer card in layout mode, quit after 8 seconds
```

End-to-end without devices: add `--fake-system=a.wav --fake-mic=b.wav` to `--selftest=asr` to feed files at real-time speed instead of computer audio and microphone. To open the full interface without devices: `MEETCAPTION_FAKE_SYSTEM=a.wav MEETCAPTION_FAKE_MIC=b.wav npm start`.

## Environment variables

- `MEETCAPTION_USERDATA=<folder>`: keep settings, voiceprint and sign-ins in a test folder instead of your own data.
- `MEETCAPTION_API=<url>`: point the membership client and the daily usage ping at another backend. Runs from source and dev builds only send the ping when this is set.
- `MEETCAPTION_UPDATE_URL=<url>`: check a local update server (a folder with `latest-mac.yml` and the zip) instead of GitHub, to test automatic updates with a packaged build.
- `MEETCAPTION_SONIOX_URL=<ws url>`: connect Soniox recognition through another address (for testing network drops through a local relay).
- `MEETCAPTION_NO_EXTERNAL=1`: do not open the system browser (for tests).
- `MEETCAPTION_DEBUG=1`: print recognition events, audio positions and the me/other decisions.

## Code layout

- `src/main/audio/`: system audio on Mac with audiotee (Core Audio taps), the speech gate, voiceprint (sherpa-onnx + CAM++), a 60-second microphone ring buffer
- `src/renderer/capture/`: WASAPI loopback on Windows and the microphone on both systems
- `src/main/asr/`: local recognition (X-ASR in a utility process), Soniox, OpenAI and Doubao streaming recognition
- `src/main/member/`: membership client (trial, sessions, temporary recognition keys, purchases)
- `src/main/usagePing.js`: the anonymous daily check-in (`POST /v1/ping`, once per local day, only after the user agrees: `usageConsent` is `""` not asked yet, `yes` or `no`; asked once in onboarding (step 6) or, for people who have not answered, in a dialog when the main window opens (`src/renderer/control/consent.js`, text in `src/renderer/shared/consent.js`); switch in Settings › General)
- `src/main/i18n.js`, `src/renderer/shared/i18n.js`, `src/i18n/`: interface languages, keyed by the Simplified Chinese source text
- `src/main/languages.js`: the 60 recognition and translation languages
- `src/main/engine.js`: capture, recognition, sentences, me/other, translation and terms, answers, saving
- `src/main/llm/`: ChatGPT sign-in and OpenAI-compatible providers
- `src/renderer/`: captions window, answer card, main window, settings, onboarding and the shared design system

## README images

The three animations in the README are recorded from the demo on the website, so they need no app and no microphone:

```bash
node scripts/readme-assets.mjs                     # both languages, website/ served locally
node scripts/readme-assets.mjs --lang en           # one language
node scripts/readme-assets.mjs --site https://meetcaption.us-cloud.uk   # record the live site instead
```

It writes `docs/readme/en/` and `docs/readme/zh/` (transparent animated WebP, 840 px wide, under 400 KB each, one file for light and dark). It needs Google Chrome, Playwright (global install), `img2webp` and ImageMagick; re-run it whenever the website demo changes.

The screenshots in `docs/readme/en/`, `docs/readme/zh/` and `docs/readme/shots/` are real windows of the app run from source against a temporary data folder, with synthetic speech standing in for the other side (`MEETCAPTION_FAKE_SYSTEM`), captured on a plain gradient. Retake them when the interface changes.
