// 本地识别模型（X-ASR 中英文流式带标点，480ms，int8）下载到 resources/models/xasr，打包时随 extraResources 进安装包。
// 模型 170 MB，不进 git：开发时 `npm run models`，打包前 before-pack.mjs 自动调。已经在且校验对就什么都不做。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const XASR_DIR = path.join(ROOT, 'resources', 'models', 'xasr')
const NAME = 'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2`
const ARCHIVE_SHA256 = 'fa5f63d618e5a01526e275a358bb7772e403f84808a4769fba52cffd8160bf74'
const FILES = {
  'encoder.int8.onnx': '908596dcc137a73b95be908ca55e88caa1b3dbbe8027c171615f4b0609c5eb1e',
  'decoder.onnx': 'a1cbc9eac2d5e3fb6617a218c67ad6daaa7f4e0fd225f08b2c22ab0413c8c257',
  'joiner.int8.onnx': 'aedb7fa697b2ab43f20499826fff7c997eea7d67db77be97769aeeeb726e63b3',
  'tokens.txt': 'b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c',
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function ok(dir) {
  return Object.entries(FILES).every(([f, h]) => {
    const p = path.join(dir, f)
    return fs.existsSync(p) && sha256(p) === h
  })
}

export async function ensureXasr({ log = console.log } = {}) {
  if (ok(XASR_DIR)) return XASR_DIR
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xasr-'))
  try {
    const archive = path.join(tmp, `${NAME}.tar.bz2`)
    log(`下载本地识别模型 ${URL}`)
    const res = await fetch(URL)
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
    if (sha256(archive) !== ARCHIVE_SHA256) throw new Error('模型压缩包校验不对')
    execFileSync('tar', ['-xjf', archive, '-C', tmp])
    fs.mkdirSync(XASR_DIR, { recursive: true })
    for (const f of Object.keys(FILES)) fs.copyFileSync(path.join(tmp, NAME, f), path.join(XASR_DIR, f))
    if (!ok(XASR_DIR)) throw new Error('解压出来的模型文件校验不对')
    log(`本地识别模型在 ${XASR_DIR}`)
    return XASR_DIR
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureXasr().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
