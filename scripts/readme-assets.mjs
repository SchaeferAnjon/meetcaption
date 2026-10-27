#!/usr/bin/env node
// Records the three demo animations in the README (captions, answer card, class notes) from the
// website's demo stage and writes transparent animated WebP files to docs/readme/<en|zh>/.
//
//   node scripts/readme-assets.mjs                 # both languages, website/ served locally
//   node scripts/readme-assets.mjs --lang en       # one language
//   node scripts/readme-assets.mjs --site https://meetcaption.us-cloud.uk
//   node scripts/readme-assets.mjs --format gif    # GIF instead of WebP (if GitHub does not show WebP)
//
// Needs: Google Chrome, Playwright (global install at /opt/homebrew/lib/node_modules/playwright, or
// PLAYWRIGHT_DIR), and `img2webp` + ImageMagick (`brew install webp imagemagick`).
// Frames come from Chrome's screencast channel with a transparent page background, so one file works
// on GitHub's light and dark themes. Each file is 840 px wide and kept under 400 KB.

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_DIR || '/opt/homebrew/lib/node_modules/playwright');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; };
const langs = arg('lang', 'en,zh').split(',');
const format = arg('format', 'webp');
const width = 840;
const maxKB = 400;
const minGap = 110;
// The stage tabs on the website, in order: bilingual captions, AI answers, class notes.
const groups = ['captions', 'answer', 'notes'];

function serveWebsite() {
  const dir = path.join(root, 'website');
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(dir, p);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

// Isolate the stage: hide the rest of the page, pin the stage at the top left, make everything transparent.
const ISOLATE = `html,body{background:transparent!important;overflow:hidden!important}
  body>*:not(main){display:none!important} main>*{visibility:hidden}
  #how{visibility:visible;position:fixed!important;left:0;top:0;margin:0!important;width:1000px!important;background:transparent!important;border:0!important;box-shadow:none!important;z-index:9999}
  #how *{visibility:visible} #stage,.stage,.sc{background:transparent!important;border:0!important;box-shadow:none!important}
  #stabs,.stage-note{display:none!important}`;

async function recordGroup(browser, site, lang, index, tmp) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 720 }, colorScheme: 'light', deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${site}/?lang=${lang}`, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: ISOLATE });
  const box = await page.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
  const total = await page.evaluate((i) => {
    const acts = [['talk', 'color', 'term'], ['ask', 'key', 'share'], ['notes', 'shot']][i];
    return acts.reduce((s, a) => s + Scenes.ACTIONS[a].dur, 0);
  }, index);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const dir = path.join(tmp, `${lang}-${groups[index]}`);
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  let clickedAt = Infinity;
  cdp.on('Page.screencastFrame', (f) => {
    const wall = Date.now();
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    if (wall < clickedAt) return;
    const name = `f${String(frames.length).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(f.data, 'base64'));
    frames.push({ name, t: f.metadata.timestamp * 1000 });
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1000, maxHeight: 720 });
  await page.waitForTimeout(300);
  // Clicking the tab restarts the group from its first scene.
  await page.evaluate((i) => document.querySelectorAll('#stabs .stab')[i].click(), index);
  clickedAt = Date.now();
  await page.waitForTimeout(total + 400);
  await cdp.send('Page.stopScreencast');
  await ctx.close();
  return { dir, frames, box };
}

function encode(rec, out) {
  const { dir, box } = rec;
  // Chrome sends about 15 frames a second; keep one every 110 ms or so, which is enough for these animations.
  const frames = [];
  for (const f of rec.frames) if (!frames.length || f.t - frames.at(-1).t >= minGap) frames.push(f);
  const small = path.join(dir, 'small');
  fs.mkdirSync(small, { recursive: true });
  for (const f of frames) {
    execFileSync('magick', [path.join(dir, f.name), '-crop', `${box.w}x${box.h}+${box.x}+${box.y}`, '+repage', '-resize', `${width}x`, '-strip', path.join(small, f.name)]);
  }
  const hold = 1800;
  const durs = frames.map((f, i) => (i + 1 < frames.length ? Math.max(40, Math.round(frames[i + 1].t - f.t)) : hold));
  for (const q of format === 'gif' ? [0] : [74, 66, 58, 50, 42]) {
    if (format === 'gif') {
      const list = [];
      frames.forEach((f, i) => list.push('-delay', String(Math.max(2, Math.round(durs[i] / 10))), path.join(small, f.name)));
      execFileSync('magick', ['-dispose', 'background', ...list, '-layers', 'OptimizePlus', '-loop', '0', out]);
    } else {
      const args = ['-loop', '0', '-lossy', '-q', String(q), '-m', '3'];
      frames.forEach((f, i) => args.push('-d', String(durs[i]), path.join(small, f.name)));
      execFileSync('img2webp', [...args, '-o', out]);
    }
    const kb = Math.round(fs.statSync(out).size / 1024);
    if (kb <= maxKB || format === 'gif') return { kb, q, frames: frames.length, seconds: Math.round((frames.at(-1).t - frames[0].t) / 100) / 10 };
  }
  throw new Error(`${out} is still over ${maxKB} KB at the lowest quality`);
}

const { server, url } = arg('site') ? { server: null, url: arg('site').replace(/\/$/, '') } : await serveWebsite();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-assets-'));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const lang of langs) {
    const outDir = path.join(root, 'docs', 'readme', lang);
    fs.mkdirSync(outDir, { recursive: true });
    for (let i = 0; i < groups.length; i++) {
      const rec = await recordGroup(browser, url, lang, i, tmp);
      const out = path.join(outDir, `${groups[i]}.${format}`);
      const info = encode(rec, out);
      console.log(`${path.relative(root, out)}: ${info.frames} frames, ${info.seconds} s, ${info.kb} KB${info.q ? ` (quality ${info.q})` : ''}`);
    }
  }
} finally {
  await browser.close();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
