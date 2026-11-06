// What a call's agent hears of a mark on the call's notes page (the voice line's drawn route, as HQ's calldraw.js
// relays it), the board's or a guest's.
import { BOARD } from './book.ts';
import { liveCall, pageFor } from './callnotes.ts';
import { partsOf, row } from '../notebookgroups.ts';
import { heightFor, UNIT_W } from '../../../hq/shell/ink/scrapunit.js';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';
import { render } from './bookrender.ts';
import { DIR } from '../pagescraps.ts';
import * as people from './sketchpeople.ts';
import { pointerOf } from './callpointers.ts';
import { replySnip, versionSlip } from './bookpick.ts';

// GET /api/voice/drawn?id=&call=: a mark on the live call's notes page, for its agent as it rests: who drew it (the
// board, or its guest by name), its words, and its picture (the mark's unit, as the page has it). A pointer on the
// agent's own (ink/callpointers.ts: ink on its scrap, a reply on its version) says so (pointer: the unit it's on, and
// the version), its picture that scrap or version with the ink over it. 404: not a mark of the board's or its guest's on
// that call's page.
export async function markForVoice(id: number, call: number) {
  const c = liveCall(call),
    p = c && pageFor(call),
    g = row(id),
    pointer = g && pointerOf(g.id);
  if (!c || !p || !g || g.page !== p.id || g.deleted !== null) return 404;
  if (!pointer && (g.parent !== null || g.by === c.agent)) return 404;
  const by = pointer?.by ?? g.by,
    guest = by === BOARD ? null : people.guestOf(by);
  if (by !== BOARD && !guest) return 404;
  const parts = partsOf(g),
    box = boxOf(parts),
    typed = (parts.texts as { text: string }[]).map(t => t.text).join(' ');
  const version = versionSlip(g.answers);
  const snip = version && (await replySnip(version.id, g.frame && JSON.parse(g.frame), parts.ink as never));
  const drawn = {
    w: box ? Math.max(UNIT_W, box.x + box.w) : UNIT_W,
    h: heightFor(parts, g.h ?? 0),
    ink: parts.ink,
    scraps: parts.pictures,
    texts: parts.texts,
  };
  const png = snip ? snip.clean : await render(drawn as Parameters<typeof render>[0], DIR);
  return {
    n: g.id,
    who: guest ? guest.name : 'Board',
    // (on the agent's own scrap, its words are the agent's: the board's mark has none)
    words: pointer && !pointer.whole ? '' : g.words || typed,
    updated: g.updated,
    ...(pointer && { pointer: { on: g.parent ?? g.id, version: version?.version ?? null } }),
    picture: { type: 'image/png', data: png.toString('base64') },
  };
}
