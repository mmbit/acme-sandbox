#!/usr/bin/env node
// mix.mjs: a film's soundtrack. Cues on a timeline (in seconds, on markers or on the bed's beats): foley.js sounds,
// synth.mjs effects or any WAV of your own; an optional music bed, set under them and ducked by every hit unless told
// otherwise; mastered for TikTok/Reels.
//   node shared/demo/mix.mjs products/<slug>/ads/sound.mjs [out.wav] [--levels] [--stems] [--no-bed]
// Writes out.wav plus out.beats.json (markers, every cue, and the bed's beat grid), so
// `ad.mjs --audio out.wav` and a scene's demo.marker() / demo.cues line up with every sound.
// See SYNTH.md for the format.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { render as foley, SOUNDS, playedAt } from './foley.js';
import { SR, SFX, SVF, scaled, render as renderSong, renderSfx, readWav, writeWav, lufs, freeverb, playLevel } from './synth.mjs';
import { scan, BARS } from './harsh.mjs'; // the sharpest moment of a track

const dB = x => Math.pow(10, x / 20);
const peak = (L, R) => { let p = 0; for (let i = 0; i < L.length; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i])); return p; };
const panGains = p => { const a = ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4; return [Math.cos(a) * Math.SQRT2, Math.sin(a) * Math.SQRT2]; };

// True peak: the highest of each sample and three points between it and the next (4x oversampling,
// windowed-sinc), so crisp transients can't overshoot the ceiling between samples.
const TP = [0.25, 0.5, 0.75].map(f => { const k = []; for (let j = -7; j <= 8; j++) { const x = f - j, w = (Math.PI * x) / 8.5; k.push((Math.sin(Math.PI * x) / (Math.PI * x)) * (0.42 + 0.5 * Math.cos(w) + 0.08 * Math.cos(2 * w))); } return k; });
function truePeaks(L, R) {
  const n = L.length, tp = new Float32Array(n);
  for (const ch of [L, R]) for (let i = 0; i < n; i++) {
    let m = Math.abs(ch[i]);
    if (i >= 7 && i + 8 < n) for (const k of TP) { let v = 0; for (let j = 0; j < 16; j++) v += ch[i - 7 + j] * k[j]; m = Math.max(m, Math.abs(v)); }
    if (m > tp[i]) tp[i] = m;
  }
  return tp;
}
function limit(L, R, ceil, gr, attack = 0.0015, release = 0.04) { // look-ahead on true peaks, fast release: shaves transients, keeps bodies
  const n = L.length, g = truePeaks(L, R), A = attack * SR, rc = 1 - Math.exp(-1 / (release * SR));
  for (let i = 0; i < n; i++) g[i] = g[i] > ceil ? ceil / g[i] : 1;
  for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] + (1 - g[i - 1]) * rc);
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + 1 / A);
  for (let i = 0; i < n; i++) { L[i] *= g[i]; R[i] *= g[i]; gr[i] *= g[i]; }
}
function softClip(L, R, t, gr) { // rounds off the first ~1 ms of the hottest clicks, above t, by at most `t` again: quicker than any limiter
  for (const ch of [L, R]) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > t) { const y = t * (1 + Math.tanh(a / t - 1)); gr[i] = Math.min(gr[i], y / a); ch[i] = Math.sign(ch[i]) * y; } }
}
// To the loudness target under a true-peak ceiling (0.7 dB of margin: ffmpeg's ebur128 meter reads ~0.5 dB above
// this estimate, and that is the meter we check with). Returns the gain reduction curve too, so each cue can report its share.
function master(L, R, { loudness = -14, ceiling = -2, maxPush = 16, clip = 4 }) {
  const c = dB(ceiling - 0.7), gr = new Float32Array(L.length).fill(1), scale = k => { for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; } };
  const tpMax = () => truePeaks(L, R).reduce((a, b) => Math.max(a, b), 0);
  scale(c / (tpMax() || 1));
  let pushed = 0;
  for (let k = 0; k < 8; k++) {
    const want = Math.min(loudness - lufs(L, R), maxPush - pushed); if (Math.abs(want) < 0.2) break;
    scale(dB(want)); pushed += want; if (clip > 0) softClip(L, R, c * dB(clip / 2), gr); limit(L, R, c, gr);
  }
  return { lufs: +lufs(L, R).toFixed(1), truePeakDb: +(20 * Math.log10(tpMax())).toFixed(2), pushedDb: +pushed.toFixed(1), gr };
}

