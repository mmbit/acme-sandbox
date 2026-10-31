// Settings › Machines: the machines the board lends HQ for long runs, kept by the board itself as Seats keeps the seats.
// One list: each machine a row (its name, its state in a word, what it has and its speed), Add a machine, and a line on
// which takes a run. A machine opens its own page: its load now and over the last minutes, the run it has and that run's
// newest output (machinelive.js), then Pause, Rename, its colours, Install again and Remove. A new machine's page shows, this once, its install
// command, with its key: pasted once, it keeps the machine's helpers in step with HQ from then on. A machine whose manager
// runs old code or stopped says so, and its page shows the install command without a key, which starts it again on the
// key it has. The coordinator's 'machines' event redraws it (world.machines), with no polling. desk.js's
// Settings draws it, and its back button steps back a page here first (machinesBack).
import { esc } from '../util.js';
import { dayTime } from '../world/clock.js';
import { livePart } from './machinelive.js';
import * as world from '../world/world.js';
import {
  loadMachines,
  loadMachineSetup,
  addMachine,
  renameMachine,
  colourMachine,
  pauseMachine,
  removeMachine,
  newInstall,
} from './data.js';
import { sfx } from './audio.js';

// A machine's state in a word (the coordinator's: taking, running, away, paused)
const STATE = { taking: 'Taking runs', running: 'Running one', away: 'Away', paused: 'Paused' };
// A manager that needs installing again, in a word (the coordinator's managerOf)
const MANAGER = { old: 'Manager out of date', quiet: 'Manager stopped' };
const RETRY_MS = 5000;
// The colours the board can give a machine, its case's and its lights', that every look draws its rig in. The first is
// the looks' own; its swatch shows how Wire draws it.
const FINISHES = [
  { name: 'HQ violet', body: null, glow: null, swatch: ['#d9cdfb', '#8b5cf6'] },
  { name: 'Black and red', body: '#111114', glow: '#e5243b' },
  { name: 'Black and blue', body: '#111114', glow: '#3b82f6' },
  { name: 'Black and white', body: '#111114', glow: '#f4f4f5' },
  { name: 'White and teal', body: '#efeee9', glow: '#14b8a6' },
  { name: 'Silver and green', body: '#b4b8c2', glow: '#22c55e' },
];

// What the board has open or under way, kept through every redraw
const ui = {
  page: null, // null: the list; { machine } or 'add'
  asking: null, // on a machine's page: 'rename', 'install' or 'remove', asked in place
  sending: new Set(), // what has a request on its way: 'add', 'pause', 'rename', 'colour', 'install', 'remove'
  refused: new Map(), // the same → why it didn't go through, in words
  paused: null, // { machine, value }: the switch just flipped, till the list has it
  coloured: null, // { machine, finish }: the swatch just tapped (FINISHES' index), till the list has it
  added: null, // the machine just added or installed again, { id, install }: its install command, shown on its page until the board leaves
  removed: null, // the name of the machine just removed, said on the list
};
let shown = null; // the last read, { el, h, list, setup }, so a tap redraws at once
let drawn = ''; // its markup: an unchanged one leaves the screen, and its focus, alone
let current = null; // the element Machines was last opened into: an answer meant for an earlier one is dropped
let listening = null; // the 'machines' event's off()

// Settings draws Machines here (h: dev, crumb(parts) for the header), at a machine's page when it's given one (the rig
// tapped in the building): a machine that isn't on the list opens the list.
export async function machineSettings(el, h, machine = null) {
  current = el;
  Object.assign(ui, {
    page: machine ? { machine } : null,
    asking: null,
    added: null,
    removed: null,
    paused: null,
    coloured: null,
  });
  el.innerHTML = '<p>LOADING…<i class="cursor"></i></p>';
  while (
    !(await read(el, h).then(
      () => true,
      () => false,
    ))
  ) {
    if (current !== el) return;
    el.innerHTML = '<p><i class="prompt">&gt; </i>No signal from the coordinator. Retrying…<i class="cursor"></i></p>';
    await new Promise(resolve => setTimeout(resolve, RETRY_MS));
  }
  if (current !== el) return;
  draw(true);
  listening?.();
  listening = world.on('machines', () => {
    if (current !== el || !el.isConnected) return listening?.();
    shown.list = world.machines;
    draw(false);
  });
}
// The header's back button: a machine's page or Add a machine go back to the list (false: on the list already)
export function machinesBack() {
  if (!ui.page || !shown?.el.isConnected) return false;
  sfx.blip();
  go(null);
  return true;
}
// What Settings' Machines row says: how many the board lends; and each one's page, for HQ's search (desk.js
// settingsSections)
export const machinesSummary = async dev => String((await machinePages(dev)).length);
export const machinePages = async dev =>
  (await loadMachines(dev)).filter(isLent).map(m => ({ page: m.id, name: m.name }));
