// board.js: the soundboard, a phone-first page to hear the palette in use: every sound, every tuning and the beds.
//   import './sound.js'; import { board } from './board.js'; board({ at, storageKey: 'myapp:soundboard', ... })
// The page brings its own words and colours through the settings and board.css's custom properties (README.md).
import { foley, palette, tune } from './engine.js';

// -15 dB puts a -16 LUFS bed about 12 LU under a palette's success sound, as mix.mjs sets it in an ad
const BED_GAIN = 0.18;

const DEFAULTS = {
  mute: null, // the mute button; by default the page's #mute
  tuningAbout: {}, // { tuning: a short line under its name }
  beds: {}, // { bed: what it is }, played from `${bedFolder}${bed}-${tuning}.mp3`
  bedFolder: './beds/',
  bedTitle: 'Beds',
  tuneSound: null, // a palette sound played when a tuning is picked
  unmuteSound: null, // a palette sound played when the sound comes back on
  soundOn: 'Sound on',
  soundOff: 'Sound off',
};

let settings = DEFAULTS, sfx = null, params = {}, tuningName = null;
const bed = { name: null, source: null, ticket: 0 }, decoded = new Map();

// Builds the soundboard in `at` and returns the player. The tiles and switches carry the hooks the sound check drives:
// [data-sound], [data-tuning] and [data-bed] (with aria-pressed), #mute, window.sfx, window.lastPlay, window.lastTuning.
export function board(boardSettings) {
  settings = { ...DEFAULTS, ...boardSettings };
  if (!settings.at) throw new Error('board() needs `at`, the element to build the soundboard in');
  if (!settings.storageKey) throw new Error('board() needs `storageKey`, where the mute choice is kept');
  if (!palette()) throw new Error('no palette in use: import one (it calls use()) before board()');
  sfx = window.sfx = foley({ key: settings.storageKey });
  bindMute(settings.mute ?? document.getElementById('mute'));
  settings.at.classList.add('soundboard');
  settings.at.append(tuningSwitch(), ...soundGroups(), ...bedGroup());
  pick(Object.keys(palette().tunings)[0]);
  return sfx;
}

function bindMute(button) {
  sfx.bind(button, { on: settings.soundOn, off: settings.soundOff, confirm: false });
  sfx.onchange(muted => {
    if (muted) stopBed();
    else if (settings.unmuteSound) sfx.play(settings.unmuteSound, params);
  });
}

// ---- the tuning
function tuningSwitch() {
  const row = document.createElement('div'), names = Object.keys(palette().tunings);
  row.className = 'tunings'; row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'Tuning');
  row.style.setProperty('--tunings', names.length);
  for (const name of names) {
    const button = document.createElement('button'), about = document.createElement('small');
    button.type = 'button'; button.dataset.tuning = name;
    about.textContent = settings.tuningAbout[name] ?? '';
    button.append(name, about);
    button.onclick = () => {
      pick(name);
      if (settings.tuneSound) sfx.play(settings.tuneSound, params);
    };
    row.append(button);
  }
  return row;
}

// tune() sets every sound's defaults and loudness trim. The same params go with each play too, because the player
// keeps rendered takes by their call params and would otherwise replay the last tuning's takes. The tuning's name goes
// with them: two tunings can differ by their trim alone, which the player's key doesn't see.
function pick(name) {
  const { trim, ...tuned } = tune(name);
  params = { ...tuned, tuning: name }; tuningName = window.lastTuning = name;
  for (const button of settings.at.querySelectorAll('[data-tuning]')) button.setAttribute('aria-pressed', String(button.dataset.tuning === name));
  if (bed.name) playBed(bed.name); // a playing bed follows the new key
}

// ---- the sounds, grouped under their role's `group` heading, the groups in the order the roles first name them
function soundGroups() {
  const { sounds, roles } = palette(), groups = new Map();
  for (const [roleName, role] of Object.entries(roles)) {
    const heading = role.group ?? roleName;
    if (!groups.has(heading)) groups.set(heading, []);
  }
  for (const [name, sound] of Object.entries(sounds)) {
    const role = roles[sound.role];
    groups.get(role.group ?? sound.role).push(soundTile(name, sound, role));
  }
  const filled = [...groups].filter(([, tiles]) => tiles.length);
  return filled.flatMap(([heading, tiles]) => group(heading, tiles));
}

function soundTile(name, sound, role) {
  const button = tile(name, (sound.about ?? '').split(';')[0], role.wide);
  button.dataset.sound = name;
  button.onclick = () => {
    const lead = window.lastPlay = sfx.play(name, params);
    if (lead != null) setTimeout(() => give(button), lead * 1000); // the tile gives on the sound's hit
  };
  return button;
}

const give = button => { button.classList.remove('hit'); void button.offsetWidth; button.classList.add('hit'); }; // the reflow restarts the animation

// ---- the beds: quiet loops in the current tuning's key, played through the player's output so mute silences them
function bedGroup() {
  const tiles = Object.entries(settings.beds).map(([name, about]) => {
    const button = tile(name, about, true);
    button.dataset.bed = name; button.setAttribute('aria-pressed', 'false');
    button.onclick = () => (bed.name === name ? stopBed() : playBed(name));
    return button;
  });
  return tiles.length ? group(settings.bedTitle, tiles) : [];
}

function stopBed() {
  try { bed.source?.stop(); } catch { /* never started */ }
  bed.source = bed.name = null; bed.ticket++;
  showBed();
}

async function playBed(name) {
  stopBed();
  const context = sfx.context, ticket = bed.ticket;
  if (sfx.muted || !context) return;
  const url = `${settings.bedFolder}${name}-${tuningName}.mp3`;
  if (!decoded.has(url)) decoded.set(url, fetch(url).then(response => response.arrayBuffer()).then(bytes => context.decodeAudioData(bytes)));
  let buffer;
  try { buffer = await decoded.get(url); } catch (err) { console.error(`soundboard: could not load ${url}:`, err.message); return; }
  if (ticket !== bed.ticket) return; // stopped, muted or another bed picked while it loaded
  const source = context.createBufferSource(), gain = context.createGain();
  source.buffer = buffer; source.loop = true; gain.gain.value = BED_GAIN;
  source.connect(gain).connect(sfx.output); source.start();
  Object.assign(bed, { name, source });
  showBed();
}

const showBed = () => { for (const button of settings.at.querySelectorAll('[data-bed]')) button.setAttribute('aria-pressed', String(button.dataset.bed === bed.name)); };

// ---- tiles and groups, shared by the sounds and the beds
function group(heading, tiles) {
  const title = document.createElement('h2'), grid = document.createElement('div');
  title.textContent = heading;
  grid.className = 'grid'; grid.style.setProperty('--cols', tiles.length % 3 ? 4 : 3);
  grid.append(...tiles);
  return [title, grid];
}

function tile(name, about, wide) {
  const button = document.createElement('button'), title = document.createElement('b'), line = document.createElement('span');
  button.type = 'button'; button.className = wide ? 'tile wide' : 'tile';
  title.textContent = name; line.textContent = about;
  button.append(document.createElement('i'), title, line);
  return button;
}
