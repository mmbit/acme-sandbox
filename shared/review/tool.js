// Review mode's parts put together (review.js loads this): its element over the page with every part's markup and
// styles, the state they share (r), and what puts a note away. Each part is a module beside this one, served with the
// same gate as review.js (feedback.ts). No part imports this: what one asks of the parts above it comes from acts.js,
// handed in here as it loads, so the imports form no circle.
import { REDUCED_MOTION_CSS, baseCss } from './base.js';
import { hand } from './acts.js';
import { startTrail } from './trail.js';
import { followPopups, makeHost } from './layer.js';
import * as dock from './dock.js';
import * as menu from './menu.js';
import * as surface from './surface.js';
import * as postit from './postit.js';
import * as pictures from './pictures.js';
import * as dictation from './dictation.js';
import * as pencil from './pencil.js';
import { setupCall } from './callnotes.js';
import { setupCallFrame } from './callframe.js';

// what a part asks of the parts above it (acts.js)
hand({
  reset,
  toggle,
  shut: menu.shut,
  paint: menu.paint,
  refresh: menu.refresh,
  redrawInk: surface.redrawInk,
  stopMic: dictation.stopMic, // (stopMic, words)
  words: dictation.words,
});

// r: the config review.js hands over ({ HQ, framed, OUTSIDE, outside, INK, LOOK, ROUTE, summoned, book, toHq, covered,
// away, calling }), the elements and the state the parts share. mode: idle | pick (marking) | note (the post-it open) | sending
export function start(config) {
  const r = {
    ...config,
    mode: 'idle',
    mark: null,
    shot: null,
    strokes: [],
    penSeen: false,
    covered: config.covered,
    away: config.away,
  };
  startTrail(r);
  const css = [
    baseCss(r.LOOK),
    dock.CSS,
    menu.CSS,
    surface.CSS,
    postit.CSS,
    pictures.CSS,
    dictation.CSS,
    pencil.CSS,
    REDUCED_MOTION_CSS,
  ].join('');
  makeHost(r, css, `<div class="ui">${surface.HTML}${pencil.HTML}${postit.HTML}${dock.html(menu.HTML)}</div>`);
  elements(r);
  followPopups(r);
  dock.setupDock(r);
  menu.setupMenu(r);
  keys(r);
  surface.setupSurface(r);
  postit.setupPostit(r);
  pictures.setupPictures(r);
  dictation.setupDictation(r);
  if (r.book) {
    pencil.setupPencil(r);
    setupCall(r);
  } else if (r.framed && !r.outside) setupCallFrame(r); // (HQ's viewer on a call)
  return { toggle: () => toggle(r), refresh: () => menu.refresh(r) };
}

function elements(r) {
  const $ = (r.$ = s => r.root.querySelector(s));
  Object.assign(r, {
    ui: $('.ui'),
    dock: $('.dock'),
    fab: $('.fab'),
    tip: $('.tip'),
    coach: $('.coach'),
    veil: $('.veil'),
    strip: $('.strip'),
    undoButton: $('.undo'),
    haloCanvas: $('.halo'),
    inkCanvas: $('.ink'),
    wet: $('.wet'),
    hl: $('.hl'),
    sheet: $('.sheet'),
    text: $('textarea'),
    msg: $('.msg'),
    mic: $('.mic'),
    pinIt: $('.send'),
    more: $('.more'),
    menu: $('.menu'),
  });
  r.ask = r.text.placeholder;
}

// the pin: a note starts, or the marking stops
export function toggle(r) {
  dock.uncoach(r);
  menu.shut(r);
  if (r.mode === 'idle') surface.pick(r);
  else if (r.mode === 'pick') reset(r);
}
// Cancel, Escape, or a note gone: review mode at rest again
export function reset(r) {
  Object.assign(r, { mode: 'idle', mark: null, shot: null });
  dictation.stopMic(r, true);
  r.text.value = '';
  r.msg.textContent = '';
  r.pinIt.disabled = false; // the next note starts blank, and can be pinned
  r.veil.hidden = true;
  r.sheet.hidden = true;
  r.sheet.classList.remove('away', 'bare');
  r.text.placeholder = r.ask;
  r.fab.classList.remove('on');
  r.more.hidden = false;
  r.dock.hidden = false;
  dock.settle(r);
  r.root.querySelectorAll('.drop').forEach(d => d.remove());
  r.hl.hidden = true;
  r.pinIt.textContent = postit.saveWord(r); // (Save, the board's; Pin it, a guest's)
  pencil.unmark(r);
  pictures.clearPictures(r);
  r.penOn?.cancel();
  Object.assign(r, { strokes: [], inkSteps: [], penSeen: false, undoTo: null, exposure: null });
  r.veil.classList.remove('marked');
  r.undoButton.disabled = true;
  surface.paintInk(r, []);
}

function keys(r) {
  // Escape puts away the menu and the note
  addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Escape' || r.covered) return;
      // what it puts away is review mode's own: the page's popup under it stays open
      if (!r.menu.hidden || r.mode !== 'idle') e.preventDefault();
      menu.shut(r);
      if (r.mode !== 'idle' && r.mode !== 'sending') reset(r);
    },
    true,
  );
  // Cmd or Ctrl+Z takes back the last line (in the note's words, it's the words' own undo)
  addEventListener(
    'keydown',
    e => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
      if (r.covered || r.root.activeElement === r.text) return;
      // (the Pencil on HQ: anything; else the last line while marking.)
      const book = r.book && r.veil.hidden,
        typing = document.activeElement?.matches('input, textarea, select, [contenteditable]'),
        pencilUndoes = book && (r.mode === 'note' || (r.mode === 'idle' && r.steps.length && !typing)),
        surfaceUndoes = !book && r.mode === 'note' && !r.veil.hidden;
      if (!(pencilUndoes || surfaceUndoes)) return;
      e.preventDefault();
      e.stopPropagation();
      (book ? pencil.undo : surface.undo)(r);
    },
    true,
  );
  // Keys typed into the note are the note's: the page's own shortcuts never hear them (a deck's space and arrows turned
  // its slides and ate the spaces). Escape still reaches the listener above, which hears it first.
  for (const type of ['keydown', 'keypress', 'keyup']) r.host.addEventListener(type, e => e.stopPropagation());
  // Taps on it are its own too: inside a popup, one that shuts on a tap outside what it shows stays open
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click'])
    r.host.addEventListener(type, e => e.stopPropagation());
}
