/* app.js - Linear WebGL2 + Meta Quest 3 WebXR immersive-ar bird tracker */

import {
    SPECIES,
    find_species,
    prng,
    vadd,
    vscale,
    vlen,
    vnorm,
    m4_ident,
    m4_mul,
    m4_persp,
    m4_look,
    m4_trs,
    m4_inv_rigid,
    world_to_polar,
    cardinal,
    orbit_pos,
    create_flock,
    step_flock,
    init_track,
    step_track,
    predict_path,
    cam_fwd,
    ndc_to_ray,
    project_ndc,
    pick_bird,
    to_csv
} from './birds.js';

const REGIONS = [
    { label: 'San Francisco Bay, CA', lat: 37.8044, lng: -122.2712 },
    { label: 'Cape May Marsh, NJ', lat: 38.9351, lng: -74.9606 },
    { label: 'Texel Wadden Coast, NL', lat: 53.0546, lng: 4.7977 },
    { label: 'Bosque del Apache, NM', lat: 33.8042, lng: -106.8914 }
];

const SEED_NEARBY = [
    { code: 'amekes', common: 'American Kestrel', sci: 'Falco sparverius', count: 2, loc: 'Coastal Meadow Ridge', time: '08:05' },
    { code: 'rethaw', common: 'Red-tailed Hawk', sci: 'Buteo jamaicensis', count: 1, loc: 'North Thermal Bluff', time: '07:52' },
    { code: 'perfal', common: 'Peregrine Falcon', sci: 'Falco peregrinus', count: 1, loc: 'Estuary Pylon', time: '07:41' },
    { code: 'grbher', common: 'Great Blue Heron', sci: 'Ardea herodias', count: 3, loc: 'Tidal Marsh Flats', time: '07:30' }
];

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
out vec4 out_col;
void main() {
    vec3 N = normalize(v_norm);
    vec3 L = normalize(vec3(0.52, 0.80, 0.28));
    float ndl = max(dot(N, L), 0.0);
    vec3 hemi = mix(vec3(0.24, 0.28, 0.20), vec3(0.54, 0.68, 0.84), N.y * 0.5 + 0.5);
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
    out_col = vec4(lit, 1.0);
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

function compile_prog(gl, vs_src, fs_src)
{
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vs_src);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fs_src);
    gl.compileShader(fs);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return p;
}

function push_tri(out, a, b, c, col)
{
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = vnorm([
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0]
    ]);
    for (const p of [a, b, c])
        out.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2]);
}

function push_box(out, cx, cy, cz, sx, sy, sz, col)
{
    const x0 = cx - sx * 0.5, x1 = cx + sx * 0.5;
    const y0 = cy - sy * 0.5, y1 = cy + sy * 0.5;
    const z0 = cz - sz * 0.5, z1 = cz + sz * 0.5;
    const p000 = [x0, y0, z0], p100 = [x1, y0, z0], p110 = [x1, y1, z0], p010 = [x0, y1, z0];
    const p001 = [x0, y0, z1], p101 = [x1, y0, z1], p111 = [x1, y1, z1], p011 = [x0, y1, z1];
    push_tri(out, p001, p101, p111, col); push_tri(out, p001, p111, p011, col);
    push_tri(out, p100, p000, p010, col); push_tri(out, p100, p010, p110, col);
    push_tri(out, p101, p100, p110, col); push_tri(out, p101, p110, p111, col);
    push_tri(out, p000, p001, p011, col); push_tri(out, p000, p011, p010, col);
    push_tri(out, p011, p111, p110, col); push_tri(out, p011, p110, p010, col);
    push_tri(out, p000, p100, p101, col); push_tri(out, p000, p101, p001, col);
}

function push_cone(out, cx, y0, cz, r, h, segs, col)
{
    const apex = [cx, y0 + h, cz];
    const base = [cx, y0, cz];
    for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const p0 = [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r];
        const p1 = [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r];
        push_tri(out, p1, p0, apex, col);
        push_tri(out, base, p0, p1, col);
    }
}

function push_disc(out, cx, y, cz, r, segs, col_in, col_out)
{
    for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const p0 = [cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r];
        const p1 = [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r];
        out.push(cx, y, cz, 0, 1, 0, col_in[0], col_in[1], col_in[2]);
        out.push(p1[0], p1[1], p1[2], 0, 1, 0, col_out[0], col_out[1], col_out[2]);
        out.push(p0[0], p0[1], p0[2], 0, 1, 0, col_out[0], col_out[1], col_out[2]);
    }
}

