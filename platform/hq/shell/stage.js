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
import { pageWidth, onPageResize } from './page.js';

// Every renderer HQ ships, as the server reads their folders (looks.mjs): [{ name, dressed }]. theme/hq.yaml picks the
// company's, a viewer may pick another. A dressed look dresses the shell to match: its UI (renderers/<name>/skin.css
// over style.css) and its sounds (renderers/<name>/sounds.js). Each says its style in its scene.js (`style`: pixel, line
// or any).
export const looks = fetch('renderers/looks.json').then(r => {
  if (!r.ok) throw new Error(`HQ's list of looks didn't load: HTTP ${r.status}`);
  return r.json();
});
// look: the renderer on stage, by name; dressed: whether it dresses the shell
export let cv = document.querySelector('#world'), scene, look, dressed;
export const pointed = { selected: null, hover: null }; // the agent to ring: whose panel is open, or under the mouse
export let paused = false; // dev: tests hold the loop and drive frames themselves
export const pause = on => { paused = on; };
// The preview viewer fills the screen over the stage: nothing behind it updates or draws until it closes, as with the
// tab hidden (the scene's resizes go on). by: what covers it (the viewer, the call player, the projects view), so one
// closing leaves the stage under another covered. Under the projects view alone the scene still updates, so what the
// world's events start plays out and ends on time, and only its drawing waits. (by, the projects view)
const covers = new Set();
export const cover = (on, by) => { covers[on ? 'add' : 'delete'](by); };
let now = 0, timers = new Set(); // timers: the timeouts for the scene on stage (its shell.later), dropped with it
const timer = set => (fn, ms) => { const id = setTimeout(() => { set.delete(id); fn(); }, ms); set.add(id); };
// the shell's own timeout for the scene on stage now: a swap drops it too
export const later = (fn, ms) => timer(timers)(fn, ms);

