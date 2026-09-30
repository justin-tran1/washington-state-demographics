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
const tigerwebHits = [];
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

// ---- zoning atlas and the medical site evaluation, around a pin on a state route in Wenatchee.
// Every service is mocked; the parcel, address and city map service are fictional.
const SITE = { lat: 47.4390, lon: -120.3250 };
const site = { fail: new Set(), liveCode: 'CC', ownerAsked: false, hits: {} };
const siteHit = k => { site.hits[k] = (site.hits[k] || 0) + 1; };
const box = (lon, lat, dx, dy) => [[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]];
const ZONE_BASE = { GEOID: '5377105', Jurisdiction: 'Wenatchee', COUNTYFP: '007', COUNTYNAME: 'Chelan', UseResidential: 'P', UseManufacturing: 'X',
  DimMaxHeight: -9999, DimMaxStories: null, DimBonusMaxHeight: null, DimMaxFar: null, DimBonusMaxFar: null, DimMaxLotCoverBuildings: null,
  DimMaxLotCoverBuildingsAndImpSu: null, DenMinLotSizeSqFt: null, MinParkingOffice: null, Info: null, ReferenceURL: null, WAZASpatialNormalizationDate: '2024-11-06' };
const WAZA_ZONES = [
  { id: 1001, p: { ZoneID: 'CC', ZoneName: 'Community Commercial', WAZAZoneGeneral: 'MXU', WAZAZoneSpecific: 'MXU4', UseOffice: 'P', UseRetail: 'P',
    DimMaxHeight: 45, DimMaxLotCoverBuildings: 75, MinParkingOffice: 3, Info: 'Design review applies along SR 285.',
    ReferenceURL: 'https://example.org/code/wenatchee/zoning' }, g: box(SITE.lon, SITE.lat, 0.002, 0.0015) },
  { id: 1002, p: { ZoneID: 'R6', ZoneName: 'Single Family Residential', WAZAZoneGeneral: 'LIR', WAZAZoneSpecific: 'SR5-12', UseOffice: 'X', UseRetail: 'X' },
    g: box(SITE.lon + 0.004, SITE.lat, 0.002, 0.0015) },
  { id: 1003, p: { ZoneID: 'PUB', ZoneName: 'Public', WAZAZoneGeneral: 'PUB', WAZAZoneSpecific: 'PUBLIC', UseOffice: 'X', UseRetail: 'X' },
    g: box(SITE.lon, SITE.lat + 0.003, 0.002, 0.0015) },
  { id: 1004, p: { GEOID: '53007', Jurisdiction: 'Unincorporated Chelan County', ZoneID: 'RR5', ZoneName: 'Rural Residential/Resource 5', WAZAZoneGeneral: 'RUR',
    WAZAZoneSpecific: 'RR5+', UseOffice: 'X', UseRetail: 'X' }, g: box(SITE.lon - 0.004, SITE.lat - 0.003, 0.002, 0.0015) },
  { id: 1005, p: { ZoneID: 'C-2', ZoneName: 'General Business', WAZAZoneGeneral: null, WAZAZoneSpecific: null, UseOffice: null, UseRetail: null },
    g: box(SITE.lon + 0.004, SITE.lat + 0.003, 0.002, 0.0015) }
].map(z => ({ type: 'Feature', properties: Object.assign({ OBJECTID: z.id }, ZONE_BASE, z.p), geometry: { type: 'Polygon', coordinates: [z.g] } }));
const JURIS = {
  city: { GEOID: '5377105', Jurisdiction: 'Wenatchee', COUNTYNAME: 'Chelan', CodeURL: 'https://example.org/code/wenatchee',
    ZoningGISURL: 'https://gis.example.org/arcgis/rest/services/City_Zoning/FeatureServer/2',
    ZoningFileURL: null, ZoneIDField: 'Zoning', SpatialSource: 'Service', WAZACODEADOPTIONDATE: 1725148800000 },
  county: { GEOID: '53007', Jurisdiction: 'Unincorporated Chelan County', COUNTYNAME: 'Chelan', CodeURL: 'https://example.org/code/chelan-county', ZoningGISURL: null, ZoneIDField: null }
};
const ringBox = ring => ring.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [180, 90, -180, -90]);
const inRing = (ring, x, y) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
function asFC(features, u) {
  const out = u.searchParams.get('outFields') || '*', noGeom = u.searchParams.get('returnGeometry') === 'false';
  const feats = features.map(f => ({ type: 'Feature', geometry: noGeom ? null : f.geometry,
    properties: out === '*' ? f.properties : Object.fromEntries(out.split(',').filter(k => k in f.properties).map(k => [k, f.properties[k]])) }));
  if (u.searchParams.get('f') === 'geojson') return { type: 'FeatureCollection', features: feats };
  return { features: feats.map(x => ({ attributes: x.properties, geometry: x.geometry && { rings: x.geometry.coordinates } })) };
}
function nearPoint(u, features) {
  const [x, y] = (u.searchParams.get('geometry') || '').split(',').map(Number);
  const d = +(u.searchParams.get('distance') || 0), dLat = d / 111320, dLon = d / (111320 * Math.cos(y * Math.PI / 180));
  return features.filter(f => {
    const ring = f.geometry.coordinates[0];
    if (inRing(ring, x, y)) return true;
    const [w, s, e, n] = ringBox(ring);
    return x >= w - dLon && x <= e + dLon && y >= s - dLat && y <= n + dLat;
  });
}
const lineNearSite = (dx, dy, horiz) => ({ type: 'LineString', coordinates: horiz
  ? [[SITE.lon - 0.01, SITE.lat + dy], [SITE.lon + 0.01, SITE.lat + dy]] : [[SITE.lon + dx, SITE.lat - 0.01], [SITE.lon + dx, SITE.lat + 0.01]] });
