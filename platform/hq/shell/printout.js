// Numbers' printout of an app's dashboard
import { esc } from '../util.js';
import { icon } from './icons.js';
import {
  number,
  count,
  euros,
  money,
  percent,
  ratio,
  sum,
  dayName,
  short,
  range,
  clock,
  country,
  sparkline,
  columns,
  horizontalBars,
  figure,
  sigil,
  gridOr,
  printerLine,
  title,
  choice,
  periods,
  numbered,
  card,
  tile,
  under,
  dayCard,
  dayTable,
  targetsCard,
  NOTHING,
  TEAR,
} from './paper.js';
const NO_ORDERS = '<p class="nodata">No orders yet.</p>';

export function appPrintout(dashboard, view, { more, care }) {
  const steps = new Map((dashboard.file?.steps ?? []).map(s => [s.id, s])),
    paid = dashboard.totals?.paid ?? dashboard.steps?.paid ?? 0;
  const label = id => steps.get(id)?.label ?? id,
    heading = numbered();
  const perDay = dashboard.daily?.length ? paid / dashboard.daily.length : 0;
  const printout = { dashboard, view, steps, label, heading, paid, perDay, none: !dashboard.updated };
  const funnel = funnelCard(printout),
    orders = `<div class="stack">${perDayCard(printout)}${countriesCard(printout)}</div>`;
  const own = (dashboard.file?.sections ?? []).map(s => ownCard(s, printout)).join('');
  const tests = testCards(printout),
    ads = adsCard(printout);
  const targets = targetsCard(dashboard.targets ?? [], heading, 'The team’s own targets for this app.');
  return `<div class="nx${printout.none ? ' empty' : ''}">${appTop(printout)}
    <section data-nx="top">${appTiles(printout)}</section>
    ${dashboard.chat ? chatLine(dashboard.chat, care) : ''}${more}
    <section class="grid two">${funnel}${orders}</section>
    ${own ? `<section class="grid two own">${own}</section>` : ''}
    <section class="grid two"><div class="stack">${tests}</div>${ads}</section>
    <section class="grid two">${targets}${promiseCard(heading)}</section>
    ${TEAR}</div>`;
}
export const appReading = x =>
  `<b>${esc(dayName(x.day))}</b>: ${count(x.paid)} paid · ${count(x.orders)} pressed Pay · ` +
  `${count(x.steps?.page)} page loads · ${money(x.eur)}`;
