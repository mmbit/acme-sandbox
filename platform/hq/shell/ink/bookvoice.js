// A voice note: the mic on the tools' island, after Text. One tap, by a finger, the Pencil or the mouse, and the book listens at
// once, the words showing beside the mic as they're heard, by a red dot and bars moving with the voice; a second tap,
// and they land on the page as pasted words do (booktape.js, book.tape.words): a box of words under the line drawn last,
// where it's in sight, so the Pencil dictates right after scribbling; else a little above the middle of the paper
// shown; a sent page's on the notebook's current page. One step Undo takes back.
// Escape lets it go. Nothing heard, or the microphone blocked, says so and goes. The tap is what asks for the
// microphone, so nothing on the page ever has to be held: one tap and it's listening, no long press anywhere.
//
// The recording is dictate.js's (pieces cut at the pauses, each transcribed as the board talks; the whole clip
// the fallback), on a call the call's own microphone.
import { dictate } from '../dictate.js';
import { canRecord } from '../voice.js';
import { callMicrophone } from '../callmic.js';
import { loadLanguage } from '../data.js';
import { sfx } from '../audio.js';
import { button, lineIcon, setPressed } from './bookui.js';
import { scope, word } from './bookscope.js';
import { stylesheet } from '../../util.js';

// a message (nothing heard, the microphone blocked) shows this long
const SAID_MS = 2200;
const MIC = lineIcon(
  '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
);

let lang = null;

// book: bookpages.js's; after: the tools' button it goes after (Text's). Where nothing can record, no mic.
export function mountVoice(book, after) {
  if (!canRecord) return;
  stylesheet('shell/ink/bookvoice.css');
  const mic = button({ icon: MIC, label: word('voiceNote'), pressed: false });
  mic.classList.add('bk-mic');
  after.after(mic);
  let v = null;
  mic.addEventListener('click', () => {
    if (v && !v.done) return landed(book, v);
    v = listen(book, mic);
  });
}

// Listening from the tap, in the board's language
function listen(book, mic) {
  lang ??= scope
    ? Promise.resolve(document.documentElement.lang)
    : loadLanguage(book.dev).then(
        l => l?.lang || 'en',
        () => 'en',
      );
  const v = { done: false, mic, el: slip(mic), api: scope ? `${scope.api}/voice` : undefined };
  setPressed(mic, true);
  mic.setAttribute('aria-label', word('voiceNoteStop'));
  sfx.micOn();
  lang.then(code => !v.done && recording(v, code));
  const cancel = () => {
    v.stop();
    v.rec?.cancel();
    v.el.remove();
  };
  const key = e => e.key === 'Escape' && cancel();
  v.stop = () => {
    if (v.done) return;
    v.done = true;
    cancelAnimationFrame(v.frame);
    removeEventListener('keydown', key, true);
    setPressed(mic, false);
    mic.setAttribute('aria-label', word('voiceNote'));
    mic.style.removeProperty('--lvl');
    sfx.micOff();
  };
  addEventListener('keydown', key, true);
  return v;
}

// The microphone on (on a call, the call's, once it has started): each piece heard transcribed as it comes and shown in
// the slip
async function recording(v, code) {
  const call = await callMicrophone();
  if (v.done) return;
  v.rec = dictate({ lang: code, api: v.api, stream: call?.clone(), onWords: text => shown(v, text) });
  v.rec.ready.catch(err => {
    if (v.done) return;
    v.stop();
    say(v, word(err?.name === 'NotAllowedError' ? 'micBlocked' : 'micFailed'));
  });
  pulse(v);
}

// The second tap: the recording stopped, its words put on the page
async function landed(book, v) {
  v.stop();
  if (!v.rec) return v.el.remove();
  v.el.dataset.state = 'writing';
  let text;
  try {
    ({ text } = await v.rec.stop());
  } catch {
    return say(v, word('transcriberAway'));
  }
  if (!text) return say(v, word('noWordsHeard'));
  v.el.remove();
  book.tape.words(text);
}

// ---- the listening slip, beside the mic

function slip(mic) {
  const el = document.createElement('div'),
    r = mic.getBoundingClientRect();
  el.className = 'bk-voice';
  el.setAttribute('role', 'status');
  el.innerHTML =
    '<i class="bk-voice-dot" aria-hidden="true"></i><i class="bk-voice-wave" aria-hidden="true">' +
    '<b></b><b></b><b></b><b></b><b></b></i><span>Listening…</span>';
  Object.assign(el.style, { left: `${r.left}px`, top: `${r.top + r.height / 2}px` });
  (document.getElementById('book') ?? document.body).append(el);
  return el;
}
function shown(v, text) {
  if (text) v.el.querySelector('span').textContent = text;
}
// The dot, the bars and the mic's ring move with the voice's level
function pulse(v) {
  const step = () => {
    if (v.done) return;
    const lvl = String(Math.min(1, v.rec?.level?.() ?? 0));
    v.el.style.setProperty('--lvl', lvl);
    v.mic.style.setProperty('--lvl', lvl);
    v.frame = requestAnimationFrame(step);
  };
  v.frame = requestAnimationFrame(step);
}
function say(v, message) {
  v.el.dataset.state = 'said';
  v.el.querySelector('span').textContent = message;
  setTimeout(() => v.el.remove(), SAID_MS);
}
