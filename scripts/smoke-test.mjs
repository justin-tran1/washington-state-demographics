/* Integration smoke test: serves the repo locally, mocks every external API
 * with fixtures, and drives the app in headless Chromium. */
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8137';
// The app loads its data from the committed, pre-built files under data/
// (served by the local web server); expectations are read from them too.
const REPO = new URL('..', import.meta.url).pathname;
const readData = f => JSON.parse(readFileSync(REPO + 'data/' + f, 'utf8'));
const hasData = f => existsSync(REPO + 'data/' + f);
const ACS_COUNTY = readData('acs/county.json');
const failures = [];
const pass = m => console.log('  ✓ ' + m);
const fail = m => { failures.push(m); console.log('  ✗ ' + m); };
const assert = (cond, m) => (cond ? pass(m) : fail(m));

// ---------------------------------------------------------------- fixtures
function sq(lon, lat, d) { // square polygon ring
  return [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]];
}
// 8 fixture "counties" in a row across WA, 8 tracts around Seattle
const COUNTIES = Array.from({ length: 8 }, (_, i) => ({
  geoid: '530' + String(i * 2 + 1).padStart(2, '0'),
  lon: -123 + i * 0.8, lat: 47.3, name: 'County ' + i
}));
const TRACTS = Array.from({ length: 8 }, (_, i) => ({
  geoid: '53033' + String(100 + i) + '00',
  lon: -122.5 + (i % 4) * 0.1, lat: 47.55 + Math.floor(i / 4) * 0.1, name: 'Tract ' + i
}));

function acsDetailed(rows, level) {
  const header = ['NAME', 'B01003_001E', 'B01002_001E', 'B19013_001E', 'B19301_001E', 'B25077_001E', 'B25064_001E',
    'B15003_001E', 'B15003_022E', 'B15003_023E', 'B15003_024E', 'B15003_025E', 'B17001_001E', 'B17001_002E',
    'B23025_003E', 'B23025_005E', 'B25003_001E', 'B25003_002E', 'B11001_001E', 'state', 'county'];
  if (level === 'tract') header.push('tract');
  const out = [header];
  rows.forEach((r, i) => {
    const row = [r.name, String(10000 + i * 5000), '38.2', String(60000 + i * 8000), '39000', String(400000 + i * 50000), '1600',
      '8000', '2000', '800', '150', '90', '9500', String(700 + i * 40), '5800', '300', '4200', '2600', '4100',
      r.geoid.slice(0, 2), r.geoid.slice(2, 5)];
    if (level === 'tract') row.push(r.geoid.slice(5));
    out.push(row);
  });
  return out;
}
function acsSubject(rows, level) {
  const header = ['S2701_C01_001E', 'S2701_C03_001E', 'S2701_C05_001E', 'state', 'county'];
  if (level === 'tract') header.push('tract');
  const out = [header];
  rows.forEach((r, i) => {
    const row = [String(9800), String(94 - i), String(6 + i), r.geoid.slice(0, 2), r.geoid.slice(2, 5)];
    if (level === 'tract') row.push(r.geoid.slice(5));
    out.push(row);
  });
  return out;
}
function boundaryFC(rows, d) {
  return {
    type: 'FeatureCollection',
    features: rows.map((r, i) => ({
      type: 'Feature',
      properties: { GEOID: r.geoid, NAME: r.name, AREALAND: 2.6e8 + i * 5e7, AREAWATER: 1e6 },
      geometry: { type: 'Polygon', coordinates: [sq(r.lon, r.lat, d)] }
    }))
  };
}
const CENTROIDS_ESRI = {
  features: TRACTS.map((r, i) => ({
    attributes: { GEOID: r.geoid, AREALAND: 2.6e8 + i * 5e7 },
    centroid: { x: r.lon, y: r.lat }
  }))
};
const now = Date.now();
const SEATTLE_ROWS = [
  ['Motor Vehicle Theft', 'MOTOR VEHICLE THEFT'], ['Theft From Motor Vehicle', 'LARCENY-THEFT OFFENSES'],
  ['Burglary/Breaking & Entering', 'BURGLARY/BREAKING&ENTERING'], ['Simple Assault', 'ASSAULT OFFENSES'],
  ['Robbery', 'ROBBERY'], ['Destruction/Damage/Vandalism of Property', 'DESTRUCTION/DAMAGE/VANDALISM OF PROPERTY'],
  ['Murder & Nonnegligent Manslaughter', 'HOMICIDE OFFENSES'], ['Drug/Narcotic Violations', 'DRUG/NARCOTIC OFFENSES']
].map(([off, cat], i) => ({ // SPD's current (republished) column schema
  offense_date: new Date(now - (i + 1) * 86400000).toISOString(),
  nibrs_offense_code_description: off, offense_category: cat,
  latitude: String(47.6 + i * 0.005), longitude: String(-122.33 - i * 0.005),
  block_address: (100 + i) + ' BLOCK OF PINE ST', neighborhood: 'DOWNTOWN'
}));
const SEATTLE_COLUMNS = ['report_number', 'report_date_time', 'offense_id', 'offense_date', 'nibrs_group_a_b',
  'nibrs_crime_against_category', 'offense_sub_category', 'shooting_type_group', 'block_address', 'latitude',
  'longitude', 'beat', 'precinct', 'sector', 'neighborhood', 'reporting_area', 'offense_category',
  'nibrs_offense_code_description', 'nibrs_offense_code'];
