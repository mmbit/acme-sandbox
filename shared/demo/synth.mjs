#!/usr/bin/env node
// synth.mjs: the demo kit's offline synth + sequencer. Pure Node, no dependencies.
//   node shared/demo/synth.mjs song.mjs out.wav [--solo bass,lead] [--mute drums]
//   node shared/demo/synth.mjs --sfx whoosh out.wav [--dur 0.8]
//   node shared/demo/synth.mjs --sfx stamp out.wav [--size 1.2 --pitch -2 ...]   (foley.js sounds too)
// Writes 44.1 kHz stereo 16-bit WAV plus out.beats.json (beat grid for cutting on beats).
// See SYNTH.md for the song format.
import fs from 'node:fs';
import path from 'node:path';
import { noteRender } from './renders.mjs';
import { pathToFileURL } from 'node:url';
import { render as foley, SOUNDS, MOVES, playedAt } from './foley.js';

export const SR = 44100;
const TAU = Math.PI * 2;
const sec = s => Math.max(1, Math.ceil(s * SR));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const dB = x => Math.pow(10, x / 20);
function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
let rand = mulberry(7);
const noise = () => rand() * 2 - 1;
const panL = p => Math.cos(((clamp(p, -1, 1) + 1) * Math.PI) / 4);
const panR = p => Math.sin(((clamp(p, -1, 1) + 1) * Math.PI) / 4);

