#!/usr/bin/env node
// Builds a deck spec (JSON) into one self-contained HTML page: CSS and script inlined, media linked relatively.
//   node shared/deck/build.mjs <deck.json> [--out <index.html>]
// The format is in shared/deck/README.md. Checks: media exists, no outside URLs for media, stacked charts add up.
import { readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parts } from './inlined.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const specPath = argv.find((a) => !a.startsWith('--'));
if (!specPath) { console.error('usage: node shared/deck/build.mjs <deck.json> [--out index.html]'); process.exit(1); }
const out = resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(dirname(specPath), 'index.html'));
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const base = dirname(out);
const problems = [], media = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const named = ['gold', 'red', 'blue', 'green', 'purple', 'orange', 'ink', 'cream', 'paper'];
const color = (c) => (named.includes(c) ? `var(--${c})` : c);
const money = (v, unit = spec.unit ?? '€') => `${v < 0 ? '−' : ''}${unit}${Math.abs(v).toFixed(2)}`;

function src(path, where) { // media is linked relative to the page, and must exist
  if (/^[a-z]+:/i.test(path) || path.startsWith('//')) { problems.push(`${where}: outside URL ${path}; copy it next to the deck`); return esc(path); }
  try { statSync(join(base, path)); media.add(resolve(base, path)); } catch { problems.push(`${where}: missing ${path}`); }
  return esc(path);
}

// Every video has a poster: a browser that won't autoplay (iOS in Low Power
// Mode) showed an empty box until tapped. One the spec doesn't name is the video's first frame, made here into
// posters/ next to the page (named by the video's contents, so a re-recorded clip gets a new one; unused ones go).
const posters = new Set(), posterDir = join(base, 'posters');
function firstFrame(video, where) {
  const file = resolve(base, video);
  if (!existsSync(file)) return null; // src() has already reported it
  const name = `${basename(video, extname(video))}-${createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 8)}.jpg`;
  posters.add(name);
  if (!existsSync(join(posterDir, name))) {
    mkdirSync(posterDir, { recursive: true });
    try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-frames:v', '1', '-vf', "scale='min(720,iw)':-2", '-q:v', '4', join(posterDir, name)]); }
    catch (e) { problems.push(`${where}: no poster for ${video} (ffmpeg: ${String(e.stderr ?? e.message).trim()})`); return null; }
  }
  return `posters/${name}`;
}

const frameOf = (m) => m.frame ?? (m.video ? 'phone' : 'photo');
const phone = (m) => frameOf(m) === 'phone'; // two pictures: duo with a phone, else a pair

// The poster is an <img> in the frame that gives it its size; the video lies over it, shown once it really plays.
function figure(m, where) {
  const frame = frameOf(m);
  const alt = esc(m.alt ?? m.label ?? '');
  const poster = m.video && (m.poster ? src(m.poster, where) : esc(firstFrame(m.video, where) ?? ''));
  const inner = m.video
    ? `${poster ? `<img class="poster" src="${poster}" alt="" decoding="async" draggable="false">` : ''}<video data-src="${src(m.video, where)}"${poster ? ` poster="${poster}"` : ''} playsinline muted ${m.loop === false ? '' : 'loop '}preload="none"${m.sound ? ' data-sound' : ''} aria-label="${alt}"></video>
        ${m.sound ? '<button class="sound" type="button">Tap for sound</button>' : ''}<button class="play" type="button" aria-label="Play">▶</button>`
    : `<img src="${src(m.image, where)}" alt="${alt}" loading="lazy" decoding="async" draggable="false">`;
  return `<figure class="${frame}${m.video ? ' video' : ''}"><div class="shell">${inner}<span class="zoom" aria-hidden="true"></span></div>${m.label ? `<figcaption>${esc(m.label)}</figcaption>` : ''}</figure>`;
}

