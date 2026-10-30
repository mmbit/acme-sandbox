// node --test shared/scrapchart/chart.test.mjs
// The chart kit at its export: a line and a bar chart, and nothing drawn without a source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartSvg } from './chart.js';

const PEN = {
  kind: 'line',
  title: 'Pen lag on the iPad mini',
  unit: 'ms',
  series: [
    ['Thu', 46],
    ['Fri', 44],
    ['Wed', 17],
  ],
  source: "HQ's speed checker,\n last 7 days",
};

test('a chart with no source is refused, whatever else it has', () => {
  for (const source of [undefined, '', '   ', 7])
    assert.throws(() => chartSvg({ ...PEN, source }), /says where its numbers came from/);
});

test('a line chart: its title, unit, a ring a point and the last number', () => {
  const svg = chartSvg(PEN);
  assert.match(svg, /^<svg [^>]*width="400" height="230"/);
  assert.match(svg, />Pen lag on the iPad mini</);
  assert.match(svg, />ms</);
  assert.equal(svg.match(/<circle cx=.+? r="3.5"/g)?.length, 3);
  assert.match(svg, /font-weight="700"[^>]*>17</);
});

test('a bar chart: a bar a value from zero, each with its number; text is escaped', () => {
  const svg = chartSvg({
    ...PEN,
    kind: 'bar',
    title: 'Scraps <answered>',
    series: [
      ['Mon', 12],
      ['Tue', 0],
    ],
  });
  assert.equal(svg.match(/fill="none" stroke="#1d1b17"/g)?.length, 2);
  assert.match(svg, />Scraps &lt;answered&gt;</);
  assert.doesNotMatch(svg, /<answered>/);
});

test('a chart takes a kind, a title and a series of labelled numbers, and no more of them than fit', () => {
  assert.throws(() => chartSvg({ ...PEN, kind: 'pie' }), /kind/);
  assert.throws(() => chartSvg({ ...PEN, title: '' }), /title/);
  assert.throws(() => chartSvg({ ...PEN, series: [['Thu', 'many']] }), /series/);
  assert.throws(() => chartSvg({ ...PEN, series: [['Thu', 1]] }), /series/, 'a line needs two points');
  const series = length => Array.from({ length }, (_, i) => [String(i), i]);
  assert.match(chartSvg({ ...PEN, series: series(200) }), /<polyline/, 'a long line fits a point a pixel');
  assert.throws(() => chartSvg({ ...PEN, kind: 'bar', series: series(200) }), /series/);
  assert.throws(() => chartSvg({ ...PEN, title: 'Pen lag on the iPad mini, '.repeat(2) }), /title/);
});
