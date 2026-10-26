// Memory (#934): one search over what the company knows and what each agent did, for jobs (hq search, hq history,
// hq call) and for calls (the call agent's search, history and call tools). The board asked the CEO for the mission on a call
// and nobody found it; an agent had no trace of their own request; the CEO couldn't find the call where the board had spent
// 15 minutes explaining the support chat's human contact. Chunks carry a title and a pointer back to the source. Words
// rank by sqlite FTS5 (bm25) plus exact '#n' numbers, and meaning by a small local embedding model, fused by rank: "#32"
// and a product's name still hit exactly, and "what we're for" (or "waarvoor bestaan we") finds the mission. Nothing leaves the
// server, and no text here reaches the board's views: these are agent API routes only (the board is never shown its own
// words back), but for nearest()'s ids, which HQ's search matches to its own lists.
//
// Who sees what. The company's files (below) are everyone's, and so are the board's calls with every agent (#1877), each
// with its summary: the report of the job that heard it, and the intercom, a document a day (intercom.ts: a line about a
// customer, or one that came of a call about a card for keys, as its placeholder).
// Everything else is its own agent's only: its jobs' reports, its desk phone requests and the board's answers (no job or
// request is summarised across agents but through a call). A customer's own details (charter rule 7) go only to the job
// working on them and org.yaml's roles.customerData (jobs.ts Reader): a job's report that holds them, a customer card and a call about a customer are left out for any
// other job, its own agent's included.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { columnsOf, db, inOneStep, once, redacted, setting } from './db.ts';
import { DATA_DIR, REPO_DIR } from './config.ts';
import * as jobs from './jobs.ts';
import type { Reader } from './jobs.ts';
import * as ledger from './ledger.ts';
import * as intercom from './intercom.ts';
import * as meetingrecord from './meetingrecord.ts';
import { jobsOfCode } from './jobcodes.ts';
import { carriesKeys, keysCondition } from './chat.ts';
import * as latency from './latency.ts';
import { SMALL_WORDS } from './language.ts';

// Texts in, one unit-length vector each (a model may embed a question and a passage differently, like e5's "query: ").
export type Embedder = (texts: string[], kind: 'query' | 'passage') => Promise<Float32Array[]>;
// shared: every agent may read it (the files, and the board's calls but those below); otherwise its agent's only.
type Doc = { doc: string; agent: string | null; source: string; title: string; pointer: string; text: string; shared: boolean; md?: boolean };
// The many that rarely change, read only when their stamp moved: a file's (by its stat) and a job's report (by when it
// ended, its length and the keys' last scrub: db.ts scrub() masks a key in place, a report as long as before).
type Stamped = Omit<Doc, 'title' | 'text'> & { title?: string; stamp: string; load: () => { title?: string; text: string } };
type Row = { id: number; doc: string; agent: string | null; source: string; title: string; pointer: string; body: string; note: string | null; shared: number };

// note: an archived chunk's "> Archived <date> by <who>: <why, what replaced it>" line (below), shown with the hit.
// vec: each chunk's meaning (below), once the model has read it. shared: whether every agent may read a chunk (Doc's
// shared), which each index pass sets from the sources' rules.
db.exec(`
  create table if not exists memory (id integer primary key, doc text not null, agent text, source text not null,
    title text not null, pointer text not null, body text not null, hash text not null, note text, vec blob,
    shared integer not null default 0);
  create index if not exists memory_doc on memory (doc);
  create index if not exists memory_unembedded on memory (id) where vec is null;
  create table if not exists memory_docs (doc text primary key, hash text not null, stamp text);
  create virtual table if not exists memory_fts using fts5(title, body, tokenize = 'unicode61 remove_diacritics 2');
  create virtual table if not exists memory_vocab using fts5vocab(memory_fts, 'row');`);
// memory_unembedded: the model's next chunks are found without reading every chunk's row on each pass. stamp: a
// Stamped document's (below), so a pass reads only those whose stamp moved.
once('2026-10-22-memory-stamps', () => {
  if (!columnsOf('memory_docs').includes('stamp')) db.exec('alter table memory_docs add column stamp text');
});
// What a hit shows comes from these rows, so a key saved just now leaves them at once (db.ts scrub()), and the word index
// with the next pass.
redacted('memory', 'title', 'body');
// A search counts the chunks, and the archive's, on each question (ranked()): from this index, not by reading every chunk's
// row with its text and vector.
db.exec('create index if not exists memory_source on memory (source)');
// And ranks its words' hits by whose they are (ranked()): from this one, as `shared` is the row's last column, after the
// text and the vector. With each one's document: a candidate is judged on the index, and only a hit's row is read.
once('2026-10-24-memory-whose-doc', 'drop index if exists memory_whose');
db.exec('create index if not exists memory_whose on memory (id, source, agent, shared, doc)');

