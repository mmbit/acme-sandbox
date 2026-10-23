#!/usr/bin/env node
// harsh.mjs: measures how harsh a sound is, so a grating one can't slip into the kit or an ad unnoticed.
//   node shared/demo/harsh.mjs                  every foley.js sound and synth.mjs effect, and every call the company's
//                                               products play (company/sounds.json), against the bars of its kind
//   node shared/demo/harsh.mjs --products f.mjs [more…]   the calls a product's own files play (an app's list, an ad's track)
//   node shared/demo/harsh.mjs a.wav [more…]    a recording or a track: as a whole, then its sharpest 0.4 s windows
// Measured against twelve real recordings, of paper slid gently across a table and of a cardboard box or toolbox dragged
// over tile or concrete. Real paper is the brighter of the two (2.9 to 3.7 acum against 1.7 to 2.5), so brightness is
// not what grates. Weight is: the energy under 500 Hz of a heavy thing shoved (paper -17 to -39 dB, box -0.6 to -6.9).
// Then crackle (clicks standing out of the rub; paper 0 to 2 a second), judder (the level shaking 15 to 150 times a
// second: synthetic stick-slip, a fingernail on a chalkboard), a narrow whistle in the noise (a resonant filter
// squeals), and sharpness past the brightest real paper.
import { existsSync, globSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// What each kind of sound may reach. A glide is a movement (a slide with where it stops, a whoosh, and the lead-in of
// a card's swish or of the slide into a lock): it must be light and smooth like the paper. A texture
// is noise a material makes (pencil, cloth, ink, and every noise sound as a whole, its landing included), allowed more
// grit. A crunch is a burst of cracks, and a tone (struck and tuned sounds) rings at its own modes: their clicks and
// narrow peaks are their design, so only their brightness is held.
//   sharpness: acum (DIN 45692 weighting; narrow noise at 1 kHz is 1, pink noise 2.2, white noise 3, gentle paper to 3.7)
//   squeal: dB a 1/12-octave band stands over its octave, 1.5 to 8 kHz (plain noise and the recordings: 4 to 5)
//   judder: % modulation depth of the 1-8 kHz envelope at 15-150 Hz, where steady for 80 ms (plain noise 8 to 12, the
//           recordings 14 to 31; a sound with no such stretch reads 0: too short to judder, held by the rest)
//   crackle: clicks a second standing 2.5 times over the 30 ms around them, but for the onset and the hit
//   weight: dB of the energy at 50-500 Hz over all of it
//   twang: a plucked string's note, dB of its energy above six times its pitch (1 kHz at least) over all of it
export const BARS = {
  glide: { sharpness: 3.8, squeal: 9, judder: 36, crackle: 3, weight: -12 },
  texture: { sharpness: 3.8, squeal: 9, judder: 40 },
  crunch: { sharpness: 3.8, squeal: 9 },
  tone: { sharpness: 3.8 },
  string: { sharpness: 3.8, twang: -16 }, // (strings below)
};

// The measures of a stereo buffer over its loud part (frames within 15 dB of the loudest); presence (dB of 2-5 kHz over
// 150 Hz-2 kHz) and centroid (Hz) are reported, not held. hit: seconds from `from` to the sound's hit, if it has one;
// f0: a note's pitch (Hz), for its twang.
// Each channel's power is measured and the two averaged, so sound in opposite phase on the two sides doesn't cancel.
export function harshness({ L, R, sr }, { from = 0, to = L.length, hit = null, f0 = null } = {}) {
  const l = L.subarray(from, to), r = R.subarray(from, to), N = 2048, hop = N / 4, w = hann(N), hz = sr / N, frames = [];
  for (let i = -hop * 3; i < l.length; i += hop) { // starts before the sound so its first attack is in a frame's middle
    const P = new Float64Array(N / 2); let e = 0;
    for (const x of [l, r]) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let j = 0; j < N; j++) { const k = i + j; re[j] = k >= 0 && k < x.length ? x[k] * w[j] : 0; }
      fft(re, im); for (let k = 1; k < N / 2; k++) P[k] += (re[k] * re[k] + im[k] * im[k]) / 2;
    }
    for (let k = 1; k < N / 2; k++) e += P[k];
    frames.push({ P, e });
  }
  const top = highest(frames.map(f => f.e)); if (!(top > 0)) return null;
  const loud = frames.filter(f => f.e > top * 10 ** -1.5), total = loud.reduce((s, f) => s + f.e, 0);
  const avg = new Float64Array(N / 2); for (const f of loud) for (let k = 0; k < N / 2; k++) avg[k] += f.P[k] / total;
  const band = (a, b) => { let s = 0; for (let k = Math.ceil(a / hz); k <= Math.min(N / 2 - 1, b / hz); k++) s += avg[k]; return s; };
  const dB = (a, b) => 10 * Math.log10(a / (b || 1e-30) + 1e-30);
  let squeal = 0, num = 0; for (const f of loud) squeal += (whistle(f.P, hz) * f.e) / total;
  avg.forEach((p, k) => (num += p * k * hz));
  const env = envelope(l, r, sr);
  return { sharpness: sharpness(avg, hz), squeal, judder: judder(env, sr), crackle: crackle(env, sr, hit), weight: dB(band(50, 500), band(50, 16000)),
    presence: dB(band(2000, 5000), band(150, 2000)), centroid: num / band(0, sr / 2),
    ...(f0 ? { twang: dB(band(Math.max(1000, 6 * f0), 16000), band(50, 16000)) } : {}) };
}

