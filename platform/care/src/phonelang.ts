// The reply's language on the phone, as metadata: the model opens each reply
// with its tag, which the turn (phone.ts) takes off and streams as a line of its own, so the voice line speaks it in
// that language's voice. A reply is in the language the caller speaks, which is the model's to hear: nothing reads it
// from their words. A turn whose first words come without a tag is asked again once, then goes unanswered: never
// spoken in a guessed voice. Once the call is held to a language, untagged words are in it: nothing else could be said
// (another language is asked again), so a reply after a tool that leaves its tag off still gets said.
// A company with one language has nothing to tell apart, so no tag.
// The call's language settles with the caller's second reply in a language they have heard the notice in (`settled`):
// one short first reply can't show which language they understand ("Hallo?" is Dutch and German). The call is held to
// that language, or to one the caller asked for (`locked`): a reply tagged otherwise is asked again once, told so (a
// turn that reads as another language is most often the speech recogniser mishearing), then goes unanswered; only
// switch_language, the caller asking, moves it
import { languageName } from './texts.ts';
import { settings } from './company.ts';
import { db } from './db.ts';
import type * as model from './model.ts';
import { healthTerm } from '../public/health.js';
import { save, spokenIn, heldFor, informedIn, type Conv } from './phonecall.ts';

export const tagOf = (l: string) => `[${l}]`;
export const tagged = () => settings.langs.length > 1;
export class UntaggedError extends Error {}
// a reply tagged in another language than the one the call is held to
export class OffLanguageError extends UntaggedError {}
export const tagging = () =>
  !tagged()
    ? ''
    : `LANGUAGE. Answer in the language the caller speaks: ${settings.langs.map(l => `${languageName(l)} ${tagOf(l)}`).join(', ')}. ` +
      "Start every reply with its tag, before any words (the line picks the voice by it; nobody hears it). Once the facts say the call is settled in a language, keep to it: the caller's words come through speech recognition, which can mishear a turn as another language. Change language only when the caller asks for it, by calling switch_language first.";
// A round's words as they come, with the tag taken off its start: wait while what's come could still be one
function untag(head: string): { lang?: string; text: string } | null {
  const lead = head.trimStart();
  const l = settings.langs.find(x => lead.startsWith(tagOf(x)));
  if (l) return { lang: l, text: lead.slice(tagOf(l).length).trimStart() };
  return settings.langs.some(x => tagOf(x).startsWith(lead)) ? null : { text: head };
}

// whether the turn has said anything yet: each later piece (a round's words, a tool's) follows after a space, so
// "code. Zeg" is never "code.Zeg", read as one word; the language it speaks in (the model's last tag), and whether a
// tag set it yet (its first words need one; a later round's go on in it).
//
// counted: the languages this turn's reply was counted in towards settling, each once.
export type Spoken = { any: boolean; lang: string; tagged: boolean; counted?: string[] };
type Said = { text: string } | { lang: string };

// A round's words as the line gets them: the language tag at their start read first (a { lang } line, the call's
// language from then on, and the language of the caller's words held back: phonecall.ts), then each piece, the first
// after the turn's earlier words with a space
export function wording(c: Conv, spoken: Spoken) {
  let head: string | null = '', // the words until the tag is read (null after)
    written = '';
  const out = (piece: string): Said[] => {
    const text = spoken.any && !written && !/^\s/.test(piece) ? ` ${piece}` : piece;
    spoken.any = true;
    written += text;
    return [{ text }];
  };
  // the round's first words, their tag read: an untagged reply on a call held to a language is in it
  const said = (read: { lang?: string; text: string }): Said[] => {
    const p = c.state.phone,
      lang = read.lang ?? (spoken.tagged ? undefined : p.locked);
    if (!lang && !spoken.tagged) throw new UntaggedError();
    if (lang && p.locked && lang !== p.locked) throw new OffLanguageError();
    head = null;
    if (lang) {
      settling(c, spoken, lang);
      spoken.tagged = true;
      spokenIn(c, lang);
    }
    if (lang && lang !== spoken.lang) {
      spoken.lang = c.state.lang = lang;
      save(c);
    }
    return [...(lang ? [{ lang }] : []), ...(read.text ? out(read.text) : [])];
  };
  return {
    get written() {
      return written;
    },
    take(piece: string): Said[] {
      if (head === null) return out(piece);
      const read = untag((head += piece));
      return read ? said(read) : [];
    },
    // (words too short to tell from the start of a tag: said as they are once a tag set the language; before one, a
    // reply cut off at a tag's start is no reply, and is asked again)
    end(): Said[] {
      if (!head?.trim()) return [];
      const read = untag(head);
      if (!read && !spoken.tagged) throw new UntaggedError();
      return said(read ?? { text: head });
    },
  };
}

const HEALTH = '[removed: a health detail]';
// the call so far as turns: the caller's words and the helper's (tagged with their language, as the model wrote them),
// those still held back after what's kept; a turn always ends on the caller's
export function history(c: Conv): model.Message[] {
  const kept = db
    .prepare('select who, text, health, lang from messages where conversation = ? order by id desc limit 40')
    .all(c.id) as any[];
  const rows = [
    ...kept.reverse(),
    ...heldFor(c).map(h => ({ who: h.who, text: h.text, health: h.o.health, lang: h.o.lang })),
  ].slice(-40);
  const messages: model.Message[] = [];
  for (const r of rows) {
    const role = r.who === 'me' ? 'user' : 'assistant';
    const text =
      role === 'user' && (r.health === 'removed' || healthTerm(r.text))
        ? HEALTH
        : r.lang && r.text && tagged()
          ? `${tagOf(r.lang)} ${r.text}`
          : r.text;
    if (!text) continue;
    const last = messages.at(-1);
    if (last?.role === role) last.content += '\n\n' + text;
    else messages.push({ role, content: text });
  }
  while (messages[0]?.role === 'assistant') messages.shift();
  return messages;
}

// A reply tagged in this language. Until the call settles, each caller turn counts once in each language its reply is
// tagged in, whether the caller asked for that language or not. The second count in a language they heard the notice
// in settles the call. The line counts the same way (`Call.replies`).
function settling(c: Conv, spoken: Spoken, lang: string) {
  const p = c.state.phone;
  if (p.settled || spoken.counted?.includes(lang)) return;
  (spoken.counted ??= []).push(lang);
  p.replies = { ...p.replies, [lang]: (p.replies?.[lang] ?? 0) + 1 };
  if (p.informed?.includes(lang) && p.replies[lang] >= 2) {
    p.settled = true;
    p.locked = lang;
  }
  save(c);
}

// switch_language: the call goes on in the language the caller asked for. Informed once is informed. Once the call has
// settled (they heard the notice in its language and spoke it twice), the new language needs no notice, and what they
// say next is kept as before. Before then, its lines come first and their words are held.
export function switchLanguage(c: Conv, lang: unknown) {
  const to = String(lang ?? ''),
    p = c.state.phone;
  if (!settings.langs.includes(to))
    return { switched: false, note: `This line speaks ${settings.langs.map(languageName).join(', ')} only.` };
  if (p.settled) informedIn(c, [to]);
  p.locked = to;
  save(c);
  console.log(`care: phone conversation ${c.id}: the caller asked for another language`);
  return { switched: true, note: `Go on in ${languageName(to)}: start your reply with ${tagOf(to)}.` };
}
