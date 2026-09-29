// Temporary exploration probe (removed before merge). Prints compact facts
// about candidate data sources so the build scripts can target them exactly.
import { fetchRetry, fetchJSON, fetchText, qs, overpass, WA_AREA } from './build-data/lib.mjs';

const out = (...a) => console.log(...a);
const sec = s => out(`\n=================== ${s}`);
const tryJSON = async (url, init) => {
  try { return await fetchJSON(url, init, { retries: 1, timeoutMs: 60000 }); }
  catch (e) { return { __err: e.message }; }
};
const fieldNames = info => (info.fields || []).map(f => f.name).join(',');

async function arcLayer(label, url, where) {
  const info = await tryJSON(`${url}?f=json`);
  if (info.__err || info.error) { out(`${label}: ${info.__err || JSON.stringify(info.error).slice(0, 200)}`); return; }
  out(`${label}: name=${info.name} type=${info.geometryType} max=${info.maxRecordCount} pag=${info.advancedQueryCapabilities && info.advancedQueryCapabilities.supportsPagination}`);
  out(`  fields: ${fieldNames(info)}`);
  if (where) {
    const c = await tryJSON(`${url}/query?${qs({ where, returnCountOnly: true, f: 'json' })}`);
    out(`  count(${where}) = ${JSON.stringify(c).slice(0, 200)}`);
    const s = await tryJSON(`${url}/query?${qs({ where, outFields: '*', resultRecordCount: 1, returnGeometry: true, outSR: 4326, f: 'json' })}`);
    if (s.features && s.features[0]) out(`  sample: ${JSON.stringify(s.features[0]).slice(0, 700)}`);
    else out(`  sample: ${JSON.stringify(s).slice(0, 300)}`);
  }
}

async function arcService(label, url) {
  const info = await tryJSON(`${url}?f=json`);
  if (info.__err || info.error) { out(`${label}: ${info.__err || JSON.stringify(info.error).slice(0, 200)}`); return null; }
  out(`${label}: layers=${(info.layers || []).map(l => `${l.id}:${l.name}`).join(' | ')} tables=${(info.tables || []).map(l => `${l.id}:${l.name}`).join(' | ')}`);
  return info;
}

async function item(label, id) {
  const it = await tryJSON(`https://www.arcgis.com/sharing/rest/content/items/${id}?f=json`);
  out(`${label} item ${id}: title=${it.title} type=${it.type} url=${it.url} modified=${it.modified && new Date(it.modified).toISOString()} ${it.__err || (it.error && it.error.message) || ''}`);
  return it;
}

// ------------------------------------------------------------------- health
sec('HRSA gisportal roots');
for (const root of ['https://gisportal.hrsa.gov/server/rest/services', 'https://gisportal.hrsa.gov/arcgis/rest/services']) {
  const r = await tryJSON(`${root}/HealthCareFacilities?f=json`);
  out(`${root}/HealthCareFacilities -> ${r.__err || (r.error && r.error.message) || (r.services || []).map(s => s.name + ':' + s.type).join(', ')}`);
}
const HRSA = 'https://gisportal.hrsa.gov/server/rest/services/HealthCareFacilities';
const cms = await arcService('CMSApprovedFacilities_FS', `${HRSA}/CMSApprovedFacilities_FS/MapServer`);
if (cms) for (const l of cms.layers || []) await arcLayer(`  CMS layer ${l.id} ${l.name}`, `${HRSA}/CMSApprovedFacilities_FS/MapServer/${l.id}`, "CMS_PROVIDER_STATE_ABBR='WA'");
const phc = await arcService('PrimaryHealthCareFacilities_FS', `${HRSA}/PrimaryHealthCareFacilities_FS/MapServer`);
if (phc) await arcLayer('  PHC layer 0', `${HRSA}/PrimaryHealthCareFacilities_FS/MapServer/0`, "SITE_STATE_ABBR='WA'");
const vha = await arcService('VHAFacilities_FS', `${HRSA}/VHAFacilities_FS/MapServer`);
if (vha) await arcLayer('  VHA layer 0', `${HRSA}/VHAFacilities_FS/MapServer/0`, '1=1');

sec('WA DOH items');
for (const [label, id] of [['DOH Hospitals', '626cb2ca35c64ea1a2ac502c573e3ec9'], ['DOH Tribal clinics', '4df352f9a9a6480a991624e4aa216728']]) {
  const it = await item(label, id);
  if (it && it.url) {
    const svc = await arcService(`  ${label} service`, it.url.replace(/\/\d+$/, ''));
    const lid = /\/\d+$/.test(it.url) ? '' : '/0';
    await arcLayer(`  ${label} layer`, it.url + lid, '1=1');
  }
}
const doh = await tryJSON(`https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services?f=json`);
out(`DOH org services: ${doh.__err || (doh.services || []).map(s => s.name).filter(n => /hosp|clinic|rhc|thc|fqhc|health|pharm|urgent/i.test(n)).join(', ')}`);