// The largest value; a loop, as a recording of minutes holds too many values to spread into Math.max's arguments.
const highest = values => values.reduce((a, v) => (v > a ? v : a), 0);
const hann = N => Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
function fft(re, im) { // in place, radix 2
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= N; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < N; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const u = i + k, v = u + len / 2, tr = re[v] * cr - im[v] * ci, ti = re[v] * ci + im[v] * cr;
        re[v] = re[u] - tr; im[v] = im[u] - ti; re[u] += tr; im[u] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
}
function whistle(P, hz) { // the most a 1/12-octave band stands over its octave (dB), 1.5 to 8 kHz
  const cum = new Float64Array(P.length + 1); for (let k = 0; k < P.length; k++) cum[k + 1] = cum[k] + P[k];
  const mean = (a, b) => { const i = Math.max(1, Math.round(a / hz)), j = Math.min(P.length - 1, Math.round(b / hz)); return j > i ? (cum[j + 1] - cum[i]) / (j + 1 - i) : 0; };
  let best = 0;
  for (let f = 1500; f <= 8000; f *= Math.pow(2, 1 / 48)) {
    const narrow = mean(f * 2 ** (-1 / 24), f * 2 ** (1 / 24)), wide = mean(f * 2 ** (-1 / 2), f * 2 ** (1 / 2));
    if (wide > 0) best = Math.max(best, 10 * Math.log10(narrow / wide));
  }
  return best;
}
function envelope(l, r, sr) { // the 1-8 kHz band's level (both sides, smoothed at 300 Hz) and its 15-150 Hz movement
  const band = () => [svf(sr, 1000, 'hp'), svf(sr, 1000, 'hp'), svf(sr, 8000, 'lp'), svf(sr, 8000, 'lp')], fl = band(), fr = band();
  const s = [svf(sr, 300, 'lp'), svf(sr, 300, 'lp')], m = [svf(sr, 15, 'hp'), svf(sr, 15, 'hp'), svf(sr, 150, 'lp'), svf(sr, 150, 'lp')];
  const level = new Float64Array(l.length), move = new Float64Array(l.length);
  for (let i = 0; i < l.length; i++) {
    let a = l[i], b = r[i]; for (const q of fl) a = q(a); for (const q of fr) b = q(b);
    let e = Math.sqrt(Math.max(0, s[1](s[0](a * a + b * b))));
    level[i] = e;
    for (const q of m) e = q(e); move[i] = e;
  }
  return { level, move };
}
function svf(sr, fc, kind) { // a 2-pole state-variable filter, Q 0.707, one sample per call
  const g = Math.tan((Math.PI * Math.min(fc, sr * 0.45)) / sr), k = Math.SQRT2, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
  let ic1 = 0, ic2 = 0;
  return x => { const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3; ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2; return kind === 'lp' ? v2 : x - k * v1 - v2; };
}

