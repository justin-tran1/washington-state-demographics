// Shared helpers for the build-time data pipeline.
//
// Runs inside GitHub Actions (full internet, Node 22 built-in fetch). Every
// dataset is written as compact, same-origin JSON under data/, so the map
// never depends on an upstream API being reachable - or CORS-enabled - from
// the viewer's browser or corporate network.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const UA = 'washington-state-demographics data build (https://github.com/justin-tran1/washington-state-demographics)';
export const WA_FIPS = '53';
// Washington bounding box, generous enough to include the San Juans and the
// Columbia River boundary: south, west, north, east.
export const WA_BBOX = { s: 45.54, w: -124.85, n: 49.01, e: -116.91 };

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

/** fetch with timeout + retries + exponential backoff. Returns the Response. */
export async function fetchRetry(url, init = {}, { retries = 3, timeoutMs = 90000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { 'User-Agent': UA, ...(init.headers || {}) }
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      if (i < retries) await sleep(2000 * 2 ** i);
    }
  }
  throw new Error(`${new URL(url).host}: ${lastErr && lastErr.message}`);
}

export async function fetchText(url, init, opts) {
  const res = await fetchRetry(url, init, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

export async function fetchJSON(url, init, opts) {
  const text = await fetchText(url, init, opts);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`non-JSON from ${new URL(url).host}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`); }
}

export const qs = p => Object.entries(p).filter(([, v]) => v != null)
  .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

/**
 * Page through an ArcGIS FeatureServer/MapServer layer. Honours the server's
 * own maxRecordCount and the exceededTransferLimit flag, so short pages do not
 * end paging early. Returns an array of { attributes, geometry } (Esri JSON).
 */
export async function arcgisAll(layerUrl, params = {}, { max = 200000 } = {}) {
  const info = await fetchJSON(`${layerUrl}?f=json`);
  if (info.error) throw new Error(`ArcGIS layer: ${info.error.message}`);
  const page = Math.min(info.maxRecordCount || 1000, 2000);
  // A server without pagination ignores resultOffset and would hand back
  // its first page forever.
  const paged = !(info.advancedQueryCapabilities && info.advancedQueryCapabilities.supportsPagination === false);
  const out = [];
  let offset = 0, prevFirst = null;
  for (;;) {
    const p = { where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326, f: 'json',
      ...(paged ? { resultRecordCount: page, resultOffset: offset } : {}), ...params };
    const data = await fetchJSON(`${layerUrl}/query?${qs(p)}`);
    if (data.error) throw new Error(`ArcGIS query: ${data.error.message}`);
    const feats = data.features || [];
    if (!paged) {
      if (data.exceededTransferLimit) throw new Error(`${layerUrl}: more than ${feats.length} features and no pagination`);
      out.push(...feats);
      break;
    }
    const first = feats.length ? JSON.stringify(feats[0]) : null;
    if (first && first === prevFirst) throw new Error(`${layerUrl}: the server returned the same page twice (resultOffset ignored)`);
    prevFirst = first;
    out.push(...feats);
    if (!feats.length || out.length >= max || (!data.exceededTransferLimit && feats.length < page)) break;
    offset += feats.length;
  }
  return { fields: info.fields || [], features: out };
}

/** Page through a Socrata dataset via SODA. */
export async function socrataAll(domain, dataset, soql = {}, { max = 500000, page = 50000 } = {}) {
  const rows = [];
  for (let offset = 0; rows.length < max; offset += page) {
    const url = `${domain}/resource/${dataset}.json?${qs({ ...soql, $limit: page, $offset: offset })}`;
    const batch = await fetchJSON(url);
    rows.push(...batch);
    if (batch.length < page) break;
  }
  return rows;
}

// Overpass: only endpoints the source-health probe confirmed answer.
export const OVERPASS = ['https://overpass-api.de/api/interpreter'];

/** Run an Overpass QL query, retrying across endpoints. */
export async function overpass(ql, { timeoutMs = 300000 } = {}) {
  let lastErr;
  for (const ep of OVERPASS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchRetry(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(ql)
        }, { retries: 0, timeoutMs });
        const text = await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
        const data = JSON.parse(text);
        // A timeout or memory limit hit while printing is reported as HTTP 200
        // with a "remark" and a partial element list: that is a failure.
        if (data.remark && /runtime error|timed? ?out|out of memory|too many/i.test(data.remark)) throw new Error(`Overpass: ${data.remark.slice(0, 200)}`);
        return data;
      } catch (err) {
        lastErr = err;
        await sleep(15000 * (attempt + 1)); // Overpass asks clients to back off
      }
    }
  }
  throw lastErr;
}

/**
 * Geocode addresses with the Census Bureau's keyless batch geocoder.
 * rows: [{ id, street, city, state, zip }] -> Map(id -> { lat, lon, exact }).
 * Sent in chunks well under the 10,000-row limit so one slow chunk can be
 * retried without redoing everything; unmatched rows are simply absent.
 */
