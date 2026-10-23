// node --test platform/hq/shell/tiles.test.js   (Apps' groups and a tile's markup, as plain functions; no DOM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appGroups, appTile } from './tiles.js';

const apps = [
  { slug: 'pals', status: 'live' },
  { slug: 'front', status: 'live', front: true },
  { slug: 'moon', status: 'test' },
  { slug: 'shop', status: 'demo' },
  { slug: 'hq', status: 'live', platform: true },
];
const shown = groups => groups.map(g => [g.caption ?? g.kind, g.apps.map(a => a.slug)]);

test("without the company's groups: the front door first, then our apps, the demos and the platform", () => {
  assert.deepEqual(shown(appGroups(apps)), [
    ['front', ['front']],
    ['ours', ['pals', 'moon']],
    ['demos', ['shop']],
    ['platform', ['hq']],
  ]);
});

test("the company's groups in its order, the front door before them and what they leave out after", () => {
  const wanted = [
    { caption: 'Platform', apps: ['hq', 'front'] },
    { caption: 'Prints', apps: ['moon', 'no-such-app', 'pals'] },
    { caption: 'Again', apps: ['moon'] },
    { caption: 'Not a list', apps: 'pals' },
    'not a group',
  ];
  assert.deepEqual(shown(appGroups(apps, wanted)), [
    ['front', ['front']],
    ['Platform', ['hq']],
    ['Prints', ['pals', 'moon']],
    ['demos', ['shop']],
  ]);
});

test("a tile's tooltip is its title when given, its words otherwise; the link outside it follows the open one", () => {
  const app = { name: 'Front Door', about: 'Our front page.' };
  assert.match(
    appTile(app, {
      href: 'https://front.preview',
      title: 'Our front page.\nOwner: Kit',
      after: '<a class="public">x</a>',
    }),
    /^<li data-tile="front door"><a class="open" href="https:\/\/front.preview" title="Our front page.\nOwner: Kit">.*<\/a><a class="public">x<\/a><\/li>$/s,
  );
  assert.match(appTile(app, { href: 'https://front.preview' }), /title="Our front page\."/);
});
