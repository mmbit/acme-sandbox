// Every sound is synthesised with WebAudio. Silent until the first tap. The brownstone's chiptune is the default pack; a
// look may bring its own (renderers/<name>/sounds.js, see wear()).
import { store } from '../util.js';

let context = null, master, sfxBus, packBus, musicBus, musicFilter, noiseBuf, unlockedAt = 0, rainGain = null, rainFilter;
export const prefs = { sound: store.get('sound', true), music: store.get('music', false) };

// iOS only lets audio start inside a user gesture, and resume there after the app was in the background (the
// context is then 'interrupted'). So every tap tries.
export function unlock() {
  if (context) { if (context.state !== 'running' && context.state !== 'closed') context.resume().catch(() => {}); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  context = new AC(); unlockedAt = performance.now();
  master = context.createGain(); master.gain.value = prefs.sound && !hushed ? 1 : 0; master.connect(context.destination);
  sfxBus = context.createGain(); sfxBus.gain.value = 0.5; sfxBus.connect(master);
  packBus = context.createGain(); packBus.connect(sfxBus);
  musicFilter = context.createBiquadFilter(); musicFilter.type = 'lowpass'; musicFilter.frequency.value = 3200; musicFilter.connect(master);
  musicBus = freshMusicBus();
  noiseBuf = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // rain as heard through a window: a soft, muffled bed (low-passed noise) whose level follows the weather,
  // and gentle drops tapping the glass (see drops())
  const src = context.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
  rainFilter = context.createBiquadFilter(); rainFilter.type = 'lowpass'; rainFilter.frequency.value = 900; rainFilter.Q.value = 0.3;
  rainGain = context.createGain(); rainGain.gain.value = 0;
  src.connect(rainFilter).connect(rainGain).connect(master); src.start();
  drops();
  if (prefs.music) startMusic();
}
export const ready = () => !!context && prefs.sound;
// In the background the context sleeps. It wakes on return where that's allowed, else on the next tap (iOS).
addEventListener('visibilitychange', () => { if (!context) return; if (document.hidden) context.suspend().catch(() => {}); else context.resume().catch(() => {}); });
for (const ev of ['touchend', 'click']) addEventListener(ev, () => unlock(), { capture: true, passive: true });
export const justUnlocked = () => performance.now() - unlockedAt < 400;

export function setSound(on) { prefs.sound = on; store.set('sound', on); level(); }
// hush: HQ goes quiet while something else is playing over it (a product preview, a call with the CEO)
let hushed = false;
// HQ goes quiet while anything else is heard: a demo, a call, a clip or sound playing in HQ. Each says why, and
// HQ's sound comes back when the last of them is done.
const hushers = new Set();
export function hush(on, why = 'demo') { on ? hushers.add(why) : hushers.delete(why); hushed = hushers.size > 0; level(); }
const playing = new Set();
for (const ev of ['play', 'pause', 'ended', 'emptied']) document.addEventListener(ev, e => {
  if (!(e.target instanceof HTMLMediaElement)) return;
  e.type === 'play' ? playing.add(e.target) : playing.delete(e.target);
  for (const m of playing) if (!m.isConnected || m.paused) playing.delete(m);
  hush(playing.size > 0, 'media');
}, true);
function level() { if (master) master.gain.setTargetAtTime(prefs.sound && !hushed ? 1 : 0, context.currentTime, 0.05); }
export function setMusic(on) { prefs.music = on; store.set('music', on); on ? startMusic() : stopMusic(); }
let lastWeather = -1, rainLevel = 0, snowLevel = 0;
// A drop on the glass: a tiny click of filtered noise (no pitch, so it taps rather than chirps), placed somewhere
// left or right. Now and then a fuller, duller tap. They come in loose clusters, more the harder it rains.
function drops() {
  const wait = rainLevel > 0.05 ? (60 + Math.random() * 380) / (0.4 + rainLevel) : 800;
  setTimeout(drops, wait);
  if (!context || context.state !== 'running' || rainLevel < 0.05 || Math.random() > rainLevel) return;
  const t = context.currentTime, big = Math.random() < 0.15, dur = big ? 0.07 : 0.022 + Math.random() * 0.016;
  const src = context.createBufferSource(), bp = context.createBiquadFilter(), g = context.createGain(), pan = context.createStereoPanner ? context.createStereoPanner() : null;
  src.buffer = noiseBuf; bp.type = 'bandpass'; bp.frequency.value = big ? 260 + Math.random() * 240 : 900 + Math.random() * 1300; bp.Q.value = big ? 1.4 : 1.1;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime((big ? 0.09 : 0.06) * (0.4 + Math.random() * 0.6), t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;
  src.connect(bp).connect(g); (pan ? g.connect(pan) : g).connect(master);
  src.start(t, Math.random() * 1.5, dur + 0.02);
}

export function setWeather(rain, dark, snow = 0) {
  if (!context) return;
  snowLevel = snow;
  const k = Math.round(rain * 20) / 20 + Math.round(dark * 10) / 100;
  if (k === lastWeather) return; lastWeather = k;
  rainGain.gain.setTargetAtTime(rain * 0.03, context.currentTime, 1.5); rainLevel = rain;
  musicFilter.frequency.setTargetAtTime(3200 - dark * 2200 - rain * 600, context.currentTime, 1);
}
// on: the holidays running now, a Set of 'halloween', 'sinterklaas', 'pakjesavond', 'christmas' and 'newYear'
let holidays = new Set();
export function setHolidays(on) { holidays = on; }

// ---- the engine: what every pack plays its sounds with
// A note: an oscillator at f Hz, gliding to f × slide, rising in attack s and dying away by dur s; cut: a low-pass on it
// (softens a square or a saw); pan: where it sits, -1 (left) to 1 (right)
export function tone(f, dur, { type = 'square', vol = 0.12, at = 0, slide = 0, attack = 0.008, cut = 0, pan = 0, bus = packBus } = {}) {
  if (!context) return;
  const t = context.currentTime + at, o = context.createOscillator(), g = context.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(f * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(cut ? lowpass(cut, panned(pan, bus)) : panned(pan, bus)); o.start(t); o.stop(t + dur + 0.05);
}
const lowpass = (freq, bus) => { const f = context.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq; f.connect(bus); return f; };
const panned = (pan, bus) => { if (!pan || !context.createStereoPanner) return bus; const p = context.createStereoPanner(); p.pan.value = pan; p.connect(bus); return p; };
// A burst of filtered noise; sweep: its filter glides to freq × sweep (a whoosh, a rustle), q: how narrow, attack: a
// fade in (else it starts at full)
export function noise(dur, { vol = 0.1, at = 0, freq = 4000, bus = packBus, type = 'bandpass', sweep = 0, q = 0, attack = 0 } = {}) {
  if (!context) return;
  const t = context.currentTime + at, s = context.createBufferSource(), f = context.createBiquadFilter(), g = context.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
  if (dur > 0.5) s.loop = true; // (from a random point in its first 1.5 s, the 2 s of noise would run out)
  if (sweep) { f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur); }
  if (q) f.Q.value = q;
  if (attack) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); } else g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(bus); s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.02);
}
// A struck or plucked note (a mallet, a tine, a glass): sine partials [ratio, level], the higher ones dying sooner
export const strike = (f, dur, partials, { vol = 0.1, ...o } = {}) =>
  partials.forEach(([r, v]) => tone(f * r, dur / Math.sqrt(r), { type: 'sine', attack: 0.004, ...o, vol: vol * v }));
