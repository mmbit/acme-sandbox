// The workspaces this company shares with linked companies (links.ts): each a link's, with threads of messages between
// the companies' agents and files with every version kept, as both HQs hold them, and how our side reads them. Our
// side's posts are workspaceposts.ts, the other company's entries workspaceentries.ts. The design:
// platform/coordinator/docs/companies.md.
import { db, columnsOf, inOneStep, redacted } from './db.ts';
import * as links from './links.ts';
import * as files from './workspacefiles.ts';

// A version travels whole inside one push, which both HQs read into memory as base64 (4/3 of it): 50 MB is a film's
// worth and still a small part of a coordinator's memory. A bigger asset goes in parts.
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
// A push's JSON at its biggest: one version alone, in base64, and its entry's fields
export const ENTRIES_JSON_MAX = Math.ceil((FILE_MAX_BYTES * 4) / 3) + 1_000_000;
export const TITLE_MAX_CHARS = 120;
export const TEXT_MAX_CHARS = 100_000;
const PATH_MAX_CHARS = 300;

// uid: the id both HQs know it by; ours: written by our side; agent: who wrote it (theirs: as their HQ names them);
// seq: ours, its entry in our log for the link (links.ts takenAt: when their HQ took it). arrived: theirs, when it
// came. read: a message of theirs, when one of us read it (read_by); one of ours, when they said they had. woke: an
// urgent one of theirs that woke our executive (workspaceentries.ts wake).
db.exec(`create table if not exists workspaces (id integer primary key, uid text not null unique, link integer not null,
  title text not null, ours integer not null, agent text not null, at text not null, seq integer, arrived text)`);
db.exec(`create table if not exists workspace_threads (id integer primary key, uid text not null unique,
  workspace integer not null, subject text not null, ours integer not null, agent text not null, at text not null,
  seq integer, arrived text)`);
db.exec(`create table if not exists workspace_messages (id integer primary key, uid text not null unique,
  thread integer not null, text text not null, urgent integer not null default 0, ours integer not null,
  agent text not null, at text not null, seq integer, arrived text, read text, read_by text, woke integer)`);
if (!columnsOf('workspace_messages').includes('woke'))
  db.exec('alter table workspace_messages add column woke integer');
db.exec(`create table if not exists workspace_files (id integer primary key, uid text not null unique,
  workspace integer not null, path text not null, sha256 text not null, size integer not null, note text not null,
  ours integer not null, agent text not null, at text not null, seq integer, arrived text)`);
db.exec(
  'create index if not exists workspace_messages_unread on workspace_messages (thread) where ours = 0 and read is null',
);
redacted('workspace_messages', 'text');

export type Row = {
  id: number;
  uid: string;
  ours: number;
  agent: string;
  at: string;
  seq: number | null;
  arrived: string | null;
};
export type WorkspaceRow = Row & { link: number; title: string };
export type ThreadRow = Row & { workspace: number; subject: string };
export type MessageRow = Row & { thread: number; text: string; urgent: number; read: string | null };
export type FileRow = Row & { workspace: number; path: string; sha256: string; size: number; note: string };
// Who's posting: the job's agent, or a team member of it speaking as itself
export type Poster = { job: number; agent: string };
export type Refusal = [number, string];

// ---- reading

// Each linked company with its workspaces' counts, for Settings › Companies and hq workspace
export function linksWithCounts() {
  const listed = links.listLinks();
  const counted = listed.links.map(link => ({
    ...link,
    workspaces: (db.prepare('select count(*) n from workspaces where link = ?').get(link.id) as { n: number }).n,
    unread: unreadIn('w.link = ?', link.id),
  }));
  return { ...listed, links: counted };
}

// Every workspace, the latest activity first
export function summaries() {
  const rows = db.prepare('select * from workspaces').all() as WorkspaceRow[];
  return rows.map(summaryOf).sort((a, b) => b.last.localeCompare(a.last));
}

