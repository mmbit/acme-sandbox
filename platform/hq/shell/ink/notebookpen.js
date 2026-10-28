// A Notebook drawing area that keeps input immediate while each stroke is saved.
import { draw } from '/__review/ink.js';

export function mountPen(canvas, save, owner) {
  const s = { canvas, save, owner, scope: null, context: canvas.getContext('2d'), stroke: null, lines: [] };
  const listeners = {
    pointerdown: event => begin(s, event),
    pointermove: event => move(s, event),
    pointerup: () => end(s),
    pointercancel: () => {
      s.stroke = null;
      redraw(s);
    },
  };
  for (const [name, listener] of Object.entries(listeners)) canvas.addEventListener(name, listener);
  resize(s);
  return {
    resize: () => resize(s),
    clear: () => {
      s.lines = [];
      s.stroke = null;
      redraw(s);
    },
    destroy() {
      for (const [name, listener] of Object.entries(listeners)) canvas.removeEventListener(name, listener);
    },
  };
}

function resize(s) {
  s.canvas.width = 1000;
  s.canvas.height = 440;
  redraw(s);
}
function redraw(s) {
  s.context.clearRect(0, 0, s.canvas.width, s.canvas.height);
  draw(s.context, [...s.lines, ...(s.stroke ? [s.stroke] : [])]);
}
function point(s, event) {
  const box = s.canvas.getBoundingClientRect();
  return [
    ((event.clientX - box.left) * s.canvas.width) / box.width,
    ((event.clientY - box.top) * s.canvas.height) / box.height,
    event.pressure || 0.5,
    event.timeStamp,
  ];
}
function begin(s, event) {
  if (!event.isPrimary || event.button !== 0 || s.stroke) return;
  event.preventDefault();
  s.canvas.setPointerCapture(event.pointerId);
  s.scope = s.owner();
  s.stroke = { color: '#292722', size: 3, alpha: 1, points: [point(s, event)] };
  redraw(s);
}
function move(s, event) {
  if (!s.stroke) return;
  const coalesced = event.getCoalescedEvents?.() ?? [];
  const events = coalesced.length ? coalesced : [event];
  s.stroke.points.push(...events.map(event => point(s, event)));
  redraw(s);
}
function end(s) {
  if (!s.stroke) return;
  const finished = s.stroke;
  s.lines.push(finished);
  s.stroke = null;
  s.save([finished], s.scope)
    .then(() => {
      redraw(s);
    })
    .catch(error => {
      s.canvas.closest('.ng-book').querySelector('.ng-error').textContent = error.message;
    });
}