function siteMock(u, method, postData) {
  const host = u.hostname, j = o => ({ contentType: 'application/json', body: JSON.stringify(o), headers: { 'Access-Control-Allow-Origin': '*' } });
  const down = { status: 500, contentType: 'text/plain', body: 'down' };
  // zoning atlas
  if (host === 'services6.arcgis.com' && u.pathname.includes('WAZA_Prototype_Layers')) {
    const m = u.pathname.match(/FeatureServer\/(\d)(\/query)?/);
    if (!m) return j({ layers: [] });
    const layer = +m[1];
    if (!m[2]) {
      siteHit('zoningMeta');
      return j({ name: 'Zones', type: 'Feature Layer', maxRecordCount: 2000, fields: [
        { name: 'WAZAZoneGeneral', type: 'esriFieldTypeString', domain: { type: 'codedValue', codedValues: [['MXU', 'Mixed Use'], ['LIR', 'Low-Intensity Residential'], ['PUB', 'Public and Semi-Public Use'], ['RUR', 'Rural']].map(([code, name]) => ({ code, name })) } },
        { name: 'WAZAZoneSpecific', type: 'esriFieldTypeString', domain: { type: 'codedValue', codedValues: [['MXU4', 'Mixed-use Low-rise (up to 4 stories)'], ['SR5-12', 'Suburban Residential (5-12 units per acre)']].map(([code, name]) => ({ code, name })) } }] });
    }
    if (site.fail.has('zoning')) return down;
    const [x, y] = (u.searchParams.get('geometry') || '').split(',').map(Number);
    if (layer === 0) {
      const where = u.searchParams.get('where') || '';
      const byId = where.match(/OBJECTID\s*=\s*(\d+)/), byCode = where.match(/UPPER\(ZoneID\)\s*=\s*'([^']*)'/);
      if (byId) { siteHit('zoneById'); return j(asFC(WAZA_ZONES.filter(z => z.properties.OBJECTID === +byId[1]), u)); }
      if (byCode) { siteHit('zoneByCode'); return j(asFC(WAZA_ZONES.filter(z => z.properties.ZoneID.toUpperCase() === byCode[1]), u)); }
      if (u.searchParams.get('geometryType') === 'esriGeometryEnvelope') {
        siteHit('zoneCells');
        const [w, s, e, n] = u.searchParams.get('geometry').split(',').map(Number);
        return j(asFC(WAZA_ZONES.filter(z => { const [a, b, c, d] = ringBox(z.geometry.coordinates[0]); return a <= e && c >= w && b <= n && d >= s; }), u));
      }
      siteHit('zoneAtPoint');
      return j(asFC(nearPoint(u, WAZA_ZONES), u));
    }
    const inCity = !inRing(WAZA_ZONES[3].geometry.coordinates[0], x, y);
    if (layer === 1) return j(asFC(inCity ? [{ type: 'Feature', properties: { GEOID: '5377105', Jurisdiction: 'Wenatchee', ZoneID: 'DR', ZoneName: 'Downtown design review overlay' }, geometry: null }] : [], u));
    return j(asFC([{ type: 'Feature', properties: inCity ? JURIS.city : JURIS.county, geometry: null }], u));
  }
  // the city's own zoning layer, which the atlas records
  if (host === 'gis.example.org' && u.pathname.includes('City_Zoning')) {
    siteHit('liveZone');
    return j({ features: [{ attributes: { Zoning: site.liveCode } }] });
  }
  // statewide parcels
  if (host === 'services.arcgis.com' && u.pathname.includes('Current_Parcels')) {
    if (!u.pathname.endsWith('/query')) return j({ name: 'Parcels_2026', fields: [{ name: 'LANDUSE_CD', type: 'esriFieldTypeSmallInteger', domain: { type: 'codedValue',
      codedValues: [{ code: 59, name: '59 - Other retail trade' }, { code: 91, name: '91 - Undeveloped land' }] } }] });
    siteHit('parcels');
    if (/owner|taxpayer/i.test(u.searchParams.get('outFields') || '')) site.ownerAsked = true;
    const [x, y] = (u.searchParams.get('geometry') || '').split(',').map(Number);
    const parcel = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [box(SITE.lon, SITE.lat, 0.0012, 0.0008)] }, properties: {
      PARCEL_ID_NR: '007-000000000001', ORIG_PARCEL_ID: '000000000001', SITUS_ADDRESS: '100 EXAMPLE AVE', SITUS_CITY_NM: 'WENATCHEE', SITUS_ZIP_NR: '98801',
      LANDUSE_CD: 59, VALUE_LAND: 1200000, VALUE_BLDG: 800000, DATA_LINK: 'https://example.org/assessor/000000000001', Shape__Area: 85600 } };
    return j(asFC(Math.abs(x - SITE.lon) < 0.003 && Math.abs(y - SITE.lat) < 0.003 ? [parcel] : [], u));
  }
  // WSDOT functional class and traffic counts
  if (host === 'data.wsdot.wa.gov' && u.pathname.includes('FunctionalClass/WSDOTFunctionalClassData')) {
    siteHit('roads');
    const state = /FeatureServer\/0\/query/.test(u.pathname), out = u.searchParams.get('outFields') || '';
    if ((state && /RoadName/.test(out)) || (!state && /StateRouteNumber/.test(out))) return j({ error: { code: 400, message: 'Failed to execute query.' } });
    return j(asFC([state
      ? { type: 'Feature', properties: { FederalFunctionalClassCode: 3, FederalFunctionalClassDesc: 'Urban Other Principal Arterial', StateRouteNumber: '285' }, geometry: lineNearSite(-0.0005) }
      : { type: 'Feature', properties: { FederalFunctionalClassCode: 4, FederalFunctionalClassDesc: 'Urban Minor Arterial', RoadName: 'Fifth St' }, geometry: lineNearSite(0, 0.00135, true) }], u));
  }
  if (host === 'data.wsdot.wa.gov' && u.pathname.includes('Shared/TrafficData/FeatureServer/1/query')) {
    siteHit('traffic');
    return j(asFC([{ type: 'Feature', properties: { StateRouteNumber: '285', AADT: 14000, Location: 'From Milepost 7.69 A to Milepost 10.02 A', ReportingYear: 2025 }, geometry: lineNearSite(-0.0005) }], u));
  }
  // elevation (a 3% grade rising to the north) and flood zones
  if (host === 'epqs.nationalmap.gov') {
    siteHit('epqs');
    if (site.fail.has('epqs')) return down;
    return j({ value: 674.6 + (+u.searchParams.get('y') - SITE.lat) * 111320 * 0.03 * 3.28084, resolution: 1 });
  }
  if (host === 'api.open-meteo.com') { siteHit('openMeteo'); return j({ elevation: (u.searchParams.get('latitude') || '').split(',').map(() => 205) }); }
  if (host === 'hazards.fema.gov') {
    siteHit('flood');
    if (site.fail.has('flood')) return down;
    return j(asFC([{ type: 'Feature', properties: { FLD_ZONE: 'X', ZONE_SUBTY: 'AREA OF MINIMAL FLOOD HAZARD', SFHA_TF: 'F', STATIC_BFE: -9999 }, geometry: null }], u));
  }
  // Overpass: the site query (parking, shelters, interchanges)
  if (u.pathname.includes('interpreter') && /social_facility/.test(decodeURIComponent(postData || ''))) {
    siteHit('overpass');
    if (site.fail.has('overpass')) return { status: 504, contentType: 'text/plain', body: 'gateway timeout' };
    const dLat = m => m / 111320, dLon = m => m / (111320 * Math.cos(SITE.lat * Math.PI / 180));
    const way = (id, cx, cy, w, h, tags) => ({ type: 'way', id, tags, geometry: box(cx, cy, dLon(w / 2), dLat(h / 2)).map(([lon, lat]) => ({ lat, lon })) });
    return j({ elements: [
      way(11, SITE.lon + dLon(25), SITE.lat + dLat(20), 40, 30, { amenity: 'parking', parking: 'surface', access: 'customers' }),
      way(12, SITE.lon + dLon(150), SITE.lat - dLat(60), 60, 30, { amenity: 'parking', parking: 'surface', name: 'Park & Ride', capacity: '26' }),
      way(13, SITE.lon - dLon(10), SITE.lat, 8, 60, { amenity: 'parking', parking: 'street_side' }),
      { type: 'node', id: 21, lat: SITE.lat + dLat(1300), lon: SITE.lon, tags: { amenity: 'social_facility', social_facility: 'shelter', 'social_facility:for': 'homeless' } },
      // Shelters for abuse victims, and women-only ones not tagged for homelessness, must never be used.
      { type: 'node', id: 22, lat: SITE.lat + dLat(300), lon: SITE.lon, tags: { amenity: 'social_facility', social_facility: 'shelter', 'social_facility:for': 'abused' } },
      { type: 'node', id: 23, lat: SITE.lat - dLat(250), lon: SITE.lon, tags: { amenity: 'social_facility', social_facility: 'shelter', 'social_facility:for': 'women' } },
      { type: 'node', id: 31, lat: SITE.lat + dLat(6000), lon: SITE.lon - dLon(1000), tags: { highway: 'motorway_junction', ref: '142' } }
    ] });
  }
  // Valhalla: the site evaluation asks for 10, 15 and 20 minutes at once
  if (host.startsWith('valhalla') && /"time":20/.test(postData || '')) {
    siteHit('valhalla');
    if (site.fail.has('valhalla')) return down;
    const body = JSON.parse(postData), { lat, lon } = body.locations[0];
    return j({ features: body.contours.map(c => ({ type: 'Feature', properties: { contour: c.time },
      geometry: { type: 'Polygon', coordinates: [box(lon, lat, c.time * 0.0042 / Math.cos(lat * Math.PI / 180), c.time * 0.004)] } })) });
  }
  return null;
}
// A stop and a route by the site, returned only to queries whose envelope covers it.
function coversSite(u) {
  const g = (u.searchParams.get('geometry') || '').split(',').map(Number);
  return g.length === 4 && g[0] <= SITE.lon && g[2] >= SITE.lon && g[1] <= SITE.lat && g[3] >= SITE.lat;
}
const SITE_STOP = { type: 'Feature', properties: { stop_name: 'SR 285 & Fifth St', stop_id: 'LT_9001' }, geometry: { type: 'Point', coordinates: [SITE.lon - 0.0006, SITE.lat + 0.0007] } };
const SITE_ROUTE = { type: 'Feature', properties: { route_type: 3, route_short_name: '1', route_long_name: 'Downtown - North End', agency_name: 'Link Transit' }, geometry: lineNearSite(-0.0006) };

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
  const siteRes = siteMock(u, method, postData);
  if (siteRes) return siteRes;

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
    tigerwebHits.push(full);
    if (full.includes('Generalized_ACS2024')) return jsonRes({ error: { code: 404, message: 'not found' } });
    // As on the real services: the generalized layers have no STATE field,
    // and their tract layer carries no GEOID at all.
    const generalized = full.includes('Generalized_ACS');
    const where = u.searchParams.get('where') || '';
    if (generalized && /STATE/.test(where)) return jsonRes({ error: { code: 400, message: 'Unable to complete operation.', details: ['Invalid query'] } });
    if (full.includes('Tracts_Blocks/MapServer/8/query')) {
      if (generalized) {
        const fc = boundaryFC(TRACTS, 0.045);
        fc.features.forEach((f, i) => { f.properties = { OBJECTID: i + 1, BASENAME: TRACTS[i].name }; });
        return jsonRes(fc);
      }
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
    if (full.includes('FeatureServer/3/query')) return jsonRes(coversSite(u) ? { type: 'FeatureCollection', features: WSDOT_ROUTES.features.concat([SITE_ROUTE]) } : WSDOT_ROUTES);
    if (full.includes('FeatureServer/1/query')) return jsonRes(coversSite(u) ? { type: 'FeatureCollection', features: WSDOT_STOPS.features.concat([SITE_STOP]) } : WSDOT_STOPS);
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

// Evaluate callbacks must not return Leaflet objects (setView/closePopup
// return the map): serializing that graph of ~30k markers breaks the call.
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
assert(await page.locator('.layer-card').count() === 8, '8 layer cards rendered');

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
await page.evaluate(() => { WAMAP.map.setView([47.6, -122.4], 11, { animate: false }); });
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

console.log('· health insurance: payer mix and insurance sources');
{
  const INS = await page.evaluate(() => ({
    payers: WAMAP.CONFIG.INSURANCE.payers.map(p => ({ id: p.id, field: p.field, label: p.label })),
    sources: WAMAP.CONFIG.INSURANCE.sources.map(s => ({ field: s.field, label: s.label, table: s.table }))
  }));
  const V = ACS_COUNTY.vintage;
  const pct1 = v => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%');
  const tableUrl = (t, g) => `https://data.census.gov/table/ACSDT5Y${V}.${t}?g=${!g ? '040XX00US53' : g.length === 5 ? '050XX00US' + g : '1400000US' + g}`;
  // The table behind each field, as the build recorded it.
  const TABLES = (ACS_COUNTY.insurance && ACS_COUNTY.insurance.tables) || {};
  assert(TABLES.pmEmployer === 'B27010' && /^[BC]27007$/.test(TABLES.srcMedicaid || '') && INS.sources.every(x => TABLES[x.field]),
    'the data file names the ACS table behind every insurance figure: ' + JSON.stringify(TABLES));

  // The data: every area's payer mix adds up to 100%, and each payer agrees
  // with the coverage-type tables (people whose payer is Medicaid all have
  // Medicaid, and so on). These tables are separate tabulations, so this
  // also catches a line mapped to the wrong type.
  const PM = ['pmEmployer', 'pmDirect', 'pmMedicare', 'pmMedicaid', 'pmMilitary', 'pmOther', 'pctUninsured'];
  for (const [lvl, d] of [['county', ACS_COUNTY], ['tract', readData('acs/tract.json')]]) {
    const F = Object.fromEntries(d.fields.map((f, i) => [f, i]));
    const missing = [...PM, 'pmDual', ...INS.sources.map(x => x.field)].filter(f => F[f] == null);
    if (missing.length) { assert(false, `${lvl} data carries the payer mix and insurance sources (missing ${missing.join(', ')})`); continue; }
    let n = 0;
    const bad = [], E = 0.05;
    for (const [g, r] of Object.entries(d.rows)) {
      const v = f => r[F[f]];
      if (v('pmEmployer') == null) continue;
      n++;
      const sum = PM.reduce((a, f) => a + v(f), 0);
      const why = [];
      if (Math.abs(sum - 100) > E) why.push('sums to ' + sum.toFixed(2));
      if (v('pmDual') > v('pmMedicaid') + E) why.push('dual > Medicaid');
      if (v('pmEmployer') > v('srcEmployer') + E) why.push('employer');
      if (v('pmDirect') > v('srcDirect') + E) why.push('direct-purchase');
      if (v('pmMedicare') > v('srcMedicare') + E) why.push('Medicare');
      if (v('pmMedicaid') > v('srcMedicaid') + E) why.push('Medicaid');
      // Medicaid holds everyone with Medicaid when the build had the Medicaid table.
      if (/\+/.test(TABLES.pmMedicaid || '') && Math.abs(v('pmMedicaid') - v('srcMedicaid')) > 0.02) why.push('Medicaid is not all Medicaid holders');
      if (v('pmMilitary') > v('srcTricare') + v('srcVA') + E) why.push('military');
      if (Math.max(v('srcEmployer'), v('srcDirect'), v('srcTricare')) > v('srcPrivate') + E) why.push('private');
      if (Math.max(v('srcMedicare'), v('srcMedicaid'), v('srcVA')) > v('srcPublic') + E) why.push('public');
      if (v('srcPrivate') + v('srcPublic') < v('pctInsured') - E) why.push('insured');
      if (why.length) bad.push(g + ' ' + why.join(', '));
    }
    assert(n >= (lvl === 'county' ? 39 : 1500) && !bad.length,
      `${lvl} payer mix adds up to 100% in all ${n} areas and agrees with the coverage-type tables` + (bad.length ? ` (${bad.length} disagree, e.g. ${bad.slice(0, 3).join('; ')})` : ''));
  }

  // The menu groups the metrics.
  const groups = await page.locator('#card-insurance select.input optgroup').evaluateAll(els => els.map(e => [e.label, e.children.length]));
  assert(groups.length === 3 && groups[0][0] === 'Coverage' && /^Payer mix/.test(groups[1][0]) && groups[1][1] === 7 && /^Insurance sources/.test(groups[2][0]) && groups[2][1] === 8,
    'the insurance menu groups coverage, payer mix and insurance sources: ' + JSON.stringify(groups));
  // A mapped metric names what it counts and links its ACS table.
  const leg = page.locator('.legend-block[data-layer="insurance"]');
  const insSel = page.locator('#card-insurance select.input');
  await insSel.selectOption('pm-medicare');
  await page.waitForTimeout(900);
  let legHref = await leg.locator('.legend-src a').getAttribute('href').catch(() => null);
  assert(/Payer mix: Medicare/.test(await leg.textContent()) && /each person counted once/.test(await leg.textContent()) && legHref === tableUrl('B27010'),
    'a payer-mix metric maps with its note and a link to ACS table B27010: ' + legHref);
  await insSel.selectOption('src-medicaid');
  await page.waitForTimeout(900);
  legHref = await leg.locator('.legend-src a').getAttribute('href').catch(() => null);
  assert(/Medicaid\/means-tested coverage/.test(await leg.textContent()) && /shares overlap/.test(await leg.textContent()) && legHref === tableUrl(TABLES.srcMedicaid),
    `an insurance-source metric cites the table its data came from (${TABLES.srcMedicaid}): ` + legHref);

  // An area's profile: payer mix bar and values, source bars, table links.
  const KF = Object.fromEntries(ACS_COUNTY.fields.map((f, i) => [f, i]));
  const king = ACS_COUNTY.rows['53033'];
  const kv = f => king[KF[f]];
  await page.evaluate(([lat, lon]) => { WAMAP.map.closePopup(); WAMAP.map.setView([lat, lon], 8, { animate: false }); }, [kv('lat'), kv('lon')]);
  await page.waitForTimeout(1500);
  const kp = await page.evaluate(([lat, lon]) => { const p = WAMAP.map.latLngToContainerPoint([lat, lon]); const b = WAMAP.map.getContainer().getBoundingClientRect(); return { x: b.left + p.x, y: b.top + p.y }; }, [kv('lat'), kv('lon')]);
  await page.mouse.click(kp.x, kp.y);
  await page.waitForTimeout(700);
  const prof = await page.evaluate(() => {
    const el = document.querySelector('.leaflet-popup-content .popup-ins');
    if (!el) return null;
    return {
      title: el.querySelector('h3').textContent,
      segs: el.querySelectorAll('.ins-stack .ins-seg').length,
      stackLabel: (el.querySelector('.ins-stack') || { getAttribute: () => '' }).getAttribute('aria-label'),
      legend: [...el.querySelectorAll('.ins-legend tr:not(.ins-sub)')].map(tr => [tr.cells[0].textContent.trim(), tr.cells[1].textContent.trim()]),
      dual: (el.querySelector('.ins-legend tr.ins-sub td.num') || {}).textContent,
      bars: [...el.querySelectorAll('.ins-bars .num')].map(x => x.textContent.trim()),
      tables: [...el.querySelectorAll('.ins-tbl a')].map(a => a.href),
      cite: [...el.querySelectorAll('.ins-cite a')].map(a => a.href)
    };
  });
  const wantLegend = INS.payers.map(p => [p.label, pct1(kv(p.field))]);
  assert(prof && prof.title === 'King County' && JSON.stringify(prof.legend) === JSON.stringify(wantLegend) && prof.dual === pct1(kv('pmDual')) &&
    prof.segs === INS.payers.filter(p => kv(p.field) >= 0.05).length,
    'a county profile shows its payer mix as a bar and lists every share from the data: ' + JSON.stringify(prof && prof.legend));
  assert(prof && JSON.stringify(prof.bars) === JSON.stringify(INS.sources.map(x => pct1(kv(x.field)))),
    'and its insurance sources, one bar per coverage type: ' + JSON.stringify(prof && prof.bars));
  assert(prof && JSON.stringify(prof.tables) === JSON.stringify(INS.sources.map(x => tableUrl(TABLES[x.field], '53033'))) &&
    prof.cite.includes(tableUrl('B27010', '53033')) && prof.cite.some(h => /kff\.org/.test(h)),
    'each figure links its ACS table for this county on data.census.gov, and the payer groups cite KFF');
  await page.evaluate(() => { WAMAP.map.closePopup(); WAMAP.map.setView([47.6, -122.4], 11, { animate: false }); });
  await insSel.selectOption('uninsured');
  await page.waitForTimeout(900);
}

console.log('· amenities');
await setToggle('card-amenities', true);
await page.waitForFunction(() => /places statewide|Could not load/.test(document.querySelector('#card-amenities .status-line').textContent), null, { timeout: 20000 }).catch(() => {});
status = await page.locator('#card-amenities .status-line').textContent();
assert(/places statewide/.test(status), 'amenities loaded statewide: "' + status.trim() + '"');
// Counted from the cluster layer's own markers (the category's count label
// only restates the file), polled while the chunked add finishes.
const schoolRows = readData('amenities/schools.json').rows.length;
const schoolLabel = (await page.locator('#amen-count-schools').textContent()).replace(/\D/g, '');
const countSchoolMarkers = () => page.evaluate(() => {
  let n = 0;
  WAMAP.map.eachLayer(l => {
    if (l instanceof L.MarkerClusterGroup) for (const m of l.getLayers()) if ((m.options.icon && m.options.icon.options.html || '').includes('🏫')) n++;
  });
  return n;
});
let schoolMarkers = 0;
for (let k = 0; k < 60; k++) {
  schoolMarkers = await countSchoolMarkers();
  if (schoolMarkers >= schoolRows) break;
  await page.waitForTimeout(250);
}
assert(schoolMarkers === schoolRows && +schoolLabel === schoolRows, `every school in the file is a marker on the map (${schoolMarkers} markers, ${schoolRows} rows, label ${schoolLabel})`);
const health = readData('amenities/health.json');
// Same rule as CONFIG.AMENITIES' health `featured` (a clinic on a hospital campus is not one).
const featuredRe = await page.evaluate(() => { const re = WAMAP.CONFIG.AMENITIES.find(c => c.id === 'health').featured; return [re.source, re.flags]; });
const hospitalKinds = new Set(health.kinds.map((k, i) => (new RegExp(...featuredRe).test(k) ? i : -1)).filter(i => i >= 0));
assert(!health.kinds.some((k, i) => hospitalKinds.has(i) && /^community health center/i.test(k)), 'health centers on hospital campuses are not drawn as hospitals');
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
await page.evaluate(([lat, lon]) => { WAMAP.map.setView([lat, lon], 18, { animate: false }); }, [ph[0], ph[1]]);
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
// Markers in the cluster groups whose icons match `re`, read once the count
// has held for 1.5 s (batched adds still running would change it).
async function settledMarkers(re) {
  const count = () => page.evaluate(src => {
    let n = 0;
    WAMAP.map.eachLayer(l => {
      if (!(l instanceof L.MarkerClusterGroup)) return;
      const ls = l.getLayers();
      if (ls.length && new RegExp(src).test(ls[0].options.icon.options.html)) n += ls.length;
    });
    return n;
  }, re.source);
  let last = -1;
  for (let i = 0, same = 0; i < 60 && same < 5; i++) {
    await page.waitForTimeout(300);
    const n = await count();
    same = n === last ? same + 1 : 0;
    last = n;
  }
  return last;
}
// A category switched off while its markers are still being added must not
// leave any behind. Retail (~20,000 markers) is loaded first; then, with the
// CPU slowed so one add spans several batches, it is switched on and straight
// off again. The plugin's own chunkedLoading fails this check.
const cdp = await page.context().newCDPSession(page);
await page.evaluate(() => { document.getElementById('amen-retail').click(); });
await page.waitForFunction(() => /\d/.test(document.getElementById('amen-count-retail').textContent), null, { timeout: 30000 });
await page.evaluate(() => { document.getElementById('amen-retail').click(); });
const amenBefore = await settledMarkers(/poi-chip/);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 });
await page.evaluate(() => { const cb = document.getElementById('amen-retail'); cb.click(); cb.click(); });
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
const amenAfter = await settledMarkers(/poi-chip/);
assert(amenBefore > 1000 && amenAfter === amenBefore,
  `a category switched off mid-load leaves no markers behind (${amenAfter} markers, ${amenBefore} before)`);

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
await page.evaluate(() => { WAMAP.map.closePopup(); });
// Two stop popups in a row: the refresh that the first one's pan deferred
// must not close the second popup when its answer lands.
await page.evaluate(() => { WAMAP.map.setView([47.607, -122.325], 16, { animate: false }); });
await page.waitForTimeout(1500);
const stopMarkers = () => {
  const out = [];
  WAMAP.map.eachLayer(l => { if (l instanceof L.MarkerClusterGroup) l.getLayers().forEach(m => { if (m._transitKind === 'stops') out.push(m); }); });
  return out;
};
const firstStop = await page.evaluate(`(${stopMarkers})().length`);
assert(firstStop >= 2, `stops load at zoom 16 (${firstStop})`);
// Pan in small steps until the transit layer's bounds key (2 decimals of the
// padded bounds) changes, so a refresh is really due while the popup is open.
const panned = await page.evaluate(`(() => {
  const s = (${stopMarkers})(); s[1].openPopup();
  const key = () => { const b = WAMAP.map.getBounds().pad(0.1); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(v => v.toFixed(2)).join('|'); };
  const k0 = key(); let n = 0;
  while (key() === k0 && n < 80) { WAMAP.map.panBy([10, 0], { animate: false }); n++; }
  return n;
})()`);
assert(panned > 0 && panned < 80, 'test setup: a small pan changes the transit bounds key (' + panned + ' steps)');
await page.waitForTimeout(1200); // the pan's refresh is deferred while the popup is open
await page.evaluate(`(() => { const s = (${stopMarkers})(); s[2].openPopup(); })()`);
await page.waitForTimeout(1500); // the deferred refresh runs when the first popup closes
const secondPopup = await page.evaluate(() => { const c = document.querySelector('.leaflet-popup-content'); return c ? c.textContent : ''; });
assert(/Stop 2/.test(secondPopup), 'a second stop popup stays open when the deferred refresh lands: "' + secondPopup.replace(/\s+/g, ' ').trim().slice(0, 60) + '"');
await page.evaluate(() => { WAMAP.map.closePopup(); WAMAP.map.setView([47.6, -122.4], 11, { animate: false }); });
await page.waitForTimeout(800);

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
await page.evaluate(() => { WAMAP.map.closePopup(); });
const total = await page.locator('.crime-total').textContent();
assert(/incidents in view/.test(total), 'viewport totals rendered: "' + total.trim() + '"');
// One canvas for every vector layer: Leaflet hit-tests a canvas against its
// own layers only, so a second canvas on top swallows the clicks below it.
assert(await page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane canvas:not(.leaflet-heatmap-layer)').length) === 1,
  'choropleth, transit and crime share one canvas');
