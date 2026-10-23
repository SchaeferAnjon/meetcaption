'use strict'
// 首次引导第二段（design/onboarding 方向 A）：盖在主窗口上的演示，3 个功能 8 个动作。走完权限小窗后自动出一次，
// 看完（或跳过）记在 settings.onboarding.demo；之后从「设置 → 关于 → 看演示」或命令面板再打开。动画在 shared/scenes.js。

const GUIDE_FEATS = [
  { title: '悬浮双语字幕', acts: ['talk', 'color', 'term'], tryable: true, note: '这些都已默认开启；字号、行数、颜色在「设置 → 字幕与答题框」里调。' },
  { title: 'AI 答题', acts: ['ask', 'key', 'share'], note: '自动回答在面试模式默认开着；快捷键在「设置 → 快捷键」里改。' },
  { title: '课堂笔记', acts: ['notes', 'shot'], note: '开始记录时在下拉里选「课堂」；下课点「生成课堂笔记」。' },
]
const GUIDE_ALL = GUIDE_FEATS.flatMap((f, p) => f.acts.map((a, j) => ({ p, j, a })))

let guide = null

function openGuide() {
  if (guide) return
  let k = 0
  let listening = false
  let tryResult = null
  let levels = { system: 0, mic: 0 }
  const stageHost = el('div.guide-stage')
  const player = Scenes.mount(stageHost)
  const box = el('div.guide', { role: 'dialog', 'aria-modal': 'true', 'aria-label': '怎么用' })
  document.body.append(box)

  const offLevel = subscribe('audio:level', ({ source, db }) => {
    if (!listening) return
    levels[source] = Math.max(0, Math.min(100, ((db ?? -90) + 70) * 1.6))
    const bar = box.querySelector(`[data-meter="${source}"]`)
    if (bar) bar.style.width = `${levels[source]}%`
  })

  async function listen() {
    listening = true
    tryResult = null
    render()
    const r = await call('testAudio', { seconds: 3, mic: true })
    listening = false
    levels = { system: 0, mic: 0 }
    if (failed(r)) tryResult = { ok: false, text: r.error || '没听到声音' }
    else {
      const sys = r.system?.heard
      const mic = r.mic?.heard
      tryResult = sys && mic ? { ok: true, text: '电脑声音和麦克风都听到了，可以开会了' } : sys ? { ok: true, text: '听到了电脑声音；麦克风没声音，说句话再试一次' } : { ok: false, text: '没听到电脑声音：放一段视频或音乐再点一次；还是没有就去「设置 → 权限」看看' }
    }
    render()
  }

  function close() {
    player.stop()
    offLevel?.()
    document.removeEventListener('keydown', onKey, true)
    box.remove()
    guide = null
    call('updateSettings', { onboarding: { demo: true } })
  }

  function onKey(e) {
    if (e.isComposing) return
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowRight') step(1)
    else if (e.key === 'ArrowLeft') step(-1)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  function step(d) {
    if (d > 0 && k === GUIDE_ALL.length - 1) return close()
    k = Math.max(0, Math.min(GUIDE_ALL.length - 1, k + d))
    render()
  }

  function render() {
    const { p, j, a } = GUIDE_ALL[k]
    const f = GUIDE_FEATS[p]
    const A = Scenes.ACTIONS[a]
    const desc = el('p')
    // desc 是 scenes.js 里写死的演示文字（带 <b>），不是用户内容
    desc.innerHTML = A.desc
    const chips = el(
      'div.guide-chips',
      {},
      f.acts.map((x, i) =>
        el(
          'button',
          {
            type: 'button',
            'aria-pressed': String(i === j),
            class: i === j ? 'run' : '',
            style: { '--dur': `${Scenes.ACTIONS[x].dur}ms` },
            onClick: () => {
              k = GUIDE_ALL.findIndex((y) => y.a === x)
              render()
            },
          },
          Scenes.ACTIONS[x].name,
          el('span.pr'),
        ),
      ),
    )
    const tryBox = f.tryable
      ? el(
          'div.guide-try',
          {},
          el('div.guide-try-title', {}, el('b', { text: '试一试' }), ' · 放一段英文视频或音乐，点「听一下」'),
          el('div.guide-meter', {}, el('span', { text: '电脑声音' }), el('span.bar', {}, el('i', { dataset: { meter: 'system' } }))),
          el('div.guide-meter.is-me', {}, el('span', { text: '麦克风' }), el('span.bar', {}, el('i', { dataset: { meter: 'mic' } }))),
          el(
            'div.guide-try-row',
            {},
            el('button.btn.btn-sm', { type: 'button', disabled: listening, onClick: listen }, icon('play', 14), el('span', { text: listening ? '正在听…' : '听一下' })),
            tryResult ? el('span.guide-try-res', { class: tryResult.ok ? 'is-ok' : 'is-bad' }, icon(tryResult.ok ? 'circle-check' : 'circle-alert', 14), el('span', { text: tryResult.text })) : null,
          ),
        )
      : null
    box.replaceChildren(
      el('div.guide-top', { text: `怎么用 ${p + 1} / ${GUIDE_FEATS.length} · ${f.title}` }),
      el('button.guide-skip', { type: 'button', onClick: close }, '跳过'),
      el(
        'div.guide-body',
        {},
        stageHost,
        el('div.guide-copy', {}, chips, el('h2', { text: A.name }), desc, el('div.guide-step', { text: A.step }), tryBox, el('div.guide-note', { text: f.note })),
      ),
      el(
        'div.guide-foot',
        {},
        el(
          'div.guide-dots',
          {},
          GUIDE_FEATS.map((x, i) =>
            el('button', {
              type: 'button',
              title: x.title,
              'aria-current': String(i === p),
              onClick: () => {
                k = GUIDE_ALL.findIndex((y) => y.p === i)
                render()
              },
            }),
          ),
        ),
        el('span.spacer'),
        k > 0 ? el('button.btn', { type: 'button', onClick: () => step(-1) }, '上一个') : null,
        el('button.btn.btn-primary', { type: 'button', onClick: () => step(1) }, k === GUIDE_ALL.length - 1 ? '开始使用' : '下一个'),
      ),
    )
    player.play(a)
    player.fit()
  }

  document.addEventListener('keydown', onKey, true)
  guide = { close }
  render()
}

function wireGuide() {
  subscribe('guide:show', () => openGuide())
  if (state.settings?.onboarding?.done && !state.settings.onboarding.demo) openGuide()
}
