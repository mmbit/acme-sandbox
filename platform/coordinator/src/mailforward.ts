// A copy of the company's bookkeeping mail to one address outside it (the board's own, for its books).
// - Which mail: business mail stored at a mailbox brand.yaml's mail.forward names (invoices, documents), at any of our
//   domains, including what a billing sender or an account's receipt rule filed at invoices@ (mail.ts filedTo) and what
//   the board filed from the desk phone. Never the board's own mail or a case's.
// - Where: the server key MAIL_FORWARD_TO, which the board types on a desk-phone card (secrets.ts): never in the repo,
//   a log line or a job.
// - How: each mail goes once, through the email service (mailout.ts): its text under a line saying what it is, and its
//   attachments byte for byte. The mail stays in HQ as before. What a pass finds due goes together, in as few emails as
//   the service's size allows, so the mail already in when the key is saved arrives as one email, or a few.
// - Each mail is tried once. A copy that didn't surely go (the service refused it, or gave no answer, so it may have
//   gone) is told in HQ's log for a person at once, and its row keeps the service's status and words. So is a mail whose
//   files HQ no longer keeps: no copy goes without all of them.
import { readFileSync, statSync } from 'node:fs';
import { db } from './db.ts';
import { publish } from './events.ts';
import { brand, companyDay, names, roles } from './company.ts';
import { secret } from './secrets.ts';
import * as mail from './mail.ts';
import * as mailout from './mailout.ts';
import { isDay } from './metrics.ts';

// A mail whose copy was tried: sent, or why not (the service's status and words, or no status for files no longer kept)
db.exec(`create table if not exists mail_copies (mail integer primary key, tried text not null, sent integer not null,
  status integer, failure text)`);

export const KEY = 'MAIL_FORWARD_TO';
// What an email carries beside its text and files: its headers and the service's JSON around them
const ENVELOPE_BYTES = 64 * 1024;
const mailboxes = (): string[] => [brand().mail?.forward ?? []].flat();
type Copy = {
  id: number;
  box: string;
  subject: string;
  text: string;
  files: { name: string; file: string; type: string }[];
  bytes: number;
};

// A listed file of a mail that HQ no longer keeps (its retention cleared it)
class UnkeptFilesError extends Error {}

// Every mail due a copy. A pass under way is the one asked for.
let running: Promise<void> | null = null;
export const pass = () => (running ??= copyAll().finally(() => (running = null)));

async function copyAll() {
  const to = secret(KEY),
    boxes = mailboxes();
  if (!to || !boxes.length || !mailout.ready('live')) return;
  const due = db
    .prepare(
      `select mail.id, mail.recipient from mail left join mail_copies c on c.mail = mail.id
    where mail.business = 1 and mail.board = 0 and c.mail is null order by mail.id`,
    )
    .all() as { id: number; recipient: string }[];
  const copies = due.flatMap(({ id, recipient }) => {
    const box = mail.mailboxOf(boxes, recipient);
    if (!box) return [];
    try {
      return [copyOf(id, box)];
    } catch (e) {
      if (!(e instanceof UnkeptFilesError)) throw e;
      failed([id], null, e.message);
      return [];
    }
  });
  for (const group of packed(copies, mailout.maxBytes() - ENVELOPE_BYTES)) if (!(await send(group, to))) return;
}

// One mail as its copy: the line saying what it is over its text, and its files (read as its email goes)
function copyOf(id: number, box: string): Copy {
  const m = mail.getMail(id) as {
    sender: string;
    recipient: string;
    subject: string;
    body: string | null;
    received: string;
    attachments: string | null;
  };
  const listed: unknown[] = JSON.parse(m.attachments ?? '[]'),
    files = listed.map((_, n) => mail.attachment(id, n));
  if (!files.every((a): a is NonNullable<typeof a> => !!a))
    throw new UnkeptFilesError('HQ no longer keeps all of its attachments');
  const head =
    `A copy of mail #${id} to ${m.recipient}, from ${m.sender}, received ${m.received.slice(0, 16).replace('T', ' ')} UTC.` +
    (m.subject ? ` Subject: ${m.subject}.` : '') +
    (files.length ? ` Attached: ${files.map(a => a.name).join(', ')}.` : '');
  const text = `${head}\n\n${m.body ?? ''}`;
  // base64 takes 4 bytes for every 3, and JSON may escape every character of the text
  const bytes = files.reduce((sum, a) => sum + Math.ceil(statSync(a.file).size / 3) * 4, 2 * Buffer.byteLength(text));
  return { id, box, subject: m.subject, text, files, bytes };
}

