// 组件展示页：左边是示意的主窗口侧栏，右边切换「主窗口骨架」和「全部组件」。
// 地址参数：?theme=dark|light&vibrancy=1|mica=1，#skeleton | #components | #palette | #modal | #menu
(function () {
  'use strict';
  const { el, icon, kbd } = ui;
  const params = new URLSearchParams(location.search);
  if (params.get('theme')) ui.setTheme(params.get('theme'));
  if (params.get('vibrancy') === '1') document.body.classList.add('vibrancy');
  if (params.get('mica') === '1') document.body.classList.add('mica');
  // ?tl=16,13：按主进程给的红绿灯位置排标题栏（真实页面里是 ui.applyChrome(init().chrome)）
  if (params.get('tl')) {
    const [x, y] = params.get('tl').split(',').map(Number);
    ui.applyChrome({ platform: 'darwin', material: params.get('vibrancy') === '1' ? 'vibrancy' : 'none', trafficLights: { x, y, width: 52, height: 16 } });
  }

  // ---------- 假数据 ----------

  const projects = [
    { id: 'thesis', name: '硕士论文', icon: 'graduation-cap', tint: 'indigo', meetings: 12 },
    { id: 'intern', name: '实习面试', icon: 'briefcase', tint: 'orange', meetings: 6 },
    { id: 'course', name: 'Transformer 课程', icon: 'book-open', tint: 'teal', meetings: 9 },
    { id: 'lab', name: '实验室周会', icon: 'flask-conical', tint: 'purple', meetings: 4 },
    { id: 'inbox', name: '未归类', icon: 'inbox', tint: 'gray', meetings: 3 },
  ];

  const meetings = [
    { id: 'm1', group: '今天', title: '和导师讨论消融实验', meta: '45 分钟 · 有纪要', time: '14:30', todos: 3 },
    { id: 'm2', group: '今天', title: '第二个数据集的误差分析', meta: '18 分钟 · 有纪要', time: '10:05', todos: 1 },
    { id: 'm3', group: '本周', title: 'Related work 章节结构', meta: '32 分钟 · 没有纪要', time: '周二', todos: 0 },
    { id: 'm4', group: '本周', title: '实验设置复查', meta: '51 分钟 · 有纪要', time: '周一', todos: 2 },
    { id: 'm5', group: '更早', title: '开题报告预演', meta: '1 小时 12 分钟 · 有纪要', time: '9月15日', todos: 4 },
    { id: 'm6', group: '更早', title: '选题讨论', meta: '38 分钟 · 有纪要', time: '9月9日', todos: 0 },
  ];

  const todos = [
    { text: '把 WebVision 子集的消融表格补上 Bonferroni 校正', due: '周五到期', tint: 'yellow', project: '硕士论文', ptint: 'indigo', done: false },
    { text: '给导师发修改后的第 4 章', due: '明天', tint: 'red', project: '硕士论文', ptint: 'indigo', done: false },
    { text: '整理去噪模块的超参数', due: null, project: '实验室周会', ptint: 'purple', done: false },
    { text: '确认下次开会时间', due: '已完成', project: '硕士论文', ptint: 'indigo', done: true },
  ];

  let mode = (location.hash || '#skeleton').slice(1);
  let currentProject = 'thesis';

  // ---------- 侧栏 ----------

  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('main');

  function renderSidebar() {
    ui.clear(sidebar);
    const nav = el('nav.sidebar-scroll', { 'aria-label': '导航' });
    nav.appendChild(el('button.search-trigger', { type: 'button', onClick: openPalette, style: 'margin-bottom:10px' },
      icon('search', 14), el('span', { text: '搜索' }), kbd('CommandOrControl+K', { size: 'sm' })));
    nav.appendChild(el('a.nav-item', { href: '#skeleton', onClick: (e) => go(e, 'skeleton') }, icon('house'), el('span.nav-label', { text: '首页' })));
    nav.appendChild(el('a.nav-item', { href: '#skeleton', onClick: (e) => go(e, 'skeleton') }, icon('list-todo'), el('span.nav-label', { text: '待办' }), el('span.count', { text: '5' })));
    nav.appendChild(el('a.nav-item', { href: '#components', class: mode === 'components' ? 'is-active' : '', onClick: (e) => go(e, 'components') },
      icon('sparkles'), el('span.nav-label', { text: '全部组件' })));
    nav.appendChild(el('div.nav-section', {}, el('span', { text: '项目' }),
      el('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': '新建项目', onClick: () => renameModal('') }, icon('plus', 14))));
    for (const p of projects) {
      const active = mode !== 'components' && p.id === currentProject;
      nav.appendChild(el('a.nav-item', {
        href: '#skeleton',
        class: active ? 'is-active' : '',
        'aria-current': active ? 'page' : null,
        onClick: (e) => {
          currentProject = p.id;
          go(e, 'skeleton');
        },
      }, ui.iconBox(p.icon, p.tint, { size: 'sm' }), el('span.nav-label', { text: p.name }), el('span.count', { text: String(p.meetings) })));
    }
    nav.appendChild(el('button.nav-item.is-muted', { type: 'button', onClick: () => renameModal('') }, icon('plus'), el('span.nav-label', { text: '新建项目' })));

    const footer = el('div.sidebar-footer', {},
      el('div.status-strip', {},
        el('button.status-chip', { type: 'button', title: '声纹已录好' }, el('span.dot.dot-ok'), '声纹'),
        el('button.status-chip', { type: 'button', title: 'ChatGPT 已登录' }, el('span.dot.dot-ok'), 'ChatGPT'),
        el('button.status-chip', { type: 'button', title: '识别服务还没配好，点这里去设置' }, el('span.dot.dot-warn'), '识别')),
      el('button.nav-item', { type: 'button', onClick: () => ui.toast({ title: '这里打开设置窗口', type: 'info' }) },
        icon('settings'), el('span.nav-label', { text: '设置' }), kbd('CommandOrControl+,', { size: 'sm' })));

    sidebar.append(el('div.sidebar-top'), nav, footer);
  }

  function go(e, next) {
    e.preventDefault();
    mode = next;
    history.replaceState(null, '', location.search + '#' + next);
    render();
  }

  // ---------- 主区域顶部：切换主题、毛玻璃 ----------

  function mainBar(title) {
    const theme = ui.segmented({
      size: 'sm',
      ariaLabel: '主题',
      value: document.documentElement.dataset.theme || 'system',
      options: [
        { value: 'system', label: '跟随系统' },
        { value: 'dark', label: '深色' },
        { value: 'light', label: '浅色' },
      ],
      onChange: (v) => ui.setTheme(v),
    });
    const vib = ui.toggle({
      size: 'sm',
      checked: document.body.classList.contains('vibrancy'),
      ariaLabel: '毛玻璃侧栏',
      onChange: (on) => document.body.classList.toggle('vibrancy', on),
    });
    return el('div.titlebar.main-bar.titlebar-safe-end', {},
      el('span.title-lg', { text: title }),
      el('label.form-inline.text-2.text-sm', {}, vib, '毛玻璃'),
      theme);
  }

  // ---------- 主窗口骨架：列表 + 详情 ----------

  function renderSkeleton() {
    const p = projects.find((x) => x.id === currentProject) || projects[0];
    const list = el('div.list', { role: 'listbox', 'aria-label': '会议' });
    let lastGroup = null;
    for (const m of meetings) {
      if (m.group !== lastGroup) {
        list.appendChild(el('div.section-title', { text: m.group }));
        lastGroup = m.group;
      }
      list.appendChild(ui.listItem({
        id: m.id,
        twoLine: true,
        title: m.title,
        subtitle: m.meta,
        selected: m.id === 'm1',
        accessories: [m.todos ? { icon: 'circle-check', text: String(m.todos), title: '未完成待办' } : null, m.time],
      }));
    }
    ui.listNav(list, { onOpen: (item) => ui.toast({ title: '打开会议', message: item.querySelector('.li-title').textContent }), initial: -1 });

    const listPane = el('section.pane', {},
      el('div.pane-header.drag', {},
        ui.iconBox(p.icon, p.tint),
        el('span.title-lg.truncate', { text: p.name, style: 'flex:1' }),
        el('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': '项目操作', onClick: (e) => projectMenu(e.currentTarget) }, icon('ellipsis'))),
      el('div.sk-start', {},
        el('div.btn-group', { style: 'width:100%' },
          el('button.btn.btn-primary.btn-lg', { type: 'button', style: 'flex:1', onClick: () => ui.toast({ title: '会议开始了', message: '在「' + p.name + '」里记录', type: 'success' }) },
            icon('mic'), el('span.truncate', { text: '在「' + p.name + '」里开始会议' })),
          el('button.btn.btn-primary.btn-lg.btn-icon', { type: 'button', 'aria-label': '换一个项目', onClick: (e) => projectPicker(e.currentTarget) }, icon('chevron-down')))),
      el('div.sk-list-tabs', {}, tabs(['会议', '待办与 DDL', '资料'], 0, ['12', '5', null])),
      el('div.pane-body', {}, list));

    const detail = el('div.sk-detail.selectable', {},
      el('input.input-bare.title-xl', { value: '和导师讨论消融实验', 'aria-label': '会议标题' }),
      el('div.sk-meta', {},
        el('span.tag.tag-dot', { dataset: { tint: p.tint }, text: p.name }),
        el('span', {}, icon('clock', 14), ' 9月24日 14:30 · 45 分钟'),
        el('span.tag.tag-ok', { text: '纪要已生成' })),
      tabs(['纪要', '待办', '字幕记录', 'AI 答题', '术语'], 0, [null, '3', null, '2', '6'], true),
      el('div.section-title', { style: 'padding-left:0;margin-top:10px', text: '待办和 DDL' }),
      el('div.sk-todos', {}, todos.map(todoRow)),
      summaryProse());

    const detailPane = el('section.pane', {},
      el('div.pane-header.drag.titlebar-safe-end', {},
        el('span.text-2.truncate', { text: '会议详情', style: 'flex:1' }),
        el('button.btn.btn-sm', { type: 'button', onClick: () => ui.toast({ title: '纪要已复制', type: 'success' }) }, icon('copy', 14), '复制纪要'),
        el('button.btn.btn-ghost.btn-icon', { type: 'button', 'aria-label': '更多', onClick: (e) => meetingMenu(e.currentTarget) }, icon('ellipsis'))),
      el('div.pane-body', {}, detail),
      el('div.action-bar', {},
        el('div.action-bar-context', {}, ui.iconBox(p.icon, p.tint, { size: 'sm' }), el('span.truncate', { text: p.name + ' / 和导师讨论消融实验' })),
        el('button.action', { type: 'button' }, '重新生成纪要', kbd('CommandOrControl+Enter', { size: 'sm' })),
        el('span.action-sep'),
        el('button.action', { type: 'button', onClick: (e) => meetingMenu(e.currentTarget, 'top') }, '操作', kbd('CommandOrControl+K', { size: 'sm' }))));

    return el('div.split', {}, listPane, detailPane);
  }

  function tabs(labels, active, counts, line) {
    const bar = el('div.tabs', { role: 'tablist', class: line ? 'tabs-line' : '' });
    labels.forEach((l, i) => {
      const b = el('button.tab', { type: 'button', role: 'tab', 'aria-selected': i === active ? 'true' : 'false' },
        l, counts && counts[i] ? el('span.count', { text: counts[i] }) : null);
      b.addEventListener('click', () => {
        bar.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', 'false'));
        b.setAttribute('aria-selected', 'true');
      });
      bar.appendChild(b);
    });
    return bar;
  }

  function todoRow(t) {
    const check = el('input.check', { type: 'checkbox', checked: t.done, 'aria-label': '完成' });
    const row = el('label.sk-todo', { class: t.done ? 'is-done' : '' },
      check,
      el('span.todo-text', { text: t.text }),
      t.due && !t.done ? el('span.tag', { dataset: { tint: t.tint }, text: t.due }) : null,
      el('span.tag.tag-dot', { dataset: { tint: t.ptint }, text: t.project }));
    check.addEventListener('change', () => row.classList.toggle('is-done', check.checked));
    return row;
  }

  function summaryProse() {
    return el('div.prose', {},
      el('h2', { text: '要点' }),
      el('ul', {},
        el('li', {}, '第二个数据集上消融掉去噪模块后下降 ', el('strong', { text: '7.5 个点' }), '，主要来自 WebVision 子集约 30% 的真实标签噪声。'),
        el('li', { text: '导师建议把多重比较的校正写进表格说明，不然审稿人会问。' }),
        el('li', { text: '下次开会前把第 4 章的修改稿发过去。' })),
      el('h2', { text: '讨论' }),
      el('p', { text: '对方先问为什么这个数据集上的下降比其他数据集大很多。我解释了标签噪声的来源，以及去噪模块在真实噪声下更关键。导师同意这个解释，但希望补一组合成噪声的对照实验。' }),
      el('blockquote', { text: 'Could you walk me through why the ablation drops so much there?' }));
  }

  // ---------- 菜单、弹层、模态框、命令面板 ----------

  function projectMenu(anchor) {
    ui.menu(anchor, [
      { label: '重命名', icon: 'pencil', kbd: 'CommandOrControl+R', onSelect: () => renameModal('硕士论文') },
      { label: '换颜色和图标', icon: 'sparkles' },
      { label: '归档', icon: 'archive' },
      'sep',
      { label: '删除项目', icon: 'trash', danger: true, onSelect: deleteProject },
    ], { align: 'end' });
  }

  function projectPicker(anchor) {
    ui.menu(anchor, [
      { section: '在哪个项目里开会' },
      ...projects.map((p) => ({
        label: p.name, icon: p.icon, tint: p.tint, checked: p.id === currentProject,
        onSelect: () => {
          currentProject = p.id;
          render();
        },
      })),
      'sep',
      { label: '新建项目', icon: 'plus', onSelect: () => renameModal('') },
    ], { align: 'end', minWidth: 240 });
  }

  function meetingMenu(anchor, placement) {
    ui.menu(anchor, [
      { label: '复制纪要', icon: 'copy', kbd: 'CommandOrControl+Shift+C' },
      { label: '移到其他项目', icon: 'folder', kbd: 'CommandOrControl+M' },
      { label: '在文件夹里显示', icon: 'external-link' },
      'sep',
      { label: '删除会议', icon: 'trash', danger: true, onSelect: () => ui.confirm({ title: '删除这场会议？', message: '会议文件夹会移到废纸篓。', okLabel: '删除', danger: true }) },
    ], { align: 'end', placement });
  }

  function renameModal(name) {
    const input = el('input.input', { value: name, placeholder: '比如：硕士论文、实习面试' });
    const desc = el('textarea.input', { placeholder: '一句话背景，AI 翻译和答题时会参考', rows: 3 });
    ui.modal({
      title: name ? '重命名项目' : '新建项目',
      description: name ? null : '每场会议都属于一个项目，项目里的背景、术语和我的资料会带给 AI。',
      body: el('div', { style: 'display:flex;flex-direction:column;gap:10px' }, input, desc),
      actions: [
        { label: '取消' },
        {
          label: name ? '保存' : '创建', kind: 'primary', onClick: () => {
            if (!input.value.trim()) {
              input.setAttribute('aria-invalid', 'true');
              input.focus();
              return false;
            }
            return new Promise((r) => setTimeout(r, 500)).then(() => ui.toast({ title: '已保存', type: 'success' }));
          },
        },
      ],
    });
  }

  async function deleteProject() {
    const ok = await ui.confirm({
      title: '删除「硕士论文」？',
      message: '里面的 12 场会议会移到「未归类」，不会删掉会议记录。',
      okLabel: '删除项目',
      danger: true,
    });
    if (ok) ui.toast({ title: '项目已删除', message: '12 场会议移到了「未归类」', action: { label: '撤销', onClick: () => ui.toast('已恢复') } });
  }

  const transcriptIndex = [
    { title: '和导师讨论消融实验', snippet: '…why the ablation drops so much there? 第二个数据集…', project: '硕士论文' },
    { title: '实验设置复查', snippet: '…Bonferroni correction 要写进表格说明…', project: '硕士论文' },
    { title: '第三轮技术面', snippet: '…walk me through your denoising module…', project: '实习面试' },
  ];

  function openPalette() {
    const cur = commandPaletteOpen();
    if (cur) return cur.close();
    ui.commandPalette({
      context: { icon: 'command', tint: 'indigo', label: '会议字幕' },
      groups: [
        {
          title: '命令',
          items: [
            { id: 'start', title: '开始会议', subtitle: '在「硕士论文」里', icon: 'mic', tint: 'red', kbd: 'CommandOrControl+Shift+R', actionLabel: '开始' },
            { id: 'new', title: '新建项目', icon: 'folder-plus', tint: 'blue', onSelect: () => renameModal('') },
            { id: 'ask', title: '让 AI 回答刚才的问题', icon: 'sparkles', tint: 'indigo', kbd: 'CommandOrControl+Alt+A' },
            { id: 'settings', title: '打开设置', icon: 'settings', tint: 'gray', kbd: 'CommandOrControl+,' },
            { id: 'theme', title: '切换深色和浅色', icon: 'moon', tint: 'gray', keywords: ['主题', 'dark', 'light'], keepOpen: true, onSelect: () => ui.setTheme(ui.currentScheme() === 'dark' ? 'light' : 'dark') },
          ],
        },
        {
          title: '项目',
          items: projects.map((p) => ({ id: 'p-' + p.id, title: p.name, icon: p.icon, tint: p.tint, accessory: p.meetings + ' 场会议', actionLabel: '切换到这个项目' })),
        },
        {
          title: '最近会议',
          items: meetings.slice(0, 4).map((m) => ({
            id: 'm-' + m.id, title: m.title, subtitle: '硕士论文', icon: 'message-square-text', tint: 'indigo', accessory: m.time,
            actions: [
              { label: '打开', icon: 'arrow-right', kbd: 'Enter' },
              { label: '复制纪要', icon: 'copy', kbd: 'CommandOrControl+Shift+C' },
              { label: '移到其他项目', icon: 'folder' },
              'sep',
              { label: '删除会议', icon: 'trash', danger: true },
            ],
          })),
        },
      ],
      source: (q) => new Promise((resolve) => setTimeout(() => {
        const hits = transcriptIndex.filter((t) => (t.title + t.snippet).toLowerCase().includes(q.toLowerCase()));
        resolve(hits.length ? [{
          title: '字幕和纪要里',
          items: hits.map((h, i) => ({ id: 's' + i, title: h.title, subtitle: h.project, snippet: h.snippet, icon: 'file-text', tint: 'teal' })),
        }] : []);
      }, 260)),
      onSelect: (item) => ui.toast({ title: item.title, message: '（示意）', type: 'info' }),
    });
  }

  function commandPaletteOpen() {
    return ui.commandPalette.current ? ui.commandPalette.current() : null;
  }

  ui.hotkey('CommandOrControl+K', openPalette);

  // ---------- 全部组件 ----------

  function section(title, lead, ...children) {
    return el('section.sg-section', {}, el('h2', { text: title }), lead ? el('p.sg-lead', { text: lead }) : null, ...children);
  }

  function row(label, ...children) {
    return el('div.sg-row', {}, label ? el('div.sg-label', { text: label }) : null, ...children);
  }

  function swatch(name, bg) {
    return el('div.sg-swatch', {}, el('span.sg-chip', {}, el('i', { style: { background: bg || `var(${name})` } })), el('code', { text: name }));
  }

  function renderComponents() {
    const page = el('div.sg-page');

    page.appendChild(section('颜色', '暗色和浅色各一套，用变量名，不写死颜色值。',
      row('背景和表面', el('div.sg-swatches', { style: 'width:100%' },
        ['--bg', '--bg-sidebar', '--bg-inset', '--bg-elevated', '--fill-1', '--fill-2', '--fill-3', '--fill-4', '--stroke', '--stroke-strong'].map((n) => swatch(n)))),
      row('文字和强调', el('div.sg-swatches', { style: 'width:100%' },
        ['--text', '--text-2', '--text-3', '--accent', '--accent-soft', '--green', '--yellow', '--red', '--blue', '--tr'].map((n) => swatch(n)))),
      row('图标方块（项目颜色）', ...ui.tints.map((t, i) => ui.iconBox(['folder', 'mic', 'sparkles', 'star', 'users', 'code', 'book-open', 'graduation-cap', 'lightbulb', 'briefcase'][i], t))),
      row('柔和版和小号', ...ui.tints.slice(1, 8).map((t) => ui.iconBox('folder', t, { variant: 'soft' })), ...ui.tints.slice(1, 8).map((t) => ui.iconBox('folder', t, { size: 'sm' })))));

    page.appendChild(section('文字', 'Mac 用系统字体，Windows 用 Segoe UI Variable 和微软雅黑 UI。正文 13px。',
      el('div', { style: 'display:flex;flex-direction:column;gap:8px' },
        el('div.title-2xl', { text: '下午好，准备开会了吗' }),
        el('div.title-xl', { text: '和导师讨论消融实验（17px 标题）' }),
        el('div.title-lg', { text: '分组标题 15px' }),
        el('div', { text: '正文 13px：对方的问题连同前面的铺垫句一起交给 AI。' }),
        el('div.text-2', { text: '次要文字：45 分钟 · 有纪要' }),
        el('div.text-3.text-sm', { text: '更弱的文字：9月24日 14:30' }),
        el('div.mono', { text: 'CommandOrControl+Alt+A' }))));

    const loadingBtn = el('button.btn.btn-primary', { type: 'button' }, icon('refresh-cw'), el('span', { text: '重新生成' }));
    loadingBtn.addEventListener('click', () => {
      loadingBtn.classList.add('is-loading');
      setTimeout(() => loadingBtn.classList.remove('is-loading'), 1200);
    });
    page.appendChild(section('按钮', '主按钮一屏最多一个。图标 16px，按钮里的快捷键徽标放右边。',
      row('种类',
        el('button.btn.btn-primary', { type: 'button' }, icon('mic'), '开始会议'),
        el('button.btn', { type: 'button' }, '默认'),
        el('button.btn', { type: 'button' }, icon('copy'), '复制'),
        el('button.btn.btn-ghost', { type: 'button' }, '幽灵按钮'),
        el('button.btn.btn-danger', { type: 'button' }, icon('trash'), '删除'),
        el('button.btn.btn-danger-solid', { type: 'button' }, '删除项目')),
      row('尺寸',
        el('button.btn.btn-sm', { type: 'button' }, '小 24px'),
        el('button.btn', { type: 'button' }, '中 28px'),
        el('button.btn.btn-lg', { type: 'button' }, '大 36px'),
        el('button.btn.btn-icon.btn-ghost', { type: 'button', 'aria-label': '更多' }, icon('ellipsis')),
        el('button.btn.btn-icon', { type: 'button', 'aria-label': '设置' }, icon('settings')),
        el('button.btn.btn-icon.btn-sm', { type: 'button', 'aria-label': '关闭' }, icon('x', 14))),
      row('带快捷键、加载、禁用、拆分',
        el('button.btn', { type: 'button' }, icon('captions'), '隐藏字幕', kbd('CommandOrControl+Alt+S', { size: 'sm' })),
        el('button.btn.btn-primary', { type: 'button' }, icon('sparkles'), '让 AI 回答', kbd('CommandOrControl+Alt+A', { size: 'sm' })),
        loadingBtn,
        el('button.btn.is-loading', { type: 'button' }, el('span', { text: '测试连接' })),
        el('button.btn', { type: 'button', disabled: true }, '不可用'),
        el('div.btn-group', {},
          el('button.btn.btn-primary', { type: 'button' }, icon('mic'), '开始会议'),
          el('button.btn.btn-primary.btn-icon', { type: 'button', 'aria-label': '选项目' }, icon('chevron-down'))))));

    page.appendChild(section('快捷键徽标', 'ui.kbd() 按平台显示：Mac 用符号，Windows 用 Ctrl、Alt、Shift。',
      row('', kbd('CommandOrControl+K'), kbd('CommandOrControl+Shift+Space'), kbd('CommandOrControl+Alt+A'), kbd('Enter'), kbd('Escape'), kbd('CommandOrControl+,'), kbd(['↑', '↓'])),
      row('小号', kbd('CommandOrControl+K', { size: 'sm' }), kbd('Enter', { size: 'sm' }),
        el('span.text-2', { text: '纯文字：' + ui.accelText('CommandOrControl+Shift+K') + ' / Windows：' + ui.accelText('CommandOrControl+Shift+K', 'win') }))));

    const segA = ui.segmented({ options: [{ value: 'system', label: '跟随系统' }, { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }], value: 'system', ariaLabel: '主题示例' });
    const segB = ui.segmented({ options: [{ value: 'volc', label: '豆包', icon: 'languages' }, { value: 'openai', label: 'OpenAI', icon: 'sparkles' }], value: 'volc', ariaLabel: '识别服务' });
    const segC = ui.segmented({ size: 'sm', options: ['自动', '中文', 'English'], value: '自动', ariaLabel: '回答语言' });
    const sel = ui.select({
      value: 'thesis',
      options: projects.map((p) => ({ value: p.id, label: p.name, icon: p.icon, tint: p.tint })),
      onChange: (v, o) => ui.toast({ title: '选了「' + o.label + '」' }),
      width: 220,
    });
    const selModel = ui.select({
      placeholder: '自动选择',
      groups: [
        { title: 'ChatGPT 订阅', options: [{ value: 'luna', label: 'gpt-5.6-luna', description: '快' }, { value: 'terra', label: 'gpt-5.6-terra', description: '更准' }] },
        { title: 'OpenAI API', options: [{ value: 'mini', label: 'gpt-5.6-mini' }] },
      ],
      width: 220,
    });
    const profile = el('textarea.input', { rows: 3, placeholder: '简历要点、项目介绍、常被问的问题' });
    const counter = el('div.form-hint', { text: '0 / 4000 字' });
    profile.addEventListener('input', () => {
      counter.textContent = profile.value.length + ' / 4000 字';
    });
    page.appendChild(section('输入和选择', '低对比度底色、细描边，聚焦时强调色描边。开关用 toggle，不用复选框。',
      el('div.sg-grid', {},
        el('div.sg-box', {}, el('div.sg-label', { text: '输入框' }),
          el('input.input', { placeholder: '比如：硕士论文' }),
          el('input.input', { value: 'sk-proj-••••••••', 'aria-invalid': 'true' }),
          el('div.form-hint.is-error', { text: 'Key 不对，服务返回 401' }),
          el('input.input', { value: '不能改', disabled: true })),
        el('div.sg-box', {}, el('div.sg-label', { text: '搜索框、大输入框' }),
          el('label.field', {}, icon('search', 14), el('input', { placeholder: '筛选待办' }), kbd('CommandOrControl+F', { size: 'sm' })),
          el('input.input.input-lg', { placeholder: 'App ID' }),
          el('select.select-native', {}, el('option', { text: '默认麦克风' }), el('option', { text: 'MacBook Pro 麦克风' }))),
        el('div.sg-box', {}, el('div.sg-label', { text: '文本域' }), profile, counter),
        el('div.sg-box', {}, el('div.sg-label', { text: '下拉（ui.select）' }), sel, selModel,
          ui.select({ options: ['一', '二'], disabled: true, placeholder: '不可用', width: 220 })),
        el('div.sg-box', {}, el('div.sg-label', { text: '分段控件' }), segA, segB, segC),
        el('div.sg-box', {}, el('div.sg-label', { text: '开关和勾选' }),
          el('div.form-inline', {}, ui.toggle({ checked: true, ariaLabel: '开' }), ui.toggle({ ariaLabel: '关' }), ui.toggle({ checked: true, disabled: true, ariaLabel: '禁用' }), ui.toggle({ size: 'sm', checked: true, ariaLabel: '小号' })),
          ui.toggle({ label: '自动回答', description: '对方一问完就出答案', checked: true }),
          el('div.form-inline', {}, el('input.check', { type: 'checkbox', checked: true, 'aria-label': '已完成' }), el('input.check', { type: 'checkbox', 'aria-label': '未完成' }),
            el('input.check.square', { type: 'checkbox', checked: true, 'aria-label': '方形' }), el('input.check', { type: 'checkbox', disabled: true, 'aria-label': '禁用' }))))));

    page.appendChild(section('设置行', '设置窗口用「左标签、右控件」的行，分组靠标题和分隔线，不套卡片。',
      el('div.form', {},
        el('div.form-section', {},
          el('h3.form-section-title', { text: '通用' }),
          formRow('主题', ui.segmented({ options: [{ value: 'system', label: '跟随系统' }, { value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }], value: 'system', ariaLabel: '主题' })),
          formRow('保存位置', el('div.form-inline', { style: 'width:100%' }, el('input.input', { value: '~/Documents/会议字幕', readOnly: true, style: 'flex:1;max-width:320px' }), el('button.btn', { type: 'button' }, '更改…'))),
          formRow('屏幕共享时', ui.toggle({ label: '隐藏字幕和答题框', checked: true }), '别人看你的共享屏幕时看不到这两个窗口。')),
        el('div.form-section', {},
          el('h3.form-section-title', { text: '账号与 AI' }),
          formRow('ChatGPT', el('div.form-inline', {}, el('span.avatar', { text: 'Z' }), el('span', { text: 'zonghan@example.com' }), el('span.tag.tag-accent', { text: 'Plus' }), el('button.btn.btn-sm', { type: 'button' }, '退出登录'))),
          formRow('答题模型', ui.select({ placeholder: '自动选择', options: ['gpt-5.6-luna', 'gpt-5.6-terra'], width: 220 }), '留空时 ChatGPT 通道用 terra。')))));

    const navList = el('div.list.sg-panel', { role: 'listbox', 'aria-label': '列表示例' },
      el('div.section-title', { text: '项目' }),
      ...projects.slice(0, 3).map((p, i) => ui.listItem({ id: p.id, icon: p.icon, tint: p.tint, title: p.name, subtitle: i === 0 ? '论文、组会、答辩' : '', accessories: [p.meetings + ' 场', i === 0 ? { kbd: 'CommandOrControl+1' } : null], selected: i === 0 })),
      el('div.section-title', { text: '待办' }),
      ui.listItem({ icon: 'list-todo', tint: 'yellow', title: '把消融表格补上校正', subtitle: '硕士论文', accessories: [{ tag: '周五', tint: 'yellow' }] }),
      ui.listItem({ icon: 'list-todo', tint: 'red', title: '给导师发第 4 章', subtitle: '硕士论文', accessories: [{ tag: '明天', tint: 'red' }] }),
      ui.listItem({ icon: 'archive', tint: 'gray', title: '已归档的项目', accessories: ['不可选'], className: 'is-disabled' }),
      el('div.list-loading', {}, ui.spinner(14), '正在加载更多'));
    ui.listNav(navList, { onOpen: (item) => ui.toast({ title: '回车打开：' + item.querySelector('.li-title').textContent }) });
    page.appendChild(section('列表', '行高 40px（两行 52px）。上下键移动、回车打开：点一下列表再按键试试。',
      el('div.sg-grid', { style: 'grid-template-columns:repeat(auto-fill,minmax(380px,1fr))' },
        navList,
        el('div.list.sg-panel', {},
          el('div.section-title', { text: '今天' }),
          ...meetings.slice(0, 2).map((m, i) => ui.listItem({ twoLine: true, title: m.title, subtitle: m.meta, accessories: [m.time], selected: i === 1 })),
          el('div.section-title', { text: '本周' }),
          ...meetings.slice(2, 4).map((m) => ui.listItem({ twoLine: true, title: m.title, subtitle: m.meta, accessories: [m.time] }))))));

    page.appendChild(section('标签页', '',
      row('圆角（项目页）', tabs(['会议', '待办与 DDL', '资料'], 0, ['12', '5', null])),
      row('下划线（会议详情）', el('div', { style: 'width:100%' }, tabs(['纪要', '待办', '字幕记录', 'AI 答题', '术语'], 1, [null, '3', null, '2', '6'], true)))));

    const meterMe = el('div.meter.meter-me', { style: { '--value': '62%', width: '120px' } }, el('i'));
    const meterOther = el('div.meter.meter-other', { style: { '--value': '35%', width: '120px' } }, el('i'));
    page.appendChild(section('标签、状态、音量', '',
      row('标签',
        el('span.tag', { text: '默认' }), el('span.tag.tag-accent', { text: 'Plus' }), el('span.tag.tag-me', { text: '我' }), el('span.tag.tag-other', { text: '对方' }),
        el('span.tag.tag-question', {}, icon('message-square-text', 12), '提问'), el('span.tag.tag-warn', { text: '周五到期' }), el('span.tag.tag-error', { text: '已逾期' }), el('span.tag.tag-ok', { text: '纪要已生成' }),
        ...projects.slice(0, 3).map((p) => el('span.tag.tag-dot', { dataset: { tint: p.tint }, text: p.name }))),
      row('圆点、头像、转圈',
        el('span.form-inline.text-2', {}, el('span.dot.dot-ok'), '已就绪'), el('span.form-inline.text-2', {}, el('span.dot.dot-warn'), '没配好'),
        el('span.form-inline.text-2', {}, el('span.dot.dot-error'), '出错'), el('span.form-inline.text-2', {}, el('span.dot.dot-live'), '录音中'),
        el('span.avatar', { text: 'Z' }), el('span.avatar.lg', { text: 'J' }), ui.spinner(14), ui.spinner(20)),
      row('音量条和进度',
        el('span.form-inline.text-2.text-sm', {}, icon('mic', 14), '我', meterMe),
        el('span.form-inline.text-2.text-sm', {}, icon('volume-2', 14), '对方', meterOther),
        el('div.progress', { style: { '--value': '40%', width: '140px' } }, el('i')),
        el('div.progress.is-indeterminate', { style: { width: '140px' } }, el('i')))));
    let t = 0;
    const timer = setInterval(() => {
      if (!meterMe.isConnected) return clearInterval(timer);
      t += 1;
      meterMe.style.setProperty('--value', Math.round(30 + 40 * Math.abs(Math.sin(t / 3))) + '%');
      meterOther.style.setProperty('--value', Math.round(10 + 30 * Math.abs(Math.cos(t / 4))) + '%');
    }, 120);

    const staticMenu = el('div.menu.sg-static', { role: 'menu', style: 'width:240px' },
      el('div.menu-list', {},
        el('div.menu-label', { text: '在哪个项目里开会' }),
        ...projects.slice(0, 3).map((p, i) => el('div.menu-item', { class: i === 1 ? 'is-selected' : '' }, ui.iconBox(p.icon, p.tint, { size: 'sm' }), el('span.menu-item-label', { text: p.name }), i === 0 ? el('span.menu-item-end', {}, icon('check', 14)) : null)),
        el('div.menu-sep'),
        el('div.menu-item', {}, icon('pencil'), el('span.menu-item-label', { text: '重命名' }), el('span.menu-item-end', {}, kbd('CommandOrControl+R', { size: 'sm' }))),
        el('div.menu-item.is-danger', {}, icon('trash'), el('span.menu-item-label', { text: '删除项目' }))));
    const termText = el('p', { style: 'margin:0;font-size:14px' }, 'Could you walk me through why the ',
      el('span.term', { text: 'ablation', dataset: { explain: '消融实验：去掉某个模块，看效果下降多少，用来证明这个模块有用。' } }),
      ' drops so much there? And did you apply a ',
      el('span.term', { text: 'Bonferroni correction', dataset: { explain: '多重比较时控制整体错误率的统计校正。' } }), '?');
    ui.tipDelegate(termText, '.term', (n) => ({ title: n.textContent, text: n.dataset.explain }));
    const popBtn = el('button.btn', { type: 'button' }, icon('info'), '弹层');
    popBtn.addEventListener('click', () => ui.popover(popBtn, el('div', { style: 'display:flex;flex-direction:column;gap:6px;width:260px' },
      el('div', { style: 'font-weight:600', text: '为什么要录声纹' }),
      el('div.text-2', { text: '外放时麦克风会串进对方的声音。录一次你的声纹，就能把串音滤掉，分清哪句是你说的。' }),
      el('div', {}, el('button.btn.btn-sm.btn-primary', { type: 'button' }, '去录声纹')))));
    page.appendChild(section('菜单、弹层、悬停解释', '菜单是锚定弹出的：上下键、回车、Esc，也能打字筛选（选项多时自动出现搜索框）。',
      row('',
        el('button.btn', { type: 'button', onClick: (e) => projectMenu(e.currentTarget) }, icon('ellipsis'), '项目操作'),
        el('button.btn', { type: 'button', onClick: (e) => projectPicker(e.currentTarget) }, icon('folder'), '选项目'),
        popBtn,
        el('button.btn', { type: 'button', onClick: (e) => ui.menu({ x: e.clientX, y: e.clientY }, [{ label: '复制', icon: 'copy' }, { label: '删除', icon: 'trash', danger: true }]) }, '在鼠标位置弹出')),
      el('div.sg-grid', {},
        el('div.sg-box', {}, el('div.sg-label', { text: '菜单（静态展示）' }), staticMenu),
        el('div.sg-box', {}, el('div.sg-label', { text: '术语悬停（鼠标停 250ms）' }), termText,
          el('div.tip.sg-static', { style: 'width:max-content' }, el('span.tip-title', { text: 'ablation' }), '消融实验：去掉某个模块，看效果下降多少。')))));

    page.appendChild(section('提示条、引导块', 'toast 从底部中间弹出，出错的停留更久并可关闭；引导块用在「没配置好的项」和权限说明。',
      row('',
        el('button.btn', { type: 'button', onClick: () => ui.toast({ title: '纪要已复制', type: 'success' }) }, '成功'),
        el('button.btn', { type: 'button', onClick: () => ui.toast({ title: '识别连不上', message: '豆包返回 401，检查 Access Token。', type: 'error' }) }, '出错'),
        el('button.btn', {
          type: 'button', onClick: () => {
            const tt = ui.toast({ title: '正在生成纪要…', type: 'loading' });
            setTimeout(() => tt.update({ title: '纪要生成好了', type: 'success', duration: 2600 }), 1400);
          },
        }, '加载后成功'),
        el('button.btn', { type: 'button', onClick: () => ui.toast({ title: '会议已移到「实习面试」', action: { label: '撤销', onClick: () => ui.toast('已撤销') } }) }, '带撤销')),
      el('div.sg-grid', {},
        el('div.sg-box', {},
          staticToast('success', 'circle-check', '纪要已复制'),
          staticToast('error', 'circle-alert', '识别连不上', '豆包返回 401，检查 Access Token。'),
          staticToast('loading', null, '正在生成纪要…')),
        el('div.sg-box', {},
          el('div.callout.callout-accent', {}, icon('fingerprint-pattern'), el('div.callout-body', {}, el('div.callout-title', { text: '还没录声纹' }), el('div.callout-desc', { text: '录 12 秒，就能分清你和对方。' })), el('button.btn.btn-sm.btn-primary', { type: 'button' }, '去录')),
          el('div.callout.callout-warn', {}, icon('triangle-alert'), el('div.callout-body', {}, el('div.callout-title', { text: '需要屏幕录制权限' }), el('div.callout-desc', { text: 'AI 答题要看屏幕截图，在系统设置里允许「会议字幕」。' })), el('button.btn.btn-sm', { type: 'button' }, '打开系统设置')),
          el('div.callout.callout-error', {}, icon('circle-alert'), el('div.callout-body', {}, el('div.callout-title', { text: '答题失败' }), el('div.callout-desc', { text: 'ChatGPT 额度用完了，稍后再试。' })))))));

    const st = ui.steps({ steps: ['录声纹', '连接 AI', '语音识别', '建第一个项目', '试一下'], current: 2 });
    page.appendChild(section('步骤条', '首次引导用：做完的打勾，当前一步用强调色。',
      el('div', { style: 'max-width:640px;margin-bottom:16px' }, st),
      row('', el('button.btn.btn-sm', { type: 'button', onClick: () => st.set(Math.max(0, stepAt - 1)) }, '上一步'),
        el('button.btn.btn-sm.btn-primary', { type: 'button', onClick: () => st.set(Math.min(4, stepAt + 1)) }, '下一步'))));
    let stepAt = 2;
    const setStep = st.set;
    st.set = (i) => {
      stepAt = i;
      setStep(i);
    };

    page.appendChild(section('空状态', '',
      el('div.sg-grid', {},
        el('div.sg-panel', {}, ui.emptyState({ icon: 'message-square-text', title: '这个项目还没有会议', description: '点「开始会议」，字幕和纪要会存在这里。', action: { label: '开始会议', icon: 'mic', primary: true } })),
        el('div.sg-panel', {}, ui.emptyState({ icon: 'circle-check', title: '没有待办了', description: '会议纪要里提到的事情会自动出现在这里。' })))));

    page.appendChild(section('模态框、确认、命令面板', '模态框：Esc 关，回车触发主按钮，Tab 在框内循环。命令面板：⌘K / Ctrl+K，模糊匹配，⌘K 打开所选项的操作。',
      row('',
        el('button.btn', { type: 'button', onClick: () => renameModal('') }, icon('folder-plus'), '新建项目'),
        el('button.btn.btn-danger', { type: 'button', onClick: deleteProject }, icon('trash'), '删除项目（确认框）'),
        el('button.btn.btn-primary', { type: 'button', onClick: openPalette }, icon('command'), '命令面板', kbd('CommandOrControl+K', { size: 'sm' })))));

    page.appendChild(section('悬浮字幕和答题框', '始终深色半透明（.hud），12px 圆角、细描边、柔和阴影；标题条用快捷键徽标提示。',
      el('div.sg-hud-stage', {},
        el('div.hud.sg-caption', {},
          el('div', {}, el('span.who', { text: '对方' }), 'Could you walk me through why the ', el('span.term', { text: 'ablation' }), ' drops so much there?'),
          el('div.tr', { text: '你能讲讲为什么那里的消融结果下降这么多吗？' }),
          el('div.me', { style: 'margin-top:6px' }, el('span.who', { text: '我' }), 'Sure. On the second dataset the labels are much noisier…')),
        el('div.hud.sg-answer', {},
          el('div.hud-header', {}, icon('sparkles', 14), 'AI 回答', el('span.spacer'), kbd('CommandOrControl+Alt+A', { size: 'sm' }),
            el('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': '收起' }, icon('x', 14))),
          el('div.sg-answer-body', {},
            el('div.sg-answer-q', { text: '问：Could you walk me through why the ablation drops so much there?' }),
            el('div.sg-answer-key', { text: '要点：真实噪声下去噪更关键' }),
            el('div', { text: 'The larger drop is on the WebVision subset, which has about 30 percent real label noise. Removing the denoising module costs 7.5 points there.' })),
          el('div.sg-answer-foot', {}, el('span', { text: '等首字 1.1 秒 · 生成 1.8 秒' }), el('span.spacer'),
            el('button.btn.btn-ghost.btn-sm', { type: 'button' }, icon('refresh-cw', 14), '重新回答'),
            el('button.btn.btn-ghost.btn-sm', { type: 'button' }, icon('copy', 14), '复制'))))));

    return page;
  }

  function formRow(label, control, hint) {
    return el('div.form-row', {}, el('div.form-label', { text: label }),
      el('div.form-control', {}, control, hint ? el('div.form-hint', { text: hint }) : null));
  }

  function staticToast(type, iconName, title, message) {
    return el('div.toast.sg-static', { dataset: { type } },
      iconName ? icon(iconName, 16) : ui.spinner(14),
      el('div.toast-text', {}, el('div.toast-title', { text: title }), message ? el('div.toast-message', { text: message }) : null),
      type === 'error' ? el('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': '关闭' }, icon('x', 14)) : null);
  }

  // ---------- 渲染 ----------

  function render() {
    renderSidebar();
    ui.clear(main);
    if (mode === 'components') {
      main.append(mainBar('全部组件'), el('div.pane-body', {}, renderComponents()));
    } else {
      main.appendChild(renderSkeleton());
      // 骨架页的主题开关放在详情面板顶部
      const header = main.querySelector('.split > .pane:last-child .pane-header');
      const bar = mainBar('');
      header.insertBefore(el('div.form-inline', {}, ...Array.from(bar.children).slice(1)), header.children[1]);
    }
  }

  render();
  const hash = location.hash.slice(1);
  if (hash === 'palette') openPalette();
  if (hash === 'modal') renameModal('');
  if (hash === 'menu') projectPicker(document.querySelector('.btn-group .btn-icon'));
})();
