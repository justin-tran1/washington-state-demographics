/* Washington Explorer — health insurance profile.
 * The insurance layer's popup for a county or census tract: insured and
 * uninsured rates, the payer mix (each person counted once, ACS table
 * B27010 with Medicaid from C27007) as a 100% bar with every value listed
 * beside it, and the
 * insurance sources (each type of coverage, alone or with others, ACS
 * tables B27002, B27003 and C27004-C27009) as bars. Every figure cites the
 * ACS table the data file records for it, linked on data.census.gov for the
 * same area.
 */
(function () {
  'use strict';
  const WAMAP = window.WAMAP;
  const CFG = WAMAP.CONFIG;
  const U = WAMAP.util;
  const INS = CFG.INSURANCE;

  // Payer and bar colors follow the theme through CSS variables, so an open
  // popup recolors with it.
  function applyColors() {
    const c = U.theme.colors(), root = document.documentElement.style;
    for (const [k, v] of Object.entries(c.payer)) root.setProperty('--pm-' + k, v);
    root.setProperty('--ins-bar', c.insBar);
    root.setProperty('--ins-track', c.insTrack);
  }
  applyColors();
  U.theme.onChange(applyColors);

  const esc = U.escapeHTML;
  // One decimal throughout, so the values line up in their column.
  const pct = v => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%');
  const link = (text, href) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

  WAMAP.insuranceProfile = function ({ geoid, name, row, acs }) {
    const table = t => INS.tableLinks(t, acs.vintage, geoid, esc);
    const tableOf = (field, fallback) => INS.tableFor(acs, field, fallback);
    // Every table the payer mix draws on (B27010, and the Medicaid table).
    const payerTables = [...new Set(INS.payers.flatMap(p => String(tableOf(p.field, 'B27010')).split('+')))].join('+');
    const foot = `<div class="popup-src">U.S. Census Bureau, American Community Survey 5-Year Estimates ${esc(acs.span)} ·
      ${esc(INS.universe)} · GEOID ${esc(geoid)} · estimates carry margins of error, shown on data.census.gov</div>`;
    const head = `<h3>${esc(name)}</h3>`;
    if (!row || row.pctUninsured == null) {
      const why = row && row.insUniverse === 0 ? ' (nobody here is in the survey universe)' : '';
      return `<div class="popup-profile popup-ins">${head}<p class="ins-empty">No health insurance estimates for this area${why}.</p>${foot}</div>`;
    }

    // ---- payer mix
    const payers = INS.payers.map(p => ({ ...p, value: row[p.field] }));
    const known = payers.every(p => p.value != null);
    const segs = known ? payers.filter(p => p.value >= 0.05).map(p =>
      `<span class="ins-seg" style="flex-grow:${p.value};background:var(--pm-${p.id})" title="${esc(p.label)}: ${pct(p.value)}"></span>`).join('') : '';
    const label = 'Payer mix: ' + payers.map(p => `${p.label} ${pct(p.value)}`).join(', ');
    const rows = payers.map(p => {
      const main = `<tr><td><span class="ins-key"><span class="swatch" style="background:var(--pm-${p.id})"></span>${esc(p.label)}</span></td><td class="num">${pct(p.value)}</td></tr>`;
      return p.id === 'medicaid' && row.pmDual != null
        ? main + `<tr class="ins-sub"><td>of which Medicare and Medicaid only (dual eligible)</td><td class="num">${pct(row.pmDual)}</td></tr>`
        : main;
    }).join('');
    const payerHTML = `<div class="ins-h">Payer mix <small>each person counted once</small></div>` +
      (known ? `<div class="ins-stack" role="img" aria-label="${esc(label)}">${segs}</div>` : '') +
      `<table class="ins-legend">${rows}</table>` +
      `<div class="ins-cite">ACS ${payerTables.includes('+') ? 'tables' : 'table'} ${table(payerTables)} · payer groups follow ${link('KFF', INS.kff.url)}'s hierarchy, adapted to the ACS tables (see Sources &amp; methodology)</div>`;

    // ---- insurance sources
    let group = null;
    const bars = INS.sources.map(s => {
      const v = row[s.field], t = tableOf(s.field, s.table);
      const heading = s.group !== group ? `<div class="ins-grp">${esc((group = s.group))}</div>` : '';
      const fill = v == null ? '' : `<span class="ins-fill" style="width:${Math.max(0, Math.min(100, v))}%"></span>`;
      return heading + `<span class="ins-lbl">${esc(s.label)}</span><span class="ins-track" title="${esc(s.label)}: ${pct(v)} (table ${esc(t)})">${fill}</span>` +
        `<span class="num">${pct(v)}</span><span class="ins-tbl">${table(t)}</span>`;
    }).join('');
    const sourcesHTML = `<div class="ins-h">Insurance sources <small>any coverage of the type, so shares overlap</small></div>` +
      `<div class="ins-bars">${bars}</div>`;

    return `<div class="popup-profile popup-ins">${head}
      <div class="ins-top"><strong>${pct(row.pctInsured)}</strong> insured · <strong>${pct(row.pctUninsured)}</strong> uninsured
        <span class="ins-of">of ${U.fmt.int(row.insUniverse)} people</span></div>
      ${payerHTML}${sourcesHTML}${foot}</div>`;
  };
})();
