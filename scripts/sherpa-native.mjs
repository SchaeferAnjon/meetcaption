// 声纹用的 sherpa-onnx 原生库：package.json 的 optionalDependencies 列了三个平台的包，pnpm 只装本机平台的那个，
// 在 M 芯片 Mac 上打 x64 包（或在 Mac 上打 Windows 包）时要把目标平台的包补进 node_modules，
// electron-builder 的 extraResources 再从 node_modules/sherpa-onnx-<平台>-<架构> 拷进 Resources/sherpa-onnx。
// 两种用法：electron-builder 的 beforePack 钩子（每个架构打包前自动调用）；或命令行 node scripts/sherpa-native.mjs darwin-x64 win-x64
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureXasr } from './fetch-models.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' } // builder-util 的 Arch 枚举

/** pnpm-lock.yaml 在工作区根上：canvas-notes 仓库里是 ../../，公开仓库里就是 ROOT */
function lockText() {
  for (let d = ROOT; ; d = path.dirname(d)) {
    const f = path.join(d, 'pnpm-lock.yaml')
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8')
    if (path.dirname(d) === d) throw new Error('找不到 pnpm-lock.yaml')
  }
}

export function ensureSherpaNative(tag) {
  const name = `sherpa-onnx-${tag}`
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).optionalDependencies?.[name]
  if (!version) throw new Error(`package.json 的 optionalDependencies 里没有 ${name}，先确认 sherpa-onnx-node 支持这个平台`)
  const integrity = new RegExp(`^  ${name}@${version.replaceAll('.', '\\.')}:\\n    resolution: \\{integrity: (\\S+?)\\}`, 'm').exec(lockText())?.[1]
  if (!integrity) throw new Error(`pnpm-lock.yaml 里没有 ${name}@${version}`)
  const entry = { version, integrity }
  const dir = path.join(ROOT, 'node_modules', name)
  try {
    const have = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version
    if (have === entry.version && fs.existsSync(path.join(dir, 'sherpa-onnx.node'))) return dir
  } catch {}

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-native-'))
  try {
    const win = process.platform === 'win32'
    const out = execFileSync(win ? 'npm.cmd' : 'npm', ['pack', `${name}@${entry.version}`, '--pack-destination', tmp, '--json'], {
      cwd: tmp,
      encoding: 'utf8',
      shell: win,
    })
    const tgz = path.join(tmp, JSON.parse(out)[0].filename)
    const got = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64')}`
    if (got !== entry.integrity) throw new Error(`${name}@${entry.version} 校验和跟 pnpm-lock.yaml 不一致`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=1'])
    console.log(`  • 已补上 ${name}@${entry.version}`)
    return dir
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

export default async function beforePack(context) {
  const platform = context.electronPlatformName === 'win32' ? 'win' : context.electronPlatformName
  const arch = ARCH[context.arch]
  if (!arch) throw new Error(`声纹原生库不支持这个架构：${context.arch}`)
  ensureSherpaNative(`${platform}-${arch}`)
  // 本地识别模型（resources/models/xasr）不进 git，打包前没有就下载
  await ensureXasr({ log: (m) => console.log(`  • ${m}`) })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const tag of process.argv.slice(2)) console.log(ensureSherpaNative(tag))
}
