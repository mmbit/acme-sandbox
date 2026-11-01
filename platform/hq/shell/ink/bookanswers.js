// The agents' answers on a notebook page beyond its slips. An answer is a slip under its note's unit, and one still
// coming the agent's face and pencil dots there, or why none came (waitingHtml: bookgroups.js draws both). A note tried
// in versions has them in one block (bookversions.js) on a layer over the page (bookpage.js mounts it in .bk-answers),
// in the page's px, that the page hangs under the note's unit, below its slips (bookunder.js). The versions are read
// again whenever the store's book or notebook changes, and as a look is worn (stage.js stage:look): a page read before
// the scene placed the agents drew initials.
import { esc, stylesheet } from '../../util.js';
import * as world from '../../world/world.js';
import { inkOf } from './agentink.js';
import { DOTS } from './bookanswerart.js';
import { faceHtml, faced } from './bookfaces.js';
import { word } from './bookscope.js';
import { wireReply } from './bookanswerreply.js';
import { loadGroups, sendReply } from './bookanswersdata.js';
import { versionsEl } from './bookversions.js';

for (const name of ['bookanswers', 'bookanswerform', 'bookversions']) stylesheet(`shell/ink/${name}.css`);

// slot: the page's .bk-answers; page: its record (bookpages.js), whose id it reads by (none yet: nothing to read);
// relay(): the page laid again (a versions block came, went or changed its height).
export function mountAnswers(slot, page, relay) {
  const layer = { slot, page, drawn: new Map(), reading: 0 },
    events = ['book:changed', 'book:notebook', 'stage:look'];
  const again = () => {
    if (!slot.isConnected && layer.reading) return events.forEach(type => document.removeEventListener(type, again));
    read(layer);
  };
  for (const type of events) document.addEventListener(type, again);
  // (once for everything that changed in a step, after it)
  layer.relay = () => {
    if (layer.relaying) return;
    layer.relaying = true;
    queueMicrotask(() => {
      layer.relaying = false;
      relay();
    });
  };
  read(layer);
}

async function read(layer) {
  const { page } = layer,
    n = ++layer.reading;
  if (!page.id) return;
  let groups;
  try {
    groups = await loadGroups(world.dev, page.id);
  } catch (e) {
    return console.error('[hq] A page’s answers can’t be read:', e);
  }
  if (n !== layer.reading || !groups) return;
  draw(layer, groups.groups);
}

// Every group's versions, kept as drawn while they're the same, drawn again when they changed. Versions the board's pen
// is on are kept till it's done (layer.held), then read again. The page keeps room in its masonry for them
// (bookunder.js), so it's laid again whenever a block comes, goes or changes its height.
function draw(layer, groups) {
  const wanted = new Map();
  for (const g of groups) {
    const tried = g.try ?? g.children.find(c => c.kind === 'answer' && c.style === 'version');
    if (tried)
      wanted.set(g.id, {
        key: JSON.stringify([g.try, g.words, g.children, faced(tried.by)]),
        make: was => versionsEl(g, versionParts(layer), was),
      });
  }
  const replaced = new Map();
  for (const [id, old] of layer.drawn) {
    if (wanted.get(id)?.key === old.key) continue;
    if (old.el.querySelector('[data-inking]')) {
      layer.held = true;
      continue;
    }
    old.el.remove();
    layer.drawn.delete(id);
    replaced.set(id, old.el);
  }
  for (const [id, { key, make }] of wanted) {
    if (layer.drawn.has(id)) continue;
    const el = make(replaced.get(id));
    // (its size changed: a version come, its picture loaded)
    new ResizeObserver(() => el.isConnected && layer.relay()).observe(el);
    layer.slot.append(el);
    layer.drawn.set(id, { key, el });
  }
  if ([...replaced.keys()].some(id => !wanted.has(id))) layer.relay();
}

// What the versions draw with from here: the page's layer their px are in, a face, and the board's pen on their frames:
// what it writes goes to the version to(ink) names, and the page is read again once it's gone
const versionParts = layer => ({
  root: layer.slot,
  faceHtml,
  wirePen: (el, { origin, to }) =>
    wireReply(el, {
      origin,
      // (the Pencil and a mouse anywhere on the frames; a finger on a version's picture, so it moves the page everywhere
      // else)
      takes: e => e.pointerType !== 'touch' || !!e.target.closest?.('.bk-version[data-answer] .bk-version-paper'),
      send: ink => {
        const on = to(ink);
        if (!on) return Promise.reject(new Error('No version here yet'));
        return sendReply(world.dev, on.answer, ink, on.frame).then(() => read(layer));
      },
      refused: words => el.setAttribute('data-refused', words),
      done: () => {
        if (!layer.held) return;
        layer.held = false;
        read(layer);
      },
    }),
});

// ---- an answer still coming

// The answer still coming on group g (the store's waiting: bookslips.ts waitingOf): its agent's face and pencil dots
// where its slip will come, or why none came.
export function waitingHtml(g) {
  const { by, name, reason } = g.waiting,
    label = reason ? `${name}: ${reason}` : word('nameWriting', { name });
  return `<div class="bk-answer-waiting" data-group="${g.id}" role="status" aria-label="${esc(label)}" style="--ink:${inkOf(
    by,
  )}">${faceHtml(g.waiting)}${reason ? `<span>${esc(reason)}</span>` : DOTS}</div>`;
}
