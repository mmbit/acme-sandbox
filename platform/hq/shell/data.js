// Talks to the coordinator. Falls back to mock data and a scripted event stream in dev mode.
import * as world from '../world/world.js';
import { placed } from './order.js';

// (toLogin and get are exported for a company's HQ apps' own data)
export const toLogin = () => { location.href = '/login'; return new Promise(() => {}); };

export async function get(url) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) return toLogin();
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// Mock data only when HQ runs locally. On the real site a failed request (say, mid-deploy) is retried
// with backoff, so the board never sees a fake company. Every endpoint below follows the same `dev` flag.
const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn) {
  for (let wait = 2000; ; wait = Math.min(wait * 2, 30000)) { try { return await fn(); } catch (e) { console.info('[hq] retrying:', e.message); await sleep(wait); } }
}
export async function loadOrg() {
  for (let wait = 2000; ; wait = Math.min(wait * 2, 30000)) {
    try { return { org: await get('/api/org'), dev: false }; }
    catch (e) {
      if (local) { console.info('[hq] /api/org unavailable, using mock data', e.message); return { org: await mockOrg(), dev: true }; }
      await sleep(wait);
    }
  }
}
// The company's brand and HQ theme: { brand, theme }, each {} when the company has none. Mock data as for the org.
// HQ boots on the defaults if the brand can't be had within a few seconds
export const loadBrand = () => Promise.race([retry(() => get('/api/brand').catch(e => local ? get('mock/brand.json') : Promise.reject(e))), sleep(6000).then(() => ({ brand: {}, theme: {} }))]);

// A later read of the org (null if it can't be had right now), and what identifies its shape: everything
// but the agents' live status, which arrives as events.
export const fetchOrg = dev => (dev ? mockOrg() : get('/api/org')).catch(() => null);
// (a lent machine's being there changes the building; which, whether it's on and what it runs don't: world.setMachines)
// (the photo studio's being there and who keeps it change the building; its counts don't: world.setStudio.)
export const orgKey = org => JSON.stringify(org, (k, v) => k === 'status' ? undefined : k === 'machines' && Array.isArray(v) ? v.some(m => m.id !== 'server')
  : k === 'studio' ? v && { keeper: v.keeper ?? null } : v);
