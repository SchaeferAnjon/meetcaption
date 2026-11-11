const { contextBridge, ipcRenderer } = require('electron')

// 视频模式的隐藏窗口（解码声音、截画面）：主进程发活过来（video:job），做完用 reply 回。
contextBridge.exposeInMainWorld('videoBridge', {
  onJob: (cb) => ipcRenderer.on('video:job', (_e, job) => cb(job)),
  reply: (id, result) => ipcRenderer.send('video:reply', id, result),
})
