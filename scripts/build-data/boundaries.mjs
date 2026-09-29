// Census tract and county boundaries for the choropleths.
//
// Pre-built so the map draws every boundary same-origin: a viewer whose
// network cannot reach tigerweb.geo.census.gov - or a TIGERweb outage - no
// longer breaks the demographics and insurance layers.
//
// Source, in order:
//  1. Census cartographic boundary files (cb_<year>_*_500k shapefiles). They
//     are clipped to the shoreline, so Puget Sound and the water between the
//     San Juan Islands are not painted as land.
//  2. TIGERweb's generalized (cartographic) map services.
//  3. TIGERweb's detailed layers: legal boundaries that extend over water,
//     only used when neither of the above answers (flagged in the manifest).
//
// Output: data/geo/{counties,tracts}.json - GeoJSON FeatureCollections with
// GEOID, NAME and AREALAND (square metres) per feature.

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fetchJSON, fetchRetry, qs, log, writeJSON, WA_FIPS } from './lib.mjs';

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

/** Douglas-Peucker on one closed ring ([lon, lat] pairs), keeping >= 4 points. */
function simplifyRing(ring, tol) {
  const n = ring.length;
  if (n <= 4 || !tol) return ring;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const t2 = tol * tol;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let best = -1, bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = ring[i];
      let d;
      if (!len2) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring;
}

const round5 = v => Math.round(v * 1e5) / 1e5;

/**
 * Read a zipped shapefile (polygons) with its .dbf attributes, without
 * dependencies. Returns [{ attributes, rings }] with Esri ring orientation
 * (outer rings clockwise), which is also the shapefile convention.
 */
