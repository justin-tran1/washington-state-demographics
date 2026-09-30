// TEMPORARY probe (removed before merge), round 2: jurisdictions the zoning
// atlas has no zones for and their own zoning services, WAZA category counts,
// FEMA flood zones, a leaner Overpass query and a 10/15/20-minute isochrone.
const ORIGIN = 'https://justin-tran1.github.io';
const UA = 'washington-state-demographics source probe (github.com/justin-tran1/washington-state-demographics)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET', body: opts.body,
      headers: Object.assign({ Origin: ORIGIN, 'User-Agent': UA }, opts.headers || {}),
      signal: AbortSignal.timeout(opts.timeout || 60000)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, acao: res.headers.get('access-control-allow-origin'), ctype: res.headers.get('content-type'), text, json, ms: Date.now() - t0, bytes: text.length };
  } catch (e) {
    return { status: 0, error: String(e), ms: Date.now() - t0, text: '', json: null, bytes: 0 };
  }
}
const qs = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)).join('&');
const short = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };
const H = t => console.log('\n=== ' + t + ' ===');
const line = (...a) => console.log(a.join(' '));
const WAZA = 'https://services6.arcgis.com/tboeqGwETr5ppr5Q/arcgis/rest/services/WAZA_Prototype_Layers/FeatureServer';

// ---------------------------------------------------------------- WAZA stats
H('WAZA zone statistics');
async function groupCounts(field, where = '1=1') {
  const r = await get(WAZA + '/0/query?' + qs({ where, groupByFieldsForStatistics: field,
    outStatistics: [{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }], f: 'json' }));
  if (!r.json || !r.json.features) { line(`group ${field}: HTTP ${r.status} ${short(r.json && r.json.error)}`); return []; }
  return r.json.features.map(x => x.attributes).sort((a, b) => b.n - a.n);
}
for (const f of ['WAZAZoneGeneral', 'WAZAZoneSpecific', 'UseOffice', 'UseRetail']) {
  const rows = await groupCounts(f);
  line(`by ${f}: ` + rows.map(a => `${a[f]}=${a.n}`).join(' ¦ '));
}
for (const g of ['COM', 'MXU', 'IND', 'PUB', 'MR', 'LIR', 'RUR', 'NRL', 'OS', 'UND', 'UNK']) {
  const rows = await groupCounts('UseOffice', `WAZAZoneGeneral='${g}'`);
  line(`UseOffice within ${g}: ` + rows.map(a => `${a.UseOffice}=${a.n}`).join(' ¦ '));
}
{
  const nullGen = await groupCounts('Jurisdiction', 'WAZAZoneGeneral IS NULL');
  line('zones without a general class, by jurisdiction: ' + nullGen.slice(0, 40).map(a => `${a.Jurisdiction}=${a.n}`).join(' ¦ '));
  const combos = await get(WAZA + '/0/query?' + qs({ where: '1=1', outFields: 'GEOID,ZoneID', returnDistinctValues: true, returnCountOnly: true, f: 'json' }));
  line('distinct (GEOID, ZoneID): ' + short(combos.json, 200));
  const combos2 = await get(WAZA + '/0/query?' + qs({ where: '1=1', outFields: 'GEOID,ZoneID,ZoneName,WAZAZoneGeneral,WAZAZoneSpecific,UseOffice,UseRetail', returnDistinctValues: true, returnCountOnly: true, f: 'json' }));
  line('distinct (GEOID, ZoneID, name, classes, office, retail): ' + short(combos2.json, 200));
}

// ---------------------------------------------------------------- missing jurisdictions
H('Jurisdictions without zones');
const zonesByGeoid = new Map((await groupCounts('GEOID')).map(a => [a.GEOID, a.n]));
line(`jurisdictions with zones: ${zonesByGeoid.size}`);
const jr = await get(WAZA + '/2/query?' + qs({ where: '1=1', outFields: 'GEOID,Jurisdiction,COUNTYNAME,SpatialSource,ZoningGISURL,ZoneIDField,CodeURL,ZoningFileURL,WAZACODEADOPTIONDATE',
  returnGeometry: true, outSR: 4326, maxAllowableOffset: 0.002, geometryPrecision: 4, f: 'geojson', resultRecordCount: 400 }));
