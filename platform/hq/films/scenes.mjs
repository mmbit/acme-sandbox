// The feature tips' films, scene by scene (tip-films.mjs records them): for each tip with a film, where it starts (the
// place its Show me opens, unrecorded), the part of the screen it shows, and a finger using the feature once, on dev
// mode's sample data. A tip whose screen changes gets its scene changed here, then its films again.

// A plain sample page for an artifact's preview (the films show HQ, not a product)
export const PREVIEW = `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;font:18px/1.5 system-ui;
  background:#f4efe6;color:#2a2620"><header style="padding:28px 40px;background:#2a2620;color:#f4efe6;font-weight:700">Sample shop</header>
  <main style="padding:40px;display:grid;grid-template-columns:repeat(3,1fr);gap:24px">${[1, 2, 3, 4, 5, 6]
    .map(
      i =>
        `<div><div style="aspect-ratio:1;border-radius:14px;background:hsl(${30 + i * 40} 45% 72%)"></div><p>Sample ${i}</p></div>`,
    )
    .join('')}</main></body>`;

// Each tip's film: where it starts (unrecorded: the place its Show me opens), the part of the screen it shows, and the
// feature used once. clip: a selector whose box the film shows, a function giving one (from a control's box), or null
// for the whole screen, at its own scale. device: what the page's device can do (an init script), api: stand-ins for the
// coordinator's answers and dev mode's mock files, by path (an answer, or one made from the request's body).
// still: the moment (seconds in) the Library's manual shows as the film's tile, for the four tiled there (manual.js).
const comp = (app, opts = {}) =>
  `import('/shell/desk.js').then(m => m.openComputer(${JSON.stringify(app)}, ${JSON.stringify(opts)}))`;
const TOOL = '#tool .device';
// a notes share with two people on a preview, one still to send (the moment End now matters), in dev mode's store
const share = `import('/shell/data.js').then(async data => {
  const page = 'https://front.preview.example.com/';
  await data.makeShare(true, { page, name: 'Ilse', email: 'ilse@example.com', days: 3 });
  const s = await data.makeShare(true, { page, name: 'Joris', email: 'joris@example.com', days: 3 });
  Object.assign(s.people[0], { opened: new Date().toISOString(), sent: new Date().toISOString(), notes: 6 });
  Object.assign(s.people[1], { opened: new Date().toISOString() });
  Object.assign(s, { owner: 'Kit', notes: 6 });
})`;
// the intercom, with the CEO's dev-mode reply as the film's own
const intercom = reply => async hq => {
  await hq.page.click('#btn-intercom');
  await hq.eval(`import('/shell/data.js').then(d => d.loadChat(true)).then(chat => {
    chat.messages.push = function (m) { if (m.who !== 'board') m.text = ${JSON.stringify(reply)}; return Array.prototype.push.call(this, m); };
  })`);
};
// (the intercom reads the conversation every 3 s: the reply shows within 4.5 s of Send)
const ask = words => async hq => {
  await hq.wait(0.4);
  await hq.type(words, '#dir-title', 18);
  await hq.wait(0.2);
  await hq.tap('#tool .device.intercom button.send, #dir-send, .device.intercom button:has-text("Send")');
  await hq.wait(4.5);
};
// (the intercom's lower part, where the conversation grows)
const INTERCOM = async box => {
  const d = await box('.device.intercom');
  return { x: d.x, y: d.y + d.height - 340, width: d.width, height: 340 };
};
// HQ's pin, inside review mode's layer (tips.js)
const pin = () => {
  const ask = new CustomEvent('review:pin', { detail: {} });
  dispatchEvent(ask);
  return ask.detail.pin ?? null;
};
// a device that can take notifications, not yet asked
const PUSH_DEVICE = () => {
  let sub = null;
  const pushManager = {
    getSubscription: async () => sub,
    subscribe: async () =>
      (sub = {
        endpoint: 'https://push.example.com/1',
        options: {},
        toJSON: () => ({ endpoint: sub.endpoint }),
        unsubscribe: async () => (sub = null),
      }),
  };
  const reg = { pushManager };
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register: async () => reg, getRegistration: async () => reg, addEventListener() {}, controller: null },
  });
  window.PushManager ??= function PushManager() {};
  let permission = 'default';
  window.Notification = Object.defineProperties(function Notification() {}, {
    permission: { get: () => permission },
    requestPermission: { value: async () => (permission = 'granted') },
  });
};
const LOOK_NEXT = { wire: 'brownstone', brownstone: 'holo', holo: 'wire' };

