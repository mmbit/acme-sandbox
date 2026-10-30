# Scrap charts


A chart from your company's data, drawn in the notebook's line look (one ink, dots for shade, the paper bare), for an
answer on a board's scrap: "is the pen getting faster?" answered with the graph. A line or a bar chart, its title and
unit over it. Numbers always say where they came from: the chart's source goes with the answer (`--source`), and the
book shows it under the picture, so a chart with no source isn't drawn.

```json
{
  "kind": "line",
  "title": "Pen lag on the iPad mini",
  "unit": "ms",
  "series": [
    ["Thu", 46],
    ["Fri", 44],
    ["Sat", 39],
    ["Wed", 17]
  ],
  "source": "HQ's speed checker, last 7 days"
}
```

```sh
node shared/scrapchart/draw.mjs chart.json chart.png
hq answer <note> "Yes: down to 17 ms from 46 a week ago" --picture chart.png --source "HQ's speed checker, last 7 days"
```

- `kind`: `line` (two points or more) or `bar`; `series`: `[label, number]` pairs in order, as many as fit the
  chart's width (about 40 bars, or a point a pixel). A long series labels every few points and the last. The title and
  unit fit one line over the chart.
- `source`: one line naming the place you read the numbers from (a tool, a table, a report) and the time they cover.
  `draw.mjs` prints the `hq answer` line with it as `--source`.
- The PNG is a scrap answer's width (400 × 230 CSS px) at twice the pixels, so it's sharp on a tablet.
- `chartSvg(spec)` in `chart.js` gives the SVG itself, for a page that shows it inline. It throws on a spec it can't
  draw, saying what's missing.

`node --test shared/scrapchart/chart.test.mjs` runs its tests.