export async function geocodeBatch(rows, { chunk = 2500 } = {}) {
  const out = new Map();
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, "'").replace(/[\r\n]+/g, ' ')}"`;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const csv = part.map(r => [r.id, r.street, r.city, r.state, r.zip].map(esc).join(',')).join('\n');
    const fd = new FormData();
    fd.append('benchmark', 'Public_AR_Current');
    fd.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
    const res = await fetchRetry('https://geocoding.geo.census.gov/geocoder/locations/addressbatch',
      { method: 'POST', body: fd }, { retries: 3, timeoutMs: 600000 });
    const text = await res.text();
    if (!res.ok) throw new Error(`Census batch geocoder HTTP ${res.status}: ${text.slice(0, 160)}`);
    // "id","input","Match","Exact","matched address","lon,lat","tigerline id","side"
    for (const line of text.split(/\r?\n/)) {
      const cols = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
      if (cols.length < 6 || cols[2] !== 'Match') continue;
      const [lon, lat] = cols[5].split(',').map(Number);
      if (isFinite(lat) && isFinite(lon)) out.set(cols[0], { lat, lon, exact: cols[3] === 'Exact' });
    }
    log(`geocoded ${Math.min(i + chunk, rows.length)}/${rows.length} (${out.size} matched)`);
  }
  return out;
}

/** Download a ZIP and return the text of its entries (or of one named entry). */
export async function unzipText(url, entry) {
  const { execFileSync } = await import('node:child_process');
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const res = await fetchRetry(url, {}, { retries: 2, timeoutMs: 300000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const d = await mkdtemp(`${tmpdir()}/zip-`);
  await writeFile(`${d}/f.zip`, Buffer.from(await res.arrayBuffer()));
  return execFileSync('unzip', ['-p', `${d}/f.zip`, ...(entry ? [entry] : [])], { maxBuffer: 1 << 30 }).toString('latin1');
}

/**
 * Parse a Census Gazetteer file into objects keyed by upper-cased header.
 * The files were tab-delimited through 2024 and are pipe-delimited since 2025.
 */
export function parseGazetteer(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes('|') ? '|' : '\t';
  const head = lines[0].split(delim).map(h => h.replace(/^\uFEFF/, '').trim().toUpperCase());
  return lines.slice(1).map(l => {
    const c = l.split(delim);
    return Object.fromEntries(head.map((h, i) => [h, (c[i] || '').trim()]));
  });
}

/** Census places (cities, towns, CDPs) in Washington, newest Gazetteer vintage. Cached. */
let placesPromise = null;
export function waPlaces() {
  if (!placesPromise) placesPromise = loadPlaces().catch(err => { placesPromise = null; throw err; });
  return placesPromise;
}
async function loadPlaces() {
  const now = new Date().getUTCFullYear();
  for (let y = now; y >= now - 4; y--) {
    try {
      const text = await fetchText(`https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${y}_Gazetteer/${y}_gaz_place_53.txt`, {}, { retries: 1, timeoutMs: 60000 });
      const rows = parseGazetteer(text);
      // A missing vintage can come back as an HTML page with status 200.
      if (!rows.length || !('NAME' in rows[0]) || !('INTPTLAT' in rows[0])) throw new Error('not a Gazetteer place file');
      const places = [];
      for (const r of rows) {
        if (!r.NAME) continue;
        const base = r.NAME.replace(/ (city|town|CDP|village)$/i, '');
        places.push({ name: r.NAME, base, incorporated: r.LSAD !== '57', lat: +r.INTPTLAT, lon: +r.INTPTLONG });
      }
      if (places.length > 500) { log(`gazetteer ${y}: ${places.length} WA places`); return { year: y, places }; }
    } catch (err) { log(`gazetteer ${y}: ${err.message}`); }
  }
  throw new Error('no Census place gazetteer found');
}

const PT_OFFSET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset' });
/** Hours behind UTC in Washington at instant t (7 in summer, 8 in winter). */
const pacificOffset = t => -parseInt(PT_OFFSET.formatToParts(new Date(t)).find(x => x.type === 'timeZoneName').value.replace('GMT', '') || '0', 10);
/**
 * Epoch ms for a timestamp without a UTC offset (Socrata "floating" times),
 * read as Washington wall-clock time with the daylight-saving rule of that
 * date. Timestamps that carry an offset are parsed as they are.
 */
export function parsePacific(s) {
  const str = String(s || '').trim();
  if (/(z|[+-]\d\d:?\d\d)$/i.test(str)) return Date.parse(str);
  const m = str.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?/);
  if (!m) return NaN;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  for (const h of [7, 8]) if (pacificOffset(wall + h * 3600000) === h) return wall + h * 3600000;
  return wall + 8 * 3600000; // the skipped spring-forward hour
}

/** Statewide Overpass area clause for Washington. */
export const WA_AREA = 'area["ISO3166-2"="US-WA"][admin_level=4]->.wa;';

export const round = (v, d = 5) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

export function inWA(lat, lon) {
  return lat >= WA_BBOX.s && lat <= WA_BBOX.n && lon >= WA_BBOX.w && lon <= WA_BBOX.e;
}

/** Write JSON compactly, creating directories. Returns byte length. */
export async function writeJSON(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const text = JSON.stringify(obj);
  await writeFile(path, text);
  return text.length;
}

export async function readJSON(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { return fallback; }
}

/**
 * Run a build step in isolation: one failing upstream must never block the
 * rest. On failure the previously committed file is left untouched, so the
 * map keeps serving the last good data.
 */
export async function step(name, fn, manifest) {
  const t0 = Date.now();
  try {
    const info = await fn();
    manifest.steps[name] = { ok: true, seconds: Math.round((Date.now() - t0) / 1000), ...info };
    log(`OK   ${name}`, JSON.stringify(info));
  } catch (err) {
    manifest.steps[name] = { ok: false, error: String(err && err.message || err).slice(0, 400) };
    log(`FAIL ${name}: ${err && err.stack || err}`);
  }
}
