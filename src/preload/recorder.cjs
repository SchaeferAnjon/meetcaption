const { contextBridge, ipcRenderer } = require('electron')

// 录屏的隐藏窗口（renderer/recorder）：录好的数据块交给主进程写盘；主进程送来字幕用的那两路声音（PCM），混进视频里
contextBridge.exposeInMainWorld('recorderBridge', {
  chunk: (buffer) => ipcRenderer.send('recorder:chunk', buffer),
  report: (what, info) => ipcRenderer.send('recorder:event', what, info),
  onPcm: (fn) => ipcRenderer.on('recorder:pcm', (_e, source, data, rate) => fn(source, data, rate)),
})
