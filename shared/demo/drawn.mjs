// A film the demo kit draws for a job on a lent machine (away.mjs): whether this process sends its films off, and while
// a run draws one, the files the job has and those the page asked for that the run lacks
import { existsSync, mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, SIDE } from './renders.mjs';

// the run's exit code when its bundle lacked files the page asked for
export const MISSING_EXIT = 3;
// how long the run gathers the files a page's requests lack, as a page asks for several at once
const GATHER_MS = 1000;

// While a run draws: { folder, has, missing, ending }
let drawn = null;

// Sent from a job, unless this is the run itself: on a lent machine (no job's token) or here (hq run's fallback)
export const sends = () => Boolean(process.env.HQ_TOKEN && process.env.HQ_URL && !process.env.HQ_RUN_HERE);

export const drawing = () => drawn !== null;

// This process is the run drawing the spec in folder, for a job that has these files
export function start(folder, has) {
  drawn = { folder, has, missing: new Set(), ending: null };
  mkdirSync(join(folder, 'back'), { recursive: true });
}

// A file a page asks for: one the job has and this tree lacks stops the run, as the page may wait for it forever. A
// render the job has only the note of (kept or made, not fetched) counts: the job fetches it for the next run
export function requireSent(file) {
  const path = relative(ROOT, file);
  if (drawn && !existsSync(file) && (drawn.has.has(path) || drawn.has.has(path + SIDE))) lacking(path);
  return file;
}

// The run ends once the page's requests pause: the files they lacked, gathered, are its answer
function lacking(path) {
  drawn.missing.add(path);
  clearTimeout(drawn.ending);
  drawn.ending = setTimeout(endLacking, GATHER_MS);
}

// A drawing that failed: on a file it lacks (a page failing on a clip's frames fails for that alone), or for itself
export function failed(error) {
  if (drawn?.missing.size) endLacking();
  throw error;
}

function endLacking() {
  writeFileSync(join(drawn.folder, 'back', 'missing.json'), JSON.stringify([...drawn.missing]));
  writeSync(1, `\nthe run lacks ${[...drawn.missing].join(', ')}\n`);
  process.exit(MISSING_EXIT);
}
