// Outside notes: the board shares a preview with outside people it names, for their review notes before a launch.
//   - A share opens one preview host under one path: a product's host whole, the front's preview door whole (the shop,
//     every shelf on it), or one cycle folder on the cycles host (its deck and its demos). A cycle folder's share also
//     opens the previews its pages link to (linked, read once when it's made: a deck's "try the demo" on a product's host
//     or in another folder), each as a share of that page would. Nothing else: no HQ, no other preview host or folder.
//   - It has its people: the board invites several to one share, removes one and invites another while it's open. Each
//     has a link of their own, a guest desk door (guests.ts): the person proves the address the board gave with a code
//     by email, the same sign-in as a checklist's, and the door's Open hands them to the preview host (preview.ts
//     accept). That host keeps their session in the host-only `ps` cookie: no Domain, so no other preview host ever
//     gets it. A linked host they open has no session yet: the preview's sign-in sends them to the guest desk (guests.ts
//     onward), whose own session hands them on to it the same way (onward).
//   - Every request is checked against these tables, so the board's End, a removal and the end date stop it at once.
//   - Each note keeps who wrote it. A person sends theirs when they're done (submit); once everyone still on the share
//     has, or the board ends it, or its date passes, the share ends and all its notes go to the owner of what was shared
//     as one job (feedback.ts). Until its date, unless the board ended it, whoever sent theirs may add more: their link
//     and the tool's menu take them up again (reopen), and the later ones go as a follow-up. A view-only share (view)
//     takes none: its people see the pages as they are, without review mode.
//   - A tester invite (tester) is a share of the shop's preview door for notes whose people may each order once, for real:
//     each gets a voucher of their own, shown on their door, that pays one basket there up to the board's amount (payments.ts testerVoucher).
//     Their order is made and sent as a customer's is; what they noted on the way goes as any share's notes do.
//     On the preview of a product with plans (plans.ts), the voucher pays one of its plans instead, typed in the
//     product's own screen by its own tester.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { db } from './db.ts';
import { FRONT } from './approvals.ts';
import { brand, infra, names } from './company.ts';
import * as guests from './guests.ts';
import * as owed from './owed.ts';
import { paidLines, sentNothing, shopName, noSuchCode, testerVoucherSources } from './payments.ts';
import * as plans from './plans.ts';
import * as pricing from './pricing.ts';
import { viewerId } from './viewers.ts';

// Share tables.
// - review_shares.linked: the other previews it opens, JSON [{host, prefix}].
// - view: 1 for view only.
// - tester: 1 for a tester invite.
// - cap: the most a voucher pays in cents, delivery included, from the board's Share box.
// - ended_by: why it ended.
// - review_share_people.voucher, ordered: the person's tester voucher and the session that spent it.
// - review_share_sessions.guest: the person whose session it is.
// - host: where it was handed, or null for the share's own host.
db.exec(`create table if not exists review_shares (id integer primary key, created text not null, about text not null,
    host text not null, prefix text not null, start text not null, ends text not null, ended text, gathered text, job integer,
    linked text, view integer not null default 0, tester integer not null default 0, cap integer, ended_by text);
  create table if not exists review_share_people (share integer not null, guest text not null collate nocase,
    nonce text not null, link text not null unique, added text not null, opened text, submitted text, removed text,
    voucher text, ordered text, primary key (share, guest));
  create table if not exists review_share_sessions (hash text primary key, share integer not null, seal text not null,
    guest text collate nocase, host text, expires integer)`);
db.exec('create unique index if not exists review_share_vouchers on review_share_people (voucher)');

// about: what the notes are about (owed.about), and so whose they are; prefix: the paths it opens on host; start: the
// page it opens at; ended: when it ended, and ended_by why: the board ended it, everyone was in, or its date passed (null:
// ended before we kept why); gathered: when its notes went (to job, if any).
export type Share = {
  id: number;
  created: string;
  about: string;
  host: string;
  prefix: string;
  start: string;
  ends: string;
  ended: string | null;
  ended_by: EndedBy | null;
  gathered: string | null;
  job: number | null;
  linked: string | null;
  view: number;
  tester: number;
  cap: number | null;
};
// One of a share's people: their own link, when they first opened it, sent their notes, or were removed
export type Person = {
  share: number;
  guest: string;
  nonce: string;
  link: string;
  added: string;
  opened: string | null;
  submitted: string | null;
  removed: string | null;
  voucher: string | null;
  ordered: string | null;
};
export type EndedBy = 'board' | 'everyone' | 'date';
export type Scope = Pick<Share, 'about' | 'host' | 'prefix' | 'start'>;
// A preview host and the paths a share opens on it
export type Reach = Pick<Share, 'host' | 'prefix'>;
export const DAYS = [1, 3, 7];
// What a tester's voucher pays at most, in cents, delivery included: the board's amount for the invite, €50 until it sets
// one
export const DEFAULT_CAP_CENTS = 5000,
  MAX_CAP_CENTS = 50_000;