const juris = (jr.json && jr.json.features) || [];
line(`jurisdictions: ${juris.length} (HTTP ${jr.status}, ${jr.bytes}B)`);
function interiorPoint(geom) {
  // Centre of the largest ring's bounding box, nudged to a vertex average if outside.
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let best = null, bestA = -1;
  for (const p of polys) {
    const ring = p[0];
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = ring; }
  }
  const inside = (x, y) => { let c = false; for (let i = 0, j = best.length - 1; i < best.length; j = i++) { const [xi, yi] = best[i], [xj, yj] = best[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  let xs = best.map(p => p[0]), ys = best.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  if (inside(cx, cy)) return [cx, cy];
  // scan a grid for an inside point
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  for (let k = 1; k < 12; k++) for (let i = 1; i < k; i++) for (let j = 1; j < k; j++) {
    const x = x0 + (x1 - x0) * i / k, y = y0 + (y1 - y0) * j / k;
    if (inside(x, y)) return [x, y];
  }
  return [cx, cy];
}
const missing = juris.filter(f => !zonesByGeoid.has(f.properties.GEOID));
line(`without zones: ${missing.length}`);
for (const f of missing) {
  const p = f.properties;
  const [x, y] = f.geometry ? interiorPoint(f.geometry) : [null, null];
  line(`\n-- ${p.Jurisdiction} (${p.GEOID}, ${p.COUNTYNAME}) source=${p.SpatialSource} zoneField=${p.ZoneIDField} adopted=${p.WAZACODEADOPTIONDATE ? new Date(p.WAZACODEADOPTIONDATE).toISOString().slice(0, 10) : '-'} pt=${x && x.toFixed(4)},${y && y.toFixed(4)}`);
  line(`   gis=${p.ZoningGISURL || '-'}  file=${p.ZoningFileURL || '-'}  code=${p.CodeURL || '-'}`);
  const url = String(p.ZoningGISURL || '').trim().replace(/\/+$/, '');
  if (!/\/(MapServer|FeatureServer)\/\d+$/i.test(url)) continue;
  const L = await get(url + '?f=json', { timeout: 30000 });
  const li = L.json || {};
  line(`   layer: HTTP ${L.status} ACAO=${L.acao || 'MISSING'} ${L.ms}ms name=${li.name} geom=${li.geometryType} maxRec=${li.maxRecordCount} formats=${li.supportedQueryFormats} ${li.error ? 'ERR ' + short(li.error) : ''}`);
  if (!li.fields) continue;
  line('   fields: ' + li.fields.map(f2 => f2.name + ':' + String(f2.type).replace('esriFieldType', '') + (f2.alias && f2.alias !== f2.name ? '("' + f2.alias + '")' : '') + (f2.domain && f2.domain.codedValues ? '[' + f2.domain.codedValues.slice(0, 30).map(c => c.code + '=' + c.name).join('; ') + ']' : '')).join(' | ').slice(0, 2500));
  const zf = p.ZoneIDField && li.fields.find(f2 => f2.name.toLowerCase() === String(p.ZoneIDField).toLowerCase()) ? li.fields.find(f2 => f2.name.toLowerCase() === String(p.ZoneIDField).toLowerCase()).name : null;
  const cnt = await get(url + '/query?' + qs({ where: '1=1', returnCountOnly: true, f: 'json' }), { timeout: 30000 });
  line(`   count=${cnt.json && cnt.json.count} ACAO=${cnt.acao || 'MISSING'}`);
  if (zf) {
    const d = await get(url + '/query?' + qs({ where: '1=1', outFields: zf, returnDistinctValues: true, returnGeometry: false, orderByFields: zf, f: 'json' }), { timeout: 30000 });
    const vals = d.json && d.json.features ? d.json.features.map(x2 => x2.attributes[zf]) : null;
    line(`   distinct ${zf} (${vals ? vals.length : '?'}): ${vals ? vals.map(v => short(v, 50)).join(' ¦ ').slice(0, 1500) : short(d.json && d.json.error)}`);
  }
  const sample = await get(url + '/query?' + qs({ where: '1=1', outFields: '*', returnGeometry: false, resultRecordCount: 3, f: 'json' }), { timeout: 30000 });
  line('   sample: ' + short(sample.json && sample.json.features && sample.json.features.map(x2 => x2.attributes), 1500));
  if (x != null) {
    const pt = await get(url + '/query?' + qs({ geometry: `${x},${y}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
      outFields: zf || '*', returnGeometry: false, f: 'json' }), { timeout: 30000 });
    line(`   at interior point: HTTP ${pt.status} ACAO=${pt.acao || 'MISSING'} ${short(pt.json && (pt.json.features ? pt.json.features.map(x2 => x2.attributes) : pt.json.error), 400)}`);
    const gj = await get(url + '/query?' + qs({ geometry: `${x - 0.01},${y - 0.007},${x + 0.01},${y + 0.007}`, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
      outFields: zf || '*', returnGeometry: true, outSR: 4326, geometryPrecision: 5, f: 'geojson' }), { timeout: 30000 });
    line(`   geojson envelope: HTTP ${gj.status} ACAO=${gj.acao || 'MISSING'} ${gj.bytes}B features=${gj.json && gj.json.features ? gj.json.features.length : '?'} ${gj.json && gj.json.error ? short(gj.json.error) : ''}`);
  }
}

// ---------------------------------------------------------------- FEMA
H('FEMA NFHL (fixed fields)');
const NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28';
const nfl = await get(NFHL + '?f=json');
line(`layer: HTTP ${nfl.status} ACAO=${nfl.acao || 'MISSING'} fields=${short(nfl.json && nfl.json.fields && nfl.json.fields.map(f => f.name), 800)}`);
const FSITES = [['kent-valley', 47.4, -122.25], ['auburn-green-river', 47.29, -122.22], ['black-diamond', 47.3087, -122.0035], ['seattle-downtown', 47.6097, -122.3331], ['snoqualmie', 47.53, -121.83], ['yakima', 46.6021, -120.5059]];
for (const [name, lat, lon] of FSITES) {
  for (const extra of [{ outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE' }, { outFields: '*' }]) {
    const r = await get(NFHL + '/query?' + qs(Object.assign({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', returnGeometry: false, f: 'json' }, extra)));
    line(`${name} ${extra.outFields.slice(0, 12)}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${short(r.json && (r.json.features ? r.json.features.map(f => f.attributes) : r.json.error), 400)}`);
  }
}
const LA = 'https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Flood_Hazard_Reduced_Set_gdb/FeatureServer';
const las = await get(LA + '?f=json');
line(`living atlas flood: HTTP ${las.status} ACAO=${las.acao || 'MISSING'} layers=${short(las.json && las.json.layers && las.json.layers.map(l => l.id + ':' + l.name), 300)}`);
const lal = await get(LA + '/0?f=json');
line(`   layer0 fields=${short(lal.json && lal.json.fields && lal.json.fields.map(f => f.name), 600)}`);
for (const [name, lat, lon] of FSITES) {
  const r = await get(LA + '/0/query?' + qs({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', outFields: '*', returnGeometry: false, f: 'json' }));
  line(`   ${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${short(r.json && (r.json.features ? r.json.features.map(f => f.attributes) : r.json.error), 400)}`);
}

// ---------------------------------------------------------------- Overpass (lean)
H('Overpass lean site query');
const OSITES = [['seattle-downtown', 47.6097, -122.3331], ['black-diamond', 47.3087, -122.0035], ['covington', 47.3587, -122.1115]];
function box(lat, lon, m) {
  const dLat = m / 111320, dLon = m / (111320 * Math.cos(lat * Math.PI / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map(v => v.toFixed(5)).join(',');
}
for (const [name, lat, lon] of OSITES) {
  const ql = `[out:json][timeout:25];
way["amenity"="parking"](around:200,${lat},${lon});out tags geom;
nwr["social_facility"="shelter"](around:3219,${lat},${lon});out tags center;
way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"](around:500,${lat},${lon});out tags geom(${box(lat, lon, 520)});
way["highway"="tertiary"](around:160,${lat},${lon});out tags geom(${box(lat, lon, 180)});
node["highway"="motorway_junction"](around:8047,${lat},${lon});out tags;
way["building"](around:40,${lat},${lon});out tags geom;`;
  const r = await get('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(ql), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const els = (r.json && r.json.elements) || [];
  const k = {};
  for (const e of els) { const t = e.tags || {}; const key = t.amenity === 'parking' ? 'parking' : t.social_facility ? 'shelter:' + (t['social_facility:for'] || '-') : t.highway === 'motorway_junction' ? 'junction' : t.highway ? t.highway : t.building ? 'building' : 'other'; k[key] = (k[key] || 0) + 1; }
  line(`${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${r.bytes}B elements=${els.length} ${JSON.stringify(k)} ${r.json ? '' : short(r.text, 200)}`);
  for (const e of els.filter(e2 => e2.tags && e2.tags.building).slice(0, 5)) line('   building ' + short(e.tags, 200) + ' pts=' + (e.geometry ? e.geometry.length : '?'));
  await sleep(5000);
}

// ---------------------------------------------------------------- Valhalla
H('Valhalla 10/15/20 minutes');
for (const [name, lat, lon] of OSITES.slice(1)) {
  const r = await get('https://valhalla1.openstreetmap.de/isochrone', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: [{ lat, lon }], costing: 'auto', contours: [{ time: 10 }, { time: 15 }, { time: 20 }], polygons: true, denoise: 0.35, generalize: 60 }) });
  line(`${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${r.bytes}B contours=${short(r.json && r.json.features && r.json.features.map(f => f.properties.contour), 100)} ${r.json && r.json.error ? short(r.json) : ''}`);
}
line('\nprobe done');
