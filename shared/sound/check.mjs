#!/usr/bin/env node
// The sound check: holds a company's palette to what nobody can hear by ear. Every sound renders the same per seed, peaks
// under 0 dBFS, sits in its role's loudness band, stays soft (brightness, attack, dark tails) and short, follows the key
// and the tuning, mixes in mix.mjs, and in Chromium the palette's soundboard is silent before a gesture, plays after
// one, remembers mute and renders what Node renders.
//   node shared/sound/check.mjs <palette.js> [--board page.html] [--tuning '{"key":"A"}'] [--trim] [--wav /tmp/sound] [--node]
// The board defaults to board.html beside the palette. --tuning checks your tuning too and prints the trim it needs;
// --trim prints every tuning's trim; --wav writes every sound and its spectrogram there; --node skips the browser.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { render, SOUNDS, palette, tune, rootOf } from './engine.js';
import { SFX, lufs, writeWav } from '../demo/synth.mjs';
import { mix } from '../demo/mix.mjs';
import { serve, playwright, urlPath } from '../demo/core.mjs';
import { listenTo } from '../browser/browser.mjs';

const SR = 44100, argv = process.argv.slice(2), VALUED = ['--board', '--tuning', '--wav'];
const flag = name => argv.includes(`--${name}`), valueOf = name => (flag(name) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const paletteFile = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
if (!paletteFile) { console.error("usage: node shared/sound/check.mjs <palette.js> [--board page.html] [--tuning '{...}'] [--trim] [--wav dir] [--node]"); process.exit(1); }
await import(pathToFileURL(path.resolve(paletteFile)).href);
const { sounds, roles, tunings, check: settings } = palette() ?? {};
if (!sounds) { console.error(`${paletteFile} put no palette in use: it should call use() from the sound engine`); process.exit(1); }
const NAMES = Object.keys(sounds), TUNING_NAMES = Object.keys(tunings), wavDir = valueOf('wav');
let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };
const hash = s => createHash('sha1').update(Buffer.from(s.L.buffer)).update(Buffer.from(s.R.buffer)).digest('hex').slice(0, 12);
const db = x => 20 * Math.log10(x + 1e-12);

// What every role is held to unless the palette's role says otherwise. dark: dB above 8 kHz from 20 ms after the hit
// (no fizz in the tail); phone: dB of the energy at 400 Hz to 5 kHz (-3.5 is 45%), so it still carries on a phone
// speaker; attack: [min, max] ms from the hit to the loudest moment (never a 0 ms click). A role sets loud
// ([target, tolerance] in LUFS), centroid (Hz) and tail (s), and may set spread (LU its sounds match within).
const BARS = { dark: -45, phone: -3.5, attack: [2, Infinity] };
const barsOf = role => ({ ...BARS, ...roles[role] });

