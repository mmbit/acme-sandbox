// Looking things up (the coordinator's memory.ts): the knowledge base and more by meaning and words (hq search), this
// agent's own past work (hq history), a call with the board (hq call), and the board's intercom (hq intercom).
import { writeFileSync } from 'node:fs';
import * as api from './api.ts';
import { savePicture } from './files.ts';
import { minute, present, print, stop, text } from './output.ts';

// (in any of the platform's languages)
export const search = {
  help: `
   hq search "query" [limit]                         search the Handbook, playbooks, department pages, briefs, the knowledge
                                                     base and the newsletter, the shared craft library ([craft]: how to
                                                     make pictures, decks, films, sound and copy; the company's own notes
                                                     win where they disagree), the board's calls with everyone (and their
                                                     summaries), the intercom, and your own job reports and requests, by meaning and
                                                     by words ("what we're for" finds the mission, in any of the platform's
                                                     languages; "#32" and a product's name hit exactly); each hit says where to
                                                     read it (a file:line, hq history '#id', hq call <id> or hq intercom <day>).
                                                     The archive (knowledge/archive/: replaced or finished) comes last,
                                                     after every current hit, each with its "Archived … by …" line`,

  async run([query, limit = '']: string[]) {
    const count = limit || '8';
    if (!query || !/^[0-9]+$/.test(count)) stop('usage: hq search "query" [limit]');
    const found = JSON.parse(await api.get(`search?q=${api.uri(query)}&limit=${count}`));
    if (present(found.words)) print(rankedHow(text(found.words)));
    const hits: Hit[] = found.hits ?? [];
    if (hits.length === 0) return print('Nothing found.');
    const archived = hits.filter(hit => present(hit.archived));
    for (const hit of hits.filter(hit => !present(hit.archived))) {
      print(`${text(hit.title)}\n  ${text(hit.pointer)}  [${text(hit.source)}]\n  ${text(hit.snippet)}\n`);
    }
    if (archived.length > 0) print('From the archive (history, not current: each says what replaced it):\n');
    for (const hit of archived) {
      const note = hit.note ?? 'Archived, with no note on why.';
      print(`${text(hit.title)}\n  ${text(hit.pointer)}  [archived]\n  ${text(note)}\n  ${text(hit.snippet)}\n`);
    }
  },
};

// "(Ranked by words only: …)": how a search ranked when meaning didn't rank everything
const rankedHow = (words: string) => `(${words.slice(0, 1).toUpperCase()}${words.slice(1)}.)\n`;

type Hit = { title: string; pointer: string; source: string; snippet: string; archived?: boolean; note?: string };

//
export const history = {
  help: `
   hq history [query]                                your own recent jobs (status, PR, report), desk phone requests (with
                                                     the board's answers), calls and the meetings you sat in (what each
                                                     seat changed, the chair's summary), newest first; a query narrows
                                                     it, '#35' to that number, a job's code (TOMAK) to that job. A report
                                                     or card about a customer shows only to the job working on it`,

  async run([query = '']: string[]) {
    const past = JSON.parse(await api.get(`history?q=${api.uri(query)}`));
    print("Your jobs (newest first; a report is the job's last message):", ...each(past.jobs, jobLines));
    print('Your desk phone requests:', ...each(past.requests, requestLines));
    print('Your calls with the board:', ...each(past.calls, callLine));
    print('Your meetings:', ...each(past.meetings, meetingLines));
  },
};

const each = <T>(list: T[] | null | undefined, line: (entry: T) => string) =>
  (list ?? []).length === 0 ? ['  none\n'] : list!.map(line);

type PastJob = {
  id: number;
  code: string;
  title: string;
  status: string;
  created: string;
  pr?: { number: number; status: string };
  report?: string;
  report_left_out?: string;
  up?: { from: string; note?: string } | null; // (its hand-up from a lighter model)
};

