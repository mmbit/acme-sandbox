// Review mode's microphone for the page in HQ's viewer: its frame is never given the microphone (desk.js's iframe), so
// a tap on the mic of the post-it there (shared/review/dictation.js) asks HQ, which records on its own page and sends
// the words back as they're heard, the voice line's way (voice.js: pieces cut at the pauses, each transcribed as the
// board talks; the whole clip the fallback). Only at that tap, and only for the viewer's page: nothing records unasked
// (the board, call 154).
import { record } from './voice.js';
import { transcribe } from './data.js';

const LEVEL_MS = 100; // the post-it's mic breathes with the voice at this pace
let on = null; // { id, to, origin, rec, parts, pending, failed, level }

// d: the page's ask ({ mic: 'start' | 'stop' | 'cancel', id }), to and origin: its window and origin, lang: the board's
export function frameMic(d, to, origin, lang) {
  if (d.mic === 'start') return start(d.id, to, origin, lang);
  if (!on || on.id !== d.id || on.to !== to) return;
  if (d.mic === 'stop') return stop(on, lang);
  stopFrameMic();
}
// The viewer closed or its page left: the recording goes, unheard
export function stopFrameMic() {
  if (!on) return;
  clearInterval(on.level);
  on.rec.cancel();
  on = null;
}

function start(id, to, origin, lang) {
  stopFrameMic();
  const v = (on = { id, to, origin, parts: [], pending: [], failed: false });
  const tell = m => v.to.postMessage({ hq: 'hq', mic: { id, ...m } }, v.origin);
  v.tell = tell;
  v.heard = () => v.parts.filter(Boolean).join(' ').trim();
  v.rec = record({
    lang,
    onSegment: clip => {
      const i = v.parts.push('') - 1;
      v.pending.push(
        transcribe(clip, lang).then(
          text => {
            v.parts[i] = text;
            if (on === v) tell({ heard: v.heard() });
          },
          () => (v.failed = true),
        ),
      );
    },
  });
  v.rec.ready.then(
    () => {
      if (on === v) v.level = setInterval(() => tell({ level: Math.min(1, v.rec.level()) }), LEVEL_MS);
    },
    err => {
      if (on !== v) return;
      on = null;
      tell({ failed: err?.name || 'Error' });
    },
  );
}

// Let go of: the last piece transcribed (or the whole clip, where the pieces failed), and the words sent back
async function stop(v, lang) {
  on = null;
  clearInterval(v.level);
  const short = v.rec.seconds() < 0.6,
    clip = await v.rec.stop();
  await Promise.all(v.pending);
  if ((!v.heard() || v.failed) && clip && !short) {
    try {
      v.parts = [await transcribe(clip, lang)];
    } catch {
      return v.tell({ done: null, why: 'transcriber' });
    }
  }
  v.tell({ done: v.heard() || null, why: short ? 'short' : null });
}