function build_meadow()
{
    const v = [];
    push_disc(v, 0, 0.0, 0, 110, 40, [0.22, 0.32, 0.17], [0.28, 0.36, 0.24]);
    push_disc(v, 15, 0.022, -34, 11.2, 24, [0.46, 0.43, 0.33], [0.36, 0.38, 0.26]);
    push_disc(v, 15, 0.045, -34, 9.6, 24, [0.16, 0.32, 0.44], [0.22, 0.40, 0.50]);

    /* Birding observation tower in forward-left vista */
    const tx = -11.5, tz = -35.0;
    const wd = [0.36, 0.25, 0.16], wm = [0.48, 0.35, 0.22], rf = [0.26, 0.31, 0.28];
    for (const dx of [-1.4, 1.4]) {
        for (const dz of [-1.4, 1.4]) {
            push_box(v, tx + dx, 2.3, tz + dz, 0.22, 4.6, 0.22, wd);
            push_box(v, tx + dx, 5.75, tz + dz, 0.16, 2.2, 0.16, wd);
        }
    }
    push_box(v, tx, 4.6, tz, 3.4, 0.22, 3.4, wm);
    push_box(v, tx, 5.55, tz - 1.55, 3.3, 0.12, 0.12, wm);
    push_box(v, tx, 5.55, tz + 1.55, 3.3, 0.12, 0.12, wm);
    push_box(v, tx - 1.55, 5.55, tz, 0.12, 0.12, 3.3, wm);
    push_box(v, tx + 1.55, 5.55, tz, 0.12, 0.12, 3.3, wm);
    push_cone(v, tx, 6.8, tz, 2.65, 1.45, 4, rf);

    for (let i = -4; i <= 4; i++) {
        if (i === 0)
            continue;
        const fx = i * 4.2, fz = -15.5 + Math.abs(i) * 0.4;
        push_box(v, fx, 0.55, fz, 0.14, 1.1, 0.14, wd);
        if (i < 4 && i !== -1) {
            push_box(v, fx + 2.1, 0.82, fz, 4.2, 0.08, 0.07, wm);
            push_box(v, fx + 2.1, 0.46, fz, 4.2, 0.08, 0.07, wm);
        }
    }

    const rand = prng(108);
    for (let i = 0; i < 32; i++) {
        const ang = (i / 32) * Math.PI * 2 + (rand() - 0.5) * 0.14;
        const dist = 48 + rand() * 32;
        const px = Math.cos(ang) * dist, pz = Math.sin(ang) * dist;
        const sc = 0.85 + rand() * 0.55;
        const t = (rand() - 0.5) * 0.06;
        push_box(v, px, 1.4 * sc, pz, 0.45 * sc, 2.8 * sc, 0.45 * sc, [0.32, 0.22, 0.15]);
        push_cone(v, px, 2.1 * sc, pz, 2.4 * sc, 3.2 * sc, 7, [0.16 + t, 0.29 + t, 0.16]);
        push_cone(v, px, 3.9 * sc, pz, 1.9 * sc, 2.8 * sc, 7, [0.20 + t, 0.34 + t, 0.18]);
        push_cone(v, px, 5.5 * sc, pz, 1.3 * sc, 2.2 * sc, 7, [0.16 + t, 0.29 + t, 0.16]);
    }
    return new Float32Array(v);
}

function build_bird_body(body_c, accent_c, wing_c)
{
    const v = [];
    const rings = [
        { z: -0.28, cy: 0.02, rx: 0.05, ry: 0.04 },
        { z: -0.05, cy: 0.01, rx: 0.11, ry: 0.085 },
        { z: 0.16, cy: 0.02, rx: 0.105, ry: 0.08 },
        { z: 0.30, cy: 0.06, rx: 0.075, ry: 0.065 },
        { z: 0.43, cy: 0.075, rx: 0.04, ry: 0.04 }
    ];
    const segs = 8;
    for (let r = 0; r < rings.length - 1; r++) {
        const a = rings[r], b = rings[r + 1];
        for (let s = 0; s < segs; s++) {
            const th0 = (s / segs) * Math.PI * 2;
            const th1 = ((s + 1) / segs) * Math.PI * 2;
            const a0 = [Math.cos(th0) * a.rx, a.cy + Math.sin(th0) * a.ry, a.z];
            const a1 = [Math.cos(th1) * a.rx, a.cy + Math.sin(th1) * a.ry, a.z];
            const b0 = [Math.cos(th0) * b.rx, b.cy + Math.sin(th0) * b.ry, b.z];
            const b1 = [Math.cos(th1) * b.rx, b.cy + Math.sin(th1) * b.ry, b.z];
            const col = Math.sin((th0 + th1) * 0.5) < -0.15 ? accent_c : body_c;
            push_tri(v, a0, b0, b1, col);
            push_tri(v, a0, b1, a1, col);
        }
    }
    const tail_cap = [0, 0.02, -0.32], beak_tip = [0, 0.068, 0.58], beak_c = [0.88, 0.68, 0.18];
    const r0 = rings[0], rn = rings[rings.length - 1];
    for (let s = 0; s < segs; s++) {
        const th0 = (s / segs) * Math.PI * 2;
        const th1 = ((s + 1) / segs) * Math.PI * 2;
        push_tri(v,
            [Math.cos(th1) * r0.rx, r0.cy + Math.sin(th1) * r0.ry, r0.z],
            [Math.cos(th0) * r0.rx, r0.cy + Math.sin(th0) * r0.ry, r0.z],
            tail_cap, body_c);
        push_tri(v,
            [Math.cos(th0) * rn.rx, rn.cy + Math.sin(th0) * rn.ry, rn.z],
            beak_tip,
            [Math.cos(th1) * rn.rx, rn.cy + Math.sin(th1) * rn.ry, rn.z],
            beak_c);
    }
    push_tri(v, [0, 0.025, -0.26], [0.21, 0.045, -0.66], [-0.21, 0.045, -0.66], wing_c);
    push_tri(v, [0, 0.025, -0.26], [-0.21, 0.045, -0.66], [0, 0.01, -0.68], accent_c);
    push_tri(v, [0, 0.025, -0.26], [0, 0.01, -0.68], [0.21, 0.045, -0.66], accent_c);
    return new Float32Array(v);
}

function build_bird_wing(side, wing_c, accent_c)
{
    const v = [];
    push_box(v, side * 0.28, 0.0, 0.02, 0.48, 0.035, 0.26, wing_c);
    const w0 = [side * 0.50, 0.015, 0.13], w1 = [side * 0.50, 0.015, -0.11];
    const w0b = [side * 0.50, -0.015, 0.13], w1b = [side * 0.50, -0.015, -0.11];
    const tip = [side * 0.98, 0.02, -0.16];
    if (side > 0) {
        push_tri(v, w0, w1, tip, wing_c);
        push_tri(v, w1b, w0b, tip, accent_c);
    } else {
        push_tri(v, w1, w0, tip, wing_c);
        push_tri(v, w0b, w1b, tip, accent_c);
    }
    return new Float32Array(v);
}

function upload_mesh(gl, data)
{
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 36, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 36, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 36, 24);
    gl.bindVertexArray(null);
    return { vao, vbo, count: data.length / 9 };
}

function push_line(buf, a, b, r, g, bl, al)
{
    buf.push(a[0], a[1], a[2], r, g, bl, al, b[0], b[1], b[2], r, g, bl, al);
}

