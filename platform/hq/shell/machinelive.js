// A machine's page in Settings › Machines (machines.js), live: its load now, the last minutes of it as a graph, and the
// run it has with that run's newest output
import { esc } from '../util.js';
import { timeOf } from '../world/clock.js';
import { withJobLinks, jobNameLink } from './prose.js';

// The output is an agent's command's: text only, never markup. Its job is a link to it.
export function livePart(m) {
  const run = m.run
    ? `<p class="machine-run">${esc(m.run.agent)}: ${m.run.title ? withJobLinks(m.run.title) : `job ${jobNameLink(m.run.job, m.run.job_code)}`} <span class="dim">${esc(m.run.kind)}, since ${esc(timeOf(m.run.since))}</span></p>`
    : '';
  const live = m.live;
  if (!live) return run;
  const meter = (label, value) => {
    const pct = Math.max(0, Math.min(100, Number(value) || 0));
    return `<span class="use-label">${label}</span><span class="bar"><i style="width:${pct}%"></i></span><span class="use-pct">${pct}%</span>`;
  };
  const gpu = live.gpu !== undefined && live.gpu !== null ? meter('GPU', live.gpu) : '';
  const lines = live.lines?.length ? `<pre class="machine-lines">${esc(live.lines.join('\n'))}</pre>` : '';
  return `<div class="machine-live"><div class="use">${meter('CPU', live.cpu)}${meter('Memory', live.mem)}${gpu}</div>${freeNow(live)}${graph(live.history ?? [])}${run}${lines}</div>`;
}
// What's free of the whole machine now: its memory and the cores its load leaves
function freeNow(live) {
  if (!live.freeMb || !live.cores) return '';
  const cores = Math.max(0, Math.round(live.cores * (1 - (Number(live.cpu) || 0) / 100)));
  return `<p class="machine-free dim">Free now: ${(live.freeMb / 1024).toFixed(1)} GB and ${cores} of ${live.cores} cores</p>`;
}
// The last minutes of CPU (a line) and memory (dashed), 0 to 100%
function graph(history) {
  if (history.length < 2) return '';
  const first = Date.parse(history[0].at),
    span = Math.max(1, Date.parse(history.at(-1).at) - first);
  const points = key =>
    history
      .map(p => `${(((Date.parse(p.at) - first) / span) * 100).toFixed(1)},${(100 - Number(p[key])).toFixed(1)}`)
      .join(' ');
  return `<svg class="machine-graph" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="CPU and memory over the last minutes">
    <polyline points="${points('cpu')}"/><polyline class="mem" points="${points('mem')}"/></svg>`;
}
