const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('captureBridge', {
  sendPcm: (source, buffer) => ipcRenderer.send('capture:pcm', source, buffer),
  reportLost: (source, reason) => ipcRenderer.send('capture:lost', source, reason),
})
