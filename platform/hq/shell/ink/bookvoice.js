// A voice note: the mic on the tools' island, after Text. Tapped (by a finger, the Pencil or the mouse) it lights and
// waits; a press then held on a spot of a page records there until it lifts. The words write themselves at that spot
// as they're said, a box of words like any typed one, an ink loader after them while more are coming (bookheard.js),
// and land there as the page's own words once the last are in, one step Undo takes back (booktape.js,
// book.tape.words at a point). The mic goes out the moment the press lifts. A double tap held on the page
// (bookinput.js) is the same note at its spot (heldAt). Tapped again, or another tool picked, before a press, the mic
// lets go; Escape lets a note go. The mic's tap is what asks for the microphone: it opens it then, ready for the
// press, so the first word isn't lost waiting for it; a hold alone never asks. Nothing heard, or the microphone
// blocked, says so in a toast. (README, A voice note at a spot)
//
// The words come over the live line as they're said (dictate.js dictateLive: phrase by phrase, a look at the one
// still being said every moment), the whole clip transcribed only where the line can't be had; a guest's book records
// in pieces cut at the pauses for its own transcriber (dictate). On a call, the call's own microphone.
import { dictate, dictateLive, audioContext } from '../dictate.js';
import { canRecord } from '../voice.js';
import { callMicrophone } from '../callmic.js';
import { gotStream, micAllowed, micBlocked } from '/__review/micallowed.js';
import { loadLanguage } from '../data.js';
import { sfx } from '../audio.js';
import { toast } from '../toast.js';
import { esc, stylesheet } from '../../util.js';
import { button, setPressed } from './bookui.js';
import { icon } from '../icons.js';
import { scope, word } from './bookscope.js';
import { followPress } from './bookpress.js';
import { heardAt } from './bookheard.js';
import { NOT_PAPER } from './bookinput.js';
import { shut } from './booksave.js';

let lang = null;

// book: bookpages.js's; after: the tools' button it goes after (Text's). Where nothing can record, no mic and no
// book.voice.
export function mountVoice(book, after) {
  if (!canRecord) return;
  stylesheet('shell/ink/bookvoice.css');
  const mic = button({ icon: icon('mic'), label: word('voiceNote'), pressed: false });
  mic.classList.add('bk-mic');
  after.after(mic);
  // armed: the mic waiting for a press (arm's); v: the note being recorded or written
  const s = { book, mic, armed: null, v: null };
  mic.addEventListener('click', () => (s.v && !s.v.done ? landed(s, s.v) : s.armed ? disarm(s) : arm(s)));
  // (another tool picked: the mic lets go)
  after.parentElement.addEventListener('click', e => {
    const picked = e.target.closest('.bk-btn');
    if (picked && picked !== mic) disarm(s);
  });
  book.voice = {
    // A double tap held at a point on a page (spot: { view, x, y }, book.at's), down its press: recorded as the mic's
    // press is, its words landing there. Before the microphone is allowed, a toast says to tap the mic once.
    heldAt(down, spot) {
      if (s.v && !s.v.done) return;
      if (!micAllowed()) return told(micBlocked() ? 'micBlocked' : 'micFirstTap');
      disarm(s);
      held(s, down, spot, {});
    },
  };
}

// ---- the mic waiting for a press

// The mic tapped: lit, its microphone and audio context opened in the tap (Safari runs a context only if it's made in
// one), and the next press on a page's paper taken for the note
function arm(s) {
  if (micBlocked()) return told('micBlocked');
  language(s.book);
  const a = (s.armed = { ctx: audioContext(), stream: null, dropped: false });
  a.ctx?.resume?.();
  // (once it's open; refused while the mic waits, it lets go and says so, refused once a note has the press, the
  // note's own recording says so)
  a.opened = opened().then(
    stream => {
      gotStream();
      if (a.dropped) stopped(stream);
      else a.stream = stream;
    },
    err => {
      if (s.armed !== a) return;
      disarm(s);
      told(err?.name === 'NotAllowedError' ? 'micBlocked' : 'micFailed');
    },
  );
  a.press = e => pressed(s, e);
  a.key = e => e.key === 'Escape' && disarm(s);
  // (at the window, before any tool or the page's pan hears it)
  addEventListener('pointerdown', a.press, true);
  addEventListener('keydown', a.key, true);
  setPressed(s.mic, true);
  s.book.desk.dataset.mic = '';
}
// The microphone: on a call, a copy of the call's (on an iPad a second microphone silences the first), else its own
async function opened() {
  const call = await callMicrophone();
  return call
    ? call.clone()
    : navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
}
// The mic let go without a note: what it opened closed
function disarm(s) {
  const a = s.armed;
  if (!a) return;
  s.armed = null;
  a.dropped = true;
  removeEventListener('pointerdown', a.press, true);
  removeEventListener('keydown', a.key, true);
  if (a.stream) stopped(a.stream);
  a.ctx?.close?.();
  delete s.book.desk.dataset.mic;
  if (!s.v || s.v.done) setPressed(s.mic, false);
}
const stopped = stream => stream.getTracks().forEach(t => t.stop());

