// A watch-along's moments: its stream folded into the lines an agent reads, each with its time. README.md has the
// design.
//   - A page change, a tap (its label and role), a scroll once it settles, typing once it settles (how much and in
//     which field, never what), a pen stroke (its shape and what's under it), a dwell (DWELL_MS still on a screen that changed), paused and resumed,
//     the screen turned or resized. Each its own moment, numbered; lines() writes the same words in a row as one line,
//     counted.
//   - Folded as the stream comes (add), so a live call's moments cost nothing per turn. A scroll or typing still going
//     on, or a dwell not yet long enough, waits for settle(): its moment comes once it's over.
//   - Times are the page's (rrweb's timestamps); add the recording's clockMs for the server's.
import type { RecordedEvent } from './store.ts';

export type Moment = {
  n: number; // its number, from 1, as the agent asks for it
  at: number; // when, on the page's clock
  kind: 'page' | 'tap' | 'scroll' | 'typed' | 'ink' | 'dwell' | 'paused' | 'resumed' | 'resized';
  words: string; // what happened, in a few words: never a value typed
  x?: number; // a tap's place, in the page's CSS px
  y?: number;
};

// A scroll or typing has settled once nothing more came for this long; a dwell is this long still on a changed screen
export const SCROLL_MS = 600,
  TYPING_MS = 1500,
  DWELL_MS = 4000;
const LABEL_CHARS = 60;

// rrweb's event types and incremental sources this file reads
const FULL_SNAPSHOT = 2,
  INCREMENTAL = 3,
  META = 4,
  CUSTOM = 5;
const MUTATION = 0,
  MOUSE_INTERACTION = 2,
  SCROLL = 3,
  RESIZE = 4,
  INPUT = 5,
  TOUCH_MOVE = 6,
  DRAG = 12;
const ELEMENT = 2,
  TEXT = 3;

// What the fold keeps of the page's DOM: enough to name a field (its label, placeholder or name)
type DomNode = { tag: string; attributes: Record<string, unknown>; parent?: number; children: number[]; text?: string };
// A scroll going on (where it started and is now), and typing in a field (how much; a box's tick)
type Place = { x: number; y: number };
type Scroll = { from: Place; to: Place; last: number };
type Typing = { length: number; checked?: boolean; last: number };
type Serialized = {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: Serialized[];
  textContent?: string;
};

export class Moments {
  readonly list: Moment[] = [];
  private nodes = new Map<number, DomNode>();
  private scrolling = new Map<number, Scroll>();
  private typing = new Map<number, Typing>();
  private positions = new Map<number, Place>(); // each scroller's last settled place: a scroll goes from there
  private root = 0; // the document's node: its scroll is the page's
  private changed = 0; // when the screen last changed after the last thing done (0: not since)
  private lastInput = 0;
  private page = ''; // the address last on, and the first page's origin (left out of the lines)
  private origin = '';

  // Events in the order they came (a batch at a time)
  add(events: RecordedEvent[]) {
    for (const event of events) {
      this.settle(event.timestamp);
      this.take(event);
    }
  }

  // Whatever has settled by this time (the page's clock) becomes a moment; Infinity settles scrolls and typing, but
  // never a dwell: that needs the time to have passed
  settle(now: number) {
    for (const [id, input] of this.typing) if (now - input.last >= TYPING_MS) this.typed(id, input);
    for (const [id, scroll] of this.scrolling) if (now - scroll.last >= SCROLL_MS) this.scrolled(id, scroll);
    if (this.changed && now - this.changed >= DWELL_MS && now !== Infinity) {
      this.push({
        at: this.changed + DWELL_MS,
        kind: 'dwell',
        words: `still for ${DWELL_MS / 1000} s on a changed screen`,
      });
      this.changed = 0;
    }
  }

  // The moments after number n
  after = (n: number) => this.list.filter(moment => moment.n > n);

  // Whether the caller has paused showing the screen (and not resumed since)
  get paused() {
    return this.list.findLast(moment => moment.kind === 'paused' || moment.kind === 'resumed')?.kind === 'paused';
  }

