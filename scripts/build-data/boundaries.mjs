// Census tract and county boundaries for the choropleths.
//
// Pre-built from TIGERweb's generalized (cartographic) layers so the map
// draws every boundary same-origin: a viewer whose network cannot reach
// tigerweb.geo.census.gov - or a TIGERweb outage - no longer breaks the
// demographics and insurance layers.
//
// Output: data/geo/{counties,tracts}.json - GeoJSON FeatureCollections with
// GEOID, NAME and AREALAND (square metres) per feature.

import { fetchJSON, qs, log, writeJSON, WA_FIPS } from './lib.mjs';

const BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services';
const roots = y => [`${BASE}/Generalized_ACS${y}`, `${BASE}/Generalized_ACS${y - 1}`, `${BASE}/Generalized_ACS${y - 2}`, `${BASE}/TIGERweb`];
const LEVELS = {
  county: { service: 'State_County/MapServer', layer: /counties/i, offset: 0.0008, page: 50 },
  tract: { service: 'Tracts_Blocks/MapServer', layer: /census tracts/i, offset: 0.0003, page: 250 }
};

/** Esri polygon (clockwise outer rings, counter-clockwise holes) -> GeoJSON geometry. */
function toGeoJSON(g) {
  const polys = [];
  for (const raw of g.rings || []) {
    // Drop repeated vertices left behind by coordinate rounding.
    const ring = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]);
    if (ring.length < 4) continue;
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) area += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
    if (area >= 0 || !polys.length) polys.push([ring]); // clockwise: a new outer ring
    else polys[polys.length - 1].push(ring);            // counter-clockwise: a hole
  }
  if (!polys.length) return null;
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

async function level(name, vintage) {
  const L = LEVELS[name];
  let lastErr;
  for (const root of roots(vintage)) {
    try {
      const info = await fetchJSON(`${root}/${L.service}?f=json`);
      if (info.error) throw new Error(info.error.message);
      // Skip group layers: they share the name but have no fields to query.
      const layer = (info.layers || []).find(l => L.layer.test(l.name) && !/label/i.test(l.name) && !(l.subLayerIds && l.subLayerIds.length));
      if (!layer) throw new Error(`${name} layer not found among: ${(info.layers || []).map(l => l.name).join(', ')}`);
      const url = `${root}/${L.service}/${layer.id}`;
      const linfo = await fetchJSON(`${url}?f=json`);
      // Without pagination support a server ignores resultOffset, so one
      // request must carry everything.
      const paged = !!(linfo.advancedQueryCapabilities && linfo.advancedQueryCapabilities.supportsPagination);
      const features = [];
      for (let offset = 0; ; offset += L.page) {
        const data = await fetchJSON(`${url}/query?${qs({
          where: `STATE='${WA_FIPS}'`, outFields: 'GEOID,NAME,AREALAND', returnGeometry: true, outSR: 4326,
          maxAllowableOffset: L.offset, geometryPrecision: 5,
          ...(paged ? { orderByFields: 'GEOID', resultRecordCount: L.page, resultOffset: offset } : {}), f: 'json'
        })}`, {}, { retries: 3, timeoutMs: 180000 });
        if (data.error) throw new Error(JSON.stringify(data.error).slice(0, 200));
        for (const f of data.features || []) {
          const geometry = toGeoJSON(f.geometry || {});
          if (!geometry) continue;
          const a = f.attributes;
          features.push({ type: 'Feature', properties: { GEOID: a.GEOID, NAME: a.NAME, AREALAND: a.AREALAND }, geometry });
        }
        if (!paged) { if (data.exceededTransferLimit) throw new Error('transfer limit hit without pagination'); break; }
        if (!(data.features || []).length || (!data.exceededTransferLimit && data.features.length < L.page)) break;
      }
      return { root, features };
    } catch (err) { lastErr = err; log(`${name} boundaries from ${root}: ${err.message}`); }
  }
  throw lastErr;
}

export async function buildBoundaries(outDir) {
  const now = new Date().getUTCFullYear();
  const summary = {};
  for (const [name, min] of [['county', 39], ['tract', 1500]]) {
    const { root, features } = await level(name, now - 1);
    if (features.length < min) throw new Error(`only ${features.length} ${name} boundaries from ${root}`);
    const bytes = await writeJSON(`${outDir}/geo/${name === 'county' ? 'counties' : 'tracts'}.json`, {
      type: 'FeatureCollection', source: root.split('/').pop(), built: new Date().toISOString(), features
    });
    summary[name] = { features: features.length, source: root.split('/').pop(), bytes };
    log(`${name} boundaries: ${features.length} from ${root.split('/').pop()} (${(bytes / 1024).toFixed(0)} KB)`);
  }
  return summary;
}
