// Events from the company: the world applies each one, the shell shows what it signals (bubbles, toasts, the
// newsletter, the status line, the open panel). The scene hears the same signals after the shell.
import { esc } from '../util.js';
import * as world from '../world/world.js';
import { bubble } from './overlay.js';
import { toast, updateStatus } from './hud.js';
import { refreshAgent } from './panel.js';
import { gazette, reloadGazette, openGazette, paintNews } from './news.js';
import { refreshRequests, refreshIntercomCount } from './desk.js';
import { refreshOrg } from './main.js';
import { names } from './brand.js';

export function onEvent(ev) {
  // (the book changed on the store, an answer clipped onto a note: the book reads its sheets again, bookrail.js; one
  // typed onto a page names it, which the book reads again if it's open, bookpages.js)
  // (a notebook's page changed, by this screen or another of the board's: every screen showing it reads it again,
  // bookpages.js.)
  if (ev.type === 'book' && ev.text === 'notebook')
    return void document.dispatchEvent(new CustomEvent('book:notebook', { detail: { page: ev.page ?? null } }));
  if (ev.type === 'book')
    return void document.dispatchEvent(new CustomEvent('book:changed', { detail: { page: ev.page ?? null } }));
  if (world.apply(ev).unknown) refreshOrg(); // someone new
}

// (registered as the shell loads, before the scene: its listeners come second)
world.on('status', ({ agent }) => {
  refreshAgent(agent);
  updateStatus();
});
world.on('say', ({ agent, to, text }) => {
  const B = world.agents.get(to);
  refreshAgent(agent); // their log grew
  bubble(agent, text || '…', to ? `to ${B?.data.name || to}` : '');
  refreshAgent(to);
  if (agent === world.company.ceo && to === 'board') refreshIntercomCount(); // a reply on the intercom
});
world.on('post', ({ agent, title, board }) => {
  const A = world.agents.get(agent);
  refreshAgent(agent);
  toast(
    `<b>${board ? 'For the board' : `New in ${esc(names.newsletter)}`}</b><br>${esc(title || 'A fresh post')}${A ? ` · by ${esc(A.data.name)}` : ''}`,
    () => openGazette(board),
  );
  if (world.dev) {
    if (!gazette.some(p => p.title === title))
      gazette.unshift({
        slug: 'dev-' + gazette.length,
        title,
        author: agent,
        date: new Date().toISOString().slice(0, 10),
        tags: ['demo'],
        cover: '',
        html: `<p>${esc(title)}. (A demo post from the dev event stream.)</p>`,
      });
    paintNews();
  } else reloadGazette(false).then(paintNews);
});
world.on('log', ({ agent, text }) => {
  refreshAgent(agent);
  if (/^Asked the board/.test(text || '')) refreshRequests();
});

// a directive through the intercom: the CEO acknowledges (the real stream reports the new job itself)
export function onDirective(title) {
  if (world.dev)
    setTimeout(() => onEvent({ type: 'chat', agent: world.company.ceo, to: 'board', text: `On it: ${title}` }), 1200);
}