export const capOf = (s: Pick<Share, 'cap'>) => s.cap ?? DEFAULT_CAP_CENTS;
const HAND_OFF_MS = 120_000,
  KEEP_DAYS = 7;
// The kits' browser files, which a demo loads from the cycles host's root (infra/products.py KITS)
const KIT_FILE = /^\/shared\/[\w/-]+\.js$/;
// What a page in a folder loads: the page, its code and data, pictures, fonts, sound and film. Never the folder's notes
// (.md), scripts (.mjs) or anything else an agent keeps beside its pages.
const PAGE_FILE =
  /(?:\/|\.(?:html|css|js|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|mp3|m4a|wav|ogg|mp4|webm|vtt))$/i;
// What a page in a folder offers to download: a PDF, a model to print. Not an archive, which could carry anything.
const DOWNLOAD_FILE = /\.(?:pdf|stl|3mf|obj)$/i;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const byId = (id: number) => db.prepare('select * from review_shares where id = ?').get(id) as Share | undefined;
const isOpen = (s: Share) => !s.ended && Date.parse(s.ends) > Date.now();
const door = (share: number, nonce: string) => guests.doorLink(`share:${share}:${nonce}`);
export const linkOf = (p: Person) => door(p.share, p.nonce).url;
// A share's people in the order they were invited, the removed ones too (their notes stay theirs)
export const people = (id: number) =>
  db.prepare('select * from review_share_people where share = ? order by rowid').all(id) as Person[];
const person = (id: number, name: string) =>
  db.prepare('select * from review_share_people where share = ? and guest = ?').get(id, name) as Person | undefined;
export const onIt = (p: Person) => !p.removed;
// Everyone the board shared with in the last REMEMBER_DAYS, counted from their latest share, the latest first: HQ's box
// offers them again (feedback.ts listPeople). Their names only, from the shares themselves.
const REMEMBER_DAYS = 21;
export const recent = () =>
  (
    db
      .prepare(
        'select guest, max(added) last from review_share_people group by guest having last > ? order by last desc',
      )
      .all(new Date(Date.now() - REMEMBER_DAYS * 864e5).toISOString()) as { guest: string }[]
  ).map(p => p.guest);
// Whether the board ever shared with them
export const sharedWith = (guest: string) =>
  !!db.prepare('select 1 from review_share_people where guest = ?').get(guest);

// ---------------------------------------------------------------- the board (HQ)
// What a share is for: notes, to view only, or a tester invite (notes and an order)
export type Kind = 'notes' | 'view' | 'tester';
export const kindOf = (s: Pick<Share, 'view' | 'tester'>): Kind => (s.tester ? 'tester' : s.view ? 'view' : 'notes');
// The open share of a scope, of a kind: the board's Share on any page it opens leads to it, so one share has all its people
export const openFor = (scope: Pick<Scope, 'host' | 'prefix'>, kind: Kind = 'notes') =>
  db
    .prepare(
      `select * from review_shares where host = ? and prefix = ? and view = ? and tester = ? and ended is null and ends > ?
      order by id desc`,
    )
    .get(scope.host, scope.prefix, kind === 'view' ? 1 : 0, kind === 'tester' ? 1 : 0, new Date().toISOString()) as
    Share | undefined;

// A new share: scope and linked from feedback.ts (scopeOf, linkedFrom), open for days, of a kind, with nobody on it yet
// (invite).
export function create(scope: Scope, linked: Reach[], days: number, kind: Kind = 'notes') {
  const now = new Date();
  const ends = new Date(now.getTime() + days * 864e5).toISOString();
  const { lastInsertRowid } = db
    .prepare(
      'insert into review_shares (created, about, host, prefix, start, ends, linked, view, tester) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      now.toISOString(),
      scope.about,
      scope.host,
      scope.prefix,
      scope.start,
      ends,
      JSON.stringify(linked),
      kind === 'view' ? 1 : 0,
      kind === 'tester' ? 1 : 0,
    );
  return byId(Number(lastInsertRowid))!;
}

