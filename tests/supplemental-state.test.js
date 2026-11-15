import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {attachFutureData} from '../apps/web/js/future-data.js';
const read=path=>JSON.parse(readFileSync(new URL('../data/cloudshadow/'+path,import.meta.url)));
test('one source state loads regional histories, audits and NASA annual simulations without replacing existing climate models',async()=>{
 const power=read('power-projections/thedalles.json'),site=power.site,bus=new EventTarget(),climate=read('projections/thedalles.json');
 const products={'power-projections':power,'site-audit':read('site-audit/thedalles.json'),'regional-evidence':read('regional-evidence/thedalles.json'),'unreal/timeline':read('unreal/timeline/thedalles.json')};
 const control=attachFutureData({site,year:2050,eventTarget:bus,loadSupplemental:true,fetchImpl:async url=>({ok:true,json:async()=>Object.entries(products).find(([key])=>url.includes('/'+key+'/'))?.[1]})});
 await control.setSite(site);control.ingest({siteId:site.id,kind:'climate-projection',result:climate});
 assert.equal(control.state.audit.site.id,site.id);assert.equal(control.state.regional.variables.filter(v=>v.status==='available').length,4);assert.equal(control.state.power.available,true);assert.equal(control.state.climate.available,true);
 control.setOptions({scenario:'ssp585',powerScenario:'ssp370',climateView:'annual'});assert.equal(control.state.climate.scenario,'ssp585');assert.equal(control.state.power.scenario,'ssp370');assert.equal(control.state.products['climate-projection'],climate);
 control.setYear(2100);assert.equal(control.state.power.year,2100);assert.equal(control.state.power.available,true);control.destroy();
});
test('screening values keep true zero, supplied scenario years and independently scoped map controls',async()=>{
 const site={id:'thedalles',lat:45.6241,lon:-121.2071},control=attachFutureData({site,year:2030,eventTarget:new EventTarget(),fetchImpl:async()=>({ok:false})});
 const result={site,years:[{year:2030,metrics:[{domain:'heat',value:0,unit:'°C'}]}],requiredInputs:[{year:2030,domain:'air',fields:['emissionRateGs']}]};
 assert.equal(control.ingest({siteId:site.id,kind:'environment-screening',result}),true);assert.equal(control.state.screening.available,true);assert.equal(control.state.screening.metrics[0].value,0);
 control.setOptions({showScreening:true,screeningDomain:'heat'});control.setYear(2040);assert.equal(control.state.screening.available,false);assert.equal(control.state.showScreening,true);assert.deepEqual(control.state.screening.metrics,[]);control.destroy();
});