// Parts of one whole, e.g. a price split into VAT, costs and margin. Grey steps for the parts, the accent for the key one.
const greys = ['#e6ddee', '#b3a5cc', '#8272a6', '#524673', '#342b50']; // recessive ink steps, adjacent pairs ΔE ≥ 15 (dataviz validator)
function stack(c, where) {
  const sum = c.parts.reduce((a, p) => a + p.value, 0);
  if (c.total != null && Math.abs(sum - c.total) > 0.005) problems.push(`${where}: parts add up to ${sum.toFixed(2)}, not ${c.total}`);
  let g = 0;
  const parts = c.parts.map((p, k) => ({ ...p, k, c: p.key ? (color(c.color ?? 'green')) : greys[g++ % greys.length] }));
  return `<div class="chart">
    <div class="total"><span>${esc(c.label ?? '')}</span><span>${money(c.total ?? sum, c.unit)}</span></div>
    <div class="stack" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${money(p.value, c.unit)}`).join(', '))}">${parts.map((p) =>
      `<i data-k="${p.k}" style="flex:${p.value} 1 0;--c:${p.c}" title="${esc(p.label)}: ${money(p.value, c.unit)}"></i>`).join('')}</div>
    <ul class="legend">${parts.map((p) => `<li data-k="${p.k}" class="${p.key ? 'key' : ''}" style="--c:${p.c}"><span>${esc(p.label)}</span><b>${money(p.value, c.unit)}</b></li>`).join('')}</ul>
  </div>`;
}

// One measure across a few items, as horizontal bars with the value at the end.
function bars(c) {
  const max = c.max ?? Math.max(...c.rows.map((r) => r.value));
  return `<div class="chart bars">${c.rows.map((r, k) => `<div class="bar" data-k="${k}">
      <div class="name">${esc(r.label)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}${r.tag ? `<span class="tag">${esc(r.tag)}</span>` : ''}</div>
      <div class="track"><div class="fill" style="--v:${(r.value / max).toFixed(4)};--c:${color(r.color ?? c.color ?? 'blue')}"></div>
        <span class="val">${esc(r.display ?? money(r.value, c.unit))}</span></div></div>`).join('')}</div>`;
}

function slide(s, chapter, where) {
  const ms = [].concat(s.media ?? []);
  const vis = s.chart ? (s.chart.type === 'bars' ? bars(s.chart) : stack(s.chart, where)) : ms.map((m) => figure(m, where)).join('');
  const cls = ['slide', s.hero ? 'hero' : vis && !s.cards ? 'split' : 'full', s.wide || s.chart ? 'wide' : '', s.class ?? ''].filter(Boolean).join(' ');
  const accent = s.accent ?? chapter.accent;
  const H = s.hero ? 'h1' : 'h2';
  // The text is in two parts, the heading and the rest, so a phone held upright
  // can show the heading, then the visual large, then the rest (scrolling if it must) instead of a stamp-sized visual.
  const head = `${s.kicker ? `<p class="kicker">${esc(s.kicker)}</p>` : ''}
      ${s.title ? `<${H}>${esc(s.title)}</${H}>` : ''}
      ${s.sub ? `<p class="sub">${esc(s.sub)}</p>` : ''}`;
  const more = `${s.points?.length ? `<ul class="points">${s.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${s.cards?.length ? `<div class="cards" style="--n:${s.cards.length}">${s.cards.map((c) => `<div class="card">
        ${c.label ? `<div class="label">${esc(c.label)}</div>` : ''}${c.big ? `<div class="big">${esc(c.big)}</div>` : ''}
        ${c.text ? `<p>${esc(c.text)}</p>` : ''}${c.source ? `<small>${esc(c.source)}</small>` : ''}</div>`).join('')}</div>` : ''}
      ${s.button ? `<a class="btn" href="${esc(s.button.href)}" target="_blank" rel="noopener">${esc(s.button.label)} <span aria-hidden="true">→</span>${s.button.small ? `<small>${esc(s.button.small)}</small>` : ''}</a>` : ''}
      ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}`;
  return `<section class="${cls}" data-chapter="${esc(chapter.name)}"${accent ? ` style="--accent:${color(accent)}"` : ''} aria-roledescription="slide">
    <div class="body"><div class="head">${head}</div>${vis ? `<div class="vis${ms.length !== 2 ? '' : ms.some(phone) ? ' duo' : ' pair'}">${vis}</div>` : ''}${more.trim() ? `<div class="more">${more}</div>` : ''}</div>
  </section>`;
}

const chapters = spec.chapters ?? [{ name: spec.title, slides: spec.slides }];
let n = 0;
// Transition sounds: the demo kit's foley player, inlined (the page loads nothing), so a slide lands with a card's
// slide instead of a jingle (board, cycle 1: satisfying sounds, not music). "sfx": false turns them off.
// The parts come from inlined.mjs, so the checks can tell a deck built on an old kit.
const inline = parts(spec.sfx !== false);
const html = chapters.flatMap((c) => c.slides.map((s) => slide(s, c, `slide ${++n} (${c.name})`))).join('\n');
const icon = (btn) => `<svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16" fill="currentColor" shape-rendering="crispEdges">${btn}</svg>`;

