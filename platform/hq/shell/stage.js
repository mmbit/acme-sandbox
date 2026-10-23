// The stage: the canvas and its scene, what the shell's chrome covers, the screen's size, and the frame loop.
import { store, cap } from '../util.js';
import * as world from '../world/world.js';
import * as audio from './audio.js';
import * as overlay from './overlay.js';
import * as tour from './tour.js';
import { bindCanvas, press } from './input.js';
import { toast, bindControls } from './hud.js';
import { panelOpen } from './panel.js';
import { brand, theme } from './brand.js';
import { wearIcons } from './icons.js';

// Every renderer HQ ships (renderers/<name>/scene.js): theme/hq.yaml picks the company's, a viewer may pick another.
// (soft, glass, paper and ring are archived on the branch archive/looks-six.)
export const RENDERERS = ['brownstone', 'holo', 'wire'];
// The looks that dress the shell to match: its UI (renderers/<name>/skin.css over style.css) and its sounds
// (renderers/<name>/sounds.js over the chiptune). The others wear its pixel art and play its chiptune.
const DRESSED = new Set(['holo', 'wire']);
export const dressed = name => DRESSED.has(name);
export let cv = document.querySelector('#world'), scene, look; // look: the renderer on stage, by name
export const pointed = { selected: null, hover: null }; // the agent to ring: whose panel is open, or under the mouse
export let paused = false; // dev: tests hold the loop and drive frames themselves
export const pause = on => { paused = on; };
// The preview viewer fills the screen over the stage: nothing behind it updates or draws until it closes, as with the
// tab hidden (the scene's resizes go on).
let covered = false;
export const cover = on => { covered = on; };
let now = 0, timers = new Set(); // timers: the timeouts for the scene on stage (its shell.later), dropped with it
const timer = set => (fn, ms) => { const id = setTimeout(() => { set.delete(id); fn(); }, ms); set.add(id); };
// the shell's own timeout for the scene on stage now: a swap drops it too
export const later = (fn, ms) => timer(timers)(fn, ms);

// A renderer on the stage, at boot or as a hot swap (the world stays, only the scene is new): a fresh canvas (a 2d
// one can't become WebGL) and scene, swapped in for the old ones once it's made. A swap that fails keeps the old
// scene (false); at boot it throws. intro: the scene opens with its intro (at boot).
export async function mount(name, intro = false) {
  const next = cv.cloneNode(), mine = new Set(), dress = skin(name);
  next.removeAttribute('style'); // (where the last scene placed its canvas)
  const sound = { play: (sfx, ...a) => audio.sfx[sfx](...a), weather: audio.setWeather, ready: audio.ready };
  let fresh, sounds;
  try {
    if (!RENDERERS.includes(name)) throw new Error(`HQ has no renderer called ${name}`);
    const { createScene } = await import(`../renderers/${name}/scene.js`);
    sounds = DRESSED.has(name) ? await import(`../renderers/${name}/sounds.js`) : {};
    fresh = await createScene({ canvas: next, world, brand, settings: { ...theme[name], intro }, shell: { sound, toast, card: overlay.card, tap: press, chrome, store, later: timer(mine) } });
  } catch (e) {
    dress.then(l => l?.remove());
    if (!scene) throw e;
    console.error('HQ could not switch the view:', e);
    toast(`<b>That view didn't load.</b> Staying with this one.`);
    return false;
  }
  const worn = await dress;
  document.querySelectorAll('link[data-skin]').forEach(l => l !== worn && l.remove());
  if (scene) {
    tour.stopTour(); scene.dispose();
    for (const id of timers) clearTimeout(id);
    bindCanvas(next);
  }
  cv.replaceWith(next); cv = next; scene = fresh; timers = mine; look = name;
  wearIcons(name);
  audio.wear(sounds);
  resize(); scene.focus({ kind: 'home' }, { instant: true });
  bindControls();
  return true;
}
// A look's skin, loading beside the one worn now (which goes when the scene swaps, so the UI is never bare): its <link>
// once it has loaded (or failed to), null for a look without one.
function skin(name) {
  if (!DRESSED.has(name)) return Promise.resolve(null);
  const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `renderers/${name}/skin.css` });
  l.dataset.skin = name;
  document.head.append(l);
  return new Promise(done => { l.onload = l.onerror = () => done(l); });
}
// The look a viewer picks in Settings, on stage now and kept on this device for their next visit; null: the company's
// (theme.renderer), whichever that is then.
export async function pick(name) {
  if ((name ?? theme.renderer) === look || await mount(name ?? theme.renderer)) store.set('renderer', name);
}
// A renderer's name for people (its info.name)
export const lookName = name => import(`../renderers/${name}/scene.js`).then(m => m.info.name, () => cap(name));

