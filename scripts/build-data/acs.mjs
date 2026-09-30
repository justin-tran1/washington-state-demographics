// ACS 5-year demographics + health insurance for every Washington county and
// census tract.
//
// Why not the Census Data API: since 2025 it answers every keyless request
// with an HTML "Missing Key" page instead of data. This step therefore reads
// the Census Bureau's keyless table-based Summary Files when no
// CENSUS_API_KEY secret is configured. Both paths publish the same estimates.
//
// Output: data/acs/county.json and data/acs/tract.json, columnar:
//   { vintage, span, source, level, fields: [...], rows: { GEOID: [values] } }

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fetchRetry, fetchJSON, fetchText, qs, log, round, writeJSON, WA_FIPS, unzipText, parseGazetteer } from './lib.mjs';

const SF_BASE = y => `https://www2.census.gov/programs-surveys/acs/summary_file/${y}/table-based-SF/data/5YRData`;
// Variable metadata. It still answers without a key (data queries do not);
// the key is sent when configured.
const META = (y, t) => `https://api.census.gov/data/${y}/acs/acs5/groups/${t}.json` +
  (process.env.CENSUS_API_KEY ? `?key=${encodeURIComponent(process.env.CENSUS_API_KEY)}` : '');
const TIGERWEB = y => `https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS${y}`;

// Detailed tables and estimate lines used (the Summary Files carry detailed
// tables only, not subject tables such as S2701, S2703 or S2704). The health
// insurance tables are added from their metadata, below.
const TABLES = {
  B01003: ['001'],                          // total population
  B01002: ['001'],                          // median age
  B19013: ['001'],                          // median household income
  B19301: ['001'],                          // per-capita income
  B25077: ['001'],                          // median value, owner-occupied units
  B25064: ['001'],                          // median gross rent
  B15003: ['001', '022', '023', '024', '025'], // pop 25+, bachelor's, master's, professional, doctorate
  B17001: ['001', '002'],                   // poverty universe, below poverty
  B23025: ['003', '005'],                   // civilian labor force, unemployed
  B25003: ['001', '002'],                   // occupied units, owner-occupied
  B11001: ['001']                           // households
};

// ---- health insurance --------------------------------------------------
// Universe: the civilian noninstitutionalized population.
//  - B27010 (types of health insurance coverage by age) splits it into
//    mutually exclusive coverage combinations: the uninsured share and the
//    payer mix come from it.
//  - B27002-B27009 count everyone holding each type of coverage, alone or
//    with other types: the insurance sources (they add up to more than 100%).
// Every line is identified from its Census label at build time, nothing is
// hardcoded. A line that cannot be identified stops the step, so the last
// good files stay published.

// Coverage-by-type tables: [table, what each "With ..." line must say,
// what it must not say (catches a table number pointing somewhere else)].
export const SOURCE_TABLES = {
  srcPrivate: ['B27002', /private/i, /employer|direct|tricare/i],
  srcPublic: ['B27003', /public/i, /medicare|medicaid|\bva\b/i],
  srcEmployer: ['B27004', /employer/i, /direct|medicare|medicaid/i],
  srcDirect: ['B27005', /direct[- ]purchase/i, /employer|medicare|medicaid/i],
  srcMedicare: ['B27006', /medicare/i, /medicaid|employer|direct/i],
  srcMedicaid: ['B27007', /medicaid|means[- ]tested/i, /medicare|employer|direct/i],
  srcTricare: ['B27008', /tricare|military/i, /employer|direct|medicare|medicaid/i],
  srcVA: ['B27009', /\bva\b|veterans/i, /employer|direct|medicare|medicaid/i]
};

