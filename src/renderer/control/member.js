'use strict'
// 会员：侧栏底部的场次卡片和收费页（照 design/pricing 的方向 A：三栏 + 授权码 + 常见问题，盖在主窗口上，Esc 关）。
// 主进程的会员模块在 src/main/member/client.js；这里只显示和调 memberBuy / memberActivate。

state.member = null // { info: { kind, code, balance, devices, trialOnly, recent }, session, buying, error }
state.memberPacks = []

const CURRENCY_KEY = 'meetcaption.pricing.currency'
const PACK_KEY = 'meetcaption.pricing.pack'
const isMember = () => state.settings?.plan === 'member'

// 一场最长几小时：服务器按授权给（只试用的 1 小时，买过的 2 小时）
const sessionHours = (info) => (info?.sessionMs ?? 2 * 3600_000) / 3600_000

function memberBalance() {
  return state.member?.info?.balance ?? null
}

function fmtMoney(pack, currency) {
  return currency === 'usd' ? `$${pack.usd}` : `¥${pack.cny}`
}

function perSession(pack, currency) {
  const v = (currency === 'usd' ? pack.usd : pack.cny) / pack.sessions
  return currency === 'usd' ? `$${v.toFixed(2)}` : `¥${v.toFixed(1)}`
}

/* ---------------- 侧栏卡片 ---------------- */

/** 会员模式下侧栏底部的一张卡：剩几场，点开收费页。自带 Key 时不显示。 */
function memberCard() {
  if (!isMember()) return null
  const info = state.member?.info
  const n = memberBalance()
  const live = state.member?.session
  let title = t('会员')
  let text = t('正在连接会员服务器…')
  let warn = false
  if (state.member?.error && !info) {
    title = t('会员')
    text = state.member.error
    warn = true
  } else if (info) {
    const trial = info.kind !== 'paid'
    title = trial ? t('免费试用') : t('会员')
    if (n > 0) text = t(`还剩 {0} 场，每场最长 {1} 小时{2}`, n, sessionHours(info), live ? t('。这一场正在计时') : '')
    else if (live && !live.exhausted) text = t(`最后一场正在计时，最长 {0} 小时`, sessionHours(info))
    else {
      text = trial ? t('试用用完了。字幕照常（本地识别），AI 要买场次或换自带 Key。') : t('场次用完了。字幕照常（本地识别），AI 要再买场次。')
      warn = true
    }
  }
  const count = n == null ? null : el('span.member-card-count', { class: warn ? 'is-warn' : '' }, el('b', { text: String(Math.max(0, n)) }), ' ', t('场', Math.max(0, n)))
  return el(
    'button.member-card',
    { type: 'button', class: warn ? 'is-warn' : '', onClick: () => openPricing() },
    el('div.member-card-head', {}, icon('sparkles', 14), el('span.member-card-title', { text: title }), count),
    el('div.member-card-text', { text }),
    el('div.member-card-link', {}, el('span', { text: state.member?.buying ? t('正在等付款…') : warn ? t('买场次') : t('查看方案') }), icon('chevron-right', 12)),
  )
}

/* ---------------- 收费页 ---------------- */

let pricing = null // 打开时 { close, render }

