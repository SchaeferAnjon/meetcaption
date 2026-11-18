'use strict'
// 录屏的隐藏窗口：getDisplayMedia 拿鼠标所在那块屏幕的画面（主进程选好屏幕，见 main/rendererCapture.js 的 routeDisplayMedia），
// 声音是主进程送来的字幕用的那两路 PCM（电脑声音和麦克风），WebAudio 混成一路；MediaRecorder 录成 mp4（H.264 + AAC，Mac 上走硬件编码），
// 每一块数据一出来就交给主进程接着写进文件，不在内存里攒（mp4 是分片的，一个关键帧一片，大约 5 秒；应用崩了也留下已经写好的那些片）。
const bridge = window.recorderBridge

// 先要 mp4，Chromium 不给再退到 webm
const TYPES = [
  ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'],
  ['video/mp4;codecs=avc1,mp4a.40.2', 'mp4'],
  ['video/mp4', 'mp4'],
  ['video/webm;codecs=vp9,opus', 'webm'],
  ['video/webm;codecs=vp8,opus', 'webm'],
  ['video/webm', 'webm'],
]

let rec = null
let stream = null
let ctx = null
let mix = null
let writing = Promise.resolve() // 数据块按顺序交出去
let sent = 0 // 交出去几块了：主进程收齐了再关文件
const lanes = new Map() // 声音来源 → { next: 下一块排在 AudioContext 的哪个时刻 }

window.pickType = () => {
  const x = TYPES.find(([m]) => MediaRecorder.isTypeSupported(m))
  return x ? { mime: x[0], ext: x[1] } : null
}

function cleanup() {
  for (const tr of stream?.getTracks() ?? []) tr.stop()
  stream = null
  ctx?.close().catch(() => {})
  ctx = null
  mix = null
  rec = null
  lanes.clear()
}

window.startRecording = async ({ mime, width, height, fps, videoBps, audioBps }) => {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: width }, height: { max: height }, frameRate: { ideal: fps, max: fps } }, audio: false })
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('no video track')
    ctx = new AudioContext({ sampleRate: 48000 })
    if (ctx.state !== 'running') await ctx.resume()
    const dest = ctx.createMediaStreamDestination()
    // 两路加在一起偶尔会顶到头：压一下，别爆音
    mix = ctx.createDynamicsCompressor()
    mix.threshold.value = -6
    mix.knee.value = 6
    mix.ratio.value = 12
    mix.connect(dest)
    rec = new MediaRecorder(new MediaStream([track, ...dest.stream.getAudioTracks()]), { mimeType: mime, videoBitsPerSecond: videoBps, audioBitsPerSecond: audioBps })
    rec.ondataavailable = (e) => {
      if (!e.data.size) return
      writing = writing.then(async () => {
        bridge.chunk(await e.data.arrayBuffer())
        sent++
      })
    }
    const started = new Promise((resolve, reject) => {
      rec.onstart = () => resolve(Date.now())
      rec.onerror = (e) => reject(e.error ?? new Error('MediaRecorder error'))
    })
    rec.start(1000)
    const startAt = await started
    rec.onerror = (e) => bridge.report('error', { message: String(e.error?.message ?? e.error ?? 'MediaRecorder error') })
    // 屏幕没了（拔掉显示器、录屏权限被收回）：主进程收尾这一段
    track.onended = () => bridge.report('ended', {})
    const s = track.getSettings()
    return { ok: true, startAt, width: s.width ?? width, height: s.height ?? height, mime: rec.mimeType }
  } catch (e) {
    cleanup()
    return { ok: false, name: e?.name ?? '', error: `${e?.name ?? ''} ${e?.message ?? e}`.trim() }
  }
}

/** 停下来，等最后一块数据交出去。→ { ok, endAt, sent } */
window.stopRecording = async () => {
  const endAt = Date.now()
  if (rec && rec.state !== 'inactive') {
    const done = new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }))
    rec.stop()
    await done
  }
  await writing
  cleanup()
  return { ok: true, endAt, sent }
}

// 主进程送来的一块声音（16 位单声道，字幕识别用的采样率）：每一路排在自己的时间线上接着放，放进混音（不出声，只进视频）
bridge.onPcm((source, data, rate) => {
  if (!ctx || !mix || !rec) return
  const pcm = new Int16Array(data.slice().buffer)
  if (!pcm.length || !rate) return
  const buf = ctx.createBuffer(1, pcm.length, rate)
  const ch = buf.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768
  let lane = lanes.get(source)
  if (!lane) lanes.set(source, (lane = { next: 0 }))
  const now = ctx.currentTime
  // 声音来得断断续续：留 150 毫秒余量；落后了（卡过）或者排得太远，从现在重新排
  if (lane.next < now + 0.03 || lane.next > now + 1.5) lane.next = now + 0.15
  const node = ctx.createBufferSource()
  node.buffer = buf
  node.connect(mix)
  node.start(lane.next)
  lane.next += buf.duration
})