// The paper's top: the printer's line, the title, the range keys. An app not launched gets no notice: its zeros say it.
function appTop({ dashboard, view, none }) {
  const last = dashboard.updated ? `last report ${esc(clock(dashboard.updated))}` : 'no report yet';
  const report = `<span>${last}</span>`;
  const live = dashboard.status === 'live';
  const stamp = `<span class="st ${live ? 'live' : 'pre'}">${live ? 'LIVE' : 'PREVIEW'}</span>`;
  const modes = choice('Whose visits', 'mode', view.mode, Object.entries({ live: 'Live', preview: 'Preview' }));
  const preview =
    '<p class="banner">Preview numbers: the board’s and the team’s own visits to the preview, ' +
    'never mixed with the real ones.</p>';
  const empty =
    '<p class="banner empty">No data yet: this app hasn’t reported anything. ' +
    'The steps below are what it will count.</p>';
  const line = `${stamp} Last ${count(dashboard.days)} days · ${esc(range(dashboard.from, dashboard.to))}`;
  return `${printerLine(report)}
    ${title(gridOr(sigil(dashboard.slug), dashboard.name, 'small sigil'), dashboard.name, line)}
    <div class="ranges">${periods(view)}
    ${view.status === 'live' ? modes : ''}</div>
    ${live && dashboard.mode === 'preview' ? preview : ''}
    ${none ? empty : ''}`;
}
// Net shows only when every kept order's is known
function appTiles({ dashboard, none, paid, perDay }) {
  const t = dashboard.totals ?? {},
    page = dashboard.steps?.page ?? 0;
  const refunded = t.refunded ? ` · ${count(t.refunded)} refunded` : '';
  const net = t.net != null && t.eur ? ` · ${money(t.net)} net` : '';
  const unknown = t.netUnknown ? ' · net not known yet' : '';
  const eurs = (dashboard.daily ?? []).map(x => x.eur ?? 0);
  const trend = `<span class="sp">${sparkline(eurs, { w: 140, h: 40, dot: 4 })}<small>per day</small></span>`;
  const revenue = under(`${count(t.kept)} orders kept${refunded}${net}${unknown}`) + (none ? '' : trend);
  const orders = under(none ? 'no data yet' : `${number(perDay, perDay < 10 ? 1 : 0)} a day`);
  const margin = under(t.margin == null ? 'the app’s file gives no margin' : 'before ads');
  return `<div class="tiles">
    ${tile('Revenue', none ? '—' : money(t.eur ?? 0), revenue, true)}
    ${tile('Paid orders', none ? '—' : count(paid), orders)}
    ${tile('Page load → paid', percent(ratio(paid, page), 2), under(`of ${count(page)} page loads`))}
    ${tile('Margin', t.margin == null || none ? '—' : money(t.margin), margin)}</div>`;
}
// Each step by how it's counted, and the blind middle where the file says (its caption)
function funnelCard({ dashboard, steps, label, heading }) {
  const blind = dashboard.file?.blind,
    reached = id => dashboard.steps?.[id] ?? 0;
  const ids = (dashboard.file?.funnel ?? []).filter(id => steps.has(id) || id in (dashboard.steps ?? {}));
  const max = Math.max(1, ...ids.map(reached));
  const how = t => (t ? `<span class="how">${icon('server', 'small')}<span>counted: ${esc(t)}</span></span>` : '');
  const step = (id, i) => {
    const c = reached(id),
      next = ids[i + 1],
      share = dec => `<b class="f">${percent(ratio(reached(next), c), dec)}</b>`;
    const bar = `<span class="bar"><i style="width:${((100 * c) / max).toFixed(2)}%"></i></span>`;
    const name = `<span class="nm">${esc(label(id))}</span>`;
    const row = `<div class="step">${name}<span class="ct">${count(c)}</span>${how(steps.get(id)?.how)}${bar}</div>`;
    if (!next) return row;
    if (blind?.after !== id) return `${row}<div class="conv">${share(0)} go on to ${esc(label(next))}</div>`;
    const caption = `${icon('mobile', 'small')}<b>The blind middle</b><span>${esc(blind.text ?? '')}</span>`;
    const conv = `<div class="conv">${share(1)} of ${esc(label(id))} reach ${esc(label(next))}</div>`;
    return `${row}<div class="blind">${caption}${conv}</div>`;
  };
  const sub = '<p class="sub">Counts from page loads and orders, never names.</p>';
  return card(heading('The funnel'), `${sub}<div class="fun">${ids.map(step).join('')}</div>`);
}
function perDayCard({ dashboard, heading, paid, perDay }) {
  const daily = dashboard.daily ?? [];
  const average = paid ? ` Dotted: ${number(perDay, 1)} a day on average.` : '';
  const sub = `Paid orders, ${esc(range(dashboard.from, dashboard.to))}.${average}`;
  const heads = '<th>Page loads</th><th>Pressed Pay</th><th>Paid</th><th>Kept €</th>';
  const cells = x =>
    `<td>${count(x.steps?.page)}</td><td>${count(x.orders)}</td><td>${count(x.paid)}</td><td>${money(x.eur)}</td>`;
  const empty = paid ? null : 'No paid orders in this period.';
  return dayCard(heading('Orders per day'), sub, columns(daily), empty, dayTable(heads, daily, cells));
}
function countriesCard({ dashboard, heading }) {
  const rows = dashboard.countries ?? [],
    margin = dashboard.file?.margin ?? {},
    margins = Object.keys(margin).length > 0;
  const paid = sum(rows.map(c => c.paid)),
    max = Math.max(1, ...rows.map(c => c.paid ?? 0));
  const sub = '<p class="sub">From the delivery address, never from an IP address.</p>';
  const head = `${heading('Where the orders go')}${sub}`;
  if (!rows.length) return card(head, NO_ORDERS);
  const val = html => `<span class="val">${html}</span>`;
  const place = c =>
    `<span class="cc">${esc(c.country ?? '??')}</span><span class="cn">${esc(country(c.country))}</span>`;
  const bar = c => `<span class="tr"><i style="width:${((100 * (c.paid ?? 0)) / max).toFixed(2)}%"></i></span>`;
  const each = c => val(figure(margin[c.country] != null ? euros(margin[c.country], 2) : '—'));
  const figures = c => `${val(figure(count(c.paid), percent(ratio(c.paid, paid), 0)))}${val(figure(money(c.eur)))}`;
  const row = c => `<span class="k">${place(c)}</span>${bar(c)}${figures(c)}${margins ? each(c) : ''}`;
  const heads =
    '<span class="hd"></span><span class="hd"></span><span class="hd r">paid</span><span class="hd r">kept €</span>';
  const marginHead = '<span class="hd r" title="margin per order, from the app’s file">margin each</span>';
  const table = `
    <div class="where">${heads}${margins ? marginHead : ''}
    ${rows.map(row).join('')}</div>`;
  return card(head, table);
}
function ownCard(s, { dashboard, label, heading }) {
  const what = dashboard.file?.what,
    name = w => (w == null ? 'Unknown' : (what?.labels?.[w] ?? w));
  if (s.kind === 'what-orders') {
    const rows = dashboard.what ?? [],
      total = sum(rows.map(r => r.paid)),
      max = Math.max(1, ...rows.map(r => r.paid ?? 0));
    const bar = r => ({
      key: esc(name(r.what)),
      v: r.paid ?? 0,
      cls: r.what == null ? 'neutral' : '',
      val: figure(count(r.paid), percent(ratio(r.paid, total), 0)),
      title: `${name(r.what)}: ${count(r.paid)} paid, ${money(r.eur)}`,
    });
    const body = rows.length ? horizontalBars(rows.map(bar), max) : NO_ORDERS;
    return card(heading(s.title ?? what?.title ?? 'What was ordered'), body);
  }
  if (s.kind === 'step-what') {
    const counts = dashboard.stepWhat?.[s.step] ?? [],
      byWhat = new Map((dashboard.what ?? []).map(r => [r.what, r]));
    const keys = [...new Set([...counts.map(c => c.what), ...byWhat.keys()])];
    const rows = keys
      .map(k => ({ k, n: counts.find(c => c.what === k)?.n ?? 0, paid: byWhat.get(k)?.paid ?? 0 }))
      .sort((a, b) => b.n - a.n || b.paid - a.paid);
    const max = Math.max(1, ...rows.map(r => Math.max(r.n, r.paid))),
      step = label(s.step).toLowerCase();
    const key = `<span><i class="sw soft"></i>${esc(step)}</span>`;
    const legend = `<p class="legend">${key}<span><i class="sw"></i>paid orders</span></p>`;
    const bar = r => ({
      key: esc(name(r.k)),
      v: r.paid,
      soft: r.n,
      cls: r.k == null ? 'neutral' : '',
      val: figure(`${count(r.paid)}/${count(r.n)}`, percent(ratio(r.paid, r.n), 0)),
      title: `${name(r.k)}: ${count(r.n)} ${step}, ${count(r.paid)} paid`,
    });
    const body = rows.length ? legend + horizontalBars(rows.map(bar), max) : NOTHING;
    return card(heading(s.title ?? `${label(s.step)} against orders`), body);
  }
  if (s.kind === 'note') return card(heading(s.title ?? 'A note'), `<p class="text">${esc(s.text ?? '')}</p>`);
  const unknown = `<p class="nodata">HQ can’t draw a “${esc(s.kind)}” section yet.</p>`;
  return card(heading(s.title ?? 'A section'), unknown);
}
// A/B tests: the running one in full, finished ones in a line
function testCards(printout) {
  const tests = (printout.dashboard.tests ?? []).slice().sort((a, b) => running(b) - running(a));
  const none = '<p class="nodata">No A/B test in this app’s file.</p>';
  if (!tests.length) return card(printout.heading('A/B test'), none);
  return tests.map((t, i) => (running(t) || i === 0 ? abCard(t, printout) : abLine(t))).join('');
}
const running = t => !t.end && t.state !== 'not-started';
const CALLED =
  'Called at the finish line and after 14 days at the earliest, never by peeking. ' +
  'The server picks a version for each page load: no cookie.';
