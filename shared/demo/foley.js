// foley.js: the satisfying-sound kit. Foley-style sounds synthesised in code (a transient, a body
// and a tail, layered), with physical parameters. One dependency-free ES module for Node and the browser:
//   Node:    import { render, SOUNDS } from './foley.js'   -> { L, R, hit, sr } (mix.mjs and synth.mjs use it)
//   Browser: import { foley } from './foley.js'; const sfx = foley({ key: 'myapp:sound' });
//            sfx.play('stamp', { size: 1.2 }); sfx.bind(muteButton);
// The same name, params and seed give the same sound in the app and in the ad. See SYNTH.md.
const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const semi = s => Math.pow(2, s / 12);
function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteHz(n) { // 'E6' or a number of Hz
  if (typeof n === 'number') return n;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(n); if (!m) throw new Error(`bad note "${n}" (want e.g. E6, F#5)`);
  return 440 * Math.pow(2, (12 * (+m[3] + 1) + PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) - 69) / 12);
}

// ---------- building blocks ----------
// (exported: a sound built outside render() takes its context here)
export function kit(sr, seed) { // per-render context: sample rate and a seeded random stream
  const r = mulberry(Math.imul(Math.round(seed * 1009) | 0, 0x9e3779b1) ^ 0x85ebca6b);
  return { sr, r, rnd: (a = 0, b = 1) => a + (b - a) * r(), nz: () => r() * 2 - 1, n: s => Math.max(1, Math.ceil(s * sr)) };
}
function SVF(sr) { // Simper/Cytomic state-variable filter
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0, k = 1;
  const f = {
    set(fc, res = 0.1) { const g = Math.tan((Math.PI * clamp(fc, 10, sr * 0.45)) / sr); k = 2 - 1.96 * clamp(res, 0, 1);
      a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; return f; },
    run(x) { const v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2; f.b = v1; f.h = x - k * v1 - v2; return v2; },
    lp: x => f.run(x), hp: x => (f.run(x), f.h), bp: x => (f.run(x), f.b),
  };
  return f;
}
function bus(c, secs) { // a stereo buffer that mono layers are added into
  const n = c.n(secs + 0.06), L = new Float32Array(n), R = new Float32Array(n);
  return { L, R, n, add(x, at = 0, g = 1, pan = 0) {
    const o = Math.round(at * c.sr), a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4, gl = g * Math.cos(a) * Math.SQRT2, gr = g * Math.sin(a) * Math.SQRT2;
    for (let i = Math.max(0, -o); i < x.length && o + i < n; i++) { L[o + i] += x[i] * gl; R[o + i] += x[i] * gr; }
    return this; } };
}
function pulse(c, width) { // raised-cosine contact pulse of unit area: shorter = harder = brighter
  const n = Math.max(1, Math.round(width * c.sr)), x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (1 - Math.cos((TAU * (i + 0.5)) / n)) / n;
  return x;
}
function modes(c, x, n, list) { // a bank of damped resonant modes driven by x; each mode rings at amplitude a
  const y = new Float32Array(n);
  for (const m of list) {
    if (m.f >= c.sr * 0.45 || m.a <= 0) continue;
    const w = (TAU * m.f) / c.sr, r = Math.exp(-6.9078 / (m.t60 * c.sr)), a1 = 2 * r * Math.cos(w), a2 = -r * r, g = m.a * Math.sin(w);
    const len = Math.min(n, x.length + c.n(m.t60)); let y1 = 0, y2 = 0;
    for (let i = 0; i < len; i++) { const v = (i < x.length ? x[i] * g : 0) + a1 * y1 + a2 * y2; y2 = y1; y1 = v; y[i] += v; }
  }
  return y;
}
function thump(c, y, at, f0, f1, tau, amp) { // a pitch-dropping sine: the low weight of a landing
  const o = Math.round(at * c.sr), n = Math.min(y.length - o, c.n(tau * 7)); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / c.sr; ph += (f1 + (f0 - f1) * Math.exp(-t / (tau * 0.5))) / c.sr;
    y[o + i] += amp * Math.sin(TAU * ph) * Math.exp(-t / tau) * Math.min(1, t / 0.0015); }
  return y;
}
function noiseEnv(c, secs, filt, fc, res, env) { // filtered noise shaped by env(x 0..1, t s)
  const n = c.n(secs), y = new Float32Array(n), f = SVF(c.sr);
  for (let i = 0; i < n; i++) {
    const x = i / n, t = i / c.sr;
    if ((i & 15) === 0) f.set(typeof fc === 'function' ? fc(x, t) : fc, res);
    y[i] = f[filt](c.nz()) * env(x, t);
  }
  return y;
}
function blip(c, r, amp, rise, ring = 1) { // one bubble: Minnaert resonance (r in mm) with the rising chirp of a bubble at the surface
  const f0 = 3260 / r, d = (0.13 * f0 + 0.0072 * Math.pow(f0, 1.5)) / ring, n = c.n(6 / d), y = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { const t = i / c.sr; ph += (f0 * (1 + rise * (1 - Math.exp(-t * d * 0.5)))) / c.sr;
    y[i] = amp * Math.sin(TAU * ph) * Math.exp(-d * t) * Math.min(1, t / 0.0008); }
  return y;
}
function grain(c) { // slow random roughness 0..2 (paper tooth, fibres, graphite), sampled per call
  let g = 1, tg = 1, k = 0;
  return rate => { if (--k <= 0) { k = Math.round(c.sr / rate); tg = Math.pow(c.r(), 2) * 2.4; } g += (tg - g) * Math.min(1, (TAU * rate) / c.sr); return g; };
}
// Never harsh (measured by harsh.mjs, held by foley-check): a moving thing stays light
// (floor), its texture fluctuates slowly (grain at its rate), and noise sounds lose the fizz above 9 kHz (soften).
function floor(c, y, hz) { // a gentle cut under hz, in place: keeps a rub or a swish light (weight under 500 Hz is a box shoved)
  const f = SVF(c.sr).set(hz, 0.1);
  for (let i = 0; i < y.length; i++) y[i] = f.hp(y[i]);
  return y;
}
// Noise above 9 kHz is fizz, not air: nothing satisfying lives there, a phone plays it as hiss and the AAC encoder
// smears it. A 4-pole roll-off for every noise sound (a bright slide, pitched up, measures 3.05 acum with it, 3.95 without).
function soften(c, o) {
  const f = [0, 1, 2, 3].map(() => SVF(c.sr).set(9000, 0.1));
  for (let i = 0; i < o.n; i++) { o.L[i] = f[1].lp(f[0].lp(o.L[i])); o.R[i] = f[3].lp(f[2].lp(o.R[i])); }
}
// What moves (a slide, a swish, a page through the air) is a soft breath: noise low-passed to a warm band (hz(x), x 0..1),
// its weight cut under floorHz, shaped by env(x, t). A bright band of noise grates, so movements stay dark and quiet.
function breath(c, secs, hz, env, floorHz = 600) {
  const n = c.n(secs), y = new Float32Array(n), a = SVF(c.sr), b = SVF(c.sr), h = SVF(c.sr).set(floorHz, 0.1), k = SVF(c.sr).set(floorHz, 0.1);
  for (let i = 0; i < n; i++) {
    const x = i / n; if ((i & 15) === 0) { const f = hz(x); a.set(f, 0.1); b.set(f, 0.1); }
    y[i] = k.hp(h.hp(b.lp(a.lp(c.nz())))) * env(x, i / c.sr);
  }
  return y;
}
// A breath into the bus at `at` s, a different one on each side: air all round, and its level wobbles half as much as
// one breath's (a narrow band of noise judders by itself). Returns the two, for what resonates with it.
function air(c, o, at, ...args) {
  const l = breath(c, ...args), r = breath(c, ...args);
  o.add(l, at, Math.SQRT1_2, -1).add(r, at, Math.SQRT1_2, 1);
  return [l, r];
}

