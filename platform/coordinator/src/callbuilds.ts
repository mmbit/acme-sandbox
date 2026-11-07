// A call's prototype built from a brief: the call's agent asks for one (its prototype tool with a brief), and a
// colleague builds it as a job, the same as any try run (ink/booktry.ts): kind 'try', started at once on a free work
// slot, committing nothing. So it is followed and steered as any job the call queued (activity, add, call_jobs), and
// nothing of it runs on the voice line (knowledge/notes/platform/call-prototypes.md).
//   - Its clip on the call's page shows at once as its placeholder: the clip's group is tried by the build's job, so
//     HQ draws the builder's face and an empty frame being sketched in while it runs, with the time builds usually
//     take (usualMinutes), as a try's versions coming are drawn.
//   - The builder looks at its page as they'll see it (script on) before it saves it: a build's version comes with the
//     picture it looked at (callprototypes.ts fromJob), the one on their screens.
//   - Another brief under its name while it builds is the call's word to that build (call.ts addToJob): one not
//     started takes it in its brief, one running at its next step.
//   - The line hears each build that landed or ended with none (heard, with the call's lines: call.ts kept), and raises
//     the agent's hand for it.
//   - None while the board has left the call to its guest: a build is a colleague's job, and a guest reaches nothing of
//     HQ (callaway.ts boardAway).
import { readFileSync } from 'node:fs';
import { db } from './db.ts';
import { addToJob } from './call.ts';
import { createJob, findAgent, agentName } from './jobs.ts';
import * as models from './models.ts';
import { changed } from './notebook.ts';
import { insertGroup, row } from './notebookgroups.ts';
import { emptyGroup } from '../../hq/shell/ink/notebookparts.js';
import { callPage } from './ink/callpage.ts';
import { boardAway } from './callaway.ts';
import { isBoardLanguage, languageName } from './language.ts';
import { shellQuote } from './shellquote.ts';
import { DIR } from './callprototypes.ts';
import { isRefused, type Refused } from './pagechecks.ts';
import { usualMinutes, type Build } from './callbuildrows.ts';

const NAME_MOST = 60,
  ABOUT_MOST = 200,
  BRIEF_MOST = 4000;
const EFFORTS = ['low', 'medium', 'high'];
const OPEN = "('queued', 'running')";
const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

// The build going under a name on a call, if one is
const openBuild = (call: number, name: string) =>
  db
    .prepare(
      `select b.* from call_builds b join jobs j on j.id = b.job where b.call = ? and b.name = ? and j.status in ${OPEN}`,
    )
    .get(call, name) as Build | undefined;

// POST /api/voice/prototype-build { call, name, brief, about?, by?, lighter?, effort?, lang? }: a prototype built from
// the agent's brief by a colleague (by: their id, else the call's agent itself), on their lighter model (lighter) and
// at an effort (effort), each the agent's judgment of the task. → its job and the words the agent hears, or why not.
export function build(b: any) {
  const at = callPage(b);
  if (isRefused(at)) return at;
  if (boardAway(Number(b.call)))
    return [
      409,
      "the board has left this call to its guest, who isn't the board: a build is a colleague's job, so this stays off \
until the board comes back. Make the page yourself (html) instead.",
    ] as Refused;
  const call = Number(b.call),
    name = oneLine(b.name),
    about = oneLine(b.about ?? ''),
    brief = typeof b.brief === 'string' ? b.brief.trim() : '';
  if (!name || [...name].length > NAME_MOST)
    return [400, `name: the prototype's, at most ${NAME_MOST} characters`] as Refused;
  if (!brief || brief.length > BRIEF_MOST)
    return [400, `brief: what to build, at most ${BRIEF_MOST} characters`] as Refused;
  if ([...about].length > ABOUT_MOST) return [400, `about: one line, at most ${ABOUT_MOST} characters`] as Refused;
  const going = openBuild(call, name);
  if (going) return steer(at.agent, call, going, brief, about);
  const how = builderOf(b, at.agent);
  if (isRefused(how)) return how;
  const { by, lighter } = how;
  const before = latest(call, name),
    version = (before?.version ?? 0) + 1;
  const g = clipGroup(at.page, at.agent, before);
  const job = createJob({
    agent: by,
    kind: 'try',
    title: `Prototype ${before?.name ?? name} v${version}`.slice(0, 140),
    prompt: buildBrief({ call, by: at.agent, name: before?.name ?? name, version, about, brief, lang: b.lang, before }),
    queuedBy: at.agent,
    expedite: true,
    thread: null,
    ...(lighter && { model: lighter.id, light: true }),
    ...(b.effort && { effort: b.effort }),
  }).id;
  held(job, { call, name: before?.name ?? name, version, about }, g.id, at.page);
  const minutes = usualMinutes();
  const usual = minutes ? ` Builds lately took about ${minutes} minute${minutes === 1 ? '' : 's'}.` : '';
  return {
    ok: `${agentName(by)} builds ${before?.name ?? name} v${version} as job #${job}: its placeholder is on the call's \
page now, with ${agentName(by)}'s face, and it lands there and on their screens when it's done.${usual} Follow it with \
activity (#${job}); what they say about it while it's built goes to it with prototype under its name again, or add.`,
    job,
    version,
  };
}