let seattleSelect = null; // captured from the live query for assertions
// Tacoma's layer is a table: coordinates are attributes, geometry is null.
const TACOMA_POINTS = {
  type: 'FeatureCollection',
  features: [0, 1, 2].map(i => ({
    type: 'Feature',
    properties: { Description: ['Theft From Motor Vehicle', 'Robbery', 'Destruction/Damage/Vandalism of Property'][i], Offense_Category: ['Larceny/Theft Offenses', 'Robbery', 'Destruction/Damage/Vandalism of Property'][i],
      DateOccurred: now - (i + 2) * 86400000, Address: (10 + i) + '00 S 12TH ST', Latitude: 47.25 + i * 0.004, Longitude: -122.44 - i * 0.004 },
    geometry: null
  }))
};
const EVERETT_ROWS = [0, 1].map(i => ({
  datetimereceived: new Date(now - (i + 1) * 86400000).toISOString().slice(0, 23),
  case: ['VUCSA - MISDEMEANOR', 'BURGLARY - RESIDENTIAL'][i],
  occurredlocationby100block: '19XX EVERETT AVE , EVERETT, WA, 98201', neighborhood: 'BAYSIDE',
  geomcoordinate: { type: 'Point', coordinates: [-122.2 - i * 0.01, 47.98] }
}));
const PIERCE_POINTS = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { OccurredOn: now - 86400000 * 3, Public_Nam: 'Theft - Vehicle Prowl', City: 'Pierce County' },
    geometry: { type: 'Point', coordinates: [-122.45, 47.16] } }]
};
const WSDOT_ROUTES = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { route_type: 3, route_short_name: '40', route_long_name: null, route_desc: 'Northgate - Downtown', agency_name: 'Metro Transit', route_url: 'https://kingcounty.gov/en/dept/metro/routes-and-service/schedules-and-maps/040.html' },
      geometry: { type: 'LineString', coordinates: [[-122.36, 47.6], [-122.33, 47.61], [-122.3, 47.66]] } },
    { type: 'Feature', properties: { route_type: 0, route_short_name: '1 Line', route_long_name: 'Link light rail', agency_name: 'Sound Transit' },
      geometry: { type: 'LineString', coordinates: [[-122.33, 47.59], [-122.32, 47.62]] } }
  ]
};
const WSDOT_STOPS = {
  type: 'FeatureCollection',
  features: [0, 1, 2, 3].map(i => ({
    type: 'Feature', properties: { stop_name: 'Stop ' + i, stop_id: 'KCM_' + (1000 + i) },
    geometry: { type: 'Point', coordinates: [-122.34 + i * 0.01, 47.6 + i * 0.005] }
  }))
};
const OSM_ELEMENTS = {
  elements: [
    { type: 'node', id: 1, lat: 47.61, lon: -122.33, tags: { name: 'QFC Broadway', shop: 'supermarket', 'addr:street': 'Broadway E' } },
    { type: 'way', id: 2, center: { lat: 47.62, lon: -122.32 }, tags: { name: 'Swedish Medical Center', amenity: 'hospital' } },
    { type: 'node', id: 3, lat: 47.6, lon: -122.34, tags: { name: 'Elliott Bay Cafe', amenity: 'cafe' } }
  ]
};
const NCES_POINTS = {
  type: 'FeatureCollection',
  features: [0, 1].map(i => ({
    type: 'Feature',
    properties: { NCESSCH: '5303300' + i, NAME: 'Fixture Elementary ' + i, STREET: (200 + i) + ' 5th Ave', CITY: 'Seattle', STATE: 'WA', ZIP: '98109' },
    geometry: { type: 'Point', coordinates: [-122.35 + i * 0.02, 47.62] }
  }))
};
const ISO_FC = {
  features: [15, 10, 5].map(m => ({
    type: 'Feature', properties: { contour: m },
    geometry: { type: 'Polygon', coordinates: [sq(-122.45, 47.6, m * 0.012)] }
  }))
};

// CDN assets served from the exact local npm tarball bytes (SRI must pass)
const PKGS = (process.env.PKGS_DIR || './node_modules').replace(/\/$/, '') + '/';
const CDN_FILES = {
  'leaflet.css': [PKGS + 'leaflet/dist/leaflet.css', 'text/css'],
  'leaflet.js': [PKGS + 'leaflet/dist/leaflet.js', 'application/javascript'],
  'leaflet.markercluster.js': [PKGS + 'leaflet.markercluster/dist/leaflet.markercluster.js', 'application/javascript'],
  'MarkerCluster.css': [PKGS + 'leaflet.markercluster/dist/MarkerCluster.css', 'text/css'],
  'MarkerCluster.Default.css': [PKGS + 'leaflet.markercluster/dist/MarkerCluster.Default.css', 'text/css'],
  'leaflet-heat.js': [PKGS + 'leaflet.heat/dist/leaflet-heat.js', 'application/javascript']
};

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64');

