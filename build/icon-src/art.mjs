// 竖耳兔图标：三个变体的 SVG 源
export const INK = '#23293B';
export const EN = '#4A8AEA';      // 左耳 英文 蓝
export const ZH = '#F2A93B';      // 右耳 中文 琥珀
export const EN_D = '#3A78D8', ZH_D = '#E8962A';

// 超椭圆（macOS 连续圆角）路径
export function squircle(x, y, s, n = 5, steps = 240) {
  const a = s / 2, cx = x + a, cy = y + a; let d = '';
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2, c = Math.cos(t), sn = Math.sin(t);
    const px = cx + a * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const py = cy + a * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
    d += (i ? 'L' : 'M') + px.toFixed(2) + ' ' + py.toFixed(2);
  }
  return d + 'Z';
}

const r = v => +v.toFixed(2);
// 字形：A（尖朝上）、中，圆头圆角笔画
export function glyphA(cx, cy, h, w, sw, col) {
  const top = cy - h / 2, bot = cy + h / 2, by = cy + h * 0.16;
  const k = (by - top) / h, bx = (w / 2) * k * 0.86;
  return `<path d="M${r(cx - w / 2)} ${r(bot)} L${r(cx)} ${r(top)} L${r(cx + w / 2)} ${r(bot)} M${r(cx - bx)} ${r(by)} L${r(cx + bx)} ${r(by)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
}
export function glyphZh(cx, cy, h, w, sw, col, boxTop = -0.2, boxBot = 0.2) {
  const y1 = cy + h * boxTop, y2 = cy + h * boxBot;
  return `<path d="M${r(cx - w / 2)} ${r(y1)} H${r(cx + w / 2)} V${r(y2)} H${r(cx - w / 2)} Z M${r(cx)} ${r(cy - h / 2)} V${r(cy + h / 2)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

let uid = 0;
const U = () => '_' + (++uid);

// 一只耳朵：直立画在 (ex, ey) 为中心，绕 (ex, pivotY) 转 angle
function ear({ ex, ey, w, h, angle, pivotY, fill = '#fff', inner = '' }) {
  return `<g transform="rotate(${angle} ${ex} ${pivotY})"><rect x="${ex - w / 2}" y="${ey - h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="${fill}"/>${inner}</g>`;
}

// 兔子（1024 坐标，底板 100..924）
// v: 'a' 耳窝亮字 | 'b' 耳朵就是字 | 'c' 双色耳朵 ; letters: 是否画字
export function rabbit(v, { letters = true, ox = 0, oy = 0, k = 1, simple = false } = {}) {
  const id = U(), T = simple ? 1.35 : 1; // simple：小尺寸用，笔画加粗、去掉眼睛高光和地面影子
  const L = { ex: 414, ey: 372, w: 176, h: 420, angle: -9, pivotY: 600 };
  const R = { ex: 610, ey: 372, w: 176, h: 420, angle: 10, pivotY: 600 };
  let lIn = '', rIn = '', lFill = '#fff', rFill = '#fff', defs = '';
  if (v === 'a') {
    // 耳窝：彩色内耳，里面一个白字
    // 内耳：上宽下窄的水滴形，外面留一圈厚白边
    const drop = (cx, col) => `<path d="M${cx} 216 C${cx + 58} 216 ${cx + 52} 300 ${cx + 46} 380 C${cx + 40} 460 ${cx + 22} 540 ${cx} 540 C${cx - 22} 540 ${cx - 40} 460 ${cx - 46} 380 C${cx - 52} 300 ${cx - 58} 216 ${cx} 216 Z" fill="${col}"/>`;
    lIn = drop(L.ex, EN); rIn = drop(R.ex, ZH);
    if (letters) {
      lIn += glyphA(L.ex, 320, 104, 62, 21 * T, '#fff');
      rIn += glyphZh(R.ex, 320, 108, 62, 21 * T, '#fff');
    }
  } else if (v === 'b') {
    // 耳朵就是字：内耳那条线本身就是 A 和 中
    if (letters) {
      lIn = glyphA(L.ex, 380, 330, 100, 31 * T, EN);
      rIn = glyphZh(R.ex, 388, 316, 104 + 8 * (T - 1) * 3, 31 * T, ZH, -0.19, 0.1);
    } else {
      lIn = `<path d="M${L.ex - 40} 520 L${L.ex} 230 L${L.ex + 40} 520" fill="none" stroke="${EN}" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>`;
      rIn = `<path d="M${R.ex} 230 V520" stroke="${ZH}" stroke-width="44" stroke-linecap="round"/>`;
    }
  } else {
    // 双色耳朵：整只耳朵上色，白描边，大白字
    defs = `<linearGradient id="le${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5E9DF3"/><stop offset="1" stop-color="${EN_D}"/></linearGradient>
      <linearGradient id="re${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F7BE55"/><stop offset="1" stop-color="${ZH_D}"/></linearGradient>`;
    const pw = 148, ph = 392, py = L.ey - L.h / 2 + 14;
    lIn = `<rect x="${L.ex - pw / 2}" y="${py}" width="${pw}" height="${ph}" rx="${pw / 2}" fill="url(#le${id})"/>`;
    rIn = `<rect x="${R.ex - pw / 2}" y="${py}" width="${pw}" height="${ph}" rx="${pw / 2}" fill="url(#re${id})"/>`;
    if (letters) {
      lIn += glyphA(L.ex, 326, 176, 96, 30 * T, '#fff');
      rIn += glyphZh(R.ex, 326, 180, 96, 30 * T, '#fff');
    }
  }
  const head = `<defs>${defs}<radialGradient id="hd${id}" cx=".42" cy=".3" r=".8"><stop offset=".55" stop-color="#fff"/><stop offset="1" stop-color="#E4EEF9"/></radialGradient></defs>
  ${simple ? '' : '<ellipse cx="512" cy="872" rx="220" ry="26" fill="#2B5A8C" opacity=".10"/>'}
  ${ear({ ...L, inner: lIn })}${ear({ ...R, inner: rIn })}
  <ellipse cx="512" cy="672" rx="238" ry="196" fill="url(#hd${id})"/>
  <ellipse cx="442" cy="660" rx="24" ry="28" fill="${INK}"/><ellipse cx="582" cy="660" rx="24" ry="28" fill="${INK}"/>
  ${simple ? '' : '<circle cx="450" cy="650" r="8" fill="#fff"/><circle cx="590" cy="650" r="8" fill="#fff"/>'}
  <path d="M500 700 Q512 712 524 700" fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>
  <ellipse cx="390" cy="722" rx="36" ry="21" fill="#FFB4B4" opacity=".75"/><ellipse cx="634" cy="722" rx="36" ry="21" fill="#FFB4B4" opacity=".75"/>`;
  return k === 1 && !ox && !oy ? head : `<g transform="translate(${ox} ${oy}) scale(${k})">${head}</g>`;
}

const BG = id => `<linearGradient id="bg${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C9E6FA"/><stop offset="1" stop-color="#82B8E8"/></linearGradient>
  <radialGradient id="gl${id}" cx=".3" cy=".18" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;

// Mac 应用图标 1024：824 底板，100 留边，阴影
export function mac(v, opts = {}) {
  const id = U(), sq = squircle(100, 100, 824);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><defs>${BG(id)}
  <filter id="sh${id}" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#0B2340" flood-opacity=".28"/></filter>
  <clipPath id="cl${id}"><path d="${sq}"/></clipPath></defs>
  <path d="${sq}" fill="url(#bg${id})" filter="url(#sh${id})"/>
  <g clip-path="url(#cl${id})"><rect width="1024" height="1024" fill="url(#gl${id})"/>${rabbit(v, opts)}</g>
  <path d="${sq}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="3"/></svg>`;
}

