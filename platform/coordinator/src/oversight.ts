// The Overseer's read-only route to the status report and the CEO's notes, and the agents' read of the same reports,
// hq report.
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { DATA_DIR, ORIGIN } from './config.ts';
import { db, remember, setting } from './db.ts';
import * as ledger from './ledger.ts';
import * as memory from './memory.ts';
import * as overseer from './overseer.ts';
import { keepMadeKey, secret } from './secrets.ts';

const KEY_NAME = 'OVERSEER_READ_KEY';
// The server's status reports (infra/report.sh writes each here whole, gzipped, named by its UTC time, and keeps two days)
const REPORTS = process.env.STATUS_REPORTS_DIR ?? `${DATA_DIR}/status`;
const REPORT_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.md\.gz$/;
const run = promisify(execFile);

export type Reading = { status: number; text: string; asOf?: string };

// GET /api/overseer/<what>, with the key as a bearer token. `since`: the as-of time of the reader's last answer.
export async function read(what: string, authorization: string | undefined, since: string | null): Promise<Reading> {
  if (!keyMatches(authorization)) return { status: 401, text: "HQ doesn't know this key." };
  const after = since === null ? null : Date.parse(since);
  if (Number.isNaN(after)) return { status: 400, text: 'since is a time, as the last answer gave it.' };
  remember('oversight.read', new Date().toISOString());
  if (what === 'status') return await report({ since: after });
  if (what === 'notes') return notes(after);
  if (/^call\/\d+$/.test(what)) return call(Number(what.slice('call/'.length)));
  return { status: 404, text: 'HQ has three things to read here: status, notes and call/<id>.' };
}

