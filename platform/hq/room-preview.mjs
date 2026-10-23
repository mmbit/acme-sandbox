#!/usr/bin/env node
// HQ's room preview: each kind of room the company's org has, in every look that draws rooms, by day, in the dark and
// on each holiday the company's calendar decorates for, in every state the company gives the kind and every place the
// layout can put it, on one labelled contact sheet a kind.
//   node platform/hq/room-preview.mjs [--rooms kind,kind] [--ref origin/main] [--out <dir>] [--record <file>]
// (--out: a new folder under $TMPDIR when left out)
// Without --rooms it previews the kinds the working tree's change against --ref touches: of the files the visual check
// that runs this tool covers (company/org.yaml review.visual, its paths but not its except), a kind's own file
// (meeting.js) that kind and any other every kind. A change to none of them previews nothing. The org is company/org.yaml, the states theme/hq/room-previews.yaml (its header has
// the format). HQ runs in dev mode on that org as mock data, with a seeded Math.random and a paused clock (harness.mjs),
// a minute and a half of it before each shot so everyone has walked to where the state puts them. Each shot is a PNG of
// the room alone, 2 screen pixels to a pixel of the art; the sheet puts them in a grid, a state a row and a look, setting
// (its date and hour) and place a column, and index.md under --out lists every file. --record writes what was shot into the branch,
// with a section for what the author saw.
// Open every sheet and look at each picture: the room lit as it should be by day and in the dark, nothing hanging in
// front of a window, door, board, sign or face, every person seated or clearly standing, and nothing cut off.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob, resolve } from 'node:path';
import { serve, ROOT } from './serve.mjs';
import { linkModules, TOOLS_HOME } from '../../shared/gates/repo.ts';
import { pin, track, settle, progress } from './harness.mjs';
import { contactSheet, index, writeRecord } from './room-sheet.mjs';
import { playwright } from '../../shared/browser/browser.mjs';
import { HOLIDAYS, holidaysOn } from '../../shared/holidays/holidays.js';
import * as world from './world/world.js';
import { buildLayout } from './renderers/brownstone/layout.js';

const arg = k => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const REF = arg('--ref') ?? 'origin/main',
  OUT = arg('--out') ?? (await mkdtemp(join(tmpdir(), 'room-previews-'))), // (a run of its own: never another's shots)
  RECORD = arg('--record');
// On the render helper: the caller's branch, ref and commit, not the helper's
const SOURCE = process.env.HQ_RENDER_SOURCE && JSON.parse(process.env.HQ_RENDER_SOURCE);
const ORG_FILE = 'company/org.yaml',
  STATES_FILE = 'theme/hq/room-previews.yaml';
const VIEW = { width: 1280, height: 800 },
  PLAIN_DATE = '2026-06-15', // a Monday in June without a holiday, as pixel-check's
  DARK_HOUR = 22,
  WALK_S = 90, // simulated seconds before a shot: long enough to cross the building and sit down
  STEP_S = 1 / 30,
  ZOOM = 2, // screen pixels to a pixel of the art
  AT_S = 2, // the frame's time: the door sign's line has just come in from the right
  POOL = 2; // pages at once: the machine is shared
const FRAME = { walk: WALK_S, step: STEP_S, zoom: ZOOM, at: AT_S };

// The looks HQ ships (shell/stage.js RENDERERS) that draw rooms, each with one palette for a kind of room. Slate (wire)
// draws a key for each person, no rooms
const LOOKS = [
  { id: 'brownstone', name: 'Brownstone', places: true },
  { id: 'holo', name: 'Holo', places: false },
];
const NOTES = [
  'Brownstone has one palette for each kind of room, and Holo one for the whole deck: one column each.',
  'Holo draws every kind of room as the same platform, wherever the layout puts it: one place.',
  "Slate isn't here: it draws a key for each person, not rooms.",
];
// The files that draw only one kind's room. Any other file the visual check covers can change every kind.
const KIND_FILES = {
  'platform/hq/renderers/brownstone/meeting.js': 'meeting',
  'platform/hq/renderers/brownstone/darkroom.js': 'darkroom',
  'platform/hq/renderers/brownstone/darkroomwall.js': 'darkroom',
};

