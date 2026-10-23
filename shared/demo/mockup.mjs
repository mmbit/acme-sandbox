#!/usr/bin/env node
// mockup.mjs: turn a flat artwork into a photo-like image of the printed Print API product.
// Everything (scene, props, textures, light) is drawn in code in headless Chromium. See MOCKUP.md.
//   node shared/demo/mockup.mjs mug art.png --out mug.png [--scene table] [--size 1080x1920]
//   node shared/demo/mockup.mjs --all art.png --out sheet.png      (every product + a contact sheet)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execSync } from 'child_process';

// Real proportions in cm (the print partner's catalogue).
// auto: flip to match the artwork's orientation. mount: default scene.
const PRODUCTS = {
  poster:   { w: 30, h: 40, auto: 1, scene: 'wall',  note: 'poster_30x40 (A4-A0 also fine)' },
  canvas:   { w: 30, h: 40, d: 2, auto: 1, scene: 'wall', note: 'canvas_30x40, 2 cm frame, image wraps' },
  calendar: { w: 21, h: 29.7, auto: 1, scene: 'wall', note: 'kalender A4, spiral + hanger; artwork = one full page' },
  clock:    { w: 30, h: 30, scene: 'wall', note: 'klok_30x30_rond; hands drawn at 10:09' },
  mug:      { w: 19.8, h: 9.8, scene: 'table', note: 'mok 330 ml, wrap 198x98 mm' },
  card:     { w: 10.5, h: 14.8, scene: 'table', note: 'folded card A6, artwork = front' },
  postcard: { w: 14.8, h: 10.5, auto: 1, scene: 'flat', note: 'kaart A6, artwork = front' },
  book:     { w: 21, h: 21, d: 1.6, auto: 1, scene: 'table', note: 'hardcover photo book 21x21 (A4 if not square)' },
  puzzle:   { w: 40, h: 30, auto: 1, scene: 'flat', note: 'puzzel 500 pieces' },
  tile:     { w: 15, h: 15, scene: 'table', note: 'tegeltje_15x15 with holder' },
};
const SCENES = ['wall', 'table', 'flat', 'studio', 'none'];

