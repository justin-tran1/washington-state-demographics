// Crime data built ahead of time.
//
// 1. data/crime/agencies.json - every Washington law-enforcement agency's
//    annual NIBRS offense counts, as compiled by WASPC (the state UCR
//    program) and published by OFM on data.wa.gov (vvfu-ry7f). Each agency is
//    placed on what it serves: city police on the Census place, sheriffs on
//    the county, and everything else (tribal, university, port police) on
//    the FBI Crime Data Explorer's agency coordinates.
// 2. data/crime/<feed>.json - incident reports from open-data feeds that
//    publish block addresses but no coordinates (King County Sheriff's
//    Office, Auburn PD), geocoded with the Census batch geocoder. Feeds that
//    do publish coordinates are queried live by the browser instead.

import { fetchJSON, fetchText, readJSON, writeJSON, log, round, inWA, geocodeBatch, qs, socrataAll, unzipText, parseGazetteer, waPlaces, parsePacific } from './lib.mjs';

const WASPC_DATASET = 'https://data.wa.gov/resource/vvfu-ry7f.json';
const WASPC_PAGE = 'https://data.wa.gov/Public-Safety/Washington-State-Uniform-Crime-Reporting-National-/vvfu-ry7f';

// Map categories (ids match CONFIG.CRIME.categories) -> WASPC columns.
// WASPC's "theft" already includes motor-vehicle theft, fraud, embezzlement
// and stolen property: the property columns sum exactly to prprtytotal. So
// "mvt" has no separate statewide count, and DUI / trespass are Group B
// (arrest-only) offenses that the dataset does not count at all.
const WASPC = {
  homicide: ['murder', 'manslaughter'],
  sexoff: ['forcible_sex', 'non_forcible_sex', 'human_trafficking', 'pornography'],
  robbery: ['robbery'],
  kidnap: ['kidnapping_abduction'],
  assault: ['assault'],
  arson: ['arson'],
  burglary: ['burglary'],
  theft: ['theft'],
  vandalism: ['destruction_of_property'],
  fraud: ['counterfeiting_forgery', 'extortion_blackmail'],
  drugs: ['drug_violations'],
  weapons: ['weapon_law_violation'],
  other: ['viol_of_no_contact', 'bribery', 'gambling_violations', 'prostitution', 'animal_cruelty']
};
const CATS = Object.keys(WASPC);

const key = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');

// Agencies that serve no city of their own: placed on the place they patrol.
const SPECIAL_PLACES = [
  [/^university of washington/i, 'Seattle'], [/^wsu vancouver/i, 'Vancouver'], [/^washington state university/i, 'Pullman'],
  [/^central washington university/i, 'Ellensburg'], [/^eastern washington university/i, 'Cheney'],
  [/^western washington university/i, 'Bellingham'], [/^evergreen state college/i, 'Olympia'], [/^port of seattle/i, 'SeaTac'],
  [/^snohomish auto theft/i, 'Everett']
];

/** Census American Indian / Alaska Native areas in Washington (reservations and trust land). */
async function waTribalAreas(year) {
  const dir = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${year}_Gazetteer/`;
  try {
    const listing = await fetchText(dir, {}, { retries: 1 });
    const file = [...listing.matchAll(/href="([^"]+)"/g)].map(m => m[1]).find(n => /gaz_aiannh_national\.(txt|zip)$/i.test(n));
    if (!file) return [];
    const text = /\.zip$/i.test(file) ? await unzipText(dir + file) : await fetchText(dir + file);
    return parseGazetteer(text)
      .map(r => ({ name: r.NAME, k: key(r.NAME), lat: +r.INTPTLAT, lon: +r.INTPTLONG }))
      .filter(a => a.name && inWA(a.lat, a.lon));
  } catch (err) { log(`AIANNH gazetteer ${year}: ${err.message}`); return []; }
}

/** FBI CDE agency roster (keyless web-app backend, then the keyed API). */
async function fbiAgencies() {
  const urls = ['https://cde.ucr.cjis.gov/LATEST/agency/byStateAbbr/WA',
    `https://api.usa.gov/crime/fbi/cde/agency/byStateAbbr/WA?API_KEY=${process.env.DATA_GOV_KEY || 'DEMO_KEY'}`];
  for (const u of urls) {
    try {
      const d = await fetchJSON(u, {}, { retries: 1, timeoutMs: 60000 });
      const list = Object.values(d).flat().filter(a => a && a.agency_name);
      if (list.length > 100) return list;
    } catch (err) { log(`FBI agencies ${new URL(u).host}: ${err.message}`); }
  }
  return [];
}

