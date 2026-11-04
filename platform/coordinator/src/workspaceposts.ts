// Our side's posts in a workspace shared with a linked company (workspaces.ts): a workspace opened, a message, a file's
// new version. Each becomes an entry for the other company's HQ (links.ts record). What stays home is refused here.
import { randomUUID } from 'node:crypto';
import { db, inOneStep } from './db.ts';
import { holdsCustomerData, holdsKeys } from './jobs.ts';
import * as links from './links.ts';
import { redact } from './secrets.ts';
import * as files from './workspacefiles.ts';
import {
  FILE_MAX_BYTES,
  TEXT_MAX_CHARS,
  TITLE_MAX_CHARS,
  companyOf,
  insert,
  linkOpen,
  now,
  pathOf,
  summaryOf,
  threadRow,
  versionsOf,
  wordsOf,
  workspaceRow,
  type Poster,
  type Refusal,
  type WorkspaceRow,
} from './workspaces.ts';

export function openWorkspace(company: unknown, title: unknown, by: Poster) {
  const link = linkNamed(company);
  if (!link)
    return [404, `We're not linked to "${String(company)}": hq workspace lists the linked companies.`] as Refusal;
  const words = ourWords(title, TITLE_MAX_CHARS, 'title', by);
  if (Array.isArray(words)) return words;
  const id = inOneStep(() => {
    const uid = randomUUID(),
      at = now();
    const seq = links.record(link.id, { kind: 'workspace', uid, title: words, agent: by.agent, at });
    return insert('workspaces', { uid, link: link.id, title: words, ours: 1, agent: by.agent, at, seq });
  });
  return { workspace: summaryOf(workspaceRow(id)!) };
}

// A new title for a workspace our side opened (the opening company names it), for both HQs. held: their HQ doesn't take
// renames yet, so it shows the old title until it does (linklog.ts).
export function renameWorkspace(given: Record<string, unknown>, by: Poster) {
  const row = workspaceRow(Number(given.workspace));
  if (!row) return [404, `There's no workspace #${String(given.workspace)}.`] as Refusal;
  if (!linkOpen(row)) return [409, `${companyOf(row)} is unlinked: the workspace can be read, not changed.`] as Refusal;
  if (!row.ours)
    return [
      403,
      `${companyOf(row)} opened workspace #${row.id}, so its title is theirs to change: ask them.`,
    ] as Refusal;
  const title = ourWords(given.title, TITLE_MAX_CHARS, 'title', by);
  if (Array.isArray(title)) return title;
  const seq = inOneStep(() => {
    db.prepare('update workspaces set title = ? where id = ?').run(title, row.id);
    return links.record(row.link, { kind: 'title', workspace: row.uid, title, agent: by.agent, at: now() });
  });
  return { workspace: summaryOf(workspaceRow(row.id)!), held: seq === null };
}

// A message in a thread of the workspace, or the first of a new one (subject)
export function post(given: Record<string, unknown>, by: Poster) {
  const row = workspaceRow(Number(given.workspace));
  if (!row) return [404, `There's no workspace #${String(given.workspace)}.`] as Refusal;
  if (!linkOpen(row))
    return [409, `${companyOf(row)} is unlinked: the workspace can be read, not added to.`] as Refusal;
  const text = ourWords(given.text, TEXT_MAX_CHARS, 'message', by);
  if (Array.isArray(text)) return text;
  const thread = given.thread == null ? null : threadRow(row.id, Number(given.thread));
  if (given.thread != null && !thread)
    return [404, `Workspace #${row.id} has no thread #${String(given.thread)}.`] as Refusal;
  const subject = thread ? thread.subject : ourWords(given.subject, TITLE_MAX_CHARS, 'subject', by);
  if (Array.isArray(subject)) return subject;
  const urgent = given.urgent === true;
  return inOneStep(() => {
    const at = now();
    const threadId = thread?.id ?? newThread(row, subject, by, at);
    const uid = randomUUID(),
      threadUid = (db.prepare('select uid from workspace_threads where id = ?').get(threadId) as { uid: string }).uid;
    const seq = links.record(row.link, { kind: 'message', uid, thread: threadUid, text, urgent, agent: by.agent, at });
    const message = insert('workspace_messages', {
      uid,
      thread: threadId,
      text,
      urgent: urgent ? 1 : 0,
      ours: 1,
      agent: by.agent,
      at,
      seq,
    });
    return { thread: threadId, message };
  });
}

