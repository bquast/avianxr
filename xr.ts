/* xr.ts - Zero-dependency procedural WebGL2 + WebXR immersive-ar bird tracking renderer */

import {
  Bird,
  Sighting,
  TrackState,
  Vec3,
  Mat4,
  find_species,
  eval_orbit_pos,
  create_flock,
  step_flock,
  step_track,
  predict_track_path,
  pick_bird_by_ray,
  world_to_polar,
  camera_forward,
  screen_ndc_to_ray,
  project_to_ndc,
  m4_ident,
  m4_mul,
  m4_persp,
  m4_look_at,
  m4_trs,
  v3_len,
  v3_norm,
  v3_add,
  v3_scale,
  prng,
} from './birds';

/* Minimal WebXR DOM types so zero extra @types packages are required */
interface XRRigidTransformLike {
  position: DOMPointReadOnly;
  orientation: DOMPointReadOnly;
  matrix: Float32Array;
}
interface XRViewLike {
  projectionMatrix: Float32Array;
  transform: XRRigidTransformLike;
  eye: string;
}
interface XRViewerPoseLike {
  transform: XRRigidTransformLike;
  views: XRViewLike[];
}
interface XRPoseLike {
  transform: XRRigidTransformLike;
}
interface XRInputSourceLike {
  handedness: string;
  targetRayMode: string;
  targetRaySpace: unknown;
}
interface XRWebGLLayerLike {
  framebuffer: WebGLFramebuffer | null;
  framebufferWidth: number;
  framebufferHeight: number;
  getViewport(view: XRViewLike): {x: number; y: number; width: number; height: number};
}
interface XRFrameLike {
  session: XRSessionLike;
  getViewerPose(refSpace: unknown): XRViewerPoseLike | null;
  getPose(space: unknown, baseSpace: unknown): XRPoseLike | null;
}
interface XRSessionLike extends EventTarget {
  renderState: {baseLayer?: XRWebGLLayerLike};
  inputSources: Iterable<XRInputSourceLike>;
  updateRenderState(state: {baseLayer: XRWebGLLayerLike}): void;
  requestReferenceSpace(type: string): Promise<unknown>;
  requestAnimationFrame(cb: (time: number, frame: XRFrameLike) => void): number;
  end(): Promise<void>;
}
interface XRSystemLike {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(mode: string, init?: Record<string, unknown>): Promise<XRSessionLike>;
}

export interface HudTelemetry {
  xr_supported: boolean;
  xr_active: boolean;
  passthrough_sim: boolean;
  zoom: number;
  heading_deg: number;
  pitch_deg: number;
  flock_count: number;
  visible_in_fov: number;
  tracked: {
    id: number;
    code: string;
    common: string;
    sci: string;
    az_deg: number;
    el_deg: number;
    range_m: number;
    speed_ms: number;
    alt_m: number;
    locked: boolean;
    ndc: [number, number] | null;
  } | null;
}

export interface EngineHandle {
  enter_ar: () => Promise<string | null>;
  exit_ar: () => Promise<void>;
  lock_nearest: () => boolean;
  cycle_target: (delta: number) => void;
  clear_lock: () => void;
  log_current_or_pin: (note?: string) => Sighting | null;
  drop_manual_pin: (code: string, note: string) => Sighting;
  spawn_species: (code: string) => void;
  set_zoom: (z: number) => void;
  set_passthrough_sim: (on: boolean) => void;
  set_filter: (code: string) => void;
  sync_pins: (rows: Sighting[]) => void;
  pan_by: (dyaw: number, dpitch: number) => void;
  click_ndc: (nx: number, ny: number) => void;
  destroy: () => void;
}

const VS_MESH = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec3 a_norm;
layout(location = 2) in vec3 a_col;
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec3 v_norm;
out vec3 v_col;
out vec3 v_wpos;
void main() {
  vec4 wp = u_model * vec4(a_pos, 1.0);
  v_wpos = wp.xyz;
  v_norm = mat3(u_model) * a_norm;
  v_col = a_col;
  gl_Position = u_mvp * vec4(a_pos, 1.0);
}
`;

const FS_MESH = `#version 300 es
precision highp float;
in vec3 v_norm;
in vec3 v_col;
in vec3 v_wpos;
uniform vec3 u_eye;
uniform float u_fog_on;
uniform vec3 u_fog_col;
uniform float u_alpha;
out vec4 out_col;
void main() {
  vec3 N = normalize(v_norm);
  vec3 L = normalize(vec3(0.52, 0.80, 0.28));
  float ndl = max(dot(N, L), 0.0);
  vec3 sky_fill = vec3(0.54, 0.68, 0.84);
  vec3 gnd_fill = vec3(0.24, 0.28, 0.20);
  vec3 hemi = mix(gnd_fill, sky_fill, N.y * 0.5 + 0.5);
  vec3 V = normalize(u_eye - v_wpos);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.18;
  vec3 lit = v_col * (hemi * 0.62 + vec3(1.02, 0.96, 0.86) * ndl * 0.72) + vec3(0.95, 0.88, 0.72) * rim;
  if (u_fog_on > 0.5) {
    float dist = length(v_wpos - u_eye);
    float fog = 1.0 - exp(-0.0085 * max(dist - 18.0, 0.0));
    lit = mix(lit, u_fog_col, clamp(fog, 0.0, 0.88));
  }
  lit = lit / (lit + vec3(0.92));
  lit = pow(max(lit, vec3(0.0)), vec3(1.0 / 1.12));
  out_col = vec4(lit, u_alpha);
}
`;

const VS_LINE = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec4 a_col;
uniform mat4 u_vp;
out vec4 v_col;
void main() {
  v_col = a_col;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}
`;