sec('HIFLD (expected dead)');
await arcLayer('HIFLD Hospitals_1', 'https://services1.arcgis.com/Hp6G80Pky0om7QvQ/arcgis/rest/services/Hospitals_1/FeatureServer/0', "STATE='WA'");

sec('CMS hospital general info (data.cms.gov provider data)');
const hgi = await tryJSON('https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?limit=2&conditions[0][property]=state&conditions[0][value]=WA&conditions[0][operator]==&count=true&results=true');
out(hgi.__err || `count=${hgi.count} sample=${JSON.stringify((hgi.results || [])[0]).slice(0, 500)}`);

// ------------------------------------------------------------------ commerce
sec('FDIC locations');
for (const base of ['https://api.fdic.gov/banks/locations', 'https://banks.data.fdic.gov/api/locations']) {
  const d = await tryJSON(`${base}?${qs({ filters: 'STALP:WA', limit: 1, format: 'json' })}`);
  out(`${base}: ${d.__err || `total=${d.meta && d.meta.total} keys=${Object.keys((d.data && d.data[0] && d.data[0].data) || {}).join(',')}`}`);
}
sec('NCUA credit unions');
for (const u of ['https://mapping.ncua.gov/api/Search/GetSearchLocations?address=Seattle%2C%20WA&type=address&radius=25',
  'https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data']) {
  try { const r = await fetchRetry(u, {}, { retries: 0, timeoutMs: 30000 }); out(`${u} -> ${r.status} ${(await r.text()).slice(0, 300).replace(/\s+/g, ' ')}`); }
  catch (e) { out(`${u} -> ${e.message}`); }
}
sec('SNAP retailers');
const snapSearch = await tryJSON(`https://www.arcgis.com/sharing/rest/search?${qs({ q: 'SNAP retailer locations owner:USDA_FNS OR title:"SNAP Retailer"', num: 10, f: 'json' })}`);
for (const r of snapSearch.results || []) out(`  ${r.id} | ${r.title} | ${r.type} | ${r.owner} | ${r.url}`);
await arcLayer('SNAP guessed', 'https://services1.arcgis.com/RLQu0rK7h4kbsBq5/arcgis/rest/services/snap_retailer_location_data/FeatureServer/0', "State='WA'");

sec('NREL alt fuel (DEMO_KEY)');
const nrel = await tryJSON(`https://developer.nrel.gov/api/alt-fuel-stations/v1.json?${qs({ api_key: 'DEMO_KEY', state: 'WA', status: 'E', access: 'public', limit: 1 })}`);
out(nrel.__err || `total=${nrel.total_results} keys=${Object.keys((nrel.fuel_stations || [])[0] || {}).slice(0, 40).join(',')}`);

sec('NCES EDGE services');
for (const f of ['K12_School_Locations', 'Postsecondary_School_Locations']) {
  const l = await tryJSON(`https://nces.ed.gov/opengis/rest/services/${f}?f=json`);
  out(`${f}: ${l.__err || (l.services || []).map(s => s.name.split('/').pop()).join(', ')}`);
}

