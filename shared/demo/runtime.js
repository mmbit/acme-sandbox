// Injected into every ad/slide page before its own scripts: window.demo. Plain script, no imports.
(() => {
  const cfg = window.__demoConfig || {};
  const g = cfg.beats || {};
  const shift = cfg.audioStart || 0; // when the track is started later, beat times move earlier
  const bpm = g.bpm || 120, per = g.beatsPerBar || 4, off = (g.offset || 0) - shift;
  const list = (a) => (a || []).map((t) => t - shift);
  const beats = list(g.beats), bars = list(g.bars || g.downbeats);
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const infos = {};
  const clipUrl = (src) => new URL(src, location.href).pathname;
  // a clip the page can't have says which, not that its 404 isn't JSON
  const info = (src, h) => (infos[src + h] ??= fetch(`/__clipinfo?src=${encodeURIComponent(clipUrl(src))}&h=${h}`)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`demo.clip ${clipUrl(src)}: ${r.status} ${await r.text()}`)))));

  const demo = (window.demo = {
    fps: cfg.fps, duration: cfg.duration, width: cfg.width, height: cfg.height, data: cfg.data,
    // which film this is: ad.mjs renders 'vertical' (social) and 'square' (the product page); a deck is 'landscape'.
    // In the square one, elements marked data-social (a "link in bio") are hidden, and so is a scene's own AI label
    // (data-ai-label): the kit draws it at full size in the square's corner instead.
    format: cfg.format,
    // A price the scene names in its settings ("prices": ["key"]), today's, as its language writes it (prices.mjs;
    //). One it doesn't name is an error, so the film's record has every price it shows.
    price(key) {
      if (!Object.hasOwn(cfg.prices || {}, key)) throw new Error(`demo.price('${key}'): name it in the scene's "prices"`);
      return cfg.prices[key];
    },
    // words with their prices in: each {price:key} as demo.price(key) gives it ("from {price:cards}")
    withPrices: (text) => text.replace(/\{price:([^}]+)\}/g, (_, key) => demo.price(key)),
    bpm, beatsPerBar: per, markers: (g.markers || []).map((m) => ({ ...m, t: m.t - shift })), sections: g.sections || [],
    cues: (g.cues || []).map((c) => ({ ...c, t: c.t - shift, start: c.start - shift })), // every sound in a mix.mjs track: { t (its hit), start, sound, name }
    // Time (s) of beat n / bar n (0-based, fractions ok) and of a named marker in the track.
    beat: (n) => (Number.isInteger(n) && beats[n] !== undefined ? beats[n] : off + (n * 60) / bpm),
    bar: (n) => (Number.isInteger(n) && bars[n] !== undefined ? bars[n] : demo.beat(n * per)),
    marker: (name) => demo.markers.find((m) => m.name === name)?.t,
    beatAt: (t) => ((t - off) * bpm) / 60, // fractional beat number at time t; beatAt(t) % 1 = phase
    // Animation helpers: progress 0..1 of t between a and b, eases, lerp.
    p: (t, a, b, ease = demo.ease.out) => ease(clamp((t - a) / (b - a))),
    lerp: (a, b, k) => a + (b - a) * k,
    clamp,
    ease: {
      linear: (k) => k,
      out: (k) => 1 - (1 - k) ** 3,
      in: (k) => k ** 3,
      inOut: (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2),
      back: (k) => 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2,
      spring: (k) => (k >= 1 ? 1 : 1 - Math.exp(-6 * k) * Math.cos(12 * k)),
    },
    // Show the frame of an MP4 at clip-local time t (s) in an <img>. Also automatic for
    // <img data-clip="rec.mp4" data-at="2" data-speed="1">: plays from scene time data-at.
    async clip(img, src, t) {
      const h = Number((img.dataset.h ??= Math.min(4096, Math.ceil((img.offsetHeight || 0) / 2) * 2)));
      const c = await info(src, h);
      const f = Math.max(0, Math.min(c.frames - 1, Math.floor(t * c.fps + 1e-6)));
      const url = `/__clip?src=${encodeURIComponent(clipUrl(src))}&h=${h}&f=${f}`;
      if (img.dataset.cur === url) return c;
      img.dataset.cur = url;
      img.src = url;
      await img.decode().catch(() => {});
      return c;
    },
    clipInfo: (src) => info(src, 0),
    async ready() {
      await new Promise((r) => (document.readyState === 'complete' ? r() : addEventListener('load', r)));
      await document.fonts.ready;
      if (cfg.format === 'square') document.head.append(Object.assign(document.createElement('style'), { textContent: '[data-social],[data-ai-label]{visibility:hidden!important}' }));
      // a vertical film for a paid ad (ad.mjs --no-social)
      else if (cfg.social === false) document.head.append(Object.assign(document.createElement('style'), { textContent: '[data-social]{visibility:hidden!important}' }));
      if (window.ready) await window.ready;
      await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
    },
    async seek(t) {
      demo.t = t;
      await Promise.all([...document.querySelectorAll('img[data-clip]')].map((el) =>
        demo.clip(el, el.dataset.clip, Math.max(0, (t - Number(el.dataset.at || 0)) * Number(el.dataset.speed || 1)))));
      if (window.frame) await window.frame(t);
      label();
    },
  });

  // The AI-content label (house rule 5): burned into every frame, on by default. --label "" turns it off.
  // Portrait (ads) keeps it clear of the platforms' top bar; landscape (decks) tucks it into the corner.
  let tag;
  function label() {
    if (!cfg.label || tag?.isConnected || window !== top) return; // once per video, not again inside iframes
    const host = document.createElement('div');
    const s = host.attachShadow({ mode: 'closed' });
    const k = Math.min(cfg.width, cfg.height) / 1080;
    const [v, h] = (cfg.labelPos || 'top-left').split('-');
    // cfg.labelInset [top, side] overrides the default offsets (Reels covers the top 270 px)
    const [iv, ih] = cfg.labelInset || [v === 'top' ? (cfg.height > cfg.width ? 150 : 44) : 90, 44]; // 1080-wide px
    s.innerHTML = `<div style="position:fixed;${v}:${Math.round(iv * k)}px;${h}:${Math.round(ih * k)}px;
      z-index:2147483647;pointer-events:none;font:600 ${Math.round(24 * k)}px/1 system-ui,'Liberation Sans',sans-serif;
      letter-spacing:.02em;color:#fff;background:rgba(0,0,0,.42);padding:${Math.round(9 * k)}px ${Math.round(16 * k)}px;
      border-radius:999px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)">${cfg.label.replace(/</g, '&lt;')}</div>`;
    document.documentElement.append(host);
    // The whole label stays in the frame: a long one wraps beside a deep inset, so each offset is clamped by its box.
    const el = s.firstElementChild;
    const fit = (side, room) => (el.style[side] = `${Math.max(0, Math.min(parseFloat(el.style[side]), room))}px`);
    fit(h, innerWidth - Math.ceil(el.getBoundingClientRect().width));
    fit(v, innerHeight - Math.ceil(el.getBoundingClientRect().height));
    tag = host;
  }
})();
