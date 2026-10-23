// One frame on the GPU: the floor, the table's pedestal and radar top, the hologram's reflections in both (stencil),
// the beam, the hologram itself, then the labels, the bloom and the lens.
import { TAU, polar, mmul, mesh, targets, LINES, TRIS, POINTS } from './gl.js';
import { programs, MAX_ROOMS } from './shaders.js';
import { TABLE_Y, TABLE_R, RING_R, CROWN_Y, built } from './deck.js';

// ---- the fixed geometry: position + normal (the beam's "normal" carries how far up the cone a vertex is)
// a solid of revolution from a profile of [radius, y] points, bottom to top along the outside
function lathe(profile, seg) {
  const out = [];
  for (let k = 0; k < profile.length - 1; k++) {
    const [r0, y0] = profile[k], [r1, y1] = profile[k + 1], l = Math.hypot(r1 - r0, y1 - y0), nr = (y1 - y0) / l, ny = -(r1 - r0) / l;
    for (let i = 0; i < seg; i++) {
      const a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU, V = (r, y, a) => [...polar(r, a, y), Math.sin(a) * nr, ny, Math.cos(a) * nr];
      out.push(...V(r0, y0, a0), ...V(r1, y1, a0), ...V(r1, y1, a1), ...V(r0, y0, a0), ...V(r1, y1, a1), ...V(r0, y0, a1));
    }
  }
  return new Float32Array(out);
}
function fixed(gl) {
  const top = [], beam = [], up = [0, 1, 0];
  for (let i = 0; i < 192; i++) top.push(0, TABLE_Y, 0, ...up, ...polar(TABLE_R, (i + 1) / 192 * TAU, TABLE_Y), ...up, ...polar(TABLE_R, i / 192 * TAU, TABLE_Y), ...up);
  const B = (v, a) => [...polar(0.3 + 2.15 * v ** 0.8, a, TABLE_Y + 0.005 + (CROWN_Y - TABLE_Y) * v), v, 0, 0];
  for (let j = 0; j < 16; j++) for (let i = 0; i < 96; i++) {
    const v0 = j / 16, v1 = (j + 1) / 16, a0 = i / 96 * TAU, a1 = (i + 1) / 96 * TAU;
    beam.push(...B(v0, a0), ...B(v1, a0), ...B(v1, a1), ...B(v0, a0), ...B(v1, a1), ...B(v0, a1));
  }
  const F = 40, floor = [[-F, -F], [F, F], [F, -F], [-F, -F], [-F, F], [F, F]].flatMap(([x, z]) => [x, 0, z, ...up]);
  return {
    body: mesh(gl, [3, 3], lathe([[2.05, 0], [2.12, 0], [2.14, 0.13], [2.1, 0.15], [2.3, 0.7], [2.62, 0.79], [2.62, 0.9]], 160)),
    top: mesh(gl, [3, 3], new Float32Array(top)), beam: mesh(gl, [3, 3], new Float32Array(beam)), floor: mesh(gl, [3, 3], new Float32Array(floor)),
    lines: mesh(gl, [3, 4], null), tris: mesh(gl, [3, 4], null), points: mesh(gl, [3, 4, 1], null), empty: gl.createVertexArray(),
  };
}

// R: { gl, P (programs), M (meshes), T (targets, from size()) }
export const createRenderer = gl => ({ gl, P: programs(gl), M: fixed(gl), T: null });
export function size(R, w, h, samples) { R.T = targets(R.gl, w, h, R.T, samples); }

