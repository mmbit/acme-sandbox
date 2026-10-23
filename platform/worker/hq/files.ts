// Files hq reads (briefs, bodies, words on stdin) and the ones it saves for the job (attachments, photos, screenshots).
import {
  accessSync,
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { levelsIn } from './levels.ts';
import { basename } from 'node:path';

export const isReadable = (path: string) => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

export const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

export const readText = (path: string) => readFileSync(path, 'utf8');

// The company's repo hq runs in: a job's clone, or the one HQ_REPO names. None outside one.
export function repoRoot() {
  if (process.env.HQ_REPO) return process.env.HQ_REPO;
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trimEnd();
  } catch {
    return undefined;
  }
}
// Its plan levels (company/levels.json), each line its own or the platform's.
export const companyLevels = () => levelsIn(repoRoot());

// A file handed to the coordinator to keep (hq ask --file, a guest checklist item's files: its cardfiles.ts), as it's
// sent: its name, its size and its bytes in base64; null when it isn't a file that can be read. MAX_FILE_BYTES: the
// coordinator's limit on a card's files in all (cardfiles.ts MAX_BYTES, from which its request body limit is worked
// out), said here first
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export function fileToSend(path: string) {
  if (!isFile(path) || !isReadable(path)) return null;
  const bytes = readFileSync(path);
  return { name: basename(path), size: bytes.length, data: bytes.toString('base64') };
}

export const readStdin = () => readFileSync(0, 'utf8');

// A file's text, or stdin's for "-"
export const readTextOrStdin = (path: string) => (path === '-' ? readStdin() : readText(path));

// A file's text or stdin's ("-"), without its trailing newlines
export const readWords = (path: string) => readTextOrStdin(path).replace(/\n+$/, '');

// Files from outside (mail attachments, the board's photos, a note's screenshot) go into a folder or file made new each
// time, with a name nobody can guess, in the job's own temp folder (TMPDIR, 0700). A fixed /tmp/<name>-<id> could be
// made first by another slot, with a symlink in it to one of this job's files, and then overwritten with a sender's bytes.
export const privateFolder = (name: string) => mkdtempSync(`${tempRoot()}/${name}.`);

// A new file of mode 0600, named <name>.XXXXXX.<extension>, with these bytes in it.
export function savePrivately(name: string, extension: string, bytes: Buffer) {
  for (;;) {
    const path = `${tempRoot()}/${name}.${randomSuffix()}.${extension}`;
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    writeSync(fd, bytes);
    closeSync(fd);
    return path;
  }
}

// A file of the job's own (0600) in a private folder.
export const saveInFolder = (path: string, bytes: Buffer) => writeFileSync(path, bytes, { mode: 0o600 });

const tempRoot = () => process.env.TMPDIR || '/tmp';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const randomSuffix = () => Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join('');
