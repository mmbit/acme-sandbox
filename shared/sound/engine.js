// engine.js: plays a company's palette of tuned sounds through foley.js. Every tonal sound sits in one major key, soft
// materials are struck in code, and one tuning moves the whole palette together. The palette is the company's own
// (README.md): its sounds, their roles and its tunings.
//   import { use } from './engine.js'; use({ sounds, roles, tunings })   -> sfx.play('pat') in an app, a cue in mix.mjs
//   import { tune } from './engine.js'; tune('warm')                      -> call once, before the first sound
// It imports './foley.js': in the repo that file points at shared/demo/foley.js; an app's own points at the kit's path
// in the repo (README).
import { SOUNDS, SVF, thump, blip, pulse, modes } from './foley.js';

// A palette imports everything it builds with from this one file.
export { foley, render, SOUNDS, SVF, bus, pulse, modes, thump, blip, grain } from './foley.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ---- the key: every tonal sound picks scale degrees of one major key, so they sit together and with the beds
const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const PENTA = [0, 1, 2, 4, 5]; // the major pentatonic, as scale degrees: any two of them sound well together
// The root's distance from C in semitones, kept within half an octave (F# below to F above), so a new key moves the
// palette a few semitones and never an octave: its brightness and loudness stay where they were mastered.
export function rootOf(key) {
  const pc = PC[key]; if (pc == null) throw new Error(`unknown key "${key}" (want C, F#, Bb...)`);
  return ((pc + 6) % 12) - 6;
}
// MIDI note of scale degree d (0 = root, 2 = third, 4 = fifth, 7 = the octave; negative goes down) in octave oct
const midiOf = (key, d, oct) => 12 * (oct + 1) + rootOf(key) + 12 * Math.floor(d / 7) + MAJOR[((d % 7) + 7) % 7];
// 'D3', 'F#4': a degree of the key as a note name, for synth.mjs songs (the beds)
export const note = (key, d, oct) => { const m = midiOf(key, d, oct); return NAMES[m % 12] + (Math.floor(m / 12) - 1); };
// Hz of degree d in octave oct of this sound's key, plus the tuning's octave and the call's pitch (semitones)
export const tone = (p, d, oct = 5) => 440 * Math.pow(2, (midiOf(p.key, d, oct + (p.octave || 0)) + (p.pitch || 0) - 69) / 12);

// ---- materials, always struck with something soft (a fingertip, a felt mallet)
// r: mode ratios, a: their levels, t: decay (T60, s) at size 1, w: contact pulse (s), att: attack ramp (s; never a
// 0 ms click), lo: low body weight, nz: the brush of felt at the contact. A palette can add its own (`materials`).
export const MATERIALS = {
  wood: { r: [1, 2.71, 4.93], a: [1, 0.28, 0.08], t: [0.075, 0.032, 0.016], w: 0.0005, att: 0.003, lo: 0.45, nz: 0.1 }, // a felt-backed wooden key
  clay: { r: [1, 2.21, 3.73], a: [1, 0.32, 0.12], t: [0.11, 0.05, 0.028], w: 0.0004, att: 0.003, lo: 0.3, nz: 0.08 }, // a fired-clay bead or pot
  felt: { r: [1, 1.83, 2.95], a: [1, 0.3, 0.1], t: [0.06, 0.03, 0.018], w: 0.0012, att: 0.004, lo: 0.7, nz: 0.15 }, // a felt hammer on soft wood
  bar: { r: [1, 3.93, 9.24], a: [1, 0.22, 0.05], t: [0.55, 0.13, 0.04], w: 0.0006, att: 0.003, lo: 0.05, nz: 0.04 }, // a tuned wooden bar (1:4:10)
  ceramic: { r: [1, 2.08, 3.52, 5.31], a: [1, 0.36, 0.17, 0.07], t: [0.75, 0.42, 0.24, 0.13], w: 0.0003, att: 0.003, lo: 0, nz: 0.03 }, // a small cup
  glass: { r: [1, 2.32, 4.25, 6.63], a: [1, 0.3, 0.14, 0.06], t: [0.95, 0.55, 0.3, 0.18], w: 0.00025, att: 0.003, lo: 0, nz: 0.02 }, // a jar
};

// ---- building blocks: mono Float32Arrays a sound adds into its bus
const norm = y => { let m = 0; for (const v of y) m = Math.max(m, Math.abs(v)); if (m) for (let i = 0; i < y.length; i++) y[i] /= m; return y; };
export function ramp(c, y, att) { // a raised-sine fade-in over att seconds: the soft edge of a fingertip
  const n = Math.max(1, Math.round(att * c.sr));
  for (let i = 0; i < n && i < y.length; i++) y[i] *= Math.pow(Math.sin((Math.PI / 2) * (i / n)), 2);
  return y;
}
export function tail(y, frac = 0.25) { // a raised-cosine fade over the last part: a ring cut off mid-decay clicks, and clicks are bright
  const n = Math.max(1, Math.round(y.length * frac));
  for (let i = 0; i < n; i++) y[y.length - 1 - i] *= Math.pow(Math.sin((Math.PI / 2) * (i / n)), 2);
  return y;
}
export const low = (c, f0, f1, tau, amp) => ramp(c, thump(c, new Float32Array(c.n(tau * 8)), 0, f0, f1, tau, amp), 0.004); // the weight of a landing
export const bloop = (c, f, amp, ring = 2.5) => tail(ramp(c, blip(c, 3260 / (f / 1.25), amp, 0.5, ring), 0.003), 0.4); // a bubble whose rise centres on f

