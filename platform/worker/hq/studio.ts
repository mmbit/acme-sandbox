// hq studio: the photo studio's photos (platform/coordinator/src/studio.ts), for its keeper to edit and check, and for
// any agent to use once the board has approved them.
import * as api from './api.ts';
import { savePrivately } from './files.ts';
import { takeRepeated, takeValues } from './flags.ts';
import { minute, print, stop, text } from './output.ts';

const USAGE = 'usage: hq studio [request|add|original|edit|ready|stop|return|placed|get|record] ...: see hq for each';

export const studio = {
  // (edit's --crop and --keep: request, add's --request, edit's --text, --fix and
  // --style, ready's --check, stop, return: edit's --turn: job #14464)
  help: `
   hq studio [--json]                                the photo studio's open shot requests and its photos still in play
                                                     (new, editing, edited, waiting for the board, approved), its keeper,
                                                     its styles and fixes, the month's spend
   hq studio request <product> --show "..." --page <url>... | --where "..."
                                                     ask for a product photo a page needs: what it must show, the pages
                                                     it goes on (up to 3) or where, for more. The keeper hears at once,
                                                     and works only on shots asked for
   hq studio add --card <id> [--field <n>] --request <id> --style <id> [--note "..."] [--text "..."]
                                                     a desk-phone card's product shots (one field, or every saved one)
                                                     into the studio for a request, for its keeper to develop; a check
                                                     photo never comes in
   hq studio original <id> [--turn 90|180|270]       the keeper's: save the board's photo to $TMPDIR to look at, turned
                                                     as the model gets it (--turn: that way, to measure boxes before)
   hq studio edit <id> [--note "..."]                the keeper's: the image model edits the photo now (it costs; HQ caps
                                                     the month), saved to $TMPDIR to compare with the original
      [--turn 90|180|270]                            the original turned clockwise first, for a shot taken sideways (0:
                                                     as taken); the photo keeps its turn for its later edits and the
                                                     board's flip, and --crop and --keep are in the turned pixels
      [--crop x,y,w,h]                               only that box of the original goes to the model: it frames the shot
      [--keep x,y,w,h]...                            that box of the original, pasted back over the edit where the model
                                                     put it, on its corners there (the model squares a photo up),
                                                     light matched: print too small for the model to copy (both in the
                                                     original's own pixels, as hq studio original saves it)
      [--text "..."]                                 the product's printed text, exactly (" / " between lines), for the
                                                     model; the photo keeps it for its later edits
      [--fix <id>]... [--style <id>]                 a fix from the studio's settings for this edit; the photo's style
   hq studio ready <id> [id...] --check "..."...     the keeper's: checked edits into the board's batch (the Studio app),
                                                     each with 1 to 3 short lines of what the board should check
   hq studio stop <id> --why "..."                   the keeper's: drop a photo no edit gets right (the board never sees
                                                     it); its request stays open for another
   hq studio return <request> --need "..."           the keeper's: hand a shot request back to whoever asked, with what
                                                     you need to make it work (a job for them)
   hq studio placed <id> <url> [url...]              the keeper's: the pages an approved photo is on, by their public
                                                     address (the board finds it by its page)
   hq studio get <id>                                an approved photo, as the board approved it, to $TMPDIR: the only
                                                     photos that may be used on the company's sites
   hq studio record [--json]                         every decision the board made: photo, product, when, the file's sha256`,

  async run([what = '', ...rest]: string[]) {
    if (what === '' || what === '--json') return list(what === '--json');
    if (what === 'request') return request(rest);
    if (what === 'add') return add(rest);
    if (what === 'original' || what === 'get') return save(what, rest);
    if (what === 'edit') return edit(rest);
    if (what === 'ready') return ready(rest);
    if (what === 'stop') return giveUp(rest);
    if (what === 'return') return giveBack(rest);
    if (what === 'placed') return placed(rest);
    if (what === 'record') return decisions(rest[0] === '--json');
    stop(USAGE);
  },
};

