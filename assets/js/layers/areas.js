/* Washington Explorer — radius & area search.
 * A circle around a dropped pin, or a polygon drawn anywhere on the map,
 * lists every amenity (the statewide files the amenities layer uses) and
 * every transit stop and route (live WSDOT GTFS, OpenStreetMap fallback)
 * inside the shape or touching its edge. Circles resize by dragging their
 * handle or typing a radius; polygons are reshaped by dragging corners.
 * Colour, opacity and outline are set per shape. Shapes are kept in this
 * browser (localStorage), like pins.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;
  const A = CFG.AREAS;

  // ------------------------------------------------------------ geometry
  // Distances are great-circle distances on the mean Earth sphere. Polygon
  // edges are straight lines on the Web Mercator map, so containment is
  // tested in Mercator metres: the list matches the shape as drawn.
  const R = 6371008.8, RM = 6378137, D2R = Math.PI / 180;
  // A point within half a metre of the edge touches it: amenity coordinates
  // are published to about a metre, so "exactly on the line" needs a margin.
  const EDGE_M = 0.5;
  const geom = {
    EDGE_M,
    distance(lat1, lon1, lat2, lon2) {
      const s1 = Math.sin((lat2 - lat1) * D2R / 2), s2 = Math.sin((lon2 - lon1) * D2R / 2);
      const a = s1 * s1 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * s2 * s2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    },
    bearing(lat1, lon1, lat2, lon2) {
      const f1 = lat1 * D2R, f2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
      const y = Math.sin(dl) * Math.cos(f2);
      const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
      return (Math.atan2(y, x) / D2R + 360) % 360;
    },
    /** [lat, lon] reached from (lat, lon) after `dist` metres on `bearingDeg`. */
    destination(lat, lon, bearingDeg, dist) {
      const d = dist / R, b = bearingDeg * D2R, f1 = lat * D2R, l1 = lon * D2R;
      const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(b));
      const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
      return [f2 / D2R, ((l2 / D2R + 540) % 360) - 180];
    },
    mx: lon => RM * lon * D2R,
    my: lat => RM * Math.log(Math.tan(Math.PI / 4 + Math.max(-85.0511, Math.min(85.0511, lat)) * D2R / 2)),
    /** Squared distance from (px, py) to the segment (ax, ay)-(bx, by). */
    segDist2(px, py, ax, ay, bx, by) {
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const x = ax + t * dx - px, y = ay + t * dy - py;
      return x * x + y * y;
    },
    /** Do the segments AB and CD share at least one point? */
    segsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
      const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
      const on = (px, py, qx, qy, rx, ry) => Math.min(px, qx) <= rx && rx <= Math.max(px, qx) &&
        Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
      const o1 = o(ax, ay, bx, by, cx, cy), o2 = o(ax, ay, bx, by, dx, dy);
      const o3 = o(cx, cy, dx, dy, ax, ay), o4 = o(cx, cy, dx, dy, bx, by);
      if (o1 !== o2 && o3 !== o4) return true;
      return (o1 === 0 && on(ax, ay, bx, by, cx, cy)) || (o2 === 0 && on(ax, ay, bx, by, dx, dy)) ||
        (o3 === 0 && on(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && on(cx, cy, dx, dy, bx, by));
    },
    /** Even-odd containment in a closed ring given as coordinate arrays. */
    ringContains(xs, ys, x, y) {
      let inside = false;
      for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
        if (((ys[i] > y) !== (ys[j] > y)) && (x < (xs[j] - xs[i]) * (y - ys[i]) / (ys[j] - ys[i]) + xs[i])) inside = !inside;
      }
      return inside;
    },
    /** Geodesic area (m²) of a ring of [lat, lon] (spherical excess approximation). */
    ringAreaM2(pts) {
      let s = 0;
      for (let i = 0, n = pts.length; i < n; i++) {
        const [y1, x1] = pts[i], [y2, x2] = pts[(i + 1) % n];
        s += (x2 - x1) * D2R * (2 + Math.sin(y1 * D2R) + Math.sin(y2 * D2R));
      }
      return Math.abs(s * R * R / 2);
    },
    perimeterM(pts) {
      let s = 0;
      for (let i = 0, n = pts.length; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        s += geom.distance(a[0], a[1], b[0], b[1]);
      }
      return s;
    },
    /**
     * Membership tests for a shape given as { type: 'circle', lat, lon, radius }
     * or { type: 'polygon', pts: [[lat, lon], ...] }:
     *   s, w, n, e      bounds, for a cheap first cut;
     *   point(lat, lon) metres from the circle's centre (0 for a polygon) when
     *                   the point is inside or on the edge, otherwise -1;
     *   line(coords)    whether a polyline ([[lon, lat], ...]) enters or
     *                   touches the shape.
     */
    tester(shape) {
      if (shape.type === 'circle') {
        const lat0 = shape.lat, lon0 = shape.lon, r = shape.radius + EDGE_M, r2 = r * r;
        const dLat = r / R / D2R * 1.001;
        const dLon = Math.asin(Math.min(1, Math.sin(r / R) / Math.max(1e-6, Math.cos(lat0 * D2R)))) / D2R * 1.001;
        // Local plane (east/north metres) for the line test: accurate to a
        // fraction of a percent at the radii this tool allows.
        const kx = R * D2R * Math.cos(lat0 * D2R), ky = R * D2R;
        return {
          s: lat0 - dLat, n: lat0 + dLat, w: lon0 - dLon, e: lon0 + dLon,
          point(lat, lon) {
            if (lat < this.s || lat > this.n || lon < this.w || lon > this.e) return -1;
            const d = geom.distance(lat0, lon0, lat, lon);
            return d <= r ? d : -1;
          },
          line(coords) {
            let px = 0, py = 0;
            for (let i = 0; i < coords.length; i++) {
              const x = (coords[i][0] - lon0) * kx, y = (coords[i][1] - lat0) * ky;
              if (x * x + y * y <= r2) return true;
              if (i > 0 && geom.segDist2(0, 0, px, py, x, y) <= r2) return true;
              px = x; py = y;
            }
            return false;
          }
        };
      }
      const pts = shape.pts, n = pts.length;
      const xs = new Float64Array(n), ys = new Float64Array(n);
      let s = 90, no = -90, w = 180, e = -180;
      for (let i = 0; i < n; i++) {
        const [la, lo] = pts[i];
        xs[i] = geom.mx(lo); ys[i] = geom.my(la);
        if (la < s) s = la; if (la > no) no = la; if (lo < w) w = lo; if (lo > e) e = lo;
      }
      // Mercator stretches ground distances by 1 / cos(latitude).
      const tol = EDGE_M / Math.cos((s + no) / 2 * D2R), tol2 = tol * tol;
      const mS = geom.my(s) - tol, mN = geom.my(no) + tol, mW = geom.mx(w) - tol, mE = geom.mx(e) + tol;
      const insideXY = (x, y) => {
        if (x < mW || x > mE || y < mS || y > mN) return false;
        if (geom.ringContains(xs, ys, x, y)) return true;
        for (let i = 0, j = n - 1; i < n; j = i++) if (geom.segDist2(x, y, xs[j], ys[j], xs[i], ys[i]) <= tol2) return true;
        return false;
      };
      const pad = tol / (RM * D2R) * 2; // the tolerance in degrees, generously
      return {
        s: s - pad, n: no + pad, w: w - pad, e: e + pad,
        point(lat, lon) {
          if (lat < this.s || lat > this.n || lon < this.w || lon > this.e) return -1;
          return insideXY(geom.mx(lon), geom.my(lat)) ? 0 : -1;
        },
        line(coords) {
          let px = 0, py = 0;
          for (let k = 0; k < coords.length; k++) {
            const x = geom.mx(coords[k][0]), y = geom.my(coords[k][1]);
            if (insideXY(x, y)) return true;
            if (k > 0 && !(Math.max(px, x) < mW || Math.min(px, x) > mE || Math.max(py, y) < mS || Math.min(py, y) > mN)) {
              for (let i = 0, j = n - 1; i < n; j = i++) {
                if (geom.segsIntersect(px, py, x, y, xs[j], ys[j], xs[i], ys[i])) return true;
              }
            }
            px = x; py = y;
          }
          return false;
        }
      };
    }
  };
  WAMAP.areaGeom = geom;

  // ------------------------------------------------------------ formatting
  const unitOf = key => A.units[key] || A.units[A.defaultUnit];
  function fmtDist(m, unit) {
    const u = unitOf(unit);
    const v = m / u.m;
    const digits = u.m < 100 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
    return v.toLocaleString('en-US', { maximumFractionDigits: digits }) + ' ' + u.label;
  }
  function fmtArea(m2, unit) {
    if (unit === 'km' || unit === 'm') {
      const km2 = m2 / 1e6;
      return km2 < 1 ? Math.round(m2 / 1e4).toLocaleString('en-US') + ' ha' : km2.toLocaleString('en-US', { maximumFractionDigits: km2 < 10 ? 2 : 1 }) + ' km²';
    }
    const sqmi = m2 * CFG.SQMI_PER_SQM;
    if (sqmi < 1) return sqmi.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' sq mi (' + Math.round(m2 / 4046.8564224).toLocaleString('en-US') + ' acres)';
    return sqmi.toLocaleString('en-US', { maximumFractionDigits: sqmi < 10 ? 2 : 1 }) + ' sq mi';
  }
  const plural = (n, one, many) => n.toLocaleString('en-US') + ' ' + (n === 1 ? one : many);
  const DASH = { solid: null, dashed: '10 7', dotted: '1 7' };

  WAMAP.createAreas = function (opts) {
    const { map, card, amenities, transit } = opts;
    // Handles sit above the POI markers (600), below tooltips and popups.
    map.createPane('areaHandles');
    map.getPane('areaHandles').style.zIndex = 640;
    const shapeGroup = L.layerGroup();   // the shapes: shared canvas, not interactive
    const handleGroup = L.layerGroup();  // resize handles, corners, labels
    const shapes = [];
    let enabled = false;
    let colorSeq = 0, areaSeq = 0;
    const accent = () => (U.theme.isDark() ? CFG.PALETTE.brand.accentGreen : CFG.PALETTE.brand.green);

    // ---- panel UI -------------------------------------------------------
    const body = card.querySelector('.card-body');
    const toggle = card.querySelector('.card-toggle input');
    const drawBtn = U.el('button', { class: 'btn', type: 'button', id: 'area-draw-btn', text: '⬠ Draw an area' });
    const pinModeBtn = U.el('button', { class: 'btn ghost', type: 'button', text: '📌 Drop a pin' });
    const hint = U.el('div', { class: 'hint', html:
      'Drop a pin and choose <strong>⭕ Radius search</strong> in its popup, or draw an area. Places and transit ' +
      'inside a shape or touching its edge are listed below. Shapes are saved in this browser.' });
    const status = U.el('div', { class: 'status-line' });
    const listEl = U.el('div', { class: 'area-list' });
    const empty = U.el('div', { class: 'hint area-empty', text: 'No shapes yet.' });
    body.append(U.el('div', { class: 'row-inline area-actions' }, [drawBtn, pinModeBtn]), hint, status, empty, listEl);
    function setStatus(text, kind) {
      status.textContent = text || '';
      status.className = 'status-line' + (kind ? ' ' + kind : '');
    }
    const drawButtons = () => [drawBtn, document.getElementById('draw-area-btn')].filter(Boolean);
    const isNarrow = () => window.innerWidth < 900;
    const sidebar = () => document.getElementById('sidebar');
    function closeSidebarOnNarrow() { if (isNarrow() && sidebar()) sidebar().classList.remove('open'); }

    // ---- places (amenity files) ------------------------------------------
    const places = { cats: null, promise: null, failed: [] };
    function ensurePlaces() {
      if (!places.promise) {
        setStatus('Loading places for the search…', 'busy');
        places.promise = amenities.loadData().then(list => {
          places.failed = list.filter(x => x.error);
          places.cats = list.filter(x => x.d).map(x => {
            const n = x.d.rows.length, lat = new Float64Array(n), lon = new Float64Array(n);
            for (let i = 0; i < n; i++) { const r = x.d.rows[i]; lat[i] = +r[x.F.lat]; lon[i] = +r[x.F.lon]; }
            return Object.assign({}, x, { lat, lon });
          });
          if (places.failed.length === list.length) places.promise = null; // retried with the next shape
          setStatus(places.failed.length
            ? 'Some place files could not load: ' + places.failed.map(f => f.cfg.label).join(', ') + '.'
            : '', places.failed.length ? 'err' : '');
          for (const s of shapes) finalUpdate(s, { transit: false });
        });
      }
      return places.promise;
    }

    // ---- shape model ------------------------------------------------------
    const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const clampR = r => Math.min(A.maxRadiusM, Math.max(A.minRadiusM, r));
    const pinOf = s => (WAMAP.pins ? WAMAP.pins.get(s.pinId) : null);
    function titleOf(s) {
      if (s.named && s.name) return s.name;
      if (s.type === 'circle') {
        const pin = pinOf(s);
        return fmtDist(s.radius, s.unit) + ' around ' + ((pin && pin.label) || 'pin');
      }
      return s.defaultName || 'Area';
    }
    function testShape(s) {
      return s.type === 'circle' ? { type: 'circle', lat: s.lat, lon: s.lon, radius: s.radius } : { type: 'polygon', pts: s.pts };
    }
    function boundsOf(s) {
      const t = geom.tester(testShape(s));
      return L.latLngBounds([t.s, t.w], [t.n, t.e]);
    }
    function pathStyle(s) {
      const st = s.style;
      return {
        color: st.color, weight: st.weight, opacity: st.opacity, fillColor: st.color, fillOpacity: st.fillOpacity,
        dashArray: DASH[st.dash] || null, lineCap: 'round', interactive: false
      };
    }
    function newStyle(color) {
      return { color: color || A.colors[colorSeq++ % A.colors.length], fillOpacity: A.fillOpacity, opacity: 0.95, weight: A.weight, dash: 'solid' };
    }

    // ---- map objects --------------------------------------------------------
    const handlePos = s => geom.destination(s.lat, s.lon, s.bearing, s.radius);
    function handleIcon(s) {
      return L.divIcon({
        className: 'area-handle-icon',
        html: `<span class="area-handle" style="border-color:${s.style.color}"></span><span class="area-handle-label">${U.escapeHTML(fmtDist(s.radius, s.unit))}</span>`,
        iconSize: [16, 16], iconAnchor: [8, 8]
      });
    }
    function labelIcon(s) {
      return L.divIcon({
        className: 'area-label-icon',
        html: `<span class="area-label" style="border-color:${s.style.color}">${U.escapeHTML(labelText(s))}</span>`,
        iconSize: null, iconAnchor: [0, 0]
      });
    }
    function labelText(s) {
      const c = counts(s);
      return titleOf(s) + (c.places != null ? ' · ' + (c.places + (c.stops || 0)).toLocaleString('en-US') : '');
    }
    function centroid(s) {
      // Area-weighted centroid in Mercator; the vertex average if that falls outside.
      const P = s.pts.map(([la, lo]) => [geom.mx(lo), geom.my(la)]);
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, n = P.length; i < n; i++) {
        const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % n], f = x1 * y2 - x2 * y1;
        a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
      }
      let ll;
      if (Math.abs(a) > 1e-9) {
        ll = L.CRS.EPSG3857.unproject(L.point(cx / (3 * a), cy / (3 * a)));
        if (geom.tester(testShape(s)).point(ll.lat, ll.lng) < 0) ll = null;
      }
      if (!ll) ll = L.latLng(s.pts.reduce((t, p) => t + p[0], 0) / s.pts.length, s.pts.reduce((t, p) => t + p[1], 0) / s.pts.length);
      return ll;
    }
    function midpoint(a, b) {
      const pa = L.CRS.EPSG3857.project(L.latLng(a[0], a[1])), pb = L.CRS.EPSG3857.project(L.latLng(b[0], b[1]));
      return L.CRS.EPSG3857.unproject(pa.add(pb).divideBy(2));
    }

    function build(s) {
      if (s.type === 'circle') {
        s.layer = L.circle([s.lat, s.lon], Object.assign({ radius: s.radius }, pathStyle(s)));
        s.handle = L.marker(handlePos(s), {
          draggable: true, pane: 'areaHandles', icon: handleIcon(s), keyboard: false, autoPan: true,
          title: 'Drag to resize'
        });
        s.handle.on('drag', () => onResizeDrag(s));
        s.handle.on('dragend', () => { s.handle.setLatLng(handlePos(s)); finalUpdate(s); });
        s.handle.on('click', () => focusEntry(s));
      } else {
        s.layer = L.polygon(s.pts, pathStyle(s));
        s.vertices = []; s.mids = [];
        s.label = L.marker(centroid(s), { pane: 'areaHandles', icon: labelIcon(s), keyboard: false, draggable: !!s.editing, autoPan: true });
        s.label.on('click', () => focusEntry(s));
        s.label.on('dragstart', () => {
          s._moveFrom = L.CRS.EPSG3857.project(s.label.getLatLng());
          s._movePts = s.pts.map(p => L.CRS.EPSG3857.project(L.latLng(p[0], p[1])));
        });
        s.label.on('drag', () => {
          const d = L.CRS.EPSG3857.project(s.label.getLatLng()).subtract(s._moveFrom);
          s.pts = s._movePts.map(p => { const ll = L.CRS.EPSG3857.unproject(p.add(d)); return [ll.lat, ll.lng]; });
          s.layer.setLatLngs(s.pts);
          placeCorners(s);
          liveUpdate(s);
        });
        s.label.on('dragend', () => { s.label.setLatLng(centroid(s)); finalUpdate(s); });
      }
    }
    function mapLayersOf(s) {
      return [s.layer, s.handle, s.label].concat(s.vertices || [], s.mids || []).filter(Boolean);
    }
    function applyVisibility(s) {
      const show = enabled && s.visible;
      for (const l of [s.layer]) { if (show) shapeGroup.addLayer(l); else shapeGroup.removeLayer(l); }
      for (const l of [s.handle, s.label]) { if (!l) continue; if (show) handleGroup.addLayer(l); else handleGroup.removeLayer(l); }
      if (s.type === 'polygon') rebuildCorners(s);
    }
    function restyle(s) {
      s.layer.setStyle(pathStyle(s));
      if (s.handle) s.handle.setIcon(handleIcon(s));
      if (s.label) s.label.setIcon(labelIcon(s));
      if (s.type === 'polygon') rebuildCorners(s);
      s.el.swatch.style.background = s.style.color;
    }

    // ---- circle resizing --------------------------------------------------
    function onResizeDrag(s) {
      const ll = s.handle.getLatLng();
      s.radius = clampR(geom.distance(s.lat, s.lon, ll.lat, ll.lng));
      s.bearing = geom.bearing(s.lat, s.lon, ll.lat, ll.lng);
      s.layer.setRadius(s.radius);
      setHandleText(s);
      syncRadiusInput(s);
      liveUpdate(s);
    }
    function setHandleText(s) {
      const el = s.handle && s.handle.getElement && s.handle.getElement();
      const lab = el && el.querySelector('.area-handle-label');
      if (lab) lab.textContent = fmtDist(s.radius, s.unit);
    }
    function setRadius(s, r) {
      s.radius = clampR(r);
      s.layer.setRadius(s.radius);
      s.handle.setLatLng(handlePos(s));
      setHandleText(s);
      finalUpdate(s);
    }

    // ---- polygon reshaping ------------------------------------------------
    function cornerIcon(s, mid) {
      return L.divIcon({
        className: 'area-vertex-icon',
        html: `<span class="${mid ? 'area-mid' : 'area-vertex'}" style="border-color:${s.style.color}"></span>`,
        iconSize: mid ? [12, 12] : [14, 14], iconAnchor: mid ? [6, 6] : [7, 7]
      });
    }
    function rebuildCorners(s) {
      for (const m of s.vertices.concat(s.mids)) handleGroup.removeLayer(m);
      s.vertices = []; s.mids = [];
      if (!s.editing || !s.visible || !enabled) return;
      s.pts.forEach((p, i) => {
        const m = L.marker(p, { draggable: true, pane: 'areaHandles', icon: cornerIcon(s, false), keyboard: false, autoPan: true,
          title: 'Drag to reshape · right-click or double-click to remove this corner' });
        m.on('drag', () => {
          const ll = m.getLatLng();
          s.pts[i] = [ll.lat, ll.lng];
          s.layer.setLatLngs(s.pts);
          placeMids(s);
          liveUpdate(s);
        });
        m.on('dragend', () => finalUpdate(s));
        m.on('contextmenu dblclick', e => {
          if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
          removeCorner(s, i);
        });
        handleGroup.addLayer(m);
        s.vertices.push(m);
      });
      s.pts.forEach((p, i) => {
        const m = L.marker(midpoint(p, s.pts[(i + 1) % s.pts.length]), { draggable: true, pane: 'areaHandles',
          icon: cornerIcon(s, true), keyboard: false, autoPan: true, title: 'Drag to add a corner' });
        m.on('dragstart', () => { const ll = m.getLatLng(); s.pts.splice(i + 1, 0, [ll.lat, ll.lng]); });
        m.on('drag', () => {
          const ll = m.getLatLng();
          s.pts[i + 1] = [ll.lat, ll.lng];
          s.layer.setLatLngs(s.pts);
          liveUpdate(s);
        });
        m.on('dragend', () => finalUpdate(s));
        handleGroup.addLayer(m);
        s.mids.push(m);
      });
    }
    function placeMids(s) {
      s.mids.forEach((m, i) => m.setLatLng(midpoint(s.pts[i], s.pts[(i + 1) % s.pts.length])));
      if (s.label) s.label.setLatLng(centroid(s));
    }
    function placeCorners(s) {
      s.vertices.forEach((m, i) => m.setLatLng(s.pts[i]));
      s.mids.forEach((m, i) => m.setLatLng(midpoint(s.pts[i], s.pts[(i + 1) % s.pts.length])));
    }
    function removeCorner(s, i) {
      if (s.pts.length <= 3) { WAMAP.toast('An area needs at least three corners.', 'warning'); return; }
      s.pts.splice(i, 1);
      s.layer.setLatLngs(s.pts);
      finalUpdate(s);
    }
    function setEditing(s, on) {
      if (s.type !== 'polygon') return;
      if (on) for (const o of shapes) if (o !== s && o.editing) setEditing(o, false);
      s.editing = on;
      s.label.options.draggable = on;
      if (s.label.dragging) { if (on) s.label.dragging.enable(); else s.label.dragging.disable(); }
      rebuildCorners(s);
      if (s.el) {
        s.el.editBtn.textContent = on ? '✓' : '✏️';
        s.el.editBtn.title = on ? 'Done reshaping' : 'Reshape on the map';
        s.el.editBtn.setAttribute('aria-pressed', String(on));
        s.el.editHint.style.display = on ? '' : 'none';
      }
    }

    // ---- results ------------------------------------------------------------
    function computePlaces(s) {
      if (!places.cats) { s.res.places = null; return; }
      const t = geom.tester(testShape(s));
      s.res.places = places.cats.map(c => {
        const items = [];
        const lat = c.lat, lon = c.lon;
        for (let i = 0; i < lat.length; i++) {
          const la = lat[i], lo = lon[i];
          if (la < t.s || la > t.n || lo < t.w || lo > t.e) continue;
          const d = t.point(la, lo);
          if (d >= 0) items.push({ i, d });
        }
        return { c, items };
      });
    }
    function routeBox(r) {
      if (!r._bb) {
        let w = 180, s = 90, e = -180, n = -90;
        for (const line of r.lines) for (const [lo, la] of line) {
          if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > n) n = la;
        }
        r._bb = [w, s, e, n];
      }
      return r._bb;
    }
    function filterTransit(s) {
      if (!s.tq) { s.res.stops = null; s.res.routes = null; return; }
      const t = geom.tester(testShape(s));
      const stops = [];
      for (const st of s.tq.res.stops) {
        const d = t.point(st.lat, st.lon);
        if (d >= 0) stops.push({ st, d });
      }
      const seen = new Map();
      for (const r of s.tq.res.routes) {
        const [w, so, e, n] = routeBox(r);
        if (e < t.w || w > t.e || n < t.s || so > t.n) continue;
        if (seen.has(r.key)) { seen.get(r.key).parts.push(r); continue; }
        if (r.lines.some(line => t.line(line))) seen.set(r.key, { r, parts: [r] });
      }
      s.res.stops = stops;
      s.res.routes = Array.from(seen.values());
    }
    function counts(s) {
      const c = { places: null, byCat: {}, stops: null, routes: null };
      if (s.res.places) {
        c.places = 0;
        for (const g of s.res.places) { c.byCat[g.c.id] = g.items.length; c.places += g.items.length; }
      }
      if (s.res.stops) c.stops = s.res.stops.length;
      if (s.res.routes) c.routes = s.res.routes.length;
      return c;
    }
    function countsText(s) {
      const c = counts(s);
      const parts = [];
      parts.push(c.places == null ? 'places loading…' : plural(c.places, 'place', 'places'));
      if (s.transitState === 'loading' && c.stops == null) parts.push('transit loading…');
      else if (s.transitState === 'err' && c.stops == null) parts.push('transit unavailable');
      else if (c.stops != null) parts.push(plural(c.stops, 'stop', 'stops'), plural(c.routes, 'route', 'routes'));
      return parts.join(' · ');
    }

    // ---- live / final updates ---------------------------------------------
    // While a handle is dragged only the counts follow, once per frame; the
    // lists, the saved copy and the transit query wait for the drop.
    function liveUpdate(s) {
      if (s._raf) return;
      s._raf = requestAnimationFrame(() => {
        s._raf = 0;
        computePlaces(s); filterTransit(s);
        renderHead(s); renderSummary(s); renderGeometry(s);
        setLabelText(s);
      });
    }
    function finalUpdate(s, o) {
      if (!shapes.includes(s)) return;
      if (s._raf) { cancelAnimationFrame(s._raf); s._raf = 0; }
      if (s.type === 'polygon') { rebuildCorners(s); if (s.label) s.label.setLatLng(centroid(s)); }
      computePlaces(s); filterTransit(s);
      renderHead(s); renderGeometry(s); renderSummary(s); renderResults(s);
      setLabelText(s);
      save();
      if (!o || o.transit !== false) scheduleTransit(s);
    }
    function setLabelText(s) {
      if (!s.label) return;
      const el = s.label.getElement && s.label.getElement();
      const lab = el && el.querySelector('.area-label');
      if (lab) lab.textContent = labelText(s);
    }

    // ---- transit -------------------------------------------------------------
    function scheduleTransit(s) {
      clearTimeout(s._tq);
      s._tq = setTimeout(() => refreshTransit(s), 350);
    }
    async function refreshTransit(s, force) {
      if (!shapes.includes(s) || !transit || !transit.queryArea) return;
      const b = boundsOf(s);
      if (!force && s.tq && s.tq.bounds.contains(b)) return; // the last answer covers the shape
      const q = b.pad(0.15);
      const gen = ++s.transitGen;
      s.transitState = 'loading';
      renderSummary(s);
      try {
        const res = await transit.queryArea(q);
        if (gen !== s.transitGen || !shapes.includes(s)) return;
        s.tq = { bounds: q, res };
        s.transitState = 'ok';
      } catch (e) {
        if (gen !== s.transitGen || !shapes.includes(s)) return;
        s.transitState = 'err';
        s.transitErr = e.message;
      }
      filterTransit(s);
      renderHead(s); renderSummary(s); renderResults(s);
      setLabelText(s);
    }

    // ---- showing a result on the map ------------------------------------------
    let highlight = null;
    function clearHighlight() { if (highlight) { map.removeLayer(highlight); highlight = null; } }
    function openAt(ll, html) {
      closeSidebarOnNarrow();
      const popup = L.popup({ maxWidth: 300, autoPanPadding: [40, 40] }).setLatLng(ll).setContent(html).openOn(map);
      popup.once('remove', clearHighlight);
    }
    function showPoint(lat, lon, html) {
      clearHighlight();
      const ll = L.latLng(lat, lon);
      if (map.getZoom() < 15 || !map.getBounds().contains(ll)) map.setView(ll, Math.max(map.getZoom(), 16), { animate: false });
      highlight = L.circleMarker(ll, { radius: 17, color: accent(), weight: 3, fill: false, interactive: false }).addTo(map);
      openAt(ll, html);
    }
    function showRoute(s, g) {
      clearHighlight();
      const lines = [];
      for (const part of g.parts) for (const line of part.lines) lines.push(line.map(c => [c[1], c[0]]));
      highlight = L.polyline(lines, { color: g.r.color, weight: 7, opacity: 0.85, interactive: false }).addTo(map);
      map.fitBounds(boundsOf(s).pad(0.1), { animate: false });
      // The popup goes on the route vertex nearest the shape's middle.
      const mid = boundsOf(s).getCenter();
      let best = null, bd = Infinity;
      for (const line of lines) for (const p of line) {
        const d = geom.distance(mid.lat, mid.lng, p[0], p[1]);
        if (d < bd) { bd = d; best = p; }
      }
      openAt(best ? L.latLng(best[0], best[1]) : mid, g.r.popup());
    }

    // ---- entries (panel) --------------------------------------------------------
    function iconBtn(text, title, onclick) {
      return U.el('button', { class: 'icon-btn area-icon-btn', type: 'button', title, 'aria-label': title, text, onclick });
    }
    function buildEntry(s) {
      const el = s.el = {};
      el.root = U.el('div', { class: 'area-entry', id: 'area-' + s.id });
      el.swatch = U.el('span', { class: 'area-swatch', style: 'background:' + s.style.color });
      el.title = U.el('button', { class: 'area-title', type: 'button' });
      el.title.addEventListener('click', () => { s.collapsed = !s.collapsed; renderCollapsed(s); save(); });
      el.eyeBtn = iconBtn('👁', 'Hide on the map', () => { s.visible = !s.visible; applyVisibility(s); renderHead(s); save(); });
      const zoomBtn = iconBtn('🔍', 'Zoom to this shape', () => { map.fitBounds(boundsOf(s).pad(0.08)); closeSidebarOnNarrow(); });
      el.editBtn = iconBtn('✏️', 'Reshape on the map', () => { if (!s.visible) { s.visible = true; applyVisibility(s); } setEditing(s, !s.editing); renderHead(s); });
      if (s.type !== 'polygon') el.editBtn.style.display = 'none';
      const delBtn = iconBtn('🗑', 'Delete this shape', () => removeShape(s));
      const head = U.el('div', { class: 'area-head' }, [el.swatch, el.title, U.el('div', { class: 'area-tools' }, [el.eyeBtn, zoomBtn, el.editBtn, delBtn])]);

      el.body = U.el('div', { class: 'area-body' });
      // name
      el.name = U.el('input', { class: 'input small', type: 'text', maxlength: '80', 'aria-label': 'Name', placeholder: titleOf(s) });
      el.name.value = s.named ? s.name : '';
      el.name.addEventListener('input', () => {
        s.name = el.name.value.trim(); s.named = !!s.name;
        renderHead(s); setLabelText(s); save();
      });
      el.body.appendChild(U.el('label', { class: 'area-row' }, [U.el('span', { class: 'mini-label', text: 'Name' }), el.name]));
      // radius (circles)
      if (s.type === 'circle') {
        el.radius = U.el('input', { class: 'input small area-radius', type: 'number', min: '0', step: 'any', 'aria-label': 'Radius' });
        el.unit = U.el('select', { class: 'input small area-unit', 'aria-label': 'Radius unit' },
          Object.keys(A.units).map(k => U.el('option', { value: k, text: A.units[k].label })));
        el.unit.value = s.unit;
        const applyInput = () => {
          const v = parseFloat(el.radius.value);
          if (!(v > 0)) return;
          setRadius(s, v * unitOf(s.unit).m);
        };
        const debounced = U.debounce(applyInput, 350);
        el.radius.addEventListener('input', debounced);
        el.radius.addEventListener('change', () => { applyInput(); syncRadiusInput(s, true); });
        el.radius.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyInput(); syncRadiusInput(s, true); } });
        el.unit.addEventListener('change', () => {
          s.unit = el.unit.value;
          syncRadiusInput(s, true); setHandleText(s);
          finalUpdate(s, { transit: false });
        });
        el.body.appendChild(U.el('div', { class: 'area-row' }, [
          U.el('span', { class: 'mini-label', text: 'Radius' }), el.radius, el.unit
        ]));
        syncRadiusInput(s, true);
      }
      el.geomInfo = U.el('div', { class: 'hint area-geom' });
      el.body.appendChild(el.geomInfo);
      el.editHint = U.el('div', { class: 'hint area-edit-hint', text:
        'Drag a corner to reshape · drag a small dot to add a corner · right-click or double-click a corner to remove it · drag the label to move the area.' });
      el.editHint.style.display = s.editing ? '' : 'none';
      el.body.appendChild(el.editHint);

      // style
      const st = s.style;
      el.color = U.el('input', { type: 'color', class: 'area-color', 'aria-label': 'Colour', value: st.color.toLowerCase() });
      el.color.addEventListener('input', () => { st.color = el.color.value; restyle(s); save(); });
      const pct = v => Math.round(v * 100) + '%';
      const fillOut = U.el('span', { class: 'area-pct', text: pct(st.fillOpacity) });
      el.fill = U.el('input', { type: 'range', class: 'slider', min: '0', max: '100', step: '5', value: String(Math.round(st.fillOpacity * 100)), 'aria-label': 'Fill opacity' });
      el.fill.addEventListener('input', () => { st.fillOpacity = +el.fill.value / 100; fillOut.textContent = pct(st.fillOpacity); restyle(s); save(); });
      const lineOut = U.el('span', { class: 'area-pct', text: pct(st.opacity) });
      el.lineOpacity = U.el('input', { type: 'range', class: 'slider', min: '10', max: '100', step: '5', value: String(Math.round(st.opacity * 100)), 'aria-label': 'Outline opacity' });
      el.lineOpacity.addEventListener('input', () => { st.opacity = +el.lineOpacity.value / 100; lineOut.textContent = pct(st.opacity); restyle(s); save(); });
      el.weight = U.el('select', { class: 'input small', 'aria-label': 'Outline width' },
        [1, 2, 3, 4, 6, 8].map(w => U.el('option', { value: String(w), text: w + ' px' })));
      el.weight.value = String(st.weight);
      el.weight.addEventListener('change', () => { st.weight = +el.weight.value; restyle(s); save(); });
      el.dash = U.el('select', { class: 'input small', 'aria-label': 'Outline style' },
        [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']].map(([v, t]) => U.el('option', { value: v, text: t })));
      el.dash.value = st.dash;
      el.dash.addEventListener('change', () => { st.dash = el.dash.value; restyle(s); save(); });
      el.body.appendChild(U.el('div', { class: 'area-style' }, [
        U.el('label', { class: 'area-row' }, [U.el('span', { class: 'mini-label', text: 'Colour' }), el.color]),
        U.el('div', { class: 'area-row' }, [U.el('span', { class: 'mini-label', text: 'Outline' }), el.weight, el.dash]),
        U.el('label', { class: 'area-row' }, [U.el('span', { class: 'mini-label', text: 'Fill opacity' }), el.fill, fillOut]),
        U.el('label', { class: 'area-row' }, [U.el('span', { class: 'mini-label', text: 'Outline opacity' }), el.lineOpacity, lineOut])
      ]));

      // summary + results
      el.summary = U.el('div', { class: 'area-summary' });
      el.csv = U.el('button', { class: 'btn mini ghost', type: 'button', text: '⬇ CSV', title: 'Download this list as a CSV file' });
      el.csv.addEventListener('click', () => exportCSV(s));
      el.body.appendChild(U.el('div', { class: 'area-summary-row' }, [el.summary, el.csv]));
      el.results = U.el('div', { class: 'area-results' });
      el.body.appendChild(el.results);

      el.root.append(head, el.body);
      listEl.appendChild(el.root);
      renderCollapsed(s);
    }
    function renderCollapsed(s) {
      s.el.root.classList.toggle('collapsed', !!s.collapsed);
      s.el.title.setAttribute('aria-expanded', String(!s.collapsed));
    }
    /** Shows the radius in the input; a value being typed is left alone unless `force`. */
    function syncRadiusInput(s, force) {
      if (!s.el || !s.el.radius) return;
      const u = unitOf(s.unit);
      if (force || document.activeElement !== s.el.radius) s.el.radius.value = String(+(s.radius / u.m).toFixed(u.m < 100 ? 0 : 3));
    }
    function renderHead(s) {
      if (!s.el) return;
      s.el.title.textContent = (s.type === 'circle' ? '⭕ ' : '⬠ ') + titleOf(s);
      s.el.title.title = countsText(s);
      s.el.name.placeholder = s.type === 'circle' ? fmtDist(s.radius, s.unit) + ' around ' + ((pinOf(s) || {}).label || 'pin') : (s.defaultName || 'Area');
      s.el.eyeBtn.textContent = s.visible ? '👁' : '🚫';
      s.el.eyeBtn.title = s.visible ? 'Hide on the map' : 'Show on the map';
      s.el.eyeBtn.setAttribute('aria-pressed', String(!s.visible));
      s.el.root.classList.toggle('hidden-shape', !s.visible);
    }
    function renderGeometry(s) {
      if (!s.el) return;
      if (s.type === 'circle') {
        s.el.geomInfo.textContent = 'Area ' + fmtArea(Math.PI * s.radius * s.radius, s.unit) + ' · drag the ◯ handle on the map to resize';
      } else {
        s.el.geomInfo.textContent = fmtArea(geom.ringAreaM2(s.pts), s.unit) + ' · ' + fmtDist(geom.perimeterM(s.pts), s.unit) +
          ' perimeter · ' + s.pts.length + ' corners';
      }
    }
    function renderSummary(s) {
      if (!s.el) return;
      let text = countsText(s);
      if (s.tq && s.tq.res.truncated) text += ' (transit list capped: zoom into a smaller area)';
      if (s.tq && s.tq.res.source === 'osm') text += ' · transit from OpenStreetMap';
      s.el.summary.textContent = text;
      s.el.title.title = text;
    }

    function renderResults(s) {
      if (!s.el) return;
      const box = s.el.results;
      box.innerHTML = '';
      const groups = [];
      if (s.res.places) {
        for (const g of s.res.places) {
          if (!g.items.length) continue;
          groups.push({
            key: 'p:' + g.c.id, label: g.c.cfg.emoji + ' ' + g.c.cfg.label, n: g.items.length,
            color: CFG.PALETTE.amenities[g.c.cfg.colorToken], rows: () => sortedPlaces(s, g), item: it => placeItem(s, g.c, it)
          });
        }
      }
      if (s.res.stops && s.res.stops.length) {
        groups.push({ key: 't:stops', label: '🚏 Transit stops', n: s.res.stops.length, color: 'var(--accent)',
          rows: () => s.res.stops.slice().sort(s.type === 'circle' ? (a, b) => a.d - b.d : (a, b) => a.st.name.localeCompare(b.st.name)),
          item: it => stopItem(s, it) });
      }
      if (s.res.routes && s.res.routes.length) {
        groups.push({ key: 't:routes', label: '🚌 Transit routes', n: s.res.routes.length, color: 'var(--accent)',
          rows: () => s.res.routes.slice().sort((a, b) => a.r.name.localeCompare(b.r.name, 'en', { numeric: true })),
          item: g => routeItem(s, g) });
      }
      if (!groups.length) {
        if (s.res.places) box.appendChild(U.el('div', { class: 'hint', text: s.transitState === 'loading'
          ? 'No places here; transit is still loading…' : 'Nothing found inside this shape.' }));
        return;
      }
      for (const g of groups) box.appendChild(groupEl(s, g));
    }
    function groupEl(s, g) {
      const det = U.el('details', { class: 'area-group', 'data-key': g.key });
      const sum = U.el('summary', {}, [
        U.el('span', { class: 'cat-dot', style: 'background:' + g.color }),
        U.el('span', { class: 'area-group-label', text: g.label }),
        U.el('span', { class: 'cat-count', text: g.n.toLocaleString('en-US') })
      ]);
      const list = U.el('div', { class: 'area-items' });
      det.append(sum, list);
      let rows = null, shown = 0;
      const more = U.el('button', { class: 'btn mini ghost area-more', type: 'button' });
      const fill = () => {
        rows = rows || g.rows();
        const upto = Math.min(rows.length, shown + A.listPage);
        const frag = document.createDocumentFragment();
        for (let i = shown; i < upto; i++) frag.appendChild(g.item(rows[i]));
        list.appendChild(frag);
        shown = upto;
        if (shown < rows.length) {
          more.textContent = 'Show ' + Math.min(A.listPage, rows.length - shown) + ' more (' + (rows.length - shown).toLocaleString('en-US') + ' left)';
          list.appendChild(more);
        } else more.remove();
      };
      more.addEventListener('click', () => { more.remove(); fill(); });
      det.addEventListener('toggle', () => {
        if (det.open) { s.open.add(g.key); if (!shown) fill(); } else s.open.delete(g.key);
      });
      if (s.open.has(g.key)) { det.open = true; fill(); }
      return det;
    }
    function sortedPlaces(s, g) {
      const rows = g.items.slice();
      if (s.type === 'circle') return rows.sort((a, b) => a.d - b.d);
      const d = g.c.d, F = g.c.F;
      const nameOf = it => String(d.rows[it.i][F.name] || d.kinds[d.rows[it.i][F.kind]] || '');
      return rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    }
    function itemEl(emoji, name, meta, onclick, swatch) {
      const b = U.el('button', { class: 'area-item', type: 'button', title: name + (meta ? ' · ' + meta : '') }, [
        swatch ? U.el('span', { class: 'mode-line', style: 'background:' + swatch }) : U.el('span', { class: 'area-item-emoji', text: emoji }),
        U.el('span', { class: 'area-item-main' }, [
          U.el('span', { class: 'area-item-name', text: name }),
          meta ? U.el('span', { class: 'area-item-meta', text: meta }) : null
        ])
      ]);
      b.addEventListener('click', onclick);
      return b;
    }
    function placeItem(s, c, it) {
      const r = c.d.rows[it.i], F = c.F;
      const kind = c.d.kinds[r[F.kind]] || c.cfg.label;
      const name = r[F.name] || kind;
      const meta = [kind !== name ? kind : null, s.type === 'circle' ? fmtDist(it.d, s.unit) : null].filter(Boolean).join(' · ');
      return itemEl(amenities.emojiFor(c.id, kind), name, meta, () => showPoint(c.lat[it.i], c.lon[it.i], amenities.popupHTML(c.id, it.i)));
    }
    function stopItem(s, it) {
      const meta = [it.st.agency || null, s.type === 'circle' ? fmtDist(it.d, s.unit) : null].filter(Boolean).join(' · ');
      return itemEl('🚏', it.st.name, meta, () => showPoint(it.st.lat, it.st.lon, it.st.popup()));
    }
    function routeItem(s, g) {
      const meta = [g.r.modeLabel, g.r.agency || null].filter(Boolean).join(' · ');
      return itemEl('', g.r.name, meta, () => showRoute(s, g), g.r.color);
    }

    // ---- CSV -------------------------------------------------------------------
    function csvCell(v) {
      if (v == null) return '';
      if (typeof v === 'number') return String(v);
      let t = String(v);
      if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // never let a spreadsheet run a name as a formula
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    }
    function exportCSV(s) {
      const u = unitOf(s.unit), circle = s.type === 'circle';
      const round = (v, k) => Math.round(v * Math.pow(10, k)) / Math.pow(10, k);
      const head = ['Area', 'Group', 'Type', 'Name', 'Address', 'Latitude', 'Longitude'];
      if (circle) head.push('Distance (' + u.label + ')');
      head.push('Agency / source', 'Link');
      const rows = [];
      const area = titleOf(s);
      for (const g of (s.res.places || [])) {
        const d = g.c.d, F = g.c.F;
        for (const it of sortedPlaces(s, g)) {
          const r = d.rows[it.i];
          const kind = d.kinds[r[F.kind]] || g.c.cfg.label;
          const src = d.sources[r[F.src]] || {};
          const ref = F.ref != null ? r[F.ref] : null;
          const link = (F.web != null && r[F.web]) || (ref && /^[nwr]\d+$/.test(ref)
            ? 'https://www.openstreetmap.org/' + { n: 'node', w: 'way', r: 'relation' }[ref[0]] + '/' + ref.slice(1) : '');
          const row = [area, g.c.cfg.label, kind, r[F.name] || kind, F.addr != null ? r[F.addr] : '', round(g.c.lat[it.i], 6), round(g.c.lon[it.i], 6)];
          if (circle) row.push(round(it.d / u.m, 3));
          row.push(src.name || '', link || '');
          rows.push(row);
        }
      }
      for (const it of (s.res.stops || [])) {
        const row = [area, 'Transit stops', 'Transit stop', it.st.name, '', round(it.st.lat, 6), round(it.st.lon, 6)];
        if (circle) row.push(round(it.d / u.m, 3));
        row.push(it.st.agency || (it.st.source === 'osm' ? 'OpenStreetMap' : ''), '');
        rows.push(row);
      }
      for (const g of (s.res.routes || [])) {
        const row = [area, 'Transit routes', g.r.modeLabel, g.r.name, '', '', ''];
        if (circle) row.push('');
        row.push(g.r.agency || '', g.r.schedule || g.r.agencyUrl || '');
        rows.push(row);
      }
      const csv = '﻿' + [head].concat(rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const slug = area.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'area';
      const a = U.el('a', { href: url, download: slug + '.csv' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    // ---- registering / removing --------------------------------------------------
    function register(s) {
      s.res = { places: null, stops: null, routes: null };
      s.open = new Set();
      s.transitGen = 0;
      s.transitState = 'idle';
      build(s);
      shapes.push(s);
      buildEntry(s);
      empty.style.display = 'none';
      if (!enabled && toggle) { toggle.checked = true; toggle.dispatchEvent(new Event('change')); }
      applyVisibility(s);
      ensurePlaces();
      finalUpdate(s);
      return s;
    }
    function removeShape(s) {
      const i = shapes.indexOf(s);
      if (i < 0) return;
      if (s._raf) cancelAnimationFrame(s._raf);
      clearTimeout(s._tq);
      s.transitGen++;
      for (const l of mapLayersOf(s)) { shapeGroup.removeLayer(l); handleGroup.removeLayer(l); }
      shapes.splice(i, 1);
      s.el.root.remove();
      clearHighlight();
      empty.style.display = shapes.length ? 'none' : '';
      save();
    }
    function addCircle(pinId, radiusM, extra) {
      const pin = WAMAP.pins && WAMAP.pins.get(pinId);
      if (!pin) return null;
      const o = extra || {};
      return register({
        id: o.id || uid(), type: 'circle', pinId, lat: pin.lat, lon: pin.lon,
        radius: clampR(radiusM || A.defaultRadiusM), unit: A.units[o.unit] ? o.unit : A.defaultUnit,
        bearing: isFinite(o.bearing) ? o.bearing : 90,
        name: o.name || '', named: !!o.name, style: o.style || newStyle(), visible: o.visible !== false, collapsed: !!o.collapsed
      });
    }
    function addPolygon(pts, extra) {
      const o = extra || {};
      areaSeq++;
      return register({
        id: o.id || uid(), type: 'polygon', pts: pts.map(p => [+p[0], +p[1]]),
        unit: A.units[o.unit] ? o.unit : A.defaultUnit, defaultName: 'Area ' + areaSeq,
        name: o.name || '', named: !!o.name, style: o.style || newStyle(), visible: o.visible !== false,
        collapsed: !!o.collapsed, editing: false
      });
    }
    /** The ring after the pin's largest: 1, 3, 5, 10 miles, then doubling. */
    function nextRing(mine) {
      const max = Math.max.apply(null, mine.map(s => s.radius));
      const ring = [1, 3, 5, 10, 25, 50].map(m => m * 1609.344).find(r => r > max * 1.001);
      return ring || Math.min(A.maxRadiusM, max * 2);
    }
    function focusEntry(s, o) {
      if (!s.el) return;
      card.classList.remove('collapsed');
      if (s.collapsed) { s.collapsed = false; renderCollapsed(s); }
      if (isNarrow() && sidebar() && !sidebar().classList.contains('open')) {
        sidebar().classList.add('open');
        setTimeout(() => map.invalidateSize(), 320);
      }
      s.el.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      s.el.root.classList.remove('flash');
      void s.el.root.offsetWidth; // restart the animation
      s.el.root.classList.add('flash');
      if (o && o.focusInput && s.el.radius) { s.el.radius.focus(); s.el.radius.select(); }
    }

    // ---- persistence -----------------------------------------------------------------
    function save() {
      U.store.set('areas', shapes.map(s => {
        const o = { id: s.id, type: s.type, name: s.named ? s.name : '', style: s.style, visible: s.visible, unit: s.unit, collapsed: !!s.collapsed };
        if (s.type === 'circle') Object.assign(o, { pinId: s.pinId, radius: Math.round(s.radius * 100) / 100, bearing: Math.round(s.bearing) });
        else o.pts = s.pts.map(p => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);
        return o;
      }));
    }
    function validStyle(st) {
      if (!st || typeof st !== 'object' || !/^#[0-9a-f]{6}$/i.test(st.color || '')) return null;
      const num = (v, lo, hi, d) => (isFinite(v) ? Math.min(hi, Math.max(lo, +v)) : d);
      return {
        color: st.color, fillOpacity: num(st.fillOpacity, 0, 1, A.fillOpacity), opacity: num(st.opacity, 0.1, 1, 0.95),
        weight: num(st.weight, 1, 8, A.weight), dash: DASH.hasOwnProperty(st.dash) ? st.dash : 'solid'
      };
    }
    function restore() {
      const saved = U.store.get('areas');
      if (!Array.isArray(saved)) return;
      for (const o of saved) {
        if (!o || typeof o !== 'object') continue;
        const extra = { id: typeof o.id === 'string' ? o.id : null, name: typeof o.name === 'string' ? o.name.slice(0, 80) : '',
          style: validStyle(o.style), visible: o.visible !== false, unit: o.unit, collapsed: true };
        if (extra.style) colorSeq++;
        else delete extra.style;
        if (o.type === 'circle' && isFinite(o.radius)) addCircle(o.pinId, +o.radius, Object.assign(extra, { bearing: +o.bearing }));
        else if (o.type === 'polygon' && Array.isArray(o.pts) && o.pts.length >= 3 &&
          o.pts.every(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)) {
          addPolygon(o.pts, extra);
        }
      }
    }

    // ---- pins ------------------------------------------------------------------------
    if (WAMAP.pins) {
      WAMAP.pins.on('move', (id, lat, lon, final) => {
        for (const s of shapes) {
          if (s.type !== 'circle' || s.pinId !== id) continue;
          s.lat = lat; s.lon = lon;
          s.layer.setLatLng([lat, lon]);
          s.handle.setLatLng(handlePos(s));
          if (final) finalUpdate(s); else liveUpdate(s);
        }
      });
      WAMAP.pins.on('remove', id => {
        for (const s of shapes.slice()) if (s.type === 'circle' && s.pinId === id) removeShape(s);
      });
      WAMAP.pins.on('label', id => {
        for (const s of shapes) if (s.type === 'circle' && s.pinId === id) { renderHead(s); setHandleText(s); save(); }
      });
    }
    /** The pin popup's radius-search section. */
    function pinPopupSection(pinId) {
      const wrap = U.el('div', { class: 'pin-areas' });
      const mine = shapes.filter(s => s.type === 'circle' && s.pinId === pinId);
      for (const s of mine) {
        wrap.appendChild(U.el('div', { class: 'pin-area-line' }, [
          U.el('span', { class: 'area-swatch', style: 'background:' + s.style.color }),
          U.el('a', { href: '#', text: fmtDist(s.radius, s.unit) + ': ' + countsText(s),
            onclick: e => { e.preventDefault(); map.closePopup(); focusEntry(s); } })
        ]));
      }
      wrap.appendChild(U.el('div', { class: 'popup-actions' }, [U.el('button', {
        class: 'btn mini', type: 'button', text: mine.length ? '⭕ Add another radius' : '⭕ Radius search',
        onclick: () => {
          const s = addCircle(pinId, mine.length ? nextRing(mine) : null);
          map.closePopup();
          if (s) focusEntry(s, { focusInput: true });
        }
      })]));
      return wrap;
    }

    // ---- drawing -----------------------------------------------------------------------
    // While drawing, a transparent layer over the map takes every click, so a
    // click on a place marker or a transit line adds a corner instead of
    // opening a popup. Drags and the wheel still reach the map (they bubble to
    // its container), so the map pans and zooms as usual.
    const draw = { active: false, pts: [], dots: [], line: null, close: null, overlay: null, bar: null, cursor: null };
    function startDraw() {
      if (draw.active) { WAMAP.modes.cancel(); return; }
      WAMAP.modes.request('area-draw', null, onDrawClick, false, endDraw);
      draw.active = true; draw.pts = []; draw.dots = []; draw.cursor = null;
      for (const b of drawButtons()) b.classList.add('active');
      map.doubleClickZoom.disable();
      draw.overlay = U.el('div', { class: 'draw-capture', 'aria-hidden': 'true' });
      map.getContainer().appendChild(draw.overlay);
      const undo = U.el('button', { class: 'btn mini ghost', type: 'button', text: '↶ Undo', title: 'Remove the last corner (Backspace)', onclick: undoPoint });
      const finish = U.el('button', { class: 'btn mini', type: 'button', text: '✓ Finish', title: 'Close the area (Enter, or double-click)', onclick: finishDraw });
      const cancel = U.el('button', { class: 'btn mini ghost', type: 'button', text: '✕ Cancel', title: 'Stop drawing (Esc)', onclick: () => WAMAP.modes.cancel() });
      draw.barText = U.el('span', { class: 'draw-bar-text' });
      draw.bar = U.el('div', { class: 'draw-bar', role: 'toolbar', 'aria-label': 'Drawing an area' }, [draw.barText, undo, finish, cancel]);
      document.getElementById('map-wrap').appendChild(draw.bar);
      draw.finishBtn = finish; draw.undoBtn = undo;
      draw.line = L.polyline([], { color: accent(), weight: 2.5, interactive: false }).addTo(map);
      draw.close = L.polyline([], { color: accent(), weight: 1.5, dashArray: '4 6', interactive: false }).addTo(map);
      map.on('mousemove', onDrawMove);
      map.on('dblclick', finishDraw);
      document.addEventListener('keydown', onDrawKey, true);
      closeSidebarOnNarrow();
      redrawDraft();
    }
    function endDraw() { // the mode's cancel hook: runs on Esc, Cancel and after Finish
      if (!draw.active) return;
      draw.active = false;
      for (const b of drawButtons()) b.classList.remove('active');
      map.off('mousemove', onDrawMove);
      map.off('dblclick', finishDraw);
      document.removeEventListener('keydown', onDrawKey, true);
      for (const l of draw.dots.concat([draw.line, draw.close])) if (l) map.removeLayer(l);
      if (draw.overlay) draw.overlay.remove();
      if (draw.bar) draw.bar.remove();
      draw.dots = []; draw.pts = []; draw.line = draw.close = draw.overlay = draw.bar = null;
      // Re-enabled after the double-click that finished the area has passed.
      setTimeout(() => { if (!draw.active) map.doubleClickZoom.enable(); }, 350);
    }
    function onDrawClick(ll) {
      const p = map.latLngToContainerPoint(ll);
      if (draw.pts.length >= 3 && p.distanceTo(map.latLngToContainerPoint(draw.pts[0])) <= 10) { finishDraw(); return; }
      const last = draw.pts[draw.pts.length - 1];
      if (last && p.distanceTo(map.latLngToContainerPoint(last)) < 5) return; // second click of a double-click
      draw.pts.push(L.latLng(ll.lat, ll.lng));
      draw.dots.push(L.circleMarker(ll, { radius: draw.pts.length === 1 ? 7 : 4.5, color: accent(), weight: 2,
        fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(map));
      redrawDraft();
    }
    function onDrawMove(e) { draw.cursor = e.latlng; redrawDraft(); }
    function redrawDraft() {
      if (!draw.active) return;
      const pts = draw.pts.slice();
      if (draw.cursor && pts.length) pts.push(draw.cursor);
      draw.line.setLatLngs(pts);
      draw.close.setLatLngs(draw.pts.length >= 2 && draw.cursor ? [draw.cursor, draw.pts[0]] : []);
      const n = draw.pts.length;
      draw.barText.textContent = n === 0 ? 'Click the map to place the first corner'
        : n < 3 ? plural(n, 'corner', 'corners') + ' · keep clicking to add corners'
          : plural(n, 'corner', 'corners') + ' · click the first corner or double-click to close';
      draw.finishBtn.disabled = n < 3;
      draw.undoBtn.disabled = n === 0;
    }
    function undoPoint() {
      if (!draw.active || !draw.pts.length) return;
      draw.pts.pop();
      const d = draw.dots.pop();
      if (d) map.removeLayer(d);
      redrawDraft();
    }
    function finishDraw() {
      if (!draw.active) return;
      if (draw.pts.length < 3) { WAMAP.toast('An area needs at least three corners.', 'warning'); return; }
      const pts = draw.pts.map(p => [p.lat, p.lng]);
      WAMAP.modes.cancel(); // -> endDraw
      const s = addPolygon(pts);
      setEditing(s, true);
      renderHead(s);
      focusEntry(s);
    }
    function onDrawKey(e) {
      if (!draw.active || (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) return;
      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); undoPoint(); }
      else if (e.key === 'Enter') { e.preventDefault(); finishDraw(); }
    }
    drawBtn.addEventListener('click', startDraw);
    pinModeBtn.addEventListener('click', () => {
      const b = document.getElementById('pin-mode-btn');
      if (b) { b.click(); closeSidebarOnNarrow(); }
    });

    // A theme change only recolours what uses the accent (the drawing guides).
    U.theme.onChange(() => {
      if (draw.line) draw.line.setStyle({ color: accent() });
      if (draw.close) draw.close.setStyle({ color: accent() });
    });

    const api = {
      id: 'areas',
      get enabled() { return enabled; },
      setEnabled(on) {
        enabled = !!on;
        if (enabled) { map.addLayer(shapeGroup); map.addLayer(handleGroup); }
        else { map.removeLayer(shapeGroup); map.removeLayer(handleGroup); }
        for (const s of shapes) applyVisibility(s);
      },
      restore,
      startDraw,
      addCircle,
      addPolygon,
      pinPopupSection,
      /** Plain summaries of every shape (used by the smoke test). */
      list() {
        return shapes.map(s => ({
          id: s.id, type: s.type, title: titleOf(s), radius: s.radius, unit: s.unit, pinId: s.pinId || null,
          lat: s.lat, lon: s.lon, pts: s.pts ? s.pts.map(p => p.slice()) : null,
          style: Object.assign({}, s.style), visible: s.visible, editing: !!s.editing, transit: s.transitState,
          layerStyle: { color: s.layer.options.color, fillOpacity: s.layer.options.fillOpacity, opacity: s.layer.options.opacity,
            weight: s.layer.options.weight, dashArray: s.layer.options.dashArray || null },
          onMap: map.hasLayer(s.layer), counts: counts(s)
        }));
      }
    };
    WAMAP.areas = api;
    return api;
  };
})();
