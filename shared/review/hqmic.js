import { stopMic, words } from './acts.js';

// Review mode's post-it mic in HQ's viewer, whose frame has no microphone (dictation.js's): the tap asks HQ, whose own
// Talk key shows in its bar; only the board's tap on that key records (HQ's framemic.js: nothing this page sends is
// taken as the board's word), and the words come back here as they're heard. Each ask goes with a line of its own
// (rec.hq, a MessagePort), and HQ answers on it alone: a word from an earlier recording is never taken for this one's,
// and none reaches the page the frame loads after this one. rec.hqLive: HQ's key tapped. rec.hint: what the note said
// before, back if the mic is tapped again first.
export function askHq(r) {
  const rec = (r.rec = { said: r.text.value.trim(), shown: [], taken: [], hint: r.msg.textContent });
  rec.typed = () => {
    rec.said = r.text.value;
    rec.taken = rec.shown;
    rec.edited = true;
  };
  rec.done = new Promise(resolve => (rec.finished = resolve));
  r.text.addEventListener('input', rec.typed);
  r.msg.textContent = 'Tap Talk in the bar above to start.';
  asked(r, rec);
}
function asked(r, rec) {
  const line = new MessageChannel();
  rec.hq = line.port1;
  line.port1.onmessage = e => fromHq(r, rec, e.data?.mic);
  r.toHq({ mic: 'start' }, [line.port2]);
}
// HQ's answers: listening, the words so far, the voice's level, the mic refused, stopping at its key, the words once
// it's stopped, or the ask dropped as HQ's frame loaded a page (this one, before its load event: asked again)
function fromHq(r, rec, m) {
  if (!m || rec.cancelled || (rec !== r.rec && rec !== r.endingRec)) return;
  if (m.live && r.rec === rec) {
    rec.hqLive = true;
    r.mic.classList.add('on');
    r.msg.textContent = 'Listening… tap the mic to stop';
  }
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
  if (m.dropped && !rec.hqLive && r.rec === rec) asked(r, rec);
  else if (m.dropped) {
    rec.stopped = true;
    if (r.rec === rec) stopMic(r);
    rec.finished({ done: null, why: 'dropped' });
  }
  // (a refusal can come after the mic's second tap: endHq is waiting for it then)
  if ('done' in m || m.failed) rec.finished(m);
}
// What the note says when HQ couldn't start its microphone
const refused = failed =>
  failed === 'NotAllowedError'
    ? 'The microphone is blocked for HQ. Type the note instead?'
    : 'Could not start the microphone.';
// Stopped here or at HQ's key: HQ answers every stop with its words (or why there are none); an ask its key never
// started just goes
export async function endHq(r, rec) {
  r.rec = null;
  r.mic.classList.remove('on');
  r.mic.style.setProperty('--lvl', 0);
  if (rec.cancelled || !rec.hqLive) {
    rec.hq.postMessage({ mic: 'cancel' });
    if (!rec.cancelled) r.msg.textContent = rec.hint;
    return;
  }
  if (!rec.stopped) rec.hq.postMessage({ mic: 'stop' });
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
