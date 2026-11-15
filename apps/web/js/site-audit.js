// Source identities stay separate until a reviewer supplies documentary evidence.
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function auditDistanceKm(a, b) {
  if (![a?.lat, a?.lon, b?.lat, b?.lon].every(finite) || Math.abs(a.lat)>90 || Math.abs(b.lat)>90 || Math.abs(a.lon)>180 || Math.abs(b.lon)>180) return null;
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
}
const safeUrl = value => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } };
export function classifyFacilityCandidate(site, facility, { decision, radiusKm = 15 } = {}) {
  const distanceKm = auditDistanceKm(site, facility), basis = [];
  if (distanceKm !== null) basis.push(`Straight-line distance ${distanceKm.toFixed(2)} km; proximity alone is not identity evidence.`);
  if (facility.name) basis.push(`Source name: ${facility.name}`);
  const matchingDecision = decision?.siteId === site?.id && decision?.sourceFacilityId === facility?.sourceFacilityId && decision?.sourceId === facility?.sourceId;
  const documented = matchingDecision && ['confirmed', 'rejected'].includes(decision.status) && typeof decision.reviewedBy === 'string' && decision.reviewedBy.trim()
    && /^\d{4}-\d{2}-\d{2}$/.test(decision.reviewedAt || '') && Number.isFinite(Date.parse(decision.reviewedAt)) && new Date(decision.reviewedAt).toISOString().slice(0,10)===decision.reviewedAt && typeof decision.statement === 'string' && decision.statement.trim()
    && Array.isArray(decision.sources) && decision.sources.some(s => s.evidence === 'primary-record' && safeUrl(s.url));
  const status = documented ? decision.status : distanceKm !== null && distanceKm <= radiusKm ? 'candidate' : 'rejected';
  if (documented) basis.push(decision.statement);
  else if (matchingDecision) basis.push('Incomplete review evidence; this proposed identity was not promoted to confirmed.');
  if (status === 'rejected' && !documented) basis.push(distanceKm === null ? 'No valid coordinates to locate this candidate.' : `Outside the explicit ${radiusKm} km candidate search radius.`);
  return { ...facility, status, distanceKm, basis, identityVerified: status === 'confirmed', eligibleForFacilityInput: status === 'confirmed', attributionEligible: false, review: documented ? decision : null };
}
export function summarizeSiteAudit(result) {
  const matches = result?.facilityMatches || [], stations = result?.stations || [];
  return { confirmed: matches.filter(m => m.status === 'confirmed').length, candidates: matches.filter(m => m.status === 'candidate').length,
    stations: stations.length, observedStations: stations.filter(s => s.series?.some(v => v.points?.some(p => finite(p.value)))).length,
    gaps: result?.gaps || [], inventoryYears: result?.inventoryCoverage?.reportingYears || [], note: 'A nearby facility or water station does not establish a facility impact or downstream connection.' };
}
/** A dated gauge annual mean is not a river-level or facility-water prediction. */
export function siteAuditWaterReadings(result, year) {
  if(!Number.isInteger(year)||year<1800||year>new Date().getUTCFullYear())return [];
  const expectedDays=(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000;
  return (result?.stations||[]).flatMap(station=>(station.series||[]).map(series=>{
    const rows=(series.points||[]).filter(p=>String(p.date).slice(0,4)===String(year)),valid=rows.filter(p=>finite(p.value));
    const dates=new Set(rows.map(p=>p.date)),available=series.id==='00060'&&series.statisticId==='00003'&&dates.size===rows.length&&valid.length>=Math.ceil(expectedDays*.9);
    const mean=available?valid.reduce((sum,p)=>sum+p.value,0)/valid.length:null;
    const factor=['ft^3/s','ft3/s','cfs'].includes(series.unit)?0.028316846592:['m^3/s','m³/s'].includes(series.unit)?1:null;
    return {stationId:station.id,name:station.name,lat:station.lat,lon:station.lon,year,available,mean,unit:series.unit,meanM3s:mean!==null&&factor!==null?mean*factor:null,
      min:available?Math.min(...valid.map(p=>p.value)):null,max:available?Math.max(...valid.map(p=>p.value)):null,validDays:valid.length,expectedDays,period:series.period,sourceUrl:series.sourceUrl,
      evidence:series.evidence,note:'Mean of recorded daily means at this gauge; at least 90% of calendar days required. Not a site withdrawal allowance, downstream connection or facility-attributable change.'};
  }).filter(reading=>reading.validDays>0));
}
export function createSiteAuditLoader({ fetchImpl = globalThis.fetch, dataBase = 'data' } = {}) {
  const cache = new Map();
  return async function load(siteId, { signal } = {}) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(siteId || '')) throw new Error('Invalid study site ID.');
    // Shared cached promises are not tied to a caller's abort signal.
    if (!cache.has(siteId)) cache.set(siteId, (async () => {
      const response = await fetchImpl(`${dataBase}/site-audit/${siteId}.json`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('No prepared source audit is available for this location.');
      const result = await response.json();
      if (result.schemaVersion !== 'site-audit/1.0' || result.site?.id !== siteId || !Array.isArray(result.facilityMatches) || !Array.isArray(result.stations)) throw new Error('Invalid site-audit product.');
      return result;
    })().catch(error => { cache.delete(siteId); throw error; }));
    const value = await cache.get(siteId); signal?.throwIfAborted(); return value;
  };
}
const defaultLoader = createSiteAuditLoader();
export function loadSiteAudit(siteId, options) { return defaultLoader(siteId, options); }
