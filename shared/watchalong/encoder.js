// The watch-along's canvas pictures encoded off the page's main thread (canvas.js starts this file as its worker): a
// picture as WebP, nothing when it's the same as the last one of its canvas. Where the browser makes no WebP (Safari)
// it goes as JPEG, or as PNG when any of it is see-through: JPEG has no see-through, and draws it black, so a pen's
// canvas over the Notebook's paper reached the call as a black page. (PNG)
// A file of its own, served from the page's origin: a page whose policy names no worker-src (HQ's) runs only its own
// origin's, never a blob's.
const last = new Map();
const encoded = async canvas => {
  const webp = await canvas.convertToBlob({ type: 'image/webp', quality: 0.5 });
  if (webp.type === 'image/webp') return webp;
  return seeThrough(canvas)
    ? canvas.convertToBlob({ type: 'image/png' })
    : canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
};
const seeThrough = canvas => {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
  return false;
};
onmessage = async ({ data: { id, bitmap, width, height } }) => {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await encoded(canvas);
  const base64 = new self.FileReaderSync().readAsDataURL(blob).split(',')[1]; // (a worker's own reader)
  const same = last.get(id) === base64;
  last.set(id, base64);
  postMessage(same ? { id } : { id, type: blob.type, base64, width, height });
};
