// The foundation keeper's seat on a review: its files and its one question.
import { db } from './db.ts';
import { roles } from './company.ts';
import { inFoundation } from './coming.ts';
import type { Read } from './reviewtriage.ts';

// The foundation keeper (org.yaml's roles.foundation) reads every first round that touches the foundation's paths, on
// those files and its one question, whoever else triage chose. The sole-author exclusion applies to this seat too.
export function keeperSeat(pr: number, files: string[], eligible: (agent: unknown) => boolean): Read | undefined {
  const keeper = roles().foundation,
    paths = files.filter(inFoundation),
    { fixes_from } = db.prepare('select fixes_from from prs where number = ?').get(pr) as { fixes_from: string | null };
  if (!keeper || fixes_from || !paths.length || !eligible(keeper)) return undefined;
  return { agent: keeper, files: paths, domain: 'the foundation', security: false, reason: KEEPER_QUESTION };
}
const KEEPER_QUESTION = `the foundation keeper's one question, of each change to these files: is it a setting, a list
entry or a plug-in point any company could use, or a branch for one company or one need? The second kind is a blocking
finding: an if-else on a brand, a company's name, data or one-off in a foundation file, a fixed list of one company's
things, or a one-of-each assumption built into the code instead of read from the company's own files. Name the line and
the generic form it would take (docs/foundation.md). A plug-in point nobody needs yet is no finding. Leave correctness,
security and style to the other readers`;
