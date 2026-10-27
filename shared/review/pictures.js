// Pictures pasted or dropped on the note: the reviewer's own pictures go with it, as small thumbnails under its words:
// pasted (Ctrl or Cmd+V) or dropped on the open note, each with a × to take it off. Each is drawn again here at most
// 2,000 px a side and stepped down to what the coordinator keeps, as the screenshot is, so a phone's photo goes too,
// without what its file says besides the pixels (where it was taken). A PNG stays one while it fits (a screenshot's text
// stays sharp). A change shows the note's own again, kept by their names.
import { ACCENT, button } from './base.js';

// the pictures taped under the note's words; the sheet lights up while one is dragged over
export const CSS = `
      .pics { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 12px; padding: 4px 2px 0; list-style: none; }
      .pics:empty { display: none; }
      .pics li { position: relative; width: 64px; height: 64px; padding: 3px; background: #fff; box-shadow: 0 2px 6px rgba(43,34,48,.25); transform: rotate(var(--tilt, 0deg)); animation: pop-in .3s cubic-bezier(.3,1.5,.5,1) both; }
      .pics img { width: 100%; height: 100%; object-fit: cover; display: block; background: #3a3345; }
      .pics li.busy img { background: linear-gradient(110deg, #3a3345 30%, #5a4f6b 50%, #3a3345 70%) 0 0 / 300% 100%; animation: shimmer 1.4s linear infinite; }
      .pics .x { position: absolute; top: -9px; right: -9px; width: 24px; height: 24px; border-radius: 50%; background: #2b2230; color: #fff; font-size: 17px; line-height: 1; display: grid; place-items: center; box-shadow: 0 0 0 2px #fff6c9; }
      .pics .x::before { content: ""; position: absolute; inset: -10px; }   /* (a finger's reach) */
      .sheet.taking { outline: 3px dashed ${ACCENT}; outline-offset: 5px; }`;

const MAX_PICTURES = 12,
  MAX_SIDE = 2000,
  MAX_DATA_URL = 2_000_000;
const FRAMELESS =
  'The film’s frame couldn’t be copied here (it comes from another site): the note keeps its moment, without a picture of it.';
const NO_ROOM_FOR_FRAME =
  'A note takes a dozen pictures at most, so the film’s frame stays off: the note keeps its moment, without a picture of it.';

// r.pictures: each { file } kept on a change or { data } new (once ready), with its thumbnail; r.framePic: the one that
// is a video's frame, added with this mark
function addPictures(r, files) {
  const images = files.filter(f => f.type.startsWith('image/'));
  if (images.length < files.length) r.msg.textContent = 'Only pictures go with a note.';
  for (const file of images) {
    if (r.pictures.length >= MAX_PICTURES) {
      r.msg.textContent = 'A note takes a dozen pictures at most.';
      return;
    }
    const p = {};
    p.li = thumbnail(r, p, null);
    p.ready = scaled(file).then(data => {
      if (data) {
        p.data = data;
        p.li.querySelector('img').src = data;
        p.li.classList.remove('busy');
        return;
      }
      p.failed = true;
      unpicture(r, p);
      r.msg.textContent = 'That picture couldn’t be read here. Another kind of file?';
    });
    r.pictures.push(p);
  }
}
function thumbnail(r, p, src) {
  const li = document.createElement('li'),
    img = new Image(),
    x = button('×', 'x');
  img.alt = '';
  x.setAttribute('aria-label', 'Remove this picture');
  if (src) img.src = src;
  else li.classList.add('busy');
  x.onclick = () => {
    unpicture(r, p);
    r.msg.textContent = '';
    if (matchMedia('(pointer: fine)').matches) r.text.focus();
  };
  li.style.setProperty('--tilt', `${(Math.random() * 6 - 3).toFixed(1)}deg`); // (taped on by hand)
  li.append(img, x);
  r.picList.append(li);
  return li;
}
export function unpicture(r, p) {
  r.pictures = r.pictures.filter(q => q !== p);
  p.li.remove();
}
// what goes with the note, once every picture is drawn: the names of the ones kept, the new ones as data URLs
// (null if one of them couldn't be read while the note was waiting: it goes nowhere without it, and the message says why)
export async function picturesNow(r, waiting) {
  await Promise.all(waiting.map(p => p.ready));
  return waiting.some(p => p.failed) ? null : r.pictures.flatMap(p => (p.file ? [p.file] : p.data ? [p.data] : []));
}
export function showPictures(r, list) {
  r.pictures = [];
  r.picList.replaceChildren();
  r.framePic = null;
  for (const { file, url } of list) {
    const p = { file };
    p.li = thumbnail(r, p, url);
    r.pictures.push(p);
  }
}
async function scaled(file) {
  const src = URL.createObjectURL(file),
    img = new Image();
  try {
    img.src = src;
    await img.decode();
    return drawn(img, img.naturalWidth, img.naturalHeight, file.type === 'image/png');
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(src);
  }
}
// a picture, or a video's frame, as a data URL the coordinator keeps (null if it can't be read: a video from another
// site without CORS taints the canvas)
export function drawn(img, w, h, png) {
  try {
    const c = document.createElement('canvas'),
      g = c.getContext('2d');
    for (let k = Math.min(1, MAX_SIDE / Math.max(w, h)); k > 0.05; k *= 0.7) {
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      g.clearRect(0, 0, c.width, c.height);
      if (png) {
        g.drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL('image/png');
        if (url.length < MAX_DATA_URL) return url;
      }
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height); // (a JPEG has no see-through)
      for (const q of [0.85, 0.7, 0.55]) {
        const url = c.toDataURL('image/jpeg', q);
        if (url.length < MAX_DATA_URL) return url;
      }
    }
    return null;
  } catch {
    return null;
  }
}
// A new note for the book (the Pencil on HQ, postit.js booked) takes no pictures: the book's notes have none. A change
// to one of review mode's own notes still does.
const booksNote = r => r.book && !r.editing;