// A job's clone has no node_modules: the worker image's copy is linked in, as the gates do (shared/gates/repo.ts)
linkModules(ROOT, TOOLS_HOME, ROOT);
const { parse } = await import('../coordinator/node_modules/yaml/dist/index.js');
const git = (...a) => promisify(execFile)('git', ['-C', ROOT, ...a], { maxBuffer: 1 << 26 }).then(r => r.stdout.trim());
const org = parse(await readFile(join(ROOT, ORG_FILE), 'utf8')),
  statesOf = parse(await readFile(join(ROOT, STATES_FILE), 'utf8')),
  rooms = orgRooms(org),
  started = Date.now();
const check = org.review?.visual?.find(c => c.run.includes('room-preview.mjs'));
const kinds = arg('--rooms')?.split(',') ?? (await changedKinds());
if (!kinds.length) {
  console.log(`Nothing of HQ's room drawing changed against ${SOURCE?.ref ?? REF}: no rooms to preview.`);
  process.exit(0);
}
for (const kind of kinds) checkKind(kind);

const server = await serve(),
  base = `http://localhost:${server.address().port}`,
  machines = await (await fetch(`${base}/mock/machines.json`)).json(), // (the mock org's, as dev mode reads them)
  { brand } = await (await fetch(`${base}/mock/brand.json`)).json(), // (the company's calendar, as dev mode reads it)
  settings = settingsOf(brand.calendar?.holidays ?? Object.keys(HOLIDAYS)); // (every holiday without one, as clock.js)
const browser = await playwright().chromium.launch({ args: ['--font-render-hinting=none'] });
const previews = [];
for (const kind of kinds) {
  const preview = await previewKind(kind);
  previews.push(preview);
  console.log(
    `${preview.sheet}  (${preview.shots.length} shots${preview.errors.length ? ', page errors: see index.md' : ''})`,
  );
}
await browser.close();
server.close();
await writeFile(join(OUT, 'index.md'), index(previews));
const branch = SOURCE?.branch ?? (await git('rev-parse', '--abbrev-ref', 'HEAD'));
if (RECORD) await writeRecord(resolve(ROOT, RECORD), previews, await rendered(branch));
console.log(
  `Done in ${Math.round((Date.now() - started) / 1000)} s; every file is listed in ${join(OUT, 'index.md')}.`,
);
if (!RECORD && check)
  console.log(`Record what you shot in the branch with --record ${check.record}/${branch.replace(/\//g, '-')}.md`);
console.log('Open every sheet above and look at each picture before you push: lit as intended by day and in the dark,');
console.log(
  'nothing in front of a window, door, board, sign or face, every person seated or clearly standing, nothing cut off.',
);

// ---------------------------------------------------------------- what to preview
// The org's rooms, the first of each kind: the board's, the commons' and the departments' (as world.js setOrg makes them)
function orgRooms(o) {
  const found = new Map(),
    add = (list, id, name, room = {}) =>
      found.has(room.kind ?? 'office') ||
      found.set(room.kind ?? 'office', { kind: room.kind ?? 'office', list, id, name });
  if (o.board) add('board', 'board', 'The Board', o.board.room ?? { kind: 'boardroom' });
  for (const c of o.commons ?? []) add('commons', c.id, c.name ?? c.id, c.room);
  for (const d of o.departments ?? []) add('departments', d.id, d.name ?? d.id, d.room);
  return found;
}