// ---------- notes & chords ----------
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export const CHORDS = {
  '': [0, 4, 7], maj: [0, 4, 7], m: [0, 3, 7], 5: [0, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9],
  7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], 9: [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14], m11: [0, 3, 7, 10, 14, 17], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  sus2: [0, 2, 7], sus4: [0, 5, 7], '7sus4': [0, 5, 7, 10], dim: [0, 3, 6], m7b5: [0, 3, 6, 10], aug: [0, 4, 8],
  '6/9': [0, 4, 7, 9, 14],
};
export function midi(n) {
  if (typeof n === 'number') return n;
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(n);
  if (!m) throw new Error(`bad note "${n}" (want e.g. C4, F#3, Bb2)`);
  return 12 * (+m[3] + 1) + PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
export const hz = m => 440 * Math.pow(2, (m - 69) / 12);
function chordPcs(sym) { // 'Am7' -> {root pc, intervals}
  const m = /^([A-G][#b]?)(.*)$/.exec(sym);
  if (!m || !(m[2] in CHORDS)) throw new Error(`unknown chord "${sym}"; qualities: ${Object.keys(CHORDS).join(' ')}`);
  return { root: (midi(m[1] + '4') % 12), iv: CHORDS[m[2]] };
}
function parseTok(tok) { // 'C4' | 'A3m7' | 'C4+E4+G4' -> [midi...]
  const out = [];
  for (const part of tok.split('+')) {
    const m = /^([A-G][#b]?)(-?\d)(.*)$/.exec(part);
    if (!m) throw new Error(`can't read "${part}" (want C4, F#3, A3m7 or C4+E4+G4)`);
    const root = midi(m[1] + m[2]);
    if (!m[3]) { out.push(root); continue; }
    if (!(m[3] in CHORDS)) throw new Error(`unknown chord "${m[3]}" in "${part}"`);
    for (const i of CHORDS[m[3]]) out.push(root + i);
  }
  return out;
}
const tokens = s => (Array.isArray(s) ? s.join(' ') : String(s)).split(/\s+/).filter(t => t && t !== '|');

// ---------- helpers for writing songs ----------
// voice('Am7 Fmaj7 C G', {low:'E3', rootless}) -> 'E3+G3+A3+C4 ...' with smooth voice leading
export function voice(prog, { low = 'F3', rootless = false } = {}) {
  const lo = midi(low); let prev = null;
  return tokens(prog).map(t => {
    if (t === '-' || t === '.') return t;
    let { root, iv } = chordPcs(t.replace(/[!?]$/, ''));
    if (rootless && iv.length > 3) iv = iv.slice(1);
    const pcs = iv.map(i => (root + i) % 12); let best = null, bestCost = Infinity;
    for (let k = 0; k < pcs.length; k++) for (const lift of [0, 12]) {
      const ns = []; let m = lo + lift + ((pcs[k] - lo + 120) % 12); ns.push(m);
      for (let j = 1; j < pcs.length; j++) { const pc = pcs[(k + j) % pcs.length]; m += ((pc - m + 120) % 12) || 12; ns.push(m); }
      const c = ns.reduce((a, b) => a + b, 0) / ns.length;
      const cost = prev ? Math.abs(c - prev.c) + (prev.ns.length === ns.length ? ns.reduce((a, n, i) => a + Math.abs(n - prev.ns[i]), 0) / ns.length : 0)
        : Math.abs(c - (lo + 9));
      if (cost < bestCost) { bestCost = cost; best = { ns, c }; }
    }
    prev = best;
    const names = best.ns.map(n => ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][n % 12] + (Math.floor(n / 12) - 1));
    return names.join('+') + (t.match(/[!?]$/)?.[0] || '');
  }).join(' ');
}
// roots('Am7 F C G', 2) -> 'A2 F2 C2 G2'
export const roots = (prog, oct = 2) => tokens(prog).map(t => (t === '-' || t === '.') ? t : t.match(/^[A-G][#b]?/)[0] + oct).join(' ');
// arp('Am F C G', {steps:8, order:'up'|'down'|'updown'|'random', span:2, low:'A3'}) -> one token per step
export function arp(prog, { steps = 8, order = 'up', span = 2, low = 'A3', seed = 3 } = {}) {
  const r = mulberry(seed);
  return tokens(voice(prog, { low })).map(t => {
    if (t === '-' || t === '.') return Array(steps).fill(t === '.' ? '.' : '-').join(' ');
    const ns = parseTok(t); const pool = [];
    for (let o = 0; o < span; o++) for (const n of ns) pool.push(n + 12 * o);
    const seq = order === 'down' ? pool.slice().reverse() : order === 'updown' ? pool.concat(pool.slice(1, -1).reverse()) : pool;
    return Array.from({ length: steps }, (_, i) => { const n = order === 'random' ? pool[Math.floor(r() * pool.length)] : seq[i % seq.length];
      return ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][n % 12] + (Math.floor(n / 12) - 1); }).join(' ');
  }).join(' ');
}
// rep('x...', 4) -> repeated pattern text
export const rep = (s, n) => Array(n).fill(s).join(' ');

// ---------- DSP building blocks ----------
export function SVF() { // Simper/Cytomic state-variable filter: one call per sample
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0, k = 1;
  const f = {
    set(fc, res = 0.1) { const g = Math.tan((Math.PI * clamp(fc, 10, SR * 0.45)) / SR); k = 2 - 1.96 * clamp(res, 0, 1);
      a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; return f; },
    run(x) { const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2; f.l = v2; f.b = v1; f.h = x - k * v1 - v2; return v2; },
    lp: x => f.run(x), hp: x => (f.run(x), f.h), bp: x => (f.run(x), f.b),
  };
  return f;
}
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function osc(type, ph, dt, pw) {
  switch (type) {
    case 'sine': return Math.sin(TAU * ph);
    case 'saw': return 2 * ph - 1 - blep(ph, dt);
    case 'square': case 'pulse': { let p2 = ph - pw; if (p2 < 0) p2 += 1; return (ph < pw ? 1 : -1) + blep(ph, dt) - blep(p2, dt); }
    case 'tri': case 'triangle': return 1 - 4 * Math.abs(ph - 0.5);
    case 'tri4': return Math.round((1 - 4 * Math.abs(ph - 0.5)) * 7.5) / 7.5; // NES-style stepped triangle
    case 'organ': return 0.55 * (Math.sin(TAU * ph) + 0.5 * Math.sin(2 * TAU * ph) + 0.3 * Math.sin(3 * TAU * ph) + 0.18 * Math.sin(4 * TAU * ph) + 0.1 * Math.sin(6 * TAU * ph));
    case 'noise': return noise();
    default: throw new Error(`unknown osc "${type}"`);
  }
}
function LFSR(rate = 18000, short = false) { // NES-ish noise channel
  let reg = 1, acc = 0, out = 1;
  return () => { acc += rate / SR; while (acc >= 1) { acc--; const b = (reg ^ (reg >> (short ? 6 : 1))) & 1; reg = (reg >> 1) | (b << 14); out = reg & 1 ? 1 : -1; } return out; };
}

// ---------- instruments ----------
export const PRESETS = {
  sine: { osc: 'sine', env: [0.005, 0.1, 0.8, 0.15] },
  bass: { osc: 'saw', env: [0.003, 0.25, 0.6, 0.08], cutoff: 280, fenv: 1400, fdecay: 0.18, res: 0.25, sub: 0.6, track: 0.2 },
  sub: { osc: 'sine', env: [0.004, 0.1, 1, 0.08], drive: 0.4 },
  reese: { osc: 'saw', unison: 3, detune: 16, spread: 0.2, env: [0.01, 0.2, 0.9, 0.1], cutoff: 500, fenv: 400, res: 0.2, sub: 0.5 },
  lead: { osc: 'saw', unison: 3, detune: 9, env: [0.008, 0.25, 0.7, 0.2], cutoff: 1800, fenv: 2800, fdecay: 0.25, res: 0.2, vib: [5.5, 14, 0.25] },
  supersaw: { osc: 'saw', unison: 7, detune: 24, spread: 0.9, env: [0.01, 0.3, 0.75, 0.3], cutoff: 4500, fenv: 2500, fdecay: 0.3, res: 0.05, gain: 0.8 },
  pad: { osc: 'saw', unison: 5, detune: 14, spread: 0.85, env: [0.7, 0.6, 0.8, 1.4], cutoff: 900, fenv: 500, fdecay: 1.2, res: 0.1, gain: 0.7 },
  glass: { osc: 'tri', unison: 3, detune: 7, spread: 0.8, env: [0.4, 0.8, 0.7, 1.5], gain: 0.8, vib: [4, 6, 0.3] },
  strings: { osc: 'saw', unison: 3, detune: 11, spread: 0.7, env: [0.25, 0.4, 0.85, 0.7], cutoff: 2200, fenv: 600, fdecay: 0.6, res: 0.05, vib: [5, 9, 0.35], gain: 0.8 },
  brass: { osc: 'saw', unison: 2, detune: 6, env: [0.05, 0.3, 0.8, 0.15], cutoff: 500, fenv: 2600, fdecay: 0.35, res: 0.15 },
  organ: { osc: 'organ', env: [0.01, 0.1, 0.9, 0.08], vib: [6.5, 7, 0], gain: 0.8 },
  chip: { osc: 'pulse', pw: 0.25, env: [0.001, 0.08, 0.7, 0.04], vib: [6, 18, 0.18], gain: 0.55 },
  chipsquare: { osc: 'square', env: [0.001, 0.1, 0.6, 0.03], gain: 0.5 },
  chipbass: { osc: 'tri4', env: [0.001, 0.05, 1, 0.02], gain: 1 },
  epiano: { fm: { ratio: 1, index: 1.6, decay: 0.7, ratio2: 14, index2: 0.9, decay2: 0.03 }, env: [0.002, 2.2, 0.25, 0.45], gain: 0.9 },
  bell: { fm: { ratio: 3.5, index: 3.2, decay: 1.4 }, env: [0.001, 3, 0, 2], gain: 0.55 },
  mallet: { fm: { ratio: 4, index: 1.8, decay: 0.07 }, env: [0.001, 0.55, 0, 0.3] },
  kalimba: { fm: { ratio: 5.4, index: 1.4, decay: 0.05, ratio2: 1, index2: 0.3, decay2: 0.3 }, env: [0.001, 0.9, 0, 0.5] },
  pluck: { type: 'pluck', warm: true, bright: 0.55, decay: 1.4 }, // warm, like guitar
  guitar: { type: 'pluck', warm: true, bright: 0.4, decay: 3.5, gain: 0.9 },
  harp: { type: 'pluck', bright: 0.7, decay: 2.5 },
};
const resolve = x => {
  if (!x) return PRESETS.sine;
  if (typeof x === 'string') { if (!PRESETS[x]) throw new Error(`unknown instrument "${x}"; presets: ${Object.keys(PRESETS).join(' ')}`); return PRESETS[x]; }
  return x.preset ? { ...resolve(x.preset), ...x } : x;
};

function synthVoice(p, L, R, t0, dur, note, vel, pan) {
  const f0 = hz(note + 12 * (p.oct || 0));
  const [a, d, s, r] = p.env || [0.005, 0.2, 0.7, 0.2];
  const len = s > 0 ? dur + r : Math.min(dur + r, a + d * 1.3 + 0.01);
  const n0 = Math.floor(t0 * SR), n = Math.min(sec(len), L.length - n0);
  if (n <= 0) return;
  const amp = Math.pow(vel, 1.4) * (p.gain ?? 1);
  const type = p.osc || 'saw', pw = p.pw ?? 0.5, fm = p.fm;
  const U = fm ? 1 : p.unison || 1, det = p.detune || 0, spread = p.spread ?? 0.6;
  const ph = new Float64Array(U), inc = new Float64Array(U), gl = new Float64Array(U), gr = new Float64Array(U);
  for (let u = 0; u < U; u++) {
    const x = U === 1 ? 0 : (u / (U - 1)) * 2 - 1;
    inc[u] = (f0 * Math.pow(2, (x * det) / 1200)) / SR; ph[u] = U === 1 ? 0 : rand();
    gl[u] = panL(pan + x * spread) / Math.sqrt(U); gr[u] = panR(pan + x * spread) / Math.sqrt(U);
  }
  const [vr, vc, vd] = p.vib || [0, 0, 0];
  const fl = p.cutoff ? SVF() : null, fr = p.cutoff ? SVF() : null, res = p.res ?? 0.1;
  const fbase = (p.cutoff || 0) * Math.pow(f0 / 261.6, p.track ?? 0.3) * (0.55 + 0.45 * vel), fenv = (p.fenv || 0) * vel, fdec = (p.fdecay ?? 0.2) / 3;
  const sub = p.sub || 0, nz = p.noise || 0, drive = p.drive || 0, dn = drive ? Math.tanh(1 + drive * 3) : 1;
  const aS = a * SR, dT = (d * SR) / 4, durS = dur * SR, rS = r * SR, rT = rS / 5;
  const cl = panL(pan), cr = panR(pan);
  let rel = 0, sph = 0, mph = 0, mph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e;
    if (i < durS) { e = i < aS ? i / aS : s + (1 - s) * Math.exp(-(i - aS) / dT); rel = e; }
    else { const k = i - durS; e = k >= rS ? 0 : rel * Math.exp(-k / rT) * (1 - k / rS); }
    const pm = vc && t > vd ? 1 + vc * 0.000578 * Math.sin(TAU * vr * t) * Math.min(1, (t - vd) / 0.3) : 1;
    let l = 0, rr = 0;
    if (fm) {
      mph += inc[0] * fm.ratio * pm; mph2 += inc[0] * (fm.ratio2 || 0) * pm; ph[0] += inc[0] * pm;
      const v = Math.sin(TAU * ph[0] + fm.index * (0.4 + 0.6 * vel) * Math.exp(-t / fm.decay) * Math.sin(TAU * mph)
        + (fm.index2 ? fm.index2 * vel * Math.exp(-t / fm.decay2) * Math.sin(TAU * mph2) : 0));
      l = v * cl; rr = v * cr;
    } else {
      for (let u = 0; u < U; u++) {
        const dt = inc[u] * pm; let q = ph[u] + dt; if (q >= 1) q -= 1; ph[u] = q;
        const v = osc(type, q, dt, pw); l += v * gl[u]; rr += v * gr[u];
      }
    }
    if (sub) { sph += (inc[0] * pm) / 2; const v = sub * Math.sin(TAU * sph); l += v * cl; rr += v * cr; }
    if (nz) { const v = nz * noise(); l += v * cl; rr += v * cr; }
    if (fl) {
      if ((i & 7) === 0) { const fc = fbase + fenv * Math.exp(-t / fdec); fl.set(fc, res); fr.set(fc, res); }
      l = fl.lp(l); rr = fr.lp(rr);
    }
    if (drive) { l = Math.tanh(l * (1 + drive * 3)) / dn; rr = Math.tanh(rr * (1 + drive * 3)) / dn; }
    if (n - i < 64) e *= (n - i) / 64; // never end on a click
    L[n0 + i] += l * amp * e; R[n0 + i] += rr * amp * e;
  }
}

function pluckVoice(p, L, R, t0, dur, note, vel, pan) { // Karplus-Strong with allpass fine tuning
  const f = hz(note + 12 * (p.oct || 0)), period = SR / f, Li = Math.max(2, Math.floor(period - 0.5)), frac = period - 0.5 - Li;
  const C = (1 - frac) / (1 + frac), decay = p.decay ?? 1.5;
  const n0 = Math.floor(t0 * SR), n = Math.min(sec(Math.min(dur + 0.15, decay * 1.1)), L.length - n0);
  if (n <= 0) return;
  const buf = new Float32Array(Li); let lp = 0, mean = 0, pk = 1e-9;
  const b = clamp((p.bright ?? 0.5) * (0.45 + 0.55 * vel), 0.02, 1);
  for (let i = 0; i < Li; i++) { lp += b * (noise() - lp); buf[i] = lp; mean += lp / Li; }
  for (let i = 0; i < Li; i++) { buf[i] -= mean; pk = Math.max(pk, Math.abs(buf[i])); }
  const rho = Math.pow(0.001, 1 / (decay * f)), amp = (Math.pow(vel, 1.3) * (p.gain ?? 1)) / pk * 0.8;
  const cl = panL(pan), cr = panR(pan), durS = dur * SR;
  let idx = 0, prev = 0, apx = 0, apy = 0, dc = 0, dcy = 0;
  for (let i = 0; i < n; i++) {
    const x = buf[idx], avg = rho * 0.5 * (x + prev); prev = x;
    const y = C * avg + apx - C * apy; apx = avg; apy = y; buf[idx] = y; idx = idx + 1 === Li ? 0 : idx + 1;
    dcy = x - dc + 0.995 * dcy; dc = x; // DC blocker
    const e = (i < durS ? 1 : Math.exp(-(i - durS) / (0.02 * SR))) * Math.min(1, (n - i) / 200);
    L[n0 + i] += dcy * amp * e * cl; R[n0 + i] += dcy * amp * e * cr;
  }
}
// A warm plucked string, a finger on nylon rather than a pick on steel: the plain
// pluck above rings every harmonic up to 5 kHz for seconds on a low note, which reads as tinny. Here a soft, rounded
// excitation, a 6 ms onset and a 4-pole lowpass that opens to a few harmonics and closes on the lower ones within 0.1 s
// keep a low note under the twang bar. `bright` moves the opening within that warm range (it can't bring the twang back).
// It draws as many random numbers as the plain pluck, so swapping one for the other leaves every other track's take as it was.
function warmPluckVoice(p, L, R, t0, dur, note, vel, pan) {
  const f = hz(note + 12 * (p.oct || 0)), period = SR / f, Li = Math.max(2, Math.floor(period - 0.5)), frac = period - 0.5 - Li;
  const C = (1 - frac) / (1 + frac), decay = p.decay ?? 1.5;
  const n0 = Math.floor(t0 * SR), n = Math.min(sec(Math.min(dur + 0.15, decay * 1.1)), L.length - n0);
  if (n <= 0) return;
  const bright = clamp(p.bright ?? 0.5, 0, 1) * (0.6 + 0.4 * vel);
  const exc = 1 - Math.exp((-TAU * clamp(f * (3 + 6 * bright), 400, 1600)) / SR);
  const buf = new Float32Array(Li); let a = 0, b = 0, mean = 0, pk = 1e-9;
  for (let i = 0; i < Li; i++) { a += exc * (noise() - a); b += exc * (a - b); buf[i] = b * Math.sin((Math.PI * (i + 0.5)) / Li); mean += buf[i] / Li; }
  for (let i = 0; i < Li; i++) { buf[i] -= mean; pk = Math.max(pk, Math.abs(buf[i])); }
  const open = clamp(f * (5 + 5 * bright), 900, 1600), closed = clamp(f * 3, 380, 1000); // the tone filter's travel, Hz
  const rho = Math.pow(0.001, 1 / (decay * f)), amp = (Math.pow(vel, 1.3) * (p.gain ?? 1)) / pk * 1.1;
  const cl = panL(pan), cr = panR(pan), durS = dur * SR, onset = 0.006 * SR, tone = [SVF(), SVF()];
  let idx = 0, prev = 0, apx = 0, apy = 0, dc = 0, dcy = 0;
  for (let i = 0; i < n; i++) {
    const x = buf[idx], avg = rho * 0.5 * (x + prev); prev = x;
    const y = C * avg + apx - C * apy; apx = avg; apy = y; buf[idx] = y; idx = idx + 1 === Li ? 0 : idx + 1;
    dcy = x - dc + 0.995 * dcy; dc = x; // DC blocker
    if ((i & 7) === 0) { const fc = closed + (open - closed) * Math.exp(-i / (0.05 * SR)); tone[0].set(fc, 0); tone[1].set(fc, 0); }
    const v = tone[1].lp(tone[0].lp(dcy));
    const e = (i < onset ? 0.5 - 0.5 * Math.cos((Math.PI * i) / onset) : 1) * (i < durS ? 1 : Math.exp(-(i - durS) / (0.02 * SR))) * Math.min(1, (n - i) / 200);
    L[n0 + i] += v * amp * e * cl; R[n0 + i] += v * amp * e * cr;
  }
}
function playNote(p, L, R, t, dur, note, vel, pan) { (p.type === 'pluck' ? (p.warm ? warmPluckVoice : pluckVoice) : synthVoice)(p, L, R, t, dur, note, vel, pan); }

// ---------- drums ----------
export const KITS = {
  punchy: { kick: { tune: 52, punch: 190, sweep: 0.032, decay: 0.42, click: 0.5, drive: 2 }, snare: { tune: 190, tone: 0.45, decay: 0.2 }, hat: { decay: 0.045 }, ohat: { decay: 0.32 } },
  808: { kick: { tune: 44, punch: 120, sweep: 0.05, decay: 1.1, click: 0.12, drive: 1.3 }, snare: { tune: 175, tone: 0.55, decay: 0.24 }, hat: { decay: 0.05, tune: 1.5 } },
  lofi: { kick: { tune: 54, punch: 80, sweep: 0.045, decay: 0.34, click: 0.08, drive: 1.1 }, snare: { tune: 165, tone: 0.35, decay: 0.16, hp: 900 }, hat: { decay: 0.03, hp: 6000 }, rim: {} },
  chip: { kick: { wave: 'tri', tune: 48, punch: 260, sweep: 0.03, decay: 0.22, click: 0, drive: 1 }, snare: { tone: 0.2, decay: 0.13, lfsr: 1, hp: 800 }, hat: { decay: 0.03, lfsr: 1, metal: 0 }, ohat: { decay: 0.2, lfsr: 1, metal: 0 }, tom: { wave: 'tri' } },
};
const DRUM_DEFAULTS = {
  kick: { tune: 50, punch: 160, sweep: 0.035, decay: 0.45, click: 0.35, drive: 1.6 },
  tom: { tune: 105, punch: 70, sweep: 0.07, decay: 0.45, click: 0.1, drive: 1.1 },
  snare: { tune: 185, tone: 0.45, snap: 0.9, decay: 0.2, hp: 1500 },
  clap: { tune: 1150, decay: 0.2 }, hat: { decay: 0.045, hp: 7500, tune: 1.6, metal: 0.8 }, ohat: { decay: 0.32, hp: 7000, tune: 1.6, metal: 0.8 },
  crash: { decay: 1.8, hp: 4500, tune: 1.9, metal: 0.5 }, rim: { tune: 1750 }, shaker: { decay: 0.08 }, cowbell: { decay: 0.25 }, block: { tune: 900 },
};
const DRUMS = {
  kick(p) {
    const n = sec(p.decay * 1.25 + 0.02), o = new Float32Array(n), dr = p.drive, nd = Math.tanh(dr); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR; ph += (p.tune + p.punch * Math.exp(-t / p.sweep)) / SR;
      const w = p.wave === 'tri' ? 1 - 4 * Math.abs((ph % 1) - 0.5) : Math.sin(TAU * ph);
      o[i] = Math.tanh(dr * (w * Math.exp((-6.9 * t) / p.decay) + p.click * noise() * Math.exp(-t / 0.0012))) / nd;
    }
    return o;
  },
  tom: p => DRUMS.kick(p),
  snare(p) {
    const n = sec(p.decay * 1.3), o = new Float32Array(n), f = SVF().set(p.hp, 0.1), nz = p.lfsr ? LFSR(22000) : noise; let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR, pd = 1 + 0.5 * Math.exp(-t / 0.008); a += (p.tune * pd) / SR; b += (p.tune * 1.78 * pd) / SR;
      const tone = (0.65 * Math.sin(TAU * a) + 0.35 * Math.sin(TAU * b)) * Math.exp((-6.9 * t) / (p.decay * 0.55));
      o[i] = tone * p.tone + f.hp(nz()) * Math.exp((-6.9 * t) / p.decay) * (p.snap ?? 0.9);
    }
    return o;
  },
  clap(p) {
    const n = sec(0.035 + p.decay * 1.2), o = new Float32Array(n), f = SVF().set(p.tune, 0.45);
    for (let i = 0; i < n; i++) {
      const t = i / SR; let e = 0;
      for (const k of [0, 0.011, 0.022]) if (t >= k) e = Math.max(e, Math.exp(-(t - k) / 0.0035));
      if (t >= 0.031) e = Math.max(e, 0.6 * Math.exp((-6.9 * (t - 0.031)) / p.decay));
      o[i] = f.bp(noise()) * e * 2.2;
    }
    return o;
  },
  metal(p) { // hats & cymbals: six square partials + noise, high-passed
    const n = sec(p.decay * 1.2 + 0.005), o = new Float32Array(n), f = SVF().set(p.hp, 0.2), nz = p.lfsr ? LFSR(26000, true) : noise;
    const fr = [205.3, 304.4, 369.6, 522.7, 540, 800].map(x => (x * p.tune) / SR), ph = new Float64Array(6);
    for (let i = 0; i < n; i++) {
      let m = 0; for (let j = 0; j < 6; j++) { ph[j] += fr[j]; if (ph[j] >= 1) ph[j] -= 1; m += ph[j] < 0.5 ? 1 : -1; }
      const t = i / SR; o[i] = f.hp(nz() * (1 - p.metal * 0.5) + (m / 6) * p.metal) * Math.exp((-6.9 * t) / p.decay) * Math.min(1, t / 0.0008) * 1.3;
    }
    return o;
  },
  hat: p => DRUMS.metal(p), ohat: p => DRUMS.metal(p), crash: p => DRUMS.metal(p),
  rim(p) { const n = sec(0.05), o = new Float32Array(n), f = SVF().set(3000, 0.5);
    for (let i = 0; i < n; i++) { const t = i / SR; o[i] = (0.7 * Math.sin(TAU * p.tune * t) + 0.8 * f.bp(noise())) * Math.exp(-t / 0.007); } return o; },
  block(p) { const n = sec(0.12), o = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / SR; o[i] = (Math.sin(TAU * p.tune * t) + 0.5 * Math.sin(TAU * p.tune * 2.76 * t) * Math.exp(-t / 0.01)) * Math.exp(-t / 0.03); } return o; },
  shaker(p) { const n = sec(p.decay * 1.4 + 0.015), o = new Float32Array(n), f = SVF().set(6500, 0.3);
    for (let i = 0; i < n; i++) { const t = i / SR; o[i] = f.bp(noise()) * Math.min(1, t / 0.012) * Math.exp((-6.9 * Math.max(0, t - 0.012)) / p.decay) * 1.6; } return o; },
  cowbell(p) { const n = sec(p.decay * 1.3), o = new Float32Array(n), f = SVF().set(800, 0.5); let a = 0, b = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; a = (a + 562 / SR) % 1; b = (b + 845 / SR) % 1;
      o[i] = f.bp((a < 0.5 ? 1 : -1) + (b < 0.5 ? 1 : -1)) * (0.6 * Math.exp(-t / 0.012) + 0.4 * Math.exp((-6.9 * t) / p.decay)); } return o; },
};
export function drumHit(lane, opts = {}) {
  const base = lane.replace(/\d+$/, '');
  if (!DRUMS[base]) throw new Error(`unknown drum "${lane}"; lanes: ${Object.keys(DRUM_DEFAULTS).join(' ')}`);
  return DRUMS[base]({ ...DRUM_DEFAULTS[base], ...opts });
}

// ---------- sound effects ----------
// the effects' bell: its bright overtones die fast, so a ding stays under harsh.mjs's sharpness bar
const BELL = { ...PRESETS.bell, fm: { ...PRESETS.bell.fm, index: 1, decay: 0.35 } };
// each returns [L, R]; hit = seconds from start to the moment that should land on the beat
export const SFX = {
  whoosh({ dur = 0.8 } = {}) {
    const n = sec(dur), L = new Float32Array(n), R = new Float32Array(n), fl = SVF(), fr = SVF();
    for (let i = 0; i < n; i++) {
      const x = i / n, e = x < 0.75 ? Math.pow(x / 0.75, 2.2) : Math.pow(1 - (x - 0.75) / 0.25, 1.5);
      if ((i & 15) === 0) { const fc = 300 * Math.pow(18, Math.sin(Math.PI * Math.min(1, x / 0.9))); fl.set(fc, 0.55); fr.set(fc * 1.1, 0.55); }
      const p = -0.7 + 1.4 * x; L[i] = fl.bp(noise()) * e * panL(p) * 1.8; R[i] = fr.bp(noise()) * e * panR(p) * 1.8;
    }
    return { L, R, hit: dur * 0.75 };
  },
  riser({ dur = 2 } = {}) {
    const n = sec(dur), L = new Float32Array(n), R = new Float32Array(n), f = SVF(); let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      const x = i / n, e = Math.pow(x, 2) * Math.min(1, (n - i) / 300);
      if ((i & 15) === 0) f.set(200 * Math.pow(40, x), 0.4);
      const fq = 110 * Math.pow(4, x * x); a = (a + fq / SR) % 1; b = (b + (fq * 1.005) / SR) % 1;
      const v = f.bp(noise()) * 1.2 + 0.15 * (2 * a - 1) + 0.15 * (2 * b - 1);
      L[i] = v * e * (0.8 + 0.2 * Math.sin(TAU * 7 * x * x)); R[i] = v * e * (0.8 - 0.2 * Math.sin(TAU * 7 * x * x));
    }
    return { L, R, hit: dur };
  },
  pop({ pitch = 1 } = {}) { const n = sec(0.09), L = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / SR; ph += (pitch * (280 + 900 * Math.exp(-t / 0.012))) / SR; L[i] = Math.sin(TAU * ph) * Math.exp(-t / 0.025) * Math.min(1, t / 0.001); }
    return { L, R: L, hit: 0 }; },
  tap({ pitch = 1 } = {}) { const o = drumHit('block', { tune: 1500 * pitch }); return { L: o, R: o, hit: 0 }; },
  click() { const n = sec(0.02), o = new Float32Array(n), f = SVF().set(4000, 0.4);
    for (let i = 0; i < n; i++) o[i] = f.bp(noise()) * Math.exp(-i / SR / 0.002) * 2.5; return { L: o, R: o, hit: 0 }; },
  ding({ note = 'E6' } = {}) { const L = new Float32Array(sec(2.5)), R = new Float32Array(L.length);
    playNote(BELL, L, R, 0, 0.1, midi(note), 0.9, 0); playNote(PRESETS.sine, L, R, 0, 0.05, midi(note) + 12, 0.12, 0); return { L, R, hit: 0 }; },
  chime({ notes = ['C6', 'E6', 'G6', 'C7'] } = {}) { const L = new Float32Array(sec(3)), R = new Float32Array(L.length);
    notes.forEach((nn, k) => playNote(BELL, L, R, k * 0.07, 0.1, midi(nn), 0.8 - k * 0.08, -0.4 + (0.8 * k) / (notes.length - 1 || 1))); return { L, R, hit: 0 }; },
  sparkle({ dur = 0.8, count = 16 } = {}) { const L = new Float32Array(sec(dur + 1.2)), R = new Float32Array(L.length), pent = [0, 2, 4, 7, 9];
    for (let k = 0; k < count; k++) { const x = k / count, nn = 84 + pent[Math.floor(rand() * 5)] + 12 * Math.floor(rand() * 2);
      playNote(BELL, L, R, x * dur + rand() * 0.03, 0.05, nn, 0.5 * (1 - 0.6 * x) + 0.1, rand() * 1.6 - 0.8); }
    return { L, R, hit: 0 }; },
  boom() { const k = drumHit('kick', { tune: 38, punch: 90, sweep: 0.12, decay: 1.8, click: 0.3, drive: 2.2 }), f = SVF().set(900, 0.1), L = new Float32Array(k.length);
    for (let i = 0; i < k.length; i++) L[i] = k[i] * 0.9 + f.lp(noise()) * Math.exp(-i / SR / 0.25) * 0.8; return { L, R: L, hit: 0 }; },
  vinyl({ dur = 4 } = {}) { const n = sec(dur), L = new Float32Array(n), R = new Float32Array(n), f = SVF().set(3500, 0.1);
    for (let i = 0; i < n; i++) { const h = f.lp(noise()) * 0.05; L[i] = h + (rand() < 0.0004 ? noise() * 0.6 : 0); R[i] = h + (rand() < 0.0004 ? noise() * 0.6 : 0); } return { L, R, hit: 0 }; },
};

