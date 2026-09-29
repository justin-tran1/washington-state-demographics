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
import { fetchRetry, fetchJSON, fetchText, qs, log, round, writeJSON, WA_FIPS } from './lib.mjs';

const SF_BASE = y => `https://www2.census.gov/programs-surveys/acs/summary_file/${y}/table-based-SF/data/5YRData`;
const META = (y, t) => `https://api.census.gov/data/${y}/acs/acs5/groups/${t}.json`; // keyless
const TIGERWEB = y => `https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS${y}`;

// Detailed tables and estimate lines used. Insurance uses detailed table
// B27010 (the Summary Files carry detailed tables only, not subject tables
// such as S2701); its "No health insurance coverage" lines are located from
// the Census variable metadata at build time rather than hardcoded.
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
  B11001: ['001'],                          // households
  B27010: null                              // resolved from metadata
};

export const FIELDS = ['pop', 'households', 'medAge', 'medInc', 'perCap', 'medHome', 'medRent',
  'pctBach', 'pctPoverty', 'pctUnemp', 'pctOwner', 'insUniverse', 'pctInsured', 'pctUninsured',
  'aland', 'lat', 'lon'];

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

/** Find B27010's "No health insurance coverage" estimate lines from metadata. */
async function uninsuredLines(y) {
  const meta = await fetchJSON(META(y, 'B27010'));
  const lines = Object.entries(meta.variables || {})
    .filter(([k, v]) => /^B27010_\d{3}E$/.test(k) && /No health insurance coverage$/i.test(v.label || ''))
    .map(([k]) => k.slice(7, 10)).sort();
  if (lines.length < 3) throw new Error(`expected >=3 uninsured lines in B27010, found ${lines.join(',')}`);
  const total = meta.variables.B27010_001E;
  if (!total || !/^Estimate!!Total/.test(total.label)) throw new Error('B27010_001E is not the table total');
  log(`B27010 uninsured lines: ${lines.join(', ')} (universe: ${total.universe || meta.variables.B27010_001E.universe})`);
  return lines;
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
  const vars = lines.map(l => `${table}_${l}E`);
  const out = { county: {}, tract: {} };
  for (const [level, forClause, inClause] of [
    ['county', 'county:*', `state:${WA_FIPS}`],
    ['tract', 'tract:*', `state:${WA_FIPS} county:*`]
  ]) {
    const url = `https://api.census.gov/data/${y}/acs/acs5?${qs({ get: vars.join(','), for: forClause, in: inClause, key })}`;
    const table2 = await fetchJSON(url);
    const h = table2[0];
    for (const r of table2.slice(1)) {
      const rec = Object.fromEntries(h.map((k, i) => [k, r[i]]));
      const geoid = rec.state + rec.county + (rec.tract || '');
      out[level][geoid] = Object.fromEntries(lines.map(l => {
        const v = Number(rec[`${table}_${l}E`]);
        return [l, !isFinite(v) || v < 0 ? null : v];
      }));
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
  const parse = text => {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const head = lines[0].split('\t').map(h => h.trim());
    return lines.slice(1).map(l => {
      const c = l.split('\t');
      return Object.fromEntries(head.map((h, i) => [h, (c[i] || '').trim()]));
    });
  };
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
async function unzipText(url) {
  const { execFileSync } = await import('node:child_process');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const res = await fetchRetry(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const d = await mkdtemp(`${tmpdir()}/gaz-`);
  await writeFile(`${d}/f.zip`, Buffer.from(await res.arrayBuffer()));
  return execFileSync('unzip', ['-p', `${d}/f.zip`], { maxBuffer: 1 << 30 }).toString('latin1');
}

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

export async function buildACS(outDir) {
  const key = process.env.CENSUS_API_KEY || '';
  const y = await newestVintage();
  log(`ACS 5-year vintage ${y} (${y - 4}-${y}); source: ${key ? 'Census Data API (keyed)' : 'keyless Summary Files'}`);
  const tables = { ...TABLES, B27010: ['001', ...await uninsuredLines(y)] };

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

  const summary = {};
  for (const level of ['county', 'tract']) {
    const rows = {};
    const geoids = Object.keys(results.B01003[level]);
    for (const g of geoids) {
      const T = t => results[t][level][g] || {};
      const ins = T('B27010');
      const insTotal = ins['001'];
      const uninsured = sumOrNull(tables.B27010.slice(1).map(l => ins[l] ?? null));
      const pctUnins = pct(uninsured, insTotal);
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
        aland: tg.aland ?? null, lat: tg.lat ?? null, lon: tg.lon ?? null
      };
      rows[g] = FIELDS.map(f => rec[f]);
    }
    // Tract names read "Census Tract 1.01, King County"; counties "King County".
    const nameOf = g => {
      const own = (tiger[level][g] || {}).name || null;
      if (level !== 'tract') return own;
      const county = (tiger.county[g.slice(0, 5)] || {}).name;
      return own && county ? `${own}, ${county}` : own;
    };
    const names = Object.fromEntries(geoids.map(g => [g, nameOf(g)]));
    const bytes = await writeJSON(`${outDir}/acs/${level}.json`, {
      vintage: y, span: `${y - 4}-${y}`, level,
      source: key ? 'U.S. Census Bureau, ACS 5-Year, Census Data API'
        : 'U.S. Census Bureau, ACS 5-Year Summary File (table-based)',
      insurance: `detailed table B27010: uninsured = lines ${tables.B27010.slice(1).join('+')} / line 001`,
      built: new Date().toISOString(), fields: FIELDS, names, rows
    });
    // Sanity checks that would catch a silently wrong column mapping.
    const vals = Object.values(rows);
    const col = f => vals.map(r => r[FIELDS.indexOf(f)]).filter(v => v != null);
    const med = a => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
    const s = {
      rows: vals.length, bytes,
      totalPop: col('pop').reduce((a, b) => a + b, 0),
      medianIncome: med(col('medInc')), medianUninsuredPct: med(col('pctUninsured')),
      withArea: col('aland').length
    };
    if (level === 'county' && vals.length !== 39) throw new Error(`expected 39 WA counties, got ${vals.length}`);
    if (s.totalPop < 7e6 || s.totalPop > 9e6) throw new Error(`implausible WA population ${s.totalPop} at ${level} level`);
    if (!(s.medianUninsuredPct > 1 && s.medianUninsuredPct < 25)) throw new Error(`implausible uninsured median ${s.medianUninsuredPct}%`);
    summary[level] = s;
  }
  return { vintage: y, keyless: !key, ...summary };
}