// Real clicks (not openPopup): the topmost shape under the pointer must get them.
async function clickWhere(want) {
  // Let a popup's auto-pan and the transit refresh it triggers finish first:
  // the target is computed in pixels.
  await page.evaluate(() => { WAMAP.map.closePopup(); });
  await page.waitForTimeout(1500);
  const pt = await page.evaluate(w => {
    const map = WAMAP.map, R = map.options.renderer, size = map.getSize(), rect = map.getContainer().getBoundingClientRect();
    const isRoute = l => l.feature && l.feature.properties && l.feature.properties.route_short_name === '40';
    const isArea = l => l.feature && l.feature.properties && l.feature.properties.GEOID;
    for (let y = 30; y < size.y - 30; y += 7) for (let x = 30; x < size.x - 30; x += 7) {
      const p = map.containerPointToLayerPoint(L.point(x, y)); // canvas hit tests use layer points
      const hits = Object.values(R._layers).filter(l => l.options.interactive !== false && l._containsPoint && l._containsPoint(p));
      const ok = w === 'route' ? hits.some(isRoute) && !hits.some(l => l instanceof L.CircleMarker)
        : hits.length && hits.every(isArea);
      const el = ok && document.elementFromPoint(rect.left + x, rect.top + y);
      if (el && el.tagName === 'CANVAS') return { x: rect.left + x, y: rect.top + y };
    }
    return null;
  }, want);
  if (!pt) return null;
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  return page.evaluate(() => { const c = document.querySelector('.leaflet-popup-content'); return c ? c.innerHTML : ''; });
}
const routeClick = await clickWhere('route');
assert(routeClick && /Agency website/.test(routeClick), 'a click on a transit line opens its popup with crime circles drawn on top: ' + String(routeClick).replace(/\s+/g, ' ').slice(0, 120));
// A pan (a popup's own auto-pan does the same) refreshes the routes; that
// must not close the route popup the user is reading.
await page.evaluate(() => { WAMAP.map.panBy([120, 0], { animate: false }); });
await page.waitForTimeout(1800);
assert(/Agency website/.test(await page.evaluate(() => { const c = document.querySelector('.leaflet-popup-content'); return c ? c.innerHTML : ''; })),
  'the route popup stays open while the map pans and transit refreshes');
