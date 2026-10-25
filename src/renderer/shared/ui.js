/*
 * 会议字幕 v3 界面小工具。纯浏览器脚本，不用打包器，挂到 window.ui。
 * 引入：<script src="../shared/icons.js"></script><script src="../shared/ui.js"></script>
 * 约定：从模型、用户、文件来的文字一律走 textContent；本文件没有 innerHTML。
 * 各函数的参数和例子见 docs/v3-ui-kit.md。
 */
(function () {
  'use strict';

  const ui = (window.ui = window.ui || {});
  const doc = document;

  // ---------- 平台和主题 ----------

  function detectPlatform() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
    if (/mac/i.test(p)) return 'mac';
    if (/win/i.test(p)) return 'win';
    return 'linux';
  }

  const platform = detectPlatform();
  const isMac = platform === 'mac';
  doc.documentElement.classList.add('is-' + platform);

  // mode: 'system' | 'dark' | 'light'
  function setTheme(mode) {
    if (mode === 'dark' || mode === 'light') doc.documentElement.dataset.theme = mode;
    else delete doc.documentElement.dataset.theme;
  }

  function currentScheme() {
    const forced = doc.documentElement.dataset.theme;
    if (forced === 'dark' || forced === 'light') return forced;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // 窗口外观：传 init() 返回的 chrome（{ platform, material, titleBarHeight, trafficLights }）。
  // 给 body 加 vibrancy / mica 类；Mac 按红绿灯位置算标题栏高度，让红绿灯上下居中；Windows 用系统按钮的高度。
  function applyChrome(chrome) {
    if (!chrome) return;
    const b = doc.body;
    const root = doc.documentElement;
    b.classList.toggle('vibrancy', chrome.material === 'vibrancy');
    b.classList.toggle('mica', chrome.material === 'mica');
    const t = chrome.trafficLights;
    if (t && typeof t.y === 'number') {
      root.style.setProperty('--titlebar-h', Math.max(38, Math.round(t.y * 2 + (t.height || 16))) + 'px');
      root.style.setProperty('--traffic-end', Math.round((t.x || 0) + (t.width || 52) + 12) + 'px');
    } else if (chrome.titleBarHeight) {
      root.style.setProperty('--titlebar-h', chrome.titleBarHeight + 'px');
    }
  }

  // ---------- el()：建节点 ----------

  function parseTag(spec) {
    const m = String(spec || 'div').match(/^[a-zA-Z][\w-]*/);
    const tag = m ? m[0] : 'div';
    const classes = [];
    let id = null;
    const re = /([.#])([\w-]+)/g;
    let r;
    while ((r = re.exec(spec))) {
      if (r[1] === '.') classes.push(r[2]);
      else id = r[2];
    }
    return { tag, classes, id };
  }

  function isChild(v) {
    return v == null || typeof v === 'string' || typeof v === 'number' || Array.isArray(v) || v instanceof Node;
  }

  function append(parent, children) {
    for (const c of children) {
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) append(parent, c);
      else if (c instanceof Node) parent.appendChild(c);
      else parent.appendChild(doc.createTextNode(String(c)));
    }
    return parent;
  }

  function setProps(node, props) {
    for (const key of Object.keys(props)) {
      const v = props[key];
      if (v === undefined) continue;
      if (key === 'class' || key === 'className') {
        const list = Array.isArray(v) ? v : String(v || '').split(/\s+/);
        for (const c of list) if (c) node.classList.add(c);
      } else if (key === 'text') {
        node.textContent = v == null ? '' : String(v);
      } else if (key === 'html' || key === 'innerHTML') {
        console.warn(t('[ui.el] 不支持 html，外来文字请用 text'));
      } else if (key === 'style') {
        if (typeof v === 'string') node.style.cssText += ';' + v;
        else if (v) {
          for (const s of Object.keys(v)) {
            if (s.startsWith('--')) node.style.setProperty(s, v[s]);
            else node.style[s] = v[s];
          }
        }
      } else if (key === 'dataset') {
        for (const d of Object.keys(v || {})) if (v[d] != null) node.dataset[d] = v[d];
      } else if (key === 'attrs') {
        for (const a of Object.keys(v || {})) if (v[a] != null && v[a] !== false) node.setAttribute(a, v[a] === true ? '' : v[a]);
      } else if (key === 'on') {
        for (const ev of Object.keys(v || {})) node.addEventListener(ev, v[ev]);
      } else if (/^on[A-Z]/.test(key) && typeof v === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), v);
      } else if (key.includes('-') || key === 'role' || key === 'for' || key === 'tabindex') {
        if (v === null || v === false) continue;
        node.setAttribute(key, v === true ? '' : v);
      } else if (key in node && !(node instanceof SVGElement)) {
        node[key] = v;
      } else if (v !== null && v !== false) {
        node.setAttribute(key, v === true ? '' : v);
      }
    }
  }

  // el('div.row.is-active#id', { text, class, style, dataset, attrs, on, onClick, ...属性 }, ...子节点)
  // 子节点里的字符串一律变成文本节点。
  function el(spec, props, ...children) {
    const { tag, classes, id } = parseTag(spec);
    const node = doc.createElement(tag);
    if (classes.length) node.classList.add(...classes);
    if (id) node.id = id;
    if (isChild(props)) children.unshift(props);
    else if (props) setProps(node, props);
    return append(node, children);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function icon(name, size, opts) {
    if (typeof ui.icon === 'function' && ui.icon !== icon) return ui.icon(name, size, opts);
    return doc.createElement('span');
  }

  // ---------- 快捷键 ----------

  const MAC_KEYS = {
    commandorcontrol: '⌘', cmdorctrl: '⌘', command: '⌘', cmd: '⌘', mod: '⌘', super: '⌘', meta: '⌘',
    control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', altgr: '⌥', shift: '⇧',
    enter: '↵', return: '↵', escape: 'Esc', esc: 'Esc', backspace: '⌫', delete: '⌦', tab: '⇥', space: 'Space',
    up: '↑', down: '↓', left: '←', right: '→', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
    plus: '+', pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End',
  };
  const WIN_KEYS = {
    commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', command: 'Ctrl', cmd: 'Ctrl', mod: 'Ctrl', super: 'Win', meta: 'Win',
    control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', option: 'Alt', altgr: 'AltGr', shift: 'Shift',
    enter: 'Enter', return: 'Enter', escape: 'Esc', esc: 'Esc', backspace: 'Backspace', delete: 'Del', tab: 'Tab', space: 'Space',
    up: '↑', down: '↓', left: '←', right: '→', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
    plus: '+', pageup: 'PgUp', pagedown: 'PgDn', home: 'Home', end: 'End',
  };
  const MAC_SYMBOLS = '⌘⇧⌥⌃';

  function splitAccel(accel) {
    if (Array.isArray(accel)) return accel.map(String);
    const s = String(accel || '').trim();
    if (!s) return [];
    if (!s.includes('+') || s === '+') {
      if (MAC_SYMBOLS.includes(s[0]) && s.length > 1) return Array.from(s);
      return [s];
    }
    const parts = s.split('+');
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '' && i === parts.length - 1 && parts[i - 1] === '') out.push('+');
      else if (parts[i] !== '') out.push(parts[i]);
    }
    return out;
  }

  // 'CommandOrControl+Shift+K' → Mac ['⌘','⇧','K']，Windows ['Ctrl','Shift','K']
  function formatAccel(accel, plat = platform) {
    const table = plat === 'mac' ? MAC_KEYS : WIN_KEYS;
    return splitAccel(accel).map((k) => {
      const t = table[k.toLowerCase()];
      if (t) return t;
      if (MAC_SYMBOLS.includes(k) && plat !== 'mac') return WIN_KEYS[{ '⌘': 'cmd', '⇧': 'shift', '⌥': 'alt', '⌃': 'ctrl' }[k]];
      return k.length === 1 ? k.toUpperCase() : k;
    });
  }

  // 纯文字版：Mac「⌘⇧K」，Windows「Ctrl+Shift+K」
  function accelText(accel, plat = platform) {
    const keys = formatAccel(accel, plat);
    return plat === 'mac' ? keys.join('') : keys.join('+');
  }

  function kbd(accel, opts = {}) {
    const keys = formatAccel(accel, opts.platform);
    const group = el('span.kbd-group', { class: opts.size === 'sm' ? 'kbd-sm' : '', 'aria-label': accelText(accel, opts.platform) });
    for (const k of keys) group.appendChild(el('span.kbd', { text: k, 'aria-hidden': 'true' }));
    return group;
  }

  const CODE_FOR = {
    ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight',
    '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote',
  };
  const KEY_ALIAS = {
    enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', space: ' ', tab: 'Tab', backspace: 'Backspace',
    delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', plus: '+',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End',
  };

  function parseAccel(accel) {
    const want = { meta: false, ctrl: false, alt: false, shift: false, key: '' };
    for (const raw of splitAccel(accel)) {
      const k = raw.toLowerCase();
      if (['commandorcontrol', 'cmdorctrl', 'mod'].includes(k)) {
        if (isMac) want.meta = true;
        else want.ctrl = true;
      } else if (['command', 'cmd', 'super', 'meta', '⌘'].includes(k)) want.meta = true;
      else if (['control', 'ctrl', '⌃'].includes(k)) want.ctrl = true;
      else if (['alt', 'option', 'altgr', '⌥'].includes(k)) want.alt = true;
      else if (['shift', '⇧'].includes(k)) want.shift = true;
      else want.key = KEY_ALIAS[k] || raw;
    }
    return want;
  }

  function matchAccel(e, accel) {
    const w = typeof accel === 'string' || Array.isArray(accel) ? parseAccel(accel) : accel;
    if (e.metaKey !== w.meta || e.ctrlKey !== w.ctrl || e.altKey !== w.alt || e.shiftKey !== w.shift) return false;
    const key = w.key;
    if (/^[a-z]$/i.test(key)) return e.code === 'Key' + key.toUpperCase();
    if (/^[0-9]$/.test(key)) return e.code === 'Digit' + key || e.code === 'Numpad' + key;
    if (CODE_FOR[key]) return e.code === CODE_FOR[key] || e.key === key;
    return e.key === key || e.key.toLowerCase() === String(key).toLowerCase();
  }

  function isTyping(target) {
    if (!target || !(target instanceof Element)) return false;
    return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
  }

  // 页面内快捷键：ui.hotkey('Mod+K', fn)；带 Cmd/Ctrl/Alt 的组合在输入框里也生效
  function hotkey(accel, handler, opts = {}) {
    const want = parseAccel(accel);
    const hasMod = want.meta || want.ctrl || want.alt;
    const allowInInput = opts.allowInInput ?? hasMod;
    const target = opts.target || doc;
    const fn = (e) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if (!allowInInput && isTyping(e.target)) return;
      if (!matchAccel(e, want)) return;
      if (opts.preventDefault !== false) e.preventDefault();
      handler(e);
    };
    target.addEventListener('keydown', fn, opts.capture ? true : false);
    return () => target.removeEventListener('keydown', fn, opts.capture ? true : false);
  }

  // ---------- 小组件 ----------

  function spinner(size = 14) {
    return el('span.spinner', { role: 'status', 'aria-label': t('加载中'), style: { width: size + 'px', height: size + 'px' } });
  }

  function iconBox(name, tint = 'gray', opts = {}) {
    return el('span.icon-box', { class: [opts.size, opts.variant], dataset: { tint } }, icon(name, 16));
  }

  // toggle({ checked, disabled, onChange(checked), label, description }) → <input class="toggle">，
  // 给了 label 时返回 <label class="toggle-field">，input 在 .input 上
  function toggle(opts = {}) {
    const input = el('input.toggle', {
      type: 'checkbox',
      role: 'switch',
      checked: !!opts.checked,
      disabled: !!opts.disabled,
      id: opts.id,
      name: opts.name,
      class: opts.size === 'sm' ? 'toggle-sm' : '',
      'aria-label': opts.label ? null : opts.ariaLabel,
    });
    if (opts.onChange) input.addEventListener('change', () => opts.onChange(input.checked, input));
    if (!opts.label) return input;
    const field = el('label.toggle-field', {},
      el('span.toggle-text', {}, el('span.toggle-label', { text: opts.label }), opts.description ? el('span.toggle-desc', { text: opts.description }) : null),
      input);
    field.input = input;
    return field;
  }

  function normOptions(options) {
    return (options || []).map((o) => (typeof o === 'object' && o !== null ? o : { value: o, label: String(o) }));
  }

  // segmented({ options: [{ value, label, icon }], value, onChange(value), size: 'sm', block, ariaLabel })
  function segmented(opts = {}) {
    const options = normOptions(opts.options);
    let current = opts.value ?? (options[0] && options[0].value);
    const root = el('div.seg', {
      role: 'radiogroup',
      'aria-label': opts.ariaLabel,
      class: [opts.size === 'sm' ? 'seg-sm' : '', opts.block ? 'seg-block' : ''],
    });
    const buttons = options.map((o) => {
      const b = el('button', { type: 'button', role: 'radio', title: o.title, disabled: !!o.disabled || !!opts.disabled, dataset: { value: String(o.value) } },
        o.icon ? icon(o.icon, 14) : null, o.label != null ? el('span', { text: o.label }) : null);
      if (!o.label && o.title) b.setAttribute('aria-label', o.title);
      b.addEventListener('click', () => set(o.value, true));
      return b;
    });
    append(root, buttons);

    function sync() {
      buttons.forEach((b, i) => {
        const on = options[i].value === current;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    }

    function set(v, fromUser) {
      if (v === current && fromUser) return;
      current = v;
      sync();
      if (fromUser && opts.onChange) opts.onChange(v);
    }

    root.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const enabled = buttons.filter((b) => !b.disabled);
      const i = enabled.findIndex((b) => b.dataset.value === String(current));
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const next = enabled[(i + d + enabled.length) % enabled.length];
      if (!next) return;
      next.focus();
      set(options[buttons.indexOf(next)].value, true);
    });

    Object.defineProperty(root, 'value', { get: () => current, set: (v) => set(v, false) });
    sync();
    return root;
  }

  // ---------- 浮层定位 ----------

  function anchorRect(anchor) {
    if (anchor instanceof Element) return anchor.getBoundingClientRect();
    if (anchor && typeof anchor.x === 'number') return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    return { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 3, bottom: innerHeight / 3, width: 0, height: 0 };
  }

  function place(pop, anchor, opts = {}) {
    const margin = 8;
    const offset = opts.offset ?? 6;
    const r = anchorRect(anchor);
    pop.style.left = '0px';
    pop.style.top = '0px';
    pop.style.maxHeight = '';
    if (opts.minWidth) pop.style.minWidth = Math.round(opts.minWidth) + 'px';
    const w = pop.offsetWidth;
    let h = pop.offsetHeight;
    const vw = innerWidth;
    const vh = innerHeight;
    let side = opts.placement === 'top' ? 'top' : 'bottom';
    const below = vh - r.bottom - offset - margin;
    const above = r.top - offset - margin;
    if (side === 'bottom' && h > below && above > below) side = 'top';
    else if (side === 'top' && h > above && below > above) side = 'bottom';
    const room = side === 'bottom' ? below : above;
    if (h > room) {
      pop.style.maxHeight = Math.max(120, room) + 'px';
      h = pop.offsetHeight;
    }
    let top = side === 'bottom' ? r.bottom + offset : r.top - offset - h;
    let left = opts.align === 'end' ? r.right - w : opts.align === 'center' ? r.left + r.width / 2 - w / 2 : r.left;
    left = Math.min(Math.max(margin, left), vw - w - margin);
    top = Math.min(Math.max(margin, top), vh - h - margin);
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    pop.dataset.side = side;
    const ox = opts.align === 'end' ? 'right' : opts.align === 'center' ? 'center' : 'left';
    pop.style.setProperty('--pop-origin', `${side === 'bottom' ? 'top' : 'bottom'} ${ox}`);
  }

  // 点外面、Esc、窗口失焦、改大小时关掉浮层
  function dismissible(pop, anchor, close, opts = {}) {
    const onDown = (e) => {
      if (pop.contains(e.target)) return;
      // 点锚点本身交给锚点的点击处理（再点一次就是收起）
      if (anchor instanceof Element && anchor.contains(e.target)) return;
      close({});
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        close({ restoreFocus: true });
      }
    };
    const onBlur = () => close({});
    const onResize = () => close({});
    const onScroll = (e) => {
      if (pop.contains(e.target)) return;
      if (opts.closeOnScroll !== false) close({});
    };
    // 捕获阶段注册：打开浮层的那次点击已经过了 document 的捕获阶段，不会把自己关掉
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    doc.addEventListener('scroll', onScroll, true);
    return () => {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      doc.removeEventListener('scroll', onScroll, true);
    };
  }

  // popover(anchor, content, { placement, align, className, onClose }) → { el, close }
  const openPopovers = new WeakMap();

  function popover(anchor, content, opts = {}) {
    const prev = anchor instanceof Element && openPopovers.get(anchor);
    if (prev && prev.isOpen()) {
      prev.close();
      return prev;
    }
    const pop = el('div.popover', { class: opts.className, role: opts.role || 'dialog' }, content);
    doc.body.appendChild(pop);
    place(pop, anchor, opts);
    let closed = false;
    let undo = null;
    function close(how = {}) {
      if (closed) return;
      closed = true;
      if (undo) undo();
      pop.remove();
      if (how.restoreFocus && anchor instanceof HTMLElement) anchor.focus();
      if (opts.onClose) opts.onClose();
    }
    undo = dismissible(pop, anchor, close, opts);
    const api = { el: pop, close, isOpen: () => !closed, reposition: () => place(pop, anchor, opts) };
    if (anchor instanceof Element) openPopovers.set(anchor, api);
    return api;
  }

  // ---------- 列表键盘导航 ----------

  // listNav(container, { itemSelector, keyTarget, onOpen(item, e), onSelect(item), selectOnHover, openOnClick, loop, initial })
  function listNav(container, opts = {}) {
    const itemSelector = opts.itemSelector || '.list-item, .menu-item, .palette-item, [data-nav-item]';
    const keyTarget = opts.keyTarget || container;
    const cls = opts.selectedClass || 'is-selected';
    let current = null;
    let seq = 0;

    if (keyTarget === container && !container.hasAttribute('tabindex')) container.tabIndex = 0;

    function items() {
      return Array.from(container.querySelectorAll(itemSelector)).filter(
        (n) => !n.hidden && n.getAttribute('aria-disabled') !== 'true' && !n.classList.contains('is-disabled') && n.offsetParent !== null
      );
    }

    function scrollIntoView(item) {
      const sc = scrollParent(item);
      if (!sc) return;
      const ir = item.getBoundingClientRect();
      if (item === items()[0]) {
        sc.scrollTop = 0; // 回到第一项时把上面的分组标题也露出来
        return;
      }
      const sr = sc.getBoundingClientRect();
      const pad = 8;
      if (ir.top < sr.top + pad) sc.scrollTop -= sr.top + pad - ir.top;
      else if (ir.bottom > sr.bottom - pad) sc.scrollTop += ir.bottom - (sr.bottom - pad);
    }

    function select(target, o = {}) {
      const list = items();
      const item = typeof target === 'number' ? list[target] : target;
      if (current && current !== item) {
        current.classList.remove(cls);
        current.setAttribute('aria-selected', 'false');
      }
      current = item || null;
      if (!current) {
        if (keyTarget !== container) keyTarget.removeAttribute('aria-activedescendant');
        return null;
      }
      current.classList.add(cls);
      current.setAttribute('aria-selected', 'true');
      if (keyTarget !== container) {
        if (!current.id) current.id = 'ui-opt-' + ++seq + '-' + Math.random().toString(36).slice(2, 7);
        keyTarget.setAttribute('aria-activedescendant', current.id);
      }
      if (o.scroll !== false) scrollIntoView(current);
      if (opts.onSelect && !o.silent) opts.onSelect(current);
      return current;
    }

    function move(delta) {
      const list = items();
      if (!list.length) return null;
      let i = current ? list.indexOf(current) : -1;
      if (i < 0) i = delta > 0 ? -1 : list.length;
      let n = i + delta;
      if (opts.loop) n = (n + list.length) % list.length;
      else n = Math.max(0, Math.min(list.length - 1, n));
      return select(list[n]);
    }

    function open(e) {
      if (!current) return;
      if (opts.onOpen) opts.onOpen(current, e);
      else current.click();
    }

    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const inInput = keyTarget !== container || isTyping(e.target);
      const ctrlNav = isMac && e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === 'ArrowDown' || (ctrlNav && (e.key === 'n' || e.key === 'j'))) {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp' || (ctrlNav && (e.key === 'p' || e.key === 'k'))) {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        move(8);
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        move(-8);
      } else if (!inInput && e.key === 'Home') {
        e.preventDefault();
        select(0);
      } else if (!inInput && e.key === 'End') {
        e.preventDefault();
        const list = items();
        select(list[list.length - 1]);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        if (!current) return;
        if (!inInput && e.target !== container && e.target.closest && e.target.closest('button, a, input, textarea, select') && !e.target.matches(itemSelector)) return;
        e.preventDefault();
        open(e);
      }
    };

    let lastPointer = null;
    const onMove = (e) => {
      // 只在鼠标真的动了才跟着选，避免列表滚动或重画时选中项乱跳
      if (lastPointer && lastPointer.x === e.clientX && lastPointer.y === e.clientY) return;
      lastPointer = { x: e.clientX, y: e.clientY };
      const item = e.target.closest && e.target.closest(itemSelector);
      if (item && container.contains(item) && item !== current && items().includes(item)) select(item, { scroll: false });
    };
    const onClick = (e) => {
      const item = e.target.closest && e.target.closest(itemSelector);
      if (!item || !container.contains(item) || !items().includes(item)) return;
      if (opts.selectOnClick !== false) select(item, { scroll: false });
      if (opts.openOnClick) {
        if (opts.onOpen) opts.onOpen(item, e);
      }
    };

    keyTarget.addEventListener('keydown', onKey);
    container.addEventListener('click', onClick);
    if (opts.selectOnHover) container.addEventListener('mousemove', onMove);

    if (opts.initial !== -1 && opts.initial !== null) {
      const list = items();
      if (list.length) select(list[Math.min(opts.initial || 0, list.length - 1)], { scroll: false, silent: true });
    }

    return {
      select,
      move,
      open,
      items,
      selected: () => current,
      // 列表重画后调用：保持原来的项（按 data-id 或同一节点），找不到就选第一个
      refresh(keepId) {
        const list = items();
        let next = null;
        if (current && current.isConnected && list.includes(current)) next = current;
        else if (keepId != null) next = list.find((n) => n.dataset.id === String(keepId)) || null;
        if (!next) next = list[0] || null;
        current = null;
        list.forEach((n) => n.classList.remove(cls));
        return select(next, { scroll: true, silent: true });
      },
      destroy() {
        keyTarget.removeEventListener('keydown', onKey);
        container.removeEventListener('click', onClick);
        container.removeEventListener('mousemove', onMove);
      },
    };
  }

  function scrollParent(node) {
    let n = node.parentElement;
    while (n && n !== doc.body) {
      const s = getComputedStyle(n).overflowY;
      if ((s === 'auto' || s === 'scroll') && n.scrollHeight > n.clientHeight) return n;
      n = n.parentElement;
    }
    return null;
  }

  // ---------- 模糊匹配 ----------

  const BOUNDARY = /[\s\-_./\\:·，。、（）()【】「」]/;

  function matchToken(tok, text, lower) {
    const idx = lower.indexOf(tok);
    if (idx >= 0) {
      const atStart = idx === 0 || BOUNDARY.test(text[idx - 1]);
      const indices = [];
      for (let i = 0; i < tok.length; i++) indices.push(idx + i);
      return { score: 100 + tok.length * 12 + (idx === 0 ? 40 : atStart ? 24 : 0) - Math.min(idx, 30), indices };
    }
    // 子序列：字母要按顺序出现
    let score = 0;
    let ti = 0;
    let prev = -2;
    const indices = [];
    for (let i = 0; i < lower.length && ti < tok.length; i++) {
      if (lower[i] !== tok[ti]) continue;
      let s = 10;
      if (i === prev + 1) s += 14;
      if (i === 0 || BOUNDARY.test(text[i - 1])) s += 16;
      if (prev >= 0) s -= Math.min(i - prev - 1, 8);
      score += s;
      indices.push(i);
      prev = i;
      ti++;
    }
    if (ti < tok.length) return null;
    return { score, indices };
  }

  // fuzzy('proj 会', '项目 Project 会议') → { score, indices } 或 null（没匹配上）
  function fuzzy(query, text) {
    const q = String(query || '').trim().toLowerCase();
    const t = String(text || '');
    if (!q) return { score: 0, indices: [] };
    const lower = t.toLowerCase();
    let score = 0;
    const all = new Set();
    for (const tok of q.split(/\s+/)) {
      const m = matchToken(tok, t, lower);
      if (!m) return null;
      score += m.score;
      m.indices.forEach((i) => all.add(i));
    }
    score -= Math.min(t.length, 60) * 0.2;
    return { score, indices: Array.from(all).sort((a, b) => a - b) };
  }

  // 把命中的字标出来（<span class="hl">），只用文本节点
  function highlight(text, indices) {
    const frag = doc.createDocumentFragment();
    const s = String(text || '');
    if (!indices || !indices.length) {
      frag.appendChild(doc.createTextNode(s));
      return frag;
    }
    const set = new Set(indices);
    let buf = '';
    let on = false;
    const flush = () => {
      if (!buf) return;
      frag.appendChild(on ? el('span.hl', { text: buf }) : doc.createTextNode(buf));
      buf = '';
    };
    for (let i = 0; i < s.length; i++) {
      const hit = set.has(i);
      if (hit !== on) {
        flush();
        on = hit;
      }
      buf += s[i];
    }
    flush();
    return frag;
  }

  // ---------- 列表行 ----------

  // listItem({ id, icon, tint, iconVariant, title, subtitle, accessories: [文字 | { text, icon, kbd, tag, tint, dot }], twoLine, selected, onClick, titleIndices })
  function accessoryNode(a) {
    if (a == null || a === false) return null;
    if (a instanceof Node) return a;
    if (typeof a !== 'object') return el('span', { text: String(a) });
    if (a.kbd) return kbd(a.kbd, { size: 'sm' });
    if (a.tag) return el('span.tag', { text: a.tag, dataset: a.tint ? { tint: a.tint } : undefined, class: a.dot ? 'tag-dot' : '' });
    if (a.dot) return el('span.dot', { class: 'dot-' + a.dot, title: a.title });
    return el('span', { title: a.title, style: a.color ? { color: a.color } : undefined, class: 'li-acc' },
      a.icon ? icon(a.icon, 14) : null, a.text != null ? ' ' + a.text : null);
  }

  function listItem(o = {}) {
    const lead = o.icon ? (o.tint ? iconBox(o.icon, o.tint, { variant: o.iconVariant }) : icon(o.icon, 16)) : o.lead || null;
    const title = el('span.li-title', {}, o.titleIndices ? highlight(o.title, o.titleIndices) : o.title);
    const sub = o.subtitle != null && o.subtitle !== '' ? el('span.li-subtitle', { text: o.subtitle }) : null;
    const acc = (o.accessories || []).map(accessoryNode).filter(Boolean);
    const node = el(o.tag || 'div', {
      class: ['list-item', o.twoLine ? 'two-line' : '', o.compact ? 'compact' : '', o.selected ? 'is-selected' : '', o.className],
      role: o.role || 'option',
      'aria-selected': o.selected ? 'true' : 'false',
      dataset: o.id != null ? { id: String(o.id) } : undefined,
      title: o.tooltip,
      onClick: o.onClick,
    }, lead, el('span.li-main', {}, title, sub), acc.length ? el('span.li-accessories', {}, acc) : null);
    return node;
  }

  // steps({ steps: ['录声纹', '连接 AI', …], current: 0 }) → <ol class="steps">，用 .set(i) 切换
  function steps(o = {}) {
    const root = el('ol.steps', { 'aria-label': o.ariaLabel || t('步骤') });
    const items = (o.steps || []).map((label, i) =>
      el('li.step', {}, el('span.step-dot'), el('span.step-label.truncate', { text: label })));
    append(root, items);
    root.set = (current) => {
      items.forEach((li, i) => {
        li.classList.toggle('is-done', i < current);
        li.classList.toggle('is-current', i === current);
        li.setAttribute('aria-current', i === current ? 'step' : 'false');
        const dot = li.firstChild;
        clear(dot);
        if (i < current) dot.appendChild(icon('check', 12));
        else dot.textContent = String(i + 1);
      });
    };
    root.set(o.current || 0);
    return root;
  }

  function emptyState(o = {}) {
    return el('div.empty', {},
      o.icon ? el('span.empty-icon', {}, icon(o.icon, 22)) : null,
      o.title ? el('div.empty-title', { text: o.title }) : null,
      o.description ? el('div.empty-desc', { text: o.description }) : null,
      o.action ? el('button.btn', { type: 'button', class: o.action.primary ? 'btn-primary' : '', onClick: o.action.onClick },
        o.action.icon ? icon(o.action.icon, 16) : null, el('span', { text: o.action.label })) : null);
  }

  // ---------- 菜单 ----------

  let openMenu = null;

  // menu(anchor, items, { align, placement, searchable, placeholder, minWidth, onClose, onSelect })
  // items: { label, icon, tint, description, kbd, hint, checked, danger, disabled, onSelect } | 'sep' | { section: '标题' }
  function menu(anchor, items, opts = {}) {
    if (openMenu && !opts.nested) {
      const same = openMenu.anchor === anchor;
      const prev = openMenu;
      prev.close();
      // 同一个锚点再点一次：收起
      if (same && anchor instanceof Element) return prev;
    }
    const root = el('div.menu', { role: 'menu', tabindex: '-1', class: opts.className });
    const list = el('div.menu-list');
    let search = null;
    if (opts.searchable) {
      search = el('input', { type: 'text', placeholder: opts.placeholder || t('搜索…'), spellcheck: false, 'aria-label': opts.placeholder || t('搜索') });
      root.appendChild(el('div.menu-search', {}, icon('search', 14), search));
    }
    root.appendChild(list);
    let data = items || [];
    let nav = null;

    function render() {
      clear(list);
      const q = search ? search.value.trim() : '';
      let shown = 0;
      let pendingSection = null;
      let lastWasSep = true;
      for (const it of data) {
        if (it === 'sep' || (it && it.type === 'sep')) {
          if (!q && !lastWasSep) {
            list.appendChild(el('div.menu-sep', { role: 'separator' }));
            lastWasSep = true;
          }
          continue;
        }
        if (it && it.section) {
          pendingSection = el('div.menu-label', { text: it.section });
          continue;
        }
        let indices = null;
        if (q) {
          const m = fuzzy(q, it.label + ' ' + (it.keywords || []).join(' '));
          if (!m) continue;
          indices = m.indices.filter((i) => i < String(it.label).length);
        }
        if (pendingSection) {
          list.appendChild(pendingSection);
          pendingSection = null;
        }
        const lead = it.tint && !it.icon ? el('span.menu-swatch', { dataset: { tint: it.tint } })
          : it.icon ? (it.tint ? iconBox(it.icon, it.tint, { size: 'sm' }) : icon(it.icon, 16)) : null;
        const end = [];
        if (it.hint) end.push(el('span', { text: it.hint }));
        if (it.kbd) end.push(kbd(it.kbd, { size: 'sm' }));
        if (it.checked) end.push(icon('check', 14));
        const row = el('div.menu-item', {
          role: it.checked != null ? 'menuitemradio' : 'menuitem',
          'aria-checked': it.checked != null ? String(!!it.checked) : null,
          'aria-disabled': it.disabled ? 'true' : null,
          class: it.danger ? 'is-danger' : '',
        }, lead, el('span.menu-item-label', {}, indices ? highlight(it.label, indices) : it.label),
          it.description ? el('span.menu-item-desc', { text: it.description }) : null,
          end.length ? el('span.menu-item-end', {}, end) : null);
        row._item = it;
        list.appendChild(row);
        shown++;
        lastWasSep = false;
      }
      const last = list.lastElementChild;
      if (last && last.classList.contains('menu-sep')) last.remove();
      if (!shown) list.appendChild(el('div.menu-empty', { text: q ? t('没有匹配的选项') : t('没有选项') }));
      if (nav) {
        const checked = Array.from(list.querySelectorAll('.menu-item')).find((r) => r._item.checked);
        nav.refresh();
        if (checked && !q) nav.select(checked, { silent: true });
      }
    }

    function choose(row) {
      const it = row && row._item;
      if (!it || it.disabled) return;
      close({ restoreFocus: true });
      if (it.onSelect) it.onSelect(it);
      if (opts.onSelect) opts.onSelect(it);
    }

    doc.body.appendChild(root);
    nav = listNav(list, {
      itemSelector: '.menu-item',
      keyTarget: search || root,
      selectOnHover: true,
      openOnClick: true,
      loop: true,
      initial: -1,
      onOpen: (row) => choose(row),
    });
    render();
    if (search) search.addEventListener('input', () => {
      render();
      nav.select(0, { silent: true });
    });

    if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'true');
    place(root, anchor, { placement: opts.placement, align: opts.align, minWidth: opts.minWidth, offset: opts.offset });
    let closed = false;
    let undo = null;
    function close(how = {}) {
      if (closed) return;
      closed = true;
      if (undo) undo();
      nav.destroy();
      root.remove();
      if (anchor instanceof Element) anchor.setAttribute('aria-expanded', 'false');
      if (openMenu && openMenu.el === root) openMenu = null;
      if (how.restoreFocus && anchor instanceof HTMLElement) anchor.focus({ preventScroll: true });
      if (opts.onClose) opts.onClose();
    }
    undo = dismissible(root, anchor, close, opts);
    (search || root).focus({ preventScroll: true });
    if (!search && !nav.selected()) nav.select(0, { silent: true, scroll: false });
    const api = { el: root, anchor, close, isOpen: () => !closed, update(next) { data = next || []; render(); } };
    if (!opts.nested) openMenu = api;
    return api;
  }

  // select({ options | groups: [{ title, options }], value, onChange(value, option), placeholder, searchable, block, disabled })
  function select(opts = {}) {
    let groups = opts.groups || [{ title: null, options: opts.options || [] }];
    let current = opts.value;
    let open = null;
    const label = el('span.select-label');
    const lead = el('span', { style: 'display:contents' });
    const btn = el('button.select', {
      type: 'button',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      disabled: !!opts.disabled,
      class: opts.block ? 'select-block' : '',
      'aria-label': opts.ariaLabel,
      style: opts.width ? { width: typeof opts.width === 'number' ? opts.width + 'px' : opts.width } : undefined,
    }, lead, label, icon('chevrons-up-down', 14));

    function flat() {
      return groups.flatMap((g) => normOptions(g.options));
    }

    function sync() {
      const o = flat().find((x) => x.value === current);
      clear(lead);
      if (o && o.icon) lead.appendChild(o.tint ? iconBox(o.icon, o.tint, { size: 'sm' }) : icon(o.icon, 14));
      else if (o && o.tint) lead.appendChild(el('span.menu-swatch', { dataset: { tint: o.tint } }));
      label.textContent = o ? o.label : opts.placeholder || t('请选择');
      btn.classList.toggle('is-placeholder', !o);
    }

    function show() {
      if (open) return open.close();
      const items = [];
      for (const g of groups) {
        if (g.title) items.push({ section: g.title });
        for (const o of normOptions(g.options)) {
          items.push({
            label: o.label, icon: o.icon, tint: o.tint, description: o.description, disabled: o.disabled, keywords: o.keywords,
            checked: o.value === current,
            onSelect: () => {
              const changed = o.value !== current;
              current = o.value;
              sync();
              if (changed && opts.onChange) opts.onChange(o.value, o);
            },
          });
        }
      }
      const count = items.filter((i) => !i.section).length;
      open = menu(btn, items, {
        minWidth: btn.getBoundingClientRect().width,
        searchable: opts.searchable ?? count > 8,
        placeholder: opts.searchPlaceholder,
        onClose: () => {
          open = null;
        },
      });
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      show();
    });
    btn.addEventListener('keydown', (e) => {
      if (['ArrowDown', 'ArrowUp'].includes(e.key) && !open) {
        e.preventDefault();
        show();
      }
    });
    Object.defineProperty(btn, 'value', { get: () => current, set: (v) => { current = v; sync(); } });
    btn.setOptions = (options, value) => {
      groups = Array.isArray(options) && options[0] && options[0].options ? options : [{ title: null, options }];
      if (value !== undefined) current = value;
      sync();
    };
    sync();
    return btn;
  }

  // ---------- 提示气泡 ----------

  let tipNode = null;
  let tipTimer = 0;
  let tipAnchor = null;
  let tipWatch = 0;

  function hideTip() {
    clearTimeout(tipTimer);
    cancelAnimationFrame(tipWatch);
    if (tipNode) tipNode.remove();
    tipNode = null;
    tipAnchor = null;
  }

  function showTip(anchor, content, opts = {}) {
    hideTip();
    const c = typeof content === 'function' ? content(anchor) : content;
    if (c == null || c === '') return;
    tipNode = el('div.tip', { role: 'tooltip' });
    if (typeof c === 'object' && !(c instanceof Node) && (c.title || c.text)) {
      if (c.title) tipNode.appendChild(el('span.tip-title', { text: c.title }));
      if (c.text) tipNode.appendChild(doc.createTextNode(c.text));
    } else {
      append(tipNode, [c]);
    }
    doc.body.appendChild(tipNode);
    place(tipNode, anchor, { placement: opts.placement || 'top', align: 'center', offset: 6 });
    tipAnchor = anchor;
    const watch = () => {
      if (!tipAnchor || !tipAnchor.isConnected) return hideTip();
      tipWatch = requestAnimationFrame(watch);
    };
    tipWatch = requestAnimationFrame(watch);
  }

  // tip(el, '文字' | { title, text } | (el) => 内容, { delay, placement }) → 解绑函数
  function tip(target, content, opts = {}) {
    const delay = opts.delay ?? 250;
    const enter = () => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(target, content, opts), delay);
    };
    const leave = () => hideTip();
    target.addEventListener('mouseenter', enter);
    target.addEventListener('mouseleave', leave);
    target.addEventListener('focus', enter);
    target.addEventListener('blur', leave);
    target.addEventListener('mousedown', leave);
    return () => {
      target.removeEventListener('mouseenter', enter);
      target.removeEventListener('mouseleave', leave);
      target.removeEventListener('focus', enter);
      target.removeEventListener('blur', leave);
      target.removeEventListener('mousedown', leave);
      if (tipAnchor === target) hideTip();
    };
  }

  // 委托版：列表经常重画时用。tipDelegate(root, '.term', (termEl) => ({ title, text }))
  function tipDelegate(root, selector, content, opts = {}) {
    const delay = opts.delay ?? 250;
    let over = null;
    const onOver = (e) => {
      const t = e.target.closest && e.target.closest(selector);
      if (!t || !root.contains(t) || t === over) return;
      over = t;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => showTip(t, content, opts), delay);
    };
    const onOut = (e) => {
      if (!over) return;
      if (e.relatedTarget && over.contains(e.relatedTarget)) return;
      over = null;
      hideTip();
    };
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    doc.addEventListener('scroll', hideTip, true);
    return () => {
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      doc.removeEventListener('scroll', hideTip, true);
      hideTip();
    };
  }

  // ---------- toast ----------

  let toastHost = null;
  const TOAST_ICON = { success: 'circle-check', error: 'circle-alert', warning: 'triangle-alert', info: 'info' };

  // toast('已复制') 或 toast({ title, message, type: 'success'|'error'|'warning'|'info'|'loading', duration, action: { label, onClick } })
  // → { el, update(opts), close() }
  function toast(input) {
    if (!toastHost || !toastHost.isConnected) {
      toastHost = el('div.toast-host', { 'aria-live': 'polite', role: 'status' });
      doc.body.appendChild(toastHost);
    }
    let o = typeof input === 'string' ? { title: input } : { ...input };
    const node = el('div.toast');
    let timer = 0;
    let closed = false;

    function render() {
      clear(node);
      node.dataset.type = o.type || 'default';
      if (o.type === 'loading') node.appendChild(spinner(14));
      else if (TOAST_ICON[o.type]) node.appendChild(icon(TOAST_ICON[o.type], 16));
      node.appendChild(el('div.toast-text', {},
        el('div.toast-title', { text: o.title || '' }),
        o.message ? el('div.toast-message', { text: o.message }) : null));
      if (o.action) {
        node.appendChild(el('button.btn.btn-sm', {
          type: 'button',
          onClick: () => {
            if (o.action.onClick) o.action.onClick();
            close();
          },
        }, o.action.label));
      }
      if (o.type === 'error' || o.closable) {
        node.appendChild(el('button.btn.btn-ghost.btn-icon.btn-sm', { type: 'button', 'aria-label': t('关闭'), onClick: () => close() }, icon('x', 14)));
      }
      arm();
    }

    function arm() {
      clearTimeout(timer);
      const d = o.duration ?? (o.type === 'loading' ? 0 : o.type === 'error' ? 6000 : o.action ? 5000 : 2600);
      if (d > 0) timer = setTimeout(close, d);
    }

    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 160);
    }

    node.addEventListener('mouseenter', () => clearTimeout(timer));
    node.addEventListener('mouseleave', arm);
    render();
    toastHost.appendChild(node);
    const live = toastHost.querySelectorAll('.toast:not(.is-leaving)');
    if (live.length > 3) live[0].remove();
    return {
      el: node,
      close,
      update(next) {
        if (closed) return;
        o = typeof next === 'string' ? { ...o, title: next } : { ...o, ...next };
        render();
      },
    };
  }

  // ---------- 模态框 ----------

  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trapFocus(container, e) {
    if (e.key !== 'Tab') return;
    const f = Array.from(container.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && doc.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!container.contains(doc.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }

  // modal({ title, description, body, actions: [{ label, kind: 'primary'|'danger'|'ghost', icon, kbd, onClick(ctx) }], width, dismissible, onClose, initialFocus })
  // onClick 返回 false 不关；返回 Promise 时按钮转圈，结果为 false 也不关。→ { el, close }
  function modal(o = {}) {
    const prevFocus = doc.activeElement;
    const titleId = 'ui-modal-' + Math.random().toString(36).slice(2, 8);
    const body = o.body == null ? null : typeof o.body === 'string' ? el('p', { text: o.body }) : o.body;
    const footer = el('div.modal-footer');
    const box = el('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, style: o.width ? { '--modal-w': o.width + 'px' } : undefined },
      el('div.modal-header', {},
        el('h2.modal-title', { id: titleId, text: o.title || '' }),
        o.description ? el('p.modal-desc', { text: o.description }) : null),
      body ? el('div.modal-body', {}, body) : null,
      footer);
    const backdrop = el('div.modal-backdrop', {}, box);
    let closed = false;
    let primary = null;
    const ctx = { close: () => close('action') };

    for (const a of o.actions || []) {
      if (a === 'spacer') {
        footer.appendChild(el('span.spacer'));
        continue;
      }
      const cls = a.kind === 'primary' ? 'btn-primary' : a.kind === 'danger' ? 'btn-danger-solid' : a.kind === 'ghost' ? 'btn-ghost' : '';
      const b = el('button.btn', { type: 'button', class: cls },
        a.icon ? icon(a.icon, 16) : null, el('span', { text: a.label }), a.kbd ? kbd(a.kbd, { size: 'sm' }) : null);
      b.addEventListener('click', async () => {
        if (!a.onClick) return close('action');
        let r = a.onClick(ctx);
        if (r && typeof r.then === 'function') {
          b.classList.add('is-loading');
          try {
            r = await r;
          } catch (err) {
            r = false;
            console.error(err);
          } finally {
            b.classList.remove('is-loading');
          }
        }
        if (r !== false) close('action');
      });
      if (a.kind === 'primary' || (a.kind === 'danger' && !primary)) primary = b;
      footer.appendChild(b);
    }
    if (!footer.children.length) footer.remove();

    function onKey(e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' && o.dismissible !== false) {
        e.preventDefault();
        e.stopPropagation();
        close('escape');
      } else if (e.key === 'Enter' && primary && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        primary.click();
      } else {
        trapFocus(box, e);
      }
    }

    function close(reason) {
      if (closed) return;
      closed = true;
      doc.removeEventListener('keydown', onKey, true);
      backdrop.classList.remove('is-open');
      setTimeout(() => backdrop.remove(), 180);
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
      if (o.onClose) o.onClose(reason);
    }

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop && o.dismissible !== false) close('backdrop');
    });
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(backdrop);
    requestAnimationFrame(() => {
      if (!closed) backdrop.classList.add('is-open');
    });
    const focusTarget = (o.initialFocus && box.querySelector(o.initialFocus)) || box.querySelector('input, textarea, select') || primary || box.querySelector(FOCUSABLE);
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    return { el: box, close: () => close('api') };
  }

  // confirm({ title, message, okLabel, cancelLabel, danger }) → Promise<boolean>
  function confirm(o = {}) {
    return new Promise((resolve) => {
      let result = false;
      modal({
        title: o.title || t('确定吗？'),
        description: o.message,
        width: o.width || 400,
        actions: [
          { label: o.cancelLabel || t('取消') },
          { label: o.okLabel || t('确定'), kind: o.danger ? 'danger' : 'primary', onClick: () => { result = true; } },
        ],
        onClose: () => resolve(result),
      });
    });
  }

  // ---------- 命令面板 ----------

  let openPalette = null;

  // commandPalette({
  //   groups: [{ title, items: [{ id, title, subtitle, snippet, icon, tint, accessory, kbd, keywords, actions, actionLabel, onSelect, keepOpen }] }],
  //   onSelect(item, group), source: async (query) => groups（主进程搜索，结果不再本地过滤）,
  //   placeholder, context: { icon, tint, label }, actionLabel: '打开', emptyText, query, onClose,
  //   actionsKey: 'CommandOrControl+K'（在面板里按它弹出当前项的操作，跟着打开面板的快捷键走） })
  // → { el, input, close, setGroups(groups), refresh() }
  function commandPalette(o = {}) {
    if (openPalette) openPalette.close();
    const prevFocus = doc.activeElement;
    let staticGroups = o.groups || [];
    let remoteGroups = [];
    let remoteToken = 0;
    let remoteTimer = 0;
    let rows = [];
    let closed = false;
    let actionsMenu = null;

    const listId = 'ui-palette-' + Math.random().toString(36).slice(2, 8);
    const input = el('input', {
      type: 'text',
      placeholder: o.placeholder || t('搜索项目、会议、待办和命令'),
      spellcheck: false,
      autocomplete: 'off',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': listId,
      'aria-autocomplete': 'list',
      value: o.query || '',
    });
    const busy = spinner(14);
    busy.hidden = true;
    const list = el('div.palette-list', { id: listId, role: 'listbox' });
    const primaryLabel = el('span', { text: o.actionLabel || t('打开') });
    const primaryBtn = el('button.action', { type: 'button' }, primaryLabel, kbd('Enter', { size: 'sm' }));
    const actionsKey = o.actionsKey === undefined ? 'CommandOrControl+K' : o.actionsKey;
    const actionsBtn = el('button.action', { type: 'button' }, el('span', { text: t('操作') }), actionsKey ? kbd(actionsKey, { size: 'sm' }) : null);
    const ctxInfo = o.context || { icon: 'command', tint: 'indigo', label: t('会议字幕') };
    const footer = el('div.action-bar', {},
      el('div.action-bar-context', {}, ctxInfo.icon ? iconBox(ctxInfo.icon, ctxInfo.tint || 'indigo', { size: 'sm' }) : null, el('span.truncate', { text: ctxInfo.label || '' })),
      primaryBtn, el('span.action-sep'), actionsBtn);
    const box = el('div.palette', { role: 'dialog', 'aria-modal': 'true', 'aria-label': t('命令面板') },
      el('div.palette-search', {}, icon('search', 18), input, busy),
      list, footer);
    const backdrop = el('div.palette-backdrop', {}, box);

    const nav = listNav(list, {
      itemSelector: '.palette-item',
      keyTarget: input,
      selectOnHover: true,
      openOnClick: true,
      initial: -1,
      onOpen: (row) => choose(row),
      onSelect: () => syncFooter(),
    });

    function groupsToShow() {
      const q = input.value.trim();
      const out = [];
      for (const g of staticGroups) {
        let items = g.items || [];
        if (q) {
          items = items
            .map((it) => {
              const mt = fuzzy(q, it.title);
              const ms = !mt && it.subtitle ? fuzzy(q, it.subtitle) : null;
              const mk = !mt && !ms && it.keywords ? fuzzy(q, [].concat(it.keywords).join(' ')) : null;
              const m = mt || ms || mk;
              if (!m) return null;
              return { it, score: m.score - (mt ? 0 : 30), indices: mt ? mt.indices : null };
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);
        } else {
          items = items.filter((it) => !it.searchOnly).map((it) => ({ it, indices: null }));
        }
        if (items.length) out.push({ group: g, items });
      }
      for (const g of remoteGroups) {
        const items = (g.items || []).map((it) => {
          const m = q ? fuzzy(q, it.title) : null;
          return { it, indices: m ? m.indices : null };
        });
        if (items.length) out.push({ group: g, items });
      }
      return out;
    }

    function render() {
      const keepId = nav.selected() ? nav.selected().dataset.id : null;
      clear(list);
      rows = [];
      const shown = groupsToShow();
      for (const { group, items } of shown) {
        if (group.title) list.appendChild(el('div.palette-section', { text: group.title, role: 'presentation' }));
        for (const { it, indices } of items) {
          const lead = it.icon ? iconBox(it.icon, it.tint || 'gray', { variant: it.iconVariant }) : null;
          const titleNode = el('span.li-title', {}, indices ? highlight(it.title, indices) : it.title);
          const sub = it.subtitle ? el('span.li-subtitle', { text: it.subtitle }) : null;
          const main = it.snippet
            ? el('span.li-main', {}, el('span.li-line', {}, titleNode, sub), el('span.palette-item-snippet', { text: it.snippet }))
            : el('span.li-main', {}, titleNode, sub);
          const acc = [];
          if (it.accessory) acc.push(el('span', { text: it.accessory }));
          if (it.kbd) acc.push(kbd(it.kbd, { size: 'sm' }));
          const row = el('div.palette-item', {
            role: 'option',
            'aria-selected': 'false',
            class: it.snippet ? 'has-snippet' : '',
            dataset: { id: String(it.id ?? it.title) },
          }, lead, main, acc.length ? el('span.li-accessories', {}, acc) : null);
          row._item = it;
          row._group = group;
          list.appendChild(row);
          rows.push(row);
        }
      }
      if (!rows.length) {
        const q = input.value.trim();
        const busyNow = !busy.hidden;
        list.appendChild(el('div.palette-empty', {},
          busyNow ? spinner(16) : icon('search', 22),
          q ? el('div', {}, busyNow ? t('正在搜索「') : t('没有找到「'), el('strong', { text: q }), t('」')) : el('div', { text: t('没有可用的命令') }),
          !busyNow && o.emptyText ? el('div.text-sm', { text: o.emptyText }) : null));
      }
      nav.refresh(keepId);
      if (!input.value.trim() && rows[0] && (!keepId || !rows.some((r) => r.dataset.id === keepId))) nav.select(rows[0], { silent: true });
      list.scrollTop = nav.selected() === rows[0] ? 0 : list.scrollTop;
      syncFooter();
    }

    function syncFooter() {
      const row = nav.selected();
      const it = row && row._item;
      primaryLabel.textContent = (it && it.actionLabel) || o.actionLabel || t('打开');
      primaryBtn.disabled = !it;
      actionsBtn.disabled = !(it && it.actions && it.actions.length);
    }

    function choose(row) {
      const it = row && row._item;
      if (!it) return;
      if (!it.keepOpen) close();
      if (it.onSelect) it.onSelect(it, row._group);
      else if (o.onSelect) o.onSelect(it, row._group);
    }

    function showActions() {
      const row = nav.selected();
      const it = row && row._item;
      if (!it || !it.actions || !it.actions.length) return;
      if (actionsMenu) {
        actionsMenu.close();
        return;
      }
      actionsMenu = menu(actionsBtn, it.actions.map((a) => (a === 'sep' ? a : {
        ...a,
        onSelect: () => {
          if (!a.keepOpen) close();
          if (a.onSelect) a.onSelect(it, a);
        },
      })), {
        placement: 'top',
        align: 'end',
        nested: true,
        onClose: () => {
          actionsMenu = null;
          if (!closed) input.focus({ preventScroll: true });
        },
      });
    }

    function runSource() {
      if (!o.source) return;
      clearTimeout(remoteTimer);
      const q = input.value.trim();
      const token = ++remoteToken;
      if (!q) {
        remoteGroups = [];
        busy.hidden = true;
        return;
      }
      remoteTimer = setTimeout(async () => {
        busy.hidden = false;
        render();
        try {
          const res = await o.source(q);
          if (token !== remoteToken || closed) return;
          remoteGroups = Array.isArray(res) ? res : [];
        } catch (err) {
          if (token !== remoteToken || closed) return;
          remoteGroups = [];
          console.error(t('[commandPalette] 搜索出错'), err);
        }
        busy.hidden = true;
        render();
      }, o.debounce ?? 120);
    }

    input.addEventListener('input', () => {
      // 旧的搜索结果先留着，新结果回来再换，免得列表闪
      render();
      if (rows[0]) nav.select(rows[0], { silent: true });
      runSource();
    });

    function onKey(e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (actionsMenu) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (input.value) {
          input.value = '';
          input.dispatchEvent(new Event('input'));
        } else close();
      } else if (actionsKey && matchAccel(e, actionsKey)) {
        e.preventDefault();
        e.stopPropagation();
        showActions();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        input.focus();
      }
    }

    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(remoteTimer);
      doc.removeEventListener('keydown', onKey, true);
      nav.destroy();
      if (actionsMenu) actionsMenu.close();
      backdrop.remove();
      if (openPalette && openPalette.el === box) openPalette = null;
      if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
      if (o.onClose) o.onClose();
    }

    primaryBtn.addEventListener('click', () => choose(nav.selected()));
    actionsBtn.addEventListener('click', showActions);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    doc.addEventListener('keydown', onKey, true);
    doc.body.appendChild(backdrop);
    render();
    input.focus();
    if (input.value) runSource();

    const api = {
      el: box,
      input,
      close,
      setGroups(groups) {
        staticGroups = groups || [];
        render();
      },
      refresh: render,
    };
    openPalette = api;
    return api;
  }

  commandPalette.current = () => openPalette;

  Object.assign(ui, {
    platform,
    isMac,
    setTheme,
    applyChrome,
    currentScheme,
    el,
    clear,
    kbd,
    formatAccel,
    accelText,
    matchAccel,
    hotkey,
    spinner,
    iconBox,
    toggle,
    segmented,
    select,
    menu,
    popover,
    tip,
    tipDelegate,
    hideTip,
    toast,
    modal,
    confirm,
    commandPalette,
    listNav,
    listItem,
    emptyState,
    steps,
    fuzzy,
    highlight,
    tints: ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'],
  });
  if (typeof ui.icon !== 'function') ui.icon = icon;
})();