// ---------- materials: the struck-object model behind knock, tink, tick, clack, snap and lock ----------
// f: first mode Hz at size 1; r, a, t: mode ratios, amplitudes and T60 decay (s); w: contact time (s);
// nz: contact noise; lo: low body weight.
export const MATERIALS = {
  wood: { f: 760, r: [1, 2.57, 4.21, 5.9], a: [1, 0.35, 0.2, 0.1], t: [0.13, 0.05, 0.032, 0.02], w: 0.0006, nz: 0.35, lo: 0.3 },
  glass: { f: 2300, r: [1, 2.32, 4.25, 6.63, 9.38], a: [1, 0.55, 0.4, 0.28, 0.18], t: [1.4, 0.9, 0.6, 0.4, 0.28], w: 0.00012, nz: 0.05, lo: 0 },
  metal: { f: 1800, r: [1, 2.76, 5.4, 8.93, 13.34], a: [1, 0.7, 0.5, 0.35, 0.22], t: [1, 0.7, 0.45, 0.3, 0.2], w: 0.0001, nz: 0.08, lo: 0 },
  ceramic: { f: 1500, r: [1, 2.08, 3.52, 5.3, 7.4], a: [1, 0.6, 0.4, 0.25, 0.15], t: [0.45, 0.3, 0.2, 0.13, 0.09], w: 0.0002, nz: 0.15, lo: 0.1 },
  plastic: { f: 1250, r: [1, 1.61, 2.73, 3.95], a: [1, 0.6, 0.38, 0.22], t: [0.05, 0.035, 0.025, 0.018], w: 0.0004, nz: 0.5, lo: 0.2 },
  card: { f: 380, r: [1, 2.2, 3.7, 5.1], a: [1, 0.5, 0.3, 0.15], t: [0.035, 0.022, 0.015, 0.01], w: 0.0015, nz: 1, lo: 0.4 },
  rubber: { f: 160, r: [1, 1.9, 3.1], a: [1, 0.4, 0.2], t: [0.06, 0.035, 0.02], w: 0.004, nz: 0.25, lo: 0.8 },
};
function impact(c, p = {}) { // mono: contact pulse -> modes, plus contact noise and body weight
  const m = MATERIALS[p.material] || MATERIALS.wood, size = p.size ?? 1, force = clamp(p.force ?? 0.8, 0.05, 1.5);
  const f0 = (p.note != null ? noteHz(p.note) : m.f / size) * semi(p.pitch || 0), dk = (p.decay ?? 1) * Math.pow(size, 0.6);
  const list = m.r.map((r, k) => ({ f: f0 * r * (k ? 1 + c.rnd(-0.015, 0.015) : 1), t60: m.t[k] * dk, a: m.a[k] * Math.pow(force, k * 0.3) * c.rnd(0.8, 1.15) }));
  if (m.t[0] > 0.3) list.push(...list.slice(0, 3).map(q => ({ ...q, f: q.f * (1 + c.rnd(0.002, 0.005)), a: q.a * 0.4 }))); // beating pairs: the shimmer of glass and metal
  const n = c.n(Math.max(...list.map(q => q.t60)) * 0.8 + 0.03), y = modes(c, pulse(c, (m.w * Math.sqrt(size)) / (0.4 + force)), n, list);
  const hp = SVF(c.sr).set(Math.min(f0 * 1.5, 9000), 0.2), cn = 0.0006 + m.w * 2, na = m.nz * force * 0.6;
  for (let i = 0, e = Math.min(n, c.n(cn * 7)); i < e; i++) y[i] += hp.hp(c.nz()) * na * Math.exp(-i / (cn * c.sr));
  if (m.lo) thump(c, y, 0, clamp(f0 * 0.3, 55, 260) * 1.6, clamp(f0 * 0.3, 55, 260), 0.012 * Math.sqrt(size) + m.w * 4, m.lo * force);
  return y;
}
// Exported so a company's own kit can build its own palette from the same parts and register it in SOUNDS.
export { SVF, bus, pulse, modes, thump, blip, grain, breath, air };

// For porting a score's numpy synthesis onto the kit: sample times, sweeps, Gaussian noise and the score's filters.
// A biquad's Q as the SVF's res (k = 1 / Q = 2 - 1.96 res); FLAT is Butterworth's flat 2-pole response (Q 0.707)
export const resonance = q => (2 - 1 / q) / 1.96;
export const FLAT = resonance(Math.SQRT1_2);
// The sample times of s seconds
export const seconds = (c, s) => Float32Array.from({ length: Math.round(s * c.sr) }, (_, i) => i / c.sr);
// A sine whose frequency follows f(t), its phase summed sample by sample
export function sweep(c, t, frequencyAt) {
  let phase = 0;
  return t.map(k => {
    phase += (TAU * frequencyAt(k)) / c.sr;
    return Math.sin(phase);
  });
}
// Gaussian noise, as numpy draws it (Box-Muller on the render's seeded stream)
export const gauss = c => Math.sqrt(-2 * Math.log(1 - c.r())) * Math.cos(TAU * c.r());
export const noise = (c, n) => Float32Array.from({ length: n }, () => gauss(c));
// x through the SVF's lp, hp or bp at hzCut
export function filtered(c, x, hzCut, pass, res = FLAT) {
  const filter = SVF(c.sr).set(hzCut, res);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = filter[pass](x[i]);
  return y;
}
export const lowpass = (c, x, hzCut, res) => filtered(c, x, hzCut, 'lp', res);
export const highpass = (c, x, hzCut, res) => filtered(c, x, hzCut, 'hp', res);
const one = (c, y, pan = 0) => { const o = bus(c, y.length / c.sr); o.add(y, 0, 1, pan); return o; };

// ---------- the sounds: each returns { o: bus, hit: seconds from the start to the moment to sync on } ----------
function hit(c, p) { return { o: one(c, impact(c, p)), hit: 0 }; }

function tick(c, p) { // a clock escapement: pallet click, the wheel a hair later, the case under both
  const s = p.size ?? 1, pt = (p.pitch || 0) + (p.tock ? -4 : 0), o = bus(c, 0.25 * s);
  o.add(impact(c, { material: 'metal', size: 0.32 * s, decay: 0.07, force: p.force ?? 0.9, pitch: pt }), 0, 1, -0.05);
  o.add(impact(c, { material: 'metal', size: 0.45 * s, decay: 0.05, force: 0.6, pitch: pt - 3 }), 0.009 * s, 0.55, 0.05);
  o.add(impact(c, { material: 'wood', size: 0.9 * s, decay: 0.5, force: 0.5, pitch: pt }), 0, 0.35);
  return { o, hit: 0 };
}

function ratchet(c, p) { // winding: pawl clicks speeding up and rising, over a whisper of spring; hit = the last click
  const N = Math.max(1, Math.round(p.clicks ?? 10)), rate = p.rate ?? 16, acc = p.accel ?? 0.4, rise = p.rise ?? 2, s = p.size ?? 1, mat = p.material ?? 'metal';
  const times = []; for (let k = 0, t = 0; k < N; k++) { times.push(t); t += (1 / rate / (1 + (acc * k) / N)) * c.rnd(0.9, 1.1); }
  const end = times[N - 1], o = bus(c, end + 0.3);
  o.add(noiseEnv(c, end + 0.04, 'bp', 2800 / s, 0.3, (x, t) => 0.05 * Math.min(1, t / 0.02) * Math.min(1, (1 - x) * 8)), 0, 1, 0.1);
  times.forEach((tk, k) => { const x = k / Math.max(1, N - 1), last = k === N - 1;
    o.add(impact(c, { material: mat, size: 0.42 * s, decay: 0.05, force: last ? 1 : 0.75, pitch: (p.pitch || 0) + rise * x }), tk, last ? 1 : 0.7 * c.rnd(0.85, 1), k & 1 ? 0.12 : -0.12);
    o.add(impact(c, { material: 'plastic', size: 0.7 * s, force: 0.5, pitch: (p.pitch || 0) + rise * x }), tk + 0.002, 0.35); });
  return { o, hit: end };
}

function clack(c, p) { // a good mechanical key: click and low thock going down, a lighter clack coming back up
  const s = p.size ?? 1, hold = p.hold ?? 0.085, mat = p.material ?? 'plastic', pt = p.pitch || 0, o = bus(c, hold + 0.25);
  o.add(impact(c, { material: mat, size: 0.75 * s, force: p.force ?? 0.9, pitch: pt }), 0, 1);
  o.add(impact(c, { material: mat, size: 2.2 * s, force: 0.6, decay: 1.5, pitch: pt }), 0.001, 0.55);
  o.add(impact(c, { material: 'metal', size: 0.25, decay: 0.06, force: 0.3, pitch: pt }), 0.002, 0.06, 0.1); // spring ping
  if (hold > 0) o.add(impact(c, { material: mat, size: 0.6 * s, force: 0.55, pitch: pt + 3 }), hold, 0.5);
  return { o, hit: 0 };
}