const areaClick = await clickWhere('area');
assert(areaClick && !/WASPC|Agency:/.test(areaClick), 'a click on a census area opens its profile with transit and crime on');
await page.evaluate(() => { WAMAP.map.closePopup(); });
// Category toggles while ~18,000 pre-geocoded markers are still being added
// must not leave stale or duplicate markers behind. With the CPU slowed, one
// full add spans several batches; the toggles run back to back and leave
// theft off, so a batch left running by an earlier render shows up as extra
// (theft) markers. The plugin's own chunkedLoading fails this check.
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 });
await page.evaluate(() => {
  WAMAP.map.setView([47.3, -120.5], 7, { animate: false });
  const chip = document.getElementById('crime-cat-theft');
  for (let i = 0; i < 5; i++) chip.click();
});
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
const crimeMarkers = await settledMarkers(/crime-dot/);
const crimeWant = await page.evaluate(() => {
  let want = 0;
  for (const c of WAMAP.CONFIG.CRIME.categories) want += +(document.getElementById('crime-count-' + c.id).textContent.replace(/\D/g, '') || 0);
  return want;
});
assert(crimeMarkers > 1000 && crimeMarkers === crimeWant,
  `no stale or duplicate crime markers after rapid toggles: ${crimeMarkers} markers for ${crimeWant} incidents`);
await page.locator('#crime-cat-theft').click(); // theft back on for the checks below
await page.evaluate(() => { WAMAP.map.setView([47.6, -122.4], 11, { animate: false }); });
await page.waitForTimeout(600);
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
await page.evaluate(() => { WAMAP.driveTime.setOrigin(47.6, -122.45, 'Test origin'); });
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
await page.evaluate(() => { WAMAP.map.closePopup(); });
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

