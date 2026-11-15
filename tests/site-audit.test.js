import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {auditDistanceKm,classifyFacilityCandidate,createSiteAuditLoader,summarizeSiteAudit,siteAuditWaterReadings} from '../apps/web/js/site-audit.js';

const site={id:'study',lat:39,lon:-77},facility={sourceId:'epa-nei',sourceFacilityId:'eis/123',lat:39.001,lon:-77.001,name:'Example data center'};
test('nearby names and locations are candidates until documentary identity review, never causal attribution',()=>{
  const candidate=classifyFacilityCandidate(site,facility);assert.equal(candidate.status,'candidate');assert.equal(candidate.identityVerified,false);assert.equal(candidate.attributionEligible,false);
  const decision={siteId:site.id,sourceId:facility.sourceId,sourceFacilityId:facility.sourceFacilityId,status:'confirmed',reviewedBy:'Test reviewer',reviewedAt:'2026-11-15',statement:'Synthetic test: both source identities explicitly linked in this test document.',sources:[{url:'https://example.gov/identity',evidence:'primary-record'}]};
  const confirmed=classifyFacilityCandidate(site,facility,{decision});assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.identityVerified,true);assert.equal(confirmed.attributionEligible,false);
  assert.equal(classifyFacilityCandidate(site,facility,{decision:{...decision,sources:[]}}).status,'candidate');
  assert.equal(classifyFacilityCandidate(site,facility,{decision:{...decision,reviewedAt:'2026-02-30'}}).status,'candidate');
  assert.equal(classifyFacilityCandidate(site,facility,{decision:{...decision,sourceFacilityId:'eis/other'}}).status,'candidate');
  assert.equal(classifyFacilityCandidate(site,{...facility,lat:20}).status,'rejected');
  assert.equal(auditDistanceKm(site,{lat:999,lon:0}),null);
});

test('all five audits preserve real source IDs, reporting years and dated USGS observations with source hashes',()=>{
  for(const id of ['colossus1','colossus2','ashburn','abilene','thedalles']){
    const audit=JSON.parse(readFileSync(new URL(`../data/cloudshadow/site-audit/${id}.json`,import.meta.url)));
    assert.equal(audit.schemaVersion,'site-audit/1.0');assert.equal(audit.site.id,id);
    assert.deepEqual(audit.inventoryCoverage.reportingYears,[2008,2011,2014,2017,2020,2023]);
    assert.ok(audit.stations.length>0&&audit.stations.length<=12);assert.ok(audit.facilityMatches.length<=12);
    for(const match of audit.facilityMatches){assert.equal(match.status,'candidate');assert.equal(match.attributionEligible,false);assert.ok(match.sourceFacilityId.startsWith('eis/'));for(const row of match.emissions){assert.equal(typeof row.unit,'string');assert.ok(Number.isInteger(row.year));assert.ok(row.sourceUrl.startsWith('https://data.epa.gov/'));}}
    const readings=siteAuditWaterReadings(audit,2025).filter(r=>r.available);assert.equal(readings.length,1,id);assert.equal(readings[0].validDays,365);assert.equal(readings[0].unit,'ft^3/s');assert.ok(readings[0].meanM3s>=0);
    assert.deepEqual(siteAuditWaterReadings(audit,2035),[]);assert.equal(summarizeSiteAudit(audit).observedStations,1);
    const series=audit.stations.find(s=>s.series.length).series[0];assert.match(series.sha256,/^[a-f0-9]{64}$/);assert.equal(new Set(series.points.map(p=>p.date)).size,365);assert.ok(series.sourceUrl.includes('parameter_code=00060'));
    assert.ok(series.points.every(p=>p.rawValue!==undefined&&p.approvalStatus));
  }
});

test('gauge summary preserves true zeros, does not average partial seasons as annual flow, and keeps source units',()=>{
  const points=Array.from({length:365},(_,i)=>({date:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),value:0}));
  const audit={stations:[{id:'USGS-00000000',name:'Synthetic fixture',series:[{id:'00060',statisticId:'00003',unit:'ft^3/s',points}]}]};
  assert.equal(siteAuditWaterReadings(audit,2025)[0].mean,0);assert.equal(siteAuditWaterReadings(audit,2025)[0].meanM3s,0);
  points.splice(0,40);const incomplete=siteAuditWaterReadings(audit,2025)[0];assert.equal(incomplete.available,false);assert.equal(incomplete.mean,null);
});

test('audit loader is bounded, validates exact site identity, caches successful reads and retries failures',async()=>{
  let calls=0;const d={schemaVersion:'site-audit/1.0',site:{id:'study'},facilityMatches:[],stations:[]};
  const loader=createSiteAuditLoader({fetchImpl:async()=>{calls++;return Response.json(d);}});await loader('study');await loader('study');assert.equal(calls,1);await assert.rejects(loader('../secret'),/Invalid/);
  const wrong=createSiteAuditLoader({fetchImpl:async()=>Response.json({...d,site:{id:'other'}})});await assert.rejects(wrong('study'),/Invalid site-audit/);
  let tries=0;const retry=createSiteAuditLoader({fetchImpl:async()=>{tries++;return new Response('{}',{status:404});}});await assert.rejects(retry('study'));await assert.rejects(retry('study'));assert.equal(tries,2);
});
