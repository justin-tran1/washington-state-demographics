/* Washington Explorer — zoning layer.
 * Zones from the Washington State Zoning Atlas (WA Department of Commerce):
 * every city's zoning districts inside its limits and each county's zoning on
 * its unincorporated land, with the atlas's normalized class and allowed uses.
 * Drawn from zoom 13, fetched per grid cell and kept while in use. A zone's
 * popup gives its code and name, class, allowed uses, development standards,
 * overlays and links to the code. WAMAP.zoning.lookup(lat, lon) answers the
 * zoning at a point for the site evaluation: the city's zone where there is
 * one, the county's as the backup.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;
  const Z = CFG.ZONING;
  const ZONES = Z.service + '/' + Z.layers.zones;
  const OVERLAYS = Z.service + '/' + Z.layers.overlays;
  const JURIS = Z.service + '/' + Z.layers.jurisdictions;
  const esc = U.escapeHTML;

  // ------------------------------------------------------------ classes
  const CAT_BY_CLASS = {};
  for (const c of Z.categories) for (const k of c.classes) CAT_BY_CLASS[k] = c;
  const OTHER = Z.categories.find(c => c.id === 'OTHER');
  const catById = id => Z.categories.find(c => c.id === id) || OTHER;

  /** A zone's map class: the atlas's general class, else inferred from its name. */
  function classify(p) {
    const g = p && p.WAZAZoneGeneral;
    if (g && CAT_BY_CLASS[g]) return { cat: CAT_BY_CLASS[g], inferred: false };
    const text = [p && p.ZoneName, p && p.ZoneID].filter(Boolean).join(' ');
    for (const [re, id] of Z.infer) if (re.test(text)) return { cat: catById(id), inferred: true };
    return { cat: OTHER, inferred: !g };
  }

  // Labels for the atlas's codes, read from the layer's own domains.
  const meta = { general: Object.assign({}, Z.general), specific: {}, promise: null };
  function loadMeta() {
    if (!meta.promise) {
      meta.promise = U.arcgis.layerInfo(ZONES).then(info => {
        for (const f of info.fields || []) {
          const cv = f.domain && f.domain.codedValues;
          if (!cv) continue;
          const m = {};
          for (const c of cv) m[c.code] = c.name;
          if (f.name === 'WAZAZoneGeneral') Object.assign(meta.general, m);
          if (f.name === 'WAZAZoneSpecific') meta.specific = m;
        }
      }).catch(() => { meta.promise = null; });
    }
    return meta.promise;
  }
  const useCode = v => (v && Z.uses[v] ? v : 'U');
  const outlookOf = p => Z.outlook.find(o => o.id === useCode(p && p.UseOffice)) || Z.outlook[Z.outlook.length - 1];
  const isCity = geoid => String(geoid || '').length === 7;

  /**
   * How a zone treats a medical office, from the atlas's office-use code
   * (medical offices fall in the office use class in most codes) and, where
   * that is not recorded, from the zone's class. score: 0-100, or null.
   */
  function medicalOutlook(p) {
    const { cat } = classify(p);
    const office = useCode(p && p.UseOffice), retail = useCode(p && p.UseRetail);
    if (office === 'P') return { score: 100, level: 'good', basis: 'office',
      text: 'Office uses, which in most codes include medical offices and clinics, are permitted outright.' };
    if (office === 'C') return { score: 60, level: 'fair', basis: 'office',
      text: 'Office uses need a conditional use permit here, so a clinic would go through a public review.' };
    if (office === 'LA') return { score: 35, level: 'fair', basis: 'office',
      text: 'Office uses are limited or accessory only here, so a stand-alone clinic may not qualify.' };
    if (office === 'X') {
      return retail === 'P'
        ? { score: 25, level: 'poor', basis: 'office', text: 'Office uses are not permitted. Retail and services are, and some codes class clinics as a service, so check the use table.' }
        : { score: 5, level: 'poor', basis: 'office', text: 'Office uses are not permitted, so a clinic would likely need a rezone or a use-specific approval.' };
    }
    const byCat = { COM: 85, MXU: 85, PUB: 55, IND: 45, MR: 30, RUR: 20, LIR: 10, OS: 0 };
    const s = byCat[cat.id];
    if (s == null) return { score: null, level: 'unknown', basis: 'none', text: 'The atlas records no allowed uses for this zone.' };
    return { score: s, level: s >= 70 ? 'good' : s >= 40 ? 'fair' : 'poor', basis: 'class',
      text: `The atlas does not record whether offices are allowed; ${cat.label.toLowerCase()} zones ${s >= 70 ? 'usually allow' : s >= 40 ? 'sometimes allow' : 'rarely allow'} medical offices.` };
  }

  // ------------------------------------------------------------ geometry
  const D2R = Math.PI / 180, RM = 6371008.8;
  /** Metres from (lat, lon) to the nearest edge of a GeoJSON polygon geometry. */
  function edgeDistanceM(geom, lat, lon) {
    const kx = RM * D2R * Math.cos(lat * D2R), ky = RM * D2R;
    const polys = !geom ? [] : geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    let best = Infinity;
    for (const poly of polys) for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky;
        const bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        let t = l2 ? -(ax * dx + ay * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const x = ax + t * dx, y = ay + t * dy;
        best = Math.min(best, Math.sqrt(x * x + y * y));
      }
    }
    return best;
  }
  function pointQuery(url, lat, lon, extra, signal) {
    return U.arcgis.query(url, Object.assign({
      geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects'
    }, extra), { pageSize: 100, maxFeatures: 100, signal });
  }

  // ------------------------------------------------------------ formatting
  // Atlas sentinels: -9999 = not applicable or unknown, 999 and 9999 = no limit.
  function std(v, unit) {
    if (v == null || v === -9999 || v === '') return null;
    if (v >= 999) return 'no limit';
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) + (unit || '');
  }
  const safeUrl = u => {
    let s = String(u || '').trim();
    if (!s) return null;
    if (/^(codepublishing|library\.municode|www\.)/i.test(s)) s = 'https://' + s;
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) && !/^https?:\/\/\//i.test(s) ? s : null;
  };
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const dateOnly = v => {
    if (v == null || v === '') return null;
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v).length === 10 ? v + 'T12:00:00Z' : v);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  };
  // Cities and towns by name ("Seattle"), counties as the atlas names them
  // ("Unincorporated King County").
  const jurisdictionLabel = p => (p && p.Jurisdiction) || 'Unknown jurisdiction';
  const useIcon = { P: '✓', C: '◐', LA: '◔', X: '✕', U: '?' };
  function useLine(label, code) {
    const c = useCode(code);
    return `<tr><td>${esc(label)}</td><td><span class="z-use z-use-${c.toLowerCase()}">${useIcon[c]} ${esc(Z.uses[c].label)}</span></td></tr>`;
  }

  /** The detail HTML for a zone (popup and site evaluation). */
  function zoneDetailHTML(ctx) {
    const z = ctx.zone || {};
    const { cat, inferred } = classify(z);
    const general = z.WAZAZoneGeneral ? (meta.general[z.WAZAZoneGeneral] || z.WAZAZoneGeneral) : null;
    const specific = z.WAZAZoneSpecific ? (meta.specific[z.WAZAZoneSpecific] || z.WAZAZoneSpecific) : null;
    const med = medicalOutlook(z);
    const rows = [];
    const push = (k, v) => { if (v != null) rows.push(`<tr><td>${esc(k)}</td><td class="num">${esc(v)}</td></tr>`); };
    const h = std(z.DimMaxHeight, ' ft'), hb = std(z.DimBonusMaxHeight, ' ft'), st = std(z.DimMaxStories);
    push('Max height', h ? h + (hb && hb !== h ? ` (${hb} with bonus)` : '') + (st ? `, ${st} stories` : '') : st ? st + ' stories' : null);
    const far = std(z.DimMaxFar), farb = std(z.DimBonusMaxFar);
    push('Max floor area ratio', far ? far + (farb && farb !== far ? ` (${farb} with bonus)` : '') : null);
    push('Max building coverage', std(z.DimMaxLotCoverBuildings, '%'));
    push('Max impervious coverage', std(z.DimMaxLotCoverBuildingsAndImpSu, '%'));
    push('Min lot size', std(z.DenMinLotSizeSqFt, ' sf'));
    const pk = std(z.MinParkingOffice);
    push('Office parking minimum', pk ? (pk === '0' ? 'none' : pk + ' per 1,000 sf') : null);
    const links = [];
    const ref = safeUrl(z.ReferenceURL), code = safeUrl(ctx.jurisdiction && ctx.jurisdiction.CodeURL);
    const map = safeUrl(ctx.jurisdiction && ctx.jurisdiction.ZoningFileURL);
    if (ref) links.push(link(ref, 'Zone chapter'));
    if (code && code !== ref) links.push(link(code, 'Municipal code'));
    if (map) links.push(link(map, 'Zoning map'));
    const overlays = (ctx.overlays || []).filter(o => o.ZoneName || o.ZoneID);
    const normalized = dateOnly(z.WAZASpatialNormalizationDate);
    const backup = ctx.backup ? `<div class="z-note">${esc(jurisdictionLabel(ctx.jurisdiction))} has no zoning in the atlas here, so the county's zoning is shown as the backup.</div>` : '';
    const row = ctx.distanceM > 0 ? `<div class="z-note">The point is in a street right-of-way, which zoning maps leave unzoned; this is the nearest zone, ${Math.round(ctx.distanceM)} m away.</div>` : '';
    return `<div class="z-detail">
      <div class="z-head"><span class="swatch" style="background:${cat.color}"></span><div>
        <div class="z-name">${esc(z.ZoneName || z.ZoneID || 'Zone')}${z.ZoneID && z.ZoneName && z.ZoneID !== z.ZoneName ? ` <span class="z-code">${esc(z.ZoneID)}</span>` : ''}</div>
        <div class="z-sub">${esc(jurisdictionLabel(z))} · ${esc(general || cat.label)}${inferred ? ' (class inferred from the zone name)' : ''}${specific && specific !== general ? ' · ' + esc(specific) : ''}</div></div></div>
      ${backup}${row}
      <div class="z-med z-med-${med.level}"><strong>Medical office:</strong> ${esc(med.text)}</div>
      <table class="z-uses">${useLine('Office', z.UseOffice)}${useLine('Retail & dining', z.UseRetail)}${useLine('Residential', z.UseResidential)}${useLine('Light industrial', z.UseManufacturing)}</table>
      ${rows.length ? `<table class="z-std">${rows.join('')}</table>` : ''}
      ${overlays.length ? `<div class="z-ovl"><strong>Overlays:</strong> ${overlays.map(o => esc(o.ZoneName || o.ZoneID)).join('; ')}</div>` : ''}
      ${z.Info ? `<div class="z-info">${esc(String(z.Info).trim())}</div>` : ''}
      ${links.length ? `<div class="z-links">${links.join(' · ')}</div>` : ''}
      <div class="popup-src">${link(Z.atlasUrl, 'Washington State Zoning Atlas')} (WA Department of Commerce)${normalized ? ' · mapped ' + esc(normalized) : ''} · not an official zoning map; confirm with the jurisdiction</div>
    </div>`;
  }

  /**
   * The zoning at a point: { zone, category, outlook, distanceM, jurisdiction,
   * county, overlays, backup }. The zone containing the point is used, or the
   * nearest within Z.nearM (a pin in a street); a city's zone wins over a
   * county's. zone is null where the atlas has none.
   */
  async function lookup(lat, lon, o = {}) {
    const signal = o.signal;
    loadMeta();
    const [near, jur, ovl] = await Promise.all([
      pointQuery(ZONES, lat, lon, { distance: Z.nearM, units: 'esriSRUnit_Meter', outFields: '*', geometryPrecision: 6 }, signal),
      pointQuery(JURIS, lat, lon, { outFields: 'GEOID,Jurisdiction,COUNTYNAME,CodeURL,ZoningGISURL,ZoningFileURL,ZoneIDField,SpatialSource,WAZACODEADOPTIONDATE', returnGeometry: false }, signal)
        .catch(e => { if (e.name === 'AbortError') throw e; return { features: [] }; }),
      pointQuery(OVERLAYS, lat, lon, { outFields: 'GEOID,Jurisdiction,ZoneID,ZoneName,ReferenceURL,Info', returnGeometry: false }, signal)
        .catch(e => { if (e.name === 'AbortError') throw e; return { features: [] }; })
    ]);
    const juris = jur.features.map(f => f.properties);
    const city = juris.find(j => isCity(j.GEOID)) || null;
    const county = juris.find(j => !isCity(j.GEOID)) || null;
    const cands = near.features.filter(f => f.geometry).map(f => {
      const inside = U.geo.geometryContains(f.geometry, lon, lat);
      return { p: f.properties, geometry: f.geometry, d: inside ? 0 : edgeDistanceM(f.geometry, lat, lon) };
    });
    // City before county; within each, the containing zone, then the nearest.
    const rank = c => (city && c.p.GEOID === city.GEOID ? 0 : isCity(c.p.GEOID) ? 1 : 2);
    cands.sort((a, b) => rank(a) - rank(b) || a.d - b.d);
    const best = cands[0] || null;
    const overlays = ovl.features.map(f => f.properties).filter(p => !best || !p.GEOID || p.GEOID === best.p.GEOID);
    if (!best) return { zone: null, jurisdiction: city || county, county, overlays, backup: false, distanceM: null };
    const { cat, inferred } = classify(best.p);
    return {
      zone: best.p, geometry: best.geometry, category: cat, inferred, outlook: medicalOutlook(best.p),
      distanceM: best.d, jurisdiction: city || county, county, overlays,
      // A county zone standing in for a city the atlas has no zoning for.
      backup: !!(city && !isCity(best.p.GEOID))
    };
  }

  /** The atlas's record for a jurisdiction's zone code (null if it has none). */
  async function zoneByCode(geoid, code, signal) {
    if (!/^\d{5}(\d{2})?$/.test(String(geoid)) || !code) return null;
    const q = String(code).trim().toUpperCase().replace(/'/g, "''");
    const fc = await U.arcgis.query(ZONES, { where: `GEOID='${geoid}' AND UPPER(ZoneID)='${q}'`, outFields: '*', returnGeometry: false },
      { pageSize: 1, maxFeatures: 1, signal });
    return fc.features[0] ? fc.features[0].properties : null;
  }

  // ------------------------------------------------------------ layer
  WAMAP.createZoning = function (opts) {
    const { map, card } = opts;
    const group = L.featureGroup();
    const state = { enabled: false, mode: 'category', opacity: Z.fillOpacity, error: null };
    const cells = new Map();   // key -> { key, lvl, i, j, status, oids, ctl, used }
    const feats = new Map();   // OBJECTID -> { layer, props, lvl, refs }
    let queue = [], active = 0, token = 0;
    let hovered = null;

    // ---- panel UI ---------------------------------------------------------
    const body = card.querySelector('.card-body');
    const modeSel = U.el('select', { class: 'input', 'aria-label': 'Colour zones by' }, [
      U.el('option', { value: 'category', text: 'Colour by zone class' }),
      U.el('option', { value: 'office', text: 'Colour by office & medical use' })
    ]);
    const opacityRow = U.el('div', { class: 'row-inline' }, [
      U.el('label', { class: 'mini-label', text: 'Opacity' }),
      U.el('input', { type: 'range', min: '15', max: '90', value: String(Math.round(Z.fillOpacity * 100)), class: 'slider', 'aria-label': 'Zoning opacity' })
    ]);
    const opacityInput = opacityRow.querySelector('input');
    const hint = U.el('div', { class: 'hint', html:
      'City zoning inside city limits and county zoning elsewhere, from the ' +
      `<a href="${esc(Z.atlasUrl)}" target="_blank" rel="noopener">Washington State Zoning Atlas</a> (WA Commerce). ` +
      'Click a zone for its allowed uses, standards and code links. Not an official zoning map.' });
    const status = U.el('div', { class: 'status-line', text: 'Off' });
    body.append(modeSel, opacityRow, hint, status);
    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }

    const legendBox = U.el('div', { class: 'legend-block', 'data-layer': 'zoning' });
    WAMAP.legendHost.appendChild(legendBox);
    legendBox.style.display = 'none';
    function renderLegend() {
      if (!state.enabled) { legendBox.style.display = 'none'; return; }
      const rows = state.mode === 'office'
        ? Z.outlook.map(o => `<div class="legend-row"><span class="swatch${o.color ? '' : ' swatch-open'}"${o.color ? ` style="background:${o.color}"` : ''}></span><span>${esc(o.label)}</span></div>`).join('')
        : Z.categories.map(c => `<div class="legend-row"><span class="swatch" style="background:${c.color}"></span><span>${esc(c.label)}</span></div>`).join('');
      legendBox.innerHTML = `<div class="legend-title">${state.mode === 'office' ? 'Office & medical use' : 'Zoning'}</div>` +
        `<div class="legend-sub">${state.mode === 'office' ? 'office use class, as the atlas records it' : 'city zoning, county zoning as backup'}</div>` + rows +
        `<div class="legend-src">WA Commerce, Washington State Zoning Atlas · verify with the jurisdiction</div>`;
      legendBox.style.display = '';
    }

    // ---- styling -------------------------------------------------------------
    function styleFor(p) {
      const fine = map.getZoom() >= 15;
      if (state.mode === 'office') {
        const o = outlookOf(p);
        return o.color
          ? { fillColor: o.color, fillOpacity: state.opacity, color: '#ffffff', weight: fine ? 0.9 : 0.5, opacity: 0.75, dashArray: null }
          : { fillColor: '#ffffff', fillOpacity: 0, color: '#7f8480', weight: 1, opacity: 0.9, dashArray: '3 3' };
      }
      return { fillColor: classify(p).cat.color, fillOpacity: state.opacity, color: '#ffffff', weight: fine ? 0.9 : 0.5, opacity: 0.75, dashArray: null };
    }
    function restyleAll() { for (const f of feats.values()) f.layer.setStyle(styleFor(f.props)); }

    function tooltipText(p) {
      const { cat } = classify(p);
      const o = outlookOf(p);
      return `<strong>${esc(p.ZoneID || p.ZoneName || 'Zone')}</strong>${p.ZoneName && p.ZoneName !== p.ZoneID ? ' · ' + esc(p.ZoneName) : ''}` +
        `<br>${esc(cat.label)} · office ${esc(Z.uses[o.id].label.toLowerCase())}<br><span class="z-tip-j">${esc(jurisdictionLabel(p))}</span>`;
    }
    async function openPopup(latlng, p) {
      const popup = L.popup({ maxWidth: 360, minWidth: 280, className: 'z-popup' }).setLatLng(latlng)
        .setContent(zoneDetailHTML({ zone: p }) + '<div class="hint">Loading standards…</div>').openOn(map);
      try {
        const [full, jur, ovl] = await Promise.all([
          U.arcgis.query(ZONES, { where: 'OBJECTID=' + Number(p.OBJECTID), outFields: '*', returnGeometry: false }, { pageSize: 1, maxFeatures: 1 }),
          pointQuery(JURIS, latlng.lat, latlng.lng, { outFields: 'GEOID,Jurisdiction,CodeURL,ZoningFileURL', returnGeometry: false }),
          pointQuery(OVERLAYS, latlng.lat, latlng.lng, { outFields: 'GEOID,ZoneID,ZoneName', returnGeometry: false }),
          loadMeta()
        ]);
        if (!map.hasLayer(popup)) return;
        const zone = (full.features[0] && full.features[0].properties) || p;
        const js = jur.features.map(f => f.properties);
        const jurisdiction = js.find(j => j.GEOID === zone.GEOID) || js.find(j => isCity(j.GEOID)) || js[0] || null;
        popup.setContent(zoneDetailHTML({
          zone, jurisdiction, backup: !isCity(zone.GEOID) && js.some(j => isCity(j.GEOID)),
          overlays: ovl.features.map(f => f.properties).filter(x => !x.GEOID || x.GEOID === zone.GEOID)
        }));
      } catch (e) {
        if (map.hasLayer(popup)) popup.setContent(zoneDetailHTML({ zone: p }) + `<div class="hint">Standards could not be loaded (${esc(e.message)}).</div>`);
      }
    }

    // ---- cells -------------------------------------------------------------
    const levelFor = z => (z >= 15 ? 'f' : 'c');
    function wantedCells(lvl) {
      const b = map.getBounds().pad(0.1);
      const [dx, dy] = Z.cellDeg;
      const c = map.getCenter();
      const out = [];
      for (let i = Math.floor(b.getWest() / dx); i <= Math.floor(b.getEast() / dx); i++) {
        for (let j = Math.floor(b.getSouth() / dy); j <= Math.floor(b.getNorth() / dy); j++) {
          const cx = (i + 0.5) * dx, cy = (j + 0.5) * dy;
          out.push({ key: `${lvl}:${i}:${j}`, lvl, i, j, d: (cx - c.lng) ** 2 + ((cy - c.lat) * 1.4) ** 2 });
        }
      }
      return out.sort((a, b2) => a.d - b2.d);
    }
    function addFeature(f, cell) {
      const p = f.properties || {};
      const oid = p.OBJECTID;
      if (oid == null || !f.geometry) return;
      const have = feats.get(oid);
      cell.oids.push(oid);
      // Keep the most detailed copy: a fine answer replaces a coarse one.
      if (have && (have.lvl === 'f' || have.lvl === cell.lvl)) { have.refs++; return; }
      let layer;
      try { layer = L.GeoJSON.geometryToLayer(f); } catch (e) { cell.oids.pop(); return; }
      layer.setStyle(styleFor(p));
      layer.bindTooltip(() => tooltipText(p), { sticky: true, direction: 'top', opacity: 0.95 });
      layer.on('mouseover', () => { hovered = layer; layer.setStyle({ weight: 2.5, color: U.theme.colors().hoverOutline, opacity: 1 }); });
      layer.on('mouseout', () => { if (hovered === layer) hovered = null; layer.setStyle(styleFor(p)); });
      layer.on('click', e => {
        if (WAMAP.modes && WAMAP.modes.active) return; // a map tool is waiting for this click
        openPopup(e.latlng, p);
      });
      if (have) { group.removeLayer(have.layer); have.layer = layer; have.lvl = cell.lvl; have.props = p; have.refs++; }
      else feats.set(oid, { layer, props: p, lvl: cell.lvl, refs: 1 });
      group.addLayer(layer);
    }
    function dropCell(cell) {
      if (cell.ctl) cell.ctl.abort();
      for (const oid of cell.oids) {
        const f = feats.get(oid);
        if (f && --f.refs <= 0) { group.removeLayer(f.layer); feats.delete(oid); }
      }
      cells.delete(cell.key);
    }
    function evict(keep) {
      if (cells.size <= Z.maxCells) return;
      const old = Array.from(cells.values()).filter(c => !keep.has(c.key) && c.status !== 'loading').sort((a, b) => a.used - b.used);
      while (cells.size > Z.maxCells && old.length) dropCell(old.shift());
    }
    async function fetchCell(cell) {
      const [dx, dy] = Z.cellDeg;
      const w = cell.i * dx, s = cell.j * dy;
      cell.ctl = new AbortController();
      const fc = await U.arcgis.query(ZONES, {
        geometry: [w, s, w + dx, s + dy].map(v => v.toFixed(6)).join(','), geometryType: 'esriGeometryEnvelope', inSR: 4326,
        spatialRel: 'esriSpatialRelIntersects', outFields: Z.fields, geometryPrecision: cell.lvl === 'f' ? 6 : 5,
        maxAllowableOffset: cell.lvl === 'f' ? Z.offset.fine : Z.offset.coarse
      }, { pageSize: 2000, maxFeatures: 12000, signal: cell.ctl.signal });
      cell.ctl = null;
      return fc.features;
    }
    function pump() {
      while (active < Z.concurrency && queue.length) {
        const cell = queue.shift();
        if (!cells.has(cell.key)) continue;
        active++;
        const my = token;
        fetchCell(cell).then(features => {
          if (!cells.has(cell.key) || my !== token) return;
          for (const f of features) addFeature(f, cell);
          cell.status = 'ok';
          group.bringToBack();
          state.error = null;
        }).catch(e => {
          if (e.name === 'AbortError') return;
          cell.status = 'err';
          state.error = e.message;
        }).finally(() => { active--; pump(); report(); });
      }
      report();
    }
    function report() {
      if (!state.enabled) return;
      if (map.getZoom() < Z.minZoom) { setStatus(`Zoom in to see zoning (zoom ${Z.minZoom}+).`); return; }
      const want = wantedCells(levelFor(map.getZoom()));
      const mine = want.map(w => cells.get(w.key)).filter(Boolean);
      const loading = mine.filter(c => c.status === 'loading').length;
      const failed = mine.filter(c => c.status === 'err').length;
      if (loading) { setStatus(`Loading zoning… ${mine.length - loading} of ${mine.length} areas`, 'busy'); return; }
      const b = map.getBounds();
      const names = new Map();
      let n = 0;
      for (const f of feats.values()) {
        const ll = f.layer.getBounds && f.layer.getBounds();
        if (!ll || !b.intersects(ll)) continue;
        n++;
        names.set(f.props.Jurisdiction, (names.get(f.props.Jurisdiction) || 0) + 1);
      }
      const top = Array.from(names.entries()).sort((a, c) => c[1] - a[1]).map(x => x[0]).filter(Boolean);
      const where = top.slice(0, 3).join(', ') + (top.length > 3 ? ` and ${top.length - 3} more` : '');
      if (failed) setStatus(`Zoning could not be loaded for ${failed} of ${mine.length} areas (${state.error || 'service error'}).`, 'err');
      else setStatus(n ? `${n.toLocaleString('en-US')} zones in view · ${where}` : 'No zoning mapped in view.', n ? 'ok' : '');
    }
    function refresh() {
      if (!state.enabled) return;
      const z = map.getZoom();
      if (z < Z.minZoom) {
        if (map.hasLayer(group)) map.removeLayer(group);
        token++;
        for (const c of cells.values()) if (c.status === 'loading') dropCell(c);
        queue = [];
        report();
        return;
      }
      if (!map.hasLayer(group)) map.addLayer(group);
      const want = wantedCells(levelFor(z));
      const keep = new Set(want.map(w => w.key));
      // Queued or loading cells that left the view stop.
      for (const c of Array.from(cells.values())) if (c.status === 'loading' && !keep.has(c.key)) dropCell(c);
      queue = queue.filter(c => keep.has(c.key));
      const now = Date.now();
      for (const w of want) {
        const have = cells.get(w.key);
        if (have) { have.used = now; if (have.status === 'err') { have.status = 'loading'; have.oids = []; queue.push(have); } continue; }
        const cell = { key: w.key, lvl: w.lvl, i: w.i, j: w.j, status: 'loading', oids: [], ctl: null, used: now };
        cells.set(cell.key, cell);
        queue.push(cell);
      }
      evict(keep);
      pump();
    }
    const onMove = U.debounce(refresh, 250);
    map.on('moveend', onMove);
    map.on('zoomend', () => { if (state.enabled) restyleAll(); });

    modeSel.addEventListener('change', () => { state.mode = modeSel.value; restyleAll(); renderLegend(); });
    opacityInput.addEventListener('input', () => { state.opacity = opacityInput.value / 100; restyleAll(); });
    U.theme.onChange(() => { if (state.enabled) restyleAll(); });

    const api = {
      id: 'zoning',
      lookup,
      zoneDetailHTML,
      classify,
      medicalOutlook,
      get mode() { return state.mode; },
      setMode(m) {
        if (m !== 'office' && m !== 'category') return;
        state.mode = m; modeSel.value = m; restyleAll(); renderLegend();
      },
      get enabled() { return state.enabled; },
      onForcedOff: null,
      setEnabled(on, silent) {
        if (on === state.enabled) return;
        state.enabled = on;
        if (on) {
          if (!silent && WAMAP.areaLayerCoordinator) WAMAP.areaLayerCoordinator.activate(api);
          loadMeta();
          renderLegend();
          refresh();
        } else {
          token++;
          queue = [];
          for (const c of Array.from(cells.values())) if (c.status === 'loading') dropCell(c);
          if (map.hasLayer(group)) map.removeLayer(group);
          legendBox.style.display = 'none';
          setStatus('Off');
        }
      },
      /** Zones currently drawn (used by the smoke test). */
      drawn() {
        return Array.from(feats.values()).map(f => ({ oid: f.props.OBJECTID, zone: f.props.ZoneID, cat: classify(f.props).cat.id, lvl: f.lvl,
          fill: f.layer.options.fillColor, fillOpacity: f.layer.options.fillOpacity, dash: f.layer.options.dashArray || null }));
      }
    };
    if (WAMAP.areaLayerCoordinator) WAMAP.areaLayerCoordinator.register(api);
    WAMAP.zoning = api;
    return api;
  };
  // The lookup works whether or not the layer was created (site evaluation).
  WAMAP.zoningLookup = lookup;
  WAMAP.zoningDetailHTML = zoneDetailHTML;
  WAMAP.zoningByCode = zoneByCode;
  WAMAP.zoningOutlook = medicalOutlook;
})();
