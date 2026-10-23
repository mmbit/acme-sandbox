// The slide-in panel: agents, rooms and the mascots (news.js opens the newsletter and the library in it).
import { esc, titleCase, cap, canvas, mins, roleHtml } from '../util.js';
import * as world from '../world/world.js';
import { clockWhen, timeOf } from '../world/clock.js';
import { sfx } from './audio.js';
import { scene, pointed } from './stage.js';
import { openPhone, openIntercom, openComputer, callAgent, ceoName } from './desk.js';
import { visitMascot } from './hud.js';
import { names } from './brand.js';
import { loadAgentModels, setAgentModel } from './data.js';
import { prose } from './prose.js';
import { icon } from './icons.js';
import { engineMark } from './engine.js';

const $ = s => document.querySelector(s);
let current = null;
const panel = $('#panel');
export const body = $('#panel-body');

export function initPanel() {
  $('#panel-close').onclick = closePanel;
  world.on('meetings', () => {
    if (current?.kind === 'agent') return refreshAgent(current.ref); // (what they said in a meeting.)
    if (current?.kind !== 'room' || !world.rooms.some(r => r.id === current.ref && r.kind === 'meeting')) return;
    const scrollTop = body.scrollTop;
    openRoom(current.ref, true);
    body.scrollTop = scrollTop;
  });
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });
}

export function show(kind, html, ref, quiet) {
  const wasOpen = !panel.hidden;
  current = { kind, ref };
  hushSounds();
  body.innerHTML = html;
  panel.hidden = false;
  panel.dataset.kind = kind;
  requestAnimationFrame(() => panel.classList.add('open'));
  if (quiet) return;
  if (!wasOpen) sfx.open();
  else sfx.blip();
  body.scrollTop = 0;
}
export function closePanel() {
  if (panel.hidden) return;
  panel.classList.remove('open');
  current = null;
  sfx.close();
  hushSounds();
  setTimeout(() => {
    if (!current) panel.hidden = true;
  }, 200);
  pointed.selected = null;
}
export const panelOpen = () => current;
const hushSounds = () =>
  body.querySelectorAll('audio').forEach(v => {
    v.pause();
    v.removeAttribute('src');
    v.load();
  });

// ---- agents ----
// the scene draws the picture ({ kind: 'agent' | 'mascot', id }) and picks the colour to frame it in, the panel sizes
// it. One the scene has no picture of (a mascot of a kind it doesn't draw) is name's initial.
function portrait(target, name, cls = 'portrait') {
  const p = scene.portrait(target);
  if (p) {
    p.img.className = target.kind === 'mascot' ? cls + ' cat' : cls;
    return p;
  }
  const img = canvas(14, 28),
    g = img.getContext('2d'),
    css = getComputedStyle(body);
  g.font = `12px ${css.fontFamily}`;
  g.textAlign = 'center';
  g.fillStyle = css.color;
  g.fillText(name[0], 7, 22);
  img.className = cls;
  return { img, accent: 'var(--gold)' };
}
const STATE = { working: 'Working', waiting: 'Queuing for a seat', sleeping: 'Sleeping', idle: 'Idle' };
const stateChip = s => `<span class="chip st-${esc(s)}">${esc(STATE[s] || s)}</span>`;
// the job in hand as the Wire look's panes show it: how long it's been on, and the lines it has added and removed
const onJob = A =>
  A.state === 'working' && A.since
    ? `<small class="on-job">${mins(A.since)} on it · +${A.lines?.add ?? 0} −${A.lines?.del ?? 0} lines</small>`
    : '';

