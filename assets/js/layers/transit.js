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
    if (!hit && key.length >= 4) {
      // "King County Metro" vs "King County Metro Transit": containment match.
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
    const renderer = L.canvas({ padding: 0.3 });
    const routesLayer = L.layerGroup();
    const ferryLayer = L.layerGroup();
    const stopsCluster = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 40, disableClusteringAtZoom: 16, showCoverageOnHover: false
    });

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
    for (const t of [3, 0, 2, 1, 4]) {
      const m = modeStyle(t);
      legend.appendChild(U.el('span', { class: 'mode-chip' }, [
        U.el('span', { class: 'mode-line', style: `background:${m.color}` }), m.label
      ]));
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
    function routePopup(props, f) {
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
      const schedule = safeUrl(raw);
      const link = (href, text) => `<div>🔗 <a href="${U.escapeHTML(href)}" target="_blank" rel="noopener">${text}</a></div>`;
      return `<div class="popup-poi"><h3>${U.escapeHTML([short, long].filter(Boolean).join(' — ') || m.label)}</h3>
        <div class="popup-cat"><span class="mode-line" style="background:${m.color}"></span> ${U.escapeHTML(m.label)}</div>
        ${agencyName ? `<div>Agency: ${U.escapeHTML(agencyName)}</div>` : ''}
        ${agency ? link(agency.url, 'Agency website') : ''}
        ${schedule ? link(schedule, 'Route schedule &amp; map') : ''}
        </div>`;
    }
    function addRouteFeatures(features, fieldsSpec) {
      routesLayer.clearLayers();
      const gj = L.geoJSON({ type: 'FeatureCollection', features }, {
        renderer,
        style: f => {
          const p = f.properties || {};
          const t = normalizeRouteType(fieldsSpec && fieldsSpec.type ? p[fieldsSpec.type]
            : (p.route_type != null ? p.route_type : p.route));
          const m = modeStyle(t);
          return { color: m.color, weight: m.weight, opacity: 0.8, dashArray: m.dash || null };
        },
        onEachFeature: (f, lyr) => {
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
      if (gen !== state.routesGen) return 0;
      addRouteFeatures(fc.features, w.routeFields);
      return fc.features.length;
    }
    async function fetchRoutesOSM(bounds, gen) {
      const bbox = U.overpass.bbox(bounds);
      const ql = `[out:json][timeout:${CFG.OVERPASS.timeoutS}];` +
        `relation["type"="route"]["route"~"^(bus|trolleybus|light_rail|subway|train|tram|ferry|monorail)$"](${bbox});` +
        `out geom(${bbox}) 500;`;
      const data = await U.overpass.run(ql);
      const features = [];
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
      if (gen !== state.routesGen) return 0;
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
    async function fetchStopsWSDOT(bounds, gen) {
      const w = await resolveWSDOT();
      if (!w.stopsUrl) throw new Error('no stop layer');
      const fc = await U.arcgis.query(w.stopsUrl, Object.assign({
        outFields: '*', geometryPrecision: 6
      }, U.arcgis.envelope(bounds)), { pageSize: 2000, maxFeatures: 5000 });
      if (gen !== state.stopsGen) return 0;
      stopsCluster.clearLayers();
      const markers = [];
      for (const f of fc.features) {
        if (!f.geometry || f.geometry.type !== 'Point') continue;
        const [lon, lat] = f.geometry.coordinates;
        const p = f.properties || {};
        const name = (w.stopFields && w.stopFields.name && p[w.stopFields.name]) || 'Transit stop';
        const stopId = w.stopFields && w.stopFields.id ? p[w.stopFields.id] : null;
        const agencyField = (w.stopFields && w.stopFields.agency && p[w.stopFields.agency]) || '';
        const freq = w.stopFields && w.stopFields.freq && p[w.stopFields.freq] != null ? p[w.stopFields.freq] : '';
        markers.push(L.marker([lat, lon], { icon: stopIcon() }).bindPopup(() =>
          `<div class="popup-poi"><h3>${U.escapeHTML(name)}</h3>
           <div class="popup-cat">🚏 Transit stop</div>${agencyHTML(agencyField || agencyForId(stopId))}
           ${freq !== '' ? `<div>Service frequency: ${U.escapeHTML(String(freq))}</div>` : ''}
           <div class="popup-src">Source: WSDOT statewide GTFS</div></div>`, { maxWidth: 280 }));
      }
      stopsCluster.addLayers(markers);
      return markers.length;
    }
    async function fetchStopsOSM(bounds, gen) {
      const bbox = U.overpass.bbox(bounds);
      const ql = `[out:json][timeout:${CFG.OVERPASS.timeoutS}];(` +
        `node["highway"="bus_stop"](${bbox});` +
        `node["railway"~"^(station|halt|tram_stop)$"](${bbox});` +
        `node["amenity"="ferry_terminal"](${bbox}););out 4000;`;
      const data = await U.overpass.run(ql);
      if (gen !== state.stopsGen) return 0;
      stopsCluster.clearLayers();
      const markers = [];
      for (const elm of (data.elements || [])) {
        if (elm.lat == null) continue;
        const name = (elm.tags && elm.tags.name) || 'Transit stop';
        markers.push(L.marker([elm.lat, elm.lon], { icon: stopIcon() }).bindPopup(
          `<div class="popup-poi"><h3>${U.escapeHTML(name)}</h3><div class="popup-cat">🚏 Stop / station</div>
           <div class="popup-src">Source: OpenStreetMap contributors</div></div>`, { maxWidth: 280 }));
      }
      stopsCluster.addLayers(markers);
      return markers.length;
    }

    // ---- ferries ---------------------------------------------------------
    async function loadFerries() {
      if (state.ferriesLoaded || state.ferryAttempts >= 3) return;
      state.ferryAttempts = (state.ferryAttempts || 0) + 1;
      try {
        const info = await U.arcgis.serviceInfo(CFG.TRANSIT.ferryService);
        const lyr = (info.layers || [])[0];
        if (!lyr) throw new Error('no ferry layer');
        const fc = await U.arcgis.query(CFG.TRANSIT.ferryService + '/' + lyr.id, {
          outFields: '*', geometryPrecision: 5
        }, { pageSize: 500, maxFeatures: 500 });
        const m = modeStyle(4);
        ferryLayer.addLayer(L.geoJSON(fc, {
          renderer,
          style: { color: m.color, weight: 3, opacity: 0.85, dashArray: '6 6' },
          onEachFeature: (f, lyr2) => {
            const p = f.properties || {};
            const name = p.ROUTE || p.RouteName || p.Route_Name || p.NAME || p.Name || 'Ferry route';
            lyr2.bindPopup(`<div class="popup-poi"><h3>${U.escapeHTML(String(name))}</h3>
              <div class="popup-cat"><span class="mode-line" style="background:${m.color}"></span> Washington State Ferries</div>
              <div>🔗 <a href="${CFG.TRANSIT.ferryWebsite}" target="_blank" rel="noopener">Schedules &amp; sailings (WSDOT)</a></div>
              <div class="popup-src">Source: WSDOT Ferry Routes</div></div>`);
          }
        }));
        state.ferriesLoaded = true;
      } catch (e) { /* retried on the next refresh (up to 3 attempts); OSM routes also carry ferries */ }
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

      if (state.showRoutes) {
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
      if (state.showStops) {
        if (zoom < CFG.TRANSIT.stopsMinZoom) { state.stopsGen++; stopsCluster.clearLayers(); state.lastStopsKey = null; }
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
    U.theme.onChange(() => { if (state.enabled) refresh(true); });

    return {
      id: 'transit',
      get enabled() { return state.enabled; },
      setEnabled(on) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) { loadLinks(); applyVisibility(); refresh(true); }
        else {
          token++;
          applyVisibility();
          setStatus('Off');
        }
      }
    };
  };
})();