// Payer mix: each B27010 combination goes to one payer, following KFF's
// hierarchy for its "Health Insurance Coverage of the Total Population"
// where the ACS tables allow it: anyone with Medicaid (dual eligibles
// included) under Medicaid; Medicare with employer or direct-purchase
// coverage under Medicare; employer with direct-purchase under employer;
// TRICARE and VA under military. KFF also moves full-time workers with
// Medicare and employer coverage to employer, which needs work status these
// tables lack. The combinations B27010 does not spell out ("other private
// only", "other public only", "other coverage combinations") stay together
// as "other".
export const PAYER_OF = {
  employerOnly: 'employer', 'employer+direct': 'employer',
  directOnly: 'direct',
  medicareOnly: 'medicare', 'employer+medicare': 'medicare', 'direct+medicare': 'medicare',
  medicaidOnly: 'medicaid', 'medicare+medicaid': 'medicaid',
  tricareOnly: 'military', vaOnly: 'military',
  otherPrivate: 'other', otherPublic: 'other', otherMixed: 'other',
  uninsured: 'uninsured'
};
export const PAYERS = ['employer', 'direct', 'medicare', 'medicaid', 'military', 'other', 'uninsured'];
const COVERAGE_TYPES = [
  ['employer', /employer/], ['direct', /direct[- ]purchase/], ['medicare', /medicare/],
  ['medicaid', /medicaid|means[- ]tested/], ['tricare', /tricare|military/], ['va', /\bva\b|veterans/]
];

/** A B27010 line label ("With employer-based health insurance only") -> its kind. */
export function payerKind(label) {
  const s = String(label).toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^no health insurance/.test(s)) return 'uninsured';
  if (/^other private only/.test(s)) return 'otherPrivate';
  if (/^other public only/.test(s)) return 'otherPublic';
  if (/^other coverage/.test(s)) return 'otherMixed';
  const types = COVERAGE_TYPES.filter(([, re]) => re.test(s)).map(([k]) => k);
  const only = / only$/.test(s);
  if (only && types.length === 1) return types[0] + 'Only';
  if (!only && types.length === 2) return types.join('+');
  return null;
}

/** A table's estimate lines from its Census metadata: [{ line, path, leaf }]. */
export function tableLines(table, meta) {
  const re = new RegExp(`^${table}_(\\d{3})E$`);
  const rows = Object.entries((meta && meta.variables) || {}).map(([k, v]) => {
    const m = k.match(re);
    return m && { line: m[1], path: String(v.label || '').split('!!').slice(1).map(p => p.replace(/:$/, '').trim()) };
  }).filter(Boolean).sort((a, b) => a.line.localeCompare(b.line));
  const total = rows.find(r => r.line === '001');
  if (!total || total.path.length !== 1 || !/^total$/i.test(total.path[0])) throw new Error(`${table}_001E is not the table total`);
  // A leaf is a line no other line breaks down further.
  for (const r of rows) r.leaf = !rows.some(o => o.path.length > r.path.length && r.path.every((p, i) => o.path[i] === p));
  return rows;
}

/** B27010 leaf lines grouped by kind; every leaf must be recognised. */
export function payerLines(rows) {
  const byKind = {};
  for (const r of rows.filter(x => x.leaf && x.line !== '001')) {
    const kind = payerKind(r.path[r.path.length - 1]);
    if (!kind || !PAYER_OF[kind]) throw new Error(`B27010_${r.line}E not recognised: "${r.path.join(' > ')}"`);
    (byKind[kind] = byKind[kind] || []).push(r.line);
  }
  if (!byKind.uninsured || byKind.uninsured.length < 3) throw new Error(`B27010: expected >=3 uninsured lines, found ${(byKind.uninsured || []).join(',')}`);
  for (const k of ['employerOnly', 'directOnly', 'medicareOnly', 'medicaidOnly', 'medicare+medicaid']) {
    if (!byKind[k]) throw new Error(`B27010: no "${k}" line`);
  }
  return byKind;
}

/** A coverage-by-type table's "With ..." and "No ..." leaf lines, checked. */
export function sourceLines(table, rows, must, mustNot) {
  const leaves = rows.filter(r => r.leaf && r.line !== '001');
  const last = r => r.path[r.path.length - 1];
  const withL = leaves.filter(r => /^with\b/i.test(last(r))), noL = leaves.filter(r => /^no\b/i.test(last(r)));
  const bad = withL.find(r => !must.test(last(r)) || (mustNot && mustNot.test(last(r))));
  if (bad || withL.length < 4 || withL.length !== noL.length || withL.length + noL.length !== leaves.length) {
    const eg = bad || leaves.find(r => !withL.includes(r) && !noL.includes(r)) || leaves[0];
    throw new Error(`${table}: unexpected lines (${withL.length} with, ${noL.length} no, ${leaves.length} in all; e.g. "${eg ? eg.path.join(' > ') : '-'}")`);
  }
  return { table, with: withL.map(r => r.line), no: noL.map(r => r.line) };
}