function hhmmss()
{
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function esc_html(s)
{
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/* Application State */
let flock = create_flock(42, 12);
let next_bird_id = 13;
let track = step_track(init_track(flock[0].id, flock[0].code, flock[0].pos, flock[0].vel), flock[0].pos, 0.2);
let real_sky_fix_ms = 0;

let sightings = [
    {
        id: 'S-init-1',
        code: 'amekes',
        common: 'American Kestrel',
        sci: 'Falco sparverius',
        az_deg: 348.2,
        el_deg: 21.4,
        range_m: 26.8,
        speed_ms: 9.5,
        alt_m: 12.4,
        pos: [-5.4, 12.4, -26.2],
        note: 'Wind-kiting above north fence line',
        time: '08:14:22',
        source: 'reticle'
    },
    {
        id: 'S-init-2',
        code: 'rethaw',
        common: 'Red-tailed Hawk',
        sci: 'Buteo jamaicensis',
        az_deg: 18.6,
        el_deg: 34.0,
        range_m: 41.2,
        speed_ms: 11.2,
        alt_m: 28.5,
        pos: [10.8, 28.5, -32.1],
        note: 'Rising on morning meadow thermal',
        time: '08:19:05',
        source: 'xr-ray'
    }
];

let cam_yaw = 0.0;
let cam_pitch = 0.24;
let zoom = 1;
let ar_sim = false;
let filter_code = 'all';
let active_panel = 'field';
let pin_open = false;
let last_eye = [0, 1.68, 0];
let last_vp = m4_ident();

let xr_supported = false;
let xr_session = null;
let xr_ref_space = null;
let xr_rays = [];

/* DOM Elements */
const $ = (id) => document.getElementById(id);
const canvas = $('xr-canvas');
const hud_root = $('hud');
const toast_el = $('toast');
const toast_text = $('toast-text');
let toast_timer = 0;

function show_toast(msg)
{
    toast_text.textContent = msg;
    toast_el.classList.remove('hidden');
    clearTimeout(toast_timer);
    toast_timer = setTimeout(() => toast_el.classList.add('hidden'), 4000);
}

/* Populate Species Selects */
const pin_select = $('pin-species');
const filter_select = $('species-filter');
for (const sp of SPECIES) {
    const o1 = document.createElement('option');
    o1.value = sp.code;
    o1.textContent = `${sp.common} (${sp.sci})`;
    pin_select.appendChild(o1);

    const o2 = document.createElement('option');
    o2.value = sp.code;
    o2.textContent = sp.common;
    filter_select.appendChild(o2);
}

function update_sighting_counts()
{
    const label = `Sightings (${sightings.length})`;
    $('nav-log-btn').textContent = label;
    $('mnav-log-btn').textContent = label;
    $('log-summary').textContent = `${sightings.length} spatial records · Quest 3 ray locks and optical bearings`;
    $('export-csv-btn').disabled = sightings.length === 0;
}

function render_log_panel()
{
    update_sighting_counts();
    const body = $('log-body');
    if (sightings.length === 0) {
        body.innerHTML = '<p style="text-align:center;color:var(--muted);padding:2rem 0;">No sightings recorded yet. Lock a bird or pinch in Quest 3 AR to log its 3D bearing.</p>';
        return;
    }
    let html = '<table class="data-table"><thead><tr>' +
        '<th>Time</th><th>Species</th><th>Bearing · Elev</th><th>Range · Alt</th><th>Note</th><th style="text-align:right;">Action</th>' +
        '</tr></thead><tbody>';
    for (const s of sightings) {
        const el_s = s.el_deg >= 0 ? `+${s.el_deg.toFixed(1)}` : s.el_deg.toFixed(1);
        html += `<tr>
            <td class="mono">${esc_html(s.time)}</td>
            <td><strong>${esc_html(s.common)}</strong><br><span style="font-size:0.74rem;color:var(--muted);font-style:italic;">${esc_html(s.sci)}</span></td>
            <td class="mono">${s.az_deg.toFixed(1)}° · ${el_s}°</td>
            <td class="mono">${s.range_m.toFixed(1)} m · ${s.alt_m.toFixed(1)} m</td>
            <td>${esc_html(s.note)}</td>
            <td style="text-align:right;"><button type="button" class="btn btn-ghost" data-del-id="${esc_html(s.id)}" aria-label="Delete sighting ${esc_html(s.common)} at ${esc_html(s.time)}">Remove</button></td>
        </tr>`;
    }
    html += '</tbody></table>';
    body.innerHTML = html;
}

async function load_nearby(idx)
{
    const reg = REGIONS[idx] || REGIONS[0];
    const body = $('nearby-body');
    body.innerHTML = '<p style="text-align:center;color:var(--muted);padding:1.5rem 0;">Loading regional observations...</p>';
    let items = SEED_NEARBY;
    let src = 'Offline Field Seed';

    try {
        const url = `https://api.inaturalist.org/v1/observations?iconic_taxa=Aves&lat=${reg.lat}&lng=${reg.lng}&radius=20&per_page=8&order=desc&order_by=created_at`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.results) && data.results.length > 0) {
                items = data.results.map((o) => {
                    const tx = o.taxon || {};
                    const common = String(tx.preferred_common_name || 'Wild Bird');
                    const sci = String(tx.name || 'Aves sp.');
                    const low = (common + ' ' + sci).toLowerCase();
                    let code = 'amegfi';
                    if (low.includes('kestrel')) code = 'amekes';
                    else if (low.includes('hawk') || low.includes('buteo')) code = 'rethaw';
                    else if (low.includes('falcon') || low.includes('peregrin')) code = 'perfal';
                    else if (low.includes('heron') || low.includes('egret')) code = 'grbher';
                    else if (low.includes('swallow')) code = 'barswa';
                    return {
                        code,
                        common,
                        sci,
                        count: 1,
                        loc: String(o.place_guess || reg.label),
                        time: String(o.time_observed_at || '').slice(11, 16) || 'Recent'
                    };
                });
                src = 'iNaturalist Live CORS';
            }
        }
    } catch {
        /* Keep offline deterministic seed */
    }

    $('nearby-sub').textContent = `Source: ${src} · Spawn observed species directly into sky`;
    let html = '';
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        html += `<div class="obs-row">
            <div>
                <div style="font-weight:600;">${esc_html(it.common)}</div>
                <div style="font-size:0.75rem;color:var(--muted);">
                    <i>${esc_html(it.sci)}</i> · ${esc_html(it.loc)} · <span class="mono">Count ${it.count}</span> · <span class="mono">${esc_html(it.time)}</span>
                </div>
            </div>
            <button type="button" class="btn btn-primary" data-spawn-code="${esc_html(it.code)}" data-spawn-name="${esc_html(it.common)}">Track in Sky</button>
        </div>`;
    }
    body.innerHTML = html;
}