// --------------------------------------------------------------- routing
function jsonRes(obj) { return { contentType: 'application/json', body: JSON.stringify(obj) }; }
function handle(url, method, postData) {
  const u = new URL(url);
  const full = u.href;
  if (u.hostname === '127.0.0.1') return null; // let the local server handle it
  if (u.hostname === 'unpkg.com' || u.hostname === 'cdn.jsdelivr.net') {
    const name = u.pathname.split('/').pop();
    if (CDN_FILES[name]) return { path: CDN_FILES[name][0], contentType: CDN_FILES[name][1], headers: { 'Access-Control-Allow-Origin': '*' } };
    return { status: 404, contentType: 'text/plain', body: 'unknown cdn file' };
  }

  // Census API
  if (u.hostname === 'api.census.gov') {
    if (full.includes('/2024/')) return { status: 404, contentType: 'text/plain', body: 'error: unknown dataset' };
    const level = full.includes('tract') ? 'tract' : 'county';
    const rows = level === 'tract' ? TRACTS : COUNTIES;
    if (full.includes('/subject')) return jsonRes(acsSubject(rows, level));
    return jsonRes(acsDetailed(rows, level));
  }
  // TIGERweb
  if (u.hostname === 'tigerweb.geo.census.gov') {
    if (full.includes('Generalized_ACS2024')) return jsonRes({ error: { code: 404, message: 'not found' } });
    if (full.includes('Tracts_Blocks/MapServer/8/query')) {
      if (full.includes('returnCentroid=true')) return jsonRes(CENTROIDS_ESRI);
      return jsonRes(boundaryFC(TRACTS, 0.045));
    }
    if (full.includes('State_County/MapServer/12/query')) return jsonRes(boundaryFC(COUNTIES, 0.35));
    if (full.includes('Tracts_Blocks/MapServer?')) return jsonRes({ layers: [{ id: 7, name: 'Census Tracts Labels' }, { id: 8, name: 'Census Tracts' }, { id: 9, name: 'Census Blocks' }], maxRecordCount: 100000 });
    if (full.includes('State_County/MapServer?')) return jsonRes({ layers: [{ id: 11, name: 'States' }, { id: 12, name: 'Counties' }], maxRecordCount: 100000 });
    return jsonRes({ error: { code: 400, message: 'unexpected tigerweb url ' + u.pathname } });
  }
  // Socrata (Seattle)
  if (u.hostname === 'data.seattle.gov' || u.hostname === 'cos-data.seattle.gov') {
    if (u.pathname.startsWith('/api/views/')) return jsonRes({ id: 'tazs-3rd5', columns: SEATTLE_COLUMNS.map(n => ({ fieldName: n })) });
    if (u.pathname.includes('tazs-3rd5')) {
      seattleSelect = u.searchParams.get('$select');
      const sel = (seattleSelect || '').split(',');
      if (!sel.includes('offense_date')) return { status: 400, contentType: 'application/json', body: JSON.stringify({ error: true, message: 'No such column' }) };
      return jsonRes(u.searchParams.get('$offset') === '0' ? SEATTLE_ROWS : []);
    }
    return jsonRes([]);
  }
  // Tacoma (TPD_RMS_Crime table)
  if (u.hostname === 'services3.arcgis.com' && u.pathname.includes('TPD_RMS_Crime')) {
    if (full.includes('/0?f=json')) return jsonRes({ type: 'Table', maxRecordCount: 1000, fields: [] });
    if (full.includes('/0/query')) {
      const out = new URL(full).searchParams.get('outFields') || '';
      if (/\*|officer/i.test(out)) return jsonRes({ error: { code: 400, message: 'test: only configured fields may be requested' } });
      return jsonRes(TACOMA_POINTS);
    }
  }
  // Pierce County Sheriff
  if (u.hostname === 'services2.arcgis.com' && u.pathname.includes('Crime_Data')) {
    if (full.includes('/1?f=json')) return jsonRes({ type: 'Feature Layer', maxRecordCount: 2000, fields: [] });
    if (full.includes('/1/query')) return jsonRes(PIERCE_POINTS);
  }
  // Everett (Socrata, point column)
  if (u.hostname === 'data.everettwa.gov' && u.pathname.includes('szww-y224')) {
    return jsonRes(u.searchParams.get('$offset') === '0' ? EVERETT_ROWS : []);
  }
  // WSDOT
  if (u.hostname === 'data.wsdot.wa.gov') {
    if (full.includes('TransitData/FeatureServer?f=json')) return jsonRes({ layers: [{ id: 1, name: 'Transit Stops' }, { id: 3, name: 'Transit Routes' }] });
    if (full.includes('TransitData/FeatureServer/3?f=json')) return jsonRes({
      type: 'Feature Layer', maxRecordCount: 2000,
      fields: ['route_short_name', 'agency_id', 'route_id', 'route_long_name', 'route_desc', 'route_type', 'route_url', 'agency_name']
        .map(name => ({ name, type: name === 'route_type' ? 'esriFieldTypeString' : 'esriFieldTypeString' }))
    });
    if (full.includes('TransitData/FeatureServer/1?f=json')) return jsonRes({
      type: 'Feature Layer', maxRecordCount: 2000,
      fields: [{ name: 'stop_id', type: 'esriFieldTypeString' }, { name: 'stop_name', type: 'esriFieldTypeString' }]
    });
    if (full.includes('FeatureServer/3/query')) return jsonRes(WSDOT_ROUTES);
    if (full.includes('FeatureServer/1/query')) return jsonRes(WSDOT_STOPS);
    if (full.includes('FerryRoutes/MapServer?f=json')) return jsonRes({ layers: [{ id: 0, name: 'Ferry Routes' }] });
    if (full.includes('FerryRoutes/MapServer/0/query')) return jsonRes({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { ROUTE: 'Seattle - Bainbridge' }, geometry: { type: 'LineString', coordinates: [[-122.34, 47.6], [-122.5, 47.62]] } }]
    });
  }
  // NCES
  if (u.hostname === 'nces.ed.gov') {
    if (full.includes('K12_School_Locations?f=json')) return jsonRes({
      services: [{ name: 'K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2324' }, { name: 'K12_School_Locations/EDGE_GEOCODE_PUBLICSCH_2122' }, { name: 'K12_School_Locations/EDGE_GEOCODE_PRIVATESCH_2122' }]
    });
    if (full.includes('Postsecondary_School_Locations?f=json')) return jsonRes({
      services: [{ name: 'Postsecondary_School_Locations/EDGE_GEOCODE_POSTSECONDARYSCH_2324' }]
    });
    if (full.includes('/query')) return jsonRes(NCES_POINTS);
  }
  // Overpass
  if (u.pathname.includes('interpreter')) return jsonRes(OSM_ELEMENTS);
  // Valhalla
  if (u.hostname.startsWith('valhalla')) return jsonRes(ISO_FC);
  // Nominatim
  if (u.hostname === 'nominatim.openstreetmap.org') {
    if (u.pathname === '/search') return jsonRes([{ display_name: 'Space Needle, 400, Broad Street, Seattle, WA', lat: '47.6205', lon: '-122.3493' }]);
    return jsonRes({ display_name: '400 Broad St, Seattle, WA 98109' });
  }
  if (u.hostname === 'geocode.arcgis.com') {
    return jsonRes({ candidates: [{ address: '400 Broad St, Seattle, Washington, 98109', location: { x: -122.3493, y: 47.6205 }, score: 100,
      attributes: { Match_addr: '400 Broad St, Seattle, Washington, 98109', Addr_type: 'PointAddress', Region: 'Washington' } }] });
  }
  // Map tiles: serve a 1x1 transparent PNG so Leaflet really builds tile
  // elements (the label-pane assertions depend on that).
  if (/\.png$|\/MapServer\/tile\//.test(u.pathname) ||
      /tile|basemap|arcgisonline|nationalmap/.test(u.hostname)) {
    return { contentType: 'image/png', body: PNG_1PX, headers: { 'Access-Control-Allow-Origin': '*' } };
  }
  // anything else: block
  return { status: 404, contentType: 'text/plain', body: 'blocked by test' };
}

