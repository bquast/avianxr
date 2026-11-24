/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  SPECIES,
  Sighting,
  NearbyObs,
  compass_cardinal,
  sightings_to_csv,
} from '../birds';
import {start_engine, EngineHandle, HudTelemetry} from '../xr';

type ActivePanel = 'field' | 'log' | 'nearby' | 'guide';

const INITIAL_SIGHTINGS: Sighting[] = [
  {
    id: 'S-init-1',
    bird_id: 1,
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
    source: 'reticle',
  },
  {
    id: 'S-init-2',
    bird_id: 2,
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
    source: 'xr-ray',
  },
];

const REGION_PRESETS = [
  {label: 'San Francisco Bay, CA', lat: 37.8044, lng: -122.2712},
  {label: 'Cape May Marsh, NJ', lat: 38.9351, lng: -74.9606},
  {label: 'Texel Wadden Coast, NL', lat: 53.0546, lng: 4.7977},
  {label: 'Bosque del Apache, NM', lat: 33.8042, lng: -106.8914},
];

const STATIC_NEARBY_FALLBACK: NearbyObs[] = [
  {code: 'amekes', common: 'American Kestrel', sci: 'Falco sparverius', count: 2, lat: 37.8044, lng: -122.2712, loc: 'Coastal Meadow Ridge', time: '08:05'},
  {code: 'rethaw', common: 'Red-tailed Hawk', sci: 'Buteo jamaicensis', count: 1, lat: 37.8089, lng: -122.2681, loc: 'North Thermal Bluff', time: '07:52'},
  {code: 'perfal', common: 'Peregrine Falcon', sci: 'Falco peregrinus', count: 1, lat: 37.8015, lng: -122.2755, loc: 'Estuary Pylon', time: '07:41'},
  {code: 'grbher3', common: 'Great Blue Heron', sci: 'Ardea herodias', count: 3, lat: 37.7992, lng: -122.2698, loc: 'Tidal Marsh Flats', time: '07:30'},
];

async function fetch_nearby_birds(lat: number, lng: number): Promise<{source: string; items: NearbyObs[]}> {
  /* 1. Try Cloudflare Pages Function /api/sightings first */
  try {
    const res = await fetch(`./api/sightings?lat=${lat}&lng=${lng}`);
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = (await res.json()) as {source: string; items: NearbyObs[]};
      if (Array.isArray(data.items) && data.items.length > 0) {
        return data;
      }
    }
  } catch {
    /* Static host (gh-pages classic) — proceed to direct CORS public API or deterministic seed */
  }

  /* 2. Direct CORS fetch to public iNaturalist Aves observations for gh-pages classic */
  try {
    const url = `https://api.inaturalist.org/v1/observations?iconic_taxa=Aves&lat=${lat}&lng=${lng}&radius=20&per_page=8&order=desc&order_by=created_at`;
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as {results?: Array<Record<string, unknown>>};
      const results = data.results || [];
      if (results.length > 0) {
        const items: NearbyObs[] = results.map((o) => {
          const taxon = (o.taxon || {}) as Record<string, unknown>;
          const common = String(taxon.preferred_common_name || 'Wild Bird');
          const sci = String(taxon.name || 'Aves sp.');
          const low = `${common} ${sci}`.toLowerCase();
          let code = 'amegfi';
          if (low.includes('kestrel')) code = 'amekes';
          else if (low.includes('hawk') || low.includes('buteo')) code = 'rethaw';
          else if (low.includes('falcon') || low.includes('peregrin')) code = 'perfal';
          else if (low.includes('heron') || low.includes('egret')) code = 'grbher3';
          else if (low.includes('swallow')) code = 'barswa';
          return {
            code,
            common,
            sci,
            count: 1,
            lat,
            lng,
            loc: String(o.place_guess || 'Regional Field'),
            time: String(o.time_observed_at || '').slice(11, 16) || 'Recent',
          };
        });
        return {source: 'iNaturalist Live', items};
      }
    }
  } catch {
    /* Offline field fallback */
  }

  return {source: 'Offline Field Seed', items: STATIC_NEARBY_FALLBACK};
}