// The shared files, and why. Out, on purpose: mail (customer data, and outside text); products/ and code
// (grep finds them better, and a product folder can hold order data); people/ profiles (each agent is given its own; the
// older lines the sweep archives are in, below). A file only counts where it really is: a symlink out of its folder (to
// a key under DATA_DIR/secrets, say) is skipped.
// The archive (knowledge/archive/) is a search source of its own, ranked last: ARCHIVE, chunks()' notes, ranked().
const ARCHIVE = 'archive';
const INTERCOM = 'intercom';
const FILES: [string, string, RegExp][] = [
  ['company', 'handbook', /^[^/]+\.md$/],             // the Handbook: the charter (the mission), decisions, authority
  ['company/playbooks', 'playbook', /\.md$/],         // how we work
  ['company/departments', 'department', /\.md$/],     // who does what
  ['company/briefs', 'brief', /\.md$/],               // what the board asked for, as briefed to the team
  ['knowledge/notes', 'note', /\.md$/],               // the knowledge base: learnings, never customer data (its own rule)
  ['knowledge/posts', 'post', /(^|\/)index\.md$/],    // the newsletter
  // The foundation's craft library, every company's: how to make good pictures, decks, films, sound and copy. Its README
  // is the library's index, not a note. Labelled apart, because a company's own notes win where the two disagree.
  ['shared/craft', 'craft', /^(?!README\.md$)[^/]+\.md$/],
  // What the janitor moved out of the live files because it was done or replaced, word for word.
  // History, not current: ranked below every live hit (ranked()) and marked, each hit with its piece's "Archived" line.
  // Everyone's, like the files it came from: notes, decisions, the shared memory and older profile lines, all in git and
  // readable by every job already. Charter rules 7 and 8: the sweep never archives a credential or a customer's or the board's
  // personal data, profile lines included, so nothing here is anything a job couldn't read before.
  ['knowledge/archive', ARCHIVE, /^(?!README\.md$).*\.md$/],
];
// A call still live (the call ledger makes its row when it starts: ledger.ts) has no transcript yet. Once it has ENDED,
// every agent reads it (search, hq call), since what the board said on it may be anyone's to act on (the CEO couldn't
// find the earlier call). But a call about a card for keys (own_only) is its own agent's: the board may read a key out
// on it, and speech-to-text writes it down in a form the mask can't match (secrets.ts redact()). And a call about a
// customer goes only to the jobs working on it (readsCall): one about a customer card (customer_card), or one whose
// follow-up holds a customer's own details (customer_data, so its summary does too). Its summary is the report of the
// job that heard it (calls.job: its follow-up, or for a call about a request the job that heard it, jobs.ts tell()),
// once that job is done. The CEO's intercom chat job hears calls too: its last message is a reply in a conversation,
// not a report, and never a summary. A call that carried on from a customer call (calls.resumes: its briefing had that
// call's transcript) is about the customer too, from its start (customer_before), and so is a call a look-up on it
// handed a customer's details (customer_read: jobs.ts readerHanded). One that
// carried on from a card for keys is its own agent's too, through any further call that carried on from it (own_only).
//
const CALLS = `select *, customer_card or customer_data or customer_read or customer_before customer from (select c.id, c.ts, c.agent, c.request, c.lines, c.job, c.status = 'live' live,
  ${keysCondition()} own_only,
  coalesce(r.customers, 0) customer_card, c.customers customer_read,
  sj.agent heard_by, sj.kind heard_kind, sj.status heard_status, sj.result summary, coalesce(sj.customers, 0) customer_data,
  coalesce(sj.kind = 'work' and sj.status = 'done' and coalesce(sj.result, '') != '', 0) reported,
  exists (select 1 from json_each(c.resumes) e join calls ec on ec.id = e.value left join requests er on er.id = ec.request
    left join jobs ej on ej.id = ec.job where coalesce(er.customers, 0) or coalesce(ej.customers, 0) or ec.customers) customer_before   --
  from calls c left join requests r on r.id = c.request left join jobs sj on sj.id = c.job)`;
const ENDED = 'not live';
// Kind work only: reviews are the panel's, and the CEO's intercom chat is a conversation with the board, not a report.
// (step, round: a job's name, nameOf.)
// (bytes, finished: its report's stamp, Stamped. A pass reads them a page at a time by id: +status keeps it off the status
// index, whose rows would be sorted again for each page.)
const JOB_COLUMNS = 'id, agent, title, step, round, status, finished, octet_length(result) bytes';
const JOBS = `select ${JOB_COLUMNS} from jobs where kind = 'work' and status in ('done', 'failed') and octet_length(result) > 0`;
const JOBS_PAGE = `select ${JOB_COLUMNS} from jobs where id > ? and kind = 'work' and +status in ('done', 'failed') and octet_length(result) > 0 order by id limit 500`;
// A request is its asking job's agent's (a team member asks under its own name in its lead's job). Not a seat's sign-in.
// closing: HQ's line on a card whose matter ended by itself, apart from the answer.
const REQUESTS = `select r.id, coalesce(j.agent, r.agent) agent, r.title, r.body, r.status, r.answer, r.closing from requests r left join jobs j on j.id = r.job
  where r.kind != 'login' and coalesce(j.agent, r.agent) is not null`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
const real = (f: string) => { try { return realpathSync.native(f); } catch { return ''; } };
const stamp = (f: string) => { const s = statSync(f, { throwIfNoEntry: false }); return s ? `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` : ''; };

const who = (agent: string, names = new Map<string, string>()) => {
  if (!names.has(agent)) names.set(agent, String(jobs.findAgent(agent)?.name ?? agent));
  return names.get(agent)!;
};
const callTitle = (c: { id: number; ts: string; agent: string; request: number | null }, names?: Map<string, string>) =>
  `Call ${c.id}: ${who(c.agent, names)} with the board, ${String(c.ts).slice(0, 10)}${c.request ? `, about request #${c.request}` : ''}`;

// A pass gives the server its thread back about every STEP_MS, so requests run between its steps: listing, reading and
// hashing every document in one go takes seconds on a busy machine. Its writes go in steps of their own (sync()).
// A step that still held the server half a second is in the status report's holds by name (latency.ts held).
const STEP_MS = 20;
const stepper = () => {
  let since = performance.now();
  const due = () => performance.now() - since >= STEP_MS;
  return {
    due,
    async pause(always = false) {
      if (!always && !due()) return;
      const ms = performance.now() - since;
      if (ms >= 500) latency.held(`the search index's pass: one step ${Math.round(ms)} ms`, ms);
      await new Promise<void>(resolve => setImmediate(resolve));
      since = performance.now();
    },
  };
};