/** pack：先选中哪一包（场次用完时主进程给 p1），不给就用上次选的。 */
function openPricing({ pack } = {}) {
  if (pricing) return pricing.render()
  const box = el('div.pricing', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('方案和价格') })
  const backdrop = el('div.pricing-backdrop', {}, box)
  const prevFocus = document.activeElement
  let currency = localStorage.getItem(CURRENCY_KEY) === 'usd' ? 'usd' : 'cny'
  let packId = pack || localStorage.getItem(PACK_KEY) || 'p10'
  let codeInput = null
  let codeMsg = ''
  let codeBusy = false
  let buyError = ''

  const close = () => {
    document.removeEventListener('keydown', onKey, true)
    unsub()
    backdrop.classList.remove('is-open')
    setTimeout(() => backdrop.remove(), 180)
    pricing = null
    prevFocus?.focus?.({ preventScroll: true })
  }
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })

  async function buy() {
    buyError = ''
    localStorage.setItem(PACK_KEY, packId)
    const r = await call('memberBuy', packId, currency)
    if (failed(r)) buyError = r.error || t('没能打开付款页')
    render()
  }

  async function activate() {
    const code = codeInput?.value.trim()
    if (!code) return codeInput?.focus()
    codeBusy = true
    codeMsg = ''
    render()
    const r = await call('memberActivate', code)
    codeBusy = false
    codeMsg = failed(r) ? r.error || t('没能激活') : ''
    if (!failed(r)) {
      ui.toast({ title: t('授权码已激活'), message: t(`这台电脑现在用这个授权码，剩 {0} 场`, r.info?.balance ?? 0), type: 'success' })
      if (!isMember()) await call('updateSettings', { plan: 'member' })
    }
    render()
  }

  function column({ name, tags = [], price, unit, sub, action, items, featured, extra }) {
    return el(
      'div.pricing-col',
      { class: featured ? 'is-featured' : '' },
      el('div.pricing-col-head', {}, el('span.pricing-col-name', { text: name }), tags.map((t) => el('span.pricing-tag', { class: t.strong ? 'is-strong' : '', text: t.text })), extra ?? null),
      el('div.pricing-price', {}, el('span.pricing-amount', { text: price }), unit ? el('span.pricing-unit', { text: unit }) : null),
      el('p.pricing-sub', { text: sub }),
      action,
      el(
        'ul.pricing-list',
        {},
        items.map((t) => el('li', {}, icon('check', 14), Array.isArray(t) ? el('span', {}, t[0], el('b', { text: t[1] })) : el('span', { text: t }))),
      ),
    )
  }

  function render() {
    const m = state.member ?? {}
    const info = m.info
    const trialLeft = info && info.kind !== 'paid' ? Math.max(0, info.balance) : null
    const packs = state.memberPacks
    const pack = packs.find((p) => p.id === packId) ?? packs[1] ?? packs[0]
    if (pack) packId = pack.id

    // 免费试用
    const trialBtn = el('button.btn.pricing-btn', { type: 'button', disabled: true }, el('span', {
      text: !info ? t('打开会员后自动领取') : info.kind === 'paid' ? t('已是会员') : trialLeft > 0 ? t(`试用中 · 剩 {0} 场`, trialLeft) : t('试用已用完'),
    }))
    if (info && !isMember()) {
      trialBtn.disabled = false
      trialBtn.querySelector('span').textContent = t('换成会员用法')
      trialBtn.addEventListener('click', () => call('updateSettings', { plan: 'member' }))
    }
    const trial = column({
      name: t('免费试用'),
      tags: [{ text: t('新用户') }],
      price: t('1 场'),
      unit: t('· 最长 1 小时'),
      sub: t('装好就能用，不用填任何 Key'),
      action: trialBtn,
      items: [t('云识别和 AI 全都能用'), [t('不用注册，'), t('不用登录')], t('一场不到 5 分钟停止的不算'), t('用完以后字幕照常（本地识别）')],
    })

    // 会员：按场买
    const curSeg = el(
      'div.seg.pricing-currency',
      { role: 'radiogroup', 'aria-label': t('币种') },
      [
        ['cny', t('人民币')],
        ['usd', t('美元')],
      ].map(([v, label]) =>
        el('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(currency === v),
          text: label,
          onClick: () => {
            currency = v
            localStorage.setItem(CURRENCY_KEY, v)
            render()
          },
        }),
      ),
    )
    const packList = el(
      'div.pricing-packs',
      { role: 'radiogroup', 'aria-label': t('场次') },
      packs.map((p) =>
        el(
          'button.pricing-pack',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(p.id === packId),
            onClick: () => {
              packId = p.id
              render()
            },
          },
          el('span.pricing-pack-n', { text: t(`{0} 场`, p.sessions) }),
          el('span.pricing-pack-price', { text: fmtMoney(p, currency) }),
          el('span.pricing-pack-per', { text: p.sessions > 1 ? t(`每场 {0}`, perSession(p, currency)) : t('先试一场') }),
        ),
      ),
    )
    const buying = m.buying
    const buyBtn = buying
      ? el('div.pricing-wait', {}, ui.spinner(14), el('span', { text: t('在浏览器里付款，付完这里自动加上') }), el('button.pricing-link', { type: 'button', onClick: () => call('memberCancelBuy') }, t('不等了')))
      : el('button.btn.btn-primary.pricing-btn', { type: 'button', onClick: (e) => withBusy(e.currentTarget, buy) }, el('span', { text: pack ? t(`购买 {0} 场 · {1}`, pack.sessions, fmtMoney(pack, currency)) : t('购买') }), icon('arrow-right', 14))
    const memberCol = column({
      name: t('会员'),
      tags: [{ text: t('推荐'), strong: true }, { text: t('免配置') }],
      extra: curSeg,
      price: pack ? fmtMoney(pack, currency) : '',
      unit: pack ? t(`· {0} 场，不过期`, pack.sessions) : '',
      sub: t('不用申请任何 Key，买了就能用'),
      action: el('div.pricing-buy', {}, packList, buyBtn, buyError ? el('div.pricing-error', { text: buyError }) : null),
      items: [
        [t('云识别：Soniox，'), t('60 种语言，中英文和外语都准')],
        t('AI 全包：翻译、术语、答题、实时笔记、纪要、课堂笔记'),
        t('一场最长 2 小时，超了自动接下一场；暂停不计时'),
        t('一个授权码最多用在 2 台电脑上，Mac、Windows 都行'),
        currency === 'cny' ? t('支付宝、微信、银行卡都能付') : t('银行卡、Apple Pay 都能付'),
      ],
      featured: true,
    })

    // 自带 Key
    const own = column({
      name: t('自带 Key'),
      tags: [{ text: t('永久免费') }],
      price: t('免费'),
      unit: t('· 不限场次'),
      sub: t('用你自己的 AI 账户，费用直接付给服务商'),
      action: el(
        'button.btn.pricing-btn',
        {
          type: 'button',
          onClick: async () => {
            await call('updateSettings', { plan: 'own' })
            close()
            openSettings('ai')
          },
        },
        el('span', { text: state.settings?.plan === 'own' ? t('正在用 · 去设置') : t('去配置') }),
        icon('arrow-right', 14),
      ),
      items: [t('本地识别在你电脑上跑，免费、断网也能出字'), t('DeepSeek、通义、Kimi、豆包、智谱、OpenAI 等 10 家'), t('有 ChatGPT Plus 可以直接登录，不另花钱'), t('句子直接发给服务商，不经过我们')],
    })

    // 授权码
    codeInput = el('input.input.pricing-code-input', { type: 'text', placeholder: t('输入授权码（MC-XXXX-XXXX-XXXX）'), spellcheck: 'false', autocomplete: 'off' })
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) activate()
    })
    const myCode = info?.code
      ? el(
          'div.pricing-mycode',
          {},
          el('span', { text: t('这台电脑的授权码') }),
          el('code.selectable', { text: info.code }),
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onClick: () => copyText(info.code, t('授权码已复制')) }, icon('copy', 13), el('span', { text: t('复制') })),
          el('span.pricing-mycode-note', { text: t(`已用在 {0} 台电脑上，最多 2 台`, info.devices ?? 1) }),
        )
      : null
    const codeRow = el(
      'div.pricing-code',
      {},
      el('div.pricing-code-title', { text: info?.code ? t('换一个授权码，或在另一台电脑上用') : t('已经买过了？输入授权码') }),
      el(
        'div.pricing-code-row',
        {},
        codeInput,
        el('button.btn', { type: 'button', onClick: async () => (codeInput.value = (await navigator.clipboard.readText().catch(() => '')).trim()) }, icon('clipboard-list', 14), el('span', { text: t('粘贴') })),
        el('button.btn.btn-primary', { type: 'button', class: codeBusy ? 'is-loading' : '', onClick: activate }, el('span', { text: t('激活') })),
      ),
      codeMsg ? el('div.pricing-error', { text: codeMsg }) : null,
      myCode,
    )

    const faq = el(
      'div.pricing-faq',
      {},
      el('h3', { text: t('常见问题') }),
      el(
        'div.pricing-faq-grid',
        {},
        [
          [t('一场怎么算？'), t('点开始记录就算一场，最长 2 小时，到点自动接下一场。断网重连、暂停再继续、崩溃后 30 分钟内重开都算同一场；暂停的时间不计。不到 5 分钟就停止的不扣（一天最多 3 次）。')],
          [t('场次用完了会怎样？'), t('字幕不会断：自动换成本地识别接着记，翻译和答题这些 AI 功能先关着。买了场次马上恢复。')],
          [t('我的会议内容会被存吗？'), t('会员的声音从你的电脑直接发给 Soniox 识别；要翻译、要回答的句子经我们的服务器转给 DeepSeek。我们的服务器不存声音和文字，只记每场用了多少时长和 token。会议记录只存在你电脑上。')],
          [t('怎么换电脑、退款？'), t('新电脑上输授权码就行，一个授权码最多 2 台；不用的那台在「设置 → 会员」里解绑。买了没用过的场次可以退款，联系方式在官网上。')],
        ].map(([q, a]) => el('div.pricing-faq-item', {}, el('div.pricing-faq-q', { text: q }), el('div.pricing-faq-a', { text: a }))),
      ),
    )

    box.replaceChildren(
      el('button.btn.btn-icon.pricing-close', { type: 'button', 'aria-label': t('关闭'), onClick: close }, icon('x', 16)),
      el(
        'div.pricing-hero',
        {},
        el('img.pricing-logo', { src: '../../assets/icon.png', alt: '' }),
        el('h2', { text: t('MeetCaption · 外语会议和课堂，听得懂、答得上') }),
        el(
          'p.pricing-open',
          {},
          el('span.pricing-tag', { text: t('开源') }),
          el('span', { text: t('软件开源、永久免费；会员买的是免配置的云识别和 AI。') }),
          el('button.pricing-link', { type: 'button', onClick: () => call('openExternal', 'https://github.com/SchaeferAnjon/meetcaption') }, el('span', { text: t('查看源码') }), icon('arrow-right', 12)),
        ),
        el('div.pricing-note', {}, icon('shield-check', 14), el('span', { text: t('不想花钱也行：本地识别在你电脑上跑，字幕永远免费，断网也能出字。') })),
      ),
      el('div.pricing-cols', {}, trial, memberCol, own),
      codeRow,
      faq,
    )
  }

  async function withBusy(btn, fn) {
    btn.classList.add('is-loading')
    try {
      await fn()
    } finally {
      btn.classList.remove('is-loading')
    }
  }

  const unsub = on('member', () => render())
  render()
  document.querySelector('.app')?.append(backdrop) ?? document.body.append(backdrop)
  document.addEventListener('keydown', onKey, true)
  requestAnimationFrame(() => backdrop.classList.add('is-open'))
  if (state.settings?.plan === 'member' && !state.member?.info) call('memberRefresh')
  pricing = { close, render }
  return pricing
}

function wireMember(init) {
  state.member = init.member ?? null
  state.memberPacks = init.memberPacks ?? []
  subscribe('member:update', (snap) => {
    state.member = snap
    emit('member', snap)
    emit('status')
  })
  subscribe('member:paid', (info) => {
    ui.toast({ title: t('付款成功，场次已经加上'), message: t(`现在剩 {0} 场{1}`, info.balance, info.code ? t(`，授权码 {0}`, info.code) : ''), type: 'success' })
  })
  subscribe('member:showPricing', (opts) => openPricing(opts ?? {}))
  let plan = state.settings?.plan
  on('settings', () => {
    if (state.settings?.plan === plan) return
    plan = state.settings?.plan
    refreshLlm()
    emit('status')
  })
}
