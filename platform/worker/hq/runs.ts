// hq run: a long headless command sent off this job to a helper (the coordinator's runs.ts, platform/helper): one of the
// machines the board lends, the fastest free one first, or this server's own helper when none takes it in time or one
// goes quiet. Either way it runs on a copy of the folders named, as the job's tree has them now, and the files named come
// back into the tree. Nothing of it runs in the job, unless `--fallback here` says so. A run is of a kind the company
// declares (org.yaml's runs.kinds), which sets the image and caps it runs with on the lent machines, and whether this
// server's helper takes it before a lent machine has finished one. With `--fallback here` a run no machine takes runs in
// the job itself.
// Kinds with checkout enabled send the whole checkout when --paths is omitted.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import * as api from './api.ts';
import { checkOnHelper } from './checks.ts';
import { type Here, noTakerNow, runHere } from './here.ts';
import { type Machine, type Presence, SERVER, showHelper } from './machines.ts';
import { minute, oneLine, present, print, stop, warn } from './output.ts';
import { unpackInto } from './unpack.ts';

const USAGE =
  'usage: hq run [--kind <name>] [--paths <folders>] [--with <files>] [--bring <paths>] [--minutes n] [--commit <sha>] [--fallback here] -- <command> [args...] | hq run <id> | hq run lines <id> | hq run stop <id> | hq run helper';
const DEFAULT_MINUTES = 60;
const POLL_MS = 5000;
const SAID_AGAIN_MS = 30 * 60_000;
const BUNDLE_SEND_MS = 10 * 60_000;

export type Spec = { command: string; kind: string; cwd: string; bring: string[]; minutes: number };
// A run's kind on the lent machines (the fastest one's size), and this server's helper of it
type Helper = Presence & {
  name: string;
  kind: string;
  // how many machines the board lends
  lent: number;
  takeMinutes: number;
  maxMinutes: number;
  lentOnly: boolean; // its runs wait for the lent machine alone, however long
  server: Presence;
  // false while this server's helper waits for the lent machine to finish a run of this kind first
  serverTakes: boolean;
};
type Run = {
  id: number;
  state: 'waiting' | 'running' | 'done' | 'withdrawn' | 'stopped' | 'lost';
  minutes: number;
  taken: string | null;
  exitCode: number | null;
  timedOut: boolean;
  why: string | null;
  kind: string | null;
  // the helper that has it or had it, the lent machine's name, and whether a lent one lost it (so only this server's
  // takes it)
  on: 'lent' | 'server' | null;
  machine: string | null;
  passed: boolean;
  bring: string[];
  helper: Helper;
};

// A run's output after the lines read so far, and the number to read after next, numbered since HQ started
type RunLines = { state: Run['state']; since: string; next: number; missed: number; lines: string[] };

export const run = {
  help: `
   hq run [--kind <name>] [--paths <folders>] [--with <files>] [--bring <paths>] [--minutes n] [--commit <sha>]
          [--fallback here] -- <command> [args...]
                                                     Kinds with checkout enabled carry this checkout, including edits
                                                     and local servers. No --paths needed. hq run helper lists the
                                                     kinds, checkout and browser support.
                                                     --bring returns screenshots and reports. Lent helper only.
                                                     Other kinds: a long headless run on the helper,
                                                     a machine with more cores: worth it for a run expected to take 30
                                                     minutes or more here. Start it in the background: it ends when the
                                                     run does. --kind names its kind of run (hq run helper lists them),
                                                     needed when there are several. It runs on a copy of --paths
                                                     (default: this folder), as the tree has them now (or at
                                                     --commit), from this folder, with no network and no node_modules;
                                                     --with adds files git ignores (renders: a film's music, a clip).
                                                     --bring's files and folders come back into the tree. Paths are
                                                     from this folder, comma-separated. When the helper doesn't take
                                                     it within a few minutes, or goes quiet, this server's own helper
                                                     runs it, shut in the same way (for a kind that says so, only once
                                                     the helper has finished a run of it: until then it waits for the
                                                     helper, and is given up if none asks). --fallback here runs it
                                                     in this job instead (HQ_RUN_HERE=1 set) when no helper may take
                                                     it: the kind isn't declared, none asks for work, or a machine
                                                     lost it. Exits with the command's code, 124 past --minutes (60)
   hq run <id>                                       waits for that run again and brings back its files
   hq run lines <id>                                 prints that run's output as it comes, each line once, until it
                                                     ends: a stopped run's too, which brings back nothing else. Start
                                                     it in the background into a file to keep a run's stages
   hq run stop <id>                                  stops it, on the helper or still waiting
   hq run helper                                     the machines, the kinds of run, whether each kind's helpers and
                                                     this server's are there, their size, and the install command
                                                     that sets a machine up`,

  async run(args: string[]) {
    if (args[0] === 'helper' && args.length === 1) return showHelper();
    if (args[0] === 'stop' && /^\d+$/.test(args[1] ?? '') && args.length === 2) return stopRun(Number(args[1]));
    if (args[0] === 'lines' && /^\d+$/.test(args[1] ?? '') && args.length === 2) return followLines(Number(args[1]));
    if (/^\d+$/.test(args[0] ?? '') && args.length === 1) return collect(Number(args[0]));
    return send(args);
  },
};

