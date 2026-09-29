// Temporary exploration probe (removed before merge). Round 3.
import { execFileSync } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fetchRetry, fetchJSON, qs } from './build-data/lib.mjs';

const out = (...a) => console.log(...a);
const sec = s => out(`\n=================== ${s}`);
const tryJSON = async url => { try { return await fetchJSON(url, {}, { retries: 1, timeoutMs: 60000 }); } catch (e) { return { __err: e.message }; } };
const fieldNames = info => (info.fields || []).map(f => `${f.name}:${(f.type || '').replace('esriFieldType', '')}`).join(',');

sec('HELMS facilities');
const helms = 'https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Facility_HELMS_Report_DEC2025/FeatureServer';
const hs = await tryJSON(`${helms}?f=json`);
out(`layers: ${(hs.layers || []).map(l => `${l.id}:${l.name}`).join(' | ')} ${hs.__err || ''}`);
for (const l of (hs.layers || []).slice(0, 4)) {
  const info = await tryJSON(`${helms}/${l.id}?f=json`);
  out(`layer ${l.id}: type=${info.geometryType} fields ${fieldNames(info)}`);
  const strF = (info.fields || []).filter(f => /String/.test(f.type) && /type|categ|class|program|profession|credential|status/i.test(f.name)).map(f => f.name);
  for (const f of strF.slice(0, 4)) {
    const d = await tryJSON(`${helms}/${l.id}/query?${qs({ where: '1=1', groupByFieldsForStatistics: f, outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }]), f: 'json' })}`);
    out(`  ${f}: ${(d.features || []).map(x => `${x.attributes[f]}=${x.attributes.n}`).join(' | ').slice(0, 3000)} ${d.__err || (d.error && JSON.stringify(d.error)) || ''}`);
  }
  const s = await tryJSON(`${helms}/${l.id}/query?${qs({ where: '1=1', outFields: '*', resultRecordCount: 2, outSR: 4326, f: 'json' })}`);
  (s.features || []).forEach(f => out(`  sample: ${JSON.stringify(f).slice(0, 900)}`));
}

sec('NCUA call report 2026-06');
try {
  const res = await fetchRetry('https://ncua.gov/files/publications/analysis/call-report-data-2026-06.zip', {}, { retries: 1, timeoutMs: 300000 });
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = await mkdtemp(`${tmpdir()}/ncua-`);
  await writeFile(`${dir}/c.zip`, buf);
  out(`zip bytes: ${buf.length}`);
  out(execFileSync('unzip', ['-l', `${dir}/c.zip`]).toString().slice(0, 3000));
  const txt = execFileSync('bash', ['-c', `unzip -p "${dir}/c.zip" '*ranch*' | head -3`]).toString();
  out(`branch file head:\n${txt.slice(0, 3000)}`);
  const wa = execFileSync('bash', ['-c', `unzip -p "${dir}/c.zip" '*ranch*' | grep -c ',"WA",\\|,WA,' || true`]).toString();
  out(`WA-ish lines: ${wa}`);
} catch (e) { out(`ncua: ${e.message}`); }

sec('Kirkland offenses');
const kk = 'https://maps.kirklandwa.gov/host/rest/services/Hosted/CrimeAnalysis_(Public)/FeatureServer';
for (const id of [2, 3, 1]) {
  const info = await tryJSON(`${kk}/${id}?f=json`);
  out(`layer ${id} ${info.name}: type=${info.geometryType} max=${info.maxRecordCount} fields ${fieldNames(info)}`);
  const dateF = (info.fields || []).filter(f => /Date/.test(f.type)).map(f => f.name);
  for (const d of dateF.slice(0, 3)) {
    const st = await tryJSON(`${kk}/${id}/query?${qs({ where: '1=1', outStatistics: JSON.stringify([{ statisticType: 'max', onStatisticField: d, outStatisticFieldName: 'mx' }, { statisticType: 'count', onStatisticField: d, outStatisticFieldName: 'n' }]), f: 'json' })}`);
    const a = st.features && st.features[0] && st.features[0].attributes;
    out(`  ${d}: max=${a && a.mx && new Date(a.mx).toISOString()} n=${a && a.n}`);
  }
  const s = await tryJSON(`${kk}/${id}/query?${qs({ where: '1=1', outFields: '*', resultRecordCount: 1, outSR: 4326, f: 'json' })}`);
  (s.features || []).forEach(f => out(`  sample: ${JSON.stringify(f).slice(0, 1200)}`));
}

