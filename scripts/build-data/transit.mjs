// Transit agency links for the route and stop popups.
//
// WSDOT's statewide TransitData route layer already carries each route's
// GTFS route_url (its schedule page) and agency_name, but not the agency's
// website, and its stop layer carries no agency at all. This step writes
// data/transit/agencies.json with:
//   agencies: normAgency(name) -> { name, url, source }
//   prefixes: route_id/stop_id prefix (e.g. "KCM") -> normAgency(name), for
//             prefixes whose routes (nearly) all belong to one agency
// Agency websites come from each agency's own GTFS agency.txt (agency_url),
// located through the Mobility Database feed catalog; when a feed cannot be
// matched, the most common origin of the agency's own route_url pages is used.

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fetchRetry, fetchText, arcgisAll, log, writeJSON, readJSON } from './lib.mjs';

const ROUTES = 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer/3';
const CATALOG = 'https://files.mobilitydatabase.org/feeds_v2.csv';

/** Minimal RFC-4180 CSV parser (GTFS and the catalog are CSV with optional quotes). */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.replace(/^﻿/, '').trim());
  return rows.map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

// Kept identical to normAgency() in assets/js/layers/transit.js.
export const normAgency = s => String(s || '').toLowerCase()
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|inc|llc)\b/g, '').replace(/\s+/g, ' ').trim();

const okUrl = u => /^https?:\/\/[^\s/]+\.[a-z]{2,}/i.test(u || '');
const withScheme = u => (u && !/^https?:\/\//i.test(u) ? 'https://' + u : u);
const tokens = s => new Set(normAgency(s).split(' ').filter(w => w.length > 2 && !/^(transit|transportation|authority|public|county|city|system|area|district|of)$/.test(w)));
/**
 * Names that mostly share words. Overlap is measured against the LONGER
 * name: "Columbia Area Transit" shares one word of three with "Lower
 * Columbia CAP", and "City of Seattle" is not "Seattle Children's Hospital".
 */
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return false;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size) >= 0.6;
}
// A route_url on a file host or CDN (a schedule PDF) says nothing about the
// agency's own website.
const FILE_HOST = /(^|\.)(wsimg\.com|amazonaws\.com|cloudfront\.net|googleusercontent\.com|googleapis\.com|google\.com|dropbox\.com|box\.com|sharepoint\.com|1drv\.ms|onedrive\.live\.com|windows\.net|azureedge\.net|squarespace-cdn\.com|wixstatic\.com|filesusr\.com|cdn\.[a-z0-9.-]+|hubspotusercontent[a-z0-9-]*\.net|bit\.ly|tinyurl\.com)$/i;