const SWITCH_LEAF_MODES = [
  { ratio: 1, decaySeconds: 0.022, amplitude: 1 },
  { ratio: 1.52, decaySeconds: 0.014, amplitude: 0.55 },
  { ratio: 2.17, decaySeconds: 0.009, amplitude: 0.35 },
  { ratio: 2.94, decaySeconds: 0.006, amplitude: 0.2 },
];

// A stiff leaf snaps over, then the plastic stem lands a little later.
function switchClick(context, params) {
  const size = params.size ?? 1;
  const sizeScale = Math.sqrt(size);
  const pitch = params.pitch || 0;
  const force = clamp(params.force ?? 0.9, 0.05, 1.5);
  const hold = params.hold ?? 0;
  const output = bus(context, hold + 0.12);
  const leaf = (atSeconds, frequencyHz, gain, pan) => {
    const leafModes = SWITCH_LEAF_MODES.map((mode, index) => {
      const jitter = index ? 1 + context.rnd(-0.02, 0.02) : 1;
      return {
        f: frequencyHz * mode.ratio * jitter,
        t60: mode.decaySeconds * sizeScale,
        a: mode.amplitude * context.rnd(0.85, 1.1),
      };
    });
    const contactPulse = pulse(context, 0.00007);
    const sampleCount = context.n(0.05 * sizeScale);
    const samples = modes(context, contactPulse, sampleCount, leafModes);
    const cutoffHz = Math.min(frequencyHz * 0.8, 9000);
    const highpass = SVF(context.sr).set(cutoffHz, 0.2);
    const noiseSampleCount = context.n(0.003);
    for (let i = 0; i < noiseSampleCount; i++) {
      const filteredNoise = highpass.hp(context.nz());
      const decay = Math.exp(-i / (0.0005 * context.sr));
      samples[i] += filteredNoise * 0.5 * decay;
    }
    output.add(samples, atSeconds, gain * force, pan);
  };
  const frequencyHz = (3300 / size) * semi(pitch);
  // A bigger switch also has a deeper body under its click.
  const bodyFrequencyHz = (frequencyHz * 0.21) / sizeScale;
  leaf(0, frequencyHz, 1, -0.05);
  const stemPulse = pulse(context, 0.0003 * sizeScale);
  const stemSampleCount = context.n(0.04 * sizeScale);
  const stemModes = [
    { f: frequencyHz * 0.62, t60: 0.016 * sizeScale, a: 1 },
    { f: frequencyHz * 0.62 * 1.61, t60: 0.011 * sizeScale, a: 0.5 },
    { f: bodyFrequencyHz, t60: 0.014 * size, a: 0.9 },
  ];
  const stem = modes(context, stemPulse, stemSampleCount, stemModes);
  // Force affects only the leaf, so a harder press raises the click over the body.
  output.add(stem, 0.0035 * sizeScale, 0.45, 0.05);
  if (hold > 0) leaf(hold, frequencyHz * semi(4), 0.4, 0.05);
  return { o: output, hit: 0 };
}

function snap(c, p) { // magnetic snap: a tiny rising pull, then a hard click with a short thud and dead stop; hit = the click
  const s = p.size ?? 1, pre = p.pull ?? 0.06, pt = p.pitch || 0, o = bus(c, pre + 0.25);
  if (pre > 0) o.add(noiseEnv(c, pre, 'bp', x => 1500 + 4500 * x * x, 0.5, x => 0.25 * x * x * x));
  o.add(impact(c, { material: 'metal', size: 0.45 * s, decay: 0.1, force: 1.2, pitch: pt }), pre, 1);
  o.add(impact(c, { material: 'plastic', size: 1.1 * s, force: 1, pitch: pt }), pre, 0.7);
  o.add(thump(c, new Float32Array(c.n(0.2)), 0, 190 / s, 100 / s, 0.012 * s, 0.6), pre);
  return { o, hit: pre };
}

function lock(c, p) { // falls into place: a short slide, latch click, the body settling home, a small glassy "yes"; hit = the latch
  const s = p.size ?? 1, sl = p.slide ?? 0.16, ring = p.ring ?? 0.35, pt = p.pitch || 0, g = 0.024 * s, o = bus(c, sl + 1);
  if (sl > 0) air(c, o, 0, sl, x => (1300 + 600 * x) / Math.sqrt(s), x => 0.35 * Math.pow(x, 1.5), 600 / Math.sqrt(s));
  o.add(impact(c, { material: 'plastic', size: 0.55 * s, force: 1.1, pitch: pt }), sl, 0.8, -0.05);
  o.add(impact(c, { material: 'metal', size: 0.4 * s, decay: 0.08, force: 1, pitch: pt }), sl, 0.45);
  o.add(impact(c, { material: 'wood', size: 1.5 * s, force: 0.9, pitch: pt }), sl + g, 0.95, 0.05);
  o.add(thump(c, new Float32Array(c.n(0.3)), 0, 160 / s, 90 / s, 0.02 * s, 0.8), sl + g);
  if (ring > 0) o.add(impact(c, { material: 'glass', note: p.note ?? 'A6', force: 0.35, decay: 0.5, pitch: pt }), sl + g + 0.03, ring * 0.35, 0.15);
  return { o, hit: sl };
}

function stamp(c, p) { // rubber stamp: air, the thunk (squish, handle, table), then the tacky peel; hit = contact
  const s = p.size ?? 1, F = p.force ?? 0.9, pre = 0.035, peel = p.peel ?? 1, o = bus(c, pre + 0.75);
  o.add(noiseEnv(c, pre, 'lp', 700, 0.1, x => 0.12 * x * x));
  const y = thump(c, new Float32Array(c.n(0.45)), 0, 210 / s, 95 / s, 0.022 * s, F);
  const lp = SVF(c.sr).set(1000 / s, 0.2);
  for (let i = 0, e = c.n(0.12); i < e; i++) { const t = i / c.sr; y[i] += lp.lp(c.nz()) * 1.4 * F * Math.exp(-t / (0.025 * s)) * Math.min(1, t / 0.002); }
  const h = impact(c, { material: 'wood', size: 1.4 * s, force: F * 0.8 }), r = impact(c, { material: 'rubber', size: s, force: F });
  for (let i = 0; i < h.length && i < y.length; i++) y[i] += h[i] * 0.45; for (let i = 0; i < r.length && i < y.length; i++) y[i] += r[i] * 0.5;
  o.add(y, pre);
  if (peel > 0) { // inked rubber letting go: a quick crackle that swells and releases
    const at = pre + (p.hold ?? 0.17), n = c.n(0.06), z = new Float32Array(n), bp = SVF(c.sr).set(2600, 0.35); let cr = 0;
    for (let i = 0; i < n; i++) { const e = Math.pow(Math.sin((Math.PI * i) / n), 0.6); if (c.r() < 0.12 * e) cr = c.nz() * (0.4 + c.r()); z[i] = bp.bp(cr + c.nz() * 0.15) * e * 0.35 * peel; cr *= 0.6; }
    o.add(z, at, 1, 0.1);
    o.add(impact(c, { material: 'plastic', size: 0.5, force: 0.3 }), at + 0.055, 0.12 * peel, 0.1);
  }
  return { o, hit: pre };
}

function squish(c, p) { // ink squish: a wet, wobbling resonant squelch with a few small bubbles; hit = the press
  const s = p.size ?? 1, d = (p.dur ?? 0.24) * Math.sqrt(s), wet = clamp(p.wet ?? 0.7, 0, 1), o = bus(c, d + 0.15);
  // a 35 ms press, not a snap; the squelch's narrow ring shakes by itself (narrow noise judders), so a broad wet layer
  // carries the top steadily under it; bubbles of 2.5-5 mm bloop under 1.3 kHz instead of pinging in the top
  // (a broader squelch and quieter bubbles: played 0.4 st up, the narrower one juddered 41)
  const env = (x, t) => Math.min(1, t / 0.035) * Math.pow(1 - x, 1.6);
  let w = 0, wt = 0; // the wobble moves a few dozen times a second: faster, the squelch buzzes
  o.add(noiseEnv(c, d, 'bp', (x, t) => { if (c.r() < 0.008) wt = c.rnd(-1, 1); w += (wt - w) * 0.05; return ((1200 - 700 * Math.pow(x, 0.7)) / s) * (1 + 0.25 * w); },
    0.5 + 0.1 * wet, (x, t) => 0.9 * env(x, t)));
  o.add(noiseEnv(c, d, 'bp', 1600 / s, 0.1, env));
  o.add(noiseEnv(c, 0.12, 'lp', 250 / s, 0.1, (x, t) => 0.5 * Math.min(1, t / 0.004) * Math.exp(-t / 0.035)));
  for (let k = 0, B = Math.round(2 + wet * 6); k < B; k++) o.add(blip(c, c.rnd(2.5, 5) * s, c.rnd(0.15, 0.3) * wet, 0.4, 2.5), c.rnd(0.1, 0.8) * d, 1, c.rnd(-0.3, 0.3));
  return { o, hit: 0.012 };
}

