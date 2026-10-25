import { dbfs } from './audio/gate.js'
import { enrollFrom, loadVoiceprintModel, pcm16ToFloat32 } from './audio/voiceprint.js'
import { t } from './i18n.js'

// 录声纹：只开麦克风录 seconds 秒（16k），每 200ms 报一次音量（这 200ms 里最大的 dBFS）和剩余秒数，
// 录完去静音、算向量、存档。capture 是 RendererCapture（或自测用的 WavCapture）。
// onProgress({ phase: 'recording'|'processing'|'done'|'error', level, secondsLeft, seconds, error })

export async function recordVoiceprint({ capture, store, seconds = 12, micDeviceId = '', onProgress = () => {} }) {
  const secs = Math.min(30, Math.max(6, Math.round(Number(seconds) || 12)))
  const rate = 16000
  const chunks = []
  let level = -100
  let failed = null
  let tick
  let token // 只停自己开的采集（RendererCapture 和开会共用）
  try {
    onProgress({ phase: 'recording', level, secondsLeft: secs })
    token = await capture.start({
      system: false,
      mic: true,
      sampleRate: rate,
      micDeviceId,
      onPcm: (source, buf) => {
        if (source !== 'mic') return
        chunks.push(Buffer.from(buf))
        level = Math.max(level, dbfs(new Int16Array(Uint8Array.from(buf).buffer)))
      },
      onError: (_s, msg) => (failed = new Error(t(`麦克风出错：{0}`, msg))),
    })
    const t0 = Date.now()
    await new Promise((resolve) => {
      tick = setInterval(() => {
        const left = secs - (Date.now() - t0) / 1000
        onProgress({ phase: 'recording', level: Math.round(level * 10) / 10, secondsLeft: Math.max(0, Math.ceil(left)) })
        level = -100
        if (left <= 0 || failed) resolve()
      }, 200)
    })
    clearInterval(tick)
    capture.stop(token)
    if (failed) throw failed
    onProgress({ phase: 'processing' })
    const model = await loadVoiceprintModel()
    const profile = enrollFrom(pcm16ToFloat32(Buffer.concat(chunks)), model)
    store.save(profile)
    onProgress({ phase: 'done', seconds: profile.seconds })
    return { ok: true, profile }
  } catch (e) {
    clearInterval(tick)
    capture.stop(token)
    onProgress({ phase: 'error', error: e.message })
    return { ok: false, error: e.message, code: e.code }
  }
}
