import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {attachFutureScene,futureScenePresentation,futureClimateBounds} from '../apps/web/js/future-scene.js';

const climate=JSON.parse(await readFile(new URL('../data/cloudshadow/projections/thedalles.json',import.meta.url)));
const site=climate.site;
const state=(options={})=>({siteId:site.id,site,year:2050,scenario:'ssp245',metric:'meanTempC',group:'heat',products:{'climate-projection':climate},...options});

test('future scene uses actual source-grid bounds and explicit period values instead of an annual facility map',()=>{
  const plan=futureScenePresentation(state());
  assert.equal(plan.kind,'climate');assert.equal(plan.period.label,'2041–2060');
  assert.equal(plan.value,climate.metrics.meanTempC.ssp245_2041_2060.value.median);
  assert.deepEqual(plan.bounds,[-121.25,45.5,-121,45.75]);
  assert.match(plan.label,/Regional air temperature/);assert.match(plan.label,/SSP2-4.5/);
  assert.match(plan.note,/not the facility/);assert.doesNotMatch(plan.label,/2050 forecast/);
  const gap=futureScenePresentation(state({year:2070}));assert.equal(gap.period.label,'2041–2060');
  const later=futureScenePresentation(state({year:2090,scenario:'ssp585'}));
  assert.equal(later.value,climate.metrics.meanTempC.ssp585_2081_2100.value.median);assert.match(later.label,/2081–2100/);
  assert.equal(futureClimateBounds({gridPoints:[[null,0],[Infinity,0]]}),null);
});

test('water and hot-days scene values use the selected metric and preserve zero rainfall change',()=>{
  const rainfall=futureScenePresentation(state({group:'water'}));
  assert.equal(rainfall.metric,'precipMmPerYear');assert.equal(rainfall.value,climate.metrics.precipMmPerYear.ssp245_2041_2060.value.median);assert.match(rainfall.label,/mm\/year/);
  const hot=futureScenePresentation(state({metric:'hotDays35C'}));assert.equal(hot.value,climate.metrics.hotDays35C.ssp245_2041_2060.value.median);assert.match(hot.label,/days\/year/);
  const zero=structuredClone(climate);zero.metrics.precipMmPerYear.ssp245_2041_2060.changeFromHistorical.median=0;
  assert.match(futureScenePresentation(state({group:'water',products:{'climate-projection':zero}})).label,/\(0 vs baseline\)/);
});

test('historical, missing, mismatched-site and out-of-horizon climate states have no future scene',()=>{
  assert.equal(futureScenePresentation(state({year:2025})),null);
  assert.equal(futureScenePresentation(state({year:2101})),null);
  assert.equal(futureScenePresentation(state({products:{}})),null);
  assert.equal(futureScenePresentation(state({siteId:'other'})),null);
  assert.equal(futureScenePresentation(state({site:{...site,id:'other'},siteId:'other'})),null);
  assert.equal(futureScenePresentation(state({group:'water',products:{},climate:{available:true,metric:'meanTempC',value:30,period:{label:'2041–2060'}}})),null);
});

test('live Python generic-point climate and plume results display only at their exact requested location',()=>{
  const live=structuredClone(climate);live.site={...site,id:'point'};
  const plan=futureScenePresentation(state({products:{'climate-projection':live}}));
  assert.equal(plan.kind,'climate');assert.equal(plan.value,climate.metrics.meanTempC.ssp245_2041_2060.value.median);
  live.site.lat+=.01;
  assert.equal(futureScenePresentation(state({products:{'climate-projection':live}})),null);
  const plume={site:{...site,id:'point'},grid:{n:2,values:[[0,1],[2,3]]},peak:{chiOverQ:.000032}};
  assert.equal(futureScenePresentation(state({group:'air',products:{'plume-scenario':plume}})).kind,'plume');
  plume.site.lon+=.01;
  assert.equal(futureScenePresentation(state({group:'air',products:{'plume-scenario':plume}})),null);
});

test('air uses the actual plume screening output and never labels it as selected-year air quality',()=>{
  const plume={site,grid:{n:2,values:[[0,1],[2,3]]},peak:{chiOverQ:0.000032},assumptions:{effectiveStackHeightM:20}};
  const plan=futureScenePresentation(state({group:'air',products:{'plume-scenario':plume}}));
  assert.equal(plan.raw,plume);assert.match(plan.label,/3\.20e-5 s\/m³/);assert.match(plan.label,/not a 2050 air-quality forecast/);assert.doesNotMatch(plan.label,/µg/);
  const source={...plume,peak:{...plume.peak,concentrationUgM3:0},emission:{rateGs:1,source:'Permit example'}};
  assert.match(futureScenePresentation(state({group:'air',products:{'plume-scenario':source}})).label,/0 µg\/m³/);
  for(const emission of [{rateGs:0,source:'Permit example'},{rateGs:-1,source:'Permit example'},{rateGs:1,source:' '}]){
    assert.doesNotMatch(futureScenePresentation(state({group:'air',products:{'plume-scenario':{...source,emission}}})).label,/µg/);
  }
  assert.equal(futureScenePresentation(state({group:'air',products:{'plume-scenario':{...plume,site:{...site,id:'wrong'}}}})),null);
});

