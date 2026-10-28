// Words edited with the pen, wherever words show (a textarea, or an element holding plain text): a stroke over them
// strikes words out (gone at once, its line fading where it was drawn) or slices the text open (a gap and a caret,
// where the next writing goes, read as handwriting by the owner's reader, or a keyboard's caret). And a field kept from
// Apple's Scribble while the pen may edit its words, and the pen's strokes on a field that no ink surface takes.
// penedit.js decides what a stroke does.
import { copyOf, editOf, inserted, overlay, struck, wordsOf } from './penedit.js';
import { outline } from './ink.js';
import { wandered } from './tap.js';

const FADE_MS = 450; // a strike's line fading as its words go
// the pen resting this long in an open gap: what's written there is read (as written.js reads a mark's lines)
const REST_MS = 1200;
const GAP_EM = 3; // an open gap's width, in the words' em
const ROOM_LINES = 2.5; // the room for writing round words opened, above, below and either side, in their lines
const SIZE = 4; // the pen's line, in the words' px (the book's ink is 5 on its page)

// The edit a stroke (client px points) makes on an element's words: editOf's ({ kind: 'strike', ranges } or { kind:
// 'slice', at }) with the text it was read on, or null
export function amendOf(el, points) {
  const { text, words } = wordsOf(el);
  const edit = editOf(points, words);
  return edit && { ...edit, text };
}

// Words struck: the text without them, given at once to put (its owner keeps it as if typed), and the stroke fading
// where it was drawn. color: the ink's.
export function strikeOut(el, edit, points, { put, color }) {
  put(struck(edit.text, edit.ranges));
  fade(el, points, color);
}
function fade(el, points, color) {
  const { layer, local } = layerOver(el);
  const line = { color: color ?? getComputedStyle(el).color, size: SIZE, points: points.map(p => local(p)) };
  layer.innerHTML = `<svg width="1" height="1" style="position: absolute; overflow: visible" aria-hidden="true"><path d="${outline(line)}" fill="${line.color}"/></svg>`;
  layer
    .animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-in' })
    .finished.then(() => layer.remove());
}

// ---- kept from Scribble

// A field the pen edits, on a touch screen (an iPad's): read-only while it holds words and isn't being typed in, so
// Apple's Scribble never takes a Pencil touching it and the pen's strokes over its words reach the page (a strike, a
// slice). A finger's or a mouse's press, a tap that focuses it (the Pencil's too) or the keyboard's Tab make it
// editable again before it's focused, so typing and Scribble after a tap work as before. Read-only rather than a copy
// of the words over the field: the field stays the one thing on screen, its layout, selection and focus its own.
// data-pen marks it read-only for the pen (not for good). refresh(): its words changed by its owner's code.
export function keepFromScribble(field) {
  if (!matchMedia('(any-pointer: coarse)').matches) return { refresh() {} };
  const free = () => {
    field.readOnly = false;
    field.removeAttribute('data-pen');
  };
  const refresh = () => {
    if (field.matches(':focus') || !field.value.trim()) return free();
    field.readOnly = true;
    field.setAttribute('data-pen', '');
  };
  field.addEventListener('pointerdown', e => e.pointerType !== 'pen' && free(), true);
  field.addEventListener('focus', free);
  field.addEventListener('blur', refresh);
  refresh();
  return { refresh };
}
// Whether the pen edits a field's words now (kept from Scribble), rather than the field taking it
export const penEdits = field => field.hasAttribute('data-pen');

// ---- the pen's strokes on a field

// The Pencil's strokes on an element no ink surface takes (review mode's post-it): drawn as it goes, and given to
// end(points) as it lifts (client px, with pressure). use(e): whether this press is one (else the element's own); a
// tap stays the element's (a click, a focus).
export function strokesOn(el, { use, end, color }) {
  el.addEventListener(
    'touchmove',
    e => [...e.changedTouches].some(t => t.touchType === 'stylus') && penEdits(el) && e.preventDefault(),
    { passive: false },
  );
  el.addEventListener('pointerdown', down => {
    if (down.pointerType !== 'pen' || !use(down)) return;
    const points = [pointOf(down)],
      { layer, local } = layerOver(el),
      ink = color ?? getComputedStyle(el).color;
    let moved = false;
    const draw = () =>
      (layer.innerHTML = `<svg width="1" height="1" style="position: absolute; overflow: visible" aria-hidden="true"><path d="${outline({ size: SIZE, points: points.map(p => local(p)) })}" fill="${ink}"/></svg>`);
    const move = e => {
      if (e.pointerId !== down.pointerId) return;
      moved ||= wandered(down, e);
      points.push(pointOf(e));
      if (moved) draw();
    };
    const up = e => {
      if (e.pointerId !== down.pointerId) return;
      for (const [type, f] of listeners) removeEventListener(type, f, true);
      layer.remove();
      if (moved && e.type === 'pointerup') end(points);
    };
    const listeners = [
      ['pointermove', move],
      ['pointerup', up],
      ['pointercancel', up],
    ];
    for (const [type, f] of listeners) addEventListener(type, f, true);
  });
}
const pointOf = e => [e.clientX, e.clientY, e.pressure || 0.5];

