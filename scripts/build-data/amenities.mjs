// Statewide amenities, one file per map category.
//
// The previous runtime layer asked Overpass for the current viewport only,
// truncated every answer (`out center 600`), recorded truncated areas as
// "covered" so they were never re-fetched, hid categories until zoom 9-14,
// and relied on two Overpass mirrors that no longer answer. Because Overpass
// prints nodes before ways, clinic nodes filled the 600 slots before any
// hospital campus (mapped as a way) was printed - which is exactly why
// hospitals were missing.
//
// This step instead pulls every category for the WHOLE state, uncapped:
// authoritative registries first (WA DOH and CMS hospitals, HRSA health
// centers, VA facilities, FDIC bank branches, USDA SNAP food retailers,
// NPPES pharmacies, NREL/AFDC fuel stations, NCES schools), then
// OpenStreetMap with wiki-correct tags to fill the gaps. An OSM point that
// duplicates a registry point is dropped (see merge()).
//
// Output: data/amenities/<id>.json
//   { built, category, sources: [{id, name, url, count}], kinds: [...],
//     fields: [...FIELDS], rows: [[lat, lon, name, kindIndex, sourceIndex, addr, ref, info, web]] }
// Trailing nulls are trimmed from each row to keep the files small.

import {
  overpass, WA_AREA, arcgisAll, fetchJSON, fetchRetry, qs, log, round, inWA, writeJSON, readJSON, geocodeBatch, waPlaces
} from './lib.mjs';

const FIELDS = ['lat', 'lon', 'name', 'kind', 'src', 'addr', 'ref', 'info', 'web'];

// Rite Aid and its Bartell Drugs chain closed every Washington store in 2025,
// but OpenStreetMap and NPPES still list many of them.
const CLOSED_PHARMACY = /\brite ?aid\b|\bbartell\b/i;

// ---------------------------------------------------------------- OSM tags
// Selectors follow the OSM wiki definitions. `kind` maps an element's tags to
// the label shown in the popup; `keepUnnamed` decides which unnamed features
// are still worth a marker.
const OSM = {
  schools: {
    selectors: ['["amenity"="school"]'],
    kind: () => 'School'
  },
  colleges: {
    selectors: ['["amenity"~"^(college|university)$"]'],
    kind: t => (t.amenity === 'university' ? 'University' : 'College')
  },
  health: {
    selectors: [
      '["amenity"="hospital"]', '["healthcare"="hospital"]',
      '["amenity"="clinic"]', '["healthcare"="clinic"]',
      '["amenity"="doctors"]', '["healthcare"="doctor"]',
      '["healthcare"="centre"]'
    ],
    // Features mis-tagged as hospitals or clinics that are not medical care sites.
    exclude: /adult family home|fire (&|and) rescue|fire station|fire dep|veterinar|animal|\bpet\b|nursing home|assisted living|senior living|memory care/i,
    kind: t => (t.amenity === 'hospital' || t.healthcare === 'hospital')
      ? (/emergency|\bER\b/.test(t.name || '') && !/hospital|medical center/i.test(t.name || '') ? 'Emergency department' : 'Hospital')
      : /urgent/i.test(`${t['healthcare:speciality'] || ''} ${t.name || ''} ${t.emergency || ''}`) ? 'Urgent care'
      : (t.amenity === 'doctors' || t.healthcare === 'doctor') ? "Doctor's office"
      : 'Clinic'
  },
  pharmacy: {
    // dispensing=no marks a drugstore without a pharmacy counter.
    selectors: ['["amenity"="pharmacy"]["dispensing"!="no"]', '["healthcare"="pharmacy"]["dispensing"!="no"]', '["shop"="chemist"]["dispensing"="yes"]'],
    exclude: CLOSED_PHARMACY,
    kind: () => 'Pharmacy'
  },
  restaurants: {
    // shop=coffee is coffee-bean retail, not a cafe, so it stays in retail.
    selectors: ['["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream|bar|pub|biergarten)$"]',
      '["shop"~"^(bakery|pastry|ice_cream)$"]'],
    kind: t => ({ restaurant: 'Restaurant', cafe: 'Cafe', fast_food: 'Fast food', food_court: 'Food court',
      ice_cream: 'Ice cream', bar: 'Bar', pub: 'Pub', biergarten: 'Beer garden' }[t.amenity]
      || ({ bakery: 'Bakery', pastry: 'Bakery', ice_cream: 'Ice cream' }[t.shop]) || 'Food & drink')
  },
  retail: {
    // Every shop=* except food retail (its own category), vehicle trade and
    // placeholder values; plus marketplaces.
    selectors: ['["shop"]["shop"!~"^(supermarket|grocery|greengrocer|convenience|health_food|butcher|deli|bakery|pastry|ice_cream|wholesale|car|car_repair|car_parts|motorcycle|tyres|fuel|vacant|no|yes|none|disused)$"]',
      '["amenity"="marketplace"]'],
    kind: t => t.shop === 'mall' ? 'Shopping mall' : t.shop === 'department_store' ? 'Department store'
      : t.amenity === 'marketplace' ? 'Marketplace'
      : t.shop ? t.shop.split(';')[0].replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) : 'Shop'
  },
  grocery: {
    selectors: ['["shop"~"^(supermarket|grocery|greengrocer|convenience|health_food|butcher|deli|wholesale)$"]'],
    kind: t => ({ supermarket: 'Supermarket', grocery: 'Grocery store', greengrocer: 'Produce market', convenience: 'Convenience store',
      health_food: 'Natural foods', butcher: 'Butcher', deli: 'Deli', wholesale: 'Warehouse club' }[t.shop] || 'Food store')
  },
  banks: {
    // Credit unions are amenity=bank in OSM too (NCUA supplies the registry).
    selectors: ['["amenity"="bank"]'],
    kind: t => /credit union|\bcu\b/i.test(`${t.name || ''} ${t.brand || ''} ${t.operator || ''}`) ? 'Credit union' : 'Bank'
  },
  fuel: {
    selectors: ['["amenity"="fuel"]', '["amenity"="charging_station"]'],
    kind: t => t.amenity === 'charging_station' ? 'EV charging' : 'Gas station',
    keepUnnamed: () => true
  },
  parks: {
    // leisure=garden is mostly private yards: keep botanical and community gardens only.
    selectors: ['["leisure"~"^(park|playground|nature_reserve|recreation_ground|dog_park)$"]',
      '["leisure"="garden"]["garden:type"~"^(botanical|community)$"]',
      '["boundary"="national_park"]', '["boundary"="protected_area"]["protect_class"~"^(2|5)$"]["name"]'],
    kind: t => ({ park: 'Park', playground: 'Playground', nature_reserve: 'Nature reserve', garden: 'Garden',
      recreation_ground: 'Recreation ground', dog_park: 'Dog park' }[t.leisure]
      || (t.boundary ? 'National / state park' : 'Park')),
    // Unnamed playgrounds, dog parks and pocket parks are real; unnamed
    // gardens are mostly private yards.
    keepUnnamed: t => /^(park|playground|dog_park)$/.test(t.leisure || '')
  }
};

