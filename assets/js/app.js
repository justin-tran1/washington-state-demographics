/* Washington Explorer — application shell: map, basemaps, search, pins,
 * interaction modes, toasts, layer wiring, About/Sources modal. */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    if (!window.L || !L.markerClusterGroup || !L.heatLayer) {
      document.body.insertAdjacentHTML('afterbegin',
        '<div class="file-warning">Could not load the map libraries (Leaflet) from the CDN — check your network or content blocker, then reload.</div>');
      return;
    }
    if (location.protocol === 'file:') {
      document.body.insertAdjacentHTML('afterbegin',
        '<div class="file-warning">This app loads data with fetch() and must be served over HTTP — run <code>python3 -m http.server</code> in the repo folder, or open the GitHub Pages URL.</div>');
    }

    U.theme.init();

    // ------------------------------------------------------------- map
    const map = L.map('map', {
      center: CFG.MAP.center, zoom: CFG.MAP.zoom,
      minZoom: CFG.MAP.minZoom, maxZoom: CFG.MAP.maxZoom,
      maxBounds: CFG.MAP.maxBounds, maxBoundsViscosity: 0.8,
      // One canvas for every vector layer: Leaflet hit-tests a canvas only
      // against its own layers, so a second one on top would swallow the
      // clicks and hovers meant for the layers below it.
      zoomControl: false, preferCanvas: true, renderer: L.canvas({ padding: 0.3 })
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: true, metric: true }).addTo(map);
    WAMAP.map = map;

    // ------------------------------------------------------- legend host
    WAMAP.legendHost = U.$('#legend-host');

    // ------------------------------------------------------------ toasts
    const toastHost = U.$('#toast-host');
    const recentToasts = new Map();
    WAMAP.toast = function (msg, kind) {
      const now = Date.now();
      if (recentToasts.has(msg) && now - recentToasts.get(msg) < 6000) return;
      recentToasts.set(msg, now);
      const colors = { good: CFG.PALETTE.status.good, warning: CFG.PALETTE.status.warning, critical: CFG.PALETTE.status.critical };
      const t = U.el('div', { class: 'toast', style: 'border-left-color:' + (colors[kind] || colors.warning) }, [
        U.el('span', { text: (kind === 'critical' ? '⚠ ' : kind === 'good' ? '✓ ' : 'ℹ ') + msg })
      ]);
      toastHost.appendChild(t);
      setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 6000);
    };
    window.addEventListener('unhandledrejection', () => { /* per-layer status lines handle their own errors */ });

    // ------------------------------------------------------------- modes
    // One interaction mode at a time (pin dropping / drive-time origin pick).
    const modes = {
      active: null, btn: null, cb: null, once: true,
      request(name, btn, cb, once = true) {
        if (this.active === name) { this.cancel(); return; }
        this.cancel();
        this.active = name; this.btn = btn; this.cb = cb; this.once = once;
        if (btn) btn.classList.add('active');
        map.getContainer().classList.add('crosshair');
      },
      cancel() {
        if (this.btn) this.btn.classList.remove('active');
        this.active = null; this.btn = null; this.cb = null;
        map.getContainer().classList.remove('crosshair');
      },
      handleClick(ll) {
        if (!this.active) return false;
        const cb = this.cb, once = this.once;
        if (once) this.cancel();
        cb(ll);
        return true;
      }
    };
    WAMAP.modes = modes;
    map.on('click', e => { modes.handleClick(e.latlng); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') modes.cancel(); });

    // ------------------------------------------------------ theme switch
    const themeBtns = U.$$('#theme-switch .theme-btn');
    function syncThemeBtns() {
      for (const b of themeBtns) b.setAttribute('aria-pressed', String(b.dataset.themeSet === U.theme.mode));
    }
    for (const b of themeBtns) {
      b.addEventListener('click', () => { U.theme.set(b.dataset.themeSet); syncThemeBtns(); });
    }
    U.theme.onChange(syncThemeBtns);
    syncThemeBtns();

    // ---------------------------------------------------------- basemaps
    // Base tiles live in Leaflet's own tilePane (below the data). Place
    // labels get a dedicated pane ABOVE the data layers so street and city
    // names stay readable through a choropleth.
    map.createPane('labels');
    map.getPane('labels').style.zIndex = 450;        // over overlays (400), under markers (600)
    map.getPane('labels').style.pointerEvents = 'none';

    const bmSelect = U.$('#basemap-select');
    const bmNote = U.$('#basemap-note');
    const labelsToggle = U.$('#labels-toggle');
    const labelsWrap = U.$('#labels-toggle-wrap');
    let currentBase = null;
    let currentLabels = [];
    let currentBm = null;

    for (const groupName of CFG.BASEMAP_GROUPS) {
      const inGroup = CFG.BASEMAPS.filter(b => b.group === groupName);
      if (!inGroup.length) continue;
      const og = U.el('optgroup', { label: groupName });
      for (const bm of inGroup) og.appendChild(U.el('option', { value: bm.id, text: bm.label }));
      bmSelect.appendChild(og);
    }

    function clearLabelLayers() {
      for (const l of currentLabels) map.removeLayer(l);
      currentLabels = [];
    }
    function applyLabels() {
      clearLabelLayers();
      const spec = currentBm && currentBm.labels ? CFG.LABEL_LAYERS[currentBm.labels] : null;
      labelsWrap.style.display = spec ? '' : 'none';
      if (!spec || !labelsToggle.checked) return;
      for (const url of spec.urls) {
        const opts = Object.assign({ pane: 'labels', attribution: '' }, spec.options);
        currentLabels.push(L.tileLayer(url, opts).addTo(map));
      }
    }
    function setBasemap(bm) {
      if (!bm) return;
      currentBm = bm;
      if (currentBase) map.removeLayer(currentBase);
      currentBase = L.tileLayer(bm.url, bm.options).addTo(map);
      currentBase.on('tileerror', U.debounce(() =>
        WAMAP.toast('Some ' + bm.label + ' tiles failed to load — try another base map.', 'warning'), 4000));
      bmNote.textContent = bm.note || '';
      if (bmSelect.value !== bm.id) bmSelect.value = bm.id;
      applyLabels();
    }
    bmSelect.addEventListener('change', () => {
      setBasemap(CFG.BASEMAPS.find(b => b.id === bmSelect.value));
    });
    labelsToggle.addEventListener('change', applyLabels);
    setBasemap(CFG.BASEMAPS[0]);

    // ------------------------------------------------------------ search
    const searchInput = U.$('#search-input');
    const searchBtn = U.$('#search-btn');
    const resultsBox = U.$('#search-results');
    let searchMarker = null;

    async function runSearch() {
      const q = searchInput.value.trim();
      if (!q) return;
      resultsBox.innerHTML = '<div class="search-item muted">Searching…</div>';
      resultsBox.style.display = '';
      try {
        const results = await U.geocode.search(q);
        if (!results.length) {
          resultsBox.innerHTML = '<div class="search-item muted">No matches found in Washington.</div>';
          return;
        }
        resultsBox.innerHTML = '';
        for (const r of results) {
          const item = U.el('div', { class: 'search-item', role: 'button', tabindex: '0' }, [
            U.el('div', { text: r.label }),
            U.el('div', { class: 'search-src', text: r.source })
          ]);
          const pick = () => selectResult(r);
          item.addEventListener('click', pick);
          item.addEventListener('keydown', e => { if (e.key === 'Enter') pick(); });
          resultsBox.appendChild(item);
        }
      } catch (err) {
        resultsBox.innerHTML = '<div class="search-item muted">Search failed: ' + U.escapeHTML(err.message) + '</div>';
      }
    }
    function selectResult(r) {
      resultsBox.style.display = 'none';
      map.flyTo([r.lat, r.lon], Math.max(map.getZoom(), 15), { duration: 0.8 });
      if (searchMarker) map.removeLayer(searchMarker);
      searchMarker = L.marker([r.lat, r.lon], {
        icon: L.divIcon({ className: 'poi-icon', html: '<span class="search-pin">📍</span>', iconSize: [34, 34], iconAnchor: [17, 30], popupAnchor: [0, -26] })
      }).addTo(map);
      const content = U.el('div', { class: 'popup-poi' }, [
        U.el('h3', { text: r.label.split(',').slice(0, 3).join(',') }),
        U.el('div', { class: 'popup-src', text: 'Geocoded by ' + r.source }),
        U.el('div', { class: 'popup-actions' }, [
          U.el('button', { class: 'btn mini', text: '🚗 Drive times from here', onclick: () => { WAMAP.driveTime.setOrigin(r.lat, r.lon, r.label.split(',').slice(0, 2).join(',')); map.closePopup(); } }),
          U.el('button', { class: 'btn mini', text: '📌 Keep as pin', onclick: () => { addPin(r.lat, r.lon, r.label.split(',').slice(0, 3).join(',')); map.closePopup(); } }),
          U.el('button', { class: 'btn mini ghost', text: 'Remove marker', onclick: () => { map.removeLayer(searchMarker); searchMarker = null; } })
        ])
      ]);
      searchMarker.bindPopup(content, { maxWidth: 320 }).openPopup();
    }
    searchBtn.addEventListener('click', runSearch);
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
    document.addEventListener('click', e => {
      if (!resultsBox.contains(e.target) && e.target !== searchInput) resultsBox.style.display = 'none';
    });

    // ------------------------------------------------------------- pins
    const pinLayer = L.layerGroup().addTo(map);
    const pins = new Map(); // id -> {marker, data}
    const savedPins = U.store.get('pins') || [];

    function pinPopup(id, data) {
      return U.el('div', { class: 'popup-poi' }, [
        U.el('h3', { text: data.label || 'Dropped pin' }),
        U.el('div', { class: 'popup-src', text: data.lat.toFixed(5) + ', ' + data.lon.toFixed(5) }),
        U.el('div', { class: 'popup-actions' }, [
          U.el('button', { class: 'btn mini', text: '🚗 Drive times from here', onclick: () => { WAMAP.driveTime.setOrigin(data.lat, data.lon, data.label || 'pin'); map.closePopup(); } }),
          U.el('button', { class: 'btn mini ghost', text: '🗑 Remove pin', onclick: () => removePin(id) })
        ])
      ]);
    }
    function addPin(lat, lon, label) {
      const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
      const data = { lat, lon, label: label || null };
      const marker = L.marker([lat, lon], {
        draggable: true,
        icon: L.divIcon({ className: 'poi-icon', html: '<span class="user-pin"></span>', iconSize: [22, 30], iconAnchor: [11, 28], popupAnchor: [0, -24] })
      }).addTo(pinLayer);
      marker.bindPopup(() => pinPopup(id, data), { maxWidth: 300 });
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        data.lat = ll.lat; data.lon = ll.lng; data.label = null;
        savePins();
        U.geocode.reverse(ll.lat, ll.lng).then(n => { if (n) { data.label = n.split(',').slice(0, 3).join(','); savePins(); } });
      });
      pins.set(id, { marker, data });
      savePins();
      if (!label) {
        U.geocode.reverse(lat, lon).then(n => { if (n) { data.label = n.split(',').slice(0, 3).join(','); savePins(); } });
      }
      updatePinCount();
      return id;
    }
    function removePin(id) {
      const p = pins.get(id);
      if (p) { pinLayer.removeLayer(p.marker); pins.delete(id); savePins(); updatePinCount(); }
    }
    function savePins() {
      U.store.set('pins', Array.from(pins.values()).map(p => p.data));
    }
    function updatePinCount() {
      U.$('#pin-count').textContent = pins.size ? String(pins.size) : '';
    }
    for (const p of savedPins) if (p && isFinite(p.lat)) addPin(p.lat, p.lon, p.label);

    const pinBtn = U.$('#pin-mode-btn');
    pinBtn.addEventListener('click', () => {
      modes.request('pin', pinBtn, ll => { addPin(ll.lat, ll.lng); }, false);
    });
    U.$('#pin-clear-btn').addEventListener('click', () => {
      for (const id of Array.from(pins.keys())) removePin(id);
    });

    // -------------------------------------------------------- locate/home
    U.$('#home-btn').addEventListener('click', () => {
      map.flyTo(CFG.MAP.center, CFG.MAP.zoom, { duration: 0.8 });
    });
    U.$('#locate-btn').addEventListener('click', () => {
      if (!navigator.geolocation) { WAMAP.toast('Geolocation is not available in this browser.', 'warning'); return; }
      navigator.geolocation.getCurrentPosition(
        pos => { map.flyTo([pos.coords.latitude, pos.coords.longitude], 14, { duration: 0.8 }); },
        () => WAMAP.toast('Could not determine your location.', 'warning'),
        { timeout: 8000 });
    });

    // ------------------------------------------------------------ layers
    const layers = {};
    layers.demographics = WAMAP.createChoropleth({
      id: 'demographics', metrics: CFG.DEMO_METRICS, rampKey: 'seqPrimary',
      map, card: U.$('#card-demographics')
    });
    layers.insurance = WAMAP.createChoropleth({
      id: 'insurance', metrics: CFG.INSURANCE_METRICS, rampKey: 'seqSecondary',
      map, card: U.$('#card-insurance')
    });
    layers.amenities = WAMAP.createAmenities({ map, card: U.$('#card-amenities') });
    layers.transit = WAMAP.createTransit({ map, card: U.$('#card-transit') });
    layers.crime = WAMAP.createCrime({ map, card: U.$('#card-crime') });
    layers.drivetime = WAMAP.createDriveTime({ map, card: U.$('#card-drivetime') });

    for (const [id, inst] of Object.entries(layers)) {
      const card = U.$('#card-' + id);
      if (!card) continue;
      const toggle = card.querySelector('.card-toggle input');
      toggle.addEventListener('change', () => inst.setEnabled(toggle.checked));
      inst.onForcedOff = () => {
        toggle.checked = false;
        WAMAP.toast('One area layer at a time — the other layer was switched off.', 'warning');
      };
      const head = card.querySelector('.card-head');
      head.addEventListener('click', e => {
        if (e.target.closest('.card-toggle')) return;
        card.classList.toggle('collapsed');
      });
    }

    // ------------------------------------------- shareable URL state (#hash)
    // View, basemap, active layers, choropleth metrics and the drive-time
    // origin round-trip through the URL so a link restores the analysis.
    function serializeState() {
      const c = map.getCenter();
      const parts = [`map=${c.lat.toFixed(5)}/${c.lng.toFixed(5)}/${map.getZoom()}`];
      if (bmSelect.value && bmSelect.value !== CFG.BASEMAPS[0].id) parts.push('bm=' + bmSelect.value);
      if (currentBm && currentBm.labels && !labelsToggle.checked) parts.push('nolabels=1');
      const on = Object.keys(layers).filter(id => {
        const t = U.$('#card-' + id + ' .card-toggle input');
        return t && t.checked;
      });
      if (on.length) parts.push('layers=' + on.join(','));
      const demoSel = U.$('#card-demographics select.input');
      if (demoSel && demoSel.value !== CFG.DEMO_METRICS[0].id) parts.push('demo=' + demoSel.value);
      const insSel = U.$('#card-insurance select.input');
      if (insSel && insSel.value !== CFG.INSURANCE_METRICS[0].id) parts.push('ins=' + insSel.value);
      const origin = WAMAP.driveTime.getOrigin();
      if (origin) parts.push(`dt=${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}`);
      return '#' + parts.join('&');
    }
    const urlState = {
      updateNow() {
        const h = serializeState();
        if (h === location.hash) return;
        try { history.replaceState(null, '', h); } catch (e) { location.hash = h; }
      },
      parse() {
        const out = {};
        for (const part of location.hash.replace(/^#/, '').split('&')) {
          if (!part) continue;
          const i = part.indexOf('=');
          if (i > 0) out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
        }
        return out;
      }
    };
    urlState.update = U.debounce(() => urlState.updateNow(), 300);
    WAMAP.urlState = urlState;

    (function restoreFromURL() {
      const st = urlState.parse();
      if (st.map) {
        const [lat, lng, z] = st.map.split('/').map(Number);
        if (isFinite(lat) && isFinite(lng)) map.setView([lat, lng], isFinite(z) ? z : map.getZoom(), { animate: false });
      }
      if (st.nolabels === '1') labelsToggle.checked = false;
      if (st.bm) {
        const bmCfg = CFG.BASEMAPS.find(b => b.id === st.bm);
        if (bmCfg) setBasemap(bmCfg);
      }
      const restoreSelect = (cardId, value) => {
        const sel = U.$('#card-' + cardId + ' select.input');
        if (sel && value && Array.from(sel.options).some(o => o.value === value)) {
          sel.value = value;
          sel.dispatchEvent(new Event('change'));
        }
      };
      restoreSelect('demographics', st.demo);
      restoreSelect('insurance', st.ins);
      if (st.layers) {
        for (const id of st.layers.split(',')) {
          const t = U.$('#card-' + id + ' .card-toggle input');
          if (t && !t.checked) { t.checked = true; t.dispatchEvent(new Event('change')); }
        }
      }
      if (st.dt) {
        const [lat, lon] = st.dt.split(',').map(Number);
        if (isFinite(lat) && isFinite(lon)) WAMAP.driveTime.setOrigin(lat, lon, null, { fit: false });
      }
    })();

    map.on('moveend', () => urlState.update());
    U.$('#sidebar').addEventListener('change', () => urlState.update());
    U.$('#share-btn').addEventListener('click', async () => {
      urlState.updateNow();
      try {
        await navigator.clipboard.writeText(location.href);
        WAMAP.toast('Link copied — it restores this view, basemap, layers and drive-time origin.', 'good');
      } catch (e) {
        WAMAP.toast('Could not access the clipboard — copy the address bar URL instead.', 'warning');
      }
    });

    // ------------------------------------------------------ about / modal
    const modal = U.$('#about-modal');
    const srcHost = U.$('#sources-content');
    for (const sec of CFG.SOURCES) {
      srcHost.appendChild(U.el('h3', { text: sec.section }));
      srcHost.appendChild(U.el('ul', {}, sec.items.map(t => U.el('li', { text: t }))));
    }
    U.$('#about-btn').addEventListener('click', () => { modal.style.display = 'flex'; });
    U.$('#about-link').addEventListener('click', e => { e.preventDefault(); modal.style.display = 'flex'; });
    U.$('#about-close').addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') modal.style.display = 'none'; });

    // --------------------------------------------------- sidebar (mobile)
    const sidebar = U.$('#sidebar');
    U.$('#sidebar-toggle').addEventListener('click', () => {
      sidebar.classList.toggle('open');
      setTimeout(() => map.invalidateSize(), 320);
    });

    // Collapse all cards except the first two on small screens
    if (window.innerWidth < 900) {
      U.$$('.layer-card').forEach((c, i) => { if (i > 0) c.classList.add('collapsed'); });
    }
  }
})();