// Someone on a share, for a guest the board names (guests.invite): a link of their own, which opens at once. One removed
// before comes back on a new link (the old one stays shut) and has their notes to send again. On a tester invite they get
// their voucher (one removed before keeps theirs: spent, it stays spent).
export function invite(id: number, guest: string) {
  const nonce = randomBytes(16).toString('hex'),
    { link } = door(id, nonce);
  db.prepare(
    `insert into review_share_people (share, guest, nonce, link, added) values (?, ?, ?, ?, ?)
    on conflict (share, guest) do update set nonce = excluded.nonce, link = excluded.link, added = excluded.added, submitted = null, removed = null`,
  ).run(id, guest, nonce, link, new Date().toISOString());
  if (byId(id)?.tester && !person(id, guest)?.voucher) giveVoucher(id, guest);
  return person(id, guest)!;
}

// The board's amount for a tester invite's vouchers, in cents: every voucher of it not yet spent pays up to it from now on,
// the ones already sent too
export const setCap = (id: number, cents: number) =>
  db.prepare('update review_shares set cap = ? where id = ? and tester = 1').run(cents, id).changes > 0;

// The board's Remove: their link and session stop at once; the notes they left stay, theirs.
export function remove(id: number, guest: string) {
  const removed = db
    .prepare('update review_share_people set removed = ? where share = ? and guest = ? and removed is null')
    .run(new Date().toISOString(), id, guest).changes;
  if (removed) {
    db.prepare('delete from review_share_sessions where share = ? and guest = ?').run(id, guest);
    for (const [code, h] of handOffs)
      if (h.share === id && h.guest.toLowerCase() === guest.toLowerCase()) handOffs.delete(code);
  }
  return !!removed;
}

// The board's End, or everyone done: it stops at once, and its notes are gathered.
// (a share that ended with everyone in keeps its sessions: each still opens only while its person may take their notes
// up again, admitted. The board's End ends such a share for good: its sessions go, and its notes, gathered when everyone
// was in, aren't gathered again.)
export function end(id: number, by: Exclude<EndedBy, 'date'>) {
  const s = byId(id);
  if (!s || (s.ended && !(by === 'board' && reopens(s)))) return false;
  db.prepare('update review_shares set ended = ?, ended_by = ? where id = ?').run(new Date().toISOString(), by, id);
  if (by !== 'everyone') db.prepare('delete from review_share_sessions where share = ?').run(id);
  return true;
}

// Whether everyone still on an open share is done: has sent their notes, and on a tester invite has ordered too, or
// their voucher would go with the share (nobody on it: not yet, the board may invite someone).
export function allIn(id: number) {
  const tester = !!byId(id)?.tester,
    on = people(id).filter(onIt);
  return on.length > 0 && on.every(p => p.submitted && (!tester || orderOf(p)));
}

// HQ's Reviews: the open shares, and those ended in the last KEEP_DAYS (with where their notes went).
export const list = () =>
  db
    .prepare('select * from review_shares where ended is null or ended > ? order by id desc')
    .all(new Date(Date.now() - KEEP_DAYS * 864e5).toISOString()) as Share[];

// ---------------------------------------------------------------- ending and gathering (feedback.ts gather)
// Shares whose date has passed end now: the date is when they ended.
export function endExpired() {
  const now = new Date().toISOString();
  for (const s of db
    .prepare('select id, ends from review_shares where ended is null and ends <= ?')
    .all(now) as Share[]) {
    db.prepare("update review_shares set ended = ?, ended_by = 'date' where id = ?").run(s.ends, s.id);
  }
  // a share that ended with everyone in kept its sessions until its date
  db.prepare('delete from review_share_sessions where share in (select id from review_shares where ends <= ?)').run(
    now,
  );
}
export const ungathered = () =>
  db.prepare('select * from review_shares where ended is not null and gathered is null order by id').all() as Share[];
export const markGathered = (id: number, job: number | null) =>
  db
    .prepare('update review_shares set gathered = ?, job = coalesce(?, job) where id = ?')
    .run(new Date().toISOString(), job, id);

// ---------------------------------------------------------------- the outsider on the preview host (preview.ts)
// The door's Open: a one-time code, good for two minutes, that the host it's for (the share's own, or one it links to)
// trades for a session. Kept in memory: a restart only means a second tap on Open. It and the session keep the guest's
// address as it was when they proved it (guests.seal): a new address or a revoke ends both. One a page hands to another
// device (handOn) lives longer and gives a session that ends sooner (accessMs).
const handOffs = new Map<
  string,
  { share: number; guest: string; expires: number; seal: string; host: string; to: string; accessMs?: number }
