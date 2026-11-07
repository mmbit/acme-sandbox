// hq sent: what became of the messages an agent sent (messages.ts).
import { db } from './db.ts';
import * as ledger from './ledger.ts';
import type { Message } from './messages.ts';

// hq sent [id]: what became of the messages this name sent (the latest 20, or one with its text), from this agent's own
// jobs only: a team member's name is its own only inside its lead's job (another job's "helper", or an alumnus's name a
// team member once used, is someone else), so a team member sees its lead's job's only.
// A job working on a call also sees what that call sent (ledger.mine), so its follow-up can check delivery.
export function sent(sender: string, me: { id: number; agent: string }, id?: number) {
  const team = sender !== me.agent;
  const mine = `sender = ? and ${team ? 'sender_job = ?' : '(sender_job in (select id from jobs where agent = ?) or sender_job is null and call is not null)'}`,
    by = [sender, team ? me.id : me.agent];
  const rows = (
    id
      ? db.prepare(`select * from messages where id = ? and ${mine}`).all(id, ...by)
      : db.prepare(`select * from messages where ${mine} order by id desc limit 20`).all(...by)
  ) as Message[];
  const visible = rows.filter(m => m.sender_job !== null || (m.call !== null && ledger.mine(me.id, m.call)));
  if (id && !visible.length) return 404;
  const status = (j: number | null) =>
    j
      ? ((db.prepare('select status from jobs where id = ?').get(j) as { status: string } | undefined)?.status ?? null)
      : null;
  return visible.map(m => ({
    id: m.id,
    to: m.recipient,
    created: m.created,
    job: m.job,
    offered: m.offered,
    delivered: m.delivered,
    became: m.became,
    ...(m.joined ? { joined: m.joined } : {}),
    ...(m.call ? { call: m.call } : {}),
    ...(m.needs_answer ? { needsAnswer: true } : {}),
    ...(m.fan ? { fan: m.fan } : {}),
    lapsed: m.lapsed,
    job_status: status(m.became ?? m.job),
    ...(id ? { text: m.text } : { first: m.text.trim().split('\n')[0] }),
  }));
}
