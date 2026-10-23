// A conversation's messages as HQ's cards show them and the models read them, health details left out for a model.
import { db } from './db.ts';
import { healthTerm } from '../public/health.js';

const CHAT_MAX = 200;

// The conversation as HQ's card shows it and the drafts read it: its messages after `after`, oldest first, the newest
// CHAT_MAX at most. Read when it's used, so what was said until then goes too. A customer's message with a health
// detail never goes to a model: `people` (HQ's card, which a person reads) gets the ones the customer sent to a person,
// marked `health: true`; a model's prompt (a draft, a summary) gets none of them. The check runs again on the rest (a
// term added to the lists since): one it holds now goes nowhere, like a held one, since nobody consented.
export function chat(conversation: number | null, after = 0, people = false) {
  if (conversation == null) return [];
  const newest = db
    .prepare(
      `select id, at, who, text, health from messages
      where conversation = ? and id > ? and text != '' and (health is null${people ? " or health = 'person'" : ''})
      order by id desc limit ?`,
    )
    .all(conversation, after, CHAT_MAX) as any[];
  return newest
    .reverse()
    .filter(m => m.who !== 'me' || m.health === 'person' || !healthTerm(m.text))
    .map(m => ({
      id: m.id as number,
      at: new Date(m.at).toISOString(),
      who: m.who === 'me' ? 'customer' : 'ai',
      text: m.text as string,
      ...(m.health ? { health: true } : {}),
    }));
}
