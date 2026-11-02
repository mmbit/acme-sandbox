// CSS media queries keep their recorded matches in a watch-along, in each document and shadow tree.
const CUSTOM = 5,
  FULL_SNAPSHOT = 2;
const READ_MS = 1000;

export function hearMedia(record) {
  let sent = '';
  const watched = new Map();
  const read = () => {
    const queries = new Set();
    for (const sheet of sheets(document))
      for (const media of mediaLists(sheet)) if (media.mediaText) queries.add(media.mediaText);
    for (const [query, match] of watched) {
      if (queries.has(query)) continue;
      match.removeEventListener('change', read);
      watched.delete(query);
    }
    for (const query of queries) {
      if (watched.has(query)) continue;
      const match = matchMedia(query);
      match.addEventListener('change', read);
      watched.set(query, match);
    }
    const matches = Object.fromEntries([...queries].sort().map(query => [query, watched.get(query).matches]));
    const id = record.mirror.getId(document);
    const now = JSON.stringify([id, matches]);
    if (id === -1 || now === sent) return;
    sent = now;
    record.addCustomEvent('media', { id: [id], matches });
  };
  const changes = new MutationObserver(read);
  changes.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['media'],
  });
  document.addEventListener('load', read, true);
  // CSSOM edits and shadow trees do not notify the document's observer.
  const tick = setInterval(read, READ_MS);
  read();
  return () => {
    clearInterval(tick);
    changes.disconnect();
    document.removeEventListener('load', read, true);
    for (const match of watched.values()) match.removeEventListener('change', read);
  };
}

function* sheets(root) {
  yield* root.adoptedStyleSheets ?? [];
  if (root.nodeType === 9) yield* root.styleSheets;
  else
    for (const element of root.querySelectorAll('style, link[rel="stylesheet"]'))
      if (element.sheet) yield element.sheet;
  for (const element of root.querySelectorAll('*')) if (element.shadowRoot) yield* sheets(element.shadowRoot);
}

function* mediaLists(sheet) {
  if (sheet.media) yield sheet.media;
  let rules;
  try {
    rules = sheet.cssRules;
  } catch (error) {
    // A foreign sheet without CORS exposes neither its rules nor their queries to the recorder.
    if (error.name === 'SecurityError') return;
    throw error;
  }
  yield* ruleMedia(rules);
}
function* ruleMedia(rules) {
  for (const rule of rules) {
    if (rule.media) yield rule.media;
    if (rule.styleSheet) yield* mediaLists(rule.styleSheet);
    else if (rule.cssRules) yield* ruleMedia(rule.cssRules);
  }
}

export const changesMedia = event => event.type === FULL_SNAPSHOT || !!mediaEvent(event);
const mediaEvent = event => (event.type === CUSTOM && event.data?.tag === 'media' ? event.data.payload : null);

export class Media {
  byDocument = new Map();
  add(event) {
    if (event.type === FULL_SNAPSHOT) this.byDocument.clear();
    const media = mediaEvent(event);
    if (media) this.byDocument.set(media.id[0], media.matches);
  }
}
export function mediaAt(events, time) {
  const media = new Media();
  for (const event of events) {
    if (event.timestamp > time) break;
    media.add(event);
  }
  return media;
}

const originals = new WeakMap();
export function applyMedia(replayer, recorded) {
  for (const [id, matches] of recorded.byDocument) {
    const doc = replayer.getMirror().getNode(id);
    if (!doc?.documentElement) continue;
    for (const sheet of sheets(doc))
      for (const media of mediaLists(sheet)) {
        const previous = originals.get(media);
        const query = previous && media.mediaText === previous.written ? previous.query : media.mediaText;
        if (!Object.hasOwn(matches, query)) continue;
        const wanted = matches[query] ? 'all' : 'not all';
        if (media.mediaText !== wanted) media.mediaText = wanted;
        originals.set(media, { query, written: wanted });
      }
  }
}