/** Metadata for every insurance table: the B27010 kinds and the source lines. */
async function insuranceLines(y) {
  const meta = async t => {
    try { return await fetchJSON(META(y, t)); }
    catch (err) { throw new Error(`${t} metadata unavailable (${err.message.replace(/key=[^&\s]+/, 'key=***')})`); }
  };
  const payer = payerLines(tableLines('B27010', await meta('B27010')));
  log('B27010 lines: ' + Object.entries(payer).map(([k, ls]) => `${k} ${ls.join('+')}`).join('; '));
  const sources = {};
  for (const [field, [table, must, mustNot]] of Object.entries(SOURCE_TABLES)) {
    sources[field] = sourceLines(table, tableLines(table, await meta(table)), must, mustNot);
    log(`${table} (${field}): "with" lines ${sources[field].with.join(',')}`);
  }
  return { payer, sources };
}

export const FIELDS = ['pop', 'households', 'medAge', 'medInc', 'perCap', 'medHome', 'medRent',
  'pctBach', 'pctPoverty', 'pctUnemp', 'pctOwner', 'insUniverse', 'pctInsured', 'pctUninsured',
  'aland', 'lat', 'lon',
  // payer mix (B27010, mutually exclusive, % of the universe; pmDual is part of pmMedicaid)
  'pmEmployer', 'pmDirect', 'pmMedicare', 'pmMedicaid', 'pmMilitary', 'pmOther', 'pmDual',
  // insurance sources (B27002-B27009, alone or in combination, % of the universe)
  'srcPrivate', 'srcEmployer', 'srcDirect', 'srcTricare', 'srcPublic', 'srcMedicare', 'srcMedicaid', 'srcVA'];

/** Newest ACS 5-year vintage whose Summary File directory exists. */
async function newestVintage() {
  const thisYear = new Date().getUTCFullYear();
  for (let y = thisYear; y >= thisYear - 4; y--) {
    try {
      const res = await fetchRetry(`${SF_BASE(y)}/acsdt5y${y}-b01003.dat`, { method: 'HEAD' }, { retries: 1, timeoutMs: 30000 });
      if (res.ok) return y;
    } catch (e) { /* try older */ }
  }
  throw new Error('no ACS 5-year Summary File found for the last five vintages');
}

/** Stream one national Summary File table, keeping only WA counties/tracts. */
async function readTable(y, table, lines) {
  const url = `${SF_BASE(y)}/acsdt5y${y}-${table.toLowerCase()}.dat`;
  const res = await fetchRetry(url, {}, { retries: 3, timeoutMs: 30 * 60 * 1000 });
  if (!res.ok) throw new Error(`${table}: HTTP ${res.status}`);
  const rl = createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity });
  let header = null, idx = null;
  const county = {}, tract = {};
  const cPrefix = `0500000US${WA_FIPS}`, tPrefix = `1400000US${WA_FIPS}`;
  for await (const line of rl) {
    if (!header) {
      header = line.split('|');
      idx = Object.fromEntries(lines.map(l => [l, header.indexOf(`${table}_E${l}`)]));
      const missing = lines.filter(l => idx[l] < 0);
      if (missing.length) throw new Error(`${table}: columns missing from header: ${missing.join(',')}`);
      continue;
    }
    const isC = line.startsWith(cPrefix), isT = !isC && line.startsWith(tPrefix);
    if (!isC && !isT) continue;
    const cols = line.split('|');
    const geoid = cols[0].slice(9); // strip "0500000US"
    const vals = {};
    for (const l of lines) {
      const v = Number(cols[idx[l]]);
      // ACS jam values (negative sentinels) and blanks mean "suppressed".
      vals[l] = cols[idx[l]] === '' || !isFinite(v) || v < 0 ? null : v;
    }
    (isC ? county : tract)[geoid] = vals;
  }
  log(`${table}: ${Object.keys(county).length} counties, ${Object.keys(tract).length} tracts`);
  return { county, tract };
}

