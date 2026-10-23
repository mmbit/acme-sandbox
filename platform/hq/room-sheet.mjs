// What HQ's room preview (room-preview.mjs) leaves: a labelled contact sheet of a room kind's shots, drawn in Chromium,
// the index of every file, and the record of what was shot that the author keeps in the branch.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// A grid of shots, a row for each state and a column for each setting (each shot { row, column, png, caption }: a
// caption for a shot that isn't quite what its column says), with a title and notes above it, as a PNG. The shots go
// on at their own size, every pixel as it was.
export async function contactSheet(browser, { title, notes, rows, shots }) {
  const page = await browser.newPage(),
    columns = [...new Set(shots.map(s => s.column))],
    cells = shots.map(s => ({
      row: s.row,
      column: columns.indexOf(s.column),
      caption: s.caption,
      url: `data:image/png;base64,${s.png.toString('base64')}`,
    }));
  try {
    const url = await page.evaluate(draw, { title, notes, rows, columns, cells });
    return Buffer.from(url.split(',')[1], 'base64');
  } finally {
    await page.close();
  }
}

// In the page: the sheet on a canvas. Rows as tall as their tallest shot, columns as wide as their widest
async function draw({ title, notes, rows, columns, cells }) {
  const GAP = 16,
    LABEL_W = 220,
    INK = '#ece8e0',
    MUTED = '#a39e94',
    FONT = 'sans-serif';
  for (const c of cells) c.img = Object.assign(new Image(), { src: c.url });
  await Promise.all(cells.map(c => c.img.decode()));
  const width = columns.map((_, k) => Math.max(...cells.filter(c => c.column === k).map(c => c.img.width))),
    height = rows.map((_, k) => Math.max(...cells.filter(c => c.row === k).map(c => c.img.height)));
  const g = document.createElement('canvas').getContext('2d');
  const wrap = (text, w, font) => {
    g.font = font;
    const lines = [''];
    for (const word of text.split(' ')) {
      const line = lines.at(-1) ? `${lines.at(-1)} ${word}` : word;
      if (g.measureText(line).width > w && lines.at(-1)) lines.push(word);
      else lines[lines.length - 1] = line;
    }
    return lines;
  };
  const heads = columns.map((c, k) => wrap(c, width[k], `15px ${FONT}`)),
    headH = Math.max(...heads.map(h => h.length)) * 20 + GAP,
    top = 48 + notes.length * 22 + GAP;
  const W = LABEL_W + width.reduce((s, w) => s + w + GAP, GAP),
    H = top + headH + height.reduce((s, h) => s + h + GAP, GAP);
  Object.assign(g.canvas, { width: W, height: H });
  g.fillStyle = '#16181d';
  g.fillRect(0, 0, W, H);
  const say = (text, x, y, font, colour = INK) => Object.assign(g, { font, fillStyle: colour }).fillText(text, x, y);
  say(title, GAP, 34, `bold 26px ${FONT}`);
  notes.forEach((n, k) => say(n, GAP, 64 + k * 22, `16px ${FONT}`, MUTED));
  const xs = width.map((_, k) => LABEL_W + GAP + width.slice(0, k).reduce((s, w) => s + w + GAP, 0)),
    ys = height.map((_, k) => top + headH + GAP + height.slice(0, k).reduce((s, h) => s + h + GAP, 0));
  heads.forEach((lines, k) => lines.forEach((l, i) => say(l, xs[k], top + 16 + i * 20, `15px ${FONT}`)));
  rows.forEach((r, k) =>
    wrap(r, LABEL_W - GAP, `bold 16px ${FONT}`).forEach((l, i) => say(l, GAP, ys[k] + 18 + i * 21, g.font)),
  );
  for (const c of cells) {
    g.fillStyle = '#23262e';
    g.fillRect(xs[c.column], ys[c.row], width[c.column], height[c.row]);
    g.drawImage(c.img, xs[c.column], ys[c.row]);
    if (c.caption) {
      g.fillStyle = '#000000b0';
      g.fillRect(xs[c.column], ys[c.row], width[c.column], 22);
      say(c.caption, xs[c.column] + 6, ys[c.row] + 16, `14px ${FONT}`);
    }
  }
  return g.canvas.toDataURL();
}

// index.md under --out: each kind's sheet and every shot, with what it shows, and any errors its pages had
export function index(previews) {
  const kinds = previews.map(p => [
    `## ${p.room.name} (${p.kind})`,
    '',
    `Sheet: ${p.sheet}`,
    '',
    ...p.shots.map(s => `- ${s.file}: ${s.state.name}; ${s.column}${s.caption ? `; ${s.caption}` : ''}`),
    ...(p.errors.length ? ['', 'Errors in the pages:', '', ...p.errors.map(e => `- ${e}`)] : []),
    '',
  ]);
  return ['# Room previews', '', ...kinds.flat()].join('\n');
}

// The record in the branch: what was rendered and shot (no pictures), and a line a kind for what its author saw
export async function writeRecord(path, previews, { branch, commit, dirty, command }) {
  const kinds = previews.map(p => [
    `## ${p.room.name} (${p.kind})`,
    '',
    `Sheet: ${p.sheet}`,
    '',
    '| State | Look | Setting | Colourway | Place |',
    '| --- | --- | --- | --- | --- |',
    ...p.shots.map(
      s =>
        `| ${[s.state.name, s.look.name, `${s.setting.name}, ${s.setting.when}`, s.colourway, s.caption ? `${s.place}, ${s.caption}` : s.place].join(' | ')} |`,
    ),
    '',
  ]);
  const record = [
    `# Room previews of ${branch}`,
    '',
    `Rendered from ${commit}${dirty ? ' and uncommitted changes' : ''} with \`${command}\`.`,
    '',
    ...kinds.flat(),
    '## What I saw',
    '',
    ...previews.map(p => `- ${p.kind}, ${[...new Set(p.shots.map(s => s.setting.name))].join(': / ')}: `),
    '',
  ];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, record.join('\n'));
}