// A press while the mic waits: on a page's open paper, it's the note's, recorded at its spot until it lifts
function pressed(s, e) {
  const { book } = s;
  if (!e.isPrimary || !book.desk.contains(e.target) || e.target.closest(NOT_PAPER)) return;
  const at = book.at(e.clientX, e.clientY);
  if (!at?.view.page.ink || shut(at.view.page)) return;
  e.stopPropagation();
  e.preventDefault();
  const a = s.armed;
  // (what the mic opened is the note's now)
  s.armed = null;
  removeEventListener('pointerdown', a.press, true);
  removeEventListener('keydown', a.key, true);
  delete book.desk.dataset.mic;
  held(s, e, { view: at.view, x: at.x, y: at.y }, a);
}

// ---- the note

// Recorded from the press down, at spot, till it lifts (or the browser lets it go): then its words land. a: what the
// mic opened for it, if it was tapped first.
function held(s, down, spot, a) {
  const v = (s.v = listen(s, spot, a));
  followPress(down, { up: () => v.done || landed(s, v) });
}

// Listening at once, in the board's language, the words showing at the spot
function listen(s, spot, a) {
  const { book, mic } = s;
  const v = { done: false, spot, mic, box: heardAt(spot, book.tools.color()) };
  setPressed(mic, true);
  mic.dataset.listening = '';
  sfx.micOn();
  recording(s, v, a);
  const key = e => e.key === 'Escape' && v.cancel();
  v.stop = () => {
    if (v.done) return;
    v.done = true;
    cancelAnimationFrame(v.frame);
    removeEventListener('keydown', key, true);
    setPressed(mic, false);
    delete mic.dataset.listening;
    mic.style.removeProperty('--lvl');
    v.box.held();
    sfx.micOff();
  };
  v.cancel = () => {
    v.stop();
    v.rec?.cancel();
    v.box.gone();
  };
  addEventListener('keydown', key, true);
  return v;
}

// The microphone on: the words heard so far shown as they come. a: what the mic opened, if it was tapped first (else
// a copy of the call's microphone, or the recording's own).
async function recording(s, v, a) {
  const code = await language(s.book);
  await a.opened;
  const mine = a.stream ?? (await callMicrophone())?.clone();
  if (v.done) {
    if (mine) stopped(mine);
    return a.ctx?.close?.();
  }
  const onWords = text => v.box.heard(text);
  if (scope) a.ctx?.close?.(); // (a guest's pieces need no context of the tap's)
  v.rec = scope
    ? dictate({ lang: code, api: `${scope.api}/voice`, stream: mine, onWords })
    : dictateLive({ lang: code, stream: mine, ctx: a.ctx, onWords, over: () => landed(s, v) });
  v.rec.ready.catch(err => {
    if (v.done) return;
    v.cancel();
    told(err?.name === 'NotAllowedError' ? 'micBlocked' : 'micFailed');
  });
  pulse(v);
}

// The press lifted (or the mic tapped, or the line's five minutes up): the mic out at once, the last words waited for
// with the loader, then landed at the spot as the page's own
async function landed(s, v) {
  if (v.landing) return;
  v.landing = true;
  v.stop();
  if (!v.rec) return v.box.gone();
  let text;
  try {
    ({ text } = await v.rec.stop());
  } catch {
    v.box.gone();
    return told('transcriberAway');
  }
  if (!text) {
    v.box.gone();
    return told('noWordsHeard');
  }
  v.box.heard(text);
  await s.book.tape.words(text, v.spot);
  v.box.gone();
}

// The board's language, read once
function language(book) {
  return (lang ??= scope
    ? Promise.resolve(document.documentElement.lang)
    : loadLanguage(book.dev).then(
        l => l?.lang || 'en',
        () => 'en',
      ));
}
// The mic's ring and the loader's dots move with the voice's level
function pulse(v) {
  const step = () => {
    if (v.done) return;
    const lvl = String(Math.min(1, v.rec?.level?.() ?? 0));
    v.box.level(lvl);
    v.mic.style.setProperty('--lvl', lvl);
    v.frame = requestAnimationFrame(step);
  };
  v.frame = requestAnimationFrame(step);
}
const told = key => toast(esc(word(key)));
