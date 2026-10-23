// The agent's drawing on the join page, alive: it breathes, blinks, glances about and now and then sips from its mug
// while idle, leans in while someone talks, looks up while it thinks, and moves its mouth with the level of its own
// voice as it plays (joinpage.js gives it that each frame). A drawing names the parts it has with data-part, and any it
// lacks stays still:
//   figure       all of it: leans in, hops
//   body         breathes (scaled from its bottom edge)
//   head         bobs with the breath, nods while speaking, tilts while thinking (turned near its bottom)
//   eyes         blink (scaled flat)
//   pupils       look about, and towards whoever talks
//   brows        lift while thinking, and on a stressed word
//   mouth-shut   shown while the mouth is closed
//   mouth-open   drawn wide open, scaled from its top edge by the voice
//   arm          lifts the mug for a sip: data-sip="<dx> <dy> <degrees>", where it goes, in the drawing's units
//   light        glows with the voice

// states: idle | listening | thinking | speaking
export class Figure {
  constructor(svg, reduced) {
    this.reduced = reduced;
    this.parts = {};
    for (const el of svg?.querySelectorAll('[data-part]') ?? []) this.parts[el.dataset.part] ??= el;
    const sip = this.parts.arm?.dataset.sip?.split(/\s+/).map(Number);
    this.sipTo = sip?.length === 3 && sip.every(Number.isFinite) ? sip : null;
    this.state = 'idle';
    this.level = 0;
    this.target = null; // a point on screen to look at, or null to look about
    this.t = 0;
    this.v = { lean: 0, think: 0, open: 0, brow: 0, gx: 0, gy: 0, sip: 0, hop: 0 };
    this.blinkAt = 1500;
    this.blinkEnd = 0;
    this.glanceAt = 0;
    this.glance = [0, 0];
    this.sipAt = 9000 + Math.random() * 8000;
    this.sipStart = -1;
    this.hopStart = -1;
  }

  // a point on the screen to look at (null: back to looking about)
  lookAt(x, y) {
    this.target = x == null ? null : [x, y];
  }

  // a happy little hop: someone joined, or the call ended well
  cheer() {
    this.hopStart = this.t;
  }

  frame(now) {
    const dt = Math.min(0.1, (now - (this.t || now)) / 1000);
    this.t = now;
    const v = this.v,
      s = this.state,
      ease = (key, to, rate) => (v[key] += (to - v[key]) * (1 - Math.exp(-rate * dt)));
    // the mouth opens fast and closes a little slower, as a voice does
    ease('open', this.level, this.level > v.open ? 30 : 16);
    ease('lean', s === 'listening' ? 1 : 0, 4);
    ease('think', s === 'thinking' ? 1 : 0, 5);
    ease('brow', s === 'thinking' ? 1 : Math.max(0, this.level - 0.55) * 2.2, 8);
    const [gx, gy] = this.gaze(now, s);
    ease('gx', gx, 10);
    ease('gy', gy, 10);
    this.sipping(now, s, ease);
    const hop = this.hopStart >= 0 ? Math.max(0, 1 - (now - this.hopStart) / 650) : 0;
    v.hop = hop ? Math.sin((1 - hop) * Math.PI) * hop : 0;
    this.draw(now);
  }

  // where the eyes go: up and aside while thinking, at the point it was given, or a glance now and then
  gaze(now, s) {
    if (s === 'thinking') return [0.55, -0.85];
    if (this.target) return this.towards(...this.target);
    if (now > this.glanceAt) {
      this.glanceAt = now + 1400 + Math.random() * 3200;
      this.glance = Math.random() < 0.45 ? [0, 0] : [Math.random() * 1.6 - 0.8, Math.random() * 0.9 - 0.4];
    }
    return s === 'speaking' ? [this.glance[0] * 0.3, this.glance[1] * 0.3] : this.glance;
  }