// ---- measurements
function fftPower(x) { // power spectrum of x (zero-padded to a power of two), bins 0..N/2
  let N = 1; while (N < x.length) N <<= 1;
  const re = new Float64Array(N), im = new Float64Array(N); re.set(x);
  for (let i = 1, j = 0; i < N; i++) { let b = N >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; } }
  for (let len = 2; len <= N; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < N; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const u = i + k, v = u + len / 2, tr = re[v] * cr - im[v] * ci, ti = re[v] * ci + im[v] * cr;
        re[v] = re[u] - tr; im[v] = im[u] - ti; re[u] += tr; im[u] += ti; const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t; } }
  }
  const P = new Float64Array(N / 2 + 1); for (let k = 0; k <= N / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
  return { P, hz: SR / N };
}
const mono = (s, from = 0, to = s.L.length) => { const y = new Float64Array(Math.max(0, to - from)); for (let i = from; i < to; i++) y[i - from] = (s.L[i] + s.R[i]) / 2; return y; };
function measure(s) {
  const n = s.L.length, h = Math.round(s.hit * SR);
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(s.L[i]), Math.abs(s.R[i]));
  // loudness: the loudest 400 ms window, stepped by 20 ms (a sound shorter than that is padded with silence)
  const W = Math.round(0.4 * SR), L = new Float32Array(Math.max(n, W)), R = new Float32Array(L.length); L.set(s.L); R.set(s.R);
  let loud = -70; for (let i = 0; i + W <= L.length; i += Math.round(0.02 * SR)) loud = Math.max(loud, lufs(L.subarray(i, i + W), R.subarray(i, i + W)));
  const { P, hz } = fftPower(mono(s)); let num = 0, den = 0, mid = 0; P.forEach((p, k) => { num += p * k * hz; den += p; if (k * hz >= 400 && k * hz <= 5000) mid += p; });
  // the tail from 20 ms after the hit, faded in over 2 ms: a hard cut would itself splash energy above 8 kHz
  const tl = mono(s, Math.min(n, h + Math.round(0.02 * SR))), fi = Math.round(0.002 * SR); for (let i = 0; i < fi && i < tl.length; i++) tl[i] *= Math.pow(Math.sin((Math.PI / 2) * (i / fi)), 2);
  const T = fftPower(tl); let hi = 0, all = 0; T.P.forEach((p, k) => { all += p; if (k * T.hz > 8000) hi += p; });
  // envelope: RMS over 0.5 ms frames; attack = hit to the loudest frame in the next 30 ms, tail = hit to the last frame above -40 dB
  const F = Math.round(0.0005 * SR), env = []; for (let i = 0; i + F <= n; i += F) { let e = 0; for (let j = i; j < i + F; j++) e += s.L[j] * s.L[j] + s.R[j] * s.R[j]; env.push(Math.sqrt(e / F / 2)); }
  const top = Math.max(...env), h0 = Math.floor(h / F); let pk = h0; for (let i = h0; i < Math.min(env.length, h0 + 60); i++) if (env[i] > env[pk]) pk = i;
  let last = env.length - 1; while (last > 0 && env[last] < top * 0.01) last--;
  return { peak: db(peak), loud, centroid: num / den, hf: 10 * Math.log10(hi / (all || 1) + 1e-12), phone: 10 * Math.log10(mid / den + 1e-12), attack: (pk - h0 + 0.5) * F / SR * 1000, tail: Math.max(0, (last * F - h) / SR), len: n / SR };
}
function freqOf(s) { // the strongest frequency, with parabolic interpolation between bins
  const { P, hz } = fftPower(mono(s)); let k = 1; for (let i = 2; i < P.length - 1; i++) if (P[i] > P[k]) k = i;
  const [a, b, c] = [P[k - 1], P[k], P[k + 1]].map(v => Math.log(v + 1e-30)); return (k + (0.5 * (a - c)) / (a - 2 * b + c)) * hz;
}

