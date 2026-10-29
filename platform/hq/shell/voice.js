// Voice for the intercom. While the board talks, the audio is cut at the pauses into short pieces (onSegment),
// each sent off at once, so the text fills in as they speak and only the last piece is left when they let go.
// The whole recording (MediaRecorder: opus on Firefox and Chrome, AAC on Safari) is kept as the fallback.
// Where the browser also has speech recognition and can share the microphone without a fight (desktop Chrome
// and Edge), the words appear live while the board talks; the transcript then replaces that preview.
import { levelMeter } from './audio.js';
import { gotStream } from '/__review/micallowed.js';

const ua = navigator.userAgent;
const mobile = /Android|iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const SR = !mobile && (window.SpeechRecognition || window.webkitSpeechRecognition);
const TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'];
export const MAX_SECONDS = 20 * 60; // the pieces are transcribed as the board talks, so length is no problem
// Recordings are transcribed on our own server (platform/stt, whisper.cpp) via POST /api/voice.
export const TRANSCRIBER = true;
export const canRecord = TRANSCRIBER && !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
// the browser's live preview, by the board's language
const LANGS = { en: 'en-US', nl: 'nl-NL', de: 'de-DE' };

// One recording. `ready` resolves once the microphone is live (after a permission prompt, the first time).
export function record({ lang = 'en', onPreview, onSegment } = {}) {
  const s = { chunks: [], t0: 0, done: false };
  const release = () => { s.cut?.close(); s.meter?.close(); s.stream?.getTracks().forEach(t => t.stop()); try { s.sr?.abort(); } catch { /* not started */ } };
  s.ready = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }).then(stream => {
    s.stream = stream; gotStream();
    if (s.done) { release(); throw new DOMException('Cancelled', 'AbortError'); }
    const type = TYPES.find(t => MediaRecorder.isTypeSupported?.(t));
    s.rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    s.rec.ondataavailable = e => { if (e.data.size) s.chunks.push(e.data); };
    s.rec.start(1000); s.t0 = performance.now();
    s.meter = levelMeter(stream);
    if (onSegment) s.cut = segmenter(stream, onSegment);
    if (SR && onPreview) preview(s, lang, onPreview);
  });
  s.seconds = () => s.t0 ? (performance.now() - s.t0) / 1000 : 0;
  // the meter: the real level where it can be read, a gentle breathing where it can't
  s.level = () => s.meter?.level() ?? 0.12 + 0.08 * Math.sin(performance.now() / 260) + (performance.now() - (s.heard || 0) < 500 ? 0.35 * Math.random() : 0);
  s.stop = () => new Promise(resolve => {
    s.done = true;
    if (!s.rec || s.rec.state === 'inactive') { release(); return resolve(null); }
    s.rec.onstop = () => resolve(new Blob(s.chunks, { type: s.rec.mimeType || 'audio/webm' }));
    s.cut?.flush(); s.rec.stop(); release();
  });
  s.cancel = () => { s.done = true; if (s.rec?.state === 'recording') { s.rec.onstop = null; s.rec.stop(); } release(); };
  return s;
}

function preview(s, lang, onPreview) {
  const r = s.sr = new SR();
  Object.assign(r, { lang: LANGS[lang] || 'en-US', continuous: true, interimResults: true });
  r.onresult = e => { s.heard = performance.now(); onPreview([...e.results].map(x => x[0].transcript.trim()).filter(Boolean).join(' ')); };
  r.onerror = r.onend = null; // only a preview: the recording carries on without it
  try { r.start(); } catch { s.sr = null; }
}

// Cuts the microphone's audio at pauses: a piece ends after SILENCE of quiet once it holds at least MIN of audio,
// or at MAX regardless. Quiet means close to the room's own noise floor (a fan or a hum raises it). Pieces with
// no speech in them are dropped (whisper invents words for silence). Each piece goes to onSegment as a 16 kHz
// mono WAV.
const MIN = 1.5, MAX = 12, SILENCE = 0.45, QUIET = 0.012, RATE = 16000;
function segmenter(stream, onSegment) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)(), src = ctx.createMediaStreamSource(stream);
  const tap = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain();
  mute.gain.value = 0; src.connect(tap).connect(mute).connect(ctx.destination); ctx.resume?.();
  let buf = [], length = 0, quiet = 0, speech = false, floor = 1;
  const flush = () => {
    if (speech && length / ctx.sampleRate > 0.4) onSegment(wav(buf, length, ctx.sampleRate));
    buf = []; length = 0; quiet = 0; speech = false;
  };
  tap.onaudioprocess = e => {
    const x = new Float32Array(e.inputBuffer.getChannelData(0)); let sum = 0;
    for (const v of x) sum += v * v;
    const level = Math.sqrt(sum / x.length); floor = Math.min(floor * 1.002, level);
    const loud = level > Math.max(QUIET, floor * 3), secs = (length += x.length, length / ctx.sampleRate);
    buf.push(x); speech ||= loud; quiet = loud ? 0 : quiet + x.length / ctx.sampleRate;
    if ((secs >= MIN && speech && quiet >= SILENCE) || secs >= MAX) flush();
  };
  return { flush, close: () => { tap.onaudioprocess = null; src.disconnect(); ctx.close?.(); } };
}
function wav(buf, length, rate) {
  const n = Math.floor(length * RATE / rate), out = new DataView(new ArrayBuffer(44 + n * 2)), all = new Float32Array(length);
  let o = 0; for (const b of buf) { all.set(b, o); o += b.length; }
  const str = (i, t) => [...t].forEach((c, k) => out.setUint8(i + k, c.charCodeAt(0)));
  str(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, all[Math.floor(i * rate / RATE)])); out.setInt16(44 + i * 2, v * 0x7fff, true); }
  return new Blob([out], { type: 'audio/wav' });
}
