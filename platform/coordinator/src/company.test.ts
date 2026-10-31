// node --test src/company.test.ts   (HQ's brand, the CEO by org.yaml, the knowledge pages: the test company)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { harness } from './harness.ts';

// The test company with no brand yet, and HQ's own pages copied in (a test changes them) rather than linked
const real = (f: string) => new URL(`../../../${f}`, import.meta.url), fixture = (f: string) => new URL(`../fixture/${f}`, import.meta.url);
const h = await harness('company', { before: repo => {
  rmSync(`${repo}/company/brand.yaml`); rmSync(`${repo}/theme`, { recursive: true }); rmSync(`${repo}/platform`);
  mkdirSync(`${repo}/platform/hq`, { recursive: true });
  for (const f of ['index.html', 'manifest.webmanifest']) copyFileSync(real(`platform/hq/${f}`), `${repo}/platform/hq/${f}`);
} });
const { repo, board } = h;
const get = (cookie = h.boardCookie) => fetch(`${h.base}/api/brand`, { headers: { cookie } }).then(async r => ({ status: r.status, body: await r.json() }));
const page = (p: string, cookie = '') => fetch(h.base + p, { headers: { cookie }, redirect: 'manual' });

test('the brand is the board\'s to read: {} without brand.yaml or theme/hq.yaml, the company\'s values once they are there', async () => {
  assert.equal((await get('')).status, 401);
  assert.deepEqual((await get()).body, { brand: {}, theme: {}, care: false, studio: false });
  mkdirSync(`${repo}/theme`);
  copyFileSync(fixture('company/brand.yaml'), `${repo}/company/brand.yaml`);
  copyFileSync(fixture('theme/hq.yaml'), `${repo}/theme/hq.yaml`);
  const { body } = await get(), { brand, theme } = body;
  assert.equal(brand.name, 'Testco');
  assert.equal(brand.names.newsletter, 'the Gazette');
  assert.equal(brand.logo.pixels.length, 3);
  assert.equal(theme.renderer, 'wire');
  assert.equal(theme.style, 'pixel');
  // the company runs the care service once its plug-in is there (products/care, infra/products.py's CARE): HQ shows Care
  mkdirSync(`${repo}/products/care`, { recursive: true });
  writeFileSync(`${repo}/products/care/product.yaml`, 'name: Care\n');
  assert.equal((await get()).body.care, true);
  // and the photo studio once brand.yaml has its block
  assert.equal((await get()).body.studio, false);
  appendFileSync(`${repo}/company/brand.yaml`, '\nstudio: { keeper: bolt }\n');
  assert.equal((await get()).body.studio, true);
});

test("the company's style is theme/hq.yaml's word, none without one, and anything else an error", async () => {
  const { style } = await import('./style.ts');
  writeFileSync(`${repo}/theme/hq.yaml`, 'renderer: wire\n');
  assert.equal(style(), undefined);
  writeFileSync(`${repo}/theme/hq.yaml`, 'style: line\nrenderer: wire\n');
  assert.equal(style(), 'line');
  writeFileSync(`${repo}/theme/hq.yaml`, 'style: [pixel, line]\nrenderer: wire\n');
  assert.throws(() => style());
  copyFileSync(fixture('theme/hq.yaml'), `${repo}/theme/hq.yaml`);
});

