// Bounded public-source audit; no credentials, private reports or automatic identity joins.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditDistanceKm, classifyFacilityCandidate } from '../apps/web/js/site-audit.js';

const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2), refresh = args.includes('--refresh-water'), rebuildWater = args.includes('--rebuild-water');
const arg = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const cacheRoot = path.resolve(root, arg('--cache-root', '../NasaSpaceHacks2026GoofyGoobers/data/processed/environment'));
const output = path.join(root, 'data/cloudshadow/site-audit'), sourceCache = path.join(root, 'tmp/site-audit-source');
const read = async (file, fallback) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch(error) { if(error.code === 'ENOENT') return fallback; throw error; } };
const sites = (await read(path.join(root, 'data/cloudshadow/sites.json'))).sites;
const decisions = (await read(path.join(root, 'data/cloudshadow/site-audit-decisions.json'), { decisions: [] })).decisions;
const sha = value => createHash('sha256').update(value).digest('hex');
await fs.mkdir(output, { recursive: true }); await fs.mkdir(sourceCache, { recursive: true });
let sourceRequests = 0;
async function json(url) {
  const cache = path.join(sourceCache, `${sha(url)}.json`), known = await read(cache, null);
  if (known && !refresh) return known;
  if (++sourceRequests > 40) throw new Error('Bounded 40-request public-source acquisition budget reached.');
  const response = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/geo+json, application/json' } });
  if (!response.ok) throw new Error(`USGS HTTP ${response.status}; no fallback values generated.`);
  const text = await response.text(); if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error('USGS source document exceeds 5 MiB.');
  const data = JSON.parse(text), value = { data, retrievedAt: new Date().toISOString(), sourceUrl: url, sha256: sha(text) };
  await fs.writeFile(cache, JSON.stringify(value)); return value;
}
const endpoint = (collection, params) => `https://api.waterdata.usgs.gov/ogcapi/v1/collections/${collection}/items?${new URLSearchParams({ f: 'json', ...params })}`;
const official = {
  usgs: { title: 'USGS Water Data OGC API documentation', url: 'https://api.waterdata.usgs.gov/docs/ogcapi/', publisher: 'USGS', evidence: 'primary-documentation' },
  epa: { title: 'EPA National Emissions Inventory point source identity guidance', url: 'https://www.epa.gov/system/files/documents/2024-04/point-source-best-practices-training_508-.pdf', publisher: 'EPA', evidence: 'primary-documentation' },
  googleAffiliation: { title: 'Oregon Business Development Commission SIP21-01 Google Data Center resolution', url: 'https://www.oregon.gov/biz/Publications/Boards/Business%20Oregon%20Commission/2021/December/sip%6021-01~Resolution%20%28website%29.pdf', publisher: 'State of Oregon', evidence: 'primary-record' },
};
const files = (await fs.readdir(cacheRoot).catch(() => [])).filter(name => /^emissions-epa-nei-year-\d{4}\.json$/.test(name));
if(!files.length)throw new Error('No cached EPA year snapshots found. Supply --cache-root <processed/environment> after inventory acquisition; existing prepared audits were not overwritten.');
const inventories = await Promise.all(files.map(async name => ({ name, data: await read(path.join(cacheRoot, name)), sha256: sha(await fs.readFile(path.join(cacheRoot, name))) })));
const osm = await read(path.join(cacheRoot, 'facilities-osm.json'), { facilities: [] });
const yearList = inventories.map(({ data }) => data.reportingYear).sort((a,b) => a-b);

