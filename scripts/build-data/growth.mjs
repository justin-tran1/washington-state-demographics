// Population growth for the medical site ranking.
//
//  - OFM Small Area Estimates Program (SAEP): April 1 population and housing
//    unit estimates for every 2020 census tract, from OFM's adjusted 2020
//    census count to the newest estimate year.
//  - OFM Growth Management Act county projections, middle series: the
//    official 5-year projections counties plan with, for a forward look.
//
// Both are Excel workbooks. Columns are identified from their header text,
// never by position, and the step stops (keeping the last good file) if a
// header or a statewide total looks wrong.
//
// Output: data/growth.json
//   { built, tract: { base, latest, fields, rows: { GEOID: [...] } },
//     county: { series, vintage, years, rows: { FIPS: [...] } } }

import { readXlsx, log, writeJSON, readJSON, WA_FIPS } from './lib.mjs';

const OFM = 'https://ofm.wa.gov/wp-content/uploads/sites/default/files/public/dataresearch/pop';
export const SAEP_URL = `${OFM}/smallarea/data/xlsx/saep_tract20.xlsx`;
const GMA_URL = y => `${OFM}/GMA/projections${y}/gma_${y}_5yr.xlsx`;
export const TRACT_FIELDS = ['pop20', 'pop', 'hu20', 'hu'];

const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);

/**
 * One SAEP sheet (total population or total housing units):
 * { base: 2020, latest, rows: { GEOID: [base, latest] }, counties: { name: fips } }.
 * `what` is the measure in the headers ("Total Population").
 */
export function saepSheet(sheet, what) {
  const W = what.replace(/\s+/g, '\\s+');
  let headRow = null;
  for (const [r, cells] of Object.entries(sheet.rows)) {
    if (Object.values(cells).some(v => /^census tract code complete$/i.test(String(v).trim()))) { headRow = +r; break; }
  }
  if (headRow == null) throw new Error(`${sheet.name}: no "Census Tract Code Complete" header`);
  const head = sheet.rows[headRow];
  const find = re => Object.keys(head).find(c => re.test(String(head[c]).trim()));
  const geoCol = find(/^census tract code complete$/i);
  const countyCol = find(/^county name$/i), countyFips = find(/^county code fips$/i);
  const baseCol = find(new RegExp(`^ofm adjusted ${W} 2020$`, 'i'));
  const years = Object.keys(head).map(c => {
    const m = String(head[c]).trim().match(new RegExp(`^estimated ${W} (\\d{4})$`, 'i'));
    return m && +m[1] > 2020 ? { c, y: +m[1] } : null;
  }).filter(Boolean).sort((a, b) => b.y - a.y);
  if (!geoCol || !baseCol || !years.length) {
    throw new Error(`${sheet.name}: expected tract code, "OFM Adjusted ${what} 2020" and "Estimated ${what} <year>" headers; saw ${Object.values(head).slice(0, 30).join(' | ')}`);
  }
  const latest = years[0];
  const rows = {}, counties = {};
  for (const [r, cells] of Object.entries(sheet.rows)) {
    if (+r <= headRow) continue;
    const g = String(cells[geoCol] || '').trim();
    if (!new RegExp(`^${WA_FIPS}\\d{9}$`).test(g)) continue; // notes and blank rows
    const a = num(cells[baseCol]), b = num(cells[latest.c]);
    if (a == null || b == null || a < 0 || b < 0) throw new Error(`${sheet.name}: tract ${g} has no 2020 or ${latest.y} value`);
    rows[g] = [Math.round(a), Math.round(b)];
    if (countyCol && countyFips && cells[countyCol]) counties[String(cells[countyCol]).trim()] = WA_FIPS + String(cells[countyFips]).trim().padStart(3, '0');
  }
  return { base: 2020, latest: latest.y, rows, counties };
}