export function openAgent(A, quiet = false) {
  if (!A) return;
  const d = A.data,
    room = world.rooms.find(r => r.id === A.roomId),
    dept = room.board ? 'Top floor' : room.name,
    pic = portrait({ kind: 'agent', id: A.id }, d.name);
  const logs = A.logs
    .slice(-30)
    .reverse()
    .map(l => `<li><time>${timeOf(l.ts)}</time><div class="lt-${esc(l.type)} prose">${prose(l.text)}</div></li>`)
    .join('');
  const tool = (name, what, state = 'open') =>
    `<li><button data-tool="${name}"><b>${esc(cap(names[name]))}</b> ${what} <em>${state}</em></button></li>`;
  const office = d.board
    ? `<h3>Your office</h3><ul class="office">
      ${tool('phone', 'Requests waiting on you', world.requests ? `${world.requests} open` : 'none open')}
      ${tool('intercom', `Talk with ${esc(ceoName())}, or call`)}
      ${tool('computer', 'AI seats and jobs')}</ul>`
    : '';
  const role = `${esc(d.role || '')}${d.pronouns ? ` · ${esc(d.pronouns)}` : ''} · ${esc(dept)}`,
    focus = d.focus ? `<p class="role role-focus">${esc(d.focus)}</p>` : '';
  const task = A.task ? esc(A.task) : '<span class="muted">Nothing on the desk right now.</span>';
  const call =
    !d.board && !d.temp ? `<button class="call-agent" data-call>${icon('phone')}Call ${esc(d.name)}</button>` : '';
  // (the engine as its mark)
  show(
    'agent',
    `
    <header class="who"><div class="pframe" style="--c:${pic.accent}"></div>
      <div><h2>${esc(d.name)}</h2><p class="role">${role}</p>${focus}
      <p>${engineMark(d.engine, { titled: true })} ${stateChip(A.state)}</p></div></header>
    <section class="task"><h3>Right now</h3><p>${task}</p>${onJob(A)}</section>
    ${saidHtml(A.id)}
    ${d.look ? `<p class="look">“${esc(d.look)}”</p>` : ''}
    ${call}
    ${office}
    <section class="models" data-models="${esc(A.id)}">${modelsHtml(A.id)}</section>
    <h3>Recent activity</h3>
    <ul class="log">${logs || '<li class="muted">Quiet so far. Activity shows up here live.</li>'}</ul>`,
    A.id,
    quiet,
  );
  body.querySelector('.pframe').append(pic.img);
  body.querySelector('[data-call]')?.addEventListener('click', () => callAgent(A.id, d.name));
  body
    .querySelectorAll('[data-tool]')
    .forEach(
      b =>
        (b.onclick = () => ({ phone: openPhone, intercom: openIntercom, computer: openComputer })[b.dataset.tool]?.()),
    );
  wireModels(A.id);
  if (!quiet)
    loadAgentModels(world.dev).then(
      list => {
        models = list;
        drawModels(A.id);
      },
      () => {},
    );
}
// What an agent in a live meeting said last, whole: the room's bubbles give it in a few words
function saidHtml(id) {
  const said = world.meetingOf(id)?.said?.find(s => s.agent === id);
  return said
    ? `<section class="said"><h3>Said in the meeting · ${esc(timeOf(Date.parse(said.at)))}</h3><div class="prose">${prose(said.text)}</div></section>`
    : '';
}
// (a redraw while the board picks a model would close its list)
export function refreshAgent(id) {
  if (current?.kind !== 'agent' || current.ref !== id || body.querySelector('.models select:focus')) return;
  openAgent(world.agents.get(id), true);
}

// ---- an agent's model
// Its main model and its one fallback, from the models a seat of the board's runs: the board's pick is what its next
// work runs on. The fallback runs elsewhere than the main model, so the list leaves out the main model's own seats.
let models = null; // the coordinator's list: { choices, models: { [agent]: { main, picked, fallback, engine } } }
let saying = null; // { agent, kind: 'moving' | 'done' | 'failed', words, at }: how the board's last pick went
const SAID_MS = 8000;
const runner = c => c && `${c.engine}:${c.cli}`; // (the seats a model runs on)
function modelsHtml(id) {
  const own = models?.models?.[id];
  if (!own) return '';
  const main = models.choices.find(c => c.id === own.main);
  const offered = c => c.seated || c.id === own.main || c.id === own.fallback;
  const keeps = c => !own.engine || c.engine === own.engine; // (a reviewer's main model stays on its panel engine)
  const option = (c, on) =>
    `<option value="${esc(c.id)}"${c.id === on ? ' selected' : ''}>` +
    `${esc(c.name)}${c.seated ? '' : ' · no seat'}</option>`;
  const mains = [
    ...models.choices.filter(c => offered(c) && keeps(c)),
    ...(main || !own.main ? [] : [{ id: own.main, name: own.main, seated: true }]),
  ];
  const fallbacks = models.choices.filter(c => offered(c) && (!main || runner(c) !== runner(main)));
  const said = saying?.agent === id && (saying.kind === 'moving' || Date.now() - saying.at < SAID_MS) ? saying : null;
  // (one pick at a time: a failed save puts back the one before)
  const off = said?.kind === 'moving' ? ' disabled' : '';
  const options = (list, on) => list.map(c => option(c, on)).join('');
  return (
    `<h3>Model</h3><div class="model-picks">
    <label>Main<select data-model="main"${off}>${options(mains, own.main)}</select></label>
    <label>Fallback<select data-model="fallback"${off}><option value="">None</option>` +
    `${options(fallbacks, own.fallback)}</select></label></div>
    <p class="muted">Used when Main’s seats run out.</p>
    ${said ? `<p class="model-said ${said.kind}" role="status">${esc(said.words)}</p>` : ''}`
  );
}
function drawModels(id) {
  const el = body.querySelector(`[data-models="${CSS.escape(id)}"]`);
  if (!el || el.contains(document.activeElement)) return;
  el.innerHTML = modelsHtml(id);
  wireModels(id);
}
function wireModels(id) {
  body.querySelectorAll('[data-model]').forEach(
    field =>
      (field.onchange = async () => {
        const own = models.models[id],
          was = { ...own },
          pick = { ...own, [field.dataset.model]: field.value || null };
        const main = models.choices.find(c => c.id === pick.main);
        // (the new main model's own seats)
        if (runner(models.choices.find(c => c.id === pick.fallback)) === runner(main)) pick.fallback = null;
        const fallback = models.choices.find(c => c.id === pick.fallback),
          mainName = main?.name ?? pick.main,
          also = fallback ? `, and on ${fallback.name} while ${mainName}’s seats are out or short` : '';
        sfx.blip();
        Object.assign(own, pick);
        saying = { agent: id, kind: 'moving', words: 'Saving…', at: Date.now() };
        field.blur();
        drawModels(id);
        try {
          // (a main model the board didn't pick stays the files', so models.yaml still moves it)
          await setAgentModel(
            world.dev,
            id,
            field.dataset.model === 'main' || own.picked ? pick.main : null,
            pick.fallback,
          );
          if (field.dataset.model === 'main') own.picked = true;
          saying = {
            agent: id,
            kind: 'done',
            words: `✓ Its next work runs on ${mainName}${also}.`,
            at: Date.now(),
          };
        } catch (err) {
          Object.assign(own, was);
          saying = {
            agent: id,
            kind: 'failed',
            words: `Didn’t go through. ${err?.refusal?.error ?? 'Try again in a minute.'}`,
            at: Date.now(),
          };
        }
        drawModels(id);
      }),
  );
}