  private take(event: RecordedEvent) {
    const body = event.data as Record<string, any>;
    if (event.type === FULL_SNAPSHOT) {
      // (what was going on settles first, named on the page it happened on)
      this.settleAll();
      this.nodes.clear();
      this.positions.clear();
      this.root = this.index(body.node);
      // (where the page was scrolled to as the snapshot was taken: a page resumed mid-scroll)
      const offset = body.initialOffset ?? {};
      this.positions.set(this.root, { x: Number(offset.left) || 0, y: Number(offset.top) || 0 });
      this.change(event.timestamp);
    } else if (event.type === META) {
      this.change(event.timestamp);
    } else if (event.type === CUSTOM) {
      this.custom(event.timestamp, String(body.tag), body.payload ?? {});
    } else if (event.type === INCREMENTAL) {
      this.incremental(event.timestamp, body);
    }
  }

  private custom(at: number, tag: string, payload: Record<string, any>) {
    if (tag === 'page') {
      const address = String(payload.address ?? '?');
      this.origin ||= originOf(address);
      this.done(at);
      // (the same page again: a recording resumed, or a frame's page told twice)
      if (address !== this.page) this.push({ at, kind: 'page', words: `on ${shortened(address, this.origin)}` });
      this.page = address;
      this.change(at);
    } else if (tag === 'tap') {
      this.done(at);
      const label = tidy(String(payload.label ?? ''));
      const role = tidy(String(payload.role ?? ''));
      const what = label ? `"${label}"${role ? ` (${role})` : ''}` : role ? `a ${role} without a name` : 'the page';
      this.push({ at, kind: 'tap', words: `tapped ${what}`, x: Number(payload.x), y: Number(payload.y) });
    } else if (tag === 'ink' && payload.phase === 'end') {
      this.done(at);
      this.push({ at, kind: 'ink', words: inked(payload) });
    } else if (tag === 'paused' || tag === 'resumed') {
      this.done(at);
      this.settle(Infinity);
      this.push({ at, kind: tag, words: tag === 'paused' ? 'paused showing the screen' : 'showed the screen again' });
    }
  }

  private incremental(at: number, body: Record<string, any>) {
    if (body.source === MUTATION) {
      for (const removed of body.removes ?? []) this.forget(removed.id);
      for (const added of body.adds ?? []) this.attach(added.node, added.parentId, added.nextId);
      for (const text of body.texts ?? []) {
        const node = this.nodes.get(text.id);
        if (node) node.text = text.value ?? '';
      }
      for (const attributeChange of body.attributes ?? []) {
        const node = this.nodes.get(attributeChange.id);
        if (node) Object.assign(node.attributes, attributeChange.attributes);
      }
      this.change(at);
    } else if (body.source === SCROLL) {
      this.lastInput = at;
      this.changed = 0;
      const now = { x: Number(body.x) || 0, y: Number(body.y) || 0 };
      const scroll = this.scrolling.get(body.id);
      if (scroll) Object.assign(scroll, { to: now, last: at });
      else this.scrolling.set(body.id, { from: this.scrolledTo(body.id), to: now, last: at });
      this.positions.set(body.id, now);
    } else if (body.source === INPUT) {
      this.done(at, body.id);
      const length = typeof body.text === 'string' ? [...body.text].length : 0;
      const input = this.typing.get(body.id);
      const checked = typeof body.isChecked === 'boolean' ? body.isChecked : undefined;
      if (input) Object.assign(input, { length, checked, last: at });
      else this.typing.set(body.id, { length, checked, last: at });
    } else if (body.source === RESIZE) {
      this.done(at);
      this.push({ at, kind: 'resized', words: `the screen is now ${body.width} × ${body.height}` });
      this.change(at);
    } else if ([MOUSE_INTERACTION, TOUCH_MOVE, DRAG].includes(body.source)) {
      this.lastInput = at;
      this.changed = 0;
    }
  }