// ---- 1. every sound, in every tuning: deterministic, distinct per seed, finite, under 0 dBFS, in its band, soft, short
const [byDefault] = TUNING_NAMES;
console.log(`${'sound'.padEnd(9)} ${'role'.padEnd(5)} ${'LUFS'.padStart(6)} ${'peak'.padStart(6)} ${'app pk'.padStart(6)} ${'centroid'.padStart(8)} ${'>8k'.padStart(5)} ${'phone'.padStart(5)} ${'attack'.padStart(6)} ${'tail'.padStart(5)} ${'length'.padStart(6)}   (${byDefault}; dB, Hz, ms, s)`);
const loudOf = name => { let x = 0; for (let k = 1; k <= 4; k++) x += measure(render(name, { seed: k }, SR)).loud; return x / 4; };
const extra = flag('tuning') ? { yours: JSON.parse(valueOf('tuning')) } : {};
const table = {}, spreads = [], gaps = [];
for (const [tn, tdef] of Object.entries({ ...tunings, ...extra })) {
  tune(tdef);
  const ms = {}, trims = {};
  for (const name of NAMES) {
    const a = render(name, { seed: 3 }, SR), b = render(name, { seed: 3 }, SR), c = render(name, { seed: 4 }, SR), r = sounds[name].role, bars = barsOf(r);
    const finite = a.L.every(Number.isFinite) && a.R.every(Number.isFinite), m = (ms[name] = { ...measure(a), loud: loudOf(name) }), where = `${name} (${tn})`;
    if (tn === byDefault) console.log(`${name.padEnd(9)} ${r.padEnd(5)} ${m.loud.toFixed(1).padStart(6)} ${m.peak.toFixed(1).padStart(6)} ${db(SOUNDS[name].level * 0.35).toFixed(1).padStart(6)} ${m.centroid.toFixed(0).padStart(8)} ${m.hf.toFixed(0).padStart(5)} ${m.phone.toFixed(1).padStart(5)} ${m.attack.toFixed(1).padStart(6)} ${m.tail.toFixed(2).padStart(5)} ${m.len.toFixed(2).padStart(6)}`);
    if (!finite || hash(a) !== hash(b) || hash(a) === hash(c)) check(false, `render ${where}`, finite ? 'seeds not deterministic/distinct' : 'not finite');
    if (m.peak >= 0) check(false, `${where} peaks under 0 dBFS`, `${m.peak.toFixed(2)} dBFS`);
    const [want, tol] = bars.loud, off = m.loud - want;
    trims[name] = +((tdef.trim?.[name] ?? 0) - off).toFixed(1);
    if (Math.abs(off) > tol) check(false, `${where} sits at ${want} LUFS +-${tol} (${r})`, m.loud.toFixed(1));
    if (m.centroid > bars.centroid) check(false, `${where} stays soft: centroid under ${bars.centroid} Hz`, m.centroid.toFixed(0));
    if (m.hf > bars.dark) check(false, `${where} is dark above 8 kHz after the first 20 ms (under ${bars.dark} dB)`, m.hf.toFixed(1));
    // a phone speaker plays little under 400 Hz: a sound that lives down there (a bare thump) vanishes on a phone
    if (m.phone < bars.phone) check(false, `${where} carries on a phone speaker: enough of its energy at 400 Hz..5 kHz (${bars.phone} dB)`, `${m.phone.toFixed(1)} dB`);
    if (m.attack < bars.attack[0] || m.attack > bars.attack[1]) check(false, `${where} attack ${bars.attack.join('..')} ms, never a 0 ms click`, m.attack.toFixed(1));
    if (m.tail > bars.tail) check(false, `${where} tail under ${bars.tail} s`, m.tail.toFixed(2));
  }
  for (const [r, { spread }] of Object.entries(roles)) {
    const louds = NAMES.filter(n => sounds[n].role === r).map(n => ms[n].loud), width = Math.max(...louds) - Math.min(...louds);
    if (spread == null || !louds.length) continue;
    spreads.push(`${tn} ${r} ${width.toFixed(1)}`);
    if (width > spread) check(false, `${tn}: the ${r} sounds match each other within ${spread} LU`, width.toFixed(1));
  }
  for (const { quieter, louder, db: [least, most] } of settings.gaps ?? []) {
    const gap = ms[louder].loud - ms[quieter].loud; gaps.push(`${tn} ${quieter} ${gap.toFixed(1)} under ${louder}`);
    if (gap < least || gap > most) check(false, `${tn}: "${quieter}" sits ${least}..${most} dB under "${louder}"`, gap.toFixed(1));
  }
  if (tn !== byDefault && (flag('trim') || tn === 'yours')) console.log(`     ${tn} trim: ${JSON.stringify(Object.fromEntries(Object.entries(trims).filter(([, v]) => v)))}`);
  table[tn] = ms;
}
tune();
check(!failed, `all ${NAMES.length} sounds x ${Object.keys(table).length} tunings: deterministic, vary by seed, under 0 dBFS, at their role's loudness, soft, carry on a phone, short`);
if (spreads.length || gaps.length) console.log(`     ${[...spreads, ...gaps].join(', ')} (LU, dB)`);
for (const [name, [least, most]] of Object.entries(settings.lengths ?? {})) {
  const length = table[byDefault][name].len;
  check(length >= least && length <= most, `${name} lasts ${least}..${most} s`, `${length.toFixed(2)} s`);
}

