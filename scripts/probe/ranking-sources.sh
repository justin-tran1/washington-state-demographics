#!/usr/bin/env bash
# Temporary probe, round 3: OFM SAEP header rows; OFM 2022 GMA county projection files.
set -u
U=https://ofm.wa.gov/wp-content/uploads/sites/default/files/public/dataresearch/pop/smallarea/data/xlsx
curl -sL -o saep_tract20.xlsx "$U/saep_tract20.xlsx"; mkdir -p x && cd x && unzip -o -q ../saep_tract20.xlsx
python3 - <<'PY'
import xml.etree.ElementTree as ET, glob
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
ss=[''.join(t.text or '' for t in si.iter('{%s}t'%ns['m'])) for si in ET.parse('xl/sharedStrings.xml').getroot()]
rels=ET.parse('xl/_rels/workbook.xml.rels').getroot()
wb=ET.parse('xl/workbook.xml').getroot()
for s in wb.find('m:sheets',ns):
    print('sheet', s.get('name'), s.attrib)
for sh in ['xl/worksheets/sheet1.xml','xl/worksheets/sheet4.xml']:
    root=ET.parse(sh).getroot(); rows=list(root.find('m:sheetData',ns))
    print('==', sh, len(rows))
    for r in rows[8:14]+rows[-3:]:
        vals=[]
        for c in r:
            v=c.find('m:v',ns); t=c.get('t'); x=v.text if v is not None else ''
            if t=='s' and x: x=ss[int(x)]
            vals.append((c.get('r'), x))
        print(r.get('r'), vals)
PY
cd ..
echo "### OFM GMA 2022 projections page"
curl -sL "https://ofm.wa.gov/data-research/population-demographics/forecasts-projections/growth-managment-act/2022-projections/" -o p22.html; ls -la p22.html
grep -o -E 'href="[^"]+\.(xlsx|xls|csv|pdf)"' p22.html | sort -u | head -20