function bubble(c, p) { // bubble pop: a round rising "bloop" with the tiny click of the surface breaking; count > 1 = a cluster
  const s = p.size ?? 1, N = Math.max(1, Math.round(p.bubbles ?? 1)), spread = p.dur ?? 0.3, o = bus(c, (N > 1 ? spread : 0) + 0.3);
  for (let k = 0; k < N; k++) {
    const at = k ? c.rnd(0, spread) : 0, r = (4 * s * (k ? c.rnd(0.45, 1.1) : 1)) / semi(p.pitch || 0);
    o.add(blip(c, r, k ? c.rnd(0.3, 0.7) : 1, p.rise ?? 0.6, p.ring ?? 3), at, 1, k ? c.rnd(-0.5, 0.5) : 0);
    o.add(noiseEnv(c, 0.004, 'hp', 3000, 0.2, (x, t) => 0.25 * Math.exp(-t / 0.0006)), at);
  }
  return { o, hit: 0 };
}

function pour(c, p) { // pour and fill: the stream, bubbles, and the air column above the water rising in pitch; hit = full
  const s = p.size ?? 1, d = p.dur ?? 1.8, fill = clamp(p.fill ?? 0.85, 0, 0.95), o = bus(c, d + 0.8), fE = 380 / s;
  const n = c.n(d), st = new Float32Array(n), col = new Float32Array(n), lp = SVF(c.sr).set(900, 0.1), bp = SVF(c.sr); let tb = 0.5, tt = 0.5;
  for (let i = 0; i < n; i++) {
    const x = i / n, t = i / c.sr, e = Math.min(1, t / 0.06) * Math.min(1, (n - i) / (0.12 * c.sr)), z = c.nz();
    if ((i & 255) === 0) tt = c.r(); tb += (tt - tb) * 0.002; // turbulence
    if ((i & 15) === 0) bp.set(fE / (1 - fill * x), 0.93); // quarter-wave column: shorter as it fills
    st[i] = lp.lp(z) * e * (0.15 + 0.25 * tb); col[i] = bp.bp(z) * e * 1.3 * (0.6 + 0.6 * tb);
  }
  o.add(st, 0, 1, -0.1).add(col, 0, 1, 0.1);
  for (let t = 0; (t += -Math.log(1 - c.r()) / 90) < d;) o.add(blip(c, c.rnd(1.5, 5) * (1 - 0.5 * fill * (t / d)) * s, c.rnd(0.1, 0.45), 0.15, 1.5), t, 1, c.rnd(-0.4, 0.4));
  for (let k = 0, t = d + 0.08; k < 3; k++, t += c.rnd(0.12, 0.25)) o.add(blip(c, c.rnd(2, 3.5) * s, 0.35 - k * 0.08, 0.5, 2), t, 1, c.rnd(-0.2, 0.2)); // last drips
  return { o, hit: d };
}

function crunch(c, p) { // crunch: brittle cracks (denser at the bite) over a pressed low body
  const s = p.size ?? 1, d = p.dur ?? 0.3, dry = clamp(p.dry ?? 0.7, 0, 1), o = bus(c, d + 0.15);
  for (let k = 0, G = Math.round(d * (90 + 320 * dry)); k < G; k++) {
    const t = d * Math.pow(c.r(), 1.8), a = Math.pow(c.r(), 2.2) * (1 - (0.6 * t) / d), f = (c.rnd(700, 4000) * (0.6 + 0.6 * dry)) / s, dec = c.rnd(0.0008, 0.005) * (1.4 - dry * 0.6);
    o.add(noiseEnv(c, dec * 5, 'bp', f, 0.45, (x, tt) => a * 2.5 * Math.exp(-tt / dec)), t, 1, c.rnd(-0.35, 0.35));
  }
  o.add(noiseEnv(c, 0.3 * s, 'lp', 500 / s, 0.1, (x, t) => 0.5 * Math.min(1, t / 0.003) * Math.exp(-t / (0.06 * s))));
  o.add(thump(c, new Float32Array(c.n(0.2)), 0, 120 / s, 70 / s, 0.02, 0.35));
  return { o, hit: 0 };
}

const TOOLS = { // pencil on paper, and friends: band (Hz), resonance, tooth, stick-slip clicks, table rumble, felt squeak
  pencil: { f: 3800, q: 0.3, grain: 0.5, clicks: 0.5, low: 0.07, squeak: 0 }, // (grain 0.8 juddered)
  crayon: { f: 2200, q: 0.35, grain: 0.6, clicks: 0.4, low: 0.12, squeak: 0 },
  marker: { f: 2600, q: 0.45, grain: 0.25, clicks: 0.1, low: 0.05, squeak: 0.6 },
  chalk: { f: 2600, q: 0.2, grain: 0.7, clicks: 0.5, low: 0.1, squeak: 0 },
};
function scribble(c, p) { // strokes back and forth; each speeds up and slows at the turn, and the pitch follows the speed
  const T = TOOLS[p.tool] || TOOLS.pencil, d = p.dur ?? 1, press = p.press ?? 0.7, s = p.size ?? 1, o = bus(c, d + 0.1);
  const K = Math.max(1, Math.round(d * (p.strokes ?? 7))), b = [0]; for (let k = 0; k < K; k++) b.push(b[k] + c.rnd(0.75, 1.25));
  for (let k = 0; k <= K; k++) b[k] *= d / b[K];
  const n = c.n(d), bp = SVF(c.sr), hp = SVF(c.sr).set(6500, 0.1), lo = SVF(c.sr).set(320, 0.1), gr = grain(c);
  let k = 0, sp = 1, clk = 0, sph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / c.sr; while (k < K - 1 && t > b[k + 1]) { k++; sp = c.rnd(0.7, 1.2); }
    const x = clamp((t - b[k]) / (b[k + 1] - b[k]), 0, 1), v = sp * Math.pow(Math.sin(Math.PI * x), 0.6), z = c.nz();
    if ((i & 15) === 0) bp.set((T.f / Math.sqrt(s)) * (0.55 + 0.6 * v), T.q);
    if (c.r() < (v * T.clicks * 150) / c.sr) clk = c.nz(); clk *= 0.5;
    // the paper's tooth passes under the point faster as the stroke speeds up, above the 15-150 Hz where it would judder
    // (a fixed 260 a second read judder 40 to 73 by stroke length)
    let y = (bp.bp(z) + 0.3 * hp.hp(z)) * (1 - T.grain * 0.5 + T.grain * 0.5 * gr(500 + 700 * v)) + clk * 0.7;
    y = y * Math.pow(v, 0.8) * press + lo.lp(z) * v * T.low * press * 2;
    if (T.squeak) { sph += (1300 + 700 * v) / s / c.sr; y += (Math.sin(TAU * sph) + 0.3 * Math.sin(2 * TAU * sph)) * T.squeak * 0.12 * Math.max(0, v - 0.4) * press; }
    const e = Math.min(1, t / 0.01, (d - t) / 0.03), pan = 0.3 * (k & 1 ? x : 1 - x) - 0.15;
    o.L[i] += y * e * Math.SQRT2 * Math.cos(((pan + 1) * Math.PI) / 4); o.R[i] += y * e * Math.SQRT2 * Math.sin(((pan + 1) * Math.PI) / 4);
  }
  return { o, hit: 0 };
}