const HELP = `usage: node shared/demo/mockup.mjs <category|--all> <artwork.png|jpg|svg> --out file.png [options]
categories: ${Object.keys(PRODUCTS).join(', ')}
  --scene ${SCENES.join('|')}   backdrop (default per product; none = transparent PNG)
  --size WxH               output size (default 1600x1200; e.g. 1080x1920, 1080x1080)
  --transparent            keep product + shadows, drop the backdrop (for compositing in ads)
  --wall #hex --surface #hex --accent #hex   restyle backdrop, table and props per team
  --no-props               no plant / sprig / pencil
  --view left|right|front  mug: which side faces the camera (default right = handle on the right)
  --pieces N               puzzle piece count (default 500)
  --magic 0..1             mug: magic-mug reveal (0 = black, 1 = fully revealed)
  --scale 2                device pixel ratio (sharper, bigger file)`;

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (['all', 'transparent', 'no-props', 'help'].includes(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

const opt = args(process.argv.slice(2));
if (opt.help || (!opt.all && opt._.length < 2) || (opt.all && opt._.length < 1)) { console.log(HELP); process.exit(opt.help ? 0 : 1); }
const cats = opt.all ? Object.keys(PRODUCTS) : [opt._[0]];
const artPath = opt.all ? opt._[0] : opt._[1];
for (const c of cats) if (!PRODUCTS[c]) { console.error(`unknown category "${c}"\n${HELP}`); process.exit(1); }
if (opt.scene && !SCENES.includes(opt.scene)) { console.error(`unknown scene "${opt.scene}"`); process.exit(1); }
const [W, H] = (opt.size || '1600x1200').split('x').map(Number);
const out = opt.out || (opt.all ? 'mockups.png' : `mockup-${cats[0]}.png`);
const ext = path.extname(artPath).toLowerCase();
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext];
if (!mime) { console.error('artwork must be png, jpg, webp or svg'); process.exit(1); }
const art = `data:${mime};base64,${fs.readFileSync(artPath).toString('base64')}`;

const req = createRequire(path.join(execSync('npm root -g').toString().trim(), '/'));
const { chromium } = req('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: Number(opt.scale || 1) });

const files = [];
for (const cat of cats) {
  const cfg = {
    cat, W, H, art, spec: PRODUCTS[cat],
    scene: opt.transparent ? 'none' : (opt.scene || PRODUCTS[cat].scene),
    wall: opt.wall, surface: opt.surface, accent: opt.accent, props: !opt['no-props'],
    view: opt.view || 'right', pieces: Number(opt.pieces || 500), magic: opt.magic == null ? null : Number(opt.magic),
  };
  await page.setContent('<!doctype html><body style="margin:0;background:transparent"><div id="stage"></div></body>');
  const warn = await page.evaluate(render, cfg);
  if (warn) console.warn(`${cat}: ${warn}`);
  const file = opt.all ? out.replace(/\.png$/, '') + `-${cat}.png` : out;
  await page.locator('#stage').screenshot({ path: file, omitBackground: cfg.scene === 'none' });
  files.push(file);
  console.log(file);
}

if (opt.all) { // contact sheet
  const cols = 4, cw = 480, ch = Math.round(cw * H / W);
  await page.setViewportSize({ width: cols * cw + (cols + 1) * 16, height: 100 });
  const cells = files.map((f, i) => `<figure><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"><figcaption>${cats[i]} · ${PRODUCTS[cats[i]].note}</figcaption></figure>`).join('');
  await page.setContent(`<body style="margin:0"><div id="stage" style="display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:16px;padding:16px;background:#f3efe8;font:13px system-ui;color:#4a4050">
    <style>figure{margin:0}img{width:${cw}px;height:${ch}px;display:block;border-radius:6px}figcaption{padding:6px 2px}</style>${cells}</div></body>`);
  await page.locator('#stage').screenshot({ path: out });
  console.log(out);
}
await browser.close();

// ---------------------------------------------------------------------------------------------
// Everything below runs inside Chromium (serialised by page.evaluate), so it must be self-contained.
async function render(c) {
  const { W, H } = c, S = Math.min(W, H), u = S / 100;
  const stage = document.getElementById('stage');
  const img = new Image(); img.src = c.art; await img.decode();
  const ar = img.naturalWidth / img.naturalHeight;
  let { w, h, d = 0 } = c.spec;
  if (c.spec.auto) {
    if (c.cat === 'book' && ar > 0.87 && ar < 1.15) { /* square book */ }
    else if (c.cat === 'book') { [w, h] = ar < 1 ? [21, 29.7] : [29.7, 21]; }
    else if ((ar > 1) !== (w > h)) [w, h] = [h, w];
  }
  const want = w / h, warn = Math.abs(ar / want - 1) > 0.04
    ? `artwork ratio ${ar.toFixed(2)} vs product ${want.toFixed(2)} (${w}x${h} cm): cropped to fill. Supply ${want.toFixed(3)}:1 art for an exact fit.` : '';

  const scene = c.scene, wall = c.wall || '#e9e1d6', surface = c.surface || (scene === 'flat' ? '#d9cbb8' : '#b98e66'), accent = c.accent || '#c96f4a';
  const enc = (x) => `url('data:image/svg+xml,${encodeURIComponent(x).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29')}')`;
  const noise = (op = .5, f = .85) => enc(`<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${f}' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='${op}'/></svg>`);
  const grain = enc(`<svg xmlns='http://www.w3.org/2000/svg' width='900' height='300'><filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.004 0.09' numOctaves='4' seed='3' stitchTiles='stitch'/><feColorMatrix type='matrix' values='0 0 0 0 .35  0 0 0 0 .22  0 0 0 0 .1  0 0 0 3 -1.2'/></filter><rect width='100%' height='100%' filter='url(#g)'/></svg>`); // wood grain
  const css = `
    #stage{position:relative;width:${W}px;height:${H}px;overflow:hidden;font-family:'DejaVu Sans',sans-serif}
    .abs{position:absolute} .fill{position:absolute;inset:0}
    .art{background:url("${c.art}") center/cover no-repeat}
    .grain::after{content:'';position:absolute;inset:0;background:${noise(.55)};mix-blend-mode:multiply;opacity:.16;pointer-events:none;border-radius:inherit}
    .p3{transform-style:preserve-3d} .face{position:absolute;backface-visibility:hidden}
  `;
  const el = (html) => { const t = document.createElement('div'); t.innerHTML = html.trim(); return t.firstChild; };
  stage.innerHTML = `<style>${css}</style>`;
  const add = (html) => stage.appendChild(el(html));

  // ---- scenes: backdrop + floor line (y where standing things touch down)
  let floorY = H * 0.86, horizon = H;
  if (scene === 'wall' || scene === 'studio') {
    const isStudio = scene === 'studio';
    horizon = H * (isStudio ? 0.72 : 0.84); floorY = H * (isStudio ? 0.83 : 0.93);
    add(`<div class="fill" style="background:${wall}"></div>`);
    add(`<div class="fill" style="background:radial-gradient(ellipse 90% 80% at 32% 18%,rgba(255,255,255,.38),transparent 70%),linear-gradient(transparent 55%,rgba(40,25,10,.10))"></div>`);
    add(`<div class="fill" style="background:${noise(.6, .6)};mix-blend-mode:multiply;opacity:.10"></div>`);
    if (isStudio) add(`<div class="abs" style="left:0;right:0;top:${horizon - 8 * u}px;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.06) ${8 * u}px,rgba(255,255,255,.12) 60%,rgba(0,0,0,.04))"></div>`);
    else { // a low sideboard along the bottom
      add(`<div class="abs" style="left:0;right:0;top:${horizon}px;bottom:0;background:linear-gradient(${surface},color-mix(in srgb,${surface},#000 28%))"></div>`);
      add(`<div class="abs" style="left:0;right:0;top:${horizon}px;height:${0.35 * u}px;background:rgba(255,255,255,.35)"></div>`);
      add(`<div class="abs" style="left:0;right:0;top:${horizon}px;bottom:0;background:${grain} 0 0/100% 300%;opacity:.3;mix-blend-mode:multiply"></div>`);
      add(`<div class="abs" style="left:0;right:0;top:${horizon - 2 * u}px;height:${2 * u}px;background:linear-gradient(transparent,rgba(0,0,0,.10))"></div>`);
    }
  } else if (scene === 'table') {
    horizon = H * 0.56; floorY = H * 0.82;
    add(`<div class="fill" style="background:${wall}"></div>`);
    add(`<div class="fill" style="background:radial-gradient(ellipse 80% 70% at 28% 10%,rgba(255,255,255,.4),transparent 70%)"></div>`);
    add(`<div class="abs" style="left:0;right:0;top:${horizon}px;bottom:0;background:linear-gradient(color-mix(in srgb,${surface},#fff 8%),color-mix(in srgb,${surface},#000 18%))"></div>`);
    add(`<div class="abs" style="left:0;right:0;top:${horizon}px;bottom:0;background:${grain} 0 0/100% 100%;opacity:.35;mix-blend-mode:multiply"></div>`);
    add(`<div class="abs" style="left:0;right:0;top:${horizon - 3 * u}px;height:${3 * u}px;background:linear-gradient(transparent,rgba(0,0,0,.12))"></div>`);
    add(`<div class="fill" style="background:radial-gradient(ellipse 120% 90% at 50% 40%,transparent 55%,rgba(0,0,0,.18))"></div>`);
  } else if (scene === 'flat') {
    add(`<div class="fill" style="background:${surface}"></div>`);
    add(`<div class="fill" style="background:${noise(.7, .7)};mix-blend-mode:multiply;opacity:.22"></div>`);
    add(`<div class="fill" style="background:radial-gradient(ellipse 80% 70% at 30% 25%,rgba(255,255,255,.28),transparent 70%),radial-gradient(ellipse 130% 110% at 50% 50%,transparent 55%,rgba(0,0,0,.2))"></div>`);
  }

  // ---- props (original, simple, recoloured by --accent)
  const plant = (x, s) => (x < 0 || x + 22 * s * u > W) ? null : add(`<svg class="abs" style="left:${x}px;top:${floorY - 34 * s * u}px;width:${22 * s * u}px;height:${34 * s * u}px;overflow:visible" viewBox="0 0 22 34">
      <ellipse cx="11" cy="33.6" rx="8" ry="1.1" fill="rgba(0,0,0,.25)" filter="blur(.6px)"/>
      <g stroke="#3f6b45" stroke-width=".5" fill="none">${[[-40, 14], [-15, 17], [10, 16], [35, 13], [-60, 10], [58, 10], [0, 12]].map(([a, l], i) =>
        `<path d="M11 21 q${Math.sin(a * Math.PI / 180) * l * .3} ${-l * .5} ${Math.sin(a * Math.PI / 180) * l} ${-l * Math.cos(a * Math.PI / 180)}"/>`).join('')}</g>
      ${[[-40, 14], [-15, 17], [10, 16], [35, 13], [-60, 10], [58, 10], [0, 12]].map(([a, l], i) => {
        const r = a * Math.PI / 180, x2 = 11 + Math.sin(r) * l, y2 = 21 - l * Math.cos(r);
        return `<ellipse cx="${x2}" cy="${y2}" rx="2.4" ry="4.4" transform="rotate(${a} ${x2} ${y2})" fill="${['#5b8f5a', '#4d7f50', '#6fa36a'][i % 3]}"/>`;
      }).join('')}
      <path d="M4.5 20 h13 l-1.4 13 a1.2 1.2 0 0 1 -1.2 1 h-7.8 a1.2 1.2 0 0 1 -1.2 -1z" fill="${accent}"/>
      <path d="M4.5 20 h13 l-.25 2.2 h-12.5z" fill="rgba(0,0,0,.18)"/><path d="M6 21 l1.2 12" stroke="rgba(255,255,255,.3)" stroke-width=".8"/>
    </svg>`);
  const sprig = (x, y, s, rot) => add(`<svg class="abs" style="left:${x}px;top:${y}px;width:${30 * s * u}px;height:${30 * s * u}px;transform:rotate(${rot}deg);filter:drop-shadow(${.5 * u}px ${.8 * u}px ${.6 * u}px rgba(0,0,0,.3))" viewBox="0 0 30 30">
      <path d="M3 27 C10 20 18 12 27 3" stroke="#6b5a3e" stroke-width=".5" fill="none"/>
      ${[...Array(7)].map((_, i) => { const t = 4 + i * 3.3, x2 = t, y2 = 30 - t; return `<ellipse cx="${x2 - 2}" cy="${y2 - 2}" rx="1.6" ry="3" transform="rotate(-45 ${x2} ${y2}) " fill="#8fae8b"/><ellipse cx="${x2 + 2}" cy="${y2 + 2}" rx="1.6" ry="3" transform="rotate(-45 ${x2} ${y2})" fill="#7c9e79"/>`; }).join('')}
    </svg>`);
  const pencil = (x, y, len, rot) => add(`<div class="abs" style="left:${x}px;top:${y}px;width:${len}px;height:${1.3 * u}px;transform:rotate(${rot}deg);border-radius:${.3 * u}px;
      background:linear-gradient(90deg,#3a3030 0 2%,#e8d2a8 2% 9%,${accent} 9% 92%,#c9b18a 92%),linear-gradient(transparent 40%,rgba(0,0,0,.25));background-blend-mode:multiply;
      box-shadow:${.4 * u}px ${.6 * u}px ${.6 * u}px rgba(0,0,0,.3);clip-path:polygon(0 50%,9% 0,100% 0,100% 100%,9% 100%)"></div>`);

  // ---- helpers
  const light = `linear-gradient(135deg,rgba(255,255,255,.14),transparent 45%,rgba(0,0,0,.07))`;
  // a slab (w x h x depth) in CSS 3D; faces: front (art), sides (given css)
  function slab(pw, ph, pd, front, side, top, extra = '') {
    return `<div class="abs p3" style="left:${-pw / 2}px;top:${-ph / 2}px;width:${pw}px;height:${ph}px;${extra}">
      <div class="face" style="inset:0;transform:translateZ(${pd / 2}px);${front}"></div>
      <div class="face" style="left:${(pw - pd) / 2}px;top:0;width:${pd}px;height:${ph}px;transform:rotateY(90deg) translateZ(${pw / 2}px);${side}"></div>
      <div class="face" style="left:${(pw - pd) / 2}px;top:0;width:${pd}px;height:${ph}px;transform:rotateY(-90deg) translateZ(${pw / 2}px);${side}"></div>
      <div class="face" style="left:0;top:${(ph - pd) / 2}px;width:${pw}px;height:${pd}px;transform:rotateX(90deg) translateZ(${ph / 2}px);${top || side}"></div>
      <div class="face" style="left:0;top:${(ph - pd) / 2}px;width:${pw}px;height:${pd}px;transform:rotateX(-90deg) translateZ(${ph / 2}px);${top || side}"></div>
    </div>`;
  }
  // world: a 3D-capable group positioned at (x,y) = centre of the object
  const world = (x, y, inner, tf = '', persp = 3.2 * S) => add(`<div class="abs p3" style="left:${x}px;top:${y}px;width:0;height:0;perspective:${persp}px;perspective-origin:${W / 2 - x}px ${H * 0.42 - y}px"><div class="p3" style="transform:${tf}">${inner}</div></div>`);
  const shadowBox = (x, y, pw, ph, blur, op, r = 0) => add(`<div class="abs" style="left:${x - pw / 2}px;top:${y - ph / 2}px;width:${pw}px;height:${ph}px;border-radius:${r};background:rgba(20,10,0,${op});filter:blur(${blur}px)"></div>`);
  const contact = (x, y, rw, rh, op = .45) => add(`<div class="abs" style="left:${x - rw}px;top:${y - rh}px;width:${2 * rw}px;height:${2 * rh}px;border-radius:50%;background:radial-gradient(closest-side,rgba(20,10,0,${op}),rgba(20,10,0,${op * .4}) 55%,transparent)"></div>`);

  // size a product so its bounding box fits a share of the stage
  const fit = (maxW, maxH) => { const k = Math.min(maxW / w, maxH / h); return [w * k, h * k, k]; };
  const port = H > W * 1.1, cx = W / 2, isWall = scene === 'wall' || scene === 'studio' || scene === 'none';
  const mode = c.cat;

  if (mode === 'poster' || mode === 'canvas' || mode === 'calendar') {
    const leaning = scene === 'table';
    const [pw, ph, k] = fit(W * (leaning ? .5 : .6), (leaning ? floorY - H * .1 : horizon) * (leaning ? 1 : .72));
    const pd = Math.max(d * k, mode === 'poster' ? 1 : 3);
    const cy = leaning ? horizon + 1.5 * u - ph / 2 : Math.min(horizon * .53, H * .47);
    if (c.props && scene !== 'none' && scene !== 'flat') plant(cx + pw / 2 + 6 * u, 1.1);
    if (mode === 'calendar') { // stack of pages below the front page
      shadowBox(cx + 1.2 * u, cy + 2.2 * u, pw, ph, 2.2 * u, .28);
      for (let i = 3; i >= 1; i--) add(`<div class="abs" style="left:${cx - pw / 2}px;top:${cy - ph / 2 + i * .22 * u}px;width:${pw}px;height:${ph}px;background:hsl(40 20% ${96 - i * 3}%);box-shadow:0 1px 1px rgba(0,0,0,.12)"></div>`);
    } else shadowBox(cx + (mode === 'canvas' ? 1.8 : 1) * u, cy + (mode === 'canvas' ? 2.6 : 1.4) * u, pw, ph, (mode === 'canvas' ? 2.6 : 1.6) * u, mode === 'canvas' ? .38 : .3);
    if (mode === 'canvas') {
      const weave = `repeating-linear-gradient(0deg,rgba(0,0,0,.05) 0 1px,transparent 1px 3px),repeating-linear-gradient(90deg,rgba(255,255,255,.06) 0 1px,transparent 1px 3px)`;
      const front = `background:${weave},${light},url('${c.art}') center/cover;`;
      const sideR = `background:linear-gradient(90deg,rgba(0,0,0,.35),rgba(0,0,0,.5)),url('${c.art}') right/auto ${ph}px;transform-origin:center;`;
      world(cx, cy, slab(pw, ph, pd, front, sideR, `background:linear-gradient(rgba(0,0,0,.2),rgba(0,0,0,.35)),url('${c.art}') top/${pw}px auto`), `rotateY(-16deg)`);
    } else {
      add(`<div class="abs art grain" style="left:${cx - pw / 2}px;top:${cy - ph / 2}px;width:${pw}px;height:${ph}px;box-shadow:0 0 0 .5px rgba(0,0,0,.08)">
        <div class="fill" style="background:${light}"></div>
        ${mode === 'poster' ? `<div class="fill" style="background:linear-gradient(90deg,transparent 30%,rgba(255,255,255,.05) 48%,rgba(0,0,0,.035) 62%,transparent 80%)"></div>` : ''}</div>`);
    }
    if (mode === 'calendar') { // spiral wire, punched holes, hanger
      const n = Math.round(pw / (1.6 * u)), gap = pw / n, top = cy - ph / 2;
      let loops = '';
      for (let i = 0; i < n; i++) { const x = (i + .5) * gap; if (Math.abs(x - pw / 2) < 3.2 * u) continue;
        loops += `<rect x="${x - .35 * u}" y="${1.6 * u}" width="${.7 * u}" height="${.55 * u}" rx="${.25 * u}" fill="#3b3440"/>
          <path d="M${x - .5 * u} ${1.9 * u} C${x - .9 * u} ${-.4 * u} ${x + .7 * u} ${-.6 * u} ${x + .3 * u} ${1.9 * u}" stroke="url(#wire)" stroke-width="${.3 * u}" fill="none" stroke-linecap="round"/>`; }
      add(`<svg class="abs" style="left:${cx - pw / 2}px;top:${top - 1.4 * u}px;overflow:visible" width="${pw}" height="${4 * u}">
        <defs><linearGradient id="wire" x1="0" x2="1"><stop offset="0" stop-color="#555"/><stop offset=".5" stop-color="#eee"/><stop offset="1" stop-color="#666"/></linearGradient></defs>${loops}
        <path d="M${pw / 2 - 2.8 * u} ${1.2 * u} L${pw / 2} ${-2.6 * u} L${pw / 2 + 2.8 * u} ${1.2 * u}" stroke="url(#wire)" stroke-width="${.3 * u}" fill="none"/>
        <circle cx="${pw / 2}" cy="${-2.8 * u}" r="${.55 * u}" fill="#8c8478"/></svg>`);
    }
  } else if (mode === 'clock') {
    const D = Math.min(W * (port ? .72 : .5), horizon * .72), cy = Math.min(horizon * .5, H * .45);
    shadowBox(cx + 1.4 * u, cy + 2.2 * u, D, D, 2.4 * u, .35, '50%');
    add(`<div class="abs" style="left:${cx - D / 2}px;top:${cy - D / 2}px;width:${D}px;height:${D}px;border-radius:50%;background:#d8d4ce;box-shadow:inset ${-.4 * u}px ${-.5 * u}px ${.3 * u}px rgba(0,0,0,.35)"></div>`);
    add(`<div class="abs art" style="left:${cx - D / 2 + .25 * u}px;top:${cy - D / 2 + .15 * u}px;width:${D - .5 * u}px;height:${D - .5 * u}px;border-radius:50%;overflow:hidden">
      <div class="fill" style="background:radial-gradient(circle at 35% 28%,rgba(255,255,255,.22),transparent 55%),radial-gradient(circle,transparent 80%,rgba(0,0,0,.12))"></div></div>`);
    const hand = (len, wd, ang, col) => `<g transform="rotate(${ang} 50 50)" filter="url(#hs)"><path d="M${50 - wd / 2} ${58} L${50 - wd * .3} ${50 - len} L${50 + wd * .3} ${50 - len} L${50 + wd / 2} 58Z" fill="${col}"/></g>`;
    add(`<svg class="abs" style="left:${cx - D / 2}px;top:${cy - D / 2}px" width="${D}" height="${D}" viewBox="0 0 100 100">
      <defs><filter id="hs"><feDropShadow dx=".6" dy="1" stdDeviation=".6" flood-opacity=".4"/></filter></defs>
      ${hand(26, 3.2, 305, '#1d1b20')}${hand(38, 2.2, 54, '#1d1b20')}${hand(40, .7, 190, '#c0392b')}
      <circle cx="50" cy="50" r="2.2" fill="#1d1b20"/><circle cx="50" cy="50" r=".8" fill="#888"/></svg>`);
    if (c.props && scene !== 'none') plant(cx + D / 2 + 8 * u, 1.1);
  } else if (mode === 'mug') {
    const R = S * .2, Hm = R * 2 * 9.5 / 8.2, e = R * .17, hw = R * .72, pad = R * .12;
    const cvw = 2 * R + hw + 2 * pad, cvh = Hm + 2 * e + 2 * pad;
    const cv = document.createElement('canvas'), dpr = window.devicePixelRatio;
    cv.width = cvw * dpr; cv.height = cvh * dpr;
    const mx = c.view === 'left' ? cx + hw / 2 : c.view === 'front' ? cx : cx - hw / 2, top = floorY - Hm - e;
    contact(mx, floorY + e * .15, R * 1.25, e * 1.3, .5);
    cv.style.cssText = `position:absolute;left:${mx - R - pad - (c.view === 'left' ? hw : 0)}px;top:${top - pad - e}px;width:${cvw}px;height:${cvh}px`;
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const X = pad + R + (c.view === 'left' ? hw : 0), T = pad + e, B = T + Hm, flip = c.view === 'left' ? -1 : 1;
    const body = () => { g.beginPath(); g.moveTo(X - R, T); g.lineTo(X - R, B); g.ellipse(X, B, R, e, 0, Math.PI, 0, true); g.lineTo(X + R, T); g.ellipse(X, T, R, e, 0, 0, Math.PI, true); g.closePath(); };
    if (c.view !== 'front') { // handle
      const hx = X + flip * R * .92, sx = flip;
      g.lineCap = 'round';
      const hp = () => { g.beginPath(); g.moveTo(hx, T + Hm * .2); g.bezierCurveTo(hx + sx * hw * 1.05, T + Hm * .12, hx + sx * hw * 1.1, T + Hm * .72, hx, T + Hm * .8); };
      hp(); g.lineWidth = R * .2; g.strokeStyle = '#cfcbc6'; g.stroke();
      hp(); g.lineWidth = R * .15; const hg = g.createLinearGradient(hx, 0, hx + sx * hw, 0); hg.addColorStop(0, '#f4f2ef'); hg.addColorStop(.6, '#ffffff'); hg.addColorStop(1, '#d9d5cf'); g.strokeStyle = hg; g.stroke();
    }
    g.save(); body(); g.fillStyle = '#f7f6f3'; g.fill(); g.clip();
    // artwork wrapped on the cylinder: print area spans 198/258 mm of the circumference
    const span = 277.2, ctr = c.view === 'left' ? -35 : c.view === 'front' ? 0 : 35, m1 = .045, m2 = .955;
    const src = document.createElement('canvas'); src.width = img.naturalWidth; src.height = img.naturalHeight;
    const sg = src.getContext('2d'); sg.drawImage(img, 0, 0);
    // crop to the 198:98 wrap ratio (cover)
    let sw = img.naturalWidth, sh = img.naturalHeight, ox = 0, oy = 0; const wr = 198 / 98;
    if (sw / sh > wr) { ox = (sw - sh * wr) / 2; sw = sh * wr; } else { oy = (sh - sw / wr) / 2; sh = sw / wr; }
    const cols = Math.ceil(2 * R * dpr);
    for (let i = 0; i < cols; i++) {
      const x = -R + (i + .5) / dpr, th = Math.asin(Math.max(-1, Math.min(1, x / R))), a = ctr + th * 180 / Math.PI, uu = (a + span / 2) / span;
      if (uu < 0 || uu > 1) continue;
      const dy = e * Math.cos(th);
      g.drawImage(src, ox + uu * (sw - 1), oy, 1, sh, X + x - .5 / dpr, T + dy + m1 * Hm, 1.6 / dpr, (m2 - m1) * Hm);
    }
    if (c.magic != null) { g.fillStyle = `rgba(22,20,24,${1 - c.magic})`; g.fillRect(0, 0, cvw, cvh); }
    // cylinder light: dark flanks, soft key light, a glaze highlight
    const lg = g.createLinearGradient(X - R, 0, X + R, 0);
    [[0, 'rgba(0,0,0,.34)'], [.12, 'rgba(0,0,0,.12)'], [.3, 'rgba(255,255,255,.08)'], [.36, 'rgba(255,255,255,.5)'], [.41, 'rgba(255,255,255,.06)'], [.7, 'rgba(0,0,0,.04)'], [.9, 'rgba(0,0,0,.2)'], [1, 'rgba(0,0,0,.42)']].forEach(([o, col]) => lg.addColorStop(o, col));
    g.fillStyle = lg; g.fillRect(X - R, 0, 2 * R, cvh);
    const vg = g.createLinearGradient(0, T, 0, B + e); vg.addColorStop(0, 'rgba(255,255,255,.05)'); vg.addColorStop(.85, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.18)');
    g.fillStyle = vg; g.fillRect(X - R, 0, 2 * R, cvh);
    g.restore();
    // rim and inside
    g.beginPath(); g.ellipse(X, T, R, e, 0, 0, Math.PI * 2); g.fillStyle = '#fbfaf8'; g.fill();
    g.beginPath(); g.ellipse(X, T + e * .04, R * .93, e * .86, 0, 0, Math.PI * 2);
    const ig = g.createLinearGradient(0, T - e, 0, T + e); ig.addColorStop(0, '#f3f1ed'); ig.addColorStop(.45, '#ddd8d1'); ig.addColorStop(1, '#a8a199'); g.fillStyle = ig; g.fill();
    g.beginPath(); g.ellipse(X, T, R, e, 0, Math.PI * .05, Math.PI * .95); g.strokeStyle = 'rgba(0,0,0,.12)'; g.lineWidth = 1; g.stroke();
    stage.appendChild(cv);
    if (c.props && scene !== 'none') plant(c.view === 'left' ? cx - R - hw - 26 * u : cx + R + hw + 4 * u, .95);
  } else if (mode === 'card') {
    const ph = Math.min(H * (port ? .36 : .5), (floorY - H * .12)), pw = ph * w / h, sx = cx - pw * .35;
    contact(sx + pw * .45, floorY + .6 * u, pw * .75, 2.2 * u, .3);
    const paper = `background:#fbf9f5;`, sd = 3 * u; // contact shadow strip lying on the table under each panel's bottom edge
    const floor = (ry, op) => `<div class="abs" style="left:${-sd * .3}px;top:${ph - sd / 2}px;width:${pw + sd * .6}px;height:${sd}px;transform-origin:${sd * .3}px 50%;transform:rotateY(${ry}deg) rotateX(90deg);
      background:radial-gradient(closest-side,rgba(20,10,0,${op}),rgba(20,10,0,${op * .35}) 60%,transparent);-webkit-mask:linear-gradient(90deg,transparent,#000 10%,#000 85%,transparent)"></div>`;
    const inner = `${floor(-50, .8)}${floor(34, .5)}
      <div class="face grain" style="left:0;top:0;width:${pw}px;height:${ph}px;transform-origin:0 50%;transform:rotateY(34deg);background:linear-gradient(90deg,#d9d4cc,#f4f1ec 45%,#fbf9f5)"></div>
      <div class="face" style="left:0;top:0;width:${pw}px;height:${ph}px;transform-origin:0 50%;transform:rotateY(34deg) rotateY(180deg);${paper}"></div>
      <div class="face art grain" style="left:0;top:0;width:${pw}px;height:${ph}px;transform-origin:0 50%;transform:rotateY(-50deg)"><div class="fill" style="background:${light}"></div></div>
      <div class="face" style="left:0;top:0;width:${pw}px;height:${ph}px;transform-origin:0 50%;transform:rotateY(-50deg) rotateY(180deg);${paper}"></div>`;
    world(sx, floorY - ph / 2, `<div class="abs p3" style="left:0;top:${-ph / 2}px;width:0;height:${ph}px">${inner}</div>`, `rotateY(0deg)`, 4.4 * ph);
    if (c.props && scene !== 'none') plant(sx - 27 * u, 1);
  } else if (mode === 'book') {
    const [pw, ph, k] = fit(W * (port ? .66 : .44), (floorY - H * .14) * .92), pd = d * k * 1.3, cy = floorY - ph / 2;
    contact(cx - pw * .08, floorY, pw * .72, 2.4 * u, .45);
    const pages = `background:repeating-linear-gradient(90deg,#f3eee4 0 1px,#e0d9cc 1px 2px),linear-gradient(90deg,rgba(0,0,0,.2),transparent 20%,transparent 80%,rgba(0,0,0,.2));background-blend-mode:multiply;`;
    const pagesTop = `background:repeating-linear-gradient(0deg,#f6f1e8 0 1px,#e2dbcf 1px 2px);`;
    const front = `background:${light},linear-gradient(90deg,rgba(0,0,0,.25),rgba(255,255,255,.12) ${pd * .35}px,rgba(0,0,0,.18) ${pd * .55}px,transparent ${pd * .9}px),url('${c.art}') center/cover;`;
    const spine = `background:linear-gradient(90deg,rgba(0,0,0,.35),rgba(255,255,255,.1) 40%,rgba(0,0,0,.25)),url('${c.art}') left/auto ${ph}px;`;
    world(cx, cy, `<div class="p3">${slab(pw, ph, pd, front, spine, pagesTop)}
       <div class="face" style="left:${pw / 2 - pd / 2 - 2}px;top:${-ph / 2 + 3}px;width:${pd - 4}px;height:${ph - 6}px;transform:rotateY(90deg) translateZ(${pw / 2 - 1}px);${pages}"></div></div>`, `rotateY(30deg)`);
    if (c.props && scene !== 'none') plant(cx + pw * .6 + 4 * u, .95);
  } else if (mode === 'tile') {
    // Print API's holder as it really is: a block of pale unfinished wood, 10 x 3.3 cm
    // (.66 x .22 of the tile's side), square edges; the tile stands in a slot in its top, its bottom 13 mm (.085) hidden
    // behind the block's front and its bottom corners showing either side. A near-level camera: the block's top is a sliver.
    const ts = Math.min(H * .42, W * (port ? .56 : .36)), pd = ts * .035, bw = ts * .66, bh = ts * .22, bd = ts * .2;
    const by = ts / 2 - ts * .085 + bh / 2, cy = floorY - by - bh / 2; // block centre below the tile's centre; table under the block
    contact(cx, floorY + .2 * u, bw * .62, 1.6 * u, .5);
    contact(cx, floorY - .2 * u, ts * .62, 1.4 * u, .14); // the tile's corners over the table, out past the block
    const gloss = `linear-gradient(118deg,rgba(255,255,255,0) 28%,rgba(255,255,255,.2) 47%,rgba(255,255,255,0) 68%)`;
    const glaze = `background:${gloss},url('${c.art}') center/cover;border-radius:${ts * .006}px;box-shadow:inset 0 0 0 ${Math.max(1, ts * .002)}px rgba(255,255,255,.75),0 0 0 .5px rgba(0,0,0,.12)`;
    const lines = [[.18, .04, .12], [.31, -.06, .09], [.47, .03, .13], [.66, -.05, .09], [.83, .06, .12]] // long faint grain
      .map(([at, b, a]) => `<path d='M0 ${at * 100} C35 ${(at + b) * 100} 65 ${(at - b) * 100} 100 ${(at + b * .4) * 100}' stroke='rgba(160,110,65,${a})' stroke-width='${Math.max(1, ts * .0025)}' fill='none' vector-effect='non-scaling-stroke'/>`).join('');
    const woodLines = enc(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>${lines}</svg>`);
    const wood = `linear-gradient(#edd3b5,#e7c9a6 55%,#dcbb95)`;
    const front = `background:linear-gradient(rgba(255,246,234,.6),rgba(255,246,234,0) ${Math.max(1.5, ts * .008)}px),${woodLines} 0 0/100% 100%,${wood}`;
    const ends = `background:linear-gradient(rgba(120,80,40,.16),rgba(120,80,40,.16)),${wood}`; // end grain a shade darker
    const top = `background:linear-gradient(#f4e3cc,#ecd5b8)`;
    world(cx, cy, `<div class="p3">${slab(ts, ts, pd, glaze, `background:#ece8e2`, `background:#f6f3ee`)}
      <div class="p3 abs" style="left:0;top:0;transform:translateY(${by}px)">${slab(bw, bh, bd, front, ends, top)}</div></div>`, `rotateY(6deg)`);
    if (c.props && scene !== 'none') plant(cx + ts * .5 + 6 * u, .95);
  } else if (mode === 'postcard') {
    const [pw, ph] = fit(W * (port ? .72 : .5), H * .55);
    if (c.props && scene !== 'none') sprig(cx + pw * .3, H / 2 - ph * 1.05 - 10 * u, 1.5, 10);
    const back = `<div style="position:absolute;left:52%;top:18%;width:1px;height:68%;background:#bbb"></div>${[0, 1, 2, 3].map(i => `<div style="position:absolute;left:57%;right:6%;top:${46 + i * 11}%;height:1px;background:#c8c2b8"></div>`).join('')}
      <div style="position:absolute;right:6%;top:8%;width:13%;height:${13 * w / h}%;border:1px dashed #c8c2b8"></div>`;
    add(`<div class="abs grain" style="left:${cx - pw * .55}px;top:${H / 2 - ph * .42}px;width:${pw}px;height:${ph}px;background:#fbf9f4;transform:rotate(-9deg);box-shadow:${.6 * u}px ${1 * u}px ${1.6 * u}px rgba(0,0,0,.28),0 0 1px rgba(0,0,0,.2)">${back}</div>`);
    add(`<div class="abs art grain" style="left:${cx - pw * .42}px;top:${H / 2 - ph * .58}px;width:${pw}px;height:${ph}px;transform:rotate(4deg);box-shadow:${.8 * u}px ${1.4 * u}px ${2.2 * u}px rgba(0,0,0,.32),0 0 1px rgba(0,0,0,.25)"><div class="fill" style="background:${light}"></div></div>`);
    if (c.props && scene !== 'none') pencil(cx - pw * .7, H / 2 + ph * .62, 24 * u, -14);
  } else if (mode === 'puzzle') {
    const [pw, ph] = fit(W * .72, H * .74);
    const n = c.pieces, cols = Math.max(2, Math.round(Math.sqrt(n * w / h))), rows = Math.max(2, Math.round(n / cols));
    const qw = pw / cols, qh = ph / rows;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const hs = [...Array(rows + 1)].map(() => [...Array(cols)].map(() => rnd() < .5 ? 1 : -1));
    const vs = [...Array(rows)].map(() => [...Array(cols + 1)].map(() => rnd() < .5 ? 1 : -1));
    const edge = (x0, y0, x1, y1, s) => { // jigsaw edge from p0 to p1, tab on side s
      const dx = x1 - x0, dy = y1 - y0, nx = -dy * s, ny = dx * s, P = (t, q) => `${(x0 + dx * t + nx * q).toFixed(1)} ${(y0 + dy * t + ny * q).toFixed(1)}`;
      return `L${P(.36, 0)} C${P(.44, 0)} ${P(.3, .24)} ${P(.5, .24)} C${P(.7, .24)} ${P(.56, 0)} ${P(.64, 0)} L${P(1, 0)} `;
    };
    let lines = '';
    for (let r = 1; r < rows; r++) { lines += `M0 ${r * qh} `; for (let q = 0; q < cols; q++) lines += edge(q * qw, r * qh, (q + 1) * qw, r * qh, hs[r][q]); }
    for (let q = 1; q < cols; q++) { lines += `M${q * qw} 0 `; for (let r = 0; r < rows; r++) lines += edge(q * qw, r * qh, q * qw, (r + 1) * qh, vs[r][q]); }
    const piece = (q, r) => { const X0 = q * qw, Y0 = r * qh, X1 = X0 + qw, Y1 = Y0 + qh;
      const E = (a, b, cc, dd, s, border) => border ? `L${cc} ${dd} ` : edge(a, b, cc, dd, s);
      return `M${X0} ${Y0} ` + E(X0, Y0, X1, Y0, hs[r][q], r === 0) + E(X1, Y0, X1, Y1, vs[r][q + 1], q === cols - 1) + E(X1, Y1, X0, Y1, -hs[r + 1][q], r === rows - 1) + E(X0, Y1, X0, Y0, -vs[r][q], q === 0) + 'Z'; };
    const out = [[cols - 2, rows - 2], [cols - 3, rows - 2], [cols - 2, rows - 3]].filter(([q, r]) => q > 0 && r > 0);
    const artImg = `<image href="${c.art}" width="${pw}" height="${ph}" preserveAspectRatio="xMidYMid slice"/>`;
    const px = cx - pw / 2, py = H / 2 - ph / 2;
    add(`<svg class="abs" style="left:${px}px;top:${py}px;overflow:visible;filter:drop-shadow(${.4 * u}px ${.7 * u}px ${.8 * u}px rgba(0,0,0,.35))" width="${pw}" height="${ph}">
      <defs><clipPath id="board"><path d="M0 0H${pw}V${ph}H0Z ${out.map(([q, r]) => piece(q, r)).join(' ')}" clip-rule="evenodd"/></clipPath>
      ${out.map(([q, r], i) => `<clipPath id="pc${i}"><path d="${piece(q, r)}"/></clipPath>`).join('')}</defs>
      <g clip-path="url(#board)">${artImg}<rect width="${pw}" height="${ph}" fill="url(#none)"/>
        <path d="${lines}" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="1.2" transform="translate(.8 .8)"/>
        <path d="${lines}" fill="none" stroke="rgba(0,0,0,.4)" stroke-width="1"/></g></svg>`);
    out.forEach(([q, r], i) => { // loose pieces nudged out of their holes
      const ox = pw - (q + .5) * qw + [3, 7, 4.5][i] * u, oy = ph * [.55, .7, .82][i] - (r + .5) * qh, rot = [18, -25, 40][i];
      add(`<svg class="abs" style="left:${px + ox}px;top:${py + oy}px;overflow:visible;filter:drop-shadow(${.3 * u}px ${.5 * u}px ${.4 * u}px rgba(0,0,0,.45))" width="${pw}" height="${ph}">
        <g transform="rotate(${rot} ${(q + .5) * qw} ${(r + .5) * qh})"><g clip-path="url(#pc${i})">${artImg}<path d="${piece(q, r)}" fill="rgba(255,255,255,.06)"/></g></g></svg>`);
    });
    if (c.props && scene !== 'none') sprig(px - 12 * u, py - 8 * u, 1.2, 190);
  }
  return warn;
}