console.log('· radius & area search');
{
  // Expectations are computed here, independently of the app's geometry:
  // haversine distances for circles, a winding-number test in Web Mercator
  // for polygons, and densified sampling for transit lines. A point within
  // half a metre of the edge touches it, as the app documents.
  const RAD = Math.PI / 180, R_E = 6371008.8, RM_E = 6378137, EDGE = 0.5;
  const hav = (la1, lo1, la2, lo2) => {
    const a = Math.sin((la2 - la1) * RAD / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin((lo2 - lo1) * RAD / 2) ** 2;
    return 2 * R_E * Math.asin(Math.sqrt(a));
  };
  const merc = (la, lo) => [RM_E * lo * RAD, RM_E * Math.log(Math.tan(Math.PI / 4 + la * RAD / 2))];
  const winding = (P, x, y) => {
    let wn = 0;
    for (let i = 0; i < P.length; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length];
      const side = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
      if (y1 <= y) { if (y2 > y && side > 0) wn++; } else if (y2 <= y && side < 0) wn--;
    }
    return wn !== 0;
  };
  const amenIds = await page.evaluate(() => WAMAP.CONFIG.AMENITIES.map(a => a.id));
  const AMEN = amenIds.map(id => {
    const d = readData('amenities/' + id + '.json');
    const F = Object.fromEntries(d.fields.map((f, i) => [f, i]));
    return { id, pts: d.rows.map(r => [r[F.lat], r[F.lon]]) };
  });
  const densify = line => { // [[lon, lat], ...] -> [lat, lon] points every ~5 m
    const out = [];
    for (let i = 1; i < line.length; i++) {
      const [lo1, la1] = line[i - 1], [lo2, la2] = line[i];
      const n = Math.max(1, Math.ceil(hav(la1, lo1, la2, lo2) / 5));
      for (let k = 0; k <= n; k++) out.push([la1 + (la2 - la1) * k / n, lo1 + (lo2 - lo1) * k / n]);
    }
    return out;
  };
  const ROUTE_LINES = WSDOT_ROUTES.features.map(f => ({ name: f.properties.route_short_name, pts: densify(f.geometry.coordinates) }))
    .concat([{ name: 'Seattle - Bainbridge', pts: densify([[-122.34, 47.6], [-122.5, 47.62]]) }]);
  const STOP_PTS = WSDOT_STOPS.features.map(f => [f.geometry.coordinates[1], f.geometry.coordinates[0]]);
  function expectCircle(lat, lon, r) {
    const inside = ([la, lo]) => hav(lat, lon, la, lo) <= r + EDGE;
    return {
      places: AMEN.reduce((n, c) => n + c.pts.filter(inside).length, 0),
      stops: STOP_PTS.filter(inside).length,
      routes: ROUTE_LINES.filter(l => l.pts.some(inside)).length
    };
  }
  function expectPolygon(pts) {
    const P = pts.map(([la, lo]) => merc(la, lo));
    const midLat = (Math.min(...pts.map(p => p[0])) + Math.max(...pts.map(p => p[0]))) / 2;
    const tol = EDGE / Math.cos(midLat * RAD); // half a metre on the ground, in Mercator metres
    const nearEdge = (x, y) => P.some(([ax, ay], i) => {
      const [bx, by] = P[(i + 1) % P.length], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(ax + t * dx - x, ay + t * dy - y) <= tol;
    });
    const inside = ([la, lo]) => { const [x, y] = merc(la, lo); return winding(P, x, y) || nearEdge(x, y); };
    return {
      places: AMEN.reduce((n, c) => n + c.pts.filter(inside).length, 0),
      stops: STOP_PTS.filter(inside).length,
      routes: ROUTE_LINES.filter(l => l.pts.some(inside)).length
    };
  }
  const areasList = () => page.evaluate(() => WAMAP.areas.list());
  const settled = async (pred, ms = 8000) => page.waitForFunction(pred, null, { timeout: ms }).catch(() => {});
  const ready = i => settled(`(() => { const s = WAMAP.areas.list()[${i}]; return s && s.counts.places != null && s.transit === 'ok'; })()`, 15000);
  const box = async sel => {
    const b = await page.locator(sel).first().boundingBox();
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
  };
  async function drag(from, dx, dy, opts = {}) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button: opts.button || 'left' });
    for (let k = 1; k <= 8; k++) await page.mouse.move(from.x + dx * k / 8, from.y + dy * k / 8);
    await page.mouse.up();
    await page.waitForTimeout(700);
  }
  const sameCounts = (got, want) => got.places === want.places && got.stops === want.stops && got.routes === want.routes;
  const cstr = c => `${c.places} places / ${c.stops} stops / ${c.routes} routes`;

  // Interactive layers off while the pin goes down (a click on a line or dot opens its popup instead).
  for (const id of ['amenities', 'transit', 'crime']) await setToggle('card-' + id, false);
  await page.evaluate(() => { WAMAP.map.closePopup(); WAMAP.map.setView([47.605, -122.335], 14, { animate: false }); });
  await page.waitForTimeout(900);
  const mb = await page.locator('#map').boundingBox();
  const mid = { x: mb.x + mb.width / 2, y: mb.y + mb.height / 2 };

  // A pin, then a radius search from its popup
  await page.locator('#pin-mode-btn').click();
  await page.mouse.click(mid.x, mid.y);
  await page.keyboard.press('Escape');
  await settled(() => document.getElementById('pin-count').textContent.trim() === '1');
  await page.waitForTimeout(500);
  await page.locator('.user-pin').first().click();
  await page.locator('.leaflet-popup-content button', { hasText: 'Radius search' }).click();
  await ready(0);
  let L0 = (await areasList())[0];
  const pinId = L0 && L0.pinId;
  const pinData = await page.evaluate(id => WAMAP.pins.get(id), pinId);
  assert(L0 && L0.type === 'circle' && Math.abs(L0.radius - 1609.344) < 0.01 && L0.unit === 'mi', 'pin popup starts a 1 mile radius search: ' + JSON.stringify(L0 && { type: L0.type, radius: L0.radius, unit: L0.unit }));
  assert(pinData && Math.abs(pinData.lat - L0.lat) < 1e-9 && Math.abs(pinData.lon - L0.lon) < 1e-9, 'the circle is centred on its pin');
  let want = expectCircle(L0.lat, L0.lon, L0.radius);
  assert(want.places > 50 && sameCounts(L0.counts, want), `1 mile circle lists every place, stop and route inside or touching it: ${cstr(L0.counts)} (expected ${cstr(want)})`);
  assert(await page.locator('#card-areas .card-toggle input').isChecked(), 'the search card switches itself on for a new shape');

  // Typed radius
  await page.locator('#card-areas .area-radius').first().fill('0.5');
  await page.locator('#card-areas .area-radius').first().press('Enter');
  await ready(0);
  L0 = (await areasList())[0];
  want = expectCircle(L0.lat, L0.lon, L0.radius);
  assert(Math.abs(L0.radius - 804.672) < 0.01 && sameCounts(L0.counts, want), `typing 0.5 mi resizes the circle and its list: ${cstr(L0.counts)} (expected ${cstr(want)})`);

  // Drag-to-resize
  const hb = await box('.area-handle');
  await drag(hb, 90, 0);
  await ready(0);
  L0 = (await areasList())[0];
  want = expectCircle(L0.lat, L0.lon, L0.radius);
  const shown = await page.locator('#card-areas .area-radius').first().inputValue();
  assert(L0.radius > 900 && Math.abs(+shown - L0.radius / 1609.344) < 0.001, `dragging the handle resizes the circle (${(L0.radius / 1609.344).toFixed(3)} mi, input ${shown})`);
  assert(sameCounts(L0.counts, want), `list follows the drag: ${cstr(L0.counts)} (expected ${cstr(want)})`);
  const handleLabel = (await page.locator('.area-handle-label').first().textContent()).trim();
  assert(/mi$/.test(handleLabel), 'the handle shows the radius: ' + handleLabel);

  // A redrawn list keeps its open group and the rows it showed
  const cSel = '#area-' + L0.id;
  const counts0 = await page.locator(cSel + ' .area-group .cat-count').allTextContents();
  const bigGroup = counts0.map(t => +t.replace(/\D/g, '')).reduce((b, n, i, a) => (n > a[b] ? i : b), 0);
  await page.locator(cSel + ' .area-group > summary').nth(bigGroup).click();
  await page.locator(cSel + ' .area-group[open] .area-more').click(); // past the first page
  const rowsBefore = await page.locator(cSel + ' .area-group[open] .area-item').count();
  await page.locator(cSel + ' .area-unit').selectOption('km');
  await page.waitForTimeout(300);
  const rowsAfter = await page.locator(cSel + ' .area-group[open] .area-item').count();
  const kmLabel = (await page.locator('.area-handle-label').first().textContent()).trim();
  assert(rowsBefore > 100 && rowsAfter === rowsBefore && /km$/.test(kmLabel), `a redrawn list keeps its open group and the rows it showed (${rowsAfter} of ${rowsBefore}; handle ${kmLabel})`);
  await page.locator(cSel + ' .area-unit').selectOption('mi');
  await page.locator(cSel + ' .area-group[open] > summary').first().click(); // closed again

  // Style
  await page.evaluate(() => {
    const set = (sel, v, ev) => { const el = document.querySelector('#card-areas ' + sel); el.value = v; el.dispatchEvent(new Event(ev)); };
    set('.area-color', '#aa3355', 'input');
    set('input[aria-label="Fill opacity"]', '40', 'input');
    set('input[aria-label="Outline opacity"]', '60', 'input');
    set('select[aria-label="Outline width"]', '4', 'change');
    set('select[aria-label="Outline style"]', 'dashed', 'change');
  });
  L0 = (await areasList())[0];
  const ls = L0.layerStyle;
  assert(ls.color === '#aa3355' && ls.fillOpacity === 0.4 && ls.opacity === 0.6 && ls.weight === 4 && !!ls.dashArray,
    'colour, fill opacity, outline opacity, width and dash apply to the circle: ' + JSON.stringify(ls));
  await page.locator('#card-areas .area-icon-btn[title="Hide on the map"]').first().click();
  assert(!(await areasList())[0].onMap, 'the eye button hides the shape');
  await page.locator('#card-areas .area-icon-btn[title="Show on the map"]').first().click();
  assert((await areasList())[0].onMap, 'and shows it again');

  // The pin follows: dragging it moves its circle
  const pb = await box('.user-pin');
  await drag(pb, -60, 40);
  await ready(0);
  L0 = (await areasList())[0];
  const moved = await page.evaluate(id => WAMAP.pins.get(id), pinId);
  want = expectCircle(L0.lat, L0.lon, L0.radius);
  assert(Math.abs(moved.lat - L0.lat) < 1e-9 && Math.abs(moved.lon - pinData.lon) > 1e-4 && sameCounts(L0.counts, want),
    `dragging the pin moves its circle and refreshes the list: ${cstr(L0.counts)} (expected ${cstr(want)})`);

  // A second ring from the popup
  await page.locator('.user-pin').first().click();
  const popupText = await page.locator('.leaflet-popup-content').textContent();
  assert(/places/.test(popupText), 'the pin popup summarises its radius search: ' + popupText.replace(/\s+/g, ' ').slice(0, 120));
  await page.locator('.leaflet-popup-content button', { hasText: 'Add another radius' }).click();
  await ready(1);
  const L1 = (await areasList())[1];
  assert(L1 && Math.abs(L1.radius - 1609.344) < 0.01 && L1.pinId === pinId, 'a second ring steps up to the next usual radius (1 mile)');
  assert(L1 && Math.abs(L1.bearing - 55) < 1e-9, 'its handle sits 35° round from the first ring\'s, so the labels do not stack (' + (L1 && L1.bearing) + '°)');
  await page.locator('#area-' + L1.id + ' .area-icon-btn[title="Delete this shape"]').click();
  assert((await areasList()).length === 1, 'a shape can be deleted');

  // Drawing an area, with the amenities layer on: a click on a marker adds a corner
  await setToggle('card-amenities', true);
  await page.evaluate(() => { WAMAP.map.closePopup(); WAMAP.map.setView([47.61, -122.33], 14, { animate: false }); });
  await page.waitForTimeout(1200);
  const poi = await page.evaluate(([x0, y0, w, h]) => {
    for (const el of document.querySelectorAll('.leaflet-marker-pane .marker-cluster, .leaflet-marker-pane .poi-chip')) {
      const b = el.getBoundingClientRect(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      if (cx > x0 + w * 0.3 && cx < x0 + w * 0.7 && cy > y0 + h * 0.3 && cy < y0 + h * 0.7) return { x: cx, y: cy };
    }
    return null;
  }, [mb.x, mb.y, mb.width, mb.height]);
  const corners = [poi || { x: mid.x - 150, y: mid.y - 100 }, { x: mid.x + 170, y: mid.y - 120 }, { x: mid.x + 180, y: mid.y + 130 }, { x: mid.x - 160, y: mid.y + 120 }];
  const cxy = corners.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
  corners.sort((a, b) => Math.atan2(a.y - cxy.y, a.x - cxy.x) - Math.atan2(b.y - cxy.y, b.x - cxy.x));
  await page.locator('#draw-area-btn').click();
  assert(await page.locator('.draw-capture').count() === 1 && await page.locator('.draw-bar').isVisible(), 'drawing shows its capture layer and toolbar');
  for (const c of corners) { await page.mouse.click(c.x, c.y); await page.waitForTimeout(350); }
  assert(!(await page.locator('.leaflet-popup').count()), 'clicks while drawing never open marker popups' + (poi ? ' (one landed on a marker)' : ''));
  await page.mouse.click(corners[0].x, corners[0].y); // closing click on the first corner
  await ready(1);
  let P = (await areasList())[1];
  assert(P && P.type === 'polygon' && P.pts.length === 4 && P.editing, 'clicking the first corner closes a 4-corner area, ready to reshape: ' + JSON.stringify(P && { pts: P.pts.length, editing: P.editing }));
  assert(await page.locator('.draw-capture').count() === 0, 'the capture layer is gone after finishing');
  want = expectPolygon(P.pts);
  assert(want.places > 20 && sameCounts(P.counts, want), `the area lists every place, stop and route inside or touching it: ${cstr(P.counts)} (expected ${cstr(want)})`);

  // Reshape: drag a corner, add a corner from a midpoint, remove one by right-click
  const before = P.pts[0].slice();
  const vb = await box('.area-vertex');
  await drag(vb, 70, 45);
  await ready(1);
  P = (await areasList())[1];
  want = expectPolygon(P.pts);
  assert((P.pts[0][0] !== before[0] || P.pts[0][1] !== before[1]) && sameCounts(P.counts, want), `dragging a corner reshapes the area and its list: ${cstr(P.counts)} (expected ${cstr(want)})`);
  await drag(await box('.area-mid'), 25, -35);
  await ready(1);
  P = (await areasList())[1];
  assert(P.pts.length === 5, 'dragging a midpoint adds a corner (' + P.pts.length + ')');
  const v2 = await box('.area-vertex');
  await page.mouse.click(v2.x, v2.y, { button: 'right' });
  await page.waitForTimeout(600);
  P = (await areasList())[1];
  assert(P.pts.length === 4, 'right-clicking a corner removes it (' + P.pts.length + ')');
  const ptsBefore = P.pts.map(p => p.slice());
  await drag(await box('.area-label'), 40, 30);
  await ready(1);
  P = (await areasList())[1];
  const dLat = P.pts.map((p, i) => p[0] - ptsBefore[i][0]);
  assert(dLat.every(d => Math.abs(d) > 1e-5) && Math.max(...dLat) - Math.min(...dLat) < 1e-4, 'dragging the label moves the whole area');
  want = expectPolygon(P.pts);
  assert(sameCounts(P.counts, want), `list follows the move: ${cstr(P.counts)} (expected ${cstr(want)})`);
  assert(P.labelPane === 'areaHandles' && /· [\d,]+ places? · [\d,]+ stops?$/.test(P.label), 'while reshaping, the label sits with the handles and names its counts: ' + P.label);
  await page.locator('#area-' + P.id + ' .area-icon-btn[title="Done reshaping"]').click();
  P = (await areasList())[1];
  assert(await page.locator('.area-vertex').count() === 0 && !P.editing, 'Done reshaping hides the corner handles');
  assert(P.labelPane === 'areaLabels', 'and the label goes back under the markers, so it never hides a pin or a place');

  // Results list: open a group, click a place
  const group = page.locator('#area-' + P.id + ' .area-group > summary').first();
  await group.click();
  const firstItem = page.locator('#area-' + P.id + ' .area-item').first();
  const itemName = (await firstItem.locator('.area-item-name').textContent()).trim();
  await firstItem.click();
  await page.waitForTimeout(500);
  const pop = (await page.locator('.leaflet-popup-content').textContent().catch(() => '')) || '';
  assert(pop.includes(itemName), 'clicking a listed place opens its popup on the map: ' + itemName);
  const rings = () => page.evaluate(() => { let n = 0; WAMAP.map.eachLayer(l => { if (l instanceof L.CircleMarker && l.options.radius === 17 && l.options.fill === false) n++; }); return n; });
  const secondItem = page.locator('#area-' + P.id + ' .area-item').nth(1);
  if (await secondItem.count()) {
    await secondItem.click();
    await page.waitForTimeout(500);
    const n = await rings();
    assert(n === 2, 'the next listed place clicked keeps its highlight ring (casing and ring: ' + n + ' layers)');
  }
  await page.evaluate(() => WAMAP.map.closePopup());
  assert(await rings() === 0, 'closing the popup removes the highlight');

  // CSV
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#area-' + P.id + ' button', { hasText: 'CSV' }).click()]);
  const csv = readFileSync(await dl.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
  const nRows = P.counts.places + P.counts.stops + P.counts.routes;
  assert(/^Area,Group,Type,Name,Address,Latitude,Longitude,Agency \/ source,Link$/.test(csv[0]) && csv.length === nRows + 1,
    `CSV has a header and one row per listed item (${csv.length - 1} of ${nRows}): ${dl.suggestedFilename()}`);

  // Esc cancels a drawing without leaving a shape
  await page.locator('#draw-area-btn').click();
  await page.mouse.click(mid.x - 60, mid.y - 40);
  await page.waitForTimeout(350);
  await page.mouse.click(mid.x + 60, mid.y - 40);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  assert((await areasList()).length === 2 && await page.locator('.draw-capture').count() === 0 && await page.locator('.draw-bar').count() === 0,
    'Esc cancels a drawing and leaves no shape behind');

  // Enter on a toolbar button presses that button: Cancel cancels, even with three corners down
  await page.locator('#draw-area-btn').click();
  for (const [dx, dy] of [[-80, -50], [80, -50], [0, 70]]) { await page.mouse.click(mid.x + dx, mid.y + dy); await page.waitForTimeout(350); }
  await page.locator('.draw-bar button', { hasText: 'Cancel' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  assert((await areasList()).length === 2 && await page.locator('.draw-bar').count() === 0, 'Enter on the Cancel button cancels the drawing instead of closing the area');

  // From the keyboard: the arrow keys move the map under a crosshair, A puts a corner there, Enter closes
  await page.locator('#draw-area-btn').click();
  const kbdCorners = [];
  for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(450);
    kbdCorners.push(await page.evaluate(() => { const c = WAMAP.map.getCenter(); return [c.lat, c.lng]; }));
    await page.keyboard.press('a');
  }
  assert(await page.locator('.draw-capture.kbd').count() === 1, 'using the keyboard shows the crosshair');
  await page.keyboard.press('Enter');
  await ready(2);
  const K = (await areasList())[2];
  const focusedLabel = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'));
  assert(K && K.type === 'polygon' && K.pts.length === 3 &&
    K.pts.every((p, i) => Math.abs(p[0] - kbdCorners[i][0]) < 1e-9 && Math.abs(p[1] - kbdCorners[i][1]) < 1e-9) && focusedLabel === 'Name',
    'from the keyboard, A puts each corner at the crosshair and Enter closes the area, then focus goes to its name: ' + JSON.stringify(K && K.pts.length) + ' / ' + focusedLabel);

  // Closing with a double-click on the first corner keeps that corner
  await page.locator('#draw-area-btn').click();
  const dcs = [[-90, -60], [90, -60], [100, 60], [-80, 70]].map(([dx, dy]) => ({ x: mid.x + dx, y: mid.y + dy }));
  for (const c of dcs) { await page.mouse.click(c.x, c.y); await page.waitForTimeout(350); }
  await page.mouse.dblclick(dcs[0].x, dcs[0].y);
  await page.waitForTimeout(700);
  const D = (await areasList())[3];
  assert(D && D.type === 'polygon' && D.pts.length === 4, 'double-clicking the first corner closes the area and keeps all four corners (' + (D && D.pts.length) + ')');

  // Geometry notes: an area whose edges cross, and a small area in square feet
  const geomText = async pts => {
    const id = await page.evaluate(p => WAMAP.areas.addPolygon(p).id, pts);
    const t = (await page.locator('#area-' + id + ' .area-geom').textContent()).trim();
    await page.locator('#area-' + id + ' .area-icon-btn[title="Delete this shape"]').click();
    return t;
  };
  const [cLat, cLon] = await page.evaluate(() => { const c = WAMAP.map.getCenter(); return [c.lat, c.lng]; });
  const bowText = await geomText([[cLat - 0.002, cLon - 0.002], [cLat + 0.002, cLon + 0.002], [cLat + 0.002, cLon - 0.002], [cLat - 0.002, cLon + 0.002]]);
  assert(/^Edges cross/.test(bowText), 'an area whose edges cross says so instead of giving a wrong area: ' + bowText);
  const smallText = await geomText([[cLat, cLon], [cLat + 0.0001, cLon], [cLat + 0.0001, cLon + 0.00015], [cLat, cLon + 0.00015]]);
  assert(/^[\d,]+ sq ft · /.test(smallText), 'a small area is given in square feet: ' + smallText);
  for (const x of [D, K]) if (x) await page.locator('#area-' + x.id + ' .area-icon-btn[title="Delete this shape"]').click();
  assert((await areasList()).length === 2, 'the extra areas are deleted again');

  // Saved in the browser: a reload brings both shapes back, the circle on its pin
  const savedShapes = await areasList();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.WAMAP && WAMAP.areas && WAMAP.areas.list().length === 2, null, { timeout: 10000 }).catch(() => {});
  await ready(0); await ready(1);
  const restored = await areasList();
  const rc = restored.find(s => s.type === 'circle'), rp = restored.find(s => s.type === 'polygon');
  const oc = savedShapes.find(s => s.type === 'circle'), op = savedShapes.find(s => s.type === 'polygon');
  assert(restored.length === 2 && rc && rc.pinId === pinId && Math.abs(rc.radius - oc.radius) < 0.02 && rc.style.color === '#aa3355',
    'after a reload the circle is back on its pin with its radius and style');
  const samePts = rp && rp.pts.length === op.pts.length && rp.pts.every((p, i) => Math.abs(p[0] - op.pts[i][0]) < 2e-6 && Math.abs(p[1] - op.pts[i][1]) < 2e-6);
  const rpWant = rp ? expectPolygon(rp.pts) : null;
  assert(samePts && sameCounts(rp.counts, rpWant), `and the area is back with its corners and list: ${rp ? cstr(rp.counts) : '-'} (expected ${rpWant ? cstr(rpWant) : '-'})`);

  // Switched off, the card stays off after a reload: the shapes wait and nothing loads until asked
  await page.locator('#card-areas .card-toggle').click();
  await page.waitForTimeout(800); // the link state follows the switch
  assert(!(await page.locator('#card-areas .card-toggle input').isChecked()), 'the search card can be switched off');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.WAMAP && WAMAP.areas && WAMAP.areas.list().length === 2, null, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  let off = await areasList();
  assert(off.length === 2 && !(await page.locator('#card-areas .card-toggle input').isChecked()) &&
    off.every(s => !s.onMap && s.counts.places == null && s.transit === 'idle' && /not loaded/.test(s.summary)),
    'a card switched off stays off after a reload, its shapes kept and nothing loaded: ' + JSON.stringify(off.map(s => [s.onMap, s.counts.places, s.transit, s.summary])));
  const offIdx = off.findIndex(s => s.type === 'polygon');
  await page.locator('#area-' + off[offIdx].id + ' .area-title').click();
  await ready(offIdx);
  off = await areasList();
  const offWant = expectPolygon(off[offIdx].pts);
  assert(!off[offIdx].onMap && sameCounts(off[offIdx].counts, offWant), `opening an entry lists its results while the card is off: ${cstr(off[offIdx].counts)} (expected ${cstr(offWant)})`);
  await page.locator('#card-areas .card-toggle').click();
  await ready(0); await ready(1);
  assert((await areasList()).every(s => s.onMap), 'switching the card back on shows the shapes');

  // Removing a pin removes its circles
  await page.locator('#pin-clear-btn').click();
  await page.waitForTimeout(300);
  const left = await areasList();
  assert(left.length === 1 && left[0].type === 'polygon', 'clearing the pins removes their radius searches');
  await page.locator('#area-' + left[0].id + ' .area-icon-btn[title="Delete this shape"]').click();
  assert((await areasList()).length === 0 && await page.locator('#card-areas .area-empty').isVisible(), 'deleting the last shape empties the list');

  // Transit answers stay true to the shape. Here the stops service answers
  // slowly (when told to) and only with the stops inside the queried box,
  // from a grid of stops over Seattle.
  const GRID = [];
  for (let la = 47.5; la <= 47.75 + 1e-9; la += 0.004) for (let lo = -122.5; lo <= -122.2 + 1e-9; lo += 0.004) GRID.push([+lo.toFixed(4), +la.toFixed(4)]);
  const tq = { delay: 0, fail: false, aborted: 0, queries: 0 };
  const onFailed = r => { if (/FeatureServer\/[13]\/query/.test(r.url())) tq.aborted++; };
  page.on('requestfailed', onFailed);
  const TQ_URL = /FeatureServer\/[13]\/query|interpreter/;
  const tqRoute = async route => {
    const url = new URL(route.request().url());
    try {
      if (tq.fail) return await route.fulfill({ status: 500, contentType: 'text/plain', body: 'down' });
      if (url.pathname.includes('interpreter')) return await route.fallback();
      if (tq.delay) await new Promise(r => setTimeout(r, tq.delay));
      if (!/FeatureServer\/1\/query/.test(url.pathname)) return await route.fallback();
      tq.queries++;
      const env = (url.searchParams.get('geometry') || '').split(',').map(Number);
      const feats = +(url.searchParams.get('resultOffset') || 0) ? [] : GRID.filter(([lo, la]) => lo >= env[0] && la >= env[1] && lo <= env[2] && la <= env[3])
        .map(([lo, la]) => ({ type: 'Feature', properties: { stop_name: 'Grid ' + lo + ',' + la, stop_id: 'KCM_' + Math.round((lo + 180) * 1e4) + '_' + Math.round(la * 1e4) },
          geometry: { type: 'Point', coordinates: [lo, la] } }));
      return await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: feats }) });
    } catch (e) { /* the page cancelled the request meanwhile */ }
  };
  await page.route(TQ_URL, tqRoute);
  const gridWant = s => GRID.filter(([lo, la]) => hav(s.lat, s.lon, la, lo) <= s.radius + EDGE).length;
  await setToggle('card-amenities', false);
  await page.evaluate(() => { WAMAP.map.closePopup(); WAMAP.map.setView([47.62, -122.35], 13, { animate: false }); });
  await page.waitForTimeout(800);
  await page.locator('#pin-mode-btn').click();
  await page.mouse.click(mid.x, mid.y);
  await page.keyboard.press('Escape');
  await settled(() => document.getElementById('pin-count').textContent.trim() === '1');
  const gridPin = await page.evaluate(() => JSON.parse(localStorage.getItem('wamap:pins')).v[0].id);
  await page.evaluate(id => { WAMAP.areas.addCircle(id, 1500); }, gridPin);
  await ready(0);
  let T = (await areasList())[0];
  assert(T.counts.stops === gridWant(T) && gridWant(T) > 20, `transit stops come from the answer for the shape's own box: ${T.counts.stops} (expected ${gridWant(T)})`);
  // Away and back while the far query is slow: its late answer must not land.
  // (Leftward: the legends on the right can cover a pin dragged that way.)
  tq.delay = 3000; tq.aborted = 0;
  await drag(await box('.user-pin'), -300, 0);
  await page.waitForTimeout(300);
  T = (await areasList())[0];
  assert(T.transit === 'loading' && T.counts.stops == null && /transit loading/.test(T.summary),
    'while a query for a moved shape runs, no stale transit counts are shown: ' + T.summary);
  await drag(await box('.user-pin'), 300, 0);
  await page.waitForTimeout(4000);
  T = (await areasList())[0];
  assert(T.transit === 'ok' && T.counts.stops === gridWant(T), `moved back inside the first answer, the late answer for the far spot is ignored: ${T.counts.stops} stops (expected ${gridWant(T)})`);
  assert(tq.aborted >= 1, 'and the superseded query is cancelled (' + tq.aborted + ' requests)');
  // A coarse answer for a big circle is not reused when it shrinks: finer lines are fetched, and the list says so meanwhile.
  tq.delay = 0;
  const rin = page.locator('#card-areas .area-radius').first();
  await rin.fill('31'); await rin.press('Enter');
  await ready(0);
  T = (await areasList())[0];
  assert(T.counts.stops === gridWant(T), `a 31 mile circle lists its ${gridWant(T)} grid stops: ${T.counts.stops}`);
  tq.delay = 2500;
  const q0 = tq.queries;
  await rin.fill('3'); await rin.press('Enter');
  await page.waitForTimeout(1000);
  T = (await areasList())[0];
  assert(T.transit === 'loading' && T.counts.stops != null && /updating transit/.test(T.summary),
    'shrinking it refetches, saying so while the last answer stands in: ' + T.summary);
  await ready(0);
  T = (await areasList())[0];
  assert(tq.queries > q0 && T.counts.stops === gridWant(T) && !/updating/.test(T.summary), `then the list settles: ${T.counts.stops} stops (expected ${gridWant(T)})`);
  // A failed query leaves no stale counts behind.
  tq.delay = 0; tq.fail = true;
  await drag(await box('.user-pin'), 0, 300);
  await settled(() => WAMAP.areas.list()[0].transit === 'err', 20000);
  T = (await areasList())[0];
  assert(T.transit === 'err' && T.counts.stops == null && /transit unavailable/.test(T.summary), 'a failed transit query shows transit as unavailable, not old counts: ' + T.summary);
  await page.unroute(TQ_URL, tqRoute);
  page.off('requestfailed', onFailed);
  await page.locator('#pin-clear-btn').click();
  assert((await areasList()).length === 0, 'clearing the pin removes its circle');

  for (const id of ['amenities', 'transit', 'crime']) await setToggle('card-' + id, true);
  await page.waitForTimeout(1200);
}