export const note = midi => 440 * 2 ** ((midi - 69) / 12); // a MIDI note's frequency
// A rendered sound (stereo channels L and R at rate sr, as the platform's sound kit renders them: /foley.js) through
// the look's own sounds, so mute and a swap reach it as they reach the rest
export function sample({ L, R, sr }, { vol = 1, at = 0 } = {}) {
  if (!context) return;
  const b = context.createBuffer(2, L.length, sr), s = context.createBufferSource(), g = context.createGain();
  b.copyToChannel(L, 0); b.copyToChannel(R, 1);
  s.buffer = b; g.gain.value = vol;
  s.connect(g).connect(packBus); s.start(context.currentTime + at);
}

// ---- the chiptune pack (the brownstone's, and every look's fallback)
function whirr(up) {
  if (!context) return;
  const t = context.currentTime, d = 2.4, o = context.createOscillator(), f = context.createBiquadFilter(), g = context.createGain();
  o.type = 'triangle'; o.frequency.setValueAtTime(up ? 70 : 140, t); o.frequency.exponentialRampToValueAtTime(up ? 150 : 60, t + d);
  f.type = 'lowpass'; f.frequency.value = 500;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.035, t + d * 0.4); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(f).connect(g).connect(packBus); o.start(t); o.stop(t + d + 0.05);
}

