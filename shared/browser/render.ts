// Automatic helper dispatch for heavy browser harnesses.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { onLent } from '../gates/lent.ts';
import { git, workingTree } from '../gates/repo.ts';
import { unpackInto } from '../../platform/worker/hq/unpack.ts';
import { supervise } from './supervise.ts';

export async function render() {
  if (process.env.HQ_RENDER_CHILD === '1') {
    process.send?.({ render: 'progress' });
    return;
  }
  const { root, ref, request } = prepare();
  const { output, args } = request;
  console.log('Render queued: checking the browser helper');
  const ran = await offload(root, ref, request);
  if (ran) {
    if (ran.timedOut && !ran.brought.size) {
      console.error(ran.output);
      console.error('Render stopped: the helper time budget ended');
      process.exit(124);
    }
    const remote = JSON.parse(ran.brought.get('render-outcome.json')!);
    console.log(ran.output.replaceAll(remote.output, output));
    restore(ran.binary!.get('render-files.tar.gz')!, output, request.record);
    console.log(`Render finished on ${ran.machine}`);
    process.exit(ran.exitCode);
  }
  console.log('Render queued on this worker: waiting for its single browser slot');
  process.exit(await supervise(resolve(process.argv[1]), args, { cwd: process.cwd(), lock: true }));
}

function prepare() {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const args = process.argv.slice(2);
  const option = (name: string) => args[args.indexOf(name) + 1];
  const has = (name: string) => args.includes(name);
  const output = has('--out') ? resolve(option('--out')) : mkdtempSync(join(tmpdir(), 'browser-render-'));
  mkdirSync(output, { recursive: true });
  if (!has('--out')) args.push('--out', output);
  const ref = has('--ref') ? option('--ref') : 'origin/main';
  const source = {
    ref,
    baseCommit: git(root, 'rev-parse', `${ref}^{commit}`).trim(),
    branch: git(root, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    commit: git(root, 'rev-parse', 'HEAD').trim(),
    dirty: Boolean(git(root, 'status', '--porcelain').trim()),
    command: ['node', relative(root, resolve(process.argv[1])), ...process.argv.slice(2)].join(' '),
  };
  const request = {
    entry: relative(root, resolve(process.argv[1])),
    args,
    cwd: relative(root, process.cwd()),
    output,
    source,
    record: has('--record') ? resolve(root, option('--record')) : null,
    brand: has('--brand') ? readFileSync(option('--brand'), 'utf8') : null,
  };
  return { root, ref, request };
}

async function offload(root: string, ref: string, request: object) {
  const { HQ_URL: hq, HQ_TOKEN: token } = process.env;
  if (!hq || !token) return undefined;
  const answer = await fetch(`${hq}/api/agent/runs/helper`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!answer.ok) throw new Error(`Render helper discovery failed: HTTP ${answer.status}`);
  // the kind org.yaml's runs.browser names.
  const helpers = (await answer.json()) as { browser: string; kinds: { name: string; present: boolean }[] };
  if (!helpers.kinds.some(kind => kind.name === helpers.browser && kind.present)) return undefined;
  return onLent(root, {
    what: 'Browser render',
    kind: helpers.browser,
    bootstrap: 'shared/browser/onhelper.sh',
    script: '../render-request.json',
    args: [],
    base: git(root, 'rev-parse', `${ref}^{commit}`).trim(),
    tree: workingTree(root),
    minutes: 30,
    bring: ['render-outcome.json'],
    binary: ['render-files.tar.gz'],
    tools: [],
    inputs: { 'render-request.json': JSON.stringify(request) },
    exitIsResult: true,
    waitWhilePresent: true,
    limitIsResult: true,
  });
}

function restore(archive: Buffer, output: string, record: string | null) {
  const scratch = mkdtempSync(join(tmpdir(), 'browser-files-'));
  try {
    const unpacked = unpackInto(scratch, archive, ['pictures', 'record.md']);
    if (unpacked.leftOut.length) throw new Error(`Render files refused: ${unpacked.leftOut.join(', ')}`);
    for (const name of readdirSync(join(scratch, 'pictures'))) {
      const destination = join(output, name);
      rmSync(destination, { recursive: true, force: true });
      cpSync(join(scratch, 'pictures', name), destination, { recursive: true });
    }
    if (record && existsSync(join(scratch, 'record.md'))) {
      mkdirSync(dirname(record), { recursive: true });
      rmSync(record, { force: true });
      writeFileSync(record, readFileSync(join(scratch, 'record.md')));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
