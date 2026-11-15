import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizePowerProjection,powerProjectionYear,powerProjectionUrl} from '../apps/web/js/power-projection.js';
import {annualClimateHtml,annualClimateChart} from '../apps/web/js/future-climate-view.js';
const site={id:'test',name:'Test',lat:45,lon:-121};
function fixture(){const temperature={},precipitation={};for(let month=1;month<=12;month++){const key='2024'+String(month).padStart(2,'0');temperature[key]=month===2?20:10;precipitation[key]=1;}return {geometry:{type:'Point',coordinates:[site.lon,site.lat]},header:{temporal:'monthly',time_standard:'utc',fill_value:-999,model:'ensemble',api:{version:'source-version'}},parameters:{T2M:{units:'C'},PRECTOTCORR:{units:'mm/day'}},properties:{parameter:{T2M:{ssp245:temperature},PRECTOTCORR:{ssp245:precipitation}}}};}
test('NASA monthly simulations use complete calendar years and actual leap-month weights',()=>{
 const result=normalizePowerProjection(fixture(),{site}),row=powerProjectionYear(result,{year:2024});
 assert.equal(row.precipitationMm,366);assert.equal(row.temperatureC,(10*337+20*29)/366);assert.equal(row.temperatureMonths,12);assert.equal(row.evidence,'climate-scenario');assert.equal(powerProjectionYear(result,{year:2023}).available,false);
 const raw=fixture();raw.properties.parameter.T2M.ssp245['202402']=-999;raw.properties.parameter.PRECTOTCORR.ssp245['202401']=0;
 const incomplete=powerProjectionYear(normalizePowerProjection(raw,{site}),{year:2024});assert.equal(incomplete.temperatureC,null);assert.equal(incomplete.precipitationMm,335);assert.equal(incomplete.temperatureMonths,11);
});
test('source units, missing pathways and documentation are preserved without mapping SSP5-8.5 to another pathway',()=>{
 const raw=fixture();raw.parameters.PRECTOTCORR.units='mm/month';assert.throws(()=>normalizePowerProjection(raw,{site}),/units/);
 const wrongModel=fixture();wrongModel.header.model='individual-model';assert.throws(()=>normalizePowerProjection(wrongModel,{site}),/ensemble/);
 const wrongPlace=fixture();wrongPlace.geometry.coordinates=[0,0];assert.throws(()=>normalizePowerProjection(wrongPlace,{site}),/location/);
 const valid=normalizePowerProjection(fixture(),{site});assert.equal(powerProjectionYear(valid,{year:2024,scenario:'ssp585'}).available,false);assert.match(valid.source.url,/power.larc.nasa.gov/);assert.throws(()=>powerProjectionUrl({...site,lat:-85}),/coverage/);
});
test('all five acquired NASA products retain three annual pathways through 2100 and separate model identities',()=>{
 for(const id of ['colossus1','colossus2','ashburn','abilene','thedalles']){
  const data=JSON.parse(readFileSync(new URL(`../data/cloudshadow/power-projections/${id}.json`,import.meta.url)));
  assert.equal(data.site.id,id);assert.deepEqual(Object.keys(data.scenarios),['ssp126','ssp245','ssp370']);
  for(const scenario of Object.keys(data.scenarios)){assert.equal(data.scenarios[scenario].annual.length,86);const annual=powerProjectionYear(data,{year:2090,scenario});assert.equal(annual.available,true);assert.equal(annual.temperatureMonths,12);assert.equal(annual.precipitationMonths,12);}
 }
});
test('annual climate graphics keep unknown years as gaps and expose exact numbers and distinct mode controls',()=>{
 const product=normalizePowerProjection(fixture(),{site});product.scenarios.ssp245.annual.find(row=>row.year===2024).temperatureC=0;
 const html=annualClimateHtml({year:2024,products:{'power-projection':product},powerScenario:'ssp245',climateView:'annual'},'heat');assert.match(html,/>0<small>/);assert.match(html,/Yearly simulation/);assert.match(html,/Climate periods/);assert.match(html,/Annual values/);assert.match(annualClimateChart(product,{year:2024}),/one conditional model pathway/);
});