const BARK = [20, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500];
function sharpness(P, hz) { // Zwicker's specific loudness ~ band energy^0.23, weighted toward the top bands (DIN 45692)
  let num = 0, den = 0;
  for (let z = 0; z < 24; z++) {
    let e = 0; for (let k = Math.ceil(BARK[z] / hz); k < BARK[z + 1] / hz && k < P.length; k++) e += P[k];
    const n = Math.pow(e, 0.23), zc = z + 0.5, g = zc < 15.8 ? 1 : 0.15 * Math.exp(0.42 * (zc - 15.8)) + 0.85;
    num += n * g * zc; den += n;
  }
  return den ? (0.11 * num) / den : 0;
}
function judder({ level, move }, sr) {
  // over the loud, steady part, in 20 ms windows every 10 ms: silence would water it down, and the fast rise and decay
  // of a click is one event, not a judder. Steady: the levels from 30 ms before to 30 ms after within 4 dB, a stretch of
  // 80 ms, longer than the slowest judder's cycle (15 Hz, 67 ms). Held over less (the 20 ms either side), a sound's
  // shape passed as steady: in a short sound, the one or two windows that did were where a lift dips before the flutter
  // or a slap decays, read as judder 50 to 130. Real paper flicks and page turns read 0 to 129 that way, 0 to 61 now;
  // a slide, a scribble or cloth reads within a few points of before, and a buzz of 0.15 s or more at 40 Hz and up still
  // reads in full. Pulsing under 35 Hz and over 3/4 deep never steadies (it did at 3/4, never in full): a flutter.
  const W = Math.round(0.02 * sr), H = Math.round(W / 2), S = 3, parts = [];
  for (let i = 0; i + W <= level.length; i += H) { let a = 0, b = 0; for (let j = i; j < i + W; j++) { a += level[j]; b += move[j] * move[j]; } parts.push({ mean: a / W, ms: b / W }); }
  const top = highest(parts.map(p => p.mean)), near = j => parts.slice(j - S, j + S + 1).map(p => p.mean);
  const on = parts.filter((p, j) => p.mean > top * 0.18 && j >= S && j < parts.length - S && Math.max(...near(j)) <= 1.6 * Math.min(...near(j)));
  if (!on.length) return 0;
  const mean = on.reduce((s, p) => s + p.mean, 0) / on.length, ms = on.reduce((s, p) => s + p.ms, 0) / on.length;
  return (100 * Math.SQRT2 * Math.sqrt(ms)) / mean;
}
function crackle({ level }, sr, hit) { // clicks: 2 ms levels peaking 2.5 times over the median of the 30 ms around them, per second
  // of sound; the onset (a flick, a lift) and the 30 ms from the hit (where it lands) are one event each, not a crackle
  const W = Math.round(0.002 * sr), e = [];
  for (let i = 0; i + W <= level.length; i += W) { let a = 0; for (let j = i; j < i + W; j++) a += level[j]; e.push(a / W); }
  const top = highest(e), on = e.filter(v => v > top * 0.1).length; if (!on) return 0;
  let clicks = 0;
  const first = e.findIndex(v => v > top * 0.1) + 15;
  for (let j = Math.max(1, first); j < e.length - 1; j++) {
    if (!(e[j] > top * 0.05 && e[j] >= e[j - 1] && e[j] > e[j + 1])) continue;
    if (hit != null && j * W >= (hit - 0.005) * sr && j * W < (hit + 0.03) * sr) continue;
    const around = e.slice(Math.max(0, j - 7), j + 8).sort((a, b) => a - b);
    if (e[j] > 2.5 * around[around.length >> 1]) clicks++;
  }
  return clicks / ((on * W) / sr);
}

