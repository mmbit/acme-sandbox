// The book rail's faces from the sheets, with no DOM, so node tests it.

// One face per agent, in the order their sheets were opened: its open sheets' notes counted, and a dot for an answer not
// yet ticked (sent sheets included). A sheet nobody owns is the CEO's (ceo), so the CEO has one face; owner stays the
// first sheet's own (null for nobody's), as the face tells its listeners.
export function facesOf({ open = [], sent = [] }, ceo) {
  const byId = new Map(),
    faceOf = owner => {
      const id = owner ?? ceo;
      return byId.get(id) ?? byId.set(id, { id, owner, count: 0, dot: false }).get(id);
    };
  for (const s of open) faceOf(s.owner).count += s.notes.filter(n => n.status === 'open').length;
  for (const s of [...open, ...sent])
    if (s.notes.some(n => n.slips?.some(slip => !slip.ticked))) faceOf(s.owner).dot = true;
  return [...byId.values()];
}
