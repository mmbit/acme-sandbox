// Looking things up (the coordinator's memory.ts): the knowledge base and more by meaning and words (hq search), this
// agent's own past work (hq history), a call with the board (hq call), and the board's intercom (hq intercom).
import * as api from './api.ts';
import { present, print, stop, text } from './output.ts';

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
};

function jobLines({ id, code, title, status, created, pr, report, report_left_out }: PastJob) {
  const pullRequest = present(pr) ? `, PR #${pr.number} ${text(pr.status)}` : '';
  const left = present(report_left_out) ? `(${text(report_left_out)})` : 'no report';
  return `#${id} ${text(code)} ${text(title)} (${text(status)}${pullRequest}, ${created.slice(0, 10)})\n${text(report ?? left)}\n`;
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
  `Call ${past.id}, ${past.ts.slice(0, 16)}${aboutAndHeard(past)}: ${text(past.pointer)}\n`;

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
                                                     call your job works for, its numbered transcript, as above`,
  //

  // A call this job works for (the call ledger): its transcript, numbered (or lines a to b). Otherwise any call the
  // coordinator shows this agent (memory.ts), every line and its summary.
  async run([id, lines = '']: string[]) {
    if (!/^[0-9]+$/.test(id ?? '') || !/^[0-9]+(-[0-9]+)?$/.test(lines || '1')) stop('usage: hq call <id> [a-b]');
    const answer = await api.call(`call?id=${id}${lines ? `&lines=${lines}` : ''}`);
    if (answer.status === 404) stop(`No call #${id} you can read (it doesn't exist, or it's still going on).`);
    if (answer.status !== 200) stop(`hq call: ${api.errorIn(answer.body, 'no answer')}`);
    const found = JSON.parse(answer.body);
    if (present(found.text)) return print(text(found.text).replace(/\n+$/, ''));
    print(
      `Call ${found.id}, ${text(found.agent)} with the board, ${found.ts.slice(0, 16)}${aboutAndHeard(found)}\n\n${found.lines.join('\n')}${summaryOf(found)}`,
    );
  },
};

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
