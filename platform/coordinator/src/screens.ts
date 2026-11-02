// What HQ shows the board, judged in pictures whatever files a change touches (org.yaml review.screens). The worker's push
// check renders the board's screens on main and on the pushed commit, each on its own coordinator and pages, and compares
// them (platform/hq/screens-compare.mjs). A push whose screens differ, or whose check couldn't tell, is work of the
// screens' engine-only rule (engineonly.ts onWork: its ruling and fixes run on that model), merges only after that look
// (an expedited one too), and its ruling opens every before and after itself and names them in its answer. A push that
// changes the check's own code can't vouch for its screens, so its check couldn't tell. A push that changes no screen
// costs nothing more.
import { basename } from 'node:path';
import { db } from './db.ts';
import { reviewSettings } from './reviewsettings.ts';
import type { Check } from './review.ts';

// (sheet null, and why, when neither side has a picture of it)
export type Shot = { screen: string; look: string; device: string; sheet?: string | null; why?: string };
// A push's screens: those it changes (none: []), or null when its check couldn't tell
type Shown = Shot[] | null;

// The check's own code: screens-compare.mjs and what it runs from, which the worker runs from the pushed checkout (as
// review.ts checksOwn says of the gates)
const OWN =
  /^platform\/hq\/(screens-(compare|side|shots|seed)|harness|originroute|room-sheet)\.mjs$|^platform\/coordinator\/src\/harness\.ts$|^platform\/worker\/hq\/unpack\.ts$|^shared\/(browser|gates)\//;

// What a render's last line says changed (screens-compare.mjs), or null when it isn't one
function answerOf(said: unknown): Shown {
  const answer = said as { rendered?: unknown; changed?: unknown } | null;
  if (answer?.rendered === false) return [];
  return answer?.rendered === true && Array.isArray(answer.changed) ? (answer.changed as Shot[]) : null;
}

// The check's answer: its report's last JSON line (the tool's own output, never a model's)
function shownBy(check: Check): Shown {
  if (check.passed !== true) return null;
  const line = String(check.report)
    .trim()
    .split('\n')
    .reverse()
    .find(l => l.trim().startsWith('{'));
  try {
    return answerOf(JSON.parse(line ?? ''));
  } catch {
    return null;
  }
}

// A push's check, kept by its commit, and couldn't tell when the pull request's files change the check itself. A
// worker that runs no screens check reports none, and its pushes owe no look.
export function record(pr: number, sha: string, check: Check | undefined, files: string[]) {
  if (!reviewSettings().screens || !check) return;
  const shown = files.some(file => OWN.test(file)) ? null : shownBy(check);
  db.prepare(
    'insert into screens_shown (pr, sha, changed) values (?, ?, ?) on conflict(pr, sha) do update set changed = excluded.changed',
  ).run(pr, sha, shown && JSON.stringify(shown));
}

// What this commit owes the board's look: the screens it changes (null: its check couldn't tell, so the look renders
// them all), or undefined when it owes nothing
export function owed(pr: number, sha: string | null | undefined): Shown | undefined {
  if (!sha || !reviewSettings().screens) return undefined;
  const row = db.prepare('select changed from screens_shown where pr = ? and sha = ?').get(pr, sha) as
    { changed: string | null } | undefined;
  if (!row) return undefined;
  const changed = row.changed === null ? null : (JSON.parse(row.changed) as Shot[]);
  return changed?.length === 0 ? undefined : changed;
}

// Whether any push of the pull request or branch changed the board's screens: its work is the screens rule's
export function changedOn(pr?: number | null, branch?: string | null) {
  if (!reviewSettings().screens) return false;
  return !!db
    .prepare(
      `select 1 from screens_shown s join prs p on p.number = s.pr
      where (p.number = $pr or p.branch = $branch) and (s.changed is null or s.changed != '[]')`,
    )
    .get({ pr: pr ?? null, branch: branch ?? null });
}

const named = (shots: Shot[]) => shots.map(shot => `${shot.screen} (${shot.look}, ${shot.device})`).join(', ');
const sheetOf = (shot: Shot) => `${shot.screen}-${shot.look}-${shot.device}-sheet.png`;
const alike = (a: Shot, b: Shot) => a.screen === b.screen && a.look === b.look && a.device === b.device;
// Changed screens with no picture on either side, and why: the look owes them as much as the rest
const unpictured = (shots: Shot[]) => shots.filter(shot => !shot.sheet);
const whyOf = (shots: Shot[]) =>
  shots.map(shot => `${shot.screen} (${shot.look}, ${shot.device}): ${shot.why ?? 'no picture'}`).join('; ');
