// The projects view's covers and those a meeting's notes are drawn from (postcover.js), decoded once so every repaint
// has them

// by its file: its image, kept so it stays decoded, and the decode
const covers = new Map();
// A slow cover is waited on for WAIT_MS at most, and one that fails leaves its tile its ground.
const WAIT_MS = 1500;

// Each cover `board` names, loaded and decoded if it isn't yet. shown: the covers the level about to paint shows: the
// load waits on those alone (all of them unless given), and the rest load once they're in, so a level's few pictures
// don't share the link with every other level's. Settles once those are decoded, or WAIT_MS on.
export function keepCovers(board, shown = null) {
  const named = [
    ...(board?.businesses ?? []),
    ...(board?.projects ?? []),
    ...(board?.completed ?? []),
    ...Object.values(board?.groups ?? {}),
  ].flatMap(x => (x?.cover ? [x.cover] : []));
  const first = shown ? named.filter(src => shown.includes(src)) : named;
  const ready = Promise.all(first.map(src => kept(src, 'high')));
  // (the others after, whether the first came or failed)
  ready.then(() => named.forEach(src => kept(src, 'low')));
  const wait = new Promise(done => setTimeout(done, WAIT_MS));
  return Promise.race([ready, wait]);
}

// A cover's decode, loading it first if it isn't kept yet
function kept(src, priority) {
  if (!covers.has(src)) {
    const img = new Image();
    img.fetchPriority = priority;
    img.src = src;
    const decoded = img.decode().catch(() => {
      // a cover that won't load: its tile shows the ground
    });
    covers.set(src, { img, decoded });
  }
  return covers.get(src).decoded;
}

// The covers a level's markup shows, by the src its tiles' pictures carry (a template's images load nothing).
export function coversIn(html) {
  const level = document.createElement('template');
  level.innerHTML = html;
  return [...level.content.querySelectorAll('.pj-cover img')].map(img => img.getAttribute('src'));
}
// The pictures `named` (their files), loaded and decoded the same way: settles once they are, or WAIT_MS on
export function keepPictures(named) {
  const wait = new Promise(done => setTimeout(done, WAIT_MS));
  return Promise.race([Promise.all(named.map(src => kept(src, 'high'))), wait]);
}
// A kept picture by its file, once it has loaded (else null)
export function keptPicture(src) {
  const img = covers.get(src)?.img;
  return img?.complete && img.naturalWidth ? img : null;
}
