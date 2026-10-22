const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('overlayApi', {
  ready: () => ipcRenderer.send('overlay:ready'),
  onConfig: (cb) => ipcRenderer.on('overlay:config', (_e, c) => cb(c)),
  onSegment: (cb) => ipcRenderer.on('overlay:segment', (_e, s) => cb(s)),
  onSegments: (cb) => ipcRenderer.on('overlay:segments', (_e, list) => cb(list)),
  setHorizontal: (b) => ipcRenderer.send('overlay:setHorizontal', b),
  // 随时拖动：字幕框在窗口里的位置（主进程据此决定鼠标在框上时接管点击）、拖动时窗口的新位置、松手
  setHitRect: (r) => ipcRenderer.send('overlay:hitRect', r),
  moveTo: (p) => ipcRenderer.send('overlay:moveTo', p),
  released: () => ipcRenderer.send('overlay:released'),
  doneEditing: () => ipcRenderer.send('overlay:doneEditing'),
  // 主进程轮询的鼠标位置（窗口内坐标，出了窗口是 null）
  onPointer: (cb) => ipcRenderer.on('overlay:pointer', (_e, p) => cb(p)),
})
