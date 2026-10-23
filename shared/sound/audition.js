// audition.js: the scene of a sound palette's audition film. Each reel item gets a shape that lands on its sounds,
// under its name, its line and the code that plays it. The page brings the reel, its title and audition.css's colours.
//   window.ready = import('.../shared/sound/audition.js').then(({ audition }) => audition({ reel, title, kicker }))

// window.demo is the runtime ad.mjs injects before the page's own scripts (shared/demo/runtime.js)
const { ease, clamp } = window.demo;
const E = Math.exp;
const W = 1080, H = 860; // the stage, before audition.css scales it up
const LEAD_IN = 0.45; // an item's shape and caption fade in this long before its first hit
const TICK = '<svg viewBox="0 0 100 100" width="100%" height="100%"><path d="M28 52 L44 67 L73 36" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" pathLength="1"/></svg>';

let stage = null;

// Each reel item is one sound on screen:
//   kind: its shape, one of KINDS below
//   name, line: the caption
//   t: when its first cue hits (s), and cues: [{ sound, at }], each `at` s after t, as mix.mjs plays them
//   call: the code under the caption, instead of the sfx.play() calls of its cues
//   big (check): the bigger success, larger and with a ring of bubbles
//   tint (tune): the CSS colour its keys rest in
//   label (sting): the line under the mark
// title and kicker are the page's own elements: the title rides over the first sound, then the kicker takes its place.
export function audition({ reel, title = null, kicker = null }) {
  const root = add(document.body, 'audition');
  stage = add(root, 'stage');
  const caption = { name: add(root, 'name'), line: add(root, 'line'), call: add(root, 'call') };
  const views = reel.map(view);

  window.frame = t => {
    if (title) {
      const shown = 1 - demo.p(t, 1.5, 1.85);
      title.style.opacity = shown;
      title.style.transform = `translateY(${(1 - shown) * -40}px)`;
    }
    if (kicker) kicker.style.opacity = demo.p(t, 1.85, 2.15);

    const i = views.findLastIndex((v, j) => t >= (j ? v.item.t - LEAD_IN : 0)), current = views[i];
    views.forEach((v, j) => v.nodes.forEach(n => { n.style.display = j === i ? '' : 'none'; }));
    if (!current) {
      for (const node of Object.values(caption)) node.textContent = '';
      return;
    }
    const item = current.item, next = views[i + 1]?.item.t;
    const shown = i ? demo.p(t, item.t - LEAD_IN, item.t - 0.2) : 1;
    const gone = next == null ? 0 : demo.p(t, next - 0.6, next - LEAD_IN);
    caption.name.textContent = item.name;
    caption.line.textContent = item.line;
    caption.call.textContent = callOf(item);
    for (const node of Object.values(caption)) {
      node.style.opacity = shown * (1 - gone);
      node.style.transform = `translateY(${(1 - shown) * 24}px)`;
    }
    stage.style.opacity = shown * (1 - gone);
    current.draw(t);
  };
}

const add = (parent, className) => {
  const node = document.createElement('div');
  node.className = className;
  parent.append(node);
  return node;
};

// The item's shape, built once and shown only while the item is on
function view(item) {
  const before = new Set(stage.children);
  const draw = KINDS[item.kind](item);
  return { item, draw, nodes: [...stage.children].filter(n => !before.has(n)) };
}

// The line of code under the caption: the item's own call, else the palette calls that play its cues
function callOf(item) {
  if (item.call) return item.call;
  const sounds = item.cues.map(c => c.sound);
  if (sounds.length > 1 && new Set(sounds).size === 1) return `sfx.play('${sounds[0]}', { degree })`;
  return [...new Set(sounds)].map(s => `sfx.play('${s}')`).join('  ');
}

// ---- the shapes: each kind builds its shape for an item and returns how to draw it at time t (s)

