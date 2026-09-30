// TEMPORARY probe (removed before merge), round 3: WSDOT functional class,
// WAZA gaps at street rights-of-way, the cities' own zoning services behind
// the atlas (browser access), and a lighter Overpass query.
const ORIGIN = 'https://justin-tran1.github.io';
const UA = 'washington-state-demographics source probe (github.com/justin-tran1/washington-state-demographics)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET', body: opts.body,
      headers: Object.assign({ Origin: ORIGIN, 'User-Agent': UA }, opts.headers || {}),
      signal: AbortSignal.timeout(opts.timeout || 45000)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not json */ }
    return { status: res.status, acao: res.headers.get('access-control-allow-origin'), text, json, ms: Date.now() - t0, bytes: text.length };
  } catch (e) {
    return { status: 0, error: String(e), ms: Date.now() - t0, text: '', json: null, bytes: 0 };
  }
}
const qs = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : v)).join('&');
const short = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };
const H = t => console.log('\n=== ' + t + ' ===');
const line = (...a) => console.log(a.join(' '));
const WAZA = 'https://services6.arcgis.com/tboeqGwETr5ppr5Q/arcgis/rest/services/WAZA_Prototype_Layers/FeatureServer';
const pt = (lat, lon, extra = {}) => Object.assign({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326,
  spatialRel: 'esriSpatialRelIntersects', returnGeometry: false, f: 'json' }, extra);

// ---------------------------------------------------------------- WSDOT functional class
H('WSDOT functional class');
const FC = 'https://data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass';
const folder = await get(FC + '?f=json');
line(`folder: HTTP ${folder.status} ACAO=${folder.acao || 'MISSING'} services=${short(folder.json && folder.json.services, 600)}`);
for (const svc of ['WSDOTFunctionalClassData/FeatureServer', 'WSDOTFunctionalClassData/MapServer']) {
  const s = await get(`${FC}/${svc}?f=json`);
  line(`${svc}: HTTP ${s.status} ACAO=${s.acao || 'MISSING'} layers=${short(s.json && s.json.layers && s.json.layers.map(l => l.id + ':' + l.name + (l.subLayerIds ? '[group]' : '')), 900)}`);
}
const FCS = FC + '/WSDOTFunctionalClassData/FeatureServer';
const fcSvc = await get(FCS + '?f=json');
const fcLayers = ((fcSvc.json && fcSvc.json.layers) || []).filter(l => !l.subLayerIds);
for (const l of fcLayers.slice(0, 8)) {
  const L = await get(`${FCS}/${l.id}?f=json`);
  const li = L.json || {};
  line(`\n layer ${l.id} ${li.name}: geom=${li.geometryType} maxRec=${li.maxRecordCount} formats=${li.supportedQueryFormats}`);
  line('   fields: ' + (li.fields || []).map(f => f.name + ':' + String(f.type).replace('esriFieldType', '') + (f.alias && f.alias !== f.name ? '("' + f.alias + '")' : '') +
    (f.domain && f.domain.codedValues ? '[' + f.domain.codedValues.slice(0, 20).map(c => c.code + '=' + c.name).join('; ') + ']' : '')).join(' | ').slice(0, 2200));
  for (const [name, lat, lon] of [['black-diamond-sr169', 47.3087, -122.0035], ['covington', 47.3587, -122.1115], ['seattle-capitol-hill', 47.6205, -122.3190]]) {
    const r = await get(`${FCS}/${l.id}/query?` + qs(pt(lat, lon, { distance: 250, units: 'esriSRUnit_Meter', outFields: '*' })));
    line(`   ${name}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms n=${r.json && r.json.features ? r.json.features.length : '?'} ${short(r.json && (r.json.features ? r.json.features.slice(0, 4).map(f => f.attributes) : r.json.error), 900)}`);
  }
}

