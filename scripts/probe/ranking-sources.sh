#!/usr/bin/env bash
# Temporary probe, round 4: OFM 2022 GMA county projections workbook layout.
set -u
U=https://ofm.wa.gov/wp-content/uploads/sites/default/files/public/dataresearch/pop/GMA/projections2022
curl -sL -o gma5.xlsx "$U/gma_2022_5yr.xlsx"; ls -la gma5.xlsx; file gma5.xlsx
mkdir -p g && cd g && unzip -o -q ../gma5.xlsx && ls xl/worksheets
python3 - <<'PY'
import xml.etree.ElementTree as ET, glob
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
try: ss=[''.join(t.text or '' for t in si.iter('{%s}t'%ns['m'])) for si in ET.parse('xl/sharedStrings.xml').getroot()]
except Exception as e: ss=[]; print('no sharedStrings', e)
wb=ET.parse('xl/workbook.xml').getroot()
print('sheets', [s.get('name') for s in wb.find('m:sheets',ns)])
for sh in sorted(glob.glob('xl/worksheets/sheet*.xml')):
    root=ET.parse(sh).getroot(); rows=list(root.find('m:sheetData',ns))
    print('==', sh, len(rows))
    def rv(r):
        out=[]
        for c in r:
            v=c.find('m:v',ns); t=c.get('t'); x=v.text if v is not None else ''
            if t=='s' and x: x=ss[int(x)]
            if t=='inlineStr':
                x=''.join(tt.text or '' for tt in c.iter('{%s}t'%ns['m']))
            out.append((c.get('r'),x))
        return out
    for r in rows[:14]: print(r.get('r'), rv(r)[:14])
    for r in rows:
        vals=rv(r)
        if any(str(x).strip() in ('King','King County') for _,x in vals): print('KING', vals[:14])
PY