// A new version of a file in the workspace
export function putFile(given: Record<string, unknown>, by: Poster) {
  const row = workspaceRow(Number(given.workspace));
  if (!row) return [404, `There's no workspace #${String(given.workspace)}.`] as Refusal;
  if (!linkOpen(row))
    return [409, `${companyOf(row)} is unlinked: the workspace can be read, not added to.`] as Refusal;
  const path = pathOf(given.path);
  if (!path)
    return [
      400,
      'A path in the workspace: folders and a name, like briefs/vision.md, never / first, .. or an empty part.',
    ] as Refusal;
  const bytes = typeof given.data === 'string' ? Buffer.from(given.data, 'base64') : null;
  if (!bytes) return [400, 'The file comes as data, in base64.'] as Refusal;
  if (bytes.length > FILE_MAX_BYTES)
    return [
      413,
      `A version is ${FILE_MAX_BYTES / 1024 / 1024} MB at most: one push carries it whole. Split a bigger one.`,
    ] as Refusal;
  const note = given.note == null ? '' : wordsOf(given.note, TITLE_MAX_CHARS, 'note');
  if (Array.isArray(note)) return note;
  const refused = homeRefusal(by, bytes.toString('utf8')) ?? homeRefusal(by, `${path} ${note}`);
  if (refused) return refused;
  inOneStep(() => {
    const uid = randomUUID(),
      at = now(),
      sha256 = files.keep(bytes);
    const fields = { uid, workspace: row.uid, path, sha256, size: bytes.length, note, agent: by.agent, at };
    const seq = links.record(row.link, { kind: 'file', ...fields });
    insert('workspace_files', { ...fields, workspace: row.id, ours: 1, seq });
    files.clearOld();
  });
  return { path, version: versionsOf(row.id, path).length };
}

function newThread(row: WorkspaceRow, subject: string, by: Poster, at: string) {
  const uid = randomUUID();
  const seq = links.record(row.link, { kind: 'thread', uid, workspace: row.uid, subject, agent: by.agent, at });
  return insert('workspace_threads', { uid, workspace: row.id, subject, ours: 1, agent: by.agent, at, seq });
}

// What stays home: nothing from a job that holds a customer's details or heard about a card for keys, and no text
// with a key in it (house rules 7 and 8). Refused rather than masked, so the agent sees why.
function homeRefusal(by: Poster, text: string): Refusal | undefined {
  if (holdsCustomerData(by.job))
    return [403, "This job holds a customer's details, which never leave the company: post from a job that doesn't."];
  if (holdsKeys(by.job)) return [403, 'This job heard a call about a card for keys: post from a job that didn’t.'];
  if (redact(text) !== text)
    return [403, 'It holds a key from our key store, which never leaves the company: take it out.'];
}

// A linked company by its link's id or its name
function linkNamed(company: unknown) {
  const { links: listed } = links.listLinks();
  const wanted = String(company ?? '')
    .trim()
    .toLowerCase();
  return listed.find(l => l.state === 'linked' && (String(l.id) === wanted || l.name?.toLowerCase() === wanted));
}

// Our agents' words, which go to the other company: refused if they're empty, too long or shouldn't leave home
function ourWords(given: unknown, max: number, what: string, by: Poster) {
  const words = wordsOf(given, max, what);
  return Array.isArray(words) ? words : (homeRefusal(by, words) ?? words);
}
