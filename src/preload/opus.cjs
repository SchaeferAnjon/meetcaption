const { contextBridge, ipcRenderer } = require('electron')

// 录音编码的隐藏窗口（renderer/opus）：收主进程混好的 PCM，编好的 Opus 包交回主进程
contextBridge.exposeInMainWorld('opusBridge', {
  packet: (ts, dur, data) => ipcRenderer.send('opus:packet', ts, dur, data),
  onPcm: (fn) => ipcRenderer.on('opus:pcm', (_e, data) => fn(data)),
})
