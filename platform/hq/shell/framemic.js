// Review mode's microphone for the page in HQ's viewer. Its frame is never given the microphone (desk.js's iframe), and
// nothing the frame says is the board's word to record: the page's own code can send anything its post-it does. So a
// tap on the post-it's mic there (shared/review/dictation.js) only brings up HQ's own Talk key in the viewer's bar, in a
// slot kept for it so it never comes under a tap meant for something else (desk.js openViewer), and only a tap on that
// key, on HQ's page, records: the key turns red and moves with the voice while it listens, and the words go back to the
// page as they're heard (dictate.js). The key or the post-it's mic stops it; every stop is answered. The ask is the
// asking page's only: it comes with a line of its own (a MessagePort), every answer goes back on it, and nothing on it
// reaches a page the frame loads after (the frame's window stays the same through them).
// Another page's hello in the frame (as it starts, before its load event: helloFrom), or the frame's load (a page
// without review mode says none; its goodbye may never come: desk.js askReview), drops the ask, a recording and words
// still on their way included, and the page hears it was dropped (one that asked before its own load event asks
// again).
// A page that asks hears nothing back until the board taps the key, so it never learns whether HQ's microphone is
// allowed; a held pen there never listens (shared/review/pentouch.js).
import { dictate } from './dictate.js';

const LEVEL_MS = 100; // the key and the post-it's mic breathe with the voice at this pace
const ARM_MS = 500; // a tap this soon after the key shows was meant for what was under it, so it isn't taken
let on = null; // { doc, lang, key, shown, tell, rec, level }
let ending = null; // the session stopped and writing its words, till they're sent ({ gone } once dropped meanwhile)

// The page asks: HQ's key shows, and waits for the board's tap. doc: the asking page's own number (review.js), line:
// the port it came with, lang: the board's, key: the bar's Talk key
export function frameMic(doc, line, lang, key) {
  stopFrameMic();
  const tell = mic => line.postMessage({ mic });
  const v = (on = { doc, lang, key, shown: performance.now(), tell });
  line.onmessage = e => fromPage(v, e.data?.mic);
  paint(key, 'asked');
  key.onclick = e => e.isTrusted && tapped(v); // (a tap of HQ's window, never one a script made)
}
// A page's hello in the frame: another page than the one that asked is there now, whatever its load event
export function helloFrom(doc) {
  if ((on && on.doc !== doc) || (ending && ending.doc !== doc)) stopFrameMic();
}
// On its line, the page stops its recording ('stop': every stop is answered) or lets its ask go ('cancel')
function fromPage(v, mic) {
  if (mic === 'stop' && on === v && v.rec) return stop(v);
  if (mic === 'stop') v.tell({ done: null });
  if (on === v) stopFrameMic();
}
// The viewer closed, its frame loaded a page or another said hello, its page left, or the page let its ask go: the
// key goes, any recording unheard, and words still being written aren't sent
export function stopFrameMic() {
  if (ending) {
    ending.gone = true;
    ending.tell({ dropped: true });
    if (!on) paint(ending.key, null);
  }
  ending = null;
  if (!on) return;
  clearInterval(on.level);
  on.rec?.cancel();
  paint(on.key, null);
  on.tell({ dropped: true });
  on = null;
}

function tapped(v) {
  if (on !== v || performance.now() - v.shown < ARM_MS) return;
  if (v.rec) return stop(v, true);
  v.rec = dictate({ lang: v.lang, onWords: heard => on === v && v.tell({ heard }) });
  paint(v.key, 'live');
  v.tell({ live: true });
  v.rec.ready.then(
    () => {
      if (on !== v) return;
      v.level = setInterval(() => {
        const level = Math.min(1, v.rec.level());
        v.key.style.setProperty('--lvl', level.toFixed(2));
        v.tell({ level });
      }, LEVEL_MS);
    },
    err => {
      if (on !== v) return;
      v.tell({ failed: err?.name || 'Error' }); // (first: the page's drop that follows finds no recording to take it as)
      stopFrameMic();
    },
  );
}

// Stopped (by the key: the page hears it's stopping): the words, once the last piece is in, sent back
async function stop(v, byKey) {
  on = null;
  ending = v;
  clearInterval(v.level);
  if (byKey) v.tell({ stopping: true });
  paint(v.key, 'busy');
  let end;
  try {
    const { text, short } = await v.rec.stop();
    end = { done: text || null, why: short ? 'short' : null };
  } catch {
    end = { done: null, why: 'transcriber' };
  }
  if (v.gone) return;
  ending = null;
  if (!on) paint(v.key, null);
  v.tell(end);
}

// The key: hidden, asked (Talk), live (Stop, red) or busy (writing the words)
function paint(key, phase) {
  key.hidden = !phase;
  key.dataset.phase = phase ?? '';
  key.disabled = phase === 'busy';
  key.style.setProperty('--lvl', 0);
  key.querySelector('span').textContent = { live: 'Stop', busy: 'Writing…' }[phase] ?? 'Talk';
  key.setAttribute(
    'aria-label',
    { live: 'Listening: tap to stop', busy: 'Writing your words' }[phase] ?? 'Talk into the page’s note',
  );
}
