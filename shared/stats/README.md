# Stats

Statistics in plain SVG, and the motion that brings them in: a figure's last days as bars, a few measures over time as
lines on one graph, figures that roll like a slot machine's and bars that grow back up from their baseline. HQ's Slate
look drew these first. Nothing here has a colour, a word or a sound: the page's CSS colours the marks by their classes
(`.bars rect`, `.now` for the last, `.none` for one not counted yet; `.lines g.<name>` for a series), and the page plays
its own sound when a count is done. With reduced motion asked for, nothing moves and `onDone` still runs.

```js
import { bars, lineGraph, compact, growBars, rollFigures } from '/shared/stats/stats.js';

stat.innerHTML = `<b class="figure">${compact(12_900)}</b>${bars(days, { tips })}`; // today on the right
graph.innerHTML = lineGraph([
  { name: 'cpu', values: cpu },
  { name: 'memory', values: memory },
]);
growBars(tile);
rollFigures(tile.querySelectorAll('.figure'), { onDone: () => play('land') });
```

- `bars(values, { width, height, tips, stubs, scale })`: a bar per value; `null` is a day not counted yet, a stub
  (`stubs: false` leaves it out); `scale` fixes the top (100 for percentages), else the highest value is.
- `lineGraph(series, { scale })`: a line per series, ending on a dot. Its points are percentages of the svg's own box,
  never a stretched viewBox (Safari thickens a stretched line whatever `vector-effect` says), so the page sizes the svg
  and keeps it clear of the graph's edges (an inset with `overflow: visible`): a line at 0 then reads as a line, not
  as the graph's border.
- `compact(n)`: 940, 1.2k, 12k.

The timings and sizes are exported (`GROW_MS`, `GROW_STAGGER_MS`, `COUNT_MS`, `BAR_SHARE`, `BAR_MIN_PX`,
`DOT_RADIUS_PX`), so a design system can state them.

```sh
node --test shared/stats/stats.test.mjs
```