export function findWorkspace(id: number, thread?: number) {
  const row = workspaceRow(id);
  if (!row) return null;
  const threads = (
    db.prepare('select * from workspace_threads where workspace = ? order by at, uid').all(id) as ThreadRow[]
  )
    .filter(t => thread === undefined || t.id === thread)
    .map(t => threadOf(row, t));
  return { ...summaryOf(row), threads, files: filesOf(row) };
}

// One version of a file (the newest without `version`, counted from 1), with its bytes
export function fileOf(workspace: number, path: string, version?: number) {
  const row = workspaceRow(workspace);
  const versions = row ? versionsOf(workspace, path) : [];
  const n = version ?? versions.length;
  const file = versions[n - 1];
  if (!row || !file) return null;
  return {
    path,
    version: n,
    size: file.size,
    sha256: file.sha256,
    note: file.note,
    by: authorOf(row, file),
    at: file.at,
    bytes: files.read(file.sha256),
  };
}

// The workspace for one of our agents, the other company's messages in it now read (and their HQ told which)
export function readFor(id: number, thread: number | undefined, reader: Poster) {
  const row = workspaceRow(id);
  if (!row) return [404, `There's no workspace #${id}.`] as Refusal;
  const unread = db
    .prepare(
      `select m.id, m.uid from workspace_messages m join workspace_threads t on t.id = m.thread
      where t.workspace = ? and (? is null or t.id = ?) and m.ours = 0 and m.read is null`,
    )
    .all(id, thread ?? null, thread ?? null) as { id: number; uid: string }[];
  if (unread.length)
    inOneStep(() => {
      const at = now();
      for (const m of unread)
        db.prepare('update workspace_messages set read = ?, read_by = ? where id = ?').run(at, reader.agent, m.id);
      if (linkOpen(row))
        links.record(row.link, { kind: 'read', messages: unread.map(m => m.uid), agent: reader.agent, at });
    });
  return findWorkspace(id, thread);
}

// The other companies' unread messages, a line per thread, for the CEO's summary (summary.ts)
export function unreadLines() {
  const rows = db
    .prepare(
      `select w.id workspace, w.title, l.name company, t.id thread, t.subject, count(*) n, sum(m.urgent) urgent, max(m.at) newest
      from workspace_messages m join workspace_threads t on t.id = m.thread join workspaces w on w.id = t.workspace
      join links l on l.id = w.link where m.ours = 0 and m.read is null group by t.id order by newest`,
    )
    .all() as {
    workspace: number;
    title: string;
    company: string;
    thread: number;
    subject: string;
    n: number;
    urgent: number;
    newest: string;
  }[];
  return rows.map(
    r =>
      `${r.company}, workspace #${r.workspace} ${JSON.stringify(r.title)}, thread #${r.thread} ${JSON.stringify(r.subject)}: ${r.n} unread` +
      `${r.urgent ? ` (${r.urgent} urgent)` : ''}, the newest ${minute(r.newest)} UTC (hq workspace read ${r.workspace} ${r.thread})`,
  );
}

// ---- helpers

export function summaryOf(row: WorkspaceRow) {
  const count = (sql: string) => (db.prepare(sql).get(row.id) as { n: number }).n;
  const last = db
    .prepare(
      `select max(at) at from (select at from workspace_threads where workspace = $w union all select m.at from workspace_messages m
      join workspace_threads t on t.id = m.thread where t.workspace = $w union all select at from workspace_files where workspace = $w)`,
    )
    .get({ w: row.id }) as { at: string | null };
  return {
    id: row.id,
    link: row.link,
    company: companyOf(row),
    linkState: links.findLink(row.link)!.state as 'linked' | 'unlinked',
    title: row.title,
    opened: row.at,
    by: authorOf(row, row),
    threads: count('select count(*) n from workspace_threads where workspace = ?'),
    files: count('select count(distinct path) n from workspace_files where workspace = ?'),
    unread: unreadIn('w.id = ?', row.id),
    urgent: unreadIn('w.id = ? and m.urgent = 1', row.id),
    last: last.at && last.at > row.at ? last.at : row.at,
  };
}