// ---- a gap opened

// The text opened at an index: the words shown split there by a gap with a caret, and the next writing goes in it.
// With the pen (hooks.keyboard false) a pad round the words takes its strokes, read once the pen rests (hooks.read(lines)
// → the words, or '' when it isn't writing) and put in at the gap, which moves on after them; lines: strokes already
// written there (client px). With a keyboard, the owner puts the caret there and the gap closes at the first key.
// A press anywhere else closes it, as does Escape. hooks: { text() (the words now), put(text) (kept as if typed),
// read, failed(err), closed(), keyboard, lines, color }. Returns { close() (a promise: done once what's written in it
// is put in), drop() (closed with what's written in it and not read yet left out) }.
export function openGap(el, at, hooks) {
  const copy = copyOf(el, { shown: true }),
    hidden = { color: el.style.color, fill: el.style.webkitTextFillColor, caret: el.style.caretColor };
  Object.assign(copy.style, { height: 'auto', minHeight: `${el.offsetHeight}px`, zIndex: 3 });
  Object.assign(el.style, { color: 'transparent', webkitTextFillColor: 'transparent', caretColor: 'transparent' });
  const gap = { el, at, copy, hooks, open: true, lines: [], timer: 0, reading: null };
  shown(gap);
  gap.pad = hooks.keyboard ? null : pad(gap);
  const outside = e => !e.composedPath().includes(gap.pad ?? copy) && close(gap);
  const key = e => {
    if (e.key !== 'Escape' && !hooks.keyboard) return;
    if (hooks.keyboard) spaced(el, e);
    close(gap);
  };
  addEventListener('pointerdown', outside, true);
  addEventListener('keydown', key, true);
  if (hooks.keyboard) el.addEventListener('blur', () => close(gap), { once: true });
  gap.unlisten = () => {
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', key, true);
    Object.assign(el.style, { color: hidden.color, webkitTextFillColor: hidden.fill, caretColor: hidden.caret });
  };
  for (const line of hooks.lines ?? [])
    written(
      gap,
      line.map(p => gap.local(p)),
    );
  return {
    close: () => close(gap),
    drop: () => {
      gap.dropped = true;
      return close(gap);
    },
  };
}
// The first letter typed in words opened gets a space either side where a word would touch it, as words written in
// do (inserted): put before the key's own letter, the caret between them, so the browser's undo takes them back too
function spaced(el, e) {
  if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.metaKey || e.altKey) return;
  const text = el.value ?? el.textContent,
    at = el.value === undefined ? caretIn(el) : el.selectionStart;
  if (at === null) return;
  const lead = /\S/.test(text[at - 1] ?? ' ') ? ' ' : '',
    trail = /\S/.test(text[at] ?? ' ') ? ' ' : '';
  if (!lead && !trail) return;
  document.execCommand('insertText', false, lead + trail);
  if (!trail) return;
  if (el.value === undefined) getSelection().modify('move', 'backward', 'character');
  else el.setSelectionRange(at + lead.length, at + lead.length);
}
// The caret's index in an element's text, or null when it isn't in it
function caretIn(el) {
  const sel = getSelection();
  if (!sel.rangeCount || !el.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.setStart(el, 0);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return range.toString().length;
}
// The words split at the gap: before it, the gap with its blinking caret, after it
function shown(gap) {
  const text = gap.hooks.text(),
    space = document.createElement('span'),
    caret = document.createElement('i');
  Object.assign(space.style, {
    display: 'inline-block',
    width: `${GAP_EM}em`,
    height: '1lh',
    verticalAlign: 'top',
    position: 'relative',
  });
  Object.assign(caret.style, {
    position: 'absolute',
    left: '0.25em',
    top: '0.1lh',
    bottom: '0.1lh',
    width: '2px',
    borderRadius: '1px',
    background: 'currentColor',
  });
  space.append(caret);
  gap.copy.replaceChildren(text.slice(0, gap.at), space, text.slice(gap.at));
  // (a caret's blink: on, then off, never fading)
  caret.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }], {
    duration: 1060,
    iterations: Infinity,
  });
  space.animate([{ width: '0' }, { width: `${GAP_EM}em` }], { duration: 160, easing: 'ease-out' });
}
// The hand's room round the words opened: the pen's strokes (or a finger's) drawn there and read once it rests; a
// mouse's press closes the gap and goes on to what's under it
function pad(gap) {
  const line = parseFloat(getComputedStyle(gap.el).lineHeight) || parseFloat(getComputedStyle(gap.el).fontSize) * 1.4,
    { layer, local } = layerOver(gap.el, line * ROOM_LINES);
  gap.local = local;
  Object.assign(layer.style, { pointerEvents: 'auto', touchAction: 'none', zIndex: 4 });
  layer.innerHTML = '<svg width="1" height="1" style="position: absolute; overflow: visible" aria-hidden="true"></svg>';
  layer.addEventListener('pointerdown', down => {
    if (down.pointerType === 'mouse') return close(gap);
    down.stopPropagation();
    down.preventDefault();
    clearTimeout(gap.timer);
    try {
      layer.setPointerCapture(down.pointerId);
    } catch {
      /* lifted already */
    }
    const points = [local(pointOf(down))],
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', gap.hooks.color ?? getComputedStyle(gap.el).color);
    layer.firstElementChild.append(path);
    const move = e => {
      if (e.pointerId !== down.pointerId) return;
      e.stopPropagation();
      points.push(local(pointOf(e)));
      path.setAttribute('d', outline({ size: SIZE, points }));
    };
    const up = e => {
      if (e.pointerId !== down.pointerId) return;
      e.stopPropagation();
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', up);
      path.remove();
      if (e.type === 'pointerup') written(gap, points);
    };
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', up);
  });
  return layer;
}
// A stroke written in the gap (the pad's px): kept on the pad, read once the pen rests. One lifted after the gap closed
// is left out: its words would land after what the gap's owner took as its last.
function written(gap, points) {
  if (!gap.open) return;
  const line = { size: SIZE, color: '#000', points };
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', outline(line));
  path.setAttribute('fill', gap.hooks.color ?? getComputedStyle(gap.el).color);
  gap.pad?.firstElementChild.append(path);
  gap.lines.push({ line, path });
  clearTimeout(gap.timer);
  gap.timer = setTimeout(() => read(gap), REST_MS);
}
// What's written in the gap read, and put in at it: the gap moves on after the words, open for more. One reading at a
// time; lines written meanwhile wait for the next.
function read(gap) {
  clearTimeout(gap.timer);
  if (gap.reading || !gap.lines.length) return gap.reading;
  const lines = gap.lines;
  gap.lines = [];
  for (const { path } of lines) path.style.opacity = '0.45';
  gap.reading = gap.hooks
    .read(lines.map(l => l.line))
    .then(
      words => {
        if (!words || !gap.el.isConnected || gap.dropped) return;
        const { text, caret } = inserted(gap.hooks.text(), gap.at, words);
        gap.hooks.put(text);
        gap.at = caret;
        if (gap.open) shown(gap);
      },
      err => gap.dropped || gap.hooks.failed?.(err),
    )
    .finally(() => {
      for (const { path } of lines) path.remove();
      gap.reading = null;
      if (gap.lines.length && !gap.dropped) read(gap);
    });
  return gap.reading;
}
// The gap closed: its pad takes no more strokes, and what's written and not read yet is read and put in first (unless
// it's dropped); the words shown whole again. Closed again while that's under way, the same wait.
function close(gap) {
  if (!gap.open) return gap.closing;
  gap.open = false;
  gap.unlisten();
  gap.copy.remove();
  if (gap.pad) gap.pad.style.pointerEvents = 'none';
  gap.closing = (async () => {
    while (!gap.dropped && (gap.lines.length || gap.reading)) await read(gap);
    gap.pad?.remove();
    gap.hooks.closed?.();
  })();
  return gap.closing;
}

// ---- a layer over words

// A layer laid over an element, grown by some px of its own each way, in the element's box (so a page's zoom and a
// post-it's tilt carry it): { layer, local(point) } (local: a client px point in the layer's px, pressure kept)
function layerOver(el, grow = 0) {
  const layer = document.createElement('div');
  Object.assign(layer.style, {
    position: 'absolute',
    left: `${el.offsetLeft}px`,
    top: `${el.offsetTop}px`,
    width: `${el.offsetWidth + 2 * grow}px`,
    height: `${el.offsetHeight + 2 * grow}px`,
    zIndex: 3,
    pointerEvents: 'none',
  });
  el.after(layer);
  const k = overlay(layer, el, grow);
  const local = ([x, y, ...rest]) => {
    const r = layer.getBoundingClientRect();
    return [(x - r.left) / k, (y - r.top) / k, ...rest];
  };
  return { layer, local };
}
