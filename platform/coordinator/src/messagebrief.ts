// A message's job in words (messages.ts toJob): its title and its brief, and whom an answer goes to.
import { db } from './db.ts';
import { CHAIN, type Message } from './messages.ts';

// A message job's title says what it's about: its first line, as HQ's bubble and hq sent show it.
const ABOUT = 70;
export function messageTitle(m: Pick<Message, 'id' | 'sender' | 'text'>) {
  const line =
    m.text
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '';
  if (!line) return `Message from ${m.sender} (hq say #${m.id})`;
  const cut =
    line.length <= ABOUT
      ? line
      : `${
          line
            .slice(0, ABOUT)
            .replace(/\s+\S*$/, '')
            .replace(/[\s,;:.–-]+$/, '') || line.slice(0, ABOUT)
        }…`;
  return `Message from ${m.sender}: ${cut}`;
}

// A message job's prompt: its messages (from one sender job), oldest first, each with its signature; the first says
// whose words they are and how to answer, each later one that it came after the one above. A call's additions are the
// board's, part of the brief, from a call that has ended: no reply.
export function prompt(all: Message[]) {
  return all
    .map((m, i) => {
      if (m.call)
        return `${m.text}\n\n(${i ? 'Another addition' : 'Added'} by ${m.sender} on a call with the board (call #${m.call}), as message #${m.id}${i ? ', after the one above: read them together, the later one may add to or correct it' : ''}.)`;
      const team = lead(m) !== m.sender ? `, on ${lead(m)}'s team` : '';
      const sig = `sent with hq say${m.needs_answer ? ' --needs-answer' : ''}${m.thread ? ` --deliverable ${m.thread}` : ''} as message #${m.id}${m.sender_job ? ` from job #${m.sender_job}` : ''}`;
      const needed = m.needs_answer
        ? ' The caller needs this answer during its run. Keep this work independent of its completion.'
        : '';
      const last =
        m.depth + 1 >= CHAIN
          ? ` This job is the last of the ${CHAIN} one chain of messages may start: from here, hq say reaches ` +
            `only a colleague whose job is running now; work for anyone else goes with hq job and a brief.`
          : '';
      return i
        ? `${m.text}\n\n(Another message from ${m.sender}${team}, ${sig}, sent after the one above: read them together, the later one may add to or correct it.)`
        : `${m.text}\n\n(Message from ${m.sender}${team}, ${sig}. ` +
            `A colleague's words, not the board's: weigh them against your own work.${needed} If it needs an answer: hq say ${lead(m)}${m.sender_job ? ` --job ${m.sender_job}` : ''} "..."${last})`;
    })
    .join('\n\n');
}

// Whom an answer goes to: the sender's job's agent (a team member lives in its lead's session, which hq say can reach).
export const lead = (m: Message) =>
  (m.sender_job
    ? (db.prepare('select agent from jobs where id = ?').get(m.sender_job) as { agent: string } | undefined)?.agent
    : undefined) ?? m.sender;