/**
 * The GMA workbook's middle series: { years, rows: { FIPS: [values] }, state }.
 * The year row is the one with five or more 4-digit years; each year column
 * is kept when the label row above it (carried across merged blanks) says
 * census or projection, so the interim estimate columns are dropped.
 */
export function gmaSheet(sheets, countyFips) {
  const sheet = sheets.find(s => /middle/i.test(s.name)) || sheets.find(s => Object.values(s.rows[2] || {}).some(v => /middle series/i.test(v)));
  if (!sheet) throw new Error(`no middle series sheet (sheets: ${sheets.map(s => s.name).join(', ')})`);
  const nums = Object.keys(sheet.rows).map(Number).sort((a, b) => a - b);
  const yearRow = nums.find(r => Object.values(sheet.rows[r]).filter(v => /^20\d\d$/.test(String(v).trim())).length >= 5);
  if (yearRow == null) throw new Error(`${sheet.name}: no row of years`);
  const labelRow = nums.slice(0, nums.indexOf(yearRow)).reverse().slice(0, 3)
    .find(r => Object.values(sheet.rows[r]).some(v => /census|estimate|projection/i.test(v)));
  const labels = labelRow != null ? sheet.rows[labelRow] : {};
  const cols = Object.keys(sheet.rows[yearRow]).filter(c => /^20\d\d$/.test(String(sheet.rows[yearRow][c]).trim()))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  let kind = '';
  const keep = [];
  // Merged header cells leave the label in the first column only.
  const allCols = Object.keys({ ...labels, ...sheet.rows[yearRow] }).sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const c of allCols) {
    if (labels[c]) kind = String(labels[c]);
    if (cols.includes(c) && /census|projection/i.test(kind)) keep.push({ c, y: +sheet.rows[yearRow][c], kind: /projection/i.test(kind) ? 'projection' : 'census' });
  }
  if (!keep.some(k => k.kind === 'census') || keep.filter(k => k.kind === 'projection').length < 3) {
    throw new Error(`${sheet.name}: could not tell census and projection columns apart (labels: ${Object.values(labels).join(' | ')})`);
  }
  const nameCol = 'A';
  const rows = {};
  let state = null;
  for (const r of nums.filter(n => n > yearRow)) {
    const cells = sheet.rows[r];
    const name = String(cells[nameCol] || '').trim().replace(/\s+county$/i, '');
    const vals = keep.map(k => num(cells[k.c]));
    if (/^(state|washington)( total)?$/i.test(name)) { state = vals; continue; }
    const fips = countyFips[name];
    if (fips && vals.every(v => v != null && v > 0)) rows[fips] = vals.map(Math.round);
  }
  return { series: 'middle', years: keep.map(k => k.y), rows, state };
}