const mapPoint = ll => page.evaluate(([lat, lon]) => {
  const q = WAMAP.map.latLngToContainerPoint([lat, lon]), r = document.getElementById('map').getBoundingClientRect();
  return { x: r.left + q.x, y: r.top + q.y };
}, ll);

console.log('· zoning layer');
{
  // Real amenity and crime markers near the site would catch the clicks on
  // zones and the pin drop below; the evaluation reads the amenity files either way.
  await setToggle('card-amenities', false);
  await setToggle('card-crime', false);
  await setToggle('card-zoning', true);
  await page.waitForTimeout(400);
  assert(!(await page.locator('#card-insurance .card-toggle input').isChecked()), 'enabling zoning switched the insurance choropleth off (one area layer at a time)');
  await page.evaluate(() => { WAMAP.map.setView([47.35, -120.7], 7, { animate: false }); });
  await page.waitForTimeout(500);
  assert(/Zoom in to see zoning/.test(await page.locator('#card-zoning .status-line').textContent()), 'below zoom 13 the zoning card asks to zoom in');
  assert(await page.locator('.legend-block[data-layer="zoning"]').isVisible(), 'zoning legend visible');
  const cellsBefore = site.hits.zoneCells || 0;
  await page.evaluate(p => { WAMAP.map.setView([p.lat, p.lon], 15, { animate: false }); }, SITE);
  await page.waitForFunction(() => /zones in view/.test(document.querySelector('#card-zoning .status-line').textContent), null, { timeout: 8000 }).catch(() => {});
  const zStatus = (await page.locator('#card-zoning .status-line').textContent()).trim();
  const drawn = await page.evaluate(() => WAMAP.zoning.drawn());
  const byZone = Object.fromEntries(drawn.map(d => [d.zone, d]));
  const CATS = await page.evaluate(() => Object.fromEntries(WAMAP.CONFIG.ZONING.categories.map(c => [c.id, c.color])));
  assert(/^5 zones in view · Wenatchee, Unincorporated Chelan County$/.test(zStatus), `zones load per grid cell at zoom 15, city and county: "${zStatus}"`);
  assert(byZone.CC && byZone.CC.cat === 'MXU' && byZone.CC.fill === CATS.MXU && byZone.R6.cat === 'LIR' && byZone.PUB.cat === 'PUB' && byZone.RR5.cat === 'RUR',
    'zones are coloured by the atlas class: ' + drawn.map(d => d.zone + ':' + d.cat).join(', '));
  assert(byZone['C-2'] && byZone['C-2'].cat === 'COM', 'a zone the atlas has not classed takes a class from its name (General Business: commercial)');
  assert((site.hits.zoneCells || 0) > cellsBefore && drawn.every(d => d.lvl === 'f'), 'zoom 15 fetches the fine geometry');
  const cellsNow = site.hits.zoneCells;
  await page.evaluate(() => { WAMAP.map.panBy([160, 0], { animate: false }); WAMAP.map.panBy([-160, 0], { animate: false }); });
  await page.waitForTimeout(700);
  assert(site.hits.zoneCells === cellsNow, 'panning back over loaded cells fetches nothing again');
  const zp = await mapPoint([SITE.lat + 0.0006, SITE.lon + 0.0012]);
  await page.mouse.click(zp.x, zp.y);
  await page.waitForFunction(() => /Office parking minimum/.test((document.querySelector('.leaflet-popup-content') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const popText = (await page.locator('.leaflet-popup-content').textContent().catch(() => '')).replace(/\s+/g, ' ');
  assert(/Community Commercial CC/.test(popText) && /Wenatchee · Mixed Use · Mixed-use Low-rise/.test(popText), 'a zone popup names the zone, its jurisdiction and class: ' + popText.slice(0, 120));
  assert(/Medical office: Office uses, which in most codes include medical offices and clinics, are permitted outright/.test(popText) && /Office\s*✓ Permitted/.test(popText),
    'the popup states the medical-office outlook from the office-use code');
  assert(/Max height\s*45 ft/.test(popText) && /Office parking minimum\s*3 per 1,000 sf/.test(popText) && /Downtown design review overlay/.test(popText) && /Design review applies along SR 285/.test(popText),
    'the popup lists standards, overlays and notes');
  const zLinks = await page.locator('.leaflet-popup-content a').evaluateAll(as => as.map(a => a.href));
  assert(zLinks.some(h => /example\.org\/code\/wenatchee\/zoning/.test(h)) && zLinks.some(h => /commerce\.wa\.gov/.test(h)), 'the popup links the code chapter and the atlas');
  await page.evaluate(() => { WAMAP.map.closePopup(); });
  await page.locator('#card-zoning select.input').selectOption('office');
  await page.waitForTimeout(300);
  const office = Object.fromEntries((await page.evaluate(() => WAMAP.zoning.drawn())).map(d => [d.zone, d]));
  const OUT = await page.evaluate(() => Object.fromEntries(WAMAP.CONFIG.ZONING.outlook.map(o => [o.id, o.color])));
  assert(office.CC.fill === OUT.P && office.R6.fill === OUT.X && office['C-2'].fillOpacity === 0 && !!office['C-2'].dash,
    'office colouring: permitted, not permitted, and unrecorded left unfilled with a dashed edge');
  assert(/Office & medical use/.test(await page.locator('.legend-block[data-layer="zoning"]').textContent()), 'the legend follows the colouring');
  assert(/zmode=office/.test(await page.evaluate(() => { WAMAP.urlState.updateNow(); return location.hash; })), 'the link keeps the office colouring');
  await page.locator('#card-zoning select.input').selectOption('category');
}

console.log('· medical site evaluation');
{
  await page.evaluate(() => { WAMAP.modes.cancel(); });
  await page.locator('#pin-mode-btn').click();
  assert(await page.evaluate(() => WAMAP.modes.active === 'pin'), 'pin mode is on');
  const sp = await mapPoint([SITE.lat, SITE.lon]);
  await page.mouse.click(sp.x, sp.y);
  await page.evaluate(() => { WAMAP.modes.cancel(); });
  await page.waitForTimeout(300);
  assert(await page.locator('.user-pin').count() === 1, 'a click in pin mode drops a pin over a zone, without opening the zone popup');
  await page.locator('.user-pin').last().click();
  await page.waitForTimeout(300);
  const evalBtn = page.locator('.leaflet-popup-content button', { hasText: 'Evaluate for medical use' });
  assert(await evalBtn.count() === 1, 'a pin popup offers "Evaluate for medical use"');
  await evalBtn.click();
  const waitDone = async () => {
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(400);
      const r = await page.evaluate(() => WAMAP.siteEval.result());
      if (r && !r.res.loading) return r;
    }
    return page.evaluate(() => WAMAP.siteEval.result());
  };
  let r = await waitDone();
  assert(await page.locator('#site-eval').isVisible(), 'the evaluation panel opens');
  const C = id => r.res.criteria.find(c => c.id === id);
  assert(Object.values(r.status).every(s => s === 'ok') && Object.keys(r.status).length === 10, 'all ten sources answered: ' + JSON.stringify(r.status));
  assert(r.res.criteria.length === 11 && r.res.criteria.every(c => c.status === 'ok') && r.res.coverage === 100, 'all eleven criteria scored: ' + r.res.criteria.map(c => c.id + ':' + c.status).join(', '));
  const weighted = Math.round(r.res.criteria.reduce((t, c) => t + c.w * c.score, 0) / 100);
  assert(r.res.overall === weighted && r.res.rating === (weighted >= 80 ? 'Strong' : weighted >= 65 ? 'Good' : weighted >= 50 ? 'Fair' : 'Weak'),
    `the overall score is the weighted average (${r.res.overall}, ${r.res.rating})`);
  assert(C('zoning').score === 100 && /zoned Community Commercial \(CC\) in Wenatchee/.test(C('zoning').fact) &&
    C('zoning').details.some(t => /own zoning map, queried live, shows the same zone \(CC\)/.test(t)), 'zoning: office permitted, confirmed against the city\'s live map');
  assert(C('site').score === 90 && /2\.0-acre parcel has room for a 10,000 sf clinic and its 50 parking stalls/.test(C('site').fact) &&
    C('site').details.some(t => /Parcel 000000000001, 100 EXAMPLE AVE, WENATCHEE: 1\.97 acres/.test(t)) && C('site').details.some(t => /about 40 stalls in 1 lot/.test(t)),
    'parking & site: parcel area against the land needed, and the customer lot on the parcel: ' + C('site').details.join(' | '));
  assert(!site.ownerAsked, 'the parcel query never asks for owner fields');
  assert(C('access').score === 93 && /120 ft from SR 285, a principal arterial carrying about 14,000 vehicles a day/.test(C('access').fact), 'arterials: functional class, traffic count and interchange distance: ' + C('access').fact);
  assert(C('transit').score > 0 && /1 transit stop within a quarter mile, served by 1 route/.test(C('transit').fact), 'transit: the stop and route by the site: ' + C('transit').fact);
  assert(C('shelters').score === 81 && /nearest shelter is 0\.8 mi away/.test(C('shelters').fact), 'shelters: distance only, and the abuse-victims and women-only shelters are never used: ' + C('shelters').fact);
  assert(C('terrain').score === 95 && /slopes about 3%/.test(C('terrain').fact) && /outside FEMA's mapped floodplains/.test(C('terrain').fact), 'terrain: slope from USGS samples and the FEMA flood zone');
  assert(/within a 10-minute drive/.test(C('demand').fact) && C('demand').details.some(t => /census tracts?\)/.test(t)), 'demand: residents within the 10-minute catchment');
  assert(/employer or direct-purchase coverage/.test(C('payer').fact) && C('payer').details.some(t => /Payer mix within a 10-minute drive/.test(t)), 'payer mix of the catchment from the ACS');
  assert(/rates (Strong|Good|Fair|Weak) \(\d+ of 100\) for a primary care clinic/.test(r.writeup) && /It is zoned Community Commercial/.test(r.writeup) &&
    /In its favor: /.test(r.writeup) && /screening estimate/.test(r.writeup), 'the write-up states the rating, the zoning and the strengths: ' + r.writeup.slice(0, 160));
  const overlayN = await page.evaluate(() => { let n = 0; WAMAP.map.eachLayer(l => { if (l.feature && l.feature.geometry && /Polygon/.test(l.feature.geometry.type) && l.options && l.options.interactive === false && l.options.dashArray === '6 5') n++; }); return n; });
  assert(overlayN >= 1, 'the drive-time catchment is outlined on the map');
  const report = await page.evaluate(() => WAMAP.siteEval.text());
  assert(/Medical site evaluation: /.test(report) && r.res.criteria.every(c => report.includes(c.label)), 'the full report lists every criterion');
  // use type and size
  await page.locator('#site-eval select').selectOption('chc');
  r = await page.evaluate(() => WAMAP.siteEval.result());
  assert(C('transit').w === 14 && /for a community health center/i.test(r.writeup) && /rely on Medicaid or are uninsured/.test(r.res.criteria.find(c => c.id === 'payer').fact),
    'a community health center weighs transit more and scores the Medicaid and uninsured share');
  await page.locator('#site-eval select').selectOption('primary');
  await page.locator('#site-eval .se-sqft').fill('40000');
  await page.locator('#site-eval .se-sqft').dispatchEvent('change');
  r = await page.evaluate(() => WAMAP.siteEval.result());
  assert(r.res.criteria.find(c => c.id === 'site').score < 90 && /parcel is smaller than the roughly/.test(r.res.criteria.find(c => c.id === 'site').fact), 'a 40,000 sf building no longer fits the parcel');
  await page.locator('#site-eval .se-sqft').fill('10000');
  await page.locator('#site-eval .se-sqft').dispatchEvent('change');
  // the city's own map shows another zone: scored on the current zone, which caps the rating
  site.liveCode = 'R6';
  await page.locator('#site-eval button', { hasText: 'Re-run' }).click();
  r = await waitDone();
  const z = r.res.criteria.find(c => c.id === 'zoning');
  assert(z.score === 5 && r.res.rating === 'Weak' && r.res.gated && z.details.some(t => /shows R6, not the atlas's CC .*the score uses the city's current zone/.test(t)) && /caps the rating/.test(r.writeup),
    'a rezone on the city\'s live map is scored and caps the rating: ' + z.details.join(' | '));
  site.liveCode = 'CC';
  // sources that fail: straight-line catchment, unscored criteria named
  site.fail.add('valhalla'); site.fail.add('overpass'); site.fail.add('epqs');
  await page.locator('#site-eval button', { hasText: 'Re-run' }).click();
  r = await waitDone();
  assert(/within 4 miles in a straight line/.test(r.res.criteria.find(c => c.id === 'demand').fact), 'without routing, the catchment is a straight-line radius');
  assert(r.res.criteria.find(c => c.id === 'shelters').status === 'error' && /Not scored: .*shelters nearby/.test(r.writeup), 'without OpenStreetMap, shelters are not scored and the write-up says so');
  assert((site.hits.openMeteo || 0) > 0 && /coarse estimate/.test(r.res.criteria.find(c => c.id === 'terrain').fact), 'without USGS, slope comes from the coarse elevation model and says so');
  site.fail.clear();
  // A traffic count is credited to the state route it was taken on, not to a nearer arterial.
  const accessFact = await page.evaluate(() => {
    const st = {};
    for (const k of ['zoning', 'parcel', 'osm', 'roads', 'traffic', 'elevation', 'flood', 'transit', 'amenities', 'catchment']) st[k] = 'error';
    st.roads = st.traffic = st.osm = 'ok';
    const line = { type: 'LineString', coordinates: [[-122, 47], [-122, 47.01]] };
    const run = { status: st, errors: {}, data: {
      roads: { roads: [{ cls: 3, desc: 'Urban Other Principal Arterial', name: 'Main St', sr: null, d: 40, geometry: line },
        { cls: 3, desc: 'Urban Other Principal Arterial', name: 'SR 285', sr: 'SR 285', d: 140, geometry: line }] },
      traffic: { sections: [{ aadt: 14000, route: 'SR 285', year: 2025, d: 140 }] },
      osm: { parking: [], shelters: [], junctions: [] } } };
    return WAMAP.siteEvalInternals.evaluate(run, WAMAP.CONFIG.SITE_EVAL.profiles[0], 10000).criteria.find(c => c.id === 'access').fact;
  });
  assert(accessFact === 'it is 130 ft from Main St, a principal arterial, near SR 285 (about 14,000 vehicles a day)', 'a nearby state route\'s traffic count is not credited to the nearer arterial: ' + accessFact);
  await page.locator('#site-eval .se-close').click();
  assert(!(await page.locator('#site-eval').isVisible()) && !(await page.evaluate(() => WAMAP.siteEval.isOpen)), 'the panel closes');
  await page.locator('#pin-clear-btn').click();
  await setToggle('card-insurance', true);
  await page.waitForTimeout(600);
  assert(!(await page.locator('#card-zoning .card-toggle input').isChecked()), 'switching a choropleth on switches zoning off');
  await setToggle('card-amenities', true);
  await setToggle('card-crime', true);
}

console.log('· about modal');
await page.locator('#about-btn').click();
assert(await page.locator('#about-modal').isVisible(), 'sources modal opens');
assert(/Valhalla/.test(await page.locator('#sources-content').textContent()), 'sources content populated');
await page.waitForTimeout(300); // table links take the data's ACS vintage
const srcLinks = await page.locator('#sources-content .src-links a').evaluateAll(as => as.map(a => a.href));
assert(/Payer mix counts each person once/.test(await page.locator('#sources-content').textContent()) &&
  srcLinks.includes(`https://data.census.gov/table/ACSDT5Y${ACS_COUNTY.vintage}.B27010?g=040XX00US53`) &&
  srcLinks.some(h => /kff\.org/.test(h)) && srcLinks.some(h => /census\.gov\/topics\/health/.test(h)),
  'Sources & methodology explains the payer mix and links the ACS table, the Census glossary and KFF: ' + srcLinks.length + ' links');
{
  const txt = await page.locator('#sources-content').textContent();
  assert(/Washington State Zoning Atlas/.test(txt) && /Medical site evaluation/.test(txt) && /No owner information is read/.test(txt) && srcLinks.some(h => /commerce\.wa\.gov/.test(h)),
    'Sources & methodology documents the zoning atlas and the site evaluation\'s criteria');
}
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

console.log('· boundary fallback (pre-built files unavailable)');
{
  const fb = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  fb.on('pageerror', e => pageErrors.push('fallback page: ' + String(e)));
  await fb.route('**/*', async route => {
    const url = route.request().url();
    if (/\/data\/geo\//.test(url)) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' });
    const res = handle(url, route.request().method(), route.request().postData());
    return res === null ? route.continue() : route.fulfill(res);
  });
  tigerwebHits.length = 0;
  await fb.goto(BASE + '/#map=47.61/-122.33/12&layers=demographics', { waitUntil: 'domcontentloaded' });
  await fb.waitForFunction(() => /tracts loaded|Could not load/.test(document.querySelector('#card-demographics .status-line').textContent), null, { timeout: 20000 }).catch(() => {});
  const fbStatus = (await fb.locator('#card-demographics .status-line').textContent()).trim();
  assert(/8 tracts loaded/.test(fbStatus), 'tracts come from TIGERweb when data/geo is unavailable: "' + fbStatus + '"');
  assert(tigerwebHits.some(h => /\/TIGERweb\/Tracts_Blocks\/MapServer\/8\/query/.test(h)),
    'a generalized tract layer without GEOID falls through to the detailed service');
  await fb.close();
}

await page.screenshot({ path: 'smoke.png', fullPage: false });
await browser.close();

console.log('\npage errors: ' + (pageErrors.length ? '\n  ' + pageErrors.join('\n  ') : 'none'));
if (pageErrors.length) failures.push(pageErrors.length + ' page error(s)');
console.log(failures.length ? '\nFAILED: ' + failures.length : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
