// The board's saved delivery addresses, for the desk phone's address cards (a credential request whose four keys are one
// address: hq ask/request --address, secrets.ts addressKeys). The board saves one under a label of its own as it saves a
// card, picks it on a later card instead of typing it again, and removes it from the same place. Its label is in the
// database; the address itself is in the key store like a key (secrets.ts keepAddress), so it's never in text, a job, a
// brief or a report, and the board's browser never gets it back. Only a card the board saves it into passes it on, into
// that card's own keys, which its tool reads as before.
import { db } from './db.ts';
import { keepAddress, savedAddress, dropAddress } from './secrets.ts';

const MOST = 20;
// Each part is one line
const PART = /^[^\p{Cc}]{1,200}$/u,
  LABEL = /^[^\p{Cc}]{1,40}$/u;

// The labels, for an address card's list (never the addresses)
export const list = () =>
  (
    db.prepare('select id, label from addresses order by label collate nocase, id').all() as {
      id: number;
      label: string;
    }[]
  ).map(({ id, label }) => ({ id, label }));

// Why a label can't be saved, or null
export function refusal(label: unknown) {
  const l = typeof label === 'string' ? label.trim() : '';
  if (!LABEL.test(l)) return 'Give the address a short name to save it under (up to 40 characters), like Home.';
  if (db.prepare('select 1 from addresses where label = ? collate nocase').get(l))
    return `You already have an address called “${l}”: give this one another name.`;
  if (list().length >= MOST) return `You have ${MOST} saved addresses: remove one first.`;
  return null;
}

// Saves the four parts under the label (refusal() checked first); false if a part isn't one line
export function save(label: string, parts: string[]) {
  if (refusal(label) || parts.length !== 4 || !parts.every(p => PART.test(p))) return false;
  const { lastInsertRowid } = db
    .prepare('insert into addresses (label, created) values (?, ?)')
    .run(label.trim(), new Date().toISOString());
  keepAddress(Number(lastInsertRowid), parts);
  return true;
}

// The four parts of a saved address, or null if it's gone
export const parts = (id: number) =>
  db.prepare('select 1 from addresses where id = ?').get(id) ? savedAddress(id) : null;

export function remove(id: number) {
  if (!db.prepare('select 1 from addresses where id = ?').get(id)) return 404;
  dropAddress(id); // first: if the file can't go, the address stays listed and the removal can be tried again
  db.prepare('delete from addresses where id = ?').run(id);
  return { ok: true, addresses: list() };
}
