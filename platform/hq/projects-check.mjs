#!/usr/bin/env node
// node platform/hq/projects-check.mjs (all looks on phone and tablet, screenshots in a temp folder)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from './serve.mjs';
import { playwright, errorsOf, tap, until } from '../../shared/browser/browser.mjs';

const RENDERERS = ['brownstone', 'holo', 'wire'];
// an agent's title that looks like markup is shown as text: one more job in the office's care thread
const own = name => readFileSync(new URL(`./mock/${name}.json`, import.meta.url));
const board = JSON.parse(own('projects')),
  care = board.projects[1].threads[1];
// a cover on the shopfront and its sticker shop, none on the office and the newsletter
const COVER = 'mock/covers/2026-09-25-we-have-a-building.svg';
// a deliverable's name on its project's tile, after its bars
const DELIVERABLE = '.pj-deliverables li > span:not(.pj-pulse)';
// a tile or a row that opens, by its tap target's attribute: its box, the words beside its cover button (prose.js covered:
const box = attr => `.covered:has(> ${attr})`;
board.businesses[0].cover = COVER;
board.projects[0].cover = COVER;
care.jobs.push({
  ...care.jobs[0],
  id: 30,
  agent: 'kit',
  title: 'Fix <img src=x onerror=alert(1)> in the footer',
  status: 'running',
  ready: 0,
});
// a task whose title names another job: that job's number a link
care.jobs.push({
  ...care.jobs[0],
  id: 33,
  agent: 'kit',
  title: 'Send the late-parcel replies once #45 is merged',
  status: 'queued',
});
// a finished banner's review that waits for the board, card 96 (the gift wrap's finished job has one under way)
const banners = board.projects[2].threads[0];
banners.jobs.push({
  ...banners.jobs[1],
  id: 59,
  agent: 'quill',
  title: 'Banner for the building post',
  step: 'Weighing the reviews',
  round: 1,
  status: 'blocked',
  review: 1,
  branch: 'job/44',
  request: 96,
  request_title: 'Pebblet’s test posters arrived',
  finished: null,
});
// a paused project and a paused thread
board.projects[2].pause = {
  why: 'Hold the newsletter until the shop opens',
  by: 'wren',
  at: '2026-10-17T06:00:00.000Z',
  until: [{ id: 41, agent: 'kit', title: 'Pick a domain for the sticker shop', state: 'waiting for the board' }],
};
board.projects[1].threads[0].pause = {
  why: 'Backups wait for the new disk',
  by: 'wren',
  at: '2026-10-17T06:00:00.000Z',
  until: [],
};
// a second done thread of the newsletter's, its one job a finished check, never closed,
// made after the first issue but finished before it
const proofs = {
  ...board.projects[2].done[0],
  id: 'news/proofs',
  name: 'The proofs',
  status: 'open',
  created: '2026-10-01T09:00:00Z',
  jobs: 1,
  done: 1,
  finished: '2026-10-05T12:00:00Z',
};
board.projects[2].done.push(proofs);
const threads = JSON.parse(own('threads')),
  launched = threads['news/launch'];
threads['news/proofs'] = {
  ...launched,
  id: 'news/proofs',
  name: 'The proofs',
  jobs: [{ ...launched.jobs[0], id: 36, title: 'Proofs read', check: 1, thread: 'news/proofs', result: 'Two typos' }],
};
threads[banners.id] = {
  ...banners,
  jobs: banners.jobs.map(j => ({ ...j, status: 'done', request: null, finished: '2026-10-19T09:00:00Z' })),
};
// the platform's mock org, jobs, schedule and cards (the dev server's own are the company's), so every face is the look's portrait.
const files = {
  'mock/projects.json': Buffer.from(JSON.stringify(board)),
  'mock/threads.json': Buffer.from(JSON.stringify(threads)),
  'mock/org.json': own('org'),
  'mock/jobs.json': own('jobs'),
  'mock/schedule.json': own('schedule'),
  'mock/requests.json': own('requests'),
};
const server = await serve(undefined, 0, files),
  base = `http://localhost:${server.address().port}`;
const out = mkdtempSync(join(tmpdir(), 'projects-check-')),
  browser = await playwright().chromium.launch();
