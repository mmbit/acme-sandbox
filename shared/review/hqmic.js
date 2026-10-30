import { stopMic, words } from './acts.js';

// Review mode's post-it mic in HQ's viewer, whose frame has no microphone (dictation.js's). While the post-it is open
// this page offers HQ its mic's place, kept as the post-it moves (the keyboard, its words growing, its pop), and HQ lays
// its own mic key right over it, looking the same: only the board's tap on that key records (HQ's framemic.js: nothing
// this page sends is taken as the board's word), at once, one tap, and the words come back here as they're said. The
// offer goes with a line of its own (r.hq.port, a MessagePort), and HQ answers on it alone: a word from an earlier
// recording is never taken for this one's, and none reaches the page the frame loads after this one. Each recording on
// it is the offer's rec while it lasts (rec.hq: the offer). (one tap, the board, call 170)
export function setupHqMic(r) {
  r.hq = null;
  let soon = 0;
  const later = () => {
    cancelAnimationFrame(soon);
    soon = requestAnimationFrame(() => sync(r));
  };
  new MutationObserver(later).observe(r.sheet, { attributes: true, attributeFilter: ['hidden', 'class'] });
  new ResizeObserver(later).observe(r.sheet);
  r.sheet.addEventListener('scroll', later, { passive: true });
  r.sheet.addEventListener('animationend', later);
  addEventListener('resize', later);
  visualViewport?.addEventListener('resize', later);
  visualViewport?.addEventListener('scroll', later);
  r.syncHq = later;
}
// The post-it open: offered, or its mic's place told again where it moved; gone: the offer goes
function sync(r) {
  const open = !r.sheet.hidden && !r.sheet.classList.contains('away') && r.mode !== 'idle',
    b = r.mic.getBoundingClientRect(),
    at = { x: b.left, y: b.top, w: b.width, h: b.height };
  if (!open || !b.width) return withdraw(r);
  if (!r.hq) return offer(r, at);
  const was = r.hq.at;
  if (Math.abs(was.x - at.x) + Math.abs(was.y - at.y) + Math.abs(was.w - at.w) < 0.5) return;
  r.hq.at = at;
  r.hq.port.postMessage({ mic: 'at', at });
}
function offer(r, at) {
  const line = new MessageChannel(),
    o = (r.hq = { port: line.port1, at, rec: null });
  line.port1.onmessage = e => fromHq(r, o, e.data?.mic);
  r.toHq({ mic: 'offer', at }, [line.port2]);
}
function withdraw(r) {
  if (!r.hq) return;
  r.hq.port.postMessage({ mic: 'cancel' });
  r.hq.port.close();
  r.hq = null;
}
// The post-it's own mic tapped here (a key, or the page's own code: HQ's key lies over it for the board's tap): it
// records nothing; the offer is made again if it went
export function askHq(r) {
  r.syncHq?.();
  r.msg.textContent = 'Tap the mic to talk.';
}
// HQ's key tapped: this recording, its words after what the note says now. What the reviewer types meanwhile stays.
function listening(r, o) {
  const rec = (o.rec = r.rec = { said: r.text.value.trim(), shown: [], taken: [], hq: o });
  rec.typed = () => {
    rec.said = r.text.value;
    rec.taken = rec.shown;
    rec.edited = true;
  };
  rec.done = new Promise(resolve => (rec.finished = resolve));
  r.text.addEventListener('input', rec.typed);
  r.mic.classList.add('on');
  r.msg.textContent = 'Listening… tap the mic to stop';
}
// HQ's answers: listening, the words so far, the voice's level, the mic refused, stopping at its key, the words once
// it's stopped, or the offer dropped as HQ's frame loaded a page (this one, before its load event: offered again)
function fromHq(r, o, m) {
  if (!m) return;
  if (m.live && r.hq === o) listening(r, o);
  const rec = o.rec;
  if (m.dropped) {
    if (r.hq === o) r.hq = null;
    if (rec && !rec.stopped) {
      rec.stopped = true;
      if (r.rec === rec) stopMic(r);
    }
    rec?.finished({ done: null, why: 'dropped' });
    r.syncHq();
    return;
  }
  if (!rec || rec.cancelled || (rec !== r.rec && rec !== r.endingRec)) return;
  if (typeof m.heard === 'string') words(r, rec, m.heard);
  if (typeof m.level === 'number' && r.rec === rec) r.mic.style.setProperty('--lvl', Math.min(0.6, m.level).toFixed(2));
  if (m.failed && r.rec === rec) {
    r.rec = null;
    r.mic.classList.remove('on');
    r.text.removeEventListener('input', rec.typed);
    r.msg.textContent = refused(m.failed);
  }
  if (m.stopping && r.rec === rec) {
    rec.stopped = true; // (HQ's key stopped it: the words follow unasked)
    stopMic(r);
  }
  // (a refusal can come after the recording's stop: endHq is waiting for it then)
  if ('done' in m || m.failed) rec.finished(m);
}
// What the note says when HQ couldn't start its microphone
const refused = failed =>
  failed === 'NotAllowedError'
    ? 'The microphone is blocked for HQ. Type the note instead?'
    : 'Could not start the microphone.';
// Stopped here or at HQ's key: HQ answers every stop with its words (or why there are none). Cancelled (the post-it
// put away): the offer goes, the recording unheard.
export async function endHq(r, rec) {
  r.rec = null;
  r.mic.classList.remove('on');
  r.mic.style.setProperty('--lvl', 0);
  if (rec.cancelled) {
    if (r.hq === rec.hq) withdraw(r);
    return;
  }
  if (!rec.stopped && r.hq === rec.hq) rec.hq.port.postMessage({ mic: 'stop' });
  const m = r.mark;
  r.mic.classList.add('busy');
  r.mic.disabled = true;
  r.msg.textContent = 'Turning your words into text…';
  const end = await rec.done;
  r.mic.classList.remove('busy');
  r.mic.disabled = false;
  if (rec.cancelled || r.mark !== m) return;
  if (end.failed) return void (r.msg.textContent = refused(end.failed));
  if (end.done) words(r, rec, end.done);
  r.msg.textContent = end.done
    ? 'Check the words, then pin it.'
    : end.why === 'short'
      ? 'That was very short. Tap, talk, then tap again.'
      : end.why === 'transcriber'
        ? 'The transcriber isn’t available right now. Type it instead?'
        : end.why === 'dropped'
          ? 'The recording stopped as the page loaded. Tap the mic to go on.'
          : 'No words came through. Try again, a little closer?';
}