test("each claimed job names the company's style and its craft note", async () => {
  const cases = [
    { theme: 'style: pixel', style: 'pixel', note: 'shared/craft/pixel-art.md' },
    { theme: 'style: line\nstyleNote: knowledge/notes/design/drawing-look.md', style: 'line', note: 'shared/craft/line-art.md' },
    { theme: 'style: paper\nstyleNote: knowledge/notes/design/paper.md', style: 'paper', note: 'knowledge/notes/design/paper.md' },
    { theme: '', style: 'none', note: 'shared/craft/pictures.md' },
  ];
  try {
    for (const sample of cases) {
      writeFileSync(`${repo}/theme/hq.yaml`, `renderer: wire\n${sample.theme}\n`);
      const job = await h.start({ agent: 'bolt' });
      const prompt = job.company.stylePrompt;
      assert.ok(prompt?.includes(`Company style: ${sample.style}`), sample.style);
      assert.ok(prompt.includes(sample.note), sample.note);
      assert.equal(prompt.split('\n').length, 1);
      if (sample.style === 'line') assert.ok(prompt.includes('knowledge/notes/design/drawing-look.md'));
      if (sample.style !== 'pixel') assert.doesNotMatch(prompt, /pixel|shared\/covers/);
      await h.finish(job);
    }
  } finally {
    copyFileSync(fixture('theme/hq.yaml'), `${repo}/theme/hq.yaml`);
  }
});

test("HQ's looks are its renderers' folders with a scene, dressed when they bring a skin, for the board only", async () => {
  const renderers = `${repo}/platform/hq/renderers`;
  mkdirSync(`${renderers}/plain`, { recursive: true });
  mkdirSync(`${renderers}/keys`);
  mkdirSync(`${renderers}/sketches`);
  for (const file of ['plain/scene.js', 'keys/scene.js', 'keys/skin.css', 'keys/sounds.js']) writeFileSync(`${renderers}/${file}`, '');
  const looks = (cookie = h.boardCookie) => fetch(`${h.base}/renderers/looks.json`, { headers: { cookie }, redirect: 'manual' });
  assert.deepEqual(await (await looks()).json(), [{ name: 'keys', dressed: true }, { name: 'plain', dressed: false }]);
  assert.notEqual((await looks('')).status, 200);
  rmSync(renderers, { recursive: true });
});

test("A company's tip films are the films and stills in its theme/hq/films, none without one, for the board only", async () => {
  const films = (cookie = h.boardCookie) => fetch(`${h.base}/films/films.json`, { headers: { cookie }, redirect: 'manual' });
  assert.deepEqual(await (await films()).json(), []);
  const folder = `${repo}/theme/hq/films`;
  mkdirSync(folder, { recursive: true });
  for (const file of ['look-wire.mp4', 'look-wire.jpg', 'look-wire.mp4.render.json']) writeFileSync(`${folder}/${file}`, '');
  assert.deepEqual(await (await films()).json(), ['look-wire.jpg', 'look-wire.mp4']);
  assert.notEqual((await films('')).status, 200);
  rmSync(folder, { recursive: true });
});

