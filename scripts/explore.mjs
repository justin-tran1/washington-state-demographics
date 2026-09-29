// Temporary exploration probe (removed before merge). Round 2: crime feeds,
// pharmacy / credit-union / park sources, Census place gazetteer.
import { fetchRetry, fetchJSON, fetchText, qs } from './build-data/lib.mjs';

const out = (...a) => console.log(...a);
const sec = s => out(`\n=================== ${s}`);
const tryJSON = async (url, init) => {
  try { return await fetchJSON(url, init, { retries: 1, timeoutMs: 60000 }); }
  catch (e) { return { __err: e.message }; }
};
const fieldNames = info => (info.fields || []).map(f => `${f.name}:${(f.type || '').replace('esriFieldType', '')}`).join(',');

async function arcLayer(label, url, where, orderBy, outFields = '*') {
  const info = await tryJSON(`${url}?f=json`);
  if (info.__err || info.error) { out(`${label}: ${info.__err || JSON.stringify(info.error).slice(0, 200)}`); return; }
  out(`${label}: name=${info.name} type=${info.geometryType} max=${info.maxRecordCount} extent=${JSON.stringify(info.extent || {}).slice(0, 160)}`);
  out(`  fields: ${fieldNames(info)}`);
  const c = await tryJSON(`${url}/query?${qs({ where: where || '1=1', returnCountOnly: true, f: 'json' })}`);
  out(`  count(${where || '1=1'}) = ${JSON.stringify(c).slice(0, 120)}`);
  const s = await tryJSON(`${url}/query?${qs({ where: where || '1=1', outFields, resultRecordCount: 2, returnGeometry: true, outSR: 4326, f: 'json', ...(orderBy ? { orderByFields: orderBy } : {}) })}`);
  if (s.features && s.features[0]) s.features.forEach(f => out(`  sample: ${JSON.stringify(f).slice(0, 600)}`));
  else out(`  sample: ${JSON.stringify(s).slice(0, 300)}`);
}
async function arcService(label, url) {
  const info = await tryJSON(`${url}?f=json`);
  if (info.__err || info.error) { out(`${label}: ${info.__err || JSON.stringify(info.error).slice(0, 200)}`); return null; }
  out(`${label}: layers=${(info.layers || []).map(l => `${l.id}:${l.name}`).join(' | ')} tables=${(info.tables || []).map(l => `${l.id}:${l.name}`).join(' | ')}`);
  return info;
}
async function soc(label, domain, id, order, where) {
  const meta = await tryJSON(`${domain}/api/views/${id}.json`);
  out(`${label}: ${meta.__err || `name=${meta.name} rowsUpdated=${meta.rowsUpdatedAt && new Date(meta.rowsUpdatedAt * 1000).toISOString()} cols=${(meta.columns || []).map(c => `${c.fieldName}:${c.dataTypeName}`).join(',')}`}`);
  const rows = await tryJSON(`${domain}/resource/${id}.json?${qs({ $limit: 3, ...(order ? { $order: `${order} DESC` } : {}), ...(where ? { $where: where } : {}) })}`);
  out(`  rows: ${JSON.stringify(rows).slice(0, 1400)}`);
  if (order) {
    const cnt = await tryJSON(`${domain}/resource/${id}.json?${qs({ $select: 'count(*) as n', $where: `${order} >= '2025-09-29T00:00:00'` })}`);
    out(`  last-12-month count: ${JSON.stringify(cnt).slice(0, 200)}`);
  }
}

// --------------------------------------------------------------------- crime
sec('data.wa.gov vvfu-ry7f (WASPC NIBRS by agency)');
await soc('vvfu-ry7f', 'https://data.wa.gov', 'vvfu-ry7f', 'indexyear');
const yrs = await tryJSON(`https://data.wa.gov/resource/vvfu-ry7f.json?${qs({ $select: 'indexyear, count(*) as n', $group: 'indexyear', $order: 'indexyear DESC', $limit: 20 })}`);
out(`  rows per year: ${JSON.stringify(yrs).slice(0, 600)}`);
const locs = await tryJSON(`https://data.wa.gov/resource/vvfu-ry7f.json?${qs({ $select: 'location,county,population,total', $where: "indexyear='2024'", $limit: 400, $order: 'location' })}`);
if (Array.isArray(locs)) out(`  2024 agencies (${locs.length}): ${locs.map(l => `${l.location} [${l.county}] ${l.population}`).join(' | ').slice(0, 6000)}`);
else out(`  2024 agencies: ${JSON.stringify(locs).slice(0, 300)}`);

