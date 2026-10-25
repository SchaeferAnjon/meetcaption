// 隐藏窗口里的采集：系统声音走 getDisplayMedia（主进程把音频换成 loopback），麦克风走 getUserMedia。
// 每一路可以单独重开（restartSource）：耳机拔掉、蓝牙断开时音轨会 ended，报给主进程，主进程带着用户手势叫这里重开。
// 麦克风跟着系统默认走的（没选设备，或者选的设备不在了先用默认）：系统默认换了（戴上 / 摘下耳机）也报一次，换到新的默认设备。
const bridge = window.captureBridge
const running = new Map() // source → { ctx, stream, label, followsDefault }
let opts = null

async function pipe(stream, source) {
  const { sampleRate } = opts
  const ctx = new AudioContext({ sampleRate })
  await ctx.audioWorklet.addModule('pcm-worklet.js')
  const node = new AudioWorkletNode(ctx, 'pcm16', { processorOptions: { chunkSamples: Math.round(sampleRate / 10) } })
  node.port.onmessage = (e) => bridge.sendPcm(source, e.data)
  const input = ctx.createMediaStreamSource(stream)
  const mute = ctx.createGain()
  mute.gain.value = 0
  input.connect(node)
  node.connect(mute)
  mute.connect(ctx.destination)
  if (ctx.state !== 'running') await ctx.resume()
  for (const track of stream.getAudioTracks())
    track.onended = () => {
      if (running.get(source)?.stream === stream) bridge.reportLost(source, 'ended')
    }
  return ctx
}

async function openMic() {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  const want = opts.micDeviceId
  let stream = null
  let fallback = false
  if (want) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: want } } })
    } catch (e) {
      // 选的麦克风拔掉了：先用系统默认，它插回来时 devicechange 再换回去
      if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e
      fallback = true
    }
  }
  stream ??= await navigator.mediaDevices.getUserMedia({ audio })
  return { stream, fallback, followsDefault: !want || fallback, label: stream.getAudioTracks()[0]?.label ?? '' }
}

async function openSystem() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  for (const t of stream.getVideoTracks()) {
    t.stop()
    stream.removeTrack(t)
  }
  if (!stream.getAudioTracks().length) throw new Error(t('没拿到系统声音（loopback 音轨为空）'))
  return { stream, fallback: false, followsDefault: false, label: '' }
}

function close(source) {
  const r = running.get(source)
  if (!r) return
  running.delete(source)
  r.stream.getTracks().forEach((t) => t.stop())
  r.ctx.close()
}

async function open(source) {
  const got = source === 'mic' ? await openMic() : await openSystem()
  try {
    const ctx = await pipe(got.stream, source)
    running.set(source, { ...got, ctx, defaultLabel: source === 'mic' ? await defaultMicLabel() : '' })
  } catch (e) {
    got.stream.getTracks().forEach((t) => t.stop())
    throw e
  }
  return { label: got.label, fallback: got.fallback }
}

const errorText = (e) => `${e.name ?? ''} ${e.message ?? e}`.trim()

// 系统默认麦克风现在是哪一个：Chromium 列出的 default 那一项的名字（「默认 - AirPods」），Windows 上还有 communications
async function defaultMicLabel() {
  const list = await navigator.mediaDevices.enumerateDevices()
  return list.find((d) => d.kind === 'audioinput' && d.deviceId === 'default')?.label ?? ''
}

navigator.mediaDevices.addEventListener('devicechange', async () => {
  const r = running.get('mic')
  if (!r) return
  const list = await navigator.mediaDevices.enumerateDevices()
  const inputs = list.filter((d) => d.kind === 'audioinput')
  // 选的设备插回来了：换回去
  if (r.fallback && inputs.some((d) => d.deviceId === opts.micDeviceId)) return bridge.reportLost('mic', 'preferred-back')
  if (!r.followsDefault) return
  const now = inputs.find((d) => d.deviceId === 'default')?.label ?? ''
  if (now && now !== r.defaultLabel) bridge.reportLost('mic', 'default-changed')
})

window.startCapture = async (o) => {
  opts = o
  const out = {}
  try {
    if (o.system) out.system = await open('system')
    if (o.mic) out.mic = await open('mic')
    return { ok: true, ...out }
  } catch (e) {
    for (const source of [...running.keys()]) close(source)
    return { ok: false, error: errorText(e) }
  }
}

/** 重开一路（patch 可以换麦克风设备）：→ { ok, label, fallback } 或 { ok: false, error }。 */
window.restartSource = async (source, patch = {}) => {
  Object.assign(opts, patch)
  close(source)
  try {
    return { ok: true, ...(await open(source)) }
  } catch (e) {
    return { ok: false, error: errorText(e) }
  }
}
