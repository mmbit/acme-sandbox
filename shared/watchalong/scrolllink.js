// A page of ours framed by HQ's viewer keeps its scroll in step with the page beside it: it tells its parent where it
// scrolled to ({ hq: 'scroll', y }) and scrolls where its parent says ({ hq: 'hq', scrollTo }), in CSS px. Served with
// the frame's answer on previews (the coordinator's feedback.ts) and on its own on public sites (infra/products.py),
// where HQ's origin isn't known: a page's scroll is all it tells, and only its direct parent is heard.
(() => {
  if (window.top === window || window.parent !== window.top || window.__scrollLink) return;
  window.__scrollLink = true;
  let told = null;
  addEventListener(
    'scroll',
    () => {
      if (told !== null) return;
      told = requestAnimationFrame(() => {
        told = null;
        parent.postMessage({ hq: 'scroll', y: Math.round(scrollY) }, '*');
      });
    },
    { passive: true },
  );
  addEventListener('message', e => {
    const y = e.data?.scrollTo;
    if (e.source !== parent || e.data?.hq !== 'hq' || !Number.isFinite(y)) return;
    scrollTo({ top: y, behavior: 'instant' });
  });
})();
