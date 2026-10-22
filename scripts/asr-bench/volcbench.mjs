// 豆包 2.0 基准：用软件里的 VolcStreamASR，按实时速度送同一段录音。node volcbench.mjs <数据集>
import fs from 'node:fs'
import path from 'node:path'
import { VolcStreamASR } from '../../src/main/asr/volc.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const ds = process.argv[2]
const pcm = fs.readFileSync(path.join(here, 'data', `${ds}.wav`)).subarray(44)
const asr = new VolcStreamASR({ appId: process.env.VOLC_ASR_APP_ID, accessToken: process.env.VOLC_ASR_ACCESS_TOKEN, resourceId: 'volc.seedasr.sauc.duration', hotwords: [] })
const finals = new Map()
let t0 = 0
asr.on('final', ({ key, text, span }) => {
  const now = (Date.now() - t0) / 1000
  finals.set(key, { text, end: span ? span.end / 1000 : null, lag: span ? +(now - span.end / 1000).toFixed(2) : null })
})
asr.on('drop', ({ key }) => finals.delete(key))
asr.on('fatal', (e) => { console.error('fatal', e.message); process.exit(1) })
await asr.connect()
t0 = Date.now()
const CH = 3200
for (let i = 0; i < pcm.length; i += CH) {
  asr.sendAudio(pcm.subarray(i, i + CH))
  const due = t0 + ((i + CH) / 32000) * 1000
  await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())))
}
await asr.close()
const list = [...finals.values()].sort((a, b) => (a.end ?? 0) - (b.end ?? 0))
const lags = list.map((x) => x.lag).filter((x) => x != null).sort((a, b) => a - b)
const out = { model: 'doubao-2.0', dataset: ds, threads: 0, lang: '', platform: 'cloud', audioSec: pcm.length / 32000, loadMs: 0, rssMB: 0, rtf: 0, finalLag: lags.length ? { p50: lags[Math.floor(lags.length / 2)], p90: lags[Math.floor(lags.length * 0.9)] } : null, finals: list, hyp: list.map((x) => x.text).join(' ') }
fs.writeFileSync(path.join(here, 'out', `doubao-2.0__${ds}__t0.json`), JSON.stringify(out, null, 1))
console.log(ds, 'finals', list.length, 'lag', JSON.stringify(out.finalLag), out.hyp.slice(0, 120))
process.exit(0)