/** agency.txt rows out of one GTFS zip. */
async function readAgencies(url) {
  const res = await fetchRetry(url, {}, { retries: 1, timeoutMs: 180000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const dir = await mkdtemp(`${tmpdir()}/gtfs-`);
  await writeFile(`${dir}/feed.zip`, Buffer.from(await res.arrayBuffer()));
  // -j junks paths: some feeds nest their files one directory down.
  try { execFileSync('unzip', ['-o', '-j', '-q', `${dir}/feed.zip`, '*agency.txt', '-d', dir]); }
  catch (e) { /* unzip exits non-zero when the pattern is absent */ }
  const files = await readdir(dir);
  return files.includes('agency.txt') ? parseCSV(await readFile(`${dir}/agency.txt`, 'utf8')) : [];
}

export async function buildTransit(outDir) {
  // 1. Agencies and id prefixes as the map's route layer names them.
  const { features } = await arcgisAll(ROUTES, { outFields: 'agency_id,agency_name,route_id,route_url', returnGeometry: false });
  const agencies = {};   // norm -> { name, url, source }
  const prefixRoutes = {}; // "KCM" -> { norm: route count }
  const routeOrigins = {}; // norm -> { origin: count }
  for (const f of features) {
    const a = f.attributes;
    if (!a.agency_name) continue;
    const key = normAgency(a.agency_name);
    agencies[key] = agencies[key] || { name: a.agency_name, url: null, source: null };
    const pre = String(a.route_id || '').split('_')[0];
    if (pre && pre !== a.route_id) {
      prefixRoutes[pre] = prefixRoutes[pre] || {};
      prefixRoutes[pre][key] = (prefixRoutes[pre][key] || 0) + 1;
    }
    const u = withScheme(a.route_url);
    if (okUrl(u)) {
      const o = new URL(u);
      if (!FILE_HOST.test(o.hostname)) {
        routeOrigins[key] = routeOrigins[key] || {};
        routeOrigins[key][o.origin] = (routeOrigins[key][o.origin] || 0) + 1;
      }
    }
  }
  // A feed can carry other agencies' routes (King County Metro's has Sound
  // Transit Express under KCM_ ids), so a prefix names an agency only when
  // that agency runs at least 80% of its routes; stops are labelled by it.
  const prefixes = {};   // "KCM" -> norm
  const ambiguous = [];
  for (const [pre, byAgency] of Object.entries(prefixRoutes)) {
    const [top, n] = Object.entries(byAgency).sort((x, y) => y[1] - x[1])[0];
    const total = Object.values(byAgency).reduce((a, b) => a + b, 0);
    if (n / total >= 0.8) prefixes[pre] = top;
    else ambiguous.push(`${pre} (${Object.entries(byAgency).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  }
  log(`route layer: ${features.length} routes, ${Object.keys(agencies).length} agencies, ${Object.keys(prefixes).length} id prefixes` +
    (ambiguous.length ? `; ambiguous prefixes left unmapped: ${ambiguous.join('; ')}` : ''));

  // 2. agency_url from every active Washington GTFS feed in the catalog.
  const gtfsAgencies = [];
  try {
    const feeds = parseCSV(await fetchText(CATALOG, {}, { timeoutMs: 120000 }))
      .filter(r => r.data_type === 'gtfs' && r['location.country_code'] === 'US' &&
        /washington/i.test(r['location.subdivision_name'] || '') && !/deprecated/i.test(r.status || ''))
      // Deprecated feeds redirect to a replacement; inactive ones still carry
      // a valid agency_url, so they stay but are read after the active ones.
      .sort((a, b) => (/inactive/i.test(a.status || '') ? 1 : 0) - (/inactive/i.test(b.status || '') ? 1 : 0));
    log(`catalog: ${feeds.length} Washington GTFS feeds`);
    for (const feed of feeds) {
      const url = feed['urls.latest'] || feed['urls.direct_download'];
      if (!url) continue;
      try {
        for (const a of await readAgencies(url)) {
          if (a.agency_name && okUrl(withScheme(a.agency_url))) gtfsAgencies.push({ name: a.agency_name, url: withScheme(a.agency_url), feed: feed.provider });
        }
      } catch (err) { log(`  feed ${feed.provider}: ${err.message}`); }
    }
  } catch (err) {
    log(`catalog unavailable: ${err.message}`);
  }
  log(`GTFS agency.txt entries with a website: ${gtfsAgencies.length}`);

  // 3. Match, then fall back to the website found by the previous build (a
  // feed that is briefly unreachable must not cost its agency the link), and
  // only then to the dominant route_url origin.
  const prev = ((await readJSON(`${outDir}/transit/agencies.json`, null)) || {}).agencies || {};
  const perFeed = {};
  for (const g of gtfsAgencies) perFeed[g.feed] = (perFeed[g.feed] || 0) + 1;
  for (const [key, a] of Object.entries(agencies)) {
    // Exact name, then similar name, then the provider name of a feed that
    // holds only one agency (a multi-agency feed's provider says nothing
    // about which of its agencies is which).
    const hit = gtfsAgencies.find(g => normAgency(g.name) === key)
      || gtfsAgencies.find(g => similar(g.name, a.name))
      || gtfsAgencies.find(g => g.feed && perFeed[g.feed] === 1 && similar(g.feed, a.name));
    if (hit) { a.url = hit.url; a.source = 'gtfs agency.txt'; continue; }
    const before = prev[key];
    if (before && before.url && /agency\.txt|previous build/.test(before.source || '')) { a.url = before.url; a.source = 'gtfs agency.txt (previous build)'; continue; }
    const origins = Object.entries(routeOrigins[key] || {}).sort((x, y) => y[1] - x[1]);
    if (origins.length) { a.url = origins[0][0]; a.source = 'route_url origin'; }
  }
  // GTFS agencies the route layer does not name (e.g. ferries, rail) are
  // still useful for stop and OSM-fallback popups.
  for (const g of gtfsAgencies) {
    const key = normAgency(g.name);
    if (!agencies[key]) agencies[key] = { name: g.name, url: g.url, source: 'gtfs agency.txt' };
  }
  const withUrl = Object.values(agencies).filter(a => a.url).length;
  const missing = Object.values(agencies).filter(a => !a.url).map(a => a.name);
  log(`agencies with a website: ${withUrl}/${Object.keys(agencies).length}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
  if (withUrl < 10) throw new Error(`only ${withUrl} agencies with websites`);

  const bytes = await writeJSON(`${outDir}/transit/agencies.json`, {
    built: new Date().toISOString(),
    source: 'WSDOT TransitData routes (agency_name, route_id) + agency GTFS feeds via the Mobility Database catalog',
    agencies, prefixes
  });
  return { routes: features.length, agencies: Object.keys(agencies).length, withUrl, prefixes: Object.keys(prefixes).length,
    ambiguousPrefixes: ambiguous.length, gtfsAgencies: gtfsAgencies.length, bytes };
}
