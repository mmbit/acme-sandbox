// node --test platform/hq/world/world.test.js   (the world alone: no DOM, no coordinator)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as world from './world.js';
import { EMOTES, fade } from './emotes.js';

const org = (...rooms) => ({
  board: { members: [{ id: 'board', name: 'The Board', human: true }] },
  departments: rooms.map(([id, ...agents]) => ({ id, agents: agents.map(a => ({ id: a, name: a, engine: 'claude' })) })),
});

test('a refresh of the org keeps everyone’s state, task and log, and seats a newcomer', () => {
  world.setOrg(org(['studio', 'wren']));
  world.apply({ type: 'status', agent: 'wren', state: 'working', text: 'Pitching ducks' });
  world.apply({ type: 'log', agent: 'wren', text: 'Sketched a duck' });
  const wren = world.agents.get('wren');
  world.setOrg(org(['studio', 'wren', 'pip'], ['ops', 'penny']));
  assert.equal(world.agents.get('wren'), wren);
  assert.equal(wren.state, 'working');
  assert.equal(wren.task, 'Pitching ducks');
  assert.deepEqual(wren.logs.map(l => l.text), ['Working: Pitching ducks', 'Sketched a duck']);
  assert.equal(world.agents.get('penny').state, 'idle');
  assert.deepEqual(world.rooms.find(r => r.id === 'studio').agentIds, ['wren', 'pip']);
});

test('the org’s read sets who is at work, unless the feed has told a newer status since it was asked', () => {
  const now = Date.now;
  let t = 1000;
  Date.now = () => t;
  world.setOrg(org(['studio', 'wren', 'pip', 'tally']));
  world.apply({ type: 'status', agent: 'wren', state: 'working', text: 'Pitching ducks' });
  const read = org(['studio', 'wren', 'pip', 'tally']), asked = t = 2000;
  const [wren, pip, tally] = read.departments[0].agents;
  wren.status = { state: 'idle' };   // its job ended while the feed was cut off
  pip.status = { state: 'working', task: 'The forty', since: '2026-10-18T13:00:00Z' };
  tally.status = { state: 'idle' };
  t = 3000;
  world.apply({ type: 'status', agent: 'tally', state: 'working', text: 'Reviewing' });   // after the read was asked
  const heard = [];
  const off = world.on('status', e => heard.push(e));
  world.setStatuses(read, asked);
  off();
  Date.now = now;
  assert.deepEqual(['wren', 'pip', 'tally'].map(id => world.agents.get(id).state), ['idle', 'working', 'working']);
  assert.deepEqual([world.agents.get('pip').task, world.agents.get('pip').since], ['The forty', Date.parse('2026-10-18T13:00:00Z')]);
  assert.deepEqual(heard, [{ agent: 'wren', was: 'working' }, { agent: 'pip', was: 'idle' }]);
});

test('a room goes dark only when everyone in it sleeps, and the board’s never does', () => {
  world.setOrg(org(['studio', 'wren', 'pip']));
  const asleep = id => world.rooms.find(r => r.id === id).asleep;
  world.apply({ type: 'status', agent: 'wren', state: 'sleeping' });
  assert.equal(asleep('studio'), false);
  world.apply({ type: 'status', agent: 'pip', state: 'sleeping' });
  assert.equal(asleep('studio'), true);
  world.apply({ type: 'status', agent: 'board', state: 'sleeping' });
  assert.equal(asleep('board'), false);
  world.apply({ type: 'status', agent: 'pip', state: 'working' });
  assert.equal(asleep('studio'), false);
});

test('an event naming someone the org chart doesn’t have asks for a refresh', () => {
  world.setOrg(org(['studio', 'wren']));
  assert.equal(world.apply({ type: 'chat', agent: 'wren', to: 'board', text: 'Hi' }).unknown, false);
  assert.equal(world.apply({ type: 'chat', agent: 'wren', to: 'nova', text: 'Welcome!' }).unknown, true);
  assert.equal(world.apply({ type: 'status', agent: 'nova', state: 'working' }).unknown, true);
});

