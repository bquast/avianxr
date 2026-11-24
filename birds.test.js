import test from 'node:test';
import assert from 'node:assert/strict';
import {
    create_flock,
    step_flock,
    world_to_polar,
    cardinal,
    init_track,
    step_track,
    predict_path,
    pick_bird,
    ndc_to_ray,
    cam_fwd,
    m4_persp,
    m4_look,
    m4_mul,
    project_ndc,
    to_csv
} from './birds.js';

test('world_to_polar computes North=0, East=90, elevation and range', () => {
    const n = world_to_polar([0, 1.7, 0], [0, 1.7, -25]);
    assert.ok(Math.abs(n.az_deg - 0) < 1e-5);
    assert.ok(Math.abs(n.el_deg - 0) < 1e-5);
    assert.ok(Math.abs(n.range_m - 25) < 1e-5);
    assert.equal(cardinal(n.az_deg), 'N');

    const e = world_to_polar([0, 0, 0], [10, 10, 0]);
    assert.ok(Math.abs(e.az_deg - 90) < 1e-5);
    assert.ok(Math.abs(e.el_deg - 45) < 1e-5);
    assert.equal(cardinal(e.az_deg), 'E');
});

test('create_flock and step_flock keep realistic frame-1 speed and altitude floor', () => {
    const f1 = create_flock(42, 10);
    const f2 = create_flock(42, 10);
    assert.equal(f1.length, 10);
    assert.deepEqual(f1[0].pos, f2[0].pos);

    let cur = step_flock(f1, 1 / 60, 1 / 60);
    for (const b of cur) {
        const spd = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
        assert.ok(spd < 30, `unexpected velocity spike: ${spd}`);
    }
    for (let i = 1; i < 120; i++)
        cur = step_flock(cur, 1 / 60, (i + 1) / 60);

    for (const b of cur) {
        assert.ok(Number.isFinite(b.pos[0]) && Number.isFinite(b.pos[1]) && Number.isFinite(b.pos[2]));
        assert.ok(b.pos[1] >= 2.5);
    }
});

test('alpha-beta tracker locks and predicts forward trajectory from fixes', () => {
    let tr = init_track(1, 'amekes', [0, 15, -25], [8, 0, 0]);
    for (let i = 1; i <= 6; i++)
        tr = step_track(tr, [i * 0.8, 15, -25], 0.1);

    assert.equal(tr.locked, true);
    assert.ok(tr.vel[0] > 4.0);
    const path = predict_path(tr, 6, 0.25);
    assert.equal(path.length, 7);
});

test('pick_bird hits targeted bird along ray and respects species filter', () => {
    const flock = create_flock(42, 6);
    const target = flock[2];
    const eye = [0, 1.68, 0];
    const ray = [target.pos[0] - eye[0], target.pos[1] - eye[1], target.pos[2] - eye[2]];
    const hit = pick_bird(flock, eye, ray, 5.0);
    assert.ok(hit !== null);
    assert.equal(hit.id, target.id);
    assert.equal(pick_bird(flock, eye, ray, 5.0, 'none'), null);
});

test('ndc_to_ray and project_ndc are mutually consistent', () => {
    const yaw = 0.3, pitch = 0.18;
    const fwd = cam_fwd(yaw, pitch);
    const ray = ndc_to_ray(0, 0, yaw, pitch, Math.PI / 3, 16 / 9);
    assert.ok(Math.abs(fwd[0] - ray[0]) < 1e-6);
    assert.ok(Math.abs(fwd[1] - ray[1]) < 1e-6);

    const eye = [0, 1.7, 0];
    const pt = [eye[0] + fwd[0] * 20, eye[1] + fwd[1] * 20, eye[2] + fwd[2] * 20];
    const vp = m4_mul(m4_persp(Math.PI / 3, 16 / 9, 0.1, 200), m4_look(eye, pt, [0, 1, 0]));
    const ndc = project_ndc(pt, vp);
    assert.ok(ndc !== null);
    assert.ok(Math.abs(ndc[0]) < 1e-5 && Math.abs(ndc[1]) < 1e-5);
});

test('to_csv formats rows and escapes embedded double quotes', () => {
    const csv = to_csv([{
        id: 'S-1',
        time: '08:22:10',
        code: 'amekes',
        common: 'American Kestrel',
        sci: 'Falco sparverius',
        az_deg: 342.4,
        el_deg: 18.2,
        range_m: 26.5,
        speed_ms: 9.5,
        alt_m: 14.1,
        source: 'xr-ray',
        note: 'Hovering near "north" post'
    }]);
    const lines = csv.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines[1].includes('"Hovering near ""north"" post"'));
});