// Windows 256 / 48：满幅圆角方块（留 4% 边）
export function win(v, size, opts = {}) {
  const id = U(), m = 1024 * 0.035, s = 1024 - 2 * m, sq = squircle(m, m, s, 5);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="${size}" height="${size}"><defs>${BG(id)}<clipPath id="cl${id}"><path d="${sq}"/></clipPath></defs>
  <path d="${sq}" fill="url(#bg${id})"/><g clip-path="url(#cl${id})"><rect width="1024" height="1024" fill="url(#gl${id})"/>${rabbit(v, { ...opts, k: 1.1, ox: -51, oy: -88 })}</g></svg>`;
}

// —— 小尺寸：按像素画 ——
// 32 和 16 的耳朵、字按整像素画（不转角度），头用矢量椭圆
const PX = { W: '#FFFFFF', E: EN, Z: ZH, K: INK, P: '#FFB4B4', w: '#EEF3FA', e: '#2F6FD0', z: '#D98A1E' };
function pix(rows, x0, y0, map = PX) {
  let o = '';
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (map[ch]) o += `<rect x="${x0 + x}" y="${y0 + y}" width="1" height="1" fill="${map[ch]}"/>`; }));
  return `<g shape-rendering="crispEdges">${o}</g>`;
}
// 32 格的一对耳朵（7 宽 × 12 高），三种画法
const EAR32 = {
  a: { L: [' WWWWW ','WWWWWWW','WWEEEWW','WWEEEWW','WWEEEWW','WWEEEWW','WWEEEWW','WWWEWWW','WWWEWWW','WWWEWWW','WWWWWWW','WWWWWWW'],
       R: [' WWWWW ','WWWWWWW','WWZZZWW','WWZZZWW','WWZZZWW','WWZZZWW','WWZZZWW','WWWZWWW','WWWZWWW','WWWZWWW','WWWWWWW','WWWWWWW'] },
  b: { L: [' WWWWW ','WWWEWWW','WWEWEWW','WWEWEWW','WEEEEEW','WEWWWEW','WEWWWEW','WEWWWEW','WWWWWWW','WWWWWWW','WWWWWWW','WWWWWWW'],
       R: [' WWWWW ','WWWZWWW','WZZZZZW','WZWZWZW','WZZZZZW','WWWZWWW','WWWZWWW','WWWZWWW','WWWWWWW','WWWWWWW','WWWWWWW','WWWWWWW'] },
  c: { L: [' EEEEE ','EEEWEEE','EEWEWEE','EEWEWEE','EWWWWWE','EWEEEWE','EWEEEWE','EWEEEWE','EEEEEEE','EEEEEEE','EEEEEEE','EEEEEEE'],
       R: [' ZZZZZ ','ZZZWZZZ','ZWWWWWZ','ZWZWZWZ','ZWWWWWZ','ZZZWZZZ','ZZZWZZZ','ZZZWZZZ','ZZZZZZZ','ZZZZZZZ','ZZZZZZZ','ZZZZZZZ'] },
};
// 16 格的一对耳朵（3 宽 × 7 高）
const EAR16 = {
  a: { L: [' W ','WWW','WEW','WEW','WEW','WEW','WWW'], R: [' W ','WWW','WZW','WZW','WZW','WZW','WWW'] },
  c: { L: [' E ','EEE','EEE','EEE','EEE','EEE','EEE'], R: [' Z ','ZZZ','ZZZ','ZZZ','ZZZ','ZZZ','ZZZ'] },
};
EAR16.b = EAR16.a;
const face32 = (cx, eyeY) => pix(['KK      KK','KK      KK'], cx - 5, eyeY) + pix(['PP          PP'], cx - 7, eyeY + 3) + pix(['K  K',' KK '], cx - 2, eyeY + 2);
// 32：plate 给 Mac（留 3 像素边）或 Windows（满幅）
export function small32(v, kind = 'mac') {
  const id = U();
  const m = kind === 'mac' ? 3 : 0.5, s = 32 - 2 * m, sq = squircle(m, m, s, 5, 120);
  const top = kind === 'mac' ? 4 : 2, headCy = kind === 'mac' ? 21.5 : 21.5, ry = kind === 'mac' ? 6.5 : 7.5, rx = kind === 'mac' ? 10 : 11;
  const ears = pix(EAR32[v].L, 8, top) + pix(EAR32[v].R, 17, top);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"><defs>${BG(id)}<clipPath id="cl${id}"><path d="${sq}"/></clipPath></defs>
  <path d="${sq}" fill="url(#bg${id})"/><g clip-path="url(#cl${id})">${ears}
  <ellipse cx="16" cy="${headCy}" rx="${rx}" ry="${ry}" fill="#fff"/>${face32(16, Math.round(headCy - 1))}</g>${kind === 'mac' ? `<path d="${sq}" fill="none" stroke="#5E8FC0" stroke-opacity=".35" stroke-width=".6"/>` : ''}</svg>`;
}
export function small16(v, kind = 'win') {
  const id = U();
  const m = kind === 'mac' ? 1.5 : 0, s = 16 - 2 * m, sq = squircle(m, m, s, 5, 80);
  const top = kind === 'mac' ? 2 : 1;
  const ears = pix(EAR16[v].L, 4, top) + pix(EAR16[v].R, 9, top);
  const cy = kind === 'mac' ? 10.5 : 11, ry = kind === 'mac' ? 3.6 : 4.2, rx = kind === 'mac' ? 5.2 : 5.8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><defs>${BG(id)}<clipPath id="cl${id}"><path d="${sq}"/></clipPath></defs>
  <path d="${sq}" fill="url(#bg${id})"/><g clip-path="url(#cl${id})">${ears}<ellipse cx="8" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff"/>${pix(['K    K'], 5, Math.round(cy) - 1)}</g></svg>`;
}