// ---- sending a run

async function send(args: string[]) {
  const root = git(['rev-parse', '--show-toplevel']);
  const { spec, paths, carried, commit, fallback } = specOf(args, git(['rev-parse', '--show-prefix']));
  const machine: Machine | undefined = !paths ? await api.getJson('runs/helper') : undefined;
  const checkout = machine?.kinds.find(kind => kind.name === spec.kind && kind.checkout);
  if (checkout) {
    if (fallback) stop('hq run: checks stay on the helper, leave out --fallback here');
    return checkOnHelper(root, spec, commit || treeNow(root, ['.'], carried), checkout.browsers);
  }
  const folders = runFolders(paths, spec.cwd);
  const here = fallback ? { root, spec } : null;
  const none = here && (await noTakerNow(spec.kind));
  if (none) return runHere(here, `hq run: ${none}`);
  const bundle = bundleOf(root, folders, carried, commit);
  const answer = await api.call('runs', {
    bytes: bundle,
    headers: { 'content-type': 'application/gzip', 'x-run': Buffer.from(JSON.stringify(spec)).toString('base64url') },
    timeoutMs: BUNDLE_SEND_MS,
  });
  if (api.isRefusal(answer.status)) stop(`hq run: HQ refused it: ${api.errorIn(answer.body, 'refused')}.`);
  const created = api.isSuccess(answer.status) ? api.parseOrNull(answer.body) : null;
  if (!Number.isSafeInteger(created?.id))
    stop(`hq run: HQ didn't take the run (HTTP ${api.httpCode(answer.status)}): send it again`);
  print(`hq run #${created.id}: sent (${created.kind}, ${(bundle.length / 2 ** 20).toFixed(1)} MB)`);
  return collect(created.id, here);
}

// The run from the command line. prefix: this folder in the repo, where the command runs and paths are read from.
function specOf(args: string[], prefix: string) {
  const dashes = args.indexOf('--');
  if (dashes < 0 || dashes === args.length - 1) stop(USAGE);
  const flags: Record<string, string> = {};
  const given = args.slice(0, dashes);
  for (let i = 0; i < given.length; i += 2) {
    const name = /^--(kind|paths|with|bring|minutes|commit|fallback)$/.exec(given[i])?.[1];
    if (!name || !given[i + 1]) stop(USAGE);
    flags[name] = given[i + 1];
  }
  const words = args.slice(dashes + 1);
  const command = words.length === 1 ? words[0] : words.map(shellQuoted).join(' ');
  const cwd = inTree(prefix, '.');
  const paths = flags.paths ? flags.paths.split(',').map(path => inTree(prefix, path)) : undefined;
  const bring = flags.bring ? flags.bring.split(',').map(path => inTree(prefix, path)) : [];
  if (bring.includes('')) stop('hq run: --bring names files or folders inside the repo');
  const carried = flags.with ? flags.with.split(',').map(path => inTree(prefix, path)) : [];
  if (carried.includes('')) stop('hq run: --with names files inside the repo');
  if (carried.length && flags.commit) stop('hq run: --with adds files as the tree has them now, so not with --commit');
  if (flags.fallback && flags.fallback !== 'here') stop('hq run: --fallback here is the one fallback');
  if (flags.fallback && flags.commit) stop('hq run: --fallback here runs the tree as it is now, so not with --commit');
  const minutes = Number(flags.minutes ?? DEFAULT_MINUTES);
  if (!Number.isSafeInteger(minutes) || minutes < 1) stop('hq run: --minutes is a whole number of minutes');
  const spec: Spec = { command, kind: flags.kind ?? '', cwd, bring, minutes };
  return { spec, paths, carried, commit: flags.commit ?? '', fallback: Boolean(flags.fallback) };
}

