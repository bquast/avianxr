/* Cloudflare Pages Function: GET /api/sightings?lat=37.8044&lng=-122.2712
 * Optional on CF Pages (uses EBIRD_API_KEY if set, else public iNaturalist Aves API).
 * Static gh-pages classic builds ignore /functions and call iNaturalist / local seed directly.
 */

interface PagesContext {
  request: Request;
  env: Record<string, string | undefined>;
}

interface OutObs {
  code: string;
  common: string;
  sci: string;
  count: number;
  lat: number;
  lng: number;
  loc: string;
  time: string;
}

function map_species_code(common: string, sci: string): string {
  const s = `${common} ${sci}`.toLowerCase();
  if (s.includes('kestrel')) return 'amekes';
  if (s.includes('red-tailed') || s.includes('buteo')) return 'rethaw';
  if (s.includes('peregrine') || s.includes('peregrinus')) return 'perfal';
  if (s.includes('heron') || s.includes('egret')) return 'grbher3';
  if (s.includes('swallow') || s.includes('swift')) return 'barswa';
  return 'amegfi';
}

export async function onRequestGet(ctx: PagesContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const lat = Math.max(-85, Math.min(85, Number(url.searchParams.get('lat') || '37.8044')));
  const lng = Math.max(-180, Math.min(180, Number(url.searchParams.get('lng') || '-122.2712')));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=180',
  };

  const ebird_key = ctx.env?.EBIRD_API_KEY;
  if (ebird_key) {
    const eb_url = `https://api.ebird.org/v2/data/obs/geo/recent?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&dist=15&maxResults=10`;
    const r = await fetch(eb_url, {headers: {'X-eBirdApiToken': ebird_key}});
    if (r.ok) {
      const raw = (await r.json()) as Array<Record<string, unknown>>;
      const items: OutObs[] = raw.map((o) => {
        const common = String(o.comName || 'Unknown Bird');
        const sci = String(o.sciName || 'Aves sp.');
        return {
          code: map_species_code(common, sci),
          common,
          sci,
          count: Number(o.howMany || 1),
          lat: Number(o.lat || lat),
          lng: Number(o.lng || lng),
          loc: String(o.locName || 'Nearby Field'),
          time: String(o.obsDt || '').slice(-5) || 'Recent',
        };
      });
      return new Response(JSON.stringify({source: 'ebird-cf', items}), {headers});
    }
  }

  const inat_url = `https://api.inaturalist.org/v1/observations?iconic_taxa=Aves&lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&radius=20&per_page=10&order=desc&order_by=created_at`;
  const r = await fetch(inat_url, {headers: {'Accept': 'application/json'}});
  if (r.ok) {
    const data = (await r.json()) as {results?: Array<Record<string, unknown>>};
    const results = data.results || [];
    const items: OutObs[] = results.map((o) => {
      const taxon = (o.taxon || {}) as Record<string, unknown>;
      const common = String(taxon.preferred_common_name || 'Wild Bird');
      const sci = String(taxon.name || 'Aves sp.');
      const geo = String(o.geojson ? '' : o.location || `${lat},${lng}`).split(',');
      return {
        code: map_species_code(common, sci),
        common,
        sci,
        count: 1,
        lat: Number(geo[0] || lat),
        lng: Number(geo[1] || lng),
        loc: String(o.place_guess || 'Local Sector'),
        time: String(o.time_observed_at || '').slice(11, 16) || 'Recent',
      };
    });
    return new Response(JSON.stringify({source: 'inaturalist-cf', items}), {headers});
  }

  return new Response(JSON.stringify({source: 'cf-empty', items: []}), {headers});
}
