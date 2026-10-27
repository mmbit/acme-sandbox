// The book rail's faces from the sheets, with no DOM, so node tests it.

// One face per agent, in the order their sheets were opened: its open sheets' notes counted, a dot for an answer not
// yet ticked (sent sheets included), and the send in its seconds to undo (a sheet's or a page sent on its own: sending,
// the sheet, or null). A sheet nobody owns is the CEO's (ceo), so the CEO has one face; owner stays the first sheet's
// own (null for nobody's), as the face tells its listeners. A page sent on its own is no note waiting: it counts none.
// (sending, the one-off page's count)
export function facesOf({ open = [], sent = [] }, ceo) {
  const byId = new Map(),
    faceOf = owner => {
      const id = owner ?? ceo;
      return byId.get(id) ?? byId.set(id, { id, owner, count: 0, dot: false, sending: null }).get(id);
    };
  for (const s of open) {
    const face = faceOf(s.owner);
    if (!s.page) face.count += s.notes.filter(n => n.status === 'open').length;
    if (s.status === 'sending') face.sending = s;
  }
  for (const s of [...open, ...sent])
    if (s.notes.some(n => n.slips?.some(slip => !slip.ticked))) faceOf(s.owner).dot = true;
  return [...byId.values()];
}
