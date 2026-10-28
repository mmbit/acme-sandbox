// Ink's preferences, per device (this browser's own, never synced: a desk's mouse and an iPad's Pencil want different
// things): whether a finger always pans once a pen is in use, whether the pen's long press opens the radial menu, and
// how long a hold takes to start a voice note. The Notebook's cog sets them (platform/hq/shell/ink/bookprefs.js); review
// mode's pen reads the hold (pentouch.js). No imports, so the book loads it alone.

const KEY = 'ink.prefs';
// The voice note's hold, as the board named them
export const HOLDS = { short: 500, medium: 750, long: 1000 };
export const DEFAULTS = { penPans: false, radial: false, hold: 'medium' };
// (the last set, for a browser that keeps nothing: private mode)
let here = {};

// The preferences now: what this browser keeps, each one its default where it keeps none (or one it doesn't know)
export function prefs() {
  let saved = here;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? here;
  } catch {
    /* private mode, or a broken value */
  }
  return {
    penPans: typeof saved.penPans === 'boolean' ? saved.penPans : DEFAULTS.penPans,
    radial: typeof saved.radial === 'boolean' ? saved.radial : DEFAULTS.radial,
    hold: saved.hold in HOLDS ? saved.hold : DEFAULTS.hold,
  };
}
// One or more changed, kept, and told to whoever listens on this page
export function setPrefs(change) {
  const now = (here = { ...prefs(), ...change });
  try {
    localStorage.setItem(KEY, JSON.stringify(now));
  } catch {
    /* private mode: for this page only */
  }
  dispatchEvent(new CustomEvent('ink:prefs', { detail: now }));
  return now;
}
// How long a still press takes to become a voice note (ms)
export const holdMs = () => HOLDS[prefs().hold];