// Parallel compression: a hard-compressed copy mixed under the dry effects lifts bodies and tails (the close-up,
// ASMR feel of foley) and leaves the transients alone, so mastering needs far less limiting to reach loudness.
function glue(L, R, amount) {
  if (!(amount > 0)) return;
  const n = L.length, pk = peak(L, R) || 1, thr = pk * dB(-26), a = 1 - Math.exp(-1 / (0.001 * SR)), rl = 1 - Math.exp(-1 / (0.08 * SR));
  const cL = new Float32Array(n), cR = new Float32Array(n); let e = 0;
  for (let i = 0; i < n; i++) { const x = Math.max(Math.abs(L[i]), Math.abs(R[i])); e += (x > e ? a : rl) * (x - e); const g = e > thr ? Math.pow(thr / e, 0.8) : 1; cL[i] = L[i] * g; cR[i] = R[i] * g; }
  const k = (amount * pk * dB(-4)) / (peak(cL, cR) || 1);
  for (let i = 0; i < n; i++) { L[i] += cL[i] * k; R[i] += cR[i] * k; }
}

function wavAtSR(file) { // a WAV at the mix's rate (linear resampling)
  const { L, R, sr } = readWav(file);
  if (sr === SR) return { L, R };
  const n = Math.floor((L.length * SR) / sr), l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * sr) / SR, k = Math.floor(x), f = x - k, k1 = Math.min(k + 1, L.length - 1);
    l[i] = L[k] + (L[k1] - L[k]) * f;
    r[i] = R[k] + (R[k1] - R[k]) * f;
  }
  return { L: l, R: r };
}

async function loadBed(b, base) { // a synth.mjs song module or a WAV (with its beats.json if there is one)
  const file = path.resolve(base, b.song || b.wav);
  if (/\.m?js$/.test(file)) {
    const mod = await import(pathToFileURL(file).href), r = renderSong(mod.default ?? mod.song);
    return { L: r.L, R: r.R, grid: r.beats };
  }
  const { L, R } = wavAtSR(file), bj = file.replace(/\.[^.]+$/, '.beats.json');
  return { L, R, grid: fs.existsSync(bj) ? JSON.parse(fs.readFileSync(bj, 'utf8')) : null };
}

// A cue's sound as { L, R, hit } at the mix's rate: a foley.js sound, a synth.mjs effect, or a WAV of any origin
// (`wav`, relative to base), its `hit` seconds in landing on the cue's time.
export function cueSound(sound, params, base = process.cwd()) {
  const placed = s => {
    const vol = params.vol ?? 1, [gainLeft, gainRight] = panGains(params.pan || 0);
    return { ...s, L: s.L.map(x => x * vol * gainLeft), R: s.R.map(x => x * vol * gainRight) };
  };
  if (params.wav) return placed({ ...wavAtSR(path.resolve(base, params.wav)), hit: params.hit ?? 0 });
  // a sound that moves plays at foley.js's MOVES
  if (SOUNDS[sound]) return scaled(foley(sound, params, SR), playedAt(sound));
  if (SFX[sound]) return placed(renderSfx(sound, params));
  throw new Error(`unknown sound "${sound}"; foley.js: ${Object.keys(SOUNDS).join(' ')}; synth.mjs: ${Object.keys(SFX).join(' ')}; or a WAV of your own: { wav: 'x.wav' }`);
}

// What each cue plays: { sound, params, cue }, the params without the cue's timing and routing, and its seed (repeats of a
// sound vary unless a cue pins its seed). mix() renders these; harsh.mjs measures each as the film plays it.
const TIMING = new Set(['t', 'at', 'bar', 'beat', 'offset', 'sound', 'align', 'name', 'send']); // a cue's own keys, not its sound's
export function calls(specIn) {
  const spec = typeof specIn === 'function' ? specIn({ SOUNDS }) : specIn, seen = {};
  return (spec.cues || []).map(cue => { const sound = cue.sound ?? cue.wav, params = Object.fromEntries(Object.entries(cue).filter(([k]) => !TIMING.has(k)));
    return { sound, params: { ...params, seed: params.seed ?? 1 + (seen[sound] = (seen[sound] ?? -1) + 1) }, cue }; });
}