export async function buildGrowth(outDir) {
  const wb = await readXlsx(SAEP_URL);
  const popSheet = wb.find(s => /^total population$/i.test(s.name.trim()));
  const huSheet = wb.find(s => /^total housing units$/i.test(s.name.trim()));
  if (!popSheet || !huSheet) throw new Error(`SAEP sheets not found (saw: ${wb.map(s => s.name).join(', ')})`);
  const pop = saepSheet(popSheet, 'Total Population'), hu = saepSheet(huSheet, 'Total Housing Units');
  if (pop.latest !== hu.latest) throw new Error(`population runs to ${pop.latest} but housing units to ${hu.latest}`);
  const rows = {};
  for (const [g, [p20, p]] of Object.entries(pop.rows)) {
    const h = hu.rows[g];
    rows[g] = [p20, p, h ? h[0] : null, h ? h[1] : null];
  }
  const sum = i => Object.values(rows).reduce((t, r) => t + (r[i] || 0), 0);
  const tot = { pop20: sum(0), pop: sum(1), hu20: sum(2), hu: sum(3), tracts: Object.keys(rows).length };
  log(`SAEP tracts: ${tot.tracts}; population ${tot.pop20} (2020) -> ${tot.pop} (${pop.latest}); housing units ${tot.hu20} -> ${tot.hu}`);
  // OFM's adjusted 2020 count for the state is 7,706,310; housing ~3.2 million.
  if (tot.tracts < 1700) throw new Error(`only ${tot.tracts} tracts`);
  if (tot.pop20 < 7.5e6 || tot.pop20 > 7.9e6) throw new Error(`implausible 2020 population ${tot.pop20}`);
  if (tot.pop < 7.5e6 || tot.pop > 9.5e6) throw new Error(`implausible ${pop.latest} population ${tot.pop}`);
  if (tot.hu20 < 2.8e6 || tot.hu20 > 3.6e6 || tot.hu < tot.hu20 * 0.95 || tot.hu > tot.hu20 * 1.4) throw new Error(`implausible housing units ${tot.hu20} -> ${tot.hu}`);
  if (Object.keys(pop.counties).length !== 39) throw new Error(`SAEP lists ${Object.keys(pop.counties).length} counties, not 39`);

  // The newest GMA projection set (published every five years or so). Only a
  // year that is not published (a 4xx answer, or not a workbook) moves on to
  // an older one; any other failure keeps the projections the last good file had.
  let county = null, gmaError = null;
  const thisYear = new Date().getUTCFullYear();
  for (let y = thisYear; y >= 2022 && !county && !gmaError; y--) {
    let sheets;
    try { sheets = await readXlsx(GMA_URL(y)); }
    catch (e) {
      if (/HTTP 4\d\d |is not an \.xlsx/.test(e.message)) continue; // not published that year
      gmaError = e;
      break;
    }
    try {
      const g = gmaSheet(sheets, pop.counties);
      const n = Object.keys(g.rows).length;
      if (n !== 39) throw new Error(`${n} counties read, not 39`);
      const i20 = g.years.indexOf(2020);
      const countySum = i20 < 0 ? 0 : Object.values(g.rows).reduce((t, r) => t + r[i20], 0);
      if (i20 < 0 || !g.state || Math.abs(countySum - g.state[i20]) > g.state[i20] * 0.01) throw new Error(`counties sum to ${countySum}, state ${g.state && g.state[i20]}`);
      county = { series: g.series, vintage: y, years: g.years, rows: g.rows };
      log(`GMA ${y} projections (middle series): ${n} counties, years ${g.years.join(', ')}; state ${g.state.join(' / ')}`);
    } catch (e) {
      // A layout this step cannot read: fall back to the previous set.
      log(`WARNING GMA ${y} workbook not usable: ${e.message}`);
    }
  }
  const prev = await readJSON(`${outDir}/growth.json`, null);
  const prevCounty = prev && prev.county && Array.isArray(prev.county.years) && prev.county.rows ? prev.county : null;
  if (prevCounty && (!county || prevCounty.vintage > county.vintage)) {
    log(`WARNING GMA projections not refreshed (${gmaError ? gmaError.message : county ? `found ${county.vintage}, older than the ${prevCounty.vintage} set on file` : 'no workbook found'}); keeping the ${prevCounty.vintage} set from the last build`);
    county = prevCounty;
  } else if (!county) log(`WARNING no GMA county projections (${gmaError ? gmaError.message : 'no workbook found'}); the county outlook is left out`);

  const doc = {
    built: new Date().toISOString(),
    source: 'Washington State Office of Financial Management: Small Area Estimates Program (census tract population and housing units)' +
      (county ? `; ${county.vintage} Growth Management Act county population projections, middle series` : ''),
    tract: { base: 2020, latest: pop.latest, fields: TRACT_FIELDS, rows },
    county
  };
  const bytes = await writeJSON(`${outDir}/growth.json`, doc);
  return { latest: pop.latest, tracts: tot.tracts, statePop: tot.pop, gma: county ? county.vintage : null, gmaCarried: !!county && county === prevCounty, bytes };
}
