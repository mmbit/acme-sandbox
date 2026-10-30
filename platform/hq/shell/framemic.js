// Review mode's microphone for the page in HQ's viewer. Its frame is never given the microphone (desk.js's iframe), and
// nothing the frame says is the board's word to record: the page's own code can send anything its post-it does. So
// while a post-it there is open, the page offers its mic's place (shared/review/hqmic.js) and HQ lays its own mic key
// right over it, looking the same, and only a tap on that key, on HQ's page, records: at once, one tap, the words going
// back to the page as they're said, over the live line (dictate.js dictateLive). The key turns red and breathes with the
// voice while it listens, and a tap again stops it, as the page's stop does; every stop is answered, and the key is
// ready for another go. The Pencil's tap on it is a finger's (data-no-ink), so the board dictates straight after
// scribbling (the board, call 170). The offer is the offering page's only: it comes with a line of its own (a
// MessagePort), every answer goes back on it, and nothing on it reaches a page the frame loads after (the frame's
// window stays the same through them).
// Another page's hello in the frame (as it starts, before its load event: helloFrom), or the frame's load (a page
// without review mode says none; its goodbye may never come: desk.js askReview), drops the offer, a recording and words
// still on their way included, and the page hears it was dropped (one that offered before its own load event offers
// again). The page picks where the key goes, so a tap in its first half second there (or since it last moved) isn't
// taken: it was meant for what was under it.
// A page that offers hears nothing back until the board taps the key, so it never learns whether HQ's microphone is
// allowed; a held pen there never listens (shared/review/pentouch.js).
import { dictateLive } from './dictate.js';

const LEVEL_MS = 100; // the key and the post-it's mic breathe with the voice at this pace
const ARM_MS = 500; // a tap this soon after the key shows or moves was meant for what was under it, so it isn't taken
const MOVED_PX = 8; // (moved this far: armed again)
// (review mode's own mic, base.js MIC, so the key looks as the post-it's does)
const MIC =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
// the open offer: { doc, lang, frame, key, at, armed, tell, follow, rec, level, writing, gone }
let on = null;

// A post-it open in the frame: HQ's key over its mic, waiting for the board's tap. doc: the offering page's own number
// (review.js), line: the port it came with, lang: the board's, frame: the viewer's, at: the mic's box in the frame's px
export function frameMic(doc, line, lang, frame, at) {
  stopFrameMic();
  const key = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'framemic',
    innerHTML: MIC,
  });
  key.dataset.noInk = ''; // (review mode's Pencil on HQ leaves it to the pen's tap: pentouch.js theirs)
  const v = (on = { doc, lang, frame, key, armed: 0, tell: mic => line.postMessage({ mic }) });
  line.onmessage = e => fromPage(v, e.data?.mic, e.data?.at);
  key.onclick = e => e.isTrusted && tapped(v); // (a tap of HQ's window, never one a script made)
  frame.closest('#viewer').append(key);
  // (the frame laid out again: the stage's devices, the notebook beside it, a new window size)
  const placed = () => place(v);
  v.follow = new ResizeObserver(placed);
  v.follow.observe(frame);
  addEventListener('resize', placed);
  document.addEventListener('book:layout', placed);
  v.unfollow = () => {
    v.follow.disconnect();
    removeEventListener('resize', placed);
    document.removeEventListener('book:layout', placed);
  };
  moved(v, at);
  paint(v, 'ready');
}
// A page's hello in the frame: another page than the one that offered is there now, whatever its load event
export function helloFrom(doc) {
  if (on && on.doc !== doc) stopFrameMic();
}
// On its line, the page's mic moved ('at'), the page stops its recording ('stop': every stop is answered) or lets
// its offer go ('cancel': the post-it put away)
function fromPage(v, mic, at) {
  if (on !== v) return;
  if (mic === 'at') return moved(v, at);
  if (mic === 'stop' && v.rec) return stop(v);
  if (mic === 'stop') return v.writing || v.tell({ done: null }); // (stopping at the key meanwhile: its words come)
  if (mic === 'cancel') stopFrameMic();
}
// The viewer closed, its frame loaded a page or another said hello, its page left, or the page let its offer go: the
// key goes, any recording unheard, and words still being written aren't sent
export function stopFrameMic() {
  const v = on;
  if (!v) return;
  on = null;
  v.gone = true;
  clearInterval(v.level);
  v.rec?.cancel();
  v.unfollow();
  v.key.remove();
  v.tell({ dropped: true });
}

// The mic's box in the frame, a plain one only; the key armed again where it moved far
function moved(v, at) {
  const n = k => (Number.isFinite(at?.[k]) ? at[k] : NaN),
    box = { x: n('x'), y: n('y'), w: Math.min(120, n('w')), h: Math.min(120, n('h')) };
  if (Object.values(box).some(Number.isNaN)) return;
  const far = !v.at || Math.hypot(box.x - v.at.x, box.y - v.at.y) > MOVED_PX;
  v.at = box;
  if (far) v.armed = performance.now() + ARM_MS;
  place(v);
}
// Over the frame where the page's mic is, at the frame's own scale (a device's size can shrink it), and only while it's
// inside the frame's box
function place(v) {
  const f = v.frame.getBoundingClientRect(),
    scale = v.frame.offsetWidth ? f.width / v.frame.offsetWidth : 1,
    x = f.left + v.frame.clientLeft * scale + v.at.x * scale,
    y = f.top + v.frame.clientTop * scale + v.at.y * scale,
    w = v.at.w * scale,
    h = v.at.h * scale;
  v.key.hidden = x < f.left || y < f.top || x + w > f.right + 0.5 || y + h > f.bottom + 0.5;
  Object.assign(v.key.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
}

function tapped(v) {
  if (on !== v || v.writing || performance.now() < v.armed) return;
  if (v.rec) return stop(v, true);
  const rec = (v.rec = dictateLive({
    lang: v.lang,
    onWords: heard => on === v && v.rec === rec && v.tell({ heard }),
    over: () => on === v && v.rec === rec && stop(v, true),
  }));
  paint(v, 'live');
  v.tell({ live: true });
  rec.ready.then(
    () => {
      if (on !== v || v.rec !== rec) return;
      v.level = setInterval(() => {
        const level = Math.min(1, rec.level());
        v.key.style.setProperty('--lvl', level.toFixed(2));
        v.tell({ level });
      }, LEVEL_MS);
    },
    err => {
      if (on !== v || v.rec !== rec) return;
      v.rec = null;
      paint(v, 'ready');
      v.tell({ failed: err?.name || 'Error' });
    },
  );
}

// Stopped (by the key: the page hears it's stopping): the words, once the last phrase is in, sent back
async function stop(v, byKey) {
  const rec = v.rec;
  v.rec = null;
  v.writing = true;
  clearInterval(v.level);
  if (byKey) v.tell({ stopping: true });
  paint(v, 'busy');
  let end;
  try {
    const { text, short } = await rec.stop();
    end = { done: text || null, why: short ? 'short' : null };
  } catch {
    end = { done: null, why: 'transcriber' };
  }
  if (v.gone) return;
  v.writing = false;
  paint(v, 'ready');
  v.tell(end);
}

// The key: ready (the mic, as the post-it's own), live (red) or busy (writing the words)
function paint(v, phase) {
  const { key } = v;
  key.dataset.phase = phase;
  key.disabled = phase === 'busy';
  key.style.setProperty('--lvl', 0);
  key.setAttribute(
    'aria-label',
    { live: 'Listening: tap to stop', busy: 'Writing your words' }[phase] ?? 'Dictate the note',
  );
}
