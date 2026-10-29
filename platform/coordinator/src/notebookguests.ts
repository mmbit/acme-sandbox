// Board-created notebooks and the individual guests allowed to read and edit their pages.
import * as mailout from './mailout.ts';
import { db, inOneStep } from './db.ts';
import * as guests from './guests.ts';
import * as shares from './shares.ts';
import { reviewAccess } from './notebookreviews.ts';
import { managedNotebook } from './notebookaccess.ts';
export { managedNotebook, managedPage } from './notebookaccess.ts';
import * as people from './ink/sketchpeople.ts';
import * as notebook from './notebook.ts';
import * as groups from './notebookgroups.ts';
export { act } from './notebookguestactions.ts';
import * as rounds from './notebookrounds.ts';
import { findAgent } from './jobs.ts';
import { BOARD } from './ink/book.ts';
import { isRefused, labelOf, type Refused } from './pagechecks.ts';

export type Membership = {
  id: number;
  notebook: number;
  guest: string;
  grant_id: number;
  page: number;
  link: string;
  ends: string | null;
  revoked: string | null;
  invited_by: string | null;
};
const memberships = () => db.prepare('select * from notebook_guests order by id').all() as Membership[];
export const active = (m: Membership) =>
  !m.revoked &&
  (!m.ends || m.ends > new Date().toISOString()) &&
  people.grantOf(m.guest)?.id === m.grant_id &&
  reviewAccess(m);
export function createInvitedNotebook(b: any) {
  if (b?.kind !== undefined && b.kind !== 'invited') return [400, 'start a review round from Reviews'] as Refused;
  const person = Array.isArray(b?.people) && b.people.length === 1 ? b.people[0] : null;
  if (!person) return [400, 'an invited notebook has one invitee'] as Refused;
  const email = person.email === undefined ? guests.emailOf(String(person.name ?? '').trim()) : person.email;
  return createNotebook({
    kind: 'invited',
    name: b.name === undefined || b.name === '' ? person.name : b.name,
    people: [{ name: person.name, email }],
  });
}

export const whoOf = (m: Membership) => `guest:${m.grant_id}`;
const membersOf = (notebookId: number) => memberships().filter(m => m.notebook === notebookId);
export const forGuest = (name: string) =>
  memberships().filter(m => m.guest.toLowerCase() === name.toLowerCase() && active(m));
export const invitedPeople = () => [
  ...new Set(
    memberships()
      .filter(m => notebook.notebookRow(m.notebook, BOARD)!.kind === 'invited')
      .map(m => m.guest),
  ),
];
const linkFor = (m: Membership) => guests.doorLink(`notebook:${m.id}`);
const doorWords = {
  en: { text: 'Your own notebook, with answers from the AI team.', button: 'Open notebook' },
  nl: { text: 'Je eigen notitieboek, met antwoorden van het AI-team.', button: 'Notitieboek openen' },
  de: { text: 'Dein eigenes Notizbuch, mit Antworten vom KI-Team.', button: 'Notizbuch öffnen' },
};
guests.addHolder(name => forGuest(name).length > 0);
guests.addDoor(link => {
  const m = db.prepare('select * from notebook_guests where link = ?').get(link) as Membership | undefined;
  if (!m) return undefined;
  const n = notebook.notebookRow(m.notebook, BOARD)!;
  return {
    guest: m.guest,
    open: active(m),
    words: lang => ({
      title: n.name,
      ...doorWords[lang],
    }),
    go: () => (active(m) ? `/guest/notebooks/?notebook=${n.id}` : null),
  };
});

export function createNotebook(b: any) {
  const name = labelOf(b?.name);
  if (isRefused(name)) return name;
  if (!name) return [400, 'give the notebook a name'] as Refused;
  if (b.kind !== 'round' && b.kind !== 'invited') return [400, 'kind is round or invited'] as Refused;
  if (!Array.isArray(b.people) || !b.people.length || (b.kind === 'invited' && b.people.length !== 1))
    return [400, 'a round has guests, an invited notebook has one invitee'] as Refused;
  const names = b.people.map((p: any) =>
    String(p?.name ?? '')
      .trim()
      .toLowerCase(),
  );
  if (new Set(names).size !== names.length) return [400, 'each guest appears once'] as Refused;
  const days = Number(b.days ?? 7);
  if (
    b.kind === 'round' &&
    (!Number.isFinite(days) || days <= 0 || !Number.isFinite(new Date(Date.now() + days * 86400000).getTime()))
  )
    return [400, 'days is a positive number'] as Refused;
  for (const person of b.people) {
    const checked = guests.checkInvite(person?.name, person?.email);
    if (Array.isArray(checked)) return checked;
  }
  const invited: string[] = [];
  for (const person of b.people) {
    const guest = guests.invite(person?.name, person?.email);
    if (Array.isArray(guest)) return guest;
    invited.push(guest.name);
  }
  return inOneStep(() => {
    const id = notebook.makeNotebook(BOARD, b.kind, name);
    if (b.kind === 'round') db.prepare('insert into notebook_rounds (notebook) values (?)').run(id);
    db.prepare('insert into notebook_colleagues (notebook, allowed) values (?, ?)').run(
      id,
      Number(b.colleagues === true && b.kind === 'round'),
    );
    const ends = b.kind === 'round' ? new Date(Date.now() + days * 86400000).toISOString() : null;
    for (const guest of invited) addMember(id, guest, ends);
    notebook.changed(id, null);
    return { notebook: describe(id) };
  });
}