// ---------- effects ----------
export function freeverb(inL, inR, outL, outR, { size = 0.6, damp = 0.4, predelay = 0.02, width = 1 } = {}) {
  const fb = 0.7 + 0.28 * clamp(size, 0, 1), dmp = damp * 0.4, pre = Math.floor(predelay * SR), n = inL.length;
  const mk = (len) => ({ b: new Float32Array(len), i: 0, s: 0 });
  const cL = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map(mk), cR = [1139, 1211, 1300, 1379, 1445, 1514, 1580, 1640].map(mk);
  const aL = [556, 441, 341, 225].map(mk), aR = [579, 464, 364, 248].map(mk);
  const hp = SVF().set(180, 0), w1 = 0.5 + width / 2, w2 = (1 - width) / 2;
  const comb = (c, x) => { const y = c.b[c.i]; c.s = y * (1 - dmp) + c.s * dmp; c.b[c.i] = x + c.s * fb; if (++c.i === c.b.length) c.i = 0; return y; };
  const ap = (a, x) => { const y = a.b[a.i]; a.b[a.i] = x + y * 0.5; if (++a.i === a.b.length) a.i = 0; return y - x; };
  for (let i = 0; i < n; i++) {
    const j = i - pre, x = j >= 0 ? hp.hp((inL[j] + inR[j]) * 0.015) : 0;
    let l = 0, r = 0;
    for (let k = 0; k < 8; k++) { l += comb(cL[k], x); r += comb(cR[k], x); }
    for (let k = 0; k < 4; k++) { l = ap(aL[k], l); r = ap(aR[k], r); }
    outL[i] += (l * w1 + r * w2) * 3; outR[i] += (r * w1 + l * w2) * 3;
  }
}
function delayFx(inL, inR, outL, outR, { time = 0.375, fb = 0.35, lp = 3500, pingpong = true } = {}) {
  const D = Math.max(1, Math.round(time * SR)), bl = new Float32Array(D), br = new Float32Array(D), fl = SVF().set(lp, 0), fr = SVF().set(lp, 0);
  let idx = 0;
  for (let i = 0; i < inL.length; i++) {
    const yl = bl[idx], yr = br[idx];
    if (pingpong) { bl[idx] = (inL[i] + inR[i]) * 0.5 + fb * fr.lp(yr); br[idx] = fb * fl.lp(yl); }
    else { bl[idx] = inL[i] + fb * fl.lp(yl); br[idx] = inR[i] + fb * fr.lp(yr); }
    outL[i] += yl; outR[i] += yr; if (++idx === D) idx = 0;
  }
}
function biquad(b0, b1, b2, a0, a1, a2) { b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0; let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return x => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; }; }
export function lufs(L, R) { // ITU-R BS.1770 integrated loudness (K-weighted, gated)
  const kw = () => { let w = (TAU * 1500) / SR, A = Math.pow(10, 4 / 40), al = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), sA = 2 * Math.sqrt(A) * al;
    const s1 = biquad(A * (A + 1 + (A - 1) * c + sA), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - sA), A + 1 - (A - 1) * c + sA, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - sA);
    w = (TAU * 38) / SR; al = Math.sin(w) / (2 * 0.5); c = Math.cos(w);
    const s2 = biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); return x => s2(s1(x)); };
  const kl = kw(), kr = kw(), n = L.length, sq = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = kl(L[i]), b = kr(R[i]); sq[i] = a * a + b * b; }
  const B = Math.floor(0.4 * SR), H = Math.floor(0.1 * SR), blocks = [];
  const cum = new Float64Array(n + 1); for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + sq[i];
  for (let s = 0; s + B <= n; s += H) blocks.push((cum[s + B] - cum[s]) / B);
  const ld = z => -0.691 + 10 * Math.log10(z + 1e-12);
  let g = blocks.filter(z => ld(z) > -70); if (!g.length) return -70;
  const rel = ld(g.reduce((a, b) => a + b, 0) / g.length) - 10; g = g.filter(z => ld(z) > rel);
  return ld(g.reduce((a, b) => a + b, 0) / g.length);
}
function limit(L, R, ceiling, attack = 0.002, release = 0.08) { // offline look-ahead peak limiter, stereo-linked
  const n = L.length, g = new Float32Array(n), A = Math.max(1, attack * SR), rc = 1 - Math.exp(-1 / (release * SR));
  for (let i = 0; i < n; i++) { const p = Math.max(Math.abs(L[i]), Math.abs(R[i])); g[i] = p > ceiling ? ceiling / p : 1; }
  for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] + (1 - g[i - 1]) * rc);
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + 1 / A);
  for (let i = 0; i < n; i++) { L[i] *= g[i]; R[i] *= g[i]; }
}
const peakOf = (L, R) => { let p = 0; for (let i = 0; i < L.length; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i])); return p; };
// values can be a number or [from, to] ramped across the track's window (x = 0..1)
const ramp = (v, x, exp) => !Array.isArray(v) ? v : exp ? v[0] * Math.pow(v[1] / v[0], x) : v[0] + (v[1] - v[0]) * x;