sec('Census place gazetteer');
for (const y of [2025, 2024, 2023]) {
  try {
    const html = await fetchText(`https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${y}_Gazetteer/`, {}, { retries: 0, timeoutMs: 30000 });
    const files = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(f => /place|county|cousub/i.test(f));
    out(`${y}: ${files.join(' ')}`);
  } catch (e) { out(`${y}: ${e.message}`); }
}

sec('FBI CDE keyless backend');
for (const u of ['https://cde.ucr.cjis.gov/LATEST/agency/byStateAbbr/WA',
  'https://cde.ucr.cjis.gov/LATEST/summarized/agency/WA0320400/violent-crime?from=01-2025&to=12-2025',
  'https://cde.ucr.cjis.gov/LATEST/s3/signedurl?key=nibrs/incident/2024/WA-2024.zip']) {
  try { const r = await fetchRetry(u, {}, { retries: 0, timeoutMs: 40000 }); out(`${u} -> ${r.status} ${(await r.text()).slice(0, 400)}`); }
  catch (e) { out(`${u} -> ${e.message}`); }
}

sec('Seattle');
const sea = await tryJSON(`https://data.seattle.gov/resource/tazs-3rd5.json?${qs({ $select: "count(*) as n, sum(case(latitude='REDACTED',1,true,0)) as redacted", $where: "offense_date >= '2025-09-29T00:00:00'" })}`);
out(`  last 12 months: ${JSON.stringify(sea)}`);

sec('Tacoma TPD_RMS_Crime');
await arcLayer('TPD_RMS_Crime/0', 'https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/TPD_RMS_Crime/FeatureServer/0',
  "DateOccurred >= TIMESTAMP '2025-09-29 00:00:00'", 'DateOccurred DESC');

sec('King County Sheriff 4kmt-kfqf');
await soc('KCSO', 'https://data.kingcounty.gov', '4kmt-kfqf', 'incident_datetime');

sec('Everett szww-y224');
await soc('Everett cases', 'https://data.everettwa.gov', 'szww-y224', 'datetimereceived', "datetimereceived < '2026-10-01T00:00:00'");

sec('Auburn 8g4u-7zzy');
await soc('Auburn', 'https://data.auburnwa.gov', '8g4u-7zzy', 'reported');
const aub = await tryJSON(`https://data.auburnwa.gov/resource/8g4u-7zzy.json?${qs({ $select: 'offense, count(*) as n', $group: 'offense', $order: 'n DESC', $limit: 60, $where: "reported >= '2025-09-29T00:00:00'" })}`);
out(`  offenses: ${JSON.stringify(aub).slice(0, 2500)}`);

sec('Pierce County Sheriff');
const pc = await arcService('Crime_Data', 'https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Crime_Data/FeatureServer');
if (pc) for (const l of (pc.layers || []).slice(0, 8)) await arcLayer(`  layer ${l.id} ${l.name}`, `https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Crime_Data/FeatureServer/${l.id}`);
await soc('Pierce socrata', 'https://internal.open.piercecountywa.gov', '9ik3-ebpg', 'occurredon');

sec('Yakima');
await arcLayer('Crimes_public/0', 'https://services5.arcgis.com/drBwGNA3YMS2QPJd/arcgis/rest/services/Crimes_public_fc349e427d9945729c4e985666b31686/FeatureServer/0',
  "reportdate >= TIMESTAMP '2025-09-29 00:00:00'", 'reportdate DESC', 'offenseid,reportdate,nibrsdesc,neighborhood,zip5');