>();
// a cap on one person's links at a time, so a flood from their page fills only their own allowance, never another's
const MOST_HAND_OFFS = 20;
function handOff(
  s: Share,
  guest: string,
  seal: string,
  host = s.host,
  page = s.start,
  o = { linkMs: HAND_OFF_MS, accessMs: 0 },
) {
  let theirs = 0;
  for (const [code, h] of handOffs) {
    if (h.expires < Date.now()) handOffs.delete(code);
    else if (h.share === s.id && h.guest === guest) theirs++;
  }
  if (theirs >= MOST_HAND_OFFS) return null;
  const code = randomBytes(24).toString('base64url'),
    at = page.indexOf('#');
  const to = at < 0 ? page : page.slice(0, at),
    slide = at < 0 ? '' : page.slice(at);
  handOffs.set(code, {
    share: s.id,
    guest,
    expires: Date.now() + o.linkMs,
    seal,
    host,
    to,
    accessMs: o.accessMs || undefined,
  });
  return `https://${host}/__preview?s=${code}&to=${encodeURIComponent(to)}${slide}`;
}
// A page's link for another device (preview.ts handOn): the same person's access on the same host, as their session has
// it now. → the link, or null when they have too many open.
export const handOn = (session: Session, host: string, to: string, o: { linkMs: number; accessMs: number }) =>
  handOff(session, session.guest, guests.seal(session.guest) ?? '', host, to, o);
// A person may be on the share: it's open, they're on it, and their address is the one they proved
// (one who may still take their notes up again keeps their session on a share that ended with everyone in, so the tool's
// own Add more notes can do it)
const admitted = (s: Share | undefined, guest: string, seal: string) => reads(s, guest) && guests.seal(guest) === seal;
// ...and so may read their own notes on it, for one whose address is proved another way (feedback.ts outsiderShot: the
// guest desk's session)
export const reads = (s: Share | undefined, guest: string) => {
  const p = s ? person(s.id, guest) : undefined;
  return !!s && !!p && (isOpen(s) || reopenable(s, p)) && onIt(p);
};

// On the host the hand-off is for only: a session for the `ps` cookie, and how many seconds it may live (to the share's
// end, or sooner for another device's).
export function accept(code: string, host: string) {
  const h = handOffs.get(code);
  handOffs.delete(code);
  const s = h && h.expires > Date.now() ? byId(h.share) : undefined;
  if (!h || !s || h.host !== host || !admitted(s, h.guest, h.seal)) return null;
  const session = randomBytes(32).toString('base64url'),
    ends = Math.min(Date.parse(s.ends), h.accessMs ? Date.now() + h.accessMs : Infinity);
  db.prepare('delete from review_share_sessions where expires <= ?').run(Date.now());
  db.prepare(
    'insert into review_share_sessions (hash, share, guest, seal, host, expires) values (?, ?, ?, ?, ?, ?)',
  ).run(sha256(session), s.id, h.guest, h.seal, host, h.accessMs ? ends : null);
  db.prepare('update review_share_people set opened = coalesce(opened, ?) where share = ? and guest = ?').run(
    new Date().toISOString(),
    s.id,
    h.guest,
  );
  return { session, seconds: Math.ceil((ends - Date.now()) / 1000), start: h.to };
}

// The open (or, for one who may take their notes up again, reopenable) share a `ps` cookie's session belongs to, if it
// was handed on this host, whose session it is, and whether another device handed it (handOn: it ends sooner).
export function fromSession(session: string | undefined, host: string) {
  if (!session) return null;
  const x = db
    .prepare(
      'select share, guest, seal, host, expires from review_share_sessions where hash = ? and (expires is null or expires > ?)',
    )
    .get(sha256(session), Date.now()) as
    { share: number; guest: string; seal: string; host: string | null; expires: number | null } | undefined;
  const s = x && byId(x.share);
  return s && x && (x.host ?? s.host) === host && admitted(s, x.guest, x.seal)
    ? { ...s, guest: x.guest, handed: x.expires !== null }
    : null;
}
export type Session = NonNullable<ReturnType<typeof fromSession>>;

// A person's Send my notes: from then on they add none. True the first time.
export const submit = (id: number, guest: string) =>
  db
    .prepare(
      'update review_share_people set submitted = ? where share = ? and guest = ? and submitted is null and removed is null',
    )
    .run(new Date().toISOString(), id, guest).changes > 0;
export const submitted = (id: number, guest: string) => !!person(id, guest)?.submitted;
// Whoever sent their notes may add more until the share's date, unless the board ended it: the share reopens, and the
// board may still Remove them from it or End it. (A view-only share takes no notes.)
export const reopens = (s: Share) =>
  !s.view && Date.parse(s.ends) > Date.now() && (!s.ended || s.ended_by === 'everyone');