async function read(el, h) {
  const [list, setup] = await Promise.all([loadMachines(h.dev), shown?.setup ?? loadMachineSetup(h.dev)]);
  if (current === el) shown = { el, h, list, setup };
}
const isLent = machine => machine.id !== 'server';

// force: after the board's own tap. Otherwise a field it's typing in holds the redraw back.
function draw(force) {
  const { el, list, h } = shown;
  const busy = el.contains(document.activeElement) && document.activeElement.matches('input');
  if (!el.isConnected || (busy && !force)) return;
  if (ui.page?.machine !== undefined && !list.some(m => m.id === ui.page.machine)) ui.page = null; // (removed meanwhile)
  if (ui.paused && list.find(m => m.id === ui.paused.machine)?.paused === ui.paused.value) ui.paused = null;
  if (ui.coloured) {
    const coloured = list.find(m => m.id === ui.coloured.machine);
    if (!coloured || finishOf(coloured) === ui.coloured.finish) ui.coloured = null;
  }
  const html = `<div class="seats-app machines-app">${page(list)}</div>`;
  h.crumb?.(crumb(list));
  if (html === drawn && el.querySelector(':scope > .machines-app')) return;
  const top = scroller(el).scrollTop;
  el.innerHTML = drawn = html;
  scroller(el).scrollTop = top;
  const lines = el.querySelector('.machine-lines');
  if (lines) lines.scrollTop = lines.scrollHeight; // (the newest output in view)
  wire(el);
}
const scroller = el => el.closest('.screen') ?? el; // (Settings' screen scrolls, not the page drawn in it)
const crumb = list =>
  !ui.page ? [] : ui.page === 'add' ? ['Add a machine'] : [list.find(m => m.id === ui.page.machine)?.name ?? ''];
function go(to) {
  Object.assign(ui, { page: to, asking: null });
  if (to?.machine !== ui.added?.id) ui.added = null;
  if (to) ui.removed = null;
  ui.refused.clear();
  scroller(shown.el).scrollTop = 0;
  draw(true);
}

// ---- the pages
function page(list) {
  const machine = ui.page?.machine !== undefined && list.find(m => m.id === ui.page.machine);
  const server = list.find(m => !isLent(m));
  return machine ? machinePage(machine, server) : ui.page === 'add' ? addForm() : listPage(list, server);
}
// The list: the machines, Add a machine, and which takes a run
function listPage(list, server) {
  const gone = ui.removed ? said('done', `✓ ${ui.removed} removed. Its key no longer works.`) : '';
  const row = m => `<li data-machine="${esc(m.id)}"><button data-open="${esc(m.id)}"><b>${esc(m.name)}</b>
    <span class="to">${stateWord(m)} ›</span><span class="dim">${esc([sizeLine(m, server), MANAGER[m.manager?.state]].filter(Boolean).join(' · '))}</span></button></li>`;
  return `${gone}<p class="cap"><i class="prompt">&gt; </i>MACHINES</p><ul class="rows settings seats machines">${list.filter(isLent).map(row).join('')}
    <li><button data-add><b>+ Add a machine</b><span class="to">›</span></button></li></ul>
    <p class="seat-foot">The fastest free machine takes each run. This server takes those no machine takes in time.</p>`;
}
const stateWord = m => `<span class="seat-now is-${esc(m.state)}">${esc(STATE[m.state] ?? m.state)}</span>`;
// What a machine has, and its speed next to this server's where that's known
function sizeLine(m, server) {
  const speed = !m.speed
    ? ''
    : server?.speed
      ? `${(m.speed / server.speed).toFixed(1)}× this server`
      : `speed ${m.speed}`;
  const parts = [m.cpus && `${m.cpus} cores`, m.memoryGb && `${m.memoryGb} GB`, m.gpu, speed].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Not heard from yet';
}
// A machine's page: its name and state, the key command once, it live, then its settings
function machinePage(m, server) {
  const head = `<div class="seat-top"><b class="seat-name">${esc(m.name)}</b>${stateWord(m)}</div>
    <p class="dim">${esc(sizeLine(m, server))}</p>`;
  return `${head}${ui.added?.id === m.id ? setupBox(ui.added.install) : managerBox(m)}${livePart(m)}${settingsOf(m)}`;
}
// A manager on old code or stopped: what to paste on the machine to start it again, on the key it has
function managerBox(m) {
  const state = m.manager?.state;
  if (!MANAGER[state]) return '';
  const why =
    state === 'old'
      ? 'Its manager runs code HQ has since changed. It stops when the machine or Docker restarts, and the helpers keep their old images.'
      : `Its manager hasn’t checked in since ${dayTime(Date.parse(m.manager.seen))}, while its helpers still take runs: it has most likely stopped.`;
  return `<div class="seat-signin machine-setup"><p>${esc(why)} On the machine, with Docker running, paste this once. It keeps the machine’s key:</p>
    ${copyBlock(shown.setup.install)}</div>`;
}
// What the board pastes on a machine: its install command, its key in it
function setupBox(install) {
  return `<div class="seat-signin machine-setup"><p>On the machine, with Docker running, paste this once. It holds the machine’s key, and HQ shows it only now:</p>
    ${copyBlock(install)}<p class="dim">From then on the machine keeps its helpers in step with HQ by itself. They ask for work within a minute or two, and the machine shows here as Taking runs.</p></div>`;
}
const copyBlock = text =>
  `<div class="machine-cmd"><code>${esc(text)}</code><button type="button" class="act" data-copy="${esc(text)}">Copy</button></div>`;
