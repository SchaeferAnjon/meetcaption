'use strict'
// 首次引导走完后的主窗口导览（design/onboarding-v2 方向 A 的 A9）：在首页上一次照亮一处，旁边一张提示卡，四处：
// 开始会议按钮、屏幕下方的悬浮字幕、右上角的答题卡、开始按钮旁的语言按钮。字幕和答题卡是盖在主窗口上的示例。
// 看完（或跳过）记在 settings.onboarding.demo；之后从「设置 → 通用 → 首次引导」或命令面板再打开。

let guide = null

function tourSteps() {
  const s = state.settings ?? {}
  const keyLine = (before, accel, after) => [before, accel ? el('span.nw', {}, kbd(accel, { size: 'sm' }), after) : after]
  return [
    {
      target: () => document.querySelector('.home-start-row .btn-group'),
      side: 'below',
      title: t('第一场会从这里开始'),
      text: keyLine(t('点这个按钮开始记录，再点一次停止；在任何应用里按 '), s.hotkeyRecord, t(' 也一样。会议先放在「未归类」，以后可以按项目分开。')),
    },
    {
      target: () => guide?.cap,
      side: 'above',
      title: t('字幕浮在所有窗口最上层'),
      text: keyLine(t('对方一说话这里就出字幕，下面是译文。拖动它换位置，按 '), s.hotkeyToggle, t(' 显示或隐藏。')),
    },
    {
      target: () => guide?.ans,
      side: 'left',
      title: t('对方一提问，答案浮在右上角'),
      text: keyLine(t('听到问题 AI 自动答，想自己问就按 '), s.assist?.hotkeyAsk, t('。共享屏幕时，对方看不到字幕和这张卡。')),
    },
    {
      target: () => document.querySelector('.home-lang'),
      side: 'below',
      title: t('语言在这里改'),
      text: [t('对方说什么、翻成什么：点这个按钮，或者进项目的「资料」页，每个项目可以不同。界面语言在 设置 → 通用。')],
    },
  ]
}

// 示例字幕和答题卡：用当前项目的语言（第 3 步选的），没有例句的语言用英语原话、界面语言译文
function tourSamples(langs) {
  const { SENT, QQ, AA } = window.SAMPLES
  const ui = window.UI_LANG || 'zh'
  const src = SENT[langs.src] ? langs.src : 'en'
  const tgt = SENT[langs.tgt] ? langs.tgt : SENT[ui] ? ui : 'zh'
  const qsrc = QQ[src] ? src : 'en'
  const qtgt = QQ[tgt] ? tgt : QQ[ui] ? ui : 'zh'
  return { src, tgt, line: SENT[src][1], tr: src === tgt ? '' : SENT[tgt][1], q: QQ[qsrc], qt: qsrc === qtgt ? '' : QQ[qtgt], a: AA[qsrc], at: qsrc === qtgt ? '' : AA[qtgt], qsrc, qtgt }
}

async function openGuide() {
  if (guide || state.engine.state !== 'idle') return
  if (router.current?.name !== 'home') go('home', {}, { root: true })
  const p = await call('getProject', state.currentProjectId)
  const langs = { src: p?.language ?? state.settings?.language ?? 'en', tgt: p?.target || state.settings?.translateTarget || 'zh' }
  const ex = tourSamples(langs)
  let k = 0
  const steps = tourSteps()
  const cap = el(
    'div.tour-hud.tour-cap',
    { 'aria-hidden': 'true' },
    el('div.tour-grip'),
    el('div.tour-cap-src', { lang: ex.src, text: ex.line }),
    ex.tr ? el('div.tour-cap-tr', { lang: ex.tgt, text: ex.tr }) : null,
  )
  const ans = el(
    'div.tour-hud.tour-ans',
    { 'aria-hidden': 'true' },
    el('div.tour-ans-k', {}, icon('sparkles', 13), el('span', { text: t('AI 答 · 对方刚问') })),
    el('div.tour-ans-q', { lang: ex.qsrc, text: ex.q }),
    ex.qt ? el('div.tour-ans-at', { lang: ex.qtgt, text: ex.qt }) : null,
    el('div.tour-ans-a', { lang: ex.qsrc, text: ex.a }),
    ex.at ? el('div.tour-ans-at', { lang: ex.qtgt, text: ex.at }) : null,
    el('div.tour-ans-share', {}, icon('eye-off', 13), el('span', { text: t('共享屏幕时对方看不到') })),
  )
  const spot = el('div.tour-spot')
  const coach = el('div.tour-coach', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('主窗口导览') })
  const layer = el('div.tour', {}, cap, ans, spot, coach)
  document.body.append(layer)

  function close() {
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', place)
    layer.remove()
    guide = null
    call('updateSettings', { onboarding: { demo: true } })
    ui.toast({ title: t('以后在 设置 → 通用 → 首次引导 里能再看一遍导览') })
  }

  function onKey(e) {
    if (e.isComposing) return
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowRight' || e.key === 'Enter') step(1)
    else if (e.key === 'ArrowLeft') step(-1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  function step(d) {
    if (d > 0 && k === steps.length - 1) return close()
    k = Math.max(0, Math.min(steps.length - 1, k + d))
    render()
  }

  // 照亮目标，提示卡放在它下面、上面或左边，不出窗口
  function place() {
    const target = steps[k].target()
    if (!target) return
    const r = target.getBoundingClientRect()
    const pad = 6
    const box = { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }
    Object.assign(spot.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` })
    const cw = coach.offsetWidth
    const ch = coach.offsetHeight
    const side = steps[k].side
    let x = side === 'left' ? box.x - cw - 14 : side === 'above' ? box.x + box.w / 2 - cw / 2 : box.x
    let y = side === 'below' ? box.y + box.h + 12 : side === 'above' ? box.y - ch - 12 : box.y
    x = Math.max(12, Math.min(innerWidth - cw - 12, x))
    y = Math.max(12, Math.min(innerHeight - ch - 12, y))
    Object.assign(coach.style, { left: `${x}px`, top: `${y}px` })
  }

  function render() {
    const st = steps[k]
    cap.hidden = k !== 1
    ans.hidden = k !== 2
    ui.clear(coach)
    coach.append(
      el('div.tour-n', {}, el('span', { text: `${k + 1} / ${steps.length}` }), el('button.tour-skip', { type: 'button', onClick: close }, t('跳过'))),
      el('div.tour-t', { text: st.title }),
      el('div.tour-x', {}, ...st.text),
      el(
        'div.tour-b',
        {},
        el('span.tour-dots', {}, steps.map((_, i) => el('i', { class: i === k ? 'is-on' : '' }))),
        k > 0 ? el('button.btn.btn-ghost', { type: 'button', onClick: () => step(-1) }, t('上一个')) : null,
        el('button.btn.btn-primary', { type: 'button', onClick: () => step(1) }, k === steps.length - 1 ? t('开始使用') : t('下一个')),
      ),
    )
    place()
    coach.querySelector('.btn-primary')?.focus({ preventScroll: true })
  }

  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', place)
  guide = { close, cap, ans }
  // 首页刚画出来：等一帧再量开始按钮的位置
  requestAnimationFrame(() => (guide ? render() : null))
}

function wireGuide() {
  subscribe('guide:show', () => openGuide())
  if (state.settings?.onboarding?.done && !state.settings.onboarding.demo) setTimeout(openGuide, 300)
}
