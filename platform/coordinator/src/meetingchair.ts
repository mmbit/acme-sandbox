// A meeting's chair (meetings.ts, meetingseats.ts): the CEO, seated in every meeting. What it judges the meeting's progress
// by, the tally it reviews once every seat has handed in, and its summary of the meeting in HQ's news feed.
import { readFileSync } from 'node:fs';
import { Marked } from 'marked';
import { columnsOf, db, meetingChanges, meetingProjects, once } from './db.ts';
import { REPO_DIR } from './config.ts';
import { ceo, companyFormats, feedFrom, projects } from './company.ts';
import { ownerOf } from './projects.ts';
import { escapeHtml } from '../../../shared/html/escape.ts';
import { play, standing, type Forecast, type Standing } from './forecast.ts';
import { seats, type Meeting } from './meetings.ts';

// The chair's part of its seat's briefing (the post's headline and shape at the close)
const HEADLINE = 8;
// ("Is it split for speed?")
export const CHAIR = `You chair this meeting: you keep the whole in shape, and only you close it.
- Keep it moving towards what it was set for. Watch the clock and the progress: \`hq meeting listen\` shows you how long
  it has run and how many lines have been said since the last plan change made in it. When it stops getting anywhere
  (say no plan change in the last twenty minutes, or the same points coming round again), say so, then change course (a
  narrower question, the next item) or wrap up.
- Each seat changes its own plans and hands them in (\`hq meeting hand-in\`), staying in the meeting. Nobody re-checks
  deadlines while changes are still moving: once everyone has handed in, the tally plays the queue with the combined
  changes (it shows in your \`hq meeting listen\` within a few minutes): every deadline and window, against how they
  stood when the meeting began.
- Then review the whole: is it headed in the right direction and in line with our strategy, is the scope right, are the
  threads real threads (one deliverable, done in hours) and the projects real projects (a finished product), do the
  owners' conventions match? Stop sprawl: needless substructures, threads nobody needs, over-engineering, each owner
  with its own conventions. Is it split for speed? Parts that don't need each other go in threads of their own, so they
  run side by side; steps that build on each other go in one thread, where its agents take turns on one branch and one
  review reads them at the end; a wait for another thread's merge only where the work truly needs it merged. Send
  what needs changing back with \`hq meeting reopen <agent>... "what to change"\`: their
  hand-ins reopen, and the tally runs again once they hand in again.
- Close it with \`hq meeting close\` once the review is done (with \`--stalled\` when it has stalled before everyone
  handed in). It gives the meeting's post in HQ's news feed for the board and the company, read on a phone. The
  meeting's topic stays internal. In your own judgment of what they'd want to know, looking forward: what we're going to
  do, what the plan is now. You give the post in parts, each one line, and HQ lays them out:
  - \`--headline\`: what was decided, in at most ${HEADLINE} words.
  - \`--opening\`: one sentence on the meeting as a whole.
  - \`--project "name"\` for each product or project touched, each followed by a \`--decision "…"\` per decision in it.
  - \`--next\`: what happens next.
  About 150 words in all, in plain words: no file paths, no job, card or PR numbers, no "(board, call n)". For example:
  hq meeting close --headline "The editor comes before new levels" \\
    --opening "The owners put the level editor first, so new levels come faster after it." \\
    --project "The puzzle app" --decision "The editor is one thread, done today." --decision "New levels wait for it." \\
    --next "The editor starts now, and every deadline holds."
  Whoever is still in the meeting stops at their next step.`;

