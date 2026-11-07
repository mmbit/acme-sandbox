// The company's optional files (brand.yaml, HQ's theme, org.yaml as HQ reads its settings), each parsed again only when
// it changes. Nothing of the coordinator's own is imported here, so the key mask reads the brand too (secrets.ts
// publicKeys) without a cycle through the database.
import { readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import { REPO_DIR } from './config.ts';

// HQ's look: the company's brand and its HQ theme, {} for a file it doesn't have or that doesn't parse (HQ then runs on
// the foundation's defaults, platform/hq/shell/brand.js). The job queue reads the brand's mascots (jobs.ts boardId), so
// a typo in it is logged once, never thrown; each file is parsed again only when it changes.
const read = new Map<string, { stamp: string; value: any; error?: Error; empty: boolean }>();
export const optional = (path: string, shape = (v: any) => v) => parsed(path, shape).value;
// A file as parsed, and why it can't be used: missing, not a map, or not parsing (org.yaml throws it: company.ts). empty:
// the file is missing or holds nothing, which board.ts reads as no profile
export function parsed(path: string, shape = (v: any) => v) {
  const file = `${REPO_DIR}/${path}`,
    s = statSync(file, { throwIfNoEntry: false });
  const stamp = s ? `${s.mtimeMs} ${s.size}` : '';
  if (read.get(path)?.stamp === stamp) return read.get(path)!;
  let value = {},
    error = s ? undefined : new Error(`${path} is missing`),
    empty = !s;
  if (s)
    try {
      const v = parse(readFileSync(file, 'utf8'));
      empty = v == null;
      if (v && typeof v === 'object' && !Array.isArray(v)) value = shape(v);
      else error = new Error(`${path} isn't a map`);
    } catch (err) {
      error = err as Error;
      console.error(`${path} doesn't parse:`, error.message);
    }
  read.set(path, { stamp, value, error, empty });
  return read.get(path)!;
}
// A mascot is a map with its id: mascots that aren't a list of them read as none
export const brand = () =>
  optional('company/brand.yaml', b =>
    b.mascots === undefined
      ? b
      : { ...b, mascots: Array.isArray(b.mascots) ? b.mascots.filter((m: unknown) => m && typeof m === 'object') : [] },
  );
