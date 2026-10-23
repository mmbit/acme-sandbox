// Visitors and visits without cookies: a daily-salted hash of address and browser, kept for that day only.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const IDLE_MS = 30 * 60_000;
const SAVE_MS = 15_000;
// The day's file is written whole every SAVE_MS, so it stays small enough to write in a few milliseconds: at most
// FILE_BYTES, each hash taking ENTRY_BYTES (`"<22 characters>":<13-digit ms>,`). Past MOST_HASHES (about 100,000, far
// beyond a real day of ours), new hashes count nothing, and the log says so once that day.
const FILE_BYTES = 4 * 1024 * 1024;
const ENTRY_BYTES = 40;
export const MOST_HASHES = Math.floor(FILE_BYTES / ENTRY_BYTES);
type Headers = Record<string, string | string[] | undefined>;
type DayList = { day: string; salt: string; seen: Map<string, number> };

// The address Caddy saw: it sets X-Forwarded-For itself (it trusts no proxy before it), so the last entry is its own.
const address = (h: Headers) =>
  String(h['x-forwarded-for'] ?? '')
    .split(',')
    .pop()!
    .trim();
const firstValue = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

// A deploy stops the container with SIGTERM: the list is saved first. Registered before metrics.setup()'s own handler
// (which pushes, then exits), so with that one waiting this one leaves the exit to it; alone (an app that counts
// without setup()), it raises the signal again once it's done, and Node ends the process as it would have.
function saveOnStop(save: () => void) {
  process.once('SIGTERM', () => {
    save();
    if (!process.listenerCount('SIGTERM')) process.kill(process.pid, 'SIGTERM');
  });
}

// day: the day at a moment, as the kit dates its counts (metrics.ts's day), which turns the list over
export function visitors(options: { file?: string | null; day: (at?: number) => string }) {
  const { day } = options;
  let today = load(options.file, day);
  let timer: ReturnType<typeof setTimeout> | null = null,
    savedAtMs = 0,
    fullOn = '';

  const save = () => {
    timer = null;
    savedAtMs = Date.now();
    if (options.file && today) write(options.file, today);
  };
  const saveSoon = () => {
    if (!timer) (timer = setTimeout(save, Math.max(0, savedAtMs + SAVE_MS - Date.now()))).unref();
  };
  // A new day: yesterday's salt and list replaced at once, whether anyone comes or not
  const turn = (now = Date.now()) => {
    if (today?.day === day(now)) return today;
    today = fresh(day(now));
    save();
    return today;
  };
  turn();
  setInterval(turn, 60_000).unref();
  saveOnStop(save);

  return {
    // Whether this page load is a new visitor today and a new visit. now: for tests.
    see(headers: Headers, now = Date.now()) {
      const list = turn(now);
      const hash = createHmac('sha256', list.salt)
        .update(`${address(headers)}\n${firstValue(headers['user-agent'])}`)
        .digest('base64url')
        .slice(0, 22);
      const last = list.seen.get(hash);
      if (last === undefined && list.seen.size >= MOST_HASHES) {
        if (fullOn !== list.day)
          console.error(`visitors: ${MOST_HASHES} hashes on ${list.day}, the day's most: new visitors uncounted today`);
        fullOn = list.day;
        return { visitor: false, visit: false };
      }
      list.seen.set(hash, now);
      saveSoon();
      return { visitor: last === undefined, visit: last === undefined || now - last >= IDLE_MS };
    },
    // Writes the day's list now (a stop).
    save,
  };
}

// With counting off: whatever list an earlier run left (its salt and hashes) is deleted, so none outlives its day.
export function forget(file: string) {
  for (const f of [file, `${file}.new`]) rmSync(f, { force: true });
}

// The day's list in its file, replaced whole
function write(file: string, list: DayList) {
  writeFileSync(`${file}.new`, JSON.stringify({ ...list, seen: Object.fromEntries(list.seen) }), { mode: 0o600 });
  renameSync(`${file}.new`, file);
}

const fresh = (day: string): DayList => ({ day, salt: randomBytes(32).toString('hex'), seen: new Map() });

// The day's list as the app left it (a restart), if it's still today's; none on the first start
function load(file: string | null | undefined, day: () => string): DayList | null {
  if (!file) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const stored = JSON.parse(text);
  if (stored.day !== day()) return null;
  return { day: stored.day, salt: stored.salt, seen: new Map(Object.entries(stored.seen)) };
}