function set_panel(next)
{
    active_panel = next;
    if (next !== 'field')
        pin_open = false;

    document.body.dataset.state = xr_session ? 'immersive-ar' : next;
    $('panel-log').classList.toggle('hidden', next !== 'log');
    $('panel-nearby').classList.toggle('hidden', next !== 'nearby');
    $('panel-guide').classList.toggle('hidden', next !== 'guide');
    $('pin-form').classList.toggle('hidden', !(next === 'field' && pin_open));
    $('reticle').classList.toggle('hidden', !(next === 'field' && !pin_open));

    for (const btn of document.querySelectorAll('[data-panel]')) {
        if (btn.getAttribute('data-panel') === next)
            btn.setAttribute('aria-current', 'page');
        else
            btn.removeAttribute('aria-current');
    }
    if (next === 'log')
        render_log_panel();
}

/* WebGL2 Setup */
const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    xrCompatible: true,
    powerPreference: 'high-performance'
});

let is_software_gl = false;
let prog_mesh = null;
let prog_line = null;
let meadow_buf = null;
let shadow_buf = null;
let line_vao = null;
let line_vbo = null;
const bird_meshes = new Map();

function init_gl_resources()
{
    if (!gl)
        return;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
        const r = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
        is_software_gl = /SwiftShader|Software|llvmpipe/i.test(r);
    }

    prog_mesh = compile_prog(gl, VS_MESH, FS_MESH);
    prog_line = compile_prog(gl, VS_LINE, FS_LINE);
    meadow_buf = upload_mesh(gl, build_meadow());

    const sh = [];
    push_disc(sh, 0, 0.035, 0, 0.85, 12, [0.06, 0.09, 0.05], [0.18, 0.26, 0.14]);
    shadow_buf = upload_mesh(gl, new Float32Array(sh));

    bird_meshes.clear();
    for (const sp of SPECIES) {
        bird_meshes.set(sp.code, {
            body: upload_mesh(gl, build_bird_body(sp.body, sp.accent, sp.wing)),
            wl: upload_mesh(gl, build_bird_wing(-1, sp.wing, sp.accent)),
            wr: upload_mesh(gl, build_bird_wing(1, sp.wing, sp.accent))
        });
    }

    line_vao = gl.createVertexArray();
    line_vbo = gl.createBuffer();
    gl.bindVertexArray(line_vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, line_vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
    gl.bindVertexArray(null);
}

init_gl_resources();
canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
canvas.addEventListener('webglcontextrestored', init_gl_resources);

/* Probe Quest 3 WebXR immersive-ar support */
if (navigator.xr && typeof navigator.xr.isSessionSupported === 'function') {
    navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
        xr_supported = Boolean(ok);
        $('xr-cap-status').textContent = xr_supported
            ? 'WebXR status: immersive-ar ready on this headset'
            : 'WebXR status: 2D Field & AR Sky mode (open in Meta Quest Browser over HTTPS for stereo passthrough)';
    }).catch(() => {
        $('xr-cap-status').textContent = 'WebXR status: 2D Field & AR Sky mode';
    });
} else {
    $('xr-cap-status').textContent = 'WebXR status: 2D Field & AR Sky mode (open in Meta Quest Browser over HTTPS for stereo passthrough)';
}