// A renderer on the stage, at boot or as a hot swap (the world stays, only the scene is new): a fresh canvas (a 2d
// one can't become WebGL) and scene, swapped in for the old ones once it's made. A swap that fails keeps the old
// scene (false); at boot it throws. intro: the scene opens with its intro (at boot).
export async function mount(name, intro = false) {
  const next = cv.cloneNode(), mine = new Set(), entry = (await looks).find(l => l.name === name);
  next.removeAttribute('style'); // (where the last scene placed its canvas)
  const sound = { play: audio.play, weather: audio.setWeather, ready: audio.ready };
  let kit, links = [], fresh, sounds, style;
  try {
    if (!entry) throw new Error(`HQ has no renderer called ${name}`);
    kit = kitOf(name); links = skin(entry, kit);
    let sceneModule;
    [sceneModule, sounds] = await Promise.all([
      import(`../renderers/${name}/scene.js`),
      wornSounds(entry.dressed ? import(`../renderers/${name}/sounds.js`) : {}, kit),
      ...links.map(loaded),
    ]);
    style = sceneModule.style;
    fresh = await sceneModule.createScene({ canvas: next, world, brand, settings: { ...theme[name], intro }, shell: { sound, toast, card: overlay.card, tap: press, chrome, store, later: timer(mine) } });
  } catch (e) {
    links.forEach(l => l.remove());
    if (!scene) throw e;
    console.error('HQ could not switch the view:', e);
    toast(`<b>That view didn't load.</b> Staying with this one.`);
    return false;
  }
  document.querySelectorAll('link:is([data-skin], [data-kit])').forEach(l => !links.includes(l) && l.remove());
  if (scene) {
    tour.stopTour(); scene.dispose();
    for (const id of timers) clearTimeout(id);
    bindCanvas(next);
  }
  cv.replaceWith(next); cv = next; scene = fresh; timers = mine; look = name; dressed = entry.dressed;
  wearIcons(style, kit);
  // (the look worn, its skin loaded and its agents placed: for what takes its tones from HQ's page, the book's table, and
  // its faces, the answers' (bookanswers.js).)
  document.dispatchEvent(new CustomEvent('stage:look', { detail: { look: name } }));
  audio.wear(sounds);
  resize(); scene.focus({ kind: 'home' }, { instant: true });
  bindControls();
  return true;
}
// A look's skin, linked beside the one worn now (which goes when the scene swaps, so the UI is never bare): its <link>s,
// none for a look without a skin or a kit. The look's own skin.css, then the kit the company dresses it in (the kit's
// hq/style.css, served at /kits/<kit>/), laid over it. (the kit)
function skin(entry, kit) {
  const sheets = [entry.dressed && ['skin', `renderers/${entry.name}/skin.css`], kit && ['kit', `/kits/${kit}/style.css`]];
  return sheets.filter(Boolean).map(([as, href]) => {
    const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
    l.dataset[as] = entry.name;
    document.head.append(l);
    return l;
  });
}
// (our own sheets: a look's fonts from Google come on links of their own, which nothing waits for.)
const loaded = l => new Promise((done, fail) => { l.onload = done; l.onerror = () => fail(new Error(`${l.href} didn't load`)); });
// The kit the company dresses a look in (theme/hq.yaml <look>.kit), its stylesheet, icons and sounds; null for none
//
function kitOf(name) {
  const kit = theme[name]?.kit ?? null;
  if (kit !== null && !(typeof kit === 'string' && KIT.test(kit))) throw new Error(`hq.yaml: ${name}.kit, ${JSON.stringify(kit)}, isn't a kit's name`);
  return kit;
}
const KIT = /^[a-z0-9][a-z0-9-]*$/; // (a kit's folder, as the servers' /kits/<kit>/ route takes it)
// A look's sounds (own: its sounds.js, as it loads) with its kit's laid over them: every kit that dresses a look ships
// hq/sounds.js, which gives MOMENTS (a moment's [[sound, params], ...] of the platform's sound kit, /foley.js, each with
// its own vol and delay) and HQ (HQ's sound name, then the moment it plays or a function of the sound's arguments giving
// its calls; {} for none).
async function wornSounds(own, kit) {
  if (!kit) return own;
  const [look, { MOMENTS, HQ }] = await Promise.all([own, import(`/kits/${kit}/sounds.js`)]);
  const play = calls => calls.forEach(([sound, { vol = 1, delay = 0, vary: _, ...params }]) => audio.foley(sound, params, { vol, at: delay }));
  const worn = Object.entries(HQ).map(([name, moment]) => [name, (...a) => play(typeof moment === 'function' ? moment(...a) : MOMENTS[moment])]);
  return { ...look, sfx: { ...look.sfx, ...Object.fromEntries(worn) } };
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
onPageResize(() => { for (const side in insets) delete insets[side]; hudBottom = null; });
new ResizeObserver(() => { hudBottom = null; }).observe(tools);
const inset = side => insets[side] ??= parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sa' + side)) || 0;
// top: the HUD; bottom: the safe area; panel: open, a side panel (wide) or a bottom sheet, its width and share
export const chrome = () => ({ top: (hudBottom ??= tools.getBoundingClientRect().bottom) + HUD_GAP, bottom: inset('b'), panel: { open: !!panelOpen(), wide: pageWidth() > WIDE, right: PANEL_W, share: SHEET } });

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
export function resize() { scene.resize(pageWidth(), viewHeight(), Math.min(devicePixelRatio || 1, 2)); }

// ---------------------------------------------------------------- loop
let last = 0, acc = 0, cost = 8;
export function loop(t) {
  requestAnimationFrame(loop);
  // (a look's own key out big over a cover, an agent's card over the projects view, draws on)
  const held = covers.size && !scene?.carded?.();
  if (document.hidden || paused || (held && [...covers].some(by => by !== 'projects'))) { last = t; return; }
  const dt = Math.min(0.1, (t - last) / 1000 || 0);
  last = t; acc += dt;
  // 60 fps when the device keeps up, 30 when it doesn't: kind to tablets, smooth for recordings
  if (acc < (cost > 12 ? 1 / 32 : 1 / 64)) return;
  const t0 = performance.now();
  step(acc); acc = 0;
  if (held) return;
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
// A screenshot about to copy the stage's canvas: a frame drawn now, as a WebGL look's last one is gone once shown
document.addEventListener('snapshot:draw', e => { if (e.target === cv && scene) scene.draw(now); }, true);
// dev: one frame at time t, with the loop held
export function frame(t) { step(0); now = t; draw(); }
