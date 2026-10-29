// The board picks one of a try's versions: it rings a version on its page, or ticks it, and that's the pick. Nothing
// here reads the ink's shape: the ink goes as a reply on the version (notebooksend.ts replyTo), drawn over the version's
// frame in its picture (replySnip), and the book's judge (bookjudge.ts) reads it as it reads any symbol, with the
// verdict 'pick' when the board chose that version.
//   - A pick is one per try: the version picked (book_slips.picked) and the others in its set unpicked. HQ stamps it.
//   - Its frame and patch join the note: the note the tried group goes as when its page is sent carries the frame in
//     its snip (sentSnip), and the job it goes to reads the pick and its patch (withPicks). A try run still going hears
//     it at once; on a call, the call's agent hears it (callanswer.ts heardOnCall, bookcalls.ts newsOf).
import { readFileSync } from 'node:fs';
import { db } from '../db.ts';
import { publish } from '../events.ts';
import { forRun } from '../messages.ts';
import { changed, pageRow, triesPageOfNote } from '../notebook.ts';
import { groupOfNote, partsOf, row, type Group } from '../notebookgroups.ts';
import { boxOf } from '../../../hq/shell/ink/notebookstack.js';
import { DIR } from '../pagescraps.ts';
import type { Stroke } from '../pagechecks.ts';
import { note, type Note } from './booknotes.ts';
import { render } from './bookrender.ts';
import type { Slip } from './bookslips.ts';
import { pictureSize } from '../../../../shared/pictures/size.ts';

// Room round what a snip shows, in page px; the gap between a group and its picked version beside it
const PAD = 24,
  GAP = 32;
// The most of a picked version's patch quoted to the job it goes to (a try's patch is a few kB; one longer is the
// frame's to show, and the try's to make again)
const PATCH_QUOTED = 20_000;
// A frame's sides as HQ may send them, page px
const FRAME_MAX = 4000;

type Box = { x: number; y: number; w: number; h: number };
const slipById = (id: number | null) =>
  id ? (db.prepare('select * from book_slips where id = ?').get(id) as Slip | undefined) : undefined;
const isVersion = (s: Slip | undefined): s is Slip => !!s && s.style === 'version';

// ---------------------------------------------------------------- the reply's picture
// A frame HQ sent with a reply: the box the version's picture shows in, in its page's px, or null for none fit to use
export function frameOf(v: unknown): Box | null {
  const f = v as Box | null;
  if (!f || typeof f !== 'object') return null;
  const ok = (n: unknown, max: number, min = -max) =>
    typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  return ok(f.x, 1e5) && ok(f.y, 1e5) && ok(f.w, FRAME_MAX, 1) && ok(f.h, FRAME_MAX, 1)
    ? { x: f.x, y: f.y, w: f.w, h: f.h }
    : null;
}
// A reply's ink on a version, drawn over the version's frame where the board saw it (frame: frameOf's), so the judge
// and the agent see what was ringed or ticked; null when the answer isn't a version with a picture, or there's no frame
export async function replySnip(answer: number, frame: Box | null, ink: Stroke[]) {
  const v = slipById(answer);
  if (!isVersion(v) || !v.picture || !frame) return null;
  const drawn = boxOf({ ink, texts: [], pictures: [] }) ?? frame;
  const x0 = Math.min(frame.x, drawn.x) - PAD,
    y0 = Math.min(frame.y, drawn.y) - PAD,
    x1 = Math.max(frame.x + frame.w, drawn.x + drawn.w) + PAD,
    y1 = Math.max(frame.y + frame.h, drawn.y + drawn.h) + PAD;
  const scraps = [{ file: v.picture, ...frame, tilt: 0 }];
  return { type: 'image/png', clean: await render({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, ink, scraps }, DIR) };
}