function render_scene(view_mat, proj_mat, eye_pos, ar_transparent, sim_t)
{
    if (!gl || !prog_mesh)
        return;
    const vp = m4_mul(proj_mat, view_mat);
    last_vp = vp;
    last_eye = eye_pos;

    gl.useProgram(prog_mesh);
    const u_mvp = gl.getUniformLocation(prog_mesh, 'u_mvp');
    const u_model = gl.getUniformLocation(prog_mesh, 'u_model');
    gl.uniform3fv(gl.getUniformLocation(prog_mesh, 'u_eye'), eye_pos);
    gl.uniform3fv(gl.getUniformLocation(prog_mesh, 'u_fog_col'), [0.64, 0.76, 0.88]);
    gl.uniform1f(gl.getUniformLocation(prog_mesh, 'u_fog_on'), ar_transparent ? 0.0 : 1.0);

    if (!ar_transparent) {
        gl.uniformMatrix4fv(u_model, false, m4_ident());
        gl.uniformMatrix4fv(u_mvp, false, vp);
        gl.bindVertexArray(meadow_buf.vao);
        gl.drawArrays(gl.TRIANGLES, 0, meadow_buf.count);
    }

    for (let i = 0; i < flock.length; i++) {
        const b = flock[i];
        if (filter_code !== 'all' && b.code !== filter_code)
            continue;
        const sp = find_species(b.code);
        const m = bird_meshes.get(b.code);
        if (!m)
            continue;

        const sc = Math.max(0.85, sp.span * 1.35);
        const pitch = -Math.asin(Math.max(-0.7, Math.min(0.7, b.vel[1] / Math.max(vlen(b.vel), 1))));
        const bm = m4_trs(b.pos, b.yaw, pitch, b.bank, sc);

        gl.uniformMatrix4fv(u_model, false, bm);
        gl.uniformMatrix4fv(u_mvp, false, m4_mul(vp, bm));
        gl.bindVertexArray(m.body.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.body.count);

        const flap = Math.sin(b.phase) * 0.68;
        const wl_m = m4_mul(bm, m4_trs([-0.06, 0.03, 0], 0, 0, -flap, 1.0));
        const wr_m = m4_mul(bm, m4_trs([0.06, 0.03, 0], 0, 0, flap, 1.0));

        gl.uniformMatrix4fv(u_model, false, wl_m);
        gl.uniformMatrix4fv(u_mvp, false, m4_mul(vp, wl_m));
        gl.bindVertexArray(m.wl.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.wl.count);

        gl.uniformMatrix4fv(u_model, false, wr_m);
        gl.uniformMatrix4fv(u_mvp, false, m4_mul(vp, wr_m));
        gl.bindVertexArray(m.wr.vao);
        gl.drawArrays(gl.TRIANGLES, 0, m.wr.count);

        if (!ar_transparent) {
            const sm = m4_trs([b.pos[0], 0, b.pos[2]], 0, 0, 0, sc * 0.9);
            gl.uniformMatrix4fv(u_model, false, sm);
            gl.uniformMatrix4fv(u_mvp, false, m4_mul(vp, sm));
            gl.bindVertexArray(shadow_buf.vao);
            gl.drawArrays(gl.TRIANGLES, 0, shadow_buf.count);
        }
    }

    /* Spatial 3D AR Overlays: 360 compass ring, target brackets, lead trajectory, pins, XR rays */
    const lines = [];
    const ring_r = 14.0;
    const ring_y = ar_transparent ? Math.max(0.15, eye_pos[1] - 1.15) : 0.14;
    for (let deg = 0; deg < 360; deg += 15) {
        const r1 = (deg * Math.PI) / 180;
        const r2 = ((deg + 15) * Math.PI) / 180;
        const x1 = eye_pos[0] + Math.sin(r1) * ring_r, z1 = eye_pos[2] - Math.cos(r1) * ring_r;
        const x2 = eye_pos[0] + Math.sin(r2) * ring_r, z2 = eye_pos[2] - Math.cos(r2) * ring_r;
        const card = deg % 90 === 0;
        const north = deg === 0;
        push_line(lines, [x1, ring_y, z1], [x1, ring_y + (card ? 0.52 : 0.22), z1],
            north ? 0.98 : 0.85, north ? 0.68 : 0.90, north ? 0.16 : 0.96, card ? 0.85 : 0.36);
        push_line(lines, [x1, ring_y, z1], [x2, ring_y, z2], 0.75, 0.84, 0.94, 0.22);
    }

    if (ar_transparent && !xr_session) {
        for (let g = -40; g <= 40; g += 8) {
            push_line(lines, [g, 0.02, -40], [g, 0.02, 40], 0.25, 0.38, 0.48, 0.22);
            push_line(lines, [-40, 0.02, g], [40, 0.02, g], 0.25, 0.38, 0.48, 0.22);
        }
    }

    for (let i = 0; i < flock.length; i++) {
        const b = flock[i];
        if ((filter_code !== 'all' && b.code !== filter_code) || (track && track.id === b.id))
            continue;
        push_line(lines, [b.pos[0] - 0.55, b.pos[1], b.pos[2]], [b.pos[0] + 0.55, b.pos[1], b.pos[2]], 0.75, 0.88, 0.98, 0.32);
        push_line(lines, [b.pos[0], b.pos[1] - 0.55, b.pos[2]], [b.pos[0], b.pos[1] + 0.55, b.pos[2]], 0.75, 0.88, 0.98, 0.32);
    }

    if (track) {
        const p = track.pos;
        const s = 1.15 + Math.sin(sim_t * 5.0) * 0.08;
        const cl = 0.48;
        for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
                for (const sz of [-1, 1]) {
                    const c = [p[0] + sx * s, p[1] + sy * s, p[2] + sz * s];
                    push_line(lines, c, [c[0] - sx * cl, c[1], c[2]], 0.98, 0.68, 0.12, 0.96);
                    push_line(lines, c, [c[0], c[1] - sy * cl, c[2]], 0.98, 0.68, 0.12, 0.96);
                    push_line(lines, c, [c[0], c[1], c[2] - sz * cl], 0.98, 0.68, 0.12, 0.96);
                }
            }
        }
        const pred = predict_path(track, 8, 0.25);
        for (let i = 0; i < pred.length - 1; i++)
            push_line(lines, pred[i], pred[i + 1], 0.98, 0.76, 0.24, 0.88 * (1 - i / pred.length));
        push_line(lines, p, [p[0], 0.05, p[2]], 0.98, 0.68, 0.12, 0.28);
    }

    for (const s of sightings) {
        const p = s.pos;
        const d = 0.42;
        push_line(lines, [p[0], p[1] + d, p[2]], [p[0] + d, p[1], p[2]], 0.38, 0.86, 0.96, 0.9);
        push_line(lines, [p[0] + d, p[1], p[2]], [p[0], p[1] - d, p[2]], 0.38, 0.86, 0.96, 0.9);
        push_line(lines, [p[0], p[1] - d, p[2]], [p[0] - d, p[1], p[2]], 0.38, 0.86, 0.96, 0.9);
        push_line(lines, [p[0] - d, p[1], p[2]], [p[0], p[1] + d, p[2]], 0.38, 0.86, 0.96, 0.9);
        push_line(lines, [p[0], p[1] - d, p[2]], [p[0], Math.max(0.05, p[1] - 3.5), p[2]], 0.38, 0.86, 0.96, 0.35);
    }

    for (const r of xr_rays)
        push_line(lines, vadd(r.origin, vscale(r.dir, 0.12)), vadd(r.origin, vscale(r.dir, 30.0)), 0.98, 0.72, 0.18, 0.82);

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

const held_keys = new Set();
let prev_ms = performance.now();
let last_hud_ms = 0;
let raf_id = 0;