// spec -> { L, R, beats (with cues), stats, squeeze (dB the limiter took off each cue), stems }. base = the folder
// paths in the spec are relative to.
export async function mix(specIn, { base = process.cwd(), noBed = false, stems = false } = {}) {
  const spec = typeof specIn === 'function' ? specIn({ SOUNDS }) : specIn;
  const M = spec.master || {}, B = spec.bed && !noBed ? { level: -12, duck: 8, release: 0.3, fadeIn: 0.4, fadeOut: 0.8, from: 0, start: 0, ...spec.bed } : null;
  const bed = B ? await loadBed(B, base) : null;
  // the grid and markers, in timeline seconds: the bed's shift by where it starts
  const shift = B ? B.from - B.start : 0, g = bed?.grid;
  const bpm = g?.bpm ?? spec.bpm ?? 120, per = g?.beatsPerBar ?? 4, beat0 = g ? (g.beats?.[0] ?? g.offset ?? 0) + shift : 0;
  const markers = new Map();
  for (const m of g?.markers || []) markers.set(m.name, m.t + shift);
  for (const [k, v] of Object.entries(spec.markers || {})) markers.set(k, v);
  const placed = [], own = calls(spec);
  for (const [i, cue] of (spec.cues || []).entries()) {
    const { t, at, bar, beat, offset = 0, align, name, send } = cue, { sound, params } = own[i]; // `send` is the reverb send; `wet` etc. go to the sound
    let T = t;
    if (T == null && at != null) { T = markers.get(at); if (T == null) throw new Error(`cue ${i} (${sound}): no marker "${at}"; have: ${[...markers.keys()].join(' ') || 'none'}`); }
    if (T == null && bar != null) T = beat0 + (bar * per * 60) / bpm;
    if (T == null && beat != null) T = beat0 + (beat * 60) / bpm;
    if (T == null) throw new Error(`cue ${i} (${sound}): give it t (seconds), at (a marker), bar or beat`);
    T += offset;
    let s;
    try { s = cueSound(sound, params, base); } catch (e) { throw new Error(`cue ${i}: ${e.message}`, { cause: e }); }
    const start = align === 'start' ? T : T - s.hit; // by default the sound's hit lands on T
    if (start < 0) console.warn(`mix: cue ${i} (${sound}) starts ${(-start).toFixed(2)} s before 0; its lead-in is cut`);
    if (name) markers.set(name, T);
    placed.push({ i, sound, name, T, start, s, send: send ?? M.send ?? 0.12 });
  }
  const end = Math.max(0, ...placed.map(p => p.start + p.s.L.length / SR));
  const duration = spec.duration ?? end + 0.2, N = Math.ceil(duration * SR);
  // the effects bus, with a small room, in two: what moves and the rest. Parallel compression (glue) lifts what sits under
  // the loudest hits, up to 10 dB at 26 dB under, so a swish turned down came back up; and a bed set against everything
  // went down with the swish, the master pushing both back up. Glue and the bed take the sounds that don't move (all of
  // them when only movements play), and a swish turned down stays down.
  const buses = [0, 1].map(() => Array.from({ length: 4 }, () => new Float32Array(N))), [still, moving] = buses;
  for (const p of placed) {
    const o = Math.round(p.start * SR), [eL, eR, rL, rR] = playLevel(p.sound) === 1 ? still : moving;
    for (let i = Math.max(0, -o); i < p.s.L.length && o + i < N; i++) { const l = p.s.L[i], r = p.s.R[i]; eL[o + i] += l; eR[o + i] += r; rL[o + i] += l * p.send; rR[o + i] += r * p.send; }
  }
  const quiet = (L, R) => !L.some(x => x !== 0) && !R.some(x => x !== 0), [sL, sR] = quiet(still[0], still[1]) ? moving : still;
  for (const [eL, eR, rL, rR] of buses) if (!quiet(eL, eR)) freeverb(rL, rR, eL, eR, { size: 0.3, damp: 0.55, predelay: 0.012, ...(M.reverb || {}) });
  glue(sL, sR, M.glue ?? 0.4);
  const reference = lufs(sL, sR);
  if (sL !== moving[0]) for (let i = 0; i < N; i++) { sL[i] += moving[0][i]; sR[i] += moving[1][i]; }
  const sfxLufs = lufs(sL, sR);
  // the bed: placed, filtered, faded, set `level` LU under the effects, then ducked by them
  const bL = new Float32Array(N), bR = new Float32Array(N);
  let bedLufs = null;
  if (bed) {
    const from = Math.round(B.from * SR), to = Math.min(N, Math.round((B.to ?? duration) * SR)), st = Math.round(B.start * SR), len = bed.L.length, loop = B.loop ?? g?.loop ?? false;
    const hp = [SVF(), SVF()], lp = [SVF(), SVF()]; if (B.hp) hp.forEach(f => f.set(B.hp, 0.1)); if (B.lp) lp.forEach(f => f.set(B.lp, 0.1));
    for (let i = from; i < to; i++) {
      let k = st + i - from; if (k >= len) { if (!loop) break; k %= len; }
      let l = bed.L[k], r = bed.R[k];
      if (B.hp) { l = hp[0].hp(l); r = hp[1].hp(r); } if (B.lp) { l = lp[0].lp(l); r = lp[1].lp(r); }
      const e = Math.min(1, (i - from) / (B.fadeIn * SR + 1), (to - i) / (B.fadeOut * SR + 1));
      bL[i] = l * e; bR[i] = r * e;
    }
    const bl = lufs(bL, bR), k = bl > -60 ? dB(reference + B.level - bl) : 1; // (a silent bed stays as it is)
    // duck: a fast follower on the effects (10 ms look-ahead); a hit at full level takes `duck` dB off, 30 dB quieter takes none
    const a = 1 - Math.exp(-1 / (0.004 * SR)), rel = 1 - Math.exp(-1 / (B.release * SR)), look = Math.round(0.01 * SR), env = new Float32Array(N);
    let e = 0, ref = 1e-9;
    for (let i = 0; i < N; i++) { const x = Math.max(Math.abs(sL[i]), Math.abs(sR[i])); e += (x > e ? a : rel) * (x - e); env[i] = e; ref = Math.max(ref, e); }
    for (let i = 0; i < N; i++) {
      const x = env[Math.min(N - 1, i + look)], gr = B.duck * Math.max(0, Math.min(1, (20 * Math.log10(x / ref + 1e-9) + 30) / 30));
      bL[i] *= k * dB(-gr); bR[i] *= k * dB(-gr);
    }
    bedLufs = lufs(bL, bR);
  }
  // master: sum, a rumble high-pass, and a 16 kHz low-pass before the limiter: AAC (ours and the platforms') cuts
  // there anyway, and cutting a click after limiting makes it ring over the ceiling, so we cut first
  const L = new Float32Array(N), R = new Float32Array(N), mkHp = () => SVF().set(M.hp ?? 30, 0), mkLp = () => SVF().set(M.lp ?? 16000, 0.3);
  const hp = [mkHp(), mkHp()], lp = [mkLp(), mkLp(), mkLp(), mkLp()];
  for (let i = 0; i < N; i++) { L[i] = lp[1].lp(lp[0].lp(hp[0].hp(sL[i] + bL[i]))); R[i] = lp[3].lp(lp[2].lp(hp[1].hp(sR[i] + bR[i]))); }
  const F = Math.min(N, Math.round(0.05 * SR)); for (let i = 0; i < F; i++) { L[N - 1 - i] *= i / F; R[N - 1 - i] *= i / F; }
  const pre = peak(L, R) || 1;
  const { gr, ...st } = master(L, R, { loudness: M.loudness ?? -14, ceiling: M.ceiling ?? -2, maxPush: M.maxPush ?? 16, clip: M.clip ?? 4 });
  const gain = peak(L, R) / pre; // roughly what mastering added, for the stems
  // the beat grid (from the bed, else spec.bpm), markers and cues for the scene
  const grid = (t0, step) => { const out = []; for (let t = ((t0 % step) + step) % step; t <= duration + 1e-9; t += step) out.push(+t.toFixed(4)); return out; };
  const bt = grid(beat0, 60 / bpm), br = grid(g?.bars?.[0] != null ? g.bars[0] + shift : beat0, (per * 60) / bpm);
  const cues = placed.map(p => ({ t: +p.T.toFixed(4), start: +p.start.toFixed(4), sound: p.sound, ...(p.name ? { name: p.name } : {}) }));
  const squeeze = placed.map(p => { let m = 1; for (let i = Math.max(0, Math.round(p.start * SR)), e = Math.min(N, i + p.s.L.length); i < e; i++) m = Math.min(m, gr[i]); return +(20 * Math.log10(m)).toFixed(1); });
  const beats = { bpm, beatsPerBar: per, duration: +duration.toFixed(4), musicEnd: +duration.toFixed(4), tail: 0, loop: false, beats: bt, bars: br,
    markers: [...markers].filter(([, t]) => t >= 0 && t <= duration).map(([name, t]) => ({ t: +t.toFixed(4), name })).sort((a, b) => a.t - b.t),
    sections: (g?.sections || []).map(s => ({ ...s, start: +(s.start + shift).toFixed(4), end: +(s.end + shift).toFixed(4) })), cues, ...(spec.title ? { title: spec.title } : {}) };
  const sorted = squeeze.slice().sort((a, b) => a - b), sharpest = (await scan({ L, R, sr: SR })).reduce((top, window) => (window.measurements.sharpness > (top?.measurements.sharpness ?? 0) ? window : top), null);
  const stats = { ...st, limitMedian: sorted[Math.floor(sorted.length / 2)] ?? 0, limitMax: sorted[0] ?? 0, sfxLufs: +sfxLufs.toFixed(1), bedUnder: bedLufs == null ? null : +(reference - bedLufs).toFixed(1), cues: placed.length,
    sharpest: sharpest && { t: +sharpest.t.toFixed(1), acum: +sharpest.measurements.sharpness.toFixed(2) } };
  return { L, R, beats, stats, squeeze, ceiling: M.ceiling ?? -2, stems: stems ? { sfx: [sL.map(x => x * gain), sR.map(x => x * gain)], bed: bed ? [bL.map(x => x * gain), bR.map(x => x * gain)] : null } : null };
}

