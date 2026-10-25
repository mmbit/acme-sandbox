// The watch-along's answer in a page of ours framed by HQ (its preview viewer, or a guest's join page on a walk-through
// call): the coordinator serves it with review mode's script, on or off, HQ's origin filled in, so a page records itself
// in the frame whether or not its viewer may take notes (README.md, "In a frame"). It says hello to HQ as the page
// loads, and bye as it goes: the walk-through's eye shows while a page that answers is in the frame. It loads the
// recorder from beside its script only once HQ first asks it to start, and hands it what HQ said while it loaded.
(() => {
  const HQ = '{{HQ_ORIGIN}}';
  // only directly inside HQ's page, never in a frame of a frame
  if (window.top === window || window.parent !== window.top || window.__watchalongFramed) return;
  window.__watchalongFramed = true;
  const ROUTE = new URL('.', document.currentScript?.src || new URL('/__review/review.js', location.href));
  const toHq = m => {
    try {
      parent.postMessage({ hq: 'watchalong', ...m }, HQ);
    } catch {
      /* not served by the coordinator */
    }
  };
  let loading = null;
  const heard = [];
  const listen = e => {
    const asked = e.data?.watchalong;
    if (
      e.source !== parent ||
      e.origin !== HQ ||
      (asked !== 'start' && asked !== 'stop') ||
      (!loading && asked === 'stop')
    )
      return;
    heard.push(e);
    loading ??= import(new URL('watchalong.js', ROUTE).href).then(
      ({ answerFrames }) => {
        removeEventListener('message', listen);
        const hear = answerFrames(HQ);
        heard.forEach(hear);
      },
      error => {
        loading = null;
        heard.length = 0;
        console.error('[watchalong] the recorder did not load', error);
      },
    );
  };
  addEventListener('message', listen);
  addEventListener('pagehide', () => toHq({ bye: 1 }));
  addEventListener('pageshow', e => e.persisted && toHq({ hello: 1 }));
  toHq({ hello: 1 });
})();
