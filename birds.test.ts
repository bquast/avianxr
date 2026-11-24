import test from 'node:test';
import assert from 'node:assert/strict';
import {
  create_flock,
  step_flock,
  world_to_polar,
  compass_cardinal,
  init_track,
  step_track,
  predict_track_path,
  pick_bird_by_ray,
  screen_ndc_to_ray,
  camera_forward,
  m4_persp,
  m4_look_at,
  m4_mul,
  project_to_ndc,
  sightings_to_csv,
} from './birds';

test('world_to_polar computes North=0, East=90, and accurate elevation/range', () => {
  const n = world_to_polar([0, 1.7, 0], [0, 1.7, -25]);
  assert.ok(Math.abs(n.az_deg - 0) < 1e-5);
  assert.ok(Math.abs(n.el_deg - 0) < 1e-5);
  assert.ok(Math.abs(n.range_m - 25) < 1e-5);
  assert.equal(compass_cardinal(n.az_deg), 'N');

  const e = world_to_polar([0, 0, 0], [10, 10, 0]);
  assert.ok(Math.abs(e.az_deg - 90) < 1e-5);
  assert.ok(Math.abs(e.el_deg - 45) < 1e-5);
  assert.equal(compass_cardinal(e.az_deg), 'E');
});

test('create_flock and step_flock preserve count and altitude floor deterministically', () => {
  const f1 = create_flock(42, 10);
  const f2 = create_flock(42, 10);
  assert.equal(f1.length, 10);
  assert.deepEqual(f1[0].pos, f2[0].pos);

  let cur = step_flock(f1, 1 / 60, 1 / 60);
  for (const b of cur) {
    const spd = Math.hypot(b.vel[0], b.vel[1], b.vel[2]);
    assert.ok(spd < 30, `frame-1 speed ${spd} spiked unrealistically`);
  }
  for (let i = 1; i < 120; i++) {
    cur = step_flock(cur, 1 / 60, (i + 1) / 60);
  }
  assert.equal(cur.length, 10);
  for (const b of cur) {
    assert.ok(Number.isFinite(b.pos[0]) && Number.isFinite(b.pos[1]) && Number.isFinite(b.pos[2]));
    assert.ok(b.pos[1] >= 2.5, `bird altitude ${b.pos[1]} dropped below safety floor`);
  }
});

test('alpha-beta tracker locks and predicts forward trajectory', () => {
  let flock = create_flock(7, 4);
  let tr = init_track(flock[0]);
  for (let i = 1; i <= 15; i++) {
    flock = step_flock(flock, 0.05, i * 0.05);
    const next = step_track(tr, flock[0], 0.05);
    assert.ok(next !== null);
    tr = next;
  }
  assert.equal(tr.locked, true);
  const path = predict_track_path(tr, 6, 0.25);
  assert.equal(path.length, 7);
  assert.ok(path[6][1] >= 1.5);
});

test('pick_bird_by_ray selects targeted bird along Quest 3 or screen ray', () => {
  const flock = create_flock(42, 6);
  const target = flock[2];
  const eye: [number, number, number] = [0, 1.65, 0];
  const ray: [number, number, number] = [
    target.pos[0] - eye[0],
    target.pos[1] - eye[1],
    target.pos[2] - eye[2],
  ];
  const hit = pick_bird_by_ray(flock, eye, ray, 5.0);
  assert.ok(hit !== null);
  assert.equal(hit.id, target.id);

  const filtered_miss = pick_bird_by_ray(flock, eye, ray, 5.0, 'nonexistent');
  assert.equal(filtered_miss, null);
});

test('screen_ndc_to_ray center matches camera_forward and project_to_ndc projects center to origin', () => {
  const yaw = 0.35;
  const pitch = 0.2;
  const fwd = camera_forward(yaw, pitch);
  const ray = screen_ndc_to_ray(0, 0, yaw, pitch, Math.PI / 3, 16 / 9);
  assert.ok(Math.abs(fwd[0] - ray[0]) < 1e-6);
  assert.ok(Math.abs(fwd[1] - ray[1]) < 1e-6);
  assert.ok(Math.abs(fwd[2] - ray[2]) < 1e-6);

  const eye: [number, number, number] = [0, 1.7, 0];
  const pt: [number, number, number] = [eye[0] + fwd[0] * 20, eye[1] + fwd[1] * 20, eye[2] + fwd[2] * 20];
  const vp = m4_mul(m4_persp(Math.PI / 3, 16 / 9, 0.1, 300), m4_look_at(eye, pt, [0, 1, 0]));
  const ndc = project_to_ndc(pt, vp);
  assert.ok(ndc !== null);
  assert.ok(Math.abs(ndc[0]) < 1e-5);
  assert.ok(Math.abs(ndc[1]) < 1e-5);
});

test('sightings_to_csv escapes quotes and writes header + rows', () => {
  const csv = sightings_to_csv([
    {
      id: 'S-1',
      bird_id: 1,
      code: 'amekes',
      common: 'American Kestrel',
      sci: 'Falco sparverius',
      az_deg: 342.4,
      el_deg: 18.2,
      range_m: 26.5,
      speed_ms: 9.5,
      alt_m: 14.1,
      pos: [-6, 14.1, -25],
      note: 'Hovering near "north" post',
      time: '08:22:10',
      source: 'xr-ray',
    },
  ]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"Hovering near ""north"" post"'));
});