// The controls are a band of their own below the slides (#bar), never over them; #menu lists every slide; #zoom shows
// a picture or video as large as the screen allows.
// No band above the slides (it was blank on a phone and clipped a scrolled
// slide); the deck's title is in #bar.
// script-src 'self' lets in review mode's /__review/review.js, which the cycles site adds to every page it serves, so the
// board can pin a note on a slide as on a demo; the deck itself still loads no script
const page = `<!doctype html>
<html lang="${esc(spec.lang ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'">
<meta name="theme-color" content="#1d1a2f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex">
<title>${esc(spec.title)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(readFileSync(join(here, 'logo.svg'), 'utf8'))}">
<style>
${inline['deck.css']}
${spec.css ? readFileSync(resolve(dirname(specPath), spec.css), 'utf8') : ''}
</style>
</head>
<body>
<!-- Built by shared/deck/build.mjs from ${esc(relative(base, resolve(specPath)))}. Edit the spec and rebuild; don't edit this file. -->
<main id="deck" aria-live="polite">
${html}
</main>
<footer id="bar">
  <div class="brand">${readFileSync(join(here, 'logo.svg'), 'utf8').replace('<svg ', '<svg aria-hidden="true" ')}<span>${esc(spec.title)}</span></div>
  <div id="progress" aria-label="Chapters"></div>
  <div id="hint">${esc(spec.hint ?? 'Swipe, tap or use the arrow keys')}</div>
  <div class="tools">
    <button id="snd" type="button" aria-pressed="true" aria-label="Sound" title="Sound (M)">${icon('<path d="M2 6h3l4-3v10l-4-3H2z"/><path d="M11 5h1v6h-1zM13 3h1v10h-1z"/>')}</button>
    <button id="fs" type="button" hidden aria-label="Full screen" title="Full screen">${icon('<path d="M1 1h5v2H3v3H1zM10 1h5v5h-2V3h-3zM1 10h2v3h3v2H1zM13 10h2v5h-5v-2h3z"/>')}</button>
    <button id="chap" type="button" aria-label="All slides" title="All slides (C)">${icon('<path d="M1 2h14v2H1zM1 7h14v2H1zM1 12h14v2H1z"/>')}</button>
  </div>
  <div id="nav">
    <button id="prev" type="button" aria-label="Previous slide">${icon('<path d="M10 2h2v2h-2v2H8v2h2v2h2v2h-2v2H8v-2H6v-2H4V6h2V4h2V2z"/>')}</button>
    <button id="count" type="button" aria-label="All slides"></button>
    <button id="next" type="button" aria-label="Next slide">${icon('<path d="M4 2h2v2h2v2h2v4H8v2H6v2H4v-2h2v-2h2V6H6V4H4z"/>')}</button>
  </div>
</footer>
<div id="menu" hidden role="dialog" aria-label="All slides"><ol></ol></div>
<div id="zoom" hidden role="dialog" aria-label="Enlarged"><button class="close" type="button" aria-label="Close">${icon('<path d="M2 2h3v1h1v1h1v1h2V4h1V3h1V2h3v3h-1v1h-1v1h-1v2h1v1h1v1h1v3h-3v-1h-1v-1h-1v-1H7v1H6v1H5v1H2v-3h1v-1h1V9h1V7H4V6H3V5H2z"/>')}</button><div class="stage"></div></div>
<script>
${inline.kit}
${inline['deck.js']}
</script>
</body>
</html>
`;
writeFileSync(out, page);
// Posters this build made for videos no longer in the deck (or re-recorded) go: only the made ones' names
// (<video>-<8 hex>.jpg), never a file the deck links (a spec's own poster may live in posters/ too), and only after
// a clean build, so a missing file doesn't cost a poster that is still wanted.
if (!problems.length && existsSync(posterDir)) for (const f of readdirSync(posterDir)) {
  if (/-[0-9a-f]{8}\.jpg$/.test(f) && !posters.has(f) && !media.has(join(posterDir, f))) rmSync(join(posterDir, f));
}

const own = [...media].filter((f) => !relative(base, f).startsWith('..'));
const size = (fs) => fs.reduce((a, f) => a + statSync(f).size, 0);
console.log(`${out}: ${n} slides, page ${(page.length / 1024).toFixed(0)} KB, media in the folder ${(size(own) / 1e6).toFixed(1)} MB, linked from outside it ${(size([...media].filter((f) => !own.includes(f))) / 1e6).toFixed(1)} MB`);
if (problems.length) { console.error(problems.map((p) => `  ! ${p}`).join('\n')); process.exit(2); }