// ---------- the sequencer ----------
function parsePattern(s) {
  const ev = []; let last = null; const toks = tokens(s);
  toks.forEach((t, i) => {
    if (t === '-' || t === '_') { if (last) last.len++; return; }
    if (t === '.') { last = null; return; }
    let vel = 0.8; if (t.endsWith('!')) { vel = 1; t = t.slice(0, -1); } else if (t.endsWith('?')) { vel = 0.5; t = t.slice(0, -1); }
    ev.push((last = { step: i, len: 1, notes: parseTok(t), vel }));
  });
  return { ev, n: toks.length };
}
function parseGrid(s) {
  const c = [...(Array.isArray(s) ? s.join('') : s).replace(/[\s|]/g, '')];
  return { ev: c.map((ch, i) => ({ step: i, len: 1, vel: { X: 1, x: 0.8, o: 0.45 }[ch] })).filter(e => e.vel), n: c.length };
}
function schedule(pat, step, from, to, T) {
  const sd = T.bar / step, total = Math.round((to - from) * step), out = [];
  if (!pat.n) return out;
  for (let base = 0; base < total; base += pat.n) for (const e of pat.ev) {
    const s = base + e.step; if (s >= total) break;
    out.push({ ...e, t: place(from * T.bar + s * sd, T), dur: Math.min(e.len, total - s) * sd });
  }
  return out;
}
function place(t, T) { // swing odd 16ths, optional humanize
  const six = T.beat / 4, s = t / six, r = Math.round(s);
  if (T.swing && Math.abs(s - r) < 1e-6 && r & 1) t += T.swing * six;
  if (T.human) t += (rand() - 0.5) * 0.014 * T.human;
  return Math.max(0, t);
}