test('an emote set by command shows over its agent, fades out and expires; an unknown kind or agent is ignored', () => {
  world.setOrg(org(['studio', 'wren']));
  const heard = [], off = world.on('feel', f => heard.push(f));
  assert.equal(world.emote('wren', 'idea', 2), true);
  const wren = world.agents.get('wren');
  world.tick(1);
  assert.equal(wren.emote.kind, 'idea');
  assert.equal(fade(wren.emote), 1);
  world.tick(0.7);
  assert.ok(fade(wren.emote) > 0 && fade(wren.emote) < 1);
  world.tick(0.4);
  assert.equal(wren.emote, null);
  assert.equal(world.emote('wren', 'smug'), false);
  assert.equal(world.emote('nova', 'idea'), false);
  off();
  assert.deepEqual(heard, [{ agent: 'wren', emote: 'idea' }]);
});

test('a finished job makes its agent happy, a post its author celebrate, and the coordinator can send any emote', () => {
  world.setOrg(org(['studio', 'wren', 'pip']));
  world.apply({ type: 'status', agent: 'wren', state: 'working', text: 'Pitching ducks' });
  assert.equal(world.agents.get('wren').emote, null);
  world.apply({ type: 'status', agent: 'wren', state: 'idle' });
  assert.equal(world.agents.get('wren').emote.kind, 'happy');
  world.apply({ type: 'post', agent: 'pip', text: 'Ducks, in 16 pixels' });
  assert.equal(world.agents.get('pip').emote.kind, 'celebrate');
  world.apply({ type: 'feel', agent: 'pip', emote: 'question' });
  assert.equal(world.agents.get('pip').emote.kind, 'question');
});

test('a new kind of emote needs only its entry in EMOTES', () => {
  world.setOrg(org(['studio', 'wren']));
  EMOTES.wave = { means: 'saying hello', glyph: '~', color: '#3e9b8f' };
  try {
    world.apply({ type: 'feel', agent: 'wren', emote: 'wave' });
    assert.equal(world.agents.get('wren').emote.kind, 'wave');
  } finally { delete EMOTES.wave; }
});

test('working days on the company’s clock: weekends and the company’s public holidays skipped', () => {
  // the holidays these days meet, as GET /api/org gives them
  world.setOrg({ company: { timeZone: 'Europe/Amsterdam', holidays: ['2026-04-27', '2026-12-25', '2026-12-26', '2028-12-25', '2028-12-26'] } });
  const on = at => [1, 2].map(n => world.dayIn(world.daysToWorkday(n, Date.parse(at)), Date.parse(at)).toISOString().slice(0, 10));
  assert.deepEqual(on('2026-10-09T10:00:00Z'), ['2026-10-12', '2026-10-13'], 'a Friday: Monday and Tuesday');
  assert.deepEqual(on('2026-10-10T10:00:00Z'), ['2026-10-12', '2026-10-13'], 'a Saturday: Monday and Tuesday');
  assert.deepEqual(on('2026-10-13T10:00:00Z'), ['2026-10-14', '2026-10-15'], 'an ordinary Tuesday: Wednesday and Thursday');
  assert.deepEqual(on('2026-04-26T10:00:00Z'), ['2026-04-28', '2026-04-29'], 'the day before Koningsdag (Monday 27 April)');
  assert.deepEqual(on('2026-12-24T10:00:00Z'), ['2026-12-28', '2026-12-29'], 'Christmas Eve, a Thursday: Christmas and the weekend');
  assert.deepEqual(on('2028-12-22T10:00:00Z'), ['2028-12-27', '2028-12-28'], 'Christmas and Boxing Day on a Monday and Tuesday');
  assert.deepEqual(on('2026-10-08T22:30:00Z'), ['2026-10-12', '2026-10-13'], '00:30 on Friday in Amsterdam is Friday, not Thursday');
  world.setOrg({ company: { timeZone: 'Europe/Amsterdam' } });
  assert.equal(world.daysToWorkday(1, Date.parse('2026-12-24T10:00:00Z')), 1, 'no calendar: the weekdays');
  assert.equal(world.daysToWorkday(1, Date.parse('2026-12-24T10:00:00Z'), 0), 0, 'from today: a Thursday is one');
  assert.equal(world.daysToWorkday(1, Date.parse('2026-10-18T10:00:00Z'), 0), 1, 'from today: a Sunday is not');
});