// ---- the kit, measured: every sound at its defaults, in every material and tool, and every cue shared/deck plays
// { label, kind, measurements, over, worst } for each: every take the kit can play (the player's seeds, at the 44.1
// and 48 kHz an AudioContext runs at, as the player plays it across its pitch vary; mix.mjs renders at 44.1 and doesn't
// vary) measured on its own: measurements the highest of each measure, over the bars it misses, worst the take that
// missed each. A movement is measured again as a glide: the whole of a slide or a whoosh, the lead-in of the others in GLIDES.
// (The vary: a pencil at the bar at pitch 0 went over it at -0.2.)
export async function kitSounds() {
  const { render, SOUNDS, PLAYER } = await import('./foley.js'), { renderSfx, SFX, SR } = await import('./synth.mjs'), sounds = [];
  const foley = (label, name, params) => sounds.push(...measured(label, kindOf(SOUNDS, name), GLIDES[name], playerTakes(render, PLAYER, name, params)));
  for (const name of Object.keys(SOUNDS)) foley(name, name, {});
  for (const [label, name, params] of [...VARIANTS, ...DECK]) foley(label, name, params);
  for (const name of Object.keys(SFX)) sounds.push(...measured(`${name} (synth)`, NOISY.has(name) ? 'texture' : 'tone', GLIDES[name],
    Array.from({ length: PLAYER.variants }, (_, k) => ({ take: `seed ${k + 1}`, sound: { ...renderSfx(name, { seed: k + 1 }), sr: SR } }))));
  return [...sounds, ...await kitStrings()];
}
// ---- what a company's products play, as they play it
// The kit's own list held the flip at its defaults and as the deck plays it, so a small, high leaf an app played
// juddered unseen. A company names its products' sound files in company/sounds.json ({ "sounds": [paths or globs from
// the repository's root] }), or on the command line (--products). Each file is either
//   an app's calls: a module exporting `calls`, [label, sound, params] for every call its player can make, over every
//     value a param reaches (a replay's step, a letter), measured on every take the player can play, like the kit's own;
//   or a mix.mjs timeline (an ad, a phone clip's sound): each foley.js cue as mix.mjs renders it, the one take the film
//     plays (its seed, at 44.1 kHz).
// Each call is measured once (vol and pan aside: the measures are ratios), under the first file that plays it.
// A product's sounds of its own (SOUNDS.x = …, a trailer's instruments ported) are held the same way, once its file
// registers them: as the kind its entry names (`kind`), else a tuned one as a tone and any other as a texture, and again
// as its entry's `also` asks: 'glide' (a movement, as a whole), 'lead-in' (a movement up to its hit) or 'string' (a
// plucked note, its pitch from the entry's `f0(params)`). Their takes must play (clean).
export async function productSounds(files) {
  const { render, SOUNDS, PLAYER } = await import('./foley.js'), { calls, cueSound } = await import('./mix.mjs'), { SR } = await import('./synth.mjs');
  const kit = new Set(Object.keys(SOUNDS)), sounds = [], seen = new Set(); // kit: foley.js's own sounds
  const definitionIds = new Map(); // two products' sounds of one name are two sounds, each its own id
  const definitionId = name => {
    if (!definitionIds.has(SOUNDS[name])) definitionIds.set(SOUNDS[name], definitionIds.size);
    return definitionIds.get(SOUNDS[name]);
  };
  // (a run's later sounds were measured only on the first span of seeds)
  const keyOf = (name, params, k) => // a run's later sounds play later seeds: the same params k sounds in are another span of takes
    JSON.stringify([name, definitionId(name), Object.entries(params).sort(), params.seed == null ? k : 0]);
  const peaks = new Map(); // a product's own sound's takes' peaks at vol 1, by key: every call's own vol is held to them
  const hold = (label, name, params, takes) => {
    if (!SOUNDS[name]) throw new Error(`unknown sound ${name} (${label})`);
    const { also, f0 } = SOUNDS[name];
    for (const { k, n, params: one } of run(params)) {
      const key = keyOf(name, one, k), fresh = !seen.has(key), runLabel = n > 1 ? `${label}, ${k + 1} of ${n}` : label;
      seen.add(key);
      const all = fresh ? takes(one, k) : null;
      if (kit.has(name)) {
        if (fresh) sounds.push(...measured(runLabel, kindOf(SOUNDS, name), GLIDES[name], all));
        continue;
      }
      if (fresh) peaks.set(key, all.map(({ take, sound }) => ({ take, peak: peakOf(sound) })));
      const failure = clean(runLabel, peaks.get(key), (params.vol ?? 1) * (params.fade ?? 1) ** k);
      if (failure) sounds.push(failure);
      const heard = fresh ? all.filter((t, i) => plays(peaks.get(key)[i].peak)) : [];
      if (heard.length) sounds.push(...measured(runLabel, kindOf(SOUNDS, name), GLIDES[name] ?? ALSO[also], heard, also === 'string' ? f0(one) : null));
    }
  };
  for (const file of files) {
    const path = resolve(ROOT, file), at = relative(ROOT, path), mod = await import(pathToFileURL(path).href);
    sounds.push(...await bedStrings(at, mod.default ?? mod.mix, path, seen));
    if (mod.calls) {
      for (const [label, name, params] of mod.calls) hold(`${at}: ${label}`, name, params, (one, k) => playerTakes(render, PLAYER, name, one, k));
      continue;
    }
    for (const [i, { sound, params, cue }] of calls(mod.default ?? mod.mix).entries()) {
      const label = `${at}: cue ${i + 1}, ${sound}${cue.name ? ` (${cue.name})` : ''}`;
      if (!params.wav) {
        hold(label, sound, params, one => [{ take: `seed ${one.seed} at ${SR} Hz`, sound: render(sound, one, SR) }]);
        continue;
      }
      const wavFile = resolve(path, '..', params.wav);
      if (seen.has(wavFile)) continue;
      seen.add(wavFile);
      sounds.push(...await wavCue(label, { ...cueSound(sound, { wav: wavFile }), sr: SR }));
    }
  }
  return sounds;
}
// A `take` row for a product's own sound whose takes ([{ take, peak }], at vol 1) don't all play at the call's vol: one
// silent (peaking at 0.002 or less), not finite or past 0 dBFS; null if they do
function clean(label, peaks, vol) {
  const bad = peaks.map(({ take, peak }) => ({ take, peak: peak * vol })).filter(({ peak }) => !plays(peak));
  if (!bad.length) return null;
  const [{ take, peak }] = bad;
  const why = `${take}${vol === 1 ? '' : ` at vol ${+vol.toFixed(3)}`}: ${!Number.isFinite(peak) ? 'not finite' : peak > 1 ? 'past 0 dBFS' : 'silent'}${bad.length > 1 ? `, ${bad.length} takes` : ''}`;
  return { label, kind: 'take', measurements: { peak }, over: ['peak'], worst: { peak: why } };
}
const plays = peak => peak > 0.002 && peak <= 1;
const peakOf = ({ L, R }) => { let top = 0; for (let i = 0; i < L.length; i++) top = Math.max(top, Math.abs(L[i]), Math.abs(R[i])); return top; };
// A WAV cue, whatever made it: its sharpness, squeal and judder held like a texture's, and its loudest 0.4 s stretch
// held to sharpness too, so a harsh moment in a long file isn't averaged away. A silent file has nothing to hold.
async function wavCue(label, sound) {
  if (!harshness(sound)) return [];
  const rows = measured(label, 'texture', null, [{ take: 'the file', sound }]);
  const worst = (await scan(sound)).filter(window => window.over.length).sort((a, b) => b.measurements.sharpness - a.measurements.sharpness)[0];
  if (worst) rows.push({ label: `${label}, at ${worst.t.toFixed(1)} s`, kind: 'track', measurements: worst.measurements, over: worst.over, worst: { sharpness: 'the file' } });
  return rows;
}
// ---- the plucked strings
// The plain Karplus-Strong string rings every harmonic up to 5 kHz for seconds, so a low note reads tinny (its twang is
// -1 to -13 dB from C2 to C5); synth.mjs's warm string reads -20 or less. Held: the `guitar` and `pluck` presets, at
// their own brightness and at the brightest a song can ask for, and every bed track a product's timeline plays on one,
// as the track plays it (its inst, every note it plays, at full velocity, the brightest). `harp` keeps its bright ring.
const STRINGS = ['guitar', 'pluck'];
const NOTES = Array.from({ length: 11 }, (_, k) => 24 + Math.floor(k / 2) * 12 + (k % 2) * 7); // C1, G1 … C6
async function kitStrings() {
  const { renderNote } = await import('./synth.mjs');
  return STRINGS.flatMap(preset => [['', preset], [', bright 1', { preset, bright: 1 }]].map(([how, inst]) =>
    stringRow(`${preset} (synth)${how}`, inst, NOTES, renderNote)));
}
async function bedStrings(at, specIn, path, seen) { // a timeline's bed song: its tracks on a string, each held once
  const { SOUNDS } = await import('./foley.js'), spec = typeof specIn === 'function' ? specIn({ SOUNDS }) : specIn;
  if (!spec?.bed?.song) return [];
  const { renderNote, songOf, trackNotes } = await import('./synth.mjs'), mod = await import(pathToFileURL(resolve(path, '..', spec.bed.song)).href), rows = [];
  for (const tr of songOf(mod.default ?? mod.song).tracks || []) {
    const key = JSON.stringify(['bed', tr.inst, trackNotes(tr)]);
    if (!STRINGS.includes(typeof tr.inst === 'string' ? tr.inst : tr.inst?.preset) || seen.has(key)) continue;
    seen.add(key); rows.push(stringRow(`${at}: bed, ${tr.name}`, tr.inst, trackNotes(tr), renderNote));
  }
  return rows;
}
const NAMES = 'C C# D D# E F F# G G# A A# B'.split(' ');
const stringRow = (label, inst, notes, renderNote) => ({ label, kind: 'string', ...worstOf(notes.map(m => {
  const sound = renderNote(inst, m);
  return { take: `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`, measurements: harshness(sound, { f0: sound.f0 }) };
}), BARS.string) });
// A call's sounds: a run (count > 1) sound by sound, as foley.js plays it (the next seed and `step` semitones up, each),
// since clicks in a row read as crackle and judder by design (a riffle of cards, a run of deals), like a track's windows
function run({ vol, pan, count, every, step, fade, ...params }) {
  const n = Math.max(1, Math.round(count ?? 1));
  return Array.from({ length: n }, (_, k) => ({ k, n, params: { ...params, ...(k ? { pitch: (params.pitch || 0) + (step || 0) * k } : {}),
    ...(params.seed != null ? { seed: params.seed + k } : {}) } }));
}
// The files company/sounds.json names, its globs expanded (none if the company has no such file)
export function productFiles(file = resolve(ROOT, 'company/sounds.json')) {
  if (!existsSync(file)) return [];
  return [...new Set(JSON.parse(readFileSync(file, 'utf8')).sounds.flatMap(p => globSync(p, { cwd: ROOT }).sort()))];
}
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// (a call that pinned its seed or vary was measured on the default takes)
// Every take the player can play of a call: its seeds (the one it pins, if it does), at the 44.1 and 48 kHz an
// AudioContext runs at, across its pitch vary (its own, if it sets one), as foley.js play() does
function playerTakes(render, PLAYER, name, { vary: own = PLAYER.vary, ...params }, from = 0) { // from: the seeds start that much later (a run's later sounds)
  const vary = [...new Set(VARY.map(v => +(v * own).toFixed(2)))];
  const seeds = params.seed != null ? [params.seed] : Array.from({ length: PLAYER.variants }, (_, k) => k + 1 + from);
  return seeds.flatMap(seed => RATES.flatMap(sr => { const sound = render(name, { ...params, seed }, sr);
    return vary.map(st => ({ take: `seed ${seed} at ${sr} Hz${st ? `, played ${st > 0 ? '+' : ''}${st} st` : ''}`, sound: st ? played(sound, st) : sound })); }));
}
// A sound measured over its takes ([{ take, sound }]) as its kind (a glide whole, with its hit), a movement again as a
// glide (part: as in GLIDES) and a plucked note again as a string (f0: its pitch, Hz)
function measured(label, kind, part, takes, f0 = null) {
  const as = (name, k, measure) => ({ label: name, kind: k, ...worstOf(takes.map(t => ({ ...t, measurements: measure(t.sound) })), BARS[k]) });
  return [as(label, kind, sound => (kind === 'glide' ? glide(sound, 'whole') : harshness(sound))), ...(part ? [as(`${label}, ${part}`, 'glide', sound => glide(sound, part))] : []),
    ...(f0 ? [as(`${label}, string`, 'string', sound => harshness(sound, { f0 }))] : [])];
}
// A product's own sound may name its kind (`kind`: 'tone' for a struck sound that isn't tuned, 'crunch', 'glide')
const kindOf = (SOUNDS, name) => {
  const { kind, tuned } = SOUNDS[name];
  if (kind && !['glide', 'texture', 'crunch', 'tone'].includes(kind)) throw new Error(`${name}: kind ${kind} is none of glide, texture, crunch, tone`);
  return kind ?? (tuned ? 'tone' : name === 'crunch' ? 'crunch' : 'texture');
};
const RATES = [44100, 48000]; // the device's rate
const VARY = [-1, -0.5, 0, 0.5, 1]; // where in the player's pitch vary a take is measured (the meter isn't monotonic in it)
// A take as the player plays it, `st` semitones off: an AudioBufferSourceNode's playbackRate, which Chromium resamples linearly
// (within 4e-5 of its OfflineAudioContext). Measure an app's own moments with it too: harshness(played(render(…), st)).
export function played({ L, R, sr, hit }, st) {
  const k = Math.pow(2, st / 12), n = Math.floor((L.length - 1) / k) + 1, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i * k, j = Math.floor(t), f = t - j, j2 = Math.min(L.length - 1, j + 1); l[i] = L[j] + f * (L[j2] - L[j]); r[i] = R[j] + f * (R[j2] - R[j]); }
  return { L: l, R: r, sr, hit: hit / k };
}
const GLIDES = { slide: 'whole', whoosh: 'whole', flip: 'lead-in', deal: 'lead-in', lock: 'lead-in' }; // the sounds that move, and which part
const ALSO = { glide: 'whole', 'lead-in': 'lead-in' }; // a product's own sound's `also`, as the part of it that moves
const glide = (sound, part) => (part === 'whole' ? harshness(sound, { hit: sound.hit }) : harshness(sound, { to: Math.round(sound.hit * sound.sr) }));
const NOISY = new Set(['whoosh', 'riser', 'click', 'vinyl']); // the synth.mjs effects made of noise
const VARIANTS = [ // label, sound, params: every material and tool
  ['slide card', 'slide', { material: 'card' }], ['slide wood', 'slide', { material: 'wood' }], ['scribble crayon', 'scribble', { tool: 'crayon' }],
  ['scribble marker', 'scribble', { tool: 'marker' }], ['scribble chalk', 'scribble', { tool: 'chalk' }], ['ruffle linen', 'ruffle', { material: 'linen' }],
  ['ruffle silk', 'ruffle', { material: 'silk' }], ['ruffle canvas', 'ruffle', { material: 'canvas' }],
  // a stroke's length moves its tooth against the meter's 20 ms steps: short pencil strokes read 54 to 73 on the old tooth
  ['scratch 0.09 s', 'scratch', { dur: 0.09 }], ['scratch 0.11 s', 'scratch', { dur: 0.11 }], ['scratch 0.14 s', 'scratch', { dur: 0.14 }],
  ['scratch 0.25 s', 'scratch', { dur: 0.25 }], ['scribble 0.3 s', 'scribble', { dur: 0.3 }],
  ['mallet bar', 'mallet', { body: 'bar' }], ['mallet chime', 'mallet', { body: 'chime' }],
];
// What shared/deck/deck.js plays, as it plays it (its vol aside: the measures are ratios). A slide back is pitched down;
// a slide forward climbs a step on every slide of a chapter, up to the octave deck.js stops at, and a lower step is heavier.
const DECK = [
  ['deck back', 'slide', { material: 'card', dur: 0.22, pitch: -2, pan: -0.3 }],
  ...Array.from({ length: 12 }, (_, k) => [`deck forward, step ${k + 1}`, 'slide', { material: 'card', dur: 0.22, pitch: k + 1, pan: 0.3 }]),
  ['deck chapter, flip', 'flip', { material: 'card', pan: 0.2 }], ['deck jump, deal', 'deal', { surface: 'table' }],
  ['deck menu or zoom', 'slide', { material: 'paper', dur: 0.3 }], ['deck either end', 'knock', { size: 0.8, pitch: -3 }],
  ['deck sound on', 'clack', { hold: 0.06 }],
];
function worstOf(takes, bars) { // each measure's highest over the takes, and per bar missed the take that missed it
  const measurements = Object.fromEntries(Object.keys(takes[0].measurements).map(k => [k, Math.max(...takes.map(t => t.measurements[k]))]));
  const missed = over(measurements, bars);
  return { measurements, over: missed, worst: Object.fromEntries(missed.map(k => [k, takes.find(t => t.measurements[k] === measurements[k]).take])) };
}
const over = (measurements, bars) => Object.keys(bars).filter(k => measurements[k] > bars[k]);