  private scrolledTo = (id: number) => this.positions.get(id) ?? { x: 0, y: 0 };

  // Something was done: typing in another field and every scroll settle now, and the screen isn't still
  private done(at: number, field?: number) {
    this.settleAll(field);
    this.lastInput = at;
    this.changed = 0;
  }
  private settleAll(field?: number) {
    for (const [id, input] of this.typing) if (id !== field) this.typed(id, input);
    for (const [id, scroll] of this.scrolling) this.scrolled(id, scroll);
  }
  private change(at: number) {
    if (!this.changed && this.lastInput && at >= this.lastInput) this.changed = at;
  }

  private scrolled(id: number, scroll: Scroll) {
    this.scrolling.delete(id);
    const down = Math.round(scroll.to.y - scroll.from.y),
      right = Math.round(scroll.to.x - scroll.from.x);
    const what = id === this.root ? 'the page' : this.nameOf(id) ? `"${this.nameOf(id)}"` : 'a part of the page';
    const ways = [
      down ? `${down > 0 ? 'down' : 'up'} ${Math.abs(down)} px` : '',
      right ? `${right > 0 ? 'right' : 'left'} ${Math.abs(right)} px` : '',
    ].filter(Boolean);
    if (ways.length) this.push({ at: scroll.last, kind: 'scroll', words: `scrolled ${what} ${ways.join(' and ')}` });
  }

  private typed(id: number, input: Typing) {
    this.typing.delete(id);
    const node = this.nodes.get(id);
    const name = this.fieldName(id);
    const field = name ? `"${name}"` : 'a field';
    const kind = String(node?.attributes.type ?? '');
    const words =
      input.checked !== undefined && ['checkbox', 'radio'].includes(kind)
        ? `${input.checked ? 'ticked' : 'unticked'} ${field}`
        : node?.tag === 'select'
          ? `picked an option in ${field}`
          : input.length
            ? `typed ${input.length} character${input.length === 1 ? '' : 's'} in ${field}`
            : `emptied ${field}`;
    this.push({ at: input.last, kind: 'typed', words });
  }

  private push(moment: Omit<Moment, 'n'>) {
    this.list.push({ ...moment, n: this.list.length + 1 });
  }

  // A node added (or moved: rrweb adds it again) under its parent, before nextId when that's there
  private attach(node: Serialized, parent: number, next?: number) {
    if (this.nodes.has(node?.id)) this.forget(node.id);
    const id = this.index(node, parent);
    const children = this.nodes.get(parent)?.children;
    if (!id || !children || children.includes(id)) return;
    const before = next == null ? -1 : children.indexOf(next);
    children.splice(before < 0 ? children.length : before, 0, id);
  }
  // A node removed: out of its parent's children, and it and all inside it gone
  private forget(id: number) {
    const node = this.nodes.get(id);
    if (!node) return;
    const siblings = node.parent === undefined ? undefined : this.nodes.get(node.parent)?.children;
    if (siblings?.includes(id)) siblings.splice(siblings.indexOf(id), 1);
    const gone = [id];
    for (const each of gone) {
      gone.push(...(this.nodes.get(each)?.children ?? []));
      this.nodes.delete(each);
    }
  }

  private index(node: Serialized, parent?: number): number {
    if (!node || typeof node.id !== 'number') return 0;
    this.nodes.set(node.id, {
      tag: node.type === ELEMENT ? String(node.tagName ?? '').toLowerCase() : '',
      attributes: { ...(node.attributes ?? {}) },
      parent,
      children: (node.childNodes ?? []).map(child => this.index(child, node.id)),
      text: node.type === TEXT ? String(node.textContent ?? '') : undefined,
    });
    return node.id;
  }

