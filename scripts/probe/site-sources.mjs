// TEMPORARY probe (removed before merge): inspects the sources the zoning
// layer and the medical site evaluation would use, from GitHub Actions
// (the development sandbox cannot reach them). Prints fields, sample
// records, sizes and the CORS header each answer carries for a browser.
const ORIGIN = 'https://justin-tran1.github.io';
const UA = 'washington-state-demographics source probe (github.com/justin-tran1/washington-state-demographics)';

async function get(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET', body: opts.body,
      headers: Object.assign({ Origin: ORIGIN, 'User-Agent': UA }, opts.headers || {}),
      signal: AbortSignal.timeout(opts.timeout || 90000)
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
const status = (label, r) => line(`[${label}] HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${r.bytes}B${r.error ? ' ERR ' + r.error : ''}${r.json && r.json.error ? ' APIERR ' + short(r.json.error) : ''}`);

const SITES = [
  ['seattle-downtown', 47.6097, -122.3331], ['seattle-capitol-hill', 47.6205, -122.3190],
  ['seattle-first-hill-hospital', 47.6086, -122.3212], ['bellevue-downtown', 47.6150, -122.1950],
  ['black-diamond-sr169', 47.3087, -122.0035], ['black-diamond-ten-trails', 47.3240, -122.0310],
  ['covington', 47.3587, -122.1115], ['auburn', 47.3073, -122.2285], ['unincorporated-king', 47.4300, -122.0500],
  ['kent-valley', 47.4000, -122.2500], ['tacoma', 47.2529, -122.4443], ['spokane', 47.6588, -117.4260],
  ['vancouver', 45.6387, -122.6615], ['yakima', 46.6021, -120.5059], ['rural-okanogan', 48.5000, -119.8000],
  ['everett', 47.9790, -122.2021], ['olympia', 47.0379, -122.9007]
];
const pointParams = (lat, lon, extra = {}) => Object.assign({
  geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
  returnGeometry: false, f: 'json'
}, extra);

function fieldList(L) {
  return (L.fields || []).map(f => {
    let s = `${f.name}:${String(f.type).replace('esriFieldType', '')}`;
    if (f.alias && f.alias !== f.name) s += `("${f.alias}")`;
    if (f.domain && f.domain.codedValues) s += `[${f.domain.codedValues.slice(0, 25).map(c => c.code + '=' + c.name).join('; ')}${f.domain.codedValues.length > 25 ? '; …' : ''}]`;
    return s;
  });
}
async function describeLayer(url, label) {
  const r = await get(url + '?f=json');
  status(label + ' layer', r);
  const L = r.json;
  if (!L || L.error) return null;
  line(`name=${L.name} type=${L.type} geom=${L.geometryType} maxRecordCount=${L.maxRecordCount} formats=${L.supportedQueryFormats}`);
  line(`advancedQuery=${short(L.advancedQueryCapabilities, 400)}`);
  line(`extent=${short(L.extent, 300)}`);
  line(`editingInfo=${short(L.editingInfo)} lastEdit=${L.editingInfo && L.editingInfo.lastEditDate ? new Date(L.editingInfo.lastEditDate).toISOString() : '-'}`);
  line('fields: ' + fieldList(L).join(' | '));
  const rend = L.drawingInfo && L.drawingInfo.renderer;
  if (rend) {
    line(`renderer type=${rend.type} field1=${rend.field1} field2=${rend.field2 || ''} field3=${rend.field3 || ''} fieldDelimiter=${rend.fieldDelimiter || ''}`);
    for (const u of (rend.uniqueValueInfos || []).slice(0, 80)) line(`  uv value=${short(u.value, 80)} label=${short(u.label, 80)} color=${u.symbol && u.symbol.color}`);
    if ((rend.uniqueValueInfos || []).length > 80) line(`  … ${rend.uniqueValueInfos.length} unique values in all`);
  }
  const c = await get(url + '/query?' + qs({ where: '1=1', returnCountOnly: true, f: 'json' }));
  line(`count=${c.json && c.json.count} (HTTP ${c.status}, ACAO=${c.acao || 'MISSING'})`);
  return L;
}
async function distinctValues(url, L, maxList = 90) {
  for (const f of (L.fields || [])) {
    if (!/String|SmallInteger|Integer|Double/.test(f.type) || /^(objectid|fid|shape|globalid)/i.test(f.name)) continue;
    const r = await get(url + '/query?' + qs({ where: '1=1', outFields: f.name, returnDistinctValues: true, returnGeometry: false,
      orderByFields: f.name, resultRecordCount: 2000, f: 'json' }));
    const vals = r.json && r.json.features ? r.json.features.map(x => x.attributes[f.name]) : null;
    if (!vals) { line(`  distinct ${f.name}: HTTP ${r.status} ${short(r.json && r.json.error)}`); continue; }
    line(`  distinct ${f.name} (${vals.length}${r.json.exceededTransferLimit ? '+' : ''}): ${vals.slice(0, maxList).map(v => short(v, 70)).join(' ¦ ')}${vals.length > maxList ? ' ¦ …' : ''}`);
  }
}
async function groupCounts(url, field) {
  const r = await get(url + '/query?' + qs({ where: '1=1', groupByFieldsForStatistics: field,
    outStatistics: [{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }], f: 'json' }));
  if (!r.json || !r.json.features) { line(`  group ${field}: HTTP ${r.status} ${short(r.json && r.json.error)}`); return; }
  const rows = r.json.features.map(x => x.attributes).sort((a, b) => b.n - a.n);
  line(`  group ${field}: ` + rows.slice(0, 60).map(a => `${short(a[field], 60)}=${a.n}`).join(' ¦ '));
}

// ---------------------------------------------------------------- WAZA
H('WAZA item');
const item = await get('https://www.arcgis.com/sharing/rest/content/items/743c0f2e1c1b4a438452c4d40ff53d74?f=json');
status('item', item);
const I = item.json || {};
line(`title=${I.title} type=${I.type} url=${I.url} owner=${I.owner} created=${I.created && new Date(I.created).toISOString()} modified=${I.modified && new Date(I.modified).toISOString()}`);
line(`typeKeywords=${short(I.typeKeywords, 300)}`);
line(`snippet=${short(I.snippet, 400)}`);
line(`accessInformation=${short(I.accessInformation, 400)}`);
line(`licenseInfo=${short(String(I.licenseInfo || '').replace(/<[^>]+>/g, ' '), 900)}`);
line(`description=${short(String(I.description || '').replace(/<[^>]+>/g, ' '), 2500)}`);
const WAZA = I.url;
if (WAZA) {
  H('WAZA service');
  const svc = await get(WAZA + '?f=json');
  status('service', svc);
  const S = svc.json || {};
  line(`capabilities=${S.capabilities} maxRecordCount=${S.maxRecordCount} formats=${S.supportedQueryFormats} layers=${short((S.layers || []).map(l => l.id + ':' + l.name))} tables=${short((S.tables || []).map(l => l.id + ':' + l.name))}`);
  line(`serviceDescription=${short(S.serviceDescription, 600)} copyright=${short(S.copyrightText, 300)}`);
  const layers = {};
  for (const l of (S.layers || []).concat(S.tables || [])) {
    H('WAZA layer ' + l.id + ' ' + l.name);
    const L = await describeLayer(WAZA + '/' + l.id, 'waza' + l.id);
    if (!L) continue;
    layers[l.id] = L;
    await distinctValues(WAZA + '/' + l.id, L);
  }
  // Point lookups: every layer, every attribute (WAZA holds no personal data).
  for (const [name, lat, lon] of SITES) {
    H('WAZA at ' + name);
    for (const id of Object.keys(layers)) {
      if (layers[id].type === 'Table') continue;
      const r = await get(WAZA + '/' + id + '/query?' + qs(pointParams(lat, lon, { outFields: '*' })));
      const feats = r.json && r.json.features;
      line(`layer ${id} (${layers[id].name}): HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms n=${feats ? feats.length : '?'} ${feats ? '' : short(r.json && r.json.error)}`);
      for (const f of (feats || []).slice(0, 6)) line('   ' + short(f.attributes, 1600));
    }
  }
  // Payload sizes for drawing: a ~2 km and a ~8 km view in Seattle.
  H('WAZA drawing payloads');
  for (const [label, d, off] of [['2km z15', 0.012, 0.00002], ['5km z14', 0.03, 0.00004], ['10km z13', 0.06, 0.00008], ['20km z12', 0.12, 0.00015]]) {
    const env = `${-122.33 - d},${47.61 - d * 0.67},${-122.33 + d},${47.61 + d * 0.67}`;
    const r = await get(WAZA + '/0/query?' + qs({ geometry: env, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
      outFields: 'OBJECTID', returnGeometry: true, outSR: 4326, geometryPrecision: 6, maxAllowableOffset: off, f: 'geojson', resultRecordCount: 2000 }));
    line(`${label}: HTTP ${r.status} ${r.ms}ms ${r.bytes}B features=${r.json && r.json.features ? r.json.features.length : '?'} exceeded=${r.json && (r.json.exceededTransferLimit || (r.json.properties && r.json.properties.exceededTransferLimit))}`);
    const p = await get(WAZA + '/0/query?' + qs({ geometry: env, geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects',
      outFields: 'OBJECTID', returnGeometry: true, outSR: 4326, maxAllowableOffset: off, quantizationParameters: { mode: 'view', originPosition: 'upperLeft', tolerance: off, extent: { xmin: -122.33 - d, ymin: 47.61 - d * 0.67, xmax: -122.33 + d, ymax: 47.61 + d * 0.67, spatialReference: { wkid: 4326 } } }, f: 'pbf', resultRecordCount: 2000 }));
    line(`${label} pbf: HTTP ${p.status} ${p.ms}ms ${p.bytes}B ctype=${p.ctype}`);
  }
}

// ---------------------------------------------------------------- local services for comparison
H('Seattle zoning (city service)');
const SEA = 'https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Current_Land_Use_Zoning_Detail_2/FeatureServer/0';
const seaL = await describeLayer(SEA, 'seattle');
for (const [name, lat, lon] of SITES.filter(s => /^seattle/.test(s[0]))) {
  const r = await get(SEA + '/query?' + qs(pointParams(lat, lon, { outFields: '*' })));
  line(`${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ` + short(r.json && r.json.features && r.json.features.map(f => f.attributes), 1500));
}
H('King County planning services');
const kc = await get('https://gisdata.kingcounty.gov/arcgis/rest/services/OpenDataPortal/planning___base/MapServer?f=json');
status('kc planning', kc);
line(short((kc.json && kc.json.layers || []).map(l => l.id + ':' + l.name), 3000));

H('ArcGIS Online zoning services in Washington (discovery)');
for (const start of [1, 101, 201]) {
  const r = await get('https://www.arcgis.com/sharing/rest/search?' + qs({ q: 'zoning type:"Feature Service" access:public', bbox: '-124.85,45.53,-116.9,49.01',
    num: 100, start, sortField: 'numviews', sortOrder: 'desc', f: 'json' }));
  if (!r.json || !r.json.results) { status('search', r); break; }
  for (const x of r.json.results) {
    const ext = x.extent && x.extent.length === 2 ? x.extent.flat().map(v => v.toFixed(2)).join(',') : '';
    line(`  ${x.title} | owner=${x.owner} | views=${x.numViews} | mod=${new Date(x.modified).toISOString().slice(0, 10)} | ext=${ext} | ${x.url}`);
  }
  if (!r.json.nextStart || r.json.nextStart < 0) break;
}

// ---------------------------------------------------------------- parcels
H('Statewide parcels');
const PAR = 'https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer';
const parSvc = await get(PAR + '?f=json');
status('parcels service', parSvc);
line(short(parSvc.json && { layers: parSvc.json.layers, tables: parSvc.json.tables, desc: parSvc.json.serviceDescription }, 1500));
const parL = await describeLayer(PAR + '/0', 'parcels0');
for (const id of [1, 2]) {
  const r = await get(PAR + '/' + id + '/query?' + qs({ where: '1=1', outFields: '*', returnGeometry: false, resultRecordCount: 50, f: 'json' }));
  line(`parcels layer ${id}: HTTP ${r.status} n=${r.json && r.json.features ? r.json.features.length : '?'} ` + short(r.json && r.json.features && r.json.features.map(f => f.attributes), 2500));
}
if (parL) {
  // Never owner or taxpayer fields: only parcel identity, size, use, value and links.
  const safe = (parL.fields || []).map(f => f.name).filter(n => !/owner|taxpayer|name|mail|contact|phone|email/i.test(n) || /land_?use|use_?name|county_?name/i.test(n));
  line('safe outFields: ' + safe.join(','));
  for (const [name, lat, lon] of SITES) {
    const r = await get(PAR + '/0/query?' + qs(pointParams(lat, lon, { outFields: safe.join(','), returnGeometry: true, outSR: 4326, geometryPrecision: 6, f: 'geojson' })));
    const f = r.json && r.json.features && r.json.features[0];
    let acres = null;
    if (f && f.geometry) {
      const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map(p => p[0]) : [];
      let m2 = 0;
      for (const ring of rings) {
        let s = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
          s += (x2 - x1) * Math.PI / 180 * (2 + Math.sin(y1 * Math.PI / 180) + Math.sin(y2 * Math.PI / 180));
        }
        m2 += Math.abs(s * 6371008.8 * 6371008.8 / 2);
      }
      acres = (m2 / 4046.86).toFixed(3);
    }
    line(`${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms acres=${acres} ` + short(f && f.properties, 1200));
  }
}

