// What a Chromium trace and CPU profile of a page say (profile-pull.mjs): each kind of the renderer's work per second,
// the page's functions that took the most, and the longest tasks with the script in them.

// The kinds of work on the renderer's main, compositor and raster threads (a kind's time includes the kinds inside it:
// FireAnimationFrame holds its FunctionCalls)
const KINDS = {
  FireAnimationFrame: 'animation frames (script)',
  EventDispatch: 'input events (script)',
  TimerFire: 'timers (script)',
  UpdateLayoutTree: 'style',
  Layout: 'layout',
  PrePaint: 'pre-paint',
  Paint: 'paint',
  Layerize: 'layerize',
  Commit: 'commit',
  RasterTask: 'raster (raster threads)',
};
// The trace's threads by name, keyed pid:tid
function threadsOf(events) {
  return new Map(
    events.filter(e => e.ph === 'M' && e.name === 'thread_name').map(e => [`${e.pid}:${e.tid}`, e.args.name]),
  );
}
// Each kind's ms per second on those threads
export function rendererWork(events, seconds) {
  const names = threadsOf(events);
  const msByKind = {};
  for (const e of events) {
    const kind = KINDS[e.name];
    if (!kind || e.ph !== 'X' || !e.dur) continue;
    const thread = names.get(`${e.pid}:${e.tid}`) ?? '';
    if (!/CrRendererMain|Raster|Compositor|TileWorker/.test(thread)) continue;
    msByKind[kind] = (msByKind[kind] ?? 0) + e.dur / 1000;
  }
  for (const k in msByKind) msByKind[k] = Math.round(msByKind[k] / seconds);
  return msByKind;
}
// A CPU profile's samples: when each was taken (the trace's clock, µs) and the page's own function it was in, the
// nearest one up its stack with a source (so a drawImage counts to the renderer's function calling it), or what the
// browser was doing outside script ((program), (idle), (garbage collector))
export function scriptOf(profile) {
  const byId = new Map(profile.nodes.map(n => [n.id, n])),
    parent = new Map(profile.nodes.flatMap(n => (n.children ?? []).map(c => [c, n.id])));
  const where = id => {
    for (let n = byId.get(id); n; n = byId.get(parent.get(n.id))) {
      const f = n.callFrame;
      if (f.url)
        return `${f.functionName || '(anonymous)'} ${f.url.replace(/^https?:\/\/[^/]+/, '')}:${f.lineNumber + 1}`;
    }
    return byId.get(id).callFrame.functionName;
  };
  let t = profile.startTime;
  return profile.samples
    .map((id, i) => ({ t: (t += profile.timeDeltas[i]), where: where(id), ms: 0 }))
    .map((s, i, all) => ({ ...s, ms: ((all[i + 1]?.t ?? profile.endTime) - s.t) / 1000 }));
}
// The page's functions that took the most, with what they called (ms per second)
export function topFunctions(scriptSamples, seconds, n = 12) {
  return top(scriptSamples, n).map(([fn, ms]) => ({ function: fn, 'ms/s': Math.round((10 * ms) / seconds) / 10 }));
}
function top(scriptSamples, n) {
  const sums = new Map();
  for (const s of scriptSamples) sums.set(s.where, (sums.get(s.where) ?? 0) + s.ms);
  return [...sums].sort((a, b) => b[1] - a[1]).slice(0, n);
}
// The main thread's longest tasks over 50 ms: how long, what kinds of work they held, and the script in them
export function longTasks(events, scriptSamples) {
  const names = threadsOf(events),
    main = e => names.get(`${e.pid}:${e.tid}`) === 'CrRendererMain';
  const tasks = events.filter(e => e.ph === 'X' && /RunTask$/.test(e.name) && e.dur > 50000 && main(e));
  return tasks
    .sort((a, b) => b.dur - a.dur)
    .slice(0, 6)
    .map(task => {
      const inside = e => e.ts >= task.ts && e.ts < task.ts + task.dur,
        kinds = {};
      for (const e of events)
        if (KINDS[e.name] && e.ph === 'X' && main(e) && inside(e))
          kinds[KINDS[e.name]] = (kinds[KINDS[e.name]] ?? 0) + Math.round(e.dur / 1000);
      const script = top(
        scriptSamples.filter(s => s.t >= task.ts && s.t < task.ts + task.dur),
        3,
      )
        .map(([fn, ms]) => `${fn} ${Math.round(ms)}`)
        .join('; ');
      return { ms: Math.round(task.dur / 1000), ...kinds, script };
    });
}