// A song module's song: written as a function of the helpers, or as it is.
export const songOf = songIn => (typeof songIn === 'function' ? songIn({ voice, roots, arp, rep, midi, PRESETS, KITS }) : songIn);
// A track's notes (its transpose in), each once, so harsh.mjs can hold an instrument as a song plays it.
export const trackNotes = tr => [...new Set(parsePattern(tr.notes || '').ev.flatMap(e => e.notes).map(n => n + (tr.transpose || 0)))].sort((a, b) => a - b);
// One note of an instrument on its own: { L, R, sr, f0 } (f0 is the pitch it sounds, its `oct` in). Reseeds the generator.
export function renderNote(inst, note, { dur = 0.6, vel = 1, seed = 7 } = {}) {
  const p = resolve(inst), L = new Float32Array(sec(dur + 4)), R = new Float32Array(L.length), m = midi(note);
  rand = mulberry(seed);
  playNote(p, L, R, 0, dur, m, vel, 0);
  return { L, R, sr: SR, f0: hz(m + 12 * (p.oct || 0)) };
}
export function render(songIn, { solo = [], mute = [], log = () => {} } = {}) {
  const song = songOf(songIn);
  rand = mulberry(song.seed ?? 7);
  const bpm = song.bpm ?? 120, meter = song.meter ?? 4, beat = 60 / bpm, bar = beat * meter, bars = song.bars ?? 4;
  const loop = !!song.loop, tail = loop ? (song.tail ?? 3) : song.tail ?? 1.5, end = bars * bar, N = sec(end + tail);
  const T = { beat, bar, swing: song.swing ?? 0, human: song.humanize ?? 0 };
  const M = song.master || {};
  const mL = new Float32Array(N), mR = new Float32Array(N), rvL = new Float32Array(N), rvR = new Float32Array(N), dlL = new Float32Array(N), dlR = new Float32Array(N);
  const L = new Float32Array(N), R = new Float32Array(N);
  const all = song.tracks || [];
  const plan = all.map(tr => {
    const from = tr.from ?? 0, to = Math.min(tr.to ?? bars, bars), step = tr.step ?? 16;
    if (tr.drums) return Object.entries(tr.drums).flatMap(([lane, g]) => schedule(parseGrid(g), step, from, to, T).map(e => ({ ...e, lane })));
    if (tr.notes) return schedule(parsePattern(tr.notes), step, from, to, T);
    return [];
  });
  // sidechain envelope from every kick
  const duckEnv = new Float32Array(N), rel = (M.duckRelease ?? 0.45) * beat;
  plan.forEach(evs => evs.forEach(e => { if (!/^kick/.test(e.lane || '')) return;
    const s = Math.floor(e.t * SR); for (let i = s, v = 1; i < N && v > 0.002; i++) { const t = (i - s) / SR; v = Math.min(1, t / 0.004) * Math.exp(-t / (rel / 3)); if (v > duckEnv[i]) duckEnv[i] = v * e.vel; } }));

  const levels = {};
  all.forEach((tr, ti) => {
    const name = tr.name || `track${ti}`;
    if (mute.includes(name) || (solo.length && !solo.includes(name))) return;
    L.fill(0); R.fill(0);
    const pan = tr.pan ?? 0;
    if (tr.drums) {
      const kit = { ...(typeof tr.kit === 'string' ? KITS[tr.kit] : tr.kit || {}) };
      for (const e of plan[ti]) {
        const base = e.lane.replace(/\d+$/, ''), o = drumHit(e.lane, { ...(kit[base] || {}), ...(kit[e.lane] || {}) });
        const g = Math.pow(e.vel, 1.2) * (tr.mix?.[e.lane] ?? 1), p = tr.pans?.[e.lane] ?? pan, gl = g * panL(p), gr = g * panR(p), s = Math.floor(e.t * SR);
        for (let i = 0; i < o.length && s + i < N; i++) { L[s + i] += o[i] * gl; R[s + i] += o[i] * gr; }
      }
    } else if (tr.notes) {
      const p = resolve(tr.inst), gate = tr.gate ?? 0.92, tr8 = tr.transpose || 0;
      for (const e of plan[ti]) {
        const k = 1 / Math.sqrt(e.notes.length);
        e.notes.forEach((nn, j) => playNote(p, L, R, e.t + j * (tr.strum || 0), e.dur * gate, nn + tr8, e.vel * k, pan + (e.notes.length > 1 ? ((j / (e.notes.length - 1)) - 0.5) * (tr.width ?? 0.3) : 0)));
      }
    }
    for (const fx of tr.sfx || []) addSfx(fx, L, R, T);
    // track bus: drive, crush, filters, volume, ducking, sends
    const from = (tr.from ?? 0) * bar, to = Math.min(tr.to ?? bars, bars) * bar, span = Math.max(1e-6, to - from);
    const hpF = [SVF(), SVF()], lpF = [SVF(), SVF()], crush = tr.crush, dr = tr.drive, dn = dr ? Math.tanh(1 + dr * 3) : 1;
    let hl = 0, hr = 0, hc = 0, ss = 0;
    const vol = tr.vol ?? 0.8, duck = tr.duck || 0, rs = tr.reverb || 0, ds = tr.delay || 0;
    for (let i = 0; i < N; i++) {
      let l = L[i], r = R[i];
      const x = clamp((i / SR - from) / span, 0, 1);
      if (dr) { l = Math.tanh(l * (1 + dr * 3)) / dn; r = Math.tanh(r * (1 + dr * 3)) / dn; }
      if (crush) { if (--hc <= 0) { hc = Math.round(SR / (crush.rate || 11025)); const q = Math.pow(2, (crush.bits || 8) - 1); hl = Math.round(l * q) / q; hr = Math.round(r * q) / q; } l = hl; r = hr; }
      if (tr.hp) { if ((i & 31) === 0) { const f = ramp(tr.hp, x, 1); hpF[0].set(f, 0.1); hpF[1].set(f, 0.1); } l = hpF[0].hp(l); r = hpF[1].hp(r); }
      if (tr.lp) { if ((i & 31) === 0) { const f = ramp(tr.lp, x, 1); lpF[0].set(f, tr.lpRes ?? 0.1); lpF[1].set(f, tr.lpRes ?? 0.1); } l = lpF[0].lp(l); r = lpF[1].lp(r); }
      const g = ramp(vol, x) * (1 - duck * duckEnv[i]);
      l *= g; r *= g; mL[i] += l; mR[i] += r; ss += l * l + r * r;
      if (rs) { rvL[i] += l * rs; rvR[i] += r * rs; }
      if (ds) { dlL[i] += l * ds; dlR[i] += r * ds; }
    }
    levels[name] = ss;
  });
  // song-level sfx go straight to the mix with a little reverb
  if (song.sfx?.length && !solo.length) { L.fill(0); R.fill(0); for (const fx of song.sfx) addSfx(fx, L, R, T);
    for (let i = 0; i < N; i++) { mL[i] += L[i]; mR[i] += R[i]; rvL[i] += L[i] * 0.15; rvR[i] += R[i] * 0.15; } }

  const D = { time: 0.75, fb: 0.35, lp: 3500, ...(M.delay || {}) };
  L.fill(0); R.fill(0); delayFx(dlL, dlR, L, R, { ...D, time: D.time * beat });
  for (let i = 0; i < N; i++) { mL[i] += L[i]; mR[i] += R[i]; rvL[i] += L[i] * 0.3; rvR[i] += R[i] * 0.3; } // echoes get a bit of room too
  freeverb(rvL, rvR, mL, mR, M.reverb || {});
  masterChain(mL, mR, M, { loop, end, N });
  let outL = mL, outR = mR;
  if (loop) { // fold the tail back to the start so the file loops seamlessly
    const E = Math.round(end * SR); outL = mL.slice(0, E); outR = mR.slice(0, E);
    for (let i = E; i < N; i++) { outL[i - E] += mL[i]; outR[i - E] += mR[i]; }
  }
  let tot = 0; for (let i = 0; i < N; i++) tot += mL[i] * mL[i] + mR[i] * mR[i];
  for (const k in levels) levels[k] = +(10 * Math.log10(levels[k] / tot + 1e-12)).toFixed(1); // dB relative to the full mix
  const lvl = { ...finish(outL, outR, M), levels };
  const duration = outL.length / SR, bt = [], br = [];
  for (let b = 0; b <= bars * meter; b++) if (b * beat <= duration + 1e-9 && (b < bars * meter || !loop)) bt.push(+(b * beat).toFixed(4));
  for (let b = 0; b <= bars; b++) if (b * bar <= duration + 1e-9 && (b < bars || !loop)) br.push(+(b * bar).toFixed(4));
  const toSec = v => +(v * bar).toFixed(4);
  const markers = Object.entries(song.markers || {}).map(([name, v]) => ({ t: toSec(v), name }));
  const sEnt = Object.entries(song.sections || {}).sort((a, b) => a[1] - b[1]);
  const sections = sEnt.map(([name, v], i) => ({ name, start: toSec(v), end: toSec(i + 1 < sEnt.length ? sEnt[i + 1][1] : bars) }));
  const beats = { bpm, beatsPerBar: meter, duration: +duration.toFixed(4), musicEnd: +end.toFixed(4), tail: loop ? 0 : +tail.toFixed(4), loop, beats: bt, bars: br, markers, sections, ...(song.title ? { title: song.title } : {}) };
  return { L: outL, R: outR, beats, stats: lvl };
}

