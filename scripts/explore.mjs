// Temporary exploration probe (removed before merge). Round 4: replay the
// exact queries the browser's crime adapters send, with a browser Origin, and
// check status, CORS and the shape of the answer.
const ORIGIN = 'https://justin-tran1.github.io';
const qs = p => Object.entries(p).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

async function probe(label, url, check) {
  try {
    const res = await fetch(url, { headers: { Origin: ORIGIN, 'User-Agent': 'Mozilla/5.0 probe' } });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch (e) { body = null; }
    const acao = res.headers.get('access-control-allow-origin');
    let verdict = '';
    try { verdict = check(body, text); } catch (e) { verdict = 'check error ' + e.message; }
    console.log(`${label}: HTTP ${res.status} ACAO=${acao || 'MISSING'} | ${verdict}`);
  } catch (e) { console.log(`${label}: FETCH FAILED ${e.message}`); }
}
const feats = b => (b && (b.features || [])) || [];
const first = b => JSON.stringify(feats(b)[0] || b).slice(0, 300);

// Seattle (socrata, live schema)
await probe('seattle', `https://data.seattle.gov/resource/tazs-3rd5.json?${qs({ $select: 'offense_date,nibrs_offense_code_description,offense_category,latitude,longitude,block_address,neighborhood', $where: `offense_date >= '${since}'`, $order: 'offense_date DESC', $limit: 5000, $offset: 0 })}`,
  b => `${Array.isArray(b) ? b.length : 'not array'} rows; ${JSON.stringify((b || [])[0]).slice(0, 200)}`);
// Everett (socrata, keyword column quoted)
await probe('everett quoted', `https://data.everettwa.gov/resource/szww-y224.json?${qs({ $select: 'datetimereceived,`case`,geomcoordinate,occurredlocationby100block,neighborhood', $where: `datetimereceived >= '${since}'`, $order: 'datetimereceived DESC', $limit: 5000, $offset: 0 })}`,
  b => `${Array.isArray(b) ? b.length : JSON.stringify(b).slice(0, 200)} rows; ${JSON.stringify((Array.isArray(b) && b[0]) || '').slice(0, 250)}`);
await probe('everett unquoted', `https://data.everettwa.gov/resource/szww-y224.json?${qs({ $select: 'datetimereceived,case,geomcoordinate', $where: `datetimereceived >= '${since}'`, $limit: 2 })}`,
  b => `${Array.isArray(b) ? b.length + ' rows' : JSON.stringify(b).slice(0, 200)}`);

const arc = (label, url, fields) => {
  const outFields = [fields.date, ...fields.offense, fields.addr, fields.lat, fields.lon].filter(Boolean).join(',');
  const base = { outFields, geometryPrecision: 6, orderByFields: `${fields.date} DESC`, returnGeometry: true, outSR: 4326, resultRecordCount: 1000, resultOffset: 0 };
  return Promise.all([
    probe(label + ' geojson/TIMESTAMP', `${url}/query?${qs({ ...base, where: `${fields.date} >= TIMESTAMP '${since} 00:00:00'`, f: 'geojson' })}`,
      b => `${b && b.error ? 'ERROR ' + JSON.stringify(b.error).slice(0, 200) : feats(b).length + ' features; ' + first(b)}`),
    probe(label + ' json/DATE', `${url}/query?${qs({ ...base, where: `${fields.date} >= DATE '${since}'`, f: 'json' })}`,
      b => `${b && b.error ? 'ERROR ' + JSON.stringify(b.error).slice(0, 200) : feats(b).length + ' features; exceeded=' + (b && b.exceededTransferLimit)}`),
    probe(label + ' layer info', `${url}?f=json`, b => `type=${b && b.type} max=${b && b.maxRecordCount} ${b && b.error ? JSON.stringify(b.error) : ''}`)
  ]);
};
await arc('tacoma', 'https://services3.arcgis.com/SCwJH1pD8WSn5T5y/arcgis/rest/services/TPD_RMS_Crime/FeatureServer/0',
  { date: 'DateOccurred', offense: ['Description', 'Offense_Category'], addr: 'Address', lat: 'Latitude', lon: 'Longitude' });
await arc('bellevue', 'https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Offenses/FeatureServer/1',
  { date: 'FROM_DATE', offense: ['LEGEND', 'STAT_KEYWORD'], lat: 'LATITUDE', lon: 'LONGITUDE' });
await arc('redmond', 'https://gis.redmond.gov/arcgis/rest/services/CrimeMap/Crimes/FeatureServer/0',
  { date: 'DateTimeReported', offense: ['OffenseDescription', 'UCR_Description', 'WebSubType'], addr: 'FilteredAddress' });
await arc('kirkland', 'https://maps.kirklandwa.gov/host/rest/services/Hosted/CrimeAnalysis_(Public)/FeatureServer/2',
  { date: 'from_date', offense: ['nibrs_desc', 'cm_nibrs_desc'], addr: 'block_address' });
await arc('pierce', 'https://services2.arcgis.com/1UvBaQ5y1ubjUPmd/arcgis/rest/services/Crime_Data/FeatureServer/1',
  { date: 'OccurredOn', offense: ['Public_Nam'], addr: 'City' });
await arc('yakima', 'https://services5.arcgis.com/drBwGNA3YMS2QPJd/arcgis/rest/services/Crimes_public_fc349e427d9945729c4e985666b31686/FeatureServer/0',
  { date: 'reportdate', offense: ['nibrsdesc'], addr: 'neighborhood' });
// WSDOT routes as the transit layer asks
await probe('wsdot routes', `https://data.wsdot.wa.gov/arcgis/rest/services/Shared/TransitData/FeatureServer/3/query?${qs({ where: '1=1', outFields: '*', geometryPrecision: 5, maxAllowableOffset: 0.0003, geometry: '-122.4,47.55,-122.25,47.7', geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', returnGeometry: true, outSR: 4326, f: 'geojson', resultRecordCount: 2000, resultOffset: 0 })}`,
  b => `${feats(b).length} routes; ${JSON.stringify((feats(b)[0] || {}).properties || b).slice(0, 300)}`);
console.log('DONE');
