// Board-created notebooks and the individual guests allowed to read and edit their pages.
import { db, inOneStep } from './db.ts';
import * as guests from './guests.ts';
import * as shares from './shares.ts';
import { managedNotebook } from './notebookaccess.ts';
import { active, forGuest, memberships, reviewMember, whoOf, type Membership } from './notebookmembers.ts';
import * as people from './ink/sketchpeople.ts';
import * as notebook from './notebook.ts';
import * as groups from './notebookgroups.ts';
import * as rounds from './notebookrounds.ts';
import { findAgent } from './jobs.ts';
import { BOARD } from './ink/book.ts';
import { TEXTS_MAX, WORDS_MAX, isRefused, labelOf, type Refused } from './pagechecks.ts';
import { TEXT_MAX } from '../../hq/shell/ink/notebookparts.js';

// The board's invite: one guest's own notebook, for good. A review round starts in Reviews (notebookreviews.ts).
export function createInvitedNotebook(b: any) {
  if (b?.kind !== undefined && b.kind !== 'invited') return [400, 'start a review round from Reviews'] as Refused;
  const person = Array.isArray(b?.people) && b.people.length === 1 ? b.people[0] : null;
  if (!person) return [400, 'an invited notebook has one invitee'] as Refused;
  const name = labelOf(b.name === undefined || b.name === '' ? person.name : b.name);
  if (isRefused(name)) return name;
  if (!name) return [400, 'give the notebook a name'] as Refused;
  const email = person.email === undefined ? guests.emailOf(String(person.name ?? '').trim()) : person.email;
  const guest = guests.invite(person.name, email);
  if (Array.isArray(guest)) return guest;
  return inOneStep(() => {
    const id = notebook.makeNotebook(BOARD, 'invited', name);
    addMember(id, guest.name, null);
    notebook.changed(id, null);
    return { notebook: describe(id) };
  });
}

const membersOf = (notebookId: number) => memberships().filter(m => m.notebook === notebookId);
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

export function addMember(notebookId: number, name: string, ends: string | null) {
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
  const members = name ? forGuest(name) : memberships();
  const ids = [...new Set(members.map(m => m.notebook))].filter(id => !only || id === only);
  return {
    notebooks: ids.map(id => describe(id, name)),
    limits: {
      noteCharacters: TEXT_MAX,
      replyCharacters: WORDS_MAX,
      typedNotes: TEXTS_MAX,
    },
  };
}

function describe(id: number, name?: string) {
  const n = notebook.notebookRow(id, BOARD)!;
  const all = membersOf(id),
    members = name ? all.filter(m => m.guest.toLowerCase() === name.toLowerCase() && active(m)) : all;
  const round = rounds.roundOf(id);
  const state = round?.closed ? 'closed' : 'open';
  // (the board reads a round's own chapters after its guests' pages: its Asks and Advice.)
  const own = name ? [] : chaptersOf(id),
    unwrapped = !!round && rounds.stateOf(round) === 'done';
  const pages = [
    ...members
      .flatMap(m => pagesFor(m))
      .map(p => ({
        ...notebook.pageOf(p),
        canSend: p.send_at === null && state === 'open' && !!members.find(m => active(m) && whoOf(m) === p.who),
        canUndo: p.send_at !== null && (round ? !round.closed : !notebook.gone(p)),
        readonly: p.send_at !== null || state !== 'open' || !members.some(m => active(m) && whoOf(m) === p.who),
      })),
    ...own.map(p => ownPage(p, unwrapped)),
  ];
  return {
    id,
    name: n.name,
    kind: n.kind,
    archived: !!n.archived,
    state,
    ends: members[0]?.ends ?? null,
    round: name || !round ? undefined : rounds.roundSummary(id),
    pages,
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

// The board writes on its Asks, and on its Advice once unwrapped, and submits an Advice page as its own
const ownPage = (p: notebook.NotebookPage, unwrapped: boolean) => ({
  ...notebook.pageOf(p),
  canSend: p.send_at === null && p.kind === 'advice' && unwrapped,
  canUndo: false,
  readonly: p.send_at !== null || (p.kind === 'advice' && !unwrapped),
});
const chaptersOf = (id: number) =>
  (
    db
      .prepare(
        "select id from book_pages where notebook = ? and who = ? and kind in ('asks', 'advice') order by pos, id",
      )
      .all(id, BOARD) as { id: number }[]
  ).map(p => notebook.pageRow(p.id, null)!);
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
        // (a guest's own asks are the board's scraps handed to them: forYou till they write on one.)
        ...(name ? { asks: [], forYou: waitsFor(g.id) } : {}),
        owner,
        owner_name: owner ? (findAgent(owner)?.name ?? owner) : null,
      };
    }),
  };
}

// A copy handed to a guest (ink/bookassign.ts) still waiting for their Answer
export const waitsFor = (group: number) =>
  !!db.prepare('select 1 from notebook_assigns where copy = ? and answered = 0').get(group);

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
export function roomLink(name: string, door: string) {
  const person = shares.personAt(door);
  const member =
    forGuest(name).find(m => m.link === door) ??
    (person?.guest.toLowerCase() === name.toLowerCase() ? reviewMember(person.share, name) : undefined);
  return member ? `/guest/notebooks/?notebook=${member.notebook}` : '/guest/notebooks/';
}