function jobLines({ id, code, title, status, created, pr, report, report_left_out, up }: PastJob) {
  const pullRequest = present(pr) ? `, PR #${pr.number} ${text(pr.status)}` : '';
  const left = present(report_left_out) ? `(${text(report_left_out)})` : 'no report';
  const handedUp = present(up)
    ? `Handed up from ${text(up.from)}, bigger than it looked${present(up.note) ? `: ${text(up.note)}` : ''}\n`
    : '';
  return `#${id} ${text(code)} ${text(title)} (${text(status)}${pullRequest}, ${created.slice(0, 10)})\n${handedUp}${text(report ?? left)}\n`;
}

type PastRequest = {
  id: number;
  title: string;
  kind: string;
  status: string;
  created: string;
  body?: string;
  left_out?: string;
  answer?: string;
  closing?: string;
};

function requestLines({ id, title, kind, status, created, body, left_out, answer, closing }: PastRequest) {
  const answered = present(answer) ? `\nThe board answered: ${text(answer)}` : '';
  const closed = present(closing) ? `\nHQ: ${text(closing)}` : '';
  return `#${id} ${text(title)} (${text(kind)}, ${text(status)}, ${created.slice(0, 10)})\n${text(body ?? `(${text(left_out)})`)}${answered}${closed}\n`;
}

type PastCall = {
  id: number;
  ts: string;
  request?: number;
  job?: number;
  pointer: string;
  agent?: string;
  lines?: string[];
};

const aboutAndHeard = ({ request, job }: { request?: number; job?: number }) =>
  (present(request) ? `, about request #${request}` : '') + (present(job) ? `, heard by job #${job}` : '');

const callLine = (past: PastCall) =>
  `Call ${past.id}, ${minute(past.ts)}${aboutAndHeard(past)}: ${text(past.pointer)}\n`;

type PastMeeting = {
  id: number;
  topic: string;
  ended: string;
  why: string;
  summary?: string;
  seats: { agent: string; chair: boolean; changed?: string }[];
  pointer: string;
};

function meetingLines({ id, topic, ended, why, summary, seats, pointer }: PastMeeting) {
  const summed = present(summary) ? `\nSummary: ${text(summary)}` : '';
  return `Meeting #${id} ${text(topic)} (${text(why)}, ${ended.slice(0, 10)}): the transcript is ${text(pointer)}${summed}\nWhat each changed:\n${seats.map(seatLine).join('\n')}\n`;
}

const seatLine = ({ agent, chair, changed }: PastMeeting['seats'][number]) =>
  `  ${text(agent)}: ${chair ? 'chaired it' : present(changed) ? text(changed) : '(handed nothing in)'}`;

export const call = {
  help: `
   hq call <id> [a-b]                                a call with the board, yours or a colleague's, every line and its
                                                     summary (one about a customer: only to the jobs working on it); for a
                                                     call your job works for, its numbered transcript, as above
   hq call <id> moments                              a walk-through call's recording (its screen was shown): what was done
                                                     (#14 tapped "Add to basket" (button)) and its transcript's lines
                                                     ([12] Board: ...) in one timeline, each with its time on the
                                                     company's clock
   hq call <id> screen <time> [--out <path>]         a PNG of that call's screen then, the pen's ink drawn, a moment's tap
                                                     ringed: a time of day (17:03:12), a moment (#14) or a time from the
                                                     call's start (+2m10s); saved to --out or a new file
                                                     $TMPDIR/call-<id>-screen.XXXXXX.png, its path and time printed`,
  //

  // A call this job works for (the call ledger): its transcript, numbered (or lines a to b). Otherwise any call the
  // coordinator shows this agent (memory.ts), every line and its summary.
  async run([id, lines = '', ...rest]: string[]) {
    if (/^[0-9]+$/.test(id ?? '') && lines === 'moments' && !rest.length) return moments(id);
    if (/^[0-9]+$/.test(id ?? '') && lines === 'screen') return screen(id, rest);
    if (!/^[0-9]+$/.test(id ?? '') || !/^[0-9]+(-[0-9]+)?$/.test(lines || '1') || rest.length) stop(CALL_USAGE);
    const answer = await api.call(`call?id=${id}${lines ? `&lines=${lines}` : ''}`);
    if (answer.status === 404) stop(`No call #${id} you can read (it doesn't exist, or it's still going on).`);
    if (answer.status !== 200) stop(`hq call: ${api.errorIn(answer.body, 'no answer')}`);
    const found = JSON.parse(answer.body);
    if (present(found.text)) return print(text(found.text).replace(/\n+$/, ''));
    print(
      `Call ${found.id}, ${text(found.agent)} with the board, ${minute(found.ts)}${aboutAndHeard(found)}\n\n${found.lines.join('\n')}${summaryOf(found)}`,
    );
  },
};