// ---------------------------------------------------------------- what the shell covers (CSS px)
const HUD_GAP = 10, PANEL_W = 420, SHEET = 0.72, WIDE = 700; // and the sheet's share of a phone screen
// Read once per change, not every frame (that forces a style recalculation or a layout): the safe-area insets (CSS px,
// side t/b/l/r) from the custom properties style.css sets, and the bottom of the HUD's tools (safe area included),
// measured: on a phone they wrap to a second row, and the tour hides most of them. (The brand plate in the corner may
// hang a little lower; scenes frame below the tools.)
const insets = {}, tools = document.querySelector('#hud .tools');
let hudBottom = null;
addEventListener('resize', () => { for (const side in insets) delete insets[side]; hudBottom = null; });
new ResizeObserver(() => { hudBottom = null; }).observe(tools);
const inset = side => insets[side] ??= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sa' + side)) || 0;
// top: the HUD; bottom: the safe area; panel: open, a side panel (wide) or a bottom sheet, its width and share
export const chrome = () => ({ top: (hudBottom ??= tools.getBoundingClientRect().bottom) + HUD_GAP, bottom: inset('b'), panel: { open: !!panelOpen(), wide: innerWidth > WIDE, right: PANEL_W, share: SHEET } });

// A home-screen app on iOS reports a viewport one status bar too short, leaving the bottom of the screen empty.
// When it fills the screen, the screen's own size is the true one. --app-h hands it to the CSS, which places
// the bottom controls from the top with it (iOS isn't consistent about where the bottom of the viewport is).
function viewHeight() {
  const [a, b] = [screen.width, screen.height].sort((x, y) => x - y), portrait = innerHeight > innerWidth;
  const full = navigator.standalone && innerWidth === (portrait ? a : b);
  const h = full ? Math.max(innerHeight, portrait ? b : a) : innerHeight;
  document.documentElement.style.setProperty('--app-h', `${h}px`);
  return h;
}
export function resize() { scene.resize(innerWidth, viewHeight(), Math.min(devicePixelRatio || 1, 2)); }

// ---------------------------------------------------------------- loop
let last = 0, acc = 0, cost = 8;
export function loop(t) {
  requestAnimationFrame(loop);
  if (document.hidden || paused || covered) { last = t; return; }
  const dt = Math.min(0.1, (t - last) / 1000 || 0);
  last = t; acc += dt;
  // 60 fps when the device keeps up, 30 when it doesn't: kind to tablets, smooth for recordings
  if (acc < (cost > 12 ? 1 / 32 : 1 / 64)) return;
  const t0 = performance.now();
  step(acc); acc = 0;
  draw();
  cost = cost * 0.95 + (performance.now() - t0) * 0.05;
}
// In this order: the tour's next stop draws after the scene's update (its whoosh uses Math.random); the scene
// moves its camera when it draws, so a new stop starts its move this frame.
function step(dt) {
  now += dt;
  world.tick(dt);
  scene.update(dt);
  overlay.step(dt);
  tour.step(dt);
}
function draw() {
  const id = [pointed.selected, pointed.hover].find(x => world.agents.has(x));
  scene.highlight(id ? { kind: 'agent', id } : null);
  scene.draw(now);
  overlay.draw();
}
// dev: one frame at time t, with the loop held
export function frame(t) { step(0); now = t; draw(); }
