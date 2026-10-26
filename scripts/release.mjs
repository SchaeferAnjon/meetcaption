#!/usr/bin/env node
// 发一个新版本到 GitHub Release（正式版的自动更新从这里拿，src/main/updater.js）：
//   1. 改 package.json 的 version，提交推到 main，打 tag v<版本> 推上去：CI 在 tag 上打 Windows 安装包（windows-installer 产物里带 latest.yml）
//   2. node scripts/release.mjs：本机用钥匙串里的 Developer ID 打 Mac 的 dmg + zip（Mac 的自动更新要和装着的版本同一张证书签名，
//      CI 的 Mac 包是临时签名，不能用），下载 CI 的 Windows 产物，核对更新要的文件齐不齐，放在 release/<版本>/
//   3. 看过没问题：node scripts/release.mjs --publish --notes <说明.md>，建 Release（不是草稿）并上传
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const publish = args.includes('--publish')
const notesAt = args.indexOf('--notes')
const notesFile = notesAt >= 0 ? args[notesAt + 1] : ''
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const tag = `v${version}`
const out = path.join(ROOT, 'release', version)

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', ...opts }).trim()
const fail = (msg) => {
  console.error(`没发：${msg}`)
  process.exit(1)
}

// 代码和 tag 对得上：工作区干净，HEAD 就是 tag 指的提交，tag 已经推上去了
if (run('git', ['status', '--porcelain'])) fail('工作区有没提交的改动')
const head = run('git', ['rev-parse', 'HEAD'])
const remoteTag = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`, `refs/tags/${tag}`])
if (!remoteTag) fail(`GitHub 上还没有 ${tag}：先 git tag ${tag} && git push origin ${tag}，等 CI 跑完`)
const tagCommit = remoteTag.split('\n').find((l) => l.endsWith('^{}'))?.split(/\s/)[0] ?? remoteTag.split(/\s/)[0]
if (tagCommit !== head) fail(`${tag} 指的是 ${tagCommit.slice(0, 7)}，本机 HEAD 是 ${head.slice(0, 7)}`)
const existing = spawnSync('gh', ['release', 'view', tag], { cwd: ROOT, encoding: 'utf8' })
if (existing.status === 0) fail(`GitHub 上已经有 ${tag} 的 Release`)

// CI 在这个 tag 上的构建要成功，拿它的 Windows 安装包
const runs = JSON.parse(run('gh', ['run', 'list', '--workflow', 'build', '--branch', tag, '--json', 'databaseId,headSha,status,conclusion', '--limit', '5']))
const ci = runs.find((r) => r.headSha === head)
if (!ci) fail(`CI 还没在 ${tag} 上跑`)
if (ci.status !== 'completed') fail(`CI 还在跑（gh run watch ${ci.databaseId}）`)
if (ci.conclusion !== 'success') fail(`CI 没过（gh run view ${ci.databaseId}）`)

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
console.log(`下载 CI ${ci.databaseId} 的 Windows 安装包…`)
run('gh', ['run', 'download', String(ci.databaseId), '-n', 'windows-installer', '-D', path.join(out, 'win')], { stdio: 'inherit' })

console.log('本机打 Mac 包（Developer ID 签名，arm64 + x64，dmg + zip）…')
const mac = spawnSync('npx', ['electron-builder', '--mac', '--arm64', '--x64', '--publish', 'never', `-c.directories.output=${path.join(out, 'mac')}`], { cwd: ROOT, stdio: 'inherit' })
if (mac.status !== 0) fail('Mac 包没打成')

// 更新要的文件：latest-mac.yml 里两个架构的 zip，latest.yml 里的 exe，版本号都是这一版
const files = []
const need = (dir, re, label) => {
  const hit = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f))
  if (!hit.length) fail(`少了${label}（${dir}）`)
  files.push(...hit)
  return hit
}
need(path.join(out, 'mac'), new RegExp(`^MeetCaption-${version}-mac-(arm64|x64)\\.dmg$`), ' Mac 的 dmg')
need(path.join(out, 'mac'), new RegExp(`^MeetCaption-${version}-mac-(arm64|x64)\\.zip(\\.blockmap)?$`), ' Mac 的 zip')
need(path.join(out, 'win'), new RegExp(`^MeetCaption-${version}-win-x64\\.exe(\\.blockmap)?$`), ' Windows 的 exe')
const [macYml] = need(path.join(out, 'mac'), /^latest-mac\.yml$/, ' latest-mac.yml')
const [winYml] = need(path.join(out, 'win'), /^latest\.yml$/, ' latest.yml')
for (const [yml, want] of [
  [macYml, [`MeetCaption-${version}-mac-arm64.zip`, `MeetCaption-${version}-mac-x64.zip`]],
  [winYml, [`MeetCaption-${version}-win-x64.exe`]],
]) {
  const text = fs.readFileSync(yml, 'utf8')
  if (!text.includes(`version: ${version}`)) fail(`${path.basename(yml)} 里的版本不是 ${version}`)
  for (const f of want) if (!text.includes(f)) fail(`${path.basename(yml)} 里没有 ${f}`)
}
console.log(`\n${tag} 要上传的文件（${out}）：`)
for (const f of files) console.log(`  ${path.relative(out, f)}  ${(fs.statSync(f).size / 1e6).toFixed(1)} MB`)

if (!publish) {
  console.log(`\n核对过了，还没上传。确认后：node scripts/release.mjs --publish --notes <说明.md>`)
  process.exit(0)
}
if (!notesFile || !fs.existsSync(notesFile)) fail('发布要给 --notes <说明.md>')
run('gh', ['release', 'create', tag, '--verify-tag', '--title', `会议字幕 ${version}`, '--notes-file', notesFile, ...files], { stdio: 'inherit' })
console.log(`已发布 ${tag}：装着旧版的正式版会在启动 30 秒内、或者 6 小时内查到并下载`)