// The kinds the working tree's change against REF draws differently (a kind's own file for a kind the org lacks is said)
async function changedKinds() {
  const sha = await git('rev-parse', '--verify', `${REF}^{commit}`),
    files = `${await git('diff', '--name-only', sha)}\n${await git('ls-files', '--others', '--exclude-standard')}`;
  if (!check)
    throw new Error(`${ORG_FILE} has no review.visual check that runs room-preview.mjs: name them with --rooms`);
  const covered = file => check.paths.some(p => matchesGlob(file, p)) && !check.except?.some(p => matchesGlob(file, p));
  const touched = new Set(),
    every = [...rooms.keys()];
  for (const file of files.split('\n').filter(covered)) {
    const own = KIND_FILES[file];
    if (own && !rooms.has(own)) console.log(`${file} changed, but ${ORG_FILE} has no ${own} room to preview it in.`);
    else if (own) touched.add(own);
    else every.forEach(k => touched.add(k));
  }
  return [...touched];
}

function checkKind(kind) {
  if (!rooms.has(kind))
    throw new Error(`${ORG_FILE} has no room of kind ${kind}: it has ${[...rooms.keys()].join(', ')}`);
}

// ---------------------------------------------------------------- the dates and hours
// The plain day and night, then one setting for each set of holidays the kept ones put up together (the shared table's
// windows), in the plain date's year: on the first evening it's on at the dark hour, or else at its first hour
function settingsOf(kept) {
  const plain = [
      { name: 'day', date: PLAIN_DATE, hour: 12 },
      { name: 'dark', date: PLAIN_DATE, hour: DARK_HOUR },
    ],
    found = new Map(),
    year = Number(PLAIN_DATE.slice(0, 4));
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 3_600_000) {
    const at = new Date(t),
      date = at.toISOString().slice(0, 10),
      hour = at.getUTCHours(),
      on = holidaysOn(date.slice(5), hour, kept),
      name = `holidays: ${on.join(', ')}`;
    if (on.length && (!found.has(name) || (found.get(name).hour !== DARK_HOUR && hour === DARK_HOUR)))
      found.set(name, { name, date, hour });
  }
  const holidays = [...found.values()].sort((p, q) => p.date.localeCompare(q.date));
  return [...plain, ...holidays].map(s => ({ ...s, when: `${s.date} ${String(s.hour).padStart(2, '0')}:00` }));
}
// The page's pinned clock: noon (UTC) on the setting's date (?date= and ?hour= set the day and the hour HQ shows)
function clockOf(setting) {
  return Date.parse(`${setting.date}T12:00:00Z`);
}

// ---------------------------------------------------------------- where the layout puts the room
// One org for each place the layout can put the room (its wing, and whether it ends the wing, where its walls stand
// full height): the org as it stands, then the room moved through its list, then spacer rooms ahead of it
function places(room) {
  const found = new Map();
  for (const variant of variants(room)) {
    const place = placeIn(variant.org, room);
    if (!found.has(place)) found.set(place, { ...variant, place });
  }
  return [...found.values()];
}
function* variants(room) {
  yield { org, how: 'as the org stands' };
  const list = room.list === 'board' ? [] : org[room.list],
    at = list.findIndex(x => x.id === room.id);
  for (let i = 0; i < list.length; i++) {
    const moved = list.filter(x => x.id !== room.id);
    moved.splice(i, 0, list[at]);
    if (i !== at) yield { org: { ...org, [room.list]: moved }, how: `moved to place ${i + 1} of the ${room.list}` };
  }
  const commons = org.commons ?? [],
    ahead = room.list === 'commons' ? at : commons.length;
  for (const size of ['s', 'm', 'l'])
    for (let n = 1; n <= 3; n++) {
      const spacers = Array.from({ length: n }, (_, k) => ({
        id: `spacer-${k + 1}`,
        name: 'Spacer',
        room: { kind: 'office', size },
      }));
      const how = `${n} spacer room${n > 1 ? 's' : ''} ahead of it`;
      yield { org: { ...org, commons: [...commons.slice(0, ahead), ...spacers, ...commons.slice(ahead)] }, how };
    }
}
// Where the room stands in an org's building (the page checks it stands there too)
function placeIn(o, room) {
  world.setOrg({ ...o, machines }, true);
  const r = buildLayout(world, VIEW.width, VIEW.height).rooms.find(x => x.src === room.id),
    last = r.lv.rooms.filter(x => x.wing === r.wing).at(-1);
  return placeName({ wing: r.wing, end: last === r });
}
function placeName({ wing, end }) {
  return `${wing} wing${end ? ', at its open end' : ''}`;
}

