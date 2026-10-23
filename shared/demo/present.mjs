#!/usr/bin/env node
// node shared/demo/present.mjs deck.json [--out presentation.mp4] [--fps 30] [--workers 3] [--label "Made with AI"]
// Renders a 16:9 presentation (1920x1080) from a manifest: sections play one after another, each for its
// `dur` seconds (ads and recordings default to their own length), over one music track. The page is
// slides.html unless the manifest names its own ("page"). Manifest format: see shared/demo/README.md.
// Paths in the manifest are relative to the manifest file. "prices": the keys of the prices it shows, in its "lang":
// `{price:key}` in its words, demo.price(key) in its pages (prices.mjs).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { args, render, beatsFor, urlPath, probe, HERE } from './core.mjs';
import { keysOf, pricesFor } from './prices.mjs';

const a = args();
const file = a._[0];
if (!file) { console.error('usage: node shared/demo/present.mjs deck.json [--out presentation.mp4] [--fps 30] [--workers n]'); process.exit(1); }
const manifest = JSON.parse(readFileSync(file, 'utf8'));
const prices = await pricesFor(keysOf(manifest.prices), manifest.lang);
function priceText(token, key) {
  const price = prices.find((p) => p.key === key);
  if (!price) throw new Error(`${token}: name ${key} in the deck's "prices"`);
  return price.text;
}
const m = JSON.parse(JSON.stringify(manifest), (k, v) => (typeof v === 'string' ? v.replace(/\{price:([^}]+)\}/g, priceText) : v));
const rel = (p) => p && resolve(dirname(file), p);
const url = (p) => p && (/^(https?:|data:|\/)/.test(p) ? p : urlPath(rel(p)));

let t = 0;
const sections = m.sections.map((s, i) => {
  const src = s.src && rel(s.src);
  const dur = Number(s.dur ?? (src ? probe(src).duration + (s.lead ?? 0) + (s.tail ?? 0.6) : 5));
  if (!(dur > 0)) throw new Error(`section ${i} (${s.type}): no dur`);
  const out = { ...s, start: t, dur, src: url(s.src), image: url(s.image), html: url(s.html) };
  t += dur;
  return out;
});

const audio = rel(m.audio);
const audioStart = Number(m.audioStart ?? 0);
const beats = beatsFor(audio, m.bpm, m.offset);
const loop = !!(m.loop ?? beats?.loop);
const label = a.label ?? m.label;
const out = a.out ? resolve(a.out) : rel(m.out) ?? file.replace(/\.json$/, '') + '.mp4';
const fps = Number(a.fps ?? m.fps ?? 30);

// How loud the sound is in each frame, a digit 0 (quiet) to 9, for the hosts' mouths: speech at podcast loudness
// spans about -45 to -15 dB a frame.
function levels(audio, from, frames) {
  const rate = 8000;
  const args = ['-v', 'error', '-ss', String(from), '-i', audio, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'];
  const pcm = execFileSync('ffmpeg', args, { maxBuffer: 1 << 30 });
  const s = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  let digits = '';
  for (let f = 0; f < frames; f++) {
    const [i0, i1] = [f, f + 1].map(k => Math.min(s.length, Math.round((k * rate) / fps)));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += s[i] * s[i];
    const db = 20 * Math.log10(Math.sqrt(sum / Math.max(1, i1 - i0)) / 32768 + 1e-9);
    digits += Math.max(0, Math.min(9, Math.round(((db + 45) / 30) * 9)));
  }
  return digits;
}

await render({
  page: m.page ? url(m.page) : urlPath(join(HERE, 'slides.html')), out, width: 1920, height: 1080,
  fps, duration: t, audio, audioStart, loop, beats,
  label: label === false || label === '' ? '' : label ?? 'Made with AI', labelPos: m.labelPos ?? 'top-right',
  workers: a.workers, crf: Number(m.crf ?? 20), maxrate: m.maxrate ?? '8M', level: '4.2',
  // hosts: who speaks, drawn at the foot of every slide
  data: {
    // css: one stylesheet or a list, each over the last; script: a module the page imports once its slides are built
    title: m.title, css: [m.css].flat().filter(Boolean).map(url), script: url(m.script), theme: m.theme, sections, captions: m.captions, // captions:
    hosts: m.hosts,
    levels: m.hosts?.length && audio ? levels(audio, audioStart, Math.round(t * fps)) : undefined,
  },
  prices: keysOf(m.prices), lang: m.lang,
});