function abCard(t, { label, heading }) {
  const [word, small, kind] = testWords(t),
    m = t.metric ?? [],
    g = t.guardrail;
  const rate = r => (r == null ? '—' : percent(r, r < 0.1 ? 2 : 1));
  const per = pair => `${esc(label(pair?.[1]))} ÷ ${esc(label(pair?.[0]))}`;
  const arm = (a, i) => {
    const role = `<span class="lbl">${a.letter === 'A' ? 'as it is' : 'the change'}</span>`;
    const soFar = running(t) && t.state === 'not-called' ? 'so far' : '';
    const reading = `<span class="r">${rate(a.metric?.rate)}</span><small>${soFar}</small>`;
    const width = Math.min(100, (100 * (a.metric?.of ?? 0)) / (t.finish || 1)).toFixed(1);
    const of = `<span><b class="f">${count(a.metric?.of)}</b> of ${count(t.finish)} ${esc(label(m[0]))}</span>`;
    const guardrail = a.guardrail ? `<div class="gr">Guardrail, ${per(g)}: <b>${rate(a.guardrail.rate)}</b></div>` : '';
    return `<div class="side"><div class="top"><span class="k k${i}">${esc(a.letter)}</span>${role}
      <span class="reading">${reading}</span></div>
    <div class="prog"><i class="k${i}" style="width:${width}%"></i>${icon('finish', 'small')}</div>
    <div class="pl">${of}<span>${count(a.metric?.n)} ${esc(label(m[1]))}</span></div>
    ${guardrail}</div>`;
  };
  const prog = Math.max(0, t.progress ?? 0),
    done = percent(Math.min(prog, 1), 0);
  const stamp = `<div class="stamp ${kind}">${esc(word)}${small ? `<small>${esc(small)}</small>` : ''}</div>`;
  const bar = `<i style="width:${Math.min(100, prog * 100).toFixed(1)}%"></i>`;
  const meter = `<div class="meter" role="img" aria-label="${done} of the way to the finish line">${bar}</div>`;
  const since = t.start ? ` · since ${esc(short(t.start))}` : '';
  const ended = t.end ? ` · ended ${esc(short(t.end))}` : '';
  const when = `${t.days != null ? `day ${count(t.days)}` : ''}${since}${ended}`;
  const guardrail = g ? `; the guardrail, ${per(g)}, mustn’t get worse` : '';
  return `<div class="card ab">${heading(running(t) ? 'A/B test, running' : 'A/B test')}
    <div class="head"><h3>“${esc(t.id)}”</h3>${stamp}</div>
    <p class="sub">${esc(t.question ?? '')}</p>
    <div class="finish">${meter}
      <div class="dayl"><span><b class="f">${done}</b> to the finish line</span><span>${when}</span></div></div>
    <div class="sides">${(t.arms ?? []).map(arm).join('')}</div>
    ${t.reason ? `<div class="verdict ${kind}">${esc(t.reason)}</div>` : ''}
    <p class="fine">Measures ${per(m)}${guardrail}. ${CALLED}</p></div>`;
}
function abLine(t) {
  const [word, small] = testWords(t);
  const verdict = `<span class="w">${esc(word)}${small ? `: ${esc(small)}` : ''}</span>`;
  const question = `<span class="q">${esc(t.question ?? '')}${t.end ? ` Ended ${esc(short(t.end))}.` : ''}</span>`;
  return `<div class="card abline"><span class="nm">A/B “${esc(t.id)}”</span>${verdict}${question}</div>`;
}
// Dowel's states (coordinator metrics.ts): one plain line each, and how the stamp looks
function testWords(t) {
  const w = t.winner ?? 'B';
  const words = {
    'not-started': ['Not started', 'starts on ' + (t.start ? short(t.start) : 'its start day'), 'wait'],
    'not-called': ['Not called', 'yet', 'wait'],
    'split-drifted': ['Split drifted', 'stop and fix', 'bad'],
    won: [`${w} won`, 'switch to ' + w, 'good'],
    lost: [`${t.variants?.find(x => x !== 'A') ?? 'B'} lost`, 'keep A', 'bad'],
    'no-difference': ['No difference', 'keep A', 'flat'],
    'six-weeks': ['Six weeks', 'no winner: keep A', 'flat'],
  };
  return words[t.state] ?? [String(t.state ?? 'Unknown'), '', 'wait'];
}
function adsCard({ dashboard, heading }) {
  const camps = dashboard.campaigns ?? [],
    labelled = camps.filter(c => c.campaign != null),
    loose = camps.find(c => c.campaign == null);
  const sub = 'By campaign label: the same for everyone who taps that ad. No click IDs.';
  const head = `${heading('Ad labels')}<p class="sub">${sub}</p>`;
  if (!labelled.length)
    return card(head, '<p class="nodata">No ad labels yet: no ad has sent anyone here with one.</p>');
  const counts = c =>
    `${count(c.page)} page loads · ${count(c.orders)} orders · ${count(c.kept)} kept · ${money(c.eur)}`;
  const camp = c => `
    <div class="camp"><span class="lb"><code>${esc(c.campaign)}</code></span><span class="fx">${counts(c)}</span>
      <span class="cpa"><b class="f">—</b><small>per order · spend —</small></span></div>`;
  const unlabelled = c => `
    <div class="camp none"><span class="lb">No ad label</span><span class="fx">${counts(c)}</span></div>`;
  const list = `<div class="camps">${labelled.map(camp).join('')}${loose ? unlabelled(loose) : ''}</div>
    <p class="note">Spend and cost per order show once the ad platforms’ own reports reach HQ.</p>`;
  return card(head, list);
}
function promiseCard(heading) {
  const words =
    'Counted from page loads and orders, on our own server. Nothing is stored on anyone’s device. ' +
    'Where visitors are counted, a hash of address and browser is kept for that day only.';
  const promise = `${icon('lock', 'small')}<b>No cookies · no IP addresses in our counts</b><span>${words}</span>`;
  return `<div class="card promise-card">${heading('How we count')}<div class="promise">${promise}</div></div>`;
}
// The support chat's line: its conversations, resolved without a person beside emails to a person (always read
// together), and the way to Care › Numbers for the same app and mode. A count not sent yet is a dash, never a 0.
function chatLine(c, care) {
  const n = v => (v == null ? '—' : count(v)),
    per = v => (v == null ? '' : under(`${number(v, v % 1 ? 1 : 0)} per 100`));
  const tiles = [
    tile('Conversations', n(c.conversations)),
    tile('Resolved without a person', n(c.resolved), per(c.resolvedRate)),
    tile('Emails to a person', n(c.person), per(c.personRate)),
  ];
  return `<section class="card chat"><h2>The support chat</h2><div class="tiles">${tiles.join('')}</div>
    ${care ? '<button data-nx-care>Care › Numbers ›</button>' : ''}</section>`;
}
export const missingPrintout = view => {
  const why = view.company
    ? 'This dashboard isn’t available right now.'
    : 'These numbers can’t be had: the app may have lost its metrics file.';
  return `<div class="nx">${title('', view.name, why)}<div class="tear">End of printout</div></div>`;
};