const FS_LINE = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 out_col;
void main() {
  out_col = v_col;
}
`;

function compile_program(gl: WebGL2RenderingContext, vs_src: string, fs_src: string): WebGLProgram {
  const vs = gl.createShader(gl.VERTEX_SHADER)!;
  gl.shaderSource(vs, vs_src);
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, fs_src);
  gl.compileShader(fs);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

/* Geometry builder helpers: each vertex = [x, y, z, nx, ny, nz, r, g, b] (9 floats) */
function push_tri(out: number[], a: Vec3, b: Vec3, c: Vec3, col: Vec3): void {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const nx = ab[1] * ac[2] - ab[2] * ac[1];
  const ny = ab[2] * ac[0] - ab[0] * ac[2];
  const nz = ab[0] * ac[1] - ab[1] * ac[0];
  const n = v3_norm([nx, ny, nz]);
  for (const p of [a, b, c]) {
    out.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2]);
  }
}

function push_box(out: number[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, col: Vec3): void {
  const x0 = cx - sx * 0.5, x1 = cx + sx * 0.5;
  const y0 = cy - sy * 0.5, y1 = cy + sy * 0.5;
  const z0 = cz - sz * 0.5, z1 = cz + sz * 0.5;
  const p000: Vec3 = [x0, y0, z0], p100: Vec3 = [x1, y0, z0], p110: Vec3 = [x1, y1, z0], p010: Vec3 = [x0, y1, z0];
  const p001: Vec3 = [x0, y0, z1], p101: Vec3 = [x1, y0, z1], p111: Vec3 = [x1, y1, z1], p011: Vec3 = [x0, y1, z1];
  /* +Z, -Z, +X, -X, +Y, -Y */
  push_tri(out, p001, p101, p111, col); push_tri(out, p001, p111, p011, col);
  push_tri(out, p100, p000, p010, col); push_tri(out, p100, p010, p110, col);
  push_tri(out, p101, p100, p110, col); push_tri(out, p101, p110, p111, col);
  push_tri(out, p000, p001, p011, col); push_tri(out, p000, p011, p010, col);
  push_tri(out, p011, p111, p110, col); push_tri(out, p011, p110, p010, col);
  push_tri(out, p000, p100, p101, col); push_tri(out, p000, p101, p001, col);
}

function push_cone(out: number[], cx: number, y0: number, cz: number, r: number, h: number, segs: number, col: Vec3): void {
  const apex: Vec3 = [cx, y0 + h, cz];
  const base_c: Vec3 = [cx, y0, cz];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0: Vec3 = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r];
    const p1: Vec3 = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
    push_tri(out, p1, p0, apex, col);
    push_tri(out, base_c, p0, p1, col);
  }
}

function push_disc(out: number[], cx: number, y: number, cz: number, r: number, segs: number, col_in: Vec3, col_out: Vec3): void {
  const c: Vec3 = [cx, y, cz];
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0: Vec3 = [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r];
    const p1: Vec3 = [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r];
    out.push(c[0], c[1], c[2], 0, 1, 0, col_in[0], col_in[1], col_in[2]);
    out.push(p1[0], p1[1], p1[2], 0, 1, 0, col_out[0], col_out[1], col_out[2]);
    out.push(p0[0], p0[1], p0[2], 0, 1, 0, col_out[0], col_out[1], col_out[2]);
  }
}

function build_meadow_geometry(): Float32Array {
  const v: number[] = [];
  /* 1. Ground meadow + subtle outer horizon skirt */
  push_disc(v, 0, 0.0, 0, 110, 40, [0.22, 0.32, 0.17], [0.28, 0.36, 0.24]);
  /* 2. Marsh pond + sandy shoreline (disjoint Y offsets >= 0.02 so zero Z-fighting) */
  push_disc(v, 15, 0.022, -34, 11.2, 24, [0.46, 0.43, 0.33], [0.36, 0.38, 0.26]);
  push_disc(v, 15, 0.045, -34, 9.6, 24, [0.16, 0.32, 0.44], [0.22, 0.40, 0.50]);

  /* 3. Tall Wooden Birding Observation Tower landmark in initial forward-left vista */
  const tx = -11.5, tz = -35.0;
  const wood_dark: Vec3 = [0.36, 0.25, 0.16];
  const wood_mid: Vec3 = [0.48, 0.35, 0.22];
  const roof_col: Vec3 = [0.26, 0.31, 0.28];
  for (const dx of [-1.4, 1.4]) {
    for (const dz of [-1.4, 1.4]) {
      push_box(v, tx + dx, 2.3, tz + dz, 0.22, 4.6, 0.22, wood_dark);
    }
  }
  /* Elevated deck + guardrails + pitched roof */
  push_box(v, tx, 4.6, tz, 3.4, 0.22, 3.4, wood_mid);
  push_box(v, tx, 5.55, tz - 1.55, 3.3, 0.12, 0.12, wood_mid);
  push_box(v, tx, 5.55, tz + 1.55, 3.3, 0.12, 0.12, wood_mid);
  push_box(v, tx - 1.55, 5.55, tz, 0.12, 0.12, 3.3, wood_mid);
  push_box(v, tx + 1.55, 5.55, tz, 0.12, 0.12, 3.3, wood_mid);
  for (const dx of [-1.4, 1.4]) {
    for (const dz of [-1.4, 1.4]) {
      push_box(v, tx + dx, 5.75, tz + dz, 0.16, 2.2, 0.16, wood_dark);
    }
  }
  push_cone(v, tx, 6.8, tz, 2.65, 1.45, 4, roof_col);

  /* 4. Split-rail wooden fence along foreground meadow trail */
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    const fx = i * 4.2;
    const fz = -15.5 + Math.abs(i) * 0.4;
    push_box(v, fx, 0.55, fz, 0.14, 1.1, 0.14, wood_dark);
    if (i < 4 && i !== -1) {
      push_box(v, fx + 2.1, 0.82, fz, 4.2, 0.08, 0.07, wood_mid);
      push_box(v, fx + 2.1, 0.46, fz, 4.2, 0.08, 0.07, wood_mid);
    }
  }

  /* 5. Multi-part perimeter tree groves (tapered trunk + 3 stacked canopy tiers) */
  const rand = prng(108);
  for (let i = 0; i < 32; i++) {
    const ang = (i / 32) * Math.PI * 2 + (rand() - 0.5) * 0.14;
    const dist = 48 + rand() * 32;
    const px = Math.cos(ang) * dist;
    const pz = Math.sin(ang) * dist;
    const sc = 0.85 + rand() * 0.55;
    const tint = (rand() - 0.5) * 0.06;
    const leaf1: Vec3 = [0.16 + tint, 0.29 + tint, 0.16];
    const leaf2: Vec3 = [0.20 + tint, 0.34 + tint, 0.18];
    push_box(v, px, 1.4 * sc, pz, 0.45 * sc, 2.8 * sc, 0.45 * sc, [0.32, 0.22, 0.15]);
    push_cone(v, px, 2.1 * sc, pz, 2.4 * sc, 3.2 * sc, 7, leaf1);
    push_cone(v, px, 3.9 * sc, pz, 1.9 * sc, 2.8 * sc, 7, leaf2);
    push_cone(v, px, 5.5 * sc, pz, 1.3 * sc, 2.2 * sc, 7, leaf1);
  }

  return new Float32Array(v);
}

/* Sleek aerodynamic tapered avian fuselage (+Z is forward flight direction in model space) */
function build_bird_body(body_c: Vec3, accent_c: Vec3, wing_c: Vec3): Float32Array {
  const v: number[] = [];
  /* Tapered diamond-oval rings along Z: tail root -> mid chest -> neck -> crown -> beak tip */
  const rings: Array<{z: number; cy: number; rx: number; ry: number}> = [
    {z: -0.28, cy: 0.02, rx: 0.05, ry: 0.04},
    {z: -0.05, cy: 0.01, rx: 0.11, ry: 0.085},
    {z: 0.16, cy: 0.02, rx: 0.105, ry: 0.08},
    {z: 0.30, cy: 0.06, rx: 0.075, ry: 0.065},
    {z: 0.43, cy: 0.075, rx: 0.04, ry: 0.04},
  ];
  const segs = 8;
  for (let r = 0; r < rings.length - 1; r++) {
    const a = rings[r];
    const b = rings[r + 1];
    for (let s = 0; s < segs; s++) {
      const th0 = (s / segs) * Math.PI * 2;
      const th1 = ((s + 1) / segs) * Math.PI * 2;
      const a0: Vec3 = [Math.cos(th0) * a.rx, a.cy + Math.sin(th0) * a.ry, a.z];
      const a1: Vec3 = [Math.cos(th1) * a.rx, a.cy + Math.sin(th1) * a.ry, a.z];
      const b0: Vec3 = [Math.cos(th0) * b.rx, b.cy + Math.sin(th0) * b.ry, b.z];
      const b1: Vec3 = [Math.cos(th1) * b.rx, b.cy + Math.sin(th1) * b.ry, b.z];
      const is_belly = Math.sin((th0 + th1) * 0.5) < -0.15;
      const col = is_belly ? accent_c : body_c;
      push_tri(v, a0, b0, b1, col);
      push_tri(v, a0, b1, a1, col);
    }
  }
  /* Close tail-root cap and sharp beak cone */
  const tail_cap: Vec3 = [0, 0.02, -0.32];
  const beak_tip: Vec3 = [0, 0.068, 0.58];
  const beak_c: Vec3 = [0.88, 0.68, 0.18];
  const r0 = rings[0];
  const rn = rings[rings.length - 1];
  for (let s = 0; s < segs; s++) {
    const th0 = (s / segs) * Math.PI * 2;
    const th1 = ((s + 1) / segs) * Math.PI * 2;
    const p0: Vec3 = [Math.cos(th0) * r0.rx, r0.cy + Math.sin(th0) * r0.ry, r0.z];
    const p1: Vec3 = [Math.cos(th1) * r0.rx, r0.cy + Math.sin(th1) * r0.ry, r0.z];
    push_tri(v, p1, p0, tail_cap, body_c);

    const h0: Vec3 = [Math.cos(th0) * rn.rx, rn.cy + Math.sin(th0) * rn.ry, rn.z];
    const h1: Vec3 = [Math.cos(th1) * rn.rx, rn.cy + Math.sin(th1) * rn.ry, rn.z];
    push_tri(v, h0, beak_tip, h1, beak_c);
  }
  /* Fanned tail feathers (-Z) */
  const t0: Vec3 = [0, 0.025, -0.26];
  const tl: Vec3 = [-0.21, 0.045, -0.66];
  const tr: Vec3 = [0.21, 0.045, -0.66];
  const tb: Vec3 = [0, 0.01, -0.68];
  push_tri(v, t0, tr, tl, wing_c);
  push_tri(v, t0, tl, tb, accent_c);
  push_tri(v, t0, tb, tr, accent_c);
  return new Float32Array(v);
}

/* Articulated two-section tapered wing (side = +1 right, -1 left) */
function build_bird_wing(side: number, wing_c: Vec3, accent_c: Vec3): Float32Array {
  const v: number[] = [];
  const s = side;
  /* Inner wing (shoulder to wrist) + outer swept primaries */
  push_box(v, s * 0.28, 0.0, 0.02, 0.48, 0.035, 0.26, wing_c);
  const w0: Vec3 = [s * 0.50, 0.015, 0.13];
  const w1: Vec3 = [s * 0.50, 0.015, -0.11];
  const tip: Vec3 = [s * 0.98, 0.02, -0.16];
  const w0b: Vec3 = [s * 0.50, -0.015, 0.13];
  const w1b: Vec3 = [s * 0.50, -0.015, -0.11];
  if (s > 0) {
    push_tri(v, w0, w1, tip, wing_c);
    push_tri(v, w1b, w0b, tip, accent_c);
  } else {
    push_tri(v, w1, w0, tip, wing_c);
    push_tri(v, w0b, w1b, tip, accent_c);
  }
  return new Float32Array(v);
}

interface MeshBuf {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  count: number;
}

function upload_mesh(gl: WebGL2RenderingContext, data: Float32Array): MeshBuf {
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = 9 * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 3 * 4);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, stride, 6 * 4);
  gl.bindVertexArray(null);
  return {vao, vbo, count: data.length / 9};
}

function push_line(buf: number[], a: Vec3, b: Vec3, r: number, g: number, bl: number, al: number): void {
  buf.push(a[0], a[1], a[2], r, g, bl, al);
  buf.push(b[0], b[1], b[2], r, g, bl, al);
}

export function start_engine(
  canvas: HTMLCanvasElement,
  overlay_root: HTMLElement | null,
  initial_pins: Sighting[],
  on_hud: (h: HudTelemetry) => void,
  on_xr_sighting: (s: Sighting) => void
): EngineHandle {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    xrCompatible: true,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;

  if (!gl) {
    on_hud({
      xr_supported: false,
      xr_active: false,
      passthrough_sim: false,
      zoom: 1,
      heading_deg: 0,
      pitch_deg: 12,
      flock_count: 0,
      visible_in_fov: 0,
      tracked: null,
    });
    return {
      enter_ar: async () => 'WebGL2 is unavailable in this browser.',
      exit_ar: async () => {},
      lock_nearest: () => false,
      cycle_target: () => {},
      clear_lock: () => {},
      log_current_or_pin: () => null,
      drop_manual_pin: (code, note) => ({
        id: `S-${Date.now()}`, bird_id: 0, code, common: find_species(code).common, sci: find_species(code).sci,
        az_deg: 0, el_deg: 10, range_m: 20, speed_ms: 0, alt_m: 10, pos: [0, 10, -20], note, time: '08:25:00', source: 'manual-pin',
      }),
      spawn_species: () => {},
      set_zoom: () => {},
      set_passthrough_sim: () => {},
      set_filter: () => {},
      sync_pins: () => {},
      pan_by: () => {},
      click_ndc: () => {},
      destroy: () => {},
    };
  }

  /* Detect software WebGL (SwiftShader in headless test containers) */
  let is_software_gl = false;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) {
    const renderer_str = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
    is_software_gl = /SwiftShader|Software|llvmpipe/i.test(renderer_str);
  }

  let prog_mesh = compile_program(gl, VS_MESH, FS_MESH);
  let prog_line = compile_program(gl, VS_LINE, FS_LINE);
  let meadow_buf = upload_mesh(gl, build_meadow_geometry());

  const shadow_disc_data: number[] = [];
  push_disc(shadow_disc_data, 0, 0.035, 0, 0.85, 12, [0.06, 0.09, 0.05], [0.18, 0.26, 0.14]);
  let shadow_buf = upload_mesh(gl, new Float32Array(shadow_disc_data));

  const bird_meshes = new Map<string, {body: MeshBuf; wing_l: MeshBuf; wing_r: MeshBuf}>();
  function ensure_species_meshes(): void {
    bird_meshes.clear();
    for (const code of ['amekes', 'rethaw', 'perfal', 'grbher3', 'barswa', 'amegfi']) {
      const sp = find_species(code);
      bird_meshes.set(code, {
        body: upload_mesh(gl!, build_bird_body(sp.body_rgb, sp.accent_rgb, sp.wing_rgb)),
        wing_l: upload_mesh(gl!, build_bird_wing(-1, sp.wing_rgb, sp.accent_rgb)),
        wing_r: upload_mesh(gl!, build_bird_wing(1, sp.wing_rgb, sp.accent_rgb)),
      });
    }
  }
  ensure_species_meshes();

  let line_vao = gl.createVertexArray()!;
  let line_vbo = gl.createBuffer()!;
  function setup_line_vao(): void {
    gl!.bindVertexArray(line_vao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, line_vbo);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 3, gl!.FLOAT, false, 7 * 4, 0);
    gl!.enableVertexAttribArray(1);
    gl!.vertexAttribPointer(1, 4, gl!.FLOAT, false, 7 * 4, 3 * 4);
    gl!.bindVertexArray(null);
  }
  setup_line_vao();

  /* Simulation & camera state */
  let flock: Bird[] = create_flock(42, 12);
  let next_bird_id = 13;
  let tracked_id: number | null = flock[0].id;
  let track_state: TrackState | null = step_track(null, flock[0], 0.016);
  let pins: Sighting[] = [...initial_pins];
  let filter_code = 'all';

  let cam_yaw = 0.0;
  let cam_pitch = 0.24; /* Aimed slightly upward into the sky + tower vista */
  let zoom = 1;
  let passthrough_sim = false;
  let last_eye: Vec3 = [0, 1.68, 0];
  let last_vp: Mat4 = m4_ident();

  let xr_supported = false;
  let xr_session: XRSessionLike | null = null;
  let xr_ref_space: unknown = null;
  let xr_rays: Array<{origin: Vec3; dir: Vec3}> = [];

  const nav_xr = (navigator as unknown as {xr?: XRSystemLike}).xr;
  if (nav_xr && typeof nav_xr.isSessionSupported === 'function') {
    nav_xr.isSessionSupported('immersive-ar').then((ok) => {
      xr_supported = Boolean(ok);
    }).catch(() => {
      xr_supported = false;
    });
  }

  /* Held WASD / Arrow keyboard look */
  const held_keys = new Set<string>();
  function on_keydown(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    held_keys.add(e.code);
  }
  function on_keyup(e: KeyboardEvent): void {
    held_keys.delete(e.code);
  }
  window.addEventListener('keydown', on_keydown);
  window.addEventListener('keyup', on_keyup);

  function on_context_lost(e: Event): void {
    e.preventDefault();
  }
  function on_context_restored(): void {
    if (!gl) return;
    prog_mesh = compile_program(gl, VS_MESH, FS_MESH);
    prog_line = compile_program(gl, VS_LINE, FS_LINE);
    meadow_buf = upload_mesh(gl, build_meadow_geometry());
    shadow_buf = upload_mesh(gl, new Float32Array(shadow_disc_data));
    ensure_species_meshes();
    line_vao = gl.createVertexArray()!;
    line_vbo = gl.createBuffer()!;
    setup_line_vao();
  }
  canvas.addEventListener('webglcontextlost', on_context_lost);
  canvas.addEventListener('webglcontextrestored', on_context_restored);

  function now_hhmmss(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function make_sighting_from_bird(b: Bird, source: 'xr-ray' | 'reticle', note: string): Sighting {
    const sp = find_species(b.code);
    const pol = world_to_polar(last_eye, b.pos);
    return {
      id: `S-${Date.now().toString(36)}-${b.id}`,
      bird_id: b.id,
      code: b.code,
      common: sp.common,
      sci: sp.sci,
      az_deg: pol.az_deg,
      el_deg: pol.el_deg,
      range_m: pol.range_m,
      speed_ms: v3_len(b.vel),
      alt_m: b.pos[1],
      pos: [...b.pos] as Vec3,
      note: note || (source === 'xr-ray' ? 'Quest 3 AR ray lock' : 'Optical reticle lock'),
      time: now_hhmmss(),
      source,
    };
  }

  /* Render a single eye/camera view given View and Projection matrices */
  function render_view(view_mat: Mat4, proj_mat: Mat4, eye_pos: Vec3, ar_transparent: boolean, sim_time: number): void {
    if (!gl) return;
    const vp = m4_mul(proj_mat, view_mat);
    last_vp = vp;
    last_eye = eye_pos;

    const fog_col: Vec3 = [0.64, 0.76, 0.88];
    const u_mvp = gl.getUniformLocation(prog_mesh, 'u_mvp');
    const u_model = gl.getUniformLocation(prog_mesh, 'u_model');
    const u_eye = gl.getUniformLocation(prog_mesh, 'u_eye');
    const u_fog_on = gl.getUniformLocation(prog_mesh, 'u_fog_on');
    const u_fog_col = gl.getUniformLocation(prog_mesh, 'u_fog_col');
    const u_alpha = gl.getUniformLocation(prog_mesh, 'u_alpha');

    gl.useProgram(prog_mesh);
    gl.uniform3fv(u_eye, eye_pos);
    gl.uniform3fv(u_fog_col, fog_col);
    gl.uniform1f(u_fog_on, ar_transparent ? 0.0 : 1.0);
    gl.uniform1f(u_alpha, 1.0);

    /* 1. Meadow & landmarks in Field mode (skipped in AR passthrough so real world shows through) */
    if (!ar_transparent) {
      const ident = m4_ident();
      gl.uniformMatrix4fv(u_model, false, ident);
      gl.uniformMatrix4fv(u_mvp, false, vp);
      gl.bindVertexArray(meadow_buf.vao);
      gl.drawArrays(gl.TRIANGLES, 0, meadow_buf.count);
    }

    /* 2. Articulated 3D birds + ground contact shadows */
    for (let i = 0; i < flock.length; i++) {
      const b = flock[i];
      if (filter_code !== 'all' && b.code !== filter_code) continue;
      const sp = find_species(b.code);
      const meshes = bird_meshes.get(b.code);
      if (!meshes) continue;

      const visual_scale = Math.max(0.85, sp.span * 1.35);
      const pitch = -Math.asin(Math.max(-0.7, Math.min(0.7, b.vel[1] / Math.max(v3_len(b.vel), 1))));
      const body_m = m4_trs(b.pos, b.yaw, pitch, b.bank, visual_scale);
      const body_mvp = m4_mul(vp, body_m);

      gl.uniformMatrix4fv(u_model, false, body_m);
      gl.uniformMatrix4fv(u_mvp, false, body_mvp);
      gl.bindVertexArray(meshes.body.vao);
      gl.drawArrays(gl.TRIANGLES, 0, meshes.body.count);

      /* Flapping wings hinged at shoulder in bird local space */
      const flap = Math.sin(b.phase) * 0.68;
      const wl_local = m4_trs([-0.06, 0.03, 0], 0, 0, -flap, 1.0);
      const wr_local = m4_trs([0.06, 0.03, 0], 0, 0, flap, 1.0);
      const wl_m = m4_mul(body_m, wl_local);
      const wr_m = m4_mul(body_m, wr_local);

      gl.uniformMatrix4fv(u_model, false, wl_m);
      gl.uniformMatrix4fv(u_mvp, false, m4_mul(vp, wl_m));
      gl.bindVertexArray(meshes.wing_l.vao);
      gl.drawArrays(gl.TRIANGLES, 0, meshes.wing_l.count);

      gl.uniformMatrix4fv(u_model, false, wr_m);
      gl.uniformMatrix4fv(u_mvp, false, m4_mul(vp, wr_m));
      gl.bindVertexArray(meshes.wing_r.vao);
      gl.drawArrays(gl.TRIANGLES, 0, meshes.wing_r.count);

      if (!ar_transparent) {
        const sh_m = m4_trs([b.pos[0], 0.0, b.pos[2]], 0, 0, 0, visual_scale * 0.9);
        gl.uniformMatrix4fv(u_model, false, sh_m);
        gl.uniformMatrix4fv(u_mvp, false, m4_mul(vp, sh_m));
        gl.bindVertexArray(shadow_buf.vao);
        gl.drawArrays(gl.TRIANGLES, 0, shadow_buf.count);
      }
    }

    /* 3. Spatial AR lines: 360° horizon compass ticks, 3D target bracket, lead ribbon, pins, XR rays */
    const lines: number[] = [];

    /* 360° spatial compass ring at 14m radius around viewer */
    const ring_r = 14.0;
    const ring_y = ar_transparent ? Math.max(0.15, eye_pos[1] - 1.15) : 0.14;
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const nx = eye_pos[0] + Math.sin(rad) * ring_r;
      const nz = eye_pos[2] - Math.cos(rad) * ring_r;
      const is_card = deg % 90 === 0;
      const h = is_card ? 0.52 : 0.22;
      const is_north = deg === 0;
      const cr = is_north ? 0.98 : 0.85;
      const cg = is_north ? 0.68 : 0.90;
      const cb = is_north ? 0.16 : 0.96;
      const ca = is_card ? 0.85 : 0.36;
      push_line(lines, [nx, ring_y, nz], [nx, ring_y + h, nz], cr, cg, cb, ca);
      /* Connect subtle horizon circle segment */
      const rad2 = ((deg + 15) * Math.PI) / 180;
      const nx2 = eye_pos[0] + Math.sin(rad2) * ring_r;
      const nz2 = eye_pos[2] - Math.cos(rad2) * ring_r;
      push_line(lines, [nx, ring_y, nz], [nx2, ring_y, nz2], 0.75, 0.84, 0.94, 0.22);
    }

    /* Passthrough simulation spatial reference grid when testing AR optics on desktop */
    if (ar_transparent && !xr_session) {
      for (let g = -40; g <= 40; g += 8) {
        push_line(lines, [g, 0.02, -40], [g, 0.02, 40], 0.25, 0.38, 0.48, 0.22);
        push_line(lines, [-40, 0.02, g], [40, 0.02, g], 0.25, 0.38, 0.48, 0.22);
      }
    }

    /* Subtle locator brackets on untracked birds in AR passthrough so peripheral birds read clearly */
    for (let i = 0; i < flock.length; i++) {
      const b = flock[i];
      if (filter_code !== 'all' && b.code !== filter_code) continue;
      if (b.id === tracked_id) continue;
      const s = 0.55;
      push_line(lines, [b.pos[0] - s, b.pos[1], b.pos[2]], [b.pos[0] + s, b.pos[1], b.pos[2]], 0.75, 0.88, 0.98, 0.32);
      push_line(lines, [b.pos[0], b.pos[1] - s, b.pos[2]], [b.pos[0], b.pos[1] + s, b.pos[2]], 0.75, 0.88, 0.98, 0.32);
    }

    /* Active tracked bird: 3D spatial corner cube brackets + alpha-beta predicted path + altitude drop-line */
    if (track_state) {
      const p = track_state.est_pos;
      const pulse = 1.15 + Math.sin(sim_time * 5.0) * 0.08;
      const c_len = 0.48;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const corner: Vec3 = [p[0] + sx * pulse, p[1] + sy * pulse, p[2] + sz * pulse];
            push_line(lines, corner, [corner[0] - sx * c_len, corner[1], corner[2]], 0.98, 0.68, 0.12, 0.96);
            push_line(lines, corner, [corner[0], corner[1] - sy * c_len, corner[2]], 0.98, 0.68, 0.12, 0.96);
            push_line(lines, corner, [corner[0], corner[1], corner[2] - sz * c_len], 0.98, 0.68, 0.12, 0.96);
          }
        }
      }
      /* Predicted 2-second trajectory curve */
      const pred = predict_track_path(track_state, 8, 0.25);
      for (let i = 0; i < pred.length - 1; i++) {
        const fade = 1.0 - i / pred.length;
        push_line(lines, pred[i], pred[i + 1], 0.98, 0.76, 0.24, 0.88 * fade);
      }
      /* Ground altitude reference stem */
      push_line(lines, p, [p[0], 0.05, p[2]], 0.98, 0.68, 0.12, 0.28);
    }

    /* Spatial 3D Sighting Pins dropped in the world */
    for (let i = 0; i < pins.length; i++) {
      const s = pins[i].pos;
      const d = 0.42;
      push_line(lines, [s[0], s[1] + d, s[2]], [s[0] + d, s[1], s[2]], 0.38, 0.86, 0.96, 0.9);
      push_line(lines, [s[0] + d, s[1], s[2]], [s[0], s[1] - d, s[2]], 0.38, 0.86, 0.96, 0.9);
      push_line(lines, [s[0], s[1] - d, s[2]], [s[0] - d, s[1], s[2]], 0.38, 0.86, 0.96, 0.9);
      push_line(lines, [s[0] - d, s[1], s[2]], [s[0], s[1] + d, s[2]], 0.38, 0.86, 0.96, 0.9);
      push_line(lines, [s[0], s[1] - d, s[2]], [s[0], Math.max(0.05, s[1] - 3.5), s[2]], 0.38, 0.86, 0.96, 0.35);
    }

    /* Quest 3 Controller / Hand-Tracking Pinch Aiming Rays */
    for (let i = 0; i < xr_rays.length; i++) {
      const r = xr_rays[i];
      const start = v3_add(r.origin, v3_scale(r.dir, 0.12));
      const end = v3_add(r.origin, v3_scale(r.dir, 30.0));
      push_line(lines, start, end, 0.98, 0.72, 0.18, 0.82);
    }

    if (lines.length > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog_line);
      gl.uniformMatrix4fv(gl.getUniformLocation(prog_line, 'u_vp'), false, vp);
      gl.bindVertexArray(line_vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, line_vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, lines.length / 7);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }
  }

  let running = true;
  let raf_id = 0;
  let timer_id = 0;
  let prev_ms = performance.now();
  let last_hud_ms = 0;

  function emit_hud(now_ms: number, force = false): void {
    if (!force && now_ms - last_hud_ms < 120) return;
    last_hud_ms = now_ms;

    let visible_in_fov = 0;
    for (let i = 0; i < flock.length; i++) {
      const b = flock[i];
      if (filter_code !== 'all' && b.code !== filter_code) continue;
      const ndc = project_to_ndc(b.pos, last_vp);
      if (ndc && Math.abs(ndc[0]) <= 1.0 && Math.abs(ndc[1]) <= 1.0) {
        visible_in_fov++;
      }
    }

    let tracked_info: HudTelemetry['tracked'] = null;
    if (tracked_id !== null) {
      const tb = flock.find((x) => x.id === tracked_id);
      if (tb && track_state) {
        const sp = find_species(tb.code);
        const pol = world_to_polar(last_eye, track_state.est_pos);
        const ndc3 = project_to_ndc(track_state.est_pos, last_vp);
        tracked_info = {
          id: tb.id,
          code: tb.code,
          common: sp.common,
          sci: sp.sci,
          az_deg: pol.az_deg,
          el_deg: pol.el_deg,
          range_m: pol.range_m,
          speed_ms: v3_len(track_state.est_vel),
          alt_m: track_state.est_pos[1],
          locked: track_state.locked,
          ndc: ndc3 && Math.abs(ndc3[0]) <= 1.15 && Math.abs(ndc3[1]) <= 1.15 ? [ndc3[0], ndc3[1]] : null,
        };
      }
    }

    const fwd = xr_session
      ? [0, 0, -1] as Vec3
      : camera_forward(cam_yaw, cam_pitch);
    const look_pol = world_to_polar([0, 0, 0], fwd);

    on_hud({
      xr_supported,
      xr_active: Boolean(xr_session),
      passthrough_sim,
      zoom,
      heading_deg: look_pol.az_deg,
      pitch_deg: look_pol.el_deg,
      flock_count: filter_code === 'all' ? flock.length : flock.filter((b) => b.code === filter_code).length,
      visible_in_fov,
      tracked: tracked_info,
    });
  }

  function step_simulation(now_ms: number): {dt: number; sim_t: number} {
    const dt = Math.min(0.05, Math.max(0.001, (now_ms - prev_ms) / 1000));
    prev_ms = now_ms;
    const sim_t = now_ms / 1000;

    /* Apply WASD / Arrow smooth camera pan in 2D Field / Sim mode */
    if (!xr_session) {
      const pan_speed = (1.35 / Math.sqrt(zoom)) * dt;
      if (held_keys.has('ArrowLeft') || held_keys.has('KeyA')) cam_yaw -= pan_speed;
      if (held_keys.has('ArrowRight') || held_keys.has('KeyD')) cam_yaw += pan_speed;
      if (held_keys.has('ArrowUp') || held_keys.has('KeyW')) cam_pitch = Math.min(1.38, cam_pitch + pan_speed * 0.8);
      if (held_keys.has('ArrowDown') || held_keys.has('KeyS')) cam_pitch = Math.max(-0.55, cam_pitch - pan_speed * 0.8);
    }

    flock = step_flock(flock, dt, sim_t);
    if (tracked_id !== null) {
      const tb = flock.find((b) => b.id === tracked_id);
      if (tb && (filter_code === 'all' || tb.code === filter_code)) {
        track_state = step_track(track_state, tb, dt);
      } else {
        tracked_id = null;
        track_state = null;
      }
    }
    return {dt, sim_t};
  }

  function frame_2d(now_ms: number): void {
    if (!running || xr_session || !gl) return;
    const {sim_t} = step_simulation(now_ms);

    const dpr = is_software_gl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    if (passthrough_sim) {
      gl.clearColor(0.04, 0.06, 0.09, 1.0);
    } else {
      gl.clearColor(0.56, 0.71, 0.86, 1.0);
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye: Vec3 = [0, 1.68, 0];
    const fwd = camera_forward(cam_yaw, cam_pitch);
    const target = v3_add(eye, fwd);
    const view_mat = m4_look_at(eye, target, [0, 1, 0]);
    const base_fov = (62 * Math.PI) / 180;
    const fov = base_fov / zoom;
    const proj_mat = m4_persp(fov, w / h, 0.15, 220.0);

    xr_rays = [];
    render_view(view_mat, proj_mat, eye, passthrough_sim, sim_t);
    emit_hud(now_ms);

    if (is_software_gl) {
      gl.flush();
      timer_id = window.setTimeout(() => {
        if (running && !xr_session) raf_id = requestAnimationFrame(frame_2d);
      }, 33);
    } else {
      raf_id = requestAnimationFrame(frame_2d);
    }
  }

  function invert_rigid_matrix(m: Float32Array): Mat4 {
    /* Orthonormal rigid transform inverse: R^T and -R^T * t */
    const out = new Float32Array(16);
    out[0] = m[0]; out[1] = m[4]; out[2] = m[8]; out[3] = 0;
    out[4] = m[1]; out[5] = m[5]; out[6] = m[9]; out[7] = 0;
    out[8] = m[2]; out[9] = m[6]; out[10] = m[10]; out[11] = 0;
    const tx = m[12], ty = m[13], tz = m[14];
    out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
    out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
    out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
    out[15] = 1;
    return out;
  }

  function frame_xr(now_ms: number, frame: XRFrameLike): void {
    const session = frame.session;
    if (!running || session !== xr_session || !gl || !xr_ref_space) return;
    session.requestAnimationFrame(frame_xr);

    const {sim_t} = step_simulation(now_ms);
    const pose = frame.getViewerPose(xr_ref_space);
    const layer = session.renderState.baseLayer;
    if (!pose || !layer) return;

    /* Collect Quest 3 controller & hand-pinch aiming rays */
    xr_rays = [];
    for (const src of session.inputSources) {
      if (!src.targetRaySpace) continue;
      const rpose = frame.getPose(src.targetRaySpace, xr_ref_space);
      if (!rpose) continue;
      const m = rpose.transform.matrix;
      const origin: Vec3 = [m[12], m[13], m[14]];
      const dir: Vec3 = v3_norm([-m[8], -m[9], -m[10]]);
      xr_rays.push({origin, dir});
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.enable(gl.DEPTH_TEST);
    /* Alpha 0.0 reveals Meta Quest 3 full-color stereo passthrough cameras */
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    for (const view of pose.views) {
      const vp = layer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      const view_mat = invert_rigid_matrix(view.transform.matrix);
      const p = view.transform.position;
      const eye_pos: Vec3 = [p.x, p.y, p.z];
      render_view(view_mat, view.projectionMatrix, eye_pos, true, sim_t);
    }

    emit_hud(now_ms);
  }

  raf_id = requestAnimationFrame(frame_2d);

  async function enter_ar(): Promise<string | null> {
    if (!nav_xr) {
      passthrough_sim = true;
      emit_hud(performance.now(), true);
      return 'WebXR unavailable on this browser — switched to AR Passthrough Optics Preview.';
    }
    try {
      const supported = await nav_xr.isSessionSupported('immersive-ar');
      if (!supported) {
        passthrough_sim = true;
        emit_hud(performance.now(), true);
        return 'immersive-ar requires Meta Quest Browser on Quest 3 — switched to AR Passthrough Preview.';
      }
      const init: Record<string, unknown> = {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['dom-overlay', 'hand-tracking', 'hit-test'],
      };
      if (overlay_root) {
        init.domOverlay = {root: overlay_root};
      }
      const session = await nav_xr.requestSession('immersive-ar', init);
      const gl_xr = gl as WebGL2RenderingContext & {makeXRCompatible?: () => Promise<void>};
      if (gl_xr.makeXRCompatible) {
        await gl_xr.makeXRCompatible();
      }
      const LayerCtor = (window as unknown as {XRWebGLLayer: new (s: XRSessionLike, g: WebGL2RenderingContext, o?: Record<string, unknown>) => XRWebGLLayerLike}).XRWebGLLayer;
      session.updateRenderState({baseLayer: new LayerCtor(session, gl!, {alpha: true})});
      let ref_space: unknown;
      try {
        ref_space = await session.requestReferenceSpace('local-floor');
      } catch {
        ref_space = await session.requestReferenceSpace('local');
      }

      xr_session = session;
      xr_ref_space = ref_space;
      cancelAnimationFrame(raf_id);
      clearTimeout(timer_id);

      /* Quest 3 Trigger or Hand Pinch ('select' event) locks targeted bird or drops 3D sighting pin */
      session.addEventListener('select', (ev: Event) => {
        const xrev = ev as unknown as {frame: XRFrameLike; inputSource: XRInputSourceLike};
        if (!xr_ref_space || !xrev.frame || !xrev.inputSource?.targetRaySpace) return;
        const rpose = xrev.frame.getPose(xrev.inputSource.targetRaySpace, xr_ref_space);
        if (!rpose) return;
        const m = rpose.transform.matrix;
        const origin: Vec3 = [m[12], m[13], m[14]];
        const dir: Vec3 = v3_norm([-m[8], -m[9], -m[10]]);
        const hit = pick_bird_by_ray(flock, origin, dir, 7.5, filter_code);
        if (hit) {
          tracked_id = hit.id;
          track_state = step_track(null, hit, 0.016);
          const s = make_sighting_from_bird(hit, 'xr-ray', 'Quest 3 pinch/trigger lock');
          pins = [s, ...pins];
          on_xr_sighting(s);
        } else {
          const pin_pos = v3_add(origin, v3_scale(dir, 22.0));
          pin_pos[1] = Math.max(1.2, pin_pos[1]);
          const code = filter_code === 'all' ? 'amekes' : filter_code;
          const sp = find_species(code);
          const pol = world_to_polar(origin, pin_pos);
          const s: Sighting = {
            id: `S-${Date.now().toString(36)}`,
            bird_id: 0,
            code,
            common: sp.common,
            sci: sp.sci,
            az_deg: pol.az_deg,
            el_deg: pol.el_deg,
            range_m: pol.range_m,
            speed_ms: 0,
            alt_m: pin_pos[1],
            pos: pin_pos,
            note: 'Real-world AR sky waypoint',
            time: now_hhmmss(),
            source: 'xr-ray',
          };
          pins = [s, ...pins];
          on_xr_sighting(s);
        }
        emit_hud(performance.now(), true);
      });

      session.addEventListener('end', () => {
        xr_session = null;
        xr_ref_space = null;
        xr_rays = [];
        prev_ms = performance.now();
        emit_hud(prev_ms, true);
        raf_id = requestAnimationFrame(frame_2d);
      });

      session.requestAnimationFrame(frame_xr);
      emit_hud(performance.now(), true);
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to start immersive-ar session.';
      return msg;
    }
  }

  async function exit_ar(): Promise<void> {
    if (xr_session) {
      await xr_session.end();
    }
  }

  function lock_nearest(): boolean {
    const dir = camera_forward(cam_yaw, cam_pitch);
    /* First try tight reticle cone, then widen to entire sky so button always acquires a live target */
    let hit = pick_bird_by_ray(flock, last_eye, dir, 28, filter_code);
    if (!hit) {
      hit = pick_bird_by_ray(flock, last_eye, dir, 179, filter_code);
    }
    if (!hit) return false;
    tracked_id = hit.id;
    track_state = step_track(null, hit, 0.016);
    /* Smoothly orient view toward newly acquired target in 2D mode if outside FOV */
    if (!xr_session) {
      const ndc = project_to_ndc(hit.pos, last_vp);
      if (!ndc || Math.abs(ndc[0]) > 0.75 || Math.abs(ndc[1]) > 0.75) {
        const pol = world_to_polar(last_eye, hit.pos);
        cam_yaw = (pol.az_deg * Math.PI) / 180;
        cam_pitch = Math.max(-0.4, Math.min(1.25, (pol.el_deg * Math.PI) / 180));
      }
    }
    emit_hud(performance.now(), true);
    return true;
  }

  function cycle_target(delta: number): void {
    const pool = filter_code === 'all' ? flock : flock.filter((b) => b.code === filter_code);
    if (pool.length === 0) return;
    const cur_idx = pool.findIndex((b) => b.id === tracked_id);
    const next_idx = cur_idx < 0 ? 0 : (cur_idx + delta + pool.length) % pool.length;
    const target = pool[next_idx];
    tracked_id = target.id;
    track_state = step_track(null, target, 0.016);
    if (!xr_session) {
      const pol = world_to_polar(last_eye, target.pos);
      cam_yaw = (pol.az_deg * Math.PI) / 180;
      cam_pitch = Math.max(-0.4, Math.min(1.25, (pol.el_deg * Math.PI) / 180));
    }
    emit_hud(performance.now(), true);
  }

  function clear_lock(): void {
    tracked_id = null;
    track_state = null;
    emit_hud(performance.now(), true);
  }

  function log_current_or_pin(note = ''): Sighting | null {
    if (tracked_id !== null) {
      const b = flock.find((x) => x.id === tracked_id);
      if (b) {
        const s = make_sighting_from_bird(b, 'reticle', note);
        pins = [s, ...pins];
        return s;
      }
    }
    return null;
  }

  function drop_manual_pin(code: string, note: string): Sighting {
    const sp = find_species(code);
    const dir = camera_forward(cam_yaw, cam_pitch);
    const pos = v3_add(last_eye, v3_scale(dir, 24.0));
    pos[1] = Math.max(1.5, pos[1]);
    const pol = world_to_polar(last_eye, pos);
    const s: Sighting = {
      id: `S-${Date.now().toString(36)}`,
      bird_id: 0,
      code: sp.code,
      common: sp.common,
      sci: sp.sci,
      az_deg: pol.az_deg,
      el_deg: pol.el_deg,
      range_m: pol.range_m,
      speed_ms: 0,
      alt_m: pos[1],
      pos,
      note: note.trim(),
      time: now_hhmmss(),
      source: 'manual-pin',
    };
    pins = [s, ...pins];
    emit_hud(performance.now(), true);
    return s;
  }

  function spawn_species(code: string): void {
    const sp = find_species(code);
    const fwd = camera_forward(cam_yaw, cam_pitch);
    const flat = v3_norm([fwd[0], 0, fwd[2]]);
    const alt = Math.max(sp.alt_min, Math.min(sp.alt_max, 14));
    const anchor: Vec3 = [last_eye[0] + flat[0] * 24, alt, last_eye[2] + flat[2] * 24];
    const id = next_bird_id++;
    const orbit_r = 12;
    const pos = eval_orbit_pos(anchor, orbit_r, id, sp, 0, prev_ms / 1000);
    const b: Bird = {
      id,
      code: sp.code,
      pos,
      vel: [0, 0, sp.speed],
      yaw: 0,
      bank: -0.22,
      phase: 0,
      anchor,
      orbit_r,
      orbit_dir: 1,
    };
    flock = [...flock, b];
    filter_code = 'all';
    tracked_id = b.id;
    track_state = step_track(null, b, 0.016);
    emit_hud(performance.now(), true);
  }

  function click_ndc(nx: number, ny: number): void {
    const dpr = is_software_gl ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, canvas.clientWidth * dpr);
    const h = Math.max(1, canvas.clientHeight * dpr);
    const fov = ((62 * Math.PI) / 180) / zoom;
    const ray = screen_ndc_to_ray(nx, ny, cam_yaw, cam_pitch, fov, w / h);
    const hit = pick_bird_by_ray(flock, last_eye, ray, 8.5, filter_code);
    if (hit) {
      tracked_id = hit.id;
      track_state = step_track(null, hit, 0.016);
      emit_hud(performance.now(), true);
    }
  }

  function destroy(): void {
    running = false;
    cancelAnimationFrame(raf_id);
    clearTimeout(timer_id);
    window.removeEventListener('keydown', on_keydown);
    window.removeEventListener('keyup', on_keyup);
    canvas.removeEventListener('webglcontextlost', on_context_lost);
    canvas.removeEventListener('webglcontextrestored', on_context_restored);
    if (xr_session) {
      xr_session.end().catch(() => {});
    }
  }

  return {
    enter_ar,
    exit_ar,
    lock_nearest,
    cycle_target,
    clear_lock,
    log_current_or_pin,
    drop_manual_pin,
    spawn_species,
    set_zoom: (z: number) => {
      zoom = z;
      emit_hud(performance.now(), true);
    },
    set_passthrough_sim: (on: boolean) => {
      passthrough_sim = on;
      emit_hud(performance.now(), true);
    },
    set_filter: (code: string) => {
      filter_code = code;
      emit_hud(performance.now(), true);
    },
    sync_pins: (rows: Sighting[]) => {
      pins = [...rows];
    },
    pan_by: (dyaw: number, dpitch: number) => {
      cam_yaw += dyaw / zoom;
      cam_pitch = Math.max(-0.55, Math.min(1.38, cam_pitch + dpitch / zoom));
    },
    click_ndc,
    destroy,
  };
}