// ------------------------------------------------------------------ test
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-gpu']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
page.on('console', msg => { if (msg.type() === 'error' && !/net::|Failed to load resource/.test(msg.text())) pageErrors.push('console: ' + msg.text()); });

await page.route('**/*', async route => {
  const req = route.request();
  const res = handle(req.url(), req.method(), req.postData());
  if (res === null) return route.continue();
  return route.fulfill(res);
});


async function setToggle(cardId, on) {
  await page.evaluate(([id, val]) => {
    const input = document.querySelector('#' + id + ' .card-toggle input');
    if (input.checked !== val) { input.checked = val; input.dispatchEvent(new Event('change')); }
  }, [cardId, on]);
}

console.log('· loading app');
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
assert(await page.locator('#map .leaflet-pane').count() > 0, 'Leaflet map initialized');
const bmCount = await page.locator('#basemap-select option').count();
const bmGroups = await page.locator('#basemap-select optgroup').count();
assert(bmCount === 16, `16 base maps offered, got ${bmCount}`);
assert(bmGroups === 5, `5 base-map groups, got ${bmGroups}`);
const bmHosts = await page.evaluate(() => WAMAP.CONFIG.BASEMAPS.map(b => new URL(b.url.replace('{s}', 'a')).host));
assert(await page.evaluate(() => WAMAP.CONFIG.BASEMAPS.every(b => /^https:/.test(b.url))), 'every base map is served over HTTPS');
assert(await page.evaluate(() => WAMAP.CONFIG.BASEMAPS.filter(b => /arcgis/.test(b.url)).every(b => /\/tile\/\{z\}\/\{y\}\/\{x\}$/.test(b.url))), 'ArcGIS services use the {z}/{y}/{x} row-major tile order');
assert(!bmHosts.some(h => h.includes('cartocdn')), 'no CARTO tiles (they now require an API key)');
assert(!(await page.evaluate(() => WAMAP.CONFIG.BASEMAPS.some(b => /\{apikey\}|\bkey=/.test(b.url)))), 'no base map needs an API key');
assert(await page.locator('.layer-card').count() === 6, '6 layer cards rendered');

