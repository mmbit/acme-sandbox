// The projects view's covers, decoded once so every repaint has them

// by its file: its image, kept so it stays decoded, and the decode
const covers = new Map();
// A slow cover is waited on for WAIT_MS at most, and one that fails leaves its tile its ground.
const WAIT_MS = 1500;

// Each cover `board` names, loaded and decoded if it isn't yet: settles once all are, or WAIT_MS on
export function keepCovers(board) {
  const named = [
    ...(board?.businesses ?? []),
    ...(board?.projects ?? []),
    ...(board?.completed ?? []),
    ...Object.values(board?.groups ?? {}),
  ].flatMap(x => (x?.cover ? [x.cover] : []));
  for (const src of named)
    if (!covers.has(src)) {
      const img = new Image();
      img.src = src;
      const decoded = img.decode().catch(() => {
        // a cover that won't load: its tile shows the ground
      });
      covers.set(src, { img, decoded });
    }
  const wait = new Promise(done => setTimeout(done, WAIT_MS));
  return Promise.race([Promise.all(named.map(src => covers.get(src).decoded)), wait]);
}
