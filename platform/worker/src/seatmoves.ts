// A seat renamed in SEATS keeps its login.
// SEAT_MOVES lists old:new pairs (b:a,c:b), moved in that order at the worker's start, before any sign-in: the new id's
// folder goes, with whatever login it held, and the old one's takes its place. <root>/moves-done is the journal: a
// "moving old:new" line before a move and "old:new" once it's done, so a later start never moves a pair twice.
// - An old folder that's gone with its move begun was moved (a start cut off after the mv): the pair is only written down.
// - An old folder that never was (no "moving" line) has no login to give: the new one's own still goes.
// - A journal that's there but can't be read moves nothing, and every new seat stays off the list until the next start:
//   read as no moves, it would move a done pair again and delete the login it brought.
// - So does one that ends mid-line (a write cut short), until someone checks its last line and ends it: the next line
//   would be glued to it, and a done pair it records would stop counting.
// - A move that fails stops the rest (a later one may need it done) and leaves their new seats off the list.
// Returns the seats to keep off the list; run throws when a command fails.
import { existsSync } from 'node:fs';

export type MoveOps = { read: (path: string) => string | undefined; run: (cmd: string, args: string[]) => unknown; log: (...a: unknown[]) => void };

export function moveSeats(spec: string, root: string, { read, run, log }: MoveOps): string[] {
  const done = `${root}/moves-done`, all = spec.split(',').filter(Boolean);
  const raw = existsSync(done) ? read(done) : '';
  if (raw === undefined || (raw && !raw.endsWith('\n'))) {
    const off = all.map(p => p.split(':')[1] ?? p);
    const why = raw === undefined ? "can't be read" : 'ends mid-line (a write cut short)', until = raw === undefined ? 'the next start' : 'it\'s mended';
    log(`seat moves: ${done} ${why}, so nothing moves; off until ${until}: ${off.join(', ')}`);
    return off;
  }
  const lines = raw.split('\n'), pairs = all.filter(p => !lines.includes(p));
  const note = (line: string) => run('sh', ['-c', 'echo "$2" >> "$1"', 'sh', done, line]);
  for (const [i, pair] of pairs.entries()) {
    const [from, to, ...rest] = pair.split(':');
    try {
      if (rest.length || ![from, to].every(id => /^[a-z0-9-]+$/.test(id ?? '') && id !== 'shared') || from === to) throw new Error('not old:new seat ids');
      if (existsSync(`${root}/${from}`)) {
        note(`moving ${pair}`);
        run('rm', ['-rf', '--', `${root}/${to}`]); run('mv', ['-T', '--', `${root}/${from}`, `${root}/${to}`]);
        log(`seat move: ${to} has ${from}'s login now, and its own is gone`);
      } else if (!lines.includes(`moving ${pair}`)) {
        run('rm', ['-rf', '--', `${root}/${to}`]);
        log(`seat move: ${from} had no login to give, and ${to}'s own is gone`);
      }
      note(pair);
    } catch (err) {
      const off = pairs.slice(i).map(p => p.split(':')[1] ?? p);
      log(`seat move ${pair} failed; off until the next start: ${off.join(', ')}:`, err);
      return off;
    }
  }
  return [];
}
