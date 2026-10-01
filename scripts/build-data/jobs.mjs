// Jobs by place of work, for the medical site ranking: the U.S. Census
// Bureau's LEHD Origin-Destination Employment Statistics (LODES 8),
// workplace area characteristics for Washington (all jobs), summed from
// census blocks to 2020 census tracts. A catchment's employer base speaks to
// employer-sponsored coverage and to daytime demand near work.
//
// Output: data/jobs.json
//   { built, year, source, fields: ['jobs', 'health'], rows: { GEOID: [all jobs, health care and social assistance jobs] } }

import { gunzipSync } from 'node:zlib';
import { fetchBuffer, log, writeJSON, WA_FIPS } from './lib.mjs';

const LODES = y => `https://lehd.ces.census.gov/data/lodes/LODES8/wa/wac/wa_wac_S000_JT00_${y}.csv.gz`;
export const JOB_FIELDS = ['jobs', 'health'];

/** A LODES workplace (WAC) file -> { rows: { tract: [jobs, health] }, total, blocks }. */
export function sumByTract(csv) {
  const lines = String(csv).split(/\r?\n/);
  const head = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const iG = head.indexOf('w_geocode'), iC = head.indexOf('C000'), iH = head.indexOf('CNS16');
  if (iG < 0 || iC < 0 || iH < 0) throw new Error(`unexpected LODES header: ${lines[0].slice(0, 160)}`);
  const block = new RegExp(`^${WA_FIPS}\\d{13}$`);
  const rows = {};
  let total = 0, blocks = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = lines[i].split(',');
    const g = String(c[iG] || '').replace(/"/g, '');
    if (!block.test(g)) continue;
    const n = Number(c[iC]), h = Number(c[iH]);
    if (!isFinite(n) || n < 0) continue;
    const t = g.slice(0, 11);
    const r = rows[t] || (rows[t] = [0, 0]);
    r[0] += n; r[1] += isFinite(h) && h > 0 ? h : 0;
    total += n; blocks++;
  }
  return { rows, total, blocks };
}

export async function buildJobs(outDir) {
  // The newest year published (LODES runs two to three years behind). Only a
  // year that is not published (a 4xx answer, or not a gzip file) moves on to
  // an older one; any other failure throws, so the last good file stays.
  const now = new Date().getUTCFullYear();
  const tried = [];
  for (let y = now - 1; y >= now - 8; y--) {
    const { status, buf } = await fetchBuffer(LODES(y), { retries: 2, timeoutMs: 240000 });
    if (!buf) { tried.push(`${y}: HTTP ${status}`); continue; }
    // A missing year can come back as an HTML page.
    if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) { tried.push(`${y}: not a gzip file`); continue; }
    const { rows, total, blocks } = sumByTract(gunzipSync(buf).toString('utf8'));
    const tracts = Object.keys(rows).length;
    const health = Object.values(rows).reduce((t, r) => t + r[1], 0);
    log(`LODES ${y}: ${blocks} blocks with jobs in ${tracts} tracts; ${total} jobs, ${health} in health care and social assistance`);
    // Washington has about 3.5 million jobs; health care and social assistance about one in seven.
    if (tracts < 1500 || total < 2.5e6 || total > 5.5e6 || health < 0.06 * total || health > 0.25 * total) {
      throw new Error(`implausible LODES ${y}: ${tracts} tracts, ${total} jobs, ${health} in health care`);
    }
    const bytes = await writeJSON(`${outDir}/jobs.json`, {
      built: new Date().toISOString(), year: y,
      source: `U.S. Census Bureau, LEHD Origin-Destination Employment Statistics (LODES 8), workplace area characteristics, all jobs, ${y}`,
      fields: JOB_FIELDS, rows
    });
    return { year: y, tracts, jobs: total, health, bytes };
  }
  throw new Error(`no LODES workplace file found (${tried.join('; ')})`);
}
