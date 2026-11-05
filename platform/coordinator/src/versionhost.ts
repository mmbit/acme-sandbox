// A host that serves a version of the work on the preview domain (a try's, ink/trypreview.ts, and an earlier one of a
// cycles page, earlier.ts): its opening, its paths and its files from git.
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { ORIGIN, PREVIEW, REPO_DIR, ZONE } from './config.ts';
import { boardOn } from './preview.ts';

const run = promisify(execFile);

// The numbered hosts of one kind on the preview domain, <kind>-<n>.preview.<zone>: one's name, or none without a
// domain (a run on one's own machine), and the number a host is, if it's one of them.
export function numbered(kind: string) {
  const name = new RegExp(`^${kind}-([1-9][0-9]{0,9})$`);
  return {
    hostOf: (n: number) => (ZONE ? `${kind}-${n}${PREVIEW}` : null),
    numberAt(host: string) {
      const h = host.toLowerCase().split(':')[0];
      const n = ZONE && h.endsWith(PREVIEW) ? name.exec(h.slice(0, -PREVIEW.length))?.[1] : undefined;
      return n ? Number(n) : null;
    },
  };
}

// A request's opening: the board's only, and no service worker, which could catch the preview login's code on its way
// in. False once it's refused (what: the version, in the refusal's words).
// also: whoever else the host lets in; sources: the CSP's directives for what its pages may load, beside the framing's.
export function opened(
  req: IncomingMessage,
  res: ServerResponse,
  what: string,
  { also, sources }: { also?: () => boolean; sources?: string } = {},
) {
  const host = String(req.headers.host ?? '')
    .toLowerCase()
    .split(':')[0];
  if (!boardOn(req, host) && !also?.()) return refused(res, 'not allowed');
  if (req.headers['service-worker'] === 'script') return refused(res, `no service workers on ${what}`);
  // HQ's viewer frames it; nothing else may
  res.setHeader('content-security-policy', [sources, `frame-ancestors 'self' ${ORIGIN}`].filter(Boolean).join('; '));
  res.setHeader('cache-control', 'no-cache');
  return true;
}
const refused = (res: ServerResponse, words: string) => {
  res.writeHead(403, { 'content-type': 'text/plain' }).end(words);
  return false;
};

// A request's path decoded, or null where it doesn't decode
export const decoded = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
};

// git on the server's checkout: its output, and a file's bytes at a commit (rejects with git's error where there are none)
const IN_REPO = ['-c', `safe.directory=${REPO_DIR}`, '-C', REPO_DIR];
export const git = (args: string[]) => run('git', [...IN_REPO, ...args], { timeout: 20_000 }).then(r => r.stdout);
export const gitShow = (sha: string, path: string) =>
  run('git', [...IN_REPO, 'show', `${sha}:${path}`], {
    encoding: 'buffer',
    maxBuffer: 256 << 20,
    timeout: 20_000,
  }).then(r => r.stdout);
