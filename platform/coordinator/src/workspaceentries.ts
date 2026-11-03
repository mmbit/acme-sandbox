// The other company's entries (links.ts receive), applied to our copy of the workspaces we share: each checked as
// outside input, and only in workspaces of the link its key opened. Their company is the link's, whatever an entry says.
import { afterStep, db } from './db.ts';
import { ceo } from './company.ts';
import * as links from './links.ts';
import * as messages from './messages.ts';
import * as files from './workspacefiles.ts';
import {
  FILE_MAX_BYTES,
  TEXT_MAX_CHARS,
  TITLE_MAX_CHARS,
  insert,
  minute,
  now,
  pathOf,
  wordsOf,
  type MessageRow,
  type ThreadRow,
  type WorkspaceRow,
} from './workspaces.ts';

// One entry of theirs, checked as outside input: its shape, and only workspaces of this link. Their company is the
// link's, whatever an entry says.
export function apply(link: links.LinkRow, entry: links.Entry) {
  const at = timeOf(entry.at),
    arrived = now(),
    agent = lineOf(entry.agent, 60, 'agent');
  if (entry.kind === 'workspace') {
    insert('workspaces', {
      uid: uidOf(entry.uid),
      link: link.id,
      title: lineOf(entry.title, TITLE_MAX_CHARS, 'title'),
      ours: 0,
      agent,
      at,
      arrived,
    });
  } else if (entry.kind === 'thread') {
    const workspace = theirWorkspace(link, entry.workspace);
    insert('workspace_threads', {
      uid: uidOf(entry.uid),
      workspace: workspace.id,
      subject: lineOf(entry.subject, TITLE_MAX_CHARS, 'subject'),
      ours: 0,
      agent,
      at,
      arrived,
    });
  } else if (entry.kind === 'message') {
    applyMessage(link, entry, { agent, at, arrived });
  } else if (entry.kind === 'file') {
    applyFile(link, entry, { agent, at, arrived });
  } else if (entry.kind === 'read') {
    applyRead(link, entry);
  } else throw new links.EntryError(`no entry is a "${String(entry.kind)}"`);
}

function applyMessage(link: links.LinkRow, entry: links.Entry, fields: { agent: string; at: string; arrived: string }) {
  const thread = db
    .prepare(
      'select t.* from workspace_threads t join workspaces w on w.id = t.workspace where t.uid = ? and w.link = ?',
    )
    .get(String(entry.thread), link.id) as ThreadRow | undefined;
  if (!thread) throw new links.EntryError('a message names a thread this link has not got');
  const text = textOf(entry.text, TEXT_MAX_CHARS, 'text'),
    urgent = entry.urgent === true,
    wakes = urgent && !waking(link);
  const id = insert('workspace_messages', {
    uid: uidOf(entry.uid),
    thread: thread.id,
    text,
    urgent: urgent ? 1 : 0,
    ours: 0,
    woke: wakes ? 1 : null,
    ...fields,
  });
  if (wakes) afterStep(() => wake(link, thread, id));
}

// An urgent message of theirs that woke our executive and is still unread here: this one waits for that read or the
// hourly check. However many urgent messages a company sends, one wake at a time.
const waking = (link: links.LinkRow) =>
  !!db
    .prepare(
      `select 1 from workspace_messages m join workspace_threads t on t.id = m.thread join workspaces w on w.id = t.workspace
      where w.link = ? and m.woke = 1 and m.read is null`,
    )
    .get(link.id);

function applyFile(link: links.LinkRow, entry: links.Entry, fields: { agent: string; at: string; arrived: string }) {
  const workspace = theirWorkspace(link, entry.workspace);
  const path = pathOf(entry.path);
  if (!path) throw new links.EntryError('a file’s path leaves its workspace');
  const bytes = Buffer.from(String(entry.data ?? ''), 'base64');
  if (bytes.length > FILE_MAX_BYTES) throw new links.EntryError('a file is over the size a version may be');
  if (files.sha256Of(bytes) !== entry.sha256)
    throw new links.EntryError('a file’s bytes are not the ones its sha256 names');
  const sha256 = files.keep(bytes);
  const note = entry.note ? lineOf(entry.note, TITLE_MAX_CHARS, 'note') : '';
  insert('workspace_files', {
    uid: uidOf(entry.uid),
    workspace: workspace.id,
    path,
    sha256,
    size: bytes.length,
    note,
    ours: 0,
    ...fields,
  });
}

// They read messages of ours: each marked read, if it's ours on this link
function applyRead(link: links.LinkRow, entry: links.Entry) {
  if (!Array.isArray(entry.messages)) throw new links.EntryError('a read lists the messages it read');
  const at = timeOf(entry.at);
  for (const uid of entry.messages)
    db.prepare(
      `update workspace_messages set read = ?, read_by = ? where uid = ? and ours = 1 and read is null
      and thread in (select t.id from workspace_threads t join workspaces w on w.id = t.workspace where w.link = ?)`,
    ).run(at, lineOf(entry.agent, 60, 'agent'), String(uid), link.id);
}

// An urgent message of theirs, for our executive now: its running session at the next step, else a job of its own. Each
// is one line of JSON, an envelope their text can't close (outsidewords.ts PARTNER).
function wake(link: links.LinkRow, thread: ThreadRow, message: number) {
  const m = db.prepare('select * from workspace_messages where id = ?').get(message) as MessageRow;
  const fields = {
    company: link.name,
    workspace: thread.workspace,
    thread: thread.id,
    subject: thread.subject,
    from: m.agent,
    at: `${minute(m.at)} UTC`,
    text: m.text,
  };
  // (JSON leaves the line breaks past ASCII as they are, the next line and the line and paragraph separators: escaped
  // too, so it stays one line)
  const words = JSON.stringify(fields).replace(
    /[\u0085\u2028\u2029]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  messages.fromPartner(ceo(), thread.workspace, `Urgent from ${link.name}: ${thread.subject}`, words);
}

function theirWorkspace(link: links.LinkRow, uid: unknown) {
  const row = db.prepare('select * from workspaces where uid = ? and link = ?').get(String(uid), link.id) as
    WorkspaceRow | undefined;
  if (!row) throw new links.EntryError('it names a workspace this link has not got');
  return row;
}

// Their entries' text: the same, or the whole push refused
function textOf(given: unknown, max: number, what: string) {
  const text = wordsOf(given, max, what);
  if (Array.isArray(text)) throw new links.EntryError(text[1]);
  return text;
}

// A name, title or note of theirs: one line, its control characters and line separators gone (links.ts nameOf)
const lineOf = (given: unknown, max: number, what: string) =>
  textOf(typeof given === 'string' ? given.replace(links.NOT_ONE_LINE, '') : given, max, what);

const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uidOf(given: unknown) {
  const uid = String(given);
  if (!UID.test(uid)) throw new links.EntryError('an id is a UUID');
  const taken = ['workspaces', 'workspace_threads', 'workspace_messages', 'workspace_files'].some(t =>
    db.prepare(`select 1 from ${t} where uid = ?`).get(uid),
  );
  if (taken) throw new links.EntryError(`${uid} is taken already`);
  return uid;
}

function timeOf(given: unknown) {
  const at = Date.parse(String(given));
  if (Number.isNaN(at)) throw new links.EntryError('every entry has its time, at');
  return new Date(at).toISOString();
}