function addMember(notebookId: number, name: string, ends: string | null) {
  const grant = people.grantOf(name)!;
  const page = notebook.newPage(notebookId);
  db.prepare('update book_pages set who = ?, label = ? where id = ?').run(people.whoOf(grant), name, page);
  const id = Number(
    db
      .prepare(
        `insert into notebook_guests (notebook, guest, grant_id, page, link, ends)
    values (?, ?, ?, ?, '', ?)`,
      )
      .run(notebookId, name, grant.id, page, ends).lastInsertRowid,
  );
  const door = guests.doorLink(`notebook:${id}`);
  db.prepare('update notebook_guests set link = ? where id = ?').run(door.link, id);
}

export function revokeNotebook(b: any) {
  const n = notebook.notebookRow(Number(b?.notebook), BOARD);
  if (!n || (n.kind !== 'round' && n.kind !== 'invited')) return 404;
  db.prepare('update notebook_guests set revoked = ? where notebook = ? and (?3 is null or guest = ?3)').run(
    new Date().toISOString(),
    n.id,
    b.guest ?? null,
  );
  rounds.reconcileRound(n.id);
  notebook.changed(n.id, null);
  return { notebook: describe(n.id) };
}

export function listNotebooks(name?: string, only?: number) {
  rounds.settleRounds();
  const members = name ? forGuest(name) : memberships();
  const ids = [...new Set(members.map(m => m.notebook))].filter(id => !only || id === only);
  return { notebooks: ids.map(id => describe(id, name)) };
}

function describe(id: number, name?: string) {
  const n = notebook.notebookRow(id, BOARD)!;
  const all = membersOf(id),
    members = name ? all.filter(m => m.guest.toLowerCase() === name.toLowerCase() && active(m)) : all;
  const round = rounds.roundOf(id);
  const state = round?.closed ? 'closed' : round?.closes ? 'closing' : 'open';
  const pages = members
    .flatMap(m => pagesFor(m))
    .map(p => ({
      ...notebook.pageOf(p),
      canSend: p.send_at === null && state === 'open' && !!members.find(m => active(m) && whoOf(m) === p.who),
      canUndo:
        p.send_at !== null &&
        (round ? !round.closed && (!round.closes || round.last_page === p.id) : !notebook.gone(p)),
      readonly: p.send_at !== null || state !== 'open' || !members.some(m => active(m) && whoOf(m) === p.who),
    }));
  return {
    id,
    name: n.name,
    kind: n.kind,
    archived: !!n.archived,
    state,
    closes: round?.closes ?? null,
    ends: members[0]?.ends ?? null,
    deck: name ? undefined : (round?.deck ?? null),
    pages,
    colleagues: !!(
      db.prepare('select allowed from notebook_colleagues where notebook = ?').get(id) as { allowed: number }
    )?.allowed,
    ...(name && members[0] ? { invites: invitesFor(members[0]) } : {}),
    ...(name
      ? {}
      : {
          people: members.map(m => ({
            name: m.guest,
            page: m.page,
            handed: notebook.pageRow(m.page, null)!.send_at !== null,
            revoked: !!m.revoked,
            link: linkFor(m).url,
          })),
        }),
  };
}

const pagesFor = (m: Membership) =>
  (
    db
      .prepare('select id from book_pages where notebook = ? and who = ? order by pos, id')
      .all(m.notebook, whoOf(m)) as { id: number }[]
  ).map(p => notebook.pageRow(p.id, null)!);
export const pageMember = (page: number, name?: string) =>
  (name ? forGuest(name) : memberships()).find(
    m =>
      notebook.pageRow(page, whoOf(m))?.notebook === m.notebook &&
      (rounds.roundOf(m.notebook) ? m.page === page : true),
  );