async function readShapefileZip(url, keepRecord) {
  const res = await fetchRetry(url, {}, { retries: 2, timeoutMs: 300000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error(`not a ZIP: ${url}`);
  const dir = await mkdtemp(`${tmpdir()}/shp-`);
  await writeFile(`${dir}/f.zip`, buf);
  execFileSync('unzip', ['-o', '-j', '-q', `${dir}/f.zip`, '-d', dir]);
  const files = await readdir(dir);
  const shpName = files.find(f => /\.shp$/i.test(f)), dbfName = files.find(f => /\.dbf$/i.test(f));
  if (!shpName || !dbfName) throw new Error(`no .shp/.dbf in ${url}`);
  const shp = await readFile(`${dir}/${shpName}`), dbf = await readFile(`${dir}/${dbfName}`);

  // dBASE III: header, 32-byte field descriptors ended by 0x0D, fixed-width records.
  const nRec = dbf.readUInt32LE(4), headLen = dbf.readUInt16LE(8), recLen = dbf.readUInt16LE(10);
  const fields = [];
  for (let o = 32; o < headLen - 1 && dbf[o] !== 0x0d; o += 32) {
    fields.push({ name: dbf.toString('latin1', o, o + 11).replace(/\0.*$/, '').trim(), type: String.fromCharCode(dbf[o + 11]), len: dbf[o + 16] });
  }
  const attrs = [];
  for (let r = 0; r < nRec; r++) {
    let o = headLen + r * recLen + 1; // first byte: deletion flag
    const a = {};
    for (const f of fields) {
      const raw = dbf.toString('latin1', o, o + f.len).trim();
      a[f.name] = f.type === 'N' || f.type === 'F' ? (raw === '' ? null : Number(raw)) : raw;
      o += f.len;
    }
    attrs.push(a);
  }

  // .shp: 100-byte header, then records (big-endian header, little-endian content).
  const out = [];
  let o = 100, idx = 0;
  while (o + 8 <= shp.length) {
    const contentLen = shp.readInt32BE(o + 4) * 2;
    const c = o + 8;
    const type = shp.readInt32LE(c);
    const a = attrs[idx++];
    if ((type === 5 || type === 15 || type === 25) && a && keepRecord(a)) {
      const numParts = shp.readInt32LE(c + 36), numPoints = shp.readInt32LE(c + 40);
      const parts = [];
      for (let i = 0; i < numParts; i++) parts.push(shp.readInt32LE(c + 44 + 4 * i));
      const pts = c + 44 + 4 * numParts;
      const rings = parts.map((start, i) => {
        const end = i + 1 < numParts ? parts[i + 1] : numPoints;
        const ring = [];
        for (let k = start; k < end; k++) ring.push([shp.readDoubleLE(pts + 16 * k), shp.readDoubleLE(pts + 16 * k + 8)]);
        return ring;
      });
      out.push({ attributes: a, rings });
    }
    o = c + contentLen;
  }
  return out;
}

/** Cartographic boundary file for one level, newest vintage first. */
async function cartographic(name, vintage, min) {
  const L = LEVELS[name];
  let lastErr;
  for (const y of [vintage, vintage - 1, vintage - 2, vintage - 3]) {
    const file = name === 'county' ? `cb_${y}_us_county_500k.zip` : `cb_${y}_${WA_FIPS}_tract_500k.zip`;
    const url = `https://www2.census.gov/geo/tiger/GENZ${y}/shp/${file}`;
    try {
      const recs = await readShapefileZip(url, a => String(a.STATEFP) === WA_FIPS);
      const features = [];
      for (const r of recs) {
        const rings = r.rings.map(ring => simplifyRing(ring, L.offset).map(([x, yy]) => [round5(x), round5(yy)]));
        const geometry = toGeoJSON({ rings });
        if (!geometry || !r.attributes.GEOID) continue;
        features.push({ type: 'Feature', properties: { GEOID: r.attributes.GEOID, NAME: r.attributes.NAME, AREALAND: r.attributes.ALAND }, geometry });
      }
      if (features.length < min) throw new Error(`only ${features.length} ${name} features`);
      return { source: file.replace(/\.zip$/, ''), features };
    } catch (err) { lastErr = err; log(`${name} boundaries from ${file}: ${err.message}`); }
  }
  throw lastErr;
}

async function level(name, vintage, min) {
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
      let sampleFields = '';
      for (let offset = 0; ; offset += L.page) {
        // Field names differ between the generalized and detailed services
        // (AREALAND vs ALAND, BASENAME...), so ask for everything and pick.
        // The generalized layers carry GEOID but no STATE field.
        const data = await fetchJSON(`${url}/query?${qs({
          where: /Generalized/.test(root) ? `GEOID LIKE '${WA_FIPS}%'` : `STATE='${WA_FIPS}'`, outFields: '*', returnGeometry: true, outSR: 4326,
          maxAllowableOffset: L.offset, geometryPrecision: 5,
          ...(paged ? { resultRecordCount: L.page, resultOffset: offset } : {}), f: 'json'
        })}`, {}, { retries: 3, timeoutMs: 180000 });
        if (data.error) throw new Error(JSON.stringify(data.error).slice(0, 200));
        if (!sampleFields && data.features && data.features[0]) sampleFields = Object.keys(data.features[0].attributes || {}).join(',');
        for (const f of data.features || []) {
          const geometry = toGeoJSON(f.geometry || {});
          if (!geometry) continue;
          const a = f.attributes;
          const geoid = a.GEOID || a.GEOID20 || a.GEOID10;
          if (!geoid) continue;
          features.push({ type: 'Feature', properties: { GEOID: geoid, NAME: a.NAME || a.BASENAME, AREALAND: a.AREALAND != null ? a.AREALAND : a.ALAND }, geometry });
        }
        if (!paged) { if (data.exceededTransferLimit) throw new Error('transfer limit hit without pagination'); break; }
        if (!(data.features || []).length || (!data.exceededTransferLimit && data.features.length < L.page)) break;
      }
      // An empty or partial answer (e.g. a service without a STATE field)
      // must fall through to the next service, not replace good boundaries.
      if (features.length < min) throw new Error(`only ${features.length} ${name} features (fields: ${sampleFields || 'none returned'})`);
      return { root, features };
    } catch (err) { lastErr = err; log(`${name} boundaries from ${root}: ${err.message}`); }
  }
  throw lastErr;
}

export async function buildBoundaries(outDir) {
  const now = new Date().getUTCFullYear();
  const summary = {};
  for (const [name, min] of [['county', 39], ['tract', 1500]]) {
    let got;
    try { got = await cartographic(name, now - 1, min); }
    catch (err) {
      const { root, features } = await level(name, now - 1, min);
      got = { source: root.split('/').pop(), features };
      // Detailed TIGERweb polygons are legal boundaries that include water.
      if (!/Generalized/.test(root)) { got.includesWater = true; log(`WARNING: ${name} boundaries include water areas (detailed TIGERweb)`); }
    }
    const bytes = await writeJSON(`${outDir}/geo/${name === 'county' ? 'counties' : 'tracts'}.json`, {
      type: 'FeatureCollection', source: got.source, built: new Date().toISOString(), features: got.features
    });
    summary[name] = { features: got.features.length, source: got.source, bytes, ...(got.includesWater ? { includesWater: true } : {}) };
    log(`${name} boundaries: ${got.features.length} from ${got.source} (${(bytes / 1024).toFixed(0)} KB)`);
  }
  return summary;
}
