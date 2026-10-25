const { contextBridge, ipcRenderer } = require('electron')

// 界面语言的表：页面脚本加载前就要有（shared/i18n.js 用它定义 t）
contextBridge.exposeInMainWorld('I18N', ipcRenderer.sendSync('i18n:get'))

contextBridge.exposeInMainWorld('answerApi', {
  ready: () => ipcRenderer.send('answer:ready'),
  onUpdate: (cb) => ipcRenderer.on('answer:update', (_e, a) => cb(a)),
  onConfig: (cb) => ipcRenderer.on('answer:config', (_e, c) => cb(c)),
  onClear: (cb) => ipcRenderer.on('answer:clear', () => cb()),
  regenerate: (id) => ipcRenderer.send('answer:regenerate', id),
  doneEditing: () => ipcRenderer.send('answer:doneEditing'),
  setBounds: (b) => ipcRenderer.send('answer:setBounds', b),
  moveTo: (p) => ipcRenderer.send('answer:moveTo', p),
  setIgnoreMouse: (ignore) => ipcRenderer.send('answer:setIgnoreMouse', ignore),
  setHitRect: (r) => ipcRenderer.send('answer:hitRect', r),
  copy: (text) => ipcRenderer.send('answer:copy', text),
  clicked: () => ipcRenderer.send('answer:clicked'),
})