const CHIPTUNE = {
  blip: () => tone(note(84), 0.06, { vol: 0.08 }),
  open: () => { tone(note(76), 0.07, { vol: 0.09 }); tone(note(83), 0.1, { vol: 0.09, at: 0.06 }); },
  close: () => { tone(note(79), 0.07, { vol: 0.07 }); tone(note(72), 0.1, { vol: 0.07, at: 0.06 }); },
  tick: () => noise(0.02, { vol: 0.05, freq: 3000 + Math.random() * 3000 }),
  pop: () => tone(note(72), 0.08, { type: 'triangle', vol: 0.12, slide: 2 }),
  whoosh: () => { noise(0.35, { vol: 0.08, freq: 1200 }); tone(note(67), 0.3, { type: 'sine', vol: 0.05, slide: 1.8 }); },
  jingle: () => [72, 76, 79, 84, 88].forEach((n, i) => { tone(note(n), 0.18, { at: i * 0.09, vol: 0.1 }); tone(note(n + 12), 0.1, { type: 'triangle', at: i * 0.09 + 0.04, vol: 0.05 }); }),
  ding: (v = 1) => { tone(note(93), 0.9, { type: 'sine', vol: 0.18 * v }); tone(note(105), 0.5, { type: 'sine', vol: 0.05 * v }); },
  meow: () => { tone(note(79), 0.35, { type: 'sawtooth', vol: 0.05, slide: 1.35 }); tone(note(83), 0.25, { type: 'triangle', vol: 0.08, at: 0.2, slide: 0.7 }); },
  fanfare: () => [60, 64, 67, 72, 67, 72, 76, 79].forEach((n, i) => tone(note(n + 12), 0.16, { at: i * 0.11, vol: 0.1, type: i % 2 ? 'square' : 'triangle' })),
  // a firework far over the skyline: a muffled thump, then a soft crackle
  boom: () => { tone(note(40), 0.5, { type: 'sine', vol: 0.025, slide: 0.6 }); noise(0.5, { vol: 0.02, freq: 400, type: 'lowpass' }); for (let i = 0; i < 18; i++) noise(0.02, { vol: 0.006 + Math.random() * 0.014, at: 0.25 + Math.random() ** 1.5 * 1.1, freq: 1500 + Math.random() * 3500 }); },
  rewind: () => tone(note(60), 0.6, { vol: 0.06, slide: 4 }),
  thump: n => { tone(note(40 + n * 3), 0.18, { type: 'triangle', vol: 0.28, slide: 0.5 }); noise(0.08, { vol: 0.06, freq: 300, type: 'lowpass' }); },
  // the delivery van: a soft electric whirr that winds down as it pulls in, and up as it leaves
  whirr: (up = false) => whirr(up),
  honk: () => { tone(note(62), 0.28, { type: 'sawtooth', vol: 0.06 }); tone(note(66), 0.28, { type: 'sawtooth', vol: 0.05 }); tone(note(62), 0.2, { type: 'sawtooth', vol: 0.06, at: 0.34 }); },
  // two quick squeaks and a longer one falling away, softened so they chirp rather than buzz
  squawk: () => [[86, 0, 1.3], [88, 0.11, 1.3], [91, 0.22, 0.7]].forEach(([n, at, slide], i) => tone(note(n), i < 2 ? 0.09 : 0.24, { vol: 0.05, cut: 2600, at, slide })),
  quack: () => { tone(note(58), 0.14, { type: 'sawtooth', vol: 0.07, slide: 0.8 }); tone(note(57), 0.16, { type: 'sawtooth', vol: 0.06, at: 0.18, slide: 0.75 }); },
  blub: () => [0, 0.09, 0.2, 0.28].forEach((at, i) => tone(note(60 + i * 5), 0.09, { type: 'sine', vol: 0.12, at, slide: 2.2 })),
  chirp: () => { const b = 94 + Math.random() * 6; [0, 0.12, 0.2].forEach((at, i) => tone(note(b + (i % 2) * 3), 0.07, { type: 'sine', vol: 0.025, at, slide: 1.25 })); },
  flap: () => noise(0.25, { vol: 0.05, freq: 900 }),
  ring: () => [0, 0.18, 0.5, 0.68].forEach(at => { tone(note(88), 0.12, { type: 'square', vol: 0.05, at }); tone(note(91), 0.12, { type: 'square', vol: 0.04, at: at + 0.06 }); }),
  twinkle: () => [96, 100, 103, 108].forEach((n, i) => tone(note(n), 0.25, { type: 'sine', vol: 0.06, at: i * 0.07 })),
  // the intercom's mic: a soft radio key-up, and a squelch when it lets go
  micOn: () => { noise(0.05, { vol: 0.035, freq: 2400 }); tone(note(79), 0.07, { type: 'sine', vol: 0.07, at: 0.02 }); tone(note(86), 0.1, { type: 'sine', vol: 0.07, at: 0.08 }); },
  micOff: () => { tone(note(86), 0.07, { type: 'sine', vol: 0.06 }); tone(note(79), 0.12, { type: 'sine', vol: 0.06, at: 0.06 }); noise(0.16, { vol: 0.025, freq: 1500, at: 0.1 }); },
  // a switch in Settings flicked: a tiny click, then two notes stepping up for on, down for off
  toggle: (on = true) => { noise(0.015, { vol: 0.04, freq: 4000 }); tone(note(on ? 79 : 84), 0.05, { vol: 0.07, at: 0.01 }); tone(note(on ? 86 : 77), 0.07, { vol: 0.07, at: 0.05 }); },
  // a big key swiped on to the next, and turned over
  swipe: () => noise(0.12, { vol: 0.05, freq: 2200 }),
  flip: () => { noise(0.06, { vol: 0.05, freq: 1600 }); tone(note(76), 0.06, { vol: 0.06, at: 0.05 }); },
  // a key dropping onto a table (v: how hard, p: semitones up), a key pressed, and one settling.
  clack: (v = 1, p = 0) => { noise(0.03, { vol: 0.06 * v, freq: 1400 + p * 60 }); tone(note(60 + p), 0.05, { type: 'triangle', vol: 0.1 * v, slide: 0.7 }); },
  press: () => { noise(0.02, { vol: 0.05, freq: 2400 }); tone(note(67), 0.04, { type: 'triangle', vol: 0.08 }); },
  land: () => tone(note(79), 0.05, { type: 'triangle', vol: 0.06 }),
  // a cocktail shaken for dur s from at: ice rattling in a tin, seven strokes a second, each a tumble of small clicks
  // and a soft knock at its end
  shake: (at = 0, dur = 1.1) => {
    for (let s = 0; s < dur - 0.05; s += 1 / 7) {
      noise(0.03, { vol: 0.05, freq: 900, q: 1.2, at: at + s });
      for (let i = 0; i < 4; i++) noise(0.012 + Math.random() * 0.01, { vol: 0.025 + Math.random() * 0.03, freq: 2800 + Math.random() * 2600, q: 3, at: at + s + 0.01 + Math.random() * 0.05 });
    }
  },
  // then served: a pour for pour s, the glass slid along the wood for slide s, and a glassy tink where it stops
  serve: (at = 0, pour = 0.35, slide = 0.55) => {
    noise(pour, { vol: 0.02, freq: 1700, q: 2.5, sweep: 1.35, attack: 0.04, at });
    [0.06, 0.17, 0.26].forEach((b, i) => tone(note(86 + i * 2), 0.05, { type: 'sine', vol: 0.02, slide: 1.5, at: at + b }));
    noise(slide, { vol: 0.04, freq: 1300, q: 0.9, sweep: 0.7, attack: 0.06, at: at + pour });
    strike(note(96), 0.6, [[1, 1], [2.32, 0.4]], { vol: 0.045, at: at + pour + slide });
    tone(note(108), 0.2, { type: 'sine', vol: 0.02, at: at + pour + slide + 0.1 });
  },
};