// ---- 2. the key and the tuning
if (settings.pitched) {
  const name = settings.pitched, want = Math.pow(2, (rootOf('G') - rootOf('C')) / 12);
  const ratio = freqOf(render(name, { key: 'G', seed: 1 }, SR)) / freqOf(render(name, { key: 'C', seed: 1 }, SR));
  check(Math.abs(ratio / want - 1) < 0.01, `tonal sounds follow the key (${name} in G vs C)`, `ratio ${ratio.toFixed(4)}, want ${want.toFixed(4)}`);
} else console.log('--   the key is not measured: name one clear-toned sound as check.pitched in the palette');
const lastName = TUNING_NAMES.at(-1), { trim: _, ...last } = tunings[lastName];
if (lastName !== byDefault) {
  const same = NAMES.filter(n => hash(render(n, { seed: 2 }, SR)) === hash(render(n, { ...last, seed: 2 }, SR)));
  check(!same.length, `a tuning changes every sound (${byDefault} vs ${lastName})`, same.join(' '));
}
const unlike = [];
for (const tn of TUNING_NAMES) {
  tune(tn); const tuned = NAMES.map(n => hash(render(n, { seed: 2 }, SR)));
  // the default's params at every sound's own level, so the only trim is the one passed as vol (the default may trim too)
  tune({ ...tunings[byDefault], trim: {} });
  const { trim = {}, ...params } = tunings[tn];
  if (!NAMES.every((n, i) => tuned[i] === hash(render(n, { ...params, seed: 2, vol: Math.pow(10, (trim[n] ?? 0) / 20) }, SR)))) unlike.push(tn);
}
tune();
check(!unlike.length, 'tune() is the same as passing the tuning as params (and its trim as vol), so apps and ads agree', unlike.join(' '));
const flat = NAMES.filter(n => hash(render(n, { seed: 3 }, SR)) === hash(render(n, { seed: 3, pitch: 2 }, SR)));
check(!flat.length, 'pitch moves every sound', flat.join(' '));
const clash = NAMES.filter(n => SFX[n]);
check(!clash.length, 'no name is also a synth.mjs SFX (mix.mjs would pick the palette\'s over it)', clash.join(' '));

// ---- 3. in a mix.mjs cue file, by name
const cued = [NAMES[0], NAMES[Math.floor(NAMES.length / 2)], NAMES.at(-1)];
const m = await mix({ cues: [{ t: 0.3, sound: cued[0] }, { t: 0.8, sound: cued[1] }, { t: 1.4, sound: cued[2], key: 'A' }], master: { loudness: -14 } });
// how loud three cues can be mastered depends on the cues (three soft taps can't reach -14 LUFS), so the palette sets its
// own target, and without one only a floor and the ceiling are held
const [masteredAt, masteredTolerance] = settings.mastered ?? [], loudEnough = masteredAt == null ? m.stats.lufs > -30 : Math.abs(m.stats.lufs - masteredAt) <= masteredTolerance;
const masteredTo = masteredAt == null ? 'under the ceiling' : `to ${masteredAt} LUFS +-${masteredTolerance}, under the ceiling`;
check(m.stats.cues === 3 && loudEnough && m.stats.truePeakDb <= -1.9, `mix.mjs plays the palette by name (${cued.join(', ')}), mastered ${masteredTo}`, `${m.stats.lufs} LUFS, ${m.stats.truePeakDb} dBTP`);