// The mock org, with the mock machines as the coordinator's org read has them
const mockOrg = async () => ({ ...(await get('mock/org.json')), machines: await mockList('machines') });
// The deployed version: { ok, commit } from the coordinator's public health check (null if unreachable).
export const loadHealth = () => fetch('/health', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
export const loadHqChanges = since => get(`/api/hq/changes?since=${since}`).then(r => r.changes ?? []).catch(() => []);

// The agents' meetings, live and planned
export const loadMeetings = dev => (dev ? get('mock/meetings.json') : get('/api/meetings'));

export const loadLibrary = dev => dev ? get('mock/library.json').catch(() => []) : get('/api/library');
export const loadGazette = dev => dev ? get('mock/gazette.json').catch(() => []) : retry(() => get('/api/gazette'));

// ---- the board's desk: requests (phone), directives (intercom), seats and jobs (computer) ----
// In dev mode these work against mock files, with answers and directives kept in memory.
const mock = {};
const mockList = async name => (mock[name] ??= await get(`mock/${name}.json`));
// A refusal rejects with an Error whose message ends in the status, and whose `refusal` is the coordinator's answer
// ({ error, and what the caller needs to act on it }).
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) return toLogin();
  if (!res.ok) throw Object.assign(new Error(`${url}: ${res.status}`), { refusal: await res.json().catch(() => null) });
  return res.json().catch(() => ({}));
}
export const loadRequests = dev => (dev ? mockList('requests') : get('/api/requests')).then(r => Array.isArray(r) ? r.slice() : []).catch(() => null);
// The answered cards (desk.js: the archive), newest first, a page at a time: { cards, more, total }, before = the last card
// shown (the mock pages by 3, so Older cards shows); a photo the board added to one
export async function loadArchive(dev, before) {
  if (!dev) return get(`/api/requests/archive${before ? `?before=${Number(before)}` : ''}`);
  const all = await mockList('archive'), from = before ? all.findIndex(r => r.id === before) + 1 : 0;
  return { cards: all.slice(from, from + 3), more: all.length > from + 3, total: all.length };
}
export const archivePhoto = (dev, id, field) => dev ? 'mock/review-shot.svg' : `/api/requests/photo?id=${Number(id)}&field=${Number(field)}`;
// a one-time link that signs the board in on a preview address (single sign-on from HQ)
export async function previewLink(dev, url) { return dev ? url : (await post('/api/preview/link', { url })).url; }
// (address, on an address card: { use: a saved address's id } or { save: its name })
// answers: a card's questions', in their order
// pictures: the numbers of the pictures that go with the answer
// review: a card that brings work back, answered with notes on its preview in review mode
export async function answerRequest(dev, id, answer, secrets, approve = false, address = undefined, answers = undefined, pictures = undefined, review = false) {
  if (!dev) return post('/api/requests/answer', { id, answer, secrets, approve, address, answers, pictures, ...(review && { review }) });
  const r = (await mockList('requests')).find(x => x.id === id);
  if ((r?.questions ?? []).some((q, k) => !answers?.[k])) throw new Error('mock: 400');
  if ([...r?.photos ?? [], ...r?.documents ?? []].some(p => !p.optional && !p.saved)) throw new Error('mock: 400'); // like the server
  if ((r?.zips ?? []).some(z => !z.optional && z.state !== 'imported')) throw new Error('mock: 400');
  for (const p of pictures ?? []) mockWaiting.delete(p);
  mock.requests = (await mockList('requests')).filter(r => r.id !== id);
  return { ok: true };
}
// the board removes a saved delivery address; the saved ones left come back
export async function removeAddress(dev, id) {
  if (!dev) return post('/api/addresses/remove', { id });
  const left = (await mockList('requests')).find(r => r.address)?.addresses?.filter(a => a.id !== id) ?? [];
  for (const r of mock.requests) if (r.address) r.addresses = left;
  return { ok: true, addresses: left };
}
// Cards for later (later.ts): the open cards off the desk phone until a day, soonest
// back first (null when they can't be had: the list on screen stays), and the board's snooze on a card until a day ('2026-10-13'), or day null to bring
// one back now. Dev mode moves the mock card between the two lists, as the server would.
export const loadLater = dev => (dev ? mockList('later') : get('/api/requests/later')).then(r => Array.isArray(r) ? r.slice() : null).catch(() => null);
export async function snoozeRequest(dev, id, day) {
  if (!dev) return post('/api/requests/later', { id, day });
  const open = await mockList('requests');
  const held = await mockList('later').catch(() => (mock.later = []));
  if (day === null) {
    const r = held.find(x => x.id === id);
    mock.later = held.filter(x => x.id !== id);
    if (r) mock.requests = [{ ...r, hidden_until: undefined, changed: new Date().toISOString() }, ...open];
    return { ok: true, until: null };
  }
  const r = open.find(x => x.id === id);
  const until = new Date(`${day}T00:00`).toISOString();
  if (!r || !(Date.parse(until) > Date.now())) throw new Error('mock: 400');
  mock.requests = open.filter(x => x.id !== id);
  mock.later = [...held, { ...r, hidden_until: until, day }].sort((a, b) => a.hidden_until.localeCompare(b.hidden_until));
  return { ok: true, until, day };
}
// A guest card (guests.ts): the guest's email address, asked the first time, and their page's language; a new link for it
// ('link'), the request closed ('request'), or the guest's access revoked ('guest'). `person` names whose language, link
// or access ('person': removed from this request, the last one too), and guestAdd invites someone else on it.
// Dev mode changes the mock card the way the server would.
export async function guestEmail(dev, id, email) {
  if (!dev) return post('/api/guest/email', { id, email });
  const r = (await mockList('requests')).find(x => x.id === id);
  if (!r?.guest || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new Error('mock: 400');
  Object.assign(r.guest, { address: `${email[0]}••••${email.slice(email.indexOf('@'))}`, needsEmail: false });
  r.guest.people?.filter(p => p.name === r.guest.name).forEach(p => { p.address = r.guest.address; });
  mockPeople(r);
  return { ok: true };
}
export async function guestRevoke(dev, id, what, person) {
  if (!dev) return post('/api/guest/revoke', { id, what, person });
  const r = (await mockList('requests')).find(x => x.id === id);
  if (what === 'guest' && r?.guest) { r.guest.people.find(p => p.name === (person ?? r.guest.name)).revoked = true; mockPeople(r); }
  if (what === 'request' && r?.guest) { r.guest.status = 'closed'; r.guest.people?.forEach(p => delete p.share); }
  if (what === 'person' && r?.guest) { r.guest.people.find(p => p.name === person).withdrawn = true; mockPeople(r); }
  return { ok: true };
}
export async function guestAdd(dev, id, name, email) {
  if (!dev) return post('/api/guest/person', { id, name, email });
  const r = (await mockList('requests')).find(x => x.id === id);
  if (!r?.guest?.people || r.guest.people.some(p => p.name === name && !p.withdrawn)) throw Object.assign(new Error('mock: 409'), { refusal: { error: `${name} is on this request already` } });
  r.guest.people = [...r.guest.people.filter(p => p.name !== name), { name, address: `${email[0]}••••${email.slice(email.indexOf('@'))}`, released: false, verified: null, lang: r.guest.lang,
    withdrawn: false, revoked: false }];
  mockPeople(r);
  return { ok: true };
}
// A guest card's switch: its guests may invite colleagues at their own domain
export async function guestColleagues(dev, id, on) {
  if (!dev) return post('/api/guest/colleagues', { id, on });
  const r = (await mockList('requests')).find(x => x.id === id);
  if (r?.guest?.colleagues) r.guest.colleagues.on = on;
  return { ok: true };
}
// the people's colours in the mock's legend, by the order they were added (guests.ts colourOf() makes the real ones)
const COLOURS = ['#2a2352', '#c4475a', '#2f7d4f', '#7a55c0', '#b0661c', '#1f7a99'];
const hue = n => COLOURS[n % COLOURS.length];
// as card() in guests.ts: everyone still on it with an address has their own Share; with several, a legend and their colours
function mockPeople(r) {
  const on = r.guest.people.filter(p => !p.withdrawn && !p.revoked), link = p => `https://hq.example/guest/mock-${p.name.toLowerCase()}`; // the link alone
  r.guest.people.forEach((p, n) => {
    if (on.includes(p) && p.address && r.guest.status === 'open') p.share = link(p); else delete p.share;
    if (on.length > 1) p.colour = hue(n); else delete p.colour;
  });
  delete r.share;
  if (on.length > 1) r.guest.legend = r.guest.people.map((p, n) => ({ name: p.name, colour: hue(n) })); else delete r.guest.legend;
  if (on.length === 1) Object.assign(r.guest, { name: on[0].name, address: on[0].address });
}
// An email card's Send (with the board's subject and text) and Discard (outbox.ts). Dev mode takes the card off, as the
// server would.
export async function outboxSend(dev, id, subject, text) {
  if (!dev) return post('/api/outbox/send', { id, subject, text });
  mock.requests = (await mockList('requests')).filter(r => r.id !== id);
  return { ok: true };
}
// The words in an email card's boxes, for its letter's preview
export const outboxPreview = (id, subject, text) => post('/api/outbox/preview', { id, subject, text });
export async function outboxDiscard(dev, id) {
  if (!dev) return post('/api/outbox/discard', { id });
  mock.requests = (await mockList('requests')).filter(r => r.id !== id);
  return { ok: true };
}
// A call out's Call and Don't call (id: the card's). Call on a call room answers with the link to send on and when it's
// open. Dev mode takes the card off, as the server would.
export async function calloutApprove(dev, id) {
  if (!dev) return post('/api/callouts/approve', { id });
  const list = await mockList('requests'), call = list.find(r => r.id === id)?.call;
  mock.requests = list.filter(r => r.id !== id);
  if (call?.kind !== 'link') return { ok: true };
  const opens = new Date(), closes = new Date(opens.getTime() + 24 * 3600_000);
  return { ok: true, link: `https://hq.example/join/mock-${id}`, opens: opens.toISOString(), closes: closes.toISOString() };
}
export async function calloutDecline(dev, id) {
  if (!dev) return post('/api/callouts/decline', { id });
  mock.requests = (await mockList('requests')).filter(r => r.id !== id);
  return { ok: true };
}
// The whole number a call out will dial, only while the call is still to come (never kept on the device)
export async function calloutNumber(dev, id) {
  if (!dev) return get(`/api/callouts/number?id=${Number(id)}`);
  const call = (await mockList('requests')).find(r => r.id === id)?.call;
  if (!call?.ending) throw new Error('mock: 404');
  return { number: `+31 20 555 0${call.ending}` };
}
// Share on a guest card releases its request: its link opens from then on
export async function guestRelease(dev, id, person) {
  if (!dev) return post('/api/guest/release', { id, person });
  const r = (await mockList('requests')).find(x => x.id === id);
  if (r?.guest) Object.assign(person ? r.guest.people.find(p => p.name === person) : r.guest, { released: true });
  return { ok: true };
}
// The board's language (the coordinator's language.ts): what it reads and hears from its agents, and the languages it
// can be.
const MOCK_LANGUAGE = { lang: 'en', languages: [{ code: 'en', name: 'English', own: 'English' }, { code: 'nl', name: 'Dutch', own: 'Nederlands' },
  { code: 'de', name: 'German', own: 'Deutsch' }] };
export const loadLanguage = dev => dev ? Promise.resolve({ ...MOCK_LANGUAGE }) : get('/api/language');
export const setLanguage = (dev, lang) => dev ? Promise.resolve(Object.assign(MOCK_LANGUAGE, { lang })) : post('/api/language', { lang });
export async function guestLang(dev, id, lang, person) {
  if (!dev) return post('/api/guest/lang', { id, lang, person });
  const r = (await mockList('requests')).find(x => x.id === id);
  if (r?.guest) Object.assign(person ? r.guest.people.find(p => p.name === person) : r.guest, { lang });
  return { ok: true };
}
// A photo for a desk-phone request's photo field (photos.ts), sent as it is picked. XHR for the upload progress.
// Rejects with an Error ending in the HTTP status (0: the coordinator can't be reached). Dev mode keeps the pictures
// in mockPhotos, exactly as they would have been sent.
const mockPhotos = new Map();
export function uploadPhoto(dev, id, field, blob, onProgress = () => {}) {
  if (dev) return (async () => {
    for (const pct of [30, 70, 100]) { onProgress(pct); await sleep(150); }
    mockPhotos.set(`${id}:${field}`, blob);
    const p = (await mockList('requests')).find(r => r.id === id)?.photos?.[field];
    if (p) p.saved = true;
    return { ok: true, field, bytes: blob.size };
  })();
  return sendField(`/api/requests/photo?id=${Number(id)}&field=${Number(field)}`, blob, blob.type || 'image/jpeg', 'photo', onProgress);
}
// A file for a document field (documents.ts), sent as it is, with its name. Resolves to { field, name, bytes } and
// rejects like uploadPhoto. Dev mode only marks the field.
export function uploadDocument(dev, id, field, file, onProgress = () => {}) {
  if (dev) return (async () => {
    for (const pct of [50, 100]) { onProgress(pct); await sleep(150); }
    const d = (await mockList('requests')).find(r => r.id === id)?.documents?.[field];
    if (d) Object.assign(d, { saved: true, name: file.name });
    return { ok: true, field, name: file.name, bytes: file.size };
  })();
  const url = `/api/requests/document?id=${Number(id)}&field=${Number(field)}&name=${encodeURIComponent(file.name)}`;
  return sendField(url, file, file.type || 'application/octet-stream', 'document', onProgress);
}
// One chunk of a big zip for a zip field (zips.ts), from `offset` of the picked file. Resolves to { received, state }.
// Rejects with an Error ending in the HTTP status (0: no answer), carrying the server's answer as `refusal` (on 416,
// { received }: the bytes it has). Dev mode keeps the count here and "unpacks" it in a second.
const mockZips = new Map();
export async function sendZipChunk(dev, id, field, file, offset, chunk) {
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  if (dev) return mockZipChunk(id, field, file, key, offset, chunk);
  const query = new URLSearchParams({ id, field, name: file.name, size: file.size, file: key, offset });
  let res;
  try {
    res = await fetch(`/api/requests/zip?${query}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' }, body: chunk });
  } catch {
    throw new Error('zip: 0');
  }
  if (res.status === 401) return toLogin();
  const answer = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`zip: ${res.status}`), { refusal: answer });
  return answer;
}
// A zip field as the server has it now: polled while it's unpacked.
export async function loadZipField(dev, id, field) {
  if (!dev) return get(`/api/requests/zip?id=${Number(id)}&field=${Number(field)}`);
  const f = (await mockList('requests')).find(r => r.id === id)?.zips?.[field];
  if (f?.state === 'importing' && Date.now() - mockZips.get(`${id}:${field}`).done > 1000)
    Object.assign(f, { state: 'imported', imported: { folder: `/imports/${id}-mock`, folders: 40, files: 2310, bytes: 1.3 * 1024 ** 3, leftOut: { files: 182400, bytes: 2.9 * 1024 ** 3 } } });
  return f;
}
async function mockZipChunk(id, field, file, key, offset, chunk) {
  await sleep(120);
  const at = `${id}:${field}`, had = mockZips.get(at);
  const received = had?.key === key ? had.received : 0;
  if (offset !== received) throw Object.assign(new Error('zip: 416'), { refusal: { received } });
  const now = { key, received: offset + chunk.size, done: 0 };
  mockZips.set(at, now);
  const f = (await mockList('requests')).find(r => r.id === id)?.zips?.[field];
  const state = now.received === file.size ? 'importing' : 'uploading';
  if (state === 'importing') now.done = Date.now();
  if (f) Object.assign(f, { state, name: file.name, size: file.size, received: now.received });
  return { received: now.received, state };
}
function sendField(url, blob, type, what, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('content-type', type);
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    x.onload = () => x.status === 401 ? toLogin() : x.status === 200 ? resolve(JSON.parse(x.responseText || '{}')) : reject(new Error(`${what}: ${x.status}`));
    x.onerror = () => reject(new Error(`${what}: 0`));
    x.send(blob);
  });
}
// A picture for the intercom (pictures.ts), a card's answer or a live
// call, sent as soon as it's picked or pasted, so Send doesn't wait for it. Resolves to { id, type, bytes }, and rejects
// like uploadPhoto. Dev mode keeps it in mockPictures, and its thumbnail is the picture itself.
const mockPictures = new Map(), mockWaiting = new Map();   // (waiting: id → the card it's for, 0 the intercom)
// A call's picture carries the call's key (pictures.ts) and stops when `signal` aborts: the board hung up.
export function uploadPicture(dev, blob, { call = 0, key = '', request = 0, signal = null, onProgress = () => {} } = {}) {
  if (dev) return (async () => {
    for (const pct of [40, 100]) { onProgress(pct); await sleep(150); }
    const id = mockPictures.size + 1;
    mockPictures.set(id, URL.createObjectURL(blob));
    if (!call) mockWaiting.set(id, request);
    return { id, type: blob.type, bytes: blob.size };
  })();
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/pictures${call ? `?call=${Number(call)}&key=${encodeURIComponent(key)}` : request ? `?request=${Number(request)}` : ''}`);
    x.setRequestHeader('content-type', blob.type || 'image/jpeg');
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    x.onload = () => x.status === 401 ? toLogin() : x.status === 200 ? resolve(JSON.parse(x.responseText || '{}')) : reject(new Error(`picture: ${x.status}`));
    x.onerror = x.onabort = () => reject(new Error('picture: 0'));
    if (signal?.aborted) return x.abort();
    signal?.addEventListener('abort', () => x.abort());
    x.send(blob);
  });
}
// The pictures uploaded for the board's next line and not
// sent yet, [{ id, type }], and taking one out of the tray: the coordinator deletes it, so it no longer counts against the
// pictures that may wait
export async function loadWaitingPictures(dev, request = 0) {
  return dev ? [...mockWaiting].filter(([, r]) => r === request).map(([id]) => ({ id, type: 'image/jpeg' })) : (await get(`/api/pictures/waiting${request ? `?request=${Number(request)}` : ''}`)).pictures;
}
export async function forgetPicture(dev, id) {
  if (dev) return mockWaiting.delete(id);
  return post('/api/pictures/forget', { id });
}
export const pictureUrl = (dev, id) => dev ? mockPictures.get(Number(id)) ?? 'mock/review-shot.svg' : `/api/pictures/file?id=${Number(id)}`;
// The intercom: a conversation with the CEO (the coordinator resumes their session for each message)
const mockChat = { messages: [], thinking: false };
export async function loadChat(dev) { return dev ? mockChat : get('/api/chat'); }
// A picture no longer waiting refuses the line: the error's refusal.missing names it (chat.ts fromBoard).
export async function sendChat(dev, text, pictures = []) {
  if (!dev) return post('/api/chat', { text, pictures });
  for (const id of pictures) mockWaiting.delete(id);
  mockChat.messages.push({ id: Date.now(), ts: new Date().toISOString(), who: 'board', text, ...(pictures.length ? { pictures } : {}) }); mockChat.thinking = true;
  setTimeout(() => { mockChat.messages.push({ id: Date.now(), ts: new Date().toISOString(), who: world.company.ceo, text: 'On it! (dev mode reply)' }); mockChat.thinking = false; }, 1500);
  return mockChat;
}
// Voice: the intercom's recording, transcribed by the coordinator. Rejects with the HTTP status (413: too long,
// 503: the transcriber is down), or 0 when the coordinator can't be reached.
export async function transcribe(clip, lang) {
  const res = await fetch(`/api/voice?lang=${encodeURIComponent(lang)}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': clip.type || 'audio/webm' }, body: clip }).catch(() => ({ status: 0 }));
  if (res.status === 401) return toLogin();
  if (res.status !== 200) throw res.status;
  return (await res.json()).text || '';
}
// Push notifications (the computer's Notifications tab and push.js)
export const pushKey = () => get('/api/push/key');
export const pushSubscribe = sub => post('/api/push/subscribe', sub);
export const pushUnsubscribe = endpoint => post('/api/push/unsubscribe', { endpoint });
export const pushTest = endpoint => post('/api/push/test', { endpoint });
export const loadMail = dev => dev ? mockList('mail') : get('/api/mail');
// What the board has read, for all its devices (seen.js). Dev mode starts from
// mock/seen.json and keeps the rest in memory.
export const loadSeen = dev => dev ? mockList('seen').then(marks => ({ ...marks })) : get('/api/seen');
export async function saveSeen(dev, list, newest) {
  if (!dev) return post('/api/seen', { list, newest });
  const marks = await mockList('seen');
  marks[list] = newest;
  return { ...marks };
}
// Mail's Send to the team on a mail of the board's own: { job, already } (mail.ts forward). Dev mode makes up a job number.
export const forwardMail = (dev, id) => dev ? Promise.resolve({ job: 9000 + Number(id), already: false }) : post('/api/mail/forward', { id });
export const loadMailOne = (dev, id) => dev ? Promise.resolve({ id, body: '(mock) The message text shows here.', attachments: '[]' }) : get(`/api/mail/one?id=${id}`);
export const loadCalls = dev => dev ? mockList('calls').catch(() => []) : get('/api/calls');
// "We missed something": one item the board adds to a call (a task for the call's agent), and the call is followed up again.
export async function addCallItem(dev, call, what) {
  if (!dev) return post('/api/calls/item', { call, what });
  const c = (await mockList('calls')).find(k => k.id === call);
  if (!c || !what || /[\r\n]/.test(what) || [...what].length > 200) throw new Error('mock: 400'); // like the server
  c.items = [...(c.items ?? []), { what, owner: c.agent, status: 'open', job: null, agent: null, request: null, why: null, board: 1 }];
  Object.assign(c, { total: c.items.length, processed: 0, state: 'ended', status: 'queued', attempts: 0 });
  return { id: Date.now(), job: c.job };
}
// (Jobs, jobs.js: every open job and the latest finished, and the recurring work, which On Air and the HUD's count read)
export const loadSchedule = dev => dev ? mockList('schedule') : get('/api/schedule');
// On Air's Run now: a recurring entry's job at once (the scheduled one still comes): { job }
export const runRecurring = (dev, id) => dev ? Promise.resolve({ job: 0, job_code: 'ROUND' }) : post('/api/schedule/run', { id }); // (job_code)
// On Air: the shows with their episodes and podcast links, and a show's new link (the old one ends)
export const loadOnAir = dev => dev ? mockList('onair') : get('/api/onair');
export const renewOnAirLink = (dev, show) => dev ? Promise.resolve({}) : post('/api/onair/link', { show });
// Settings › Overseer
const MOCK_OVERSIGHT = { company: 'The company', address: 'http://localhost/api/overseer/', key: 'overseer_example', read: null };
export const loadOversight = dev => dev ? Promise.resolve(MOCK_OVERSIGHT) : get('/api/oversight');
export const renewOversightKey = dev => dev ? Promise.resolve(MOCK_OVERSIGHT) : post('/api/oversight/renew', {});
// The projects view (projects.js): projects, their threads and jobs, and the open work in none
export const loadProjects = dev => dev ? mockList('projects') : get('/api/projects');
// The board's order of a grid's projects (their ids), kept for every device: the answer is every project's order, dev
// mode's the mock's projects placed as the coordinator places them.
export async function sortProjects(dev, ids) {
  if (!dev) return post('/api/projects/order', { order: ids });
  return { order: placed((await mockList('projects')).projects.map(p => p.id), ids) };
}
// A done thread with its jobs, which the projects view opens from its project.
export const loadThread = async (dev, id) => dev ? (await mockList('threads'))[id] : get(`/api/projects/thread?id=${encodeURIComponent(id)}`);
// A finished review's or ruling's findings, each with what became of it (the coordinator's reviewrows.ts).
export const loadFindings = async (dev, id) => dev ? { findings: (await mockList('findings'))[id] ?? [] } : get(`/api/projects/findings?job=${Number(id)}`);
export const loadJobs = dev => dev ? mockList('jobs') : get('/api/jobs');
// One job by its number, however old (null when there's none): Jobs opening one its list no longer holds. Dev mode's are
// the mock jobs and the projects mock's
export async function loadJob(dev, id) {
  if (!dev) return (await get(`/api/jobs/find?id=${Number(id)}`)).job;
  const board = await mockList('projects'),
    all = [...await mockList('jobs'), ...board.projects.flatMap(p => p.threads.flatMap(t => t.jobs)), ...board.unsorted, ...(board.meetings ?? [])];
  return all.find(j => j.id === Number(id)) ?? null;
}
// no jobs start for memory, while it lasts: a line, or null (the coordinator's room.ts)
export const loadRoom = dev => dev ? Promise.resolve({ line: 'No new jobs can start: the worker has been short of memory for 6 min. 2 jobs could start if memory allowed.' }) : get('/api/room');
// a job's log, oldest first (the coordinator's log.ts); dev mode's is made up
export const loadJobLog = (dev, id) => dev ? Promise.resolve(mockLog()) : get(`/api/jobs/log?id=${Number(id)}`);
const mockLog = () => ['Read platform/coordinator/src/jobs.ts', 'Grep “claimNext” in platform/coordinator/src', 'I’ll add the wait to the claim query, then test it.',
  'Edit platform/coordinator/src/jobs.ts', '$ cd platform/coordinator && node --test src/jobs.test.ts', 'Plan: ✓ Read the queue · ✓ Add the wait · Test it']
  .map((text, i, all) => ({ ts: new Date(Date.now() - (all.length - i) * 47e3).toISOString(), agent: null, text }));
// what the company got done each day, the last 14 (Wire's numbers: the coordinator's work.ts)
export const loadWork = dev => dev ? mockList('work') : get('/api/work');
// Numbers (numbers.js): a line per app, and one app's dashboard for a period and mode. Dev mode reads mock/numbers.json
// and mock/numbers/<slug>.json, which holds an answer per "<mode>:<days>".
export const loadNumbers = (dev, days = 28) => get(dev ? 'mock/numbers.json' : `/api/numbers?days=${Number(days)}`);
export const loadNumbersApp = (dev, slug, days, mode) => dev
  ? get(`mock/numbers/${encodeURIComponent(slug)}.json`).then(m => m[`${mode}:${days}`] ?? Promise.reject(new Error('mock: 400')))
  : get(`/api/numbers/${encodeURIComponent(slug)}?days=${Number(days)}&mode=${encodeURIComponent(mode)}`);
// ---- Care (care.js): the customers waiting on the board, and what it does about them, from the coordinator's /api/care
// routes (platform/coordinator/src/care.ts)
// A Care action: a refusal arrives in plain words ({ error }), and they become the Error's message (.status is the HTTP
// status; 0: the coordinator can't be reached), so the board reads why, not a code. Without a body it's a GET (Find a case).
async function act(url, body) {
  const res = await fetch(url, body === undefined ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
    : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) throw refused(0, 'Could not reach the coordinator. Try again.');
  if (res.status === 401) return toLogin();
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw refused(res.status, typeof json?.error === 'string' && json.error ? json.error : `That didn’t go through (error ${res.status}). Try again in a minute.`);
  return json;
}
const refused = (status, words) => Object.assign(new Error(words), { status });
const copy = v => JSON.parse(JSON.stringify(v));
// Dev mode plays the coordinator on mock/care*.json, in memory: the list, each card's full text by id, the sent cards and
// every remedy (both paged by 2 here, so Older shows), with the same refusals as the server.
let careMock = null;
async function careState() {
  careMock ??= await Promise.all(['care', 'care-cards', 'care-done', 'care-remedies'].map(n => get(`mock/${n}.json`)))
    .then(([list, full, done, rows]) => ({ ...list, full, done, rows, erased: [] }));
  const s = careMock;
  for (const c of s.cards.filter(c => c.status === 'sending' && Date.parse(c.undoUntil) <= Date.now())) careDone(c, 'sent');
  const open = c => ['waiting', 'unsure'].includes(c.status);
  // an ask's redraft comes 1.5 s later here (care's model, played): the draft replaced, the text before kept
  for (const c of s.cards.filter(c => c.asking && Date.parse(c.asking.at) < Date.now() - 1500)) {
    (s.full[c.id].lines ??= []).push({ id: 900 + c.id, at: new Date().toISOString(), who: 'note', text: `Redrafted as you asked: “${c.asking.ask}”` });
    Object.assign(c, { before: c.draft ?? '', draft: `${c.draft ? `${c.draft.trim()}\n\n` : ''}(Redrafted as you asked: ${c.asking.ask})`, asking: null, changes: null, canGoBack: true });
  }
  s.counts = { replies: s.cards.filter(c => c.kind !== 'bug' && open(c) && c.sendTo !== 'partner').length, claims: s.cards.filter(c => open(c) && c.sendTo === 'partner').length, bugs: s.cards.filter(c => c.kind === 'bug' && c.status === 'waiting').length, remedies: s.remedies.length, owed: s.owed.length, held: (s.held ?? []).filter(h => !h.answer).length };
  return s;
}
const careDone = (c, status) => { careMock.cards = careMock.cards.filter(x => x !== c); Object.assign(c, { status, undoUntil: null }); careMock.done.unshift(c); };
const LIST = ['cards', 'busy', 'queue', 'name', 'email', 'remedies', 'owed', 'counts', 'mailOnly', 'slots', 'held'];
export const loadCare = async dev => dev ? copy(Object.fromEntries(Object.entries(await careState()).filter(([k]) => LIST.includes(k)))) : get('/api/care');
export const loadCareCount = async dev => dev ? copy((await careState()).counts) : get('/api/care/count');
export async function loadCareCard(dev, id) {
  if (!dev) return get(`/api/care/card?id=${Number(id)}`);
  const s = await careState(), c = s.cards.find(x => x.id === id) ?? s.done.find(x => x.id === id);
  if (!c) throw refused(404, 'That card isn’t there any more.');
  const full = { ...c, ...s.full[id] };
  if (s.name) full.signoff = String(full.signoff ?? '').replace('[your name]', s.name);
  return copy(full);
}
// Find a case by its reference (H-1042, 1042, E-7): its card, or the coordinator's words for why not (deleted at the
// customer's request, not in Care)
export async function findCareCase(dev, ref) {
  if (!dev) return act(`/api/care/card?case=${encodeURIComponent(ref)}`);
  const r = String(ref).trim().toUpperCase().replace(/^([HE]?)-?(?=\d)/, (_, l) => `${l || 'H'}-`), s = await careState();
  if (!/^[HE]-\d{1,9}$/.test(r)) throw refused(400, 'A case reference is a letter and a number, like H-1042 or E-7.');
  if (s.erased.includes(r)) throw refused(404, `${r} was deleted at the customer’s request: only its reference is kept.`);
  const c = s.cards.find(x => x.case === r) ?? s.done.find(x => x.case === r);
  if (!c) throw refused(404, `There’s no case ${r} in Care.`);
  return loadCareCard(dev, c.id);
}
// a page of the sent (and closed) cards, newest first, after the card `before`; and every remedy the same way
async function page(dev, url, list, key, before, size) {
  if (!dev) return get(`${url}${before ? `?before=${Number(before)}` : ''}`);
  const all = (await careState())[list], from = before ? all.findIndex(x => x.id === before) + 1 : 0;
  return copy({ [key]: all.slice(from, from + size), more: all.length > from + size });
}
export const loadCareDone = (dev, before) => page(dev, '/api/care/done', 'done', 'cards', before, 2);
export const loadCareRemedies = (dev, before) => page(dev, '/api/care/remedies', 'rows', 'remedies', before, 2);
// a bug report's picture and a claim's photos: only ever an <img> from here
export const carePicture = (dev, id) => dev ? 'mock/review-shot.svg' : `/api/care/picture?id=${Number(id)}`;
export const carePhoto = (dev, id, name) => dev ? 'mock/care-photo.jpg' : `/api/care/photo?id=${Number(id)}&name=${encodeURIComponent(name)}`;
// POST /api/care/<what>: send, undo, ask, unask, back, to, draft, close, unsure, fixed, handoff, erase, busy, name, refund-again;
// an email's tomail, and tocare (job #3318)
export async function careAction(dev, what, body) {
  if (!dev) return act(`/api/care/${what}`, body);
  const s = await careState(), now = Date.now();
  // a card that was sent or closed can be deleted too (from the Sent fold or Find a case)
  if (what === 'erase') {
    const c = s.cards.find(x => x.id === body.id) ?? s.done.find(x => x.id === body.id);
    if (!c) throw refused(404, 'That card isn’t there any more.');
    if (['sending', 'mailing'].includes(c.status)) throw refused(409, 'A reply on this card is on its way: Undo it, or wait until it’s gone, then delete the case. Nothing was deleted.');
    s.cards = s.cards.filter(x => x !== c); s.done = s.done.filter(x => x !== c); delete s.full[c.id]; s.erased.push(c.case);
    return { ok: true, case: c.case };
  }
  const c = s.cards.find(x => x.id === body.id);
  if ('id' in body && !c) throw refused(404, 'That card isn’t there any more.');
  const undo = () => new Date(now + 10_000).toISOString();
  switch (what) {
    case 'send':
      if (!s.name) throw refused(409, 'Your name for the sign-off isn’t set yet.');
      if (!s.email) throw refused(503, 'The email key isn’t on the server yet, so nothing was sent.');
      if (!String(body.text ?? '').trim()) throw refused(409, 'The reply is empty.');
      if (c.asking) throw refused(409, 'The team is redrafting this reply: wait for it, or take your ask back first. Nothing was sent.');
      if ((s.full[c.id]?.lines ?? []).some(l => l.id > body.seen)) { c.draft = body.text; throw refused(409, 'A new message came in while you wrote: read it first. Your reply is kept; nothing was sent.'); }
      Object.assign(c, { status: 'sending', draft: body.text, sentAt: new Date(now).toISOString(), undoUntil: undo(), error: null, newReply: false });
      return { ok: true, undoUntil: c.undoUntil };
    case 'undo':
      if (c.status !== 'sending' || Date.parse(c.undoUntil) <= now) throw refused(409, 'Already sent');
      Object.assign(c, { status: 'waiting', sentAt: null, undoUntil: null });
      return { ok: true };
    case 'ask':
      if (c.kind === 'claim') throw refused(409, 'The team doesn’t redraft a claim’s emails: edit this one yourself.');
      if (c.kind === 'email') throw refused(409, 'The team doesn’t redraft a reply to an email: edit it yourself.');
      if (!String(body.text ?? '').trim()) throw refused(400, 'Say what to change.');
      Object.assign(c, { changes: body.text.trim(), draft: String(body.draft ?? '').trim() || null, asking: { ask: body.text.trim(), at: new Date(now).toISOString() } });
      return { ok: true };
    case 'unask': Object.assign(c, { changes: null, asking: null }); return { ok: true };
    case 'back': Object.assign(c, { draft: c.before || null, canGoBack: false }); return { ok: true };
    case 'to': c.sendTo = body.to; return { ok: true };
    case 'draft':
      if (c.asking) throw refused(409, 'The team is redrafting this reply: take your ask back to edit it yourself.');
      c.draft = body.text; return { ok: true };
    case 'close': careDone(c, 'closed'); return { ok: true };
    case 'tomail':
      if (c.kind !== 'email' || c.status !== 'waiting') throw refused(409, 'Only an email card waiting for its reply goes back to Mail.');
      s.mailOnly = [...new Set([...(s.mailOnly ?? []), s.full[c.id].to.toLowerCase()])]; careDone(c, 'closed'); return { ok: true };
    case 'tocare':
      if (!(s.mailOnly ?? []).includes(String(body.address ?? '').toLowerCase())) throw refused(404, 'That address isn’t kept in Mail.');
      s.mailOnly = s.mailOnly.filter(a => a !== String(body.address).toLowerCase()); return { ok: true };
    case 'fixed': careDone(c, 'fixed'); return { ok: true };
    case 'unsure':
      if (body.went) careDone(c, 'sent'); else Object.assign(c, { status: 'waiting', sentAt: null, error: null }); // Send again: the board taps Send
      return { ok: true };
    case 'handoff': Object.assign(c, { job: 4000 + c.id, job_code: null }); return { ok: true, job: c.job, job_code: c.job_code }; // (job_code)
    case 'busy': {
      const b = s.busy; b.switch = body.busy; b.on = b.held || body.busy !== 'off';
      b.why = b.held ? `someone has waited over ${b.aim ?? 3} working days` : body.busy === 'on' ? 'switched on here' : body.busy === 'auto' ? 'one has waited over 2 working days' : null;
      return { ok: true };
    }
    case 'name':
      if (!String(body.name ?? '').trim() || [...String(body.name).trim()].length > 60) throw refused(400, 'A name of 1 to 60 characters.');
      s.name = String(body.name).trim(); return { ok: true };
    case 'refund-again': s.owed = s.owed.filter(o => o.voucher !== body.voucher); return { ok: true, status: 'refunded' };
    // a held order's Release, Refuse or Undo, played: no app reads the answer here, so Undo stays
    case 'held': {
      const h = (s.held ?? []).find(x => x.line === body.line);
      if (!h) throw refused(404, 'That order isn’t waiting any more: it went on, or it was cancelled.');
      if (h.taken) throw refused(409, h.answer === 'release' ? 'It’s on its way to the printer already.' : 'It’s being refunded already.');
      if (body.answer && body.revision !== h.revision) throw refused(409, 'What’s on it changed since you looked: here it is again.');
      Object.assign(h, { answer: body.answer ?? null, answeredAt: body.answer ? new Date().toISOString() : null });
      return { ok: true };
    }
  }
  throw refused(404, 'Not a Care action.');
}
// A remedy's Approve / Not now, and an owed voucher's "Paid another way": the desk phone's own answer to its request
export async function careAnswer(dev, request, approve) {
  if (!dev) return act('/api/requests/answer', { id: request, answer: '', approve });
  await answerRequest(dev, request, '', {}, approve);
  const s = await careState();
  s.remedies = s.remedies.filter(r => r.request !== request); s.owed = s.owed.filter(o => o.request !== request);
  for (const c of s.cards) c.remedies = c.remedies.filter(r => r.request !== request);
  return { ok: true };
}
// Care › Numbers: the apps the support chat has numbers for ({ apps }), or one app's for a mode (null: the app's own). Dev
// mode reads mock/care-numbers.json: { apps, detail: { "<slug>:<mode>": … } }
export async function loadCareNumbers(dev, app, mode) {
  if (!dev) return get(`/api/care/numbers${app ? `?app=${encodeURIComponent(app)}${mode ? `&mode=${encodeURIComponent(mode)}` : ''}` : ''}`);
  const m = await mockList('care-numbers');
  if (!app) return copy({ apps: m.apps });
  const d = m.detail[`${app}:${mode ?? m.apps.find(a => a.slug === app)?.status}`];
  if (!d) throw new Error('mock/care-numbers.json: 404');
  return copy(d);
}
// end of Care

// Numbers' apps: every product, from the repo's product.yaml files
// what's near the board's words in meaning, for HQ's search: { hits: [{ kind, id }], why: why the search model didn't answer,
// if it didn't }; the mock none
export const loadMeaning = (dev, q) => get(dev ? 'mock/meaning.json' : `/api/search/meaning?q=${encodeURIComponent(q)}`);
export const loadApps = dev => get(dev ? 'mock/apps.json' : '/api/apps');
export const loadArtifacts = dev => get(dev ? 'mock/artifacts.json' : '/api/artifacts');
// Review notes (the computer's Notes tab): pending until the board sends a batch to the product's owner.
// Dev mode keeps them in mock/review.json and counts per product from there.
export async function loadReviewProducts(dev) {
  if (!dev) return get('/api/review/products');
  const { products, notes } = await mockList('review'), n = (slug, s) => notes.filter(x => x.slug === slug && x.status === s).length;
  return products.map(p => ({ ...p, pending: n(p.slug, 'pending'), sent: n(p.slug, 'sent'), discarded: n(p.slug, 'discarded') })).sort((a, b) => b.pending - a.pending);
}
export const loadReviewNotes = (dev, slug) => dev ? mockList('review').then(r => r.notes.filter(x => x.slug === slug)) : get(`/api/review/notes?slug=${encodeURIComponent(slug)}`);
// (file: the screenshot's name, new when its mark is drawn again)
export const reviewShot = (dev, id, file) => dev ? 'mock/review-shot.svg' : `/api/review/shot?id=${Number(id)}${file ? `&v=${encodeURIComponent(file)}` : ''}`;
// ...and a picture added to it, by its file's name
export const reviewPicture = (dev, id, file) => dev ? 'mock/review-shot.svg' : `/api/review/shot?id=${Number(id)}&pic=${encodeURIComponent(file)}`;
export async function sendNotes(dev, slug, ids) {
  if (!dev) return post('/api/review/send', { slug, ids });
  const { notes } = await mockList('review'), job = Math.max(0, ...(await mockList('jobs')).map(j => j.id)) + 1;
  const batch = notes.filter(x => x.slug === slug && x.status === 'pending' && ids.includes(x.id));
  batch.forEach(x => Object.assign(x, { status: 'sent', job }));
  return { job, job_code: null, agent: world.company.ceo, name: world.agents.get(world.company.ceo).data.name, count: batch.length }; // (job_code)
}
export async function discardNotes(dev, ids) {
  if (!dev) return post('/api/review/discard', { ids });
  const batch = (await mockList('review')).notes.filter(x => x.status === 'pending' && ids.includes(x.id));
  batch.forEach(x => { x.status = 'discarded'; });
  return { ok: true, count: batch.length };
}

// Shares for outside notes (Reviews, and the viewer's Share): the people invited to leave notes on one preview, each on
// a link of their own. Invite takes {page, name, email, days} (a new share, or the page's open one) or {id, name, email}.
// Dev mode keeps them in memory.
export const loadShares = dev => dev ? Promise.resolve(mock.shares ??= []) : get('/api/review/shares');
const mockRefusal = error => Object.assign(new Error('mock: 409'), { refusal: { error } });
export async function makeShare(dev, body) {
  if (!dev) return post('/api/review/shares', body);
  mock.shares ??= [];
  if (body.tester && body.cap !== undefined && !(Number.isInteger(body.cap) && body.cap >= 1 && body.cap <= 500)) throw mockRefusal('cap: whole euros, 1 to 500');
  let share = body.id ? mock.shares.find(s => s.id === body.id && !s.ended) : null;
  if (!share) {
    // what and whose: the product the page belongs to, as the dev mock's notes have it
    const host = new URL(body.page).host, slug = host.split('.')[0], product = (await mockList('review')).products.find(p => p.slug === slug);
    share = mock.shares.find(s => !s.ended && s.host === host && s.view === !!body.view && s.tester === !!body.tester);
    if (!share) mock.shares.unshift(share = { id: mock.shares.length + 1, what: product?.name ?? slug, host, prefix: '/', ends: new Date(Date.now() + body.days * 864e5).toISOString(),
      ended: null, notes: 0, people: [], job: null, owner: product?.ownerName ?? '',
        view: !!body.view, tester: !!body.tester, cap: body.tester ? body.cap ?? 50 : null, pays: slug === 'front' ? 'order' : 'plan' });
  }
  if (share.people.some(p => p.name === body.name)) throw mockRefusal(`${body.name} is on it already`);
  const known = mockShared().find(p => p.name === body.name), email = body.email ?? known?.email;
  if (!email) throw mockRefusal('that email address doesn’t look right');
  share.people.push({ name: body.name, title: known?.title ?? null, address: `${email[0]}••••${email.slice(email.indexOf('@'))}`, email, opened: null, sent: null, notes: 0, link: `${location.origin}/guest/dev-${Date.now()}`, ordered: null });
  return share;
}
// The people the board shared with in the last three weeks, by name and the title it gave them: the share box's Recent,
// whom a name alone invites again. A title is one short line, empty to clear it. Dev mode: everyone on a mock share.
const mockShared = () => [...new Map((mock.shares ?? []).flatMap(s => s.people).map(p => [p.name, p])).values()];
export const loadPeople = dev => dev ? Promise.resolve(mockShared().map(p => ({ name: p.name, title: p.title ?? null }))) : get('/api/review/people');
export async function setPersonTitle(dev, name, title) {
  if (!dev) return post('/api/review/people/title', { name, title });
  title = title.replace(/\s+/g, ' ').trim().slice(0, 40) || null;
  (mock.shares ?? []).flatMap(s => s.people).filter(p => p.name === name).forEach(p => { p.title = title; });
  return { name, title };
}
export async function removeFromShare(dev, id, name) {
  if (!dev) return post('/api/review/shares/remove', { id, name });
  const share = (mock.shares ??= []).find(s => s.id === id);
  share.people = share.people.filter(p => p.name !== name);
  return share;
}
// A tester invite's amount, in euros
export async function setShareCap(dev, id, cap) {
  if (!dev) return post('/api/review/shares/cap', { id, cap });
  return Object.assign((mock.shares ??= []).find(s => s.id === id), { cap });
}
export async function endShare(dev, id) {
  if (!dev) return post('/api/review/shares/end', { id });
  const share = (mock.shares ??= []).find(s => s.id === id);
  share.people.forEach(p => { p.link = null; });
  return Object.assign(share, { ended: new Date().toISOString() });
}

export function connectEvents(onEvent, dev, org) {
  if (dev) return fakeStream(onEvent, org);
  let es;
  const open = () => {
    es = new EventSource('/api/events');
    es.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch { /* ignore malformed lines */ } };
    es.onerror = async () => {
      if (es.readyState !== EventSource.CLOSED) return; // the browser is retrying on its own
      const r = await fetch('/api/org', { credentials: 'same-origin' }).catch(() => null);
      if (r && r.status === 401) toLogin(); else setTimeout(open, 5000);
    };
  };
  open();
}

// A small scripted day at the office, using whoever exists in the mock org.
const SCRIPT = [
  [2, 'chat', 'juno', 'wren', 'Morning! Can Studio pitch two venture ideas by Friday?'],
  [3, 'chat', 'wren', 'juno', 'On it. One of them involves ducks.'],
  [3, 'status', 'dex', null, 'Printing parcel labels', 'working'],
  [2, 'log', 'bolt', null, 'Job queue: 3 workers online'],
  [3, 'log', 'bolt', null, 'Editing schedule.ts'],
  [0, 'lines', 'bolt', null, null, null, { add: 18, del: 3 }],
  [3, 'log', 'dex', null, 'Run the label printer tests'],
  [2, 'log', 'dex', null, '7 tests passed', null, { tests: 7 }],
  [3, 'chat', 'rook', 'nib', 'Your diff drops the null check on line 42.'],
  [3, 'chat', 'nib', 'rook', 'It is unreachable. Prove me wrong.'],
  [2, 'status', 'tally', null, 'Reviewing PR #12: job queue', 'working'],
  [3, 'log', 'quill', null, 'Panel agreement on PR #12: 3 of 4'],
  [2, 'chat', 'kit', 'moss', 'Need a banner for the building post!'],
  [3, 'chat', 'moss', 'kit', 'Pixel art incoming. Give me ten minutes.'],
  [3, 'status', 'wren', null, 'Drafting venture one-pagers', 'working'],
  [2, 'log', 'poppy', null, 'Replied to 3 customer emails'],
  [3, 'status', 'penny', null, 'Waiting for a seat: month-end close', 'waiting'],
  [3, 'post', 'moss', null, 'Our logo, in 16 pixels'],
  [3, 'log', 'sable', null, 'Dependency audit: 0 criticals, 1 low'],
  [2, 'chat', 'sable', 'bolt', 'The coordinator lockfile looks clean. Nice.'],
  [3, 'status', 'dex', null, 'Out of usage, back at 06:00', 'sleeping'],
  [3, 'status', 'penny', null, 'Month-end close', 'working'],
  [3, 'chat', 'juno', 'penny', 'How are we doing on runway?'],
  [3, 'chat', 'penny', 'juno', 'Tidy. Numbers in Monday\'s digest.'],
  [3, 'status', 'tally', null, 'Queued for a seat: next review', 'waiting'],
  [4, 'status', 'dex', null, 'Packing the first orders', 'working'],
  [3, 'status', 'wren', null, null, 'idle'],
  [3, 'chat', 'juno', 'board', 'The weekly plan is ready for your review.'],
  [4, 'chat', 'quill', 'sable', 'Merged findings: two real issues, one false alarm.'],
  [3, 'status', 'flint', null, 'Codex seat is back, reviewing PR #12', 'working'],
  [3, 'chat', 'poppy', 'dex', 'A customer asks if the mug ships to Ghent.'],
  [3, 'chat', 'dex', 'poppy', 'It does. Tracking number is on its way.'],
  [3, 'post', 'kit', null, 'Week one in numbers'],
  [4, 'status', 'vera', null, 'Checking the new terms page', 'working'],
  [3, 'chat', 'wren', 'moss', 'Can the duck idea get a logo?'],
  [3, 'chat', 'moss', 'wren', 'Already sketching. It wears a tiny hard hat.'],
  [4, 'status', 'flint', null, 'Codex limit reached, back at 06:00', 'sleeping'],
  [3, 'status', 'vera', null, 'Usage limit reached, back at 04:00', 'sleeping'],
];

function fakeStream(onEvent, org) {
  const people = (org.departments || []).flatMap(d => d.agents || []), ids = new Set(people.map(a => a.id));
  const steps = SCRIPT.filter(s => ids.has(s[2]) && (!s[3] || ids.has(s[3])));
  if (!steps.length) return;
  // whoever is at work writes tokens, in bursts and lulls, sent every few seconds as the worker does (and has for the
  // last few minutes, as the coordinator's status would say)
  const tokens = new Map(people.filter(a => a.status?.state === 'working').map(a => [a.id, 0])),
    burst = () => Math.round(Math.random() ** 2 * 2400);
  for (const [agent] of tokens)
    for (let ago = 6 * 60_000; ago > 0; ago -= 10_000) {
      tokens.set(agent, tokens.get(agent) + burst() * 2);
      onEvent({ ts: new Date(Date.now() - ago).toISOString(), type: 'tokens', agent, total: tokens.get(agent) });
    }
  let i = 0;
  const next = () => {
    const [wait, type, agent, to, text, state, counts] = steps[i++ % steps.length];
    setTimeout(() => {
      if (type === 'status') if (state === 'working') tokens.set(agent, 0); else tokens.delete(agent);
      onEvent({ ts: new Date().toISOString(), type, agent, to: to || undefined, text, state, ...counts });
      next();
    }, wait * 1000);
  };
  next();
  setInterval(() => {
    for (const [agent, total] of tokens) {
      const now = total + burst();
      tokens.set(agent, now);
      onEvent({ ts: new Date().toISOString(), type: 'tokens', agent, total: now });
    }
  }, 4000);
}

// ---- an agent's model
// The models the board picks from (`seated`: a seat runs it) and each agent's main model and fallback; a pick answers
// at once, as the coordinator takes it in one step.
export const loadAgentModels = dev => (dev ? mockList('agent-models') : get('/api/agents/models'));
export async function setAgentModel(dev, agent, main, fallback) {
  if (!dev) return post('/api/agents/model', { agent, main, fallback });
  const list = await mockList('agent-models'), runner = id => { const c = list.choices.find(x => x.id === id); return c && `${c.engine}:${c.cli}`; };
  if (fallback && runner(fallback) === runner(main)) throw seatRefused('Pick a fallback at another provider: this one runs on the same seats.');
  const own = list.models[agent];
  Object.assign(own, { main: main ?? own.main, picked: main !== null, fallback });
  return { ok: true };
}

// ---- seats
// The worker's seats, the providers they run on and the board's actions on them. An action answers at once, and the
// seat's row then shows the worker carrying it out (its action and sign-in). Dev mode plays the worker on the mocks.
export const loadSeats = dev => (dev ? mockList('seats') : get('/api/seats'));
export const loadSeatProviders = dev => (dev ? mockList('seat-providers') : get('/api/seats/providers'));
const seatPost = (dev, action, body) => (dev ? mockSeatAction(action, body) : post(`/api/seats/${action}`, body));
// seat: { id, provider, key? }, or a service of the board's own: { id, provider: 'new', name, engine, url, model, key }
export const addSeat = (dev, seat) => seatPost(dev, 'add', seat);
export const removeSeat = (dev, seat) => seatPost(dev, 'remove', { seat });
export const pauseSeat = (dev, seat, paused) => seatPost(dev, 'pause', { seat, paused });
export const signInSeat = (dev, seat) => seatPost(dev, 'sign-in', { seat });
export const sendSeatCode = (dev, seat, code) => seatPost(dev, 'code', { seat, code });
export const sendSeatKey = (dev, seat, key) => seatPost(dev, 'key', { seat, key });
// the level a seat stops at (percent of its limits), and pacing for every seat
export const setSeatStop = (dev, seat, stop) => seatPost(dev, 'stop', { seat, stop });
export const setPacing = (dev, on) => seatPost(dev, 'pacing', { on });

// The mock worker: it takes an action up after a moment, works on it, then says how it went. A key or code that reads
// "wrong" fails, so the failures can be seen too. Keys are never kept.
const WORKER_MS = 1500;
const seatRefused = error => Object.assign(new Error('mock: 400'), { refusal: { error } });
const startAction = (row, what) => (row.action = { id: Date.now(), what, status: 'waiting', words: null, at: Date.now() });
function work(row, what, done) {
  const action = startAction(row, what);
  setTimeout(() => { action.status = 'working'; setTimeout(() => done(action), WORKER_MS); }, WORKER_MS);
}
const finish = (action, status, words) => Object.assign(action, { status, words, at: Date.now() });
async function mockSeatAction(action, body) {
  const rows = await mockList('seats'), setup = await mockList('seat-providers');
  if (action === 'add') return mockAdd(rows, setup, body);
  if (action === 'pacing') return mockPacing(setup, body.on);
  const row = rows.find(s => s.id === body.seat);
  if (!row || row.removing) throw seatRefused(`There’s no seat called ${body.seat}.`);
  if (action === 'remove') { row.removing = true; work(row, 'remove', () => rows.splice(rows.indexOf(row), 1)); }
  if (action === 'stop') work(row, 'stop', a => { row.stop = body.stop; finish(a, 'done', `Stops at ${body.stop}% of its limits now.`); });
  if (action === 'pause') work(row, body.paused ? 'pause' : 'resume', a => { Object.assign(row, { paused: body.paused, state: body.paused ? 'paused' : 'ready' });
    finish(a, 'done', body.paused ? 'Paused. It finishes its job and takes no new ones.' : 'Resumed. It takes work again.'); });
  if (action === 'key') {
    if (row.sign_in !== 'key') throw seatRefused(`${row.id} signs in with an account, not a key.`);
    work(row, 'key', a => mockKeyTested(row, a, body.key));
  }
  if (action === 'sign-in') {
    if (row.sign_in === 'key') throw seatRefused(`${row.id} runs on a key. Change its key instead.`);
    mockSignIn(row);
  }
  if (action === 'code') {
    if (row.signin?.status !== 'open' || row.signin.asks !== 'code') throw seatRefused(`${row.id} isn’t waiting for a code. Start its sign-in again.`);
    row.signin = { ...row.signin, status: 'checking', at: Date.now() };
    setTimeout(() => {
      const words = body.code.trim() === 'wrong' ? 'The sign-in tool said: Invalid code.' : `Signed in. ${row.id} takes work now.`, ok = !words.startsWith('The');
      row.signin = { status: ok ? 'done' : 'failed', asks: 'code', words, at: Date.now() };
      if (ok) Object.assign(row, { state: 'ready', note: null });
      finish(row.action, ok ? 'done' : 'failed', words);
    }, WORKER_MS * 2);
  }
  return { ok: true };
}
function mockSignIn(row) {
  startAction(row, 'sign-in').status = 'working';
  row.signin = { status: 'starting', asks: row.engine === 'claude' ? 'code' : 'nothing', at: Date.now() };
  setTimeout(() => {
    row.signin = row.engine === 'claude' ? { status: 'open', asks: 'code', url: 'https://claude.ai/oauth/authorize?code=true&client_id=mock', at: Date.now() }
      : { status: 'open', asks: 'nothing', url: 'https://auth.openai.com/codex/device', code: 'QRST-20517', at: Date.now() };
    if (row.engine !== 'claude') setTimeout(() => {   // (the board types the code on the provider's page, and the tool notices)
      row.signin = { ...row.signin, status: 'checking' };
      setTimeout(() => { row.signin = { status: 'done', asks: 'nothing', words: `Signed in. ${row.id} takes work now.`, at: Date.now() }; Object.assign(row, { state: 'ready', note: null }); finish(row.action, 'done', row.signin.words); }, WORKER_MS);
    }, WORKER_MS * 6);
  }, WORKER_MS);
}
function mockKeyTested(row, action, key) {
  const ok = key.trim() !== 'wrong';
  Object.assign(row, ok ? { state: 'ready', note: null } : { state: 'login', note: 'Needs a key' });
  finish(action, ok ? 'done' : 'failed', ok ? `The key works. ${row.id} takes work now.` : 'The service refused the key: it isn’t valid.');
}
function mockAdd(rows, setup, seat) {
  if (!/^[a-z]+-([0-9]+|[a-z]+)$/.test(seat.id ?? '')) throw seatRefused('A seat’s name is a lowercase word, a dash, then a number or another word, like claude-4 or mistral-1.');
  if (rows.some(s => s.id === seat.id)) throw seatRefused(`There’s a seat called ${seat.id} already. Pick another name.`);
  let provider = setup.providers.find(p => p.id === seat.provider);
  if (seat.provider === 'new') {
    if (!seat.name || !seat.url || !seat.model) throw seatRefused('A service of your own needs its name, its API address and its model.');
    provider = { id: seat.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name: seat.name, engine: 'codex', cli: seat.cli, sign_in: 'key', url: seat.url, model: seat.model, from: 'board' };
    setup.providers.push(provider);
  }
  if (!provider) throw seatRefused('Pick the service the seat runs on.');
  if (provider.sign_in === 'key' && !seat.key) throw seatRefused(`${provider.name} needs its key.`);
  const row = { id: seat.id, engine: provider.engine, cli: provider.cli, provider: provider.id, provider_name: provider.name, sign_in: provider.sign_in, stop: 90, paused: false,
    state: null, until: null, note: null, action: null, signin: null };
  rows.push(row);
  work(row, 'add', a => {
    if (provider.sign_in === 'key') return mockKeyTested(row, a, seat.key);
    Object.assign(row, { state: 'login', note: 'Waiting for the board to sign in' });
    finish(a, 'done', 'Added.');
    mockSignIn(row);
  });
  return { ok: true };
}
// ---- machines
// The machines the board lends for long runs, each live (the coordinator's runs.ts listMachines), the commands that set
// their helpers up, and the board's changes to them, which answer at once. Dev mode changes the mocks as the coordinator
// would.
export const loadMachines = dev => (dev ? mockList('machines') : get('/api/machines'));
export const loadMachineSetup = dev => (dev ? mockList('machine-setup') : get('/api/machines/setup'));
const machinePost = (dev, action, body) => (dev ? mockMachineAction(action, body) : post(`/api/machines/${action}`, body));
// (add answers with the new machine's id and its install command, its key in it, shown this once)
export const addMachine = (dev, name) => machinePost(dev, 'add', { name });
export const renameMachine = (dev, machine, name) => machinePost(dev, 'rename', { machine, name });
// (body and glow: its case's colour and its lights', as #rrggbb, or both null.)
export const colourMachine = (dev, machine, body, glow) => machinePost(dev, 'colour', { machine, body, glow });
export const pauseMachine = (dev, machine, paused) => machinePost(dev, 'pause', { machine, paused });
export const removeMachine = (dev, machine) => machinePost(dev, 'remove', { machine });
// (a new key, and the install command that carries it, shown this once)
export const newInstall = (dev, machine) => machinePost(dev, 'install', { machine });
async function mockMachineAction(action, body) {
  const list = await mockList('machines'), name = String(body.name ?? '').trim(), m = list.find(x => x.id === body.machine);
  if ((action === 'add' || action === 'rename') && (!name || name.length > 40)) throw seatRefused('A machine’s name is a line of at most 40 characters.');
  if ((action === 'add' || action === 'rename') && list.some(x => x.name.toLowerCase() === name.toLowerCase() && x.id !== body.machine)) throw seatRefused(`There’s a machine called ${name} already. Pick another name.`);
  if (action === 'add') {
    const id = Math.max(0, ...list.map(x => (typeof x.id === 'number' ? x.id : 0))) + 1;
    list.splice(list.length - 1, 0, { id, name, state: 'away', speed: null, cpus: null, memoryGb: null, gpu: null, gpuCount: 0, body: null, glow: null, kinds: [], paused: false, added: new Date().toISOString(), seen: null });
    return { ...(await mockList('machine-setup')), id, install: mockInstall(id) };
  }
  if (!m) throw seatRefused('There’s no such machine.');
  if (action === 'install') return { install: mockInstall(m.id) };
  if (action === 'rename') m.name = name;
  if (action === 'colour') Object.assign(m, { body: body.body, glow: body.glow });
  if (action === 'pause') Object.assign(m, { paused: body.paused, state: body.paused ? 'paused' : m.run ? 'running' : 'taking' });
  if (action === 'remove') list.splice(list.indexOf(m), 1);
  return { ok: true };
}
const mockInstall = id =>
  `docker run --rm --user 0:0 --entrypoint node -v /var/run/docker.sock:/var/run/docker.sock -v hq-example:/state -e MANAGER=install -e HQ_URL=https://hq.example -e HELPER_KEY=helper_MOCK${id} node:24.22.1-slim -e "fetch(process.env.HQ_URL+'/api/helper/manager')"`;
function mockPacing(setup, on) {
  const action = { id: Date.now(), what: 'pacing', status: 'waiting', words: null, at: Date.now() };
  setup.pacing = { on, action };
  setTimeout(() => finish(action, 'done', on ? 'Pacing is on.' : 'Pacing is off.'), WORKER_MS);
  return { ok: true };
}

// ---- Studio (studio.js): the product photos the board approves, from the coordinator's /api/studio routes
// A refusal arrives in plain words, as Care's do (act). A picture is only ever an <img>'s address: an edit's has its id,
// so a new edit of the same photo is a new address, and its original's too.
export const loadStudio = async dev => (dev ? copy(await studioState()) : get('/api/studio'));
export function studioPicture(dev, photo, side) {
  if (dev) return `mock/studio/${photo.mockPicture}-${side}.svg`;
  const id = Number(photo.id),
    edit = `&edit=${Number(photo.edit)}`;
  // (an original with its edit: the one that edit came from, the keeper's crop if any)
  return side === 'edited' ? `/api/studio/edited?id=${id}${edit}` : `/api/studio/original?id=${id}${photo.edit ? edit : ''}`;
}
// POST /api/studio/<what>: decide ({ photos: [{ id, edit }], decision: approved, declined or withdrawn, note }) → { decided },
// reject ({ photo: { id, edit }, note }: a waiting one declined and back to the keeper), change ({ photo: { id, edit },
// note }: an approved one off the sites and back to the keeper).
export const studioAction = (dev, what, body) => (dev ? mockStudioAction(what, body) : act(`/api/studio/${what}`, body));
// Dev mode plays the coordinator on mock/studio.json, in memory. A photo sent back develops again in a few seconds: new,
// then editing, then waiting. A mock photo's pictures are mock/studio/<its mockPicture>-original.svg and -edited.svg.
let studioMock = null;
const STUDIO_EDITING_MS = 2500, STUDIO_WAITING_MS = 9000;
async function studioState() {
  studioMock ??= await get('mock/studio.json');
  for (const p of studioMock.photos.filter(p => p.developing)) {
    const age = Date.now() - p.developing;
    if (age < STUDIO_EDITING_MS) continue;
    if (age < STUDIO_WAITING_MS) { p.status = 'editing'; continue; }
    Object.assign(p, { status: 'waiting', edited: new Date().toISOString(), edit: (p.edit ?? 0) + 1, tries: p.tries + 1, developing: undefined });
  }
  return studioMock;
}
async function mockStudioAction(what, body) {
  const s = await studioState(), find = id => s.photos.find(p => p.id === id);
  const decide = (p, decision) => Object.assign(p, { status: decision, decided: { decision, by: 'board', at: new Date().toISOString() } });
  if (what === 'decide' && body.decision === 'withdrawn') {
    const p = find(body.photos[0].id);
    if (p?.status !== 'approved') throw refused(409, 'Only an approved photo can be withdrawn.');
    decide(p, 'withdrawn');
    return { decided: 1 };
  }
  if (what === 'decide') {
    const waiting = body.photos.map(x => find(x.id)).filter(p => p?.status === 'waiting');
    for (const p of waiting) decide(p, body.decision);
    return { decided: waiting.length };
  }
  if (what === 'change') {
    const p = find(body.photo.id);
    if (p?.status !== 'approved') throw refused(409, 'Only an approved photo can change.');
    if (!String(body.note ?? '').trim()) throw refused(400, 'Say what should change.');
    Object.assign(p, { status: 'new', places: [], developing: Date.now() });
    return { ok: true };
  }
  if (what === 'reject') {
    const p = find(body.photo.id);
    if (p?.status !== 'waiting' || p.edit !== body.photo.edit) throw refused(409, 'That photo isn’t waiting any more: look at it again.');
    Object.assign(decide(p, 'declined'), { status: 'new', developing: Date.now() });
    return { ok: true };
  }
  throw refused(404, 'There’s no such studio action.');
}
