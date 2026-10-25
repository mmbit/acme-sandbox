// Pictures on a call (call.js).
import { uploadPicture } from './data.js';
import * as world from '../world/world.js';
import { names } from './brand.js';
import { icon } from './icons.js';
import { shrink } from './tray.js';

const $ = s => document.querySelector(s);
const PICTURE = icon('picture');

// While the call is live the board attaches or pastes a picture. Each one is redrawn as a JPEG (shrink()), uploaded for
// this call, and the voice line gets its number. The line shows it to the agent with the board's next words, or on its
// own after a quiet moment, and says how far it got: 'received', then 'seen', or 'failed' (a restarted agent lost it, for
// one: platform/voice). It says them all again when the call resumes. The strip under the words shows each picture's
// state.
// The agent sees them in the order the board picked them: each takes its place in c.queued when it's picked, and goes
// to the line once it's uploaded and the ones before it are sent or failed. A number sent stays in c.unanswered until
// the line answers, and goes again when the call resumes (the line ignores a number it knows).
export function startPictures(c) {
  c.queued = [];
  c.unanswered = [];
  c.urls = [];
  c.uploads = new AbortController(); // (hanging up stops the uploads on their way)
  const strip = $('#call-pics');
  strip.innerHTML = '';
  strip.hidden = true;
  $('#call-attach').disabled = true; // (until the line picks up: the upload needs the call's number)
  $('#call-attach').onclick = () => $('#call-file').click();
  $('#call-file').onchange = e => {
    sharePictures(c, e.target.files);
    e.target.value = '';
  };
  c.paste = e => pastePictures(c, e);
  addEventListener('paste', c.paste);
}
// the line picked up, or took the call back after a reconnect: numbers it hasn't answered go again, in order, then the
// ones that waited for it
export function picturesLive(c) {
  $('#call-attach').disabled = false;
  for (const id of c.unanswered) c.ws.send(JSON.stringify({ type: 'picture', id }));
  sendPictures(c);
}
// the uploaded pictures at the front of the queue go to the line, while it has the call on this connection
function sendPictures(c) {
  while (c.live && c.ws?.readyState === 1 && c.queued[0]?.id) {
    const { id } = c.queued.shift();
    c.unanswered.push(id);
    c.ws.send(JSON.stringify({ type: 'picture', id }));
  }
}
function pastePictures(c, e) {
  if (c.over || !c.call || e.defaultPrevented || e.target.closest?.('input, textarea, [contenteditable]')) return;
  const items = [...(e.clipboardData?.items ?? [])].filter(i => i.kind === 'file').map(i => i.getAsFile());
  const files = e.clipboardData?.files.length ? [...e.clipboardData.files] : items.filter(Boolean);
  if (!files.some(f => f.type.startsWith('image/'))) return;
  e.preventDefault();
  sharePictures(c, files);
}
function sharePictures(c, files) {
  for (const file of [...files].filter(f => f.type.startsWith('image/'))) sharePicture(c, file);
}
async function sharePicture(c, file) {
  // The call the board picked it on, by its key: a call that ends while the picture is redrawn or sent can give its
  // number to the next one, and the coordinator refuses the key of a call that's gone (pictures.ts).
  const on = { call: c.call, key: c.key, signal: c.uploads.signal },
    place = { id: 0 };
  c.queued.push(place);
  const strip = $('#call-pics'),
    li = document.createElement('li');
  li.className = 'busy';
  li.innerHTML = `<span class="thumb">${PICTURE}</span><i>Sending…</i>`;
  strip.hidden = false;
  strip.append(li);
  strip.scrollLeft = strip.scrollWidth;
  try {
    const blob = await shrink(file),
      url = URL.createObjectURL(blob);
    c.urls.push(url);
    li.querySelector('.thumb').innerHTML = `<img src="${url}" alt="">`;
    if (c.over) return;
    const { id } = await uploadPicture(world.dev, blob, on);
    if (c.over) return;
    li.dataset.picture = place.id = id;
    sendPictures(c);
  } catch (err) {
    if (c.over) return;
    c.queued.splice(c.queued.indexOf(place), 1); // (the ones after it go without it)
    sendPictures(c);
    const status = +String(err?.message ?? '').match(/\d{3}$/)?.[0];
    pictureSays(
      li,
      'failed',
      err === 'decode'
        ? 'Couldn’t read it'
        : status === 413
          ? 'Too big to send'
          : status === 409
            ? 'The call ended'
            : status === 429
              ? 'Too many pictures'
              : status
                ? `Not sent (error ${status})`
                : `Couldn’t reach ${names.hq}`,
    );
  }
}
// what the voice line says about a picture: it has it, the agent has it, or it couldn't use it (or lost it)
export function pictureState(c, ev) {
  const unanswered = c.unanswered.indexOf(Number(ev.id));
  if (unanswered >= 0) c.unanswered.splice(unanswered, 1);
  const li = $(`#call-pics [data-picture="${Number(ev.id)}"]`);
  if (!li) return;
  if (ev.state === 'received') pictureSays(li, 'sent', 'Sent');
  else if (ev.state === 'seen') pictureSays(li, 'seen', `${c.name} has it`);
  else if (ev.state === 'failed') pictureSays(li, 'failed', PICTURE_FAILED[ev.why] ?? `${c.name} couldn’t open it`);
}
// (why the line let it go; a turn stopped before its request isn't one: the session sends it with the next.)
const PICTURE_FAILED = { 'too many': 'Too many pictures', lost: 'Lost. Share it again' };
const pictureSays = (li, state, text) => {
  li.className = state;
  li.querySelector('i').textContent = text;
};
export function stopPictures(c) {
  removeEventListener('paste', c.paste);
  c.uploads.abort();
  for (const url of c.urls) URL.revokeObjectURL(url);
}
