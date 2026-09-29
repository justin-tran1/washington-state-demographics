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
    localCounties: 'data/wa_counties.geojson'
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

  const INSURANCE_METRICS = [
    { id: 'uninsured', label: 'Uninsured rate', unit: '%', fmt: 'pct1',
      value: d => d.pctUninsured, desc: 'Civilian noninstitutionalized population without health insurance coverage (ACS subject table S2701).' },
    { id: 'insured', label: 'Insured rate', unit: '%', fmt: 'pct1',
      value: d => d.pctInsured, desc: 'Civilian noninstitutionalized population with health insurance coverage (ACS subject table S2701).' }
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
  const OVERPASS = {
    endpoints: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.private.coffee/api/interpreter'
    ],
    timeoutS: 40
  };

  // -------------------------------------------------------------- amenities
  // source 'osm'  -> Overpass selectors (applied as nwr[...](bbox))
  // source 'nces' -> NCES EDGE point services with OSM fallback
  const AMENITIES = [
    { id: 'schools', label: 'Schools (K-12)', emoji: '🏫',  colorToken: 'schools', minZoom: 11, cap: 900,
      source: 'nces', ncesKind: 'k12',
      osm: ['["amenity"="school"]', '["amenity"="kindergarten"]'] },
    { id: 'colleges', label: 'Colleges & universities', emoji: '🎓',  colorToken: 'colleges', minZoom: 9, cap: 500,
      source: 'nces', ncesKind: 'postsecondary',
      osm: ['["amenity"="college"]', '["amenity"="university"]'] },
    { id: 'grocery', label: 'Grocery & supermarkets', emoji: '🛒',  colorToken: 'grocery', minZoom: 12, cap: 800,
      source: 'osm', osm: ['["shop"~"^(supermarket|grocery|greengrocer|convenience|health_food)$"]'] },
    { id: 'restaurants', label: 'Restaurants & cafes', emoji: '🍽️',  colorToken: 'restaurants', minZoom: 14, cap: 1200,
      source: 'osm', osm: ['["amenity"~"^(restaurant|cafe|fast_food)$"]'] },
    { id: 'retail', label: 'Retail & shopping', emoji: '🛍️',  colorToken: 'retail', minZoom: 14, cap: 1200,
      source: 'osm', osm: ['["shop"~"^(mall|department_store|clothes|shoes|electronics|furniture|doityourself|hardware|sports|variety_store|general|gift|jewelry|beauty|books|toys|pet)$"]'] },
    { id: 'pharmacy', label: 'Pharmacies', emoji: '💊',  colorToken: 'pharmacy', minZoom: 12, cap: 500,
      source: 'osm', osm: ['["amenity"="pharmacy"]', '["shop"="chemist"]', '["healthcare"="pharmacy"]'] },
    { id: 'health', label: 'Hospitals & clinics', emoji: '🏥',  colorToken: 'health', minZoom: 9, cap: 600,
      source: 'osm', osm: ['["amenity"~"^(hospital|clinic)$"]', '["healthcare"~"^(hospital|clinic)$"]'] },
    { id: 'banks', label: 'Banks & credit unions', emoji: '🏦',  colorToken: 'banks', minZoom: 13, cap: 500,
      source: 'osm', osm: ['["amenity"="bank"]'] },
    { id: 'fuel', label: 'Fuel & EV charging', emoji: '⛽',  colorToken: 'fuel', minZoom: 12, cap: 700,
      source: 'osm', osm: ['["amenity"="fuel"]', '["amenity"="charging_station"]'] },
    { id: 'parks', label: 'Parks & playgrounds', emoji: '🌳',  colorToken: 'parks', minZoom: 12, cap: 900,
      source: 'osm', osm: ['["leisure"~"^(park|playground)$"]'] }
  ];

  const NCES = {
    k12Folder: 'https://nces.ed.gov/opengis/rest/services/K12_School_Locations',
    postsecFolder: 'https://nces.ed.gov/opengis/rest/services/Postsecondary_School_Locations',
    k12Match: /^EDGE_GEOCODE_(PUBLICSCH|PRIVATESCH)_(\d{4})$/i,
    postsecMatch: /^EDGE_GEOCODE_POSTSECONDARYSCH_(\d{4})$/i
  };

  // ---------------------------------------------------------------- transit
  const TRANSIT = {
    wsdotService: 'https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer',
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
    maxPerCity: 25000,
    // Category rules are applied (in order) against UPPERCASED
    // "offense || parent group" text from each source, so one rule set covers
    // all cities. First match wins.
    categories: [
      { id: 'homicide', label: 'Homicide', group: 'person', re: /HOMICIDE|MURDER|MANSLAUGHTER/ },
      { id: 'sexoff', label: 'Sex offenses', group: 'person', re: /RAPE|SODOMY|FONDLING|SEX OFFENSE|SEXUAL|INDECENT|PEEPING|PORNOGRAPHY|HUMAN TRAFFICKING/ },
      { id: 'robbery', label: 'Robbery', group: 'person', re: /ROBBERY/ },
      { id: 'kidnap', label: 'Kidnapping', group: 'person', re: /KIDNAP|ABDUCTION/ },
      { id: 'assault', label: 'Assault', group: 'person', re: /ASSAULT|INTIMIDATION|HARASSMENT/ },
      { id: 'arson', label: 'Arson', group: 'property', re: /ARSON/ },
      { id: 'mvt', label: 'Motor vehicle theft', group: 'property', re: /MOTOR VEHICLE THEFT|AUTO THEFT/ },
      { id: 'burglary', label: 'Burglary / B&E', group: 'property', re: /BURGLARY|BREAKING/ },
      { id: 'theft', label: 'Larceny / theft', group: 'property', re: /LARCENY|THEFT|SHOPLIFT|PICKPOCKET|PURSE|STOLEN PROPERTY/ },
      { id: 'vandalism', label: 'Vandalism / property damage', group: 'property', re: /VANDALISM|DESTRUCTION|DAMAGE|MALICIOUS MISCHIEF|GRAFFITI/ },
      { id: 'fraud', label: 'Fraud / forgery', group: 'property', re: /FRAUD|FORGERY|COUNTERFEIT|EMBEZZLE|EXTORTION|BAD CHECK|IDENTITY/ },
      { id: 'drugs', label: 'Drugs / narcotics', group: 'society', re: /DRUG|NARCOTIC/ },
      { id: 'weapons', label: 'Weapons', group: 'society', re: /WEAPON|FIREARM/ },
      { id: 'dui', label: 'DUI', group: 'society', re: /DUI|DRIVING UNDER/ },
      { id: 'trespass', label: 'Trespass', group: 'society', re: /TRESPASS/ },
      { id: 'other', label: 'Other offenses', group: 'other', re: /./ }
    ],
    defaultOn: ['homicide', 'sexoff', 'robbery', 'kidnap', 'assault', 'arson', 'mvt', 'burglary', 'theft', 'vandalism'],
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
        note: 'Seattle PD NIBRS incident reports; locations generalized to the 100 block.'
      },
      {
        id: 'tacoma', label: 'Tacoma', type: 'arcgis-item',
        itemId: '4b9326bf98c84fe4a1d8526ee6870c2d',
        portal: 'https://www.arcgis.com',
        link: 'https://data.cityoftacoma.org/datasets/tacoma::city-of-tacoma-reported-crime-tacoma/about',
        note: 'City of Tacoma reported crime (NIBRS-based). Tacoma excludes domestic-violence and sex offenses from its public data.'
      },
      {
        id: 'spokane', label: 'Spokane', type: 'arcgis-service',
        service: 'https://services6.arcgis.com/ydggmMcp46DZ7B9Z/ArcGIS/rest/services/CrimePoints/FeatureServer',
        link: 'https://my.spokanecity.org/opendata/gis/',
        note: 'City of Spokane police incident points from the city open-data GIS.'
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

  // ---------------------------------------------------------------- sources
  const SOURCES = [
    { section: 'Demographics & health insurance', items: [
      'U.S. Census Bureau, American Community Survey (ACS) 5-Year Estimates, retrieved live from the Census Data API (api.census.gov). The vintage in use is shown in the layer legend; the app automatically uses the newest published vintage.',
      'Health insurance coverage: ACS subject table S2701 (civilian noninstitutionalized population), the standard federal source for sub-county insurance coverage.',
      'Boundaries: U.S. Census Bureau TIGERweb generalized (cartographic) census tracts and counties. Bundled county fallback derived from the Census Bureau cartographic boundary files (via the us-atlas package).',
      'Median values are ACS estimates and carry margins of error; small tracts have wider error bands. Values suppressed by the Census Bureau are shown as "no data".'
    ]},
    { section: 'Amenities', items: [
      'Schools and colleges: National Center for Education Statistics (NCES) EDGE geocoded point locations - public schools (Common Core of Data), private schools (PSS), and postsecondary institutions (IPEDS). The newest published school year is selected automatically; if NCES is unreachable the app falls back to OpenStreetMap.',
      'Shops, grocery, restaurants, pharmacies, hospitals, banks, fuel and parks: OpenStreetMap via the Overpass API, fetched live for the current map view. OSM is the most complete open nationwide POI source; completeness varies by area.'
    ]},
    { section: 'Transit', items: [
      'Washington State Department of Transportation (WSDOT) consolidated statewide GTFS transit data (routes and stops for every transit agency in the state), served from data.wsdot.wa.gov.',
      'WSDOT Ferry Routes service for Washington State Ferries.',
      'If WSDOT services are unreachable the app falls back to OpenStreetMap transit route relations and stops.'
    ]},
    { section: 'Crime', items: [
      'Seattle: Seattle Police Department "SPD Crime Data: 2008-Present" (NIBRS), Seattle Open Data portal, updated daily. Locations are generalized to the 100 block.',
      'Tacoma: City of Tacoma "Reported Crime" open dataset (NIBRS-based). The city excludes domestic-violence and sex offenses from public data.',
      'Spokane: City of Spokane police incident points (CrimePoints service) from the city open-data GIS.',
      'Incident-level open police data is published city by city; there is no statewide incident feed. Counts reflect reported offenses, not convictions, and reporting practices differ between agencies - compare within a city, not across cities. Statewide agency totals are published annually by WASPC ("Crime in Washington").'
    ]},
    { section: 'Drive-time areas', items: [
      'Isochrones are computed by the Valhalla open-source routing engine (public FOSSGIS server) over the OpenStreetMap road network, using road classes, speed limits and turn costs.',
      'Estimates reflect typical (free-flow to moderate) conditions, not live congestion. Peak-hour drive times in urban areas can be materially longer.',
      'Population and income inside each band are estimated by allocating whole census tracts whose centroid falls inside the band (ACS 5-year data).'
    ]},
    { section: 'Base maps', items: [
      '16 base maps, all keyless and free to use: OpenStreetMap and OSM Humanitarian; Esri Light/Dark Gray Canvas, World Imagery, Streets and Topographic; USGS The National Map (Imagery, Imagery+Topo, Topo, Shaded Relief, Hydrography); OpenTopoMap; OPNVKarte transit; CyclOSM; and WSDOT\'s Washington base map.',
      'Licensing, in plain terms: the USGS National Map services are U.S. federal works in the public domain with no commercial-use restriction - the cleanest option here, and the reason they are offered alongside the commercial alternatives. The Esri services at server.arcgisonline.com are keyless but are legacy raster layers in Esri Mature Support (cartography frozen around 2021, World Imagery excepted and still maintained); an organisation with an ArcGIS entitlement should point these at its own keyed basemap service. OpenStreetMap and the community servers (OSM France, OpenTopoMap, MeMoMaps) are volunteer-funded and ask that heavy or commercial traffic not lean on them.',
      'CARTO Positron and Dark Matter were deliberately removed: CARTO began requiring an API key on basemaps.cartocdn.com in late August 2026 and now stamps anonymous tiles with an "API KEY REQUIRED" watermark while still returning HTTP 200, and CARTO\'s own basemap-styles licence restricts the tile services to enterprise customers.',
      'Place labels can be drawn above the data layers (the "Labels above data layers" option) so street and city names stay readable through a choropleth instead of being buried by it.',
      'Address search: U.S. Census Bureau Geocoder (street addresses) with OpenStreetMap Nominatim as fallback and for place-name search. Reverse geocoding by Nominatim.'
    ]},
    { section: 'Colour & accessibility', items: [
      'The interface uses the official CBRE brand palette: CBRE Green #003F2D, Accent Green #17E88F, Dark Green #012A2D, Dark Grey #435254 and the CBRE secondary and chart colours.',
      'Data ramps are not raw brand swatches. Each one was generated in OKLCH at a CBRE brand hue and checked with a palette validator for monotone lightness, visible step gaps, single hue, colour-blind separation and contrast against the surface it is drawn on. Light and dark themes use separately chosen steps rather than an automatic inversion.',
      'Colour is never the only channel: amenity pins carry a distinct emoji and label, transit modes carry a distinct dash pattern, and every layer has a legend. That matters because CBRE\'s palette is deliberately muted, so several brand hues sit closer together than a generic categorical palette would.'
    ]}
  ];

  WAMAP.CONFIG = {
    PALETTE, MAP, BASEMAPS, BASEMAP_GROUPS, LABEL_LAYERS, CENSUS, TIGERWEB, DEMO_METRICS, INSURANCE_METRICS,
    GEOCODE, OVERPASS, AMENITIES, NCES, TRANSIT, CRIME, ISOCHRONE, SOURCES,
    SQMI_PER_SQM
  };
})();