if (wavDir) { // every sound as a WAV with a spectrogram, and foley.js's own beside them to compare
  fs.mkdirSync(wavDir, { recursive: true });
  const theirs = Object.keys(SOUNDS).filter(n => !sounds[n]);
  for (const name of [...NAMES, ...theirs]) {
    const s = render(name, { seed: 3 }, SR), pad = Math.round(0.1 * SR), L = new Float32Array(s.L.length + 2 * pad), R = new Float32Array(L.length);
    L.set(s.L, pad); R.set(s.R, pad); const f = path.join(wavDir, `${sounds[name] ? '' : 'foley-'}${name}.wav`); writeWav(f, L, R);
    // the picture at a fixed scale (peak to -1 dBFS, 80 dB of range, 0..22 kHz; the 16-bit floor sits under it) so the palette and foley.js compare at a glance
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', f, '-lavfi', `volume=${(-1 - measure(s).peak).toFixed(1)}dB,showspectrumpic=s=320x160:legend=0:drange=80,drawtext=text='${name}':x=6:y=6:fontcolor=white:fontsize=18`, f.replace(/\.wav$/, '.png')]);
  }
  for (const name of theirs) { const t = measure(render(name, { seed: 3 }, SR)); console.log(`     foley.js ${name.padEnd(9)} centroid ${t.centroid.toFixed(0).padStart(5)} Hz, >8k ${t.hf.toFixed(0)} dB, attack ${t.attack.toFixed(1)} ms`); }
  console.log(`wrote ${NAMES.length + theirs.length} WAVs and spectrograms to ${wavDir}`);
}

