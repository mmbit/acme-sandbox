// GitHub calls the coordinator makes itself, for pull requests and branches it publishes.
const { GITHUB_TOKEN, REPO } = process.env;
// Each call gives up after this long (it throws, as when GitHub can't be reached): the review loop holds a pull request
// while it waits on GitHub (review.ts `deciding`), and the sweep that acts on its ruling skips it until then.
const timeout = () => AbortSignal.timeout(Number(process.env.GITHUB_TIMEOUT_MS) || 15_000);

// Merges only if the branch head is still `sha`, the commit the panel reviewed. GitHub refuses with 409 (or a 422
// about the sha) when the branch moved since: `moved` tells the caller not to try again. `commit`: the merge commit
// GitHub made.
export async function mergePullRequest(
  pr: number,
  title: string,
  sha: string,
): Promise<{ ok: boolean; moved: boolean; why: string; commit?: string }> {
  if (!GITHUB_TOKEN || !REPO) return { ok: false, moved: false, why: 'no GitHub token configured' };
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${pr}/merge`, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'merge', commit_title: title, sha }),
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: timeout(), // (signal)
  });
  const text = res.ok ? '' : (await res.text()).slice(0, 200);
  const made = res.ok ? await res.json().catch(() => ({})) : {};
  // GitHub's own words, without the JSON around them
  const said = (() => {
    try {
      return String(JSON.parse(text).message ?? text);
    } catch {
      return text;
    }
  })();
  return {
    ok: res.ok,
    moved: res.status === 409 || (res.status === 422 && /\bsha\b|head/i.test(text)),
    why: res.ok ? '' : `${res.status} ${said}`,
    commit: typeof made.sha === 'string' ? made.sha : undefined,
  };
}

// A file as GitHub lists a pull request's (its files API: at most PAGE a page, and MOST_FILES in all)
export type PullRequestFile = {
  filename?: string;
  previous_filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
};
const PAGE = 100,
  MOST_FILES = 3000;
// The lines a pull request adds, from GitHub's own diff of it (the review loop's look for keys in what merges unreviewed:
// review.ts mergeOffice), and the files whose earlier lines it removes or changes (altered: GitHub's deletions, a changed
// line counted as one); undefined when GitHub can't tell. A file it lists with added lines but no patch (it leaves out a
// big file's) throws: those lines can't be read, so nothing may merge on them. Every page of the list is read, and one
// as long as GitHub's longest list (it shows no more) throws too: the files after it can't be read. (altered; every page)
export async function pullRequestDiff(pr: number): Promise<{ added: string; altered: string[] } | undefined> {
  if (!GITHUB_TOKEN || !REPO) return undefined;
  const files: PullRequestFile[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${pr}/files?per_page=${PAGE}&page=${page}`, {
      headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
      signal: timeout(), // (signal)
    });
    if (!res.ok) return undefined;
    const some = (await res.json().catch(() => null)) as PullRequestFile[] | null;
    if (!Array.isArray(some)) return undefined;
    files.push(...some);
    if (some.length < PAGE) break;
    if (files.length >= MOST_FILES)
      throw new Error(`GitHub lists only a pull request's first ${MOST_FILES} files, so the rest can't be read`);
  }
  const unread = files.find(f => !f.patch && (f.additions ?? 0) > 0);
  if (unread)
    throw new Error(
      `GitHub lists ${unread.additions} added lines in ${unread.filename} but doesn't show them, so they can't be read`,
    );
  const added = files
    .flatMap(f =>
      (f.patch ?? '')
        .split('\n')
        .filter(l => l.startsWith('+'))
        .map(l => l.slice(1)),
    )
    .join('\n');
  // a rename counts under both names, and a file GitHub shows no patch for (a binary one) counts as changed
  const changed = (f: PullRequestFile) =>
    (f.deletions ?? 0) > 0 || f.status === 'renamed' || (!!f.status && f.status !== 'added' && !f.patch);
  return {
    added,
    altered: files
      .filter(changed)
      .flatMap(f => [String(f.filename), ...(f.previous_filename ? [f.previous_filename] : [])]),
  };
}