function sync_hud(now_ms, force = false)
{
    if (!force && now_ms - last_hud_ms < 120)
        return;
    last_hud_ms = now_ms;

    let in_fov = 0;
    let total = 0;
    for (const b of flock) {
        if (filter_code !== 'all' && b.code !== filter_code)
            continue;
        total++;
        const ndc = project_ndc(b.pos, last_vp);
        if (ndc && Math.abs(ndc[0]) <= 1 && Math.abs(ndc[1]) <= 1)
            in_fov++;
    }

    const fwd = xr_session ? [0, 0, -1] : cam_fwd(cam_yaw, cam_pitch);
    const lpol = world_to_polar([0, 0, 0], fwd);
    $('hud-bearing').textContent = `${cardinal(lpol.az_deg)} ${lpol.az_deg.toFixed(0).padStart(3, '0')}°`;
    $('hud-pitch').textContent = `Elev ${lpol.el_deg >= 0 ? '+' + lpol.el_deg.toFixed(0) : lpol.el_deg.toFixed(0)}°`;
    $('hud-scope').textContent = `${zoom}x Scope`;
    $('hud-fov').textContent = `${in_fov}/${total} in FOV`;

    const callout = $('target-callout');
    if (track) {
        const sp = find_species(track.code);
        const pol = world_to_polar(last_eye, track.pos);
        const spd = vlen(track.vel);
        $('tr-name').textContent = sp.common;
        $('tr-meta').innerHTML = `<i>${esc_html(sp.sci)}</i> · ${track.locked ? 'α-β Track Locked' : 'Acquiring'}`;
        $('tr-id').textContent = track.id > 0 ? `#${track.id}` : 'SKY';
        $('tr-az').textContent = `${pol.az_deg.toFixed(1)}°`;
        $('tr-el').textContent = `${pol.el_deg >= 0 ? '+' + pol.el_deg.toFixed(1) : pol.el_deg.toFixed(1)}°`;
        $('tr-rng').textContent = `${pol.range_m.toFixed(1)} m`;
        $('tr-spd').textContent = `${spd.toFixed(1)} m/s`;

        const ndc = project_ndc(track.pos, last_vp);
        if (active_panel === 'field' && !xr_session && ndc && Math.abs(ndc[0]) <= 0.88 && Math.abs(ndc[1]) <= 0.72) {
            callout.textContent = `${track.id > 0 ? '#' + track.id : 'SKY'} ${sp.common} · ${pol.range_m.toFixed(1)} m`;
            callout.style.transform = `translate3d(${ndc[0] * 44}vw, ${-ndc[1] * 38 - 6}vh, 0)`;
            callout.classList.remove('hidden');
        } else {
            callout.classList.add('hidden');
        }
    } else {
        $('tr-name').textContent = 'No Bird Locked';
        $('tr-meta').textContent = 'Click a bird, press Space, or tap Lock Nearest';
        $('tr-id').textContent = '--';
        $('tr-az').textContent = '--';
        $('tr-el').textContent = '--';
        $('tr-rng').textContent = '--';
        $('tr-spd').textContent = '--';
        callout.classList.add('hidden');
    }
}

function step_world(now_ms)
{
    const dt = Math.min(0.05, Math.max(0.001, (now_ms - prev_ms) / 1000));
    prev_ms = now_ms;
    const sim_t = now_ms / 1000;

    if (!xr_session) {
        const pan = (1.35 / Math.sqrt(zoom)) * dt;
        if (held_keys.has('ArrowLeft') || held_keys.has('KeyA')) cam_yaw -= pan;
        if (held_keys.has('ArrowRight') || held_keys.has('KeyD')) cam_yaw += pan;
        if (held_keys.has('ArrowUp') || held_keys.has('KeyW')) cam_pitch = Math.min(1.38, cam_pitch + pan * 0.8);
        if (held_keys.has('ArrowDown') || held_keys.has('KeyS')) cam_pitch = Math.max(-0.55, cam_pitch - pan * 0.8);
    }

    flock = step_flock(flock, dt, sim_t);
    if (track && track.id > 0) {
        const tb = flock.find((b) => b.id === track.id);
        if (tb && (filter_code === 'all' || tb.code === filter_code))
            track = step_track(track, tb.pos, dt);
        else
            track = null;
    } else if (track && track.id === 0) {
        /* Propagate real-sky AR passthrough track smoothly between user pinches */
        if (now_ms - real_sky_fix_ms < 8000)
            track = { ...track, pos: vadd(track.pos, vscale(track.vel, dt)) };
        else
            track = null;
    }
    return sim_t;
}

