// The Sketchbook's sketches from the coordinator (sketches.ts), or in dev mode from mock/sketches.json, played in memory
// with the same refusals.
//   a sketch: { id, label, archived, created, updated, w, h, strokes, pictures, picture, sent }, with ink: [strokes],
//   scraps: [{ file, x, y, w, h, tilt, url }] and waiting: [{ file, url }] (pictures from review mode) when read whole
//   (the pictures)
import { act, copy, refused, get } from '../data.js';
import { pictureOf } from './sketchpen.js';

export const loadSketches = dev => (dev ? mockList() : act('/api/sketches'));
export const loadSketch = (dev, id) => (dev ? mockOne(id) : act(`/api/sketches/ink?id=${Number(id)}`));
// what: create { label?, w, h }, save { id, ink, scraps, picture }, label { id, label }, archive { id, archived },
// delete { id }, send { id }
export const sketchAction = (dev, what, body) => (dev ? mockAction(what, body) : act(`/api/sketches/${what}`, body));

// A picture for a sketch's page, as HQ drew it smaller (sketchscraps.js shrink): { file, url }.
export async function uploadScrap(dev, id, blob) {
  return dev ? mockUpload(id, blob) : act(`/api/sketches/scrap?id=${Number(id)}`, blob);
}

let mock = null;
// (dev mode's pictures: a file's name to its address here; any other is one of mock/'s)
const mockFiles = new Map();
const mockUrl = file => mockFiles.get(file) ?? `mock/${file}`;
function mockUpload(id, blob) {
  const file = `${id}-s-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}.${blob.type === 'image/png' ? 'png' : 'jpg'}`;
  mockFiles.set(file, URL.createObjectURL(blob));
  return { file, url: mockUrl(file) };
}
// (and the invited people's books, read only)
let mockGuests = [];
async function state() {
  if (!mock) {
    const all = await get('mock/sketches.json');
    mock = all.sketches;
    mockGuests = all.guests ?? [];
    // (the coordinator keeps each one's picture from HQ's save: here they're drawn once)
    for (const s of [...mock, ...mockGuests.flatMap(g => g.sketches)])
      s.picture = s.ink.length ? pictureOf(s, 'image/png') : null;
  }
  return mock;
}
const summary = ({ ink, scraps, waiting: _waiting, ...s }) => ({
  ...s,
  strokes: ink.length,
  pictures: scraps?.length ?? 0,
});
async function mockList() {
  const all = await state();
  const guests = mockGuests.map(g => ({ ...g, sketches: g.sketches.map(summary) }));
  return { sketches: copy(all.map(summary).sort((a, b) => b.updated.localeCompare(a.updated))), guests: copy(guests) };
}
async function mockOne(id) {
  const s = (await state()).find(s => s.id === Number(id));
  if (!s) throw refused(404, 'That sketch is gone.');
  const withUrl = p => ({ ...p, url: mockUrl(p.file) });
  return copy({
    ...summary(s),
    ink: s.ink,
    scraps: (s.scraps ?? []).map(withUrl),
    waiting: (s.waiting ?? []).map(withUrl),
  });
}
async function mockAction(what, body) {
  const all = await state(),
    now = new Date().toISOString();
  if (what === 'create') {
    const s = { id: Math.max(0, ...all.map(s => s.id)) + 1, label: body.label ?? '', archived: false };
    all.push(
      Object.assign(s, { created: now, updated: now, w: body.w, h: body.h, ink: [], picture: null, sent: null }),
    );
    return copy(summary(s));
  }
  const s = all.find(s => s.id === Number(body.id));
  if (!s) throw refused(404, 'That sketch is gone.');
  if (what === 'delete') {
    all.splice(all.indexOf(s), 1);
    return { ok: true };
  }
  if (what === 'send') {
    if (!s.picture) throw refused(409, 'Draw something first: there’s nothing on the page to send.');
    s.sent = now;
    return { sent: now, line: 1, picture: 1 };
  }
  if (what === 'label' && String(body.label).trim().length > 80)
    throw refused(400, 'A label is 80 characters at most.');
  if (what === 'label') s.label = String(body.label).trim();
  else if (what === 'archive') s.archived = !!body.archived;
  else if (what === 'save') {
    const named = new Set((body.scraps ?? []).map(p => p.file));
    Object.assign(s, { ink: body.ink, scraps: body.scraps ?? [], picture: body.picture });
    s.waiting = (s.waiting ?? []).filter(p => !named.has(p.file));
  } else throw refused(404, 'There’s no such Notebook action.');
  if (what === 'save') s.updated = now;
  return copy(summary(s));
}
