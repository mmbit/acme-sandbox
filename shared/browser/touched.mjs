// What each case of a browser check ran, and whether a change since touches it, so the check runs again only the
// cases a change could have moved.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workingTree } from '../gates/repo.ts';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..'); // the checkout the pages are served from
const RECORD = 'touched.json';
// the files whose executed lines are noted, a script's: any other file a case fetched touches it when it changes at all
const SCRIPT = /\.m?js$/;
// a relative import in a module's source: from '…', import '…', import('…'); and a file it reads by its own address,
// new URL('…', import.meta.url), or one in a folder it names, with the rest
// worked out as it runs, new URL(`./folder/${…}…`, import.meta.url): every file in that folder, when it's below the
// repo's root (an address from the root itself builds a path to any file, not a folder of inputs)
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const MODULE = /\.(?:m?js|ts)$/; // (a file whose imports and reads are followed)
const READ = /\bnew URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
const READ_IN = /\bnew URL\(\s*`(\.{1,2}\/(?:[^`$/]*\/)*)[^`/]*\$\{[^`]*`\s*,\s*import\.meta\.url\s*\)/g;

// The record in the folder out of the check whose entry is the module at entryUrl: what its cases ran, each with the
// tree it ran on (the working tree as git would store it). reads: the files the check reads itself (a list of screens,
// a setting), from the repo's root, which touch every case as its code does. touches(name) says whether a change since touches that case
// (one with no record always runs), kept(name) is its result then, names() the cases it has, save() notes a case run
// now, and write() keeps them all for the next run.
export function recordIn(out, entryUrl, reads = []) {
  const entry = fileURLToPath(entryUrl);
  const root = gitIn(dirname(entry), ['rev-parse', '--show-toplevel']).toString().trim();
  const file = join(out, RECORD);
  const earlier = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { cases: {}, objects: '' };
  // (the trees it names, for a checkout that never had them: a helper's has only the tree it was sent)
  if (earlier.objects) gitIn(root, ['unpack-objects', '-q'], Buffer.from(earlier.objects, 'base64'));
  const tree = workingTree(root);
  const code = [...codeOf(root, entry), ...reads];
  const changes = changesSince(root, earlier.cases, tree);
  const cases = { ...earlier.cases };
  return {
    touches: name =>
      !(name in earlier.cases) || touches(earlier.cases[name].files, changes.get(earlier.cases[name].tree)),
    kept: name => earlier.cases[name].result,
    names: () => Object.keys(earlier.cases),
    save(name, result, files) {
      cases[name] = { tree, result, files: { ...files, ...Object.fromEntries(code.map(path => [path, 'whole'])) } };
    },
    write() {
      mkdirSync(out, { recursive: true });
      writeFileSync(file, JSON.stringify({ cases, objects: objectsOf(root, cases) }));
    },
  };
}

// --touched's answer, for a check's runner: which of the recorded cases chosen a change since touches, then whether
// there's anything to run again. noun: what the check calls a case, one and many (['story', 'stories']); only: the
// words they were chosen by, if any.
export function listTouched(record, chosen, { check, noun: [one, many], out, only }) {
  const touched = chosen.filter(record.touches);
  for (const name of touched) console.log(`touched ${name}`);
  console.log(
    !chosen.length
      ? `${check}: no ${one} recorded in ${out}${only ? ` for '${only}'` : ''}: run them, with --out, to record them`
      : touched.length
        ? `${check}: ${touched.length} of ${chosen.length} recorded ${many} touched since the last run: run them --again`
        : `${check}: none of the ${chosen.length} recorded ${many} touched since the last run, nothing to run again`,
  );
}

// The check's own code: its entry and every module of the repo it imports, near or far, with this one, and the files
// they read by their own address or in a folder they name
function codeOf(root, entry) {
  const found = new Set();
  const visit = file => {
    if (found.has(file) || !existsSync(file) || !statSync(file).isFile()) return; // (a folder's fixed address: a place)
    found.add(file);
    if (!MODULE.test(file)) return;
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of [...source.matchAll(IMPORT), ...source.matchAll(READ)])
      visit(resolve(dirname(file), specifier));
    for (const [, folder] of source.matchAll(READ_IN)) {
      const dir = resolve(dirname(file), folder),
        below = relative(root, dir);
      if (below && !below.startsWith('..') && existsSync(dir))
        for (const name of readdirSync(dir)) visit(join(dir, name));
    }
  };
  visit(entry);
  visit(fileURLToPath(import.meta.url));
  return [...found].map(file => relative(root, file)).filter(path => !path.startsWith('..'));
}

// The changes since each tree the cases ran on, to the files they noted: a tree → a map of a changed file → its hunks
// (git diff -U0's old side, [start, count]; none for a file whose change has no lines, as a picture's)
function changesSince(root, cases, tree) {
  const changes = new Map();
  for (const [earlier, paths] of pathsByTree(cases)) {
    const changed = new Map();
    const diff =
      earlier === tree
        ? ''
        : gitIn(root, ['diff', '-U0', '--no-renames', '--no-ext-diff', earlier, tree, '--', ...paths]);
    let hunks;
    for (const line of diff.toString().split('\n')) {
      if (line.startsWith('diff --git ')) {
        // (diff --git a/<path> b/<path>, the path the same both sides with no renames)
        const both = line.slice('diff --git '.length);
        changed.set(both.slice(2, 2 + (both.length - 5) / 2), (hunks = []));
      }
      const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
      if (hunk) hunks.push([Number(hunk[1]), Number(hunk[2] ?? 1)]);
    }
    changes.set(earlier, changed);
  }
  return changes;
}

// Whether a case's files ({ path: 'whole' | its executed lines as [from, to] ranges }) meet the changes since its tree
function touches(files, changed) {
  return Object.entries(files).some(([path, lines]) => {
    const hunks = changed.get(path);
    return hunks && (lines === 'whole' || !hunks.length || hunks.some(hunk => hits(hunk, lines)));
  });
}

// A hunk's old side against executed lines: lines changed or deleted among them, or lines inserted next to one
// (git's start is the line they go after when it takes none away)
function hits([start, count], lines) {
  const [from, to] = count ? [start, start + count - 1] : [start, start + 1];
  return lines.some(([first, last]) => first <= to && from <= last);
}

// Each tree the cases ran on, with the files they noted there
function pathsByTree(cases) {
  const trees = new Map();
  for (const { tree, files } of Object.values(cases)) {
    const paths = trees.get(tree) ?? new Set();
    for (const path of Object.keys(files)) paths.add(path);
    trees.set(tree, paths);
  }
  return [...trees].map(([tree, paths]) => [tree, [...paths]]);
}

// The objects a later run needs to see what changed in the cases' files since their trees, packed: the trees on the way
// to each file and the files themselves, as base64
function objectsOf(root, cases) {
  const ids = new Set();
  for (const [tree, paths] of pathsByTree(cases)) {
    ids.add(tree);
    const listing = gitIn(root, ['ls-tree', '-r', '-t', '-z', tree, '--', ...paths]).toString();
    for (const entry of listing.split('\0').filter(Boolean)) ids.add(entry.split(/\s/)[2]);
  }
  return gitIn(root, ['pack-objects', '--stdout', '-q'], `${[...ids].join('\n')}\n`).toString('base64');
}

const gitIn = (cwd, args, input) =>
  execFileSync('git', ['--literal-pathspecs', '-c', 'core.quotePath=false', ...args], {
    cwd,
    input,
    maxBuffer: 1 << 30,
  });

// Follows what a browser's cases open, from before the first page of each loads: begin() as a case starts, then end()
// → the files it used ({ path: 'whole' | executed lines }), from Chromium's coverage of every page it had open and
// what they fetched. served: an address → the repo files it answers from (none for an address of no repo file's). end() gives null without served and
// in another browser. abandon() closes the contexts a case opened, under a case given up, whose files are then null.
export const watch = (browser, served) => new Watcher(browser, served);

class Watcher {
  #served;
  #covered;
  #running = new Map(); // a page → its coverage, starting
  #opened = [];
  #fetched = new Set();
  #scripts = [];
  #abandoned = false;
  #unread = new Set(); // what the pages fetched whose coverage couldn't be read (closed on their own, or crashed)
  #fetchedBy = new Map(); // a page → what it fetched

  constructor(browser, served) {
    this.#served = served;
    this.#covered = Boolean(served) && browser.browserType().name() === 'chromium';
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await newContext(options);
      this.#opened.push(context);
      if (this.#covered) this.#follow(context);
      return context;
    };
  }

  begin() {
    [this.#opened, this.#fetched, this.#scripts, this.#unread, this.#abandoned] = [[], new Set(), [], new Set(), false];
  }

  async abandon() {
    this.#abandoned = true;
    for (const page of this.#opened.flatMap(context => context.pages())) this.#running.delete(page);
    await Promise.all(this.#opened.map(context => context.close()));
  }

  async end() {
    if (!this.#covered || this.#abandoned) return null;
    // (the pages that live on start again, for the next case)
    const open = [...this.#running.keys()];
    await Promise.all(open.map(page => this.#stop(page)));
    await Promise.all(open.filter(page => !page.isClosed()).map(page => this.#start(page)));
    return filesOf(this.#served, this.#scripts, this.#fetched, this.#unread);
  }

  // (a page's coverage is gone with it, so it's read as the page or its context closes)
  #follow(context) {
    context.on('request', request => this.#fetched.add(request.url()));
    context.on('page', page => {
      const fetched = new Set();
      this.#fetchedBy.set(page, fetched);
      page.on('request', request => fetched.add(request.url()));
      this.#start(page);
      const close = page.close.bind(page);
      page.close = async options => {
        await this.#stop(page);
        return close(options);
      };
    });
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await this.#start(page);
      return page;
    };
    const close = context.close.bind(context);
    context.close = async options => {
      await Promise.all(context.pages().map(page => this.#stop(page)));
      return close(options);
    };
  }

  #start(page) {
    if (!this.#running.has(page)) this.#running.set(page, page.coverage.startJSCoverage({ resetOnNavigation: false }));
    return this.#running.get(page);
  }

  async #stop(page) {
    const starting = this.#running.get(page);
    this.#running.delete(page);
    if (!starting) return;
    try {
      await starting;
      this.#scripts.push(...(await page.coverage.stopJSCoverage()));
    } catch {
      for (const url of this.#fetchedBy.get(page) ?? []) this.#unread.add(url);
    }
    this.#fetchedBy.delete(page);
  }
}

// The repo files a case used: a script's executed lines where its source is the file's, else the whole file, as for
// everything else it fetched (an answer built from several files: all of them) and all a page whose coverage is unread
// fetched
function filesOf(served, scripts, fetched, unread) {
  const sourcesOf = url => (/^https?:/.test(url) ? served(url) : []);
  const fileOf = url => (sourcesOf(url).length === 1 ? sourcesOf(url)[0] : null);
  const used = new Set([...fetched].flatMap(sourcesOf));
  const texts = new Map();
  const textOf = path => texts.get(path) ?? texts.set(path, readFileSync(join(ROOT, path), 'utf8')).get(path);
  const lines = new Map(); // a script's file → the lines that ran, or null once a page had other source for it
  for (const script of scripts) {
    const path = fileOf(script.url);
    if (!path) continue;
    used.add(path);
    const same = SCRIPT.test(path) && lines.get(path) !== null && script.source === textOf(path);
    lines.set(path, same ? new Set([...(lines.get(path) ?? []), ...executedLines(script)]) : null);
  }
  for (const path of [...unread].flatMap(sourcesOf)) lines.set(path, null);
  return Object.fromEntries([...used].map(path => [path, lines.get(path) ? rangesOf(lines.get(path)) : 'whole']));
}

// The lines of a script that ran, from V8's block coverage: a function's ranges nest, an inner one's count overriding
// the outer's, so they're laid down outermost first. A line counts when any of its characters ran, its end of line too.
function executedLines({ source, functions }) {
  const ran = new Uint8Array(source.length);
  const ranges = functions
    .flatMap(f => f.ranges)
    .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const { startOffset, endOffset, count } of ranges) ran.fill(count > 0 ? 1 : 0, startOffset, endOffset);
  const lines = new Set();
  for (let i = 0, line = 1; i < source.length; i++) {
    if (ran[i]) lines.add(line);
    if (source[i] === '\n') line++;
  }
  return lines;
}

// Line numbers as [from, to] ranges, in order
function rangesOf(lines) {
  const ranges = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] === line - 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}