// a machine's settings, as Settings' rows: Pause, Rename, its helpers' commands, Remove (which asks first, in place)
function settingsOf(m) {
  const id = esc(m.id),
    paused = ui.paused?.machine === m.id ? ui.paused.value : m.paused;
  const rename =
    ui.asking === 'rename'
      ? `<form class="seat-ask" data-rename-form><label>Its name<input name="machine-name" value="${esc(m.name)}" maxlength="40" autocomplete="off" spellcheck="false"></label>
    <div class="seat-btns"><button class="cta"${ui.sending.has('rename') ? ' disabled' : ''}>Save</button><button type="button" class="act" data-do="keep">Cancel</button></div>${outcome('rename')}</form>`
      : '';
  const install =
    ui.asking === 'install'
      ? `<div class="seat-ask"><p>A new key and install command: its helpers stop until it’s pasted on the machine.</p>
    <div class="seat-btns"><button type="button" class="cta" data-do="install-sure"${ui.sending.has('install') ? ' disabled' : ''}>Make it</button>
    <button type="button" class="act" data-do="keep">Cancel</button></div>${outcome('install')}</div>`
      : '';
  const remove =
    ui.asking === 'remove'
      ? `<div class="seat-ask danger-zone"><p>Its key stops working at once, so HQ lets its helpers in no more. On the machine, remove them with:</p>
    ${copyBlock(shown.setup.remove)}<div class="seat-btns"><button type="button" class="danger" data-do="remove-sure"${ui.sending.has('remove') ? ' disabled' : ''}>Remove ${esc(m.name)}</button>
    <button type="button" class="act" data-do="keep">Cancel</button></div>${outcome('remove')}</div>`
      : '';
  return `<ul class="rows settings seat-settings">
    <li class="switch-row"><b id="pause-${id}">Pause</b><span class="ctl"><button type="button" class="switch" role="switch" data-toggle="pause" aria-checked="${paused}" aria-labelledby="pause-${id}"${ui.sending.has('pause') ? ' disabled' : ''}><i></i></button></span>${outcome('pause')}</li>
    <li><button data-do="rename"><b>Rename</b><span class="to">›</span></button>${rename}</li>
    ${coloursOf(m)}
    <li><button data-do="install"><b>Install again</b><span class="dim">For a machine whose helpers were started by hand</span><span class="to">›</span></button>${install}</li>
    <li><button data-do="remove" class="danger-row"><b>Remove machine</b></button>${remove}</li></ul>`;
}
// Its colours: a swatch per finish, the one it has pressed, and that one's name (a pair set another way: Its own)
function coloursOf(m) {
  const id = esc(m.id),
    chosen = ui.coloured?.machine === m.id ? ui.coloured.finish : finishOf(m);
  const swatch = (finish, index) => {
    const [body, glow] = finish.swatch ?? [finish.body, finish.glow];
    return `<button type="button" class="swatch" data-finish="${index}" aria-pressed="${index === chosen}" aria-label="${esc(finish.name)}" title="${esc(finish.name)}" style="--body:${body};--glow:${glow}"${ui.sending.has('colour') ? ' disabled' : ''}><i></i></button>`;
  };
  return `<li class="machine-colours"><b id="colours-${id}">Colours</b><span class="to">${esc(FINISHES[chosen]?.name ?? 'Its own')}</span>
    <span class="swatches" role="group" aria-labelledby="colours-${id}">${FINISHES.map(swatch).join('')}</span>${outcome('colour')}</li>`;
}
// The finish a machine has (FINISHES' index), -1 for colours set another way
const finishOf = m => FINISHES.findIndex(finish => finish.body === m.body && finish.glow === m.glow);
// Add a machine: its name, and HQ makes its key
const addForm =
  () => `<form class="seat-form" data-add-form><label>Its name<input name="machine-name" placeholder="The study’s desktop" maxlength="40" autocomplete="off" spellcheck="false"></label>
  ${outcome('add')}<div class="seat-btns"><button class="cta"${ui.sending.has('add') ? ' disabled' : ''}>Add machine</button></div>
  <p class="seat-foot">HQ makes its key, then shows what to paste on it.</p></form>`;
