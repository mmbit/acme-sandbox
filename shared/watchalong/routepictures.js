// The watch-along's pictures that a replay can't load by their address, in the recording: what the page shows from its
// own routes (HQ's notes' pictures, a book's cover, an agent's drawing: `/api/...?file=`, behind the viewer's sign-in).
// The mirror loads a picture file by its address itself (mirror.ts), but only the viewer's own sign-in may load these,
// so they come in the recording and the mirror answers them by their address: the agent sees the picture the board
// sees. A blob's can't be asked for by its address in another browser: the mirror marks it as not captured.
// watchalong.js loads this file on the recording page.
import { record } from './vendor/rrweb-record.js';
import { HIDE, PRIVATE } from './watchalong.js';

// A picture file by its address: the replay loads it as it is
const FILE = /\.(png|jpe?g|webp|gif|svg)$/i;
// The longest side a picture goes at: its own size up to this. A replay lays a picture out at its own size where the
// page gives it none, so it keeps that size (a photo is made smaller before it's uploaded, an agent's drawing is small).
const LONG_PX = 1600;

// Each such picture once loaded, once per address while recording: a `picture` moment { address, type, base64 }, encoded
// off the main thread (encoder.js, canvas.js's). Never one in a hidden or private part. Returns what stops it.
export function carryPictures() {
  const encoder = new Worker(new URL('./encoder.js', import.meta.url));
  const carried = new Set();
  encoder.onmessage = ({ data: { id, type, base64 } }) =>
    base64 && record.addCustomEvent('picture', { address: id, type, base64 });
  const carry = async img => {
    const address = img.currentSrc || img.src;
    if (!address || carried.has(address) || !img.complete || !img.naturalWidth || !unloadable(address)) return;
    if (img.closest(`${HIDE}, ${PRIVATE}`)) return;
    carried.add(address);
    const k = Math.min(1, LONG_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const size = { resizeWidth: Math.round(img.naturalWidth * k), resizeHeight: Math.round(img.naturalHeight * k) };
    try {
      const bitmap = await (k < 1
        ? createImageBitmap(img, { ...size, resizeQuality: 'medium' })
        : createImageBitmap(img));
      encoder.postMessage({ id: address, bitmap, width: bitmap.width, height: bitmap.height }, [bitmap]);
    } catch {
      carried.delete(address); // (it went, or can't be read: tried again as it loads anew)
    }
  };
  const loaded = e => e.target instanceof HTMLImageElement && carry(e.target);
  document.addEventListener('load', loaded, true);
  document.querySelectorAll('img').forEach(carry);
  return () => {
    document.removeEventListener('load', loaded, true);
    encoder.terminate();
  };
}

// A picture of this page's own that isn't a file (a route's)
function unloadable(address) {
  const url = new URL(address, location.href);
  return url.origin === location.origin && !FILE.test(url.pathname);
}
