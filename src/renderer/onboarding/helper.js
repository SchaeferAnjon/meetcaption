'use strict'
// 系统设置旁边的拖图标面板（main/dragHelper.js）：兔子图标往左拖进系统设置的列表。
// kind：sys（仅系统录音）| scr（录屏与系统录音）| mic（麦克风只能开开关，没有图标可拖）；app：系统设置列表里显示的应用名。
const api = window.app
const { el, icon } = ui
const q = new URLSearchParams(location.search)
const kind = q.get('kind')
const appName = q.get('app') || 'MeetCaption'
// 系统设置里的原文（按系统语言），读不到用自己的译文
const N = { screen: q.get('screen') || t('录屏与系统录音'), audio: q.get('audio') || t('仅系统录音'), quit: q.get('quit') || t('退出并重新打开'), later: q.get('later') || t('以后') }
let dragged = false

function render() {
  let t1
  let t2
  if (kind === 'mic') {
    t1 = t('在左边列表里打开开关')
    t2 = t('麦克风不能拖，打开「{0}」的开关就行。', appName)
  } else if (dragged) {
    t1 = t('松开在列表里就加上了')
    t2 = kind === 'sys' ? t('系统接着会问要不要重开：录屏也要的话先点「{0}」，拖完录屏再一起重开。', N.later) : t('系统接着会问要不要重开：点「{0}」，引导会回到这一步。', N.quit)
  } else {
    t1 = t('把 {0} 拖进「{1}」', appName, kind === 'sys' ? N.audio : N.screen)
    t2 = kind === 'sys' ? t('拖进去开关就打开了，macOS 可能接着请你重开一次。') : t('拖进去开关就打开了，再按系统提示重开一次。')
  }
  const img = el('img', { src: '../../assets/icon.png', alt: 'MeetCaption', draggable: kind === 'mic' ? 'false' : 'true' })
  const box = el('div.hp-icon', { class: kind === 'mic' ? 'is-plain' : '', title: kind === 'mic' ? '' : t('按住图标，往左拖进系统设置的列表') }, img)
  if (kind !== 'mic')
    img.addEventListener('dragstart', (e) => {
      e.preventDefault()
      api.dragApp()
      dragged = true
      render()
    })
  document.getElementById('hp').className = `hp${dragged ? ' is-done' : ''}`
  document.getElementById('hp').replaceChildren(
    box,
    el('div.hp-text', {}, el('div.hp-t1', {}, dragged ? icon('check', 14) : el('span.nudge', {}, icon('arrow-left', 14)), el('span', { text: t1 })), el('div.hp-t2', { text: t2 })),
    el('button.hp-x', { type: 'button', 'aria-label': t('关掉'), onClick: () => api.showDragHelper() }, icon('x', 13)),
  )
}

render()