async function docs(): Promise<(Doc | Stamped)[]> {
  const out: (Doc | Stamped)[] = [], repo = real(REPO_DIR), step = stepper();
  for (const [dir, source, only] of FILES) {
    const root = real(`${REPO_DIR}/${dir}`);
    if (!repo || root !== `${repo}/${dir}`) continue;       // missing, or a symlink (out of the repo, or to a folder left out)
    for (const f of (readdirSync(root, { recursive: true }) as string[]).filter(f => only.test(f)).sort()) {
      const path = `${dir}/${f}`, file = real(`${root}/${f}`);
      if (!file.startsWith(`${root}/`)) continue;             // a symlink out of its folder: never read, never shown
      if (source !== ARCHIVE && file.startsWith(`${repo}/knowledge/archive/`)) continue;   // defence in depth: no live root holds the archive today
      out.push({ doc: `file:${path}`, agent: null, source, pointer: path, shared: true, md: true, stamp: stamp(file), load: () => {
        const text = read(file);
        const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
        return { title: fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? text.match(/^# (.+)$/m)?.[1] ?? path, text };
      } });
      await step.pause();
    }
  }
  const report = db.prepare('select result from jobs where id = ?'), page = db.prepare(JOBS_PAGE), scrubbed = setting('scrubbed') ?? '';
  for (let last = 0, js: any[]; (js = page.all(last)).length; last = js.at(-1).id, await step.pause()) {
    for (const j of js) out.push({ doc: `job:${j.id}`, agent: j.agent, source: 'job',
      title: `Job #${j.id}: ${jobs.nameOf(j)} (${j.status})`, pointer: `hq history '#${j.id}'`, shared: false,
      stamp: `${j.finished}:${j.bytes}:${scrubbed}`, load: () => ({ text: (report.get(j.id) as { result: string } | undefined)?.result ?? '' }) });
  }
  for (const r of db.prepare(REQUESTS).all() as any[]) out.push({ doc: `request:${r.id}`, agent: r.agent, source: 'request',
    title: `Request #${r.id}: ${r.title} (${r.status})`, pointer: `hq history '#${r.id}'`,
    text: `${r.body}${r.answer ? `\n\nThe board answered: ${r.answer}` : ''}${r.closing ? `\n\nHQ: ${r.closing}` : ''}`, shared: false });
  await step.pause();
  const names = new Map<string, string>();   // (org.yaml is read once a pass, not once a call)
  for (const c of db.prepare(`${CALLS} where ${ENDED}`).all() as any[]) {
    const title = callTitle(c, names), shared = !c.own_only;
    out.push({ doc: `call:${c.id}`, agent: c.agent, source: 'call', title, pointer: `hq call ${c.id}`, text: JSON.parse(c.lines).join('\n'), shared });
    if (c.reported) out.push({ doc: `summary:${c.id}:${c.job}`, agent: c.agent, source: 'summary', title: `${title} › summary (job #${c.job}'s report)`,
      pointer: `hq call ${c.id}`, text: c.summary, shared });
    await step.pause();
  }
  await step.pause();
  for (const [day, lines] of intercom.everyDay()) out.push({ doc: `${INTERCOM}:${day}`, agent: null, source: INTERCOM,
    title: `The intercom with the board, ${day}`, pointer: `hq intercom ${day}`, text: lines.join('\n'), shared: true });
  // (an ended meeting's transcript, a document each: meetingrecord.ts.)
  for (const m of meetingrecord.transcripts()) out.push({ doc: `meeting:${m.id}`, agent: null, source: 'meeting', title: m.title,
    pointer: `hq meeting ${m.id}`, text: m.text, shared: true });
  return out;
}

// About 128 tokens a chunk (all the model reads), split at Markdown headings, then between lines. In the archive, also
// where each piece starts: its "> Archived …" blockquote (one file holds many pieces, newest first), so a chunk is one
// piece's and carries its note. A piece ends at the next heading as high as the one it's under: a profile's "## Working
// memory" after its "## Track record" pieces, or the next decision's "## <date>" (its own line comes after it); a whole
// note's own "## " sections, under its "# " title, stay its piece's. A piece also starts at its heading: what comes before
// its line under that same heading (a whole note's title and intro, above the blockquote) gets its line too. A file's own
// intro, under its "# " title before a profile's "## Track record", has none.
const MAX = 600;
function chunks(d: Doc) {
  const out: { title: string; body: string; pointer: string; note: string | null }[] = [], lines = d.text.split('\n');
  let head = '', cur: string[] = [], size = 0, at = 1, fence = false, note: string | null = null, level = 0, under = 0, since = 0;
  const flush = () => { const body = cur.join('\n').trim(); if (body) out.push({ title: head ? `${d.title} › ${head}` : d.title, body, pointer: d.md ? `${d.pointer}:${at}` : d.pointer, note }); cur = []; size = 0; };
  const fm = d.md ? d.text.match(/^---\n[\s\S]*?\n---\n/)?.[0].split('\n').length ?? 1 : 1;
  for (let i = fm - 1; i < lines.length; i++) {
    const l = lines[i];
    if (d.md && l.startsWith('```')) fence = !fence;
    const h = d.md && !fence ? l.match(/^(#{1,4})\s+(.+)/) : null;
    if (h) {
      flush(); head = h[2].trim() === d.title ? '' : h[2].trim(); at = i + 1; level = h[1].length;
      if (level <= under) note = null;
      since = out.length;
      continue;
    }
    if (d.source === ARCHIVE && !fence && /^>\s*Archived\b/.test(l)) {
      flush(); under = level;
      const quote: string[] = [];
      for (let j = i; j < lines.length && lines[j].startsWith('>'); j++) quote.push(lines[j].replace(/^>\s?/, '').trim());
      note = quote.join(' ').trim();
      for (const c of out.slice(since)) c.note ??= note;
    }
    for (const p of l.length <= MAX ? [l] : l.match(/[^]{1,600}(?:\s+|$)|[^]{600}/g)!) {
      if (size + p.length > MAX && size) { flush(); at = i + 1; }
      if (!size) at = i + 1;
      cur.push(p); size += p.length + 1;
    }
  }
  flush();
  return out;
}

// A Stamped document read, in Doc's field order: a document's stored hash is of its Doc's JSON
function loaded({ stamp: _, load, ...d }: Stamped): Doc {
  const got = load();
  return { doc: d.doc, agent: d.agent, source: d.source, title: got.title ?? d.title ?? '', pointer: d.pointer, text: got.text, shared: d.shared, ...(d.md ? { md: d.md } : {}) };
}

// Only what changed is indexed again (a hash per document), and only the chunks that changed are embedded again (a hash
// per chunk: one that moved keeps its vector); what's gone from the repo or the query above is dropped. A Stamped
// document is read only when its stamp (with the rest it was listed with) moved, and indexed again only if its text did.
async function sync(all: (Doc | Stamped)[]) {
  const known = new Map((db.prepare('select doc, hash, stamp from memory_docs').all() as { doc: string; hash: string; stamp: string | null }[]).map(r => [r.doc, r]));
  const restamp = db.prepare('update memory_docs set stamp = ? where doc = ?');
  const rows = db.prepare('select id, hash from memory where doc = ?'), del = db.prepare('delete from memory where id = ?'), delFts = db.prepare('delete from memory_fts where rowid = ?');
  const add = db.prepare('insert into memory (doc, agent, source, title, pointer, body, hash, note, shared) values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addFts = db.prepare('insert into memory_fts (rowid, title, body) values (?, ?, ?)');
  const move = db.prepare('update memory set pointer = ?, agent = ?, source = ?, note = ?, shared = ? where id = ?');
  const gone = (id: number) => { del.run(id); delFts.run(id); vecs?.delete(id); };
  const drop = (doc: string) => { for (const r of rows.all(doc) as { id: number }[]) gone(r.id); };
  let changed = 0;
  // A step's worth of documents, then the server's turn
  const each = (listed: Doc | Stamped) => {
    const was = known.get(listed.doc), stamp = 'load' in listed ? sha(JSON.stringify(listed)) : null;
    known.delete(listed.doc);
    if (stamp && was?.stamp === stamp) return;
    const d = 'load' in listed ? loaded(listed) : listed, h = sha(JSON.stringify(d));
    if (was?.hash === h) { if (stamp) restamp.run(stamp, d.doc); return; }
    changed++;
    const old = new Map<string, number[]>();
    for (const r of rows.all(d.doc) as { id: number; hash: string }[]) old.set(r.hash, [...old.get(r.hash) ?? [], r.id]);
    for (const c of chunks(d)) {
      const ch = sha(`${c.title}\n${c.body}`), keep = old.get(ch)?.shift();
      if (keep) {
        move.run(c.pointer, d.agent, d.source, c.note, +d.shared, keep);
        const kept = vecs?.get(keep);
        if (kept) Object.assign(kept, { agent: d.agent, source: d.source, shared: +d.shared });
        continue;
      }
      const id = Number(add.run(d.doc, d.agent, d.source, c.title, c.pointer, c.body, ch, c.note, +d.shared).lastInsertRowid);
      addFts.run(id, c.title, c.body);
    }
    for (const id of [...old.values()].flat()) gone(id);
    db.prepare('insert into memory_docs (doc, hash, stamp) values (?, ?, ?) on conflict(doc) do update set hash = excluded.hash, stamp = excluded.stamp').run(d.doc, h, stamp);
  };
  try {
    const step = stepper();
    for (let i = 0; i < all.length; await step.pause(true)) inOneStep(() => { do each(all[i++]); while (i < all.length && !step.due()); });
    inOneStep(() => { for (const doc of known.keys()) { drop(doc); db.prepare('delete from memory_docs where doc = ?').run(doc); changed++; } });
  } catch (err) { vecs = undefined; throw err; }
  return changed;
}

// The model: paraphrase-multilingual-MiniLM-L12-v2, quantized (about 120 MB, 384 dimensions, 50 languages), trained so a
// sentence and its translation land together: a Dutch question finds the English charter (multilingual-e5-small, tried
// first in #934, ranked Dutch notes above it). It runs here, on onnxruntime-node: no key, no spend, nothing leaves the
// server. Fetched and checked at image build (Dockerfile), read from MEMORY_MODELS with downloads off. No model there, or
// one that won't load: search by words only, and hq search says so.
const MODEL = process.env.MEMORY_MODEL ?? 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', MODELS = process.env.MEMORY_MODELS ?? `${DATA_DIR}/models`;
// What the vectors were made with (the settings row): the model and its pinned revision, so a new one embeds everything again.
const MODEL_ID = `${MODEL}@${process.env.MEMORY_MODEL_REVISION ?? ''}`;
let embedder: Embedder | null | undefined, model = MODEL_ID;
// On a thread of its own (memory-model.ts), so the model's load and each batch never hold a request up. A
// thread that fails or ends takes the model with it: by words only from then on.
let thread: Worker | undefined;
function local(): Embedder | null {
  if (!existsSync(`${MODELS}/${MODEL}`)) { console.warn(`Search: no model at ${MODELS}/${MODEL}, by words only`); return null; }
  const mine = thread = new Worker(new URL('./memory-model.ts', import.meta.url), { workerData: { model: MODEL, models: MODELS } });
  const waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (err: Error) => void }>();
  let asked = 0;
  const e: Embedder = texts => new Promise((resolve, reject) => { waiting.set(++asked, { resolve, reject }); mine.postMessage({ id: asked, texts }); });
  const end = (why: unknown) => {
    if (embedder !== e) return;
    embedder = null;
    if (thread === mine) console.error('Search: the model would not load, by words only:', why);   // (not when stopped: stopModel())
    for (const w of waiting.values()) w.reject(new Error(String(why)));
    waiting.clear();
  };
  mine.on('message', (m: { failed: string } | { id: number; vectors?: Float32Array[]; error?: string }) => {
    if ('failed' in m) return end(m.failed);
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.vectors) w?.resolve(m.vectors); else w?.reject(new Error(m.error));
  });
  mine.on('error', end);
  mine.on('exit', code => {
    end(`its thread ended (${code})`);
    if (thread === mine) thread = undefined;   // (stopModel() has nothing left to wait for)
  });
  mine.unref();   // (after the listeners: a 'message' listener references the thread again; it never keeps a process alive that's done)
  return e;
}
// A deploy's stop (server.ts) waits for the model's thread to end itself between two batches: onnxruntime aborts the whole
// process if its thread is ended in one.
export function stopModel() {
  const stopping = thread;
  thread = undefined;
  if (!stopping) return Promise.resolve();
  const ended = new Promise<void>(resolve => stopping.once('exit', () => resolve()));
  stopping.ref();   // (the process waits for it now)
  stopping.postMessage({ stop: true });
  return ended;
}
const embed = () => embedder === undefined ? (embedder = local()) : embedder;
// Tests use a deterministic fake (no model, no network); null is a server without the model.
export function setEmbedder(e: Embedder | null, id = 'test') { embedder = e; model = e ? id : MODEL_ID; vecs = undefined; }

// Chunks without a vector, 8 at a time. Another model's vectors don't compare: a new model id embeds everything again.
// An index pass can run while a batch embeds: a vector is only kept by a chunk with the same id and the same text.
async function embedPending(e: Embedder) {
  if (!current()) {
    db.prepare('update memory set vec = null').run();
    db.prepare("insert into settings (key, value) values ('memory.model', ?) on conflict(key) do update set value = excluded.value").run(model);
    vecs = undefined;
  }
  const next = db.prepare('select id, title, body, hash from memory where vec is null and id > ? order by id limit 8'), put = db.prepare('update memory set vec = ? where id = ? and hash = ?');
  const embedded = db.prepare('select id, doc, agent, source, shared, vec from memory where id = ?');
  for (let rows, last = 0; (rows = next.all(last) as (Row & { hash: string })[]).length; last = rows[rows.length - 1].id) {
    const v = await e(rows.map(r => `${r.title}\n${r.body}`), 'passage');
    if (embedder !== e) return;   // swapped (a test) or failed to load meanwhile
    try {
      inOneStep(() => rows.forEach((r, i) => {   // (one disk sync a batch)
        if (put.run(new Uint8Array(v[i].buffer, v[i].byteOffset, v[i].byteLength), r.id, r.hash).changes && vecs) vecs.set(r.id, asVector(embedded.get(r.id)));
      }));
    } catch (err) { vecs = undefined; throw err; }   // (a rolled-back batch leaves no entry that the table lacks)
  }
}
// One embedding pass at a time, in the background; a search never waits for it (it ranks what has a vector so far).
let pass: Promise<void> | undefined;
export const embedAll = () => pass ??= (async () => { const e = embed(); if (e) await embedPending(e); })()
  .catch(err => console.error('Search: embedding stopped:', err)).finally(() => { pass = undefined; });

// Brute-force cosine over every vector (tens of thousands of chunks), read once, then kept as the index changes: a chunk
// embedded, moved or dropped changes its own entry (sync(), embedPending()). None while they're another model's (a new
// one's first pass hasn't reset them yet): they don't compare. They're read a page at a time, the server's turn between
// two, by the first that needs them (start() reads them in the background): read in one go, they held the server's
// thread 1.7 s on a busy machine. Changes meanwhile go to the map being filled (vecs), and one that drops it
// (vecs = undefined) starts the read again.
type Vector = { id: number; doc: string; agent: string | null; source: string; shared: number; v: Float32Array };
let vecs: Map<number, Vector> | undefined, reading: Promise<Map<number, Vector>> | undefined;
const asVector = (r: any): Vector => ({ id: r.id, doc: r.doc, agent: r.agent, source: r.source, shared: r.shared, v: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) });
const current = () => (db.prepare("select value from settings where key = 'memory.model'").get() as { value: string } | undefined)?.value === model;
const PAGE = 1_000;
const vectors = async () => vecs && !reading ? vecs : reading ??= readVectors().finally(() => { reading = undefined; });
async function readVectors(): Promise<Map<number, Vector>> {
  const page = db.prepare(`select id, doc, agent, source, shared, vec from memory where vec is not null and id > ? order by id limit ${PAGE}`);
  for (;;) {
    const into = vecs = new Map();
    if (!current()) return into;
    for (let rows, last = 0; vecs === into && (rows = page.all(last) as any[]).length; last = rows[rows.length - 1].id) {
      for (const r of rows) into.set(r.id, asVector(r));
      await new Promise(resolve => setImmediate(resolve));
    }
    if (vecs === into) return into;
  }
}
const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
// The question's vector, or why there's none (what hq search says when it ranked by words only). A model that hangs
// (loading, say) never holds a search up for more than a few seconds.
async function meaning(q: string, wait = 5_000): Promise<{ v: Float32Array } | { why: string }> {
  const e = embed();
  if (!e) return { why: "the search model isn't on this server, or didn't load" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ why: string }>(r => { timer = setTimeout(() => r({ why: 'the search model took too long on this question' }), wait); });
  try { return await Promise.race([e([q], 'query').then(([v]) => ({ v })), late]); }
  catch (err) { console.error('Search: query embedding failed:', err); return { why: 'the search model failed on this question' }; }
  finally { clearTimeout(timer); }
}
// How near a chunk must be to count, measured for this model on our files (job #1878): made-up words like "wombatglue"
// come nearest at about 0.37, "what are we for" finds the charter's Mission at 0.41, and real questions' best hits are
// 0.45 and up. Without it, meaning always finds something, and a history "narrowed" by a word that matches nothing lists
// unrelated work. Another model means measuring it again.
const NEAR = 0.38;

// At start and on a timer: files change with each deploy, jobs and calls as rows arrive. A search reads live rows, never
// only the index (ranked() checks each hit's row), so what the rules leave out is out at once. New chunks are then
// embedded in the background.
// One pass at a time (a pass takes turns with the server's other work): one asked for meanwhile runs after it, so it
// sees what changed since. The number of documents it indexed again or dropped.
let passes: Promise<unknown> = Promise.resolve();
export function refresh() {
  const pass = passes.catch(() => {}).then(async () => { const changed = await sync(await docs()); void embedAll(); return changed; });
  passes = pass;
  return pass;
}
export function start(every = 120_000) {
  const tick = () => refresh().catch(err => console.error('Search: indexing failed:', err));
  setTimeout(tick, 5_000); setInterval(tick, every);
  setTimeout(() => void vectors().catch(err => console.error('Search: reading the vectors failed:', err)), 5_000);
}

// Still what the index says it is, for the reader: a file, a row of its agent's own, or a call that's over (its own
// agent's only, if it's about a card for keys), and its summary while it's still that job's. Each query takes the row's
// id, its agent, the reader's agent and, for a summary, its job. And nothing about a customer the reader wasn't handed
// (readsDoc).
const LIVE: Record<string, string> = {
  job: `select 1 from (${JOBS}) where id = ? and agent = ? and agent = ?`,
  request: `select 1 from (${REQUESTS}) where id = ? and agent = ? and agent = ?`,
  call: `select 1 from (${CALLS}) where id = ? and agent = ? and ${ENDED} and (not own_only or agent = ?)`,
  summary: `select 1 from (${CALLS}) where id = ? and agent = ? and ${ENDED} and (not own_only or agent = ?) and reported and job = ?`,
};
const live = (r: { doc: string; agent: string | null }, reader: Reader) => {
  if (r.agent === null) return r.doc.startsWith('file:') || r.doc.startsWith(`${INTERCOM}:`) || r.doc.startsWith('meeting:');
  const [kind, id, job] = r.doc.split(':');
  return !!LIVE[kind] && !!db.prepare(LIVE[kind]).get(Number(id), r.agent, reader.agent, ...(job ? [Number(job)] : [])) && readsDoc(r.doc, reader);
};

const STOP = new Set(Object.values(SMALL_WORDS).flatMap(words => words.split(/\s+/)));
// Words (bm25), '#n' numbers and meaning, fused by reciprocal rank (k = 60), best chunk per document. The scope is in the
// query itself, so chunks outside it never push the ones in it past its limit: 'own' is only the agent's own jobs,
// requests and calls (history), 'intercom' only the intercom's chunks, each a hit of its own (a day holds many asks).
type Scope = 'all' | 'own' | 'intercom';
async function ranked(q: string, reader: Reader, n: number, scope: Scope = 'all') {
  const { agent } = reader;
  // The question's meaning first, and the vectors, so all the rest runs after the awaits: an index pass can run while it
  // embeds (and reuse an id), and nothing read before them is trusted after. Every hit is still checked against its live row below.
  const m = await meaning(q), vs = 'v' in m ? [...(await vectors()).values()] : [];
  const terms = [...new Set(q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  // Small words (each language's, language.ts) and words in more than a fifth of all chunks ("company") only
  // drown the rest: dropped, unless that's all there is and the index isn't all embedded yet ("what are we for": by
  // meaning, which reads the whole question, and not by four words that are everywhere).
  // The live chunks judge their words on live counts alone: archived copies of a word can't make it common for them (their
  // words' pass would then be skipped, and a live chunk only its words find would drop out under archived hits). The
  // archive judges on the whole index, as before: on its own few chunks, every word its pieces are about would be common.
  const all = db.prepare(`select count(*) n, coalesce(sum(source = '${ARCHIVE}'), 0) a from memory`).get() as { n: number; a: number }, total = all.n;
  // How many chunks hold each word, from the word index alone, and the archive's share of them only where it decides the
  // word for the live chunks: one a fifth of them or fewer hold is rare for them whatever the archive's share, and one
  // more than a fifth hold with every archived chunk taken off is common.
  const kept = total - all.a, holding = db.prepare('select count(*) n from memory_fts where memory_fts match ?');
  // (never `rowid in (…)` beside the match: FTS5 then looks each id up apart, seconds)
  const archived = db.prepare(`select coalesce(sum(rowid in (select id from memory where source = '${ARCHIVE}')), 0) n from memory_fts where memory_fts match ?`);
  const counts = terms.filter(t => !STOP.has(t)).map(t => {
    const { n } = holding.get(`"${t}"`) as { n: number }, decides = n > kept / 5 && n - all.a <= kept / 5;
    return { t, n, a: decides ? (archived.get(`"${t}"`) as { n: number }).n : 0 };
  });
  const archivedVs = vs.filter(c => c.source === ARCHIVE).length;
  const sides = [
    { is: '!=', n: kept, rare: counts.filter(c => c.n - c.a <= kept / 5), unread: vs.length - archivedVs < kept },
    { is: '=', n: all.a, rare: counts.filter(c => c.n <= total / 5), unread: vs.length < total },
  ];
  const mine = (r: { agent: string | null; shared: number; source: string }) =>
    scope === 'intercom' ? r.source === INTERCOM : r.agent === agent || (scope === 'all' && !!r.shared);
  const [whose, whom] = scope === 'intercom' ? [`m.source = '${INTERCOM}'`, []] : [scope === 'own' ? 'm.agent = ?' : '(m.shared or m.agent = ?)', [agent]];
  const score = new Map<number, number>(), fuse = (ids: number[]) => ids.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (60 + i)));
  // Live and archived candidates are taken apart, each its own top 50: the archive after every live hit (below) holds only
  // if no number of archived chunks can crowd the live ones out of the candidates first.
  const apart = (rows: { id: number; source: string }[]) => [rows.filter(r => r.source !== ARCHIVE), rows.filter(r => r.source === ARCHIVE)].forEach(g => fuse(g.slice(0, 50).map(r => r.id)));
  for (const { is, n, rare, unread } of sides) {
    const words = rare.length ? rare.map(c => c.t) : unread ? terms : [];
    if (n && words.length) apart((db.prepare(`select m.id, m.agent, m.source, m.shared from memory_fts f join memory m indexed by memory_whose on m.id = f.rowid
      where memory_fts match ? and ${whose} and m.source ${is} '${ARCHIVE}' order by bm25(memory_fts, 3, 1) limit 300`)
      .all(words.map(t => `"${t}"`).join(' OR '), ...whom) as Row[]).filter(mine));
  }
  // "#32": that number exactly, titles first (the tokenizer drops the #, and 32 alone is everywhere). Looked for among the
  // chunks with the word 32, so a colour like #32a4ff is no hit.
  for (const n of [...new Set(q.match(/#\d+/g) ?? [])].slice(0, 5)) {   // a pasted list can't stall HQ
    const exact = new RegExp(`${n}(?!\\d)`), like = `%${n}%`;
    apart((db.prepare(`select m.id, m.doc, m.agent, m.source, m.shared, m.title, m.body from memory_fts f join memory m on m.id = f.rowid
      where memory_fts match ? and ${whose} and (m.title like ? or m.body like ?)`).all(`"${n.slice(1)}"`, ...whom, like, like) as Row[])
      .filter(r => mine(r) && exact.test(`${r.title}\n${r.body}`)).sort((a, b) => +exact.test(b.title) - +exact.test(a.title)));
  }
  // Meaning: the agent's own chunks and the shared ones (files, the board's calls) only, like the words, nearest first.
  if ('v' in m) apart(vs.filter(mine).map(c => ({ id: c.id, source: c.source, d: dot(c.v, m.v) })).filter(c => c.d >= NEAR).sort((a, b) => b.d - a.d));
  // Best first, but the archive after every live hit, however well it matches: an agent sees the current answer first,
  // and the archived one (history) only below it. A candidate is judged on the index, and only a hit's row is read.
  const light = db.prepare('select id, doc, agent, source, shared from memory indexed by memory_whose where id = ?');
  const whole = db.prepare('select id, doc, agent, source, title, pointer, body, note, shared from memory where id = ?');
  const seen = new Set<string>(), hits: (Row & { score: number })[] = [], old = (r: { source: string }) => +(r.source === ARCHIVE);
  const rows = [...score].map(([id, s]) => ({ ...light.get(id) as Pick<Row, 'id' | 'doc' | 'agent' | 'source' | 'shared'>, score: s }))
    .filter(r => r.id).sort((a, b) => old(a) - old(b) || b.score - a.score);
  for (const r of rows) {
    const key = scope === 'intercom' ? String(r.id) : r.doc;
    if (seen.has(key) || !mine(r) || !live(r, reader)) continue;
    seen.add(key); hits.push({ ...whole.get(r.id) as Row, score: r.score });
    if (hits.length >= n) break;
  }
  // What hq search says when meaning didn't rank everything: no model, or the first index still being built.
  const words = 'why' in m ? `ranked by words only: ${m.why}` : !vs.length ? 'ranked by words only: the search model is still reading the index'
    : vs.length < total ? `ranked by words, and by meaning for ${vs.length} of ${total} parts so far (the index is still being built)` : undefined;
  return { hits, terms, ...(words ? { words } : {}) };
}
function snippet(body: string, terms: string[]) {
  const flat = body.replace(/\s+/g, ' ').trim(), low = flat.toLowerCase();
  const first = Math.min(...terms.filter(t => t.length > 1).map(t => low.indexOf(t)).filter(i => i >= 0)), at = isFinite(first) ? Math.max(0, first - 80) : 0;
  return `${at ? '…' : ''}${flat.slice(at, at + 280)}${at + 280 < flat.length ? '…' : ''}`;
}
const clamp = (n: unknown, d: number) => Math.min(30, Math.max(1, Math.round(Number(n)) || d));

// hq search: ranked hits over the shared files and the token's agent's own work. An archived hit says so, with its
// piece's "Archived <date> by <who>: <why, what replaced it>" line (null if the piece has none: a file's own intro).
export async function search(q: unknown, reader: Reader, limit?: unknown) {
  const query = String(q ?? '').trim();
  if (!query) return 400;
  const { hits, terms, words } = await ranked(query, reader, clamp(limit, 8));
  if (hits.some(h => aboutCustomer(h.doc))) jobs.readerHanded(reader);
  if (hits.some(h => aboutKeys(h.doc))) jobs.handedKeys(reader.id);
  return { ...(words ? { words } : {}), hits: hits.map(h => ({ source: h.source, title: h.title, pointer: h.pointer, snippet: snippet(h.body, terms),
    score: Number(h.score.toFixed(4)), ...(h.source === ARCHIVE ? { archived: true, note: h.note } : {}) })) };
}

// A day read or a search of the intercom
export async function findIntercom(q: unknown, reader: Reader, limit?: unknown, day?: unknown) {
  return day || intercom.isSpan(q) ? intercom.read(day || q) : searchIntercom(q, reader, limit);
}

// hq intercom "words": the intercom's lines nearest the words or their meaning, a few lines around each, best first, with
// the day each is on (hq intercom <day> reads it whole: intercom.ts)
export async function searchIntercom(q: unknown, reader: Reader, limit?: unknown) {
  const query = String(q ?? '').trim();
  if (!query) return 400;
  const { hits, words } = await ranked(query, reader, clamp(limit, 8), 'intercom');
  return { ...(words ? { words } : {}), hits: hits.map(h => ({ day: h.doc.slice(INTERCOM.length + 1), pointer: h.pointer, lines: h.body })) };
}

// hq history: the token's agent's own jobs (status, PR, report), requests (body, answer), calls and meetings, newest first; with
// a query, the ones it matches ('#35': that number, 'HQ-COVERS': the jobs of the task with that code). "Know where to look it up", for jobs and calls alike. A report or
// card about a customer the reader wasn't handed shows by its title, with why the rest is left out.
//
const PR = "(select number || ' ' || status from prs where branch = coalesce(j.branch, 'job/' || j.id) order by number desc limit 1)";
export async function history(reader: Reader, q: unknown, limit?: unknown) {
  const { agent } = reader, n = clamp(limit, 8), query = String(q ?? '').trim(), exact = query.match(/^#?(\d+)$/)?.[1];
  const coded = jobsOfCode(query);
  let ids: Record<'job' | 'request' | 'call', number[]> | undefined = coded === undefined ? undefined : { job: coded, request: [], call: [] };
  if (query && !exact && !ids) {
    const { hits } = await ranked(query, reader, n, 'own');
    ids = { job: [], request: [], call: [] };
    for (const h of hits) { const [k, id] = h.doc.split(':'); ids[k === 'summary' ? 'call' : k as 'job'].push(Number(id)); }   // (a call found by its summary)
  }
  const where = (k: 'job' | 'request' | 'call', col: string) => exact ? ` and ${col} = ${Number(exact)}` : ids ? ` and ${col} in (${ids[k].join(',') || 0})` : '';
  const order = <T extends { id: number }>(k: 'job' | 'request' | 'call', rows: T[]) => ids ? rows.sort((a, b) => ids![k].indexOf(a.id) - ids![k].indexOf(b.id)) : rows;
  // db.ts jobs_agent_work: the query reads only the rows it shows.
  const done = db.prepare(`select j.id, j.code, j.created, j.title, j.step, j.round, j.status, ${PR} pr, j.result report, j.customers from jobs j
    indexed by jobs_agent_work where j.agent = ? and j.kind = 'work'${where('job', 'j.id')} order by j.id desc limit ?`).all(agent, n) as any[];
  // closing: HQ's line, apart from the board's answer.
  const requests = db.prepare(`select r.id, r.created, r.kind, r.title, r.status, r.body, r.answer, r.closing, r.customers from requests r
    left join jobs j on j.id = r.job where coalesce(j.agent, r.agent) = ? and r.kind != 'login'${where('request', 'r.id')} order by r.id desc limit ?`).all(agent, n) as any[];
  const calls = db.prepare(`${CALLS} where agent = ? and not live${where('call', 'id')} order by id desc limit ?`).all(agent, n) as any[];
  const reportShown = (j: { id: number; customers: number }) => jobs.readsReport(j, reader), cardShown = (r: { id: number }) => jobs.readsCard(r.id, reader);
  if (done.some(j => j.customers && reportShown(j)) || requests.some(r => r.customers && cardShown(r))) jobs.readerHanded(reader);   // (a call here is only its number)
  if (done.some(j => j.report && reportShown(j) && keysReport(j.id))) jobs.handedKeys(reader.id);
  return { agent,
    // (a review loop's job by its full name, its step and round with the work's title: nameOf.)
    jobs: order('job', done.map(({ pr, customers, step, round, ...j }) => ({ ...j, title: jobs.nameOf({ title: j.title, step, round }),
      pr: pr ? { number: Number(pr.split(' ')[0]), status: pr.split(' ')[1] } : null,
      ...(reportShown({ id: j.id, customers }) ? {} : { report: null, report_left_out: jobs.REPORT_LEFT_OUT }) }))),
    requests: order('request', requests.map(({ customers, ...r }) => !customers || cardShown(r) ? r : { ...r, body: null, answer: null, left_out: jobs.CARD_REFUSED })),
    calls: order('call', calls.map(c => ({ id: c.id, ts: c.ts, request: c.request, job: c.job, pointer: `hq call ${c.id}` }))),
    // (the ended meetings it sat in, each seat's line and the transcript's pointer: a query of words or a job's code finds
    // none, hq search finds transcripts.)
    meetings: ids ? [] : meetingrecord.attended(agent, n, exact ? Number(exact) : undefined) };
}

// hq call <id>: a call with the board, every line, and its summary, for whoever may read it (callAccess). A summary that
// isn't there is left out with a line saying why.
export function call(id: unknown, reader: Reader) {
  const c = callRow(Number(id) || 0), access = canRead(c, reader);
  if (access !== true) return access;
  if (c.customer) jobs.readerHanded(reader);
  if (c.own_only) jobs.handedKeys(reader.id);
  const base = { id: c.id, ts: c.ts, agent: c.agent, request: c.request, job: c.job };
  const by = c.heard_by && `job #${c.job}, ${who(c.heard_by)}'s`;
  const none = c.reported ? '' : !c.job ? 'nobody has followed this call up yet'
    : c.heard_kind === 'chat' ? `The CEO's intercom chat heard this call: what came of it is in that conversation, not a report`
    : c.heard_status !== 'done' ? `its follow-up (${by}) is ${['failed', 'stopped', 'cancelled'].includes(c.heard_status) ? c.heard_status : 'not done yet'}`
    : `its follow-up (${by}) ended without a report`;
  return { ...base, lines: JSON.parse(c.lines), summary: c.reported ? c.summary : null, ...(none ? { summary_left_out: none } : {}) };
}

// Whether a reader may read a call's lines (hq call, the call's pictures: pictures.ts): true, 404 (no such call, still
// going on, or about a card for keys and another agent's), or a refusal that says why (about a customer, not handed it).
// A job working on the call (ledger.ts mine) reads it whatever it's about.
export const callAccess = (id: number, reader: Reader) => canRead(callRow(id), reader);
// A call every job reads (canRead for any reader): ended, not about a customer, not a card for keys's.
export function readByAll(id: number) {
  const c = callRow(id);
  return !!c && !c.live && !c.own_only && !c.customer;
}
const callRow = (id: number) => db.prepare(`${CALLS} where id = ?`).get(id) as any;
function canRead(c: any, reader: Reader): true | 404 | [403, string] {
  if (!c) return 404;
  if (!working(c.id, reader) && (c.live || (c.own_only && c.agent !== reader.agent))) return 404;
  if (c.customer && !readsCustomerCall(c.id, reader)) return [403, customerCallRefused(c, reader)];
  return true;
}
const working = (call: number, reader: Reader) => !!reader.id && ledger.mine(reader.id, call);
// A call about a customer: the jobs working on it (ledger.ts mine) and roles.customerData.
const readsCustomerCall = (call: number, reader: Reader) => working(call, reader) || jobs.readsCustomerData(reader.agent);
const customerCallRefused = (c: any, reader: Reader) => `call #${c.id} is about a customer, so it goes only to the jobs working on it (its \
follow-up${c.job ? `, job #${c.job}` : ''}, and the jobs handed out for its items) and to org.yaml's roles.customerData: \
${c.agent === reader.agent ? 'work from what its follow-up left (its pull request, the jobs it handed out)' : `ask ${who(c.agent)} for what you need from it (hq say ${c.agent})`}`;

// A customer's own details may be in the report of a job handed them, in a customer card, and in a call about one or
// followed up by such a job. Only the job working on them reads them (readsDoc, and jobs.ts Reader), and holds them from
// then on, so they go no further (jobs.ts holdsCustomerData).
export const customerCall = (id: number) => !!db.prepare(`select 1 from (${CALLS}) where id = ? and customer`).get(id);
// A call about a card for keys (own_only): its own agent's alone
export const keysCall = (id: number) => !!db.prepare(`select 1 from (${CALLS}) where id = ? and own_only`).get(id);
const readsCall = (id: number, reader: Reader) => !customerCall(id) || readsCustomerCall(id, reader);
function aboutCustomer(doc: string) {
  const [kind, id] = doc.split(':'), n = Number(id);
  if (kind === 'job') return jobs.holdsCustomerData(n);
  if (kind === 'request') return jobs.customerCard(n);
  return (kind === 'call' || kind === 'summary') && customerCall(n);
}
// A call about a card for keys, its summary, and the report of the job that heard it (its follow-up): their reader holds
// keys (jobs.ts holdsKeys)
const keysReport = (job: number) => !!db.prepare(`select 1 from calls c where c.job = ? and ${keysCondition()}`).get(job);
function aboutKeys(doc: string) {
  const [kind, id] = doc.split(':'), n = Number(id);
  if (kind === 'job') return keysReport(n);
  return (kind === 'call' || kind === 'summary') && carriesKeys(n);
}
function readsDoc(doc: string, reader: Reader) {
  const [kind, id] = doc.split(':'), n = Number(id);
  if (kind === 'job') return jobs.readsReport({ id: n, customers: jobs.holdsCustomerData(n) }, reader);
  if (kind === 'request') return jobs.readsCard(n, reader);
  if (kind === 'call' || kind === 'summary') return readsCall(n, reader);
  return true;
}

// HQ's go-to-anything search (shell/finder.js): what's near the board's words in meaning, as the things it points at,
// nearest first: a Library document, a task's report, a card or a call. Only these ids go out, and HQ shows one only
// where a list of its own (the projects, the desk phone, Calls, the Library) already holds it, so each keeps the rules of
// the screen it comes from; why the search model didn't answer, when it didn't.
const NEAREST: Record<string, string> = { file: 'library', job: 'task', request: 'card', call: 'call', summary: 'call' };
export async function nearest(q: unknown) {
  const query = String(q ?? '').trim();
  if (!query) return { hits: [] };
  const m = await meaning(query);
  if (!('v' in m)) return { hits: [], why: m.why };
  const near = [...(await vectors()).values()].filter(c => c.source !== ARCHIVE && NEAREST[c.doc.split(':')[0]])
    .map(c => ({ doc: c.doc, d: dot(c.v, m.v) })).filter(c => c.d >= NEAR).sort((a, b) => b.d - a.d);
  const hits = new Map<string, { kind: string; id: string }>();
  for (const { doc } of near) {
    const [kind, ...rest] = doc.split(':'), path = rest.join(':');
    const post = kind === 'file' && /^knowledge\/posts\/(.+)\/index\.md$/.exec(path);
    const id = kind === 'summary' ? rest[0] : post ? `post:${post[1]}` : path;
    hits.set(`${NEAREST[kind]}:${id}`, { kind: NEAREST[kind], id });
  }
  return { hits: [...hits.values()] };
}
export const stats = () => db.prepare('select count(*) chunks, count(vec) embedded, count(distinct doc) docs from memory').get();