// the effects that move, at foley.js's MOVES like its own
const MOVING = new Set(['whoosh']), playLevel = type => (MOVING.has(type) ? MOVES : playedAt(type));
export const scaled = (o, g) => (g === 1 ? o : { ...o, L: o.L.map(x => x * g), R: o.R.map(x => x * g) });
function sfxOf(type, opts) { // a synth.mjs SFX, else a foley.js sound (its seed and pan the caller's), at the kit's level
  if (SFX[type]) return scaled(SFX[type](opts), playLevel(type));
  if (SOUNDS[type]) { const { type: _type, at: _at, to: _to, vol: _vol, pan: _pan, ...p } = opts; return scaled(foley(type, p, SR), playLevel(type)); }
  throw new Error(`unknown sfx "${type}"; have: ${Object.keys(SFX).join(' ')} and foley.js: ${Object.keys(SOUNDS).join(' ')}`);
}
function addSfx(fx, L, R, T) {
  const s = sfxOf(fx.type, fx), pos = fx.to != null ? fx.to * T.bar - s.hit : (fx.at ?? 0) * T.bar, v = fx.vol ?? 0.7, p = fx.pan ?? 0;
  const n0 = Math.round(pos * SR);
  for (let i = 0; i < s.L.length; i++) { const j = n0 + i; if (j < 0 || j >= L.length) continue; L[j] += s.L[i] * v * panL(p) * 1.41; R[j] += s.R[i] * v * panR(p) * 1.41; }
}