async function list(json: boolean) {
  const studio = await ask('studio');
  if (json) return print(JSON.stringify(studio, null, 2));
  const month = studio.month;
  print(
    `Keeper: ${text(studio.keeper)} · model ${text(studio.model)} at ${text(studio.size)}${studio.key ? '' : ' · NO KEY YET (its card is with the board)'}`,
    `This month: ${text(month.edits)} edits, $${Number(month.usd).toFixed(2)} of the $${text(month.cap_usd)} cap`,
    `Products: ${studio.products.map((p: any) => text(p.id)).join(', ')} · styles: ${studio.styles.map((s: any) => text(s.id)).join(', ')}` +
      ` · fixes: ${studio.fixes.map((f: any) => text(f.id)).join(', ') || 'none'}`,
    '',
    ...(studio.requests.length ? ['Asked for:'] : ['No shot requests open.']),
    ...studio.requests.map(
      (r: any) =>
        `request #${text(r.id)}  ${text(r.product)}, for ${text(r.where)}, from ${text(r.by)}: must show "${text(r.show)}"`,
    ),
    '',
  );
  if (!studio.photos.length) return print('No photos in the studio.');
  for (const p of studio.photos)
    print(
      `#${text(p.id)}  ${text(p.status).padEnd(8)}  ${text(p.product)}, ${text(p.style)}${p.request ? ` (request #${text(p.request)})` : ''}  (${text(p.tries)} ${p.tries === 1 ? 'edit' : 'edits'})` +
        `${p.turn ? `  turned ${text(p.turn)}°` : ''}${p.note ? `  "${text(p.note)}"` : ''}${p.text ? `  text: "${text(p.text)}"` : ''}${p.asked ? `  the board asks: "${text(p.asked)}"` : ''}` +
        `${p.checks.length ? `  checks: ${p.checks.map(text).join('; ')}` : ''}${p.error ? `  failed: ${text(p.error)}` : ''}`,
    );
}

const REQUEST_USAGE = 'usage: hq studio request <product> --show "..." (--page <url>... | --where "...")';
async function request(given: string[]) {
  const pages = takeRepeated(given, '--page', `${REQUEST_USAGE}: --page needs a value`),
    { values, args } = takeValues(pages.args, ['--show', '--where'], REQUEST_USAGE);
  if (args.length !== 1 || !values.show) stop(REQUEST_USAGE);
  const asked = await ask('studio/request', {
    product: args[0],
    show: values.show,
    pages: pages.values,
    where: values.where,
  });
  print(`Shot request #${text(asked.id)}: ${text(asked.keeper)} hears at once, as a job.`);
}

async function add(given: string[]) {
  const { values } = takeValues(given, ['--card', '--field', '--request', '--style', '--note', '--text'], USAGE);
  if (!/^[0-9]+$/.test(values.card ?? '') || !/^#?[0-9]+$/.test(values.request ?? '') || !values.style)
    stop('usage: hq studio add --card <id> [--field <n>] --request <id> --style <id> [--note "..."] [--text "..."]');
  const added = await ask('studio/add', {
    card: Number(values.card),
    field: values.field == null ? undefined : Number(values.field),
    request: Number(values.request!.replace('#', '')),
    style: values.style,
    note: values.note,
    text: values.text,
  });
  print(`Added to the studio: ${added.ids.map((id: number) => `#${id}`).join(', ')}. Its keeper gets them as a job.`);
}

async function save(what: 'original' | 'get', given: string[]) {
  const usage = `usage: hq studio ${what} <id>${what === 'original' ? ' [--turn 90|180|270]' : ''}`,
    { values, args } = takeValues(given, what === 'original' ? ['--turn'] : [], usage),
    id = args[0] ?? '';
  if (args.length !== 1 || !/^#?[0-9]+$/.test(id)) stop(usage);
  const n = id.replace('#', ''),
    turn = values.turn == null ? '' : `&turn=${encodeURIComponent(values.turn)}`,
    picture = await ask(`studio/picture?id=${n}&which=${what === 'get' ? 'approved' : 'original'}${turn}`);
  const path = savePrivately(
    `studio-${n}-${what === 'get' ? 'approved' : 'original'}`,
    picture.type === 'image/png' ? 'png' : 'jpg',
    Buffer.from(text(picture.data), 'base64'),
  );
  const approved = picture.approved
    ? `, approved by ${text(picture.approved.by)} ${minute(text(picture.approved.at))}`
    : '';
  print(
    `Photo #${n} (${text(picture.product)}${approved}${picture.turn ? `, turned ${text(picture.turn)}° clockwise` : ''}) → ${path}`,
    ...(approved ? [`sha256 ${text(picture.sha256)}`] : []),
  );
}

// (--crop, --keep); job #14307 (--text, --fix, --style); job #14464 (--turn)
const EDIT_USAGE =
  'usage: hq studio edit <id> [--note "..."] [--turn 90|180|270] [--crop x,y,w,h] [--keep x,y,w,h]... [--text "..."] [--fix <id>]... [--style <id>]';
async function edit(given: string[]) {
  const keeps = takeRepeated(given, '--keep', `${EDIT_USAGE}: --keep needs a value`),
    fixes = takeRepeated(keeps.args, '--fix', `${EDIT_USAGE}: --fix needs a value`),
    { values, args } = takeValues(fixes.args, ['--note', '--turn', '--crop', '--text', '--style'], EDIT_USAGE),
    id = (args[0] ?? '').replace('#', '');
  if (!/^[0-9]+$/.test(id)) stop(EDIT_USAGE);
  print(`Photo #${id}: in the image model (this takes up to a few minutes)...`);
  const edited = await ask('studio/edit', {
    id: Number(id),
    note: values.note,
    turn: values.turn,
    crop: values.crop,
    keep: keeps.values,
    text: values.text,
    fixes: fixes.values,
    style: values.style,
  });
  const path = savePrivately(
    `studio-${id}-edit-${text(edited.edit)}`,
    edited.type === 'image/png' ? 'png' : 'jpg',
    Buffer.from(text(edited.data), 'base64'),
  );
  print(
    `Photo #${id}, edit ${text(edited.edit)} ($${Number(edited.usd).toFixed(3)}; this month $${Number(edited.month.usd).toFixed(2)}) → ${path}`,
    ...(edited.turn ? [`From the original turned ${text(edited.turn)}° clockwise.`] : []),
    ...(edited.crop ? [`From the original's box ${text(edited.crop)}.`] : []),
    ...edited.kept.map((k: any) =>
      k.at ? keptLine(k) : `Not kept: ${box(k.box)}: ${text(k.missing)}. The model's alone there.`,
    ),
    'Compare it with the original before hq studio ready.',
  );
}
const box = (b: any) => [b.x, b.y, b.w, b.h].map(text).join(',');
const keptLine = (k: any) =>
  `Kept ${box(k.box)} from the original: at ${box(k.at)} in the edit (match ${text(k.match)}, light × ${k.gain.map(text).join('/')}).`;

// (--check)
async function ready(given: string[]) {
  const usage = 'usage: hq studio ready <id> [id...] --check "..." [--check "..."]...',
    checks = takeRepeated(given, '--check', `${usage}: --check needs a value`),
    ids = checks.args.map(id => id.replace('#', ''));
  if (!ids.length || !ids.every(id => /^[0-9]+$/.test(id)) || !checks.values.length) stop(usage);
  const moved = await ask('studio/ready', { ids: ids.map(Number), checks: checks.values });
  print(
    `In the board's batch: ${moved.ready.map((id: number) => `#${id}`).join(', ')} (${text(moved.waiting)} waiting for the board).`,
  );
}

async function giveUp(given: string[]) {
  const { values, args } = takeValues(given, ['--why'], USAGE),
    id = (args[0] ?? '').replace('#', '');
  if (!/^[0-9]+$/.test(id) || !values.why?.trim()) stop('usage: hq studio stop <id> --why "..."');
  await ask('studio/stop', { id: Number(id), why: values.why });
  print(`Photo #${id} is dropped: "${values.why.trim()}". Its request stays open for another photo.`);
}

async function giveBack(given: string[]) {
  const { values, args } = takeValues(given, ['--need'], USAGE),
    id = (args[0] ?? '').replace('#', '');
  if (!/^[0-9]+$/.test(id) || !values.need?.trim()) stop('usage: hq studio return <request> --need "..."');
  const back = await ask('studio/return', { id: Number(id), need: values.need });
  print(`Shot request #${id} is back with whoever asked, as job #${text(back.job)}, with what you need.`);
}

async function placed([id = '', ...urls]: string[]) {
  const n = id.replace('#', '');
  if (!/^[0-9]+$/.test(n) || !urls.length) stop('usage: hq studio placed <id> <url> [url...]');
  const answer = await ask('studio/placed', { id: Number(n), urls });
  print(`Photo #${n} is on: ${answer.places.map(text).join(', ')}`);
}

async function decisions(json: boolean) {
  const all = (await ask('studio/record')).decisions;
  if (json) return print(JSON.stringify(all, null, 2));
  if (!all.length) return print('No decisions yet.');
  for (const d of all)
    print(
      `${minute(text(d.at))}  #${text(d.photo)}  ${text(d.decision).padEnd(9)}  by ${text(d.by)}  ${text(d.product)}, ${text(d.style)}  ${text(d.model)}  sha256 ${text(d.sha256)}`,
    );
}

// HQ's answer, or a stop with its reason
async function ask(route: string, body?: unknown) {
  const answer = await api.call(route, body === undefined ? {} : { body });
  if (answer.status < 200 || answer.status > 299)
    stop(`HQ refused it: ${api.errorIn(answer.body, `HTTP ${answer.status}`)}.`);
  return JSON.parse(answer.body);
}
