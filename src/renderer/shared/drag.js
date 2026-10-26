// 悬浮窗随时拖动：在 el 上按住移动超过几个像素就拖整个窗口（按钮、链接、能选中的文字不算，单击照常）。
// moveTo({ first }) 通知主进程挪窗口（first：这一次拖动的第一下；位置由主进程按鼠标走了多远算，不发坐标），end() 在松手时调；ignore：另外不拖的元素（比如能选中复制的正文）。
window.dragWindow = function dragWindow(el, { moveTo, end, enabled = () => true, ignore = '' }) {
  const SLOP = 4
  const onScrollbar = (e) => e.offsetX >= e.target.clientWidth && e.target.scrollHeight > e.target.clientHeight
  const skip = (e) => e.target.closest(`button, a, input, textarea, select, .handle${ignore ? `, ${ignore}` : ''}`) || onScrollbar(e)
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !enabled() || skip(e)) return
    const start = { mx: e.screenX, my: e.screenY }
    let dragging = false
    el.setPointerCapture(e.pointerId)
    const move = (ev) => {
      const dx = ev.screenX - start.mx
      const dy = ev.screenY - start.my
      if (!dragging && Math.abs(dx) + Math.abs(dy) < SLOP) return
      if (!dragging) document.body.classList.add('dragging')
      moveTo({ first: !dragging })
      dragging = true
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      document.body.classList.remove('dragging')
      if (dragging) end?.()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  })
}