function threadOf(workspace: WorkspaceRow, t: ThreadRow) {
  const rows = db
    .prepare('select * from workspace_messages where thread = ? order by at, uid')
    .all(t.id) as MessageRow[];
  return {
    id: t.id,
    subject: t.subject,
    opened: t.at,
    by: authorOf(workspace, t),
    messages: rows.map(m => ({
      id: m.id,
      at: m.at,
      by: authorOf(workspace, m),
      text: m.text,
      urgent: m.urgent === 1,
      arrived: arrivedOf(workspace, m),
      read: m.read,
    })),
  };
}

function filesOf(workspace: WorkspaceRow) {
  const paths = db
    .prepare('select distinct path from workspace_files where workspace = ? order by path')
    .all(workspace.id) as { path: string }[];
  return paths.map(({ path }) => ({
    path,
    versions: versionsOf(workspace.id, path).map((v, i) => ({
      n: i + 1,
      at: v.at,
      by: authorOf(workspace, v),
      size: v.size,
      sha256: v.sha256,
      note: v.note,
      arrived: arrivedOf(workspace, v),
    })),
  }));
}

// A path's versions in the order both HQs see them: by time, then by uid
export const versionsOf = (workspace: number, path: string) =>
  db
    .prepare('select * from workspace_files where workspace = ? and path = ? order by at, uid')
    .all(workspace, path) as FileRow[];

const arrivedOf = (workspace: WorkspaceRow, row: Row) =>
  row.ours ? links.takenAt(workspace.link, row.seq) : row.arrived;
const authorOf = (workspace: WorkspaceRow, row: Row) => ({
  company: row.ours ? links.ourName() : companyOf(workspace),
  agent: row.agent,
  ours: row.ours === 1,
});
export const companyOf = (workspace: WorkspaceRow) => links.findLink(workspace.link)!.name!;
export const linkOpen = (workspace: WorkspaceRow) => links.findLink(workspace.link)!.state === 'linked';

function unreadIn(where: string, id: number) {
  const sql = `select count(*) n from workspace_messages m join workspace_threads t on t.id = m.thread join workspaces w on w.id = t.workspace
    where ${where} and m.ours = 0 and m.read is null`;
  return (db.prepare(sql).get(id) as { n: number }).n;
}

export const workspaceRow = (id: number) =>
  db.prepare('select * from workspaces where id = ?').get(id) as WorkspaceRow | undefined;
export const threadRow = (workspace: number, id: number) =>
  db.prepare('select * from workspace_threads where workspace = ? and id = ?').get(workspace, id) as
    ThreadRow | undefined;

export function insert(table: string, fields: Record<string, string | number | null>) {
  const names = Object.keys(fields);
  const sql = `insert into ${table} (${names.join(', ')}) values (${names.map(() => '?').join(', ')}) returning id`;
  return (db.prepare(sql).get(...Object.values(fields)) as { id: number }).id;
}

// Our own agents' words: some text, within its size
export function wordsOf(given: unknown, max: number, what: string): string | Refusal {
  const text = typeof given === 'string' ? given.trim() : '';
  if (!text) return [400, `The ${what} is empty.`];
  return text.length <= max ? text : [413, `A ${what} is ${max} characters at most.`];
}

// A path inside the workspace: relative, its parts plain names
export function pathOf(given: unknown) {
  const path = typeof given === 'string' ? given.trim() : '';
  const parts = path.split('/');
  const plain = parts.every(p => p && p !== '.' && p !== '..' && !/[\p{C}\\]/u.test(p));
  return path && path.length <= PATH_MAX_CHARS && plain ? path : null;
}

export const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');
export const now = () => new Date().toISOString();
