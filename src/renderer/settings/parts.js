/*
 * 设置窗口和首次引导共用的部件，挂在 window.parts：
 * 设置读写（本地先改，合并成一个 patch 延迟发给主进程，嵌套字段由主进程逐层合并）、
 * 表单控件绑定、ChatGPT 账号、声纹录制、快捷键录制、连接测试、字幕预览。
 * 依赖 ../shared/icons.js 和 ../shared/ui.js。外来文字一律走 textContent。
 */
;(function () {
  'use strict'

  const api = window.app
  const { el, icon, clear } = ui
  const isMac = ui.isMac

  /* ---------------- 小工具 ---------------- */

  const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  function deepMerge(a, b) {
    if (!isObj(a) || !isObj(b)) return b
    const out = { ...a }
    for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v
    return out
  }
  const getPath = (o, key) => key.split('.').reduce((x, k) => x?.[k], o)
  const patchFor = (key, v) => key.split('.').reduceRight((acc, k) => ({ [k]: acc }), v)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  function dateText(ms) {
    return fmtDate(ms, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  }

  // 主进程没接好的接口：缺方法或没注册 handler 都返回 { ok: false, missing }，界面照常显示
  const NOT_READY = t('这个功能在当前版本里还没接好')
  async function call(name, ...args) {
    if (typeof api[name] !== 'function') return { ok: false, missing: true, error: NOT_READY }
    try {
      return await api[name](...args)
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (/No handler registered/i.test(msg)) return { ok: false, missing: true, error: NOT_READY }
      return { ok: false, error: msg }
    }
  }
  function on(channel, cb) {
    try {
      return api.on(channel, cb)
    } catch {
      return () => {}
    }
  }

  // 主进程发的音量是 dBFS（-100 到 0），-60 dB 以下算没声音
  function levelPct(db) {
    if (typeof db !== 'number' || Number.isNaN(db)) return 0
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100))
  }

  function localGet(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  function localSet(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch {}
  }

  /* ---------------- 设置读写 ---------------- */

  let S = null
  let pending = {}
  let saveTimer = 0
  const bindings = [] // { key, sync(value) }
  const watchers = [] // (S) => void，控件显示隐藏、依赖状态
  const savedListeners = []

  function get(key) {
    return getPath(S, key)
  }

  function refresh() {
    if (!S) return
    for (const b of bindings) b.sync(getPath(S, b.key))
    for (const w of watchers) w(S)
  }

  /** 改一个设置：界面立刻跟着变，delay 毫秒内的修改合并成一次保存。 */
  function set(key, value, delay = 250) {
    const p = patchFor(key, value)
    pending = deepMerge(pending, p)
    S = deepMerge(S, p)
    refresh()
    clearTimeout(saveTimer)
    saveTimer = setTimeout(flush, delay)
  }

  // 主进程给回来的设置上，叠上已经发出去还没回来的、和还没发出去的修改
  const sending = []
  const overlay = (next) => [...sending, pending].reduce((acc, p) => deepMerge(acc, p), next)

  async function flush() {
    clearTimeout(saveTimer)
    if (!Object.keys(pending).length) return
    const patch = pending
    pending = {}
    sending.push(patch)
    try {
      const next = await api.updateSettings(patch)
      sending.splice(sending.indexOf(patch), 1)
      if (next) S = overlay(next)
      refresh()
      for (const f of savedListeners) f(patch)
    } catch (e) {
      sending.splice(sending.indexOf(patch), 1)
      ui.toast({ type: 'error', title: t('没能保存设置'), message: String(e?.message ?? e) })
    }
  }

  function initSettings(settings) {
    S = settings
    // 别的窗口改了设置（或者自己的保存落盘了）
    on('settings:changed', (next) => {
      S = overlay(next)
      refresh()
    })
    // 关窗口前把没发出去的修改发掉（invoke 的消息同步发出，不用等结果）
    window.addEventListener('beforeunload', () => {
      if (!Object.keys(pending).length) return
      try {
        api.updateSettings(pending)
      } catch {}
      pending = {}
    })
    refresh()
  }

  function bind(key, sync) {
    bindings.push({ key, sync })
    if (S) sync(getPath(S, key))
  }

  function watch(fn) {
    watchers.push(fn)
    if (S) fn(S)
  }

  const showWhen = (node, test) => watch((s) => (node.hidden = !test(s)))
  // 关掉时整块变灰、不能操作
  const enableWhen = (node, test) =>
    watch((s) => {
      const on = Boolean(test(s))
      node.classList.toggle('is-off', !on)
      node.inert = !on
    })

  /* ---------------- 控件 ---------------- */

  function toggleInput(key, opts = {}) {
    const input = ui.toggle({ ariaLabel: opts.label, onChange: (v) => set(key, v, 0) })
    bind(key, (v) => (input.checked = Boolean(v)))
    return input
  }

  /** 输入框。secret：密码框加眼睛按钮；trim：保存时去掉首尾空格（key、ID 粘贴时常带空格）。 */
  function textInput(key, opts = {}) {
    const input = el('input.input', {
      type: opts.secret ? 'password' : 'text',
      placeholder: opts.placeholder ?? '',
      spellcheck: false,
      autocomplete: 'off',
      class: [opts.mono ? 'mono' : '', opts.short ? 'short' : ''],
      'aria-label': opts.label,
    })
    input.addEventListener('input', () => set(key, opts.trim ? input.value.trim() : input.value, 500))
    input.addEventListener('blur', () => flush())
    bind(key, (v) => {
      if (document.activeElement !== input) input.value = v ?? ''
    })
    if (!opts.secret) return input
    const eye = el('button.btn.btn-ghost.btn-icon.btn-sm.secret-eye', { type: 'button', 'aria-label': t('显示') }, icon('eye', 14))
    eye.addEventListener('click', () => {
      const show = input.type === 'password'
      input.type = show ? 'text' : 'password'
      eye.setAttribute('aria-label', show ? t('隐藏') : t('显示'))
      clear(eye).append(icon(show ? 'eye-off' : 'eye', 14))
    })
    const wrap = el('div.secret', {}, input, eye)
    wrap.input = input
    return wrap
  }

  function textArea(key, opts = {}) {
    const ta = el('textarea.input', { rows: opts.rows ?? 3, placeholder: opts.placeholder ?? '', spellcheck: false, 'aria-label': opts.label })
    ta.addEventListener('input', () => set(key, ta.value, 500))
    ta.addEventListener('blur', () => flush())
    bind(key, (v) => {
      if (document.activeElement !== ta) ta.value = v ?? ''
    })
    return ta
  }

  function segField(key, options, opts = {}) {
    const seg = ui.segmented({ options, ariaLabel: opts.label, size: opts.size, onChange: (v) => set(key, v, 0) })
    bind(key, (v) => (seg.value = v))
    return seg
  }

  function selectField(key, options, opts = {}) {
    const sel = ui.select({ options, value: S ? get(key) : undefined, width: opts.width, ariaLabel: opts.label, onChange: (v) => set(key, v, 0) })
    bind(key, (v) => (sel.value = v))
    return sel
  }

  function slider(key, { min, max, step, format = (v) => String(v), label }) {
    const input = el('input.slider', { type: 'range', min, max, step, 'aria-label': label })
    const out = el('output.slider-value.num')
    const paint = (v) => {
      out.textContent = format(v)
      input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`)
    }
    input.addEventListener('input', () => {
      const v = Number(input.value)
      paint(v)
      set(key, v, 250)
    })
    bind(key, (v) => {
      input.value = v
      paint(Number(v))
    })
    return el('div.slider-field', {}, input, out)
  }

  function colorField(key, label) {
    const input = el('input.swatch-input', { type: 'color', 'aria-label': label })
    const chip = el('span.swatch-chip')
    const hex = el('span.swatch-hex.mono')
    input.addEventListener('input', () => {
      chip.style.background = input.value
      hex.textContent = input.value.toUpperCase()
      set(key, input.value, 250)
    })
    bind(key, (v) => {
      input.value = v || '#ffffff'
      chip.style.background = input.value
      hex.textContent = input.value.toUpperCase()
    })
    return el('label.swatch', {}, chip, hex, input)
  }

  /** 表单行：左标签、右控件（控件可以是数组），hint 放控件下面。 */
  function row(label, control, hint, opts = {}) {
    const hintNode = hint == null ? null : hint instanceof Node ? hint : el('div.form-hint', { text: hint })
    const r = el('div.form-row', { class: opts.class }, el('div.form-label', { text: label ?? '' }), el('div.form-control', {}, control, hintNode))
    return r
  }

  function section(title, desc, ...children) {
    return el('section.form-section', {}, title ? el('h3.form-section-title', { text: title }) : null, desc ? el('p.form-section-desc', { text: desc }) : null, children)
  }

  function callout(kind, iconName, title, desc, action) {
    return el(
      'div.callout',
      { class: kind ? `callout-${kind}` : '' },
      icon(iconName, 16),
      el('div.callout-body', {}, title ? el('div.callout-title', { text: title }) : null, desc ? el('div.callout-desc', { text: desc }) : null),
      action ?? null,
    )
  }

  /** 测试按钮 + 结果行。run() 返回 { ok, error, ... }；okText(r) 是成功时的文字。 */
  function testButton(label, run, okText) {
    const btn = el('button.btn', { type: 'button' }, icon('play', 14), el('span', { text: label }))
    const out = el('div.test-line', { role: 'status' })
    const show = (state, text) => {
      out.dataset.state = state
      clear(out)
      if (state === 'busy') out.append(ui.spinner(12))
      else if (state === 'ok') out.append(icon('circle-check', 14))
      else if (state === 'err') out.append(icon('circle-alert', 14))
      out.append(el('span.selectable', { text }))
    }
    btn.addEventListener('click', async () => {
      btn.classList.add('is-loading')
      btn.disabled = true
      show('busy', t('正在连接…'))
      await flush()
      const r = await run()
      btn.classList.remove('is-loading')
      btn.disabled = false
      if (r?.ok) show('ok', okText(r))
      else show('err', r?.error || t('没有连上'))
    })
    const node = el('div.test', {}, btn, out)
    node.reset = () => {
      delete out.dataset.state
      clear(out)
    }
    return node
  }

  /* ---------------- 快捷键录制 ---------------- */

  let hotkeyStatus = { accel: '', error: null, ask: { accel: '', error: null } }
  const hotkeyFields = []

  function keyName(e) {
    const c = e.code
    if (/^Key[A-Z]$/.test(c)) return c.slice(3)
    if (/^Digit\d$/.test(c)) return c.slice(5)
    if (/^F\d{1,2}$/.test(c)) return c
    const map = {
      Space: 'Space', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
      Comma: ',', Period: '.', Slash: '/', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Tab: 'Tab',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
    }
    return map[c] ?? null
  }

  function modsOf(e) {
    const mods = []
    if (isMac ? e.metaKey : e.ctrlKey) mods.push('CommandOrControl')
    if (isMac && e.ctrlKey) mods.push('Control')
    if (!isMac && e.metaKey) mods.push('Super')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    return mods
  }

  // 复制、粘贴、撤销、关窗口、退出这些，设成快捷键会把原来的功能盖掉
  const RESERVED = new Set([
    ...['C', 'V', 'X', 'A', 'Z', 'Shift+Z', 'Q', 'W', 'H', 'M', 'Return', 'Tab', 'Shift+Tab'].map((k) => `CommandOrControl+${k}`),
    ...(isMac ? ['Control+Tab', 'Control+Shift+Tab'] : ['CommandOrControl+Y', 'Alt+F4', 'Alt+Tab']),
  ])

  function accelOf(e) {
    const key = keyName(e)
    if (!key) return null
    const mods = modsOf(e)
    if (!mods.length && !/^F\d+$/.test(key)) return { error: isMac ? t('至少要带一个 ⌘、⌥、⌃ 或 ⇧（F1 到 F12 可以单独用）') : t('至少要带一个 Ctrl、Alt 或 Shift（F1 到 F12 可以单独用）') }
    const accel = [...mods, key].join('+')
    if (RESERVED.has(accel)) return { error: t(`{0} 是复制、粘贴这类系统操作，换一个`, ui.accelText(accel)) }
    return { accel }
  }

  function serverHotkeyError(key) {
    if (key === 'hotkeyToggle') return hotkeyStatus?.error || ''
    if (key === 'hotkeyRecord') return hotkeyStatus?.record?.error || ''
    if (key === 'assist.hotkeyAsk') return hotkeyStatus?.ask?.error || ''
    if (key === 'class.hotkeySlide') return hotkeyStatus?.slide?.error || ''
    return ''
  }

  function hotkeyRecorder(key, { def, label }) {
    const btn = el('button.hotkey', { type: 'button', 'aria-label': t(`{0}的快捷键，点一下录制新的`, label) })
    const reset = el('button.btn.btn-ghost.btn-sm', { type: 'button' }, icon('refresh-cw', 13), el('span', { text: t('恢复默认') }))
    const err = el('div.form-hint.is-error')
    let recording = false
    let held = []
    let localError = ''
    const f = { key, label }

    function render() {
      clear(btn)
      btn.classList.toggle('is-recording', recording)
      if (recording) {
        if (held.length) btn.append(ui.kbd(held.join('+')), el('span.hotkey-wait', { text: t('再按一个键') }))
        else btn.append(el('span.hotkey-wait', { text: t('按下新的组合键，Esc 取消，Delete 不用这个快捷键') }))
      } else {
        const v = get(key)
        btn.append(v ? ui.kbd(v) : el('span.text-3', { text: t('未设置') }))
        btn.append(el('span.hotkey-edit', {}, icon('pencil', 12)))
      }
      reset.hidden = recording || get(key) === def
      const e = localError || serverHotkeyError(key)
      err.textContent = e
      err.hidden = !e
    }
    f.render = render

    btn.addEventListener('click', () => {
      if (recording) return
      recording = true
      held = []
      localError = ''
      render()
    })
    // 离开这一项（点了别处、按了 Tab）就收起录制，连同「重复了」这类提示，不然会挂在这一行下面一直不走
    btn.addEventListener('blur', () => {
      recording = false
      held = []
      localError = ''
      render()
    })
    btn.addEventListener('keydown', (e) => {
      if (!recording) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !modsOf(e).length) {
        recording = false
        localError = ''
        render()
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !modsOf(e).length) {
        recording = false
        localError = ''
        set(key, '', 0)
        render()
        return
      }
      const r = accelOf(e)
      if (!r) {
        held = modsOf(e)
        render()
        return
      }
      if (r.error) {
        localError = r.error
        held = []
        render()
        return
      }
      const clash = hotkeyFields.find((o) => o.key !== key && get(o.key) === r.accel)
      held = []
      if (clash) {
        // 还在录制：直接按别的组合就行，Esc 取消（提示一起清掉）
        localError = t(`和「{0}」的快捷键重复了，换一个，或者按 Esc 取消`, clash.label)
        render()
        return
      }
      recording = false
      localError = ''
      set(key, r.accel, 0)
      render()
    })
    btn.addEventListener('keyup', (e) => {
      if (!recording) return
      held = modsOf(e)
      render()
    })
    reset.addEventListener('click', () => {
      localError = ''
      set(key, def, 0)
    })
    hotkeyFields.push(f)
    bind(key, render)
    return el('div.hotkey-field', {}, el('div.form-inline', {}, btn, reset), err)
  }

  on('hotkey:status', (st) => {
    hotkeyStatus = st ?? hotkeyStatus
    for (const f of hotkeyFields) f.render()
  })

  /* ---------------- ChatGPT 账号 ---------------- */

  let chatgpt = null // null 还不知道；{ unsupported } 主进程没接
  let loginBusy = false
  let loginError = ''
  let loginSeq = 0
  const chatgptViews = new Set()
  const chatgptListeners = []

  function setChatgpt(st) {
    if (!st || typeof st !== 'object') return
    if (st.ok === false) chatgpt = st.missing ? { unsupported: true } : { loggedIn: false, error: st.error }
    else chatgpt = st
    for (const v of chatgptViews) v()
    for (const f of chatgptListeners) f(chatgpt)
  }

  async function chatgptLogin() {
    const seq = ++loginSeq
    loginError = ''
    loginBusy = true
    setChatgpt({ ...(chatgpt ?? {}), loggingIn: true, loggedIn: false, error: null })
    const r = await call('chatgptLogin')
    if (seq !== loginSeq) return // 又点了一次登录，这次的结果不用管
    loginBusy = false
    if (r?.missing) return setChatgpt(r)
    if (r?.ok === false && r.code !== 'login-cancelled') loginError = r.error || t('登录没有完成')
    if (r?.status) setChatgpt(r.status)
    else setChatgpt(await call('chatgptStatus'))
    if (chatgpt?.loggedIn) ui.toast({ type: 'success', title: t('ChatGPT 已登录') })
  }

  async function chatgptLogout() {
    loginError = ''
    const r = await call('chatgptLogout')
    if (r?.ok === false && !r.missing) loginError = r.error
    setChatgpt(r && r.ok !== false && !r.error ? r : await call('chatgptStatus'))
  }

  function copyText(text, done = t('已复制')) {
    navigator.clipboard.writeText(text).then(
      () => ui.toast({ type: 'success', title: done }),
      () => ui.toast({ type: 'error', title: t('没能复制，请手动选中文字复制') }),
    )
  }

  /* ---------------- AI 服务（清单来自主进程 llm/providers.js） ---------------- */

  let providers = []
  const providerById = (id) => providers.find((p) => p.id === id)

  /** 服务商图标：彩色的用图片；单色的（OpenAI、Kimi、OpenRouter）用遮罩按文字颜色画；自定义没有图标。 */
  function providerLogo(p, size = 20) {
    const style = `width:${size}px;height:${size}px`
    if (!p.icon) return el('span.provider-logo.is-icon', { style }, icon('settings', size - 2))
    const url = `../shared/providers/${p.icon}`
    if (p.mono) return el('span.provider-logo.is-mono', { style: `${style};-webkit-mask-image:url(${url})`, 'aria-hidden': 'true' })
    return el('img.provider-logo', { src: url, alt: '', style })
  }

  /** 选 AI 服务：国内直连、海外和其他两组卡片。onPick(id)：点了哪一家。 */
  function providerPicker({ onPick, recommend = 'chatgpt' } = {}) {
    const cards = []
    const group = (title, list) =>
      el(
        'div.provider-group',
        {},
        el('div.provider-group-title', { text: title }),
        el(
          'div.provider-grid',
          { role: 'radiogroup', 'aria-label': title },
          list.map((p) => {
            const b = el(
              'button.choice.provider-choice',
              { type: 'button', role: 'radio', dataset: { id: p.id }, onClick: () => (set('llmProvider', p.id, 0), onPick?.(p.id)) },
              providerLogo(p),
              el('span.choice-main', {}, el('span.choice-title', {}, el('span', { text: t(p.name) }), p.id === recommend ? el('span.tag.tag-accent', { text: t('推荐') }) : null), el('span.choice-desc', { text: t(p.blurb) })),
            )
            cards.push(b)
            return b
          }),
        ),
      )
    const root = el('div.provider-picker', {}, group(t('国内直连'), providers.filter((p) => p.region === 'cn')), group(t('海外和其他'), providers.filter((p) => p.region !== 'cn')))
    watch((st) => cards.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === st.llmProvider))))
    return root
  }

  /**
   * 选中的那家要填什么：ChatGPT 是登录卡片，OpenAI 是和语音识别共用的 openaiKey，内置服务是各自的 Key（llmKeys），自定义是地址加 Key。
   * row(label, control, hint)：设置窗口用 row，引导用它自己的 field。
   */
  function providerSetup({ row: line = row } = {}) {
    const keyLink = (p) => el('button.link-btn', { type: 'button', onClick: () => api.openExternal(p.keyPage) }, el('span', { text: t(`去 {0} 创建 Key`, t(p.name)) }), icon('external-link', 12))
    const parts = []
    const chat = el('div.provider-setup', {}, chatgptPanel())
    showWhen(chat, (st) => st.llmProvider === 'chatgpt')
    parts.push(chat)
    for (const p of providers.filter((x) => x.keyPage)) {
      const key = p.id === 'openai' ? 'openaiKey' : `llmKeys.${p.id}`
      const hint = el('div.form-hint', {}, p.id === 'openai' ? el('span', { text: t('按用量付费。语音识别选 OpenAI 时也用这个 Key。') }) : null, keyLink(p))
      const node = el('div.provider-setup', {}, line(`${t(p.name)} Key`, textInput(key, { secret: true, trim: true, placeholder: t('粘贴 API Key'), label: `${t(p.name)} API Key` }), hint))
      showWhen(node, (st) => st.llmProvider === p.id)
      parts.push(node)
    }
    const custom = el(
      'div.provider-setup',
      {},
      line(t('接口地址'), textInput('llmBaseUrl', { trim: true, placeholder: 'https://…/v1', label: t('接口地址') }), t('任何 OpenAI 兼容接口，填到 /v1 这一级。智谱 Coding Plan：https://open.bigmodel.cn/api/coding/paas/v4')),
      line('API Key', textInput('llmKey', { secret: true, trim: true, label: 'API Key' })),
    )
    showWhen(custom, (st) => st.llmProvider === 'custom')
    parts.push(custom)
    return parts
  }

  /** 账号卡片：没登录、登录中、已登录三种样子。 */
  function chatgptPanel() {
    const box = el('div.account')
    const render = () => {
      const st = chatgpt
      const err = loginError || st?.error
      const errNode = err ? el('div.form-hint.is-error.selectable', { text: err }) : null
      if (!st) {
        box.replaceChildren(ui.spinner(14), el('span.text-2', { text: t('正在读取登录状态…') }))
        return
      }
      if (st.unsupported) {
        box.replaceChildren(el('span.account-icon', {}, icon('circle-alert', 16)), el('div.account-main', {}, el('div.account-title', { text: t('还不能用 ChatGPT 账号登录') }), el('div.account-sub', { text: t(`{0}，先用 OpenAI API Key。`, NOT_READY) })))
        return
      }
      if (st.loggedIn) {
        const plan = st.planLabel || st.plan
        box.replaceChildren(
          el('span.avatar.lg', { text: (st.email || 'C').slice(0, 1) }),
          el(
            'div.account-main',
            {},
            el('div.account-title', {}, el('span.truncate.selectable', { text: st.email || t('已登录') }), plan ? el('span.tag.tag-accent', { text: plan }) : null),
            el('div.account-sub', { text: st.source === 'codex' ? t('开发模式：只读借用本机 Codex 的登录，不会刷新。') : t('翻译、纪要和答题都走这个账号的订阅额度。') }),
            errNode,
          ),
          el('button.btn.btn-sm', { type: 'button', onClick: chatgptLogout, disabled: st.source === 'codex' }, icon('log-out', 14), el('span', { text: t('退出登录') })),
        )
        return
      }
      if (st.loggingIn || loginBusy) {
        box.replaceChildren(
          el('span.account-icon', {}, ui.spinner(16)),
          el(
            'div.account-main',
            {},
            el('div.account-title', { text: t('正在浏览器里登录…') }),
            el('div.account-sub', { text: t('在打开的网页里登录 ChatGPT 并同意授权，完成后会自动回到这里。浏览器没弹出来就复制链接自己打开。') }),
            el(
              'div.form-inline.account-actions',
              {},
              st.loginUrl ? el('button.btn.btn-sm', { type: 'button', onClick: () => copyText(st.loginUrl, t('登录链接已复制')) }, icon('copy', 13), el('span', { text: t('复制登录链接') })) : null,
              el('button.btn.btn-sm', { type: 'button', onClick: chatgptLogin }, icon('external-link', 13), el('span', { text: t('重新打开') })),
              typeof api.chatgptCancelLogin === 'function' ? el('button.btn.btn-ghost.btn-sm', { type: 'button', onClick: () => call('chatgptCancelLogin') }, t('取消')) : null,
            ),
            errNode,
          ),
        )
        return
      }
      box.replaceChildren(
        el('span.account-icon', {}, icon('user', 16)),
        el('div.account-main', {}, el('div.account-title', { text: t('还没登录') }), el('div.account-sub', { text: t('在浏览器里登录，本应用看不到你的密码。') }), errNode),
        el('button.btn.btn-primary', { type: 'button', onClick: chatgptLogin }, icon('log-in', 14), el('span', { text: t('用 ChatGPT 账号登录') })),
      )
    }
    chatgptViews.add(render)
    render()
    return box
  }

  on('chatgpt:status', (st) => {
    if (!loginBusy || st?.loggedIn || st?.loggingIn) setChatgpt(st)
  })

  /* ---------------- 声纹录制 ---------------- */

  const VP_SECONDS = 12
  let vp = null // { enrolled, seconds, createdAt } | { unsupported }
  let vpRec = null // 录制中：{ phase, startedAt, secondsLeft, level, gotEvent, eventSeconds }
  let vpTimer = 0
  let vpWatchdog = 0
  let vpError = ''
  let vpJustDone = false
  let engineState = 'idle'
  const vpViews = new Set()
  const vpListeners = []

  function renderVp() {
    for (const v of vpViews) v()
    for (const f of vpListeners) f(vp)
  }

  function setVoiceprint(st) {
    if (!st || typeof st !== 'object') return
    vp = st.ok === false ? (st.missing ? { unsupported: true } : { enrolled: false }) : st
    renderVp()
  }

  function stopVpTimers() {
    clearInterval(vpTimer)
    clearTimeout(vpWatchdog)
    vpTimer = vpWatchdog = 0
  }

  async function finishEnroll(phase, error) {
    if (!vpRec) return
    stopVpTimers()
    vpRec = null
    vpError = phase === 'error' ? error || t('没录好，请再试一次') : ''
    vpJustDone = phase !== 'error'
    setVoiceprint(await call('voiceprintStatus'))
  }

  on('voiceprint:progress', (p) => {
    if (!p || !vpRec) return
    vpRec.gotEvent = true
    if (p.phase === 'recording') {
      if (typeof p.level === 'number') vpRec.level = p.level
      if (typeof p.secondsLeft === 'number') {
        vpRec.secondsLeft = p.secondsLeft
        vpRec.eventSeconds = true
      }
    } else if (p.phase === 'processing') vpRec.phase = 'processing'
    else if (p.phase === 'done') return finishEnroll('done')
    else if (p.phase === 'error') return finishEnroll('error', p.error)
    renderVp()
  })

  async function startEnroll() {
    if (vpRec) return
    if (typeof api.voiceprintEnroll !== 'function') {
      vpError = t(`{0}。`, NOT_READY)
      return renderVp()
    }
    vpError = ''
    vpJustDone = false
    vpRec = { phase: 'recording', startedAt: Date.now(), secondsLeft: VP_SECONDS, level: null, gotEvent: false }
    // 主进程不发倒计时也能走：本地按时间算，收到事件以事件为准
    vpTimer = setInterval(() => {
      if (!vpRec || vpRec.phase !== 'recording') return
      const local = VP_SECONDS - (Date.now() - vpRec.startedAt) / 1000
      if (!vpRec.eventSeconds) vpRec.secondsLeft = Math.max(0, local)
      vpRec.elapsed = Math.min(VP_SECONDS, (Date.now() - vpRec.startedAt) / 1000)
      if (local <= 0 && !vpRec.gotEvent) vpRec.phase = 'processing'
      renderVp()
    }, 100)
    vpWatchdog = setTimeout(() => finishEnroll('error', t('录制一直没有结束，请再试一次')), (VP_SECONDS + 30) * 1000)
    renderVp()
    const r = await call('voiceprintEnroll', VP_SECONDS)
    if (!vpRec) return // 事件已经给了结果
    if (r?.ok === false || r?.error) return finishEnroll('error', r.error)
    const st = await call('voiceprintStatus')
    if (!vpRec) return
    if (st?.enrolled && (!st.createdAt || st.createdAt >= vpRec.startedAt - 1000)) return finishEnroll('done')
    if (!vpRec.gotEvent) finishEnroll('error', t('没录好，请再试一次'))
  }

  async function clearVoiceprint() {
    const r = await call('voiceprintClear')
    if (r?.ok === false) vpError = r.error
    vpJustDone = false
    setVoiceprint(r && r.ok !== false && 'enrolled' in r ? r : await call('voiceprintStatus'))
    if (!vp?.enrolled) ui.toast({ title: t('声纹已删除') })
  }

  const VP_SCRIPT = [
    { lang: 'zh-CN', text: t('我现在在录声纹。今天想简单介绍一下我最近做的项目，还有接下来几周的计划。') },
    { lang: 'en', text: 'Hi, this is a short voice sample. I usually talk about my research, the experiments I am running, and the project I am building.' },
  ]

  function vpStatusNode() {
    const st = vp
    if (!st) return el('div.vp-state', {}, ui.spinner(12), el('span.text-2', { text: t('正在读取声纹状态…') }))
    if (st.unsupported) return el('div.vp-state', {}, el('span.tag', { text: t('暂不可用') }), el('span.text-2', { text: NOT_READY }))
    if (st.enrolled) {
      const when = st.createdAt ? t(`，{0} 录制`, dateText(st.createdAt)) : ''
      return el('div.vp-state', {}, el('span.tag.tag-ok', {}, icon('check', 12), t('已录制')), el('span.text-2', { text: t(`有效语音 {0} 秒{1}`, Number(st.seconds || 0).toFixed(1), when) }))
    }
    return el('div.vp-state', {}, el('span.tag.tag-warn', { text: t('还没录') }), el('span.text-2', { text: t('没有声纹时，麦克风里的声音都算你说的。') }))
  }

  /** 声纹录制块：状态、朗读文字、倒计时和音量条、开始 / 重新录制 / 删除。 */
  function voiceprintRecorder(opts = {}) {
    const status = el('div.vp-status')
    const script = el(
      'div.vp-script',
      {},
      el('div.vp-script-head', { text: t('点「开始录制」后，用平常开会的音量把下面两段连着读出来：') }),
      VP_SCRIPT.map((p) => el('p.vp-line.selectable', { lang: p.lang, text: p.text })),
      el('div.vp-script-foot', { text: t('读完还没到时间就接着随便说几句，中英文都行。离麦克风近一点，周围安静一些。') }),
    )
    const count = el('span.vp-count-num.num')
    const label = el('span.vp-live-label')
    const meter = el('div.meter.meter-me', {}, el('i'))
    const progress = el('div.progress', {}, el('i'))
    const live = el('div.vp-live', {}, el('div.vp-count', {}, count, el('small', { text: t('秒') })), el('div.vp-live-main', {}, label, meter, progress))
    const done = el('div.vp-done')
    const err = el('div.callout.callout-error.vp-error', {}, icon('circle-alert', 16), el('div.callout-body', {}, el('div.callout-desc.selectable')))
    const start = el('button.btn', { type: 'button' })
    const del = el('button.btn.btn-ghost.btn-danger', { type: 'button' })
    const note = el('div.form-hint')
    let confirmDel = false
    let confirmTimer = 0

    start.addEventListener('click', startEnroll)
    del.addEventListener('click', () => {
      if (!confirmDel) {
        confirmDel = true
        render()
        clearTimeout(confirmTimer)
        confirmTimer = setTimeout(() => {
          confirmDel = false
          render()
        }, 3000)
        return
      }
      confirmDel = false
      clearTimeout(confirmTimer)
      clearVoiceprint()
    })

    function render() {
      const st = vp
      const busy = Boolean(vpRec)
      const meeting = engineState !== 'idle'
      // status: 'enrolled' 只在已经录过时显示状态行（引导里用）
      const showStatus = opts.status === 'enrolled' ? Boolean(st?.enrolled) && !vpJustDone && !busy : opts.status !== false
      if (showStatus) status.replaceChildren(vpStatusNode())
      status.hidden = !showStatus
      script.hidden = Boolean(st?.enrolled && !busy && !vpError)
      live.hidden = !busy
      if (busy) {
        const processing = vpRec.phase === 'processing'
        const left = Math.max(0, vpRec.secondsLeft ?? VP_SECONDS)
        count.textContent = processing ? '0' : String(Math.ceil(left))
        live.classList.toggle('is-processing', processing)
        clear(label).append(processing ? ui.spinner(12) : el('span.dot.dot-live'), el('span', { text: processing ? t('录好了，正在分析声音…') : t('正在录音，请开始读') }))
        meter.style.setProperty('--value', `${processing ? 0 : levelPct(vpRec.level)}%`)
        const elapsed = vpRec.eventSeconds ? VP_SECONDS - left : (vpRec.elapsed ?? 0)
        progress.style.setProperty('--value', `${processing ? 100 : Math.min(100, (elapsed / VP_SECONDS) * 100)}%`)
      }
      done.hidden = !(vpJustDone && st?.enrolled && !busy)
      if (!done.hidden) done.replaceChildren(icon('circle-check', 16), el('span', { text: t(`已录好，有效语音 {0} 秒。开会时会自动分清你和对方。`, Number(st.seconds || 0).toFixed(1)) }))
      err.hidden = !vpError
      err.querySelector('.callout-desc').textContent = vpError
      start.disabled = busy || Boolean(st?.unsupported) || meeting
      clear(start).append(
        icon(busy ? 'mic' : st?.enrolled && !vpError ? 'refresh-cw' : 'mic', 14),
        el('span', { text: busy ? (vpRec.phase === 'processing' ? t('正在分析…') : t('录音中…')) : vpError ? t('再录一次') : st?.enrolled ? t('重新录制') : t('开始录制') }),
      )
      start.classList.toggle('btn-primary', !st?.enrolled || Boolean(vpError))
      del.hidden = !st?.enrolled || busy || opts.allowDelete === false
      clear(del).append(icon('trash', 14), el('span', { text: confirmDel ? t('确定删除？') : t('删除声纹') }))
      note.textContent = meeting && !busy ? t('正在记录会议，停止记录后才能录声纹。') : ''
      note.hidden = !note.textContent
    }

    vpViews.add(render)
    render()
    return el('div.vp', {}, status, script, live, done, err, el('div.form-inline.vp-actions', {}, start, del), note)
  }

  on('engine:state', (st) => {
    engineState = st?.state ?? 'idle'
    renderVp()
  })

  /* ---------------- 字幕预览 ---------------- */

  // 预览用的一句：三个意群，ablation 两边都标
  const PREVIEW_SENTENCE = {
    text: 'Could you walk me through why the ablation drops on the second dataset?',
    tr: t('你能讲讲，在第二个数据集上，为什么消融结果掉得这么多吗？'),
    chunks: [
      { en: 'Could you walk me through', zh: t('你能讲讲') },
      { en: 'why the ablation drops', zh: t('为什么消融结果掉得这么多') },
      { en: 'on the second dataset', zh: t('在第二个数据集上') },
    ],
    terms: [{ term: 'ablation', zh: t('消融'), explain: t('消融实验：去掉模型的某个部分，看效果掉多少。') }],
  }
  // AI 纠错开着时，预览里的 dataset 是从「data set」纠正过来的，看得到纠正词的点线
  const PREVIEW_ORIG = 'Could you walk me through why the ablation drops on the second data set?'

  /**
   * 字幕窗的样子：跟着字号、背景深浅、颜色、译文、意群颜色、术语开关变。scale 把字号缩到预览框里。
   * opts.style：强制某种意群样式（设置里并排比较两种样子时用）。
   */
  function captionPreview(opts = {}) {
    const scale = opts.scale ?? 0.62
    const en = el('div.cap-en')
    const tr = el('div.cap-tr')
    const tip = el('div.cap-tip', {}, el('b', { text: t('ablation · 消融') }), el('span', { text: t('消融实验：去掉模型的某个部分，看效果掉多少。') }))
    const hud = el('div.cap-hud', {}, en, tr)
    const stage = el('div.cap-stage', { 'aria-hidden': 'true', class: opts.compact ? 'is-compact' : '' }, tip, hud)
    let sig = ''
    watch((s) => {
      const o = s.overlay ?? {}
      const fs = Math.max(11, Math.round((o.fontSize ?? 26) * scale))
      hud.style.setProperty('--cap-size', `${fs}px`)
      hud.style.setProperty('--cap-bg', String(o.bgOpacity ?? 0.6))
      hud.style.setProperty('--cap-text', o.textColor || '#ffffff')
      hud.style.setProperty('--cap-tr', o.translationColor || '#ffd666')
      const termsOn = s.terms?.enabled !== false
      const fixOn = s.terms?.correct !== false
      const pr = window.bilingual ? window.bilingual.prefs(opts.style ? { display: { chunkColors: true, chunkStyle: opts.style } } : s) : { colors: false, className: 'bi-mono' }
      hud.classList.remove('bi-text', 'bi-bar', 'bi-mono')
      hud.classList.add(pr.className)
      const next = JSON.stringify([pr.colors, termsOn, fixOn])
      if (next !== sig && window.bilingual) {
        sig = next
        const r = window.bilingual.render(fixOn ? { ...PREVIEW_SENTENCE, orig: PREVIEW_ORIG } : PREVIEW_SENTENCE, { colors: pr.colors, terms: termsOn })
        en.replaceChildren(r.en)
        tr.replaceChildren(r.zh)
        // 预览里让两边的术语都亮着，看得出是同一个词
        for (const t of hud.querySelectorAll('.term')) t.classList.add('is-linked')
      }
      tr.hidden = !(o.showTranslation && s.translate) && !opts.style
      tip.hidden = !termsOn || opts.tip === false
      tip.style.setProperty('--cap-size', `${fs}px`)
    })
    return stage
  }

  /* ---------------- 启动 ---------------- */

  /** 用 init() 的结果初始化共享状态。 */
  function boot(init) {
    providers = init.llmProviders ?? []
    hotkeyStatus = init.hotkey ?? hotkeyStatus
    engineState = init.snapshot?.state ?? 'idle'
    initSettings(init.settings)
    setChatgpt(init.chatgpt ?? { ok: false, missing: typeof api.chatgptStatus !== 'function' })
    if (!init.chatgpt && typeof api.chatgptStatus === 'function') call('chatgptStatus').then(setChatgpt)
    setVoiceprint(init.voiceprint ?? { ok: false, missing: typeof api.voiceprintStatus !== 'function' })
    if (!init.voiceprint && typeof api.voiceprintStatus === 'function') call('voiceprintStatus').then(setVoiceprint)
  }

  window.parts = {
    api,
    NOT_READY,
    call,
    on,
    sleep,
    levelPct,
    dateText,
    deepMerge,
    localGet,
    localSet,
    boot,
    get,
    set,
    flush,
    refresh,
    watch,
    showWhen,
    enableWhen,
    onSaved: (f) => savedListeners.push(f),
    settings: () => S,
    toggleInput,
    textInput,
    textArea,
    segField,
    selectField,
    slider,
    colorField,
    row,
    section,
    callout,
    testButton,
    hotkeyRecorder,
    chatgptPanel,
    chatgptLogin,
    providerPicker,
    providerSetup,
    providerById,
    chatgpt: () => chatgpt,
    onChatgpt: (f) => chatgptListeners.push(f),
    voiceprintRecorder,
    voiceprint: () => vp,
    onVoiceprint: (f) => vpListeners.push(f),
    vpBusy: () => Boolean(vpRec),
    engineState: () => engineState,
    captionPreview,
    copyText,
  }
})()
