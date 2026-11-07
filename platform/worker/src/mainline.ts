// Main's line along its first parents, told to HQ each time main moves (worker.ts tellMain), so a commit that reached it
// outside a pull request HQ merged still gets a push's checks (the coordinator's carries.ts, worker.ts carryChecks).
// `code`: whether it changes anything a push's checks run on (checkedChange), which sizes its carry check
export type CheckScope = { typecheck: boolean; tests: string[] };
type Commit = { sha: string; parents: string[]; code?: boolean; scope?: CheckScope };
export type ToldMain = { commits: Commit[]; after?: string; lost?: string };

// 100 commits with their scopes are tens of KB, far under HQ's 3 MB a request from the worker (the coordinator's
// server.ts SIGNED_IN_MAX)
export const MAIN_LINE = 100;

// Main's last commits, unless its tip is `told` already. A line that doesn't reach the last commit HQ heard of gets HQ's
// answer with that commit: everything main took since goes to HQ in pages, oldest first, each `after` the commit the one
// before ended on, or, with that commit gone from the mirror, the line as `lost` history. Returns the tip told. A request
// that fails throws, and the next telling starts from where HQ got to.
export async function tellMainLine(
  git: { mainTip(): string; mainLine(count: number): Commit[]; mainSince(seen: string): Commit[] | undefined },
  tell: (told: ToldMain) => Promise<{ seen?: string }>,
  told?: string,
) {
  if (git.mainTip() === told) return told;
  const line = git.mainLine(MAIN_LINE);
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

// What a push's checks (shared/gates) spend their time on: the gates lint and type-check code, and the tests run every
// suite of each area a change touches (suites.ts changeAt, areaOf, SUITES). The worker runs from platform/worker alone
// (infra/worker.sh), so their rules are read again here, and mainline.test.ts holds them to shared/gates'.
const CODE = /\.(ts|js|mjs|cjs|css|html)$|(^|\/)(package|tsconfig)\.json$/;
const TYPED = /\.(ts|js|mjs|cjs)$|(^|\/)(package|tsconfig)\.json$/;
const TEST_FILE = /\.test\.(ts|js|mjs)$|(^|\/)test_[^/]*\.(py|sh)$/;
function areaOf(path: string) {
  const parts = path.split('/');
  if (parts.length === 1) return '.';
  const depth = /^(platform|shared|kits|products)$/.test(parts[0]) && parts.length > 2 ? 2 : 1;
  return parts.slice(0, depth).join('/');
}
// The areas holding tests among a tree's files
export const testedAreas = (files: string[]) => new Set(files.filter(f => TEST_FILE.test(f)).map(areaOf));
// Whether a change to these paths gets more than a few seconds of the checks: a code file, or one in an area with tests
export const checkedChange = (paths: string[], tested: Set<string>) =>
  paths.some(path => CODE.test(path) || tested.has(areaOf(path)));

// The checks these paths require: the type check, and the areas with tests in the commit's own tree
export function checkScope(paths: string[], tested: Set<string>): CheckScope {
  return {
    typecheck: paths.some(path => TYPED.test(path)),
    tests: [...new Set(paths.map(areaOf).filter(area => tested.has(area)))].sort(),
  };
}