// id: one of the world's rooms
export function openRoom(id, quiet = false) {
  const room = world.rooms.find(r => r.id === id),
    people = room.agentIds.map(a => world.agents.get(a)),
    pets = world.mascots.filter(m => m.home === id);
  const row = (attribute, name, title, chip = '') =>
    `<li><button ${attribute}><span class="pslot"></span>` +
    `<span><b>${esc(name)}</b><small>${title}</small></span>${chip}</button></li>`;
  const rows = [
    ...people.map(A => row(`data-agent="${esc(A.id)}"`, A.data.name, roleHtml(A.data), stateChip(A.state))),
    ...pets.map(m => row(`data-pet="${esc(m.id)}"`, m.name, roleHtml(m))),
  ];
  show(
    'room',
    `<h2>${esc(room.name)}</h2>` +
      `<p class="role">${esc(titleCase(room.kind))} · ${room.board ? 'the penthouse' : `size ${esc(room.size)}`}</p>` +
      (room.kind === 'meeting'
        ? meetingLines(room.id)
        : `<ul class="people">${rows.join('') || '<li class="muted">Nobody works here right now.</li>'}</ul>`),
    room.id,
    quiet,
  );
  body.querySelectorAll('[data-agent]').forEach((b, i) => {
    b.querySelector('.pslot').append(portrait({ kind: 'agent', id: people[i].id }, people[i].data.name, 'mini').img);
    b.onclick = () => openAgent(people[i]);
  });
  body.querySelectorAll('[data-pet]').forEach((b, i) => {
    b.querySelector('.pslot').append(portrait({ kind: 'mascot', id: pets[i].id }, pets[i].name, 'mini').img);
    b.onclick = () => openPet(pets[i]);
  });
}

// A meeting room: each meeting it holds (its topic, since when, who's in it and the projects whose plans it changed) and
// the next ones planned, or that the meetings can't be read right now
function meetingLines(id) {
  if (world.meetings === undefined) return '';
  if (world.meetings === null)
    return '<p class="muted">The meetings can’t be read right now: no signal from the coordinator.</p>';
  const held = world.meetingsIn(id),
    who = seats => esc(seats.map(a => world.agents.get(a)?.data.name ?? a).join(', ')),
    next = world.meetings.planned;
  const now = held.length
    ? held
        .map(
          m =>
            `<p><b>${esc(m.topic)}</b></p><p class="muted">Since ${esc(clockWhen(Date.parse(m.started)))} · ${who(m.seats)}</p>` +
            (m.projects?.length
              ? `<p class="muted">Plans changed: ${esc(m.projects.map(p => p.name).join(', '))}</p>`
              : ''),
        )
        .join('')
    : '<p class="muted">No meeting right now.</p>';
  const later = next
    .map(p => `<p>${esc(clockWhen(Date.parse(p.at)))} · ${esc(p.topic)} · ${who(p.seats)}</p>`)
    .join('');
  return now + (later ? `<p class="role">Next</p>${later}` : '');
}

// A mascot: a name card, never an engine badge or a work status; a visit when the scene has it somewhere.
function openPet(m) {
  const pic = portrait({ kind: 'mascot', id: m.id }, m.name),
    where = scene.where?.({ kind: 'mascot', id: m.id }),
    role = [m.role, where && cap(where)].filter(Boolean).join(' · ');
  show(
    'pet',
    `<header class="who"><div class="pframe" style="--c:${pic.accent}"></div>
      <div><h2>${esc(m.name)}</h2><p class="role">${esc(role)}</p></div></header>
    ${m.about ? `<p class="look">${esc(m.about)}</p>` : ''}
    ${where ? `<p><button class="back pet-visit">Say hello on the ${esc(where)} →</button></p>` : ''}`,
    m.id,
  );
  body.querySelector('.pframe').append(pic.img);
  body.querySelector('.pet-visit')?.addEventListener('click', () => {
    closePanel();
    visitMascot(m.id);
  });
}