function outcome(key) {
  if (ui.sending.has(key)) return said('moving', 'Sending…');
  return ui.refused.has(key) ? said('failed', `Didn’t go through. ${ui.refused.get(key)}`) : '';
}
const said = (kind, words) =>
  `<p class="seat-said ${kind}">${esc(words)}${kind === 'moving' ? '<i class="cursor"></i>' : ''}</p>`;

// ---- the board's taps
function wire(el) {
  const { h } = shown,
    id = ui.page?.machine;
  el.querySelectorAll('[data-open]').forEach(
    b =>
      (b.onclick = () => {
        sfx.blip();
        go({ machine: Number(b.dataset.open) });
      }),
  );
  el.querySelector('[data-add]')?.addEventListener('click', () => {
    sfx.blip();
    go('add');
    el.querySelector('[name=machine-name]')?.focus();
  });
  el.querySelectorAll('[data-copy]').forEach(
    b =>
      (b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          b.textContent = 'Copied ✓';
          sfx.blip();
          setTimeout(() => (b.textContent = 'Copy'), 1200);
        } catch {
          /* no clipboard */
        }
      }),
  );
  el.querySelectorAll('[data-do]').forEach(b => (b.onclick = () => tapped(b.dataset.do, id)));
  el.querySelector('[data-toggle=pause]')?.addEventListener('click', e => {
    const on = e.currentTarget.getAttribute('aria-checked') !== 'true';
    e.currentTarget.setAttribute('aria-checked', on); // (it moves at once; Sending… under it till it's done)
    sfx.toggle(on);
    ui.paused = { machine: id, value: on };
    act(
      'pause',
      () => pauseMachine(h.dev, id, on),
      null,
      () => (ui.paused = null),
    );
  });
  el.querySelectorAll('[data-finish]').forEach(
    b =>
      (b.onclick = () => {
        const finish = Number(b.dataset.finish),
          { body, glow } = FINISHES[finish];
        sfx.blip();
        ui.coloured = { machine: id, finish };
        act(
          'colour',
          () => colourMachine(h.dev, id, body, glow),
          null,
          () => (ui.coloured = null),
        );
      }),
  );
  const named = (form, then) =>
    (form.onsubmit = e => {
      e.preventDefault();
      const field = form.querySelector('input'),
        name = field.value.trim();
      if (!name) return field.focus();
      field.blur();
      then(name);
    });
  const rename = el.querySelector('[data-rename-form]');
  if (rename)
    named(rename, name =>
      act(
        'rename',
        () => renameMachine(h.dev, id, name),
        () => (ui.asking = null),
      ),
    );
  const add = el.querySelector('[data-add-form]');
  if (add)
    named(add, name =>
      act(
        'add',
        () => addMachine(h.dev, name),
        added => {
          ui.page = { machine: added.id };
          ui.added = { id: added.id, install: added.install };
        },
      ),
    );
}
// A tap on a machine's action: Rename and Remove ask first, in place
function tapped(what, id) {
  sfx.blip();
  if (what === 'rename' || what === 'remove' || what === 'install') {
    ui.asking = what;
    ui.refused.delete(what);
    draw(true);
    if (what === 'rename') shown.el.querySelector('[data-rename-form] input')?.select();
    return;
  }
  ui.asking = null;
  if (what === 'keep') return draw(true);
  if (what === 'install-sure')
    return act(
      'install',
      () => newInstall(shown.h.dev, id),
      answer => (ui.added = { id, install: answer.install }),
    );
  const name = shown.list.find(m => m.id === id)?.name;
  act(
    'remove',
    () => removeMachine(shown.h.dev, id),
    () => {
      ui.removed = name;
      ui.page = null;
    },
  );
}
// One request: "Sending…" under its control, then the list read again. A refusal stays in words till the next try.
async function act(key, request, done, failed) {
  ui.sending.add(key);
  ui.refused.delete(key);
  draw(true);
  try {
    const answer = await request();
    done?.(answer);
  } catch (err) {
    ui.refused.set(key, refusalWords(err));
    failed?.();
  }
  ui.sending.delete(key);
  await read(shown.el, shown.h).catch(() => {});
  draw(true);
}
function refusalWords(err) {
  if (err?.refusal?.error) return err.refusal.error;
  const status = Number(String(err?.message).match(/\d{3}$/)?.[0]);
  return status
    ? `The server couldn’t do it (error ${status}). Try again in a minute.`
    : 'Couldn’t reach the coordinator. Try again.';
}
