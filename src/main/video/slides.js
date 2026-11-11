import fs from 'node:fs'
import path from 'node:path'

// 视频里截的画面存进这节课的 slides/，文件名是它在视频里的位置：00.18.20.jpg（时.分.秒），和网课截图一样的写法；
// 记进 session.slides：{ file: 'slides/00.18.20.jpg', at: 开始时间 + 视频里的毫秒 }，界面用 at - startedAt 得到视频位置。
const pad = (n) => String(n).padStart(2, '0')

export function videoSlideName(ms) {
  const s = Math.floor(ms / 1000)
  return `${pad(Math.floor(s / 3600))}.${pad(Math.floor((s % 3600) / 60))}.${pad(s % 60)}`
}

export function saveVideoSlide(sessionDir, jpeg, ms) {
  const dir = path.join(sessionDir, 'slides')
  fs.mkdirSync(dir, { recursive: true })
  const name = `${videoSlideName(ms)}.jpg`
  fs.writeFileSync(path.join(dir, name), jpeg)
  return `slides/${name}`
}
