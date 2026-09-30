/* Washington Explorer — drive-time (isochrone) tool.
 * Areas reachable by car in 5 / 10 / 15 minutes, computed by the Valhalla
 * open-source routing engine (public FOSSGIS server) over the OpenStreetMap
 * road network. Population/household/income inside each band are estimated by
 * allocating census tracts whose internal point falls inside the band (ACS 5-year).
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  WAMAP.createDriveTime = function (opts) {
    const { map, card } = opts;
    const group = L.layerGroup();
    const state = {
      origin: null,       // {lat, lon, label}
      minutes: CFG.ISOCHRONE.minutes.slice(),
      marker: null,
      busy: false,
      lastResult: null
    };

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');
    const originLine = U.el('div', { class: 'origin-line', html: '<em>No origin set</em>' });
    const btnRow = U.el('div', { class: 'row-inline' });
    const pickBtn = U.el('button', { class: 'btn', type: 'button', text: '🎯 Pick origin on map' });
    const clearBtn = U.el('button', { class: 'btn ghost', type: 'button', text: 'Clear' });
    btnRow.append(pickBtn, clearBtn);

    const bandRow = U.el('div', { class: 'band-row' });
    for (const m of CFG.ISOCHRONE.minutes) {
      const cb = U.el('input', { type: 'checkbox', id: 'dt-band-' + m });
      cb.checked = true;
      cb.addEventListener('change', () => {
        state.minutes = CFG.ISOCHRONE.minutes.filter(x => document.getElementById('dt-band-' + x).checked);
        if (state.origin && state.minutes.length) generate();
        else if (!state.minutes.length) clearResult(false);
      });
      bandRow.appendChild(U.el('label', { for: 'dt-band-' + m, class: 'check-item' }, [
        cb, U.el('span', { class: 'cat-dot', style: 'background:' + U.theme.colors().isochrone[m] }),
        U.el('span', { text: m + ' min' })
      ]));
    }
    const statsBox = U.el('div', { class: 'dt-stats' });
    const status = U.el('div', { class: 'status-line', text: 'Set an origin to compute drive times.' });
    const hint = U.el('div', {
      class: 'hint',
      text: 'Estimates reflect typical driving conditions on the OpenStreetMap road network (Valhalla routing engine) — not live traffic. Peak-hour times can be longer.'
    });
    body.append(originLine, btnRow, bandRow, statsBox, status, hint);

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }

    const legendBox = U.el('div', { class: 'legend-block', 'data-layer': 'drivetime' });
    WAMAP.legendHost.appendChild(legendBox);
    legendBox.style.display = 'none';
    function renderLegend() {
      if (!state.lastResult) { legendBox.style.display = 'none'; return; }
      legendBox.innerHTML = '<div class="legend-title">Drive time</div>' +
        state.minutes.map(m =>
          `<div class="legend-row"><span class="swatch" style="background:${U.theme.colors().isochrone[m]};opacity:.55"></span><span>≤ ${m} minutes</span></div>`
        ).join('') +
        '<div class="legend-src">Valhalla / OpenStreetMap · typical conditions</div>';
      legendBox.style.display = '';
    }

    // ---- isochrone request ----------------------------------------------
    async function requestIsochrones(lat, lon) {
      const bodyJSON = JSON.stringify({
        locations: [{ lat, lon }],
        costing: CFG.ISOCHRONE.costing,
        contours: state.minutes.map(m => ({ time: m })),
        polygons: true,
        denoise: CFG.ISOCHRONE.denoise,
        generalize: CFG.ISOCHRONE.generalize
      });
      let lastErr;
      for (const ep of CFG.ISOCHRONE.endpoints) {
        for (const withId of [true, false]) {
          try {
            const headers = { 'Content-Type': 'application/json' };
            if (withId) headers['X-Client-Id'] = CFG.ISOCHRONE.clientId;
            const res = await fetch(ep, { method: 'POST', headers, body: bodyJSON });
            if (!res.ok) {
              let msg = 'HTTP ' + res.status;
              try { const e = await res.json(); if (e.error) msg = e.error; } catch (x) {}
              throw new Error(msg);
            }
            return await res.json();
          } catch (err) { lastErr = err; }
        }
      }
      throw lastErr || new Error('isochrone service unreachable');
    }

    // ---- analytics -------------------------------------------------------
    async function computeStats(bands) {
      // bands: [{minutes, geoms: [geometry,...], areaSqMi}]
      const acs = await U.censusStore.load('tract');
      const idx = await WAMAP.geoStore.loadTractIndex();
      const perBand = new Map(bands.map(b => [b.minutes, { pop: 0, hh: 0, incPop: 0, incSum: 0 }]));
      const sorted = bands.slice().sort((a, b) => a.minutes - b.minutes);
      for (const pt of idx) {
        for (const b of sorted) { // smallest containing band gets the tract
          if (b.geoms.some(g => U.geo.geometryContains(g, pt.lon, pt.lat))) {
            const row = acs.rows[pt.geoid];
            if (row) {
              const agg = perBand.get(b.minutes);
              agg.pop += row.pop || 0;
              agg.hh += row.households || 0;
              if (row.medInc != null && row.pop) { agg.incSum += row.medInc * row.pop; agg.incPop += row.pop; }
            }
            break;
          }
        }
      }
      // cumulative: "within X minutes"
      const out = [];
      let cpop = 0, chh = 0, cIncSum = 0, cIncPop = 0;
      for (const b of sorted) {
        const agg = perBand.get(b.minutes);
        cpop += agg.pop; chh += agg.hh; cIncSum += agg.incSum; cIncPop += agg.incPop;
        out.push({
          minutes: b.minutes, pop: cpop, hh: chh,
          medInc: cIncPop ? cIncSum / cIncPop : null,
          areaSqMi: b.areaSqMi, span: acs.span
        });
      }
      return out;
    }
    function renderStats(rows) {
      if (!rows) { statsBox.innerHTML = ''; return; }
      statsBox.innerHTML =
        '<table class="dt-table"><thead><tr><th></th><th>Population</th><th>House&shy;holds</th><th>Med. HH income*</th></tr></thead><tbody>' +
        rows.map(r =>
          `<tr><td><span class="cat-dot" style="background:${U.theme.colors().isochrone[r.minutes]}"></span>≤ ${r.minutes} min</td>` +
          `<td class="num">${U.fmt.int(r.pop)}</td><td class="num">${U.fmt.int(r.hh)}</td>` +
          `<td class="num">${U.fmt.money(r.medInc)}</td></tr>`).join('') +
        `</tbody></table><div class="hint">*Population-weighted average of tract medians. Tracts allocated by internal point, ACS 5-Year ${rows[0] ? rows[0].span : ''}.</div>`;
    }

    // ---- generate / clear -------------------------------------------------
    async function generate() {
      if (!state.origin || state.busy || !state.minutes.length) return;
      state.busy = true;
      setStatus('Computing drive times…', 'busy');
      try {
        const data = await requestIsochrones(state.origin.lat, state.origin.lon);
        const feats = (data.features || []).filter(f => f.geometry &&
          (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
        if (!feats.length) throw new Error('no isochrone returned');
        // group features by contour value
        const byMin = new Map();
        for (const f of feats) {
          const m = Math.round(f.properties && (f.properties.contour != null ? f.properties.contour : f.properties.metric));
          if (!byMin.has(m)) byMin.set(m, []);
          byMin.get(m).push(f.geometry);
        }
        group.clearLayers();
        if (!map.hasLayer(group)) map.addLayer(group);
        const bands = [];
        const minsDesc = Array.from(byMin.keys()).sort((a, b) => b - a);
        for (const m of minsDesc) {
          const geoms = byMin.get(m);
          const color = U.theme.colors().isochrone[m] || U.theme.colors().isochrone[15];
          let area = 0;
          for (const g of geoms) {
            area += U.geo.areaSqMi(g);
            group.addLayer(L.geoJSON({ type: 'Feature', geometry: g }, {
              style: { color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.22, interactive: false }
            }));
          }
          bands.push({ minutes: m, geoms, areaSqMi: area });
        }
        placeMarker();
        state.lastResult = { bands };
        renderLegend();
        if (state.fitOnGenerate) {
          const fitLayer = L.geoJSON({ type: 'FeatureCollection', features: feats });
          map.fitBounds(fitLayer.getBounds().pad(0.12));
        }
        setStatus('Drive-time bands for ' + (state.origin.label || 'origin'), 'ok');
        try {
          renderStats(await computeStats(bands));
        } catch (e) {
          statsBox.innerHTML = '<div class="hint">Reach statistics unavailable (' + U.escapeHTML(e.message) + ').</div>';
        }
      } catch (err) {
        setStatus('Drive-time service error: ' + err.message, 'err');
        WAMAP.toast('Could not compute drive times (' + err.message + ')', 'critical');
      } finally {
        state.busy = false;
      }
    }

    function placeMarker() {
      if (state.marker) { group.removeLayer(state.marker); }
      state.marker = L.marker([state.origin.lat, state.origin.lon], {
        draggable: true,
        icon: L.divIcon({
          className: 'poi-icon',
          html: '<span class="dt-origin">🚗</span>',
          iconSize: [30, 30], iconAnchor: [15, 15]
        })
      }).bindTooltip('Drive-time origin (drag to move)');
      state.marker.on('dragend', () => {
        const ll = state.marker.getLatLng();
        setOrigin(ll.lat, ll.lng, ll.lat.toFixed(4) + ', ' + ll.lng.toFixed(4), { fit: false });
      });
      group.addLayer(state.marker);
    }

    function clearResult(clearOrigin) {
      group.clearLayers();
      if (map.hasLayer(group)) map.removeLayer(group);
      state.marker = null;
      state.lastResult = null;
      statsBox.innerHTML = '';
      legendBox.style.display = 'none';
      if (clearOrigin !== false) {
        state.origin = null;
        originLine.innerHTML = '<em>No origin set</em>';
        setStatus('Set an origin to compute drive times.');
        if (WAMAP.urlState) WAMAP.urlState.update();
      }
    }

    function setOrigin(lat, lon, label, opts) {
      state.fitOnGenerate = !(opts && opts.fit === false); // shared links and marker drags keep the current view
      state.origin = { lat, lon, label: label || (lat.toFixed(4) + ', ' + lon.toFixed(4)) };
      originLine.innerHTML = 'Origin: <strong>' + U.escapeHTML(state.origin.label) + '</strong>';
      if (WAMAP.urlState) WAMAP.urlState.update();
      const cardToggle = card.querySelector('.card-toggle input');
      if (cardToggle && !cardToggle.checked) { cardToggle.checked = true; cardToggle.dispatchEvent(new Event('change')); }
      generate();
      // async label refinement
      U.geocode.reverse(lat, lon).then(name => {
        if (name && state.origin && state.origin.lat === lat) {
          state.origin.label = name.split(',').slice(0, 3).join(',');
          originLine.innerHTML = 'Origin: <strong>' + U.escapeHTML(state.origin.label) + '</strong>';
        }
      });
    }

    pickBtn.addEventListener('click', () => {
      WAMAP.modes.request('dt-origin', pickBtn, ll => setOrigin(ll.lat, ll.lng));
    });
    clearBtn.addEventListener('click', () => clearResult(true));

    const api = {
      id: 'drivetime',
      setOrigin,
      getOrigin() { return state.origin; },
      get enabled() { return map.hasLayer(group); },
      setEnabled(on) {
        if (on) {
          if (state.origin) { if (!map.hasLayer(group)) map.addLayer(group); renderLegend(); }
          else setStatus('Set an origin: pick on the map, search an address, or use a pin.', '');
        } else {
          if (map.hasLayer(group)) map.removeLayer(group);
          legendBox.style.display = 'none';
        }
      }
    };
    WAMAP.driveTime = api;
    return api;
  };
})();
