/* Washington Explorer — amenities layer.
 * Every category is one statewide file under data/amenities/, pre-built by
 * scripts/build-data/amenities.mjs from authoritative registries (CMS/HRSA
 * facilities, WA DOH hospitals, FDIC branches, USDA SNAP retailers, NREL
 * stations, NCES schools) merged with OpenStreetMap. A category's file is
 * loaded once, the first time it is switched on, so nothing is capped per
 * view or hidden until some zoom level.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  const OSM_TYPES = { n: 'node', w: 'way', r: 'relation' };

  WAMAP.createAmenities = function (opts) {
    const { map, card } = opts;
    // Markers go in through U.addLayersChunked, which can be cancelled when a
    // category is switched off mid-load (the plugin's chunkedLoading cannot).
    const cluster = L.markerClusterGroup({
      chunkedLoading: false, maxClusterRadius: 46, disableClusteringAtZoom: 17,
      spiderfyOnMaxZoom: true, showCoverageOnHover: false
    });
    // "Featured" kinds (hospitals) are few and important, so they are never
    // folded into clusters: every one stays visible at statewide zoom.
    const featuredLayer = L.layerGroup();

    const state = { enabled: false, cats: new Map() };
    for (const c of CFG.AMENITIES) {
      state.cats.set(c.id, {
        cfg: c, on: CFG.AMENITIES_DEFAULT_ON.includes(c.id),
        markers: [], featured: [], built: false, featuredCount: 0, F: null,
        shown: false, partial: false, cancel: null, data: null, promise: null, error: null
      });
    }

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');
    const list = U.el('div', { class: 'check-list' });
    for (const [cid, cat] of state.cats) {
      const cb = U.el('input', { type: 'checkbox', id: 'amen-' + cid });
      cb.checked = cat.on;
      cb.addEventListener('change', () => { cat.on = cb.checked; refresh(); });
      const label = U.el('label', { for: 'amen-' + cid, class: 'check-item', id: 'amen-label-' + cid }, [
        cb,
        U.el('span', { class: 'cat-dot', style: 'background:' + CFG.PALETTE.amenities[cat.cfg.colorToken] }),
        U.el('span', { text: cat.cfg.emoji + ' ' + cat.cfg.label }),
        U.el('span', { class: 'cat-count', id: 'amen-count-' + cid, text: '' })
      ]);
      list.appendChild(label);
    }
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    const hint = U.el('div', { class: 'hint' });
    body.append(list, hint, status);

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }

    // ---- markers --------------------------------------------------------
    function emojiFor(cat, kind) {
      for (const [re, e] of cat.cfg.kindEmoji || []) if (re.test(kind)) return e;
      return cat.cfg.emoji;
    }
    const icons = new Map();
    function iconFor(cat, emoji, big) {
      const key = cat.cfg.id + '|' + emoji + '|' + big;
      if (!icons.has(key)) {
        const color = CFG.PALETTE.amenities[cat.cfg.colorToken];
        icons.set(key, L.divIcon({
          className: 'poi-icon',
          html: `<span class="poi-chip${big ? ' poi-chip-lg' : ''}" style="border-color:${color}">${emoji}</span>`,
          iconSize: big ? [34, 34] : [28, 28], iconAnchor: big ? [17, 17] : [14, 14], popupAnchor: [0, -12]
        }));
      }
      return icons.get(key);
    }

    function popupHTML(cat, d, F, r) {
      const kind = d.kinds[r[F.kind]] || cat.cfg.label;
      const src = d.sources[r[F.src]] || {};
      const ref = F.ref != null ? r[F.ref] : null;
      const osm = ref && /^[nwr]\d+$/.test(ref) ? `https://www.openstreetmap.org/${OSM_TYPES[ref[0]]}/${ref.slice(1)}` : null;
      const link = osm || src.url || null;
      const srcName = U.escapeHTML(src.name || 'Unknown source') + (osm ? ' contributors' : '');
      const emoji = emojiFor(cat, kind);
      const val = f => (F[f] != null && r[F[f]] != null ? r[F[f]] : null);
      const addr = val('addr'), info = val('info'), web = val('web');
      return `<div class="popup-poi"><h3>${U.escapeHTML(r[F.name] || kind)}</h3>
        <div class="popup-cat">${emoji} ${U.escapeHTML(kind)}</div>
        ${addr ? `<div>${U.escapeHTML(addr)}</div>` : ''}
        ${info ? `<div>${U.escapeHTML(info)}</div>` : ''}
        ${web && /^https?:\/\/[^\s"'<>]+$/i.test(web) ? `<div>🔗 <a href="${U.escapeHTML(web)}" target="_blank" rel="noopener">Website</a></div>` : ''}
        <div class="popup-src">Source: ${link ? `<a href="${U.escapeHTML(link)}" target="_blank" rel="noopener">${srcName}</a>` : srcName}</div></div>`;
    }

    // Markers are built the first time a category is shown: the radius and
    // area search reads the same files without drawing tens of thousands.
    function buildMarkers(cat) {
      if (cat.built) return;
      cat.built = true;
      const d = cat.data, F = cat.F;
      const kindIcons = d.kinds.map(k => ({
        small: iconFor(cat, emojiFor(cat, k), false),
        big: iconFor(cat, emojiFor(cat, k), true),
        featured: !!(cat.cfg.featured && cat.cfg.featured.test(k))
      }));
      const fallback = { small: iconFor(cat, cat.cfg.emoji, false), featured: false };
      for (const r of d.rows) {
        const ki = kindIcons[r[F.kind]] || fallback;
        const isFeatured = ki.featured;
        // Popups are rendered on demand: tens of thousands of markers would
        // otherwise each carry a pre-built HTML string.
        const m = L.marker([r[F.lat], r[F.lon]], {
          icon: isFeatured ? ki.big : ki.small, keyboard: isFeatured, title: r[F.name] || d.kinds[r[F.kind]] || ''
        }).bindPopup(() => popupHTML(cat, d, F, r), { maxWidth: 300 });
        (isFeatured ? cat.featured : cat.markers).push(m);
      }
    }

    function load(cat) {
      if (cat.data) return Promise.resolve(cat.data);
      if (!cat.promise) {
        cat.promise = U.fetchJSON(CFG.AMENITY_DATA_DIR + cat.cfg.id + '.json', { timeout: 60000, retries: 1 })
          .then(d => {
            if (!d || !Array.isArray(d.rows) || !Array.isArray(d.fields) || !Array.isArray(d.kinds) || !Array.isArray(d.sources)) {
              throw new Error('unexpected file format');
            }
            const F = {};
            d.fields.forEach((f, i) => { F[f] = i; });
            const featuredKinds = d.kinds.map(k => !!(cat.cfg.featured && cat.cfg.featured.test(k)));
            cat.featuredCount = d.rows.reduce((n, r) => n + (featuredKinds[r[F.kind]] ? 1 : 0), 0);
            cat.F = F;
            cat.data = d;
            cat.error = null;
            return d;
          })
          .catch(err => { cat.promise = null; cat.error = err; throw err; });
      }
      return cat.promise;
    }

    function sync(cat) {
      const show = !!(cat.on && cat.data);
      // `partial`: an add was interrupted (layer switched off) and must resume.
      if (show === cat.shown && !(show && cat.partial && !cat.cancel)) return;
      if (cat.cancel) { cat.cancel(); cat.cancel = null; }
      cat.shown = show;
      if (show) {
        buildMarkers(cat);
        cat.partial = true;
        cat.cancel = U.addLayersChunked(cluster, cat.markers, () => { cat.partial = false; cat.cancel = null; });
        cat.featured.forEach(m => featuredLayer.addLayer(m));
      } else {
        cat.partial = false;
        cluster.removeLayers(cat.markers);
        cat.featured.forEach(m => featuredLayer.removeLayer(m));
      }
    }

    function describe(cat) {
      const d = cat.data;
      const elc = document.getElementById('amen-count-' + cat.cfg.id);
      const lab = document.getElementById('amen-label-' + cat.cfg.id);
      if (!d) { if (elc) elc.textContent = ''; return; }
      const n = d.rows.length;
      if (elc) elc.textContent = '· ' + n.toLocaleString();
      if (lab) lab.title = cat.cfg.label + ': ' + n.toLocaleString() + ' places statewide\n' +
        d.sources.map(s => '• ' + s.name + ': ' + (s.count || 0).toLocaleString() +
          (s.asOf ? ' (source unavailable at the last build; kept from ' + String(s.asOf).slice(0, 10) + ')' : '')).join('\n') +
        (d.built ? '\nBuilt ' + String(d.built).slice(0, 10) : '');
    }

    function summary() {
      let total = 0;
      const featuredNotes = [];
      for (const [, cat] of state.cats) {
        if (!cat.on || !cat.data) continue;
        total += cat.data.rows.length;
        if (cat.featuredCount) featuredNotes.push(cat.featuredCount.toLocaleString() + ' ' + cat.cfg.featuredLabel + ' always shown');
      }
      return total.toLocaleString() + ' places statewide' + (featuredNotes.length ? ' · ' + featuredNotes.join(' · ') : '');
    }

    // ---- orchestration --------------------------------------------------
    let token = 0;
    async function refresh() {
      if (!state.enabled) return;
      const my = ++token;
      for (const [, cat] of state.cats) sync(cat); // hide unchecked ones immediately
      const pending = [];
      for (const [, cat] of state.cats) {
        if (cat.on && !cat.data) pending.push(load(cat).then(() => null, err => ({ cat, err })));
      }
      hint.textContent = 'Counts are statewide; hover a category to see its sources.';
      let errs = [];
      if (pending.length) {
        setStatus('Loading places…', 'busy');
        errs = (await Promise.all(pending)).filter(Boolean);
        if (my !== token || !state.enabled) return;
      }
      for (const [, cat] of state.cats) { sync(cat); describe(cat); }
      if (errs.length) setStatus('Could not load: ' + errs.map(e => e.cat.cfg.label + ' (' + e.err.message + ')').join('; '), 'err');
      else setStatus(summary(), 'ok');
    }

    return {
      id: 'amenities',
      /**
       * Every category's statewide file, loaded once and shared with the
       * layer: [{ id, cfg, d, F }], or { id, cfg, error } for a file that
       * could not be loaded. Used by the radius and area search.
       */
      loadData() {
        return Promise.all(Array.from(state.cats.values()).map(cat => load(cat).then(
          d => ({ id: cat.cfg.id, cfg: cat.cfg, d, F: cat.F }),
          error => ({ id: cat.cfg.id, cfg: cat.cfg, error }))));
      },
      /** The popup a category's row i shows on the map. */
      popupHTML(id, i) {
        const cat = state.cats.get(id);
        return cat && cat.data && cat.data.rows[i] ? popupHTML(cat, cat.data, cat.F, cat.data.rows[i]) : '';
      },
      emojiFor(id, kind) { const cat = state.cats.get(id); return cat ? emojiFor(cat, kind) : ''; },
      get enabled() { return state.enabled; },
      setEnabled(on) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
          map.addLayer(cluster);
          map.addLayer(featuredLayer);
          refresh();
        } else {
          token++;
          for (const [, cat] of state.cats) if (cat.cancel) { cat.cancel(); cat.cancel = null; } // resumed on the next enable
          map.removeLayer(cluster);
          map.removeLayer(featuredLayer);
          setStatus('Off');
          hint.textContent = '';
        }
      }
    };
  };
})();