console.log('· demographics (county level)');
await setToggle('card-demographics', true);
await page.waitForTimeout(1500);
let status = await page.locator('#card-demographics .status-line').textContent();
assert(status.includes('ACS 5-Year ' + ACS_COUNTY.span), 'demographics read the pre-built ACS ' + ACS_COUNTY.span + ': "' + status.trim() + '"');
assert(/\b(8|39) counties/.test(status) && !/Could not load/.test(status), 'county polygons loaded: "' + status.trim() + '"');
assert(await page.locator('.legend-block[data-layer="demographics"]').isVisible(), 'demographics legend visible');
const legendTitle = await page.locator('.legend-block[data-layer="demographics"] .legend-title').textContent();
assert(/Population density/.test(legendTitle), 'legend shows default metric');

console.log('· demographics (tract level)');
await page.evaluate(() => WAMAP.map.setView([47.6, -122.4], 11, { animate: false }));
await page.waitForTimeout(1600);
status = await page.locator('#card-demographics .status-line').textContent();
assert(/tracts loaded/.test(status), 'tracts loaded at z11: "' + status.trim() + '"');

console.log('· metric switch + insurance exclusivity');
await page.locator('#card-demographics select.input').selectOption('income');
await page.waitForTimeout(700);
assert(/Median household income/.test(await page.locator('.legend-block[data-layer="demographics"] .legend-title').textContent()), 'metric switch updates legend');
await setToggle('card-insurance', true);
await page.waitForTimeout(1200);
assert(!(await page.locator('#card-demographics .card-toggle input').isChecked()), 'enabling insurance switched demographics off');
assert(/Uninsured rate/.test(await page.locator('.legend-block[data-layer="insurance"] .legend-title').textContent()), 'insurance legend visible');

console.log('· amenities');
await setToggle('card-amenities', true);
await page.waitForFunction(() => /places statewide|Could not load/.test(document.querySelector('#card-amenities .status-line').textContent), null, { timeout: 20000 }).catch(() => {});
status = await page.locator('#card-amenities .status-line').textContent();
assert(/places statewide/.test(status), 'amenities loaded statewide: "' + status.trim() + '"');
const schoolCount = (await page.locator('#amen-count-schools').textContent()).replace(/\D/g, '');
assert(+schoolCount === readData('amenities/schools.json').rows.length, `every school in the file is on the map (${schoolCount})`);
const health = readData('amenities/health.json');
const hospitalKinds = new Set(health.kinds.map((k, i) => (/hospital|emergency/i.test(k) ? i : -1)).filter(i => i >= 0));
const hospitals = health.rows.filter(r => hospitalKinds.has(r[3])).length;
assert(hospitals >= 100, `health file carries at least 100 hospitals (${hospitals})`);
const bigChips = await page.locator('.poi-chip-lg').count();
assert(bigChips === hospitals, `every hospital is drawn unclustered at statewide zoom (${bigChips}/${hospitals})`);
assert(/hospitals always shown/.test(status), 'status line reports the always-shown hospitals');
const srcTitle = await page.locator('#amen-label-health').getAttribute('title');
assert(/Department of Health/.test(srcTitle || '') && /OpenStreetMap/.test(srcTitle || ''), 'health category lists its sources on hover');
// every category file is present and well formed
for (const c of await page.evaluate(() => WAMAP.CONFIG.AMENITIES.map(a => a.id))) {
  const d = hasData('amenities/' + c + '.json') ? readData('amenities/' + c + '.json') : null;
  assert(d && d.rows.length > 50 && d.kinds.length && d.sources.length, `amenities/${c}.json has ${d ? d.rows.length : 0} places from ${d ? d.sources.map(x => x.id).join('+') : '-'}`);
}
// a pharmacy popup renders from the compact row format (zoomed past the
// clustering threshold onto a known pharmacy from the file)
const ph = readData('amenities/pharmacy.json').rows[0];
await page.evaluate(() => { document.getElementById('amen-pharmacy').click(); });
await page.waitForTimeout(1200);
await page.evaluate(([lat, lon]) => WAMAP.map.setView([lat, lon], 18, { animate: false }), [ph[0], ph[1]]);
await page.waitForTimeout(1200);
const phPopup = await page.evaluate(([lat, lon]) => {
  let html = null;
  WAMAP.map.eachLayer(l => {
    if (!html && l.getLatLng && l.getPopup && l.getPopup() && Math.abs(l.getLatLng().lat - lat) < 1e-6 && Math.abs(l.getLatLng().lng - lon) < 1e-6) {
      l.openPopup(); html = document.querySelector('.leaflet-popup-content').textContent;
    }
  });
  return html;
}, [ph[0], ph[1]]);
assert(phPopup && phPopup.includes(ph[2]) && /Source:/.test(phPopup), 'pharmacy popup renders: ' + (phPopup || '').replace(/\s+/g, ' ').slice(0, 140));
await page.evaluate(() => { WAMAP.map.closePopup(); document.getElementById('amen-pharmacy').click(); WAMAP.map.setView([47.6, -122.4], 11, { animate: false }); });
await page.waitForTimeout(800);

