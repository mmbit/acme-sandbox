// The action store: what a confirmation button does is stored here by the server, and a tap
// sends only its id. Nothing the model wrote is kept as a label: the caller renders the button from a template of
// `kind` and `args`, and checks the grant and the business rule again when it's tapped.
import { db, now, token } from './db.ts';

export type Action = { id: string; conversation: number; shop: string; kind: string; args: any; created: number; expires: number };

export function propose(a: { conversation: number; session: string; shop: string; kind: string; args: object; ttlMs: number }): { id: string } {
  const id = token(18), t = now();   // 144 random bits: the id is all a tap carries, so it must not be guessable
  db.prepare('insert into actions (id, conversation, session, shop, kind, args, created, expires) values (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, a.conversation, a.session, a.shop, a.kind, JSON.stringify(a.args), t, t + a.ttlMs);
  return { id };
}

// The action, once: only in the session and shop that it was proposed in (a shop's,
// as its session is), and before it expires. One statement, so two taps at once can't both get it. kind: only an action
// of that kind (any other is left as it was).
export function take(id: string, session: string, shop: string, kind: string | null = null): Action | null {
  const r = db.prepare(`update actions set used = ? where id = ? and session = ? and shop = ? and used is null and expires > ? and (? is null or kind = ?)
    returning id, conversation, shop, kind, args, created, expires`).get(now(), String(id ?? ''), session, shop, now(), kind, kind) as any;
  return r ? { ...r, args: JSON.parse(r.args) } : null;
}

// What it did, kept with it (the app's answer: ok, a reference, or why not).
export function done(id: string, result: object) {
  db.prepare('update actions set result = ? where id = ?').run(JSON.stringify(result), id);
}

// Actions that can no longer be taken (a card whose note care removed: engine.ts removeHealth()), whatever their expiry.
export function revoke(ids: string[]) {
  const end = db.prepare('update actions set expires = 0 where id = ? and used is null');
  for (const id of ids) end.run(id);
}
