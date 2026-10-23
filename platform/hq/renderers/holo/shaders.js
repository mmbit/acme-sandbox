// The holo deck's shaders: the glossy floor, the table's pedestal and radar top, the glowing lines and points, the
// projector's beam, and the post passes (labels, bloom, the lens: fringes, streaks, scanlines, grain).
import { program } from './gl.js';

export const MAX_ROOMS = 32; // the radar top draws a wedge for each of the first this many rooms

// uFog: how thick the air is (the weather's fog thickens it)
const FOG = `uniform float uFog;
float fogf(vec3 w) { return exp(-max(length(w - uCam) - 6.5, 0.0) * uFog); }`;
// the hologram's scan bands and flicker, above the table top only
const HOLO = `float holoMod(vec3 w) {
  if (w.y < 0.93) return 1.0;
  float band = exp(-pow(fract(w.y * 0.42 - uT * 0.19) - 0.5, 2.0) * 240.0);
  return uFlick * (0.9 + 0.1 * sin(w.y * 90.0 - uT * 5.0) + band * 1.1);
}`;
const VS_WORLD = `layout(location=0) in vec3 aPos; layout(location=1) in vec3 aN;
uniform mat4 uVP; out vec3 vW; out vec3 vN;
void main() { vW = aPos; vN = aN; gl_Position = uVP * vec4(aPos, 1.0); }`;
const VS_FULL = `out vec2 vUv;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

// uDay: daylight, 0 at night .. 1 at noon (the room's walls catch a little of it)
const FLOOR = `in vec3 vW; in vec3 vN; uniform vec3 uCam; uniform float uT; uniform float uDay; out vec4 o;
float grid(vec2 p, float s, float px) { vec2 g = abs(fract(p / s - 0.5) - 0.5) * s; vec2 l = 1.0 - smoothstep(vec2(0.0), fwidth(p) * px, g); return max(l.x, l.y); }
void main() {
  float r = length(vW.xz);
  vec3 teal = vec3(0.12, 0.72, 0.95), c = vec3(0.004, 0.0065, 0.010) + vec3(0.010, 0.012, 0.016) * uDay;
  c += teal * (grid(vW.xz, 0.5, 1.0) * 0.045 + grid(vW.xz, 2.5, 1.4) * 0.10) * exp(-max(r - 2.6, 0.0) * 0.28);
  c += teal * (0.30 * exp(-pow(r - 2.72, 2.0) * 7.0) + 0.05 * exp(-r * r * 0.05));
  c += teal * 0.10 * exp(-pow(fract(r * 0.16 - uT * 0.11) - 0.5, 2.0) * 900.0) * exp(-max(r - 2.6, 0.0) * 0.18) * step(2.6, r);
  o = vec4(c * exp(-length(vW - uCam) * 0.055), 1.0);
}`;

const BODY = `in vec3 vW; in vec3 vN; uniform vec3 uCam; uniform float uT; out vec4 o;
${FOG}
void main() {
  vec3 N = normalize(vN), V = normalize(uCam - vW), L = normalize(vec3(0.0, 2.3, 0.0) - vW), teal = vec3(0.15, 0.8, 1.0);
  vec3 c = vec3(0.010, 0.014, 0.020) + teal * (max(dot(N, L), 0.0) * 0.05 + pow(1.0 - max(dot(N, V), 0.0), 4.0) * 0.10);
  float th = atan(vW.x, vW.z) / 6.2831853 * 64.0, f = fract(th);
  float seam = 1.0 - smoothstep(0.0, fwidth(th) * 1.5, min(f, 1.0 - f));
  c *= 1.0 - seam * 0.6;
  c += teal * seam * 0.02 * smoothstep(0.1, 0.8, vW.y);
  float leds = step(0.55, fract(th * 2.0 - uT * 0.5)) * exp(-pow((vW.y - 0.815) / 0.004, 2.0));
  c += teal * (exp(-pow((vW.y - 0.845) / 0.005, 2.0)) * 1.6 + leds * 0.5 + exp(-pow((vW.y - 0.125) / 0.006, 2.0)) * 0.9 + exp(-pow((vW.y - 0.9) / 0.012, 2.0)) * 0.4);
  o = vec4(c * fogf(vW), 1.0);
}`;

// The radar top: rings, ticks, a wedge per room (uRoom: angle, activity, arrival flash; uRCol; uRNew: how far
// it's been built, 1 = done) with a conveyor spoke out to its footprint, the sweep, and the projector's lens.
const TOP = `#define TAU 6.2831853
in vec3 vW; in vec3 vN; uniform vec3 uCam; uniform float uT; uniform float uSweep; uniform float uDR; uniform float uHalf; uniform int uN;
uniform vec3 uRoom[${MAX_ROOMS}]; uniform vec3 uRCol[${MAX_ROOMS}]; uniform float uRNew[${MAX_ROOMS}]; out vec4 o;
${FOG}
float wrapA(float a) { return mod(a + 3.14159265, TAU) - 3.14159265; }
float ln(float d, float px, float w) { return 1.0 - smoothstep(px * w, px * (w + 1.2), d); }
void main() {
  vec2 p = vW.xz; float rr = length(p), th = atan(p.x, p.y), px = length(fwidth(p));
  vec3 cyan = vec3(0.25, 0.85, 1.0), mag = vec3(1.0, 0.22, 0.72);
  vec3 c = vec3(0.007, 0.010, 0.015) * (1.0 - 0.25 * rr / 2.6), e = vec3(0.0);
  vec2 g = abs(fract(p * 8.0) - 0.5) / 8.0;
  e += cyan * 0.05 * ln(length(g), px, 0.6) * smoothstep(0.5, 0.8, rr) * (1.0 - smoothstep(2.1, 2.25, rr));
  e += cyan * 0.06 * ln(abs(fract(rr / 0.25 + 0.5) - 0.5) * 0.25, px, 0.3) * step(0.5, rr) * step(rr, 2.2);
  float tk = abs(fract(th / TAU * 180.0 + 0.5) - 0.5) * TAU / 180.0 * rr, big = step(abs(fract(th / TAU * 36.0 + 0.5) - 0.5), 0.02);
  e += cyan * (0.35 * ln(tk, px, 0.4) * step(2.30, rr) * step(rr, 2.34 + big * 0.05) + 0.50 * ln(abs(rr - 2.28), px, 0.5) + 0.25 * ln(abs(rr - 2.56), px, 0.5) + 1.10 * ln(abs(rr - 2.605), px, 0.8));
  for (int i = 0; i < ${MAX_ROOMS}; i++) {
    if (i >= uN) break;
    float a = uRoom[i].x, act = uRoom[i].y, fl = uRoom[i].z, np = uRNew[i];
    vec3 col = mix(mag, uRCol[i], smoothstep(0.85, 1.0, np));
    float vis = smoothstep(0.0, 0.25, np), da = wrapA(th - a), band = step(0.62, rr) * step(rr, 2.2);
    float inW = step(abs(da), uHalf) * band, edge = ln(abs(abs(da) - uHalf) * rr, px, 0.4) * band;
    e += col * vis * (inW * (0.006 + 0.012 * act + 0.05 * fl) + edge * (0.07 + 0.10 * act));
    e += col * vis * 0.7 * ln(abs(rr - 2.2), px, 1.0) * step(abs(da), uHalf);
    float spoke = ln(abs(da) * rr, px, 0.5) * step(0.4, rr) * step(rr, uDR - 0.3), dash = step(0.55, fract(rr * 3.0 - uT * 1.4 - float(i) * 0.37));
    e += col * vis * spoke * (0.04 + 0.45 * dash * (0.3 + act));
    vec2 fp = vec2(sin(a), cos(a)) * uDR; float dd = length(p - fp);
    e += col * vis * exp(-dd * dd * 14.0) * (0.04 + 0.10 * act + 0.3 * fl);
    if (np < 1.0) e += mag * inW * step(0.5, fract((p.x - p.y) * 14.0 - uT * 2.5)) * 0.10 * vis * (1.0 - smoothstep(0.85, 1.0, np));
  }
  float sd = mod(uSweep - th, TAU), sweepMask = smoothstep(0.38, 0.5, rr) * (1.0 - smoothstep(2.18, 2.26, rr));
  e += cyan * sweepMask * (exp(-sd * 2.6) * 0.10 + ln(abs(wrapA(th - uSweep)) * rr, px, 0.7) * 0.9);
  float iris = step(0.5, fract(th / TAU * 24.0 + uT * 0.3)) * step(0.22, rr) * step(rr, 0.30);
  e += cyan * (1.4 * ln(abs(rr - 0.34), px, 1.0) + 0.5 * ln(abs(rr - 0.42), px, 0.4) + iris * 0.35 + smoothstep(0.34, 0.0, rr) * 0.8 + 0.012 * exp(-rr * 0.7));
  o = vec4((c + e) * fogf(vW), 1.0);
}`;

// lines and triangles in their vertices' colours; uGain dims them for the reflections
const PRIM_VS = `layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol;
uniform mat4 uVP; out vec4 vC; out vec3 vW;
void main() { vC = aCol; vW = aPos; gl_Position = uVP * vec4(aPos, 1.0); }`;
const PRIM = `in vec4 vC; in vec3 vW; uniform vec3 uCam; uniform float uT; uniform float uFlick; uniform float uGain; out vec4 o;
${FOG}
${HOLO}
void main() { o = vec4(vC.rgb * vC.a * fogf(vW) * holoMod(vW) * uGain, 1.0); }`;
// soft glow points, sized in world units (uScale: px per unit at distance 1)
const POINTS_VS = `layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol; layout(location=2) in float aSize;
uniform mat4 uVP; uniform float uScale; out vec4 vC; out vec3 vW;
void main() { vC = aCol; vW = aPos; gl_Position = uVP * vec4(aPos, 1.0); gl_PointSize = clamp(aSize * uScale / gl_Position.w, 1.5, 256.0); }`;
const POINTS = `in vec4 vC; in vec3 vW; uniform vec3 uCam; uniform float uT; uniform float uFlick; uniform float uGain; out vec4 o;
${FOG}
${HOLO}
void main() {
  float d = length(gl_PointCoord * 2.0 - 1.0), a = (exp(-d * d * 16.0) + exp(-d * d * 3.5) * 0.28) * (1.0 - smoothstep(0.8, 1.0, d));
  o = vec4(vC.rgb * vC.a * a * fogf(vW) * holoMod(vW) * uGain, 1.0);
}`;
// the projector's cone of light (uPower: how busy the company is brightens it)
const BEAM = `in vec3 vW; in vec3 vN; uniform vec3 uCam; uniform float uT; uniform float uFlick; uniform float uPower; out vec4 o;
${FOG}
void main() {
  float v = vN.x, ndv = abs(dot(normalize(vec3(vW.x, 0.0, vW.z)), normalize(uCam - vW))), th = atan(vW.x, vW.z);
  float s1 = pow(0.5 + 0.5 * sin(th * 19.0 + sin(th * 5.0 + uT * 0.35) * 2.0), 3.0), s2 = 0.55 + 0.45 * sin(th * 53.0 - uT * 0.6);
  float band = exp(-pow(fract(vW.y * 0.42 - uT * 0.19) - 0.5, 2.0) * 240.0);
  // (v interpolates a hair past 1 at the cone's top edge, and Safari's pow of a negative is NaN: the bloom spreads one
  // NaN pixel over half the screen, black)
  float a = pow(max(1.0 - v, 0.0), 2.4) * smoothstep(0.0, 0.04, v) * (0.3 + 0.7 * s1 * s2) * pow(ndv, 1.5) * (1.0 + band * 0.8) * uFlick * uPower;
  o = vec4(vec3(0.2, 0.75, 1.0) * a * 0.065 * fogf(vW), 1.0);
}`;

const LABEL = `in vec2 vUv; uniform sampler2D uTex; out vec4 o; void main() { o = vec4(texture(uTex, vUv).rgb * 1.25, 1.0); }`;
// bloom: a 13-tap downsample (the first with a threshold), then a tent upsample added back up the chain
const DOWN = `in vec2 vUv; uniform sampler2D uTex; uniform vec2 uTx; uniform float uThr; out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 4.0;
  c += texture(uTex, vUv + uTx * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTx * vec2(1.0, -1.0)).rgb;
  c += texture(uTex, vUv + uTx * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTx * vec2(1.0, 1.0)).rgb;
  c /= 8.0;
  if (uThr > 0.0) { float b = max(c.r, max(c.g, c.b)); c *= max(b - uThr, 0.0) / max(b, 1e-4); }
  o = vec4(c, 1.0);
}`;
const UP = `in vec2 vUv; uniform sampler2D uTex; uniform vec2 uTx; out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv + uTx * vec2(-2.0, 0.0)).rgb + texture(uTex, vUv + uTx * vec2(2.0, 0.0)).rgb;
  c += texture(uTex, vUv + uTx * vec2(0.0, -2.0)).rgb + texture(uTex, vUv + uTx * vec2(0.0, 2.0)).rgb;
  c += (texture(uTex, vUv + uTx * vec2(-1.0, -1.0)).rgb + texture(uTex, vUv + uTx * vec2(1.0, -1.0)).rgb) * 2.0;
  c += (texture(uTex, vUv + uTx * vec2(-1.0, 1.0)).rgb + texture(uTex, vUv + uTx * vec2(1.0, 1.0)).rgb) * 2.0;
  o = vec4(c / 12.0 * 0.9, 1.0);
}`;
// The lens: chromatic fringes towards the edges, the bloom, anamorphic streaks (a few taps: phones), scanlines, a
// vignette, ACES, grain, and a glitch now and then (uGlitch)
const COMPOSITE = `in vec2 vUv; uniform sampler2D uScene; uniform sampler2D uBloom; uniform sampler2D uStreak; uniform float uT; uniform float uGlitch; out vec4 o;
float h(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 uv = vUv; float band = floor(uv.y * 48.0), gl = uGlitch * step(0.78, h(band + floor(uT * 30.0) * 7.0));
  uv.x += gl * (h(band * 3.1 + floor(uT * 30.0)) - 0.5) * 0.05;
  // (fringes grow from nothing in the middle, where the names are read: a constant term split every letter's colours)
  vec2 d = uv - 0.5; vec2 off = d * 0.016 * dot(d, d) + vec2(gl * 0.006 + uGlitch * 0.002, 0.0);
  vec3 col = vec3(texture(uScene, uv + off).r, texture(uScene, uv).g, texture(uScene, uv - off).b);
  col += vec3(texture(uBloom, uv + off * 2.0).r, texture(uBloom, uv).g, texture(uBloom, uv - off * 2.0).b) * 0.7;
  vec3 st = vec3(0.0);
  for (int i = -6; i <= 6; i++) { float x = float(i) / 6.0; st += max(texture(uStreak, vec2(uv.x + x * 0.22, uv.y)).rgb - 0.06, 0.0) * exp(-abs(x) * 5.0); }
  col += dot(st, vec3(0.33)) * vec3(0.25, 0.7, 1.0) * 0.4;
  col *= 0.93 + 0.07 * sin(gl_FragCoord.y * 1.5708);
  col *= 1.0 - 0.55 * smoothstep(0.25, 0.95, length(d * vec2(1.25, 1.0)));
  col = pow(aces(col * 1.15), vec3(1.0 / 2.2)) + vec3(0.006, 0.012, 0.02);
  o = vec4(col + (h2(gl_FragCoord.xy + fract(uT * 13.0) * 100.0) - 0.5) * 0.028, 1.0);
}`;

export const programs = gl => ({
  floor: program(gl, VS_WORLD, FLOOR), body: program(gl, VS_WORLD, BODY), top: program(gl, VS_WORLD, TOP),
  prim: program(gl, PRIM_VS, PRIM), points: program(gl, POINTS_VS, POINTS), beam: program(gl, VS_WORLD, BEAM),
  label: program(gl, VS_FULL, LABEL), down: program(gl, VS_FULL, DOWN), up: program(gl, VS_FULL, UP), composite: program(gl, VS_FULL, COMPOSITE),
});