// Copies into as few groups as fit the size (the largest first, each into the first group with room), each group oldest
// first. One copy past the size goes alone, for the service to refuse.
function packed(copies: Copy[], size: number) {
  const groups: { copies: Copy[]; bytes: number }[] = [];
  for (const c of [...copies].sort((a, b) => b.bytes - a.bytes)) {
    const room = groups.find(g => g.bytes + c.bytes <= size);
    if (room) {
      room.copies.push(c);
      room.bytes += c.bytes;
    } else groups.push({ copies: [c], bytes: c.bytes });
  }
  return groups.map(g => g.copies.sort((a, b) => a.id - b.id)).sort((a, b) => a[0].id - b[0].id);
}

// One email with the group's copies: false when the service isn't there to send it, so the pass waits for the next one
async function send(group: Copy[], to: string) {
  const ids = group.map(c => c.id),
    one = group.length === 1;
  const subject = one ? `Fwd: ${group[0].subject}`.trim() : `Fwd: ${group.length} mails, #${ids[0]} to #${ids.at(-1)}`;
  const text =
    (one ? '' : `Copies of ${group.length} mails, oldest first. Each one's files are attached as they came.\n\n`) +
    group.map(c => c.text).join('\n\n----\n\n');
  const named = namedOf(ids);
  try {
    await mailout.send('live', {
      to,
      from: `${group[0].box}@${mailout.domains()[0]}`,
      subject,
      text,
      attachments: group.flatMap(c =>
        c.files.map(a => ({
          filename: a.name,
          content: readFileSync(a.file),
          type: a.type || 'application/octet-stream',
        })),
      ),
      about: `the copy of ${named}`,
    });
  } catch (e) {
    if (!(e instanceof mailout.MailError)) throw e;
    if (e.status === 503) return false;
    failed(ids, e.status, e.message);
    return true;
  }
  for (const id of ids) tried(id, 1, null, null);
  publish({ type: 'log', agent: roles().inbox, text: `Mail: a copy of ${named} went to the forward address` });
  return true;
}

// Copies that didn't surely go: on their rows, and told for a person
function failed(ids: number[], status: number | null, failure: string) {
  for (const id of ids) tried(id, 0, status, failure);
  const named = namedOf(ids);
  publish({
    type: 'log',
    agent: roles().process,
    text: `Mail: NEEDS A PERSON: the copy of ${named} to the forward address didn't go: ${failure}`,
  });
}

const namedOf = (ids: number[]) => (ids.length === 1 ? `mail #${ids[0]}` : `mails #${ids.join(', #')}`);

// The try on the mail's row
const tried = (id: number, sent: number, status: number | null, failure: string | null) =>
  db
    .prepare('insert into mail_copies (mail, tried, sent, status, failure) values (?, ?, ?, ?, ?)')
    .run(id, new Date().toISOString(), sent, status, failure);

// ---- the company's own report to the same address: a month's books, sent by Finance (org.yaml's roles.finance)
// - What: the report's text as one text file (its bytes as Finance made them) under a short body, which HQ heads with what
//   it is (an automated summary from the company's Finance, not a customer's message) and the date of its records.
// - Once: each month and kind (its preview, its close) is one email, ever, by its row here (this HQ is the company's
//   own, so the company is in the identity). A second ask answers the first's receipt and sends nothing. A send that
//   surely didn't go (the service refused it) may be asked again; one that may have gone (no answer, or HQ cut off mid-send)
//   goes again only when asked with `again`, once a person has looked; one they found in the inbox is marked arrived
//   (`confirmArrival`), with no receipt, and asked again sends nothing. Without the address, a mailbox or the email service nothing
//   is kept: the month stays pending. A failure is told in HQ's log for a person, as a copy's is.
// - Its receipt is the service's id for the email, which says the service took it, not that it arrived (mailout.ts tells a
//   delivery failure it hears of, by the send's about). No receipt ever holds the address.
db.exec(`create table if not exists forward_reports (month text not null, kind text not null, state text not null,
  records text not null, tried text not null, receipt text, status integer, failure text, confirmed text,
  primary key (month, kind))`);
