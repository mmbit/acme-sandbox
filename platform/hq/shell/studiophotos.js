// The photo studio's photos as Photos (studio.js) shows them: what it last read from the coordinator, and the words and
// pictures of a photo. Everything from the coordinator is shown as text, a picture only as an <img>.
import { esc, MONTHS } from '../util.js';
import { studioPicture } from './data.js';
import { noise } from './audio.js';
import * as world from '../world/world.js';

// studio: the last GET /api/studio. tab: 'approvals', 'queue' or 'history' (null until the screen opens). current: the
// photo Approvals shows. open: the approved photo History shows big, else null. side: the picture shown big ('original'
// or 'edited'). query: History's search. changing: History's "This should change" note is open. lines: a photo's id →
// what went wrong, under it (its own part: the field above it stays as typed).
// repaint(el) reads the studio again and draws the screen, render(el) draws it from what it has (studio.js sets both).
export const screen = {
  studio: null,
  who: id => id,
  tab: null,
  current: null,
  open: null,
  side: 'edited',
  query: '',
  changing: false,
  lines: new Map(),
  repaint: async () => {},
  render: () => {},
};

export const SIDE = { original: 'Original', edited: 'Edit' };
// the darkroom's safelight, on while a photo develops
export const LIGHT = '<i class="sd-light" aria-hidden="true"></i>';

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// waiting for the board, oldest first: the order Approvals shows them in
export const waitingOf = studio => studio.photos.filter(p => p.status === 'waiting').reverse();
export const photoOf = id => screen.studio.photos.find(p => p.id === id);
// a product's name in the company's settings, else its id
export const nameIn = (list, id) => list.find(x => x.id === id)?.name ?? id;
// the photo's product, by name
export const whatHtml = p => `<b>${esc(nameIn(screen.studio.products, p.product))}</b>`;
export const lineHtml = key =>
  screen.lines.has(key) ? `<p class="sd-msg" role="status">${esc(screen.lines.get(key))}</p>` : '';
export const keeperHtml = () => esc(screen.who(screen.studio.keeper));
export const dayOf = time => {
  const d = new Date(time);
  return isNaN(d) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
export const pictureHtml = (p, side) =>
  `<img src="${esc(studioPicture(world.dev, p, side))}" alt="" loading="lazy" decoding="async" data-img="${side}">`;

// a camera's shutter, its blades opening and closing
export function shutter(at = 0) {
  noise(0.025, { vol: 0.09, freq: 3400, at });
  noise(0.045, { vol: 0.07, freq: 1300, at: at + 0.055 });
}

// One of the board's sends about photo p (Accept, Reject, This should change): buttons off while it goes,
// done() once the coordinator has it; a refusal goes on the photo's line, the buttons back on and what the board typed
// left as it is. The screen reads the studio again either way.
export async function send(el, p, buttons, action, done) {
  buttons.forEach(b => (b.disabled = true));
  try {
    await action();
    screen.lines.delete(p.id);
    done();
  } catch (e) {
    buttons.forEach(b => (b.disabled = false));
    screen.lines.set(p.id, e.message);
  }
  screen.repaint(el);
}
