// The renders a push names (each .render.json it changes: shared/demo/renders.mjs), kept in the worker's store by their
// sha256, where the server takes them to put back in its checkout (infra/renders.py). Each is read from the job's clone
// as the job's own user, so a planted symlink can't point root at its secrets, and kept only when it's what its
// .render.json says (the gates check that too). A run's raw output kept the same way has no command; one from before
// renders were kept (a blob in git's history) has nothing to keep. Returns why any was left out; a render left out shows
// as missing on the server, and the job goes on. (raw output)
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';

const SIDE = '.render.json';
export const RENDER_MAX = 2 ** 30; // (a film is tens of MB: a gigabyte is no render)

type Who = { uid?: number; gid?: number; env: Record<string, string> };

export async function keepRenders(store: string, who: Who, dir: string, files: string[]) {
  const left: string[] = [];
  mkdirSync(store, { recursive: true });
  for (const side of files.filter(f => f.endsWith(SIDE))) {
    let note: { blob?: string; sha256?: string; bytes?: number };
    try {
      note = JSON.parse(await read(who, `${dir}/${side}`, 1 << 20).then(b => b.toString('utf8')));
    } catch {
      left.push(`${side}: not read`);
      continue;
    }
    const { sha256, bytes } = note;
    if (note.blob) continue; // (from git's history)
    if (
      !/^[0-9a-f]{64}$/.test(sha256 ?? '') ||
      typeof bytes !== 'number' ||
      !Number.isInteger(bytes) ||
      bytes < 0 ||
      bytes > RENDER_MAX
    ) {
      left.push(`${side}: names no sha256 and size a render has`);
      continue;
    }
    if (existsSync(`${store}/${sha256}`)) continue;
    const tmp = `${store}/.${randomBytes(6).toString('hex')}`;
    const kept = await copy(who, `${dir}/${side.slice(0, -SIDE.length)}`, tmp, sha256!, bytes);
    if (kept) {
      chmodSync(tmp, 0o444);
      renameSync(tmp, `${store}/${sha256}`);
    } else {
      rmSync(tmp, { force: true });
      left.push(`${side}: its render isn't what it names, not kept`);
    }
  }
  return left;
}

// a file read as its owner, up to max bytes
function read(who: Who, path: string, max: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const cat = spawn('cat', ['--', path], {
      env: who.env,
      uid: who.uid,
      gid: who.gid,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parts: Buffer[] = [];
    let size = 0;
    cat.stdout.on('data', (d: Buffer) => {
      if ((size += d.length) > max) cat.kill('SIGKILL');
      else parts.push(d);
    });
    cat.on('close', code =>
      code === 0 && size <= max ? resolve(Buffer.concat(parts)) : reject(new Error(`couldn't read ${path}`)),
    );
  });
}

// a file copied as its owner into `to`, whole and only when it has the sha256 and size given
function copy(who: Who, from: string, to: string, sha256: string, bytes: number) {
  return new Promise<boolean>(resolve => {
    const cat = spawn('cat', ['--', from], {
      env: who.env,
      uid: who.uid,
      gid: who.gid,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out = createWriteStream(to, { mode: 0o600 }),
      hash = createHash('sha256');
    let size = 0;
    cat.stdout.on('data', (d: Buffer) => {
      if ((size += d.length) > bytes) cat.kill('SIGKILL');
      else hash.update(d);
    });
    cat.stdout.pipe(out);
    cat.on('close', code => out.end(() => resolve(code === 0 && size === bytes && hash.digest('hex') === sha256)));
  });
}