  // A field's name as the page shows it: its aria-label, its label (for= or around it), placeholder or name
  private fieldName(id: number) {
    const node = this.nodes.get(id);
    if (!node) return '';
    const own = node.attributes['aria-label'] ?? '';
    if (own) return tidy(String(own));
    const domId = node.attributes.id;
    for (const [labelId, label] of this.nodes)
      if (label.tag === 'label' && domId && label.attributes.for === domId) return tidy(this.textOf(labelId));
    for (let up = node.parent; up !== undefined; up = this.nodes.get(up)?.parent)
      if (this.nodes.get(up)?.tag === 'label') return tidy(this.textOf(up));
    return tidy(String(node.attributes.placeholder ?? node.attributes.name ?? ''));
  }
  private nameOf = (id: number) => tidy(String(this.nodes.get(id)?.attributes['aria-label'] ?? ''));
  private textOf(id: number): string {
    const node = this.nodes.get(id);
    if (!node) return '';
    return node.text ?? node.children.map(child => this.textOf(child)).join(' ');
  }
}

// Moments as lines: each its number, its time (as `clock` writes it) and what happened; the same words in a row are one
// line, with the first's time and how many (#4–6 17:03:12 tapped "Add" (×3))
export function lines(moments: Moment[], clock: (at: number) => string) {
  const runs: Moment[][] = [];
  for (const moment of moments) {
    const run = runs.at(-1);
    if (run && run[0].kind === moment.kind && run[0].words === moment.words) run.push(moment);
    else runs.push([moment]);
  }
  return runs.map(([first, ...more]) =>
    more.length
      ? `#${first.n}–${more.at(-1)!.n} ${clock(first.at)} ${first.words} (×${more.length + 1})`
      : `#${first.n} ${clock(first.at)} ${first.words}`,
  );
}

// A pen stroke in a few words: its shape (a circle, a box, a line, or a stroke) and what's under it, as the page named
// it (watchalong.js under: the things most of whose box it covers).
function inked(ink: Record<string, any>) {
  const points: number[][] = Array.isArray(ink.stroke?.points) ? ink.stroke.points : [];
  const shape = shapeOf(points);
  const under = (Array.isArray(ink.under) ? ink.under : [])
    .map((thing: Record<string, unknown>) => {
      const label = tidy(String(thing.label ?? '')),
        role = tidy(String(thing.role ?? ''));
      return label ? `"${label}"${role ? ` (${role})` : ''}` : '';
    })
    .filter(Boolean)
    .join(' and ');
  if (!under) return `drew ${shape === 'stroke' ? 'a pen stroke' : `a ${shape}`}`;
  return (
    { circle: `circled ${under}`, box: `drew a box around ${under}`, line: `drew a line under ${under}` }[
      shape as 'circle' | 'box' | 'line'
    ] ?? `drew on ${under}`
  );
}
// A stroke's shape from its points: a rectangle's five corners, a loop that comes back near where it began, a flat
// line, or none of those
const LINE_PX = 24;
function shapeOf(points: number[][]) {
  if (points.length < 2) return 'stroke';
  const xs = points.map(p => p[0]),
    ys = points.map(p => p[1]);
  const width = Math.max(...xs) - Math.min(...xs),
    height = Math.max(...ys) - Math.min(...ys);
  const [first, last] = [points[0], points.at(-1)!];
  const square = points.length === 5 && first[0] === last[0] && first[1] === last[1];
  if (square && points.every((p, i) => !i || p[0] === points[i - 1][0] || p[1] === points[i - 1][1])) return 'box';
  if (height < LINE_PX && width > 2 * height) return 'line';
  const closed = Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.3 * Math.max(width, height);
  return closed && width > 12 && height > 12 ? 'circle' : 'stroke';
}

const originOf = (address: string) => {
  try {
    return new URL(address).origin;
  } catch {
    return '';
  }
};
const shortened = (address: string, origin: string) =>
  origin && address.startsWith(`${origin}/`) ? address.slice(origin.length) : address;

const tidy = (words: string) => {
  const line = words.replace(/\s+/g, ' ').trim();
  return line.length > LABEL_CHARS ? `${line.slice(0, LABEL_CHARS - 1)}…` : line;
};
