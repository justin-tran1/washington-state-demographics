/* Washington Explorer — crime layer.
 * Two levels of detail:
 *  - Statewide: every law-enforcement agency's annual NIBRS offense counts
 *    (WASPC "Crime in Washington", pre-built into data/crime/agencies.json),
 *    drawn as circles sized by offenses and colored by rate per 1,000.
 *  - Incident reports from each department that publishes them: Seattle,
 *    Tacoma, Bellevue, Redmond, Kirkland, Everett, Yakima and the Pierce
 *    County Sheriff are queried live; the King County Sheriff and Auburn
 *    publish block addresses only and are geocoded ahead of time.
 * One keyword rule set classifies every source's offense text, so the
 * category filters behave the same everywhere.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;

  const CAT_BY_ID = {};
  for (const c of CFG.CRIME.categories) CAT_BY_ID[c.id] = c;

  function classify(text) {
    const up = String(text || '').toUpperCase();
    for (const c of CFG.CRIME.categories) if (c.re.test(up)) return c;
    return CAT_BY_ID.other;
  }
  WAMAP.classifyCrime = classify; // exposed for tests/console inspection

  const AGENCY_TYPE = { city: 'City police', sheriff: "County sheriff (unincorporated areas and contract cities)", other: 'Other agency' };

  WAMAP.createCrime = function (opts) {
    const { map, card } = opts;
    const cluster = L.markerClusterGroup({
      chunkedLoading: true, maxClusterRadius: 50, disableClusteringAtZoom: 17, showCoverageOnHover: false
    });
    let heat = null;
    const agencyRenderer = L.canvas({ padding: 0.3 });
    const agencyLayer = L.layerGroup();
    const legendBox = U.el('div', { class: 'legend-block', 'data-layer': 'crime' });
    WAMAP.legendHost.appendChild(legendBox);
    legendBox.style.display = 'none';

    const state = {
      enabled: false,
      range: CFG.CRIME.defaultRange,
      mode: 'clusters',
      showAgencies: true,
      agencies: { data: null, promise: null, error: null },
      catOn: new Map(CFG.CRIME.categories.map(c => [c.id, CFG.CRIME.defaultOn.includes(c.id)])),
      cities: new Map(CFG.CRIME.cities.map(c => [c.id, {
        cfg: c, on: true, status: 'idle', incidents: [], truncated: false, error: null, noCoords: 0, resolved: null, file: null
      }]))
    };

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');

    const agencyCb = U.el('input', { type: 'checkbox', id: 'crime-agencies' });
    agencyCb.checked = state.showAgencies;
    agencyCb.addEventListener('change', () => { state.showAgencies = agencyCb.checked; refreshAgencies(); });
    const agencyRow = U.el('label', { for: 'crime-agencies', class: 'check-item' }, [
      agencyCb, U.el('span', { text: 'Every agency statewide (annual totals)' }),
      U.el('span', { class: 'cat-count', id: 'crime-agency-count', text: '' })
    ]);
    const agencyNote = U.el('div', { class: 'hint', id: 'crime-agency-note' });

    const cityHead = U.el('div', { class: 'hint', text: 'Incident reports (department open data):' });
    const cityRow = U.el('div', { class: 'city-chips' });
    for (const [cid, city] of state.cities) {
      const chip = U.el('button', { class: 'city-chip', id: 'crime-city-' + cid, type: 'button', title: city.cfg.note }, [
        U.el('span', { class: 'chip-dot' }), U.el('span', { text: city.cfg.label }),
        U.el('span', { class: 'chip-count', text: '' })
      ]);
      chip.addEventListener('click', () => {
        city.on = !city.on;
        chip.classList.toggle('off', !city.on);
        if (city.on && state.enabled && city.status === 'idle') fetchCity(cid);
        renderIncidents();
        updateCityChips();
      });
      cityRow.appendChild(chip);
    }

    const controls = U.el('div', { class: 'row-inline' });
    const rangeSel = U.el('select', { class: 'input small', 'aria-label': 'Time range' },
      CFG.CRIME.ranges.map(r => U.el('option', { value: String(r.id), text: r.label })));
    rangeSel.value = String(state.range);
    const modeSel = U.el('select', { class: 'input small', 'aria-label': 'Display mode' }, [
      U.el('option', { value: 'clusters', text: 'Points (clustered)' }),
      U.el('option', { value: 'heat', text: 'Heat map' })
    ]);
    controls.append(rangeSel, modeSel);

    const catList = U.el('div', { class: 'check-list crime-cats' });
    const groups = [
      { id: 'person', label: 'Crimes against persons' },
      { id: 'property', label: 'Crimes against property' },
      { id: 'society', label: 'Crimes against society' },
      { id: 'other', label: 'Other' }
    ];
    for (const g of groups) {
      const cats = CFG.CRIME.categories.filter(c => c.group === g.id);
      if (!cats.length) continue;
      const gcb = U.el('input', { type: 'checkbox', id: 'crime-group-' + g.id });
      const header = U.el('label', { class: 'check-group', for: 'crime-group-' + g.id }, [
        gcb,
        U.el('span', { class: 'cat-dot', style: 'background:' + U.theme.colors().crimeGroups[g.id] }),
        U.el('strong', { text: g.label })
      ]);
      catList.appendChild(header);
      const syncGroupBox = () => {
        const ons = cats.map(c => state.catOn.get(c.id));
        gcb.checked = ons.every(Boolean);
        gcb.indeterminate = !gcb.checked && ons.some(Boolean);
      };
      gcb.addEventListener('change', () => {
        for (const c of cats) {
          state.catOn.set(c.id, gcb.checked);
          const cb = document.getElementById('crime-cat-' + c.id);
          if (cb) cb.checked = gcb.checked;
        }
        onCategoriesChanged();
      });
      for (const c of cats) {
        const cb = U.el('input', { type: 'checkbox', id: 'crime-cat-' + c.id });
        cb.checked = state.catOn.get(c.id);
        cb.addEventListener('change', () => { state.catOn.set(c.id, cb.checked); syncGroupBox(); onCategoriesChanged(); });
        catList.appendChild(U.el('label', { for: 'crime-cat-' + c.id, class: 'check-item sub' }, [
          cb, U.el('span', { text: c.label }),
          U.el('span', { class: 'cat-count', id: 'crime-count-' + c.id, text: '' })
        ]));
      }
      syncGroupBox();
    }

    const totalLine = U.el('div', { class: 'crime-total' });
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    const note = U.el('div', { class: 'hint', text: 'Reporting practices differ between departments: compare places within one source, not across sources.' });
    body.append(agencyRow, agencyNote, cityHead, cityRow, controls, catList, totalLine, status, note);

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }
    function updateCityChips() {
      for (const [cid, city] of state.cities) {
        const chip = document.getElementById('crime-city-' + cid);
        if (!chip) continue;
        chip.classList.toggle('off', !city.on);
        const dot = chip.querySelector('.chip-dot');
        dot.className = 'chip-dot ' + city.status;
        chip.querySelector('.chip-count').textContent =
          city.status === 'ok' ? city.incidents.length.toLocaleString() + (city.truncated ? '+' : '')
          : city.status === 'busy' ? '…' : city.status === 'err' ? 'unavailable' : '';
        chip.title = city.cfg.note + (city.error ? ' — ' + city.error : '');
      }
    }
    function onCategoriesChanged() { renderIncidents(); renderAgencies(); }

    // ---- statewide agencies ----------------------------------------------
    function loadAgencies() {
      const a = state.agencies;
      if (a.data) return Promise.resolve(a.data);
      if (!a.promise) {
        a.promise = U.fetchJSON(CFG.CRIME.statewide.file, { timeout: 30000, retries: 1 })
          .then(d => {
            if (!d || !Array.isArray(d.rows) || !Array.isArray(d.fields)) throw new Error('unexpected file format');
            d.F = {};
            d.fields.forEach((f, i) => { d.F[f] = i; });
            a.data = d; a.error = null;
            return d;
          })
          .catch(err => { a.promise = null; a.error = err; throw err; });
      }
      return a.promise;
    }
    function selectedCats(d) { return d.cats.filter(c => state.catOn.get(c)); }
    function agencyCount(d, row, cats) { return cats.reduce((s, c) => s + (row[d.F[c]] || 0), 0); }

    function rateBreaks(values) {
      const v = values.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
      if (!v.length) return null;
      const q = p => v[Math.min(v.length - 1, Math.floor(p * v.length))];
      return [q(0.2), q(0.4), q(0.6), q(0.8)];
    }
    function rateColors() {
      const H = CFG.PALETTE.heatGradient;
      return [H[0.45], H[0.62], H[0.78], H[0.9], H[1.0]];
    }
    function classOf(rate, breaks) {
      if (rate == null || !breaks) return -1;
      let i = 0;
      while (i < breaks.length && rate > breaks[i]) i++;
      return i;
    }

    function renderAgencies() {
      agencyLayer.clearLayers();
      const d = state.agencies.data;
      if (!state.enabled || !state.showAgencies || !d) { renderLegend(); return; }
      const cats = selectedCats(d);
      const F = d.F;
      const rows = d.rows.map(r => {
        const n = agencyCount(d, r, cats);
        const pop = r[F.pop];
        return { r, n, rate: pop > 0 ? n / pop * 1000 : null };
      });
      // Rates are only comparable for agencies that serve a resident
      // population; the breaks come from those alone.
      const breaks = rateBreaks(rows.filter(x => x.r[F.pop] >= 1000).map(x => x.rate));
      const colors = rateColors();
      const max = Math.max(1, ...rows.map(x => x.n));
      for (const x of rows.sort((a, b) => b.n - a.n)) { // big circles first, small ones on top
        const cls = classOf(x.rate, breaks);
        const radius = 3 + 24 * Math.sqrt(x.n / max);
        L.circleMarker([x.r[F.lat], x.r[F.lon]], {
          renderer: agencyRenderer, radius,
          color: cls < 0 ? CFG.PALETTE.brand.cement : CFG.PALETTE.heatGradient[1.0], weight: 1,
          fillColor: cls < 0 ? U.theme.colors().noData : colors[cls], fillOpacity: 0.78
        }).bindPopup(() => agencyPopup(d, x, cats), { maxWidth: 320 }).addTo(agencyLayer);
      }
      state.agencies.breaks = breaks;
      const cnt = document.getElementById('crime-agency-count');
      if (cnt) cnt.textContent = '· ' + d.rows.length.toLocaleString();
      const missing = CFG.CRIME.categories.filter(c => state.catOn.get(c.id) && CFG.CRIME.statewide.notCounted[c.id])
        .map(c => c.label + ' (' + CFG.CRIME.statewide.notCounted[c.id] + ')');
      agencyNote.textContent = d.year + ' offenses reported to WASPC by ' + d.rows.length + ' agencies' +
        (missing.length ? '. Not in statewide counts: ' + missing.join(', ') : '') + '.';
      renderLegend();
    }

    function agencyPopup(d, x, cats) {
      const F = d.F, r = x.r;
      const pop = r[F.pop], total = r[F.total], prev = r[F.prev];
      const fmtRate = n => (pop > 0 ? (n / pop * 1000).toFixed(1) : '–');
      const catRows = cats.map(c => {
        const n = r[F[c]] || 0;
        return `<tr><td>${U.escapeHTML(CAT_BY_ID[c] ? CAT_BY_ID[c].label : c)}</td><td>${n.toLocaleString()}</td><td>${fmtRate(n)}</td></tr>`;
      }).join('');
      const change = prev > 0 ? Math.round((total - prev) / prev * 100) : null;
      return `<div class="popup-profile"><h3>${U.escapeHTML(r[F.name])}</h3>
        <div class="popup-cat">${U.escapeHTML(AGENCY_TYPE[r[F.type]] || 'Agency')} · ${U.escapeHTML(titleCounty(r[F.county]))} County</div>
        <table>
          <tr><td>Population served</td><td colspan="2">${pop > 0 ? pop.toLocaleString() : 'n/a (no resident population)'}</td></tr>
          <tr><td>All Group A offenses, ${d.year}</td><td colspan="2">${total.toLocaleString()}${pop > 0 ? ' · ' + fmtRate(total) + ' per 1,000' : ''}</td></tr>
          ${change != null ? `<tr><td>Change vs ${d.prevYear}</td><td colspan="2">${change > 0 ? '+' : ''}${change}%</td></tr>` : ''}
          <tr><th>Selected categories</th><th>Offenses</th><th>per 1,000</th></tr>
          ${catRows || '<tr><td colspan="3">No categories selected</td></tr>'}
          <tr><td><strong>Selected total</strong></td><td><strong>${x.n.toLocaleString()}</strong></td><td><strong>${fmtRate(x.n)}</strong></td></tr>
        </table>
        <div class="popup-src">Source: <a href="${U.escapeHTML(d.url)}" target="_blank" rel="noopener">WASPC Crime in Washington ${d.year}</a> (NIBRS). Theft includes vehicle theft and fraud.</div></div>`;
    }
    const titleCounty = s => String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

    function renderLegend() {
      const d = state.agencies.data;
      const b = state.agencies.breaks;
      if (!state.enabled || !state.showAgencies || !d || !b) { legendBox.style.display = 'none'; return; }
      const colors = rateColors();
      const stops = ['0', ...b.map(v => v.toFixed(1)), '+'];
      legendBox.innerHTML =
        `<div class="legend-title">Crime rate by agency, ${d.year}</div>` +
        `<div class="legend-sub">selected offenses per 1,000 residents · circle size = number of offenses</div>` +
        colors.map((c, i) => `<div class="legend-row"><span class="swatch" style="background:${c}"></span><span>${i === colors.length - 1 ? '> ' + stops[i] : stops[i] + ' – ' + stops[i + 1]}</span></div>`).join('') +
        `<div class="legend-row"><span class="swatch" style="background:${U.theme.colors().noData}"></span><span>No resident population (tribal, campus, port)</span></div>` +
        `<div class="legend-src">WASPC Crime in Washington via data.wa.gov</div>`;
      legendBox.style.display = '';
    }

    async function refreshAgencies() {
      if (!state.enabled) return;
      if (state.showAgencies && !map.hasLayer(agencyLayer)) map.addLayer(agencyLayer);
      if (!state.showAgencies && map.hasLayer(agencyLayer)) map.removeLayer(agencyLayer);
      if (state.showAgencies && !state.agencies.data) {
        try { await loadAgencies(); } catch (err) { agencyNote.textContent = 'Statewide totals unavailable: ' + err.message; }
      }
      renderAgencies();
    }

    // ---- incident adapters ------------------------------------------------
    function sinceDate() { return new Date(Date.now() - state.range * 86400000); }
    function isoDay(d) { return d.toISOString().slice(0, 10); }
    const tooNew = t => t > Date.now() + 86400000; // feeds occasionally carry future-dated typos

    // Column names are resolved against the dataset's live metadata so the
    // adapter survives schema changes; known schemas are the fallback when
    // metadata cannot be fetched.
    async function resolveSocrataSchemas(city) {
      if (city.schemas) return city.schemas;
      if (city.cfg.fields) { city.schemas = [city.cfg.fields]; return city.schemas; }
      const cands = city.cfg.fieldCandidates;
      try {
        const cols = new Set(await U.socrataColumns(city.cfg.domains, city.cfg.dataset));
        const pick = names => names.find(n => cols.has(n)) || null;
        const live = {
          date: pick(cands.date), lat: pick(cands.lat), lon: pick(cands.lon),
          addr: pick(cands.addr), area: pick(cands.area),
          offense: cands.offense.filter(n => cols.has(n)).slice(0, 4)
        };
        if (live.date && live.lat && live.lon && live.offense.length) {
          city.schemas = [live];
          return city.schemas;
        }
      } catch (e) { /* metadata unavailable — fall back to known schemas */ }
      city.schemas = city.cfg.schemas;
      return city.schemas;
    }

    async function fetchSocrata(city) {
      const schemas = await resolveSocrataSchemas(city);
      const since = isoDay(sinceDate());
      let res = null, f = null, lastErr = null;
      for (const schema of schemas) {
        try {
          res = await U.socrataQuery(city.cfg.domains, city.cfg.dataset, {
            $select: [schema.date, ...schema.offense, schema.lat, schema.lon, schema.point, schema.addr, schema.area].filter(Boolean).join(','),
            $where: `${schema.date} >= '${since}'`,
            $order: `${schema.date} DESC`
          }, { maxRows: CFG.CRIME.maxPerCity });
          f = schema;
          break;
        } catch (err) { lastErr = err; }
      }
      if (!res) throw lastErr || new Error('query failed');
      city.schemas = [f]; // remember the schema that worked
      const incidents = [];
      let noCoords = 0;
      for (const r of res.rows) {
        let lat, lon;
        if (f.point) {
          const c = r[f.point] && r[f.point].coordinates;
          lon = c ? +c[0] : NaN; lat = c ? +c[1] : NaN;
        } else { lat = parseFloat(r[f.lat]); lon = parseFloat(r[f.lon]); }
        // Seattle writes the literal string "REDACTED" for suppressed locations.
        if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) < 1) { noCoords++; continue; }
        const date = r[f.date] ? new Date(r[f.date]) : null;
        if (date && tooNew(date.getTime())) continue;
        const texts = f.offense.map(k => r[k]).filter(Boolean);
        const cat = classify(texts.join('||'));
        incidents.push({
          lat, lon, catId: cat.id, group: cat.group, offense: texts[0] || 'Offense', date,
          addr: (f.addr && r[f.addr]) || (f.area && r[f.area]) || '', cityId: city.cfg.id
        });
      }
      return { incidents, truncated: res.truncated, noCoords };
    }

    /** ArcGIS layer with configured field names (url + fields). */
    async function fetchArcgis(city) {
      const cfg = city.cfg, fl = cfg.fields;
      if (!city.resolved) {
        const info = await U.arcgis.layerInfo(cfg.url);
        city.resolved = { pageSize: Math.min(2000, info.maxRecordCount || 1000) };
      }
      const since = sinceDate();
      // Only the configured columns are ever requested: some layers also
      // carry officer names or narratives that have no place on a map.
      const outFields = [fl.date, ...fl.offense, fl.addr, fl.lat, fl.lon].filter(Boolean).join(',');
      const params = { outFields, geometryPrecision: 6, orderByFields: `${fl.date} DESC`,
        where: `${fl.date} >= TIMESTAMP '${isoDay(since)} 00:00:00'` };
      const opts = { pageSize: city.resolved.pageSize, maxFeatures: CFG.CRIME.maxPerCity };
      let fc;
      try { fc = await U.arcgis.query(cfg.url, params, opts); }
      catch (e) { // some servers reject TIMESTAMP syntax — retry with DATE
        fc = await U.arcgis.query(cfg.url, Object.assign({}, params, { where: `${fl.date} >= DATE '${isoDay(since)}'` }), opts);
      }
      const incidents = [];
      let noCoords = 0;
      for (const f of fc.features) {
        const p = f.properties || {};
        let lat, lon;
        if (fl.lat && fl.lon) { lat = +p[fl.lat]; lon = +p[fl.lon]; }
        else if (f.geometry && f.geometry.type === 'Point') { lon = f.geometry.coordinates[0]; lat = f.geometry.coordinates[1]; }
        if (!isFinite(lat) || !isFinite(lon) || !lat || Math.abs(lat) < 1) { noCoords++; continue; }
        const raw = p[fl.date];
        const t = raw == null ? NaN : (typeof raw === 'number' ? raw : Date.parse(raw));
        if (isFinite(t) && (t < since.getTime() || tooNew(t))) continue; // belt & braces if where was ignored
        const texts = fl.offense.map(k => p[k]).filter(Boolean).map(String);
        const cat = classify(texts.join('||'));
        incidents.push({
          lat, lon, catId: cat.id, group: cat.group, offense: texts[0] || 'Offense',
          date: isFinite(t) ? new Date(t) : null, addr: (fl.addr && p[fl.addr]) || '', cityId: cfg.id
        });
      }
      return { incidents, truncated: fc.features.length >= CFG.CRIME.maxPerCity, noCoords };
    }

    /** Pre-built, geocoded file (data/crime/<id>.json): filtered by range here. */
    async function fetchPrebuilt(city) {
      if (!city.file) {
        const d = await U.fetchJSON(city.cfg.file, { timeout: 30000, retries: 1 });
        if (!d || !Array.isArray(d.rows)) throw new Error('unexpected file format');
        city.file = d;
      }
      const d = city.file;
      const from = Date.parse(d.from);
      const since = sinceDate().getTime();
      const cats = d.offenses.map(o => classify(o));
      const incidents = [];
      for (const r of d.rows) {
        const t = from + r[2] * 60000;
        if (t < since) continue;
        const cat = cats[r[3]];
        incidents.push({ lat: r[0], lon: r[1], catId: cat.id, group: cat.group, offense: d.offenses[r[3]],
          date: new Date(t), addr: d.addrs[r[4]] || '', cityId: city.cfg.id });
      }
      return { incidents, truncated: false, noCoords: 0 };
    }

    const ADAPTERS = { socrata: fetchSocrata, arcgis: fetchArcgis, prebuilt: fetchPrebuilt };

    async function fetchCity(cid) {
      const city = state.cities.get(cid);
      if (!city || city.status === 'busy') return;
      city.status = 'busy';
      city.error = null;
      updateCityChips();
      updateStatusLine();
      try {
        const res = await ADAPTERS[city.cfg.type](city);
        city.incidents = res.incidents;
        city.truncated = res.truncated;
        city.noCoords = res.noCoords;
        city.status = 'ok';
      } catch (err) {
        city.status = 'err';
        city.error = err.message;
        city.incidents = [];
      }
      updateCityChips();
      renderIncidents();
      updateStatusLine();
    }

    function updateStatusLine() {
      const parts = [];
      let anyBusy = false;
      const truncated = [];
      for (const [, city] of state.cities) {
        if (!city.on) continue;
        if (city.status === 'busy') anyBusy = true;
        if (city.status === 'ok' && city.truncated) truncated.push(city.cfg.label);
      }
      if (anyBusy) { setStatus('Loading incidents…', 'busy'); return; }
      const errs = Array.from(state.cities.values()).filter(c => c.on && c.status === 'err');
      if (errs.length) parts.push(errs.map(c => c.cfg.label + ' unavailable').join(', '));
      if (truncated.length) parts.push('capped at ' + CFG.CRIME.maxPerCity.toLocaleString() + ' newest for ' + truncated.join(', '));
      const noC = Array.from(state.cities.values()).reduce((a, c) => a + (c.on ? c.noCoords : 0), 0);
      if (noC) parts.push(noC.toLocaleString() + ' records without a published location excluded');
      setStatus(parts.length ? parts.join(' · ') : 'Loaded', errs.length ? 'err' : 'ok');
    }

    // ---- incident rendering -------------------------------------------------
    function activeIncidents() {
      const out = [];
      for (const [, city] of state.cities) {
        if (!city.on || city.status !== 'ok') continue;
        for (const inc of city.incidents) if (state.catOn.get(inc.catId)) out.push(inc);
      }
      return out;
    }
    function incidentPopup(inc) {
      const city = state.cities.get(inc.cityId);
      const cat = CAT_BY_ID[inc.catId];
      return `<div class="popup-poi"><h3>${U.escapeHTML(inc.offense)}</h3>
        <div class="popup-cat"><span class="cat-dot" style="background:${U.theme.colors().crimeGroups[inc.group]}"></span>
        ${U.escapeHTML(cat.label)}</div>
        ${inc.date ? `<div>${U.escapeHTML(inc.date.toLocaleString())}</div>` : ''}
        ${inc.addr ? `<div>${U.escapeHTML(inc.addr)}</div>` : ''}
        <div class="popup-src">Source: <a href="${U.escapeHTML(city.cfg.link)}" target="_blank" rel="noopener">${U.escapeHTML(city.cfg.label)} open data</a></div></div>`;
    }
    const dotIcons = {};
    function dotIcon(group) {
      const color = U.theme.colors().crimeGroups[group];
      if (!dotIcons[color]) {
        dotIcons[color] = L.divIcon({
          className: 'poi-icon', html: `<span class="crime-dot" style="background:${color}"></span>`,
          iconSize: [12, 12], iconAnchor: [6, 6], popupAnchor: [0, -6]
        });
      }
      return dotIcons[color];
    }
    function renderIncidents() {
      if (!state.enabled) return;
      const incidents = activeIncidents();
      cluster.clearLayers();
      if (heat) { map.removeLayer(heat); heat = null; }
      if (state.mode === 'clusters') {
        if (!map.hasLayer(cluster)) map.addLayer(cluster);
        cluster.addLayers(incidents.map(inc =>
          L.marker([inc.lat, inc.lon], { icon: dotIcon(inc.group), keyboard: false })
            .bindPopup(() => incidentPopup(inc), { maxWidth: 300 })));
      } else {
        if (map.hasLayer(cluster)) map.removeLayer(cluster);
        if (incidents.length) {
          heat = L.heatLayer(incidents.map(i => [i.lat, i.lon, 0.7]), {
            radius: 22, blur: 18, maxZoom: 17, gradient: CFG.PALETTE.heatGradient
          }).addTo(map);
        }
      }
      updateViewCounts();
    }
    function updateViewCounts() {
      if (!state.enabled) return;
      const bounds = map.getBounds();
      const counts = {};
      let total = 0;
      for (const inc of activeIncidents()) {
        if (bounds.contains([inc.lat, inc.lon])) {
          counts[inc.catId] = (counts[inc.catId] || 0) + 1;
          total++;
        }
      }
      for (const c of CFG.CRIME.categories) {
        const elc = document.getElementById('crime-count-' + c.id);
        if (elc) elc.textContent = counts[c.id] ? counts[c.id].toLocaleString() : '';
      }
      totalLine.textContent = total.toLocaleString() + ' incidents in view · last ' + state.range + ' days';
    }

    // ---- events ---------------------------------------------------------
    rangeSel.addEventListener('change', () => {
      state.range = +rangeSel.value;
      for (const [cid, city] of state.cities) {
        city.status = 'idle'; // stale for the new range even while the layer is off
        if (state.enabled && city.on) fetchCity(cid);
      }
      if (state.enabled) renderIncidents();
    });
    modeSel.addEventListener('change', () => { state.mode = modeSel.value; renderIncidents(); });
    map.on('moveend', U.debounce(() => updateViewCounts(), 350));
    U.theme.onChange(() => { if (state.enabled) { renderIncidents(); renderAgencies(); } });

    return {
      id: 'crime',
      get enabled() { return state.enabled; },
      setEnabled(on) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
          refreshAgencies();
          for (const [cid, city] of state.cities) {
            if (city.on && city.status === 'idle') fetchCity(cid);
          }
          renderIncidents();
          updateStatusLine();
        } else {
          cluster.clearLayers();
          if (map.hasLayer(cluster)) map.removeLayer(cluster);
          if (heat) { map.removeLayer(heat); heat = null; }
          agencyLayer.clearLayers();
          if (map.hasLayer(agencyLayer)) map.removeLayer(agencyLayer);
          legendBox.style.display = 'none';
          setStatus('Off');
        }
      }
    };
  };
})();
