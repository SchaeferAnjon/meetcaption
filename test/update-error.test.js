import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { setUiLang, t } from '../src/main/i18n.js'

// 设置 → 通用 → 更新里「更新出错」的说法：settings/app.js 是页面脚本，这里把两个函数的原文取出来在 Node 里跑
const src = fs.readFileSync(new URL('../src/renderer/settings/app.js', import.meta.url), 'utf8')
const grab = (name) => src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))[0]
const { updateError, joinSentences } = Function('t', `${grab('updateError')}\n${grab('joinSentences')}\nreturn { updateError, joinSentences }`)(t)

// electron-updater 的原文（本机更新服务器上量到的）：latest-mac.yml 找不到 / yml 在但 zip 404
const NO_YML = 'Cannot find channel "latest-mac.yml" update info: HttpError: 404 Not Found'
const NO_ZIP = 'Cannot download "http://127.0.0.1/MeetCaption-0.6.2-arm64-mac.zip", status 404: Not Found'
const APPS = '会议字幕不在「应用程序」文件夹里，可能装不上更新：把它拖进「应用程序」后再打开。'

test('更新出错：新版的安装包（zip）404 说成「下载不到」，yml 找不到才是「还没有新版本」', () => {
  setUiLang('zh')
  assert.equal(updateError(NO_ZIP, '0.6.2'), '新版本 0.6.2 的安装包下载不到（404），过一会儿再试')
  assert.equal(updateError(NO_ZIP), '新版本的安装包下载不到（404），过一会儿再试')
  assert.equal(updateError('Cannot download "x.zip", status 503: Service Unavailable', '0.6.2'), '新版本 0.6.2 的安装包下载不到（503），过一会儿再试')
  assert.equal(updateError(NO_YML, '0.6.2'), 'GitHub 上还没有能自动更新的新版本')
  assert.equal(updateError('HttpError: 404 Not Found'), 'HttpError: 404 Not Found', '别的 404 原样给')
  setUiLang('en')
  assert.equal(updateError(NO_ZIP, '0.6.2'), "The installer for version 0.6.2 can't be downloaded (404). Try again in a while")
  setUiLang('zh')
})

test('更新状态行：状态句和「不在应用程序文件夹」两句之间有句末标点', () => {
  setUiLang('zh')
  assert.equal(joinSentences(t('更新出错：{0}', updateError(NO_YML)), APPS), `更新出错：GitHub 上还没有能自动更新的新版本。 ${APPS}`)
  assert.equal(joinSentences('已是最新版本 0.6.1', '后一句。'), '已是最新版本 0.6.1。 后一句。')
  assert.equal(joinSentences('已有句号。', '后一句。'), '已有句号。 后一句。')
  assert.equal(joinSentences('只有一句', ''), '只有一句')
  setUiLang('en')
  assert.equal(joinSentences(t('更新出错：{0}', updateError(NO_ZIP, '0.6.2')), t(APPS)), "Update failed: The installer for version 0.6.2 can't be downloaded (404). Try again in a while. MeetCaption isn't in the Applications folder, so updates may not install. Drag it into Applications and open it from there.")
  setUiLang('zh')
})