const reopenable = (s: Share, p: Person) => reopens(s) && !!p.submitted && onIt(p);
// Takes their notes up again, and the share too if it had ended with everyone in. The notes already gathered went to the
// owner; the later ones go when it ends again, as a follow-up (feedback.ts outsideText).
function reopen(s: Share, guest: string) {
  db.prepare('update review_share_people set submitted = null where share = ? and guest = ?').run(s.id, guest);
  if (s.ended)
    db.prepare('update review_shares set ended = null, ended_by = null, gathered = null where id = ?').run(s.id);
}

// The same from review mode's menu (review.js's Add more notes), for a session's own person.
export function canTakeUp(id: number, guest: string) {
  const s = byId(id),
    p = person(id, guest);
  return !!s && !!p && reopenable(s, p);
}
export function takeUp(id: number, guest: string) {
  if (!canTakeUp(id, guest)) return false;
  reopen(byId(id)!, guest);
  return true;
}

// The guest desk's onward (guests.ts): an open share of this guest's that opens url (its own host or one its pages link
// to) hands them on to it; null if none does.
export function onward(guest: string, url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const seal = guests.seal(guest);
  if (u.protocol !== 'https:' || !seal) return null;
  const s = (
    db
      .prepare(
        `select s.* from review_shares s join review_share_people p on p.share = s.id
        where p.guest = ? and p.removed is null and s.ended is null order by s.id desc`,
      )
      .all(guest) as Share[]
  ).find(x => isOpen(x) && opens(x, u.host, u.pathname + u.search));
  return s ? handOff(s, guest, seal, u.host, u.pathname + u.search + u.hash) : null;
}

// Where a share reaches: its own host and path, and the previews its pages link to.
export const reaches = (s: Share): Reach[] => [{ host: s.host, prefix: s.prefix }, ...JSON.parse(s.linked ?? '[]')];

// Whether a share opens a request's path (X-Forwarded-Uri, raw) on host: on one it reaches, a product's host whole (prefix
// /); in a folder, its pages and what they load, the kits' files and the company's files served from the repo
// (company/infra.env SERVED_FROM_REPO: the theme's CSS a demo links). The path is read as the file server reads it, every
// escape resolved; no name in it starts with a dot (.., a hidden file).
export const opens = (s: Share, host: string, uri: string) =>
  reaches(s).some(r => r.host === host && prefixOpens(r.prefix, uri));
