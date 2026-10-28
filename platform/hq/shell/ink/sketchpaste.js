// Pictures onto a sketch's page (sketchscraps.js places them): pasted with Cmd/Ctrl+V or from the Paste bubble a press
// held on the paper brings, dropped, or waiting from review mode. Each is drawn smaller here, shows at once, and is a step
// to undo once the coordinator has kept it (sketches.ts).
//   page: sketchpage.js's (sketch, box, find, ink, adding: the uploads under way, say(words, warn))
import { sfx } from '../audio.js';
import { shrink } from './sketchscraps.js';

const IMAGE = /^image\//;
const middle = page => [page.sketch.w / 2, page.sketch.h / 2];
// (several at once land a little apart, like photos dealt onto a table)
const dealt = ([x, y], i) => [x + i * 28, y + i * 22];
// a point on screen in the sketch's units, kept on the page
function unitsAt(page, clientX, clientY) {
  const r = page.find('.sk-sheet').getBoundingClientRect(),
    k = r.width / page.sketch.w;
  return [
    Math.min(Math.max((clientX - r.left) / k, 0), page.sketch.w),
    Math.min(Math.max((clientY - r.top) / k, 0), page.sketch.h),
  ];
}

// A picture file onto the page at `at`: drawn smaller here first, shown at once, kept by the coordinator, then a step to undo
async function putPicture(page, file, at) {
  const small = await shrink(file);
  if (!small) return page.say('That picture couldn’t be read here. Another kind of file?', true);
  const img = new Image();
  img.alt = '';
  img.src = URL.createObjectURL(small.blob);
  if (
    !(await img.decode().then(
      () => true,
      () => false,
    ))
  )
    return page.say('That picture couldn’t be read here. Another kind of file?', true);
  const placed = page.ink.addScrap(img, at);
  const upload = page.book.upload(page.sketch.id, small.blob).then(
    // (the book's)
    kept => placed.kept(kept.file),
    e => {
      placed.gone();
      page.say(`That picture didn’t stay: ${e.message}`, true);
    },
  );
  page.adding.add(upload);
  upload.finally(() => page.adding.delete(upload));
}

// Cmd/Ctrl+V anywhere on the open sketch puts the clipboard's pictures in the page's middle, and files dropped on it land
// where they're dropped. Text pasted into the label stays the label's.
export function wirePictures(page) {
  const { box } = page,
    sheet = page.find('.sk-sheet');
  const images = list => [...(list ?? [])].filter(f => IMAGE.test(f.type));
  const pasted = e => {
    const found = images(e.clipboardData?.files);
    if (!found.length || !box.open) return;
    e.preventDefault();
    found.forEach((f, i) => putPicture(page, f, dealt(middle(page), i)));
  };
  document.addEventListener('paste', pasted);
  // Delete or Backspace takes the picked picture off (wherever the focus went: a tapped bubble that's gone leaves it on
  // the page's body)
  const keyed = e => {
    if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      box.open &&
      !e.target.closest?.('input, textarea') &&
      page.ink.unpin()
    )
      e.preventDefault();
  };
  document.addEventListener('keydown', keyed);
  const carries = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
  let taking;
  box.addEventListener('dragover', e => {
    if (!carries(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    sheet.classList.add('taking');
    clearTimeout(taking);
    taking = setTimeout(() => sheet.classList.remove('taking'), 200);
  });
  box.addEventListener('drop', e => {
    if (!carries(e)) return;
    e.preventDefault();
    sheet.classList.remove('taking');
    const found = images(e.dataTransfer.files);
    if (!found.length) return page.say('Only pictures go on a sketch.', true);
    found.forEach((f, i) => putPicture(page, f, dealt(unitsAt(page, e.clientX, e.clientY), i)));
  });
  return {
    stop() {
      document.removeEventListener('paste', pasted);
      document.removeEventListener('keydown', keyed);
    },
  };
}

// A press held on the bare paper: a Paste bubble there, as the iPad's own, which reads the clipboard when tapped
export function offerPaste(page, at) {
  page.find('.sk-callout')?.remove();
  const r = page.find('.sk-sheet').getBoundingClientRect(),
    k = r.width / page.sketch.w;
  const bubble = Object.assign(document.createElement('button'), { className: 'sk-callout', textContent: 'Paste' });
  Object.assign(bubble.style, { left: `${r.left + at[0] * k}px`, top: `${r.top + at[1] * k}px` });
  page.box.append(bubble);
  sfx.tick();
  const away = e => {
    if (e?.target === bubble) return;
    bubble.remove();
    page.box.removeEventListener('pointerdown', away, true);
  };
  page.box.addEventListener('pointerdown', away, true);
  setTimeout(away, 5000);
  bubble.onclick = async () => {
    away();
    try {
      const items = await navigator.clipboard.read();
      const imageOf = it => {
        const type = it.types.find(t => IMAGE.test(t));
        return type && it.getType(type);
      };
      const found = (await Promise.all(items.map(imageOf))).filter(Boolean);
      if (!found.length) return page.say('No picture to paste: copy one first.', true);
      found.forEach((f, i) => putPicture(page, f, dealt(at, i)));
    } catch {
      page.say('The clipboard can’t be read here: paste with ⌘V or Ctrl+V.', true);
    }
  };
}

// Pictures sent here from review mode wait on the sketch until it opens: they land on the page then, each a step to undo
export async function placeWaiting(page) {
  for (const [i, w] of (page.sketch.waiting ?? []).entries()) {
    const img = new Image();
    img.alt = '';
    img.src = w.url;
    if (
      !(await img.decode().then(
        () => true,
        () => false,
      ))
    ) {
      page.say('A picture from review mode couldn’t be loaded: open the sketch again.', true);
      continue;
    }
    page.ink.addScrap(img, dealt(middle(page), i)).kept(w.file);
  }
}