function set(gl, P, name, v) {
  const l = P.u[name];
  if (l == null) return;
  if (typeof v === 'number') gl.uniform1f(l, v);
  else if (v.length === 16) gl.uniformMatrix4fv(l, false, v);
  else gl[`uniform${v.length}f`](l, ...v);
}
// f: this frame's { VP, eye, t, flick, fog, day, glitch, power, scale }; labels: the 2d canvas to lay in
export function render(R, S, f, labels) {
  const { gl, P, M, T } = R, { w, h } = T;
  const use = (p, extra = {}) => { gl.useProgram(p.p); for (const [k, v] of Object.entries({ uVP: f.VP, uCam: f.eye, uT: f.t, uFlick: f.flick, uFog: f.fog, uDay: f.day, uGain: 1, uScale: f.scale, ...extra })) set(gl, p, k, v); };
  const drawMesh = (m, mode = gl.TRIANGLES) => { gl.bindVertexArray(m.vao); gl.drawArrays(mode, 0, m.count); };
  M.lines.fill(LINES.f, LINES.n); M.tris.fill(TRIS.f, TRIS.n); M.points.fill(POINTS.f, POINTS.n);

  gl.bindFramebuffer(gl.FRAMEBUFFER, T.ms); gl.viewport(0, 0, w, h);
  gl.depthMask(true); gl.stencilMask(0xff); gl.disable(gl.BLEND);
  gl.clearColor(0.002, 0.004, 0.007, 1); gl.clearStencil(0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  // the solid things, each marking the stencil: the floor 2, the pedestal 0, the table top 1
  gl.enable(gl.STENCIL_TEST); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); gl.enable(gl.DEPTH_TEST);
  gl.stencilFunc(gl.ALWAYS, 2, 0xff); use(P.floor); drawMesh(M.floor);
  gl.stencilFunc(gl.ALWAYS, 0, 0xff); use(P.body); drawMesh(M.body);
  gl.stencilFunc(gl.ALWAYS, 1, 0xff);
  const rooms = S.rooms.slice(0, MAX_ROOMS), room = new Float32Array(MAX_ROOMS * 3), col = new Float32Array(MAX_ROOMS * 3), made = new Float32Array(MAX_ROOMS);
  rooms.forEach((r, i) => { room.set([r.a, r.act, r.flash], i * 3); col.set(r.w.asleep ? [0.35, 0.3, 0.7] : r.col, i * 3); made[i] = built(S, r); });
  use(P.top, { uSweep: ((S.sweep + Math.PI) % TAU) - Math.PI, uDR: RING_R, uHalf: S.half });
  gl.uniform1i(P.top.u.uN, rooms.length); gl.uniform3fv(P.top.u.uRoom, room); gl.uniform3fv(P.top.u.uRCol, col); gl.uniform1fv(P.top.u.uRNew, made);
  drawMesh(M.top);
  // the hologram mirrored in the glossy table top and floor, faintly, where each is
  gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.disable(gl.DEPTH_TEST); gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
  for (const [ref, y0, gain] of [[1, TABLE_Y, 0.16], [2, 0, 0.07]]) {
    gl.stencilFunc(gl.EQUAL, ref, 0xff);
    const VP = mmul(f.VP, [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 2 * y0, 0, 1]);
    use(P.prim, { uVP: VP, uGain: gain }); drawMesh(M.tris); drawMesh(M.lines, gl.LINES);
    use(P.points, { uVP: VP, uGain: gain }); drawMesh(M.points, gl.POINTS);
  }
  gl.disable(gl.STENCIL_TEST); gl.enable(gl.DEPTH_TEST);
  use(P.beam, { uPower: f.power }); drawMesh(M.beam);
  use(P.prim); drawMesh(M.tris); drawMesh(M.lines, gl.LINES);
  use(P.points); drawMesh(M.points, gl.POINTS);
  gl.disable(gl.DEPTH_TEST);

  // resolve, and lay the labels in (so they glow too)
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, T.ms); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, T.sceneFb);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.sceneFb);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.labels);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, labels);
  gl.useProgram(P.label.p); gl.bindVertexArray(M.empty); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.BLEND);
  // bloom: down the mip chain, then back up it, adding
  let src = T.scene, sw = w, sh = h;
  gl.useProgram(P.down.p);
  T.mips.forEach((m, i) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.f); gl.viewport(0, 0, m.w, m.h); gl.bindTexture(gl.TEXTURE_2D, src);
    set(gl, P.down, 'uTx', [1 / sw, 1 / sh]); set(gl, P.down, 'uThr', i === 0 ? 0.22 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3); src = m.t; sw = m.w; sh = m.h;
  });
  gl.useProgram(P.up.p); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  for (let i = T.mips.length - 2; i >= 0; i--) {
    const m = T.mips[i], s = T.mips[i + 1];
    // the first level is a half-res copy of every bright line and letter: kept whole, it laid a soft double over them
    // (the "blurry" deck); a little of it keeps the glow hugging them, the wider levels carry the rest
    if (i === 0) { gl.blendColor(0, 0, 0, 0.35); gl.blendFunc(gl.ONE, gl.CONSTANT_ALPHA); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.f); gl.viewport(0, 0, m.w, m.h); gl.bindTexture(gl.TEXTURE_2D, s.t);
    set(gl, P.up, 'uTx', [0.5 / s.w, 0.5 / s.h]); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.disable(gl.BLEND);
  // the lens, onto the screen
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, w, h);
  gl.useProgram(P.composite.p);
  [T.scene, T.mips[0].t, T.mips[3].t].forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
  gl.uniform1i(P.composite.u.uScene, 0); gl.uniform1i(P.composite.u.uBloom, 1); gl.uniform1i(P.composite.u.uStreak, 2);
  set(gl, P.composite, 'uT', f.t); set(gl, P.composite, 'uGlitch', f.glitch);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.activeTexture(gl.TEXTURE0);
}
