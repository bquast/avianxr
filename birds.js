/* birds.js - Pure functional 3D math, bird kinematics, and alpha-beta tracking */

export const SPECIES = [
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
        body: [0.76, 0.41, 0.24],
        wing: [0.34, 0.43, 0.52],
        accent: [0.92, 0.86, 0.76]
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
        body: [0.42, 0.29, 0.20],
        wing: [0.52, 0.37, 0.25],
        accent: [0.78, 0.34, 0.18]
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
        body: [0.28, 0.33, 0.40],
        wing: [0.22, 0.27, 0.34],
        accent: [0.88, 0.85, 0.78]
    },
    {
        code: 'grbher',
        common: 'Great Blue Heron',
        sci: 'Ardea herodias',
        span: 1.75,
        speed: 8.4,
        flap_hz: 1.6,
        alt_min: 7,
        alt_max: 18,
        pattern: 'glide',
        body: [0.44, 0.52, 0.60],
        wing: [0.33, 0.41, 0.50],
        accent: [0.84, 0.80, 0.68]
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
        body: [0.16, 0.27, 0.48],
        wing: [0.13, 0.22, 0.40],
        accent: [0.82, 0.44, 0.22]
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
        body: [0.90, 0.76, 0.14],
        wing: [0.15, 0.16, 0.18],
        accent: [0.95, 0.94, 0.88]
    }
];

export function find_species(code)
{
    for (let i = 0; i < SPECIES.length; i++) {
        if (SPECIES[i].code === code)
            return SPECIES[i];
    }
    return SPECIES[0];
}

