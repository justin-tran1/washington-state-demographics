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
  const RANK_LABEL = ['Most favorable option', 'Second most favorable option'];

  WAMAP.createSiteRanking = function (opts) {
    const { map } = opts;
    const SD = WAMAP.siteData;

    // ---- DOM -------------------------------------------------------------
    const modal = U.el('div', { id: 'rank-modal', class: 'modal rank-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Site ranking' });
    modal.style.display = 'none';
    const closeBtn = U.el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close the site ranking', text: '✕' });
    const profileSel = U.el('select', { class: 'input small rank-profile', 'aria-label': 'Use type' }, S.profiles.map(p => U.el('option', { value: p.id, text: p.label })));
    const sqftIn = U.el('input', { class: 'input small rank-sqft', type: 'number', min: '1000', max: '500000', step: '500', 'aria-label': 'Building size in square feet' });
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
    const hooked = new WeakSet();
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
      rows.sort((a, b) => {
        const ao = a.res && a.res.overall != null, bo = b.res && b.res.overall != null;
        if (ao !== bo) return ao ? -1 : 1;
        if (!ao) return a.i - b.i;
        if (a.res.gated !== b.res.gated) return a.res.gated ? 1 : -1;
        return b.res.overall - a.res.overall || b.res.stars - a.res.stars || a.i - b.i;
      });
      let n = 0;
      for (const r of rows) {
        if (!r.res || r.res.overall == null) r.rankLabel = r.busy ? 'Scoring…' : 'Not scored';
        else if (r.res.gated) r.rankLabel = 'Zoning barrier: medical use not permitted';
        else r.rankLabel = rows.length === 1 ? 'Only site so far' : RANK_LABEL[n] || 'Less favorable option';
        if (r.res && r.res.overall != null) { r.rank = rows.indexOf(r) + 1; if (!r.res.gated) n++; }
        if (r.res && r.res.overall != null && r.res.coverage < 60) r.rankLabel += ' (partial data)';
      }
      return { profile, W, rows, busy: rows.some(r => r.busy) };
    }
    /** The two facts shown for a criterion: its heaviest factor, then a red flag if there is one, else the next heaviest. */
    function briefs(cat) {
      const fs = cat.factors.filter(f => f.status === 'ok' && f.brief).sort((a, b) => b.w - a.w);
      if (!fs.length) return [];
      const flag = fs.slice(1).find(f => f.score < 35);
      return [fs[0], flag || fs[1]].filter(Boolean);
    }

    let last = null;
    function render() {
      if (!isOpen()) return;
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
        body.appendChild(U.el('tr', { class: cat.w === 0 ? 'rank-off' : '' }, cells));
      }
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
      note.textContent = 'Each criterion is rated 1-5 from the scores of the factors behind it (5 Excellent 85+, 4 Strong 70-84, 3 Average 50-69, 2 Below average 30-49, 1 Poor below 30); ' +
        'the overall score is the weighted average of the criteria scores, out of 100. A site whose zoning rules out medical use is ranked after the others. ' +
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
    function applyWeights() {
      const w = {};
      for (const inp of host.querySelectorAll('.rank-win')) {
        const v = +inp.value;
        if (inp.value === '' || !(v >= 0 && v <= 100)) return;
        w[inp.dataset.cat] = Math.round(v);
      }
      if (!S.categories.every(c => c.id in w) || !S.categories.some(c => w[c.id] > 0)) return;
      SD.setWeights(SD.prefs.profile, w);
    }
    profileSel.addEventListener('change', () => SD.setPrefs({ profile: profileSel.value }));
    const applySqft = () => { const v = Math.round(+sqftIn.value); if (v >= 1000 && v <= 500000 && v !== SD.prefs.sqft) SD.setPrefs({ sqft: v }); };
    sqftIn.addEventListener('input', U.debounce(applySqft, 300));
    sqftIn.addEventListener('change', applySqft);
    resetBtn.addEventListener('click', () => SD.setWeights(SD.prefs.profile, null));
    rescoreBtn.addEventListener('click', () => {
      for (const p of sites()) SD.forgetRun(p);
      pump();
    });
    SD.onChange(() => { if (isOpen()) render(); });

    function openSite(id) {
      const pin = WAMAP.pins.get(id);
      close();
      if (!pin) return;
      map.setView([pin.lat, pin.lon], Math.max(map.getZoom(), 15));
      if (WAMAP.siteEval) WAMAP.siteEval.open(id);
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
      }
      lines.push('', 'Criteria rated 1-5 (5 Excellent 85+, 4 Strong 70-84, 3 Average 50-69, 2 Below average 30-49, 1 Poor <30); overall = weighted average of criteria scores out of 100. Screening estimates from public data (Washington Explorer).');
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
        for (const f of S.criteria.filter(x => x.cat === cat.id)) {
          rows.push(['  ' + f.label, ''].concat(last.rows.map(r => {
            const x = r.res && r.res.criteria.find(y => y.id === f.id);
            return x && x.status === 'ok' ? `${x.score}${x.brief ? ' - ' + x.brief : ''}` : '';
          })));
        }
      }
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
    function open() {
      modal.style.display = 'flex';
      pump();
      render();
      closeBtn.focus();
    }
    function close() { modal.style.display = 'none'; }
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
          overall: r.res ? r.res.overall : null, rating: r.res ? r.res.rating : null, gated: r.res ? r.res.gated : null,
          categories: r.res ? r.res.categories.map(c => ({ id: c.id, w: c.w, score: c.score, grade: c.grade && c.grade.n })) : [] })) };
      },
      text: asText, csv: asCSV
    };
  };
})();