// ---- packs
// The look's pack: { sfx: its sounds by name, music: its band (see voice()), or score: music of its own (see schedule()) };
// what it lacks, the chiptune plays.
let pack = {};
export const sfx = Object.fromEntries(Object.keys(CHIPTUNE).map(name => [name, (...a) => (pack.sfx?.[name] ?? CHIPTUNE[name])(...a)]));
// The stage puts on a look's pack as its scene goes on. The sounds play through a bus of the pack's own, which a swap
// fades and drops, so the last look's (its van's whirr) never ring on under the new one's.
export function wear(next) {
  pack = next; step = 0; // (the new look's music starts from its top)
  if (!context) return;
  musicBus = freshMusicBus(musicBus);
  const old = packBus;
  packBus = context.createGain(); packBus.connect(sfxBus);
  old.gain.setTargetAtTime(0, context.currentTime, 0.02);
  setTimeout(() => old.disconnect(), 200);
}

// How loud the microphone is (0..1) for the intercom's meter, or null when that can't be read: the context is
// asleep, or the browser won't mix a stream at another sample rate (Firefox, on some laptops).
export function levelMeter(stream) {
  unlock();
  if (!context) return null;
  try {
    const src = context.createMediaStreamSource(stream), an = context.createAnalyser(), buf = new Float32Array(512);
    an.fftSize = 512; src.connect(an); // not connected onwards: the board doesn't hear themselves
    return {
      level() { if (context.state !== 'running') return null; an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.min(1, Math.sqrt(s / buf.length) * 6); },
      close() { src.disconnect(); },
    };
  } catch { return null; }
}

