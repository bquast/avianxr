/* birds.ts - Pure functional bird kinematics, vector/matrix math, and alpha-beta tracking */

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export interface Species {
  code: string;
  common: string;
  sci: string;
  span: number;
  speed: number;
  flap_hz: number;
  alt_min: number;
  alt_max: number;
  pattern: 'soar' | 'bound' | 'stoop' | 'glide' | 'dart';
  body_rgb: Vec3;
  wing_rgb: Vec3;
  accent_rgb: Vec3;
}

export interface Bird {
  id: number;
  code: string;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  bank: number;
  phase: number;
  anchor: Vec3;
  orbit_r: number;
  orbit_dir: number;
}

export interface PolarCoord {
  az_deg: number;
  el_deg: number;
  range_m: number;
}

export interface TrackState {
  bird_id: number;
  est_pos: Vec3;
  est_vel: Vec3;
  age_s: number;
  locked: boolean;
}

export interface Sighting {
  id: string;
  bird_id: number;
  code: string;
  common: string;
  sci: string;
  az_deg: number;
  el_deg: number;
  range_m: number;
  speed_ms: number;
  alt_m: number;
  pos: Vec3;
  note: string;
  time: string;
  source: 'xr-ray' | 'reticle' | 'manual-pin';
}

export interface NearbyObs {
  code: string;
  common: string;
  sci: string;
  count: number;
  lat: number;
  lng: number;
  loc: string;
  time: string;
}

export const SPECIES: Species[] = [
  {
    code: 'amekes',
    common: 'American Kestrel',
    sci: 'Falco sparverius',
    span: 0.58,
    speed: 9.5,
    flap_hz: 6.2,
    alt_min: 9,
    alt_max: 24,
    pattern: 'dart',
    body_rgb: [0.76, 0.41, 0.24],
    wing_rgb: [0.34, 0.43, 0.52],
    accent_rgb: [0.92, 0.86, 0.76],
  },
  {
    code: 'rethaw',
    common: 'Red-tailed Hawk',
    sci: 'Buteo jamaicensis',
    span: 1.24,
    speed: 11.2,
    flap_hz: 2.1,
    alt_min: 22,
    alt_max: 46,
    pattern: 'soar',
    body_rgb: [0.42, 0.29, 0.20],
    wing_rgb: [0.52, 0.37, 0.25],
    accent_rgb: [0.78, 0.34, 0.18],
  },
  {
    code: 'perfal',
    common: 'Peregrine Falcon',
    sci: 'Falco peregrinus',
    span: 1.04,
    speed: 17.8,
    flap_hz: 4.8,
    alt_min: 18,
    alt_max: 42,
    pattern: 'stoop',
    body_rgb: [0.28, 0.33, 0.40],
    wing_rgb: [0.22, 0.27, 0.34],
    accent_rgb: [0.88, 0.85, 0.78],
  },
  {
    code: 'grbher3',
    common: 'Great Blue Heron',
    sci: 'Ardea herodias',
    span: 1.75,
    speed: 8.4,
    flap_hz: 1.6,
    alt_min: 7,
    alt_max: 18,
    pattern: 'glide',
    body_rgb: [0.44, 0.52, 0.60],
    wing_rgb: [0.33, 0.41, 0.50],
    accent_rgb: [0.84, 0.80, 0.68],
  },
  {
    code: 'barswa',
    common: 'Barn Swallow',
    sci: 'Hirundo rustica',
    span: 0.34,
    speed: 12.6,
    flap_hz: 7.5,
    alt_min: 4,
    alt_max: 14,
    pattern: 'dart',
    body_rgb: [0.16, 0.27, 0.48],
    wing_rgb: [0.13, 0.22, 0.40],
    accent_rgb: [0.82, 0.44, 0.22],
  },
  {
    code: 'amegfi',
    common: 'American Goldfinch',
    sci: 'Spinus tristis',
    span: 0.26,
    speed: 7.8,
    flap_hz: 8.4,
    alt_min: 5,
    alt_max: 15,
    pattern: 'bound',
    body_rgb: [0.90, 0.76, 0.14],
    wing_rgb: [0.15, 0.16, 0.18],
    accent_rgb: [0.95, 0.94, 0.88],
  },
];

export function find_species(code: string): Species {
  for (let i = 0; i < SPECIES.length; i++) {
    if (SPECIES[i].code === code) {
      return SPECIES[i];
    }
  }
  return SPECIES[0];
}