// f: where the breath's band tops out (Hz, at full speed); stop: the material of the soft tap where it comes to rest
const SURFACES = { paper: { f: 2200, stop: null }, card: { f: 1900, stop: 'card' }, wood: { f: 1700, stop: 'wood' } };
function slide(c, p) { // a sheet or piece slid gently across the table, easing in and settling; hit = where it stops
  const d = p.dur ?? 0.45, s = p.size ?? 1, M = SURFACES[p.material] || SURFACES.paper, o = bus(c, d + 0.2);
  const v = x => Math.pow(Math.sin(Math.PI * Math.pow(x, 0.8)), 1.6);
  // a breath of air under the sheet, warmer as it slows, about 10 dB under a glass ding
  const [fr] = air(c, o, 0, d, x => (M.f / Math.sqrt(s)) * (0.55 + 0.45 * v(x)), v, 600 / Math.sqrt(s));
  if (M.stop === 'wood') o.add(modes(c, fr.map(x => x * 0.05), fr.length + c.n(0.1), MATERIALS.wood.r.map((r, k) => ({ f: (600 / s) * r, t60: 0.06, a: MATERIALS.wood.a[k] }))), 0, 1, 0.1);
  // a light stop, no thud: small and cut under 400 Hz, so a slide pitched down (the deck's step back) stays light
  if (M.stop) o.add(floor(c, impact(c, { material: M.stop, size: 0.65 * s, force: 0.2 }), 400 / s), d * 0.97, 0.15);
  return { o, hit: d * 0.97 };
}

function flip(c, p) { // page flip (paper) or card flip (card): lift or flick, flutter through the air, flap down; hit = the landing
  const card = p.material === 'card', s = p.size ?? 1, d = p.dur ?? (card ? 0.2 : 0.42), land = d * 0.86, o = bus(c, d + 0.25), gr = grain(c);
  // a card's flick is a crisp tick: its low thump is cut away, or the card reads as a knock
  if (card) { o.add(floor(c, floor(c, impact(c, { material: 'card', size: 0.45 * s, force: 1.1 }), 700), 700), 0, 0.5); o.add(noiseEnv(c, 0.004, 'hp', 3000, 0.1, () => 0.3)); }
  // a page's lift is one steady swell that the flutter rises out of: a short lift whose grain swung it 0 to 2.4 times
  // died before the flutter had risen, and a short or pitched-up page (a small leaf, 0.12 s) turned the gap into a
  // 25 to 50 Hz shake (judder up to 79 at 0.14 to 0.2 s; now 30 at most, 0.12 to 0.42 s, every size, 6 semitones up)
  else air(c, o, 0, d * 0.5, x => 1500 + 500 * x, x => 0.12 * Math.sin(Math.PI * x) * (0.6 + 0.4 * gr(30)));
  const fl = (card ? 45 : 22) * c.rnd(0.9, 1.1), a0 = d * 0.15, span = land - a0;
  // the flutter is a gentle sway (a deep one at 20 to 50 Hz reads as a judder), a soft breath through the air
  air(c, o, a0, span, x => (1100 + 900 * Math.sin(Math.PI * x)) / Math.sqrt(s),
    (x, t) => 0.3 * Math.pow(Math.sin(Math.PI * x), 1.5) * (0.75 + 0.25 * Math.abs(Math.sin(Math.PI * fl * t))), (card ? 900 : 700) / Math.sqrt(s));
  o.add(impact(c, { material: 'card', size: (card ? 0.9 : 1.7) * s, force: card ? 0.9 : 0.55 }), land, 0.9);
  o.add(noiseEnv(c, 0.05, 'lp', 600, 0.1, (x, t) => 0.5 * Math.exp(-t / 0.012)), land);
  return { o, hit: land };
}

function deal(c, p) { // a card dealt: it leaves the deck, swishes, slaps down and skids a hair; hit = the landing
  const s = p.size ?? 1, felt = (p.surface ?? 'felt') === 'felt', fly = p.fly ?? 0.11, at = 0.04 + fly, o = bus(c, at + 0.3);
  air(c, o, 0, 0.045, x => 1800 + 400 * x, x => 0.2 * x);
  air(c, o, 0.03, fly, x => 2100 - 500 * x, x => 0.3 * Math.sin(Math.PI * x)); // a soft swish through the air
  o.add(impact(c, { material: 'card', size: s, force: felt ? 0.5 : 0.9 }), at, 0.9, 0.15);
  o.add(noiseEnv(c, 0.06, 'lp', felt ? 1500 : 4000, 0.1, (x, t) => (felt ? 0.5 : 0.8) * Math.exp(-t / 0.012)), at, 1, 0.15);
  air(c, o, at + 0.008, 0.03, () => 1700, x => 0.08 * (1 - x));
  return { o, hit: at };
}

const CLOTH = { // grains per second, lowpass Hz, grain length range, crackle, silky hiss
  cotton: { rate: 55, cut: 2200, len: [0.03, 0.11], crack: 0.2, hiss: 0.1 },
  linen: { rate: 70, cut: 2800, len: [0.03, 0.09], crack: 0.5, hiss: 0.1 }, // (grains from 0.02 s juddered)
  silk: { rate: 35, cut: 4200, len: [0.05, 0.15], crack: 0, hiss: 0.35 },
  canvas: { rate: 60, cut: 1700, len: [0.04, 0.11], crack: 0.4, hiss: 0.05 }, // shorter crumples judder
};
function ruffle(c, p) { // cloth moving: overlapping soft crumples, a breath of moved air, and a hiss for silk
  const d = p.dur ?? 0.6, s = p.size ?? 1, C = CLOTH[p.material] || CLOTH.cotton, o = bus(c, d + 0.2);
  const env = x => (x < 0.15 ? x / 0.15 : Math.pow(Math.max(0, (1 - x) / 0.85), 1.3));
  for (let k = 0, G = Math.round(C.rate * d * (p.density ?? 1)); k < G; k++) {
    let x = c.r(); for (let tries = 0; tries < 8 && c.r() > env(x); tries++) x = c.r();
    const len = c.rnd(C.len[0], C.len[1]), a = Math.pow(c.r(), 1.3) * env(x), f = SVF(c.sr).set((c.rnd(0.5, 1.4) * C.cut) / s, 0.15), g = new Float32Array(c.n(len));
    for (let i = 0; i < g.length; i++) g[i] = (f.lp(c.nz()) + (c.r() < C.crack * 0.004 ? c.nz() * 2 : 0)) * a * Math.sin((Math.PI * i) / g.length);
    o.add(g, x * d, 0.8, c.rnd(-0.4, 0.4));
  }
  o.add(noiseEnv(c, d, 'lp', 200 / s, 0.1, x => 0.6 * env(x)));
  if (C.hiss) o.add(noiseEnv(c, d, 'hp', 5000, 0.1, x => C.hiss * 0.12 * env(x)), 0, 1, 0.2);
  return { o, hit: 0 };
}

