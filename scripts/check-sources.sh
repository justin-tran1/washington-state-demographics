#!/usr/bin/env bash
# Probes every live data source the app calls from the browser, the way a
# browser would: with an Origin header. For each it records the HTTP status,
# whether the response carries a CORS header the browser will accept, and the
# first bytes of the body. Report-only: a source being down does not fail CI.
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

# ---- Census Data API (demographics + insurance) --------------------------
for y in 2024 2023; do
  probe "census acs5 $y county" GET "https://api.census.gov/data/$y/acs/acs5?get=NAME,B01003_001E,B19013_001E&for=county:*&in=state:53"
  probe "census subject S2701 $y county" GET "https://api.census.gov/data/$y/acs/acs5/subject?get=S2701_C01_001E,S2701_C03_001E,S2701_C05_001E&for=county:*&in=state:53"
done
probe "census tract in=space-joined" GET "https://api.census.gov/data/2024/acs/acs5?get=NAME,B01003_001E&for=tract:*&in=state:53%20county:*"
probe "census tract in=repeated" GET "https://api.census.gov/data/2024/acs/acs5?get=NAME,B01003_001E&for=tract:*&in=state:53&in=county:*"
probe "census all 20 vars (app query)" GET "https://api.census.gov/data/2024/acs/acs5?get=NAME,B01003_001E,B01002_001E,B19013_001E,B19301_001E,B25077_001E,B25064_001E,B15003_001E,B15003_022E,B15003_023E,B15003_024E,B15003_025E,B17001_001E,B17001_002E,B23025_003E,B23025_005E,B25003_001E,B25003_002E,B11001_001E&for=county:*&in=state:53"
probe "tigerweb ACS2024 State_County" GET "https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2024/State_County/MapServer?f=json"
probe "tigerweb ACS2024 Tracts" GET "https://tigerweb.geo.census.gov/arcgis/rest/services/Generalized_ACS2024/Tracts_Blocks/MapServer?f=json"
probe "census geocoder" GET "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=400+Broad+St+Seattle+WA&benchmark=Public_AR_Current&format=json"

# ---- Esri Living Atlas ACS layers (CORS-friendly alternative) -----------
probe "esri ACS health insurance" GET "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Health_Insurance_Coverage_Variables_Boundaries/FeatureServer?f=json"
probe "esri ACS population" GET "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/ACS_Population_Variables_Boundaries/FeatureServer?f=json"

# ---- Amenities -----------------------------------------------------------
Q='data=%5Bout%3Ajson%5D%3Bnode(47.60%2C-122.35%2C47.62%2C-122.32)%5Bamenity%3Dcafe%5D%3Bout%203%3B'
for ep in https://overpass-api.de/api/interpreter https://overpass.kumi.systems/api/interpreter https://overpass.private.coffee/api/interpreter; do
  probe "overpass $(echo $ep | cut -d/ -f3)" POST "$ep" "$Q"
done
probe "nces k12 folder" GET "https://nces.ed.gov/opengis/rest/services/K12_School_Locations?f=json"
probe "nces postsecondary folder" GET "https://nces.ed.gov/opengis/rest/services/Postsecondary_School_Locations?f=json"

# ---- Transit ---------------------------------------------------------------
probe "wsdot TransitData" GET "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer?f=json"
probe "wsdot FerryRoutes" GET "https://data.wsdot.wa.gov/arcgis/rest/services/Shared/FerryRoutes/MapServer?f=json"
probe "wsdot gtfs list" GET "https://data.wsdot.wa.gov/gtfs/list.html"

# ---- Crime -----------------------------------------------------------------
probe "seattle SPD rows" GET 'https://data.seattle.gov/resource/tazs-3rd5.json?$limit=1'
probe "seattle SPD metadata" GET "https://data.seattle.gov/api/views/tazs-3rd5.json"
probe "tacoma item" GET "https://www.arcgis.com/sharing/rest/content/items/4b9326bf98c84fe4a1d8526ee6870c2d?f=json"
probe "spokane CrimePoints" GET "https://services6.arcgis.com/ydggmMcp46DZ7B9Z/ArcGIS/rest/services/CrimePoints/FeatureServer?f=json"
probe "fbi CDE (DEMO_KEY)" GET "https://api.usa.gov/crime/fbi/cde/agency/byStateAbbr/WA?API_KEY=DEMO_KEY"

# ---- Drive time / geocoding ----------------------------------------------
probe "valhalla preflight" OPTIONS "https://valhalla1.openstreetmap.de/isochrone"
probe "valhalla isochrone" POST "https://valhalla1.openstreetmap.de/isochrone" '{"locations":[{"lat":47.6062,"lon":-122.3321}],"costing":"auto","contours":[{"time":5}],"polygons":true}' "application/json"
probe "nominatim" GET "https://nominatim.openstreetmap.org/search?q=Seattle&format=jsonv2&limit=1"