console.log('· transit');
await setToggle('card-transit', true);
await page.waitForTimeout(1500);
status = await page.locator('#card-transit .status-line').textContent();
assert(/WSDOT/.test(status), 'transit uses WSDOT source: "' + status.trim() + '"');
const routePopup = await page.evaluate(() => {
  let html = null;
  WAMAP.map.eachLayer(l => { if (!html && l.feature && l.feature.properties && l.feature.properties.route_short_name === '40') { l.openPopup(); html = document.querySelector('.leaflet-popup-content').innerHTML; } });
  return html || '';
});
const agencySite = (readData('transit/agencies.json').agencies['metro transit'] || {}).url;
assert(/Northgate - Downtown/.test(routePopup), 'route popup falls back to route_desc when the long name is empty');
assert(agencySite && routePopup.includes('href="' + agencySite + '"') && /Agency website/.test(routePopup), 'route popup links the agency website (' + agencySite + ')');
assert(/040\.html/.test(routePopup) && /Route schedule/.test(routePopup), 'route popup links the GTFS route_url schedule page');
await page.evaluate(() => WAMAP.map.closePopup());

console.log('· crime');
await setToggle('card-crime', true);
await page.waitForTimeout(2500);
const chip = async id => (await page.locator('#crime-city-' + id + ' .chip-count').textContent()).trim();
assert(await chip('seattle') === '8', 'Seattle chip count = 8, got "' + await chip('seattle') + '"');
assert(seattleSelect && seattleSelect.includes('nibrs_offense_code_description') && !seattleSelect.includes('offense_start_datetime'),
  'Seattle adapter resolved the live column schema: ' + seattleSelect);
assert(await chip('tacoma') === '3', 'Tacoma chip count = 3 (table layer with coordinate columns, configured fields only), got "' + await chip('tacoma') + '"');
assert(await chip('everett') === '2', 'Everett chip count = 2 (Socrata point column), got "' + await chip('everett') + '"');
assert(await chip('pierce') === '1', 'Pierce County Sheriff chip count = 1, got "' + await chip('pierce') + '"');
assert(await page.locator('#crime-city-spokane').count() === 0, 'mislabelled "Spokane" (Washington, D.C.) feed removed');
for (const id of ['kcso', 'auburn']) {
  if (!hasData('crime/' + id + '.json')) { fail(`data/crime/${id}.json missing`); continue; }
  assert(/^\d[\d,]*$/.test(await chip(id)) && +(await chip(id)).replace(/,/g, '') > 0, `${id} pre-geocoded incidents load (${await chip(id)})`);
}
const agencies = readData('crime/agencies.json');
assert(agencies.rows.length > 200, `statewide file covers ${agencies.rows.length} agencies (${agencies.year})`);
const agencyCount = (await page.locator('#crime-agency-count').textContent()).replace(/\D/g, '');
assert(+agencyCount === agencies.rows.length, 'every agency is drawn: ' + agencyCount);
assert(/Crime rate by agency/.test(await page.locator('.legend-block[data-layer="crime"]').textContent()), 'crime rate legend visible');
const agencyPopup = await page.evaluate(() => {
  let html = null;
  WAMAP.map.eachLayer(l => { if (!html && l instanceof L.CircleMarker && l.getPopup()) { l.openPopup(); html = document.querySelector('.leaflet-popup-content').innerHTML; } });
  return html || '';
});
assert(/per 1,000/.test(agencyPopup) && /WASPC/.test(agencyPopup), 'agency popup shows rates and the WASPC source');
await page.evaluate(() => WAMAP.map.closePopup());
const total = await page.locator('.crime-total').textContent();
assert(/incidents in view/.test(total), 'viewport totals rendered: "' + total.trim() + '"');
// Count check on Seattle alone: switch every other incident feed off.
for (const id of await page.evaluate(() => WAMAP.CONFIG.CRIME.cities.map(c => c.id).filter(c => c !== 'seattle'))) {
  await page.locator('#crime-city-' + id).click();
}
await page.waitForTimeout(500);
// MVT classification check: "Theft From Motor Vehicle" must be theft, not MVT.
const counts = await page.evaluate(() => ({
  mvt: document.getElementById('crime-count-mvt').textContent,
  theft: document.getElementById('crime-count-theft').textContent
}));
assert(counts.mvt.trim() === '1', 'MVT classified once (got "' + counts.mvt + '")');
assert(counts.theft.trim() === '1', 'theft-from-vehicle classified as theft (got "' + counts.theft + '")');
// classification rules against realistic NIBRS strings
const cls = await page.evaluate(() => [
  ['Theft From Motor Vehicle||LARCENY-THEFT OFFENSES', 'theft'],
  ['Motor Vehicle Theft||MOTOR VEHICLE THEFT', 'mvt'],
  ['SEX OFFENSES, CONSENSUAL', 'sexoff'],
  ['TRESPASS OF REAL PROPERTY', 'trespass'],
  ['BAD CHECKS', 'fraud'],
  ['DRIVING UNDER THE INFLUENCE', 'dui'],
  ['WEAPON LAW VIOLATIONS', 'weapons'],
  ['FAMILY OFFENSES, NONVIOLENT', 'other'],
  ['AGGRAVATED ASSAULT||ASSAULT OFFENSES', 'assault'],
  ['MALICIOUS HARASSMENT', 'assault'],
  ['ARSON', 'arson'],
  ['MURDER & NONNEGLIGENT MANSLAUGHTER', 'homicide'],
  ['Theft - Vehicle Prowl', 'theft'],
  ['VUCSA - MISDEMEANOR', 'drugs'],
  ['Criminal Mischi', 'vandalism'],
  ['STOLEN VEHICLE', 'mvt']
].map(([t, want]) => ({ t, want, got: WAMAP.classifyCrime(t).id })));
for (const c of cls) assert(c.got === c.want, `classify "${c.t}" -> ${c.got} (want ${c.want})`);
// drugs is off by default
const drugCount = await page.evaluate(() => document.getElementById('crime-count-drugs').textContent);
assert(drugCount.trim() === '', 'drugs category off by default');
await page.locator('#card-crime select.input >> nth=1').selectOption('heat');
await page.waitForTimeout(600);
assert(await page.locator('.leaflet-heatmap-layer, canvas.leaflet-heatmap-layer').count() > 0, 'heat map mode renders');

