// HQ's search's own categories (finder.js): each list as its screen shows it, so each keeps that screen's rules. Their
// items are shaped as an app's finds are (template/kits/README.md).
import { cap } from '../util.js';
import * as world from '../world/world.js';
import { names } from './brand.js';
import { loadProjects, loadRequests, loadArchive, loadArtifacts, loadCalls, loadMail } from './data.js';
import {
  computerApps,
  openComputer,
  openPhone,
  openAnswered,
  openLink,
  openJob,
  who,
  ago,
  settingsSections,
} from './desk.js'; // (openJob)
import { openProjects } from './projects.js';
import { stepName } from './threads.js';
import { nameText } from './jobs.js'; // (the board's names)
import { libraryEntries } from './news.js';
import { openAgent } from './panel.js';

// The categories in the chips' order: id, chip name, prefix, its list. A company app's (its finds: template/kits/README.md)
// go after HQ's apps.
export const BUILT_IN = [
  { id: 'apps', name: 'Apps', prefix: 'a', list: apps },
  { id: 'artifacts', name: 'Artifacts', prefix: 'ar', list: artifacts },
  { id: 'work', name: 'Work', prefix: 'w', list: work },
  { id: 'cards', name: cap(names.phone), prefix: 'd', list: cards },
  { id: 'calls', name: 'Calls', prefix: 'c', list: calls },
  { id: 'mail', name: 'Mail', prefix: 'm', list: mail },
  { id: 'library', name: cap(names.libraryShort), prefix: 'l', list: library },
  { id: 'people', name: 'People', prefix: 'p', list: people },
  { id: 'settings', name: 'Settings', prefix: 's', list: settings },
];

// (and the projects view, the HUD's key beside the computer's apps.)
async function apps() {
  return [
    {
      key: 'projects',
      title: 'Projects',
      sub: 'Businesses, projects and who’s doing what',
      open: () => openProjects(),
    },
    ...computerApps().map(a => ({
      key: a.id,
      title: a.name,
      sub: a.what,
      open: () => openComputer(a.id),
    })),
  ];
}
async function work() {
  const board = await loadProjects(world.dev);
  const business = id => board.businesses.find(b => b.id === id)?.name;
  const task = (j, where) => ({
    key: String(j.id),
    task: true,
    title: nameText(j),
    codes: [j.code, `#${j.id}`].filter(Boolean),
    sub: [stepName(j), where].filter(Boolean).join(' · '),
    at: j.finished, // (work not done yet is never old)
    open: () => openJob(j.id), // (as any work link opens)
  });
  return [
    ...board.businesses.map(b => ({
      key: b.id,
      title: b.name,
      sub: 'Business',
      open: () => openProjects({ business: b.id }),
    })),
    ...board.projects.flatMap(p => [
      {
        key: p.id,
        title: nameText(p, 'name'),
        sub: ['Project', business(p.business)].filter(Boolean).join(' · '),
        open: () => openProjects({ project: p.id }),
      },
      ...p.threads.map(t => ({
        key: t.id,
        title: nameText(t, 'name'),
        sub: `Thread · ${nameText(p, 'name')}`,
        open: () => openProjects({ project: p.id, thread: t.id }),
      })),
      ...(p.done ?? []).map(t => ({
        key: t.id,
        title: nameText(t, 'name'),
        sub: `Done thread · ${nameText(p, 'name')}`,
        at: t.done,
        open: () => openProjects({ project: p.id, thread: t.id, done: true }),
      })),
      ...p.threads.flatMap(t => t.jobs.map(j => task(j, `${nameText(t, 'name')} · ${nameText(p, 'name')}`))),
    ]),
    ...(board.unsorted ?? []).map(j => task(j, 'Being placed')),
    ...(board.meetings ?? []).map(j => task(j, 'Meetings')),
  ];
}
async function cards() {
  const [open, answered] = await Promise.all([loadRequests(world.dev), loadArchive(world.dev)]);
  if (!open) throw new Error(`the ${names.phone}'s cards didn't load`); // (loadRequests' null)
  const card = (r, sub, opens, at) => ({
    key: String(r.id),
    title: r.title,
    codes: [`#${r.id}`],
    sub: `${sub} · ${who(r.agent)}`,
    at,
    open: () => opens(r.id),
  });
  return [
    ...open.map(r => card(r, 'Waiting', openPhone)),
    ...answered.cards.map(r => card(r, 'Answered', openAnswered, r.answered ?? r.created)),
  ];
}
async function artifacts() {
  return (await loadArtifacts(world.dev)).map(a => ({
    key: String(a.id),
    title: a.name,
    sub: [a.about, ...a.place.map(p => p.name)].filter(Boolean).join(' · '),
    at: a.shown,
    open: () => openLink(a.open),
  }));
}
async function calls() {
  return (await loadCalls(world.dev)).map(c => ({
    key: String(c.id),
    title: `Call with ${who(c.agent)}`,
    codes: [`#${c.id}`],
    sub: [ago(c.ts), ...(c.items ?? []).map(i => i.what)].join(' · '),
    at: c.ts,
    open: () => openComputer('calls', { call: c.id }),
  }));
}
async function mail() {
  return (await loadMail(world.dev)).map(m => ({
    key: String(m.id),
    title: m.subject || '(no subject)',
    sub: m.sender,
    at: m.received,
    open: () => openComputer('mail', { mail: m.id }),
  }));
}
async function library() {
  return (await libraryEntries()).map(d => ({ key: d.key, title: d.title, sub: d.shelf, open: d.open }));
}
async function people() {
  return [...world.agents.values()].map(A => ({
    key: A.id,
    title: A.data.name,
    sub: A.data.role,
    open: () => openAgent(A),
  }));
}
// Settings as its list shows it (desk.js settingsSections): each section, its choices its codes, and each page in it.
// A section whose choices or pages don't load is still found by its name, as its row in Settings still shows.
async function settings() {
  const found = await Promise.all(
    settingsSections().map(async s => {
      const [choices, pages] = await Promise.allSettled([s.choices?.() ?? [], s.pages?.() ?? []]);
      const failure = [choices, pages].find(loaded => loaded.status === 'rejected');
      if (failure) console.error(`[hq] search: ${s.id} didn't load`, failure.reason);
      return [
        {
          key: s.id,
          title: s.name,
          codes: choices.value ?? [],
          sub: 'Settings',
          open: () => (s.run ? s.run() : openComputer('settings', { section: s.id })),
        },
        ...(pages.value ?? []).map(p => ({
          key: `${s.id}:${p.page}`,
          title: p.name,
          sub: `Settings › ${s.name}`,
          open: () => openComputer('settings', { section: s.id, page: p.page }),
        })),
        ...(failure ? [{ missed: `Settings › ${s.name}` }] : []),
      ];
    }),
  );
  return found.flat();
}