function frame_2d(now_ms)
{
    if (xr_session)
        return;
    const sim_t = step_world(now_ms);

    if (gl) {
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
        if (ar_sim)
            gl.clearColor(0.04, 0.06, 0.09, 1.0);
        else
            gl.clearColor(0.56, 0.71, 0.86, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const eye = [0, 1.68, 0];
        const fwd = cam_fwd(cam_yaw, cam_pitch);
        const view_mat = m4_look(eye, vadd(eye, fwd), [0, 1, 0]);
        const proj_mat = m4_persp(((62 * Math.PI) / 180) / zoom, w / h, 0.15, 220.0);

        xr_rays = [];
        render_scene(view_mat, proj_mat, eye, ar_sim, sim_t);
    }

    sync_hud(now_ms);

    if (is_software_gl && gl) {
        gl.flush();
        setTimeout(() => {
            if (!xr_session)
                raf_id = requestAnimationFrame(frame_2d);
        }, 33);
    } else {
        raf_id = requestAnimationFrame(frame_2d);
    }
}

function frame_xr(now_ms, frame)
{
    const session = frame.session;
    if (session !== xr_session || !gl || !xr_ref_space)
        return;
    session.requestAnimationFrame(frame_xr);

    const sim_t = step_world(now_ms);
    const pose = frame.getViewerPose(xr_ref_space);
    const layer = session.renderState.baseLayer;
    if (!pose || !layer)
        return;

    xr_rays = [];
    for (const src of session.inputSources) {
        if (!src.targetRaySpace)
            continue;
        const rpose = frame.getPose(src.targetRaySpace, xr_ref_space);
        if (!rpose)
            continue;
        const m = rpose.transform.matrix;
        xr_rays.push({ origin: [m[12], m[13], m[14]], dir: vnorm([-m[8], -m[9], -m[10]]) });
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    for (const view of pose.views) {
        const vp = layer.getViewport(view);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        const p = view.transform.position;
        render_scene(m4_inv_rigid(view.transform.matrix), view.projectionMatrix, [p.x, p.y, p.z], true, sim_t);
    }
    sync_hud(now_ms);
}

/* Tracking & Logging Actions */
function add_sighting(code, pos, speed_ms, source, note)
{
    const sp = find_species(code);
    const pol = world_to_polar(last_eye, pos);
    const s = {
        id: 'S-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 999),
        code: sp.code,
        common: sp.common,
        sci: sp.sci,
        az_deg: pol.az_deg,
        el_deg: pol.el_deg,
        range_m: pol.range_m,
        speed_ms,
        alt_m: pos[1],
        pos: [pos[0], pos[1], pos[2]],
        note,
        time: hhmmss(),
        source
    };
    sightings = [s, ...sightings];
    update_sighting_counts();
    if (active_panel === 'log')
        render_log_panel();
    return s;
}

function orient_to(pos)
{
    if (xr_session)
        return;
    const pol = world_to_polar(last_eye, pos);
    cam_yaw = (pol.az_deg * Math.PI) / 180;
    cam_pitch = Math.max(-0.4, Math.min(1.25, (pol.el_deg * Math.PI) / 180));
}

function lock_nearest()
{
    const dir = cam_fwd(cam_yaw, cam_pitch);
    const hit = pick_bird(flock, last_eye, dir, 28, filter_code) || pick_bird(flock, last_eye, dir, 179, filter_code);
    if (!hit)
        return false;
    track = step_track(init_track(hit.id, hit.code, hit.pos, hit.vel), hit.pos, 0.2);
    const ndc = project_ndc(hit.pos, last_vp);
    if (!ndc || Math.abs(ndc[0]) > 0.75 || Math.abs(ndc[1]) > 0.75)
        orient_to(hit.pos);
    sync_hud(performance.now(), true);
    return true;
}

function cycle_bird(delta)
{
    const pool = filter_code === 'all' ? flock : flock.filter((b) => b.code === filter_code);
    if (pool.length === 0)
        return;
    const idx = pool.findIndex((b) => track && b.id === track.id);
    const b = pool[idx < 0 ? 0 : (idx + delta + pool.length) % pool.length];
    track = step_track(init_track(b.id, b.code, b.pos, b.vel), b.pos, 0.2);
    orient_to(b.pos);
    sync_hud(performance.now(), true);
}

async function toggle_xr()
{
    if (xr_session) {
        await xr_session.end();
        return;
    }
    if (!navigator.xr || !gl) {
        set_ar_sim(true);
        show_toast('WebXR unavailable here — switched to AR Sky Optics preview.');
        return;
    }
    try {
        const ok = await navigator.xr.isSessionSupported('immersive-ar');
        if (!ok) {
            set_ar_sim(true);
            show_toast('immersive-ar requires Meta Quest Browser on Quest 3 — switched to AR Sky preview.');
            return;
        }
        if (gl.makeXRCompatible)
            await gl.makeXRCompatible();

        const session = await navigator.xr.requestSession('immersive-ar', {
            requiredFeatures: ['local-floor'],
            optionalFeatures: ['dom-overlay', 'hand-tracking', 'hit-test'],
            domOverlay: { root: hud_root }
        });
        session.updateRenderState({ baseLayer: new window.XRWebGLLayer(session, gl, { alpha: true }) });
        let ref_space;
        try {
            ref_space = await session.requestReferenceSpace('local-floor');
        } catch {
            ref_space = await session.requestReferenceSpace('local');
        }

        xr_session = session;
        xr_ref_space = ref_space;
        cancelAnimationFrame(raf_id);
        $('xr-btn').textContent = 'Exit Quest 3 AR';
        document.body.dataset.state = 'immersive-ar';

        session.addEventListener('select', (ev) => {
            if (!xr_ref_space || !ev.frame || !ev.inputSource || !ev.inputSource.targetRaySpace)
                return;
            const rpose = ev.frame.getPose(ev.inputSource.targetRaySpace, xr_ref_space);
            if (!rpose)
                return;
            const m = rpose.transform.matrix;
            const origin = [m[12], m[13], m[14]];
            const dir = vnorm([-m[8], -m[9], -m[10]]);
            const hit = pick_bird(flock, origin, dir, 7.5, filter_code);

            if (hit) {
                track = step_track(init_track(hit.id, hit.code, hit.pos, hit.vel), hit.pos, 0.2);
                add_sighting(hit.code, hit.pos, vlen(hit.vel), 'xr-ray', 'Quest 3 pinch/trigger lock');
            } else {
                /* Real-sky bird tracking: consecutive pinches feed alpha-beta velocity estimator */
                const fix = vadd(origin, vscale(dir, 24.0));
                fix[1] = Math.max(1.2, fix[1]);
                const now = performance.now();
                const code = filter_code === 'all' ? 'amekes' : filter_code;
                if (track && track.id === 0 && now - real_sky_fix_ms < 6000) {
                    const dt = Math.max(0.08, (now - real_sky_fix_ms) / 1000);
                    track = step_track(track, fix, dt, 0.65, 0.35);
                } else {
                    track = init_track(0, code, fix, [0, 0, 0]);
                }
                real_sky_fix_ms = now;
                add_sighting(code, fix, vlen(track.vel), 'xr-ray', 'Real-sky AR ray fix');
            }
            sync_hud(performance.now(), true);
        });

        session.addEventListener('end', () => {
            xr_session = null;
            xr_ref_space = null;
            xr_rays = [];
            $('xr-btn').textContent = 'Enter Quest 3 AR';
            document.body.dataset.state = active_panel;
            prev_ms = performance.now();
            raf_id = requestAnimationFrame(frame_2d);
        });

        session.requestAnimationFrame(frame_xr);
    } catch (err) {
        show_toast(err instanceof Error ? err.message : 'Unable to start immersive-ar.');
    }
}

function set_zoom(z)
{
    zoom = z;
    for (const b of document.querySelectorAll('[data-zoom]'))
        b.setAttribute('aria-pressed', Number(b.getAttribute('data-zoom')) === z ? 'true' : 'false');
    sync_hud(performance.now(), true);
}

function set_ar_sim(on)
{
    ar_sim = on;
    for (const b of document.querySelectorAll('[data-ar-sim]'))
        b.setAttribute('aria-pressed', (b.getAttribute('data-ar-sim') === '1') === on ? 'true' : 'false');
    sync_hud(performance.now(), true);
}

/* Wire DOM Events */
$('brand-link').addEventListener('click', (e) => {
    e.preventDefault();
    set_panel('field');
});

for (const btn of document.querySelectorAll('[data-panel]'))
    btn.addEventListener('click', () => set_panel(btn.getAttribute('data-panel')));

for (const btn of document.querySelectorAll('[data-close-panel]'))
    btn.addEventListener('click', () => set_panel('field'));

$('xr-btn').addEventListener('click', toggle_xr);
$('toast-close').addEventListener('click', () => toast_el.classList.add('hidden'));

$('btn-lock').addEventListener('click', lock_nearest);
$('btn-next').addEventListener('click', () => cycle_bird(1));

$('btn-log').addEventListener('click', () => {
    if (!track && !lock_nearest())
        return;
    const s = add_sighting(track.code, track.pos, vlen(track.vel), 'reticle', 'Optical reticle lock');
    show_toast(`Logged ${s.common} (${s.az_deg.toFixed(0)}° · ${s.range_m.toFixed(1)} m)`);
});

$('btn-pin').addEventListener('click', () => {
    pin_open = true;
    $('pin-err').classList.add('hidden');
    set_panel('field');
});

$('pin-cancel-top').addEventListener('click', () => { pin_open = false; set_panel('field'); });
$('pin-cancel-btn').addEventListener('click', () => { pin_open = false; set_panel('field'); });

$('pin-note').addEventListener('input', () => $('pin-err').classList.add('hidden'));

$('pin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const note = $('pin-note').value.trim();
    if (!note) {
        $('pin-err').classList.remove('hidden');
        return;
    }
    const dir = cam_fwd(cam_yaw, cam_pitch);
    const pos = vadd(last_eye, vscale(dir, 24.0));
    pos[1] = Math.max(1.5, pos[1]);
    const s = add_sighting(pin_select.value, pos, 0, 'manual-pin', note);
    $('pin-note').value = '';
    pin_open = false;
    set_panel('field');
    show_toast(`Pinned ${s.common} waypoint in 3D sky`);
});

$('log-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del-id]');
    if (!btn)
        return;
    const id = btn.getAttribute('data-del-id');
    sightings = sightings.filter((r) => r.id !== id);
    render_log_panel();
});

