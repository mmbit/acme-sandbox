// Ink's preferences, per device (this browser's own, never synced: a desk's mouse and an iPad's Pencil want different
// things): whether a finger always pans (off on a new device, so a finger draws; on by itself the first time a pen is
// used on a page that loads this file, penUsed(), and after that only the board's), whether the pen's long press opens
// the radial menu, and how long a hold takes to start a voice note. The Notebook's cog sets them
// (platform/hq/shell/ink/bookprefs.js). Review mode's pen reads the hold (pentouch.js), its finger whether it pans
// (surface.js). No imports, so the book loads it alone.

const KEY = 'ink.prefs';
// The voice note's hold, as the board named them
export const HOLDS = { short: 500, medium: 750, long: 1000 };
// (only what was set kept; penPans off till a pen is used)
export const DEFAULTS = { penPans: false, radial: false, hold: 'medium' };
// (the last set, for a browser that keeps nothing: private mode)
let here = {};

// What this browser keeps: only what was set here, so a default changed later reaches every device that never set it
function kept() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? here;
  } catch {
    return here; /* private mode, or a broken value */
  }
}
// The preferences now: what this browser keeps, each one its default where it keeps none (or one it doesn't know)
export function prefs() {
  const saved = kept();
  return {
    penPans: typeof saved.penPans === 'boolean' ? saved.penPans : DEFAULTS.penPans,
    radial: typeof saved.radial === 'boolean' ? saved.radial : DEFAULTS.radial,
    hold: saved.hold in HOLDS ? saved.hold : DEFAULTS.hold,
  };
}
// One or more changed, kept, and told to whoever listens on this page
export function setPrefs(change) {
  here = { ...kept(), ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(here));
  } catch {
    /* private mode: for this page only */
  }
  const now = prefs();
  dispatchEvent(new CustomEvent('ink:prefs', { detail: now }));
  return now;
}
// A pen used on this device: the first time, and only then, a finger always pans (a value kept from before, too, so
// one an older Notebook saved with any change gives way); turned off after that, it stays off. Heard on any page that
// loads this module: HQ, a guest's notebook, review mode on a preview, one listener.
function penUsed() {
  if (!kept().penSeen) setPrefs({ penSeen: true, penPans: true });
}
addEventListener('pointerdown', e => e.pointerType === 'pen' && penUsed(), true);
// How long a still press takes to become a voice note (ms)
export const holdMs = () => HOLDS[prefs().hold];