test('HQ\'s pages name the company before any script runs: index.html, the manifest, the login page and its logo', async () => {
  writeFileSync(`${repo}/platform/hq/acme-dark.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(`${repo}/company/brand.yaml`, `name: Acme
names: { hq: Studio }
app: { title: Acme Studio, description: 'Acme <live>', themeColour: '#102030' }
logo: { svg: acme.svg, svgDark: acme-dark.svg, alt: Acme }
`);
  const index = await (await page('/', h.boardCookie)).text();
  assert.match(index, /<meta name="theme-color" content="#102030">/);
  assert.match(index, /<meta name="description" content="Acme &#60;live&#62;">/);
  assert.match(index, /<title>Acme Studio<\/title>/);
  assert.match(index, /<img src="acme.svg" alt="Acme"/);
  const manifest = await (await page('/manifest.webmanifest')).json();
  assert.equal(manifest.name, 'Acme Studio');
  assert.equal(manifest.theme_color, '#102030');
  // (both logos: the light one on a light look's card, the dark on Holo's)
  assert.match(await (await page('/login')).text(),
    /<h1><img class="day" src="\/acme.svg" alt="Acme"[^>]*><img class="night" src="\/acme-dark.svg" alt="Acme"[^>]*> Studio<\/h1>/);
  assert.equal((await page('/acme-dark.svg')).status, 200);   // the login page's logo, so it's public
  writeFileSync(`${repo}/company/brand.yaml`, 'logo: { svgDark: api/org }\n');
  assert.equal((await page('/api/org')).status, 401);          // and only a logo is
  writeFileSync(`${repo}/company/brand.yaml`, 'name: [\n');
  assert.equal((await page('/login')).status, 200);            // a brand.yaml that doesn't parse can't lock the board out
});

test("the brand's colour is the title bar's and the guest page's accent, with readable letters, unless they name their own", async () => {
  writeFileSync(`${repo}/company/brand.yaml`, "colour: '#d6ea3c'\n");
  assert.match(await (await page('/', h.boardCookie)).text(), /<meta name="theme-color" content="#d6ea3c">/);
  assert.deepEqual((await get()).body.brand.guest.colours, { accent: '#d6ea3c', onAccent: '#000000' });
  writeFileSync(`${repo}/company/brand.yaml`, "colour: '#2f3a8f'\n");
  assert.deepEqual((await get()).body.brand.guest.colours, { accent: '#2f3a8f', onAccent: '#ffffff' });
  writeFileSync(`${repo}/company/brand.yaml`, "colour: '#d6ea3c'\napp: { themeColour: '#15171c' }\nguest: { colours: { accent: '#0969da' } }\n");
  const { brand } = (await get()).body;
  assert.equal(brand.app.themeColour, '#15171c');
  assert.deepEqual(brand.guest.colours, { accent: '#0969da' });
  rmSync(`${repo}/company/brand.yaml`);
});

test("a brand colour that isn't #rrggbb fails HQ's look loudly, naming it, and empties nothing else of brand.yaml", async t => {
  const said = t.mock.method(console, 'error', () => {});
  writeFileSync(`${repo}/company/brand.yaml`, "name: Acme\ncolour: '#47f'\nmail: { domain: example.com, boardOnly: [board] }\n");
  assert.equal((await get()).status, 500);
  assert.match(said.mock.calls.map(c => String(c.arguments[0]?.message ?? c.arguments[0])).join('\n'), /company\/brand\.yaml's colour "#47f" isn't #rrggbb/);
  assert.equal((await page('/login')).status, 200);
  // mail, jobs, care and calls read the file as it is (the board's own mail stays its own: mail.test.ts)
  const { brand, mailDomains } = await import('./company.ts');
  assert.deepEqual(brand().mail.boardOnly, ['board']);
  assert.deepEqual(mailDomains(), ['example.com']);
  rmSync(`${repo}/company/brand.yaml`);
});

test('a brand.yaml that doesn\'t parse, or whose mascots aren\'t a list of maps, can\'t stop the job queue or the brand', async () => {
  for (const yaml of ['name: [\n', 'mascots: 5\n', 'mascots: [~]\n']) {
    writeFileSync(`${repo}/company/brand.yaml`, yaml);
    await h.start({ agent: 'bolt' });   // (claimed: asserted)
    assert.equal((await get()).status, 200, yaml);
  }
});

test('another company\'s CEO (org.yaml\'s company.ceo) gets the intercom, the directives and the desk page, by name', async () => {
  writeFileSync(`${repo}/company/org.yaml`, readFileSync(`${repo}/company/org.yaml`, 'utf8').replace(/^(\s+ceo:) juno\b/m, '$1 kit'));
  writeFileSync(`${repo}/company/brand.yaml`, 'name: Acme\nnames: { phone: front desk }\n');
  await board('/api/chat', { text: 'What are we working on?' });
  const turn = (await h.claim('claude', { kind: 'chat' }))!;
  assert.equal(turn.agent, 'kit');
  assert.equal(turn.company.name, 'Acme', "the worker's brief says Acme");
  await h.finish(turn, { result: 'The launch.' });
  assert.equal((await board('/api/chat')).body.messages.at(-1).who, 'kit', "HQ shows the reply as the CEO's");
  assert.equal(h.job((await board('/api/jobs', { title: 'Plan the week' })).body.id).agent, 'kit');
  const desk = await page('/desk', h.boardCookie);
  assert.deepEqual([desk.status, desk.headers.get('location')], [302, '/?open=phone']);
});

test("a post's or note's relative pictures and links are fetched from its own folder under /knowledge/; the rest stay as written", async () => {
  const slug = '2026-10-01-a-picture', dir = `${repo}/knowledge/posts/${slug}`, topic = `${repo}/knowledge/notes/support`;
  mkdirSync(dir, { recursive: true }); mkdirSync(topic, { recursive: true }); mkdirSync(`${repo}/company/playbooks`, { recursive: true });
  copyFileSync(real('platform/hq/favicon-32.png'), `${dir}/burst.png`);
  writeFileSync(`${dir}/index.md`, '---\ntitle: A picture\nauthor: kit\n---\n![mid-burst](burst.png) and the [same](./burst.png#top), '
    + '![from the root](/knowledge/posts/x/y.png) ![web](https://example.com/a.png) ![inline](data:image/png;base64,AA==) '
    + '[up](#top) [mail](mailto:a@b.c) [the kit](../../notes/support/kit.md) `![code](not-a-picture.png)` '
    + '[a typo](https:) [no host](ftp:)\n');
  writeFileSync(`${topic}/kit.md`, '# Kit\n\n![a screen](screens/one.png) [guardrails](guardrails.md)\n');
  writeFileSync(`${repo}/company/playbooks/support.md`, '# Support\n\n[the kit](kit.md) ![a picture](p.png)\n');
  const api = async (p: string) => (await fetch(h.base + p, { headers: { cookie: h.boardCookie } })).json();
  const post = (await api('/api/gazette')).find((p: { slug: string }) => p.slug === slug);
  const at = `/knowledge/posts/${slug}`;
  for (const s of [`<img src="${at}/burst.png" alt="mid-burst">`, `<a href="${at}/burst.png#top">`, '<img src="/knowledge/posts/x/y.png"',
    '<img src="https://example.com/a.png"', '<img src="data:image/png;base64,AA=="', '<a href="#top">', '<a href="mailto:a@b.c">',
    '<a href="/knowledge/notes/support/kit.md">', '<code>![code](not-a-picture.png)</code>', '<a href="https:">', '<a href="ftp:">'])
    assert.ok(post.html.includes(s), `${s} in ${post.html}`);
  // the picture loads from there, through the server's own route
  const img = await page(`${at}/burst.png`, h.boardCookie);
  assert.equal(img.status, 200);
  assert.deepEqual(new Uint8Array(await img.arrayBuffer()), new Uint8Array(readFileSync(real('platform/hq/favicon-32.png'))));
  // a phone's photo by its own name, and a .jpeg, load too (types.ts: one table, any case)
  for (const f of ['IMG_1234.JPG', 'photo.jpeg']) {
    copyFileSync(real('platform/hq/favicon-32.png'), `${dir}/${f}`);
    const r = await page(`${at}/${f}`, h.boardCookie);
    assert.deepEqual([r.status, r.headers.get('content-type')], [200, 'image/jpeg'], f);
  }
  // a screenshot's name with a space or an accent, a stray %: the src HQ renders loads it (the server reads it as the review does)
  const names = ['Screenshot 2026-10-01 at 09.41.png', 'café.png', '100%.png'];
  for (const f of names) copyFileSync(real('platform/hq/favicon-32.png'), `${dir}/${f}`);
  writeFileSync(`${dir}/index.md`, '---\ntitle: A picture\nauthor: kit\n---\n![shot](<Screenshot 2026-10-01 at 09.41.png>) ![cafe](café.png) ![all](100%.png)\n');
  const srcs = [...(await api('/api/gazette')).find((p: { slug: string }) => p.slug === slug).html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(srcs.length, names.length, srcs.join(' '));
  for (const src of srcs) assert.equal((await page(src, h.boardCookie)).status, 200, src);
  // decoding opens no way out of the folder: an encoded ../ to a picture next to it, or a NUL, is not found
  writeFileSync(`${repo}/secret.png`, 'x');
  for (const p of ['/knowledge/..%2fsecret.png', '/knowledge/%2e%2e%2fsecret.png', `${at}/..%2f..%2f..%2fsecret.png`, '/cycles/..%2f..%2fsecret.png',
    `${at}/burst.png%00.png`])
    assert.equal((await fetch(h.base + p, { headers: { cookie: h.boardCookie } })).status, 404, p);
  // a note's from its topic's folder; the handbook's, whose folder isn't served, as written
  const docs = await api('/api/library'), doc = (p: string) => docs.find((d: { path: string }) => d.path === p).html;
  assert.match(doc('knowledge/notes/support/kit.md'), /<img src="\/knowledge\/notes\/support\/screens\/one\.png" alt="a screen"> <a href="\/knowledge\/notes\/support\/guardrails\.md">/);
  assert.match(doc('company/playbooks/support.md'), /<a href="kit\.md">the kit<\/a> <img src="p\.png"/);
});

test('a team member sits in its lead\'s department, with its lead named as HQ shows them (staff or team member)', async () => {
  const lead = await h.start({ agent: 'wren', title: 'A team' });   // a team is a running job's
  const join = (id: string, name: string, parent: string) => h.worker('team', { job: lead.id, lead: 'wren', id, name, parent, state: 'working' });
  await join('fern', 'Fern', 'wren');
  await join('channel-groundwork', 'Channel groundwork', 'fern');   // no name of its own
  await join('ash', 'Ash', 'channel-groundwork');
  const studio = (await board('/api/org')).body.departments.find((d: { id: string }) => d.id === 'studio');
  // (a plain title, the lead in its focus)
  const roles = Object.fromEntries(studio.agents.map((a: { id: string; role: string; focus?: string }) => [a.id, [a.role, a.focus]]));
  assert.deepEqual(roles.fern, ['Team member', 'with Wren']);
  assert.deepEqual(roles['channel-groundwork'], ['Team member', 'with Fern']);
  assert.deepEqual(roles.ash, ['Team member', 'with Channel groundwork']);
});

test('an agent\'s focus (org.yaml) goes to HQ beside its plain title, and into its prompts after it', async () => {
  const { titleOf } = await import('./company.ts'), { findAgent } = await import('./jobs.ts');
  const org = `${repo}/company/org.yaml`, before = readFileSync(org, 'utf8');
  writeFileSync(org, before.replace('role: Head of Studio,', 'role: Head of Studio, focus: "films and decks",'));
  try {
    const wren = (await board('/api/org')).body.departments.flatMap((d: { agents: object[] }) => d.agents).find((a: { id: string }) => a.id === 'wren');
    assert.deepEqual([wren.role, wren.focus], ['Head of Studio', 'films and decks']);
    assert.equal(titleOf(findAgent('wren')!), 'Head of Studio (films and decks)');
    assert.equal(titleOf(findAgent('moss')!), 'Creative Director');   // (none: the title alone)
    // the worker's briefing reads the title as the claim sends it
    const job = await h.start({ agent: 'wren', title: 'A title with its focus' });
    assert.equal(job.agentInfo.role, 'Head of Studio (films and decks)');
  } finally { writeFileSync(org, before); }
});

test('a team member\'s card says what it\'s doing: its task, or for one its lead only named, its latest step; never a look', async () => {
  const lead = await h.start({ agent: 'wren', title: 'Two members' });
  await h.worker('team', { job: lead.id, lead: 'wren', id: 'quoin', name: 'quoin', parent: 'wren', state: 'working', task: 'The formats kit\'s tests' });
  await h.worker('team', { job: lead.id, lead: 'wren', id: 'burnish', name: 'burnish', parent: 'wren', state: 'working', task: '' });
  const card = async (id: string) => (await board('/api/org')).body.departments.find((d: { id: string }) => d.id === 'studio').agents.find((a: { id: string }) => a.id === id);
  assert.equal((await card('burnish')).status.task, undefined);   // nothing done yet: HQ says nothing's on the desk
  for (const text of ['Reading worker.ts', 'Running the coordinator\'s tests'])
    assert.equal((await h.agent('step', lead.token, { text, as: 'burnish' })).status, 200);
  await h.agent('step', lead.token, { text: 'Reading team.ts', as: 'quoin' });
  const named = await card('burnish'), tasked = await card('quoin');
  assert.deepEqual([named.status.task, named.steps, named.look], ['Running the coordinator\'s tests', true, undefined]);
  assert.deepEqual([tasked.status.task, tasked.steps, tasked.look], ['The formats kit\'s tests', undefined, undefined]);
});

test('the company\'s clock goes to HQ as the coordinator reads it: UTC when org.yaml names none, an error for a name that isn\'t a zone', async () => {
  const { timeZone } = await import('./company.ts');
  const org = `${repo}/company/org.yaml`, before = readFileSync(org, 'utf8');
  try {
    assert.equal((await board('/api/org')).body.company.timeZone, 'Europe/Amsterdam');
    writeFileSync(org, before.replace(/^\s+timeZone:.*\n/m, ''));
    assert.equal(timeZone(), 'UTC');
    writeFileSync(org, before.replace('Europe/Amsterdam', 'Europe/Amsterdm'));
    assert.throws(timeZone, /Europe\/Amsterdm/);
    assert.equal((await board('/api/org')).status, 500);
  } finally { writeFileSync(org, before); }
});

test("an agent's voice on calls is org.yaml's, else one fitting their pronouns, else the line's default", async () => {
  const org = `${repo}/company/org.yaml`, before = readFileSync(org, 'utf8');
  writeFileSync(org, before.replace('name: Kit,', 'name: Kit, pronouns: she/her,').replace('name: Dex,', 'name: Dex, pronouns: He/Him,')
    .replace('name: Penny,', 'name: Penny, pronouns: they/them,').replace('name: Wren,', 'name: Wren, pronouns: he/him,'));
  try {
    const voice = async (agent: string) => (await h.voice('call-context', { agent, lang: 'en' })).body.voice;
    assert.deepEqual([await voice('kit'), await voice('dex'), await voice('penny'), await voice('moss'), await voice('wren')],
      ['jane', 'alba', null, 'paul', 'jane']);
  } finally { writeFileSync(org, before); }
});

test('an edited org.yaml or note is what HQ shows next, even at the same size', async () => {
  const org = `${repo}/company/org.yaml`, note = `${repo}/company/playbooks/support.md`;
  writeFileSync(note, '# Support\n\nThe first words.\n');
  assert.match((await board('/api/library')).body.find((d: { path: string }) => d.path === 'company/playbooks/support.md').html, /first/);
  const wren = async () => (await board('/api/org')).body.departments.flatMap((d: { agents: { id: string; name: string }[] }) => d.agents)
    .find((a: { id: string }) => a.id === 'wren').name;
  assert.equal(await wren(), 'Wren');
  writeFileSync(org, readFileSync(org, 'utf8').replace('name: Wren,', 'name: Wran,'));
  writeFileSync(note, '# Support\n\nThe other words.\n');
  assert.equal(await wren(), 'Wran');
  assert.match((await board('/api/library')).body.find((d: { path: string }) => d.path === 'company/playbooks/support.md').html, /other/);
});

// (the old addresses' redirect gone once every page had reloaded)
test("HQ's files are served where they are: shell/ and shell/ink/ each its own, an old address before shell/ink/ a 404", async () => {
  mkdirSync(`${repo}/platform/hq/shell/ink`, { recursive: true });
  writeFileSync(`${repo}/platform/hq/shell/booktips.js`, 'export {};\n');
  writeFileSync(`${repo}/platform/hq/shell/ink/book.js`, 'export {};\n');
  assert.equal((await page('/shell/booktips.js', h.boardCookie)).status, 200, 'the tips book, in shell/');
  assert.equal((await page('/shell/ink/book.js', h.boardCookie)).status, 200, "Ink's book, in shell/ink/");
  const old = await page('/shell/book.js', h.boardCookie);
  assert.deepEqual([old.status, old.headers.get('location')], [404, null], 'no redirect to shell/ink/');
});
