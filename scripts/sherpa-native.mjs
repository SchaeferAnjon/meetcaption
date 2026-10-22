// 声纹用的 sherpa-onnx 原生库：npm 只装本机平台的那个 optionalDependency，
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

export function ensureSherpaNative(tag) {
  const name = `sherpa-onnx-${tag}`
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const entry = lock.packages?.[`node_modules/${name}`]
  if (!entry) throw new Error(`package-lock.json 里没有 ${name}，先确认 sherpa-onnx-node 支持这个平台`)
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
    if (got !== entry.integrity) throw new Error(`${name}@${entry.version} 校验和跟 package-lock.json 不一致`)
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
