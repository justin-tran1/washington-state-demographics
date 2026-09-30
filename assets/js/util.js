/* Washington Explorer — shared utilities and API clients */
(function () {
  'use strict';
  const WAMAP = (window.WAMAP = window.WAMAP || {});
  const CFG = WAMAP.CONFIG;

  // ------------------------------------------------------------------- dom
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------ formatting
  const fmt = {
    int: v => (v == null ? '—' : Math.round(v).toLocaleString('en-US')),
    num1: v => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 })),
    money: v => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US')),
    pct1: v => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%'),
    sqmi: v => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' sq mi'),
    by(kind, v) { return (this[kind] || this.num1)(v); }
  };
  const debounce = (fn, ms) => {
    let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  };

  /**
   * Add markers to a MarkerClusterGroup in time-sliced batches; returns a
   * function that cancels the rest. markercluster's own chunkedLoading keeps
   * adding after clearLayers()/removeLayers() and throws once its group is
   * off the map, so groups fed through here are built with it switched off.
   */
  function addLayersChunked(group, layers, onDone) {
    let i = 0, cancelled = false;
    (function step() {
      if (cancelled) return;
      const t0 = performance.now();
      while (i < layers.length && performance.now() - t0 < 40) {
        group.addLayers(layers.slice(i, i + 1000));
        i += 1000;
      }
      if (i < layers.length) setTimeout(step, 0);
      else if (onDone) onDone();
    })();
    return () => { cancelled = true; };
  }

  // Washington wall-clock time: feeds publish "floating" timestamps without
  // a UTC offset, and incidents are shown in local (Pacific) time whatever
  // the viewer's own time zone.
  const PT = 'America/Los_Angeles';
  let ptOffsetFmt = null;
  function pacificOffset(t) {
    try {
      ptOffsetFmt = ptOffsetFmt || new Intl.DateTimeFormat('en-US', { timeZone: PT, timeZoneName: 'shortOffset' });
      const part = ptOffsetFmt.formatToParts(new Date(t)).find(x => x.type === 'timeZoneName');
      return -parseInt(String(part && part.value).replace('GMT', ''), 10) || 8;
    } catch (e) { return 8; }
  }
  /** Epoch ms of a timestamp; one without an offset is read as Pacific time. */
  function parsePacific(s) {
    const str = String(s == null ? '' : s).trim();
    if (/(z|[+-]\d\d:?\d\d)$/i.test(str)) return Date.parse(str);
    const m = str.match(/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?/);
    if (!m) return Date.parse(str);
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    for (const h of [7, 8]) if (pacificOffset(wall + h * 3600000) === h) return wall + h * 3600000;
    return wall + 8 * 3600000;
  }
  const fmtPacific = d => d.toLocaleString('en-US', { timeZone: PT, dateStyle: 'medium', timeStyle: 'short' }) + ' PT';

  // --------------------------------------------------------------- storage
  const store = {
    get(key) {
      try {
        const raw = localStorage.getItem('wamap:' + key);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (obj.exp && Date.now() > obj.exp) { localStorage.removeItem('wamap:' + key); return null; }
        return obj.v;
      } catch (e) { return null; }
    },
    set(key, v, ttlMs) {
      try {
        localStorage.setItem('wamap:' + key, JSON.stringify({ v, exp: ttlMs ? Date.now() + ttlMs : 0 }));
      } catch (e) { /* quota or private mode — cache is optional */ }
    },
    del(key) { try { localStorage.removeItem('wamap:' + key); } catch (e) {} }
  };

  // ----------------------------------------------------------------- theme
  // Resolves the active CBRE color set. 'auto' follows the OS; the explicit
  // modes win over it. Layers subscribe so they can restyle in place when the
  // theme flips rather than waiting for the next data fetch.
  const theme = {
    _mode: 'auto',
    _mql: window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false, addEventListener() {} },
    _subs: [],
    get mode() { return this._mode; },
    isDark() { return this._mode === 'dark' || (this._mode === 'auto' && this._mql.matches); },
    /** the active theme-dependent palette set */
    colors() { return CFG.PALETTE[this.isDark() ? 'dark' : 'light']; },
    set(mode) {
      this._mode = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
      store.set('theme', this._mode);
      this.apply();
    },
    apply() {
      document.documentElement.setAttribute('data-theme', this.isDark() ? 'dark' : 'light');
      for (const cb of this._subs) { try { cb(); } catch (e) { /* one bad subscriber must not break the rest */ } }
    },
    onChange(cb) { this._subs.push(cb); },
    init() {
      const saved = store.get('theme');
      if (saved) this._mode = saved;
      if (this._mql.addEventListener) {
        this._mql.addEventListener('change', () => { if (this._mode === 'auto') this.apply(); });
      }
      this.apply();
    }
  };

  // ------------------------------------------------------------------ http
  // Relative URLs (same-origin data/ files) have no host of their own.
  const hostOf = url => { try { return new URL(url, location.href).host + (/^https?:/i.test(url) ? '' : '/' + url); } catch (e) { return url; } };
  function abortError() { const e = new Error('Request cancelled'); e.name = 'AbortError'; return e; }
  /** opts.signal (an AbortSignal) cancels the request and its retries. */
  async function fetchJSON(url, opts = {}) {
    const { timeout = 30000, retries = 1, init = {}, signal } = opts;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal && signal.aborted) throw abortError();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(url, Object.assign({ signal: ctl.signal }, init));
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + hostOf(url));
        const text = await res.text();
        try { return JSON.parse(text); }
        catch (e) { throw new Error('Bad JSON from ' + hostOf(url)); }
      } catch (err) {
        clearTimeout(timer);
        if (signal && signal.aborted) throw abortError();
        lastErr = err;
        if (attempt < retries) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
      } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr;
  }
  function qs(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  }

  // ---------------------------------------------------------------- arcgis
  // Minimal ArcGIS REST client: service introspection, paginated queries,
  // GeoJSON output with Esri-JSON fallback conversion.
  const arcgis = {
    async serviceInfo(serviceUrl) {
      const info = await fetchJSON(serviceUrl + '?f=json', { timeout: 20000 });
      if (info.error) throw new Error('ArcGIS: ' + (info.error.message || 'service error'));
      return info;
    },
    async layerInfo(layerUrl) {
      const info = await fetchJSON(layerUrl + '?f=json', { timeout: 20000 });
      if (info.error) throw new Error('ArcGIS: ' + (info.error.message || 'layer error'));
      return info;
    },
    findLayer(serviceInfo, nameRe, excludeRe) {
      const layers = (serviceInfo.layers || []).filter(l =>
        nameRe.test(l.name) && !(excludeRe && excludeRe.test(l.name)) &&
        (!l.subLayerIds || !l.subLayerIds.length));
      return layers.length ? layers[0] : null;
    },
    esriToGeoJSON(esri) {
      const features = (esri.features || []).map(f => {
        let geometry = null;
        const g = f.geometry;
        if (g) {
          if (g.x !== undefined) geometry = { type: 'Point', coordinates: [g.x, g.y] };
          else if (g.points) geometry = { type: 'MultiPoint', coordinates: g.points };
          else if (g.paths) geometry = g.paths.length === 1
            ? { type: 'LineString', coordinates: g.paths[0] }
            : { type: 'MultiLineString', coordinates: g.paths };
          else if (g.rings) {
            // Esri: outer rings are clockwise, holes counter-clockwise.
            const polys = [];
            for (const ring of g.rings) {
              let area = 0;
              for (let i = 0; i < ring.length - 1; i++)
                area += (ring[i + 1][0] - ring[i][0]) * (ring[i + 1][1] + ring[i][1]);
              if (area >= 0 || !polys.length) polys.push([ring]); // outer (screen CW)
              else polys[polys.length - 1].push(ring);            // hole
            }
            geometry = polys.length === 1
              ? { type: 'Polygon', coordinates: polys[0] }
              : { type: 'MultiPolygon', coordinates: polys };
          }
        }
        return { type: 'Feature', properties: f.attributes || {}, geometry };
      });
      return { type: 'FeatureCollection', features };
    },
    /** Query a layer with pagination. Returns a GeoJSON FeatureCollection. opts.signal cancels it. */
    async query(layerUrl, params = {}, opts = {}) {
      const pageSize = opts.pageSize || 2000;
      const maxFeatures = opts.maxFeatures || 20000;
      const signal = opts.signal;
      const all = [];
      let offset = 0;
      for (;;) {
        const p = Object.assign({
          where: '1=1', outFields: '*', returnGeometry: true, outSR: 4326,
          f: 'geojson', resultRecordCount: pageSize, resultOffset: offset
        }, params);
        let fc, exceeded = false;
        try {
          const data = await fetchJSON(layerUrl + '/query?' + qs(p), { timeout: 45000, signal });
          if (data.error) throw new Error(data.error.message || 'query error');
          exceeded = !!(data.exceededTransferLimit || (data.properties && data.properties.exceededTransferLimit));
          fc = p.f === 'geojson' && data.type === 'FeatureCollection' ? data : arcgis.esriToGeoJSON(data);
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (p.f === 'geojson') { // some older servers lack geojson output
            const data = await fetchJSON(layerUrl + '/query?' + qs(Object.assign({}, p, { f: 'json' })), { timeout: 45000, signal });
            if (data.error) throw new Error(data.error.message || 'query error');
            exceeded = !!data.exceededTransferLimit;
            fc = arcgis.esriToGeoJSON(data);
          } else throw err;
        }
        all.push(...fc.features);
        // Servers clamp resultRecordCount to their own maxRecordCount, so a
        // short page only ends pagination when the server did not flag more.
        if (fc.features.length === 0 || all.length >= maxFeatures ||
            (!exceeded && fc.features.length < pageSize)) break;
        offset += fc.features.length;
      }
      return { type: 'FeatureCollection', features: all.slice(0, maxFeatures) };
    },
    envelope(bounds) { // Leaflet LatLngBounds -> esri envelope params
      return {
        geometry: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
        geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects'
      };
    }
  };

  // --------------------------------------------------------------- socrata
  async function socrataQuery(domains, dataset, soql, opts = {}) {
    const pageSize = 20000; // SODA allows up to 50,000 per request
    const maxRows = opts.maxRows || 25000;
    let lastErr;
    for (const domain of domains) {
      try {
        const rows = [];
        let offset = 0;
        for (;;) {
          const url = domain + '/resource/' + dataset + '.json?' +
            qs(Object.assign({}, soql, { $limit: pageSize, $offset: offset }));
          const page = await fetchJSON(url, { timeout: 45000 });
          rows.push(...page);
          if (page.length < pageSize || rows.length >= maxRows) return { rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows, domain };
          offset += page.length;
        }
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('Socrata query failed');
  }
  /** Live column names of a Socrata dataset (view metadata endpoint). */
  async function socrataColumns(domains, dataset) {
    let lastErr;
    for (const domain of domains) {
      try {
        const meta = await fetchJSON(`${domain}/api/views/${dataset}.json`, { timeout: 20000 });
        const cols = (meta.columns || []).map(c => c.fieldName).filter(Boolean);
        if (cols.length) return cols;
      } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error('no column metadata');
  }

  // -------------------------------------------------------------- overpass
  const overpass = {
    _busy: Promise.resolve(),
    /** Run a query; `signal` (optional AbortSignal) cancels it, queued or running. */
    run(ql, signal) {
      // Serialize requests to stay polite with the public endpoints.
      const job = this._busy.then(() => this._run(ql, signal));
      this._busy = job.catch(() => {});
      return job;
    },
    async _run(ql, signal) {
      let lastErr;
      for (const ep of CFG.OVERPASS.endpoints) {
        if (signal && signal.aborted) throw abortError();
        try {
          const res = await fetch(ep, {
            method: 'POST', signal,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(ql)
          });
          if (res.status === 429 || res.status === 504) { lastErr = new Error('Overpass busy (' + res.status + ')'); continue; }
          if (!res.ok) { lastErr = new Error('Overpass HTTP ' + res.status); continue; }
          return await res.json();
        } catch (err) {
          if (signal && signal.aborted) throw abortError();
          lastErr = err;
        }
      }
      throw lastErr || new Error('All Overpass endpoints failed');
    },
    bbox(bounds) { // Overpass bbox order: south,west,north,east
      return [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
        .map(v => v.toFixed(5)).join(',');
    }
  };

  // ---------------------------------------------------------------- census
  // ACS 5-year estimates, built at deploy time by the build-data GitHub Action
  // and served same-origin from data/acs/. The browser no longer calls the
  // Census Data API at all: since 2025 it returns a "Missing Key" HTML page to
  // every keyless request, which is what broke these layers.
  const censusStore = {
    _mem: {}, vintage: null, _pending: {},
    async load(level) { // level: 'county' | 'tract'
      if (this._mem[level]) return this._mem[level];
      if (this._pending[level]) return this._pending[level];
      this._pending[level] = this._load(level).finally(() => { delete this._pending[level]; });
      return this._pending[level];
    },
    async _load(level) {
      let data;
      try {
        data = await fetchJSON(CFG.CENSUS.prebuilt[level], { timeout: 30000, retries: 1 });
      } catch (err) {
        throw new Error('ACS ' + level + ' data file unavailable (' + err.message + ')');
      }
      if (!data || !Array.isArray(data.fields) || !data.rows) throw new Error('ACS ' + level + ' data file is malformed');
      const F = data.fields;
      const rows = {};
      for (const [geoid, vals] of Object.entries(data.rows)) {
        const rec = { name: (data.names && data.names[geoid]) || '' };
        for (let i = 0; i < F.length; i++) rec[F[i]] = vals[i];
        rows[geoid] = rec;
      }
      // `insurance.tables` names the ACS table behind each insurance field.
      const result = { vintage: data.vintage, span: data.span, source: data.source, built: data.built, insurance: data.insurance || null, rows };
      this.vintage = data.vintage;
      this._mem[level] = result;
      return result;
    }
  };

  // ------------------------------------------------------------- tigerweb
  // Live boundary fallback, used only when the pre-built data/geo files
  // cannot be loaded. Each root is tried in turn until one answers with
  // usable features: the generalized services carry GEOID but no STATE field
  // (and name their fields differently), the detailed service has both.
  const tigerweb = {
    _good: {}, // level -> root that answered with usable features
    async _layerUrl(root, level) {
      const T = CFG.TIGERWEB;
      const svc = `${root}/${level === 'tract' ? T.tractService : T.countyService}`;
      const layer = arcgis.findLayer(await arcgis.serviceInfo(svc), level === 'tract' ? T.tractLayerName : T.countyLayerName, /label/i);
      if (!layer) throw new Error(level + ' layer not found');
      return `${svc}/${layer.id}`;
    },
    async _query(level, extra, opts) {
      const fips = CFG.CENSUS.stateFips;
      const roots = this._good[level] ? [this._good[level]] : CFG.TIGERWEB.roots;
      let lastErr = null, emptyAnswer = false;
      for (const root of roots) {
        try {
          const fc = await arcgis.query(await this._layerUrl(root, level), Object.assign({
            where: /Generalized/.test(root) ? `GEOID LIKE '${fips}%'` : `STATE = '${fips}'`,
            outFields: '*', geometryPrecision: 5
          }, extra), opts);
          const features = [];
          for (const f of fc.features) {
            const p = f.properties || {};
            const geoid = String(p.GEOID || p.GEOID20 || '');
            if (!f.geometry || !geoid.startsWith(fips)) continue;
            features.push({ type: 'Feature', geometry: f.geometry, properties: {
              GEOID: geoid, NAME: p.NAME || p.BASENAME || geoid,
              AREALAND: p.AREALAND != null ? p.AREALAND : p.ALAND, AREAWATER: p.AREAWATER != null ? p.AREAWATER : p.AWATER
            } });
          }
          if (features.length) { this._good[level] = root; return { type: 'FeatureCollection', features }; }
          if (fc.features.length) throw new Error('features without GEOID'); // wrong layer shape: next root
          emptyAnswer = true; // nothing in view here: try the next root, then accept
        } catch (err) { lastErr = err; }
      }
      if (emptyAnswer) return { type: 'FeatureCollection', features: [] };
      delete this._good[level];
      throw lastErr || new Error('TIGERweb unavailable');
    },
    tractsInView(bounds) { return this._query('tract', arcgis.envelope(bounds), { pageSize: 1000, maxFeatures: 6000 }); },
    counties() { return this._query('county', {}, { pageSize: 100, maxFeatures: 200 }); }
  };

  // -------------------------------------------------------------- geometry
  const geo = {
    ringContains(ring, x, y) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    },
    polygonContains(coords, x, y) { // GeoJSON Polygon coordinates
      if (!this.ringContains(coords[0], x, y)) return false;
      for (let i = 1; i < coords.length; i++) if (this.ringContains(coords[i], x, y)) return false;
      return true;
    },
    geometryContains(geom, lon, lat) {
      if (!geom) return false;
      if (geom.type === 'Polygon') return this.polygonContains(geom.coordinates, lon, lat);
      if (geom.type === 'MultiPolygon') return geom.coordinates.some(p => this.polygonContains(p, lon, lat));
      return false;
    },
    /** Rough geodesic area of a GeoJSON polygon geometry, in square miles. */
    areaSqMi(geom) {
      const R = 6371008.8;
      const ringArea = ring => {
        let s = 0;
        for (let i = 0, n = ring.length; i < n; i++) {
          const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
          s += (x2 - x1) * Math.PI / 180 * (2 + Math.sin(y1 * Math.PI / 180) + Math.sin(y2 * Math.PI / 180));
        }
        return Math.abs(s * R * R / 2);
      };
      let total = 0;
      const polys = geom.type === 'Polygon' ? [geom.coordinates]
        : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      for (const poly of polys) {
        total += ringArea(poly[0]);
        for (let i = 1; i < poly.length; i++) total -= ringArea(poly[i]);
      }
      return total * CFG.SQMI_PER_SQM;
    },
    quantileBreaks(values, bins) {
      const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
      if (v.length < bins) return null;
      const breaks = [];
      for (let i = 1; i < bins; i++) breaks.push(v[Math.floor(i * v.length / bins)]);
      return { breaks, min: v[0], max: v[v.length - 1] };
    },
    binIndex(value, breaks) {
      let i = 0;
      while (i < breaks.length && value >= breaks[i]) i++;
      return i;
    }
  };

  // ------------------------------------------------------------- geocoding
  let lastNominatim = 0;
  async function nominatim(url, params) {
    const wait = CFG.GEOCODE.minIntervalMs - (Date.now() - lastNominatim);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastNominatim = Date.now();
    return fetchJSON(url + '?' + qs(params), { timeout: 20000 });
  }
  const geocode = {
    async search(query) {
      const G = CFG.GEOCODE;
      const results = [];
      const inWA = (lat, lon) => lat >= 45.4 && lat <= 49.1 && lon >= -124.9 && lon <= -116.8;
      // Primary: Esri World Geocoder - rooftop-level US addresses and named
      // places, restricted to Washington's extent.
      try {
        const data = await fetchJSON(G.esriFind + '?' + qs({
          SingleLine: query, f: 'json', maxLocations: 8, countryCode: 'USA',
          searchExtent: G.esriExtent, outFields: 'Match_addr,Addr_type,Region'
        }), { timeout: 15000 });
        for (const c of (data.candidates || [])) {
          const lat = c.location && c.location.y, lon = c.location && c.location.x;
          if (lat == null || !inWA(lat, lon) || c.score < 70) continue;
          const region = c.attributes && c.attributes.Region;
          if (region && !/washington/i.test(region)) continue;
          results.push({ label: c.address, lat, lon, source: 'Esri World Geocoder', score: c.score });
        }
      } catch (e) { /* fall through to Nominatim */ }
      if (!results.length) {
        const data = await nominatim(G.nominatimSearch, {
          q: query, format: 'jsonv2', addressdetails: 0, limit: 8,
          viewbox: G.viewbox, bounded: 1, countrycodes: 'us'
        });
        for (const m of data) {
          results.push({ label: m.display_name, lat: +m.lat, lon: +m.lon, source: 'OpenStreetMap Nominatim' });
        }
      }
      return results;
    },
    async reverse(lat, lon) {
      try {
        const data = await nominatim(CFG.GEOCODE.nominatimReverse, {
          lat, lon, format: 'jsonv2', zoom: 18
        });
        return data && data.display_name ? data.display_name : null;
      } catch (e) { return null; }
    }
  };

  WAMAP.util = {
    $, $$, el, escapeHTML, fmt, debounce, addLayersChunked, parsePacific, fmtPacific, store, fetchJSON, abortError, qs,
    arcgis, socrataQuery, socrataColumns, overpass, censusStore, tigerweb, geo, geocode, theme
  };
})();