const KINDS = {
  key: item => {
    const key = shape('key', W / 2, H / 2 + 40, 300, 300);
    return t => {
      const u = sinceLastHit(item, t);
      tf(key, 0, 18 * press(u), squash(u));
      key.style.boxShadow = `0 ${18 - 14 * press(u)}px 0 var(--line)`;
    };
  },
  row: item => {
    const pills = item.cues.map((c, i) => shape('pill', W / 2 + spread(i, item.cues.length) * 150, H / 2 + 40, 125, 110));
    return t => hits(item).forEach((h, i) => {
      const u = t - h;
      tf(pills[i], 0, 12 * press(u), squash(u));
      light(pills[i], u >= 0);
    });
  },
  dial: item => {
    const dial = shape('ring', W / 2, H / 2 + 20, 380, 380, '<div class="mark"></div>');
    return t => {
      const turned = hits(item).reduce((a, h) => a + 20 * ease.out(clamp((t - h + 0.03) / 0.04, 0, 1)), 0);
      tf(dial, 0, 0, [1, 1], turned - 40, '50% 50%');
    };
  },
  toggle: item => {
    const track = shape('pill', W / 2, H / 2 + 20, 420, 210), knob = shape('dot knob', W / 2 - 105, H / 2 + 20, 172, 172);
    return t => {
      const [hitOn, hitOff] = hits(item);
      const switchedOn = ease.inOut(clamp((t - hitOn + 0.1) / 0.1, 0, 1)), switchedOff = ease.inOut(clamp((t - hitOff + 0.02) / 0.1, 0, 1));
      const on = switchedOn * (1 - switchedOff), u = t >= hitOff ? t - hitOff : t - hitOn;
      tf(knob, 210 * on, 0, squash(u), 0, '50% 50%');
      light(track, on > 0.5);
    };
  },
  pop: item => {
    const dot = shape('dot', W / 2, H / 2 + 20, 300, 300);
    return t => {
      const u = t - item.t, s = u < 0 ? 0 : 1 + 0.35 * E(-u * 10) * Math.cos(u * 26) - 0.35 * E(-u * 40);
      tf(dot, 0, 0, [s, s], 0, '50% 50%');
    };
  },
  flick: item => {
    const card = shape('card', W / 2, H / 2 + 20, 420, 280);
    return t => {
      const u = t - item.t, p = ease.in(clamp(u / 0.32, 0, 1));
      const give = u < 0 ? [1, 1] : [1 - 0.04 * E(-u * 30), 1 - 0.06 * E(-u * 30)];
      tf(card, 900 * p, -260 * p, give, 26 * p, '50% 50%');
      card.style.opacity = 1 - p;
    };
  },
  drawer: item => {
    const drawer = shape('drawer', W / 2, H / 2 + 40, 540, 220, '<div class="handle"></div>');
    return t => {
      const p = ease.out(clamp((t - item.t + 0.26) / 0.26, 0, 1));
      tf(drawer, 0, 300 * (1 - p), squash(t - item.t));
      drawer.style.opacity = clamp(p * 3, 0, 1);
    };
  },
  card: item => {
    const card = shape('card', W / 2, H / 2 + 20, 340, 460);
    return t => {
      const p = ease.out(clamp((t - item.t + 0.2) / 0.2, 0, 1));
      tf(card, 900 * (1 - p), 0, squash(t - item.t), 6 * (1 - p));
    };
  },
  sheet: item => {
    const sheet = shape('sheet', W / 2, H / 2 + 60, 560, 360);
    return t => {
      const u = t - item.t, p = ease.out(clamp((u + 0.22) / 0.22, 0, 1)), give = u > 0 ? 18 * E(-u * 12) * Math.sin(u * 22) : 0;
      tf(sheet, 0, 300 * (1 - p) + give, [1, 1]);
      sheet.style.opacity = clamp(p * 3, 0, 1);
    };
  },
  drop: item => {
    const cushion = shape('pill', W / 2, H / 2 + 230, 520, 120), ball = shape('dot', W / 2, H / 2 + 100, 140, 140);
    const bounces = [[0, 0.095, 70], [0.095, 0.155, 22]]; // [from, to, height]: two hops after the landing
    return t => {
      const u = t - item.t;
      let y;
      if (u < 0) {
        const f = clamp(1 + u / 0.4, 0, 1);
        y = -520 * (1 - f * f);
      } else {
        const bounce = bounces.find(([from, to]) => u >= from && u < to);
        y = bounce ? -bounce[2] * Math.sin(Math.PI * (u - bounce[0]) / (bounce[1] - bounce[0])) : 0;
      }
      tf(ball, 0, y, u >= 0 ? squash(u) : [1, 1]);
      tf(cushion, 0, 0, u >= 0 ? [1 + 0.05 * E(-u * 12), 1 - 0.18 * E(-u * 12)] : [1, 1]);
    };
  },
  nope: item => {
    const key = shape('key', W / 2, H / 2 + 40, 300, 300);
    return t => {
      const shake = (h, side) => (t >= h ? side * 22 * E(-(t - h) * 14) * Math.cos((t - h) * 30) : 0);
      tf(key, shake(item.t, -1) + shake(item.t + 0.14, 1), 0, squash(t - item.t));
    };
  },
  bell: item => {
    const note = shape('note', W / 2, H / 2, 600, 150, '<div class="dot"></div><div class="note-title"></div><div class="note-text"></div>');
    return t => {
      const p = ease.out(clamp((t - item.t + 0.18) / 0.18, 0, 1)), u = t >= item.t + 0.12 ? t - item.t - 0.12 : t - item.t;
      tf(note, 0, -260 * (1 - p), squash(u), 0, '50% 0%');
      note.style.opacity = p;
    };
  },
  // big: the bigger success, drawn larger, with a ring of bubbles
  check: item => {
    const ring = shape('ring', W / 2, H / 2 + 20, 300, 300, TICK), tick = ring.querySelector('path');
    const bubbles = [0, 1, 2, 3, 4, 5, 6, 7].map(() => shape('dot', W / 2, H / 2 + 20, 36, 36));
    const size = item.big ? 1.3 : 1;
    return t => {
      const u = t - item.t, [sx, sy] = squash(u);
      tf(ring, 0, 0, [sx * size, sy * size], 0, '50% 50%');
      tick.style.strokeDasharray = 1;
      tick.style.strokeDashoffset = 1 - ease.out(clamp((u - 0.04) / 0.2, 0, 1));
      ring.style.borderColor = u >= 0 ? 'var(--accent)' : 'var(--ink)';
      bubbles.forEach((b, i) => {
        const v = u - 0.24, on = item.big && v > 0, a = (i / 8) * 2 * Math.PI + 0.3, r = 190 + 90 * ease.out(clamp(v / 0.8, 0, 1));
        b.style.opacity = on ? Math.max(0, 1 - v / 0.9) : 0;
        tf(b, on ? Math.cos(a) * r : 0, on ? Math.sin(a) * r : 0, [1, 1], 0, '50% 50%');
      });
    };
  },
  bloom: item => {
    const bubbles = [0, 1, 2, 3, 4, 5, 6].map(i => shape('dot', W / 2 + Math.sin(i * 2.4) * 220, H / 2 + 180, 70 - i * 4, 70 - i * 4));
    return t => bubbles.forEach((b, i) => {
      const v = t - item.t - 0.45 * Math.pow(i / 6, 1.3), s = v > 0 ? 1 + 0.3 * E(-v * 14) : 0;
      b.style.opacity = v > 0 ? Math.max(0, 1 - v / 1.2) : 0;
      // they rise, but never up into the AI label (house rule 5)
      tf(b, 0, v > 0 ? -260 * ease.out(clamp(v / 1.2, 0, 1)) - i * 20 : 0, [s, s], 0, '50% 50%');
    });
  },
  // a tuning: a key per cue, labelled with its sound and resting in the item's tint
  tune: item => {
    const keys = item.cues.map((cue, i) => {
      const x = W / 2 + spread(i, item.cues.length) * 210, key = shape('key', x, H / 2 + 20, 170, 170);
      shape('label', x, H / 2 + 150, 200, 40).textContent = cue.sound;
      return key;
    });
    const tint = item.tint ?? 'var(--card)';
    return t => hits(item).forEach((h, i) => {
      const u = t - h;
      tf(keys[i], 0, 18 * press(u), squash(u));
      keys[i].style.background = u >= 0 && u < 0.3 ? 'var(--accent)' : tint;
    });
  },
  // the logo moment: a mark rises into place, bubbles fly out sideways, then the item's label shows
  sting: item => {
    const mark = shape('key', W / 2, H / 2 + 20, 310, 310, '<div class="emblem"></div>');
    const bubbles = [0, 1, 2, 3, 4, 5].map(i => shape('dot', W / 2 + (i - 2.5) * 60, H / 2 - 110, 40, 40));
    const label = shape('label', W / 2, H / 2 + 230, 600, 40);
    label.textContent = item.label ?? '';
    return t => {
      const u = t - item.t, p = ease.in(clamp((u + 0.4) / 0.4, 0, 1));
      tf(mark, 0, 160 * (1 - p), squash(u));
      mark.style.opacity = clamp((u + 0.4) / 0.3, 0, 1);
      label.style.opacity = clamp((u - 0.5) / 0.4, 0, 1);
      // out sideways, clear of the AI label (house rule 5)
      bubbles.forEach((b, i) => {
        const v = u - 0.12 - 0.09 * i, q = ease.out(clamp(v / 1.1, 0, 1));
        b.style.opacity = v > 0 ? Math.max(0, 1 - v / 1.1) : 0;
        tf(b, v > 0 ? (i - 2.5) * 45 * q : 0, v > 0 ? -110 * q : 0, [1, 1], 0, '50% 50%');
      });
    };
  },
};