test('a card put aside comes back on the first morning still ahead on the company’s clock: today before 08:00 there', () => {
  world.setOrg({ company: { timeZone: 'Europe/Amsterdam' } });
  assert.equal(world.firstMorning(Date.parse('2026-10-18T22:30:00Z')), 0, '00:30 on Monday in Amsterdam: Monday');
  assert.equal(world.firstMorning(Date.parse('2026-10-19T05:59:00Z')), 0, '07:59 in Amsterdam: still today');
  assert.equal(world.firstMorning(Date.parse('2026-10-19T06:00:00Z')), 1, '08:00 in Amsterdam: tomorrow');
  assert.equal(world.firstMorning(Date.parse('2026-12-01T06:30:00Z')), 0, 'winter time: 07:30 in Amsterdam');
  assert.equal(world.firstMorning(Date.parse('2026-10-18T21:30:00Z')), 1, '23:30 on Sunday: Monday is tomorrow');
});

test("the machines: from the org, then their event; the rig is the one at work, else the fastest, and Wire has a key for each one that's on, in the shape the looks draw", () => {
  let heard = 0;
  const off = world.on('machines', () => heard++);
  const at = i => new Date(Date.UTC(2026, 9, 17, 12, 0, i * 10)).toISOString();
  const server = { id: 'server', name: 'This server', state: 'taking', speed: 500, cpus: null, gpuCount: 0, body: null, glow: null };
  const laptop = { id: 2, name: 'Laptop', state: 'taking', speed: 300, cpus: 4, gpuCount: 0, body: null, glow: null };
  const tower = { id: 3, name: 'Tower', state: 'away', speed: 2000, cpus: null, gpuCount: 0, body: null, glow: null };
  const rig = { id: 1, name: 'The rig', state: 'taking', speed: 1500, cpus: 32, gpu: '2× RTX 4090', gpuCount: 2, body: '#111114', glow: '#e5243b' };
  world.setOrg({ ...org(['studio', 'wren']), machines: [rig, laptop, tower, server] });
  const unsaid = { size: 2, gpuCount: 0, body: null, glow: null };
  assert.deepEqual(world.machine, { id: 3, name: 'Tower', present: false, running: null, ...unsaid }, 'the fastest, though away');
  assert.deepEqual(world.rigs().map(m => m.name), ['The rig', 'Laptop'], 'those that are on, not this server');
  assert.deepEqual(world.rigs().map(m => [m.size, m.gpuCount, m.body, m.glow]), [[3, 2, '#111114', '#e5243b'], [1, 0, null, null]], 'each its size and the colours the board gave it');
  const run = { kind: 'simulation', job: 7, agent: 'wren', title: 'Seeds', since: at(0), cores: 24 };
  const live = { cpu: 90, mem: 41, gpu: 12, history: [{ at: at(0), cpu: 80, mem: 40 }, { at: at(1), cpu: 90, mem: 41, gpu: 12 }], lines: ['seed 1'] };
  world.apply({ type: 'machines', machines: [rig, { ...laptop, state: 'running', run, live }, tower, server] });
  assert.equal(heard, 2);
  assert.deepEqual(world.machine, { id: 2, name: 'Laptop', present: true, running: { ...run, output: ['seed 1'] }, size: 1, gpuCount: 0, body: null, glow: null, cpu: [80, 90], memory: [40, 41], gpu: [12] }, 'the one at work');
  world.setOrg(org(['studio', 'wren']));
  assert.deepEqual([world.machine, world.rigs()], [null, []], 'none lent');
  off();
});

