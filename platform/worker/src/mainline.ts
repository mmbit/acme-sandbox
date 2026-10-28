// Main's line along its first parents, told to HQ each time main moves (worker.ts tellMain), so a commit that reached it
// outside a pull request HQ merged still gets a push's checks (the coordinator's carries.ts, worker.ts carryChecks).
type Commit = { sha: string; parents: string[] };
export type ToldMain = { commits: Commit[]; after?: string; lost?: string };

// 100 commits are about 15 KB, under HQ's 20 KB a request (shared/routes JSON_MAX)
export const MAIN_LINE = 100;

// Main's last commits, unless its tip is `told` already. A line that doesn't reach the last commit HQ heard of gets HQ's
// answer with that commit: everything main took since goes to HQ in pages, oldest first, each `after` the commit the one
// before ended on, or, with that commit gone from the mirror, the line as `lost` history. Returns the tip told. A request
// that fails throws, and the next telling starts from where HQ got to.
export async function tellMainLine(
  git: { mainLine(count: number): Commit[]; mainSince(seen: string): Commit[] | undefined },
  tell: (told: ToldMain) => Promise<{ seen?: string }>,
  told?: string,
) {
  const line = git.mainLine(MAIN_LINE);
  if (line[0].sha === told) return told;
  const { seen } = await tell({ commits: line });
  if (!seen) return line[0].sha;
  const since = git.mainSince(seen);
  if (!since) await tell({ commits: line, lost: seen });
  for (let at = 0, after = seen; since && at < since.length; at += MAIN_LINE) {
    const page = since.slice(at, at + MAIN_LINE).reverse();
    await tell({ commits: page, after });
    after = page[0].sha;
  }
  return line[0].sha;
}