// call/<id>: a call with the board whole, for the Overseer following one up for the board: every line, the items its
// follow-ups recorded (their state and the work on them), and each follow-up's report. Never a call still going on, one
// about a customer (charter rule 7) or one about a card for keys (rule 8): those stay with the jobs working on them.
function call(id: number): Reading {
  const c = db.prepare('select id, ts, agent, status, lines from calls where id = ?').get(id) as
    { id: number; ts: string; agent: string; status: string; lines: string } | undefined;
  if (!c || c.status === 'live') return { status: 404, text: `There's no ended call #${id}.` };
  if (memory.customerCall(id) || memory.keysCall(id))
    return { status: 403, text: `Call #${id} is about a customer or a card for keys: it stays with the jobs on it.` };
  const lines = (JSON.parse(c.lines) as string[]).map((line, i) => `[${i + 1}] ${line}`);
  const items = ledger
    .items(id)
    .map(i => `- #${i.id} ${i.kind}, ${i.owner}, ${i.status}${i.job ? `, job #${i.job}` : ''}: ${i.what}`);
  const followUps = (
    db.prepare("select id, status, result from jobs where call = ? and kind = 'work' order by id").all(id) as {
      id: number;
      status: string;
      result: string | null;
    }[]
  ).map(j => `### Job #${j.id} (${j.status})\n\n${j.result ?? '(no report)'}`);
  const text = [
    `# Call #${id} with ${c.agent}, ${c.ts}`,
    `## Transcript\n\n${lines.join('\n') || '(none)'}`,
    `## Items\n\n${items.join('\n') || '(none recorded)'}`,
    `## Follow-ups\n\n${followUps.join('\n\n') || '(none)'}`,
  ].join('\n\n');
  return { status: 200, text };
}

// Settings › Overseer: the address and key the board gives the Overseer (a key is made the first time), and its last read
export const forBoard = () => ({
  address: `${ORIGIN}/api/overseer/`,
  key: secret(KEY_NAME) || renewKey(),
  read: setting('oversight.read') ?? null,
});

// A new key, which ends the old one: the Overseer reads nothing until it has the new one
export const renew = () => ({ ...forBoard(), key: renewKey() });

function renewKey() {
  const key = `overseer_${randomBytes(32).toString('base64url')}`;
  keepMadeKey(KEY_NAME, key);
  return key;
}

const digest = (text: string) => createHash('sha256').update(text).digest();
function keyMatches(authorization: string | undefined) {
  const key = secret(KEY_NAME);
  return !!key && timingSafeEqual(digest(authorization ?? ''), digest(`Bearer ${key}`));
}

// The newest report whole (with `at`, the newest at or before then); with `since`, what changed from the report the
// reader had then (the newest at or before it) to that one, as a diff whose hunks name their section. Older than every
// kept report: the report whole.
export async function report({
  since = null,
  at = null,
}: {
  since?: number | null;
  at?: number | null;
}): Promise<Reading> {
  const kept = reports(),
    shown = at === null ? kept.at(-1) : kept.findLast(r => Date.parse(r.at) <= at);
  if (!kept.length) return { status: 404, text: 'No status report has reached HQ yet.' };
  if (!shown) return { status: 404, text: `HQ keeps reports from ${kept[0].at} on.` };
  const asOf = shown.at;
  if (since === null) return { status: 200, text: unpacked(shown.file), asOf };
  if (since >= Date.parse(shown.at)) return { status: 200, text: `No report since ${shown.at}.\n`, asOf };
  const had = kept.findLast(r => Date.parse(r.at) <= since);
  if (!had)
    return {
      status: 200,
      text: `HQ keeps reports from ${kept[0].at} on, so here is the one of ${shown.at} whole.\n\n${unpacked(shown.file)}`,
      asOf,
    };
  const changes = await diff(unpacked(had.file), unpacked(shown.file));
  const head = `# What changed in the status report from ${had.at} to ${shown.at}\n\nA unified diff; each hunk's header names its section.\n\n`;
  return { status: 200, text: head + changes, asOf };
}

// The times of the kept reports, oldest first (hq report --list)
export const reportTimes = () => reports().map(r => r.at);

// The kept reports, oldest first, each with its time (ISO, UTC)
function reports() {
  if (!existsSync(REPORTS)) return [];
  return readdirSync(REPORTS)
    .filter(name => REPORT_NAME.test(name))
    .sort()
    .map(name => {
      const [, y, mo, d, h, mi, s] = REPORT_NAME.exec(name)!;
      return { at: `${y}-${mo}-${d}T${h}:${mi}:${s}Z`, file: `${REPORTS}/${name}` };
    });
}
const unpacked = (file: string) => gunzipSync(readFileSync(file)).toString('utf8');

// git's diff of two texts, its file header left out. Each hunk's header carries the nearest `== ` heading above it.
async function diff(before: string, after: string) {
  const dir = mkdtempSync(`${tmpdir()}/oversight-`);
  try {
    writeFileSync(`${dir}/before.md`, before);
    writeFileSync(`${dir}/after.md`, after);
    writeFileSync(`${dir}/attributes`, '* diff=report\n');
    const args = [
      '-c',
      `core.attributesFile=${dir}/attributes`,
      '-c',
      'diff.report.xfuncname=^(== .*)$',
      'diff',
      '--no-index',
      '--no-color',
      '--unified=1',
      `${dir}/before.md`,
      `${dir}/after.md`,
    ];
    let out: { stdout: string };
    try {
      out = await run('git', args, { cwd: dir, maxBuffer: 64 * 2 ** 20, timeout: 30_000 });
    } catch (err) {
      // git diff exits 1 when the texts differ
      if ((err as { code?: number }).code !== 1) throw err;
      out = err as { stdout: string };
    }
    const hunks = out.stdout.indexOf('\n@@');
    return hunks < 0 ? 'No line changed.\n' : out.stdout.slice(hunks + 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The CEO's notes let out after `since`, newest first (all of them without)
function notes(since: number | null): Reading {
  const asOf = new Date().toISOString(),
    text = overseer.releasedSince(since === null ? undefined : new Date(since).toISOString());
  return { status: 200, text, asOf };
}