sec('Overpass statewide counts');
const SEL = {
  hospital: ['["amenity"="hospital"]', '["healthcare"="hospital"]'],
  clinic: ['["amenity"="clinic"]', '["healthcare"="clinic"]', '["healthcare"="centre"]'],
  doctors: ['["amenity"="doctors"]', '["healthcare"="doctor"]'],
  pharmacy: ['["amenity"="pharmacy"]', '["healthcare"="pharmacy"]'],
  restaurants: ['["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|biergarten)$"]', '["shop"~"^(bakery|coffee|pastry|confectionery)$"]'],
  retail: ['["shop"]["shop"!~"^(supermarket|grocery|greengrocer|convenience|health_food|butcher|deli|bakery|coffee|pastry|confectionery|car|car_repair|car_parts|motorcycle|tyres|vacant|no|yes|fuel)$"]'],
  banks: ['["amenity"="bank"]'],
  fuel: ['["amenity"="fuel"]'],
  charging: ['["amenity"="charging_station"]'],
  parks: ['["leisure"~"^(park|playground|nature_reserve|garden|recreation_ground|dog_park)$"]']
};
for (const [k, sels] of Object.entries(SEL)) {
  const t0 = Date.now();
  try {
    const d = await overpass(`[out:json][timeout:200];${WA_AREA}(${sels.map(s => `nwr${s}(area.wa);`).join('')});out count;`);
    const c = (d.elements || [])[0];
    out(`${k}: ${JSON.stringify(c && c.tags)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) { out(`${k}: ${e.message}`); }
}

// --------------------------------------------------------------------- crime
sec('FBI NIBRS bulk state files');
for (const y of [2024, 2023]) {
  for (const u of [`https://s3-us-gov-west-1.amazonaws.com/cg-d4b776d0-d898-4153-90c8-8336f86bdfec/${y}/WA-${y}.zip`,
    `https://cde.ucr.cjis.gov/LATEST/s3/signedurl?key=nibrs/annual/WA-${y}.zip`]) {
    try { const r = await fetchRetry(u, { method: 'HEAD' }, { retries: 0, timeoutMs: 30000 }); out(`${u} -> ${r.status} len=${r.headers.get('content-length')} type=${r.headers.get('content-type')}`); }
    catch (e) { out(`${u} -> ${e.message}`); }
  }
}
sec('FBI CDE API (DEMO_KEY)');
for (const p of ['summarized/state/WA/violent-crime?from=01-2024&to=12-2024',
  'summarized/agency/WASPD0000/all?from=01-2024&to=12-2024',
  'agency/byStateAbbr/WA']) {
  const d = await tryJSON(`https://api.usa.gov/crime/fbi/cde/${p}${p.includes('?') ? '&' : '?'}API_KEY=DEMO_KEY`);
  out(`${p}: ${JSON.stringify(d).slice(0, 600)}`);
}
sec('Socrata catalog: WA crime datasets');
for (const q of ['crime', 'police incidents', 'offense', 'NIBRS', 'calls for service']) {
  const d = await tryJSON(`https://api.us.socrata.com/api/catalog/v1?${qs({ q, only: 'dataset', limit: 100 })}`);
  for (const r of d.results || []) {
    const dom = r.metadata && r.metadata.domain;
    if (!/wa\.gov|seattle|kingcounty|tacoma|spokane|bellevue|everett|redmond|kent|renton|olympia|vancouver|bellingham|pierce|snohomish|clark|thurston|yakima|kirkland|auburn|federalway|lakewood/i.test(dom || '')) continue;
    out(`  [${q}] ${dom} ${r.resource.id} | ${r.resource.name} | updated ${r.resource.data_updated_at} | cols ${(r.resource.columns_field_name || []).slice(0, 25).join(',')}`);
  }
}
sec('ArcGIS Online search: WA crime layers');
for (const q of ['crime Washington', 'police incidents Washington', 'crime Spokane', 'crime Tacoma', 'crime Everett', 'crime Vancouver WA', 'crime Bellingham', 'crime Olympia', 'crime Kent WA', 'crime Renton', 'crime Pierce County', 'crime Snohomish County', 'crime Yakima', 'crime Redmond', 'crime Bellevue', 'crime Kirkland', 'police offenses Tacoma']) {
  const d = await tryJSON(`https://www.arcgis.com/sharing/rest/search?${qs({ q: `${q} type:"Feature Service"`, num: 20, f: 'json', sortField: 'modified', sortOrder: 'desc' })}`);
  for (const r of d.results || []) out(`  [${q}] ${r.id} | ${r.title} | ${r.owner} | mod ${new Date(r.modified).toISOString().slice(0, 10)} | ${r.url}`);
}
sec('data.wa.gov NIBRS search');
const wa = await tryJSON(`https://data.wa.gov/api/catalog/v1?${qs({ q: 'crime', limit: 50 })}`);
for (const r of wa.results || []) out(`  ${r.resource.id} | ${r.resource.name} | ${r.resource.type} | updated ${r.resource.data_updated_at}`);

// ------------------------------------------------------------------- transit
sec('WSDOT transit');
const tsvc = await arcService('TransitData', 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer');
if (tsvc) for (const l of tsvc.layers || []) await arcLayer(`  layer ${l.id} ${l.name}`, `https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer/${l.id}`, '1=1');
try {
  const html = await fetchText('https://data.wsdot.wa.gov/gtfs/list.html', {}, { retries: 1 });
  const zips = [...html.matchAll(/href="([^"]+)"/gi)].map(m => m[1]);
  out(`gtfs list: ${zips.length} links; zips=${zips.filter(z => /\.zip/i.test(z)).length}; first: ${zips.slice(0, 15).join(' ')}`);
} catch (e) { out(`gtfs list: ${e.message}`); }
out('\nDONE');
