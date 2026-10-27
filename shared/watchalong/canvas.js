// The watch-along's canvases: their pictures in the recording (watchalong.js loads this file where a page asks for
// canvas frames).
import { record } from './vendor/rrweb-record.js';
import { HIDE, PRIVATE } from './watchalong.js';

// rrweb's event type, source and context this file writes
const INCREMENTAL = 3,
  CANVAS_MUTATION = 9,
  CONTEXT_2D = 0;

// The page's canvases (HQ's building is one) as pictures, `fps` a second, no bigger than they show on screen, encoded
// off the main thread, and only when they changed: rrweb's canvas mutations, which its replayer draws. rrweb's own
// recordCanvas stays off: it encodes every canvas twice on the main thread as it starts, a freeze at each start and
// resume, and samples every device pixel. Returns what stops it.
export function sampleCanvases(fps, emit) {
  // (a file of its own beside this one, not a blob: HQ's policy runs workers from its own origin only, and refused the
  // blob's, so no canvas reached a call's recording.)
  const encoder = new Worker(new URL('./encoder.js', import.meta.url));
  const encoding = new Set();
  encoder.onmessage = ({ data: { id, type, base64, width, height } }) => {
    encoding.delete(id);
    if (base64) emit({ type: INCREMENTAL, timestamp: Date.now(), data: drawn(id, type, base64, width, height) });
  };
  const picture = async canvas => {
    const id = record.mirror.getId(canvas);
    const shown = canvas.width && canvas.clientWidth && !canvas.closest(`${HIDE}, ${PRIVATE}`);
    if (id < 0 || encoding.has(id) || !shown) return;
    encoding.add(id);
    // a whole share of the canvas's pixels: one for each pixel on screen, or a few more
    const step = Math.max(1, Math.floor(canvas.width / canvas.clientWidth));
    const size = { resizeWidth: Math.ceil(canvas.width / step), resizeHeight: Math.ceil(canvas.height / step) };
    try {
      const bitmap = await (step > 1
        ? createImageBitmap(canvas, { ...size, resizeQuality: 'medium' })
        : createImageBitmap(canvas));
      encoder.postMessage({ id, bitmap, width: canvas.width, height: canvas.height }, [bitmap]);
    } catch {
      encoding.delete(id); // the canvas went, or lost its size, meanwhile
    }
  };
  // in an animation frame: a WebGL canvas's picture is there only in the frame that drew it
  let frame = 0;
  const look = () => (frame = requestAnimationFrame(() => document.querySelectorAll('canvas').forEach(picture)));
  look();
  const tick = setInterval(look, 1000 / fps);
  return () => {
    clearInterval(tick);
    cancelAnimationFrame(frame);
    encoder.terminate();
  };
}
// A canvas's picture, drawn over the whole canvas in the replay
const drawn = (id, type, base64, width, height) => {
  const bitmap = {
    rr_type: 'ImageBitmap',
    args: [{ rr_type: 'Blob', data: [{ rr_type: 'ArrayBuffer', base64 }], type }],
  };
  const commands = [
    { property: 'clearRect', args: [0, 0, width, height] },
    { property: 'drawImage', args: [bitmap, 0, 0, width, height] },
  ];
  return { source: CANVAS_MUTATION, id, type: CONTEXT_2D, commands };
};
