// Every sound is synthesised with WebAudio. Silent until the first tap. Each look brings its own pack
// (renderers/<name>/sounds.js, see wear()); what it lacks, the platform's sound kit clicks.
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
export function sample({ L, R, sr }, { vol = 1, at = 0, bus = packBus } = {}) {
  if (!context) return;
  const b = context.createBuffer(2, L.length, sr), s = context.createBufferSource(), g = context.createGain();
  b.copyToChannel(L, 0); b.copyToChannel(R, 1);
  s.buffer = b; g.gain.value = vol;
  s.connect(g).connect(bus); s.start(context.currentTime + at);
}

// ---- packs
// The look's pack (renderers/<name>/sounds.js): { sfx: its sounds by name, score: its music (see schedule()) }. A sound
// it lacks is the platform's own: a switch's click from the sound kit.
let pack = {};
const click = () => foley('switch', { size: 0.9 }, { vol: 0.8 });
export const sfx = new Proxy({}, { get: (_, name) => (...a) => (pack.sfx?.[name] ?? click)(...a) });
// A sound by its name, as the scenes (shell.sound.play) and a kit's moments call it.
export const play = (name, ...a) => sfx[name](...a);
// A sound of the platform's sound kit (/foley.js), rendered once per take (four takes each, picked at random, so repeats
// don't grate), once the kit has loaded.
const kit = import('../foley.js'),
  takes = new Map();
export function foley(name, params = {}, { vol = 1, at = 0 } = {}) {
  const bus = packBus; // (the bus it was asked on: cue's, or the look's then)
  kit.then(k => {
    const look = `${name}${JSON.stringify(params)}#${1 + Math.floor(Math.random() * 4)}`;
    if (!takes.has(look)) takes.set(look, k.render(name, { ...params, seed: Number(look.at(-1)) }));
    sample(takes.get(look), { vol: vol * 0.5, at, bus });
  });
}
// A call's own controls are heard over the hush the call puts on HQ (the minimised call's bubble), never louder than
// HQ's own sounds.
let cueBus = null;
export function cue(name, ...a) {
  if (!context || !prefs.sound) return;
  if (!cueBus) { cueBus = context.createGain(); cueBus.gain.value = sfxBus.gain.value; cueBus.connect(context.destination); }
  const look = packBus;
  packBus = cueBus;
  try { play(name, ...a); } finally { packBus = look; }
}
// The stage puts on a look's pack as its scene goes on. The sounds play through a bus of the pack's own, which a swap
// fades and drops, so the last look's (its van's whirr) never ring on under the new one's.
export function wear(next) {
  pack = next; step = 0;
  if (!context) return;
  nextT = context.currentTime + 0.1; // (the new look's music starts from its top, now)
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
// The look's music: score.step s a step (or a function of the mood's rain), score.play(step, at s from now, the mood)
function schedule() {
  const score = pack.score;
  if (!score) return;
  const stepS = typeof score.step === 'function' ? score.step({ rain: rainLevel }) : score.step;
  for (; nextT < context.currentTime + 0.25; nextT += stepS, step++)
    score.play(step, nextT - context.currentTime, { bus: musicBus, rain: rainLevel, snow: snowLevel, holidays });
}
