// What people see, checked in pictures (org.yaml review.visual): a change to those paths is looked at in its previews, in
// every state and setting they render, by its author before the push (a record of the run beside the change) and by every
// reviewer and the ruling (each names the pictures it opened). A picture wrong in any of them is blocking, in every round.
import { matchesGlob } from 'node:path';
import { db } from './db.ts';
import { reviewSettings, type VisualCheck } from './reviewsettings.ts';

export type Applied = VisualCheck & { files: string[] };

// Every visual check these files fall under, each with those of them it covers (its paths, not its except)
export function visualFor(files: string[]): Applied[] {
  const matches = (file: string, paths: string[] = []) => paths.some(path => matchesGlob(file, path));
  return reviewSettings()
    .visual.map(check => ({ ...check, files: files.filter(f => matches(f, check.paths) && !matches(f, check.except)) }))
    .filter(check => check.files.length);
}

// Where a branch's author records their run of a check's previews: one file a branch, its slashes as dashes
export const recordOf = (check: VisualCheck, branch: string) => `${check.record}/${branch.replaceAll('/', '-')}.md`;

// The checks a pull request still owes its author's record of, after this push (`changed`: what it changed since the
// head before it; `files`: what it changes against main). Files a check covers stay owed from push to push, a push sent
// back included, until one carries that check's record, or the pull request no longer changes them (the tool previews
// nothing then).
export function owedPreviews(pr: number, branch: string, changed: string[], files: string[]) {
  const owed = db.prepare('select files from previews_owed where pr = ?').get(pr) as { files: string } | undefined;
  const drawn = [...new Set([...(owed ? (JSON.parse(owed.files) as string[]) : []), ...changed])].filter(file =>
    files.includes(file),
  );
  const checks = visualFor(drawn).filter(check => !changed.includes(recordOf(check, branch)));
  const still = [...new Set(checks.flatMap(check => check.files))];
  if (!still.length) db.prepare('delete from previews_owed where pr = ?').run(pr);
  else
    db.prepare(
      'insert into previews_owed (pr, files) values (?, ?) on conflict(pr) do update set files = excluded.files',
    ).run(pr, JSON.stringify(still));
  return checks;
}

const pictures = (check: Applied) =>
  `${check.files.join(', ')} draw what people see. Render their previews: \`${check.run}\`. Open every picture it ` +
  `lists (Read each PNG: a sheet you didn't open isn't checked) and judge each state in each setting: ${check.look}`;

// The author's step, before a push
export const authorStep = (checks: Applied[], branch: string) =>
  !checks.length
    ? ''
    : `

## The previews, before you push
${checks.map(check => `- ${pictures(check)} Run it with \`--record ${recordOf(check, branch)}\`.`).join('\n')}
Fill in what you saw in each record's last section, and commit the records with the change: a push of these files
without its record comes back to you before any review. Fix what the pictures show first.`;

// A reviewer's step: their report lists the pictures they opened, or the review counts as not run
export const reviewStep = (checks: Applied[]) =>
  !checks.length
    ? ''
    : `

## The previews (required)
${checks.map(check => `- ${pictures(check)} Read the author's record (${check.record}/) too.`).join('\n')}
A state a record skips, or one it calls right that isn't, is a finding. Anything wrong in a picture is a finding,
blocking in every round: what the board sees is what a customer meets. Add to your report, beside "findings" and
"summary":
   "previews": [{"sheet": "<the path you opened>", "saw": "<one line: what it shows in the day and in the dark>"}]
A report without the pictures you opened counts as a review that didn't run.`;

// The ruling's step: open them too before a merge
export const rulingStep = (checks: Applied[]) =>
  !checks.length
    ? ''
    : `

## The previews
${checks.map(check => `- ${pictures(check)}`).join('\n')}
Open them yourself before you rule, and weigh what each reviewer's "previews" says it saw: a picture wrong in any state
or setting is blocking, whatever the round.`;

// Whether a reviewer's report names the pictures it opened
export function sawPreviews(output: string | null) {
  try {
    const seen = JSON.parse(output ?? '')?.previews;
    return (
      Array.isArray(seen) &&
      seen.length > 0 &&
      seen.every(p => typeof p?.sheet === 'string' && p.sheet && typeof p.saw === 'string')
    );
  } catch {
    return false;
  }
}
