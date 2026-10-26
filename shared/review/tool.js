// Review mode's parts put together (review.js loads this): its element over the page with every part's markup and
// styles, the state they share (r), and what puts a note away. Each part is a module beside this one, served with the
// same gate as review.js (feedback.ts).
import { REDUCED_MOTION_CSS, baseCss } from './base.js';
import { startTrail } from './trail.js';
import { followPopups, makeHost } from './layer.js';
import * as dock from './dock.js';
import * as menu from './menu.js';
import * as notes from './notes.js';
import * as surface from './surface.js';
import * as postit from './postit.js';
import * as pictures from './pictures.js';
import * as dictation from './dictation.js';
import { setupChange, unpick } from './change.js';
import * as pencil from './pencil.js';
import { setupCall } from './callnotes.js';

// r: the config review.js hands over ({ HQ, framed, OUTSIDE, outside, SENT, LOOK, ROUTE, summoned, toHq, covered }), the
// elements and the state the parts share. mode: idle | pick (marking) | note (the post-it open) | sending
export function start(config) {
  const r = {
    ...config,
    mode: 'idle',
    mark: null,
    shot: null,
    editing: null,
    strokes: [],
    penSeen: false,
    covered: config.covered,
  };
  startTrail(r);
  const css = [
    baseCss(r.LOOK),
    dock.CSS,
    menu.CSS,
    notes.CSS,
    surface.CSS,
    postit.CSS,
    pictures.CSS,
    dictation.CSS,
    pencil.CSS,
    REDUCED_MOTION_CSS,
  ].join('');
  makeHost(
    r,
    css,
    `<div class="ui">${surface.HTML}${pencil.HTML}${postit.HTML}${dock.html(menu.HTML)}${notes.HTML}</div>`,
  );
  elements(r);
  followPopups(r);
  dock.setupDock(r);
  menu.setupMenu(r);
  notes.setupNotes(r);
  setupChange(r);
  keys(r);
  surface.setupSurface(r);
  postit.setupPostit(r);
  pictures.setupPictures(r);
  dictation.setupDictation(r);
  if (r.book) {
    pencil.setupPencil(r);
    setupCall(r);
  }
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
    redrawButton: $('.redraw'),
    more: $('.more'),
    menu: $('.menu'),
    notesItem: $('[data-list]'),
    sendButton: $('[data-mine]'),
    again: $('[data-again]'),
    side: $('.side'),
    dim: $('.dim'),
    sideList: $('.side ol'),
    sideSend: $('.side [data-send]'),
    zoom: $('.zoom'),
  });
  r.ask = r.text.placeholder;
}

// the pin: a note starts, or the marking stops
export function toggle(r) {
  dock.uncoach(r);
  menu.shut(r);
  notes.closeSide(r);
  if (r.mode === 'idle') surface.pick(r);
  else if (r.mode === 'pick') (r.editing ? unpick : reset)(r);
}
// Cancel, or Escape: a change goes back to My notes
export function cancel(r) {
  const was = r.editing;
  reset(r);
  if (was) notes.openSide(r);
}
export function reset(r) {
  Object.assign(r, { mode: 'idle', mark: null, shot: null, editing: null });
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
  r.dock.hidden = !r.side.hidden;
  dock.settle(r);
  r.root.querySelectorAll('.drop').forEach(d => d.remove());
  r.hl.hidden = true;
  r.redrawButton.hidden = true;
  r.pinIt.textContent = 'Pin it';
  pencil.unmark(r);
  pictures.showPictures(r, []);
  r.penOn?.cancel();
  Object.assign(r, { strokes: [], penSeen: false, undoTo: null, exposure: null });
  r.veil.classList.remove('marked');
  r.undoButton.disabled = true;
  surface.paintInk(r, []);
}

function keys(r) {
  // Escape puts away the big screenshot, else the sidebar, else the menu and the note
  addEventListener(
    'keydown',
    e => {
      if (e.key !== 'Escape' || r.covered) return;
      // what it puts away is review mode's own: the page's popup under it stays open
      if (!r.zoom.hidden || !r.side.hidden || !r.menu.hidden || r.mode !== 'idle') e.preventDefault();
      if (!r.zoom.hidden) r.zoom.hidden = true;
      else if (!r.side.hidden) notes.closeSide(r);
      else {
        menu.shut(r);
        if (r.mode === 'pick' && r.editing) unpick(r);
        else if (r.mode !== 'idle' && r.mode !== 'sending') cancel(r);
      }
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
