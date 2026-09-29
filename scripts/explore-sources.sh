#!/usr/bin/env bash
# Temporary exploration probe (removed before merge).
set -u
UA="washington-state-demographics build (github.com/justin-tran1/washington-state-demographics)"
ORIGIN="https://justin-tran1.github.io"
sec() { echo; echo "=================== $1"; }
get() { curl -sS -m 60 -L -A "$UA" -H "Origin: $ORIGIN" "$@"; }

sec "ACS 2024 table-based summary file: directory"
get "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/" | grep -oE 'acsdt5y2024-b(01003|01002|19013|19301|25077|25064|15003|17001|23025|25003|11001|27010|27001)\.dat' | sort -u
get -I "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01003.dat" | grep -iE '^(HTTP|content-length|last-modified)'
sec "B01003 header + WA county rows"
get "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01003.dat" | { head -1; grep -E '^0500000US53' | head -3; }
sec "B27010 header + one WA county row"
get "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b27010.dat" | { head -1 | tr '|' '\n' | head -70 | tr '\n' ' '; echo; grep -E '^0500000US53033' | head -1; }
sec "summary-file geography reference"
get "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/documentation/" | grep -oE 'href="[^"]+"' | head -20
sec "API variable metadata (keyless?) B27010"
get "https://api.census.gov/data/2024/acs/acs5/groups/B27010.json" | head -c 600; echo

sec "Esri World Geocoder keyless + CORS"
curl -sS -m 30 -D - -o /tmp/g.json -A "$UA" -H "Origin: $ORIGIN" "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?SingleLine=400%20Broad%20St%2C%20Seattle%2C%20WA&f=json&maxLocations=1&outFields=Match_addr,Addr_type" | grep -iE '^(HTTP|access-control-allow-origin)'; head -c 400 /tmp/g.json; echo

sec "Overpass statewide query timing (hospitals, WA)"
time curl -sS -m 180 -A "$UA" --data-urlencode 'data=[out:json][timeout:170];area["ISO3166-2"="US-WA"][admin_level=4]->.wa;(nwr["amenity"="hospital"](area.wa);nwr["healthcare"="hospital"](area.wa););out center tags;' https://overpass-api.de/api/interpreter -o /tmp/h.json; python3 -c "import json;d=json.load(open('/tmp/h.json'));print('elements:',len(d['elements']))"

sec "FBI CDE: NIBRS offense summary for Seattle PD (WASPD0000)"
get "https://api.usa.gov/crime/fbi/cde/summarized/agency/WASPD0000/violent-crime?from=01-2023&to=12-2024&API_KEY=DEMO_KEY" | head -c 700; echo
get "https://api.usa.gov/crime/fbi/cde/agency/byStateAbbr/WA?API_KEY=DEMO_KEY" | python3 -c "import json,sys;d=json.load(sys.stdin);n=sum(len(v) for v in d.values());print('WA agencies:',n,'counties:',len(d));a=next(iter(d.values()))[0];print('fields:',sorted(a.keys()))"
