// A pushed branch's pull request, opened on GitHub by the worker (worker.ts land), which alone holds the token.
import { preview } from './outcome.ts';
import { redact } from './safety.ts';

export type GitHub = { repo: string; token: string; base: string };
// Its number; 'unreached' when GitHub couldn't be reached or failed on its side (a 5xx), the worker's own snag; or GitHub's
// refusal (its status and message), with no open one found.
export type Opened = number | 'unreached' | { refused: string };

// Opens the pull request for a branch, or finds the open one (after review fixes).
export async function openPullRequest(
  gh: GitHub,
  branch: string,
  pull: { title: string; body: string },
  log: (...a: unknown[]) => void,
  signal?: AbortSignal,
): Promise<Opened> {
  const headers = { authorization: `Bearer ${gh.token}`, accept: 'application/vnd.github+json' };
  // (a request that fails, or a body cut off while it's read, is GitHub not reached: its answers, errors too, are responses)
  const reach = async (url: string, init: RequestInit) => {
    try {
      signal?.throwIfAborted();
      const res = await fetch(url, { ...init, signal });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (err) {
      signal?.throwIfAborted();
      log(`Could not reach GitHub to open a PR for ${branch}:`, err);
      return undefined;
    }
  };
  const res = await reach(`https://api.github.com/repos/${gh.repo}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ head: branch, base: gh.base, ...pull }),
  });
  if (!res) return 'unreached';
  if (res.ok) return JSON.parse(res.text).number;
  const open = await reach(
    `https://api.github.com/repos/${gh.repo}/pulls?state=open&head=${gh.repo.split('/')[0]}:${branch}`,
    { headers },
  );
  if (!open) return 'unreached';
  const number = open.ok ? JSON.parse(open.text)[0]?.number : undefined;
  if (number) return number;
  log(`Could not open a PR for ${branch}: ${res.status}`);
  return res.status >= 500 ? 'unreached' : { refused: `HTTP ${res.status}: ${preview(redact(res.text).trim(), 300)}` };
}
