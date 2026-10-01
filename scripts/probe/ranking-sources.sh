#!/usr/bin/env bash
# Temporary probe, round 2: NAMCS visit rates by age, OFM tract estimates and county projections.
set -u
command -v pdftotext >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq poppler-utils >/dev/null 2>&1)
echo "### NAMCS 2019: tables with patient age"
curl -sL -o namcs2019.pdf "https://www.cdc.gov/nchs/data/ahcd/namcs_summary/2019-namcs-web-tables-508.pdf"
pdftotext -layout namcs2019.pdf namcs2019.txt
grep -n -E "^Table [0-9]+\." namcs2019.txt | head -40
echo "--- age rows with rates"
grep -n -E "(Under 15 years|15[–-]24 years|25[–-]44 years|45[–-]64 years|65[–-]74 years|75 years and over|65 years and over|Under 18|18[–-]44|18[–-]64)" namcs2019.txt | head -40
echo "--- table containing patient age (first match +40 lines)"
awk '/Table [0-9]+\..*(age|Age)/{f=1} f{print; n++} n>60{exit}' namcs2019.txt
echo
echo "### NHSR 184: age rates"
curl -sL -o nhsr184.pdf "https://www.cdc.gov/nchs/data/nhsr/nhsr184.pdf"; pdftotext -layout nhsr184.pdf nhsr184.txt
sed -n '100,140p' nhsr184.txt
grep -n -E "Under 1|1[–-]17|18[–-]44|45[–-]64|65 and over|75 and over" nhsr184.txt | head -30
echo
echo "### OFM SAEP tract estimates: workbook structure"
U=https://ofm.wa.gov/wp-content/uploads/sites/default/files/public/dataresearch/pop/smallarea/data/xlsx
curl -sL -o saep_tract20.xlsx "$U/saep_tract20.xlsx"; ls -la saep_tract20.xlsx; file saep_tract20.xlsx
mkdir -p x && cd x && unzip -o -q ../saep_tract20.xlsx && ls -R | head -30
python3 - <<'PY'
import re, xml.etree.ElementTree as ET
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
wb=ET.parse('xl/workbook.xml').getroot()
print('sheets:', [s.get('name') for s in wb.find('m:sheets',ns)])
ss=[ ''.join(t.text or '' for t in si.iter('{%s}t'%ns['m'])) for si in ET.parse('xl/sharedStrings.xml').getroot()] 
import glob
for sh in sorted(glob.glob('xl/worksheets/sheet*.xml'))[:3]:
    root=ET.parse(sh).getroot()
    rows=root.find('m:sheetData',ns)
    print('==', sh, 'rows', len(rows))
    for r in list(rows)[:8]:
        vals=[]
        for c in r:
            v=c.find('m:v',ns); t=c.get('t')
            x=v.text if v is not None else ''
            if t=='s' and x: x=ss[int(x)]
            vals.append(x)
        print(r.get('r'), vals[:24])
    # find a King County tract row
    for r in list(rows)[8:4000]:
        vals=[]
        for c in r:
            v=c.find('m:v',ns); t=c.get('t'); x=v.text if v is not None else ''
            if t=='s' and x: x=ss[int(x)]
            vals.append(x)
        if any(str(x).startswith('53033000101') for x in vals): print('sample', vals[:24]); break
PY
cd ..
echo
echo "### OFM GMA county projections"
curl -sL "https://ofm.wa.gov/washington-data-research/population-demographics/population-forecasts-and-projections/growth-management-act-county-projections" -o ofm_gma.html
grep -o -E 'href="[^"]+"' ofm_gma.html | grep -i -E "project|gma|xlsx|forecast" | sort -u | head -40
curl -sL "https://ofm.wa.gov/washington-data-research/population-demographics/population-forecasts-and-projections" -o ofm_proj.html
grep -o -E 'href="[^"]+"' ofm_proj.html | grep -i -E "project|county|xlsx" | sort -u | head -40