/** Same values from the Census Data API, when a key is configured. */
async function readTableAPI(y, table, lines, key) {
  const out = { county: {}, tract: {} };
  // The API takes at most 50 variables per call.
  for (let i = 0; i < lines.length; i += 45) {
    const chunk = lines.slice(i, i + 45);
    const vars = chunk.map(l => `${table}_${l}E`);
    for (const [level, forClause, inClause] of [
      ['county', 'county:*', `state:${WA_FIPS}`],
      ['tract', 'tract:*', `state:${WA_FIPS} county:*`]
    ]) {
      const url = `https://api.census.gov/data/${y}/acs/acs5?${qs({ get: vars.join(','), for: forClause, in: inClause, key })}`;
      const table2 = await fetchJSON(url);
      const h = table2[0];
      for (const r of table2.slice(1)) {
        const rec = Object.fromEntries(h.map((k, j) => [k, r[j]]));
        const geoid = rec.state + rec.county + (rec.tract || '');
        const vals = out[level][geoid] = out[level][geoid] || {};
        for (const l of chunk) {
          const v = Number(rec[`${table}_${l}E`]);
          vals[l] = !isFinite(v) || v < 0 ? null : v;
        }
      }
    }
  }
  return out;
}

/** Census tract display name from its 6-digit code: 005302 -> "53.02". */
function tractName(geoid) {
  const code = geoid.slice(5);
  const base = parseInt(code.slice(0, 4), 10), suffix = code.slice(4);
  return `Census Tract ${suffix === '00' ? base : base + '.' + suffix}`;
}

/**
 * Land area, internal point and name for every WA county and tract.
 * Primary source is the Census Gazetteer files (keyless, flat, exactly the
 * fields needed); TIGERweb is the fallback.
 */
async function geoAttributes(y) {
  for (const gy of [y, y - 1, y - 2]) {
    try { return await gazetteer(gy); }
    catch (err) { log(`Gazetteer ${gy} unavailable: ${err.message}`); }
  }
  log('falling back to TIGERweb for land area and internal points');
  return tigerAttributes(y);
}