// ---------------------------------------------------------------- WSDOT traffic
H('WSDOT traffic data');
const TD = 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/FeatureServer';
const tdSvc = await get(TD + '?f=json');
status('traffic service', tdSvc);
line(short(tdSvc.json && tdSvc.json.layers, 800));
for (const id of [0, 1]) await describeLayer(TD + '/' + id, 'traffic' + id);
for (const [name, lat, lon] of SITES.slice(0, 12)) {
  for (const id of [0, 1]) {
    const r = await get(TD + '/' + id + '/query?' + qs(pointParams(lat, lon, { distance: 300, units: 'esriSRUnit_Meter', outFields: '*' })));
    line(`${name} layer${id}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} n=${r.json && r.json.features ? r.json.features.length : '?'} ` + short(r.json && r.json.features && r.json.features.slice(0, 3).map(f => f.attributes), 900));
  }
}

// ---------------------------------------------------------------- elevation
H('Elevation');
for (const [name, lat, lon] of SITES.slice(0, 6)) {
  const r = await get(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Feet&includeDate=false`);
  line(`EPQS ${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${short(r.text, 300)}`);
}
{
  const lats = SITES.slice(0, 6).map(s => s[1]).join(','), lons = SITES.slice(0, 6).map(s => s[2]).join(',');
  const r = await get(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
  line(`open-meteo: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${short(r.text, 300)}`);
}

// ---------------------------------------------------------------- FEMA
H('FEMA NFHL');
const NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const nf = await get(NFHL + '?f=json');
status('nfhl service', nf);
line(short(nf.json && (nf.json.layers || []).map(l => l.id + ':' + l.name), 1500));
for (const [name, lat, lon] of SITES.slice(0, 12)) {
  const r = await get(NFHL + '/28/query?' + qs(pointParams(lat, lon, { outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DFIRM_ID,EFF_DATE' })));
  line(`${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${short(r.json && (r.json.features ? r.json.features.map(f => f.attributes) : r.json.error), 500)}`);
}

// ---------------------------------------------------------------- Overpass
H('Overpass');
async function overpass(ql, label) {
  const r = await get('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(ql),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const els = r.json && r.json.elements;
  const kinds = {};
  for (const e of (els || [])) {
    const t = e.tags || {};
    const k = t.amenity === 'parking' ? 'parking' : t.social_facility ? 'shelter' : t.highway === 'motorway_junction' ? 'junction' : t.highway ? 'road:' + t.highway : 'other';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  line(`${label}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${r.bytes}B elements=${els ? els.length : '?'} ${JSON.stringify(kinds)} ${els ? '' : short(r.text, 300)}`);
  return els || [];
}
for (const [name, lat, lon] of [SITES[4], SITES[0], SITES[8]]) {
  const els = await overpass(`[out:json][timeout:40];
(way["amenity"="parking"](around:250,${lat},${lon});relation["amenity"="parking"](around:250,${lat},${lon}););out tags geom;
nwr["social_facility"="shelter"](around:3000,${lat},${lon});out tags center;
way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](around:800,${lat},${lon});out tags geom;
node["highway"="motorway_junction"](around:8000,${lat},${lon});out tags;`, name);
  for (const e of els.filter(e => e.tags && e.tags.amenity === 'parking').slice(0, 8)) line('   parking ' + short(e.tags, 300) + ' pts=' + (e.geometry ? e.geometry.length : e.members ? 'rel' : '?'));
  for (const e of els.filter(e => e.tags && e.tags.social_facility).slice(0, 8)) line('   shelter ' + short(e.tags, 400));
  for (const e of els.filter(e => e.tags && e.tags.highway && e.tags.highway !== 'motorway_junction').slice(0, 10)) line('   road ' + short({ highway: e.tags.highway, name: e.tags.name, ref: e.tags.ref, lanes: e.tags.lanes, maxspeed: e.tags.maxspeed }, 200));
}
{
  const els = await overpass(`[out:json][timeout:60];nwr["social_facility"="shelter"](45.53,-124.85,49.01,-116.9);out tags center;`, 'shelters statewide');
  const byFor = {};
  for (const e of els) { const k = (e.tags || {})['social_facility:for'] || '(none)'; byFor[k] = (byFor[k] || 0) + 1; }
  line('   social_facility:for ' + JSON.stringify(byFor));
  const parkingCap = await overpass(`[out:json][timeout:60];way["amenity"="parking"](47.25,-122.45,47.75,-121.95);out tags;`, 'parking tags (Seattle-Bellevue-Kent box)');
  const withCap = parkingCap.filter(e => e.tags && e.tags.capacity).length;
  const byType = {};
  for (const e of parkingCap) { const k = (e.tags || {}).parking || '(none)'; byType[k] = (byType[k] || 0) + 1; }
  line(`   parking with capacity tag: ${withCap}/${parkingCap.length} parking=${JSON.stringify(byType)}`);
}
line('\nprobe done');