const CALL_USAGE = 'usage: hq call <id> [a-b | moments | screen <time> [--out <path>]]';

// hq call <id> moments and screen <time> (the coordinator's callviews.ts timeline, screenAt), on hq call's access.
async function moments(id: string) {
  const found = JSON.parse(await viewed(id, 'moments'));
  print(
    `(Times in ${text(found.timeZone)}.${present(found.untimed) ? ` Only the moments: ${text(found.untimed)}.` : ''})\n`,
  );
  print((found.lines as unknown[]).map(text).join('\n'));
}
async function screen(id: string, args: string[]) {
  const out = args.indexOf('--out'),
    path = out < 0 ? '' : (args[out + 1] ?? '');
  const at = args.filter((_, i) => out < 0 || (i !== out && i !== out + 1));
  if (at.length !== 1 || (out >= 0 && !path)) stop(CALL_USAGE);
  const found = JSON.parse(await viewed(id, 'screen', `&at=${api.uri(at[0])}`));
  let saved = path;
  if (path) writeFileSync(path, Buffer.from(text(found.picture.data), 'base64'), { mode: 0o600 });
  else saved = savePicture(`call-${id}-screen`, 'image/png', text(found.picture.data));
  print(`${text(found.line)} (${Number(found.width)}×${Number(found.height)} px) → ${saved}`);
}
async function viewed(id: string, view: string, more = '') {
  const answer = await api.call(`call?id=${id}&view=${view}${more}`);
  if (answer.status === 200) return answer.body;
  const error = api.errorIn(answer.body, 'no answer');
  // (HQ's bare 404: no such call for this job, as hq call says it)
  stop(
    answer.status === 404 && error === 'not found'
      ? `No call #${id} you can read (it doesn't exist, or it's still going on).`
      : `hq call: ${error}`,
  );
}

function summaryOf({ summary, summary_left_out, job }: { summary?: string; summary_left_out?: string; job?: number }) {
  if (present(summary)) return `\n\nSummary (job #${job}'s report):\n${text(summary)}`;
  if (present(summary_left_out)) return `\n\n(No summary: ${text(summary_left_out)}.)`;
  return '';
}

export const intercom = {
  help: `
   hq intercom <day | days | "words">                the board's intercom chat with the CEO, every line with its time (the
                                                     company's clock) and who said it: a day (2026-10-16), days
                                                     (2026-10-14..2026-10-16) or a day's hours (2026-10-16 09:00-12:00) in
                                                     full, or the lines nearest some words or their meaning, best first.
                                                     A line about a customer or a call for keys shows as a placeholder,
                                                     pictures by number`,

  async run(args: string[]) {
    const span = args.join(' ').trim();
    if (!span) stop('usage: hq intercom <day | days | "words">');
    const answer = await api.call(`intercom?q=${api.uri(span)}`);
    if (answer.status !== 200) stop(`hq intercom: ${api.errorIn(answer.body, 'no answer')}`);
    const found = JSON.parse(answer.body);
    if (Array.isArray(found.days)) return printDays(found);
    if (present(found.words)) print(rankedHow(text(found.words)));
    const hits: IntercomHit[] = found.hits ?? [];
    if (hits.length === 0) return print('Nothing found on the intercom.');
    for (const hit of hits) print(`${text(hit.day)}  (${text(hit.pointer)})\n${text(hit.lines)}\n`);
  },
};

type IntercomHit = { day: string; pointer: string; lines: string };

function printDays(found: { timeZone: string; days: { day: string; lines: string[] }[] }) {
  if (found.days.length === 0) return print(`Nothing on the intercom then (times in ${text(found.timeZone)}).`);
  print(`(Times in ${text(found.timeZone)}.)\n`);
  for (const { day, lines } of found.days) print(`${text(day)}\n${lines.map(text).join('\n')}\n`);
}