function masterChain(L, R, M, { loop, end, N }) {
  const lo = M.lofi;
  const hp = [SVF().set(M.hp || 28, 0), SVF().set(M.hp || 28, 0)], lp = M.lp ? [SVF().set(M.lp, 0.05), SVF().set(M.lp, 0.05)] : null;
  if (lo) { // tape wow/flutter, hiss, crackle
    const wow = (lo.wow ?? 1) * 0.0018 * SR, flt = (lo.flutter ?? 1) * 0.00012 * SR, base = wow + flt + 4, cL = L.slice(), cR = R.slice(), f = SVF().set(4000, 0);
    for (let i = 0; i < N; i++) {
      const t = i / SR, d = base + wow * Math.sin(TAU * 0.55 * t) + flt * Math.sin(TAU * 7.1 * t), j = i - d, k = Math.floor(j), fr = j - k;
      const a = k >= 0 ? cL[k] : 0, b = k + 1 >= 0 ? cL[k + 1] : 0, c = k >= 0 ? cR[k] : 0, e = k + 1 >= 0 ? cR[k + 1] : 0;
      const h = f.lp(noise()) * 0.012 * (lo.hiss ?? 1), cr = rand() < 0.00035 * (lo.crackle ?? 1) ? noise() * 0.25 : 0;
      L[i] = a + (b - a) * fr + h + cr; R[i] = c + (e - c) * fr + h + (rand() < 0.00035 * (lo.crackle ?? 1) ? noise() * 0.25 : 0);
    }
  }
  for (let i = 0; i < N; i++) {
    L[i] = hp[0].hp(L[i]); R[i] = hp[1].hp(R[i]);
    if (lp) { L[i] = lp[0].lp(L[i]); R[i] = lp[1].lp(R[i]); }
  }
  if (M.width != null) for (let i = 0; i < N; i++) { const m = (L[i] + R[i]) / 2, s = ((L[i] - R[i]) / 2) * M.width; L[i] = m + s; R[i] = m - s; }
  if (!loop) { // trim trailing silence, then a short fade
    let last = N - 1; const th = peakOf(L, R) * 0.0005; while (last > end * SR && Math.max(Math.abs(L[last]), Math.abs(R[last])) < th) last--;
    const F = sec(0.3); for (let i = Math.max(0, last - F); i < N; i++) { const g = i > last ? 0 : Math.pow((last - i) / F, 2); L[i] *= g; R[i] *= g; }
  }
}