sec('Bellevue');
for (const svc of ['Offenses', 'Crime_Cases_By_100_Block']) {
  const s = await arcService(svc, `https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/${svc}/FeatureServer`);
  if (s) for (const l of (s.layers || []).slice(0, 3)) {
    const info = await tryJSON(`https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/${svc}/FeatureServer/${l.id}?f=json`);
    const dateF = (info.fields || []).filter(f => /Date/.test(f.type)).map(f => f.name);
    out(`  layer ${l.id}: fields ${fieldNames(info)}`);
    for (const d of dateF.slice(0, 2)) {
      const st = await tryJSON(`https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/${svc}/FeatureServer/${l.id}/query?${qs({ where: '1=1', outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: d, outStatisticFieldName: 'mx' }, { statisticType: 'count', onStatisticField: d, outStatisticFieldName: 'n' }]), f: 'json' })}`);
      const a = st.features && st.features[0] && st.features[0].attributes;
      out(`    ${d}: max=${a && a.mx && new Date(a.mx).toISOString()} n=${a && a.n} ${st.__err || (st.error && st.error.message) || ''}`);
    }
  }
}

sec('Redmond / Kirkland');
await arcService('Redmond Crimes', 'https://gis.redmond.gov/arcgis/rest/services/CrimeMap/Crimes/FeatureServer');
await arcLayer('Redmond Crimes/0', 'https://gis.redmond.gov/arcgis/rest/services/CrimeMap/Crimes/FeatureServer/0', undefined, undefined, 'LawIncidentNumber,DateTimeReported,OffenseCode,WebSubType');
await arcService('Kirkland CrimeAnalysis (Public)', 'https://maps.kirklandwa.gov/host/rest/services/Hosted/CrimeAnalysis_(Public)/FeatureServer');
await arcLayer('Kirkland/0', 'https://maps.kirklandwa.gov/host/rest/services/Hosted/CrimeAnalysis_(Public)/FeatureServer/0');

sec('Spokane CrimePoints (suspected D.C.)');
await arcService('CrimePoints', 'https://services6.arcgis.com/ydggmMcp46DZ7B9Z/ArcGIS/rest/services/CrimePoints/FeatureServer');

// ------------------------------------------------------------------ amenities
sec('WA DOH pharmacies');
const ph = await tryJSON(`https://www.arcgis.com/sharing/rest/search?${qs({ q: 'pharmacies orgid:rGGrs6HCnw87OFOT', num: 20, f: 'json' })}`);
for (const r of ph.results || []) out(`  ${r.id} | ${r.title} | ${r.type} | ${r.owner} | ${r.url} | mod ${new Date(r.modified).toISOString().slice(0, 10)}`);
const ph2 = await tryJSON(`https://www.arcgis.com/sharing/rest/search?${qs({ q: 'title:Pharmacies owner:WADOH', num: 20, f: 'json' })}`);
for (const r of ph2.results || []) out(`  (owner search) ${r.id} | ${r.title} | ${r.type} | ${r.owner} | ${r.url}`);
const dohRoot = await tryJSON('https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services?f=json');
out(`  DOH services (${(dohRoot.services || []).length}): ${(dohRoot.services || []).map(s => s.name).join(', ').slice(0, 4000)}`);
await arcLayer('DOH Clinics', 'https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Clinics/FeatureServer/0');

sec('NCUA call report ZIP');
for (const q of ['2026-06', '2026-03', '2025-12']) {
  const u = `https://ncua.gov/files/publications/analysis/call-report-data-${q}.zip`;
  try { const r = await fetchRetry(u, { method: 'HEAD' }, { retries: 0, timeoutMs: 30000 }); out(`${u} -> ${r.status} len=${r.headers.get('content-length')}`); }
  catch (e) { out(`${u} -> ${e.message}`); }
}

sec('PAD-US');
await arcLayer('Manager_Type_PADUS', 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Type_PADUS/FeatureServer/0', "State_Nm='WA'");
await arcLayer('WA State Parks', 'https://services5.arcgis.com/4LKAHwqnBooVDUlX/arcgis/rest/services/ParkBoundaries/FeatureServer/2');

sec('Mobility Database catalog');
try {
  const csv = await fetchText('https://files.mobilitydatabase.org/feeds_v2.csv', {}, { retries: 1, timeoutMs: 60000 });
  const lines = csv.split('\n');
  out(`header: ${lines[0]}`);
  out(`WA rows: ${lines.filter(l => /,Washington,/.test(l)).length}; sample: ${lines.filter(l => /,Washington,/.test(l)).slice(0, 3).join(' || ').slice(0, 1500)}`);
} catch (e) { out(`catalog: ${e.message}`); }

out('\nDONE');
