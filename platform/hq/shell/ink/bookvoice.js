// A voice note on a page: held still (a mouse's press, a double tap held: bookinput.js), the book listens where the
// press is, the words showing as they're heard beside a red pulse; let go, they land there as a box of words on the
// page (booktexts.js put), one step Undo takes back. Nothing heard, or the microphone blocked, says so and goes. The
// listening slip is the moment's only: nothing of it stays drawn.
//
// The recording is the intercom's (voice.js: pieces cut at the pauses, each transcribed as the board talks; the whole
// clip the fallback).
import { record } from '../voice.js';
import { transcribe, loadLanguage } from '../data.js';
import { sfx } from '../audio.js';

// a message (nothing heard, the microphone blocked) shows this long
const SAID_MS = 2200;

let lang = null;

// book: bookpages.js's; down: the press that held (its pointer ends it). Returns { cancel() }.
export function listen(book, down) {
  const at = book.at(down.clientX, down.clientY);
  if (!at) return null;
  const desk = book.desk.getBoundingClientRect(),
    right = book.at(desk.right - 16, down.clientY)?.x ?? at.x + 360;
  lang ??= loadLanguage(book.dev).then(
    l => l?.lang || 'en',
    () => 'en',
  );
  const v = { parts: [], pending: [], failed: false, done: false, el: slip(down) };
  sfx.micOn();
  lang.then(code => !v.done && recording(v, code));
  // let go: the words land
  const end = e => {
    if (e.pointerId !== down.pointerId) return;
    if (e.type !== 'pointerup') return cancel();
    v.stop();
    landed(book, v, at, right);
  };
  const key = e => e.key === 'Escape' && cancel();
  const cancel = () => {
    v.stop();
    v.rec?.cancel();
    v.el.remove();
  };
  v.stop = () => {
    if (v.done) return;
    v.done = true;
    cancelAnimationFrame(v.frame);
    removeEventListener('pointerup', end, true);
    removeEventListener('pointercancel', end, true);
    removeEventListener('keydown', key, true);
    sfx.micOff();
  };
  addEventListener('pointerup', end, true);
  addEventListener('pointercancel', end, true);
  addEventListener('keydown', key, true);
  return { cancel };
}

// The microphone on, in the board's language: each piece heard transcribed as it comes and shown in the slip
function recording(v, code) {
  v.code = code;
  v.rec = record({
    lang: code,
    onSegment: clip => {
      const i = v.parts.push('') - 1;
      v.pending.push(
        transcribe(clip, code).then(
          text => {
            v.parts[i] = text;
            shown(v);
          },
          () => (v.failed = true),
        ),
      );
    },
  });
  v.rec.ready.catch(err => {
    if (v.done) return;
    v.stop();
    say(v, err?.name === 'NotAllowedError' ? 'The microphone is blocked here' : 'The microphone didn’t start');
  });
  pulse(v);
}

// The words heard so far, joined
const words = v => v.parts.filter(Boolean).join(' ').trim();

// The recording stopped: the last piece transcribed (or the whole clip, where the pieces failed), and the words put on
// the page where the press was
async function landed(book, v, at, right) {
  if (!v.rec) return v.el.remove();
  v.el.dataset.state = 'writing';
  const clip = await v.rec.stop();
  await Promise.all(v.pending);
  if ((!words(v) || v.failed) && clip && v.code) {
    try {
      v.parts = [await transcribe(clip, v.code)];
    } catch {
      return say(v, 'The transcriber isn’t available right now');
    }
  }
  const text = words(v);
  if (!text) return say(v, 'No words came through');
  v.el.remove();
  book.tools?.put?.(at, text, right);
}

// ---- the listening slip, at the press

function slip(down) {
  const el = document.createElement('div');
  el.className = 'bk-voice';
  el.setAttribute('role', 'status');
  el.innerHTML = '<i class="bk-voice-dot" aria-hidden="true"></i><span>Listening…</span>';
  Object.assign(el.style, { left: `${down.clientX}px`, top: `${down.clientY}px` });
  (document.getElementById('book') ?? document.body).append(el);
  return el;
}
function shown(v) {
  const text = words(v);
  if (text) v.el.querySelector('span').textContent = text;
}
// The dot breathes with the voice's level
function pulse(v) {
  const dot = v.el.querySelector('.bk-voice-dot');
  const step = () => {
    if (v.done) return;
    dot.style.setProperty('--lvl', String(Math.min(1, v.rec?.level?.() ?? 0)));
    v.frame = requestAnimationFrame(step);
  };
  v.frame = requestAnimationFrame(step);
}
function say(v, message) {
  v.el.dataset.state = 'said';
  v.el.querySelector('span').textContent = message;
  setTimeout(() => v.el.remove(), SAID_MS);
}