export function finish(L, R, M) { // loudness to target, then true-ish peak ceiling
  const ceil = dB(M.ceiling ?? -1), target = M.loudness ?? -14, maxPush = M.maxPush ?? 8;
  const p0 = peakOf(L, R) || 1; for (let i = 0; i < L.length; i++) { L[i] *= ceil / p0; R[i] *= ceil / p0; }
  let pushed = 0;
  for (let k = 0; k < 3; k++) {
    const want = clamp(target - lufs(L, R), -24, maxPush - pushed); if (Math.abs(want) < 0.3) break;
    const g = dB(want); for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; } pushed += want; limit(L, R, ceil);
  }
  return { lufs: +lufs(L, R).toFixed(1), peakDb: +(20 * Math.log10(peakOf(L, R))).toFixed(2) };
}

export function renderSfx(type, opts = {}) {
  rand = mulberry(opts.seed ?? 11);
  const o = sfxOf(type, opts), n = o.L.length + sec(0.6), L = new Float32Array(n), R = new Float32Array(n);
  L.set(o.L); R.set(o.R); const wl = new Float32Array(n), wr = new Float32Array(n);
  const rl = new Float32Array(n), rr = new Float32Array(n); for (let i = 0; i < o.L.length; i++) { rl[i] = o.L[i] * 0.2; rr[i] = o.R[i] * 0.2; }
  freeverb(rl, rr, wl, wr, { size: 0.35, damp: 0.5 }); for (let i = 0; i < n; i++) { L[i] += wl[i]; R[i] += wr[i]; }
  let last = n - 1; const th = peakOf(L, R) * 0.0003; while (last > 0 && Math.abs(L[last]) < th && Math.abs(R[last]) < th) last--;
  // the peak is normalised here, so the play level goes on after it
  const g = (dB(opts.peak ?? -3) * playLevel(type)) / (peakOf(L, R) || 1);
  const oL = L.slice(0, last + 1), oR = R.slice(0, last + 1); for (let i = 0; i < oL.length; i++) { oL[i] *= g; oR[i] *= g; }
  return { L: oL, R: oR, hit: o.hit };
}

export function readWav(file) { // 16/24-bit PCM or 32-bit float, mono or stereo -> { L, R, sr }
  const b = fs.readFileSync(file); if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file}: not a WAV`);
  let fmt = null, o = 12;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4), d = o + 8;
    if (id === 'fmt ') { fmt = { tag: b.readUInt16LE(d), ch: b.readUInt16LE(d + 2), sr: b.readUInt32LE(d + 4), bits: b.readUInt16LE(d + 14) };
      if (fmt.tag === 0xfffe && len >= 26) fmt.tag = b.readUInt16LE(d + 24); } // WAVE_FORMAT_EXTENSIBLE: the real format is in the subformat GUID
    if (id === 'data' && fmt) {
      const bps = fmt.bits / 8, n = Math.floor(Math.min(len, b.length - d) / (bps * fmt.ch)), L = new Float32Array(n), R = new Float32Array(n);
      const rd = fmt.tag === 3 ? i => b.readFloatLE(i) : fmt.bits === 16 ? i => b.readInt16LE(i) / 32768 : fmt.bits === 24 ? i => b.readIntLE(i, 3) / 8388608 : null;
      if (!rd) throw new Error(`${file}: ${fmt.bits}-bit format ${fmt.tag} not supported (use 16/24-bit PCM or 32-bit float)`);
      for (let i = 0; i < n; i++) { const p = d + i * bps * fmt.ch; L[i] = rd(p); R[i] = fmt.ch > 1 ? rd(p + bps) : L[i]; }
      return { L, R, sr: fmt.sr };
    }
    o = d + len + (len & 1);
  }
  throw new Error(`${file}: no audio data`);
}

// 16-bit PCM with dither unless `bits` asks for 24-bit PCM or 32-bit float, at `rate` (the kit's SR unless given)
export function writeWav(file, L, R, { rate = SR, bits = 16 } = {}) { // (rate, bits)
  if (![16, 24, 32].includes(bits)) throw new Error(`writeWav: ${bits}-bit (16, 24 or 32)`);
  const n = L.length, bps = bits / 8, buf = Buffer.alloc(44 + n * 2 * bps);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2 * bps, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(bits === 32 ? 3 : 1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2 * bps, 28); buf.writeUInt16LE(2 * bps, 32); buf.writeUInt16LE(bits, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2 * bps, 40);
  const r = mulberry(99), q16 = x => clamp(Math.round(x * 32767 + (r() - r())), -32768, 32767); // TPDF dither
  const q24 = x => clamp(Math.round(x * 8388607), -8388608, 8388607);
  const put = bits === 16 ? (x, at) => buf.writeInt16LE(q16(x), at) : bits === 24 ? (x, at) => buf.writeIntLE(q24(x), at, 3) : (x, at) => buf.writeFloatLE(x, at);
  for (let i = 0; i < n; i++) { put(L[i], 44 + i * 2 * bps); put(R[i], 44 + i * 2 * bps + bps); }
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, buf);
  noteRender(file); // its .render.json, committed in its place (renders.mjs)
}

// ---------- CLI ----------
async function main(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); flags[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else pos.push(a); }
  const t0 = performance.now();
  if (flags.sfx) {
    const out = pos[0] || `${flags.sfx}.wav`, opts = {}; // every other flag is a param: --size 1.2 --material glass
    for (const [k, v] of Object.entries(flags)) if (k !== 'sfx') opts[k] = v === true ? true : v !== '' && !isNaN(+v) ? +v : v;
    const s = renderSfx(flags.sfx, opts); writeWav(out, s.L, s.R);
    console.log(`${out}: ${flags.sfx}, ${(s.L.length / SR).toFixed(2)} s, hit at ${s.hit.toFixed(3)} s`); return;
  }
  if (!pos[0] || flags.help) {
    console.log('usage: node synth.mjs song.mjs out.wav [--solo a,b] [--mute c]\n       node synth.mjs --sfx <name> out.wav [--dur s] [--param value ...]\n\nSFX: ' + Object.keys(SFX).join(' ') + '\nFoley (foley.js): ' + Object.keys(SOUNDS).join(' ') + '\nInstruments: ' + Object.keys(PRESETS).join(' ') + '\nKits: ' + Object.keys(KITS).join(' ') + '\nDrum lanes: ' + Object.keys(DRUM_DEFAULTS).join(' '));
    return;
  }
  const mod = await import(pathToFileURL(path.resolve(pos[0])).href);
  const out = pos[1] || pos[0].replace(/\.m?js$/, '.wav');
  const split = v => (typeof v === 'string' ? v.split(',') : []);
  const res = render(mod.default ?? mod.song, { solo: split(flags.solo), mute: split(flags.mute) });
  writeWav(out, res.L, res.R);
  const bfile = out.replace(/\.wav$/i, '') + '.beats.json';
  fs.writeFileSync(bfile, JSON.stringify(res.beats) + '\n');
  console.log(`${out}: ${res.beats.duration.toFixed(2)} s @ ${res.beats.bpm} bpm${res.beats.loop ? ' (loop)' : ''}, ${res.stats.lufs} LUFS, peak ${res.stats.peakDb} dBFS, rendered in ${((performance.now() - t0) / 1000).toFixed(2)} s\n${bfile}: ${res.beats.beats.length} beats, ${res.beats.markers.length} markers`);
  if (flags.levels) console.log('track levels (dB vs mix): ' + Object.entries(res.stats.levels).map(([k, v]) => `${k} ${v}`).join(', '));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main(process.argv.slice(2)).catch(e => { console.error('synth: ' + e.message); process.exit(1); });