function prefixOpens(prefix: string, uri: string) {
  if (!/^\/(?![/\\])/.test(uri)) return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(uri, 'http://x').pathname);
  } catch {
    return false;
  }
  if (path.includes('\\') || path.split('/').some(name => name.startsWith('.'))) return false;
  // (the folder without its slash: the file server sends it on to the folder's page)
  if (prefix === '/' || path === prefix.slice(0, -1)) return true;
  return (
    // (and what its pages offer to download)
    (path.startsWith(prefix) && (PAGE_FILE.test(path) || DOWNLOAD_FILE.test(path))) ||
    KIT_FILE.test(path) ||
    servedFromRepo(path)
  );
}
// Caddy's path.Match for an entry: a * stands for part of one name
const servedFromRepo = (path: string) =>
  (infra().SERVED_FROM_REPO ?? '')
    .split(',')
    .filter(Boolean)
    .some(entry => new RegExp(`^${entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(path));

// ---------------------------------------------------------------- a tester's voucher
// TESTER and twelve letters and digits nobody misreads (60 bits), shown in fours: TESTER-7KQ2-XW9P-3MZT. Kept as typed
// without its dashes (payments.ts squeezedCode), as a share's links are kept: it opens nothing but one order on the preview.
// (A pass's player's, players.ts, looks the same.)
const VOUCHER_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newVoucher = () =>
  `TESTER${Array.from({ length: 12 }, () => VOUCHER_LETTERS[randomInt(VOUCHER_LETTERS.length)]).join('')}`;
export const shownVoucher = (code: string) => `TESTER-${code.slice(6).match(/.{4}/g)!.join('-')}`;
function giveVoucher(id: number, guest: string) {
  db.prepare('update review_share_people set voucher = ? where share = ? and guest = ?').run(newVoucher(), id, guest);
}
const holderOf = (code: string) =>
  db.prepare('select * from review_share_people where voucher = ?').get(code) as Person | undefined;
// The preview's code box (payments.ts testerVoucher): a tester's voucher pays one basket while its invite is open and its
// person on it. Removed, or the invite ended, it pays none; spent, it says so. Each pays on its own invite's product only
// (the shop's door, or a product with plans), and there its own tester's id names them.
const inviteVouchers: (typeof testerVoucherSources)[number] = {
  find: (code, product) => {
    const p = holderOf(code);
    return p && byId(p.share)?.about === product ? code : undefined;
  },
  holds: code => !!holderOf(code),
  viewer: code => {
    const p = holderOf(code),
      s = p && byId(p.share);
    return s ? viewerId(s.about, { share: s.id, guest: p.guest }) : null;
  },
  unusable: code => {
    const p = holderOf(code),
      s = p && byId(p.share);
    if (!p || !s) return noSuchCode;
    if (orderOf(p)) return [409, 'this voucher has been used', 'code_used'];
    if (!isOpen(s) || !onIt(p)) return [409, 'this tester invite has ended', 'code_expired'];
    return null;
  },
  // what it pays at most: its invite's amount, read as the basket is shown and again at its checkout
  cap: code => {
    const p = holderOf(code),
      s = p && byId(p.share);
    return s ? capOf(s) : DEFAULT_CAP_CENTS;
  },
  use: (code, session) => {
    const why = inviteVouchers.unusable(code);
    if (why) return why;
    db.prepare('update review_share_people set ordered = ? where voucher = ?').run(session, code);
    return null;
  },
  // A tester's order whose parcel goes again by hand is its voucher's again, unless the voucher has paid another order
  // since (that one's session then, and nothing changes).
  retake: (code, session) => {
    const p = holderOf(code),
      since = p && orderOf(p);
    if (since && since !== session) return since;
    db.prepare('update review_share_people set ordered = ? where voucher = ?').run(session, code);
    return null;
  },
};
testerVoucherSources.push(inviteVouchers);
// The order a tester's voucher paid, or null: none yet, or one whose parcel was cancelled before anything was sent (Print
// API cancelled it, or every thing was taken out), which leaves the voucher to pay a basket again.
export const orderOf = (p: Person) => (p.ordered && !sentNothing(p.ordered) ? p.ordered : null);
// What a tester ordered, for the board's list and the owner's job: the stalls of the lines their voucher paid (never what
// they typed: their order is a customer's, rule 7), or the plan and tiers it paid
export function orderedFrom(p: Person) {
  const order = orderOf(p);
  if (!order) return [];
  return (
    plans.bought(order) ?? [
      ...new Set(
        paidLines(order)
          .filter(l => !l.goes_with)
          .map(l => shopName(l.product)),
      ),
    ]
  );
}

// ---------------------------------------------------------------- the door on the guest desk
// (view: a view-only share's, which asks for nothing; the pin's menu)
const WORDS = {
  en: (what: string, company: string, until: string) => ({
    title: `${what}, for your notes`,
    button: `Open ${what}`,
    text: `${company}’s crew would like your notes on ${what} before it goes out. Open it, tap the red pin on anything you’d \
change, and say or type what you think. Something across several pages? The small menu next to the pin has a general \
note. When you’re done, tap Send my notes in that menu: they go to the crew with a picture of the screen. It’s open \
until ${until}.`,
  }),
  nl: (what: string, company: string, until: string) => ({
    title: `${what}, voor jouw notities`,
    button: `Open ${what}`,
    text: `De crew van ${company} hoort graag wat jij van ${what} vindt voordat het live gaat. Open het, tik op de rode speld \
bij alles wat je anders zou doen, en zeg of typ wat je denkt. Iets dat over meerdere pagina’s gaat? Het menuutje naast de \
speld heeft een algemene notitie. Klaar? Tik op Stuur mijn notities in dat menu: ze gaan met een foto van het scherm naar \
de crew. Het staat open tot ${until}.`,
  }),
};
const VIEW = {
  en: (what: string, company: string, until: string) => ({
    title: what,
    button: `Open ${what}`,
    text: `${company}’s crew is sharing ${what} with you. Have a look around: it’s open until ${until}.`,
  }),
  nl: (what: string, company: string, until: string) => ({
    title: what,
    button: `Open ${what}`,
    text: `De crew van ${company} deelt ${what} met je. Kijk gerust rond: het staat open tot ${until}.`,
  }),
};
// A notes share's door once its person sent theirs (reopenable): thanks, and its button takes them up again.
const SENT = {
  en: (what: string, company: string, until: string) => ({
    title: 'Sent, thank you',
    button: 'Add more notes',
    text: `Your notes on ${what} went to ${company}’s crew. Thought of more? Add more notes opens it again, until ${until}.`,
  }),
  nl: (what: string, company: string, until: string) => ({
    title: 'Verstuurd, dank je wel',
    button: 'Meer notities toevoegen',
    text: `Je notities over ${what} zijn naar de crew van ${company} gegaan. Nog iets bedacht? Meer notities toevoegen opent \
het weer, tot ${until}.`,
  }),
};
// A share's link once it's closed for good (the board ended it, its date passed, or its person was removed): why, in one
// line.
const SHUT = {
  en: (sent: boolean) => (sent ? 'These notes were sent and this invite has ended.' : 'This invite has ended.'),
  nl: (sent: boolean) =>
    sent ? 'Deze notities zijn verstuurd en deze uitnodiging is afgelopen.' : 'Deze uitnodiging is afgelopen.',
};
// A tester invite's door: a greeting, three steps with the voucher in the first (or that it is spent), the company's
// testerFeedback as a fourth when set, a quieter aside on what happens to their notes, and a small line with its
// testerNote, that notes carry the screen and browser, and the closing time. A step's **…** is bold. Once they've sent
// their notes, its button is Add more notes (more). plan: on a product with plans, its own first step (plans.ts tester;
// '' for the words here), null on the shop's door.
const TESTER = {
  en: (what: string, company: string, until: string, note: string, feedback: string[], plan: string | null) => ({
    title: `${what}, to try out`,
    button: `Open ${what}`,
    text: `${company}’s crew would love you to try ${what} before it opens.`,
    steps: [
      plan === null
        ? 'Look around and order something for real: **it’s actually made and sent to your address**. 🎁 Type the voucher below in the basket’s code box.'
        : plan ||
          `Look around and take a plan, as anyone would. 🎁 Type the voucher below where ${what} asks how to pay: **it pays for the plan, nothing is charged and no card is asked for**.`,
      `Tap the red pin on anything you’d change${plan === null ? ', all the way to the confirmation page,' : ''} and say or type what you think. Something across several pages? The small menu next to the pin has a general note.`,
      'Done? Tap Send my notes in that menu: they go to the crew with a picture of the screen. Thought of more? Add more notes is in the same menu.',
      ...feedback,
    ],
    aside: {
      title: 'What happens to your notes',
      lines: [
        plan === null
          ? 'You can pin notes anywhere: the shop and every app in it.'
          : `You can pin notes anywhere in ${what}.`,
        'Something broken? Pin a note: the crew looks at it and fixes what’s plainly broken.',
        'Once everyone has sent their notes, the crew goes through them all and decides what to change.',
      ],
    },
    small: `${note}Your notes include your screen size and browser, so we see what you saw. Open until ${until}.`,
    more: 'Add more notes',
    voucher: (cap: string) =>
      plan === null
        ? `Your voucher, for one order up to ${cap}, delivery included`
        : `Your voucher, for one plan up to ${cap}`,
    spent:
      plan === null
        ? 'Your voucher is spent: thank you for your order.'
        : 'Your voucher has paid for your plan: enjoy it.',
  }),
  nl: (what: string, company: string, until: string, note: string, feedback: string[], plan: string | null) => ({
    title: `${what}, om uit te proberen`,
    button: `Open ${what}`,
    text: `De crew van ${company} wil graag dat jij ${what} uitprobeert voordat het opengaat.`,
    steps: [
      plan === null
        ? 'Kijk rond en bestel echt iets: **het wordt echt gemaakt en naar jouw adres gestuurd**. 🎁 Typ de tegoedbon hieronder in het codevak van je mandje.'
        : plan ||
          `Kijk rond en neem een abonnement, zoals iedereen dat zou doen. 🎁 Typ de tegoedbon hieronder waar ${what} vraagt hoe je betaalt: **hij betaalt het abonnement, er wordt niets afgeschreven en je hoeft geen kaart te geven**.`,
      `Tik op de rode speld bij alles wat je anders zou doen${plan === null ? ', tot en met de bevestigingspagina,' : ''} en zeg of typ wat je denkt. Iets dat over meerdere pagina’s gaat? Het menuutje naast de speld heeft een algemene notitie.`,
      'Klaar? Tik op Stuur mijn notities in dat menu: ze gaan met een foto van het scherm naar de crew. Nog iets bedacht? Meer notities toevoegen zit in hetzelfde menu.',
      ...feedback,
    ],
    aside: {
      title: 'Wat er met je notities gebeurt',
      lines: [
        plan === null
          ? 'Je kunt overal notities prikken: in de winkel en in elke app.'
          : `Je kunt overal in ${what} notities prikken.`,
        'Werkt iets niet? Prik een notitie: de crew kijkt ernaar en repareert wat duidelijk stuk is.',
        'Als iedereen zijn notities heeft gestuurd, gaat de crew ze allemaal door en beslist wat er verandert.',
      ],
    },
    small: `${note}Je notities bevatten je schermgrootte en browser, zodat we zien wat jij zag. Open tot ${until}.`,
    more: 'Meer notities toevoegen',
    voucher: (cap: string) =>
      plan === null
        ? `Je tegoedbon, voor één bestelling tot ${cap}, verzending inbegrepen`
        : `Je tegoedbon, voor één abonnement tot ${cap}`,
    spent:
      plan === null
        ? 'Je tegoedbon is gebruikt: dank je wel voor je bestelling.'
        : 'Je tegoedbon heeft je abonnement betaald: veel plezier.',
  }),
};
// €50, or €12.50: whole euros without cents
const euros = (cents: number, lang: keyof typeof TESTER) =>
  guests.pageFormats().money(cents, lang, { wholeWithoutCents: true });
const testerNote = (lang: keyof typeof TESTER) => {
  const note = brand().testerNote?.[lang];
  return typeof note === 'string' && note.trim() ? `${note.trim()} ` : '';
};
// brand.yaml's testerFeedback, the door's last step when set
const testerFeedback = (lang: keyof typeof TESTER) => {
  const step = brand().testerFeedback?.[lang];
  return typeof step === 'string' && step.trim() ? [step.trim()] : [];
};
// What a voucher pays for on a product with plans, in its own words ('' for the door's), or null on the shop's door. Plans
// that can't be read, or are gone, keep the door shut: it would promise a plan the product can't sell.
function planStep(s: Share, lang: keyof typeof TESTER) {
  if (s.about === FRONT) return null;
  let plans: pricing.Plans | null;
  try {
    plans = pricing.plansOf(s.about);
  } catch (err) {
    throw err instanceof pricing.PlansError ? new guests.DoorError(err.message) : err;
  }
  if (!plans) throw new guests.DoorError(`products/${s.about} names no plans for its tester invite's vouchers`);
  return plans.tester[lang] ?? '';
}
guests.addDoor(link => {
  const p = db.prepare('select * from review_share_people where link = ?').get(link) as Person | undefined;
  const s = p && byId(p.share);
  if (!p || !s) return undefined;
  return {
    guest: p.guest,
    open: (isOpen(s) || reopenable(s, p)) && onIt(p),
    words: lang => {
      const said = [
        owed.ownerOf(s.about).name,
        names().name,
        guests.pageFormats().moment(Date.parse(s.ends), lang),
      ] as const;
      const now = person(s.id, p.guest),
        sent = !!now && reopenable(byId(s.id) ?? s, now);
      if (!s.tester) return (s.view ? VIEW : sent ? SENT : WORDS)[lang](...said);
      const { voucher, spent, more, ...t } = TESTER[lang](
          ...said,
          testerNote(lang),
          testerFeedback(lang),
          planStep(s, lang),
        ),
        // sent, their button takes the notes up again
        w = sent ? { ...t, button: more } : t;
      if (!now?.voucher) return w;
      return {
        ...w,
        code: orderOf(now)
          ? { label: spent, value: '' }
          : { label: voucher(euros(capOf(byId(s.id) ?? s), lang)), value: shownVoucher(now.voucher) },
      };
    },
    go: () => {
      const was = byId(s.id),
        sent = person(s.id, p.guest);
      if (was && sent?.link === p.link && reopenable(was, sent)) reopen(was, p.guest);
      const now = byId(s.id),
        seal = guests.seal(p.guest),
        still = person(s.id, p.guest);
      return now && isOpen(now) && seal && still?.link === p.link && onIt(still) ? handOff(now, p.guest, seal) : null;
    },
    shut: (lang, own) => SHUT[lang](own && !!p.submitted && !p.removed),
  };
});
guests.addOnward(onward);
// A guest still on an open share keeps their address, as does one who may still take their notes up again (reopenable);
// one removed, or whose shares ended for good, is free to invite again at another.
guests.addHolder(
  guest =>
    !!db
      .prepare(
        `select 1 from review_share_people p join review_shares s on s.id = p.share
        where p.guest = ? and p.removed is null and s.ends > ?
          and (s.ended is null or (s.ended_by = 'everyone' and s.view = 0 and p.submitted is not null))`,
      )
      .get(guest, new Date().toISOString()),
);
