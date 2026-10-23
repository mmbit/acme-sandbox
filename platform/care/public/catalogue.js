// The widget catalogue: each widget is drawn from a JSON spec the server sends (never HTML), and every one can also be
// answered by typing (the hosts and drawings are the company's, by use()). A
// renderer gets the spec, its state (ws: done, picked, photos, note…, kept by the server) and the widget's api:
// answer(payload, echo) sends ids plus the words for the transcript; update(patch) changes local state.
// The `html` attribute below only ever gets the engine's own SVGs and the company's (use()).

// The company's part (its plug-in's public/plugin.js, given by widget.js in the browser and the server's plug-in loader):
//   links: the hosts the chat may link to besides the app's own (its own sites, its carriers' tracking pages); a host
//          matches itself and every subdomain
//   art:   its own drawings for an order's picture (`order`) and the photo slots (`box`, `label`, `flat`, `close`,
//          `print`, `contents`), SVG markup of its own (never a customer's), each optional
let LINKS = [];
export function use({ links, art } = {}) {
  if (links) LINKS = links;
  if (art) Object.assign(OUTLINES, art);
}

export const INTERACTIVE = new Set(['choice', 'order_picker', 'code_entry', 'photo_request', 'consent', 'summary', 'helped', 'health']);
// drawn inside the bubble it belongs to, at its end, rather than as a card under it
export const INLINE = new Set(['outage']);

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  return el;
};

export function render(spec, ws, api) {
  const fn = R[spec.type];
  const el = fn ? fn(spec, ws, api) : h('p', {}, '');
  el.classList.add('wg', `wg-${spec.type}`);
  if (spec.kind) el.dataset.kind = spec.kind; // the case card (the reply to an ask) and the others, for the checks
  if (ws.done) el.classList.add('done');
  if (ws.gone && !ws.done) { el.classList.add('gone'); el.setAttribute('aria-disabled', 'true'); el.querySelectorAll('button, input, textarea').forEach((b) => (b.disabled = true)); }
  if (api.fresh) el.classList.add('pop');
  return el;
}