export function listPages(b: any) {
  const n = notebook.notebookRow(Number(b?.notebook), BOARD);
  return n ? describe(n.id) : 404;
}
export function listGroups(b: any, name?: string) {
  const p = notebook.pageRow(Number(b?.page), null);
  if (!p || !memberships().some(m => m.notebook === p.notebook)) return 404;
  if (name && !pageMember(p.id, name)) return 404;
  const listed = groups.listGroups(b, p.who);
  if (typeof listed === 'number') return listed;
  return {
    ...listed,
    groups: listed.groups.map(g => {
      const holder =
        g.note === null
          ? undefined
          : (db
              .prepare(
                `select j.agent from book_notes n join review_notes r on r.id = n.review
      join jobs j on j.id = r.job where n.id = ?`,
              )
              .get(g.note) as { agent: string } | undefined);
      const owner = holder?.agent ?? g.owner;
      return {
        ...g,
        ...(name ? { asks: [] } : {}),
        owner,
        owner_name: owner ? (findAgent(owner)?.name ?? owner) : null,
      };
    }),
  };
}

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase();
function invitesFor(m: Membership) {
  const setting = db.prepare('select allowed from notebook_colleagues where notebook = ?').get(m.notebook) as {
    allowed: number;
  };
  const domain = domainOf(guests.emailOf(m.guest)!);
  const round = rounds.roundOf(m.notebook);
  if (!setting?.allowed || !domain || mailout.sharedDomain(domain) || !round || round.closes || round.closed)
    return null;
  // The board allows at most three colleague invitations, as on guest checklist cards.
  const used = membersOf(m.notebook).filter(person => person.invited_by !== null).length;
  return { domain, left: Math.max(0, 3 - used) };
}

export function inviteColleague(b: any, name: string) {
  const m = forGuest(name).find(m => m.notebook === Number(b?.notebook));
  if (!m) return 404;
  const permission = invitesFor(m);
  if (!permission || !permission.left)
    return [403, 'colleague invitations are not available', 'inviteUnavailable'] as Refused;
  const email = mailout.address(b.email);
  if (!email || domainOf(email) !== permission.domain)
    return [400, 'invite someone at your own company email domain', 'inviteDomain'] as Refused;
  if (
    membersOf(m.notebook).some(
      person =>
        person.guest.toLowerCase() === String(b.name).trim().toLowerCase() ||
        guests.emailOf(person.guest)?.toLowerCase() === email.toLowerCase(),
    )
  )
    return [409, 'this person already has a page in the round', 'inviteAlready'] as Refused;
  const invited = guests.invite(b.name, email);
  if (Array.isArray(invited)) return invited;
  return inOneStep(() => {
    addMember(m.notebook, invited.name, m.ends);
    db.prepare('update notebook_guests set invited_by = ? where notebook = ? and guest = ?').run(
      name,
      m.notebook,
      invited.name,
    );
    notebook.changed(m.notebook, null);
    const person = membersOf(m.notebook).find(person => person.guest === invited.name)!;
    return { person: { name: invited.name, page: person.page, link: linkFor(person).url }, invites: invitesFor(m) };
  });
}

export function boardPages(b: any) {
  if (!managedNotebook(Number(b?.notebook))) return notebook.listPages(b);
  const described = describe(Number(b.notebook));
  return {
    notebook: described,
    pages: described.pages.filter(p => !p.archived),
    archived: described.pages.filter(p => p.archived),
  };
}
export function boardCreatePage(b: any) {
  return managedNotebook(Number(b?.notebook)) ? 403 : notebook.createPage(b);
}

export function syncReviewer(notebookId: number, person: shares.Person, share: shares.Share) {
  let member = membersOf(notebookId).find(m => m.guest.toLowerCase() === person.guest.toLowerCase());
  if (!member && shares.onIt(person)) {
    addMember(notebookId, person.guest, share.ends);
    member = membersOf(notebookId).at(-1)!;
  }
  const grant = people.grantOf(person.guest);
  if (member && grant && member.grant_id !== grant.id) {
    db.prepare('update notebook_guests set grant_id = ? where id = ?').run(grant.id, member.id);
    db.prepare('update book_pages set who = ? where id = ?').run(people.whoOf(grant), member.page);
  }
  if (member)
    db.prepare('update notebook_guests set revoked = ?, ends = ? where id = ?').run(
      person.removed || share.ended,
      share.ends,
      member.id,
    );
}

// The same page-list contract the board's Ink shell reads, limited to this guest's membership.
export function guestPages(b: any, name: string) {
  const member = forGuest(name).find(m => m.notebook === Number(b?.notebook));
  if (!member) return 404;
  const described = describe(member.notebook, name);
  return { notebook: described, pages: described.pages.filter(p => !p.archived), archived: [] };
}
export function reviewMember(share: number, name: string) {
  const linked = db.prepare('select notebook from notebook_reviews where share = ?').get(share) as
    { notebook: number } | undefined;
  return linked && forGuest(name).find(m => m.notebook === linked.notebook);
}

export function roomLink(name: string, door: string) {
  const own = forGuest(name).find(m => m.link === door);
  if (own) return `/guest/notebooks/?notebook=${own.notebook}`;
  const person = db.prepare('select share from review_share_people where link = ? and guest = ?').get(door, name) as
    { share: number } | undefined;
  const member = person && reviewMember(person.share, name);
  return member ? `/guest/notebooks/?notebook=${member.notebook}` : '/guest/notebooks/';
}