// Whether GitHub has it merged or closed (a merge that went through unheard, or a close by hand: review.ts merge());
// undefined when it can't tell. And whether it merges into main as it is now (`mergeable`: false is a conflict, null
// while GitHub still works it out). Its head identifies a push outside any job (review.ts movedOutside()).
export async function pullRequestState(
  pr: number,
): Promise<{ state: 'merged' | 'closed' | 'open'; mergeable: boolean | null; head?: string } | undefined> {
  if (!GITHUB_TOKEN || !REPO) return undefined;
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${pr}`, {
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: timeout(), // (signal)
  });
  if (!res.ok) return undefined;
  const p = await res.json().catch(() => ({}));
  const state =
    p.merged === true ? 'merged' : p.state === 'closed' ? 'closed' : p.state === 'open' ? 'open' : undefined;
  return (
    state && {
      state,
      mergeable: typeof p.mergeable === 'boolean' ? p.mergeable : null,
      head: typeof p.head?.sha === 'string' ? p.head.sha : undefined,
    }
  );
}

// Whether every commit on the pull request's branch is on its base already (its head is no commits ahead), so closing it
// unmerged loses nothing; undefined when GitHub can't tell, or doesn't answer in time (a close waits on this).
export async function landed(pr: number): Promise<boolean | undefined> {
  if (!GITHUB_TOKEN || !REPO) return undefined;
  const headers = { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal = timeout(); // (timeout())
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${pr}`, { headers, signal });
  const p = res.ok ? await res.json().catch(() => ({})) : {};
  const base = p.base?.ref,
    head = p.head?.sha;
  if (typeof base !== 'string' || typeof head !== 'string') return undefined;
  const compared = await fetch(`https://api.github.com/repos/${REPO}/compare/${encodeURIComponent(base)}...${head}`, {
    headers,
    signal,
  });
  const c = compared.ok ? await compared.json().catch(() => ({})) : {};
  return typeof c.ahead_by === 'number' ? c.ahead_by === 0 : undefined;
}

export async function closePullRequest(pr: number) {
  if (!GITHUB_TOKEN || !REPO) return { ok: false, why: 'no GitHub token configured' };
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${pr}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: timeout(), // (signal)
  });
  return { ok: res.ok, why: res.ok ? '' : `${res.status}` };
}

// ---------------------------------------------------------------- branches made here
// A branch made on GitHub as one commit over `base`: `files` maps a path to its new text, or to null where the commit
// removes it (mode: an executable's 100755). A branch already there is moved to the new commit. Its commit, or why not.
export async function branchFrom(
  name: string,
  base: string,
  files: { path: string; text: string | null; mode: string }[],
  message: string,
): Promise<{ ok: true; sha: string } | { ok: false; why: string }> {
  if (!GITHUB_TOKEN || !REPO) return { ok: false, why: 'no GitHub token configured' };
  const commit = await gh('GET', `git/commits/${base}`);
  if (!commit.ok) return commit;
  const tree = await gh('POST', 'git/trees', {
    base_tree: (commit.body.tree as { sha: string }).sha,
    tree: files.map(f => ({
      path: f.path,
      mode: f.mode,
      type: 'blob',
      ...(f.text === null ? { sha: null } : { content: f.text }),
    })),
  });
  if (!tree.ok) return tree;
  const made = await gh('POST', 'git/commits', { message, tree: tree.body.sha, parents: [base] });
  if (!made.ok) return made;
  const sha = String(made.body.sha);
  const ref = await gh('POST', 'git/refs', { ref: `refs/heads/${name}`, sha });
  const moved = !ref.ok && ref.status === 422 ? await gh('PATCH', `git/refs/heads/${name}`, { sha, force: true }) : ref;
  return moved.ok ? { ok: true, sha } : moved;
}
// A branch removed from GitHub (one already gone counts as removed)
export async function deleteBranch(name: string) {
  if (!GITHUB_TOKEN || !REPO) return { ok: false, why: 'no GitHub token configured' };
  const res = await gh('DELETE', `git/refs/heads/${name}`);
  return res.ok || res.status === 404 || res.status === 422 ? { ok: true, why: '' } : res;
}
async function gh(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' },
    signal: timeout(),
  });
  if (res.ok) return { ok: true as const, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  return { ok: false as const, status: res.status, why: `${res.status} ${await res.text()}` };
}
