// The call's window as a place to let a picture go (call.js): a Notebook page carried by its folded corner
// (bookdogear.js), a picture file dragged in from the desktop, or a picture dragged off a page. The window lights while
// something it takes is over it, its screen or, minimised, its bubble, and what's let go there goes to the agent as an
// attached picture does (callpictures.js). A paste is the call's too while the board is in its window: pressed or
// focused there last.
import { showPictures } from './callpictures.js';

const IMAGE = /^image\//;
// a drag's events come every few hundred ms at most while it's held still: the light goes this long after the last
const LIT_MS = 300;
const DRAGS = ['dragenter', 'dragover', 'drop'];

let call = null;

export function startDrop(c) {
  call = c;
  c.inWindow = false;
  c.dragged = e => dragged(c, e);
  c.pressed = e => (c.inWindow = !!windowOf(c, e.target));
  for (const type of DRAGS) addEventListener(type, c.dragged, true);
  addEventListener('pointerdown', c.pressed, true);
  addEventListener('focusin', c.pressed, true);
}
export function stopDrop(c) {
  for (const type of DRAGS) removeEventListener(type, c.dragged, true);
  removeEventListener('pointerdown', c.pressed, true);
  removeEventListener('focusin', c.pressed, true);
  light(c, false);
  if (call === c) call = null;
}

// The call's window under a point on the screen, or null (no call, or not over it)
export const callWindowAt = (x, y) => call && windowOf(call, document.elementFromPoint(x, y));
// The call's window lit as a place to let go, or not
export const lightCall = on => call && light(call, on);
// Whether a paste is the call's: the board pressed or focused its window last
export const pasteForCall = () => !!call?.inWindow;
// Pictures let go on the call's window from inside HQ (each a File or a promise of one), as a drop's go: a picture
// taped in the notebook, carried there by the Select tool (bookselectlift.js).
export const dropOnCall = files => call && showPictures(call, files);

// The window shown: the call's screen, or its bubble while it's small; the one an element is in, else null
function windowOf(c, el) {
  const shown = c.small ? c.bubble?.el : c.layer?.querySelector('.device');
  return shown && el instanceof Node && shown.contains(el) ? shown : null;
}
function light(c, on) {
  clearTimeout(c.lit);
  for (const el of [c.bubble?.el, c.layer?.querySelector('.device')]) el?.toggleAttribute('data-drop', on);
  if (on) c.lit = setTimeout(() => light(c, false), LIT_MS);
}

// A drag over the window: taken when it carries files or a picture's address; let go, its pictures go to the agent
function dragged(c, e) {
  const types = [...(e.dataTransfer?.types ?? [])];
  if (!windowOf(c, e.target) || !(types.includes('Files') || types.includes('text/uri-list'))) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'copy';
  light(c, e.type !== 'drop');
  if (e.type === 'drop') showPictures(c, picturesIn(e.dataTransfer));
}
// The pictures a drop carries: its picture files, else the picture at the address it carries (a page's own <img>)
function picturesIn(data) {
  const files = [...data.files].filter(f => IMAGE.test(f.type));
  if (files.length || data.files.length) return files;
  const url = data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .find(line => line && !line.startsWith('#'));
  return url ? [fetch(url).then(answer => answer.blob())] : [];
}
