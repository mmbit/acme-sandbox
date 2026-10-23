// A company's own commands: hq <name> runs kits/<kit>/hq-<name>.sh of the company's repo (the one hq runs in, a job's
// clone; HQ_REPO names another) when the platform has no command of that name (template/kits/README.md). It runs in
// bash with hq's helpers (kit.sh). Its opening comment lines are its part of hq's help.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { isFile, repoRoot } from './files.ts';
import { compareText } from './output.ts';

const KIT_SH = new URL('./kit.sh', import.meta.url).pathname;

export function findKitCommand(name: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return undefined;
  return kitCommandFiles().find(file => file.endsWith(`/hq-${name}.sh`));
}

// Runs it with all of hq's arguments, the command first, and ends hq with its exit code.
export function runKitCommand(file: string, args: string[]) {
  const run = spawnSync('bash', [KIT_SH, file, ...args], { stdio: 'inherit' });
  if (run.error) throw run.error;
  return run.status ?? 128 + constants.signals[run.signal!];
}

// Each command's opening comment lines, in the order of their files
export const kitHelp = () => kitCommandFiles().flatMap(openingComment);

function openingComment(file: string) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const end = lines.findIndex(line => !line.startsWith('#'));
  return lines.slice(0, end === -1 ? lines.length : end);
}

// kits/*/hq-*.sh, in code point order
function kitCommandFiles() {
  const root = repoRoot();
  if (root === undefined) return [];
  const kits = `${root}/kits`;
  const files = folders(kits).flatMap(kit =>
    filesIn(`${kits}/${kit}`)
      .filter(name => /^hq-.*\.sh$/.test(name))
      .map(name => `${kits}/${kit}/${name}`),
  );
  return files.filter(isFile).sort(compareText);
}

const folders = (path: string) => filesIn(path).filter(name => !name.startsWith('.'));

const filesIn = (path: string) => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};