// ---------------------------------------------------------------- the mock data for a state
// The org with everyone's status, and the meetings, live and planned, their seats filled from the org's people in order,
// their times round noon (UTC) on the setting's date
function mockData(variantOrg, room, state, setting) {
  const o = structuredClone(variantOrg),
    own = room.list === 'departments' ? o.departments.find(d => d.id === room.id) : null;
  if (state.people === 'none') own.agents = [];
  const people = (o.departments ?? []).flatMap(d => d.agents ?? []);
  for (const a of people) a.status = { state: (own?.agents.includes(a) && state.people) || state.everyone || 'idle' };
  let next = 0,
    id = 1;
  const seats = n => {
    const ids = people.slice(next, (next += n)).map(a => a.id);
    return ids;
  };
  const at = minutes => new Date(clockOf(setting) + minutes * 60_000).toISOString();
  const live = (state.live ?? []).map(m => ({
    id: id++,
    topic: m.topic,
    at: at(-5),
    started: at(-4),
    limit: 30,
    seats: seats(m.seats),
    projects: m.projects?.map(p => ({ name: p.name, changed: at(-p.ago) })),
  }));
  const planned = (state.planned ?? []).map(m => ({ id: id++, topic: m.topic, at: at(m.in), seats: seats(m.seats) }));
  for (const m of live)
    for (const a of people) if (m.seats.includes(a.id)) a.status = { state: 'working', task: m.topic };
  return { org: o, meetings: { live, planned } };
}

// ---------------------------------------------------------------- shooting a kind
async function previewKind(kind) {
  const room = rooms.get(kind),
    dir = join(OUT, kind),
    jobs = shotsOf(room, dir);
  await rm(dir, { recursive: true, force: true }); // (an earlier run's shots, with --out)
  await mkdir(dir, { recursive: true });
  const errors = [],
    todo = jobs.slice();
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      for (let job; (job = todo.shift());) {
        const shot = await shoot(room, job);
        progress();
        await writeFile(job.file, shot.png);
        errors.push(...shot.errors.map(e => `${job.state.name}, ${job.column}: ${e}`));
        job.png = shot.png;
      }
    }),
  );
  const sheet = join(dir, `${kind}-sheet.png`),
    title = `${room.name}: the ${kind} room, ${jobs.length} shots`,
    rows = statesOf[kind].map(s => s.name);
  await writeFile(sheet, await contactSheet(browser, { title, notes: NOTES, rows, shots: jobs }));
  return { kind, room, sheet, shots: jobs, errors };
}