const locked = (ws) => ws.done || ws.gone;
// what was picked: the server's action id, or the prototype's { action } / { order }
const pickedAction = (ws) => (typeof ws.picked === 'string' ? ws.picked : ws.picked?.action);
const R = {
  choice(spec, ws, api) {
    return h('div', { class: `chips${spec.equal ? ' equal' : ''}`, role: 'group', 'aria-label': api.w('choose') }, spec.options.map((o) => {
      const picked = !!o.action && pickedAction(ws) === o.action;
      return h('button', { type: 'button', class: `chip${o.primary ? ' primary' : ''}${picked ? ' picked' : ''}`, 'aria-pressed': ws.done ? String(picked) : null, disabled: locked(ws),
        onclick: () => api.answer({ action: o.action }, o.echo || o.label) }, o.label);
    }));
  },

  // a card of an order carries its app, and the tap sends it: two stalls of a shop may share a number
  order_picker(spec, ws, api) {
    return h('div', { class: 'orders', role: 'group', 'aria-label': api.w('orders') }, spec.orders.map((o) => {
      // a card with no known date leaves the date out
      const placed = o.date ?? o.ordered, date = placed ? day(placed, api.lang) : null;
      const picked = (!!o.action && pickedAction(ws) === o.action) || (!!o.id && ws.picked?.order === o.id && ws.picked?.app === o.app);
      return h('button', { type: 'button', class: `order${picked ? ' picked' : ''}`, disabled: locked(ws), 'aria-pressed': ws.done ? String(picked) : null,
        onclick: () => api.answer({ ...(o.action ? { action: o.action } : {}), order: o.id, ...(o.app ? { app: o.app } : {}) }, date ? api.w('picked_order', { title: o.title, date }) : o.title) },
      ownImage(o.art) ? h('img', { src: o.art, alt: '', width: 46, height: 61, loading: 'lazy' }) : h('span', { class: 'o-art', html: OUTLINES.order }),
      h('span', { class: 'o-t' }, h('b', {}, o.title), h('span', {}, date ? api.w('ordered', { date, id: o.id }) : o.id)),
      h('span', { class: `pill ${[o.tone, o.state, o.status].find((x) => TONES.has(x)) ?? ''}` }, STATUSES.has(o.status) ? api.w(`st_${o.status}`) : o.status));
    }));
  },

  code_entry(spec, ws, api) {
    const n = spec.length || 6;
    const boxes = Array.from({ length: n }, (_, i) => h('input', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: n, 'aria-label': api.w('digit', { i: i + 1, n }),
      autocomplete: i === 0 ? 'one-time-code' : 'off', disabled: locked(ws), value: ws.done && ws.picked?.code ? ws.picked.code[i] : null }));
    const wrap = h('div', { class: `code${ws.shake ? ' shake' : ''}`, role: 'group', 'aria-label': api.w('code_group', { n, to: spec.to }) }, boxes);
    const put = (digits, from = 0) => { digits.split('').slice(0, n - from).forEach((d, k) => (boxes[from + k].value = d)); check(); };
    const check = () => { const v = boxes.map((b) => b.value).join(''); if (/^\d+$/.test(v) && v.length === n) { boxes.forEach((b) => (b.disabled = true)); setTimeout(() => api.answer({ code: v }, `${v.slice(0, 3)} ${v.slice(3)}`), 250); } };
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => { const d = b.value.replace(/\D/g, ''); if (d.length > 1) return put(d, i); b.value = d; if (d && i < n - 1) boxes[i + 1].focus(); check(); });
      b.addEventListener('keydown', (e) => { if (e.key === 'Backspace' && !b.value && i) { boxes[i - 1].focus(); boxes[i - 1].value = ''; } });
      b.addEventListener('paste', (e) => { e.preventDefault(); put((e.clipboardData.getData('text') || '').replace(/\D/g, ''), 0); });
    });
    return h('div', {}, wrap, h('p', { class: 'fine' }, ws.done ? api.w('code_ok') : api.w('code_hint', { to: spec.to })));
  },

  photo_request(spec, ws, api) {
    const photos = ws.photos || {};
    const list = h('ol', { class: 'slots' }, spec.slots.map((s) => {
      const got = photos[s.id];
      const file = h('input', { type: 'file', accept: 'image/*', class: 'vh', id: `f-${spec.id}-${s.id}`, disabled: locked(ws) });
      file.addEventListener('change', async () => { const f = file.files?.[0]; if (f) api.photo(s.id, await encode(f)); });
      return h('li', { class: `slot${got ? ' got' : ''}${got?.note ? ' ok' : ''}` },
        got ? h('img', { class: 'shot', src: got.src, alt: api.w('photo', { label: s.label }) }) : h('span', { class: 'outline', html: OUTLINES[s.id] || OUTLINES.flat }),
        h('span', { class: 's-t' }, h('b', {}, s.label), s.fine ? h('small', {}, s.fine) : null,
          got?.note ? h('span', { class: 's-note' }, got.note) : got ? h('span', { class: 's-note wait' }, api.w('checking')) : null),
        got || locked(ws) ? null : h('span', { class: 's-act' }, file,
          h('label', { class: 'btn', for: file.id }, h('span', { html: CAM }), api.w('take'))));
    }));
    return h('div', {}, list, spec.fine ? h('p', { class: 'fine' }, spec.fine) : null);
  },

  // one consent for both the page picture and the short log (logs fall under the cookie rule too)
  // Three buttons of equal weight, none primary ("no" as easy as "yes"). "See what we'd send" builds the bundle
  // here in the browser and shows it, nothing sent; "Send it" sends exactly what was shown (the widget froze it), or
  // builds it at the tap; "No thanks" is a tap like any other. The words are the server's templates.
  consent(spec, ws, api) {
    const [send, no] = spec.options;
    const peek = h('div', { class: 'peek', id: `peek-${spec.id}`, hidden: !ws.peek, 'aria-live': 'polite' });
    const fill = (b) => peek.replaceChildren(
      b.picture ? h('img', { class: 'snap', src: b.picture, alt: api.w('snap_alt'), width: b.page.w, height: b.page.h }) : h('p', { class: 'fine' }, api.w('snap_nopic')),
      h('pre', { 'aria-label': api.w('snap_log') }, b.events.map((e) => `${new Date(e.at).toTimeString().slice(0, 8)} ${e.kind} ${e.text}`).join('\n') || api.w('snap_none')));
    if (ws.peek) { const made = api.diagnostics.shown(); if (made) fill(made); else api.diagnostics.preview().then(fill); } // redrawn open: at once, so the log doesn't jump
    const see = h('button', { type: 'button', class: `chip${ws.peek ? ' on' : ''}`, 'aria-expanded': String(!!ws.peek), 'aria-controls': peek.id, onclick: () => {
      const open = peek.hidden; peek.hidden = !open; see.setAttribute('aria-expanded', String(open)); see.classList.toggle('on', open); api.update({ peek: open });
      if (open && !peek.children.length) { peek.append(h('p', { class: 'fine' }, api.w('snap_making'))); api.diagnostics.preview().then(fill); }
    } }, spec.see);
    const chip = (o, onclick) => h('button', { type: 'button', class: `chip${o.action && pickedAction(ws) === o.action ? ' picked' : ''}`, disabled: locked(ws), onclick }, o.label);
    return h('div', {}, h('b', { class: 'sum-h' }, spec.title), h('p', { class: 'c-text' }, spec.text), peek,
      h('div', { class: 'chips equal', role: 'group', 'aria-label': spec.title },
        see, chip(send, () => api.diagnostics.send(send)), chip(no, () => api.answer({ action: no.action }, no.label))),
      h('p', { class: 'fine' }, spec.fine));
  },

  // "Did this help?": the question is the bubble's words, the card its two buttons. The
  // answer is a count with nothing linked, so the tap writes no words into the transcript and the server keeps only that
  // it was answered; afterwards the card just says thanks
  helped(spec, ws, api) {
    if (ws.done) return h('p', { class: 'fine' }, api.w('helped_thanks'));
    return h('div', { class: 'chips equal', role: 'group', 'aria-label': api.w('choose') }, (spec.options || []).map((o) =>
      h('button', { type: 'button', class: 'chip', disabled: locked(ws), onclick: () => api.answer({ action: o.action }, o.label, true, true) }, o.label)));
  },

  // The health-detail card: its words are the bubble's text, above it; two buttons of equal weight, neither
  // primary, since the second is explicit consent (art. 9(2)(a)) and "Edit my message" must be as easy. Drawn for a
  // message the widget held on the device (options with `local`) or one care held (options with server action ids).
  health(spec, ws, api) {
    return h('div', { class: 'chips equal', role: 'group', 'aria-label': api.w('choose') }, spec.options.map((o) =>
      h('button', { type: 'button', class: `chip${(o.action ?? o.local) === pickedAction(ws) || o.local === ws.picked ? ' picked' : ''}`, disabled: locked(ws),
        onclick: () => api.health(o) }, o.label)));
  },

  // the carrier's own page, in a new tab; a link that isn't the company's or a carrier's isn't shown at all
  tracking(spec, ws, api) {
    const url = safeLink(spec.url);
    return h('div', { class: 'track' },
      h('span', { class: 'truck', html: TRUCK }),
      h('span', { class: 't-t' }, h('b', {}, [spec.carrier, spec.status ?? spec.state].filter(Boolean).join(' · ')), h('span', {}, [spec.since && api.w('since', { date: day(spec.since, api.lang) }), spec.code].filter(Boolean).join(' · '))),
      url ? h('a', { class: 'chip', href: url, target: '_blank', rel: 'noopener noreferrer' }, api.w('track')) : null);
  },

  // files of the company's own for this device (company.ts `files`): each a download link on the app's own host, from the
  // server; one that isn't the app's own isn't shown at all
  files(spec) {
    const own = (f) => { const u = safeLink(f.url); return u && new URL(u).origin === location.origin ? u : null; };
    return h('div', { class: 'files' }, spec.title ? h('b', { class: 'sum-h' }, spec.title) : null,
      h('div', { class: 'chips' }, (spec.files || []).map((f) => { const url = own(f); return url ? h('a', { class: 'chip primary', href: url, download: f.name || '' }, f.label) : null; })));
  },

  summary(spec, ws, api) {
    const note = spec.note != null ? h('textarea', { rows: 3, 'aria-label': api.w('note_label'), disabled: locked(ws) }) : null;
    if (note) { note.value = ws.note ?? spec.note; note.addEventListener('input', () => { delete note.dataset.aiGenerated; api.update({ note: note.value }); }); }
    // the AI mark on a note the model wrote, while it's still the model's words (README.md, "The AI mark").
    if (note && spec.noteAiGenerated && note.value === spec.note) note.dataset.aiGenerated = 'true';
    return h('div', { class: 'sum' }, h('b', { class: 'sum-h' }, spec.title),
      h('dl', {}, spec.rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      note ? h('label', { class: 'sum-note' }, h('span', {}, api.w('note_hint')), note) : null,
      h('div', { class: `chips${spec.equal ? ' equal' : ''}` }, spec.options.map((o) => h('button', { type: 'button', class: `chip${o.primary ? ' primary' : ''}${o.action && pickedAction(ws) === o.action ? ' picked' : ''}`, disabled: locked(ws),
        onclick: () => api.answer({ action: o.action, ...(note && o.primary ? { note: note.value } : {}) }, o.label) }, o.label))));
  },

  // The outage message: what's wrong and what happens to their messages are the bubble's text, from the server's templates.
  // A stop's way to a person ends it, one small link in that same bubble (INLINE): one tap, no case made, no card.
  outage(spec, ws, api) {
    return h('span', { class: 'out', hidden: !spec.options?.length }, (spec.options || []).map((o) => h('button', { type: 'button', class: 'link', disabled: !!ws.done,
      onclick: () => api.answer({ action: o.action }, o.label) }, o.label)));
  },
};

