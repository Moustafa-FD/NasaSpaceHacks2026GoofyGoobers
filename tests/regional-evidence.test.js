import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateRegionalEvidence,createRegionalEvidenceLoader,summarizeRegionalEvidence,regionalVariables} from '../apps/web/js/regional-evidence.js';

const fixture=()=>({schemaVersion:'regional-evidence/1.0',site:{id:'test',name:'Test',lat:39,lon:-77},inventory:[],variables:[{id:'power-precipitation',label:'Rain',group:'water',status:'available',unit:'mm/day',annualUnit:'mm/year',source:{name:'NASA POWER'},resolution:'Regional grid',monthly:[{date:'2024-01',value:0},{date:'2025-01',value:null}],annual:[{year:2024,value:0,validMonths:12,complete:true},{year:2025,value:null,validMonths:1,complete:false}],trend:{status:'insufficient_data'}}]});

test('regional histories preserve real zero, source-specific units and incomplete/future years',()=>{
  const product=validateRegionalEvidence(fixture(),'test');
  const zero=summarizeRegionalEvidence(product,{year:2024});assert.equal(zero.available,true);assert.equal(zero.value,0);assert.equal(zero.unit,'mm/year');assert.equal(zero.monthlyUnit,'mm/day');assert.equal(zero.monthly[0].value,0);
  const missing=summarizeRegionalEvidence(product,{year:2025});assert.equal(missing.value,null);assert.equal(missing.validMonths,1);assert.match(missing.reason,/1\/12/);
  const future=summarizeRegionalEvidence(product,{year:2090});assert.equal(future.status,'beyond-record');assert.equal(future.value,null);assert.match(future.reason,/ends in 2025/);
});

test('missing Giovanni exports stay distinct from unavailable NASA global coverage',()=>{
  const product=fixture();product.variables.push({id:'giovanni-groundwater',label:'Groundwater condition',group:'water',status:'not-imported',unit:'source units',annualUnit:'source units',monthly:[],annual:[],reason:'CSV is not present locally.'});
  const missing=summarizeRegionalEvidence(product,{year:2024,variable:'giovanni-groundwater'});assert.equal(missing.status,'not-imported');assert.equal(missing.value,null);assert.match(missing.reason,/not present locally/);assert.equal(regionalVariables(product,'air').length,0);assert.equal(regionalVariables(product,'water').length,2);
});

test('regional loader bounds caching, rejects traversal and bad source sequences, and retries failed loads',async()=>{
  let calls=0;const loader=createRegionalEvidenceLoader({fetchImpl:async(url)=>{calls++;return {ok:true,json:async()=>({...fixture(),site:{id:url.split('/').at(-1).replace('.json',''),lat:39,lon:-77}})};},cacheLimit:2});
  const first=await loader.load('test');assert.equal(await loader.load('test'),first);assert.equal(calls,1);await loader.load('second');await loader.load('third');assert.equal(loader.size,2);await loader.load('test');assert.equal(calls,4);
  await assert.rejects(loader.load('../private'),/Invalid/);
  const invalid=fixture();invalid.variables[0].monthly.push({date:'2024-01',value:1});assert.throws(()=>validateRegionalEvidence(invalid,'test'),/sequence/);assert.throws(()=>validateRegionalEvidence(fixture(),'other'),/Invalid/);
  let n=0;const retry=createRegionalEvidenceLoader({fetchImpl:async()=>{n++;return n===1?{ok:false,status:503}:{ok:true,json:async()=>fixture()};}});await assert.rejects(retry.load('test'),/503/);await retry.load('test');assert.equal(n,2);
});

test('all five prepared regional inventories expose real POWER histories and honest Giovanni import status',()=>{
  for(const siteId of ['ashburn','colossus1','colossus2','abilene','thedalles']){
    const data=validateRegionalEvidence(JSON.parse(readFileSync(new URL(`../data/cloudshadow/regional-evidence/${siteId}.json`,import.meta.url),'utf8')),siteId);
    for(const id of ['power-precipitation','power-temperature','power-humidity','power-wind']){const variable=data.variables.find(v=>v.id===id);assert.equal(variable.status,'available');assert.ok(variable.annual.some(p=>Number.isFinite(p.value)));assert.match(variable.source.documentationUrl,/power\.larc\.nasa\.gov/);assert.match(variable.provenance.sha256,/^[a-f0-9]{64}$/);}
    assert.equal(data.inventory.find(v=>v.id==='climate').status,'available');
    for(const variable of data.variables.filter(v=>v.id.startsWith('giovanni-'))){if(variable.status==='not-imported'){assert.equal(variable.annual.length,0);assert.match(variable.reason,/checkout|import/);}}
  }
});