// ---------- tuned bodies: a bell, a bar and a chime, struck with a soft felt mallet ----------
// f: the note (Hz) when none is given; r: each partial's ratio to the note; a: its level under a soft mallet;
// t: its T60 decay (s) at ring 1, the upper partials dying first; split: how far apart the two halves of each partial
// sit (a cast bell is never quite round, so each partial beats slowly, a different beat on each side).
// bell: a bronze bell's hum, prime, minor third, fifth, octave (the nominal) and the two above it.
// bar: a tuned vibraphone or marimba bar, 1 : 4 : 10. chime: a hanging tube, 1 : 2.76 : 5.40 : 8.93.
export const BODIES = {
  bell: { f: 660, r: [0.5, 1, 1.19, 1.5, 2, 2.5, 3], a: [0.4, 1, 0.42, 0.22, 0.4, 0.12, 0.06], t: [4, 3.2, 2.2, 1.6, 1.3, 0.8, 0.55], split: 0.003 },
  bar: { f: 523, r: [1, 3.95, 9.85], a: [1, 0.32, 0.08], t: [2.4, 0.7, 0.22], split: 0 },
  chime: { f: 1047, r: [1, 2.76, 5.4, 8.93], a: [1, 0.3, 0.12, 0.05], t: [3, 1.4, 0.7, 0.35], split: 0.0015 },
};
// A felt mallet stays on the surface for a few milliseconds: the sound swells in over that time (no click), and the
// partials above the mallet's corner are struck only softly. bright 0..1 is the mallet's hardness.
function mallet(c, p) {
  const body = BODIES[p.body] || BODIES.bell, size = p.size ?? 1, hardness = clamp(p.bright ?? 0.5, 0, 1);
  const f0 = (p.note != null ? noteHz(p.note) : body.f / size) * semi(p.pitch || 0);
  const ringFor = (p.ring ?? 1) * Math.pow(size, 0.6) * clamp(Math.pow(body.f / f0, 0.4), 0.5, 1.6); // a high note dies sooner
  const corner = 1.5 + 10 * hardness * hardness, swellSecs = 0.013 - 0.01 * hardness;
  const partials = body.r.map((r, k) => ({ f: f0 * r, t60: body.t[k] * ringFor, a: body.a[k] / (1 + (r / corner) ** 2) }));
  const longest = Math.max(...partials.map(q => q.t60)), o = bus(c, longest * 1.5 + 0.2), swell = c.n(swellSecs);
  // The two halves of a partial start together, one louder, and drift apart: a slow warble that never quite cancels
  // on a phone's one speaker.
  const halves = body.split ? [[1 - body.split / 2, 0.75, -0.5], [1 + body.split / 2, 0.25, 0.5]] : [[1, 1, 0]];
  for (const q of partials) {
    const f = q.f * (1 + c.rnd(-0.002, 0.002)), phase = c.rnd(0, TAU);
    for (const [detune, share, pan] of halves) o.add(ringing(f * detune, q.t60, swell, phase, c), 0, q.a * share, pan);
  }
  hall(c, o, (p.room ?? 0.2) * 0.9, Math.min(1.8, 0.6 + 0.4 * longest));
  return { o, hit: swellSecs / 2 };
}
// One partial: a damped sine that swells in over `swell` samples (a raised cosine, so it starts without a click), to
// 90 dB down. The sine and its decay run as one two-pole recursion.
function ringing(hz, t60, swell, phase, c) {
  const n = c.n(t60 * 1.5), y = new Float32Array(n);
  if (hz >= c.sr * 0.45) return y;
  const w = (TAU * hz) / c.sr, decay = Math.exp(-6.9078 / (t60 * c.sr));
  const a1 = 2 * decay * Math.cos(w), a2 = -decay * decay;
  let y2 = Math.sin(phase - w) / decay, y1 = Math.sin(phase);
  for (let i = 0; i < n; i++) {
    const rise = i < swell ? 0.5 - 0.5 * Math.cos((Math.PI * i) / swell) : 1;
    y[i] = y1 * rise;
    const next = a1 * y1 + a2 * y2;
    y2 = y1;
    y1 = next;
  }
  return y;
}
// A small, soft room tail (a four-line feedback delay network), added in place: amount of wet, t60 in seconds.
// Its highs die faster than its lows, as in a furnished room. Unrolled to scalars: an app renders it on a tap.
function hall(c, o, amount, t60) {
  if (!(amount > 0)) return;
  const [n0, n1, n2, n3] = [29.7, 37.1, 41.1, 43.7].map(ms => Math.round((ms / 1000) * c.sr)), pre = c.n(0.012);
  const line0 = new Float32Array(n0), line1 = new Float32Array(n1), line2 = new Float32Array(n2), line3 = new Float32Array(n3);
  const gain = n => 0.5 * Math.pow(10, (-3 * n) / (t60 * c.sr)); // the Hadamard matrix's 1/2, and the line's decay
  const g0 = gain(n0), g1 = gain(n1), g2 = gain(n2), g3 = gain(n3), soft = 1 - Math.exp((-TAU * 3500) / c.sr);
  const dry = new Float32Array(o.n);
  for (let i = 0; i < o.n; i++) dry[i] = (o.L[i] + o.R[i]) * 0.25;
  let h0 = 0, h1 = 0, h2 = 0, h3 = 0, d0 = 0, d1 = 0, d2 = 0, d3 = 0;
  for (let i = 0; i < o.n; i++) {
    const a = line0[h0], b = line1[h1], d = line2[h2], e = line3[h3], x = i >= pre ? dry[i - pre] : 0;
    o.L[i] += (a + d) * amount;
    o.R[i] += (b + e) * amount;
    d0 += soft * ((a + b + d + e) * g0 - d0);
    d1 += soft * ((a - b + d - e) * g1 - d1);
    d2 += soft * ((a + b - d - e) * g2 - d2);
    d3 += soft * ((a - b - d + e) * g3 - d3);
    line0[h0] = x + d0;
    line1[h1] = x + d1;
    line2[h2] = x + d2;
    line3[h3] = x + d3;
    h0 = h0 + 1 === n0 ? 0 : h0 + 1;
    h1 = h1 + 1 === n1 ? 0 : h1 + 1;
    h2 = h2 + 1 === n2 ? 0 : h2 + 1;
    h3 = h3 + 1 === n3 ? 0 : h3 + 1;
  }
}

// ---------- the palette ----------
// p: default params; level: peak after normalising (sustained textures sit lower than hits); hit: what "hit" means;
// tuned: the sound retunes its own resonances by `pitch` (the others are varispeeded by render(), like tape);
// moves: a sound of something moving over or through something (a slide, a stroke, cloth), played at MOVES.
// A sound that moves sits well under the hits and the bells: at the same level, a pencil across paper or a brush's
// strokes in a row read as loud as a bell and gritty at full volume. Wherever the kit plays a sound (the player,
// mix.mjs, synth.mjs) one that moves plays at MOVES of its level: the kit's own marked `moves`, a company's own by its
// `kind` or `also` 'glide'. render() leaves it whole, so a sound built from the kit's keeps its own balance.
export const MOVES = 0.5;
export const moves = def => !!def && (def.moves ?? (def.kind === 'glide' || def.also === 'glide'));
/** The gain the kit plays a sound at, by name: MOVES for one that moves, else 1. */
export const playedAt = name => (moves(SOUNDS[name]) ? MOVES : 1);
export const SOUNDS = {
  scribble: { fn: scribble, p: { dur: 1, strokes: 7, tool: 'pencil', press: 0.7 }, moves: true, level: 0.33, about: 'pencil scribbling on paper; tool pencil|crayon|marker|chalk, dur, strokes (per s), press' },
  scratch: { fn: scribble, p: { dur: 0.16, strokes: 6, tool: 'pencil', press: 0.9 }, moves: true, level: 0.37, about: 'one quick pencil stroke, a tick mark (scribble with one stroke)' },
  slide: { fn: slide, p: { dur: 0.45, material: 'paper' }, moves: true, level: 0.15, about: 'a sheet or piece slid across a table; material paper|card|wood; hit = where it stops' },
  flip: { fn: flip, p: { material: 'paper' }, level: 0.95, about: 'page flip (paper) or card flip (card): lift, flutter, flap down; hit = the landing' },
  deal: { fn: deal, p: { surface: 'felt' }, level: 0.95, about: 'a card dealt onto felt|table; fly (s of flight); hit = the landing' },
  stamp: { fn: stamp, p: { peel: 1 }, level: 0.95, about: 'rubber stamp thunk with the tacky peel after hold s (peel 0 = none); hit = contact' },
  squish: { fn: squish, p: { wet: 0.7 }, level: 0.41, about: 'wet ink squish; wet 0..1, dur' },
  ruffle: { fn: ruffle, p: { dur: 0.6, material: 'cotton' }, moves: true, level: 0.57, about: 'cloth moving; material cotton|linen|silk|canvas, dur, density' },
  snap: { fn: snap, p: {}, tuned: true, level: 0.95, about: 'magnetic snap: tiny pull (pull s), hard click, dead stop; hit = the click' },
  tick: { fn: tick, p: {}, tuned: true, level: 0.83, about: 'clockwork tick; tock: true for the lower half of tick-tock' },
  ratchet: { fn: ratchet, p: { clicks: 10, rate: 16 }, tuned: true, level: 0.75, about: 'winding ratchet; clicks, rate (per s), accel, rise (semitones), material metal|plastic; hit = the last click' },
  clack: { fn: clack, p: { hold: 0.085 }, tuned: true, level: 0.72, about: 'soft mechanical key, click-clack; hold (s between down and up, 0 = only down), material' },
  switch: { fn: switchClick, p: {}, tuned: true, level: 0.7, about: 'a crisp tactile switch, one bright dry click; hold (s to a lighter click letting go, 0 = none)' },
  bubble: { fn: bubble, p: { bubbles: 1 }, tuned: true, level: 0.69, about: 'bubble pop, a round rising bloop; bubbles > 1 for a cluster over dur, rise, ring' },
  pour: { fn: pour, p: { dur: 1.8, fill: 0.85 }, level: 0.34, about: 'pour and fill, the pitch climbing as it fills; dur, fill 0..0.95; hit = full' },
  crunch: { fn: crunch, p: { dur: 0.3, dry: 0.7 }, level: 0.84, about: 'crunch (paper ball, leaves, a biscuit); dry 0..1 (brittle), dur' },
  tink: { fn: hit, p: { material: 'glass', size: 0.8 }, tuned: true, level: 0.34, about: 'glass tink; any hit param, note to tune it (E6)' },
  knock: { fn: hit, p: { material: 'wood' }, tuned: true, level: 0.67, about: 'wood block knock; any hit param' },
  hit: { fn: hit, p: { material: 'wood' }, tuned: true, level: 0.67, about: 'a struck object; material wood|glass|metal|ceramic|plastic|card|rubber, size, force, decay, note' },
  lock: { fn: lock, p: {}, tuned: true, level: 0.95, about: 'the lock-in when something falls into place: slide, latch, settle, a small glassy ring (ring 0..1, note); hit = the latch' },
  mallet: { fn: mallet, p: { body: 'bell' }, tuned: true, level: 0.3, about: 'a tuned bell, bar or chime struck with a soft felt mallet; body bell|bar|chime, note (F5), ring (longer), bright (harder mallet); notes for a run' },
};