test('On Air: a host working on a show’s job is recording, a co-host who’s free joins, and nobody once it’s done', () => {
  world.setOrg({ ...org(['studio', 'wren', 'pip', 'penny']), shows: [{ id: 'digest', name: 'The Morning Digest', hosts: ['wren', 'pip'] }] });
  const [wren, pip, penny] = ['wren', 'pip', 'penny'].map(id => world.agents.get(id));
  assert.equal(world.onAir(), false);
  world.apply({ type: 'status', agent: 'wren', state: 'working', text: 'On Air: The Morning Digest (17 Oct)' });
  assert.deepEqual([world.recording(wren)?.id, world.joining(pip)?.id, world.joining(penny)], ['digest', 'digest', null]);
  assert.equal(world.onAir(), true);
  world.apply({ type: 'status', agent: 'wren', state: 'idle' });
  assert.deepEqual([world.recording(wren), world.joining(pip), world.onAir()], [null, null, false]);
});

test('the photo studio: from the org, then its event; none without one', () => {
  let heard = 0;
  const off = world.on('studio', () => heard++);
  world.setOrg(org(['creative', 'pinhole']));
  assert.equal(world.studio, null);
  world.setOrg({ ...org(['creative', 'pinhole']), studio: { keeper: 'pinhole', waiting: 3, developing: 1, editing: 1 } });
  assert.deepEqual(world.studio, { keeper: 'pinhole', waiting: 3, developing: 1, editing: 1 });
  world.apply({ type: 'studio', studio: { keeper: 'pinhole', waiting: 4, developing: 0, editing: 0 } });
  assert.deepEqual(world.studio, { keeper: 'pinhole', waiting: 4, developing: 0, editing: 0 });
  world.apply({ type: 'studio', studio: null });
  assert.equal(world.studio, null);
  assert.equal(heard, 2); // (the org's own signal covers a new org)
  off();
});

test('meetings: who sits in a live one, the meeting rooms hold every live one in turn, and a failed read is unread', () => {
  const commons = [{ id: 'lobby', room: { kind: 'lobby' } }, { id: 'meet', room: { kind: 'meeting' } }];
  world.setOrg({ ...org(['studio', 'wren', 'pip', 'penny']), commons });
  let heard = 0;
  const off = world.on('meetings', () => heard++);
  assert.deepEqual([world.meetings, world.meetingOf('wren'), world.meetingsIn('meet')], [undefined, null, []], 'pending before a read');
  const live = [{ id: 1, topic: 'Levels', seats: ['wren', 'pip'] }, { id: 2, topic: 'Books', seats: ['penny'] }];
  world.setMeetings({ live, planned: [] });
  assert.deepEqual([world.meetingOf('pip')?.id, world.meetingOf('penny')?.id, world.meetingOf('nobody')], [1, 2, null]);
  assert.deepEqual([world.meetingsIn('meet').map(m => m.id), world.meetingsIn('lobby')], [[1, 2], []], 'one room holds both');
  world.setMeetings({ live, planned: [] });
  assert.equal(heard, 1, 'a read that changes nothing is not heard');
  world.setMeetings(null); // a failed read
  assert.deepEqual([heard, world.meetings, world.meetingOf('pip'), world.meetingsIn('meet')], [2, null, null, []]);
  world.setMeetings({ live, planned: [] });
  world.setOrg({ ...org(['studio', 'wren', 'pip', 'penny']), commons: [...commons, { id: 'meet2', room: { kind: 'meeting' } }] });
  assert.deepEqual([world.meetingsIn('meet').map(m => m.id), world.meetingsIn('meet2').map(m => m.id)], [[1], [2]], 'two rooms: one each');
  off();
});