// Photos are re-encoded in the browser (EXIF and location gone, at most 1600 px), then kept as a small thumbnail.
// The upload itself isn't built yet: the widget tells the server a photo was taken, nothing more.
async function encode(src, sample = false) {
  const img = src instanceof HTMLCanvasElement ? src : await createImageBitmap(src, { imageOrientation: 'from-image' });
  const k = Math.min(1, 1600 / Math.max(img.width, img.height)), w = Math.round(img.width * k), hh = Math.round(img.height * k);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: hh }); c.getContext('2d').drawImage(img, 0, 0, w, hh);
  const t = Math.min(1, 320 / Math.max(w, hh)), th = Object.assign(document.createElement('canvas'), { width: Math.round(w * t), height: Math.round(hh * t) });
  th.getContext('2d').drawImage(c, 0, 0, th.width, th.height);
  img.close?.();
  return { w, h: hh, thumb: th.toDataURL('image/jpeg', 0.78), sample };
}

// ---- links: only to the company's own hosts and its carriers' tracking pages (use()), https, never a script
const under = (host, d) => host === d || host.endsWith('.' + d);
// the server checks an emailed answer's addresses against the same hosts (engine.ts linksOk), without the app's own origin
export const linkHost = (host) => LINKS.some((d) => under(host, d));
export function safeLink(href) {
  let u; try { u = new URL(String(href ?? ''), location.href); } catch { return null; }
  if (u.origin === location.origin) return u.href; // the app the chat is on (its own domain included)
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  return linkHost(u.hostname) ? u.href : null;
}
// images only from the app's own host: no remote images (a tracking pixel could tell someone the chat was read)
const ownImage = (src) => { try { return !!src && new URL(src, location.href).origin === location.origin; } catch { return false; } };
const TONES = new Set(['shipped', 'delivered', 'printing']);
const STATUSES = new Set(['paid', 'printing', 'shipped', 'delivered', 'cancelled', 'refunded']);
// an ISO date as the customer reads it ("26 Sep", "26 sep.", "26. Sept."); anything else as it came
const day = (d, lang = 'en') => { const t = Date.parse(d); return /^\d{4}-\d\d-\d\d/.test(String(d)) && !isNaN(t) ? new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang, { day: 'numeric', month: 'short' }).format(t) : d; };
const CAM = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.6"/></svg>';
const TRUCK = '<svg viewBox="0 0 40 28" aria-hidden="true"><path d="M3 6h20v14H3zM23 11h8l5 5v4H23z"/><circle cx="10" cy="21" r="3"/><circle cx="30" cy="21" r="3"/><path d="M26 11v5h9" /></svg>';
// outline drawings for the photo slots: what to take, not a stock image; and the picture of an order without its own
const OUTLINES = {
  order: '<svg viewBox="0 0 46 61" aria-hidden="true"><rect x="3" y="3" width="40" height="55" rx="1"/><path d="M10 46l9-11 6 7 4-4 7 8z"/><circle cx="29" cy="20" r="4"/></svg>',
  box: '<svg viewBox="0 0 64 48" aria-hidden="true"><path d="M10 16l22-9 22 9v22l-22 9-22-9z"/><path d="M10 16l22 9 22-9M32 25v22"/><path d="M21 11.5l22 9v7" class="acc"/></svg>',
  label: '<svg viewBox="0 0 64 48" aria-hidden="true"><rect x="12" y="8" width="40" height="32" rx="2"/><path d="M17 15h16M17 20h22M17 25h12" class="acc"/><path d="M17 31v5M19.5 31v5M23 31v5M25 31v5M28 31v5M31.5 31v5M33.5 31v5M37 31v5M40 31v5M42 31v5M45 31v5"/></svg>',
  flat: '<svg viewBox="0 0 64 48" aria-hidden="true"><path d="M17 6h30M17 42h30" stroke-width="3"/><rect x="19" y="7" width="26" height="34"/><path d="M24 34l6-7 4 4 3-3 4 6z" class="acc"/></svg>',
  close: '<svg viewBox="0 0 64 48" aria-hidden="true"><path d="M8 40L26 8M14 42L30 14" class="acc"/><circle cx="36" cy="20" r="12"/><path d="M45 29l10 10"/><path d="M29 16l6 5 4-3 3 6"/></svg>',
  print: '<svg viewBox="0 0 64 48" aria-hidden="true"><circle cx="30" cy="20" r="13"/><path d="M39.5 29.5l11 11"/><path d="M23 26l7-14 7 14M25.5 21h9" class="acc"/></svg>',
};

