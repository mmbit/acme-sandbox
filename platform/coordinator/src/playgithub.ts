// GitHub, played: the pull requests the coordinator merges, reads and closes, each open until something happens to it.
// A test sets how GitHub answers (`pr(n)`'s fields, or `refuse` for the next merge) and reads what happened to the pull
// request (its state, the title it was merged under), never which calls were made. Anything else goes to the real fetch.
export type PullRequest = {
  state: 'open' | 'closed';
  added?: string; // what its diff adds (github.ts pullRequestDiff)
  files?: import('./github.ts').PullRequestFile[]; // GitHub's own list of its files, in place of `added`'s
  merged: boolean;
  mergeable: boolean | null;
  head: string;
  base: string;
  aheadBy: number;
  title?: string;
  mergedSha?: string;
  mergeCommit?: string; // the merge commit GitHub answers its merge with
};
export function playGithub() {
  const pulls = new Map<number, PullRequest>();
  const pr = (n: number) => {
    if (!pulls.has(n))
      pulls.set(n, { state: 'open', merged: false, mergeable: true, head: `h${n}`, base: 'main', aheadBy: 2 });
    return pulls.get(n)!;
  };
  // the next merges' answers, in turn (a status and GitHub's message): a race with main, a moved branch...
  const refuse: { status: number; message: string }[] = [];
  // a hook before GitHub answers: a test holds an answer back (a slow or silent GitHub) by returning a promise
  const gh = {
    pr,
    pulls,
    refuse,
    wait: undefined as undefined | ((method: string, n: number, signal?: AbortSignal | null) => Promise<void> | void),
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/')) return real(url, init);
    const method = init.method ?? 'GET',
      n = Number(u.match(/\/pulls\/(\d+)/)?.[1]);
    const compared = u.match(/\/compare\/[^/]+\.\.\.h(\d+)$/);
    await gh.wait?.(method, compared ? Number(compared[1]) : n, init.signal);
    if (compared) return json({ ahead_by: pr(Number(compared[1])).aheadBy });
    const p = pr(n);
    // the files' diffs (github.ts pullRequestDiff): a test sets what a pull request adds as p.added, a page at a time
    if (method === 'GET' && u.includes('/files')) {
      const query = new URL(u).searchParams,
        size = Number(query.get('per_page') ?? 30),
        page = Number(query.get('page') ?? 1);
      const files = p.files ?? [{ patch: (p.added ?? '').replace(/^/gm, '+') }];
      return json(files.slice((page - 1) * size, page * size));
    }
    if (method === 'GET')
      return json({
        merged: p.merged,
        state: p.state,
        mergeable: p.mergeable,
        base: { ref: p.base },
        head: { sha: p.head },
        merge_commit_sha: p.mergeCommit,
      });
    if (method === 'PATCH') {
      p.state = 'closed';
      return json({});
    }
    // PUT: the merge
    const { commit_title, sha } = JSON.parse(String(init.body));
    if (p.state !== 'open') return json({ message: 'Pull Request is not mergeable' }, 405);
    const refusal = refuse.shift();
    if (refusal) return json({ message: refusal.message }, refusal.status);
    if (p.mergeable === false) return json({ message: 'Pull Request is not mergeable' }, 405);
    Object.assign(p, { state: 'closed', merged: true, title: commit_title, mergedSha: sha });
    return json({ merged: true, sha: p.mergeCommit });
  }) as typeof fetch;
  return gh;
}
