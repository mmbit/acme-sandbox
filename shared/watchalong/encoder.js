// The watch-along's canvas pictures encoded off the page's main thread (canvas.js starts this file as its worker): a
// picture as WebP (JPEG where the browser makes no WebP: Safari), nothing when it's the same as the last one of its
// canvas. A file of its own, served from the page's origin: a page whose policy names no worker-src (HQ's) runs only
// its own origin's, never a blob's.
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
