// A company's brand.yaml (its own, and the template's a new company starts from) has one colour, `colour:`, which HQ
// and the guest page wear and Wire's colourways mix (platform/coordinator/src/company.ts brandLook): one the change
// leaves that isn't #rrggbb is refused here, before it's deployed, as HQ's look fails on it. Read with the
// coordinator's own YAML parser, as HQ reads it.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Change, Problem } from './output.ts';

const BRANDS = new Set(['company/brand.yaml', 'template/company/brand.yaml']);

export function brandProblems(root: string, changes: Change[]): Problem[] {
  const brands = changes.filter(c => BRANDS.has(c.path));
  if (!brands.length) return [];
  const { parse } = createRequire(join(root, 'platform/coordinator/package.json'))('yaml');
  return brands.flatMap(({ path }): Problem[] => {
    let colour;
    try {
      colour = parse(readFileSync(join(root, path), 'utf8'))?.colour;
    } catch (err) {
      return [{ path, text: `doesn't parse: ${(err as Error).message}` }];
    }
    if (colour === undefined || (typeof colour === 'string' && /^#[0-9a-f]{6}$/i.test(colour))) return [];
    return [
      {
        path,
        text: `its colour ${JSON.stringify(colour)} isn't #rrggbb, which HQ's look needs: write it as six hex digits, quoted (colour: '#4477ff')`,
      },
    ];
  });
}