export function hush(c, secs, fc, env, res = 0.1) { // noise through a 4-pole low-pass that can move: air, felt, paper, all dark
  const n = c.n(secs), y = new Float32Array(n), a = SVF(c.sr), b = SVF(c.sr), f = typeof fc === 'function' ? fc : () => fc;
  for (let i = 0; i < n; i++) { const x = i / n, t = i / c.sr; if ((i & 15) === 0) { const hz = f(x, t); a.set(hz, res); b.set(hz, 0.1); } y[i] = b.lp(a.lp(c.nz())) * env(x, t); }
  return y;
}

// One soft strike of a material at f Hz, peak 1: contact pulse into the modes, a dark felt brush, the low weight.
export function strike(c, mat, f, { force = 0.8, decay = 1, size = 1, weight = 1 } = {}) { // weight scales the low body
  const m = MATERIALS[mat]; if (!m) throw new Error(`unknown material "${mat}"; have: ${Object.keys(MATERIALS).join(' ')}`);
  const list = m.r.map((r, k) => ({ f: f * r * (k ? 1 + c.rnd(-0.01, 0.01) : 1), t60: m.t[k] * decay * Math.sqrt(size), a: m.a[k] * Math.pow(force, k * 0.4) * c.rnd(0.85, 1.1) }));
  if (m.t[0] > 0.5) list.push(...list.slice(0, 2).map(q => ({ ...q, f: q.f * (1 + c.rnd(0.001, 0.003)), a: q.a * 0.35 }))); // a slow beat: the warm shimmer of a cup
  // every mode rings to the end of the buffer (the pulse is padded to it), then the whole strike fades: nothing is cut off
  const n = c.n(Math.max(...list.map(q => q.t60)) + 0.02), x = new Float32Array(n); x.set(pulse(c, m.w));
  const y = norm(modes(c, x, n, list));
  const fc = Math.min(2400 / Math.sqrt(size), f * 3), a = SVF(c.sr).set(fc, 0.1), b = SVF(c.sr).set(fc, 0.1); // 4-pole: the felt stays dark
  for (let i = 0, e = Math.min(n, c.n(0.02)); i < e; i++) y[i] += b.lp(a.lp(c.nz())) * m.nz * force * Math.exp(-i / (0.003 * c.sr));
  if (m.lo) { const body = clamp(f * 0.25, 60, 220) / Math.sqrt(size); thump(c, y, 0, body * 1.5, body, 0.01 * Math.sqrt(size), m.lo * force * weight); }
  return tail(ramp(c, norm(y), m.att));
}

// ---- the palette in use
// sounds: { name: { fn(c, p) -> { o: bus, hit }, role, level, about } }; roles: { role: how it's grouped and checked };
// tunings: { name: params every sound gets as defaults, plus `trim` (dB per sound) }. The first tuning is the default.
let inUse = null, current = null;
export function use({ sounds, roles, tunings, materials = {}, check = {} }) {
  const first = Object.values(tunings ?? {})[0];
  if (!first?.key) throw new Error('a palette needs tunings, and its first (the default) needs a key');
  const roleless = Object.keys(sounds).filter(name => !roles[sounds[name].role]);
  if (roleless.length) throw new Error(`these sounds' roles aren't in the palette's roles: ${roleless.join(' ')}`);
  // Never shadow a foley.js sound: if it ever adds one of the palette's names, say so instead of replacing it quietly
  for (const name in sounds) if (SOUNDS[name] && !SOUNDS[name].palette) throw new Error(`foley.js has its own "${name}": rename it in the palette`);
  for (const name in inUse?.sounds) delete SOUNDS[name];
  Object.assign(MATERIALS, materials);
  inUse = { sounds, roles, tunings, check };
  tune();
  return inUse;
}
export const tuning = () => current;
export const palette = () => inUse;

// tune('warm') or tune({ key: 'A', body: 'clay' }) (on top of the default tuning). It sets every sound's defaults, so
// a call's own params still win. Call it before the first sound: the browser player keeps rendered takes by their params.
export function tune(t) {
  if (!inUse) throw new Error('no palette in use: import one (it calls use()) before tune()');
  const [byDefault] = Object.values(inUse.tunings), base = t == null ? byDefault : typeof t === 'string' ? inUse.tunings[t] : t;
  if (!base) throw new Error(`unknown tuning "${t}"; have: ${Object.keys(inUse.tunings).join(' ')}`);
  const { trim = {}, ...params } = { ...byDefault, trim: undefined, ...base };
  current = { ...params, trim };
  // tuned: these sounds handle `pitch` themselves (their notes move, staying exact), so render() doesn't varispeed them
  for (const [name, { fn, level, about, role }] of Object.entries(inUse.sounds))
    SOUNDS[name] = { fn, p: { ...params }, tuned: true, level: level * Math.pow(10, (trim[name] ?? 0) / 20), about, role, palette: true };
  return current;
}