async function gazetteer(gy) {
  const dir = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${gy}_Gazetteer/`;
  // File naming has varied between vintages (case, national vs per-state,
  // .txt vs .zip), so discover the real names from the directory listing.
  const listing = await fetchText(dir);
  const files = [...new Set([...listing.matchAll(/href="([^"]+\.(?:txt|zip))"/gi)].map(m => m[1]))];
  const find = re => files.find(f => re.test(f));
  const countyFile = find(/gaz_counties_national\.txt$/i) || find(/gaz_counties_national\.zip$/i);
  const tractFile = find(new RegExp(`gaz_tracts_${WA_FIPS}\\.txt$`, 'i')) || find(/gaz_tracts_national\.txt$/i)
    || find(/gaz_tracts_national\.zip$/i);
  if (!countyFile || !tractFile) throw new Error(`county/tract files not listed (saw: ${files.slice(0, 12).join(', ')})`);
  log(`Gazetteer ${gy}: using ${countyFile}, ${tractFile}`);
  const load = async name => (/\.zip$/i.test(name) ? unzipText(dir + name) : fetchText(dir + name));
  const parse = parseGazetteer;
  const out = { county: {}, tract: {} };
  for (const r of parse(await load(countyFile))) {
    if (!r.GEOID || !r.GEOID.startsWith(WA_FIPS)) continue;
    out.county[r.GEOID] = { name: r.NAME, aland: +r.ALAND, lat: round(+r.INTPTLAT), lon: round(+r.INTPTLONG) };
  }
  for (const r of parse(await load(tractFile))) {
    if (!r.GEOID || !r.GEOID.startsWith(WA_FIPS)) continue;
    out.tract[r.GEOID] = { name: tractName(r.GEOID), aland: +r.ALAND, lat: round(+r.INTPTLAT), lon: round(+r.INTPTLONG) };
  }
  if (Object.keys(out.county).length !== 39) throw new Error(`expected 39 counties, got ${Object.keys(out.county).length}`);
  if (Object.keys(out.tract).length < 1500) throw new Error(`only ${Object.keys(out.tract).length} tracts`);
  log(`Gazetteer ${gy}: ${Object.keys(out.county).length} counties, ${Object.keys(out.tract).length} tracts`);
  return out;
}

/** Download a zip and return the text of its single .txt member (runner has unzip). */

/** Fallback: land area + internal point from TIGERweb, choosing whichever
 *  field names the layer actually exposes and logging the full error. */
async function tigerAttributes(y) {
  const out = { county: {}, tract: {} };
  const svc = { county: 'State_County/MapServer', tract: 'Tracts_Blocks/MapServer' };
  const want = { county: /^Counties$/i, tract: /^Census Tracts$/i };
  for (const level of ['county', 'tract']) {
    let root = TIGERWEB(y);
    let info = await fetchJSON(`${root}/${svc[level]}?f=json`).catch(() => null);
    if (!info || info.error) { root = TIGERWEB(y - 1); info = await fetchJSON(`${root}/${svc[level]}?f=json`); }
    // Skip group layers: they share the name but have no fields to query.
    const layer = (info.layers || []).find(l => want[level].test(l.name) && !(l.subLayerIds && l.subLayerIds.length));
    if (!layer) throw new Error(`TIGERweb ${level} layer not found`);
    const layerUrl = `${root}/${svc[level]}/${layer.id}`;
    const linfo = await fetchJSON(`${layerUrl}?f=json`);
    const have = new Set((linfo.fields || []).map(f => f.name));
    const pick = (...c) => c.find(n => have.has(n));
    const F = { geoid: pick('GEOID'), name: pick('NAME', 'BASENAME'), aland: pick('AREALAND', 'ALAND'),
      lat: pick('INTPTLAT', 'CENTLAT'), lon: pick('INTPTLON', 'CENTLON') };
    const outFields = Object.values(F).filter(Boolean).join(',');
    const paged = !!(linfo.advancedQueryCapabilities && linfo.advancedQueryCapabilities.supportsPagination);
    for (let offset = 0; ; offset += 1000) {
      const p = { where: `STATE='${WA_FIPS}'`, outFields, returnGeometry: false, f: 'json' };
      if (paged) Object.assign(p, { resultRecordCount: 1000, resultOffset: offset });
      const data = await fetchJSON(`${layerUrl}/query?${qs(p)}`);
      if (data.error) throw new Error(`TIGERweb ${level}: ${JSON.stringify(data.error)} (fields available: ${[...have].join(',')})`);
      for (const f of data.features || []) {
        const a = f.attributes;
        out[level][a[F.geoid]] = {
          name: level === 'tract' ? tractName(a[F.geoid]) : a[F.name],
          aland: a[F.aland], lat: round(+a[F.lat]), lon: round(+a[F.lon])
        };
      }
      if (!paged || !(data.features || []).length || (!data.exceededTransferLimit && data.features.length < 1000)) break;
    }
    log(`TIGERweb ${level}: ${Object.keys(out[level]).length} features`);
  }
  return out;
}

const pct = (num, den) => (num == null || !den ? null : round(100 * num / den, 2));
const sumOrNull = arr => (arr.some(v => v == null) ? null : arr.reduce((a, b) => a + b, 0));
const sumLines = (vals, lines) => sumOrNull(lines.map(l => vals[l] ?? null));

/**
 * Insurance counts for one area: B27010 by payer (every B27010 line lands in
 * exactly one), and the "with" total of each coverage-by-type table.
 * `T(table)` gives the area's { line: value } for a table.
 */
export function insuranceCounts(T, lines) {
  const ins = T('B27010');
  const payer = Object.fromEntries(PAYERS.map(p => [p, 0]));
  for (const [kind, ls] of Object.entries(lines.payer)) {
    const v = sumLines(ins, ls);
    const p = PAYER_OF[kind];
    payer[p] = payer[p] == null || v == null ? null : payer[p] + v;
  }
  const sources = {};
  for (const [field, s] of Object.entries(lines.sources)) {
    const vals = T(s.table);
    sources[field] = { with: sumLines(vals, s.with), no: sumLines(vals, s.no), total: vals['001'] ?? null };
  }
  return {
    total: ins['001'] ?? null, payer, dual: sumLines(ins, lines.payer['medicare+medicaid']),
    leaves: sumLines(ins, Object.values(lines.payer).flat()), sources
  };
}

export async function buildACS(outDir) {
  const key = process.env.CENSUS_API_KEY || '';
  const y = await newestVintage();
  log(`ACS 5-year vintage ${y} (${y - 4}-${y}); source: ${key ? 'Census Data API (keyed)' : 'keyless Summary Files'}`);
  const insLines = await insuranceLines(y);
  const tables = { ...TABLES, B27010: ['001', ...Object.values(insLines.payer).flat()] };
  for (const s of Object.values(insLines.sources)) tables[s.table] = ['001', ...s.with, ...s.no];

  // Download tables a few at a time: the Census file server throttles each
  // connection to roughly 1 MB/s, so parallelism is what keeps this fast.
  const entries = Object.entries(tables);
  const results = {};
  const workers = Array.from({ length: 4 }, async () => {
    while (entries.length) {
      const [t, lines] = entries.shift();
      results[t] = key ? await readTableAPI(y, t, lines, key) : await readTable(y, t, lines);
    }
  });
  await Promise.all(workers);
  const tiger = await geoAttributes(y);

  // Both files are written only once every check has passed: a failed step
  // must leave the last good files in place (the workflow commits data/).
  const summary = {}, docs = {};
  for (const level of ['county', 'tract']) {
    const rows = {};
    const geoids = Object.keys(results.B01003[level]);
    // Statewide sums (from the counties) for the checks and the build log.
    const state = { total: 0, payer: Object.fromEntries(PAYERS.map(p => [p, 0])), dual: 0, src: {}, srcTotal: {} };
    const mismatch = [];
    for (const g of geoids) {
      const T = t => results[t][level][g] || {};
      const ic = insuranceCounts(T, insLines);
      const insTotal = ic.total;
      // Components must add up to their totals: a wrong line mapping would not.
      if (ic.leaves != null && insTotal != null && ic.leaves !== insTotal) mismatch.push(`${g} B27010 ${ic.leaves}/${insTotal}`);
      for (const [f, c] of Object.entries(ic.sources)) {
        if (c.with != null && c.no != null && c.total != null && c.with + c.no !== c.total) mismatch.push(`${g} ${insLines.sources[f].table} ${c.with}+${c.no}/${c.total}`);
      }
      if (level === 'county' && insTotal && PAYERS.every(p => ic.payer[p] != null)) {
        state.total += insTotal;
        for (const p of PAYERS) state.payer[p] += ic.payer[p];
        state.dual += ic.dual || 0;
        for (const [f, c] of Object.entries(ic.sources)) {
          if (c.with == null || !c.total) continue;
          state.src[f] = (state.src[f] || 0) + c.with;
          state.srcTotal[f] = (state.srcTotal[f] || 0) + c.total;
        }
      }
      const pctUnins = pct(ic.payer.uninsured, insTotal);
      const srcPct = f => pct(ic.sources[f].with, ic.sources[f].total);
      const tg = tiger[level][g] || {};
      const rec = {
        pop: T('B01003')['001'] ?? null,
        households: T('B11001')['001'] ?? null,
        medAge: T('B01002')['001'] ?? null,
        medInc: T('B19013')['001'] ?? null,
        perCap: T('B19301')['001'] ?? null,
        medHome: T('B25077')['001'] ?? null,
        medRent: T('B25064')['001'] ?? null,
        pctBach: pct(sumOrNull(['022', '023', '024', '025'].map(l => T('B15003')[l] ?? null)), T('B15003')['001']),
        pctPoverty: pct(T('B17001')['002'], T('B17001')['001']),
        pctUnemp: pct(T('B23025')['005'], T('B23025')['003']),
        pctOwner: pct(T('B25003')['002'], T('B25003')['001']),
        insUniverse: insTotal ?? null,
        pctInsured: pctUnins == null ? null : round(100 - pctUnins, 2),
        pctUninsured: pctUnins,
        aland: tg.aland ?? null, lat: tg.lat ?? null, lon: tg.lon ?? null,
        pmEmployer: pct(ic.payer.employer, insTotal), pmDirect: pct(ic.payer.direct, insTotal),
        pmMedicare: pct(ic.payer.medicare, insTotal), pmMedicaid: pct(ic.payer.medicaid, insTotal),
        pmMilitary: pct(ic.payer.military, insTotal), pmOther: pct(ic.payer.other, insTotal),
        pmDual: pct(ic.dual, insTotal),
        srcPrivate: srcPct('srcPrivate'), srcEmployer: srcPct('srcEmployer'), srcDirect: srcPct('srcDirect'),
        srcTricare: srcPct('srcTricare'), srcPublic: srcPct('srcPublic'), srcMedicare: srcPct('srcMedicare'),
        srcMedicaid: srcPct('srcMedicaid'), srcVA: srcPct('srcVA')
      };
      rows[g] = FIELDS.map(f => rec[f]);
    }
    if (mismatch.length) throw new Error(`${level}: ${mismatch.length} areas whose insurance lines do not add up, e.g. ${mismatch.slice(0, 3).join('; ')}`);
    // Tract names read "Census Tract 1.01, King County"; counties "King County".
    const nameOf = g => {
      const own = (tiger[level][g] || {}).name || null;
      if (level !== 'tract') return own;
      const county = (tiger.county[g.slice(0, 5)] || {}).name;
      return own && county ? `${own}, ${county}` : own;
    };
    const names = Object.fromEntries(geoids.map(g => [g, nameOf(g)]));
    docs[level] = {
      vintage: y, span: `${y - 4}-${y}`, level,
      source: key ? 'U.S. Census Bureau, ACS 5-Year, Census Data API'
        : 'U.S. Census Bureau, ACS 5-Year Summary File (table-based)',
      insurance: {
        universe: 'Civilian noninstitutionalized population',
        uninsured: `B27010 lines ${insLines.payer.uninsured.join('+')} / B27010_001`,
        payerMix: Object.fromEntries(PAYERS.map(p => [p, Object.entries(insLines.payer)
          .filter(([k]) => PAYER_OF[k] === p).map(([k, ls]) => `${k}: B27010 ${ls.join('+')}`)])),
        sources: Object.fromEntries(Object.entries(insLines.sources).map(([f, s]) => [f, `${s.table} lines ${s.with.join('+')} / ${s.table}_001`]))
      },
      built: new Date().toISOString(), fields: FIELDS, names, rows
    };
    // Sanity checks that would catch a silently wrong column mapping.
    const vals = Object.values(rows);
    const col = f => vals.map(r => r[FIELDS.indexOf(f)]).filter(v => v != null);
    const med = a => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
    const s = {
      rows: vals.length,
      totalPop: col('pop').reduce((a, b) => a + b, 0),
      medianIncome: med(col('medInc')), medianUninsuredPct: med(col('pctUninsured')),
      withArea: col('aland').length, withPayerMix: col('pmEmployer').length
    };
    if (level === 'county' && vals.length !== 39) throw new Error(`expected 39 WA counties, got ${vals.length}`);
    if (s.totalPop < 7e6 || s.totalPop > 9e6) throw new Error(`implausible WA population ${s.totalPop} at ${level} level`);
    if (!(s.medianUninsuredPct > 1 && s.medianUninsuredPct < 25)) throw new Error(`implausible uninsured median ${s.medianUninsuredPct}%`);
    if (level === 'county') {
      // Statewide shares, checked against wide bounds that a mislabelled
      // line would break, and kept in the manifest.
      const sh = n => round(100 * n / state.total, 1);
      s.statewide = {
        payerMix: Object.fromEntries(PAYERS.map(p => [p, sh(state.payer[p])])), dual: sh(state.dual),
        sources: Object.fromEntries(Object.keys(SOURCE_TABLES).map(f => [f, round(100 * state.src[f] / state.srcTotal[f], 1)]))
      };
      const B = { employer: [35, 70], direct: [2, 20], medicare: [8, 30], medicaid: [8, 35], military: [0.5, 10], other: [0, 15], uninsured: [1, 25],
        srcPrivate: [50, 85], srcEmployer: [40, 75], srcDirect: [4, 25], srcTricare: [1, 10], srcPublic: [20, 50], srcMedicare: [10, 30], srcMedicaid: [10, 35], srcVA: [0.5, 6] };
      const shares = { ...s.statewide.payerMix, ...s.statewide.sources };
      const off = Object.entries(B).filter(([k, [lo, hi]]) => !(shares[k] >= lo && shares[k] <= hi));
      if (off.length) throw new Error(`implausible statewide insurance shares: ${off.map(([k]) => `${k} ${shares[k]}%`).join(', ')}`);
      const sum = PAYERS.reduce((a, p) => a + state.payer[p], 0);
      if (sum !== state.total) throw new Error(`payer mix covers ${sum} of ${state.total} people`);
    }
    summary[level] = s;
  }
  for (const level of ['county', 'tract']) summary[level].bytes = await writeJSON(`${outDir}/acs/${level}.json`, docs[level]);
  return { vintage: y, keyless: !key, ...summary };
}
