# Washington Explorer

An interactive mapping app for Washington state: demographics, health-insurance coverage,
amenities, transit, crime, and 5/10/15-minute drive-time analysis from public, authoritative
data sources. Pure static site (Leaflet + vanilla JS, no front-end build step) on GitHub
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
| Health-insurance layer | % uninsured / % insured (civilian noninstitutionalized population), same county/tract engine |
| Amenities layer | Schools, colleges, grocery, restaurants/cafes, retail, pharmacies, hospitals/clinics, banks/credit unions, fuel/EV charging, parks/playgrounds — every category loaded statewide (no per-view caps or zoom limits), authoritative registries merged with OpenStreetMap; hospitals always visible and never clustered |
| Transit layer | Statewide routes and stops from WSDOT's consolidated GTFS (all WA agencies), styled by mode (bus, light rail/streetcar, rail, ferry), plus WSF ferry routes. Route popups link to the agency website and the route's schedule page |
| Crime layer | Statewide: every agency's annual NIBRS offense totals (WASPC), sized by offenses and colored by rate per 1,000. Incident level: Seattle, Tacoma, Bellevue, Redmond, Kirkland, Everett, Yakima, Pierce County Sheriff, King County Sheriff and Auburn. Per-category filters, 30/90/180/365-day ranges, clustered points or heat map, live in-view counts |
| Drive-time tool | 5/10/15-minute drive-time areas (isochrones) around any address, pin, or clicked point, with estimated population, households, and income inside each band |
| Shareable links | The URL hash tracks view, basemap, active layers, choropleth metrics, and drive-time origin; "Copy link" hands a colleague the exact analysis |

## Data sources (and why they were chosen)

The heavy, rate-limited or key-gated sources are fetched **at build time** by
`.github/workflows/build-data.yml` (monthly, plus weekly for crime incident files, and on
every change to `scripts/build-data/`) and committed as compact JSON under `data/`. The
browser loads those files same-origin from GitHub Pages, so no viewer's network has to
reach the Census API (which has required a key since May 2026), Overpass or a dozen
registries. A failed source never blocks the others: the last good file stays in place and
`data/manifest.json` records what each step fetched.

| Layer | Source | Notes |
|---|---|---|
| Demographics & insurance | [U.S. Census Bureau ACS 5-Year](https://www.census.gov/programs-surveys/acs) table-based Summary Files (keyless) → `data/acs/` | The only dataset published for **every** census tract; newest vintage detected automatically. Insurance from detailed table **B27010** (uninsured lines / universe), equivalent to subject table S2701. Setting a `CENSUS_API_KEY` secret switches the build to the Census Data API |
| Boundaries | [Census TIGERweb](https://tigerweb.geo.census.gov/arcgis/rest/services) generalized services → `data/geo/` | Tract and county polygons pre-built; live TIGERweb and `data/wa_counties.geojson` remain fallbacks |
| Hospitals & clinics | WA DOH licensed hospitals; CMS Provider of Services (hospitals, CAHs, FQHCs, rural health clinics, surgery centers) via HRSA; VHA facilities; HRSA health center sites; WA DOH public health clinics; OSM | The previous live Overpass query was capped at 600 results per view and printed clinic nodes before hospital campuses, so hospitals were cut off first |
| Pharmacies | WA DOH licensed pharmacies (HELMS) when available, else the NPPES NPI registry (Census-geocoded); OSM | OSM alone maps well under half of WA pharmacies |
| Grocery | USDA SNAP-authorized retailers; OSM | |
| Banks & credit unions | FDIC BankFind branches; NCUA call-report credit union branches (Census-geocoded); OSM | |
| Fuel & EV charging | NREL Alternative Fuels Data Center (public stations); OSM | |
| Parks & playgrounds | Washington State Parks; USGS PAD-US; OSM | |
| Schools & colleges | [NCES EDGE geocoded school locations](https://nces.ed.gov/programs/edge/geographic/schoollocations) | CCD (public), PSS (private), IPEDS (postsecondary); newest school year |
| Restaurants, retail | [OpenStreetMap](https://www.openstreetmap.org) (statewide Overpass extract) | No authoritative statewide registry with coordinates exists |
| Transit | [WSDOT statewide consolidated GTFS](https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer) (live) + agency websites from each agency's GTFS `agency.txt` via the [Mobility Database](https://mobilitydatabase.org) → `data/transit/agencies.json` | Route popups use the GTFS `route_url` for schedule pages; OSM fallback |
| Crime — statewide | [WASPC Crime in Washington](https://data.wa.gov/Public-Safety/Washington-State-Uniform-Crime-Reporting-National-/vvfu-ry7f) (NIBRS, OFM on data.wa.gov) → `data/crime/agencies.json` | Every agency; placed on its Census place (city police) or county (sheriff) |
| Crime — incidents (live) | Seattle PD (Socrata), Tacoma PD, Bellevue PD, Redmond PD, Kirkland PD, Yakima PD, Pierce County Sheriff (ArcGIS), Everett PD (Socrata) | Queried from the browser; ArcGIS layers are asked only for configured columns |
| Crime — incidents (pre-built) | King County Sheriff's Office, Auburn PD (Socrata) → `data/crime/` | Published with block addresses only; geocoded weekly with the Census batch geocoder |
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
  materially longer. Population inside bands uses tract-centroid allocation (a tract counts
  if its centroid is inside the band).
- Crime points are reported offenses, not convictions; some records lack coordinates and are
  excluded (the layer says how many). In WASPC's statewide totals, theft includes
  motor-vehicle theft and fraud, and DUI / trespass (arrest-only offenses) are not counted.
- Amenity points from different sources are de-duplicated by name and proximity; OSM
  completeness still varies by area for restaurants and retail.

## Architecture

```
index.html                 app shell + layer cards
assets/css/app.css         design system (light + dark)
assets/js/config.js        every endpoint, metric, category, palette token
assets/js/util.js          fetch/ArcGIS/Socrata/Overpass/Census clients, geocoding, geometry
assets/js/layers/          choropleth engine, amenities, transit, crime, drive time
data/                      pre-built datasets (acs/, geo/, amenities/, transit/, crime/, manifest.json)
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
vintages, Gazetteer files and TIGERweb services are discovered newest-first; the Seattle
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
node scripts/build-data/index.mjs amenities    # one step: acs, boundaries, amenities, transit, crime
```

## Attribution

Basemaps © OpenStreetMap contributors, © Esri, USGS. Data: U.S. Census Bureau, NCES, CMS,
HRSA, VHA, FDIC, NCUA, USDA FNS, NREL, USGS PAD-US, WA Department of Health, Washington State
Parks, WSDOT, WASPC / OFM, the Seattle, Tacoma, Bellevue, Redmond, Kirkland, Everett, Yakima
and Auburn police departments, the King County and Pierce County sheriffs, the Mobility
Database, OpenStreetMap contributors (ODbL), Valhalla/FOSSGIS. This project is not affiliated
with any of these providers.
