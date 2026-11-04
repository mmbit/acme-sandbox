// The board's guest on its live call: someone in the room with it, on a device of their own, with their own pen.
//   - The board adds them on the call screen (POST /api/calls/guest: their name, address and language): a guest of the
//     guest desk (guests.ts invite), signed in by an emailed code or their passkey, and a door for this call whose link
//     the board's screen shows as a QR code (HQ's callguest.js).
//   - The door tells them first, in their language, that the call's agent is an AI and the call is written down (the
//     notice in knowledge/notes/compliance/walk-through-calls.md), then opens the guest notebook room at the call's
//     notes page. Muted: the sound is the board's device's.
//   - On that page they draw and write with their pen as the board does, as themselves (their grant's 'guest:<id>', in
//     their colour), and change or delete only their own marks (notebookguestroom.ts). Nothing else of the board's book
//     is open to them, and nothing of HQ.
//   - Each mark on the call's page, theirs or the board's from any screen, reaches the call's agent as it rests, with who
//     drew it (markForVoice, through HQ's calldraw.js and the voice line).
//   - The call ended, the door and the page close to them: the page goes in with the call, as every call's does.
import { db } from './db.ts';
import * as guests from './guests.ts';
import * as people from './ink/sketchpeople.ts';
import { findAgent } from './jobs.ts';
import { boardLanguage } from './language.ts';
import { BOARD } from './ink/book.ts';
import { liveCall, pageFor } from './ink/callnotes.ts';
import { pageOf, pageRow, shut } from './notebook.ts';
import { partsOf, row } from './notebookgroups.ts';
import { heightFor, UNIT_W } from '../../hq/shell/ink/scrapunit.js';
import { boxOf } from '../../hq/shell/ink/notebookstack.js';
import { render } from './ink/bookrender.ts';
import { DIR } from './pagescraps.ts';
import type { Refused } from './pagechecks.ts';

type CallGuest = { id: number; call: number; guest: string; link: string; added: string };

// What the door says before they join, in each language the guest desk has: the walk-through note's notice, word for
// word, then what their pen does on the call
const WORDS = {
  en: {
    title: (agent: string) => `Call with ${agent}`,
    text: (agent: string) =>
      `${agent} is an AI assistant. We keep a written transcript of this call, never its sound. What you draw on the call’s page, ${agent} sees too, and it stays with the call’s notes. Your device stays muted: the call runs through the other device.`,
    button: 'Join the call’s page',
    shut: 'This call has ended.',
  },
  nl: {
    title: (agent: string) => `Gesprek met ${agent}`,
    text: (agent: string) =>
      `${agent} is een AI-assistent. We houden een geschreven verslag van dit gesprek bij, nooit het geluid. Wat je op de pagina van het gesprek tekent, ziet ${agent} ook, en het blijft bij de aantekeningen van het gesprek. Je apparaat blijft stil: het gesprek loopt via het andere apparaat.`,
    button: 'Naar de pagina van het gesprek',
    shut: 'Dit gesprek is afgelopen.',
  },
  de: {
    title: (agent: string) => `Gespräch mit ${agent}`,
    text: (agent: string) =>
      `${agent} ist eine KI. Wir führen ein schriftliches Protokoll dieses Gesprächs, nie eine Tonaufnahme. Was du auf die Seite des Gesprächs zeichnest, sieht ${agent} auch, und es bleibt bei den Notizen des Gesprächs. Dein Gerät bleibt stumm: das Gespräch läuft über das andere Gerät.`,
    button: 'Zur Seite des Gesprächs',
    shut: 'Dieses Gespräch ist beendet.',
  },
} satisfies Record<guests.Lang, unknown>;

const agentName = (call: number) => {
  const c = db.prepare('select agent from calls where id = ?').get(call) as { agent: string } | undefined;
  return c ? (findAgent(c.agent)?.name ?? c.agent) : '';
};

// POST /api/calls/guest { call, name, email, lang? }: the board's guest on its live call, and their door's link. Asked
// again for the same person, the same link.
export function addGuest(b: any) {
  const call = Number(b?.call);
  if (!Number.isInteger(call) || call < 1 || !liveCall(call))
    return [404, 'no live call of yours by that number'] as Refused;
  const lang = b.lang ?? boardLanguage();
  if (!Object.hasOwn(WORDS, lang)) return [400, `lang is one of ${Object.keys(WORDS).join(', ')}`] as Refused;
  const invited = guests.invite(b.name, b.email);
  if (Array.isArray(invited)) return invited as Refused;
  // (the door and its code email in the language the board picked for them)
  db.prepare('update guests set lang = ? where name = ?').run(lang, invited.name);
  if (!people.grantOf(invited.name)) return [409, `${invited.name} has no pen of their own yet`] as Refused;
  if (!pageFor(call)) return [409, 'this call’s notes page couldn’t be opened'] as Refused;
  const found = db.prepare('select * from call_guests where call = ? and guest = ?').get(call, invited.name) as
    CallGuest | undefined;
  const id =
    found?.id ??
    Number(
      db
        .prepare('insert into call_guests (call, guest, added) values (?, ?, ?)')
        .run(call, invited.name, new Date().toISOString()).lastInsertRowid,
    );
  const door = guests.doorLink(`call:${id}`);
  db.prepare('update call_guests set link = ? where id = ?').run(door.link, id);
  return { link: door.url, name: invited.name, address: invited.address };
}