// (a send cut off by a restart may have gone)
db.prepare(
  "update forward_reports set state = 'uncertain', failure = 'HQ restarted mid-send' where state = 'sending'",
).run();

export const REPORT_KINDS = ['preview', 'closed'] as const;
type ReportKind = (typeof REPORT_KINDS)[number];
export type ReportState = 'accepted' | 'arrived' | 'not ready' | 'failed' | 'uncertain' | 'sending';
export type ReportReceipt = {
  month: string;
  kind: ReportKind;
  state: ReportState;
  records?: string;
  tried?: string;
  receipt?: string;
  failure?: string;
  confirmed?: string;
  already?: boolean;
};
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Every report's state, or one month's: what the next ask would find
// (a bad month: why, as a string)
export function reports(month?: string): ReportReceipt[] | string {
  if (month !== undefined && !MONTH.test(month)) return 'month: YYYY-MM';
  const rows = db
    .prepare(`select * from forward_reports where ? is null or month = ? order by month, kind desc`)
    .all(month ?? null, month ?? null) as any[];
  return rows.map(receiptOf);
}

// One report, as Finance asks it (hq mail summary): the month (YYYY-MM), its kind, the records' date (YYYY-MM-DD), the
// text file (base64) and the body. A refusal is [status, why]; every outcome of a send is a receipt.
export async function sendReport(request: Record<string, unknown>): Promise<ReportReceipt | [number, string]> {
  const report = asked(request);
  if (Array.isArray(report)) return report;
  const { month, kind, records } = report;
  const previousReceipt = db
    .prepare('select * from forward_reports where month = ? and kind = ?')
    .get(month, kind) as any;
  if (['accepted', 'arrived', 'sending'].includes(previousReceipt?.state))
    return { ...receiptOf(previousReceipt), already: true };
  if (previousReceipt?.state === 'uncertain' && request.again !== true)
    return { ...receiptOf(previousReceipt), already: true };
  const to = secret(KEY);
  // (ready as the copies are: an address, a bookkeeping mailbox to send from, the email service)
  if (!to || !mailboxes().length || !mailout.ready('live')) return { month, kind, state: 'not ready', records };
  db.prepare(
    `insert into forward_reports (month, kind, state, records, tried) values (?, ?, 'sending', ?, ?)
    on conflict (month, kind) do update set state = 'sending', records = excluded.records, tried = excluded.tried,
    receipt = null, status = null, failure = null`,
  ).run(month, kind, records, new Date().toISOString());
  const email = emailOf(report);
  try {
    const { id } = await mailout.send('live', { to, ...email });
    publish({ type: 'log', agent: roles().finance, text: `Mail: ${email.about} went to the forward address` });
    return reported(report, 'accepted', id, null, null);
  } catch (e) {
    if (!(e instanceof mailout.MailError)) {
      reported(report, 'uncertain', null, null, 'HQ failed mid-send');
      throw e;
    }
    const sure = e.status !== 504;
    publish({
      type: 'log',
      agent: roles().process,
      text: `Mail: NEEDS A PERSON: ${email.about} to the forward address ${sure ? "didn't go" : 'may not have gone'}: ${e.message}`,
    });
    return reported(report, sure ? 'failed' : 'uncertain', null, e.status, e.message);
  }
}

