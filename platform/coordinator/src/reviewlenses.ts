// What a round's triage and its readers are told of the lenses: each reader's one discipline, the one reader who looks,
// the readability reader, the foundation question and throwaway work's low bar.
import { FOUNDATION } from './coming.ts';

// The triage's guidance, the readability reader's line included when a first read has one (reviewtriage.ts)
export const brief = (readability?: string) =>
  [LENSES, readability && readabilityLine(readability), FOUNDATION_TRIAGE, THROWAWAY].filter(Boolean).join('\n');

// Each reader's one discipline, and the one reader at most who sees what the change shows
const LENSES = `Each reader looks through one lens, the discipline their role names: give it as their "domain", and keep their
reason to it. A lens on the code (readability, structure, security) reads the diff alone. Seeing what the change shows
(its previews, screenshots, a page check) is one reader's, named in "looker", and only when the change needs a visual
eye: a reader above whose files include what shows, or the consolidator when it reads alone. Otherwise "looker" is null
and nobody renders anything. Configured preview commands cover only their own paths, not every UI change.
If engine constraints move all of the chosen reader's visual files away, the look follows those files to their reader.
If the consolidator has no separate reader seat, its look passes to a reader holding the shown files, or stays with
the consolidator when it reads alone.`;

// The readability reader (org.yaml's roles.readability) reads every first round of lasting code unless triage says why
// not
const readabilityLine = (agent: string) => `Readability and structure are ${agent}'s lens: CODE_STYLE.md, naming,
structure, duplication and designs worth refactoring. On this first read, choose ${agent} with that "domain" for the
code that lasts (code customers use, other code builds on or that keeps running), whatever else you choose. Leave them
out only when there is no such code to read (notes, profiles, copy, data, a one-line setting, throwaway work), with the
reason in "exceptions".`;

// The foundation's paths, as the carry and the foundation report have them (coming.ts)
const paths = FOUNDATION.join(', ');

// Whether a change belongs in the foundation needs judgment, asked of one reader only when the change looks relevant
const FOUNDATION_TRIAGE = `The foundation question (docs/foundation.md): is each change in the foundation's paths (${paths})
a setting, a list entry or a plug-in point any company could use, and marked for the carry; and does code in our own
folders hold something any company would need? Judge whether this change makes the question worth asking: it changes
foundation code, or it may hold something that should be generic. If it does, give it to one reader in "foundation":
most naturally the reader of structure, or a reader you add for it. Otherwise null. Never add a reader for it by habit:
most changes to our own folders don't need it. If engine constraints move files away from that reader, the question
goes with those files to their reader too.`;

// The question as the reader it went to hears it, after their own lens's read (review.ts)
export const FOUNDATION_QUESTION = `
Triage also gave you the foundation question (docs/foundation.md), after your lens's own read and never in its place.
Of each change to the foundation's paths (${paths}): is it a setting, a list entry or a plug-in point any company could
use, or a branch for one company or one need? The second kind is a blocking finding: an if-else on a brand, a company's
name, data or one-off in a foundation file, a fixed list of one company's things, or a one-of-each assumption built
into the code instead of read from the company's own files. Name the line and the generic form it would take. A
foundation change without its \`company: job #<n>, not upstream yet\` mark is a finding whose fix is that mark. Code in
our own folders that any company would need is a nonblocking finding naming where in the foundation it belongs. A
plug-in point nobody needs yet is no finding.
`;

// Whether the change is throwaway, judged from what it is (CODE_STYLE.md): its readers then hold it to the low bar
const THROWAWAY = `Set "throwaway" when the change is work that runs once or twice and goes to the archive: a prototype, a
demo reel, a concept film, a presentation. Its readers then look only at whether it misses the board's vision in an
important way and at real breakage or safety, so one reader, or the consolidator alone, is usually enough. Code that
customers use, that other code builds on, or that keeps running is never throwaway, whatever its folder.`;