export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function v3_add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3_sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function v3_scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function v3_dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function v3_cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function v3_len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function v3_norm(a: Vec3): Vec3 {
  const l = v3_len(a);
  if (l < 1e-8) {
    return [0, 0, -1];
  }
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function m4_ident(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function m4_mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4 + 0];
    const b1 = b[c * 4 + 1];
    const b2 = b[c * 4 + 2];
    const b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

export function m4_persp(fov_rad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1.0 / Math.tan(fov_rad * 0.5);
  const nf = 1.0 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

export function m4_look_at(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = v3_norm(v3_sub(eye, target));
  const x = v3_norm(v3_cross(up, z));
  const y = v3_cross(z, x);
  const out = new Float32Array(16);
  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[3] = 0;
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[7] = 0;
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[11] = 0;
  out[12] = -v3_dot(x, eye);
  out[13] = -v3_dot(y, eye);
  out[14] = -v3_dot(z, eye);
  out[15] = 1;
  return out;
}

export function m4_trs(pos: Vec3, yaw: number, pitch: number, roll: number, scale: number): Mat4 {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);

  const r00 = (cy * cr + sy * sp * sr) * scale;
  const r01 = (cp * sr) * scale;
  const r02 = (-sy * cr + cy * sp * sr) * scale;

  const r10 = (-cy * sr + sy * sp * cr) * scale;
  const r11 = (cp * cr) * scale;
  const r12 = (sy * sr + cy * sp * cr) * scale;

  const r20 = (sy * cp) * scale;
  const r21 = (-sp) * scale;
  const r22 = (cy * cp) * scale;

  const out = new Float32Array(16);
  out[0] = r00;
  out[1] = r01;
  out[2] = r02;
  out[3] = 0;
  out[4] = r10;
  out[5] = r11;
  out[6] = r12;
  out[7] = 0;
  out[8] = r20;
  out[9] = r21;
  out[10] = r22;
  out[11] = 0;
  out[12] = pos[0];
  out[13] = pos[1];
  out[14] = pos[2];
  out[15] = 1;
  return out;
}

/* World convention: -Z is North (0 deg), +X is East (90 deg), +Y is Up */
export function world_to_polar(eye: Vec3, target: Vec3): PolarCoord {
  const d = v3_sub(target, eye);
  const range_m = v3_len(d);
  if (range_m < 1e-6) {
    return {az_deg: 0, el_deg: 0, range_m: 0};
  }
  const horiz = Math.hypot(d[0], d[2]);
  let az = (Math.atan2(d[0], -d[2]) * 180) / Math.PI;
  if (az < 0) {
    az += 360;
  }
  const el = (Math.atan2(d[1], horiz) * 180) / Math.PI;
  return {az_deg: az, el_deg: el, range_m};
}

export function compass_cardinal(az_deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round((((az_deg % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

export function eval_orbit_pos(
  anchor: Vec3,
  orbit_r: number,
  bird_id: number,
  sp: Species,
  th: number,
  time_s: number
): Vec3 {
  let rad = orbit_r;
  if (sp.pattern === 'dart') {
    rad += Math.sin(time_s * 1.4 + bird_id) * 2.5;
  } else if (sp.pattern === 'stoop') {
    rad += Math.cos(time_s * 0.9 + bird_id * 1.7) * 4.0;
  }
  const x = anchor[0] + Math.cos(th) * rad;
  const z = anchor[2] + Math.sin(th) * rad;

  let y = anchor[1];
  if (sp.pattern === 'soar') {
    y += Math.sin(time_s * 0.45 + bird_id) * 3.2;
  } else if (sp.pattern === 'bound') {
    y += Math.abs(Math.sin(time_s * 2.6 + bird_id)) * 1.6 - 0.6;
  } else if (sp.pattern === 'stoop') {
    y += Math.sin(time_s * 0.85 + bird_id * 2.1) * 5.5;
  } else {
    y += Math.sin(time_s * 1.1 + bird_id) * 1.2;
  }
  return [x, Math.max(2.5, y), z];
}

export function create_flock(seed = 42, count = 12): Bird[] {
  const rand = prng(seed);
  const flock: Bird[] = [];
  for (let i = 0; i < count; i++) {
    const id = i + 1;
    const sp = SPECIES[i % SPECIES.length];
    /* Place first 4 birds right in front of the spawn view (-Z sector) so immediate sightlines are lively */
    const angle = i < 4
      ? -Math.PI * 0.5 + (i - 1.5) * 0.34
      : rand() * Math.PI * 2;
    const dist = i < 4 ? 22 + i * 5 : 20 + rand() * 32;
    const cx = Math.cos(angle) * dist * 0.45;
    const cz = Math.sin(angle) * dist - (i < 4 ? 12 : 0);
    const orbit_r = 11 + rand() * 17;
    const orbit_dir = i % 2 === 0 ? 1 : -1;
    const th = rand() * Math.PI * 2;
    const alt = sp.alt_min + rand() * (sp.alt_max - sp.alt_min);
    const anchor: Vec3 = [cx, alt, cz];
    const pos = eval_orbit_pos(anchor, orbit_r, id, sp, th, 0);
    const vx = -Math.sin(th) * orbit_dir * sp.speed;
    const vz = Math.cos(th) * orbit_dir * sp.speed;
    const yaw = Math.atan2(vx, vz);

    flock.push({
      id,
      code: sp.code,
      pos,
      vel: [vx, 0, vz],
      yaw,
      bank: -orbit_dir * 0.24,
      phase: rand() * Math.PI * 2,
      anchor,
      orbit_r,
      orbit_dir,
    });
  }
  return flock;
}

export function spawn_bird_near_view(
  flock: Bird[],
  code: string,
  eye: Vec3,
  look_dir: Vec3,
  next_id: number,
  time_s = 0
): Bird[] {
  const sp = find_species(code);
  const flat = v3_norm([look_dir[0], 0, look_dir[2]]);
  const dist = 26;
  const alt = Math.max(sp.alt_min, Math.min(sp.alt_max, eye[1] + 10));
  const anchor: Vec3 = [eye[0] + flat[0] * dist, alt, eye[2] + flat[2] * dist];
  const orbit_r = 12;
  const pos = eval_orbit_pos(anchor, orbit_r, next_id, sp, 0, time_s);
  const vel: Vec3 = [0, 0, sp.speed];
  const b: Bird = {
    id: next_id,
    code: sp.code,
    pos,
    vel,
    yaw: Math.atan2(vel[0], vel[2]),
    bank: -0.22,
    phase: 0,
    anchor,
    orbit_r,
    orbit_dir: 1,
  };
  return [...flock, b];
}

export function step_bird(b: Bird, dt: number, time_s: number): Bird {
  const sp = find_species(b.code);
  const clamped_dt = Math.min(Math.max(dt, 0.001), 0.1);
  const dx = b.pos[0] - b.anchor[0];
  const dz = b.pos[2] - b.anchor[2];
  const cur_th = Math.atan2(dz, dx);
  const omega = (sp.speed / Math.max(b.orbit_r, 6)) * b.orbit_dir;
  const next_th = cur_th + omega * clamped_dt;

  const target = eval_orbit_pos(b.anchor, b.orbit_r, b.id, sp, next_th, time_s);

  let vx = (target[0] - b.pos[0]) / clamped_dt;
  let vy = (target[1] - b.pos[1]) / clamped_dt;
  let vz = (target[2] - b.pos[2]) / clamped_dt;
  const raw_spd = Math.hypot(vx, vy, vz);
  const max_spd = sp.speed * 1.65;
  if (raw_spd > max_spd && raw_spd > 1e-5) {
    const sc = max_spd / raw_spd;
    vx *= sc;
    vy *= sc;
    vz *= sc;
  }
  const yaw = Math.atan2(vx, vz);
  const bank = Math.max(-0.65, Math.min(0.65, -omega * 1.15));

  /* Intermittent glide duty cycle for soaring/bounding birds */
  let flap_scale = 1.0;
  if (sp.pattern === 'soar' && Math.sin(time_s * 0.9 + b.id) > -0.3) {
    flap_scale = 0.12;
  } else if (sp.pattern === 'glide' && Math.sin(time_s * 1.2 + b.id) > 0.0) {
    flap_scale = 0.18;
  }
  const phase = (b.phase + clamped_dt * sp.flap_hz * Math.PI * 2 * flap_scale) % (Math.PI * 2);

  return {
    ...b,
    pos: target,
    vel: [vx, vy, vz],
    yaw,
    bank,
    phase,
  };
}

export function step_flock(flock: Bird[], dt: number, time_s: number): Bird[] {
  const next = new Array<Bird>(flock.length);
  for (let i = 0; i < flock.length; i++) {
    next[i] = step_bird(flock[i], dt, time_s);
  }
  return next;
}

/* Alpha-Beta kinematic tracker for smoothing AR optical/ray tracks */
export function init_track(b: Bird): TrackState {
  return {
    bird_id: b.id,
    est_pos: [...b.pos] as Vec3,
    est_vel: [...b.vel] as Vec3,
    age_s: 0,
    locked: true,
  };
}

export function step_track(prev: TrackState | null, b: Bird | undefined, dt: number): TrackState | null {
  if (!b) {
    return null;
  }
  if (!prev || prev.bird_id !== b.id) {
    return init_track(b);
  }
  const alpha = 0.45;
  const beta = 0.14;
  const cdt = Math.min(Math.max(dt, 0.001), 0.1);

  const pred_pos = v3_add(prev.est_pos, v3_scale(prev.est_vel, cdt));
  const resid = v3_sub(b.pos, pred_pos);
  const est_pos = v3_add(pred_pos, v3_scale(resid, alpha));
  const est_vel = v3_add(prev.est_vel, v3_scale(resid, beta / cdt));

  return {
    bird_id: b.id,
    est_pos,
    est_vel,
    age_s: prev.age_s + cdt,
    locked: prev.age_s + cdt >= 0.15,
  };
}

export function predict_track_path(tr: TrackState, steps = 8, step_dt = 0.25): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i * step_dt;
    pts.push([
      tr.est_pos[0] + tr.est_vel[0] * t,
      Math.max(1.5, tr.est_pos[1] + tr.est_vel[1] * t),
      tr.est_pos[2] + tr.est_vel[2] * t,
    ]);
  }
  return pts;
}

/* Ray-cone + sphere intersection for Quest 3 controller/pinch ray & screen click picking */
export function pick_bird_by_ray(
  flock: Bird[],
  ray_origin: Vec3,
  ray_dir: Vec3,
  cone_deg = 5.5,
  filter_code = 'all'
): Bird | null {
  const dir = v3_norm(ray_dir);
  const cos_lim = Math.cos((cone_deg * Math.PI) / 180);
  let best: Bird | null = null;
  let best_score = -1;

  for (let i = 0; i < flock.length; i++) {
    const b = flock[i];
    if (filter_code !== 'all' && b.code !== filter_code) {
      continue;
    }
    const to_b = v3_sub(b.pos, ray_origin);
    const dist = v3_len(to_b);
    if (dist < 0.5 || dist > 160) {
      continue;
    }
    const u = v3_scale(to_b, 1 / dist);
    const cos_ang = v3_dot(dir, u);
    const hit_radius = 1.6;
    const sphere_cos = Math.cos(Math.atan2(hit_radius, dist));
    const threshold = Math.min(cos_lim, sphere_cos);

    if (cos_ang >= threshold && cos_ang > best_score) {
      best_score = cos_ang;
      best = b;
    }
  }
  return best;
}

export function camera_forward(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return [
    Math.sin(yaw) * cp,
    Math.sin(pitch),
    -Math.cos(yaw) * cp,
  ];
}

export function screen_ndc_to_ray(
  ndc_x: number,
  ndc_y: number,
  yaw: number,
  pitch: number,
  fov_rad: number,
  aspect: number
): Vec3 {
  const fwd = camera_forward(yaw, pitch);
  const right = v3_norm(v3_cross(fwd, [0, 1, 0]));
  const up = v3_norm(v3_cross(right, fwd));
  const tan_half = Math.tan(fov_rad * 0.5);
  const rx = ndc_x * aspect * tan_half;
  const ry = ndc_y * tan_half;
  return v3_norm(v3_add(fwd, v3_add(v3_scale(right, rx), v3_scale(up, ry))));
}

export function project_to_ndc(world: Vec3, vp: Mat4): [number, number, number] | null {
  const x = world[0];
  const y = world[1];
  const z = world[2];
  const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
  const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
  const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
  const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
  if (cw <= 0.05) {
    return null;
  }
  return [cx / cw, cy / cw, cz / cw];
}

export function sightings_to_csv(rows: Sighting[]): string {
  const header = 'id,time,species_code,common_name,scientific_name,azimuth_deg,elevation_deg,range_m,speed_ms,altitude_m,source,note';
  const lines = [header];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const safe_note = `"${r.note.replace(/"/g, '""')}"`;
    lines.push([
      r.id,
      r.time,
      r.code,
      `"${r.common}"`,
      `"${r.sci}"`,
      r.az_deg.toFixed(1),
      r.el_deg.toFixed(1),
      r.range_m.toFixed(1),
      r.speed_ms.toFixed(1),
      r.alt_m.toFixed(1),
      r.source,
      safe_note,
    ].join(','));
  }
  return lines.join('\n');
}