sec('Bellevue Crimes sample');
const bs = await tryJSON(`https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Offenses/FeatureServer/1/query?${qs({ where: "FROM_DATE >= TIMESTAMP '2025-09-29 00:00:00'", outFields: '*', resultRecordCount: 3, outSR: 4326, f: 'json', orderByFields: 'FROM_DATE DESC' })}`);
(bs.features || []).forEach(f => out(`  sample: ${JSON.stringify(f).slice(0, 700)}`));
const bc = await tryJSON(`https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Offenses/FeatureServer/1/query?${qs({ where: "FROM_DATE >= TIMESTAMP '2025-09-29 00:00:00'", returnCountOnly: true, f: 'json' })}`);
out(`  last 12 months: ${JSON.stringify(bc)}`);

sec('Redmond sample + range');
const rd = 'https://gis.redmond.gov/arcgis/rest/services/CrimeMap/Crimes/FeatureServer/0';
const rst = await tryJSON(`${rd}/query?${qs({ where: '1=1', outStatistics: JSON.stringify([{ statisticType: 'min', onStatisticField: 'DateTimeReported', outStatisticFieldName: 'mn' }, { statisticType: 'max', onStatisticField: 'DateTimeReported', outStatisticFieldName: 'mx' }]), f: 'json' })}`);
const ra = rst.features && rst.features[0] && rst.features[0].attributes;
out(`  range: ${ra && new Date(ra.mn).toISOString()} .. ${ra && new Date(ra.mx).toISOString()} ${rst.__err || ''}`);
const rs = await tryJSON(`${rd}/query?${qs({ where: '1=1', outFields: 'LawIncidentNumber,DateTimeReported,OffenseDescription,IBR_Description,UCR_Description,FilteredAddress,WebSubType', resultRecordCount: 3, outSR: 4326, f: 'json' })}`);
(rs.features || []).forEach(f => out(`  sample: ${JSON.stringify(f).slice(0, 600)}`));

sec('PAD-US centroid support');
const pad = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Type_PADUS/FeatureServer/0';
const pc = await tryJSON(`${pad}/query?${qs({ where: "State_Nm='WA' AND FeatClass='Fee' AND Des_Tp IN ('LP','LREC','SP','SREC','NP','NRA')", returnCountOnly: true, f: 'json' })}`);
out(`  count: ${JSON.stringify(pc)}`);
const pcs = await tryJSON(`${pad}/query?${qs({ where: "State_Nm='WA' AND FeatClass='Fee' AND Des_Tp='LP'", outFields: 'Unit_Nm,Loc_Nm,Mang_Name,Loc_Mang,Des_Tp,GIS_Acres,Pub_Access', returnGeometry: false, returnCentroid: true, outSR: 4326, resultRecordCount: 3, f: 'json' })}`);
out(`  centroid sample: ${JSON.stringify(pcs).slice(0, 1200)}`);
const dt = await tryJSON(`${pad}/query?${qs({ where: "State_Nm='WA'", groupByFieldsForStatistics: 'Des_Tp,FeatClass', outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'OBJECTID', outStatisticFieldName: 'n' }]), f: 'json' })}`);
out(`  Des_Tp x FeatClass: ${(dt.features || []).map(x => `${x.attributes.Des_Tp}/${x.attributes.FeatClass}=${x.attributes.n}`).join(' ')}`);

out('\nDONE');
