// What rrweb's replayer rebuilds unlike the recorded page, put right in the events it's given, so the mirror's pictures
// (mirrorpage.ts) and the player (player.js) show the page as it was. Plain JS, for a browser and Node alike. README.md
// has the design.
//   - What comes after <body>: rrweb's rebuild of a full snapshot moves <body> to the end of <html>, so whatever the page
//     put after it (HQ's book and review mode's controls) would come before it, and a rule by that order (`body ~
//     #book`, how a look styles the book) wouldn't match. Those nodes come out of the snapshot and go in after <body>
//     right after it, as one mutation of rrweb's own, node by node, so the page's order and its look's rules hold.
//   - A moved shadow host's stylesheets: rrweb's recorder sends a shadow root's adopted stylesheets once. A host moved
//     on the page (taken out and put back in one mutation, its id kept) is built anew by the replayer, its shadow root
//     with nothing adopted (review mode's controls move into each dialog that opens). Its stylesheets are adopted again
//     right after the mutation that moved it, so it draws styled as on the page.

// rrweb's event types and sources this file reads and writes
const FULL_SNAPSHOT = 2,
  INCREMENTAL = 3,
  MUTATION = 0,
  ADOPTED = 15,
  ELEMENT = 2;

export class Rebuilt {
  adopted = new Map(); // a shadow host's id → the stylesheets it adopted last (rrweb's style ids)
  // The events as the replayer should have them: each as it was, and what puts the rebuild right after it
  take(events) {
    const out = [];
    for (const event of events) {
      if (event.type === FULL_SNAPSHOT) {
        this.adopted.clear();
        out.push(...bodyLast(event));
        continue;
      }
      out.push(event);
      if (event.type !== INCREMENTAL) continue;
      if (event.data.source === ADOPTED) this.adopted.set(event.data.id, event.data.styleIds);
      if (event.data.source === MUTATION) out.push(...this.readopted(event));
    }
    return out;
  }
  // A mutation's moved hosts' stylesheets adopted again (a host added for the first time has none known yet)
  readopted(event) {
    const ids = event.data.adds.flatMap(add => idsIn(add.node)).filter(id => this.adopted.has(id));
    return ids.map(id => ({
      type: INCREMENTAL,
      timestamp: event.timestamp,
      data: { source: ADOPTED, id, styleIds: this.adopted.get(id) },
    }));
  }
}

// A full snapshot without what follows <body> in <html>, and the mutation that puts it there after the rebuild
function bodyLast(event) {
  const doc = event.data.node,
    html = doc.childNodes?.find(n => n.type === ELEMENT && n.tagName === 'html');
  const body = html ? html.childNodes.findIndex(n => n.type === ELEMENT && n.tagName === 'body') : -1;
  if (body < 0 || body === html.childNodes.length - 1) return [event];
  const after = html.childNodes.slice(body + 1);
  const trimmed = { ...html, childNodes: html.childNodes.slice(0, body + 1) };
  const node = { ...doc, childNodes: doc.childNodes.map(n => (n === html ? trimmed : n)) };
  const adds = after.flatMap(child => [...added(child, html.id)]);
  return [
    { ...event, data: { ...event.data, node } },
    {
      type: INCREMENTAL,
      timestamp: event.timestamp,
      data: { source: MUTATION, texts: [], attributes: [], removes: [], adds },
    },
  ];
}

// A node and everything in it as a mutation's adds, each on its own and in order, as the replayer builds an added node
// without what's in it. A frame keeps its document, which the replayer puts in it once it's in.
function* added(node, parentId) {
  yield { parentId, nextId: null, node };
  if (node.type === ELEMENT && node.tagName === 'iframe') return;
  for (const child of node.childNodes ?? []) yield* added(child, node.id);
}

// The ids of a serialized node and everything in it
const idsIn = node => [node.id, ...(node.childNodes ?? []).flatMap(idsIn)];
