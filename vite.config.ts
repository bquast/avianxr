import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

const FALLBACK_OBS = [
  {code: 'amekes', common: 'American Kestrel', sci: 'Falco sparverius', count: 2, lat: 37.8044, lng: -122.2712, loc: 'Coastal Meadow Ridge', time: '08:05'},
  {code: 'rethaw', common: 'Red-tailed Hawk', sci: 'Buteo jamaicensis', count: 1, lat: 37.8089, lng: -122.2681, loc: 'North Thermal Bluff', time: '07:52'},
  {code: 'perfal', common: 'Peregrine Falcon', sci: 'Falco peregrinus', count: 1, lat: 37.8015, lng: -122.2755, loc: 'Estuary Pylon', time: '07:41'},
  {code: 'grbher3', common: 'Great Blue Heron', sci: 'Ardea herodias', count: 3, lat: 37.7992, lng: -122.2698, loc: 'Tidal Marsh Flats', time: '07:30'},
  {code: 'barswa', common: 'Barn Swallow', sci: 'Hirundo rustica', count: 6, lat: 37.8031, lng: -122.2734, loc: 'Timber Boathouse', time: '07:18'},
  {code: 'amegfi', common: 'American Goldfinch', sci: 'Spinus tristis', count: 4, lat: 37.8058, lng: -122.2704, loc: 'Thistle Field Margin', time: '07:04'},
];

export default defineConfig(() => {
  return {
    base: './',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'local-cf-pages-api-shim',
        configureServer(server) {
          server.middlewares.use('/api/sightings', (req, res) => {
            const url = new URL(req.url || '/', 'http://localhost:3000');
            const lat = Number(url.searchParams.get('lat') || '37.8044');
            const lng = Number(url.searchParams.get('lng') || '-122.2712');
            const items = FALLBACK_OBS.map((o, i) => ({
              ...o,
              lat: Number((lat + (i - 2.5) * 0.0021).toFixed(4)),
              lng: Number((lng + ((i % 3) - 1) * 0.0028).toFixed(4)),
            }));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({source: 'local-shim', items}));
          });
        },
      },
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
