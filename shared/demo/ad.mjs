#!/usr/bin/env node
// Renders an HTML scene into a 9:16 ad film and a square one beside it (README.md, "ad.mjs: the scene contract")
import { resolve, dirname } from 'node:path';
import { args, render, inlineConfig, beatsFor, urlPath, probe } from './core.mjs';
import { keysOf } from './prices.mjs';

const a = args();
const scene = a._[0];
if (!scene) { console.error('usage: node shared/demo/ad.mjs scene.html [--out ad.mp4] [--duration s] [--audio track.wav]'); process.exit(1); }
const inl = inlineConfig(scene);
const rel = (p) => p && resolve(dirname(scene), p);
const pick = (k, alt) => a[k] ?? a[alt] ?? inl[k] ?? inl[alt];
const audio = a.audio ? resolve(a.audio) : rel(inl.audio);
const audioStart = Number(pick('audio-start', 'audioStart') ?? 0);
const beats = beatsFor(audio, pick('bpm'), pick('offset'));
const duration = Number(pick('duration') ?? (audio ? Math.min(30, probe(audio).duration - audioStart) : 15));
const out = a.out ? resolve(a.out) : rel(inl.out) ?? scene.replace(/\.html?$/, '.mp4');
const lang = pick('lang');
if (lang !== undefined && !/^[a-z]{2}$/.test(lang)) { console.error(`--lang takes a two-letter language code, like nl, not ${JSON.stringify(lang)}`); process.exit(1); }
const named = (base) => (lang ? `${base}.${lang}.mp4` : `${base}.mp4`);
const label = pick('label');
const width = Number(pick('width') ?? 1080), height = Number(pick('height') ?? 1920);
const inset = pick('label-inset', 'labelInset'); // [edge, side] in 1080-wide px: how far the label sits from the edges
const labelInset = inset == null ? undefined
  : (Array.isArray(inset) ? inset : String(inset).split(',')).map((n) => Number(String(n).trim() || NaN)); // '' isn't 0
// A typo guard, in the label's 1080-wide px (runtime.js scales by k): the default one-line label (42 px tall) fits
// in the frame, starting no further in from its side than the middle. runtime.js keeps any label whole by its box.
const k = Math.min(width, height) / 1080, maxEdge = Math.floor(height / k - 42), maxSide = Math.floor(width / k / 2);
if (labelInset && (labelInset.length !== 2 || !labelInset.every((n) => Number.isFinite(n) && n >= 0)
  || labelInset[0] > maxEdge || labelInset[1] > maxSide)) {
  console.error(`--label-inset takes two numbers, edge,side (like 280,72), within the frame `
    + `(edge up to ${maxEdge}, side up to ${maxSide} here), not ${JSON.stringify(inset)}`); process.exit(1);
}

// Two films from one scene: the vertical one for social, and a square one for the product page,
// on the scene's own background colour (or `square`, any CSS background). Each film's recipe renders only itself.
const square = pick('square'); // false: no square film
const only = pick('only');
if (only !== undefined && !['vertical', 'square'].includes(only)) { console.error(`--only takes vertical or square, not ${JSON.stringify(only)}`); process.exit(1); }
const formats = only ? [only] : ['vertical', ...(square !== false && height > width ? ['square'] : [])];
const ownArgs = process.argv.slice(1).filter((arg, i, all) => !arg.startsWith('--only') && all[i - 1] !== '--only');
const film = {
  page: urlPath(scene), width, height,
  fps: Number(pick('fps') ?? 30), duration, audio, audioStart, beats,
  label: label === false || label === '' ? '' : label ?? 'Made with AI', labelPos: pick('label-pos', 'labelPos'), labelInset,
  workers: a.workers, crf: Number(pick('crf') ?? 20), maxrate: pick('maxrate') ?? '8M', level: '4.2',
  data: lang ? { ...inl.data, lang } : inl.data, prices: keysOf(pick('prices')), lang: lang ?? inl.data?.lang,
  social: pick('social') !== false,
};
for (const format of formats) {
  await render({ ...film, format, out: named(out.replace(/\.mp4$/i, '') + (format === 'square' ? '-square' : '')),
    fill: typeof square === 'string' ? square : undefined, recipe: ['node', ...ownArgs, '--only', format] });
}