const texts = (page, sel) => page.$$eval(sel, els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
// The header: the logo whole and the tools clear of it, and on a phone the tools in at most two rows beside it over the
// projects, so they start high
async function header(page, at, phone, projects = false) {
  const h = await page.evaluate(() => {
    const box = s => document.querySelector(s).getBoundingClientRect(),
      b = box('#hud .brand'),
      // Wire can render the logo inline while hiding its image.
      logo = [...document.querySelectorAll('#hud .brand :is(img, svg.logo)')]
        .map(e => e.getBoundingClientRect())
        .find(r => r.width) ?? { width: 0 },
      tools = [...document.querySelectorAll('#hud .tools > *')]
        .filter(e => e.offsetParent)
        .map(e => e.getBoundingClientRect());
    const word = document.querySelector('#hud .brand b');
    return {
      logo: logo.width > 0 && logo.left >= b.left - 0.5 && logo.right <= b.right + 0.5,
      word: !word.offsetParent || word.scrollWidth <= word.clientWidth + 1,
      clear: tools.every(t => t.left >= b.right),
      rows: new Set(tools.map(t => Math.round(t.top))).size,
      bottom: box('#hud').bottom,
    };
  });
  assert.ok(h.logo && h.word && h.clear, `${at}: the logo whole, the tools clear of it (${JSON.stringify(h)})`);
  if (phone && projects)
    assert.ok(
      h.rows <= 2 && h.bottom < 130,
      `${at}: the tools in two rows at most, the header low (${JSON.stringify(h)})`,
    );
}

for (const look of RENDERERS)
  for (const [w, h, device] of [
    [390, 844, 'phone'],
    [1180, 820, 'tablet'],
  ]) {
    const page = await browser.newPage({
      viewport: { width: w, height: h },
      hasTouch: device === 'phone',
      isMobile: device === 'phone',
    });
    const errors = errorsOf(page);
    await page.goto(`${base}/?intro=0&renderer=${look}`);
    await until(page, '#loading.gone');
    const at = `${look}, ${device}`,
      // (after a level's entrance, which starts it see-through)
      shot = name =>
        page.waitForTimeout(500).then(() => page.screenshot({ path: `${out}/${look}-${device}-${name}.png` }));
    // nothing off the screen: no key, the view or the open job wider than the page
    const offScreen = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#projects :is(.pj-modal, .pj-tile, .pj-head, .pj-card)')]
          .filter(e => {
            const r = e.getBoundingClientRect();
            return r.width && (r.left < -1 || r.right > innerWidth + 1);
          })
          .map(e => e.className),
      );
    // calm: nothing in the look's red, whatever the state
    const reds = () =>
      page.evaluate(() => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--red)';
        document.querySelector('#projects').append(probe);
        const red = getComputedStyle(probe).color;
        probe.remove();
        return [...document.querySelectorAll('#projects *')]
          .filter(e => [getComputedStyle(e).color, getComputedStyle(e).backgroundColor].includes(red))
          .map(e => e.className || e.tagName);
      });
    // the board never reads a job's number, and nothing is underlined
    const plain = () =>
      page.evaluate(() => ({
        numbers: document.querySelector('#projects').innerText.match(/#\d+/g) ?? [],
        underlined: [...document.querySelectorAll('#projects *')]
          .filter(e => getComputedStyle(e).textDecorationLine.includes('underline'))
          .map(e => e.className || e.tagName),
      }));
    // tiles' covers: the picture's file, or the fallback's initial; and the bars over each one's cover, a voice for each
    // job running
    const covers = tiles =>
      page.$$eval(`${tiles} .pj-art .pj-cover`, c =>
        c.map(e => e.querySelector('img')?.getAttribute('src') ?? e.textContent),
      );
    const bars = tiles =>
      page.$$eval(tiles, t =>
        t.map(e =>
          [...e.querySelectorAll('.pj-art > .pj-pulse')].map(p =>
            p.querySelectorAll('.pj-voice').length === Number(p.ariaLabel.split(' ')[0]) ? p.ariaLabel : 'miscounted',
          ),
        ),
      );
    // tiles' marks: what waits on the board or is paused, by its name on hover
    const marks = tiles => page.$$eval(tiles, t => t.map(e => e.querySelector('.pj-mark')?.title ?? ''));
    const title = () => page.$eval('.pj-head h1', e => e.firstChild.textContent);
    // a level's keys are in once its entrance is over
    const level = name =>
      page.waitForFunction(n => document.querySelector('.pj-head h1')?.firstChild.textContent === n, name);
    // a sideways drag on the level, as a finger's
    const swipe = async dx => {
      // (the last one's entrance, however long it takes on a loaded machine)
      await page.waitForFunction(
        () =>
          !document
            .querySelector('#projects')
            .getAnimations({ subtree: true })
            .some(a => a.playState === 'running' && a.effect.getTiming().iterations !== Infinity),
      );
      // (and a measured level: right after a screenshot holo's can read as all zeros once), pressed off its keys, where
      // the drag stays on the screen: a press on one that a loaded machine holds still past the sort's hold lifts it
      const { x, y } = await (
        await page.waitForFunction(dx => {
          const r = document.querySelector('.pj-level').getBoundingClientRect();
          for (let y = r.top + 4; r.width > 0 && y < Math.min(r.bottom, innerHeight); y += 4)
            for (let x = r.left + r.width / 2, d = 0; d < r.width / 2; d += 4)
              for (const at of [x - d, x + d]) {
                const e = document.elementFromPoint(at, y);
                const free = e?.closest('.pj-level') && !e.closest('[data-sort], button, a');
                if (free && at + dx > 8 && at + dx < innerWidth - 8) return { x: at, y };
              }
          return false;
        }, dx)
      ).jsonValue();
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(x + (dx * i) / 6, y + 2);
      await page.mouse.up();
    };

    // HQ opens on the agents view, with no switch beside the logo: the HUD's Projects key opens the projects view, the
    // desktop has no app for it
    assert.equal(await page.$('#views'), null, `${at}: no switch`);
    assert.ok(await page.$eval('#projects', e => e.hidden), `${at}: the projects view is hidden at first`);
    await header(page, at, device === 'phone');
    await tap(page, '#btn-computer');
    await page.waitForSelector('[data-app=notes]');
    assert.deepEqual(await page.$$('[data-app=projects], [data-app=jobs]'), [], `${at}: no Projects or Jobs app`);
    await tap(page, '#tool [data-close]');
    await page.waitForSelector('#tool', { state: 'hidden' });
    // (the logo's width aside: its clock may turn a minute in between.)
    const hudBoxes = () =>
      page.$$eval('#hud .brand, #hud .tools > *', els =>
        els
          .filter(e => e.offsetParent)
          .map(e => {
            const { x, y, width, height } = e.getBoundingClientRect();
            return [e.id, x, y, e.id ? width : null, height];
          }),
      );
    const before = await hudBoxes();
    await tap(page, '#btn-projects');
    await page.waitForSelector('[data-business]');
    assert.equal(
      await page.getAttribute('#btn-projects', 'aria-pressed'),
      'true',
      `${at}: the key down while it's out`,
    );
    // (the header never moves as the view comes out: every key where it was, and the view clear under them)
    assert.deepEqual(await hudBoxes(), before, `${at}: the header stays put`);
    const gap = await page.evaluate(
      () =>
        document.querySelector('#projects .pj-modal').offsetTop -
        Math.max(
          ...[...document.querySelectorAll('#hud .brand, #hud .tools > *')].map(e => e.getBoundingClientRect().bottom),
        ),
    );
    assert.ok(gap >= 14, `${at}: the view clear of the header (${gap} px)`);
    // (a second press closes it, and one more opens it again)
    await tap(page, '#btn-projects');
    await page.waitForSelector('#projects', { state: 'hidden' });
    assert.equal(await page.getAttribute('#btn-projects', 'aria-pressed'), 'false', `${at}: the key up once it's in`);
    await tap(page, '#btn-projects');
    await page.waitForSelector('#projects [data-business]');
    // (the view's own close, the big key's way: the HUD has no way out of its own.)
    assert.ok(!(await page.$('#btn-leave')), `${at}: no way out in the HUD's tools`);
    assert.ok(await page.$('#projects .pj-head [data-leave]'), `${at}: the view's own close`);
    await header(page, at, device === 'phone', true);

    // home: a business each, its cover, its owner in the corner, the bars of the work running in it, marked and lit where
    // something waits for the board; then Recurring (the routines' projects) and the work being placed while a run of it
    // finished lately, each a plain tile. Under the HUD, under the view's head (its name, no way back up).
    assert.deepEqual(await texts(page, '[data-business] b'), ['The shopfront', 'The office'], at);
    assert.deepEqual(await marks('[data-business]'), ['Waits for you', ''], at);
    assert.deepEqual(
      await covers('[data-business]'),
      [COVER, 'T'],
      `${at}: a cover, else the plain ground and initial`,
    );
    assert.deepEqual(
      await bars('[data-business]'),
      [['2 jobs running'], ['2 jobs running']],
      `${at}: the bars of the jobs running, once`,
    );
    assert.ok(
      await page.$$eval('[data-business] .pj-live', p =>
        p.every(e => e.getAnimations().some(a => a.playState === 'running')),
      ),
      `${at}: each bar on its beat`,
    );
    assert.deepEqual(
      await page.$$eval('[data-business] .pj-corner .pj-owner', p => p.map(e => e.dataset.name)),
      ['Kit, owner', 'Wren, owner'],
      `${at}: each business's owner in its corner, named`,
    );
    assert.deepEqual(
      await page.$$eval('[data-business]', t => t.map(e => e.classList.contains('lit'))),
      [true, false],
      `${at}: the shop's domain and the banner's review wait for the board`,
    );
    assert.deepEqual(
      await texts(page, '[data-group] > .pj-tile-body > b'),
      ['Recurring', 'Outside projects', 'Meetings'],
      at,
    );
    assert.equal(await page.$('[data-group] .pj-next'), null, `${at}: what our works are, never what's up next`);
    assert.equal(await title(), 'Projects', `${at}: home is the view's top`);
    assert.ok(!(await page.$('#projects :is(.pj-head [data-up], .pj-dot)')), `${at}: no way up from the top`);
    assert.match(
      (await texts(page, '.pj-board > [role=status]'))[0] ?? '',
      /^No new jobs can start: the worker has been short of memory/,
      `${at}: why nothing starts, while it lasts`,
    );
    // (once the view has flown out of the HUD's key: on its way it passes the HUD.)
    await page.waitForFunction(
      () =>
        !document
          .querySelector('#projects')
          .getAnimations({ subtree: true })
          .some(a => a.playState === 'running' && a.effect.getTiming().iterations !== Infinity),
      null,
      { polling: 250 },
    );
    const hud = await page.evaluate(() => ({
      hud: document.querySelector('#hud').getBoundingClientRect().bottom,
      board: document.querySelector('.pj-board').getBoundingClientRect().top,
    }));
    assert.ok(hud.board >= hud.hud - 1, `${at}: the keys scroll under the HUD's edge (${JSON.stringify(hud)})`);
    assert.deepEqual(await offScreen(), [], at);
    assert.deepEqual(await reds(), [], at);
    assert.deepEqual(await plain(), { numbers: [], underlined: [] }, at);
    assert.ok(await page.$eval('.pj-sides', e => e.hidden), `${at}: no sides at home`);
    await shot('home');

    // a business: its projects' keys drop in under its head
    await tap(page, '[data-business=shopfront]');
    await level('The shopfront');
    assert.deepEqual(await texts(page, '[data-project] b'), ['The sticker shop', 'The newsletter'], at);
    assert.deepEqual(
      await page.$$eval('.pj-head .pj-mark.you', m => m.map(e => e.title)),
      ['Waits for you'],
      `${at}: lit at every level, a mark, not a key`,
    );
    assert.equal(
      await page.$$eval('.pj-tile .pj-face', f => f.filter(e => !e.style.backgroundImage).length),
      0,
      `${at}: every face is a portrait`,
    );
    // an owner at work shows once, the others at work beside them, each at work marked so
    assert.deepEqual(
      await page.$$eval('[data-project]', ts => ts.map(t => [...t.querySelectorAll('.pj-face')].map(f => f.title))),
      [['Kit', 'Rook, at work'], ['Moss, at work']],
      `${at}: an owner at work once`,
    );
    assert.equal(await page.$$eval('[data-project] .pj-owner .pj-crown', c => c.length), 2, `${at}: owners crowned`);
    // a project's cover, else the plain ground; the bars of the jobs running in it
    assert.deepEqual(await covers('[data-project]'), [COVER, 'T'], `${at}: a project's cover, else its initial`);
    assert.deepEqual(
      await bars('[data-project]'),
      [['1 job running'], ['1 job running']],
      `${at}: the bars of each project's running jobs`,
    );
    // each project's deliverables, those with work running first with its bars, then up next, with when each is done,
    // or its latest done ones
    assert.deepEqual(
      await texts(page, `[data-project] ${DELIVERABLE}`),
      ['Gift wrap', 'The sticker shop opens', 'Banners for the posts'],
      at,
    );
    assert.deepEqual(
      await page.$$eval('[data-project] .pj-deliverables li', l => l.map(e => Boolean(e.querySelector('.pj-pulse')))),
      [true, false, true],
      `${at}: the deliverables with work running`,
    );
    const whens = await texts(page, '[data-project] .pj-deliverables small');
    assert.deepEqual([whens[1], whens[2]], ['For you', 'For you'], `${at}: waiting on the board, not a time`);
    assert.match(
      whens[0],
      /^(\d+ min|[\d½]+ h|\d{2}:\d{2}|[A-Z][a-z]{2}(?: \d{1,2} [A-Z][a-z]+| \d{2}:\d{2})?)$/,
      `${at}: when it's done, the planner's`,
    );
    await shot('business');
    // the board sorts them by dragging one held still, and a drag opens nothing (the order kept: the coordinator's
    // projects test)
    const drag = async (from, to, hold = true) => {
      const a = await page.locator(from).boundingBox(),
        b = await page.locator(to).boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      if (hold) await page.waitForSelector('.pj-lifted');
      for (let i = 1; i <= 8; i++)
        await page.mouse.move(a.x + a.width / 2 + ((b.x - a.x) * i) / 8, a.y + a.height / 2 + ((b.y - a.y) * i) / 8);
      await page.mouse.up();
    };
    await drag('[data-project=news]', '[data-project=shop]');
    assert.deepEqual(await texts(page, '[data-project] b'), ['The newsletter', 'The sticker shop'], `${at}: dragged`);
    await page.waitForTimeout(300);
    assert.equal(await title(), 'The shopfront', `${at}: a drag opens nothing`);
    await drag('[data-project=shop]', '[data-project=news]');
    assert.deepEqual(await texts(page, '[data-project] b'), ['The sticker shop', 'The newsletter'], `${at}: and back`);
    // a mouse that drags at once lifts the tile as it moves, and the level stays put
    if (device !== 'phone') {
      await drag('[data-project=shop]', '[data-project=news]', false);
      assert.deepEqual(
        await texts(page, '[data-project] b'),
        ['The newsletter', 'The sticker shop'],
        `${at}: dragged at once`,
      );
      assert.equal(await title(), 'The shopfront', `${at}: no swipe under a mouse drag`);
      await page.waitForTimeout(300); // (the dropped tile home before it's aimed at)
      await drag('[data-project=news]', '[data-project=shop]');
      assert.deepEqual(
        await texts(page, '[data-project] b'),
        ['The sticker shop', 'The newsletter'],
        `${at}: and back again`,
      );
    }
    // a swipe brings the next business in, and a business of one project opens at its tiles too
    await swipe(-140);
    await level('The office');
    assert.deepEqual(await texts(page, '[data-project] b'), ['The office'], `${at}: a business of one, at its tiles`);
    await swipe(140);
    await level('The shopfront');
    // a short drag is neither a swipe nor a tap
    await swipe(-30);
    assert.equal(await title(), 'The shopfront', at);
    // the sides: a small triangle outside the view on each side, on top where it is, and a tap on one the swipe's step;
    // none at home, where nothing is beside
    const sides = await page.evaluate(() => {
      const view = document.querySelector('.pj-modal').getBoundingClientRect();
      return [...document.querySelectorAll('.pj-sides svg')].map(svg => {
        const r = svg.getBoundingClientRect(),
          on = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { outside: r.right <= view.left || r.left >= view.right, onTop: Boolean(on?.closest('.pj-sides')) };
      });
    });
    assert.deepEqual(
      sides,
      Array(2).fill({ outside: true, onTop: true }),
      `${at}: the sides (${JSON.stringify(sides)})`,
    );
    await tap(page, '.pj-sides [data-side="1"]');
    await level('The office');
    await tap(page, '.pj-sides [data-side="-1"]');
    await level('The shopfront');

    // a project: its owner, its threads, each a deliverable with more than the project's tile said of it: who's on it,
    // what it's for, what runs and comes next, what it waits on, its tasks as a strip, its lines and when it's done with
    // its sums
    await tap(page, '[data-project=shop]');
    await level('The sticker shop');
    assert.deepEqual(await texts(page, '.pj-head small'), ['The shopfront'], `${at}: the level above, over its name`);
    assert.equal(
      await page.$eval('.pj-head .pj-marks .pj-owner', e => e.dataset.name),
      'Kit, owner',
      `${at}: its owner, crowned, a face in the head`,
    );
    assert.deepEqual(await texts(page, '.pj-head .pj-keys button'), [], at);
    assert.deepEqual(await texts(page, `${box('[data-thread]')} b`), ['The sticker shop opens', 'Gift wrap'], at);
    assert.deepEqual(
      await texts(page, `${box('[data-thread]')} .pj-goal`),
      ['Customers can buy stickers on our own domain.', 'A buyer can wrap an order and pick a ribbon.'],
      `${at}: what each is for`,
    );
    assert.deepEqual(
      await texts(page, `${box('[data-thread]')} .pj-now li > span:not(.pj-pulse)`),
      ['Pick a domain for the sticker shop', 'Gift wrap at checkout', 'Gift wrap at checkout: the ribbon picker'],
      `${at}: its tasks running, then the one up next`,
    );
    assert.deepEqual(
      await texts(page, `${box('[data-thread]')} .pj-now .pj-tag`),
      ['Next', 'Next'],
      `${at}: the one up next named so`,
    );
    assert.deepEqual(
      await texts(page, `${box('[data-thread="shop/launch"]')} .pj-waits li`),
      [
        'On your desk phone: Which domain for the sticker shop?',
        'Not on your desk phone yet: Which printer for the price tags?',
      ],
      `${at}: what a thread waits on, the board's part first`,
    );
    assert.deepEqual(
      await texts(page, `${box('[data-thread]')} .pj-strip-words`),
      ['0 of 5 done', '0 of 2 done'],
      `${at}: its tasks as a strip`,
    );
    assert.deepEqual(await texts(page, `${box('[data-thread]')} .pj-lines`), ['+52 −10', '+172 −17'], at);
    assert.deepEqual(await marks(box('[data-thread]')), ['Waits for you', ''], at);
    const times = await texts(page, `${box('[data-thread]')} .pj-eta-foot .pj-when`),
      sums = await texts(page, `${box('[data-thread]')} .pj-eta-foot small`);
    assert.equal(times.length, 2, `${at}: each its time, as its page's head has it`);
    for (const time of times) assert.match(time, /^Done about /, `${at}: when it's done, the planner's`);
    assert.match(sums[1], /of agent time left\. .* past its deadline /, `${at}: the agent time left and its window`);
    assert.deepEqual(await offScreen(), [], at);
    await shot('project');

    // a thread: its tasks as a list, the board's card first and lit, a card not on the desk phone yet quiet and opening
    // nothing, each task with who, where it is, the planner's times, its size and its code, and every check and review
    // under its task; its time always in its head, and its keys
    await tap(page, '[data-thread="shop/launch"]');
    await level('The sticker shop opens');
    assert.match(
      (await texts(page, '.pj-head .pj-eta summary'))[0] ?? '',
      /^(Done about .+|No time yet)$/,
      `${at}: its time, even while it waits for the board`,
    );
    const cards = await texts(page, '.pj-level .pj-task');
    assert.match(cards[0], /^Which domain for the sticker shop\? ?On your desk phone · For Kit: Pick a domain/, at);
    // (a card not on the desk phone yet under the task whose work it waits for, saying so; the tasks in time order.
    const later = cards.findIndex(c => /^Which printer for the price tags\?/.test(c));
    assert.match(
      cards[later],
      /^Which printer for the price tags\? ?Not on your desk phone yet · Once SH-PHOTOS is live · For Penny: /,
      at,
    );
    assert.ok(later > cards.findIndex(c => /^Product photos/.test(c)), `${at}: under the work it waits for (${cards})`);
    assert.ok(
      cards.some(c => /^Product photos.*Vera · .{0,10}SH-DOMAIN ·/.test(c)) &&
        (await page.$$('.pj-level .pj-wait svg[data-icon=hourglass]')).length > 0,
      `${at}: a task after another names its code, behind an hourglass (${cards})`,
    );
    assert.deepEqual(
      await page.$$eval('.pj-level .pj-board-task', b =>
        b.map(e => [!!e.querySelector(':scope > button.cover'), e.classList.contains('lit')]),
      ),
      [
        [true, true],
        [false, false],
      ],
      `${at}: the card on the desk phone lit and a key, the held one neither`,
    );
    assert.match(cards[1], /^Landing page for the sticker shop ?Kit · Done, in review ?SH-LANDING$/, at);
    assert.ok(
      cards.some(t =>
        /^Shipping costs per country.* ?Penny · starts \w{3} \d\d:\d\d · done about \w{3} \d\d:\d\d ?1½ h ?SH-SHIPPING$/.test(
          t,
        ),
      ),
      `${at}: a planned task with the planner's times (${cards})`,
    );
    assert.ok(
      cards.some(t => /Product photos/.test(t) && / · check\b/.test(t)),
      `${at}: the check shows`,
    );
    // (a fix round says what it fixes, never its kind alone.)
    assert.ok(
      (await texts(page, '.pj-level .pj-step .pj-task')).some(t =>
        /^Fixing what round 1 found: The price on the landing page leaves out the shipping cost\. ?\w+ · /.test(t),
      ),
      `${at}: the landing page's open fix round shows under it, saying what it fixes`,
    );
    assert.deepEqual(
      await page.evaluate(async () => {
        const { doingOf } = await import('/shell/threads.js');
        const fix = { review: 1, kind: 'work', stage: 'fix', round: 2, title: 'Fix finding 7' };
        return [
          doingOf({ ...fix, fixes: { round: 2, findings: ['A.', 'B.', 'C.'] } }),
          doingOf({ ...fix, fixes: { round: 2, findings: ['A.'], title: 'Count the fee once' } }),
          doingOf({ ...fix, fixes: { round: 2, findings: [], touchups: true } }),
          doingOf({ ...fix, step: 'Bringing up to date', round: null }),
          doingOf(fix),
          doingOf({ review: 1, kind: 'review', title: 'Landing page' }),
        ];
      }),
      [
        'Fixing what round 2 found: A.; B.; and 1 more',
        'Fixing what round 2 found: Count the fee once',
        "Checking the edits made in round 2's review",
        'Bringing up to date',
        'Fixing what the review found',
        'Reviewing',
      ],
      at,
    );
    assert.deepEqual(await texts(page, '.pj-head .pj-keys button'), [], `${at}: nothing finished to fold away`);
    assert.deepEqual(await plain(), { numbers: [], underlined: [] }, at);
    await shot('thread');
    // a finished review shows what it found on its row, in ink when something blocks, and its ruling the verdict; a tap
    // lists each finding, blocking or a note, with what became of it
    assert.deepEqual(
      await page.$$eval('.pj-level .pj-step .pj-task:has(.pj-found)', rows =>
        rows.map(r => [
          r.querySelector(':scope > .cover').dataset.job,
          r.querySelector('.pj-found').textContent,
          r.querySelector('.pj-found.blocking') !== null,
        ]),
      ),
      [
        ['41', '1 blocking · 2 notes', true],
        ['46', 'Another round', true],
      ],
      at,
    );
    // (its front says what it found in a line, its back lists each.)
    await tap(page, '.pj-level [data-job="41"]');
    await page.waitForSelector('.pj-card .pj-front .pj-summary');
    assert.equal((await texts(page, '.pj-card .pj-front .pj-summary'))[0], 'Found 1 blocking finding and 2 notes.', at);
    assert.equal(await page.$('.pj-card .pj-front :is(.pj-findings, .pj-readers)'), null, `${at}: the front is short`);
    await tap(page, '.pj-card [data-turn]');
    await page.waitForSelector('.pj-card .pj-findings li.blocking');
    assert.deepEqual(
      await page.$$eval('.pj-card .pj-findings li', lines =>
        lines.map(l => [
          l.querySelector('.pj-found').textContent,
          [...l.lastChild.childNodes]
            .filter(n => n.nodeName !== 'SMALL')
            .map(n => n.textContent)
            .join(''),
          l.querySelector('small').textContent,
        ]),
      ),
      [
        ['Blocking', 'The price on the landing page leaves out the shipping cost.', 'Still open'],
        ['Note', 'The hero picture loads at full size on a phone.', 'Moved to a follow-up task'],
        ['Note', 'A heading reads in title case, as #43’s did.', 'Dropped'],
      ],
      at,
    );
    // a finding's job number links to that job
    assert.deepEqual(await page.$$eval('.pj-card .pj-findings a.job-link', a => a.map(e => e.dataset.job)), ['43'], at);
    // and who read the round and why, as its triage chose them: each reader's reason, who rules it, and a finder left
    // out with why
    assert.equal(
      await page.$eval('.pj-card .pj-chosen', p => p.textContent),
      'A product page with a price on it, as #43 is: one read for the copy and the price, one for how it looks on a phone.',
      at,
    );
    assert.deepEqual(
      await page.$$eval('.pj-card .pj-readers .pj-row', rows =>
        rows.map(r => [
          r.querySelector('b').textContent,
          r.querySelector('small')?.textContent ?? '',
          r.querySelector('.pj-tag').textContent,
        ]),
      ),
      [
        ['Tally', 'The price and its shipping cost are money a customer sees.', 'Copy'],
        ['Wren', 'The hero picture and its layout on a phone.', 'Visual'],
        ['Quill', '', 'Rules'],
        ['Rook', 'Found nothing in this page’s files last round (#43), and none of them changed.', 'Left out'],
      ],
      at,
    );
    // the triage's reason and a reader's link their job numbers
    assert.deepEqual(
      await page.$$eval('.pj-card :is(.pj-chosen, .pj-readers) a.job-link', a => a.map(e => e.dataset.job)),
      ['43', '43'],
      at,
    );
    assert.deepEqual(await offScreen(), [], at);
    await shot('findings');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    // the card opens the desk phone at it
    await tap(page, '.pj-level [data-card]');
    await page.waitForSelector('#tool .device.phone');
    await page.waitForFunction(() =>
      document.querySelector('#phone-screen')?.textContent.includes('Launch Hello Postcards'),
    ); // (card 91, not the first)
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tool', { state: 'hidden' });
    // back up a level, and the next thread's sums a tap away
    await tap(page, '[data-up]');
    await level('The sticker shop');
    await tap(page, '[data-thread="shop/wrap"]');
    await level('Gift wrap');
    await tap(page, '.pj-eta summary');
    assert.match(
      (await texts(page, '.pj-eta'))[0],
      /^Done about Sat \d\d:10 ?40 min of agent time left\. 1½ h past its deadline Sat \d\d:30\.$/,
      at,
    );
    assert.deepEqual(await reds(), [], `${at}: a later time is never red`);

    // a running task opens its agent's card, the very one the home page shows, over the view; it closes back to the
    // view as it was
    const agentCard = () =>
      page.evaluate(() => Boolean(document.querySelector('#panel:not([hidden]), .wire .solo:not([hidden])')));
    await tap(page, '.pj-level [data-job="58"]');
    await page.waitForFunction(() => document.querySelector('#panel:not([hidden]), .wire .solo:not([hidden])'));
    assert.ok(!(await page.$('#projects .pj-card')), `${at}: no sheet of its own for a job at work`);
    // (and from here it steps to no other agent's: the board's note.)
    assert.equal(await page.$('.wire .solo .sides'), null, `${at}: no sides to agents of other work`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#panel:not([hidden]), .wire .solo:not([hidden])'));
    assert.ok(!(await agentCard()), at);
    assert.equal(await title(), 'Gift wrap', `${at}: the view where it was`);

    // any other opens as a big key over the view, under the HUD: its code, never a number or a breadcrumb, on its front;
    // turned over, its reviews, its report, what follows it and its steps
    await tap(page, '[data-job="50"]');
    await page.waitForSelector('.pj-pop .pj-card');
    assert.match(
      (await texts(page, '.pj-card .pj-front .pj-code-line'))[0],
      /^[A-Z]{2,3}-[A-Z]{2,8}$/,
      `${at}: the task's code, no breadcrumbs`,
    );
    assert.deepEqual(await texts(page, '.pj-card .pj-front h2'), ['Gift wrap at checkout'], at);
    await tap(page, '.pj-card [data-turn]');
    await page.waitForSelector('.pj-card.flipped');
    assert.deepEqual(
      await texts(page, '.pj-card .pj-back h4'),
      ['Its reviews and fixes', 'What it did', 'Then, once it’s merged', 'Its steps'],
      at,
    );
    assert.ok(
      (await texts(page, '.pj-card .pj-back .pj-rows li')).some(t =>
        /^Gift wrap at checkout: the ribbon picker/.test(t),
      ),
      at,
    );
    await page.waitForFunction(() => !document.querySelector('.pj-card').getAnimations({ subtree: true }).length); // (its flight in and its turn)
    const under = await page.evaluate(() => ({
      hud: document.querySelector('#hud').getBoundingClientRect().bottom,
      job: document.querySelector('.pj-card').getBoundingClientRect().top,
    }));
    assert.ok(under.job >= under.hud - 1, `${at}: the job is under the HUD (${JSON.stringify(under)})`);
    // (its steps there at once, as the agents' big keys' are.)
    await page.waitForSelector('.pj-card .pj-back .steplog li[data-k]');
    assert.deepEqual(await plain(), { numbers: [], underlined: [] }, at);
    assert.deepEqual(await offScreen(), [], at);
    await shot('job');
    // a job it leads to opens in its place, on its front; Escape closes the job, then goes up a level at a time
    await tap(page, '.pj-card .pj-rows [data-job="54"]');
    await page.waitForFunction(() =>
      document.querySelector('.pj-card:not(.flipped) .pj-front h2')?.textContent.includes('ribbon picker'),
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    await page.keyboard.press('Escape');
    await level('The sticker shop');
    await page.keyboard.press('Escape');
    await level('The shopfront');

    // a done task's card: on its front what it did in a line, its review loop's output never shown raw; turned over by
    // the mark in its corner, its record, who read it and its steps as the agents' big keys show theirs, a tap opening
    // a step; both faces on the screen and scrolling, a short one too.
    await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const t = (await loadProjects(true)).projects[0].threads[0],
        review = t.jobs.find(j => j.id === 41),
        chosen = review.triage.selection;
      t.jobs.push({
        ...review,
        id: 40,
        agent: 'quill',
        kind: 'consolidate',
        stage: 'triage',
        step: 'Choosing the reviewers',
        findings: undefined,
        triage: { ...review.triage, job: 40 },
        created: '2026-09-25T08:30:00Z',
        finished: '2026-09-25T08:45:00Z',
        result: JSON.stringify({ decision: 'review', reason: chosen.reason, reviewers: chosen.reviewers }),
      });
      await (await import('/shell/projects.js')).openProjects({ job: 40 });
    });
    const still = () =>
      page.waitForFunction(() => !document.querySelector('.pj-card')?.getAnimations({ subtree: true }).length, null, {
        polling: 250,
      });
    // (the card whole between the HUD and the screen's foot, and its face scrolled as far as it goes, if it can)
    const onScreen = () =>
      page.evaluate(() => {
        const c = document.querySelector('.pj-card').getBoundingClientRect(),
          hud = document.querySelector('#hud').getBoundingClientRect().bottom,
          faces = document.querySelector('.pj-card-faces');
        faces.scrollTop = faces.scrollHeight;
        const scrolls = faces.scrollHeight <= faces.clientHeight + 1 || faces.scrollTop > 0;
        faces.scrollTop = 0;
        return {
          inside: c.left >= 0 && c.right <= innerWidth && c.top >= hud - 1 && c.bottom <= innerHeight + 1,
          scrolls,
        };
      });
    await page.waitForSelector('.pj-pop .pj-card[data-job-open="40"]');
    await still();
    assert.match(
      (await texts(page, '.pj-card .pj-front .pj-summary'))[0] ?? '',
      /^Chose Tally and Wren to review it: A product page with a price on it, as \S+ is: one read for the copy and the price, one for how it looks on a phone\.$/,
      at,
    );
    assert.ok(await page.$('.pj-card .pj-front .pj-why-big svg[data-icon=tick]'), `${at}: done as the tick`);
    assert.ok(!(await page.$eval('.pj-card', c => c.textContent.includes('{'))), `${at}: no raw output, either side`);
    assert.equal(await page.$('.pj-card-keys [data-turn]'), null, `${at}: no turn key beside the close`);
    assert.ok(
      await page.$eval('.pj-card', c => {
        const r = c.getBoundingClientRect(),
          m = c.querySelector(':scope > .pj-turns[data-turn]').getBoundingClientRect();
        return (
          m.right <= r.right && m.bottom <= r.bottom && m.left > r.left + r.width / 2 && m.top > r.top + r.height / 2
        );
      }),
      `${at}: the turn mark in its bottom corner`,
    );
    assert.deepEqual(await onScreen(), { inside: true, scrolls: true }, `${at}: its front`);
    await shot('done-front');
    await tap(page, '.pj-card [data-turn]');
    await page.waitForSelector('.pj-card.flipped');
    await still();
    await page.waitForSelector('.pj-card .pj-back .pj-record');
    const record = await texts(page, '.pj-card .pj-record dt');
    assert.deepEqual(record.slice(0, 3), ['Started', 'Finished', 'Start to end'], at);
    assert.ok(
      record.some(t => /^Agent time, sized /.test(t)),
      `${at}: its agent time against its size (${record})`,
    );
    assert.deepEqual(
      await texts(page, '.pj-card .pj-back .pj-readers .pj-row b'),
      ['Tally', 'Wren', 'Quill', 'Rook'],
      `${at}: who read it, by name`,
    );
    await page.waitForSelector('.pj-card .pj-back .steplog li[data-k]');
    assert.ok(
      await page.$$eval('.pj-card .steplog li[data-k]', lines =>
        lines.every(l => /^\d\d:\d\d$/.test(l.querySelector('time').textContent)),
      ),
      `${at}: each step with its time`,
    );
    assert.ok(
      await page.$eval('.pj-card .steplog', l => l.scrollTop + l.clientHeight >= l.scrollHeight - 2),
      `${at}: its steps at the newest`,
    );
    await page.$eval('.pj-card .steplog li[data-k]', li => li.click());
    assert.ok(await page.$('.pj-card.flipped .steplog li.open'), `${at}: a tap opens a step, the card stays turned`);
    assert.deepEqual(await onScreen(), { inside: true, scrolls: true }, `${at}: its back`);
    assert.ok(!(await page.$eval('.pj-card', c => c.textContent.includes('{'))), at);
    await shot('done-back');
    // (and on a short screen, its front scrolls inside the screen)
    await tap(page, '.pj-card [data-turn]');
    await page.waitForSelector('.pj-card:not(.flipped)');
    await page.setViewportSize({ width: w, height: 360 });
    await still();
    const short = await onScreen();
    assert.ok(
      await page.$eval('.pj-card-faces', f => f.scrollHeight > f.clientHeight),
      `${at}: a short screen's front overflows`,
    );
    assert.deepEqual(short, { inside: true, scrolls: true }, `${at}: a short screen's front`);
    await page.setViewportSize({ width: w, height: h });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    await page.evaluate(async () => {
      const t = (await (await import('/shell/data.js')).loadProjects(true)).projects[0].threads[0];
      t.jobs.splice(
        t.jobs.findIndex(j => j.id === 40),
        1,
      );
    });
    await page.keyboard.press('Escape');
    await level('The sticker shop');
    await page.keyboard.press('Escape');
    await level('The shopfront');

    // a paused project says only that and when it's judged, never the brief's why, and can't be held again; a finished job
    // whose review waits for the board leads its thread as its card
    await tap(page, '[data-project=news]');
    await level('The newsletter');
    assert.deepEqual(
      await texts(page, '.pj-head .pj-marks .pj-note'),
      ['Paused, to be judged once “Pick a domain for the sticker shop” ends'],
      at,
    );
    assert.ok(
      !(await page.$eval('#projects', e => e.textContent.includes('Hold the newsletter'))),
      `${at}: no pause's reason on its tiles or head`,
    );
    assert.deepEqual(
      await texts(page, '.pj-head .pj-keys button'),
      ['Ongoing', 'Completed'],
      `${at}: a paused project can't be held again`,
    );
    // its ongoing threads, the completed ones a switch away
    assert.deepEqual(
      await texts(page, `${box('[data-thread]')} b`),
      ['Banners for the posts'],
      `${at}: only the ongoing`,
    );
    await shot('ongoing');
    await tap(page, '[data-thread="news/banners"]');
    await level('Banners for the posts');
    assert.match((await texts(page, '.pj-level .pj-task.lit'))[0], /^Pebblet’s test posters.*On your desk phone/, at);
    await tap(page, '.pj-level [data-card="96"]');
    await page.waitForFunction(() => document.querySelector('#phone-screen')?.textContent.includes('Pebblet'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#tool', { state: 'hidden' });
    await tap(page, '[data-up]');
    await level('The newsletter');
    // a done thread is a tap away: one that doesn't load says so on its tile, and a tap tries again, even when it was
    // picked while another thread's move was still leaving (that move is over); one that loads after the board has
    // moved on opens nothing
    await tap(page, '[data-done=completed]');
    // (one closed with no jobs in it says so, never "0 of 0".)
    await page.waitForSelector('[data-thread="news/old-card"]');
    assert.deepEqual(
      await texts(page, `${box('[data-thread="news/old-card"]')} .pj-state`),
      ['Closed with no jobs'],
      at,
    );
    await page.route('**/mock/threads.json', r => r.fulfill({ status: 503, body: '' }));
    await page.evaluate(() => {
      document.querySelector('[data-done=ongoing]').click();
      document.querySelector('[data-thread="news/proofs"]').click();
    });
    await page.waitForFunction(() =>
      document
        .querySelector('[data-thread="news/proofs"]')
        ?.parentElement.textContent.includes('Didn’t open. Tap to try again.'),
    );
    await page.waitForTimeout(600); // (past the first move's exit)
    assert.equal(await title(), 'The newsletter', `${at}: a failed load moves nowhere, nor the move it replaced`);
    assert.equal(
      (await texts(page, `${box('[data-thread="news/proofs"]')} .pj-state`))[0],
      'Didn’t open. Tap to try again.',
      at,
    );
    await page.unroute('**/mock/threads.json');
    let release;
    const held = new Promise(r => (release = r));
    await page.route('**/mock/threads.json', async r => {
      await held;
      await r.continue();
    });
    await tap(page, '[data-thread="news/proofs"]');
    await page.waitForFunction(() =>
      document.querySelector('[data-thread="news/proofs"]')?.parentElement.textContent.includes('Opening'),
    );
    await tap(page, '[data-up]');
    await level('The shopfront');
    release();
    await page.waitForResponse('**/mock/threads.json');
    await page.waitForTimeout(800);
    assert.equal(await title(), 'The shopfront', `${at}: a late load opens nothing`);
    await page.unroute('**/mock/threads.json');
    await tap(page, '[data-project=news]');
    await level('The newsletter');
    await tap(page, '[data-done=completed]');
    assert.deepEqual(
      await texts(page, `${box('[data-thread]')} b`),
      ["Old card: the newsletter's sign-up line", 'The first issue', 'The proofs'],
      `${at}: the completed threads, in place of the ongoing`,
    );
    assert.deepEqual(await page.$$eval('.pj-head [data-done]', k => k.map(e => e.ariaPressed)), ['false', 'true'], at);
    await shot('completed');
    await tap(page, '[data-done=ongoing]');
    assert.deepEqual(await texts(page, `${box('[data-thread]')} b`), ['Banners for the posts'], `${at}: and back`);
    await tap(page, '[data-done=completed]');
    // a done thread of only a finished check shows it, and it opens (its report on the card's back)
    await tap(page, '[data-thread="news/proofs"]');
    await level('The proofs');
    await tap(page, '.pj-level [data-job="36"]');
    await tap(page, '.pj-card [data-turn]');
    await page.waitForFunction(() => document.querySelector('.pj-card .pj-report')?.textContent.includes('Two typos'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    // its key for what's done stays whichever way it's set, so the check comes back
    await tap(page, '.pj-head [data-done]');
    assert.deepEqual(await texts(page, '.pj-head .pj-keys button'), ['Done · 1'], at);
    assert.ok(!(await page.$('.pj-level [data-job="36"]')), `${at}: the key hides it`);
    await tap(page, '.pj-head [data-done]');
    assert.ok(await page.locator('.pj-level [data-job="36"]').isVisible(), `${at}: and bring it back`);
    await tap(page, '[data-up]');
    await level('The newsletter');
    await tap(page, '[data-thread="news/launch"]');
    await level('The first issue');
    assert.ok(await page.locator('.pj-level [data-job="37"]').isVisible(), `${at}: a done thread opens with its jobs`);
    await tap(page, '.pj-level [data-job="37"]');
    await tap(page, '.pj-card [data-turn]');
    await page.waitForFunction(() => document.querySelector('.pj-card .pj-report')?.textContent.includes('Posted'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    await tap(page, '[data-up]');
    await level('The newsletter');
    assert.deepEqual(
      await texts(page, `${box('[data-thread]')} b`),
      ["Old card: the newsletter's sign-up line", 'The first issue', 'The proofs'],
      `${at}: back keeps the completed threads shown`,
    );
    await tap(page, '[data-done=ongoing]');
    await tap(page, '[data-thread="news/banners"]');
    await level('Banners for the posts');
    await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const project = (await loadProjects(true)).projects.find(p => p.id === 'news');
      const thread = project.threads.find(t => t.id === 'news/banners');
      const { jobs, ...details } = thread;
      project.threads = project.threads.filter(t => t.id !== thread.id);
      project.done.push({ ...details, jobs: jobs.length, done: jobs.length, finished: '2026-10-19T09:00:00Z' });
      await (await import('/shell/projects.js')).openProjects();
    });
    assert.equal(await title(), 'Banners for the posts', `${at}: completion keeps the thread open on refresh`);
    await tap(page, '[data-up]');
    await level('The newsletter');
    assert.equal(await page.getAttribute('[data-done=completed]', 'aria-pressed'), 'true', at);
    assert.ok(await page.locator('[data-thread="news/banners"]').isVisible(), at);
    // with nothing ongoing, its tile shows the two latest finished, not the latest made
    await tap(page, '[data-up]');
    await level('The shopfront');
    assert.deepEqual(
      await texts(page, `[data-project=news] ${DELIVERABLE}`),
      ['Banners for the posts', 'The first issue'],
      `${at}: the latest done by when each finished`,
    );
    await tap(page, '[data-project=news]');
    await level('The newsletter');
    await page.evaluate(async () => {
      const { loadProjects, loadThread } = await import('/shell/data.js');
      const project = (await loadProjects(true)).projects.find(p => p.id === 'news');
      const thread = structuredClone(await loadThread(true, 'news/banners'));
      thread.jobs.push({ ...thread.jobs[0], id: 60, status: 'running', check: 0, review: 0, finished: null });
      project.done = project.done.filter(t => t.id !== thread.id);
      project.threads.push(thread);
      await (await import('/shell/projects.js')).openProjects();
    });
    await tap(page, '[data-done=ongoing]');
    await tap(page, '[data-thread="news/banners"]');
    await level('Banners for the posts');
    assert.equal(await page.getAttribute('.pj-head [data-done]', 'aria-pressed'), 'false', at);
    await tap(page, '[data-up]');
    await level('The newsletter');
    assert.equal(await page.getAttribute('[data-done=ongoing]', 'aria-pressed'), 'true', at);
    await tap(page, '[data-up]');
    await level('The shopfront');
    // a project whose threads each had only a task dropped before it started: done, each at its drop, the latest first
    const shopThreads = await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const project = (await loadProjects(true)).projects.find(p => p.id === 'shop');
      const threads = project.threads;
      project.threads = [];
      project.done = threads.map((t, n) => ({
        ...t,
        jobs: 1,
        done: 0,
        finished: `2026-10-1${7 + n}T09:00:00.000Z`,
      }));
      await (await import('/shell/projects.js')).openProjects();
      return threads;
    });
    assert.deepEqual(
      await texts(page, `[data-project=shop] ${DELIVERABLE}`),
      ['Gift wrap', 'The sticker shop opens'],
      `${at}: dropped tasks' threads, by when each was dropped`,
    );
    await page.evaluate(async threads => {
      const { loadProjects } = await import('/shell/data.js');
      const project = (await loadProjects(true)).projects.find(p => p.id === 'shop');
      project.threads = threads;
      project.done = [];
      await (await import('/shell/projects.js')).openProjects();
    }, shopThreads);
    await tap(page, '[data-up]');
    await page.waitForSelector('[data-business]');

    // Recurring: the routines as projects, each with its interval and next run, and no key to run it (its head says them
    // too); a routine's planned run is its thread, waiting for a spare seat, and its finished runs its completed threads
    await tap(page, '[data-group=recurring]');
    await level('Recurring');
    assert.deepEqual(
      await texts(page, '.pj-level [data-project] .pj-schedule'),
      [
        'daily 07:45 · next tomorrow 07:45',
        'Mondays 07:30 · next Monday 07:30',
        'Fridays 03:00 · next Fri 2 Oct 03:00',
        'every 4 hours · next today 20:00',
      ],
      `${at}: each routine's interval and next run`,
    );
    assert.equal(await page.$('[data-run]'), null, `${at}: no Run now`);
    await tap(page, '[data-project=hardening]');
    await level('Weekly hardening scan');
    assert.deepEqual(await texts(page, '.pj-head .pj-schedule'), ['Fridays 03:00 · next Fri 2 Oct 03:00'], at);
    assert.deepEqual(await texts(page, `.pj-level ${box('[data-thread]')} b`), ['Weekly hardening scan, 2 Oct'], at);
    await tap(page, '[data-done=completed]');
    await tap(page, '[data-thread="hardening/job-39"]');
    await level('Weekly hardening scan, 25 Sept');
    await tap(page, '.pj-level [data-job="39"]');
    await page.waitForFunction(() => document.querySelector('.pj-card h2')?.textContent.includes('hardening'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    await page.keyboard.press('Escape');
    await level('Weekly hardening scan');
    await page.keyboard.press('Escape');
    await level('Recurring');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-business]');

    // the work outside the projects: its jobs open
    await tap(page, '[data-group=unsorted]');
    await level('Outside projects');
    await tap(page, '.pj-level [data-job="48"]');
    await page.waitForSelector('.pj-card');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-business]');

    // the meetings: a tile each, with everyone at it and its topic as the board reads it, the ended ones on a tap;
    // a meeting opens its first seat
    await tap(page, '[data-group=meetings]');
    await level('Meetings');
    assert.deepEqual(await texts(page, '.pj-level .pj-tile b'), ['How the line-art kit fits together'], at);
    assert.equal((await page.$$('.pj-level .pj-tile .pj-face')).length, 3, `${at}: everyone at it`);
    assert.match((await texts(page, '.pj-level .pj-tile .pj-state'))[0], /^Starts /, at);
    await tap(page, '.pj-head [data-done]');
    await page.waitForFunction(() => document.querySelectorAll('.pj-level .pj-tile').length === 2);
    assert.deepEqual(
      await texts(page, '.pj-level .pj-tile .pj-state'),
      [(await texts(page, '.pj-level .pj-tile .pj-state'))[0], 'Ended'],
      at,
    );
    await tap(page, '.pj-level [data-job="81"]');
    await page.waitForSelector('.pj-card');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-business]');

    // an agent's words stay text
    await tap(page, '[data-business=office]');
    await page.waitForSelector('[data-project=office]');
    await tap(page, '[data-project=office]');
    await page.waitForSelector('[data-thread="office/care"]');
    await tap(page, '[data-thread="office/care"]');
    await level('Care replies');
    await tap(page, '.pj-eta summary');
    assert.match(
      (await texts(page, '.pj-eta'))[0],
      /30 min of agent time left\. 30 min past its aim of Sat \d\d:30, 2 h to spare before its deadline Sat \d\d:00\.$/,
      `${at}: a thread that gives part of its window`,
    );
    assert.ok(
      (await page.$eval('.pj-level', e => e.textContent.includes('<img src=x'))) &&
        !(await page.$('.pj-level img[src=x]')),
      `${at}: markup in a title is text`,
    );
    // a job number in a task's title links to that job, beside the row's tap target, and a tap on it opens that job
    assert.deepEqual(
      await page.$$eval(`.pj-level ${box('[data-job="33"]')} a.job-link`, a => a.map(e => e.dataset.job)),
      ['45'],
      at,
    );
    assert.equal(
      await page.$$eval('#projects button a, #projects button .job-link', a => a.length),
      0,
      `${at}: no link inside a button`,
    );
    await page.click(`.pj-level ${box('[data-job="33"]')} a.job-link`);
    await page.waitForSelector('.pj-pop .pj-card[data-job-open="45"]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));

    // a check and a review without its work card both show their board decisions first
    await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const t = (await loadProjects(true)).projects[1].threads[1];
      // and a job queued after two cards, its review blocked on a third
      const after = { ...t.jobs[0], status: 'queued', request: null, check: 0, review: 0, finished: null };
      t.jobs.push(
        {
          ...after,
          id: 79,
          agent: 'quill',
          branch: 'job/79',
          cards: [501, 502].map(id => ({ id, title: `Card ${id}` })),
        },
        {
          ...after,
          id: 80,
          agent: 'quill',
          branch: 'job/79',
          review: 1,
          status: 'blocked',
          request: 503,
          request_title: 'Card 503',
        },
        ...[77, 78].map(id => ({
          ...t.jobs[0],
          id,
          agent: 'quill',
          status: 'blocked',
          request: 90 + id - 77,
          request_title: `Card ${id}`,
          check: id === 77 ? 1 : 0,
          review: id === 78 ? 1 : 0,
          branch: `job/${id + 100}`,
          finished: null,
        })),
      );
      await (await import('/shell/projects.js')).openProjects();
    });
    await page.waitForFunction(() => document.querySelectorAll('.pj-level .pj-board-task.lit').length === 5);
    assert.deepEqual(
      await page.$$eval('.pj-level .pj-task', c =>
        c.slice(0, 5).map(e => e.querySelector(':scope > .cover')?.dataset.card),
      ),
      ['90', '91', '501', '502', '503'],
      `${at}: every decision leads the thread, each once`,
    );
    await page.evaluate(async () => (await import('/shell/projects.js')).openProjects({ job: 79 }));
    await page.waitForSelector('.pj-card');
    assert.deepEqual(
      await page.$$eval('.pj-card .pj-why-big [data-card]', b => b.map(e => e.dataset.card)),
      ['501', '502', '503'],
      `${at}: the job names every card it waits on`,
    );
    await page.keyboard.press('Escape');

    // two queued after one, the second also after the first of them: only the first starts once it's merged, and the
    // second shows under both
    await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const t = (await loadProjects(true)).projects[1].threads[1];
      const job = (id, title, more) => ({
        ...t.jobs[0],
        id,
        title,
        agent: 'quill',
        status: 'queued',
        ready: 0,
        paused: 0,
        request: null,
        cards: [],
        waits: [],
        check: 0,
        review: 0,
        branch: `job/${id}`,
        finished: null,
        result: null,
        ...more,
      });
      const a = { after: 201, after_agent: 'quill', after_title: 'Measure the replies', after_state: 'queued' };
      t.jobs.push(
        job(201, 'Measure the replies', { status: 'running' }),
        job(202, 'Shorter replies', {
          ...a,
          waits: [{ id: 203, agent: 'quill', title: 'Reply styles', state: 'queued' }],
        }),
        job(203, 'Reply styles', a),
        job(204, 'Waits only for the card', { cards: [{ id: 201, title: 'Choose the reply' }] }),
        job(205, 'Waits for the job and card', { ...a, cards: [{ id: 201, title: 'Choose the reply' }] }),
      );
      await (await import('/shell/projects.js')).openProjects({ job: 201 });
    });
    await page.waitForFunction(() => document.querySelector('.pj-card h2')?.textContent === 'Measure the replies');
    await tap(page, '.pj-card [data-turn]');
    assert.deepEqual(
      await texts(page, '.pj-card .pj-back h4'),
      ['Then, once it’s merged', 'Also waiting for it', 'Its steps'],
      at,
    );
    assert.deepEqual(
      await page.$$eval('.pj-card .pj-back .pj-rows > li > .pj-row', r =>
        r.map(e => [e.querySelector(':scope > .cover')?.dataset.job, e.querySelector('.pj-tag').textContent]),
      ),
      [
        ['203', 'starts then'],
        ['202', 'then'],
        ['202', 'also waits'],
        ['205', 'also waits'],
      ],
      `${at}: a job that waits for two is never said to start with the first`,
    );
    assert.equal(
      await page.$eval(`.pj-card ${box('[data-job="205"]')} .pj-row-text small`, el => el.textContent),
      'Also after your answer on the desk phone',
      `${at}: a card with the same number as the job stays a separate wait`,
    );
    await page.keyboard.press('Escape');

    // queued work in the claim's order (its rank), not its planned start, which two starting together share: the older
    // one second, and a finished job's card where its open review stands.
    await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const t = (await loadProjects(true)).projects[1].threads[1];
      const job = (id, title, more) => ({
        ...t.jobs[0],
        id,
        title,
        agent: 'quill',
        status: 'queued',
        ready: 1,
        paused: 0,
        start: 1790000000000,
        cards: [],
        waits: [],
        branch: `job/${id}`,
        ...more,
      });
      t.jobs.push(
        job(211, 'Older, its latest start later', { rank: 2 }),
        job(212, 'Newer, its latest start sooner', { rank: 1 }),
        job(213, 'Reviewed reply macros', { status: 'done', start: null, finished: '2026-10-19T09:00:00Z' }),
        job(214, 'Reviewed reply macros', { review: 1, branch: 'job/213', step: 'Reviewing', round: 1, rank: 3 }),
        job(215, 'Reviewed reply macros', { review: 1, branch: 'job/213', step: 'Reviewing', round: 1, rank: 0 }),
      );
      await (await import('/shell/projects.js')).openProjects();
    });
    await page.waitForSelector('.pj-level [data-job="211"]');
    assert.deepEqual(
      await page.$$eval('.pj-level .pj-task.work', t =>
        t.map(e => e.querySelector(':scope > .cover').dataset.job).filter(id => id > 210),
      ),
      ['213', '212', '211'],
      `${at}: the queue in the claim's order`,
    );

    // an open thread's finished check, and a finished review under its running work: both keys are there whichever
    // shows, and both reports open
    await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const office = (await loadProjects(true)).projects[1],
        base = office.threads[1].jobs[0],
        finished = '2026-09-25T09:00:00Z';
      const job = (id, title, more = {}) => ({
        ...base,
        id,
        title,
        agent: 'quill',
        status: 'running',
        ready: 0,
        paused: 0,
        request: null,
        cards: [],
        waits: [],
        check: 0,
        review: 0,
        step: null,
        round: null,
        branch: `job/${id}`,
        finished: null,
        result: null,
        thread: 'office/audit',
        ...more,
      });
      office.threads.push({
        ...office.threads[1],
        id: 'office/audit',
        name: 'The audit',
        pause: null,
        outlook: null,
        jobs: [
          job(301, 'Audit the replies'),
          job(302, 'Reply links checked', { check: 1, status: 'done', finished, result: 'All links answer' }),
          job(303, 'Audit the macros'),
          job(304, 'Audit the macros', {
            review: 1,
            branch: 'job/303',
            step: 'Reviewing',
            round: 1,
            status: 'done',
            finished,
            result: 'Approved as it is',
          }),
        ],
      });
      await (await import('/shell/projects.js')).openProjects();
    });
    await tap(page, '[data-up]');
    await level('The office');
    // a project's threads by when they're done, soonest first, one waiting (a pause) on top and marked, whatever order
    // they come in; a time changed re-sorts them on the next load. The office's own threads back after.
    const threeThreads = hours =>
      page.evaluate(async hours => {
        const { loadProjects } = await import('/shell/data.js');
        const office = (await loadProjects(true)).projects[1];
        window.officeThreads ??= office.threads;
        const [backups, care] = window.officeThreads,
          at = h => ({ ...care.outlook, finish: care.outlook.finish + h * 3600000 }),
          plain = { ...care, pause: null, jobs: [{ ...care.jobs[0], status: 'running', request: null, cards: [] }] };
        office.threads = hours
          ? [
              { ...plain, id: 'office/late', name: 'Later', outlook: at(hours[0]) },
              { ...plain, id: 'office/soon', name: 'Sooner', outlook: at(hours[1]) },
              { ...backups, id: 'office/held', name: 'Held' },
            ]
          : window.officeThreads;
        await (await import('/shell/projects.js')).openProjects();
      }, hours);
    // (the names once the load that lists `last` last is painted)
    const listed = async last => {
      await until(page, `${box('[data-thread]')}:last-child b`, new RegExp(`^${last}$`));
      return texts(page, `${box('[data-thread]')} b`);
    };
    await threeThreads([2, 1]);
    assert.deepEqual(await listed('Later'), ['Held', 'Sooner', 'Later'], `${at}: by when they're done`);
    assert.deepEqual(await marks(box('[data-thread]')), ['Paused', '', ''], `${at}: the waiting one marked`);
    await threeThreads([1, 2]);
    assert.deepEqual(await listed('Sooner'), ['Held', 'Later', 'Sooner'], `${at}: and re-sorted`);
    await threeThreads(null);
    await page.waitForSelector('[data-thread="office/audit"]');
    await tap(page, '[data-thread="office/audit"]');
    await level('The audit');
    // (a key set as asked, whichever way it stood)
    const press = async (key, on) => {
      if ((await page.getAttribute(`.pj-head ${key}`, 'aria-pressed')) !== String(on))
        await tap(page, `.pj-head ${key}`);
    };
    // what's done hides behind its key, and every review shows under its work however it stands; both reports open on
    // their cards' backs
    await press('[data-done]', false);
    assert.match((await texts(page, '.pj-head .pj-keys button'))[0], /^Done · \d+$/, at);
    assert.ok(!(await page.$('.pj-level [data-job="302"]')), `${at}: a finished task hidden`);
    assert.ok(await page.$('.pj-level .pj-step [data-job="304"]'), `${at}: a finished review under its work`);
    await press('[data-done]', true);
    for (const [id, report] of [
      ['302', 'All links answer'],
      ['304', 'Approved as it is'],
    ]) {
      await tap(page, `.pj-level [data-job="${id}"]`);
      await tap(page, '.pj-card [data-turn]');
      await page.waitForFunction(r => document.querySelector('.pj-card .pj-report')?.textContent.includes(r), report);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.pj-card'));
    }

    // a link to a job's report opens the projects view at it, and the view's own close goes back to the building
    const shut = () => page.waitForFunction(() => document.querySelector('#projects').hidden);
    await page.evaluate(async () => (await import('/shell/projects.js')).openProjects({ job: 44 }));
    await page.waitForFunction(() => document.querySelector('.pj-card h2')?.textContent.includes('building post'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.pj-card'));
    await tap(page, '#projects .pj-head [data-leave]');
    await shut();
    assert.ok(
      !(await page.evaluate(() => document.body.classList.contains('projects'))),
      `${at}: the building's controls are back`,
    );
    // the HUD's throughput, in tasks: done in the last day by the hour, at work and waiting, each opening the view; a tap
    // on the page round the view closes it
    await page.waitForSelector('#status [data-jobs]');
    assert.deepEqual(
      await page.$$eval('#status > span', s => s.map(e => e.dataset.jobs)),
      ['done', 'active', 'waiting'],
      at,
    );
    assert.equal(await page.$$eval('#status .flow-bars rect', r => r.length), 48, `${at}: 24 hours, tasks and reviews`);
    assert.deepEqual(
      await page.$$eval('#status > span', s => s.map(e => e.ariaLabel)),
      [
        '206 tasks and 371 reviews done in the last 24 hours, hour by hour',
        '13 at work: 9 tasks, 4 reviews',
        '58 waiting: 46 tasks, 12 reviews',
      ],
      at,
    );
    // the first visit's hint over the throughput, never on it, in each look's font (Wire shows none)
    assert.ok(
      await page.evaluate(() => {
        const hint = document.querySelector('#hint').getBoundingClientRect();
        return !hint.height || hint.bottom <= document.querySelector('#status').getBoundingClientRect().top + 0.5;
      }),
      `${at}: the hint clears the throughput`,
    );
    const opened = () => page.waitForFunction(() => !document.querySelector('#projects').hidden);
    await tap(page, '#status [data-jobs=done]');
    await opened();
    await tap(page, '#projects');
    await shut();
    await tap(page, '#status [data-jobs=waiting]');
    await opened();
    await tap(page, '#projects .pj-head [data-leave]');
    await shut();

    // A busy review keeps every colleague visible, the owner crowned, on project and thread tiles.
    await page.evaluate(async () => {
      const { loadProjects } = await import('/shell/data.js');
      const t = (await loadProjects(true)).projects[0].threads[1];
      const running = t.jobs.find(j => j.status === 'running');
      t.jobs.push(
        ...['kit', 'wren', 'nib', 'flint', 'sable'].map((agent, i) => ({
          ...running,
          id: 600 + i,
          agent,
        })),
      );
      await (await import('/shell/projects.js')).openProjects({ group: 'recurring' });
    });
    await level('Recurring');
    await tap(page, '[data-up]');
    await page.waitForSelector('[data-business=shopfront]');
    await tap(page, '[data-business=shopfront]');
    await level('The shopfront');
    await tap(page, '[data-project=shop]');
    await level('The sticker shop');
    for (const selector of [box('[data-thread="shop/wrap"]'), '[data-project=shop]']) {
      const visible = await page.$eval(selector, tile => {
        const bounds = tile.getBoundingClientRect();
        const faces = [...tile.querySelectorAll('.pj-face')];
        return {
          faces: faces.length >= 6,
          crowned: tile.matches('[data-project]') ? tile.querySelectorAll('.pj-owner .pj-crown').length === 1 : true,
          inside: faces.every(face => {
            const r = face.getBoundingClientRect();
            return r.left >= bounds.left && r.right <= bounds.right && r.bottom <= bounds.bottom;
          }),
        };
      });
      assert.deepEqual(
        visible,
        { faces: true, crowned: true, inside: true },
        at + ': the owner and all workers visible in ' + selector,
      );
      if (selector.includes('data-thread')) {
        await tap(page, '[data-up]');
        await level('The shopfront');
      }
    }
    assert.deepEqual(errors, [], at);
    await page.close();
  }
await browser.close();
server.close();
console.log(`projects-check: all good (${RENDERERS.length} looks × phone and tablet). Screenshots: ${out}`);