// Every shot of a room: each look, time of day and place (a look that draws no places, one), each state a row. A shot
// whose state moves the room (an empty department is shorter) is captioned with where it stands
function shotsOf(room, dir) {
  const where = places(room),
    shots = [];
  for (const look of LOOKS)
    for (const setting of settings)
      for (const variant of look.places ? where : where.slice(0, 1))
        for (const [row, state] of statesOf[room.kind].entries()) {
          const place = look.places ? `${variant.place} (${variant.how})` : 'its place on the deck',
            column = `${look.name}, ${setting.name}, ${setting.when}, ${place}`,
            colourway = `${look.name}'s one palette`,
            name = `${slug(state.name)}--${look.id}-${slug(setting.name)}-${slug(look.places ? variant.place : 'deck')}`;
          const data = mockData(variant.org, room, state, setting),
            stands = look.places && placeIn(data.org, room),
            caption = stands && stands !== variant.place ? `here it stands in the ${stands}` : '';
          const file = join(dir, `${name}.png`);
          shots.push({ ...data, stands, caption, look, setting, variant, place, colourway, state, row, column, file });
        }
  return shots;
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// One shot in a page of its own: HQ on the state's mock data, in the look and at the hour, time run on, the room framed
async function shoot(room, job) {
  const context = await browser.newContext({
    viewport: VIEW,
    locale: 'en-US',
    timezoneId: 'UTC',
    serviceWorkers: 'block',
  });
  try {
    await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await context.route(/\/mock\/org\.json$/, r => r.fulfill({ json: job.org }));
    await context.route(/\/mock\/meetings\.json$/, r => r.fulfill({ json: job.meetings }));
    await pin(context, clockOf(job.setting));
    const page = track(await context.newPage()),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const { date, hour } = job.setting;
    await page.goto(`${base}/?intro=0&date=${date}&hour=${hour}&weather=clear&renderer=${job.look.id}`);
    await page.waitForFunction(() => window.hq, null, { polling: 100 });
    await settle(page); // (the meetings' read among the boot's requests)
    await page.evaluate(() => (window.hq.world.paused = true));
    await page.clock.runFor(100); // (the boot's zero-delay timers)
    const { clip, wing, last } = await page.evaluate(still, { look: job.look.id, id: room.id, ...FRAME });
    const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
    const place = job.look.places && placeName({ wing, end: last === room.id });
    if (place !== job.stands) throw new Error(`${room.id} stands in the ${place} in the page, not the ${job.stands}`);
    return { png, errors };
  } finally {
    await context.close();
  }
}

// In the page: the look's time run on (the world's and the scene's steps, without drawing), then one frame with the
// room in the middle, and the part of the screen to keep. Brownstone: the room's art at the zoom; Holo: the middle of its
// own framing of the room
// (and where the room stands: its wing, and which room ends that wing on its floor)
async function still({ look, id, walk, step, zoom, at }) {
  const [stage, world] = await Promise.all([import('/shell/stage.js'), import('/world/world.js')]);
  if (stage.look !== look) throw new Error(`${look} didn't start: HQ shows ${stage.look}`);
  for (let t = 0; t < walk; t += step) {
    world.tick(step);
    stage.scene.update(step);
  }
  const cv = document.querySelector('#world');
  let box,
    stands = {};
  if (look === 'brownstone') {
    const r = window.hq.L().rooms.find(x => x.src === id),
      a = r.art,
      cam = window.hq.cam;
    stands = { wing: r.wing, last: r.lv.rooms.filter(x => x.wing === r.wing).at(-1).src };
    Object.assign(cam, { x: Math.round(a.cx + a.c.width / 2), y: Math.round(a.cy + a.c.height / 2), z: zoom, t: null });
    window.hq.frame(at);
    const k = cam.z / devicePixelRatio; // (CSS px a pixel of the art: the canvas is the art at 1:1, scaled up by CSS)
    box = { x: (a.cx - cam.x) * k + innerWidth / 2, y: (a.cy - cam.y) * k + innerHeight / 2 };
    Object.assign(box, { width: a.c.width * k, height: a.c.height * k });
  } else {
    if (!stage.scene.focus({ kind: 'room', id }, { instant: true })) throw new Error(`${look} has no room ${id}`);
    window.hq.frame(at);
    box = { x: innerWidth / 3, y: innerHeight / 3, width: innerWidth / 3, height: innerHeight / 3 };
  }
  // the page as a viewer sees it (the sky is the page's background), without the shell's buttons and panels
  for (const el of document.body.querySelectorAll('*')) if (!el.contains(cv)) el.style.visibility = 'hidden';
  cv.style.visibility = 'visible';
  const x = Math.max(0, Math.round(box.x)),
    y = Math.max(0, Math.round(box.y));
  const clip = {
    x,
    y,
    width: Math.min(innerWidth, Math.round(box.x + box.width)) - x,
    height: Math.min(innerHeight, Math.round(box.y + box.height)) - y,
  };
  return { clip, ...stands };
}

// What the record says was rendered: the branch, its commit (and whether the tree had changes on top) and the command
async function rendered(branch) {
  if (SOURCE) return SOURCE;
  const commit = await git('rev-parse', 'HEAD'),
    dirty = !!(await git('status', '--porcelain')),
    command = ['node platform/hq/room-preview.mjs', ...process.argv.slice(2)].join(' ');
  return { branch, commit, dirty, command };
}
