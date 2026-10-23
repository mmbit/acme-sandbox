// What the gates keep out of git (gates.ts): renders, whose recipe and .render.json go in their place, a run's raw
// output, which goes in the store, and generated output, whose summary does.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BIG, MEDIA, SIDE } from '../demo/renders.mjs';
import { git } from './repo.ts';

const MANY = 10_000,
  MANY_IN_ALL = 100_000;
const LOCK = /(^|\/)(package-lock\.json|[^/]+\.lock)$/;
const SUMMARY =
  "commit a short summary of what it shows (in a note, a test or the report), never the raw output; keep a run's output in $TMPDIR";
// a data file in the knowledge base or a product: one over DATA_LINES lines or BIG bytes is raw output
const DATA = /^(knowledge|products)\/.*\.(json|jsonl|ndjson|log|txt|csv|tsv)$/;
const DATA_LINES = 2_000;

// A file the change touches: its lines the change adds or edits, and its path at the base (gates.ts changedFiles)
export type Change = { path: string; basePath: string | null; lines: Set<number> | 'all' };
export type Problem = { path: string; line?: number; text: string };

// Renders stay out of git: a video or audio file over BIG the change adds or edits is refused, and every .render.json it
// adds or edits names what's really there (the file it rendered, or for one from before, its blob in git's history), so
// the worker can keep it and the server put it back (infra/renders.py).
export function renderProblems(root: string, changes: Change[]): Problem[] {
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  return changes.flatMap(({ path }): Problem[] => {
    if (!path) return [];
    if (MEDIA.test(path) && statSync(join(root, path)).size > BIG)
      return [
        {
          path,
          text: 'a render in git: commit its recipe and the .render.json the kit writes beside it (shared/demo/README.md, Renders), or for one rendered before, node shared/demo/renders.mjs adopt',
        },
      ];
    if (!path.endsWith(SIDE)) return [];
    const file = path.slice(0, -SIDE.length);
    let note: { command?: string[]; blob?: string; sha256?: string; bytes?: number };
    try {
      note = JSON.parse(readFileSync(join(root, path), 'utf8'));
    } catch {
      return [{ path, text: "isn't JSON" }];
    }
    if (note.blob) {
      let data: Buffer;
      try {
        data = execFileSync('git', ['-C', root, 'cat-file', 'blob', note.blob], { maxBuffer: 1 << 30 });
      } catch {
        return [{ path, text: `names blob ${note.blob}, which git doesn't have` }];
      }
      return hash(data) === note.sha256 ? [] : [{ path, text: `its blob isn't the file it names (sha256)` }];
    }
    const there =
      existsSync(join(root, file)) &&
      statSync(join(root, file)).size === note.bytes &&
      hash(readFileSync(join(root, file))) === note.sha256;
    return there
      ? []
      : [
          {
            path,
            text: `${file} is missing here or isn't what it names: ${note.command ? 'render it again' : 'fetch it'} (node shared/demo/renders.mjs ${note.command ? 'render' : 'fetch'} ${file})`,
          },
        ];
  });
}

// A run's raw output (a trace, observations, a frame dump, a log) goes in the store, never in the knowledge base or a
// product: a data file there that the change adds or edits, over DATA_LINES
// lines or BIG bytes, is refused. A fixture a test reads is let through by the `fixture` attribute (.gitattributes).
export function dataProblems(root: string, changes: Change[]): Problem[] {
  const big = changes
    .map(c => c.path)
    .filter(path => path && DATA.test(path) && !LOCK.test(path) && lstatSync(join(root, path)).isFile())
    .filter(path => {
      const data = readFileSync(join(root, path));
      return data.length > BIG || lineCount(data) > DATA_LINES;
    });
  if (!big.length) return [];
  // check-attr -z: path, attribute, value, each ending in NUL
  const marks = git(root, 'check-attr', '-z', 'fixture', '--', ...big).split('\0');
  const fixtures = new Set(marks.flatMap((path, i) => (i % 3 === 0 && marks[i + 2] === 'set' ? [path] : [])));
  return big
    .filter(path => !fixtures.has(path))
    .map(path => ({
      path,
      text: `raw output in git (over ${DATA_LINES.toLocaleString('en')} lines or 512 KB): keep it in the store (node shared/demo/renders.mjs keep ${path}), commit the .render.json beside it and a short summary of its numbers; a fixture a test reads gets the "fixture" attribute in .gitattributes`,
    }));
}

function lineCount(data: Buffer) {
  if (data.includes(0)) return 0; // (a binary file has no lines: git shows -)
  const breaks = data.filter(b => b === 10).length;
  return data.length && data[data.length - 1] !== 10 ? breaks + 1 : breaks;
}

// Generated output stays out of git: a file the change adds or edits more than
// MANY lines of (a lock file aside), or more than MANY_IN_ALL lines added in all, which a run's output spread over many
// files is. (node_modules is in .gitignore.) A data file dataProblems holds is its alone.
export function outputProblems(root: string, changes: Change[]): Problem[] {
  const added = (c: Change) => {
    if (c.lines !== 'all') return c.lines.size;
    const file = join(root, c.path);
    return lstatSync(file).isFile() ? lineCount(readFileSync(file)) : 0;
  };
  const counted = changes.filter(c => c.path && !LOCK.test(c.path)).map(c => ({ path: c.path, lines: added(c) }));
  const problems: Problem[] = counted
    .filter(c => c.lines > MANY && !DATA.test(c.path))
    .map(({ path, lines }) => ({ path, text: `${lines.toLocaleString('en')} lines of generated output: ${SUMMARY}` }));
  const all = counted.reduce((n, c) => n + c.lines, 0);
  if (!problems.length && all > MANY_IN_ALL)
    problems.push({
      path: '(the whole change)',
      text: `adds ${all.toLocaleString('en')} lines: generated output? ${SUMMARY}`,
    });
  return problems;
}