// —— 菜单栏 / 托盘：单色剪影 ——
// size 像素；rec 录音中；col 颜色（Mac 模板图用黑）
export function tray(size, rec, col = '#000') {
  const id = U(), u = size / 16, sw = size <= 16 ? 1 : size <= 24 ? 1.5 : 2;
  // 16 格上的几何，按 u 放大
  const earW = 3.2, earH = 8.2, lx = 3.4, rx_ = 9.4, ey = 1.1;
  const hx = 8, hy = 10.6, hrx = 5.9, hry = 4.5;
  const S = v => +(v * u).toFixed(2);
  if (!rec) {
    const o = sw / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><mask id="m${id}"><rect width="${size}" height="${size}" fill="#fff"/><ellipse cx="${S(hx)}" cy="${S(hy)}" rx="${S(hrx) + o}" ry="${S(hry) + o}" fill="#000"/></mask></defs>
    <g fill="none" stroke="${col}" stroke-width="${sw}"><g mask="url(#m${id})"><rect x="${S(lx)}" y="${S(ey)}" width="${S(earW)}" height="${S(earH)}" rx="${S(earW) / 2}" transform="rotate(-8 ${S(lx + earW / 2)} ${S(9)})"/><rect x="${S(rx_)}" y="${S(ey)}" width="${S(earW)}" height="${S(earH)}" rx="${S(earW) / 2}" transform="rotate(8 ${S(rx_ + earW / 2)} ${S(9)})"/></g>
    <ellipse cx="${S(hx)}" cy="${S(hy)}" rx="${S(hrx) - o}" ry="${S(hry) - o}"/></g>
    <g fill="${col}"><circle cx="${S(6)}" cy="${S(10.4)}" r="${S(0.78)}"/><circle cx="${S(10)}" cy="${S(10.4)}" r="${S(0.78)}"/></g></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><mask id="m${id}"><rect width="${size}" height="${size}" fill="#fff"/><circle cx="${S(6)}" cy="${S(10.4)}" r="${S(0.95)}" fill="#000"/><circle cx="${S(10)}" cy="${S(10.4)}" r="${S(0.95)}" fill="#000"/></mask></defs>
  <g fill="${col}" mask="url(#m${id})"><rect x="${S(lx - 0.3)}" y="${S(ey - 0.3)}" width="${S(earW + 0.6)}" height="${S(earH)}" rx="${S(earW + 0.6) / 2}" transform="rotate(-8 ${S(lx + earW / 2)} ${S(9)})"/><rect x="${S(rx_ - 0.3)}" y="${S(ey - 0.3)}" width="${S(earW + 0.6)}" height="${S(earH)}" rx="${S(earW + 0.6) / 2}" transform="rotate(8 ${S(rx_ + earW / 2)} ${S(9)})"/>
  <ellipse cx="${S(hx)}" cy="${S(hy)}" rx="${S(hrx)}" ry="${S(hry)}"/></g></svg>`;
}
// Windows 托盘录音中：剪影 + 红点（点外一圈任务栏底色）
export function winTray(size, rec, theme) {
  const col = theme === 'dark' ? '#FFFFFF' : '#1B1B1B', bg = theme === 'dark' ? '#202020' : '#EEEEEE';
  let s = trayN(size, rec, col);
  if (rec) { const u = size / 16; s = s.replace('</svg>', `<circle cx="${(13.8 * u).toFixed(2)}" cy="${(13.8 * u).toFixed(2)}" r="${(2.7 * u).toFixed(2)}" fill="${bg}"/><circle cx="${(13.8 * u).toFixed(2)}" cy="${(13.8 * u).toFixed(2)}" r="${(1.95 * u).toFixed(2)}" fill="#E5484D"/></svg>`); }
  return s;
}

// 16 像素的托盘按像素画（1x），# 黑，o 录音中挖空
const T16 = {
  idle: [
'................',
'....##....##....',
'...#..#..#..#...',
'...#..#..#..#...',
'...#..#..#..#...',
'...#..#..#..#...',
'...#..#..#..#...',
'..##..####..##..',
'.#............#.',
'#..............#',
'#...#......#...#',
'#..............#',
'#..............#',
'.#............#.',
'..##........##..',
'....########....'],
  rec: [
'................',
'....##....##....',
'...####..####...',
'...####..####...',
'...####..####...',
'...####..####...',
'...####..####...',
'..############..',
'.##############.',
'################',
'####.######.####',
'################',
'################',
'.##############.',
'..############..',
'....########....'] };
export function tray16(rec, col = '#000') {
  let o = ''; (rec ? T16.rec : T16.idle).forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') o += `<rect x="${x}" y="${y}" width="1" height="1"/>`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><g fill="${col}" shape-rendering="crispEdges">${o}</g></svg>`;
}

// 24 / 32 像素：耳朵直立，2 像素线落在整像素上
const TG = {
  24: { ear: [5, 2, 5, 12], gap: 9, head: [12, 15.5, 9, 6.6], eyes: [8.6, 15.4, 1.25], sw: 2 },
  32: { ear: [7, 3, 6, 15], gap: 12, head: [16, 21, 12.2, 8.6], eyes: [11.4, 20.6, 1.6], sw: 2 },
};
export function trayN(size, rec, col = '#000') {
  if (size === 16) return tray16(rec, col);
  const g = TG[size], id = U(), [ex, ey, ew, eh] = g.ear, [hx, hy, hrx, hry] = g.head, [e1, eyY, er] = g.eyes, sw = g.sw;
  const rx2 = size - ex - ew; // 右耳 x（左右对称）
  const e2 = size - e1;
  if (!rec) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><mask id="m${id}"><rect width="${size}" height="${size}" fill="#fff"/><ellipse cx="${hx}" cy="${hy}" rx="${hrx + sw / 2}" ry="${hry + sw / 2}" fill="#000"/></mask></defs>
  <g fill="none" stroke="${col}" stroke-width="${sw}"><g mask="url(#m${id})"><rect x="${ex}" y="${ey}" width="${ew}" height="${eh}" rx="${ew / 2}"/><rect x="${rx2}" y="${ey}" width="${ew}" height="${eh}" rx="${ew / 2}"/></g><ellipse cx="${hx}" cy="${hy}" rx="${hrx}" ry="${hry}"/></g>
  <g fill="${col}"><circle cx="${e1}" cy="${eyY}" r="${er}"/><circle cx="${e2}" cy="${eyY}" r="${er}"/></g></svg>`;
  const o = sw / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><defs><mask id="m${id}"><rect width="${size}" height="${size}" fill="#fff"/><circle cx="${e1}" cy="${eyY}" r="${er + 0.3}" fill="#000"/><circle cx="${e2}" cy="${eyY}" r="${er + 0.3}" fill="#000"/></mask></defs>
  <g fill="${col}" mask="url(#m${id})"><rect x="${ex - o}" y="${ey - o}" width="${ew + sw}" height="${eh}" rx="${(ew + sw) / 2}"/><rect x="${rx2 - o}" y="${ey - o}" width="${ew + sw}" height="${eh}" rx="${(ew + sw) / 2}"/><ellipse cx="${hx}" cy="${hy}" rx="${hrx + o}" ry="${hry + o}"/></g></svg>`;
}