// ---------- render: name + params -> stereo buffers ----------
// Shared params: size (1 = default, 2 = twice as big and lower), pitch (semitones), bright (0..1, 0.5 = as designed),
// room (0..1 early reflections), pan (-1..1), vol, seed (same seed = same sound), force (how hard, where it applies),
// count/every/step/fade (repeats: every s apart, step semitones each, fade gain each), and for a tuned sound notes
// (a run: one take per note, every s apart, e.g. notes: ['C5', 'D5', 'F5'] for a pentatonic run).
export function render(name, params = {}, sr = 48000) {
  const def = SOUNDS[name]; if (!def) throw new Error(`unknown sound "${name}"; have: ${Object.keys(SOUNDS).join(' ')}`);
  const p = { ...def.p, ...params }, count = p.notes ? p.notes.length : Math.max(1, Math.round(p.count ?? 1));
  if (p.notes || count > 1) return repeat(name, p, count, sr);
  const c = kit(sr, p.seed ?? 1); let { o, hit: h } = def.fn(c, p);
  if (p.pitch && !def.tuned) { const k = semi(p.pitch); o = varispeed(c, o, k); h /= k; }
  tilt(c, o, p.bright ?? 0.5); if (!def.tuned) soften(c, o); room(c, o, p.room ?? 0.2);
  if (p.pan) { const a = ((clamp(p.pan, -1, 1) + 1) * Math.PI) / 4, gl = Math.cos(a) * Math.SQRT2, gr = Math.sin(a) * Math.SQRT2;
    for (let i = 0; i < o.n; i++) { const l = o.L[i], r = o.R[i]; o.L[i] = gl * (p.pan < 0 ? l + r * (1 - gr) : l); o.R[i] = gr * (p.pan > 0 ? r + l * (1 - gl) : r); } }
  let pk = 0; for (let i = 0; i < o.n; i++) pk = Math.max(pk, Math.abs(o.L[i]), Math.abs(o.R[i]));
  let end = o.n - 1; while (end > 0 && Math.abs(o.L[end]) < pk * 1e-4 && Math.abs(o.R[end]) < pk * 1e-4) end--;
  const L = o.L.slice(0, end + 1), R = o.R.slice(0, end + 1), g = pk ? ((def.level ?? 0.8) * (p.vol ?? 1)) / pk : 0, F = c.n(0.005);
  for (let i = 0; i < L.length; i++) { const e = g * Math.min(1, (L.length - i) / F); L[i] *= e; R[i] *= e; }
  return { L, R, hit: h, sr };
}
function repeat(name, p, count, sr) { // count copies (or one per note) `every` s apart, each a fresh seed, hits aligned
  const every = p.every ?? 0.12, parts = [], { notes, ...one } = p;
  for (let k = 0; k < count; k++) parts.push(render(name, { ...one, count: 1, note: notes ? notes[k] : p.note, seed: (p.seed ?? 1) + k, pitch: (p.pitch || 0) + (p.step || 0) * k, vol: (p.vol ?? 1) * Math.pow(p.fade ?? 1, k) }, sr));
  const h = Math.max(...parts.map(q => q.hit)), n = Math.max(...parts.map((q, k) => Math.round((h - q.hit + k * every) * sr) + q.L.length));
  const L = new Float32Array(n), R = new Float32Array(n); let pk = 0;
  parts.forEach((q, k) => { const o = Math.round((h - q.hit + k * every) * sr); for (let i = 0; i < q.L.length; i++) { L[o + i] += q.L[i]; R[o + i] += q.R[i]; } });
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
  if (pk > 0.98) for (let i = 0; i < n; i++) { L[i] *= 0.98 / pk; R[i] *= 0.98 / pk; }
  return { L, R, hit: h, sr };
}
function varispeed(c, o, k) { // plays the bus k times faster (tape-style: higher and shorter), band-limited when going up
  const n = Math.max(1, Math.floor((o.n - 1) / k)), out = { L: new Float32Array(n), R: new Float32Array(n), n };
  for (const [src, dst] of [[o.L, out.L], [o.R, out.R]]) {
    let x = src;
    if (k > 1) { const a = SVF(c.sr).set((c.sr * 0.42) / k, 0.3), b = SVF(c.sr).set((c.sr * 0.42) / k, 0.3); x = src.map(v => b.lp(a.lp(v))); }
    for (let i = 0; i < n; i++) { // cubic Hermite between the four nearest samples
      const t = i * k, j = Math.floor(t), f = t - j, y0 = x[Math.max(0, j - 1)], y1 = x[j], y2 = x[Math.min(o.n - 1, j + 1)], y3 = x[Math.min(o.n - 1, j + 2)];
      dst[i] = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
    }
  }
  return out;
}
function tilt(c, o, bright) { // bright 0..1: darker below 0.5, crisper above
  const k = (bright - 0.5) * 2; if (Math.abs(k) < 1e-3) return;
  const a = 1 - Math.exp((-TAU * 2500) / c.sr), m = k > 0 ? k : 0.8 * k;
  for (const ch of [o.L, o.R]) { let lp = 0; for (let i = 0; i < o.n; i++) { lp += a * (ch[i] - lp); ch[i] += m * (ch[i] - lp); } }
}
function room(c, o, amt) { // a few early reflections off a nearby table and walls: presence and width, no long tail
  if (!(amt > 0)) return;
  const tl = [[7.1, 0.5], [11.9, 0.38], [17.3, 0.3], [24.1, 0.22], [31.3, 0.16], [39.7, 0.11]], trr = [[8.9, 0.48], [13.1, 0.36], [19.7, 0.28], [26.3, 0.2], [34.1, 0.15], [43.1, 0.1]];
  const n = o.n, m = new Float32Array(n), a = 1 - Math.exp((-TAU * 5000) / c.sr);
  for (let i = 0; i < n; i++) m[i] = (o.L[i] + o.R[i]) * 0.5;
  for (const [ch, taps] of [[o.L, tl], [o.R, trr]]) {
    const e = new Float32Array(n);
    for (const [ms, g] of taps) { const dly = Math.round((ms / 1000) * c.sr); for (let i = dly; i < n; i++) e[i] += m[i - dly] * g; }
    let lp = 0; for (let i = 0; i < n; i++) { lp += a * (e[i] - lp); ch[i] += lp * amt; }
  }
}

