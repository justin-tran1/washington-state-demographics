/* Washington Explorer — configuration
 * All data sources, metrics, categories and palette tokens live here.
 * Every endpoint is a public, keyless, CORS-enabled service; sources are
 * documented in the About panel (see SOURCES at the bottom of this file).
 */
(function () {
  'use strict';
  const WAMAP = (window.WAMAP = window.WAMAP || {});

  // ---------------------------------------------------------------- palette
  // CBRE brand palette. BRAND holds the official hex values exactly as
  // published in the CBRE brand guidelines; every other color in this app is
  // one of those values or a step derived from one of their OKLCH hues.
  const BRAND = {
    green: '#003F2D',          // CBRE Green — primary brand
    accentGreen: '#17E88F',    // Accent Green — highlights only, "use sparingly"
    darkGreen: '#012A2D',      // Dark Green — dark surfaces
    darkGrey: '#435254',       // Dark Grey — body text
    lightGrey: '#CAD1D3',      // Light Grey — borders, dividers
    midnight: '#032842', celadon: '#80BBAD', wheat: '#DBD99A', sage: '#538184',
    midnightTint: '#778F9C', sageTint: '#96B3B6', celadonTint: '#C0D4CB',
    cement: '#7F8480', wheatTint: '#EFECD2', cementTint: '#CBCDCB',
    dataOrange: '#D2785A', dataPurple: '#885073', dataLightPurple: '#A388BF',
    dataBlue: '#1F3765', dataLightBlue: '#3E7CA6',
    negativeRed: '#AD2A2A', positiveText: '#28573C', negativeText: '#A03530'
  };

  // Map-pin categories. Pins render as white chips with a colored ring and a
  // distinct emoji, so the emoji + label carry identity and color supports it.
  // Hues are CBRE hues; lightness is tuned so every ring clears 3:1 on white.
  // Worst ADJACENT pair in this list order: ΔE 15.7 (>= 15 floor).
  const AMENITY_COLORS = {
    schools: '#355fb2', colleges: '#9d427e', grocery: '#7d7808', restaurants: '#cb6441',
    retail: '#9667c1', pharmacy: '#0c8e7a', health: '#ab413c', banks: '#435254',
    fuel: '#0a7cb7', parks: '#06684d'
  };

  // Transit line colors. Legend order is chosen so the worst adjacent CVD pair
  // is maximised; each mode also carries a distinct dash pattern (see TRANSIT),
  // so mode is never conveyed by color alone.
  const TRANSIT_COLORS = {
    light: { bus: '#0977ba', lightRail: '#d9704d', metro: '#b15490', ferry: '#10a992', rail: '#087557' },
    dark:  { bus: '#1d87cd', lightRail: '#d66741', metro: '#b15490', ferry: '#10a992', rail: '#0a8664' }
  };

  // Crime density heat ramp — CBRE negative-red hue (26 deg), monotone
  // lightness. Shared by both themes (it sits on map tiles, not on a panel).
  const HEAT = { 0.25: '#f8d5d0', 0.45: '#e5b0aa', 0.62: '#d08d86', 0.78: '#bb6962', 0.9: '#a5453f', 1.0: '#8d1a1c' };

  // Theme-dependent sets. Every ramp below was generated in OKLCH at a CBRE
  // brand hue and checked with the dataviz validator; see README for the
  // recorded results. Sequential ramps pass monotone-lightness, step-gap and
  // single-hue; their end nearest the surface is allowed to recede because
  // that is what "near zero" means in a sequential encoding.
  const PALETTE = {
    brand: BRAND,
    heatGradient: HEAT,
    amenities: AMENITY_COLORS,
    status: {
      good: BRAND.positiveText, warning: '#8A6D0B',
      serious: BRAND.dataOrange, critical: BRAND.negativeRed
    },
    light: {
      // CBRE Green hue, light -> dark
      seqPrimary: ['#d9f2e7', '#accbbd', '#80a696', '#558270', '#2a5f4c', '#023d2c'],
      // Midnight hue, light -> dark (kept a different hue family from the
      // demographics ramp so the two choropleths never read alike)
      seqSecondary: ['#dceefd', '#aec5d9', '#819db6', '#557794', '#2b5373', '#013050'],
      // Discrete ordered bands at the Wheat hue (106 deg) - deliberately a
      // different hue family from BOTH choropleth ramps (green 167, blue 245),
      // because drive-time bands are large translucent fills that can sit on
      // top of a choropleth. Nearest band = most prominent. Passes the full
      // ordinal suite on a white surface.
      isochrone: { 5: '#6c681c', 10: '#8e8b47', 15: '#b2b074' },
      // Passes all-pairs CVD and normal-vision floors on white.
      crimeGroups: { person: '#b94641', property: '#1577b7', society: '#928d27', other: BRAND.cement },
      transit: TRANSIT_COLORS.light,
      // Payer mix, in bar order. The five payers are CBRE-hue steps that pass
      // the dataviz checks as adjacent stacked segments (worst CVD ΔE 18.9,
      // normal-vision 19.3, all >= 3:1 on white); "other" recedes and
      // "uninsured" stands out as neutrals, with values always listed beside
      // the bar. Same hue per payer in both themes.
      payer: { employer: '#355fb2', direct: '#7d7808', medicare: '#9667c1', medicaid: '#d9704d', military: '#9d427e',
        other: BRAND.cementTint, uninsured: BRAND.darkGrey },
      insBar: '#557794', insTrack: '#e8eef3',
      noData: BRAND.cementTint,
      hoverOutline: BRAND.darkGreen
    },
    dark: {
      seqPrimary: ['#dcf5ea', '#b3d3c5', '#8ab2a1', '#62927e', '#3a735e', '#05553e'],
      seqSecondary: ['#e1f1ff', '#b6cee3', '#8dacc6', '#668baa', '#406a8e', '#164b72'],
      // Same three validated steps, reversed: on the dark surface the
      // brightest band is the one that reads as nearest.
      isochrone: { 5: '#b2b074', 10: '#8e8b47', 15: '#6c681c' },
      crimeGroups: { person: '#a53330', property: '#2b87c8', society: '#9d970d', other: BRAND.sageTint },
      transit: TRANSIT_COLORS.dark,
      // Worst adjacent CVD ΔE 16.7, normal-vision 19.0, all >= 3:1 on the
      // dark surface (military re-stepped to clear orange).
      payer: { employer: '#1d87cd', direct: '#9d970d', medicare: '#9667c1', medicaid: '#d66741', military: '#c42f97',
        other: '#464f50', uninsured: BRAND.cementTint },
      insBar: '#8dacc6', insTrack: '#12393c',
      noData: '#2b484a',
      hoverOutline: '#ffffff'
    }
  };

  // ------------------------------------------------------------------- map
  const MAP = {
    center: [47.35, -120.7],
    zoom: 7,
    minZoom: 5,
    maxZoom: 19,
    // Washington state with generous padding
    maxBounds: [[43.6, -129.5], [51.5, -112.0]],
    waBounds: { south: 45.53, west: -124.85, north: 49.01, east: -116.90 },
    tractZoom: 9 // choropleths switch county -> tract at this zoom
  };

  // Attribution strings are the exact text each provider asks for.
  const ATTR_OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const ATTR_ESRI_CANVAS = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community';
  const ATTR_USGS = 'Tiles courtesy of the <a href="https://www.usgs.gov/">U.S. Geological Survey</a> &mdash; The National Map';

  // Transparent label / reference layers. These are drawn in their own Leaflet
  // pane ABOVE the data layers, so place names stay readable through a
  // choropleth instead of being buried by it.
  const LABEL_LAYERS = {
    esriLightRef: {
      label: 'Esri light reference',
      urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
      options: { maxZoom: 19, maxNativeZoom: 16 }
    },
    esriDarkRef: {
      label: 'Esri dark reference',
      urls: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
      options: { maxZoom: 19, maxNativeZoom: 16 }
    },
    esriImageryRef: {
      label: 'Esri places & roads',
      urls: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
        'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'
      ],
      options: { maxZoom: 19 }
    }
  };

  // Base maps, grouped for the picker. Every entry is keyless and CORS-enabled.
  // `native` is Leaflet's maxNativeZoom: tiles stop at that level and are
  // upsampled beyond it, which keeps the map usable past a service's real
  // cache depth instead of going blank.
  // `labels` names the transparent reference layer that pairs with the base.
  // NOTE ON TILE URL AXIS ORDER: every ArcGIS-hosted service below uses
  // /tile/{z}/{y}/{x} (row before column), the reverse of the OSM {z}/{x}/{y}
  // convention. Swapping them yields a plausible-looking but scrambled map
  // rather than an obvious error, so do not "tidy" these into {x}/{y}.
  const BASEMAP_GROUPS = ['Street', 'Analysis canvas', 'Aerial imagery', 'Terrain & topographic', 'Thematic'];
  const BASEMAPS = [
    // ---- Street ---------------------------------------------------------
    { id: 'osm', label: 'OpenStreetMap', group: 'Street',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 19, attribution: ATTR_OSM },
      note: 'Community-maintained and the most current street data here.' },
    { id: 'esri-street', label: 'Esri Streets', group: 'Street',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, METI, and the GIS user community' },
      note: 'Esri legacy raster service (Mature Support): cartography is frozen at 2021.' },
    { id: 'osm-hot', label: 'OSM Humanitarian', group: 'Street',
      url: 'https://tile-{s}.openstreetmap.fr/hot/{z}/{x}/{y}.png',
      options: { maxZoom: 20, subdomains: 'abc', attribution: ATTR_OSM + ', tiles by <a href="https://www.hotosm.org/">HOT</a>, hosted by <a href="https://openstreetmap.fr/">OSM France</a>' },
      note: 'High-contrast OSM style; reads well at high zoom.' },

    // ---- Analysis canvas ------------------------------------------------
    { id: 'esri-light-gray', label: 'Light Gray Canvas', group: 'Analysis canvas',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: ATTR_ESRI_CANVAS },
      labels: 'esriLightRef',
      note: 'Built by Esri to sit under thematic data - the best backdrop for the choropleth layers.' },
    { id: 'esri-dark-gray', label: 'Dark Gray Canvas', group: 'Analysis canvas',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: ATTR_ESRI_CANVAS },
      labels: 'esriDarkRef',
      note: 'Dark analysis canvas; pairs with the CBRE dark theme.' },

    // ---- Aerial imagery -------------------------------------------------
    { id: 'esri-imagery', label: 'Esri World Imagery', group: 'Aerial imagery',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
      labels: 'esriImageryRef',
      note: 'Still actively maintained by Esri; turn labels on for a hybrid view.' },
    { id: 'usgs-imagery', label: 'USGS Imagery (NAIP)', group: 'Aerial imagery',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: ATTR_USGS },
      labels: 'esriImageryRef',
      note: 'U.S. federal imagery, public domain - the cleanest licensing of any layer here.' },
    { id: 'usgs-imagery-topo', label: 'USGS Imagery + Topo', group: 'Aerial imagery',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: ATTR_USGS },
      note: 'Federal imagery with topographic names and contours burned in.' },

    // ---- Terrain & topographic -----------------------------------------
    { id: 'usgs-topo', label: 'USGS Topo', group: 'Terrain & topographic',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: ATTR_USGS },
      note: 'The classic USGS quad cartography, public domain.' },
    { id: 'usgs-relief', label: 'USGS Shaded Relief', group: 'Terrain & topographic',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, maxNativeZoom: 15, attribution: ATTR_USGS },
      labels: 'esriImageryRef',
      note: 'Terrain only - useful for reading the Cascades and Olympics behind data layers.' },
    { id: 'opentopomap', label: 'OpenTopoMap', group: 'Terrain & topographic',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 17, maxNativeZoom: 15, subdomains: 'abc', attribution: 'Map data: ' + ATTR_OSM + ', <a href="https://viewfinderpanoramas.org">SRTM</a> | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)' },
      note: 'Contours and hillshade. Volunteer-run server - please go easy on it.' },
    { id: 'esri-topo', label: 'Esri Topographic', group: 'Terrain & topographic',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, DeLorme, NAVTEQ, TomTom, USGS, NPS, NRCAN, and the GIS user community' },
      note: 'Esri legacy raster service (Mature Support): frozen at 2021.' },

    { id: 'usgs-hydro', label: 'USGS Hydrography', group: 'Terrain & topographic',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 19, maxNativeZoom: 16, attribution: ATTR_USGS },
      labels: 'esriImageryRef',
      note: 'Rivers, lakes and wetlands - flood and waterfront context.' },

    // ---- Thematic -------------------------------------------------------
    { id: 'wsdot-base', label: 'WSDOT Washington base', group: 'Thematic',
      url: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/WebBaseMapWebMercator/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 18, maxNativeZoom: 16, attribution: 'Washington State Department of Transportation' },
      note: 'WSDOT\'s own state base map. Washington only - blank outside the state.',
      waOnly: true },
    { id: 'opnvkarte', label: 'Transit (OPNVKarte)', group: 'Thematic',
      url: 'https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png',
      options: { maxZoom: 18, attribution: 'Map <a href="https://memomaps.de/">memomaps.de</a> (<a href="https://creativecommons.org/licenses/by-sa/2.0/">CC-BY-SA</a>), map data ' + ATTR_OSM },
      note: 'Renders transit lines and stops in the basemap itself.' },
    { id: 'cyclosm', label: 'CyclOSM (bike)', group: 'Thematic',
      url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
      options: { maxZoom: 20, subdomains: 'abc', attribution: '<a href="https://www.cyclosm.org/">CyclOSM</a>, hosted by <a href="https://openstreetmap.fr/">OSM France</a> | Map data ' + ATTR_OSM },
      note: 'Cycling infrastructure, useful as a walkability/bikeability proxy.' }
  ];

  // ---------------------------------------------------------------- census
  // ACS 5-year estimates are built at deploy time (scripts/build-data/acs.mjs)
  // and served same-origin; the newest published vintage is picked up
  // automatically on the monthly rebuild.
  const CENSUS = {
    stateFips: '53',
    prebuilt: { county: 'data/acs/county.json', tract: 'data/acs/tract.json' }
  };

  // TIGERweb generalized (cartographic) boundaries, one service per ACS vintage.
  const TIGERWEB = {
    roots: [
      'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2024',
      'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2023',
      'https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2022',
      // Detailed (non-generalized) current-vintage services as a last resort.
      'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb'
    ],
    tractService: 'Tracts_Blocks/MapServer',
    tractLayerName: /census tracts/i,
    countyService: 'State_County/MapServer',
    countyLayerName: /counties/i,
    localCounties: 'data/wa_counties.geojson',
    // Same-origin boundaries written by the "Build map data" Action.
    prebuilt: { county: 'data/geo/counties.json', tract: 'data/geo/tracts.json' }
  };

  const SQMI_PER_SQM = 1 / 2589988.110336;

  // Demographic metrics. `value(d)` receives the derived record built in
  // censusStore; land area (sq meters) is merged from boundary attributes.
  const DEMO_METRICS = [
    { id: 'density', label: 'Population density', unit: '/sq mi', fmt: 'int',
      value: d => (d.pop != null && d.aland > 0 ? d.pop / (d.aland * SQMI_PER_SQM) : null),
      needsArea: true, desc: 'People per square mile of land area (ACS B01003 / TIGER land area).' },
    { id: 'pop', label: 'Total population', unit: '', fmt: 'int',
      value: d => d.pop, desc: 'Total population (ACS table B01003).' },
    { id: 'income', label: 'Median household income', unit: '$', fmt: 'money',
      value: d => d.medInc, desc: 'Median household income in the past 12 months (ACS table B19013).' },
    { id: 'age', label: 'Median age', unit: 'yrs', fmt: 'num1',
      value: d => d.medAge, desc: 'Median age (ACS table B01002).' },
    { id: 'edu', label: "Bachelor's degree or higher", unit: '%', fmt: 'pct1',
      value: d => d.pctBach, desc: "Share of population 25+ with a bachelor's degree or higher (ACS table B15003)." },
    { id: 'homeValue', label: 'Median home value', unit: '$', fmt: 'money',
      value: d => d.medHome, desc: 'Median value of owner-occupied housing units (ACS table B25077).' },
    { id: 'rent', label: 'Median gross rent', unit: '$', fmt: 'money',
      value: d => d.medRent, desc: 'Median gross rent (ACS table B25064).' },
    { id: 'poverty', label: 'Poverty rate', unit: '%', fmt: 'pct1',
      value: d => d.pctPoverty, desc: 'Share of the poverty universe below the poverty level (ACS table B17001).' },
    { id: 'unemp', label: 'Unemployment rate', unit: '%', fmt: 'pct1',
      value: d => d.pctUnemp, desc: 'Unemployed share of the civilian labor force (ACS table B23025).' },
    { id: 'owner', label: 'Owner-occupied share', unit: '%', fmt: 'pct1',
      value: d => d.pctOwner, desc: 'Owner-occupied share of occupied housing units (ACS table B25003).' }
  ];

  // Health insurance, for the civilian noninstitutionalized population.
  // Payer mix counts each person once (ACS table B27010, grouped as KFF
  // does); insurance sources count everyone holding each type of coverage,
  // alone or with others, so they overlap (ACS tables B27002 and B27003, and
  // C27004-C27009: the 5-year estimates publish the single-type tables
  // collapsed). Tables below are defaults: the data file records the table
  // behind each field, and that is what the map cites.
  const INSURANCE = {
    universe: 'civilian noninstitutionalized population',
    kff: { label: 'KFF, Health Insurance Coverage of the Total Population',
      url: 'https://www.kff.org/state-health-policy-data/state-indicator/total-population/' },
    glossary: { label: 'U.S. Census Bureau, Health Insurance Glossary',
      url: 'https://www.census.gov/topics/health/health-insurance/about/glossary.html' },
    /** The ACS table behind a field, as the data file records it (else the default). */
    tableFor(acs, field, fallback) {
      return (acs && acs.insurance && acs.insurance.tables && acs.insurance.tables[field]) || fallback;
    },
    /** Links to each table in "B27010" or "B27010+C27007", on data.census.gov. */
    tableLinks(tables, vintage, geoid, esc) {
      return String(tables).split('+').map(t =>
        `<a href="${esc(this.tableUrl(t, vintage, geoid))}" target="_blank" rel="noopener">${esc(t)}</a>`).join(' + ');
    },
    /** data.census.gov table page for an ACS 5-year detailed table, at one area. */
    tableUrl(table, vintage, geoid) {
      const g = !geoid ? '040XX00US53' : geoid.length === 5 ? '050XX00US' + geoid : '1400000US' + geoid;
      return `https://data.census.gov/table/ACSDT5Y${vintage}.${table}?g=${g}`;
    },
    payers: [
      { id: 'employer', field: 'pmEmployer', label: 'Employer-sponsored',
        desc: 'Coverage through a current or former employer or union (own or a family member\'s), alone or with direct-purchase coverage.' },
      { id: 'direct', field: 'pmDirect', label: 'Direct-purchase',
        desc: 'Only a plan bought directly from an insurance company (KFF: "non-group").' },
      { id: 'medicare', field: 'pmMedicare', label: 'Medicare',
        desc: 'Medicare without Medicaid: Medicare alone, or with employer or direct-purchase coverage.' },
      { id: 'medicaid', field: 'pmMedicaid', label: 'Medicaid',
        desc: 'Everyone with Medicaid or another means-tested public plan (Apple Health in Washington), whatever other coverage they have, dual eligibles included.' },
      { id: 'military', field: 'pmMilitary', label: 'Military (TRICARE, VA)',
        desc: 'Only TRICARE/military health coverage, or only VA health care.' },
      { id: 'other', field: 'pmOther', label: 'Other combinations',
        desc: 'Coverage combinations table B27010 does not break down and that include no Medicaid, such as Medicare with both employer and direct-purchase coverage, or TRICARE with employer coverage.' },
      { id: 'uninsured', field: 'pctUninsured', label: 'Uninsured',
        desc: 'No health insurance coverage (Indian Health Service alone does not count as coverage).' }
    ],
    // `label` in the profile's bar list, `metric` as a map metric.
    sources: [
      { group: 'Private', field: 'srcPrivate', label: 'Any private', metric: 'Private coverage (any type)', table: 'B27002',
        what: 'private coverage of any type (employer-based, direct-purchase or TRICARE)' },
      { group: 'Private', field: 'srcEmployer', label: 'Employer-based', metric: 'Employer-based coverage', table: 'C27004',
        what: 'employer-based coverage (a current or former employer or union, their own or a family member\'s)' },
      { group: 'Private', field: 'srcDirect', label: 'Direct-purchase', metric: 'Direct-purchase coverage', table: 'C27005',
        what: 'a plan bought directly from an insurance company' },
      { group: 'Private', field: 'srcTricare', label: 'TRICARE/military', metric: 'TRICARE/military coverage', table: 'C27008',
        what: 'TRICARE or other military health coverage' },
      { group: 'Public', field: 'srcPublic', label: 'Any public', metric: 'Public coverage (any type)', table: 'B27003',
        what: 'public coverage of any type (Medicare, Medicaid/means-tested or VA)' },
      { group: 'Public', field: 'srcMedicare', label: 'Medicare', metric: 'Medicare coverage', table: 'C27006', what: 'Medicare' },
      { group: 'Public', field: 'srcMedicaid', label: 'Medicaid/means-tested', metric: 'Medicaid/means-tested coverage', table: 'C27007',
        what: 'Medicaid or another means-tested public plan (Apple Health in Washington)' },
      { group: 'Public', field: 'srcVA', label: 'VA health care', metric: 'VA health care', table: 'C27009', what: 'VA health care' }
    ]
  };

  const PM = 'Payer mix (each person counted once)', SRC = 'Insurance sources (any coverage of the type)';
  const INSURANCE_METRICS = [
    { id: 'uninsured', group: 'Coverage', label: 'Uninsured rate', unit: '%', fmt: 'pct1', table: 'B27010', field: 'pctUninsured',
      value: d => d.pctUninsured, desc: 'Civilian noninstitutionalized population without health insurance coverage (ACS detailed table B27010; the same measure as subject table S2701).' },
    { id: 'insured', group: 'Coverage', label: 'Insured rate', unit: '%', fmt: 'pct1', table: 'B27010', field: 'pctInsured',
      value: d => d.pctInsured, desc: 'Civilian noninstitutionalized population with health insurance coverage (ACS detailed table B27010; the same measure as subject table S2701).' },
    ...INSURANCE.payers.filter(p => p.id !== 'uninsured').map(p => ({
      id: 'pm-' + p.id, group: PM, label: 'Payer mix: ' + p.label, short: p.label, tip: p.label + ' (payer mix)', unit: '%', fmt: 'pct1', table: 'B27010', field: p.field,
      note: 'each person counted once', value: d => d[p.field],
      desc: p.desc + ' Each person is counted once, in payer groups as KFF defines them (ACS tables B27010 and, for Medicaid, C27007; the legend links them; see Sources & methodology).'
    })),
    { id: 'pm-dual', group: PM, label: 'Payer mix: dual eligible (Medicare and Medicaid only)', short: 'Dual eligible (Medicare and Medicaid only)', tip: 'Dual eligible (Medicare and Medicaid only)', unit: '%', fmt: 'pct1', table: 'B27010', field: 'pmDual',
      note: 'part of the Medicaid share', value: d => d.pmDual,
      desc: 'People whose coverage is Medicare and Medicaid and nothing else, part of the Medicaid share (ACS table B27010; dual eligibles who also hold a third type are not separated).' },
    ...INSURANCE.sources.map(s => ({
      id: 'src-' + s.field.slice(3).toLowerCase(), group: SRC, label: s.metric, short: s.label, unit: '%', fmt: 'pct1', table: s.table, field: s.field,
      note: 'alone or with other coverage, so shares overlap', value: d => d[s.field],
      desc: `Share of people with ${s.what}, alone or with other coverage, so these shares add up to more than 100% (ACS table ${s.table}; the legend names the table used).`
    }))
  ];

  // -------------------------------------------------------------- geocoding
  // Address search. The U.S. Census geocoder was dropped from the browser
  // path: it sends no Access-Control-Allow-Origin header, so browsers can
  // never read its responses and every search silently fell back. Esri's
  // World Geocoder answers keyless with CORS for display (non-stored) use.
  const GEOCODE = {
    esriFind: 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates',
    nominatimSearch: 'https://nominatim.openstreetmap.org/search',
    nominatimReverse: 'https://nominatim.openstreetmap.org/reverse',
    // west,north,east,south per Nominatim viewbox convention (left,top,right,bottom)
    viewbox: '-124.85,49.01,-116.90,45.53',
    // xmin,ymin,xmax,ymax for Esri's searchExtent
    esriExtent: '-124.85,45.53,-116.90,49.01',
    minIntervalMs: 1100
  };

  // --------------------------------------------------------------- overpass
  // Only the transit layer's fallback still queries Overpass live. The other
  // public mirrors (kumi.systems, private.coffee) stopped answering in 2026.
  const OVERPASS = {
    endpoints: ['https://overpass-api.de/api/interpreter'],
    timeoutS: 40
  };

  // -------------------------------------------------------------- amenities
  // One statewide file per category, pre-built by the "Build map data"
  // GitHub Action (scripts/build-data/amenities.mjs). `featured` kinds are
  // drawn larger and never clustered; `kindEmoji` picks a marker per kind.
  const AMENITY_DATA_DIR = 'data/amenities/';
  const AMENITIES = [
    { id: 'schools', label: 'Schools (K-12)', emoji: '🏫', colorToken: 'schools' },
    { id: 'colleges', label: 'Colleges & universities', emoji: '🎓', colorToken: 'colleges' },
    // About two thirds of SNAP-authorized food retailers are convenience stores.
    { id: 'grocery', label: 'Grocery & convenience stores', emoji: '🛒', colorToken: 'grocery',
      kindEmoji: [[/convenience/i, '🏪']] },
    { id: 'restaurants', label: 'Restaurants & cafes', emoji: '🍽️', colorToken: 'restaurants',
      kindEmoji: [[/cafe|coffee/i, '☕']] },
    { id: 'retail', label: 'Retail & shopping', emoji: '🛍️', colorToken: 'retail' },
    { id: 'pharmacy', label: 'Pharmacies', emoji: '💊', colorToken: 'pharmacy' },
    { id: 'health', label: 'Hospitals & clinics', emoji: '🏥', colorToken: 'health',
      // Not "Community health center (on a hospital campus)": that is a clinic.
      featured: /^(?!community health center).*(hospital|emergency)/i, featuredLabel: 'hospitals',
      kindEmoji: [[/^(?!community health center).*(hospital|emergency)/i, '🏥'], [/./, '🩺']] },
    { id: 'banks', label: 'Banks & credit unions', emoji: '🏦', colorToken: 'banks' },
    { id: 'fuel', label: 'Fuel & EV charging', emoji: '⛽', colorToken: 'fuel',
      kindEmoji: [[/EV|charging/i, '🔌']] },
    { id: 'parks', label: 'Parks & playgrounds', emoji: '🌳', colorToken: 'parks' }
  ];
  const AMENITIES_DEFAULT_ON = ['schools', 'grocery', 'health'];

  // ---------------------------------------------------------------- transit
  const TRANSIT = {
    wsdotService: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer',
    // Agency websites and per-route schedule pages, read from every agency's
    // GTFS feed (agency.txt / routes.txt) by scripts/build-data/transit.mjs.
    agencyData: 'data/transit/agencies.json',
    // Fallback when that file is missing or an agency is not in it:
    // [pattern tested against the agency name, official website].
    agencyLinks: [
      [/king county metro|^metro transit|kcm\b/i, 'https://kingcounty.gov/en/dept/metro'],
      [/water taxi/i, 'https://kingcounty.gov/en/dept/metro/travel-options/water-taxi'],
      [/sound transit/i, 'https://www.soundtransit.org'],
      [/community transit/i, 'https://www.communitytransit.org'],
      [/everett transit/i, 'https://everetttransit.org'],
      [/pierce transit/i, 'https://www.piercetransit.org'],
      [/intercity transit/i, 'https://www.intercitytransit.com'],
      [/kitsap transit/i, 'https://www.kitsaptransit.com'],
      [/spokane transit|\bsta\b/i, 'https://www.spokanetransit.com'],
      [/c-?tran\b/i, 'https://www.c-tran.com'],
      [/ben franklin/i, 'https://www.bft.org'],
      [/whatcom|\bwta\b/i, 'https://www.ridewta.com'],
      [/skagit transit/i, 'https://www.skagittransit.org'],
      [/island transit/i, 'https://www.islandtransit.org'],
      [/link transit/i, 'https://www.linktransit.com'],
      [/valley transit/i, 'https://www.valleytransit.com'],
      [/mason transit/i, 'https://www.masontransit.org'],
      [/jefferson transit/i, 'https://jeffersontransit.com'],
      [/clallam transit/i, 'https://www.clallamtransit.com'],
      [/grays harbor/i, 'https://www.ghtransit.com'],
      [/twin transit/i, 'https://twintransit.org'],
      [/seattle (center )?monorail/i, 'https://www.seattlemonorail.com'],
      [/seattle streetcar/i, 'https://www.seattle.gov/transportation/getting-around/transit/streetcar'],
      [/washington state ferries|\bwsf\b/i, 'https://wsdot.wa.gov/travel/washington-state-ferries'],
      [/amtrak/i, 'https://www.amtrakcascades.com'],
      [/asotin county ptba|lewiston transit/i, 'https://ridethevalley.org'],
      [/lewis county transit|twin transit/i, 'https://lewiscountytransit.org']
    ],
    ferryWebsite: 'https://wsdot.wa.gov/travel/washington-state-ferries',
    ferryService: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/FerryRoutes/MapServer',
    routeLayerName: /route/i,
    stopLayerName: /stop/i,
    stopsMinZoom: 13,
    routesMinZoom: 8,
    // GTFS route_type -> display
    modes: {
      0:  { label: 'Streetcar / tram', token: 'lightRail', weight: 3, dash: '6 3' },
      1:  { label: 'Metro',            token: 'metro',     weight: 3, dash: '2 4' },
      2:  { label: 'Rail (Amtrak / Sounder)', token: 'rail', weight: 3, dash: '10 4' },
      3:  { label: 'Bus',              token: 'bus',       weight: 2 },
      4:  { label: 'Ferry',            token: 'ferry',     weight: 3, dash: '4 6' },
      5:  { label: 'Cable car',        token: 'metro',     weight: 3, dash: '2 4' },
      6:  { label: 'Gondola',          token: 'metro',     weight: 3, dash: '2 4' },
      7:  { label: 'Funicular',        token: 'metro',     weight: 3, dash: '2 4' },
      12: { label: 'Monorail',         token: 'lightRail', weight: 3, dash: '8 3 2 3' },
      bus: 3, ferry: 4, light_rail: 0, tram: 0, train: 2, subway: 1, monorail: 12
    }
  };

  // ------------------------------------------------------------------ crime
  const CRIME = {
    ranges: [
      { id: 30, label: 'Last 30 days' },
      { id: 90, label: 'Last 90 days' },
      { id: 180, label: 'Last 6 months' },
      { id: 365, label: 'Last 12 months' }
    ],
    defaultRange: 90,
    maxPerCity: 80000, // Seattle alone reports ~76k offenses a year
    // Category rules are applied (in order) against UPPERCASED
    // "offense || parent group" text from each source, so one rule set covers
    // every feed. First match wins.
    categories: [
      { id: 'homicide', label: 'Homicide', group: 'person', re: /HOMICIDE|MURDER|MANSLAUGHTER/ },
      { id: 'sexoff', label: 'Sex offenses', group: 'person', re: /RAPE|SODOMY|FONDLING|SEX OFFENSE|SEXUAL|INDECENT|PEEPING|PORNOGRAPHY|HUMAN TRAFFICKING|VOYEUR/ },
      { id: 'robbery', label: 'Robbery', group: 'person', re: /ROBBERY/ },
      { id: 'kidnap', label: 'Kidnapping', group: 'person', re: /KIDNAP|ABDUCTION/ },
      { id: 'assault', label: 'Assault', group: 'person', re: /ASSAULT|INTIMIDATION|HARASSMENT|THREAT|STALK/ },
      { id: 'arson', label: 'Arson', group: 'property', re: /ARSON/ },
      // "Theft From Motor Vehicle" / "Vehicle Prowl" are larceny, not MVT.
      { id: 'mvt', label: 'Motor vehicle theft', group: 'property', re: /MOTOR VEHICLE THEFT|AUTO THEFT|VEHICLE THEFT|STOLEN VEHICLE|THEFT - (MOTOR )?VEHICLE(\|\||$)|TAKING (A )?MOTOR VEHICLE/ },
      { id: 'burglary', label: 'Burglary / B&E', group: 'property', re: /BURGLARY|BREAKING/ },
      // Before theft: "Identity Theft" and NIBRS "False Pretenses/Swindle" are fraud.
      { id: 'fraud', label: 'Fraud / forgery', group: 'property', re: /FRAUD|FORGERY|COUNTERFEIT|EMBEZZLE|EXTORTION|BLACKMAIL|BAD CHECK|IDENTITY|FALSE PRETENSE|SWINDLE|CONFIDENCE GAME|IMPERSONAT|HACKING|COMPUTER INVASION/ },
      { id: 'theft', label: 'Larceny / theft', group: 'property', re: /LARCENY|THEFT|SHOPLIFT|PICKPOCKET|POCKET.?PICK|PURSE|STOLEN PROPERTY|PROWL/ },
      { id: 'vandalism', label: 'Vandalism / property damage', group: 'property', re: /VANDALISM|DESTRUCTION|DAMAGE|MALICIOUS MISCHIEF|CRIMINAL MISCHI|GRAFFITI/ },
      { id: 'drugs', label: 'Drugs / narcotics', group: 'society', re: /DRUG|NARCOTIC|VUCSA|CONTROLLED SUBSTANCE/ },
      { id: 'weapons', label: 'Weapons', group: 'society', re: /WEAPON|FIREARM/ },
      { id: 'dui', label: 'DUI', group: 'society', re: /DUI|DRIVING UNDER/ },
      { id: 'trespass', label: 'Trespass', group: 'society', re: /TRESPASS/ },
      { id: 'other', label: 'Other offenses', group: 'other', re: /./ }
    ],
    defaultOn: ['homicide', 'sexoff', 'robbery', 'kidnap', 'assault', 'arson', 'mvt', 'burglary', 'theft', 'vandalism'],
    // Every agency in the state: annual NIBRS counts compiled by WASPC,
    // pre-built by scripts/build-data/crime.mjs.
    statewide: {
      file: 'data/crime/agencies.json',
      // Categories the statewide counts cannot split out (see crime.mjs).
      notCounted: {
        mvt: 'counted under theft', fraud: 'fraud itself is counted under theft; only forgery and extortion are split out',
        dui: 'arrest-only (Group B)', trespass: 'arrest-only (Group B)'
      }
    },
    // Incident-level feeds. 'socrata' / 'arcgis' are queried live by the
    // browser; 'prebuilt' feeds publish block addresses only and are
    // geocoded ahead of time into data/crime/.
    cities: [
      {
        id: 'seattle', label: 'Seattle', type: 'socrata',
        domains: ['https://data.seattle.gov', 'https://cos-data.seattle.gov'],
        dataset: 'tazs-3rd5',
        // SPD has republished this dataset with new column names. Candidates
        // are matched against the live column list (first existing name wins;
        // every existing "offense" column feeds classification).
        fieldCandidates: {
          date: ['offense_date', 'offense_start_datetime', 'report_date_time', 'report_datetime'],
          offense: ['nibrs_offense_code_description', 'offense', 'offense_sub_category', 'offense_category',
            'offense_parent_group', 'nibrs_crime_against_category', 'crime_against_category'],
          lat: ['latitude'], lon: ['longitude'],
          addr: ['block_address', '_100_block_address'],
          area: ['neighborhood', 'mcpp']
        },
        // Known schemas, tried in order only if the metadata endpoint is unreachable.
        schemas: [
          { date: 'offense_date', offense: ['nibrs_offense_code_description', 'offense_category'],
            lat: 'latitude', lon: 'longitude', addr: 'block_address', area: 'neighborhood' },
          { date: 'offense_start_datetime', offense: ['offense', 'offense_parent_group'],
            lat: 'latitude', lon: 'longitude', addr: '_100_block_address', area: 'mcpp' }
        ],
        link: 'https://data.seattle.gov/Public-Safety/SPD-Crime-Data-2008-Present/tazs-3rd5',
        note: 'Seattle PD NIBRS offenses, updated daily; locations generalized to the 100 block. SPD redacts the location of most homicides and sex offenses.'
      },
      {
        id: 'tacoma', label: 'Tacoma', type: 'arcgis',
        url: 'https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/TPD_RMS_Crime/FeatureServer/0',
        fields: { date: 'DateOccurred', offense: ['Description', 'Offense_Category'], addr: 'Address', lat: 'Latitude', lon: 'Longitude' },
        link: 'https://data.cityoftacoma.org/datasets/a27ad2206f16467793c17d33422c3e91',
        note: 'Tacoma PD reported crime, updated each business day. Tacoma excludes domestic-violence and sex offenses from its public data.'
      },
      {
        id: 'kcso', label: 'King County Sheriff', type: 'prebuilt', file: 'data/crime/kcso.json',
        link: 'https://data.kingcounty.gov/Law-Enforcement-Safety/KCSO-Offense-Reports-2020-to-Present/4kmt-kfqf',
        note: "King County Sheriff's Office NIBRS offenses: unincorporated King County and contract cities (Burien, Shoreline, SeaTac, Sammamish, Kenmore, Woodinville, Covington, Maple Valley and others). Block addresses geocoded by the Census Bureau; refreshed weekly."
      },
      {
        id: 'bellevue', label: 'Bellevue', type: 'arcgis',
        url: 'https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Offenses/FeatureServer/1',
        fields: { date: 'FROM_DATE', offense: ['LEGEND', 'STAT_KEYWORD'], lat: 'LATITUDE', lon: 'LONGITUDE' },
        link: 'https://data.bellevuewa.gov/',
        note: 'Bellevue PD offenses (NIBRS). Some records are published without a location.'
      },
      {
        id: 'redmond', label: 'Redmond', type: 'arcgis',
        url: 'https://gis.redmond.gov/arcgis/rest/services/CrimeMap/Crimes/FeatureServer/0',
        fields: { date: 'DateTimeReported', offense: ['OffenseDescription', 'UCR_Description', 'WebSubType'], addr: 'FilteredAddress' },
        link: 'https://www.redmond.gov/1232/Crime-Map',
        note: 'Redmond PD crime map data (rolling 12 months); sensitive offenses omitted by the city.'
      },
      {
        id: 'kirkland', label: 'Kirkland', type: 'arcgis',
        url: 'https://maps.kirklandwa.gov/host/rest/services/Hosted/CrimeAnalysis_(Public)/FeatureServer/2',
        fields: { date: 'from_date', offense: ['nibrs_desc', 'cm_nibrs_desc'], addr: 'block_address' },
        link: 'https://www.kirklandwa.gov/Government/Departments/Police',
        note: 'Kirkland PD public crime-map offenses (NIBRS).'
      },
      {
        id: 'auburn', label: 'Auburn', type: 'prebuilt', file: 'data/crime/auburn.json',
        link: 'https://data.auburnwa.gov/Public-Safety/Crimes/8g4u-7zzy',
        note: 'Auburn PD case reports with non-criminal case types removed. Auburn publishes exact addresses, so each report is generalized to its block before it is geocoded (Census Bureau) and published, and sex offenses, child abuse, protection-order violations, stalking and kidnapping are withheld. Refreshed weekly.'
      },
      {
        id: 'everett', label: 'Everett', type: 'socrata',
        domains: ['https://data.everettwa.gov'], dataset: 'szww-y224',
        fields: { date: 'datetimereceived', offense: ['case'], point: 'geomcoordinate', addr: 'occurredlocationby100block', area: 'neighborhood' },
        link: 'https://data.everettwa.gov/Public-Safety/Police-Cases/szww-y224',
        note: 'Everett PD case reports, updated daily. Everett excludes domestic-violence, child-abuse and minor sex cases.'
      },
      {
        id: 'pierce', label: 'Pierce County Sheriff', type: 'arcgis',
        url: 'https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Crime_Data/FeatureServer/1',
        fields: { date: 'OccurredOn', offense: ['Public_Nam'], addr: 'City' },
        link: 'https://open.piercecountywa.gov/',
        note: "Pierce County Sheriff's Department offenses, rolling 12 months, updated monthly: unincorporated Pierce County and the contract cities Edgewood and University Place (cities with their own police, such as Puyallup, Bonney Lake and Gig Harbor, are not included). Locations approximate."
      },
      {
        id: 'yakima', label: 'Yakima', type: 'arcgis',
        url: 'https://services5.arcgis.com/drBwGNA3YMS2QPJd/arcgis/rest/services/Crimes_public_fc349e427d9945729c4e985666b31686/FeatureServer/0',
        fields: { date: 'reportdate', offense: ['nibrsdesc'], addr: 'neighborhood' },
        link: 'https://ypddata.yakimawa.gov/datasets/yakima::crimes-public/about',
        note: 'Yakima PD NIBRS offenses, updated daily.'
      }
    ]
  };

  // ------------------------------------------------------------- drive time
  const ISOCHRONE = {
    endpoints: ['https://valhalla1.openstreetmap.de/isochrone'],
    clientId: 'justin-tran1.github.io/washington-state-demographics',
    minutes: [5, 10, 15],
    costing: 'auto',
    denoise: 0.35,
    generalize: 60
  };

  // ------------------------------------------------- radius & area search
  const AREAS = {
    defaultRadiusM: 1609.344,   // 1 mile, the usual first trade-area ring
    minRadiusM: 10,
    maxRadiusM: 80467,          // 50 miles
    units: {
      mi: { label: 'mi', m: 1609.344 }, km: { label: 'km', m: 1000 },
      m: { label: 'm', m: 1 }, ft: { label: 'ft', m: 0.3048 }
    },
    defaultUnit: 'mi',
    // New shapes take these in turn: CBRE data colours, mid lightness so an
    // outline reads on light, dark and imagery base maps alike.
    colors: ['#3E7CA6', '#D2785A', '#885073', '#0C8E7A', '#AB413C', '#7D7808'],
    fillOpacity: 0.15,
    weight: 2,
    listPage: 100               // result rows shown per group before "Show more"
  };

  // ----------------------------------------------------------------- zoning
  // Washington State Zoning Atlas (WA Department of Commerce): every city's
  // zoning districts inside its limits and each county's zoning for its
  // unincorporated land, normalized to one set of classes and allowed uses.
  // Queried live (keyless, CORS-enabled); a city's zone wins over a county's
  // where both cover a spot, and county zoning is the backup elsewhere.
  const ZONING = {
    service: 'https://services6.arcgis.com/tboeqGwETr5ppr5Q/arcgis/rest/services/WAZA_Prototype_Layers/FeatureServer',
    layers: { zones: 0, overlays: 1, jurisdictions: 2 },
    atlasUrl: 'https://www.commerce.wa.gov/growth-management/data-research/waza/',
    minZoom: 13,
    // Zones are fetched per grid cell (degrees of longitude, latitude) and
    // kept, so panning back over an area costs nothing.
    cellDeg: [0.05, 0.035],
    maxCells: 80,
    concurrency: 4,
    // Line generalization (degrees) by zoom: coarse below 15, fine from 15.
    offset: { coarse: 0.00008, fine: 0.00001 },
    fields: 'OBJECTID,GEOID,Jurisdiction,ZoneID,ZoneName,WAZAZoneGeneral,WAZAZoneSpecific,UseOffice,UseRetail',
    // A pin in a street (the atlas leaves rights-of-way unzoned) takes the
    // nearest zone within this distance.
    nearM: 30,
    // The site evaluation also asks the jurisdiction's own zoning layer (the
    // atlas records its URL and zone field) whether the zone still matches.
    // Seattle's layer is listed without a field name in the atlas.
    liveFieldOverrides: { '5363000': 'ZONING' },
    // Map classes: the atlas's general classes, grouped into eight hues and a
    // neutral. Conventional planning colours (LBCS: yellow residential, red
    // commercial, purple industrial, blue public, green open space). Worst
    // ALL-pairs separation: CVD ΔE 9.0, normal vision 15.2, lightness and
    // chroma in band (dataviz validator; the yellow is below 3:1 on white, so
    // the legend, tooltip and popup always name the class).
    categories: [
      { id: 'LIR', label: 'Low-intensity residential', classes: ['LIR'], color: '#c7b500' },
      { id: 'MR', label: 'Multi-unit residential', classes: ['MR'], color: '#cf7604' },
      { id: 'MXU', label: 'Mixed use', classes: ['MXU'], color: '#a75091' },
      { id: 'COM', label: 'Commercial', classes: ['COM'], color: '#8c2c36' },
      { id: 'IND', label: 'Industrial', classes: ['IND'], color: '#59419b' },
      { id: 'PUB', label: 'Public & semi-public', classes: ['PUB'], color: '#0278c7' },
      { id: 'OS', label: 'Parks & open space', classes: ['OS'], color: '#059f6d' },
      { id: 'RUR', label: 'Rural & resource lands', classes: ['RUR', 'NRL'], color: '#7a6813' },
      { id: 'OTHER', label: 'Military, tribal or unclassified', classes: ['MIL', 'TRB', 'UND', 'UNK'], color: '#a9aeac' }
    ],
    // The atlas's own labels (read live from the layer's domains; these are
    // the fallback if that metadata cannot be loaded).
    general: {
      COM: 'Commercial', IND: 'Industrial', NRL: 'Natural resource lands', OS: 'Parks and open space',
      PUB: 'Public and semi-public use', TRB: 'Tribal lands', UND: 'Undesignated', LIR: 'Low-intensity residential',
      UNK: 'Unknown', RUR: 'Rural', MXU: 'Mixed use', MR: 'Multi-unit residential', MIL: 'Military lands'
    },
    // Zones the atlas has not classed get one from their name, marked as inferred.
    infer: [
      [/mixed|downtown|village|town cent|city cent|urban cent|\bmu\b|\bmxd?\b/i, 'MXU'],
      [/industr|manufactur|warehouse|\bm-?\d\b|\bi-?\d\b|\bi-?[lmh]\b|\bli\b|\bhi\b|seaport|airport|aviation/i, 'IND'],
      [/commerc|business|retail|office|shopping|\bc-?\d\b|\bcb\b|\bbn\b|\bgc\b|\bnc\b/i, 'COM'],
      [/multi|apartment|high density|medium density|townhouse|\brm|\bmf|\br-?(1[2-9]|[2-9]\d)\b/i, 'MR'],
      [/single|residential|\brs|\bsf\b|\bsr\b|\bllr|\br-?\d/i, 'LIR'],
      [/park|open space|recreation|conservancy|greenbelt/i, 'OS'],
      [/public|institution|school|civic|government|hospital|campus|cemetery|utility/i, 'PUB'],
      [/agric|farm|forest|timber|mineral|mining|resource|rural/i, 'RUR']
    ],
    // Allowed-use codes, as the atlas records them for each zone.
    uses: {
      P: { label: 'Permitted', short: 'permitted' },
      C: { label: 'Conditional', short: 'conditional use permit' },
      LA: { label: 'Limited or accessory', short: 'limited or accessory only' },
      X: { label: 'Not permitted', short: 'not permitted' },
      U: { label: 'Unknown', short: 'not recorded' }
    },
    // "Office & medical use" colouring: where an office (the use class that
    // takes medical offices) is allowed. All-pairs CVD ΔE 12.1 among the
    // three hues; "not permitted" recedes as a light neutral, unknown is left
    // unfilled with a dashed edge.
    outlook: [
      { id: 'P', label: 'Office use permitted', color: '#12814f' },
      { id: 'C', label: 'Conditional use permit', color: '#dca118' },
      { id: 'LA', label: 'Limited or accessory only', color: '#8f4a9a' },
      { id: 'X', label: 'Not permitted', color: '#c9ced0' },
      { id: 'U', label: 'Not recorded', color: null }
    ],
    fillOpacity: 0.55
  };

  // ------------------------------------------------------ site evaluation
  // A screening score for a medical clinic at a dropped pin, from public
  // data. The criteria follow a healthcare site search (demand and payer mix
  // in the drive-time catchment, access and visibility, zoning, site capacity,
  // competition and adjacency to other care) and add parking, shelters,
  // amenities, transit, arterials and terrain. Each criterion scores 0-100 from
  // the anchors below (straight lines between anchors; population on a log
  // scale); the use type sets the weights (each set sums to 100) and the
  // drive time that defines the catchment.
  const SITE_EVAL = {
    defaultSqft: 10000,
    profiles: [
      { id: 'primary', label: 'Primary care clinic', minutes: 10, parkingPer1000: 5,
        weights: { zoning: 14, demand: 14, payer: 12, access: 12, transit: 8, site: 12, health: 8, amenities: 8, competition: 6, terrain: 4, shelters: 2 } },
      { id: 'multi', label: 'Multispecialty or medical office', minutes: 20, parkingPer1000: 5.5,
        weights: { zoning: 14, demand: 14, payer: 14, access: 12, transit: 6, site: 12, health: 12, amenities: 4, competition: 4, terrain: 5, shelters: 3 } },
      { id: 'urgent', label: 'Urgent care', minutes: 10, parkingPer1000: 5,
        weights: { zoning: 14, demand: 12, payer: 10, access: 18, transit: 6, site: 10, health: 6, amenities: 10, competition: 8, terrain: 4, shelters: 2 } },
      { id: 'chc', label: 'Community health center (FQHC)', minutes: 15, parkingPer1000: 4,
        weights: { zoning: 14, demand: 10, payer: 12, access: 8, transit: 14, site: 10, health: 8, amenities: 8, competition: 6, terrain: 4, shelters: 6 } }
    ],
    criteria: [
      { id: 'zoning', label: 'Zoning', icon: '🏗️' },
      { id: 'demand', label: 'Demand (population)', icon: '👥' },
      { id: 'payer', label: 'Payer mix & income', icon: '💳' },
      { id: 'access', label: 'Arterials & visibility', icon: '🛣️' },
      { id: 'transit', label: 'Public transit', icon: '🚌' },
      { id: 'site', label: 'Parking & site size', icon: '🅿️' },
      { id: 'health', label: 'Hospitals & care nearby', icon: '🏥' },
      { id: 'amenities', label: 'Amenities nearby', icon: '🛒' },
      { id: 'competition', label: 'Competition', icon: '📊' },
      { id: 'terrain', label: 'Elevation, slope & flood', icon: '⛰️' },
      { id: 'shelters', label: 'Shelters nearby', icon: '🏠' }
    ],
    // Population anchors per use type: people within the catchment drive time.
    demand: {
      primary: [[2000, 10], [8000, 35], [20000, 60], [40000, 80], [70000, 100]],
      multi: [[15000, 10], [50000, 35], [120000, 60], [250000, 80], [450000, 100]],
      urgent: [[3000, 10], [10000, 35], [25000, 60], [50000, 80], [80000, 100]],
      chc: [[5000, 10], [20000, 35], [50000, 60], [100000, 80], [180000, 100]]
    },
    // Straight-line fallback when drive times are unavailable (miles).
    fallbackMiles: { primary: 4, multi: 10, urgent: 4, chc: 6 },
    payer: {
      commercial: [[35, 15], [45, 40], [55, 65], [62, 85], [70, 100]],   // % employer + direct-purchase
      income: [[45000, 15], [65000, 40], [85000, 65], [110000, 85], [140000, 100]],
      medicare: [[8, 30], [14, 60], [20, 85], [26, 100]],               // % Medicare incl. dual (multispecialty)
      need: [[10, 15], [18, 40], [26, 65], [34, 85], [42, 100]]         // % Medicaid + uninsured (FQHC)
    },
    access: {
      // metres to the nearest road of each federal functional class (WSDOT)
      byClass: {
        1: [[60, 70], [250, 55], [800, 35]],                       // interstate: visible, but no direct access
        2: [[30, 100], [100, 85], [250, 65], [500, 45], [800, 30]], // freeway / expressway
        3: [[30, 100], [100, 85], [250, 65], [500, 45], [800, 30]], // other principal arterial
        4: [[30, 85], [100, 72], [250, 55], [500, 38], [800, 25]],  // minor arterial
        5: [[30, 65], [100, 55], [250, 40], [500, 25]],             // major collector
        6: [[30, 50], [100, 40], [250, 28]]                         // minor collector
      },
      none: 15,
      freeway: [[1600, 100], [4000, 75], [8000, 45]],   // metres to the nearest freeway interchange
      freewayNone: 20,
      aadtBonus: [[10000, 3], [20000, 6], [40000, 10]]   // vehicles a day on a state route within 150 m
    },
    transit: { nearStop: 45, farStop: 25, perRoute: 8, routesMax: 35, rail: 20 },
    site: {
      stallSqft: 325,        // a surface stall with its share of aisles (planning rule of thumb: 300-350 sf)
      overhead: 1.35,        // setbacks, landscaping and circulation on top of building + parking
      oneStoryMaxSqft: 20000,
      fit: [[0.3, 10], [0.6, 40], [0.85, 70], [1, 85], [1.5, 100]],       // parcel area / land needed
      parking: [[0, 15], [0.5, 55], [1, 90], [1.3, 100]]                  // mapped stalls / stalls needed
    },
    health: {
      hospitalM: [[1600, 100], [5000, 75], [10000, 50], [20000, 28], [40000, 10]],
      clinics: [[0, 15], [2, 40], [5, 65], [10, 85], [20, 100]],          // within 1 mile
      pharmacies: [[0, 20], [1, 70], [3, 100]]
    },
    amenities: {
      retail: [[0, 15], [3, 45], [10, 70], [25, 90], [50, 100]]           // restaurants + shops within 1/2 mile
    },
    // Same-type providers per 10,000 residents of the catchment.
    competition: {
      primary: [[0.5, 100], [1.5, 80], [3, 55], [6, 30], [10, 15]],
      multi: [[1, 100], [3, 75], [6, 50], [10, 30]],
      urgent: [[0, 100], [0.2, 80], [0.5, 55], [1, 30], [2, 15]],
      chc: [[0, 100], [1, 75], [3, 45], [6, 20]]                          // per 10,000 Medicaid/uninsured residents
    },
    terrain: {
      slope: [[2, 100], [5, 85], [8, 60], [12, 35], [18, 15]],            // % grade across 50 m around the pin
      sfhaCap: 25,           // a pin in the 1%-annual-chance floodplain scores at most this
      moderatePenalty: 15    // 0.2%-annual-chance floodplain
    },
    shelters: {
      privateM: [[200, 30], [400, 45], [800, 65], [1600, 90], [3200, 100]],
      chcM: [[800, 100], [1600, 80], [3200, 60]], chcNone: 45
    },
    ratings: [[80, 'Strong'], [65, 'Good'], [50, 'Fair'], [0, 'Weak']],
    endpoints: {
      parcels: 'https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0',
      parcelsInfo: 'https://geo.wa.gov/maps/2b603a599a0842a3b2284c04c8927f35',
      functionalClass: 'https://data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass/WSDOTFunctionalClassData/FeatureServer',
      trafficSections: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/FeatureServer/1',
      epqs: 'https://epqs.nationalmap.gov/v1/json',
      openMeteo: 'https://api.open-meteo.com/v1/elevation',
      flood: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28'
    },
    radii: { parkingM: 200, sheltersM: 3219, junctionsM: 8047, roadsM: 800, trafficM: 150,
      stopNearM: 400, stopFarM: 800, amenityNearM: 805, amenityFarM: 1609, slopeM: 50, parcelM: 25 }
  };

  // ---------------------------------------------------------------- sources
  const SOURCES = [
    { section: 'Demographics', items: [
      'U.S. Census Bureau, American Community Survey (ACS) 5-Year Estimates for every Washington county and census tract. A GitHub Action reads the Census Bureau\'s keyless ACS Summary Files each month and publishes them with the map, so the browser never calls the Census API (which has required an API key since May 2026). The vintage in use is shown in the layer legend; the newest published vintage is picked up automatically.',
      'Land area and tract names: U.S. Census Bureau Gazetteer files. Boundaries: Census cartographic boundary files (1:500,000, clipped to the shoreline), pre-built with the map; TIGERweb is the fallback.',
      'Median values are ACS estimates and carry margins of error; small tracts have wider error bands. Values suppressed by the Census Bureau are shown as "no data".'
    ]},
    { section: 'Health insurance', items: [
      'U.S. Census Bureau, American Community Survey 5-Year Estimates, for every county and census tract: detailed table B27010 (types of health insurance coverage by age); B27002 and B27003 (private and public health insurance by sex by age); and C27004 to C27009 (employer-based, direct-purchase, Medicare, Medicaid/means-tested, TRICARE/military and VA health coverage by sex by age; the 5-year estimates publish these single-type tables with collapsed age groups, as C tables). Universe: the civilian noninstitutionalized population, so active-duty military and people living in institutions are not included. Each area\'s profile links its tables on data.census.gov.',
      'Coverage types follow the Census Bureau\'s definitions (Health Insurance Glossary, census.gov): employer-based coverage comes through a current or former employer or union, the person\'s own or a family member\'s; direct-purchase is bought directly from an insurance company; TRICARE and other military coverage count as private; Medicare, Medicaid and other means-tested plans (Apple Health in Washington) and VA health care count as public. People whose only coverage is the Indian Health Service are counted as uninsured.',
      'Insurance sources count everyone holding each type of coverage, alone or with other types, so they add up to more than 100%. The uninsured share is the "no health insurance coverage" lines of B27010 over its universe, the same measure as subject table S2701.',
      'Payer mix counts each person once, following the hierarchy KFF uses for "Health Insurance Coverage of the Total Population" (kff.org). Medicaid is everyone with Medicaid or other means-tested coverage, whatever else they have, dual eligibles included (table C27007). The other groups come from the coverage combinations in table B27010: Medicare alone or with employer or direct-purchase coverage is counted under Medicare; employer coverage alone or with direct-purchase under employer-sponsored; direct-purchase alone under direct-purchase; TRICARE or VA alone under military. KFF also counts full-time workers who have both Medicare and employer coverage as employer-covered; the ACS tables carry no work status, so they are counted under Medicare here. Combinations that B27010 groups without naming the types, less the Medicaid holders among them, are shown as "other combinations" (for example Medicare with both employer and direct-purchase coverage, or TRICARE with employer coverage). KFF works from ACS microdata, so its Washington figures will not match these exactly.',
      'Tract estimates come from small samples and carry wide margins of error; data.census.gov shows the margin for each value.'
    ], links: [
      // `table`: linked on data.census.gov at the ACS vintage the map uses.
      { label: 'ACS table B27010 for Washington (data.census.gov)', table: 'B27010' },
      { label: 'U.S. Census Bureau Health Insurance Glossary', url: 'https://www.census.gov/topics/health/health-insurance/about/glossary.html' },
      { label: 'KFF: Health Insurance Coverage of the Total Population', url: 'https://www.kff.org/state-health-policy-data/state-indicator/total-population/' },
      { label: 'ACS Summary File', url: 'https://www.census.gov/programs-surveys/acs/data/summary-file.html' }
    ]},
    { section: 'Amenities', items: [
      'Every category is pulled for the whole state each month (no per-view caps or zoom limits) and merged from authoritative registries first, then OpenStreetMap to fill gaps. A point that duplicates one already kept is dropped: the same name nearby (town names, health-system brands and store numbers do not count, and the radius widens for address-geocoded registries and large parks), or the same kind of place at the same spot (clinics, pharmacies, banks and fuel stations within 30-45 m whatever their names, since registries and OpenStreetMap often name one place differently; hospitals, grocery stores and parks beyond 30 or 10 m only when their names share a word). Hover a category in the panel to see how many places each source contributed.',
      'Hospitals & clinics: WA Department of Health licensed hospitals; CMS Provider of Services (hospitals, critical access hospitals, federally qualified health centers, rural health clinics, ambulatory surgery centers) via HRSA; Veterans Health Administration facilities; HRSA health center sites; WA DOH local health jurisdiction clinics; plus OpenStreetMap hospitals, clinics, urgent care and doctors\' offices. Hospitals are drawn larger and never clustered.',
      'Pharmacies: WA DOH licensed pharmacies where available, otherwise community pharmacies from the federal NPI registry (NPPES), geocoded by the U.S. Census Bureau; plus OpenStreetMap.',
      'Grocery & convenience stores: USDA SNAP-authorized food retailers (supermarkets, grocery, convenience and specialty food stores, farmers markets) plus OpenStreetMap; convenience stores, about two thirds of the points, have their own marker. Banks & credit unions: FDIC BankFind branches, NCUA credit union branches (geocoded) and OpenStreetMap. Fuel & EV charging: NREL Alternative Fuels Data Center public stations plus OpenStreetMap. Parks: Washington State Parks, USGS PAD-US public parks and recreation areas, and OpenStreetMap parks and playgrounds.',
      'Schools and colleges: NCES EDGE geocoded locations of public schools, private schools and postsecondary institutions (newest school year). Restaurants & cafes and Retail & shopping: OpenStreetMap, the most complete open statewide source for businesses; completeness varies by area.'
    ]},
    { section: 'Transit', items: [
      'Washington State Department of Transportation (WSDOT) consolidated statewide GTFS transit data (routes and stops for every transit agency in the state), served from data.wsdot.wa.gov.',
      'Route popups link to the agency\'s website and, where the agency publishes one in its GTFS feed, the route\'s own schedule page. Agency websites come from each agency\'s GTFS agency.txt (found through the Mobility Database feed catalog).',
      'WSDOT Ferry Routes service for Washington State Ferries. If WSDOT services are unreachable the app falls back to OpenStreetMap transit route relations and stops.'
    ]},
    { section: 'Crime', items: [
      'Statewide: every Washington law-enforcement agency\'s annual NIBRS offense counts from WASPC "Crime in Washington", published by the Office of Financial Management on data.wa.gov. Each agency is drawn where it serves (city police at the city, sheriffs at the county) and colored by offenses per 1,000 residents. In these totals, theft includes motor-vehicle theft and fraud, and DUI and trespass (arrest-only offenses) are not counted.',
      'Incident reports, queried live: Seattle PD (SPD Crime Data, NIBRS; SPD redacts the location of most homicides and sex offenses), Tacoma PD reported crime (excludes domestic-violence and sex offenses), Bellevue PD offenses, Redmond PD crime map, Kirkland PD crime map, Everett PD police cases (excludes domestic-violence, child-abuse and minor sex cases), Yakima PD offenses, and the Pierce County Sheriff\'s rolling 12-month crime data.',
      'Incident reports, geocoded weekly by the build: King County Sheriff\'s Office offense reports (unincorporated King County and contract cities) and Auburn PD case reports. KCSO publishes block addresses; Auburn publishes exact ones, which the build generalizes to the block, withholding sex offenses, child abuse, protection-order violations, stalking and kidnapping altogether. The Census Bureau batch geocoder places the blocks.',
      'Counts reflect reported offenses, not convictions, and reporting practices differ between agencies - compare places within one source, not across sources. Several large departments (among them Spokane, Vancouver, Bellingham, Olympia, Renton, Federal Way, Bremerton and the Snohomish and Clark County sheriffs) publish no open incident feed; they appear in the statewide totals only.'
    ]},
    { section: 'Drive-time areas', items: [
      'Isochrones are computed by the Valhalla open-source routing engine (public FOSSGIS server) over the OpenStreetMap road network, using road classes, speed limits and turn costs.',
      'Estimates reflect typical (free-flow to moderate) conditions, not live congestion. Peak-hour drive times in urban areas can be materially longer.',
      'Population and income inside each band are estimated by allocating whole census tracts whose internal point (Census Gazetteer INTPTLAT/INTPTLONG, always inside the tract) falls inside the band (ACS 5-year data).'
    ]},
    { section: 'Radius & area search', items: [
      'A circle around a dropped pin, or a polygon drawn anywhere on the map, lists every amenity point in the statewide amenity files and every transit stop and route (WSDOT statewide GTFS, queried live, with OpenStreetMap as the fallback; Washington State Ferries routes included, once per route) that falls inside the shape or touches its edge (a point within half a metre of the edge counts as touching it, since amenity coordinates are published to about a metre). Routes are listed when any part of their line reaches the shape.',
      'One transit query returns at most 20,000 stops and 8,000 route shapes (from OpenStreetMap, 4,000 stops and 500 routes). A list cut short at that limit is marked with a + and the panel and the CSV say so; a smaller shape gives the complete list.',
      'Circle radii are great-circle distances from the pin. Polygon edges are straight lines on the map (Web Mercator), and containment is tested on that same projection, so the list matches the shape as drawn. Areas and perimeters are geodesic estimates.',
      'Amenities are points (a park is its representative point, not its boundary). Shapes, their styles and their names are stored only in this browser; the CSV export downloads the current list.'
    ]},
    { section: 'Zoning', items: [
      'Washington State Zoning Atlas (WAZA), Washington State Department of Commerce, queried live: the zoning districts of cities inside their limits and of counties on their unincorporated land (zones for 278 of the state\'s 320 cities, towns and counties; most of the rest are small towns with only a paper map, which the popup links), with each zone\'s local code and name, a normalized class, whether office, retail, residential and industrial uses are permitted, conditional, limited or not permitted, and development standards (height, floor area ratio, lot coverage, parking minimums). Where a city\'s zone and a county\'s overlap, the city\'s is used; the county\'s zoning is the backup where the atlas has none for the city. Streets are unzoned in the atlas, so a point in a right-of-way takes the nearest zone within 30 m.',
      'The map colours zones by the atlas\'s general class, grouped into eight classes plus "military, tribal or unclassified" (conventional planning colours: yellow residential, red commercial, purple industrial, blue public, green open space). About 3,000 zones the atlas has not classed get a class from their name, marked as inferred in the popup. The "office & medical use" colouring shows where the atlas records office uses (the use class most codes put medical offices in) as permitted, conditional, limited or not permitted.',
      'The atlas compiles each jurisdiction\'s code as of 2024-2025 and is not an official zoning map: popups link the zone\'s code chapter and the municipal code, and the site evaluation also asks the city\'s own zoning map (where the atlas records one that answers) whether the zone has changed. Always confirm zoning with the jurisdiction.'
    ], links: [
      { label: 'Washington State Zoning Atlas (WA Commerce)', url: 'https://www.commerce.wa.gov/growth-management/data-research/waza/' }
    ]},
    { section: 'Medical site evaluation', items: [
      'Opened from a dropped pin, it scores the spot for a medical clinic from public data, 0-100 on each of eleven criteria, weighted by use type (primary care, multispecialty or medical office, urgent care, community health center; each set of weights sums to 100). The criteria follow a typical healthcare site search (demand and payer mix in the drive-time catchment, access and visibility, zoning, site capacity, competition and adjacency to other care) and add parking, shelters, amenities, transit, arterials and terrain. The overall score is the weighted average: Strong 80+, Good 65-79, Fair 50-64, Weak below 50. A criterion whose data could not be loaded is left out and the others reweighted, and the panel says how much of the weight was scored. A zoning score of 10 or less (neither offices nor retail permitted, or a low-density residential or open-space zone with no recorded uses) caps the rating at Weak.',
      'Zoning: the atlas\'s office-use permission (permitted 100, conditional 60, limited 35, not permitted 5, or 25 where retail and services are permitted), else a typical value for the zone class. Demand: residents of census tracts whose internal point lies within the drive time (10 minutes for primary and urgent care, 15 for a health center, 20 for multispecialty; Valhalla routing over OpenStreetMap, straight-line circles if routing is down), scored on a log scale. Payer mix & income: employer plus direct-purchase coverage (60%) and population-weighted median household income (40%); multispecialty adds Medicare share; a health center scores its Medicaid and uninsured share instead (ACS 5-year tables B27010, C27007, B19013).',
      'Arterials & visibility: distance to the nearest road of each federal functional class (WSDOT), plus up to 10 points for the annual average daily traffic on a state route within 150 m (WSDOT traffic counts) and a quarter of the score from distance to the nearest freeway interchange (OpenStreetMap). Transit: stops within a quarter and half mile, routes within a quarter mile and rail within half a mile (WSDOT statewide GTFS). Parking & site size: the parcel\'s area (Washington statewide tax parcels) against the land a building of the entered size needs with surface parking (one story up to 20,000 sf and two above; stalls at the use type\'s ratio or the zone\'s office minimum if higher, 325 sf per stall, plus 35% for setbacks and landscaping), 60%, and mapped parking on the parcel or within 400 ft against the stalls needed (OpenStreetMap; stall counts estimated from lot area where not tagged), 40%. A vacant parcel (undeveloped land use, or no building value) is scored on its area alone. No owner information is read.',
      'Hospitals & care nearby: distance to the nearest hospital, clinics and practices within a mile and pharmacies within a mile (the amenities layer\'s registries and OpenStreetMap). Amenities: a grocery store within half a mile or a mile, restaurants and shops within half a mile, a bank within a mile. Competition: same-type providers in the catchment per 10,000 residents (per 10,000 Medicaid or uninsured residents for a health center); private practices are undercounted in open data, so this carries a small weight. Terrain: ground slope across 50 m around the pin (USGS 3DEP via the Elevation Point Query Service; a 90 m model if it is down) and the FEMA flood zone (a pin in the 1% annual chance floodplain scores at most 25). Shelters: distance to the nearest shelter for people experiencing homelessness (OpenStreetMap; closer scores lower for private clinics and higher for a health center, with a small weight). Shelters that may serve abuse victims or minors (tagged for them, or women-only and not tagged for homelessness) are never used, and only distances are shown.',
      'The write-up states the rating, the zoning and the strongest and weakest criteria in plain sentences, and lists anything that could not be scored. This is a screening estimate, not an appraisal, a market study or a zoning determination: confirm zoning, the parcel, access and utilities with the jurisdiction and a site visit.'
    ]},
    { section: 'Base maps', items: [
      '16 base maps, all keyless and free to use: OpenStreetMap and OSM Humanitarian; Esri Light/Dark Gray Canvas, World Imagery, Streets and Topographic; USGS The National Map (Imagery, Imagery+Topo, Topo, Shaded Relief, Hydrography); OpenTopoMap; OPNVKarte transit; CyclOSM; and WSDOT\'s Washington base map.',
      'Licensing, in plain terms: the USGS National Map services are U.S. federal works in the public domain with no commercial-use restriction - the cleanest option here, and the reason they are offered alongside the commercial alternatives. The Esri services at server.arcgisonline.com are keyless but are legacy raster layers in Esri Mature Support (cartography frozen around 2021, World Imagery excepted and still maintained); an organisation with an ArcGIS entitlement should point these at its own keyed basemap service. OpenStreetMap and the community servers (OSM France, OpenTopoMap, MeMoMaps) are volunteer-funded and ask that heavy or commercial traffic not lean on them.',
      'CARTO Positron and Dark Matter were deliberately removed: CARTO began requiring an API key on basemaps.cartocdn.com in late August 2026 and now stamps anonymous tiles with an "API KEY REQUIRED" watermark while still returning HTTP 200, and CARTO\'s own basemap-styles licence restricts the tile services to enterprise customers.',
      'Place labels can be drawn above the data layers (the "Labels above data layers" option) so street and city names stay readable through a choropleth instead of being buried by it.',
      'Address search: Esri World Geocoder (keyless, addresses and places, limited to Washington) with OpenStreetMap Nominatim as fallback. Reverse geocoding by Nominatim.'
    ]},
    { section: 'Colour & accessibility', items: [
      'The interface uses the official CBRE brand palette: CBRE Green #003F2D, Accent Green #17E88F, Dark Green #012A2D, Dark Grey #435254 and the CBRE secondary and chart colours.',
      'Data ramps are not raw brand swatches. Each one was generated in OKLCH at a CBRE brand hue and checked with a palette validator for monotone lightness, visible step gaps, single hue, colour-blind separation and contrast against the surface it is drawn on. Light and dark themes use separately chosen steps rather than an automatic inversion.',
      'Colour is never the only channel: amenity pins carry a distinct emoji and label, transit modes carry a distinct dash pattern, and every layer has a legend. That matters because CBRE\'s palette is deliberately muted, so several brand hues sit closer together than a generic categorical palette would.'
    ]}
  ];

  WAMAP.CONFIG = {
    PALETTE, MAP, BASEMAPS, BASEMAP_GROUPS, LABEL_LAYERS, CENSUS, TIGERWEB, DEMO_METRICS, INSURANCE_METRICS,
    INSURANCE, GEOCODE, OVERPASS, AMENITIES, AMENITIES_DEFAULT_ON, AMENITY_DATA_DIR, TRANSIT, CRIME, ISOCHRONE, AREAS, ZONING, SITE_EVAL, SOURCES,
    SQMI_PER_SQM
  };
})();