guests.addDoor(link => {
  const g = db.prepare('select * from call_guests where link = ?').get(link) as CallGuest | undefined;
  if (!g) return undefined;
  const agent = agentName(g.call);
  return {
    guest: g.guest,
    open: !!openPage(g),
    words: lang => ({ title: WORDS[lang].title(agent), text: WORDS[lang].text(agent), button: WORDS[lang].button }),
    shut: lang => WORDS[lang].shut,
    go: () => {
      const p = openPage(g);
      return p ? `/guest/notebooks/?notebook=${p.notebook}` : null;
    },
  };
});

// The call's notes page while its call is live and open to its guest, or undefined
function openPage(g: CallGuest) {
  if (!liveCall(g.call) || !people.grantOf(g.guest)) return undefined;
  const p = pageFor(g.call);
  return p && !shut(p) ? p : undefined;
}
// The live calls a guest is on, with their pages
const callsOf = (name: string) =>
  (db.prepare('select * from call_guests where guest = ? order by id desc').all(name) as CallGuest[])
    .map(g => ({ g, page: openPage(g) }))
    .filter(on => on.page);

// Whether the guest is on a live call now (the guest notebook room opens for them)
export const onACall = (name: string) => callsOf(name).length > 0;
// (and a live call holds them at their address: guests.ts gives the name to someone else only once nothing does)
guests.addHolder(onACall);

// The guest's way onto a page of the board's: the call's notes page, while they're its guest. who: the page's owner
// (the board), by: the guest as they write there. undefined: not theirs.
export function onCallPage(page: number, name: string) {
  const on = callsOf(name).find(c => c.page!.id === page);
  const grant = on && people.grantOf(name);
  return grant ? { who: BOARD, by: people.whoOf(grant) } : undefined;
}

// The room's list of a notebook (?notebook=), for a guest on a call whose page is in it: that page alone, as the
// guest's shell reads a notebook of theirs. undefined: none.
export function notebookFor(name: string, notebook: number) {
  const on = callsOf(name).find(c => c.page!.notebook === notebook);
  if (!on) return undefined;
  const agent = agentName(on.g.call);
  const page = { ...pageOf(pageRow(on.page!.id, BOARD)!), canSend: false, canUndo: false, readonly: false };
  return {
    id: notebook,
    name: WORDS[guests.langOf({ lang: guestLang(name) })].title(agent),
    kind: 'call',
    archived: false,
    state: 'open',
    ends: null,
    pages: [page],
  };
}
const guestLang = (name: string) =>
  (db.prepare('select lang from guests where name = ?').get(name) as { lang: string | null } | undefined)?.lang ?? null;

// GET /api/voice/drawn?id=&call=: a mark on the live call's notes page, for its agent as it rests: who drew it (the
// board, or its guest by name), its words, and its picture (the mark's unit, as the page has it). 404: not a mark of
// the board's or its guest's on that call's page.
export async function markForVoice(id: number, call: number) {
  const c = liveCall(call),
    p = c && pageFor(call),
    g = row(id);
  if (!c || !p || !g || g.page !== p.id || g.deleted !== null || g.parent !== null || g.by === c.agent) return 404;
  const guest = g.by === BOARD ? null : people.guestOf(g.by);
  if (g.by !== BOARD && !guest) return 404;
  const parts = partsOf(g),
    box = boxOf(parts),
    typed = (parts.texts as { text: string }[]).map(t => t.text).join(' ');
  const drawn = {
    w: box ? Math.max(UNIT_W, box.x + box.w) : UNIT_W,
    h: heightFor(parts, g.h!),
    ink: parts.ink,
    scraps: parts.pictures,
    texts: parts.texts,
  };
  const png = await render(drawn as Parameters<typeof render>[0], DIR);
  return {
    n: g.id,
    who: guest ? guest.name : 'Board',
    words: g.words || typed,
    updated: g.updated,
    picture: { type: 'image/png', data: png.toString('base64') },
  };
}
