// The viewer's temporary marks, relayed between the board's devices through the live feed.
const device = crypto.randomUUID();
// Three missed refreshes (review mode's sharing.js REFRESH_MS) mean the drawing device has disconnected.
const EXPIRE_MS = 15_000;
const SWEEP_MS = 5000;

let viewer;

export function mountMarks({ frame }) {
  viewer = { frame, ownMarks: null, pending: null, sending: false, remote: new Map() };
  document.addEventListener('viewmarks', e => {
    const marks = e.detail;
    if (marks.device === device) return;
    if (marks.anchor.ink.length) viewer.remote.set(marks.device, { ...marks, at: Date.now() });
    else viewer.remote.delete(marks.device);
    paint(viewer);
  });
  setInterval(() => {
    for (const [id, marks] of viewer.remote) if (Date.now() - marks.at > EXPIRE_MS) viewer.remote.delete(id);
    paint(viewer);
  }, SWEEP_MS);
  addEventListener('pagehide', () => {
    if (!viewer.ownMarks) return;
    const marks = JSON.stringify({ device, anchor: { ...viewer.ownMarks, ink: [] } });
    navigator.sendBeacon('/api/viewer/marks', new Blob([marks], { type: 'application/json' }));
  });
}

export function shareMarks(anchor, origin) {
  if (typeof anchor.url !== 'string' || !URL.canParse(anchor.url, origin)) return;
  const url = new URL(anchor.url, origin);
  if (url.origin !== origin) return;
  viewer.ownMarks = { ...anchor, url: url.href };
  viewer.pending = { device, anchor: viewer.ownMarks };
  void post(viewer);
  paint(viewer);
}

async function post(viewer) {
  if (viewer.sending) return;
  viewer.sending = true;
  try {
    while (viewer.pending) {
      const marks = viewer.pending;
      viewer.pending = null;
      const response = await fetch('/api/viewer/marks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(marks),
      });
      if (!response.ok) throw new Error(`Live marks: ${response.status}`);
    }
  } catch (error) {
    console.error('[hq] Live marks could not be shared:', error);
  } finally {
    viewer.sending = false;
  }
}

function paint({ frame, ownMarks, remote }) {
  if (!ownMarks || !frame()) return;
  const anchors = [...remote.values()].filter(m => m.anchor.url === ownMarks.url).map(m => m.anchor);
  frame().contentWindow.postMessage({ hq: 'hq', marks: anchors }, new URL(ownMarks.url).origin);
}