  towards(x, y) {
    // (where the eyes are on screen, measured twice a second rather than every frame: a measure forces a layout)
    if (!this.eyes || this.t - this.eyes.at > 500)
      this.eyes = { at: this.t, box: (this.parts.eyes ?? this.parts.head)?.getBoundingClientRect() };
    const eyes = this.eyes.box;
    if (!eyes) return [0, 0];
    const dx = x - (eyes.left + eyes.width / 2),
      dy = y - (eyes.top + eyes.height / 2),
      far = Math.hypot(dx, dy) || 1,
      reach = Math.min(1, far / 160);
    return [(dx / far) * reach, (dy / far) * reach];
  }

  // A sip every half a minute or so while idle: up, a slow sip with the eyes shut, down. Anything else puts it down.
  sipping(now, s, ease) {
    if (!this.sipTo || this.reduced) return;
    if (this.sipStart < 0 && s === 'idle' && now > this.sipAt) this.sipStart = now;
    if (this.sipStart < 0) return void ease('sip', 0, 6);
    const p = (now - this.sipStart) / 3000;
    if (s !== 'idle' || p >= 1) {
      this.sipStart = -1;
      this.sipAt = now + 22000 + Math.random() * 20000;
      return;
    }
    ease('sip', p < 0.72 ? 1 : 0, p < 0.72 ? 3.2 : 4.5);
  }

  draw(now) {
    const p = this.parts,
      v = this.v,
      still = this.reduced;
    const breath = still ? 0 : Math.sin((now / 4300) * Math.PI * 2);
    const lean = still ? 0 : v.lean;
    set(
      p.figure,
      `translateY(${(lean * 6 - v.hop * 14).toFixed(2)}px) scale(${(1 + lean * 0.03).toFixed(4)}) rotate(${(-lean * 1.2).toFixed(2)}deg)`,
    );
    set(p.body, `scale(1, ${(1 + breath * 0.012).toFixed(4)})`);
    const nod = still ? 0 : (v.open - 0.3) * 2.2 * (this.state === 'speaking' ? 1 : 0);
    set(p.head, `translateY(${(-breath * 1.6).toFixed(2)}px) rotate(${(v.think * 5 + nod - v.sip * 4).toFixed(2)}deg)`);
    set(p.pupils, `translate(${(v.gx * 5).toFixed(2)}px, ${(v.gy * 4).toFixed(2)}px)`);
    set(p.brows, `translateY(${(-v.brow * 5).toFixed(2)}px)`);
    set(p.eyes, `scale(1, ${this.blink(now).toFixed(3)})`);
    const open = Math.max(0, v.open - 0.04);
    set(p['mouth-open'], `scale(${(0.82 + open * 0.18).toFixed(3)}, ${open.toFixed(3)})`);
    if (p['mouth-shut']) p['mouth-shut'].style.opacity = open > 0.05 ? '0' : '1';
    if (p['mouth-open']) p['mouth-open'].style.opacity = open > 0.02 ? '1' : '0';
    if (this.sipTo) {
      const [dx, dy, deg] = this.sipTo,
        e = v.sip * v.sip * (3 - 2 * v.sip);
      set(
        p.arm,
        `translate(${(dx * e).toFixed(2)}px, ${(dy * e - v.hop * 6).toFixed(2)}px) rotate(${(deg * e).toFixed(2)}deg)`,
      );
    }
    if (p.light) p.light.style.opacity = (0.55 + v.open * 0.45).toFixed(3);
  }

  // how open the eyes are: a blink every few seconds (now and then two), shut during a sip
  blink(now) {
    if (this.v.sip > 0.8) return 0.1;
    if (now > this.blinkAt) {
      this.blinkEnd = now + 150;
      this.blinkAt = now + (Math.random() < 0.2 ? 260 : 2200 + Math.random() * 4200);
    }
    const left = this.blinkEnd - now;
    return left > 0 ? 0.1 + 0.9 * Math.abs(left / 75 - 1) : 1;
  }
}

const set = (el, transform) => {
  if (el) el.style.transform = transform;
};