test('agricultural scene labels actual model climate-exposure means and leave missing crop outputs absent',()=>{
  const raw={futurePeriod:{start:'2035-01-01',end:'2039-12-31'},settings:{heatThresholdC:35},comparisons:[{model:'A',indicators:{heatThresholdDays:{futureMeanPerSeason:0,change:0}}},{model:'B',indicators:{heatThresholdDays:{futureMeanPerSeason:12,change:4}}}]};
  const plan=futureScenePresentation(state({group:'vegetation',products:{agriculture:raw}}));
  assert.match(plan.label,/A: 0 hot days\/season/);assert.match(plan.label,/B: 12 hot days\/season/);assert.match(plan.label,/2035–2039/);assert.match(plan.label,/not crop loss/);
  raw.comparisons.forEach(m=>m.indicators.heatThresholdDays.futureMeanPerSeason=null);
  assert.equal(futureScenePresentation(state({group:'vegetation',products:{agriculture:raw}})),null);
});

test('loaded complete-year daily climate numbers and supported trend extensions appear without a fabricated spatial field',()=>{
  const metric={available:true,year:2039,value:0,models:2,period:{start:2039,end:2039,label:'2039'}};
  const dailyClimate={metrics:{precipMmPerYear:metric}};
  const withPeriod=futureScenePresentation(state({year:2039,group:'water',dailyClimate}));
  assert.match(withPeriod.label,/2039 daily-climate models: 0 mm\/year/);
  const onlyDaily=futureScenePresentation(state({year:2039,group:'water',dailyClimate,products:{}}));
  assert.equal(onlyDaily.kind,'daily-climate');assert.equal(onlyDaily.value,0);assert.equal(onlyDaily.bounds,undefined);
  assert.equal(futureScenePresentation(state({year:2040,group:'water',dailyClimate,products:{}})),null,'previous-year daily model data do not carry forward');
  const trend={variables:{NDVI:{available:true,year:2030,value:.25,min:.2,max:.3}}};
  const plan=futureScenePresentation(state({year:2030,group:'vegetation',products:{},trend}));
  assert.equal(plan.kind,'trend');assert.match(plan.label,/0\.25 NDVI/);assert.match(plan.label,/If the historical trend continues/);assert.equal(plan.bounds,undefined);
  assert.equal(futureScenePresentation(state({year:2036,group:'vegetation',products:{},trend})),null);
});

test('future scene retains two entities, restores historical view, guards late site events and disposes all listeners',t=>{
  const previous=globalThis.Cesium,entities=[],target=new EventTarget(),layers=[];
  class Vector{constructor(x,y,z){Object.assign(this,{x,y,z});}static fromDegrees(x,y,z){return new Vector(x,y,z);}}
  const color={withAlpha:alpha=>({alpha})};
  globalThis.Cesium={Cartesian3:Vector,Cartesian2:Vector,Color:{WHITE:{},BLACK:{},fromCssColorString:()=>color},Rectangle:{fromDegrees:(...bounds)=>bounds},DistanceDisplayCondition:class{},LabelStyle:{FILL_AND_OUTLINE:1}};
  t.after(()=>{if(previous===undefined)delete globalThis.Cesium;else globalThis.Cesium=previous;});
  const viewer={entities:{add(entity){entities.push(entity);return entity;},remove(entity){entities.splice(entities.indexOf(entity),1);}},scene:{requestRender(){}}};
  const emit=(type,detail)=>target.dispatchEvent(new CustomEvent(type,{detail}));
  target.addEventListener('cs:environment-layer',event=>layers.push(event.detail));
  const scene=attachFutureScene(viewer,{eventTarget:target,document:null,site});
  scene.setState(state());assert.equal(scene.count,2);const originals=[...entities];
  scene.setState(state({scenario:'ssp585',year:2090}));assert.deepEqual(entities,originals,'entities update in place');
  emit('cs:campus-ready',{siteId:site.id,marker:{lat:site.lat,lon:site.lon,roofHeight:500}});assert.equal(entities[0].position.z,535,'mapped rooftop avoids below-terrain labels');
  const plume={site,grid:{n:2,values:[[0,1],[2,3]]},peak:{chiOverQ:0.000032}};
  scene.setState(state({group:'air',products:{'plume-scenario':plume}}));assert.equal(scene.count,1);assert.equal(layers.at(-1).enabled,true);
  scene.setState(state({group:'air',year:2025,products:{'plume-scenario':plume}}));assert.equal(scene.count,0);assert.equal(layers.at(-1).enabled,false);
  scene.setState(state());emit('cs:site',{site:{id:'new',lat:0,lon:0}});assert.equal(scene.count,0);
  emit('cs:year',{siteId:site.id,year:2090});assert.equal(scene.count,0);
  emit('cs:future-state',{state:state()});assert.equal(scene.count,0,'late previous-site model output cannot restore the old overlay');
  emit('cs:site',{site});assert.equal(scene.count,2,'a new-site state arriving before the site event is retained for the authorized switch');
  scene.destroy();scene.destroy();emit('cs:future-state',{state:state()});assert.equal(entities.length,0);
});