// ---- chiptune: an I-vi-IV-V loop, a B section (IV-V-iii-vi) and an arpeggio bridge ----
const CHORDS = [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]];
const CHORDS_B = [[53, 57, 60], [55, 59, 62], [52, 55, 59], [57, 60, 64]];
const MELODY = [0, -1, 2, 1, -1, 0, 2, -1, 1, 2, -1, 0, 1, -1, 3, -1];
const MELODY_B = [2, -1, 1, 0, 2, -1, 3, -1, 1, 0, -1, 2, 0, -1, -1, -1];
let timer = null, step = 0, nextT = 0;
function startMusic() {
  if (!context || timer) return;
  nextT = context.currentTime + 0.1; step = 0;
  timer = setInterval(schedule, 60);
}
function stopMusic() { clearInterval(timer); timer = null; if (context) musicBus = freshMusicBus(musicBus); }
// The music's own bus. A swap or the music button lets the old one fade and go, so a score's long notes don't ring on
// under the next look's music, or after the music is off.
function freshMusicBus(old) {
  const bus = context.createGain(); bus.gain.value = 0.16; bus.connect(musicFilter);
  if (old) { old.gain.setTargetAtTime(0, context.currentTime, 0.3); setTimeout(() => old.disconnect(), 2500); }
  return bus;
}
function schedule() {
  // a look with a score of its own plays that: score.step s a step, score.play(step, at s from now, the mood)
  const score = pack.score;
  if (score) {
    for (; nextT < context.currentTime + 0.25; nextT += score.step, step++) score.play(step, nextT - context.currentTime, { bus: musicBus, rain: rainLevel, snow: snowLevel, holidays });
    return;
  }
  // eighth notes at 92 bpm, a little slower and softer in the rain, with a faint twinkle on top when it snows
  const spb = 60 / (92 - 6 * rainLevel) / 2, hush = 1 - 0.6 * rainLevel, december = holidays.has('sinterklaas') || holidays.has('christmas');
  while (nextT < context.currentTime + 0.25) {
    const section = (step >> 6) % 3, B = section === 2, bar = (step >> 3) % 4, ch = (B ? CHORDS_B : CHORDS)[bar], at = nextT - context.currentTime, s = step % 8;
    if (holidays.has('halloween')) hauntedBass(step, s, ch[0], at, spb);
    else if (s % 4 === 0) tone(note(ch[0] - 24), spb * 3.5, voice('bass', { type: 'triangle', vol: 0.5, at }));
    tone(note(ch[(B ? s : s % 3) % 3] + 12 + (B && s > 3 ? 12 : 0)), spb * 0.6, voice('arp', { vol: 0.12, at }));
    const mel = B ? MELODY_B : MELODY, m = mel[(step + bar * 3) % 16];
    if (m >= 0 && (section === 1 || B)) tone(note(ch[m % 3] + 24 + (m === 3 ? 12 : 0)), spb * 1.4, voice('lead', { type: 'triangle', vol: 0.35, at }));
    if (s % 2 === 1) noise(0.03, voice('hat', { vol: 0.12 * hush, at, freq: 8000 }));
    if (s === 4 && section > 0) noise(0.09, voice('snare', { vol: 0.1 * hush, at, freq: 1800 }));
    if (snowLevel > 0.3 && s === 6 && bar % 2 === 0) tone(note(ch[(step >> 3) % 3] + 36), spb * 2, { type: 'sine', vol: 0.06 * snowLevel, at, bus: musicBus });
    if (december && (s % 2 === 0 || s % 4 === 3)) sleighBells(s, ch[s % 3] + 36, at, spb, hush);
    nextT += spb; step++;
  }
}
// A part of the band (bass, arp, lead, hat, snare) as the look's pack plays it: its settings over the chiptune's, its
// gain on the level
const voice = (part, o) => ({ ...o, ...pack.music?.[part], vol: o.vol * (pack.music?.[part]?.gain ?? 1), bus: musicBus });
// Halloween's bass walks the root and a minor third, both sagging a little flat, then glides from a tritone into
// the next bar's root
function hauntedBass(step, s, root, at, spb) {
  if (s % 2 || s > 4) return;
  const next = step + 8 - s, nextRoot = ((next >> 6) % 3 === 2 ? CHORDS_B : CHORDS)[(next >> 3) % 4][0];
  const from = note(root - 24 + [0, 3, 6][s / 2]), slide = s === 4 ? note(nextRoot - 24) / from : 0.985;
  tone(from, spb * (s === 4 ? 3.9 : 1.9), voice('bass', { type: 'triangle', vol: 0.4, at, slide }));
}
// December's sleigh bells: a shake of three tiny jingles on each beat, and a softer, swung one at the end of each half bar
function sleighBells(s, ringNote, at, spb, hush) {
  const beat = s % 2 === 0, t = at + (beat ? 0 : spb / 3), vol = (beat ? 0.08 : 0.045) * hush;
  [0, 0.011, 0.026].forEach((d, i) => noise(0.06 - i * 0.015, { vol, at: t + d, freq: 4500, bus: musicBus }));
  if (beat) tone(note(ringNote), 0.15, { type: 'sine', vol: vol * 0.35, at: t, bus: musicBus });
}
