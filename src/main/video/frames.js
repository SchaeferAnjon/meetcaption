import { pathToFileURL } from 'node:url'
import { MediaError } from './demux.js'
import { t } from '../i18n.js'

// 一节课的视频：画面一变（翻页）就截一张（隐藏窗口里的 <video> 跳着取样，比较见 renderer/video/worker.js 的 frames.scan）。
// onFrame(atMs, jpeg: Uint8Array) 每截到一张就回一次；onProgress(取样到的毫秒)。画面读不出来（编码 Chromium 不认、只有声音）报 no-picture。
// 取消：关掉这个 worker（VideoWorker.close），正在做的活回 worker-closed。

export async function scanFrames({ worker, file, durationMs, onFrame, onProgress, signal, stepSec, minGapSec, max }) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  const r = await worker.call(
    'frames.scan',
    { url: pathToFileURL(file).href, durationMs, stepSec, minGapSec, max },
    {
      onEvent: (e) => {
        if (e.type === 'frame') onFrame?.(e.atMs, e.jpeg)
        else if (e.type === 'progress') onProgress?.(e.atMs)
      },
    },
  )
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  if (r.error === 'no-picture') throw new MediaError('no-picture', t('这个视频的画面读不出来，字幕和笔记照常做，只是没有截图'))
  if (r.error) throw new MediaError('frames', t(`截画面没做完：{0}`, r.error))
  return r
}
