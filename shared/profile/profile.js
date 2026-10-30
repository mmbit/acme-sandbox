// The profiler: a page's memory and smoothness over a long session, sampled and sent to HQ, so a leak shows as growth
// (shared/profile/README.md). The coordinator serves it after review.js while `hq profile on` holds for the page's host.
(() => {
  if (window.__profiling) return;
  window.__profiling = true;
  // (platform/hq/profile-session.mjs sets shorter times for its sessions in window.__profileTimes)
  const { sampleMs: SAMPLE_MS = 20_000, sendMs: SEND_MS = 60_000 } = window.__profileTimes ?? {};
  // Three frames or more dropped at 60 Hz (a 66.7 ms gap): between refresh multiples at 60 and 120 Hz, so jitter
  // doesn't decide whether a gap counts
  const SLOW_FRAME_MS = 60;
  const REGIONS = 8; // the body's biggest children, by elements
  const ROUTE = new URL('profile', document.currentScript?.src || new URL('/__review/review.js', location.href));
  const session = crypto.randomUUID();

  // The tab's session before this one, whether it ended with a pagehide (a reload, a navigation, pull to refresh) or
  // without one (the browser killed the page), and whether it was hidden then: iOS reclaims a page in the background
  // without a pagehide too, so only one killed while it showed reads as out of memory or a crash
  const KEY = 'profile:session';
  const previous = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  let clean = false;
  const mark = () => sessionStorage.setItem(KEY, JSON.stringify({ session, clean, hidden: document.hidden }));
  mark();
  const device = {
    agent: navigator.userAgent,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    memory: navigator.deviceMemory ?? null,
    cores: navigator.hardwareConcurrency ?? null,
    previous,
  };

  // ---- what lives: weakly held, so a collected one stops counting
  const alive = {
    canvas: new Set(),
    audio: new Set(),
    resize: new Set(),
    mutation: new Set(),
    intersection: new Set(),
  };
  const refs = new WeakMap();
  const track = (kind, thing) => {
    if (!refs.has(thing)) refs.set(thing, new WeakRef(thing));
    alive[kind].add(refs.get(thing));
  };
  const trackCanvas = element => element instanceof HTMLCanvasElement && track('canvas', element);
  const untrack = (kind, thing) => refs.has(thing) && alive[kind].delete(refs.get(thing));
  const living = kind => [...alive[kind]].map(ref => ref.deref() ?? (alive[kind].delete(ref), null)).filter(Boolean);

  const { createElement } = Document.prototype;
  Document.prototype.createElement = function (...args) {
    const element = createElement.apply(this, args);
    trackCanvas(element);
    return element;
  };
  for (const canvas of document.querySelectorAll('canvas')) track('canvas', canvas);
  if (window.OffscreenCanvas)
    window.OffscreenCanvas = class extends OffscreenCanvas {
      constructor(...args) {
        super(...args);
        track('canvas', this);
      }
    };
  const webgl = new WeakSet();
  for (const Canvas of [HTMLCanvasElement, window.OffscreenCanvas].filter(Boolean)) {
    const { getContext } = Canvas.prototype;
    Canvas.prototype.getContext = function (type, ...rest) {
      const context = getContext.call(this, type, ...rest);
      if (context && String(type).startsWith('webgl')) webgl.add(this);
      return context;
    };
  }
  for (const name of ['AudioContext', 'webkitAudioContext'].filter(n => window[n]))
    window[name] = class extends window[name] {
      constructor(...args) {
        super(...args);
        track('audio', this);
      }
    };
  // An observer counts from its first observe() until disconnect() (one that unobserved every target still counts)
  for (const [kind, name] of [
    ['resize', 'ResizeObserver'],
    ['mutation', 'MutationObserver'],
    ['intersection', 'IntersectionObserver'],
  ]) {
    const proto = window[name]?.prototype;
    if (!proto) continue;
    const { observe, disconnect } = proto;
    proto.observe = function (...args) {
      track(kind, this);
      return observe.apply(this, args);
    };
    proto.disconnect = function () {
      untrack(kind, this);
      return disconnect.call(this);
    };
  }

  // ---- listeners on window and document (an element's go with it), by type, without once-only ones
  const listening = new Map([
    [window, new Map()],
    [document, new Map()],
  ]);
  const keyOf = (type, options) =>
    `${type}${(typeof options === 'boolean' ? options : options?.capture) ? ' capture' : ''}`;
  const { addEventListener, removeEventListener } = EventTarget.prototype;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const byType = listening.get(this);
    if (byType && listener && !options?.once) {
      const key = keyOf(type, options);
      if (!byType.has(key)) byType.set(key, new Set());
      byType.get(key).add(listener);
      options?.signal?.addEventListener('abort', () => byType.get(key).delete(listener));
    }
    return addEventListener.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    listening.get(this)?.get(keyOf(type, options))?.delete(listener);
    return removeEventListener.call(this, type, listener, options);
  };

  // ---- timers: intervals running, and timeouts and animation frames asked for in each sample
  const intervals = new Set();
  const asked = { timeouts: 0, animationFrames: 0 };
  const { setInterval: every, clearInterval: stopEvery, setTimeout: later, requestAnimationFrame: nextFrame } = window;
  window.setInterval = (...args) => {
    const id = every(...args);
    intervals.add(id);
    return id;
  };
  window.clearInterval = id => {
    intervals.delete(id);
    stopEvery(id);
  };
  window.setTimeout = (...args) => {
    asked.timeouts++;
    return later(...args);
  };
  window.requestAnimationFrame = callback => {
    asked.animationFrames++;
    return nextFrame(callback);
  };

  // ---- smoothness: the gaps between frames while the page shows, and long tasks where the browser tells them.
  // `held` counts the same for the frames while a finger, pen or mouse button is down (a drag, a stroke, a slider),
  // which a sample's 20 s otherwise mix with everything else: a frame counts as held when a pointer was down at any
  // time in its gap, so a tap inside one long frame counts too
  const frames = { shown: 0, slow: 0, worst: 0 };
  const held = { shown: 0, slow: 0, worst: 0 };
  const pointersDown = new Set();
  let pressedSinceFrame = false;
  let lastFrame = 0;
  const count = (counts, gap) => {
    counts.shown++;
    if (gap > SLOW_FRAME_MS) counts.slow++;
    counts.worst = Math.max(counts.worst, gap);
  };
  const frame = t => {
    if (lastFrame && !document.hidden) {
      count(frames, t - lastFrame);
      if (pressedSinceFrame || pointersDown.size) count(held, t - lastFrame);
    }
    pressedSinceFrame = false;
    lastFrame = t;
    nextFrame(frame);
  };
  nextFrame(frame);
  const press = e => {
    pointersDown.add(e.pointerId);
    pressedSinceFrame = true;
  };
  addEventListener.call(window, 'pointerdown', press, true);
  for (const type of ['pointerup', 'pointercancel'])
    addEventListener.call(window, type, e => pointersDown.delete(e.pointerId), true);
  // (a pointer let go while the page was hidden or another window had it sends no pointerup here, so losing focus and
  // the page's visibility changing both forget every pointer down)
  addEventListener.call(window, 'blur', () => pointersDown.clear());
  addEventListener.call(document, 'visibilitychange', () => {
    lastFrame = 0;
    pointersDown.clear();
    mark();
  });
  const longTasks = { count: 0, ms: 0, worst: 0 };
  if (PerformanceObserver.supportedEntryTypes?.includes('longtask'))
    new PerformanceObserver(list => {
      for (const task of list.getEntries()) {
        longTasks.count++;
        longTasks.ms += task.duration;
        longTasks.worst = Math.max(longTasks.worst, task.duration);
      }
    }).observe({ type: 'longtask', buffered: true });

  // ---- the sample
  const started = performance.now();
  let samples = [];
  const timers = [every(() => samples.push(sample()), SAMPLE_MS), every(send, SEND_MS)];
  addEventListener.call(window, 'pagehide', () => {
    samples.push(sample());
    send();
    clean = true;
    mark();
  });
  addEventListener.call(window, 'pageshow', e => {
    if (!e.persisted) return;
    clean = false;
    mark();
  });

  function sample() {
    const counted = countElements(); // (it tracks the canvases a view made from markup, so it goes first)
    const canvases = living('canvas');
    const heap = performance.memory;
    const taken = {
      at: Date.now(),
      up: Math.round((performance.now() - started) / 1000),
      hidden: document.hidden,
      state: stateOf(),
      heap: heap ? megabytes(heap.usedJSHeapSize) : null,
      ...counted,
      canvases: canvases.length,
      canvasMb: megabytes(canvases.reduce((sum, c) => sum + c.width * c.height * 4, 0)),
      webgl: canvases.filter(c => webgl.has(c)).length,
      audio: living('audio').filter(a => a.state !== 'closed').length,
      resize: living('resize').length,
      mutation: living('mutation').length,
      intersection: living('intersection').length,
      listeners: listenersByType(),
      intervals: intervals.size,
      ...asked,
      frames: { ...frames, worst: Math.round(frames.worst) },
      held: { ...held, worst: Math.round(held.worst) },
      longTasks: { ...longTasks, ms: Math.round(longTasks.ms), worst: Math.round(longTasks.worst) },
    };
    Object.assign(asked, { timeouts: 0, animationFrames: 0 });
    for (const counts of [frames, held]) Object.assign(counts, { shown: 0, slow: 0, worst: 0 });
    Object.assign(longTasks, { count: 0, ms: 0, worst: 0 });
    return taken;
  }

  function send() {
    if (!samples.length) return;
    const body = JSON.stringify({ session, page: location.pathname, device, samples });
    samples = [];
    // (a page left open after the switch went off hears no from HQ, and stops; a send that fails loses its minute's
    // samples on purpose, so a page offline for hours doesn't pile them up)
    fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
      .then(answer => [403, 404].includes(answer.status) && stop())
      .catch(() => {});
  }
  const stop = () => timers.forEach(stopEvery);

  // Every element, in open shadow roots too, and the body's biggest children by theirs: where the page grows. It also
  // tracks each canvas it meets, since one a view made from markup (innerHTML, a template) never passed createElement
  function countElements() {
    const regions = new Map();
    for (const child of document.body?.children ?? []) {
      const name = regionOf(child);
      regions.set(name, (regions.get(name) ?? 0) + 1 + within(child));
    }
    const outside =
      document.documentElement.getElementsByTagName('*').length +
      1 -
      (document.body?.getElementsByTagName('*').length ?? 0);
    const sorted = [...regions].sort((a, b) => b[1] - a[1]);
    const shown = Object.fromEntries(sorted.slice(0, REGIONS));
    const rest = sorted.slice(REGIONS).reduce((sum, [, n]) => sum + n, 0);
    if (rest) shown['(the rest)'] = rest;
    return { nodes: outside + sorted.reduce((sum, [, n]) => sum + n, 0), regions: shown };
  }
  function within(root) {
    trackCanvas(root);
    let count = root.shadowRoot ? within(root.shadowRoot) : 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let element = walker.nextNode(); element; element = walker.nextNode()) {
      trackCanvas(element);
      count += 1 + (element.shadowRoot ? within(element.shadowRoot) : 0);
    }
    return count;
  }
  const regionOf = element =>
    element.id
      ? `#${element.id}`
      : element.classList[0]
        ? `${element.localName}.${element.classList[0]}`
        : element.localName;

  // The page's state as its root and body wear it (their classes and the root's data attributes): which view is open
  const stateOf = () =>
    [
      document.documentElement.className,
      document.body?.className,
      ...Object.entries(document.documentElement.dataset).map(([k, v]) => `${k}=${v}`),
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 200);

  const listenersByType = () =>
    Object.fromEntries(
      [...listening.values()]
        .flatMap(byType => [...byType])
        .filter(([, set]) => set.size)
        .reduce((sums, [key, set]) => sums.set(key, (sums.get(key) ?? 0) + set.size), new Map()),
    );
  const megabytes = bytes => Math.round(bytes / 1e5) / 10;
})();
