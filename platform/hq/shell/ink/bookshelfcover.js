// A book's cover changed from its menu on the Shelf (bookshelf.js): a picture picked from the device, drawn again at
// most COVER_SIDE a side (nothing of the file goes but its pixels), on the book's front at once and kept by the store
// (POST /api/notebooks/cover), heard as a print laid down.
import { foley } from '../audio.js';
import { shrink } from '../tray.js';
import { setCover } from './notebookdata.js';

// a cover shows a few hundred px wide at most: this keeps it sharp on a retina tablet and small to send
const COVER_SIDE = 1200;

// s: the overview's state (bookshelf.js mountScreens). ui: { draw(), refresh(), told(words) }, the overview's own.
// Returns change(n): the picker opened for notebook n's cover.
export function mountCover(s, ui) {
  const input = Object.assign(document.createElement('input'), {
    type: 'file',
    accept: 'image/png,image/jpeg',
    hidden: true,
  });
  s.far.after(input);
  let book = null;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file && book) put(s, ui, book, file);
  });
  return n => {
    book = n;
    input.click();
  };
}

async function put(s, ui, n, file) {
  let picture;
  try {
    picture = await dataUrl(await shrink(file, COVER_SIDE));
  } catch {
    return ui.told("That picture couldn't be read. Try a JPEG or PNG.");
  }
  const before = n.cover;
  n.cover = picture;
  ui.draw();
  foley('hit', { material: 'card', size: 1.4, force: 0.25 }, { vol: 0.25 });
  try {
    await setCover(s.dev, n.id, picture);
  } catch (e) {
    n.cover = before;
    ui.draw();
    ui.told(e.message);
  }
  ui.refresh();
}
const dataUrl = blob =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