// A path given from this folder, as the repo sees it ('' for its root)
function inTree(prefix: string, given: string) {
  const path = normalize(join(prefix, given)).replace(/\/$/, '');
  if (given.startsWith('/') || path === '..' || path.startsWith('../')) stop(`hq run: ${given} is outside the repo`);
  return path === '.' ? '' : path;
}

function runFolders(paths: string[] | undefined, cwd: string) {
  const folders = paths ?? [cwd];
  if (folders.includes('')) stop('hq run: name the folders the run needs with --paths, not the whole repo');
  if (cwd && !folders.some(path => cwd === path || cwd.startsWith(`${path}/`)))
    stop(`hq run: this folder (${cwd}) must be inside --paths, where the command runs`);
  return folders;
}

// The folders and carried files as a gzipped tar, at a commit or as the tree has them now
function bundleOf(root: string, paths: string[], carried: string[], commit: string) {
  const tree = commit ? git(['-C', root, 'rev-parse', `${commit}^{tree}`]) : treeNow(root, paths, carried);
  return execFileSync('git', ['-C', root, 'archive', '--format=tar.gz', tree, '--', ...paths, ...carried], {
    maxBuffer: 1024 * 2 ** 20,
  });
}

// Changes and new files included, through an index of its own, so the job's staging stays as it is. The carried files
// go in even though git ignores them.
function treeNow(root: string, paths: string[], carried: string[]) {
  const scratch = mkdtempSync(`${tmpdir()}/hq-run-index-`);
  const env = { ...process.env, GIT_INDEX_FILE: `${scratch}/index` };
  try {
    git(['-C', root, 'read-tree', 'HEAD'], env);
    git(['-C', root, 'add', '-A', '--', ...paths], env);
    if (carried.length) git(['-C', root, 'add', '-f', '--', ...carried], env);
    return git(['-C', root, 'write-tree'], env);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- waiting for it

// Waits for the run and brings it back. One no helper is there to take is given up, so the job hears it rather than
// waiting on nothing, or runs here with `--fallback here`.
async function collect(id: number, here: Here | null = null) {
  const started = Date.now();
  let said = '';
  let saidAt = 0;
  for (;;) {
    const current = await readRun(id);
    const line = stateLine(current);
    if (line !== said || Date.now() - saidAt > SAID_AGAIN_MS) {
      print(`hq run #${id}: ${line}`);
      [said, saidAt] = [line, Date.now()];
    }
    if (current.state === 'done') return bringBack(current, git(['rev-parse', '--show-toplevel']));
    if (current.state === 'waiting' && noTaker(current, started, Boolean(here))) {
      const withdrawn = await readRun(id, 'withdraw');
      if (withdrawn.state === 'withdrawn' && here)
        return runHere(here, `hq run #${id}: no helper took it in ${current.helper.takeMinutes} min`);
      if (withdrawn.state === 'withdrawn') stop(`hq run #${id}: ${noTakerLine(current.helper)}`);
      continue;
    }
    if (current.state === 'lost' && here)
      return runHere(here, `hq run #${id}: lost (${current.why ?? 'no reason given'})`);
    if (current.state !== 'waiting' && current.state !== 'running')
      stop(`hq run #${id}: ${current.state} (${current.why ?? 'no reason given'}): send it again`);
    await sleep(POLL_MS);
  }
}

// No helper that may take it has asked for work for as long as a run waits to be taken (a helper restarting asks again
// well within it). A kind for the lent machine only waits for it, unless the run may run here.
const noTaker = ({ helper, passed }: Run, started: number, orHere: boolean) =>
  (!helper.lentOnly || orHere) &&
  !(helper.present && (!passed || !helper.serverTakes)) &&
  !(helper.server.present && helper.serverTakes) &&
  Date.now() - started > helper.takeMinutes * 60_000;

const noTakerLine = (helper: Helper) =>
  helper.serverTakes
    ? `neither ${helper.name} nor ${SERVER} is asking for work: send it again later`
    : `${helper.name} isn't asking for work, and ${SERVER} takes no ${helper.kind} run until ${helper.name} has finished one: leave the run to a later job`;

function stateLine({ state, helper, taken, why, on, machine, passed }: Run) {
  const size = ({ cpus, memoryGb }: Presence) => (cpus ? ` (${cpus} cores, ${memoryGb} GB)` : '');
  const where = on === 'server' ? `${SERVER}${size(helper.server)}` : (machine ?? helper.name);
  if (state === 'waiting' && helper.lentOnly)
    return `${why ? `${why}; ` : ''}waiting for ${helper.name}${helper.present ? size(helper) : ", which isn't asking for work now"} (this kind runs there alone)`;
  if (state === 'waiting' && !helper.serverTakes)
    return `waiting for ${helper.name}${size(helper)}: ${SERVER} takes no ${helper.kind} run until it has finished one`;
  if (state === 'waiting' && passed) return why ?? `waiting for ${SERVER}`;
  if (state === 'waiting' && !helper.present) return `${helper.name} isn't asking for work: waiting for ${SERVER}`;
  if (state === 'waiting')
    return `waiting for ${helper.name}${size(helper)}, or ${SERVER} after ${helper.takeMinutes} min`;
  if (state === 'running') return `running on ${where}${present(taken) ? ` since ${minute(taken)}` : ''}`;
  if (state === 'done') return `done on ${on === 'server' ? SERVER : (machine ?? helper.name)}`;
  return `${state}: ${why ?? 'no reason given'}`;
}

const readRun = (id: number, action?: 'withdraw' | 'stop'): Promise<Run> =>
  askOfRun(id, action ? `runs/${id}/${action}` : `runs/${id}`, action ? {} : undefined);

// HQ's answer on the run, asked again while HQ restarts (a deploy): a run on the helper goes on meanwhile
async function askOfRun<Answer extends { state: string }>(id: number, route: string, body?: object): Promise<Answer> {
  for (let tries = 1; ; tries++) {
    const answer = await api.orNoAnswer(api.call(route, { body, timeoutMs: 30_000 }));
    if (api.isRefusal(answer.status)) stop(`hq run #${id}: ${api.errorIn(answer.body, 'refused')}`);
    const current = api.isSuccess(answer.status) ? api.parseOrNull(answer.body) : null;
    if (current?.state) return current;
    if (tries >= 20) stop(`hq run #${id}: HQ didn't answer (HTTP ${api.httpCode(answer.status)})`);
    await sleep(POLL_MS);
  }
}

// The run's output, then its files into the tree, and its exit code
async function bringBack(current: Run, root: string) {
  const output = await api.getBytes(`runs/${current.id}/output`);
  const files = await api.getBytes(`runs/${current.id}/files`);
  for (const download of [output, files]) {
    if (download.status !== 200) {
      const reason = download.status === 404 ? 'results unavailable or expired' : `HTTP ${download.status}`;
      // (the exit handler prints these words)
      stop(`hq run #${current.id}: ${reason}`, 22);
    }
  }
  process.stdout.write(output.bytes);
  bringIn(`hq run #${current.id}`, root, files.bytes, current.bring);
  if (current.timedOut) warn(`hq run #${current.id}: stopped at its limit, ${current.minutes} min`);
  return current.exitCode ?? 1;
}

// The files a run sent back into the tree, as unpackInto lets them in
function bringIn(label: string, root: string, files: Buffer, bring: string[]) {
  if (!files.length) return;
  let unpacked: ReturnType<typeof unpackInto>;
  try {
    unpacked = unpackInto(root, files, bring);
  } catch (error) {
    stop(`${label}: no files brought back: ${(error as Error).message}`);
  }
  for (const line of unpacked.leftOut) warn(`${label}: left out ${oneLine(line)}`);
  if (unpacked.brought.length) print(`${label}: files back in the tree`);
}

// ---- the others

// The run's output as its helper's beats bring it, by line number, so a line said again prints again and none twice.
// It ends with the run, once the last lines it heard are read. HQ keeps them in memory: a restart numbers them anew,
// from its new start (since), so lines read since the restart aren't mistaken for those read before it.
async function followLines(id: number) {
  let after = 0;
  let since = '';
  for (;;) {
    const heard = await askOfRun<RunLines>(id, `runs/${id}/lines?after=${after}`);
    if (since && heard.since !== since) {
      warn(`hq run #${id}: HQ restarted, and kept none of the run's lines from before`);
      since = heard.since;
      after = 0;
      continue;
    }
    since = heard.since;
    if (heard.missed) warn(`hq run #${id}: ${heard.missed} lines passed unread (HQ keeps a run's last 100)`);
    if (heard.lines.length) process.stdout.write(`${heard.lines.join('\n')}\n`);
    after = heard.next;
    if (heard.state !== 'waiting' && heard.state !== 'running') return void warn(`hq run #${id}: ${heard.state}`);
    await sleep(POLL_MS);
  }
}

async function stopRun(id: number) {
  const current = await readRun(id, 'stop');
  print(`hq run #${id}: ${current.state}`);
}

function git(args: string[], env = process.env) {
  return execFileSync('git', args, { encoding: 'utf8', env }).trim();
}

const shellQuoted = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
