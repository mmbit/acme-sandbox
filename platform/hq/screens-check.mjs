#!/usr/bin/env node
// HQ's screens, all of them, for a look over by eye: every tool, every computer app and Settings section, an agent's
// panel and a preview, on a phone, a tablet and a desktop, in light and dark. Each is saved as a picture, and the check fails on
// a console error, a button whose words (or icon) hardly stand out from what's behind them, a control whose face
// hardly stands out from what it sits on, a choice in a row of choices that wraps or is cut off, or, on the computer's
// screen, a row or tile whose hover box (its outline included) cuts through words outside it.
//   node platform/hq/screens-check.mjs [renderer] [--out <folder>]   (the company's renderer by default; /tmp/hq-screens)
// Dev mode on the mock data, with the company's own theme (theme/hq.yaml) when the repo has one.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mockBrand, mockFiles, serve } from './serve.mjs';
import { contrastChannels } from '../../shared/contrast/contrast.js';
import { playwright } from '../../shared/browser/browser.mjs';

const args = process.argv.slice(2),
  outAt = args.indexOf('--out'),
  OUT = outAt >= 0 ? args.splice(outAt, 2)[1] : '/tmp/hq-screens';
const RENDERER = args[0] ?? (await mockBrand()).theme.renderer;
const server = await serve(undefined, 0, await mockFiles());
const url = `http://localhost:${server.address().port}/?renderer=${RENDERER}&intro=0&hour=12&weather=clear`;

