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
  const source = URL.createObjectURL(new Blob([`(${encodePictures})()`], { type: 'text/javascript' }));
  const encoder = new Worker(source);
  URL.revokeObjectURL(source);
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
// The encoder, in a worker of its own: a picture as WebP (JPEG where the browser makes no WebP: Safari), nothing when
// it's the same as the last one of its canvas
function encodePictures() {
  const last = new Map();
  const encoded = async (canvas, type, quality) => {
    const blob = await canvas.convertToBlob({ type, quality });
    return blob.type === type || type === 'image/jpeg' ? blob : encoded(canvas, 'image/jpeg', 0.6);
  };
  onmessage = async ({ data: { id, bitmap, width, height } }) => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await encoded(canvas, 'image/webp', 0.5);
    const base64 = new self.FileReaderSync().readAsDataURL(blob).split(',')[1]; // (a worker's own reader)
    const same = last.get(id) === base64;
    last.set(id, base64);
    postMessage(same ? { id } : { id, type: blob.type, base64, width, height });
  };
}