// The build kept with its call (call_jobs: the call's own job, which it follows and steers), and its placeholder: the
// clip's group tried by its job, expecting one version more than it shows (bookversionsof.js versionsOf), drawn again
function held(
  job: number,
  b: Omit<Build, 'job' | 'grp' | 'heard'>,
  grp: number,
  page: Parameters<typeof insertGroup>[0],
) {
  db.prepare('insert or ignore into call_jobs (call, job) values (?, ?)').run(b.call, job);
  db.prepare('insert into call_builds (job, call, name, grp, version, about) values (?, ?, ?, ?, ?, ?)').run(
    ...[job, b.call, b.name, grp, b.version, b.about],
  );
  const shown = db.prepare("select count(*) n from book_slips where grp = ? and style = 'version'").get(grp) as {
    n: number;
  };
  db.prepare('update notebook_groups set tried = ?, expect = ? where id = ?').run(job, shown.n + 1, grp);
  changed(page.notebook, page.id);
}

// Who builds it (by: their id, else the call's agent: a Claude colleague, as a build is steered while it runs) and on
// which model: theirs, or their lighter one (lighter)
function builderOf(b: any, agent: string) {
  const by: string = typeof b.by === 'string' && b.by ? b.by : agent,
    builder = findAgent(by);
  if (!builder) return [404, `by: there's no colleague ${by}: their id, as your briefing names them`] as Refused;
  // (only a Claude session reads a message at its next step: on another engine, what they say while it's built would
  // become a job of its own, never reaching the build: messages.ts send.)
  if ((builder.engine ?? 'claude') !== 'claude')
    return [
      409,
      `by: ${builder.name ?? by} works on ${builder.engine}, and a build is steered while it runs, which only a Claude \
colleague's takes: choose one of them`,
    ] as Refused;
  if (b.effort !== undefined && !EFFORTS.includes(b.effort))
    return [400, `effort: one of ${EFFORTS.join(', ')}`] as Refused;
  const lighter = b.lighter === true ? models.lighterChoices(String(builder.engine))[0] : undefined;
  if (b.lighter === true && !lighter)
    return [409, `${builder.name ?? by}'s engine has no lighter model: leave lighter out`] as Refused;
  return { by, lighter };
}

// Another brief under the name of a build going: the call's word to that build (call.ts addToJob)
function steer(agent: string, call: number, going: Build, brief: string, about: string) {
  const words = `${brief}${about ? `\n(What this version changes, in a line, now: ${about}.)` : ''}`;
  const added = addToJob({ agent, callId: call }, going.job, words);
  if (typeof added === 'number') return [added, 'it could not reach the build just now'] as Refused;
  if (Array.isArray(added)) return added as Refused;
  if (about) db.prepare('update call_builds set about = ? where job = ?').run(about, going.job);
  const when = added.added === 'brief' ? "it hasn't started, so it's in its brief" : 'it reads it at its next step';
  return {
    ok: `${going.name} v${going.version} is still being built (job #${going.job}): this goes to ${agentName(added.agent)}, \
and ${when}.`,
    job: going.job,
    version: going.version,
  };
}

// The newest version of a prototype on the call, if there is one
const latest = (call: number, name: string) =>
  db
    .prepare('select * from call_prototypes where call = ? and name = ? order by version desc limit 1')
    .get(call, name) as { id: number; name: string; version: number; grp: number | null } | undefined;

// The group its clip is: the one its versions are under, while it's on the page, else a new one (callprototypes.ts
// clipOn takes it for the version that lands)
function clipGroup(page: Parameters<typeof insertGroup>[0], agent: string, before?: { grp: number | null }) {
  const had = before?.grp ? row(before.grp) : undefined;
  return had && had.page === page.id && had.deleted === null
    ? had
    : insertGroup(page, 'note', agent, emptyGroup, { h: 0 });
}