export function prng(seed)
{
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function vadd(a, b)
{
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vsub(a, b)
{
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vscale(a, s)
{
    return [a[0] * s, a[1] * s, a[2] * s];
}

export function vdot(a, b)
{
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vcross(a, b)
{
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0]
    ];
}

export function vlen(a)
{
    return Math.hypot(a[0], a[1], a[2]);
}

export function vnorm(a)
{
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < 1e-8)
        return [0, 0, -1];
    return [a[0] / l, a[1] / l, a[2] / l];
}

export function m4_ident()
{
    const m = new Float32Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m;
}

export function m4_mul(a, b)
{
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

export function m4_persp(fov_rad, aspect, near, far)
{
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

export function m4_look(eye, target, up)
{
    const z = vnorm(vsub(eye, target));
    const x = vnorm(vcross(up, z));
    const y = vcross(z, x);
    const out = new Float32Array(16);
    out[0] = x[0];  out[1] = y[0];  out[2] = z[0];
    out[4] = x[1];  out[5] = y[1];  out[6] = z[1];
    out[8] = x[2];  out[9] = y[2];  out[10] = z[2];
    out[12] = -vdot(x, eye);
    out[13] = -vdot(y, eye);
    out[14] = -vdot(z, eye);
    out[15] = 1;
    return out;
}

export function m4_trs(pos, yaw, pitch, roll, sc)
{
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const out = new Float32Array(16);

    out[0] = (cy * cr + sy * sp * sr) * sc;
    out[1] = (cp * sr) * sc;
    out[2] = (-sy * cr + cy * sp * sr) * sc;

    out[4] = (-cy * sr + sy * sp * cr) * sc;
    out[5] = (cp * cr) * sc;
    out[6] = (sy * sr + cy * sp * cr) * sc;

    out[8] = (sy * cp) * sc;
    out[9] = (-sp) * sc;
    out[10] = (cy * cp) * sc;

    out[12] = pos[0];
    out[13] = pos[1];
    out[14] = pos[2];
    out[15] = 1;
    return out;
}

export function m4_inv_rigid(m)
{
    const out = new Float32Array(16);
    out[0] = m[0]; out[1] = m[4]; out[2] = m[8];
    out[4] = m[1]; out[5] = m[5]; out[6] = m[9];
    out[8] = m[2]; out[9] = m[6]; out[10] = m[10];
    const tx = m[12], ty = m[13], tz = m[14];
    out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
    out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
    out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
    out[15] = 1;
    return out;
}

/* World convention: -Z is North (0 deg), +X is East (90 deg), +Y is Up */
export function world_to_polar(eye, target)
{
    const d = vsub(target, eye);
    const range_m = vlen(d);
    if (range_m < 1e-6)
        return { az_deg: 0, el_deg: 0, range_m: 0 };

    const horiz = Math.hypot(d[0], d[2]);
    let az = (Math.atan2(d[0], -d[2]) * 180) / Math.PI;
    if (az < 0)
        az += 360;
    const el = (Math.atan2(d[1], horiz) * 180) / Math.PI;
    return { az_deg: az, el_deg: el, range_m };
}

export function cardinal(az_deg)
{
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round((((az_deg % 360) + 360) % 360) / 45) % 8;
    return dirs[idx];
}

export function orbit_pos(anchor, orbit_r, id, sp, th, t)
{
    let r = orbit_r;
    if (sp.pattern === 'dart')
        r += Math.sin(t * 1.4 + id) * 2.5;
    else if (sp.pattern === 'stoop')
        r += Math.cos(t * 0.9 + id * 1.7) * 4.0;

    const x = anchor[0] + Math.cos(th) * r;
    const z = anchor[2] + Math.sin(th) * r;

    let y = anchor[1];
    if (sp.pattern === 'soar')
        y += Math.sin(t * 0.45 + id) * 3.2;
    else if (sp.pattern === 'bound')
        y += Math.abs(Math.sin(t * 2.6 + id)) * 1.6 - 0.6;
    else if (sp.pattern === 'stoop')
        y += Math.sin(t * 0.85 + id * 2.1) * 5.5;
    else
        y += Math.sin(t * 1.1 + id) * 1.2;

    return [x, Math.max(2.5, y), z];
}

export function create_flock(seed = 42, count = 12)
{
    const rand = prng(seed);
    const flock = [];
    for (let i = 0; i < count; i++) {
        const id = i + 1;
        const sp = SPECIES[i % SPECIES.length];
        const ang = i < 4 ? -Math.PI * 0.5 + (i - 1.5) * 0.34 : rand() * Math.PI * 2;
        const dist = i < 4 ? 22 + i * 5 : 20 + rand() * 32;
        const cx = Math.cos(ang) * dist * 0.45;
        const cz = Math.sin(ang) * dist - (i < 4 ? 12 : 0);
        const orbit_r = 11 + rand() * 17;
        const orbit_dir = i % 2 === 0 ? 1 : -1;
        const th = rand() * Math.PI * 2;
        const alt = sp.alt_min + rand() * (sp.alt_max - sp.alt_min);
        const anchor = [cx, alt, cz];
        const pos = orbit_pos(anchor, orbit_r, id, sp, th, 0);
        const vx = -Math.sin(th) * orbit_dir * sp.speed;
        const vz = Math.cos(th) * orbit_dir * sp.speed;

        flock.push({
            id,
            code: sp.code,
            pos,
            vel: [vx, 0, vz],
            yaw: Math.atan2(vx, vz),
            bank: -orbit_dir * 0.24,
            phase: rand() * Math.PI * 2,
            anchor,
            orbit_r,
            orbit_dir
        });
    }
    return flock;
}

export function step_bird(b, dt, t)
{
    const sp = find_species(b.code);
    const cdt = Math.min(Math.max(dt, 0.001), 0.1);
    const cur_th = Math.atan2(b.pos[2] - b.anchor[2], b.pos[0] - b.anchor[0]);
    const omega = (sp.speed / Math.max(b.orbit_r, 6)) * b.orbit_dir;
    const next_th = cur_th + omega * cdt;
    const target = orbit_pos(b.anchor, b.orbit_r, b.id, sp, next_th, t);

    let vx = (target[0] - b.pos[0]) / cdt;
    let vy = (target[1] - b.pos[1]) / cdt;
    let vz = (target[2] - b.pos[2]) / cdt;
    const spd = Math.hypot(vx, vy, vz);
    const max_spd = sp.speed * 1.65;
    if (spd > max_spd && spd > 1e-5) {
        const sc = max_spd / spd;
        vx *= sc;
        vy *= sc;
        vz *= sc;
    }

    let flap_sc = 1.0;
    if (sp.pattern === 'soar' && Math.sin(t * 0.9 + b.id) > -0.3)
        flap_sc = 0.12;
    else if (sp.pattern === 'glide' && Math.sin(t * 1.2 + b.id) > 0.0)
        flap_sc = 0.18;

    return {
        ...b,
        pos: target,
        vel: [vx, vy, vz],
        yaw: Math.atan2(vx, vz),
        bank: Math.max(-0.65, Math.min(0.65, -omega * 1.15)),
        phase: (b.phase + cdt * sp.flap_hz * Math.PI * 2 * flap_sc) % (Math.PI * 2)
    };
}

export function step_flock(flock, dt, t)
{
    const out = new Array(flock.length);
    for (let i = 0; i < flock.length; i++)
        out[i] = step_bird(flock[i], dt, t);
    return out;
}

/* Alpha-beta filter for both continuous bird tracks and discrete real-sky AR ray fixes */
export function init_track(id, code, pos, vel = [0, 0, 0])
{
    return {
        id,
        code,
        pos: [pos[0], pos[1], pos[2]],
        vel: [vel[0], vel[1], vel[2]],
        age: 0,
        locked: false
    };
}

export function step_track(tr, obs_pos, dt, alpha = 0.45, beta = 0.14)
{
    const cdt = Math.min(Math.max(dt, 0.005), 5.0);
    const pred = vadd(tr.pos, vscale(tr.vel, cdt));
    const resid = vsub(obs_pos, pred);
    const pos = vadd(pred, vscale(resid, alpha));
    const vel = vadd(tr.vel, vscale(resid, beta / cdt));
    const age = tr.age + cdt;
    return {
        ...tr,
        pos,
        vel,
        age,
        locked: age >= 0.15
    };
}

export function predict_path(tr, steps = 8, step_dt = 0.25)
{
    const pts = [];
    for (let i = 0; i <= steps; i++) {
        const t = i * step_dt;
        pts.push([
            tr.pos[0] + tr.vel[0] * t,
            Math.max(1.2, tr.pos[1] + tr.vel[1] * t),
            tr.pos[2] + tr.vel[2] * t
        ]);
    }
    return pts;
}

export function cam_fwd(yaw, pitch)
{
    const cp = Math.cos(pitch);
    return [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

export function ndc_to_ray(nx, ny, yaw, pitch, fov_rad, aspect)
{
    const fwd = cam_fwd(yaw, pitch);
    const right = vnorm(vcross(fwd, [0, 1, 0]));
    const up = vnorm(vcross(right, fwd));
    const th = Math.tan(fov_rad * 0.5);
    return vnorm(vadd(fwd, vadd(vscale(right, nx * aspect * th), vscale(up, ny * th))));
}

export function project_ndc(world, vp)
{
    const x = world[0], y = world[1], z = world[2];
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.05)
        return null;
    return [cx / cw, cy / cw, cz / cw];
}

export function pick_bird(flock, origin, dir, cone_deg = 6.0, filter = 'all')
{
    const udir = vnorm(dir);
    const cos_lim = Math.cos((cone_deg * Math.PI) / 180);
    let best = null;
    let best_cos = -1;

    for (let i = 0; i < flock.length; i++) {
        const b = flock[i];
        if (filter !== 'all' && b.code !== filter)
            continue;
        const d = vsub(b.pos, origin);
        const dist = vlen(d);
        if (dist < 0.5 || dist > 160)
            continue;
        const cos_a = vdot(udir, vscale(d, 1 / dist));
        const sphere_cos = Math.cos(Math.atan2(1.6, dist));
        const lim = Math.min(cos_lim, sphere_cos);
        if (cos_a >= lim && cos_a > best_cos) {
            best_cos = cos_a;
            best = b;
        }
    }
    return best;
}

export function to_csv(rows)
{
    const lines = [
        'id,time,species_code,common_name,scientific_name,azimuth_deg,elevation_deg,range_m,speed_ms,altitude_m,source,note'
    ];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const note = '"' + String(r.note || '').replace(/"/g, '""') + '"';
        lines.push([
            r.id,
            r.time,
            r.code,
            '"' + r.common + '"',
            '"' + r.sci + '"',
            r.az_deg.toFixed(1),
            r.el_deg.toFixed(1),
            r.range_m.toFixed(1),
            r.speed_ms.toFixed(1),
            r.alt_m.toFixed(1),
            r.source,
            note
        ].join(','));
    }
    return lines.join('\n');
}
