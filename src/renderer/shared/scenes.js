'use strict'
// 首次引导和「看演示」用的动画（和官网首页的演示舞台同一份，来自 design/onboarding 原型）。设计尺寸 640×400，按容器宽度缩放。
// 只拼静态的演示文字，不放任何用户内容。
// 三个功能、8 个动作的演示动画；window.Scenes.mount(host, { actions }) 返回 { play(i), stop() }
;(function () {
  const W = 640, H = 400;
  const CURSOR = '<svg class="cursor" viewBox="0 0 18 24"><path d="M1.5 1.5v18l4.6-4.4 3 7 3-1.3-3-6.9h6.4z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const EN = [['Could you walk me through', 'k1'], ['why the <span class="term">ablation</span> drops', 'k2'], ['on the second dataset?', 'k3']];
  const ZH = [[t('你能讲讲'), 'k1'], [t('，在第二个数据集上'), 'k3'], [t('，为什么<span class="term">消融</span>结果会掉'), 'k2'], [t('？'), '']];
  const call = (extra = '') => t(`<div class="callwin"><div class="bar"><i></i><i></i><i></i><span style="margin-left:6px">Zoom 会议 · 组会</span></div><div class="tiles"><div class="tile talk"><div class="av">M</div><span class="nm">Prof. Miller</span></div><div style="display:grid;gap:6px"><div class="tile"><div class="av sm">L</div><span class="nm">Lena</span></div><div class="tile"><div class="av sm" style="background:linear-gradient(135deg,#d6a07a,#a8694a)">你</div><span class="nm">你</span></div></div></div></div>{0}`, extra);
  const enLine = () => EN.map(([t, k]) => `<span class="ck ${k}">${t.split(/(<span[^>]*>[^<]*<\/span>| )/).filter((x) => x && x !== ' ').map((w) => `<span class="w">${w}</span>`).join(' ')}</span>`).join(' ');
  const hud = () => `<div class="caphud"><div class="en">${enLine()}</div><div class="zh">${ZH.map(([t, k]) => `<span class="zc ${k}">${t}</span>`).join('')}</div></div>`;
  const ACTIONS = {
    talk: { name: t('对方说话，字幕就出来'), desc: t('对方一开口，屏幕最上层就出字幕：一个词一个词地跟着，<b>不用对方开字幕</b>，Zoom、Teams、腾讯会议都行。'), step: t('对方说的英文一句句出来'), dur: 6200,
      html: () => call(hud()), run(s, at) { const ws = [...s.querySelectorAll('.w')]; ws.forEach((w, i) => at(300 + i * 230, () => w.classList.add('on'))); } },
    color: { name: t('译文跟在下面，意群同色'), desc: t('每句原文下面跟一句译文，<b>同一个意思用同一种颜色</b>，顺序倒过来也一眼对得上。'), step: t('原文和译文按颜色对上'), dur: 6400,
      html: () => call(hud()), run(s, at) { s.querySelectorAll('.w').forEach((w) => w.classList.add('on')); const ck = [...s.querySelectorAll('.ck')], zc = [...s.querySelectorAll('.zc')]; [[0, 0], [1, 2], [2, 1]].forEach(([e, z], j) => at(500 + j * 900, () => { ck[e].classList.add('col'); zc[z].classList.add('on'); })); at(3300, () => zc[3].classList.add('on')); } },
    term: { name: t('鼠标停在术语上看解释'), desc: t('专业词两边都画了虚线，<b>鼠标停上去</b>就弹出一句解释；字幕窗不挡点击，会议软件照常用。'), step: t('停在「ablation」上'), dur: 6000,
      html: () => call(hud() + t('<div class="tip"><b>ablation · 消融实验</b><br>去掉模型的某个部分，看效果掉多少，用来判断这部分有没有用。</div>') + CURSOR),
      run(s, at) { s.querySelectorAll('.w,.zc').forEach((w) => w.classList.add('on')); s.querySelectorAll('.ck').forEach((w) => w.classList.add('col')); const c = s.querySelector('.cursor'), tip = s.querySelector('.tip'), term = s.querySelector('.caphud .term'); at(400, () => { const o = s.getBoundingClientRect(), r = term.getBoundingClientRect(), k = o.width / W || 1; const x = (r.left - o.left + r.width * 0.5) / k, top = (r.top - o.top) / k; c.style.left = `${x - 3}px`; c.style.top = `${top + (r.height / k) * 0.45}px`; tip.style.left = `${Math.max(8, Math.min(W - 238, x - 115))}px`; tip.style.bottom = `${H - top + 8}px`; }); at(1500, () => tip.classList.add('on')); } },
    ask: { name: t('对方提问，答案就浮出来'), desc: t('听出是在问你，右上角的答题框<b>马上给出能照着说的回答</b>，下面带译文。'), step: t('对方问完，答案自己出来'), dur: 7600,
      html: () => call(t(`<div class="caphud"><div class="en"><span class="qtag">提问</span><span class="qq">What would you do differently if you had more time?</span></div><div class="zh" style="color:#bbb">如果时间更多，你会怎么做得不一样？</div></div><div class="ansbox"><div class="ah"><span class="dt"></span>AI 回答 · 1.2 秒</div><div class="q">如果时间更多，你会怎么做？</div><div class="a"></div><div class="az">我会先缩小实验规模，在一个数据集上验证假设，再扩大。</div></div>`)),
      run(s, at) { at(600, () => s.querySelector('.qtag').classList.add('on')); at(1100, () => s.querySelector('.ansbox').classList.add('on')); const t = "I'd scale the experiment down first, validate the idea on one dataset, then expand."; const a = s.querySelector('.a'); for (let i = 0; i <= t.length; i += 3) at(1500 + i * 28, () => (a.textContent = t.slice(0, i))); at(1500 + t.length * 28 + 100, () => { a.textContent = t; s.querySelector('.az').classList.add('on'); }); } },
    key: { name: t('没自动出来，按 ⌥⌘A'), desc: t('老师点名、对方没用问号的时候，<b>按一下快捷键</b>，AI 就回答刚才那句。在任何软件里都能按。'), step: t('按快捷键让 AI 回答'), dur: 6400,
      html: () => call(t(`<div class="caphud"><div class="en">So, any thoughts on the baseline?</div><div class="zh" style="color:#bbb">那么，对基线有什么看法？</div></div><div class="keys"><span>⌥</span><span>⌘</span><span>A</span></div><div class="ansbox"><div class="ah"><span class="dt"></span>AI 回答</div><div class="q">对基线有什么看法？</div><div class="a">The baseline is solid, but it's tuned on a different split, so I'd rerun it on ours first.</div><div class="az on">基线没问题，但调参用的是另一种划分，我会先在我们的数据上重跑一次。</div></div>`)),
      run(s, at) { const k = s.querySelector('.keys'), ks = [...k.children]; at(500, () => k.classList.add('on')); at(1000, () => ks.forEach((x) => x.classList.add('dn'))); at(1300, () => ks.forEach((x) => x.classList.remove('dn'))); at(1600, () => k.classList.remove('on')); at(1800, () => s.querySelector('.ansbox').classList.add('on')); } },
    share: { name: t('共享屏幕时对方看不到'), desc: t('字幕和答题框<b>只有你自己看得见</b>：对方看你的共享屏幕、录屏、截图，都没有它们。'), step: t('左边是你，右边是对方看到的'), dur: 5600,
      html: () => t(`<div class="split2"><div class="pane"><div class="mini" style="transform:scale(.458)">{0}</div><div class="lab">你的屏幕：字幕和答题框都在</div></div><div class="pane"><div class="mini" style="transform:scale(.458)">{1}</div><div class="lab">对方看到的共享屏幕：什么都没有</div></div></div>`, call(hud() + t('<div class="ansbox on"><div class="ah"><span class="dt"></span>AI 回答</div><div class="a">I would start with the smaller model.</div></div>')), call()),
      run(s) { s.querySelectorAll('.w,.zc').forEach((w) => w.classList.add('on')); s.querySelectorAll('.ck').forEach((w) => w.classList.add('col')); } },
    notes: { name: t('每两分钟整理一版笔记'), desc: t('上课时右边是<b>实时笔记</b>：小节、要点、公式、老师强调的考点，边听边长出来，下课生成完整的课堂笔记。'), step: t('笔记跟着老师讲的长出来'), dur: 7000,
      html: () => t(`<div class="slidewin"><div class="bar"><i></i><i></i><i></i><span style="margin-left:6px">Machine Learning · 第 7 讲</span></div><h5>Gradient Descent</h5><p>Step size matters: too large oscillates, too small is slow.</p><svg class="cv" viewBox="0 0 340 170"><path d="M10 20 Q170 300 330 20" fill="none" stroke="#5a5ff0" stroke-width="3"/><path d="M42 70L282 91L80 116L240 133L132 152L196 156" fill="none" stroke="#f5883a" stroke-dasharray="4 4"/><g fill="#f5883a"><circle cx="42" cy="70" r="5"/><circle cx="282" cy="91" r="5"/><circle cx="80" cy="116" r="5"/><circle cx="240" cy="133" r="5"/><circle cx="132" cy="152" r="5"/><circle cx="196" cy="156" r="5"/></g></svg></div>
        <div class="notes"><div class="nh"><span class="dt"></span>实时笔记</div><div class="it h">1. 梯度下降的直觉</div><div class="it">· 沿着坡最陡的方向往下走</div><div class="it">· 学习率太大会来回震荡</div><div class="it">· 太小收敛很慢</div><div class="it ex">★ 考点：学习率怎么选</div><div class="it h">2. 收敛条件</div><div class="it">· 损失不再下降就停</div></div>`),
      run(s, at) { [...s.querySelectorAll('.notes .it')].forEach((x, i) => at(500 + i * 700, () => x.classList.add('on'))); } },
    shot: { name: t('按 ⌥⌘P 截下课件'), desc: t('网课时按一下就把<b>当前课件截下来</b>，放进这节课；笔记和下课生成的图文笔记会在讲到它的地方插这张图。'), step: t('截下课件，放进笔记'), dur: 5600,
      html: () => ACTIONS.notes.html().replace('<div class="notes">', '<div class="flashw"></div><div class="fly"></div><div class="notes">').replace(t('<div class="it h">2. 收敛条件</div><div class="it">· 损失不再下降就停</div>'), t('<div class="it"><div class="thumb">课件 14:32 · Gradient Descent</div></div>')),
      run(s, at) { s.querySelectorAll('.notes .it').forEach((x, i) => { if (i < 5) x.classList.add('on'); }); at(700, () => s.querySelector('.flashw').classList.add('on')); at(900, () => s.querySelector('.fly').classList.add('on')); at(1300, () => s.querySelector('.fly').classList.add('go')); at(2100, () => { s.querySelector('.fly').style.display = 'none'; [...s.querySelectorAll('.notes .it')].slice(5).forEach((x) => x.classList.add('on')); }); } },
  };
  function mount(host, opts = {}) {
    host.classList.add('stagefit');
    const st = document.createElement('div'); st.className = 'stage'; host.append(st);
    const fit = () => { const k = host.clientWidth / W; st.style.transform = `scale(${k})`; host.style.height = H * k + 'px'; };
    fit(); new ResizeObserver(fit).observe(host);
    let timers = [], cur = null;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const at = (ms, f) => timers.push(setTimeout(f, reduce ? 0 : ms));
    function play(key) {
      timers.forEach(clearTimeout); timers = []; cur = key;
      const a = ACTIONS[key]; st.innerHTML = `<div class="sc">${a.html()}</div>`;
      a.run(st, at);
      if (!reduce) at(a.dur, () => play(key));
      opts.onPlay && opts.onPlay(key, a);
    }
    return { play, stop: () => { timers.forEach(clearTimeout); timers = []; }, fit };
  }
  window.Scenes = { ACTIONS, mount };
})();
