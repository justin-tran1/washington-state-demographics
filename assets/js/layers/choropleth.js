/* Washington Explorer — area (choropleth) layer engine.
 * One engine powers both the Demographics and Health-insurance layers:
 * county polygons statewide, census tracts once zoomed in, ACS values joined
 * from the shared census store, quantile bins with a stable statewide legend.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  // ------------------------------------------------------ shared geo store
  const geoStore = {
    counties: null, countiesSource: null, countiesPromise: null,
    tractCache: new Map(), // GEOID -> GeoJSON feature
    tractIndex: null, tractIndexPromise: null, // statewide centroids + land area
    tractIndexById: null, // GEOID -> index entry

    // Boundaries come from the pre-built, same-origin files first (see
    // scripts/build-data/boundaries.mjs); TIGERweb and the bundled county
    // file are fallbacks for a missing or stale build.
    async loadCounties() {
      if (this.counties) return this.counties;
      if (this.countiesPromise) return this.countiesPromise;
      this.countiesPromise = (async () => {
        const attempts = [
          ['prebuilt', () => U.fetchJSON(CFG.TIGERWEB.prebuilt.county, { timeout: 20000 })],
          ['tigerweb', () => U.tigerweb.counties()],
          ['bundled', () => U.fetchJSON(CFG.TIGERWEB.localCounties, { timeout: 15000 })]
        ];
        let lastErr;
        for (const [source, load] of attempts) {
          try {
            const fc = await load();
            if (!fc || !fc.features || !fc.features.length) throw new Error('empty');
            this.countiesSource = source;
            this.counties = fc;
            return fc;
          } catch (e) { lastErr = e; }
        }
        throw lastErr;
      })();
      this.countiesPromise.catch(() => { this.countiesPromise = null; });
      return this.countiesPromise;
    },

    tractsStatewide: null, tractsPromise: null, tractsFileFailed: false,
    async loadTractsInView(map) {
      // Statewide file: loaded once, then every tract is available. A failed
      // load is not retried on every pan: TIGERweb serves the rest of the session.
      if (!this.tractsStatewide && !this.tractsFileFailed) {
        if (!this.tractsPromise) {
          this.tractsPromise = U.fetchJSON(CFG.TIGERWEB.prebuilt.tract, { timeout: 60000, retries: 1 }).then(fc => {
            if (!fc || !fc.features || fc.features.length < 1000) throw new Error('incomplete tract file');
            for (const f of fc.features) this.tractCache.set(f.properties.GEOID, f);
            this.tractsStatewide = true;
          });
          this.tractsPromise.catch(() => { this.tractsPromise = null; this.tractsFileFailed = true; });
        }
        try { await this.tractsPromise; } catch (e) { /* fall back to TIGERweb */ }
      }
      if (this.tractsStatewide) return this.tractCache;
      const bounds = map.getBounds().pad(0.25);
      const fc = await U.tigerweb.tractsInView(bounds);
      for (const f of fc.features) {
        if (f.properties && f.properties.GEOID && !this.tractCache.has(f.properties.GEOID)) {
          this.tractCache.set(f.properties.GEOID, f);
        }
      }
      return this.tractCache;
    },

    /** Statewide tract internal points + land areas, from the pre-built ACS
     *  tract file (TIGERweb INTPTLAT/INTPTLON, which are guaranteed to fall
     *  inside the tract - better than a centroid for point-in-polygon work).
     *  Used by the drive-time reach statistics. */
    async loadTractIndex() {
      if (this.tractIndex) return this.tractIndex;
      if (!this.tractIndexPromise) {
        this.tractIndexPromise = U.censusStore.load('tract').then(acs => {
          const pts = [];
          for (const [geoid, r] of Object.entries(acs.rows)) {
            if (r.lat != null && r.lon != null) pts.push({ geoid, lat: r.lat, lon: r.lon, aland: r.aland });
          }
          if (!pts.length) throw new Error('no tract internal points in the ACS data');
          this.tractIndex = pts;
          this.tractIndexById = new Map(pts.map(p => [p.geoid, p]));
          return pts;
        });
        this.tractIndexPromise.catch(() => { this.tractIndexPromise = null; });
      }
      return this.tractIndexPromise;
    },
    alandOf(geoid) {
      if (this.tractCache.has(geoid)) return this.tractCache.get(geoid).properties.AREALAND;
      const hit = this.tractIndexById && this.tractIndexById.get(geoid);
      return hit ? hit.aland : null;
    }
  };
  WAMAP.geoStore = geoStore;

  // ------------------------------------------- single-active-layer control
  const coordinator = {
    instances: [],
    register(inst) { this.instances.push(inst); },
    activate(inst) {
      for (const other of this.instances) {
        if (other !== inst && other.enabled) {
          other.setEnabled(false, true);
          if (other.onForcedOff) other.onForcedOff();
        }
      }
    }
  };
  WAMAP.areaLayerCoordinator = coordinator;

  // --------------------------------------------------------------- engine
  WAMAP.createChoropleth = function (opts) {
    const { id, metrics, rampKey, map, card } = opts;
    // Colors resolve per theme at draw time, never captured at construction.
    const ramp = () => U.theme.colors()[rampKey];
    const noData = () => U.theme.colors().noData;
    // Polygons share the map's single canvas with transit lines and crime
    // circles (one canvas hit-tests all of them). So a hovered area is not
    // raised with bringToFront, which would lift it over those layers for
    // good; a non-interactive outline is drawn on top instead.
    let hoverOutline = null;
    const clearHover = () => { if (hoverOutline) { map.removeLayer(hoverOutline); hoverOutline = null; } };

    const state = {
      enabled: false,
      metric: metrics[0],
      opacity: 0.72,
      level: null,        // 'county' | 'tract'
      layer: null,
      breaksCache: {},    // `${level}:${metric.id}` -> {breaks,min,max}
      lastError: null
    };

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');
    const metricSel = U.el('select', { class: 'input', 'aria-label': 'Metric' },
      metrics.map(m => U.el('option', { value: m.id, text: m.label })));
    const desc = U.el('div', { class: 'hint' });
    const opacityRow = U.el('div', { class: 'row-inline' }, [
      U.el('label', { class: 'mini-label', text: 'Opacity' }),
      U.el('input', { type: 'range', min: '20', max: '95', value: '72', class: 'slider', 'aria-label': 'Layer opacity' })
    ]);
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    body.append(metricSel, desc, opacityRow, status);
    const opacityInput = opacityRow.querySelector('input');

    const legendBox = U.el('div', { class: 'legend-block', 'data-layer': id });
    WAMAP.legendHost.appendChild(legendBox);
    legendBox.style.display = 'none';

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }
    function updateDesc() { desc.textContent = state.metric.desc || ''; }
    updateDesc();

    // ---- data helpers ---------------------------------------------------
    function levelForZoom() { return map.getZoom() >= CFG.MAP.tractZoom ? 'tract' : 'county'; }

    function valueFor(geoid, acs, feature) {
      const row = acs.rows[geoid];
      if (!row) return null;
      // Land area ships with the ACS rows; the boundary attribute is only a
      // fallback (the bundled county outlines carry no AREALAND at all).
      if (state.metric.needsArea && !(row.aland > 0)) {
        const aland = feature && feature.properties.AREALAND != null
          ? feature.properties.AREALAND : geoStore.alandOf(geoid);
        return aland > 0 ? state.metric.value(Object.assign({}, row, { aland })) : null;
      }
      return state.metric.value(row);
    }

    async function computeBreaks(level, acs) {
      const key = level + ':' + state.metric.id + ':' + acs.vintage;
      if (state.breaksCache[key]) return state.breaksCache[key];
      // Every metric, density included, can be binned straight from the
      // statewide ACS rows, so the legend is stable wherever the view is.
      const values = Object.values(acs.rows).map(r => state.metric.value(r));
      const q = U.geo.quantileBreaks(values, ramp().length);
      state.breaksCache[key] = q;
      return q;
    }

    function colorFor(v, q) {
      const steps = ramp();
      if (v == null || !q) return noData();
      return steps[Math.min(U.geo.binIndex(v, q.breaks), steps.length - 1)];
    }

    // ---- rendering ------------------------------------------------------
    let renderToken = 0;
    async function render() {
      if (!state.enabled) return;
      const token = ++renderToken;
      const level = levelForZoom();
      try {
        setStatus('Loading ' + (level === 'tract' ? 'census tracts' : 'counties') + '…', 'busy');
        const acs = await U.censusStore.load(level);
        let features;
        if (level === 'county') {
          const fc = await geoStore.loadCounties();
          features = fc.features;
        } else {
          await geoStore.loadTractsInView(map);
          features = Array.from(geoStore.tractCache.values());
        }
        if (token !== renderToken || !state.enabled) return;
        const q = await computeBreaks(level, acs);
        if (token !== renderToken || !state.enabled) return;

        // Panning without new tracts (or a metric/level change) needs no redraw.
        const renderKey = [level, state.metric.id, acs.vintage, features.length].join('|');
        if (state.layer && renderKey === state.renderKey) {
          setStatus(statusText(acs, level, features.length), 'ok');
          return;
        }
        state.renderKey = renderKey;

        if (state.layer) { map.removeLayer(state.layer); state.layer = null; }
        clearHover();
        state.level = level;
        state.layer = L.geoJSON({ type: 'FeatureCollection', features }, {
          style: f => {
            const v = valueFor(f.properties.GEOID, acs, f);
            return {
              fillColor: colorFor(v, q), fillOpacity: state.opacity,
              color: '#ffffff', weight: level === 'county' ? 1.2 : 0.7, opacity: 0.9
            };
          },
          onEachFeature: (f, lyr) => {
            const geoid = f.properties.GEOID;
            lyr.on('mouseover', () => {
              clearHover();
              hoverOutline = L.geoJSON(f, {
                interactive: false, style: { fill: false, weight: 2.5, color: U.theme.colors().hoverOutline, opacity: 1 }
              }).addTo(map);
            });
            lyr.on('mouseout', clearHover);
            const row = acs.rows[geoid];
            const v = valueFor(geoid, acs, f);
            const name = (row && row.name ? row.name.split(';')[0] : f.properties.NAME) || geoid;
            lyr.bindTooltip(
              `<strong>${U.escapeHTML(name)}</strong><br>${U.escapeHTML(state.metric.label)}: ${U.fmt.by(state.metric.fmt, v)}`,
              { sticky: true, direction: 'top', opacity: 0.95 });
            lyr.on('click', e => {
              L.popup({ maxWidth: 340 })
                .setLatLng(e.latlng)
                .setContent(profileHTML(geoid, f, acs))
                .openOn(map);
            });
          }
        }).addTo(map);
        state.layer.bringToBack();
        renderLegend(q, acs, level);
        setStatus(statusText(acs, level, features.length), 'ok');
        state.lastError = null;
      } catch (err) {
        if (token !== renderToken) return;
        state.lastError = err;
        setStatus('Could not load data: ' + err.message, 'err');
        WAMAP.toast('Area data unavailable right now (' + err.message + ')', 'critical');
      }
    }

    function statusText(acs, level, n) {
      return `ACS 5-Year ${acs.span} · ${n.toLocaleString()} ${level === 'tract' ? 'tracts loaded' : 'counties'}`
        + (level === 'county' && geoStore.countiesSource === 'bundled' ? ' (bundled boundaries)' : '');
    }

    function profileHTML(geoid, feature, acs) {
      const row = acs.rows[geoid] || null;
      const name = (row && row.name ? row.name : (feature.properties.NAME || geoid));
      const aland = row && row.aland > 0 ? row.aland
        : (feature.properties.AREALAND != null ? feature.properties.AREALAND : geoStore.alandOf(geoid));
      const withArea = row ? Object.assign({}, row, { aland }) : null;
      const lines = [];
      const push = (label, val) => lines.push(
        `<tr><td>${U.escapeHTML(label)}</td><td class="num">${val}</td></tr>`);
      if (withArea) {
        for (const m of CFG.DEMO_METRICS) push(m.label, U.fmt.by(m.fmt, m.value(withArea)));
        push('Per-capita income', U.fmt.money(withArea.perCap));
        push('Households', U.fmt.int(withArea.households));
        for (const m of CFG.INSURANCE_METRICS) push(m.label, U.fmt.by(m.fmt, m.value(withArea)));
        if (aland > 0) push('Land area', U.fmt.sqmi(aland * CFG.SQMI_PER_SQM));
      } else {
        lines.push('<tr><td colspan="2">No ACS data for this area.</td></tr>');
      }
      return `<div class="popup-profile"><h3>${U.escapeHTML(name)}</h3>
        <table>${lines.join('')}</table>
        <div class="popup-src">ACS 5-Year ${acs.span} · GEOID ${U.escapeHTML(geoid)} · estimates carry margins of error</div></div>`;
    }

    function renderLegend(q, acs, level) {
      if (!q) { legendBox.style.display = 'none'; return; }
      const f = v => U.fmt.by(state.metric.fmt, v);
      const stops = [q.min, ...q.breaks, q.max];
      const rows = ramp().map((c, i) =>
        `<div class="legend-row"><span class="swatch" style="background:${c}"></span>` +
        `<span>${f(stops[i])} – ${f(stops[i + 1])}</span></div>`).join('');
      legendBox.innerHTML =
        `<div class="legend-title">${U.escapeHTML(state.metric.label)}</div>` +
        `<div class="legend-sub">${level === 'tract' ? 'by census tract' : 'by county'} · ${ramp().length} equal-count classes statewide</div>` +
        rows +
        `<div class="legend-row"><span class="swatch" style="background:${noData()}"></span><span>No data</span></div>` +
        `<div class="legend-src">ACS 5-Year ${acs.span}, U.S. Census Bureau</div>`;
      legendBox.style.display = '';
    }

    // ---- events ---------------------------------------------------------
    const onMove = U.debounce(() => {
      if (!state.enabled) return;
      const level = levelForZoom();
      if (level === 'tract' || level !== state.level) render();
    }, 450);
    map.on('moveend zoomend', onMove);
    // Restyle in place when the theme flips (ramp + no-data color change).
    U.theme.onChange(() => { if (state.enabled) { state.renderKey = null; render(); } });

    metricSel.addEventListener('change', () => {
      state.metric = metrics.find(m => m.id === metricSel.value) || metrics[0];
      updateDesc();
      if (state.enabled) render();
    });
    opacityInput.addEventListener('input', () => {
      state.opacity = opacityInput.value / 100;
      if (state.layer) state.layer.setStyle({ fillOpacity: state.opacity });
    });

    const api = {
      id,
      get enabled() { return state.enabled; },
      onForcedOff: null,
      setEnabled(on, silent) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
          if (!silent) coordinator.activate(api);
          render();
        } else {
          renderToken++;
          if (state.layer) { map.removeLayer(state.layer); state.layer = null; }
          clearHover();
          state.renderKey = null;
          legendBox.style.display = 'none';
          setStatus('Off');
        }
      }
    };
    coordinator.register(api);
    return api;
  };
})();