// The builder's brief: the call, what to build, at what size, and the look before it lands
function buildBrief(o: {
  call: number;
  by: string;
  name: string;
  version: number;
  about: string;
  brief: string;
  lang: unknown;
  before?: { id: number; version: number };
}) {
  const lang = isBoardLanguage(o.lang) ? languageName(o.lang) : 'the language of the brief';
  const earlier = o.before ? earlierPage(o.before.id) : null;
  const was = o.before
    ? `\n\nThe version before (v${o.before.version}), to build on: keep what works, change what the brief asks${
        o.about ? ` (${o.about})` : ''
      }.${earlier ? `\n\n${earlier}` : " Its page couldn't be read: build it again from the brief."}`
    : '';
  return `${agentName(o.by)} is on a design session with the board (call #${o.call}), and asks you to build a prototype \
for it: the people in it talk on while you work, watching its placeholder on the call's page, and it lands on their \
screens the moment you save it. They iterate on it: each round of their feedback is a next version.

Prototype: ${o.name} (v${o.version}). Its words in ${lang}.

${o.brief}${was}

How:
- Make what's asked, at the size it's asked, and quickly: they're waiting. An infographic, a poster or a diagram is one \
still picture (an SVG in a page), made in about a minute, with no animation or sound. A screen to try is that screen \
with the taps that matter. Motion, sound or a game only when the brief asks for them. Small and right beats big: \
what they want more of, they ask for in the next round.
- One HTML page with everything inline (CSS, script, SVG, data URLs) in a folder of your own outside the repository: \
nothing outside it loads, no fonts, scripts or pictures from the web. It fits a tablet or phone either way round, or \
a laptop, with big touch targets and no hover-only parts. Never anyone's real details.
- Before you save it, look at it as they will: open it with Playwright (Chromium, script on) at 1180 × 820, let it \
settle, take a screenshot and look at the picture against the brief. Everything the brief names is drawn and in its \
place: nothing empty, cut off, overlapping or unreadable. Fix what isn't and look again.
- Then save it with that picture: \`hq prototype --call ${o.call} ${shellQuote(o.name)} <folder> --picture <png>${
    o.about ? ` --about ${shellQuote(o.about)}` : ''
  }\`. It lands as v${o.version}. Only a version saved with the picture you looked at lands.
- What they say while you build reaches you as a message at your next step: take it into this version.
- Never commit, push or open a pull request, and queue no work: your copy of the repository is thrown away when you \
end. Write nothing to anyone.
- End with one line, in ${lang}: what to try first on it, a dozen words or so. If you saved nothing, that line says \
why, plainly: they hear it.`;
}
// The earlier version's page, as its brief quotes it
function earlierPage(id: number) {
  try {
    return readFileSync(`${DIR}/${id}/index.html`, 'utf8');
  } catch {
    return null;
  }
}

// The builds of a call the line hasn't heard of that have ended: each one that landed (its name and version as saved,
// what it changes, and the builder's line on what to try first) or ended with none (why). Each is heard once.
export function heard(call: number) {
  const ended = db
    .prepare(
      `select b.*, j.status, j.result, j.agent from call_builds b join jobs j on j.id = b.job
        where b.call = ? and b.heard = 0 and j.status not in ${OPEN}`,
    )
    .all(call) as (Build & { status: string; result: string | null; agent: string })[];
  return ended.map(b => {
    db.prepare('update call_builds set heard = 1 where job = ?').run(b.job);
    const landed = db
      .prepare('select name, version from call_prototypes where call = ? and name = ? and version = ?')
      .get(call, b.name, b.version) as { name: string; version: number } | undefined;
    const said = (b.result ?? '').trim().split('\n').at(-1)?.trim().slice(0, 300) ?? '';
    const who = agentName(b.agent);
    if (landed) return { name: landed.name, version: landed.version, about: b.about, by: who, line: said, job: b.job };
    const why =
      b.status === 'stopped' || b.status === 'cancelled'
        ? 'its build was stopped'
        : said || `${who}'s build ended without saving it${b.status === 'failed' ? ' (it failed)' : ''}`;
    return { name: b.name, version: b.version, by: who, failed: why, job: b.job };
  });
}

// The call ended: its builds stop, as nothing lands once it's over (callprototypes.ts fromJob). One still queued is
// cancelled; one running stops at its next heartbeat.
export function endedCall(call: number) {
  const now = new Date().toISOString(),
    why = `call #${call} ended, and a prototype is shown only while it's on`;
  for (const { job } of db
    .prepare(`select b.job from call_builds b join jobs j on j.id = b.job where b.call = ? and j.status in ${OPEN}`)
    .all(call) as { job: number }[]) {
    db.prepare(
      "update jobs set status = 'cancelled', seat = null, result = ?, finished = ? where id = ? and status = 'queued' and session is null",
    ).run(`Cancelled: ${why}`, now, job);
    db.prepare("update jobs set stopping = ? where id = ? and status in ('running', 'queued')").run(`hq: ${why}`, job);
  }
}