// ---------- the browser player ----------
// const sfx = foley({ key: 'myapp:sound', volume: 0.5 }); sfx.play('stamp'); sfx.bind(button);
// Silent until the first tap or key press (browsers require it) and while muted; the choice is kept in localStorage.
// Muting fades the output out at once and stops every sound playing or scheduled (a later unmute doesn't bring them back).
// Every play varies a little (the next of `variants` seeds, pitch and level within `vary` semitones/dB) so repeats never
// grate, and the take after it renders in idle time, so only a sound's first play waits for a render.
// A listening piece (a soundboard, a scored film) also has:
//   sfx.prepare([[name, params], [name, params, { loop: true }]]) renders first takes in idle time, before any tap;
//   play(name, { destination, onended }) plays into a node of the piece's own (a gain it moves) and says when it's done;
//   sfx.loop(name, { dur, destination }) loops a sound that has a dur (a bed), its end running on into its start;
//   sfx.stop(destination, fade) fades out and stops what's playing or scheduled into it (everything, without one).
// PLAYER: the defaults, which harsh.mjs measures every take of.
export const PLAYER = { volume: 0.35, vary: 0.4, variants: 4 };
// The take play(name, params) plays, rendered anywhere (a worker, for the player's keep): params without the player's
// own, and the key the player keeps it under
const PLAYER_PARAMS = ['vol', 'vary', 'delay', 'destination', 'onended'];
const takeParams = params => Object.fromEntries(Object.entries(params).filter(([k]) => !PLAYER_PARAMS.includes(k)));
const takeKey = (name, p, seed, looped = false) => name + JSON.stringify(p) + '#' + seed + (looped ? ' loop' : '');
export function renderTake(name, params, sr = 48000) { const p = takeParams(params); return render(name, { ...p, seed: p.seed ?? 1 }, sr); }
const TAKES = 64; // rendered takes kept (a prepared one always), the oldest let go first
const JOIN_S = 1; // a loop's end, crossfaded into its start
export function foley({ key = 'hq:sound', volume = PLAYER.volume, vary = PLAYER.vary, variants = PLAYER.variants, muted: startMuted = false } = {}) {
  const w = globalThis, takes = new Map(), turns = new Map(), subs = new Set(), playing = new Set();
  let ac = null, out = null, muted = startMuted, gesture = -1e9;
  try { const v = w.localStorage?.getItem(key); if (v) muted = v === 'off'; } catch {}
  const wake = () => {
    gesture = Date.now();
    if (muted) return;
    if (!ac) { const AC = w.AudioContext || w.webkitAudioContext; if (!AC) return;
      ac = new AC(); out = ac.createGain(); out.gain.value = volume;
      const lim = ac.createDynamicsCompressor(); lim.threshold.value = -10; lim.knee.value = 6; lim.ratio.value = 8; lim.attack.value = 0.002; lim.release.value = 0.12;
      out.connect(lim).connect(ac.destination); }
    if (ac.state === 'suspended') ac.resume();
  };
  for (const e of ['pointerdown', 'keydown', 'touchend']) w.addEventListener?.(e, wake, { capture: true, passive: true });
  const live = () => ac && (ac.state === 'running' || (ac.state === 'suspended' && Date.now() - gesture < 1000));
  const level = () => { // the output follows volume and mute, with a 15 ms glide so it never clicks
    if (!out) return; const g = out.gain, t = ac.currentTime;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t); else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.setTargetAtTime(muted ? 0 : volume, t, 0.015);
  };
  // A take, rendered once (at 48 kHz before there's a context, the browser resamples it), its buffer made once there is.
  const take = (name, p, seed, looped = false) => {
    const k = takeKey(name, p, seed, looped); let t = takes.get(k);
    if (!t) {
      const sr = ac ? ac.sampleRate : 48000, s = looped ? joined(name, p, seed, sr) : render(name, { ...p, seed }, sr);
      if (takes.size >= TAKES) { const old = [...takes].find(([, o]) => !o.kept); if (old) takes.delete(old[0]); }
      takes.set(k, (t = { sound: s, hit: s.hit, buffer: null, kept: false }));
    }
    if (!t.buffer && ac) { const s = t.sound; t.buffer = ac.createBuffer(2, s.L.length, s.sr); t.buffer.copyToChannel(s.L, 0); t.buffer.copyToChannel(s.R, 1); t.sound = null; }
    return t;
  };
  const start = (t, { destination = out, vol = 1, rate = 1, delay = 0, loop = false, onended } = {}) => {
    const src = ac.createBufferSource(), g = ac.createGain(), sound = { src, g, destination };
    src.buffer = t.buffer; src.loop = loop; src.playbackRate.value = rate; g.gain.value = vol;
    src.connect(g).connect(destination); src.start(ac.currentTime + delay);
    playing.add(sound); src.onended = () => { playing.delete(sound); onended?.(); };
  };
  const idle = work => new Promise(done => { const run = () => done(work()); if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 2000 }); else setTimeout(run, 30); });
  const api = {
    get muted() { return muted; },
    get ready() { return !muted && !!ac && ac.state === 'running'; },
    get context() { return ac; },
    get output() { return out; },
    setMuted(m) {
      muted = !!m; try { w.localStorage?.setItem(key, muted ? 'off' : 'on'); } catch {}
      if (muted && ac) { const t = ac.currentTime + 0.1; playing.forEach(s => s.src.stop(t)); playing.clear(); } // once faded out
      if (!muted) wake(); level(); subs.forEach(f => f(muted));
    },
    toggle() { api.setMuted(!muted); return muted; },
    onchange(f) { subs.add(f); return () => subs.delete(f); },
    setVolume(v) { volume = v; level(); },
    // Plays now (or `delay` s from now). Returns the seconds until the sound's hit, or null when silent.
    play(name, params = {}) {
      if (muted || !live()) return null;
      const { vol = 1, vary: v = vary, delay = 0, destination, onended } = params, p = takeParams(params), turn = name + JSON.stringify(p);
      const seed = p.seed ?? turns.get(turn) ?? 1, t = take(name, p, seed), rate = semi((Math.random() * 2 - 1) * v);
      start(t, { destination, vol: vol * playedAt(name) * Math.pow(10, ((Math.random() * 2 - 1) * v) / 20), rate, delay, onended });
      if (p.seed == null) { const next = (seed % variants) + 1; turns.set(turn, next); idle(() => take(name, p, next)); }
      return delay + t.hit / rate;
    },
    // Loops a sound with a dur until stopped. Returns the loop's seconds, or null when silent.
    loop(name, params = {}) {
      if (muted || !live()) return null;
      const { vol = 1, destination, ...p } = params, t = take(name, p, p.seed ?? 1, true);
      start(t, { destination, vol: vol * playedAt(name), loop: true });
      return t.buffer.duration;
    },
    // Keeps a take rendered elsewhere (renderTake(name, params) in a worker) for play(name, params), never let go
    keep(name, params, sound) {
      const p = takeParams(params), k = takeKey(name, p, p.seed ?? 1);
      if (!takes.has(k)) takes.set(k, { sound, hit: sound.hit, buffer: null, kept: true });
    },
    // Renders the first take of each [name, params, { loop }] in idle time and keeps it. Resolves once all are ready.
    prepare(list) {
      return Promise.all(list.map(([name, p = {}, { loop = false } = {}]) => idle(() => { take(name, p, p.seed ?? 1, loop).kept = true; })));
    },
    // Fades out over about `fade` s, then stops, every sound playing or scheduled into `destination` (every sound without one).
    stop(destination, fade = 0.1) {
      if (!ac) return; const t = ac.currentTime;
      for (const s of playing) if (!destination || s.destination === destination) { s.g.gain.setTargetAtTime(0, t, fade / 6); s.src.stop(t + fade); playing.delete(s); }
    },
    // Wires a button as the mute toggle: aria-pressed = sound on, text = on/off (text: false keeps your own content).
    // Set confirm to [name, params] for a custom sound, true for the default key clack, or false for no sound.
    bind(btn, { on = '🔊', off = '🔇', text = true, confirm = true } = {}) {
      const show = () => { btn.setAttribute('aria-pressed', String(!muted)); if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', 'Sound');
        btn.title = muted ? 'Sound is off' : 'Sound is on'; btn.dataset.muted = String(muted); if (text) btn.textContent = muted ? off : on; };
      btn.addEventListener('click', () => {
        api.toggle();
        if (!muted && confirm) {
          const confirmation = Array.isArray(confirm) ? confirm : ['clack', { vol: 0.5, hold: 0.06 }];
          api.play(...confirmation);
        }
      });
      api.onchange(show); show(); return btn;
    },
  };
  return api;
}

// A sound with a dur, rendered JOIN_S longer than it plays: the extra second crossfades into its start, so its end runs
// on into its beginning. A tail render() trimmed as silence counts as silence.
function joined(name, p, seed, sr) {
  const secs = p.dur ?? SOUNDS[name]?.p.dur;
  if (!(secs > JOIN_S)) throw new Error(`loop: "${name}" needs a dur over ${JOIN_S} s to loop`);
  const s = render(name, { ...p, dur: secs + JOIN_S, seed }, sr), n = Math.round(secs * sr), overlap = Math.round(JOIN_S * sr);
  const [L, R] = [s.L, s.R].map(channel => {
    const o = channel.slice(0, n);
    for (let i = 0; i < overlap; i++) { const x = (i / overlap) * (Math.PI / 2); o[i] = channel[i] * Math.sin(x) + (channel[n + i] ?? 0) * Math.cos(x); }
    return o;
  });
  return { L, R, hit: 0, sr };
}