async function main(argv) {
  const flags = new Set(argv.filter(a => a.startsWith('--'))), pos = argv.filter(a => !a.startsWith('--'));
  if (!pos[0] || flags.has('--help')) {
    console.log('usage: node shared/demo/mix.mjs sound.mjs [out.wav] [--levels] [--stems] [--no-bed]\nfoley.js sounds: ' + Object.keys(SOUNDS).join(' ') + '\nsynth.mjs sfx: ' + Object.keys(SFX).join(' '));
    return;
  }
  const t0 = performance.now(), file = path.resolve(pos[0]), mod = await import(pathToFileURL(file).href);
  const out = pos[1] || file.replace(/\.m?js$/, '.wav');
  const res = await mix(mod.default ?? mod.mix, { base: path.dirname(file), noBed: flags.has('--no-bed'), stems: flags.has('--stems') });
  writeWav(out, res.L, res.R);
  const bfile = out.replace(/\.wav$/i, '') + '.beats.json';
  fs.writeFileSync(bfile, JSON.stringify(res.beats) + '\n');
  const s = res.stats;
  console.log(`${out}: ${res.beats.duration.toFixed(2)} s, ${s.cues} cues, ${s.lufs} LUFS, peaks under ${res.ceiling} dBTP${s.bedUnder != null ? `, bed ${s.bedUnder} LU under the effects that don't move` : ''}, hits limited ${-s.limitMedian} dB (median) to ${-s.limitMax} dB${s.sharpest ? `, sharpest moment ${s.sharpest.acum} acum at ${s.sharpest.t} s` : ''}, rendered in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
  if (s.limitMax < -12) console.log(`  note: some hits lose over 12 dB to the limiter (--levels shows which). Turn those cues' vol down, or add texture between hits.`);
  if (s.sharpest?.acum > BARS.tone.sharpness) console.log(`  note: the moment at ${s.sharpest.t} s is sharper than ${BARS.tone.sharpness} acum (brighter than real paper): darker cues there, or \`bright\` under 0.5.`);
  if (flags.has('--levels')) res.beats.cues.forEach((c, i) => console.log(`  ${c.t.toFixed(2).padStart(6)} s  ${(c.sound + (c.name ? ` (${c.name})` : '')).padEnd(20)} limited ${String(-res.squeeze[i]).padStart(4)} dB${c.start !== c.t ? `, starts ${c.start.toFixed(2)}` : ''}`));
  if (res.stems) {
    const stem = k => out.replace(/\.wav$/i, '') + `.${k}.wav`;
    writeWav(stem('sfx'), ...res.stems.sfx); if (res.stems.bed) writeWav(stem('bed'), ...res.stems.bed);
    console.log(`stems: ${stem('sfx')}${res.stems.bed ? ` ${stem('bed')}` : ''}`);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch(e => { console.error('mix: ' + e.message); process.exit(1); });
