/* Washington Explorer — medical site evaluation.
 * A panel for a dropped pin that scores the spot for a medical clinic from
 * public data: zoning (Washington State Zoning Atlas, checked against the
 * city's own map where it answers), the parcel and mapped parking, access to
 * arterials and freeways (WSDOT functional class and traffic counts, OSM
 * interchanges), transit, nearby hospitals, clinics and amenities, the
 * drive-time catchment's population, payer mix and income (Valhalla + ACS),
 * competition, terrain and flood zone (USGS, FEMA) and nearby shelters (OSM).
 * Each criterion scores 0-100 against the anchors in CONFIG.SITE_EVAL, the
 * use type weights them, and a short write-up states the result.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;
  const S = CFG.SITE_EVAL;
  const esc = U.escapeHTML;
  const D2R = Math.PI / 180, R = 6371008.8, M_PER_MI = 1609.344, FT_PER_M = 3.28084;

  // ------------------------------------------------------------ math
  /** Straight lines between anchors [[x, score], ...] (x ascending); log: on log(x). */
  function ramp(x, pts, log) {
    if (x == null || !isFinite(x)) return null;
    const f = v => (log ? Math.log(Math.max(v, 1)) : v);
    const X = f(x);
    if (X <= f(pts[0][0])) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const x0 = f(pts[i - 1][0]), x1 = f(pts[i][0]);
      if (X <= x1) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (X - x0) / (x1 - x0);
    }
    return pts[pts.length - 1][1];
  }
  const clamp = v => Math.max(0, Math.min(100, v));
  const geom = () => WAMAP.areaGeom;
  const dist = (a, b, c, d) => geom().distance(a, b, c, d);
  /** Metres from (lat, lon) to a GeoJSON geometry (lines, polygon edges or a point). */
  function geomDistM(lat, lon, g) {
    if (!g) return Infinity;
    if (g.type === 'Point') return dist(lat, lon, g.coordinates[1], g.coordinates[0]);
    const kx = R * D2R * Math.cos(lat * D2R), ky = R * D2R;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates
      : g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : [];
    let best = Infinity;
    for (const line of lines) {
      let px = null, py = null;
      for (const c of line) {
        const x = (c[0] - lon) * kx, y = (c[1] - lat) * ky;
        if (px == null) best = Math.min(best, Math.hypot(x, y));
        else {
          const dx = x - px, dy = y - py, l2 = dx * dx + dy * dy;
          let t = l2 ? -(px * dx + py * dy) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          best = Math.min(best, Math.hypot(px + t * dx, py + t * dy));
        }
        px = x; py = y;
      }
    }
    return best;
  }
  /** Area (m²) and centre of a small ring of [lon, lat] (local plane). */
  function ringStats(ring) {
    if (!ring || ring.length < 3) return { m2: 0, lat: null, lon: null };
    const lat0 = ring[0][1], kx = R * D2R * Math.cos(lat0 * D2R), ky = R * D2R;
    let a = 0, sx = 0, sy = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
      a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky);
      sx += x1; sy += y1;
    }
    return { m2: Math.abs(a) / 2, lat: sy / ring.length, lon: sx / ring.length };
  }

  // ------------------------------------------------------------ formatting
  const int = v => Math.round(v).toLocaleString('en-US');
  function miles(m) {
    if (m == null || !isFinite(m)) return '—';
    if (m < 305) return Math.round(m * FT_PER_M / 10) * 10 + ' ft';
    const mi = m / M_PER_MI;
    return (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
  }
  const pct = (v, d = 0) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d) + '%');
  const money = v => (v == null || !isFinite(v) ? '—' : '$' + (v >= 10000 ? int(Math.round(v / 1000) * 1000) : int(v)));
  const approx = n => (n >= 10000 ? int(Math.round(n / 1000) * 1000) : n >= 1000 ? int(Math.round(n / 100) * 100) : int(n));
  const plural = (n, one, many) => int(n) + ' ' + (n === 1 ? one : many);
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const lower = s => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  function routeName(num) {
    const n = parseInt(num, 10);
    if (!isFinite(n)) return null;
    if ([5, 82, 90, 182, 205, 405, 705].includes(n)) return 'I-' + n;
    if ([2, 12, 97, 101, 195, 197, 395, 730].includes(n)) return 'US ' + n;
    return 'SR ' + n;
  }

  // ------------------------------------------------------------ fetchers
  // Each returns plain data or throws; the panel fills in as each arrives.
  const lastRun = {};
  function pointParams(lat, lon, extra) {
    return Object.assign({ geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects' }, extra);
  }

  async function fetchZoning(lat, lon, signal) {
    const z = await WAMAP.zoningLookup(lat, lon, { signal });
    z.live = null;
    const j = z.jurisdiction;
    if (z.zone && j && j.GEOID === z.zone.GEOID && z.distanceM === 0) {
      z.live = await liveZoneCheck(j, lat, lon, signal).catch(e => { if (e.name === 'AbortError') throw e; return null; });
      if (z.live) {
        z.live.same = sameZone(z.live.code, z.zone.ZoneID);
        // The city's current zone differs from the atlas: score the current
        // one, as the atlas describes that code, where it lists it.
        if (!z.live.same) {
          z.live.zone = await WAMAP.zoningByCode(j.GEOID, z.live.code, signal).catch(e => { if (e.name === 'AbortError') throw e; return null; });
          if (z.live.zone) z.live.outlook = WAMAP.zoningOutlook(z.live.zone);
        }
      }
    }
    return z;
  }
  function sameZone(a, b) {
    const n = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const x = n(a), y = n(b);
    return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
  }
  /** The zone the jurisdiction's own zoning layer gives at the point (the atlas records its URL). */
  async function liveZoneCheck(j, lat, lon, signal) {
    const url = String(j.ZoningGISURL || '').trim().replace(/\/+$/, '');
    const field = CFG.ZONING.liveFieldOverrides[j.GEOID] || j.ZoneIDField;
    if (!field || !/^https:\/\/[^\s?#]+\/(MapServer|FeatureServer)\/\d+$/i.test(url)) return null;
    const data = await U.fetchJSON(url + '/query?' + U.qs(pointParams(lat, lon, { outFields: field, returnGeometry: false, f: 'json' })),
      { timeout: 8000, retries: 0, signal });
    const f = data && data.features && data.features[0];
    if (!f || !f.attributes) return null;
    const key = Object.keys(f.attributes).find(k => k.toLowerCase() === String(field).toLowerCase());
    const code = key ? f.attributes[key] : null;
    return code == null || code === '' ? null : { code: String(code).trim(), source: j.Jurisdiction };
  }

  let parcelMeta = null;
  function parcelLandUseLabels() {
    if (!parcelMeta) {
      parcelMeta = U.arcgis.layerInfo(S.endpoints.parcels).then(info => {
        const f = (info.fields || []).find(x => x.name === 'LANDUSE_CD');
        const m = {};
        for (const c of (f && f.domain && f.domain.codedValues) || []) m[c.code] = String(c.name).replace(/^\d+\s*-\s*/, '');
        return m;
      }).catch(() => { parcelMeta = null; return {}; });
    }
    return parcelMeta;
  }
  async function fetchParcel(lat, lon, signal) {
    // Parcel identity, size, land use and values only: never owner fields.
    const fields = 'PARCEL_ID_NR,ORIG_PARCEL_ID,SITUS_ADDRESS,SITUS_CITY_NM,SITUS_ZIP_NR,LANDUSE_CD,VALUE_LAND,VALUE_BLDG,DATA_LINK,Shape__Area';
    const [fc, labels] = await Promise.all([
      U.arcgis.query(S.endpoints.parcels, pointParams(lat, lon, { distance: S.radii.parcelM, units: 'esriSRUnit_Meter', outFields: fields, geometryPrecision: 6 }),
        { pageSize: 25, maxFeatures: 25, signal }),
      parcelLandUseLabels()
    ]);
    const cands = fc.features.filter(f => f.geometry).map(f => {
      const inside = U.geo.geometryContains(f.geometry, lon, lat);
      return { f, d: inside ? 0 : geomDistM(lat, lon, f.geometry) };
    }).sort((a, b) => a.d - b.d);
    if (!cands.length) return { none: true };
    const { f, d } = cands[0];
    const p = f.properties;
    const sqft = p.Shape__Area > 0 ? p.Shape__Area : U.geo.areaSqMi(f.geometry) * 27878400;
    const lu = p.LANDUSE_CD;
    return {
      props: p, geometry: f.geometry, distanceM: d, sqft, acres: sqft / 43560,
      landUse: lu != null ? { code: lu, label: labels[lu] || null } : null,
      vacant: lu === 91 || (p.VALUE_BLDG === 0 && p.VALUE_LAND > 0),
      link: /^https?:\/\/[^\s"'<>]+$/i.test(p.DATA_LINK || '') ? p.DATA_LINK : null
    };
  }

  async function fetchOSM(lat, lon, signal) {
    const r = S.radii;
    const ql = `[out:json][timeout:25];
way["amenity"="parking"](around:${r.parkingM},${lat},${lon});out tags geom;
nwr["social_facility"="shelter"](around:${r.sheltersM},${lat},${lon});out tags center;
node["highway"="motorway_junction"](around:${r.junctionsM},${lat},${lon});out tags;`;
    let data;
    try { data = await U.overpass.run(ql, signal); } catch (e) {
      if (e.name === 'AbortError') throw e;
      await new Promise(res => setTimeout(res, 3500)); // the public server sheds load in bursts
      data = await U.overpass.run(ql, signal);
    }
    const parking = [], shelters = [], junctions = [];
    for (const el of data.elements || []) {
      const t = el.tags || {};
      if (t.amenity === 'parking' && el.geometry) {
        const ring = el.geometry.map(g => [g.lon, g.lat]);
        const st = ringStats(ring);
        const levels = parseInt(t['building:levels'] || t['parking:levels'], 10);
        const multi = /multi-storey|underground|rooftop/.test(t.parking || '');
        const cap = parseInt(t.capacity, 10);
        const stalls = isFinite(cap) && cap > 0 ? cap : Math.round(st.m2 / 30 * (multi && levels > 1 ? levels : 1));
        parking.push({ id: el.id, ring, lat: st.lat, lon: st.lon, m2: st.m2, stalls, estimated: !(isFinite(cap) && cap > 0),
          type: t.parking || 'surface', access: t.access || '', name: t.name || '', street: /street_side|lane/.test(t.parking || ''),
          d: dist(lat, lon, st.lat, st.lon) });
      } else if (t.social_facility === 'shelter') {
        // Shelters for people experiencing homelessness only: anything tagged
        // for abuse victims or children is left out, and so is a women-only
        // shelter not tagged for homelessness (often a domestic-violence
        // shelter). Only distances are shown.
        const forWhom = t['social_facility:for'] || '';
        if (/abuse|victim|domestic|child|juvenile/i.test(forWhom) || (/women/i.test(forWhom) && !/homeless/i.test(forWhom))) continue;
        const la = el.lat != null ? el.lat : el.center && el.center.lat, lo = el.lon != null ? el.lon : el.center && el.center.lon;
        if (la == null) continue;
        shelters.push({ d: dist(lat, lon, la, lo) });
      } else if (t.highway === 'motorway_junction' && el.lat != null) {
        junctions.push({ d: dist(lat, lon, el.lat, el.lon), ref: t.ref || '', name: t.name || t.exit_to || '' });
      }
    }
    shelters.sort((a, b) => a.d - b.d);
    junctions.sort((a, b) => a.d - b.d);
    parking.sort((a, b) => a.d - b.d);
    return { parking, shelters, junctions };
  }

  async function fetchRoads(lat, lon, signal) {
    const base = pointParams(lat, lon, { distance: S.radii.roadsM, units: 'esriSRUnit_Meter', geometryPrecision: 6, maxAllowableOffset: 0.00002 });
    const [st, local] = await Promise.all([
      U.arcgis.query(S.endpoints.functionalClass + '/0', Object.assign({ outFields: 'FederalFunctionalClassCode,FederalFunctionalClassDesc,StateRouteNumber' }, base), { pageSize: 1000, maxFeatures: 3000, signal }),
      U.arcgis.query(S.endpoints.functionalClass + '/1', Object.assign({ outFields: 'FederalFunctionalClassCode,FederalFunctionalClassDesc,RoadName' }, base), { pageSize: 1000, maxFeatures: 3000, signal })
    ]);
    const roads = [];
    for (const f of st.features.concat(local.features)) {
      const p = f.properties || {};
      const cls = +p.FederalFunctionalClassCode;
      if (!(cls >= 1 && cls <= 6) || !f.geometry) continue;
      const sr = p.StateRouteNumber ? routeName(p.StateRouteNumber) : null;
      roads.push({ cls, desc: p.FederalFunctionalClassDesc || '', name: p.RoadName || sr || '', sr, d: geomDistM(lat, lon, f.geometry), geometry: f.geometry });
    }
    roads.sort((a, b) => a.d - b.d);
    return { roads };
  }

  async function fetchTraffic(lat, lon, signal) {
    const fc = await U.arcgis.query(S.endpoints.trafficSections, pointParams(lat, lon, {
      distance: S.radii.trafficM, units: 'esriSRUnit_Meter', outFields: 'StateRouteNumber,AADT,Location,ReportingYear', geometryPrecision: 6
    }), { pageSize: 50, maxFeatures: 50, signal });
    const sections = fc.features.filter(f => f.properties && f.properties.AADT > 0).map(f => ({
      aadt: f.properties.AADT, route: routeName(f.properties.StateRouteNumber), year: f.properties.ReportingYear,
      d: geomDistM(lat, lon, f.geometry)
    })).sort((a, b) => a.d - b.d);
    return { sections };
  }

  async function fetchElevation(lat, lon, signal) {
    const g = geom();
    const pts = [[lat, lon]].concat([0, 90, 180, 270].map(b => g.destination(lat, lon, b, S.radii.slopeM)));
    let ft = null, source = 'USGS 3DEP (Elevation Point Query Service)';
    try {
      ft = await Promise.all(pts.map(([la, lo]) => U.fetchJSON(`${S.endpoints.epqs}?x=${lo.toFixed(6)}&y=${la.toFixed(6)}&wkid=4326&units=Feet&includeDate=false`,
        { timeout: 12000, retries: 1, signal }).then(r => {
        const v = r && (r.value != null ? +r.value : r.USGS_Elevation_Point_Query_Service && +r.USGS_Elevation_Point_Query_Service.Elevation_Query.Elevation);
        if (!isFinite(v) || v < -1000) throw new Error('no elevation');
        return v;
      })));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      const r = await U.fetchJSON(`${S.endpoints.openMeteo}?latitude=${pts.map(p => p[0].toFixed(5)).join(',')}&longitude=${pts.map(p => p[1].toFixed(5)).join(',')}`,
        { timeout: 15000, retries: 1, signal });
      if (!r || !Array.isArray(r.elevation) || r.elevation.length !== pts.length) throw new Error('no elevation');
      ft = r.elevation.map(m => m * FT_PER_M);
      source = 'Copernicus 90 m DEM via Open-Meteo (USGS unavailable; slope approximate)';
    }
    const run = S.radii.slopeM * FT_PER_M;
    const slope = Math.max(...ft.slice(1).map(v => Math.abs(v - ft[0]))) / run * 100;
    return { elevationFt: ft[0], slopePct: slope, reliefFt: Math.max(...ft) - Math.min(...ft), source };
  }

  async function fetchFlood(lat, lon, signal) {
    const fc = await U.arcgis.query(S.endpoints.flood, pointParams(lat, lon, { outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE', returnGeometry: false }),
      { pageSize: 5, maxFeatures: 5, signal });
    const p = fc.features[0] && fc.features[0].properties;
    if (!p) return { unmapped: true };
    return { zone: p.FLD_ZONE, subtype: p.ZONE_SUBTY || '', sfha: p.SFHA_TF === 'T', bfe: p.STATIC_BFE > -9000 ? p.STATIC_BFE : null };
  }

  async function fetchTransit(transit, lat, lon, signal) {
    if (!transit || !transit.queryArea) throw new Error('transit unavailable');
    const g = geom();
    const pad = S.radii.stopFarM + 100;
    const ne = g.destination(lat, lon, 45, pad * Math.SQRT2), sw = g.destination(lat, lon, 225, pad * Math.SQRT2);
    const res = await transit.queryArea(L.latLngBounds([sw[0], sw[1]], [ne[0], ne[1]]), { signal });
    const near = g.tester({ type: 'circle', lat, lon, radius: S.radii.stopNearM });
    const far = g.tester({ type: 'circle', lat, lon, radius: S.radii.stopFarM });
    const stops = res.stops.map(s => ({ name: s.name, agency: s.agency, d: dist(lat, lon, s.lat, s.lon) })).filter(s => s.d <= S.radii.stopFarM).sort((a, b) => a.d - b.d);
    const routesNear = new Map(), railFar = new Map();
    for (const r of res.routes) {
      if (r.lines.some(l => near.line(l))) routesNear.set(r.key, r);
      if (/rail|metro|streetcar|tram|monorail|ferry/i.test(r.modeLabel) && r.lines.some(l => far.line(l))) railFar.set(r.key, r);
    }
    return {
      source: res.source, truncated: res.truncated, stops,
      near: stops.filter(s => s.d <= S.radii.stopNearM),
      routes: Array.from(routesNear.values()).map(r => ({ name: r.name, mode: r.modeLabel, agency: r.agency })),
      rail: Array.from(railFar.values()).map(r => ({ name: r.name, mode: r.modeLabel }))
    };
  }

  async function fetchAmenities(amenities, lat, lon) {
    const list = await amenities.loadData();
    const out = { byCat: {}, health: [], failed: list.filter(x => x.error).map(x => x.cfg.label) };
    const box = deg => ({ s: lat - deg, n: lat + deg, w: lon - deg / Math.cos(lat * D2R), e: lon + deg / Math.cos(lat * D2R) });
    const near = box(0.03), wide = box(0.6); // ~3 km for counts; ~65 km for health (catchments, hospitals)
    for (const c of list) {
      if (!c.d) continue;
      const F = c.F, rows = c.d.rows, kinds = c.d.kinds;
      const cat = { n05: 0, n1: 0, nearest: null };
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i], la = +r[F.lat], lo = +r[F.lon];
        const isHealth = c.id === 'health' || c.id === 'pharmacy';
        const b = isHealth ? wide : near;
        if (la < b.s || la > b.n || lo < b.w || lo > b.e) continue;
        const d = dist(lat, lon, la, lo);
        if (isHealth) out.health.push({ cat: c.id, kind: kinds[r[F.kind]] || '', name: r[F.name] || '', lat: la, lon: lo, d });
        if (d <= S.radii.amenityFarM) {
          cat.n1++;
          if (d <= S.radii.amenityNearM) cat.n05++;
        }
        if (!cat.nearest || d < cat.nearest.d) cat.nearest = { d, name: r[F.name] || kinds[r[F.kind]] || c.cfg.label, kind: kinds[r[F.kind]] || '' };
      }
      out.byCat[c.id] = cat;
    }
    return out;
  }

  async function requestIsochrones(lat, lon, minutes, signal) {
    const body = JSON.stringify({ locations: [{ lat, lon }], costing: CFG.ISOCHRONE.costing, contours: minutes.map(m => ({ time: m })),
      polygons: true, denoise: CFG.ISOCHRONE.denoise, generalize: CFG.ISOCHRONE.generalize });
    let lastErr;
    for (const ep of CFG.ISOCHRONE.endpoints) {
      for (const withId of [true, false]) {
        const headers = { 'Content-Type': 'application/json' };
        if (withId) headers['X-Client-Id'] = CFG.ISOCHRONE.clientId;
        try {
          const res = await fetch(ep, { method: 'POST', headers, body, signal });
          if (!res.ok) throw new Error('HTTP ' + res.status + ' from the routing service');
          return await res.json();
        } catch (e) { if (e.name === 'AbortError') throw e; lastErr = e; }
      }
    }
    throw lastErr || new Error('routing service unreachable');
  }
  function emptyAgg() { return { pop: 0, households: 0, incSum: 0, incPop: 0, ins: 0, employer: 0, direct: 0, medicare: 0, dual: 0, medicaid: 0, military: 0, other: 0, uninsured: 0, tracts: 0 }; }
  function addTract(a, row) {
    a.pop += row.pop || 0; a.households += row.households || 0; a.tracts++;
    if (row.medInc != null && row.pop) { a.incSum += row.medInc * row.pop; a.incPop += row.pop; }
    const w = row.insUniverse || 0;
    if (w && row.pmEmployer != null) {
      a.ins += w;
      for (const [k, f] of [['employer', 'pmEmployer'], ['direct', 'pmDirect'], ['medicare', 'pmMedicare'], ['dual', 'pmDual'], ['medicaid', 'pmMedicaid'], ['military', 'pmMilitary'], ['other', 'pmOther'], ['uninsured', 'pctUninsured']]) {
        a[k] += (row[f] || 0) * w;
      }
    }
  }
  function finishAgg(a) {
    const s = k => (a.ins ? a[k] / a.ins : null);
    return { pop: a.pop, households: a.households, tracts: a.tracts, medInc: a.incPop ? a.incSum / a.incPop : null,
      employer: s('employer'), direct: s('direct'), medicare: s('medicare'), dual: s('dual'), medicaid: s('medicaid'),
      military: s('military'), other: s('other'), uninsured: s('uninsured') };
  }
  async function fetchCatchment(lat, lon, signal) {
    const minutes = Array.from(new Set(S.profiles.map(p => p.minutes))).sort((a, b) => a - b);
    const [acs, idx] = await Promise.all([U.censusStore.load('tract'), WAMAP.geoStore.loadTractIndex()]);
    let bands, source;
    try {
      const data = await requestIsochrones(lat, lon, minutes, signal);
      const byMin = new Map();
      for (const f of data.features || []) {
        if (!f.geometry || !/Polygon/.test(f.geometry.type)) continue;
        const m = Math.round(f.properties && (f.properties.contour != null ? f.properties.contour : f.properties.metric));
        if (!byMin.has(m)) byMin.set(m, []);
        byMin.get(m).push(f.geometry);
      }
      if (!byMin.size) throw new Error('no drive-time area returned');
      bands = minutes.filter(m => byMin.has(m)).map(m => ({ key: m, geoms: byMin.get(m), test: (la, lo) => byMin.get(m).some(g => U.geo.geometryContains(g, lo, la)) }));
      source = 'valhalla';
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // Straight-line circles instead, one per use type.
      const radii = Array.from(new Set(Object.values(S.fallbackMiles))).sort((a, b) => a - b);
      bands = radii.map(mi => ({ key: mi, geoms: null, test: (la, lo) => dist(lat, lon, la, lo) <= mi * M_PER_MI }));
      source = 'radius';
      bands.error = e.message;
    }
    const aggs = new Map(bands.map(b => [b.key, emptyAgg()]));
    for (const pt of idx) {
      if (Math.abs(pt.lat - lat) > 0.6 || Math.abs(pt.lon - lon) > 0.9) continue;
      const row = acs.rows[pt.geoid];
      if (!row) continue;
      for (const b of bands) if (b.test(pt.lat, pt.lon)) { addTract(aggs.get(b.key), row); } // nested areas: each counts its own tracts
    }
    const out = { source, span: acs.span, vintage: acs.vintage, error: bands.error || null, byKey: {}, geoms: {}, tests: {} };
    for (const b of bands) { out.byKey[b.key] = finishAgg(aggs.get(b.key)); out.geoms[b.key] = b.geoms; out.tests[b.key] = b.test; }
    return out;
  }

  // ------------------------------------------------------------ scoring
  const HOSPITAL = /^(?!community health center).*(hospital)/i;
  const PRIMARY = /^(clinic|doctor|community health|rural health)/i;
  const URGENT = /urgent/i;
  const SAFETY_NET = /community health|fqhc|rural health|public health/i;
  function catchmentFor(d, profile) {
    const c = d.catchment;
    if (!c) return null;
    const key = c.source === 'valhalla' ? profile.minutes : S.fallbackMiles[profile.id];
    const agg = c.byKey[key];
    if (!agg) return null;
    return { agg, key, test: c.tests[key], geoms: c.geoms[key],
      label: c.source === 'valhalla' ? `${profile.minutes}-minute drive` : `${key}-mile radius`,
      basis: c.source === 'valhalla' ? `within a ${profile.minutes}-minute drive (Valhalla routing, typical traffic)` : `within ${key} miles in a straight line (drive times were unavailable: ${c.error || 'routing error'})` };
  }

  const EVAL = {
    zoning(d) {
      const z = d.zoning;
      if (!z.zone) {
        const j = z.jurisdiction;
        return { score: null, na: `The state zoning atlas has no zoning for this spot${j ? ' (' + j.Jurisdiction + ')' : ''}; check the jurisdiction's map.` };
      }
      let o = z.outlook, p = z.zone;
      const details = [];
      const compiled = String(p.WAZASpatialNormalizationDate || '').slice(0, 7) || 'earlier';
      if (z.live && z.live.same) details.push(`✓ ${z.live.source}'s own zoning map, queried live, shows the same zone (${z.live.code}).`);
      else if (z.live && z.live.zone) {
        details.push(`⚠ ${z.live.source}'s own zoning map, queried live, shows ${z.live.code}, not the atlas's ${p.ZoneID} (compiled ${compiled}); the score uses the city's current zone. Confirm with the city.`);
        p = z.live.zone; o = z.live.outlook;
      } else if (z.live) {
        details.push(`⚠ ${z.live.source}'s own zoning map, queried live, shows ${z.live.code}, not the atlas's ${p.ZoneID} (compiled ${compiled}); the atlas may predate a rezone, so confirm with the city.`);
      }
      const name = p.ZoneName && p.ZoneName !== p.ZoneID ? `${p.ZoneName} (${p.ZoneID})` : (p.ZoneID || p.ZoneName);
      if (z.distanceM > 0) details.push(`The pin sits in a street right-of-way; this is the nearest zone, ${Math.round(z.distanceM)} m away.`);
      if (z.backup) details.push(`${z.jurisdiction.Jurisdiction} has no zoning in the atlas here; the county's zoning is used as the backup.`);
      // The panel's bullets carry the right-of-way and backup notes.
      const html = WAMAP.zoningDetailHTML(Object.assign({}, z, { distanceM: 0, backup: false }));
      if (o.score == null) return { score: null, na: o.text, html, details };
      return { score: o.score, html, details,
        fact: `it is zoned ${name} in ${p.Jurisdiction}, where ${lower(o.text).replace(/\.$/, '')}` };
    },
    demand(d, profile) {
      const c = catchmentFor(d, profile);
      if (!c) return { score: null, na: 'Population could not be estimated.' };
      const s = ramp(c.agg.pop, S.demand[profile.id], true);
      return { score: s, fact: `${s < 50 ? 'only ' : ''}about ${approx(c.agg.pop)} people live ${c.basis.split(' (')[0]}`,
        details: [`Population ${c.basis}: ${int(c.agg.pop)} in ${plural(c.agg.households, 'household', 'households')} (${plural(c.agg.tracts, 'census tract', 'census tracts')}).`,
          `Anchors for a ${lower(profile.label)}: ${S.demand[profile.id].map(a => approx(a[0]) + ' → ' + a[1]).join(', ')}.`],
        sources: [`ACS 5-Year ${esc(d.catchment.span)} (U.S. Census Bureau), tracts allocated by internal point`] };
    },
    payer(d, profile) {
      const c = catchmentFor(d, profile);
      if (!c || c.agg.employer == null) return { score: null, na: 'Payer mix could not be estimated.' };
      const a = c.agg, P = S.payer;
      const commercial = a.employer + a.direct, need = a.medicaid + a.uninsured, medicare = a.medicare + a.dual;
      let s, fact;
      if (profile.id === 'chc') {
        s = ramp(need, P.need);
        fact = `${pct(need)} of residents in the catchment rely on Medicaid or are uninsured`;
      } else {
        const cs = ramp(commercial, P.commercial), is = a.medInc != null ? ramp(a.medInc, P.income) : cs;
        s = profile.id === 'multi' ? 0.5 * cs + 0.3 * is + 0.2 * ramp(medicare, P.medicare) : 0.6 * cs + 0.4 * is;
        fact = `${pct(commercial)} of nearby residents have employer or direct-purchase coverage and the typical household income is about ${money(a.medInc)}`;
      }
      return { score: s, fact,
        details: [`Payer mix ${c.basis} (each person counted once): employer ${pct(a.employer, 1)}, direct-purchase ${pct(a.direct, 1)}, Medicare ${pct(a.medicare, 1)}, Medicaid ${pct(a.medicaid, 1)} (dual eligible ${pct(a.dual, 1)}), military ${pct(a.military, 1)}, other ${pct(a.other, 1)}, uninsured ${pct(a.uninsured, 1)}.`,
          `Median household income: ${money(a.medInc)} (population-weighted average of tract medians).`,
          profile.id === 'chc' ? 'For a community health center, a larger Medicaid and uninsured share means more of the people it serves.' :
            profile.id === 'multi' ? 'Weighs commercial coverage (50%), income (30%) and Medicare share (20%, specialty use rises with age).' : 'Weighs commercial coverage (60%) and income (40%).'],
        sources: [`ACS 5-Year ${esc(d.catchment.span)} tables B27010, C27007, B19013`] };
    },
    access(d) {
      const roads = d.roads.roads, A = S.access;
      let best = { s: A.none, road: null };
      for (const r of roads) {
        const s = ramp(r.d, A.byClass[r.cls]);
        if (s != null && r.d <= (A.byClass[r.cls][A.byClass[r.cls].length - 1][0]) && s > best.s) best = { s, road: r };
      }
      const sec = d.traffic && d.traffic.sections[0];
      const bonus = sec ? (ramp(sec.aadt, [[0, 0]].concat(A.aadtBonus)) || 0) : 0;
      const j = d.osm && d.osm.junctions[0];
      const fw = d.osm ? (j ? ramp(j.d, A.freeway) : A.freewayNone) : null;
      const s = clamp((fw == null ? best.s : 0.75 * best.s + 0.25 * fw) + bonus);
      const r = best.road;
      const kind = { 1: 'an interstate', 2: 'a freeway or expressway', 3: 'a principal arterial', 4: 'a minor arterial', 5: 'a major collector', 6: 'a minor collector' };
      const roadText = r ? `it is ${miles(r.d)} from ${r.name ? r.name + ', ' : ''}${kind[r.cls]}` : 'no arterial is within half a mile';
      // The count belongs to the state route it was taken on, which may not be the road scored.
      const aadt = !sec ? '' : r && r.sr && r.sr === sec.route ? ` carrying about ${approx(sec.aadt)} vehicles a day`
        : `, near ${sec.route || 'a state route'} (about ${approx(sec.aadt)} vehicles a day)`;
      const details = roads.slice(0, 6).map(x => `${x.name || 'Unnamed road'}: ${x.desc}, ${miles(x.d)} away.`);
      if (sec) details.push(`${sec.route || 'State route'} traffic: ${int(sec.aadt)} vehicles a day (${sec.year} annual average, WSDOT), ${miles(sec.d)} from the pin.`);
      if (d.osm) details.push(j ? `Nearest freeway interchange: ${[j.ref && 'exit ' + j.ref, j.name].filter(Boolean).join(', ') || 'unnamed'}, ${miles(j.d)} away.` : 'No freeway interchange within 5 miles.');
      else details.push('Freeway interchanges were not checked (OpenStreetMap was unavailable).');
      return { score: s, fact: `${roadText}${aadt}${j && j.d <= 4000 ? `, ${miles(j.d)} from a freeway interchange` : ''}`, details,
        sources: ['WSDOT federal functional classification and traffic counts; OpenStreetMap interchanges'] };
    },
    transit(d) {
      const t = d.transit, T = S.transit;
      const s = clamp((t.near.length ? T.nearStop : t.stops.length ? T.farStop : 0) + Math.min(T.routesMax, t.routes.length * T.perRoute) + (t.rail.length ? T.rail : 0));
      const fact = t.near.length ? `${plural(t.near.length, 'transit stop', 'transit stops')} within a quarter mile${t.routes.length ? ', served by ' + plural(t.routes.length, 'route', 'routes') : ''}`
        : t.stops.length ? `the nearest transit stop is ${miles(t.stops[0].d)} away` : 'no transit stop within half a mile';
      const details = [];
      if (t.stops.length) details.push('Nearest stops: ' + t.stops.slice(0, 4).map(x => `${x.name} (${miles(x.d)})`).join('; ') + '.');
      if (t.routes.length) details.push('Routes within a quarter mile: ' + t.routes.slice(0, 10).map(r => r.name).join('; ') + (t.routes.length > 10 ? '; …' : '') + '.');
      if (t.rail.length) details.push('Rail or ferry within half a mile: ' + t.rail.map(r => r.name).join('; ') + '.');
      if (t.truncated) details.push('The transit query hit its size limit; counts may be low.');
      return { score: s, fact: fact + (t.rail.length ? ' and rail within half a mile' : ''), details,
        sources: [t.source === 'osm' ? 'OpenStreetMap stops and routes (WSDOT unreachable)' : 'WSDOT statewide GTFS'] };
    },
    site(d, profile, sqft) {
      const P = S.site, par = d.parcel, osm = d.osm;
      const codeMin = d.zoning && d.zoning.zone && d.zoning.zone.MinParkingOffice > 0 && d.zoning.zone.MinParkingOffice < 999 ? d.zoning.zone.MinParkingOffice : null;
      const ratio = Math.max(profile.parkingPer1000, codeMin || 0);
      const stalls = Math.ceil(sqft / 1000 * ratio);
      const footprint = sqft / (sqft > P.oneStoryMaxSqft ? 2 : 1);
      const need = (footprint + stalls * P.stallSqft) * P.overhead;
      const details = [`A ${int(sqft)} sf ${lower(profile.label)} needs about ${int(stalls)} parking stalls at ${ratio} per 1,000 sf${codeMin && codeMin >= profile.parkingPer1000 ? ' (the zone\'s office minimum)' : ''}, and about ${(need / 43560).toFixed(2)} acres for a ${sqft > P.oneStoryMaxSqft ? 'two' : 'one'}-story building with surface parking.`];
      if (codeMin && codeMin < profile.parkingPer1000) details.push(`The zone's office parking minimum is ${codeMin} per 1,000 sf; medical users typically want ${profile.parkingPer1000}.`);
      let fit = null, fact = null;
      if (par && !par.none) {
        fit = ramp(par.sqft / need, P.fit);
        const pid = par.props.ORIG_PARCEL_ID || par.props.PARCEL_ID_NR;
        details.push(`Parcel ${pid}${par.props.SITUS_ADDRESS ? ', ' + par.props.SITUS_ADDRESS + (par.props.SITUS_CITY_NM ? ', ' + par.props.SITUS_CITY_NM : '') : ''}: ${par.acres.toFixed(2)} acres (${int(par.sqft)} sf)${par.landUse ? ', land use ' + (par.landUse.label || 'code ' + par.landUse.code) : ''}${par.vacant ? ', no building value on record' : ''}.`);
        if (par.props.VALUE_LAND != null) details.push(`Assessed land ${money(par.props.VALUE_LAND)}${par.props.VALUE_BLDG != null ? ', building ' + money(par.props.VALUE_BLDG) : ''}.`);
        if (par.distanceM > 0) details.push(`The pin is ${Math.round(par.distanceM)} m outside any parcel (likely a street); this is the nearest one.`);
        fact = par.sqft >= need
          ? `the ${par.acres.toFixed(1)}-acre parcel has room for a ${int(sqft)} sf clinic and its ${int(stalls)} parking stalls`
          : `the ${par.acres.toFixed(2)}-acre parcel is smaller than the roughly ${(need / 43560).toFixed(1)} acres a ${int(sqft)} sf clinic with ${int(stalls)} stalls typically needs`;
      } else if (par && par.none) details.push('No tax parcel found at the pin.');
      let park = null;
      if (osm) {
        const lots = osm.parking.filter(p => !p.street && !/private/.test(p.access));
        const onParcel = par && !par.none ? lots.filter(p => U.geo.geometryContains(par.geometry, p.lon, p.lat)) : [];
        const pool = onParcel.length ? onParcel : lots.filter(p => p.d <= 120);
        const n = pool.reduce((t, p) => t + p.stalls, 0);
        park = ramp(n / stalls, P.parking);
        details.push(pool.length ? `Mapped parking ${onParcel.length ? 'on the parcel' : 'within 400 ft'}: about ${int(n)} stalls in ${plural(pool.length, 'lot', 'lots')}${pool.some(p => p.estimated) ? ' (stall counts estimated from lot area where not tagged)' : ''}.`
          : 'No public or customer parking lots are mapped within 400 ft (OpenStreetMap coverage varies).');
        if (!fact) fact = pool.length ? `about ${int(n)} mapped parking stalls are within 400 ft, against the ~${int(stalls)} a ${int(sqft)} sf clinic needs` : `no parking lots are mapped within 400 ft, against the ~${int(stalls)} stalls a ${int(sqft)} sf clinic needs`;
      }
      let s;
      if (fit != null && park != null) s = par.vacant ? fit : 0.6 * fit + 0.4 * park;
      else s = fit != null ? fit : park;
      if (s == null) {
        const why = [par && par.none ? 'no tax parcel was found at the pin' : 'the parcel could not be loaded',
          osm ? null : 'mapped parking could not be loaded (OpenStreetMap did not answer)'].filter(Boolean);
        return { score: null, na: cap(why.join(' and ')) + '.', details };
      }
      return { score: s, fact, details,
        sources: ['Washington State parcels (WA Geospatial Portal)', 'OpenStreetMap parking', 'zoning atlas parking minimums'],
        links: par && par.link ? [[par.link, 'County assessor record']] : [] };
    },
    health(d) {
      const h = d.amenities.health, H = S.health;
      const hosp = h.filter(x => x.cat === 'health' && HOSPITAL.test(x.kind) && !/psychiatric/i.test(x.kind)).sort((a, b) => a.d - b.d)[0];
      const clinics = h.filter(x => x.cat === 'health' && !HOSPITAL.test(x.kind) && x.d <= M_PER_MI);
      const pharm = h.filter(x => x.cat === 'pharmacy' && x.d <= M_PER_MI);
      const s = 0.45 * (hosp ? ramp(hosp.d, H.hospitalM) : 5) + 0.35 * ramp(clinics.length, H.clinics) + 0.2 * ramp(pharm.length, H.pharmacies);
      const urgent = h.filter(x => URGENT.test(x.kind)).sort((a, b) => a.d - b.d)[0];
      return { score: s,
        fact: `${hosp ? `${hosp.name || 'a hospital'} is ${miles(hosp.d)} away` : 'no hospital is within 40 miles'} and ${clinics.length ? plural(clinics.length, 'clinic or practice is', 'clinics and practices are') : 'no clinics or practices are'} within a mile`,
        details: [hosp ? `Nearest hospital: ${hosp.name} (${hosp.kind}), ${miles(hosp.d)}.` : 'No hospital found within about 40 miles.',
          `Clinics, doctors' offices, surgery centers and health centers within 1 mile: ${clinics.length}.`,
          `Pharmacies within 1 mile: ${pharm.length}.`,
          urgent ? `Nearest urgent care: ${urgent.name || 'urgent care'}, ${miles(urgent.d)}.` : null].filter(Boolean),
        sources: ['WA DOH, CMS and HRSA facility registries plus OpenStreetMap (the amenities layer\'s files)'] };
    },
    amenities(d) {
      const b = d.amenities.byCat, A = S.amenities;
      const g = b.grocery && b.grocery.nearest;
      const gs = !g ? 30 : g.d <= S.radii.amenityNearM ? 100 : g.d <= S.radii.amenityFarM ? 70 : 30;
      const shops = ((b.restaurants && b.restaurants.n05) || 0) + ((b.retail && b.retail.n05) || 0);
      const banks = b.banks && b.banks.n1 > 0;
      const s = 0.35 * gs + 0.45 * ramp(shops, A.retail) + 0.2 * (banks ? 100 : 40);
      return { score: s,
        fact: `${g ? `a grocery store is ${miles(g.d)} away` : 'no grocery store is mapped nearby'} and ${plural(shops, 'restaurant or shop is', 'restaurants and shops are')} within half a mile`,
        details: ['Within ½ mile / 1 mile: ' + ['grocery', 'restaurants', 'retail', 'banks', 'pharmacy', 'fuel'].filter(k => b[k]).map(k => {
          const c = CFG.AMENITIES.find(x => x.id === k);
          return `${c.label.toLowerCase()} ${b[k].n05} / ${b[k].n1}`;
        }).join('; ') + '.', g ? `Nearest grocery: ${g.name}, ${miles(g.d)}.` : null].filter(Boolean),
        sources: ['USDA SNAP retailers, FDIC and NCUA branches, OpenStreetMap (the amenities layer\'s files)'] };
    },
    competition(d, profile) {
      const c = catchmentFor(d, profile);
      if (!c) return { score: null, na: 'The catchment could not be computed.' };
      const inCatch = d.amenities.health.filter(x => x.cat === 'health' && c.test(x.lat, x.lon));
      let n, per, what, base = c.agg.pop;
      if (profile.id === 'urgent') { n = inCatch.filter(x => URGENT.test(x.kind)).length; what = 'urgent care centers'; }
      else if (profile.id === 'chc') { n = inCatch.filter(x => SAFETY_NET.test(x.kind)).length; what = 'community, rural and public health clinics'; base = c.agg.pop * ((c.agg.medicaid || 0) + (c.agg.uninsured || 0)) / 100; }
      else if (profile.id === 'multi') { n = inCatch.filter(x => !URGENT.test(x.kind)).length; what = 'hospitals, surgery centers, clinics and practices'; }
      else { n = inCatch.filter(x => PRIMARY.test(x.kind)).length; what = 'clinics, practices and health centers'; }
      per = base > 0 ? n / (base / 10000) : null;
      const s = per == null ? null : ramp(per, S.competition[profile.id]);
      if (s == null) return { score: null, na: 'No residents in the catchment to compare with.' };
      return { score: s,
        fact: `${plural(n, 'competing site is', 'competing sites are')} mapped ${c.label === `${profile.minutes}-minute drive` ? 'within the ' + c.label : 'in the ' + c.label} (${per.toFixed(1)} per 10,000 ${profile.id === 'chc' ? 'Medicaid or uninsured residents' : 'residents'})`,
        details: [`Mapped ${what} ${c.basis}: ${n}.`, `Density: ${per.toFixed(2)} per 10,000 ${profile.id === 'chc' ? 'Medicaid or uninsured residents' : 'residents'}.`,
          'Registries list hospitals, health centers and surgery centers completely; private practices come from OpenStreetMap and are undercounted, so treat this as indicative.'],
        sources: ['The amenities layer\'s health facilities, within the drive-time area'] };
    },
    terrain(d) {
      const e = d.elevation, f = d.flood, T = S.terrain;
      if (!e && !f) return { score: null, na: 'Elevation and flood data were unavailable.' };
      let s = e ? ramp(e.slopePct, T.slope) : 80;
      const details = [];
      if (e) details.push(`Elevation ${int(e.elevationFt)} ft; ground slope about ${e.slopePct.toFixed(1)}% across 50 m around the pin (relief ${e.reliefFt.toFixed(0)} ft). Source: ${e.source}.`);
      let floodText = null;
      if (f && !f.unmapped) {
        const moderate = /0\.2 PCT/i.test(f.subtype);
        if (f.sfha) { s = Math.min(s, T.sfhaCap); floodText = `it lies in FEMA flood zone ${f.zone}, the 1% annual chance floodplain`; }
        else if (moderate) { s = Math.max(0, s - T.moderatePenalty); floodText = 'it lies in the 0.2% annual chance (500-year) floodplain'; }
        else floodText = f.zone === 'D' ? 'FEMA has not determined its flood risk (zone D)' : 'it is outside FEMA\'s mapped floodplains';
        details.push(`FEMA flood zone ${f.zone}${f.subtype ? ' (' + lower(f.subtype) + ')' : ''}${f.bfe != null ? ', base flood elevation ' + f.bfe + ' ft' : ''}.`);
      } else if (f && f.unmapped) details.push('No FEMA flood map covers this spot.');
      else details.push('FEMA flood zones could not be checked.');
      const coarse = e && /Open-Meteo/.test(e.source) ? ' (coarse estimate)' : '';
      return { score: s,
        fact: [e ? `the ground slopes about ${Math.round(e.slopePct)}% around the pin${coarse}` : null, floodText].filter(Boolean).join(' and '),
        details, sources: ['USGS 3DEP elevation', 'FEMA National Flood Hazard Layer'] };
    },
    shelters(d, profile) {
      const sh = d.osm.shelters, T = S.shelters;
      const nearest = sh[0];
      const n05 = sh.filter(x => x.d <= M_PER_MI / 2).length, n1 = sh.filter(x => x.d <= M_PER_MI).length;
      const s = profile.id === 'chc' ? (nearest ? ramp(nearest.d, T.chcM.map(a => [a[0], a[1]])) : T.chcNone)
        : (nearest ? ramp(nearest.d, T.privateM) : 100);
      return { score: s,
        fact: !nearest ? 'no shelters are mapped within 2 miles' : n05 ? `${plural(n05, 'shelter is', 'shelters are')} within half a mile (nearest ${miles(nearest.d)})` : `the nearest shelter is ${miles(nearest.d)} away`,
        details: [`Shelters for people experiencing homelessness within ½ / 1 / 2 miles: ${n05} / ${n1} / ${sh.length}.`,
          profile.id === 'chc' ? 'For a community health center, nearby shelters mean patients it is there to serve, so closer scores higher.'
            : 'For most private clinics, a shelter next door weighs on security and perception, so closer scores lower (the weight is small).',
          'From OpenStreetMap; only distances are shown, and shelters that may serve abuse victims or minors are never used.'],
        sources: ['OpenStreetMap social facilities'] };
    }
  };
  const NEEDS = { zoning: ['zoning'], demand: ['catchment'], payer: ['catchment'], access: ['roads'], transit: ['transit'],
    site: ['parcel', 'osm'], health: ['amenities'], amenities: ['amenities'], competition: ['catchment', 'amenities'], terrain: ['elevation', 'flood'], shelters: ['osm'] };
  const ANY_OF = { site: true, terrain: true }; // scored when any one of their sources answered

  /** Scores every criterion from what has loaded so far. */
  function evaluate(run, profile, sqft) {
    const d = run.data, st = run.status;
    const criteria = S.criteria.map(c => {
      const w = profile.weights[c.id];
      const needs = NEEDS[c.id];
      const ok = needs.filter(k => st[k] === 'ok'), pend = needs.filter(k => st[k] === 'loading'), bad = needs.filter(k => st[k] === 'error');
      const ready = ANY_OF[c.id] ? ok.length > 0 && !pend.length : ok.length === needs.length;
      if (!ready) {
        if (pend.length) return Object.assign({}, c, { w, status: 'loading' });
        return Object.assign({}, c, { w, status: 'error', na: bad.map(k => run.errors[k]).filter(Boolean).join('; ') || 'data unavailable' });
      }
      let r;
      try { r = EVAL[c.id](d, profile, sqft); } catch (e) { r = { score: null, na: 'Could not be scored (' + e.message + ').' }; }
      if (r.score == null) return Object.assign({}, c, r, { w, status: 'na' });
      return Object.assign({}, c, r, { w, score: Math.round(clamp(r.score)), status: 'ok' });
    });
    const scored = criteria.filter(c => c.status === 'ok');
    const wsum = scored.reduce((t, c) => t + c.w, 0);
    const overall = wsum ? Math.round(scored.reduce((t, c) => t + c.w * c.score, 0) / wsum) : null;
    const zoning = criteria.find(c => c.id === 'zoning');
    let rating = overall == null ? null : S.ratings.find(([min]) => overall >= min)[1];
    const gated = zoning.status === 'ok' && zoning.score <= 10;
    if (gated) rating = 'Weak';
    return { criteria, overall, rating, gated, coverage: wsum, loading: criteria.some(c => c.status === 'loading') };
  }

  /** A few plain sentences: the result, zoning, strengths, watch-outs, gaps. */
  function writeUp(res, profile, site) {
    if (res.overall == null) return '';
    const out = [];
    const partial = res.coverage < 60 ? ' (partial: several criteria could not be scored)' : '';
    out.push(`${site} rates ${res.rating} (${res.overall} of 100) for a ${lower(profile.label)}${partial}.`);
    const z = res.criteria.find(c => c.id === 'zoning');
    if (z.status === 'ok') out.push(cap(z.fact) + (res.gated ? '; this caps the rating until a rezone or use approval is confirmed.' : '.'));
    else if (z.status === 'na' || z.status === 'error') out.push(`Zoning could not be confirmed from the state atlas${z.na ? ' (' + lower(z.na).replace(/\.$/, '') + ')' : ''}.`);
    const others = res.criteria.filter(c => c.id !== 'zoning' && c.status === 'ok' && c.fact);
    const strong = others.filter(c => c.score >= 65).sort((a, b) => b.w * b.score - a.w * a.score).slice(0, 3);
    const weak = others.filter(c => c.score < 50).sort((a, b) => b.w * (100 - b.score) - a.w * (100 - a.score)).slice(0, 3);
    const join = xs => xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join('; ') + '; and ' + xs[xs.length - 1];
    if (strong.length) out.push('In its favor: ' + join(strong.map(c => c.fact)) + '.');
    if (weak.length) out.push('Watch-outs: ' + join(weak.map(c => c.fact)) + '.');
    const middling = others.filter(c => c.score >= 50 && c.score < 65).sort((a, b) => b.w - a.w).slice(0, 1);
    if (!weak.length && middling.length) out.push('Middling: ' + middling[0].fact + '.');
    const gaps = res.criteria.filter(c => c.status === 'error' || c.status === 'na').map(c => lower(c.label));
    if (gaps.length) out.push(`Not scored: ${gaps.join(', ')}.`);
    out.push('This is a screening estimate from public data; confirm zoning, the parcel and access with the jurisdiction and a site visit.');
    return out.join(' ');
  }

  // ------------------------------------------------------------ panel
  WAMAP.createSiteEval = function (opts) {
    const { map, amenities, transit } = opts;
    const wrap = document.getElementById('map-wrap');
    const overlay = L.layerGroup();
    let run = null;            // the evaluation shown
    let profile = S.profiles[0];
    let sqft = S.defaultSqft;
    try { const saved = U.store.get('siteEvalPrefs'); if (saved) { profile = S.profiles.find(p => p.id === saved.profile) || profile; sqft = saved.sqft > 0 ? saved.sqft : sqft; } } catch (e) { /* optional */ }

    // ---- DOM -------------------------------------------------------------
    const panel = U.el('aside', { id: 'site-eval', class: 'se-panel', role: 'dialog', 'aria-label': 'Medical site evaluation', 'aria-modal': 'false' });
    panel.style.display = 'none';
    const title = U.el('h2', { class: 'se-title' });
    const coords = U.el('div', { class: 'se-coords' });
    const closeBtn = U.el('button', { class: 'icon-btn se-close', type: 'button', 'aria-label': 'Close the site evaluation', text: '✕' });
    const profileSel = U.el('select', { class: 'input small', 'aria-label': 'Use type' }, S.profiles.map(p => U.el('option', { value: p.id, text: p.label })));
    const sqftIn = U.el('input', { class: 'input small se-sqft', type: 'number', min: '1000', max: '500000', step: '500', 'aria-label': 'Building size in square feet' });
    const showMap = U.el('input', { type: 'checkbox', id: 'se-show-map' });
    showMap.checked = true;
    const scoreNum = U.el('div', { class: 'se-num' });
    const ratingEl = U.el('div', { class: 'se-rating' });
    const barFill = U.el('span');
    const coverage = U.el('div', { class: 'se-cov' });
    const writeupEl = U.el('p', { class: 'se-writeup-text', 'aria-live': 'polite' });
    const copyBtn = U.el('button', { class: 'btn mini', type: 'button', text: '📋 Copy write-up' });
    const copyAllBtn = U.el('button', { class: 'btn mini ghost', type: 'button', text: 'Copy full report' });
    const rerunBtn = U.el('button', { class: 'btn mini ghost', type: 'button', text: '↻ Re-run', title: 'Fetch every source again' });
    const critList = U.el('div', { class: 'se-criteria' });
    panel.append(
      U.el('div', { class: 'se-head' }, [U.el('div', { class: 'se-head-main' }, [U.el('div', { class: 'se-kicker', text: '🏥 Medical site evaluation' }), title, coords]), closeBtn]),
      U.el('div', { class: 'se-controls' }, [
        U.el('label', { class: 'se-ctl' }, [U.el('span', { class: 'mini-label', text: 'Use type' }), profileSel]),
        U.el('label', { class: 'se-ctl' }, [U.el('span', { class: 'mini-label', text: 'Building (sf)' }), sqftIn])
      ]),
      U.el('div', { class: 'se-score' }, [scoreNum, U.el('div', { class: 'se-score-side' }, [ratingEl, U.el('div', { class: 'se-bar' }, [barFill]), coverage])]),
      U.el('div', { class: 'se-writeup' }, [U.el('div', { class: 'se-h', text: 'Summary' }), writeupEl, U.el('div', { class: 'se-actions' }, [copyBtn, copyAllBtn, rerunBtn])]),
      U.el('div', { class: 'se-h se-h-crit' }, ['Criteria ', U.el('small', { text: 'weight · score out of 100' })]),
      critList,
      U.el('label', { class: 'check-item se-showmap', for: 'se-show-map' }, [showMap, U.el('span', { text: 'Show the parcel and drive-time catchment on the map' })]),
      U.el('div', { class: 'se-foot', html:
        'A screening estimate from public data, not an appraisal or a zoning determination. Weights and thresholds are listed under ' +
        '<a href="#" class="se-methods">Sources &amp; methodology</a>.' })
    );
    wrap.appendChild(panel);
    panel.querySelector('.se-methods').addEventListener('click', e => { e.preventDefault(); const b = document.getElementById('about-btn'); if (b) b.click(); });
    profileSel.value = profile.id;
    sqftIn.value = String(sqft);

    function savePrefs() { U.store.set('siteEvalPrefs', { profile: profile.id, sqft }); }
    profileSel.addEventListener('change', () => { profile = S.profiles.find(p => p.id === profileSel.value) || S.profiles[0]; savePrefs(); render(); drawOverlay(); });
    const applySqft = () => {
      const v = Math.round(+sqftIn.value);
      if (!(v >= 1000 && v <= 500000)) return;
      sqft = v; savePrefs(); render();
    };
    sqftIn.addEventListener('input', U.debounce(applySqft, 300));
    sqftIn.addEventListener('change', applySqft);
    closeBtn.addEventListener('click', close);
    rerunBtn.addEventListener('click', () => { if (run) start(run.pinId, true); });
    showMap.addEventListener('change', drawOverlay);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.style.display !== 'none' && !document.querySelector('.modal[style*="flex"]')) close(); });

    // ---- running ------------------------------------------------------------
    const SOURCES = ['zoning', 'parcel', 'osm', 'roads', 'traffic', 'elevation', 'flood', 'transit', 'amenities', 'catchment'];
    function start(pinId, force) {
      const pin = WAMAP.pins && WAMAP.pins.get(pinId);
      if (!pin) return;
      const same = run && run.pinId === pinId && run.lat === pin.lat && run.lon === pin.lon;
      if (same && !force) { show(); render(); return; }
      if (run && run.ctl) run.ctl.abort();
      const ctl = new AbortController();
      run = { pinId, lat: pin.lat, lon: pin.lon, label: pin.label, ctl, data: {}, status: {}, errors: {}, started: Date.now() };
      const my = run;
      show();
      const jobs = {
        zoning: () => fetchZoning(my.lat, my.lon, ctl.signal),
        parcel: () => fetchParcel(my.lat, my.lon, ctl.signal),
        osm: () => fetchOSM(my.lat, my.lon, ctl.signal),
        roads: () => fetchRoads(my.lat, my.lon, ctl.signal),
        traffic: () => fetchTraffic(my.lat, my.lon, ctl.signal),
        elevation: () => fetchElevation(my.lat, my.lon, ctl.signal),
        flood: () => fetchFlood(my.lat, my.lon, ctl.signal),
        transit: () => fetchTransit(transit, my.lat, my.lon, ctl.signal),
        amenities: () => fetchAmenities(amenities, my.lat, my.lon),
        catchment: () => fetchCatchment(my.lat, my.lon, ctl.signal)
      };
      for (const k of SOURCES) {
        my.status[k] = 'loading';
        jobs[k]().then(v => { if (run !== my) return; my.data[k] = v; my.status[k] = 'ok'; })
          .catch(e => { if (run !== my || e.name === 'AbortError') return; my.status[k] = 'error'; my.errors[k] = e.message || String(e); })
          .finally(() => { if (run === my) { scheduleRender(); if (k === 'parcel' || k === 'catchment') drawOverlay(); } });
      }
      render();
      drawOverlay();
    }
    let raf = 0;
    function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

    function show() {
      const wasHidden = panel.style.display === 'none';
      panel.style.display = '';
      wrap.classList.add('se-open');
      if (window.innerWidth < 900) { const sb = document.getElementById('sidebar'); if (sb) sb.classList.remove('open'); }
      if (wasHidden && run) keepPinVisible();
    }
    /** Pans the map so the pin is not hidden behind the panel. */
    function keepPinVisible() {
      const size = map.getSize(), p = map.latLngToContainerPoint([run.lat, run.lon]);
      const narrow = window.innerWidth < 900;
      const free = narrow ? { x0: 0, x1: size.x, y0: 0, y1: size.y - panel.offsetHeight } : { x0: 0, x1: size.x - panel.offsetWidth - 20, y0: 0, y1: size.y };
      const cx = (free.x0 + free.x1) / 2, cy = (free.y0 + free.y1) / 2;
      const inside = p.x > free.x0 + 40 && p.x < free.x1 - 40 && p.y > free.y0 + 40 && p.y < free.y1 - 40;
      if (!inside) map.panBy([p.x - cx, p.y - cy], { animate: false });
    }
    function close() {
      if (run && run.ctl) run.ctl.abort();
      panel.style.display = 'none';
      wrap.classList.remove('se-open');
      overlay.clearLayers();
      if (map.hasLayer(overlay)) map.removeLayer(overlay);
      run = null;
    }

    // ---- rendering --------------------------------------------------------------
    const levelOf = s => (s >= 70 ? 'good' : s >= 40 ? 'fair' : 'poor');
    const iconOf = { good: '✓', fair: '◐', poor: '✕' };
    function critEl(c, open) {
      const det = U.el('details', { class: 'se-crit se-' + c.status + (c.status === 'ok' ? ' se-' + levelOf(c.score) : ''), 'data-id': c.id });
      if (open) det.open = true;
      const scoreText = c.status === 'ok' ? String(c.score) : c.status === 'loading' ? '…' : '—';
      const lvl = c.status === 'ok' ? levelOf(c.score) : null;
      det.appendChild(U.el('summary', {}, [
        U.el('span', { class: 'se-icon', text: c.icon }),
        U.el('span', { class: 'se-cname', text: c.label }),
        U.el('span', { class: 'se-w', text: c.w + '%' }),
        U.el('span', { class: 'se-cbar' }, [U.el('span', { style: 'width:' + (c.status === 'ok' ? c.score : 0) + '%' })]),
        U.el('span', { class: 'se-cscore', text: (lvl ? iconOf[lvl] + ' ' : '') + scoreText, 'aria-label': c.status === 'ok' ? `${c.score} out of 100, ${lvl}` : c.status })
      ]));
      const body = U.el('div', { class: 'se-cbody' });
      if (c.status === 'loading') body.appendChild(U.el('div', { class: 'hint', text: 'Loading…' }));
      else if (c.status === 'error') body.appendChild(U.el('div', { class: 'se-miss', text: 'Not scored: ' + (c.na || 'data unavailable') }));
      else {
        if (c.status === 'na') body.appendChild(U.el('div', { class: 'se-miss', text: 'Not scored: ' + (c.na || 'data unavailable') }));
        if (c.fact) body.appendChild(U.el('div', { class: 'se-fact', text: cap(c.fact) + '.' }));
        if (c.html) body.appendChild(U.el('div', { class: 'se-zone', html: c.html }));
        if (c.details && c.details.length) body.appendChild(U.el('ul', { class: 'se-details' }, c.details.map(t => U.el('li', { text: t }))));
        const src = [];
        for (const s of c.sources || []) src.push(s);
        const linkEls = (c.links || []).map(([href, text]) => link(href, text));
        if (src.length || linkEls.length) body.appendChild(U.el('div', { class: 'se-src', html: [src.map(esc).join(' · '), linkEls.join(' · ')].filter(Boolean).join(' · ') }));
      }
      det.appendChild(body);
      return det;
    }
    let lastRes = null;
    function render() {
      if (!run) return;
      title.textContent = run.label || 'Dropped pin';
      coords.innerHTML = '';
      coords.append(run.lat.toFixed(5) + ', ' + run.lon.toFixed(5) + ' · ',
        U.el('a', { href: '#', text: 'zoom to site', onclick: e => { e.preventDefault(); map.setView([run.lat, run.lon], Math.max(map.getZoom(), 16)); } }));
      const res = evaluate(run, profile, sqft);
      lastRes = res;
      const lvl = res.overall == null ? null : res.rating === 'Strong' || res.rating === 'Good' ? 'good' : res.rating === 'Fair' ? 'fair' : 'poor';
      scoreNum.textContent = res.overall == null ? '…' : String(res.overall);
      scoreNum.className = 'se-num' + (lvl ? ' se-' + lvl : '');
      ratingEl.textContent = res.overall == null ? 'Scoring…' : `${lvl ? iconOf[lvl] + ' ' : ''}${res.rating}${res.gated ? ' (zoning)' : ''} · ${profile.label}`;
      barFill.style.width = (res.overall || 0) + '%';
      barFill.className = lvl ? 'se-' + lvl : '';
      const nScored = res.criteria.filter(c => c.status === 'ok').length;
      coverage.textContent = res.loading
        ? `${nScored} of ${res.criteria.length} criteria scored so far, still loading…`
        : `${nScored} of ${res.criteria.length} criteria scored (${res.coverage}% of the weight)`;
      writeupEl.textContent = res.loading && res.overall == null ? 'Gathering data for this site…' : writeUp(res, profile, run.label || 'This site') + (res.loading ? ' (still loading)' : '');
      const open = new Set(Array.from(critList.querySelectorAll('details[open]')).map(dd => dd.dataset.id));
      critList.innerHTML = '';
      for (const c of res.criteria) critList.appendChild(critEl(c, open.has(c.id)));
    }
    function reportText() {
      if (!run || !lastRes) return '';
      const lines = [`Medical site evaluation: ${run.label || 'Dropped pin'} (${run.lat.toFixed(5)}, ${run.lon.toFixed(5)})`,
        `Use type: ${profile.label}; building ${int(sqft)} sf`, `Overall: ${lastRes.overall == null ? 'n/a' : lastRes.overall + '/100, ' + lastRes.rating}`, '',
        writeUp(lastRes, profile, run.label || 'This site'), ''];
      for (const c of lastRes.criteria) {
        lines.push(`${c.label} (weight ${c.w}%): ${c.status === 'ok' ? c.score + '/100' : 'not scored'}${c.fact ? ' - ' + cap(c.fact) : c.na ? ' - ' + c.na : ''}`);
        for (const t of c.details || []) lines.push('  - ' + t);
      }
      lines.push('', 'Sources: Washington State Zoning Atlas (WA Commerce), WA statewide parcels, WSDOT functional class and traffic counts, USGS 3DEP, FEMA NFHL, WSDOT GTFS, ACS 5-year (U.S. Census Bureau), Valhalla/OpenStreetMap, facility registries. Screening estimate; verify with the jurisdiction.');
      return lines.join('\n');
    }
    async function copy(text, btn) {
      const old = btn.textContent;
      try { await navigator.clipboard.writeText(text); btn.textContent = '✓ Copied'; }
      catch (e) {
        const ta = U.el('textarea', { class: 'se-copy-fallback' });
        ta.value = text; document.body.appendChild(ta); ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (x) { /* none */ }
        ta.remove();
        btn.textContent = ok ? '✓ Copied' : 'Copy failed';
      }
      setTimeout(() => { btn.textContent = old; }, 1600);
    }
    copyBtn.addEventListener('click', () => copy(writeupEl.textContent, copyBtn));
    copyAllBtn.addEventListener('click', () => copy(reportText(), copyAllBtn));

    // ---- map overlay ---------------------------------------------------------------
    function drawOverlay() {
      overlay.clearLayers();
      if (!run || !showMap.checked) { if (map.hasLayer(overlay)) map.removeLayer(overlay); return; }
      if (!map.hasLayer(overlay)) map.addLayer(overlay);
      const accent = U.theme.isDark() ? CFG.PALETTE.brand.accentGreen : CFG.PALETTE.brand.green;
      const c = run.data.catchment && catchmentFor(run.data, profile);
      if (c && c.geoms) for (const g of c.geoms) overlay.addLayer(L.geoJSON(g, { interactive: false, style: { color: accent, weight: 2, dashArray: '6 5', fill: false, opacity: 0.85 } }));
      const par = run.data.parcel;
      if (par && !par.none) overlay.addLayer(L.geoJSON(par.geometry, { interactive: false, style: { color: accent, weight: 3, fillColor: accent, fillOpacity: 0.08 } }));
      overlay.addLayer(L.circleMarker([run.lat, run.lon], { radius: 16, color: accent, weight: 3, fill: false, interactive: false }));
    }
    U.theme.onChange(() => { if (run) drawOverlay(); });

    // ---- pins -------------------------------------------------------------------
    if (WAMAP.pins) {
      WAMAP.pins.on('move', (id, lat, lon, final) => { if (final && run && run.pinId === id) start(id, true); });
      WAMAP.pins.on('remove', id => { if (run && run.pinId === id) close(); });
      WAMAP.pins.on('label', id => { if (run && run.pinId === id) { run.label = WAMAP.pins.get(id).label; render(); } });
    }

    return {
      open: id => start(id, false),
      close,
      get isOpen() { return panel.style.display !== 'none'; },
      setProfile(id) { const p = S.profiles.find(x => x.id === id); if (p) { profile = p; profileSel.value = id; render(); drawOverlay(); } },
      setSqft(v) { sqftIn.value = String(v); applySqft(); },
      /** The current result, for the smoke test. */
      result() { return run ? { res: evaluate(run, profile, sqft), writeup: writeupEl.textContent, status: Object.assign({}, run.status), errors: Object.assign({}, run.errors) } : null; },
      text: reportText
    };
  };
  WAMAP.siteEvalInternals = { ramp, geomDistM, ringStats, evaluate, writeUp };
})();