// ---------------------------------------------------------------- WAZA gaps
H('WAZA: rights-of-way and zone counts');
for (const [name, geoid] of [['Black Diamond', '5306330'], ['Vancouver', '5374060'], ['Richland', '5358235']]) {
  const c = await get(WAZA + '/0/query?' + qs({ where: `GEOID='${geoid}'`, returnCountOnly: true, f: 'json' }));
  const d = await get(WAZA + '/0/query?' + qs({ where: `GEOID='${geoid}'`, outFields: 'ZoneID,ZoneName,WAZAZoneGeneral,WAZAZoneSpecific,UseOffice', returnDistinctValues: true, returnGeometry: false, f: 'json' }));
  line(`${name}: zones=${c.json && c.json.count} distinct=${short(d.json && d.json.features && d.json.features.map(f => Object.values(f.attributes).join('/')), 1800)}`);
}
for (const [name, lat, lon] of [['black-diamond-sr169', 47.3087, -122.0035], ['black-diamond-ten-trails', 47.3240, -122.0310], ['vancouver', 45.6387, -122.6615], ['seattle-downtown', 47.6097, -122.3331], ['auburn-main', 47.3073, -122.2285]]) {
  for (const dist of [15, 40]) {
    const r = await get(WAZA + '/0/query?' + qs(pt(lat, lon, { distance: dist, units: 'esriSRUnit_Meter', outFields: 'OBJECTID,GEOID,Jurisdiction,ZoneID,ZoneName,WAZAZoneGeneral,UseOffice', returnGeometry: true, outSR: 4326, geometryPrecision: 6, f: 'geojson' })));
    const fs = (r.json && r.json.features) || [];
    line(`${name} within ${dist} m: HTTP ${r.status} n=${fs.length} ${short(fs.map(f => f.properties.Jurisdiction + ':' + f.properties.ZoneID + ':' + f.properties.WAZAZoneGeneral + ':' + f.properties.UseOffice), 500)}`);
  }
}

// ---------------------------------------------------------------- local services behind the atlas
H('Cities\' own zoning services (from the atlas)');
const jr = await get(WAZA + '/2/query?' + qs({ where: '1=1', outFields: 'GEOID,Jurisdiction,ZoningGISURL,ZoneIDField,SpatialSource', returnGeometry: false, f: 'json', resultRecordCount: 400 }));
const juris = ((jr.json && jr.json.features) || []).map(f => f.attributes);
const direct = juris.filter(j => /\/(MapServer|FeatureServer)\/\d+\/?$/i.test(String(j.ZoningGISURL || '').trim()));
line(`jurisdictions=${juris.length} with a direct layer URL=${direct.length} with a zone field too=${direct.filter(j => j.ZoneIDField).length}`);
let n = 0, cors = 0, ok = 0;
for (const j of direct) {
  const url = String(j.ZoningGISURL).trim().replace(/\/+$/, '');
  const r = await get(url + '/query?' + qs({ where: '1=1', returnCountOnly: true, f: 'json' }), { timeout: 20000 });
  n++;
  const good = r.status === 200 && r.json && typeof r.json.count === 'number';
  if (good) ok++;
  if (good && r.acao) cors++;
  line(`  ${j.Jurisdiction.padEnd(34)} ${good ? 'OK ' : 'BAD'} ACAO=${(r.acao || 'MISSING').padEnd(28)} count=${r.json && r.json.count} field=${j.ZoneIDField || '-'} ${r.error ? short(r.error, 80) : ''} ${url}`);
}
line(`direct layers answering: ${ok}/${n}; with a CORS header: ${cors}`);

// ---------------------------------------------------------------- Overpass (lighter)
H('Overpass lighter query');
for (const [name, lat, lon] of [['black-diamond', 47.3087, -122.0035], ['covington', 47.3587, -122.1115]]) {
  const ql = `[out:json][timeout:25];
way["amenity"="parking"](around:200,${lat},${lon});out tags geom;
nwr["social_facility"="shelter"](around:3219,${lat},${lon});out tags center;
node["highway"="motorway_junction"](around:8047,${lat},${lon});out tags;`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await get('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(ql), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const els = (r.json && r.json.elements) || [];
    line(`${name} try ${attempt}: HTTP ${r.status} ACAO=${r.acao || 'MISSING'} ${r.ms}ms ${r.bytes}B elements=${els.length}`);
    if (r.status === 200) break;
    await sleep(8000);
  }
  await sleep(6000);
}
line('\nprobe done');