// ---- the claim's photo slots (`photos`, from photos.ts slotsFor: every word on it is the server's). The note (no faces,
// nobody else's things) sits above the slots, before any camera opens. Each slot has its outline, label and hint and a
// camera button; a photo is re-encoded here to a JPEG of at most 2560 px and 3 MB, which keeps uploads quick and leaves
// the location out, but it isn't a control: the server checks, decodes and re-encodes every one. The slot
// gets its tick when the server has the photo (ws.filled, the server's list), a re-take replaces it, and the option
// ("That's all the photos") goes on like any button.
INTERACTIVE.add('photos');
const SHOT_ART = { box: 'box', label: 'label', box_damage: 'close', product: 'flat', closeup: 'print', contents: 'contents' };
OUTLINES.contents = '<svg viewBox="0 0 64 48" aria-hidden="true"><rect x="6" y="9" width="22" height="30" rx="1"/><path d="M36 12h22M36 20h22" stroke-width="3"/><circle cx="47" cy="33" r="6"/><path d="M12 30l5-6 5 6" class="acc"/></svg>';
R.photos = (spec, ws, api) => {
  const w = spec.words || {}, filled = new Set(ws.filled || []), mine = ws.photos || {};
  const list = h('ol', { class: 'slots' }, (spec.slots || []).map((s) => {
    const got = filled.has(s.shot), here = mine[s.shot] || {};
    const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'vh', id: `f-${spec.id}-${s.shot}`, disabled: locked(ws) || here.sending });
    file.addEventListener('change', () => { const f = file.files?.[0]; if (f) api.upload(s.shot, jpeg(f)); });
    const status = here.sending ? h('span', { class: 's-note wait' }, w.sending) : here.failed ? h('span', { class: 's-note bad', role: 'alert' }, here.failed)
      : got ? h('span', { class: 's-note' }, w.got) : null;
    return h('li', { class: `slot${got ? ' got ok' : ''}` },
      here.thumb ? h('img', { class: 'shot', src: here.thumb, alt: s.label }) : h('span', { class: 'outline', html: OUTLINES[SHOT_ART[s.shot]] || OUTLINES.flat }),
      h('span', { class: 's-t' }, h('b', {}, s.label), s.hint ? h('small', {}, s.hint) : null, status),
      locked(ws) || here.sending ? null : h('span', { class: 's-act' }, file, h('label', { class: 'btn', for: file.id }, h('span', { html: CAM }), got ? w.again : w.take)));
  }));
  return h('div', {}, spec.note ? h('p', { class: 'fine p-note' }, spec.note) : null, list,
    h('div', { class: 'chips' }, (spec.options || []).map((o) => h('button', { type: 'button', class: `chip${o.primary ? ' primary' : ''}${o.action && pickedAction(ws) === o.action ? ' picked' : ''}`,
      disabled: locked(ws), onclick: () => api.answer({ action: o.action }, o.label) }, o.label))));
};
// a photo as a JPEG of at most 2560 px, upright, under 3 MB (quality, then size, stepped down), and a small thumbnail
async function jpeg(file) {
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); URL.revokeObjectURL(img.src); } // a format only <img> decodes
  const draw = (k) => { const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(img.width * k)), height: Math.max(1, Math.round(img.height * k)) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c; };
  let k = Math.min(1, 2560 / Math.max(img.width, img.height)), q = 0.86, blob;
  for (;;) {
    blob = await new Promise((r) => draw(k).toBlob(r, 'image/jpeg', q));
    if (!blob || blob.size <= 2.9 * 1024 * 1024 || k < 0.2) break;
    q = Math.max(0.6, q - 0.1); k *= 0.8;
  }
  const thumb = draw(Math.min(1, 160 / Math.max(img.width, img.height))).toDataURL('image/jpeg', 0.7);
  img.close?.();
  return { blob, thumb };
}