// ---------------------------------------------------------------- the pick
// The judge's verdict 'pick' on a board's reply (t.grp: the reply group; t.note: a reply note, on a version of an old
// book's note): the version it replies to picked. Returns the version picked, or null (not a reply on a version).
export function pickNow(t: { grp?: number; note?: number }) {
  const reply = t.grp ? row(t.grp) : undefined;
  const answers = reply?.kind === 'reply' ? reply.answers : !t.grp && t.note ? note(t.note)?.answers : null;
  const v = slipById(answers ?? null);
  return isVersion(v) ? pick(v) : null;
}
// A version picked, by the judge's pick or the board's tick (bookanswer.ts tickAnswer): the rest of its set not, as one
// per try is all a job can build; the pages, the try run and a call told. Picked already: nothing new to tell.
export function pick(v: Slip) {
  if (v.picked) return v.id;
  db.prepare(
    `update book_slips set picked = case when id = ? then ? else null end
      where style = 'version' and (id = ? or (grp is not null and grp = ?) or (note is not null and note = ?))`,
  ).run(v.id, new Date().toISOString(), v.id, v.grp, v.note);
  // (the note tried: a group, on its page and its versions page; or an old book's note, a call's, on its versions page.
  const root = v.grp !== null ? row(v.grp) : undefined;
  const p = root && pageRow(root.page, null);
  if (p && p.notebook !== null) changed(p.notebook, p.id);
  const tries = root
    ? (db.prepare('select id, notebook from book_pages where tries = ?').get(root.id) as
        { id: number; notebook: number | null } | undefined)
    : v.note !== null
      ? triesPageOfNote(v.note)
      : undefined;
  if (tries && tries.notebook !== null) changed(tries.notebook, tries.id);
  publish({ type: 'book', agent: v.by, text: 'slip' });
  const tried = root
    ? (root as Group & { tried?: number | null }).tried
    : v.note !== null
      ? (db.prepare('select tried from book_notes where id = ?').get(v.note) as { tried: number | null } | undefined)
          ?.tried
      : null;
  toTry(tried ?? null, v);
  const on = root ? { grp: root.id } : v.note !== null ? { note: v.note } : null;
  // (loaded when it's needed, as bookanswer.ts does: the call's file reads the answers, which read the send's)
  if (on) void import('./callanswer.ts').then(m => m.heardOnCall(on));
  return v.id;
}
// A try run still going hears the pick at its next step (it makes no more versions of what's settled)
function toTry(tried: number | null, v: Slip) {
  const run = tried
    ? (db.prepare("select id from jobs where id = ? and status = 'running'").get(tried) as { id: number } | undefined)
    : undefined;
  if (run)
    forRun(
      v.by,
      `The board picked your version “${v.version ?? v.id}”: no more versions of this one are needed.`,
      run.id,
    );
}

// The version picked on a group (a board's note that was tried), if one is
export const pickedOn = (grp: number) =>
  db
    .prepare("select * from book_slips where grp = ? and style = 'version' and picked is not null order by picked desc")
    .get(grp) as Slip | undefined;

// ---------------------------------------------------------------- with the page
// The group's snip as its note takes it when its page is sent: the group, and its picked version's frame beside it
// (null: no version picked, the group's own snip stands)
export async function sentSnip(g: Group) {
  const v = pickedOn(g.id);
  const parts = partsOf(g),
    box = boxOf(parts);
  if (!v?.picture || !box) return null;
  const seen = pictureSize(readFileSync(`${DIR}/${v.picture}`))!;
  const w = Math.max(box.w, 320),
    h = Math.round((w * seen.height) / seen.width);
  const frame = { x: box.x + box.w + GAP, y: box.y, w, h };
  return {
    type: 'image/png',
    clean: await render(
      {
        x: box.x - PAD,
        y: box.y - PAD,
        w: box.w + GAP + w + 2 * PAD,
        h: Math.max(box.h, h) + 2 * PAD,
        ink: parts.ink as never,
        scraps: [...parts.pictures, { file: v.picture, ...frame, tilt: 0 }],
        texts: parts.texts as never,
      },
      DIR,
    ),
  };
}
// Each note's text for the job it goes to, with the version the board picked on it (the note a tried group went as, or
// a reply on a version) and that version's patch
export function withPicks(notes: Note[], texts: string[]) {
  return texts.map((text, i) => {
    const n = notes[i];
    const own = groupOfNote(n.id);
    const answered = slipById(n.answers);
    const v = (own && pickedOn(own.id)) || (isVersion(answered) && answered.picked ? answered : undefined);
    return v ? `${text}\n${pickedLine(v)}` : text;
  });
}
function pickedLine(v: Slip) {
  const patch = v.patch ? readFileSync(`${DIR}/${v.patch}`, 'utf8') : null;
  const said = `The board picked the version “${v.version ?? v.id}” (${v.text || 'its frame'}): build that one${
    v.picture ? '; its frame is in the note’s picture' : ''
  }.`;
  return patch ? `${said} Its patch, from the try (start from it):\n${quotedPatch(patch)}` : said;
}
// A version's patch as a brief quotes it (booktry.ts's too: a reply on a version)
export function quotedPatch(patch: string) {
  const quoted =
    patch.length > PATCH_QUOTED ? `${patch.slice(0, PATCH_QUOTED)}\n… (cut: the rest as the frame shows)` : patch;
  return `\`\`\`diff\n${quoted}\n\`\`\``;
}