const BROKEN =
  "one it can't picture on either side is broken on main as well, and holds this pull request until main is fixed";

// A ruling's step: open every changed screen before and after, and judge it
export function rulingStep(job: { pr: number; sha?: string; stage?: string }) {
  const shots = job.stage === 'ruling' ? owed(job.pr, job.sha) : undefined,
    settings = reviewSettings().screens;
  if (shots === undefined || !settings) return '';
  const { found, owes } = shots === null ? UNTOLD : told(shots);
  return `

## The board's screens, before and after
${found} Render them yourself: \`${settings.run}\`. Open every sheet it lists (Read each PNG: a sheet you didn't open isn't
checked) and judge each after against its before: ${settings.look}
Anything a screen gets wrong is a blocking finding, in every round. Add to your answer, beside "decision":
   "screens": [{"sheet": "<the path you opened>", "saw": "<one line: what changed and whether it holds up>"}]
${owes}`;
}

// The push check couldn't tell: the ruling owes the sheets its own render lists
const UNTOLD = {
  found:
    "This push's screens check couldn't tell whether it changes what HQ shows the board (it couldn't run, or the " +
    "pull request changes the check's own code).",
  owes: `   "screens_render": <your render's last line, the JSON object as it printed it>
"screens" is [] only when that line says nothing changed. A ruling without every sheet its render lists is refused.`,
};

// The push check's changed screens: the ruling owes every one's sheet, and its own render of those the check got no
// picture of
function told(shots: Shot[]) {
  const found = `This push changes what HQ shows the board: ${named(shots)}.`,
    owes = `A ruling without every one of these sheets is refused: ${shots.map(sheetOf).join(', ')}.`;
  const blank = unpictured(shots);
  if (!blank.length) return { found, owes };
  return {
    found,
    owes: `${owes}
The check got no picture on either side of ${whyOf(blank)}. Your render must show each one: its sheet in "screens", or,
where your render finds it the same, add "screens_render": <your render's last line, the JSON object as it printed it>.
Render again until it does: ${BROKEN}.`,
  };
}

// Whether a ruling (its parsed answer) that owed the look names every sheet it had to open, and what it saw on each:
// the push check's changed screens, or, when that couldn't tell, those of the ruling's own render ("screens_render"). A
// changed screen with no picture on either side is owed until the ruling's own render shows its sheet, or finds it the
// same.
export function lookProblem(pr: number, sha: string | null, answer: Record<string, unknown>) {
  const shots = owed(pr, sha);
  if (shots === undefined) return undefined;
  const rendered = answerOf(answer.screens_render);
  const toOpen = shots
    ? shots.flatMap(shot => (shot.sheet || !rendered ? [shot] : rendered.filter(again => alike(again, shot))))
    : rendered;
  if (!toOpen)
    return "the push's screens check couldn't tell: \"screens_render\" must be your own render's last line, as it printed it";
  const blank = unpictured(toOpen);
  if (blank.length)
    return `the push changes what HQ shows the board, but these have no picture on either side: ${whyOf(blank)}. Render again until your render shows each one's sheet, and give its last line as "screens_render": ${BROKEN}`;
  const seen = Array.isArray(answer.screens) ? (answer.screens as { sheet?: unknown; saw?: unknown }[]) : [];
  const unseen = toOpen.filter(shot => !seen.some(look => sawSheet(look, shot)));
  if (!unseen.length) return undefined;
  return `the push changes what HQ shows the board: "screens" must list every before/after sheet you opened, with what you saw (missing: ${unseen.map(sheetOf).join(', ')})`;
}

// Whether one of a ruling's "screens" entries is this screen's sheet, with what it saw on it
const sawSheet = (look: { sheet?: unknown; saw?: unknown } | null, shot: Shot) =>
  typeof look?.sheet === 'string' &&
  basename(look.sheet) === sheetOf(shot) &&
  typeof look.saw === 'string' &&
  !!look.saw.trim();