const VIEWS = {
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  tablet: { viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  desktop: { viewport: { width: 1280, height: 800 } },
};
// (a sketch full screen goes back to the Sketchbook first)
const close = page =>
  page.evaluate(() =>
    [
      document.querySelector('dialog.sk-page[open] [data-back]'),
      document.querySelector(
        '#tool:not([hidden]) [data-close], #viewer:not([hidden]) [data-close], #panel:not([hidden]) #panel-close, .wire .big .close, #projects:not([hidden]) [data-leave]',
      ),
    ].forEach(button => button?.click()),
  );
const app = name => async page => {
  await page.click('#btn-computer');
  await page.click(`[data-app="${name}"]`);
};
const SCREENS = {
  home: async () => {},
  phone: page => page.click('#btn-desk'),
  // a card's answer keys, and its Later menu
  card: async page => {
    await page.click('#btn-desk');
    await page.locator('.req .questions .chip').first().scrollIntoViewIfNeeded();
  },
  'card-later': async page => {
    await page.click('#btn-desk');
    await page.click('[data-later]');
  },
  news: page => page.click('#btn-news'),
  intercom: page => page.click('#btn-intercom'),
  computer: page => page.click('#btn-computer'),
  projects: page => page.click('#btn-projects'), // (the HUD's own key)
  ...Object.fromEntries(
    ['numbers', 'artifacts', 'people', 'calls', 'notes', 'mail', 'seats', 'settings'].map(a => [a, app(a)]),
  ),
  // the Sketchbook, and a sketch full screen
  sketchbook: app('sketchbook'),
  'sketchbook-page': async page => {
    await app('sketchbook')(page);
    await page.click('[data-open]');
    await page.waitForSelector('dialog.sk-page[open]');
  },
  // the photo studio's Approvals, and an approved photo big in its History
  studio: app('studio'),
  'studio-big': async page => {
    await app('studio')(page);
    await page.click('[data-tab=history]');
    await page.click('[data-rows=history] button');
  },
  ...Object.fromEntries(
    ['seats', 'alerts', 'overseer', 'look'].map(s => [
      // (Settings › Seats; the Overseer's page)
      `settings-${s}`,
      async page => {
        await app('settings')(page);
        await page.click(`[data-section="sys:${s}"]`);
      },
    ]),
  ),
  // an app's dashboard and a company's, with their rows of choices
  'numbers-app': async page => {
    await app('numbers')(page);
    await page.click('[data-nx-app][data-status="live"]');
  },
  'numbers-dashboard': async page => {
    await app('numbers')(page);
    await page.click('[data-nx-company]');
  },
  agent: page =>
    page.evaluate(() => {
      const A = [...window.hq.world.agents.values()].find(a => !a.data.board);
      return import('/shell/panel.js').then(p => p.openAgent(A));
    }),
  // Wire's big key: a key tapped, and tapped again to turn it over, and the rig's (none on a look without keys)
  key: page => page.click('.wire .key.agent'),
  'key-back': async page => {
    await page.click('.wire .key.agent');
    await page.waitForTimeout(600);
    await page.click('.wire .big .doing');
  },
  'key-rig': page => page.click('.wire .key.machine'),
  preview: page =>
    page.evaluate(() => {
      const a = Object.assign(document.createElement('a'), { href: 'https://hello.preview.example.com/' });
      document.body.append(a);
      a.click();
      a.remove();
    }),
};

// Every visible control and link with the colours the browser drew it in: its words, its outline, and the background
// of it and of each element it sits in, innermost first, and every engine's mark (shell/engine.js), held to its words'
// contrast. The checks below work on these in Node.
// (the marks)
const WORDS = 'button, a[href], [role=button]';
const MARKS = '.mark[role=img]';
const FACES =
  'button, [role=button], select, textarea, input:not([type=checkbox], [type=radio], [type=range], [type=hidden])';
const controlsOnScreen = page =>
  page.evaluate(
    ([words, faces, marks]) => {
      const out = [];
      for (const el of document.querySelectorAll(`${words}, ${faces}, ${marks}`)) {
        const r = el.getBoundingClientRect(),
          s = getComputedStyle(el);
        if (!r.width || !r.height || s.visibility === 'hidden' || +s.opacity < 0.5 || el.closest('[hidden]')) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const backgrounds = [];
        for (let e = el; e; e = e.parentElement) backgrounds.push(getComputedStyle(e).backgroundColor);
        out.push({
          name: `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} “${(el.textContent.trim() || el.getAttribute('aria-label') || '').slice(0, 30)}”`,
          drawn: el.matches(marks) || (el.matches(words) && Boolean(el.textContent.trim() || el.querySelector('svg'))),
          faced: el.matches(faces),
          color: s.color,
          border: s.borderTopColor,
          borderWidth: parseFloat(s.borderTopWidth),
          backgrounds,
        });
      }
      return out;
    },
    [WORDS, FACES, MARKS],
  );

// Every button, link and mark whose words (or icon, drawn in its colour) are under 3:1 against the first solid colour behind
// them (the marks)
const lowContrast = controls =>
  controls
    .filter(c => c.drawn)
    .flatMap(c => {
      const ratio = contrastChannels(rgba(c.color).slice(0, 3), firstSolid(c.backgrounds));
      return ratio < 3 ? [`${c.name} ${ratio.toFixed(1)}:1`] : [];
    });

// Every control whose face (its fill, laid over what's behind it) is under 1.05:1 against the first solid colour behind
// it, with no outline of 3:1 to set it apart either: a key on a panel of its own colour. A control without a fill is
// words, the check above.
const lowFace = controls =>
  controls
    .filter(c => c.faced && rgba(c.backgrounds[0])[3])
    .flatMap(c => {
      const fill = rgba(c.backgrounds[0]),
        under = firstSolid(c.backgrounds.slice(1)),
        ratio = contrastChannels(over(fill, under), under),
        outlined = c.borderWidth >= 1 && contrastChannels(over(rgba(c.border), under), under) >= 3;
      return ratio < 1.05 && !outlined ? [`${c.name} ${ratio.toFixed(2)}:1`] : [];
    });

// A computed colour as [r, g, b, a], channels 0 to 255: a color-mix() comes back as color(srgb r g b / a), its channels
// 0 to 1
const rgba = css => {
  const [r, g, b, a = 1] = (css.match(/[\d.]+/g) ?? []).map((n, i) =>
    css.startsWith('color(') && i < 3 ? n * 255 : Number(n),
  );
  return [r, g, b, a];
};
// The first background that mostly hides what's behind it, white past the page's own
const firstSolid = backgrounds => {
  const solid = backgrounds.map(rgba).find(c => c[3] > 0.5);
  return solid ? solid.slice(0, 3) : [255, 255, 255];
};
const over = ([r, g, b, a], under) => [r, g, b].map((c, i) => c * a + under[i] * (1 - a));

// Every choice in a row of choices that is cut off by the row, and every short one (a period, a mode, a level: two
// words at most) that wraps onto a second line. A sentence to tap may wrap.
const brokenChoices = page =>
  page.evaluate(() => {
    const out = [];
    for (const row of document.querySelectorAll('[role=group], [role=radiogroup], .seg')) {
      if (!row.checkVisibility({ visibilityProperty: true })) continue;
      const box = row.getBoundingClientRect();
      for (const el of row.querySelectorAll('button, label')) {
        if (!el.checkVisibility({ visibilityProperty: true }) || !el.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = new Set([...range.getClientRects()].filter(r => r.width).map(r => Math.round(r.bottom))),
          r = el.getBoundingClientRect();
        if (lines.size > 1 && el.textContent.trim().split(/\s+/).length <= 2)
          out.push(`“${el.textContent.trim().slice(0, 24)}” wraps`);
        if (r.right > box.right + 1 || r.left < box.left - 1 || r.right > innerWidth)
          out.push(`“${el.textContent.trim().slice(0, 24)}” is cut off`);
      }
    }
    return out;
  });

// On the computer's screen, every visible control whose box, a pixel wider for a hover outline, crosses words outside it
// (words it wholly holds are its own, like the front door's address).
const crossedWords = page =>
  page.evaluate(() => {
    const screen = document.querySelector('#crt');
    if (!screen) return [];
    const words = [];
    const walk = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode;
      if (!node.textContent.trim() || !node.parentElement.checkVisibility({ visibilityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width && r.height) words.push([node, r]);
    }
    const out = [];
    for (const el of screen.querySelectorAll('button, a, summary')) {
      if (!el.checkVisibility({ visibilityProperty: true })) continue;
      const b = el.getBoundingClientRect(),
        box = { left: b.left - 1, top: b.top - 1, right: b.right + 1, bottom: b.bottom + 1 };
      for (const [node, r] of words) {
        if (el.contains(node) || node.parentElement.contains(el)) continue;
        const held = r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
        const w = Math.min(box.right, r.right) - Math.max(box.left, r.left),
          h = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
        if (w > 1 && h > 1 && !held)
          out.push(`“${el.textContent.trim().slice(0, 24)}” crosses “${node.textContent.trim().slice(0, 24)}”`);
      }
    }
    return [...new Set(out)];
  });

await mkdir(OUT, { recursive: true });
const browser = await playwright().chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const problems = [];
for (const [view, device] of Object.entries(VIEWS))
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ ...device, colorScheme: scheme, serviceWorkers: 'block' });
    await ctx.route(/\.preview\.example\.com/, r => r.fulfill({ contentType: 'text/html', body: '<p>A preview</p>' }));
    const page = await ctx.newPage();
    page.on('pageerror', e => problems.push(`${view}/${scheme}: ${e.message}`));
    page.on(
      'console',
      m =>
        m.type() === 'error' &&
        !/404|Failed to load resource/.test(m.text()) &&
        problems.push(`${view}/${scheme}: ${m.text()}`),
    );
    await page.goto(url);
    await page.waitForFunction(() => window.hq, null, { polling: 100 });
    await page.waitForTimeout(1500);
    for (const [name, open] of Object.entries(SCREENS)) {
      if (name.startsWith('key') && !(await page.$('.wire'))) continue;
      try {
        await open(page);
        await page.waitForTimeout(700);
        await page.screenshot({ path: join(OUT, `${view}-${scheme}-${name}.png`) });
        const controls = await controlsOnScreen(page);
        for (const p of lowContrast(controls)) problems.push(`${view}/${scheme}/${name}: low contrast ${p}`);
        for (const p of await crossedWords(page)) problems.push(`${view}/${scheme}/${name}: hover box ${p}`);
        for (const p of lowFace(controls)) problems.push(`${view}/${scheme}/${name}: low face ${p}`);
        for (const p of await brokenChoices(page)) problems.push(`${view}/${scheme}/${name}: choice ${p}`);
      } catch (e) {
        problems.push(`${view}/${scheme}/${name}: couldn't open (${e.message.split('\n')[0]})`);
      }
      await close(page);
      await page.waitForTimeout(300);
    }
    await ctx.close();
  }
await browser.close();
server.close();
console.log(`screens-check: ${RENDERER}, pictures in ${OUT}`);
for (const p of [...new Set(problems)]) console.log(`  ${p}`);
process.exit(problems.length ? 1 : 0);