$('export-csv-btn').addEventListener('click', () => {
    const blob = new Blob([to_csv(sightings)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'avianxr-sightings.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

$('region-select').addEventListener('change', (e) => load_nearby(Number(e.target.value)));

$('nearby-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-spawn-code]');
    if (!btn)
        return;
    const code = btn.getAttribute('data-spawn-code');
    const sp = find_species(code);
    const fwd = cam_fwd(cam_yaw, cam_pitch);
    const flat = vnorm([fwd[0], 0, fwd[2]]);
    const alt = Math.max(sp.alt_min, Math.min(sp.alt_max, 14));
    const anchor = [last_eye[0] + flat[0] * 24, alt, last_eye[2] + flat[2] * 24];
    const id = next_bird_id++;
    const pos = orbit_pos(anchor, 12, id, sp, 0, prev_ms / 1000);
    const b = { id, code: sp.code, pos, vel: [0, 0, sp.speed], yaw: 0, bank: -0.22, phase: 0, anchor, orbit_r: 12, orbit_dir: 1 };
    flock = [...flock, b];
    filter_code = 'all';
    filter_select.value = 'all';
    track = step_track(init_track(b.id, b.code, b.pos, b.vel), b.pos, 0.2);
    set_panel('field');
    show_toast(`Spawned & locked ${sp.common} in forward sector`);
    sync_hud(performance.now(), true);
});

for (const btn of document.querySelectorAll('[data-zoom]'))
    btn.addEventListener('click', () => set_zoom(Number(btn.getAttribute('data-zoom'))));

for (const btn of document.querySelectorAll('[data-ar-sim]'))
    btn.addEventListener('click', () => set_ar_sim(btn.getAttribute('data-ar-sim') === '1'));

filter_select.addEventListener('change', (e) => {
    filter_code = e.target.value;
    sync_hud(performance.now(), true);
});

/* Pointer & Keyboard Controls */
let drag = { active: false, x: 0, y: 0, moved: false };

canvas.addEventListener('pointerdown', (e) => {
    drag = { active: true, x: e.clientX, y: e.clientY, moved: false };
});

canvas.addEventListener('pointermove', (e) => {
    if (!drag.active)
        return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3)
        drag.moved = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    cam_yaw -= (dx * 0.0038) / zoom;
    cam_pitch = Math.max(-0.55, Math.min(1.38, cam_pitch + (dy * 0.0032) / zoom));
});

canvas.addEventListener('pointerup', (e) => {
    const moved = drag.moved;
    drag.active = false;
    if (!moved) {
        const rect = canvas.getBoundingClientRect();
        const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
        const ny = -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
        const fov = ((62 * Math.PI) / 180) / zoom;
        const ray = ndc_to_ray(nx, ny, cam_yaw, cam_pitch, fov, rect.width / Math.max(1, rect.height));
        const hit = pick_bird(flock, last_eye, ray, 8.5, filter_code);
        if (hit) {
            track = step_track(init_track(hit.id, hit.code, hit.pos, hit.vel), hit.pos, 0.2);
            sync_hud(performance.now(), true);
        }
    }
});

canvas.addEventListener('wheel', (e) => {
    if (e.deltaY < 0) set_zoom(zoom === 1 ? 2 : 4);
    else if (e.deltaY > 0) set_zoom(zoom === 4 ? 2 : 1);
}, { passive: true });

window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
        return;
    held_keys.add(e.code);
    if (e.code === 'Space' || e.code === 'KeyT') {
        e.preventDefault();
        lock_nearest();
    } else if (e.code === 'BracketRight') {
        cycle_bird(1);
    } else if (e.code === 'BracketLeft') {
        cycle_bird(-1);
    } else if (e.code === 'KeyL') {
        $('btn-log').click();
    } else if (e.code === 'Digit1') {
        set_zoom(1);
    } else if (e.code === 'Digit2') {
        set_zoom(2);
    } else if (e.code === 'Digit4') {
        set_zoom(4);
    }
});

window.addEventListener('keyup', (e) => held_keys.delete(e.code));

/* Boot */
render_log_panel();
load_nearby(0);
raf_id = requestAnimationFrame(frame_2d);