// A w x h box centred on (x, y) of the stage
function shape(className, x, y, w, h, inner = '') {
  const node = add(stage, className);
  Object.assign(node.style, { left: `${x - w / 2}px`, top: `${y - h / 2}px`, width: `${w}px`, height: `${h}px` });
  if (inner) node.innerHTML = inner;
  return node;
}

const hits = item => item.cues.map(c => item.t + (c.at ?? 0));
// Seconds since the item's latest hit so far: negative before its first
const sinceLastHit = (item, t) => {
  const passed = hits(item).filter(h => t >= h);
  return passed.length ? t - Math.max(...passed) : -1;
};
// Where the i-th of n shapes in a row sits, in steps from the middle
const spread = (i, n) => i - (n - 1) / 2;
// The squash every shape does on its hit: flattened at the contact, a springy rebound, then still (u: s since the hit)
const squash = u => {
  if (u < 0) return [1, 1];
  const a = E(-u * 9) * Math.cos(u * 30);
  return [1 + 0.14 * a, 1 - 0.2 * a];
};
// A key going down on its hit and springing back
const press = u => (u < 0 ? 0 : E(-u * 16));
const light = (node, on) => {
  node.style.background = on ? 'var(--accent)' : 'var(--card)';
  node.style.borderColor = on ? 'var(--accent)' : 'var(--line)';
};
const tf = (node, x, y, [sx, sy] = [1, 1], r = 0, origin = '50% 100%') => {
  node.style.transformOrigin = origin;
  node.style.transform = `translate(${x}px, ${y}px) rotate(${r}deg) scale(${sx}, ${sy})`;
};
