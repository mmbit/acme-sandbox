// WebGL2 plumbing for the holo deck: programs, meshes, render targets, the per-frame batches of glowing lines,
// triangles and points, and the small vector and matrix maths the camera needs.
export const TAU = Math.PI * 2;

// ---- vectors (plain [x, y, z] arrays) and column-major 4×4 matrices
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const nrm = a => scl(a, 1 / (Math.hypot(...a) || 1));
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const polar = (r, a, y) => [Math.sin(a) * r, y, Math.cos(a) * r];
export const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// sx, sy: an off-axis shift of the picture (NDC), so the middle of the view is the middle of what the chrome leaves free
export function persp(fov, aspect, near, far, sx = 0, sy = 0) {
  const t = 1 / Math.tan(fov / 2);
  return [t / aspect, 0, 0, 0, 0, t, 0, 0, -sx, -sy, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
}
export function lookAt(eye, at) {
  const z = nrm(sub(eye, at)), x = nrm(cross([0, 1, 0], z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
export function mmul(a, b) {
  const r = new Array(16);
  for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + i] * b[c * 4 + k]; r[c * 4 + i] = s; }
  return r;
}

// ---- GL objects
// The context, or null where the device has no WebGL2. Float targets when the GPU renders to them (HDR bloom),
// else 8-bit ones (the glow clips sooner, the look holds).
export function context(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const float = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');
  return Object.assign(gl, { HDR: float ? gl.RGBA16F : gl.RGBA8, MSAA: Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0) });
}
function shader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, '#version 300 es\nprecision highp float;\n' + src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(`holo: a shader didn't compile: ${gl.getShaderInfoLog(s)}`);
  return s;
}
// { p, u: uniform locations by name }
export function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`holo: a program didn't link: ${gl.getProgramInfoLog(p)}`);
  const u = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const { name } = gl.getActiveUniform(p, i); u[name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, name); }
  return { p, u };
}
// layout: floats per attribute (locations 0, 1, …); data: a Float32Array, or null for one filled every frame
export function mesh(gl, layout, data) {
  const vao = gl.createVertexArray(), buf = gl.createBuffer(), per = layout.reduce((s, n) => s + n, 0);
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  let off = 0;
  layout.forEach((n, i) => { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, n, gl.FLOAT, false, per * 4, off); off += n * 4; });
  gl.bindVertexArray(null);
  const m = { vao, count: 0, fill(f32, n = f32.length) { gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, f32, data ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW, 0, n); m.count = n / per; } };
  if (data) m.fill(data);
  return m;
}
function texture(gl, w, h, fmt) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  if (fmt) gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}
function framebuffer(gl, tex) {
  const f = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return f;
}
const renderbuffer = (gl, fmt, w, h, samples) => {
  const r = gl.createRenderbuffer(), n = Math.min(gl.MSAA, samples);
  gl.bindRenderbuffer(gl.RENDERBUFFER, r);
  if (n > 1) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, fmt, w, h); else gl.renderbufferStorage(gl.RENDERBUFFER, fmt, w, h);
  return r;
};
// The frame's targets at w×h: the multisampled scene (with stencil, for the reflections; at most `samples` samples),
// its resolved copy, the bloom's mip chain and the labels' texture. The last ones are deleted first.
export function targets(gl, w, h, old, samples) {
  if (old) {
    for (const t of [old.scene, old.labels, ...old.mips.map(m => m.t)]) gl.deleteTexture(t);
    for (const f of [old.sceneFb, old.ms, ...old.mips.map(m => m.f)]) gl.deleteFramebuffer(f);
    for (const r of old.rbs) gl.deleteRenderbuffer(r);
  }
  const scene = texture(gl, w, h, gl.HDR), ms = gl.createFramebuffer(), rbs = [renderbuffer(gl, gl.HDR, w, h, samples), renderbuffer(gl, gl.DEPTH24_STENCIL8, w, h, samples)];
  gl.bindFramebuffer(gl.FRAMEBUFFER, ms);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbs[0]);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rbs[1]);
  const mips = [];
  for (let i = 0, mw = w, mh = h; i < 6; i++) { mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); const t = texture(gl, mw, mh, gl.HDR); mips.push({ t, f: framebuffer(gl, t), w: mw, h: mh }); }
  return { w, h, scene, sceneFb: framebuffer(gl, scene), ms, rbs, mips, labels: texture(gl, w, h) };
}

// ---- the frame's batches: lines and triangles (position, colour) and glow points (position, colour, size)
function batch(per) {
  const b = { per, f: new Float32Array(per * 4096), n: 0 };
  b.push = (...v) => {
    if (b.n + v.length > b.f.length) { const f = new Float32Array(b.f.length * 2); f.set(b.f); b.f = f; }
    for (const x of v) b.f[b.n++] = x;
  };
  return b;
}
export const LINES = batch(7), TRIS = batch(7), POINTS = batch(8);
export function begin() { LINES.n = TRIS.n = POINTS.n = 0; }
// colours are [r, g, b, a], a being the intensity (it may go well over 1: the bloom picks that up)
export function line(a, b, ca, cb = ca) { LINES.push(...a, ...ca, ...b, ...cb); }
export function pt(p, c, size) { POINTS.push(...p, ...c, size); }
export function tri(a, b, c, ca, cb = ca, cc = cb) { TRIS.push(...a, ...ca, ...b, ...cb, ...c, ...cc); }
// a flat arc round centre c (in the plane y = c[1]) from angle a0 to a1
export function arc(c, r, col, a0 = 0, a1 = TAU, seg = 48) {
  const n = Math.max(2, Math.ceil(seg * Math.abs(a1 - a0) / TAU));
  let prev = null;
  for (let i = 0; i <= n; i++) { const p = add(c, polar(r, a0 + (a1 - a0) * i / n, 0)); if (prev) line(prev, p, col); prev = p; }
}
export function dashes(c, r, col, n, duty, rot) { for (let i = 0; i < n; i++) { const a = rot + i / n * TAU; arc(c, r, col, a, a + duty * TAU / n, 48); } }
// a flat ring or disc, colour ci inside fading to co outside
export function disc(c, r0, r1, ci, co, seg = 48, a0 = 0, a1 = TAU) {
  for (let i = 0; i < seg; i++) {
    const s0 = a0 + (a1 - a0) * i / seg, s1 = a0 + (a1 - a0) * (i + 1) / seg, P = (r, a) => add(c, polar(r, a, 0));
    tri(P(r0, s0), P(r1, s0), P(r1, s1), ci, co, co); tri(P(r0, s0), P(r1, s1), P(r0, s1), ci, co, ci);
  }
}