export const FILMS = {
  artifact: {
    still: 4.5,
    // (dev mode's notes with the preview's product and whose it is, for the share box to name both)
    api: { '/mock/review.json': { products: [{ slug: 'front', name: 'Sample shop', ownerName: 'Kit' }], notes: [] } },
    start: async hq => {
      await hq.eval(comp('artifacts'));
      await hq.until(() => document.querySelector('#tool .applist a.open'));
      await hq.page.click('#tool .applist a.open');
    },
    // (the viewer's top right, where Share opens its box)
    clip: async box => {
      const bar = await box('#viewer .bar');
      return { x: bar.x + bar.width - 560, y: 0, width: 560, height: 440 };
    },
    play: async hq => {
      await hq.wait(0.8);
      await hq.tap('#viewer .bar .share');
      await hq.wait(0.6);
      await hq.type('Ilse', '#viewer .sharebox form.invite [name=name]');
      await hq.type('ilse@example.com', '#viewer .sharebox form.invite [name=email]');
      await hq.wait(0.2);
      await hq.tap('#viewer .sharebox form.invite button');
      await hq.wait(2.2);
    },
  },
  endnow: {
    start: async hq => {
      await hq.eval(share);
      await hq.eval(comp('notes', { shown: 'shared' }));
    },
    clip: TOOL,
    play: async hq => {
      await hq.wait(0.8);
      await hq.tap('#tool section.share summary');
      await hq.wait(1);
      await hq.tap('#tool section.share [data-end]');
      await hq.wait(0.8);
      await hq.tap('#tool section.share [data-end]');
      await hq.wait(2.2);
    },
  },
  machines: {
    still: 0.6,
    start: hq => hq.eval(comp('settings', { section: 'sys:machines' })),
    clip: TOOL,
    play: async hq => {
      await hq.wait(1);
      await hq.tap('#tool :text("+ Add a machine")');
      await hq.wait(0.6);
      await hq.type('The study’s desktop', '#tool input');
      await hq.wait(0.3);
      await hq.tap('#tool button:has-text("Add machine")');
      await hq.wait(2.4);
    },
  },
  look: {
    still: 0.6,
    start: hq => hq.eval(comp('settings', { section: 'sys:look' })),
    clip: null,
    scale: 0.6,
    play: async (hq, look) => {
      await hq.wait(0.8);
      await hq.tap(`#tool [data-look="${LOOK_NEXT[look]}"]`);
      await hq.wait(2.4);
      await hq.tap(`#tool [data-look="${look}"]`);
      await hq.wait(1.6);
    },
  },
  pin: {
    // (review mode's layer opened, so the film's finger finds the note's box in it)
    device: () => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        return attach.call(this, { ...init, mode: 'open' });
      };
    },
    // (the book: today's, with nobody's page yet, and the note going on the page it makes)
    api: {
      '/api/book': { pages: [] },
      '/api/book/sheets': { open: [] },
      '/api/book/page/new': { id: 1 },
      '/api/book/note': note => ({ note: { ...note, id: 1, n: 1, by: null, slips: [] } }),
    },
    // (and the org, whose CEO the note is for: answered only once HQ is on its mock data, which an answer before ends)
    start: hq => hq.page.route('**/api/org', r => r.fulfill({ json: { company: { ceo: 'ceo' }, departments: [] } })),
    clip: null,
    scale: 0.6,
    play: async hq => {
      await hq.wait(0.5);
      await hq.tap('#book .bk-lip'); // (folded in the films: opened beside HQ, the book brings the pin, pinsummon.js)
      await hq.wait(1);
      await hq.tap(pin);
      await hq.wait(0.6);
      await hq.tap([520, 150]);
      await hq.wait(0.8);
      await hq.tap('textarea >> visible=true');
      await hq.type('Make this title bigger', null, 16);
      await hq.wait(0.4);
      await hq.tap('button:has-text("Send") >> visible=true');
      await hq.wait(1.2);
    },
  },
  notifications: {
    still: 0.6,
    device: PUSH_DEVICE,
    api: {
      '/api/push/key': { key: 'BKey', devices: 1 },
      '/api/push/subscribe': { ok: true },
      '/api/push/test': { sent: true },
    },
    start: hq => hq.eval(comp('settings', { section: 'sys:alerts' })),
    clip: TOOL,
    play: async hq => {
      await hq.wait(1);
      await hq.tap('#tool [data-push="on"]');
      await hq.wait(1.4);
      await hq.tap('#tool [data-push="test"]');
      await hq.wait(2.4);
    },
  },
  calls: {
    // (its card from the company's CEO, someone in the building in every look: dev mode's cards are the platform's sample
    // team's, whom a company's own mock org may not have)
    start: async hq => {
      await hq.eval(`Promise.all([import('/shell/data.js').then(d => d.loadRequests(true)), fetch('mock/org.json').then(r => r.json())])
        .then(([cards, org]) => Object.assign(cards.find(r => r.id === 11), { agent: org.company.ceo }))`);
      await hq.eval(`import('/shell/desk.js').then(m => m.openPhone(11))`);
      await hq.until(() => document.querySelector('#call-about'));
    },
    clip: '#phone-screen',
    play: async hq => {
      await hq.wait(0.8);
      await hq.tap('#call-about');
      await hq.wait(1.2);
      hq.line({ type: 'call', id: 'film', call: 1, key: 'film' });
      hq.line({ type: 'state', state: 'listening' });
      await hq.wait(0.8);
      hq.line({ type: 'heard', text: 'Register now, before the first sale.' });
      hq.line({ type: 'state', state: 'thinking' });
      await hq.wait(0.8);
      hq.line({ type: 'state', state: 'speaking' });
      hq.line({ type: 'said', text: 'Good. I’ll register us this week.' });
      await hq.wait(2.4);
    },
  },
  pausing: {
    start: intercom('Paused. The shop’s redesign waits until Monday morning, then picks up where it stopped.'),
    clip: INTERCOM,
    scale: 1.6,
    play: ask('Pause the shop’s redesign till Monday'),
  },
  seats: {
    start: hq => hq.eval(comp('settings', { section: 'sys:seats' })),
    clip: TOOL,
    play: async hq => {
      await hq.wait(1);
      await hq.tap('#tool .seats li:first-child button');
      await hq.wait(1);
      await hq.tap('#tool button:has-text("85%")');
      await hq.wait(2.4);
    },
  },
  asking: {
    start: intercom('Done. Every Monday at nine, the week’s sales come to your desk phone.'),
    clip: INTERCOM,
    scale: 1.6,
    play: ask('Every Monday, send me the week’s sales'),
  },
};