const addrOf = t => [
  [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
  t['addr:city']
].filter(Boolean).join(', ') || null;
const osmWeb = t => {
  const u = t.website || t['contact:website'] || t.url;
  return u && /^https?:\/\/\S+$/i.test(u) ? u : null;
};

async function osmCategory(id) {
  const spec = OSM[id];
  const body = spec.selectors.map(s => `nwr${s}(area.wa);`).join('');
  const ql = `[out:json][timeout:290];${WA_AREA}(${body});out center tags;`;
  const data = await overpass(ql);
  const rows = [];
  for (const e of data.elements || []) {
    const lat = e.lat != null ? e.lat : e.center && e.center.lat;
    const lon = e.lon != null ? e.lon : e.center && e.center.lon;
    if (lat == null || !inWA(lat, lon)) continue;
    const t = e.tags || {};
    const kind = spec.kind(t);
    const name = t.name || t.brand || t.operator || null;
    if (!name && !(spec.keepUnnamed && spec.keepUnnamed(t))) continue;
    if (spec.exclude && spec.exclude.test([name, t.brand, t.operator].filter(Boolean).join(' '))) continue;
    // Unnamed features keep name null: they must never match each other by
    // name (every unnamed playground is called "Playground").
    rows.push({
      lat: round(lat), lon: round(lon), name, unnamed: !name, kind, addr: addrOf(t),
      ref: e.type[0] + e.id, web: osmWeb(t),
      info: t.opening_hours ? `Hours: ${t.opening_hours}`.slice(0, 120) : null
    });
  }
  if (rows.length < 20) throw new Error(`only ${rows.length} OSM features - Overpass answer looks truncated`);
  return rows;
}

// ------------------------------------------------------ authoritative data
// Each returns rows in the same shape; a failure is logged and the category
// carries on with its remaining sources.

const HRSA = 'https://gisportal.hrsa.gov/server/rest/services/HealthCareFacilities';
const CMS_POS = `${HRSA}/CMSApprovedFacilities_FS/MapServer`;
const joinAddr = (...p) => p.map(x => (x == null ? '' : String(x).trim())).filter(Boolean).join(', ') || null;
const pt = f => (f.geometry && isFinite(f.geometry.y) && isFinite(f.geometry.x) && inWA(f.geometry.y, f.geometry.x)
  ? { lat: round(f.geometry.y), lon: round(f.geometry.x) } : null);

/** WA Department of Health licensed hospitals: rooftop points, bed counts. */
async function dohHospitals() {
  const url = 'https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Hospitals/FeatureServer/0';
  const { features } = await arcgisAll(url, {
    outFields: 'NAME,ADDRESS,CITY,ACUTE,CAH,Beds_Total,Beds_Psychiatric,Weblink'
  });
  const rows = [];
  for (const f of features) {
    const p = pt(f); if (!p) continue;
    const a = f.attributes;
    const kind = a.CAH === 'Yes' ? 'Critical access hospital'
      : a.ACUTE === 'Yes' ? 'Hospital (acute care)'
      : a.Beds_Psychiatric > 0 ? 'Psychiatric hospital' : 'Hospital';
    rows.push({ ...p, name: a.NAME, kind,
      addr: joinAddr(String(a.ADDRESS || '').replace(/\s+P\.?\s?O\.? Box.*$/i, ''), a.CITY),
      info: a.Beds_Total > 0 ? `${a.Beds_Total} licensed beds` : null,
      web: /^https?:\/\//i.test(a.Weblink || '') ? a.Weblink : null });
  }
  if (rows.length < 80) throw new Error(`only ${rows.length} DOH hospitals`);
  return rows;
}

const CMS_HOSP_KIND = {
  'short term': 'Hospital (acute care)', psychiatric: 'Psychiatric hospital', rehabilitation: 'Rehabilitation hospital',
  'long term': 'Long-term care hospital', childrens: "Children's hospital", "children's": "Children's hospital",
  'critical access hospitals': 'Critical access hospital'
};
/** A layer of the CMS Provider of Services file, as served by HRSA's GIS. */
async function cmsLayer(layerId, kindOf, extraFields = '') {
  const { features } = await arcgisAll(`${CMS_POS}/${layerId}`, {
    where: "CMS_PROVIDER_STATE_ABBR='WA'",
    outFields: 'FACILITY_NM,CMS_PROVIDER_ADDRESS,CMS_PROVIDER_CITY,CMS_PROVIDER_CAT_SUB_TYP_DESC,CMS_PROVIDER_NUM' + (extraFields ? ',' + extraFields : '')
  });
  const rows = [];
  for (const f of features) {
    const p = pt(f); if (!p) continue;
    const a = f.attributes;
    rows.push({ ...p, ccn: a.CMS_PROVIDER_NUM, name: titleCase(a.FACILITY_NM), kind: kindOf(a),
      addr: joinAddr(a.CMS_PROVIDER_ADDRESS, a.CMS_PROVIDER_CITY),
      info: a.TOT_BED_CT > 0 ? `${a.TOT_BED_CT} beds (CMS)` : a.OPERATING_ROOM_CT > 0 ? `${a.OPERATING_ROOM_CT} operating rooms` : null });
  }
  return rows;
}
/**
 * CMS Hospital General Information: the hospitals currently enrolled in
 * Medicare (acute care, critical access, children's, psychiatric, VA, DoD),
 * keyed by CMS certification number. The Provider of Services layer still
 * carries long-closed providers ("Shadel Hosp", "Ranier State School Hosp"),
 * so it is only trusted for CCNs that appear here.
 */
async function cmsCurrentHospitals() {
  const d = await fetchJSON(`https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?${qs({
    'conditions[0][property]': 'state', 'conditions[0][value]': 'WA', 'conditions[0][operator]': '=', limit: 500
  })}`, {}, { retries: 2, timeoutMs: 60000 });
  const byCcn = new Map((d.results || []).map(r => [String(r.facility_id), r]));
  if (byCcn.size < 60) throw new Error(`only ${byCcn.size} WA hospitals in CMS Hospital General Information`);
  return byCcn;
}
const HGI_KIND = {
  'acute care hospitals': 'Hospital (acute care)', 'critical access hospitals': 'Critical access hospital',
  psychiatric: 'Psychiatric hospital', childrens: "Children's hospital",
  'acute care - veterans administration': 'VA hospital (medical center)', 'acute care - department of defense': 'Military hospital'
};
async function cmsHospitals() {
  const current = await cmsCurrentHospitals();
  const all = [...await cmsLayer(0, () => 'Hospital', 'TOT_BED_CT'), ...await cmsLayer(1, () => 'Hospital', 'TOT_BED_CT')];
  const rows = [];
  for (const r of all) {
    const h = current.get(String(r.ccn));
    if (!h) continue;
    rows.push({ ...r, name: titleCase(h.facility_name), kind: HGI_KIND[String(h.hospital_type || '').toLowerCase()] || 'Hospital',
      info: [r.info, h.emergency_services === 'Yes' ? 'Emergency services' : null].filter(Boolean).join(' · ') || null });
  }
  log(`CMS hospitals: ${rows.length} of ${all.length} POS records are current (HGI lists ${current.size})`);
  if (rows.length < 50) throw new Error(`only ${rows.length} current CMS hospitals`);
  return rows;
}
async function cmsClinics() {
  const rows = [
    ...await cmsLayer(2, () => 'Community health center (FQHC)'),
    ...await cmsLayer(3, () => 'Rural health clinic'),
    ...await cmsLayer(6, () => 'Ambulatory surgery center', 'OPERATING_ROOM_CT')
  ];
  if (rows.length < 200) throw new Error(`only ${rows.length} CMS clinic sites`);
  return rows;
}

/** HRSA health center service delivery sites (FQHCs and look-alikes). */
async function hrsaHealthCenters() {
  // Explicit outFields: the layer also carries named administrative contacts.
  const { features } = await arcgisAll(`${HRSA}/PrimaryHealthCareFacilities_FS/MapServer/0`, {
    where: "SITE_STATE_ABBR='WA'",
    outFields: 'SITE_NM,SITE_ADDRESS,SITE_CITY,SITE_URL,HCC_STATUS_DESC,HCC_LOC_DESC,HCC_LOC_SETTING_DESC,GRANTEE_NM'
  });
  const rows = [];
  for (const f of features) {
    const a = f.attributes;
    if (a.HCC_STATUS_DESC && !/active/i.test(a.HCC_STATUS_DESC)) continue;
    if (/mobile/i.test(`${a.HCC_LOC_DESC || ''} ${a.HCC_LOC_SETTING_DESC || ''}`)) continue; // vans have no fixed site
    const p = pt(f); if (!p) continue;
    const setting = a.HCC_LOC_SETTING_DESC && !/all other|clinic/i.test(a.HCC_LOC_SETTING_DESC) ? ` (${a.HCC_LOC_SETTING_DESC.toLowerCase()})` : '';
    const web = a.SITE_URL ? (/^https?:\/\//i.test(a.SITE_URL) ? a.SITE_URL : 'https://' + a.SITE_URL.trim()) : null;
    rows.push({ ...p, name: a.SITE_NM, kind: 'Community health center' + setting,
      addr: joinAddr(a.SITE_ADDRESS, a.SITE_CITY), info: a.GRANTEE_NM ? `Operated by ${titleCase(a.GRANTEE_NM)}` : null,
      web: web && /^https?:\/\/[^\s/]+\.[a-z]{2,}/i.test(web) ? web : null });
  }
  if (rows.length < 150) throw new Error(`only ${rows.length} active WA health center sites`);
  return rows;
}

/** Veterans Health Administration medical centers and clinics. */
async function vaFacilities() {
  const { features } = await arcgisAll(`${HRSA}/VHAFacilities_FS/MapServer/0`, {
    where: "VHA_S_STATE='WA'",
    outFields: 'VHA_STA_NAME,VHA_S_ADD1,VHA_S_ADD2,VHA_S_CITY,VHA_VAH,VHA_VCTR2,VHA_MOBILE,VHA_PCCBOC,VHA_MSCBOC,VHA_SUSPENDED'
  });
  const rows = [];
  for (const f of features) {
    const a = f.attributes;
    if (+a.VHA_MOBILE === 1 || /^y/i.test(String(a.VHA_SUSPENDED || ''))) continue;
    const p = pt(f); if (!p) continue;
    // VHA_VAH is not set for every medical center, so the name decides too
    // ("... VA Medical Center", not "... Medical Center-Vancouver" campuses).
    const kind = +a.VHA_VAH === 1 || /medical center$/i.test(a.VHA_STA_NAME || '') ? 'VA hospital (medical center)'
      : +a.VHA_VCTR2 === 1 ? 'Vet Center (counseling)' : 'VA clinic';
    // ADD1 is sometimes the site name, then ADD2 carries the street.
    const street = /^\d/.test(a.VHA_S_ADD1 || '') ? a.VHA_S_ADD1 : (a.VHA_S_ADD2 || a.VHA_S_ADD1);
    rows.push({ ...p, name: a.VHA_STA_NAME, kind, addr: joinAddr(street, a.VHA_S_CITY), web: 'https://www.va.gov/find-locations/' });
  }
  if (rows.length < 5) throw new Error(`only ${rows.length} WA VA sites`);
  return rows;
}

/** FDIC-insured bank branches (credit unions are NCUA-insured: see OSM). */
async function fdicBranches() {
  const hosts = ['https://api.fdic.gov/banks/locations', 'https://banks.data.fdic.gov/api/locations'];
  let lastErr;
  for (const base of hosts) {
    try {
      const out = [];
      for (let offset = 0; ; offset += 10000) {
        const data = await fetchJSON(`${base}?${qs({
          filters: 'STALP:WA', fields: 'NAME,OFFNAME,ADDRESS,CITY,LATITUDE,LONGITUDE,SERVTYPE,SERVTYPE_DESC,MAINOFF',
          limit: 10000, offset, format: 'json'
        })}`);
        const recs = (data.data || []).map(d => d.data || d);
        for (const r of recs) {
          const lat = +r.LATITUDE, lon = +r.LONGITUDE;
          if (!isFinite(lat) || !isFinite(lon) || !inWA(lat, lon)) continue;
          // Skip offices with no public counter: cyber (13), mobile (14, 29),
          // home/phone banking (15) and administrative (21).
          if ([13, 14, 15, 21, 29].includes(+r.SERVTYPE)) continue;
          const office = r.OFFNAME && r.OFFNAME !== r.NAME ? r.OFFNAME : null;
          out.push({ lat: round(lat), lon: round(lon), name: String(r.NAME || '').replace(/,?\s+National Association$/i, ', N.A.'),
            kind: +r.MAINOFF === 1 ? 'Bank (main office)' : 'Bank branch',
            addr: joinAddr(r.ADDRESS, r.CITY), info: office ? `Branch: ${titleCase(office)}` : null });
        }
        if (recs.length < 10000) break;
      }
      if (out.length < 300) throw new Error(`only ${out.length} WA branches`);
      return out;
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

/** USDA FNS: currently authorized SNAP food retailers. */
async function snapRetailers() {
  const url = 'https://services1.arcgis.com/RLQu0rK7h4kbsBq5/arcgis/rest/services/snap_retailer_location_data/FeatureServer/0';
  const { features } = await arcgisAll(url, {
    where: "State='WA'", outFields: 'Store_Name,Store_Street_Address,City,Store_Type,Latitude,Longitude'
  });
  const KIND = [
    [/super ?store|supermarket/i, 'Supermarket'], [/large grocery/i, 'Grocery store'], [/medium grocery/i, 'Grocery store'],
    [/small grocery/i, 'Grocery store'], [/convenience/i, 'Convenience store'], [/farmers|market/i, 'Farmers market'],
    [/meat|poultry|seafood/i, 'Butcher / seafood'], [/fruit|veg|produce/i, 'Produce market'], [/bakery/i, 'Bakery']
  ];
  const out = [];
  for (const f of features) {
    const a = f.attributes;
    // "Combination Grocery/Other" is drug stores, dollar stores and gas
    // stations; "Specialty" and "Other" are not grocery stores either.
    const hit = KIND.find(([re]) => re.test(a.Store_Type || ''));
    if (!hit) continue;
    const lat = f.geometry ? f.geometry.y : +a.Latitude, lon = f.geometry ? f.geometry.x : +a.Longitude;
    if (!isFinite(lat) || !isFinite(lon) || !inWA(lat, lon)) continue;
    out.push({ lat: round(lat), lon: round(lon), name: titleCase(a.Store_Name), kind: hit[1],
      addr: joinAddr(titleCase(a.Store_Street_Address), titleCase(a.City)), info: 'Accepts SNAP / EBT' });
  }
  if (out.length < 1000) throw new Error(`only ${out.length} WA food retailers`);
  return out;
}

/** NREL Alternative Fuels Data Center: open, public fuel and charging stations. */
async function afdcStations() {
  const key = process.env.DATA_GOV_KEY || 'DEMO_KEY';
  // NREL became the National Laboratory of the Rockies in 2025; try both hosts.
  const hosts = ['https://developer.nlr.gov', 'https://developer.nrel.gov'];
  let data, lastErr;
  for (const h of hosts) {
    try {
      data = await fetchJSON(`${h}/api/alt-fuel-stations/v1.json?${qs({ api_key: key, state: 'WA', status: 'E', access: 'public', limit: 'all' })}`,
        {}, { retries: 2, timeoutMs: 120000 });
      break;
    } catch (err) { lastErr = err; }
  }
  if (!data) throw lastErr;
  const FUEL = { ELEC: 'EV charging', CNG: 'CNG', LNG: 'LNG', LPG: 'Propane', E85: 'E85', BD: 'Biodiesel', HY: 'Hydrogen', RD: 'Renewable diesel' };
  const out = [];
  for (const s of data.fuel_stations || []) {
    if (!inWA(s.latitude, s.longitude)) continue;
    const ev = s.fuel_type_code === 'ELEC';
    const ports = [s.ev_dc_fast_num && `${s.ev_dc_fast_num} DC fast`, s.ev_level2_evse_num && `${s.ev_level2_evse_num} Level 2`].filter(Boolean).join(', ');
    out.push({ lat: round(s.latitude), lon: round(s.longitude), name: s.station_name,
      kind: ev ? 'EV charging' : `Alternative fuel (${FUEL[s.fuel_type_code] || s.fuel_type_code})`,
      addr: joinAddr(s.street_address, s.city),
      info: ev ? [ports && `Ports: ${ports}`, s.ev_network && s.ev_network !== 'Non-Networked' ? s.ev_network : null].filter(Boolean).join(' · ') || null
        : (s.access_days_time || null) });
  }
  if (out.length < 500) throw new Error(`only ${out.length} WA stations`);
  return out;
}

/**
 * NPPES (the federal NPI registry) community/retail pharmacies, geocoded with
 * the Census batch geocoder. OpenStreetMap maps well under half of the
 * state's pharmacies - most sit inside grocery and big-box stores and are
 * never drawn as their own feature - so this is the primary pharmacy source.
 */
async function nppesPharmacies() {
  const API = 'https://npiregistry.cms.hhs.gov/api/';
  const KEEP = /community\/retail|clinic pharmacy|compounding|specialty pharmacy/i;
  const seen = new Map();
  const fetchPrefix = async prefix => {
    for (let skip = 0; skip <= 1000; skip += 200) {
      const d = await fetchJSON(`${API}?${qs({ version: '2.1', enumeration_type: 'NPI-2', taxonomy_description: 'Pharmacy',
        state: 'WA', postal_code: prefix, limit: 200, skip })}`, {}, { retries: 3, timeoutMs: 60000 });
      if (d.Errors) throw new Error(JSON.stringify(d.Errors).slice(0, 200));
      const res = d.results || [];
      for (const r of res) {
        const tx = (r.taxonomies || []).find(t => t.primary) || (r.taxonomies || [])[0] || {};
        if (!KEEP.test(tx.desc || '')) continue;
        const loc = (r.addresses || []).find(a => a.address_purpose === 'LOCATION');
        if (!loc || loc.state !== 'WA') continue;
        const name = (r.basic && (r.basic.organization_name || r.basic.name)) || '';
        const dba = ((r.other_names || []).find(o => o.organization_name) || {}).organization_name;
        const label = dba || name;
        if (CLOSED_PHARMACY.test(label)) continue; // many of their NPIs were never deactivated
        seen.set(r.number, {
          id: r.number, name: titleCase(label), street: loc.address_1, city: loc.city, zip: String(loc.postal_code || '').slice(0, 5),
          // NPPES descriptions read "Pharmacy, Clinic Pharmacy": keep the specific part.
          kind: /retail/i.test(tx.desc) ? 'Pharmacy'
            : String(tx.desc).replace(/^pharmacy,\s*/i, '').replace(/^\w/, c => c.toUpperCase()).replace(/ Pharmacy$/, ' pharmacy')
        });
      }
      if (res.length < 200) return skip + res.length;
    }
    return 1200;
  };
  // Washington ZIPs are 980xx-994xx. Wildcard postal codes keep each query
  // under the API's 1,200-result window; a saturated 3-digit prefix is
  // re-queried by 4-digit prefix.
  for (let z = 980; z <= 994; z++) {
    const n = await fetchPrefix(`${z}*`);
    if (n >= 1200) for (let d = 0; d <= 9; d++) await fetchPrefix(`${z}${d}*`);
  }
  const list = [...seen.values()];
  log(`nppes: ${list.length} WA community pharmacies to geocode`);
  if (list.length < 400) throw new Error(`only ${list.length} NPPES pharmacies`);
  const coords = await geocodeBatch(list.map(p => ({ id: p.id, street: p.street, city: p.city, state: 'WA', zip: p.zip })));
  const out = [];
  for (const p of list) {
    const c = coords.get(p.id);
    if (!c || !inWA(c.lat, c.lon)) continue;
    out.push({ lat: round(c.lat), lon: round(c.lon), name: p.name, kind: p.kind,
      addr: joinAddr(titleCase(p.street), titleCase(p.city)), info: `NPI ${p.id}` });
  }
  log(`nppes: geocoded ${out.length}/${list.length}`);
  if (out.length < 300) throw new Error(`only ${out.length} pharmacies geocoded`);
  return out;
}

/**
 * WA Department of Health HELMS licensing extract: every DOH-credentialed
 * facility with a geocoded point. Used for pharmacies when the extract
 * carries them (the licence types are discovered, not assumed).
 */
async function helmsPharmacies() {
  const url = 'https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Facility_HELMS_Report_DEC2025/FeatureServer/0';
  const types = await fetchJSON(`${url}/query?${qs({ where: '1=1', groupByFieldsForStatistics: 'Regulatory_Authorization_Type__Name',
    outStatistics: JSON.stringify([{ statisticType: 'count', onStatisticField: 'FID', outStatisticFieldName: 'n' }]), f: 'json' })}`);
  const list = (types.features || []).map(f => `${f.attributes.Regulatory_Authorization_Type__Name}=${f.attributes.n}`);
  log(`HELMS licence types: ${list.join(' | ')}`);
  const wanted = (types.features || []).map(f => f.attributes.Regulatory_Authorization_Type__Name)
    // In-hospital (inpatient) pharmacies do not serve the public.
    .filter(t => /pharmac/i.test(t || '') && !/hospital|nuclear|wholesal|manufactur|non-?resident|drug other|shopkeeper|research/i.test(t));
  if (!wanted.length) throw new Error('HELMS extract has no pharmacy licence types');
  const { features } = await arcgisAll(url, {
    where: `Regulatory_Authorization_Type__Name IN (${wanted.map(t => `'${t.replace(/'/g, "''")}'`).join(',')})`,
    outFields: 'Account_Name,Organization_Owner__Account_Name,Regulatory_Authorization_Type__Name,Physical_Address,Mailing_Address,Website,Expiration_Date'
  });
  // The layer is a point-in-time extract of active licences. Its expiration
  // dates predate later renewals, so they are not used to drop records.
  const rows = [];
  for (const f of features) {
    const a = f.attributes;
    const p = pt(f); if (!p) continue;
    if (CLOSED_PHARMACY.test(`${a.Account_Name || ''} ${a.Organization_Owner__Account_Name || ''}`)) continue;
    const addr = String(a.Physical_Address || a.Mailing_Address || '').replace(/,?\s*United States$/i, '').replace(/,\s*Washington\s+\d{5}(-\d{4})?$/i, '');
    rows.push({ ...p, name: titleCase(a.Account_Name || a.Organization_Owner__Account_Name), kind: 'Pharmacy',
      addr: addr || null, info: 'Licensed by the WA Pharmacy Commission', web: /^https?:\/\//i.test(a.Website || '') ? a.Website : null });
  }
  if (rows.length < 400) throw new Error(`only ${rows.length} licensed pharmacies in HELMS (${wanted.join(', ')})`);
  return rows;
}

/** WA DOH local health jurisdiction clinics (public health departments). */
async function dohClinics() {
  const { features } = await arcgisAll('https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Clinics/FeatureServer/0', {
    outFields: 'ClinicName,AgencyName,Address1,City,Additional_Info'
  });
  const rows = [];
  for (const f of features) {
    const p = pt(f); if (!p) continue;
    const a = f.attributes;
    rows.push({ ...p, name: a.ClinicName, kind: 'Public health clinic', addr: joinAddr(titleCase(a.Address1), a.City),
      info: a.AgencyName ? `Operated by ${a.AgencyName}` : null });
  }
  if (rows.length < 50) throw new Error(`only ${rows.length} public health clinics`);
  return rows;
}

/**
 * NCUA credit union branches from the latest quarterly call report, geocoded
 * with the Census batch geocoder (the file carries addresses only). Credit
 * unions are not FDIC-insured, so FDIC's branch file never lists them.
 */
async function ncuaBranches() {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  let buf = null, quarter = null;
  const d = new Date();
  for (let i = 0; i < 6 && !buf; i++) {
    const q = new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 - 3 * i, 1));
    const ym = `${q.getUTCFullYear()}-${String(q.getUTCMonth() + 3).padStart(2, '0')}`; // quarter-end month
    try {
      const res = await fetchRetry(`https://ncua.gov/files/publications/analysis/call-report-data-${ym}.zip`, {}, { retries: 1, timeoutMs: 180000 });
      const b = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      if (b && b[0] === 0x50 && b[1] === 0x4b) { buf = b; quarter = ym; } // "PK": a real ZIP, not an HTML error page
    } catch (e) { /* try the previous quarter */ }
  }
  if (!buf) throw new Error('no NCUA call report ZIP in the last six quarters');
  const dir = await mkdtemp(`${tmpdir()}/ncua-`);
  await writeFile(`${dir}/c.zip`, buf);
  execFileSync('unzip', ['-o', '-j', '-q', `${dir}/c.zip`, 'Credit Union Branch Information.txt', '-d', dir]);
  const rows = parseCSV(await readFile(`${dir}/Credit Union Branch Information.txt`, 'latin1'));
  const wa = rows.filter(r => r.PhysicalAddressStateCode === 'WA' && !/corporate office|administrative/i.test(r.SiteTypeName || '') || (r.PhysicalAddressStateCode === 'WA' && r.MemberServices === '1'));
  log(`NCUA ${quarter}: ${wa.length} WA member-service sites`);
  if (wa.length < 200) throw new Error(`only ${wa.length} WA credit union sites`);
  const coords = await geocodeBatch(wa.map((r, i) => ({ id: String(i), street: r.PhysicalAddressLine1, city: r.PhysicalAddressCity,
    state: 'WA', zip: String(r.PhysicalAddressPostalCode || '').slice(0, 5) })));
  const out = [];
  wa.forEach((r, i) => {
    const c = coords.get(String(i));
    if (!c || !inWA(c.lat, c.lon)) return;
    const site = r.SiteName && r.SiteName !== r.CU_NAME ? titleCase(r.SiteName) : null;
    out.push({ lat: round(c.lat), lon: round(c.lon), name: titleCase(r.CU_NAME).replace(/\bFcu\b/, 'FCU').replace(/\bCu\b/, 'CU') + (/credit union|\bf?cu\b/i.test(r.CU_NAME) ? '' : ' (credit union)'),
      kind: 'Credit union', addr: joinAddr(titleCase(r.PhysicalAddressLine1), titleCase(r.PhysicalAddressCity)),
      info: [site && `Branch: ${site}`, r.HoursOfOperation ? `Hours: ${r.HoursOfOperation}`.slice(0, 120) : null].filter(Boolean).join(' · ') || null });
  });
  log(`NCUA: geocoded ${out.length}/${wa.length}`);
  if (out.length < 150) throw new Error(`only ${out.length} credit union sites geocoded`);
  return out;
}

/** Washington State Parks: official park list with entrance points and pages. */
async function stateParks() {
  const { features } = await arcgisAll('https://services5.arcgis.com/4LKAHwqnBooVDUlX/arcgis/rest/services/ParkBoundaries/FeatureServer/2', {
    outFields: 'ParkName,Category,WebPage,Lat_Entrance,Long_Entrance,Acres,LABEL_LOCAL', returnGeometry: false
  });
  const rows = [];
  for (const f of features) {
    const a = f.attributes;
    const lat = +a.Lat_Entrance, lon = +a.Long_Entrance;
    if (!isFinite(lat) || !isFinite(lon) || !inWA(lat, lon)) continue;
    rows.push({ lat: round(lat), lon: round(lon), name: a.LABEL_LOCAL || `${a.ParkName} ${a.Category || 'State Park'}`,
      kind: /marine/i.test(a.Category || '') ? 'State marine park' : 'State park', approx: parkSpread(a.Acres),
      info: a.Acres ? `${Math.round(a.Acres).toLocaleString('en-US')} acres` : null,
      web: /^https?:\/\//i.test(a.WebPage || '') ? a.WebPage : null });
  }
  if (rows.length < 100) throw new Error(`only ${rows.length} state parks`);
  return rows;
}

/**
 * USGS PAD-US 4.x: publicly owned local, state and national parks and
 * recreation areas (fee-owned parcels). One point per park unit, at the
 * largest parcel's centroid.
 */
async function padusParks() {
  const url = 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Type_PADUS/FeatureServer/0';
  const KIND = { LP: 'Park', LREC: 'Recreation area', SP: 'State park', SREC: 'State recreation area', NP: 'National park', NRA: 'National recreation area' };
  const { features } = await arcgisAll(url, {
    where: `State_Nm='WA' AND FeatClass='Fee' AND Des_Tp IN (${Object.keys(KIND).map(k => `'${k}'`).join(',')}) AND (Pub_Access IS NULL OR Pub_Access<>'XA')`,
    outFields: 'Unit_Nm,Loc_Nm,Mang_Name,Loc_Mang,Des_Tp,GIS_Acres', returnGeometry: true, maxAllowableOffset: 0.0005, geometryPrecision: 5
  });
  const units = new Map();
  for (const f of features) {
    const a = f.attributes;
    const c = ringCentroid(f.geometry);
    if (!c || !inWA(c.lat, c.lon)) continue;
    const name = cleanParkName(a.Loc_Nm || a.Unit_Nm);
    if (!name) continue;
    const k = `${name.toLowerCase()}|${a.Loc_Mang || a.Mang_Name}`;
    const prev = units.get(k);
    if (!prev || (a.GIS_Acres || 0) > prev.acres) {
      units.set(k, { lat: round(c.lat), lon: round(c.lon), name, kind: KIND[a.Des_Tp] || 'Park', acres: a.GIS_Acres || 0,
        approx: parkSpread(a.GIS_Acres),
        info: [a.Loc_Mang && a.Loc_Mang !== 'UNK' ? `Managed by ${titleCase(a.Loc_Mang)}` : null].filter(Boolean).join(' · ') || null });
    }
  }
  const rows = [...units.values()];
  if (rows.length < 1000) throw new Error(`only ${rows.length} PAD-US park units`);
  return rows;
}
const cleanParkName = s => {
  const n = titleCase(String(s || '').trim());
  // PAD-US fills unnamed units with "<Manager> 123" placeholders and parcel
  // codes such as "LP379" (a real "Pier 62" is kept).
  return !n || (/\b\d{2,}$/.test(n) && !/^pier\s/i.test(n)) || /^[a-z]{1,3}\s*-?\s*\d+$/i.test(n)
    || /^(unknown|unnamed)/i.test(n) ? null : n;
};
/**
 * How far (m) a point can sit from another source's point for the same park:
 * a centroid or an entrance lies up to about half the park's width away.
 */
const parkSpread = acres => (acres > 0 ? Math.min(8000, Math.round(0.9 * Math.sqrt(acres * 4047))) : 0);
/** Area-weighted centroid of an Esri polygon's largest ring (lat/lon). */
function ringCentroid(g) {
  if (!g) return null;
  if (g.centroid) return { lat: g.centroid.y, lon: g.centroid.x };
  let best = null;
  for (const ring of g.rings || []) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (!a) continue;
    const c = { lon: cx / (3 * a), lat: cy / (3 * a), area: Math.abs(a) };
    if (!best || c.area > best.area) best = c;
  }
  return best;
}

/** NCES public + private K-12 schools, and postsecondary institutions. */
async function ncesSchools(kind) {
  const folder = kind === 'k12'
    ? 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations'
    : 'https://nces.ed.gov/opengis/rest/services/Postsecondary_School_Locations';
  const listing = await fetchJSON(`${folder}?f=json`);
  const names = (listing.services || []).map(s => s.name.split('/').pop());
  const newest = re => names.map(n => { const m = n.match(re); return m ? { n, y: +m[1] } : null; })
    .filter(Boolean).sort((a, b) => b.y - a.y)[0];
  const services = kind === 'k12'
    ? [['Public school', newest(/^EDGE_GEOCODE_PUBLICSCH_(\d{4})$/i)], ['Private school', newest(/^EDGE_GEOCODE_PRIVATESCH_(\d{4})$/i)]]
    : [['College / university', newest(/^EDGE_GEOCODE_POSTSECONDARYSCH_(\d{4})$/i)]];
  const out = [];
  const used = [];
  for (const [label, svc] of services) {
    if (!svc) continue;
    const url = `${folder}/${svc.n}/MapServer/0`;
    const info = await fetchJSON(`${url}?f=json`);
    const fields = new Set((info.fields || []).map(f => f.name));
    const stateField = ['STATE', 'LSTATE', 'STABBR'].find(f => fields.has(f));
    if (!stateField) throw new Error(`${svc.n}: no state field`);
    const { features } = await arcgisAll(url, { where: `${stateField}='WA'`, outFields: '*' });
    used.push(`${svc.n} (${features.length})`);
    for (const f of features) {
      const p = pt(f); if (!p) continue;
      const a = f.attributes;
      out.push({ ...p, name: titleCase(a.NAME || a.SCH_NAME || a.INSTNM || 'School'), kind: label,
        addr: joinAddr(titleCase(a.STREET || a.LSTREET1 || a.ADDRESS), titleCase(a.CITY || a.LCITY)),
        info: `NCES ${String(svc.y).replace(/^(\d\d)(\d\d)$/, '20$1-$2')}` });
    }
  }
  if (out.length < (kind === 'k12' ? 1500 : 60)) throw new Error(`only ${out.length} WA ${kind} records from ${used.join(', ')}`);
  out.services = used;
  return out;
}

// ------------------------------------------------------------------ helpers
function titleCase(s) {
  if (!s) return s;
  const str = String(s).trim().replace(/\s+/g, ' ');
  // Leave mixed-case strings alone; only tame ALL-CAPS registry text.
  if (str !== str.toUpperCase()) return str;
  return str.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())
    .replace(/\b(Of|And|The|At|In|For)\b/g, w => w.toLowerCase())
    .replace(/\b(Ne|Nw|Se|Sw|Po|Llc|Pllc|Cvs|Qfc|Va|Ii|Iii|Iv|Usa|Wa)\b/g, w => w.toUpperCase())
    .replace(/'S\b/g, "'s").replace(/^./, c => c.toUpperCase());
}

/** RFC-4180 CSV -> array of objects keyed by the header row. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = ''; rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = (rows.shift() || []).map(h => h.replace(/^﻿/, '').trim());
  return rows.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/** Metres between two lat/lon points (equirectangular is plenty at this scale). */
function metres(a, b) {
  const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos((a.lat + b.lat) / 2 * k), y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

// Words that say what a place is rather than which place it is; ignored when
// comparing names ("Harborview Medical Center" vs "HARBORVIEW MEDICAL CTR").
const GENERIC = new Set(('the of and at in on for a an inc llc pllc co corp company center centre ctr medical med ' +
  'hospital hosp clinic clinics health healthcare care services service community regional family public ' +
  'chc fqhc campus location bank jpmorgan branch credit union cu fcu na fsb station gas fuel ev charging charger ' +
  'store stores market supermarket wholesale grocery foods food pharmacy rx drug drugs school park state wa washington ' +
  // Place and direction words: sharing only "Seattle" or "North" says
  // nothing about two places being the same one.
  'north south east west northwest northeast southwest southeast city downtown county puget sound pacific ' +
  'cascade valley seattle tacoma spokane bellevue everett kent renton yakima vancouver olympia bellingham ' +
  'kirkland redmond auburn federal way lynnwood kennewick pasco richland bremerton shoreline burien lakewood').split(' '));
// Kept in the normalised full name, which decides when no distinctive word is left.
const STOP = new Set('the of and at in on for a an inc llc pllc co corp company na fsb dba ltd'.split(' '));
// Health-system names are shared by many distinct facilities ("Swedish First
// Hill" vs "Swedish Cherry Hill"), so they only count when nothing else is left.
const HEALTH_BRANDS = new Set(('multicare providence swedish franciscan peacehealth kaiser permanente virginia mason uw ' +
  'medicine evergreenhealth kadlec confluence astria legacy sea mar seamar neighborcare healthpoint chas ichs yvfwc ' +
  'unitycare fred hutch hutchinson trios').split(' '));
const WA_COUNTIES = ('adams|asotin|benton|chelan|clallam|clark|columbia|cowlitz|douglas|ferry|franklin|garfield|grant|' +
  'grays harbor|island|jefferson|king|kitsap|kittitas|klickitat|lewis|lincoln|mason|okanogan|pacific|pend oreille|' +
  'pierce|san juan|skagit|skamania|snohomish|spokane|stevens|thurston|wahkiakum|walla walla|whatcom|whitman|yakima').split('|');

/**
 * Regex matching Washington place and county names, used for health
 * facilities, whose names so often carry their town ("Mount Vernon VA
 * Clinic", "Mount Vernon Chiropractic") that a shared town says nothing.
 */
function placeRegex(placeNames) {
  const names = [...new Set([...placeNames, ...WA_COUNTIES].map(n => String(n).toLowerCase().replace(/['’]/g, '').trim()).filter(n => n.length > 2))]
    .sort((a, b) => b.length - a.length)
    .map(n => n.split(/[^a-z0-9]+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^a-z0-9]+'));
  return names.length ? new RegExp(`\\b(${names.join('|')})\\b`, 'g') : null;
}

/** Everything merge() compares about a name, computed once per row. */
function nameInfo(name, cat) {
  const raw = String(name || '').toLowerCase().replace(/['’`]/g, '').replace(/&/g, ' and ').replace(/\bsaint\b/g, 'st')
    // "U.S. Bank, N.A." / "U.S. Bank National Association" -> "us bank"
    .replace(/\bu\.\s?s\.?(?=\s|$)/g, 'us').replace(/,?\s*(\bn\.\s?a\.?|national association)$/, '');
  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const stripped = cat.placeRe ? raw.replace(cat.placeRe, ' ') : raw;
  // Store numbers ("QFC 803", "Walgreens #12345", "T-1234") name a branch, not a brand.
  let tok = stripped.split(/[^a-z0-9]+/).filter(w => w.length > 1 && !GENERIC.has(w) && !/^[a-z]?\d+[a-z]?$/.test(w));
  if (cat.brands) { const rest = tok.filter(w => !cat.brands.has(w)); if (rest.length) tok = rest; }
  let decl = null;
  for (const [cls, re] of Object.entries(cat.kindWords || {})) if (re.test(raw)) { decl = cls; break; }
  const plain = words.filter(w => !STOP.has(w));
  return {
    tok: new Set(tok),
    all: new Set(plain.filter(w => !/^[a-z]?\d+[a-z]?$/.test(w))),
    norm: plain.join(' '),
    num: words.filter(w => /^\d+$/.test(w)).join('-'),
    decl
  };
}
const overlap = (A, B) => { let c = 0; for (const w of A) if (B.has(w)) c++; return c / Math.max(A.size, B.size); };

/**
 * Do two named rows name the same place? Distinctive words must overlap by
 * at least 60% of the LONGER name ("Pho Bac" and "Pho Hoa" share one word
 * of two: not the same). Rows from one source must agree exactly, since a
 * registry never lists one facility twice under different names.
 */
function sameNameAs(p, q, cat) {
  if (p.unnamed || q.unnamed) return false;
  if (p.num && q.num && p.num !== q.num) return false; // two numbered branches of one chain
  if (p.cls !== q.cls) {
    // Only a mis-classified copy of one place matches across classes: the
    // names may not claim different kinds ("Kadlec Clinic" is not "Kadlec
    // Regional Medical Center") and must agree in full, generic words too.
    if (cat.crossClassNames === false) return false;
    if (p.decl && q.decl && p.decl !== q.decl) return false;
    if (overlap(p.all, q.all) < 0.5) return false;
  }
  const A = p.tok, B = q.tok;
  if (!A.size || !B.size) return p.norm === q.norm;
  const o = overlap(A, B);
  return p.src === q.src ? o === 1 : o >= 0.6;
}
const disjoint = (p, q) => {
  if (!p.tok.size || !q.tok.size) return false;
  for (const w of p.tok) if (q.tok.has(w)) return false;
  return true;
};

/**
 * Merge sources in priority order. A row duplicates an already-kept row when
 *  - the names match (sameNameAs) within the pair's name radius: the class's
 *    `nameRadius` for two rows of one class, else the category `radius`,
 *    widened to the positional uncertainty (`approx`, metres) of geocoded or
 *    centroid sources; or
 *  - it comes from another source, is the same class of place (e.g. both
 *    hospitals) within that class's `classRadius`, and the names are not
 *    plainly different (Mary Bridge Children's shares Tacoma General's campus).
 * Distinct places that merely share a building or a campus are kept.
 * groups: [{ rows, approx, inferred }] in priority order; `inferred` marks a
 * source whose classes are guessed from tags (OpenStreetMap).
 */
function merge(groups, cat) {
  const { radius, classOf = () => 'x', classRadius = {}, nameRadius = {} } = cat;
  const maxBase = Math.max(radius, ...Object.values(classRadius), ...Object.values(nameRadius));
  // Rows whose uncertainty is wider than a few cells (big parks) live in a
  // coarse grid, so ordinary rows need not search kilometres around them.
  const WIDE = 1500;
  const grids = [{ deg: 0.01, cells: new Map(), maxApprox: 0 }, { deg: 0.1, cells: new Map(), maxApprox: 0 }];
  const cellKey = (g, lat, lon) => `${Math.floor(lat / g.deg)}:${Math.floor(lon / g.deg)}`;
  const around = (g, p, r) => {
    const a = Math.floor(p.lat / g.deg), b = Math.floor(p.lon / g.deg);
    const di = Math.ceil(r / 111320 / g.deg), dj = Math.ceil(r / (111320 * Math.cos(p.lat * Math.PI / 180)) / g.deg);
    const out = [];
    for (let i = -di; i <= di; i++) for (let j = -dj; j <= dj; j++) {
      const c = g.cells.get(`${a + i}:${b + j}`);
      if (c) for (const q of c) out.push(q);
    }
    return out;
  };
  const nameR = (p, q) => {
    if (p.cls !== q.cls) return radius; // weaker evidence: never widened
    const base = nameRadius[p.cls] != null ? nameRadius[p.cls] : Math.max(radius, classRadius[p.cls] || 0);
    return p.src === q.src ? base : Math.max(base, p.approx, q.approx);
  };
  const kept = [], counts = [], drops = [];
  groups.forEach(({ rows, approx = 0, inferred = false }, si) => {
    let n = 0;
    for (const row of rows) {
      const unnamed = row.unnamed || !row.name || row.name === row.kind;
      const cls = classOf(row);
      const p = { ...row, name: unnamed ? null : row.name, unnamed, src: si, cls,
        approx: Math.max(approx, row.approx || 0), ...nameInfo(unnamed ? '' : row.name, cat) };
      // A registry's own classification counts as what the name says; one
      // inferred from OpenStreetMap tags does not.
      if (!p.decl && !inferred && cat.kindWords) p.decl = cls;
      const r2 = classRadius[p.cls] != null ? classRadius[p.cls] : radius;
      let hit = null;
      for (const g of grids) {
        for (const q of around(g, p, Math.max(maxBase, p.approx, g.maxApprox))) {
          const d = metres(p, q);
          if (q.src !== si && q.cls === p.cls && d < r2 && !disjoint(p, q) && !(p.num && q.num && p.num !== q.num)) { hit = { q, d, rule: 'class' }; break; }
          if (d < nameR(p, q) && sameNameAs(p, q, cat)) { hit = { q, d, rule: 'name' }; break; }
        }
        if (hit) break;
      }
      if (hit) { drops.push({ p, ...hit }); continue; }
      const g = grids[p.approx > WIDE ? 1 : 0];
      const k = cellKey(g, p.lat, p.lon);
      if (!g.cells.has(k)) g.cells.set(k, []);
      g.cells.get(k).push(p);
      if (p.approx > g.maxApprox) g.maxApprox = p.approx;
      kept.push(p);
      n++;
    }
    counts.push(n);
  });
  return { kept, counts, drops };
}

// ----------------------------------------------------------------- catalog
// Sources per map category in priority order. `fallbackOnly` sources run
// only when every source before them failed. `approx` is a source's
// positional uncertainty in metres (address geocodes, centroids). The other
// keys tune duplicate detection (see merge()): `classOf` + `classRadius`
// (same kind of place at the same spot), `nameRadius` (same name nearby),
// `kindWords` (what a name says it is), `crossClassNames: false` (a
// playground never duplicates a park, nor a charger a gas station).
const OSM_SRC = (id, extra = {}) => ({ id: 'osm', name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/copyright',
  fn: () => osmCategory(id), ...extra });
const CATEGORIES = {
  schools: { radius: 80, sources: [
    { id: 'nces-k12', name: 'NCES EDGE public & private school locations', url: 'https://nces.ed.gov/programs/edge/Geographic/SchoolLocations', fn: () => ncesSchools('k12') },
    OSM_SRC('schools', { fallbackOnly: true })] },
  colleges: { radius: 200, sources: [
    { id: 'nces-post', name: 'NCES EDGE postsecondary institutions (IPEDS)', url: 'https://nces.ed.gov/programs/edge/Geographic/SchoolLocations', fn: () => ncesSchools('post') },
    OSM_SRC('colleges', { fallbackOnly: true })] },
  health: {
    radius: 150,
    classOf: r => /hospital|medical center|emergency/i.test(r.kind) ? 'hospital' : /surgery/i.test(r.kind) ? 'asc'
      : /doctor/i.test(r.kind) ? 'doctor' : /vet center/i.test(r.kind) ? 'vetctr' : 'clinic',
    classRadius: { hospital: 350, clinic: 40, asc: 40, doctor: 25, vetctr: 40 },
    // A hospital campus's OSM centre can sit well away from the licensed
    // address point; the same name within 1.5 km is the same hospital.
    nameRadius: { hospital: 1500 },
    kindWords: {
      hospital: /\bhospital\b|medical cent(er|re)\b|\bmed(ical)? ctr\b/,
      asc: /surg(ery|ical) cent|ambulatory surg|endoscopy/,
      clinic: /\bclinics?\b|urgent care|walk-?in|\bhealth cent(er|re)\b|\bchc\b|medical (office|group|building|plaza|pavilion)/,
      doctor: /\b(md|dds|dmd|pllc)\b|physicians?\b|\bdr\b|practice\b|associates\b/
    },
    brands: new Set([...HEALTH_BRANDS, 'university']),
    places: true, // town names are stripped before comparing (see placeRegex)
    sources: [
      { id: 'doh', name: 'WA Department of Health licensed hospitals', url: 'https://geo.wa.gov/datasets/626cb2ca35c64ea1a2ac502c573e3ec9', fn: dohHospitals },
      { id: 'cms-hosp', name: 'CMS Provider of Services: hospitals & critical access hospitals', url: 'https://data.hrsa.gov/data/download', fn: cmsHospitals },
      { id: 'va', name: 'Veterans Health Administration facilities', url: 'https://www.va.gov/find-locations/', fn: vaFacilities },
      { id: 'hrsa', name: 'HRSA health center service delivery sites', url: 'https://data.hrsa.gov/data/download', fn: hrsaHealthCenters, approx: 250 },
      { id: 'cms-clinic', name: 'CMS Provider of Services: FQHCs, rural health clinics & surgery centers', url: 'https://data.hrsa.gov/data/download', fn: cmsClinics, approx: 250 },
      { id: 'doh-lhj', name: 'WA DOH local health jurisdiction clinics', url: 'https://geo.wa.gov/', fn: dohClinics, approx: 250 },
      OSM_SRC('health')
    ]
  },
  pharmacy: { radius: 60, classRadius: { x: 45 }, sources: [
    { id: 'doh-helms', name: 'WA DOH licensed pharmacies (HELMS)', url: 'https://doh.wa.gov/licenses-permits-and-certificates/facilities-z/pharmacies', fn: helmsPharmacies, approx: 250 },
    { id: 'nppes', name: 'CMS NPPES NPI registry: community pharmacies (Census-geocoded)', url: 'https://npiregistry.cms.hhs.gov/', fn: nppesPharmacies, fallbackOnly: true, approx: 250 },
    OSM_SRC('pharmacy')] },
  grocery: { radius: 60,
    classOf: r => /convenience/i.test(r.kind) ? 'conv' : /farmers/i.test(r.kind) ? 'farm' : 'grocery',
    classRadius: { grocery: 60, conv: 30, farm: 60 },
    sources: [
      { id: 'snap', name: 'USDA SNAP-authorized food retailers', url: 'https://www.fns.usda.gov/snap/retailer-locator', fn: snapRetailers, approx: 250 },
      OSM_SRC('grocery')] },
  restaurants: { radius: 20, sources: [OSM_SRC('restaurants')] },
  retail: { radius: 20, sources: [OSM_SRC('retail')] },
  banks: { radius: 60,
    classOf: r => /credit union/i.test(r.kind) ? 'cu' : 'bank',
    classRadius: { bank: 40, cu: 40 },
    // "America's Credit Union" is not "Bank of America".
    kindWords: { cu: /credit union|\bf?cu\b/, bank: /\bbank\b|\bsavings\b|bancorp|\btrust\b/ },
    sources: [
      { id: 'fdic', name: 'FDIC BankFind branch locations', url: 'https://banks.data.fdic.gov/bankfind-suite/', fn: fdicBranches, approx: 250 },
      { id: 'ncua', name: 'NCUA credit union branches (Census-geocoded)', url: 'https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data', fn: ncuaBranches, approx: 250 },
      { ...OSM_SRC('banks'), name: 'OpenStreetMap (banks & credit unions)' }] },
  fuel: { radius: 40, crossClassNames: false,
    classOf: r => /EV/i.test(r.kind) ? 'ev' : 'fuel',
    classRadius: { ev: 30, fuel: 40 },
    sources: [
      { id: 'afdc', name: 'NREL Alternative Fuels Data Center (public stations)', url: 'https://afdc.energy.gov/stations', fn: afdcStations },
      OSM_SRC('fuel')] },
  // Park points from different sources can sit far apart for big parks (a
  // centroid vs an entrance): each registry row carries its park's spread as
  // `approx`. Unnamed parks and playgrounds only match at the tight radius.
  parks: { radius: 500, crossClassNames: false,
    classOf: r => (/playground/i.test(r.kind) ? 'play' : 'park'), classRadius: { park: 60, play: 25 }, sources: [
    { id: 'state-parks', name: 'Washington State Parks', url: 'https://parks.wa.gov/find-parks', fn: stateParks },
    { id: 'padus', name: 'USGS PAD-US public parks & recreation areas', url: 'https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview', fn: padusParks },
    OSM_SRC('parks')] }
};

const trimRow = r => { while (r.length && r[r.length - 1] == null) r.pop(); return r; };

/** Rows a source contributed to the previously published file, as merge input. */
function previousRows(prev, sourceId) {
  if (!prev || !Array.isArray(prev.rows)) return [];
  const F = Object.fromEntries(prev.fields.map((f, i) => [f, i]));
  const srcIdx = prev.sources.findIndex(x => x.id === sourceId);
  if (srcIdx < 0) return [];
  return prev.rows.filter(r => r[F.src] === srcIdx).map(r => ({
    lat: r[F.lat], lon: r[F.lon], name: r[F.name] || null, unnamed: r[F.name] == null, kind: prev.kinds[r[F.kind]],
    addr: r[F.addr] || null, ref: r[F.ref] || null, info: r[F.info] || null, web: r[F.web] || null
  }));
}

export async function buildAmenities(outDir, only) {
  const summary = {};
  let placeRe = null;
  try { placeRe = placeRegex((await waPlaces()).places.map(p => p.base)); }
  catch (err) { log(`amenities: no place names (${err.message}); town names count as distinctive`); }
  for (const [id, cat] of Object.entries(CATEGORIES)) {
    if (only && !only.includes(id)) continue;
    if (cat.places) cat.placeRe = placeRe;
    const prev = await readJSON(`${outDir}/amenities/${id}.json`, null);
    const got = [];
    const info = [];
    for (const s of cat.sources) {
      if (s.fallbackOnly && got.length) continue;
      try {
        const rows = await s.fn();
        got.push({ s, rows });
        info.push({ id: s.id, fetched: rows.length, ...(rows.services ? { services: rows.services } : {}) });
        log(`${id}: ${s.id} -> ${rows.length}`);
      } catch (err) {
        // A transient upstream failure must not thin out the map: carry the
        // source's rows forward from the last published file instead.
        const carried = previousRows(prev, s.id);
        const prevSrc = prev && prev.sources.find(x => x.id === s.id);
        info.push({ id: s.id, error: String(err.message || err).slice(0, 300), carriedForward: carried.length });
        log(`${id}: ${s.id} FAILED ${err.message}${carried.length ? ` - keeping ${carried.length} rows from ${prev.built}` : ''}`);
        if (carried.length) got.push({ s, rows: carried, stale: (prevSrc && prevSrc.asOf) || prev.built });
      }
    }
    if (!got.length) { summary[id] = { error: 'every source failed', sources: info }; continue; }
    const { kept, counts, drops } = merge(got.map(g => ({ rows: g.rows, approx: g.s.approx || 0, inferred: g.s.id === 'osm' })), cat);
    got.forEach((g, i) => { const x = info.find(y => y.id === g.s.id); if (x) x.kept = counts[i]; });
    // Every dropped hospital is logged, so a wrong merge can be spotted in the run log.
    for (const x of drops.filter(x => x.p.cls === 'hospital')) {
      log(`${id}: dropped ${x.p.name} [${got[x.p.src].s.id}, ${x.p.kind}] as ${x.q.name} [${got[x.q.src].s.id}, ${x.q.kind}] ${Math.round(x.d)} m (${x.rule})`);
    }
    const kinds = [...new Set(kept.map(r => r.kind))].sort();
    const kindIdx = new Map(kinds.map((k, i) => [k, i]));
    const rows = kept.map(r => trimRow([r.lat, r.lon, r.name, kindIdx.get(r.kind), r.src, r.addr || null, r.ref || null, r.info || null, r.web || null]));
    const bytes = await writeJSON(`${outDir}/amenities/${id}.json`, {
      built: new Date().toISOString(), category: id,
      sources: got.map((g, i) => ({ id: g.s.id, name: g.s.name, url: g.s.url, count: counts[i], ...(g.stale ? { asOf: g.stale } : {}) })),
      kinds, fields: FIELDS, rows
    });
    summary[id] = { total: rows.length, bytes, sources: info };
    log(`${id}: wrote ${rows.length} places (${(bytes / 1024).toFixed(0)} KB)`);
  }
  const failed = Object.entries(summary).filter(([, v]) => v.error).map(([k]) => k);
  if (failed.length) throw new Error(`categories with no data: ${failed.join(', ')} ${JSON.stringify(summary).slice(0, 300)}`);
  return summary;
}