// ---- the command line
async function main(files) {
  const COLS = [['sharpness', 'sharp', 2], ['squeal', 'squeal', 1], ['judder', 'judder', 0], ['crackle', 'crack', 0], ['weight', 'weight', 1], ['presence', '2-5k', 1], ['centroid', 'centroid', 0], ['twang', 'twang', 1]];
  const row = (label, kind, measurements, misses) => console.log(`${label.padEnd(28)} ${kind.padEnd(7)} ${COLS.map(([k, h, d]) => (measurements[k]?.toFixed(d) ?? '').padStart(h.length + 1)).join(' ')}  ${misses.join(', ')}`);
  console.log(`${''.padEnd(28)} ${'kind'.padEnd(7)} ${COLS.map(([, h]) => h.padStart(h.length + 1)).join(' ')}  (acum, dB, %, per s, dB, dB, Hz, dB)`);
  if (!files.length || files[0] === '--products') {
    const all = files.length ? await productSounds(files.slice(1).map(file => resolve(file))) : [...await kitSounds(), ...await productSounds(productFiles())];
    for (const sound of all) row(sound.label, sound.kind, sound.measurements, sound.over.map(k => `${k} (${sound.worst[k]})`));
    const bad = all.filter(sound => sound.over.length);
    process.exitCode = bad.length ? 1 : 0; // a sound over its bars fails the command, as the product check it replaced did
    console.log(`${all.length - bad.length} of ${all.length} within the bars of their kind: ${Object.entries(BARS).map(([k, b]) => `${k} ${Object.entries(b).map(([q, v]) => `${q} ${v}`).join(' ')}`).join('; ')}`);
    return;
  }
  const { readWav, SR } = await import('./synth.mjs');
  for (const file of files) { // the whole file against each kind's bars, then a long one's harshest windows
    const recording = readWav(file), whole = harshness(recording);
    if (!whole) { console.log(`${file}: silent`); continue; }
    for (const kind of ['glide', 'texture']) row(kind === 'glide' ? file.split('/').pop().slice(0, 28) : '', kind, whole, over(whole, BARS[kind]));
    if (recording.L.length < 2 * recording.sr) continue;
    if (recording.sr !== SR) { console.log(`  (${recording.sr} Hz: its windows need ${SR} Hz, the loudness meter's rate)`); continue; }
    const windows = await scan(recording), bad = windows.filter(window => window.over.length);
    console.log(`  ${windows.length} loud windows of 0.4 s, ${bad.length} over the sharpness bar`);
    for (const window of windows.sort((a, b) => b.measurements.sharpness - a.measurements.sharpness).slice(0, 5)) row(`  at ${window.t.toFixed(1)} s`, 'track', window.measurements, window.over);
  }
}
// A track's loud 0.4 s windows (within 10 LU of the whole), each measured: [{ t, measurements, over }]. A track mixes
// every kind (clicks in a row read as judder, a tone as a whistle), so its windows are held to what holds for all: sharpness.
export async function scan({ L, R, sr }) {
  const { lufs, SR } = await import('./synth.mjs');
  if (sr !== SR) throw new Error(`${sr} Hz: the loudness meter runs at ${SR} Hz`);
  const W = Math.round(0.4 * sr), step = Math.round(0.1 * sr), whole = lufs(L, R), windows = [];
  for (let i = 0; i + W <= L.length; i += step) {
    if (lufs(L.subarray(i, i + W), R.subarray(i, i + W)) < whole - 10) continue; // the quiet stretches can't grate
    const measurements = harshness({ L, R, sr }, { from: i, to: i + W });
    if (measurements) windows.push({ t: i / sr, measurements, over: over(measurements, { sharpness: BARS.tone.sharpness }) });
  }
  return windows;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch(e => { console.error('harsh: ' + e.message); process.exit(1); });