type Report = { month: string; kind: ReportKind; records: string; bytes: Buffer; body: string };
// What was asked, or why it can't be sent
function asked(request: Record<string, unknown>): Report | [number, string] {
  const month = String(request.month ?? ''),
    kind = String(request.kind ?? '') as ReportKind,
    records = String(request.records ?? ''),
    body = String(request.body ?? '').trim();
  if (!MONTH.test(month)) return [400, 'month: YYYY-MM'];
  if (!REPORT_KINDS.includes(kind)) return [400, `kind: ${REPORT_KINDS.join(' or ')}`];
  if (!isDay(records)) return [400, "records: the records' date, YYYY-MM-DD"];
  const thisMonth = companyDay(Date.now()).slice(0, 7);
  if (month > thisMonth) return [400, 'month: not after the current month on the company clock'];
  if (kind === 'closed' && month === thisMonth)
    return [400, 'closed: only a month that has ended on the company clock'];
  const monthEnd = new Date(`${month}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  if (kind === 'closed' && records < monthEnd.toISOString().slice(0, 10))
    return [400, 'closed: records must cover the last day of the month'];
  if (!body) return [400, 'the body: nonempty text'];
  const bytes = typeof request.file === 'string' ? Buffer.from(request.file, 'base64') : Buffer.alloc(0);
  if (!bytes.length) return [400, 'the attachment: a nonempty text file'];
  try {
    utf8.decode(bytes);
  } catch {
    return [400, 'the attachment: UTF-8 text'];
  }
  return { month, kind, records, bytes, body };
}

// The report's email, all but its address: from the first bookkeeping mailbox, the file as it is (text/plain, the bare
// type Lettermint's examples use: its bytes are UTF-8 as asked)
function emailOf({ month, kind, records, bytes, body }: Report) {
  const preview = kind === 'preview',
    company = names().name,
    box = mailboxes()[0];
  return {
    from: `${box}@${mailout.domains()[0]}`,
    subject: `${company} books: ${month}${preview ? ' preview' : ''}`,
    text:
      `An automated summary from ${company}'s Finance agent, sent by HQ to the address saved for the books: not a ` +
      `customer's message. Records as of ${records}.\n\n${body}\n`,
    attachments: [
      {
        filename: `${slug(company)}-books-${month}${preview ? '-preview' : ''}.txt`,
        content: bytes,
        type: 'text/plain',
      },
    ],
    about: `${company}'s books for ${month}${preview ? ' (preview)' : ''}`,
  };
}

// A send that may have gone, found in the inbox by a person (the board, on a desk-phone card): arrived, so it never goes
// again. Its month and kind (YYYY-MM, preview or closed). A refusal is [status, why].
export function confirmArrival(request: Record<string, unknown>): ReportReceipt | [number, string] {
  const month = String(request.month ?? ''),
    kind = String(request.kind ?? '') as ReportKind;
  if (!MONTH.test(month)) return [400, 'month: YYYY-MM'];
  if (!REPORT_KINDS.includes(kind)) return [400, `kind: ${REPORT_KINDS.join(' or ')}`];
  const row = db.prepare('select state from forward_reports where month = ? and kind = ?').get(month, kind) as any;
  if (row?.state !== 'uncertain')
    return [409, `only a send that may have gone is confirmed: this one is ${row?.state ?? 'never asked'}`];
  db.prepare("update forward_reports set state = 'arrived', confirmed = ? where month = ? and kind = ?").run(
    new Date().toISOString(),
    month,
    kind,
  );
  return receiptOf(db.prepare('select * from forward_reports where month = ? and kind = ?').get(month, kind));
}

// The send's outcome on its row, as its receipt
function reported(
  { month, kind }: Report,
  state: ReportReceipt['state'],
  receipt: string | null,
  status: number | null,
  failure: string | null,
) {
  db.prepare(
    'update forward_reports set state = ?, receipt = ?, status = ?, failure = ? where month = ? and kind = ?',
  ).run(state, receipt, status, failure, month, kind);
  return receiptOf(db.prepare('select * from forward_reports where month = ? and kind = ?').get(month, kind));
}

const receiptOf = (r: any): ReportReceipt => ({
  month: r.month,
  kind: r.kind,
  state: r.state,
  records: r.records,
  tried: r.tried,
  ...(r.receipt ? { receipt: r.receipt } : {}),
  ...(r.failure ? { failure: r.failure } : {}),
  ...(r.confirmed ? { confirmed: r.confirmed } : {}),
});

// A file name's part from the company's name: lower case letters and digits, dashes between
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

setInterval(
  () => pass().catch(e => console.error('Mail: the copies to the forward address failed:', e)),
  300_000,
).unref();