console.log('· drive time');
await page.evaluate(() => WAMAP.driveTime.setOrigin(47.6, -122.45, 'Test origin'));
await page.waitForTimeout(2200);
assert(await page.locator('#card-drivetime .card-toggle input').isChecked(), 'drive-time card auto-enabled');
assert(/Drive time/.test(await page.locator('.legend-block[data-layer="drivetime"]').textContent()), 'drive-time legend visible');
const dtRows = await page.locator('.dt-table tbody tr').count();
assert(dtRows === 3, '3 drive-time stat rows, got ' + dtRows);
const dtFirst = await page.locator('.dt-table tbody tr >> nth=0').textContent();
assert(/≤ 5 min/.test(dtFirst) && /\d/.test(dtFirst), '5-min band has stats: "' + dtFirst.trim() + '"');

console.log('· search');
await page.fill('#search-input', '400 Broad St, Seattle');
await page.press('#search-input', 'Enter');
await page.waitForTimeout(1200);
const items = await page.locator('.search-item').count();
assert(items >= 1, 'search returned results');
const srcText = await page.locator('.search-src >> nth=0').textContent();
assert(/Esri/.test(srcText), 'address resolved by the Esri World Geocoder: "' + srcText + '"');
await page.locator('.search-item >> nth=0').click();
await page.waitForTimeout(1300);
assert(await page.locator('.search-pin').count() === 1, 'search marker placed');
assert(/Drive times from here/.test(await page.locator('.leaflet-popup').textContent()), 'search popup has drive-time action');