// the paused video's frame, as the note's first picture (its × takes it off like any other)
// (what to tell the board when no frame went: a film from another site without CORS taints the canvas, and a note
// with a dozen pictures has no room; '' when it did)
export function addFrame(r, video) {
  if (booksNote(r)) return ''; // (its snip shows the frame)
  const data = drawn(video, video.videoWidth, video.videoHeight, false);
  if (!data) return FRAMELESS;
  if (r.pictures.length >= MAX_PICTURES) return NO_ROOM_FOR_FRAME;
  const p = { data, ready: Promise.resolve() };
  p.li = thumbnail(r, p, data);
  r.picList.prepend(p.li);
  r.pictures.unshift(p);
  r.framePic = p;
  return '';
}

// A paste into the note, or with nothing on the page to take it. Text copied with a picture of itself (an office app's
// cells) pastes as text; a file copied in a file manager brings its name as text, and goes as the picture.
const imagesIn = list => [...(list ?? [])].filter(f => f.type.startsWith('image/'));
function pasted(r, e) {
  if (r.mode !== 'note' || r.covered || booksNote(r)) return;
  const images = imagesIn(e.clipboardData?.files),
    words = e.clipboardData?.getData('text/plain').trim() ?? '';
  if (!images.length || (words && !words.split(/\r?\n/).every(w => images.some(f => f.name === w.trim())))) return;
  e.preventDefault();
  addPictures(r, images);
}
// A file dragged over the open note lights it up, and dropped there goes with it. One that misses it lands on the note
// too, unless the page takes it, rather than the browser opening the file in place of the page and the note. While
// the note is covered (HQ's viewer), or is the book's, which takes no pictures, a miss still doesn't open the file, but
// nothing goes in the note.
function dropping(r, target, ours) {
  const carriesFiles = e => r.mode === 'note' && [...(e.dataTransfer?.types ?? [])].includes('Files'),
    shut = () => r.covered || booksNote(r);
  target.addEventListener('dragover', e => {
    if (!carriesFiles(e) || (!ours && e.defaultPrevented)) return;
    if (ours) e.stopPropagation();
    e.preventDefault();
    e.dataTransfer.dropEffect = shut() ? 'none' : 'copy';
    if (shut()) return;
    r.sheet.classList.add('taking');
    clearTimeout(r.takingTimer);
    r.takingTimer = setTimeout(() => r.sheet.classList.remove('taking'), 200);
  });
  target.addEventListener('drop', e => {
    if (!carriesFiles(e) || (!ours && e.defaultPrevented)) return;
    if (ours) e.stopPropagation();
    e.preventDefault();
    if (shut()) return;
    r.sheet.classList.remove('taking');
    addPictures(r, [...e.dataTransfer.files]);
  });
}

export function setupPictures(r) {
  r.pictures = [];
  r.framePic = null;
  r.picList = document.createElement('ul');
  r.picList.className = 'pics';
  r.picList.setAttribute('aria-label', 'Pictures with this note');
  r.text.after(r.picList);
  // (the page never hears what goes in the note)
  r.host.addEventListener('paste', e => {
    e.stopPropagation();
    pasted(r, e);
  });
  addEventListener('paste', e => (e.target === document.body || e.target === document.documentElement) && pasted(r, e));
  dropping(r, r.host, true);
  dropping(r, window, false);
}
