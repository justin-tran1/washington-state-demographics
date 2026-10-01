/* Washington Explorer — site ranking.
 * Compares every dropped pin on the six weighted criteria of the medical site
 * evaluation and ranks them, best first: each criterion's 1-5 rating with a
 * bar and the facts behind it, and the overall score out of 100. It reuses
 * the evaluation's runs (layers/siteeval.js), so changing the use type or a
 * weight re-ranks at once without fetching anything again.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;
  const S = CFG.SITE_EVAL;
  const CONCURRENT = 2;       // sites gathered at once (each makes about ten requests)
  const SOURCES = ['zoning', 'parcel', 'osm', 'roads', 'traffic', 'elevation', 'flood', 'transit', 'amenities', 'catchment'];
  const loading = r => SOURCES.some(k => r.status[k] === 'loading');
  const gradeLevel = n => (n >= 4 ? 'good' : n === 3 ? 'fair' : 'poor');
  const int = v => Math.round(v).toLocaleString('en-US');
  const usd = v => '$' + (v >= 995000 ? (v / 1e6).toFixed(v >= 9.95e6 ? 0 : 1) + 'M' : v >= 1000 ? Math.round(v / 1000) + 'k' : Math.round(v));
  const RANK_LABEL = ['Top-ranked site', 'Second-ranked site'];
  /** "5 very strong 85+, 4 strong 70-84, …" from CONFIG.SITE_EVAL.scale. */
  const scaleText = () => S.scale.map(([min, n, label], i) =>
    `${n} ${label.toLowerCase()} ${i === 0 ? min + '+' : min === 0 ? 'below ' + S.scale[i - 1][0] : min + '-' + (S.scale[i - 1][0] - 1)}`).join(', ');

  /**
   * Sorts rows ({ i, res, busy }) best first and gives each a rank and a
   * label. Zoning that rules out medical use sorts last; equal scores share a
   * rank and a label, since the order between them means nothing.
   */
  function rankRows(rows) {
    rows.sort((a, b) => {
      const ao = a.res && a.res.overall != null, bo = b.res && b.res.overall != null;
      if (ao !== bo) return ao ? -1 : 1;
      if (!ao) return a.i - b.i;
      if (a.res.gated !== b.res.gated) return a.res.gated ? 1 : -1;
      return b.res.overall - a.res.overall || b.res.stars - a.res.stars || a.i - b.i;
    });
    let n = 0, prev = null;
    rows.forEach((r, i) => {
      const res = r.res;
      if (!res || res.overall == null) { r.rankLabel = r.busy ? 'Scoring…' : 'Not scored'; return; }
      const tie = prev && prev.res.gated === res.gated && prev.res.overall === res.overall && prev.res.stars === res.stars;
      r.rank = tie ? prev.rank : i + 1;
      r.tied = tie;
      if (tie) prev.tied = true;
      if (res.gated) {
        // Office uses not permitted, or a zone class (residential, open space) whose uses are not recorded.
        const z = res.criteria.find(c => c.id === 'zoning');
        r.rankLabel = z && z.basis === 'office' ? 'Zoning barrier: offices not permitted' : 'Zoning likely a barrier (uses not recorded for this zone)';
      } else {
        if (!tie) r.group = n++;
        else r.group = prev.group;
        r.rankLabel = rows.length === 1 ? 'Only site so far' : RANK_LABEL[r.group] || 'Lower-ranked site';
      }
      prev = r;
    });
    for (const r of rows) {
      if (!r.res || r.res.overall == null) continue;
      if (r.tied) r.rankLabel = 'Tied: ' + r.rankLabel.charAt(0).toLowerCase() + r.rankLabel.slice(1);
      const z = r.res.criteria.find(c => c.id === 'zoning');
      r.zoningUnchecked = !!z && (z.status === 'error' || z.status === 'na');
      if (r.zoningUnchecked) r.rankLabel += ' · zoning not verified';
      if (r.res.coverage < 60) r.rankLabel += ' (partial data)';
    }
    return rows;
  }

  WAMAP.createSiteRanking = function (opts) {
    const { map } = opts;
    const SD = WAMAP.siteData;

    // ---- DOM -------------------------------------------------------------
    const modal = U.el('div', { id: 'rank-modal', class: 'modal rank-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Site ranking' });
    modal.style.display = 'none';
    const closeBtn = U.el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the site ranking', text: '✕' });
    const profileSel = U.el('select', { class: 'input small rank-profile', 'aria-label': 'Use type' }, S.profiles.map(p => U.el('option', { value: p.id, text: p.label })));
    const sqftIn = U.el('input', { class: 'input small rank-sqft', type: 'number', min: String(SD.SQFT_MIN), max: String(SD.SQFT_MAX), step: '500', 'aria-label': 'Building size in square feet' });
    const resetBtn = U.el('button', { class: 'btn mini ghost', type: 'button', text: 'Reset weights' });
    const rescoreBtn = U.el('button', { class: 'btn mini ghost', type: 'button', text: '↻ Re-score', title: 'Fetch every source again for every site' });
    const copyBtn = U.el('button', { class: 'btn mini', type: 'button', text: '📋 Copy as text' });
    const csvBtn = U.el('button', { class: 'btn mini ghost', type: 'button', text: '⬇ CSV' });
    const statusEl = U.el('div', { class: 'rank-status', 'aria-live': 'polite' });
    const host = U.el('div', { class: 'rank-scroll' });
    const note = U.el('p', { class: 'rank-note' });
    modal.appendChild(U.el('div', { class: 'modal-box rank-box' }, [
      U.el('div', { class: 'modal-head' }, [U.el('h2', { text: '📊 Site ranking' }), closeBtn]),
      U.el('div', { class: 'rank-toolbar' }, [
        U.el('label', { class: 'se-ctl' }, [U.el('span', { class: 'mini-label', text: 'Use type' }), profileSel]),
        U.el('label', { class: 'se-ctl rank-ctl-sf' }, [U.el('span', { class: 'mini-label', text: 'Building (sf)' }), sqftIn]),
        U.el('div', { class: 'rank-actions' }, [resetBtn, rescoreBtn, copyBtn, csvBtn])
      ]),
      statusEl,
      U.el('div', { class: 'modal-body rank-body' }, [host, note])
    ]));
    document.body.appendChild(modal);

    // ---- pins and runs -------------------------------------------------------
    const hooked = new Set();   // runs this ranking follows while it is open
    const allPins = () => (WAMAP.pins && WAMAP.pins.list ? WAMAP.pins.list() : []);
    const sites = () => allPins().slice(0, S.rankMax);
    const peek = p => SD.peek(p);
    function onRun(r, k) { if (!isOpen()) return; if (k === 'forgotten') pump(); else scheduleRender(); }
    function hook(r) {
      if (hooked.has(r)) return;
      hooked.add(r);
      r.listeners.add(onRun);
      r.done.then(() => { if (isOpen()) pump(); });
    }
    /** Starts runs for sites that have none, a couple at a time. */
    function pump() {
      const list = sites();
      let active = list.filter(p => { const r = peek(p); return r && loading(r); }).length;
      for (const p of list) {
        const r = peek(p);
        if (r) { hook(r); continue; }
        if (active >= CONCURRENT) continue;
        hook(SD.gather(p));
        active++;
      }
      scheduleRender();
    }

    // ---- ranking ---------------------------------------------------------------
    /** Sites with their results, best first; zoning that rules out medical use sorts last. */
    function compute() {
      const profile = SD.prefs.profile, W = SD.weightsFor(profile);
      const rows = sites().map((pin, i) => {
        const run = peek(pin);
        const res = run ? SD.evaluate(run, profile, SD.prefs.sqft, W) : null;
        return { pin, i, run, res, label: SD.pinLabel({ pinId: pin.id }), busy: !run || loading(run) };
      });
      rankRows(rows);
      // Not weighted, but part of the choice: how much of each site's catchment
      // another pin already draws on (cannibalization, if one is an existing
      // site), and what the land is assessed at (a rough guide to cost).
      for (const r of rows) {
        const c = r.run && r.run.data.catchment ? SD.catchmentFor(r.run.data, profile) : null;
        r.members = c && c.agg.members && c.agg.pop > 0 ? c.agg : null;
        const par = r.run && r.run.data.parcel;
        r.land = par && !par.none && par.acres > 0 && par.props.VALUE_LAND > 0
          ? { acres: par.acres, land: par.props.VALUE_LAND, total: par.props.VALUE_LAND + (par.props.VALUE_BLDG > 0 ? par.props.VALUE_BLDG : 0) } : null;
      }
      for (const r of rows) {
        r.overlap = null;
        if (!r.members) continue;
        for (const o of rows) {
          if (o === r || !o.members) continue;
          let shared = 0;
          for (const g in r.members.members) if (g in o.members.members) shared += r.members.members[g];
          const share = shared / r.members.pop;
          if (!r.overlap || share > r.overlap.share) r.overlap = { share, other: o };
        }
      }
      return { profile, W, rows, busy: rows.some(r => r.busy) };
    }
    /** The two facts shown for a criterion: its heaviest factor, then a red flag if there is one, else the next heaviest. */
    function briefs(cat) {
      const fs = cat.factors.filter(f => f.status === 'ok' && f.brief).sort((a, b) => b.w - a.w);
      // Zoning that could not be checked is said first: the score leaves it out.
      const z = cat.factors.find(f => f.id === 'zoning' && (f.status === 'error' || f.status === 'na'));
      if (z) fs.unshift({ id: 'zoning', label: 'Zoning', brief: 'zoning not verified', score: 0, w: Infinity });
      if (!fs.length) return [];
      const flag = fs.slice(1).find(f => f.score < 35);
      return [fs[0], flag || fs[1]].filter(Boolean);
    }

    const overlapText = r => (!r.overlap ? (r.busy ? '…' : '—') : r.overlap.share < 0.005 ? 'No shared residents'
      : `${Math.round(r.overlap.share * 100)}% of residents shared with ${r.overlap.other.rank ? '#' + r.overlap.other.rank : r.overlap.other.label}`);
    const landText = r => (r.land ? `${usd(r.land.land / r.land.acres)} per acre` : r.busy ? '…' : 'not on record');
    const landSub = r => (r.land ? `land ${usd(r.land.land)} · total ${usd(r.land.total)} (${r.land.acres.toFixed(r.land.acres < 10 ? 1 : 0)} ac)` : '');
    let last = null, rendering = false, deferred = false;
    /** The weight input being edited, if any: { cat, committed } (committed when it shows the stored weight). */
    function editing() {
      const el = document.activeElement;
      if (!el || !host.contains(el) || !el.classList.contains('rank-win')) return null;
      return { cat: el.dataset.cat, committed: Number(el.value) === SD.weightsFor(SD.prefs.profile)[el.dataset.cat] };
    }
    function render() {
      if (!isOpen()) return;
      if (rendering) { scheduleRender(); return; }
      // Rebuilding the table would throw away a weight half typed: wait for it.
      const ed = editing();
      if (ed && !ed.committed) { deferred = true; return; }
      rendering = true;
      try { build(ed && ed.cat); } finally { rendering = false; }
    }
    function build(focusCat) {
      const out = compute();
      last = out;
      syncControls(out);
      const total = allPins().length;
      if (!total) {
        host.innerHTML = '';
        host.appendChild(U.el('div', { class: 'rank-empty' }, [
          U.el('p', { text: 'No pins yet. Drop a pin on each candidate site (📍 in the toolbar, or "Keep as pin" on a search result), then rank them here.' })]));
        statusEl.textContent = '';
        note.textContent = '';
        return;
      }
      const done = out.rows.filter(r => !r.busy).length;
      statusEl.textContent = out.busy ? `Scoring ${done} of ${out.rows.length} sites… the ranking updates as each one finishes.`
        : `${out.rows.length} site${out.rows.length === 1 ? '' : 's'} ranked for ${lowerFirst(out.profile.label)}${total > S.rankMax ? ` (the first ${S.rankMax} of ${total} pins; remove pins to compare others)` : ''}.`;
      const wTotal = S.categories.reduce((t, c) => t + out.W[c.id], 0);
      const table = U.el('table', { class: 'rank-table' });
      const headCells = [U.el('th', { class: 'rank-crit', scope: 'col', text: 'Criteria' }), U.el('th', { class: 'rank-w', scope: 'col', text: 'Weight' })];
      for (const r of out.rows) {
        const name = U.el('button', { class: 'rank-name', type: 'button', text: r.label, title: 'Open this site\'s evaluation' });
        name.addEventListener('click', () => openSite(r.pin.id));
        const hs = r.res && r.res.overall != null ? U.el('div', { class: 'rank-hscore' }, [U.el('b', { text: String(r.res.overall) }), ` of 100 · ${r.res.rating}`]) : null;
        headCells.push(U.el('th', { class: 'rank-site', scope: 'col' }, [
          U.el('div', { class: 'rank-no', text: r.rank ? '#' + r.rank : '…' }), name,
          U.el('div', { class: 'rank-coord', text: r.pin.lat.toFixed(4) + ', ' + r.pin.lon.toFixed(4) }), hs]));
      }
      table.appendChild(U.el('thead', {}, [U.el('tr', {}, headCells)]));
      const body = U.el('tbody');
      for (const cat of S.categories) {
        const w = U.el('input', { class: 'input small rank-win', type: 'number', min: '0', max: '100', step: '5', value: String(out.W[cat.id]),
          'aria-label': cat.label + ' weight (%)', 'data-cat': cat.id });
        w.addEventListener('change', applyWeights);
        const cells = [U.el('th', { class: 'rank-crit', scope: 'row' }, [U.el('span', { class: 'rank-ci', text: cat.icon }),
          U.el('span', {}, [U.el('span', { class: 'rank-cl', text: cat.label }), U.el('small', { text: cat.about })])]),
        U.el('td', { class: 'rank-w' }, [w, U.el('span', { text: '%' })])];
        for (const r of out.rows) {
          const c = r.res && r.res.categories.find(x => x.id === cat.id);
          if (!c || !c.grade) { cells.push(U.el('td', { class: 'rank-cell rank-na', text: r.busy ? '…' : 'not scored' })); continue; }
          const lvl = gradeLevel(c.grade.n);
          cells.push(U.el('td', { class: 'rank-cell se-' + lvl, 'data-cat': cat.id, title: `${c.grade.n} of 5, ${c.grade.label} (${c.score} of 100)` }, [
            U.el('div', { class: 'rank-gline' }, [U.el('span', { class: 'se-grade se-g-' + lvl, text: String(c.grade.n) }), U.el('span', { class: 'rank-glabel', text: c.grade.label + (c.loading ? '…' : '') })]),
            U.el('div', { class: 'rank-bar' }, [U.el('span', { style: 'width:' + c.score + '%' })]),
            U.el('ul', { class: 'rank-briefs' }, briefs(c).map(f => U.el('li', { text: f.brief, title: f.label })))]));
        }
        body.appendChild(U.el('tr', { class: out.W[cat.id] === 0 ? 'rank-off' : '' }, cells));
      }
      const info = (icon, label, about, cell) => U.el('tr', { class: 'rank-info' }, [
        U.el('th', { class: 'rank-crit', scope: 'row' }, [U.el('span', { class: 'rank-ci', text: icon }), U.el('span', {}, [U.el('span', { class: 'rank-cl', text: label }), U.el('small', { text: about })])]),
        U.el('td', { class: 'rank-w rank-nw', text: 'not weighted' })].concat(out.rows.map(cell)));
      if (out.rows.length > 1) {
        body.appendChild(info('🔁', 'Catchment overlap', 'Residents another pin also reaches', r => U.el('td', { class: 'rank-cell rank-icell' + (r.overlap && r.overlap.share >= 0.5 ? ' rank-flag' : ''), text: overlapText(r) })));
      }
      body.appendChild(info('🏷️', 'Assessed land value', 'County assessor; a rough guide to cost', r => U.el('td', { class: 'rank-cell rank-icell' }, [
        U.el('div', { text: landText(r) }), r.land ? U.el('div', { class: 'rank-isub', text: landSub(r) }) : null])));
      const totalCells = [U.el('th', { class: 'rank-crit', scope: 'row', text: 'Overall score' }),
        U.el('td', { class: 'rank-w' + (wTotal !== 100 ? ' rank-woff' : ''), text: wTotal + '%', title: wTotal !== 100 ? 'Weights are scaled to 100%' : '' })];
      for (const r of out.rows) {
        const res = r.res;
        if (!res || res.overall == null) { totalCells.push(U.el('td', { class: 'rank-total-cell rank-na', text: r.rankLabel })); continue; }
        const lvl = gradeLevel(res.grade.n);
        totalCells.push(U.el('td', { class: 'rank-total-cell se-' + lvl }, [
          U.el('div', { class: 'rank-score', text: String(res.overall) }),
          U.el('div', { class: 'rank-of', text: `of 100 · ${res.rating} · ${res.stars.toFixed(1)} of 5` }),
          U.el('div', { class: 'rank-label' + (r.rank === 1 && !res.gated ? ' rank-top' : ''), text: r.rankLabel })]));
      }
      body.appendChild(U.el('tr', { class: 'rank-total' }, totalCells));
      table.appendChild(body);
      host.innerHTML = '';
      host.appendChild(table);
      if (focusCat) { const el = host.querySelector(`.rank-win[data-cat="${focusCat}"]`); if (el) el.focus(); } // keep the place of a keyboard edit
      note.textContent = `Each criterion is rated 1-5 from the scores of the factors behind it (${scaleText()}); ` +
        'the overall score is the weighted average of the criteria scores, out of 100, and equal scores share a rank. A site whose zoning rules out medical use is ranked after the others; one whose zoning could not be checked says so. ' +
        'Catchment overlap is the share of a site\'s drive-time residents that another pin also reaches; where that pin is an existing site, a high share means the new one would draw on the same patients. Land value is the county assessor\'s, not a market price. ' +
        `Weights are ${SD.customWeights(out.profile) ? 'your own for this use type (kept in this browser)' : 'the defaults for this use type'}; edit them in the Weight column. Open a site for the evidence behind each rating. Screening estimates from public data.`;
    }
    let raf = 0;
    function scheduleRender() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
    const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);

    function syncControls(out) {
      profileSel.value = out.profile.id;
      if (document.activeElement !== sqftIn) sqftIn.value = String(SD.prefs.sqft);
      resetBtn.disabled = !SD.customWeights(out.profile);
    }
    function applyWeights(e) {
      const cur = SD.weightsFor(SD.prefs.profile), w = Object.assign({}, cur);
      for (const inp of host.querySelectorAll('.rank-win')) {
        const v = +inp.value;
        if (inp.value !== '' && v >= 0 && v <= 100) w[inp.dataset.cat] = Math.round(v);
      }
      // A value out of range, or weights that would all be zero, go back to what applies.
      if (!S.categories.some(c => w[c.id] > 0)) Object.assign(w, cur);
      for (const inp of host.querySelectorAll('.rank-win')) if (Number(inp.value) !== w[inp.dataset.cat] || inp.value === '') inp.value = String(w[inp.dataset.cat]);
      if (S.categories.some(c => w[c.id] !== cur[c.id])) SD.setWeights(SD.prefs.profile, w);
      else if (e) scheduleRender();
    }
    profileSel.addEventListener('change', () => SD.setPrefs({ profile: profileSel.value }));
    const applySqft = () => { const v = Math.round(+sqftIn.value); if (SD.okSqft(v) && v !== SD.prefs.sqft) SD.setPrefs({ sqft: v }); };
    sqftIn.addEventListener('input', U.debounce(applySqft, 300));
    sqftIn.addEventListener('change', () => { applySqft(); if (!SD.okSqft(Math.round(+sqftIn.value))) sqftIn.value = String(SD.prefs.sqft); });
    resetBtn.addEventListener('click', () => SD.setWeights(SD.prefs.profile, null));
    rescoreBtn.addEventListener('click', () => {
      for (const p of sites()) SD.forgetRun(p);
      pump();
    });
    SD.onChange(() => { if (isOpen()) scheduleRender(); });
    host.addEventListener('focusout', () => { if (deferred) { deferred = false; scheduleRender(); } });

    function openSite(id) {
      // The panel takes the run over before the ranking lets go of it.
      const pin = WAMAP.pins.get(id);
      if (pin) {
        map.setView([pin.lat, pin.lon], Math.max(map.getZoom(), 15));
        if (WAMAP.siteEval) WAMAP.siteEval.open(id);
      }
      close();
    }

    // ---- export ---------------------------------------------------------------
    function asText() {
      if (!last) return '';
      const out = last;
      const lines = [`Site ranking: ${out.profile.label}, ${int(SD.prefs.sqft)} sf building`,
        `Weights: ${S.categories.map(c => `${c.label} ${out.W[c.id]}%`).join('; ')}${SD.customWeights(out.profile) ? ' (custom)' : ''}`, ''];
      for (const r of out.rows) {
        const res = r.res;
        lines.push(`${r.rank ? r.rank + '. ' : '- '}${r.label} (${r.pin.lat.toFixed(5)}, ${r.pin.lon.toFixed(5)}): ${res && res.overall != null ? `${res.overall}/100, ${res.rating}, ${res.stars.toFixed(1)} of 5` : 'not scored'} - ${r.rankLabel}`);
        if (res) {
          lines.push('   ' + res.categories.map(c => `${c.short} ${c.grade ? c.grade.n + '/5' : 'n/a'}`).join(' · '));
          const facts = res.categories.flatMap(c => briefs(c).map(f => f.brief));
          if (facts.length) lines.push('   ' + facts.join('; '));
        }
        const extra = [out.rows.length > 1 && r.overlap ? 'Catchment overlap: ' + overlapText(r) : null, r.land ? `Assessed land: ${landText(r)}, ${landSub(r)}` : null].filter(Boolean);
        if (extra.length) lines.push('   ' + extra.join(' · '));
      }
      lines.push('', `Criteria rated 1-5 (${scaleText()}); overall = weighted average of criteria scores out of 100. Screening estimates from public data (Washington Explorer).`);
      return lines.join('\n');
    }
    function asCSV() {
      if (!last) return '';
      const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const rows = [['Criterion', 'Weight (%)'].concat(last.rows.map(r => `${r.label} (${r.pin.lat.toFixed(5)}, ${r.pin.lon.toFixed(5)})`))];
      for (const cat of S.categories) {
        rows.push([cat.label, last.W[cat.id]].concat(last.rows.map(r => {
          const c = r.res && r.res.categories.find(x => x.id === cat.id);
          return c && c.grade ? `${c.grade.n} ${c.grade.label} (${c.score})` : '';
        })));
        const counted = S.criteria.filter(x => x.cat === cat.id && (last.profile.factorWeights && last.profile.factorWeights[x.id] != null ? last.profile.factorWeights[x.id] : x.w) > 0);
        for (const f of counted) {
          rows.push(['  ' + f.label, ''].concat(last.rows.map(r => {
            const x = r.res && r.res.criteria.find(y => y.id === f.id);
            return x && x.status === 'ok' ? `${x.score}${x.brief ? ' - ' + x.brief : ''}` : '';
          })));
        }
      }
      rows.push(['Catchment overlap (share of residents another pin reaches)', 'not weighted'].concat(last.rows.map(r => (r.overlap ? `${Math.round(r.overlap.share * 100)}%${r.overlap.share >= 0.005 ? ' with ' + (r.overlap.other.rank ? '#' + r.overlap.other.rank : r.overlap.other.label) : ''}` : ''))));
      rows.push(['Assessed land value per acre ($)', 'not weighted'].concat(last.rows.map(r => (r.land ? Math.round(r.land.land / r.land.acres) : ''))));
      rows.push(['Overall score (of 100)', S.categories.reduce((t, c) => t + last.W[c.id], 0)].concat(last.rows.map(r => (r.res && r.res.overall != null ? r.res.overall : ''))));
      rows.push(['Rating', ''].concat(last.rows.map(r => (r.res && r.res.rating) || '')));
      rows.push(['Rank', ''].concat(last.rows.map(r => `${r.rank || ''} ${r.rankLabel}`.trim())));
      return rows.map(r => r.map(q).join(',')).join('\r\n');
    }
    copyBtn.addEventListener('click', () => SD.copyText(asText(), copyBtn));
    csvBtn.addEventListener('click', () => {
      const blob = new Blob(['﻿' + asCSV()], { type: 'text/csv;charset=utf-8' });
      const a = U.el('a', { href: URL.createObjectURL(blob), download: 'site-ranking.csv' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });

    // ---- open / close -----------------------------------------------------------
    function isOpen() { return modal.style.display !== 'none'; }
    let opener = null;
    function open() {
      if (!isOpen()) opener = document.activeElement;
      modal.style.display = 'flex';
      pump();
      render();
      closeBtn.focus();
    }
    function close() {
      modal.style.display = 'none';
      // Let go of the runs: one still loading that nothing else follows is stopped (reopening resumes it).
      for (const r of hooked) SD.release(r, onRun);
      hooked.clear();
      if (opener && document.body.contains(opener) && opener.focus) opener.focus();
      opener = null;
    }
    closeBtn.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen()) close(); });
    if (WAMAP.pins) for (const ev of ['add', 'move', 'remove', 'label']) WAMAP.pins.on(ev, (id, lat, lon, final) => { if (ev === 'move' && !final) return; if (isOpen()) setTimeout(pump, 0); });

    return {
      open, close,
      get isOpen() { return isOpen(); },
      /** The ranking as shown, for the smoke test. */
      result() {
        const out = compute();
        return { profile: out.profile.id, busy: out.busy, weights: out.W, rows: out.rows.map(r => ({ pinId: r.pin.id, label: r.label, rank: r.rank || null, rankLabel: r.rankLabel,
          overall: r.res ? r.res.overall : null, rating: r.res ? r.res.rating : null, gated: r.res ? r.res.gated : null, tied: !!r.tied, zoningUnchecked: !!r.zoningUnchecked,
          overlap: r.overlap ? { share: r.overlap.share, with: r.overlap.other.pin.id } : null, landPerAcre: r.land ? r.land.land / r.land.acres : null,
          categories: r.res ? r.res.categories.map(c => ({ id: c.id, w: c.w, score: c.score, grade: c.grade && c.grade.n })) : [] })) };
      },
      text: asText, csv: asCSV
    };
  };
  WAMAP.siteRankingInternals = { rankRows };
})();