console.log('· pins');
await page.evaluate(() => WAMAP.map.closePopup());
// Turn the data layers off first: transit lines and crime dots are
// interactive, and a click that lands on one opens its popup instead of
// reaching the map, which would make this test order-dependent.
for (const id of ['amenities', 'transit', 'crime']) await setToggle('card-' + id, false);
await page.waitForTimeout(400);
await page.locator('#pin-mode-btn').click();
const mapBox = await page.locator('#map').boundingBox();
await page.mouse.click(mapBox.x + mapBox.width * 0.30, mapBox.y + mapBox.height * 0.70);
await page.waitForFunction(() => document.getElementById('pin-count').textContent.trim() === '1', null, { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(700); // keep the two clicks from coalescing into a double-click zoom
await page.mouse.click(mapBox.x + mapBox.width * 0.72, mapBox.y + mapBox.height * 0.28);
await page.waitForFunction(() => document.getElementById('pin-count').textContent.trim() === '2', null, { timeout: 5000 }).catch(() => {});
const pinDiag = await page.evaluate(() => ({
  count: document.getElementById('pin-count').textContent.trim(),
  modeActive: !!(window.WAMAP.modes && window.WAMAP.modes.active),
  btnActive: document.getElementById('pin-mode-btn').classList.contains('active'),
  popupOpen: !!document.querySelector('.leaflet-popup')
}));
assert(pinDiag.count === '2', 'two pins dropped in pin mode: ' + JSON.stringify(pinDiag));
await page.keyboard.press('Escape');
await page.locator('#pin-clear-btn').click();
await page.waitForFunction(() => document.getElementById('pin-count').textContent.trim() === '', null, { timeout: 5000 }).catch(() => {});
assert((await page.locator('#pin-count').textContent()).trim() === '', 'pins cleared');

// restore the layers the pin test switched off, so the URL-state round trip
// below still covers a realistic multi-layer selection
for (const id of ['amenities', 'transit', 'crime']) await setToggle('card-' + id, true);
await page.waitForTimeout(1500);

console.log('· about modal');
await page.locator('#about-btn').click();
assert(await page.locator('#about-modal').isVisible(), 'sources modal opens');
assert(/Valhalla/.test(await page.locator('#sources-content').textContent()), 'sources content populated');
await page.locator('#about-close').click();

console.log('· base maps + label sandwich');
// OSM (default) carries no label overlay, so the toggle hides itself
assert(await page.locator('#labels-toggle-wrap').isHidden(), 'labels toggle hidden for a base map with no reference layer');
await page.locator('#basemap-select').selectOption('esri-light-gray');
await page.waitForTimeout(700);
assert(await page.locator('#labels-toggle-wrap').isVisible(), 'labels toggle shown for Light Gray Canvas');
assert(/thematic data/.test(await page.locator('#basemap-note').textContent()), 'base-map note rendered');
const paneInfo = await page.evaluate(() => {
  const p = WAMAP.map.getPane('labels');
  return { z: p && p.style.zIndex, tiles: p ? p.querySelectorAll('.leaflet-layer').length : -1 };
});
assert(paneInfo.z === '450', `labels pane sits above overlays at z-index 450, got ${paneInfo.z}`);
assert(paneInfo.tiles === 1, `one label layer in the labels pane, got ${paneInfo.tiles}`);
await page.locator('#labels-toggle').uncheck();
await page.waitForTimeout(400);
assert((await page.evaluate(() => WAMAP.map.getPane('labels').children.length)) === 0, 'unchecking removes the label layer');
await page.locator('#labels-toggle').check();
await page.waitForTimeout(400);
const nativeZoom = await page.evaluate(() => WAMAP.CONFIG.BASEMAPS.find(b => b.id === 'usgs-imagery').options.maxNativeZoom);
assert(nativeZoom === 16, 'USGS imagery declares maxNativeZoom so it upsamples instead of going blank');

console.log('· CBRE theme');
const themed = await page.evaluate(() => {
  const out = {};
  WAMAP.util.theme.set('light');
  out.lightAttr = document.documentElement.getAttribute('data-theme');
  out.lightRamp = WAMAP.util.theme.colors().seqPrimary[5];
  out.lightAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  WAMAP.util.theme.set('dark');
  out.darkAttr = document.documentElement.getAttribute('data-theme');
  out.darkRamp = WAMAP.util.theme.colors().seqPrimary[5];
  out.darkAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  out.darkSurface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
  WAMAP.util.theme.set('auto');
  out.brandGreen = WAMAP.CONFIG.PALETTE.brand.green;
  return out;
});
assert(themed.lightAttr === 'light' && themed.darkAttr === 'dark', 'theme switch stamps data-theme');
assert(themed.lightAccent.toLowerCase() === '#003f2d', `light accent is CBRE Green, got ${themed.lightAccent}`);
assert(themed.darkAccent.toLowerCase() === '#17e88f', `dark accent is CBRE Accent Green, got ${themed.darkAccent}`);
assert(themed.darkSurface.toLowerCase() === '#012a2d', `dark surface is CBRE Dark Green, got ${themed.darkSurface}`);
assert(themed.lightRamp !== themed.darkRamp, 'choropleth ramp differs between themes');
assert(themed.brandGreen === '#003F2D', 'official CBRE Green present in the palette');
const strayColors = await page.evaluate(() => {
  // every JS-side color must come from the CBRE palette module
  const P = WAMAP.CONFIG.PALETTE;
  const hexes = new Set();
  const walk = v => {
    if (typeof v === 'string') { if (/^#[0-9a-f]{6}$/i.test(v)) hexes.add(v.toLowerCase()); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(P);
  const banned = ['#2a78d6', '#eb6834', '#e34948', '#4a3aa7', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
  return banned.filter(b => hexes.has(b));
});
assert(strayColors.length === 0, `no pre-rebrand colors left in the palette (found ${strayColors.join(', ')})`);

console.log('· shareable URL state');
await page.locator('#card-insurance select.input').selectOption('insured');
await page.waitForTimeout(600);
const hash = await page.evaluate(() => location.hash);
assert(/map=/.test(hash) && /layers=/.test(hash), 'hash carries view + layers: ' + hash);
assert(/ins=insured/.test(hash), 'hash carries the insurance metric');
assert(/dt=/.test(hash), 'hash carries the drive-time origin');
const zoomBefore = await page.evaluate(() => WAMAP.map.getZoom());
await page.goto(BASE + '/' + hash, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2600);
assert(await page.locator('#card-insurance .card-toggle input').isChecked(), 'insurance layer restored from URL');
assert(await page.locator('#card-transit .card-toggle input').isChecked(), 'transit layer restored from URL');
assert(!(await page.locator('#card-demographics .card-toggle input').isChecked()), 'demographics stays off (was off in the link)');
assert((await page.locator('#card-insurance select.input').inputValue()) === 'insured', 'insurance metric restored from URL');
assert(/Origin:/.test(await page.locator('#card-drivetime .origin-line').textContent()), 'drive-time origin restored from URL');
assert(await page.locator('.dt-table tbody tr').count() === 3, 'drive-time bands recomputed after restore');
const zoomAfter = await page.evaluate(() => WAMAP.map.getZoom());
assert(zoomAfter === zoomBefore, `map view restored without refit (zoom ${zoomBefore} -> ${zoomAfter})`);

await page.screenshot({ path: 'smoke.png', fullPage: false });
await browser.close();

console.log('\npage errors: ' + (pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : 'none'));
if (pageErrors.length) failures.push(pageErrors.length + ' page error(s)');
console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
