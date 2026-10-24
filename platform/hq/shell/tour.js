// The showcase tour: the building assembles, then the camera glides stop to stop with title cards.
import { esc } from '../util.js';
import { sfx } from './audio.js';
import * as world from '../world/world.js';
import { scene } from './stage.js';
import { closePanel } from './panel.js';
import { syncHud } from './hud.js';
import { brand, names } from './brand.js';

const card = document.querySelector('#card');
let tour = null;
export const touring = () => !!tour;

// the whole company, then the scene's stops (and round again: the company's card comes once a loop, not twice in a row)
export function startTour() {
  closePanel();
  const show = scene.showcase(true),
    home = { target: { kind: 'home' }, hold: 5, title: `${brand.name} ${names.hq}` };
  tour = {
    stops: [{ ...home, sub: 'Run by AI agents, live all day and all night' }, ...show.stops],
    i: -1,
    t: show.lead,
  };
  document.body.classList.add('touring');
}
// a stop the scene can't frame (a mascot it doesn't draw) is skipped
function nextTour() {
  let s;
  do {
    tour.i = (tour.i + 1) % tour.stops.length;
    s = tour.stops[tour.i];
  } while (!scene.focus(s.target));
  tour.t = s.hold;
  card.innerHTML = `<b>${esc(s.title)}</b>${s.sub ? `<span>${esc(s.sub)}</span>` : ''}`;
  card.classList.remove('show');
  void card.offsetWidth;
  card.classList.add('show');
  sfx.whoosh();
}
export function stopTour() {
  if (!tour) return;
  tour = null;
  document.body.classList.remove('touring');
  card.classList.remove('show');
  syncHud();
  scene.showcase(false);
}
export function step(dt) {
  if (tour && (tour.t -= dt) <= 0) nextTour();
}
