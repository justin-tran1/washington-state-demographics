#!/usr/bin/env bash
# Temporary probe: data for the site-ranking framework (growth, age, visit rates).
set -u
SF=https://www2.census.gov/programs-surveys/acs/summary_file
echo "### ACS table-based summary files: which 5-year vintages exist"
for y in 2019 2020 2021 2022 2023 2024 2025; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -I "$SF/$y/table-based-SF/data/5YRData/acsdt5y$y-b01003.dat")
  echo "vintage $y b01003: HTTP $code"
done
echo
echo "### B01003 2021 vs 2024: WA tract GEOIDs and totals"
for y in 2021 2024; do
  curl -s "$SF/$y/table-based-SF/data/5YRData/acsdt5y$y-b01003.dat" | grep -E '^(GEO_ID|1400000US53|0500000US53|0400000US53)' > b01003_$y.txt
  head -1 b01003_$y.txt
  echo "$y: tracts $(grep -c '^1400000US53' b01003_$y.txt) counties $(grep -c '^0500000US53' b01003_$y.txt)"
  grep '^0400000US53' b01003_$y.txt | head -2
done
cut -d'|' -f1 b01003_2021.txt | grep '^1400000US53' | sort > g21; cut -d'|' -f1 b01003_2024.txt | grep '^1400000US53' | sort > g24
echo "tracts in both: $(comm -12 g21 g24 | wc -l); only 2021: $(comm -23 g21 g24 | wc -l); only 2024: $(comm -13 g21 g24 | wc -l)"
echo "sample King County tracts (2021 vs 2024):"; join -t'|' <(grep '^1400000US53033' b01003_2021.txt | sort | head -5) <(grep '^1400000US53033' b01003_2024.txt | sort) | head -5
echo
echo "### B25001 housing units 2021/2024 header"
for y in 2021 2024; do curl -s "$SF/$y/table-based-SF/data/5YRData/acsdt5y$y-b25001.dat" | head -1 | cut -c1-200; done
echo
echo "### B01001 (sex by age) 2024 header and labels"
curl -s "$SF/2024/table-based-SF/data/5YRData/acsdt5y2024-b01001.dat" | head -1 | cut -c1-600
curl -s "https://api.census.gov/data/2024/acs/acs5/groups/B01001.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)['variables']
for k in sorted(d):
    if k.endswith('E') and k.startswith('B01001_'): print(k, d[k]['label'])
" | head -60
echo
echo "### CDC NAMCS 2019 national summary tables: visit rates by age"
curl -sL -o namcs2019.pdf "https://www.cdc.gov/nchs/data/ahcd/namcs_summary/2019-namcs-web-tables-508.pdf"; ls -la namcs2019.pdf; file namcs2019.pdf
command -v pdftotext >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq poppler-utils >/dev/null)
pdftotext -layout namcs2019.pdf namcs2019.txt 2>&1 | head -3
grep -n -i -E "Table 1\.|Under 15 years|15–24 years|25–44 years|45–64 years|65–74 years|75 years and over|All visits|15-24|25-44" namcs2019.txt | head -60
echo "--- Table 1 context"
awk '/Table 1\./{f=1} f{print; n++} n>45{exit}' namcs2019.txt
echo
echo "### NHSR 184 (office visits by age, 2019)"
curl -sL -o nhsr184.pdf "https://www.cdc.gov/nchs/data/nhsr/nhsr184.pdf"; pdftotext -layout nhsr184.pdf nhsr184.txt 2>/dev/null
grep -n -i -E "visits per 100|per 100 (people|persons)" nhsr184.txt | head -30
echo
echo "### OFM county projections (GMA) page and files"
curl -sL "https://ofm.wa.gov/washington-data-research/population-demographics/population-forecasts-and-projections/growth-management-act-county-projections" -o ofm_gma.html; ls -la ofm_gma.html
grep -o -E 'href="[^"]+\.(xlsx|xls|csv|pdf)"' ofm_gma.html | head -20
curl -sL "https://ofm.wa.gov/washington-data-research/population-demographics/population-estimates/small-area-estimates-program" -o ofm_saep.html; ls -la ofm_saep.html
grep -o -E 'href="[^"]+\.(xlsx|xls|csv|zip)"' ofm_saep.html | head -30