export default function App() {
  const canvas_ref = useRef<HTMLCanvasElement | null>(null);
  const overlay_ref = useRef<HTMLDivElement | null>(null);
  const engine_ref = useRef<EngineHandle | null>(null);
  const drag_ref = useRef<{active: boolean; x: number; y: number; moved: boolean}>({
    active: false, x: 0, y: 0, moved: false,
  });

  const [panel, set_panel] = useState<ActivePanel>('field');
  const [sightings, set_sightings] = useState<Sighting[]>(INITIAL_SIGHTINGS);
  const [species_filter, set_species_filter] = useState<string>('all');
  const [status_banner, set_status_banner] = useState<string | null>(null);

  /* Manual waypoint pin form state */
  const [pin_open, set_pin_open] = useState(false);
  const [pin_species, set_pin_species] = useState('amekes');
  const [pin_note, set_pin_note] = useState('');
  const [pin_error, set_pin_error] = useState<string | null>(null);

  /* Nearby regional sightings state */
  const [region_idx, set_region_idx] = useState(0);
  const [nearby_loading, set_nearby_loading] = useState(false);
  const [nearby_source, set_nearby_source] = useState('Regional Feed');
  const [nearby_items, set_nearby_items] = useState<NearbyObs[]>(STATIC_NEARBY_FALLBACK);

  const [hud, set_hud] = useState<HudTelemetry>({
    xr_supported: false,
    xr_active: false,
    passthrough_sim: false,
    zoom: 1,
    heading_deg: 0,
    pitch_deg: 14,
    flock_count: 12,
    visible_in_fov: 4,
    tracked: null,
  });

  /* Mount WebGL2 + WebXR engine once */
  useEffect(() => {
    const canvas = canvas_ref.current;
    if (!canvas) return;

    const eng = start_engine(
      canvas,
      overlay_ref.current,
      INITIAL_SIGHTINGS,
      (next_hud) => set_hud(next_hud),
      (xr_sight) => {
        set_sightings((prev) => [xr_sight, ...prev]);
      }
    );
    engine_ref.current = eng;

    return () => {
      eng.destroy();
      engine_ref.current = null;
    };
  }, []);

  /* Sync body data-state for semantic diagnostics */
  useEffect(() => {
    document.body.dataset.state = hud.xr_active ? 'immersive-ar' : panel;
  }, [hud.xr_active, panel]);

  /* Load nearby birds when region changes or panel opens */
  useEffect(() => {
    const reg = REGION_PRESETS[region_idx];
    let cancelled = false;
    set_nearby_loading(true);
    fetch_nearby_birds(reg.lat, reg.lng).then((res) => {
      if (cancelled) return;
      set_nearby_items(res.items);
      set_nearby_source(res.source);
      set_nearby_loading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [region_idx]);

  /* Global keyboard shortcuts for field operation */
  useEffect(() => {
    function on_key(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const eng = engine_ref.current;
      if (!eng) return;

      if (e.code === 'Space' || e.code === 'KeyT') {
        e.preventDefault();
        eng.lock_nearest();
      } else if (e.code === 'BracketRight') {
        eng.cycle_target(1);
      } else if (e.code === 'BracketLeft') {
        eng.cycle_target(-1);
      } else if (e.code === 'KeyL') {
        const s = eng.log_current_or_pin();
        if (s) {
          set_sightings((prev) => [s, ...prev]);
          set_status_banner(`Logged ${s.common} at ${s.range_m.toFixed(1)} m`);
        }
      } else if (e.code === 'Digit1') {
        eng.set_zoom(1);
      } else if (e.code === 'Digit2') {
        eng.set_zoom(2);
      } else if (e.code === 'Digit4') {
        eng.set_zoom(4);
      }
    }
    window.addEventListener('keydown', on_key);
    return () => window.removeEventListener('keydown', on_key);
  }, []);

  /* Auto-dismiss transient status toasts so they never linger over the sky */
  useEffect(() => {
    if (!status_banner) return;
    const id = window.setTimeout(() => set_status_banner(null), 4000);
    return () => window.clearTimeout(id);
  }, [status_banner]);

  async function handle_xr_toggle(): Promise<void> {
    const eng = engine_ref.current;
    if (!eng) return;
    if (hud.xr_active) {
      await eng.exit_ar();
      set_status_banner(null);
      return;
    }
    const msg = await eng.enter_ar();
    if (msg) {
      set_status_banner(msg);
    } else {
      set_status_banner(null);
    }
  }

  function handle_log_locked(): void {
    const eng = engine_ref.current;
    if (!eng) return;
    const s = eng.log_current_or_pin();
    if (!s) {
      const locked = eng.lock_nearest();
      if (locked) {
        const s2 = eng.log_current_or_pin();
        if (s2) {
          set_sightings((prev) => [s2, ...prev]);
          set_status_banner(`Logged ${s2.common} (${s2.az_deg.toFixed(0)}° · ${s2.range_m.toFixed(1)} m)`);
        }
      }
      return;
    }
    set_sightings((prev) => [s, ...prev]);
    set_status_banner(`Logged ${s.common} (${s.az_deg.toFixed(0)}° · ${s.range_m.toFixed(1)} m)`);
  }

  function handle_submit_manual_pin(e: React.FormEvent): void {
    e.preventDefault();
    if (!pin_note.trim()) {
      set_pin_error('Enter a brief field note (e.g. "Perched on east snag") before saving.');
      return;
    }
    const eng = engine_ref.current;
    if (!eng) return;
    const created = eng.drop_manual_pin(pin_species, pin_note);
    set_sightings((prev) => [created, ...prev]);
    set_pin_note('');
    set_pin_error(null);
    set_pin_open(false);
    set_status_banner(`Pinned ${created.common} waypoint in 3D sky`);
  }

  function handle_delete_sighting(id: string): void {
    set_sightings((prev) => {
      const next = prev.filter((r) => r.id !== id);
      engine_ref.current?.sync_pins(next);
      return next;
    });
  }

  function handle_export_csv(): void {
    const csv = sightings_to_csv(sightings);
    const blob = new Blob([csv], {type: 'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'avianxr-sightings.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function on_pointer_down(e: React.PointerEvent<HTMLCanvasElement>): void {
    drag_ref.current = {active: true, x: e.clientX, y: e.clientY, moved: false};
  }

  function on_pointer_move(e: React.PointerEvent<HTMLCanvasElement>): void {
    if (!drag_ref.current.active) return;
    const dx = e.clientX - drag_ref.current.x;
    const dy = e.clientY - drag_ref.current.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      drag_ref.current.moved = true;
    }
    drag_ref.current.x = e.clientX;
    drag_ref.current.y = e.clientY;
    engine_ref.current?.pan_by(-dx * 0.0038, dy * 0.0032);
  }

  function on_pointer_up(e: React.PointerEvent<HTMLCanvasElement>): void {
    const was_moved = drag_ref.current.moved;
    drag_ref.current.active = false;
    if (!was_moved && canvas_ref.current) {
      const rect = canvas_ref.current.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      engine_ref.current?.click_ndc(nx, ny);
    }
  }

  function on_wheel(e: React.WheelEvent<HTMLCanvasElement>): void {
    if (e.deltaY < 0) {
      const next = hud.zoom === 1 ? 2 : 4;
      engine_ref.current?.set_zoom(next);
    } else if (e.deltaY > 0) {
      const next = hud.zoom === 4 ? 2 : 1;
      engine_ref.current?.set_zoom(next);
    }
  }

  const cardinal = compass_cardinal(hud.heading_deg);

  return (
    <div className="relative w-screen h-screen overflow-hidden select-none bg-slate-950 text-slate-100">
      {/* Dedicated WebGL2 / WebXR Canvas */}
      <canvas
        ref={canvas_ref}
        data-testid="xr-bird-canvas"
        aria-label="3D Bird Tracking Viewport"
        onPointerDown={on_pointer_down}
        onPointerMove={on_pointer_move}
        onPointerUp={on_pointer_up}
        onPointerCancel={() => { drag_ref.current.active = false; }}
        onWheel={on_wheel}
        className="block w-full h-full cursor-crosshair touch-none"
      />

      {/* Semantic DOM Overlay Root (also mounted into Quest 3 WebXR dom-overlay) */}
      <div
        id="xr-overlay"
        ref={overlay_ref}
        className="pointer-events-none fixed inset-0 z-10 flex flex-col justify-between"
      >
        {/* Top Bar Contract: 1-row, 3-zone header (Brand | 4 single-line nav links | 1 primary CTA) */}
        <header className="pointer-events-auto flex items-center justify-between gap-8 px-6 py-3.5 bg-slate-950/88 border-b border-white/12">
          <a
            href="#field"
            onClick={(e) => { e.preventDefault(); set_panel('field'); }}
            className="font-display text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-amber-400"
          >
            AvianXR
          </a>

          <nav aria-label="Primary sections" className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-300">
            <button
              type="button"
              onClick={() => set_panel('field')}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                panel === 'field' ? 'text-white border-amber-400' : 'border-transparent hover:text-white'
              }`}
            >
              Field Optics
            </button>
            <button
              type="button"
              onClick={() => set_panel('log')}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                panel === 'log' ? 'text-white border-amber-400' : 'border-transparent hover:text-white'
              }`}
            >
              Sightings ({sightings.length})
            </button>
            <button
              type="button"
              onClick={() => set_panel('nearby')}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                panel === 'nearby' ? 'text-white border-amber-400' : 'border-transparent hover:text-white'
              }`}
            >
              Nearby Feed
            </button>
            <button
              type="button"
              onClick={() => set_panel('guide')}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                panel === 'guide' ? 'text-white border-amber-400' : 'border-transparent hover:text-white'
              }`}
            >
              Quest 3 Setup
            </button>
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handle_xr_toggle}
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300"
            >
              {hud.xr_active ? 'Exit Quest 3 AR' : 'Enter Quest 3 AR'}
            </button>
          </div>
        </header>

        {/* Mobile Secondary Section Strip (keeps mobile sticky total well below 15% cap) */}
        <nav
          aria-label="Mobile sections"
          className="pointer-events-auto flex md:hidden items-center justify-around px-3 py-1.5 bg-slate-950/88 border-b border-white/10 text-xs font-medium text-slate-300"
        >
          <button type="button" onClick={() => set_panel('field')} className={`px-2 py-1 whitespace-nowrap ${panel === 'field' ? 'text-amber-400 font-semibold' : ''}`}>
            Field
          </button>
          <button type="button" onClick={() => set_panel('log')} className={`px-2 py-1 whitespace-nowrap ${panel === 'log' ? 'text-amber-400 font-semibold' : ''}`}>
            Sightings ({sightings.length})
          </button>
          <button type="button" onClick={() => set_panel('nearby')} className={`px-2 py-1 whitespace-nowrap ${panel === 'nearby' ? 'text-amber-400 font-semibold' : ''}`}>
            Nearby
          </button>
          <button type="button" onClick={() => set_panel('guide')} className={`px-2 py-1 whitespace-nowrap ${panel === 'guide' ? 'text-amber-400 font-semibold' : ''}`}>
            Quest 3
          </button>
        </nav>

        {/* Center Optical Sight & Non-Blocking Toast */}
        <main className="relative flex-1 flex items-center justify-center">
          {/* Top-center compact bearing readout */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-lg bg-slate-950/82 border border-white/12 font-mono text-xs text-slate-200 whitespace-nowrap">
            <span>{cardinal} {hud.heading_deg.toFixed(0).padStart(3, '0')}°</span>
            <span className="mx-2 text-slate-500" aria-hidden="true">·</span>
            <span>Elev {hud.pitch_deg >= 0 ? `+${hud.pitch_deg.toFixed(0)}` : hud.pitch_deg.toFixed(0)}°</span>
            <span className="mx-2 text-slate-500" aria-hidden="true">·</span>
            <span>{hud.zoom}x Scope</span>
            <span className="mx-2 text-slate-500" aria-hidden="true">·</span>
            <span>{hud.visible_in_fov}/{hud.flock_count} in FOV</span>
          </div>

          {status_banner && (
            <div
              role="status"
              className="pointer-events-auto absolute top-13 left-1/2 -translate-x-1/2 flex items-center gap-3 px-3.5 py-1.5 rounded-lg bg-slate-900/94 border border-amber-400/40 text-xs text-slate-100 shadow-lg w-max max-w-[90vw]"
            >
              <span className="truncate">{status_banner}</span>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => set_status_banner(null)}
                className="text-slate-400 hover:text-white font-semibold px-1 shrink-0"
              >
                Close
              </button>
            </div>
          )}

          {/* 2D Screen-Space Optical Callout Tag above locked 3D bird (when inside FOV in 2D mode) */}
          {panel === 'field' && !hud.xr_active && hud.tracked?.ndc && Math.abs(hud.tracked.ndc[0]) <= 0.88 && Math.abs(hud.tracked.ndc[1]) <= 0.72 && (
            <div
              aria-hidden="true"
              style={{
                transform: `translate3d(${hud.tracked.ndc[0] * 44}vw, ${-hud.tracked.ndc[1] * 38 - 6}vh, 0)`,
              }}
              className="pointer-events-none absolute px-2.5 py-1 rounded bg-slate-950/85 border border-amber-400/50 font-mono text-[11px] text-amber-200 whitespace-nowrap"
            >
              #{hud.tracked.id} {hud.tracked.common} · {hud.tracked.range_m.toFixed(1)} m
            </div>
          )}

          {/* Subtle Optical Spotting Reticle (center of FOV, shifted slightly upward on mobile to clear HUD) */}
          {panel === 'field' && !pin_open && (
            <div aria-hidden="true" className="relative w-16 h-16 md:w-24 md:h-24 -translate-y-6 md:translate-y-0 pointer-events-none opacity-75">
              <div className="absolute top-0 left-0 w-3.5 h-3.5 md:w-4 md:h-4 border-t-2 border-l-2 border-amber-400/80" />
              <div className="absolute top-0 right-0 w-3.5 h-3.5 md:w-4 md:h-4 border-t-2 border-r-2 border-amber-400/80" />
              <div className="absolute bottom-0 left-0 w-3.5 h-3.5 md:w-4 md:h-4 border-b-2 border-l-2 border-amber-400/80" />
              <div className="absolute bottom-0 right-0 w-3.5 h-3.5 md:w-4 md:h-4 border-b-2 border-r-2 border-amber-400/80" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-amber-400/90" />
            </div>
          )}

          {/* Manual 3D Waypoint Pin Dialog */}
          {pin_open && panel === 'field' && (
            <form
              onSubmit={handle_submit_manual_pin}
              aria-label="Drop 3D Sky Waypoint"
              className="pointer-events-auto w-full max-w-md mx-4 p-5 rounded-xl bg-slate-950/95 border border-white/15 shadow-xl space-y-4"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-semibold text-white">Drop 3D Sighting Waypoint</h2>
                <button
                  type="button"
                  onClick={() => { set_pin_open(false); set_pin_error(null); }}
                  className="text-xs text-slate-400 hover:text-white px-2 py-1"
                >
                  Cancel
                </button>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="pin-species-select" className="block text-xs font-medium text-slate-300">
                  Observed Species
                </label>
                <select
                  id="pin-species-select"
                  value={pin_species}
                  onChange={(e) => set_pin_species(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-white/15 text-sm text-white focus-visible:outline-2 focus-visible:outline-amber-400"
                >
                  {SPECIES.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.common} ({s.sci})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="pin-note-input" className="block text-xs font-medium text-slate-300">
                  Field Observation Note
                </label>
                <input
                  id="pin-note-input"
                  type="text"
                  value={pin_note}
                  onChange={(e) => {
                    set_pin_note(e.target.value);
                    if (pin_error) set_pin_error(null);
                  }}
                  placeholder="e.g. Hovering 20m over marsh reeds"
                  className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-white/15 text-sm text-white placeholder:text-slate-500 focus-visible:outline-2 focus-visible:outline-amber-400"
                />
                {pin_error && (
                  <p role="alert" className="text-xs text-amber-300">
                    {pin_error}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { set_pin_open(false); set_pin_error(null); }}
                  className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg whitespace-nowrap"
                >
                  Save 3D Pin
                </button>
              </div>
            </form>
          )}

          {/* Panel: Sightings Log */}
          {panel === 'log' && (
            <section
              aria-label="Sightings Log"
              className="pointer-events-auto w-full max-w-4xl mx-4 max-h-[74vh] flex flex-col rounded-xl bg-slate-950/94 border border-white/14 shadow-xl overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-white/10">
                <div>
                  <h2 className="font-display text-lg font-semibold text-white">Recorded Field Sightings</h2>
                  <p className="text-xs text-slate-400">
                    {sightings.length} spatial records · Quest 3 ray locks and optical bearings
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handle_export_csv}
                    disabled={sightings.length === 0}
                    className="px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 rounded-lg whitespace-nowrap"
                  >
                    Download CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => set_panel('field')}
                    className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg border border-white/12 whitespace-nowrap"
                  >
                    Return to Field
                  </button>
                </div>
              </div>

              <div className="overflow-y-auto p-6">
                {sightings.length === 0 ? (
                  <div className="py-10 text-center space-y-2">
                    <p className="text-sm text-slate-300">No sightings recorded in this session yet.</p>
                    <p className="text-xs text-slate-500">
                      Lock onto a bird in Field Optics or pinch in Quest 3 AR to log its 3D bearing.
                    </p>
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-white/12 text-xs text-slate-400">
                        <th className="pb-2.5 pr-4 font-medium">Time</th>
                        <th className="pb-2.5 pr-4 font-medium">Species</th>
                        <th className="pb-2.5 pr-4 font-medium">Bearing · Elev</th>
                        <th className="pb-2.5 pr-4 font-medium">Range · Alt</th>
                        <th className="pb-2.5 pr-4 font-medium">Note</th>
                        <th className="pb-2.5 text-right font-medium">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/8">
                      {sightings.map((s) => (
                        <tr key={s.id} className="hover:bg-white/4">
                          <td className="py-3 pr-4 font-mono text-xs text-slate-300 whitespace-nowrap">{s.time}</td>
                          <td className="py-3 pr-4">
                            <div className="font-medium text-slate-100">{s.common}</div>
                            <div className="text-xs text-slate-400 italic">{s.sci}</div>
                          </td>
                          <td className="py-3 pr-4 font-mono text-xs text-slate-200 whitespace-nowrap">
                            {s.az_deg.toFixed(1)}° · {s.el_deg >= 0 ? `+${s.el_deg.toFixed(1)}` : s.el_deg.toFixed(1)}°
                          </td>
                          <td className="py-3 pr-4 font-mono text-xs text-slate-200 whitespace-nowrap">
                            {s.range_m.toFixed(1)} m · {s.alt_m.toFixed(1)} m
                          </td>
                          <td className="py-3 pr-4 text-xs text-slate-300">{s.note}</td>
                          <td className="py-3 text-right">
                            <button
                              type="button"
                              aria-label={`Delete sighting ${s.common} at ${s.time}`}
                              onClick={() => handle_delete_sighting(s.id)}
                              className="px-2.5 py-1 text-xs text-slate-400 hover:text-red-300 rounded whitespace-nowrap"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          )}

          {/* Panel: Nearby Avian Observations (CF Pages /api/sightings + iNaturalist gh-pages fallback) */}
          {panel === 'nearby' && (
            <section
              aria-label="Nearby Bird Observations"
              className="pointer-events-auto w-full max-w-3xl mx-4 max-h-[74vh] flex flex-col rounded-xl bg-slate-950/94 border border-white/14 shadow-xl overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-white/10">
                <div>
                  <h2 className="font-display text-lg font-semibold text-white">Regional Avian Observations</h2>
                  <p className="text-xs text-slate-400">
                    Source: {nearby_source} · Spawn observed species directly into your 3D sky
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <label htmlFor="region-preset" className="sr-only">Flyway Sector</label>
                  <select
                    id="region-preset"
                    value={region_idx}
                    onChange={(e) => set_region_idx(Number(e.target.value))}
                    className="px-3 py-2 rounded-lg bg-slate-900 border border-white/15 text-xs text-white"
                  >
                    {REGION_PRESETS.map((r, idx) => (
                      <option key={r.label} value={idx}>{r.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => set_panel('field')}
                    className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg border border-white/12 whitespace-nowrap"
                  >
                    Return to Field
                  </button>
                </div>
              </div>

              <div className="overflow-y-auto p-6">
                {nearby_loading ? (
                  <p className="py-8 text-center text-xs text-slate-400">Loading regional observations...</p>
                ) : (
                  <div className="divide-y divide-white/8">
                    {nearby_items.map((item, idx) => (
                      <div key={`${item.code}-${idx}`} className="py-3.5 flex items-center justify-between gap-4">
                        <div>
                          <div className="text-sm font-semibold text-slate-100">{item.common}</div>
                          <div className="text-xs text-slate-400">
                            <span className="italic">{item.sci}</span>
                            <span className="mx-1.5" aria-hidden="true">·</span>
                            <span>{item.loc}</span>
                            <span className="mx-1.5" aria-hidden="true">·</span>
                            <span className="font-mono">Count {item.count}</span>
                            <span className="mx-1.5" aria-hidden="true">·</span>
                            <span className="font-mono">{item.time}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            engine_ref.current?.spawn_species(item.code);
                            set_species_filter('all');
                            set_panel('field');
                            set_status_banner(`Spawned & locked ${item.common} in forward sector`);
                          }}
                          className="px-3.5 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg whitespace-nowrap shrink-0"
                        >
                          Track in Sky
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Panel: Meta Quest 3 WebXR & Static / CF Pages Hosting Guide */}
          {panel === 'guide' && (
            <section
              aria-label="Quest 3 Setup and Hosting Guide"
              className="pointer-events-auto w-full max-w-3xl mx-4 max-h-[74vh] overflow-y-auto p-6 rounded-xl bg-slate-950/94 border border-white/14 shadow-xl space-y-6"
            >
              <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
                <div>
                  <h2 className="font-display text-lg font-semibold text-white">Meta Quest 3 WebXR & Hosting</h2>
                  <p className="text-xs text-slate-400">
                    Browser WebXR status: {hud.xr_supported ? 'immersive-ar ready' : '2D Field & Passthrough Sim mode (open in Meta Quest Browser over HTTPS for stereo AR)'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => set_panel('field')}
                  className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg border border-white/12 whitespace-nowrap"
                >
                  Return to Field
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs text-slate-300 leading-relaxed">
                <div className="space-y-2">
                  <h3 className="font-display text-sm font-semibold text-white">01. Quest 3 Passthrough Controls</h3>
                  <p>
                    Open the hosted HTTPS URL inside <strong>Meta Quest Browser</strong> and press <strong>Enter Quest 3 AR</strong>. WebGL2 clears with alpha 0 to expose full-color Quest 3 stereo passthrough with 360° horizon compass ticks and 3D flight vectors.
                  </p>
                  <p className="text-slate-400">
                    <strong>Trigger or Hand Pinch:</strong> Aim controller ray or bare-hand pinch ray at a bird to lock the α-β tracker and log a sighting, or pinch open sky to drop a 3D waypoint marker at 22m.
                  </p>
                </div>

                <div className="space-y-2">
                  <h3 className="font-display text-sm font-semibold text-white">02. Architecture & File Layout</h3>
                  <p>
                    Zero 3D libraries — pure functional TypeScript and raw WebGL2 shaders in flat root modules:
                  </p>
                  <p className="font-mono text-slate-200">
                    /birds.ts · /xr.ts · /functions/api/sightings.ts
                  </p>
                  <p className="text-slate-400">
                    Vite builds with relative <code className="font-mono text-slate-200">base: './'</code> so the exact same <code className="font-mono text-slate-200">dist/</code> directory deploys cleanly on GitHub Pages classic or Cloudflare Pages.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2 border-t border-white/10 text-xs">
                <div className="space-y-2">
                  <h3 className="font-display text-sm font-semibold text-white">03. GitHub Pages Classic</h3>
                  <pre className="p-3 rounded-lg bg-slate-900 border border-white/10 font-mono text-slate-200 overflow-x-auto">
{`npm run build
npx gh-pages -d dist`}
                  </pre>
                  <p className="text-slate-400">
                    Provides automatic HTTPS required by WebXR <code className="font-mono">navigator.xr</code> and falls back directly to CORS iNaturalist avian data.
                  </p>
                </div>

                <div className="space-y-2">
                  <h3 className="font-display text-sm font-semibold text-white">04. Cloudflare Pages + Functions</h3>
                  <pre className="p-3 rounded-lg bg-slate-900 border border-white/10 font-mono text-slate-200 overflow-x-auto">
{`npm run build
npx wrangler pages deploy dist`}
                  </pre>
                  <p className="text-slate-400">
                    Automatically mounts <code className="font-mono text-slate-200">/functions/api/sightings.ts</code> at <code className="font-mono text-slate-200">/api/sightings</code> (set optional <code className="font-mono text-slate-200">EBIRD_API_KEY</code> in CF Pages env).
                  </p>
                </div>
              </div>
            </section>
          )}
        </main>

        {/* Bottom Field HUD: Left Target Telemetry Card + Right Optical Controls */}
        <footer className="pointer-events-none flex flex-col lg:flex-row lg:items-end justify-between gap-2.5 md:gap-4 p-3 md:px-6 md:pb-5">
          {/* Tracked Bird α-β Filter Telemetry Card */}
          <div className="pointer-events-auto w-full lg:max-w-md p-3.5 md:p-4 rounded-xl bg-slate-950/88 border border-white/12 space-y-2.5 md:space-y-3">
            {hud.tracked ? (
              <>
                <div className="flex items-baseline justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="font-display text-base font-semibold text-white truncate">
                      {hud.tracked.common}
                    </h2>
                    <p className="text-xs text-slate-400 truncate">
                      <span className="italic">{hud.tracked.sci}</span>
                      <span aria-hidden="true">{' · '}</span>
                      <span>{hud.tracked.locked ? 'α-β Track Locked' : 'Acquiring'}</span>
                    </p>
                  </div>
                  <span className="font-mono text-xs text-amber-300 whitespace-nowrap shrink-0">
                    #{hud.tracked.id}
                  </span>
                </div>

                <div className="grid grid-cols-4 gap-2 md:gap-3 pt-2 border-t border-white/10 font-mono">
                  <div>
                    <div className="text-[11px] font-sans text-slate-400">Bearing</div>
                    <div className="text-xs md:text-sm font-semibold text-white">{hud.tracked.az_deg.toFixed(1)}°</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-sans text-slate-400">Elev</div>
                    <div className="text-xs md:text-sm font-semibold text-white">
                      {hud.tracked.el_deg >= 0 ? `+${hud.tracked.el_deg.toFixed(1)}` : hud.tracked.el_deg.toFixed(1)}°
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-sans text-slate-400">Range</div>
                    <div className="text-xs md:text-sm font-semibold text-white">{hud.tracked.range_m.toFixed(1)} m</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-sans text-slate-400">Speed</div>
                    <div className="text-xs md:text-sm font-semibold text-white">{hud.tracked.speed_ms.toFixed(1)} m/s</div>
                  </div>
                </div>
              </>
            ) : (
              <div className="py-1 space-y-1">
                <h2 className="font-display text-sm font-semibold text-white">No Bird Locked</h2>
                <p className="text-xs text-slate-400">
                  Click any bird in the sky, press Space, or use Lock Nearest to engage 3D trajectory tracking.
                </p>
              </div>
            )}

            <div className="flex items-center gap-1.5 sm:gap-2 pt-0.5">
              <button
                type="button"
                onClick={() => engine_ref.current?.lock_nearest()}
                className="px-2.5 sm:px-3.5 py-2 text-xs font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 border border-white/12 rounded-lg whitespace-nowrap shrink-0"
              >
                Lock Nearest
              </button>
              <button
                type="button"
                onClick={() => engine_ref.current?.cycle_target(1)}
                className="px-2.5 sm:px-3.5 py-2 text-xs font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 border border-white/12 rounded-lg whitespace-nowrap shrink-0"
              >
                Next Bird
              </button>
              <button
                type="button"
                onClick={handle_log_locked}
                className="px-3 sm:px-4 py-2 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg whitespace-nowrap shrink-0"
              >
                Log Sighting
              </button>
              <button
                type="button"
                onClick={() => { set_panel('field'); set_pin_open(true); }}
                className="px-2 sm:px-3 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg whitespace-nowrap shrink-0"
              >
                + Sky Pin
              </button>
            </div>
          </div>

          {/* Right Optics & Species Filter Toolbar */}
          <div className="pointer-events-auto flex items-center justify-between sm:justify-start gap-2 md:gap-3 p-2.5 md:p-3 rounded-xl bg-slate-950/88 border border-white/12 overflow-x-auto">
            {/* Scope Magnification Segmented Control */}
            <div role="group" aria-label="Optical Magnification" className="flex items-center p-0.5 rounded-lg bg-slate-900 border border-white/10 shrink-0">
              {[1, 2, 4].map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => engine_ref.current?.set_zoom(z)}
                  className={`px-2.5 md:px-3 py-1.5 text-xs font-mono font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    hud.zoom === z ? 'bg-amber-400 text-slate-950' : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {z}x
                </button>
              ))}
            </div>

            {/* Meadow 3D vs AR Passthrough Optics Preview */}
            <div role="group" aria-label="Environment Mode" className="flex items-center p-0.5 rounded-lg bg-slate-900 border border-white/10 shrink-0">
              <button
                type="button"
                onClick={() => engine_ref.current?.set_passthrough_sim(false)}
                className={`px-2.5 md:px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  !hud.passthrough_sim ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Meadow 3D
              </button>
              <button
                type="button"
                onClick={() => engine_ref.current?.set_passthrough_sim(true)}
                className={`px-2.5 md:px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  hud.passthrough_sim ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                AR Optics Sim
              </button>
            </div>

            {/* Species Filter */}
            <div className="flex items-center shrink-0">
              <label htmlFor="species-filter" className="sr-only">Filter Species</label>
              <select
                id="species-filter"
                value={species_filter}
                onChange={(e) => {
                  const val = e.target.value;
                  set_species_filter(val);
                  engine_ref.current?.set_filter(val);
                }}
                className="px-2.5 md:px-3 py-1.5 md:py-2 rounded-lg bg-slate-900 border border-white/12 text-xs text-slate-200 max-w-[132px] sm:max-w-none focus-visible:outline-2 focus-visible:outline-amber-400"
              >
                <option value="all">All Species (6)</option>
                {SPECIES.map((s) => (
                  <option key={s.code} value={s.code}>{s.common}</option>
                ))}
              </select>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
