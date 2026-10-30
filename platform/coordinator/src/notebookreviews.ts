// Reviews shares own their round notebook, invitations, expiry and shelf lifetime.
import { db, inOneStep } from './db.ts';
import * as shares from './shares.ts';
import * as notebook from './notebook.ts';
import * as rounds from './notebookrounds.ts';
import { syncReviewer } from './notebookguests.ts';
import { BOARD } from './ink/book.ts';
import { ownerOf } from './owed.ts';
import { companyTime } from './company.ts';
export function reviewAccess(m: { notebook: number; guest: string }) {
  const linked = db.prepare('select share from notebook_reviews where notebook = ?').get(m.notebook) as
    { share: number } | undefined;
  if (!linked) return true;
  const share = shares.byId(linked.share)!;
  return (
    shares.isOpen(share) &&
    shares.people(share.id).some(person => shares.onIt(person) && person.guest.toLowerCase() === m.guest.toLowerCase())
  );
}
db.exec('create table if not exists notebook_reviews (share integer primary key, notebook integer not null unique)');

// Reviews owns the round's invitation and expiry. Its notebook is made once, at the first invite.
export function syncReviewNotebook(share: shares.Share) {
  if (share.view) return;
  return inOneStep(() => {
    let linked = db.prepare('select notebook from notebook_reviews where share = ?').get(share.id) as
      { notebook: number } | undefined;
    if (!linked) {
      if (!shares.isOpen(share)) return;
      const name = `${ownerOf(share.about).name}: ${companyTime(Date.parse(share.created))}`;
      const id = notebook.makeNotebook(BOARD, 'round', name);
      db.prepare('insert into notebook_rounds (notebook) values (?)').run(id);
      db.prepare('insert into notebook_reviews (share, notebook) values (?, ?)').run(share.id, id);
      linked = { notebook: id };
    }
    for (const person of shares.people(share.id)) syncReviewer(linked.notebook, person, share);
    const round = rounds.roundOf(linked.notebook)!;
    if (shares.isOpen(share) && shares.people(share.id).some(shares.onIt) && round.closed && !round.advice) {
      db.prepare('update notebook_rounds set closed = null where notebook = ?').run(linked.notebook);
      db.prepare('update notebooks set archived = 0 where id = ?').run(linked.notebook);
    }
    if (share.ended || Date.parse(share.ends) <= Date.now()) {
      db.prepare('update notebooks set archived = 1 where id = ?').run(linked.notebook);
    }
    rounds.reconcileRound(linked.notebook);
    notebook.changed(linked.notebook, null);
    return linked.notebook;
  });
}

// Existing Reviews invitations get the same notebook association when the coordinator starts.
export function syncOpenReviews() {
  for (const share of shares.list()) {
    if (shares.isOpen(share) && !share.view && shares.people(share.id).some(shares.onIt)) syncReviewNotebook(share);
  }
}
