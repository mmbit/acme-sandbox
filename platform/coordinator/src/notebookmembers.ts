// A guest's memberships of the board's notebooks, as read by the notebook code and Reviews: who they are on each page,
// whether it's still open to them, and their one link to their shelf. It reads no group or delivery code.
import { db } from './db.ts';
import * as guests from './guests.ts';
import * as shares from './shares.ts';
import * as people from './ink/sketchpeople.ts';

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
export const memberships = () => db.prepare('select * from notebook_guests order by id').all() as Membership[];
export const active = (m: Membership) =>
  !m.revoked &&
  (!m.ends || m.ends > new Date().toISOString()) &&
  people.grantOf(m.guest)?.id === m.grant_id &&
  reviewAccess(m);
// A Reviews share's notebook (notebookreviews.ts) is open to the people still on its open share
function reviewAccess(m: Membership) {
  const share = reviewShare(m.notebook);
  if (!share) return true;
  return (
    shares.isOpen(share) &&
    shares.people(share.id).some(person => shares.onIt(person) && person.guest.toLowerCase() === m.guest.toLowerCase())
  );
}
const reviewShare = (notebookId: number) => {
  const linked = db.prepare('select share from notebook_reviews where notebook = ?').get(notebookId) as
    { share: number } | undefined;
  return linked && shares.byId(linked.share)!;
};

export const whoOf = (m: Membership) => `guest:${m.grant_id}`;
export const forGuest = (name: string) =>
  memberships().filter(m => m.guest.toLowerCase() === name.toLowerCase() && active(m));
// Everyone invited to a notebook of their own
export const invitedPeople = () => {
  const invited = db
    .prepare(
      "select g.guest from notebook_guests g join notebooks n on n.id = g.notebook where n.kind = 'invited' order by g.id",
    )
    .all() as { guest: string }[];
  return [...new Set(invited.map(m => m.guest))];
};
// A Reviews share's guest on its notebook, while it's open to them
export function reviewMember(share: number, name: string) {
  const linked = db.prepare('select notebook from notebook_reviews where share = ?').get(share) as
    { notebook: number } | undefined;
  return linked && forGuest(name).find(m => m.notebook === linked.notebook);
}
// A guest's one link to their shelf of books, the same on every share (notebookguestshelf.ts opens it)
export const shelfLink = (name: string) => guests.doorLink(`shelf:${name.toLowerCase()}`).url;
