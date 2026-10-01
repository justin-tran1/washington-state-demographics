# Washington Explorer

An interactive mapping app for Washington state: demographics, health-insurance coverage,
city and county zoning, amenities, transit, crime, 5/10/15-minute drive-time analysis and a
medical site evaluation for any dropped pin, from public, authoritative data sources. Pure static site (Leaflet + vanilla JS, no front-end build step) on GitHub
Pages; a scheduled GitHub Action pre-builds the statewide datasets into `data/`.

**Live site:** https://justin-tran1.github.io/washington-state-demographics/ (once this is merged
to the default branch). Locally, open `index.html` via any static web server.

This repository is a GitHub Pages *project site*, so the app is served from the
`/washington-state-demographics/` sub-path rather than the domain root. Every asset path in the
app is relative, so it works unchanged at either location.

## Features

| Feature | Details |
|---|---|
| Toggleable base maps | 16 keyless base maps in 5 groups: OpenStreetMap, OSM Humanitarian, Esri Streets/Light Gray/Dark Gray/Imagery/Topographic, USGS Imagery, Imagery+Topo, Topo, Shaded Relief, Hydrography, OpenTopoMap, OPNVKarte transit, CyclOSM, WSDOT Washington base |
| Labels above data | Optional transparent reference layer drawn in its own pane above the choropleths, so place names stay readable through a fill |
| CBRE theming | Official CBRE brand palette throughout, with an Auto / Light / Dark switch; dark mode uses CBRE Dark Green panels with Accent Green highlights |
| Address search | Esri World Geocoder (keyless, limited to Washington) for addresses and places, OSM Nominatim fallback; jump-to with action popup |
| Pin dropping | Pin mode (Esc to exit), draggable pins, reverse-geocoded labels, persisted in `localStorage` |
| Demographics layer | Choropleth by county (statewide) or census tract (zoom 9+): population density, total population, median household income, median age, % bachelor's+, median home value, median gross rent, poverty rate, unemployment, owner-occupancy. Click any area for a full profile |
| Health-insurance layer | Uninsured and insured rates, the **payer mix** (employer-sponsored, direct-purchase, Medicare, Medicaid incl. dual eligibles, military, other combinations, uninsured; each person counted once, grouped the way KFF does) and the **insurance sources** (private, employer-based, direct-purchase, TRICARE, public, Medicare, Medicaid/means-tested, VA; alone or with other coverage), mapped by county and tract. Clicking an area shows its payer mix bar and source bars, each figure linked to its ACS table on data.census.gov |
| Zoning layer | Every city's zoning inside its limits and county zoning on unincorporated land (the county's is the backup where a city has none), from the Washington State Zoning Atlas, drawn from zoom 13. Colour by zone class or by whether office (medical) use is permitted, conditional, limited or not permitted. A zone's popup gives its code and name, allowed uses, height, FAR, lot coverage and parking minimums, overlays, and links to the code chapter |
| Medical site evaluation | "Evaluate for medical use" on any pin (or search result) opens a panel that scores the spot for a primary care clinic, multispecialty or medical office, urgent care or community health center, at the building size you enter, on the six weighted criteria of a healthcare site ranking: **market demand & growth** (catchment residents weighted by the care their ages use, OFM population growth and county projections), **access & connectivity** (arterials, freeway interchanges, transit), **competitive positioning** (same-type providers per resident, nearby hospitals and care), **financial viability** (payer mix, income, unemployment), **site feasibility** (zoning checked against the city's own live map, parcel size and parking, slope and flood zone, nearby shelters) and **visibility & long-term potential** (frontage and traffic counts, the retail corridor, housing growth nearby). Each criterion is rated 1-5 and the weights (editable, kept per use type) combine them into a score out of 100. It writes a short summary of strengths and watch-outs, outlines the parcel and catchment on the map, and copies as text |
| Site ranking | "Rank all pins" (from the evaluation panel or a pin's popup) compares every pin, up to eight, side by side: a column per site, best first, with each criterion's 1-5 rating, a bar and the facts behind it, and the overall score labelled most favorable, second most favorable or less favorable. Switching the use type or editing a weight re-ranks at once without fetching again; a site whose zoning rules out medical use is ranked last. Copies as text or downloads as CSV |
| Amenities layer | Schools, colleges, grocery, restaurants/cafes, retail, pharmacies, hospitals/clinics, banks/credit unions, fuel/EV charging, parks/playgrounds — every category loaded statewide (no per-view caps or zoom limits), authoritative registries merged with OpenStreetMap; hospitals always visible and never clustered |
| Transit layer | Statewide routes and stops from WSDOT's consolidated GTFS (all WA agencies), styled by mode (bus, light rail/streetcar, rail, ferry), plus WSF ferry routes. Route popups link to the agency website and the route's schedule page |
| Crime layer | Statewide: every agency's annual NIBRS offense totals (WASPC), sized by offenses and colored by rate per 1,000. Incident level: Seattle, Tacoma, Bellevue, Redmond, Kirkland, Everett, Yakima, Pierce County Sheriff, King County Sheriff and Auburn. Per-category filters, 30/90/180/365-day ranges, clustered points or heat map, live in-view counts |
| Drive-time tool | 5/10/15-minute drive-time areas (isochrones) around any address, pin, or clicked point, with estimated population, households, and income inside each band |
| Radius & area search | A radius around any pin (type a distance in mi / km / m / ft, or drag the circle's handle; add 1-3-5 mile rings) or a polygon drawn on the map with the mouse, a finger or the keyboard (arrow keys move the map, A adds a corner at the crosshair, Enter closes the area). Drag corners to reshape, drag a midpoint to add a corner, right-click, double-click or long-press a corner to remove it, drag the label to move the area. Each shape lists every amenity and every transit stop and route inside it or touching its edge, grouped by category, with click-to-locate and CSV export. Colour, fill and outline opacity, outline width and style are set per shape; shapes are saved in the browser |
| Shareable links | The URL hash tracks view, basemap, active layers, choropleth metrics, and drive-time origin; "Copy link" hands a colleague the exact analysis |

## Data sources (and why they were chosen)

The heavy, rate-limited or key-gated sources are fetched **at build time** by
`.github/workflows/build-data.yml` (monthly, plus weekly for crime incident files, and on
every change to `scripts/build-data/`) and committed as compact JSON under `data/`. The
browser loads those files same-origin from GitHub Pages, so no viewer's network has to
reach the Census Data API (whose data queries have required a key since May 2026),
Overpass or a dozen registries. A failed source never blocks the others: its last good data
stays in place (a failed amenity source's rows, an agency's previous website, the published
boundaries rather than water-inclusive fallback polygons) and `data/manifest.json` records
what each step fetched.

| Layer | Source | Notes |
|---|---|---|
| Demographics & insurance | [U.S. Census Bureau ACS 5-Year](https://www.census.gov/programs-surveys/acs) table-based Summary Files (keyless) → `data/acs/` | The only dataset published for **every** census tract; newest vintage detected automatically. Insurance from detailed tables **B27010** (uninsured share, equivalent to subject table S2701, and the payer mix) and **B27002**, **B27003** and **C27004–C27009** (coverage by type; the 5-year estimates publish the single-type tables as collapsed C tables); every line is identified from its Census label at build time and checked, and the payer-mix method is written out in *Sources & methodology*. Setting a `CENSUS_API_KEY` secret switches the build to the Census Data API |
| Boundaries | [Census cartographic boundary files](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html) (500k, clipped to the shoreline) → `data/geo/` | Tract and county polygons pre-built; TIGERweb and `data/wa_counties.geojson` remain fallbacks |
| Hospitals & clinics | WA DOH licensed hospitals; CMS Provider of Services (hospitals, CAHs, FQHCs, rural health clinics, surgery centers) via HRSA; VHA facilities; HRSA health center sites; WA DOH public health clinics; OSM | The previous live Overpass query was capped at 600 results per view and printed clinic nodes before hospital campuses, so hospitals were cut off first |
| Pharmacies | WA DOH licensed pharmacies (HELMS) when available, else the NPPES NPI registry (Census-geocoded); OSM | OSM alone maps well under half of WA pharmacies |
| Grocery & convenience stores | USDA SNAP-authorized retailers; OSM | About two thirds are convenience stores (own marker) |
| Banks & credit unions | FDIC BankFind branches; NCUA call-report credit union branches (Census-geocoded); OSM | |
| Fuel & EV charging | NREL Alternative Fuels Data Center (public stations); OSM | |
| Parks & playgrounds | Washington State Parks; USGS PAD-US; OSM | |
| Schools & colleges | [NCES EDGE geocoded school locations](https://nces.ed.gov/programs/edge/geographic/schoollocations) | CCD (public), PSS (private), IPEDS (postsecondary); newest school year |
| Restaurants, retail | [OpenStreetMap](https://www.openstreetmap.org) (statewide Overpass extract) | No authoritative statewide registry with coordinates exists |
| Transit | [WSDOT statewide consolidated GTFS](https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer) (live) + agency websites from each agency's GTFS `agency.txt` via the [Mobility Database](https://mobilitydatabase.org) → `data/transit/agencies.json` | Route popups use the GTFS `route_url` for schedule pages; OSM fallback |
| Crime — statewide | [WASPC Crime in Washington](https://data.wa.gov/Public-Safety/Washington-State-Uniform-Crime-Reporting-National-/vvfu-ry7f) (NIBRS, OFM on data.wa.gov) → `data/crime/agencies.json` | Every agency; placed on its Census place (city police) or county (sheriff) |
| Crime — incidents (live) | Seattle PD (Socrata), Tacoma PD, Bellevue PD, Redmond PD, Kirkland PD, Yakima PD, Pierce County Sheriff (ArcGIS), Everett PD (Socrata) | Queried from the browser; ArcGIS layers are asked only for configured columns |
| Crime — incidents (pre-built) | King County Sheriff's Office, Auburn PD (Socrata) → `data/crime/` | Geocoded weekly with the Census batch geocoder at block level only: Auburn's exact addresses are generalized to the block, and its sex-offense, child-abuse, protection-order, stalking and kidnapping reports are withheld |
| Zoning | [Washington State Zoning Atlas](https://www.commerce.wa.gov/growth-management/data-research/waza/) (WA Department of Commerce, live) | Zones for 278 of 320 cities, towns and counties with normalized classes, allowed uses and development standards; the site evaluation also queries the city's own zoning layer the atlas records (83 answer with CORS) to catch rezones since the atlas was compiled |
| Site evaluation | [WA statewide tax parcels](https://geo.wa.gov/maps/2b603a599a0842a3b2284c04c8927f35), [WSDOT functional classification](https://data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass) and [traffic counts](https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/FeatureServer), [USGS Elevation Point Query Service](https://epqs.nationalmap.gov/v1/docs) (Open-Meteo fallback), [FEMA National Flood Hazard Layer](https://hazards.fema.gov/), OpenStreetMap parking, shelters and interchanges (Overpass), plus the transit, amenity, ACS and drive-time sources above (all live); [OFM small area estimates](https://ofm.wa.gov/washington-data-research/population-demographics/population-estimates/small-area-estimates-program) (tract population and housing units) and [OFM Growth Management Act county projections](https://ofm.wa.gov/washington-data-research/population-demographics/population-forecasts-and-projections/growth-management-act-county-projections) → `data/growth.json`; ACS age bands (B01001) weighted by physician-office visit rates by age from the [National Ambulatory Medical Care Survey](https://www.cdc.gov/nchs/namcs/) 2019 | Parcels are read for identity, size, land use and assessed values only, never owner fields; shelters that may serve abuse victims or minors are never used and only distances are shown. Weights and thresholds are in `SITE_EVAL` in `config.js` and written out in *Sources & methodology* |
| Drive times | [Valhalla](https://github.com/valhalla/valhalla) routing engine on the public [FOSSGIS server](https://valhalla.openstreetmap.de) | Open-source isochrones over the OSM road network. Free keyless services model **typical** conditions, not live congestion — the UI says so explicitly |
| Geocoding | [Esri World Geocoder](https://developers.arcgis.com/rest/geocode/) + [Nominatim](https://nominatim.org) | Esri answers keyless with CORS; the Census geocoder sends no CORS header, so browsers cannot use it |
| Base maps | USGS The National Map, Esri ArcGIS Online, OpenStreetMap + community servers, WSDOT | All keyless; see the licensing section below |

There is no statewide *incident-level* crime feed, so the crime layer pairs statewide agency
totals with incident reports from every department found to publish them openly. Crime
category filters use one NIBRS keyword rule set across sources so filters behave consistently,
but reporting practices differ between agencies: **compare within a source, not across
sources.**

Optional repository secrets: `CENSUS_API_KEY` (Census Data API instead of Summary Files) and
`DATA_GOV_KEY` (higher NREL / FBI rate limits than `DEMO_KEY`). Neither is required.

## Accuracy notes

- ACS values are 5-year survey estimates with margins of error; small tracts are noisy.
  Suppressed values render as "no data".
- Drive-time bands are estimates for typical conditions; peak-hour urban drive times can be
  materially longer. Population inside bands allocates whole tracts: a tract counts if its
  Census internal point (Gazetteer INTPTLAT/INTPTLONG, always inside the tract) is in the band.
- Crime points are reported offenses, not convictions; some records lack coordinates and are
  excluded (the layer says how many). In WASPC's statewide totals, theft includes
  motor-vehicle theft and fraud, and DUI / trespass (arrest-only offenses) are not counted.
- Zoning comes from the state zoning atlas, compiled from each jurisdiction's code as of
  2024-2025. It is not an official zoning map; popups link the code chapter, and the site
  evaluation flags a zone that the city's own current map shows differently.
- The site evaluation and ranking are screening scores, not an appraisal, market study or
  zoning determination. The six criteria and their default weights follow a common healthcare
  site-ranking framework (demand & growth 30%, access 20%, competition 20%, financial 15%,
  feasibility 10%, visibility 5% for primary care, with variants per use type); they are a
  starting point, so edit them to match the brief. Competition counts undercount private
  practices (registries list hospitals, health centers and surgery centers completely;
  practices come from OSM), and mapped parking depends on OSM coverage. Demand weights
  residents by national visit rates by age, not by local utilization or claims.
- Amenity points from different sources are de-duplicated two ways. The same name nearby:
  distinctive words must mostly agree (town names, health-system brands and store numbers do
  not count; unnamed places never match), and the radius widens for address-geocoded
  registries and large parks. The same kind of place at the same spot: clinics, pharmacies,
  banks and fuel stations from two sources within 30-45 m merge whatever their names, because
  registries and OSM often name one place differently; hospitals (30 m), grocery stores and
  parks (10 m) merge beyond that only when their names share a word. Every hospital the merge
  drops is listed in the build log. OSM completeness still varies by area for restaurants and
  retail.

## Architecture

```
index.html                 app shell + layer cards
assets/css/app.css         design system (light + dark)
assets/js/config.js        every endpoint, metric, category, palette token
assets/js/util.js          fetch/ArcGIS/Socrata/Overpass/Census clients, geocoding, geometry
assets/js/layers/          choropleth engine, amenities, transit, crime, drive time, radius & area search,
                           zoning, medical site evaluation and the site ranking
data/                      pre-built datasets (acs/, geo/, amenities/, transit/, crime/, growth.json, manifest.json)
data/wa_counties.geojson   bundled county-boundary fallback
scripts/build-data/        the data pipeline run by the "Build map data" Action (one module per dataset)
scripts/check-sources.sh   weekly source-health probe ("Check data sources" Action)
scripts/build_counties.mjs rebuilds the bundled counties from us-atlas
scripts/smoke-test.mjs     headless-Chromium integration test (mocked live APIs, real data/ files)
```

Leaflet 1.9.4 + markercluster + heat load from pinned CDN versions (unpkg, jsDelivr
fallback) with SRI integrity hashes computed from the exact npm tarballs.

## Brand and colour

The interface uses the official CBRE palette — CBRE Green `#003F2D`, Accent Green `#17E88F`,
Dark Green `#012A2D`, Dark Grey `#435254`, plus the CBRE secondary and chart colours. Light
mode is white panels with CBRE Green as the accent; dark mode is CBRE Dark Green panels with
Accent Green as the accent, which matches the brand's "use Accent Green sparingly, for
highlights" rule.

Data ramps are **not** raw brand swatches. CBRE publishes a five-step sequential ramp
(`#17E88F → #012A2D`), but it spans 46° of hue, so it fails a single-hue check and cannot
carry a choropleth on its own. Every ramp here was instead generated in OKLCH at a CBRE brand
hue with brand-matched chroma, then checked with the `dataviz` palette validator. Recorded
results:

| Role | Basis | Validator outcome |
|---|---|---|
| Demographics ramp | CBRE Green hue (167°), 6 steps | monotone lightness, ΔL gaps, single hue — pass, both themes |
| Insurance ramp | Midnight hue (245°), 6 steps | same — pass, both themes; a different hue family so the two choropleths never read alike |
| Crime heat | Negative-red hue (26°), 6 stops | monotone, single hue — pass |
| Drive-time bands | Wheat hue (106°), 3 ordinal steps | full ordinal suite passes in both themes (2.24:1 on white, 2.65:1 on Dark Green). A third hue family on purpose: the bands are large translucent fills that can sit on top of a choropleth, so they must not share a hue with either ramp |
| Crime groups | red / blue / olive at brand hues | all-pairs CVD and normal-vision floors pass in both themes (worst 17.3 deutan, 25.3 normal in dark) |
| Amenity pins (10) | CBRE chart hues | worst *adjacent* pair ΔE 15.7; all-pairs cannot pass at ten categories, so emoji + label carry identity |
| Transit modes (5) | CBRE chart hues | adjacent pairs pass in both themes; each mode also has its own dash pattern |
| Payer mix (5 payers + 2 neutrals) | CBRE chart hues, one hue per payer in both themes | adjacent stacked segments pass: worst CVD ΔE 18.9 / normal 19.3 light, 16.7 / 19.0 dark (military re-stepped for dark); "other" recedes and "uninsured" stands out as neutrals, and every value is listed beside the bar |
| Zoning classes (8 + neutral) | Planning convention (LBCS: yellow residential, orange multifamily, magenta mixed use, red commercial, purple industrial, blue public, green open space, olive rural) | searched in OKLCH for the best **all-pairs** separation, since any two zones can touch on a map: worst CVD ΔE 9.0, normal 15.2, lightness and chroma in band; the yellow is under 3:1 on white, so the legend, tooltip and popup always name the class |
| Office & medical use (3 + neutral) | green permitted / amber conditional / purple limited | all-pairs CVD ΔE 12.1; "not permitted" recedes as a light neutral and "not recorded" is left unfilled with a dashed edge |

For sequential ramps the step nearest the surface is allowed to recede — in a sequential
encoding that step means "near zero". Where the validator warns, the mitigation is real and
documented rather than waved away: colour is never the only channel, because CBRE's palette is
deliberately muted and several brand hues sit closer together than a generic categorical
palette would.

## Base map licensing

All 16 are keyless, but their terms differ and that matters for commercial use:

- **USGS The National Map** (Imagery, Imagery+Topo, Topo, Shaded Relief, Hydrography) — U.S.
  federal works in the public domain, no commercial restriction. The cleanest option here.
- **Esri** (`server.arcgisonline.com`) — keyless, but these are legacy raster layers in Esri
  Mature Support with cartography frozen around 2021; World Imagery is an explicit exception
  and is still maintained. An organisation with an ArcGIS entitlement should repoint these at
  its own keyed basemap service.
- **OpenStreetMap and community servers** (OSM France, OpenTopoMap, MeMoMaps) — volunteer
  funded; their usage policies ask that heavy or commercial traffic not lean on them.
- **WSDOT** — Washington State agency service, published openly; Washington coverage only.
- **CARTO was removed.** CARTO began requiring an API key on `basemaps.cartocdn.com` in late
  August 2026 and now stamps anonymous tiles with an "API KEY REQUIRED" watermark while still
  returning HTTP 200 — so `tileerror` never fires and the map just looks broken. CARTO's own
  `basemap-styles` licence also restricts the tile services to enterprise customers.

Resilience: every build step is isolated and a failure keeps the last good file; ACS
vintages, Gazetteer files, cartographic boundary files and TIGERweb services are discovered
newest-first; the Seattle
adapter resolves column names from the dataset's live metadata (SPD has republished the
dataset with new columns before) and has domain failover; WSDOT falls back to OSM. Every
layer shows its own source/status line, and failures degrade per-layer with a visible
message.

## Development

```bash
python3 -m http.server 8137          # serve the app at http://localhost:8137
node --check assets/js/**/*.js       # syntax check

# integration test (mocked live APIs + the committed data/ files, headless Chromium)
npm i playwright-core leaflet@1.9.4 leaflet.markercluster@1.5.3 leaflet.heat@0.2.0
CHROMIUM_PATH=/path/to/chromium node scripts/smoke-test.mjs

# rebuild datasets locally (Node 22+, network access); or run the "Build map data" Action
node scripts/build-data/index.mjs              # every step
node scripts/build-data/index.mjs amenities    # one step: acs, growth, boundaries, amenities, transit, crime
```

## Attribution

Basemaps © OpenStreetMap contributors, © Esri, USGS. Data: U.S. Census Bureau, NCHS, NCES, CMS,
HRSA, VHA, FDIC, NCUA, USDA FNS, NREL, USGS PAD-US and 3DEP, FEMA, WA Department of Health,
WA Department of Commerce (Washington State Zoning Atlas), the Washington statewide parcels
project and county assessors, Washington State Parks, WSDOT, WA Office of Financial Management, WASPC, the Seattle, Tacoma, Bellevue, Redmond, Kirkland, Everett, Yakima
and Auburn police departments, the King County and Pierce County sheriffs, the Mobility
Database, OpenStreetMap contributors (ODbL), Valhalla/FOSSGIS. This project is not affiliated
with any of these providers.