async function buildAgencies(outDir) {
  const latest = await fetchJSON(`${WASPC_DATASET}?${qs({ $select: 'max(indexyear) as y' })}`);
  const year = +latest[0].y;
  const rowsFor = async y => fetchJSON(`${WASPC_DATASET}?${qs({ $where: `indexyear='${y}'`, $limit: 5000 })}`);
  const [cur, prev] = await Promise.all([rowsFor(year), rowsFor(year - 1)]);
  if (cur.length < 150) throw new Error(`only ${cur.length} WASPC rows for ${year}`);
  const prevTotal = new Map(prev.map(r => [`${r.county}|${r.location}`, +r.total]));

  const { year: gazYear, places: gaz } = await waPlaces();
  const places = gaz.map(p => ({ ...p, k: key(p.base) }));
  const tribal = await waTribalAreas(gazYear);
  const placeByKey = new Map();
  for (const p of places) if (!placeByKey.has(p.k) || p.incorporated) placeByKey.set(p.k, p);
  const findPlace = base => {
    const k = key(base);
    if (placeByKey.has(k)) return placeByKey.get(k);
    // "Beaux Arts" -> "Beaux Arts Village town"
    return places.find(p => p.incorporated && p.k.startsWith(k) && k.length >= 5) || null;
  };
  const acsCounty = await readJSON(`${outDir}/acs/county.json`, null);
  const countyPt = new Map();
  if (acsCounty) {
    const fi = acsCounty.fields;
    for (const [geoid, r] of Object.entries(acsCounty.rows)) {
      const name = (acsCounty.names && acsCounty.names[geoid]) || '';
      const lat = r[fi.indexOf('lat')], lon = r[fi.indexOf('lon')];
      if (name && lat != null) countyPt.set(name.replace(/ County.*$/i, '').toUpperCase(), { lat, lon });
    }
  }
  if (countyPt.size < 39) throw new Error(`county points missing (${countyPt.size}); run the acs step first`);
  const fbi = await fbiAgencies();
  const fbiByName = new Map(fbi.map(a => [key(a.agency_name), a]));
  log(`FBI roster: ${fbi.length} agencies`);

  const num = v => (v == null || v === '' ? 0 : +v);
  const out = [];
  const counties = {};
  const unplaced = [];
  for (const r of cur) {
    const county = String(r.county || '').toUpperCase();
    const counts = CATS.map(c => WASPC[c].reduce((s, col) => s + num(r[col]), 0));
    const total = num(r.total);
    const prevT = prevTotal.has(`${r.county}|${r.location}`) ? prevTotal.get(`${r.county}|${r.location}`) : null;
    if (/^county total$/i.test(r.location)) {
      counties[county] = [num(r.population), total, prevT, ...counts];
      continue;
    }
    if (/^state(wide)? totals?$/i.test(r.location)) continue;
    let type = 'other', pt = null, where = '';
    const city = r.location.match(/^(.*?)\s+(Police Department|Police Dept\.?|Department of Public Safety|Public Safety Department|Marshal'?s Office)$/i);
    const sheriff = r.location.match(/^(.*?)\s+County Sheriff'?s? Office$/i);
    if (sheriff) {
      type = 'sheriff';
      pt = countyPt.get(sheriff[1].toUpperCase()) || countyPt.get(county);
      where = 'county';
    } else if (city && !/tribal|tribe|nation|university|college|port of/i.test(city[1])) {
      // "Moxee City Police Department" serves the place named "Moxee".
      const p = findPlace(city[1]) || findPlace(city[1].replace(/\s+city$/i, ''));
      if (p) { type = 'city'; pt = { lat: p.lat, lon: p.lon }; where = 'place'; }
    }
    if (!pt && /tribal|tribe|nation/i.test(r.location)) {
      // Tribal police: the reservation named by the agency's first word.
      const first = key(r.location.split(/\s+/)[0]);
      const area = first.length >= 4 && tribal.find(a => a.k.startsWith(first));
      if (area) { pt = { lat: area.lat, lon: area.lon }; where = 'reservation'; }
    }
    if (!pt) {
      const special = SPECIAL_PLACES.find(([re]) => re.test(r.location));
      const p = special && placeByKey.get(key(special[1]));
      if (p) { pt = { lat: p.lat, lon: p.lon }; where = 'special'; }
    }
    if (!pt) {
      const f = fbiByName.get(key(r.location));
      if (f && inWA(f.latitude, f.longitude)) { pt = { lat: f.latitude, lon: f.longitude }; where = 'fbi'; }
      if (f && type === 'other' && /city/i.test(f.agency_type_name) && city) type = 'city';
    }
    if (!pt) { pt = countyPt.get(county); where = 'county-fallback'; unplaced.push(r.location); }
    if (!pt) continue;
    out.push([r.location, type, county, round(pt.lat), round(pt.lon), num(r.population), total, prevT, ...counts]);
  }
  // Agencies that share a point (FBI roster coordinates are often county
  // centroids) are fanned out slightly so every circle stays clickable.
  const seen = new Map();
  for (const row of out) {
    const k = `${row[3]},${row[4]}`;
    const n = seen.get(k) || 0;
    if (n) { const a = n * 2.4; row[3] = round(row[3] + 0.012 * Math.sin(a)); row[4] = round(row[4] + 0.018 * Math.cos(a)); }
    seen.set(k, n + 1);
  }
  if (unplaced.length) log(`placed at county point (no place/FBI match): ${unplaced.join(' | ')}`);
  const bytes = await writeJSON(`${outDir}/crime/agencies.json`, {
    built: new Date().toISOString(), year, prevYear: year - 1,
    source: 'WASPC Crime in Washington (NIBRS Group A offenses), via OFM on data.wa.gov', url: WASPC_PAGE,
    cats: CATS, fields: ['name', 'type', 'county', 'lat', 'lon', 'pop', 'total', 'prev', ...CATS],
    rows: out, countyFields: ['pop', 'total', 'prev', ...CATS], counties
  });
  return { year, agencies: out.length, counties: Object.keys(counties).length, unplaced: unplaced.length, bytes };
}

// ------------------------------------------------------ geocoded incidents
const DAY = 86400000;

/** Write an incident file: rows [lat, lon, minutesSinceFrom, offenseIdx, addrIdx]. */
async function writeIncidents(outDir, id, meta, incidents) {
  const from = new Date(Date.now() - 366 * DAY);
  from.setUTCHours(0, 0, 0, 0);
  const offs = [], offIdx = new Map(), addrs = [], addrIdx = new Map();
  const idx = (list, map, v) => { if (!map.has(v)) { map.set(v, list.length); list.push(v); } return map.get(v); };
  const rows = [];
  for (const i of incidents.sort((a, b) => a.t - b.t)) {
    if (!isFinite(i.t) || i.t < from.getTime()) continue;
    rows.push([round(i.lat), round(i.lon), Math.round((i.t - from.getTime()) / 60000), idx(offs, offIdx, i.offense), idx(addrs, addrIdx, i.addr || '')]);
  }
  const bytes = await writeJSON(`${outDir}/crime/${id}.json`, {
    built: new Date().toISOString(), ...meta, from: from.toISOString(),
    fields: ['lat', 'lon', 'minutes', 'offense', 'addr'], offenses: offs, addrs, rows
  });
  return { incidents: rows.length, bytes };
}

/** "26400 Block 180TH AVE SE" -> "26400 180TH AVE SE" (the block's first address). */
const blockToStreet = s => String(s || '').replace(/\s+Block\s+(of\s+)?/i, ' ').replace(/^(\d+)XX\b/i, '$100').replace(/\s+/g, ' ').trim();

// [south, west, north, east]: a match outside it is a geocoding miss (a
// street name that also exists in another town), not a real location.
async function geocodeIncidents(list, cityDefault, bbox) {
  const uniq = new Map();
  for (const i of list) {
    const street = blockToStreet(i.addr);
    if (!/^\d/.test(street)) continue; // intersections and blank addresses cannot be batch-geocoded
    const k = `${street}|${i.city || cityDefault}|${i.zip || ''}`.toUpperCase();
    if (!uniq.has(k)) uniq.set(k, { id: String(uniq.size + 1), street, city: i.city || cityDefault, state: 'WA', zip: i.zip || '' });
    i.gkey = k;
  }
  const coords = await geocodeBatch([...uniq.values()]);
  const byKey = new Map([...uniq.entries()].map(([k, v]) => [k, coords.get(v.id)]));
  const out = [];
  for (const i of list) {
    const c = i.gkey && byKey.get(i.gkey);
    if (c && c.lat >= bbox[0] && c.lat <= bbox[2] && c.lon >= bbox[1] && c.lon <= bbox[3]) out.push({ ...i, lat: c.lat, lon: c.lon });
  }
  log(`geocoded ${out.length}/${list.length} incidents (${uniq.size} distinct addresses)`);
  return out;
}

async function buildKCSO(outDir) {
  const since = new Date(Date.now() - 366 * DAY).toISOString().slice(0, 19);
  const rows = await socrataAll('https://data.kingcounty.gov', '4kmt-kfqf', {
    $select: 'case_number,incident_datetime,nibrs_code_name,block_address,city,zip',
    $where: `incident_datetime >= '${since}'`, $order: 'incident_datetime'
  });
  // Socrata timestamps carry no offset: they are Washington wall-clock time.
  const list = rows.filter(r => r.incident_datetime && r.nibrs_code_name).map(r => ({
    t: parsePacific(r.incident_datetime),
    offense: r.nibrs_code_name, addr: r.block_address, city: r.city, zip: r.zip
  }));
  if (list.length < 5000) throw new Error(`only ${list.length} KCSO offenses in the last year`);
  // The Sheriff's transit police also patrol Sound Transit lines outside King
  // County, so the box spans the Snohomish-King-Pierce service area.
  const located = await geocodeIncidents(list, '', [46.95, -122.75, 48.05, -121.0]);
  if (located.length < list.length * 0.5) throw new Error(`only ${located.length}/${list.length} KCSO incidents geocoded`);
  return writeIncidents(outDir, 'kcso', {
    label: 'King County Sheriff', source: "King County Sheriff's Office offense reports (NIBRS), block addresses geocoded by the U.S. Census Bureau",
    url: 'https://data.kingcounty.gov/Law-Enforcement-Safety/KCSO-Offense-Reports-2020-to-Present/4kmt-kfqf',
    fetched: list.length
  }, located);
}

/**
 * "1210 AUBURN WAY N # D" -> { street: "1200 AUBURN WAY N", label: "1200 block of AUBURN WAY N" }.
 * Auburn publishes exact house and apartment addresses; nothing finer than
 * the block is geocoded or published. Intersections are kept as they are.
 */
function toBlock(addr) {
  const a = String(addr || '').split(/[;,]/)[0]
    .replace(/\s+(#|apt|apartment|unit|ste|suite|spc|space|lot|trlr|bldg|rm|room)(?![a-z]).*$/i, '')
    .replace(/\s+/g, ' ').trim();
  const m = a.match(/^(\d+)[A-Z]?(?:-[A-Z0-9]+)?\s+(.+)$/i);
  if (!m) return /&|\//.test(a) ? { street: a, label: a } : null;
  const block = Math.floor(+m[1] / 100) * 100;
  return { street: `${block || 1} ${m[2]}`, label: `${block} block of ${m[2]}` };
}

// Victims of these offenses can be identified from a location, so they are
// not published at all (Seattle, Tacoma and Everett withhold them too).
const AUBURN_WITHHELD = /^(sex|rape|child abuse|order violation|stalking|custodial inter|kidnap|human traffick)/i;

// Auburn's feed mixes crimes with every other case type the department logs.
const AUBURN_NON_CRIME = /^(verbal domestic|traffic|warrant arrest|missing person|impounded vehic|person in distr|alarm|canceled|dead body|lost\/found prop|recovered stole|assist|cps|aps|civil matter|welfare check|suspicious|animal problem|juvenile proble|miscellaneous|abandoned veh|mental|information|found property|runaway|natural death)/i;
async function buildAuburn(outDir) {
  const since = new Date(Date.now() - 366 * DAY).toISOString().slice(0, 19);
  const rows = await socrataAll('https://data.auburnwa.gov', '8g4u-7zzy', {
    $select: 'casenumber,offense,reported,address', $where: `reported >= '${since}'`, $order: 'reported'
  });
  const crimes = rows.filter(r => r.offense && r.reported && !AUBURN_NON_CRIME.test(r.offense.trim()));
  const withheld = crimes.filter(r => AUBURN_WITHHELD.test(r.offense.trim())).length;
  const list = crimes.filter(r => !AUBURN_WITHHELD.test(r.offense.trim())).map(r => {
    const b = toBlock(r.address);
    // The feed mixes "Theft" and "THEFT"; unify, but keep acronyms such as DUI.
    return { t: parsePacific(r.reported), offense: r.offense.trim().replace(/^[A-Z ]{5,}$/, s => s[0] + s.slice(1).toLowerCase()),
      addr: b ? b.street : '', label: b ? b.label : '', city: 'Auburn' };
  });
  log(`Auburn: ${list.length} reports, ${withheld} withheld (sensitive offense types)`);
  if (list.length < 2000) throw new Error(`only ${list.length} Auburn crime reports in the last year`);
  // geocodeIncidents reads `addr` (already the block's first address); the
  // published address is the block label.
  const located = (await geocodeIncidents(list, 'Auburn', [47.2, -122.4, 47.4, -122.05])).map(i => ({ ...i, addr: i.label }));
  if (located.length < list.length * 0.5) throw new Error(`only ${located.length}/${list.length} Auburn reports geocoded`);
  return writeIncidents(outDir, 'auburn', {
    label: 'Auburn', source: 'City of Auburn police case reports (non-criminal case types removed; sex offenses, child abuse, protection-order violations, stalking and kidnapping withheld), generalized to the block and geocoded by the U.S. Census Bureau',
    url: 'https://data.auburnwa.gov/Public-Safety/Crimes/8g4u-7zzy', fetched: list.length, withheld
  }, located);
}

export async function buildCrime(outDir) {
  const summary = {};
  const errors = [];
  for (const [name, fn] of [['agencies', buildAgencies], ['kcso', buildKCSO], ['auburn', buildAuburn]]) {
    try { summary[name] = await fn(outDir); log(`crime ${name}: ${JSON.stringify(summary[name])}`); }
    catch (err) { summary[name] = { error: String(err.message || err).slice(0, 300) }; errors.push(name); log(`crime ${name} FAILED: ${err.stack || err}`); }
  }
  if (errors.length === 3) throw new Error(`every crime dataset failed: ${JSON.stringify(summary)}`);
  return summary;
}
