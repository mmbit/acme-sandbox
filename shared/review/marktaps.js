// A finger's tap on a note's hairline on HQ's page (marks.js draws them): its card, with what was said, where the note is
// and its answers (hairline.js).
import { REACH, cardOpen, hairAt, hideCard, sentLabel, showCard } from './hairline.js';
import { answeredNow, slipActs } from './markslips.js';
import { get, ownerOf } from './markpage.js';
import { hairsNow } from './marks.js';

// When a sent note went: its sheet's sending time (the book's latest sent sheets, asked once a tap needs one), else the
// last time the note changed
async function sentAt(r, note) {
  r.sentTimes ??= get('/sheets').then(
    ({ sent }) => new Map(sent.map(s => [s.id, s.sent])),
    () => new Map(),
  );
  return (await r.sentTimes).get(note.sheet) ?? note.updated ?? note.created;
}
// Where a note still to send waits, as its card says: "For Lark, not sent", or on a call's page "On your call with Juno"
// (a note on nobody's sheet: the CEO's)
async function whereOpen(r, note) {
  const owner = note.owner ?? (await ownerOf(r, null)),
    name = (await r.org).agents.get(owner) ?? owner;
  return note.onCall ? `On your call with ${name}` : `For ${name}, not sent`;
}
// A finger's tap on a hairline opens its card there; a tap anywhere else closes it and stays the page's. A tap that lands
// on one is the card's alone: the page hears its touch cancelled, as when the browser takes a touch to scroll, and
// no click.
const TAP = { px: 10, ms: 500 };
export function hairTaps(r) {
  let down = null;
  const swallowClick = c => c.isTrusted && c.stopPropagation();
  addEventListener(
    'pointerdown',
    e => {
      const path = e.composedPath();
      if (cardOpen(r) && !path.includes(r.host)) hideCard(r);
      down =
        e.pointerType === 'touch' && e.isPrimary && !path.includes(r.host) && path.includes(document.body)
          ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp }
          : null;
    },
    true,
  );
  addEventListener(
    'pointerup',
    e => {
      if (!down || e.pointerId !== down.id) return;
      const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < TAP.px && e.timeStamp - down.t < TAP.ms;
      down = null;
      if (!tap || r.covered || !r.veil.hidden) return;
      const hit = hairAt([...hairsNow(r), ...answeredNow(r)], [e.clientX, e.clientY], REACH);
      if (!hit) return;
      e.stopPropagation();
      e.target.dispatchEvent(
        new PointerEvent('pointercancel', {
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          isPrimary: true,
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
          composed: true,
        }),
      );
      addEventListener('click', swallowClick, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallowClick, true), 400);
      const open = !(r.sent ?? []).includes(hit.note), // (a mark: a note still on its sheet)
        line = open ? whereOpen(r, hit.note) : sentAt(r, hit.note).then(sentLabel);
      showCard(r, hit.note, [e.clientX, e.clientY], line, slipActs);
    },
    true,
  );
  addEventListener('scroll', () => hideCard(r), { capture: true, passive: true });
}
