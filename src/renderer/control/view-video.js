'use strict'
// 视频模式（首页第五张卡「视频」）：加一个视频的面板、首页上的进度卡、结果页里的播放器和字幕列表。
// 流水线在主进程（main/video/*），这里只管选文件、问价、显示进度、播放和点回那一刻。

const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mp3', 'm4a', 'mkv'] // mkv 放进来：声音读不出来时面板里说清楚
const VIDEO_FORMATS = 'mp4 · mov · webm · mp3 · m4a'
const extOf = (p) => String(p).split('.').pop().toLowerCase()
const baseName = (p) => String(p).split(/[\\/]/).pop()

function fmtSize(n) {
  if (!n) return ''
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`
}

/** 1 小时 40 分、35 分钟、不到 1 分钟（面板里和结果页上说视频多长）。 */
function fmtLen(ms) {
  const m = Math.round(ms / 60000)
  if (m < 1) return t('不到 1 分钟')
  if (m < 60) return t(`{0} 分钟`, m)
  const h = Math.floor(m / 60)
  return m % 60 ? t(`{0} 小时 {1} 分`, h, m % 60) : t(`{0} 小时`, h)
}

const fmtEta = (sec) => (sec < 60 ? t('不到 1 分钟') : t(`约 {0} 分钟`, Math.max(1, Math.round(sec / 60))))

/** 视频的第一帧当缩略图；没有画面（mp3、m4a）或读不出来返回 ''。 */
function videoPoster(file, w = 144, h = 80) {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    const done = (x) => (v.removeAttribute('src'), v.load(), resolve(x))
    const timer = setTimeout(() => done(''), 6000)
    v.addEventListener('error', () => (clearTimeout(timer), done('')), { once: true })
    v.addEventListener(
      'loadeddata',
      () => {
        if (!v.videoWidth) return (clearTimeout(timer), done(''))
        v.addEventListener(
          'seeked',
          () => {
            clearTimeout(timer)
            const c = document.createElement('canvas')
            c.width = w * 2
            c.height = h * 2
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
            done(c.toDataURL('image/jpeg', 0.8))
          },
          { once: true },
        )
        v.currentTime = Math.min(1, (v.duration || 1) / 2)
      },
      { once: true },
    )
    v.src = fileUrl(file)
  })
}

/* ---------------- 首页：第五张卡 ---------------- */

/** 拖进来或点选一个文件。不认的格式说清楚能拖哪几种。 */
function takeVideoFile(file) {
  if (!file) return
  if (!VIDEO_EXTS.includes(extOf(file))) return ui.toast({ title: t('这种格式读不了'), message: t(`能拖进来的是 {0}`, VIDEO_FORMATS.replaceAll(' · ', '、')), type: 'warning' })
  if (state.video?.running) return ui.toast({ title: t('已经在处理一个视频了'), message: t('等它做完再加下一个'), type: 'warning' })
  if (state.engine.state !== 'idle') return ui.toast({ title: t('正在记录会议'), message: t('先停止记录再处理视频'), type: 'warning' })
  openVideoSheet(file)
}

async function pickVideo() {
  const f = await call('videoPick')
  if (typeof f === 'string' && f) takeVideoFile(f)
}

function videoCard() {
  const busy = Boolean(state.video?.running)
  const card = el(
    'button.mode-card.video-card',
    { type: 'button', class: busy ? 'is-busy' : '', dataset: { mode: 'video' }, 'aria-label': t('视频：拖进视频或点这里选文件') },
    el('span.mode-card-head', {}, ui.iconBox('video', 'teal', { size: 'sm' }), el('span.mode-card-title', { text: t('视频') }), el('span.mode-card-new', { text: t('新') })),
    el('span.mode-card-desc', { text: busy ? t('正在处理一个视频，做完再加下一个') : t('拖进视频或点这里选文件，出字幕和笔记') }),
    el('span.mode-card-fmt', {}, ...VIDEO_FORMATS.split(' · ').map((f, i, a) => el('span.nw', { text: i < a.length - 1 ? `${f} · ` : f }))),
  )
  card.addEventListener('click', () => (busy ? ui.toast({ title: t('已经在处理一个视频了'), message: t('等它做完再加下一个'), type: 'warning' }) : pickVideo()))
  card.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    card.classList.add('is-drop')
  })
  card.addEventListener('dragleave', () => card.classList.remove('is-drop'))
  card.addEventListener('drop', (e) => {
    e.preventDefault()
    card.classList.remove('is-drop')
    const f = e.dataTransfer?.files?.[0]
    if (f) takeVideoFile(api.pathForFile(f))
  })
  return card
}

/** 首页上的任务卡：处理中、处理好了、出错。没有就返回 null。 */
function videoJobCard() {
  const v = state.video ?? {}
  if (v.running) {
    const p = v.progress
    const rec = p?.steps?.find((x) => x.id === 'recognize')
    const line = !p
      ? t('正在准备…')
      : rec?.state === 'active' && p.atMs
        ? t(`识别到 {0} / {1} · 还要{2}`, fmtOffset(p.atMs), fmtOffset(p.durationMs), fmtEta(p.etaSec))
        : t(`还要{0}`, fmtEta(p.etaSec))
    const bar = el('div.vm-bar', {}, el('i', { style: { width: `${Math.round((p?.fraction ?? 0) * 100)}%` } }))
    const steps = el(
      'div.vm-phases',
      {},
      ...(p?.steps ?? []).map((s) => el('span', { class: s.state === 'done' ? 'is-ok' : s.state === 'active' ? 'is-now' : '' }, s.state === 'done' ? icon('check', 13) : null, s.label)),
    )
    return el(
      'div.vm-job',
      { role: 'status', dataset: { vmJob: 'running' } },
      el(
        'div.vm-job-top',
        {},
        v.poster ? el('div.vm-thumb', {}, el('img', { src: v.poster, alt: '' })) : el('div.vm-thumb.is-icon', {}, icon('video', 20)),
        el('div.vm-grow', {}, el('div.vm-job-title.truncate', { text: t(`正在处理「{0}」`, v.name ?? '') }), el('div.vm-job-sub', { text: line })),
        el('button.btn.btn-ghost', { type: 'button', onClick: cancelVideo }, t('取消')),
      ),
      bar,
      steps,
      el('div.vm-job-sub', { text: t('可以关掉窗口，处理完会发通知。') }),
    )
  }
  if (v.done) {
    const d = v.done
    const parts = [d.translate ? t('字幕和译文') : t('字幕'), d.notes ? (d.kind === 'class' ? t('图文课堂笔记') : t('纪要和待办')) : null, d.slides ? t(`自动截了 {0} 张画面`, d.slides) : null].filter(Boolean)
    const extra = [d.partial, d.translateFailed ? t(`有 {0} 句没翻出来`, d.translateFailed) : '', d.notesError ? t(`笔记没做完：{0}`, d.notesError) : ''].filter(Boolean)
    return el(
      'div.vm-job.is-done',
      { role: 'status', dataset: { vmJob: 'done' } },
      el(
        'div.vm-job-top',
        {},
        v.poster ? el('div.vm-thumb', {}, el('img', { src: v.poster, alt: '' })) : el('div.vm-thumb.is-icon.is-ok', {}, icon('circle-check', 20)),
        el('div.vm-grow', {}, el('div.vm-job-title.truncate', { text: t(`「{0}」处理好了`, d.name) }), el('div.vm-job-sub', { text: [d.durationMs ? t(`{0}的{1}`, fmtLen(d.durationMs), parts.join(t('，'))) : parts.join(t('，')), ...extra].join(' · ') })),
        el('button.btn', { type: 'button', onClick: () => (dismissVideoJob(), go('meeting', { id: d.sessionId })) }, t('打开'), icon('arrow-right', 14)),
        el('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': t('关闭'), onClick: dismissVideoJob }, icon('x', 14)),
      ),
    )
  }
  if (v.failed) {
    const f = v.failed
    return el(
      'div.vm-job.is-failed',
      { role: 'alert', dataset: { vmJob: 'failed' } },
      el(
        'div.vm-job-top',
        {},
        el('div.vm-thumb.is-icon.is-bad', {}, icon('circle-alert', 20)),
        el('div.vm-grow', {}, el('div.vm-job-title.truncate', { text: t(`「{0}」没处理成`, f.name ?? '') }), el('div.vm-job-sub', { text: f.error })),
        el('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': t('关闭'), onClick: dismissVideoJob }, icon('x', 14)),
      ),
    )
  }
  return null
}

function dismissVideoJob() {
  state.video = { running: false }
  emit('video')
}

async function cancelVideo() {
  const ok = await ui.confirm({ title: t('取消处理这个视频？'), message: t('已经开始的部分按场次规则算，还没开始的不扣。做到一半的字幕不会留下。'), okLabel: t('取消处理'), cancelLabel: t('继续处理') })
  if (ok) await call('videoCancel')
}

/* ---------------- 加一个视频的面板 ---------------- */

async function openVideoSheet(file) {
  const proj = (await call('getProject', state.currentProjectId)) || {}
  const settings = state.settings ?? {}
  const sh = {
    file,
    kind: proj.mode === 'class' ? 'class' : 'meeting',
    language: proj.language ?? 'en',
    target: proj.target || settings.translateTarget || 'zh',
    notes: true,
    projectId: state.currentProjectId,
    recognition: 'cloud',
    quotes: {},
    poster: '',
  }
  if (sh.target === sh.language) sh.target = ''
  let closed = false
  let seq = 0
  const root = el('div.vm-sheet')
  const backdrop = el('div.vm-backdrop', { onClick: (e) => e.target === backdrop && close() }, root)
  const close = () => {
    if (closed) return
    closed = true
    backdrop.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.menu')) (e.stopPropagation(), close())
  }
  document.addEventListener('keydown', onKey, true)
  document.body.append(backdrop)

  const ask = (recognition) =>
    call('videoQuote', { file, kind: sh.kind, recognition, translate: Boolean(sh.target), notes: sh.notes, language: sh.language, target: sh.target })

  async function refresh() {
    const my = ++seq
    const [cloud, local] = await Promise.all([ask('cloud'), ask('local')])
    if (closed || my !== seq) return
    sh.quotes = { cloud, local }
    if (!sh.touchedRecognition) sh.recognition = cloud.cloudAvailable ? 'cloud' : 'local'
    render()
  }

  const L = (code) => langLabel(code)
  const pickLang = (anchor, which) => {
    const options = which === 'src' ? SOURCE_LANGS : [{ value: '', label: t('不翻译'), keywords: ['none'] }, ...TARGET_LANGS]
    ui.menu(
      anchor,
      options.map((o) => ({
        label: o.label,
        hint: o.hint,
        keywords: o.keywords,
        checked: o.value === (which === 'src' ? sh.language : sh.target),
        onSelect: () => {
          if (which === 'src') {
            sh.language = o.value
            if (sh.target === o.value) sh.target = ''
          } else sh.target = o.value
          refresh()
          render()
        },
      })),
      { searchable: true, placeholder: t('搜索语言，比如 Deutsch、德语、de'), minWidth: 280 },
    )
  }

  function choice({ on, onPick, title, icn, desc, extra, tag }) {
    return el(
      'button.vm-choice',
      { type: 'button', class: on ? 'is-on' : '', role: 'radio', 'aria-checked': String(on), onClick: onPick },
      el('span.vm-choice-t', {}, el('span.vm-radio'), icn ? icon(icn, 16) : null, el('span', { text: title }), tag ? el('span.vm-rec', { text: tag }) : null),
      el('span.vm-choice-d', { text: desc }),
      extra ?? null,
    )
  }

  // selected：没选中的那张卡不出红字（场次不够只在选中的那一张上说）
  function usageLine(q, selected, cloud) {
    if (!q || q.sessions == null) return null
    if (q.plan !== 'member') return cloud ? el('span.vm-choice-x', { text: t('用你自己的 Key，不用场次') }) : null
    if (!q.sessions) return el('span.vm-choice-x', { text: t('不用场次') })
    const bad = q.enough === false && selected
    return el('span.vm-choice-x', { class: bad ? 'is-bad' : '' }, bad ? t('这个视频要用 {0} 场', q.sessions) : t('这个视频用 {0} 场，还剩 {1} 场', q.sessions, q.balance))
  }

  function render() {
    const cur = sh.quotes[sh.recognition]
    const probe = (sh.quotes.cloud ?? sh.quotes.local)?.probe
    const member = (sh.quotes.cloud ?? {}).plan === 'member'
    const fileErr = cur?.errors?.find((x) => ['audio-unsupported', 'no-audio', 'format', 'open', 'no-index', 'decode'].includes(x.code))
    const langErr = cur?.errors?.find((x) => x.code === 'local-language')
    const balErr = cur?.errors?.find((x) => x.code === 'no-balance')
    const keyErr = cur?.errors?.find((x) => x.code === 'no-cloud-key')
    const aiErr = cur?.errors?.find((x) => x.code === 'no-ai')
    const blocked = !cur || !cur.ok || cur.errors.length > 0
    const project = projectOf(sh.projectId)
    const kindNote = t(`按项目「{0}」的默认先选好了`, project?.name ?? t('未归类'))
    const noun = sh.kind === 'class' ? t('整理成图文课堂笔记') : t('整理成会议纪要和待办')

    const fileRow = el(
      'div.vm-file',
      {},
      sh.poster ? el('div.vm-thumb.is-lg', {}, el('img', { src: sh.poster, alt: '' })) : el('div.vm-thumb.is-lg.is-icon', {}, icon(probe?.hasVideo === false ? 'audio-lines' : 'video', 22)),
      el(
        'div.vm-grow',
        {},
        el('div.vm-file-name.truncate', { text: baseName(file), title: file }),
        el('div.vm-file-meta', { text: probe ? [probe.durationMs ? fmtLen(probe.durationMs) : '', extOf(file), fmtSize(probe.size)].filter(Boolean).join(' · ') : t('正在读这个文件…') }),
      ),
      el('button.vm-link', { type: 'button', onClick: async () => {
        const f = await call('videoPick')
        if (typeof f === 'string' && f && VIDEO_EXTS.includes(extOf(f))) {
          close()
          openVideoSheet(f)
        } else if (typeof f === 'string' && f) ui.toast({ title: t('这种格式读不了'), message: t(`能拖进来的是 {0}`, VIDEO_FORMATS.replaceAll(' · ', '、')), type: 'warning' })
      } }, t('换个文件')),
    )

    const callout = (cls, title, text, actions = []) =>
      el('div.vm-callout', { class: cls, role: 'alert' }, icon(cls === 'is-warn' ? 'triangle-alert' : 'circle-alert', 16), el('div.vm-grow', {}, el('div.vm-callout-t', { text: title }), el('div.vm-callout-d', { text }), actions.length ? el('div.vm-callout-a', {}, ...actions) : null))

    const fileCallout = fileErr
      ? callout(
          'is-bad',
          fileErr.code === 'audio-unsupported' ? t('这个文件的声音读不出来') : fileErr.code === 'no-audio' ? t('这个文件里没有声音') : t('这个文件读不了'),
          fileErr.code === 'audio-unsupported'
            ? t(`它的声音是 {0} 格式，常见于 mkv。先用 HandBrake 或 IINA 转成 mp4，再拖进来。`, fileErr.codecLabel ?? '')
            : fileErr.code === 'format'
              ? t(`能拖进来的是 {0}`, VIDEO_FORMATS.replaceAll(' · ', '、'))
              : fileErr.message,
          [el('button.btn.btn-sm', { type: 'button', onClick: async () => { const f = await call('videoPick'); if (typeof f === 'string' && f) (close(), takeVideoFile(f)) } }, t('换个文件'))],
        )
      : null

    const kind = el(
      'div.vm-field',
      {},
      el('div.vm-label', {}, t('这是什么'), el('span.vm-hint', { text: kindNote })),
      el(
        'div.vm-choices',
        { role: 'radiogroup' },
        choice({ on: sh.kind === 'class', onPick: () => ((sh.kind = 'class'), refresh(), render()), title: t('一节课'), icn: 'graduation-cap', desc: t('出图文课堂笔记：画面一变（翻页）就截一张，插在老师讲到的地方，和网课一样') }),
        choice({ on: sh.kind === 'meeting', onPick: () => ((sh.kind = 'meeting'), refresh(), render()), title: t('一场会'), icn: 'users', desc: t('出纪要和待办；说话的人标成「说话人 1、2、3」，之后能改成真名') }),
      ),
    )

    const srcBtn = el('button.vm-select', { type: 'button', onClick: (e) => pickLang(e.currentTarget, 'src') }, icon('mic', 15), el('span.vm-sel-t', { text: t(`视频里说 {0}`, L(sh.language)) }), icon('chevron-down', 14))
    const tgtBtn = el('button.vm-select', { type: 'button', onClick: (e) => pickLang(e.currentTarget, 'tgt') }, el('span.vm-sel-t', { text: sh.target ? t(`翻成 {0}`, L(sh.target)) : t('不翻译') }), icon('chevron-down', 14))
    const lang = el('div.vm-field', {}, el('div.vm-label', {}, t('语言')), el('div.vm-pair', {}, srcBtn, icon('arrow-right', 15), tgtBtn))

    const projBtn = el('button.vm-select', { type: 'button', onClick: (e) => projectMenu(e.currentTarget, { current: sh.projectId, title: t('放进哪个项目'), onPick: (id) => ((sh.projectId = id), render()) }) }, projectBox(project, 'sm'), el('span.vm-sel-t', { text: project?.name ?? t('未归类') }), icon('chevron-down', 14))
    const proj2 = el('div.vm-field', {}, el('div.vm-label', {}, t('放进项目')), projBtn)

    const notes = el(
      'label.vm-check',
      {},
      el('input', { type: 'checkbox', checked: sh.notes, onChange: (e) => ((sh.notes = e.target.checked), refresh(), render()) }),
      el('span', { text: noun }),
    )

    const q = sh.quotes
    const rec = el(
      'div.vm-field',
      {},
      el('div.vm-label', {}, t('识别')),
      el(
        'div.vm-choices',
        { role: 'radiogroup' },
        choice({ on: sh.recognition === 'cloud', onPick: () => ((sh.recognition = 'cloud'), (sh.touchedRecognition = true), render()), title: member ? t('会员云识别') : t('云识别'), icn: 'cloud', tag: t('推荐'), desc: t('更准，支持更多语言'), extra: usageLine(q.cloud, sh.recognition === 'cloud', true) }),
        choice({ on: sh.recognition === 'local', onPick: () => ((sh.recognition = 'local'), (sh.touchedRecognition = true), render()), title: t('本地识别'), icn: 'laptop', desc: t('免费，不联网，只认中文和英文'), extra: usageLine(q.local, sh.recognition === 'local', false) }),
      ),
      member ? el('div.vm-fine', { text: t('按视频时长算：2 小时以内 1 场，2 到 4 小时 2 场，以此类推。本地识别只出原文字幕时不用场次。') }) : null,
    )

    const langCallout = langErr
      ? callout('is-warn', t('本地识别只认中文和英文'), (member ? t('这个视频说的是{0}，要用会员云识别。', L(sh.language)) : t('这个视频说的是{0}，要用云识别。', L(sh.language))), [
          el('button.btn.btn-sm', { type: 'button', onClick: () => ((sh.recognition = 'cloud'), (sh.touchedRecognition = true), render()) }, member ? t('换成会员云识别') : t('换成云识别')),
        ])
      : null
    const balCallout = balErr
      ? callout('is-bad', t('场次不够'), t(`这个视频 {0}，要用 {1} 场；你还剩 {2} 场。`, fmtLen(probe?.durationMs ?? 0), balErr.need, balErr.have), [
          el('button.btn.btn-sm.btn-primary', { type: 'button', onClick: () => (close(), call('showPricing')) }, t('买场次')),
          el('button.btn.btn-sm', { type: 'button', onClick: () => ((sh.recognition = 'local'), (sh.target = ''), (sh.notes = false), (sh.touchedRecognition = true), refresh(), render()) }, t('只要原文字幕（本地识别，不用场次）')),
        ])
      : null
    const keyCallout = keyErr
      ? callout('is-warn', t('云识别要先填 Soniox 的 Key'), t('自带 Key 的话，云识别用你的 Soniox 账号。填好 Key 再来，或者先用本地识别。'), [
          el('button.btn.btn-sm', { type: 'button', onClick: () => (close(), openSettings('asr')) }, t('去设置')),
          el('button.btn.btn-sm', { type: 'button', onClick: () => ((sh.recognition = 'local'), (sh.touchedRecognition = true), render()) }, t('换本地识别')),
        ])
      : null

    const aiCallout = aiErr
      ? callout('is-warn', t('AI 服务还没连上'), t(`{0}。翻译和笔记要用 AI。`, aiErr.message), [
          el('button.btn.btn-sm', { type: 'button', onClick: () => (close(), aiSettings()) }, t('去设置')),
          el('button.btn.btn-sm', { type: 'button', onClick: () => ((sh.target = ''), (sh.notes = false), refresh(), render()) }, t('只要原文字幕')),
        ])
      : null
    const est = cur?.estSec
    const foot = el(
      'div.vm-foot',
      {},
      el('div.vm-foot-note', {}, blocked ? t('先解决上面的问题才能开始。') : [el('div', { text: (est ?? 60) < (probe?.durationMs ?? 0) / 2000 ? t(`大约 {0} 分钟处理完，比视频本身快得多。`, Math.max(1, Math.round((est ?? 60) / 60))) : t(`大约 {0} 分钟处理完。`, Math.max(1, Math.round((est ?? 60) / 60))) }), el('div', { text: t('可以关掉窗口，好了会发通知。') })]),
      el('button.btn', { type: 'button', onClick: close }, t('取消')),
      el('button.btn.btn-primary', { type: 'button', disabled: blocked || sh.starting, onClick: start }, t('开始处理'), icon('arrow-right', 15)),
    )

    fill(
      root,
      el('div.vm-sheet-h', { text: t('加一个视频') }),
      el('div.vm-sheet-b', {}, fileRow, fileCallout, kind, lang, proj2, notes, rec, langCallout, balCallout, keyCallout, aiCallout),
      foot,
    )
    // 出错提示变了的话让它露出来（面板里内容多，提示在下面会被盖住）；没变就不动，免得用户改别的选项时滚来滚去
    const errKey = [fileErr?.code, langErr?.code, balErr?.code, keyErr?.code, aiErr?.code].filter(Boolean).join()
    const warn = root.querySelector('.vm-callout')
    if (warn && errKey !== sh.lastErrKey) requestAnimationFrame(() => warn.scrollIntoView({ block: 'nearest' }))
    sh.lastErrKey = errKey
  }

  async function start() {
    if (sh.starting) return
    sh.starting = true
    render()
    const poster = sh.poster
    const r = await call('videoStart', { file, kind: sh.kind, recognition: sh.recognition, translate: Boolean(sh.target), notes: sh.notes, language: sh.language, target: sh.target, projectId: sh.projectId })
    sh.starting = false
    if (failed(r) || r?.ok === false) {
      ui.toast({ title: t('没能开始处理'), message: r?.error, type: 'error' })
      return refresh()
    }
    state.video = { running: true, name: baseName(file), poster, progress: null }
    emit('video')
    close()
    if (router.current?.name !== 'home') go('home', {}, { root: true })
  }

  render()
  videoPoster(file).then((p) => {
    if (closed) return
    sh.poster = p
    render()
  })
  refresh()
}

/* ---------------- 结果页：左边视频，右边字幕 ---------------- */

const SPEAKER_TINTS = ['blue', 'green', 'pink', 'orange', 'purple', 'teal', 'yellow', 'red']
const RATES = [1, 1.25, 1.5, 2, 0.75]
const SUBS_KEY = 'meetcaption.video.subs'

/** 这场视频的字幕按视频里的毫秒排好：[{ seg, at, end }]。 */
function videoLines(s) {
  return (s.segments ?? [])
    .filter((x) => x.text)
    .map((seg) => ({ seg, at: seg.startedAt - s.startedAt, end: seg.startedAt - s.startedAt + (seg.dur ?? 3000) }))
    .sort((a, b) => a.at - b.at)
}

/** 播放到 ms 时在说的那一句的下标：最后一个开始时间不晚于 ms 的；还没到第一句是 -1。 */
function lineAt(lines, ms) {
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].at <= ms) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

function videoView(ctx, s0, opts = {}) {
  let s = s0
  let lines = videoLines(s)
  const slides = () => [...(s.slides ?? [])].filter((x) => x.file).map((x) => ({ ...x, ms: x.at - s.startedAt })).sort((a, b) => a.ms - b.ms)
  const listeners = new Set() // (ms, idx) → void
  let subsOn = store(SUBS_KEY) !== '0'
  let wide = false // 看笔记时视频缩小，画面字幕让位给下面的「正在说」

  /* 播放器 */
  const video = el('video.vm-video', { preload: 'metadata', playsinline: true })
  const hasPicture = s.video?.hasVideo !== false
  const msg = el('div.vm-frame-msg', { hidden: true })
  const ovOrig = el('span')
  const ovTr = el('span.is-tr')
  const ov = el('div.vm-ov', { hidden: true }, ovOrig, ovTr)
  const big = el('button.vm-big', { type: 'button', 'aria-label': t('播放') }, icon('play', 22))
  const frame = el('div.vm-frame', {}, hasPicture ? video : el('div.vm-audio', {}, icon('audio-lines', 34), el('span', { text: t('只有声音') }), video), ov, msg, big)
  const playBtn = el('button.vm-icb', { type: 'button', 'aria-label': t('播放') }, icon('play', 16))
  const time = el('span.vm-time.num')
  const rateBtn = el('button.vm-pill', { type: 'button', title: t('播放速度') }, '1×')
  const subsBtn = el('button.vm-pill', { type: 'button', hidden: !hasPicture, 'aria-pressed': String(subsOn) }, icon('captions', 14), t('画面字幕'))
  const knob = el('i.vm-kn')
  const played = el('i.vm-pl')
  const ticks = el('div.vm-ticks')
  const scrub = el('div.vm-scrub', { role: 'slider', tabindex: 0, 'aria-label': t('播放进度') }, el('i.vm-tr'), played, ticks, knob)
  const ctrl = el('div.vm-ctrl', {}, scrub, el('div.vm-ctrl-row', {}, playBtn, time, el('span.vm-grow'), rateBtn, subsBtn))
  const player = el('div.vm-player', {}, frame, ctrl)

  const dur = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : s.video?.durationMs ?? 0)
  const now = () => video.currentTime * 1000

  function drawTicks() {
    ticks.replaceChildren(...slides().map((x) => el('i.vm-tk', { style: { left: `${Math.min(100, (x.ms / (dur() || 1)) * 100)}%` } })))
  }

  function sync() {
    const ms = now()
    const d = dur()
    const f = d ? ms / d : 0
    played.style.width = `${f * 100}%`
    knob.style.left = `${f * 100}%`
    time.textContent = `${fmtOffset(ms)} / ${fmtOffset(d)}`
    const i = lineAt(lines, ms)
    const cur = i >= 0 && ms <= lines[i].end + 800 ? lines[i] : null
    if (subsOn && cur && !wide) {
      ovOrig.textContent = cur.seg.text
      ovTr.textContent = (cur.seg.sentences ?? []).map((y) => y.tr).filter(Boolean).join(' ')
      ov.hidden = false
    } else ov.hidden = true
    for (const fn of listeners) fn(ms, i, cur)
  }

  function setPlaying(on) {
    playBtn.replaceChildren(icon(on ? 'pause' : 'play', 16))
    playBtn.setAttribute('aria-label', on ? t('暂停') : t('播放'))
    frame.classList.toggle('is-playing', on)
  }

  const toggle = () => (video.paused ? video.play().catch(() => {}) : video.pause())
  function seek(ms, play = false) {
    video.currentTime = Math.max(0, Math.min(ms, Math.max(0, dur() - 50))) / 1000
    if (play) video.play().catch(() => {})
    sync()
  }
  const failMsg = (text) => ((msg.textContent = text), (msg.hidden = false), (big.hidden = true))
  video.addEventListener('timeupdate', sync)
  video.addEventListener('seeked', sync)
  video.addEventListener('play', () => setPlaying(true))
  video.addEventListener('pause', () => setPlaying(false))
  video.addEventListener('loadedmetadata', () => {
    drawTicks()
    sync()
    if (hasPicture && s.video?.hasVideo && !video.videoWidth) failMsg(t('这个视频的画面放不出来（编码不支持），声音和字幕照常。'))
  })
  video.addEventListener('error', () => failMsg(t('视频读不出来：文件可能被挪走或删掉了。字幕和笔记还在。')))
  video.addEventListener('ended', () => setPlaying(false))
  playBtn.addEventListener('click', toggle)
  big.addEventListener('click', toggle)
  frame.addEventListener('click', (e) => (e.target === video || e.target === frame) && toggle())
  rateBtn.addEventListener('click', () => {
    const next = RATES[(RATES.indexOf(video.playbackRate) + 1) % RATES.length]
    video.playbackRate = next
    rateBtn.textContent = `${next}×`
  })
  subsBtn.addEventListener('click', () => {
    subsOn = !subsOn
    store(SUBS_KEY, subsOn ? '1' : '0')
    subsBtn.setAttribute('aria-pressed', String(subsOn))
    sync()
  })
  const scrubTo = (e) => {
    const r = scrub.getBoundingClientRect()
    seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur())
  }
  scrub.addEventListener('pointerdown', (e) => {
    scrub.setPointerCapture(e.pointerId)
    scrubTo(e)
    scrub.onpointermove = scrubTo
  })
  scrub.addEventListener('pointerup', () => (scrub.onpointermove = null))
  scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') (e.preventDefault(), seek(now() - 5000))
    else if (e.key === 'ArrowRight') (e.preventDefault(), seek(now() + 5000))
  })
  const onKey = (e) => {
    if (e.key !== ' ' || e.isComposing || e.metaKey || e.ctrlKey) return
    const a = document.activeElement
    if (a && (a.matches?.('input, textarea, select, [contenteditable]') || (a.closest?.('.tabs, .menu, .modal') ?? null))) return
    if (a && a !== document.body && !a.closest?.('.vm-player, .vm-lines')) return
    e.preventDefault()
    toggle()
  }
  document.addEventListener('keydown', onKey)
  setPlaying(false)
  video.src = fileUrl(s.video.file)
  video.addEventListener('loadeddata', () => (video.currentTime = Math.min(video.currentTime, 0)), { once: true })

  /* 自动截的画面：一排缩略图，点一下跳过去 */
  const strip = el('div.vm-frames', { hidden: true })
  const cap = el('div.vm-cap', { hidden: true }, icon('image', 14), el('b', { text: t('自动截的画面') }), el('span.vm-hint', { text: t('画面一变就截一张，点一下跳过去') }))
  function drawFrames() {
    const list = slides()
    cap.hidden = strip.hidden = !list.length
    strip.replaceChildren(
      ...list.map((x) => {
        const b = el('button.vm-fr', { type: 'button', dataset: { ms: String(x.ms) }, title: fmtOffset(x.ms), onClick: () => seek(x.ms, true) }, el('img', { src: slideSrc(x, s.dir), alt: '', loading: 'lazy' }), el('span.vm-fr-at.num', { text: fmtOffset(x.ms) }))
        return b
      }),
    )
  }
  listeners.add((ms) => {
    let on = null
    for (const b of strip.children) if (Number(b.dataset.ms) <= ms + 400) on = b
    for (const b of strip.children) b.classList.toggle('is-on', b === on)
  })
  drawFrames()

  /* 宽模式下视频下面「正在说」 */
  const nowBox = el('div.vm-now', { hidden: true }, el('div.vm-cap', {}, icon('captions', 14), el('b', { text: t('正在说') })), el('div.vm-now-o'), el('div.vm-now-z'))
  const nowO = nowBox.querySelector('.vm-now-o')
  const nowZ = nowBox.querySelector('.vm-now-z')
  listeners.add((ms, i, cur) => {
    nowO.textContent = cur ? cur.seg.text : t('（这一段没人说话）')
    nowZ.textContent = cur ? (cur.seg.sentences ?? []).map((y) => y.tr).filter(Boolean).join(' ') : ''
    nowO.classList.toggle('is-quiet', !cur)
  })

  const left = el('div.vm-left', {}, player, cap, strip, nowBox)

  /* 右边的字幕列表：点一句跳到那一句并播放，播放时这一句高亮、列表跟着滚 */
  function renderTranscript(panel) {
    const names = s.video?.speakers
    const box = el('div.vm-lines.selectable')
    const rows = lines.map((ln, i) => {
      const sp = ln.seg.sp
      const tint = names ? SPEAKER_TINTS[(sp ?? 0) % SPEAKER_TINTS.length] : null
      const who = names
        ? el('button.vm-who', { type: 'button', dataset: { tint }, title: t('点一下改名字') }, ln.seg.speaker || names[0])
        : null
      const tr = (ln.seg.sentences ?? []).map((y) => y.tr).filter(Boolean).join(' ')
      const row = el(
        'div.vm-ln',
        { dataset: { i: String(i) }, tabindex: 0, role: 'button' },
        el('span.vm-ln-t.num', { text: fmtOffset(ln.at) }),
        el('div.vm-ln-body', {}, el('div.vm-ln-o', {}, who, ln.seg.text), tr ? el('div.vm-ln-z', { text: tr }) : null),
      )
      row.addEventListener('click', (e) => {
        if (e.target.closest('.vm-who, input')) return
        if (window.getSelection()?.toString()) return
        seek(ln.at, true)
      })
      row.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === row) (e.preventDefault(), seek(ln.at, true))
      })
      who?.addEventListener('click', () => renameSpeaker(who, sp))
      return row
    })
    box.append(...rows)
    const back = el('button.btn.btn-sm.vm-follow-btn', { type: 'button', hidden: true }, icon('corner-down-left', 13), t('回到正在说的这句'))
    const wrap = el('div.vm-lines-wrap', {}, box, el('div.vm-follow', {}, back))
    fill(
      panel,
      el(
        'div.panel-toolbar.vm-toolbar',
        {},
        el('span.text-2.text-sm', { text: [t(`{0} 句`, lines.length), s.slides?.length ? t(`{0} 张截图`, s.slides.length) : null, s.video?.translateFailed ? t(`有 {0} 句没翻出来`, s.video.translateFailed) : null].filter(Boolean).join(' · ') }),
        el('span.header-spacer'),
        el('button.btn.btn-sm', { type: 'button', onClick: () => copyText(transcriptText(s), t('字幕记录已复制')) }, icon('copy', 14), t('复制全文')),
      ),
      lines.length ? wrap : ui.emptyState({ icon: 'captions', title: t('没有字幕'), description: t('这个视频没有识别到内容。') }),
    )
    let follow = true
    let activeRow = null
    const scroller = panel
    const toActive = (smooth = true) => {
      if (!activeRow) return
      const pr = scroller.getBoundingClientRect()
      const rr = activeRow.getBoundingClientRect()
      const target = scroller.scrollTop + (rr.top - pr.top) - pr.height / 3
      scroller.scrollTo({ top: Math.max(0, target), behavior: smooth ? 'smooth' : 'instant' })
    }
    const off = () => {
      if (!follow || video.paused) return
      follow = false
      back.hidden = false
    }
    scroller.addEventListener('wheel', off, { passive: true })
    scroller.addEventListener('touchmove', off, { passive: true })
    back.addEventListener('click', () => ((follow = true), (back.hidden = true), toActive()))
    const fn = (ms, i) => {
      const row = i >= 0 ? rows[i] : null
      if (row === activeRow) return
      activeRow?.classList.remove('is-on')
      activeRow = row
      row?.classList.add('is-on')
      if (follow && row && !video.paused) toActive()
    }
    listeners.add(fn)
    video.addEventListener('seeking', () => ((follow = true), (back.hidden = true)))
    sync()
    return () => listeners.delete(fn)
  }

  function renameSpeaker(btn, sp) {
    const names = s.video.speakers
    const input = el('input.vm-who-input', { type: 'text', value: names[sp] ?? '', maxLength: 40, 'aria-label': t('说话人的名字') })
    btn.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = async (save) => {
      if (done) return
      done = true
      const name = input.value.trim()
      if (save && name && name !== names[sp]) {
        const r = await call('videoRenameSpeaker', s.id, sp, name)
        if (failed(r)) ui.toast({ title: t('没能改名'), message: r?.error, type: 'error' })
        else {
          s.video.speakers = r.speakers
          for (const seg of s.segments) if (seg.sp === sp) seg.speaker = name
          opts.onRename?.()
        }
      }
      opts.onRename?.()
    }
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return
      if (e.key === 'Enter') finish(true)
      if (e.key === 'Escape') (e.stopPropagation(), finish(false))
    })
    input.addEventListener('blur', () => finish(true))
  }

  /** 笔记里的 [mm:ss]、截图点一下回到视频那一刻 */
  function decorate(root) {
    for (const h of root.querySelectorAll('h2, h3, li, p')) {
      const node = h.firstChild
      if (!node || node.nodeType !== 3) continue
      const m = node.nodeValue.match(/^\s*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/)
      if (!m) continue
      const parts = m[1].split(':').map(Number)
      const ms = (parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]) * 1000
      node.nodeValue = node.nodeValue.slice(m[0].length)
      h.prepend(el('button.vm-tchip', { type: 'button', title: t('回到视频这一刻'), onClick: () => seek(ms, true) }, icon('play', 10), m[1]), ' ')
    }
    for (const img of root.querySelectorAll('img.prose-slide')) {
      const file = (img.getAttribute('src') || '').split('/').pop()
      const slide = slides().find((x) => x.file.endsWith(file))
      if (!slide) continue
      img.title = t(`回到视频 {0}`, fmtOffset(slide.ms))
      img.addEventListener('click', (e) => (e.stopImmediatePropagation(), seek(slide.ms, true)), true)
    }
  }

  return {
    left,
    seek,
    toggle,
    video,
    renderTranscript,
    decorate,
    setWide(on) {
      wide = on
      nowBox.hidden = !on
      subsBtn.hidden = on || !hasPicture
      sync()
    },
    update(next) {
      s = next
      lines = videoLines(s)
      drawFrames()
      drawTicks()
      sync()
    },
    destroy() {
      document.removeEventListener('keydown', onKey)
      video.pause()
      video.removeAttribute('src')
      video.load()
    },
  }
}