// Optional company guidance follows the platform's instructions. The close's checks hold either way.
export const MEETINGS = 'company/playbooks/meetings.md';
export function chair() {
  let own = '';
  try {
    own = readFileSync(`${REPO_DIR}/${MEETINGS}`, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return own ? `${CHAIR}\n\nThe company's own guidance for its meetings (${MEETINGS}):\n${own}` : CHAIR;
}

// What the chair judges progress by: minutes since the start, the lines said, and the latest plan change made in the
// meeting (plan_changes.meeting) with its owner and the lines said since it (since the start when there's none yet).
export function progress(m: Meeting, now = Date.now()) {
  const minutes = (iso: string) => Math.floor((now - Date.parse(iso)) / 60_000);
  const linesAfter = (iso: string) =>
    (db.prepare('select count(*) n from meeting_lines where meeting = ? and at > ?').get(m.id, iso) as { n: number }).n;
  const change = db
    .prepare('select at, by, project from plan_changes where meeting = ? order by id desc limit 1')
    .get(m.id) as { at: string; by: string; project: string } | undefined;
  return {
    minutes: minutes(m.started!),
    lines: linesAfter(''),
    change: change ? { by: change.by, project: change.project, minutes: minutes(change.at) } : null,
    since: linesAfter(change?.at ?? ''),
  };
}

// ---- the tally

// The play once every seat has handed in: each open thread of the meeting's projects (those its seats own, and those it
// changed) and every thread with a window, its planned finish against its window, and how it stood as the meeting went
// live (before). Tasks already carry their saved queue-time estimates.
export type Outlook = { finish: number | null; standing: Standing | null };
export type Tally =
  | { waiting: { job: number; failed: boolean }[] }
  | {
      at: string;
      threads: (Outlook & { id: string; name: string; owner: string; deadline: number | null; was: Outlook | null })[];
    };

const scopeOf = (id: number) =>
  new Set([
    ...projects()
      .list.filter(p => seats(id).some(x => x.agent === p.owner))
      .map(p => p.id),
    ...meetingChanges(id).map(c => c.project),
  ]);
const openThreads = () =>
  db.prepare("select id, name, project from threads where status = 'open'").all() as {
    id: string;
    name: string;
    project: string;
  }[];

// The outlooks a tally compares with: the meeting's threads and every windowed one, as last played (none yet: none)
export function outlooks(id: number, f: Forecast | undefined) {
  const scope = scopeOf(id);
  const out: Record<string, Outlook & { deadline: number | null }> = {};
  for (const t of openThreads()) {
    const o = f?.threads.get(t.id);
    if (o && (scope.has(t.project) || o.deadline !== null || o.aim !== null))
      out[t.id] = { finish: o.finish, standing: standing(o), deadline: o.deadline };
    else if (scope.has(t.project)) out[t.id] = { finish: null, standing: null, deadline: null };
  }
  return out;
}

export function tally(m: Meeting, now: number): Tally {
  const was = m.before ? (JSON.parse(m.before) as Record<string, Outlook>) : {};
  const named = new Map(openThreads().map(t => [t.id, t]));
  return {
    at: new Date(now).toISOString(),
    threads: Object.entries(outlooks(m.id, play(now))).map(([id, o]) => ({
      id,
      name: named.get(id)!.name,
      owner: ownerOf(named.get(id)!),
      ...o,
      was: was[id] ? { finish: was[id].finish, standing: was[id].standing } : null,
    })),
  };
}

// ---- the news feed

// The post's headline apart from the topic, so the topic stays internal (meetings.ts makes it in a new database)
once('2026-10-21-meetings-headline', () => {
  if (!columnsOf('meetings').includes('headline')) db.exec('alter table meetings add column headline text');
});

// The post as the chair gives it at the close (meetingseats.ts close), in parts: a headline of at most HEADLINE words,
// an opening line, each project touched with its decisions, and the next step, every one a line of its own. Their shape
// checked, the summary is laid out from them here, once, as the Markdown the feed shows. A refusal is a string.
const line = (x: unknown) => (typeof x === 'string' && !/[\r\n]/.test(x) ? x.trim() : '');
export function post(given: Record<string, unknown>) {
  const headline = line(given.headline);
  if (!headline) return `give the post a headline (--headline "…"): what was decided, on one line`;
  const words = headline.split(/\s+/).length;
  if (words > HEADLINE) return `the headline has ${words} words: say what was decided in at most ${HEADLINE}`;
  const opening = line(given.opening);
  if (!opening) return 'give the post its opening (--opening "…"): one sentence on the meeting, on one line';
  const projects = (Array.isArray(given.projects) ? given.projects : []).map(
    (p: { name?: unknown; decisions?: unknown }) => ({
      name: line(p?.name),
      decisions: (Array.isArray(p?.decisions) ? p.decisions : []).map(line),
    }),
  );
  if (!projects.length || projects.some(p => !p.name || !p.decisions.length || p.decisions.some(d => !d)))
    return 'give each product or project touched (--project "name") with its decisions after it (--decision "…" each), every one on one line';
  const next = line(given.next);
  if (!next) return 'give the post its next step (--next "…"), on one line';
  const summary = [
    opening,
    ...projects.flatMap(p => ['', `**${p.name}**`, ...p.decisions.map(d => `- ${d}`)]),
    '',
    `**Next:** ${next}`,
  ].join('\n');
  return { headline, summary };
}

// Every meeting its chair closed, as a post in HQ's news feed (company.ts gazette): its headline (the topic for a
// meeting closed before headlines) and the chair's summary as Markdown, raw HTML in it shown as text. It's the board's
// (its feed, not the company's), and carries what HQ draws its cover from (postcover.js): who sat in it, the chair
// first, and the pictures of the projects whose plans it changed, each its own cover else its business's (company.ts
// projects).
const markdown = new Marked({ renderer: { html: ({ text }) => escapeHtml(text) } });
feedFrom(() => summaries());
export function summaries() {
  const formats = companyFormats(),
    { covers, businesses } = projects(),
    businessOf = db.prepare('select business from projects where id = ?');
  return (
    db.prepare("select * from meetings where status = 'done' and summary is not null order by id").all() as Meeting[]
  ).map(x => {
    const ended = Date.parse(x.ended!);
    const date = formats.dayAt(ended);
    const people = [...new Set([ceo(), ...seats(x.id).map(s => s.agent)])];
    const pictures = meetingProjects(x.id).flatMap(p => {
      const business = (businessOf.get(p.id) as { business: string | null } | undefined)?.business; // (done ones too)
      const cover = covers[p.id] ?? businesses.find(b => b.id === business)?.cover;
      return cover ? [cover] : [];
    });
    return {
      slug: `meeting-${x.id}`,
      title: x.headline ?? `Meeting: ${x.topic}`,
      author: ceo(),
      date,
      tags: ['meeting'],
      board: true,
      links: [],
      cover: null,
      meeting: { people, pictures: [...new Set(pictures)] },
      sound: null,
      html: markdown.parse(x.summary!) as string,
      t: `${date}T${formats.time(ended, 'en')}`,
    };
  });
}
