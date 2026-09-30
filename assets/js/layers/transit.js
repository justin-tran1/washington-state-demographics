/* Washington Explorer — transit layer.
 * Primary source: WSDOT's consolidated statewide GTFS data (every WA transit
 * agency) served from data.wsdot.wa.gov, plus the WSDOT Ferry Routes service.
 * Falls back to OpenStreetMap route relations/stops if WSDOT is unreachable.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  function normalizeRouteType(v) {
    if (v == null) return 3;
    let t = Number(v);
    if (isNaN(t)) {
      const alias = CFG.TRANSIT.modes[String(v).toLowerCase()];
      return typeof alias === 'number' ? alias : 3;
    }
    if (t >= 100) { // GTFS extended route types
      if (t >= 700 && t < 800) return 3;
      if (t >= 900 && t < 1000) return 0;
      if (t >= 1000 && t < 1300) return 4;
      if (t >= 400 && t < 500) return 1;
      if (t >= 100 && t < 200) return 2;
      return 3;
    }
    return t;
  }
  function modeStyle(t) {
    const m = CFG.TRANSIT.modes[t] || CFG.TRANSIT.modes[3];
    // Color is resolved per theme; `dash` gives each mode a second,
    // non-color channel so mode is never carried by hue alone.
    return Object.assign({}, m, { color: U.theme.colors().transit[m.token] });
  }

  // ---- agency links -------------------------------------------------------
  // Same normalisation as scripts/build-data/transit.mjs, so names from the
  // WSDOT route layer and from each agency's GTFS agency.txt line up.
  const normAgency = s => String(s || '').toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|inc|llc)\b/g, '').replace(/\s+/g, ' ').trim();
  const safeUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(u || '') ? u : null);
  const links = { data: null, promise: null };
  function loadLinks() {
    if (!links.promise) {
      links.promise = U.fetchJSON(CFG.TRANSIT.agencyData, { timeout: 30000, retries: 1 })
        .then(d => { links.data = d && d.agencies ? d : { agencies: {}, routes: {} }; })
        .catch(() => { links.data = { agencies: {}, routes: {} }; });
    }
    return links.promise;
  }
  /** { name, url, key } for an agency name, or null. */
  function agencyInfo(name) {
    const key = normAgency(name);
    if (!key) return null;
    const A = (links.data && links.data.agencies) || {};
    let hit = A[key] && A[key].url ? A[key] : null;
    if (!A[key] && key.length >= 4) {
      // "King County Metro" vs "King County Metro Transit": containment match,
      // only for names the file does not list (a listed agency without a
      // website must not borrow another's).
      const k2 = Object.keys(A).find(k => A[k].url && k.length >= 4 && (k.includes(key) || key.includes(k)));
      if (k2) hit = Object.assign({ key: k2 }, A[k2]);
    }
    if (!hit) {
      const cur = CFG.TRANSIT.agencyLinks.find(([re]) => re.test(name));
      if (cur) hit = { name, url: cur[1] };
    }
    if (!hit || !safeUrl(hit.url)) return null;
    return { name: hit.name || name, url: hit.url, key: hit.key || key };
  }
  /** Agency name for a WSDOT stop/route id such as "KCM_12345". */
  function agencyForId(id) {
    const pre = String(id || '').split('_')[0];
    const P = (links.data && links.data.prefixes) || {};
    const A = (links.data && links.data.agencies) || {};
    const key = P[pre];
    return key && A[key] ? A[key].name : '';
  }
  function agencyHTML(name) {
    if (!name) return '';
    const a = agencyInfo(name);
    return a
      ? `<div>Agency: <a href="${U.escapeHTML(a.url)}" target="_blank" rel="noopener">${U.escapeHTML(name)}</a></div>`
      : `<div>Agency: ${U.escapeHTML(name)}</div>`;
  }

  WAMAP.createTransit = function (opts) {
    const { map, card } = opts;
    // Lines use the map's shared canvas renderer: one canvas per layer would
    // leave only the topmost one clickable.
    const routesLayer = L.layerGroup();
    const ferryLayer = L.layerGroup();
    // Stops go in through U.addLayersChunked, which a newer view can cancel.
    const stopsCluster = L.markerClusterGroup({
      chunkedLoading: false, maxClusterRadius: 40, disableClusteringAtZoom: 16, showCoverageOnHover: false
    });
    let cancelStops = null;
    // Replacing routes or stops removes the layer an open popup belongs to,
    // which closes it; and opening a popup near the edge pans the map, which
    // triggers exactly such a refresh. So while a route or stop popup is open
    // and in view, that part waits and catches up once the popup closes.
    const openPopups = { routes: null, stops: null };
    const pending = { routes: false, stops: false };
    const kindOf = popup => (popup && popup._source && popup._source._transitKind) || null;
    const holds = k => !!(openPopups[k] && map.hasLayer(openPopups[k]) && map.getBounds().contains(openPopups[k].getLatLng()));
    // Checked again when an answer arrives: a popup opened while the request
    // was in flight (a second stop clicked right after the first) is kept too.
    function deferIfHeld(k) {
      if (!holds(k)) return false;
      pending[k] = true;
      state[k === 'routes' ? 'lastRoutesKey' : 'lastStopsKey'] = null;
      return true;
    }
    map.on('popupopen', e => { const k = kindOf(e.popup); if (k) openPopups[k] = e.popup; });
    map.on('popupclose', e => {
      const k = kindOf(e.popup);
      if (!k || openPopups[k] !== e.popup) return;
      openPopups[k] = null;
      if (pending[k]) { pending[k] = false; refresh(false); }
    });
    function setStops(markers) {
      for (const m of markers) m._transitKind = 'stops';
      if (cancelStops) { cancelStops(); cancelStops = null; }
      stopsCluster.clearLayers();
      if (markers.length) cancelStops = U.addLayersChunked(stopsCluster, markers, () => { cancelStops = null; });
    }

    const state = {
      enabled: false,
      showRoutes: true, showStops: true, showFerries: true,
      source: null, // 'wsdot' | 'osm'
      wsdot: null, wsdotPromise: null, // {routesUrl, stopsUrl, routeFields, stopFields}
      ferriesLoaded: false,
      lastRoutesKey: null, lastStopsKey: null,
      // Bumped for every new request: a slower, older response must not
      // overwrite the routes or stops of the view the user has moved to.
      routesGen: 0, stopsGen: 0
    };

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');
    const subs = U.el('div', { class: 'check-list' });
    const mkSub = (key, label) => {
      const cb = U.el('input', { type: 'checkbox', id: 'transit-' + key });
      cb.checked = state['show' + key];
      cb.addEventListener('change', () => { state['show' + key] = cb.checked; applyVisibility(); refresh(true); });
      subs.appendChild(U.el('label', { for: 'transit-' + key, class: 'check-item' }, [cb, U.el('span', { text: label })]));
    };
    mkSub('Routes', 'Transit routes');
    mkSub('Stops', 'Stops & stations (zoom 13+)');
    mkSub('Ferries', 'WSF ferry routes');
    const legend = U.el('div', { class: 'mode-legend' });
    const legendLines = [];
    for (const t of [3, 0, 2, 1, 4]) {
      const m = modeStyle(t);
      const line = U.el('span', { class: 'mode-line', style: `background:${m.color}` });
      legendLines.push([line, t]);
      legend.appendChild(U.el('span', { class: 'mode-chip' }, [line, m.label]));
    }
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    body.append(subs, legend, status);
    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }
    function applyVisibility() {
      const want = (on, layer) => {
        if (state.enabled && on) { if (!map.hasLayer(layer)) map.addLayer(layer); }
        else if (map.hasLayer(layer)) map.removeLayer(layer);
      };
      want(state.showRoutes, routesLayer);
      want(state.showStops, stopsCluster);
      want(state.showFerries, ferryLayer);
    }

    // ---- WSDOT resolution ------------------------------------------------
    async function resolveWSDOT() {
      if (state.wsdot) return state.wsdot;
      if (state.wsdotPromise) return state.wsdotPromise;
      state.wsdotPromise = (async () => {
        const info = await U.arcgis.serviceInfo(CFG.TRANSIT.wsdotService);
        const routeLyr = U.arcgis.findLayer(info, CFG.TRANSIT.routeLayerName, /stop|label/i);
        const stopLyr = U.arcgis.findLayer(info, CFG.TRANSIT.stopLayerName, /label/i);
        if (!routeLyr) throw new Error('WSDOT route layer not found');
        const routesUrl = CFG.TRANSIT.wsdotService + '/' + routeLyr.id;
        const stopsUrl = stopLyr ? CFG.TRANSIT.wsdotService + '/' + stopLyr.id : null;
        const findField = (fields, patterns) => {
          for (const re of patterns) {
            const hit = (fields || []).find(f => re.test(f.name));
            if (hit) return hit.name;
          }
          return null;
        };
        const rInfo = await U.arcgis.layerInfo(routesUrl);
        const routeFields = {
          type: findField(rInfo.fields, [/^route_?type$/i, /route_?type/i, /^mode$/i]),
          shortName: findField(rInfo.fields, [/^route_?short_?name$/i, /short_?name/i]),
          longName: findField(rInfo.fields, [/^route_?long_?name$/i, /long_?name/i, /^route_?name$/i]),
          desc: findField(rInfo.fields, [/^route_?desc$/i]),
          agency: findField(rInfo.fields, [/^agency_?name$/i, /agency_?name/i, /^agency$/i, /agency/i]),
          url: findField(rInfo.fields, [/^route_?url$/i, /route_?url/i])
        };
        let stopFields = null;
        if (stopsUrl) {
          const sInfo = await U.arcgis.layerInfo(stopsUrl);
          stopFields = {
            name: findField(sInfo.fields, [/^stop_?name$/i, /stop_?name/i, /^name$/i]),
            id: findField(sInfo.fields, [/^stop_?id$/i]),
            agency: findField(sInfo.fields, [/^agency_?name$/i, /agency/i]),
            freq: findField(sInfo.fields, [/freq.*(level|class|cat)/i, /frequen/i]) // WSDOT frequent-transit study
          };
        }
        state.wsdot = { routesUrl, stopsUrl, routeFields, stopFields };
        return state.wsdot;
      })();
      state.wsdotPromise.catch(() => { state.wsdotPromise = null; });
      return state.wsdotPromise;
    }

    // ---- fetch: routes ---------------------------------------------------
    function boundsKey(bounds, extra) {
      return [bounds.getWest().toFixed(2), bounds.getSouth().toFixed(2),
        bounds.getEast().toFixed(2), bounds.getNorth().toFixed(2), extra].join('|');
    }
    /** What a route's properties say: from WSDOT fields (f) or OSM tags. */
    function routeInfo(props, f) {
      const rf = f || {};
      const t = normalizeRouteType(rf.type ? props[rf.type] : (props.route_type != null ? props.route_type : props.route));
      const m = modeStyle(t);
      const short = rf.shortName ? props[rf.shortName] : (props.ref || props.route_short_name);
      const long = (rf.longName && props[rf.longName]) || (rf.desc && props[rf.desc]) ||
        (rf.longName ? null : (props.name || props.route_long_name));
      const agencyName = rf.agency ? props[rf.agency] : (props.operator || props.network || props.agency_name);
      const agency = agencyName ? agencyInfo(agencyName) : null;
      // GTFS route_url: the agency's own schedule page for this route.
      let raw = rf.url ? props[rf.url] : (props.route_url || props.website || props.url);
      if (raw && !/^https?:/i.test(raw) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(raw)) raw = 'https://' + raw;
      const title = [short, long].filter(Boolean).join(' — ') || m.label;
      return { t, m, short, long, title, agencyName: agencyName || '', agency, schedule: safeUrl(raw) };
    }
    function routePopup(props, f) {
      const r = routeInfo(props, f);
      const link = (href, text) => `<div>🔗 <a href="${U.escapeHTML(href)}" target="_blank" rel="noopener">${text}</a></div>`;
      return `<div class="popup-poi"><h3>${U.escapeHTML(r.title)}</h3>
        <div class="popup-cat"><span class="mode-line" style="background:${r.m.color}"></span> ${U.escapeHTML(r.m.label)}</div>
        ${r.agencyName ? `<div>Agency: ${U.escapeHTML(r.agencyName)}</div>` : ''}
        ${r.agency ? link(r.agency.url, 'Agency website') : ''}
        ${r.schedule ? link(r.schedule, 'Route schedule &amp; map') : ''}
        </div>`;
    }
    function addRouteFeatures(features, fieldsSpec) {
      routesLayer.clearLayers();
      const gj = L.geoJSON({ type: 'FeatureCollection', features }, {
        style: f => {
          const p = f.properties || {};
          const t = normalizeRouteType(fieldsSpec && fieldsSpec.type ? p[fieldsSpec.type]
            : (p.route_type != null ? p.route_type : p.route));
          const m = modeStyle(t);
          return { color: m.color, weight: m.weight, opacity: 0.8, dashArray: m.dash || null };
        },
        onEachFeature: (f, lyr) => {
          lyr._transitKind = 'routes';
          // Rendered when opened, so the agency-link file has had time to load.
          lyr.bindPopup(() => routePopup(f.properties || {}, fieldsSpec), { maxWidth: 300 });
          lyr.on('mouseover', () => lyr.setStyle({ weight: (lyr.options.weight || 2) + 2, opacity: 1 }));
          lyr.on('mouseout', () => gj.resetStyle(lyr));
        }
      });
      routesLayer.addLayer(gj);
    }

    async function fetchRoutesWSDOT(bounds, zoom, gen) {
      const w = await resolveWSDOT();
      const offset = zoom < 10 ? 0.001 : zoom < 12 ? 0.0003 : 0.00005;
      const fc = await U.arcgis.query(w.routesUrl, Object.assign({
        outFields: '*', geometryPrecision: 5, maxAllowableOffset: offset
      }, U.arcgis.envelope(bounds)), { pageSize: 2000, maxFeatures: 8000 });
      if (gen !== state.routesGen || deferIfHeld('routes')) return 0;
      addRouteFeatures(fc.features, w.routeFields);
      return fc.features.length;
    }
    const OSM_ROUTE_CAP = 500, OSM_STOP_CAP = 4000;
    /** OSM route relations in `bounds` as GeoJSON features; `.capped` when Overpass hit its limit. */
    async function osmRouteFeatures(bounds, signal) {
      const bbox = U.overpass.bbox(bounds);
      const ql = `[out:json][timeout:${CFG.OVERPASS.timeoutS}];` +
        `relation["type"="route"]["route"~"^(bus|trolleybus|light_rail|subway|train|tram|ferry|monorail)$"](${bbox});` +
        `out geom(${bbox}) ${OSM_ROUTE_CAP};`;
      const data = await U.overpass.run(ql, signal);
      const features = [];
      features.capped = (data.elements || []).length >= OSM_ROUTE_CAP;
      for (const rel of (data.elements || [])) {
        if (rel.type !== 'relation') continue;
        const lines = [];
        for (const mem of (rel.members || [])) {
          if (mem.type === 'way' && mem.geometry && mem.geometry.length > 1 &&
              !/platform|stop/.test(mem.role || '')) {
            lines.push(mem.geometry.map(pt => [pt.lon, pt.lat]));
          }
        }
        if (!lines.length) continue;
        features.push({
          type: 'Feature',
          properties: Object.assign({}, rel.tags),
          geometry: lines.length === 1 ? { type: 'LineString', coordinates: lines[0] }
            : { type: 'MultiLineString', coordinates: lines }
        });
      }
      return features;
    }
    async function fetchRoutesOSM(bounds, gen) {
      const features = await osmRouteFeatures(bounds);
      if (gen !== state.routesGen || deferIfHeld('routes')) return 0;
      addRouteFeatures(features, null);
      return features.length;
    }

    // ---- fetch: stops ----------------------------------------------------
    function stopIcon() {
      return L.divIcon({
        className: 'poi-icon',
        html: '<span class="stop-dot"></span>',
        iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6]
      });
    }
    /** A WSDOT stop feature as { lat, lon, name, id, agency, freq }. */
    function wsdotStop(f, w) {
      if (!f.geometry || f.geometry.type !== 'Point') return null;
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const sf = w.stopFields || {};
      const id = sf.id ? p[sf.id] : null;
      return {
        lat, lon, id,
        name: (sf.name && p[sf.name]) || 'Transit stop',
        // The id-prefix lookup waits for the popup: agencies.json may still be loading.
        agency: (sf.agency && p[sf.agency]) || '',
        freq: sf.freq && p[sf.freq] != null ? String(p[sf.freq]) : '',
        source: 'wsdot'
      };
    }
    function stopPopupHTML(s) {
      if (s.source === 'osm') {
        return `<div class="popup-poi"><h3>${U.escapeHTML(s.name)}</h3><div class="popup-cat">🚏 Stop / station</div>
          <div class="popup-src">Source: OpenStreetMap contributors</div></div>`;
      }
      return `<div class="popup-poi"><h3>${U.escapeHTML(s.name)}</h3>
        <div class="popup-cat">🚏 Transit stop</div>${agencyHTML(s.agency || agencyForId(s.id))}
        ${s.freq !== '' ? `<div>Service frequency: ${U.escapeHTML(s.freq)}</div>` : ''}
        <div class="popup-src">Source: WSDOT statewide GTFS</div></div>`;
    }
    async function fetchStopsWSDOT(bounds, gen) {
      const w = await resolveWSDOT();
      if (!w.stopsUrl) throw new Error('no stop layer');
      const fc = await U.arcgis.query(w.stopsUrl, Object.assign({
        outFields: '*', geometryPrecision: 6
      }, U.arcgis.envelope(bounds)), { pageSize: 2000, maxFeatures: 5000 });
      if (gen !== state.stopsGen || deferIfHeld('stops')) return 0;
      const markers = [];
      for (const f of fc.features) {
        const s = wsdotStop(f, w);
        if (s) markers.push(L.marker([s.lat, s.lon], { icon: stopIcon() }).bindPopup(() => stopPopupHTML(s), { maxWidth: 280 }));
      }
      setStops(markers);
      return markers.length;
    }
    async function osmStops(bounds, signal) {
      const bbox = U.overpass.bbox(bounds);
      const ql = `[out:json][timeout:${CFG.OVERPASS.timeoutS}];(` +
        `node["highway"="bus_stop"](${bbox});` +
        `node["railway"~"^(station|halt|tram_stop)$"](${bbox});` +
        `node["amenity"="ferry_terminal"](${bbox}););out ${OSM_STOP_CAP};`;
      const data = await U.overpass.run(ql, signal);
      const out = [];
      out.capped = (data.elements || []).length >= OSM_STOP_CAP;
      for (const elm of (data.elements || [])) {
        if (elm.lat == null) continue;
        out.push({ lat: elm.lat, lon: elm.lon, id: 'n' + elm.id, name: (elm.tags && elm.tags.name) || 'Transit stop', agency: '', freq: '', source: 'osm' });
      }
      return out;
    }
    async function fetchStopsOSM(bounds, gen) {
      const stops = await osmStops(bounds);
      if (gen !== state.stopsGen || deferIfHeld('stops')) return 0;
      setStops(stops.map(s => L.marker([s.lat, s.lon], { icon: stopIcon() }).bindPopup(stopPopupHTML(s), { maxWidth: 280 })));
      return stops.length;
    }

    // ---- ferries ---------------------------------------------------------
    // Fetched once (it is small) and shared by the layer and the area search.
    let ferryPromise = null;
    function ferryRoutes() {
      if (!ferryPromise) {
        ferryPromise = (async () => {
          const info = await U.arcgis.serviceInfo(CFG.TRANSIT.ferryService);
          const lyr = (info.layers || [])[0];
          if (!lyr) throw new Error('no ferry layer');
          return U.arcgis.query(CFG.TRANSIT.ferryService + '/' + lyr.id, {
            outFields: '*', geometryPrecision: 5
          }, { pageSize: 500, maxFeatures: 500 });
        })();
        ferryPromise.catch(() => { ferryPromise = null; });
      }
      return ferryPromise;
    }
    const ferryName = p => String(p.ROUTE || p.RouteName || p.Route_Name || p.NAME || p.Name || 'Ferry route');
    function ferryPopupHTML(name) {
      return `<div class="popup-poi"><h3>${U.escapeHTML(name)}</h3>
        <div class="popup-cat"><span class="mode-line" style="background:${modeStyle(4).color}"></span> Washington State Ferries</div>
        <div>🔗 <a href="${CFG.TRANSIT.ferryWebsite}" target="_blank" rel="noopener">Schedules &amp; sailings (WSDOT)</a></div>
        <div class="popup-src">Source: WSDOT Ferry Routes</div></div>`;
    }
    async function loadFerries() {
      // Overlapping refreshes share one request, so they spend one attempt.
      if (state.ferriesLoaded || state.ferriesLoading || state.ferryAttempts >= 3) return;
      state.ferriesLoading = true;
      state.ferryAttempts = (state.ferryAttempts || 0) + 1;
      try {
        const fc = await ferryRoutes();
        ferryLayer.addLayer(L.geoJSON(fc, {
          // A function, so a theme change can re-apply it (resetStyle).
          style: () => ({ color: modeStyle(4).color, weight: 3, opacity: 0.85, dashArray: '6 6' }),
          onEachFeature: (f, lyr2) => {
            const name = ferryName(f.properties || {});
            lyr2.bindPopup(() => ferryPopupHTML(name));
          }
        }));
        state.ferriesLoaded = true;
      } catch (e) { /* retried on the next refresh (up to 3 attempts); OSM routes also carry ferries */ }
      finally { state.ferriesLoading = false; }
    }

    // ---- area query (radius & area search) -------------------------------
    const lineParts = g => (!g ? [] : g.type === 'LineString' ? [g.coordinates]
      : g.type === 'MultiLineString' ? g.coordinates : []);
    // OSM maps each direction of a route as its own relation ("Bus 8: A => B",
    // "Bus 8: B => A"); they merge on operator + ref + mode, shown as "A ↔ B".
    const bothWays = name => {
      const m = String(name || '').match(/^[^:]*:\s*(.+?)\s*(?:=>|->|→)\s*(.+)$/);
      return m ? m[1] + ' ↔ ' + m[2] : name;
    };
    function areaRoute(props, rf, geometry) {
      const r = routeInfo(props, rf);
      const osmRef = !rf && props.ref;
      return {
        key: (osmRef ? [r.agencyName, props.ref, r.t] : [r.agencyName, r.short, r.long, r.t]).join('|').toLowerCase(),
        name: osmRef ? [props.ref, bothWays(props.name)].filter(Boolean).join(' — ') : r.title,
        modeLabel: r.m.label, color: r.m.color, agency: r.agencyName,
        agencyUrl: r.agency ? r.agency.url : null, schedule: r.schedule,
        lines: lineParts(geometry), popup: () => routePopup(props, rf)
      };
    }
    /** Line generalisation (degrees) the area query uses for `bounds`: coarser for bigger areas. */
    function detailFor(bounds) {
      const span = Math.max(bounds.getEast() - bounds.getWest(), bounds.getNorth() - bounds.getSouth());
      return span > 1 ? 0.001 : span > 0.25 ? 0.0003 : 0.00005;
    }
    const isWSF = name => /washington state ferries|^wsf$/i.test(String(name || '').trim());
    /**
     * Every stop and route (ferries included) whose geometry meets `bounds`,
     * whatever the layer's own view, zoom or on/off state:
     * { source, stops: [{ lat, lon, name, agency, freq, popup() }],
     *   routes: [{ key, name, modeLabel, color, agency, lines, popup() }],
     *   truncated, capped: { stops, routes }, offset }.
     * `capped` marks a list cut short at the service's limit; `offset` is the
     * line generalisation used (degrees). Lines are GeoJSON [lon, lat] arrays.
     * opts.signal cancels the query.
     */
    async function queryArea(bounds, opts = {}) {
      const signal = opts.signal;
      const check = () => { if (signal && signal.aborted) throw U.abortError(); };
      await loadLinks();
      check();
      const offset = detailFor(bounds);
      const MAX_ROUTES = 8000, MAX_STOPS = 20000;
      const out = { source: 'wsdot', stops: [], routes: [], truncated: false, capped: { stops: false, routes: false }, offset };
      try {
        const w = await resolveWSDOT();
        check();
        const env = U.arcgis.envelope(bounds);
        const [rfc, sfc] = await Promise.all([
          U.arcgis.query(w.routesUrl, Object.assign({ outFields: '*', geometryPrecision: 5, maxAllowableOffset: offset }, env),
            { pageSize: 2000, maxFeatures: MAX_ROUTES, signal }),
          w.stopsUrl ? U.arcgis.query(w.stopsUrl, Object.assign({ outFields: '*', geometryPrecision: 6 }, env),
            { pageSize: 2000, maxFeatures: MAX_STOPS, signal }) : Promise.resolve({ features: [] })
        ]);
        for (const f of rfc.features) out.routes.push(areaRoute(f.properties || {}, w.routeFields, f.geometry));
        for (const f of sfc.features) { const s = wsdotStop(f, w); if (s) out.stops.push(s); }
        out.capped = { routes: rfc.features.length >= MAX_ROUTES, stops: sfc.features.length >= MAX_STOPS };
      } catch (e) {
        check();
        out.source = 'osm';
        const [feats, stops] = await Promise.all([osmRouteFeatures(bounds, signal), osmStops(bounds, signal)]);
        for (const f of feats) out.routes.push(areaRoute(f.properties || {}, null, f.geometry));
        out.stops = stops;
        out.capped = { routes: !!feats.capped, stops: !!stops.capped };
      }
      out.truncated = out.capped.routes || out.capped.stops;
      for (const s of out.stops) {
        if (!s.agency && s.source === 'wsdot') s.agency = agencyForId(s.id); // agencies.json is loaded by now
        s.popup = () => stopPopupHTML(s);
      }
      try {
        const fc = await ferryRoutes();
        check();
        // One entry per WSF route, from the ferry service the map draws: the
        // GTFS layer (and OSM) list each crossing again, once per direction.
        out.routes = out.routes.filter(r => !isWSF(r.agency));
        for (const f of fc.features) {
          const name = ferryName(f.properties || {});
          out.routes.push({
            key: 'wsf|' + name.toLowerCase(), name, modeLabel: 'Ferry (Washington State Ferries)', color: modeStyle(4).color,
            agency: 'Washington State Ferries', agencyUrl: CFG.TRANSIT.ferryWebsite, schedule: null,
            lines: lineParts(f.geometry), popup: () => ferryPopupHTML(name)
          });
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        /* ferry routes are optional here: the GTFS or OSM ferry routes stay */
      }
      return out;
    }

    // ---- orchestration ---------------------------------------------------
    let token = 0;
    async function refresh(force) {
      if (!state.enabled) return;
      const myToken = ++token;
      const zoom = map.getZoom();
      const bounds = map.getBounds().pad(0.1);
      const jobs = [];
      let note = '';

      // (Zooming out past the routes' minimum zoom clears them regardless.)
      if (state.showRoutes && !force && zoom >= CFG.TRANSIT.routesMinZoom && holds('routes')) pending.routes = true;
      else if (state.showRoutes) {
        if (zoom < CFG.TRANSIT.routesMinZoom) { state.routesGen++; routesLayer.clearLayers(); state.lastRoutesKey = null; note = 'Zoom in for routes (z' + CFG.TRANSIT.routesMinZoom + '+). '; }
        else {
          const key = boundsKey(bounds, 'r' + (zoom < 10 ? 'a' : zoom < 12 ? 'b' : 'c'));
          if (force || key !== state.lastRoutesKey) {
            state.lastRoutesKey = key;
            const gen = ++state.routesGen;
            jobs.push((async () => {
              try {
                const n = await fetchRoutesWSDOT(bounds, zoom, gen);
                state.source = 'wsdot';
                return 'routes:' + n;
              } catch (e) {
                const n = await fetchRoutesOSM(bounds, gen);
                state.source = 'osm';
                return 'routes:' + n;
              }
            })());
          }
        }
      }
      if (state.showStops && !force && zoom >= CFG.TRANSIT.stopsMinZoom && holds('stops')) pending.stops = true;
      else if (state.showStops) {
        if (zoom < CFG.TRANSIT.stopsMinZoom) { state.stopsGen++; setStops([]); state.lastStopsKey = null; }
        else {
          const key = boundsKey(bounds, 's');
          if (force || key !== state.lastStopsKey) {
            state.lastStopsKey = key;
            const gen = ++state.stopsGen;
            jobs.push((async () => {
              try { return 'stops:' + await fetchStopsWSDOT(bounds, gen); }
              catch (e) { return 'stops:' + await fetchStopsOSM(bounds, gen); }
            })());
          }
        }
      }
      if (state.showFerries) loadFerries();

      if (!jobs.length) { setStatus(note + sourceLabel(), note ? '' : 'ok'); return; }
      setStatus('Loading transit…', 'busy');
      try {
        await Promise.all(jobs);
        if (myToken !== token || !state.enabled) return;
        setStatus(note + sourceLabel(), 'ok');
      } catch (err) {
        if (myToken !== token) return;
        setStatus('Transit data unavailable: ' + err.message, 'err');
      }
    }
    function sourceLabel() {
      return state.source === 'osm'
        ? 'Source: OpenStreetMap (WSDOT unreachable)'
        : 'Source: WSDOT statewide GTFS + WSF ferries';
    }

    const onMove = U.debounce(() => refresh(false), 600);
    map.on('moveend', onMove);
    // A theme change only recolours: nothing is fetched again.
    U.theme.onChange(() => {
      for (const [line, t] of legendLines) line.style.background = modeStyle(t).color;
      for (const group of [routesLayer, ferryLayer]) {
        group.eachLayer(gj => { if (gj.resetStyle) gj.eachLayer(l => gj.resetStyle(l)); });
      }
    });

    return {
      id: 'transit',
      queryArea,
      detailFor,
      get enabled() { return state.enabled; },
      setEnabled(on) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) { loadLinks(); applyVisibility(); refresh(true); }
        else {
          token++;
          state.stopsGen++;
          setStops([]);
          state.lastStopsKey = null;
          applyVisibility();
          setStatus('Off');
        }
      }
    };
  };
})();
