#!/usr/bin/env bash
# Probes the data sources the app depends on - first those the browser calls
# directly (sent with an Origin header, so the CORS column shows whether a
# browser may read the answer), then those only the data build reads. Records
# HTTP status, CORS allow-origin and the first bytes of the body.
# Report-only: a source being down does not fail CI.
set -u
ORIGIN="https://justin-tran1.github.io"
OUT="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
UA="washington-state-demographics source check (github.com/justin-tran1/washington-state-demographics)"

printf '| Source | HTTP | CORS allow-origin | Body starts |\n|---|---|---|---|\n' >> "$OUT"

probe() { # name method url [data] [content-type]
  local name="$1" method="$2" url="$3" data="${4:-}" ctype="${5:-application/x-www-form-urlencoded}"
  local hdr body code acao
  hdr=$(mktemp); body=$(mktemp)
  if [ "$method" = POST ]; then
    code=$(curl -sS -m 40 -o "$body" -D "$hdr" -w '%{http_code}' -A "$UA" -H "Origin: $ORIGIN" \
           -H "Content-Type: $ctype" --data "$data" "$url" 2>/dev/null || echo 000)
  elif [ "$method" = OPTIONS ]; then
    code=$(curl -sS -m 40 -o "$body" -D "$hdr" -w '%{http_code}' -A "$UA" -X OPTIONS -H "Origin: $ORIGIN" \
           -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type,x-client-id" \
           "$url" 2>/dev/null || echo 000)
  else
    code=$(curl -sS -m 40 -L -o "$body" -D "$hdr" -w '%{http_code}' -A "$UA" -H "Origin: $ORIGIN" \
           "$url" 2>/dev/null || echo 000)
  fi
  acao=$(grep -i '^access-control-allow-origin:' "$hdr" | tail -1 | cut -d' ' -f2- | tr -d '\r')
  [ -z "$acao" ] && acao="MISSING"
  local snippet; snippet=$(head -c 110 "$body" | tr '\n\r|' '   ')
  echo "PROBE|$name|$code|$acao|$snippet"
  printf '| %s | %s | %s | `%s` |\n' "$name" "$code" "$acao" "$snippet" >> "$OUT"
  rm -f "$hdr" "$body"
}

# ===== Called from the viewer's browser: CORS matters =====================
# ---- Transit ---------------------------------------------------------------
probe "wsdot TransitData" GET "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer?f=json"
probe "wsdot FerryRoutes" GET "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/FerryRoutes/MapServer?f=json"

# ---- Crime incident feeds (live) ------------------------------------------
probe "seattle SPD rows" GET 'https://data.seattle.gov/resource/tazs-3rd5.json?$limit=1'
probe "seattle SPD metadata" GET "https://data.seattle.gov/api/views/tazs-3rd5.json"
probe "seattle SPD rows (cos-data failover)" GET 'https://cos-data.seattle.gov/resource/tazs-3rd5.json?$limit=1'
probe "tacoma TPD_RMS_Crime" GET "https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/TPD_RMS_Crime/FeatureServer/0?f=json"
probe "bellevue Offenses" GET "https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Offenses/FeatureServer/1?f=json"
probe "redmond Crimes" GET "https://gis.redmond.gov/arcgis/rest/services/CrimeMap/Crimes/FeatureServer/0?f=json"
probe "kirkland offenses" GET "https://maps.kirklandwa.gov/host/rest/services/Hosted/CrimeAnalysis_(Public)/FeatureServer/2?f=json"
probe "everett police cases" GET 'https://data.everettwa.gov/resource/szww-y224.json?$limit=1'
probe "pierce sheriff" GET "https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Crime_Data/FeatureServer/1?f=json"
probe "yakima crimes" GET "https://services5.arcgis.com/drBwGNA3YMS2QPJd/arcgis/rest/services/Crimes_public_fc349e427d9945729c4e985666b31686/FeatureServer/0?f=json"

# ---- Zoning and the medical site evaluation --------------------------------
WAZA="https://services6.arcgis.com/tboeqGwETr5ppr5Q/arcgis/rest/services/WAZA_Prototype_Layers/FeatureServer"
probe "zoning atlas zones (layer)" GET "$WAZA/0?f=json"
probe "zoning atlas zone at a point" GET "$WAZA/0/query?geometry=-122.3331,47.6097&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ZoneID,WAZAZoneGeneral,UseOffice&returnGeometry=false&f=json"
probe "zoning atlas jurisdictions" GET "$WAZA/2/query?where=1%3D1&returnCountOnly=true&f=json"
probe "WA statewide parcels" GET "https://services.arcgis.com/jsIt88o09Q0r1j8h/arcgis/rest/services/Current_Parcels/FeatureServer/0/query?geometry=-122.3331,47.6097&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=PARCEL_ID_NR,LANDUSE_CD,Shape__Area&returnGeometry=false&f=json"
probe "WSDOT functional class" GET "https://data.wsdot.wa.gov/arcgis/rest/services/FunctionalClass/WSDOTFunctionalClassData/FeatureServer/1/query?geometry=-122.319,47.6205&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=250&units=esriSRUnit_Meter&outFields=FederalFunctionalClassCode,RoadName&returnGeometry=false&f=json"
probe "WSDOT traffic sections" GET "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TrafficData/FeatureServer/1/query?geometry=-122.3470,47.6616&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&distance=150&units=esriSRUnit_Meter&outFields=AADT&returnGeometry=false&f=json"
probe "USGS elevation point query" GET "https://epqs.nationalmap.gov/v1/json?x=-122.3331&y=47.6097&wkid=4326&units=Feet&includeDate=false"
probe "Open-Meteo elevation (fallback)" GET "https://api.open-meteo.com/v1/elevation?latitude=47.6097&longitude=-122.3331"
probe "FEMA flood hazard zones" GET "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?geometry=-121.83,47.53&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,SFHA_TF&returnGeometry=false&f=json"
probe "overpass (site evaluation)" POST "https://overpass-api.de/api/interpreter" 'data=%5Bout%3Ajson%5D%3Bnode(around%3A3000%2C47.6097%2C-122.3331)%5Bsocial_facility%3Dshelter%5D%3Bout%203%3B'

# ---- Drive time / geocoding ----------------------------------------------
probe "esri world geocoder" GET "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?SingleLine=400%20Broad%20St%2C%20Seattle%2C%20WA&f=json&maxLocations=1"
probe "valhalla preflight" OPTIONS "https://valhalla1.openstreetmap.de/isochrone"
probe "valhalla isochrone" POST "https://valhalla1.openstreetmap.de/isochrone" '{"locations":[{"lat":47.6062,"lon":-122.3321}],"costing":"auto","contours":[{"time":5}],"polygons":true}' "application/json"
probe "nominatim" GET "https://nominatim.openstreetmap.org/search?q=Seattle&format=jsonv2&limit=1"
probe "overpass (transit fallback)" POST "https://overpass-api.de/api/interpreter" 'data=%5Bout%3Ajson%5D%3Bnode(47.60%2C-122.35%2C47.62%2C-122.32)%5Bamenity%3Dcafe%5D%3Bout%203%3B'

# ===== Called only by the "Build map data" Action (CORS irrelevant) =========
probe "census ACS summary file dir" GET "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/"
probe "census cartographic boundary files" GET "https://www2.census.gov/geo/tiger/GENZ2025/shp/"
probe "census gazetteer files" GET "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
probe "census ACS variable metadata (B27010)" GET "https://api.census.gov/data/2024/acs/acs5/groups/B27010.json"
probe "tigerweb ACS2024 Tracts (boundary fallback)" GET "https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2024/Tracts_Blocks/MapServer?f=json"
probe "WA DOH hospitals" GET "https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Hospitals/FeatureServer/0?f=json"
probe "WA DOH HELMS facilities" GET "https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Facility_HELMS_Report_DEC2025/FeatureServer/0?f=json"
probe "HRSA CMS facilities" GET "https://gisportal.hrsa.gov/server/rest/services/HealthCareFacilities/CMSApprovedFacilities_FS/MapServer?f=json"
probe "HRSA health centers" GET "https://gisportal.hrsa.gov/server/rest/services/HealthCareFacilities/PrimaryHealthCareFacilities_FS/MapServer/0?f=json"
probe "HRSA VA facilities" GET "https://gisportal.hrsa.gov/server/rest/services/HealthCareFacilities/VHAFacilities_FS/MapServer/0?f=json"
probe "CMS hospital general information" GET 'https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?limit=1'
probe "WA DOH public health clinics" GET "https://services8.arcgis.com/rGGrs6HCnw87OFOT/arcgis/rest/services/Clinics/FeatureServer/0?f=json"
probe "NPPES registry" GET "https://npiregistry.cms.hhs.gov/api/?version=2.1&taxonomy_description=Pharmacy&state=WA&limit=1"
probe "census batch geocoder" GET "https://geocoding.geo.census.gov/geocoder/benchmarks"
probe "FDIC locations" GET "https://api.fdic.gov/banks/locations?filters=STALP:WA&limit=1"
probe "USDA SNAP retailers" GET "https://services1.arcgis.com/RLQu0rK7h4kbsBq5/arcgis/rest/services/snap_retailer_location_data/FeatureServer/0?f=json"
probe "NREL/NLR fuel stations" GET "https://developer.nlr.gov/api/alt-fuel-stations/v1.json?api_key=DEMO_KEY&state=WA&limit=1"
probe "NCES k12 folder" GET "https://nces.ed.gov/opengis/rest/services/K12_School_Locations?f=json"
probe "NCES postsecondary folder" GET "https://nces.ed.gov/opengis/rest/services/Postsecondary_School_Locations?f=json"
probe "NCUA call report data page" GET "https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data"
probe "PAD-US" GET "https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Manager_Type_PADUS/FeatureServer/0?f=json"
probe "WA State Parks" GET "https://services5.arcgis.com/4LKAHwqnBooVDUlX/arcgis/rest/services/ParkBoundaries/FeatureServer/2?f=json"
probe "Mobility Database catalog" GET "https://files.mobilitydatabase.org/feeds_v2.csv"
probe "WASPC NIBRS (data.wa.gov)" GET 'https://data.wa.gov/resource/vvfu-ry7f.json?$limit=1'
probe "King County Sheriff offenses" GET 'https://data.kingcounty.gov/resource/4kmt-kfqf.json?$limit=1'
probe "Auburn crimes" GET 'https://data.auburnwa.gov/resource/8g4u-7zzy.json?$limit=1'
probe "FBI CDE agencies (keyless)" GET "https://cde.ucr.cjis.gov/LATEST/agency/byStateAbbr/WA"
probe "FBI CDE agencies (api.usa.gov fallback)" GET "https://api.usa.gov/crime/fbi/cde/agency/byStateAbbr/WA?API_KEY=DEMO_KEY"