for (const site of sites) {
  const previous = await read(path.join(output, `${site.id}.json`), null), byFacility = new Map();
  for (const { data } of inventories) for (const record of data.records || []) {
    const f = record.facility; if (!f) continue;
    const point = { lat: f.latitude, lon: f.longitude }, distance = auditDistanceKm(site, point); if (distance === null || distance > 15) continue;
    const key = f.id;
    if (!byFacility.has(key)) byFacility.set(key, { sourceId: 'epa-nei', sourceFacilityId: f.id, name: f.name, ...point, address: f.address, city: f.city, state: f.state,
      sourceUrl: record.sourceUrl, evidence: 'reported-inventory', sourceClassification: record.classification?.status, reportingYears: [], emissions: [] });
    const item = byFacility.get(key); if (!item.reportingYears.includes(record.reportingYear)) item.reportingYears.push(record.reportingYear);
    item.emissions.push({ id: record.id, year: record.reportingYear, pollutant: record.pollutant, amount: record.quantity, unit: record.unit, quality: record.quality, measurementMethod: record.measurementMethod, sourceUrl: record.sourceUrl });
  }
  const facilityMatches = [...byFacility.values()].map(f => {
    const result = classifyFacilityCandidate(site, f, { decision: decisions.find(d => d.siteId === site.id && d.sourceId === f.sourceId && d.sourceFacilityId === f.sourceFacilityId) });
    result.reportingYears.sort((a,b) => a-b);
    if (site.id === 'thedalles' && f.sourceFacilityId === 'eis/19091511') result.verifiedRelationships = [{ type: 'operator-affiliation', status: 'confirmed', operator: 'Google / Alphabet', source: official.googleAffiliation, note: 'Primary Oregon resolution identifies Design LLC within the Google group. It does not establish that this EIS record is the selected original campus or an individual mapped building.' }];
    return result;
  }).sort((a,b) => a.distanceKm - b.distanceKm).slice(0,12);
  const mapped = osm.facilities.filter(f => {const d=auditDistanceKm(site, { lat: f.location?.latitude, lon: f.location?.longitude });return d!==null&&d<=3;}).map(f => ({ sourceId: 'osm', id: f.id, name: f.name, operator: f.operator, sourceUrl: f.sourceUrl, lat: f.location.latitude, lon: f.location.longitude, address: f.address, distanceKm: auditDistanceKm(site, { lat: f.location.latitude, lon: f.location.longitude }), status: 'mapped-contributed', campusIdentity: 'not-deduplicated' })).sort((a,b) => a.distanceKm-b.distanceKm).slice(0,20);
  let stations = previous?.stations || [], waterSource = previous?.waterDiscovery || { status: 'not-acquired' };
  if (refresh || rebuildWater || !previous) {
    try {
      const dx = .25 / Math.max(.2, Math.cos(site.lat * Math.PI/180)), bbox = [site.lon-dx, site.lat-.25, site.lon+dx, site.lat+.25].join(',');
      const discovery = await json(endpoint('monitoring-locations', { bbox, agency_code: 'USGS', site_type_code: 'ST', limit: '500' }));
      stations = (discovery.data.features || []).map(f => ({ id: f.properties?.monitoring_location_id || f.id, name: f.properties?.monitoring_location_name, siteType: f.properties?.site_type || f.properties?.site_type_code,
        lat: f.geometry?.coordinates?.[1], lon: f.geometry?.coordinates?.[0], sourceUrl: `https://waterdata.usgs.gov/monitoring-location/${f.id}/`, coverage: { status: 'metadata-not-queried', parameters: [] }, series: [] }))
        .filter(s => /^USGS-\d{8,15}$/.test(s.id || '') && Number.isFinite(s.lat) && Number.isFinite(s.lon)).map(s => ({ ...s, distanceKm: auditDistanceKm(site,s) }))
        .sort((a,b) => a.distanceKm-b.distanceKm);
      const priority = site.id.startsWith('colossus') ? stations.find(s => s.id === 'USGS-07032000') : null;
      stations = [...(priority ? [priority] : []), ...stations.filter(s => s !== priority)].slice(0,12);
      waterSource = { status: 'downloaded', sourceUrl: discovery.sourceUrl, retrievedAt: discovery.retrievedAt, sha256: discovery.sha256, returned: discovery.data.features?.length || 0, limit: 500, truncated: !!discovery.data.links?.some(l => l.rel === 'next') };
      // Three nearest stream/gauge locations per site; wells remain in discovery
      // but are not silently mixed with river records.
      const chosen = stations.filter(s => /stream|^ST$|lake|^LK$|^ST-/i.test(s.siteType || '')).slice(0,3);
      for (const station of chosen) {
        try {
          const meta = await json(endpoint('time-series-metadata', { monitoring_location_id: station.id, limit: '500' }));
          const rows = (meta.data.features || []).map(f => ({ id: f.id, parameterCode: f.properties?.parameter_code, parameterName: f.properties?.parameter_name,
            unit: f.properties?.unit_of_measure, begin: f.properties?.begin_utc || f.properties?.begin, end: f.properties?.end_utc || f.properties?.end,
            statisticId: f.properties?.statistic_id, computationPeriod: f.properties?.computation_period_identifier }));
          station.coverage = { status: 'source-metadata', parameters: rows, sourceUrl: meta.sourceUrl, retrievedAt: meta.retrievedAt, sha256: meta.sha256,
            note: 'Earliest/latest timestamps are not continuous coverage; source gaps may exist. Metadata does not prove observations in a selected period.' };
          const discharge = rows.find(r => r.parameterCode === '00060' && r.computationPeriod === 'Daily' && r.statisticId === '00003');
          if (!discharge || stations.some(s => s.series?.length)) continue;
          const url = endpoint('daily', { monitoring_location_id: station.id, parameter_code: '00060', statistic_id: '00003', datetime: '2025-01-01/2025-12-31', limit: '400', sortby: 'time' });
          const daily = await json(url), seen = new Set(), points = [];
          for (const f of daily.data.features || []) {
            const p = f.properties || {}, date = String(p.time || '').slice(0,10), rawValue = p.value;
            if (p.monitoring_location_id !== station.id || p.parameter_code !== '00060' || p.statistic_id !== '00003' || p.time_series_id!==discharge.id || !/^2025-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
            seen.add(date); const numeric = typeof rawValue === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(rawValue.trim()) ? Number(rawValue) : null;
            points.push({ date, sourceTime:p.time, value: Number.isFinite(numeric) ? numeric : null, rawValue, approvalStatus: p.approval_status, qualifier: p.qualifier, timeSeriesId: p.time_series_id });
          }
          if (points.length) station.series.push({ id: '00060', label: 'Daily mean discharge', unit: discharge.unit || null, statisticId: '00003', timeStandard:'source daily dates; original timestamp retained', period: { start: '2025-01-01', end: '2025-12-31' }, points: points.sort((a,b) => a.date.localeCompare(b.date)), evidence: 'ground-observation', sourceUrl: daily.sourceUrl, retrievedAt: daily.retrievedAt, sha256: daily.sha256, complete: !daily.data.links?.some(l => l.rel === 'next'), note: 'Discharge measured at this source station; no downstream/campus connection or facility effect has been established.' });
        } catch(error) { station.coverage = { ...station.coverage, error: error.message }; }
      }
    } catch(error) { waterSource = { ...waterSource, status: previous?.stations?.length ? 'previous-download-retained' : 'unavailable', error: error.message }; }
  }
  const onsetYear = Number(site.onset?.slice(0,4)), latest = yearList.at(-1), gaps = [
    { id: 'facility-identity', status: facilityMatches.some(m => m.status === 'confirmed') ? 'reviewed-association-available' : 'needs-verification', label: 'Exact campus → regulatory identity', detail: 'Nearby inventory records remain candidates until documentary review links both identities. Operator affiliation alone is not campus identity.' },
    { id: 'inventory-time', status: latest < onsetYear ? 'predates-study-start' : 'historical-only', label: 'Emissions inventory timing', detail: `Cached reporting years: ${yearList.join(', ') || 'none'}. Study comparison starts ${site.onset}. Missing or pre-opening reports do not mean zero emissions.` },
    { id: 'water-observations', status: stations.some(s => s.series?.length) ? 'dated-station-observations' : 'no-dated-observations-acquired', label: 'Water station observations', detail: 'Station metadata, sampled parameters and actual downloaded dates are separate. Measurements at a nearby station do not establish downstream connection.' },
    { id: 'water-balance', status: 'missing-inputs-and-model', label: 'Facility withdrawals and receiving-water effects', detail: 'Complete sourced withdrawal/consumption/return/discharge records and watershed/aquifer connectivity remain necessary for a facility-impact model.' },
  ];
  const result = { schemaVersion: 'site-audit/1.0', site: { id: site.id, name: site.name, lat: site.lat, lon: site.lon, scope: site.id === 'ashburn' ? 'regional-cluster' : 'study-campus' }, generatedAt: new Date().toISOString(),
    inventoryCoverage: { reportingYears: yearList, source: 'Cached EPA NEI NAICS518210 sector candidates', latestReportingYear: latest || null, notFacilityCensus: true, snapshots: inventories.map(({data,sha256}) => ({ reportingYear: data.reportingYear, retrievedAt: data.retrievedAt, sourceUrl: data.sourceUrl, sha256 })) },
    mappedFacilities: mapped, facilityMatches, waterDiscovery: waterSource, stations, gaps, sources: [official.usgs,official.epa,...(site.id === 'thedalles' ? [official.googleAffiliation] : [])],
    note: 'No automatic facility attribution. Inventory emissions, ambient concentrations, water use, river flow and regional climate remain distinct quantities.' };
  await fs.writeFile(path.join(output, `${site.id}.json`), JSON.stringify(result, null, 2)+'\n');
  console.log(`${site.id}: ${mapped.length} mapped elements, ${facilityMatches.length} regulatory candidates, ${stations.length} water locations, ${stations.filter(s => s.series?.length).length} dated discharge series`);
}