// ---- 4. in Chromium, through the palette's soundboard (the same modules an app loads)
if (flag('node')) { console.log(failed ? `${failed} check(s) failed` : 'all checks passed (Node only)'); process.exit(failed ? 1 : 0); }
const boardFile = valueOf('board') ?? path.join(path.dirname(paletteFile), 'board.html');
if (!fs.existsSync(boardFile)) { check(false, 'the soundboard is there', `no ${boardFile}: pass --board, or --node to skip the browser`); process.exit(1); }
// the tap to hear: the loudest of the short sounds, so a ringing tail doesn't spill into the bed's measurement after it
const roleOf = n => roles[sounds[n].role], short = NAMES.filter(n => roleOf(n).tail < 1);
const [heard = NAMES[0]] = short.sort((a, b) => roleOf(b).loud[0] - roleOf(a).loud[0] || roleOf(a).tail - roleOf(b).tail);
const [, switchTo] = TUNING_NAMES, paletteUrl = urlPath(paletteFile), engineUrl = urlPath(path.join(import.meta.dirname, 'engine.js'));
const srv = await serve(), { chromium } = playwright(), browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 912 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }), page = await ctx.newPage();
  page.on('pageerror', e => check(false, 'page error', e.message));
  await page.goto(srv.origin + urlPath(boardFile));
  await page.waitForFunction(() => window.sfx);
  check(await page.evaluate(n => window.sfx.context === null && window.sfx.play(n) === null, NAMES[0]), 'silent before a user gesture (no AudioContext, play() returns null)');
  const layout = await page.evaluate(() => { const t = [...document.querySelectorAll('[data-sound]')].map(b => b.getBoundingClientRect());
    return { wide: document.documentElement.scrollWidth, cols: new Set(t.slice(0, 6).map(r => Math.round(r.left))).size, min: Math.min(...t.map(r => Math.min(r.width, r.height))), tiles: t.length }; });
  check(layout.wide <= 420 && layout.cols === Math.min(2, NAMES.length) && layout.min >= 44 && layout.tiles === NAMES.length, 'on an iPhone Air (420x912): no sideways scroll, two columns, big tiles, every sound', JSON.stringify(layout));

  await page.tap(`[data-sound="${NAMES[0]}"]`);
  await page.waitForFunction(() => window.sfx.ready, null, { timeout: 5000 }).catch(() => {}); // the check below reports it, with the state
  check(await page.evaluate(() => window.sfx.ready && typeof window.lastPlay === 'number'), 'the first tap starts audio and plays', `state ${await page.evaluate(() => window.sfx.context?.state)}`);
  const level = await listenTo(page);
  const [, on] = await Promise.all([page.tap(`[data-sound="${heard}"]`), level()]);
  check(on > -45, `a tap on "${heard}" is audible on the output`, `${on.toFixed(1)} dBFS RMS`);
  if (switchTo) {
    await page.tap(`[data-tuning="${switchTo}"]`);
    check(await page.evaluate(n => document.querySelector(`[data-tuning="${n}"]`).getAttribute('aria-pressed') === 'true' && window.lastTuning === n, switchTo), `the tuning switch picks ${switchTo}`);
  }

  const bed = await page.evaluate(() => document.querySelector('[data-bed]')?.dataset.bed);
  if (bed) {
    await page.tap(`[data-bed="${bed}"]`);
    await page.waitForSelector(`[data-bed="${bed}"][aria-pressed="true"]`, { timeout: 5000 }).catch(() => {}); // a bed that won't start fails the check below
    const bedOn = await level(); await page.tap(`[data-bed="${bed}"]`); await page.waitForTimeout(250); const bedOff = await level();
    check(bedOn > -60 && bedOn < -25 && bedOff < -80, `a bed plays quietly from its tile (in ${switchTo ?? byDefault}'s key) and stops on a second tap`, `${bedOn.toFixed(1)} -> ${bedOff.toFixed(1)} dBFS RMS`);
  } else console.log('--   the board has no beds');

  await page.tap('#mute');
  const stored = await page.evaluate(() => Object.keys(localStorage).find(k => localStorage.getItem(k) === 'off'));
  check(await page.evaluate(() => window.sfx.muted && document.getElementById('mute').getAttribute('aria-pressed') === 'false') && !!stored, 'the mute toggle mutes, says so (aria-pressed) and is stored', stored ?? 'nothing stored');
  await page.waitForTimeout(250); // the mute's own fade-out
  const [, off] = await Promise.all([page.tap(`[data-sound="${heard}"]`), level()]);
  check(off < -80 && (await page.evaluate(() => window.lastPlay)) === null, 'muted taps are silent', `${off.toFixed(1)} dBFS RMS`);
  await page.reload(); await page.waitForFunction(() => window.sfx);
  check(await page.evaluate(() => window.sfx.muted && document.getElementById('mute').getAttribute('aria-pressed') === 'false'), 'mute is remembered after a reload');
  await page.tap('#mute');
  check(await page.evaluate(k => !window.sfx.muted && localStorage.getItem(k) === 'on', stored), 'unmuting is stored too');
  if (wavDir) await page.screenshot({ path: path.join(wavDir, 'board.png'), fullPage: true });

  // the browser renders the same samples as Node, so an app and its ad sound alike
  const params = { ...last, seed: 5, pitch: 1, key: 'Bb' };
  let worst = 0;
  for (const name of NAMES) {
    const b = await page.evaluate(async ([n, p, paletteAt, engineAt]) => { await import(paletteAt); const { render } = await import(engineAt);
      const s = render(n, p, 44100); return [Array.from(s.L), Array.from(s.R)]; }, [name, params, paletteUrl, engineUrl]);
    const a = render(name, params, SR);
    if (b[0].length !== a.L.length) { worst = Infinity; break; }
    for (let i = 0; i < a.L.length; i++) worst = Math.max(worst, Math.abs(a.L[i] - b[0][i]), Math.abs(a.R[i] - b[1][i]));
  }
  check(worst < 1e-6, 'Chromium renders every sound sample-for-sample like Node', `max difference ${worst}`);
} finally { await browser.close(); srv.close(); }
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
